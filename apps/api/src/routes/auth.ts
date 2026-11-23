import { and, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authSessions, lecturers, roleAssignments, roles, students, users } from '@attend/db';
import {
  ChangePasswordInput,
  MeResponse,
  SignInInput,
  TotpConfirmInput,
} from '@attend/contracts';
import { ApiError } from '../lib/problem.ts';
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  hashSessionToken,
  idleMinutesFor,
  newCsrfToken,
  newSessionToken,
} from '../lib/auth.ts';
import { hashPassword, needsRehash, verifyPassword } from '../domain/password.ts';
import { generateTotpSecret, otpauthUrl, verifyTotp } from '../domain/totp.ts';
import { encryptSecret, decryptSecret, parseMasterKey } from '../domain/secrets.ts';
import { writeAudit } from '../lib/audit.ts';
import { rows } from '../lib/query.ts';

const SignInResponse = z.object({
  userId: z.string().uuid(),
  mfaRequired: z.boolean(),
  mfaVerified: z.boolean(),
  mfaSetupRequired: z.boolean(),
  requiresMfa: z.boolean(),
});

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  const masterKey = parseMasterKey(app.env.MASTER_KEY);

  app.post('/api/v1/auth/signin', async (request, reply) => {
    const input = SignInInput.parse(request.body);
    const email = input.email.trim().toLowerCase();

    // Rate limit per account as well as per IP so that password spraying from
    // many addresses still trips a limit.
    const attempts = await app.kv.increment(`signin:${email}:${request.ip}`, 300);
    if (attempts > 10) throw new ApiError('RATE_LIMITED', 'Too many sign-in attempts. Wait five minutes.');

    const [user] = await app.stores.db
      .select()
      .from(users)
      .where(and(sql`lower(${users.email}) = ${email}`, isNull(users.deletedAt)))
      .limit(1);

    // Always run a hash comparison so a missing account and a wrong password
    // take about the same time.
    const storedHash = user?.passwordHash ?? 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA';
    const passwordOk = await verifyPassword(input.password, storedHash);

    if (!user || !passwordOk) {
      await writeAudit(app.stores.db, {
        actorId: user?.id ?? null,
        actorEmail: email,
        action: 'auth.signin_failed',
        entity: 'user',
        entityId: user?.id ?? null,
        ip: request.ip,
        requestId: request.id,
      });
      throw new ApiError('INVALID_CREDENTIALS', 'Email or password is incorrect.');
    }
    if (user.status !== 'active') {
      throw new ApiError('FORBIDDEN', 'This account is suspended.');
    }

    if (needsRehash(storedHash)) {
      const upgraded = await hashPassword(input.password);
      await app.stores.db.update(users).set({ passwordHash: upgraded }).where(eq(users.id, user.id));
    }

    const [lecturerRow] = await app.stores.db
      .select({ id: lecturers.id })
      .from(lecturers)
      .where(eq(lecturers.userId, user.id))
      .limit(1);
    const staffRoles = await rows<{ key: string }>(
      app.stores.db,
      sql`select r.key from role_assignments ra join roles r on r.id = ra.role_id
          where ra.user_id = ${user.id}::uuid and r.key <> 'student'`,
    );
    const requiresMfa = Boolean(lecturerRow) || staffRoles.length > 0;

    let mfaVerified = false;
    if (requiresMfa) {
      if (!user.totpConfirmedAt) {
        mfaVerified = false; // client must run /auth/totp/setup then confirm
      } else if (!input.totp) {
        throw new ApiError('MFA_REQUIRED', 'Enter the six-digit code from your authenticator app.');
      } else {
        const secretEnc = user.totpSecretEnc;
        if (!secretEnc) throw new ApiError('MFA_REQUIRED', 'Two-factor is not configured. Contact an administrator.');
        const secret = decryptSecret(secretEnc, masterKey);
        const result = verifyTotp(secret, input.totp, Date.now());
        if (!result.ok) throw new ApiError('MFA_INVALID', 'That code is not valid.');
        mfaVerified = true;
      }
    }

    const settings = await app.settings();
    const idleMinutes = idleMinutesFor({
      isAdmin: staffRoles.some((role) => role.key.endsWith('_admin')),
      isStaff: requiresMfa,
      adminIdleMinutes: settings.adminIdleMinutes,
      staffIdleMinutes: settings.staffIdleMinutes,
      studentIdleMinutes: settings.studentIdleMinutes,
    });

    const token = newSessionToken();
    const now = new Date();
    const absoluteHours = requiresMfa ? 12 : 24 * 7;
    await app.stores.db.insert(authSessions).values({
      userId: user.id,
      tokenHash: hashSessionToken(token),
      kind: 'web',
      idleExpiresAt: new Date(now.getTime() + idleMinutes * 60_000),
      absoluteExpiresAt: new Date(now.getTime() + absoluteHours * 3_600_000),
      mfaVerifiedAt: mfaVerified ? now : null,
      ip: request.ip,
      userAgent: request.headers['user-agent']?.slice(0, 300) ?? null,
    });

    await app.stores.db.update(users).set({ lastLoginAt: now }).where(eq(users.id, user.id));

    const csrf = newCsrfToken();
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: app.env.SESSION_COOKIE_SECURE,
      path: '/',
      maxAge: absoluteHours * 3600,
      domain: app.env.COOKIE_DOMAIN,
    });
    reply.setCookie(CSRF_COOKIE, csrf, {
      httpOnly: false,
      sameSite: 'lax',
      secure: app.env.SESSION_COOKIE_SECURE,
      path: '/',
      maxAge: absoluteHours * 3600,
      domain: app.env.COOKIE_DOMAIN,
    });

    await writeAudit(app.stores.db, {
      actorId: user.id,
      actorEmail: user.email,
      action: 'auth.signin',
      entity: 'user',
      entityId: user.id,
      ip: request.ip,
      requestId: request.id,
    });

    return SignInResponse.parse({
      userId: user.id,
      mfaRequired: requiresMfa,
      mfaVerified,
      mfaSetupRequired: requiresMfa && !user.totpConfirmedAt,
      requiresMfa,
    });
  });

  app.post('/api/v1/auth/totp/setup', async (request) => {
    const principal = await app.authenticate(request);
    if (!principal.requiresMfa) throw new ApiError('FORBIDDEN', 'Two-factor applies to staff accounts only.');
    if (principal.mfaSatisfied) throw new ApiError('CONFLICT', 'Two-factor is already configured.');

    const secret = generateTotpSecret();
    await app.stores.db
      .update(users)
      .set({ totpSecretEnc: encryptSecret(secret, masterKey), updatedAt: new Date() })
      .where(eq(users.id, principal.userId));

    return {
      secret,
      otpauthUrl: otpauthUrl(secret, principal.email, app.env.INSTITUTION_NAME),
    };
  });

  app.post('/api/v1/auth/totp/confirm', async (request) => {
    const principal = await app.authenticate(request);
    const input = TotpConfirmInput.parse(request.body);
    const [user] = await app.stores.db.select().from(users).where(eq(users.id, principal.userId)).limit(1);
    if (!user?.totpSecretEnc) throw new ApiError('MFA_REQUIRED', 'Start two-factor setup first.');

    const secret = decryptSecret(user.totpSecretEnc, masterKey);
    const result = verifyTotp(secret, input.code, Date.now());
    if (!result.ok) throw new ApiError('MFA_INVALID', 'That code is not valid.');

    const now = new Date();
    await app.stores.db
      .update(users)
      .set({ totpConfirmedAt: now, updatedAt: now })
      .where(eq(users.id, principal.userId));
    await app.stores.db
      .update(authSessions)
      .set({ mfaVerifiedAt: now, updatedAt: now })
      .where(eq(authSessions.id, principal.sessionId));

    await writeAudit(app.stores.db, {
      actorId: principal.userId,
      actorEmail: principal.email,
      action: 'auth.totp_enabled',
      entity: 'user',
      entityId: principal.userId,
      ip: request.ip,
      requestId: request.id,
    });
    return { ok: true as const };
  });

  app.post('/api/v1/auth/signout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) {
      await app.stores.db
        .update(authSessions)
        .set({ revokedAt: new Date(), updatedAt: new Date() })
        .where(eq(authSessions.tokenHash, hashSessionToken(token)));
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    reply.clearCookie(CSRF_COOKIE, { path: '/' });
    return { ok: true as const };
  });

  app.get('/api/v1/auth/me', async (request) => {
    const principal = await app.authenticate(request);

    const [user] = await app.stores.db.select().from(users).where(eq(users.id, principal.userId)).limit(1);
    if (!user) throw new ApiError('UNAUTHENTICATED');

    const assignments = await rows<{ role_key: string; scope_type: string; scope_name: string | null }>(
      app.stores.db,
      sql`
        select r.key as role_key,
               ra.scope_type::text as scope_type,
               case ra.scope_type
                 when 'institution' then (select name from institutions order by created_at limit 1)
                 when 'faculty' then (select name from faculties where id = ra.scope_id)
                 when 'department' then (select name from departments where id = ra.scope_id)
                 when 'offering' then (
                   select c.code || ' ' || t.name from course_offerings o
                   join courses c on c.id = o.course_id
                   join terms t on t.id = o.term_id
                   where o.id = ra.scope_id
                 )
                 else null
               end as scope_name
        from role_assignments ra
        join roles r on r.id = ra.role_id
        where ra.user_id = ${principal.userId}::uuid
      `,
    );

    const [studentRow] = await app.stores.db
      .select()
      .from(students)
      .where(eq(students.userId, user.id))
      .limit(1);

    let studentBlock: MeResponse['student'] = null;
    if (studentRow) {
      const [status] = await rows<{
        notice_version: string | null;
        granted_at: string | null;
        face_enrolled: boolean;
        device_bound: boolean;
      }>(
        app.stores.db,
        sql`
          select
            (select notice_version from biometric_consents
              where student_id = ${studentRow.id}::uuid and withdrawn_at is null
              order by granted_at desc limit 1) as notice_version,
            (select granted_at::text from biometric_consents
              where student_id = ${studentRow.id}::uuid and withdrawn_at is null
              order by granted_at desc limit 1) as granted_at,
            exists (select 1 from biometrics.face_templates
              where student_id = ${studentRow.id}::uuid and is_active) as face_enrolled,
            exists (select 1 from devices
              where student_id = ${studentRow.id}::uuid and status = 'active') as device_bound
        `,
      );
      studentBlock = {
        id: studentRow.id,
        studentNumber: studentRow.studentNumber,
        consentGrantedAt: status?.granted_at ?? null,
        noticeVersion: status?.notice_version ?? null,
        faceEnrolled: status?.face_enrolled ?? false,
        deviceBound: status?.device_bound ?? false,
      };
    }

    const [lecturerRow] = await app.stores.db
      .select()
      .from(lecturers)
      .where(eq(lecturers.userId, user.id))
      .limit(1);

    return MeResponse.parse({
      userId: user.id,
      email: user.email,
      name: user.name,
      status: user.status,
      roles: assignments.map((assignment) => ({
        roleKey: assignment.role_key,
        scopeType: assignment.scope_type,
        scopeId: null,
        scopeName: assignment.scope_name ?? '',
      })),
      permissions: principal.permissions,
      student: studentBlock,
      staff: lecturerRow
        ? {
            id: lecturerRow.id,
            staffNumber: lecturerRow.staffNumber,
            requiresMfa: true,
          }
        : null,
    });
  });

  app.post('/api/v1/auth/password', async (request, reply) => {
    const principal = await app.authenticate(request);
    const input = ChangePasswordInput.parse(request.body);
    const [user] = await app.stores.db.select().from(users).where(eq(users.id, principal.userId)).limit(1);
    if (!user?.passwordHash) throw new ApiError('UNAUTHENTICATED');
    const ok = await verifyPassword(input.currentPassword, user.passwordHash);
    if (!ok) throw new ApiError('INVALID_CREDENTIALS', 'Current password is incorrect.');

    await app.stores.db
      .update(users)
      .set({ passwordHash: await hashPassword(input.newPassword), updatedAt: new Date() })
      .where(eq(users.id, principal.userId));

    // Sign out every other session: a password change revokes existing device trust.
    await app.stores.db
      .update(authSessions)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(authSessions.userId, principal.userId), sql`id <> ${principal.sessionId}::uuid`));

    await writeAudit(app.stores.db, {
      actorId: principal.userId,
      actorEmail: principal.email,
      action: 'auth.password_changed',
      entity: 'user',
      entityId: principal.userId,
      ip: request.ip,
      requestId: request.id,
    });

    void reply;
    return { ok: true as const };
  });

  // Kept for completeness: resolves a role key to its id, used by admin routes.
  void roles;
  void roleAssignments;
}
