import { z } from 'zod';
import { LIVENESS_CHALLENGES } from '../enums.ts';

/** Frames arrive as base64 (no data-URL prefix) JPEG/WebP, max 5 per request. */
export const FrameSchema = z.string().min(64).max(4_000_000);
export const FramesSchema = z.array(FrameSchema).min(1).max(5);

export const ConsentInput = z.object({
  noticeVersion: z.string().min(1).max(40),
  granted: z.boolean(),
});
export type ConsentInput = z.infer<typeof ConsentInput>;

export const ConsentResponse = z.object({
  noticeVersion: z.string(),
  grantedAt: z.string().nullable(),
  withdrawnAt: z.string().nullable(),
});

export const EnrollInput = z.object({
  frames: FramesSchema,
  challenge: z.enum(LIVENESS_CHALLENGES),
});
export type EnrollInput = z.infer<typeof EnrollInput>;

export const EnrollResponse = z.object({
  enrolled: z.literal(true),
  modelVersion: z.string(),
  qualityScore: z.number(),
  livenessScore: z.number(),
  framesAccepted: z.number(),
});

export const BiometricStatus = z.object({
  consent: z.object({
    noticeVersion: z.string().nullable(),
    grantedAt: z.string().nullable(),
    withdrawnAt: z.string().nullable(),
  }),
  face: z.object({
    enrolled: z.boolean(),
    modelVersion: z.string().nullable(),
    qualityScore: z.number().nullable(),
    enrolledAt: z.string().nullable(),
  }),
  device: z.object({
    bound: z.boolean(),
    platform: z.string().nullable(),
    boundAt: z.string().nullable(),
  }),
});
export type BiometricStatus = z.infer<typeof BiometricStatus>;

/** Payload sent by the API to the face service (internal only). */
export const FaceServiceEnrollRequest = z.object({
  frames: FramesSchema,
  challenge: z.enum(LIVENESS_CHALLENGES),
});
export type FaceServiceEnrollRequest = z.infer<typeof FaceServiceEnrollRequest>;

export const FaceServiceVerifyRequest = z.object({
  frames: FramesSchema,
  challenge: z.enum(LIVENESS_CHALLENGES),
});
export type FaceServiceVerifyRequest = z.infer<typeof FaceServiceVerifyRequest>;

export const FaceServiceResponse = z.object({
  modelVersion: z.string(),
  embedding: z.array(z.number()).length(512),
  qualityScore: z.number(),
  qualityReasons: z.array(z.string()),
  livenessScore: z.number(),
  livenessPassed: z.boolean(),
  framesAccepted: z.number(),
  activeChallengePassed: z.boolean().nullable(),
  processingMs: z.number(),
});
export type FaceServiceResponse = z.infer<typeof FaceServiceResponse>;

export const FaceServiceHealth = z.object({
  status: z.enum(['ok', 'degraded']),
  modelVersion: z.string(),
  modelsLoaded: z.boolean(),
});
