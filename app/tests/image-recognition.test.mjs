import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { recognizeImage } from '../dist/server/image-recognition.js';

test('sends the selected image to the pinned model and rejects incomplete outputs', async () => {
  process.env.BAILIAN_WORKSPACE_ID = 'workspace-test';
  process.env.DASHSCOPE_API_KEY = 'synthetic-test-key';
  const image = await sharp({ create: { width: 100, height: 100, channels: 3, background: 'white' } }).png().toBuffer();
  const output = await recognizeImage(image, 'image/png', async (url, options) => {
    assert.equal(new URL(url).hostname, 'workspace-test.cn-beijing.maas.aliyuncs.com');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'qwen3.5-flash-2026-02-23');
    assert.equal(body.messages[1].content[0].image_url.url, 'data:image/png;base64,' + image.toString('base64'));
    return Response.json({ choices: [{ finish_reason: 'stop', message: {
      content: JSON.stringify({ questions: [{ stem: ' 题干 ', visualContext: ' A → B，权重 3 ' }] })
    } }] });
  });
  assert.deepEqual(output, { model: 'qwen3.5-flash-2026-02-23', promptVersion: 'image-questions-v25', stems: ['题干'], visualContexts: ['A → B，权重 3'], questionBoxes: [null],
    figures: [[{ box: null, initial: null, reread: null, status: 'needs_review', reason: 'location' }]], resolvedContexts: [''] });
  await assert.rejects(recognizeImage(image, 'image/png', async () =>
    Response.json({ choices: [{ finish_reason: 'length' }] })), /OCR_INVALID_OUTPUT/);
  const rotated = await sharp({ create: { width: 100, height: 200, channels: 3, background: 'white' } })
    .jpeg().withMetadata({ orientation: 6 }).toBuffer();
  let requests = 0;
  const crossColumn = await recognizeImage(rotated, 'image/jpeg', async (_url, options) => {
    assert.equal(++requests, 1);
    const url = JSON.parse(options.body).messages[1].content[0].image_url.url;
    const dimensions = await sharp(Buffer.from(url.split(',')[1], 'base64')).metadata();
    assert.equal(dimensions.width, 200);
    assert.equal(dimensions.height, 100);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ questions: [
      { stem: '如下图', questionBox: [10, 20, 450, 900], figures: [{ box: [520, 30, 900, 550] }] }
    ] }) } }] });
  });
  assert.equal(crossColumn.figures[0][0].reason, 'location');
  assert.equal(crossColumn.figures[0][0].status, 'needs_review');
});

test('retries the provider JSON generation failure once within the original timeout', async () => {
  process.env.BAILIAN_WORKSPACE_ID = 'workspace-test';
  process.env.DASHSCOPE_API_KEY = 'synthetic-test-key';
  const image = await sharp({ create: { width: 100, height: 100, channels: 3, background: 'white' } }).jpeg().toBuffer();
  const failure = () => Response.json({ error: { code: 'invalid_parameter_error',
    message: 'Model output became abnormal while generating a JSON response for response_format.' } }, { status: 400 });
  const signals = [];
  const output = await recognizeImage(image, 'image/jpeg', async (_url, options) => {
    signals.push(options.signal);
    if (signals.length === 1) return failure();
    const retry = JSON.parse(options.body);
    assert.equal(retry.response_format, undefined);
    assert.match(retry.messages[1].content[0].image_url.url, /^data:image\/png;base64,/);
    return Response.json({ choices: [{ finish_reason: 'stop', message: {
      content: JSON.stringify({ questions: [{ stem: '题干' }] })
    } }] });
  });
  assert.deepEqual(output.stems, ['题干']);
  assert.equal(signals.length, 2);
  assert.equal(signals[0], signals[1]);
  let attempts = 0;
  await assert.rejects(recognizeImage(image, 'image/jpeg', async () => {
    attempts++;
    return failure();
  }), /OCR_REQUEST_FAILED/);
  assert.equal(attempts, 2);
});

test('the solution adapter requests an answer and explanation and preserves insufficient evidence', async () => {
  process.env.BAILIAN_WORKSPACE_ID = 'workspace-test';
  process.env.DASHSCOPE_API_KEY = 'synthetic-test-key';
  const { solveQuestion } = await import('../dist/server/model-solution.js');
  const solution = await solveQuestion('根据上图求面积', async (_url, options) => {
    const payload = JSON.parse(options.body);
    assert.equal(payload.model, 'qwen-flash-2025-07-28');
    assert.equal(payload.messages[1].content, '根据上图求面积');
    return Response.json({ choices: [{ finish_reason: 'stop', message: {
      content: JSON.stringify({ status: 'insufficient_evidence', answer: '', explanation: '缺少图形。' })
    } }] });
  });
  assert.equal(solution.status, 'insufficient_evidence');
  assert.equal(solution.answer, '');
  assert.equal(solution.explanation, '缺少图形。');
});

test('routes an image-backed question to the visual solver with the original image', async () => {
  process.env.BAILIAN_WORKSPACE_ID = 'workspace-test';
  process.env.DASHSCOPE_API_KEY = 'synthetic-test-key';
  const { solveQuestion } = await import('../dist/server/model-solution.js');
  const bytes = Buffer.from('original image');
  const result = await solveQuestion('根据图求出度', async (_url, options) => {
    const { model, messages } = JSON.parse(options.body);
    assert.equal(model, 'qwen3-vl-plus');
    assert.deepEqual(messages[1].content, [
      { type: 'text', text: '根据图求出度' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,' + bytes.toString('base64') } }
    ]);
    return Response.json({ choices: [{ finish_reason: 'stop', message: {
      content: JSON.stringify({ status: 'solved', answer: '2', explanation: '有两条出边。' })
    } }] });
  }, { bytes, mediaType: 'image/png' });
  assert.equal(result.model, 'qwen3-vl-plus');
  assert.equal(result.answer, '2');
});

test('only publishes a choice answer when its label matches the selected option text', async () => {
  process.env.BAILIAN_WORKSPACE_ID = 'workspace-test';
  process.env.DASHSCOPE_API_KEY = 'synthetic-test-key';
  const { solveQuestion } = await import('../dist/server/model-solution.js');
  const stem = '计算 24 × 36。\nA. 640\nB. 720\nC. 840\nD. 864';
  for (const [answer, expectedStatus] of [['C', 'insufficient_evidence'], ['Ｄ', 'solved']]) {
    const result = await solveQuestion(stem, async (_url, options) => {
      const payload = JSON.parse(options.body);
      assert.equal(payload.model, 'qwen-plus-2025-12-01');
      assert.equal(payload.enable_thinking, true);
      return Response.json({ choices: [{ finish_reason: 'stop', message: {
        content: JSON.stringify({ status: 'solved', answer, selectedOptionText: '864', explanation: '24 × 36 = 864。' })
      } }] });
    });
    assert.equal(result.status, expectedStatus);
    assert.equal(result.answer, expectedStatus === 'solved' ? 'D' : '');
  }
});

test('maps both image solution batches to the exact recognized stems', async () => {
  process.env.BAILIAN_WORKSPACE_ID = 'workspace-test';
  process.env.DASHSCOPE_API_KEY = 'synthetic-test-key';
  const { solvePaper } = await import('../dist/server/paper-model-cache.js');
  const questions = Array.from({ length: 8 }, (_, index) => ({
    stem: `Original ${index}`, visualContext: `Diagram ${index}`
  }));
  const fetch = globalThis.fetch;
  const batches = [];
  globalThis.fetch = async (_url, options) => {
    const { messages } = JSON.parse(options.body);
    const input = JSON.parse(messages[1].content[0].text);
    batches.push(input);
    return Response.json({ choices: [{ finish_reason: 'stop', message: {
      content: JSON.stringify({ solutions: input.map(({ index }) => ({
        index, status: 'solved', answer: '2', explanation: 'Checks the diagram.'
      })) })
    } }] });
  };
  try {
    const solutions = await solvePaper('', { bytes: Buffer.from('whole image'), mediaType: 'image/png' }, questions);
    assert.deepEqual(batches.map(batch => batch.map(item => item.index)), [[0, 1, 2, 3], [0, 1, 2, 3]]);
    assert.deepEqual(solutions.map(item => item.stem), questions.map(item => item.stem));
  } finally {
    globalThis.fetch = fetch;
  }
});

test('checks original-resolution crops, edge directions, and numeric search-tree order', async () => {
  const { figureBox, figureReading, compareFigure, cropOriginal, figureText } =
    await import('../dist/server/paper-figures.js');
  const { default: sharp } = await import('sharp');
  assert.equal(figureBox([80, 500, 20, 900]), null);
  assert.equal(figureBox([-1, 0, 80, 80]), null);
  const box = figureBox([100, 250, 900, 750]);
  const original = await sharp({ create: { width: 1000, height: 2000, channels: 3, background: 'white' } }).png().toBuffer();
  const crop = await sharp(await cropOriginal(original, box)).metadata();
  assert.equal(crop.width, 816);
  assert.equal(crop.height, 1032);

  const graph = (kind, edges) => figureReading({ kind, nodes: ['02', '03', '04'], edges, description: '' });
  const edge = (from, to, label) => ({ from, to, label });
  const initial = graph('directed', [edge('02', '03', '10')]);
  const figure = { box, initial, reread: null, status: 'needs_review' };
  const reversed = graph('directed', [edge('03', '02', '10')]);
  assert.equal(compareFigure(figure, initial).status, 'consistent');
  assert.equal(compareFigure(figure, reversed).reason, 'conflict');
  assert.equal(compareFigure(figure, null).reason, 'unreadable');
  assert.match(figureText(reversed), /03 → 02 \(10\)/);
  assert.equal(graph('tree', [edge('02', '03', 'left'), edge('02', '04', 'left')]), null);
  assert.equal(graph('tree', [edge('02', '03', 'left'), edge('03', '02', 'right')]), null);
  const impossible = graph('tree', [edge('02', '03', 'left'), edge('02', '04', 'right')]);
  assert.equal(compareFigure({ ...figure, initial: impossible }, impossible, 'AVL').reason, 'structure');
  const unspecified = graph('tree', [edge('03', '02', 'child'), edge('03', '04', 'right')]);
  const repaired = compareFigure({ ...figure, initial: null }, unspecified, 'AVL');
  assert.equal(repaired.inferredSides, 1);
  assert.equal(repaired.reread.edges[0].label, 'left');
  assert.equal(repaired.status, 'needs_review');
  const parentPairs = graph('tree', [edge('03', '04', 'child'), edge('03', '02', 'child')]);
  const confirmed = compareFigure({ ...figure, initial: unspecified }, parentPairs, '二元搜尋樹');
  assert.equal(confirmed.status, 'consistent');
  assert.equal(confirmed.inferredSides, 2);
  assert.equal(compareFigure({ ...figure, initial: impossible }, parentPairs, 'AVL').status, 'needs_review');
  const wrongParents = graph('tree', [edge('02', '03', 'child'), edge('03', '04', 'child')]);
  assert.equal(compareFigure({ ...figure, initial: unspecified }, wrongParents, 'AVL').reason, 'conflict');
});

test('recovers a PDF page after provider JSON failure without guessing page numbers', async () => {
  const image = await sharp({ create: { width: 100, height: 100, channels: 3, background: 'white' } }).png().toBuffer();
  let calls = 0;
  const result = await recognizeImage(image, 'image/png', async (_url, options) => {
    const request = JSON.parse(options.body);
    if (++calls === 1) return Response.json({ choices: [{ finish_reason: 'length' }] });
    assert.equal(request.response_format, undefined);
    return Response.json({ choices: [{ finish_reason: 'stop', message: {
      content: '```json\n{"printedPage":null,"questions":[{"stem":"12. 题干"}]}\n```'
    } }] });
  });
  assert.equal(calls, 2);
  assert.equal(result.printedPage, undefined);
  assert.deepEqual(result.stems, ['12. 题干']);
});

test('does not publish a leading continuation as a separate question', async () => {
  const image = await sharp({ create: { width: 100, height: 100, channels: 3, background: 'white' } }).png().toBuffer();
  const result = await recognizeImage(image, 'image/png', async () => Response.json({ choices: [{
    finish_reason: 'stop', message: { content: JSON.stringify({ printedPage: 3, questions: [
      { stem: 'III. 续文\nA. 选项一\nB. 选项二' },
      { stem: '18. 新题\nA. 选项一\nB. 选项二' }
    ] }) }
  }] }));
  assert.equal(result.printedPage, 3);
  assert.deepEqual(result.stems, ['18. 新题\nA. 选项一\nB. 选项二']);
});

test('retries a page timeout with a fresh deadline and keeps all choice text', async () => {
  const image = await sharp({ create: { width: 100, height: 100, channels: 3, background: 'white' } }).png().toBuffer();
  const calls = [];
  const stem = '01. 题干\nA. 选项甲\nB. 选项乙\nC. 选项丙\nD. 选项丁';
  const result = await recognizeImage(image, 'image/png', async (_url, options) => {
    calls.push(options.signal);
    if (calls.length === 1) throw new DOMException('Timed out', 'TimeoutError');
    assert.equal(JSON.parse(options.body).response_format, undefined);
    return Response.json({ choices: [{ finish_reason: 'stop',
      message: { content: JSON.stringify({ printedPage: 2, questions: [{ stem }] }) } }] });
  });
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0], calls[1]);
  assert.equal(result.printedPage, 2);
  assert.deepEqual(result.stems, [stem]);
});

test('recovers complete options from a question crop when the page response omits them', async () => {
  const image = await sharp({ create: { width: 100, height: 100, channels: 3, background: 'white' } }).png().toBuffer();
  let calls = 0;
  const result = await recognizeImage(image, 'image/png', async () => {
    const payload = ++calls === 1 ? { printedPage: 2, questions: [
      { stem: '01. 请选择正确选项（ ）。', questionBox: [30, 20, 950, 310] },
      { stem: '02. 请选择正确选项（ ）。\nA. 甲\nB. 乙\nC. 丙\nD. 丁' }
    ] } : { options: { A: '甲', B: '乙', C: '丙', D: '丁' } };
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(payload) } }] });
  });
  assert.equal(calls, 2);
  assert.match(result.stems[0], /A\. 甲\nB\. 乙\nC\. 丙\nD\. 丁$/);
});

test('retries a transient page failure and parses the original total-first page label', async () => {
  const image = await sharp({ create: { width: 100, height: 100, channels: 3, background: 'white' } }).png().toBuffer();
  const calls = [];
  const result = await recognizeImage(image, 'image/png', async (_url, options) => {
    calls.push(options.signal);
    if (calls.length === 1) return Response.json({}, { status: 503 });
    assert.equal(JSON.parse(options.body).response_format, undefined);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
      printedPageLabel: '頁次：４－１', printedPage: 4, questions: [
        { printedQuestionNumber: '０１', stem: '16個位元的范围？' }, { printedQuestionNumber: 2, stem: '2. 说明过程。' }
      ]
    }) } }] });
  });
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0], calls[1]);
  assert.equal(result.printedPageLabel, '頁次：４－１');
  assert.equal(result.printedPage, 1);
  assert.equal(result.printedTotalPages, 4);
  assert.deepEqual(result.stems, ['01. 16個位元的范围？', '2. 说明过程。']);
});

test('rereads numbered choices in one request and retains an incomplete original for review', async () => {
  const image = await sharp({ create: { width: 100, height: 100, channels: 3, background: 'white' } }).png().toBuffer();
  let calls = 0;
  const result = await recognizeImage(image, 'image/png', async (_url, options) => {
    const prompt = JSON.parse(options.body).messages[0].content;
    const payload = ++calls === 1 ? { printedPageLabel: '3/4', choiceInstructions: '本試卷全為單一選擇題。', questions: [
      { stem: '０１. 第一道题', standalone: true }, { stem: '02. 第二道题\nA. 原文', standalone: true }
    ] } : { choiceOptions: { '01': { A: 'NULL', B: '乙', C: '丙', D: '丁' }, 2: { A: '原文', B: '乙', C: '丙', D: null } } };
    if (calls === 2) assert.match(prompt, /1（4 项）、2（4 项）/u);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(payload) } }] });
  });
  assert.equal(calls, 2);
  assert.equal(result.printedPage, 3);
  assert.deepEqual(result.choiceCounts, [4, 4]);
  assert.deepEqual(result.stems, ['０１. 第一道题\nA. NULL\nB. 乙\nC. 丙\nD. 丁', '02. 第二道题\nA. 原文']);
  assert.deepEqual(result.standaloneStems, [result.stems[0]]);
});

test('rereads a missing printed number without mistaking a quantity in the question for its label', async () => {
  const image = await sharp({ create: { width: 100, height: 100, channels: 3, background: 'white' } }).png().toBuffer();
  const options = '\nA. 甲\nB. 乙\nC. 丙\nD. 丁';
  let calls = 0;
  const result = await recognizeImage(image, 'image/png', async (_url, request) => {
    const payload = ++calls === 1 ? { questions: [
      { stem: '11. 前一题' + options }, { stem: '16個位元的范围？' + options }, { stem: '13. 后一题' + options }
    ] } : { printedQuestionNumbers: { 1: '12' } };
    if (calls === 2) assert.match(JSON.parse(request.body).messages[0].content, /16個位元的范围/u);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(payload) } }] });
  }, true);
  assert.equal(calls, 2);
  assert.equal(result.stems[1], '12. 16個位元的范围？' + options);
});

test('surfaces denied model access without retrying the page', async () => {
  const image = await sharp({ create: { width: 100, height: 100, channels: 3, background: 'white' } }).png().toBuffer();
  let calls = 0;
  await assert.rejects(recognizeImage(image, 'image/png', async () => {
    calls++;
    return Response.json({ error: { code: 'AccessDenied.Unpurchased' } }, { status: 403 });
  }), /MODEL_SERVICE_NOT_ENABLED/);
  assert.equal(calls, 1);
});

test('extracts only validated subject, term and teacher metadata from synthetic output', async () => {
  process.env.BAILIAN_WORKSPACE_ID='workspace-test';process.env.DASHSCOPE_API_KEY='synthetic-test-key';
  const image=await sharp({create:{width:100,height:100,channels:3,background:'white'}}).png().toBuffer();
  const recognize=metadata=>recognizeImage(image,'image/png',async()=>Response.json({choices:[{finish_reason:'stop',message:{
    content:JSON.stringify({questions:[],...metadata})}}]}));
  const known=await recognize({paperSubject:'数学',paperTerm:' ２０２６ 秋 ',paperTeacher:' 张老师 '});
  assert.equal(known.paperTerm,'2026 秋');assert.equal(known.paperTeacher,'张老师');
  const unknown=await recognize({paperTerm:'unknown',paperTeacher:'张\u0000老师'});
  assert.equal(unknown.paperTerm,undefined);assert.equal(unknown.paperTeacher,undefined);
});

