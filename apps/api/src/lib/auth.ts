import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { and, eq, isNull } from 'drizzle-orm';
import { authSessions, lecturers, students, users } from '@attend/db';
import type { Database } from '@attend/db';
import type { Permission } from '@attend/contracts';
import { decideAccess, permissionList } from '../domain/rbac.ts';
import type { Assignment, ResourceScope } from '../domain/rbac.ts';
import { ApiError } from './problem.ts';
import { rows } from './query.ts';

/**
 * Session handling and authorisation.
 *
 * Cookie: HttpOnly, SameSite=Lax, Secure in production, opaque 32-byte token.
 * Only a SHA-256 hash of the token is stored, so a database leak cannot be
 * replayed as a live session. Idle timeouts are per role kind and refreshed on
 * use; the absolute lifetime never extends.
 */

export const SESSION_COOKIE = 'attend_session';
export const CSRF_COOKIE = 'attend_csrf';

export interface Principal {
  userId: string;
  email: string;
  name: string;
  sessionId: string;
  kind: 'web' | 'api_key';
  mfaSatisfied: boolean;
  requiresMfa: boolean;
  studentId: string | null;
  lecturerId: string | null;
  assignments: Assignment[];
  permissions: string[];
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function newCsrfToken(): string {
  return randomBytes(24).toString('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function idleMinutesFor(options: {
  isAdmin: boolean;
  isStaff: boolean;
  adminIdleMinutes: number;
  staffIdleMinutes: number;
  studentIdleMinutes: number;
}): number {
  if (options.isAdmin) return options.adminIdleMinutes;
  if (options.isStaff) return options.staffIdleMinutes;
  return options.studentIdleMinutes;
}

export async function loadPrincipal(database: Database, token: string): Promise<Principal | null> {
  const tokenHash = hashSessionToken(token);
  const [session] = await database
    .select()
    .from(authSessions)
    .where(and(eq(authSessions.tokenHash, tokenHash), isNull(authSessions.revokedAt)))
    .limit(1);
  if (!session) return null;

  const now = new Date();
  if (session.idleExpiresAt <= now || session.absoluteExpiresAt <= now) return null;

  const [user] = await database
    .select()
    .from(users)
    .where(and(eq(users.id, session.userId), isNull(users.deletedAt)))
    .limit(1);
  if (!user || user.status !== 'active') return null;

  const [studentRow] = await database
    .select({ id: students.id })
    .from(students)
    .where(eq(students.userId, user.id))
    .limit(1);
  const [lecturerRow] = await database
    .select({ id: lecturers.id })
    .from(lecturers)
    .where(eq(lecturers.userId, user.id))
    .limit(1);

  const assignments = await loadAssignments(database, user.id);
  const isStaff =
    Boolean(lecturerRow) ||
    assignments.some((assignment) =>
      ['lecturer', 'teaching_assistant', 'faculty_admin', 'department_admin', 'super_admin', 'auditor'].includes(
        assignment.roleKey,
      ),
    );

  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    sessionId: session.id,
    kind: session.kind === 'api_key' ? 'api_key' : 'web',
    mfaSatisfied: session.mfaVerifiedAt !== null,
    requiresMfa: isStaff,
    studentId: studentRow?.id ?? null,
    lecturerId: lecturerRow?.id ?? null,
    assignments,
    permissions: permissionList(assignments),
  };
}

export async function loadAssignments(database: Database, userId: string): Promise<Assignment[]> {
  // Aggregating in SQL keeps authorisation to a single round trip.
  const result = await rows<{
    role_key: string;
    scope_type: Assignment['scopeType'];
    scope_id: string | null;
    permissions: string[] | null;
  }>(
    database,
    sql`
      select r.key as role_key,
             ra.scope_type::text as scope_type,
             ra.scope_id,
             coalesce(array_agg(p.key) filter (where p.key is not null), '{}') as permissions
      from role_assignments ra
      join roles r on r.id = ra.role_id and r.deleted_at is null
      left join role_permissions rp on rp.role_id = r.id
      left join permissions p on p.id = rp.permission_id
      where ra.user_id = ${userId}::uuid
      group by r.key, ra.scope_type, ra.scope_id
    `,
  );

  return result.map((row) => ({
    roleKey: row.role_key,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    permissions: row.permissions ?? [],
  }));
}

export function can(
  principal: Principal,
  permission: Permission | string,
  resource: ResourceScope,
): boolean {
  if (principal.requiresMfa && !principal.mfaSatisfied) return false;
  return decideAccess(principal.assignments, permission, resource).allowed;
}

export function assertCan(
  principal: Principal,
  permission: Permission | string,
  resource: ResourceScope,
): void {
  if (principal.requiresMfa && !principal.mfaSatisfied) {
    throw new ApiError('MFA_REQUIRED', 'Complete two-factor setup to continue.');
  }
  const decision = decideAccess(principal.assignments, permission, resource);
  if (!decision.allowed) {
    throw new ApiError('FORBIDDEN', `Missing ${permission} for this scope.`);
  }
}

export function assertStudent(principal: Principal): string {
  if (!principal.studentId) throw new ApiError('FORBIDDEN', 'This endpoint is for students.');
  return principal.studentId;
}

export function assertLecturer(principal: Principal): string {
  if (!principal.lecturerId) throw new ApiError('FORBIDDEN', 'This endpoint is for teaching staff.');
  return principal.lecturerId;
}

/** Sliding idle expiry: extend on use, never past the absolute limit. */
export async function touchSession(
  database: Database,
  sessionId: string,
  idleMinutes: number,
): Promise<void> {
  const now = new Date();
  await database
    .update(authSessions)
    .set({ idleExpiresAt: new Date(now.getTime() + idleMinutes * 60_000), updatedAt: now })
    .where(eq(authSessions.id, sessionId));
}
