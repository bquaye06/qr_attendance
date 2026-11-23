import { sql } from 'drizzle-orm';
import { systemSettingHistory, systemSettings } from '@attend/db';
import type { Database } from '@attend/db';
import { DEFAULT_SETTINGS, SETTING_KEYS, SettingsSchema } from '@attend/contracts';
import type { SettingKey, Settings } from '@attend/contracts';
import { ApiError } from './problem.ts';
import { writeAudit } from './audit.ts';

/**
 * Settings are stored one row per key with a version history, validated against
 * the contract schema. A short TTL cache keeps the check-in hot path off the
 * database while still making a console change effective within a second or two
 * (and immediately on the instance that made the change).
 */

const CACHE_TTL_MS = 1500;
let cache: { value: Settings; loadedAt: number } | null = null;

export function invalidateSettingsCache(): void {
  cache = null;
}

export async function loadSettings(database: Database): Promise<Settings> {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) return cache.value;

  const rows = await database.select().from(systemSettings);
  const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const row of rows) {
    if (!(SETTING_KEYS as string[]).includes(row.key)) continue;
    merged[row.key] = row.value;
  }
  const parsed = SettingsSchema.safeParse(merged);
  if (!parsed.success) {
    // Never run with an invalid policy: fall back to defaults and shout.
    console.error('settings invalid, falling back to defaults', parsed.error.issues);
    cache = { value: DEFAULT_SETTINGS, loadedAt: Date.now() };
    return DEFAULT_SETTINGS;
  }
  cache = { value: parsed.data, loadedAt: Date.now() };
  return parsed.data;
}

export interface SettingUpdateInput {
  key: string;
  value: unknown;
  actorId: string;
  actorEmail: string;
  reason: string;
  ip?: string | null;
  requestId?: string | null;
}

export async function updateSetting(database: Database, input: SettingUpdateInput): Promise<Settings> {
  const key = input.key as SettingKey;
  if (!(SETTING_KEYS as string[]).includes(input.key)) {
    throw new ApiError('SETTING_INVALID', `Unknown setting ${input.key}`);
  }
  const candidate = SettingsSchema.partial().safeParse({ [key]: input.value });
  if (!candidate.success) {
    throw new ApiError(
      'SETTING_INVALID',
      `Value for ${input.key} is invalid`,
      candidate.error.issues.map((issue) => ({ path: String(issue.path[0] ?? key), message: issue.message })),
    );
  }

  const [existing] = await database.select().from(systemSettings).where(sql`key = ${input.key}`).limit(1);
  const nextVersion = (existing?.version ?? 0) + 1;
  const nextValue = input.value as never;

  if (existing) {
    await database
      .update(systemSettings)
      .set({ value: nextValue, version: nextVersion, updatedBy: input.actorId, updatedAt: new Date() })
      .where(sql`key = ${input.key}`);
  } else {
    await database
      .insert(systemSettings)
      .values({ key: input.key, value: nextValue, version: nextVersion, updatedBy: input.actorId });
  }

  await database.insert(systemSettingHistory).values({
    key: input.key,
    version: nextVersion,
    value: nextValue,
    actorId: input.actorId,
    reason: input.reason,
  });

  await writeAudit(database, {
    actorId: input.actorId,
    actorEmail: input.actorEmail,
    action: 'settings.update',
    entity: 'system_setting',
    entityId: null,
    before: existing ? { value: existing.value, version: existing.version } : null,
    after: { key: input.key, value: input.value, version: nextVersion, reason: input.reason },
    ip: input.ip ?? null,
    requestId: input.requestId ?? null,
  });

  invalidateSettingsCache();
  return loadSettings(database);
}

export async function loadSettingHistory(
  database: Database,
  key: string,
): Promise<{ version: number; value: unknown; reason: string | null; at: Date }[]> {
  const rows = await database
    .select()
    .from(systemSettingHistory)
    .where(sql`key = ${key}`)
    .orderBy(sql`version desc`);
  return rows.map((row) => ({
    version: row.version,
    value: row.value,
    reason: row.reason,
    at: row.createdAt,
  }));
}
