import { readFile, stat } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

const { BAILIAN_WORKSPACE_ID, DASHSCOPE_API_KEY } = process.env;
if (!/^[a-zA-Z0-9-]+$/.test(BAILIAN_WORKSPACE_ID ?? '') || !DASHSCOPE_API_KEY) {
  throw new Error('Set BAILIAN_WORKSPACE_ID and DASHSCOPE_API_KEY for the Beijing workspace');
}
const imageFile = process.argv[2];
if (!imageFile || !/\.png$/i.test(imageFile) || (await stat(imageFile)).size > 1024 * 1024) {
  throw new Error('Pass a synthetic PNG (up to 1 MB) displaying only the digit 7');
}
const bytes = await readFile(imageFile);
if (!bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
  throw new Error('The smoke fixture must be a PNG');
}
const image = 'data:image/png;base64,' + bytes.toString('base64');

const endpoint = `https://${BAILIAN_WORKSPACE_ID}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions`;
const models = [
  { id: 'qwen-flash-2025-07-28', content: '计算 3 + 4。' },
  { id: 'qwen-plus-2025-12-01', content: '计算 3 + 4。' },
  ...['qwen3.5-flash-2026-02-23', 'qwen3-vl-plus'].map((id) => ({
    id, content: [
      { type: 'text', text: '识别图中唯一的数字。' },
      { type: 'image_url', image_url: { url: image } }
    ]
  }))
];

for (const { id, content } of models) {
  const started = performance.now();
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${DASHSCOPE_API_KEY}`, 'Content-Type': 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        model: id,
        stream: false,
        enable_thinking: false,
        response_format: { type: 'json_object' },
        max_tokens: 128,
        messages: [
          { role: 'system', content: '只返回 JSON 对象，包含整数 answer 字段。' },
          { role: 'user', content }
        ]
      })
    });
    if (!response.ok) {
      console.log(JSON.stringify({ model: id, httpStatus: response.status, passed: false }));
      process.exitCode = 1;
      continue;
    }
    const result = await response.json();
    const choice = result.choices?.[0];
    const answer = JSON.parse(choice?.message?.content ?? 'null')?.answer;
    const usage = result.usage;
    const passed = choice?.finish_reason === 'stop' && answer === 7
      && Number.isInteger(usage?.prompt_tokens) && Number.isInteger(usage?.completion_tokens);
    console.log(JSON.stringify({
      model: id,
      passed,
      latencyMs: Math.round(performance.now() - started),
      inputTokens: usage?.prompt_tokens,
      outputTokens: usage?.completion_tokens
    }));
    if (!passed) process.exitCode = 1;
  } catch (error) {
    console.log(JSON.stringify({ model: id, passed: false, error: error.name }));
    process.exitCode = 1;
  }
}
