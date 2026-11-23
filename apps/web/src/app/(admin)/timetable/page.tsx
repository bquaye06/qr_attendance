import { Card, CardBody, CardHeader, CardTitle, EmptyState } from '@attend/ui';
import { apiFetch, requireRole } from '@/lib/api';
import { JsonForm } from '@/components/admin/JsonForm';
import { GenerateSessionsForm } from './GenerateSessionsForm';

export const metadata = { title: 'Timetable · Attend' };

interface Slot {
  id: string;
  day_of_week: number;
  starts_at: string;
  ends_at: string;
  valid_from: string;
  valid_to: string;
  course_code: string;
  course_title: string;
  room_name: string;
  offering_id: string;
  term_name: string;
  session_count: number;
}

interface Row {
  id: string;
  [key: string]: unknown;
}

const DAYS = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export default async function TimetablePage() {
  await requireRole('admin');
  const [slots, offerings, rooms, terms, courses] = await Promise.all([
    apiFetch<{ slots: Slot[] }>('/api/v1/admin/timetable'),
    apiFetch<{ items: Row[] }>('/api/v1/admin/offerings'),
    apiFetch<{ items: Row[] }>('/api/v1/admin/rooms'),
    apiFetch<{ items: Row[] }>('/api/v1/admin/terms'),
    apiFetch<{ items: Row[] }>('/api/v1/admin/courses'),
  ]);

  const courseById = new Map(courses.items.map((course) => [course.id, String(course['code'])]));
  const termById = new Map(terms.items.map((term) => [term.id, String(term['name'])]));
  const offeringOptions = offerings.items.map((offering) => ({
    value: offering.id,
    label: `${courseById.get(String(offering['course_id'])) ?? 'course'} · section ${String(
      offering['section'],
    )} · ${termById.get(String(offering['term_id'])) ?? 'term'}`,
  }));
  const roomOptions = rooms.items.map((room) => ({ value: room.id, label: String(room['name']) }));
  const termOptions = terms.items.map((term) => ({ value: term.id, label: String(term['name']) }));

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Timetable</h1>
        <p className="text-sm text-slate-600">
          Recurring slots per offering and room. Generating sessions creates one <code>class_session</code> per
          occurrence, with the check-in window computed from the institution defaults.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recurring slots ({slots.slots.length})</CardTitle>
        </CardHeader>
        <CardBody className="overflow-x-auto p-0">
          {slots.slots.length === 0 ? (
            <div className="p-4">
              <EmptyState title="No slots yet" description="Add the first slot below, then generate sessions." />
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2">Course</th>
                  <th className="px-4 py-2">Room</th>
                  <th className="px-4 py-2">Day</th>
                  <th className="px-4 py-2">Time</th>
                  <th className="px-4 py-2">Valid</th>
                  <th className="px-4 py-2">Sessions</th>
                </tr>
              </thead>
              <tbody>
                {slots.slots.map((slot) => (
                  <tr key={slot.id} className="border-t border-slate-100">
                    <td className="px-4 py-2">
                      <p className="font-medium">{slot.course_code}</p>
                      <p className="text-xs text-slate-500">{slot.term_name}</p>
                    </td>
                    <td className="px-4 py-2 text-xs">{slot.room_name}</td>
                    <td className="px-4 py-2 text-xs">{DAYS[slot.day_of_week]}</td>
                    <td className="px-4 py-2 text-xs">
                      {slot.starts_at.slice(0, 5)}–{slot.ends_at.slice(0, 5)}
                    </td>
                    <td className="px-4 py-2 text-xs">
                      {slot.valid_from} → {slot.valid_to}
                    </td>
                    <td className="px-4 py-2 text-xs">{slot.session_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Add a recurring slot</CardTitle>
          </CardHeader>
          <CardBody>
            <JsonForm
              action="/api/v1/admin/timetable"
              submitLabel="Add slot"
              successMessage="Slot added. Generate sessions for the term to create class sessions."
              fields={[
                { name: 'offeringId', label: 'Offering', type: 'select', options: offeringOptions, required: true },
                { name: 'roomId', label: 'Room', type: 'select', options: roomOptions, required: true },
                { name: 'dayOfWeek', label: 'Day (1=Mon, 7=Sun)', type: 'number', required: true, defaultValue: 1 },
                { name: 'startsAt', label: 'Starts', type: 'time', required: true },
                { name: 'endsAt', label: 'Ends', type: 'time', required: true },
                { name: 'validFrom', label: 'Valid from', type: 'date', required: true },
                { name: 'validTo', label: 'Valid to', type: 'date', required: true },
              ]}
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Generate sessions</CardTitle>
          </CardHeader>
          <CardBody>
            <GenerateSessionsForm terms={termOptions} />
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
