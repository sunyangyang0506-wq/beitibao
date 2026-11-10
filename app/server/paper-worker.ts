import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { Pool } from 'pg';
import { isImageType, recognizeImage } from './image-recognition.js';
import { loadOrProcessPaper, PaperCacheBusy, solvePaper } from './paper-model-cache.js';
import { modelRequest } from './model-gateway.js';
import { transaction } from './db.js';
import { extractPages } from './paper-parser.js';
import { loadPaperOriginal, type PaperOriginal, type PaperStorage } from './paper-storage.js';
import { applySchoolPdf, prepareSchoolPdf } from './school-paper-reuse.js';
import { queueCoursePrediction } from './predictions.js';
import type { JobTarget } from './job-outbox.js';

function scanPages(pages: string[]) {
  return pages.flatMap((text, index) => {
    const invalid = text.match(/\uFFFD|[\u0000-\u0008\u000B\u000E-\u001F]/gu)?.length ?? 0;
    return !/[\p{L}\p{N}]/u.test(text) || invalid > Math.max(1, text.length * 0.05) ? [index + 1] : [];
  });
}

export async function processNextPaper(pool: Pool, recognize = recognizeImage, solve = solvePaper,
  privateWorker?: { storage?: PaperStorage; modelsEnabled: boolean; predictionsEnabled?: boolean }, target?: JobTarget, recognizeAllPdfPages = false) {
  const leaseId = randomUUID();
  const { rows: [paper] } = await pool.query<PaperOriginal & {
    tenant_id: string; id: string; model_cache_key: string | null; recognize_scans: boolean; model_allowed: boolean; course_id: string | null; fingerprint: string; school_page_hashes: string[] | null;
  }>(`
    WITH next AS (
      SELECT tenant_id, id FROM papers
      WHERE (status = 'queued' OR (status = 'processing' AND lease_until <= now()))
        AND ($2::uuid IS NULL OR (tenant_id, id) = ($2, $3::uuid))
      ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
    )
    UPDATE papers AS p SET status = 'processing', lease_id = $1, lease_until = now() + interval '180 seconds'
    FROM next WHERE (p.tenant_id, p.id) = (next.tenant_id, next.id)
    RETURNING p.tenant_id, p.id, p.pdf, p.media_type, p.object_key, p.object_version, p.object_bytes,
      p.model_cache_key, p.recognize_scans, p.model_allowed, p.course_id, p.fingerprint, p.school_page_hashes
  `, [leaseId, target?.tenant ?? null, target?.id ?? null]);
  if (!paper) return false;

  let pages: string[] | null = null;
  let recognition: Awaited<ReturnType<typeof recognizeImage>> | null = null;
  let failure: string | null = null;
  const mediaType = paper.media_type;
  const modelsEnabled = paper.model_allowed && (privateWorker?.modelsEnabled ?? true);
  let validPrivateImage = false;
  let schoolHashes: string[] | null = null;
  try {
    const original = await loadPaperOriginal(paper, privateWorker?.storage).catch(() => {
      throw new Error('PAPER_ORIGINAL_UNAVAILABLE');
    });
    if (privateWorker && isImageType(mediaType)) {
      const { width, height, format } = await sharp(original, { limitInputPixels: 25_000_000 }).metadata();
      if (!width || !height || width * height > 25_000_000 || format !== (mediaType === 'image/jpeg' ? 'jpeg' : 'png')) {
        throw new Error('INVALID_IMAGE');
      }
      validPrivateImage = true;
    }
    if (mediaType === 'application/pdf') {
      pages = await extractPages(original);
      schoolHashes = await prepareSchoolPdf(pool, paper, original, pages.length).catch(() => null);
    }
    const request = modelRequest(pool, paper.tenant_id, 'paper');
    const extract = async () => {
      if (isImageType(mediaType)) return {
        recognition: modelsEnabled ? await recognize(original, mediaType, request) : null, pages: ['']
      };
      const text = pages!;
      return { recognition: null, pages: text, skipSolutions: recognizeAllPdfPages || scanPages(text).length > 0 };
    };
    const result = modelsEnabled && paper.model_cache_key && !schoolHashes
      ? await loadOrProcessPaper(pool, paper.tenant_id, paper.model_cache_key, extract, (text, image, questions) => solve(text, image, questions, request),
          isImageType(mediaType) ? { bytes: original, mediaType } : undefined)
      : await extract();
    pages = result.pages;
    recognition = result.recognition;
  } catch (error) {
    if (error instanceof PaperCacheBusy) {
      await pool.query(`
        UPDATE papers SET lease_until = now() + interval '5 seconds'
        WHERE tenant_id = $1 AND id = $2 AND lease_id = $3
      `, [paper.tenant_id, paper.id, leaseId]);
      return true;
    }
    const code = error instanceof Error ? error.message : '';
    failure = code === 'PAPER_ORIGINAL_UNAVAILABLE' ? code : isImageType(mediaType)
      ? (code === 'OCR_NOT_CONFIGURED' ? code : 'OCR_FAILED') : 'PDF_PARSE_FAILED';
    if (validPrivateImage) pages = [''];
  }

  await transaction(pool, async db => {
    if (pages && schoolHashes) {
      const reused = await applySchoolPdf(db, paper, leaseId, schoolHashes, pages, modelsEnabled);
      if (reused.state === 'waiting') return;
      if (reused.state === 'copied') {
        if (reused.courseId && (privateWorker?.predictionsEnabled ?? modelsEnabled)) {
          await queueCoursePrediction(db, paper.tenant_id, reused.courseId);
        }
        return;
      }
    }
    const update = await db.query(`
      UPDATE papers SET status = $4, pages = $5, failure = $6, recognition = $7, lease_id = NULL, lease_until = NULL
      WHERE tenant_id = $1 AND id = $2 AND lease_id = $3
    `, [paper.tenant_id, paper.id, leaseId, pages ? 'review' : 'failed',
      JSON.stringify(pages ?? []), failure, recognition ? JSON.stringify(recognition) : null]);
    if (update.rowCount && pages && mediaType === 'application/pdf' && (recognizeAllPdfPages || paper.recognize_scans || schoolHashes) && modelsEnabled) {
      const scans = paper.object_key || recognizeAllPdfPages || schoolHashes ? pages.map((_, index) => index + 1) : scanPages(pages);
      if (scans.length) await db.query(`
        INSERT INTO paper_page_recognition (tenant_id, paper_id, page_number)
        SELECT $1, $2, unnest($3::integer[]) ON CONFLICT DO NOTHING
      `, [paper.tenant_id, paper.id, scans]);
    }
  });
  return true;
}
