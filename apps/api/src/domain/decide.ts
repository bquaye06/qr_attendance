import type { ErrorCode } from '@attend/contracts';
import type { QrRejectReason } from './qr-token.ts';

/**
 * The check-in decision engine.
 *
 * Two pure steps, no I/O, no framework:
 *   1. `decideClaim` — the QR scan. Validates token, window, device identity and
 *      the student's right to be in this session. Success yields a short-lived
 *      claim; nothing is written to attendance yet.
 *   2. `decideVerification` — the face stage. Turns face scores into the final
 *      attendance status or a rejection.
 *
 * The order of checks is part of the contract: the same broken request always
 * produces the same error code, and cryptographic checks run before any
 * database-derived state so an unsigned token cannot leak enrollment facts.
 */

export type ClaimDecision = { allowed: true } | { allowed: false; code: ErrorCode; detail: string };

export interface ClaimDecisionInput {
  now: Date;
  token: { verified: boolean; reason?: QrRejectReason; sessionId?: string };
  session:
    | {
        id: string;
        status: 'scheduled' | 'open' | 'closed' | 'cancelled';
        checkinOpensAt: Date;
        checkinClosesAt: Date;
      }
    | null;
  enrollmentActive: boolean;
  consentGranted: boolean;
  faceEnrolled: boolean;
  device: { registered: boolean; status: 'active' | 'revoked' | null; fingerprintMatches: boolean };
  webauthnOk: boolean;
  ipAllowed: boolean;
  geofence: { enabled: boolean; inside: boolean; distanceM: number | null };
  alreadyCheckedIn: boolean;
  deviceUsedByOtherStudent: boolean;
}

function reject(code: ErrorCode, detail: string): ClaimDecision {
  return { allowed: false, code, detail };
}

export function decideClaim(input: ClaimDecisionInput): ClaimDecision {
  // 1. Cryptographic proof first: a bad token must not reveal session state.
  if (!input.token.verified) {
    switch (input.token.reason) {
      case 'expired':
        return reject('QR_EXPIRED', 'This QR code has expired. Scan the code on the screen again.');
      case 'bad_signature':
        return reject('QR_SIGNATURE_INVALID', 'This QR code was not issued by the attendance system.');
      default:
        return reject('QR_INVALID', 'This QR code could not be read. Scan the code on the screen again.');
    }
  }

  // 2. Session state.
  if (!input.session) return reject('QR_INVALID', 'Session not found for this QR code.');
  if (input.token.sessionId && input.token.sessionId !== input.session.id) {
    return reject('QR_INVALID', 'This QR code belongs to a different session.');
  }
  if (input.session.status === 'cancelled') {
    return reject('SESSION_CANCELLED', 'This session was cancelled.');
  }
  if (input.session.status === 'closed') {
    return reject('SESSION_CLOSED', 'This session has already closed.');
  }
  if (input.now < input.session.checkinOpensAt) {
    return reject('WINDOW_NOT_OPEN', 'Check-in has not opened yet.');
  }
  if (input.now > input.session.checkinClosesAt) {
    return reject('WINDOW_CLOSED', 'The check-in window has closed.');
  }

  // 3. Eligibility.
  if (!input.enrollmentActive) return reject('NOT_ENROLLED', 'You are not enrolled in this course.');
  if (!input.consentGranted) {
    return reject('CONSENT_REQUIRED', 'Accept the biometric notice before checking in.');
  }
  if (!input.faceEnrolled) return reject('FACE_NOT_ENROLLED', 'Enrol your face before checking in.');

  // 4. Device proof.
  if (!input.device.registered) {
    return reject('DEVICE_NOT_REGISTERED', 'Register this device before checking in.');
  }
  if (input.device.status === 'revoked') {
    return reject('DEVICE_REVOKED', 'This device was revoked. Request a device reset.');
  }
  if (!input.device.fingerprintMatches) {
    return reject('DEVICE_FINGERPRINT_MISMATCH', 'This device does not match your registered device.');
  }

  // 5. WebAuthn assertion over the challenge bound to this claim request.
  if (!input.webauthnOk) return reject('WEBAUTHN_FAILED', 'Device verification failed. Try again.');

  // 6. Network and location policy.
  if (!input.ipAllowed) {
    return reject('IP_NOT_ALLOWED', 'You must be on the campus network for this session.');
  }
  if (input.geofence.enabled && !input.geofence.inside) {
    return reject('GEOFENCE_VIOLATION', 'You are not close enough to the room to check in.');
  }

  // 7. Duplicate and reuse checks last: they need the most state to evaluate.
  if (input.alreadyCheckedIn) {
    return reject('ALREADY_CHECKED_IN', 'You are already checked in for this session.');
  }
  if (input.deviceUsedByOtherStudent) {
    return reject('DEVICE_ALREADY_USED', 'This device has already checked someone else in for this session.');
  }

  return { allowed: true };
}

// --------------------------------------------------------------- face stage

export type VerifyDecision =
  | { outcome: 'present' | 'late' | 'present_flagged'; reasons: string[] }
  | { outcome: 'rejected'; code: ErrorCode; detail: string };

export interface VerifyDecisionInput {
  now: Date;
  lateAfter: Date;
  checkinClosesAt: Date;
  quality: { score: number; threshold: number };
  liveness: { score: number; passed: boolean; threshold: number };
  activeLiveness: { required: boolean; passed: boolean | null };
  similarity: { value: number; threshold: number };
  duplicateFace: boolean;
  risk: { score: number; threshold: number };
  failureCount: number;
  failuresBeforeFlag: number;
}

export function decideVerification(input: VerifyDecisionInput): VerifyDecision {
  // The window is re-checked: the claim may have been open for a minute.
  if (input.now > input.checkinClosesAt) {
    return {
      outcome: 'rejected',
      code: 'WINDOW_CLOSED',
      detail: 'The check-in window closed before verification finished.',
    };
  }

  if (input.activeLiveness.required && input.activeLiveness.passed === false) {
    return {
      outcome: 'rejected',
      code: 'LIVENESS_FAILED',
      detail: 'The liveness challenge was not completed. Try again in better light.',
    };
  }
  if (!input.liveness.passed || input.liveness.score < input.liveness.threshold) {
    return {
      outcome: 'rejected',
      code: 'LIVENESS_FAILED',
      detail: 'Liveness check failed: the capture looks like a photo or a screen.',
    };
  }
  if (input.quality.score < input.quality.threshold) {
    return {
      outcome: 'rejected',
      code: 'FACE_QUALITY_LOW',
      detail: 'The photo is too low quality. Move to better light and hold still.',
    };
  }
  if (input.duplicateFace) {
    return {
      outcome: 'rejected',
      code: 'DUPLICATE_FACE',
      detail: 'This face already checked in for this session on another account.',
    };
  }
  if (input.similarity.value < input.similarity.threshold) {
    return {
      outcome: 'rejected',
      code: 'FACE_MISMATCH',
      detail: 'The face does not match the enrolled student.',
    };
  }

  const reasons: string[] = [];
  if (input.risk.score >= input.risk.threshold) reasons.push('risk_above_threshold');
  if (input.failureCount + 1 >= input.failuresBeforeFlag) reasons.push('repeated_failures');

  if (reasons.length > 0) return { outcome: 'present_flagged', reasons };

  return { outcome: input.now > input.lateAfter ? 'late' : 'present', reasons: [] };
}
