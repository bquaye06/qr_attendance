import { Badge, Card, CardBody, CardHeader, CardTitle, EmptyState, Input } from '@attend/ui';
import { apiFetch, requireRole } from '@/lib/api';
import { StatusToggle } from './StatusToggle';

export const metadata = { title: 'People · Attend' };

interface StudentRow {
  id: string;
  student_number: string;
  name: string;
  email: string;
  status: string;
  enrollments: number;
}

interface StaffRow {
  id: string;
  staff_number: string;
  name: string;
  email: string;
  status: string;
  department: string;
  is_teaching_assistant: boolean;
}

export default async function PeoplePage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  await requireRole('admin');
  const { q } = await searchParams;
  const query = q ? `?q=${encodeURIComponent(q)}` : '';
  const data = await apiFetch<{ students: StudentRow[]; staff: StaffRow[] }>(`/api/v1/admin/people${query}`);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">People</h1>
        <p className="text-sm text-slate-600">
          Suspend an account to block sign-in immediately; sessions on that account stop working on the next request.
        </p>
      </div>

      <form action="/admin/people" method="get" className="flex gap-2">
        <Input name="q" defaultValue={q ?? ''} placeholder="Search name, number or email" />
        <button type="submit" className="h-11 rounded-lg bg-slate-900 px-4 text-sm text-white">
          Search
        </button>
      </form>

      <Card>
        <CardHeader>
          <CardTitle>Students ({data.students.length})</CardTitle>
        </CardHeader>
        <CardBody className="overflow-x-auto p-0">
          {data.students.length === 0 ? (
            <div className="p-4">
              <EmptyState title="No students match" />
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2">Student</th>
                  <th className="px-4 py-2">Email</th>
                  <th className="px-4 py-2">Courses</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2">Action</th>
                </tr>
              </thead>
              <tbody>
                {data.students.map((student) => (
                  <tr key={student.id} className="border-t border-slate-100">
                    <td className="px-4 py-2">
                      <p className="font-medium">{student.name}</p>
                      <p className="text-xs text-slate-500">{student.student_number}</p>
                    </td>
                    <td className="px-4 py-2 text-xs">{student.email}</td>
                    <td className="px-4 py-2 text-xs">{student.enrollments}</td>
                    <td className="px-4 py-2">
                      <Badge tone={student.status === 'active' ? 'success' : 'danger'}>{student.status}</Badge>
                    </td>
                    <td className="px-4 py-2">
                      <StatusToggle userId={student.id} status={student.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Staff ({data.staff.length})</CardTitle>
        </CardHeader>
        <CardBody className="overflow-x-auto p-0">
          {data.staff.length === 0 ? (
            <div className="p-4">
              <EmptyState title="No staff match" />
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2">Staff</th>
                  <th className="px-4 py-2">Department</th>
                  <th className="px-4 py-2">Role</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2">Action</th>
                </tr>
              </thead>
              <tbody>
                {data.staff.map((member) => (
                  <tr key={member.id} className="border-t border-slate-100">
                    <td className="px-4 py-2">
                      <p className="font-medium">{member.name}</p>
                      <p className="text-xs text-slate-500">
                        {member.staff_number} · {member.email}
                      </p>
                    </td>
                    <td className="px-4 py-2 text-xs">{member.department}</td>
                    <td className="px-4 py-2 text-xs">{member.is_teaching_assistant ? 'Teaching assistant' : 'Lecturer'}</td>
                    <td className="px-4 py-2">
                      <Badge tone={member.status === 'active' ? 'success' : 'danger'}>{member.status}</Badge>
                    </td>
                    <td className="px-4 py-2">
                      <StatusToggle userId={member.id} status={member.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>

      <p className="text-xs text-slate-500">
        Creating people and bulk CSV import are API-only in this build (`POST /api/v1/admin/people`,
        `PATCH /api/v1/admin/users/:id/status`). See docs/DECISIONS.md D-010.
      </p>
    </div>
  );
}
