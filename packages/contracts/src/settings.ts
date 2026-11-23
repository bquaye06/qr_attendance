import { z } from 'zod';

/**
 * Institution-wide policy. Stored one row per key in `system_settings` with a
 * version history, validated against this schema on load and on every write.
 * Nothing here is hard-coded in business logic: the decision engine receives
 * the resolved settings object.
 */
export const SettingsSchema = z.object({
  qrRotationSeconds: z.number().int().min(5).max(300).default(10),
  qrExpirySeconds: z.number().int().min(5).max(600).default(15),

  checkinOpensOffsetMinutes: z.number().int().min(-120).max(120).default(0),
  checkinClosesOffsetMinutes: z.number().int().min(1).max(240).default(15),
  lateAfterMinutes: z.number().int().min(0).max(240).default(10),

  similarityThreshold: z.number().min(0.1).max(0.99).default(0.45),
  similarityMargin: z.number().min(0).max(0.5).default(0.05),
  /** Similarity at or above which a new enrolment is treated as a duplicate face. */
  duplicateFaceThreshold: z.number().min(0.3).max(0.99).default(0.6),
  livenessThreshold: z.number().min(0).max(1).default(0.8),
  qualityThreshold: z.number().min(0).max(1).default(0.6),
  requireActiveLiveness: z.boolean().default(true),

  geofenceEnabled: z.boolean().default(false),
  geofenceDefaultRadiusM: z.number().int().min(20).max(2000).default(100),
  ipAllowlistEnforced: z.boolean().default(false),

  maxDevicesPerStudent: z.number().int().min(1).max(3).default(1),
  claimTtlSeconds: z.number().int().min(10).max(300).default(60),
  checkinRateLimitPerMinute: z.number().int().min(1).max(60).default(10),

  failuresBeforeFlag: z.number().int().min(1).max(10).default(3),
  riskFlagThreshold: z.number().int().min(1).max(100).default(70),

  attendanceThresholdPercent: z.number().int().min(1).max(100).default(75),
  manualOverrideLimitPerSession: z.number().int().min(0).max(500).default(10),

  evidenceRetentionDays: z.number().int().min(1).max(365).default(30),
  templatePurgeGraceDays: z.number().int().min(1).max(365).default(30),

  adminIdleMinutes: z.number().int().min(5).max(120).default(30),
  staffIdleMinutes: z.number().int().min(10).max(720).default(120),
  studentIdleMinutes: z.number().int().min(60).max(20160).default(4320),

  sessionAutoOpenFromTimetable: z.boolean().default(false),
  requireFirstEnrollmentApproval: z.boolean().default(false),
  timeZone: z.string().default('Africa/Accra'),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type SettingKey = keyof Settings;

export const SETTING_KEYS = Object.keys(SettingsSchema.shape) as SettingKey[];

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});

export const DEFAULT_BIOMETRIC_NOTICE_VERSION = '2026-01-v1';

/** Per-faculty switches layered over the global settings. */
export const FEATURE_FLAGS = ['geofence', 'active_liveness', 'manual_override'] as const;
export type FeatureFlag = (typeof FEATURE_FLAGS)[number];

export function resolveFeatureFlag(
  flag: FeatureFlag,
  settings: Settings,
  overrides: ReadonlyArray<{ flag: string; enabled: boolean }>,
): boolean {
  if (flag === 'manual_override') {
    // `manual_override` is enabled when the limit is above zero.
    const override = overrides.find((o) => o.flag === flag);
    if (override) return override.enabled;
    return settings.manualOverrideLimitPerSession > 0;
  }
  const override = overrides.find((o) => o.flag === flag);
  if (override) return override.enabled;
  if (flag === 'geofence') return settings.geofenceEnabled;
  return settings.requireActiveLiveness;
}
