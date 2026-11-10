import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFile } from 'node:fs/promises';
import { Agent, request } from 'node:http';
import pg from 'pg';
import { createApp } from '../dist/server/app.js';
import { processNextPaper } from '../dist/server/paper-worker.js';
import { samplePaper } from '../tests/fixtures/sample-paper.mjs';

const size = 1000;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4, connectionTimeoutMillis: 5000 });
const admin = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
const worker = new pg.Pool({ connectionString: process.env.LOCAL_PAPER_WORKER_DATABASE_URL, max: 1 });
const privateMode = process.argv.includes('--private');
const origin = privateMode ? 'https://load.example.test' : 'http://127.0.0.1:5173';
const objects = new Map();
const storage = {
  signUpload: key => ({ url: 'https://oss.example.test/', fields: { key } }),
  async read(object) { return objects.get(object.key) ?? null; }
};
const privateWorker = privateMode ? { storage, modelsEnabled: false } : undefined;
const app = await createApp({ pool, origin, localPapers: !privateMode, secureCookies: privateMode,
  privatePapers: privateMode ? { storage: () => storage, modelsEnabled: false, predictionsEnabled: false } : undefined });
const agent = new Agent({ keepAlive: true, maxSockets: size + 10 });
const result = { startedAt: new Date().toISOString(),
  environment: privateMode ? 'production API mode on loopback HTTP, isolated PostgreSQL and object store substitute, API pool 4'
    : 'loopback HTTP and isolated PostgreSQL, API pool 4', users: size };
const digest = token => createHash('sha256').update(token).digest('hex');
const users = Array.from({ length: size }, (_, i) => ({ email: 'load-' + i + '@example.test',
  tenant: randomUUID(), course: randomUUID(), paper: randomUUID(), question: randomUUID(),
  token: randomBytes(32).toString('base64url') }));
const reference = { source: 'teacher', kind: 'numeric', answers: ['4'], explanation: '2 + 2 = 4。' };

async function seed() {
  await admin.connect();
  await admin.query('BEGIN');
  await admin.query('CREATE TEMP TABLE load_seed (email text, tenant uuid, course uuid, paper uuid, question uuid, token_hash text) ON COMMIT DROP');
  await admin.query(`
    INSERT INTO load_seed
    SELECT email, tenant, course, paper, question, token_hash
    FROM jsonb_to_recordset($1::jsonb) s(email text, tenant uuid, course uuid, paper uuid, question uuid, token_hash text)
  `, [JSON.stringify(users.map(({ token, ...user }) => ({ ...user, token_hash: digest(token) })))]);
  await admin.query("INSERT INTO accounts (id,email,password_hash) SELECT tenant,email,'fixture' FROM load_seed");
  await admin.query("INSERT INTO sessions SELECT token_hash,tenant,now()+interval '1 hour' FROM load_seed");
  await admin.query("INSERT INTO courses (tenant_id,id,name,term) SELECT tenant,course,'合成课','负载验证' FROM load_seed");
  await admin.query(`
    INSERT INTO papers (tenant_id,course_id,id,title,fingerprint,pdf,status,pages)
    SELECT tenant,course,paper,'合成卷',paper::text,''::bytea,'review','["2+2"]'::jsonb FROM load_seed
  `);
  await admin.query(`
    INSERT INTO paper_questions (tenant_id,paper_id,id,page_number,fingerprint,stem,reference)
    SELECT tenant,paper,question,1,question::text,'2 + 2 等于几？',$1::jsonb FROM load_seed
  `, [JSON.stringify(reference)]);
  await admin.query(`
    INSERT INTO practice_attempts (tenant_id,paper_id,title,questions)
    SELECT tenant,paper,'合成卷',jsonb_build_array(
      jsonb_build_object('id',question,'stem','2 + 2 等于几？','pageNumber',1,'reference',$1::jsonb)
    ) FROM load_seed
  `, [JSON.stringify(reference)]);
  await admin.query('COMMIT');
}

let base;
function post(user, path, value, contentType = 'application/json', capture = false) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  const started = performance.now();
  return new Promise(resolve => {
    const outgoing = request(base + '/api/v1' + path, { agent, method: 'POST', headers: {
      origin, 'content-type': contentType, 'content-length': bytes.length,
      cookie: 'beitibao_session=' + user.token, 'x-csrf-token': digest('csrf:' + user.token)
    } }, response => {
      const chunks = [];
      if (capture) response.on('data', chunk => chunks.push(chunk));
      else response.resume();
      response.on('end', () => resolve({ status: response.statusCode, ms: performance.now() - started,
        ...(capture && { body: JSON.parse(Buffer.concat(chunks).toString()) }) }));
    });
    outgoing.setTimeout(10_000, () => outgoing.destroy(new Error('TIMEOUT')));
    outgoing.on('error', () => resolve({ status: 0, ms: performance.now() - started }));
    outgoing.end(bytes);
  });
}
const save = (user, submit) => post(user, '/papers/' + user.paper + '/practice/save', {
  revision: submit ? 1 : 0, changes: { [user.question]: '4' }, submit
});
function summarize(requests, elapsed) {
  const times = requests.map(item => item.ms).sort((a, b) => a - b);
  return { requests: times.length, successful: requests.filter(item => item.status === 200).length,
    statusCounts: Object.fromEntries([...new Set(requests.map(item => item.status))].map(status =>
      [status, requests.filter(item => item.status === status).length])),
    elapsedMs: Math.round(elapsed), p95Ms: Math.round(times[Math.ceil(times.length * 0.95) - 1]), maxMs: Math.round(times.at(-1)) };
}

try {
  await seed();
  base = await app.listen({ host: '127.0.0.1', port: 0 });
  let started = performance.now();
  const drafts = await Promise.all(users.map(user => save(user, false)));
  result.saves = summarize(drafts, performance.now() - started);
  assert.equal(result.saves.successful, size);
  started = performance.now();
  const concurrentUploads = (async () => {
    await delay(1400);
    const sample = samplePaper();
    const uploadUsers = users.slice(0, 12);
    if (privateMode) {
      const receipts = await Promise.all(uploadUsers.map(user => post(user, '/courses/' + user.course + '/paper-uploads', {
        title: 'Load fixture', school: 'Synthetic fixtures', mediaType: 'application/pdf', bytes: sample.length,
        sha256: digest(sample), rightsConfirmed: true, allowModels: false
      }, 'application/json', true)));
      assert.ok(receipts.every(item => item.status === 201));
      for (const receipt of receipts) objects.set(receipt.body.fields.key, sample);
      for (let offset = 0; offset < receipts.length; offset += 2) {
        const completed = await Promise.all(receipts.slice(offset, offset + 2).map(({ body }, index) =>
          post(uploadUsers[offset + index], '/paper-uploads/' + body.uploadId + '/complete', { versionId: 'fixture' })));
        assert.ok(completed.every(item => item.status === 202));
      }
    } else {
      const received = await Promise.all(uploadUsers.map(user =>
        post(user, '/courses/' + user.course + '/papers?title=Load%20fixture', sample, 'application/pdf')));
      assert.ok(received.every(item => item.status === 202));
    }
    let processed = 0;
    while (await processNextPaper(worker, undefined, undefined, privateWorker)) processed++;
    return processed;
  })();
  const batches = Array.from({ length: 10 }, (_, index) => (async () => {
    await delay(index * 1000);
    return Promise.all(users.slice(index * 100, index * 100 + 100).map(user => save(user, true)));
  })());
  const submitted = (await Promise.all(batches)).flat();
  result.submits = summarize(submitted, performance.now() - started);
  result.backgroundUploads = await concurrentUploads;
  assert.equal(result.submits.successful, size);
  assert.equal(result.backgroundUploads, 12);
  const repeated = await Promise.all(users.slice(0, 50).map(user => save(user, true)));
  result.successfulDuplicateSubmits = repeated.filter(item => item.status === 200).length;
  assert.equal(result.successfulDuplicateSubmits, 50);
  const { rows: [count] } = await admin.query(`
    SELECT count(*)::int AS results, count(*) FILTER (WHERE cardinality(covered)=1)::int AS covered
    FROM practice_results
  `);
  assert.deepEqual(count, { results: size, covered: size });
  Object.assign(result, count);
} finally {
  result.finishedAt = new Date().toISOString();
  await writeFile(new URL(privateMode ? './practice-load-release-results.json' : './practice-load-local-results.json', import.meta.url),
    JSON.stringify(result, null, 2) + '\n');
  agent.destroy();
  await app.close();
  await Promise.all([pool.end(), admin.end(), worker.end()]);
}
console.log(JSON.stringify(result, null, 2));
