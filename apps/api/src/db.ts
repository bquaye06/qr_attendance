import { createDatabase } from '@attend/db';
import type { Database } from '@attend/db';
import type { Pool } from 'pg';
import type { Env } from '../env.ts';

/**
 * Two pools:
 *  - `db` is the application role (Neon pooled string).
 *  - `biometrics` is the role that owns the `biometrics` schema. When it is not
 *    configured (local development) the app pool is used, and the isolation is
 *    documented as a production requirement in docs/DECISIONS.md.
 */
export interface Stores {
  db: Database;
  pool: Pool;
  biometrics: Database;
  close(): Promise<void>;
}

export function createStores(env: Env): Stores {
  const primary = createDatabase({
    connectionString: env.DATABASE_URL,
    applicationName: 'attend-api',
    max: 12,
  });

  let biometrics: Database = primary.db;
  let biometricsPool: Pool | null = null;
  if (env.BIOMETRICS_DATABASE_URL) {
    const isolated = createDatabase({
      connectionString: env.BIOMETRICS_DATABASE_URL,
      applicationName: 'attend-api-biometrics',
      max: 4,
    });
    biometrics = isolated.db;
    biometricsPool = isolated.pool;
  }

  return {
    db: primary.db,
    pool: primary.pool,
    biometrics,
    async close(): Promise<void> {
      await primary.pool.end();
      if (biometricsPool) await biometricsPool.end();
    },
  };
}
