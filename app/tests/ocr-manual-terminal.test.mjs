import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { registerRecognitionReview } from '../dist/server/recognition-review.js';

const codes=['MODEL_PAYMENT_REQUIRED','MODEL_SERVICE_NOT_ENABLED','MODEL_AUTHENTICATION_FAILED','MODEL_ACCESS_DENIED','MODEL_BUDGET_LIMIT','MODEL_NOT_CONFIGURED'];
function route(db,suffix){
  let handler;
  const app={get(){},post(path,_opts,fn){if(path.endsWith(suffix))handler=fn;}};
  registerRecognitionReview(app,{connect:async()=>db},'/test',undefined,true);
  return async(body={},params={})=>{
    const reply={status:200,code(n){this.status=n;return this;},send(body){return {status:this.status,body};}};
    return handler({studySession:{id:'tenant'},params:{paperId:'paper',...params},body,headers:{}},reply);
  };
}
const empty=()=>({rows:[],rowCount:0});
test('already saved confirmation stays idempotent without new writes',async()=>{
  const db={release(){},async query(sql){
    if(sql.includes('FROM papers p LEFT JOIN'))return {rows:[{media_type:'application/pdf',model_allowed:true,recognition:{stems:['Explain stacks.']}}]};
    if(sql.includes('FROM recognition_feedback f'))return {rows:[{outcome:'confirmed',reviewed_stem:'Explain stacks.',visual_review:null}]};
    assert.ok(!sql.includes('INSERT')&&!sql.includes('SELECT 1 FROM papers p WHERE'));
    return empty();
  }};
  assert.deepEqual(await route(db,'/recognition-review')({candidateIndex:0,stem:'Explain stacks.'}),{outcome:'confirmed'});
});
test('rejecting a candidate remains available without queueing a model',async()=>{
  let feedback=false;
  const db={release(){},async query(sql){
    if(sql.includes('FROM papers p LEFT JOIN'))return {rows:[{media_type:'application/pdf',model_allowed:true,recognition:{stems:['Explain stacks.']}}]};
    if(sql.includes('SELECT pdf_figure_pending'))return {rows:[{pending:false}]};
    assert.ok(!sql.includes('INSERT INTO paper_questions')&&!sql.includes('SELECT 1 FROM papers p WHERE'));
    if(sql.includes('INSERT INTO recognition_feedback'))feedback=true;
    return empty();
  }};
  assert.deepEqual(await route(db,'/recognition-review')({candidateIndex:0,stem:null}),{outcome:'rejected'});
  assert.equal(feedback,true);
});
for(const terminal of codes){
  test('manual candidate is blocked before INSERT for '+terminal,async()=>{
    let inserts=0,gate=false;
    const db={release(){},async query(sql,args){
      if(sql.includes('FROM papers p LEFT JOIN'))return {rows:[{media_type:'application/pdf',model_allowed:true,recognition:{stems:['Explain stacks.']}}]};
      if(sql.includes('SELECT 1 FROM papers p WHERE')){gate=true;assert.ok(args[2].includes(terminal));return {rows:[{}],rowCount:1};}
      if(sql.includes('INSERT'))inserts++;
      return empty();
    }};
    assert.deepEqual(await route(db,'/recognition-review')({candidateIndex:0,stem:'Explain stacks.'}),{status:409,body:{code:'MODEL_RECOVERY_REQUIRED'}});
    assert.equal(gate,true);assert.equal(inserts,0);
  });
}
test('manual candidate without terminal errors still publishes and queues',async()=>{
  let queued=false;
  const db={release(){},async query(sql,args){
    if(sql.includes('FROM papers p LEFT JOIN'))return {rows:[{media_type:'application/pdf',model_allowed:true,recognition:{stems:['Explain stacks.'],model:'test',promptVersion:'test'}}]};
    if(sql.includes('SELECT pdf_figure_pending'))return {rows:[{pending:false}]};
    if(sql.includes('INSERT INTO paper_questions')){queued=args[6]==='queued';return {rows:[{id:'question'}]};}
    return empty();
  }};
  assert.deepEqual(await route(db,'/recognition-review')({candidateIndex:0,stem:'Explain stacks.'}),{outcome:'confirmed'});
  assert.equal(queued,true);
});

for(const terminal of [...codes,'OCR_NOT_CONFIGURED','OCR_REQUEST_FAILED'])for(const concurrentReview of [false,true,'changed']){
  test(`manual reread ${terminal}; concurrent review=${concurrentReview}`,async()=>{
    const previousWorkspace=process.env.BAILIAN_WORKSPACE_ID,previousKey=process.env.DASHSCOPE_API_KEY;
    const previousFetch=globalThis.fetch;
    process.env.BAILIAN_WORKSPACE_ID='synthetic-test';process.env.DASHSCOPE_API_KEY='synthetic-not-a-secret';
    globalThis.fetch=async()=>{assert.fail('No live model request is permitted');};
    const image=await sharp({create:{width:20,height:20,channels:3,background:'white'}}).png().toBuffer();
    const original={box:[0,0,1000,1000],initial:null,reread:null,status:'needs_review'};
    let figure=structuredClone(original),writes=0,failed=false;
    const db={release(){},async query(sql,args){
      if(sql.includes('FROM papers p LEFT JOIN'))return {rows:[{pdf:image,media_type:'image/png',model_allowed:true,recognition:{stems:['Figure'],figures:[[structuredClone(figure)]]}}]};
      if(sql.includes('SELECT 1 FROM recognition_feedback'))return {rows:[],rowCount:failed&&concurrentReview===true?1:0};
      if(sql.includes('UPDATE papers SET recognition')){figure=JSON.parse(args[3]);writes++;return {rows:[],rowCount:1};}
      if(sql.includes('AT TIME ZONE')){failed=true;if(concurrentReview==='changed')figure.reason='structure';throw Error(terminal);}
      return empty();
    }};
    try{
      const result=await route(db,'/reread')({box:[0,0,1000,1000]},{candidate:0,figure:0});
      if(codes.includes(terminal)||terminal==='OCR_NOT_CONFIGURED'){
        assert.deepEqual(result,{status:409,body:{code:terminal}});
        assert.equal(writes,concurrentReview?1:2);
        if(!concurrentReview)assert.deepEqual(figure,original);
      }else assert.ok(result.figure);
    }finally{
      globalThis.fetch=previousFetch;
      if(previousWorkspace===undefined)delete process.env.BAILIAN_WORKSPACE_ID;else process.env.BAILIAN_WORKSPACE_ID=previousWorkspace;
      if(previousKey===undefined)delete process.env.DASHSCOPE_API_KEY;else process.env.DASHSCOPE_API_KEY=previousKey;
    }
  });
}
