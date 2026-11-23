'use client';

/**
 * Browser-side WebAuthn and device helpers.
 *
 * The passkey lives in the platform authenticator; the credential id is cached
 * locally so the assertion can be scoped to it, with a discoverable-credential
 * fallback if the local cache was cleared.
 */

const INSTALL_ID_KEY = 'attend-install-id';
const CREDENTIAL_KEY = 'attend-credential-id';

export function b64uToBuffer(value: string): ArrayBuffer {
  const normalised = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalised + '='.repeat((4 - (normalised.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export function bufferToB64u(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

async function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('attend', 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('device')) db.createObjectStore('device');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idbGet(key: string): Promise<string | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('device', 'readonly');
      const request = tx.objectStore('device').get(key);
      request.onsuccess = () => resolve(typeof request.result === 'string' ? request.result : null);
      request.onerror = () => reject(request.error);
    });
  } catch {
    return null;
  }
}

async function idbSet(key: string, value: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('device', 'readwrite');
    tx.objectStore('device').put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Random per-install identifier, never derived from the hardware. */
export async function getInstallId(): Promise<string> {
  const existing = await idbGet(INSTALL_ID_KEY);
  if (existing) return existing;
  const created = bufferToB64u(crypto.getRandomValues(new Uint8Array(16)).buffer);
  await idbSet(INSTALL_ID_KEY, created);
  return created;
}

export async function setCredentialId(id: string): Promise<void> {
  await idbSet(CREDENTIAL_KEY, id);
}

export async function getCredentialId(): Promise<string | null> {
  return idbGet(CREDENTIAL_KEY);
}

export function fingerprintFor(): Promise<{ userAgentFamily: string; platform: string; screen: string; installId: string }> {
  return getInstallId().then((installId) => ({
    userAgentFamily: detectBrowser(),
    platform: navigator.platform || 'unknown',
    screen: `${window.screen.width}x${window.screen.height}`,
    installId,
  }));
}

function detectBrowser(): string {
  const ua = navigator.userAgent;
  const match =
    /(Edg|Chrome|Firefox|Safari)\/(\d+)/u.exec(ua) ?? /Version\/(\d+).*Safari/u.exec(ua);
  if (!ua.includes('Safari') && !match) return 'unknown';
  return match ? `${match[1]}/${match[2]}` : 'Safari';
}

export interface RegistrationOptions {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: { type: 'public-key'; alg: number }[];
  authenticatorSelection: {
    authenticatorAttachment: 'platform';
    residentKey: 'required' | 'preferred' | 'discouraged';
    userVerification: 'required' | 'preferred' | 'discouraged';
  };
  timeout: number;
  attestation: 'none' | 'indirect' | 'direct' | 'enterprise';
  excludeCredentials: { id: string; type: 'public-key'; transports?: string[] }[];
  challengeId: string;
}

export async function createPasskey(options: RegistrationOptions): Promise<{
  challengeId: string;
  credential: unknown;
}> {
  const credential = (await navigator.credentials.create({
    publicKey: {
      challenge: b64uToBuffer(options.challenge),
      rp: options.rp,
      user: {
        id: b64uToBuffer(options.user.id),
        name: options.user.name,
        displayName: options.user.displayName,
      },
      pubKeyCredParams: options.pubKeyCredParams,
      authenticatorSelection: options.authenticatorSelection,
      timeout: options.timeout,
      attestation: options.attestation,
      excludeCredentials: options.excludeCredentials.map((entry) => ({
        id: b64uToBuffer(entry.id),
        type: 'public-key' as const,
      })),
    },
  })) as PublicKeyCredential | null;

  if (!credential) throw new Error('Device registration was cancelled.');
  const response = credential.response as AuthenticatorAttestationResponse;
  const id = bufferToB64u(credential.rawId);
  await setCredentialId(id);

  return {
    challengeId: options.challengeId,
    credential: {
      id,
      rawId: id,
      type: 'public-key' as const,
      clientExtensionResults: credential.getClientExtensionResults(),
      response: {
        clientDataJSON: bufferToB64u(response.clientDataJSON),
        attestationObject: bufferToB64u(response.attestationObject),
      },
    },
  };
}

export async function sha256Challenge(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return bufferToB64u(digest);
}

export async function getAssertion(token: string, rpId: string): Promise<unknown> {
  const challenge = await sha256Challenge(token);
  const credentialId = await getCredentialId();

  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: b64uToBuffer(challenge),
      rpId,
      userVerification: 'required',
      timeout: 60_000,
      ...(credentialId
        ? { allowCredentials: [{ id: b64uToBuffer(credentialId), type: 'public-key' as const }] }
        : {}),
    },
  })) as PublicKeyCredential | null;

  if (!assertion) throw new Error('Device verification was cancelled.');
  const response = assertion.response as AuthenticatorAssertionResponse;

  return {
    id: bufferToB64u(assertion.rawId),
    rawId: bufferToB64u(assertion.rawId),
    type: 'public-key' as const,
    clientExtensionResults: assertion.getClientExtensionResults(),
    response: {
      clientDataJSON: bufferToB64u(response.clientDataJSON),
      authenticatorData: bufferToB64u(response.authenticatorData),
      signature: bufferToB64u(response.signature),
      userHandle: response.userHandle ? bufferToB64u(response.userHandle) : null,
    },
  };
}
