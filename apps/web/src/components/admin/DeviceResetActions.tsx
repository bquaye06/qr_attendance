'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Button } from '@attend/ui';
import { clientFetch } from '@/lib/api';

/** Approving a reset revokes the old passkey, so the next device binding is clean. */
export function DeviceResetActions({ requestId }: { requestId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function decide(decision: 'approved' | 'rejected'): Promise<void> {
    const note = window.prompt(
      decision === 'approved'
        ? 'Confirm the identity check was done. Note (audited):'
        : 'Why is this reset rejected? (audited)',
    );
    if (!note || note.trim().length < 3) return;
    setBusy(true);
    setError(null);
    try {
      await clientFetch(`/api/v1/admin/device-resets/${requestId}`, {
        method: 'POST',
        body: JSON.stringify({ decision, note: note.trim() }),
      });
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save the decision.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div className="flex gap-2">
        <Button size="sm" disabled={busy} onClick={() => void decide('approved')}>
          Approve
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void decide('rejected')}>
          Reject
        </Button>
      </div>
    </div>
  );
}
