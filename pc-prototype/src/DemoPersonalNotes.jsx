import React from 'react';
import { showPersonalNotes } from './demo-paper-assignment.js';

export function DemoPersonalNotes({ question, notes, onSave }) {
  if (!showPersonalNotes(question)) return null;
  return <details className="prototype-notes"><summary>个人答案与解析</summary>
    <form className="form" onSubmit={event => onSave(event, question)}>
      <label>个人答案<textarea name="answer" defaultValue={notes?.answer ?? ''} /></label>
      <label>个人解析<textarea name="explanation" defaultValue={notes?.explanation ?? ''} /></label>
      <button type="submit">保存个人记录</button>
    </form>
  </details>;
}
