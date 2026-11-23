import { createHash } from 'node:crypto';

/**
 * Device fingerprint hashing.
 *
 * The browser sends a small, non-PII fingerprint (UA family, platform, screen
 * metrics, random install id, all kept in IndexedDB). We store only a salted
 * hash so the raw values never sit in the database.
 */

export interface DeviceFingerprintInput {
  userAgentFamily: string;
  platform: string;
  screen: string;
  installId: string;
}

/** Stable JSON: keys sorted, whitespace removed, values trimmed and lowercased. */
export function canonicalFingerprint(input: DeviceFingerprintInput): string {
  const normalised = {
    installId: input.installId.trim(),
    platform: input.platform.trim().toLowerCase(),
    screen: input.screen.trim().toLowerCase(),
    userAgentFamily: input.userAgentFamily.trim().toLowerCase(),
  };
  const ordered = Object.keys(normalised)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${JSON.stringify(normalised[key as keyof typeof normalised])}`)
    .join(',');
  return `{${ordered}}`;
}

export function hashFingerprint(input: DeviceFingerprintInput, salt: string): string {
  return createHash('sha256').update(`${salt}:${canonicalFingerprint(input)}`).digest('hex');
}

/** Compare two hashes without leaking length or timing information. */
export function fingerprintMatches(expected: string, actual: string): boolean {
  if (expected.length !== actual.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  return diff === 0;
}
