import { z } from 'zod';
import { SYSTEM_ROLES, USER_STATUSES, SCOPE_TYPES } from '../enums.ts';
import { PERMISSIONS } from '../permissions.ts';

export const SignInInput = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
  totp: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
});
export type SignInInput = z.infer<typeof SignInInput>;

export const MeResponse = z.object({
  userId: z.string().uuid(),
  email: z.string(),
  name: z.string(),
  status: z.enum(USER_STATUSES),
  roles: z.array(
    z.object({
      roleKey: z.string(),
      scopeType: z.enum(SCOPE_TYPES),
      scopeId: z.string().uuid().nullable(),
      scopeName: z.string(),
    }),
  ),
  permissions: z.array(z.enum(PERMISSIONS)),
  student: z
    .object({
      id: z.string().uuid(),
      studentNumber: z.string(),
      consentGrantedAt: z.string().nullable(),
      noticeVersion: z.string().nullable(),
      faceEnrolled: z.boolean(),
      deviceBound: z.boolean(),
    })
    .nullable(),
  staff: z
    .object({
      id: z.string().uuid(),
      staffNumber: z.string(),
      requiresMfa: z.boolean(),
    })
    .nullable(),
});
export type MeResponse = z.infer<typeof MeResponse>;

export const SignOutResponse = z.object({ ok: z.literal(true) });

export const TotpSetupResponse = z.object({
  secret: z.string(),
  otpauthUrl: z.string(),
});

export const TotpConfirmInput = z.object({ code: z.string().regex(/^\d{6}$/) });

export const ChangePasswordInput = z.object({
  currentPassword: z.string().min(8).max(200),
  newPassword: z.string().min(12).max(200),
});

export const SystemRoleSchema = z.enum(SYSTEM_ROLES);
