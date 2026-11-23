import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

/**
 * Migration runner.
 *
 * Applies `migrations/NNNN_*.sql` in filename order, each inside a transaction,
 * recording the name in `schema_migrations`. An applied migration is never
 * edited: the runner refuses to start if a previously applied file's checksum
 * changed, which catches the most common mistake before it corrupts a database.
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'migrations');

interface Migration {
  name: string;
  sql: string;
}

function loadMigrations(): Migration[] {
  return readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => ({ name: file, sql: readFileSync(join(migrationsDir, file), 'utf8') }));
}

function checksum(sql: string): string {
  let hash = 0;
  for (let i = 0; i < sql.length; i += 1) {
    hash = (hash * 31 + sql.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16);
}

async function main(): Promise<void> {
  const connectionString = process.env['DATABASE_URL_MIGRATE'] ?? process.env['DATABASE_URL'];
  if (!connectionString) {
    console.error('DATABASE_URL_MIGRATE or DATABASE_URL must be set');
    process.exit(1);
  }

  const client = new Client({ connectionString });
  await client.connect();

  try {
    await client.query(`
      create table if not exists schema_migrations (
        name text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )
    `);

    const applied = new Map<string, string>();
    const { rows } = await client.query<{ name: string; checksum: string }>(
      'select name, checksum from schema_migrations',
    );
    for (const row of rows) applied.set(row.name, row.checksum);

    for (const migration of loadMigrations()) {
      const sum = checksum(migration.sql);
      const previous = applied.get(migration.name);
      if (previous) {
        if (previous !== sum) {
          throw new Error(
            `migration ${migration.name} was modified after being applied (checksum ${previous} -> ${sum}). ` +
              'Never edit an applied migration: add a new one instead.',
          );
        }
        continue;
      }
      process.stdout.write(`applying ${migration.name} … `);
      await client.query('begin');
      try {
        await client.query(migration.sql);
        await client.query('insert into schema_migrations (name, checksum) values ($1, $2)', [
          migration.name,
          sum,
        ]);
        await client.query('commit');
        process.stdout.write('ok\n');
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
    }
    console.log('migrations up to date');
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
