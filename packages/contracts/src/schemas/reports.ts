import { z } from 'zod';
import { ATTENDANCE_STATUSES } from '../enums.ts';

export const ReportFormatQuery = z.object({
  format: z.enum(['json', 'csv', 'pdf', 'xlsx']).default('json'),
});
export type ReportFormatQuery = z.infer<typeof ReportFormatQuery>;

export const CourseReportQuery = z.object({
  offeringId: z.string().uuid(),
  format: z.enum(['json', 'csv', 'pdf', 'xlsx']).default('json'),
});
export type CourseReportQuery = z.infer<typeof CourseReportQuery>;

export const RangeReportQuery = z.object({
  from: z.string().date(),
  to: z.string().date(),
  facultyId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional(),
  format: z.enum(['json', 'csv', 'pdf', 'xlsx']).default('json'),
});
export type RangeReportQuery = z.infer<typeof RangeReportQuery>;

export const SessionReportQuery = z.object({
  sessionId: z.string().uuid(),
  format: z.enum(['json', 'csv', 'pdf', 'xlsx']).default('json'),
});

/** Student × session matrix for one course offering. */
export const CourseMatrix = z.object({
  offeringId: z.string().uuid(),
  courseCode: z.string(),
  courseTitle: z.string(),
  termName: z.string(),
  threshold: z.number().int(),
  sessions: z.array(
    z.object({
      sessionId: z.string().uuid(),
      startsAt: z.string(),
      status: z.string(),
    }),
  ),
  students: z.array(
    z.object({
      studentId: z.string().uuid(),
      studentNumber: z.string(),
      name: z.string(),
      cells: z.array(z.enum(ATTENDANCE_STATUSES).nullable()),
      attended: z.number().int(),
      held: z.number().int(),
      percent: z.number(),
      belowThreshold: z.boolean(),
    }),
  ),
});
export type CourseMatrix = z.infer<typeof CourseMatrix>;

export const DashboardResponse = z.object({
  today: z.object({
    sessionsScheduled: z.number().int(),
    sessionsOpen: z.number().int(),
    attendanceRate: z.number(),
    checkins: z.number().int(),
  }),
  term: z.object({
    attendanceRate: z.number(),
    sessionsHeld: z.number().int(),
    checkins: z.number().int(),
  }),
  byFaculty: z.array(
    z.object({
      facultyId: z.string().uuid(),
      name: z.string(),
      attendanceRate: z.number(),
      checkins: z.number().int(),
    }),
  ),
  flagged24h: z.number().int(),
  failed24h: z.number().int(),
  faceService: z.object({
    status: z.enum(['ok', 'degraded', 'down']),
    p95Ms: z.number().nullable(),
    modelVersion: z.string().nullable(),
  }),
  pendingResets: z.number().int(),
  pendingReviews: z.number().int(),
});
export type DashboardResponse = z.infer<typeof DashboardResponse>;

export const AuditEntry = z.object({
  id: z.string().uuid(),
  actorId: z.string().uuid().nullable(),
  actorName: z.string().nullable(),
  action: z.string(),
  entity: z.string(),
  entityId: z.string().uuid().nullable(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  ip: z.string().nullable(),
  at: z.string(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;

export const HealthResponse = z.object({
  status: z.enum(['ok', 'degraded']),
  db: z.enum(['ok', 'down']),
  redis: z.enum(['ok', 'down']),
  face: z.enum(['ok', 'degraded', 'down']),
  queueDepth: z.number().int(),
  failedJobs: z.number().int(),
  modelVersion: z.string().nullable(),
  version: z.string(),
});
