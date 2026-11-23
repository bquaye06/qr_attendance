import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ServerResponse } from 'node:http';
import { classSessions } from '@attend/db';
import {
  ExtendWindowInput,
  QrTokenEvent,
  RosterResponse,
  SessionSummary,
  StartSessionInput,
  CloseSessionInput,
} from '@attend/contracts';
import { ApiError } from '../lib/problem.ts';
import { assertCan } from '../lib/auth.ts';
import { rows } from '../lib/query.ts';
import { channels } from '../lib/events.ts';
import { writeAudit } from '../lib/audit.ts';
import { issueQrToken } from '../domain/qr-token.ts';
import { computeCheckinWindow, extendWindow as extendWindowRule } from '../domain/session.ts';
import { newSessionSecret, decryptSecret, parseMasterKey } from '../domain/secrets.ts';
import { encryptSecret } from '../domain/secrets.ts';
import { loadRoster, buildRosterEvent } from '../services/roster.ts';
import { loadSessionAccess, loadTeachingOfferings } from '../services/session-access.ts';

/**
 * Lecturer portal endpoints: today's sessions, opening and closing a session,
 * the rotating QR stream, the live roster stream, window extension and history.
 *
 * The projector page only ever receives tokens and counts — never student
 * names — so a photographed projector screen leaks nothing but a dead token.
 */
export async function registerSessionRoutes(app: FastifyInstance): Promise<void> {
  const masterKey = parseMasterKey(app.env.MASTER_KEY);

  async function summary(sessionId: string): Promise<SessionSummary> {
    const [row] = await rows<{
      id: string;
      offering_id: string;
      course_code: string;
      course_title: string;
      room_name: string | null;
      starts_at: Date;
      ends_at: Date;
      checkin_opens_at: Date;
      checkin_closes_at: Date;
      late_after: Date;
      status: SessionSummary['status'];
      geofence_enabled: boolean;
      enrolled: number;
      present: number;
      late: number;
      flagged: number;
      absent: number;
    }>(
      app.stores.db,
      sql`
        select s.id, s.offering_id, c.code as course_code, c.title as course_title, r.name as room_name,
               s.starts_at, s.ends_at, s.checkin_opens_at, s.checkin_closes_at, s.late_after, s.status,
               s.geofence_enabled,
               (select count(*) from enrollments e
                 where e.offering_id = s.offering_id and e.status = 'active' and e.deleted_at is null)::int as enrolled,
               count(ar.id) filter (where ar.status in ('present', 'present_manual'))::int as present,
               count(ar.id) filter (where ar.status = 'late')::int as late,
               count(ar.id) filter (where ar.status = 'present_flagged')::int as flagged,
               count(ar.id) filter (where ar.status = 'absent')::int as absent
        from class_sessions s
        join course_offerings o on o.id = s.offering_id
        join courses c on c.id = o.course_id
        left join rooms r on r.id = s.room_id
        left join attendance_records ar on ar.session_id = s.id
        where s.id = ${sessionId}::uuid
        group by s.id, s.offering_id, c.code, c.title, r.name
      `,
    );
    if (!row) throw new ApiError('NOT_FOUND', 'Session not found.');
    return SessionSummary.parse({
      id: row.id,
      offeringId: row.offering_id,
      courseCode: row.course_code,
      courseTitle: row.course_title,
      roomName: row.room_name,
      startsAt: row.starts_at.toISOString(),
      endsAt: row.ends_at.toISOString(),
      checkinOpensAt: row.checkin_opens_at.toISOString(),
      checkinClosesAt: row.checkin_closes_at.toISOString(),
      lateAfter: row.late_after.toISOString(),
      status: row.status,
      geofenceEnabled: row.geofence_enabled,
      enrolledCount: row.enrolled,
      presentCount: row.present,
      lateCount: row.late,
      flaggedCount: row.flagged,
      absentCount: row.absent,
    });
  }

  // ---------------------------------------------------------------- today
  app.get('/api/v1/lecturer/today', async (request) => {
    const principal = await app.authenticate(request);
    const timeZone = (await app.settings()).timeZone;

    const sessions = await rows<{ session_id: string }>(
      app.stores.db,
      sql`
        select s.id as session_id
        from class_sessions s
        join teaching_assignments ta on ta.offering_id = s.offering_id and ta.lecturer_id = ${principal.lecturerId}::uuid
        where s.starts_at >= date_trunc('day', now() at time zone ${timeZone}) at time zone ${timeZone}
          and s.starts_at <  date_trunc('day', now() at time zone ${timeZone}) at time zone ${timeZone} + interval '1 day'
        order by s.starts_at
      `,
    );

    const summaries = await Promise.all(
      sessions.map(async (session) => {
        const access = await loadSessionAccess(app.stores.db, session.session_id);
        assertCan(principal, 'session:read', access);
        return summary(session.session_id);
      }),
    );
    return { sessions: summaries };
  });

  app.get('/api/v1/lecturer/offerings', async (request) => {
    const principal = await app.authenticate(request);
    if (!principal.lecturerId) throw new ApiError('FORBIDDEN', 'Teaching staff only.');
    const offeringIds = await loadTeachingOfferings(app.stores.db, principal.lecturerId);

    const result = await rows<{
      offering_id: string;
      course_code: string;
      course_title: string;
      term_name: string;
      role: string;
      student_count: number;
    }>(
      app.stores.db,
      sql`
        select o.id as offering_id, c.code as course_code, c.title as course_title, t.name as term_name,
               ta.role,
               (select count(*) from enrollments e
                 where e.offering_id = o.id and e.status = 'active' and e.deleted_at is null)::int as student_count
        from course_offerings o
        join courses c on c.id = o.course_id
        join terms t on t.id = o.term_id
        join teaching_assignments ta on ta.offering_id = o.id and ta.lecturer_id = ${principal.lecturerId}::uuid
        where o.deleted_at is null
        order by c.code
      `,
    );
    void offeringIds;
    return { offerings: result };
  });

  // ---------------------------------------------------------- start / close
  app.post('/api/v1/sessions/:id/start', async (request) => {
    const principal = await app.authenticate(request);
    const { id } = request.params as { id: string };
    const input = StartSessionInput.parse(request.body ?? {});
    const access = await loadSessionAccess(app.stores.db, id);
    assertCan(principal, 'session:start', access);

    if (access.status === 'cancelled') throw new ApiError('SESSION_CANCELLED', 'This session was cancelled.');
    if (access.status === 'open') return { session: await summary(id) };
    if (access.status === 'closed') throw new ApiError('SESSION_CLOSED', 'This session is already closed.');

    const settings = await app.settings();
    const window = computeCheckinWindow({
      startsAt: access.startsAt,
      opensOffsetMinutes: settings.checkinOpensOffsetMinutes,
      closesOffsetMinutes: input.checkinClosesOffsetMinutes ?? settings.checkinClosesOffsetMinutes,
      lateAfterMinutes: input.lateAfterMinutes ?? settings.lateAfterMinutes,
    });

    const secret = newSessionSecret();
    await app.stores.db
      .update(classSessions)
      .set({
        status: 'open',
        qrSecretEnc: encryptSecret(secret, masterKey),
        qrSecretRotatedAt: new Date(),
        checkinOpensAt: window.opensAt,
        checkinClosesAt: window.closesAt,
        lateAfter: window.lateAfter,
        geofenceEnabled: input.geofenceEnabled ?? settings.geofenceEnabled,
        openedAt: new Date(),
        openedBy: principal.userId,
        updatedAt: new Date(),
      })
      .where(eq(classSessions.id, id));

    await writeAudit(app.stores.db, {
      actorId: principal.userId,
      actorEmail: principal.email,
      action: 'session.started',
      entity: 'class_session',
      entityId: id,
      after: {
        checkinOpensAt: window.opensAt.toISOString(),
        checkinClosesAt: window.closesAt.toISOString(),
        geofenceEnabled: input.geofenceEnabled ?? settings.geofenceEnabled,
      },
      ip: request.ip,
      requestId: request.id,
    });

    return { session: await summary(id) };
  });

  app.post('/api/v1/sessions/:id/close', async (request) => {
    const principal = await app.authenticate(request);
    const { id } = request.params as { id: string };
    const input = CloseSessionInput.parse(request.body ?? {});
    const access = await loadSessionAccess(app.stores.db, id);
    assertCan(principal, 'session:close', access);
    if (access.status === 'closed') return { session: await summary(id) };

    await app.stores.db
      .update(classSessions)
      .set({
        status: 'closed',
        closedAt: new Date(),
        closedBy: principal.userId,
        // The signing secret is destroyed on close: an old QR token cannot be
        // validated against a session that is done.
        qrSecretEnc: null,
        updatedAt: new Date(),
      })
      .where(eq(classSessions.id, id));

    // Mark everyone without a record absent, inside the same request.
    await markAbsent(app, id);

    await writeAudit(app.stores.db, {
      actorId: principal.userId,
      actorEmail: principal.email,
      action: 'session.closed',
      entity: 'class_session',
      entityId: id,
      after: { reason: input.reason ?? null },
      ip: request.ip,
      requestId: request.id,
    });

    await app.hub.publish(channels.sessionRoster(id), await buildRosterEvent(app.stores.db, id));
    return { session: await summary(id) };
  });

  app.post('/api/v1/sessions/:id/extend', async (request) => {
    const principal = await app.authenticate(request);
    const { id } = request.params as { id: string };
    const input = ExtendWindowInput.parse(request.body);
    const access = await loadSessionAccess(app.stores.db, id);
    assertCan(principal, 'session:manage', access);

    const result = extendWindowRule(access, input.minutes);
    if (!result.extended) {
      throw result.reason === 'already_extended'
        ? new ApiError('WINDOW_ALREADY_EXTENDED', 'This window has already been extended once.')
        : new ApiError('SESSION_CLOSED', 'This session is closed.');
    }

    await app.stores.db
      .update(classSessions)
      .set({
        checkinClosesAt: result.closesAt,
        windowExtensions: access.windowExtensions + 1,
        updatedAt: new Date(),
      })
      .where(eq(classSessions.id, id));

    await writeAudit(app.stores.db, {
      actorId: principal.userId,
      actorEmail: principal.email,
      action: 'session.window_extended',
      entity: 'class_session',
      entityId: id,
      before: { checkinClosesAt: access.checkinClosesAt.toISOString() },
      after: { checkinClosesAt: result.closesAt.toISOString(), minutes: input.minutes, reason: input.reason },
      ip: request.ip,
      requestId: request.id,
    });

    return { session: await summary(id) };
  });

  // ------------------------------------------------------------- roster
  app.get('/api/v1/sessions/:id/roster', async (request) => {
    const principal = await app.authenticate(request);
    const { id } = request.params as { id: string };
    const access = await loadSessionAccess(app.stores.db, id);
    assertCan(principal, 'attendance:read', access);

    const entries = await loadRoster(app.stores.db, id);
    return RosterResponse.parse({
      session: await summary(id),
      entries: entries.map((entry) => ({
        studentId: entry.studentId,
        studentNumber: entry.studentNumber,
        name: entry.name,
        status: entry.status,
        method: entry.method,
        checkedInAt: entry.checkedInAt,
        flagReason: entry.flagReason,
        riskScore: entry.riskScore,
        attempted: entry.attempted,
      })),
    });
  });

  app.get('/api/v1/sessions/:id/roster/stream', async (request, reply) => {
    const principal = await app.authenticate(request);
    const { id } = request.params as { id: string };
    const access = await loadSessionAccess(app.stores.db, id);
    assertCan(principal, 'attendance:read', access);

    startSse(reply.raw);
    const channel = channels.sessionRoster(id);
    const initial = await buildRosterEvent(app.stores.db, id);
    writeEvent(reply.raw, 'roster', initial);

    const unsubscribe = await app.hub.subscribe(channel, (payload) => {
      writeEvent(reply.raw, 'roster', payload);
    });
    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);

    request.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      reply.raw.end();
    });
    return reply;
  });

  // ------------------------------------------------------------ QR stream
  app.get('/api/v1/sessions/:id/qr/stream', async (request, reply) => {
    const principal = await app.authenticate(request);
    const { id } = request.params as { id: string };
    const access = await loadSessionAccess(app.stores.db, id);
    assertCan(principal, 'session:read', access);
    if (!access.qrSecretEnc) throw new ApiError('SESSION_CLOSED', 'Start the session to display a QR code.');

    const settings = await app.settings();
    const secret = decryptSecret(access.qrSecretEnc, masterKey);

    startSse(reply.raw);

    const emit = (): void => {
      const { token, payload } = issueQrToken({
        sessionId: id,
        secret,
        nowMs: Date.now(),
        ttlSeconds: settings.qrExpirySeconds,
        nonce: randomUUID(),
      });
      writeEvent(
        reply.raw,
        'qr',
        QrTokenEvent.parse({
          token,
          issuedAt: new Date(payload.iat * 1000).toISOString(),
          expiresAt: new Date(payload.exp * 1000).toISOString(),
          rotationSeconds: settings.qrRotationSeconds,
          sessionId: id,
        }),
      );
    };

    emit();
    const rotation = setInterval(emit, Math.max(5, settings.qrRotationSeconds) * 1000);
    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);

    request.raw.on('close', () => {
      clearInterval(rotation);
      clearInterval(heartbeat);
      reply.raw.end();
    });
    return reply;
  });

  // -------------------------------------------------------------- history
  app.get('/api/v1/lecturer/offerings/:offeringId/history', async (request) => {
    const principal = await app.authenticate(request);
    const { offeringId } = request.params as { offeringId: string };
    const { loadOfferingScope } = await import('../services/session-access.ts');
    const scope = await loadOfferingScope(app.stores.db, offeringId);
    assertCan(principal, 'session:read', scope);

    const sessions = await rows<{
      session_id: string;
      starts_at: Date;
      status: string;
      room_name: string | null;
      present: number;
      absent: number;
    }>(
      app.stores.db,
      sql`
        select s.id as session_id, s.starts_at, s.status, r.name as room_name,
               count(ar.id) filter (where ar.status in ('present','late','present_manual'))::int as present,
               count(ar.id) filter (where ar.status = 'absent')::int as absent
        from class_sessions s
        left join rooms r on r.id = s.room_id
        left join attendance_records ar on ar.session_id = s.id
        where s.offering_id = ${offeringId}::uuid
        group by s.id, r.name
        order by s.starts_at desc
      `,
    );

    return {
      offering: { id: scope.offeringId, code: scope.courseCode, title: scope.courseTitle, term: scope.termName },
      sessions: sessions.map((session) => ({
        sessionId: session.session_id,
        startsAt: session.starts_at.toISOString(),
        roomName: session.room_name,
        status: session.status,
        present: session.present,
        absent: session.absent,
      })),
    };
  });
}

/** Shared absence sweep: also called by the job worker. */
export async function markAbsent(app: FastifyInstance, sessionId: string): Promise<number> {
  const result = await app.stores.db.execute(sql`
    insert into attendance_records (session_id, student_id, status, method)
    select s.id, e.student_id, 'absent', 'auto'
    from class_sessions s
    join enrollments e on e.offering_id = s.offering_id and e.status = 'active' and e.deleted_at is null
    where s.id = ${sessionId}::uuid
      and not exists (
        select 1 from attendance_records ar where ar.session_id = s.id and ar.student_id = e.student_id
      )
    on conflict do nothing
  `);
  return (result as unknown as { rowCount: number }).rowCount ?? 0;
}

function startSse(response: ServerResponse): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  response.write('retry: 3000\n\n');
}

function writeEvent(response: ServerResponse, event: string, payload: unknown): void {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}
