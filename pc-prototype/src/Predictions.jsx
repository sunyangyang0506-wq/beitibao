import React, { useEffect, useState } from 'react';
import { Attempt } from './Practice.jsx';

const labels = {
  queued: '等待生成', processing: '正在生成', ready: '可练习', failed: '生成失败', superseded: '源题已更新'
};

const failureLabels = {
  MODEL_BUDGET_LIMIT: '已达到当天模型预算，已生成的练习仍可使用。',
  MODEL_RATE_LIMIT: '当前已达到推理容量，请稍后重试。',
  PREDICTION_TIMEOUT: '模型响应超时，请稍后重试。',
  PREDICTION_RATE_LIMITED: '模型调用暂时限流，请稍后重试。',
  PREDICTION_VERIFICATION_FAILED: '通过复算的候选题数量不足，请重试。',
  INVALID_PREDICTION: '本次题目没有通过结构或证据校验，请重试。',
  MODEL_NOT_CONFIGURED: '后台预测模型尚未配置。'
};

export function Predictions({ initialCourseId, courses, api, csrf, onOpen, onExpired }) {
  const [selected, setSelected] = useState(initialCourseId ?? '');
  const courseId = selected || courses[0]?.id;
  if (!courseId) return <main className="content"><h1>考题预测</h1><p>请先添加科目并上传试卷。</p></main>;
  return <main className="content">
    <div className="intro"><h1>考题预测</h1><p>查看同科预测卷、生成进度和历史记录。</p></div>
    <section className="panel padded">
      <label>选择科目<select value={courseId} onChange={event => setSelected(event.target.value)}>
        {courses.map(course => <option key={course.id} value={course.id}>{course.name} · {course.term}</option>)}
      </select></label>
      <PredictionJob key={courseId} courseId={courseId} api={api} csrf={csrf} onOpen={onOpen} onExpired={onExpired} />
    </section>
  </main>;
}

function PredictionJob({ courseId, api, csrf, onOpen, onExpired }) {
  const [data, setData] = useState(null);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const path = '/courses/' + courseId + '/prediction';

  useEffect(() => {
    const controller = new AbortController();
    let timer;
    async function read() {
      try {
        const result = await api(path, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setData(result);
        setError('');
        if (result.enabled !== false) {
          const running = ['queued', 'processing'].includes(result.prediction?.status);
          timer = setTimeout(read, running ? 3000 : 10000);
        }
      } catch (failure) {
        if (controller.signal.aborted) return;
        if (failure.status === 401) onExpired();
        else setError(failure.message);
      }
    }
    read();
    return () => { clearTimeout(timer); controller.abort(); };
  }, [path, api, onExpired, revision]);

  async function generate() {
    setBusy(true);
    setError('');
    try {
      await api(path, { data: {}, csrf });
      setRevision(value => value + 1);
    } catch (failure) {
      if (failure.status === 401) onExpired();
      else setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  const status = data?.prediction?.status;
  const enoughEvidence = (data?.targetQuestions ?? 0) >= (data?.minimumPaperQuestions ?? 5);
  const running = status === 'queued' || status === 'processing';
  return <div className="pc-fields">
    <details open>
      <summary>预测卷怎么出题</summary>
      <p>从同科已识别的原卷中筛选题面完整的题目，去除重复题和仅改数字的变体，优先覆盖原卷已有题型。模型根据原题考点生成新题，再独立复算答案并校验题意、解析和来源。每套 5 至 12 道，练习交卷后可查看逐题出题依据。</p>
    </details>
    {data?.enabled === false && <p role="status">预测卷生成尚未开放。已生成的练习仍可查看。</p>}
    {data && <p>可用来源题 {data.available} 道，来自 {data.sourcePapers ?? 0} 份原卷。
      {data.enabled && (enoughEvidence ? ' 本套计划生成 ' + data.targetQuestions + ' 道题。' : ' 自动生成至少需要 ' + (data.minimumPaperQuestions ?? 5) + ' 道可用且不重复的来源题。可继续上传同科试卷。')}</p>}
    {data?.enabled && data.waitingForPapers && <p role="status">正在识别同科试卷，完成后自动生成预测卷。</p>}
    {data?.enabled && !status && enoughEvidence && !data.waitingForPapers && <p role="status">符合条件的新上传试卷识别完毕后会自动生成预测卷。已有试卷也可手动生成。</p>}
    {status && <p role="status">{labels[status]}
      {status === 'failed' && '。' + (failureLabels[data.prediction.failure] ?? '请稍后重试。')}</p>}
    {error && <div role="alert">{error} <button onClick={() => setRevision(value => value + 1)}>重新读取</button></div>}
    {status === 'ready' && <p>可直接在本页作答，交卷后查看参考答案、解析和出题依据。</p>}
    {status === 'ready' && data.prediction.schoolReused && <p className="pc-status" role="status">已复用同校整套预测卷</p>}
    {status === 'ready' ? <Attempt key={data.prediction.paperId} paperId={data.prediction.paperId}
      api={api} csrf={csrf} onExpired={onExpired} embedded />
      : !running && data?.enabled && enoughEvidence && !data.waitingForPapers &&
        <button className="primary" disabled={busy} onClick={generate}>
        {status === 'failed' ? '重试生成' : status === 'superseded' ? '按新题目重新生成' : '生成预测卷'}
      </button>}
    {(data?.previousPaperId || (status === 'superseded' && data.prediction.paperId)) &&
      <button onClick={() => onOpen(data.previousPaperId || data.prediction.paperId)}>查看上一版预测卷</button>}
    {data?.history?.length > 0 && <details><summary>历史预测卷</summary>
      <ul>{data.history.map(paper => <li key={paper.paperId}>
        <button type="button" onClick={() => onOpen(paper.paperId)}>
          {new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(paper.createdAt))}
          {' · ' + paper.questionCount + ' 道'}
        </button>
      </li>)}</ul>
    </details>}
  </div>;
}
