import { Badge, Card, CardBody, CardHeader, CardTitle, EmptyState } from '@attend/ui';
import { apiFetch, requireRole } from '@/lib/api';
import { ResolveButtons } from './ResolveButtons';

export const metadata = { title: 'Review queue · Attend' };

interface ReviewItem {
  id: string;
  kind: string;
  session_id: string;
  student_name: string;
  student_number: string;
  course_code: string;
  reasons: string[];
  risk_score: number | null;
  state: string;
  created_at: string;
}

export default async function ReviewPage() {
  await requireRole('admin');
  const { items } = await apiFetch<{ items: ReviewItem[] }>('/api/v1/admin/review');
  const pending = items.filter((item) => item.state === 'pending');

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Review queue</h1>
        <p className="text-sm text-slate-600">
          Check-ins that passed but carried risk signals. Confirm to keep them present, reject to mark absent.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            {pending.length} pending <span className="font-normal text-slate-500">of {items.length} total</span>
          </CardTitle>
        </CardHeader>
        <CardBody className="space-y-3">
          {items.length === 0 ? (
            <EmptyState title="Queue is clear" description="Nothing has been flagged for review." />
          ) : (
            items.map((item) => (
              <div key={item.id} className="rounded-lg border border-slate-200 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium">
                      {item.student_name} <span className="text-slate-500">({item.student_number})</span>
                    </p>
                    <p className="text-xs text-slate-500">
                      {item.course_code} · {new Date(item.created_at).toLocaleString('en-GB')}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {item.risk_score !== null ? <Badge tone="warning">risk {item.risk_score}</Badge> : null}
                    <Badge tone={item.state === 'pending' ? 'neutral' : item.state === 'confirmed' ? 'success' : 'danger'}>
                      {item.state}
                    </Badge>
                  </div>
                </div>
                <p className="mt-2 text-xs text-slate-600">
                  Signals: {item.reasons.length > 0 ? item.reasons.join(', ').replace(/_/gu, ' ') : 'none recorded'}
                </p>
                {item.state === 'pending' ? <ResolveButtons itemId={item.id} /> : null}
              </div>
            ))
          )}
        </CardBody>
      </Card>
    </div>
  );
}
