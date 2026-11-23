import { createHash } from 'node:crypto';
import type { Database } from '@attend/db';
import { idempotencyKeys } from '@attend/db';
import { and, eq } from 'drizzle-orm';
import { ApiError } from './problem.ts';

/**
 * Idempotency for check-in requests.
 *
 * The key is scoped to the user and route so one student cannot consume
 * another's key. Replaying the same key with a different body is an error, not
 * a silent replay — that usually means a client bug, and silently accepting it
 * would hide a duplicate attempt.
 */
export interface StoredResponse {
  status: number;
  body: unknown;
}

export function requestHash(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
}

export function idempotencyKeyFor(userId: string, headerValue: string): string {
  return `${userId}:${headerValue}`;
}

export async function lookupIdempotent(
  database: Database,
  key: string,
  route: string,
  hash: string,
): Promise<StoredResponse | null> {
  const [row] = await database
    .select()
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.key, key), eq(idempotencyKeys.route, route)))
    .limit(1);
  if (!row) return null;
  if (row.requestHash !== hash) {
    throw new ApiError(
      'IDEMPOTENCY_KEY_REUSED',
      'This Idempotency-Key was already used with a different request body.',
    );
  }
  if (row.responseStatus === null) return null; // in flight, caller should retry
  return { status: row.responseStatus, body: row.responseBody };
}

export async function storeIdempotent(
  database: Database,
  key: string,
  userId: string,
  route: string,
  hash: string,
  response: StoredResponse,
): Promise<void> {
  await database
    .insert(idempotencyKeys)
    .values({
      key,
      userId,
      route,
      requestHash: hash,
      responseStatus: response.status,
      responseBody: response.body as never,
      expiresAt: new Date(Date.now() + 24 * 3_600_000),
    })
    .onConflictDoUpdate({
      target: idempotencyKeys.key,
      set: {
        responseStatus: response.status,
        responseBody: response.body as never,
      },
    });
}

export function requireIdempotencyKey(header: unknown): string {
  if (typeof header !== 'string' || header.length < 8) {
    throw new ApiError('VALIDATION_FAILED', 'An Idempotency-Key header (8+ characters) is required.');
  }
  return header;
}
