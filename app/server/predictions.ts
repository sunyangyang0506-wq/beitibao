import { isTerminalModelFailure } from './model-provider-errors.js';
import { knowledgeMetadata } from './knowledge.js';
import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { modelRequest } from './model-gateway.js';
import { asTenant, lockCourseMaterial, transaction } from './db.js';
import type { JobTarget } from './job-outbox.js';
import { claimSchoolPrediction } from './school-prediction-reuse.js';
import { setTenant } from './school-identity.js';
import { predictionSources, predictionUnlocked } from './prediction-access.js';
import { closedBookActive } from './practice.js';
import { generatePrediction, maxEvidenceLength, minimumPaperQuestions, predictionBlueprint, predictionModel, predictionVersion, validatePrediction,
  type Evidence, type Predicted, type PredictionCall } from './prediction-model.js';

export { generatePrediction } from './prediction-model.js';

type Job = { id: string; tenant_id: string; course_id: string; source_digest: string; evidence: Evidence[] };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function sources(db: Pool | PoolClient, tenant: string, course: string) {
  const { rows } = await db.query<Evidence & { version: string }>(`
    WITH source AS (
      SELECT DISTINCT ON (coalesce(p.school_content_key,p.id::text),q.page_number,q.fingerprint,q.question_kind,q.reference,q.visual_review)
        q.id,q.stem,q.question_kind,q.paper_id,p.title,q.page_number,q.reference,q.visual_review,q.fingerprint,
        coalesce(p.school_content_key,p.id::text) AS material_key
      FROM paper_questions q JOIN papers p ON (q.tenant_id, q.paper_id) = (p.tenant_id, p.id)
      WHERE q.tenant_id = $1 AND p.course_id = $2 AND NOT p.is_prediction AND p.status = 'review'
        AND (p.model_allowed OR p.school_reuse='exact') AND NOT p.missing_pages
        AND NOT EXISTS (
          SELECT 1 FROM paper_page_recognition r
          WHERE (r.tenant_id, r.paper_id) = (p.tenant_id, p.id) AND r.reviewed_at IS NULL
        )
        AND char_length(q.stem) <= $3 AND q.stem !~* $4
      ORDER BY coalesce(p.school_content_key,p.id::text),q.page_number,q.fingerprint,q.question_kind,q.reference,q.visual_review,
        p.created_at,p.id,q.id
    )
    SELECT id,stem,question_kind AS kind,paper_id AS "paperId",title,page_number AS page,
      md5(string_agg(id::text || ':' || question_kind || ':' || md5(stem) || ':' || md5(coalesce(reference::text, '')) || ':' || md5(coalesce(visual_review, '')), ',' )
        OVER (ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)) AS version
    FROM source
    ORDER BY row_number() OVER (PARTITION BY question_kind ORDER BY material_key,page_number,fingerprint,id),
      material_key,page_number,fingerprint,id LIMIT 30
  `, [tenant, course, maxEvidenceLength, '如下图|下图|见图|上图|如图|下表|下列图表|as shown|following figure|siguiente (grafo|árbol|figura)|muestra la figura']);
  return { evidence: rows.map(({ version, ...row }) => row),
    version: rows[0] ? digest([predictionModel, predictionVersion, rows[0].version]) : null };
}

// Callers hold the course material lock while capturing the evidence version.
export async function queueCoursePrediction(db: PoolClient, tenant: string, course: string, requireFullPaper = true) {
  await setTenant(db, tenant);
  const material = await predictionSources(db, tenant, course);
  if (!material?.confirmed || !material.ready) return null;
  const input = await sources(db, tenant, course);
  if (!input.version || (requireFullPaper && predictionBlueprint(input.evidence).length < minimumPaperQuestions)) return null;
  await db.query(`
    INSERT INTO predictions (tenant_id, course_id, source_digest, evidence) VALUES ($1,$2,$3,$4)
    ON CONFLICT DO NOTHING
  `, [tenant, course, input.version, JSON.stringify(input.evidence)]);
  return input.version;
}

const params = { type: 'object', required: ['courseId'], properties: { courseId: { type: 'string', format: 'uuid' } } };
const security = [{ session: [] }];

export function registerPredictionRoutes(app: FastifyInstance, pool: Pool, prefix: string, enabled = true, requireFullPaper = false) {
  const path = prefix + '/courses/:courseId/prediction';
  app.get<{ Params: { courseId: string } }>(path, { schema: { params, security } }, async (request, reply) => {
    const tenant = request.studySession!.id;
    const { courseId } = request.params;
    return asTenant(pool, tenant, async db => {
      const material = await predictionSources(db, tenant, courseId);
      if (!material) return reply.code(404).send({ code: 'COURSE_NOT_FOUND' });
      const unlocked = await predictionUnlocked(db, tenant, courseId);
      const access = { locked: !unlocked, sourcesConfirmed: material.confirmed, waitingForPapers: !material.ready };
      if (!unlocked) return { enabled, ...access, questions: [], prediction: null, history: [] };
      const input = await sources(db, tenant, courseId);
      const { rows: [latest] } = await db.query(`
        SELECT id, status, source_digest, paper_id AS "paperId", failure, school_reused AS "schoolReused",
          (SELECT count(*)::int FROM paper_questions q
           WHERE (q.tenant_id, q.paper_id) = (predictions.tenant_id, predictions.paper_id)) AS "questionCount"
        FROM predictions
        WHERE tenant_id = $1 AND course_id = $2 ORDER BY (source_digest = $3) DESC NULLS LAST, created_at DESC, id DESC LIMIT 1
      `, [tenant, courseId, input.version]);
      const { rows: history } = latest ? await db.query(`
        SELECT paper_id AS "paperId", created_at AS "createdAt",
          (SELECT count(*)::int FROM paper_questions q
           WHERE (q.tenant_id, q.paper_id) = (predictions.tenant_id, predictions.paper_id)) AS "questionCount"
        FROM predictions
        WHERE tenant_id = $1 AND course_id = $2 AND paper_id IS NOT NULL AND id <> $3
        ORDER BY created_at DESC, id DESC LIMIT 20
      `, [tenant, courseId, latest.id]) : { rows: [] };
      const ready = latest?.status === 'ready' && latest.source_digest === input.version && latest.paperId;
      const questions = ready && !await closedBookActive(db, tenant, latest.paperId)
        ? (await db.query(`
          SELECT id, stem, question_kind AS kind FROM paper_questions
          WHERE tenant_id = $1 AND paper_id = $2 ORDER BY created_at, id
        `, [tenant, latest.paperId])).rows : [];
      return { enabled, ...access, questions,
        targetQuestions: predictionBlueprint(input.evidence).length, minimumPaperQuestions, available: input.evidence.length, sourcePapers: new Set(input.evidence.map(item => item.paperId)).size,
        previousPaperId: latest?.paperId ? null : history[0]?.paperId ?? null, history, prediction: latest ? {
          id: latest.id, status: latest.source_digest === input.version ? latest.status : 'superseded',
          paperId: latest.paperId, failure: latest.failure, questionCount: latest.questionCount, schoolReused: latest.schoolReused
        } : null };

    });
  });
  app.post<{ Params: { courseId: string }; Body: { paperIds: string[] } }>(path + '/confirm-sources', {
    schema: { params, security, body: { type: 'object', additionalProperties: false, required: ['paperIds'], properties: {
      paperIds: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', format: 'uuid' } }
    } } }
  }, async (request, reply) => {
    const tenant = request.studySession!.id;
    const { courseId } = request.params;
    const result = await asTenant(pool, tenant, async db => {
      await lockCourseMaterial(db, tenant, courseId);
      const material = await predictionSources(db, tenant, courseId);
      if (!material) return 'COURSE_NOT_FOUND';
      const confirmed = [...new Set(request.body.paperIds.map(id => id.toLowerCase()))].sort();
      if (JSON.stringify(confirmed) !== JSON.stringify(material.paperIds)) return 'PREDICTION_SOURCES_CHANGED';
      await db.query('UPDATE courses SET prediction_source_papers = $3 WHERE tenant_id = $1 AND id = $2',
        [tenant, courseId, confirmed]);
      const version = enabled ? await queueCoursePrediction(db, tenant, courseId, requireFullPaper) : null;
      if (version) await db.query(`UPDATE predictions SET status = 'queued'
        WHERE tenant_id = $1 AND course_id = $2 AND source_digest = $3 AND status = 'superseded'`, [tenant, courseId, version]);
      return { sourcesConfirmed: true, waitingForPapers: !material.ready };
    });
    return typeof result === 'string' ? reply.code(result === 'COURSE_NOT_FOUND' ? 404 : 409).send({ code: result }) : result;
  });
  app.post<{ Params: { courseId: string } }>(path, { schema: { params, security } }, async (request, reply) => {
    if (!enabled) return reply.code(409).send({ code: 'PREDICTION_NOT_RELEASED' });
    const tenant = request.studySession!.id;
    const { courseId } = request.params;
    const prediction = await asTenant(pool, tenant, async db => {
      await lockCourseMaterial(db, tenant, courseId);
      const material = await predictionSources(db, tenant, courseId);
      if (!material) return { error: 'COURSE_NOT_FOUND' };
      if (!material.confirmed) return { error: 'PREDICTION_SOURCES_UNCONFIRMED' };
      const version = await queueCoursePrediction(db, tenant, courseId, requireFullPaper);
      if (!version) return null;
      const key = [tenant, courseId, version];
      await db.query("UPDATE predictions SET status = 'queued' WHERE tenant_id = $1 AND course_id = $2 AND source_digest = $3 AND status IN ('failed', 'superseded')", key);
      const { rows: [job] } = await db.query(`
        SELECT id, status, paper_id AS "paperId" FROM predictions
        WHERE tenant_id = $1 AND course_id = $2 AND source_digest = $3
      `, key);
      return job;
    });
    if (prediction && 'error' in prediction) return reply.code(prediction.error === 'COURSE_NOT_FOUND' ? 404 : 409).send({ code: prediction.error });
    return prediction ?? reply.code(409).send({ code: 'PREDICTION_NO_EVIDENCE' });
  });
}

export async function processNextPrediction(pool: Pool, generate?: (evidence: Evidence[]) => Promise<Predicted[]>, target?: JobTarget) {
  const lease = randomUUID();
  const { rows: [job] } = await pool.query<Job>(`
    WITH next AS (
      SELECT tenant_id,id FROM predictions WHERE (status = 'queued'
        OR (status = 'processing' AND lease_until <= now()))
        AND ($2::uuid IS NULL OR (tenant_id, id) = ($2, $3::uuid))
      ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
    )
    UPDATE predictions p SET status = 'processing', lease = $1, lease_until = now() + interval '18 minutes', failure = NULL
    FROM next WHERE (p.tenant_id,p.id) = (next.tenant_id,next.id)
    RETURNING p.id,p.tenant_id,p.course_id,p.source_digest,p.evidence
  `, [lease, target?.tenant ?? null, target?.id ?? null]);
  if (!job) return false;

  const calls: PredictionCall[] = [];
  let questions: Predicted[] | null = null;
  let failure: string | null = null;
  let schoolReused = false;
  const input = await asTenant(pool, job.tenant_id, async db => {
    await lockCourseMaterial(db, job.tenant_id, job.course_id);
    const material = await predictionSources(db, job.tenant_id, job.course_id);
    return material?.confirmed && material.ready ? sources(db, job.tenant_id, job.course_id) : { version: null, evidence: [] };
  });
  const reuse = input.version === job.source_digest
    ? await transaction(pool, db => claimSchoolPrediction(db, job, input, sources))
    : { state: 'private' as const };
  if (reuse.state === 'waiting') {
    await pool.query(`
      UPDATE predictions SET lease=NULL, lease_until=now() + interval '5 seconds'
      WHERE tenant_id=$1 AND id=$2 AND lease=$3
    `, [job.tenant_id, job.id, lease]);
    return true;
  }
  if (reuse.state === 'copied') {
    questions = reuse.questions;
    schoolReused = true;
  } else if (input.version === job.source_digest) {
    try {
      questions = validatePrediction(await (generate ? generate(job.evidence) :
        generatePrediction(job.evidence, modelRequest(pool, job.tenant_id, 'prediction'), call => calls.push(call))), job.evidence);
      if (reuse.state === 'owner' && questions.length !== predictionBlueprint(job.evidence).length) {
        throw new Error('PREDICTION_VERIFICATION_FAILED');
      }
    } catch (error) {
      questions = null;
      const code = error instanceof Error ? error.message : '';
      failure = isTerminalModelFailure(code) || ['INVALID_PREDICTION', 'PREDICTION_VERIFICATION_FAILED', 'MODEL_BUDGET_LIMIT', 'MODEL_RATE_LIMIT',
        'PREDICTION_RATE_LIMITED', 'PREDICTION_TIMEOUT', 'MODEL_NOT_CONFIGURED'].includes(code)
        ? code : 'PREDICTION_REQUEST_FAILED';
    }
  }

  await transaction(pool, async db => {
    await setTenant(db, job.tenant_id);
    await lockCourseMaterial(db, job.tenant_id, job.course_id);
    const key = [job.tenant_id, job.id, lease];
    const current = await db.query('SELECT 1 FROM predictions WHERE tenant_id=$1 AND id=$2 AND lease=$3 FOR UPDATE', key);
    if (!current.rowCount) return;
    const input = await sources(db, job.tenant_id, job.course_id);
    const material = await predictionSources(db, job.tenant_id, job.course_id);
    const stale = input.version !== job.source_digest || !material?.confirmed || !material.ready;
    if (schoolReused && !stale) {
      const confirmed = await claimSchoolPrediction(db, job, input, sources);
      if (confirmed.state !== 'copied') {
        await db.query("UPDATE predictions SET status='queued', lease=NULL, lease_until=NULL WHERE tenant_id=$1 AND id=$2 AND lease=$3", key);
        return;
      }
      questions = confirmed.questions;
    }
    if (!questions || stale) {
      await db.query(`UPDATE predictions SET status=$4, failure=$5, model_calls=model_calls || $6::jsonb,
        lease=NULL, lease_until=NULL WHERE tenant_id=$1 AND id=$2 AND lease=$3`,
        [...key, stale ? 'superseded' : 'failed', stale ? null : failure, JSON.stringify(calls)]);
      return;
    }
    const { rows: [paper] } = await db.query(`
      INSERT INTO papers (tenant_id,course_id,title,fingerprint,pdf,status,pages,is_prediction)
      VALUES ($1,$2,'考题预测卷',$3,''::bytea,'review','[]',true) RETURNING id
    `, [job.tenant_id, job.course_id, 'prediction:' + job.id]);
    for (const [index, question] of questions.entries()) {
      const linked = job.evidence.filter(item => question.sourceIds.includes(item.id));
      await db.query(`
        INSERT INTO paper_questions (tenant_id,paper_id,page_number,fingerprint,stem,question_kind,solution_status,model_solution,created_at)
        VALUES ($1,$2,1,$3,$4,$5,'ready',$6,transaction_timestamp() + $7::int * interval '1 microsecond')
      `, [job.tenant_id, paper.id, digest(question.stem), question.stem, question.kind, JSON.stringify({
        model: question.generator ?? predictionModel, promptVersion: predictionVersion, status: 'solved', answer: question.answer,
        explanation: question.explanation, ...knowledgeMetadata(question), rationale: question.rationale, evidence: linked
      }), index]);
    }
    await db.query(`UPDATE predictions SET status='ready', paper_id=$4, model_calls=model_calls || $5::jsonb, school_reused=$6,
      lease=NULL, lease_until=NULL WHERE tenant_id=$1 AND id=$2 AND lease=$3`,
      [...key, paper.id, JSON.stringify(calls), schoolReused]);
  });
  return true;
}
