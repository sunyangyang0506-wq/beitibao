import type { Pool } from 'pg';
import { asTenant } from './db.js';

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
      WITH covered AS (
        SELECT DISTINCT coalesce(e.anchor_id, q.id) AS id
        FROM paper_questions q
        JOIN papers p ON (q.tenant_id, q.paper_id) = (p.tenant_id, p.id) AND NOT p.is_prediction
        LEFT JOIN current_question_equivalence e ON (e.tenant_id, e.member_id) = (q.tenant_id, q.id)
        LEFT JOIN practice_results settled ON (settled.tenant_id, settled.paper_id) = (q.tenant_id, q.paper_id)
        LEFT JOIN practice_attempts a ON (a.tenant_id, a.paper_id) = (q.tenant_id, q.paper_id)
        LEFT JOIN question_recall r ON (r.tenant_id, r.question_id) = (q.tenant_id, q.id)
        WHERE q.tenant_id = $1 AND (r.self_rating IS NOT NULL OR CASE WHEN settled.paper_id IS NOT NULL THEN q.id = ANY(settled.covered)
          ELSE a.submitted_at IS NOT NULL AND coalesce(a.answers ->> q.id::text, '') ~ '[^[:space:]]' END)
      )
      SELECT c.id, c.name, c.teacher, c.term,
        to_char(c.exam_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD"T"HH24:MI') AS "examAt",
        (SELECT a.paper_id FROM practice_attempts a
          JOIN papers draft ON (draft.tenant_id, draft.id) = (a.tenant_id, a.paper_id)
          WHERE a.tenant_id = c.tenant_id AND draft.course_id = c.id AND NOT draft.is_prediction
            AND a.submitted_at IS NULL AND (a.deadline_at IS NULL OR a.deadline_at > now())
          ORDER BY a.revision DESC, a.paper_id LIMIT 1) AS "draftPaperId",
        count(p.id)::int AS "totalPapers",
        count(p.id) FILTER (WHERE p.status = 'review' AND NOT p.missing_pages AND NOT EXISTS (
          SELECT 1 FROM paper_page_recognition r WHERE (r.tenant_id, r.paper_id) = (p.tenant_id, p.id) AND r.reviewed_at IS NULL
        ) AND EXISTS (
          SELECT 1 FROM paper_questions q WHERE q.tenant_id = p.tenant_id AND q.paper_id = p.id
        ) AND NOT EXISTS (
          SELECT 1 FROM paper_questions q
          LEFT JOIN current_question_equivalence e ON (e.tenant_id, e.member_id) = (q.tenant_id, q.id)
          LEFT JOIN covered done ON done.id = coalesce(e.anchor_id, q.id)
          WHERE q.tenant_id = p.tenant_id AND q.paper_id = p.id
            AND done.id IS NULL
        ))::int AS "completedPapers"
      FROM courses c
      LEFT JOIN papers p ON (p.tenant_id, p.course_id) = (c.tenant_id, c.id) AND NOT p.is_prediction
      WHERE c.tenant_id = $1 GROUP BY c.tenant_id, c.id ORDER BY c.created_at DESC, c.id
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
