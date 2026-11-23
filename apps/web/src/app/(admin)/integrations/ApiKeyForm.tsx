'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Button, Input, Label } from '@attend/ui';
import { clientFetch } from '@/lib/api';

/** The secret comes back exactly once, so it is shown here and nowhere else. */
export function ApiKeyForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState('attendance:read, report:read');
  const [expiresInDays, setExpiresInDays] = useState('365');
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create(): Promise<void> {
    setBusy(true);
    setError(null);
    setSecret(null);
    try {
      const result = await clientFetch<{ id: string; secret: string }>('/api/v1/admin/integrations/api-keys', {
        method: 'POST',
        body: JSON.stringify({
          name,
          scopes: scopes
            .split(',')
            .map((scope) => scope.trim())
            .filter(Boolean),
          expiresInDays: Number(expiresInDays),
        }),
      });
      setSecret(result.secret);
      setName('');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create the key.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-slate-200 p-3">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {secret ? (
        <Alert tone="warning" title="Copy this key now">
          <code className="mt-1 block break-all rounded bg-white/60 px-2 py-1 text-xs">{secret}</code>
          It cannot be shown again. Only its hash is stored.
        </Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <Label htmlFor="key-name">Name</Label>
          <Input id="key-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="SIS nightly sync" />
        </div>
        <div>
          <Label htmlFor="key-scopes">Scopes</Label>
          <Input id="key-scopes" value={scopes} onChange={(event) => setScopes(event.target.value)} />
        </div>
        <div>
          <Label htmlFor="key-expiry">Expires in (days)</Label>
          <Input
            id="key-expiry"
            type="number"
            value={expiresInDays}
            onChange={(event) => setExpiresInDays(event.target.value)}
          />
        </div>
      </div>

      <Button disabled={busy || name.trim().length < 3} onClick={() => void create()}>
        {busy ? 'Creating…' : 'Create API key'}
      </Button>
    </div>
  );
}
