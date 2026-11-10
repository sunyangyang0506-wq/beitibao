import React from 'react';

export function KnowledgePoints({ points }) {
  return <div>
    <strong>知识点</strong>
    {points?.length ? <ul>{points.map(point => <li key={point}>{point}</li>)}</ul> : <p>暂无知识点标注。</p>}
  </div>;
}

export function KnowledgeNetwork({ network, prediction, onQuestion }) {
  if (!network) return null;
  return <section className="panel padded pc-review-title">
    <h2>{prediction ? '预测卷知识网与预测逻辑' : '整卷知识网与出题逻辑'}</h2>
    {network.nodes.length ? <>
      <p>知识点覆盖 {network.nodes.length} 项。连线表示知识点在同一道题中出现。</p>
      <div className="pc-knowledge-nodes">
        {network.nodes.map(node => <div key={node.label} className="badge">
          {node.label} · {node.questions.map(number => onQuestion ? <button key={number} type="button" onClick={() => onQuestion(number)}>第 {number} 题</button> : <span key={number}>第 {number} 题 </span>)}
        </div>)}
      </div>
      {network.edges.length > 0 && <ul>{network.edges.map(edge => <li key={JSON.stringify([edge.from, edge.to])}>
        {edge.from} ↔ {edge.to} · 第 {edge.questions.join('、')} 题
      </li>)}</ul>}
    </> : <p>暂无可组成知识网的标注。</p>}
    <h3>{prediction ? '预测逻辑' : '出题逻辑（根据题面推断）'}</h3>
    {network.questionLogic.length ? <ul>{network.questionLogic.map(item => <li key={item.number}>
      第 {item.number} 题 · {item.text}
    </li>)}</ul> : <p>暂无可展示的逻辑分析。</p>}
  </section>;
}
