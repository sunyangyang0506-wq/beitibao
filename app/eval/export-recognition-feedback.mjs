import assert from 'node:assert/strict';
import pg from 'pg';

const tenant = process.argv[2];
assert.match(tenant ?? '', /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i,
  'Provide the account UUID whose feedback you are authorized to export');
assert.ok(process.env.DATABASE_URL, 'DATABASE_URL is required');
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
try {
  await db.query('BEGIN READ ONLY');
  await db.query("SELECT set_config('beitibao.tenant_id', $1, true)", [tenant]);
  const { rows } = await db.query(`
    SELECT f.paper_id AS "sourceGroup", p.fingerprint AS "sourceSha256", p.media_type AS "mediaType",
      f.candidate_index AS "candidateIndex", f.model, f.prompt_version AS "promptVersion",
      f.original_stem AS "originalStem", f.reviewed_stem AS "reviewedStem", f.outcome
    FROM recognition_feedback f
    JOIN papers p ON (p.tenant_id, p.id) = (f.tenant_id, f.paper_id)
    WHERE f.tenant_id = $1
    ORDER BY f.paper_id, f.candidate_index
  `, [tenant]);
  await db.query('COMMIT');
  console.log(JSON.stringify({ datasetVersion: 'recognition-feedback-v1', split: 'review-queue', examples: rows }, null, 2));
} finally {
  await db.end();
}
