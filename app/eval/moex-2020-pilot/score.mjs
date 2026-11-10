import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { modelGradingReference, gradePracticeAnswer } from '../../dist/server/question-reference.js';

const json = async filename => JSON.parse(await readFile(new URL(filename, import.meta.url), 'utf8'));
const { questions: gold, sourcePages, referenceRevision } = await json('official-exam-2020-gold.json');
const baseline = await json('official-exam-2020-run.json');
const retry = await json('official-exam-2020-page3-retry.json').catch(error => {
  if (error.code !== 'ENOENT') throw error;
  return null;
});
const textKey = value => (value ?? '').normalize('NFKC').replace(/[\s\u200b-\u200d]+/gu, '');
function numberAndStem(question) {
  const original = question.stem.normalize('NFKC');
  const match = /^(?:第\s*)?(\d{1,2})(?:\s*[.、):题題]\s*|\s+)/u.exec(original);
  return { number: match ? Number(match[1]) : null, text: match ? original.slice(match[0].length) : original };
}

function splitOptions(text) {
  const markers = [...text.matchAll(/(?<![a-zA-Z])(?:\(([A-D])\)|([A-D])[\s]*[.、):])/gu)];
  const marker = [];
  let next = 0;
  for (const found of markers) {
    if ((found[1] ?? found[2]) === 'ABCD'[next]) {
      marker.push(found);
      next++;
    }
  }
  const options = marker.length === 4 ? Object.fromEntries(marker.map((item, index) => [
    'ABCD'[index], text.slice(item.index + item[0].length, marker[index + 1]?.index).trim()
  ])) : null;
  return { stem: options ? text.slice(0, marker[0].index).trim() : text.trim(), options };
}

function decodeAnswer(answer, options) {
  if (!answer) return null;
  const text = answer.trim().normalize('NFKC').toUpperCase();
  const label = /^(?:(?:答案|选项|選項)\s*:?\s*)?(?:\(([A-D])\)|([A-D])(?=[.、:\s。]|$))/u.exec(text);
  if (label) return label[1] ?? label[2];
  const exact = Object.entries(options).filter(([, value]) => textKey(value).toUpperCase() === textKey(text));
  return exact.length === 1 ? exact[0][0] : null;
}

function score(questions, subset) {
  const candidates = questions.map(q => ({ ...q, ...numberAndStem(q) }));
  const rows = subset.map(key => {
    const matches = candidates.filter(item => item.number === key.number && item.page === key.page);
    const q = matches.length === 1 ? matches[0] : undefined;
    const { stem, options } = q ? splitOptions(q.text) : {};
    const prediction = decodeAnswer(q?.answer, key.options);
    const solution = q?.answer ? { status:'solved',answer:q.answer,explanation:q.explanation } : null;
    return {
      number:key.number, page:key.page, referenceAnswer:key.answer, detected:Boolean(q),
      fourOptions:Boolean(options && Object.values(options).every(Boolean)),
      normalizedStemExact:Boolean(stem && textKey(stem) === textKey(key.stem)),
      normalizedOptionsExact:Boolean(options && Object.keys(key.options).every(k => textKey(options[k]) === textKey(key.options[k]))),
      rawModelAnswer:q?.answer ?? null, answerModel:q?.model ?? null, interpretedOption:prediction, correct:prediction === key.answer,
      automaticallyGradable:Boolean(q && modelGradingReference(q.kind,q.stem,solution)),
      appGradeForOfficialAnswer:q ? gradePracticeAnswer(key.answer,null,q.kind,q.stem,solution) : null
    };
  });
  return { total:rows.length, detected:rows.filter(q=>q.detected).length, fourOptions:rows.filter(q=>q.fourOptions).length,
    exactStems:rows.filter(q=>q.normalizedStemExact).length, exactOptions:rows.filter(q=>q.normalizedOptionsExact).length,
    interpreted:rows.filter(q=>q.interpretedOption).length, correct:rows.filter(q=>q.correct).length,
    automaticallyGradable:rows.filter(q=>q.automaticallyGradable).length, rows };
}
function usage(run) {
  return { recognizedSeconds:(Date.parse(run.recognitionFinishedAt)-Date.parse(run.startedAt))/1000,
    totalSeconds:(Date.parse(run.finishedAt)-Date.parse(run.startedAt))/1000,
    meteredYuan:run.usage.reduce((s,x)=>s+Number(x.spentMicros??0),0)/1e6,
    requestStates:run.usage.reduce((s,x)=>(s[x.state]=(s[x.state]??0)+1,s),{}) };
}
assert.equal(gold.length,40);
function fullScore(run) {
  const printedPageMatches = Array.from({ length: sourcePages }, (_, index) => index + 1).filter(page => {
    const reviews = run.recognition.pageReviews.filter(review => review.page === page);
    return reviews.length === 1 && reviews[0].recognition?.printedPage === page;
  }).length;
  return { ...score(run.questions,gold), ...usage(run),
    printedPageMatches };
}
function qualityGate(run, scored) {
  const minimumPercent = 95;
  const check = (metric, passedCount, total) => ({ metric, passedCount, total, passed: total > 0 && passedCount * 100 > minimumPercent * total });
  const checks = [
    check('detected', scored.detected, scored.total),
    check('fourOptions', scored.fourOptions, scored.total),
    check('exactStems', scored.exactStems, scored.total),
    check('exactOptions', scored.exactOptions, scored.total),
    check('printedPageMatches', scored.printedPageMatches, sourcePages),
    check('correct', scored.correct, scored.total)
  ];
  const answerModels = new Set(run.questions.map(question => question.model).filter(Boolean));
  for (const model of answerModels) {
    const rows = scored.rows.filter(row => row.answerModel === model);
    checks.push(check(model, rows.filter(row => row.correct).length, rows.length));
  }
  const measured = ['page', 'solution'].every(task => run.usage.some(call => call.task === task && call.state === 'metered'));
  return { minimumPercent, comparison: '>', measured, passed: measured && checks.every(item => item.passed), checks };
}
const [filename, flag, ...extra] = process.argv.slice(2);
assert.ok(!extra.length && (flag === undefined || flag === '--require-95'), 'Expected a report filename and optional --require-95');
const result = { first: fullScore(baseline), retried: retry ? {
  ...score(retry.questions.map(q=>({...q,page:3})),gold.filter(q=>q.page===3)), ...usage(retry),
  printedPageMatches:retry.recognition.pageReviews.filter(p=>p.recognition?.printedPage===3).length
} : null };
let output = 'official-exam-2020-audited-score.json';
if (filename) {
  assert.match(filename, /^official-exam-2020-[a-z0-9-]+\.json$/u);
  const regression = await json(filename);
  assert.equal(regression.inputSha256, baseline.inputSha256);
  result.regression = fullScore(regression);
  output = filename.replace(/\.json$/u, '-audited-score.json');
  if (flag === '--require-95') {
    const gate = qualityGate(regression, result.regression);
    console.log(JSON.stringify({ referenceRevision, report: filename, ...gate }));
    if (!gate.passed) process.exitCode = 1;
  }
}
if (flag !== '--require-95') {
  await writeFile(new URL(output, import.meta.url),JSON.stringify({ referenceRevision, ...result },null,2)+'\n');
  for (const [key,value] of Object.entries(result)) if(value) {
    const {rows,...summary}=value;
    console.log(JSON.stringify({scope:key,...summary,missed:rows.filter(q=>!q.detected).map(q=>q.number),
      wrongOrUndecoded:rows.filter(q=>q.detected&&!q.correct).map(q=>[q.number,q.referenceAnswer,q.interpretedOption]),
      missingOptions:rows.filter(q=>q.detected&&!q.fourOptions).map(q=>q.number)}));
  }
}
