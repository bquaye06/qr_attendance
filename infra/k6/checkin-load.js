import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';

/**
 * Load profile for one session: read path + claim path.
 *
 *   k6 run infra/k6/checkin-load.js \
 *     -e BASE_URL=http://localhost:4000 \
 *     -e SESSION_ID=<uuid> \
 *     -e COOKIE='attend_session=...; attend_csrf=...' \
 *     -e CSRF='<token>' \
 *     -e TOKEN_PACK=infra/k6/tokens.json
 *
 * What this measures, and what it deliberately does not:
 *
 *   measured   the lecturer read path (roster JSON) and the claim stage of
 *              check-in (QR verification, enrollment/consent/device/WebAuthn
 *              checks, duplicate checks, claim insert) under load;
 *   not        the face stage. A faithful 500-check-in run needs 500 distinct
 *              consented faces against a real face service, because a stubbed
 *              embedding either fails the similarity threshold or trips the
 *              duplicate-face rule. That measurement belongs in a consented
 *              staging run; see docs/RUNBOOK.md.
 *
 * Assertions cannot be produced inside k6: they are ECDSA signatures. `tokens.json`
 * is produced by `infra/load/prepare.mjs`, which registers real passkeys for the
 * seeded cohort and pre-signs one assertion per student for the token it also
 * mints. That keeps every integrity rule switched on during the test.
 *
 * Targets (from the brief): claim p95 < 300 ms, zero duplicate records.
 */
const BASE_URL = __ENV.BASE_URL || 'http://localhost:4000';
const SESSION_ID = __ENV.SESSION_ID;
const COOKIE = __ENV.COOKIE;
const CSRF = __ENV.CSRF;
const TOKEN = __ENV.TOKEN;

const claimLatency = new Trend('claim_latency', true);
const rosterLatency = new Trend('roster_latency', true);
const claimRejected = new Rate('claim_rejected');

// `open()` must run in the init context with a literal path, so the pack is read
// once per VU from ./tokens.json (produced by infra/load/prepare.mjs --out).
let pack = [];
try {
  pack = JSON.parse(open('./tokens.json'));
} catch {
  pack = [];
}

export const options = {
  scenarios: {
    // 500 check-ins in two minutes, spread over the cohort.
    claims: {
      executor: 'shared-iterations',
      exec: 'claim',
      vus: 50,
      iterations: 500,
      maxDuration: '2m',
    },
    // Lecturers and the projector reading during the same window.
    roster: {
      executor: 'constant-vus',
      exec: 'readRoster',
      vus: 20,
      duration: '2m',
    },
  },
  thresholds: {
    claim_latency: ['p(95)<300'],
    roster_latency: ['p(95)<400'],
    http_req_failed: ['rate<0.01'],
  },
};

function headers() {
  return {
    cookie: COOKIE,
    'x-csrf-token': CSRF,
    'content-type': 'application/json',
  };
}

export function readRoster() {
  const response = http.get(`${BASE_URL}/api/v1/sessions/${SESSION_ID}/roster`, { headers: headers() });
  rosterLatency.add(response.timings.duration);
  check(response, { 'roster 200': (r) => r.status === 200 });
  sleep(1);
}

export function claim() {
  // Each iteration consumes one pre-signed student; the pack is cycled, so a
  // student who has already checked in returns ALREADY_CHECKED_IN, which is the
  // correct behaviour and is counted rather than treated as a failure.
  if (pack.length === 0) {
    throw new Error('tokens.json is empty: run infra/load/prepare.mjs first');
  }
  const entry = pack[__ITER % pack.length];

  const payload = JSON.stringify({
    token: TOKEN || entry.token,
    credential: entry.assertion,
    fingerprint: entry.fingerprint,
  });

  const response = http.post(`${BASE_URL}/api/v1/checkin/claim`, payload, {
    headers: { ...headers(), 'idempotency-key': `k6-${__VU}-${__ITER}` },
  });

  claimLatency.add(response.timings.duration);
  const accepted = response.status === 200;
  claimRejected.add(!accepted);

  check(response, {
    'claim is 200 or a known integrity rejection': (r) =>
      r.status === 200 || [409, 403, 400, 429].includes(r.status),
  });
}
