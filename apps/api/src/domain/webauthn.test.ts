import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  b64uToBuffer,
  bufferToB64u,
  coseToPublicKey,
  parseAuthenticatorData,
  verifyAssertion,
  verifyRegistration,
} from './webauthn.ts';

const RP_ID = 'localhost';
const ORIGIN = 'http://localhost:3000';

interface KeyMaterial {
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
  cose: string;
}

/** Build a COSE_Key for an ES256 P-256 key, as an authenticator would. */
function makeEs256Key(): KeyMaterial {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const x = b64uToBuffer(jwk.x);
  const y = b64uToBuffer(jwk.y);

  const cose = encodeCoseKey(x, y);
  return { privateKey, cose: cose.toString('base64') };
}

/** Minimal CBOR map encoder for the fixed COSE_Key shape we use in tests. */
function encodeCoseKey(x: Buffer, y: Buffer): Buffer {
  const parts: Buffer[] = [];
  parts.push(Buffer.from([0xa5])); // map(5)
  parts.push(Buffer.from([0x01, 0x02])); // 1: 2 (EC2)
  parts.push(Buffer.from([0x03, 0x26])); // 3: -7 (ES256)
  parts.push(Buffer.from([0x20, 0x01])); // -1: 1 (P-256)
  parts.push(Buffer.from([0x21, 0x58, x.length])); // -2: bytes(x)
  parts.push(x);
  parts.push(Buffer.from([0x22, 0x58, y.length])); // -3: bytes(y)
  parts.push(y);
  return Buffer.concat(parts);
}

function authData(options: {
  rpId?: string;
  flags?: number;
  signCount?: number;
  credentialId?: Buffer;
  cose?: string;
}): Buffer {
  const rpIdHash = createHash('sha256').update(options.rpId ?? RP_ID).digest();
  const flags = options.flags ?? 0x45; // UP | UV | AT
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(options.signCount ?? 0);
  const parts = [rpIdHash, Buffer.from([flags]), counter];
  if ((flags & 0x40) !== 0) {
    parts.push(Buffer.alloc(16)); // aaguid
    const credentialId = options.credentialId ?? Buffer.from('credential-id-0001', 'utf8');
    const length = Buffer.alloc(2);
    length.writeUInt16BE(credentialId.length);
    parts.push(length, credentialId);
    parts.push(Buffer.from(options.cose ?? makeEs256Key().cose, 'base64'));
  }
  return Buffer.concat(parts);
}

function clientData(type: 'webauthn.create' | 'webauthn.get', challenge: string, origin = ORIGIN): string {
  return bufferToB64u(
    Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), 'utf8'),
  );
}

function attestationObject(auth: Buffer): string {
  // {fmt: "none", attStmt: {}, authData: bytes}
  const parts: Buffer[] = [];
  parts.push(Buffer.from([0xa3]));
  parts.push(Buffer.from([0x63]), Buffer.from('fmt', 'ascii'), Buffer.from([0x64]), Buffer.from('none', 'ascii'));
  parts.push(Buffer.from([0x67]), Buffer.from('attStmt', 'ascii'), Buffer.from([0xa0]));
  parts.push(Buffer.from([0x68]), Buffer.from('authData', 'ascii'));
  const header = auth.length < 24 ? Buffer.from([0x40 + auth.length]) : Buffer.from([0x58, auth.length]);
  parts.push(header, auth);
  return bufferToB64u(Buffer.concat(parts));
}

describe('WebAuthn device binding', () => {
  it('parses authenticator data with attested credential data', () => {
    const cose = makeEs256Key().cose;
    const parsed = parseAuthenticatorData(authData({ cose }));
    assert.equal(parsed.flags.userPresent, true);
    assert.equal(parsed.flags.userVerified, true);
    assert.equal(parsed.credentialId, bufferToB64u(Buffer.from('credential-id-0001', 'utf8')));
    assert.ok(parsed.credentialPublicKey && parsed.credentialPublicKey.length > 0);
  });

  it('converts a COSE key into a usable public key', () => {
    const material = makeEs256Key();
    const key = coseToPublicKey(Buffer.from(material.cose, 'base64'));
    assert.equal(key.algorithm, 'ES256');
    assert.equal(key.keyObject.asymmetricKeyType, 'ec');
  });

  it('verifies a registration for our RP ID and origin', () => {
    const material = makeEs256Key();
    const challenge = bufferToB64u(Buffer.from('challenge-abc-123', 'utf8'));
    const result = verifyRegistration({
      rpId: RP_ID,
      allowedOrigins: [ORIGIN],
      expectedChallenge: challenge,
      clientDataJSON: clientData('webauthn.create', challenge),
      attestationObject: attestationObject(authData({ cose: material.cose })),
      rawId: 'cmF3LWlk',
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.credentialId, 'cmF3LWlk');
    assert.ok(result.value.publicKeyCose.length > 0);
  });

  it('rejects a registration for a different RP ID', () => {
    const material = makeEs256Key();
    const challenge = bufferToB64u(Buffer.from('challenge-abc-123', 'utf8'));
    const result = verifyRegistration({
      rpId: RP_ID,
      allowedOrigins: [ORIGIN],
      expectedChallenge: challenge,
      clientDataJSON: clientData('webauthn.create', challenge),
      attestationObject: attestationObject(authData({ rpId: 'evil.example', cose: material.cose })),
      rawId: 'cmF3LWlk',
    });
    assert.deepEqual(result, { ok: false, reason: 'rp_id_mismatch' });
  });

  it('rejects a registration whose challenge differs', () => {
    const material = makeEs256Key();
    const result = verifyRegistration({
      rpId: RP_ID,
      allowedOrigins: [ORIGIN],
      expectedChallenge: bufferToB64u(Buffer.from('expected-challenge', 'utf8')),
      clientDataJSON: clientData('webauthn.create', bufferToB64u(Buffer.from('other-challenge', 'utf8'))),
      attestationObject: attestationObject(authData({ cose: material.cose })),
      rawId: 'cmF3LWlk',
    });
    assert.deepEqual(result, { ok: false, reason: 'challenge_mismatch' });
  });

  it('verifies a valid assertion and returns the new counter', () => {
    const material = makeEs256Key();
    const challenge = bufferToB64u(Buffer.from('claim-challenge', 'utf8'));
    const cdata = clientData('webauthn.get', challenge);
    const auth = authData({ flags: 0x05, signCount: 7 });
    const clientDataHash = createHash('sha256').update(b64uToBuffer(cdata)).digest();
    const signature = sign('sha256', Buffer.concat([auth, clientDataHash]), material.privateKey);

    const result = verifyAssertion({
      rpId: RP_ID,
      allowedOrigins: [ORIGIN],
      expectedChallenge: challenge,
      clientDataJSON: cdata,
      authenticatorData: bufferToB64u(auth),
      signature: bufferToB64u(signature),
      credentialId: 'cred-1',
      publicKeyCose: material.cose,
      storedSignCount: 3,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.newSignCount, 7);
  });

  it('rejects an assertion signed by a different key', () => {
    const legit = makeEs256Key();
    const attacker = makeEs256Key();
    const challenge = bufferToB64u(Buffer.from('claim-challenge', 'utf8'));
    const cdata = clientData('webauthn.get', challenge);
    const auth = authData({ flags: 0x05, signCount: 1 });
    const clientDataHash = createHash('sha256').update(b64uToBuffer(cdata)).digest();
    const forged = sign('sha256', Buffer.concat([auth, clientDataHash]), attacker.privateKey);

    const result = verifyAssertion({
      rpId: RP_ID,
      allowedOrigins: [ORIGIN],
      expectedChallenge: challenge,
      clientDataJSON: cdata,
      authenticatorData: bufferToB64u(auth),
      signature: bufferToB64u(forged),
      credentialId: 'cred-1',
      publicKeyCose: legit.cose,
      storedSignCount: 0,
    });
    assert.deepEqual(result, { ok: false, reason: 'signature_invalid' });
  });

  it('rejects a replayed assertion whose counter did not advance', () => {
    const material = makeEs256Key();
    const challenge = bufferToB64u(Buffer.from('claim-challenge', 'utf8'));
    const cdata = clientData('webauthn.get', challenge);
    const auth = authData({ flags: 0x05, signCount: 5 });
    const clientDataHash = createHash('sha256').update(b64uToBuffer(cdata)).digest();
    const signature = sign('sha256', Buffer.concat([auth, clientDataHash]), material.privateKey);

    const result = verifyAssertion({
      rpId: RP_ID,
      allowedOrigins: [ORIGIN],
      expectedChallenge: challenge,
      clientDataJSON: cdata,
      authenticatorData: bufferToB64u(auth),
      signature: bufferToB64u(signature),
      credentialId: 'cred-1',
      publicKeyCose: material.cose,
      storedSignCount: 5,
    });
    assert.deepEqual(result, { ok: false, reason: 'counter_regression' });
  });

  it('rejects an assertion from an untrusted origin', () => {
    const material = makeEs256Key();
    const challenge = bufferToB64u(Buffer.from('claim-challenge', 'utf8'));
    const cdata = clientData('webauthn.get', challenge, 'https://phish.example');
    const auth = authData({ flags: 0x05, signCount: 1 });
    const result = verifyAssertion({
      rpId: RP_ID,
      allowedOrigins: [ORIGIN],
      expectedChallenge: challenge,
      clientDataJSON: cdata,
      authenticatorData: bufferToB64u(auth),
      signature: bufferToB64u(Buffer.from('ignored')),
      credentialId: 'cred-1',
      publicKeyCose: material.cose,
      storedSignCount: 0,
    });
    assert.deepEqual(result, { ok: false, reason: 'origin_mismatch' });
  });

  it('rejects an assertion when the user was not verified and UV is required', () => {
    const material = makeEs256Key();
    const challenge = bufferToB64u(Buffer.from('claim-challenge', 'utf8'));
    const cdata = clientData('webauthn.get', challenge);
    const auth = authData({ flags: 0x01, signCount: 2 });
    const clientDataHash = createHash('sha256').update(b64uToBuffer(cdata)).digest();
    const signature = sign('sha256', Buffer.concat([auth, clientDataHash]), material.privateKey);
    const result = verifyAssertion({
      rpId: RP_ID,
      allowedOrigins: [ORIGIN],
      expectedChallenge: challenge,
      clientDataJSON: cdata,
      authenticatorData: bufferToB64u(auth),
      signature: bufferToB64u(signature),
      credentialId: 'cred-1',
      publicKeyCose: material.cose,
      storedSignCount: 0,
    });
    assert.deepEqual(result, { ok: false, reason: 'user_not_verified' });
  });
});
