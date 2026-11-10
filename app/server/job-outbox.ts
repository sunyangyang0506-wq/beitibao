import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

const tables = {
  paper: { table: 'papers', key: 'id', status: 'status' },
  page: { table: 'paper_page_recognition', key: 'paper_id', status: 'status' },
  solution: { table: 'paper_questions', key: 'id', status: 'solution_status' },
  prediction: { table: 'predictions', key: 'id', status: 'status' }
} as const;
export type BusinessLane = keyof typeof tables;
export const businessLanes = Object.keys(tables) as BusinessLane[];
export type JobTarget = { tenant: string; id: string; page: number | null };
export type QueueEvent = { version: 1; eventId: string };

export async function dispatchBusinessJob(pool: Pool, lane: BusinessLane, publish: (event: QueueEvent) => Promise<void>) {
  const lease = randomUUID();
  const { rows: [event] } = await pool.query<{ id: string; attempts: number }>(`
    WITH exhausted AS (
      UPDATE business_job_outbox SET state = 'dead', lease = NULL, lease_until = NULL
      WHERE lane = $1 AND state = 'publishing' AND lease_until <= now() AND attempts = 5
    ), next AS (
      SELECT id FROM business_job_outbox
      WHERE lane = $1 AND attempts < 5 AND next_attempt_at <= now()
        AND (state = 'pending' OR (state = 'publishing' AND lease_until <= now()))
      ORDER BY next_attempt_at, id FOR UPDATE SKIP LOCKED LIMIT 1
    )
    UPDATE business_job_outbox o SET state = 'publishing', lease = $2,
      lease_until = now() + interval '1 minute', attempts = o.attempts + 1
    FROM next WHERE o.id = next.id RETURNING o.id, o.attempts
  `, [lane, lease]);
  if (!event) return false;
  let sent = false;
  try {
    await publish({ version: 1, eventId: event.id });
    sent = true;
  } catch {
    console.warn(JSON.stringify({ code: 'BUSINESS_QUEUE_DELIVERY_FAILED', lane, eventId: event.id, attempt: event.attempts }));
  }
  await pool.query(`
    UPDATE business_job_outbox SET state = $3, lease = NULL, lease_until = NULL,
      next_attempt_at = now() + make_interval(secs => $4::int)
    WHERE id = $1 AND lease = $2 AND state = 'publishing'
  `, [event.id, lease, sent ? 'published' : event.attempts === 5 ? 'dead' : 'pending', 15 * 2 ** event.attempts]);
  return true;
}

export async function consumeBusinessJob(pool: Pool, lane: BusinessLane, eventId: string,
  process: (target: JobTarget) => Promise<boolean>) {
  const { rows: [target] } = await pool.query<JobTarget>(`
    SELECT tenant_id AS tenant, job_key AS id, page_number AS page FROM business_job_outbox WHERE id = $1 AND lane = $2
  `, [eventId, lane]);
  if (!target) return true;
  await process(target);
  const { table, key, status } = tables[lane];
  const pending = await pool.query(`
    SELECT 1 FROM ${table} WHERE tenant_id = $1 AND ${key} = $2 AND ${status} IN ('queued', 'processing')
      ${lane === 'page' ? 'AND page_number = $3' : ''}
  `, lane === 'page' ? [target.tenant, target.id, target.page] : [target.tenant, target.id]);
  return !pending.rowCount;
}
