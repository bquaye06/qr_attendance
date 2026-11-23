'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Button, Card, CardBody, CardHeader, CardTitle, Input, Label } from '@attend/ui';
import { clientFetch } from '@/lib/api';

interface Setup {
  secret: string;
  otpauthUrl: string;
}

export function MfaForm() {
  const router = useRouter();
  const [setup, setSetup] = useState<Setup | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function start(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setSetup(await clientFetch<Setup>('/api/v1/auth/totp/setup', { method: 'POST' }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not start setup.');
    } finally {
      setBusy(false);
    }
  }

  async function confirm(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await clientFetch('/api/v1/auth/totp/confirm', {
        method: 'POST',
        body: JSON.stringify({ code }),
      });
      router.push('/');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That code was not accepted.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle>{setup ? 'Enter the code from your app' : 'Set up your authenticator'}</CardTitle>
      </CardHeader>
      <CardBody className="space-y-4">
        {error ? <Alert tone="danger">{error}</Alert> : null}

        {!setup ? (
          <Button onClick={() => void start()} disabled={busy}>
            {busy ? 'Preparing…' : 'Generate my secret'}
          </Button>
        ) : (
          <>
            <div>
              <Label>Secret (type this into your authenticator app)</Label>
              <code className="block break-all rounded-lg bg-slate-100 px-3 py-2 text-sm">{setup.secret}</code>
            </div>
            <div>
              <Label htmlFor="code">Six-digit code</Label>
              <Input
                id="code"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/gu, ''))}
              />
            </div>
            <Button onClick={() => void confirm()} disabled={busy || code.length !== 6}>
              {busy ? 'Verifying…' : 'Confirm and continue'}
            </Button>
          </>
        )}
      </CardBody>
    </Card>
  );
}
