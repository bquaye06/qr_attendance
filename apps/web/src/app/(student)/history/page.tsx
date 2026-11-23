import Link from 'next/link';
import { AttendanceBadge, Card, CardBody, CardHeader, CardTitle, EmptyState, ProgressLike } from '@attend/ui';
import { apiFetch, requireRole } from '@/lib/api';

export const metadata = { title: 'History · Attend' };

interface Summary {
  records: {
    id: string;
    courseCode: string;
    courseTitle: string;
    startsAt: string;
    status: string;
    method: string;
    roomName: string | null;
  }[];
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
}

export default async function HistoryPage() {
  await requireRole('student');
  const summary = await apiFetch<Summary>('/api/v1/me/attendance');

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Your attendance</h1>

      <Card>
        <CardHeader>
          <CardTitle>By course</CardTitle>
        </CardHeader>
        <CardBody className="space-y-3">
          {summary.perCourse.length === 0 ? (
            <EmptyState title="No courses yet" description="Once you are enrolled in a course, it appears here." />
          ) : (
            summary.perCourse.map((course) => (
              <div key={course.offeringId}>
                <div className="flex items-baseline justify-between">
                  <p className="text-sm font-medium">
                    {course.courseCode} <span className="text-slate-500">{course.courseTitle}</span>
                  </p>
                  <p className={`text-sm font-semibold ${course.belowThreshold ? 'text-red-600' : 'text-emerald-700'}`}>
                    {course.percent}%
                  </p>
                </div>
                <ProgressLike value={course.percent} threshold={course.threshold} />
                <p className="mt-1 text-xs text-slate-500">
                  {course.attended} of {course.held} sessions · threshold {course.threshold}%
                  {course.belowThreshold ? ' · below threshold' : ''}
                </p>
              </div>
            ))
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Every session</CardTitle>
        </CardHeader>
        <CardBody className="space-y-2">
          {summary.records.length === 0 ? (
            <EmptyState title="Nothing recorded yet" />
          ) : (
            summary.records.map((record) => (
              <div key={record.id} className="flex items-center justify-between gap-3 border-b border-slate-100 py-2 last:border-0">
                <div>
                  <p className="text-sm font-medium">{record.courseCode}</p>
                  <p className="text-xs text-slate-500">
                    {new Date(record.startsAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}
                    {record.roomName ? ` · ${record.roomName}` : ''}
                    {record.method === 'manual' ? ' · manual' : ''}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <AttendanceBadge status={record.status} />
                  {record.status === 'absent' ? (
                    <Link href={`/student/appeals?recordId=${record.id}`} className="text-xs underline">
                      Appeal
                    </Link>
                  ) : null}
                </div>
              </div>
            ))
          )}
        </CardBody>
      </Card>
    </div>
  );
}
