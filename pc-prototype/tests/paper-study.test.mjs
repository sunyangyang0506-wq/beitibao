import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { assignDemoSubject, showPersonalNotes } from '../src/demo-paper-assignment.js';
import { assignmentMessage } from '../src/paper-assignment.js';

async function renderers(t) {
  const temporary = await mkdtemp(join(tmpdir(), 'beitibao-study-ui-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const output = join(temporary, 'ui.cjs');
  await build({ stdin: { contents: `import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { AnswerCorrection, isChoiceQuestion } from './src/QuestionRecall.jsx';
    import { DemoPersonalNotes } from './src/DemoPersonalNotes.jsx';
    import { StudyQuestions, PendingPageRecovery, PaperProcessingRecovery, SavedImageRecovery, orderedStudyQuestions } from './src/PaperStudy.jsx';
    export const correction = question => renderToStaticMarkup(React.createElement(AnswerCorrection, { question }));
    export const notes = question => renderToStaticMarkup(React.createElement(DemoPersonalNotes, { question, notes: { answer: '已有个人答案', explanation: '已有个人解析' } }));
    export const study = result => renderToStaticMarkup(React.createElement(StudyQuestions, { result, paperId: 'paper' }));
    export const recovery = pages => renderToStaticMarkup(React.createElement(PendingPageRecovery, { pages }));
    export const processingRecovery = (result, busy = false) => renderToStaticMarkup(React.createElement(PaperProcessingRecovery, { result, busy }));
    export const savedImageRecovery = (result, busy = false) => renderToStaticMarkup(React.createElement(SavedImageRecovery, { result, busy }));
    export { isChoiceQuestion, PaperProcessingRecovery, SavedImageRecovery, orderedStudyQuestions };`, resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'jsx' },
    outfile: output, bundle: true, platform: 'node', format: 'cjs', loader: { '.css': 'empty' }, logLevel: 'silent' });
  return createRequire(import.meta.url)(output);
}

test('single and multiple choice hide personal notes without touching input or saved data', async t => {
  const render = await renderers(t);
  for (const type of ['单选题', '多选题', '选择题']) {
    const q = { type, options: ['选项一', '选项二'], answer: 'A', correction: { answer: '历史个人答案' } };
    const original = JSON.stringify(q);
    assert.equal(render.notes(q), '');
    assert.equal(showPersonalNotes(q), false);
    assert.equal(JSON.stringify(q), original);
  }
  for (const q of [{ kind: 'choice' }, { reference: { kind: 'choice' } }, { stem: '选择正确项。\nA. 一\nB. 二' }]) {
    assert.equal(render.correction({ ...q, correction: { answer: '保留的历史记录' } }), '');
  }
  for (const kind of ['fill', 'calculation', 'short_answer', 'other']) {
    assert.match(render.correction({ kind, correction: { answer: '保留的历史记录' } }), /保留的历史记录/);
  }
  assert.match(render.notes({ type: '计算题', options: [] }), /个人答案与解析/);
  assert.match(render.notes({ type: '填空题', options: ['题目材料'] }), /个人答案与解析/);
  assert.match(render.notes({ type: '简答题', options: [] }), /已有个人解析/);
});

test('recognized questions display directly in study, guarded during closed-book sessions', async t => {
  const render = await renderers(t);
  const result = { paper: { title: '数学原卷' }, questions: [{ id: 'q1', stem: '计算一加一', pageNumber: 1, kind: 'calculation' }] };
  const html = render.study(result);
  assert.match(html, /本卷题目/);
  assert.match(html, /计算一加一/);
  assert.match(html, /查看本题答案/);
  assert.match(html, /原文件第/);
  assert.doesNotMatch(html, /确认归档|归档课程|试卷识别/);
  const locked = render.study({ ...result, closedBook: true });
  assert.match(locked, /闭卷练习中/);
  assert.doesNotMatch(locked, /计算一加一|查看本题答案/);
  assert.match(render.study({ ...result, questions: [] }), /暂无可背诵题目/);
});

test('demo subject assignment only uses known sample evidence and respects limits/ambiguity', () => {
  const created = assignDemoSubject([], '高等数学', 1, () => 'new');
  assert.equal(created.created, true);
  assert.equal(created.course.term, '学期待确认');
  assert.equal(created.course.teacher, '');
  assert.equal(assignDemoSubject([created.course], '高等数学', 1, () => 'bad').course.id, 'new');
  assert.equal(assignDemoSubject([], '', 1, () => 'bad').reason, 'unknown');
  assert.equal(assignDemoSubject([created.course], '大学物理', 1, () => 'bad').reason, 'subject_limit');
  assert.equal(assignDemoSubject([created.course, { ...created.course, id: 'other', term: '2025 秋' }], '高等数学', 2, () => 'bad').reason, 'ambiguous');
  for (const reason of ['unknown', 'ambiguous', 'subject_limit', 'duplicate']) assert.ok(assignmentMessage({ assignmentReason: reason }).length);
});

test('both entry points remove standalone recognition and required manual assignment UI', async () => {
  for (const file of ['App.jsx', 'PaperLibrary.jsx', 'PaperStudy.jsx']) {
    const source = await readFile(new URL('../src/' + file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /<h2>试卷识别|<h2>试题识别预览|确认归档|<label>归档课程/);
  }
});

// Source links must reset an earlier cross-paper mode before mounting the target question.
test('prediction evidence navigation targets the whole-paper question display', async () => {
  const source = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(source, /const openPaper = \(c,p,q\) => \{ if \(q\) setMode\('whole'\)/);
});

test('legacy settled pending pages retain a recovery control without manual archive UI', async t => {
  const render = await renderers(t);
  const html = render.recovery([{ page: 2, status: 'review' }, { page: 3, status: 'failed' }, { page: 4, status: 'processing' }]);
  assert.match(html, /重新整理本页/);
  assert.match(html, /重试本页/);
  assert.doesNotMatch(html, /确认归档|归档课程/);
  assert.equal((html.match(/<button/g) ?? []).length, 2);
});

test('legacy private image OCR failures keep whole-paper retry without leaking into ready or closed-book states', async t => {
  const render = await renderers(t);
  for (const mediaType of ['image/png', 'image/jpeg']) {
    for (const failure of ['OCR_FAILED', 'OCR_NOT_CONFIGURED']) {
      const result = { paper: { status: 'review', mediaType, failure, modelAvailable: true }, questions: [], canDelete: true };
      assert.match(render.processingRecovery(result), /重试处理原卷/);
      assert.match(render.processingRecovery(result), /原卷图片尚未生成可背诵题目/);
      assert.doesNotMatch(render.processingRecovery(result), /检查 PDF/);
      assert.match(render.processingRecovery(result, true), /<button disabled/);
      assert.equal(render.processingRecovery({ ...result, closedBook: true }), '');
      assert.equal(render.processingRecovery({ ...result, questions: [{ id: 'existing' }] }), '');
      assert.equal(render.processingRecovery({ ...result, paper: { ...result.paper, status: 'processing' } }), '');
      assert.equal(render.processingRecovery({ ...result, paper: { ...result.paper, failure: null } }), '');
      assert.doesNotMatch(render.processingRecovery({ ...result, paper: { ...result.paper, modelAvailable: false } }), /<button/);
      let calls = 0;
      const control = render.PaperProcessingRecovery({ result, onRetry: () => { calls++; } });
      control.props.children.find(child => child?.type === 'button').props.onClick();
      assert.equal(calls, 1); // Local callback only. No network or model invocation.
    }
  }
  const invalidPdf = { paper: { status: 'failed', mediaType: 'application/pdf', failure: 'PDF_PARSE_FAILED' }, questions: [] };
  assert.match(render.processingRecovery(invalidPdf), /检查 PDF/);
  assert.doesNotMatch(render.processingRecovery(invalidPdf), /<button/);
  assert.match(render.processingRecovery({ ...invalidPdf, paper: { ...invalidPdf.paper, failure: 'PAPER_ORIGINAL_UNAVAILABLE' } }), /重试处理原卷/);
});

test('saved image recognition has a publication entry without OCR or modifying historical review data', async t => {
  const render = await renderers(t);
  for (const mediaType of ['image/png', 'image/jpeg']) {
    const result = { paper: { status: 'review', mediaType, modelAvailable: false,
      recognition: { stems: ['已经拒绝的题目', '待整理的旧题'] } }, questions: [],
      reviews: [{ candidateIndex: 0, outcome: 'rejected' }], savedImageRecovery: { publishable: 1, pending: 0 } };
    const saved = JSON.stringify(result);
    const html = render.savedImageRecovery(result);
    assert.match(html, /已有 1 道识别结果/);
    assert.match(html, /整理已有题目/);
    assert.match(html, /不重新调用模型/);
    assert.doesNotMatch(html, /重试处理原卷/);
    assert.match(render.savedImageRecovery(result, true), /<button disabled/);
    assert.equal(render.savedImageRecovery({ ...result, closedBook: true }), '');
    assert.equal(render.savedImageRecovery({ ...result, paper: { ...result.paper, status: 'processing' } }), '');
    assert.equal(render.savedImageRecovery({ ...result, paper: { ...result.paper, mediaType: 'application/pdf' } }), '');
    assert.equal(render.savedImageRecovery({ ...result, savedImageRecovery: undefined }), '');
    assert.equal(render.savedImageRecovery({ ...result, savedImageRecovery: { publishable: 0, pending: 0 } }), '');
    const unresolved = render.savedImageRecovery({ ...result, savedImageRecovery: { publishable: 0, pending: 2 } });
    assert.match(unresolved, /2 道题的保存结果不完整/);
    assert.doesNotMatch(unresolved, /<button/);
    assert.match(render.savedImageRecovery({ ...result, questions: [{ id: 'retained' }] }), /整理已有题目/);
    let calls = 0;
    const control = render.SavedImageRecovery({ result, onPublish: () => { calls++; } });
    control.props.children.find(child => child?.props?.children).props.children.find(child => child?.type === 'button').props.onClick();
    assert.equal(calls, 1); // Local callback only, no model or network call.
    assert.equal(JSON.stringify(result), saved);
  }
});

test('study follows saved page order while preserving within-page sequence and original sources', async t => {
  const render = await renderers(t);
  const questions = [
    { id: 'q1', stem: '原页一题', pageNumber: 1, sourcePages: [1] },
    { id: 'q2', stem: '原页二第一题', pageNumber: 2, sourcePages: [2, 1] },
    { id: 'q3', stem: '原页二第二题', pageNumber: 2, sourcePages: [2] },
    { id: 'q4', stem: '原页三题', pageNumber: 3, sourcePages: [3] }
  ];
  const before = JSON.stringify(questions);
  const reordered = render.orderedStudyQuestions(questions, [2, 1, 3]);
  assert.deepEqual(reordered.map(q => q.id), ['q2', 'q3', 'q1', 'q4']);
  assert.equal(reordered[0], questions[1]);
  assert.deepEqual(reordered[0].sourcePages, [2, 1]);
  assert.equal(JSON.stringify(questions), before);
  assert.equal(render.orderedStudyQuestions(questions, null), questions);
  assert.equal(render.orderedStudyQuestions(questions, []), questions);
  assert.deepEqual(render.orderedStudyQuestions(questions, [2]).map(q => q.id), ['q2', 'q3', 'q1', 'q4']);
  const html = render.study({ paper: { title: '调序原卷', pageOrder: [2, 1, 3] }, questions });
  assert.match(html, /原页二第一题/);
  assert.doesNotMatch(html, /原页二第二题|原页一题|原页三题/);
  assert.match(html, /第 1 \/ 4 题/);
  assert.match(html, /<button type="button" disabled="">上一题<\/button>/);
  assert.match(html, /<button type="button">下一题<\/button>/);
  assert.match(html, /href="\/api\/v1\/papers\/paper\/pages\/2"/);
});
