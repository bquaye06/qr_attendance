'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Button, Label, Select } from '@attend/ui';
import { clientFetch } from '@/lib/api';

interface GenerateResult {
  created: { slotId: string; sessions: number }[];
  total: number;
}

export function GenerateSessionsForm({ terms }: { terms: { value: string; label: string }[] }) {
  const router = useRouter();
  const [termId, setTermId] = useState(terms[0]?.value ?? '');
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function generate(dryRun: boolean): Promise<void> {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await clientFetch<GenerateResult>('/api/v1/admin/sessions/generate', {
        method: 'POST',
        body: JSON.stringify({ termId, dryRun }),
      });
      setResult(response);
      if (!dryRun) router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Generation failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {result ? (
        <Alert tone="success" title={result.total === 0 ? 'Nothing to generate' : `${result.total} sessions`}>
          {result.total === 0
            ? 'Every occurrence already exists, or no slots cover this term.'
            : `Across ${result.created.length} slot(s). Existing sessions were left untouched.`}
        </Alert>
      ) : null}

      <div>
        <Label htmlFor="gen-term">Term</Label>
        <Select id="gen-term" value={termId} onChange={(event) => setTermId(event.target.value)}>
          {terms.map((term) => (
            <option key={term.value} value={term.value}>
              {term.label}
            </option>
          ))}
        </Select>
      </div>

      <div className="flex gap-2">
        <Button variant="outline" disabled={busy || !termId} onClick={() => void generate(true)}>
          {busy ? 'Checking…' : 'Preview (dry run)'}
        </Button>
        <Button
          disabled={busy || !termId}
          onClick={() => {
            if (!window.confirm('Create class sessions for this term?')) return;
            void generate(false);
          }}
        >
          Generate sessions
        </Button>
      </div>

      <p className="text-xs text-slate-500">
        Generating twice is safe: occurrences that already exist are skipped by the unique
        (offering, starts_at) constraint.
      </p>
    </div>
  );
}
