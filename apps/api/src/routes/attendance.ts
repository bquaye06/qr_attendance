import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { appeals, attendanceRecords } from '@attend/db';
import {
  AppealDecisionInput,
  AppealInput,
  BulkExcuseInput,
  ManualAttendanceInput,
  StudentAttendanceSummary,
} from '@attend/contracts';
import { ApiError } from '../lib/problem.ts';
import { assertCan, assertStudent } from '../lib/auth.ts';
import { rows } from '../lib/query.ts';
import { writeAudit } from '../lib/audit.ts';
import { channels } from '../lib/events.ts';
import { buildRosterEvent } from '../services/roster.ts';
import { loadOfferingScope, loadSessionAccess } from '../services/session-access.ts';
import { attendancePercent } from '../domain/session.ts';

/**
 * Manual corrections and appeals.
 *
 * A correction without a reason is rejected before it touches the database, and
 * every applied change writes an override row plus an audit entry. Corrections
 * never delete anything: the original status stays in attendance_overrides.
 */
export async function registerAttendanceRoutes(app: FastifyInstance): Promise<void> {
  app.patch('/api/v1/attendance/:recordId', async (request) => {
    const principal = await app.authenticate(request);
    const { recordId } = request.params as { recordId: string };
    const input = ManualAttendanceInput.parse(request.body);

    const [record] = await app.stores.db
      .select()
      .from(attendanceRecords)
      .where(eq(attendanceRecords.id, recordId))
      .limit(1);
    if (!record) throw new ApiError('NOT_FOUND', 'Attendance record not found.');

    const access = await loadSessionAccess(app.stores.db, record.sessionId);
    assertCan(principal, 'attendance:override', access);

    const settings = await app.settings();
    if (settings.manualOverrideLimitPerSession > 0) {
      const [countRow] = await rows<{ count: number }>(
        app.stores.db,
        sql`select count(*)::int as count from attendance_overrides o
            join attendance_records r on r.id = o.record_id
            where r.session_id = ${record.sessionId}::uuid`,
      );
      if ((countRow?.count ?? 0) >= settings.manualOverrideLimitPerSession) {
        throw new ApiError(
          'FORBIDDEN',
          `This session has reached the manual correction limit (${settings.manualOverrideLimitPerSession}). Contact an administrator.`,
        );
      }
    }

    if (record.status === input.status) {
      return { record: { id: record.id, status: record.status } };
    }

    const client = await app.stores.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `update attendance_records
            set status = $2, method = 'manual', marked_by = $3, checked_in_at = coalesce(checked_in_at, now()), updated_at = now()
          where id = $1`,
        [recordId, input.status, principal.userId],
      );
      await client.query(
        `insert into attendance_overrides (record_id, old_status, new_status, reason, actor_id)
         values ($1, $2, $3, $4, $5)`,
        [recordId, record.status, input.status, input.reason, principal.userId],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }

    await writeAudit(app.stores.db, {
      actorId: principal.userId,
      actorEmail: principal.email,
      action: 'attendance.override',
      entity: 'attendance_record',
      entityId: recordId,
      before: { status: record.status },
      after: { status: input.status, reason: input.reason },
      ip: request.ip,
      requestId: request.id,
    });

    await app.hub.publish(channels.sessionRoster(record.sessionId), await buildRosterEvent(app.stores.db, record.sessionId));
    return { record: { id: recordId, status: input.status } };
  });

  /**
   * Lecturer correction addressed by student rather than record id, which is
   * what the live roster has to hand. Creates the record if the absence sweep
   * has not run yet.
   */
  app.patch('/api/v1/sessions/:id/students/:studentId', async (request) => {
    const principal = await app.authenticate(request);
    const { id, studentId } = request.params as { id: string; studentId: string };
    const input = ManualAttendanceInput.parse(request.body);
    const access = await loadSessionAccess(app.stores.db, id);
    assertCan(principal, 'attendance:override', access);

    const [existing] = await app.stores.db
      .select()
      .from(attendanceRecords)
      .where(sql`session_id = ${id}::uuid and student_id = ${studentId}::uuid`)
      .limit(1);

    const client = await app.stores.pool.connect();
    try {
      await client.query('begin');
      if (!existing) {
        await client.query(
          `insert into attendance_records (session_id, student_id, status, method, marked_by, checked_in_at)
           values ($1, $2, $3, 'manual', $4, case when $3 = 'absent' then null else now() end)
           on conflict (session_id, student_id) do nothing`,
          [id, studentId, input.status, principal.userId],
        );
      } else if (existing.status !== input.status) {
        await client.query(
          `update attendance_records
              set status = $3, method = 'manual', marked_by = $4, updated_at = now()
            where session_id = $1 and student_id = $2`,
          [id, studentId, input.status, principal.userId],
        );
        await client.query(
          `insert into attendance_overrides (record_id, old_status, new_status, reason, actor_id)
           values ($1, $2, $3, $4, $5)`,
          [existing.id, existing.status, input.status, input.reason, principal.userId],
        );
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }

    await writeAudit(app.stores.db, {
      actorId: principal.userId,
      actorEmail: principal.email,
      action: 'attendance.override',
      entity: 'attendance_record',
      entityId: existing?.id ?? null,
      before: { status: existing?.status ?? null },
      after: { sessionId: id, studentId, status: input.status, reason: input.reason },
      ip: request.ip,
      requestId: request.id,
    });

    await app.hub.publish(channels.sessionRoster(id), await buildRosterEvent(app.stores.db, id));
    return { ok: true as const, status: input.status };
  });

  app.post('/api/v1/sessions/:id/bulk-excuse', async (request) => {
    const principal = await app.authenticate(request);
    const { id } = request.params as { id: string };
    const input = BulkExcuseInput.parse(request.body);
    const access = await loadSessionAccess(app.stores.db, id);
    assertCan(principal, 'attendance:override_bulk', access);

    let changed = 0;
    const client = await app.stores.pool.connect();
    try {
      await client.query('begin');
      for (const studentId of input.studentIds) {
        const existing = await client.query(
          `select id, status from attendance_records where session_id = $1 and student_id = $2`,
          [id, studentId],
        );
        if (existing.rowCount === 0) {
          await client.query(
            `insert into attendance_records (session_id, student_id, status, method, marked_by)
             values ($1, $2, 'excused', 'manual', $3)
             on conflict do nothing`,
            [id, studentId, principal.userId],
          );
          changed += 1;
        } else if (existing.rows[0].status !== 'excused') {
          await client.query(
            `update attendance_records set status = 'excused', method = 'manual', marked_by = $3, updated_at = now()
             where session_id = $1 and student_id = $2`,
            [id, studentId, principal.userId],
          );
          await client.query(
            `insert into attendance_overrides (record_id, old_status, new_status, reason, actor_id)
             values ($1, $2, 'excused', $3, $4)`,
            [existing.rows[0].id, existing.rows[0].status, input.reason, principal.userId],
          );
          changed += 1;
        }
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }

    await writeAudit(app.stores.db, {
      actorId: principal.userId,
      actorEmail: principal.email,
      action: 'attendance.bulk_excuse',
      entity: 'class_session',
      entityId: id,
      after: { students: input.studentIds.length, changed, reason: input.reason },
      ip: request.ip,
      requestId: request.id,
    });

    await app.hub.publish(channels.sessionRoster(id), await buildRosterEvent(app.stores.db, id));
    return { changed };
  });

  // -------------------------------------------------------- student history
  app.get('/api/v1/me/attendance', async (request) => {
    const principal = await app.authenticate(request);
    const studentId = assertStudent(principal);
    const settings = await app.settings();

    const records = await rows<{
      id: string;
      session_id: string;
      course_code: string;
      course_title: string;
      starts_at: Date;
      status: 'present' | 'late' | 'present_flagged' | 'present_manual' | 'absent' | 'excused';
      method: 'auto' | 'manual';
      checked_in_at: Date | null;
      room_name: string | null;
      offering_id: string;
    }>(
      app.stores.db,
      sql`
        select r.id, r.session_id, r.status, r.method, r.checked_in_at, s.starts_at,
               c.code as course_code, c.title as course_title, r2.name as room_name, o.id as offering_id
        from attendance_records r
        join class_sessions s on s.id = r.session_id
        join course_offerings o on o.id = s.offering_id
        join courses c on c.id = o.course_id
        left join rooms r2 on r2.id = s.room_id
        where r.student_id = ${studentId}::uuid
        order by s.starts_at desc
        limit 200
      `,
    );

    const courseRows = await rows<{
      offering_id: string;
      course_code: string;
      course_title: string;
      held: number;
      attended: number;
    }>(
      app.stores.db,
      sql`
        select o.id as offering_id, c.code as course_code, c.title as course_title,
               count(s.id)::int as held,
               count(r.id) filter (where r.status in ('present','late','present_flagged','present_manual'))::int as attended
        from enrollments e
        join course_offerings o on o.id = e.offering_id
        join courses c on c.id = o.course_id
        left join class_sessions s on s.offering_id = o.id and s.status in ('open','closed')
        left join attendance_records r on r.session_id = s.id and r.student_id = e.student_id
        where e.student_id = ${studentId}::uuid and e.status = 'active' and e.deleted_at is null
        group by o.id, c.code, c.title
        order by c.code
      `,
    );

    return StudentAttendanceSummary.parse({
      records: records.map((record) => ({
        id: record.id,
        sessionId: record.session_id,
        courseCode: record.course_code,
        courseTitle: record.course_title,
        startsAt: record.starts_at.toISOString(),
        status: record.status,
        method: record.method,
        checkedInAt: record.checked_in_at?.toISOString() ?? null,
        roomName: record.room_name,
      })),
      perCourse: courseRows.map((course) => {
        const percent = attendancePercent(course.attended, course.held);
        return {
          offeringId: course.offering_id,
          courseCode: course.course_code,
          courseTitle: course.course_title,
          held: course.held,
          attended: course.attended,
          percent,
          belowThreshold: percent < settings.attendanceThresholdPercent,
          threshold: settings.attendanceThresholdPercent,
        };
      }),
    });
  });

  // ---------------------------------------------------------------- appeals
  app.post('/api/v1/appeals', async (request) => {
    const principal = await app.authenticate(request);
    const studentId = assertStudent(principal);
    const input = AppealInput.parse(request.body);

    const [record] = await app.stores.db
      .select()
      .from(attendanceRecords)
      .where(eq(attendanceRecords.id, input.recordId))
      .limit(1);
    if (!record) throw new ApiError('NOT_FOUND', 'Attendance record not found.');
    if (record.studentId !== studentId) throw new ApiError('FORBIDDEN', 'That record is not yours.');

    const inserted = await app.stores.db
      .insert(appeals)
      .values({ recordId: input.recordId, studentId, message: input.message, status: 'open' })
      .onConflictDoNothing()
      .returning({ id: appeals.id });
    if (inserted.length === 0) throw new ApiError('CONFLICT', 'There is already an open appeal for this record.');

    await writeAudit(app.stores.db, {
      actorId: principal.userId,
      actorEmail: principal.email,
      action: 'appeal.created',
      entity: 'appeal',
      entityId: inserted[0]!.id,
      after: { recordId: input.recordId },
      ip: request.ip,
      requestId: request.id,
    });
    return { appealId: inserted[0]!.id, status: 'open' as const };
  });

  app.get('/api/v1/appeals', async (request) => {
    const principal = await app.authenticate(request);
    const query = request.query as { offeringId?: string; status?: string };

    const scope = query.offeringId
      ? await loadOfferingScope(app.stores.db, query.offeringId)
      : { institutionId: '00000000-0000-0000-0000-000000000000', facultyId: null, departmentId: null, offeringId: null };
    assertCan(principal, 'appeal:read', scope);

    const list = await rows<{
      id: string;
      record_id: string;
      student_name: string;
      course_code: string;
      starts_at: Date;
      status: string;
      message: string;
      created_at: Date;
      decided_at: Date | null;
      decision_note: string | null;
    }>(
      app.stores.db,
      sql`
        select a.id, a.record_id, u.name as student_name, c.code as course_code, s.starts_at,
               a.status, a.message, a.created_at, a.decided_at, a.decision_note
        from appeals a
        join attendance_records r on r.id = a.record_id
        join class_sessions s on s.id = r.session_id
        join course_offerings o on o.id = s.offering_id
        join courses c on c.id = o.course_id
        join students st on st.id = a.student_id
        join users u on u.id = st.user_id
        where (${query.status ?? null}::text is null or a.status = ${query.status ?? null})
          and (${query.offeringId ?? null}::uuid is null or o.id = ${query.offeringId ?? null}::uuid)
        order by a.created_at desc
        limit 200
      `,
    );
    return { appeals: list };
  });

  app.get('/api/v1/appeals/mine', async (request) => {
    const principal = await app.authenticate(request);
    const studentId = assertStudent(principal);
    const list = await rows<Record<string, unknown>>(
      app.stores.db,
      sql`select a.id, a.record_id, a.status, a.message, a.created_at, a.decided_at, a.decision_note
          from appeals a where a.student_id = ${studentId}::uuid order by a.created_at desc limit 50`,
    );
    return { appeals: list };
  });

  app.patch('/api/v1/appeals/:id', async (request) => {
    const principal = await app.authenticate(request);
    const { id } = request.params as { id: string };
    const input = AppealDecisionInput.parse(request.body);

    const [appeal] = await app.stores.db.select().from(appeals).where(eq(appeals.id, id)).limit(1);
    if (!appeal) throw new ApiError('NOT_FOUND', 'Appeal not found.');
    const [record] = await app.stores.db
      .select()
      .from(attendanceRecords)
      .where(eq(attendanceRecords.id, appeal.recordId))
      .limit(1);
    if (!record) throw new ApiError('NOT_FOUND', 'Record not found.');
    const access = await loadSessionAccess(app.stores.db, record.sessionId);
    assertCan(principal, 'appeal:resolve', access);

    await app.stores.db
      .update(appeals)
      .set({
        status: input.decision,
        decidedBy: principal.userId,
        decidedAt: new Date(),
        decisionNote: input.note,
        updatedAt: new Date(),
      })
      .where(eq(appeals.id, id));

    if (input.decision === 'accepted') {
      await app.stores.db
        .update(attendanceRecords)
        .set({ status: 'present_manual', method: 'manual', markedBy: principal.userId, updatedAt: new Date() })
        .where(eq(attendanceRecords.id, record.id));
      await app.stores.db.execute(sql`
        insert into attendance_overrides (record_id, old_status, new_status, reason, actor_id)
        values (${record.id}::uuid, ${record.status}, 'present_manual', ${`appeal accepted: ${input.note}`}, ${principal.userId}::uuid)
      `);
    }

    await writeAudit(app.stores.db, {
      actorId: principal.userId,
      actorEmail: principal.email,
      action: 'appeal.resolved',
      entity: 'appeal',
      entityId: id,
      before: { status: appeal.status },
      after: { status: input.decision, note: input.note },
      ip: request.ip,
      requestId: request.id,
    });

    return { appealId: id, status: input.decision };
  });
}
