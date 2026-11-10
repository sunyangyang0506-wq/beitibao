import { resolveRecognizedCourse, type Assignment } from './subject-assignment.js';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { FastifyInstance } from 'fastify';
import { modelRequest } from './model-gateway.js';
import { asTenant, lockCourseMaterial, transaction } from './db.js';
import { recognizeImage } from './image-recognition.js';
import { choiceOptionCount, completeChoiceStem } from './paper-choices.js';
import { renderPage } from './paper-parser.js';
import { closedBookActive } from './practice.js';
import { loadPaperOriginal, type PaperOriginal, type PaperStorage } from './paper-storage.js';
import { queueCoursePrediction } from './predictions.js';
import { reuseMatchingPages, reuseStandaloneSolutions } from './school-paper-reuse.js';
import { setTenant, subjectKey } from './school-identity.js';
import type { JobTarget } from './job-outbox.js';

export const pdfRecognitionSize = 2400;
export const candidatesPerPage = 100;
const pageParams = { type: 'object', required: ['paperId', 'page'], properties: {
  paperId: { type: 'string', format: 'uuid' }, page: { type: 'integer', minimum: 1, maximum: 30 }
} };
const security = [{ session: [] }];

export function registerPdfPageRecognition(app: FastifyInstance, pool: Pool, prefix: string, modelsEnabled = true) {
  const route = prefix + '/papers/:paperId/pages/:page';
  app.post<{ Params: { paperId: string; page: number } }>(route + '/recognition',
    { schema: { params: pageParams, security } }, async (request, reply) => {
      const tenant = request.studySession!.id;
      const { paperId, page } = request.params;
      const key = [tenant, paperId, page];
      let published = false;
      const status = await asTenant(pool, tenant, async db => {
        const { rows: [course] } = await db.query<{ course_id: string | null }>(
          'SELECT course_id FROM papers WHERE tenant_id = $1 AND id = $2', key.slice(0, 2));
        if (course?.course_id) await lockCourseMaterial(db, tenant, course.course_id);
        const { rows: [paper] } = await db.query<{ model_allowed: boolean }>(
          'SELECT model_allowed FROM papers WHERE tenant_id = $1 AND id = $2 FOR UPDATE', key.slice(0, 2));
        if (!paper) return undefined;
        if (!paper.model_allowed) return 'unavailable';
        if (await closedBookActive(db, tenant, paperId)) return 'locked';
        const { rows: [job] } = await db.query<{ status: string; reviewed_at: Date | null }>(
          'SELECT status, reviewed_at FROM paper_page_recognition WHERE tenant_id = $1 AND paper_id = $2 AND page_number = $3', key);
        if (job?.status === 'review') {
          // Recover older saved recognition without rerunning OCR or discarding feedback.
          // Cross-account cache reuse remains a worker-only operation.
          if (!job.reviewed_at) await publishCompletedPages(db, tenant, paperId, false, modelsEnabled);
          const { rows: [saved] } = await db.query<{ status: string; published: boolean }>(
            'SELECT status, reviewed_at IS NOT NULL AS published FROM paper_page_recognition WHERE tenant_id = $1 AND paper_id = $2 AND page_number = $3', key);
          published = saved?.published ?? false;
          return saved?.status;
        }
        if (!modelsEnabled) return 'unavailable';
        await db.query(`
          INSERT INTO paper_page_recognition (tenant_id, paper_id, page_number)
          SELECT tenant_id, id, $3 FROM papers
          WHERE tenant_id = $1 AND id = $2 AND status = 'review' AND media_type = 'application/pdf'
            AND NOT is_prediction AND model_allowed AND jsonb_array_length(pages) >= $3
          ON CONFLICT (tenant_id, paper_id, page_number) DO UPDATE
          SET status = 'queued', failure = NULL
          WHERE paper_page_recognition.status = 'failed' AND paper_page_recognition.reviewed_at IS NULL
        `, key);
        const { rows: [queued] } = await db.query(
          'SELECT status FROM paper_page_recognition WHERE tenant_id = $1 AND paper_id = $2 AND page_number = $3', key);
        return queued?.status;
      });
      if (status === 'unavailable') return reply.code(409).send({ code: 'RECOGNITION_UNAVAILABLE' });
      if (status === 'locked') return reply.code(409).send({ code: 'CLOSED_BOOK_ACTIVE' });
      return status ? reply.code(status === 'queued' || status === 'processing' ? 202 : 200).send({ status, published })
        : reply.code(404).send({ code: 'PAPER_NOT_FOUND' });
    });

  app.post<{ Params: { paperId: string; page: number } }>(route + '/confirm',
    { schema: { params: pageParams, security } }, async (request, reply) => {
      const tenant = request.studySession!.id;
      const { paperId, page } = request.params;
      const key = [tenant, paperId, page];
      const status = await asTenant(pool, tenant, async db => {
        // Serialize page confirmation with candidate confirmation and figure re-selection.
        const { rows: [paper] } = await db.query<{ model_allowed: boolean }>(
          'SELECT model_allowed FROM papers WHERE tenant_id = $1 AND id = $2 FOR UPDATE', key.slice(0, 2));
        if (await closedBookActive(db, tenant, paperId)) return 'locked';
        const { rows: [job] } = await db.query<{ status: string; reviewed_at: string | null; count: number }>(`
          SELECT status, reviewed_at, coalesce(jsonb_array_length(recognition->'stems'), 0) AS count
          FROM paper_page_recognition WHERE tenant_id = $1 AND paper_id = $2 AND page_number = $3
          FOR UPDATE
        `, key);
        if (!job) return 'missing';
        if (job.reviewed_at) return 'confirmed';
        const paused = (!modelsEnabled || !paper?.model_allowed) && ['queued', 'processing'].includes(job.status);
        if (!paused && !['review', 'failed'].includes(job.status)) return 'pending';
        const first = (page - 1) * candidatesPerPage;
        const { rows: [summary] } = await db.query<{ count: number }>(`
          SELECT count(*)::int AS count FROM recognition_feedback
          WHERE tenant_id = $1 AND paper_id = $2 AND candidate_index >= $3 AND candidate_index < $4
        `, [tenant, paperId, first, first + job.count]);
        if (summary?.count !== job.count) return 'pending';
        await db.query(`
          UPDATE paper_page_recognition SET reviewed_at = now(),
            status = CASE WHEN $4 THEN 'failed' ELSE status END,
            failure = CASE WHEN $4 THEN 'RECOGNITION_UNAVAILABLE' ELSE failure END,
            lease_id = CASE WHEN $4 THEN NULL ELSE lease_id END,
            lease_until = CASE WHEN $4 THEN NULL ELSE lease_until END
          WHERE tenant_id = $1 AND paper_id = $2 AND page_number = $3
        `, [...key, paused]);
        return 'confirmed';
      });
      if (status === 'locked') return reply.code(409).send({ code: 'CLOSED_BOOK_ACTIVE' });
      if (status === 'missing') return reply.code(404).send({ code: 'PAPER_NOT_FOUND' });
      if (status === 'pending') return reply.code(409).send({ code: 'PAGE_REVIEW_REQUIRED' });
      return { status };
    });
}

async function publishCompletedPages(db: PoolClient, tenant: string, paperId: string, reuseSolutions = true, queueSolutions = true) {
  const key = [tenant, paperId];
  const { rows } = await db.query<{
    page_number: number; reviewed_at: Date | null; status: string; failure: string | null;
    recognition: Awaited<ReturnType<typeof recognizeImage>> | null;
  }>(`SELECT r.page_number, r.reviewed_at, r.status, r.failure, r.recognition FROM paper_page_recognition r
      JOIN papers p ON (p.tenant_id, p.id) = (r.tenant_id, r.paper_id)
      WHERE r.tenant_id = $1 AND r.paper_id = $2
      ORDER BY coalesce(array_position(p.page_order, r.page_number), r.page_number)`, key);
  if (rows.some(row => ['queued', 'processing'].includes(row.status))) return false;

  const choiceOnly = rows.some(row => row.recognition?.choiceOnly);
  for (const [index, row] of rows.entries()) {
    const result = row.recognition;
    if (row.reviewed_at) continue;
    if (row.status === 'review' && (!result || !Array.isArray(result.stems) ||
        result.stems.some(stem => typeof stem !== 'string' || !stem.trim() || [...stem].length > 8000))) {
      await db.query(`UPDATE paper_page_recognition SET status = 'failed', failure = 'OCR_FAILED'
        WHERE tenant_id = $1 AND paper_id = $2 AND page_number = $3`, [...key, row.page_number]);
      continue;
    }
    if (!result || (row.status !== 'review' && row.failure !== 'OCR_INCOMPLETE_OPTIONS')) continue;
    const next = rows[index + 1];
    const continued = next?.recognition?.continuation;
    const stems = [...result.stems];
    const last = stems.at(-1);
    const joined = Boolean(last && continued && last.length + continued.length < 8000 && !last.includes(continued));
    if (joined) stems[stems.length - 1] = last + '\n' + continued;
    const checked = stems.map((stem, candidate) =>
      completeChoiceStem(stem, choiceOptionCount(stem, result.choiceCounts?.[candidate], choiceOnly)));
    if (checked.includes(null)) {
      await db.query(`UPDATE paper_page_recognition SET status = 'failed', failure = 'OCR_INCOMPLETE_OPTIONS'
        WHERE tenant_id = $1 AND paper_id = $2 AND page_number = $3`, [...key, row.page_number]);
      continue;
    }
    if (row.status !== 'review' || checked.some((stem, candidate) => stem !== result.stems[candidate])) {
      await db.query(`UPDATE paper_page_recognition SET status = 'review', failure = NULL,
        recognition = jsonb_set(recognition, '{stems}', $4)
        WHERE tenant_id = $1 AND paper_id = $2 AND page_number = $3`, [...key, row.page_number, JSON.stringify(checked)]);
    }
    await db.query('SELECT publish_recognized_pdf_page($1, $2, $3)', [...key, row.page_number]);
    if (joined && next) await db.query(`UPDATE paper_questions SET source_pages = ARRAY[$3::int, $5::int]
      WHERE tenant_id = $1 AND paper_id = $2 AND page_number = $3 AND stem = $4 AND cardinality(source_pages) = 0`,
    [...key, row.page_number, checked.at(-1), next.page_number]);
  }
  if (reuseSolutions) await reuseStandaloneSolutions(db, tenant, paperId);
  if (queueSolutions) await db.query(`UPDATE paper_questions SET solution_status = 'queued'
    WHERE tenant_id = $1 AND paper_id = $2 AND solution_status IS NULL`, key);
  return true;
}

export async function processNextPageRecognition(pool: Pool, recognize = recognizeImage, storage?: PaperStorage, target?: JobTarget, autoPublish = false, autoPredict = false) {
  const lease = randomUUID();
  const { rows: [job] } = await pool.query<PaperOriginal & { tenant_id: string; paper_id: string; page_number: number; course_id: string | null; auto_assignment: boolean; fingerprint: string; school_page_hashes: string[] | null; school_candidate_id: string | null; cover_choice_only: boolean }>(`
    WITH next AS (
      SELECT r.tenant_id, r.paper_id, r.page_number FROM paper_page_recognition r
      WHERE (r.status = 'queued' OR (r.status = 'processing' AND r.lease_until <= now()))
        AND EXISTS (SELECT 1 FROM papers p WHERE (p.tenant_id, p.id) = (r.tenant_id, r.paper_id) AND p.model_allowed
          AND (NOT p.auto_assignment OR p.course_id IS NOT NULL OR r.page_number = 1 OR NOT EXISTS (
            SELECT 1 FROM paper_page_recognition cover WHERE (cover.tenant_id, cover.paper_id) = (r.tenant_id, r.paper_id)
              AND cover.page_number = 1 AND cover.status IN ('queued', 'processing')
          )))
        AND ($2::uuid IS NULL OR (r.tenant_id, r.paper_id, r.page_number) = ($2, $3::uuid, $4::int))
      ORDER BY r.created_at, r.page_number FOR UPDATE SKIP LOCKED LIMIT 1
    )
    UPDATE paper_page_recognition r SET status = 'processing', lease_id = $1, lease_until = now() + interval '145 seconds'
    FROM next JOIN papers p ON (p.tenant_id, p.id) = (next.tenant_id, next.paper_id)
    WHERE (r.tenant_id, r.paper_id, r.page_number) = (next.tenant_id, next.paper_id, next.page_number)
    RETURNING r.tenant_id, r.paper_id, r.page_number, p.course_id, p.auto_assignment, p.fingerprint, p.school_page_hashes, p.school_candidate_id, p.pdf, p.media_type, p.object_key, p.object_version, p.object_bytes,
      EXISTS (SELECT 1 FROM paper_page_recognition cover
        WHERE (cover.tenant_id, cover.paper_id) = (r.tenant_id, r.paper_id)
          AND cover.page_number = 1 AND cover.recognition->>'choiceOnly' = 'true') AS cover_choice_only
  `, [lease, target?.tenant ?? null, target?.id ?? null, target?.page ?? null]);
  if (!job) return false;
  let recognition: Awaited<ReturnType<typeof recognizeImage>> | null = null;
  let failure: string | null = null;
  try {
    const image = await renderPage(await loadPaperOriginal(job, storage), job.page_number, pdfRecognitionSize);
    recognition = await recognize(image, 'image/png', modelRequest(pool, job.tenant_id, 'page'), job.cover_choice_only);
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    failure = error instanceof Error && error.name === 'TimeoutError' ? 'OCR_TIMEOUT' :
      ['OCR_NOT_CONFIGURED', 'OCR_ACCESS_DENIED', 'MODEL_BUDGET_LIMIT', 'MODEL_RATE_LIMIT'].includes(code) ? code : 'OCR_FAILED';
  }
  await transaction(pool, async db => {
    const key = [job.tenant_id, job.paper_id];
    const subject = job.auto_assignment && job.page_number === 1 ? recognition?.paperSubject : undefined;
    let courseId = job.course_id;
    const assignment: Assignment = job.auto_assignment && job.page_number === 1 && !courseId
      ? await resolveRecognizedCourse(db, job.tenant_id, recognition ?? {})
      : { courseId, reason: 'assigned' };
    courseId = assignment.courseId;
    if (courseId && (subject || (autoPublish && autoPredict))) await lockCourseMaterial(db, job.tenant_id, courseId);
    const { rows: [paper] } = await db.query<{ count: number; review_revision: number }>(`
      SELECT jsonb_array_length(pages) AS count, review_revision
      FROM papers WHERE tenant_id = $1 AND id = $2 FOR UPDATE
    `, key);
    if (!paper) throw new Error('STALE_RECOGNITION_LEASE');
    const saved = await db.query(`
      UPDATE paper_page_recognition SET status = $5, failure = $6, recognition = $7::jsonb || jsonb_build_object('recognizedAt', clock_timestamp()), original_recognition = $7::jsonb, lease_id = NULL, lease_until = NULL
      WHERE tenant_id = $1 AND paper_id = $2 AND page_number = $3 AND lease_id = $4
    `, [...key, job.page_number, lease, recognition ? 'review' : 'failed',
      failure, recognition ? JSON.stringify(recognition) : null]);
    if (!saved.rowCount) throw new Error('STALE_RECOGNITION_LEASE');
    if (job.page_number === 1 && recognition?.paperSubject) {
      await setTenant(db, job.tenant_id);
      const keySubject = subjectKey(recognition.paperSubject);
      await db.query(`
        UPDATE school_paper_index SET subject_key = CASE WHEN subject_key IS NULL OR subject_key=$3 THEN $3 ELSE NULL END
        WHERE tenant_id=$1 AND paper_id=$2
      `, [...key, keySubject]);
    }
    if (job.auto_assignment && job.page_number === 1) {
      const { rows: [assigned] } = await db.query<{ course_id: string | null }>(`
        UPDATE papers p SET recognized_subject = $3, course_id = CASE
          WHEN p.course_id IS NOT NULL OR $4::uuid IS NULL OR EXISTS (
            SELECT 1 FROM papers existing WHERE existing.tenant_id = p.tenant_id AND existing.course_id = $4
              AND existing.fingerprint = p.fingerprint AND existing.school IS NOT DISTINCT FROM p.school AND existing.id <> p.id
          ) THEN p.course_id ELSE $4 END
        WHERE p.tenant_id = $1 AND p.id = $2 RETURNING course_id
      `, [...key, subject ?? null, courseId]);
      courseId = assigned?.course_id ?? null;
      await db.query('UPDATE papers SET assignment_reason = $3 WHERE tenant_id = $1 AND id = $2',
        [...key, courseId ? 'assigned' : assignment.courseId ? 'duplicate' : assignment.reason]);
      if (job.school_candidate_id && courseId && subject) {
        await reuseMatchingPages(db, { ...job, id: job.paper_id }, job.school_candidate_id, subject);
      }
    }

    if (recognition && paper.review_revision === 0) {
      const { rows } = await db.query<{ page: number; printed: number | null; total: number | null }>(`
        SELECT page_number AS page, (recognition->>'printedPage')::int AS printed, (recognition->>'printedTotalPages')::int AS total
        FROM paper_page_recognition WHERE tenant_id = $1 AND paper_id = $2 AND status IN ('review', 'failed') AND recognition IS NOT NULL
        ORDER BY printed
      `, key);
      const complete = rows.length === paper.count && rows.every(({ printed }, index) =>
        printed !== null && rows[0]!.printed !== null && printed === rows[0]!.printed + index);
      const distinct = new Set(rows.map(row => row.printed));
      const declared = new Set(rows.flatMap(row => row.total ? [row.total] : []));
      const missingByPrintedTotal = declared.size === 1 && [...declared][0]! > paper.count;
      if (rows.length === paper.count && (missingByPrintedTotal ||
        (!distinct.has(null) && distinct.size === rows.length && !complete))) {
        await db.query('UPDATE papers SET missing_pages = true, review_revision = review_revision + 1 WHERE tenant_id = $1 AND id = $2', key);
      }
      if (!missingByPrintedTotal && complete && rows.some(({ page }, index) => page !== index + 1)) {
        await db.query('UPDATE papers SET page_order = $3, review_revision = review_revision + 1 WHERE tenant_id = $1 AND id = $2',
          [...key, rows.map(({ page }) => page)]);
      }
    }
    if (autoPublish) {
      if (job.page_number === 1 && recognition?.paperTitle) {
        await db.query('UPDATE papers SET title = $3 WHERE tenant_id = $1 AND id = $2 AND auto_title',
          [...key, recognition.paperTitle]);
      }
      const published = await publishCompletedPages(db, job.tenant_id, job.paper_id);
      if (published && autoPredict && courseId) await queueCoursePrediction(db, job.tenant_id, courseId);
    }
  }).catch(error => { if (!(error instanceof Error) || error.message !== 'STALE_RECOGNITION_LEASE') throw error; });
  return true;
}
