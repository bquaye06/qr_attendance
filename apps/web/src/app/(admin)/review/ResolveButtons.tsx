'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Button } from '@attend/ui';
import { clientFetch } from '@/lib/api';

export function ResolveButtons({ itemId }: { itemId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function resolve(action: 'confirm' | 'reject' | 'escalate'): Promise<void> {
    const reason = window.prompt('Reason for this decision (required, audited):');
    if (!reason || reason.trim().length < 3) return;
    setBusy(true);
    setError(null);
    try {
      await clientFetch(`/api/v1/admin/review/${itemId}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ action, reason: reason.trim() }),
      });
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not resolve this item.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 space-y-2">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={() => void resolve('confirm')}>
          Confirm attendance
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void resolve('reject')}>
          Reject
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void resolve('escalate')}>
          Escalate
        </Button>
      </div>
    </div>
  );
}
