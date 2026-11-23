# Architecture

## Shape

```
Student PWA ─┐
Lecturer ────┼─► apps/api (Fastify) ──► services/face (internal only)
Console ─────┘         │
                       ├─► Postgres (Neon) + pgvector, `biometrics` schema
                       └─► Redis (optional): nonces, rate limits, idempotency, SSE fan-out
```

Rules that hold everywhere:

- The API is the single source of truth. Next.js server components call it and never touch the database.
- The browser never calls the face service. The face service never sees the database, student names, or attendance decisions.
- Permissions are checked in the API on every request. Hiding a button is cosmetic only.
- Business rules live in `apps/api/src/domain/*` as pure functions with tests. Route handlers wire I/O; they do not decide.

## Check-in, end to end

```
Lecturer starts session ──► per-session HMAC secret generated, encrypted, stored on class_sessions
                                   │
GET /sessions/:id/qr/stream (SSE) ─┴─► one signed token per rotation interval
                                        token = v1.<payload>.<hmac>
                                        payload = { sid, nonce, iat, exp }

Student scans ──► POST /checkin/claim { token, webauthn assertion, fingerprint, geo? }
                  1. verify token signature + expiry with that session's secret
                  2. session open and inside the check-in window
                  3. enrolled, consent on file, template on file
                  4. device active, fingerprint matches
                  5. WebAuthn assertion over sha256(token) (binds sign-in to this exact QR)
                  6. IP allowlist if enabled, geofence if enabled
                  7. not already checked in; device not used by anyone else this session
                  → checkin_claims row (single use, TTL 60 s) + liveness challenge

Student faces camera ──► POST /checkin/verify { claimId, frames }
                  1. claim owned by this student, unconsumed, unexpired
                  2. face service: quality, liveness, active challenge, 512-d embedding
                  3. cosine similarity vs own template ≥ similarityThreshold
                  4. same face not already checked in under another account
                  5. risk score from all signals
                  6. decision: present | late | present_flagged | reject
                  7. one transaction: consume claim, insert record, log attempt, queue review
                  8. push roster event over SSE
```

Why two steps: the QR scan is cheap and frequently attempted, the face check is expensive. Nothing is written to
`attendance_records` until both pass, and a failed face check leaves an `attendance_attempts` row for the audit and
review queue.

## Data model highlights

| Concern | Mechanism |
| --- | --- |
| One record per student per session | `UNIQUE(session_id, student_id)` |
| One device, one student, per session | partial `UNIQUE(session_id, device_id) WHERE device_id IS NOT NULL` |
| One active device per student | partial `UNIQUE(student_id) WHERE status = 'active'` |
| One active template per student per model | partial `UNIQUE(student_id, model_version) WHERE is_active` |
| No rewriting history | `audit_log` is append-only; the app role has no UPDATE/DELETE grant |
| Duplicate enrolment only | HNSW index on `biometrics.face_templates.embedding` (used at enrolment, never at check-in) |
| Corrections are additive | `attendance_overrides` keeps the old status, reason and actor |

Biometric isolation: `biometrics.face_templates` lives in its own schema. The API opens a second pool
(`BIOMETRICS_DATABASE_URL`) only on the enrolment and check-in code paths. In local development a single role is used
and the isolation is a production requirement (see DECISIONS D-004).

## Enforced-in-two-places rules

Threat | Control
--- | ---
Signing in for a friend | face must match the account owner; liveness blocks photos and screens
Using your phone to check in a friend | `UNIQUE(session_id, device_id)` — a race cannot get around a constraint
Checking in twice | `UNIQUE(session_id, student_id)` + `Idempotency-Key` per request
Sharing the QR off-site | token rotates every 10 s, expires in 15 s, single-use nonce, optional geofence/IP allowlist
Replaying a request | assertion is bound to the token (single-use nonce) + server-issued liveness challenge
Printed photo or screen replay | passive anti-spoofing + random active challenge + quality gates
One face on two accounts | enrolment compares against every template before storing
Insider edits | reason required, override rows, append-only audit, no delete path
Rooted phone or emulator | flagged via fingerprint/attestation signals, surfaced in review — not blocked by default

## Scoring and thresholds

`computeRiskScore` is a pure function with fixed weights (liveness weakness, thin similarity margin, ambiguity against
other templates, geofence distance, fingerprint mismatch, freshly bound device, stale token, recent failures, failed
active challenge). Above `riskFlagThreshold` the record is stored as `present_flagged` and queued for review instead of
being rejected. All thresholds come from `system_settings`, so changing one in the console changes the next check-in
with no redeploy and no code change.

## Failure behaviour

- Face service down → `FACE_SERVICE_UNAVAILABLE` (503), never `FACE_MISMATCH`. The manual path still works.
- Redis absent → single-instance fallback; SSE stays local.
- Server restarts mid-claim → claims are rows with expiry, so a stale claim simply expires.
- Session closed or window ended → the absence sweep marks everyone without a record absent; existing records are never touched, so a correction survives.
