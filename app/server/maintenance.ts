import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { paperObjectKey } from './paper-storage.js';

type Purge = (key: string, keptVersion: string | null) => Promise<boolean>;

export async function purgeExpiredPaperUpload(pool: Pool, purge: Purge) {
  const lease = randomUUID();
  const { rows: [job] } = await pool.query<{ tenant_id: string; id: string; kept_version: string | null; erased_at: string | null }>(`
    WITH next AS (
      SELECT tenant_id, id FROM paper_uploads
      WHERE cleaned_at IS NULL AND (cleanup_lease_until IS NULL OR cleanup_lease_until <= now())
        AND expires_at <= now() - CASE WHEN erased_at IS NULL THEN interval '24 hours' ELSE interval '5 minutes' END
      ORDER BY (erased_at IS NULL), expires_at FOR UPDATE SKIP LOCKED LIMIT 1
    )
    UPDATE paper_uploads u SET cleanup_lease = $1, cleanup_lease_until = now() + interval '3 minutes'
    FROM next WHERE (u.tenant_id, u.id) = (next.tenant_id, next.id)
    RETURNING u.tenant_id, u.id, u.kept_version, u.erased_at::text AS erased_at
  `, [lease]);
  if (!job) return false;
  const done = await purge(paperObjectKey(job.tenant_id, job.id), job.kept_version).catch(() => {
    console.warn(JSON.stringify({ code: 'PAPER_OBJECT_PURGE_RETRY' }));
    return false;
  });
  // Compare the full timestamp so a concurrent deletion leaves the row due for the next cleanup.
  await pool.query(`
    UPDATE paper_uploads SET cleanup_lease = NULL,
      cleanup_lease_until = CASE WHEN $4 THEN NULL ELSE now() + interval '5 minutes' END,
      cleaned_at = CASE WHEN $4 AND erased_at IS NOT DISTINCT FROM $5::timestamptz THEN now() ELSE NULL END
    WHERE tenant_id = $1 AND id = $2 AND cleanup_lease = $3
  `, [job.tenant_id, job.id, lease, done, job.erased_at]);
  return true;
}

export async function runMaintenance(pool: Pool, purge: Purge) {
  await pool.query('DELETE FROM sessions WHERE expires_at <= now()');
  await pool.query("DELETE FROM auth_limits WHERE window_started_at <= now() - interval '1 day'");
  await pool.query("DELETE FROM password_recovery WHERE expires_at <= now() - interval '1 day'");
  await pool.query("DELETE FROM paper_uploads WHERE cleaned_at <= now() - interval '30 days' AND kept_version IS NULL");
  await pool.query("DELETE FROM business_job_outbox WHERE created_at <= now() - interval '30 days' AND state IN ('published', 'dead')");
  await pool.query("DELETE FROM model_rate_events WHERE started_at <= now() - interval '1 day'");
  const started = Date.now();
  let processed = 0;
  while (processed < 10 && Date.now() - started < 20_000 && await purgeExpiredPaperUpload(pool, purge)) processed++;
  return { processed };
}
