/**
 * Data-retention rules. The scheduled purge job uses these to decide what is
 * due; nothing here touches storage.
 */

const DAY_MS = 86_400_000;

export function daysBetween(earlier: Date, later: Date): number {
  return Math.floor((later.getTime() - earlier.getTime()) / DAY_MS);
}

export interface PurgeDecisionInput {
  now: Date;
  /** Set when the student withdrew consent. */
  withdrawnAt: Date | null;
  /** Set when the student left the institution or was deleted. */
  leftAt: Date | null;
  /** Set when the student asked for biometric deletion from their profile. */
  deletionRequestedAt: Date | null;
  /** Institution grace period, in days. */
  graceDays: number;
}

export interface PurgeDecision {
  due: boolean;
  reason: 'withdrawn' | 'left' | 'deletion_requested' | null;
  dueAt: Date | null;
}

/**
 * Templates are purged when any trigger has passed its grace period. The grace
 * window exists so an accidental withdrawal can be reversed before data is
 * destroyed.
 */
export function templatePurgeDecision(input: PurgeDecisionInput): PurgeDecision {
  const triggers: { at: Date; reason: NonNullable<PurgeDecision['reason']> }[] = [];
  if (input.withdrawnAt) triggers.push({ at: input.withdrawnAt, reason: 'withdrawn' });
  if (input.leftAt) triggers.push({ at: input.leftAt, reason: 'left' });
  if (input.deletionRequestedAt) triggers.push({ at: input.deletionRequestedAt, reason: 'deletion_requested' });

  if (triggers.length === 0) return { due: false, reason: null, dueAt: null };

  const earliest = triggers.reduce((best, current) => (current.at < best.at ? current : best), triggers[0]!);
  const dueAt = new Date(earliest.at.getTime() + input.graceDays * DAY_MS);
  return { due: input.now >= dueAt, reason: earliest.reason, dueAt };
}

/** Flagged-attempt evidence older than the retention window must be deleted. */
export function evidencePurgeCutoff(now: Date, retentionDays: number): Date {
  return new Date(now.getTime() - retentionDays * DAY_MS);
}

export function isEvidenceDue(createdAt: Date, now: Date, retentionDays: number): boolean {
  return createdAt <= evidencePurgeCutoff(now, retentionDays);
}
