import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Rotating QR tokens.
 *
 * A token is `<version>.<payload>.<mac>` where payload is base64url(JSON) and
 * mac is base64url(HMAC-SHA256("<version>.<payload>", per-session secret)).
 * The per-session secret never leaves the API: it is generated when the session
 * starts, stored encrypted, and destroyed when the session closes.
 *
 * Tokens carry their own issue and expiry times so a screen-photo of the QR is
 * useless within `qrExpirySeconds`, without any lookup.
 */

export const QR_TOKEN_VERSION = 'v1';

export interface QrTokenPayload {
  /** version */
  v: 1;
  /** session id */
  sid: string;
  /** single-use nonce for this token */
  n: string;
  /** issued at, epoch seconds */
  iat: number;
  /** expires at, epoch seconds */
  exp: number;
}

export type QrRejectReason = 'malformed' | 'bad_signature' | 'expired' | 'not_yet_valid';

export type QrVerification =
  | { ok: true; payload: QrTokenPayload }
  | { ok: false; reason: QrRejectReason };

export function base64UrlEncode(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

export function base64UrlDecode(input: string): Buffer {
  const normalised = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalised + '='.repeat((4 - (normalised.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

function mac(version: string, payloadSegment: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(`${version}.${payloadSegment}`).digest();
}

export function newNonce(): string {
  return base64UrlEncode(randomBytes(12));
}

export interface IssueOptions {
  sessionId: string;
  secret: string;
  nowMs: number;
  ttlSeconds: number;
  nonce?: string;
}

export function issueQrToken(options: IssueOptions): { token: string; payload: QrTokenPayload } {
  const issuedAt = Math.floor(options.nowMs / 1000);
  const payload: QrTokenPayload = {
    v: 1,
    sid: options.sessionId,
    n: options.nonce ?? newNonce(),
    iat: issuedAt,
    exp: issuedAt + Math.max(1, Math.floor(options.ttlSeconds)),
  };
  const payloadSegment = base64UrlEncode(Buffer.from(JSON.stringify(payload), 'utf8'));
  const signature = base64UrlEncode(mac(QR_TOKEN_VERSION, payloadSegment, options.secret));
  return { token: `${QR_TOKEN_VERSION}.${payloadSegment}.${signature}`, payload };
}

function isPayload(value: unknown): value is QrTokenPayload {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate['v'] === 1 &&
    typeof candidate['sid'] === 'string' &&
    candidate['sid'].length > 0 &&
    typeof candidate['n'] === 'string' &&
    candidate['n'].length > 0 &&
    typeof candidate['iat'] === 'number' &&
    Number.isFinite(candidate['iat']) &&
    typeof candidate['exp'] === 'number' &&
    Number.isFinite(candidate['exp'])
  );
}

export interface VerifyOptions {
  token: string;
  secret: string;
  nowMs: number;
  /** Allowance for client clock skew and network time; never larger than ttl. */
  clockSkewSeconds?: number;
}

export function verifyQrToken(options: VerifyOptions): QrVerification {
  const skew = options.clockSkewSeconds ?? 0;
  const parts = options.token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [version, payloadSegment, signatureSegment] = parts as [string, string, string];
  if (version !== QR_TOKEN_VERSION || !payloadSegment || !signatureSegment) {
    return { ok: false, reason: 'malformed' };
  }

  const expected = mac(version, payloadSegment, options.secret);
  let supplied: Buffer;
  try {
    supplied = base64UrlDecode(signatureSegment);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(base64UrlDecode(payloadSegment).toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!isPayload(payload)) return { ok: false, reason: 'malformed' };

  const nowSeconds = Math.floor(options.nowMs / 1000);
  if (nowSeconds > payload.exp + skew) return { ok: false, reason: 'expired' };
  if (nowSeconds < payload.iat - skew) return { ok: false, reason: 'not_yet_valid' };

  return { ok: true, payload };
}

/** Seconds left before a token expires; used for risk scoring and the QR UI. */
export function secondsUntilExpiry(payload: QrTokenPayload, nowMs: number): number {
  return Math.max(0, payload.exp - Math.floor(nowMs / 1000));
}
