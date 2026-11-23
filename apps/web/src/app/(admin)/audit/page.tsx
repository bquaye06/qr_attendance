import { Card, CardBody, CardHeader, CardTitle, EmptyState } from '@attend/ui';
import { apiFetch, requireRole } from '@/lib/api';

export const metadata = { title: 'Audit log · Attend' };

interface AuditRow {
  id: string;
  actor_email: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  at: string;
  ip: string | null;
}

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ action?: string; entity?: string }> }) {
  await requireRole('admin');
  const { action, entity } = await searchParams;
  const query = new URLSearchParams();
  if (action) query.set('action', action);
  if (entity) query.set('entity', entity);
  const { entries } = await apiFetch<{ entries: AuditRow[] }>(`/api/v1/admin/audit?${query.toString()}`);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Audit log</h1>
        <p className="text-sm text-slate-600">
          Append-only. No one — including administrators — can edit or delete an entry.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Latest {entries.length} entries</CardTitle>
        </CardHeader>
        <CardBody className="overflow-x-auto p-0">
          {entries.length === 0 ? (
            <div className="p-4">
              <EmptyState title="Nothing recorded yet" />
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2">When</th>
                  <th className="px-4 py-2">Actor</th>
                  <th className="px-4 py-2">Action</th>
                  <th className="px-4 py-2">Entity</th>
                  <th className="px-4 py-2">IP</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id} className="border-t border-slate-100">
                    <td className="px-4 py-2 text-xs">{new Date(entry.at).toLocaleString('en-GB')}</td>
                    <td className="px-4 py-2 text-xs">{entry.actor_email ?? 'system'}</td>
                    <td className="px-4 py-2 font-mono text-xs">{entry.action}</td>
                    <td className="px-4 py-2 text-xs">
                      {entry.entity}
                      {entry.entity_id ? ` · ${entry.entity_id.slice(0, 8)}` : ''}
                    </td>
                    <td className="px-4 py-2 text-xs text-slate-500">{entry.ip ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
