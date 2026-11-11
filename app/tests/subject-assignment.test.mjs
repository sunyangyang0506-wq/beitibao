import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import pg from 'pg';
import { asTenant } from '../dist/server/db.js';
import { resolveRecognizedCourse, pendingTerm } from '../dist/server/subject-assignment.js';
import { saveCourse } from '../dist/server/courses.js';
import { processNextPageRecognition } from '../dist/server/pdf-page-recognition.js';
import { imagePromptVersion } from '../dist/server/image-recognition.js';
import { samplePaper } from './fixtures/sample-paper.mjs';
const admin = new pg.Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
const api = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const paperWorker = new pg.Pool({ connectionString: process.env.RELEASE_PAPER_DATABASE_URL });
const page = new pg.Pool({ connectionString: process.env.RELEASE_PAGE_DATABASE_URL });
after(() => Promise.all([admin.end(), api.end(), page.end(), paperWorker.end()]));
async function account(limit = 3) {
  const { rows: [a] } = await admin.query('INSERT INTO accounts (email,password_hash,subject_limit) VALUES ($1,$2,$3) RETURNING id',
    [randomUUID()+'@subject.test', 'synthetic', limit]);
  return a.id;
}
const resolve = (tenant, evidence, pool = page) => asTenant(pool, tenant, db => resolveRecognizedCourse(db, tenant, evidence));

test('automatic courses: new, normalized reuse, tenant isolation, metadata ambiguity and quotas', async () => {
  const tenant = await account(1);
  assert.deepEqual(await resolve(tenant, {}), {courseId:null, reason:'unknown'});
  assert.deepEqual(await resolve(tenant, {paperSubject:'unknown'}), {courseId:null, reason:'unknown'});
  const first = await resolve(tenant, {paperSubject:' 数据结构 '});
  assert.equal(first.reason, 'assigned');
  assert.deepEqual(await resolve(tenant, {paperSubject:'数据 结构'}), first);
  const { rows: [course] } = await admin.query('SELECT * FROM courses WHERE id=$1',[first.courseId]);
  assert.equal(course.term, pendingTerm);
  assert.equal(course.teacher, '');
  assert.deepEqual(await resolve(tenant, {paperSubject:'英语'}), {courseId:null, reason:'subject_limit'});
  const other = await resolve(await account(), {paperSubject:'数据结构'});
  assert.notEqual(other.courseId, first.courseId);
  await saveCourse(api, tenant, {name:'数据结构',term:'2026 秋',teacher:'李老师'});
  assert.equal((await resolve(tenant,{paperSubject:'数据结构'})).reason,'ambiguous');
  const selected = await resolve(tenant,{paperSubject:'数据结构',paperTerm:'2026 秋',paperTeacher:'李老师'});
  assert.notEqual(selected.courseId, first.courseId);
  assert.equal(selected.reason,'assigned');
  assert.equal((await resolve(tenant,{paperSubject:'数据结构',paperTeacher:'王老师'})).reason,'ambiguous');
});

test('parallel recognition and manual creation serialize quota and reuse decisions', async () => {
  const tenant = await account(1);
  const results = await Promise.all(Array.from({length:8},()=>resolve(tenant,{paperSubject:'数学'})));
  assert.equal(new Set(results.map(r=>r.courseId)).size,1);
  const next = await account(1);
  const raced = await Promise.all([
    resolve(next,{paperSubject:'英语'}), saveCourse(api,next,{name:'数学',term:'2026 秋'})
  ]);
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM courses WHERE tenant_id=$1',[next])).rows[0].n,1);
  assert.ok(raced[0].reason === 'subject_limit' || raced[1].limitReached === 1);
});

test('page worker persists automatic assignment and pending reason using restricted release grants', async () => {
  const tenant = await account(1);
  for (const [subject, expected] of [['数学','assigned'],['英语','subject_limit'],[undefined,'unknown']]) {
    const id=randomUUID();
    await admin.query(`INSERT INTO papers (tenant_id,id,title,fingerprint,pdf,status,pages,model_allowed,auto_assignment)
      VALUES ($1,$2,'synthetic',$3,$4,'review','[""]',true,true)`,[tenant,id,randomUUID(),samplePaper()]);
    await admin.query('INSERT INTO paper_page_recognition (tenant_id,paper_id,page_number) VALUES ($1,$2,1)',[tenant,id]);
    await processNextPageRecognition(page,async()=>({stems:[],visualContexts:[],figures:[],questionBoxes:[],resolvedContexts:[],
      paperSubject:subject,model:'synthetic',promptVersion:imagePromptVersion}),undefined,{tenant,id,page:1});
    const {rows:[paper]}=await admin.query('SELECT assignment_reason,course_id FROM papers WHERE id=$1',[id]);
    assert.equal(paper.assignment_reason,expected);
    assert.equal(Boolean(paper.course_id),expected==='assigned');
  }
});

test('exact school cache creates recipient course from cover evidence without copying owner teacher or term', async () => {
  const { applySchoolPdf, reuseDigest } = await import('../dist/server/school-paper-reuse.js');
  const { schoolRenderVersion } = await import('../dist/server/paper-parser.js');
  const sourceTenant=await account(), targetTenant=await account();
  const {rows:[school]}=await admin.query('INSERT INTO schools (name,name_key) VALUES ($1,$1) RETURNING id',[randomUUID()]);
  await admin.query('UPDATE accounts SET school_id=$1 WHERE id=ANY($2::uuid[])',[school.id,[sourceTenant,targetTenant]]);
  const sourceCourse=await saveCourse(api,sourceTenant,{name:'缓存科目',teacher:'不可继承的教师',term:'不可继承的学期'});
  const hash=randomUUID(), hashes=[hash], content=reuseDigest([schoolRenderVersion,hashes]);
  const sourceId=randomUUID();
  await admin.query(`INSERT INTO papers (tenant_id,id,course_id,title,fingerprint,pdf,status,pages,share_school_id,school_content_key,recognized_subject)
    VALUES ($1,$2,$3,'source',$4,$5,'review','[""]',$6,$7,'缓存科目')`,
    [sourceTenant,sourceId,sourceCourse.course.id,hash,samplePaper(),school.id,content]);
  const recognition={stems:['1. Synthetic question'],figures:[[]],paperSubject:'缓存科目',promptVersion:imagePromptVersion};
  await admin.query(`INSERT INTO paper_page_recognition (tenant_id,paper_id,page_number,status,reviewed_at,recognition,original_recognition)
    VALUES ($1,$2,1,'review',now(),$3,$3)`,[sourceTenant,sourceId,recognition]);
  await admin.query(`INSERT INTO paper_questions (tenant_id,paper_id,page_number,fingerprint,stem) VALUES ($1,$2,1,$3,$4)`,
    [sourceTenant,sourceId,hash,recognition.stems[0]]);
  await admin.query(`INSERT INTO school_paper_index (school_id,tenant_id,paper_id,file_hash,render_version,page_hashes,content_key,subject_key)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'缓存科目')`,[school.id,sourceTenant,sourceId,hash,schoolRenderVersion,hashes,content]);
  const id=randomUUID(),lease=randomUUID();
  await admin.query(`INSERT INTO papers (tenant_id,id,title,fingerprint,pdf,status,auto_assignment,lease_id)
    VALUES ($1,$2,'target',$3,$4,'processing',true,$5)`,[targetTenant,id,hash,samplePaper(),lease]);
  const result=await asTenant(paperWorker,targetTenant,db=>applySchoolPdf(db,
    {tenant_id:targetTenant,id,course_id:null,fingerprint:hash,school_page_hashes:null,auto_assignment:true},lease,hashes,[''],false));
  assert.equal(result.state,'copied');
  assert.ok(result.courseId);
  const {rows:[course]}=await admin.query('SELECT term,teacher FROM courses WHERE id=$1',[result.courseId]);
  assert.deepEqual(course,{term:pendingTerm,teacher:''});
});

test('retry-assignment uses stored evidence, enforces CSRF, and recovers after quota adjustment', async () => {
  const { createApp } = await import('../dist/server/app.js');
  const { createHash, randomBytes } = await import('node:crypto');
  const origin='https://retry-subject.test', email=randomUUID()+'@subject.test',invite=randomBytes(32).toString('base64url');
  await admin.query("INSERT INTO invitations (token_hash,email,expires_at) VALUES ($1,$2,now()+interval '1 hour')",
    [createHash('sha256').update(invite).digest('hex'),email]);
  const app=await createApp({pool:api,origin,localPapers:true});
  try {
    const registered=await app.inject({method:'POST',url:'/api/v1/auth/register',headers:{origin},payload:{email,password:'synthetic-long-password',invite}});
    assert.equal(registered.statusCode,201);
    const cookie=registered.headers['set-cookie'].split(';')[0],csrf=registered.json().csrfToken;
    const {rows:[a]}=await admin.query('SELECT id FROM accounts WHERE email=$1',[email]);
    await admin.query('UPDATE accounts SET subject_limit=1 WHERE id=$1',[a.id]);
    await saveCourse(api,a.id,{name:'英语',term:'2026 秋'});
    const id=randomUUID();
    await admin.query(`INSERT INTO papers (tenant_id,id,title,fingerprint,pdf,status,pages,auto_assignment,assignment_reason)
      VALUES ($1,$2,'retry',$3,$4,'review','[""]',true,'subject_limit')`,[a.id,id,randomUUID(),samplePaper()]);
    await admin.query(`INSERT INTO paper_page_recognition (tenant_id,paper_id,page_number,status,original_recognition)
      VALUES ($1,$2,1,'review',$3)`,[a.id,id,{paperSubject:'数学'}]);
    const call=headers=>app.inject({method:'POST',url:'/api/v1/papers/'+id+'/retry-assignment',headers:{origin,cookie,...headers}});
    assert.equal((await call({})).statusCode,403);
    let response=await call({'x-csrf-token':csrf});
    assert.equal(response.statusCode,200);assert.equal(response.json().assignmentReason,'subject_limit');
    await admin.query('UPDATE accounts SET subject_limit=2 WHERE id=$1',[a.id]);
    response=await call({'x-csrf-token':csrf});
    assert.equal(response.statusCode,200);assert.equal(response.json().assignmentReason,'assigned');
    assert.ok(response.json().courseId);
  } finally {await app.close();}
});

test('legacy settled PDF recognition republishes without OCR and preserves rejected feedback and source evidence', async () => {
  const { createApp }=await import('../dist/server/app.js');
  const {createHash,randomBytes}=await import('node:crypto');
  const origin='https://recover-subject.test',email=randomUUID()+'@subject.test',invite=randomBytes(32).toString('base64url');
  await admin.query("INSERT INTO invitations (token_hash,email,expires_at) VALUES ($1,$2,now()+interval '1 hour')",
    [createHash('sha256').update(invite).digest('hex'),email]);
  const app=await createApp({pool:api,origin,localPapers:true});
  try {
    const registered=await app.inject({method:'POST',url:'/api/v1/auth/register',headers:{origin},payload:{email,password:'synthetic-long-password',invite}});
    assert.equal(registered.statusCode,201);
    const headers={origin,cookie:registered.headers['set-cookie'].split(';')[0],'x-csrf-token':registered.json().csrfToken};
    const {rows:[a]}=await admin.query('SELECT id FROM accounts WHERE email=$1',[email]);
    const id=randomUUID(),recognition={stems:['1. 解释栈。','2. 应保留已拒绝决定。'],model:'synthetic',promptVersion:'legacy'};
    await admin.query(`INSERT INTO papers (tenant_id,id,title,fingerprint,pdf,status,pages,model_allowed)
      VALUES ($1,$2,'legacy',$3,$4,'review','[""]',true)`,[a.id,id,randomUUID(),samplePaper()]);
    await admin.query(`INSERT INTO paper_page_recognition (tenant_id,paper_id,page_number,status,recognition,original_recognition)
      VALUES ($1,$2,1,'review',$3,$3)`,[a.id,id,recognition]);
    await admin.query(`INSERT INTO recognition_feedback (tenant_id,paper_id,candidate_index,model,prompt_version,original_stem,outcome)
      VALUES ($1,$2,1,'synthetic','legacy',$3,'rejected')`,[a.id,id,recognition.stems[1]]);
    const recover=()=>app.inject({method:'POST',url:'/api/v1/papers/'+id+'/pages/1/recognition',headers});
    for(let i=0;i<2;i++) {
      const response=await recover();assert.equal(response.statusCode,200,response.body);assert.equal(response.json().status,'review');assert.equal(response.json().published,true);
    }
    const {rows:[page]}=await admin.query('SELECT reviewed_at,status,original_recognition FROM paper_page_recognition WHERE paper_id=$1',[id]);
    assert.ok(page.reviewed_at);assert.equal(page.status,'review');assert.deepEqual(page.original_recognition,recognition);
    const {rows:questions}=await admin.query('SELECT stem,solution_status FROM paper_questions WHERE paper_id=$1',[id]);
    assert.deepEqual(questions,[{stem:recognition.stems[0],solution_status:'queued'}]);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM recognition_feedback WHERE paper_id=$1',[id])).rows[0].n,1);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM model_invocations WHERE tenant_id=$1',[a.id])).rows[0].n,0);
    const offline=await createApp({pool:api,origin,localPapers:true,
      privatePapers:{modelsEnabled:false,predictionsEnabled:false,storage:()=>({})}});
    try {
      const oldId=randomUUID();
      await admin.query(`INSERT INTO papers (tenant_id,id,title,fingerprint,pdf,status,pages,model_allowed)
        VALUES ($1,$2,'offline legacy',$3,$4,'review','[""]',true)`,[a.id,oldId,randomUUID(),samplePaper()]);
      await admin.query(`INSERT INTO paper_page_recognition (tenant_id,paper_id,page_number,status,recognition,original_recognition)
        VALUES ($1,$2,1,'review',$3,$3)`,[a.id,oldId,recognition]);
      const recovered=await offline.inject({method:'POST',url:'/api/v1/papers/'+oldId+'/pages/1/recognition',headers});
      assert.equal(recovered.statusCode,200,recovered.body);assert.equal(recovered.json().published,true);
      const {rows:offlineQuestions}=await admin.query('SELECT solution_status FROM paper_questions WHERE paper_id=$1',[oldId]);
      assert.equal(offlineQuestions.length,2);assert.ok(offlineQuestions.every(q=>q.solution_status===null));
    } finally {await offline.close();}
    await admin.query('UPDATE papers SET model_allowed=false WHERE id=$1',[id]);
    assert.equal((await recover()).statusCode,409);
  } finally {await app.close();}
});

test('saved image publication is model-free, partial, idempotent, and preserves feedback, answers and permissions', async () => {
  const {createApp}=await import('../dist/server/app.js');
  const {createHash,randomBytes}=await import('node:crypto');
  const origin='https://saved-image.test',email=randomUUID()+'@subject.test',invite=randomBytes(32).toString('base64url');
  await admin.query("INSERT INTO invitations (token_hash,email,expires_at) VALUES ($1,$2,now()+interval '1 hour')",
    [createHash('sha256').update(invite).digest('hex'),email]);
  const app=await createApp({pool:api,origin,localPapers:true,
    privatePapers:{modelsEnabled:false,predictionsEnabled:false,storage:()=>({})}});
  try {
    const registered=await app.inject({method:'POST',url:'/api/v1/auth/register',headers:{origin},payload:{email,password:'synthetic-long-password',invite}});
    assert.equal(registered.statusCode,201);
    const headers={origin,cookie:registered.headers['set-cookie'].split(';')[0],'x-csrf-token':registered.json().csrfToken};
    const {rows:[a]}=await admin.query('SELECT id FROM accounts WHERE email=$1',[email]);
    const recognition={stems:[' 1. 解释栈。 ','2. 已拒绝。','3. 选择正确项。\nA. 甲\nB. 乙','4. 根据图表回答。'],
      choiceCounts:[0,0,4,0],figures:[[],[],[],[{status:'needs_review'}]],model:'synthetic',promptVersion:'legacy'};
    const id=randomUUID();
    await admin.query(`INSERT INTO papers (tenant_id,id,title,fingerprint,pdf,status,pages,media_type,model_allowed,recognition)
      VALUES ($1,$2,'legacy image',$3,$4,'review','[""]','image/png',true,$5)`,[a.id,id,randomUUID(),Buffer.from('synthetic stored image'),recognition]);
    await admin.query(`INSERT INTO recognition_feedback (tenant_id,paper_id,candidate_index,model,prompt_version,original_stem,outcome)
      VALUES ($1,$2,1,'synthetic','legacy',$3,'rejected')`,[a.id,id,recognition.stems[1]]);
    const publish=(paperId=id,h=headers)=>app.inject({method:'POST',url:'/api/v1/papers/'+paperId+'/publish-saved-recognition',headers:h});
    const details=async()=> (await app.inject({method:'GET',url:'/api/v1/papers/'+id,headers})).json();
    assert.deepEqual((await details()).savedImageRecovery,{publishable:1,pending:2});
    assert.equal((await details()).paper.modelAvailable,false);
    assert.equal((await publish(id,{origin,cookie:headers.cookie})).statusCode,403);
    assert.equal((await publish(randomUUID())).statusCode,404);
    await admin.query("INSERT INTO practice_attempts (tenant_id,paper_id,title,questions) VALUES ($1,$2,'active','[]')",[a.id,id]);
    assert.equal((await publish()).json().code,'CLOSED_BOOK_ACTIVE');
    assert.equal((await details()).savedImageRecovery,undefined);
    await admin.query('UPDATE practice_attempts SET submitted_at=now() WHERE paper_id=$1',[id]);
    const first=await publish();assert.equal(first.statusCode,200,first.body);
    assert.deepEqual(first.json(),{published:1,skipped:1,pending:2});
    assert.deepEqual((await details()).savedImageRecovery,{publishable:0,pending:2});
    const {rows:[question]}=await admin.query('SELECT id,stem,solution_status FROM paper_questions WHERE paper_id=$1',[id]);
    assert.equal(question.stem,recognition.stems[0].trim());assert.equal(question.solution_status,null);
    const answer={status:'solved',answer:'已存答案',explanation:'原解释'};
    await admin.query("UPDATE paper_questions SET model_solution=$2,solution_status='ready' WHERE id=$1",[question.id,answer]);
    const second=await publish();assert.deepEqual(second.json(),{published:0,skipped:2,pending:2});
    assert.deepEqual((await admin.query('SELECT model_solution FROM paper_questions WHERE id=$1',[question.id])).rows[0].model_solution,answer);
    assert.deepEqual((await admin.query('SELECT recognition FROM papers WHERE id=$1',[id])).rows[0].recognition,recognition);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM recognition_feedback WHERE paper_id=$1',[id])).rows[0].n,1);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM model_invocations WHERE tenant_id=$1',[a.id])).rows[0].n,0);
    await admin.query('UPDATE papers SET model_allowed=false WHERE id=$1',[id]);
    assert.equal((await publish()).json().code,'RECOGNITION_UNAVAILABLE');
    assert.equal((await details()).savedImageRecovery,undefined);
  } finally {await app.close();}
});
