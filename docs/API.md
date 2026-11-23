# API reference (v1)

Base: `/api/v1`. JSON only. Session cookie `attend_session` (HttpOnly) plus `attend_csrf` for unsafe methods.
Errors are RFC 9457 problem details: `{ type, title, status, code, detail, instance, requestId?, errors? }`.

## Auth

| Method | Path | Who | Notes |
| --- | --- | --- | --- |
| POST | `/auth/signin` | all | `{ email, password, totp? }` → sets cookies. Staff without TOTP get `mfaSetupRequired`. |
| POST | `/auth/totp/setup` | staff | Returns base32 secret + otpauth URL (once). |
| POST | `/auth/totp/confirm` | staff | `{ code }` promotes the session to MFA-satisfied. |
| GET | `/auth/me` | all | Identity, roles, permissions, student/staff blocks. |
| POST | `/auth/password` | all | Revokes every other session. |
| POST | `/auth/signout` | all | Revokes the current session. |

## Devices

| Method | Path | Who | Notes |
| --- | --- | --- | --- |
| POST | `/devices/register/options` | student | WebAuthn creation options + `challengeId`. |
| POST | `/devices/register` | student | `{ challengeId, credential, fingerprint }`. One active device per student. |
| GET | `/devices/me` | student | Bound devices and any pending reset request. |
| POST | `/devices/reset-request` | student | `{ reason }`; one pending at a time. |

## Biometrics

| Method | Path | Who | Notes |
| --- | --- | --- | --- |
| POST | `/biometrics/consent` | student | `{ noticeVersion, granted }`; versioned, audited. |
| POST | `/biometrics/enroll` | student | `{ frames[1..5], challenge }`; duplicate-face search blocks enrolment. |
| GET | `/biometrics/status` | student | Consent, template and device summary. |
| DELETE | `/biometrics` | student | Withdraw consent; purge scheduled after the grace period. |
| GET | `/me/data-export` | student | Data-subject access download (no embeddings). |

## Check-in

Both endpoints require `Idempotency-Key` and are rate limited per student per minute.

| Method | Path | Who | Notes |
| --- | --- | --- | --- |
| POST | `/checkin/claim` | student | `{ token, credential, fingerprint, location? }` → `{ claimId, expiresAt, challenge, session }` |
| POST | `/checkin/verify` | student | `{ claimId, frames }` → `{ status, checkedInAt, courseCode, message }` |
| GET | `/checkin/eligibility` | student | What is still missing before check-in. |

Check-in error codes, in the order they are evaluated:
`QR_INVALID`, `QR_SIGNATURE_INVALID`, `QR_EXPIRED`, `SESSION_CANCELLED`, `SESSION_CLOSED`, `WINDOW_NOT_OPEN`,
`WINDOW_CLOSED`, `NOT_ENROLLED`, `CONSENT_REQUIRED`, `FACE_NOT_ENROLLED`, `DEVICE_NOT_REGISTERED`, `DEVICE_REVOKED`,
`DEVICE_FINGERPRINT_MISMATCH`, `WEBAUTHN_FAILED`, `IP_NOT_ALLOWED`, `GEOFENCE_VIOLATION`, `ALREADY_CHECKED_IN`,
`DEVICE_ALREADY_USED`, `CLAIM_INVALID`, `CLAIM_EXPIRED`, `CLAIM_ALREADY_USED`, `LIVENESS_FAILED`, `FACE_QUALITY_LOW`,
`DUPLICATE_FACE`, `FACE_MISMATCH`, `FACE_SERVICE_UNAVAILABLE`.

## Sessions (lecturer)

| Method | Path | Who | Notes |
| --- | --- | --- | --- |
| GET | `/lecturer/today` | lecturer | Today's sessions with counts. |
| GET | `/lecturer/offerings` | lecturer | Courses they teach. |
| POST | `/sessions/:id/start` | lecturer | Opens the window, mints the per-session QR secret. |
| POST | `/sessions/:id/close` | lecturer | Closes, destroys the secret, sweeps absences. |
| POST | `/sessions/:id/extend` | lecturer | `{ minutes, reason }`; once per session. |
| GET | `/sessions/:id/qr/stream` | lecturer, TA | SSE: `qr` events with signed tokens. |
| GET | `/sessions/:id/roster` | lecturer, TA | Snapshot of the roster. |
| GET | `/sessions/:id/roster/stream` | lecturer, TA | SSE: `roster` events on every change. |
| GET | `/lecturer/offerings/:offeringId/history` | lecturer | Past sessions with counts. |

## Attendance and appeals

| Method | Path | Who | Notes |
| --- | --- | --- | --- |
| PATCH | `/attendance/:recordId` | lecturer, admin | `{ status, reason }`; reason required. |
| PATCH | `/sessions/:id/students/:studentId` | lecturer, admin | Same, addressed by student (live roster). |
| POST | `/sessions/:id/bulk-excuse` | lecturer, admin | `{ studentIds[], reason }`. |
| GET | `/me/attendance` | student | Records plus per-course percentages. |
| POST | `/appeals` | student | `{ recordId, message }`; one open appeal per record. |
| GET | `/appeals/mine` | student | Own appeals. |
| GET | `/appeals` | admin, lecturer | Filter by `offeringId`, `status`. |
| PATCH | `/appeals/:id` | admin, lecturer | `{ decision, note }`; accepting marks the record `present_manual`. |

## Reports

`?format=json|csv|pdf|xlsx`.

| Method | Path | Who |
| --- | --- | --- |
| GET | `/reports/course/:offeringId` | lecturer, admin, auditor |
| GET | `/reports/session/:sessionId` | lecturer, admin, auditor |
| GET | `/reports/range?from&to` | admin, auditor |

## Admin

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/admin/dashboard` | Today and term rates, by faculty, face-service health, pending counts |
| GET/POST/PATCH/DELETE | `/admin/faculties`, `departments`, `programmes`, `courses`, `offerings`, `terms`, `rooms` | Master data, soft delete |
| GET/POST | `/admin/timetable` | List recurring slots with course/room labels; create a slot |
| POST | `/admin/sessions/generate` | Generate a term of sessions; `dryRun` supported |
| POST | `/admin/enrollments` | Bulk enrol by student id |
| POST | `/admin/enrollments/import` | Bulk enrol by student number with a validation preview (`dryRun`) |
| PATCH | `/admin/users/:id/status` | Suspend or reactivate |
| GET | `/admin/people` | Students and staff with search |
| GET | `/admin/review`, POST `/admin/review/:id/resolve` | Flagged attempts: confirm, reject, escalate |
| GET | `/admin/devices`, POST `/admin/devices/:id/revoke`, POST `/admin/device-resets/:id` | Device management |
| GET | `/admin/biometrics`, POST `/admin/biometrics/:studentId/purge` | Two-admin purge |
| GET/PATCH | `/admin/settings`, GET `/admin/settings/:key/history` | Versioned policy |
| GET/POST | `/admin/roles`, POST `/admin/role-assignments` | Custom roles and scoping |
| GET | `/admin/audit` | Search by actor, entity, action, date |
| GET/POST | `/admin/integrations`, `/integrations/api-keys`, `/integrations/webhooks` | SIS/LMS integration |

## Webhooks

`attendance.recorded` and `session.closed` are the event names held on each webhook; delivery is queued with an HMAC
signature over the raw body. (Delivery worker: see README "not built".)

## Rate limits

Global 300 requests/minute per user or IP. Sign-in: 10 attempts per account per IP per 5 minutes. Check-in: the
`checkinRateLimitPerMinute` setting (default 10). Face verification attempts: 20 per student per minute.
