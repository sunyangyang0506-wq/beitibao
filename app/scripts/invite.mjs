import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';

const email = process.argv[2]?.trim().toLowerCase();
if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  throw new Error('Provide a valid invitee email address');
}
if (!process.env.MIGRATION_DATABASE_URL) throw new Error('MIGRATION_DATABASE_URL is required');
const db = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
const invite = randomBytes(32).toString('base64url');
await db.connect();
try {
  await db.query(
    "INSERT INTO invitations (token_hash, email, expires_at) VALUES ($1, $2, now() + interval '24 hours')",
    [createHash('sha256').update(invite).digest('hex'), email]
  );
  console.log(invite);
} finally {
  await db.end();
}
