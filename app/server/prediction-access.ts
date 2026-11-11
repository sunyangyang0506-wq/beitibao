import type { PoolClient } from 'pg';
import { lockCourseMaterial } from './db.js';

export async function lockPredictionSourceCourse(db: PoolClient, tenant: string, paperId: string) {
  const { rows: [paper] } = await db.query<{ course_id: string | null }>(
    'SELECT course_id FROM papers WHERE tenant_id = $1 AND id = $2 AND NOT is_prediction', [tenant, paperId]);
  if (paper?.course_id) await lockCourseMaterial(db, tenant, paper.course_id);
  return paper?.course_id ?? null;
}

export async function predictionSources(db: PoolClient, tenant: string, courseId: string) {
  const { rows: [course] } = await db.query<{ paperIds: string[]; confirmed: boolean; ready: boolean }>(`
    SELECT material.ids AS "paperIds",
      coalesce(c.prediction_source_papers = material.ids AND cardinality(material.ids) > 0, false) AS confirmed,
      coalesce(material.ready, false) AS ready
    FROM courses c
    CROSS JOIN LATERAL (
      SELECT coalesce(array_agg(p.id ORDER BY p.id), '{}'::uuid[]) AS ids,
        bool_and(p.status = 'review' AND NOT p.missing_pages AND EXISTS (
          SELECT 1 FROM paper_questions q WHERE (q.tenant_id,q.paper_id) = (p.tenant_id,p.id) AND NOT q.figure_review_blocked
        ) AND NOT EXISTS (
          SELECT 1 FROM paper_page_recognition r
          WHERE (r.tenant_id,r.paper_id) = (p.tenant_id,p.id) AND r.reviewed_at IS NULL
        )) AS ready
      FROM papers p WHERE p.tenant_id = c.tenant_id AND p.course_id = c.id AND NOT p.is_prediction
    ) material
    WHERE c.tenant_id = $1 AND c.id = $2
  `, [tenant, courseId]);
  return course ?? null;
}

export async function predictionUnlocked(db: PoolClient, tenant: string, courseId: string) {
  const { rows: [progress] } = await db.query<{ unlocked: boolean }>(`
    SELECT total_papers > 0 AND completed_papers = total_papers AS unlocked
    FROM course_learning_progress WHERE tenant_id = $1 AND course_id = $2
  `, [tenant, courseId]);
  return progress?.unlocked ?? false;
}
