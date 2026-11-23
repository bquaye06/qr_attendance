import { z } from 'zod';
import { ATTENDANCE_STATUSES, SESSION_STATUSES, TEACHING_ROLES } from '../enums.ts';

export const SessionSummary = z.object({
  id: z.string().uuid(),
  offeringId: z.string().uuid(),
  courseCode: z.string(),
  courseTitle: z.string(),
  roomName: z.string().nullable(),
  startsAt: z.string(),
  endsAt: z.string(),
  checkinOpensAt: z.string(),
  checkinClosesAt: z.string(),
  lateAfter: z.string(),
  status: z.enum(SESSION_STATUSES),
  geofenceEnabled: z.boolean(),
  enrolledCount: z.number().int(),
  presentCount: z.number().int(),
  lateCount: z.number().int(),
  flaggedCount: z.number().int(),
  absentCount: z.number().int(),
});
export type SessionSummary = z.infer<typeof SessionSummary>;

export const StartSessionInput = z.object({
  checkinClosesOffsetMinutes: z.number().int().min(1).max(240).optional(),
  lateAfterMinutes: z.number().int().min(0).max(240).optional(),
  geofenceEnabled: z.boolean().optional(),
});
export type StartSessionInput = z.infer<typeof StartSessionInput>;

export const CloseSessionInput = z.object({
  reason: z.string().max(500).optional(),
});

export const ExtendWindowInput = z.object({
  minutes: z.number().int().min(1).max(120),
  reason: z.string().min(3).max(300),
});
export type ExtendWindowInput = z.infer<typeof ExtendWindowInput>;

/** One rotating QR token, streamed to the lecturer screen over SSE. */
export const QrTokenEvent = z.object({
  token: z.string(),
  issuedAt: z.string(),
  expiresAt: z.string(),
  rotationSeconds: z.number().int(),
  sessionId: z.string().uuid(),
});
export type QrTokenEvent = z.infer<typeof QrTokenEvent>;

export const RosterEntry = z.object({
  studentId: z.string().uuid(),
  studentNumber: z.string(),
  name: z.string(),
  status: z.enum(ATTENDANCE_STATUSES),
  method: z.enum(['auto', 'manual']).nullable(),
  checkedInAt: z.string().nullable(),
  flagReason: z.string().nullable(),
  riskScore: z.number().int().nullable(),
  attempted: z.boolean(),
});
export type RosterEntry = z.infer<typeof RosterEntry>;

export const RosterResponse = z.object({
  session: SessionSummary,
  entries: z.array(RosterEntry),
});
export type RosterResponse = z.infer<typeof RosterResponse>;

export const RosterEvent = z.object({
  sessionId: z.string().uuid(),
  counts: z.object({
    enrolled: z.number().int(),
    present: z.number().int(),
    late: z.number().int(),
    flagged: z.number().int(),
    absent: z.number().int(),
    excused: z.number().int(),
  }),
  entries: z.array(RosterEntry),
});
export type RosterEvent = z.infer<typeof RosterEvent>;

export const ManualAttendanceInput = z.object({
  status: z.enum(['present_manual', 'excused', 'absent']),
  reason: z.string().min(3).max(500),
});
export type ManualAttendanceInput = z.infer<typeof ManualAttendanceInput>;

export const BulkExcuseInput = z.object({
  studentIds: z.array(z.string().uuid()).min(1).max(500),
  reason: z.string().min(3).max(500),
});
export type BulkExcuseInput = z.infer<typeof BulkExcuseInput>;

export const SessionHistoryEntry = z.object({
  sessionId: z.string().uuid(),
  startsAt: z.string(),
  roomName: z.string().nullable(),
  status: z.enum(SESSION_STATUSES),
  present: z.number().int(),
  absent: z.number().int(),
});

export const TeachingAssignmentSummary = z.object({
  offeringId: z.string().uuid(),
  courseCode: z.string(),
  courseTitle: z.string(),
  role: z.enum(TEACHING_ROLES),
  studentCount: z.number().int(),
});
