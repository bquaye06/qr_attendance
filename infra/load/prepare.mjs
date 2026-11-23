#!/usr/bin/env node
/**
 * Prepares a claim-load pack for infra/k6/checkin-load.js.
 *
 * For each seeded student it:
 *   1. signs in (email/password from the seed),
 *   2. accepts the biometric notice,
 *   3. generates an ES256 passkey and registers it as the bound device,
 *   4. signs one WebAuthn assertion over sha256(qrToken),
 *   5. writes { studentNumber, fingerprint, assertion } to tokens.json.
 *
 * The assertions are bound to one specific QR token because that is what the API
 * verifies — the load test therefore uses a token minted for a single session and
 * a single rotation window. That is the honest shape of the protocol.
 *
 * Usage:
 *   node infra/load/prepare.mjs --base http://localhost:4000 --session <uuid> --out infra/k6/tokens.json
 *
 * Requires: the seed applied, and a face template for each student so the claim
 * stage can pass its FACE_NOT_ENROLLED check (seed writes synthetic templates for
 * the first 20 students only; extend the seed for a full 500-student run).
 */
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);

const BASE = args.get('--base') ?? 'http://localhost:4000';
const SESSION = args.get('--session');
const OUT = args.get('--out') ?? 'infra/k6/tokens.json';
const COUNT = Number(args.get('--count') ?? 20);
const PASSWORD = args.get('--password') ?? 'SeedPassw0rd!';

if (!SESSION) {
  console.error('missing --session <uuid>');
  process.exit(1);
}

const b64u = (buffer) => Buffer.from(buffer).toString('base64url');

class Client {
  cookies = new Map();

  async call(path, init = {}) {
    const headers = {
      'content-type': 'application/json',
      ...(init.body ? {} : {}),
      ...(init.headers ?? {}),
    };
    const cookieHeader = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    if (cookieHeader) headers.cookie = cookieHeader;
    const csrf = this.cookies.get('attend_csrf');
    if (csrf && init.method && init.method !== 'GET') headers['x-csrf-token'] = decodeURIComponent(csrf);

    const response = await fetch(`${BASE}${path}`, { ...init, headers });
    for (const setCookie of response.headers.getSetCookie()) {
      const [pair] = setCookie.split(';');
      const index = pair.indexOf('=');
      this.cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
    const text = await response.text();
    if (!response.ok) throw new Error(`${path} -> ${response.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  }
}

/** Read one QR token from the lecturer SSE stream (needs a staff session). */
async function mintToken(staff) {
  const response = await fetch(`${BASE}/api/v1/sessions/${SESSION}/qr/stream`, {
    headers: {
      cookie: [...staff.cookies].map(([name, value]) => `${name}=${value}`).join('; '),
      accept: 'text/event-stream',
    },
  });
  const reader = response.body?.getReader();
  if (!reader) throw new Error('no SSE body');
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const match = /data: (\{.*\})/u.exec(buffer);
    if (match?.[1]) {
      await reader.cancel();
      return JSON.parse(match[1]).token;
    }
  }
  throw new Error('no QR token received');
}

function authData(rpId) {
  const rpIdHash = createHash('sha256').update(rpId).digest();
  // UP | UV: the API requires user verification on check-in, so the harness
  // authenticator must assert it here as well.
  const flags = Buffer.from([0x05]);
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(1);
  return Buffer.concat([rpIdHash, flags, counter]);
}

function coseKeyFromJwk(jwk) {
  const x = Buffer.from(jwk.x, 'base64url');
  const y = Buffer.from(jwk.y, 'base64url');
  return Buffer.concat([
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01]),
    Buffer.from([0x21, 0x58, x.length]),
    x,
    Buffer.from([0x22, 0x58, y.length]),
    y,
  ]);
}

function registrationCredential(rpId, origin, challenge, keyPair, credentialId) {
  const clientDataJSON = b64u(
    Buffer.from(
      JSON.stringify({ type: 'webauthn.create', challenge, origin, crossOrigin: false }),
      'utf8',
    ),
  );
  const rpIdHash = createHash('sha256').update(rpId).digest();
  const flags = Buffer.from([0x45]); // UP | UV | AT
  const counter = Buffer.alloc(4);
  const aaguid = Buffer.alloc(16);
  const idLength = Buffer.alloc(2);
  idLength.writeUInt16BE(credentialId.length);
  const cose = coseKeyFromJwk(keyPair.publicKey.export({ format: 'jwk' }));

  const authDataBytes = Buffer.concat([rpIdHash, flags, counter, aaguid, idLength, credentialId, cose]);
  // {fmt:"none", attStmt:{}, authData: bytes}
  const attestationObject = b64u(
    Buffer.concat([
      Buffer.from([0xa3, 0x63]),
      Buffer.from('fmt', 'ascii'),
      Buffer.from([0x64]),
      Buffer.from('none', 'ascii'),
      Buffer.from([0x67]),
      Buffer.from('attStmt', 'ascii'),
      Buffer.from([0xa0, 0x68]),
      Buffer.from('authData', 'ascii'),
      Buffer.from(authDataBytes.length < 24 ? [0x40 + authDataBytes.length] : [0x58, authDataBytes.length]),
      authDataBytes,
    ]),
  );

  return {
    id: b64u(credentialId),
    rawId: b64u(credentialId),
    type: 'public-key',
    clientExtensionResults: {},
    response: { clientDataJSON, attestationObject },
  };
}

function assertionCredential(rpId, origin, token, keyPair, credentialId) {
  const challenge = b64u(createHash('sha256').update(token).digest());
  const clientDataJSON = b64u(
    Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin, crossOrigin: false })),
  );
  const authenticatorData = authData(rpId);
  const clientDataHash = createHash('sha256').update(Buffer.from(clientDataJSON, 'base64url')).digest();
  const signedData = Buffer.concat([authenticatorData, clientDataHash]);
  const signature = sign('sha256', signedData, keyPair.privateKey);

  return {
    id: b64u(credentialId),
    rawId: b64u(credentialId),
    type: 'public-key',
    clientExtensionResults: {},
    response: {
      clientDataJSON,
      authenticatorData: b64u(authenticatorData),
      signature: b64u(signature),
      userHandle: null,
    },
  };
}

async function main() {
  const rpId = args.get('--rp') ?? 'localhost';
  const origin = args.get('--origin') ?? 'http://localhost:3000';

  const staff = new Client();
  await staff.call('/api/v1/auth/signin', {
    method: 'POST',
    body: JSON.stringify({ email: args.get('--staff') ?? 'lecturer1@seed.attend.local', password: PASSWORD }),
  });
  const token = await mintToken(staff);
  console.log('minted a QR token for session', SESSION);

  const pack = [];
  for (let index = 1; index <= COUNT; index += 1) {
    const studentNumber = `2026${String(index).padStart(4, '0')}`;
    const client = new Client();
    try {
      await client.call('/api/v1/auth/signin', {
        method: 'POST',
        body: JSON.stringify({ email: `student${String(index).padStart(3, '0')}@seed.attend.local`, password: PASSWORD }),
      });
      await client.call('/api/v1/biometrics/consent', {
        method: 'POST',
        body: JSON.stringify({ noticeVersion: '2026-01-v1', granted: true }),
      });

      const options = await client.call('/api/v1/devices/register/options', { method: 'POST' });
      const keyPair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const credentialId = randomBytes(16);
      const credential = registrationCredential(rpId, origin, options.challenge, keyPair, credentialId);
      const fingerprint = {
        userAgentFamily: 'k6/harness',
        platform: 'node',
        screen: '0x0',
        installId: b64u(randomBytes(16)),
      };
      await client.call('/api/v1/devices/register', {
        method: 'POST',
        body: JSON.stringify({ challengeId: options.challengeId, credential, fingerprint }),
      });

      pack.push({
        studentNumber,
        fingerprint,
        token,
        assertion: assertionCredential(rpId, origin, token, keyPair, credentialId),
      });
      console.log('prepared', studentNumber);
    } catch (error) {
      console.warn('skipped', studentNumber, String(error).slice(0, 120));
    }
  }

  writeFileSync(OUT, JSON.stringify(pack, null, 2));
  console.log(`wrote ${pack.length} claim(s) to ${OUT}`);
  console.log('token expires in seconds — run k6 immediately, or re-run this script');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
