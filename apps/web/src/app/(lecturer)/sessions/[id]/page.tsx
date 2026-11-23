import { apiFetch, requireRole } from '@/lib/api';
import { LiveClient } from './LiveClient';

export const metadata = { title: 'Live session · Attend' };

interface RosterResponse {
  session: {
    id: string;
    courseCode: string;
    courseTitle: string;
    roomName: string | null;
    checkinClosesAt: string;
    status: string;
    enrolledCount: number;
    presentCount: number;
    lateCount: number;
    flaggedCount: number;
    absentCount: number;
  };
  entries: {
    studentId: string;
    studentNumber: string;
    name: string;
    status: string;
    method: string | null;
    checkedInAt: string | null;
    flagReason: string | null;
    riskScore: number | null;
  }[];
}

export default async function LiveSessionPage({ params }: { params: Promise<{ id: string }> }) {
  await requireRole('lecturer');
  const { id } = await params;
  const roster = await apiFetch<RosterResponse>(`/api/v1/sessions/${id}/roster`);

  return (
    <LiveClient
      sessionId={id}
      meta={{
        courseCode: roster.session.courseCode,
        courseTitle: roster.session.courseTitle,
        roomName: roster.session.roomName,
        checkinClosesAt: roster.session.checkinClosesAt,
        status: roster.session.status,
      }}
      initial={{
        counts: {
          enrolled: roster.session.enrolledCount,
          present: roster.session.presentCount,
          late: roster.session.lateCount,
          flagged: roster.session.flaggedCount,
          absent: roster.session.absentCount,
          excused: 0,
        },
        entries: roster.entries,
      }}
    />
  );
}
