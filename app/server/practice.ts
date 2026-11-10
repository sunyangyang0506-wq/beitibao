import { buildKnowledgeNetwork } from './knowledge.js';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { gradePracticeAnswer, type ModelGradingSolution, type QuestionReference } from './question-reference.js';
import { asTenant, transaction } from './db.js';

type DraftState = { marked: string[]; position: string | null };

type Attempt = {
  title: string;
  questions: { id: string; stem: string; pageNumber: number; kind?: string; sourcePages?: number[]; visualReview?: string | null; reference?: QuestionReference | null }[];
  answers: Record<string, string>;
  revision: number;
  draft: DraftState;
  submittedAt: string | null;
  deadlineAt: string | null;
};
type SolutionSnapshot = {
  stem: string;
  visual_review: string | null;
  model_solution: (ModelGradingSolution & NonNullable<Parameters<typeof buildKnowledgeNetwork>[0][number]['modelSolution']>) | null;
  solution_status: string | null;
};
type CurrentSolution = SolutionSnapshot & { id: string; reference: QuestionReference | null; correction: unknown; stem_correction: string | null };
type Grades = Record<string, ReturnType<typeof gradePracticeAnswer>>;

function gradeQuestion(attempt: Attempt, question: Attempt['questions'][number], snapshot?: SolutionSnapshot) {
  return gradePracticeAnswer(attempt.answers[question.id], question.reference, question.kind, question.stem, snapshot?.model_solution);
}

async function presentAttempt(attempt: Attempt, pool: Pool, tenant: string, paperId: string) {
  const solutions = new Map<string, CurrentSolution>();
  const corrections = new Map<string, string>();
  let snapshots: Record<string, SolutionSnapshot> | null = null;
  let grades: Grades | undefined;
  if (attempt.submittedAt) {
    const key = [tenant, paperId];
    const read = await asTenant(pool, tenant, async db => {
      const { rows: [saved] } = await db.query<{ graded: Grades; solution_snapshots: Record<string, SolutionSnapshot> | null }>(
        'SELECT graded, solution_snapshots FROM practice_results WHERE tenant_id = $1 AND paper_id = $2 FOR UPDATE', key);
      const { rows } = await db.query<CurrentSolution>(`
      SELECT q.id, q.stem, q.visual_review, q.reference, q.model_solution, q.solution_status, r.correction, r.stem_correction FROM paper_questions q
      LEFT JOIN question_recall r ON (r.tenant_id, r.question_id) = (q.tenant_id, q.id)
      WHERE q.tenant_id = $1 AND q.paper_id = $2
      `, key);
      const snapshots = saved?.solution_snapshots ?? null;
      let changed = false;
      for (const row of rows) {
        const snapshot = snapshots?.[row.id];
        if (!snapshot || snapshot.model_solution || snapshot.stem !== row.stem || snapshot.visual_review !== row.visual_review) continue;
        if (row.model_solution) {
          snapshot.model_solution = row.model_solution;
          snapshot.solution_status = row.solution_status;
          changed = true;
        }
      }
      if (changed) await db.query('UPDATE practice_results SET solution_snapshots = $3 WHERE tenant_id = $1 AND paper_id = $2',
        [...key, JSON.stringify(snapshots)]);
      return { grades: saved?.graded, rows, snapshots };
    });
    grades = read.grades;
    snapshots = read.snapshots;
    for (const row of read.rows) {
      solutions.set(row.id, row);
      if (row.stem_correction) corrections.set(row.id, row.stem_correction);
    }
  } else {
    const { rows } = await asTenant(pool, tenant, db => db.query<{ id: string; stem_correction: string }>(`
      SELECT q.id, r.stem_correction FROM paper_questions q
      JOIN question_recall r ON (r.tenant_id, r.question_id) = (q.tenant_id, q.id)
      WHERE q.tenant_id = $1 AND q.paper_id = $2 AND r.stem_correction IS NOT NULL
    `, [tenant, paperId]));
    for (const row of rows) corrections.set(row.id, row.stem_correction);
  }
  const questions = attempt.questions.map(({ reference, visualReview, ...question }) => {
    const stemCorrection = corrections.get(question.id);
    const display = stemCorrection ? { ...question, stemCorrection } : question;
    if (!attempt.submittedAt) return display;
    const current = solutions.get(question.id);
    const referenceChanged = JSON.stringify(reference ?? null) !== JSON.stringify(current?.reference ?? null);
    const snapshot = snapshots?.[question.id];
    const matchesInput = snapshot && current && snapshot.stem === current.stem && snapshot.visual_review === current.visual_review;
    const savedGrade = grades?.[question.id];
    const result = savedGrade && savedGrade !== 'needs_review' ? savedGrade : gradeQuestion(attempt, { ...question, reference }, snapshot);
    return { ...display, reference: reference ?? null, referenceChanged,
      modelSolution: snapshot?.model_solution ?? null, correction: current?.correction ?? null,
      solutionStatus: snapshot?.model_solution ? snapshot.solution_status : matchesInput ? current.solution_status : null,
      solutionRetryable: Boolean(matchesInput && current.solution_status === 'failed'),
      legacySolutionUnavailable: snapshots === null,
      result: (referenceChanged || stemCorrection) && result !== 'unanswered' ? 'needs_review' : result };
  });
  return { ...attempt, questions, ...(attempt.submittedAt && {
    knowledgeNetwork: buildKnowledgeNetwork(questions.map(question => ({
      modelSolution: 'modelSolution' in question ? question.modelSolution : null
    })))
  }) };
}
const fields = 'title, questions, answers, revision, draft_state AS "draft", submitted_at AS "submittedAt", deadline_at AS "deadlineAt"';
const params = { type: 'object', required: ['paperId'], properties: { paperId: { type: 'string', format: 'uuid' } } };
const security = [{ session: [] }];

export async function closedBookActive(db: PoolClient, tenant: string, paperId: string) {
  const result = await db.query(`
    SELECT 1 FROM practice_attempts WHERE tenant_id = $1 AND paper_id = $2 AND submitted_at IS NULL
  `, [tenant, paperId]);
  return Boolean(result.rowCount);
}

async function storeResult(db: PoolClient, tenant: string, paperId: string, attempt: Attempt) {
  if (!attempt.submittedAt) return;
  await db.query("SELECT set_config('beitibao.tenant_id', $1, true)", [tenant]);
  const { rows } = await db.query<SolutionSnapshot & { id: string }>(`
    SELECT q.id, q.stem, q.visual_review, q.model_solution, q.solution_status
    FROM paper_questions q
    JOIN jsonb_to_recordset($3::jsonb) AS input(id uuid, stem text, "visualReview" text)
      ON q.id = input.id AND q.stem = input.stem AND q.visual_review IS NOT DISTINCT FROM input."visualReview"
    WHERE q.tenant_id = $1 AND q.paper_id = $2
  `, [tenant, paperId, JSON.stringify(attempt.questions)]);
  const snapshots = Object.fromEntries(rows.map(({ id, ...snapshot }) => [id, snapshot]));
  const grades = Object.fromEntries(attempt.questions.map(question =>
    [question.id, gradeQuestion(attempt, question, snapshots[question.id])]));
  const covered = attempt.questions.filter(question => grades[question.id] !== 'unanswered').map(question => question.id);
  await db.query(`
    INSERT INTO practice_results (tenant_id, paper_id, graded, covered, submitted_at, solution_snapshots)
    VALUES ($1, $2, $3, $4::uuid[], $5, $6)
    ON CONFLICT (tenant_id, paper_id) DO NOTHING
  `, [tenant, paperId, JSON.stringify(grades), covered, attempt.submittedAt, JSON.stringify(snapshots)]);
}

async function settleExpiredPaper(db: PoolClient, tenant: string, paperId: string) {
  const { rows: [attempt] } = await db.query<Attempt>(`
    UPDATE practice_attempts SET submitted_at = deadline_at, revision = revision + 1
    WHERE tenant_id = $1 AND paper_id = $2 AND submitted_at IS NULL AND deadline_at <= clock_timestamp()
    RETURNING ${fields}
  `, [tenant, paperId]);
  if (attempt) await storeResult(db, tenant, paperId, attempt);
  return attempt;
}

export async function settleExpiredPractices(pool: Pool) {
  await transaction(pool, async db => {
    const { rows: due } = await db.query<{ tenant_id: string; paper_id: string }>(`
      SELECT tenant_id, paper_id FROM practice_attempts
      WHERE submitted_at IS NULL AND deadline_at <= clock_timestamp()
      ORDER BY deadline_at LIMIT 50 FOR UPDATE SKIP LOCKED
    `);
    for (const item of due) await settleExpiredPaper(db, item.tenant_id, item.paper_id);
  });
}

export async function consumePracticeDeadline(pool: Pool, eventId: string) {
  return transaction(pool, async db => {
    const { rows: [event] } = await db.query<{ tenant_id: string; paper_id: string }>(`
      SELECT tenant_id, paper_id FROM practice_deadline_outbox WHERE id = $1
    `, [eventId]);
    if (!event) return true;
    if (await settleExpiredPaper(db, event.tenant_id, event.paper_id)) return true;
    const pending = await db.query(`
      SELECT 1 FROM practice_attempts WHERE tenant_id = $1 AND paper_id = $2 AND submitted_at IS NULL AND deadline_at IS NOT NULL
    `, [event.tenant_id, event.paper_id]);
    return !pending.rowCount;
  });
}

export function registerPracticeRoutes(app: FastifyInstance, pool: Pool, prefix: string, modelsEnabled = true) {
  const path = prefix + '/papers/:paperId/practice';
  app.get<{ Params: { paperId: string } }>(path, { schema: { params, security } }, async (request, reply) => {
    const tenant = request.studySession!.id;
    const attempt = await asTenant(pool, tenant, async db => {
      const key = [tenant, request.params.paperId];
      const expired = await settleExpiredPaper(db, tenant, request.params.paperId);
      if (expired) return expired;
      const { rows } = await db.query<Attempt>(`
        SELECT ${fields} FROM practice_attempts WHERE tenant_id = $1 AND paper_id = $2
      `, key);
      return rows[0];
    });
    return attempt ? presentAttempt(attempt, pool, tenant, request.params.paperId) : reply.code(404).send({ code: 'PRACTICE_NOT_FOUND' });
  });

  app.post<{ Params: { paperId: string }; Body: { durationMinutes?: number } | undefined }>(path,
    { schema: { params, security, body: { type: 'object', properties: {
      durationMinutes: { type: 'integer', minimum: 1, maximum: 360 }
    } } } }, async (request, reply) => {
    const tenant = request.studySession!.id;
    const key = [tenant, request.params.paperId];
    const { attempt, pending } = await asTenant(pool, tenant, async db => {
      await db.query('SELECT 1 FROM papers WHERE tenant_id = $1 AND id = $2 FOR UPDATE', key);
      await db.query(`
        WITH created AS (
        INSERT INTO practice_attempts (tenant_id, paper_id, title, questions, deadline_at)
        SELECT p.tenant_id, p.id, p.title, jsonb_agg(
          jsonb_build_object('id', q.id, 'stem', q.stem, 'pageNumber', q.page_number, 'kind', q.question_kind, 'reference', q.reference, 'visualReview', q.visual_review)
            || CASE WHEN cardinality(q.source_pages) > 0 THEN jsonb_build_object('sourcePages', q.source_pages) ELSE '{}'::jsonb END
          ORDER BY coalesce(array_position(p.page_order, q.page_number), q.page_number), q.created_at, q.id
        ), CASE WHEN $3::int IS NULL THEN NULL ELSE clock_timestamp() + make_interval(mins => $3::int) END
        FROM papers p JOIN paper_questions q ON (q.tenant_id, q.paper_id) = (p.tenant_id, p.id)
        WHERE p.tenant_id = $1 AND p.id = $2 AND p.status = 'review' AND p.course_id IS NOT NULL AND NOT p.missing_pages
          AND NOT EXISTS (SELECT 1 FROM paper_page_recognition r
            WHERE (r.tenant_id, r.paper_id) = (p.tenant_id, p.id) AND r.reviewed_at IS NULL)
        GROUP BY p.tenant_id, p.id, p.title
        ON CONFLICT (tenant_id, paper_id) DO NOTHING
        RETURNING tenant_id, paper_id, deadline_at
        )
        INSERT INTO practice_deadline_outbox (tenant_id, paper_id, deliver_at)
        SELECT tenant_id, paper_id, deadline_at FROM created WHERE deadline_at IS NOT NULL
      `, [...key, request.body?.durationMinutes ?? null]);
      const { rows } = await db.query<Attempt>(`
        SELECT ${fields} FROM practice_attempts WHERE tenant_id = $1 AND paper_id = $2
      `, key);
      const current = rows[0];
      if (modelsEnabled && current && !current.submittedAt) {
        await db.query(`
          UPDATE paper_questions SET solution_status = 'queued'
          WHERE tenant_id = $1 AND paper_id = $2 AND solution_status IS NULL AND id = ANY($3::uuid[])
            AND EXISTS (SELECT 1 FROM papers WHERE tenant_id = $1 AND id = $2 AND model_allowed)
        `, [...key, current.questions.map(question => question.id)]);
      }
      const pending = !current && await db.query(`
        SELECT 1 FROM papers p WHERE p.tenant_id = $1 AND p.id = $2 AND (p.missing_pages OR EXISTS (
          SELECT 1 FROM paper_page_recognition r WHERE (r.tenant_id, r.paper_id) = (p.tenant_id,p.id) AND r.reviewed_at IS NULL))
      `, key);
      return { attempt: current, pending: Boolean(pending && pending.rowCount) };
    });
    if (pending) return reply.code(409).send({ code: 'PAGE_REVIEW_REQUIRED' });
    return attempt ? presentAttempt(attempt, pool, tenant, request.params.paperId) : reply.code(404).send({ code: 'PRACTICE_NOT_FOUND' });
  });

  app.post<{ Params: { paperId: string }; Body: { revision: number; answers?: Record<string, string>; changes?: Record<string, string>; draft?: DraftState; submit: boolean } }>(
    path + '/save', { bodyLimit: 512 * 1024, schema: { params, security, body: {
      type: 'object', additionalProperties: false, required: ['revision', 'submit'],
      oneOf: [{ required: ['answers'] }, { required: ['changes'] }],
      properties: {
        revision: { type: 'integer', minimum: 0, maximum: 2147483646 },
        answers: { type: 'object', additionalProperties: { type: 'string', maxLength: 4000 } },
        changes: { type: 'object', additionalProperties: { type: 'string', maxLength: 4000 } },
        draft: { type: 'object', additionalProperties: false, required: ['marked', 'position'], properties: {
          marked: { type: 'array', maxItems: 1000, uniqueItems: true, items: { type: 'string' } },
          position: { type: ['string', 'null'] }
        } },
        submit: { type: 'boolean' }
      }
    } } }, async (request, reply) => {
      const tenant = request.studySession!.id;
      const key = [tenant, request.params.paperId];
      const { revision, answers, changes, draft, submit } = request.body;
      const result = await asTenant(pool, tenant, async db => {
        const { rows: [attempt] } = await db.query<Attempt>(`
          SELECT ${fields} FROM practice_attempts WHERE tenant_id = $1 AND paper_id = $2 FOR UPDATE
        `, key);
        if (!attempt) return { status: 404, code: 'PRACTICE_NOT_FOUND' };
        if (attempt.submittedAt) return submit ? { attempt } : { status: 409, code: 'PRACTICE_SUBMITTED' };
        const expired = await settleExpiredPaper(db, tenant, request.params.paperId);
        if (expired) return { attempt: expired };
        if (revision !== attempt.revision) return { status: 409, code: 'PRACTICE_CONFLICT' };
        const ids = new Set(attempt.questions.map(question => question.id));
        if (Object.entries(answers ?? changes ?? {}).some(([id, answer]) => !ids.has(id) || answer.includes('\u0000'))
            || draft?.marked.some(id => !ids.has(id)) || (draft?.position && !ids.has(draft.position))) {
          return { status: 400, code: 'INVALID_ANSWER' };
        }
        const { rows } = await db.query<Attempt>(`
          UPDATE practice_attempts SET
            answers = CASE WHEN deadline_at <= statement_timestamp() THEN answers ELSE $3::jsonb END,
            draft_state = CASE WHEN deadline_at <= statement_timestamp() THEN draft_state ELSE $5::jsonb END,
            revision = revision + 1,
            submitted_at = CASE WHEN deadline_at <= statement_timestamp() THEN deadline_at
              WHEN $4 THEN statement_timestamp() ELSE NULL END
          WHERE tenant_id = $1 AND paper_id = $2 RETURNING ${fields}
        `, [...key, JSON.stringify(answers ?? { ...attempt.answers, ...changes }), submit, JSON.stringify(draft ?? attempt.draft)]);
        if (rows[0]?.submittedAt) await storeResult(db, tenant, request.params.paperId, rows[0]);
        return { attempt: rows[0] };
      });
      return 'code' in result ? reply.code(result.status!).send({ code: result.code }) : presentAttempt(result.attempt!, pool, tenant, request.params.paperId);
    });
}
