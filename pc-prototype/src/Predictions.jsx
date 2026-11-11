import { predictionFailureMessage } from './prediction-failure.js';
import React, { useEffect, useState } from 'react';
import { Attempt } from './Practice.jsx';

const labels = {
  queued: '等待生成', processing: '正在生成', ready: '可练习', failed: '生成失败', superseded: '源题已更新'
};



export function Predictions({ initialCourseId, courses, api, csrf, onOpen, onExpired, onPractice, onLibrary }) {
  const [selected, setSelected] = useState(initialCourseId ?? '');
  const courseId = selected || courses[0]?.id;
  if (!courseId) return <main className="content"><h1>考题预测</h1><p>请先添加科目并上传试卷。</p></main>;
  return <main className="content">
    <div className="intro"><h1>考题预测</h1><p>学完本科目全部原卷后解锁预测卷。</p></div>
    <section className="panel padded">
      <label>选择科目<select value={courseId} onChange={event => setSelected(event.target.value)}>
        {courses.map(course => <option key={course.id} value={course.id}>{course.name} · {course.term}</option>)}
      </select></label>
      <p>原卷传齐并确认后，系统自动准备预测卷。同校、同科且完整原卷内容一致的学员共用一套预测卷，各自完成学习后解锁。</p>
      <PredictionJob key={courseId} courseId={courseId} api={api} csrf={csrf} onOpen={onOpen} onExpired={onExpired}
        onPractice={onPractice} onLibrary={onLibrary} />
    </section>
  </main>;
}

function PredictionJob({ courseId, api, csrf, onOpen, onExpired, onPractice, onLibrary }) {
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
  if (data?.locked) return <div className="pc-status" role="status">
    <h2>学完整科后解锁</h2>
    <p>请完成本科目全部原卷的作答或背诵自评，预测卷会在完成后展示。</p>
    <button type="button" onClick={() => onPractice(courseId)}>继续学习本科目</button>
    {!data.sourcesConfirmed && <><p>本科目原卷尚未确认传齐。</p>
      <button type="button" onClick={() => onLibrary(courseId)}>前往试卷库确认</button></>}
  </div>;
  return <div className="pc-fields">
    {!data && !error && <p role="status">正在读取预测状态…</p>}
    <details open>
      <summary>预测卷怎么出题</summary>
      <p>从同科已识别的原卷中筛选题面完整的题目，去除重复题和仅改数字的变体，优先覆盖原卷已有题型。模型根据原题考点生成新题，再独立复算答案并校验题意、解析和来源。每套 5 至 12 道，练习交卷后可查看逐题出题依据。</p>
    </details>
    {data?.enabled === false && <p role="status">预测卷生成尚未开放。已生成的练习仍可查看。</p>}
    {data && <p>可用来源题 {data.available} 道，来自 {data.sourcePapers ?? 0} 份原卷。
      {data.enabled && (enoughEvidence ? ' 本套计划生成 ' + data.targetQuestions + ' 道题。' : ' 自动生成至少需要 ' + (data.minimumPaperQuestions ?? 5) + ' 道可用且不重复的来源题。可继续上传同科试卷。')}</p>}
    {data && !data.sourcesConfirmed && <div className="pc-status"><p>请确认本科目的全部原卷已传齐，系统将自动准备预测卷。</p>
      <button type="button" onClick={() => onLibrary(courseId)}>前往试卷库确认</button></div>}
    {data?.enabled && data.sourcesConfirmed && data.waitingForPapers && <p role="status">正在处理已确认的全部原卷，完成后自动生成预测卷。</p>}
    {status && <p role="status">{labels[status]}
      {status === 'failed' && '。' + predictionFailureMessage(data.prediction.failure)}</p>}
    {error && <div role="alert">{error} <button onClick={() => setRevision(value => value + 1)}>重新读取</button></div>}
    {status === 'ready' && <p>可直接在本页作答，交卷后查看参考答案、解析和出题依据。</p>}
    {status === 'ready' && data.prediction.schoolReused && <p className="pc-status" role="status">已复用同校整套预测卷</p>}
    {status === 'ready' ? <Attempt key={data.prediction.paperId} paperId={data.prediction.paperId}
      api={api} csrf={csrf} onExpired={onExpired} embedded />
      : !running && data?.enabled && data.sourcesConfirmed && enoughEvidence && !data.waitingForPapers &&
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
