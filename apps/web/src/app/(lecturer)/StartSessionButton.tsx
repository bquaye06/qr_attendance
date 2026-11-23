'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Button } from '@attend/ui';
import { clientFetch } from '@/lib/api';

export function StartSessionButton({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function start(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await clientFetch(`/api/v1/sessions/${sessionId}/start`, { method: 'POST', body: JSON.stringify({}) });
      router.push(`/lecturer/sessions/${sessionId}`);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not start the session.');
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Button className="w-full" disabled={busy} onClick={() => void start()}>
        {busy ? 'Opening…' : 'Start session'}
      </Button>
    </div>
  );
}
