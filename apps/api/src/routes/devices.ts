import { and, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { devices, deviceResetRequests, students, webauthnChallenges } from '@attend/db';
import {
  DeviceRegisterInput,
  DeviceRegisterOptionsResponse,
  DeviceResetRequestInput,
} from '@attend/contracts';
import { ApiError } from '../lib/problem.ts';
import { assertStudent } from '../lib/auth.ts';
import { newChallenge, rpIdFromOrigin, verifyRegistration } from '../domain/webauthn.ts';
import { hashFingerprint } from '../domain/fingerprint.ts';
import { writeAudit } from '../lib/audit.ts';

/**
 * Device binding: a platform passkey plus a hashed non-PII fingerprint.
 * One active device per student is a database constraint, not a guideline.
 */
export async function registerDeviceRoutes(app: FastifyInstance): Promise<void> {
  const rpId = app.env.WEBAUTHN_RP_ID;
  const allowedOrigins = app.env.WEBAUTHN_ALLOWED_ORIGINS.split(',').map((origin) => origin.trim());

  app.post('/api/v1/devices/register/options', async (request) => {
    const principal = await app.authenticate(request);
    const studentId = assertStudent(principal);
    const settings = await app.settings();

    const existingDevices = await app.stores.db
      .select({ credentialId: devices.webauthnCredentialId })
      .from(devices)
      .where(and(eq(devices.studentId, studentId), eq(devices.status, 'active')));

    if (existingDevices.length >= settings.maxDevicesPerStudent) {
      throw new ApiError(
        'CONFLICT',
        'This account already has a bound device. Request a device reset from your profile.',
      );
    }

    const challenge = newChallenge();
    const expiresAt = new Date(Date.now() + 5 * 60_000);
    const [row] = await app.stores.db
      .insert(webauthnChallenges)
      .values({
        userId: principal.userId,
        purpose: 'register',
        challenge,
        expiresAt,
      })
      .returning({ id: webauthnChallenges.id });

    return DeviceRegisterOptionsResponse.parse({
      challenge,
      rp: { id: rpId, name: app.env.INSTITUTION_NAME },
      user: {
        id: Buffer.from(principal.userId).toString('base64url'),
        name: principal.email,
        displayName: principal.name,
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        residentKey: 'preferred',
        userVerification: 'required',
      },
      timeout: 300_000,
      attestation: 'none',
      excludeCredentials: existingDevices.map((device) => ({ id: device.credentialId, type: 'public-key' as const })),
      challengeId: row!.id,
    });
  });

  app.post('/api/v1/devices/register', async (request) => {
    const principal = await app.authenticate(request);
    const studentId = assertStudent(principal);
    const input = DeviceRegisterInput.parse(request.body);
    const settings = await app.settings();

    const [challengeRow] = await app.stores.db
      .select()
      .from(webauthnChallenges)
      .where(
        and(
          eq(webauthnChallenges.id, input.challengeId),
          eq(webauthnChallenges.userId, principal.userId),
          eq(webauthnChallenges.purpose, 'register'),
          isNull(webauthnChallenges.consumedAt),
        ),
      )
      .limit(1);
    if (!challengeRow) throw new ApiError('CLAIM_INVALID', 'Registration challenge not found or already used.');
    if (challengeRow.expiresAt <= new Date()) throw new ApiError('CLAIM_EXPIRED', 'Registration challenge expired.');

    const verification = verifyRegistration({
      rpId,
      allowedOrigins,
      expectedChallenge: challengeRow.challenge,
      clientDataJSON: input.credential.response.clientDataJSON,
      attestationObject: input.credential.response.attestationObject,
      rawId: input.credential.rawId,
      requireUserVerification: true,
    });
    if (!verification.ok) {
      throw new ApiError('WEBAUTHN_FAILED', `Device registration failed (${verification.reason}).`);
    }

    const activeCount = await app.stores.db
      .select({ id: devices.id })
      .from(devices)
      .where(and(eq(devices.studentId, studentId), eq(devices.status, 'active')));
    if (activeCount.length >= settings.maxDevicesPerStudent) {
      throw new ApiError('CONFLICT', 'This account already has a bound device. Request a device reset.');
    }

    const inserted = await app.stores.db
      .insert(devices)
      .values({
        studentId,
        webauthnCredentialId: verification.value.credentialId,
        publicKey: verification.value.publicKeyCose,
        signCount: verification.value.signCount,
        fingerprintHash: hashFingerprint(input.fingerprint, app.env.FINGERPRINT_PEPPER),
        platform: input.fingerprint.platform,
        userAgentFamily: input.fingerprint.userAgentFamily,
        status: 'active',
      })
      .onConflictDoNothing()
      .returning({ id: devices.id });

    if (inserted.length === 0) {
      // A concurrent request bound the same credential: the unique index won.
      throw new ApiError('CONFLICT', 'This device is already registered.');
    }

    await app.stores.db
      .update(webauthnChallenges)
      .set({ consumedAt: new Date() })
      .where(eq(webauthnChallenges.id, challengeRow.id));

    await writeAudit(app.stores.db, {
      actorId: principal.userId,
      actorEmail: principal.email,
      action: 'device.bound',
      entity: 'device',
      entityId: inserted[0]!.id,
      after: { platform: input.fingerprint.platform, userAgentFamily: input.fingerprint.userAgentFamily },
      ip: request.ip,
      requestId: request.id,
    });

    return { deviceId: inserted[0]!.id, boundAt: new Date().toISOString() };
  });

  app.get('/api/v1/devices/me', async (request) => {
    const principal = await app.authenticate(request);
    const studentId = assertStudent(principal);
    const rows = await app.stores.db
      .select({
        id: devices.id,
        status: devices.status,
        platform: devices.platform,
        userAgentFamily: devices.userAgentFamily,
        boundAt: devices.boundAt,
        revokedAt: devices.revokedAt,
      })
      .from(devices)
      .where(eq(devices.studentId, studentId))
      .orderBy(sql`bound_at desc`);

    const [pending] = await app.stores.db
      .select({ id: deviceResetRequests.id, status: deviceResetRequests.status, createdAt: deviceResetRequests.createdAt })
      .from(deviceResetRequests)
      .where(and(eq(deviceResetRequests.studentId, studentId), eq(deviceResetRequests.status, 'pending')))
      .limit(1);

    return {
      devices: rows.map((device) => ({
        id: device.id,
        status: device.status,
        platform: device.platform,
        userAgentFamily: device.userAgentFamily,
        boundAt: device.boundAt.toISOString(),
        revokedAt: device.revokedAt?.toISOString() ?? null,
      })),
      pendingResetRequest: pending
        ? { id: pending.id, status: pending.status, requestedAt: pending.createdAt.toISOString() }
        : null,
    };
  });

  app.post('/api/v1/devices/reset-request', async (request) => {
    const principal = await app.authenticate(request);
    const studentId = assertStudent(principal);
    const input = DeviceResetRequestInput.parse(request.body);

    const inserted = await app.stores.db
      .insert(deviceResetRequests)
      .values({ studentId, reason: input.reason, status: 'pending' })
      .onConflictDoNothing()
      .returning({ id: deviceResetRequests.id });

    if (inserted.length === 0) {
      throw new ApiError('CONFLICT', 'You already have a pending device reset request.');
    }

    await writeAudit(app.stores.db, {
      actorId: principal.userId,
      actorEmail: principal.email,
      action: 'device.reset_requested',
      entity: 'device_reset_request',
      entityId: inserted[0]!.id,
      after: { reason: input.reason },
      ip: request.ip,
      requestId: request.id,
    });

    return { requestId: inserted[0]!.id, status: 'pending' as const };
  });

  // Used by the student profile page: who am I bound as.
  app.get('/api/v1/devices/me/student', async (request) => {
    const principal = await app.authenticate(request);
    const studentId = assertStudent(principal);
    const [row] = await app.stores.db
      .select({ studentNumber: students.studentNumber })
      .from(students)
      .where(eq(students.id, studentId))
      .limit(1);
    return { studentNumber: row?.studentNumber ?? null };
  });

  // Exposed for the web client so it does not have to guess the RP id.
  app.get('/api/v1/devices/rp', async () => ({ rpId: rpIdFromOrigin(app.env.WEB_ORIGIN), configured: rpId }));
}
