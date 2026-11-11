import { closedBookActive } from './practice.js';
import { registerRecallRoutes } from './recall.js';
import { normalizeAnswer, type QuestionReference } from './question-reference.js';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { imagePromptVersion, isImageType, validImage } from './image-recognition.js';
import { registerPdfPageRecognition } from './pdf-page-recognition.js';
import { registerRecognitionReview } from './recognition-review.js';
import { asTenant, lockCourseMaterial } from './db.js';
import { paperSolutionVersion } from './paper-model-cache.js';
import { maxPdfBytes, renderPage } from './paper-parser.js';
import { registerQuestionEquivalence } from './question-equivalence.js';
import { paperFields as fields, registerPrivatePaperUploads, uploadCourse, type PrivatePapers } from './paper-uploads.js';
import { loadPaperOriginal, maxPrivatePdfBytes, type PaperOriginal } from './paper-storage.js';
import { schoolOf } from './school-identity.js';
import { queueCoursePrediction } from './predictions.js';
import { registerPaperDeletion } from './paper-deletion.js';

const uuid = { type: 'string', format: 'uuid' };
const security = [{ session: [] }];
const courseParams = { type: 'object', required: ['courseId'], properties: { courseId: uploadCourse } };
const paperParams = { type: 'object', required: ['paperId'], properties: { paperId: uuid } };
const pageNumber = { type: 'integer', minimum: 1, maximum: 30 };
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

export function registerPaperRoutes(app: FastifyInstance, pool: Pool, prefix: string, privatePapers?: PrivatePapers, localModelPreview = false, pdfOnlyUploads = false) {
  let previews = 0;
  registerRecognitionReview(app, pool, prefix, privatePapers, localModelPreview);
  const uploadLimit = localModelPreview ? maxPrivatePdfBytes : maxPdfBytes;
  registerPdfPageRecognition(app, pool, prefix, privatePapers?.modelsEnabled);
  registerRecallRoutes(app, pool, prefix, privatePapers?.modelsEnabled);
  registerQuestionEquivalence(app, pool, prefix);
  if (privatePapers) {
    registerPrivatePaperUploads(app, pool, prefix, privatePapers, pdfOnlyUploads);
    registerPaperDeletion(app, pool, prefix);
  }
  else app.addContentTypeParser(['application/pdf', 'image/png', 'image/jpeg'], { parseAs: 'buffer', bodyLimit: uploadLimit },
    (_request, body, done) => done(null, body));

  app.get<{ Params: { courseId: string } }>(prefix + '/courses/:courseId/papers',
    { schema: { security, params: courseParams } }, async (request, reply) => {
      const tenant = request.studySession!.id;
      const courseId = request.params.courseId === 'auto' ? null : request.params.courseId;
      const result = await asTenant(pool, tenant, async (db) => {
        const course = courseId ? await db.query('SELECT name FROM courses WHERE tenant_id = $1 AND id = $2', [tenant, courseId]) : null;
        if (course && !course.rowCount) return null;
        const { rows } = await db.query(`
          SELECT ${fields}, questions.present AS "hasQuestions",
            (missing_pages OR page_review.pending) AS "pendingReview",
            CASE
              WHEN status IN ('queued', 'processing') OR page_review.running THEN 'recognizing'
              WHEN status = 'failed' OR page_review.failed THEN 'failed'
              WHEN course_id IS NULL THEN 'unassigned'
              WHEN missing_pages THEN 'missing_pages'
              WHEN page_review.pending THEN 'needs_review'
              WHEN NOT questions.present THEN CASE WHEN media_type = 'application/pdf' THEN 'no_questions' ELSE 'needs_review' END
              ELSE 'ready'
            END AS "libraryStatus"
          FROM papers
          CROSS JOIN LATERAL (
            SELECT EXISTS (
              SELECT 1 FROM paper_questions q WHERE (q.tenant_id, q.paper_id) = (papers.tenant_id, papers.id)
            ) AS present
          ) questions
          CROSS JOIN LATERAL (
            SELECT count(*) > 0 AS pending,
              coalesce(bool_or(r.status IN ('queued', 'processing')), false) AS running,
              coalesce(bool_or(r.status = 'failed'), false) AS failed
            FROM paper_page_recognition r
            WHERE (r.tenant_id, r.paper_id) = (papers.tenant_id, papers.id) AND r.reviewed_at IS NULL
          ) page_review
          WHERE tenant_id = $1 AND ($2::uuid IS NULL OR course_id = $2) AND NOT is_prediction ORDER BY created_at DESC
        `, [tenant, courseId]);
        return { course: course?.rows[0] ?? null, papers: rows, schoolSharingAvailable: Boolean(await schoolOf(db, tenant)), modelUploads: privatePapers?.modelsEnabled ?? localModelPreview, ...(privatePapers && {
          uploadMode: 'private'
        }), ...(localModelPreview && { maxUploadMb: 50 }) };
      });
      return result ?? reply.code(404).send({ code: 'COURSE_NOT_FOUND' });
    });

  if (!privatePapers) app.post<{ Params: { courseId: string }; Querystring: { title: string; school?: string; recognizeScans?: boolean; autoTitle?: boolean; shareAtSchool?: boolean; redacted?: boolean }; Body: Buffer }>(
    prefix + '/courses/:courseId/papers', { bodyLimit: uploadLimit, schema: {
      security, params: courseParams,
      querystring: { type: 'object', required: ['title'], properties: { title: { type: 'string', maxLength: 200 }, school: { type: 'string', maxLength: 120 }, recognizeScans: { type: 'boolean' }, autoTitle: { type: 'boolean' }, shareAtSchool: { type: 'boolean' }, redacted: { type: 'boolean' } } }
    } }, async (request, reply) => {
      const pdf = request.body;
      const title = request.query.title.trim();
      const mediaType = request.headers['content-type']?.split(';')[0]?.trim();
      if (pdfOnlyUploads && mediaType !== 'application/pdf') return reply.code(415).send({ code: 'PDF_ONLY' });
      if (request.params.courseId === 'auto' && mediaType !== 'application/pdf') return reply.code(415).send({ code: 'PDF_ONLY' });
      const image = isImageType(mediaType);
      const school = request.query.school?.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase() || null;
      if (school?.includes('\u0000') || (school && [...school].length > 120)) {
        return reply.code(400).send({ code: 'INVALID_SCHOOL' });
      }
      if (!title || title.includes('\u0000') || !Buffer.isBuffer(pdf) || (image ? !validImage(pdf, mediaType) : mediaType !== 'application/pdf' || pdf.subarray(0, 5).toString() !== '%PDF-')) {
        return reply.code(400).send({ code: image ? 'INVALID_IMAGE' : 'INVALID_PDF' });
      }
      const tenant = request.studySession!.id;
      const courseId = request.params.courseId === 'auto' ? null : request.params.courseId;
      const result = await asTenant(pool, tenant, async (db) => {
        const share = request.query.shareAtSchool && !image && localModelPreview && request.query.recognizeScans && request.query.redacted;
        const schoolId = share ? await schoolOf(db, tenant) : null;
        if (request.query.shareAtSchool && !schoolId) return 'sharing' as const;
        const course = await db.query<{ name: string }>('SELECT name FROM courses WHERE tenant_id = $1 AND id = $2', [tenant, courseId]);
        if (courseId && !course.rowCount) return null;
        const key = [tenant, courseId, hash(pdf)];
        const cacheKey = school && course.rows[0] ? hash(JSON.stringify([tenant, school, course.rows[0]!.name.toLowerCase(), key[2], paperSolutionVersion, image ? imagePromptVersion : null])) : null;
        const cached = cacheKey && await db.query('SELECT cache_key FROM paper_model_cache WHERE cache_key = $1', [cacheKey]);
        if (!courseId) {
          await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 98217))', [tenant]);
          const { rows: [previous] } = await db.query(`
            SELECT ${fields} FROM papers WHERE tenant_id = $1 AND fingerprint = $2 AND auto_assignment LIMIT 1
          `, [tenant, key[2]]);
          if (previous) return { paper: previous, reused: true };
        }
        const inserted = await db.query(`
          INSERT INTO papers (tenant_id, course_id, fingerprint, title, pdf, media_type, school, model_cache_key, recognize_scans, auto_title, auto_assignment, share_school_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $2::uuid IS NULL, $11)
          ON CONFLICT DO NOTHING RETURNING ${fields}
        `, [...key, title, pdf, mediaType, school, cacheKey, !image && (request.query.recognizeScans ?? false), !image && Boolean(request.query.autoTitle), schoolId]);
        if (inserted.rowCount) return { paper: inserted.rows[0], reused: false, modelReused: Boolean(cached && cached.rowCount) };
        const existing = await db.query(`
          SELECT ${fields} FROM papers WHERE tenant_id = $1 AND fingerprint = $3 AND (
            ($2::uuid IS NULL AND auto_assignment) OR (course_id IS NOT DISTINCT FROM $2 AND school IS NOT DISTINCT FROM $4)
          ) ORDER BY auto_assignment DESC LIMIT 1
        `, [...key, school]);
        return { paper: existing.rows[0], reused: true };
      });
      if (result === 'sharing') return reply.code(403).send({ code: 'SCHOOL_SHARING_NOT_AUTHORIZED' });
      if (!result) return reply.code(404).send({ code: 'COURSE_NOT_FOUND' });
      return reply.code(result.reused ? 200 : 202).send(result);
    });

  app.post<{ Params: { paperId: string }; Body: { courseId: string } }>(prefix + '/papers/:paperId/assignment',
    { schema: { security, params: paperParams, body: { type: 'object', required: ['courseId'], properties: { courseId: uuid } } } },
    async (request, reply) => {
      const tenant = request.studySession!.id;
      const { paperId } = request.params;
      const { courseId } = request.body;
      const result = await asTenant(pool, tenant, async db => {
        const course = await db.query('SELECT 1 FROM courses WHERE tenant_id = $1 AND id = $2', [tenant, courseId]);
        if (!course.rowCount) return 'missing';
        await lockCourseMaterial(db, tenant, courseId);
        const { rows: [paper] } = await db.query<{ course_id: string | null; status: string; running: boolean; duplicate: boolean }>(`
          SELECT p.course_id, p.status, EXISTS (
            SELECT 1 FROM paper_page_recognition r WHERE (r.tenant_id, r.paper_id) = (p.tenant_id, p.id)
              AND r.status IN ('queued', 'processing')
          ) AS running, EXISTS (
            SELECT 1 FROM papers other WHERE other.tenant_id = p.tenant_id AND other.course_id = $3
              AND other.fingerprint = p.fingerprint AND other.school IS NOT DISTINCT FROM p.school AND other.id <> p.id
          ) AS duplicate
          FROM papers p WHERE p.tenant_id = $1 AND p.id = $2 AND p.auto_assignment FOR UPDATE
        `, [tenant, paperId, courseId]);
        if (!paper) return 'missing';
        if (paper.course_id === courseId) return 'saved';
        if (paper.course_id || paper.running || ['queued', 'processing'].includes(paper.status)) return 'conflict';
        if (paper.duplicate) return 'duplicate';
        await db.query('UPDATE papers SET course_id = $3 WHERE tenant_id = $1 AND id = $2', [tenant, paperId, courseId]);
        if (privatePapers?.predictionsEnabled ?? localModelPreview) await queueCoursePrediction(db, tenant, courseId);
        return 'saved';
      });
      if (result === 'missing') return reply.code(404).send({ code: 'PAPER_NOT_FOUND' });
      if (result !== 'saved') return reply.code(409).send({ code: result === 'duplicate' ? 'PAPER_ALREADY_ARCHIVED' : 'PAPER_ASSIGNMENT_BUSY' });
      return { courseId };
    });

  app.post<{ Params: { paperId: string } }>(prefix + '/papers/:paperId/revoke-school-sharing',
    { schema: { security, params: paperParams } }, async (request, reply) => {
      const tenant = request.studySession!.id;
      const { paperId } = request.params;
      const saved = await asTenant(pool, tenant, db => db.query(`
        UPDATE papers SET share_school_id = NULL WHERE tenant_id = $1 AND id = $2 AND NOT is_prediction
        RETURNING id
      `, [tenant, paperId]));
      return saved.rowCount ? { sharedAtSchool: false } : reply.code(404).send({ code: 'PAPER_NOT_FOUND' });
    });

  app.get<{ Params: { paperId: string }; Querystring: { includeAnalysis?: boolean } }>(prefix + '/papers/:paperId',
    { schema: { security, params: paperParams, querystring: { type: 'object', properties: { includeAnalysis: { type: 'boolean' } } } } }, async (request, reply) => {
      const key = [request.studySession!.id, request.params.paperId];
      const result = await asTenant(pool, key[0]!, async (db) => {
        const { rows: [paper] } = await db.query(`
          SELECT ${fields}, pages, recognition, (model_allowed AND $3) AS "modelAvailable",
            (model_allowed AND $4 AND media_type = 'application/pdf') AS "autoReview"
          FROM papers WHERE tenant_id = $1 AND id = $2
        `, [...key, privatePapers?.modelsEnabled ?? true, privatePapers?.modelsEnabled ?? localModelPreview]);
        if (!paper) return null;
        if (await closedBookActive(db, key[0]!, key[1]!)) {
          return { paper: { ...paper, pages: [], recognition: null }, questions: [], reviews: [], pageReviews: [], closedBook: true,
            ...(privatePapers && { canDelete: true }) };
        }
        const { rows: questions } = await db.query(`
          SELECT q.id, input_revision AS "inputRevision", page_number AS "pageNumber", stem, question_kind AS "kind", r.stem_correction AS "stemCorrection",
            reference, model_solution AS "modelSolution", solution_status AS "solutionStatus", solution_failure AS "solutionFailure",
            CASE WHEN cardinality(source_pages) > 0 THEN source_pages END AS "sourcePages"
          FROM paper_questions q LEFT JOIN question_recall r ON (r.tenant_id, r.question_id) = (q.tenant_id, q.id)
          WHERE q.tenant_id = $1 AND q.paper_id = $2 ORDER BY page_number, q.created_at
        `, key);
        const { rows: reviews } = await db.query(`
          SELECT f.candidate_index AS "candidateIndex", f.outcome, f.reviewed_stem AS "reviewedStem",
            f.question_id AS "questionId", q.visual_review AS "visualReview"
          FROM recognition_feedback f LEFT JOIN paper_questions q ON q.tenant_id = f.tenant_id AND q.id = f.question_id
          WHERE f.tenant_id = $1 AND f.paper_id = $2 ORDER BY f.candidate_index
        `, key);
        const { rows: pageReviews } = await db.query(`
          SELECT page_number AS page, status, failure, recognition, reviewed_at AS "reviewedAt"
          FROM paper_page_recognition WHERE tenant_id = $1 AND paper_id = $2 ORDER BY page_number
        `, key);
        return { paper, questions: questions.map(({ sourcePages, reference, modelSolution, solutionStatus, solutionFailure, stemCorrection, ...question }) => ({
          ...question, ...(sourcePages && { sourcePages }), ...(stemCorrection && { stemCorrection }), ...(request.query.includeAnalysis && { reference, modelSolution, solutionStatus, solutionFailure })
        })), reviews, pageReviews, ...(privatePapers && { canDelete: true }) };
      });
      return result ?? reply.code(404).send({ code: 'PAPER_NOT_FOUND' });
    });

  app.get<{ Params: { paperId: string; page: number } }>(prefix + '/papers/:paperId/pages/:page',
    { schema: { security, params: { ...paperParams, required: ['paperId', 'page'], properties: { paperId: uuid, page: pageNumber } } } },
    async (request, reply) => {
      if (previews >= 2) return reply.code(429).send({ code: 'PREVIEW_BUSY' });
      previews++;
      try {
        const tenant = request.studySession!.id;
        const { paperId, page } = request.params;
        const paper = await asTenant(pool, tenant, async db => {
          if (await closedBookActive(db, tenant, paperId)) return { locked: true } as const;
          const { rows } = await db.query<PaperOriginal>(`
            SELECT pdf, media_type, object_key, object_version, object_bytes FROM papers WHERE tenant_id = $1 AND id = $2
              AND status = 'review' AND jsonb_array_length(pages) >= $3
          `, [tenant, paperId, page]);
          return rows[0];
        });
        if (paper && 'locked' in paper) return reply.code(409).send({ code: 'CLOSED_BOOK_ACTIVE' });
        if (!paper) return reply.code(404).send({ code: 'PAPER_NOT_FOUND' });
        const original = await loadPaperOriginal(paper, privatePapers?.storage(request.headers));
        if (isImageType(paper.media_type)) {
          return reply.header('X-Content-Type-Options', 'nosniff').type(paper.media_type).send(original);
        }
        const image = await renderPage(original, page);
        return reply.header('X-Content-Type-Options', 'nosniff').type('image/png').send(image);
      } finally {
        previews--;
      }
    });

  app.post<{ Params: { paperId: string }; Body: { revision: number; missingPages: boolean; pageOrder?: number[] } }>(
    prefix + '/papers/:paperId/review-state', { schema: {
      security, params: paperParams, body: { type: 'object', additionalProperties: false, required: ['revision', 'missingPages'], properties: {
        revision: { type: 'integer', minimum: 0, maximum: 2147483646 }, missingPages: { type: 'boolean' },
        pageOrder: { type: 'array', minItems: 1, maxItems: 30, uniqueItems: true, items: pageNumber }
      } }
    } }, async (request, reply) => {
      const tenant = request.studySession!.id;
      const { paperId } = request.params;
      const { revision, missingPages, pageOrder } = request.body;
      const outcome = await asTenant(pool, tenant, async db => {
        const { rows: [current] } = await db.query<{ count: number; review_revision: number }>(`
          SELECT jsonb_array_length(pages) AS count, review_revision FROM papers
          WHERE tenant_id = $1 AND id = $2 AND status = 'review' AND NOT is_prediction FOR UPDATE
        `, [tenant, paperId]);
        if (!current) return 'PAPER_NOT_FOUND';
        if (await closedBookActive(db, tenant, paperId)) return 'CLOSED_BOOK_ACTIVE';
        if (current.review_revision !== revision) return 'PAPER_REVIEW_CONFLICT';
        if (pageOrder && (pageOrder.length !== current.count || pageOrder.some(page => page > current.count))) {
          return 'INVALID_PAGE_ORDER';
        }
        const { rows: [updated] } = await db.query(`
          UPDATE papers SET share_school_id = NULL, school_content_key = NULL, page_order = coalesce($3::int[], page_order), missing_pages = $4, review_revision = review_revision + 1
          WHERE tenant_id = $1 AND id = $2 RETURNING ${fields}
        `, [tenant, paperId, pageOrder ?? null, missingPages]);
        return { paper: updated };
      });
      return typeof outcome === 'string' ? reply.code(outcome === 'PAPER_NOT_FOUND' ? 404 :
        outcome === 'INVALID_PAGE_ORDER' ? 400 : 409).send({ code: outcome }) : outcome;
    });

  app.post<{ Params: { paperId: string }; Body: { pageNumber: number; stem: string; sourcePages?: number[] } }>(
    prefix + '/papers/:paperId/questions', { schema: {
      security, params: paperParams, body: { type: 'object', additionalProperties: false,
        required: ['pageNumber', 'stem'], properties: { pageNumber, stem: { type: 'string', maxLength: 8000 },
          sourcePages: { type: 'array', maxItems: 30, uniqueItems: true, items: pageNumber } } }
    }, bodyLimit: 40 * 1024 }, async (request, reply) => {
      const tenant = request.studySession!.id;
      const { pageNumber, stem: raw, sourcePages = [] } = request.body;
      const stem = raw.trim();
      if (!stem || stem.includes('\u0000')) return reply.code(400).send({ code: 'INVALID_QUESTION' });
      const key = [tenant, request.params.paperId, pageNumber, hash(stem)];
      const result = await asTenant(pool, tenant, async (db) => {
        const { rows: [paper] } = await db.query<{ count: number; model_allowed: boolean }>(`
          SELECT jsonb_array_length(pages) AS count, model_allowed FROM papers
          WHERE tenant_id = $1 AND id = $2 AND status = 'review' AND NOT is_prediction AND jsonb_array_length(pages) >= $3
          FOR UPDATE
        `, key.slice(0, 3));
        if (!paper) return null;
        if (sourcePages.some(page => page > paper.count) || sourcePages.includes(pageNumber)) return { invalidSources: true };
        if (await closedBookActive(db, tenant, request.params.paperId)) return { locked: true };
        const inserted = await db.query(`
          INSERT INTO paper_questions (tenant_id, paper_id, page_number, fingerprint, stem, source_pages, solution_status) VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (tenant_id, paper_id, page_number, fingerprint) DO NOTHING RETURNING id
        `, [...key, stem, sourcePages.length ? [pageNumber, ...sourcePages] : [],
          (privatePapers?.modelsEnabled || localModelPreview) && paper.model_allowed ? 'queued' : null]);
        if (inserted.rowCount) {
          await db.query('UPDATE papers SET share_school_id=NULL, school_content_key=NULL WHERE tenant_id=$1 AND id=$2 AND (share_school_id IS NOT NULL OR school_content_key IS NOT NULL)', key.slice(0, 2));
          return { id: inserted.rows[0].id, reused: false };
        }
        const existing = await db.query(`
          SELECT id FROM paper_questions WHERE tenant_id = $1 AND paper_id = $2 AND page_number = $3 AND fingerprint = $4
        `, key);
        return { id: existing.rows[0].id, reused: true };
      });
      if (!result) return reply.code(404).send({ code: 'PAPER_NOT_FOUND' });
      if ('invalidSources' in result) return reply.code(400).send({ code: 'INVALID_SOURCE_PAGES' });
      if ('locked' in result) return reply.code(409).send({ code: 'CLOSED_BOOK_ACTIVE' });
      return reply.code(result.reused ? 200 : 201).send(result);
    });
  app.post<{ Params: { paperId: string; questionId: string }; Body: QuestionReference }>(
    prefix + '/papers/:paperId/questions/:questionId/reference', { schema: {
      security, params: { type: 'object', required: ['paperId', 'questionId'], properties: { paperId: uuid, questionId: uuid } },
      body: { type: 'object', additionalProperties: false, required: ['kind', 'source', 'answers', 'explanation'], properties: {
        kind: { type: 'string', enum: ['choice', 'numeric', 'manual'] },
        source: { type: 'string', enum: ['teacher', 'verified'] },
        answers: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'string', minLength: 1, maxLength: 1000 } },
        explanation: { type: 'string', maxLength: 2000 }
      } }
    }, bodyLimit: 128 * 1024 }, async (request, reply) => {
      const { kind, source, answers, explanation } = request.body;
      const values = answers.map(answer => answer.trim());
      if (values.some(value => !value || value.includes('\u0000') || (kind !== 'manual' && normalizeAnswer(value, kind) === null))
          || explanation.includes('\u0000')) {
        return reply.code(400).send({ code: 'INVALID_REFERENCE' });
      }
      const tenant = request.studySession!.id;
      const { paperId, questionId } = request.params;
      const reference = { kind, source, answers: values, explanation: explanation.trim() };
      const result = await asTenant(pool, tenant, db => db.query(`
        UPDATE paper_questions SET reference = $4
        WHERE tenant_id = $1 AND paper_id = $2 AND id = $3 RETURNING id
      `, [tenant, paperId, questionId, JSON.stringify(reference)]));
      return result.rowCount ? { reference } : reply.code(404).send({ code: 'PAPER_NOT_FOUND' });
    });
  app.post<{ Params: { paperId: string; questionId: string } }>(
    prefix + '/papers/:paperId/questions/:questionId/solution', { schema: {
      security, params: { type: 'object', required: ['paperId', 'questionId'], properties: { paperId: uuid, questionId: uuid } }
    } }, async (request, reply) => {
      if (privatePapers && !privatePapers.modelsEnabled) return reply.code(409).send({ code: 'SOLUTION_UNAVAILABLE' });
      const tenant = request.studySession!.id;
      const { paperId, questionId } = request.params;
      const result = await asTenant(pool, tenant, db => db.query(`
        UPDATE paper_questions SET solution_status = 'queued', solution_attempt_count = 0
        WHERE tenant_id = $1 AND paper_id = $2 AND id = $3
          AND (solution_status IS NULL OR solution_status = 'failed')
          AND EXISTS (SELECT 1 FROM papers WHERE tenant_id = $1 AND id = $2 AND model_allowed)
      `, [tenant, paperId, questionId]));
      return result.rowCount ? reply.code(202).send({ status: 'queued' })
        : reply.code(409).send({ code: 'SOLUTION_UNAVAILABLE' });
    });
}
