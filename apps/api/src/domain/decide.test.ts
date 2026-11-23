import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decideClaim, decideVerification } from './decide.ts';
import type { ClaimDecisionInput } from './decide.ts';

const t0 = new Date('2026-01-12T09:00:00.000Z');

function baseInput(overrides: Partial<ClaimDecisionInput> = {}): ClaimDecisionInput {
  return {
    now: t0,
    token: { verified: true, sessionId: 'session-1' },
    session: {
      id: 'session-1',
      status: 'open',
      checkinOpensAt: new Date('2026-01-12T08:55:00.000Z'),
      checkinClosesAt: new Date('2026-01-12T09:15:00.000Z'),
    },
    enrollmentActive: true,
    consentGranted: true,
    faceEnrolled: true,
    device: { registered: true, status: 'active', fingerprintMatches: true },
    webauthnOk: true,
    ipAllowed: true,
    geofence: { enabled: false, inside: true, distanceM: null },
    alreadyCheckedIn: false,
    deviceUsedByOtherStudent: false,
    ...overrides,
  };
}

function codeOf(input: ClaimDecisionInput): string | 'allowed' {
  const decision = decideClaim(input);
  return decision.allowed ? 'allowed' : decision.code;
}

describe('decideClaim', () => {
  it('allows a complete, valid claim', () => {
    assert.deepEqual(decideClaim(baseInput()), { allowed: true });
  });

  it('rejects an expired token with QR_EXPIRED', () => {
    assert.equal(codeOf(baseInput({ token: { verified: false, reason: 'expired' } })), 'QR_EXPIRED');
  });

  it('rejects a forged signature with QR_SIGNATURE_INVALID', () => {
    assert.equal(
      codeOf(baseInput({ token: { verified: false, reason: 'bad_signature' } })),
      'QR_SIGNATURE_INVALID',
    );
  });

  it('checks the token before anything derived from the database', () => {
    // Even with everything else broken, the token error wins: it must not leak
    // whether the student is enrolled or has already checked in.
    const decision = codeOf(
      baseInput({
        token: { verified: false, reason: 'expired' },
        enrollmentActive: false,
        alreadyCheckedIn: true,
        device: { registered: false, status: null, fingerprintMatches: false },
      }),
    );
    assert.equal(decision, 'QR_EXPIRED');
  });

  it('rejects a token minted for a different session', () => {
    assert.equal(codeOf(baseInput({ token: { verified: true, sessionId: 'session-2' } })), 'QR_INVALID');
  });

  it('rejects before the window opens and after it closes', () => {
    assert.equal(
      codeOf(baseInput({ now: new Date('2026-01-12T08:50:00.000Z') })),
      'WINDOW_NOT_OPEN',
    );
    assert.equal(codeOf(baseInput({ now: new Date('2026-01-12T09:15:01.000Z') })), 'WINDOW_CLOSED');
  });

  it('rejects cancelled and closed sessions', () => {
    const session = baseInput().session!;
    assert.equal(codeOf(baseInput({ session: { ...session, status: 'cancelled' } })), 'SESSION_CANCELLED');
    assert.equal(codeOf(baseInput({ session: { ...session, status: 'closed' } })), 'SESSION_CLOSED');
  });

  it('rejects a student who is not enrolled with NOT_ENROLLED', () => {
    assert.equal(codeOf(baseInput({ enrollmentActive: false })), 'NOT_ENROLLED');
  });

  it('requires consent and an enrolled face', () => {
    assert.equal(codeOf(baseInput({ consentGranted: false })), 'CONSENT_REQUIRED');
    assert.equal(codeOf(baseInput({ faceEnrolled: false })), 'FACE_NOT_ENROLLED');
  });

  it('rejects unregistered, revoked and swapped devices', () => {
    assert.equal(
      codeOf(baseInput({ device: { registered: false, status: null, fingerprintMatches: true } })),
      'DEVICE_NOT_REGISTERED',
    );
    assert.equal(
      codeOf(baseInput({ device: { registered: true, status: 'revoked', fingerprintMatches: true } })),
      'DEVICE_REVOKED',
    );
    assert.equal(
      codeOf(baseInput({ device: { registered: true, status: 'active', fingerprintMatches: false } })),
      'DEVICE_FINGERPRINT_MISMATCH',
    );
  });

  it('rejects a failed WebAuthn assertion', () => {
    assert.equal(codeOf(baseInput({ webauthnOk: false })), 'WEBAUTHN_FAILED');
  });

  it('enforces the geofence only when the session enables it', () => {
    assert.equal(
      codeOf(baseInput({ geofence: { enabled: false, inside: false, distanceM: 900 } })),
      'allowed',
    );
    assert.equal(
      codeOf(baseInput({ geofence: { enabled: true, inside: false, distanceM: 900 } })),
      'GEOFENCE_VIOLATION',
    );
  });

  it('rejects a device already used by another student in this session', () => {
    assert.equal(codeOf(baseInput({ deviceUsedByOtherStudent: true })), 'DEVICE_ALREADY_USED');
  });

  it('rejects a second check-in for the same student', () => {
    assert.equal(codeOf(baseInput({ alreadyCheckedIn: true })), 'ALREADY_CHECKED_IN');
  });

  it('reports duplicates before device reuse for the same request', () => {
    assert.equal(
      codeOf(baseInput({ alreadyCheckedIn: true, deviceUsedByOtherStudent: true })),
      'ALREADY_CHECKED_IN',
    );
  });
});

const lateAfter = new Date('2026-01-12T09:10:00.000Z');
const closesAt = new Date('2026-01-12T09:15:00.000Z');

function verifyInput(overrides: Partial<Parameters<typeof decideVerification>[0]> = {}) {
  return {
    now: new Date('2026-01-12T09:05:00.000Z'),
    lateAfter,
    checkinClosesAt: closesAt,
    quality: { score: 0.9, threshold: 0.6 },
    liveness: { score: 0.95, passed: true, threshold: 0.8 },
    activeLiveness: { required: true, passed: true },
    similarity: { value: 0.72, threshold: 0.45 },
    duplicateFace: false,
    risk: { score: 10, threshold: 70 },
    failureCount: 0,
    failuresBeforeFlag: 3,
    ...overrides,
  };
}

describe('decideVerification', () => {
  it('records present for an on-time, clean verification', () => {
    assert.deepEqual(decideVerification(verifyInput()), { outcome: 'present', reasons: [] });
  });

  it('records late after the late threshold', () => {
    const decision = decideVerification(verifyInput({ now: new Date('2026-01-12T09:12:00.000Z') }));
    assert.equal(decision.outcome, 'late');
  });

  it('rejects a spoof with LIVENESS_FAILED', () => {
    const decision = decideVerification(verifyInput({ liveness: { score: 0.2, passed: false, threshold: 0.8 } }));
    assert.deepEqual(
      { outcome: decision.outcome, code: 'code' in decision ? decision.code : null },
      { outcome: 'rejected', code: 'LIVENESS_FAILED' },
    );
  });

  it('rejects an unfinished active challenge', () => {
    const decision = decideVerification(
      verifyInput({ activeLiveness: { required: true, passed: false } }),
    );
    assert.equal('code' in decision ? decision.code : null, 'LIVENESS_FAILED');
  });

  it('ignores the active challenge when the institution disables it', () => {
    const decision = decideVerification(
      verifyInput({ activeLiveness: { required: false, passed: false } }),
    );
    assert.equal(decision.outcome, 'present');
  });

  it('rejects a low-quality capture with FACE_QUALITY_LOW', () => {
    const decision = decideVerification(verifyInput({ quality: { score: 0.3, threshold: 0.6 } }));
    assert.equal('code' in decision ? decision.code : null, 'FACE_QUALITY_LOW');
  });

  it("rejects someone else's face with FACE_MISMATCH", () => {
    const decision = decideVerification(verifyInput({ similarity: { value: 0.21, threshold: 0.45 } }));
    assert.equal('code' in decision ? decision.code : null, 'FACE_MISMATCH');
  });

  it('rejects a face already used by another account with DUPLICATE_FACE', () => {
    const decision = decideVerification(verifyInput({ duplicateFace: true }));
    assert.equal('code' in decision ? decision.code : null, 'DUPLICATE_FACE');
  });

  it('flags instead of rejecting when risk is high', () => {
    const decision = decideVerification(verifyInput({ risk: { score: 82, threshold: 70 } }));
    assert.deepEqual(decision, { outcome: 'present_flagged', reasons: ['risk_above_threshold'] });
  });

  it('flags after repeated failures even at low risk', () => {
    const decision = decideVerification(verifyInput({ failureCount: 2, failuresBeforeFlag: 3 }));
    assert.deepEqual(decision, { outcome: 'present_flagged', reasons: ['repeated_failures'] });
  });

  it('rejects when the window closed while the claim was open', () => {
    const decision = decideVerification(verifyInput({ now: new Date('2026-01-12T09:16:00.000Z') }));
    assert.equal('code' in decision ? decision.code : null, 'WINDOW_CLOSED');
  });

  it('uses the configured threshold, so an admin change takes effect immediately', () => {
    const strict = decideVerification(verifyInput({ similarity: { value: 0.62, threshold: 0.7 } }));
    const lenient = decideVerification(verifyInput({ similarity: { value: 0.62, threshold: 0.45 } }));
    assert.equal('code' in strict ? strict.code : null, 'FACE_MISMATCH');
    assert.equal(lenient.outcome, 'present');
  });
});
