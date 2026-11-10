import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Algorithm, hash, verify } from '@node-rs/argon2';
import type { Pool, PoolClient } from 'pg';
import { transaction } from './db.js';

export const sessionLifetime = 7 * 24 * 60 * 60;
const passwordOptions = { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };
const dummyHash = hash(randomBytes(32), passwordOptions);
export const hashPassword = (password: string) => hash(password, passwordOptions);

export function digest(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

export function csrfToken(token: string) {
  return digest('csrf:' + token);
}

export function validCsrf(token: string, value: unknown) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
    && timingSafeEqual(Buffer.from(csrfToken(token)), Buffer.from(value));
}

export async function authLimit(pool: Pool, scope: string, key: string, limit: number) {
  const result = await pool.query<{ attempts: number }>(`
    INSERT INTO auth_limits (bucket, window_started_at, attempts) VALUES ($1, now(), 1)
    ON CONFLICT (bucket) DO UPDATE SET
      attempts = CASE WHEN auth_limits.window_started_at <= now() - interval '15 minutes'
        THEN 1 ELSE LEAST(auth_limits.attempts + 1, $2 + 1) END,
      window_started_at = CASE WHEN auth_limits.window_started_at <= now() - interval '15 minutes'
        THEN now() ELSE auth_limits.window_started_at END
    RETURNING attempts
  `, [digest(scope + ':' + key), limit]);
  return result.rows[0]!.attempts <= limit;
}

async function createSession(db: Pool | PoolClient, accountId: string) {
  const token = randomBytes(32).toString('base64url');
  await db.query(
    "INSERT INTO sessions VALUES ($1, $2, now() + $3 * interval '1 second')",
    [digest(token), accountId, sessionLifetime]
  );
  return token;
}

type Credentials = { email?: string; phone?: string; password: string };

export async function register(pool: Pool, { email, phone, password, invite }: Credentials & { invite: string }) {
  const inviteHash = digest(invite);
  const eligible = await pool.query(
    'SELECT 1 FROM invitations WHERE token_hash = $1 AND (email = $2 OR phone = $3) AND used_at IS NULL AND expires_at > now()',
    [inviteHash, email ?? null, phone ?? null]
  );
  if (!eligible.rowCount) return null;
  const passwordHash = await hashPassword(password);
  return transaction(pool, async (db) => {
    const claimed = await db.query<{ subject_limit: number | null }>(`
      UPDATE invitations SET used_at = now()
      WHERE token_hash = $1 AND (email = $2 OR phone = $3) AND used_at IS NULL AND expires_at > now()
      RETURNING subject_limit
    `, [inviteHash, email ?? null, phone ?? null]);
    if (!claimed.rowCount) return null;
    const result = await db.query<{ id: string }>(`
      INSERT INTO accounts (email, phone, password_hash, subject_limit) VALUES ($1, $2, $3, $4)
      ON CONFLICT DO NOTHING RETURNING id
    `, [email ?? null, phone ?? null, passwordHash, claimed.rows[0]!.subject_limit]);
    const account = result.rows[0];
    return account ? createSession(db, account.id) : null;
  });
}

export async function login(pool: Pool, { email, phone, password }: Credentials) {
  const result = await pool.query<{ id: string; password_hash: string }>(
    'SELECT id, password_hash FROM accounts WHERE email = $1 OR phone = $2', [email ?? null, phone ?? null]
  );
  const account = result.rows[0];
  const valid = await verify(account?.password_hash ?? await dummyHash, password);
  if (!valid || !account) return null;
  return transaction(pool, async db => {
    const current = await db.query('SELECT id FROM accounts WHERE id = $1 AND password_hash = $2 FOR SHARE',
      [account.id, account.password_hash]);
    return current.rowCount ? createSession(db, account.id) : null;
  });
}

export async function findSession(pool: Pool, token?: string) {
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const result = await pool.query<{ id: string; email: string | null; phone: string | null }>(`
    SELECT accounts.id, accounts.email, accounts.phone FROM sessions
    JOIN accounts ON accounts.id = sessions.account_id
    WHERE token_hash = $1 AND expires_at > now()
  `, [digest(token)]);
  return result.rows[0] ? { ...result.rows[0], token } : null;
}
