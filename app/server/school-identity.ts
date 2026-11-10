import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { asTenant } from './db.js';

export function subjectKey(name: string) {
  const key = name.normalize('NFKC').toLowerCase().replace(/[\s·（）()]/gu, '');
  if (/^(?:408|408计算机统考|计算机统考408|计算机学科专业基础(?:综合|试题)?(?:408)?|408计算机学科专业基础(?:综合|试题)?)$/u.test(key)) return '408';
  return key;
}

export async function schoolOf(db: Pool | PoolClient, tenant: string): Promise<string | null> {
  const { rows: [account] } = await db.query<{ school_id: string | null }>(
    'SELECT school_id FROM accounts WHERE id = $1', [tenant]);
  return account?.school_id ?? null;
}

export function setTenant(db: PoolClient, tenant: string) {
  return db.query("SELECT set_config('beitibao.tenant_id', $1, true)", [tenant]);
}

export function registerSchoolIdentity(app: FastifyInstance, pool: Pool, prefix: string, adminEmail?: string) {
  app.post<{ Params: { accountId: string }; Body: { schoolName: string | null } }>(
    prefix + '/admin/accounts/:accountId/school', { schema: {
      security: [{ session: [] }],
      params: { type: 'object', required: ['accountId'], properties: { accountId: { type: 'string', format: 'uuid' } } },
      body: { type: 'object', required: ['schoolName'], additionalProperties: false,
        properties: { schoolName: { anyOf: [{ type: 'null' }, { type: 'string', minLength: 1, maxLength: 120 }] } } }
    } }, async (request, reply) => {
      if (!adminEmail || request.studySession!.email !== adminEmail) return reply.code(403).send({ code: 'ADMIN_REQUIRED' });
      const { accountId } = request.params;
      const name = request.body.schoolName?.normalize('NFKC').trim().replace(/\s+/gu, ' ');
      if (request.body.schoolName !== null && (!name || /[\p{Cc}\p{Cf}]/u.test(name) || [...name].length > 120)) {
        return reply.code(400).send({ code: 'INVALID_SCHOOL' });
      }
      const result = await asTenant(pool, accountId, async db => {
        const { rows: [account] } = await db.query<{ school_id: string | null }>(
          'SELECT school_id FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
        if (!account) return null;
        let school: { id: string; name: string } | null = null;
        if (name) {
          await db.query('INSERT INTO schools (name, name_key) VALUES ($1, $2) ON CONFLICT DO NOTHING', [name, name.toLowerCase()]);
          school = (await db.query<{ id: string; name: string }>('SELECT id, name FROM schools WHERE name_key = $1', [name.toLowerCase()])).rows[0]!;
        }
        const schoolId = school?.id ?? null;
        if (account.school_id !== schoolId) {
          await db.query('UPDATE accounts SET school_id = $2 WHERE id = $1', [accountId, schoolId]);
          await db.query('UPDATE papers SET share_school_id = NULL, school_content_key = NULL WHERE tenant_id = $1 AND (share_school_id IS NOT NULL OR school_content_key IS NOT NULL)', [accountId]);
          await db.query('UPDATE paper_uploads SET share_school_id = NULL WHERE tenant_id = $1 AND share_school_id IS NOT NULL', [accountId]);
        }
        return { id: accountId, schoolId, schoolName: school?.name ?? null };
      });
      return result ?? reply.code(404).send({ code: 'ACCOUNT_NOT_FOUND' });
    });
}
