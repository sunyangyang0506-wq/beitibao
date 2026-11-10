import { KnowledgePoints } from './Knowledge.jsx';
import { RecallQuestion, questionKinds } from './QuestionRecall.jsx';
import React, { useEffect, useState } from 'react';

const labels = { open: '待重练', resolved: '已重练', needs_review: '无法自动判定' };
const grades = { correct: '答对了，已更新重练状态。', incorrect: '这次答错了，可以再练一次。', needs_review: '模型暂时无法判定这次作答。' };

const mistakeViews = [['time', '按错题时间'], ['kind', '按题型'], ['both', '按题型和错题时间']];
const formatMistakeTime = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});
const mistakeDay = item => item.mistakeDay ?? '日期未记录';
const mistakeKind = item => questionKinds[item.kind] ?? '其他题';

function MistakeGroups({ entries, groups, children }) {
  if (!groups.length) return entries.map(children);
  const [groupBy, ...remaining] = groups;
  const grouped = new Map();
  for (const item of entries) {
    const key = groupBy(item);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  }
  return [...grouped].map(([key, items]) => <section className="prototype-mistake-group" key={key}>
    <h2>{key}<span>{items.length} 道</span></h2>
    <MistakeGroups entries={items} groups={remaining}>{children}</MistakeGroups>
  </section>);
}

export function Mistakes({ api, csrf, onExpired, onPractice }) {
  const [items, setItems] = useState(null);
  const [filter, setFilter] = useState('all');
  const [course, setCourse] = useState('');
  const [kind, setKind] = useState('');
  const [day, setDay] = useState('');
  const [view, setView] = useState('time');
  const [selected, setSelected] = useState(null);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    api('/mistakes', { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setItems(result.mistakes);
    }).catch(failure => {
      if (controller.signal.aborted) return;
      if (failure.status === 401) onExpired();
      else setError(failure.message);
    });
    return () => controller.abort();
  }, [api, onExpired, revision]);

  const courses = new Map(items?.map(item => [item.courseId, item.course]) ?? []);
  const visible = items?.filter(item => (filter === 'all' || item.status === filter)
    && (!course || item.courseId === course) && (!kind || item.kind === kind) && (!day || item.mistakeDay === day));
  return <main className="content">
    <div className="intro"><h1>错题本</h1><p>收录整套作答中自动判错的题目，以及背诵自评为待巩固的题目。</p></div>
    {error && <p role="alert">{error}</p>}
    {selected?.mode === 'recall' ? <section className="panel padded">
      <button onClick={() => setSelected(null)}>返回错题列表</button>
      <RecallQuestion key={selected.id} question={selected} path={'/papers/' + selected.paperId + '/questions/' + selected.id}
        api={api} csrf={csrf} onExpired={onExpired} onAssessed={() => setRevision(value => value + 1)} />
    </section> : selected ? <MistakeRetry key={selected.id} item={selected} api={api} csrf={csrf} onExpired={onExpired}
      onSaved={() => setRevision(value => value + 1)} onClose={() => setSelected(null)} /> :
      <section className="panel padded">
        <div className="pc-mistake-filters">
        <label>科目<select value={course} onChange={event => setCourse(event.target.value)}>
          <option value="">全部科目</option>
          {[...courses].map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select></label>
        <label>题型<select value={kind} onChange={event => setKind(event.target.value)}>
          <option value="">全部题型</option>
          {Object.entries(questionKinds).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select></label>
        <label>错题时间<input type="date" value={day} onChange={event => setDay(event.target.value)} /></label>
        <label>筛选状态<select value={filter} onChange={event => setFilter(event.target.value)}>
          <option value="all">全部</option>
          {Object.entries(labels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select></label>
        </div>
        {!items && !error && <p role="status">正在读取错题…</p>}
        {items?.length === 0 && <p>还没有错题。按题型背诵时，选择「漏了部分」或「还想不起来」即可自动收录。 <button onClick={onPractice}>去题目背诵</button></p>}
        {items?.length > 0 && visible?.length === 0 && <p>暂无符合条件的错题。 <button onClick={() => { setCourse(''); setKind(''); setDay(''); setFilter('all'); }}>清除筛选</button></p>}
        {visible?.length > 0 && <>
          <div className="prototype-mistake-view">
            <p role="status">共 {visible.length} 道错题</p>
            <div className="segments" aria-label="查看方式">{mistakeViews.map(([id, label]) =>
              <button key={id} type="button" className={view === id ? 'selected' : ''} aria-pressed={view === id}
                onClick={() => setView(id)}>{label}</button>)}</div>
          </div>
          <MistakeGroups entries={visible} groups={view === 'time' ? [mistakeDay] : view === 'kind' ? [mistakeKind] : [mistakeKind, mistakeDay]}>
            {item => <article className="prototype-mistake-card" key={item.id}>
              <div className="prototype-mistake-meta"><span className="badge blue">{mistakeKind(item)}</span>
                <span className="badge">{labels[item.status]}</span><span>{item.course} · {item.paperTitle} · 第 {item.pageNumber} 页
                  {item.sourceCount > 1 && ` · ${item.sourceCount} 条来源`}</span>
                <span>{item.mistakeAt ? '错题时间 ' + formatMistakeTime.format(new Date(item.mistakeAt)) : '日期未记录'}</span>
              </div>
              <details><summary className="pc-confirmed-stem">{item.stem}</summary>
                {item.mode === 'graded' && <div className="prototype-mistake-answers">
                  <div><strong>当时的作答</strong><p className="pc-confirmed-stem">{item.originalAnswer}</p></div>
                  <div><strong>参考答案</strong><p>{item.reference?.answers.join('、') ?? '暂无参考答案'}</p></div>
                </div>}
                {item.reference?.explanation && <p className="pc-confirmed-stem">{item.reference.explanation}</p>}
                <KnowledgePoints points={item.knowledgePoints} />
              </details>
              <div className="prototype-mistake-footer"><span>{item.mode === 'graded' ? '作答判错' : '专项背诵收录'}</span>
                <button onClick={() => setSelected(item)}>重练</button></div>
            </article>}
          </MistakeGroups>
        </>}
      </section>}
  </main>;
}

export function MistakeRetry({ item, api, csrf, onExpired, onSaved, onClose, closeLabel = '返回错题列表' }) {
  const [answer, setAnswer] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [attemptKey, setAttemptKey] = useState(() => crypto.randomUUID());

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      setResult(await api('/mistakes/' + item.id + '/retry', { data: { attemptKey, answer }, csrf }));
      onSaved?.();
    } catch (failure) {
      if (failure.status === 401) onExpired();
      else setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  return <section className="panel padded">
    <button type="button" onClick={onClose}>{closeLabel}</button>
    <p>{item.paperTitle} · 第 {item.pageNumber} 页</p>
    <p className="pc-confirmed-stem">{item.stem}</p>
    <form className="pc-fields" onSubmit={submit}>
      <label>本次作答<textarea required maxLength={4000} value={answer} readOnly={Boolean(result)}
        disabled={busy} onChange={event => { setAnswer(event.target.value); setAttemptKey(crypto.randomUUID()); }} /></label>
      {!result && <button className="primary" disabled={busy || !answer.trim()}>提交重练</button>}
      {error && <p role="alert">{error}</p>}
    </form>
    {result && <>
      <MistakeRetryFeedback result={result} />
      <button onClick={() => { setResult(null); setAnswer(''); setAttemptKey(crypto.randomUUID()); }}>再练一次</button>
    </>}
  </section>;
}

export function MistakeRetryFeedback({ result }) {
  return <>
    <p role="status">{grades[result.result]}</p>
    <KnowledgePoints points={result.knowledgePoints} />
    <p>参考答案　{result.reference?.answers.join('、') ?? '历史参考答案不可用，无法自动判定。'}</p>
    {result.reference?.explanation && <p className="pc-confirmed-stem">{result.reference.explanation}</p>}
  </>;
}
