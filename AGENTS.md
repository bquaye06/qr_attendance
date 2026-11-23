# AGENTS.md — working rules for this repository

This file is the standing brief for anyone (human or agent) changing the code. It is the short version of the
institution's requirements; the long version is the system prompt in `docs/DECISIONS.md` history.

## Mission

Record that a specific enrolled student was physically present in a specific class session, and make that record
trustworthy. A record is valid only when three proofs agree: presence (live rotating QR), identity (face + liveness),
device (bound device, one student per session).

## Non-negotiables

1. Never weaken an integrity rule to make a test pass or a demo work — uniqueness, expiry, liveness, scope checks.
2. Never log or persist face images, embeddings in logs, tokens or secrets. Frames exist in memory only.
3. The API is the single source of truth. Next.js server components call the API; they never write to Postgres.
4. Business rules live in `apps/api/src/domain/*` as pure, tested functions. Route handlers orchestrate I/O.
5. Every schema change is a new numbered migration. Never edit an applied migration (the runner enforces a checksum).
6. Every feature ships end to end: schema, API, validation, UI, permissions, audit, tests. If you cannot finish it,
   say exactly what is missing instead of stubbing it.
7. Permissions are enforced in the API on every request. Hiding a button in the UI is cosmetic.
8. Prefer boring, well-supported libraries. Justify any new dependency in one line in `docs/DECISIONS.md`.

## Conventions

- TypeScript strict; no `any` without a comment saying why. Relative imports use explicit `.ts`/`.tsx` extensions so
  Node's type-stripping runtime, webpack and tsc all agree.
- Python 3.12 with type hints, `ruff` and `mypy --strict` clean.
- Conventional commits. CI blocks merge on lint, typecheck, unit, integration, python and e2e failures.
- Errors: throw `ApiError(code, detail)`; the error hook renders RFC 9457 problem details.
- Money, if ever added: `numeric(14,2)`.

## Where things live

| Concern | Path |
| --- | --- |
| Decision engine (claim + verify) | `apps/api/src/domain/decide.ts` |
| QR token format and verification | `apps/api/src/domain/qr-token.ts` |
| WebAuthn verification | `apps/api/src/domain/webauthn.ts` |
| Risk scoring weights | `apps/api/src/domain/risk.ts` |
| RBAC scope rules | `apps/api/src/domain/rbac.ts` |
| Session windows, absence sweep | `apps/api/src/domain/session.ts` |
| Report matrix | `apps/api/src/domain/report.ts` |
| Schema (authoritative DDL) | `packages/db/migrations/*.sql` |
| Settings contract and defaults | `packages/contracts/src/settings.ts` |
| Error codes | `packages/contracts/src/errors.ts` |

## Before you claim something works

Run the relevant suite and paste the result. The zero-dependency suite covers the security-critical rules:

```bash
node --experimental-strip-types --test --experimental-test-isolation=none "apps/api/src/domain/*.test.ts"
```

## When requirements are unclear

Pick the safest reasonable default, write it in `docs/DECISIONS.md`, and keep going. Stop and ask only for decisions
that cannot be undone — deleting biometric data, changing the retention policy, or changing the lawful basis.
