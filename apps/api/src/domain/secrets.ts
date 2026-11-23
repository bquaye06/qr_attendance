import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Envelope encryption for the few secrets the database holds: per-session QR
 * signing secrets, face templates and TOTP seeds. AES-256-GCM, random IV per
 * value, key from the environment (managed secret store in production).
 *
 * Wire format: `v1.<iv-b64url>.<tag-b64url>.<ciphertext-b64url>`.
 */

const VERSION = 'v1';
const IV_BYTES = 12;

export class SecretKeyError extends Error {}

function b64u(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

function fromB64u(value: string): Buffer {
  const normalised = value.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalised + '='.repeat((4 - (normalised.length % 4)) % 4), 'base64');
}

/** Accepts a 32-byte key as base64, hex or raw utf8 passphrase (hashed). */
export function parseMasterKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new SecretKeyError('master key is empty');
  const candidates: Buffer[] = [];
  if (/^[0-9a-fA-F]{64}$/u.test(trimmed)) candidates.push(Buffer.from(trimmed, 'hex'));
  try {
    const decoded = Buffer.from(trimmed, 'base64');
    if (decoded.length === 32) candidates.push(decoded);
  } catch {
    // not base64; fall through
  }
  const first = candidates[0];
  if (first && first.length === 32) return first;
  // Passphrase fallback: derive a stable 32-byte key so misconfigured
  // environments still start, but make it obvious in the docs that a real
  // 32-byte key is required.
  return createHash('sha256').update(trimmed, 'utf8').digest();
}

export function encryptSecret(plaintext: string, key: Buffer): string {
  if (key.length !== 32) throw new SecretKeyError('AES-256-GCM requires a 32-byte key');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, b64u(iv), b64u(tag), b64u(ciphertext)].join('.');
}

export function decryptSecret(payload: string, key: Buffer): string {
  if (key.length !== 32) throw new SecretKeyError('AES-256-GCM requires a 32-byte key');
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) throw new SecretKeyError('unrecognised ciphertext');
  const [, ivPart, tagPart, dataPart] = parts as [string, string, string, string];
  const decipher = createDecipheriv('aes-256-gcm', key, fromB64u(ivPart));
  decipher.setAuthTag(fromB64u(tagPart));
  return Buffer.concat([decipher.update(fromB64u(dataPart)), decipher.final()]).toString('utf8');
}

/** Per-session QR signing secret (32 random bytes, base64url). */
export function newSessionSecret(): string {
  return b64u(randomBytes(32));
}
