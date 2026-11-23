# End-to-end tests

These run against a real stack (web + api + face + Postgres). A mocked API would
prove nothing here: the whole point is that three independent proofs agree.

## Run

```bash
# stack up first (docker compose, or pnpm dev + uvicorn)
pnpm exec playwright install --with-deps chromium
BASE_URL=http://localhost:3000 pnpm --filter @attend/web e2e
```

Specs:

| File | Needs | Writes data |
| --- | --- | --- |
| `auth.spec.ts` | seeded database | no |
| `student-gating.spec.ts` | seeded database | no |
| `checkin-journey.spec.ts` | seeded database, face service with models, `E2E_FULL=1` | **yes** |

`checkin-journey.spec.ts` binds a device to `student001`, enrols a face template
and starts a session for `lecturer1`. Run it against a disposable database:

```bash
E2E_FULL=1 BASE_URL=http://localhost:3000 pnpm --filter @attend/web e2e checkin-journey
```

## How the ceremony is real

- **Passkey**: a CDP virtual authenticator (`WebAuthn.enable` +
  `addVirtualAuthenticator`) so registration and assertion signatures are
  produced and verified by the API's own WebAuthn code. No test-only bypass
  exists in the API.
- **Camera**: Chrome's fake media device
  (`--use-fake-device-for-media-stream`), so the face service receives genuine
  frames through the same path a phone would use.
- **Staff MFA**: the test reads the base32 secret the setup page displays and
  computes the TOTP itself. The MFA rule is exercised, not disabled.

## Why the journey spec is gated

It mutates seed state (device, template, session). Keeping it behind `E2E_FULL`
means the default CI run is repeatable, while the acceptance criterion is still
executable on demand.
