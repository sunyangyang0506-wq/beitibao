import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
export async function seedLegacyQuestionCorrection(query) {
  const tenant=randomUUID(),course=randomUUID(),paper=randomUUID(),question=randomUUID(),school=randomUUID();
  await query('INSERT INTO schools(id,name,name_key) VALUES ($1,$2,$3)',[school,'Synthetic school',school]);
  await query("INSERT INTO accounts(id,email,password_hash,school_id) VALUES ($1,$2,'synthetic',$3)",[tenant,tenant+'@example.test',school]);
  await query("INSERT INTO courses(tenant_id,id,name,term) VALUES ($1,$2,'Upgrade','2026')",[tenant,course]);
  await query(`INSERT INTO papers(tenant_id,id,course_id,title,fingerprint,pdf,status,pages,share_school_id,school_content_key)
    VALUES ($1,$2,$3,'Legacy','legacy',$4,'review','["page"]',$5,'legacy-shared-key')`,[tenant,paper,course,Buffer.alloc(0),school]);
  await query(`INSERT INTO paper_questions(tenant_id,id,paper_id,page_number,fingerprint,stem,question_kind,model_solution,solution_status)
    VALUES ($1,$2,$3,1,'legacy-question','Original question','choice','{"status":"solved","answer":"A"}','ready')`,[tenant,question,paper]);
  await query(`INSERT INTO question_recall(tenant_id,question_id,stem_correction,revealed,self_rating,correction)
    VALUES ($1,$2,'Personal revised question',true,'mastered','{"answer":"My private note"}')`,[tenant,question]);
  const questions=[{id:question,stem:'Original question',kind:'choice',pageNumber:1,reference:null,visualReview:null}];
  await query(`INSERT INTO practice_attempts(tenant_id,paper_id,title,questions,answers,submitted_at)
    VALUES ($1,$2,'Legacy',$3,$4,now())`,[tenant,paper,JSON.stringify(questions),JSON.stringify({[question]:'B'})]);
  await query(`INSERT INTO practice_results(tenant_id,paper_id,graded,covered,submitted_at,solution_snapshots)
    VALUES ($1,$2,$3,$4,now(),$5)`,[tenant,paper,JSON.stringify({[question]:'incorrect'}),[question],JSON.stringify({[question]:{stem:'Original question',visual_review:null,model_solution:{status:'solved',answer:'A'},solution_status:'ready'}})]);
  return {tenant,paper,question};
}
export async function verifyLegacyQuestionCorrection(query,fixture) {
  const {tenant,paper,question}=fixture;
  await query("SELECT set_config('beitibao.tenant_id',$1,false)",[tenant]);
  const q=(await query('SELECT stem,input_revision,model_solution,solution_status FROM paper_questions WHERE id=$1',[question])).rows[0];
  assert.deepEqual(q,{stem:'Personal revised question',input_revision:2,model_solution:null,solution_status:null});
  const p=(await query('SELECT share_school_id,school_content_key FROM papers WHERE id=$1',[paper])).rows[0];
  assert.deepEqual(p,{share_school_id:null,school_content_key:null});
  const h=(await query('SELECT question,recall FROM question_revision_history WHERE question_id=$1',[question])).rows[0];
  assert.equal(h.question.stem,'Original question');
  assert.equal(h.question.model_solution.answer,'A');
  assert.equal(h.recall.self_rating,'mastered');
  assert.equal(h.recall.correction.answer,'My private note');
  const a=(await query('SELECT questions,answers FROM practice_attempts WHERE paper_id=$1',[paper])).rows[0];
  assert.equal(a.questions[0].stem,'Original question');
  assert.equal(a.answers[question],'B');
  const r=(await query('SELECT graded FROM practice_results WHERE paper_id=$1',[paper])).rows[0];
  assert.equal(r.graded[question],'incorrect');
  const policies=(await query("SELECT relname,relforcerowsecurity FROM pg_class WHERE relname=ANY($1)",[['papers','paper_questions','question_recall','question_equivalence','question_revision_history','practice_history']])).rows;
  assert.equal(policies.length,6);
  assert.ok(policies.every(row=>row.relforcerowsecurity));
  return {cases:['non-superuser-owner-upgrade','legacy-personal-overlay-version','school-share-revoked','original-recall-preserved','attempt-result-unmodified','force-rls-restored']};
}
