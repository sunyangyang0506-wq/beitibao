import type { PoolClient } from 'pg';
import { schoolOf, setTenant, subjectKey } from './school-identity.js';
import { reuseDigest } from './school-paper-reuse.js';
import { predictionSources } from './prediction-access.js';
import { minimumPaperQuestions, predictionBlueprint, predictionModel, predictionVersion, validatePrediction,
  type Evidence, type Predicted } from './prediction-model.js';

type PredictionInput = { evidence: Evidence[]; version: string | null };
type SourceJob = { id: string; tenant_id: string; course_id: string; source_digest: string };
type IndexJob = SourceJob & { status: string; paper_id: string | null; busy: boolean };
type ReadInput = (db: PoolClient, tenant: string, course: string) => Promise<PredictionInput>;

async function schoolInput(db: PoolClient, tenant: string, courseId: string, evidence: Evidence[]) {
  if (predictionBlueprint(evidence).length < minimumPaperQuestions) return null;
  await setTenant(db, tenant);
  const material = await predictionSources(db, tenant, courseId);
  if (!material?.confirmed || !material.ready) return null;
  const school = await schoolOf(db, tenant);
  if (!school) return null;
  const { rows: [course] } = await db.query<{ name: string }>(
    'SELECT name FROM courses WHERE tenant_id=$1 AND id=$2', [tenant, courseId]);
  if (!course) return null;
  const subject = subjectKey(course.name);
  const { rows } = await db.query<{ id: string; school_content_key: string | null; authorized: boolean }>(`
    SELECT p.id,p.school_content_key, EXISTS (
      SELECT 1 FROM school_paper_index i
      JOIN papers original ON (original.tenant_id,original.id)=(i.tenant_id,i.paper_id)
        AND original.share_school_id=i.school_id AND original.school_content_key=i.content_key
        AND original.status='review' AND NOT original.missing_pages
      JOIN accounts author ON author.id=i.tenant_id AND author.school_id=i.school_id
      WHERE i.school_id=$3 AND i.subject_key=$4 AND i.content_key=p.school_content_key
        AND NOT EXISTS (SELECT 1 FROM paper_page_recognition r
          WHERE (r.tenant_id,r.paper_id)=(original.tenant_id,original.id) AND (r.reviewed_at IS NULL OR r.status <> 'review'))
    ) AS authorized
    FROM papers p WHERE p.tenant_id=$1 AND p.course_id=$2 AND NOT p.is_prediction AND p.status='review'
      AND (p.model_allowed OR p.school_reuse='exact') AND NOT p.missing_pages
      AND EXISTS (SELECT 1 FROM paper_questions q WHERE (q.tenant_id,q.paper_id)=(p.tenant_id,p.id))
      AND NOT EXISTS (SELECT 1 FROM paper_page_recognition r WHERE (r.tenant_id,r.paper_id)=(p.tenant_id,p.id) AND r.reviewed_at IS NULL)
  `, [tenant, courseId, school, subject]);
  if (rows.length !== material.paperIds.length || rows.some(row => !row.authorized || !row.school_content_key)) return null;
  const revised = await db.query(`SELECT 1 FROM paper_questions WHERE tenant_id=$1 AND paper_id=ANY($2::uuid[]) AND input_revision>1 LIMIT 1`, [tenant, rows.map(row => row.id)]);
  if (revised.rowCount) return null;
  const papers = new Map(rows.map(row => [row.id, row.school_content_key!]));
  const stableById = new Map<string, string>();
  for (const question of evidence) {
    const paper = papers.get(question.paperId);
    if (!paper) return null;
    stableById.set(question.id, reuseDigest([paper, question.page, question.kind, question.stem]));
  }
  const versions = [...new Set(papers.values())].sort();
  const keys = [...new Set(stableById.values())].sort();
  return { school, stableById, key: reuseDigest(['complete-paper-set-v1', school, subject, versions, keys, predictionModel, predictionVersion]) };
}

async function copyPrediction(db: PoolClient, origin: IndexJob, from: Map<string, string>, to: Map<string, string>, evidence: Evidence[]) {
  const targetByKey = new Map([...to].map(([id, key]) => [key, id]));
  const { rows } = await db.query<{ stem: string; question_kind: string; model_solution: {
    answer: string; explanation: string; rationale: string; knowledgePoints: string[]; designLogic?: string;
    model?: string; promptVersion?: string; evidence: Evidence[];
  } }>(`SELECT stem,question_kind,model_solution FROM paper_questions
    WHERE tenant_id=$1 AND paper_id=$2 AND solution_status='ready' ORDER BY created_at,id`, [origin.tenant_id, origin.paper_id]);
  if (rows.length !== predictionBlueprint(evidence).length) return null;
  const candidates: Predicted[] = [];
  for (const { stem, question_kind: kind, model_solution: solution } of rows) {
    if (solution?.promptVersion !== predictionVersion || !solution.knowledgePoints?.length || !solution.evidence?.length) return null;
    const sourceIds = solution.evidence.map(item => targetByKey.get(from.get(item.id) ?? ''));
    if (sourceIds.some(id => !id)) return null;
    candidates.push({ stem, kind, sourceIds: sourceIds as string[], answer: solution.answer,
      explanation: solution.explanation, rationale: solution.rationale, knowledgePoints: solution.knowledgePoints,
      designLogic: solution.designLogic, generator: solution.model });
  }
  try {
    return validatePrediction(candidates, evidence);
  } catch {
    return null;
  }
}

type Reuse = { state: 'private' | 'owner' | 'waiting' } | { state: 'copied'; questions: Predicted[] };

export async function claimSchoolPrediction(db: PoolClient, job: SourceJob, input: PredictionInput, readInput: ReadInput): Promise<Reuse> {
  const context = await schoolInput(db, job.tenant_id, job.course_id, input.evidence);
  if (!context) return { state: 'private' };
  const key = [context.school, context.key];
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 81110))', [context.key]);
  const { rows: [previous] } = await db.query<IndexJob>(`
    SELECT p.id,p.tenant_id,p.course_id,p.source_digest,p.status,p.paper_id,
      (p.status='processing' AND p.lease_until>now()) AS busy
    FROM school_prediction_index i JOIN predictions p ON (p.tenant_id,p.id)=(i.tenant_id,i.prediction_id)
    WHERE i.school_id=$1 AND i.input_key=$2
  `, key);
  if (previous?.id === job.id && previous.tenant_id === job.tenant_id) return { state: 'owner' };
  if (previous && (previous.status === 'ready' || previous.busy)) {
    await setTenant(db, previous.tenant_id);
    const current = await readInput(db, previous.tenant_id, previous.course_id);
    const origin = current.version === previous.source_digest
      ? await schoolInput(db, previous.tenant_id, previous.course_id, current.evidence) : null;
    const same = origin?.key === context.key;
    const copied = same && previous.status === 'ready' && previous.paper_id
      ? await copyPrediction(db, previous, origin.stableById, context.stableById, input.evidence) : null;
    await setTenant(db, job.tenant_id);
    if (copied) return { state: 'copied', questions: copied };
    if (same && previous.busy) return { state: 'waiting' };
  }

  await db.query('DELETE FROM school_prediction_index WHERE school_id=$1 AND input_key=$2', key);
  await db.query('INSERT INTO school_prediction_index (school_id,input_key,tenant_id,prediction_id) VALUES ($1,$2,$3,$4)',
    [...key, job.tenant_id, job.id]);
  return { state: 'owner' };
}
