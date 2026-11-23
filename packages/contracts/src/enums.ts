/**
 * Every enum in the system. Kept as const objects (not TS enums) so the same
 * values can be used by Node's type-stripping runtime, Zod and the database.
 */

export const ATTENDANCE_STATUSES = [
  'present',
  'late',
  'present_flagged',
  'present_manual',
  'absent',
  'excused',
] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

/** Statuses that mean the student physically attended. */
export const PRESENT_STATUSES: readonly AttendanceStatus[] = [
  'present',
  'late',
  'present_flagged',
  'present_manual',
];

export const ATTENDANCE_METHODS = ['auto', 'manual'] as const;
export type AttendanceMethod = (typeof ATTENDANCE_METHODS)[number];

export const SESSION_STATUSES = ['scheduled', 'open', 'closed', 'cancelled'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const ATTEMPT_STAGES = ['claim', 'face'] as const;
export type AttemptStage = (typeof ATTEMPT_STAGES)[number];

export const ATTEMPT_RESULTS = ['pass', 'fail', 'flagged'] as const;
export type AttemptResult = (typeof ATTEMPT_RESULTS)[number];

export const DEVICE_STATUSES = ['active', 'revoked'] as const;
export type DeviceStatus = (typeof DEVICE_STATUSES)[number];

export const RESET_REQUEST_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type ResetRequestStatus = (typeof RESET_REQUEST_STATUSES)[number];

export const APPEAL_STATUSES = ['open', 'accepted', 'rejected'] as const;
export type AppealStatus = (typeof APPEAL_STATUSES)[number];

export const USER_STATUSES = ['active', 'suspended'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const SCOPE_TYPES = ['institution', 'faculty', 'department', 'offering'] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];

export const SYSTEM_ROLES = [
  'super_admin',
  'faculty_admin',
  'department_admin',
  'lecturer',
  'teaching_assistant',
  'student',
  'auditor',
] as const;
export type SystemRole = (typeof SYSTEM_ROLES)[number];

export const ENROLLMENT_STATUSES = ['active', 'dropped', 'completed'] as const;
export type EnrollmentStatus = (typeof ENROLLMENT_STATUSES)[number];

export const TEACHING_ROLES = ['lecturer', 'assistant'] as const;
export type TeachingRole = (typeof TEACHING_ROLES)[number];

export const REVIEW_STATES = ['pending', 'confirmed', 'rejected', 'escalated'] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

/** Liveness challenges the face service can verify. */
export const LIVENESS_CHALLENGES = ['blink', 'turn_left', 'turn_right', 'none'] as const;
export type LivenessChallenge = (typeof LIVENESS_CHALLENGES)[number];

/** Face-service model families we can record against a template. */
export const FACE_MODEL_VERSION = 'insightface-buffalo_l-arcface-r100';

export const FORMATS = ['json', 'csv', 'pdf', 'xlsx'] as const;
export type ExportFormat = (typeof FORMATS)[number];
