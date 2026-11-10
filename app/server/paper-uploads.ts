import { createHash, randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { schoolOf } from './school-identity.js';
import { asTenant, lockCourseMaterial } from './db.js';
import { imagePromptVersion, isImageType, validImage } from './image-recognition.js';
import { paperSolutionVersion } from './paper-model-cache.js';
import { maxImageBytes, maxPrivatePdfBytes, objectVersionPattern, paperObjectKey, type PaperMediaType,
  type PaperStorage } from './paper-storage.js';

export type PrivatePapers = {
  storage: (headers: IncomingHttpHeaders) => PaperStorage;
  modelsEnabled: boolean;
  predictionsEnabled: boolean;
};

type Upload = {
  id: string; course_id: string | null; title: string; school: string | null; media_type: PaperMediaType;
  byte_count: number; fingerprint: string; model_allowed: boolean; auto_title: boolean; share_school_id: string | null; expires_at: Date; paper_id: string | null;
};

export const paperFields = 'id, course_id AS "courseId", title, recognized_subject AS "recognizedSubject", school_reuse AS "schoolReuse", share_school_id IS NOT NULL AS "sharedAtSchool", status, failure, media_type AS "mediaType", page_order AS "pageOrder", missing_pages AS "missingPages", review_revision AS "reviewRevision"';
const uuid = { type: 'string', format: 'uuid' };
export const uploadCourse = { anyOf: [uuid, { type: 'string', const: 'auto' }] };
const security = [{ session: [] }];
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const uploadFields = 'id, course_id, title, school, media_type, byte_count, fingerprint, model_allowed, auto_title, share_school_id, expires_at, paper_id';
const uploadWindowMs = 5 * 60_000;

function loadUpload(db: PoolClient, tenant: string, id: string, lock = false) {
  return db.query<Upload>(`SELECT ${uploadFields} FROM paper_uploads
    WHERE tenant_id = $1 AND id = $2 AND erased_at IS NULL${lock ? ' FOR UPDATE' : ''}`, [tenant, id]);
}

async function reusedPaper(db: PoolClient, tenant: string, paperId: string) {
  const { rows: [paper] } = await db.query(`SELECT ${paperFields} FROM papers WHERE tenant_id = $1 AND id = $2`, [tenant, paperId]);
  return { paper, reused: true, modelReused: false };
}

export function registerPrivatePaperUploads(app: FastifyInstance, pool: Pool, prefix: string, settings: PrivatePapers, pdfOnlyUploads = false) {
  let completing = 0;
  app.post<{ Params: { courseId: string }; Body: { title: string; school?: string; mediaType: PaperMediaType;
    bytes: number; sha256: string; rightsConfirmed: boolean; allowModels: boolean; redacted?: boolean; autoTitle?: boolean; shareAtSchool?: boolean } }>(
    prefix + '/courses/:courseId/paper-uploads', { schema: {
      security, params: { type: 'object', required: ['courseId'], properties: { courseId: uploadCourse } },
      body: { type: 'object', additionalProperties: false,
        required: ['title', 'mediaType', 'bytes', 'sha256', 'rightsConfirmed', 'allowModels'], properties: {
          title: { type: 'string', minLength: 1, maxLength: 200 },
          school: { type: 'string', minLength: 1, maxLength: 120 },
          mediaType: { type: 'string', enum: ['application/pdf', 'image/png', 'image/jpeg'] },
          bytes: { type: 'integer', minimum: 1, maximum: maxPrivatePdfBytes },
          sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
          rightsConfirmed: { type: 'boolean', const: true },
          allowModels: { type: 'boolean' },
          redacted: { type: 'boolean' },
          autoTitle: { type: 'boolean' },
          shareAtSchool: { type: 'boolean' }
        } }
    } }, async (request, reply) => {
      const { mediaType, bytes, sha256: fingerprint, allowModels, redacted, autoTitle, shareAtSchool } = request.body;
      if ((pdfOnlyUploads || request.params.courseId === 'auto') && mediaType !== 'application/pdf') return reply.code(415).send({ code: 'PDF_ONLY' });
      const title = request.body.title.trim();
      const school = request.body.school?.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase() || null;
      if (!title || [title, school].some(value => value?.includes('\u0000')) || (school && [...school].length > 120) ||
          (isImageType(mediaType) && bytes > maxImageBytes)) return reply.code(400).send({ code: 'INVALID_PAPER_UPLOAD' });
      if (allowModels && (!settings.modelsEnabled || !redacted)) {
        return reply.code(400).send({ code: 'MODEL_CONSENT_UNAVAILABLE' });
      }
      const tenant = request.studySession!.id;
      const courseId = request.params.courseId === 'auto' ? null : request.params.courseId;
      const store = settings.storage(request.headers);
      const result = await asTenant(pool, tenant, async db => {
        const schoolId = shareAtSchool && mediaType === 'application/pdf' && redacted && allowModels ? await schoolOf(db, tenant) : null;
        if (shareAtSchool && !schoolId) return 'sharing' as const;
        if (courseId && !(await db.query('SELECT 1 FROM courses WHERE tenant_id = $1 AND id = $2', [tenant, courseId])).rowCount) return null;
        await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 98217))', [tenant]);
        const { rows: [usage] } = await db.query<{ count: number }>(`
          SELECT count(*)::int AS count FROM paper_uploads
          WHERE tenant_id = $1 AND created_at > now() - interval '24 hours'
        `, [tenant]);
        if (usage!.count >= 30) return 'limited' as const;
        const id = randomUUID();
        const expiresAt = new Date(Date.now() + uploadWindowMs);
        const form = store.signUpload(paperObjectKey(tenant, id), mediaType, bytes, expiresAt);
        await db.query(`
          INSERT INTO paper_uploads (tenant_id, id, course_id, title, school, media_type, byte_count, fingerprint, model_allowed, expires_at, auto_title, share_school_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        `, [tenant, id, courseId, title, school, mediaType, bytes, fingerprint, allowModels, expiresAt, mediaType === 'application/pdf' && Boolean(autoTitle), schoolId]);
        return { uploadId: id, expiresAt: expiresAt.toISOString(), ...form };
      });
      if (result === 'sharing') return reply.code(403).send({ code: 'SCHOOL_SHARING_NOT_AUTHORIZED' });
      if (result === 'limited') return reply.code(429).send({ code: 'RATE_LIMITED' });
      return result ? reply.code(201).send(result) : reply.code(404).send({ code: 'COURSE_NOT_FOUND' });
    });

  app.post<{ Params: { uploadId: string }; Body: { versionId: string } }>(
    prefix + '/paper-uploads/:uploadId/complete', { schema: {
      security, params: { type: 'object', required: ['uploadId'], properties: { uploadId: uuid } },
      body: { type: 'object', additionalProperties: false, required: ['versionId'],
        properties: { versionId: { type: 'string', pattern: objectVersionPattern } } }
    } }, async (request, reply) => {
      const tenant = request.studySession!.id;
      const { uploadId } = request.params;
      const { versionId } = request.body;
      const { rows: [upload] } = await asTenant(pool, tenant, db => loadUpload(db, tenant, uploadId));
      if (!upload) return reply.code(404).send({ code: 'PAPER_UPLOAD_NOT_FOUND' });
      if (upload.paper_id) return asTenant(pool, tenant, db => reusedPaper(db, tenant, upload.paper_id!));
      if (pdfOnlyUploads && upload.media_type !== 'application/pdf') return reply.code(415).send({ code: 'PDF_ONLY' });
      if (upload.expires_at.getTime() <= Date.now()) return reply.code(410).send({ code: 'PAPER_UPLOAD_EXPIRED' });
      if (versionId === 'null') return reply.code(400).send({ code: 'INVALID_PAPER_OBJECT' });
      if (completing >= 2) return reply.header('Retry-After', '2').code(429).send({ code: 'PAPER_UPLOAD_BUSY' });
      const key = paperObjectKey(tenant, uploadId);
      completing++;
      try {
        const bytes = await settings.storage(request.headers).read({
          key, version: versionId, bytes: upload.byte_count, mediaType: upload.media_type
        });
        const image = isImageType(upload.media_type);
        if (!bytes || bytes.length !== upload.byte_count || sha256(bytes) !== upload.fingerprint ||
            (image ? !validImage(bytes, upload.media_type as 'image/jpeg' | 'image/png') :
              bytes.subarray(0, 5).toString() !== '%PDF-')) {
          return reply.code(422).send({ code: 'INVALID_PAPER_OBJECT' });
        }
        const result = await asTenant(pool, tenant, async db => {
          if (upload.course_id) await lockCourseMaterial(db, tenant, upload.course_id);
          const { rows: [current] } = await loadUpload(db, tenant, uploadId, true);
          if (!current) return null;
          if (current.paper_id) return reusedPaper(db, tenant, current.paper_id);
          if (current.expires_at.getTime() <= Date.now()) return null;
          const { rows: [course] } = await db.query<{ name: string }>(
            'SELECT name FROM courses WHERE tenant_id = $1 AND id = $2', [tenant, upload.course_id]);
          if (upload.course_id && !course) return null;
          const cacheKey = upload.model_allowed && course && upload.school ? sha256(JSON.stringify([tenant, upload.school,
            course.name.toLowerCase(), upload.fingerprint, paperSolutionVersion, image ? imagePromptVersion : null])) : null;
          const identity = [tenant, upload.course_id, upload.fingerprint, upload.school];
          if (!upload.course_id) {
            const { rows: [previous] } = await db.query(`
              SELECT id FROM papers WHERE tenant_id = $1 AND fingerprint = $2 AND auto_assignment AND NOT is_prediction
              ORDER BY created_at LIMIT 1
            `, [tenant, upload.fingerprint]);
            if (previous) {
              await db.query('UPDATE paper_uploads SET paper_id = $3 WHERE tenant_id = $1 AND id = $2', [tenant, uploadId, previous.id]);
              return reusedPaper(db, tenant, previous.id);
            }
          }
          const { rows: [paper] } = await db.query(`
            INSERT INTO papers (tenant_id, course_id, fingerprint, school, title, media_type, pdf,
              model_cache_key, object_key, object_version, object_bytes, model_allowed, recognize_scans, auto_title, auto_assignment, share_school_id)
            VALUES ($1,$2,$3,$4,$5,$6,''::bytea,$7,$8,$9,$10,$11,$12,$13,$2::uuid IS NULL,$14)
            ON CONFLICT DO NOTHING RETURNING ${paperFields}
          `, [...identity, upload.title, upload.media_type, cacheKey, key, versionId, upload.byte_count, upload.model_allowed, !image && upload.model_allowed, upload.auto_title, current.share_school_id]);
          const stored = paper ?? (await db.query(`
            SELECT ${paperFields} FROM papers WHERE tenant_id = $1 AND fingerprint = $3 AND (
              ($2::uuid IS NULL AND auto_assignment) OR (course_id IS NOT DISTINCT FROM $2 AND school IS NOT DISTINCT FROM $4)
            ) ORDER BY auto_assignment DESC LIMIT 1
          `, identity)).rows[0];
          await db.query('UPDATE paper_uploads SET paper_id = $3, kept_version = $4 WHERE tenant_id = $1 AND id = $2',
            [tenant, uploadId, stored.id, paper ? versionId : null]);
          const cached = paper && cacheKey && await db.query('SELECT cache_key FROM paper_model_cache WHERE cache_key = $1', [cacheKey]);
          return { paper: stored, reused: !paper, modelReused: Boolean(cached && cached.rowCount) };
        });
        return result ? reply.code(result.reused ? 200 : 202).send(result)
          : reply.code(410).send({ code: 'PAPER_UPLOAD_EXPIRED' });
      } finally {
        completing--;
      }
    });
}
