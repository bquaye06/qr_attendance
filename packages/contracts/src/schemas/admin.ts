import { z } from 'zod';
import {
  APPEAL_STATUSES,
  ATTENDANCE_STATUSES,
  REVIEW_STATES,
  SCOPE_TYPES,
  SYSTEM_ROLES,
  USER_STATUSES,
} from '../enums.ts';
import { PERMISSIONS } from '../permissions.ts';
import { SettingsSchema } from '../settings.ts';

export const UuidSchema = z.string().uuid();

// ---------------------------------------------------------------- structure
export const FacultyInput = z.object({
  name: z.string().min(2).max(120),
  code: z.string().min(2).max(16),
});
export const DepartmentInput = FacultyInput.extend({ facultyId: UuidSchema });

export const ProgrammeInput = z.object({
  name: z.string().min(2).max(120),
  code: z.string().min(2).max(16),
  departmentId: UuidSchema,
});

export const TermInput = z.object({
  name: z.string().min(2).max(60),
  startsOn: z.string().date(),
  endsOn: z.string().date(),
  isCurrent: z.boolean().default(false),
});

export const CourseInput = z.object({
  code: z.string().min(2).max(20),
  title: z.string().min(2).max(160),
  departmentId: UuidSchema,
  creditHours: z.number().int().min(1).max(12).default(3),
});

export const OfferingInput = z.object({
  courseId: UuidSchema,
  termId: UuidSchema,
  section: z.string().min(1).max(10).default('A'),
  capacity: z.number().int().min(1).max(2000).optional(),
});

export const RoomInput = z.object({
  name: z.string().min(1).max(80),
  building: z.string().max(80).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  geofenceM: z.number().int().min(20).max(2000).default(100),
  allowedCidrs: z.array(z.string().min(7).max(43)).max(20).default([]),
});

// ---------------------------------------------------------------- people
export const StudentInput = z.object({
  email: z.string().email(),
  name: z.string().min(2).max(120),
  studentNumber: z.string().min(2).max(32),
  programmeId: UuidSchema,
  year: z.number().int().min(1).max(8),
});

export const LecturerInput = z.object({
  email: z.string().email(),
  name: z.string().min(2).max(120),
  staffNumber: z.string().min(2).max(32),
  departmentId: UuidSchema,
  role: z.enum(['lecturer', 'teaching_assistant']).default('lecturer'),
});

export const SuspendUserInput = z.object({
  status: z.enum(USER_STATUSES),
  reason: z.string().min(3).max(500),
});

export const EnrollmentInput = z.object({
  offeringId: UuidSchema,
  studentIds: z.array(UuidSchema).min(1).max(1000),
});

export const TeachingAssignmentInput = z.object({
  offeringId: UuidSchema,
  lecturerId: UuidSchema,
  role: z.enum(['lecturer', 'assistant']).default('lecturer'),
});

// ---------------------------------------------------------------- timetable
export const TimetableSlotInput = z.object({
  offeringId: UuidSchema,
  roomId: UuidSchema,
  dayOfWeek: z.number().int().min(1).max(7),
  startsAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  endsAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  validFrom: z.string().date(),
  validTo: z.string().date(),
});
export type TimetableSlotInput = z.infer<typeof TimetableSlotInput>;

export const GenerateSessionsInput = z.object({
  termId: UuidSchema,
  dryRun: z.boolean().default(false),
});
export type GenerateSessionsInput = z.infer<typeof GenerateSessionsInput>;

export const CsvImportInput = z.object({
  kind: z.enum(['students', 'lecturers', 'enrollments', 'timetable']),
  csv: z.string().min(1).max(5_000_000),
  dryRun: z.boolean().default(true),
});
export type CsvImportInput = z.infer<typeof CsvImportInput>;

// ---------------------------------------------------------------- roles
export const RoleInput = z.object({
  key: z
    .string()
    .min(3)
    .max(40)
    .regex(/^[a-z][a-z0-9_]*$/),
  name: z.string().min(2).max(80),
  permissions: z.array(z.enum(PERMISSIONS)).min(1),
});
export const RoleAssignmentInput = z.object({
  userId: UuidSchema,
  roleKey: z.string().min(3).max(40),
  scopeType: z.enum(SCOPE_TYPES),
  scopeId: UuidSchema.nullable(),
});

// ---------------------------------------------------------------- settings
export const SettingsPatch = SettingsSchema.partial();
export const SettingWrite = z.object({
  key: z.string().min(1).max(60),
  value: z.unknown(),
  reason: z.string().min(3).max(500),
});

// ---------------------------------------------------------------- review
export const ReviewResolveInput = z.object({
  action: z.enum(['confirm', 'reject', 'escalate']),
  reason: z.string().min(3).max(500),
});
export const AppealSummary = z.object({
  id: UuidSchema,
  recordId: UuidSchema,
  studentId: UuidSchema,
  studentName: z.string(),
  courseCode: z.string(),
  sessionStartsAt: z.string(),
  status: z.enum(APPEAL_STATUSES),
  message: z.string(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  decisionNote: z.string().nullable(),
});

export const ReviewItem = z.object({
  id: UuidSchema,
  kind: z.enum(['attempt', 'record']),
  sessionId: UuidSchema,
  courseCode: z.string(),
  studentName: z.string(),
  studentNumber: z.string(),
  status: z.enum(ATTENDANCE_STATUSES).nullable(),
  riskScore: z.number().int().nullable(),
  reasons: z.array(z.string()),
  createdAt: z.string(),
  state: z.enum(REVIEW_STATES),
});

// ---------------------------------------------------------------- integrations
export const ApiKeyInput = z.object({
  name: z.string().min(3).max(80),
  scopes: z.array(z.string().min(3).max(60)).min(1),
  expiresInDays: z.number().int().min(1).max(3650).default(365),
});
export const WebhookInput = z.object({
  url: z.string().url(),
  events: z.array(z.enum(['attendance.recorded', 'session.closed'])).min(1),
  secret: z.string().min(16).max(200),
});

export const SystemRoleList = z.array(z.enum(SYSTEM_ROLES));
