import { Badge, Card, CardBody, CardHeader, CardTitle, EmptyState } from '@attend/ui';
import { DeviceResetActions } from '@/components/admin/DeviceResetActions';
import { DeviceRevokeButton } from '@/components/admin/DeviceRevokeButton';
import { apiFetch, requireRole } from '@/lib/api';

export const metadata = { title: 'Devices · Attend' };

interface DeviceRow {
  id: string;
  status: string;
  platform: string;
  user_agent_family: string;
  bound_at: string;
  revoked_at: string | null;
  student_number: string;
  name: string;
}

interface ResetRow {
  id: string;
  status: string;
  reason: string;
  created_at: string;
  student_number: string;
  name: string;
}

export default async function DevicesPage() {
  await requireRole('admin');
  const { devices, resets } = await apiFetch<{ devices: DeviceRow[]; resets: ResetRow[] }>('/api/v1/admin/devices');

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Devices</h1>

      <Card>
        <CardHeader>
          <CardTitle>Pending reset requests</CardTitle>
        </CardHeader>
        <CardBody className="space-y-2">
          {resets.length === 0 ? (
            <EmptyState title="No pending requests" />
          ) : (
            resets.map((reset) => (
              <div key={reset.id} className="flex items-start justify-between border-b border-slate-100 py-2 last:border-0">
                <div>
                  <p className="text-sm font-medium">
                    {reset.name} <span className="text-slate-500">({reset.student_number})</span>
                  </p>
                  <p className="text-xs text-slate-600">{reset.reason}</p>
                  <p className="text-xs text-slate-400">{new Date(reset.created_at).toLocaleString('en-GB')}</p>
                </div>
                <DeviceResetActions requestId={reset.id} />
              </div>
            ))
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Bound devices</CardTitle>
        </CardHeader>
        <CardBody className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2">Student</th>
                <th className="px-4 py-2">Platform</th>
                <th className="px-4 py-2">Bound</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Action</th>
              </tr>
            </thead>
            <tbody>
              {devices.slice(0, 100).map((device) => (
                <tr key={device.id} className="border-t border-slate-100">
                  <td className="px-4 py-2">
                    {device.name} <span className="text-xs text-slate-500">{device.student_number}</span>
                  </td>
                  <td className="px-4 py-2 text-xs">
                    {device.platform} · {device.user_agent_family}
                  </td>
                  <td className="px-4 py-2 text-xs">{new Date(device.bound_at).toLocaleDateString('en-GB')}</td>
                  <td className="px-4 py-2">
                    <Badge tone={device.status === 'active' ? 'success' : 'neutral'}>{device.status}</Badge>
                  </td>
                  <td className="px-4 py-2">
                    {device.status === 'active' ? <DeviceRevokeButton deviceId={device.id} /> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardBody>
      </Card>
    </div>
  );
}
