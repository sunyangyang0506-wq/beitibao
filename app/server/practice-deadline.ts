import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

type Publish = (event: { version: 1; eventId: string }, delaySeconds: number) => Promise<void>;

export async function dispatchPracticeDeadline(pool: Pool, publish: Publish, eventId?: string) {
  const lease = randomUUID();
  const { rows: [event] } = await pool.query<{ id: string; delay: number; attempts: number }>(`
    WITH exhausted AS (
      UPDATE practice_deadline_outbox SET state = 'dead', lease = NULL, lease_until = NULL
      WHERE state = 'publishing' AND lease_until <= now() AND attempts = 5
        AND ($2::uuid IS NULL OR id = $2)
    ), next AS (
      SELECT id FROM practice_deadline_outbox
      WHERE attempts < 5 AND next_attempt_at <= now() AND ($2::uuid IS NULL OR id = $2) AND
        (state = 'pending' OR (state = 'publishing' AND lease_until <= now()))
      ORDER BY next_attempt_at, id FOR UPDATE SKIP LOCKED LIMIT 1
    )
    UPDATE practice_deadline_outbox o SET state = 'publishing', lease = $1,
      lease_until = now() + interval '1 minute', attempts = o.attempts + 1
    FROM next WHERE o.id = next.id
    RETURNING o.id, o.attempts, greatest(0, ceil(extract(epoch FROM (o.deliver_at - clock_timestamp()))))::int AS delay
  `, [lease, eventId ?? null]);
  if (!event) return false;
  let sent = false;
  try {
    await publish({ version: 1, eventId: event.id }, event.delay);
    sent = true;
  } catch {
    console.warn(JSON.stringify({ code: 'PRACTICE_EVENT_DELIVERY_FAILED', eventId: event.id, attempt: event.attempts }));
  }
  await pool.query(`
    UPDATE practice_deadline_outbox SET state = $3, lease = NULL, lease_until = NULL,
      next_attempt_at = now() + make_interval(secs => $4::int)
    WHERE id = $1 AND lease = $2 AND state = 'publishing'
  `, [event.id, lease, sent ? 'published' : event.attempts === 5 ? 'dead' : 'pending', 15 * 2 ** event.attempts]);
  return true;
}
