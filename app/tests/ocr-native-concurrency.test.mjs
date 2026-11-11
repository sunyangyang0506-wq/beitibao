// Native PostgreSQL tests: no SQL mocks, real transactions and restricted runtime roles.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { asTenant } from '../dist/server/db.js';
import { publishCompletedPages } from '../dist/server/pdf-page-recognition.js';
import { registerRecognitionReview } from '../dist/server/recognition-review.js';

const terminal = ['MODEL_PAYMENT_REQUIRED', 'MODEL_SERVICE_NOT_ENABLED', 'MODEL_AUTHENTICATION_FAILED',
  'MODEL_ACCESS_DENIED', 'MODEL_BUDGET_LIMIT', 'MODEL_NOT_CONFIGURED'];

function retryRoute(pool) {
  let handler;
  const app = { get() {}, post(path, _options, callback) {
    if (path.endsWith('/retry-recognition')) handler = callback;
  } };
  registerRecognitionReview(app, pool, '/test', { modelsEnabled: true });
  return async (tenant, paper) => {
    const reply = { status: null, code(status) { this.status = status; return this; },
      send(body) { return { status: this.status, body }; } };
    return handler({ studySession: { id: tenant }, params: { paperId: paper } }, reply);
  };
}

async function waitForBlocked(admin, application, count) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const { rows: [row] } = await admin.query(`SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE application_name = $1 AND cardinality(pg_blocking_pids(pid)) > 0`, [application]);
    if (row.count >= count) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`Expected ${count} real PostgreSQL lock waiters for ${application}`);
}

test('native OCR retry/publication concurrency and tenant isolation', { timeout: 45000 }, async t => {
  for (const name of ['DATABASE_URL', 'MIGRATION_DATABASE_URL', 'RELEASE_PAGE_DATABASE_URL']) {
    assert.ok(process.env[name], `${name} is required; run with scripts/test-local.sh`);
  }
  const name = 'ocr-native-' + randomUUID();
  const admin = new pg.Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
  const api = new pg.Pool({ connectionString: process.env.DATABASE_URL, application_name: name + '-api', max: 4,
    statement_timeout: 12000 });
  const page = new pg.Pool({ connectionString: process.env.RELEASE_PAGE_DATABASE_URL, application_name: name + '-page',
    statement_timeout: 12000 });
  const owner = randomUUID(), other = randomUUID(), course = randomUUID(), image = randomUUID(), pdf = randomUUID();
  const retry = retryRoute(api);
  try {
    for (const pool of [api, page]) {
      const { rows: [role] } = await pool.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
      assert.deepEqual(role, { rolsuper: false, rolbypassrls: false });
    }
    await admin.query('INSERT INTO accounts(id,email,password_hash) VALUES ($1,$2,$3),($4,$5,$3)',
      [owner, owner + '@example.test', 'synthetic-unusable-hash', other, other + '@example.test']);
    await admin.query("INSERT INTO courses(tenant_id,id,name,term) VALUES ($1,$2,'Synthetic OCR isolation','test')", [owner, course]);
    for (const [id, media] of [[image, 'image/png'], [pdf, 'application/pdf']]) {
      await admin.query(`INSERT INTO papers(tenant_id,id,course_id,title,fingerprint,pdf,status,media_type,
        object_key,object_version,object_bytes,model_allowed,failure,created_at)
        VALUES ($1,$2,$3,'Synthetic OCR concurrency',$2::text,'','review',$4,$5,'synthetic-version',1,true,
          'MODEL_PAYMENT_REQUIRED','2099-01-01')`, [owner, id, course, media, 'synthetic/' + id]);
    }
    await admin.query(`INSERT INTO paper_page_recognition(tenant_id,paper_id,page_number,status,recognition)
      VALUES ($1,$2,1,'review','{"stems":["1. Explain a synthetic stack."]}'),($1,$2,2,'review','{"stems":["2. Explain a synthetic queue."]}')`, [owner, pdf]);

    await t.test('two simultaneous explicit retries serialize; only one queues', async () => {
      const blocker = await api.connect();
      let attempts = [];
      try {
        await blocker.query('BEGIN');
        await blocker.query("SELECT set_config('beitibao.tenant_id',$1,true)", [owner]);
        await blocker.query('SELECT 1 FROM papers WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [owner, image]);
        attempts = [retry(owner, image), retry(owner, image)];
        // Observe actual database lock waits, rather than inferring overlap from a timer.
        await waitForBlocked(admin, name + '-api', 2);
        await blocker.query('COMMIT');
        const results = await Promise.all(attempts);
        assert.deepEqual(results.map(r => r.status).sort(), [202, 409]);
        assert.deepEqual(results.find(r => r.status === 409).body, { code: 'RECOGNITION_UNAVAILABLE' });
        const { rows: [saved] } = await admin.query('SELECT status,failure FROM papers WHERE tenant_id=$1 AND id=$2', [owner, image]);
        assert.deepEqual(saved, { status: 'queued', failure: null });
      } finally {
        await blocker.query('ROLLBACK'); blocker.release();
        await Promise.allSettled(attempts);
        await admin.query("UPDATE papers SET status='review',failure='MODEL_PAYMENT_REQUIRED' WHERE tenant_id=$1 AND id=$2", [owner, image]);
      }
    });

    await t.test('publication waits for terminal sibling commit and cannot publish stale success', async () => {
      const writer = await api.connect();
      let publishing;
      try {
        await writer.query('BEGIN');
        await writer.query("SELECT set_config('beitibao.tenant_id',$1,true)", [owner]);
        await writer.query('SELECT 1 FROM papers WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [owner, pdf]);
        await writer.query(`UPDATE paper_page_recognition SET status='failed',failure='MODEL_PAYMENT_REQUIRED',
          recognition=NULL,reviewed_at=now() WHERE tenant_id=$1 AND paper_id=$2 AND page_number=2`, [owner, pdf]);
        publishing = asTenant(page, owner, db => publishCompletedPages(db, owner, pdf, true, true));
        await waitForBlocked(admin, name + '-page', 1);
        await writer.query('COMMIT');
        assert.equal(await publishing, false);
        const { rows: [saved] } = await admin.query(`SELECT
          (SELECT count(*)::int FROM paper_questions WHERE tenant_id=$1 AND paper_id=$2) AS questions,
          (SELECT reviewed_at IS NULL FROM paper_page_recognition WHERE tenant_id=$1 AND paper_id=$2 AND page_number=1) AS untouched`, [owner, pdf]);
        assert.deepEqual(saved, { questions: 0, untouched: true });
      } finally {
        await writer.query('ROLLBACK'); writer.release();
        if (publishing) await Promise.allSettled([publishing]);
      }
    });

    await t.test('all terminal codes block native worker and recovery publication, reviewed or not', async () => {
      for (const code of terminal) for (const reviewed of [false, true]) {
        await admin.query(`UPDATE paper_page_recognition SET failure=$3,reviewed_at=CASE WHEN $4 THEN now() ELSE NULL END
          WHERE tenant_id=$1 AND paper_id=$2 AND page_number=2`, [owner, pdf, code, reviewed]);
        for (const [pool, reuse] of [[page, true], [api, false]]) {
          assert.equal(await asTenant(pool, owner, db => publishCompletedPages(db, owner, pdf, reuse, true)), false);
        }
      }
      assert.equal((await admin.query('SELECT 1 FROM paper_questions WHERE tenant_id=$1 AND paper_id=$2', [owner, pdf])).rowCount, 0);
    });

    await t.test('runtime RLS rejects forged victim IDs, writes and publication; route hides victim', async () => {
      assert.deepEqual(await retry(other, image), { status: 409, body: { code: 'RECOGNITION_UNAVAILABLE' } });
      await asTenant(api, other, async db => {
        // Pass victim identifiers even though the database session belongs to the attacker.
        assert.equal(await publishCompletedPages(db, owner, pdf, false, true), false);
        assert.equal((await db.query('SELECT * FROM papers WHERE tenant_id=$1 AND id=$2', [owner, image])).rowCount, 0);
        assert.equal((await db.query('SELECT * FROM paper_page_recognition WHERE tenant_id=$1 AND paper_id=$2', [owner, pdf])).rowCount, 0);
        assert.equal((await db.query("UPDATE papers SET status='queued',failure=NULL WHERE tenant_id=$1 AND id=$2", [owner, image])).rowCount, 0);
        assert.equal((await db.query("UPDATE paper_page_recognition SET failure=NULL WHERE tenant_id=$1 AND paper_id=$2", [owner, pdf])).rowCount, 0);
      });
      await assert.rejects(asTenant(api, other, db => db.query(`INSERT INTO paper_page_recognition
        (tenant_id,paper_id,page_number) VALUES ($1,$2,3)`, [owner, pdf])), error => error.code === '42501' && /row-level security/i.test(error.message));
      const { rows: [saved] } = await admin.query('SELECT status,failure FROM papers WHERE tenant_id=$1 AND id=$2', [owner, image]);
      assert.deepEqual(saved, { status: 'review', failure: 'MODEL_PAYMENT_REQUIRED' });
    });
  } finally {
    // These fixtures exist only in the disposable synthetic CI database.
    await admin.query('DELETE FROM paper_page_recognition WHERE tenant_id=$1', [owner]);
    await admin.query('DELETE FROM paper_questions WHERE tenant_id=$1', [owner]);
    await admin.query('DELETE FROM papers WHERE tenant_id=$1', [owner]);
    await admin.query('DELETE FROM courses WHERE tenant_id=$1', [owner]);
    await admin.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[owner, other]]);
    await Promise.all([api.end(), page.end(), admin.end()]);
  }
});
