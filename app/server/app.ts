import { randomBytes } from 'node:crypto';
import { registerPredictionRoutes } from './predictions.js';
import { registerMistakeRoutes } from './mistakes.js';
import { registerPracticeRoutes } from './practice.js';
import Fastify, { type FastifyError } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import staticFiles from '@fastify/static';
import type { Pool } from 'pg';
import { registerPaperRoutes } from './papers.js';
import * as schema from '../contracts/api.js';
import { authLimit, csrfToken, digest, findSession, login, register, sessionLifetime, validCsrf } from './auth.js';
import { getProgress, saveCourse, saveExamTime, type CourseInput } from './courses.js';
import { recoverySecret, registerPasswordRecovery } from './password-recovery.js';
import { registerSchoolIdentity } from './school-identity.js';
import type { PrivatePapers } from './paper-uploads.js';

const cookieName = 'beitibao_session';
const prefix = '/api/v1';
const readMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
const errorSchema = { type: 'object', required: ['code'], properties: { code: { type: 'string' } } };

export async function createApp({ pool, origin, secureCookies = true, exposeOpenApi = false, localPapers = false, localModelPreview = false, pdfOnlyUploads = false,
  passwordRecovery = recoverySecret(), trustedProxies = [], accountAdminEmail, privatePapers, webRoot }: {
  pool: Pool; origin: string; secureCookies?: boolean; exposeOpenApi?: boolean; localPapers?: boolean; localModelPreview?: boolean; pdfOnlyUploads?: boolean;
  passwordRecovery?: Buffer | null; trustedProxies?: string[]; accountAdminEmail?: string;
  privatePapers?: PrivatePapers;
  webRoot?: string;
}) {
  const app = Fastify({ bodyLimit: 16 * 1024, trustProxy: trustedProxies.length ? trustedProxies : false,
    ajv: { customOptions: { removeAdditional: false } } });
  await app.register(cookie);
  await app.register(cors, { origin, credentials: true, allowedHeaders: ['Content-Type', 'X-CSRF-Token'] });
  await app.register(swagger, { openapi: {
    info: { title: '背题宝 API', version: '0.1.0' },
    components: { securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: cookieName } } }
  } });
  const cookieOptions = { httpOnly: true, secure: secureCookies, sameSite: 'lax' as const, path: prefix };

  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    if (secureCookies) {
      reply.header('Strict-Transport-Security', 'max-age=31536000');
      reply.header('Referrer-Policy', 'no-referrer');
    }
    if (!request.url.startsWith(prefix + '/')) return;
    reply.header('Cache-Control', 'no-store');
    if (!readMethods.has(request.method) && request.headers.origin !== origin) {
      return reply.code(403).send({ code: 'ORIGIN_REJECTED' });
    }
  });

  app.setErrorHandler((error, request, reply) => {
    const details = error instanceof Error ? error as Partial<FastifyError> : {};
    const status = details.statusCode ?? 500;
    if (status >= 500) {
      console.error(JSON.stringify({ requestId: request.id, code: 'API_REQUEST_FAILED', reason: details.code ?? 'INTERNAL_ERROR' }));
      return reply.code(500).send({ code: 'INTERNAL_ERROR' });
    }
    return reply.code(status).send({ code: 'INVALID_REQUEST' });
  });
  if (privatePapers) app.addHook('onResponse', async (request, reply) => {
    if (request.routeOptions.url?.startsWith(prefix + '/') && (reply.statusCode >= 500 || reply.elapsedTime > 500)) {
      console.log(JSON.stringify({ code: 'API_REQUEST_TIMING', route: request.routeOptions.url,
        method: request.method, status: reply.statusCode, elapsedMs: Math.round(reply.elapsedTime) }));
    }
  });

  app.get('/healthz', async () => ({ status: 'ok' }));
  if (privatePapers) app.get('/readyz', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      await pool.query('SELECT 1 FROM paper_uploads LIMIT 0');
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });
  if (webRoot) {
    await app.register(staticFiles, { root: webRoot, index: false, wildcard: false, cacheControl: false,
      setHeaders(response, file) {
        response.header('Cache-Control', file.endsWith('/index.html') ? 'no-store' : 'public, max-age=31536000, immutable');
        if (file.endsWith('/index.html')) response.header('Content-Security-Policy',
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; " +
          "connect-src 'self' https://*.oss-cn-beijing.aliyuncs.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
      }
    });
    app.get('/', async (_request, reply) => reply.sendFile('index.html'));
  }
  if (exposeOpenApi) app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());
  registerPasswordRecovery(app, pool, prefix, passwordRecovery);

  app.post<{ Body: { email?: string; phone?: string; password: string; invite: string } }>(prefix + '/auth/register',
    { schema: { body: schema.registration, response: { 201: schema.session, 409: errorSchema, 429: errorSchema } } },
    async (request, reply) => {
      if (!await authLimit(pool, 'register-ip', request.ip, 20)) {
        return reply.header('Retry-After', '900').code(429).send({ code: 'RATE_LIMITED' });
      }
      const email = request.body.email?.toLowerCase();
      const phone = request.body.phone;
      const token = await register(pool, { ...request.body, email });
      if (!token) return reply.code(409).send({ code: 'INVITATION_UNAVAILABLE' });
      return reply.setCookie(cookieName, token, { ...cookieOptions, maxAge: sessionLifetime })
        .code(201).send({ ...(phone ? { phone } : { email }), csrfToken: csrfToken(token), ...(email && email === accountAdminEmail && { isAdmin: true }) });
    });

  app.post<{ Body: { email?: string; phone?: string; password: string } }>(prefix + '/auth/login',
    { schema: { body: schema.credentials, response: { 200: schema.session, 401: errorSchema, 429: errorSchema } } },
    async (request, reply) => {
      const email = request.body.email?.toLowerCase();
      const phone = request.body.phone;
      if (!await authLimit(pool, 'login-ip', request.ip, 50) || !await authLimit(pool, 'login-email', (email ?? phone)!, 10)) {
        return reply.header('Retry-After', '900').code(429).send({ code: 'RATE_LIMITED' });
      }
      const token = await login(pool, { ...request.body, email });
      if (!token) return reply.code(401).send({ code: 'INVALID_CREDENTIALS' });
      return reply.setCookie(cookieName, token, { ...cookieOptions, maxAge: sessionLifetime })
        .send({ ...(phone ? { phone } : { email }), csrfToken: csrfToken(token), ...(email && email === accountAdminEmail && { isAdmin: true }) });
    });

  await app.register(async (protectedRoutes) => {
    protectedRoutes.addHook('onRequest', async (request, reply) => {
      const current = await findSession(pool, request.cookies[cookieName]);
      if (!current) return reply.code(401).send({ code: 'AUTH_REQUIRED' });
      if (!readMethods.has(request.method) && !validCsrf(current.token, request.headers['x-csrf-token'])) {
        return reply.code(403).send({ code: 'CSRF_REJECTED' });
      }
      request.studySession = current;
    });

    const security = [{ session: [] }];
    protectedRoutes.get(prefix + '/auth/session',
      { schema: { security, response: { 200: schema.session } } }, async (request) => ({
        ...(request.studySession!.phone ? { phone: request.studySession!.phone } : { email: request.studySession!.email }),
        csrfToken: csrfToken(request.studySession!.token),
        ...(request.studySession!.email === accountAdminEmail && { isAdmin: true })
      }));

    protectedRoutes.get(prefix + '/admin/access', { schema: { security } }, async (request, reply) => {
      if (!accountAdminEmail || request.studySession!.email !== accountAdminEmail) {
        return reply.code(403).send({ code: 'ADMIN_REQUIRED' });
      }
      return { email: request.studySession!.email };
    });

    protectedRoutes.get(prefix + '/admin/invitations', { schema: { security } }, async (request, reply) => {
      if (!accountAdminEmail || request.studySession!.email !== accountAdminEmail) {
        return reply.code(403).send({ code: 'ADMIN_REQUIRED' });
      }
      const { rows } = await pool.query(`
        SELECT email, phone, expires_at AS "expiresAt", used_at AS "usedAt", subject_limit AS "subjectLimit",
          CASE WHEN used_at IS NOT NULL THEN 'used'
            WHEN expires_at <= now() THEN 'expired' ELSE 'pending' END AS status
        FROM invitations ORDER BY expires_at DESC, email LIMIT 50
      `);
      return { invitations: rows };
    });

    protectedRoutes.post<{ Body: { email?: string; phone?: string; subjectLimit?: number } }>(prefix + '/admin/invitations', {
      schema: { security, body: {
        type: 'object', additionalProperties: false, oneOf: schema.oneIdentity,
        properties: { email: schema.credentials.properties.email, phone: schema.phone, subjectLimit: { type: 'integer', minimum: 0, maximum: 1000 } }
      } }
    }, async (request, reply) => {
      const current = request.studySession!;
      if (!accountAdminEmail || current.email !== accountAdminEmail) {
        return reply.code(403).send({ code: 'ADMIN_REQUIRED' });
      }
      if (!await authLimit(pool, 'admin-invite', current.id, 60)) {
        return reply.header('Retry-After', '900').code(429).send({ code: 'RATE_LIMITED' });
      }
      const email = request.body.email?.toLowerCase();
      const phone = request.body.phone;
      const token = randomBytes(32).toString('base64url');
      const result = await pool.query<{ expires_at: Date }>(`
        INSERT INTO invitations (token_hash, email, phone, expires_at, subject_limit)
        SELECT $1, $2, $3, now() + interval '24 hours', $4
        WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE email = $2 OR phone = $3)
        RETURNING expires_at
      `, [digest(token), email ?? null, phone ?? null, request.body.subjectLimit ?? null]);
      const invitation = result.rows[0];
      if (!invitation) return reply.code(409).send({ code: 'ACCOUNT_EXISTS' });
      return reply.code(201).send({ ...(phone ? { phone } : { email }), invite: token, expiresAt: invitation.expires_at.toISOString(), subjectLimit: request.body.subjectLimit ?? null });
    });

    registerSchoolIdentity(protectedRoutes, pool, prefix, accountAdminEmail);

    protectedRoutes.get<{ Querystring: { email?: string } }>(prefix + '/admin/accounts', {
      schema: { security, querystring: { type: 'object', properties: { email: { type: 'string', maxLength: 254 } } } }
    }, async (request, reply) => {
      if (!accountAdminEmail || request.studySession!.email !== accountAdminEmail) {
        return reply.code(403).send({ code: 'ADMIN_REQUIRED' });
      }
      const { rows } = await pool.query(`
        SELECT a.id, a.email, a.phone, a.subject_limit AS "subjectLimit", s.name AS "schoolName"
        FROM accounts a LEFT JOIN schools s ON s.id = a.school_id
        WHERE strpos(coalesce(a.phone, a.email), lower($1)) > 0 OR $1 = ''
        ORDER BY coalesce(phone, email) LIMIT 50
      `, [request.query.email?.trim() ?? '']);
      return { accounts: rows };
    });

    protectedRoutes.post<{ Params: { accountId: string }; Body: { subjectLimit: number } }>(
      prefix + '/admin/accounts/:accountId/subject-limit', { schema: {
        security, params: { type: 'object', required: ['accountId'], properties: { accountId: { type: 'string', format: 'uuid' } } },
        body: { type: 'object', required: ['subjectLimit'], additionalProperties: false,
          properties: { subjectLimit: { type: 'integer', minimum: 0, maximum: 1000 } } }
      } }, async (request, reply) => {
        if (!accountAdminEmail || request.studySession!.email !== accountAdminEmail) {
          return reply.code(403).send({ code: 'ADMIN_REQUIRED' });
        }
        const { rows: [account] } = await pool.query(`
          UPDATE accounts SET subject_limit = $2 WHERE id = $1
          RETURNING id, email, phone, subject_limit AS "subjectLimit"
        `, [request.params.accountId, request.body.subjectLimit]);
        return account ?? reply.code(404).send({ code: 'ACCOUNT_NOT_FOUND' });
      });

    protectedRoutes.post(prefix + '/auth/logout', { schema: { security } }, async (request, reply) => {
      await pool.query('DELETE FROM sessions WHERE token_hash = $1', [digest(request.studySession!.token)]);
      return reply.clearCookie(cookieName, cookieOptions).code(204).send();
    });

    protectedRoutes.post<{ Body: CourseInput }>(prefix + '/courses',
      { schema: { security, body: schema.courseInput, response: { 200: schema.courseResult, 201: schema.courseResult } } },
      async (request, reply) => {
        const result = await saveCourse(pool, request.studySession!.id, request.body);
        if (!result) return reply.code(400).send({ code: 'INVALID_COURSE' });
        if ('limitReached' in result) return reply.code(409).send({ code: 'SUBJECT_LIMIT_REACHED', limit: result.limitReached });
        return reply.code(result.reused ? 200 : 201).send(result);
      });

    protectedRoutes.post<{ Params: { courseId: string }; Body: { examAt: string | null } }>(
      prefix + '/courses/:courseId/exam-time', { schema: {
        security,
        params: { type: 'object', required: ['courseId'], properties: { courseId: { type: 'string', format: 'uuid' } } },
        body: { type: 'object', required: ['examAt'], additionalProperties: false,
          properties: { examAt: { anyOf: [{ type: 'null' }, { type: 'string', pattern: '^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$' }] } } }
      } }, async (request, reply) => {
        const { examAt } = request.body;
        if (examAt !== null) {
          const parsed = new Date(examAt + ':00Z');
          if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 16) !== examAt) {
            return reply.code(400).send({ code: 'INVALID_EXAM_TIME' });
          }
        }
        const result = await saveExamTime(pool, request.studySession!.id, request.params.courseId, examAt);
        return result ?? reply.code(404).send({ code: 'COURSE_NOT_FOUND' });
      });

    protectedRoutes.get(prefix + '/progress',
      { schema: { security, response: { 200: schema.courseProgress } } },
      async (request) => getProgress(pool, request.studySession!.id));
    if (localPapers || privatePapers) {
      registerPaperRoutes(protectedRoutes, pool, prefix, privatePapers, localModelPreview, pdfOnlyUploads);
      registerPracticeRoutes(protectedRoutes, pool, prefix, privatePapers?.modelsEnabled);
      registerMistakeRoutes(protectedRoutes, pool, prefix);
      registerPredictionRoutes(protectedRoutes, pool, prefix, privatePapers?.predictionsEnabled, Boolean(privatePapers) || localModelPreview);
    }
  });

  return app;
}

declare module 'fastify' {
  interface FastifyRequest {
    studySession: Awaited<ReturnType<typeof findSession>>;
  }
}
