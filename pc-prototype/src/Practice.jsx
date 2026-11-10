import { samePracticeAttempt } from './practice-draft.js';
import { libraryStatusLabels } from './paper-library-status.js';
import { MistakeRetry } from './Mistakes.jsx';
import { KnowledgeNetwork, KnowledgePoints } from './Knowledge.jsx';
import { QuestionRecall, AnswerCorrection, questionKinds } from './QuestionRecall.jsx';
import React, { useEffect, useRef, useState } from 'react';
import { PaperText } from './PaperText.jsx';

function PracticeQuestionInput({ question, number, title, answer, submitted, disabled, onFocus, onAnswer, formatted }) {
  const stem = question.stemCorrection ?? question.stem;
  const optionA = /(?:^|\s)[AＡ][.．、)）:]\s*/u.exec(stem);
  const optionB = /(?:^|\s)[BＢ][.．、)）:]\s*/u.exec(stem);
  const firstLine = stem.split('\n', 1)[0];
  const legacyChoice = !question.kind &&
    /(?:的是|为|是|有)\s*[（(][^\S\r\n]*[）)]\s*[。．.?？]?\s*$/u.test(firstLine);
  const choice = question.kind === 'choice' || (optionA && optionB && optionA.index < optionB.index) || legacyChoice;
  const label = '第 ' + number + ' 题作答';

  if (formatted) return <div className="pc-fields">
    <strong>{title}</strong>
    <PaperText text={stem} />
    <label>{label}
      {choice && !submitted ? <select value={answer} disabled={disabled} onFocus={onFocus}
        onChange={event => onAnswer(event.target.value)}>
        <option value="">请选择答案</option>
        {['A', 'B', 'C', 'D'].map(letter => <option key={letter}>{letter}</option>)}
      </select> : <textarea value={answer} maxLength={4000} readOnly={submitted}
        disabled={disabled} onFocus={onFocus} onChange={event => onAnswer(event.target.value)} />}
    </label>
  </div>;

  if (!choice) return <label>{title}
    <span className="pc-confirmed-stem">{stem}</span>
    <textarea aria-label={label} value={answer} maxLength={4000} readOnly={submitted}
      disabled={disabled} onFocus={onFocus} onChange={event => onAnswer(event.target.value)} />
  </label>;

  const optionsStart = optionA?.index ?? (legacyChoice ? firstLine.length : stem.length);
  const prompt = stem.slice(0, optionsStart);
  const blanks = [...prompt.matchAll(/[（(][^\S\r\n]*[）)]/gu)];
  const blank = blanks.at(-1);
  const before = blank ? prompt.slice(0, blank.index) : prompt.trimEnd() + ' ';
  const after = blank ? stem.slice(blank.index + blank[0].length) : stem.slice(optionsStart);
  return <div className="pc-choice-question">
    <div>{title}</div>
    <div className="pc-confirmed-stem">{before}<span className="pc-choice-blank">
      {blank?.[0][0] ?? '（'}<input type="text" aria-label={label} value={answer}
        title={answer || undefined} autoComplete="off" spellCheck={false}
        readOnly={submitted} disabled={disabled} onFocus={onFocus}
        onChange={event => {
          const value = event.target.value.normalize('NFKC').toUpperCase().trim();
          if (/^[A-D]?$/u.test(value)) onAnswer(value);
        }} />{blank?.[0].at(-1) ?? '）'}
    </span>{after}</div>
  </div>;
}

export function Practice({ paperId, courses, api, csrf, onOpen, onExpired, onMistakes }) {
  if (paperId) return <Attempt paperId={paperId} api={api} csrf={csrf} onOpen={onOpen} onExpired={onExpired} />;
  return <PaperPicker onMistakes={onMistakes} courses={courses} api={api} csrf={csrf} onOpen={onOpen} onExpired={onExpired} />;
}

function PaperPicker({ courses, api, csrf, onOpen, onExpired, onMistakes }) {
  const [recallPapers, setRecallPapers] = useState(null);
  const [chosen, setChosen] = useState('');
  const [duration, setDuration] = useState('');
  const [selectedPaperId, setSelectedPaperId] = useState('');
  const courseId = chosen || courses[0]?.id;
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (!courseId) return;
    const controller = new AbortController();
    api('/courses/' + courseId + '/papers', { signal: controller.signal }).then(({ papers }) => {
      if (!controller.signal.aborted) setResult({ courseId, papers: papers.filter(paper => paper.status === 'review' && paper.hasQuestions) });
    }).catch(error => {
      if (controller.signal.aborted) return;
      if (error.status === 401) onExpired();
      else setResult({ courseId, error: error.message });
    });
    return () => controller.abort();
  }, [courseId, api, onExpired]);

  if (recallPapers) return <QuestionRecall onMistakes={onMistakes} papers={recallPapers} api={api} csrf={csrf} onExpired={onExpired} onBack={() => setRecallPapers(null)} />;
  const current = result?.courseId === courseId ? result : null;
  const selectedPaper = current?.papers?.find(paper => paper.id === selectedPaperId);
  return <main className="content">
    <div className="intro"><h1>题目背诵</h1><p>选择科目和原卷，练习已经确认的题目。</p></div>
    <section className="panel padded">
      {courseId ? <label className="pc-course-select">科目<select value={courseId} onChange={event => { setChosen(event.target.value); setSelectedPaperId(''); }}>
        {courses.map(course => <option key={course.id} value={course.id}>{course.name} · {course.term}</option>)}
      </select></label> : <p>请先在学习进展添加科目。</p>}
      {current?.error && <p role="alert">{current.error}</p>}
      {courseId && !current && <p role="status">正在读取试卷…</p>}
      {current?.papers?.length === 0 && <p>请先上传试卷并确认题目。</p>}
      {current?.papers?.length > 0 && <div className="pc-fields">
        <h2>整套背诵</h2>
        <label>选择试卷<select value={selectedPaper?.id ?? ''} onChange={event => setSelectedPaperId(event.target.value)}>
          <option value="">请选择一套原卷</option>
          {current.papers.map(paper => <option key={paper.id} value={paper.id} disabled={paper.libraryStatus !== 'ready'}>
            {paper.title}{paper.libraryStatus !== 'ready' ? '（' + libraryStatusLabels[paper.libraryStatus] + '）' : ''}
          </option>)}
        </select></label>
        <label>整套练习计时<select value={duration} onChange={event => setDuration(event.target.value)}>
          <option value="">不限时</option><option value="30">30 分钟</option><option value="60">60 分钟</option>
          <option value="90">90 分钟</option><option value="120">120 分钟</option>
        </select></label>
        <div className="pc-dialog-actions">
          <button className="primary" disabled={selectedPaper?.libraryStatus !== 'ready'}
            onClick={() => onOpen(selectedPaper.id, duration ? Number(duration) : undefined)}>开始整套背诵</button>
        </div>
        <h2>按题型背诵</h2>
        <button onClick={() => setRecallPapers(current.papers)}>
          {current.papers.length > 1 ? '跨卷按题型背诵' : '开始按题型背诵'}
        </button>
      </div>}
    </section>
  </main>;
}

const resultLabels = { correct: '正确', incorrect: '错误', unanswered: '未作答', needs_review: '无法自动判定' };

function questionResultLabel(question) {
  if (question.result === 'needs_review' && ['queued', 'processing'].includes(question.solutionStatus)) {
    return '模型判分中';
  }
  return resultLabels[question.result];
}

const blankDraft = { marked: [], position: null };
const changesSince = (answers, baseline) => Object.fromEntries(Object.entries(answers)
  .filter(([id, answer]) => answer !== (baseline[id] ?? '')));

function localAttemptDraft(key) {
  try { return JSON.parse(sessionStorage.getItem(key) ?? 'null'); } catch { return null; }
}

function jumpToQuestion(id) {
  if (id) requestAnimationFrame(() => document.getElementById('attempt-question-' + id)?.scrollIntoView({ block: 'start' }));
}

export function Attempt({ paperId, api, csrf, onOpen, onExpired, embedded = false }) {
  const [attempt, setAttempt] = useState(null);
  const [historyId, setHistoryId] = useState('');
  const [history, setHistory] = useState([]);
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const [answers, setAnswers] = useState({});
  const [draft, setDraft] = useState(blankDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [resultFilter, setResultFilter] = useState('');
  const [retryQuestion, setRetryQuestion] = useState(null);
  const settled = useRef(false);
  const savingLock = useRef(false);
  const latestInput = useRef(null);
  latestInput.current = { answers, draft };
  const [now, setNow] = useState(Date.now);
  const path = '/papers/' + paperId + '/practice';
  const draftKey = 'beitibao-draft-' + paperId;

  useEffect(() => {
    const controller = new AbortController();
    const requested = Number(new URL(location.href).searchParams.get('duration'));
    const data = Number.isInteger(requested) && requested >= 1 && requested <= 360 ? { durationMinutes: requested } : {};
    setAttempt(null); setError(''); setNotice(''); setRetryQuestion(null); setResultFilter('');
    api(historyId ? path + '/history/' + historyId : path, { ...(historyId ? {} : { data, csrf }), signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return;
      const stored = result.submittedAt ? null : localAttemptDraft(draftKey);
      const saved = samePracticeAttempt(stored?.attemptId, result.attemptId) ? stored : null;
      if (stored && !saved) {
        try { sessionStorage.setItem(draftKey + ':' + (stored.attemptId ?? 'legacy'), JSON.stringify(stored)); } catch {}
      }
      const ids = new Set(result.questions.map(question => question.id));
      const localChanges = Object.fromEntries(Object.entries(saved?.changes ?? {})
        .filter(([id, value]) => ids.has(id) && typeof value === 'string'));
      const serverDraft = result.draft ?? blankDraft;
      const restored = saved?.draft?.marked?.every(id => ids.has(id)) &&
        (!saved.draft.position || ids.has(saved.draft.position)) ? saved.draft : serverDraft;
      settled.current = Boolean(result.submittedAt);
      setAttempt(result);
      setAnswers({ ...result.answers, ...localChanges });
      setDraft(restored);
      if (saved) setNotice('已恢复此窗口未提交的修改。请核对后保存。');
      jumpToQuestion(restored.position);
    }).catch(failure => {
      if (controller.signal.aborted) return;
      if (failure.status === 401) onExpired();
      else setError(failure.message);
    });
    return () => controller.abort();
  }, [api, path, csrf, onExpired, draftKey, historyId]);

  useEffect(() => {
    if (!attempt?.submittedAt) return;
    const controller = new AbortController();
    api(path + '/history', { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setHistory(result.history);
    }).catch(failure => {
      if (!controller.signal.aborted) setError(failure.message);
    });
    return () => controller.abort();
  }, [attempt?.submittedAt, path, api]);

  useEffect(() => {
    if (!attempt || attempt.historical) return;
    const changes = changesSince(answers, attempt.answers);
    try {
      if (attempt.submittedAt || (!Object.keys(changes).length && JSON.stringify(draft) === JSON.stringify(attempt.draft ?? blankDraft))) {
        sessionStorage.removeItem(draftKey);
      } else {
        sessionStorage.setItem(draftKey, JSON.stringify({ changes, draft, attemptId: attempt.attemptId }));
      }
    } catch { /* The server draft remains available if browser storage is disabled. */ }
  }, [attempt, answers, draft, draftKey]);

  useEffect(() => {
    if (attempt?.historical || !attempt?.submittedAt || !attempt.questions.some(question => ['queued', 'processing'].includes(question.solutionStatus))) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const latest = await api(path, { signal: controller.signal });
        if (!controller.signal.aborted) setAttempt(latest);
      } catch (failure) {
        if (controller.signal.aborted) return;
        if (failure.status === 401) onExpired();
        else setError(failure.message);
      }
    }, 5000);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [attempt, api, path, onExpired]);

  const deadline = attempt?.deadlineAt ? Date.parse(attempt.deadlineAt) : null;
  const remaining = deadline === null ? null : Math.max(0, Math.ceil((deadline - now) / 1000));
  useEffect(() => {
    if (!deadline || attempt?.submittedAt) return;
    const controller = new AbortController();
    const interval = setInterval(() => setNow(Date.now()), 1000);
    const timer = setTimeout(async () => {
      try {
        const current = await api(path, { signal: controller.signal });
        if (!controller.signal.aborted && current.submittedAt) {
          settled.current = true;
          setAttempt(current);
          setAnswers(current.answers);
          setDraft(current.draft ?? blankDraft);
          const unsaved = Object.keys(changesSince(latestInput.current.answers, current.answers)).length;
          setNotice(unsaved ? `时间到，已提交服务器草稿。有 ${unsaved} 题的最后修改未计入。` : '时间到，已提交服务器上最后保存的草稿。');
        }
      } catch (failure) {
        if (controller.signal.aborted) return;
        if (failure.status === 401) onExpired();
        else setError(failure.message);
      }
    }, Math.max(0, deadline - Date.now()) + 100);
    return () => { clearInterval(interval); clearTimeout(timer); controller.abort(); };
  }, [deadline, attempt?.submittedAt, api, path, onExpired]);

  const dirty = Boolean(attempt && (Object.keys(changesSince(answers, attempt.answers)).length
    || JSON.stringify(draft) !== JSON.stringify(attempt.draft ?? blankDraft)));
  const autoSave = React.useEffectEvent(() => save(false, true));
  const deadlineNear = remaining !== null && remaining <= 10;
  const expired = remaining === 0;
  useEffect(() => {
    if (!dirty || busy || saving || error || attempt?.submittedAt || expired) return;
    const timer = setTimeout(autoSave, deadlineNear ? 250 : 1500);
    return () => clearTimeout(timer);
  }, [dirty, busy, saving, error, attempt?.submittedAt, expired, deadlineNear]);

  async function save(submit, automatic = false) {
    if (savingLock.current || settled.current) return;
    savingLock.current = true;
    setSaving(true);
    if (!automatic) setBusy(true);
    setError('');
    setNotice('');
    try {
      const changes = changesSince(answers, attempt.answers);
      const result = await api(path + '/save', { data: { changes, draft, revision: attempt.revision, submit }, csrf });
      if (settled.current) return;
      settled.current = Boolean(result.submittedAt);
      setAttempt(result);
      const pending = changesSince(latestInput.current.answers, answers);
      const unsaved = Object.keys(changesSince(latestInput.current.answers, result.answers)).length;
      setAnswers(result.submittedAt ? result.answers : { ...result.answers, ...pending });
      setDraft(result.submittedAt || latestInput.current.draft === draft ? result.draft ?? blankDraft : latestInput.current.draft);
      if (result.submittedAt) setNotice(unsaved ? `作答已提交。有 ${unsaved} 题的最后修改未计入。` : '作答已提交。');
      else if (!automatic) setNotice('草稿已保存，刷新后可继续。');
    } catch (failure) {
      if (failure.status === 401) onExpired();
      else if (['PRACTICE_CONFLICT', 'PRACTICE_SUBMITTED'].includes(failure.code)) {
        try {
          const latest = await api(path);
          if (settled.current) return;
          if (!samePracticeAttempt(latest.attemptId, attempt.attemptId)) {
            setError('已开启新版练习。此窗口的旧版输入已保留，未合并到新版；请返回练习列表重新打开。');
            return;
          }
          settled.current = Boolean(latest.submittedAt);
          setAttempt(latest);
          if (latest.submittedAt) {
            setAnswers(latest.answers);
            setDraft(latest.draft ?? blankDraft);
            const unsaved = Object.keys(changesSince(latestInput.current.answers, latest.answers)).length;
            setNotice(unsaved ? `已交卷。有 ${unsaved} 题的最后修改未计入。` : '已交卷，已显示服务器结果。');
          } else {
            setAnswers({ ...latest.answers, ...changesSince(latestInput.current.answers, attempt.answers) });
            if (JSON.stringify(latestInput.current.draft) === JSON.stringify(attempt.draft ?? blankDraft)) setDraft(latest.draft ?? blankDraft);
            setNotice('已合并服务器草稿并保留此窗口的修改。请核对后再次保存或提交。');
          }
        } catch (reloadFailure) {
          if (reloadFailure.status === 401) onExpired();
          else setError(reloadFailure.message);
        }
      } else setError(automatic ? '自动保存失败。请点击「保存草稿」重试。' : failure.message);
    } finally {
      savingLock.current = false;
      setSaving(false);
      setBusy(false);
    }
  }

  const Container = embedded ? 'div' : 'main';
  const formatted = attempt?.title === '考题预测卷';
  return <Container className={embedded ? undefined : 'content'}>
    {!embedded && <button disabled={busy} onClick={() => onOpen('')}>返回练习列表</button>}
    <div className="intro pc-review-title"><div className="eyebrow">{attempt?.title === '考题预测卷' ? '整套预测' : '原卷练习'}</div>
      {embedded ? <h2>预测试卷</h2> : <h1>{attempt?.title ?? '题目背诵'}</h1>}
      {remaining !== null && !attempt?.submittedAt && <p>剩余 {Math.floor(remaining / 60)} 分 {remaining % 60} 秒。到期提交最后保存的草稿。</p>}
      {attempt && <p>{attempt.submittedAt ? '已提交 · ' : ''}共 {attempt.questions.length} 题</p>}
    </div>
    {error && <p className="pc-status" role="alert">{error}</p>}
    {notice && <p className="pc-status" role="status">{notice}</p>}
    {!attempt && !error && <p role="status">正在加载练习…</p>}
    {attempt?.inputChanged && <p role="status">题目已有新版本。本次仍保留开练时的题面，旧版本作答不计入新版覆盖。</p>}
    {attempt?.submittedAt && history.length > 0 && <label>作答记录<select value={historyId} onChange={event => setHistoryId(event.target.value)}>
      <option value="">当前练习</option>
      {history.map(item => <option key={item.id} value={item.id}>历史作答 · {new Date(item.submittedAt).toLocaleString('zh-CN')}</option>)}
    </select></label>}
    {attempt?.historical && <p role="status">历史作答：题面、答案和成绩按原版本保留。</p>}
    {attempt && !attempt.submittedAt && <p role="status">{saving ? '保存中…' : dirty ? '有未保存的修改' : '草稿已同步'}</p>}
    {retryQuestion ? <MistakeRetry key={retryQuestion.id} item={{ ...retryQuestion, paperTitle: attempt.title }}
      api={api} csrf={csrf} onExpired={onExpired} closeLabel="返回交卷结果" onClose={() => {
        setRetryQuestion(null); jumpToQuestion(retryQuestion.id);
      }} /> : <>
    {attempt?.submittedAt && <section className="panel padded pc-review-title">
      <h2>本次结果</h2>
      <div className="chips">{[['', '全部题目'], ['correct', '答对'], ['incorrect', '错题'], ['unanswered', '未作答'], ['needs_review', '未自动判分']].map(([key, label]) =>
        <button key={key} aria-pressed={resultFilter === key} onClick={() => setResultFilter(key)}>
          {label} · {attempt.questions.filter(q => !key || q.result === key).length}
        </button>)}</div>
      <details><summary>查看卷后知识网和分析</summary><KnowledgeNetwork network={attempt.knowledgeNetwork}
        prediction={attempt.questions.some(question => question.modelSolution?.evidence?.length)}
        onQuestion={number => { setResultFilter(''); jumpToQuestion(attempt.questions[number - 1]?.id); }} /></details>
    </section>}
    {attempt && <div className="pc-attempt-layout">
      <section className="panel padded">
      {attempt.questions.map((question, index) => (!resultFilter || question.result === resultFilter) && <div key={question.id} id={'attempt-question-' + question.id} className="pc-fields pc-attempt-question">
        <PracticeQuestionInput question={question} number={index + 1} formatted={formatted}
          title={'第 ' + (index + 1) + ' 题' + (attempt.title !== '考题预测卷' ? ' · 原卷第 ' + question.pageNumber + ' 页' : '')}
          answer={answers[question.id] ?? ''} submitted={Boolean(attempt.submittedAt)}
          disabled={busy || (!attempt.submittedAt && remaining === 0)}
          onFocus={() => !attempt.submittedAt && setDraft(current => ({ ...current, position: question.id }))}
          onAnswer={value => setAnswers(current => ({ ...current, [question.id]: value }))} />
        {attempt.submittedAt && <div className="pc-confirmed-stem">
          <strong>{questionResultLabel(question)}</strong>
          {!attempt.historical && question.result === 'incorrect' && <button type="button" onClick={() => {
            setRetryQuestion(question); window.scrollTo(0, 0);
          }}>重练本题</button>}
          {question.inputChanged && <p>题干已有新版，下方保留本次作答的原题、答案和成绩。</p>}
          {question.referenceChanged && <p>参考答案已更新。下方显示交卷时的答案和解析。</p>}
          {question.reference && <>
            <p>参考答案（{question.reference.source === 'teacher' ? '教师提供' : '已核验'}）</p>
            <div>{question.reference.answers.join('、')}</div>
            {question.reference.explanation && <p>{question.reference.explanation}</p>}
          </>}
          {question.modelSolution && <KnowledgePoints points={question.modelSolution.knowledgePoints} />}
          {question.modelSolution && <>
            <p>{question.modelSolution.status === 'solved' ? '模型参考答案' : '模型无法确定答案'}</p>
            {question.modelSolution.answer && <PaperText text={question.modelSolution.answer} />}
            <details open>
              <summary>答案解析</summary>
              <PaperText text={question.modelSolution.explanation} />
            </details>
            {question.modelSolution.evidence?.length > 0 && <details>
              <summary>查看预测依据</summary>
              <p><strong>预测题：</strong>{question.stem}</p>
              <p><strong>推演逻辑：</strong>{question.modelSolution.rationale}</p>
              <ul>{question.modelSolution.evidence.map(source => <li key={source.id}>
                <strong>{source.title} · 第 {source.page} 页</strong>
                {source.paperId && source.page && <p><a href={'/api/v1/papers/' + source.paperId + '/pages/' + source.page}
                  target="_blank" rel="noreferrer">查看证据原页</a></p>}
                <p>{source.stem}</p>
              </li>)}</ul>
            </details>}
          </>}
          {!question.modelSolution && ['queued', 'processing'].includes(question.solutionStatus) && <p>正在生成知识点、参考答案和解析…</p>}
          {question.legacySolutionUnavailable && <p>这份历史答卷未保存模型解析快照。</p>}
          {question.solutionRetryable && <button onClick={async () => {
            try {
              await api('/papers/' + paperId + '/questions/' + question.id + '/solution', { data: {}, csrf });
              setAttempt(await api(path));
            } catch (failure) {
              if (failure.status === 401) onExpired();
              else setError(failure.message);
            }
          }}>重试生成答案</button>}
          {!attempt.historical && <AnswerCorrection question={question} path={'/papers/' + paperId + '/questions/' + question.id}
            api={api} csrf={csrf} onExpired={onExpired} />}
        </div>}
      </div>)}
      {!attempt.submittedAt && <div className="pc-dialog-actions pc-confirmed-title">
        <button disabled={saving || remaining === 0} onClick={() => save(false)}>保存草稿</button>
        <button disabled={saving || remaining === 0} className="primary" onClick={() => setConfirmSubmit(true)}>
          {embedded ? '交卷并查看答案' : '提交整套'}
        </button>
      </div>}
      </section>
      <aside className="panel padded pc-answer-card" aria-label="答题卡">
        <h2>答题卡</h2>
        {embedded && !attempt.submittedAt && <button type="button" disabled={saving || remaining === 0}
          onClick={() => setConfirmSubmit(true)}>交卷并查看答案</button>}
        {[...new Set(attempt.questions.map(question => question.kind ?? 'other'))].map(kind => <section className="answer-group" key={kind}>
          <h3>{questionKinds[kind] ?? '其他题'}</h3>
          <div className="pc-answer-grid">
          {attempt.questions.map((question, index) => {
            if ((question.kind ?? 'other') !== kind) return null;
            const result = attempt.submittedAt ? question.result : undefined;
            const answerStatus = attempt.submittedAt ? questionResultLabel(question) : answers[question.id]?.trim() ? '已答' : '未答';
            const cardStatus = result === 'needs_review'
              ? answerStatus === '模型判分中' ? '判分中' : '未判定'
              : answerStatus;
            const label = draft.position === question.id ? answerStatus + '，当前位置' : answerStatus;
            return <a key={question.id} href={'#attempt-question-' + question.id} aria-label={`第 ${index + 1} 题，${label}`}
              data-result={result}
              aria-current={draft.position === question.id ? 'location' : undefined}
              onClick={event => {
                if (attempt.submittedAt) {
                  event.preventDefault();
                  setResultFilter('');
                  jumpToQuestion(question.id);
                } else setDraft(current => ({ ...current, position: question.id }));
              }}>
              <span>{index + 1}</span><small>{cardStatus}</small>
            </a>;
          })}
          </div>
        </section>)}
      </aside>
    </div>}
    {confirmSubmit && !attempt?.submittedAt && <dialog className="pc-dialog" aria-labelledby="submit-paper-title"
      ref={element => { if (element && !element.open) element.showModal(); }}
      onCancel={event => { event.preventDefault(); setConfirmSubmit(false); }}>
      <h2 id="submit-paper-title">确认交卷</h2>
      <p>还有 {attempt.questions.filter(question => !answers[question.id]?.trim()).length} 题未作答。提交后可查看整卷解析。</p>
      <div className="pc-dialog-actions">
        <button onClick={() => setConfirmSubmit(false)}>返回检查</button>
        <button className="primary" disabled={saving || remaining === 0} onClick={() => {
          setConfirmSubmit(false);
          void save(true);
        }}>确认提交</button>
      </div>
    </dialog>}
    </>}
  </Container>;
}
