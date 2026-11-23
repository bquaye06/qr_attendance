import { auditLog } from '@attend/db';
import type { Database } from '@attend/db';

/**
 * Append-only audit trail. Every admin action, lecturer override, settings
 * change, biometric action and data export writes one row here; the API's own
 * role has no UPDATE/DELETE grant on the table.
 */
export interface AuditEntryInput {
  actorId?: string | null;
  actorEmail?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  requestId?: string | null;
}

export async function writeAudit(database: Database, entry: AuditEntryInput): Promise<void> {
  await database.insert(auditLog).values({
    actorId: entry.actorId ?? null,
    actorEmail: entry.actorEmail ?? null,
    action: entry.action,
    entity: entry.entity,
    entityId: entry.entityId ?? null,
    before: (entry.before ?? null) as never,
    after: (entry.after ?? null) as never,
    ip: entry.ip ?? null,
    requestId: entry.requestId ?? null,
  });
}
