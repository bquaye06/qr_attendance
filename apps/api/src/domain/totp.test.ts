import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { base32Decode, base32Encode, generateTotpSecret, totpCode, verifyTotp } from './totp.ts';

// RFC 6238 appendix B test vectors (SHA-1, 8 digits, 30 s step).
const RFC_SECRET_ASCII = '12345678901234567890';
const RFC_SECRET_BASE32 = base32Encode(Buffer.from(RFC_SECRET_ASCII, 'ascii'));

describe('TOTP', () => {
  it('matches the RFC 6238 SHA-1 vectors', () => {
    const vectors: [number, string][] = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130'],
    ];
    for (const [seconds, expected] of vectors) {
      const code = totpCode(RFC_SECRET_BASE32, seconds * 1000, { digits: 8 });
      assert.equal(code, expected, `vector at T=${seconds}`);
    }
  });

  it('produces a six digit code by default', () => {
    const secret = generateTotpSecret();
    assert.match(totpCode(secret, Date.UTC(2026, 0, 1)), /^\d{6}$/u);
  });

  it('accepts the current code and rejects a neighbouring-window code outside tolerance', () => {
    const secret = generateTotpSecret();
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    const code = totpCode(secret, now);
    assert.equal(verifyTotp(secret, code, now).ok, true);
    assert.equal(verifyTotp(secret, code, now + 30_000).ok, true, 'one step of drift is tolerated');
    assert.equal(verifyTotp(secret, code, now + 180_000).ok, false, 'three steps of drift is rejected');
  });

  it('rejects wrong codes, wrong lengths and non-numeric input', () => {
    const secret = generateTotpSecret();
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    const code = totpCode(secret, now);
    const wrong = code === '000000' ? '000001' : '000000';
    assert.equal(verifyTotp(secret, wrong, now).ok, false);
    assert.equal(verifyTotp(secret, '123', now).ok, false);
    assert.equal(verifyTotp(secret, 'abcdef', now).ok, false);
  });

  it('base32 round-trips', () => {
    const original = Buffer.from('attend-biometric-platform', 'utf8');
    assert.deepEqual(base32Decode(base32Encode(original)), original);
  });
});
