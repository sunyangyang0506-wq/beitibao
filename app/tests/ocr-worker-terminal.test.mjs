// SQL-parameter regressions, not a substitute for native PostgreSQL integration.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { samplePaper } from './fixtures/sample-paper.mjs';
import { processNextPaper } from '../dist/server/paper-worker.js';
import { processNextPageRecognition } from '../dist/server/pdf-page-recognition.js';
import { loadOrProcessPaper, solvePaper } from '../dist/server/paper-model-cache.js';
const terminal = ['MODEL_PAYMENT_REQUIRED','MODEL_SERVICE_NOT_ENABLED','MODEL_AUTHENTICATION_FAILED','MODEL_ACCESS_DENIED','MODEL_BUDGET_LIMIT'];
function poolFor(handler) {
  const statements=[];
  const pool={statements,async query(sql,params=[]) {
    statements.push({sql,params});
    if(['BEGIN','COMMIT','ROLLBACK'].includes(sql) || sql.includes('set_config')) return {rows:[],rowCount:0};
    return handler(sql,params);
  },async connect(){return {...pool,release(){}};}};
  return pool;
}
for(const code of terminal) {
  test(`PDF page persists failed/null recognition and safe code: ${code}`,async()=>{
    let calls=0, saved;
    const pool=poolFor((sql,params)=>{
      if(sql.includes('WITH next'))return {rows:[{tenant_id:'tenant',paper_id:'paper',page_number:1,pdf:samplePaper(),media_type:'application/pdf',object_key:null,auto_assignment:false,course_id:null}]};
      if(sql.includes('SELECT jsonb_array_length'))return {rows:[{count:1,review_revision:0}]};
      if(sql.includes('UPDATE paper_page_recognition SET status')) {saved=params;return {rows:[],rowCount:1};}
      if(sql.includes('SELECT r.page_number'))return {rows:[{page_number:1,status:'failed',failure:code,recognition:null,reviewed_at:null}]};
      throw Error('Unexpected SQL '+sql);
    });
    assert.equal(await processNextPageRecognition(pool,async()=>{calls++;throw Error(code);},undefined,undefined,true),true);
    assert.equal(calls,1);
    assert.deepEqual(saved.slice(4),['failed',code,null]);
    assert.ok(!pool.statements.some(({sql})=>/INSERT INTO paper_questions|SET status = 'published'/.test(sql)));
  });
  test(`private image stays review with failure/null recognition: ${code}`,async()=>{
    const png=await sharp({create:{width:30,height:30,channels:3,background:'white'}}).png().toBuffer();
    let calls=0,saved;
    const pool=poolFor((sql,params)=>{
      if(sql.includes('WITH next'))return {rows:[{tenant_id:'tenant',id:'paper',pdf:png,media_type:'image/png',object_key:null,model_allowed:true,model_cache_key:null}]};
      if(sql.includes('UPDATE papers SET status')) {saved=params;return {rows:[],rowCount:1};}
      throw Error('Unexpected SQL '+sql);
    });
    assert.equal(await processNextPaper(pool,async()=>{calls++;throw Error(code);},undefined,{modelsEnabled:true}),true);
    assert.equal(calls,1);
    assert.deepEqual(saved.slice(3),['review','[""]',code,null]);
    assert.ok(!pool.statements.some(({sql})=>/INSERT INTO paper_questions|SET status = 'published'/.test(sql)));
  });
}
function cachePool(){return poolFor((sql)=>{
  if(sql.includes('SELECT 1 FROM papers')) return {rows:[{}],rowCount:1};
  if(sql.includes('SELECT pages, recognition')) return {rows:[],rowCount:0};
  if(sql.includes('INSERT INTO paper_model_cache_claim'))return {rows:[],rowCount:1};
  if(sql.includes('pg_advisory_xact_lock')||sql.includes('DELETE FROM paper_model_cache_claim'))return {rows:[],rowCount:0};
  throw Error('Unexpected SQL '+sql);
});}
test('cache propagates terminal solution errors and always releases claim without caching',async()=>{
  for(const code of terminal){
    const pool=cachePool();let calls=0;
    await assert.rejects(loadOrProcessPaper(pool,'tenant','key',async()=>({pages:['exam'],recognition:null}),async()=>{calls++;throw Error(code);}),{message:code});
    assert.equal(calls,1);
    assert.ok(pool.statements.some(({sql})=>sql.includes('DELETE FROM paper_model_cache_claim')));
    assert.ok(!pool.statements.some(({sql})=>sql.includes('INSERT INTO paper_model_cache (')));
  }
});
test('nonterminal malformed solution keeps extraction without caching',async()=>{
  const pool=cachePool();const extracted={pages:['exam'],recognition:null};
  assert.deepEqual(await loadOrProcessPaper(pool,'tenant','key',async()=>extracted,async()=>{throw Error('INVALID_PAPER_SOLUTIONS');}),extracted);
});
test('whole-paper adapter uses safe provider codes without response details',async()=>{
  process.env.BAILIAN_WORKSPACE_ID='synthetic';process.env.DASHSCOPE_API_KEY='synthetic';
  for(const [status,body,code] of [[400,{error:{code:'Arrearage'}},'MODEL_PAYMENT_REQUIRED'],[402,{},'MODEL_PAYMENT_REQUIRED'],[401,{},'MODEL_AUTHENTICATION_FAILED'],[403,{error:{code:'AccessDenied.Unpurchased'}},'MODEL_SERVICE_NOT_ENABLED'],[403,{},'MODEL_ACCESS_DENIED']]){
    let calls=0;
    await assert.rejects(solvePaper('exam',undefined,undefined,async()=>{calls++;return Response.json(body,{status});}),{message:code});assert.equal(calls,1);
  }
});

// Recovery routes call this same publication function with cache reuse disabled.
// These tests exercise both caller modes, including a previously reviewed failure.
test('whole-paper gate blocks mixed successful/terminal pages in worker and recovery modes',async()=>{
  const { publishCompletedPages } = await import('../dist/server/pdf-page-recognition.js');
  for(const reuseSolutions of [true,false]) for(const reviewed_at of [null,new Date()]) for(const code of terminal) {
    const order=[];
    const db={async query(sql,params){
      order.push(sql);
      assert.deepEqual(params,['tenant','paper']);
      if(sql.includes('SELECT 1 FROM papers')) {
        assert.match(sql,/FOR UPDATE/);return {rows:[{}],rowCount:1};
      }
      if(sql.includes('SELECT r.page_number')) {
        assert.match(sql,/FOR UPDATE OF r/);
        assert.match(order[0],/SELECT 1 FROM papers/);
        return {rows:[
          {page_number:1,status:'review',failure:null,reviewed_at:null,recognition:{stems:['1. Explain a stack.']}},
          {page_number:2,status:'failed',failure:code,reviewed_at,recognition:null}
        ]};
      }
      throw Error('Terminal gate allowed a publication/cache/queue side effect: '+sql);
    }};
    assert.equal(await publishCompletedPages(db,'tenant','paper',reuseSolutions,true),false);
    assert.equal(order.length,2);
  }
});
test('paper lock is acquired before publication gate and missing paper cannot publish',async()=>{
  const { publishCompletedPages } = await import('../dist/server/pdf-page-recognition.js');
  let calls=0;
  assert.equal(await publishCompletedPages({async query(sql){calls++;assert.match(sql,/SELECT 1 FROM papers.*FOR UPDATE/);return {rows:[],rowCount:0};}},'tenant','missing'),false);
  assert.equal(calls,1);
});
