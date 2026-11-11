export function assignmentMessage(paper) {
  const messages = {
    subject_limit: '已达学科上限，请联系管理员调整后重试。',
    ambiguous: '同名科目有多个教师或学期，暂未归属。',
    unknown: '卷面未提供可靠识别的科目。',
    duplicate: '已有相同试卷，暂未重复归属。'
  };
  return messages[paper.assignmentReason] ?? (paper.recognizedSubject
    ? '科目已识别，暂未完成自动归属。' : '科目待确认，请补充清晰、完整的卷面。');
}
