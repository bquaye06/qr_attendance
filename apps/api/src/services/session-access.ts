import { and, eq, sql } from 'drizzle-orm';
import { classSessions, students, teachingAssignments } from '@attend/db';
import type { Database } from '@attend/db';
import { ApiError } from '../lib/problem.ts';
import { assertCan } from '../lib/auth.ts';
import type { Principal } from '../lib/auth.ts';
import type { ResourceScope } from '../domain/rbac.ts';
import { rows } from '../lib/query.ts';

/**
 * Resolves a session (or offering) to its place in the org hierarchy, so scope
 * checks work the same way everywhere. Missing rows are 404, never 403, so the
 * API does not confirm existence to an unauthorised caller.
 */
export interface SessionAccess extends ResourceScope {
  sessionId: string;
  offeringId: string;
  status: 'scheduled' | 'open' | 'closed' | 'cancelled';
  roomId: string | null;
  startsAt: Date;
  endsAt: Date;
  checkinOpensAt: Date;
  checkinClosesAt: Date;
  lateAfter: Date;
  geofenceEnabled: boolean;
  ipAllowlistEnforced: boolean;
  windowExtensions: number;
  qrSecretEnc: string | null;
  courseCode: string;
  courseTitle: string;
  roomName: string | null;
  roomAllowedCidrs: string[] | null;
  roomLatitude: number | null;
  roomLongitude: number | null;
  roomGeofenceM: number | null;
  termName: string;
}

export async function loadSessionAccess(database: Database, sessionId: string): Promise<SessionAccess> {
  const [row] = await rows<{
    id: string;
    offering_id: string;
    status: SessionAccess['status'];
    room_id: string | null;
    starts_at: Date;
    ends_at: Date;
    checkin_opens_at: Date;
    checkin_closes_at: Date;
    late_after: Date;
    geofence_enabled: boolean;
    ip_allowlist_enforced: boolean;
    window_extensions: number;
    qr_secret_enc: string | null;
    course_code: string;
    course_title: string;
    term_name: string;
    room_name: string | null;
    allowed_cidrs: string[] | null;
    latitude: string | null;
    longitude: string | null;
    geofence_m: number | null;
    institution_id: string;
    faculty_id: string;
    department_id: string;
  }>(
    database,
    sql`
      select s.id, s.offering_id, s.status, s.room_id, s.starts_at, s.ends_at,
             s.checkin_opens_at, s.checkin_closes_at, s.late_after,
             s.geofence_enabled, s.ip_allowlist_enforced, s.window_extensions, s.qr_secret_enc,
             c.code as course_code, c.title as course_title, t.name as term_name,
             r.name as room_name, r.allowed_cidrs, r.latitude::text as latitude,
             r.longitude::text as longitude, r.geofence_m,
             i.id as institution_id, f.id as faculty_id, d.id as department_id
      from class_sessions s
      join course_offerings o on o.id = s.offering_id
      join courses c on c.id = o.course_id
      join terms t on t.id = o.term_id
      join departments d on d.id = c.department_id
      join faculties f on f.id = d.faculty_id
      join institutions i on i.id = f.institution_id
      left join rooms r on r.id = s.room_id
      where s.id = ${sessionId}::uuid
    `,
  );
  if (!row) throw new ApiError('NOT_FOUND', 'Session not found.');

  return {
    sessionId: row.id,
    offeringId: row.offering_id,
    institutionId: row.institution_id,
    facultyId: row.faculty_id,
    departmentId: row.department_id,
    status: row.status,
    roomId: row.room_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    checkinOpensAt: row.checkin_opens_at,
    checkinClosesAt: row.checkin_closes_at,
    lateAfter: row.late_after,
    geofenceEnabled: row.geofence_enabled,
    ipAllowlistEnforced: row.ip_allowlist_enforced,
    windowExtensions: row.window_extensions,
    qrSecretEnc: row.qr_secret_enc,
    courseCode: row.course_code,
    courseTitle: row.course_title,
    roomName: row.room_name,
    roomAllowedCidrs: row.allowed_cidrs,
    roomLatitude: row.latitude ? Number(row.latitude) : null,
    roomLongitude: row.longitude ? Number(row.longitude) : null,
    roomGeofenceM: row.geofence_m,
    termName: row.term_name,
  };
}

export async function loadOfferingScope(
  database: Database,
  offeringId: string,
): Promise<ResourceScope & { courseCode: string; courseTitle: string; termName: string }> {
  const [row] = await rows<{
    institution_id: string;
    faculty_id: string;
    department_id: string;
    course_code: string;
    course_title: string;
    term_name: string;
  }>(
    database,
    sql`
      select i.id as institution_id, f.id as faculty_id, d.id as department_id,
             c.code as course_code, c.title as course_title, t.name as term_name
      from course_offerings o
      join courses c on c.id = o.course_id
      join terms t on t.id = o.term_id
      join departments d on d.id = c.department_id
      join faculties f on f.id = d.faculty_id
      join institutions i on i.id = f.institution_id
      where o.id = ${offeringId}::uuid and o.deleted_at is null
    `,
  );
  if (!row) throw new ApiError('NOT_FOUND', 'Course offering not found.');
  return {
    institutionId: row.institution_id,
    facultyId: row.faculty_id,
    departmentId: row.department_id,
    offeringId,
    courseCode: row.course_code,
    courseTitle: row.course_title,
    termName: row.term_name,
  };
}

export function assertSessionAccess(
  principal: Principal,
  access: ResourceScope,
  permission: 'session:start' | 'session:close' | 'session:read' | 'session:manage' | 'attendance:read' | 'attendance:override' | 'attendance:override_bulk' | 'report:read' | 'report:export',
): void {
  assertCan(principal, permission, access);
}

/** Offerings the principal teaches (lecturer or assistant). */
export async function loadTeachingOfferings(database: Database, lecturerId: string): Promise<string[]> {
  const result = await database
    .select({ offeringId: teachingAssignments.offeringId })
    .from(teachingAssignments)
    .where(and(eq(teachingAssignments.lecturerId, lecturerId), sql`deleted_at is null`));
  return result.map((row) => row.offeringId);
}

void classSessions;
void students;
