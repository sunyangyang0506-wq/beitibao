import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { asTenant, lockCourseMaterial } from './db.js';

export function registerPaperDeletion(app: FastifyInstance, pool: Pool, prefix: string) {
  app.post<{ Params: { paperId: string }; Body: { confirmed: boolean } }>(prefix + '/papers/:paperId/delete', {
    schema: { security: [{ session: [] }], params: { type: 'object', required: ['paperId'],
      properties: { paperId: { type: 'string', format: 'uuid' } } },
    body: { type: 'object', required: ['confirmed'], additionalProperties: false,
      properties: { confirmed: { type: 'boolean', const: true } } } }
  }, async (request, reply) => {
    const tenant = request.studySession!.id;
    const { paperId } = request.params;
    const removed = await asTenant(pool, tenant, async db => {
      const { rows: [paper] } = await db.query<{ course_id: string | null }>(
        'SELECT course_id FROM papers WHERE tenant_id = $1 AND id = $2', [tenant, paperId]);
      if (!paper) return false;
      if (paper.course_id) await lockCourseMaterial(db, tenant, paper.course_id);
      const { rows: [locked] } = await db.query<{ course_id: string | null }>(
        'SELECT course_id FROM papers WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenant, paperId]);
      if (!locked) return false;
      if (locked.course_id !== paper.course_id) return 'changed' as const;
      const related = await db.query<{ id: string; paper_id: string | null }>(`
        SELECT id, paper_id FROM predictions WHERE tenant_id = $1 AND course_id = $2 AND
          (paper_id = $3 OR evidence @> jsonb_build_array(jsonb_build_object('paperId', $3::uuid)))
        FOR UPDATE
      `, [tenant, paper.course_id, paperId]);
      const paperIds = [paperId, ...related.rows.flatMap(row => row.paper_id ? [row.paper_id] : [])];
      const key = [tenant, paperIds];
      const { rows: originals } = await db.query<{ model_cache_key: string | null }>(
        'SELECT model_cache_key FROM papers WHERE tenant_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE', key);
      if (!originals.length) return false;
      const { rows: questions } = await db.query<{ id: string }>(
        'SELECT id FROM paper_questions WHERE tenant_id = $1 AND paper_id = ANY($2::uuid[])', key);
      const questionKey = [tenant, questions.map(row => row.id)];
      const predictionKey = [tenant, related.rows.map(row => row.id)];
      await db.query(`
        UPDATE paper_uploads u SET paper_id = NULL, kept_version = NULL, cleaned_at = NULL, erased_at = now(),
          title = '', school = '', fingerprint = repeat('0', 64)
        WHERE u.tenant_id = $1 AND u.erased_at IS NULL AND (u.paper_id = ANY($2::uuid[]) OR EXISTS (
          SELECT 1 FROM papers p WHERE p.tenant_id = u.tenant_id AND p.id = ANY($2::uuid[])
            AND (p.course_id, p.fingerprint, p.school) = (u.course_id, u.fingerprint, u.school)))
      `, key);
      await db.query(`
        DELETE FROM business_job_outbox WHERE tenant_id = $1 AND (
          (lane IN ('paper','page') AND job_key = ANY($2::uuid[]))
          OR (lane = 'solution' AND job_key = ANY($3::uuid[]))
          OR (lane = 'prediction' AND job_key = ANY($4::uuid[])))
      `, [...key, questionKey[1], predictionKey[1]]);
      await db.query('DELETE FROM predictions WHERE tenant_id = $1 AND id = ANY($2::uuid[])', predictionKey);
      await db.query(`
        DELETE FROM question_equivalence WHERE tenant_id = $1
          AND (anchor_id = ANY($2::uuid[]) OR member_id = ANY($2::uuid[]))
      `, questionKey);
      for (const table of ['question_recall', 'mistake_retries']) {
        await db.query(`DELETE FROM ${table} WHERE tenant_id = $1 AND question_id = ANY($2::uuid[])`, questionKey);
      }
      for (const table of ['recognition_feedback', 'paper_page_recognition', 'practice_results',
        'practice_deadline_outbox', 'practice_attempts', 'paper_questions']) {
        await db.query(`DELETE FROM ${table} WHERE tenant_id = $1 AND paper_id = ANY($2::uuid[])`, key);
      }
      await db.query('DELETE FROM papers WHERE tenant_id = $1 AND id = ANY($2::uuid[])', key);
      const cacheKeys = [...new Set(originals.flatMap(row => row.model_cache_key ? [row.model_cache_key] : []))].sort();
      for (const cacheKey of cacheKeys) {
        await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [cacheKey]);
        const remaining = await db.query('SELECT 1 FROM papers WHERE tenant_id = $1 AND model_cache_key = $2 LIMIT 1', [tenant, cacheKey]);
        if (!remaining.rowCount) {
          await db.query('DELETE FROM paper_model_cache_claim WHERE tenant_id = $1 AND cache_key = $2', [tenant, cacheKey]);
          await db.query('DELETE FROM paper_model_cache WHERE tenant_id = $1 AND cache_key = $2', [tenant, cacheKey]);
        }
      }
      return true;
    });
    if (removed === 'changed') return reply.code(409).send({ code: 'PAPER_ASSIGNMENT_BUSY' });
    return removed ? reply.code(204).send() : reply.code(404).send({ code: 'PAPER_NOT_FOUND' });
  });
}
