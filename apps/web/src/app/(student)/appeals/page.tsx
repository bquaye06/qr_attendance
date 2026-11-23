import { AttendanceBadge, Card, CardBody, CardHeader, CardTitle, EmptyState } from '@attend/ui';
import { apiFetch, requireRole } from '@/lib/api';
import { AppealForm } from './AppealForm';

export const metadata = { title: 'Appeals · Attend' };

interface AppealsResponse {
  appeals: { id: string; record_id: string; status: string; message: string; created_at: string; decision_note: string | null }[];
}

export default async function AppealsPage({
  searchParams,
}: {
  searchParams: Promise<{ recordId?: string }>;
}) {
  await requireRole('student');
  const { recordId } = await searchParams;
  const data = await apiFetch<AppealsResponse>('/api/v1/appeals/mine');

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Appeals</h1>

      <Card>
        <CardHeader>
          <CardTitle>Raise an appeal</CardTitle>
        </CardHeader>
        <CardBody>
          <AppealForm recordId={recordId ?? ''} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Your appeals</CardTitle>
        </CardHeader>
        <CardBody className="space-y-3">
          {data.appeals.length === 0 ? (
            <EmptyState title="No appeals" description="Appeals you raise appear here with the reviewer's decision." />
          ) : (
            data.appeals.map((appeal) => (
              <div key={appeal.id} className="border-b border-slate-100 pb-3 last:border-0">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium">Record {appeal.record_id.slice(0, 8)}</p>
                  <AttendanceBadge status={appeal.status === 'accepted' ? 'present_manual' : appeal.status === 'rejected' ? 'absent' : 'excused'} />
                </div>
                <p className="mt-1 text-sm text-slate-700">{appeal.message}</p>
                {appeal.decision_note ? (
                  <p className="mt-1 text-xs text-slate-500">Reviewer: {appeal.decision_note}</p>
                ) : null}
                <p className="mt-1 text-xs text-slate-400">{new Date(appeal.created_at).toLocaleString('en-GB')}</p>
              </div>
            ))
          )}
        </CardBody>
      </Card>
    </div>
  );
}
