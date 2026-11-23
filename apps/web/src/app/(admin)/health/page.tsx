import { Alert, Badge, Card, CardBody, CardHeader, CardTitle } from '@attend/ui';
import { requireRole } from '@/lib/api';

export const metadata = { title: 'System health · Attend' };

const API_URL = process.env['API_URL'] ?? 'http://localhost:4000';

interface Ready {
  status: 'ok' | 'degraded';
  db: 'ok' | 'down';
  redis: 'ok' | 'down';
  face: 'ok' | 'degraded' | 'down';
  queueDepth: number;
  failedJobs: number;
  modelVersion: string | null;
  version: string;
}

async function readReady(): Promise<{ http: number; body: Ready | null }> {
  try {
    const response = await fetch(`${API_URL}/readyz`, { cache: 'no-store' });
    return { http: response.status, body: (await response.json()) as Ready };
  } catch {
    return { http: 0, body: null };
  }
}

export default async function HealthPage() {
  await requireRole('admin');
  const { http, body } = await readReady();

  const tone = (value: string): 'success' | 'warning' | 'danger' =>
    value === 'ok' ? 'success' : value === 'degraded' ? 'warning' : 'danger';

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">System health</h1>
        <p className="text-sm text-slate-600">
          Live readiness from the API. A degraded face service does not stop check-in: the manual path stays open.
        </p>
      </div>

      {!body ? (
        <Alert tone="danger" title="API unreachable">
          Nothing answered at {API_URL}/readyz. Check the container or process.
        </Alert>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Card>
              <CardBody>
                <p className="text-xs uppercase tracking-wide text-slate-500">Overall</p>
                <p className="mt-2">
                  <Badge tone={tone(body.status)}>{body.status}</Badge>
                </p>
                <p className="mt-1 text-xs text-slate-500">HTTP {http}</p>
              </CardBody>
            </Card>
            <Card>
              <CardBody>
                <p className="text-xs uppercase tracking-wide text-slate-500">Database</p>
                <p className="mt-2">
                  <Badge tone={tone(body.db)}>{body.db}</Badge>
                </p>
              </CardBody>
            </Card>
            <Card>
              <CardBody>
                <p className="text-xs uppercase tracking-wide text-slate-500">Redis</p>
                <p className="mt-2">
                  <Badge tone={body.redis === 'ok' ? 'success' : 'warning'}>{body.redis}</Badge>
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  {body.redis === 'down' ? 'single-instance fallback' : 'shared state'}
                </p>
              </CardBody>
            </Card>
            <Card>
              <CardBody>
                <p className="text-xs uppercase tracking-wide text-slate-500">Face service</p>
                <p className="mt-2">
                  <Badge tone={tone(body.face)}>{body.face}</Badge>
                </p>
                <p className="mt-1 text-xs text-slate-500">{body.modelVersion ?? 'no model'}</p>
              </CardBody>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Background jobs</CardTitle>
            </CardHeader>
            <CardBody className="space-y-2 text-sm">
              <p>
                Failed in the last 24 h: <strong>{body.failedJobs}</strong>
                {body.failedJobs > 0 ? ' — check the worker logs and job_runs.' : ''}
              </p>
              <p className="text-xs text-slate-500">
                API version {body.version}. Jobs run every 30 s under a Postgres advisory lock: absence sweep, then
                retention purge.
              </p>
            </CardBody>
          </Card>
        </>
      )}

      <Alert tone="info" title="Model licences">
        Face model weights are pinned by SHA-256 in <code>services/face/models.lock</code>. Check the licence of every
        model before production use — see docs/DECISIONS.md.
      </Alert>
    </div>
  );
}
