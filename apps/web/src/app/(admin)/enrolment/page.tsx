import { Card, CardBody, CardHeader, CardTitle } from '@attend/ui';
import { apiFetch, requireRole } from '@/lib/api';
import { EnrolImport } from './EnrolImport';

export const metadata = { title: 'Enrolment · Attend' };

interface Row {
  id: string;
  [key: string]: unknown;
}

export default async function EnrolmentPage() {
  await requireRole('admin');
  const [offerings, courses, terms] = await Promise.all([
    apiFetch<{ items: Row[] }>('/api/v1/admin/offerings'),
    apiFetch<{ items: Row[] }>('/api/v1/admin/courses'),
    apiFetch<{ items: Row[] }>('/api/v1/admin/terms'),
  ]);

  const courseById = new Map(courses.items.map((course) => [course.id, `${course['code']} — ${course['title']}`]));
  const termById = new Map(terms.items.map((term) => [term.id, String(term['name'])]));

  const options = offerings.items.map((offering) => ({
    value: offering.id,
    label: `${courseById.get(String(offering['course_id'])) ?? 'Unknown course'} · section ${String(
      offering['section'],
    )} · ${termById.get(String(offering['term_id'])) ?? 'unknown term'}`,
  }));

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Enrolment</h1>
        <p className="text-sm text-slate-600">
          Paste student numbers from a class list. Validate first: the preview shows what would change, what is
          already enrolled, and which numbers do not exist.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Bulk enrol into an offering</CardTitle>
        </CardHeader>
        <CardBody>
          <EnrolImport offerings={options} />
        </CardBody>
      </Card>
    </div>
  );
}
