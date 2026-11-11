import { resolveRecognizedCourse, type Assignment } from './subject-assignment.js';
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { asTenant, lockCourseMaterial } from './db.js';
import { imagePromptVersion, type recognizeImage } from './image-recognition.js';
import { schoolRenderVersion, schoolPageFingerprints } from './paper-parser.js';
import { schoolOf, setTenant, subjectKey } from './school-identity.js';
import { solutionPromptVersion } from './model-solution.js';
import type { QuestionReference } from './question-reference.js';

type Recognition = Awaited<ReturnType<typeof recognizeImage>>;
type Solution = { status?: string; answer?: string; explanation?: string; knowledgePoints?: string[]; promptVersion?: string; originalImagePages?: number[] };
type Page = { page_number: number; status: string; reviewed_at: Date | null; recognition: Recognition | null; original_recognition: Recognition | null };
type Question = { input_revision: number; page_number: number; fingerprint: string; stem: string; question_kind: string; source_pages: number[];
  model_solution: Solution | null; solution_status: string | null; standalone_solution: boolean; reference: QuestionReference | null; visual_review: string | null };
type Source = {
  id: string; tenant_id: string; paper_id: string; file_hash: string; page_hashes: string[]; subject_key: string | null; content_key: string; created_at: Date;
  course_id: string | null; recognized_subject: string | null; page_order: number[] | null; status: string; missing_pages: boolean;
};
type Target = { auto_assignment?: boolean; tenant_id: string; id: string; course_id: string | null; fingerprint: string; school_page_hashes: string[] | null };

export const reuseDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const reuseWaitMs = 20 * 60_000;
const candidateSelect = `
  SELECT i.id, i.tenant_id, i.paper_id, i.file_hash, i.page_hashes, i.content_key, i.subject_key, i.created_at,
    p.course_id, p.recognized_subject, p.page_order, p.status, p.missing_pages
  FROM school_paper_index i
  JOIN papers p ON (p.tenant_id,p.id) = (i.tenant_id,i.paper_id) AND p.share_school_id = i.school_id AND p.school_content_key = i.content_key
  JOIN accounts owner ON owner.id = i.tenant_id AND owner.school_id = i.school_id
`;

export async function prepareSchoolPdf(pool: Pool, target: Target, pdf: Buffer, pageCount: number) {
  const school = await schoolOf(pool, target.tenant_id);
  if (!school) return null;
  if (target.school_page_hashes?.length === pageCount) return target.school_page_hashes;
  const { rows: [sameFile] } = await asTenant(pool, target.tenant_id, db => db.query<{ page_hashes: string[] }>(`
    ${candidateSelect} WHERE i.school_id = $1 AND i.file_hash = $2 AND i.render_version = $3
      AND cardinality(i.page_hashes) = $4 LIMIT 1
  `, [school, target.fingerprint, schoolRenderVersion, pageCount]));
  return sameFile?.page_hashes ?? await schoolPageFingerprints(pdf, pageCount);
}

async function readCourseNames(db: PoolClient, tenant: string) {
  return (await db.query<{ id: string; name: string }>('SELECT id, name FROM courses WHERE tenant_id = $1', [tenant])).rows;
}

async function readSource(db: PoolClient, source: Source, recipient: string) {
  await setTenant(db, source.tenant_id);
  const { rows: pages } = await db.query<Page>(`SELECT page_number, status, reviewed_at, recognition, original_recognition FROM paper_page_recognition
    WHERE tenant_id = $1 AND paper_id = $2 ORDER BY page_number`, [source.tenant_id, source.paper_id]);
  const { rows: questions } = await db.query<Question>(`SELECT input_revision, page_number, fingerprint, stem, question_kind, source_pages, model_solution, solution_status,
    standalone_solution, reference, visual_review FROM paper_questions WHERE tenant_id = $1 AND paper_id = $2
    ORDER BY page_number, created_at, id`, [source.tenant_id, source.paper_id]);
  const { rows: [course] } = await db.query<{ name: string }>('SELECT name FROM courses WHERE tenant_id = $1 AND id = $2',
    [source.tenant_id, source.course_id]);
  await setTenant(db, recipient);
  return { pages, questions, subject: source.recognized_subject ?? course?.name ?? null,
    subjectAgrees: !source.recognized_subject || !course || subjectKey(source.recognized_subject) === subjectKey(course.name) };
}

function completePage(page: Page, original = false) {
  const result = original ? page.original_recognition : page.recognition;
  return page.status === 'review' && Boolean(page.reviewed_at && result?.promptVersion === imagePromptVersion &&
    !result.figures?.some(figures => figures.some(figure => figure.status === 'needs_review')));
}

function usableSolution(solution: Solution | null) {
  return solution?.promptVersion === solutionPromptVersion && solution.status === 'solved' &&
    Boolean(solution.answer?.trim() && solution.explanation?.trim() && solution.knowledgePoints?.length);
}

function samePageIndexes(source: Source, hashes: string[]) {
  return hashes.flatMap((hash, index) => source.page_hashes[index] === hash ? [index + 1] : []);
}

function readyOriginal(source: Source, material: Awaited<ReturnType<typeof readSource>>) {
  if (source.status !== 'review' || source.missing_pages || material.pages.length !== source.page_hashes.length ||
      !material.pages.every(page => completePage(page)) || !material.questions.length ||
      material.questions.some(question => question.input_revision > 1 || question.visual_review ||
        (question.reference && !['paper', 'paper_ocr'].includes(question.reference.source)))) return false;
  return material.pages.every(page => {
    const stems = new Set(page.recognition?.stems ?? []);
    const questions = material.questions.filter(question => question.page_number === page.page_number);
    const unresolved = new Set(page.recognition?.figures?.flatMap((figures, index) =>
      figures.some(figure => figure.status === 'needs_review') ? [page.recognition!.stems[index]] : []) ?? []);
    return stems.size === questions.length && questions.every(question => stems.has(question.stem) &&
      (!unresolved.has(question.stem) || (usableSolution(question.model_solution) &&
        question.model_solution?.originalImagePages?.includes(page.page_number))));
  });
}

async function lockSource(db: PoolClient, id: string) {
  return (await db.query<Source>(`${candidateSelect} WHERE i.id=$1 FOR SHARE OF p`, [id])).rows[0];
}

async function copyRecognizedPages(db: PoolClient, target: Target, pages: Page[], exact: boolean) {
  for (const page of pages) {
    const original = page.original_recognition ?? page.recognition;
    await db.query(`
      INSERT INTO paper_page_recognition (tenant_id,paper_id,page_number,status,recognition,original_recognition,reviewed_at)
      VALUES ($1,$2,$3,'review',$4,$5,CASE WHEN $6 THEN now() END) ON CONFLICT DO NOTHING
    `, [target.tenant_id, target.id, page.page_number, JSON.stringify(exact ? page.recognition : original), JSON.stringify(original), exact]);
  }
}

async function copyOriginal(db: PoolClient, target: Target, source: Source, material: Awaited<ReturnType<typeof readSource>>,
  courseId: string | null, text: string[], modelsEnabled: boolean) {
  const { rows: [paper] } = await db.query<{ course_id: string | null }>(`
    UPDATE papers p SET status='review', pages=$3, title=CASE WHEN auto_title THEN coalesce($4,title) ELSE title END,
      recognized_subject=$5, page_order=$6, school_reuse='exact', school_content_key=$7,
      course_id=coalesce(p.course_id, CASE WHEN NOT EXISTS (
        SELECT 1 FROM papers other WHERE other.tenant_id=p.tenant_id AND other.id<>p.id AND other.course_id=$8
          AND other.fingerprint=p.fingerprint AND other.school IS NOT DISTINCT FROM p.school
      ) THEN $8::uuid END), failure=NULL, lease_id=NULL, lease_until=NULL
    WHERE p.tenant_id=$1 AND p.id=$2 RETURNING course_id
  `, [target.tenant_id, target.id, JSON.stringify(text), material.pages[0]?.recognition?.paperTitle ?? null, material.subject, source.page_order, source.content_key, courseId]);
  await copyRecognizedPages(db, target, material.pages, true);
  const sameTextContext = source.file_hash === target.fingerprint ||
    (await db.query<{ same: boolean }>('SELECT pages=$3::jsonb AS same FROM papers WHERE tenant_id=$1 AND id=$2',
      [source.tenant_id, source.paper_id, JSON.stringify(text)])).rows[0]?.same;
  await db.query(`
    INSERT INTO paper_questions (tenant_id,paper_id,page_number,fingerprint,stem,question_kind,source_pages,
      model_solution,solution_status,standalone_solution,reference,created_at)
    SELECT $1,$2,(q->>'page_number')::int,q->>'fingerprint',q->>'stem',q->>'question_kind',
      ARRAY(SELECT jsonb_array_elements_text(q->'source_pages')::int),
      nullif(q->'model_solution','null'::jsonb),q->>'solution_status',(q->>'standalone_solution')::boolean,nullif(q->'reference','null'::jsonb),
      statement_timestamp() + ord * interval '1 microsecond'
    FROM jsonb_array_elements($3::jsonb) WITH ORDINALITY AS item(q,ord)
  `, [target.tenant_id, target.id, JSON.stringify(material.questions.map(question => {
    const solution = (sameTextContext || question.standalone_solution) && usableSolution(question.model_solution) ? question.model_solution : null;
    const reference = sameTextContext || question.reference?.source === 'paper_ocr' ? question.reference : null;
    return { ...question, reference, model_solution: solution, solution_status: solution ? 'ready' : modelsEnabled ? 'queued' : null,
      standalone_solution: Boolean(solution && question.standalone_solution) };
  }))]);
  return paper!.course_id;
}

type ReuseResult = { state: 'normal' } | { state: 'waiting' } | { state: 'copied'; courseId: string | null };

export async function applySchoolPdf(db: PoolClient, target: Target, lease: string, hashes: string[], text: string[],
  modelsEnabled: boolean): Promise<ReuseResult> {
  const tenant = target.tenant_id;
  await setTenant(db, tenant);
  const school = await schoolOf(db, tenant);
  if (!school) return { state: 'normal' };
  const contentKey = reuseDigest([schoolRenderVersion, hashes]);
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 81109))', [school + ':' + contentKey]);
  const courses = await readCourseNames(db, tenant);
  const targetCourse = courses.find(course => course.id === target.course_id);
  const targetSubject = targetCourse ? subjectKey(targetCourse.name) : null;
  const { rows: candidates } = await db.query<Source>(`
    ${candidateSelect} WHERE i.school_id=$1 AND i.render_version=$2 AND i.page_hashes[1]=$3
      AND (i.tenant_id,i.paper_id)<>($4,$5) AND NOT p.missing_pages AND p.status <> 'failed'
      AND ($7::text IS NULL OR i.subject_key IS NULL OR i.subject_key=$7)
    ORDER BY (i.content_key=$6) DESC, (SELECT count(*) FROM unnest($8::text[]) WITH ORDINALITY AS page(hash,n)
      WHERE i.page_hashes[n::int]=page.hash) DESC, i.created_at, i.id LIMIT 30
  `, [school, schoolRenderVersion, hashes[0], tenant, target.id, contentKey, targetSubject, hashes]);

  let exact: { source: Source; subject: string; complete: boolean; cover: Recognition | null } | null = null;
  const exactSubjects = new Set<string>();
  let partial: { id: string; pages: Page[] } | null = null;
  let wait = false;
  for (const source of candidates) {
    const material = await readSource(db, source, tenant);
    const subject = material.subject ? subjectKey(material.subject) : null;
    if (!material.subjectAgrees || (targetSubject && subject && targetSubject !== subject)) continue;
    if (source.content_key === contentKey) {
      if (modelsEnabled && Date.now() - source.created_at.getTime() < reuseWaitMs &&
        (source.status === 'queued' || source.status === 'processing' ||
          material.pages.some(page => ['queued', 'processing'].includes(page.status)) ||
          material.questions.some(question => question.solution_status === 'queued' || question.solution_status === 'processing'))) {
        wait = true;
      }
      if (subject) exactSubjects.add(subject);
      if (subject && readyOriginal(source, material)) {
        const complete = material.questions.every(question => usableSolution(question.model_solution));
        if (!exact || (complete && !exact.complete)) exact = { source, subject, complete, cover: material.pages.find(page => page.page_number === 1)?.original_recognition ?? null };
      }
    }
    if (subject && (targetSubject === subject || (!targetSubject && courses.some(course => subjectKey(course.name) === subject)))) {
      const matches = samePageIndexes(source, hashes);
      const pages = material.pages.filter(page => matches.includes(page.page_number) && completePage(page, true));
      if (pages.length > (partial?.pages.length ?? 0)) partial = { id: source.id, pages };
    }
  }

  if (!targetSubject && exactSubjects.size > 1) { exact = null; wait = false; }
  if (exact?.complete) wait = false;
  await db.query('SAVEPOINT school_assignment');
  const assignment: Assignment = !target.course_id && target.auto_assignment && exact && !wait
    ? await resolveRecognizedCourse(db, tenant, exact.cover?.paperSubject && subjectKey(exact.cover.paperSubject) === exact.subject ? exact.cover : {})
    : { courseId: target.course_id, reason: 'unknown' };
  const courseId = target.course_id ?? assignment.courseId;
  if (courseId && (exact || partial)) await lockCourseMaterial(db, tenant, courseId);
  // Take the course lock before locking a source paper. Page publication uses the same order.
  const exactSource = exact && !wait ? await lockSource(db, exact.source.id) : null;
  const exactMaterial = exactSource ? await readSource(db, exactSource, tenant) : null;
  if (targetSubject && partial && !exactMaterial && !wait) {
    const source = await lockSource(db, partial.id);
    const material = source ? await readSource(db, source, tenant) : null;
    const matches = source ? samePageIndexes(source, hashes) : [];
    partial = source && material?.subject && material.subjectAgrees && subjectKey(material.subject) === targetSubject
      ? { id: source.id, pages: material.pages.filter(page => matches.includes(page.page_number) && completePage(page, true)) } : null;
  }
  const { rows: [current] } = await db.query<{ share_school_id: string | null }>(
    'SELECT share_school_id FROM papers WHERE tenant_id=$1 AND id=$2 AND lease_id=$3 FOR UPDATE', [tenant, target.id, lease]);
  if (!current) {
    await db.query('ROLLBACK TO SAVEPOINT school_assignment');
    return { state: 'waiting' };
  }
  await db.query('UPDATE papers SET school_page_hashes=$3 WHERE tenant_id=$1 AND id=$2', [tenant, target.id, hashes]);
  if (wait) {
    await db.query("UPDATE papers SET lease_until=now() + interval '5 seconds' WHERE tenant_id=$1 AND id=$2", [tenant, target.id]);
    return { state: 'waiting' };
  }
  if (exactSource && exactMaterial?.subject && exactMaterial.subjectAgrees && subjectKey(exactMaterial.subject) === exact?.subject &&
      readyOriginal(exactSource, exactMaterial) && JSON.stringify(exactMaterial.pages.find(page => page.page_number === 1)?.original_recognition ?? null) === JSON.stringify(exact?.cover)) {
    const assigned = await copyOriginal(db, target, exactSource, exactMaterial, courseId, text, modelsEnabled);
    await db.query('UPDATE papers SET assignment_reason=$3 WHERE tenant_id=$1 AND id=$2',
      [tenant, target.id, assigned ? 'assigned' : courseId ? 'duplicate' : assignment.reason]);
    return { state: 'copied', courseId: assigned };
  }

  if (!target.course_id && assignment.courseId) {
    await db.query('ROLLBACK TO SAVEPOINT school_assignment');
    await db.query('UPDATE papers SET school_page_hashes=$3 WHERE tenant_id=$1 AND id=$2', [tenant, target.id, hashes]);
  }
  if (modelsEnabled && current.share_school_id === school) {
    await db.query(`
      INSERT INTO school_paper_index (school_id,tenant_id,paper_id,file_hash,render_version,page_hashes,content_key,subject_key)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (tenant_id,paper_id) DO NOTHING
    `, [school, tenant, target.id, target.fingerprint, schoolRenderVersion, hashes, contentKey, targetSubject]);
    await db.query('UPDATE papers SET school_content_key=$3 WHERE tenant_id=$1 AND id=$2', [tenant, target.id, contentKey]);
  }
  if (modelsEnabled && partial) {
    await db.query('UPDATE papers SET school_candidate_id=$3 WHERE tenant_id=$1 AND id=$2', [tenant, target.id, partial.id]);
    if (targetSubject) {
      // A shorter file can match every available page of a longer version. Keep one fresh page job to finish publication.
      const reusable = partial.pages.length === hashes.length ? partial.pages.slice(0, -1) : partial.pages;
      await copyRecognizedPages(db, target, reusable, false);
      if (reusable.length) await db.query("UPDATE papers SET school_reuse='pages' WHERE tenant_id=$1 AND id=$2", [tenant, target.id]);
      const cover = reusable.find(page => page.page_number === 1)?.original_recognition;
      if (cover) await db.query(`
        UPDATE papers SET title=CASE WHEN auto_title THEN coalesce($3,title) ELSE title END,
          recognized_subject=coalesce($4,recognized_subject) WHERE tenant_id=$1 AND id=$2
      `, [tenant, target.id, cover.paperTitle ?? null, cover.paperSubject ?? null]);
    }
  }
  return { state: 'normal' };
}

export async function reuseMatchingPages(db: PoolClient, target: Target, candidateId: string, subject: string) {
  await setTenant(db, target.tenant_id);
  const source = await lockSource(db, candidateId);
  if (!source || source.missing_pages || source.status !== 'review' || !target.school_page_hashes) return;
  const material = await readSource(db, source, target.tenant_id);
  if (!material.subject || !material.subjectAgrees || subjectKey(subject) !== subjectKey(material.subject)) return;
  const matches = samePageIndexes(source, target.school_page_hashes);
  let copied = false;
  for (const page of material.pages) {
    if (page.page_number === 1 || !matches.includes(page.page_number) || !completePage(page, true)) continue;
    const saved = await db.query(`
      UPDATE paper_page_recognition SET status='review', recognition=$4, original_recognition=$4
      WHERE tenant_id=$1 AND paper_id=$2 AND page_number=$3 AND status='queued'
    `, [target.tenant_id, target.id, page.page_number, JSON.stringify(page.original_recognition)]);
    copied ||= Boolean(saved.rowCount);
  }
  if (copied) await db.query("UPDATE papers SET school_reuse='pages' WHERE tenant_id=$1 AND id=$2", [target.tenant_id, target.id]);
}

export async function reuseStandaloneSolutions(db: PoolClient, tenant: string, paperId: string) {
  await setTenant(db, tenant);
  const { rows: [target] } = await db.query<{ school_candidate_id: string | null; school_page_hashes: string[] | null;
    recognized_subject: string | null; course_id: string | null }>(`
    SELECT school_candidate_id, school_page_hashes, recognized_subject, course_id
    FROM papers WHERE tenant_id=$1 AND id=$2
  `, [tenant, paperId]);
  if (!target?.school_candidate_id || !target.school_page_hashes) return;
  const source = await lockSource(db, target.school_candidate_id);
  if (!source || source.missing_pages || source.status !== 'review') return;
  const targetName = target.recognized_subject ?? (await readCourseNames(db, tenant)).find(course => course.id === target.course_id)?.name;
  const material = await readSource(db, source, tenant);
  if (!targetName || !material.subject || !material.subjectAgrees || subjectKey(targetName) !== subjectKey(material.subject)) return;
  const matches = samePageIndexes(source, target.school_page_hashes);
  let copied = false;
  for (const question of material.questions) {
    if (question.input_revision > 1 || !matches.includes(question.page_number) || !question.standalone_solution || question.source_pages.length ||
        question.reference || question.visual_review || !usableSolution(question.model_solution)) continue;
    const saved = await db.query(`
      UPDATE paper_questions SET model_solution=$6, solution_status='ready', standalone_solution=true
      WHERE tenant_id=$1 AND paper_id=$2 AND page_number=$3 AND stem=$4 AND question_kind=$5
        AND input_revision=1 AND solution_status IS NULL AND reference IS NULL AND visual_review IS NULL AND cardinality(source_pages)=0
    `, [tenant, paperId, question.page_number, question.stem, question.question_kind, JSON.stringify(question.model_solution)]);
    copied ||= Boolean(saved.rowCount);
  }
  if (copied) await db.query("UPDATE papers SET school_reuse='pages' WHERE tenant_id=$1 AND id=$2", [tenant, paperId]);
}
