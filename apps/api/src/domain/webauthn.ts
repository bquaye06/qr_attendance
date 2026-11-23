import { createHash, createPublicKey, randomBytes, verify as cryptoVerify, timingSafeEqual } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

/**
 * WebAuthn verification for device binding (passkeys).
 *
 * Scope: we only need to *verify* credentials our own PWA creates, so we parse
 * the attestation object for the credential public key (attestation statement
 * signatures are not trusted — `attestation: none` — which is what the spec
 * asks for: platform authenticator, no attestation trust chain).
 *
 * Everything here is pure node:crypto; no third-party WebAuthn library.
 */

// ------------------------------------------------------------------ base64url

export function b64uToBuffer(value: string): Buffer {
  const normalised = value.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalised + '='.repeat((4 - (normalised.length % 4)) % 4), 'base64');
}

export function bufferToB64u(value: Buffer | Uint8Array): string {
  return Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

// ---------------------------------------------------------------------- CBOR

type CborValue =
  | number
  | string
  | Uint8Array
  | boolean
  | null
  | CborValue[]
  | { [key: string]: CborValue };

interface CborDecoded {
  value: CborValue;
  bytesRead: number;
}

function decodeItem(buffer: Buffer, offset: number, depth = 0): CborDecoded {
  if (depth > 16) throw new Error('cbor: nesting too deep');
  if (offset >= buffer.length) throw new Error('cbor: unexpected end of input');

  const initial = buffer[offset]!;
  const major = initial >> 5;
  const additional = initial & 0x1f;
  let cursor = offset + 1;

  const readLength = (info: number): { length: number; indefinite: boolean } => {
    if (info < 24) return { length: info, indefinite: false };
    if (info === 24) {
      const length = buffer[cursor]!;
      cursor += 1;
      return { length, indefinite: false };
    }
    if (info === 25) {
      const length = buffer.readUInt16BE(cursor);
      cursor += 2;
      return { length, indefinite: false };
    }
    if (info === 26) {
      const length = buffer.readUInt32BE(cursor);
      cursor += 4;
      return { length, indefinite: false };
    }
    if (info === 27) {
      const length = Number(buffer.readBigUInt64BE(cursor));
      cursor += 8;
      return { length, indefinite: false };
    }
    if (info === 31) return { length: 0, indefinite: true };
    throw new Error(`cbor: reserved additional info ${info}`);
  };

  switch (major) {
    case 0: {
      const { length } = readLength(additional);
      return { value: length, bytesRead: cursor - offset };
    }
    case 1: {
      const { length } = readLength(additional);
      return { value: -1 - length, bytesRead: cursor - offset };
    }
    case 2: {
      const { length, indefinite } = readLength(additional);
      if (indefinite) {
        const chunks: Buffer[] = [];
        for (;;) {
          if (buffer[cursor] === 0xff) {
            cursor += 1;
            break;
          }
          const chunk = decodeItem(buffer, cursor, depth + 1);
          chunks.push(Buffer.from(chunk.value as Uint8Array));
          cursor += chunk.bytesRead;
        }
        return { value: Buffer.concat(chunks), bytesRead: cursor - offset };
      }
      const bytes = buffer.subarray(cursor, cursor + length);
      cursor += length;
      return { value: new Uint8Array(bytes), bytesRead: cursor - offset };
    }
    case 3: {
      const { length, indefinite } = readLength(additional);
      if (indefinite) {
        let text = '';
        for (;;) {
          if (buffer[cursor] === 0xff) {
            cursor += 1;
            break;
          }
          const chunk = decodeItem(buffer, cursor, depth + 1);
          text += String(chunk.value);
          cursor += chunk.bytesRead;
        }
        return { value: text, bytesRead: cursor - offset };
      }
      const text = buffer.subarray(cursor, cursor + length).toString('utf8');
      cursor += length;
      return { value: text, bytesRead: cursor - offset };
    }
    case 4: {
      const { length, indefinite } = readLength(additional);
      const items: CborValue[] = [];
      if (indefinite) {
        for (;;) {
          if (buffer[cursor] === 0xff) {
            cursor += 1;
            break;
          }
          const item = decodeItem(buffer, cursor, depth + 1);
          items.push(item.value);
          cursor += item.bytesRead;
        }
      } else {
        for (let i = 0; i < length; i += 1) {
          const item = decodeItem(buffer, cursor, depth + 1);
          items.push(item.value);
          cursor += item.bytesRead;
        }
      }
      return { value: items, bytesRead: cursor - offset };
    }
    case 5: {
      const { length, indefinite } = readLength(additional);
      const map: Record<string, CborValue> = {};
      const readPair = (): void => {
        const key = decodeItem(buffer, cursor, depth + 1);
        cursor += key.bytesRead;
        const value = decodeItem(buffer, cursor, depth + 1);
        cursor += value.bytesRead;
        map[String(key.value)] = value.value;
      };
      if (indefinite) {
        for (;;) {
          if (buffer[cursor] === 0xff) {
            cursor += 1;
            break;
          }
          readPair();
        }
      } else {
        for (let i = 0; i < length; i += 1) readPair();
      }
      return { value: map, bytesRead: cursor - offset };
    }
    case 6: {
      const tag = decodeItem(buffer, cursor, depth + 1);
      cursor += tag.bytesRead;
      const inner = decodeItem(buffer, cursor, depth + 1);
      cursor += inner.bytesRead;
      return { value: inner.value, bytesRead: cursor - offset };
    }
    case 7: {
      if (additional === 20) return { value: false, bytesRead: 1 };
      if (additional === 21) return { value: true, bytesRead: 1 };
      if (additional === 22) return { value: null, bytesRead: 1 };
      if (additional === 25) {
        cursor += 2;
        return { value: 0, bytesRead: cursor - offset };
      }
      if (additional === 26) {
        const value = buffer.readFloatBE(cursor);
        cursor += 4;
        return { value, bytesRead: cursor - offset };
      }
      if (additional === 27) {
        const value = buffer.readDoubleBE(cursor);
        cursor += 8;
        return { value, bytesRead: cursor - offset };
      }
      throw new Error(`cbor: unsupported simple value ${additional}`);
    }
    default:
      throw new Error(`cbor: unsupported major type ${major}`);
  }
}

export function decodeCbor(buffer: Buffer): CborDecoded {
  return decodeItem(buffer, 0);
}

// ------------------------------------------------------- authenticator data

export interface AuthenticatorData {
  rpIdHash: Buffer;
  flags: { userPresent: boolean; userVerified: boolean; attestedCredentialData: boolean };
  signCount: number;
  aaguid: string | null;
  credentialId: string | null;
  credentialPublicKey: Buffer | null;
  extensions: Buffer | null;
  raw: Buffer;
}

export function parseAuthenticatorData(buffer: Buffer): AuthenticatorData {
  if (buffer.length < 37) throw new Error('authenticatorData: too short');
  const rpIdHash = buffer.subarray(0, 32);
  const flagByte = buffer[32]!;
  const signCount = buffer.readUInt32BE(33);
  const userPresent = (flagByte & 0x01) !== 0;
  const userVerified = (flagByte & 0x04) !== 0;
  const attestedCredentialData = (flagByte & 0x40) !== 0;
  const extensionData = (flagByte & 0x80) !== 0;

  let cursor = 37;
  let aaguid: string | null = null;
  let credentialId: string | null = null;
  let credentialPublicKey: Buffer | null = null;
  let extensions: Buffer | null = null;

  if (attestedCredentialData) {
    if (buffer.length < cursor + 18) throw new Error('authenticatorData: truncated credential data');
    aaguid = buffer
      .subarray(cursor, cursor + 16)
      .toString('hex')
      .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/u, '$1-$2-$3-$4-$5');
    cursor += 16;
    const credentialIdLength = buffer.readUInt16BE(cursor);
    cursor += 2;
    if (buffer.length < cursor + credentialIdLength) {
      throw new Error('authenticatorData: truncated credential id');
    }
    credentialId = bufferToB64u(buffer.subarray(cursor, cursor + credentialIdLength));
    cursor += credentialIdLength;
    const key = decodeItem(buffer, cursor);
    const keyLength = key.bytesRead;
    credentialPublicKey = Buffer.from(buffer.subarray(cursor, cursor + keyLength));
    cursor += keyLength;
  }

  if (extensionData) {
    extensions = Buffer.from(buffer.subarray(cursor));
  }

  return {
    rpIdHash,
    flags: { userPresent, userVerified, attestedCredentialData },
    signCount,
    aaguid,
    credentialId,
    credentialPublicKey,
    extensions,
    raw: buffer,
  };
}

// ------------------------------------------------------------- COSE -> JWK

const COSE_KTY_EC2 = 2;
const COSE_KTY_RSA = 3;
const COSE_KTY_OKP = 1;

const COSE_ALG_ES256 = -7;
const COSE_ALG_EDDSA = -8;
const COSE_ALG_RS256 = -257;

export interface PublicKeyMaterial {
  keyObject: KeyObject;
  algorithm: 'ES256' | 'RS256' | 'EdDSA';
}

export function coseToPublicKey(coseBytes: Buffer): PublicKeyMaterial {
  const decoded = decodeCbor(coseBytes);
  const cose = decoded.value as Record<string, CborValue>;
  const kty = Number(cose['1']);
  const alg = Number(cose['3']);

  if (kty === COSE_KTY_EC2) {
    const crvId = Number(cose['-1']);
    const crv = crvId === 1 ? 'P-256' : crvId === 2 ? 'P-384' : crvId === 3 ? 'P-521' : null;
    if (!crv) throw new Error(`cose: unsupported EC curve ${crvId}`);
    const jwk = {
      kty: 'EC',
      crv,
      x: bufferToB64u(cose['-2'] as Uint8Array),
      y: bufferToB64u(cose['-3'] as Uint8Array),
    };
    return {
      keyObject: createPublicKey({ key: jwk, format: 'jwk' }),
      algorithm: alg === COSE_ALG_ES256 ? 'ES256' : 'ES256',
    };
  }

  if (kty === COSE_KTY_RSA) {
    const jwk = {
      kty: 'RSA',
      n: bufferToB64u(cose['-1'] as Uint8Array),
      e: bufferToB64u(cose['-2'] as Uint8Array),
    };
    return { keyObject: createPublicKey({ key: jwk, format: 'jwk' }), algorithm: 'RS256' };
  }

  if (kty === COSE_KTY_OKP) {
    const crvId = Number(cose['-1']);
    if (crvId !== 6) throw new Error('cose: only Ed25519 OKP keys are supported');
    const jwk = {
      kty: 'OKP',
      crv: 'Ed25519',
      x: bufferToB64u(cose['-2'] as Uint8Array),
    };
    return {
      keyObject: createPublicKey({ key: jwk, format: 'jwk' }),
      algorithm: alg === COSE_ALG_EDDSA ? 'EdDSA' : 'EdDSA',
    };
  }

  throw new Error(`cose: unsupported kty ${kty}`);
}

// ------------------------------------------------------------- client data

export interface ClientData {
  type: string;
  challenge: string;
  origin: string;
  crossOrigin: boolean;
}

export function parseClientData(clientDataJSON: string): ClientData {
  const raw = JSON.parse(b64uToBuffer(clientDataJSON).toString('utf8')) as Record<string, unknown>;
  if (typeof raw['type'] !== 'string' || typeof raw['challenge'] !== 'string') {
    throw new Error('clientData: missing type or challenge');
  }
  return {
    type: raw['type'],
    challenge: raw['challenge'],
    origin: typeof raw['origin'] === 'string' ? raw['origin'] : '',
    crossOrigin: raw['crossOrigin'] === true,
  };
}

function challengesMatch(expected: string, actual: string): boolean {
  const a = b64uToBuffer(expected);
  const b = b64uToBuffer(actual);
  if (a.length === b.length) return timingSafeEqual(a, b);
  // Accept a client that echoes the challenge as an unpadded string.
  return Buffer.from(expected).equals(Buffer.from(actual));
}

export type WebAuthnFailure =
  | 'malformed'
  | 'client_data_type'
  | 'challenge_mismatch'
  | 'origin_mismatch'
  | 'rp_id_mismatch'
  | 'user_not_present'
  | 'user_not_verified'
  | 'counter_regression'
  | 'signature_invalid'
  | 'unknown_credential';

export type WebAuthnResult<T> = { ok: true; value: T } | { ok: false; reason: WebAuthnFailure };

export interface RegistrationVerificationInput {
  rpId: string;
  allowedOrigins: readonly string[];
  expectedChallenge: string;
  clientDataJSON: string;
  attestationObject: string;
  rawId: string;
  requireUserVerification?: boolean;
}

export interface RegistrationVerification {
  credentialId: string;
  publicKeyCose: string;
  signCount: number;
  aaguid: string | null;
}

export function verifyRegistration(
  input: RegistrationVerificationInput,
): WebAuthnResult<RegistrationVerification> {
  let clientData: ClientData;
  try {
    clientData = parseClientData(input.clientDataJSON);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (clientData.type !== 'webauthn.create') return { ok: false, reason: 'client_data_type' };
  if (!challengesMatch(input.expectedChallenge, clientData.challenge)) {
    return { ok: false, reason: 'challenge_mismatch' };
  }
  if (!input.allowedOrigins.includes(clientData.origin)) {
    return { ok: false, reason: 'origin_mismatch' };
  }

  let authDataBuffer: Buffer;
  try {
    const attestation = decodeCbor(b64uToBuffer(input.attestationObject));
    const map = attestation.value as Record<string, CborValue>;
    authDataBuffer = Buffer.from(map['authData'] as Uint8Array);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  let authData: AuthenticatorData;
  try {
    authData = parseAuthenticatorData(authDataBuffer);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  const expectedRpIdHash = createHash('sha256').update(input.rpId).digest();
  if (!timingSafeEqual(authData.rpIdHash, expectedRpIdHash)) {
    return { ok: false, reason: 'rp_id_mismatch' };
  }
  if (!authData.flags.userPresent) return { ok: false, reason: 'user_not_present' };
  if (input.requireUserVerification !== false && !authData.flags.userVerified) {
    return { ok: false, reason: 'user_not_verified' };
  }
  if (!authData.credentialPublicKey || !authData.credentialId) {
    return { ok: false, reason: 'malformed' };
  }

  return {
    ok: true,
    value: {
      credentialId: input.rawId,
      publicKeyCose: authData.credentialPublicKey.toString('base64'),
      signCount: authData.signCount,
      aaguid: authData.aaguid,
    },
  };
}

export interface AssertionVerificationInput {
  rpId: string;
  allowedOrigins: readonly string[];
  expectedChallenge: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
  credentialId: string;
  publicKeyCose: string;
  storedSignCount: number;
  requireUserVerification?: boolean;
}

export interface AssertionVerification {
  newSignCount: number;
}

export function verifyAssertion(
  input: AssertionVerificationInput,
): WebAuthnResult<AssertionVerification> {
  let clientData: ClientData;
  try {
    clientData = parseClientData(input.clientDataJSON);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (clientData.type !== 'webauthn.get') return { ok: false, reason: 'client_data_type' };
  if (!challengesMatch(input.expectedChallenge, clientData.challenge)) {
    return { ok: false, reason: 'challenge_mismatch' };
  }
  if (!input.allowedOrigins.includes(clientData.origin)) {
    return { ok: false, reason: 'origin_mismatch' };
  }

  let authDataBuffer: Buffer;
  let authData: AuthenticatorData;
  let key: PublicKeyMaterial;
  let signature: Buffer;
  try {
    authDataBuffer = b64uToBuffer(input.authenticatorData);
    authData = parseAuthenticatorData(authDataBuffer);
    key = coseToPublicKey(Buffer.from(input.publicKeyCose, 'base64'));
    signature = b64uToBuffer(input.signature);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  const expectedRpIdHash = createHash('sha256').update(input.rpId).digest();
  if (!timingSafeEqual(authData.rpIdHash, expectedRpIdHash)) {
    return { ok: false, reason: 'rp_id_mismatch' };
  }
  if (!authData.flags.userPresent) return { ok: false, reason: 'user_not_present' };
  if (input.requireUserVerification !== false && !authData.flags.userVerified) {
    return { ok: false, reason: 'user_not_verified' };
  }

  if (authData.signCount !== 0 && input.storedSignCount !== 0 && authData.signCount <= input.storedSignCount) {
    return { ok: false, reason: 'counter_regression' };
  }

  const clientDataHash = createHash('sha256').update(b64uToBuffer(input.clientDataJSON)).digest();
  const signedData = Buffer.concat([authDataBuffer, clientDataHash]);
  const verified =
    key.algorithm === 'EdDSA'
      ? cryptoVerify(null, signedData, key.keyObject, signature)
      : cryptoVerify('sha256', signedData, key.keyObject, signature);

  if (!verified) return { ok: false, reason: 'signature_invalid' };
  return { ok: true, value: { newSignCount: authData.signCount } };
}

/** Deterministic RP ID from the public origin: protocol and port are dropped. */
export function rpIdFromOrigin(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return origin;
  }
}

export function challengeFromBytes(bytes: Buffer): string {
  return bufferToB64u(bytes);
}

export function newChallenge(): string {
  // 32 random bytes, echoed back by the authenticator in clientDataJSON.
  return bufferToB64u(randomBytes(32));
}
