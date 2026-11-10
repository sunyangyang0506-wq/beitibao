import type { Pool, PoolClient } from 'pg';

export async function transaction<T>(pool: Pool, run: (db: PoolClient) => Promise<T>) {
  const db = await pool.connect();
  let discard = false;
  try {
    await db.query('BEGIN');
    const result = await run(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await db.query('ROLLBACK');
    } catch {
      discard = true;
    }
    throw error;
  } finally {
    db.release(discard);
  }
}

export function asTenant<T>(pool: Pool, tenantId: string, run: (db: PoolClient) => Promise<T>) {
  return transaction(pool, async (db) => {
    await db.query("SELECT set_config('beitibao.tenant_id', $1, true)", [tenantId]);
    return run(db);
  });
}

export function lockCourseMaterial(db: PoolClient, tenant: string, course: string) {
  return db.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text || ':' || $2::text, 66117))", [tenant, course]);
}
