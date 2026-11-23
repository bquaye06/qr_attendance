/** Session window maths and the absence sweep. Pure, no clock access. */

export interface CheckinWindow {
  opensAt: Date;
  closesAt: Date;
  lateAfter: Date;
}

export interface WindowOptions {
  startsAt: Date;
  opensOffsetMinutes: number;
  closesOffsetMinutes: number;
  lateAfterMinutes: number;
}

const MINUTE_MS = 60_000;

export function computeCheckinWindow(options: WindowOptions): CheckinWindow {
  return {
    opensAt: new Date(options.startsAt.getTime() + options.opensOffsetMinutes * MINUTE_MS),
    closesAt: new Date(options.startsAt.getTime() + options.closesOffsetMinutes * MINUTE_MS),
    lateAfter: new Date(options.startsAt.getTime() + options.lateAfterMinutes * MINUTE_MS),
  };
}

export type WindowState = 'not_open' | 'open' | 'closed';

export function windowState(window: Pick<CheckinWindow, 'opensAt' | 'closesAt'>, now: Date): WindowState {
  if (now < window.opensAt) return 'not_open';
  if (now > window.closesAt) return 'closed';
  return 'open';
}

export type CheckinPunctuality = 'present' | 'late';

export function punctualityFor(lateAfter: Date, now: Date): CheckinPunctuality {
  return now > lateAfter ? 'late' : 'present';
}

/**
 * At close, every enrolled student without a record is absent.
 * Existing rows are never touched, so a manual correction survives the job.
 */
export function absencesToWrite(
  enrolledStudentIds: readonly string[],
  recordedStudentIds: readonly string[],
): string[] {
  const recorded = new Set(recordedStudentIds);
  const seen = new Set<string>();
  const missing: string[] = [];
  for (const studentId of enrolledStudentIds) {
    if (recorded.has(studentId) || seen.has(studentId)) continue;
    seen.add(studentId);
    missing.push(studentId);
  }
  return missing;
}

export interface SessionLike {
  status: 'scheduled' | 'open' | 'closed' | 'cancelled';
  checkinClosesAt: Date;
}

/** Sessions the absence job must sweep: open sessions whose window has ended. */
export function sessionsDueForClose(sessions: readonly SessionLike[], now: Date): number[] {
  const indexes: number[] = [];
  sessions.forEach((session, index) => {
    if (session.status === 'open' && now > session.checkinClosesAt) indexes.push(index);
  });
  return indexes;
}

export interface ExtendResult {
  closesAt: Date;
  extended: boolean;
  reason?: 'already_extended' | 'session_closed';
}

/** A window can be extended once, and only while the session is open. */
export function extendWindow(
  session: { status: string; checkinClosesAt: Date; windowExtensions: number },
  minutes: number,
): ExtendResult {
  if (session.windowExtensions >= 1) {
    return { closesAt: session.checkinClosesAt, extended: false, reason: 'already_extended' };
  }
  if (session.status === 'closed' || session.status === 'cancelled') {
    return { closesAt: session.checkinClosesAt, extended: false, reason: 'session_closed' };
  }
  return { closesAt: new Date(session.checkinClosesAt.getTime() + minutes * MINUTE_MS), extended: true };
}

/** Percentage of held sessions attended, rounded to one decimal place. */
export function attendancePercent(attended: number, held: number): number {
  if (held <= 0) return 0;
  return Math.round((attended / held) * 1000) / 10;
}

export function isBelowThreshold(percent: number, threshold: number): boolean {
  return percent < threshold;
}
