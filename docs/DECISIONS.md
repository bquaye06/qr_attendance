# Decision log

Every deviation from the brief, and every default chosen in place of a `[bracket]`, is recorded here. Newest last.

## D-001 Auth: password + TOTP in the API, SSO deferred

The brief allows "Auth.js or Better Auth … [if SSO is available], else email + password + TOTP for staff".
The institution has no SSO endpoint yet, so staff use password (scrypt, N=16384) plus RFC 6238 TOTP, and sessions
are issued by the API itself: opaque 32-byte token, SHA-256 hashed at rest, HttpOnly/SameSite=Lax cookie,
per-role idle timeout (admin 30 min), absolute lifetime 12 h for staff and 7 days for students.

Consequence: adding SAML/OIDC later means adding an identity-provider callback that mints the same session rows;
nothing else changes. `users.sso_subject` already exists for that.

## D-002 WebAuthn is implemented on node:crypto, not a library

The only WebAuthn operations needed are the ones our own PWA performs: parse the attestation object for the
credential public key, and verify assertions (ES256/RS256/EdDSA) against it. That is ~400 lines of CBOR + COSE
parsing and `crypto.verify`. It is covered by tests that generate real P-256 keys and sign real assertions,
including negative cases (wrong key, replayed counter, wrong origin, UV not satisfied).

Attestation statements are not trusted (`attestation: none`), which is what the brief asks for: platform
authenticator, no attestation chain.

## D-003 The WebAuthn challenge is the QR token

The brief says the assertion must be "bound to the claimId". Creating a separate challenge would need an extra
round trip before the scan. Instead the client signs `sha256(qrToken)`; the server recomputes it from the token it
already has. Because each QR token carries a single-use nonce and a short expiry, replaying a captured assertion
against a later token fails. This is implemented and tested.

## D-004 Face templates are vectors, not application-level encrypted blobs

The brief says "store the averaged embedding, encrypted" *and* asks for an HNSW index over
`face_templates.embedding` for duplicate-enrolment search. A pgvector column cannot also be an application-level
ciphertext, because Postgres must read the vector to index it.

Chosen: keep `vector(512)` and rely on (a) a separate `biometrics` schema, (b) a dedicated DB role, (c) at-rest
encryption from the managed database (Neon), (d) HNSW used *only* for enrolment duplicate search — check-in compares
against one known template. If your DPO requires column-level encryption instead, the duplicate search has to move
to the face service and this needs revisiting; that is a deliberate, reversible trade written down here rather than
silently dropped.

## D-005 Duplicate-face threshold is separate from the check-in threshold

One threshold cannot serve both jobs: 0.45 similarity is right for "is this the same person", too loose for "is this
face already enrolled to someone else". Default `duplicateFaceThreshold = 0.60`, editable in the console.

## D-006 Redis is optional; the in-process fallback is single-instance only

`REDIS_URL` powers idempotency keys, rate-limit counters, one-time nonces and SSE fan-out. Without it the API uses an
in-memory store and works correctly on one instance; with more than one instance, SSE and rate limits are per-process.
Recorded in RUNBOOK: set `REDIS_URL` before scaling out.

## D-007 Jobs are a Postgres advisory-lock loop, not BullMQ

The brief allows "BullGQ (or a Neon-backed queue)". The worker is a 30-second loop guarded by
`pg_try_advisory_lock`, so a second worker instance is harmless and no extra service is needed. Every run is recorded
in `job_runs`. Swap in BullMQ when throughput or retries justify it.

## D-008 Testcontainers replaced by a CI Postgres service

Integration tests use the `DATABASE_URL` the environment provides; CI starts `pgvector/pgvector:pg16` as a service
container. Same isolation, no Docker-in-CI requirement, and it keeps the local `docker compose up` path identical.

## D-009 DDL is SQL; Drizzle is the typed query layer

`packages/db/migrations/*.sql` is the source of truth and the runner refuses to start if an applied migration's
checksum changed. `packages/db/src/schema.ts` mirrors it for typed queries. `drizzle-kit generate` exists for diffing,
but its output must be reviewed into a numbered migration.

## D-010 Console coverage

Every console area now has a page: dashboard, review queue, academic structure (faculties, departments, programmes,
courses, terms, rooms, offerings), people (search, suspend/reactivate), timetable (slots + session generation with a
dry run), enrolment (bulk import by student number with a validation preview), devices (revoke, approve/reject resets),
biometrics (status + two-admin purge), roles, settings, integrations (API keys, webhooks), audit log and system health.

Still API-only: creating people (and the people CSV import), assigning roles to a user, and editing an existing row's
individual fields from the UI (the endpoints exist and are audited; the screens are a follow-up).

## D-014 Browser and load testing strategy

- **Browser tests** run against a real stack. The passkey ceremony uses a CDP virtual authenticator and the camera
  uses Chrome's fake media device, so the API's WebAuthn and the face service are exercised, not bypassed. Staff MFA is
  completed by the test computing the TOTP from the secret the setup page displays.
- **The full three-proof journey is gated behind `E2E_FULL=1`** because it writes seed state (device, template,
  session) and needs model weights in the face service. The default CI run covers the seeded flows only.
- **Load testing** splits the pipeline honestly: `infra/load/prepare.mjs` registers real passkeys for the cohort and
  pre-signs assertions (k6 cannot sign), and `infra/k6/checkin-load.js` measures the claim stage and the lecturer read
  path. The face stage cannot be load-tested with a stub — a stubbed embedding either fails the similarity threshold or
  trips the duplicate-face rule — so a faithful 500-check-in measurement needs 500 distinct consented faces against a
  real face service, run on staging. Recorded in RUNBOOK.

## D-011 Institution defaults

`[Institution]` = Demo University (`DEMO`), time zone `Africa/Accra` (Ghana), currency not used.
Attendance threshold 75 %, check-in window opens at start and closes 15 minutes later, late after 10 minutes,
QR rotates every 10 s and is valid 15 s, claim lifetime 60 s, geofence off by default with a 100 m default radius,
one device per student, three failures flag an attempt, risk flag threshold 70, evidence retention 30 days,
biometric purge grace 30 days, admin idle 30 minutes.

## D-012 npm is accepted as a fallback installer

`pnpm` is the declared package manager (`pnpm-workspace.yaml`, `packageManager` field) and CI uses it. The repository
also declares `workspaces` in the root `package.json` so `npm install` works on machines where pnpm's worker threads
fail (this build machine). Internal dependencies use `"*"` rather than `workspace:*` so both installers resolve them;
pnpm still links the local packages.

## D-013 Anonymous diagnostic header removed

`X-Powered-By` and framework fingerprints are stripped; error responses carry a request id and a stable code only.
