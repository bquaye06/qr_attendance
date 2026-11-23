# Attend — biometric QR attendance platform

Three proofs must agree before a student is marked present:

1. **Presence** — the student scanned a short-lived QR code shown live in the room.
2. **Identity** — a live face capture, after a liveness check, matches the student's enrolled template.
3. **Device** — the scan came from the student's own bound device, and that device has not checked in anyone else for this session.

Three portals share one API and one database: a mobile-first student PWA, a lecturer portal with a projector screen, and a management console.

---

## Repository layout

```
apps/
  api/            Fastify API: auth, sessions, check-in, reports, jobs, SSE
  web/            Next.js 15 App Router: (student) (lecturer) (admin) route groups
services/
  face/           FastAPI + ONNX Runtime: detection, quality, liveness, embeddings
packages/
  db/             Drizzle schema mirror + SQL migrations (source of truth) + seed
  contracts/      Zod schemas, error codes, permissions, settings — shared web/api
  ui/             Shared components (shadcn-style, no runtime dependency on a UI kit)
  config/         tsconfig presets, eslint/tailwind presets
infra/            docker-compose, Dockerfiles
docs/             ARCHITECTURE, DECISIONS, DPIA, RUNBOOK, API
.github/          CI: lint, typecheck, unit, integration, python, e2e
```

## Quick start

Prerequisites: Node 22+, pnpm 9 (`corepack enable pnpm`), Docker.

```bash
cp .env.example .env          # then set MASTER_KEY, FINGERPRINT_PEPPER, FACE_SERVICE_SECRET
docker compose -f infra/docker-compose.yml up --build
```

That brings up Postgres 16 with pgvector, Redis, the API, the worker, the face service and the web app, and runs migrations plus the seed on first start.

Without Docker:

```bash
pnpm install
pnpm --filter @attend/db migrate          # needs DATABASE_URL_MIGRATE
pnpm --filter @attend/db seed
pnpm dev                                   # api :4000, web :3000
cd services/face && uvicorn app.main:app --port 8000
```

The face service needs model weights in `services/face/models` (see `models.lock` and `docs/DECISIONS.md`). Without them it starts, reports `degraded`, and refuses to pretend it verified anything — the manual check-in path still works.

## Seed accounts

All seed passwords are `SeedPassw0rd!`.

| Role | Email | Notes |
| --- | --- | --- |
| Super admin | `admin@seed.attend.local` | MFA setup on first sign-in |
| Lecturer | `lecturer1@seed.attend.local` | MFA setup on first sign-in |
| Student | `student001@seed.attend.local` | 120 seeded students, `studentNNN@seed.attend.local` |

Seed data is marked: institution `DEMO`, emails under `seed.attend.local`, and face templates use model version `seed-synthetic-512` (random vectors, not faces).

## Tests

```bash
pnpm test               # vitest across packages (needs pnpm install)
pnpm test:domain        # business-rule tests that need no dependencies (Node's runner)
pnpm check:structure    # every relative/@/ import resolves, every named import exists (no install needed)
cd services/face && pytest tests -q
pnpm --filter @attend/web e2e    # Playwright against a running stack (see apps/web/e2e/README.md)
```

`pnpm test:domain` runs with nothing installed: it covers the QR token, WebAuthn verification, the decision engine, risk scoring, RBAC scope rules, session windows, retention, secrets and the report matrix.

## What is built, and what is not

Built end to end (schema → API → UI → permissions → audit → tests):

- Check-in: rotating signed QR, claim window, WebAuthn assertion bound to the QR token, face verification, risk scoring, atomic write, live roster push.
- Integrity rules: `UNIQUE(session_id, student_id)`, partial `UNIQUE(session_id, device_id)`, one active device per student, one active template per student/model, append-only audit log.
- Sessions: start/close, window extension (once), absence sweep inline and as a job.
- Devices: registration, fingerprint binding, reset requests.
- Biometrics: versioned consent, enrolment with duplicate-face search, withdrawal and grace-period purge.
- Lecturer portal: today, live session with rotating QR and live roster over SSE, corrections with a required reason.
- Student app: setup (consent → device → face), check-in, history with per-course percentages, appeals.
- Console: dashboard, review queue, academic structure, people, timetable and session generation, enrolment import,
  devices, biometrics with two-admin purge, roles, settings with version history, integrations, audit log, health.
- Reports: course matrix, session, date range; CSV, XLSX and PDF.
- Jobs: absence sweep and retention purge with advisory locks.
- Face service: decode/quality/liveness/embedding pipeline, service-token auth, metrics, evaluation script, tests.
- Tests: 115 business-rule tests (run with nothing installed), Playwright specs against a real stack, and a k6 claim/read
  load profile with a Node harness that produces real WebAuthn assertions.

Not built in this pass:

- SAML/OIDC single sign-on. Staff use password + TOTP; see `docs/DECISIONS.md` D-001.
- Creating people and assigning roles from the UI (API endpoints exist and are audited), and the people CSV import with
  validation preview.
- Email notifications (at-risk students, scheduled export delivery) and webhook delivery retries.
- Real model weights: `models.lock` is a template until the digests are filled in, which is also why the full
  three-proof Playwright journey is gated behind `E2E_FULL=1`.

`docs/DECISIONS.md` records every deliberate deviation and default.

## Security posture

- Face images are never stored: the service returns scores and a 512-d embedding and wipes buffers; the API stores one averaged, normalised embedding per student.
- Biometric tables live in a separate `biometrics` schema with its own role (`BIOMETRICS_DATABASE_URL`).
- Sessions are opaque cookies, HttpOnly, SameSite=Lax, hashed at rest, with per-role idle timeouts and CSRF double-submit tokens.
- Every admin action, override, settings change, biometric action and export writes an append-only audit row; the app role has no UPDATE/DELETE grant on `audit_log`.
- Errors are RFC 9457 problem details with stable codes; the API never leaks whether a session, student or device exists to an unauthorised caller.
