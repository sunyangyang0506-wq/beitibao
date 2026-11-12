import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { recognizeImage } from '../dist/server/image-recognition.js';
process.env.BAILIAN_WORKSPACE_ID = 'synthetic-test';
process.env.DASHSCOPE_API_KEY = 'synthetic-no-network';
const image = await sharp({ create: { width: 100, height: 100, channels: 3, background: 'white' } }).png().toBuffer();
const ok = payload => Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(payload)}}]});
for (const [status, body, code] of [
  [400,{error:{code:'Arrearage'}},'MODEL_PAYMENT_REQUIRED'],
  [402,{},'MODEL_PAYMENT_REQUIRED'],
  [401,{},'MODEL_AUTHENTICATION_FAILED'],
  [403,{error:{code:'AccessDenied.Unpurchased'}},'MODEL_SERVICE_NOT_ENABLED'],
  [403,{},'MODEL_ACCESS_DENIED']
]) test(`page stops on ${status} ${code}`, async () => {
  let calls=0;
  await assert.rejects(recognizeImage(image,'image/png',async()=>{calls++;return Response.json(body,{status});}), {message:code});
  assert.equal(calls,1);
});
for (const [name,payload,choiceOnly] of [
  ['choice recovery',{questions:[{stem:'1. 选哪一个 A. 甲',choiceOptionCount:4}]},false],
  ['question number recovery',{questions:[{stem:'11. 前一题 A. 甲 B. 乙 C. 丙 D. 丁'},{stem:'没有编号 A. 甲 B. 乙 C. 丙 D. 丁'},{stem:'13. 后一题 A. 甲 B. 乙 C. 丙 D. 丁'}]},true],
  ['figure reread',{questions:[{stem:'1. 图',questionBox:[0,0,1000,1000],figures:[{box:[100,100,500,500],reading:{description:'graph'}}]}]},false]
]) test(`${name} cannot swallow a terminal failure`,async()=>{
  let calls=0;
  await assert.rejects(recognizeImage(image,'image/png',async()=>++calls===1?ok(payload):Response.json({error:{code:'Arrearage'}},{status:400}),choiceOnly),{message:'MODEL_PAYMENT_REQUIRED'});
  assert.equal(calls,2);
});
test('crop budget exhaustion propagates instead of producing a successful page',async()=>{
  let calls=0;
  await assert.rejects(recognizeImage(image,'image/png',async()=>{
    if(++calls===1)return ok({questions:[{stem:'1. 选哪一个 A. 甲',choiceOptionCount:4}]});
    throw new Error('MODEL_BUDGET_LIMIT');
  }),{message:'MODEL_BUDGET_LIMIT'});
  assert.equal(calls,2);
});
