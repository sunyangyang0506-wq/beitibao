import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { asTenant } from './db.js';
import { gradePracticeAnswer, modelGradingReference, type ModelGradingSolution, type QuestionReference } from './question-reference.js';

type Row = {
  id: string; paperId: string; paperTitle: string; course: string;
  logicalId: string;
  stem: string; pageNumber: number; reference: QuestionReference | null;
  originalAnswer: string; retryResult: string | null; referenceChanged: boolean; courseId: string; kind: string; day: string | null; mistakeAt: Date | null;
  modelSolution?: { knowledgePoints?: string[] };
  gradingKind?: string;
  gradingSolution?: ModelGradingSolution;
};

function grade(row: Row, answer: string) {
  return gradePracticeAnswer(answer, row.reference, row.gradingKind, row.stem, row.gradingSolution);
}

function submittedQuestions(db: PoolClient, tenant: string, questionId?: string) {
  const filter = questionId ? "AND q.value ->> 'id' = $2" : '';
  return db.query<Row>(`
    SELECT q.value ->> 'id' AS id, a.paper_id AS "paperId", a.title AS "paperTitle", c.name AS course, c.id AS "courseId",
      q.value ->> 'stem' AS stem, (q.value ->> 'pageNumber')::int AS "pageNumber",
      q.value -> 'reference' AS reference,
      (pq.reference IS DISTINCT FROM nullif(q.value -> 'reference', 'null'::jsonb)) AS "referenceChanged",
      a.answers ->> (q.value ->> 'id') AS "originalAnswer",
      coalesce(eq.anchor_id, pq.id) AS "logicalId",
      pq.question_kind AS kind, pq.model_solution AS "modelSolution",
      q.value ->> 'kind' AS "gradingKind",
      pr.solution_snapshots -> (q.value ->> 'id') -> 'model_solution' AS "gradingSolution",
      to_char(a.submitted_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') AS day,
      greatest(a.submitted_at, r.last_incorrect_at) AS "mistakeAt",
      r.result AS "retryResult"
    FROM practice_attempts a
    JOIN papers p ON (p.tenant_id, p.id) = (a.tenant_id, a.paper_id)
    JOIN courses c ON (c.tenant_id, c.id) = (p.tenant_id, p.course_id)
    CROSS JOIN LATERAL jsonb_array_elements(a.questions) AS q(value)
    JOIN paper_questions pq ON pq.tenant_id = a.tenant_id AND pq.id = (q.value ->> 'id')::uuid
    LEFT JOIN practice_results pr ON (pr.tenant_id, pr.paper_id) = (a.tenant_id, a.paper_id)
    LEFT JOIN current_question_equivalence eq ON (eq.tenant_id,eq.member_id) = (pq.tenant_id,pq.id)
    LEFT JOIN LATERAL (
      SELECT result, max(attempted_at) FILTER (WHERE result = 'incorrect') OVER () AS last_incorrect_at
      FROM mistake_retries
      WHERE tenant_id = a.tenant_id AND (question_id = coalesce(eq.anchor_id,pq.id) OR EXISTS (
        SELECT 1 FROM current_question_equivalence linked WHERE (linked.tenant_id,linked.member_id) = (a.tenant_id,question_id)
          AND linked.anchor_id = coalesce(eq.anchor_id,pq.id)
      ))
      AND (attempted_at IS NULL OR attempted_at >= a.submitted_at)
      ORDER BY id DESC LIMIT 1
    ) r ON true
    WHERE a.tenant_id = $1 AND a.submitted_at IS NOT NULL ${filter}
    ORDER BY a.submitted_at DESC, a.paper_id, q.value ->> 'id'
  `, questionId ? [tenant, questionId] : [tenant]);
}

export function registerMistakeRoutes(app: FastifyInstance, pool: Pool, prefix: string) {
  const security = [{ session: [] }];
  app.get(prefix + '/mistakes', { schema: { security } }, async request => {
    const tenant = request.studySession!.id;
    return asTenant(pool, tenant, async db => {
      const { rows } = await submittedQuestions(db, tenant);
      const mistakes = rows.filter(row => grade(row, row.originalAnswer) === 'incorrect')
        .map(({ reference, originalAnswer, retryResult, modelSolution, referenceChanged, gradingKind, gradingSolution, ...question }) => ({
          ...question, mode: 'graded', originalAnswer, reference: reference ?? modelGradingReference(gradingKind, question.stem, gradingSolution),
          knowledgePoints: modelSolution?.knowledgePoints ?? [],
          status: referenceChanged ? 'needs_review' : retryResult === 'correct' ? 'resolved' : retryResult === 'needs_review' ? 'needs_review' : 'open'
        }));
      const { rows: assessed } = await db.query<typeof mistakes[number]>(`
        SELECT q.id, p.id AS "paperId", p.title AS "paperTitle", c.name AS course, c.id AS "courseId", q.question_kind AS kind,
          to_char(r.mistake_recorded_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') AS day,
          coalesce(r.last_mistake_at, r.mistake_recorded_at) AS "mistakeAt",
          q.stem, q.page_number AS "pageNumber", coalesce(eq.anchor_id, q.id) AS "logicalId", 'recall' AS mode,
          CASE WHEN r.self_rating = 'mastered' THEN 'resolved' ELSE 'open' END AS status
        FROM question_recall r
        JOIN paper_questions q ON (q.tenant_id,q.id) = (r.tenant_id,r.question_id)
        JOIN papers p ON (p.tenant_id,p.id) = (q.tenant_id,q.paper_id)
        JOIN courses c ON (c.tenant_id,c.id) = (p.tenant_id,p.course_id)
        LEFT JOIN current_question_equivalence eq ON (eq.tenant_id,eq.member_id) = (q.tenant_id,q.id)
        WHERE r.tenant_id = $1 AND (r.bookmarked OR r.had_recall_difficulty) AND NOT p.is_prediction
        ORDER BY c.name, p.title, q.page_number, q.id
      `, [tenant]);
      const groups = new Map<string, Omit<typeof mistakes[number], 'logicalId'> & { sourceCount: number }>();
      const seen = new Set<string>();
      for (const { logicalId, ...question } of [...mistakes, ...assessed].sort(
        (a, b) => (b.mistakeAt?.getTime() ?? 0) - (a.mistakeAt?.getTime() ?? 0)
      )) {
        const group = groups.get(logicalId);
        if (group && question.day && (!group.day || question.day < group.day)) group.day = question.day;
        if (seen.has(question.id)) continue;
        seen.add(question.id);
        if (group) group.sourceCount++;
        else groups.set(logicalId, { ...question, sourceCount: 1 });
      }
      const calendarDay = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' });
      return { mistakes: [...groups.values()].map(question => ({
        ...question, mistakeDay: question.mistakeAt ? calendarDay.format(question.mistakeAt) : null
      })) };
    });
  });

  app.post<{ Params: { questionId: string }; Body: { attemptKey: string; answer: string } }>(
    prefix + '/mistakes/:questionId/retry', { bodyLimit: 32 * 1024, schema: {
      security, params: { type: 'object', required: ['questionId'], properties: { questionId: { type: 'string', format: 'uuid' } } },
      body: { type: 'object', required: ['attemptKey', 'answer'], properties: {
        attemptKey: { type: 'string', format: 'uuid' }, answer: { type: 'string', maxLength: 4000 }
      } }
    } }, async (request, reply) => {
      const tenant = request.studySession!.id;
      const id = request.params.questionId;
      const answer = request.body.answer.trim();
      if (!answer || answer.includes('\u0000')) return reply.code(400).send({ code: 'INVALID_ANSWER' });
      const result = await asTenant(pool, tenant, async db => {
        const { rows: [question] } = await submittedQuestions(db, tenant, id);
        if (!question || grade(question, question.originalAnswer) !== 'incorrect') return null;
        const key = [tenant, id, request.body.attemptKey];
        const result = question.referenceChanged ? 'needs_review' : grade(question, answer);
        const inserted = await db.query(`
          INSERT INTO mistake_retries (tenant_id, question_id, attempt_key, answer, result)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (tenant_id, question_id, attempt_key) DO NOTHING RETURNING answer, result
        `, [...key, answer, result]);
        const saved = inserted.rows[0] ?? (await db.query(`
          SELECT answer, result FROM mistake_retries WHERE tenant_id = $1 AND question_id = $2 AND attempt_key = $3
        `, key)).rows[0];
        return { ...saved, reference: question.reference ?? modelGradingReference(question.gradingKind, question.stem, question.gradingSolution),
          knowledgePoints: question.modelSolution?.knowledgePoints ?? [] };
      });
      if (!result) return reply.code(404).send({ code: 'PRACTICE_NOT_FOUND' });
      if (result.answer !== answer) return reply.code(409).send({ code: 'PRACTICE_CONFLICT' });
      return result;
    });
}
