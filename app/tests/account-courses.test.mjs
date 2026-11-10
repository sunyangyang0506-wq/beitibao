import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { createApp } from '../dist/server/app.js';
import { processNextPasswordRecovery } from '../dist/server/password-recovery.js';

assert.ok(process.env.DATABASE_URL && process.env.MIGRATION_DATABASE_URL, 'Run scripts/test-local.sh');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const admin = new pg.Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
const origin = 'https://study.example.test';
const password = 'long example password';
const passwordRecovery = randomBytes(32);
let app;

before(async () => {
  const { rows } = await pool.query(
    'SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
  );
  assert.deepEqual(rows[0], { rolname: 'beitibao_test_api', rolsuper: false, rolbypassrls: false });
  app = await createApp({ pool, origin, exposeOpenApi: true, passwordRecovery, accountAdminEmail: 'owner@example.test' });
});

after(async () => {
  await app?.close();
  await Promise.all([pool.end(), admin.end()]);
});

function request(method, path, { session, payload, requestOrigin = origin, csrf = session?.csrf } = {}) {
  return app.inject({
    method, url: '/api/v1' + path, payload,
    headers: {
      origin: requestOrigin,
      ...(session && { cookie: session.cookie }),
      ...(csrf && { 'x-csrf-token': csrf })
    }
  });
}

async function invite(email) {
  const token = randomBytes(32).toString('base64url');
  await admin.query(
    "INSERT INTO invitations (token_hash, email, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
    [createHash('sha256').update(token).digest('hex'), email]
  );
  return token;
}

function sessionOf(response) {
  return { cookie: response.headers['set-cookie'].split(';')[0], csrf: response.json().csrfToken };
}

test('consumes an email-bound invitation once and revokes a logged-out session', async () => {
  const email = 'auth@example.test';
  const token = await invite(email);
  const payload = { email, password, invite: token };
  assert.equal((await request('POST', '/auth/register', {
    payload: { ...payload, email: 'wrong@example.test' }
  })).statusCode, 409);
  const responses = await Promise.all([
    request('POST', '/auth/register', { payload }),
    request('POST', '/auth/register', { payload })
  ]);
  assert.deepEqual(responses.map((item) => item.statusCode).sort(), [201, 409]);
  const registered = responses.find((item) => item.statusCode === 201);
  assert.match(registered.headers['set-cookie'], /HttpOnly/);
  assert.match(registered.headers['set-cookie'], /Secure/);
  assert.match(registered.headers['set-cookie'], /SameSite=Lax/);
  assert.equal((await request('POST', '/auth/login', { payload: { email, password: 'wrong example password' } })).statusCode, 401);
  const login = await request('POST', '/auth/login', { payload: { email: email.toUpperCase(), password } });
  assert.equal(login.statusCode, 200);
  const session = sessionOf(login);
  assert.equal((await request('GET', '/auth/session', { session })).json().email, email);
  assert.equal((await request('POST', '/auth/logout', { session })).statusCode, 204);
  assert.equal((await request('GET', '/auth/session', { session })).statusCode, 401);
});

test('creates one normalized course under concurrency and isolates progress per account', async () => {
  const first = 'first@example.test';
  const second = 'second@example.test';
  async function register(email) {
    const response = await request('POST', '/auth/register', { payload: { email, password, invite: await invite(email) } });
    assert.equal(response.statusCode, 201);
    return sessionOf(response);
  }
  const [owner, other] = await Promise.all([register(first), register(second)]);
  const course = { name: '  ＡＩ  导论  ', teacher: ' 李老师 ', term: '2026 秋' };
  const add = (session, payload = course) => request('POST', '/courses', { session, payload });
  const results = await Promise.all(Array.from({ length: 6 }, () => add(owner)));
  assert.equal(results.filter((item) => item.statusCode === 201).length, 1);
  assert.equal(results.filter((item) => item.statusCode === 200).length, 5);
  const ids = new Set(results.map((item) => item.json().course.id));
  assert.equal(ids.size, 1);
  assert.equal(results[0].json().course.name, 'AI 导论');
  const own = (await request('GET', '/progress', { session: owner })).json();
  assert.equal(own.total, 1);
  assert.equal(own.incomplete, 1);
  assert.equal(own.courses[0].status, 'awaiting_upload');
  assert.equal((await request('GET', '/progress', { session: other })).json().total, 0);
  assert.equal((await add(other)).statusCode, 201);
  assert.equal((await pool.query('SELECT id FROM courses')).rowCount, 0);

  const examPath = '/courses/' + [...ids][0] + '/exam-time';
  const examAt = '2027-01-19T09:30';
  assert.equal((await request('POST', examPath, { session: other, payload: { examAt } })).statusCode, 404);
  assert.equal((await request('POST', examPath, { session: owner, payload: { examAt: '2027-02-30T09:30' } })).statusCode, 400);
  const savedExam = await request('POST', examPath, { session: owner, payload: { examAt } });
  assert.equal(savedExam.statusCode, 200, savedExam.body);
  assert.equal((await request('GET', '/progress', { session: owner })).json().courses[0].examAt, examAt);
  assert.equal((await request('POST', examPath, { session: owner, payload: { examAt: null } })).statusCode, 200);
  assert.equal((await request('GET', '/progress', { session: owner })).json().courses[0].examAt, null);

  const tenant = (await admin.query('SELECT id FROM accounts WHERE email = $1', [first])).rows[0].id;
  await assert.rejects(pool.query(
    "INSERT INTO courses (tenant_id, name, term) VALUES ($1, 'forbidden', '2026')", [tenant]
  ), { code: '42501' });

  assert.equal((await add(owner, { ...course, tenantId: tenant })).statusCode, 400);
  assert.equal((await add(owner, { ...course, name: '  ' })).statusCode, 400);
  assert.equal((await request('POST', '/courses', { session: owner, csrf: 'bad', payload: course })).statusCode, 403);
  assert.equal((await request('POST', '/courses', { session: owner, requestOrigin: 'https://other.test', payload: course })).statusCode, 403);
  assert.equal((await request('GET', '/progress')).statusCode, 401);
});

test('persists authentication limits across application instances', async () => {
  const payload = { email: 'absent@example.test', password };
  for (let attempt = 0; attempt < 10; attempt++) {
    assert.equal((await request('POST', '/auth/login', { payload })).statusCode, 401);
  }
  const secondApp = await createApp({ pool, origin });
  try {
    const response = await secondApp.inject({
      method: 'POST', url: '/api/v1/auth/login', payload, headers: { origin }
    });
    assert.equal(response.statusCode, 429);
    assert.equal(response.headers['retry-after'], '900');
  } finally {
    await secondApp.close();
  }
});

test('delivers a time-limited password reset once and revokes all prior sessions', async () => {
  const email = 'reset@example.test';
  const signup = await request('POST', '/auth/register', { payload: { email, password, invite: await invite(email) } });
  const first = sessionOf(signup);
  const second = sessionOf(await request('POST', '/auth/login', { payload: { email, password } }));
  const requestReset = target => request('POST', '/auth/recovery/request', { payload: { email: target } });
  const real = await requestReset(email);
  const absent = await requestReset('reset-absent@example.test');
  assert.equal(real.statusCode, 202);
  assert.equal(absent.statusCode, 202);
  assert.deepEqual(real.json(), absent.json());
  const worker = new pg.Pool({ connectionString: process.env.RECOVERY_DATABASE_URL });
  const messages = [];
  const sender = async (to, link) => { messages.push({ to, link }); };
  try {
    await assert.rejects(worker.query('SELECT token_hash FROM password_recovery'), { code: '42501' });
    const delivered = await Promise.all(Array.from({ length: 2 }, () =>
      processNextPasswordRecovery(worker, passwordRecovery, origin, sender)));
    assert.deepEqual(delivered.sort(), [false, true]);
    assert.equal(messages[0].to, email);
    const link = new URL(messages[0].link);
    assert.equal(link.origin, origin);
    assert.equal(link.search, '');
    const token = new URLSearchParams(link.hash.slice(1)).get('reset');
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    const newPassword = 'new example recovery password';
    const complete = candidate => request('POST', '/auth/recovery/complete', { payload: { token: candidate, password: newPassword } });
    const attempts = await Promise.all([complete(token), complete(token)]);
    assert.deepEqual(attempts.map(item => item.statusCode).sort(), [204, 409]);
    assert.equal((await request('GET', '/auth/session', { session: first })).statusCode, 401);
    assert.equal((await request('GET', '/auth/session', { session: second })).statusCode, 401);
    assert.equal((await request('POST', '/auth/login', { payload: { email, password } })).statusCode, 401);
    assert.equal((await request('POST', '/auth/login', { payload: { email, password: newPassword } })).statusCode, 200);
    assert.equal((await requestReset(email)).statusCode, 202);
    await processNextPasswordRecovery(worker, passwordRecovery, origin, sender);
    await admin.query("UPDATE password_recovery SET expires_at = now() - interval '1 second' WHERE used_at IS NULL");
    assert.equal((await complete(new URLSearchParams(new URL(messages[1].link).hash.slice(1)).get('reset'))).statusCode, 409);
  } finally { await worker.end(); }
});

test('publishes the OpenAPI contract and exposes a database-independent health check', async () => {
  assert.equal((await app.inject('/healthz')).statusCode, 200);
  const spec = (await app.inject('/openapi.json')).json();
  assert.ok(spec.paths['/api/v1/courses'].post.responses['201']);
  assert.deepEqual(spec.paths['/api/v1/progress'].get.security, [{ session: [] }]);
});

test('only the configured administrator can issue one-time account invitations', async () => {
  async function createAccount(email) {
    const response = await request('POST', '/auth/register', {
      payload: { email, password, invite: await invite(email) }
    });
    assert.equal(response.statusCode, 201);
    return sessionOf(response);
  }

  const owner = await createAccount('owner@example.test');
  const learner = await createAccount('other-learner@example.test');
  const email = 'new-learner@example.test';
  const path = '/admin/invitations';
  assert.equal((await request('POST', path, { payload: { email } })).statusCode, 401);
  assert.equal((await request('POST', path, { session: learner, payload: { email } })).statusCode, 403);
  assert.equal((await request('POST', path, { session: owner, csrf: null, payload: { email } })).statusCode, 403);
  const response = await request('POST', path, { session: owner, payload: { email, subjectLimit: 1 } });
  assert.equal(response.statusCode, 201);
  const { invite: token } = response.json();
  assert.equal((await request('GET', path, { session: learner })).statusCode, 403);
  const list = async () => (await request('GET', path, { session: owner })).json().invitations;
  const pending = (await list()).find(item => item.email === email);
  assert.equal(pending.status, 'pending');
  assert.ok(!('token_hash' in pending) && !('invite' in pending));
  assert.equal((await request('POST', '/auth/register', {
    payload: { email: 'wrong-owner@example.test', password, invite: token }
  })).statusCode, 409);
  const registerLearner = () => request('POST', '/auth/register', { payload: { email, password, invite: token } });
  const signup = await registerLearner();
  assert.equal(signup.statusCode, 201);
  const createdLearner = sessionOf(signup);
  const add = (name, term = '2026 秋') => request('POST', '/courses', { session: createdLearner, payload: { name, term } });
  const simultaneous = await Promise.all([add('数学'), add('物理')]);
  assert.deepEqual(simultaneous.map(result => result.statusCode).sort(), [201, 409]);
  const existing = simultaneous.find(result => result.statusCode === 201).json().course.name;
  assert.equal((await add(existing, '2027 春')).statusCode, 201);
  assert.equal((await request('GET', '/admin/accounts', { session: learner })).statusCode, 403);
  const listed = await request('GET', '/admin/accounts?email=new-learner', { session: owner });
  const [account] = listed.json().accounts;
  assert.equal(account.subjectLimit, 1);
  const quota = '/admin/accounts/' + account.id + '/subject-limit';
  assert.equal((await request('POST', quota, { session: learner, payload: { subjectLimit: 2 } })).statusCode, 403);
  assert.equal((await request('POST', quota, { session: owner, payload: { subjectLimit: 2 } })).json().subjectLimit, 2);
  assert.equal((await add('英语')).statusCode, 201);
  assert.equal((await list()).find(item => item.email === email).status, 'used');
  assert.equal((await registerLearner()).statusCode, 409);
  assert.equal((await request('POST', path, { session: owner, payload: { email } })).statusCode, 409);
  const phone = '13900000000';
  const phoneInvite = await request('POST', path, { session: owner, payload: { phone, subjectLimit: 3 } });
  assert.equal(phoneInvite.statusCode, 201);
  assert.equal(phoneInvite.json().phone, phone);
  const phoneSignup = await request('POST', '/auth/register', { payload: { phone, password, invite: phoneInvite.json().invite } });
  assert.equal(phoneSignup.statusCode, 201);
  assert.equal(phoneSignup.json().phone, phone);
  const phoneLogin = await request('POST', '/auth/login', { payload: { phone, password } });
  assert.equal(phoneLogin.statusCode, 200);
  assert.equal(phoneLogin.json().phone, phone);
  const phoneAccounts = await request('GET', '/admin/accounts?email=' + phone, { session: owner });
  assert.equal(phoneAccounts.json().accounts[0].subjectLimit, 3);
  assert.equal((await request('POST', path, { session: owner, payload: { phone, email } })).statusCode, 400);

});
