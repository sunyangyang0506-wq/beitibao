import type { PoolClient } from 'pg';
import { lockCourseMaterial } from './db.js';
import { refreshPracticeResults } from './practice-results.js';
import { queueCoursePrediction } from './predictions.js';

export function stemKey(value: string) {
  return value.replace(/\r\n?/gu, '\n').trim();
}

export async function reviseQuestion(db: PoolClient, tenant: string, paperId: string, questionId: string, stem: string, modelsEnabled: boolean, expectedRevision: number) {
  const { rows: [paper] } = await db.query<{ course_id: string | null; model_allowed: boolean }>(
    'SELECT course_id, model_allowed FROM papers WHERE tenant_id=$1 AND id=$2', [tenant, paperId]);
  if (!paper) return null;
  if (paper.course_id) await lockCourseMaterial(db, tenant, paper.course_id);
  await db.query('SELECT 1 FROM papers WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [tenant, paperId]);
  const { rows: [question] } = await db.query<{ stem: string; input_revision: number; stem_correction: string | null }>(
    `SELECT q.stem,q.input_revision,r.stem_correction FROM paper_questions q LEFT JOIN question_recall r ON (r.tenant_id,r.question_id)=(q.tenant_id,q.id) WHERE q.tenant_id=$1 AND q.paper_id=$2 AND q.id=$3 AND NOT q.figure_review_blocked FOR UPDATE OF q`, [tenant, paperId, questionId]);
  if (!question) return null;
  if (question.input_revision !== expectedRevision) return { conflict: true as const };
  if (stemKey(stem) === stemKey(question.stem)) return { stemCorrection: question.stem_correction, inputRevision: question.input_revision, changed: false };
  // Lock the active attempt before its result, matching submission and restart order.
  await db.query('SELECT 1 FROM practice_attempts WHERE tenant_id=$1 AND paper_id=$2 FOR UPDATE', [tenant, paperId]);
  await refreshPracticeResults(db, tenant, { paperId });
  await db.query(`
    INSERT INTO question_revision_history (tenant_id, question_id, input_revision, question, recall)
    SELECT q.tenant_id, q.id, q.input_revision, to_jsonb(q), to_jsonb(r)
    FROM paper_questions q LEFT JOIN question_recall r ON (r.tenant_id,r.question_id)=(q.tenant_id,q.id)
    WHERE q.tenant_id=$1 AND q.id=$2
  `, [tenant, questionId]);
  // Revoke the lease before queuing the new input. An old worker's CAS cannot publish.
  await db.query(`
    UPDATE paper_questions SET stem=$3, input_revision=input_revision+1, reference=NULL,
      model_solution=NULL, solution_status=NULL, solution_lease=NULL, solution_lease_until=NULL,
      solution_failure=NULL, solution_finished_at=NULL, solution_attempt_count=0, standalone_solution=false
    WHERE tenant_id=$1 AND id=$2
  `, [tenant, questionId, stem]);
  await db.query(`
    INSERT INTO question_recall (tenant_id,question_id,stem_correction) VALUES ($1,$2,$3)
    ON CONFLICT (tenant_id,question_id) DO UPDATE SET stem_correction=excluded.stem_correction,
      revealed=false, self_rating=NULL, assessed_revision=NULL, correction=NULL
  `, [tenant, questionId, stem]);
  await db.query(`UPDATE question_equivalence SET revoked_at=coalesce(revoked_at,now())
    WHERE tenant_id=$1 AND (anchor_id=$2 OR member_id=$2) AND revoked_at IS NULL`, [tenant, questionId]);
  if (modelsEnabled && paper.model_allowed) {
    await db.query("UPDATE paper_questions SET solution_status='queued' WHERE tenant_id=$1 AND id=$2", [tenant, questionId]);
    if (paper.course_id) await queueCoursePrediction(db, tenant, paper.course_id);
  }
  return { stemCorrection: stem, inputRevision: question.input_revision + 1, changed: true };
}
