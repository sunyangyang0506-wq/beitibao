import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';

if (!process.env.MIGRATION_DATABASE_URL) throw new Error('MIGRATION_DATABASE_URL is required');
const db = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
const directory = new URL('../migrations/', import.meta.url);
await db.connect();
try {
  await db.query('BEGIN');
  await db.query('SELECT pg_advisory_xact_lock(734206815)');
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY)');
  const files = (await readdir(directory)).filter((file) => /^\d+_\w+\.sql$/.test(file)).sort();
  for (const filename of files) {
    const result = await db.query(
      'INSERT INTO schema_migrations VALUES ($1) ON CONFLICT DO NOTHING RETURNING filename',
      [filename]
    );
    if (!result.rowCount) continue;
    await db.query(await readFile(new URL(filename, directory), 'utf8'));
    console.log('Applied', filename);
  }
  await db.query('COMMIT');
} catch (error) {
  await db.query('ROLLBACK');
  throw error;
} finally {
  await db.end();
}
