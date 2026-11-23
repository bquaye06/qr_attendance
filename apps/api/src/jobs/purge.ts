import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../lib/audit.ts';

/**
 * Retention purges.
 *
 * 1. Face templates for students who withdrew consent, left, or asked for
 *    deletion, once the grace period has passed.
 * 2. Flagged-attempt evidence references, once the retention window has passed.
 *
 * Both are idempotent: running twice deletes nothing the second time.
 */
export async function purgeDueData(app: FastifyInstance): Promise<{
  templates: number;
  evidence: number;
}> {
  const settings = await app.settings();
  const graceDays = settings.templatePurgeGraceDays;

  const purgeable = await app.stores.biometrics.execute(sql`
    select distinct ft.student_id
    from biometrics.face_templates ft
    where exists (
      select 1 from biometric_consents bc
      where bc.student_id = ft.student_id
        and bc.withdrawn_at is not null
        and bc.withdrawn_at <= now() - (${graceDays} || ' days')::interval
        and not exists (
          select 1 from biometric_consents active
          where active.student_id = ft.student_id and active.withdrawn_at is null
        )
    )
    or exists (
      select 1 from students st
      where st.id = ft.student_id and st.left_at is not null
        and st.left_at <= now() - (${graceDays} || ' days')::interval
    )
  `);
  const studentIds = (purgeable as unknown as { rows: { student_id: string }[] }).rows ?? [];

  let templates = 0;
  for (const row of studentIds) {
    const deleted = await app.stores.biometrics.execute(
      sql`delete from biometrics.face_templates where student_id = ${row.student_id}::uuid`,
    );
    templates += (deleted as unknown as { rowCount: number }).rowCount ?? 0;

    await writeAudit(app.stores.db, {
      actorId: null,
      actorEmail: 'system@attend',
      action: 'biometric.purged',
      entity: 'student',
      entityId: row.student_id,
      after: { reason: 'retention policy', graceDays },
    });
  }

  const evidence = await app.stores.db.execute(sql`
    update attendance_attempts
       set evidence_purged_at = now(), evidence_key = null
     where evidence_key is not null
       and created_at <= now() - (${settings.evidenceRetentionDays} || ' days')::interval
  `);

  return {
    templates,
    evidence: (evidence as unknown as { rowCount: number }).rowCount ?? 0,
  };
}
