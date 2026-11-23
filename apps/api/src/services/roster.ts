import { sql } from 'drizzle-orm';
import type { Database } from '@attend/db';
import { RosterEvent } from '@attend/contracts';
import type { AttendanceStatus } from '@attend/contracts';
import { countRoster } from '../domain/report.ts';
import { rows } from '../lib/query.ts';

/**
 * The lecturer's live roster: every enrolled student with their status, plus
 * counts. Shared by the JSON endpoint and the SSE stream, so both always agree.
 */
export interface RosterRow {
  studentId: string;
  studentNumber: string;
  name: string;
  status: AttendanceStatus;
  method: 'auto' | 'manual' | null;
  checkedInAt: string | null;
  flagReason: string | null;
  riskScore: number | null;
  attempted: boolean;
}

export async function loadRoster(database: Database, sessionId: string): Promise<RosterRow[]> {
  const records = await rows<{
    student_id: string;
    student_number: string;
    name: string;
    status: AttendanceStatus | null;
    method: 'auto' | 'manual' | null;
    checked_in_at: string | null;
    flag_reason: string | null;
    risk_score: number | null;
    attempted: boolean;
  }>(
    database,
    sql`
      select st.id as student_id,
             st.student_number,
             u.name,
             r.status,
             r.method,
             r.checked_in_at::text as checked_in_at,
             r.flag_reason,
             r.risk_score,
             exists (
               select 1 from attendance_attempts a
               where a.session_id = ${sessionId}::uuid and a.student_id = st.id
             ) as attempted
      from class_sessions s
      join enrollments e on e.offering_id = s.offering_id and e.status = 'active' and e.deleted_at is null
      join students st on st.id = e.student_id and st.deleted_at is null
      join users u on u.id = st.user_id
      left join attendance_records r on r.session_id = s.id and r.student_id = st.id
      where s.id = ${sessionId}::uuid
      order by st.student_number
    `,
  );

  return records.map((record) => ({
    studentId: record.student_id,
    studentNumber: record.student_number,
    name: record.name,
    status: record.status ?? 'absent',
    method: record.method,
    checkedInAt: record.checked_in_at,
    flagReason: record.flag_reason,
    riskScore: record.risk_score,
    attempted: record.attempted,
  }));
}

export async function buildRosterEvent(database: Database, sessionId: string): Promise<RosterEvent> {
  const entries = await loadRoster(database, sessionId);
  const counts = countRoster(
    entries.map((entry) => entry.status),
    entries.length,
  );
  return RosterEvent.parse({
    sessionId,
    counts,
    entries: entries.map((entry) => ({
      studentId: entry.studentId,
      studentNumber: entry.studentNumber,
      name: entry.name,
      status: entry.status,
      method: entry.method,
      checkedInAt: entry.checkedInAt,
      flagReason: entry.flagReason,
      riskScore: entry.riskScore,
      attempted: entry.attempted,
    })),
  });
}
