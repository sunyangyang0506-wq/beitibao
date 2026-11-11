import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createApp } from '../../dist/server/app.js';
import { consumePracticeDeadline, settleExpiredPractices } from '../../dist/server/practice.js';

export async function verifyQuestionVersions(pool, query, queuePool, localPool) {
  const origin = 'https://question-versions.example.test';
  let afterCommit = null;
  const observedPool = { query: pool.query.bind(pool), connect: async () => {
    const client = await pool.connect();
    let readAttempt = false;
    return { query: async (...args) => {
      const result = await client.query(...args);
      const sql = args[0].trim();
      if (sql.endsWith('FROM practice_attempts WHERE tenant_id = $1 AND paper_id = $2')) readAttempt = true;
      if (sql === 'COMMIT' && readAttempt && afterCommit) { const next = afterCommit; afterCommit = null; await next(); }
      return result;
    }, release: client.release.bind(client) };
  } };
  const app = await createApp({ pool: observedPool, origin, localPapers: true, passwordRecovery: null });
  const tenant = randomUUID(), course = randomUUID(), paper = randomUUID(), otherPaper = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const sha = value => createHash('sha256').update(value).digest('hex');
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  const stem = 'Choose the first value.\nA. One B. Two C. Three D. Four';
  const corrected = 'Choose the second value.\nA. One B. Two C. Three D. Four';
  const model = { status: 'solved', answer: 'A', explanation: 'Original explanation' };
  await query('INSERT INTO accounts (id,email,password_hash) VALUES ($1,$2,$3)', [tenant,tenant+'@example.test','synthetic']);
  await query("INSERT INTO sessions (token_hash,account_id,expires_at) VALUES ($1,$2,now()+interval '1 hour')", [sha(token),tenant]);
  await query("INSERT INTO courses (tenant_id,id,name,term) VALUES ($1,$2,'Versions','2026')", [tenant,course]);
  for (const id of [paper,otherPaper]) await query(`INSERT INTO papers (tenant_id,id,course_id,title,fingerprint,pdf,status,pages,model_allowed)
    VALUES ($1,$2,$3,'Synthetic',$2::uuid::text,$4,'review','["page"]',true)`, [tenant,id,course,Buffer.alloc(0)]);
  for (const [index,id] of ids.entries()) await query(`INSERT INTO paper_questions (tenant_id,id,paper_id,page_number,fingerprint,stem,question_kind,model_solution,solution_status)
    VALUES ($1,$2,$3,1,$2::uuid::text,$4,'choice',$5,'ready')`, [tenant,id,index===2?otherPaper:paper,stem,JSON.stringify(model)]);
  async function api(method,path,payload,status=200) {
    const response = await app.inject({ method,url:'/api/v1'+path,payload,headers:{origin,cookie:'beitibao_session='+token,'x-csrf-token':sha('csrf:'+token)} });
    assert.equal(response.statusCode,status,path+': '+response.body);
    return response.json();
  }
  const path = '/papers/'+paper+'/practice';
  const qpath = '/papers/'+paper+'/questions/'+ids[0];
  const completed = async () => (await api('GET','/progress')).courses[0].completedPapers;
  try {
    const started = await api('POST',path,{durationMinutes:10});
    const deadlineId = (await query('SELECT id FROM practice_deadline_outbox WHERE paper_id=$1',[paper])).rows[0].id;
    const first = await api('POST',path+'/save',{revision:started.revision,changes:{[ids[0]]:'B',[ids[1]]:'A'},submit:true});
    assert.equal(first.questions[0].result,'incorrect');
    assert.equal(await completed(),1);
    await api('POST',qpath+'/equivalences',{memberId:ids[2]});
    assert.equal(await completed(),2);
    await api('POST',qpath+'/reveal',{});
    await api('POST',qpath+'/assessment',{rating:'mastered'});
    const unchanged = await api('POST',qpath+'/stem-correction',{stem:' \n'+stem.replaceAll('\n','\r\n')+'\n '});
    assert.equal(unchanged.changed,false);
    assert.equal(await completed(),2);
    assert.equal((await api('POST',path,{})).attemptId,first.attemptId);
    const oldLease = randomUUID();
    await query("UPDATE paper_questions SET solution_status='processing',solution_lease=$2 WHERE id=$1",[ids[0],oldLease]);
    const changed = await api('POST',qpath+'/stem-correction',{stem:corrected});
    assert.equal(changed.inputRevision,2);
    await api('POST',qpath+'/stem-correction',{stem:'Stale tab',inputRevision:1},409);
    await api('POST',qpath+'/assessment',{rating:'mastered',inputRevision:1},404);
    assert.equal(await completed(),0);
    const revision = (await query('SELECT question,recall FROM question_revision_history WHERE question_id=$1',[ids[0]])).rows[0];
    assert.equal(revision.question.stem,stem);
    assert.equal(revision.question.model_solution.answer,'A');
    assert.equal(revision.recall.self_rating,'mastered');
    assert.equal((await query("UPDATE paper_questions SET model_solution='{}' WHERE id=$1 AND solution_lease=$2",[ids[0],oldLease])).rowCount,0);
    const beforeRestart = await api('GET',path);
    assert.equal(beforeRestart.questions[0].stem,stem);
    assert.equal(beforeRestart.questions[0].result,'incorrect');
    assert.equal(beforeRestart.questions[0].inputChanged,true);
    assert.equal(beforeRestart.questions[0].modelSolution.answer,'A');
    const current = await api('POST',path,{durationMinutes:10});
    assert.notEqual(current.attemptId,first.attemptId);
    assert.equal(current.submittedAt,null);
    assert.equal(current.questions[0].stem,corrected);
    assert.equal(current.questions[0].inputRevision,2);
    assert.deepEqual(current.answers,{});
    assert.ok(current.questions.every(q=>!('reference' in q)&&!('modelSolution' in q)));
    assert.equal((await api('POST',path,{})).attemptId,current.attemptId);
    const history = (await api('GET',path+'/history')).history;
    assert.equal(history.length,1);
    await api('GET',path+'/history/'+history[0].id,undefined,409);
    assert.equal((await api('GET','/mistakes')).mistakes.some(q=>q.id===ids[0]),false);
    await api('POST','/mistakes/'+ids[0]+'/retry',{attemptKey:randomUUID(),answer:'A'},404);
    await api('POST',path+'/save',{revision:started.revision,changes:{[ids[0]]:'A'},submit:true},409);
    // A previously delivered event ID cannot settle the replacement attempt.
    assert.equal(await consumePracticeDeadline({query,connect:async()=>({query,release(){}})},deadlineId),true);
    assert.equal((await api('GET',path)).submittedAt,null);
    await query("UPDATE paper_questions SET model_solution=$2,solution_status='ready' WHERE id=$1",[ids[0],JSON.stringify({...model,answer:'B'})]);
    const second = await api('POST',path+'/save',{revision:current.revision,changes:{[ids[0]]:'B'},submit:true});
    assert.equal(second.questions[0].result,'correct');
    // The unchanged second question remains covered by the old archived attempt.
    assert.equal(await completed(),1);
    const old = await api('GET',path+'/history/'+history[0].id);
    assert.equal(old.historical,true);
    assert.equal(old.questions[0].stem,stem);
    assert.equal(old.questions[0].modelSolution.answer,'A');
    assert.equal(old.questions[0].result,'incorrect');
    assert.equal(old.answers[ids[0]],'B');
    const mistakes = (await api('GET','/mistakes')).mistakes;
    assert.equal(mistakes.some(q=>q.id===ids[0]),false);
    // Reverting the text is another input version, not a resurrection of old coverage.
    await api('POST',qpath+'/stem-correction',{stem,inputRevision:2});
    assert.equal(await completed(),0);
    let third;
    afterCommit = async () => { third = await api('POST',path,{}); };
    const intercepted = await api('GET',path,undefined,409);
    assert.equal(intercepted.code,'CLOSED_BOOK_ACTIVE');
    assert.equal('questions' in intercepted,false);
    assert.equal(third.questions[0].inputRevision,3);
    assert.equal((await api('GET',path+'/history')).history.length,2);
    // A draft keeps the answer basis that existed before an in-flight correction.
    async function extraPaper(count, ready = true) {
      const id = randomUUID(), questions=[];
      await query(`INSERT INTO papers (tenant_id,id,course_id,title,fingerprint,pdf,status,pages,model_allowed)
        VALUES ($1,$2,$3,'Extra',$2::uuid::text,$4,'review','["page"]',true)`,[tenant,id,course,Buffer.alloc(0)]);
      for(let n=0;n<count;n++) {
        const q=randomUUID(); questions.push(q);
        await query(`INSERT INTO paper_questions (tenant_id,id,paper_id,page_number,fingerprint,stem,question_kind,model_solution,solution_status)
          VALUES ($1,$2,$3,1,$2::uuid::text,$4,'choice',$5,$6)`,[tenant,q,id,stem,ready?JSON.stringify(model):null,ready?'ready':'queued']);
      }
      return {id,questions,path:'/papers/'+id+'/practice',qpath:q=>'/papers/'+id+'/questions/'+q};
    }
    const draftPaper=await extraPaper(1);
    const oldDraft=await api('POST',draftPaper.path,{});
    await api('POST',draftPaper.qpath(draftPaper.questions[0])+'/stem-correction',{stem:corrected,inputRevision:1});
    const draftResult=await api('POST',draftPaper.path+'/save',{revision:oldDraft.revision,changes:{[draftPaper.questions[0]]:'B'},submit:true});
    assert.equal(draftResult.questions[0].stem,stem);
    assert.equal(draftResult.questions[0].modelSolution.answer,'A');
    assert.equal(draftResult.questions[0].result,'incorrect');
    const late=await extraPaper(2,false);
    const lateFirst=await api('POST',late.path,{});
    await api('POST',late.path+'/save',{revision:lateFirst.revision,changes:Object.fromEntries(late.questions.map(id=>[id,'B'])),submit:true});
    await api('POST',late.qpath(late.questions[1])+'/stem-correction',{stem:corrected,inputRevision:1});
    const lateCurrent=await api('POST',late.path,{});
    await query("UPDATE paper_questions SET model_solution=$2,solution_status='ready' WHERE id=$1",[late.questions[0],JSON.stringify(model)]);
    await api('POST',late.path+'/save',{revision:lateCurrent.revision,changes:{[late.questions[1]]:'B'},submit:true});
    const lateHistory=(await api('GET',late.path+'/history')).history[0];
    const lateSaved=await api('GET',late.path+'/history/'+lateHistory.id);
    assert.equal(lateSaved.questions.find(q=>q.id===late.questions[0]).result,'incorrect');
    assert.equal(lateSaved.questions.find(q=>q.id===late.questions[1]).result,'needs_review');
    assert.equal((await api('GET','/mistakes')).mistakes.find(q=>q.id===late.questions[0]).status,'open');
    assert.equal((await api('POST','/mistakes/'+late.questions[0]+'/retry',{attemptKey:randomUUID(),answer:'A'})).result,'correct');
    for (const worker of [queuePool,localPool].filter(Boolean)) {
      const timed=await extraPaper(1);
      const timer=await api('POST',timed.path,{durationMinutes:1});
      await api('POST',timed.path+'/save',{revision:timer.revision,changes:{[timed.questions[0]]:'B'},submit:false});
      await api('POST',timed.qpath(timed.questions[0])+'/stem-correction',{stem:corrected,inputRevision:1});
      await query("UPDATE practice_attempts SET deadline_at=now()-interval '1 second' WHERE paper_id=$1",[timed.id]);
      if(worker===queuePool) {
        const event=(await query('SELECT id FROM practice_deadline_outbox WHERE paper_id=$1',[timed.id])).rows[0];
        assert.equal(await consumePracticeDeadline(worker,event.id),true);
      } else await settleExpiredPractices(worker);
      const timedResult=await api('GET',timed.path);
      assert.ok(timedResult.submittedAt);
      assert.equal(timedResult.questions[0].result,'incorrect');
    }
    // Deletion locks a lower-ID prediction and its higher-ID source as one ordered set,
    // then removes their new history tables without affecting other papers.
    const { default: Fastify } = await import('fastify');
    const { registerPaperDeletion } = await import('../../dist/server/paper-deletion.js');
    const deletionCalls=[];
    const deletionPool={query:pool.query.bind(pool),connect:async()=>{
      const client=await pool.connect();
      return {query:async(sql,values=[])=>{deletionCalls.push({sql,values});return client.query(sql,values);},release:client.release.bind(client)};
    }};
    const deletionApp=Fastify();
    deletionApp.addHook('preHandler',async request=>{request.studySession={id:tenant};});
    registerPaperDeletion(deletionApp,deletionPool,'/api/v1');
    try {
      const deletionPapers=[await extraPaper(1),await extraPaper(1)].sort((a,b)=>a.id.localeCompare(b.id));
      const [predictionPaper,source]=deletionPapers;
      const d=await api('POST',source.path,{});
      await api('POST',source.path+'/save',{revision:d.revision,changes:{[source.questions[0]]:'A'},submit:true});
      await api('POST',source.qpath(source.questions[0])+'/stem-correction',{stem:corrected,inputRevision:1});
      await api('POST',source.path,{});
      await query('UPDATE papers SET is_prediction=true WHERE id=$1',[predictionPaper.id]);
      await query(`INSERT INTO predictions(tenant_id,course_id,source_digest,evidence,status,paper_id)
        VALUES ($1,$2,$3,$4,'ready',$5)`,[tenant,course,randomUUID(),JSON.stringify([{paperId:source.id}]),predictionPaper.id]);
      const deleted=await deletionApp.inject({method:'POST',url:'/api/v1/papers/'+source.id+'/delete',payload:{confirmed:true}});
      assert.equal(deleted.statusCode,204,deleted.body);
      const locks=deletionCalls.filter(call=>/FROM papers.*FOR UPDATE/s.test(call.sql));
      assert.equal(locks.length,1);
      assert.match(locks[0].sql,/ORDER BY id FOR UPDATE/);
      assert.deepEqual(locks[0].values[1],[predictionPaper.id,source.id]);
      assert.equal((await query('SELECT 1 FROM practice_history WHERE paper_id=$1',[source.id])).rowCount,0);
      assert.equal((await query('SELECT 1 FROM question_revision_history WHERE question_id=$1',[source.questions[0]])).rowCount,0);
      assert.equal((await query('SELECT 1 FROM papers WHERE id=ANY($1::uuid[])',[[source.id,predictionPaper.id]])).rowCount,0);
      assert.equal((await query('SELECT 1 FROM papers WHERE id=$1',[paper])).rowCount,1);
    } finally {await deletionApp.close();}
    // Unrelated accounts cannot list, read or mutate archived inputs.
    const foreign = randomUUID(), foreignToken=randomBytes(32).toString('base64url');
    await query('INSERT INTO accounts (id,email,password_hash) VALUES ($1,$2,$3)',[foreign,foreign+'@example.test','synthetic']);
    await query("INSERT INTO sessions (token_hash,account_id,expires_at) VALUES ($1,$2,now()+interval '1 hour')",[sha(foreignToken),foreign]);
    const response=await app.inject({method:'GET',url:'/api/v1'+path+'/history/'+history[0].id,headers:{origin,cookie:'beitibao_session='+foreignToken}});
    assert.equal(response.statusCode,404);
    const rights=(await pool.query("SELECT has_table_privilege(current_user,'practice_history','UPDATE') AS update_history,has_table_privilege(current_user,'question_revision_history','UPDATE') AS update_inputs")).rows[0];
    assert.deepEqual(rights,{update_history:false,update_inputs:false});
    return {cases:['cosmetic-no-op','versioned-coverage','recall-history','equivalence-revocation','stale-worker-rejection','immutable-old-result','fresh-attempt','closed-book-history-guard','interleaved-result-restart-guard','stale-save-rejection','stale-timer-rejection','unchanged-question-coverage','latest-answer-mistake-resolution','old-draft-answer-basis','archived-late-solution','archived-direct-retry',...(queuePool?['queue-role-expiry']:[]),...(localPool?['local-worker-expiry']:[]),'repeated-version-revert','tenant-history-isolation','append-only-permissions','ordered-related-deletion','archived-data-deletion']};
  } finally {await app.close();}
}
