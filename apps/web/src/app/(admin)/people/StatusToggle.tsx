'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Button } from '@attend/ui';
import { clientFetch } from '@/lib/api';

export function StatusToggle({ userId, status }: { userId: string; status: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const next = status === 'active' ? 'suspended' : 'active';

  async function change(): Promise<void> {
    const reason = window.prompt(`Reason for ${next === 'suspended' ? 'suspending' : 'reactivating'} this account?`);
    if (!reason || reason.trim().length < 3) return;
    setBusy(true);
    setError(null);
    try {
      await clientFetch(`/api/v1/admin/users/${userId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: next, reason: reason.trim() }),
      });
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not change the status.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void change()}>
        {busy ? 'Saving…' : next === 'suspended' ? 'Suspend' : 'Reactivate'}
      </Button>
    </div>
  );
}
