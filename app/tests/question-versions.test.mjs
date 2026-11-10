import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { stemKey } from '../dist/server/question-versions.js';
test('cosmetic normalization preserves meaningful internal whitespace and formula differences',()=>{
  assert.equal(stemKey(' \r\nA\r\nB \n'),'A\nB');
  assert.notEqual(stemKey('x y'),stemKey('xy'));
  assert.notEqual(stemKey('x < 1'),stemKey('x > 1'));
});
test('versioned practice retains history and restarts only changed inputs',async()=>{
  const {verifyQuestionVersions}=await import('./fixtures/question-versions.mjs');
  const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
  const admin=new pg.Pool({connectionString:process.env.MIGRATION_DATABASE_URL});
  const queue=new pg.Pool({connectionString:process.env.PRACTICE_QUEUE_DATABASE_URL});
  const local=new pg.Pool({connectionString:process.env.LOCAL_PAPER_WORKER_DATABASE_URL});
  try {await verifyQuestionVersions(pool,(sql,values)=>admin.query(sql,values),queue,local);}
  finally {await pool.end();await admin.end();await queue.end();await local.end();}
});
test('personal revision solver preserves corrected conditions and records its prompt variant',async()=>{
  const {solveQuestion}=await import('../dist/server/model-solution.js');
  const workspace=process.env.BAILIAN_WORKSPACE_ID,key=process.env.DASHSCOPE_API_KEY;
  process.env.BAILIAN_WORKSPACE_ID='synthetic-workspace';process.env.DASHSCOPE_API_KEY='synthetic-key';
  try {
    const solved=await solveQuestion('Use the corrected condition',async(_url,options)=>{
      const body=JSON.parse(options.body);
      assert.match(body.messages[0].content,/个人修订版/);
      assert.match(body.messages[0].content,/不得用原卷旧题干或旧参考答案替换/);
      return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({status:'solved',answer:'New answer',explanation:'Use the new condition'})}}]});
    },undefined,'Old source text',undefined,'short_answer',true);
    assert.match(solved.promptVersion,/-personal-v1$/);
  } finally {
    if(workspace===undefined) delete process.env.BAILIAN_WORKSPACE_ID;else process.env.BAILIAN_WORKSPACE_ID=workspace;
    if(key===undefined) delete process.env.DASHSCOPE_API_KEY;else process.env.DASHSCOPE_API_KEY=key;
  }
});
