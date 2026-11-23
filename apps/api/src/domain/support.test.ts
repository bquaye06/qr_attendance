import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fingerprintMatches, hashFingerprint } from './fingerprint.ts';
import { hashPassword, needsRehash, verifyPassword } from './password.ts';
import { isEvidenceDue, templatePurgeDecision } from './retention.ts';
import { decryptSecret, encryptSecret, newSessionSecret, parseMasterKey, SecretKeyError } from './secrets.ts';
import { bestMatch, cosineSimilarity, nearestOtherSimilarity, toTemplate } from './similarity.ts';

describe('secret envelope encryption', () => {
  const key = parseMasterKey(Buffer.alloc(32, 7).toString('base64'));

  it('round-trips a session secret', () => {
    const secret = newSessionSecret();
    assert.equal(decryptSecret(encryptSecret(secret, key), key), secret);
  });

  it('produces a different ciphertext each time (random IV)', () => {
    const first = encryptSecret('same-plaintext', key);
    const second = encryptSecret('same-plaintext', key);
    assert.notEqual(first, second);
  });

  it('detects tampering with the ciphertext', () => {
    const sealed = encryptSecret('sensitive', key);
    const parts = sealed.split('.');
    const forged = [parts[0], parts[1], parts[2], Buffer.from('other').toString('base64url')].join('.');
    assert.throws(() => decryptSecret(forged, key));
  });

  it('refuses to decrypt with the wrong key', () => {
    const otherKey = parseMasterKey(Buffer.alloc(32, 9).toString('base64'));
    const sealed = encryptSecret('sensitive', key);
    assert.throws(() => decryptSecret(sealed, otherKey));
  });

  it('rejects a key of the wrong length', () => {
    assert.throws(() => encryptSecret('x', Buffer.alloc(16)), SecretKeyError);
  });
});

describe('password hashing', () => {
  it('verifies the correct password and rejects others', async () => {
    const stored = await hashPassword('correct-horse-battery-staple');
    assert.equal(await verifyPassword('correct-horse-battery-staple', stored), true);
    assert.equal(await verifyPassword('wrong-password', stored), false);
  });

  it('salts each hash', async () => {
    const a = await hashPassword('same-password');
    const b = await hashPassword('same-password');
    assert.notEqual(a, b);
  });

  it('rejects malformed stored values without throwing', async () => {
    assert.equal(await verifyPassword('x', 'not-a-hash'), false);
    assert.equal(await verifyPassword('x', 'scrypt$bad$8$1$c2FsdA==$aGFzaA=='), false);
  });

  it('flags weaker stored parameters for rehash', async () => {
    const stored = await hashPassword('pw');
    assert.equal(needsRehash(stored), false);
    // A hash produced with cheaper parameters must be upgraded on next sign-in.
    assert.equal(needsRehash(stored.replace('scrypt$16384$', 'scrypt$4096$')), true);
    assert.equal(needsRehash('scrypt$4096$8$1$c2FsdA==$aGFzaA=='), true);
    assert.equal(needsRehash('not-a-hash'), true);
  });
});

describe('device fingerprints', () => {
  const fingerprint = {
    userAgentFamily: 'Chrome 131',
    platform: 'Android',
    screen: '412x915',
    installId: 'install-abc-123',
  };
  const salt = 'pepper';

  it('hashes deterministically and ignores field order and case', () => {
    const a = hashFingerprint(fingerprint, salt);
    const b = hashFingerprint(
      {
        installId: 'install-abc-123',
        platform: 'android',
        screen: '412X915',
        userAgentFamily: 'chrome 131',
      },
      salt,
    );
    assert.equal(a, b);
    assert.equal(a.length, 64);
  });

  it('changes when the install id changes', () => {
    const a = hashFingerprint(fingerprint, salt);
    const b = hashFingerprint({ ...fingerprint, installId: 'install-abc-999' }, salt);
    assert.notEqual(a, b);
  });

  it('compares hashes in constant time without length leaks', () => {
    const a = hashFingerprint(fingerprint, salt);
    assert.equal(fingerprintMatches(a, a), true);
    assert.equal(fingerprintMatches(a, hashFingerprint({ ...fingerprint, platform: 'iOS' }, salt)), false);
    assert.equal(fingerprintMatches(a, 'short'), false);
  });
});

describe('retention rules', () => {
  const now = new Date('2026-06-01T00:00:00.000Z');

  it('keeps templates during the grace period after withdrawal', () => {
    const decision = templatePurgeDecision({
      now,
      withdrawnAt: new Date('2026-05-20T00:00:00.000Z'),
      leftAt: null,
      deletionRequestedAt: null,
      graceDays: 30,
    });
    assert.equal(decision.due, false);
    assert.equal(decision.reason, 'withdrawn');
    assert.equal(decision.dueAt?.toISOString(), '2026-06-19T00:00:00.000Z');
  });

  it('purges once the grace period has elapsed', () => {
    const decision = templatePurgeDecision({
      now,
      withdrawnAt: new Date('2026-04-01T00:00:00.000Z'),
      leftAt: null,
      deletionRequestedAt: null,
      graceDays: 30,
    });
    assert.equal(decision.due, true);
  });

  it('uses the earliest trigger when several apply', () => {
    const decision = templatePurgeDecision({
      now,
      withdrawnAt: new Date('2026-05-25T00:00:00.000Z'),
      leftAt: new Date('2026-04-25T00:00:00.000Z'),
      deletionRequestedAt: new Date('2026-05-30T00:00:00.000Z'),
      graceDays: 30,
    });
    assert.equal(decision.reason, 'left');
    assert.equal(decision.due, true);
  });

  it('keeps templates when no trigger exists', () => {
    const decision = templatePurgeDecision({
      now,
      withdrawnAt: null,
      leftAt: null,
      deletionRequestedAt: null,
      graceDays: 30,
    });
    assert.deepEqual(decision, { due: false, reason: null, dueAt: null });
  });

  it('expires evidence after the retention window', () => {
    assert.equal(isEvidenceDue(new Date('2026-04-01T00:00:00.000Z'), now, 30), true);
    assert.equal(isEvidenceDue(new Date('2026-05-31T00:00:00.000Z'), now, 30), false);
  });
});

describe('embedding similarity', () => {
  const template = toTemplate([[0.5, 0.5], [0.5, 0.5]]);

  it('normalises an averaged template to unit length', () => {
    const norm = Math.hypot(...template);
    assert.ok(Math.abs(norm - 1) < 1e-9);
  });

  it('scores an identical embedding at 1 and an orthogonal one at 0', () => {
    assert.ok(Math.abs(cosineSimilarity([1, 0], [1, 0]) - 1) < 1e-9);
    assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-9);
  });

  it('returns zero for a zero vector instead of NaN', () => {
    assert.equal(cosineSimilarity([0, 0], [1, 0]), 0);
  });

  it('finds the best candidate and the nearest other face', () => {
    const candidates = [
      { id: 'self', embedding: [1, 0] },
      { id: 'other', embedding: [0.6, 0.8] },
    ];
    const best = bestMatch([0.99, 0.01], candidates);
    assert.equal(best?.id, 'self');
    assert.equal(nearestOtherSimilarity([0.99, 0.01], candidates), best?.similarity);
  });

  it('rejects mismatched dimensions instead of silently comparing', () => {
    assert.throws(() => cosineSimilarity([1, 0], [1, 0, 0]));
  });
});
