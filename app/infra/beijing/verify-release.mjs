import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const { BEITIBAO_ACCEPTANCE_ORIGIN, BEITIBAO_ACCEPTANCE_EMAIL, BEITIBAO_ACCEPTANCE_PASSWORD } = process.env;
const origin = new URL(BEITIBAO_ACCEPTANCE_ORIGIN ?? '');
assert.equal(origin.protocol, 'https:');
assert.equal(origin.origin, BEITIBAO_ACCEPTANCE_ORIGIN);
assert.ok(BEITIBAO_ACCEPTANCE_EMAIL && BEITIBAO_ACCEPTANCE_PASSWORD, 'Configure a designated acceptance account');
const fixture = await readFile(new URL('../../eval/papers/dev-cs.pdf', import.meta.url));
const request = (url, options = {}) => fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(30_000) });
let cookie;
let csrf;
async function api(path, data) {
  const result = await request(origin + 'api/v1' + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { origin: origin.origin, ...(cookie && { cookie }), ...(csrf && { 'x-csrf-token': csrf }),
      ...(data === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) })
  });
  assert.ok(result.ok, `Acceptance API failed at ${path.split('/')[1]} (${result.status})`);
  return result;
}
const health = await request(origin + 'healthz');
assert.equal(health.status, 200);
assert.equal((await request(origin + 'readyz')).status, 200);
const web = await request(origin);
assert.equal(web.status, 200);
assert.match(web.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
assert.doesNotMatch(web.headers.get('content-disposition') ?? '', /attachment/i);
const index = await web.text();
const asset = index.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
assert.ok(asset);
assert.equal((await request(new URL(asset, origin))).status, 200);

const login = await api('/auth/login', { email: BEITIBAO_ACCEPTANCE_EMAIL, password: BEITIBAO_ACCEPTANCE_PASSWORD });
const session = login.headers.get('set-cookie');
assert.match(session, /; Secure/i);
assert.match(session, /; HttpOnly/i);
cookie = session.split(';')[0];
csrf = (await login.json()).csrfToken;
let paperPath;
try {
  const { course } = await (await api('/courses', { name: '生产验收合成样卷', term: '运维验收' })).json();
  const coursePath = '/courses/' + course.id;
  assert.equal((await (await api(coursePath + '/papers')).json()).uploadMode, 'private');
  const upload = await (await api(coursePath + '/paper-uploads', {
    title: '合成试卷上传检查', school: '合成验收材料', mediaType: 'application/pdf',
    bytes: fixture.length, sha256: createHash('sha256').update(fixture).digest('hex'),
    rightsConfirmed: true, allowModels: false
  })).json();
  const endpoint = new URL(upload.url);
  assert.equal(endpoint.protocol, 'https:');
  assert.match(endpoint.hostname, /^beitibao-(staging|production)-[a-z0-9]{6,12}-papers\.oss-cn-beijing\.aliyuncs\.com$/);
  const form = new FormData();
  for (const [name, value] of Object.entries(upload.fields)) form.append(name, value);
  form.append('file', new Blob([fixture], { type: 'application/pdf' }), 'synthetic.pdf');
  const object = await request(endpoint, { method: 'POST', body: form, headers: { origin: origin.origin } });
  assert.equal(object.status, 201, 'OSS form upload failed');
  assert.equal(object.headers.get('access-control-allow-origin'), origin.origin, 'OSS CORS did not allow the product origin');
  const versionId = object.headers.get('x-oss-version-id');
  assert.ok(versionId && versionId !== 'null');
  const complete = '/paper-uploads/' + upload.uploadId + '/complete';
  const started = Date.now();
  const { paper } = await (await api(complete, { versionId })).json();
  paperPath = '/papers/' + paper.id;
  assert.equal((await (await api(complete, { versionId })).json()).paper.id, paper.id);
  let review;
  do {
    review = await (await api(paperPath)).json();
    if (review.paper.status === 'review') break;
    assert.ok(['queued', 'processing'].includes(review.paper.status), 'Paper worker failed');
    await delay(1500);
  } while (Date.now() - started < 120_000);
  assert.equal(review.paper.status, 'review', 'Paper review did not arrive within 120 seconds');
  assert.equal(review.paper.modelAvailable, false);
  assert.match((await api(paperPath + '/pages/1')).headers.get('content-type'), /^image\/png/);
  const { id } = await (await api(paperPath + '/questions', { pageNumber: 1, stem: '2 + 2 等于几？' })).json();
  const { revision } = await (await api(paperPath + '/practice', {})).json();
  const result = await (await api(paperPath + '/practice/save', { revision, changes: { [id]: '4' }, submit: true })).json();
  assert.ok(result.submittedAt);
  await api(paperPath + '/delete', { confirmed: true });
  assert.equal((await request(origin + 'api/v1' + paperPath, { headers: { cookie } })).status, 404);
  paperPath = undefined;
  console.log(JSON.stringify({ status: 'passed', checks: ['https', 'api', 'oss-cors', 'oss-version', 'queue',
    'review', 'practice', 'deletion'], reviewAndPracticeMs: Date.now() - started }));
} finally {
  if (paperPath) await api(paperPath + '/delete', { confirmed: true }).catch(() => {});
  await api('/auth/logout', {}).catch(() => {});
}
