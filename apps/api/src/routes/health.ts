import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { HealthResponse } from '@attend/contracts';
import { rows } from '../lib/query.ts';

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/healthz', async () => ({ status: 'ok' as const }));

  app.get('/readyz', async (_request, reply) => {
    const dbOk = await app.stores.db
      .execute(sql`select 1`)
      .then(() => true)
      .catch(() => false);

    const face = await app.face.health();
    const failedJobs = dbOk
      ? await rows<{ count: string }>(
          app.stores.db,
          sql`select count(*)::text as count from job_runs where status = 'failed' and started_at > now() - interval '24 hours'`,
        ).catch(() => [{ count: '0' }])
      : [{ count: '0' }];

    const payload = {
      status: dbOk && face?.modelsLoaded ? ('ok' as const) : ('degraded' as const),
      db: dbOk ? ('ok' as const) : ('down' as const),
      redis: app.kv.kind === 'redis' ? ('ok' as const) : ('down' as const),
      face: face ? (face.modelsLoaded ? ('ok' as const) : ('degraded' as const)) : ('down' as const),
      queueDepth: 0,
      failedJobs: Number.parseInt(failedJobs[0]?.count ?? '0', 10),
      modelVersion: face?.modelVersion ?? null,
      version: process.env['npm_package_version'] ?? '0.1.0',
    };

    return reply
      .status(payload.status === 'ok' ? 200 : 503)
      .send(HealthResponse.parse(payload));
  });

  // Public health for load balancers.
  app.get('/api/v1/health', async (_request, reply) => {
    const probe = await app.stores.db
      .execute(sql`select 1`)
      .then(() => true)
      .catch(() => false);
    return reply.status(probe ? 200 : 503).send({ status: probe ? 'ok' : 'degraded' });
  });
}
