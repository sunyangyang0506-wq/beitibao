import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { closedBookActive } from './practice.js';
import { asTenant } from './db.js';
import { reviseQuestion } from './question-versions.js';

export const questionKinds = ['choice', 'fill', 'calculation', 'short_answer', 'other'];
const uuid = { type: 'string', format: 'uuid' };
const params = { type: 'object', required: ['paperId', 'questionId'], properties: { paperId: uuid, questionId: uuid } };
const security = [{ session: [] }];

export function registerRecallRoutes(app: FastifyInstance, pool: Pool, prefix: string, modelsEnabled = true) {
  const questionPath = prefix + '/papers/:paperId/questions/:questionId';
  app.post<{ Params: { paperId: string; questionId: string }; Body: { stem: string; inputRevision?: number } }>(
    questionPath + '/stem-correction', { bodyLimit: 48 * 1024, schema: { params, security, body: {
      type: 'object', additionalProperties: false, required: ['stem'], properties: {
        stem: { type: 'string', minLength: 1, maxLength: 8000 }, inputRevision: { type: 'integer', minimum: 1 }
      }
    } } }, async (request, reply) => {
      const { paperId, questionId } = request.params;
      const tenant = request.studySession!.id;
      const stem = request.body.stem.trim();
      if (!stem || stem.includes('\u0000')) return reply.code(400).send({ code: 'INVALID_QUESTION' });
      const saved = await asTenant(pool, tenant, db => reviseQuestion(db, tenant, paperId, questionId, stem, modelsEnabled, request.body.inputRevision ?? 1));
      if (saved && 'conflict' in saved) return reply.code(409).send({ code: 'QUESTION_VERSION_CONFLICT' });
      return saved ?? reply.code(404).send({ code: 'PAPER_NOT_FOUND' });
    });

  app.post<{ Params: { paperId: string; questionId: string }; Body: { kind: string } }>(questionPath + '/kind', {
    schema: { params, security, body: { type: 'object', required: ['kind'], properties: {
      kind: { type: 'string', enum: questionKinds }
    } } }
  }, async (request, reply) => {
    const { paperId, questionId } = request.params;
    const tenant = request.studySession!.id;
    const saved = await asTenant(pool, tenant, db => db.query(`
      UPDATE paper_questions SET question_kind = $4 WHERE tenant_id = $1 AND paper_id = $2 AND id = $3 AND NOT figure_review_blocked
    `, [tenant, paperId, questionId, request.body.kind]));
    return saved.rowCount ? { kind: request.body.kind } : reply.code(404).send({ code: 'PAPER_NOT_FOUND' });
  });

  app.post<{ Params: { paperId: string }; Body: { kind: string } }>(prefix + '/papers/:paperId/recall', {
    schema: { security, params: { type: 'object', required: ['paperId'], properties: { paperId: uuid } },
      body: { type: 'object', required: ['kind'], properties: { kind: { type: 'string', enum: questionKinds } } } }
  }, async request => {
    if (!modelsEnabled) return { queued: 0 };
    const tenant = request.studySession!.id;
    const result = await asTenant(pool, tenant, db => db.query(`
      UPDATE paper_questions SET solution_status = 'queued'
      WHERE tenant_id = $1 AND paper_id = $2 AND question_kind = $3 AND solution_status IS NULL AND NOT figure_review_blocked
        AND EXISTS (SELECT 1 FROM papers WHERE tenant_id = $1 AND id = $2 AND model_allowed)
    `, [tenant, request.params.paperId, request.body.kind]));
    return { queued: result.rowCount };
  });

  app.post<{ Params: { paperId: string; questionId: string } }>(questionPath + '/reveal',
    { schema: { params, security } }, async (request, reply) => {
      const tenant = request.studySession!.id;
      const { paperId, questionId } = request.params;
      const result = await asTenant(pool, tenant, async db => {
        await db.query('SELECT 1 FROM papers WHERE tenant_id=$1 AND id=$2 FOR SHARE', [tenant, paperId]);
        if (await closedBookActive(db, tenant, paperId)) return { locked: true };
        const key = [tenant, paperId, questionId];
        const { rows: [question] } = await db.query(`
          SELECT input_revision AS "inputRevision", reference, model_solution AS "modelSolution", solution_status AS "solutionStatus"
          FROM paper_questions WHERE tenant_id = $1 AND paper_id = $2 AND id = $3 AND NOT figure_review_blocked
        `, key);
        if (!question) return null;
        await db.query(`
          INSERT INTO question_recall (tenant_id, question_id, revealed) VALUES ($1, $2, true)
          ON CONFLICT (tenant_id, question_id) DO UPDATE SET revealed = true WHERE NOT question_recall.revealed
        `, [tenant, questionId]);
        if (modelsEnabled && question.solutionStatus === null) {
          const queued = await db.query(`
            UPDATE paper_questions SET solution_status = 'queued'
            WHERE tenant_id = $1 AND paper_id = $2 AND id = $3 AND solution_status IS NULL
              AND EXISTS (SELECT 1 FROM papers WHERE tenant_id = $1 AND id = $2 AND model_allowed)
          `, key);
          if (queued.rowCount) question.solutionStatus = 'queued';
        }
        const { rows: [saved] } = await db.query('SELECT correction, self_rating AS "selfRating", bookmarked FROM question_recall WHERE tenant_id = $1 AND question_id = $2', [tenant, questionId]);
        return { ...question, correction: saved.correction, selfRating: saved.selfRating, bookmarked: saved.bookmarked };
      });
      if (result?.locked) return reply.code(409).send({ code: 'CLOSED_BOOK_ACTIVE' });
      return result ?? reply.code(404).send({ code: 'PAPER_NOT_FOUND' });
    });

  app.post<{ Params: { paperId: string; questionId: string }; Body: { answer: string; explanation: string } }>(
    questionPath + '/correction', { bodyLimit: 64 * 1024, schema: { params, security, body: {
      type: 'object', required: ['answer', 'explanation'], properties: {
        answer: { type: 'string', maxLength: 4000 }, explanation: { type: 'string', maxLength: 8000 }
      }
    } } }, async (request, reply) => {
      const tenant = request.studySession!.id;
      const { paperId, questionId } = request.params;
      const correction = { answer: request.body.answer.trim(), explanation: request.body.explanation.trim() };
      if (!correction.answer || Object.values(correction).some(value => value.includes('\u0000'))) {
        return reply.code(400).send({ code: 'INVALID_REFERENCE' });
      }
      const saved = await asTenant(pool, tenant, db => db.query(`
        INSERT INTO question_recall (tenant_id, question_id, correction)
        SELECT q.tenant_id, q.id, $4::jsonb FROM paper_questions q
        WHERE q.tenant_id = $1 AND q.paper_id = $2 AND q.id = $3 AND NOT q.figure_review_blocked AND (
          EXISTS (SELECT 1 FROM question_recall r WHERE r.tenant_id = q.tenant_id AND r.question_id = q.id AND r.revealed)
          OR EXISTS (SELECT 1 FROM practice_attempts a WHERE a.tenant_id = q.tenant_id AND a.paper_id = q.paper_id
            AND a.submitted_at IS NOT NULL AND a.questions @> jsonb_build_array(jsonb_build_object('id', q.id)))
        )
        ON CONFLICT (tenant_id, question_id) DO UPDATE SET correction = excluded.correction RETURNING correction
      `, [tenant, paperId, questionId, JSON.stringify(correction)]));
      return saved.rows[0] ?? reply.code(404).send({ code: 'PAPER_NOT_FOUND' });
    });
  app.post<{ Params: { paperId: string; questionId: string }; Body: { rating: string; inputRevision?: number } }>(
    questionPath + '/assessment', { schema: { params, security, body: {
      type: 'object', required: ['rating'], properties: {
        rating: { type: 'string', enum: ['mastered', 'partial', 'needs_practice'] }, inputRevision: { type: 'integer', minimum: 1 }
      }
    } } }, async (request, reply) => {
      const tenant = request.studySession!.id;
      const { paperId, questionId } = request.params;
      const { rows: [result] } = await asTenant(pool, tenant, db => db.query(`
        UPDATE question_recall r SET self_rating = $4, assessed_revision = q.input_revision,
          had_recall_difficulty = r.had_recall_difficulty OR $4 IN ('partial', 'needs_practice'),
          mistake_recorded_at = CASE WHEN $4 IN ('partial', 'needs_practice')
            THEN coalesce(r.mistake_recorded_at, statement_timestamp()) ELSE r.mistake_recorded_at END,
          last_mistake_at = CASE WHEN $4 IN ('partial', 'needs_practice')
            THEN statement_timestamp() ELSE r.last_mistake_at END
        FROM paper_questions q
        WHERE (q.tenant_id, q.id) = (r.tenant_id, r.question_id)
          AND r.tenant_id = $1 AND q.paper_id = $2 AND r.question_id = $3 AND r.revealed AND q.input_revision=$5 AND NOT q.figure_review_blocked
        RETURNING self_rating AS "selfRating"
      `, [tenant, paperId, questionId, request.body.rating, request.body.inputRevision ?? 1]));
      return result ?? reply.code(404).send({ code: 'PAPER_NOT_FOUND' });
    });
  app.post<{ Params: { paperId: string; questionId: string }; Body: { bookmarked: boolean } }>(
    questionPath + '/bookmark', { schema: { params, security, body: {
      type: 'object', required: ['bookmarked'], properties: { bookmarked: { type: 'boolean' } }
    } } }, async (request, reply) => {
      const tenant = request.studySession!.id;
      const { paperId, questionId } = request.params;
      const { rows: [result] } = await asTenant(pool, tenant, db => db.query(`
        INSERT INTO question_recall (tenant_id, question_id, bookmarked, mistake_recorded_at)
        SELECT tenant_id, id, $4, CASE WHEN $4 THEN clock_timestamp() END FROM paper_questions
        WHERE tenant_id = $1 AND paper_id = $2 AND id = $3 AND NOT figure_review_blocked
        ON CONFLICT (tenant_id, question_id) DO UPDATE SET bookmarked = excluded.bookmarked,
          mistake_recorded_at = coalesce(question_recall.mistake_recorded_at, excluded.mistake_recorded_at) RETURNING bookmarked
      `, [tenant, paperId, questionId, request.body.bookmarked]));
      return result ?? reply.code(404).send({ code: 'PAPER_NOT_FOUND' });
    });
}
