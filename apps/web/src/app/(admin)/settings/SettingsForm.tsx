'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Button, Input, Label, Select } from '@attend/ui';
import { clientFetch } from '@/lib/api';

export function SettingsForm({
  settings,
  labels,
}: {
  settings: Record<string, unknown>;
  labels: Record<string, string>;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<Record<string, string>>(
    Object.fromEntries(
      Object.entries(settings).map(([key, value]) => [key, typeof value === 'boolean' ? String(value) : String(value)]),
    ),
  );
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function saveOne(key: string): Promise<void> {
    const reason = window.prompt(`Reason for changing ${labels[key] ?? key}? (required, audited)`);
    if (!reason || reason.trim().length < 3) return;

    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const raw = draft[key] ?? '';
      const original = settings[key];
      let value: unknown = raw;
      if (typeof original === 'boolean') value = raw === 'true';
      else if (typeof original === 'number') value = Number(raw);

      await clientFetch('/api/v1/admin/settings', {
        method: 'PATCH',
        body: JSON.stringify({ key, value, reason: reason.trim() }),
      });
      setSaved(`${labels[key] ?? key} updated. New policy applies to the next check-in.`);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save that setting.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {saved ? <Alert tone="success">{saved}</Alert> : null}

      <div className="grid gap-3 md:grid-cols-2">
        {Object.keys(labels)
          .filter((key) => key in settings)
          .map((key) => {
            const original = settings[key];
            const isBoolean = typeof original === 'boolean';
            return (
              <div key={key}>
                <Label htmlFor={key}>{labels[key]}</Label>
                <div className="flex gap-2">
                  {isBoolean ? (
                    <Select
                      id={key}
                      value={draft[key] ?? 'false'}
                      onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
                    >
                      <option value="true">On</option>
                      <option value="false">Off</option>
                    </Select>
                  ) : (
                    <Input
                      id={key}
                      value={draft[key] ?? ''}
                      onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
                      inputMode={typeof original === 'number' ? 'decimal' : 'text'}
                    />
                  )}
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void saveOne(key)}>
                    Save
                  </Button>
                </div>
              </div>
            );
          })}
      </div>
    </div>
  );
}
