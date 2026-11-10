import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const forbidden = ['DATABASE_URL', 'MIGRATION_DATABASE_URL', 'PGHOST', 'PGSERVICE',
  'DASHSCOPE_API_KEY', 'BAILIAN_WORKSPACE_ID', 'ALIYUN_ACCESS_KEY_SECRET',
  'RECOVERY_SMTP_URL', 'NPM_TOKEN', 'NODE_OPTIONS', 'VITE_SECRET_TEST'];

async function fixture(t, { pgVersion = '16.6', environmentFile, failNpmCommand } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'beitibao-ci-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ['scripts', 'app/scripts', 'pc-prototype', 'bin']) {
    await mkdir(join(root, directory), { recursive: true });
  }
  await copyFile(new URL('./ci.sh', import.meta.url), join(root, 'scripts/ci.sh'));
  const trace = join(root, 'trace.jsonl');
  for (const command of ['node', 'npm', 'initdb', 'pg_ctl', 'psql', 'pg_dump', 'pg_restore', 'createdb',
    'pdfinfo', 'pdftotext', 'pdftoppm']) {
    // Commands are deliberately replaced. These tests check orchestration and
    // environment isolation only, never pretend to run PostgreSQL or npm.
    await writeFile(join(root, 'bin', command), `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import assert from 'node:assert/strict';
for (const key of ${JSON.stringify(forbidden)}) assert.equal(process.env[key], undefined, key);
assert.match(process.env.HOME, /^\\/tmp\\/beitibao-ci\\.[^/]+\\/home$/);
assert.equal(process.env.npm_config_userconfig, '/dev/null');
assert.equal(process.env.npm_config_globalconfig, '/dev/null');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ command: ${JSON.stringify(command)}, args }) + '\\n');
if (${JSON.stringify(command)} === 'npm' && args.join(' ') === ${JSON.stringify(failNpmCommand ?? null)}) process.exit(23);
if (args[0] === '--version') console.log(${JSON.stringify(command === 'node' ? 'v24.22.1' : `${command} (PostgreSQL) ${pgVersion}`)});
`, { mode: 0o700 });
  }
  // An ESM marker permits imports in the extensionless executable fixtures.
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
  await writeFile(join(root, 'app/scripts/test-local.sh'), '#!/usr/bin/env bash\nset -euo pipefail\nnode fixture-database "$@"\n');
  if (environmentFile) await writeFile(join(root, environmentFile), 'VITE_SECRET_TEST=never-build-this\n');
  return {
    run(args = []) {
      return spawnSync('bash', ['scripts/ci.sh', ...args], {
        cwd: root,
        env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`,
          ...Object.fromEntries(forbidden.map(key => [key, 'must-not-reach-child'])) },
        encoding: 'utf8', timeout: 30_000,
      });
    },
    async commands() {
      return (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    },
  };
}

test('CI drops inherited credentials and only checks prerequisites when requested', async t => {
  const f = await fixture(t);
  const result = f.run(['--check-prerequisites']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /CI prerequisites passed/);
  assert.equal((await f.commands()).some(item => item.command === 'npm'), false);
});

test('CI runs the exact synthetic checks, restores, and both frontend builds', async t => {
  const f = await fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const commands = (await f.commands())
    .filter(item => item.command === 'npm' || (item.command === 'node' && ['--test', 'fixture-database'].includes(item.args[0])))
    .map(item => [item.command, ...item.args].join(' '));
  assert.deepEqual(commands, [
    'npm --prefix app ci --no-audit --no-fund',
    'npm --prefix pc-prototype ci --no-audit --no-fund',
    'node --test scripts/ci.test.mjs',
    'npm --prefix app run lint',
    'npm --prefix app test',
    'node fixture-database --school-reuse',
    'node fixture-database --release-restore',
    'npm --prefix pc-prototype run test:unit',
    'npm --prefix pc-prototype run build',
    'npm --prefix pc-prototype run test:sites',
    'npm --prefix pc-prototype run build:connected',
  ]);
});

test('CI rejects a mismatched PostgreSQL major before installing dependencies', async t => {
  const f = await fixture(t, { pgVersion: '15.10' });
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must be PostgreSQL 16/);
  assert.equal((await f.commands()).some(item => item.command === 'npm'), false);
});

test('CI refuses environment files Vite would load', async t => {
  const f = await fixture(t, { environmentFile: 'pc-prototype/.env.connected.local' });
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Remove pc-prototype\/\.env.connected.local/);
  assert.equal((await f.commands()).some(item => item.command === 'npm'), false);
});

test('CI does not forward arbitrary evaluation or deployment arguments', async t => {
  const f = await fixture(t);
  const result = f.run(['--prediction-live']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage:/);
});

test('CI propagates a failed check and does not continue into later stages', async t => {
  const f = await fixture(t, { failNpmCommand: '--prefix app run lint' });
  const result = f.run();
  assert.equal(result.status, 23);
  const commands = await f.commands();
  assert.deepEqual(commands.at(-1), { command: 'npm', args: ['--prefix', 'app', 'run', 'lint'] });
  assert.equal(commands.some(item => item.args.includes('fixture-database')), false);
});
