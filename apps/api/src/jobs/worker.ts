import { sql } from 'drizzle-orm';
import { buildApp } from '../app.ts';
import { loadEnv } from '../env.ts';
import { closeExpiredSessions } from './absence.ts';
import { purgeDueData } from './purge.ts';

/**
 * Background worker.
 *
 * A single-process polling loop over the Neon-backed `job_runs` table. A Postgres
 * advisory lock guarantees only one instance runs a given job at a time, which is
 * what we need without adding a queue service. Swap in BullMQ if the deployment
 * grows beyond a handful of instances (documented in docs/RUNBOOK.md).
 */

const TICK_MS = 30_000;
const ABSENCE_LOCK = 918_273;
const PURGE_LOCK = 918_274;

async function runGuarded(
  app: Awaited<ReturnType<typeof buildApp>>,
  lockId: number,
  job: string,
  work: () => Promise<Record<string, unknown>>,
): Promise<void> {
  const lock = await app.stores.db.execute(sql`select pg_try_advisory_lock(${lockId}) as locked`);
  const locked = (lock as unknown as { rows: { locked: boolean }[] }).rows[0]?.locked ?? false;
  if (!locked) return;

  try {
    const [run] = await app.stores.db
      .execute(sql`insert into job_runs (job) values (${job}) returning id`)
      .then((result) => (result as unknown as { rows: { id: string }[] }).rows);

    const startedAt = Date.now();
    try {
      const detail = await work();
      await app.stores.db.execute(sql`
        update job_runs set status = 'ok', finished_at = now(), detail = ${JSON.stringify(detail)}::jsonb
        where id = ${run!.id}::uuid
      `);
      app.log.info({ job, ms: Date.now() - startedAt, ...detail }, 'job finished');
    } catch (error) {
      await app.stores.db.execute(sql`
        update job_runs set status = 'failed', finished_at = now(),
          detail = ${JSON.stringify({ error: String(error) })}::jsonb
        where id = ${run!.id}::uuid
      `);
      app.log.error({ job, err: error }, 'job failed');
    }
  } finally {
    await app.stores.db.execute(sql`select pg_advisory_unlock(${lockId})`);
  }
}

async function main(): Promise<void> {
  const env = loadEnv();
  const app = await buildApp({ env });
  // The worker never serves HTTP; it only uses the decorated clients.
  app.log.info('worker started');

  const tick = async (): Promise<void> => {
    await runGuarded(app, ABSENCE_LOCK, 'absence_sweep', async () => ({ ...(await closeExpiredSessions(app)) }));
    await runGuarded(app, PURGE_LOCK, 'retention_purge', async () => ({ ...(await purgeDueData(app)) }));
  };

  await tick();
  const timer = setInterval(() => void tick(), TICK_MS);

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'worker stopping');
    clearInterval(timer);
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
