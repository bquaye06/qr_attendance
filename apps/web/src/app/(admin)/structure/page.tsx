import { Card, CardBody, CardHeader, CardTitle, EmptyState } from '@attend/ui';
import { apiFetch, requireRole } from '@/lib/api';
import { JsonForm } from '@/components/admin/JsonForm';
import type { FieldSpec } from '@/components/admin/JsonForm';

export const metadata = { title: 'Academic structure · Attend' };

interface Row {
  id: string;
  [key: string]: unknown;
}

const label = (rows: Row[], idKey: string, textKey: string): { value: string; label: string }[] =>
  rows.map((row) => ({ value: String(row[idKey]), label: String(row[textKey]) }));

export default async function StructurePage() {
  await requireRole('admin');

  const [faculties, departments, programmes, courses, terms, rooms, offerings] = await Promise.all([
    apiFetch<{ items: Row[] }>('/api/v1/admin/faculties'),
    apiFetch<{ items: Row[] }>('/api/v1/admin/departments'),
    apiFetch<{ items: Row[] }>('/api/v1/admin/programmes'),
    apiFetch<{ items: Row[] }>('/api/v1/admin/courses'),
    apiFetch<{ items: Row[] }>('/api/v1/admin/terms'),
    apiFetch<{ items: Row[] }>('/api/v1/admin/rooms'),
    apiFetch<{ items: Row[] }>('/api/v1/admin/offerings'),
  ]);

  const facultyOptions = label(faculties.items, 'id', 'name');
  const departmentOptions = label(departments.items, 'id', 'name');
  const courseOptions = label(courses.items, 'id', 'code');
  const termOptions = terms.items.map((term) => ({ value: term.id, label: String(term['name']) }));
  const courseById = new Map(courses.items.map((course) => [course.id, String(course['code'])]));
  const termById = new Map(terms.items.map((term) => [term.id, String(term['name'])]));

  const sections: {
    title: string;
    action: string;
    rows: Row[];
    columns: { key: string; label: string }[];
    fields: FieldSpec[];
    submitLabel: string;
  }[] = [
    {
      title: 'Faculties',
      action: '/api/v1/admin/faculties',
      rows: faculties.items,
      columns: [
        { key: 'name', label: 'Name' },
        { key: 'code', label: 'Code' },
      ],
      fields: [
        { name: 'name', label: 'Name', required: true },
        { name: 'code', label: 'Code', required: true, placeholder: 'SCI' },
      ],
      submitLabel: 'Add faculty',
    },
    {
      title: 'Departments',
      action: '/api/v1/admin/departments',
      rows: departments.items,
      columns: [
        { key: 'name', label: 'Name' },
        { key: 'code', label: 'Code' },
        { key: 'faculty_id', label: 'Faculty' },
      ],
      fields: [
        { name: 'name', label: 'Name', required: true },
        { name: 'code', label: 'Code', required: true },
        { name: 'facultyId', label: 'Faculty', type: 'select', options: facultyOptions, required: true },
      ],
      submitLabel: 'Add department',
    },
    {
      title: 'Programmes',
      action: '/api/v1/admin/programmes',
      rows: programmes.items,
      columns: [
        { key: 'name', label: 'Name' },
        { key: 'code', label: 'Code' },
        { key: 'department_id', label: 'Department' },
      ],
      fields: [
        { name: 'name', label: 'Name', required: true },
        { name: 'code', label: 'Code', required: true },
        { name: 'departmentId', label: 'Department', type: 'select', options: departmentOptions, required: true },
      ],
      submitLabel: 'Add programme',
    },
    {
      title: 'Courses',
      action: '/api/v1/admin/courses',
      rows: courses.items,
      columns: [
        { key: 'code', label: 'Code' },
        { key: 'title', label: 'Title' },
        { key: 'credit_hours', label: 'Credits' },
      ],
      fields: [
        { name: 'code', label: 'Course code', required: true, placeholder: 'CS201' },
        { name: 'title', label: 'Title', required: true },
        { name: 'departmentId', label: 'Department', type: 'select', options: departmentOptions, required: true },
        { name: 'creditHours', label: 'Credit hours', type: 'number', defaultValue: 3 },
      ],
      submitLabel: 'Add course',
    },
    {
      title: 'Terms',
      action: '/api/v1/admin/terms',
      rows: terms.items,
      columns: [
        { key: 'name', label: 'Name' },
        { key: 'starts_on', label: 'Starts' },
        { key: 'ends_on', label: 'Ends' },
        { key: 'is_current', label: 'Current' },
      ],
      fields: [
        { name: 'name', label: 'Name', required: true, placeholder: '2026/2027 Semester 1' },
        { name: 'startsOn', label: 'Starts on', type: 'date', required: true },
        { name: 'endsOn', label: 'Ends on', type: 'date', required: true },
        { name: 'isCurrent', label: 'Current term', type: 'checkbox' },
      ],
      submitLabel: 'Add term',
    },
    {
      title: 'Rooms',
      action: '/api/v1/admin/rooms',
      rows: rooms.items,
      columns: [
        { key: 'name', label: 'Name' },
        { key: 'building', label: 'Building' },
        { key: 'geofence_m', label: 'Geofence (m)' },
        { key: 'allowed_cidrs', label: 'Allowed CIDRs' },
      ],
      fields: [
        { name: 'name', label: 'Name', required: true },
        { name: 'building', label: 'Building' },
        { name: 'latitude', label: 'Latitude', type: 'number', hint: 'Optional: enables geofencing for this room' },
        { name: 'longitude', label: 'Longitude', type: 'number' },
        { name: 'geofenceM', label: 'Geofence radius (m)', type: 'number', defaultValue: 100 },
        {
          name: 'allowedCidrs',
          label: 'Allowed CIDRs',
          array: true,
          hint: 'Comma separated, e.g. 10.20.0.0/16',
        },
      ],
      submitLabel: 'Add room',
    },
    {
      title: 'Offerings',
      action: '/api/v1/admin/offerings',
      rows: offerings.items,
      columns: [
        { key: 'course_id', label: 'Course' },
        { key: 'term_id', label: 'Term' },
        { key: 'section', label: 'Section' },
        { key: 'capacity', label: 'Capacity' },
      ],
      fields: [
        { name: 'courseId', label: 'Course', type: 'select', options: courseOptions, required: true },
        { name: 'termId', label: 'Term', type: 'select', options: termOptions, required: true },
        { name: 'section', label: 'Section', defaultValue: 'A' },
        { name: 'capacity', label: 'Capacity', type: 'number' },
      ],
      submitLabel: 'Add offering',
    },
  ];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold">Academic structure</h1>
        <p className="text-sm text-slate-600">
          Faculties, departments, programmes, courses, terms, rooms and offerings. Every write is audited.
        </p>
      </div>

      {sections.map((section) => (
        <Card key={section.title}>
          <CardHeader>
            <CardTitle>
              {section.title} <span className="font-normal text-slate-500">({section.rows.length})</span>
            </CardTitle>
          </CardHeader>
          <CardBody className="space-y-4">
            {section.rows.length === 0 ? (
              <EmptyState title={`No ${section.title.toLowerCase()} yet`} description="Add the first one below." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      {section.columns.map((column) => (
                        <th key={column.key} className="px-3 py-2">
                          {column.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {section.rows.map((row) => (
                      <tr key={row.id} className="border-t border-slate-100">
                        {section.columns.map((column) => (
                          <td key={column.key} className="px-3 py-2 text-xs">
                            {renderCell(row[column.key], column.key, { courseById, termById })}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <details className="rounded-lg border border-slate-200 p-3">
              <summary className="cursor-pointer text-sm font-medium">{section.submitLabel}</summary>
              <div className="mt-3">
                <JsonForm
                  action={section.action}
                  fields={section.fields}
                  submitLabel={section.submitLabel}
                  successMessage={`${section.title.slice(0, -1)} saved.`}
                />
              </div>
            </details>
          </CardBody>
        </Card>
      ))}
    </div>
  );
}

function renderCell(
  value: unknown,
  key: string,
  maps: { courseById: Map<string, string>; termById: Map<string, string> },
): string {
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : '—';
  if (key === 'course_id') return maps.courseById.get(String(value)) ?? String(value);
  if (key === 'term_id') return maps.termById.get(String(value)) ?? String(value);
  return String(value);
}
