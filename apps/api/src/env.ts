import { z } from 'zod';

/**
 * Environment contract. The process refuses to start when something required
 * is missing rather than failing at the first request.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  /** Neon pooled connection string used by the API. */
  DATABASE_URL: z.string().min(1),
  /** Optional connection string for the biometrics role (isolated schema). */
  BIOMETRICS_DATABASE_URL: z.string().optional(),
  /** Direct (non-pooled) connection used by migrations. */
  DATABASE_URL_MIGRATE: z.string().optional(),

  REDIS_URL: z.string().optional(),

  /** 32-byte key (base64/hex) that wraps QR secrets and TOTP seeds. */
  MASTER_KEY: z.string().min(16),
  /** Pepper for device fingerprints. */
  FINGERPRINT_PEPPER: z.string().min(8),
  /** Shared secret for API -> face service calls. */
  FACE_SERVICE_URL: z.string().url().default('http://localhost:8000'),
  FACE_SERVICE_SECRET: z.string().min(16),
  FACE_SERVICE_TIMEOUT_MS: z.coerce.number().int().min(500).max(20000).default(6000),

  /** Public origins allowed to call the API and to hold sessions. */
  WEB_ORIGIN: z.string().default('http://localhost:3000'),
  WEBAUTHN_RP_ID: z.string().default('localhost'),
  WEBAUTHN_ALLOWED_ORIGINS: z.string().default('http://localhost:3000'),

  COOKIE_DOMAIN: z.string().optional(),
  SESSION_COOKIE_SECURE: z
    .string()
    .default('false')
    .transform((value) => value === 'true'),

  /** Institution defaults, overridable from the console. */
  INSTITUTION_NAME: z.string().default('Demo University'),
  TIME_ZONE: z.string().default('Africa/Accra'),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`invalid environment: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export function allowedOrigins(env: Env): string[] {
  return env.WEBAUTHN_ALLOWED_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}
