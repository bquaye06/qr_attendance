import { Badge, Card, CardBody, CardHeader, CardTitle, EmptyState } from '@attend/ui';
import { apiFetch, requireRole } from '@/lib/api';
import { JsonForm } from '@/components/admin/JsonForm';
import { ApiKeyForm } from './ApiKeyForm';

export const metadata = { title: 'Integrations · Attend' };

interface ApiKeyRow {
  id: string;
  name: string;
  scopes: string[];
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

interface WebhookRow {
  id: string;
  url: string;
  events: string[];
  is_active: boolean;
  created_at: string;
}

export default async function IntegrationsPage() {
  await requireRole('admin');
  const { apiKeys, webhooks } = await apiFetch<{ apiKeys: ApiKeyRow[]; webhooks: WebhookRow[] }>(
    '/api/v1/admin/integrations',
  );

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Integrations</h1>
        <p className="text-sm text-slate-600">
          API keys for the student information system and the LMS, plus webhooks on attendance and session events.
          Only a hash of a key is stored, so a key is shown once at creation and never again.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>API keys ({apiKeys.length})</CardTitle>
        </CardHeader>
        <CardBody className="space-y-3">
          {apiKeys.length === 0 ? (
            <EmptyState title="No keys" description="Create one below for your SIS integration." />
          ) : (
            apiKeys.map((key) => (
              <div key={key.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2 last:border-0">
                <div>
                  <p className="text-sm font-medium">{key.name}</p>
                  <p className="text-xs text-slate-500">
                    {key.scopes.join(', ')} · created {new Date(key.created_at).toLocaleDateString('en-GB')}
                    {key.last_used_at ? ` · last used ${new Date(key.last_used_at).toLocaleDateString('en-GB')}` : ''}
                  </p>
                </div>
                <Badge tone={key.revoked_at ? 'danger' : 'success'}>{key.revoked_at ? 'revoked' : 'active'}</Badge>
              </div>
            ))
          )}
          <ApiKeyForm />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Webhooks ({webhooks.length})</CardTitle>
        </CardHeader>
        <CardBody className="space-y-3">
          {webhooks.length === 0 ? (
            <EmptyState title="No webhooks" description="Subscribe an endpoint to attendance.recorded or session.closed." />
          ) : (
            webhooks.map((hook) => (
              <div key={hook.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2 last:border-0">
                <div>
                  <p className="break-all text-sm font-medium">{hook.url}</p>
                  <p className="text-xs text-slate-500">{hook.events.join(', ')}</p>
                </div>
                <Badge tone={hook.is_active ? 'success' : 'neutral'}>{hook.is_active ? 'active' : 'paused'}</Badge>
              </div>
            ))
          )}

          <div className="rounded-lg border border-slate-200 p-3">
            <p className="mb-3 text-sm font-medium">Add a webhook</p>
            <JsonForm
              action="/api/v1/admin/integrations/webhooks"
              submitLabel="Add webhook"
              successMessage="Webhook saved."
              fields={[
                { name: 'url', label: 'Endpoint URL', required: true, placeholder: 'https://sis.example.edu/hooks/attend' },
                {
                  name: 'events',
                  label: 'Events',
                  array: true,
                  required: true,
                  defaultValue: 'attendance.recorded',
                  hint: 'attendance.recorded, session.closed',
                },
                {
                  name: 'secret',
                  label: 'Signing secret',
                  type: 'password',
                  required: true,
                  hint: 'At least 16 characters; used to sign the request body',
                },
              ]}
            />
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
