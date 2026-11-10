import React, { useEffect, useRef } from 'react';
import renderMathInElement from 'katex/contrib/auto-render';
import 'katex/dist/katex.min.css';

const delimiters = [
  { left: '$$', right: '$$', display: true },
  { left: '\\[', right: '\\]', display: true },
  { left: '\\(', right: '\\)', display: false },
  { left: '$', right: '$', display: false },
];

export function PaperText({ text }) {
  const ref = useRef(null);
  useEffect(() => {
    const element = ref.current;
    element.textContent = text ?? '';
    renderMathInElement(element, { delimiters, trust: false, maxExpand: 250, maxSize: 20 });
  }, [text]);
  return <div ref={ref} className="pc-confirmed-stem pc-formatted-paper-text" />;
}
