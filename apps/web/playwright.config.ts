import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests run against a real stack (web + api + face + Postgres), not
 * mocks: the point is to prove the three proofs agree, and a mocked API would
 * prove nothing.
 *
 * The stack is expected to be up already (docker compose, or `pnpm dev`):
 *   BASE_URL=http://localhost:3000 pnpm --filter @attend/web e2e
 *
 * Camera and geolocation are faked per-test; `checkin.spec.ts` additionally
 * needs E2E_FULL=1 because it writes seed data (a bound device and a face
 * template) and should only run against a disposable database.
 */
const baseURL = process.env['BASE_URL'] ?? 'http://localhost:3000';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] ? 1 : 0,
  workers: 1,
  reporter: process.env['CI'] ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL,
    trace: 'on-first-retry',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    permissions: ['camera', 'geolocation'],
    geolocation: { latitude: 5.6505, longitude: -0.187 },
    launchOptions: {
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream=fps=30',
      ],
    },
  },
  projects: [
    { name: 'desktop-chrome', use: { ...devices['Desktop Chrome'] } },
    // The student journey is mobile-first and is designed one-handed.
    { name: 'mobile-safari', use: { ...devices['iPhone 14'] } },
  ],
});
