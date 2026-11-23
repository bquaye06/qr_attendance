import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { checkinClaims, devices, students } from '@attend/db';
import { and, eq, isNull } from 'drizzle-orm';
import { ClaimInput, ClaimResponse, VerifyInput, VerifyResponse } from '@attend/contracts';
import type { AttendanceStatus, LivenessChallenge } from '@attend/contracts';
import { ApiError } from '../lib/problem.ts';
import { assertStudent } from '../lib/auth.ts';
import { rows } from '../lib/query.ts';
import { decideClaim, decideVerification } from '../domain/decide.ts';
import { base64UrlDecode, bufferToB64u, verifyAssertion } from '../domain/webauthn.ts';
import { verifyQrToken } from '../domain/qr-token.ts';
import { decryptSecret, parseMasterKey } from '../domain/secrets.ts';
import { fingerprintMatches, hashFingerprint } from '../domain/fingerprint.ts';
import { evaluateGeofence, ipMatchesAllowlist } from '../domain/geo.ts';
import { cosineSimilarity, nearestOtherSimilarity } from '../domain/similarity.ts';
import { computeRiskScore } from '../domain/risk.ts';
import { punctualityFor } from '../domain/session.ts';
import { resolveFeatureFlag } from '@attend/contracts';
import type { Settings } from '@attend/contracts';
import {
  idempotencyKeyFor,
  lookupIdempotent,
  requestHash,
  requireIdempotencyKey,
  storeIdempotent,
} from '../lib/idempotency.ts';
import { writeAudit } from '../lib/audit.ts';
import { channels } from '../lib/events.ts';
import { buildRosterEvent } from '../services/roster.ts';

/**
 * Check-in: claim then verify.
 *
 * Nothing reaches `attendance_records` until both stages pass, and each stage is
 * a single database transaction so a race between two requests cannot create a
 * duplicate (the unique indexes are the real guard; the transaction just keeps
 * the attempt log consistent with the result).
 *
 * The WebAuthn assertion is bound to the QR token: the client signs
 * sha256(token) and the server recomputes it. Because every QR token carries a
 * single-use nonce, the assertion cannot be lifted and replayed against a later
 * token.
 */
export async function registerCheckinRoutes(app: FastifyInstance): Promise<void> {
  const masterKey = parseMasterKey(app.env.MASTER_KEY);
  const rpId = app.env.WEBAUTHN_RP_ID;
  const allowedOrigins = app.env.WEBAUTHN_ALLOWED_ORIGINS.split(',').map((origin) => origin.trim());

  async function enforceRateLimit(studentId: string, limit: number): Promise<void> {
    const bucket = Math.floor(Date.now() / 60_000);
    const count = await app.kv.increment(`checkin:${studentId}:${bucket}`, 120);
    if (count > limit) {
      throw new ApiError('RATE_LIMITED', 'Too many check-in attempts. Wait a minute and try again.');
    }
  }

  async function recordAttempt(
    sessionId: string,
    studentId: string,
    deviceId: string | null,
    stage: 'claim' | 'face',
    result: 'pass' | 'fail' | 'flagged',
    detail: {
      failureReason?: string;
      similarity?: number | null;
      livenessScore?: number | null;
      qualityScore?: number | null;
      riskScore?: number | null;
      geoDistanceM?: number | null;
      tokenIssuedAt?: Date | null;
      ip?: string | null;
    },
  ): Promise<void> {
    await app.stores.db.execute(sql`
      insert into attendance_attempts
        (session_id, student_id, device_id, stage, result, failure_reason, similarity,
         liveness_score, quality_score, risk_score, geo_distance_m, token_issued_at, ip)
      values (${sessionId}::uuid, ${studentId}::uuid, ${deviceId}::uuid, ${stage}, ${result},
              ${detail.failureReason ?? null}, ${detail.similarity ?? null}, ${detail.livenessScore ?? null},
              ${detail.qualityScore ?? null}, ${detail.riskScore ?? null}, ${detail.geoDistanceM ?? null},
              ${detail.tokenIssuedAt ?? null}, ${detail.ip ?? null})
    `);
  }

  // ------------------------------------------------------------------ claim
  app.post('/api/v1/checkin/claim', async (request, reply) => {
    const principal = await app.authenticate(request);
    const studentId = assertStudent(principal);
    const input = ClaimInput.parse(request.body);
    const settings = await app.settings();
    const idempotencyHeader = requireIdempotencyKey(request.headers['idempotency-key']);
    const idempotencyKey = idempotencyKeyFor(principal.userId, idempotencyHeader);
    const hash = requestHash(request.body);

    const replay = await lookupIdempotent(app.stores.db, idempotencyKey, 'POST /checkin/claim', hash);
    if (replay) return reply.status(replay.status).send(replay.body);

    await enforceRateLimit(studentId, settings.checkinRateLimitPerMinute);

    // 1. Locate the session from the (still unverified) token payload, then
    //    verify the signature with that session's own secret.
    const tokenParts = input.token.split('.');
    if (tokenParts.length !== 3) throw new ApiError('QR_INVALID', 'This QR code could not be read.');
    let sessionId: string | null = null;
    try {
      const payload = JSON.parse(base64UrlDecode(tokenParts[1]!).toString('utf8')) as { sid?: string };
      sessionId = typeof payload.sid === 'string' ? payload.sid : null;
    } catch {
      throw new ApiError('QR_INVALID', 'This QR code could not be read.');
    }
    if (!sessionId) throw new ApiError('QR_INVALID', 'This QR code could not be read.');

    const [sessionRow] = await rows<{
      id: string;
      status: 'scheduled' | 'open' | 'closed' | 'cancelled';
      qr_secret_enc: string | null;
      checkin_opens_at: Date;
      checkin_closes_at: Date;
      late_after: Date;
      geofence_enabled: boolean;
      ip_allowlist_enforced: boolean;
      room_id: string | null;
      faculty_id: string | null;
      geofence_m: number | null;
      latitude: string | null;
      longitude: string | null;
      allowed_cidrs: string[] | null;
      course_code: string;
      course_title: string;
      room_name: string | null;
    }>(
      app.stores.db,
      sql`
        select s.id, s.status, s.qr_secret_enc, s.checkin_opens_at, s.checkin_closes_at, s.late_after,
               s.geofence_enabled, s.ip_allowlist_enforced, s.room_id,
               f.id as faculty_id,
               r.geofence_m, r.latitude, r.longitude, r.allowed_cidrs, r.name as room_name,
               c.code as course_code, c.title as course_title
        from class_sessions s
        join course_offerings o on o.id = s.offering_id
        join courses c on c.id = o.course_id
        join departments d on d.id = c.department_id
        join faculties f on f.id = d.faculty_id
        left join rooms r on r.id = s.room_id
        where s.id = ${sessionId}::uuid
      `,
    );

    const tokenVerification =
      sessionRow?.qr_secret_enc
        ? verifyQrToken({
            token: input.token,
            secret: decryptSecret(sessionRow.qr_secret_enc, masterKey),
            nowMs: Date.now(),
          })
        : ({ ok: false, reason: 'malformed' } as const);

    const tokenPayload = tokenVerification.ok ? tokenVerification.payload : null;

    // 2. Everything else the decision needs.
    const [facts] = await rows<{
      enrolled: boolean;
      consent_granted: boolean;
      face_enrolled: boolean;
      device_id: string | null;
      device_status: string | null;
      device_fingerprint: string | null;
      device_public_key: string | null;
      device_sign_count: string | null;
      device_bound_at: Date | null;
      already_checked_in: boolean;
      device_used_by_other: boolean;
      recent_failures: number;
    }>(
      app.stores.db,
      sql`
        select
          exists (select 1 from enrollments e
                  join course_offerings o on o.id = e.offering_id
                  where o.id = (select offering_id from class_sessions where id = ${sessionId}::uuid)
                    and e.student_id = ${studentId}::uuid
                    and e.status = 'active' and e.deleted_at is null) as enrolled,
          exists (select 1 from biometric_consents bc
                  where bc.student_id = ${studentId}::uuid and bc.withdrawn_at is null) as consent_granted,
          exists (select 1 from biometrics.face_templates ft
                  where ft.student_id = ${studentId}::uuid and ft.is_active) as face_enrolled,
          d.id as device_id, d.status as device_status, d.fingerprint_hash as device_fingerprint,
          d.public_key as device_public_key, d.sign_count::text as device_sign_count, d.bound_at as device_bound_at,
          exists (select 1 from attendance_records ar
                  where ar.session_id = ${sessionId}::uuid and ar.student_id = ${studentId}::uuid) as already_checked_in,
          exists (select 1 from attendance_records ar
                  join devices od on od.id = ar.device_id
                  where ar.session_id = ${sessionId}::uuid
                    and od.student_id = ${studentId}::uuid
                    and ar.student_id <> ${studentId}::uuid) as device_used_by_other,
          (select count(*) from attendance_attempts a
            where a.session_id = ${sessionId}::uuid and a.student_id = ${studentId}::uuid and a.result = 'fail')::int as recent_failures
        from students st
        left join lateral (
          select * from devices dv
          where dv.student_id = st.id and dv.status = 'active'
          order by dv.bound_at desc limit 1
        ) d on true
        where st.id = ${studentId}::uuid
      `,
    );

    // A device may only check in one person per session: compare by fingerprint
    // too, so a re-bound device cannot be used to hide the previous user.
    const deviceUsedByOther = await deviceUsedByAnotherStudent(
      app,
      sessionId,
      studentId,
      facts?.device_id ?? null,
    );

    const fingerprintMatched = facts?.device_fingerprint
      ? fingerprintMatches(
          facts.device_fingerprint,
          hashFingerprint(input.fingerprint, app.env.FINGERPRINT_PEPPER),
        )
      : false;

    const expectedChallenge = bufferToB64u(createHash('sha256').update(input.token).digest());
    const assertion =
      facts?.device_public_key && input.credential.id
        ? verifyAssertion({
            rpId,
            allowedOrigins,
            expectedChallenge,
            clientDataJSON: input.credential.response.clientDataJSON,
            authenticatorData: input.credential.response.authenticatorData,
            signature: input.credential.response.signature,
            credentialId: input.credential.id,
            publicKeyCose: facts.device_public_key,
            storedSignCount: Number(facts.device_sign_count ?? '0'),
            requireUserVerification: true,
          })
        : ({ ok: false, reason: 'unknown_credential' } as const);

    const geofenceEnabled =
      sessionRow?.geofence_enabled === true ||
      (await resolveFlags(app, sessionRow?.faculty_id ?? null, settings, request)) === 'on';

    const roomGeofence = sessionRow?.latitude && sessionRow?.longitude
      ? evaluateGeofence(
          {
            latitude: Number(sessionRow.latitude),
            longitude: Number(sessionRow.longitude),
            geofenceM: sessionRow.geofence_m ?? settings.geofenceDefaultRadiusM,
          },
          input.location ?? null,
          settings.geofenceDefaultRadiusM,
        )
      : { inside: true, distanceM: null as number | null, skipped: true };

    const ipAllowed =
      sessionRow?.ip_allowlist_enforced && sessionRow.allowed_cidrs && sessionRow.allowed_cidrs.length > 0
        ? ipMatchesAllowlist(request.ip, sessionRow.allowed_cidrs)
        : true;

    const decision = decideClaim({
      now: new Date(),
      token: tokenVerification.ok
        ? { verified: true, sessionId: tokenPayload?.sid }
        : { verified: false, reason: tokenVerification.reason },
      session: sessionRow
        ? {
            id: sessionRow.id,
            status: sessionRow.status,
            checkinOpensAt: sessionRow.checkin_opens_at,
            checkinClosesAt: sessionRow.checkin_closes_at,
          }
        : null,
      enrollmentActive: facts?.enrolled ?? false,
      consentGranted: facts?.consent_granted ?? false,
      faceEnrolled: facts?.face_enrolled ?? false,
      device: {
        registered: Boolean(facts?.device_id),
        status: (facts?.device_status as 'active' | 'revoked' | null) ?? null,
        fingerprintMatches: fingerprintMatched,
      },
      webauthnOk: assertion.ok,
      ipAllowed,
      geofence: {
        enabled: geofenceEnabled,
        inside: roomGeofence.inside,
        distanceM: roomGeofence.distanceM,
      },
      alreadyCheckedIn: facts?.already_checked_in ?? false,
      deviceUsedByOtherStudent: deviceUsedByOther,
    });

    if (!decision.allowed) {
      if (sessionRow) {
        await recordAttempt(sessionRow.id, studentId, facts?.device_id ?? null, 'claim', 'fail', {
          failureReason: decision.code,
          geoDistanceM: roomGeofence.distanceM,
          tokenIssuedAt: tokenPayload ? new Date(tokenPayload.iat * 1000) : null,
          ip: request.ip,
        });
      }
      await writeAudit(app.stores.db, {
        actorId: principal.userId,
        actorEmail: principal.email,
        action: 'checkin.claim_rejected',
        entity: 'student',
        entityId: studentId,
        after: { code: decision.code, sessionId },
        ip: request.ip,
        requestId: request.id,
      });
      throw new ApiError(decision.code, decision.detail);
    }

    // 3. Success: open the claim window and issue the liveness challenge.
    const challenge = pickChallenge(settings, sessionRow?.faculty_id ?? null, request);
    const expiresAt = new Date(Date.now() + settings.claimTtlSeconds * 1000);
    const [claim] = await app.stores.db
      .insert(checkinClaims)
      .values({
        sessionId: sessionId,
        studentId,
        deviceId: facts!.device_id!,
        challenge,
        expiresAt,
      })
      .returning({ id: checkinClaims.id });

    // Advance the authenticator counter so a replayed assertion is rejected.
    if (assertion.ok) {
      await app.stores.db
        .update(devices)
        .set({ signCount: assertion.value.newSignCount, updatedAt: new Date() })
        .where(eq(devices.id, facts!.device_id!));
    }

    await recordAttempt(sessionId, studentId, facts?.device_id ?? null, 'claim', 'pass', {
      geoDistanceM: roomGeofence.distanceM,
      tokenIssuedAt: tokenPayload ? new Date(tokenPayload.iat * 1000) : null,
      ip: request.ip,
    });

    const response = ClaimResponse.parse({
      claimId: claim!.id,
      expiresAt: expiresAt.toISOString(),
      challenge,
      session: {
        id: sessionId,
        courseCode: sessionRow!.course_code,
        courseTitle: sessionRow!.course_title,
        roomName: sessionRow!.room_name ?? null,
        checkinClosesAt: sessionRow!.checkin_closes_at.toISOString(),
      },
    });

    await storeIdempotent(app.stores.db, idempotencyKey, principal.userId, 'POST /checkin/claim', hash, {
      status: 200,
      body: response,
    });

    return reply.status(200).send(response);
  });

  // ----------------------------------------------------------------- verify
  app.post('/api/v1/checkin/verify', async (request, reply) => {
    const principal = await app.authenticate(request);
    const studentId = assertStudent(principal);
    const input = VerifyInput.parse(request.body);
    const settings = await app.settings();
    const idempotencyHeader = requireIdempotencyKey(request.headers['idempotency-key']);
    const idempotencyKey = idempotencyKeyFor(principal.userId, idempotencyHeader);
    const hash = requestHash({ claimId: input.claimId, frames: input.frames.length });

    const replay = await lookupIdempotent(app.stores.db, idempotencyKey, 'POST /checkin/verify', hash);
    if (replay) return reply.status(replay.status).send(replay.body);

    await enforceRateLimit(studentId, settings.checkinRateLimitPerMinute);

    const [claim] = await app.stores.db
      .select()
      .from(checkinClaims)
      .where(and(eq(checkinClaims.id, input.claimId), eq(checkinClaims.studentId, studentId)))
      .limit(1);
    if (!claim) throw new ApiError('CLAIM_INVALID', 'This check-in claim no longer exists.');
    if (claim.consumedAt) throw new ApiError('CLAIM_ALREADY_USED', 'This check-in was already completed.');
    if (claim.expiresAt <= new Date()) {
      throw new ApiError('CLAIM_EXPIRED', 'The check-in window for this claim expired. Scan the QR code again.');
    }

    const [session] = await rows<{
      id: string;
      status: string;
      checkin_closes_at: Date;
      late_after: Date;
      course_code: string;
    }>(
      app.stores.db,
      sql`select s.id, s.status, s.checkin_closes_at, s.late_after, c.code as course_code
          from class_sessions s
          join course_offerings o on o.id = s.offering_id
          join courses c on c.id = o.course_id
          where s.id = ${claim.sessionId}::uuid`,
    );
    if (!session) throw new ApiError('QR_INVALID', 'Session not found.');
    if (session.status !== 'open') throw new ApiError('SESSION_CLOSED', 'This session is no longer open.');

    await enforceFaceAttemptLimit(app, studentId);

    // 1. Face service: quality, liveness and a 512-d embedding.
    let face;
    try {
      face = await app.face.verify(input.frames, claim.challenge as LivenessChallenge);
    } catch (error) {
      await recordAttempt(claim.sessionId, studentId, claim.deviceId, 'face', 'fail', {
        failureReason: 'FACE_SERVICE_UNAVAILABLE',
        ip: request.ip,
      });
      throw error;
    }

    // 2. Compare with this student's template.
    const [template] = await rows<{ embedding: string }>(
      app.stores.biometrics,
      sql`select embedding::text as embedding from biometrics.face_templates
          where student_id = ${studentId}::uuid and is_active
          order by enrolled_at desc limit 1`,
    );
    if (!template) throw new ApiError('FACE_NOT_ENROLLED', 'Enrol your face before checking in.');

    const storedEmbedding = parseVector(template.embedding);
    const similarity = cosineSimilarity(storedEmbedding, face.embedding);

    // 3. The same face must not already be checked in under another account.
    const others = await rows<{ student_id: string; embedding: string }>(
      app.stores.biometrics,
      sql`
        select ft.student_id, ft.embedding::text as embedding
        from biometrics.face_templates ft
        join attendance_records ar on ar.student_id = ft.student_id and ar.session_id = ${claim.sessionId}::uuid
        where ft.is_active and ft.student_id <> ${studentId}::uuid
      `,
    );
    const nearest = nearestOtherSimilarity(
      face.embedding,
      others.map((row) => ({ id: row.student_id, embedding: parseVector(row.embedding) })),
    );
    const duplicateFace = nearest >= settings.duplicateFaceThreshold;

    // 4. Risk, then the final decision.
    const [deviceRow] = await app.stores.db
      .select()
      .from(devices)
      .where(eq(devices.id, claim.deviceId))
      .limit(1);
    const [failureRow] = await rows<{ count: number }>(
      app.stores.db,
      sql`select count(*)::int as count from attendance_attempts
          where session_id = ${claim.sessionId}::uuid and student_id = ${studentId}::uuid and result = 'fail'`,
    );

    const risk = computeRiskScore({
      livenessScore: face.livenessScore,
      similarity,
      similarityThreshold: settings.similarityThreshold,
      similarityMarginToOthers: nearest,
      geofence: null,
      fingerprintMatched: true,
      deviceAgeHours: deviceRow ? (Date.now() - deviceRow.boundAt.getTime()) / 3_600_000 : null,
      tokenAgeSeconds: 0,
      recentFailures: failureRow?.count ?? 0,
      requireActiveLiveness: settings.requireActiveLiveness,
      activeChallengePassed: face.activeChallengePassed,
    });

    const decision = decideVerification({
      now: new Date(),
      lateAfter: session.late_after,
      checkinClosesAt: session.checkin_closes_at,
      quality: { score: face.qualityScore, threshold: settings.qualityThreshold },
      liveness: { score: face.livenessScore, passed: face.livenessPassed, threshold: settings.livenessThreshold },
      activeLiveness: {
        required: settings.requireActiveLiveness && claim.challenge !== 'none',
        passed: face.activeChallengePassed,
      },
      similarity: { value: similarity, threshold: settings.similarityThreshold },
      duplicateFace,
      risk: { score: risk.score, threshold: settings.riskFlagThreshold },
      failureCount: failureRow?.count ?? 0,
      failuresBeforeFlag: settings.failuresBeforeFlag,
    });

    if (decision.outcome === 'rejected') {
      await recordAttempt(claim.sessionId, studentId, claim.deviceId, 'face', 'fail', {
        failureReason: decision.code,
        similarity,
        livenessScore: face.livenessScore,
        qualityScore: face.qualityScore,
        riskScore: risk.score,
        ip: request.ip,
      });
      await app.stores.db.execute(
        sql`update students set biometric_failure_count = biometric_failure_count + 1, updated_at = now()
            where id = ${studentId}::uuid`,
      );
      await writeAudit(app.stores.db, {
        actorId: principal.userId,
        actorEmail: principal.email,
        action: 'checkin.verify_rejected',
        entity: 'student',
        entityId: studentId,
        after: { code: decision.code, similarity, riskScore: risk.score },
        ip: request.ip,
        requestId: request.id,
      });
      throw new ApiError(decision.code, decision.detail);
    }

    const checkedInAt = new Date();
    const status: AttendanceStatus = decision.outcome;
    const flagReason = decision.outcome === 'present_flagged' ? decision.reasons.join(',') : null;

    // 5. One transaction: consume the claim, write the record, log the attempt.
    const client = await app.stores.pool.connect();
    let inserted = false;
    try {
      await client.query('begin');

      const consumed = await client.query(
        `update checkin_claims set consumed_at = now() where id = $1 and consumed_at is null returning id`,
        [claim.id],
      );
      if (consumed.rowCount === 0) {
        await client.query('rollback');
        throw new ApiError('CLAIM_ALREADY_USED', 'This check-in was already completed.');
      }

      const record = await client.query(
        `insert into attendance_records
           (session_id, student_id, device_id, status, method, checked_in_at, risk_score, flag_reason, similarity, liveness_score)
         values ($1, $2, $3, $4, 'auto', $5, $6, $7, $8, $9)
         on conflict do nothing
         returning id`,
        [
          claim.sessionId,
          studentId,
          claim.deviceId,
          status,
          checkedInAt,
          risk.score,
          flagReason,
          similarity,
          face.livenessScore,
        ],
      );
      inserted = (record.rowCount ?? 0) > 0;

      if (!inserted) {
        // Either the student or the device already has a record: the unique
        // indexes fired, which is the behaviour we want under a race.
        await client.query('rollback');
        throw new ApiError('ALREADY_CHECKED_IN', 'You are already checked in for this session.');
      }

      await client.query(
        `insert into attendance_attempts
           (session_id, student_id, device_id, stage, result, similarity, liveness_score, quality_score, risk_score, ip)
         values ($1, $2, $3, 'face', $4, $5, $6, $7, $8, $9)`,
        [
          claim.sessionId,
          studentId,
          claim.deviceId,
          decision.outcome === 'present_flagged' ? 'flagged' : 'pass',
          similarity,
          face.livenessScore,
          face.qualityScore,
          risk.score,
          request.ip,
        ],
      );

      if (decision.outcome === 'present_flagged') {
        await client.query(
          `insert into review_items (kind, record_id, session_id, student_id, reasons, risk_score)
           values ('record', $1, $2, $3, $4, $5)`,
          [record.rows[0].id, claim.sessionId, studentId, decision.reasons, risk.score],
        );
      }

      await client.query(
        `update students set biometric_failure_count = 0, updated_at = now() where id = $1`,
        [studentId],
      );

      await client.query('commit');
    } catch (error) {
      try {
        await client.query('rollback');
      } catch {
        // already rolled back
      }
      throw error;
    } finally {
      client.release();
    }

    // 6. Push the roster update and fire webhooks.
    const rosterEvent = await buildRosterEvent(app.stores.db, claim.sessionId);
    await app.hub.publish(channels.sessionRoster(claim.sessionId), rosterEvent);

    await writeAudit(app.stores.db, {
      actorId: principal.userId,
      actorEmail: principal.email,
      action: 'checkin.recorded',
      entity: 'attendance_record',
      entityId: null,
      after: { status, sessionId: claim.sessionId, riskScore: risk.score, similarity },
      ip: request.ip,
      requestId: request.id,
    });

    void punctualityFor(session.late_after, checkedInAt);

    const response = VerifyResponse.parse({
      status,
      checkedInAt: checkedInAt.toISOString(),
      courseCode: session.course_code,
      message:
        decision.outcome === 'present_flagged'
          ? 'Checked in. Your attendance is recorded and will be reviewed.'
          : decision.outcome === 'late'
            ? 'Checked in as late.'
            : 'Checked in.',
    });

    await storeIdempotent(app.stores.db, idempotencyKey, principal.userId, 'POST /checkin/verify', hash, {
      status: 200,
      body: response,
    });

    return reply.status(200).send(response);
  });

  /** Used by the student home screen to know whether they can check in. */
  app.get('/api/v1/checkin/eligibility', async (request) => {
    const principal = await app.authenticate(request);
    const studentId = assertStudent(principal);
    const [row] = await rows<{
      consent: boolean;
      face: boolean;
      device: boolean;
      pending_reset: boolean;
    }>(
      app.stores.db,
      sql`
        select
          exists (select 1 from biometric_consents bc where bc.student_id = ${studentId}::uuid and bc.withdrawn_at is null) as consent,
          exists (select 1 from biometrics.face_templates ft where ft.student_id = ${studentId}::uuid and ft.is_active) as face,
          exists (select 1 from devices d where d.student_id = ${studentId}::uuid and d.status = 'active') as device,
          exists (select 1 from device_reset_requests r where r.student_id = ${studentId}::uuid and r.status = 'pending') as pending_reset
      `,
    );
    const ready = Boolean(row?.consent && row.face && row.device);
    return {
      ready,
      consent: row?.consent ?? false,
      faceEnrolled: row?.face ?? false,
      deviceBound: row?.device ?? false,
      pendingReset: row?.pending_reset ?? false,
      missing: [
        row?.consent ? null : 'consent',
        row?.face ? null : 'face',
        row?.device ? null : 'device',
      ].filter((value): value is string => value !== null),
    };
  });

  void students;
  void isNull;
}

async function deviceUsedByAnotherStudent(
  app: FastifyInstance,
  sessionId: string,
  studentId: string,
  deviceId: string | null,
): Promise<boolean> {
  if (!deviceId) return false;
  const [row] = await rows<{ used: boolean }>(
    app.stores.db,
    sql`select exists (
          select 1 from attendance_records ar
          where ar.session_id = ${sessionId}::uuid
            and ar.device_id = ${deviceId}::uuid
            and ar.student_id <> ${studentId}::uuid
        ) as used`,
  );
  return row?.used ?? false;
}

async function resolveFlags(
  app: FastifyInstance,
  facultyId: string | null,
  settings: Settings,
  request: FastifyRequest,
): Promise<'on' | 'off'> {
  if (!facultyId) return settings.geofenceEnabled ? 'on' : 'off';
  const overrides = await rows<{ flag: string; enabled: boolean }>(
    app.stores.db,
    sql`select flag, enabled from feature_flags where faculty_id = ${facultyId}::uuid`,
  );
  return resolveFeatureFlag('geofence', settings, overrides) ? 'on' : 'off';
}

function pickChallenge(
  settings: Settings,
  facultyId: string | null,
  request: FastifyRequest,
): LivenessChallenge {
  void facultyId;
  void request;
  if (!settings.requireActiveLiveness) return 'none';
  const options: LivenessChallenge[] = ['blink', 'turn_left', 'turn_right'];
  return options[Math.floor(Math.random() * options.length)] ?? 'blink';
}

async function enforceFaceAttemptLimit(app: FastifyInstance, studentId: string): Promise<void> {
  const bucket = Math.floor(Date.now() / 60_000);
  const count = await app.kv.increment(`face:${studentId}:${bucket}`, 120);
  if (count > 20) {
    throw new ApiError('RATE_LIMITED', 'Too many face verification attempts. Wait a minute.');
  }
}

/** Postgres vector literal -> number[]. */
function parseVector(literal: string): number[] {
  return literal
    .replace(/^\[/u, '')
    .replace(/\]$/u, '')
    .split(',')
    .map((value) => Number.parseFloat(value));
}
