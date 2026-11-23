'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Button } from '@attend/ui';
import { clientFetch } from '@/lib/api';

export function DeviceRevokeButton({ deviceId }: { deviceId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function revoke(): Promise<void> {
    const reason = window.prompt('Reason for revoking this device? (audited)');
    if (!reason || reason.trim().length < 3) return;
    setBusy(true);
    setError(null);
    try {
      await clientFetch(`/api/v1/admin/devices/${deviceId}/revoke`, {
        method: 'POST',
        body: JSON.stringify({ reason: reason.trim() }),
      });
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not revoke the device.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void revoke()}>
        {busy ? 'Revoking…' : 'Revoke'}
      </Button>
    </div>
  );
}
