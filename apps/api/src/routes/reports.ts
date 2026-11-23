import { sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { CourseMatrix, CourseReportQuery, RangeReportQuery, SessionReportQuery } from '@attend/contracts';
import { ApiError } from '../lib/problem.ts';
import { assertCan } from '../lib/auth.ts';
import { rows } from '../lib/query.ts';
import { writeAudit } from '../lib/audit.ts';
import { buildCourseMatrix } from '../domain/report.ts';
import { loadOfferingScope, loadSessionAccess } from '../services/session-access.ts';
import { CONTENT_TYPES, toCsv, toPdf, toXlsx } from '../services/exports.ts';
import type { TableData } from '../services/exports.ts';

/** Reports: course matrix, single session, institution range. CSV/PDF/XLSX. */
export async function registerReportRoutes(app: FastifyInstance): Promise<void> {
  async function matrixFor(offeringId: string) {
    const settings = await app.settings();
    const sessions = await rows<{
      session_id: string;
      starts_at: Date;
      status: 'scheduled' | 'open' | 'closed' | 'cancelled';
    }>(
      app.stores.db,
      sql`select id as session_id, starts_at, status from class_sessions
          where offering_id = ${offeringId}::uuid order by starts_at`,
    );
    const students = await rows<{ student_id: string; student_number: string; name: string }>(
      app.stores.db,
      sql`select st.id as student_id, st.student_number, u.name
          from enrollments e
          join students st on st.id = e.student_id
          join users u on u.id = st.user_id
          where e.offering_id = ${offeringId}::uuid and e.status = 'active' and e.deleted_at is null
          order by st.student_number`,
    );
    const records = await rows<{
      session_id: string;
      student_id: string;
      status: 'present' | 'late' | 'present_flagged' | 'present_manual' | 'absent' | 'excused';
    }>(
      app.stores.db,
      sql`select r.session_id, r.student_id, r.status
          from attendance_records r
          join class_sessions s on s.id = r.session_id
          where s.offering_id = ${offeringId}::uuid`,
    );

    const matrix = buildCourseMatrix({
      sessions: sessions.map((session) => ({
        sessionId: session.session_id,
        startsAt: session.starts_at,
        status: session.status,
      })),
      students: students.map((student) => ({
        studentId: student.student_id,
        studentNumber: student.student_number,
        name: student.name,
      })),
      records,
      threshold: settings.attendanceThresholdPercent,
    });
    return { matrix, threshold: settings.attendanceThresholdPercent };
  }

  function matrixTable(input: {
    title: string;
    subtitle: string;
    sessions: { sessionId: string; startsAt: string }[];
    students: {
      studentNumber: string;
      name: string;
      cells: { sessionId: string; status: string | null }[];
      attended: number;
      held: number;
      percent: number;
    }[];
  }): TableData {
    const columns = [
      { key: 'studentNumber', label: 'Student no.', width: 14 },
      { key: 'name', label: 'Name', width: 26 },
      ...input.sessions.map((session, index) => ({
        key: `s${index}`,
        label: new Date(session.startsAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }),
        width: 10,
      })),
      { key: 'attended', label: 'Attended', width: 9 },
      { key: 'held', label: 'Held', width: 7 },
      { key: 'percent', label: '%', width: 8 },
    ];
    const rowsOut = input.students.map((student) => {
      const row: Record<string, string | number | null> = {
        studentNumber: student.studentNumber,
        name: student.name,
        attended: student.attended,
        held: student.held,
        percent: student.percent,
      };
      input.sessions.forEach((session, index) => {
        const cell = student.cells.find((entry) => entry.sessionId === session.sessionId);
        row[`s${index}`] = cell?.status ? shortStatus(cell.status) : 'â€“';
      });
      return row;
    });
    return { title: input.title, subtitle: input.subtitle, columns, rows: rowsOut };
  }

  async function respond(reply: FastifyReply, format: string, data: TableData, filename: string): Promise<unknown> {
    if (format === 'csv') {
      return reply
        .header('content-type', CONTENT_TYPES.csv)
        .header('content-disposition', `attachment; filename="${filename}.csv"`)
        .send(toCsv(data));
    }
    if (format === 'xlsx') {
      const buffer = await toXlsx(data);
      return reply
        .header('content-type', CONTENT_TYPES.xlsx)
        .header('content-disposition', `attachment; filename="${filename}.xlsx"`)
        .send(buffer);
    }
    if (format === 'pdf') {
      const buffer = await toPdf(data);
      return reply
        .header('content-type', CONTENT_TYPES.pdf)
        .header('content-disposition', `attachment; filename="${filename}.pdf"`)
        .send(buffer);
    }
    return reply.send(data);
  }

  app.get('/api/v1/reports/course/:offeringId', async (request, reply) => {
    const principal = await app.authenticate(request);
    const { offeringId } = request.params as { offeringId: string };
    const query = CourseReportQuery.parse({ offeringId, ...(request.query as object) });
    const scope = await loadOfferingScope(app.stores.db, offeringId);
    assertCan(principal, query.format === 'json' ? 'report:read' : 'report:export', scope);

    const { matrix, threshold } = await matrixFor(offeringId);
    const parsed = CourseMatrix.parse({ ...matrix, offeringId, courseCode: scope.courseCode, courseTitle: scope.courseTitle, termName: scope.termName, threshold });

    await writeAudit(app.stores.db, {
      actorId: principal.userId,
      actorEmail: principal.email,
      action: 'report.exported',
      entity: 'course_offering',
      entityId: offeringId,
      after: { kind: 'course_matrix', format: query.format },
      ip: request.ip,
      requestId: request.id,
    });

    const table = matrixTable({
      title: `${scope.courseCode} â€” ${scope.courseTitle}`,
      subtitle: `${scope.termName} Â· attendance threshold ${threshold}% Â· generated ${new Date().toISOString()}`,
      sessions: matrix.sessions,
      students: matrix.students,
    });
    return respond(reply, query.format, table, `${scope.courseCode}-attendance`);
  });

  app.get('/api/v1/reports/session/:sessionId', async (request, reply) => {
    const principal = await app.authenticate(request);
    const { sessionId } = request.params as { sessionId: string };
    const query = SessionReportQuery.parse({ sessionId, ...(request.query as object) });
    const access = await loadSessionAccess(app.stores.db, sessionId);
    assertCan(principal, query.format === 'json' ? 'report:read' : 'report:export', access);

    const records = await rows<{
      student_number: string;
      name: string;
      status: string;
      method: string;
      checked_in_at: Date | null;
      risk_score: number | null;
      flag_reason: string | null;
    }>(
      app.stores.db,
      sql`
        select st.student_number, u.name, coalesce(r.status, 'absent') as status,
               coalesce(r.method, 'auto') as method, r.checked_in_at, r.risk_score, r.flag_reason
        from enrollments e
        join students st on st.id = e.student_id
        join users u on u.id = st.user_id
        left join attendance_records r on r.session_id = ${sessionId}::uuid and r.student_id = st.id
        where e.offering_id = (select offering_id from class_sessions where id = ${sessionId}::uuid)
          and e.status = 'active' and e.deleted_at is null
        order by st.student_number
      `,
    );

    const table: TableData = {
      title: `${access.courseCode} â€” session ${access.startsAt.toISOString().slice(0, 10)}`,
      subtitle: `${access.courseTitle} Â· ${access.roomName ?? 'no room'} Â· window closed ${access.checkinClosesAt.toISOString()}`,
      columns: [
        { key: 'studentNumber', label: 'Student no.', width: 14 },
        { key: 'name', label: 'Name', width: 28 },
        { key: 'status', label: 'Status', width: 14 },
        { key: 'method', label: 'Method', width: 10 },
        { key: 'checkedInAt', label: 'Checked in', width: 18 },
        { key: 'risk', label: 'Risk', width: 8 },
        { key: 'flag', label: 'Flag', width: 20 },
      ],
      rows: records.map((record) => ({
        studentNumber: record.student_number,
        name: record.name,
        status: record.status,
        method: record.method,
        checkedInAt: record.checked_in_at ? record.checked_in_at.toISOString().slice(11, 19) : '',
        risk: record.risk_score,
        flag: record.flag_reason,
      })),
      footer: 'Attendance is only valid where presence, identity and device proofs all passed.',
    };

    await writeAudit(app.stores.db, {
      actorId: principal.userId,
      actorEmail: principal.email,
      action: 'report.exported',
      entity: 'class_session',
      entityId: sessionId,
      after: { kind: 'session', format: query.format },
      ip: request.ip,
      requestId: request.id,
    });

    return respond(reply, query.format, table, `session-${sessionId.slice(0, 8)}`);
  });

  app.get('/api/v1/reports/range', async (request, reply) => {
    const principal = await app.authenticate(request);
    const query = RangeReportQuery.parse(request.query ?? {});
    const institutionScope = {
      institutionId: '00000000-0000-0000-0000-000000000001',
      facultyId: query.facultyId ?? null,
      departmentId: query.departmentId ?? null,
      offeringId: null,
    };
    assertCan(principal, query.format === 'json' ? 'report:read' : 'report:export', institutionScope);

    if (query.from > query.to) throw new ApiError('VALIDATION_FAILED', '`from` must be before `to`.');

    const result = await rows<{
      faculty: string;
      course_code: string;
      held: number;
      present: number;
      rate: number;
    }>(
      app.stores.db,
      sql`
        select f.name as faculty, c.code as course_code,
               count(s.id)::int as held,
               count(r.id) filter (where r.status in ('present','late','present_manual','present_flagged'))::int as present,
               coalesce(round(100.0 * count(r.id) filter (where r.status in ('present','late','present_manual','present_flagged'))
                 / nullif(count(s.id) * greatest((select count(*) from enrollments e2 where e2.offering_id = o.id and e2.status = 'active'), 1), 0), 1), 0)::float as rate
        from class_sessions s
        join course_offerings o on o.id = s.offering_id
        join courses c on c.id = o.course_id
        join departments d on d.id = c.department_id
        join faculties f on f.id = d.faculty_id
        left join attendance_records r on r.session_id = s.id
        where s.starts_at >= ${query.from}::date and s.starts_at < (${query.to}::date + interval '1 day')
          and s.status in ('open','closed')
          and (${query.facultyId ?? null}::uuid is null or f.id = ${query.facultyId ?? null}::uuid)
          and (${query.departmentId ?? null}::uuid is null or d.id = ${query.departmentId ?? null}::uuid)
        group by f.name, c.code, o.id
        order by f.name, c.code
      `,
    );

    const table: TableData = {
      title: 'Attendance by course',
      subtitle: `${query.from} to ${query.to}`,
      columns: [
        { key: 'faculty', label: 'Faculty', width: 24 },
        { key: 'course_code', label: 'Course', width: 12 },
        { key: 'held', label: 'Sessions held', width: 14 },
        { key: 'present', label: 'Presences', width: 12 },
        { key: 'rate', label: 'Rate %', width: 10 },
      ],
      rows: result,
    };

    await writeAudit(app.stores.db, {
      actorId: principal.userId,
      actorEmail: principal.email,
      action: 'report.exported',
      entity: 'institution',
      entityId: null,
      after: { kind: 'range', from: query.from, to: query.to, format: query.format },
      ip: request.ip,
      requestId: request.id,
    });

    return respond(reply, query.format, table, `attendance-${query.from}-to-${query.to}`);
  });
}

function shortStatus(status: string): string {
  switch (status) {
    case 'present':
      return 'P';
    case 'late':
      return 'L';
    case 'present_flagged':
      return 'F';
    case 'present_manual':
      return 'M';
    case 'excused':
      return 'E';
    case 'absent':
      return 'A';
    default:
      return 'â€“';
  }
}
