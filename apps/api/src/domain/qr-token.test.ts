import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { issueQrToken, secondsUntilExpiry, verifyQrToken } from './qr-token.ts';

const secret = 'test-session-secret-0123456789';
const sessionId = '11111111-1111-1111-1111-111111111111';
const t0 = Date.UTC(2026, 0, 1, 9, 0, 0);

describe('rotating QR tokens', () => {
  it('round-trips a token and returns the payload', () => {
    const { token, payload } = issueQrToken({ sessionId, secret, nowMs: t0, ttlSeconds: 15 });
    const result = verifyQrToken({ token, secret, nowMs: t0 + 1000 });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.payload.sid, sessionId);
    assert.equal(result.payload.n, payload.n);
    assert.equal(result.payload.exp - result.payload.iat, 15);
  });

  it('rejects a token after its expiry with reason "expired"', () => {
    const { token } = issueQrToken({ sessionId, secret, nowMs: t0, ttlSeconds: 15 });
    const result = verifyQrToken({ token, secret, nowMs: t0 + 16_000 });
    assert.deepEqual(result, { ok: false, reason: 'expired' });
  });

  it('accepts a token exactly at its expiry second', () => {
    const { token } = issueQrToken({ sessionId, secret, nowMs: t0, ttlSeconds: 15 });
    assert.equal(verifyQrToken({ token, secret, nowMs: t0 + 15_000 }).ok, true);
  });

  it('rejects a token signed with a different session secret', () => {
    const { token } = issueQrToken({ sessionId, secret, nowMs: t0, ttlSeconds: 15 });
    const result = verifyQrToken({ token, secret: 'another-secret', nowMs: t0 });
    assert.deepEqual(result, { ok: false, reason: 'bad_signature' });
  });

  it('rejects a tampered payload even though the signature length is unchanged', () => {
    const { token } = issueQrToken({ sessionId, secret, nowMs: t0, ttlSeconds: 15 });
    const [version, payload, signature] = token.split('.') as [string, string, string];
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    decoded['exp'] = Number(decoded['exp']) + 3600;
    const forgedPayload = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url');
    const forged = [version, forgedPayload, signature].join('.');
    assert.deepEqual(verifyQrToken({ token: forged, secret, nowMs: t0 }), {
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects malformed input', () => {
    for (const bad of ['', 'abc', 'v1.only-two', 'v2.aaa.bbb', 'v1..']) {
      const result = verifyQrToken({ token: bad, secret, nowMs: t0 });
      assert.equal(result.ok, false, `expected ${JSON.stringify(bad)} to be rejected`);
    }
  });

  it('rejects a token issued in the future beyond the skew allowance', () => {
    const { token } = issueQrToken({ sessionId, secret, nowMs: t0 + 60_000, ttlSeconds: 15 });
    assert.deepEqual(verifyQrToken({ token, secret, nowMs: t0 }), { ok: false, reason: 'not_yet_valid' });
    assert.equal(verifyQrToken({ token, secret, nowMs: t0, clockSkewSeconds: 60 }).ok, true);
  });

  it('issues a distinct nonce per token so one scan cannot be replayed for another', () => {
    const first = issueQrToken({ sessionId, secret, nowMs: t0, ttlSeconds: 15 });
    const second = issueQrToken({ sessionId, secret, nowMs: t0, ttlSeconds: 15 });
    assert.notEqual(first.payload.n, second.payload.n);
    assert.notEqual(first.token, second.token);
  });

  it('reports remaining validity for the UI countdown', () => {
    const { payload } = issueQrToken({ sessionId, secret, nowMs: t0, ttlSeconds: 15 });
    assert.equal(secondsUntilExpiry(payload, t0 + 5_000), 10);
    assert.equal(secondsUntilExpiry(payload, t0 + 60_000), 0);
  });
});
