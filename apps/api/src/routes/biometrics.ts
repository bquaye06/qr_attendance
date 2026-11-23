import { and, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { biometricConsents, devices, students } from '@attend/db';
import {
  ConsentInput,
  EnrollInput,
  FACE_MODEL_VERSION,
  BiometricStatus,
} from '@attend/contracts';
import { ApiError } from '../lib/problem.ts';
import { assertStudent } from '../lib/auth.ts';
import { writeAudit } from '../lib/audit.ts';
import { rows } from '../lib/query.ts';

/**
 * Biometric consent and enrolment.
 *
 * Enrolment stores one averaged, L2-normalised embedding and nothing else:
 * frames are forwarded to the face service in memory and never written. Before
 * the template is stored, the new embedding is compared against every existing
 * template (HNSW index) so one face cannot hold two accounts.
 */
export async function registerBiometricRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/v1/biometrics/consent', async (request) => {
    const principal = await app.authenticate(request);
    const studentId = assertStudent(principal);
    const input = ConsentInput.parse(request.body);

    const now = new Date();
    if (input.granted) {
      await app.stores.db
        .update(biometricConsents)
        .set({ withdrawnAt: now, updatedAt: now })
        .where(and(eq(biometricConsents.studentId, studentId), isNull(biometricConsents.withdrawnAt)));

      await app.stores.db.insert(biometricConsents).values({
        studentId,
        noticeVersion: input.noticeVersion,
        grantedAt: now,
        ip: request.ip,
      });
      await writeAudit(app.stores.db, {
        actorId: principal.userId,
        actorEmail: principal.email,
        action: 'biometric.consent_granted',
        entity: 'student',
        entityId: studentId,
        after: { noticeVersion: input.noticeVersion },
        ip: request.ip,
        requestId: request.id,
      });
      return { noticeVersion: input.noticeVersion, grantedAt: now.toISOString(), withdrawnAt: null };
    }

    // Withdrawal: templates stay until the grace period passes, then the purge
    // job deletes them (a student can change their mind inside the grace window).
    await app.stores.db
      .update(biometricConsents)
      .set({ withdrawnAt: now, updatedAt: now })
      .where(and(eq(biometricConsents.studentId, studentId), isNull(biometricConsents.withdrawnAt)));

    await writeAudit(app.stores.db, {
      actorId: principal.userId,
      actorEmail: principal.email,
      action: 'biometric.consent_withdrawn',
      entity: 'student',
      entityId: studentId,
      after: { noticeVersion: input.noticeVersion },
      ip: request.ip,
      requestId: request.id,
    });
    return { noticeVersion: input.noticeVersion, grantedAt: null, withdrawnAt: now.toISOString() };
  });

  app.post('/api/v1/biometrics/enroll', async (request) => {
    const principal = await app.authenticate(request);
    const studentId = assertStudent(principal);
    const input = EnrollInput.parse(request.body);
    const settings = await app.settings();

    const [consent] = await app.stores.db
      .select({ id: biometricConsents.id })
      .from(biometricConsents)
      .where(and(eq(biometricConsents.studentId, studentId), isNull(biometricConsents.withdrawnAt)))
      .limit(1);
    if (!consent) throw new ApiError('CONSENT_REQUIRED', 'Accept the biometric notice before enrolling.');

    const face = await app.face.enroll(input.frames, input.challenge);

    if (!face.livenessPassed) {
      await writeAttemptAudit(app, principal, studentId, 'biometric.enroll_failed', request.ip, {
        reason: 'liveness_failed',
        livenessScore: face.livenessScore,
      });
      throw new ApiError('LIVENESS_FAILED', 'Liveness check failed. Try again in even light without a screen behind you.');
    }
    if (face.qualityScore < settings.qualityThreshold) {
      await writeAttemptAudit(app, principal, studentId, 'biometric.enroll_failed', request.ip, {
        reason: 'quality_low',
        qualityScore: face.qualityScore,
        qualityReasons: face.qualityReasons,
      });
      throw new ApiError('FACE_QUALITY_LOW', `Enrolment frames were too low quality (${face.qualityReasons.join(', ')}).`);
    }
    if (input.challenge !== 'none' && face.activeChallengePassed === false) {
      throw new ApiError('LIVENESS_FAILED', 'The liveness challenge was not completed.');
    }

    const vector = `[${face.embedding.map((value) => value.toFixed(6)).join(',')}]`;

    // Duplicate-face search across every active template, excluding this student.
    const [duplicate] = await rows<{ student_id: string; similarity: number | string }>(
      app.stores.biometrics,
      sql`
        select student_id, (1 - (embedding <=> ${vector}::vector))::numeric as similarity
        from biometrics.face_templates
        where is_active and student_id <> ${studentId}::uuid
        order by embedding <=> ${vector}::vector
        limit 1
      `,
    );

    const duplicateSimilarity = duplicate ? Number(duplicate.similarity) : 0;
    if (duplicate && duplicateSimilarity >= settings.duplicateFaceThreshold) {
      await writeAudit(app.stores.db, {
        actorId: principal.userId,
        actorEmail: principal.email,
        action: 'biometric.duplicate_blocked',
        entity: 'student',
        entityId: studentId,
        after: { similarity: duplicateSimilarity, matchesStudentId: duplicate.student_id },
        ip: request.ip,
        requestId: request.id,
      });
      throw new ApiError(
        'DUPLICATE_FACE',
        'This face is already enrolled to another student. Contact an administrator to resolve it.',
      );
    }

    // One active template per student and model version.
    await app.stores.biometrics.execute(sql`
      update biometrics.face_templates set is_active = false, updated_at = now()
      where student_id = ${studentId}::uuid and model_version = ${FACE_MODEL_VERSION} and is_active
    `);
    await app.stores.biometrics.execute(sql`
      insert into biometrics.face_templates (student_id, embedding, model_version, quality_score, liveness_score)
      values (${studentId}::uuid, ${vector}::vector, ${FACE_MODEL_VERSION}, ${face.qualityScore}, ${face.livenessScore})
    `);

    await writeAudit(app.stores.db, {
      actorId: principal.userId,
      actorEmail: principal.email,
      action: 'biometric.enrolled',
      entity: 'student',
      entityId: studentId,
      after: {
        modelVersion: FACE_MODEL_VERSION,
        qualityScore: face.qualityScore,
        livenessScore: face.livenessScore,
        framesAccepted: face.framesAccepted,
      },
      ip: request.ip,
      requestId: request.id,
    });

    return {
      enrolled: true as const,
      modelVersion: face.modelVersion,
      qualityScore: face.qualityScore,
      livenessScore: face.livenessScore,
      framesAccepted: face.framesAccepted,
    };
  });

  app.get('/api/v1/biometrics/status', async (request) => {
    const principal = await app.authenticate(request);
    const studentId = assertStudent(principal);

    const [consent] = await app.stores.db
      .select()
      .from(biometricConsents)
      .where(eq(biometricConsents.studentId, studentId))
      .orderBy(sql`granted_at desc`)
      .limit(1);

    const [template] = await rows<{
      model_version: string | null;
      quality_score: string | null;
      enrolled_at: string | null;
    }>(
      app.stores.biometrics,
      sql`select model_version, quality_score::text as quality_score, enrolled_at::text as enrolled_at
          from biometrics.face_templates
          where student_id = ${studentId}::uuid and is_active
          order by enrolled_at desc limit 1`,
    );

    const [device] = await app.stores.db
      .select({ platform: devices.platform, boundAt: devices.boundAt })
      .from(devices)
      .where(and(eq(devices.studentId, studentId), eq(devices.status, 'active')))
      .limit(1);

    return BiometricStatus.parse({
      consent: {
        noticeVersion: consent?.withdrawnAt ? null : (consent?.noticeVersion ?? null),
        grantedAt: consent?.withdrawnAt ? null : (consent?.grantedAt.toISOString() ?? null),
        withdrawnAt: consent?.withdrawnAt?.toISOString() ?? null,
      },
      face: {
        enrolled: Boolean(template),
        modelVersion: template?.model_version ?? null,
        qualityScore: template?.quality_score ? Number(template.quality_score) : null,
        enrolledAt: template?.enrolled_at ?? null,
      },
      device: {
        bound: Boolean(device),
        platform: device?.platform ?? null,
        boundAt: device?.boundAt.toISOString() ?? null,
      },
    });
  });

  /**
   * Data-subject rights: withdraw biometric consent and request deletion.
   * The purge job removes templates after the grace period.
   */
  app.delete('/api/v1/biometrics', async (request) => {
    const principal = await app.authenticate(request);
    const studentId = assertStudent(principal);
    const settings = await app.settings();
    const now = new Date();

    await app.stores.db
      .update(biometricConsents)
      .set({ withdrawnAt: now, updatedAt: now })
      .where(and(eq(biometricConsents.studentId, studentId), isNull(biometricConsents.withdrawnAt)));

    await writeAudit(app.stores.db, {
      actorId: principal.userId,
      actorEmail: principal.email,
      action: 'biometric.deletion_requested',
      entity: 'student',
      entityId: studentId,
      ip: request.ip,
      requestId: request.id,
    });

    return {
      withdrawnAt: now.toISOString(),
      purgeScheduledFor: new Date(now.getTime() + settings.templatePurgeGraceDays * 86_400_000).toISOString(),
    };
  });

  /** Download everything the platform holds about the signed-in student. */
  app.get('/api/v1/me/data-export', async (request, reply) => {
    const principal = await app.authenticate(request);
    const studentId = assertStudent(principal);

    const attendance = await rows<Record<string, unknown>>(
      app.stores.db,
      sql`
        select c.code as course_code, c.title as course_title, s.starts_at,
               r.status, r.method, r.checked_in_at, r.risk_score
        from attendance_records r
        join class_sessions s on s.id = r.session_id
        join course_offerings o on o.id = s.offering_id
        join courses c on c.id = o.course_id
        where r.student_id = ${studentId}::uuid
        order by s.starts_at desc
      `,
    );

    const consents = await app.stores.db
      .select({
        noticeVersion: biometricConsents.noticeVersion,
        grantedAt: biometricConsents.grantedAt,
        withdrawnAt: biometricConsents.withdrawnAt,
      })
      .from(biometricConsents)
      .where(eq(biometricConsents.studentId, studentId));

    const [student] = await app.stores.db
      .select({ studentNumber: students.studentNumber })
      .from(students)
      .where(eq(students.id, studentId))
      .limit(1);

    const payload = {
      generatedAt: new Date().toISOString(),
      student: { studentNumber: student?.studentNumber ?? null, email: principal.email, name: principal.name },
      consents: consents.map((consent) => ({
        noticeVersion: consent.noticeVersion,
        grantedAt: consent.grantedAt.toISOString(),
        withdrawnAt: consent.withdrawnAt?.toISOString() ?? null,
      })),
      attendance,
      note: 'No face images are stored by this platform. Face templates are embeddings and are not included here.',
    };

    return reply
      .header('content-type', 'application/json')
      .header('content-disposition', 'attachment; filename="attend-data-export.json"')
      .send(payload);
  });
}

async function writeAttemptAudit(
  app: FastifyInstance,
  principal: { userId: string; email: string },
  studentId: string,
  action: string,
  ip: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await writeAudit(app.stores.db, {
    actorId: principal.userId,
    actorEmail: principal.email,
    action,
    entity: 'student',
    entityId: studentId,
    after: detail,
    ip,
  });
}
