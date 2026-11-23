'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Button, Input, Label } from '@attend/ui';
import { clientFetch } from '@/lib/api';

export function AppealForm({ recordId }: { recordId: string }) {
  const router = useRouter();
  const [record, setRecord] = useState(recordId);
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await clientFetch('/api/v1/appeals', {
        method: 'POST',
        body: JSON.stringify({ recordId: record.trim(), message }),
      });
      setDone(true);
      setMessage('');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not submit the appeal.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {done ? <Alert tone="success">Appeal submitted. Your lecturer or an administrator will review it.</Alert> : null}
      <div>
        <Label htmlFor="recordId">Attendance record id</Label>
        <Input
          id="recordId"
          value={record}
          onChange={(event) => setRecord(event.target.value)}
          placeholder="Open the record from your history"
        />
      </div>
      <div>
        <Label htmlFor="message">What happened?</Label>
        <textarea
          id="message"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          rows={4}
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          placeholder="Be specific: time, room, and what stopped you checking in."
        />
      </div>
      <Button disabled={busy || message.trim().length < 10 || record.trim().length < 8} onClick={() => void submit()}>
        {busy ? 'Submitting…' : 'Submit appeal'}
      </Button>
    </div>
  );
}
