import { createHmac, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { authLimit, digest, hashPassword } from './auth.js';
import { transaction } from './db.js';
import { credentials } from '../contracts/api.js';

const ttlMinutes = 20;

export function recoverySecret(value = process.env.RECOVERY_TOKEN_SECRET) {
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) && Buffer.from(value, 'base64url').length === 32
    ? Buffer.from(value, 'base64url') : null;
}

function tokenFor(secret: Buffer, id: string) {
  return createHmac('sha256', secret).update('beitibao-password-reset:' + id).digest('base64url');
}

export function registerPasswordRecovery(app: FastifyInstance, pool: Pool, prefix: string, secret: Buffer | null) {
  const emailSchema = credentials.properties.email;
  const passwordSchema = credentials.properties.password;
  app.post<{ Body: { email: string } }>(prefix + '/auth/recovery/request', { schema: { body: {
    type: 'object', required: ['email'], additionalProperties: false, properties: { email: emailSchema }
  } } }, async (request, reply) => {
    if (!secret) return reply.code(503).send({ code: 'RECOVERY_NOT_CONFIGURED' });
    const email = request.body.email.toLowerCase();
    if (!await authLimit(pool, 'recovery-ip', request.ip, 10) || !await authLimit(pool, 'recovery-email', email, 3)) {
      return reply.header('Retry-After', '900').code(429).send({ code: 'RATE_LIMITED' });
    }
    const id = randomUUID();
    await pool.query(`
      INSERT INTO password_recovery (id, account_id, token_hash, expires_at)
      SELECT $1, id, $3, now() + make_interval(mins => $4::int) FROM accounts WHERE email = $2 FOR SHARE
    `, [id, email, digest(tokenFor(secret, id)), ttlMinutes]);
    return reply.code(202).send({ status: 'accepted' });
  });

  app.post<{ Body: { token: string; password: string } }>(prefix + '/auth/recovery/complete', { schema: { body: {
    type: 'object', required: ['token', 'password'], additionalProperties: false,
    properties: { token: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' }, password: passwordSchema }
  } } }, async (request, reply) => {
    if (!secret) return reply.code(503).send({ code: 'RECOVERY_NOT_CONFIGURED' });
    if (!await authLimit(pool, 'recovery-complete-ip', request.ip, 20)) {
      return reply.header('Retry-After', '900').code(429).send({ code: 'RATE_LIMITED' });
    }
    const invalid = () => reply.code(409).send({ code: 'RECOVERY_LINK_UNAVAILABLE' });
    const tokenHash = digest(request.body.token);
    const { rows: [eligible] } = await pool.query<{ account_id: string }>(`
      SELECT account_id FROM password_recovery WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
    `, [tokenHash]);
    if (!eligible) return invalid();
    const password = await hashPassword(request.body.password);
    const changed = await transaction(pool, async db => {
      const { rowCount } = await db.query('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [eligible.account_id]);
      if (!rowCount) return false;
      const claim = await db.query(`
        UPDATE password_recovery SET used_at = now() WHERE account_id = $1 AND token_hash = $2
          AND used_at IS NULL AND expires_at > clock_timestamp()
      `, [eligible.account_id, tokenHash]);
      if (!claim.rowCount) return false;
      await db.query('UPDATE accounts SET password_hash = $2 WHERE id = $1', [eligible.account_id, password]);
      await db.query('UPDATE password_recovery SET used_at = now() WHERE account_id = $1 AND used_at IS NULL', [eligible.account_id]);
      await db.query('DELETE FROM sessions WHERE account_id = $1', [eligible.account_id]);
      return true;
    });
    return changed ? reply.code(204).send() : invalid();
  });
}

type SendReset = (email: string, link: string, id: string) => Promise<void>;

export async function processNextPasswordRecovery(pool: Pool, secret: Buffer, origin: string, send: SendReset) {
  const lease = randomUUID();
  const { rows: [job] } = await pool.query<{ id: string; email: string; attempts: number }>(`
    WITH next AS (
      SELECT id FROM password_recovery
      WHERE sent_at IS NULL AND used_at IS NULL AND expires_at > now()
        AND attempts < 3 AND next_attempt_at <= now() AND (lease_until IS NULL OR lease_until <= now())
      ORDER BY next_attempt_at, id FOR UPDATE SKIP LOCKED LIMIT 1
    )
    UPDATE password_recovery r SET send_lease = $1, lease_until = now() + interval '1 minute', attempts = r.attempts + 1
    FROM next, accounts a WHERE r.id = next.id AND a.id = r.account_id
    RETURNING r.id, a.email, r.attempts
  `, [lease]);
  if (!job) return false;
  const link = new URL(origin);
  link.hash = 'reset=' + tokenFor(secret, job.id);
  let sent = false;
  try {
    await send(job.email, link.href, job.id);
    sent = true;
  } catch {
    console.warn(JSON.stringify({ code: 'RECOVERY_MAIL_DELIVERY_FAILED', attempt: job.attempts }));
  }
  await pool.query(`
    UPDATE password_recovery SET
      sent_at = CASE WHEN $3 THEN now() ELSE NULL END, send_lease = NULL, lease_until = NULL,
      next_attempt_at = now() + make_interval(secs => $4::int)
    WHERE id = $1 AND send_lease = $2
  `, [job.id, lease, sent, 30 * job.attempts]);
  return true;
}
