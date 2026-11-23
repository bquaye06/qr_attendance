import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * RFC 6238 TOTP (SHA-1, 6 digits, 30 s step) for staff second factors, and
 * RFC 4648 base32 for the shared secret. Implemented on node:crypto so the API
 * has no native build dependency for its second factor.
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/gu, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export interface TotpOptions {
  digits?: number;
  stepSeconds?: number;
}

function hotp(secret: Buffer, counter: number, digits: number): string {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secret).update(buffer).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return (binary % 10 ** digits).toString().padStart(digits, '0');
}

export function generateTotpSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

export function totpCode(secretBase32: string, nowMs: number, options: TotpOptions = {}): string {
  const digits = options.digits ?? 6;
  const step = options.stepSeconds ?? 30;
  const counter = Math.floor(nowMs / 1000 / step);
  return hotp(base32Decode(secretBase32), counter, digits);
}

export interface VerifyTotpOptions extends TotpOptions {
  /** Accept codes from ±window steps to absorb clock drift. */
  window?: number;
}

/**
 * Constant-time code comparison. Returns the matched step so callers can
 * reject replay of an already-used code.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  nowMs: number,
  options: VerifyTotpOptions = {},
): { ok: boolean; step?: number } {
  const digits = options.digits ?? 6;
  const step = options.stepSeconds ?? 30;
  const window = options.window ?? 1;
  const trimmed = code.replace(/\s+/gu, '');
  if (!/^\d+$/u.test(trimmed) || trimmed.length !== digits) return { ok: false };

  const secret = base32Decode(secretBase32);
  const current = Math.floor(nowMs / 1000 / step);
  for (let offset = -window; offset <= window; offset += 1) {
    const candidate = hotp(secret, current + offset, digits);
    const a = Buffer.from(candidate);
    const b = Buffer.from(trimmed);
    if (a.length === b.length && timingSafeEqual(a, b)) {
      return { ok: true, step: current + offset };
    }
  }
  return { ok: false };
}

export function otpauthUrl(secretBase32: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
