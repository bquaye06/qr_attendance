import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import {
  ApiKeyInput,
  CourseInput,
  DepartmentInput,
  EnrollmentImportInput,
  EnrollmentInput,
  FacultyInput,
  GenerateSessionsInput,
  OfferingInput,
  ProgrammeInput,
  RoleAssignmentInput,
  RoleInput,
  RoomInput,
  SettingWrite,
  SuspendUserInput,
  TermInput,
  TimetableSlotInput,
  WebhookInput,
} from '@attend/contracts';
import { ApiError } from '../lib/problem.ts';
import { assertCan } from '../lib/auth.ts';
import type { Principal } from '../lib/auth.ts';
import { rows } from '../lib/query.ts';
import { writeAudit } from '../lib/audit.ts';
import { loadSettingHistory, updateSetting } from '../lib/settings.ts';
import { encryptSecret, parseMasterKey } from '../domain/secrets.ts';
import { computeCheckinWindow } from '../domain/session.ts';

/**
 * Management console API.
 *
 * Scope rules are uniform: an institution-scoped admin sees everything, a
 * faculty admin sees rows under their faculties, a department admin sees their
 * departments. Every write is audited with before/after values.
 */
export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  const institutionScope = {
    institutionId: '00000000-0000-0000-0000-000000000001',
    facultyId: null,
    departmentId: null,
    offeringId: null,
  };

  /** SQL predicate restricting a query to the principal's scope. */
  function scopeFilter(principal: Principal, facultyColumn: string, departmentColumn: string | null): SQL {
    if (principal.assignments.some((assignment) => assignment.scopeType === 'institution')) {
      return sql`true`;
    }
    const facultyIds = principal.assignments
      .filter((assignment) => assignment.scopeType === 'faculty' && assignment.scopeId)
      .map((assignment) => assignment.scopeId as string);
    const departmentIds = principal.assignments
      .filter((assignment) => assignment.scopeType === 'department' && assignment.scopeId)
      .map((assignment) => assignment.scopeId as string);

    if (facultyIds.length === 0 && departmentIds.length === 0) return sql`false`;
    if (departmentColumn) {
      return sql`(${sql.raw(facultyColumn)} = any(${facultyIds}::uuid[]) or ${sql.raw(departmentColumn)} = any(${departmentIds}::uuid[]))`;
    }
    return sql`${sql.raw(facultyColumn)} = any(${facultyIds}::uuid[])`;
  }

  // ------------------------------------------------------------ dashboard
  app.get('/api/v1/admin/dashboard', async (request) => {
    const principal = await app.authenticate(request);
    assertCan(principal, 'report:read', institutionScope);

    const [today] = await rows<{
      sessions_scheduled: number;
      sessions_open: number;
      checkins: number;
      presences: number;
      records: number;
    }>(
      app.stores.db,
      sql`
        select
          (select count(*) from class_sessions where starts_at::date = current_date)::int as sessions_scheduled,
          (select count(*) from class_sessions where status = 'open')::int as sessions_open,
          (select count(*) from attendance_records where created_at > now() - interval '24 hours')::int as checkins,
          (select count(*) from attendance_records where status in ('present','late','present_manual','present_flagged'))::int as presences,
          (select count(*) from attendance_records)::int as records
      `,
    );

    const byFaculty = await rows<{ faculty_id: string; name: string; checkins: number; rate: number }>(
      app.stores.db,
      sql`
        select f.id as faculty_id, f.name,
               count(r.id) filter (where r.status in ('present','late','present_manual','present_flagged'))::int as checkins,
               coalesce(round(100.0 * count(r.id) filter (where r.status in ('present','late','present_manual','present_flagged'))
                 / nullif((select count(*) from class_sessions s2
                           join course_offerings o2 on o2.id = s2.offering_id
                           join courses c2 on c2.id = o2.course_id
                           join departments d2 on d2.id = c2.department_id
                           where d2.faculty_id = f.id and s2.status in ('open','closed')), 0), 1), 0)::float as rate
        from faculties f
        left join departments d on d.faculty_id = f.id
        left join courses c on c.department_id = d.id
        left join course_offerings o on o.course_id = c.id
        left join class_sessions s on s.offering_id = o.id
        left join attendance_records r on r.session_id = s.id
        group by f.id, f.name
        order by f.name
      `,
    );

    const [flagged] = await rows<{ flagged: number; failed: number }>(
      app.stores.db,
      sql`
        select
          (select count(*) from attendance_records where status = 'present_flagged' and created_at > now() - interval '24 hours')::int as flagged,
          (select count(*) from attendance_attempts where result = 'fail' and created_at > now() - interval '24 hours')::int as failed
      `,
    );

    const [resets] = await rows<{ pending_resets: number; pending_reviews: number }>(
      app.stores.db,
      sql`select
            (select count(*) from device_reset_requests where status = 'pending')::int as pending_resets,
            (select count(*) from review_items where state = 'pending')::int as pending_reviews`,
    );

    const face = await app.face.health();

    return {
      today: {
        sessionsScheduled: today?.sessions_scheduled ?? 0,
        sessionsOpen: today?.sessions_open ?? 0,
        attendanceRate: today && today.records > 0 ? Math.round((today.presences / today.records) * 1000) / 10 : 0,
        checkins: today?.checkins ?? 0,
      },
      term: {
        attendanceRate:
          byFaculty.length > 0
            ? Math.round((byFaculty.reduce((sum, row) => sum + row.rate, 0) / byFaculty.length) * 10) / 10
            : 0,
        sessionsHeld: 0,
        checkins: today?.presences ?? 0,
      },
      byFaculty: byFaculty.map((row) => ({
        facultyId: row.faculty_id,
        name: row.name,
        attendanceRate: row.rate,
        checkins: row.checkins,
      })),
      flagged24h: flagged?.flagged ?? 0,
      failed24h: flagged?.failed ?? 0,
      faceService: {
        status: face ? (face.modelsLoaded ? 'ok' : 'degraded') : 'down',
        p95Ms: null,
        modelVersion: face?.modelVersion ?? null,
      },
      pendingResets: resets?.pending_resets ?? 0,
      pendingReviews: resets?.pending_reviews ?? 0,
    };
  });

  // -------------------------------------------------------- master data CRUD
  interface CrudDef {
    path: string;
    table: string;
    entity: string;
    insertSchema: z.ZodTypeAny;
    patchSchema: z.ZodTypeAny;
    columns: string[];
    facultyColumn: string;
    departmentColumn: string | null;
    orderBy: string;
  }

  const RESOURCES: CrudDef[] = [
    {
      path: 'faculties',
      table: 'faculties',
      entity: 'faculty',
      insertSchema: FacultyInput,
      patchSchema: FacultyInput.partial(),
      columns: ['name', 'code'],
      facultyColumn: 'id',
      departmentColumn: null,
      orderBy: 'name',
    },
    {
      path: 'departments',
      table: 'departments',
      entity: 'department',
      insertSchema: DepartmentInput,
      patchSchema: DepartmentInput.partial(),
      columns: ['name', 'code', 'faculty_id'],
      facultyColumn: 'faculty_id',
      departmentColumn: 'id',
      orderBy: 'name',
    },
    {
      path: 'programmes',
      table: 'programmes',
      entity: 'programme',
      insertSchema: ProgrammeInput,
      patchSchema: ProgrammeInput.partial(),
      columns: ['name', 'code', 'department_id'],
      facultyColumn: 'department_id',
      departmentColumn: 'department_id',
      orderBy: 'name',
    },
    {
      path: 'courses',
      table: 'courses',
      entity: 'course',
      insertSchema: CourseInput,
      patchSchema: CourseInput.partial(),
      columns: ['code', 'title', 'department_id', 'credit_hours'],
      facultyColumn: 'department_id',
      departmentColumn: 'department_id',
      orderBy: 'code',
    },
    {
      path: 'offerings',
      table: 'course_offerings',
      entity: 'course_offering',
      insertSchema: OfferingInput,
      patchSchema: OfferingInput.partial(),
      columns: ['course_id', 'term_id', 'section', 'capacity'],
      facultyColumn: 'course_id',
      departmentColumn: 'course_id',
      orderBy: 'created_at desc',
    },
    {
      path: 'terms',
      table: 'terms',
      entity: 'term',
      insertSchema: TermInput,
      patchSchema: TermInput.partial(),
      columns: ['name', 'starts_on', 'ends_on', 'is_current'],
      facultyColumn: 'id',
      departmentColumn: null,
      orderBy: 'starts_on desc',
    },
    {
      path: 'rooms',
      table: 'rooms',
      entity: 'room',
      insertSchema: RoomInput,
      patchSchema: RoomInput.partial(),
      columns: ['name', 'building', 'latitude', 'longitude', 'geofence_m', 'allowed_cidrs'],
      facultyColumn: 'id',
      departmentColumn: null,
      orderBy: 'name',
    },
  ];

  for (const resource of RESOURCES) {
    app.get(`/api/v1/admin/${resource.path}`, async (request) => {
      const principal = await app.authenticate(request);
      assertCan(principal, 'structure:read', institutionScope);

      const filter = scopeFilter(principal, resource.facultyColumn, resource.departmentColumn);
      const list = await rows<Record<string, unknown>>(
        app.stores.db,
        sql`select * from ${sql.raw(resource.table)} where deleted_at is null and ${filter}
            order by ${sql.raw(resource.orderBy)} limit 500`,
      );
      return { items: list };
    });

    app.post(`/api/v1/admin/${resource.path}`, async (request) => {
      const principal = await app.authenticate(request);
      assertCan(principal, 'structure:write', institutionScope);
      const input = resource.insertSchema.parse(request.body) as Record<string, unknown>;

      const [institution] = await rows<{ id: string }>(
        app.stores.db,
        sql`select id from institutions order by created_at limit 1`,
      );
      if (!institution) throw new ApiError('CONFLICT', 'No institution configured.');

      const columns = Object.keys(input).map(snake);
      const values = Object.keys(input).map((key) => normaliseValue(input[key]));
      if (['faculties', 'terms', 'rooms'].includes(resource.table)) {
        columns.push('institution_id');
        values.push(institution.id);
      }

      const inserted = await rows<Record<string, unknown>>(
        app.stores.db,
        sql`insert into ${sql.raw(resource.table)} (${sql.raw(columns.join(', '))})
            values (${sql.join(values.map((value) => sql`${value}`), sql`, `)})
            returning *`,
      );

      await writeAudit(app.stores.db, {
        actorId: principal.userId,
        actorEmail: principal.email,
        action: `${resource.entity}.created`,
        entity: resource.entity,
        entityId: String(inserted[0]?.['id'] ?? ''),
        after: input,
        ip: request.ip,
        requestId: request.id,
      });
      return { item: inserted[0] };
    });

    app.patch(`/api/v1/admin/${resource.path}/:id`, async (request) => {
      const principal = await app.authenticate(request);
      assertCan(principal, 'structure:write', institutionScope);
      const { id } = request.params as { id: string };
      const patch = resource.patchSchema.parse(request.body) as Record<string, unknown>;
      const keys = Object.keys(patch);
      if (keys.length === 0) throw new ApiError('VALIDATION_FAILED', 'Nothing to update.');

      const assignments = keys.map((key) => sql`${sql.raw(snake(key))} = ${normaliseValue(patch[key])}`);
      const updated = await rows<Record<string, unknown>>(
        app.stores.db,
        sql`update ${sql.raw(resource.table)}
               set ${sql.join(assignments, sql`, `)}, updated_at = now()
             where id = ${id}::uuid and deleted_at is null
            returning *`,
      );
      if (updated.length === 0) throw new ApiError('NOT_FOUND', 'Resource not found.');

      await writeAudit(app.stores.db, {
        actorId: principal.userId,
        actorEmail: principal.email,
        action: `${resource.entity}.updated`,
        entity: resource.entity,
        entityId: id,
        after: patch,
        ip: request.ip,
        requestId: request.id,
      });
      return { item: updated[0] };
    });

    app.delete(`/api/v1/admin/${resource.path}/:id`, async (request) => {
      const principal = await app.authenticate(request);
      assertCan(principal, 'structure:write', institutionScope);
      const { id } = request.params as { id: string };
      await app.stores.db.execute(
        sql`update ${sql.raw(resource.table)} set deleted_at = now(), updated_at = now() where id = ${id}::uuid`,
      );
      await writeAudit(app.stores.db, {
        actorId: principal.userId,
        actorEmail: principal.email,
        action: `${resource.entity}.deleted`,
        entity: resource.entity,
        entityId: id,
        ip: request.ip,
        requestId: request.id,
      });
      return { ok: true as const };
    });
  }

  // ------------------------------------------------------- people & enrolment
  app.post('/api/v1/admin/enrollments', async (request) => {
    const principal = await app.authenticate(request);
    assertCan(principal, 'enrollment:write', institutionScope);
    const input = EnrollmentInput.parse(request.body);

    const inserted = await app.stores.db.execute(sql`
      insert into enrollments (offering_id, student_id, status)
      select ${input.offeringId}::uuid, sid, 'active' from unnest(${input.studentIds}::uuid[]) as sid
      on conflict (offering_id, student_id) do update set status = 'active', deleted_at = null, updated_at = now()
    `);

    await writeAudit(app.stores.db, {
      actorId: principal.userId,
      actorEmail: principal.email,
      action: 'enrollment.bulk_added',
      entity: 'course_offering',
      entityId: input.offeringId,
      after: { students: input.studentIds.length },
      ip: request.ip,
      requestId: request.id,
    });
    return { added: (inserted as unknown as { rowCount: number }).rowCount ?? input.studentIds.length };
  });

  /**
   * Bulk enrolment by student number, with a validation preview. Administrators
   * work from class lists, not UUIDs, so the console never has to resolve ids.
   */
  app.post('/api/v1/admin/enrollments/import', async (request) => {
    const principal = await app.authenticate(request);
    assertCan(principal, 'enrollment:write', institutionScope);
    const input = EnrollmentImportInput.parse(request.body);

    const numbers = [...new Set(input.studentNumbers.map((number) => number.trim()).filter(Boolean))];
    if (numbers.length === 0) throw new ApiError('VALIDATION_FAILED', 'No student numbers supplied.');

    const found = await rows<{ id: string; student_number: string }>(
      app.stores.db,
      sql`select id, student_number from students
          where student_number = any(${numbers}::text[]) and deleted_at is null`,
    );
    const matchedNumbers = new Set(found.map((row) => row.student_number));
    const unknown = numbers.filter((number) => !matchedNumbers.has(number));

    const existing = await rows<{ student_id: string }>(
      app.stores.db,
      sql`select student_id from enrollments
          where offering_id = ${input.offeringId}::uuid and status = 'active' and deleted_at is null`,
    );
    const existingIds = new Set(existing.map((row) => row.student_id));
    const alreadyEnrolled = found
      .filter((row) => existingIds.has(row.id))
      .map((row) => row.student_number);
    const toAdd = found.filter((row) => !existingIds.has(row.id));

    if (input.dryRun) {
      return {
        dryRun: true,
        matched: found.length,
        unknown,
        alreadyEnrolled,
        toAdd: toAdd.length,
      };
    }

    if (toAdd.length === 0) {
      return { dryRun: false, added: 0, unknown, alreadyEnrolled };
    }

    const inserted = await app.stores.db.execute(sql`
      insert into enrollments (offering_id, student_id, status)
      select ${input.offeringId}::uuid, sid, 'active' from unnest(${toAdd.map((row) => row.id)}::uuid[]) as sid
      on conflict (offering_id, student_id) do update set status = 'active', deleted_at = null, updated_at = now()
    `);

    await writeAudit(app.stores.db, {
      actorId: principal.userId,
      actorEmail: principal.email,
      action: 'enrollment.imported',
      entity: 'course_offering',
      entityId: input.offeringId,
      after: {
        requested: numbers.length,
        added: toAdd.length,
        alreadyEnrolled: alreadyEnrolled.length,
        unknown: unknown.length,
      },
      ip: request.ip,
      requestId: request.id,
    });

    return {
      dryRun: false,
      added: (inserted as unknown as { rowCount: number }).rowCount ?? toAdd.length,
      unknown,
      alreadyEnrolled,
    };
  });

  app.patch('/api/v1/admin/users/:id/status', async (request) => {
    const principal = await app.authenticate(request);
    assertCan(principal, 'people:write', institutionScope);
    const { id } = request.params as { id: string };
    const input = SuspendUserInput.parse(request.body);
    await app.stores.db.execute(
      sql`update users set status = ${input.status}, updated_at = now() where id = ${id}::uuid`,
    );
    await writeAudit(app.stores.db, {
      actorId: principal.userId,
      actorEmail: principal.email,
      action: 'user.status_changed',
      entity: 'user',
      entityId: id,
      after: { status: input.status, reason: input.reason },
      ip: request.ip,
      requestId: request.id,
    });
    return { ok: true as const };
  });

  // -------------------------------------------------------------- timetable
  app.get('/api/v1/admin/timetable', async (request) => {
    const principal = await app.authenticate(request);
    assertCan(principal, 'structure:read', institutionScope);

    const slots = await rows<Record<string, unknown>>(
      app.stores.db,
      sql`
        select t.id, t.day_of_week, t.starts_at::text as starts_at, t.ends_at::text as ends_at,
               t.valid_from::text as valid_from, t.valid_to::text as valid_to,
               c.code as course_code, c.title as course_title, r.name as room_name,
               o.id as offering_id, term.name as term_name,
               (select count(*) from class_sessions s where s.timetable_slot_id = t.id)::int as session_count
        from timetable_slots t
        join course_offerings o on o.id = t.offering_id
        join courses c on c.id = o.course_id
        join terms term on term.id = o.term_id
        join rooms r on r.id = t.room_id
        where t.deleted_at is null
        order by c.code, t.day_of_week
        limit 500
      `,
    );
    return { slots };
  });

  app.post('/api/v1/admin/timetable', async (request) => {
    const principal = await app.authenticate(request);
    assertCan(principal, 'timetable:write', institutionScope);
    const input = TimetableSlotInput.parse(request.body);
    const [slot] = await rows<Record<string, unknown>>(
      app.stores.db,
      sql`insert into timetable_slots (offering_id, room_id, day_of_week, starts_at, ends_at, valid_from, valid_to)
          values (${input.offeringId}::uuid, ${input.roomId}::uuid, ${input.dayOfWeek}, ${input.startsAt}::time,
                  ${input.endsAt}::time, ${input.validFrom}::date, ${input.validTo}::date)
          returning *`,
    );
    await writeAudit(app.stores.db, {
      actorId: principal.userId,
      actorEmail: principal.email,
      action: 'timetable.slot_created',
      entity: 'timetable_slot',
      entityId: String(slot?.['id'] ?? ''),
      after: input,
      ip: request.ip,
      requestId: request.id,
    });
    return { item: slot };
  });

  /** Generate class sessions for a term from the timetable. */
  app.post('/api/v1/admin/sessions/generate', async (request) => {
    const principal = await app.authenticate(request);
    assertCan(principal, 'timetable:write', institutionScope);
    const input = GenerateSessionsInput.parse(request.body);
    const settings = await app.settings();

    const slots = await rows<{
      id: string;
      offering_id: string;
      room_id: string;
      day_of_week: number;
      starts_at: string;
      ends_at: string;
      valid_from: string;
      valid_to: string;
    }>(
      app.stores.db,
      sql`select id, offering_id, room_id, day_of_week, starts_at::text, ends_at::text,
                 valid_from::text, valid_to::text
          from timetable_slots
          where deleted_at is null
            and offering_id in (select id from course_offerings where term_id = ${input.termId}::uuid)
            and valid_from <= (select ends_on from terms where id = ${input.termId}::uuid)
            and valid_to >= (select starts_on from terms where id = ${input.termId}::uuid)`,
    );

    const created: { slotId: string; sessions: number }[] = [];
    for (const slot of slots) {
      const dates: Date[] = [];
      const from = new Date(`${slot.valid_from}T00:00:00Z`);
      const to = new Date(`${slot.valid_to}T00:00:00Z`);
      for (let cursor = new Date(from); cursor <= to; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
        // Postgres dow: 1=Monday … 7=Sunday; JS getUTCDay: 0=Sunday.
        const dow = cursor.getUTCDay() === 0 ? 7 : cursor.getUTCDay();
        if (dow === slot.day_of_week) dates.push(new Date(cursor));
      }
      if (input.dryRun) {
        created.push({ slotId: slot.id, sessions: dates.length });
        continue;
      }
      let count = 0;
      for (const date of dates) {
        const [hours, minutes] = slot.starts_at.split(':').map((part) => Number.parseInt(part, 10));
        const startsAt = new Date(date);
        startsAt.setUTCHours(hours ?? 9, minutes ?? 0, 0, 0);
        const [endHours, endMinutes] = slot.ends_at.split(':').map((part) => Number.parseInt(part, 10));
        const endsAt = new Date(date);
        endsAt.setUTCHours(endHours ?? 11, endMinutes ?? 0, 0, 0);

        const window = computeCheckinWindow({
          startsAt,
          opensOffsetMinutes: settings.checkinOpensOffsetMinutes,
          closesOffsetMinutes: settings.checkinClosesOffsetMinutes,
          lateAfterMinutes: settings.lateAfterMinutes,
        });

        const result = await app.stores.db.execute(sql`
          insert into class_sessions
            (offering_id, room_id, timetable_slot_id, starts_at, ends_at, checkin_opens_at, checkin_closes_at, late_after, status)
          values (${slot.offering_id}::uuid, ${slot.room_id}::uuid, ${slot.id}::uuid, ${startsAt}, ${endsAt},
                  ${window.opensAt}, ${window.closesAt}, ${window.lateAfter}, 'scheduled')
          on conflict (offering_id, starts_at) do nothing
        `);
        count += (result as unknown as { rowCount: number }).rowCount ?? 0;
      }
      created.push({ slotId: slot.id, sessions: count });
    }

    await writeAudit(app.stores.db, {
      actorId: principal.userId,
      actorEmail: principal.email,
      action: 'timetable.sessions_generated',
      entity: 'term',
      entityId: input.termId,
      after: { dryRun: input.dryRun, created },
      ip: request.ip,
      requestId: request.id,
    });

    return { created, total: created.reduce((sum, entry) => sum + entry.sessions, 0) };
  });

  // ---------------------------------------------------------------- review
  app.get('/api/v1/admin/review', async (request) => {
    const principal = await app.authenticate(request);
    assertCan(principal, 'review:read', institutionScope);

    const items = await rows<{
      id: string;
      kind: string;
      session_id: string;
      student_name: string;
      student_number: string;
      course_code: string;
      reasons: string[];
      risk_score: number | null;
      state: string;
      created_at: Date;
    }>(
      app.stores.db,
      sql`
        select ri.id, ri.kind, ri.session_id, u.name as student_name, st.student_number,
               c.code as course_code, ri.reasons, ri.risk_score, ri.state, ri.created_at
        from review_items ri
        join students st on st.id = ri.student_id
        join users u on u.id = st.user_id
        join class_sessions s on s.id = ri.session_id
        join course_offerings o on o.id = s.offering_id
        join courses c on c.id = o.course_id
        order by (ri.state = 'pending') desc, ri.created_at desc
        limit 200
      `,
    );
    return { items };
  });

  app.post('/api/v1/admin/review/:id/resolve', async (request) => {
    const principal = await app.authenticate(request);
    assertCan(principal, 'review:resolve', institutionScope);
    const { id } = request.params as { id: string };
    const body = request.body as { action?: string; reason?: string };
    const action = body.action;
    if (!action || !['confirm', 'reject', 'escalate'].includes(action)) {
      throw new ApiError('VALIDATION_FAILED', 'action must be confirm, reject or escalate.');
    }
    if (!body.reason || body.reason.trim().length < 3) {
      throw new ApiError('VALIDATION_FAILED', 'A reason is required.');
    }

    const [item] = await rows<{ id: string; record_id: string | null; kind: string }>(
      app.stores.db,
      sql`select id, record_id, kind from review_items where id = ${id}::uuid`,
    );
    if (!item) throw new ApiError('NOT_FOUND', 'Review item not found.');

    await app.stores.db.execute(sql`
      update review_items
         set state = ${action === 'confirm' ? 'confirmed' : action === 'reject' ? 'rejected' : 'escalated'},
             resolved_by = ${principal.userId}::uuid, resolved_at = now(), note = ${body.reason}, updated_at = now()
       where id = ${id}::uuid
    `);

    if (item.record_id && action === 'confirm') {
      await app.stores.db.execute(sql`
        update attendance_records set status = 'present_manual', method = 'manual', updated_at = now()
        where id = ${item.record_id}::uuid and status = 'present_flagged'
      `);
    }
    if (item.record_id && action === 'reject') {
      await app.stores.db.execute(sql`
        update attendance_records set status = 'absent', updated_at = now()
        where id = ${item.record_id}::uuid and status = 'present_flagged'
      `);
    }

    await writeAudit(app.stores.db, {
      actorId: principal.userId,
      actorEmail: principal.email,
      action: 'review.resolved',
      entity: 'review_item',
      entityId: id,
      after: { action, reason: body.reason },
      ip: request.ip,
      requestId: request.id,
    });
    return { ok: true as const };
  });

  // --------------------------------------------------------------- devices
  app.get('/api/v1/admin/devices', async (request) => {
    const principal = await app.authenticate(request);
    assertCan(principal, 'device:read', institutionScope);
    const devices = await rows<Record<string, unknown>>(
      app.stores.db,
      sql`select d.id, d.status, d.platform, d.user_agent_family, d.bound_at, d.revoked_at,
                 st.student_number, u.name
          from devices d
          join students st on st.id = d.student_id
          join users u on u.id = st.user_id
          order by d.bound_at desc limit 500`,
    );
    const resets = await rows<Record<string, unknown>>(
      app.stores.db,
      sql`select r.id, r.status, r.reason, r.created_at, st.student_number, u.name
          from device_reset_requests r
          join students st on st.id = r.student_id
          join users u on u.id = st.user_id
          where r.status = 'pending'
          order by r.created_at`,
    );
    return { devices, resets };
  });

  app.post('/api/v1/admin/devices/:id/revoke', async (request) => {
    const principal = await app.authenticate(request);
    assertCan(principal, 'device:revoke', institutionScope);
    const { id } = request.params as { id: string };
    const reason = (request.body as { reason?: string } | undefined)?.reason;
    if (!reason || reason.trim().length < 3) throw new ApiError('VALIDATION_FAILED', 'A reason is required.');

    await app.stores.db.execute(sql`
      update devices set status = 'revoked', revoked_at = now(), updated_at = now() where id = ${id}::uuid
    `);
    await writeAudit(app.stores.db, {
      actorId: principal.userId,
      actorEmail: principal.email,
      action: 'device.revoked',
      entity: 'device',
      entityId: id,
      after: { reason },
      ip: request.ip,
      requestId: request.id,
    });
    return { ok: true as const };
  });

  app.post('/api/v1/admin/device-resets/:id', async (request) => {
    const principal = await app.authenticate(request);
    assertCan(principal, 'device:approve', institutionScope);
    const { id } = request.params as { id: string };
    const body = request.body as { decision?: string; note?: string };
    if (body.decision !== 'approved' && body.decision !== 'rejected') {
      throw new ApiError('VALIDATION_FAILED', 'decision must be approved or rejected.');
    }

    const [resetRequest] = await rows<{ id: string; student_id: string; status: string }>(
      app.stores.db,
      sql`select id, student_id, status from device_reset_requests where id = ${id}::uuid`,
    );
    if (!resetRequest) throw new ApiError('NOT_FOUND', 'Reset request not found.');
    if (resetRequest.status !== 'pending') throw new ApiError('CONFLICT', 'This request was already decided.');

    if (body.decision === 'approved') {
      // Revoke the old passkey: the binding is gone, so the next device is clean.
      await app.stores.db.execute(sql`
        update devices set status = 'revoked', revoked_at = now(), updated_at = now()
        where student_id = ${resetRequest.student_id}::uuid and status = 'active'
      `);
    }
    await app.stores.db.execute(sql`
      update device_reset_requests
         set status = ${body.decision}, decided_by = ${principal.userId}::uuid, decided_at = now(),
             decision_note = ${body.note ?? null}, updated_at = now()
       where id = ${id}::uuid
    `);

    await writeAudit(app.stores.db, {
      actorId: principal.userId,
      actorEmail: principal.email,
      action: 'device.reset_decided',
      entity: 'device_reset_request',
      entityId: id,
      after: { decision: body.decision, note: body.note ?? null },
      ip: request.ip,
      requestId: request.id,
    });
    return { ok: true as const };
  });

  // ------------------------------------------------------------ biometrics
  app.get('/api/v1/admin/biometrics', async (request) => {
    const principal = await app.authenticate(request);
    assertCan(principal, 'biometric:read', institutionScope);
    const students = await rows<Record<string, unknown>>(
      app.stores.db,
      sql`
        select st.id, st.student_number, u.name,
               exists (select 1 from biometric_consents bc where bc.student_id = st.id and bc.withdrawn_at is null) as consent,
               (select count(*) from biometrics.face_templates ft where ft.student_id = st.id and ft.is_active)::int as templates,
               (select max(enrolled_at)::text from biometrics.face_templates ft where ft.student_id = st.id) as enrolled_at,
               st.biometric_failure_count
        from students st
        join users u on u.id = st.user_id
        where st.deleted_at is null
        order by st.student_number
        limit 500
      `,
    );
    return { students };
  });

  /** Purge needs a second admin: the request and approval must be different people. */
  app.post('/api/v1/admin/biometrics/:studentId/purge', async (request) => {
    const principal = await app.authenticate(request);
    assertCan(principal, 'biometric:purge', institutionScope);
    const { studentId } = request.params as { studentId: string };
    const body = request.body as { reason?: string; approvalToken?: string };

    const approvalKey = `biometric-purge:${studentId}`;
    const existing = await app.kv.get(approvalKey);

    if (!body.approvalToken) {
      if (existing) throw new ApiError('APPROVAL_REQUIRED', 'Waiting for a second administrator to approve.');
      await app.kv.set(approvalKey, principal.userId, 900);
      return { state: 'awaiting_second_approval' as const };
    }
    if (existing === principal.userId) {
      throw new ApiError('APPROVER_MUST_DIFFER', 'A second administrator must approve the purge.');
    }
    if (!existing) throw new ApiError('APPROVAL_REQUIRED', 'Start the purge request first.');

    await app.stores.biometrics.execute(
      sql`delete from biometrics.face_templates where student_id = ${studentId}::uuid`,
    );
    await app.stores.db.execute(
      sql`update students set biometric_failure_count = 0, updated_at = now() where id = ${studentId}::uuid`,
    );
    await app.kv.delete(approvalKey);

    await writeAudit(app.stores.db, {
      actorId: principal.userId,
      actorEmail: principal.email,
      action: 'biometric.purged',
      entity: 'student',
      entityId: studentId,
      after: { reason: body.reason ?? 'administrative purge', approver: principal.userId },
      ip: request.ip,
      requestId: request.id,
    });
    return { state: 'purged' as const };
  });

  // -------------------------------------------------------------- settings
  app.get('/api/v1/admin/settings', async (request) => {
    const principal = await app.authenticate(request);
    assertCan(principal, 'settings:read', institutionScope);
    return { settings: await app.settings() };
  });

  app.patch('/api/v1/admin/settings', async (request) => {
    const principal = await app.authenticate(request);
    assertCan(principal, 'settings:write', institutionScope);
    const input = SettingWrite.parse(request.body);
    const settings = await updateSetting(app.stores.db, {
      key: input.key,
      value: input.value,
      actorId: principal.userId,
      actorEmail: principal.email,
      reason: input.reason,
      ip: request.ip,
      requestId: request.id,
    });
    return { settings };
  });

  app.get('/api/v1/admin/settings/:key/history', async (request) => {
    const principal = await app.authenticate(request);
    assertCan(principal, 'settings:read', institutionScope);
    const { key } = request.params as { key: string };
    return { history: await loadSettingHistory(app.stores.db, key) };
  });

  // ----------------------------------------------------------------- roles
  app.get('/api/v1/admin/roles', async (request) => {
    const principal = await app.authenticate(request);
    assertCan(principal, 'role:read', institutionScope);
    const roles = await rows<Record<string, unknown>>(
      app.stores.db,
      sql`select r.id, r.key, r.name, r.is_system,
                 coalesce(array_agg(p.key) filter (where p.key is not null), '{}') as permissions,
                 (select count(*) from role_assignments ra where ra.role_id = r.id)::int as assignments
          from roles r
          left join role_permissions rp on rp.role_id = r.id
          left join permissions p on p.id = rp.permission_id
          where r.deleted_at is null
          group by r.id order by r.is_system desc, r.name`,
    );
    return { roles };
  });

  app.post('/api/v1/admin/roles', async (request) => {
    const principal = await app.authenticate(request);
    assertCan(principal, 'role:write', institutionScope);
    const input = RoleInput.parse(request.body);

    const [role] = await rows<{ id: string }>(
      app.stores.db,
      sql`insert into roles (key, name, is_system) values (${input.key}, ${input.name}, false) returning id`,
    );
    await app.stores.db.execute(sql`
      insert into role_permissions (role_id, permission_id)
      select ${role!.id}::uuid, p.id from permissions p where p.key = any(${input.permissions}::text[])
      on conflict do nothing
    `);

    await writeAudit(app.stores.db, {
      actorId: principal.userId,
      actorEmail: principal.email,
      action: 'role.created',
      entity: 'role',
      entityId: role!.id,
      after: input,
      ip: request.ip,
      requestId: request.id,
    });
    return { roleId: role!.id };
  });

  app.post('/api/v1/admin/role-assignments', async (request) => {
    const principal = await app.authenticate(request);
    assertCan(principal, 'role:write', institutionScope);
    const input = RoleAssignmentInput.parse(request.body);

    const [role] = await rows<{ id: string }>(
      app.stores.db,
      sql`select id from roles where key = ${input.roleKey} and deleted_at is null`,
    );
    if (!role) throw new ApiError('NOT_FOUND', 'Role not found.');

    await app.stores.db.execute(sql`
      insert into role_assignments (user_id, role_id, scope_type, scope_id)
      values (${input.userId}::uuid, ${role.id}::uuid, ${input.scopeType}, ${input.scopeId}::uuid)
      on conflict do nothing
    `);
    await writeAudit(app.stores.db, {
      actorId: principal.userId,
      actorEmail: principal.email,
      action: 'role.assigned',
      entity: 'user',
      entityId: input.userId,
      after: input,
      ip: request.ip,
      requestId: request.id,
    });
    return { ok: true as const };
  });

  // ----------------------------------------------------------------- audit
  app.get('/api/v1/admin/audit', async (request) => {
    const principal = await app.authenticate(request);
    assertCan(principal, 'audit:read', institutionScope);
    const query = request.query as { actorId?: string; entity?: string; action?: string; from?: string; to?: string };

    const entries = await rows<Record<string, unknown>>(
      app.stores.db,
      sql`
        select id, actor_id, actor_email, action, entity, entity_id, before, after, ip, at::text as at
        from audit_log
        where (${query.actorId ?? null}::uuid is null or actor_id = ${query.actorId ?? null}::uuid)
          and (${query.entity ?? null}::text is null or entity = ${query.entity ?? null})
          and (${query.action ?? null}::text is null or action = ${query.action ?? null})
          and (${query.from ?? null}::date is null or at >= ${query.from ?? null}::date)
          and (${query.to ?? null}::date is null or at < (${query.to ?? null}::date + interval '1 day'))
        order by at desc
        limit 500
      `,
    );
    return { entries };
  });

  // ---------------------------------------------------------- integrations
  app.get('/api/v1/admin/integrations', async (request) => {
    const principal = await app.authenticate(request);
    assertCan(principal, 'integration:read', institutionScope);
    const keys = await rows<Record<string, unknown>>(
      app.stores.db,
      sql`select id, name, scopes, expires_at, last_used_at, revoked_at, created_at from api_keys order by created_at desc`,
    );
    const hooks = await rows<Record<string, unknown>>(
      app.stores.db,
      sql`select id, url, events, is_active, created_at from webhooks order by created_at desc`,
    );
    return { apiKeys: keys, webhooks: hooks };
  });

  app.post('/api/v1/admin/integrations/api-keys', async (request) => {
    const principal = await app.authenticate(request);
    assertCan(principal, 'integration:write', institutionScope);
    const input = ApiKeyInput.parse(request.body);
    const { createHash, randomBytes } = await import('node:crypto');
    const secret = `att_${randomBytes(24).toString('base64url')}`;
    const keyHash = createHash('sha256').update(secret).digest('hex');

    const [key] = await rows<{ id: string }>(
      app.stores.db,
      sql`insert into api_keys (name, key_hash, scopes, created_by, expires_at)
          values (${input.name}, ${keyHash}, ${input.scopes}, ${principal.userId}::uuid,
                  now() + (${input.expiresInDays} || ' days')::interval)
          returning id`,
    );

    await writeAudit(app.stores.db, {
      actorId: principal.userId,
      actorEmail: principal.email,
      action: 'integration.api_key_created',
      entity: 'api_key',
      entityId: key!.id,
      after: { name: input.name, scopes: input.scopes, expiresInDays: input.expiresInDays },
      ip: request.ip,
      requestId: request.id,
    });

    // Shown once; only the hash is stored.
    return { id: key!.id, secret };
  });

  app.post('/api/v1/admin/integrations/webhooks', async (request) => {
    const principal = await app.authenticate(request);
    assertCan(principal, 'integration:write', institutionScope);
    const input = WebhookInput.parse(request.body);
    const masterKey = parseMasterKey(app.env.MASTER_KEY);

    const [hook] = await rows<{ id: string }>(
      app.stores.db,
      sql`insert into webhooks (url, events, secret_enc) values (${input.url}, ${input.events}, ${encryptSecret(input.secret, masterKey)})
          returning id`,
    );
    await writeAudit(app.stores.db, {
      actorId: principal.userId,
      actorEmail: principal.email,
      action: 'integration.webhook_created',
      entity: 'webhook',
      entityId: hook!.id,
      after: { url: input.url, events: input.events },
      ip: request.ip,
      requestId: request.id,
    });
    return { id: hook!.id };
  });

  // ------------------------------------------------------------ people list
  app.get('/api/v1/admin/people', async (request) => {
    const principal = await app.authenticate(request);
    assertCan(principal, 'people:read', institutionScope);
    const query = request.query as { kind?: string; q?: string };
    const search = query.q ? `%${query.q}%` : null;

    const students = await rows<Record<string, unknown>>(
      app.stores.db,
      sql`select st.id, st.student_number, u.name, u.email, u.status,
                 (select count(*) from enrollments e where e.student_id = st.id and e.status = 'active')::int as enrollments
          from students st join users u on u.id = st.user_id
          where st.deleted_at is null
            and (${search}::text is null or u.name ilike ${search} or st.student_number ilike ${search} or u.email ilike ${search})
          order by st.student_number limit 200`,
    );

    const staff = await rows<Record<string, unknown>>(
      app.stores.db,
      sql`select l.id, l.staff_number, u.name, u.email, u.status, d.name as department, l.is_teaching_assistant
          from lecturers l join users u on u.id = l.user_id
          join departments d on d.id = l.department_id
          where l.deleted_at is null
            and (${search}::text is null or u.name ilike ${search} or l.staff_number ilike ${search})
          order by l.staff_number limit 200`,
    );

    return { students, staff };
  });
}

function snake(key: string): string {
  return key.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);
}

function normaliseValue(value: unknown): unknown {
  if (Array.isArray(value)) return value;
  return value ?? null;
}
