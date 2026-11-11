import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { asTenant } from './db.js';
import { closedBookActive } from './practice.js';

const uuid = { type: 'string', format: 'uuid' };
const params = { type: 'object', required: ['paperId', 'questionId'], properties: { paperId: uuid, questionId: uuid } };
const security = [{ session: [] }];

async function originalQuestion(db: PoolClient, tenant: string, paper: string, question: string) {
  const { rows: [item] } = await db.query<{ course_id: string; question_kind: string; stem: string }>(`
    SELECT p.course_id, q.question_kind, q.stem FROM paper_questions q
    JOIN papers p ON (q.tenant_id, q.paper_id) = (p.tenant_id, p.id)
    WHERE q.tenant_id = $1 AND q.paper_id = $2 AND q.id = $3 AND NOT q.figure_review_blocked AND NOT p.is_prediction AND p.status = 'review'
  `, [tenant, paper, question]);
  return item;
}

export function registerQuestionEquivalence(app: FastifyInstance, pool: Pool, prefix: string) {
  const path = prefix + '/papers/:paperId/questions/:questionId/equivalences';
  app.get<{ Params: { paperId: string; questionId: string }; Querystring: { query?: string } }>(path, {
    schema: { params, security, querystring: { type: 'object', properties: { query: { type: 'string', maxLength: 120 } } } }
  }, async (request, reply) => {
    const tenant = request.studySession!.id;
    const { paperId, questionId } = request.params;
    const result = await asTenant(pool, tenant, async db => {
      const source = await originalQuestion(db, tenant, paperId, questionId);
      if (!source) return null;
      if (await closedBookActive(db, tenant, paperId)) return { locked: true };
      const { rows: links } = await db.query(`
        SELECT e.id, e.anchor_id AS "anchorId", e.member_id AS "memberId", e.revoked_at AS "revokedAt",
          p.title, q.page_number AS "pageNumber"
        FROM question_equivalence e
        JOIN paper_questions q ON (q.tenant_id, q.id) = (e.tenant_id,
          CASE WHEN e.anchor_id = $2 THEN e.member_id ELSE e.anchor_id END)
        JOIN papers p ON (p.tenant_id, p.id) = (q.tenant_id, q.paper_id)
        WHERE e.tenant_id = $1 AND (e.anchor_id = $2 OR e.member_id = $2)
        ORDER BY e.revoked_at NULLS FIRST, e.confirmed_at DESC LIMIT 30
      `, [tenant, questionId]);
      const { rows: candidates } = await db.query(`
        SELECT q.id, p.title, q.stem, q.page_number AS "pageNumber"
        FROM paper_questions q JOIN papers p ON (q.tenant_id, q.paper_id) = (p.tenant_id, p.id)
        WHERE q.tenant_id = $1 AND p.course_id = $2 AND p.id <> $3 AND p.status = 'review' AND NOT p.is_prediction
          AND q.question_kind = $4 AND NOT q.figure_review_blocked AND NOT EXISTS (
            SELECT 1 FROM practice_attempts a WHERE (a.tenant_id,a.paper_id) = (p.tenant_id,p.id) AND a.submitted_at IS NULL
          ) AND ($5 = '' AND regexp_replace(q.stem, '[[:space:]]+', '', 'g') = regexp_replace($6, '[[:space:]]+', '', 'g')
            OR $5 <> '' AND strpos(lower(q.stem), lower($5)) > 0)
        ORDER BY p.created_at DESC, q.page_number, q.id LIMIT 20
      `, [tenant, source.course_id, paperId, source.question_kind, request.query.query?.trim() ?? '', source.stem]);
      return { links, candidates };
    });
    if (!result) return reply.code(404).send({ code: 'PAPER_NOT_FOUND' });
    return 'locked' in result ? reply.code(409).send({ code: 'CLOSED_BOOK_ACTIVE' }) : result;
  });

  app.post<{ Params: { paperId: string; questionId: string }; Body: { memberId?: string; revokeId?: string } }>(path, {
    schema: { params, security, body: { type: 'object', additionalProperties: false,
      oneOf: [{ required: ['memberId'] }, { required: ['revokeId'] }], properties: { memberId: uuid, revokeId: uuid } } }
  }, async (request, reply) => {
    const tenant = request.studySession!.id;
    const { paperId, questionId } = request.params;
    const { memberId, revokeId } = request.body;
    const result = await asTenant(pool, tenant, async db => {
      const source = await originalQuestion(db, tenant, paperId, questionId);
      if (!source) return 'PAPER_NOT_FOUND';
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [tenant + ':' + source.course_id]);
      if (await closedBookActive(db, tenant, paperId)) return 'CLOSED_BOOK_ACTIVE';
      if (revokeId) {
        const revoked = await db.query(`
          UPDATE question_equivalence SET revoked_at = coalesce(revoked_at, now())
          WHERE tenant_id = $1 AND id = $2 AND (anchor_id = $3 OR member_id = $3) RETURNING id
        `, [tenant, revokeId, questionId]);
        return revoked.rowCount ? { id: revokeId, status: 'revoked' } : 'PAPER_NOT_FOUND';
      }
      const { rows: [target] } = await db.query<{ paper_id: string; question_kind: string }>(`
        SELECT q.paper_id, q.question_kind FROM paper_questions q
        JOIN papers p ON (q.tenant_id, q.paper_id) = (p.tenant_id, p.id)
        WHERE q.tenant_id = $1 AND q.id = $2 AND p.course_id = $3 AND q.paper_id <> $4
          AND p.status = 'review' AND NOT p.is_prediction AND NOT q.figure_review_blocked
      `, [tenant, memberId, source.course_id, paperId]);
      if (!target) return 'PAPER_NOT_FOUND';
      if (target.question_kind !== source.question_kind) return 'EQUIVALENCE_KIND_MISMATCH';
      if (await closedBookActive(db, tenant, target.paper_id)) return 'CLOSED_BOOK_ACTIVE';
      const { rows } = await db.query<{ id: string; anchor_id: string; member_id: string }>(`
        SELECT id, anchor_id, member_id FROM question_equivalence
        WHERE tenant_id = $1 AND revoked_at IS NULL AND (member_id IN ($2, $3) OR anchor_id = $3)
      `, [tenant, questionId, memberId]);
      const existing = rows.find(row => row.anchor_id === questionId && row.member_id === memberId);
      if (existing) return { id: existing.id, status: 'confirmed' };
      if (rows.length) return 'EQUIVALENCE_CONFLICT';
      const { rows: [created] } = await db.query(`
        INSERT INTO question_equivalence (tenant_id, anchor_id, member_id, question_kind) VALUES ($1, $2, $3, $4) RETURNING id
      `, [tenant, questionId, memberId, source.question_kind]);
      return { id: created.id, status: 'confirmed' };
    });
    if (typeof result !== 'string') return result;
    return reply.code(result === 'PAPER_NOT_FOUND' ? 404 : 409).send({ code: result });
  });
}
