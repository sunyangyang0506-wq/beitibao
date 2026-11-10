import { KnowledgePoints } from './Knowledge.jsx';
import React, { useEffect, useState } from 'react';

export const questionKinds = { choice: '选择题', fill: '填空题', calculation: '计算题', short_answer: '简答题', other: '其他题' };

export function QuestionRecall({ papers, api, csrf, onExpired, onBack, onMistakes }) {
  const [questions, setQuestions] = useState([]);
  const [kind, setKind] = useState('');
  const [activeKind, setActiveKind] = useState('');
  const [selected, setSelected] = useState([]);
  const [activePapers, setActivePapers] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all(papers.map(paper => api('/papers/' + paper.id, { signal: controller.signal })
      .then(result => result.questions.map(question => ({ ...question, paperId: paper.id, paperTitle: paper.title }))))
    ).then(results => {
      if (!controller.signal.aborted) setQuestions(results.flat());
    }).catch(failure => {
      if (controller.signal.aborted) return;
      if (failure.status === 401) onExpired();
      else setError(failure.message);
    });
    return () => controller.abort();
  }, [api, papers, onExpired]);

  async function start() {
    setBusy(true);
    setError('');
    try {
      await Promise.all(selected.map(id => api('/papers/' + id + '/recall', { data: { kind }, csrf })));
      setActivePapers(selected);
      setActiveKind(kind);
    } catch (failure) {
      if (failure.status === 401) onExpired();
      else setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  return <main className="content">
    <button onClick={onBack}>返回练习列表</button>
    <div className="intro pc-review-title"><h1>按题型背诵</h1><p>按题型选择同科原卷</p></div>
    <section className="panel padded">
      <label>选择题型<select value={kind} disabled={busy} onChange={event => {
        const next = event.target.value;
        setKind(next);
        setSelected([...new Set(questions.filter(question => question.kind === next).map(question => question.paperId))]);
      }}>
        <option value="">请选择</option>
        {Object.entries(questionKinds).filter(([key]) => questions.some(question => question.kind === key))
          .map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select></label>
      {kind && papers.filter(paper => questions.some(question => question.paperId === paper.id && question.kind === kind))
        .map(paper => <label className="pc-check" key={paper.id}><input type="checkbox" checked={selected.includes(paper.id)}
          disabled={busy} onChange={event => setSelected(event.target.checked
            ? [...selected, paper.id] : selected.filter(id => id !== paper.id))} />{paper.title}</label>)}
      <button disabled={!kind || !selected.length || busy} onClick={start}>开始背诵</button>
      {error && <p role="alert">{error}</p>}
      {questions.filter(question => question.kind === activeKind && activePapers.includes(question.paperId)).map(question => <RecallQuestion key={question.id}
        question={question} path={'/papers/' + question.paperId + '/questions/' + question.id} api={api} csrf={csrf} onExpired={onExpired} onMistakes={onMistakes} />)}
    </section>
  </main>;
}

export function RecallQuestion({ question, path, api, csrf, onExpired, onAssessed, onMistakes }) {
  const [result, setResult] = useState(null);
  const [savedToMistakes, setSavedToMistakes] = useState(false);
  const [stemCorrection, setStemCorrection] = useState(question.stemCorrection ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function reveal(retry = false) {
    setBusy(true);
    setError('');
    try {
      if (retry) await api(path + '/solution', { data: {}, csrf });
      setResult(await api(path + '/reveal', { data: {}, csrf }));
    } catch (failure) {
      if (failure.status === 401) onExpired();
      else setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  async function bookmark() {
    setBusy(true);
    setError('');
    try {
      const saved = await api(path + '/bookmark', { data: { bookmarked: !result.bookmarked }, csrf });
      setResult(current => ({ ...current, ...saved }));
      setSavedToMistakes(saved.bookmarked);
      onAssessed?.();
    } catch (failure) {
      if (failure.status === 401) onExpired();
      else setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  async function assess(rating) {
    setBusy(true);
    setError('');
    try {
      const saved = await api(path + '/assessment', { data: { rating }, csrf });
      setResult(current => ({ ...current, ...saved }));
      setSavedToMistakes(rating !== 'mastered');
      onAssessed?.();
    } catch (failure) {
      if (failure.status === 401) onExpired();
      else setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  return <section className="pc-recognition-item">
    <small>{question.paperTitle} · 第 {question.pageNumber} 页</small>
    <p className="pc-confirmed-stem">{stemCorrection ?? question.stem}</p>
    <StemCorrection question={{ ...question, stemCorrection }} path={path} api={api} csrf={csrf}
      onExpired={onExpired} onSaved={setStemCorrection} />
    <button disabled={busy} onClick={() => reveal(result?.solutionStatus === 'failed')}>
      {!result ? '查看本题答案' : result.solutionStatus === 'failed' ? '重试生成答案' : '刷新答案'}
    </button>
    {error && <p role="alert">{error}</p>}
    {result && <>
      {stemCorrection && <p>下方模型解析对应原题干。可保存自己的答案和解析。</p>}
      {result.modelSolution && <KnowledgePoints points={result.modelSolution.knowledgePoints} />}
      {result.reference && <p>已核验答案：{result.reference.answers.join('、')} {result.reference.explanation}</p>}
      {result.modelSolution ? <div className="pc-confirmed-stem">
        <strong>{result.modelSolution.status === 'solved' ? '模型参考答案与解析' : '模型无法确定答案'}</strong>
        {result.modelSolution.answer && <p>{result.modelSolution.answer}</p>}
        <p>{result.modelSolution.explanation}</p>
      </div> : <p>{result.solutionStatus === 'failed' ? '生成失败。' : '正在生成知识点、参考答案和解析…'}</p>}
      <div className="pc-dialog-actions">
        {Object.entries({ mastered: '能独立说出', partial: '漏了部分', needs_practice: '还想不起来' }).map(([rating, label]) =>
          <button key={rating} disabled={busy} aria-pressed={result.selfRating === rating} onClick={() => assess(rating)}>{label}</button>)}
      </div>
      <button disabled={busy} onClick={bookmark}>{result.bookmarked ? '取消手动收录' : '加入错题本'}</button>
      {savedToMistakes && <p role="status">已收录到错题本。 {onMistakes && <button onClick={onMistakes}>查看错题本</button>}</p>}
      <AnswerCorrection question={result} path={path} api={api} csrf={csrf} onExpired={onExpired} />
    </>}
  </section>;
}

export function AnswerCorrection({ question, path, api, csrf, onExpired }) {
  const [saved, setSaved] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const correction = saved ?? question.correction;

  async function save(event) {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    setBusy(true);
    setError('');
    try {
      setSaved((await api(path + '/correction', { data, csrf })).correction);
    } catch (failure) {
      if (failure.status === 401) onExpired();
      else setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  return <details>
    <summary>个人答案与笔记</summary>
    <form className="pc-fields" onSubmit={save} key={JSON.stringify(correction)}>
      <label>我的答案<textarea name="answer" required maxLength={4000}
        defaultValue={correction?.answer ?? question.reference?.answers?.[0] ?? question.modelSolution?.answer ?? ''} /></label>
      <label>我的解析<textarea name="explanation" maxLength={8000}
        defaultValue={correction?.explanation ?? question.reference?.explanation ?? question.modelSolution?.explanation ?? ''} /></label>
      <button disabled={busy}>{busy ? '保存中…' : '保存笔记'}</button>
    </form>
    {saved && <p role="status">笔记已保存。</p>}
    {error && <p role="alert">{error}</p>}
  </details>;
}

export function StemCorrection({ question, path, api, csrf, onExpired, onSaved }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  async function save(event) {
    event.preventDefault();
    const stem = new FormData(event.currentTarget).get('stem');
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      const result = await api(path + '/stem-correction', { data: { stem }, csrf });
      onSaved(result.stemCorrection);
      setSaved(true);
    } catch (failure) {
      if (failure.status === 401) onExpired();
      else setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  return <details>
    <summary>纠正题干</summary>
    <form className="pc-fields" onSubmit={save}>
      <label>题干<textarea name="stem" required maxLength={8000} key={question.stemCorrection ?? question.stem}
        defaultValue={question.stemCorrection ?? question.stem} /></label>
      <button disabled={busy}>{busy ? '保存中…' : '保存题干'}</button>
    </form>
    {saved && <p role="status">已保存题干。</p>}
    {error && <p role="alert">{error}</p>}
  </details>;
}
