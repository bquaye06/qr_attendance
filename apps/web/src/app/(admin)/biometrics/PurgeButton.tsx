'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Button } from '@attend/ui';
import { clientFetch } from '@/lib/api';

/**
 * Two-administrator purge. The first click records the request in Redis; the
 * second click must come from a *different* administrator's session, so the UI
 * offers both actions and lets the API enforce the rule.
 */
export function PurgeButton({ studentId, hasTemplates }: { studentId: string; hasTemplates: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'requested' | 'purged'>('idle');
  const [busy, setBusy] = useState(false);

  async function call(approve: boolean): Promise<void> {
    const reason = window.prompt(
      approve
        ? 'Confirm the purge. Reason (recorded in the audit log):'
        : 'Reason for requesting a biometric purge?',
    );
    if (!reason || reason.trim().length < 3) return;
    setBusy(true);
    setError(null);
    try {
      const result = await clientFetch<{ state: string }>(`/api/v1/admin/biometrics/${studentId}/purge`, {
        method: 'POST',
        body: JSON.stringify(
          approve
            ? { reason: reason.trim(), approvalToken: 'second-admin' }
            : { reason: reason.trim() },
        ),
      });
      setState(result.state === 'purged' ? 'purged' : 'requested');
      if (result.state === 'purged') router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Purge failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {state === 'purged' ? <span className="text-xs text-emerald-700">purged</span> : null}
      {state === 'requested' ? (
        <span className="text-xs text-amber-700">awaiting second admin</span>
      ) : null}
      <div className="flex flex-wrap gap-1">
        <Button size="sm" variant="outline" disabled={busy || !hasTemplates} onClick={() => void call(false)}>
          Request
        </Button>
        <Button size="sm" variant="destructive" disabled={busy || !hasTemplates} onClick={() => void call(true)}>
          Approve
        </Button>
      </div>
    </div>
  );
}
