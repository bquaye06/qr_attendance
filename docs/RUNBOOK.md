# Runbook

## Deploy

1. Provision Postgres with the `vector` extension (Neon branch per environment) and Redis.
2. Set every variable in `.env.example`. Two are secrets that must come from a managed store, never from the repo:
   `MASTER_KEY` (32 bytes, base64) and `FACE_SERVICE_SECRET`. `FINGERPRINT_PEPPER` is a third.
3. Run migrations with the **direct** connection string:
   `DATABASE_URL_MIGRATE=… node --experimental-strip-types packages/db/src/migrate.ts`
4. Deploy `apps/api`, `apps/api` worker (`src/jobs/worker.ts`), `apps/web`, `services/face`.
5. Put the face service on a private network. Only the API should reach it.
6. Fill in `services/face/models.lock` with real SHA-256 digests and mount the weights read-only.

## Health checks

| Endpoint | Expect |
| --- | --- |
| `GET /healthz` (API) | `{"status":"ok"}` — process is up |
| `GET /readyz` (API) | 200 when DB reachable and models loaded; 503 otherwise |
| `GET /healthz` (face) | 200 always |
| `GET /readyz` (face) | 200 only when models are loaded |
| `GET /metrics` (face) | Prometheus counters/histograms |

`/readyz` returning 503 with `face: "down"` is expected when weights are missing; check-in falls back to manual.

## Routine jobs

The worker runs every 30 s under a Postgres advisory lock:

- `absence_sweep` — closes open sessions whose window ended and marks missing students absent.
- `retention_purge` — deletes templates whose grace period expired; clears evidence references past retention.

Every run writes a `job_runs` row. Alert when `status = 'failed'` for the same job three runs in a row.

## Common incidents

**Students cannot check in, all get `LIVENESS_FAILED`.**
Check the face service `/readyz`, then `models.lock` checksums, then room lighting. If the anti-spoof model is
missing the service returns 0.5 and everything fails closed by design. Manual path still works; tell lecturers.

**`FACE_SERVICE_UNAVAILABLE` spikes.**
Look at the face service p95 and CPU. The API timeout is `FACE_SERVICE_TIMEOUT_MS` (default 6 s). Do not raise it past
the check-in latency target; scale the face service instead.

**A device is already used by another student.**
Expected behaviour: one device, one student, per session. If a shared phone is legitimate, the department admin must
approve a device reset and the lecturer marks attendance manually for that session.

**Wrong student marked present.**
Confirm or reject the item in the review queue. `confirm` keeps the record as `present_manual`; `reject` sets it to
`absent`. Both write an audit row with your reason.

**Student withdrew consent but the template is still there.**
Expected during the grace period (default 30 days, `templatePurgeGraceDays`). To purge early, use the two-admin purge
flow (`POST /api/v1/admin/biometrics/:studentId/purge` twice, by two different admins).

**Suspected template leak.**
Do not delete rows by hand: run the purge flow (audited), rotate `MASTER_KEY` (re-encrypts QR secrets and TOTP seeds),
rotate `FACE_SERVICE_SECRET`, invalidate sessions by truncating `auth_sessions`, and follow the DPO's breach process.

## Key rotation

| Key | Method |
| --- | --- |
| `MASTER_KEY` | Re-encrypt `class_sessions.qr_secret_enc` and `users.totp_secret_enc` with the new key, swap, restart. Sessions are also invalidated (QR secrets are per-session). |
| `FACE_SERVICE_SECRET` | Deploy API and face service together; tokens are valid for 60 s, so a rolling restart causes at most a minute of 401s. |
| `FINGERPRINT_PEPPER` | Rotating it invalidates every device fingerprint; students must re-register. Treat as a device-reset event. |
| Database credentials | Neon supports overlapping credentials; rotate, restart, then revoke the old one. |

## Restore drill (quarterly, documented)

1. Restore the latest Neon point-in-time backup into a scratch branch.
2. Point a staging API at it and run `pnpm --filter @attend/db migrate` — it must report "up to date" (no pending migrations).
3. Verify: `select count(*) from attendance_records`, `select count(*) from biometrics.face_templates`, and the last
   `audit_log` timestamp. Write the numbers and the restore time in the operations log.
4. Delete the scratch branch.

## Scaling checklist

Before adding a second API instance: set `REDIS_URL` (SSE, rate limits and idempotency are per-process without it).
Before adding a second worker: nothing to do; advisory locks already serialise jobs.

## Verification commands for a release

```bash
node --experimental-strip-types --test --experimental-test-isolation=none "apps/api/src/domain/*.test.ts"
pnpm --filter @attend/api test
pnpm --filter @attend/web e2e
(cd services/face && pytest tests -q)
```
