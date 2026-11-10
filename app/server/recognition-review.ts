import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { compareFigure, cropOriginal, figureBox, isNumericSearchTree, type PaperFigure } from './paper-figures.js';
import { isImageType, rereadFigure, type recognizeImage } from './image-recognition.js';
import { modelRequest } from './model-gateway.js';
import { closedBookActive } from './practice.js';
import { asTenant, lockCourseMaterial } from './db.js';
import { choiceOptionCount, completeChoiceStem } from './paper-choices.js';
import { renderPage } from './paper-parser.js';
import { candidatesPerPage, pdfRecognitionSize } from './pdf-page-recognition.js';
import { loadPaperOriginal, type PaperOriginal, type PaperStorage } from './paper-storage.js';
import type { PrivatePapers } from './paper-uploads.js';

const maxCandidate = 30 * candidatesPerPage - 1;
const paperIdParam = { type: 'string', format: 'uuid' };
const params = { type: 'object', required: ['paperId'], properties: { paperId: paperIdParam } };
const figureParams = { type: 'object', required: ['paperId', 'candidate', 'figure'], properties: {
  paperId: paperIdParam, candidate: { type: 'integer', minimum: 0, maximum: maxCandidate },
  figure: { type: 'integer', minimum: 0, maximum: 3 }
} };
const security = [{ session: [] }];
type FigureParams = { paperId: string; candidate: number; figure: number };
type CandidateDocument = PaperOriginal & {
  model_allowed: boolean; recognition: Awaited<ReturnType<typeof recognizeImage>> | null;
  reviewed_at: string | null;
};
type CandidateSource = CandidateDocument & { page: number; index: number };

async function loadCandidate(db: PoolClient, tenant: string, paperId: string, candidate: number, lock = false, withImage = true) {
  const page = Math.floor(candidate / candidatesPerPage) + 1;
  const { rows: [paper] } = await db.query<CandidateDocument>(`
    SELECT ${withImage ? 'p.pdf, p.object_key, p.object_version, p.object_bytes' :
      'NULL AS pdf, NULL AS object_key, NULL AS object_version, NULL AS object_bytes'}, p.media_type, p.model_allowed, r.reviewed_at,
      CASE WHEN p.media_type = 'application/pdf' THEN r.recognition ELSE p.recognition END AS recognition
    FROM papers p LEFT JOIN paper_page_recognition r
      ON (p.tenant_id, p.id, r.page_number) = (r.tenant_id, r.paper_id, $3)
    WHERE p.tenant_id = $1 AND p.id = $2 AND p.status = 'review' AND NOT p.is_prediction
      AND (p.media_type = 'application/pdf' OR $3 = 1)
    ${lock ? 'FOR UPDATE OF p' : ''}
  `, [tenant, paperId, page]);
  return paper ? { ...paper, page, index: candidate % candidatesPerPage } : null;
}

async function originalImage(source: CandidateSource, storage?: PaperStorage) {
  const bytes = await loadPaperOriginal(source, storage);
  return isImageType(source.media_type) ? bytes : renderPage(bytes, source.page, pdfRecognitionSize);
}

async function updateFigure(db: PoolClient, tenant: string, { paperId, figure }: FigureParams,
  source: CandidateSource, value: PaperFigure) {
  const path = ['figures', String(source.index), String(figure)];
  const parameters = [tenant, paperId, path, JSON.stringify(value)];
  if (isImageType(source.media_type)) {
    await db.query('UPDATE papers SET recognition = jsonb_set(recognition, $3, $4) WHERE tenant_id = $1 AND id = $2', parameters);
  } else {
    await db.query(`
      UPDATE paper_page_recognition SET recognition = jsonb_set(recognition, $3, $4)
      WHERE tenant_id = $1 AND paper_id = $2 AND page_number = $5
    `, [...parameters, source.page]);
  }
}

async function hasReview(db: PoolClient, tenant: string, paperId: string, candidate: number) {
  const result = await db.query('SELECT 1 FROM recognition_feedback WHERE tenant_id = $1 AND paper_id = $2 AND candidate_index = $3',
    [tenant, paperId, candidate]);
  return Boolean(result.rowCount);
}

type SavedImagePaper = { status: string; media_type: string; model_allowed: boolean; is_prediction?: boolean;
  recognition: Awaited<ReturnType<typeof recognizeImage>> | null };

export async function savedImageCandidates(db: PoolClient, tenant: string, paperId: string, paper: SavedImagePaper) {
  const recognition = paper.recognition;
  if (!isImageType(paper.media_type) || paper.status !== 'review' || !paper.model_allowed || paper.is_prediction ||
      !recognition || !Array.isArray(recognition.stems) || recognition.stems.length > candidatesPerPage) return null;
  const { rows: feedback } = await db.query<{ candidate_index: number }>(
    'SELECT candidate_index FROM recognition_feedback WHERE tenant_id=$1 AND paper_id=$2', [tenant, paperId]);
  const { rows: questions } = await db.query<{ fingerprint: string }>(
    'SELECT fingerprint FROM paper_questions WHERE tenant_id=$1 AND paper_id=$2 AND page_number=1', [tenant, paperId]);
  const reviewed = new Set(feedback.map(row => row.candidate_index));
  const saved = new Set(questions.map(row => row.fingerprint));
  const candidates: { stem: string; fingerprint: string; kind: string }[] = [];
  let skipped = 0, pending = 0;
  for (const [index, original] of recognition.stems.entries()) {
    if (reviewed.has(index)) { skipped++; continue; }
    if (typeof original !== 'string' || !original.trim() || original.includes('\u0000') || [...original].length > 8000) {
      pending++; continue;
    }
    const stem = completeChoiceStem(original.trim(), choiceOptionCount(original,
      recognition.choiceCounts?.[index], recognition.choiceOnly));
    if (!stem) { pending++; continue; }
    const fingerprint = createHash('sha256').update(stem).digest('hex');
    if (saved.has(fingerprint)) { skipped++; continue; }
    const figures = recognition.figures?.[index];
    if ((figures && (!Array.isArray(figures) || figures.some(figure => !figure || figure.status !== 'consistent'))) ||
        (recognition.visualContexts?.[index] && !figures?.length && !recognition.resolvedContexts?.[index])) {
      pending++; continue;
    }
    const kind = /(^|\s)A[.、．)]/u.test(stem) && /(^|\s)B[.、．)]/u.test(stem) ? 'choice'
      : /计算|求出|求值|求其|求下列/u.test(stem) ? 'calculation' : /____/u.test(stem) ? 'fill' : 'other';
    candidates.push({ stem, fingerprint, kind });
    saved.add(fingerprint);
  }
  return { candidates, skipped, pending };
}

export function registerRecognitionReview(app: FastifyInstance, pool: Pool, prefix: string, privatePapers?: PrivatePapers, localModelPreview = false) {
  const route = prefix + '/papers/:paperId/recognition/:candidate/figures/:figure';
  let cropPreviews = 0;
  app.get<{ Params: FigureParams }>(route, { schema: { security, params: figureParams } }, async (request, reply) => {
    if (cropPreviews >= 2) return reply.code(429).send({ code: 'PREVIEW_BUSY' });
    cropPreviews++;
    try {
      const { paperId, candidate, figure } = request.params;
      const tenant = request.studySession!.id;
      const source = await asTenant(pool, tenant, async db =>
        await closedBookActive(db, tenant, paperId) ? { locked: true } as const : loadCandidate(db, tenant, paperId, candidate));
      if (source && 'locked' in source) return reply.code(409).send({ code: 'CLOSED_BOOK_ACTIVE' });
      const box = source && figureBox(source.recognition?.figures?.[source.index]?.[figure]?.box);
      if (!source || !box) return reply.code(404).send({ code: 'FIGURE_NOT_FOUND' });
      const crop = await originalImage(source, privatePapers?.storage(request.headers)).then(image => cropOriginal(image, box)).catch(() => null);
      if (!crop) return reply.code(422).send({ code: 'FIGURE_UNAVAILABLE' });
      return reply.header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'private, no-store')
        .type('image/png').send(crop);
    } finally {
      cropPreviews--;
    }
  });

  let activeRereads = 0;
  app.post<{ Params: FigureParams; Body: { box: number[] } }>(route + '/reread', { schema: {
    security, params: figureParams,
    body: { type: 'object', required: ['box'], additionalProperties: false, properties: {
      box: { type: 'array', minItems: 4, maxItems: 4, items: { type: 'integer', minimum: 0, maximum: 1000 } }
    } }
  } }, async (request, reply) => {
    if (privatePapers && !privatePapers.modelsEnabled) return reply.code(409).send({ code: 'FIGURE_REREAD_UNAVAILABLE' });
    const box = figureBox(request.body.box);
    if (!box) return reply.code(400).send({ code: 'INVALID_FIGURE_BOX' });
    if (activeRereads >= 2) return reply.code(429).send({ code: 'PREVIEW_BUSY' });
    const tenant = request.studySession!.id;
    const { paperId, candidate, figure } = request.params;
    activeRereads++;
    try {
      const reserved = await asTenant(pool, tenant, async db => {
        const source = await loadCandidate(db, tenant, paperId, candidate, true);
        if (source && await closedBookActive(db, tenant, paperId)) return { locked: true } as const;
        const figures = source?.recognition?.figures;
        const original = source && figures?.[source.index]?.[figure];
        if (!source || !original) return null;
        if (!source.model_allowed || source.reviewed_at || original.manualReread || figures!.flat().filter(item => item.manualReread).length >= 8
            || await hasReview(db, tenant, paperId, candidate)) return { unavailable: true };
        const { box: previousBox, initial, reread: previousReread, status, reason } = original;
        const pending: PaperFigure = { box, initial: original.initial, reread: null, status: 'needs_review',
          reason: 'manual', manualReread: true, previous: { box: previousBox, initial, reread: previousReread, status, reason } };
        await updateFigure(db, tenant, request.params, source, pending);
        return { source, pending };
      });
      if (!reserved) return reply.code(404).send({ code: 'FIGURE_NOT_FOUND' });
      if ('locked' in reserved) return reply.code(409).send({ code: 'CLOSED_BOOK_ACTIVE' });
      if ('unavailable' in reserved) return reply.code(409).send({ code: 'FIGURE_REREAD_UNAVAILABLE' });

      const { source, pending } = reserved;
      const stem = source.recognition?.stems[source.index] ?? '';
      const reread = await originalImage(source, privatePapers?.storage(request.headers))
        .then(image => rereadFigure(image, box, modelRequest(pool, tenant, 'figure'), isNumericSearchTree(stem, pending.initial)))
        .catch(() => null);
      const comparison = compareFigure(pending, reread, stem);
      const updated: PaperFigure = { ...comparison, status: 'needs_review', reason: comparison.reason ?? 'manual' };
      const saved = await asTenant(pool, tenant, async db => {
        // A concurrent human confirmation takes precedence over a late model result.
        await db.query('SELECT 1 FROM papers WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenant, paperId]);
        if (await hasReview(db, tenant, paperId, candidate)) return pending;
        await updateFigure(db, tenant, request.params, source, updated);
        return updated;
      });
      return { figure: saved };
    } finally {
      activeRereads--;
    }
  });

  app.post<{ Params: { paperId: string } }>(prefix + '/papers/:paperId/publish-saved-recognition',
    { schema: { params, security } }, async (request, reply) => {
      const tenant = request.studySession!.id;
      const paperId = request.params.paperId;
      const result = await asTenant(pool, tenant, async db => {
        const { rows: [course] } = await db.query<{ course_id: string | null }>(
          'SELECT course_id FROM papers WHERE tenant_id=$1 AND id=$2', [tenant, paperId]);
        if (course?.course_id) await lockCourseMaterial(db, tenant, course.course_id);
        const { rows: [paper] } = await db.query<{ status: string; media_type: string; model_allowed: boolean;
          recognition: Awaited<ReturnType<typeof recognizeImage>> | null }>(`
          SELECT status, media_type, model_allowed, recognition FROM papers
          WHERE tenant_id=$1 AND id=$2 AND NOT is_prediction FOR UPDATE
        `, [tenant, paperId]);
        if (!paper) return { code: 'PAPER_NOT_FOUND' };
        if (await closedBookActive(db, tenant, paperId)) return { code: 'CLOSED_BOOK_ACTIVE' };
        const available = await savedImageCandidates(db, tenant, paperId, paper);
        if (!available) return { code: 'RECOGNITION_UNAVAILABLE' };
        let published = 0, skipped = available.skipped;
        for (const { stem, fingerprint, kind } of available.candidates) {
          const saved = await db.query(`
            INSERT INTO paper_questions (tenant_id,paper_id,page_number,fingerprint,stem,question_kind)
            VALUES ($1,$2,1,$3,$4,$5)
            ON CONFLICT (tenant_id,paper_id,page_number,fingerprint) DO NOTHING
          `, [tenant, paperId, fingerprint, stem, kind]);
          if (saved.rowCount) published++; else skipped++;
        }
        // Do not manufacture human feedback, alter saved OCR/answers, or enqueue model work.
        return { published, skipped, pending: available.pending };
      });
      if ('code' in result) return reply.code(result.code === 'PAPER_NOT_FOUND' ? 404 : 409).send(result);
      return result;
    });

  app.post<{ Params: { paperId: string } }>(prefix + '/papers/:paperId/retry-recognition',
    { schema: { params, security } }, async (request, reply) => {
      const tenant = request.studySession!.id;
      const result = await asTenant(pool, tenant, db => db.query(`
        UPDATE papers SET status = 'queued', failure = NULL
        WHERE tenant_id = $1 AND id = $2 AND (
          (status = 'failed' AND object_key IS NOT NULL AND failure = 'PAPER_ORIGINAL_UNAVAILABLE') OR
          ($3 AND media_type IN ('image/png', 'image/jpeg') AND model_allowed AND (
            status = 'failed' OR (status = 'review' AND object_key IS NOT NULL AND failure IN ('OCR_FAILED', 'OCR_NOT_CONFIGURED')
              AND NOT EXISTS (SELECT 1 FROM paper_questions WHERE tenant_id = $1 AND paper_id = $2))
          )))
      `, [tenant, request.params.paperId, privatePapers?.modelsEnabled ?? true]));
      return result.rowCount ? reply.code(202).send({ status: 'queued' })
        : reply.code(409).send({ code: 'RECOGNITION_UNAVAILABLE' });
    });

  app.post<{ Params: { paperId: string }; Body: { candidateIndex: number; stem: string | null; visualReview?: string } }>(
    prefix + '/papers/:paperId/recognition-review', { bodyLimit: 64 * 1024, schema: {
      params, security,
      body: { type: 'object', additionalProperties: false, required: ['candidateIndex', 'stem'], properties: {
        candidateIndex: { type: 'integer', minimum: 0, maximum: maxCandidate },
        stem: { type: ['string', 'null'], maxLength: 8000 },
        visualReview: { type: 'string', minLength: 1, maxLength: 8000 }
      } }
    } }, async (request, reply) => {
      const tenant = request.studySession!.id;
      const { paperId } = request.params;
      const { candidateIndex, stem: raw } = request.body;
      const stem = raw === null ? null : raw.trim();
      const visualReview = stem === null ? null : request.body.visualReview?.trim() ?? null;
      if (stem === '' || stem?.includes('\u0000') || visualReview === '' || visualReview?.includes('\u0000')) {
        return reply.code(400).send({ code: 'INVALID_QUESTION' });
      }
      const result = await asTenant(pool, tenant, db => confirmCandidate(db, tenant, paperId, candidateIndex, stem, visualReview, privatePapers?.modelsEnabled ?? localModelPreview));
      if (!result) return reply.code(404).send({ code: 'RECOGNITION_UNAVAILABLE' });
      if ('locked' in result) return reply.code(409).send({ code: 'CLOSED_BOOK_ACTIVE' });
      if ('visualPending' in result) return reply.code(409).send({ code: 'FIGURE_REVIEW_REQUIRED' });
      if ('conflict' in result) return reply.code(409).send({ code: 'REVIEW_ALREADY_SAVED' });
      return result;
    });
}

async function confirmCandidate(db: PoolClient, tenant: string, paperId: string, candidate: number,
  stem: string | null, visualReview: string | null, modelsEnabled: boolean) {
  const source = await loadCandidate(db, tenant, paperId, candidate, true, false);
  const recognition = source?.recognition;
  const original = source && recognition?.stems[source.index];
  if (!source || !recognition || typeof original !== 'string') return null;
  if (await closedBookActive(db, tenant, paperId)) return { locked: true };
  const key = [tenant, paperId, candidate];
  const { rows: [existing] } = await db.query(`
    SELECT f.outcome, f.reviewed_stem, q.visual_review
    FROM recognition_feedback f LEFT JOIN paper_questions q ON q.tenant_id = f.tenant_id AND q.id = f.question_id
    WHERE f.tenant_id = $1 AND f.paper_id = $2 AND f.candidate_index = $3
  `, key);
  if (existing) return existing.reviewed_stem === stem && existing.visual_review === visualReview
    ? { outcome: existing.outcome } : { conflict: true };
  if (source.reviewed_at) return { conflict: true };
  if (stem !== null && recognition.figures?.[source.index]?.some(figure => figure.status === 'needs_review') && !visualReview) {
    return { visualPending: true };
  }
  let questionId = null;
  if (stem !== null) {
    const fingerprint = createHash('sha256').update(stem).digest('hex');
    const { rows: [question] } = await db.query(`
      INSERT INTO paper_questions (tenant_id, paper_id, page_number, fingerprint, stem, visual_review, solution_status)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (tenant_id, paper_id, page_number, fingerprint) DO NOTHING RETURNING id
    `, [tenant, paperId, source.page, fingerprint, stem, visualReview,
      modelsEnabled && source.model_allowed ? 'queued' : null]);
    if (question) questionId = question.id;
    else {
      const { rows: [saved] } = await db.query(`
        SELECT id, visual_review FROM paper_questions WHERE tenant_id = $1 AND paper_id = $2
          AND page_number = $3 AND fingerprint = $4
      `, [tenant, paperId, source.page, fingerprint]);
      if (visualReview !== saved.visual_review) return { conflict: true };
      questionId = saved.id;
    }
  }
  const outcome = stem === null ? 'rejected' : stem === original ? 'confirmed' : 'corrected';
  await db.query(`
    INSERT INTO recognition_feedback
      (tenant_id, paper_id, candidate_index, model, prompt_version, original_stem, reviewed_stem, outcome, question_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  `, [...key, recognition.model, recognition.promptVersion, original, stem, outcome, questionId]);
  return { outcome };
}
