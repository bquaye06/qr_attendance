import { apiFetch } from '@/lib/api';
import { Alert } from '@attend/ui';
import { CheckinClient } from './CheckinClient';

export const metadata = { title: 'Check in · Attend' };

export default async function CheckinPage() {
  const eligibility = await apiFetch<{ ready: boolean; missing: string[] }>('/api/v1/checkin/eligibility');
  const rp = await apiFetch<{ rpId: string }>('/api/v1/devices/rp');

  if (!eligibility.ready) {
    return (
      <Alert tone="warning" title="Finish setup first">
        Missing: {eligibility.missing.join(', ')}. Open the setup screen from your home page.
      </Alert>
    );
  }

  return <CheckinClient rpId={rp.rpId} />;
}
