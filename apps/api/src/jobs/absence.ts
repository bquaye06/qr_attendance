import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { channels } from '../lib/events.ts';
import { buildRosterEvent } from '../services/roster.ts';
import { writeAudit } from '../lib/audit.ts';

/**
 * Absence sweep.
 *
 * Runs on a timer and also inline when a lecturer closes a session. Any open
 * session whose check-in window has passed is closed and every enrolled student
 * without a record becomes `absent`. Existing records are never touched, so a
 * manual correction survives the job.
 */
export async function closeExpiredSessions(app: FastifyInstance): Promise<{ closed: number; absent: number }> {
  const expired = await app.stores.db.execute(sql`
    select id from class_sessions
    where status = 'open' and checkin_closes_at <= now()
    order by checkin_closes_at
    limit 50
  `);
  const sessionIds = (expired as unknown as { rows: { id: string }[] }).rows ?? [];
  let absent = 0;

  for (const row of sessionIds) {
    const inserted = await app.stores.db.execute(sql`
      insert into attendance_records (session_id, student_id, status, method)
      select s.id, e.student_id, 'absent', 'auto'
      from class_sessions s
      join enrollments e on e.offering_id = s.offering_id and e.status = 'active' and e.deleted_at is null
      where s.id = ${row.id}::uuid
        and not exists (
          select 1 from attendance_records ar where ar.session_id = s.id and ar.student_id = e.student_id
        )
      on conflict do nothing
    `);
    absent += (inserted as unknown as { rowCount: number }).rowCount ?? 0;

    await app.stores.db.execute(sql`
      update class_sessions
         set status = 'closed', closed_at = now(), qr_secret_enc = null, updated_at = now()
       where id = ${row.id}::uuid and status = 'open'
    `);

    await writeAudit(app.stores.db, {
      actorId: null,
      actorEmail: 'system@attend',
      action: 'session.auto_closed',
      entity: 'class_session',
      entityId: row.id,
      after: { reason: 'check-in window ended' },
    });

    await app.hub.publish(channels.sessionRoster(row.id), await buildRosterEvent(app.stores.db, row.id));
  }

  return { closed: sessionIds.length, absent };
}
