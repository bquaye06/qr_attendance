import { z } from 'zod';
import { ATTENDANCE_STATUSES, LIVENESS_CHALLENGES } from '../enums.ts';
import { AssertionCredentialSchema, DeviceFingerprintSchema } from './devices.ts';

export const ClaimInput = z.object({
  token: z.string().min(10).max(2000),
  credential: AssertionCredentialSchema,
  fingerprint: DeviceFingerprintSchema,
  location: z
    .object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
      accuracyM: z.number().min(0).max(5000),
    })
    .optional(),
});
export type ClaimInput = z.infer<typeof ClaimInput>;

/** The claim closes the QR window: it is single-use, short-lived and bound to the device. */
export const ClaimResponse = z.object({
  claimId: z.string(),
  expiresAt: z.string(),
  challenge: z.enum(LIVENESS_CHALLENGES),
  session: z.object({
    id: z.string().uuid(),
    courseCode: z.string(),
    courseTitle: z.string(),
    roomName: z.string().nullable(),
    checkinClosesAt: z.string(),
  }),
});
export type ClaimResponse = z.infer<typeof ClaimResponse>;

export const VerifyInput = z.object({
  claimId: z.string().min(10).max(120),
  frames: z.array(z.string().min(64).max(4_000_000)).min(1).max(5),
});
export type VerifyInput = z.infer<typeof VerifyInput>;

export const VerifyResponse = z.object({
  status: z.enum(ATTENDANCE_STATUSES),
  checkedInAt: z.string(),
  courseCode: z.string(),
  message: z.string(),
});
export type VerifyResponse = z.infer<typeof VerifyResponse>;

export const StudentAttendanceRecord = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  courseCode: z.string(),
  courseTitle: z.string(),
  startsAt: z.string(),
  status: z.enum(ATTENDANCE_STATUSES),
  method: z.enum(['auto', 'manual']),
  checkedInAt: z.string().nullable(),
  roomName: z.string().nullable(),
});
export type StudentAttendanceRecord = z.infer<typeof StudentAttendanceRecord>;

export const StudentAttendanceSummary = z.object({
  records: z.array(StudentAttendanceRecord),
  perCourse: z.array(
    z.object({
      offeringId: z.string().uuid(),
      courseCode: z.string(),
      courseTitle: z.string(),
      held: z.number().int(),
      attended: z.number().int(),
      percent: z.number(),
      belowThreshold: z.boolean(),
      threshold: z.number().int(),
    }),
  ),
});
export type StudentAttendanceSummary = z.infer<typeof StudentAttendanceSummary>;

export const AppealInput = z.object({
  recordId: z.string().uuid(),
  message: z.string().min(10).max(2000),
});
export type AppealInput = z.infer<typeof AppealInput>;

export const AppealDecisionInput = z.object({
  decision: z.enum(['accepted', 'rejected']),
  note: z.string().min(3).max(1000),
});

export const ClaimHeaders = z.object({
  'idempotency-key': z.string().min(8).max(200),
});
