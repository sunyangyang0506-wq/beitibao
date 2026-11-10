import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Compile the real JSX and render it with React, without requiring a browser or backend.
test('retry feedback renders absent historical references safely and preserves available evidence', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'beitibao-mistake-ui-'));
  try {
    const output = join(temporary, 'feedback.cjs');
    await build({
      stdin: {
        contents: `import React from 'react';
          import { renderToStaticMarkup } from 'react-dom/server';
          import { MistakeRetryFeedback } from './src/Mistakes.jsx';
          export const render = result => renderToStaticMarkup(React.createElement(MistakeRetryFeedback, { result }));`,
        resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'jsx'
      },
      outfile: output, bundle: true, platform: 'node', format: 'cjs', loader: { '.css': 'empty' }, logLevel: 'silent'
    });
    const { render } = createRequire(import.meta.url)(output);
    for (const reference of [null, undefined]) {
      const html = render({ result: 'needs_review', reference, knowledgePoints: [] });
      assert.match(html, /模型暂时无法判定这次作答/);
      assert.match(html, /历史参考答案不可用，无法自动判定/);
    }
    const html = render({ result: 'correct', reference: { answers: ['A'], explanation: 'Original explanation' }, knowledgePoints: ['Original concept'] });
    assert.match(html, /答对了，已更新重练状态/);
    assert.match(html, /参考答案　A/);
    assert.match(html, /Original explanation/);
    assert.match(html, /Original concept/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
