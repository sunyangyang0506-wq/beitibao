import type { PoolClient } from 'pg';
import { setTenant, subjectKey } from './school-identity.js';

export const pendingTerm = '学期待确认';
export type SubjectEvidence = { paperSubject?: unknown; paperTerm?: unknown; paperTeacher?: unknown };
export type Assignment = { courseId: string | null; reason: 'assigned' | 'unknown' | 'ambiguous' | 'subject_limit' };

export function classificationText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || /[\p{Cc}\p{Cf}]/u.test(value)) return undefined;
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  return normalized && [...normalized].length <= max && !/^(?:unknown|null|undefined|不详|未知|无法确定|待确认)$/iu.test(normalized)
    ? normalized : undefined;
}

// Shared by manual creation and recognition. Do not hold this lock across model calls.
export function lockSubjectCreation(db: PoolClient, tenant: string) {
  return db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 92041))', [tenant]);
}

export async function resolveRecognizedCourse(db: PoolClient, tenant: string, evidence: SubjectEvidence): Promise<Assignment> {
  const name = classificationText(evidence.paperSubject, 100);
  if (!name || !subjectKey(name)) return { courseId: null, reason: 'unknown' };
  const term = classificationText(evidence.paperTerm, 80);
  const teacher = classificationText(evidence.paperTeacher, 100);
  await setTenant(db, tenant);
  await lockSubjectCreation(db, tenant);
  const { rows: [account] } = await db.query<{ subject_limit: number | null }>(
    'SELECT subject_limit FROM accounts WHERE id = $1', [tenant]);
  if (!account) return { courseId: null, reason: 'unknown' };
  const { rows } = await db.query<{ id: string; name: string; term: string; teacher: string }>(
    'SELECT id, name, teacher, term FROM courses WHERE tenant_id = $1', [tenant]);
  const sameSubject = rows.filter(course => subjectKey(course.name) === subjectKey(name));
  const matches = sameSubject.filter(course => (!term || course.term === term) && (!teacher || course.teacher === teacher));
  if (matches.length === 1) return { courseId: matches[0]!.id, reason: 'assigned' };
  if (matches.length > 1 || (sameSubject.length > 0 && (!term || !teacher))) {
    return { courseId: null, reason: 'ambiguous' };
  }
  // Match the manual API's distinct-name quota. Reuse the canonical existing spelling across terms.
  const canonicalName = sameSubject[0]?.name ?? name;
  const names = new Set(rows.map(course => course.name.toLowerCase()));
  if (!names.has(canonicalName.toLowerCase()) && account.subject_limit !== null && names.size >= account.subject_limit) {
    return { courseId: null, reason: 'subject_limit' };
  }
  const { rows: [created] } = await db.query<{ id: string }>(`
    INSERT INTO courses (tenant_id, name, teacher, term) VALUES ($1, $2, $3, $4) RETURNING id
  `, [tenant, canonicalName, teacher ?? '', term ?? pendingTerm]);
  return { courseId: created!.id, reason: 'assigned' };
}
