export const normalizeSubject = value => value.normalize('NFKC').replace(/\s+/gu, '').toLowerCase();

export function assignDemoSubject(courses, subject, limit, createId) {
  if (!subject) return { reason: 'unknown' };
  const candidates = courses.filter(course => normalizeSubject(course.name) === normalizeSubject(subject));
  if (candidates.length === 1) return { course: candidates[0], reason: 'assigned' };
  if (candidates.length > 1) return { reason: 'ambiguous' };
  if (new Set(courses.map(course => normalizeSubject(course.name))).size >= limit) return { reason: 'subject_limit' };
  return { reason: 'assigned', created: true,
    course: { id: createId(), name: subject, teacher: '', term: '学期待确认', papers: [], prediction: null } };
}

export const showPersonalNotes = question => question.type
  ? !['单选题', '多选题', '选择题'].includes(question.type) : !question.options?.length;
