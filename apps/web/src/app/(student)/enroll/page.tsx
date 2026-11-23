import { apiFetch, requireRole } from '@/lib/api';
import { EnrollClient } from './EnrollClient';

export const metadata = { title: 'Setup · Attend' };

export default async function EnrollPage() {
  await requireRole('student');
  const status = await apiFetch<{
    consent: { grantedAt: string | null };
    face: { enrolled: boolean };
    device: { bound: boolean };
  }>('/api/v1/biometrics/status');

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">One-time setup</h1>
      <EnrollClient
        initial={{
          consent: status.consent.grantedAt !== null,
          deviceBound: status.device.bound,
          faceEnrolled: status.face.enrolled,
        }}
      />
    </div>
  );
}
