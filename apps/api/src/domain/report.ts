import { attendancePercent, isBelowThreshold } from './session.ts';

/**
 * Course report matrix: students × sessions, each student's attendance
 * percentage, and who is below the institution's threshold.
 */

export type MatrixStatus =
  | 'present'
  | 'late'
  | 'present_flagged'
  | 'present_manual'
  | 'absent'
  | 'excused';

export interface MatrixSession {
  sessionId: string;
  startsAt: Date;
  status: 'scheduled' | 'open' | 'closed' | 'cancelled';
}

export interface MatrixStudent {
  studentId: string;
  studentNumber: string;
  name: string;
}

export interface MatrixRecord {
  sessionId: string;
  studentId: string;
  status: MatrixStatus;
}

const PRESENT = new Set<MatrixStatus>(['present', 'late', 'present_flagged', 'present_manual']);

export interface MatrixCell {
  sessionId: string;
  status: MatrixStatus | null;
}

export interface MatrixRow {
  studentId: string;
  studentNumber: string;
  name: string;
  cells: MatrixCell[];
  attended: number;
  held: number;
  percent: number;
  belowThreshold: boolean;
}

export interface MatrixResult {
  sessions: { sessionId: string; startsAt: string; status: string }[];
  students: MatrixRow[];
  held: number;
}

export function buildCourseMatrix(input: {
  sessions: readonly MatrixSession[];
  students: readonly MatrixStudent[];
  records: readonly MatrixRecord[];
  threshold: number;
}): MatrixResult {
  // Cancelled sessions are not held and never count against a student.
  const sessions = [...input.sessions]
    .filter((session) => session.status !== 'cancelled')
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());

  const byStudentSession = new Map<string, Map<string, MatrixStatus>>();
  for (const record of input.records) {
    const inner = byStudentSession.get(record.studentId) ?? new Map<string, MatrixStatus>();
    inner.set(record.sessionId, record.status);
    byStudentSession.set(record.studentId, inner);
  }

  const students: MatrixRow[] = input.students.map((student) => {
    const inner = byStudentSession.get(student.studentId) ?? new Map<string, MatrixStatus>();
    let attended = 0;
    const cells = sessions.map((session) => {
      const status = inner.get(session.sessionId) ?? null;
      if (status && PRESENT.has(status)) attended += 1;
      return { sessionId: session.sessionId, status };
    });
    const held = sessions.length;
    const percent = attendancePercent(attended, held);
    return {
      studentId: student.studentId,
      studentNumber: student.studentNumber,
      name: student.name,
      cells,
      attended,
      held,
      percent,
      belowThreshold: isBelowThreshold(percent, input.threshold),
    };
  });

  students.sort((a, b) => a.studentNumber.localeCompare(b.studentNumber));

  return {
    sessions: sessions.map((session) => ({
      sessionId: session.sessionId,
      startsAt: session.startsAt.toISOString(),
      status: session.status,
    })),
    students,
    held: sessions.length,
  };
}

export interface RosterCounts {
  enrolled: number;
  present: number;
  late: number;
  flagged: number;
  absent: number;
  excused: number;
}

/** Counts for the live roster and the projector counter. Unrecorded = absent. */
export function countRoster(
  statuses: readonly (MatrixStatus | null)[],
  enrolled: number,
): RosterCounts {
  const counts: RosterCounts = { enrolled, present: 0, late: 0, flagged: 0, absent: 0, excused: 0 };
  for (const status of statuses) {
    switch (status) {
      case 'present':
      case 'present_manual':
        counts.present += 1;
        break;
      case 'late':
        counts.late += 1;
        break;
      case 'present_flagged':
        counts.flagged += 1;
        break;
      case 'excused':
        counts.excused += 1;
        break;
      case 'absent':
      default:
        counts.absent += 1;
        break;
    }
  }
  return counts;
}
