import type { SQL } from 'drizzle-orm';
import type { db as DatabaseType } from '../db.ts';

/**
 * Thin typed wrapper over Drizzle's raw execution. Aggregations and joins that
 * span the `biometrics` schema read far better as SQL than as builder chains,
 * and they stay parameterised through Drizzle's `sql` tag.
 */
export async function rows<T>(database: DatabaseType, query: SQL): Promise<T[]> {
  const result = await database.execute(query);
  return (result as unknown as { rows: T[] }).rows;
}

export async function one<T>(database: DatabaseType, query: SQL): Promise<T | null> {
  const result = await rows<T>(database, query);
  return result[0] ?? null;
}

/** Postgres returns numeric as string; convert once at the boundary. */
export function toNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}
