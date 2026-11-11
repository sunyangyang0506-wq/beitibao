import type { Pool } from 'pg';
import { asTenant } from './db.js';
import { lockSubjectCreation } from './subject-assignment.js';

export type CourseInput = { name: string; term: string; teacher?: string };
type Course = Required<CourseInput> & { id: string };

function normalize(value: string) {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

export async function saveCourse(pool: Pool, tenantId: string, input: CourseInput) {
  const name = normalize(input.name);
  const teacher = normalize(input.teacher ?? '');
  const term = normalize(input.term);
  if (!name || !term || [...name].length > 100 || [...teacher].length > 100 || [...term].length > 80
      || [name, teacher, term].some((value) => value.includes('\u0000'))) return null;

  return asTenant(pool, tenantId, async (db) => {
    await lockSubjectCreation(db, tenantId);
    const { rows: [account] } = await db.query<{ subject_limit: number | null }>(
      'SELECT subject_limit FROM accounts WHERE id = $1 FOR UPDATE', [tenantId]);
    if (!account) return null;
    if (account.subject_limit !== null) {
      const { rows: [usage] } = await db.query<{ count: number; existing: boolean }>(`
        SELECT count(DISTINCT lower(name))::int AS count,
          coalesce(bool_or(lower(name) = lower($2)), false) AS existing
        FROM courses WHERE tenant_id = $1
      `, [tenantId, name]);
      if (!usage!.existing && usage!.count >= account.subject_limit) return { limitReached: account.subject_limit };
    }
    const values = [tenantId, name, teacher, term];
    const inserted = await db.query<Course>(`
      INSERT INTO courses (tenant_id, name, teacher, term) VALUES ($1, $2, $3, $4)
      ON CONFLICT (tenant_id, name, teacher, term) DO NOTHING RETURNING id, name, teacher, term
    `, values);
    if (inserted.rows[0]) return { course: inserted.rows[0], reused: false };
    const existing = await db.query<Course>(`
      SELECT id, name, teacher, term FROM courses
      WHERE tenant_id = $1 AND name = $2 AND teacher = $3 AND term = $4
    `, values);
    return { course: existing.rows[0]!, reused: true };
  });
}

export function getProgress(pool: Pool, tenantId: string) {
  return asTenant(pool, tenantId, async (db) => {
    const { rows } = await db.query<Course & { totalPapers: number; completedPapers: number }>(`
      SELECT c.id, c.name, c.teacher, c.term,
        to_char(c.exam_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD"T"HH24:MI') AS "examAt",
        (SELECT a.paper_id FROM practice_attempts a
          JOIN papers draft ON (draft.tenant_id, draft.id) = (a.tenant_id, a.paper_id)
          WHERE a.tenant_id = c.tenant_id AND draft.course_id = c.id AND NOT draft.is_prediction
            AND a.submitted_at IS NULL AND (a.deadline_at IS NULL OR a.deadline_at > now())
          ORDER BY a.revision DESC, a.paper_id LIMIT 1) AS "draftPaperId",
        progress.total_papers AS "totalPapers", progress.completed_papers AS "completedPapers"
      FROM courses c
      JOIN course_learning_progress progress ON (progress.tenant_id, progress.course_id) = (c.tenant_id, c.id)
      WHERE c.tenant_id = $1 ORDER BY c.created_at DESC, c.id
    `, [tenantId]);
    const courses = rows.map((course) => ({
      ...course,
      status: !course.totalPapers ? 'awaiting_upload'
        : course.completedPapers === course.totalPapers ? 'completed' : 'awaiting_review',
      remainingPapers: course.totalPapers - course.completedPapers
    }));
    const completed = courses.filter(course => course.status === 'completed').length;
    return { total: courses.length, completed, incomplete: courses.length - completed, courses };
  });
}

export function saveExamTime(pool: Pool, tenantId: string, courseId: string, examAt: string | null) {
  return asTenant(pool, tenantId, async (db) => {
    const { rows: [course] } = await db.query(`
      UPDATE courses SET exam_at = $3::timestamp AT TIME ZONE 'Asia/Shanghai'
      WHERE tenant_id = $1 AND id = $2
      RETURNING id, to_char(exam_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD"T"HH24:MI') AS "examAt"
    `, [tenantId, courseId, examAt]);
    return course;
  });
}
