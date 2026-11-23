import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  pgTable,
  primaryKey,
  smallint,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
  inet,
} from 'drizzle-orm/pg-core';

/**
 * Drizzle mirror of `migrations/0001_init.sql`.
 *
 * The SQL migration is the source of truth for DDL; this file exists so the API
 * gets typed queries. When they disagree, the migration wins and this file is a
 * bug — `pnpm --filter @attend/db generate` is not used to author DDL.
 */

const createdAt = timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

// ---------------------------------------------------------------- org hierarchy

export const institutions = pgTable('institutions', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  name: text('name').notNull(),
  code: text('code').notNull().unique(),
  timeZone: text('time_zone').notNull().default('Africa/Accra'),
  createdAt,
  updatedAt,
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const faculties = pgTable(
  'faculties',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    code: text('code').notNull(),
    createdAt,
    updatedAt,
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [uniqueIndex('faculties_institution_code').on(table.institutionId, table.code)],
);

export const departments = pgTable(
  'departments',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    facultyId: uuid('faculty_id')
      .notNull()
      .references(() => faculties.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    code: text('code').notNull(),
    createdAt,
    updatedAt,
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [uniqueIndex('departments_faculty_code').on(table.facultyId, table.code)],
);

export const programmes = pgTable(
  'programmes',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    departmentId: uuid('department_id')
      .notNull()
      .references(() => departments.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    code: text('code').notNull(),
    createdAt,
    updatedAt,
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [uniqueIndex('programmes_department_code').on(table.departmentId, table.code)],
);

export const terms = pgTable('terms', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  institutionId: uuid('institution_id')
    .notNull()
    .references(() => institutions.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  startsOn: date('starts_on').notNull(),
  endsOn: date('ends_on').notNull(),
  isCurrent: boolean('is_current').notNull().default(false),
  createdAt,
  updatedAt,
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const courses = pgTable(
  'courses',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    departmentId: uuid('department_id')
      .notNull()
      .references(() => departments.id, { onDelete: 'restrict' }),
    code: text('code').notNull(),
    title: text('title').notNull(),
    creditHours: smallint('credit_hours').notNull().default(3),
    createdAt,
    updatedAt,
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [uniqueIndex('courses_department_code').on(table.departmentId, table.code)],
);

export const courseOfferings = pgTable(
  'course_offerings',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    courseId: uuid('course_id')
      .notNull()
      .references(() => courses.id, { onDelete: 'restrict' }),
    termId: uuid('term_id')
      .notNull()
      .references(() => terms.id, { onDelete: 'restrict' }),
    section: text('section').notNull().default('A'),
    capacity: integer('capacity'),
    createdAt,
    updatedAt,
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [uniqueIndex('offerings_course_term_section').on(table.courseId, table.termId, table.section)],
);

export const rooms = pgTable('rooms', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  institutionId: uuid('institution_id')
    .notNull()
    .references(() => institutions.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  building: text('building'),
  latitude: numeric('latitude', { precision: 9, scale: 6 }),
  longitude: numeric('longitude', { precision: 9, scale: 6 }),
  geofenceM: integer('geofence_m').notNull().default(100),
  allowedCidrs: text('allowed_cidrs').array().notNull().default(sql`'{}'::text[]`),
  createdAt,
  updatedAt,
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const timetableSlots = pgTable('timetable_slots', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  offeringId: uuid('offering_id')
    .notNull()
    .references(() => courseOfferings.id, { onDelete: 'cascade' }),
  roomId: uuid('room_id')
    .notNull()
    .references(() => rooms.id, { onDelete: 'restrict' }),
  dayOfWeek: smallint('day_of_week').notNull(),
  startsAt: time('starts_at').notNull(),
  endsAt: time('ends_at').notNull(),
  validFrom: date('valid_from').notNull(),
  validTo: date('valid_to').notNull(),
  createdAt,
  updatedAt,
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

// ---------------------------------------------------------------- people

export const users = pgTable('users', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  email: text('email').notNull(),
  name: text('name').notNull(),
  passwordHash: text('password_hash'),
  status: text('status').notNull().default('active'),
  ssoSubject: text('sso_subject').unique(),
  totpSecretEnc: text('totp_secret_enc'),
  totpConfirmedAt: timestamp('totp_confirmed_at', { withTimezone: true }),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  createdAt,
  updatedAt,
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const students = pgTable('students', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  studentNumber: text('student_number').notNull().unique(),
  programmeId: uuid('programme_id')
    .notNull()
    .references(() => programmes.id, { onDelete: 'restrict' }),
  year: smallint('year').notNull().default(1),
  biometricFailureCount: integer('biometric_failure_count').notNull().default(0),
  leftAt: timestamp('left_at', { withTimezone: true }),
  createdAt,
  updatedAt,
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const lecturers = pgTable('lecturers', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  staffNumber: text('staff_number').notNull().unique(),
  departmentId: uuid('department_id')
    .notNull()
    .references(() => departments.id, { onDelete: 'restrict' }),
  isTeachingAssistant: boolean('is_teaching_assistant').notNull().default(false),
  createdAt,
  updatedAt,
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const teachingAssignments = pgTable(
  'teaching_assignments',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    offeringId: uuid('offering_id')
      .notNull()
      .references(() => courseOfferings.id, { onDelete: 'cascade' }),
    lecturerId: uuid('lecturer_id')
      .notNull()
      .references(() => lecturers.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('lecturer'),
    createdAt,
    updatedAt,
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [uniqueIndex('teaching_assignments_offering_lecturer').on(table.offeringId, table.lecturerId)],
);

export const enrollments = pgTable(
  'enrollments',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    offeringId: uuid('offering_id')
      .notNull()
      .references(() => courseOfferings.id, { onDelete: 'cascade' }),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('active'),
    createdAt,
    updatedAt,
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [uniqueIndex('enrollments_offering_student').on(table.offeringId, table.studentId)],
);

// ---------------------------------------------------------------- RBAC

export const roles = pgTable('roles', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  key: text('key').notNull().unique(),
  name: text('name').notNull(),
  isSystem: boolean('is_system').notNull().default(false),
  createdAt,
  updatedAt,
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const permissions = pgTable('permissions', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  key: text('key').notNull().unique(),
  description: text('description').notNull().default(''),
  createdAt,
  updatedAt,
});

export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permissionId: uuid('permission_id')
      .notNull()
      .references(() => permissions.id, { onDelete: 'cascade' }),
    createdAt,
  },
  (table) => [primaryKey({ columns: [table.roleId, table.permissionId] })],
);

export const roleAssignments = pgTable('role_assignments', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  roleId: uuid('role_id')
    .notNull()
    .references(() => roles.id, { onDelete: 'cascade' }),
  scopeType: text('scope_type').notNull(),
  scopeId: uuid('scope_id'),
  createdAt,
  updatedAt,
});

// ---------------------------------------------------------------- auth

export const authSessions = pgTable('auth_sessions', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  kind: text('kind').notNull().default('web'),
  idleExpiresAt: timestamp('idle_expires_at', { withTimezone: true }).notNull(),
  mfaVerifiedAt: timestamp('mfa_verified_at', { withTimezone: true }),
  absoluteExpiresAt: timestamp('absolute_expires_at', { withTimezone: true }).notNull(),
  ip: inet('ip'),
  userAgent: text('user_agent'),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt,
  updatedAt,
});

export const webauthnChallenges = pgTable('webauthn_challenges', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  purpose: text('purpose').notNull(),
  challenge: text('challenge').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt,
});

// ---------------------------------------------------------------- devices

export const devices = pgTable('devices', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  studentId: uuid('student_id')
    .notNull()
    .references(() => students.id, { onDelete: 'cascade' }),
  webauthnCredentialId: text('webauthn_credential_id').notNull().unique(),
  publicKey: text('public_key').notNull(),
  signCount: bigint('sign_count', { mode: 'number' }).notNull().default(0),
  fingerprintHash: text('fingerprint_hash').notNull(),
  platform: text('platform').notNull(),
  userAgentFamily: text('user_agent_family').notNull(),
  status: text('status').notNull().default('active'),
  boundAt: timestamp('bound_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt,
  updatedAt,
});

export const deviceResetRequests = pgTable('device_reset_requests', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  studentId: uuid('student_id')
    .notNull()
    .references(() => students.id, { onDelete: 'cascade' }),
  reason: text('reason').notNull(),
  status: text('status').notNull().default('pending'),
  decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decisionNote: text('decision_note'),
  createdAt,
  updatedAt,
});

// ---------------------------------------------------------------- biometrics

export const biometricConsents = pgTable('biometric_consents', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  studentId: uuid('student_id')
    .notNull()
    .references(() => students.id, { onDelete: 'cascade' }),
  noticeVersion: text('notice_version').notNull(),
  grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
  ip: inet('ip'),
  createdAt,
  updatedAt,
});

/** Separate schema + separate DB role: see migrations/0001_init.sql grants. */
export const biometricsSchema = pgSchema('biometrics');

export const faceTemplates = biometricsSchema.table('face_templates', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  studentId: uuid('student_id').notNull(),
  embedding: vector('embedding', { dimensions: 512 }).notNull(),
  modelVersion: text('model_version').notNull(),
  qualityScore: numeric('quality_score', { precision: 4, scale: 3 }).notNull(),
  livenessScore: numeric('liveness_score', { precision: 4, scale: 3 }),
  isActive: boolean('is_active').notNull().default(true),
  enrolledAt: timestamp('enrolled_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt,
  updatedAt,
});

// ---------------------------------------------------------------- sessions

export const classSessions = pgTable('class_sessions', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  offeringId: uuid('offering_id')
    .notNull()
    .references(() => courseOfferings.id, { onDelete: 'cascade' }),
  roomId: uuid('room_id').references(() => rooms.id, { onDelete: 'set null' }),
  timetableSlotId: uuid('timetable_slot_id').references(() => timetableSlots.id, { onDelete: 'set null' }),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  checkinOpensAt: timestamp('checkin_opens_at', { withTimezone: true }).notNull(),
  checkinClosesAt: timestamp('checkin_closes_at', { withTimezone: true }).notNull(),
  lateAfter: timestamp('late_after', { withTimezone: true }).notNull(),
  status: text('status').notNull().default('scheduled'),
  qrSecretEnc: text('qr_secret_enc'),
  qrSecretRotatedAt: timestamp('qr_secret_rotated_at', { withTimezone: true }),
  geofenceEnabled: boolean('geofence_enabled').notNull().default(false),
  ipAllowlistEnforced: boolean('ip_allowlist_enforced').notNull().default(false),
  windowExtensions: integer('window_extensions').notNull().default(0),
  openedAt: timestamp('opened_at', { withTimezone: true }),
  openedBy: uuid('opened_by').references(() => users.id, { onDelete: 'set null' }),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  closedBy: uuid('closed_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt,
  updatedAt,
});

export const checkinClaims = pgTable('checkin_claims', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  sessionId: uuid('session_id')
    .notNull()
    .references(() => classSessions.id, { onDelete: 'cascade' }),
  studentId: uuid('student_id')
    .notNull()
    .references(() => students.id, { onDelete: 'cascade' }),
  deviceId: uuid('device_id')
    .notNull()
    .references(() => devices.id, { onDelete: 'cascade' }),
  challenge: text('challenge').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt,
});

export const idempotencyKeys = pgTable('idempotency_keys', {
  key: text('key').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  route: text('route').notNull(),
  requestHash: text('request_hash').notNull(),
  responseStatus: integer('response_status'),
  responseBody: jsonb('response_body'),
  createdAt,
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

// ---------------------------------------------------------------- attendance

export const attendanceAttempts = pgTable(
  'attendance_attempts',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => classSessions.id, { onDelete: 'cascade' }),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
    stage: text('stage').notNull(),
    result: text('result').notNull(),
    failureReason: text('failure_reason'),
    similarity: numeric('similarity', { precision: 5, scale: 4 }),
    livenessScore: numeric('liveness_score', { precision: 5, scale: 4 }),
    qualityScore: numeric('quality_score', { precision: 5, scale: 4 }),
    riskScore: integer('risk_score'),
    geoDistanceM: integer('geo_distance_m'),
    tokenIssuedAt: timestamp('token_issued_at', { withTimezone: true }),
    ip: inet('ip'),
    evidenceKey: text('evidence_key'),
    evidencePurgedAt: timestamp('evidence_purged_at', { withTimezone: true }),
    createdAt,
  },
  (table) => [index('attempts_session_idx').on(table.sessionId, table.createdAt)],
);

export const attendanceRecords = pgTable(
  'attendance_records',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => classSessions.id, { onDelete: 'cascade' }),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
    status: text('status').notNull(),
    method: text('method').notNull().default('auto'),
    checkedInAt: timestamp('checked_in_at', { withTimezone: true }),
    riskScore: integer('risk_score'),
    flagReason: text('flag_reason'),
    similarity: numeric('similarity', { precision: 5, scale: 4 }),
    livenessScore: numeric('liveness_score', { precision: 5, scale: 4 }),
    geoDistanceM: integer('geo_distance_m'),
    markedBy: uuid('marked_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt,
    updatedAt,
  },
  (table) => [index('records_session_idx').on(table.sessionId)],
);

export const attendanceOverrides = pgTable('attendance_overrides', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  recordId: uuid('record_id')
    .notNull()
    .references(() => attendanceRecords.id, { onDelete: 'cascade' }),
  oldStatus: text('old_status').notNull(),
  newStatus: text('new_status').notNull(),
  reason: text('reason').notNull(),
  actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt,
});

export const reviewItems = pgTable('review_items', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  kind: text('kind').notNull(),
  recordId: uuid('record_id').references(() => attendanceRecords.id, { onDelete: 'cascade' }),
  attemptId: uuid('attempt_id').references(() => attendanceAttempts.id, { onDelete: 'cascade' }),
  sessionId: uuid('session_id')
    .notNull()
    .references(() => classSessions.id, { onDelete: 'cascade' }),
  studentId: uuid('student_id')
    .notNull()
    .references(() => students.id, { onDelete: 'cascade' }),
  reasons: text('reasons').array().notNull().default(sql`'{}'::text[]`),
  riskScore: integer('risk_score'),
  state: text('state').notNull().default('pending'),
  resolvedBy: uuid('resolved_by').references(() => users.id, { onDelete: 'set null' }),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  note: text('note'),
  createdAt,
  updatedAt,
});

export const appeals = pgTable('appeals', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  recordId: uuid('record_id')
    .notNull()
    .references(() => attendanceRecords.id, { onDelete: 'cascade' }),
  studentId: uuid('student_id')
    .notNull()
    .references(() => students.id, { onDelete: 'cascade' }),
  message: text('message').notNull(),
  status: text('status').notNull().default('open'),
  decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decisionNote: text('decision_note'),
  createdAt,
  updatedAt,
});

// ---------------------------------------------------------------- system

export const systemSettings = pgTable('system_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  version: integer('version').notNull().default(1),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt,
});

export const systemSettingHistory = pgTable('system_setting_history', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  key: text('key').notNull(),
  version: integer('version').notNull(),
  value: jsonb('value').notNull(),
  actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
  reason: text('reason'),
  createdAt,
});

export const featureFlags = pgTable('feature_flags', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  facultyId: uuid('faculty_id')
    .notNull()
    .references(() => faculties.id, { onDelete: 'cascade' }),
  flag: text('flag').notNull(),
  enabled: boolean('enabled').notNull(),
  createdAt,
  updatedAt,
});

export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  actorId: uuid('actor_id'),
  actorEmail: text('actor_email'),
  action: text('action').notNull(),
  entity: text('entity').notNull(),
  entityId: uuid('entity_id'),
  before: jsonb('before'),
  after: jsonb('after'),
  ip: inet('ip'),
  requestId: text('request_id'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
});

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  name: text('name').notNull(),
  keyHash: text('key_hash').notNull().unique(),
  scopes: text('scopes').array().notNull().default(sql`'{}'::text[]`),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt,
});

export const webhooks = pgTable('webhooks', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  url: text('url').notNull(),
  events: text('events').array().notNull(),
  secretEnc: text('secret_enc').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt,
  updatedAt,
});

export const jobRuns = pgTable('job_runs', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  job: text('job').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  status: text('status').notNull().default('running'),
  detail: jsonb('detail'),
});
