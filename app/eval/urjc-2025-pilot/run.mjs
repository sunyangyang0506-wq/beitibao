import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const {recognizeImage}=await import(pathToFileURL(resolve('app/dist/server/image-recognition.js')));
const {solutionChecks,solutionContent}=await import(pathToFileURL(resolve('app/dist/server/model-solution.js')));
const dir=resolve('app/eval/urjc-2025-pilot');
const items=JSON.parse(await readFile(dir+'/question-text.json'));
const endpoint='https://'+process.env.BAILIAN_WORKSPACE_ID+'.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions';
const results=[];
for (const [id, blocks] of Object.entries(items)) {
 const row={id};
 results.push(row);
 let recognition;
 try {
  row.recognition=await recognizeImage(await readFile(dir+'/inputs/'+id+'.png'),'image/png',async (...args)=>{
   const response=await fetch(...args);
   recognition=await response.clone().json();
   row.recognitionUsage=recognition.usage;
   row.recognitionRequestId=recognition.request_id??recognition.id;
   if(!response.ok) row.recognitionHTTP=response.status;
   return response;
  });
 } catch(e){row.recognitionError=e.message;}
 try {
  const hasDiagram=blocks.some(t=>t.startsWith('@'));
  const model=hasDiagram?'qwen3-vl-plus':'qwen-plus-2025-12-01';
  const stem=blocks.filter(t=>!t.startsWith('@')).join('\n');
  const visualContext=hasDiagram?row.recognition?.visualContexts?.join('\n'):'';
  const image=hasDiagram?{bytes:await readFile(dir+'/inputs/'+id+'-diagram.png'),mediaType:'image/png'}:undefined;
  const content=solutionContent(visualContext?stem+'\nTranscripción auxiliar no verificada: '+visualContext:stem,image);
  const response=await fetch(endpoint,{method:'POST',redirect:'error',signal:AbortSignal.timeout(45000),
   headers:{Authorization:'Bearer '+process.env.DASHSCOPE_API_KEY,'Content-Type':'application/json'},
   body:JSON.stringify({model,enable_thinking:false,max_tokens:2048,response_format:{type:'json_object'},messages:[
    {role:'system',content:'Resuelve todos los apartados en español. Devuelve solo un objeto JSON con la clave answer (cadena). Responde al problema tal como está escrito. Para un árbol o grafo, describe sus aristas explícitamente. Para código Pascal, incluye la implementación si se pide. '+solutionChecks},
    {role:'user',content}]})});
  const body=await response.json();
  row.solution={model,status:response.status,usage:body.usage,requestId:body.request_id??body.id,finishReason:body.choices?.[0]?.finish_reason};
  if(response.ok) row.solution.answer=JSON.parse(body.choices[0].message.content).answer;
  else row.solution.code=body.error?.code??body.code;
 } catch(e) {row.solutionError=e.message;}
 await writeFile(dir+'/results-v2.json',JSON.stringify(results,null,2)+'\n');
 console.log(id,row.recognition?.stems.length??row.recognitionError,row.solution?.status,row.solution?.finishReason);
}
