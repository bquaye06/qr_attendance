import { defineConfig } from 'drizzle-kit';

/**
 * DDL is authored as SQL in `migrations/` (see src/migrate.ts). drizzle-kit is
 * wired up only so `pnpm db:generate` can produce a diff when someone changes
 * the TS schema, which must then be hand-reviewed into a numbered migration.
 */
export default defineConfig({
  schema: './src/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env['DATABASE_URL_MIGRATE'] ?? process.env['DATABASE_URL'] ?? '',
  },
  extensionsFilters: ['postgis'],
  verbose: true,
  strict: true,
});
