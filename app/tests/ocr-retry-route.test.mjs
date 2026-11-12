// Route/SQL-contract regressions; native PostgreSQL execution is still required.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerRecognitionReview } from '../dist/server/recognition-review.js';
const whitelist=['MODEL_PAYMENT_REQUIRED','MODEL_SERVICE_NOT_ENABLED','MODEL_AUTHENTICATION_FAILED','MODEL_ACCESS_DENIED','MODEL_BUDGET_LIMIT','MODEL_NOT_CONFIGURED'];
function routeWith({owned=true,locked=false,modelsEnabled=true,rowCounts=[1]}={}) {
  let handler;const queries=[];
  const db={async query(sql,params=[]){
    queries.push({sql,params});
    if(['BEGIN','COMMIT','ROLLBACK'].includes(sql)||sql.includes('set_config')) return {rows:[],rowCount:0};
    assert.deepEqual(params.slice(0,2),['tenant','paper']);
    if(sql.includes('SELECT 1 FROM papers')){assert.match(sql,/NOT is_prediction FOR UPDATE/);return {rows:owned?[{}]:[],rowCount:owned?1:0};}
    if(sql.includes('FROM practice_attempts'))return {rows:[],rowCount:locked?1:0};
    if(sql.includes('UPDATE papers SET status')){
      assert.match(sql,/WHERE tenant_id = \$1 AND id = \$2/);
      assert.match(sql,/\$3 AND media_type IN \('image\/png', 'image\/jpeg'\) AND model_allowed/);
      assert.match(sql,/status = 'review' AND object_key IS NOT NULL/);
      assert.match(sql,/failure = ANY\(\$4::text\[\]\) AND recognition IS NULL/);
      assert.match(sql,/NOT EXISTS \(SELECT 1 FROM paper_questions WHERE tenant_id = \$1 AND paper_id = \$2\)/);
      assert.equal(params[2],modelsEnabled);assert.deepEqual(params[3],whitelist);
      assert.ok(queries.findIndex(q=>q.sql.includes('FOR UPDATE'))<queries.length-1);
      return {rows:[],rowCount:rowCounts.shift()??0};
    }
    throw Error('Unexpected SQL '+sql);
  },release(){}};
  const pool={async connect(){return db;}};
  const app={get(){},post(path,_opts,fn){if(path.endsWith('/retry-recognition'))handler=fn;}};
  registerRecognitionReview(app,pool,'/test',{modelsEnabled});
  return {queries,async invoke(){const reply={status:null,code(status){this.status=status;return this;},send(body){return {status:this.status,body};}};return handler({studySession:{id:'tenant'},params:{paperId:'paper'}},reply);}};
}
test('explicit recovery queues once and repeated request returns 409 without another job',async()=>{
  const route=routeWith({rowCounts:[1,0]});
  assert.deepEqual(await route.invoke(),{status:202,body:{status:'queued'}});
  assert.deepEqual(await route.invoke(),{status:409,body:{code:'RECOGNITION_UNAVAILABLE'}});
  // The database UPDATE predicate admits only failed/review, never queued/processing.
  for(const {sql} of route.queries.filter(q=>q.sql.includes('UPDATE papers SET status'))){
    assert.ok(!sql.includes("status = 'processing'"));
    assert.equal((sql.match(/status = 'queued'/g)||[]).length,1);
  }
});
test('wrong tenant/missing/prediction paper cannot reach retry UPDATE',async()=>{
  const route=routeWith({owned:false});
  assert.equal((await route.invoke()).status,409);
  assert.ok(!route.queries.some(q=>q.sql.includes('UPDATE papers SET status')));
});
test('closed-book attempt cannot retry or clear failure',async()=>{
  const route=routeWith({locked:true});
  assert.deepEqual(await route.invoke(),{status:409,body:{code:'CLOSED_BOOK_ACTIVE'}});
  assert.ok(!route.queries.some(q=>q.sql.includes('UPDATE papers SET status')));
});
test('disabled-model configuration is passed into restrictive database guard',async()=>{
  const route=routeWith({modelsEnabled:false,rowCounts:[0]});
  assert.equal((await route.invoke()).status,409);
});
