import { buildKnowledgeNetwork } from './knowledge.js';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import type { QuestionReference } from './question-reference.js';
import { gradePracticeQuestion, refreshPracticeResults, samePracticeInput, practiceSolutionSources, type SolutionSnapshot, type Grades, type CurrentPracticeSolution } from './practice-results.js';
import { asTenant, transaction } from './db.js';

type DraftState = { marked: string[]; position: string | null };

type Attempt = {
  title: string;
  attemptId: string;
  questions: { id: string; stem: string; inputRevision?: number; pageNumber: number; kind?: string; sourcePages?: number[]; visualReview?: string | null; reference?: QuestionReference | null }[];
  answers: Record<string, string>;
  revision: number;
  draft: DraftState;
  submittedAt: string | null;
  deadlineAt: string | null;
};
type CurrentSolution = CurrentPracticeSolution & { correction: unknown; stem_correction: string | null };

async function presentAttempt(attempt: Attempt, pool: Pool, tenant: string, paperId: string, reply: FastifyReply) {
  const solutions = new Map<string, CurrentSolution>();
  const corrections = new Map<string, string>();
  const versions = new Map<string, number>();
  let snapshots: Record<string, SolutionSnapshot> | null = null;
  let grades: Grades | undefined;
  if (attempt.submittedAt) {
    const key = [tenant, paperId];
    const read = await asTenant(pool, tenant, async db => {
      await db.query('SELECT 1 FROM papers WHERE tenant_id=$1 AND id=$2 FOR SHARE', key);
      const { rows: [currentAttempt] } = await db.query<{ submitted_at: string | null }>('SELECT submitted_at FROM practice_attempts WHERE tenant_id=$1 AND paper_id=$2', key);
      if (!currentAttempt) return { blocked: 'PRACTICE_NOT_FOUND' as const, status: 404 };
      if (!currentAttempt.submitted_at) return { blocked: 'CLOSED_BOOK_ACTIVE' as const, status: 409 };
      await refreshPracticeResults(db, tenant, { paperId });
      const { rows: [saved] } = await db.query<{ graded: Grades; solution_snapshots: Record<string, SolutionSnapshot> | null }>(
        `SELECT r.graded,r.solution_snapshots FROM practice_results r JOIN practice_attempts a USING (tenant_id,paper_id)
         WHERE r.tenant_id=$1 AND r.paper_id=$2 AND a.attempt_id=$3 FOR UPDATE OF r`, [...key, attempt.attemptId]);
      const { rows } = await db.query<CurrentSolution>(`
      SELECT q.id, q.stem, q.input_revision, q.visual_review, q.question_kind, q.reference, q.model_solution, q.solution_status, r.correction, r.stem_correction FROM paper_questions q
      LEFT JOIN question_recall r ON (r.tenant_id, r.question_id) = (q.tenant_id, q.id)
      WHERE q.tenant_id = $1 AND q.paper_id = $2
      `, key);
      const archive = !saved ? (await db.query<{ graded: Grades; solution_snapshots: Record<string, SolutionSnapshot> | null }>(
        'SELECT graded,solution_snapshots FROM practice_history WHERE tenant_id=$1 AND paper_id=$2 AND attempt_id=$3', [...key, attempt.attemptId])).rows[0] : null;
      const result = saved ?? archive;
      const snapshots = result?.solution_snapshots ?? null;
      return { grades: result?.graded, rows, snapshots };
    });
    if ('blocked' in read) return reply.code(read.status ?? 409).send({ code: read.blocked });
    grades = read.grades;
    snapshots = read.snapshots;
    for (const row of read.rows) {
      solutions.set(row.id, row);
      versions.set(row.id, row.input_revision ?? 1);
      if (row.stem_correction) corrections.set(row.id, row.stem_correction);
    }
  } else {
    const { rows } = await asTenant(pool, tenant, db => db.query<{ id: string; stem: string; input_revision: number; stem_correction: string | null }>(`
      SELECT q.id, q.stem, q.input_revision, r.stem_correction FROM paper_questions q
      LEFT JOIN question_recall r ON (r.tenant_id, r.question_id) = (q.tenant_id, q.id)
      WHERE q.tenant_id = $1 AND q.paper_id = $2
    `, [tenant, paperId]));
    for (const row of rows) {
      versions.set(row.id, row.input_revision);
      if (row.stem_correction) corrections.set(row.id, row.stem_correction);
    }
  }
  const questions = attempt.questions.map(({ reference, visualReview, ...question }) => {
    const stemCorrection = corrections.get(question.id);
    const inputChanged = (question.inputRevision ?? 1) !== versions.get(question.id)
      || Boolean(stemCorrection && stemCorrection !== question.stem);
    const display = { ...question, inputChanged };
    if (!attempt.submittedAt) return display;
    const current = solutions.get(question.id);
    const referenceChanged = JSON.stringify(reference ?? null) !== JSON.stringify(current?.reference ?? null);
    const snapshot = snapshots?.[question.id];
    const matchesInput = snapshot && current && snapshot.stem === current.stem && snapshot.visual_review === current.visual_review
      && samePracticeInput({ ...question, reference, visualReview }, current);
    const savedGrade = grades?.[question.id];
    const result = savedGrade && savedGrade !== 'needs_review' ? savedGrade : gradePracticeQuestion(attempt, { ...question, reference }, snapshot);
    return { ...display, reference: reference ?? null, referenceChanged,
      modelSolution: snapshot?.model_solution ?? null, correction: current?.correction ?? null,
      solutionStatus: snapshot?.model_solution ? snapshot.solution_status : matchesInput ? current.solution_status : null,
      solutionRetryable: Boolean(matchesInput && current.solution_status === 'failed'),
      legacySolutionUnavailable: snapshots === null,
      result };
  });
  return { ...attempt, questions, inputChanged: questions.some(question => question.inputChanged), ...(attempt.submittedAt && {
    knowledgeNetwork: buildKnowledgeNetwork(questions.map(question => ({
      modelSolution: 'modelSolution' in question ? question.modelSolution : null
    })))
  }) };
}
const fields = 'attempt_id AS "attemptId", title, questions, answers, revision, draft_state AS "draft", submitted_at AS "submittedAt", deadline_at AS "deadlineAt"';
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
    SELECT q.id, q.stem, q.input_revision, q.visual_review, q.model_solution, q.solution_status
    FROM (${practiceSolutionSources}) q
    JOIN jsonb_to_recordset($3::jsonb) AS input(id uuid, stem text, "inputRevision" integer, "visualReview" text, kind text, reference jsonb)
      ON q.id = input.id AND q.input_revision = coalesce(input."inputRevision", 1) AND q.stem = input.stem
      AND q.visual_review IS NOT DISTINCT FROM input."visualReview"
      AND (input.kind IS NULL OR q.question_kind = input.kind)
      AND q.reference IS NOT DISTINCT FROM input.reference
    WHERE q.paper_id = $2
  `, [tenant, paperId, JSON.stringify(attempt.questions)]);
  const snapshots = Object.fromEntries(rows.map(({ id, ...snapshot }) => [id, snapshot]));
  const grades = Object.fromEntries(attempt.questions.map(question =>
    [question.id, gradePracticeQuestion(attempt, question, snapshots[question.id])]));
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
  app.get<{ Params: { paperId: string } }>(path + '/history', { schema: { params, security } }, async request => {
    const { rows } = await asTenant(pool, request.studySession!.id, db => db.query(`
      SELECT id, submitted_at AS "submittedAt", title FROM practice_history
      WHERE tenant_id=$1 AND paper_id=$2 ORDER BY submitted_at DESC, id DESC
    `, [request.studySession!.id, request.params.paperId]));
    return { history: rows };
  });
  app.get<{ Params: { paperId: string; historyId: string } }>(path + '/history/:historyId', {
    schema: { security, params: { type: 'object', required: ['paperId','historyId'], properties: {
      paperId: { type: 'string', format: 'uuid' }, historyId: { type: 'string', format: 'uuid' }
    } } }
  }, async (request, reply) => {
    const result = await asTenant(pool, request.studySession!.id, async db => {
      const key = [request.studySession!.id, request.params.paperId];
      await db.query('SELECT 1 FROM papers WHERE tenant_id=$1 AND id=$2 FOR SHARE', key);
      if (await closedBookActive(db, request.studySession!.id, request.params.paperId)) return { locked: true as const };
      await refreshPracticeResults(db, request.studySession!.id, { paperId: request.params.paperId });
      const { rows: [saved] } = await db.query<Attempt & {
        graded: Grades | null; solution_snapshots: Record<string, SolutionSnapshot> | null;
      }>(`SELECT ${fields}, graded, solution_snapshots FROM practice_history WHERE tenant_id=$1 AND paper_id=$2 AND id=$3`,
        [...key, request.params.historyId]);
      return { saved };
    });
    if ('locked' in result) return reply.code(409).send({ code: 'CLOSED_BOOK_ACTIVE' });
    const saved = result.saved;
    if (!saved) return reply.code(404).send({ code: 'PRACTICE_NOT_FOUND' });
    const { graded, solution_snapshots, ...attempt } = saved;
    const questions = attempt.questions.map(({ visualReview, ...question }) => {
      const snapshot = solution_snapshots?.[question.id];
      return { ...question, reference: question.reference ?? null, result: graded?.[question.id] ?? gradePracticeQuestion(attempt, question, snapshot),
        modelSolution: snapshot?.model_solution ?? null, solutionStatus: snapshot?.solution_status ?? null,
        legacySolutionUnavailable: solution_snapshots === null, historical: true };
    });
    return { ...attempt, questions, historical: true, knowledgeNetwork: buildKnowledgeNetwork(questions.map(question => ({ modelSolution: question.modelSolution }))) };
  });
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
    return attempt ? presentAttempt(attempt, pool, tenant, request.params.paperId, reply) : reply.code(404).send({ code: 'PRACTICE_NOT_FOUND' });
  });

  app.post<{ Params: { paperId: string }; Body: { durationMinutes?: number } | undefined }>(path,
    { schema: { params, security, body: { type: 'object', properties: {
      durationMinutes: { type: 'integer', minimum: 1, maximum: 360 }
    } } } }, async (request, reply) => {
    const tenant = request.studySession!.id;
    const key = [tenant, request.params.paperId];
    const { attempt, pending } = await asTenant(pool, tenant, async db => {
      await db.query('SELECT 1 FROM papers WHERE tenant_id = $1 AND id = $2 FOR UPDATE', key);
      const { rows: [previous] } = await db.query<Attempt>(`
        SELECT ${fields} FROM practice_attempts WHERE tenant_id=$1 AND paper_id=$2 FOR UPDATE
      `, key);
      let nextRevision = 0;
      if (previous?.submittedAt) {
        const { rows: [change] } = await db.query<{ changed: boolean }>(`
          SELECT EXISTS (
            SELECT 1 FROM (SELECT * FROM paper_questions WHERE tenant_id=$1 AND paper_id=$2) q
            FULL JOIN jsonb_to_recordset($3::jsonb)
              AS old(id uuid, stem text, "inputRevision" integer, "visualReview" text, kind text) ON q.id=old.id
            WHERE q.id IS NULL OR old.id IS NULL OR q.input_revision<>coalesce(old."inputRevision",1)
              OR practice_stem_key(q.stem) IS DISTINCT FROM practice_stem_key(old.stem)
              OR q.visual_review IS DISTINCT FROM old."visualReview"
              OR (old.kind IS NOT NULL AND old.kind<>q.question_kind)
          ) AS changed
        `, [...key, JSON.stringify(previous.questions)]);
        if (change?.changed) {
          const eligible = await db.query(`SELECT 1 FROM papers p WHERE p.tenant_id=$1 AND p.id=$2
            AND p.status='review' AND p.course_id IS NOT NULL AND NOT p.missing_pages
            AND EXISTS (SELECT 1 FROM paper_questions q WHERE q.tenant_id=p.tenant_id AND q.paper_id=p.id)
            AND NOT EXISTS (SELECT 1 FROM paper_page_recognition r WHERE r.tenant_id=p.tenant_id AND r.paper_id=p.id AND r.reviewed_at IS NULL)`, key);
          if (!eligible.rowCount) return { attempt: previous, pending: true };
          await refreshPracticeResults(db, tenant, { paperId: request.params.paperId });
          await db.query(`INSERT INTO practice_history
            (tenant_id,paper_id,attempt_id,title,questions,answers,revision,draft_state,submitted_at,deadline_at,graded,covered,solution_snapshots)
            SELECT a.tenant_id,a.paper_id,a.attempt_id,a.title,a.questions,a.answers,a.revision,a.draft_state,a.submitted_at,a.deadline_at,
              r.graded,r.covered,r.solution_snapshots
            FROM practice_attempts a LEFT JOIN practice_results r USING (tenant_id,paper_id)
            WHERE a.tenant_id=$1 AND a.paper_id=$2`, key);
          nextRevision = previous.revision + 1;
          await db.query('DELETE FROM practice_results WHERE tenant_id=$1 AND paper_id=$2', key);
          await db.query('DELETE FROM practice_deadline_outbox WHERE tenant_id=$1 AND paper_id=$2', key);
          await db.query('DELETE FROM practice_attempts WHERE tenant_id=$1 AND paper_id=$2', key);
        }
      }

      await db.query(`
        WITH created AS (
        INSERT INTO practice_attempts (tenant_id, paper_id, title, questions, deadline_at, revision)
        SELECT p.tenant_id, p.id, p.title, jsonb_agg(
          jsonb_build_object('id', q.id, 'stem', q.stem, 'inputRevision', q.input_revision, 'pageNumber', q.page_number, 'kind', q.question_kind, 'reference', q.reference, 'visualReview', q.visual_review)
            || CASE WHEN cardinality(q.source_pages) > 0 THEN jsonb_build_object('sourcePages', q.source_pages) ELSE '{}'::jsonb END
          ORDER BY coalesce(array_position(p.page_order, q.page_number), q.page_number), q.created_at, q.id
        ), CASE WHEN $3::int IS NULL THEN NULL ELSE clock_timestamp() + make_interval(mins => $3::int) END, $4
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
      `, [...key, request.body?.durationMinutes ?? null, nextRevision]);
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
    return attempt ? presentAttempt(attempt, pool, tenant, request.params.paperId, reply) : reply.code(404).send({ code: 'PRACTICE_NOT_FOUND' });
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
        if (attempt.submittedAt) return submit && revision === attempt.revision - 1 ? { attempt } : { status: 409, code: 'PRACTICE_SUBMITTED' };
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
      return 'code' in result ? reply.code(result.status!).send({ code: result.code }) : presentAttempt(result.attempt!, pool, tenant, request.params.paperId, reply);
    });
}
