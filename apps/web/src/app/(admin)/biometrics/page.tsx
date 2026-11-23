import { Alert, Badge, Card, CardBody, CardHeader, CardTitle, EmptyState } from '@attend/ui';
import { apiFetch, requireRole } from '@/lib/api';
import { PurgeButton } from './PurgeButton';

export const metadata = { title: 'Biometrics · Attend' };

interface StudentRow {
  id: string;
  student_number: string;
  name: string;
  consent: boolean;
  templates: number;
  enrolled_at: string | null;
  biometric_failure_count: number;
}

export default async function BiometricsPage() {
  await requireRole('admin');
  const { students } = await apiFetch<{ students: StudentRow[] }>('/api/v1/admin/biometrics');

  const withoutConsent = students.filter((student) => !student.consent).length;
  const enrolled = students.filter((student) => student.templates > 0).length;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Biometrics</h1>
        <p className="text-sm text-slate-600">
          Enrolment status, consent and failures. Purges need two different administrators: the first requests, the
          second approves from their own session.
        </p>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
          <p className="text-xs uppercase tracking-wide text-slate-500">Students</p>
          <p className="mt-1 text-2xl font-semibold">{students.length}</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
          <p className="text-xs uppercase tracking-wide text-slate-500">Enrolled faces</p>
          <p className="mt-1 text-2xl font-semibold">{enrolled}</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
          <p className="text-xs uppercase tracking-wide text-slate-500">Without consent</p>
          <p className="mt-1 text-2xl font-semibold">{withoutConsent}</p>
        </div>
      </div>

      <Alert tone="info" title="What is stored">
        One 512-number embedding per student, in the isolated <code>biometrics</code> schema. No images, ever.
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle>Per student</CardTitle>
        </CardHeader>
        <CardBody className="overflow-x-auto p-0">
          {students.length === 0 ? (
            <div className="p-4">
              <EmptyState title="No students yet" />
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2">Student</th>
                  <th className="px-4 py-2">Consent</th>
                  <th className="px-4 py-2">Templates</th>
                  <th className="px-4 py-2">Enrolled</th>
                  <th className="px-4 py-2">Failures</th>
                  <th className="px-4 py-2">Purge</th>
                </tr>
              </thead>
              <tbody>
                {students.map((student) => (
                  <tr key={student.id} className="border-t border-slate-100">
                    <td className="px-4 py-2">
                      <p className="font-medium">{student.name}</p>
                      <p className="text-xs text-slate-500">{student.student_number}</p>
                    </td>
                    <td className="px-4 py-2">
                      <Badge tone={student.consent ? 'success' : 'danger'}>
                        {student.consent ? 'granted' : 'none'}
                      </Badge>
                    </td>
                    <td className="px-4 py-2 text-xs">{student.templates}</td>
                    <td className="px-4 py-2 text-xs">
                      {student.enrolled_at ? new Date(student.enrolled_at).toLocaleDateString('en-GB') : '—'}
                    </td>
                    <td className="px-4 py-2 text-xs">{student.biometric_failure_count}</td>
                    <td className="px-4 py-2">
                      <PurgeButton studentId={student.id} hasTemplates={student.templates > 0} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
