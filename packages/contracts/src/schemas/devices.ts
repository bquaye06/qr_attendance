import { z } from 'zod';
import { DEVICE_STATUSES, LIVENESS_CHALLENGES, RESET_REQUEST_STATUSES } from '../enums.ts';

/** Non-PII device fingerprint produced in the browser. */
export const DeviceFingerprintSchema = z.object({
  userAgentFamily: z.string().min(1).max(80),
  platform: z.string().min(1).max(40),
  screen: z.string().min(1).max(40),
  installId: z.string().min(8).max(80),
});
export type DeviceFingerprint = z.infer<typeof DeviceFingerprintSchema>;

/** Public-key credential JSON as produced by `navigator.credentials.create()`. */
export const RegistrationCredentialSchema = z.object({
  id: z.string().min(1),
  rawId: z.string().min(1),
  type: z.literal('public-key'),
  clientExtensionResults: z.record(z.unknown()).optional(),
  response: z.object({
    clientDataJSON: z.string().min(1),
    attestationObject: z.string().min(1),
    transports: z.array(z.string()).optional(),
  }),
});
export type RegistrationCredentialJSON = z.infer<typeof RegistrationCredentialSchema>;

export const AssertionCredentialSchema = z.object({
  id: z.string().min(1),
  rawId: z.string().min(1),
  type: z.literal('public-key'),
  clientExtensionResults: z.record(z.unknown()).optional(),
  response: z.object({
    clientDataJSON: z.string().min(1),
    authenticatorData: z.string().min(1),
    signature: z.string().min(1),
    userHandle: z.string().nullable().optional(),
  }),
});
export type AssertionCredentialJSON = z.infer<typeof AssertionCredentialSchema>;

export const DeviceRegisterInput = z.object({
  /** Challenge row id returned by POST /devices/register/options */
  challengeId: z.string().uuid(),
  credential: RegistrationCredentialSchema,
  fingerprint: DeviceFingerprintSchema,
});
export type DeviceRegisterInput = z.infer<typeof DeviceRegisterInput>;

export const PublicKeyCredentialDescriptorSchema = z.object({
  id: z.string(),
  type: z.literal('public-key'),
  transports: z.array(z.string()).optional(),
});

export const DeviceRegisterOptionsResponse = z.object({
  challenge: z.string(),
  rp: z.object({ id: z.string(), name: z.string() }),
  user: z.object({ id: z.string(), name: z.string(), displayName: z.string() }),
  pubKeyCredParams: z.array(z.object({ type: z.literal('public-key'), alg: z.number() })),
  authenticatorSelection: z.object({
    authenticatorAttachment: z.literal('platform'),
    residentKey: z.enum(['required', 'preferred', 'discouraged']),
    userVerification: z.enum(['required', 'preferred', 'discouraged']),
  }),
  timeout: z.number(),
  attestation: z.enum(['none', 'indirect', 'direct', 'enterprise']),
  excludeCredentials: z.array(PublicKeyCredentialDescriptorSchema),
  challengeId: z.string(),
});
export type DeviceRegisterOptionsResponse = z.infer<typeof DeviceRegisterOptionsResponse>;

export const DeviceSummary = z.object({
  id: z.string().uuid(),
  studentId: z.string().uuid(),
  studentName: z.string(),
  studentNumber: z.string(),
  status: z.enum(DEVICE_STATUSES),
  platform: z.string(),
  userAgentFamily: z.string(),
  boundAt: z.string(),
  revokedAt: z.string().nullable(),
});
export type DeviceSummary = z.infer<typeof DeviceSummary>;

export const DeviceResetRequestInput = z.object({
  reason: z.string().min(5).max(500),
});

export const DeviceResetDecisionInput = z.object({
  decision: z.enum(['approved', 'rejected']),
  note: z.string().max(500).optional(),
});

export const DeviceResetRequestSummary = z.object({
  id: z.string().uuid(),
  studentId: z.string().uuid(),
  studentName: z.string(),
  studentNumber: z.string(),
  reason: z.string(),
  status: z.enum(RESET_REQUEST_STATUSES),
  requestedAt: z.string(),
  decidedAt: z.string().nullable(),
  decidedBy: z.string().nullable(),
});

export const LivenessChallengeSchema = z.enum(LIVENESS_CHALLENGES);
