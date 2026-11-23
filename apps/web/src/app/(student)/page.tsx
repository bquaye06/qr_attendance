import Link from 'next/link';
import { Badge, Card, CardBody, CardHeader, CardTitle, EmptyState, Stat } from '@attend/ui';
import { apiFetch, requireRole } from '@/lib/api';

export const metadata = { title: 'Home · Attend' };

interface Eligibility {
  ready: boolean;
  consent: boolean;
  faceEnrolled: boolean;
  deviceBound: boolean;
  pendingReset: boolean;
  missing: string[];
}

interface Summary {
  perCourse: {
    offeringId: string;
    courseCode: string;
    courseTitle: string;
    held: number;
    attended: number;
    percent: number;
    belowThreshold: boolean;
    threshold: number;
  }[];
  records: { id: string; courseCode: string; startsAt: string; status: string }[];
}

export default async function StudentHome() {
  const me = await requireRole('student');
  const [eligibility, summary] = await Promise.all([
    apiFetch<Eligibility>('/api/v1/checkin/eligibility'),
    apiFetch<Summary>('/api/v1/me/attendance'),
  ]);

  const steps = [
    { key: 'consent', done: eligibility.consent, label: 'Accept the biometric notice', href: '/student/enroll' },
    { key: 'device', done: eligibility.deviceBound, label: 'Register this phone', href: '/student/enroll' },
    { key: 'face', done: eligibility.faceEnrolled, label: 'Enrol your face', href: '/student/enroll' },
  ];

  return (
    <div className="space-y-5">
      <section>
        <h1 className="text-xl font-semibold">Hello {me.name.split(' ')[0]}</h1>
        <p className="text-sm text-slate-600">
          {eligibility.ready
            ? 'You are ready to check in. Scan the code on the screen when your class starts.'
            : 'Finish setup once, then check-in takes a few seconds.'}
        </p>
      </section>

      {eligibility.ready ? (
        <Link
          href="/student/checkin"
          className="block rounded-xl bg-slate-900 px-5 py-6 text-center text-white hover:bg-slate-800"
        >
          <span className="text-lg font-semibold">Scan the QR code</span>
          <span className="mt-1 block text-sm text-slate-300">Presence + face + this device</span>
        </Link>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Finish setup</CardTitle>
          </CardHeader>
          <CardBody className="space-y-3">
            {steps.map((step) => (
              <div key={step.key} className="flex items-center justify-between gap-3">
                <span className="text-sm text-slate-700">{step.label}</span>
                {step.done ? (
                  <Badge tone="success">Done</Badge>
                ) : (
                  <Link href={step.href} className="text-sm font-medium text-slate-900 underline">
                    Start
                  </Link>
                )}
              </div>
            ))}
            {eligibility.pendingReset ? (
              <p className="text-xs text-amber-700">
                A device reset is waiting for approval. You can still be marked present manually by your lecturer.
              </p>
            ) : null}
          </CardBody>
        </Card>
      )}

      <section className="grid grid-cols-2 gap-3">
        {summary.perCourse.slice(0, 4).map((course) => (
          <Stat
            key={course.offeringId}
            label={course.courseCode}
            value={`${course.percent}%`}
            detail={`${course.attended}/${course.held} attended`}
          />
        ))}
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Recent attendance</CardTitle>
        </CardHeader>
        <CardBody className="space-y-2">
          {summary.records.length === 0 ? (
            <EmptyState title="No attendance yet" description="Your records appear here after your first check-in." />
          ) : (
            summary.records.slice(0, 6).map((record) => (
              <div key={record.id} className="flex items-center justify-between border-b border-slate-100 py-2 last:border-0">
                <div>
                  <p className="text-sm font-medium">{record.courseCode}</p>
                  <p className="text-xs text-slate-500">{new Date(record.startsAt).toLocaleString('en-GB')}</p>
                </div>
                <Badge tone={record.status === 'absent' ? 'danger' : record.status === 'late' ? 'info' : 'success'}>
                  {record.status.replace('_', ' ')}
                </Badge>
              </div>
            ))
          )}
        </CardBody>
      </Card>

      <div className="flex gap-3">
        <Link href="/student/history" className="flex-1 rounded-lg border border-slate-300 bg-white px-4 py-3 text-center text-sm">
          Full history
        </Link>
        <Link href="/student/appeals" className="flex-1 rounded-lg border border-slate-300 bg-white px-4 py-3 text-center text-sm">
          Appeals
        </Link>
      </div>
    </div>
  );
}
