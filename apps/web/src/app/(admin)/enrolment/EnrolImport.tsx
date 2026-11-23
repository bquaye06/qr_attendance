'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Button, Label, Select } from '@attend/ui';
import { clientFetch } from '@/lib/api';

interface ImportResult {
  dryRun: boolean;
  matched?: number;
  toAdd?: number;
  added?: number;
  unknown: string[];
  alreadyEnrolled: string[];
}

export function EnrolImport({ offerings }: { offerings: { value: string; label: string }[] }) {
  const router = useRouter();
  const [offeringId, setOfferingId] = useState(offerings[0]?.value ?? '');
  const [numbers, setNumbers] = useState('');
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function parsed(): string[] {
    return numbers
      .split(/[\s,;]+/u)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  async function run(dryRun: boolean): Promise<void> {
    const studentNumbers = parsed();
    if (studentNumbers.length === 0) {
      setError('Paste at least one student number.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await clientFetch<ImportResult>('/api/v1/admin/enrollments/import', {
        method: 'POST',
        body: JSON.stringify({ offeringId, studentNumbers, dryRun }),
      });
      setPreview(result);
      if (!dryRun) {
        router.refresh();
        setNumbers('');
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Import failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {error ? <Alert tone="danger">{error}</Alert> : null}

      <div>
        <Label htmlFor="offering">Offering</Label>
        <Select id="offering" value={offeringId} onChange={(event) => setOfferingId(event.target.value)}>
          {offerings.map((offering) => (
            <option key={offering.value} value={offering.value}>
              {offering.label}
            </option>
          ))}
        </Select>
      </div>

      <div>
        <Label htmlFor="numbers">Student numbers</Label>
        <textarea
          id="numbers"
          rows={6}
          value={numbers}
          onChange={(event) => setNumbers(event.target.value)}
          placeholder={'20260001\n20260002\n20260003'}
          className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm"
        />
        <p className="mt-1 text-xs text-slate-500">One per line, or separated by commas.</p>
      </div>

      {preview ? (
        <Alert
          tone={preview.dryRun ? 'info' : 'success'}
          title={preview.dryRun ? 'Validation preview' : 'Enrolment complete'}
        >
          <ul className="mt-1 list-disc pl-5 text-sm">
            {preview.dryRun ? (
              <>
                <li>{preview.matched ?? 0} numbers matched a student</li>
                <li>{preview.toAdd ?? 0} would be added</li>
              </>
            ) : (
              <li>{preview.added ?? 0} enrolled</li>
            )}
            {preview.alreadyEnrolled.length > 0 ? (
              <li>{preview.alreadyEnrolled.length} already enrolled (left as they are)</li>
            ) : null}
            {preview.unknown.length > 0 ? (
              <li className="text-red-700">
                Not found: {preview.unknown.slice(0, 12).join(', ')}
                {preview.unknown.length > 12 ? ` +${preview.unknown.length - 12} more` : ''}
              </li>
            ) : null}
          </ul>
        </Alert>
      ) : null}

      <div className="flex gap-2">
        <Button variant="outline" disabled={busy || !offeringId} onClick={() => void run(true)}>
          {busy ? 'Checking…' : 'Validate'}
        </Button>
        <Button
          disabled={busy || !offeringId || preview === null}
          onClick={() => {
            if (!window.confirm('Enrol these students into the selected offering?')) return;
            void run(false);
          }}
        >
          Enrol students
        </Button>
      </div>
      <p className="text-xs text-slate-500">
        Enrol runs only after a validation preview, so a typo in a class list cannot silently enrol the wrong cohort.
      </p>
    </div>
  );
}
