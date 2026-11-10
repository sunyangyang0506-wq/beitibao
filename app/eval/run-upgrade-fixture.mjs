import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import sharp from 'sharp';

const admin = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
const fixtureToken = 'A'.repeat(43);
const hash = token => createHash('sha256').update(token).digest('hex');
const email = 'legacy-upgrade@example.test';
const stem = '旧版图片题 2 + 2 等于几？';
const reference = { source: 'teacher', kind: 'numeric', answers: ['4'], explanation: '4' };
await admin.connect();
try {
  if (process.argv[2] === 'prepare') {
    const directory = new URL('../migrations/', import.meta.url);
    const files = (await readdir(directory)).filter(file => /^0(?:0[1-9]|1[0-5])_\w+\.sql$/.test(file)).sort();
    assert.equal(files.length, 15);
    await admin.query('BEGIN');
    await admin.query('CREATE TABLE schema_migrations (filename text PRIMARY KEY)');
    for (const filename of files) {
      await admin.query(await readFile(new URL(filename, directory), 'utf8'));
      await admin.query('INSERT INTO schema_migrations VALUES ($1)', [filename]);
    }
    const { rows: [{ id: tenant }] } = await admin.query("INSERT INTO accounts (email,password_hash) VALUES ($1,'fixture') RETURNING id", [email]);
    await admin.query("INSERT INTO sessions VALUES ($1,$2,now()+interval '1 hour')", [hash(fixtureToken), tenant]);
    const { rows: [{ id: course }] } = await admin.query("INSERT INTO courses (tenant_id,name,term) VALUES ($1,'升级样例','2026') RETURNING id", [tenant]);
    const bytes = await sharp({ create: { width: 50, height: 50, channels: 3, background: 'white' } }).png().toBuffer();
    for (const timed of [false, true]) {
      const { rows: [{ id: paper }] } = await admin.query(`
        INSERT INTO papers (tenant_id,course_id,title,fingerprint,pdf,status,pages,media_type,recognition,model_cache_key)
        VALUES ($1,$2,$3,$3,$4,'review','[""]','image/png',$5,'legacy-shared') RETURNING id
      `, [tenant, course, timed ? '旧版定时卷' : '旧版历史卷', bytes,
        JSON.stringify({ model: 'legacy', promptVersion: 'legacy', stems: [stem] })]);
      const { rows: [{ id }] } = await admin.query(`
        INSERT INTO paper_questions (tenant_id,paper_id,page_number,fingerprint,stem,reference)
        VALUES ($1,$2,1,'legacy-question',$3,$4) RETURNING id
      `, [tenant, paper, stem, JSON.stringify(reference)]);
      await admin.query(`
        INSERT INTO practice_attempts (tenant_id,paper_id,title,questions,answers,deadline_at,submitted_at)
        VALUES ($1,$2,'旧版作答',$3,$4,CASE WHEN $5 THEN now()+interval '1 hour' END,CASE WHEN NOT $5 THEN now() END)
      `, [tenant, paper, JSON.stringify([{ id, stem, pageNumber: 1, reference }]), JSON.stringify({ [id]: '4' }), timed]);
    }
    await admin.query("INSERT INTO paper_model_cache VALUES ('legacy-shared','[]',null,'[]')");
    await admin.query('COMMIT');
  } else {
    const { createApp } = await import('../dist/server/app.js');
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const privateMode = process.argv.includes('--private');
    const app = await createApp({ pool, origin: privateMode ? 'https://restore.example.test' : 'http://127.0.0.1:5173',
      localPapers: !privateMode, privatePapers: privateMode ? { modelsEnabled: false, predictionsEnabled: false,
        storage() { return { async read() { throw new Error('Unexpected object read'); } }; } } : undefined });
    try {
      const { rows: [paper] } = await admin.query("SELECT id FROM papers WHERE title='旧版历史卷'");
      const get = path => app.inject({ url: '/api/v1/papers/' + paper.id + path, headers: { cookie: 'beitibao_session=' + fixtureToken } });
      const details = (await get('')).json();
      assert.deepEqual(details.paper.pageOrder, []);
      assert.equal(details.paper.recognition.stems[0], stem);
      assert.equal((await get('/pages/1')).headers['content-type'], 'image/png');
      const attempt = (await get('/practice')).json();
      assert.equal(attempt.questions[0].result, 'correct');
      assert.deepEqual(attempt.draft, { marked: [], position: null });
      assert.equal((await admin.query('SELECT 1 FROM practice_deadline_outbox')).rowCount, 1);
      assert.equal((await pool.query("SELECT cache_key FROM paper_model_cache WHERE cache_key='legacy-shared'")).rowCount, 0);
      const { rows: [{ filename }] } = await admin.query('SELECT filename FROM schema_migrations ORDER BY filename DESC LIMIT 1');
      console.log(`015 → ${filename.slice(0, 3)} verified: image, old submission, scheduled attempt and cache isolation`);
    } finally {
      await app.close();
      await pool.end();
    }
  }
} finally { await admin.end(); }
