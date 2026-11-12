import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = process.env.PREFLIGHT_SCRIPT ?? fileURLToPath(new URL('../infra/beijing/preflight.sh', import.meta.url));

// The child receives a new environment and a mock-only PATH, never cloud credentials.
function runPreflight({ args = [], missingVariables = [], missingTools = [], release = false,
  account = '100', response = JSON.stringify({ AccountId: account }), cliExit = 0 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'beitibao-preflight-'));
  const callLog = join(directory, 'calls');
  try {
    for (const name of ['terraform', 'aliyun']) {
      if (missingTools.includes(name)) continue;
      const content = name === 'terraform' ? '#!/bin/sh\nexit 0\n' :
        '#!/bin/sh\nprintf "called\\n" >> "$MOCK_CALL_LOG"\nprintf "%s\\n" "$MOCK_IDENTITY"\nexit "$MOCK_EXIT"\n';
      writeFileSync(join(directory, name), content, { mode: 0o755 });
    }
    if (!missingTools.includes('node')) symlinkSync(process.execPath, join(directory, 'node'));
    const env = {
      PATH: directory, MOCK_CALL_LOG: callLog, MOCK_IDENTITY: response, MOCK_EXIT: String(cliExit),
      TF_VAR_account_id: '100', TF_VAR_suffix: 'sample', TF_VAR_vpc_cidr: '10.0.0.0/16',
      TF_VAR_zones: '["cn-beijing-a","cn-beijing-b"]', TF_VAR_web_origin: 'https://example.test',
      TF_VAR_fc_role_arn: 'test-role', TF_VAR_smoke_image: 'test-image'
    };
    // Only tests variable presence. Terraform remains responsible for object validation.
    if (release) env.TF_VAR_release = '{}';
    for (const name of missingVariables) delete env[name];
    const result = spawnSync('/bin/bash', [script, ...args], { env, encoding: 'utf8', timeout: 5000 });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    return { ...result, calledCloud: existsSync(callLog) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const options of [{}, { args: ['--release'], release: true }]) {
  test(`preflight accepts valid mode ${JSON.stringify(options.args ?? [])}`, () => {
    const result = runPreflight(options);
    assert.equal(result.status, 0);
    assert.equal(result.calledCloud, true);
  });
}
for (const [args, release] of [[['--relese'], false], [['--release', 'extra'], false], [['--release', 'extra'], true]]) {
  test(`preflight rejects arguments ${JSON.stringify(args)} (release configured: ${release}) before cloud access`, () => {
    const result = runPreflight({ args, release });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /无效参数/);
    assert.equal(result.calledCloud, false);
  });
}
for (const [name, options] of [
  ['base configuration', { missingVariables: ['TF_VAR_account_id'] }],
  ['release configuration', { args: ['--release'] }]
]) {
  test(`preflight rejects missing ${name} before cloud access`, () => {
    const result = runPreflight(options);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /缺少目标环境配置/);
    assert.equal(result.calledCloud, false);
  });
}
for (const tool of ['node', 'aliyun', 'terraform']) {
  test(`preflight rejects missing ${tool} before cloud access`, () => {
    const result = runPreflight({ missingTools: [tool] });
    assert.equal(result.status, 1);
    assert.match(result.stdout, new RegExp(`缺少部署工具：${tool}`));
    assert.equal(result.calledCloud, false);
  });
}
for (const [name, options, message] of [
  ['account mismatch', { account: '200' }, /不一致/],
  ['invalid identity JSON', { response: 'not-json' }, /无法验证/],
  ['missing account ID', { response: '{}' }, /不一致/],
  ['CLI failure', { cliExit: 1 }, /无法验证/]
]) {
  test(`preflight fails closed for ${name}`, () => {
    const result = runPreflight(options);
    assert.equal(result.status, 1);
    assert.match(result.stdout, message);
    assert.equal(result.calledCloud, true);
  });
}
