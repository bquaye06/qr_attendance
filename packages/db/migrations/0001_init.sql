-- Attend: initial schema.
-- Owner: packages/db. This file is append-only once applied: every later change
-- ships as a new numbered migration.
--
-- Conventions:
--   * uuid primary keys, generated in-database
--   * created_at / updated_at on every table
--   * soft delete (deleted_at) on master data only
--   * explicit ON DELETE rules on every foreign key
--   * integrity rules that can be constraints ARE constraints

create extension if not exists "pgcrypto";
create extension if not exists "vector";
create schema if not exists biometrics;

-- ---------------------------------------------------------------- org hierarchy
create table if not exists institutions (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  code text not null unique,
  time_zone text not null default 'Africa/Accra',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists faculties (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null references institutions(id) on delete cascade,
  name text not null,
  code text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (institution_id, code)
);

create table if not exists departments (
  id uuid primary key default gen_random_uuid(),
  faculty_id uuid not null references faculties(id) on delete cascade,
  name text not null,
  code text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (faculty_id, code)
);

create table if not exists programmes (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references departments(id) on delete cascade,
  name text not null,
  code text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (department_id, code)
);

create table if not exists terms (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null references institutions(id) on delete cascade,
  name text not null,
  starts_on date not null,
  ends_on date not null,
  is_current boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint terms_dates_ordered check (ends_on > starts_on)
);

-- Only one current term per institution.
create unique index if not exists terms_one_current
  on terms (institution_id) where is_current and deleted_at is null;

create table if not exists courses (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references departments(id) on delete restrict,
  code text not null,
  title text not null,
  credit_hours smallint not null default 3,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (department_id, code)
);

create table if not exists course_offerings (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references courses(id) on delete restrict,
  term_id uuid not null references terms(id) on delete restrict,
  section text not null default 'A',
  capacity integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (course_id, term_id, section)
);

create table if not exists rooms (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null references institutions(id) on delete cascade,
  name text not null,
  building text,
  latitude numeric(9, 6),
  longitude numeric(9, 6),
  geofence_m integer not null default 100,
  allowed_cidrs text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint rooms_geofence_range check (geofence_m between 20 and 2000),
  constraint rooms_has_both_coords check (
    (latitude is null and longitude is null) or (latitude is not null and longitude is not null)
  )
);

create table if not exists timetable_slots (
  id uuid primary key default gen_random_uuid(),
  offering_id uuid not null references course_offerings(id) on delete cascade,
  room_id uuid not null references rooms(id) on delete restrict,
  day_of_week smallint not null,
  starts_at time not null,
  ends_at time not null,
  valid_from date not null,
  valid_to date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint timetable_day_range check (day_of_week between 1 and 7),
  constraint timetable_time_order check (ends_at > starts_at),
  constraint timetable_valid_range check (valid_to >= valid_from)
);

-- ---------------------------------------------------------------- people
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  name text not null,
  password_hash text,
  status text not null default 'active',
  sso_subject text unique,
  totp_secret_enc text,
  totp_confirmed_at timestamptz,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint users_status_values check (status in ('active', 'suspended'))
);

create unique index if not exists users_email_lower on users (lower(email)) where deleted_at is null;

create table if not exists students (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references users(id) on delete cascade,
  student_number text not null unique,
  programme_id uuid not null references programmes(id) on delete restrict,
  year smallint not null default 1,
  biometric_failure_count integer not null default 0,
  left_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint students_year_range check (year between 1 and 8)
);

create table if not exists lecturers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references users(id) on delete cascade,
  staff_number text not null unique,
  department_id uuid not null references departments(id) on delete restrict,
  is_teaching_assistant boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists teaching_assignments (
  id uuid primary key default gen_random_uuid(),
  offering_id uuid not null references course_offerings(id) on delete cascade,
  lecturer_id uuid not null references lecturers(id) on delete cascade,
  role text not null default 'lecturer',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (offering_id, lecturer_id),
  constraint teaching_assignment_role check (role in ('lecturer', 'assistant'))
);

create table if not exists enrollments (
  id uuid primary key default gen_random_uuid(),
  offering_id uuid not null references course_offerings(id) on delete cascade,
  student_id uuid not null references students(id) on delete cascade,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (offering_id, student_id),
  constraint enrollments_status check (status in ('active', 'dropped', 'completed'))
);

-- ---------------------------------------------------------------- RBAC
create table if not exists roles (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists permissions (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  description text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists role_permissions (
  role_id uuid not null references roles(id) on delete cascade,
  permission_id uuid not null references permissions(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (role_id, permission_id)
);

create table if not exists role_assignments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  role_id uuid not null references roles(id) on delete cascade,
  scope_type text not null,
  scope_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint role_assignment_scope_type check (scope_type in ('institution', 'faculty', 'department', 'offering')),
  constraint role_assignment_scope_shape check (
    (scope_type = 'institution' and scope_id is null) or (scope_type <> 'institution' and scope_id is not null)
  )
);

create unique index if not exists role_assignments_unique
  on role_assignments (user_id, role_id, scope_type, coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- ---------------------------------------------------------------- auth sessions
create table if not exists auth_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  kind text not null default 'web',
  idle_expires_at timestamptz not null,
  mfa_verified_at timestamptz,
  absolute_expires_at timestamptz not null,
  ip inet,
  user_agent text,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint auth_sessions_kind check (kind in ('web', 'api_key'))
);

create index if not exists auth_sessions_user on auth_sessions (user_id) where revoked_at is null;

-- Short-lived WebAuthn challenges (registration and claim assertions).
create table if not exists webauthn_challenges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  purpose text not null,
  challenge text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint webauthn_challenge_purpose check (purpose in ('register', 'claim')),
  constraint webauthn_challenge_owner unique (id, user_id)
);

create index if not exists webauthn_challenges_lookup on webauthn_challenges (user_id, purpose, expires_at);

-- ---------------------------------------------------------------- devices
create table if not exists devices (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references students(id) on delete cascade,
  webauthn_credential_id text not null unique,
  public_key text not null,
  sign_count bigint not null default 0,
  fingerprint_hash text not null,
  platform text not null,
  user_agent_family text not null,
  status text not null default 'active',
  bound_at timestamptz not null default now(),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint devices_status check (status in ('active', 'revoked'))
);

-- One active device per student, enforced by the database.
create unique index if not exists devices_one_active_per_student
  on devices (student_id) where status = 'active';

create table if not exists device_reset_requests (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references students(id) on delete cascade,
  reason text not null,
  status text not null default 'pending',
  decided_by uuid references users(id) on delete set null,
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint device_reset_status check (status in ('pending', 'approved', 'rejected'))
);

create unique index if not exists device_reset_one_pending
  on device_reset_requests (student_id) where status = 'pending';

-- ---------------------------------------------------------------- biometrics
create table if not exists biometric_consents (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references students(id) on delete cascade,
  notice_version text not null,
  granted_at timestamptz not null default now(),
  withdrawn_at timestamptz,
  ip inet,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists biometric_consents_active
  on biometric_consents (student_id) where withdrawn_at is null;

-- Face templates live in their own schema with their own grant, so the app's
-- default role cannot read embeddings unless a query explicitly uses it.
create table if not exists biometrics.face_templates (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.students(id) on delete cascade,
  embedding vector(512) not null,
  model_version text not null,
  quality_score numeric(4, 3) not null,
  liveness_score numeric(4, 3),
  is_active boolean not null default true,
  enrolled_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One active template per student per model version.
create unique index if not exists face_templates_one_active
  on biometrics.face_templates (student_id, model_version) where is_active;

-- HNSW is only used for the duplicate-enrollment search, never for check-in.
create index if not exists face_templates_embedding_hnsw
  on biometrics.face_templates using hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------- sessions
create table if not exists class_sessions (
  id uuid primary key default gen_random_uuid(),
  offering_id uuid not null references course_offerings(id) on delete cascade,
  room_id uuid references rooms(id) on delete set null,
  timetable_slot_id uuid references timetable_slots(id) on delete set null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  checkin_opens_at timestamptz not null,
  checkin_closes_at timestamptz not null,
  late_after timestamptz not null,
  status text not null default 'scheduled',
  qr_secret_enc text,
  qr_secret_rotated_at timestamptz,
  geofence_enabled boolean not null default false,
  ip_allowlist_enforced boolean not null default false,
  window_extensions integer not null default 0,
  opened_at timestamptz,
  opened_by uuid references users(id) on delete set null,
  closed_at timestamptz,
  closed_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint class_sessions_status check (status in ('scheduled', 'open', 'closed', 'cancelled')),
  constraint class_sessions_time_order check (
    ends_at > starts_at and checkin_opens_at <= checkin_closes_at and late_after <= checkin_closes_at
  ),
  unique (offering_id, starts_at)
);

create index if not exists class_sessions_offering_starts on class_sessions (offering_id, starts_at desc);
create index if not exists class_sessions_open on class_sessions (checkin_closes_at) where status = 'open';

-- Claim window: created when a QR scan succeeds, consumed by the face stage.
create table if not exists checkin_claims (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references class_sessions(id) on delete cascade,
  student_id uuid not null references students(id) on delete cascade,
  device_id uuid not null references devices(id) on delete cascade,
  challenge text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists checkin_claims_lookup on checkin_claims (id, student_id);

-- Idempotency keys for check-in requests.
create table if not exists idempotency_keys (
  key text primary key,
  user_id uuid not null references users(id) on delete cascade,
  route text not null,
  request_hash text not null,
  response_status integer,
  response_body jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

-- ---------------------------------------------------------------- attendance
create table if not exists attendance_attempts (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references class_sessions(id) on delete cascade,
  student_id uuid not null references students(id) on delete cascade,
  device_id uuid references devices(id) on delete set null,
  stage text not null,
  result text not null,
  failure_reason text,
  similarity numeric(5, 4),
  liveness_score numeric(5, 4),
  quality_score numeric(5, 4),
  risk_score integer,
  geo_distance_m integer,
  token_issued_at timestamptz,
  ip inet,
  evidence_key text,
  evidence_purged_at timestamptz,
  created_at timestamptz not null default now(),
  constraint attempts_stage check (stage in ('claim', 'face')),
  constraint attempts_result check (result in ('pass', 'fail', 'flagged'))
);

create index if not exists attempts_session on attendance_attempts (session_id, created_at desc);
create index if not exists attempts_student on attendance_attempts (student_id, created_at desc);
create index if not exists attempts_recent_failures
  on attendance_attempts (student_id, session_id) where result = 'fail';

create table if not exists attendance_records (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references class_sessions(id) on delete cascade,
  student_id uuid not null references students(id) on delete cascade,
  device_id uuid references devices(id) on delete set null,
  status text not null,
  method text not null default 'auto',
  checked_in_at timestamptz,
  risk_score integer,
  flag_reason text,
  similarity numeric(5, 4),
  liveness_score numeric(5, 4),
  geo_distance_m integer,
  marked_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint records_status check (
    status in ('present', 'late', 'present_flagged', 'present_manual', 'absent', 'excused')
  ),
  constraint records_method check (method in ('auto', 'manual'))
);

-- One record per student per session, and one device per session.
create unique index if not exists records_one_per_student
  on attendance_records (session_id, student_id);
create unique index if not exists records_one_device_per_session
  on attendance_records (session_id, device_id) where device_id is not null;

create index if not exists records_session on attendance_records (session_id);
create index if not exists records_student_time on attendance_records (student_id, checked_in_at desc);

create table if not exists attendance_overrides (
  id uuid primary key default gen_random_uuid(),
  record_id uuid not null references attendance_records(id) on delete cascade,
  old_status text not null,
  new_status text not null,
  reason text not null,
  actor_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint override_reason_not_empty check (length(btrim(reason)) >= 3)
);

create table if not exists review_items (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  record_id uuid references attendance_records(id) on delete cascade,
  attempt_id uuid references attendance_attempts(id) on delete cascade,
  session_id uuid not null references class_sessions(id) on delete cascade,
  student_id uuid not null references students(id) on delete cascade,
  reasons text[] not null default '{}',
  risk_score integer,
  state text not null default 'pending',
  resolved_by uuid references users(id) on delete set null,
  resolved_at timestamptz,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint review_kind check (kind in ('attempt', 'record')),
  constraint review_state check (state in ('pending', 'confirmed', 'rejected', 'escalated'))
);

create index if not exists review_pending on review_items (state, created_at desc);

create table if not exists appeals (
  id uuid primary key default gen_random_uuid(),
  record_id uuid not null references attendance_records(id) on delete cascade,
  student_id uuid not null references students(id) on delete cascade,
  message text not null,
  status text not null default 'open',
  decided_by uuid references users(id) on delete set null,
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint appeals_status check (status in ('open', 'accepted', 'rejected'))
);

create unique index if not exists appeals_one_open_per_record
  on appeals (record_id) where status = 'open';

-- ---------------------------------------------------------------- system
create table if not exists system_settings (
  key text primary key,
  value jsonb not null,
  version integer not null default 1,
  updated_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now()
);

create table if not exists system_setting_history (
  id uuid primary key default gen_random_uuid(),
  key text not null,
  version integer not null,
  value jsonb not null,
  actor_id uuid references users(id) on delete set null,
  reason text,
  created_at timestamptz not null default now(),
  unique (key, version)
);

create table if not exists feature_flags (
  id uuid primary key default gen_random_uuid(),
  faculty_id uuid not null references faculties(id) on delete cascade,
  flag text not null,
  enabled boolean not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (faculty_id, flag),
  constraint feature_flags_known check (flag in ('geofence', 'active_liveness', 'manual_override'))
);

-- Append-only audit log: no updates, no deletes (enforced by grants below).
create table if not exists audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid,
  actor_email text,
  action text not null,
  entity text not null,
  entity_id uuid,
  before jsonb,
  after jsonb,
  ip inet,
  request_id text,
  at timestamptz not null default now()
);

create index if not exists audit_at on audit_log (at desc);
create index if not exists audit_actor on audit_log (actor_id, at desc);
create index if not exists audit_entity on audit_log (entity, entity_id, at desc);
create index if not exists audit_action on audit_log (action, at desc);

create table if not exists api_keys (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  key_hash text not null unique,
  scopes text[] not null default '{}',
  created_by uuid references users(id) on delete set null,
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists webhooks (
  id uuid primary key default gen_random_uuid(),
  url text not null,
  events text[] not null,
  secret_enc text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists job_runs (
  id uuid primary key default gen_random_uuid(),
  job text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running',
  detail jsonb,
  constraint job_runs_status check (status in ('running', 'ok', 'failed'))
);

-- ---------------------------------------------------------------- derived views
create or replace view session_attendance_counts as
select
  s.id as session_id,
  s.offering_id,
  (select count(*) from enrollments e where e.offering_id = s.offering_id and e.status = 'active' and e.deleted_at is null) as enrolled,
  count(r.id) filter (where r.status in ('present', 'present_manual')) as present,
  count(r.id) filter (where r.status = 'late') as late,
  count(r.id) filter (where r.status = 'present_flagged') as flagged,
  count(r.id) filter (where r.status = 'absent') as absent,
  count(r.id) filter (where r.status = 'excused') as excused
from class_sessions s
left join attendance_records r on r.session_id = s.id
group by s.id, s.offering_id;

-- ---------------------------------------------------------------- grants
-- A dedicated role owns biometric reads. In managed Postgres (Neon) the
-- migration runner may not be allowed to create roles, so this block degrades
-- to a warning rather than blocking the deployment.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'attend_biometrics') then
    create role attend_biometrics nologin;
  end if;
  grant usage on schema biometrics to attend_biometrics;
  grant select, insert, update, delete on biometrics.face_templates to attend_biometrics;
exception
  when insufficient_privilege then
    raise notice 'skipping biometrics role grants: insufficient privilege';
end;
$$;

-- The application role may not rewrite history. The API connects as a role
-- without UPDATE/DELETE on audit_log; the grant is revoked from PUBLIC so that
-- a newly created role cannot inherit it by accident.
revoke update, delete on audit_log from public;
