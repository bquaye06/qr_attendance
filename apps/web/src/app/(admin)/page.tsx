import Link from 'next/link';
import { Alert, Badge, Card, CardBody, CardHeader, CardTitle, Stat } from '@attend/ui';
import { apiFetch, requireRole } from '@/lib/api';

export const metadata = { title: 'Dashboard · Attend' };

interface Dashboard {
  today: { sessionsScheduled: number; sessionsOpen: number; attendanceRate: number; checkins: number };
  term: { attendanceRate: number; sessionsHeld: number; checkins: number };
  byFaculty: { facultyId: string; name: string; attendanceRate: number; checkins: number }[];
  flagged24h: number;
  failed24h: number;
  faceService: { status: 'ok' | 'degraded' | 'down'; p95Ms: number | null; modelVersion: string | null };
  pendingResets: number;
  pendingReviews: number;
}

export default async function AdminDashboard() {
  await requireRole('admin');
  const data = await apiFetch<Dashboard>('/api/v1/admin/dashboard');

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Today</h1>
        <Badge tone={data.faceService.status === 'ok' ? 'success' : data.faceService.status === 'degraded' ? 'warning' : 'danger'}>
          Face service: {data.faceService.status}
          {data.faceService.modelVersion ? ` (${data.faceService.modelVersion})` : ''}
        </Badge>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Sessions today" value={data.today.sessionsScheduled} detail={`${data.today.sessionsOpen} open now`} />
        <Stat label="Attendance today" value={`${data.today.attendanceRate}%`} />
        <Stat label="Check-ins (24h)" value={data.today.checkins} />
        <Stat label="Failed attempts (24h)" value={data.failed24h} />
      </div>

      {(data.pendingReviews > 0 || data.pendingResets > 0 || data.flagged24h > 0) && (
        <Alert tone="warning" title="Needs attention">
          <ul className="mt-1 list-disc pl-5">
            {data.pendingReviews > 0 ? (
              <li>
                {data.pendingReviews} flagged {data.pendingReviews === 1 ? 'check-in' : 'check-ins'} waiting in the{' '}
                <Link href="/admin/review" className="underline">
                  review queue
                </Link>
              </li>
            ) : null}
            {data.pendingResets > 0 ? <li>{data.pendingResets} device reset requests pending</li> : null}
            {data.flagged24h > 0 ? <li>{data.flagged24h} records flagged in the last 24 hours</li> : null}
          </ul>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Attendance by faculty</CardTitle>
        </CardHeader>
        <CardBody className="space-y-2">
          {data.byFaculty.length === 0 ? (
            <p className="text-sm text-slate-500">No sessions recorded yet.</p>
          ) : (
            data.byFaculty.map((faculty) => (
              <div key={faculty.facultyId} className="flex items-center justify-between border-b border-slate-100 py-2 last:border-0">
                <span className="text-sm">{faculty.name}</span>
                <span className="text-sm font-medium">
                  {faculty.attendanceRate}% <span className="text-xs text-slate-500">({faculty.checkins} presences)</span>
                </span>
              </div>
            ))
          )}
        </CardBody>
      </Card>

      <p className="text-xs text-slate-500">
        Console screens for academic structure, people, timetable, enrolment, biometrics, roles, integrations and
        exports are served by the API; only dashboard, review queue, settings, devices and the audit log have pages in
        this build. See docs/DECISIONS.md for the exact list.
      </p>
    </div>
  );
}
