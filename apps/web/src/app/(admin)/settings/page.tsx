import { Card, CardBody, CardHeader, CardTitle } from '@attend/ui';
import { apiFetch, requireRole } from '@/lib/api';
import { SettingsForm } from './SettingsForm';

export const metadata = { title: 'Settings · Attend' };

const LABELS: Record<string, string> = {
  qrRotationSeconds: 'QR rotation (seconds)',
  qrExpirySeconds: 'QR validity (seconds)',
  checkinOpensOffsetMinutes: 'Check-in opens (minutes from start)',
  checkinClosesOffsetMinutes: 'Check-in closes (minutes from start)',
  lateAfterMinutes: 'Late after (minutes)',
  similarityThreshold: 'Face similarity threshold',
  duplicateFaceThreshold: 'Duplicate-face threshold',
  livenessThreshold: 'Liveness threshold',
  qualityThreshold: 'Capture quality threshold',
  requireActiveLiveness: 'Require an active liveness challenge',
  geofenceEnabled: 'Geofencing on by default',
  geofenceDefaultRadiusM: 'Default geofence radius (m)',
  ipAllowlistEnforced: 'Enforce room IP allowlists',
  maxDevicesPerStudent: 'Max active devices per student',
  claimTtlSeconds: 'Claim lifetime (seconds)',
  checkinRateLimitPerMinute: 'Check-in rate limit per minute',
  failuresBeforeFlag: 'Failures before flagging',
  riskFlagThreshold: 'Risk score that triggers review',
  attendanceThresholdPercent: 'Attendance threshold (%)',
  manualOverrideLimitPerSession: 'Manual corrections per session',
  evidenceRetentionDays: 'Evidence retention (days)',
  templatePurgeGraceDays: 'Biometric purge grace (days)',
  adminIdleMinutes: 'Admin idle timeout (minutes)',
  staffIdleMinutes: 'Staff idle timeout (minutes)',
  studentIdleMinutes: 'Student idle timeout (minutes)',
  sessionAutoOpenFromTimetable: 'Open sessions automatically from the timetable',
  requireFirstEnrollmentApproval: 'Require approval of first biometric enrolment',
  timeZone: 'Institution time zone',
};

export default async function SettingsPage() {
  await requireRole('admin');
  const { settings } = await apiFetch<{ settings: Record<string, unknown> }>('/api/v1/admin/settings');

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="text-sm text-slate-600">
          Every change is versioned and audited, and takes effect on the next request — no redeploy.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Attendance policy</CardTitle>
        </CardHeader>
        <CardBody>
          <SettingsForm settings={settings} labels={LABELS} />
        </CardBody>
      </Card>
    </div>
  );
}
