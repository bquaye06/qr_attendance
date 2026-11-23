'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Button, Input, Label, Select } from '@attend/ui';
import { clientFetch } from '@/lib/api';

/**
 * One small form component drives every "create a row" panel in the console.
 *
 * It posts JSON to the API and refreshes the server component, so the table below
 * always reflects what the database actually holds. Validation stays in the API
 * (Zod schemas in @attend/contracts); this component only shapes the payload.
 */
export interface FieldSpec {
  name: string;
  label: string;
  type?: 'text' | 'number' | 'date' | 'time' | 'select' | 'checkbox' | 'textarea' | 'password';
  options?: { value: string; label: string }[];
  placeholder?: string;
  defaultValue?: string | number | boolean;
  required?: boolean;
  hint?: string;
  /** Split comma-separated input into a string array before posting. */
  array?: boolean;
}

function coerce(field: FieldSpec, raw: string): unknown {
  if (field.type === 'checkbox') return raw === 'true' || raw === 'on';
  if (field.array) {
    return raw
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  if (field.type === 'number') {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : raw;
  }
  return raw;
}

export function JsonForm({
  action,
  fields,
  submitLabel,
  method = 'POST',
  successMessage = 'Saved.',
  confirmMessage,
}: {
  action: string;
  fields: FieldSpec[];
  submitLabel: string;
  method?: 'POST' | 'PATCH';
  successMessage?: string;
  confirmMessage?: string;
}) {
  const router = useRouter();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      fields.map((field) => [field.name, field.defaultValue === undefined ? '' : String(field.defaultValue)]),
    ),
  );
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function set(name: string, value: string): void {
    setValues((current) => ({ ...current, [name]: value }));
  }

  async function submit(): Promise<void> {
    if (confirmMessage && !window.confirm(confirmMessage)) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const payload: Record<string, unknown> = {};
      for (const field of fields) {
        const raw = values[field.name] ?? '';
        if (raw === '' && !field.required) continue;
        payload[field.name] = coerce(field, raw);
      }
      await clientFetch(action, { method, body: JSON.stringify(payload) });
      setMessage(successMessage);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That request was rejected.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {message ? <Alert tone="success">{message}</Alert> : null}

      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map((field) => (
          <div key={field.name} className={field.type === 'textarea' ? 'sm:col-span-2' : undefined}>
            <Label htmlFor={`${action}-${field.name}`}>{field.label}</Label>
            {field.type === 'select' ? (
              <Select
                id={`${action}-${field.name}`}
                value={values[field.name] ?? ''}
                onChange={(event) => set(field.name, event.target.value)}
              >
                <option value="">Select…</option>
                {(field.options ?? []).map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            ) : field.type === 'checkbox' ? (
              <Select
                id={`${action}-${field.name}`}
                value={values[field.name] ?? 'false'}
                onChange={(event) => set(field.name, event.target.value)}
              >
                <option value="false">No</option>
                <option value="true">Yes</option>
              </Select>
            ) : (
              <Input
                id={`${action}-${field.name}`}
                type={
                  field.type === 'number'
                    ? 'number'
                    : field.type === 'date'
                      ? 'date'
                      : field.type === 'time'
                        ? 'time'
                        : field.type === 'password'
                          ? 'password'
                          : 'text'
                }
                inputMode={field.type === 'number' ? 'decimal' : undefined}
                placeholder={field.placeholder}
                value={values[field.name] ?? ''}
                onChange={(event) => set(field.name, event.target.value)}
              />
            )}
            {field.hint ? <p className="mt-1 text-xs text-slate-500">{field.hint}</p> : null}
          </div>
        ))}
      </div>

      <Button disabled={busy} onClick={() => void submit()}>
        {busy ? 'Saving…' : submitLabel}
      </Button>
    </div>
  );
}
