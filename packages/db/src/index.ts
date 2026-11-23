import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.ts';

export * from './schema.ts';
export { schema };

export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseOptions {
  /** Neon pooled connection string: use this for the API. */
  connectionString: string;
  max?: number;
  applicationName?: string;
}

/**
 * The API uses the pooled connection string; migrations use the direct one.
 * SSL is required outside localhost, which is how Neon and most managed
 * providers behave.
 */
export function createDatabase(options: DatabaseOptions): { db: Database; pool: Pool } {
  const needsSsl = !/^postgres(ql)?:\/\/[^/]*(localhost|127\.0\.0\.1)/u.test(options.connectionString);
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    application_name: options.applicationName ?? 'attend-api',
    ssl: needsSsl ? { rejectUnauthorized: true } : undefined,
  });
  return { db: drizzle(pool, { schema }), pool };
}
