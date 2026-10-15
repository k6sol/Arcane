import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createCodexService, type CodexActionOutcome,type CodexHostClient } from '../../apps/daemon/src/codex-service.js';
import { codexRoutes } from '../../apps/daemon/src/codex-routes.js';
import { createNativeAssetRegistry } from '../../apps/daemon/src/native-asset-authority.js';
import { CodexSession } from '../../packages/codex-client/src/session.js';
import { nativeEnvironment } from '../../packages/codex-client/src/transport.js';
import { limits } from '../../packages/codex-client/src/validation.js';
import { ARCANE_NATIVE_TOOL_NAMES } from '../../packages/protocol/src/arcane-tools.js';
import type { StudioTestTaskOrigin, StudioTestTaskSettled } from '../../packages/protocol/src/chat-task-playtest.js';
import { ChatTaskStore } from '../../packages/storage/src/chat-task-store.js';
import { DatabaseSync } from 'node:sqlite';
import { sqliteTransportPath } from '../../packages/storage/src/sqlite-path.js';
import {referenceInput} from '../../packages/codex-client/testing/reference-fixture.js';
import {referenceImageMetadata} from '../../packages/codex-client/src/reference-images.js';

const THREAD='managed.thread:exact', SESSION='managed.session:exact', HASH='a'.repeat(64), SUBJECT='b'.repeat(64);
// Production client/service/registry/SQLite/HTTP with a labelled JSONL process
// peer. This process is not a native provider or Studio acceptance test.
const PEER=String.raw`
const {createInterface}=require('node:readline'),{appendFileSync,existsSync}=require('node:fs');
const [encoded,audit]=process.argv.slice(1),s=JSON.parse(encoded);let checks=0,turns=0,threadId='managed.thread:exact';
const send=v=>process.stdout.write(JSON.stringify(v)+'\n'),reply=(id,result)=>send({id,result});
if(s.mode==='hold-close-current'&&s.index===1){setInterval(()=>{},1000);process.on('SIGTERM',()=>{const timer=setInterval(()=>{if(existsSync(s.gate+'-close')){clearInterval(timer);process.exit(0);}},5);});}
createInterface({input:process.stdin}).on('line',line=>{
 const message=JSON.parse(line),{id,method,params={}}=message;appendFileSync(audit,JSON.stringify({process:s.index,...message})+'\n');
 if(!method||method==='initialized')return;
 if(method==='initialize')return reply(id,{});
 if(method==='account/read')return reply(id,{account:{type:'chatgpt',email:s.email,planType:'plus'},requiresOpenaiAuth:true});
 if(method==='model/list')return reply(id,{data:[{id:'fixture',model:'fixture',displayName:'Fixture',supportedReasoningEfforts:[{reasoningEffort:'low'}],...(s.modalities?{inputModalities:s.modalities}:{})}],nextCursor:null});
 if(method==='thread/start'||method==='thread/resume'){threadId=params.threadId??s.newThread;const result={thread:{id:threadId,sessionId:s.session,turns:[],status:{type:'idle'}},model:params.model,modelProvider:'openai',cwd:process.cwd(),approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:{type:'readOnly',networkAccess:false}};
  if(s.mode==='hold-resume'&&method==='thread/resume'){const timer=setInterval(()=>{if(existsSync(s.gate+'-resume')){clearInterval(timer);reply(id,result);}},5);return;}return reply(id,result);}
 if(method==='thread/read')return reply(id,{thread:{id:params.threadId,sessionId:s.session,cwd:process.cwd(),ephemeral:false,turns:s.mode==='history-frame-limit'?[{id:'large-history-turn',status:'completed',error:null,items:[{type:'userMessage',id:'large-history-item',content:[{type:'text',text:'x'.repeat(1048576),text_elements:[]}]}]}]:[]}});
 if(method==='mcpServerStatus/list'){
  checks++;const result={data:[{name:'arcane',runtimeStatus:'connected',toolsError:null,pluginId:null,tools:Object.fromEntries(s.tools.map(n=>[n,{}]))}],nextCursor:null};
  if(s.mode==='hold-preflight'&&checks>1||s.mode==='hold-repair'&&checks>2){const timer=setInterval(()=>{if(existsSync(s.gate+'-preflight')){clearInterval(timer);reply(id,result);}},5);return;}
  return reply(id,result);
 }
 if(method==='turn/start'){
  turns++;if(s.mode==='unknown-repair'&&turns===2)return reply(id,{});
  const turn={id:'managed.turn:'+s.index+':'+turns,status:['complete','hold-repair'].includes(s.mode)?'completed':'inProgress'};
  if(s.mode==='hold-ack'){const timer=setInterval(()=>{if(existsSync(s.gate+'-ack')){clearInterval(timer);reply(id,{turn});}},5);}else reply(id,{turn});
  if(s.mode==='repair-approval'&&turns===2)send({id:'managed.approval:'+s.index+':'+turns,method:'item/commandExecution/requestApproval',params:{threadId,turnId:turn.id,itemId:'managed.command:'+turns,command:'synthetic-local-command',cwd:process.cwd(),availableDecisions:['accept','decline','cancel']}});
  if(turn.status==='inProgress'){const timer=setInterval(()=>{if(!existsSync(s.gate+'-'+turns))return;clearInterval(timer);send({method:'turn/completed',params:{threadId,turn:{...turn,status:'completed'}}});},5);}
  return;
 }
 if(method==='turn/interrupt')return reply(id,{});
 throw Error('Unexpected synthetic method '+method);
});`;

interface Wire { process:number; method:string; params:Record<string,unknown>;id?:string|number;result?:unknown }
async function until(check:()=>boolean|Promise<boolean>){const end=Date.now()+6000;while(!await check()){assert.ok(Date.now()<end,'Expected managed task fixture state.');await delay(5);}}
function packet(jobId=randomUUID(),outcome:'passed'|'failed'='failed'):StudioTestTaskSettled {
  return {jobId,displayDigest:HASH,scenarioDigest:HASH,subjectDigest:SUBJECT,reportDigest:createHash('sha256').update(jobId+outcome).digest('hex'),
    review:{runId:randomUUID(),evidence:'fixture',nativeAcceptance:false,binding:null,scopeDigest:HASH,phase:'done',outcome:outcome==='passed'?'succeeded':'failed',
      code:outcome==='passed'?'OK':'ASSERTION_FAILED' as StudioTestTaskSettled['review']['code'],cleanup:'complete',startedAt:1,deadline:2,cleanupDeadline:3,watchdog:{armed:false,fired:false,reason:null},
      observations:1,logs:[],logsTruncated:false,requiresHumanReview:false,canStartAnotherOperation:true},
    scenario:{outcome,requiredEvidence:'complete',inputRelease:'complete',restoration:'complete',subjects:'current'}};
}
async function fixture(t:test.TestContext,options:{mode?:string;email?:(index:number)=>string|null;modalities?:(index:number)=>string[];revalidation?:'current'|'changed'|'unobserved';newThread?:(index:number)=>string;legacy?:true}={}){
 const boundary=await realpath(tmpdir()),root=await realpath(await mkdtemp(join(boundary,'arcane-managed-task-'))),project=join(root,'project');await mkdir(project);
 const registry=createNativeAssetRegistry({projectPath:await realpath(project)}),clients:CodexSession[]=[],tokens:string[]=[],audit=join(root,'wire.jsonl');
 const cancelled:{jobId:string;origin:StudioTestTaskOrigin}[]=[],validated:string[]=[];
 let service=createCodexService({directory:join(root,'journal'),projectPath:project,assetRegistry:registry,connect:async hooks=>{
   assert.ok(hooks);tokens.push(hooks.finalCredential());const index=clients.length;
   const client=new CodexSession({command:process.execPath,args:['-e',PEER,JSON.stringify({index,mode:options.mode??'held',email:options.email?options.email(index):'fixture@example.invalid',modalities:options.modalities?.(index),session:SESSION,newThread:options.newThread?.(index)??THREAD,gate:join(root,'finish-'+index),tools:ARCANE_NATIVE_TOOL_NAMES}),audit],cwd:project,env:nativeEnvironment()},limits({requestTimeoutMs:1500}),'spawned-node-fixture','arcane-only',hooks);
   clients.push(client);await client.initialize();
   if(options.legacy){const methods=['snapshot','selectModel','startThread','resumeThread','grantThreadWrites','revokeThreadWrites','startTurn','interruptTurn','respondApproval','close']as const;
     return Object.fromEntries(methods.map(name=>[name,(Reflect.get(client,name)as Function).bind(client)]))as CodexHostClient;}
   return client;
 }});
 service.attachPlaytestCancellation(Object.freeze({async cancelExact(jobId:string,origin:StudioTestTaskOrigin){cancelled.push({jobId,origin});},
   async revalidateExact(jobId:string,_origin:StudioTestTaskOrigin,_digest:string){validated.push(jobId);return options.revalidation??'current';}}));
 const control='human-'+randomUUID(),generic='agent-'+randomUUID(),route=codexRoutes(service);let origin='';
 const server=createServer(async(request,response)=>{if(!await route(request,response,new URL(request.url??'/',origin),control,origin,generic)){response.writeHead(404);response.end();}});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
 t.after(async()=>{await service.close();registry.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
   const part=relative(boundary,root);assert.ok(part.startsWith('arcane-managed-task-')&&!isAbsolute(part)&&!part.includes(sep));await rm(root,{recursive:true,force:true});});
 const post=async(input:unknown,bearer=control,requestOrigin=origin,path=!!input&&typeof input==='object'&&Object.hasOwn(input,'references')?'/v1/codex/reference-turn':'/v1/codex/action')=>{const response=await fetch(origin+path,{method:'POST',headers:{Authorization:'Bearer '+bearer,Origin:requestOrigin,'Content-Type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(10000)});return {status:response.status,data:await response.json() as CodexActionOutcome};};
 const excessiveReferenceBody=()=>new Promise<{status:number;error:string}>((resolve,reject)=>{
   // Send the excessive declared length without uploading rejected bytes. The
   // real route must refuse at its header boundary; its bounded discard closes
   // an unfinished upload, so a large fetch body cannot reliably read the reply.
   const request=httpRequest(origin+'/v1/codex/reference-turn',{method:'POST',headers:{Authorization:'Bearer '+control,Origin:origin,'Content-Type':'application/json','Content-Length':'1000001'},signal:AbortSignal.timeout(10000)},response=>{
     let body='';response.setEncoding('utf8');response.on('data',chunk=>{body+=chunk;assert.ok(body.length<4096);});response.on('error',reject);
     response.on('end',()=>{try{resolve({status:response.statusCode!,error:(JSON.parse(body)as {error:string}).error});}catch(error){reject(error);}finally{request.destroy();}});
   });request.on('error',reject);request.end();
 });
 const action=(action:string,fields:Record<string,unknown>={})=>post({requestId:randomUUID(),connectionId:action==='connect'?null:service.state().snapshot!.connectionId,action,...fields});
 const ready=async()=>{for(const [actionName,fields]of [['connect',{}],['select',{model:'fixture',effort:'low'}],['thread-start',{}]]as const)assert.equal((await action(actionName,fields)).data.record.state,'acknowledged');};
 const send=(text='Synthetic human task')=>action('turn-start',{threadId:service.state().snapshot!.thread!.threadId,text,allowWorkspaceWrites:true,allowAssets:true});
 const task=()=>service.state().chatTasks!.at(-1)!;
 const taskOrigin=(index=0)=>service.playtestTasks!.capture('agent-'+createHash('sha256').update(tokens[index]!).digest('hex'))!;
 const prepare=(binding:StudioTestTaskOrigin,report:StudioTestTaskSettled)=>service.playtestTasks!.prepared(binding,{jobId:report.jobId,displayDigest:report.displayDigest,scenarioDigest:report.scenarioDigest,subjectDigest:report.subjectDigest});
 const wire=async():Promise<Wire[]>=>(await readFile(audit,'utf8')).trim().split('\n').map(line=>JSON.parse(line)as Wire);
 return {service,registry,clients,tokens,cancelled,validated,root,project,post,excessiveReferenceBody,action,ready,send,task,taskOrigin,prepare,wire,
   finish:(process=0,turn=1)=>writeFile(join(root,'finish-'+process+'-'+turn),'complete',{flag:'wx'}),
   releasePreflight:(process=0)=>writeFile(join(root,'finish-'+process+'-preflight'),'release',{flag:'wx'}),control,generic};
}

test('actual image HTTP Send reaches only its owned initial native turn; repair carries text and no image bytes',async t=>{
 const f=await fixture(t,{modalities:()=>['text','image']});await f.ready();const references=[referenceInput()];
 const input={requestId:randomUUID(),connectionId:f.service.state().snapshot!.connectionId,action:'turn-start',threadId:THREAD,text:'Use this visual reference',references,allowWorkspaceWrites:true,allowAssets:true};
 const result=await f.post(input);assert.equal(result.data.record.state,'acknowledged');assert.deepEqual(result.data.record.references,referenceImageMetadata(references));
 const initial=(await f.wire()).find(row=>row.method==='turn/start')!;
 assert.deepEqual(initial.params!.input,[{type:'text',text:input.text,text_elements:[]},{type:'image',url:references[0]!.dataUrl}]);
 assert.ok(!JSON.stringify(result.data.state).includes('data:image/'));assert.equal((await f.post(input)).data.replayed,true);
 const journal=new DatabaseSync(sqliteTransportPath(join(f.root,'journal','codex-actions.sqlite')),{readOnly:true});
 try{const rows=journal.prepare('SELECT payload FROM actions').all()as {payload:string}[];assert.ok(rows.length);assert.ok(rows.every(row=>!row.payload.includes('data:image/')));}
 finally{journal.close();}
 const origin=f.taskOrigin(),report=packet();f.prepare(origin,report);await f.finish();await f.service.playtestTasks!.terminal(origin,report);
 await until(async()=>(await f.wire()).filter(row=>row.method==='turn/start').length===2);
 const repair=(await f.wire()).filter(row=>row.method==='turn/start')[1]!.params!.input as {type:string}[];
 assert.equal(repair.length,1);assert.equal(repair[0]!.type,'text');
 const changed={...input,references:[referenceInput(undefined,'other.png')]};assert.equal((await f.post(changed)).status,409);
});
test('fresh task rotation rechecks image capability on the actual new native client',async t=>{
 const f=await fixture(t,{modalities:index=>index===0?['text','image']:['text']});await f.ready();await f.send();await f.finish();await until(()=>f.clients[0]!.snapshot().thread!.turnStatus==='completed');
 const result=await f.action('turn-start',{threadId:THREAD,text:'Reference follow-up',references:[referenceInput()],allowWorkspaceWrites:true,allowAssets:true});
 assert.equal(result.data.record.state,'rejected');assert.equal(result.data.record.errorCode,'IMAGE_UNSUPPORTED');
 assert.equal(f.clients.length,2);assert.equal((await f.wire()).filter(row=>row.method==='turn/start').length,1);
});
test('held managed image preflight uses the original immutable PNG after caller mutation',async t=>{
 const f=await fixture(t,{mode:'hold-preflight'});await f.ready();const reference=referenceInput(),original=reference.dataUrl;
 const input={requestId:randomUUID(),connectionId:f.service.state().snapshot!.connectionId,action:'turn-start',threadId:THREAD,text:'Original image',references:[reference],allowWorkspaceWrites:true,allowAssets:true};
 const pending=f.service.action(input);await until(async()=>(await f.wire()).filter(row=>row.method==='mcpServerStatus/list').length===2);
 reference.dataUrl='file:///not-authorized.png';input.references.push(referenceInput(undefined,'new.png'));await f.releasePreflight();
 assert.equal((await pending).record.state,'acknowledged');
 const sent=(await f.wire()).find(row=>row.method==='turn/start')!.params!.input as {type:string;url?:string}[];
 assert.equal(sent.length,2);assert.equal(sent[1]!.url,original);
});
test('explicit exact task Stop during image preflight suppresses native image dispatch',async t=>{
 const f=await fixture(t,{mode:'hold-preflight'});await f.ready();const pending=f.action('turn-start',{threadId:THREAD,text:'Stop image task',references:[referenceInput()],allowWorkspaceWrites:true,allowAssets:true});
 await until(async()=>(await f.wire()).filter(row=>row.method==='mcpServerStatus/list').length===2);
 assert.equal((await f.action('task-stop',{threadId:THREAD,taskId:f.task().taskId})).data.record.state,'acknowledged');await pending;
 assert.equal((await f.wire()).filter(row=>row.method==='turn/start').length,0);assert.equal(f.task().state,'cancelled');
});
test('reference route denies agents, foreign origins, wrong envelopes and oversized bodies before native work',async t=>{
 const f=await fixture(t);await f.ready();const input={requestId:randomUUID(),connectionId:f.service.state().snapshot!.connectionId,action:'turn-start',threadId:THREAD,text:'Human image',references:[referenceInput()]};
 const before=(await f.wire()).length,records=f.service.state().actions.length;
 assert.equal((await f.post(input,f.generic)).status,403);assert.equal((await f.post(input,f.control,'http://foreign.invalid')).status,403);
 assert.equal((await f.post(input,f.control,undefined,'/v1/codex/action')).status,400);
 assert.equal((await f.post({...input,action:'connect'})).status,400);
 assert.deepEqual(await f.excessiveReferenceBody(),{status:413,error:'BODY_LIMIT'});
 assert.equal((await f.post({...input,references:[{name:'reference.png',path:'private.png'}]})).status,400);
 assert.equal(f.service.state().actions.length,records);assert.equal((await f.wire()).length,before);
});

test('actual human Send retains one private same-thread repair and one reverify after native terminal plus source check',async t=>{
 const f=await fixture(t);await f.ready();assert.equal((await f.send()).data.record.state,'acknowledged');
 const origin=f.taskOrigin(),report=packet();assert.ok(origin);assert.throws(()=>f.service.playtestTasks!.assert(structuredClone(origin)),/Foreign/);
 let releaseHeld!:()=>void;const held=new Promise<void>(resolve=>{releaseHeld=resolve;}).then(()=>{f.service.playtestTasks!.assert(origin);f.prepare(origin,packet());});void held.catch(()=>{});
 f.prepare(origin,report);await f.service.playtestTasks!.terminal(origin,report);await delay(20);
 assert.equal(f.clients.length,1);assert.equal((await f.wire()).filter(row=>row.method==='turn/start').length,1);assert.deepEqual(f.validated,[]);
 await f.finish();await until(()=>f.task().round===1&&f.clients[0]!.snapshot().operations.filter(op=>op.method==='turn/start'&&op.state==='acknowledged').length===2);assert.deepEqual(f.validated,[report.jobId]);
 const turns=(await f.wire()).filter(row=>row.method==='turn/start');assert.equal(turns.length,2);assert.equal(turns[0]!.process,turns[1]!.process);
 for(const turn of turns){assert.equal(turn.params.threadId,THREAD);assert.equal(turn.params.model,'fixture');assert.equal(turn.params.effort,'low');assert.equal(turn.params.approvalPolicy,'on-request');
   assert.deepEqual(turn.params.sandboxPolicy,{type:'workspaceWrite',writableRoots:[await realpath(f.project)],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true});
   for(const key of ['initiatedBy','continuation','taskId','allowAssets','allowWorkspaceWrites'])assert.equal(turn.params[key],undefined);}
 const second=packet(randomUUID(),'passed'),repairOrigin=f.taskOrigin();assert.notEqual(repairOrigin,origin);assert.throws(()=>f.prepare(origin,packet()),/admission/);
 releaseHeld();await assert.rejects(held,/admission/);
 f.prepare(repairOrigin,second);await f.service.playtestTasks!.terminal(repairOrigin,second);assert.equal(f.task().state,'awaiting_verification');
 await f.finish(0,2);await until(()=>f.task().state==='verified');await f.service.playtestTasks!.terminal(origin,report);
 assert.equal((await f.wire()).filter(row=>row.method==='turn/start').length,2);assert.equal(f.clients.length,1);assert.throws(()=>f.prepare(origin,packet()),/unavailable/);
});

test('navigation preserves the original task client and repair cannot borrow a newly connected conversation',async t=>{
 const f=await fixture(t);await f.ready();await f.send();const original=f.clients[0]!,binding=f.taskOrigin(),report=packet();f.prepare(binding,report);
 await f.finish();await until(()=>original.snapshot().thread!.turnStatus==='completed');
 assert.equal((await f.action('disconnect',{preserveAssetWork:true})).data.record.state,'acknowledged');assert.equal(original.snapshot().connected,true);assert.equal(f.service.state().snapshot,null);
 await f.ready();const current=f.service.state().snapshot!.connectionId;assert.notEqual(current,original.snapshot().connectionId);
 await f.service.playtestTasks!.terminal(binding,report);await until(async()=> (await f.wire()).filter(row=>row.method==='turn/start').length===2);
 const turns=(await f.wire()).filter(row=>row.method==='turn/start');assert.deepEqual(turns.map(row=>row.process),[0,0]);assert.equal(f.service.state().snapshot!.connectionId,current);
 assert.equal(f.clients[1]!.snapshot().thread!.turnStatus,'idle');assert.deepEqual(f.cancelled,[]);
});

test('human follow-up cancels original exact job and rotates its MCP credential before same-thread dispatch',async t=>{
 const f=await fixture(t);await f.ready();await f.send();const origin=f.taskOrigin(),report=packet();f.prepare(origin,report);await f.finish();await until(()=>f.clients[0]!.snapshot().thread!.turnStatus==='completed');
 const old=f.service.state().snapshot!.connectionId,input={requestId:randomUUID(),connectionId:old,action:'turn-start',threadId:THREAD,text:'Human follow-up supersedes old task',allowWorkspaceWrites:true,allowAssets:true};
 const sent=await f.post(input);assert.equal(sent.data.record.state,'acknowledged');assert.equal(sent.data.record.connectionId,old);assert.equal(sent.data.record.nextConnectionId,f.service.state().snapshot!.connectionId);
 assert.notEqual(sent.data.record.nextConnectionId,old);assert.equal(f.clients.length,2);assert.notEqual(f.tokens[0],f.tokens[1]);
 assert.deepEqual(f.cancelled.map(value=>value.jobId),[report.jobId]);assert.equal(f.cancelled[0]!.origin,origin);assert.equal(f.clients[0]!.snapshot().connected,false);
 assert.throws(()=>f.service.playtestTasks!.assert(origin),/unavailable/);await f.service.playtestTasks!.terminal(origin,report);await delay(20);
 assert.deepEqual((await f.wire()).filter(row=>row.method==='turn/start').map(row=>row.process),[0,1]);
 assert.equal((await f.post(input)).data.replayed,true);assert.equal(f.clients.length,2);assert.equal((await f.wire()).filter(row=>row.method==='turn/start').length,2);
});

for(const actionName of ['task-stop','revoke-writes','revoke-assets','disconnect'])test('explicit '+actionName+' fences and cancels only the original prepared task job',async t=>{
 const f=await fixture(t);await f.ready();await f.send();const origin=f.taskOrigin(),report=packet();f.prepare(origin,report);
 const fields=actionName==='disconnect'?{}:actionName==='task-stop'?{threadId:THREAD,taskId:origin.taskId}:{threadId:THREAD};
 assert.equal((await f.action(actionName,fields)).data.record.state,'acknowledged');assert.equal(f.cancelled.length,1);assert.equal(f.cancelled[0]!.origin,origin);
 assert.equal(f.cancelled[0]!.jobId,report.jobId);assert.equal(f.clients[0]!.snapshot().connected,false);assert.equal(f.task().state,'cancelled');
 await f.service.playtestTasks!.terminal(origin,report);await delay(20);assert.equal((await f.wire()).filter(row=>row.method==='turn/start').length,1);
});

test('revocation while actual managed preflight awaits suppresses native turn dispatch',async t=>{
 const f=await fixture(t,{mode:'hold-preflight'});await f.ready();const pending=f.send();await until(async()=> (await f.wire()).filter(row=>row.method==='mcpServerStatus/list').length===2);
 assert.equal((await f.action('task-stop',{threadId:THREAD,taskId:f.task().taskId})).data.record.state,'acknowledged');await pending;
 assert.equal((await f.wire()).filter(row=>row.method==='turn/start').length,0);assert.equal(f.task().state,'cancelled');
});

test('unknown repair acknowledgement is durably retained and never replays after daemon restart',async t=>{
 const f=await fixture(t,{mode:'unknown-repair'});await f.ready();await f.send();const binding=f.taskOrigin(),report=packet();f.prepare(binding,report);await f.finish();await f.service.playtestTasks!.terminal(binding,report);
 await until(()=>f.task().state==='unknown');await until(()=>!f.clients[0]!.snapshot().connected);assert.equal((await f.wire()).filter(row=>row.method==='turn/start').length,2);
 await f.service.close();const recovered=new ChatTaskStore({directory:join(f.root,'journal','chat-tasks'),projectPath:f.project});
 try{assert.equal(recovered.list()[0]!.state,'unknown');assert.equal(recovered.list()[0]!.repairDispatch,'unknown');assert.equal(recovered.list()[0]!.evidence.length,1);}finally{recovered.close();}
});

for(const missing of ['capture','source','cleanup'])test('uncertain '+missing+' evidence cannot authorize repair or verified completion',async t=>{
 const f=await fixture(t);await f.ready();await f.send();const binding=f.taskOrigin();let report=packet(randomUUID(),'passed');
 if(missing==='capture')report={...report,scenario:{...report.scenario!,requiredEvidence:'missing'}};
 if(missing==='source')report={...report,scenario:{...report.scenario!,subjects:'unobserved'}};
 if(missing==='cleanup')report={...report,scenario:{...report.scenario!,restoration:'unknown'}};
 f.prepare(binding,report);await f.service.playtestTasks!.terminal(binding,report);await f.finish();await delay(30);
 assert.equal(f.task().state,'paused');assert.deepEqual(f.validated,[]);assert.equal((await f.wire()).filter(row=>row.method==='turn/start').length,1);
});

test('post-turn source change blocks even a fully settled failed scenario',async t=>{
 const f=await fixture(t,{revalidation:'changed'});await f.ready();await f.send();const binding=f.taskOrigin(),report=packet();f.prepare(binding,report);
 await f.service.playtestTasks!.terminal(binding,report);await f.finish();await until(()=>f.task().state==='paused');assert.equal(f.task().reason,'verification_sources_changed');
 assert.equal((await f.wire()).filter(row=>row.method==='turn/start').length,1);
});

test('fresh task account mismatch refuses dispatch and model or agent input cannot mint host continuation',async t=>{
 const f=await fixture(t,{email:index=>index?'different@example.invalid':'fixture@example.invalid'});await f.ready();await f.send();await f.finish();await until(()=>f.clients[0]!.snapshot().thread!.turnStatus==='completed');
 const input={requestId:randomUUID(),connectionId:f.service.state().snapshot!.connectionId,action:'turn-start',threadId:THREAD,text:'Follow-up',allowWorkspaceWrites:true,allowAssets:true};
 assert.ok([401,403].includes((await f.post(input,f.generic)).status));
 for(const injected of [{continuation:{kind:'native-task-continuation'}},{taskId:randomUUID()},{initiatedBy:'human'},{repair:true}])assert.equal((await f.post({...input,...injected})).status,400);
 const failed=await f.post(input);assert.equal(failed.data.record.state,'rejected');assert.equal(failed.data.record.errorCode,'ACCOUNT_IDENTITY');assert.equal(f.clients.length,2);
 assert.equal((await f.wire()).filter(row=>row.method==='turn/start').length,1);assert.equal(f.clients[1]!.snapshot().connected,false);
});

for(const failure of ['trigger','revision'])test('explicit Stop still closes the actual native peer and exact job when task journal '+failure+' rejects its update',async t=>{
 const f=await fixture(t);await f.ready();await f.send();const origin=f.taskOrigin(),report=packet();f.prepare(origin,report);
 const db=new DatabaseSync(sqliteTransportPath(join(f.root,'journal','chat-tasks','chat-tasks.sqlite')));
 try{if(failure==='trigger')db.exec("CREATE TRIGGER reject_update BEFORE UPDATE ON chat_tasks BEGIN SELECT RAISE(ABORT,'fixture task write refused'); END");
   else db.prepare("UPDATE chat_tasks SET payload=json_set(payload,'$.revision',65535) WHERE id=?").run(origin.taskId);
   const stopped=await f.action('task-stop',{threadId:THREAD,taskId:origin.taskId});assert.equal(stopped.data.record.state,'rejected');
   assert.equal(f.clients[0]!.snapshot().connected,false);assert.deepEqual(f.cancelled.map(value=>value.jobId),[report.jobId]);assert.equal(f.cancelled[0]!.origin,origin);
   assert.throws(()=>f.service.playtestTasks!.assert(origin),/unavailable/);
 }finally{if(failure==='trigger')db.exec('DROP TRIGGER reject_update');db.close();}
});

test('a rejected task ACK journal update closes the accepted writable native peer and exact job without replay',async t=>{
 const f=await fixture(t,{mode:'hold-ack'});await f.ready();
 const input={requestId:randomUUID(),connectionId:f.service.state().snapshot!.connectionId,action:'turn-start',threadId:THREAD,text:'Held accepted turn',allowWorkspaceWrites:true,allowAssets:true};
 const pending=f.post(input);await until(async()=> (await f.wire()).some(row=>row.method==='turn/start'));
 const origin=f.taskOrigin(),report=packet();assert.ok(origin);f.prepare(origin,report);assert.equal(f.clients[0]!.snapshot().thread!.writeGranted,true);
 const db=new DatabaseSync(sqliteTransportPath(join(f.root,'journal','chat-tasks','chat-tasks.sqlite')));
 try{db.exec("CREATE TRIGGER reject_task_ack BEFORE UPDATE ON chat_tasks BEGIN SELECT RAISE(ABORT,'fixture task acknowledgement refused'); END");
   await writeFile(join(f.root,'finish-0-ack'),'release',{flag:'wx'});
   assert.equal((await pending).status,500);assert.equal(f.clients[0]!.snapshot().connected,false);
   assert.deepEqual(f.cancelled.map(value=>value.jobId),[report.jobId]);assert.equal(f.cancelled[0]!.origin,origin);
   assert.throws(()=>f.service.playtestTasks!.assert(origin),/unavailable/);
   const recorded=f.service.state().actions.find(value=>value.requestId===input.requestId);assert.equal(recorded?.state,'acknowledged','The actual native ACK receipt remains recorded.');
   const replayed=await f.post(input);assert.equal(replayed.status,200);assert.equal(replayed.data.replayed,true);assert.equal(replayed.data.record.state,'acknowledged');
   assert.equal((await f.wire()).filter(row=>row.method==='turn/start').length,1);
 }finally{db.exec('DROP TRIGGER reject_task_ack');db.close();}
});

test('shutdown fences and closes every navigation-retained native owner despite failing task journal writes',async t=>{
 const f=await fixture(t,{newThread:index=>index?THREAD+'.other':THREAD});await f.ready();await f.send();const first=f.taskOrigin(),firstReport=packet();f.prepare(first,firstReport);
 await f.finish();await until(()=>f.clients[0]!.snapshot().thread!.turnStatus==='completed');await f.action('disconnect',{preserveAssetWork:true});
 await f.ready();await f.send();const second=f.taskOrigin(1),secondReport=packet();f.prepare(second,secondReport);
 const db=new DatabaseSync(sqliteTransportPath(join(f.root,'journal','chat-tasks','chat-tasks.sqlite')));
 try{db.exec("CREATE TRIGGER reject_updates BEFORE UPDATE ON chat_tasks BEGIN SELECT RAISE(ABORT,'fixture all task writes refused'); END");
   f.service.fenceTaskAdmission();assert.throws(()=>f.service.playtestTasks!.assert(first),/unavailable/);assert.throws(()=>f.service.playtestTasks!.assert(second),/unavailable/);
   assert.throws(()=>f.service.playtestTasks!.terminal(first,firstReport),/fixture all task writes refused/);
 }
 finally{await f.service.close();assert.deepEqual(f.clients.map(client=>client.snapshot().connected),[false,false]);
   assert.deepEqual(new Set(f.cancelled.map(value=>value.jobId)),new Set([firstReport.jobId,secondReport.jobId]));db.exec('DROP TRIGGER reject_updates');db.close();}
 assert.equal((await f.wire()).filter(row=>row.method==='turn/start').length,2);
});

test('registry retirement before daemon close cannot strand an owned native task process',async t=>{
 const f=await fixture(t);await f.ready();await f.send();const origin=f.taskOrigin(),report=packet();f.prepare(origin,report);
 f.registry.close();await f.service.close();assert.equal(f.clients[0]!.snapshot().connected,false);assert.deepEqual(f.cancelled.map(value=>value.jobId),[report.jobId]);
});

test('a broken action journal still fences and closes all retained owners when every task write fails',async t=>{
 const f=await fixture(t,{newThread:index=>index?THREAD+'.other':THREAD});await f.ready();await f.send();const first=f.taskOrigin(),a=packet();f.prepare(first,a);
 await f.finish();await until(()=>f.clients[0]!.snapshot().thread!.turnStatus==='completed');await f.action('disconnect',{preserveAssetWork:true});await f.ready();await f.send();const second=f.taskOrigin(1),b=packet();f.prepare(second,b);
 const connectionId=f.service.state().snapshot!.connectionId,taskDb=new DatabaseSync(sqliteTransportPath(join(f.root,'journal','chat-tasks','chat-tasks.sqlite'))),actionDb=new DatabaseSync(sqliteTransportPath(join(f.root,'journal','codex-actions.sqlite')));
 try{taskDb.exec("CREATE TRIGGER reject_updates BEFORE UPDATE ON chat_tasks BEGIN SELECT RAISE(ABORT,'fixture all task writes refused'); END");actionDb.exec('DROP TABLE actions');
   assert.equal((await f.post({requestId:randomUUID(),connectionId,action:'history-load',threadId:THREAD+'.other'})).status,400);
   assert.deepEqual(f.clients.map(client=>client.snapshot().connected),[false,false]);assert.deepEqual(new Set(f.cancelled.map(value=>value.jobId)),new Set([a.jobId,b.jobId]));
 }finally{taskDb.exec('DROP TRIGGER reject_updates');taskDb.close();actionDb.close();}
});

test('actual client continuation rejects copied tokens and human selfclaims, then reserves exactly one private dispatch',async t=>{
 const f=await fixture(t,{mode:'complete'});await f.ready();const client=f.clients[0]!,started=await client.startManagedTask({initiatedBy:'human',threadId:THREAD,text:'Original actual human task'});
 await assert.rejects(client.continueTask({continuation:structuredClone(started.continuation),text:'Forged copy'}),{code:'TASK_SCOPE'});
 await assert.rejects(client.startTurn({initiatedBy:'human',threadId:'foreign.thread',text:'Wrong scope must not revoke original continuation'}),{code:'THREAD'});
 await assert.rejects(client.continueTask({continuation:started.continuation,text:'Human selfclaim',initiatedBy:'human'}as never),{code:'ARGUMENTS'});
 await client.continueTask({continuation:started.continuation,text:'Private host continuation'});await assert.rejects(client.continueTask({continuation:started.continuation,text:'Replay'}),{code:'TASK_SCOPE'});
 assert.equal((await f.wire()).filter(row=>row.method==='turn/start').length,2);assert.equal(client.snapshot().thread!.writeGranted,false);
});

test('revocation during private continuation preflight suppresses the second native turn',async t=>{
 const f=await fixture(t,{mode:'hold-repair'});await f.ready();const client=f.clients[0]!,started=await client.startManagedTask({initiatedBy:'human',threadId:THREAD,text:'Original human task',allowWorkspaceWrites:true});
 const pending=client.continueTask({continuation:started.continuation,text:'Private host continuation'});void pending.catch(()=>{});
 await until(async()=> (await f.wire()).filter(row=>row.method==='mcpServerStatus/list').length===3);client.revokeTaskContinuation();await f.releasePreflight();
 await assert.rejects(pending,{code:'GRANT_REVOKED',dispatched:false});assert.equal((await f.wire()).filter(row=>row.method==='turn/start').length,1);
});

test('a rejected duplicate managed start cannot clear the original pending cancellation gate',async t=>{
 const f=await fixture(t,{mode:'hold-preflight'});await f.ready();const client=f.clients[0]!,pending=client.startManagedTask({initiatedBy:'human',threadId:THREAD,text:'Held initial task',allowWorkspaceWrites:true});void pending.catch(()=>{});
 await until(async()=> (await f.wire()).filter(row=>row.method==='mcpServerStatus/list').length===2);
 await assert.rejects(client.startManagedTask({initiatedBy:'human',threadId:THREAD,text:'Duplicate managed start'}),{code:'BUSY'});
 await assert.rejects(client.startTurn({initiatedBy:'human',threadId:THREAD,text:'Duplicate public start'}),{code:'BUSY',dispatched:false});
 client.revokeTaskContinuation();await f.releasePreflight();await assert.rejects(pending,{code:'GRANT_REVOKED',dispatched:false});assert.equal((await f.wire()).filter(row=>row.method==='turn/start').length,0);
});

test('unreported native account identity cannot mint an automatic repair capability',async t=>{
 const f=await fixture(t,{email:()=>null});await f.ready();const sent=await f.send();assert.equal(sent.data.record.state,'rejected');assert.equal(sent.data.record.errorCode,'ACCOUNT_IDENTITY');
 await assert.rejects(f.clients[0]!.startManagedTask({initiatedBy:'human',threadId:THREAD,text:'No private identity'}),{code:'ACCOUNT_IDENTITY'});
 assert.equal((await f.wire()).filter(row=>row.method==='turn/start').length,0);assert.equal(f.clients[0]!.snapshot().connected,true);assert.deepEqual(f.service.state().chatTasks,[]);
});

test('explicitly injected legacy host client retains its labelled lane without task origin or automatic repair',async t=>{
 const f=await fixture(t,{legacy:true});await f.ready();assert.equal((await f.send()).data.record.state,'acknowledged');assert.deepEqual(f.service.state().chatTasks,[]);
 assert.equal(f.service.playtestTasks!.capture('agent-'+createHash('sha256').update(f.tokens[0]!).digest('hex')),null);assert.equal((await f.wire()).filter(row=>row.method==='turn/start').length,1);
});

test('a later omitted Send never inherits the original automatic workspace or asset permission',async t=>{
 const f=await fixture(t);await f.ready();await f.send();const previous=f.taskOrigin();
 const sent=await f.action('turn-start',{threadId:THREAD,text:'Read-only follow-up'});assert.equal(sent.data.record.state,'acknowledged');assert.equal(f.clients.length,2);
 assert.throws(()=>f.service.playtestTasks!.assert(previous),/unavailable/);const turns=(await f.wire()).filter(row=>row.method==='turn/start');assert.deepEqual(turns[1]!.params.sandboxPolicy,{type:'readOnly',networkAccess:false});
 assert.equal(f.service.state().nativeAssets!.granted,false);assert.equal(f.service.state().snapshot!.thread!.writeGranted,false);
});

test('existing explicit persistent grants survive exact human-task rotation without becoming automatic grants',async t=>{
 const f=await fixture(t);await f.ready();await f.action('grant-writes',{threadId:THREAD});await f.action('grant-assets',{threadId:THREAD});await f.send();await f.finish();await until(()=>f.clients[0]!.snapshot().thread!.turnStatus==='completed');
 const sent=await f.action('turn-start',{threadId:THREAD,text:'Follow up within existing manual grants',allowWorkspaceWrites:false,allowAssets:false});assert.equal(sent.data.record.state,'acknowledged');assert.equal(f.clients.length,2);
 await f.finish(1);await until(()=>f.clients[1]!.snapshot().thread!.turnStatus==='completed');assert.equal(f.service.state().snapshot!.thread!.writeGranted,true);assert.equal(f.service.state().nativeAssets!.granted,true);assert.equal(f.service.state().nativeAssets!.admissionOpen,false);
});

for(const code of ['TIMEOUT','BINDING_CHANGED','RUNTIME_ERROR'])test(code+' cannot be interpreted as an automatic gameplay repair assertion',async t=>{
 const f=await fixture(t);await f.ready();await f.send();const origin=f.taskOrigin(),base=packet(),report={...base,review:{...base.review,code:code as StudioTestTaskSettled['review']['code']}};f.prepare(origin,report);
 await f.service.playtestTasks!.terminal(origin,report);await f.finish();await until(()=>f.task().state==='paused');assert.equal((await f.wire()).filter(row=>row.method==='turn/start').length,1);assert.equal(f.task().round,0);
});

for(const actionName of ['revoke-writes','revoke-assets','disconnect','select'])test('reopening the same conversation keeps explicit '+actionName+' bound to its retained original task',async t=>{
 const f=await fixture(t);await f.ready();await f.send();const origin=f.taskOrigin(),report=packet();f.prepare(origin,report);await f.finish();await until(()=>f.clients[0]!.snapshot().thread!.turnStatus==='completed');
 await f.action('disconnect',{preserveAssetWork:true});await f.ready();assert.equal(f.clients[0]!.snapshot().connected,true);
 const fields=actionName==='disconnect'?{}:actionName==='select'?{model:'fixture',effort:'low'}:{threadId:THREAD};
 assert.equal((await f.action(actionName,fields)).data.record.state,'acknowledged');assert.equal(f.clients[0]!.snapshot().connected,false);assert.deepEqual(f.cancelled.map(value=>value.jobId),[report.jobId]);assert.equal(f.cancelled[0]!.origin,origin);
});

test('revoking another conversation cannot cancel the navigation-retained task',async t=>{
 const f=await fixture(t,{newThread:index=>index?THREAD+'.other':THREAD});await f.ready();await f.send();const origin=f.taskOrigin(),report=packet();f.prepare(origin,report);await f.finish();await until(()=>f.clients[0]!.snapshot().thread!.turnStatus==='completed');
 await f.action('disconnect',{preserveAssetWork:true});await f.ready();await f.action('revoke-assets',{threadId:THREAD+'.other'});assert.deepEqual(f.cancelled,[]);assert.equal(f.clients[0]!.snapshot().connected,true);f.service.playtestTasks!.assert(origin);
});

test('configured task admission fence rejects a later human Send without legacy dispatch fallback',async t=>{
 const f=await fixture(t);await f.ready();f.service.fenceTaskAdmission();const sent=await f.send();assert.equal(sent.data.record.state,'rejected');assert.equal(sent.data.record.errorCode,'CLOSED');
 assert.equal((await f.wire()).filter(row=>row.method==='turn/start').length,0);assert.equal(f.clients.length,1);
});

test('navigation repair approval focuses the original owned native client without launch/resume/dispatch and uses its exact existing approval response',async t=>{
 const f=await fixture(t,{mode:'repair-approval'});await f.ready();await f.send();const origin=f.taskOrigin(),report=packet(),original=f.clients[0]!;f.prepare(origin,report);
 await f.finish();await until(()=>original.snapshot().thread!.turnStatus==='completed');await f.action('disconnect',{preserveAssetWork:true});await f.ready();
 await f.service.playtestTasks!.terminal(origin,report);await until(()=>original.snapshot().approvals.length===1);
 const before=(await f.wire()).filter(row=>['thread/start','thread/resume','turn/start'].includes(row.method)).length,current=f.service.state().snapshot!.connectionId;
 const input={requestId:randomUUID(),connectionId:current,action:'task-focus',taskId:origin.taskId,threadId:THREAD};
 assert.ok([401,403].includes((await f.post(input,f.generic)).status));assert.equal((await f.post({...input,sessionId:SESSION})).status,400);
 assert.equal((await f.post({...input,requestId:randomUUID(),taskId:randomUUID()})).data.record.state,'rejected');
 const focused=await f.post(input);assert.equal(focused.data.record.state,'acknowledged');assert.equal(focused.data.record.connectionId,current);assert.equal(focused.data.record.nextConnectionId,original.snapshot().connectionId);
 assert.equal(f.service.state().snapshot!.connectionId,original.snapshot().connectionId);assert.equal(f.clients.length,2);assert.equal(f.clients[1]!.snapshot().connected,false);
 assert.equal((await f.wire()).filter(row=>['thread/start','thread/resume','turn/start'].includes(row.method)).length,before);
 const approval=f.service.state().snapshot!.approvals[0]!;assert.equal(approval.connectionId,original.snapshot().connectionId);assert.equal(approval.turnId,original.snapshot().thread!.turnId);
 assert.equal((await f.action('approval',{threadId:THREAD,turnId:approval.turnId,handle:approval.handle,decision:'accept'})).data.record.state,'acknowledged');
 await until(async()=> (await f.wire()).some(row=>row.id==='managed.approval:0:2'&&JSON.stringify(row.result)==='{"decision":"accept"}'));
 assert.equal((await f.wire()).filter(row=>row.method==='turn/start').length,2);
});

test('focus across different conversations restores exact saved history without dispatching a new task',async t=>{
 const f=await fixture(t,{newThread:index=>index?THREAD+'.other':THREAD});await f.ready();await f.send();const origin=f.taskOrigin();await f.finish();await until(()=>f.clients[0]!.snapshot().thread!.turnStatus==='completed');
 await f.action('disconnect',{preserveAssetWork:true});await f.ready();assert.equal(f.service.state().nativeHistory!.threadId,THREAD+'.other');
 assert.equal((await f.action('task-focus',{taskId:origin.taskId,threadId:THREAD})).data.record.state,'acknowledged');assert.equal(f.service.state().nativeHistory!.threadId,THREAD);
 assert.equal((await f.action('history-load',{threadId:THREAD})).data.record.state,'acknowledged');assert.equal(f.service.state().nativeHistory!.recorded!.result.completeness,'complete');
 assert.equal((await f.wire()).filter(row=>row.method==='turn/start').length,1);
});

test('Disconnect during actual held native close cannot rebind a stale focused task',async t=>{
 const f=await fixture(t,{mode:'hold-close-current',newThread:index=>index?THREAD+'.other':THREAD});await f.ready();await f.send();const origin=f.taskOrigin();await f.finish();await until(()=>f.clients[0]!.snapshot().thread!.turnStatus==='completed');await f.action('disconnect',{preserveAssetWork:true});await f.ready();
 const current=f.service.state().snapshot!.connectionId,pending=f.action('task-focus',{taskId:origin.taskId,threadId:THREAD});await until(()=>!f.clients[1]!.snapshot().connected);
 const stopped=f.post({requestId:randomUUID(),connectionId:current,action:'disconnect'});await writeFile(join(f.root,'finish-1-close'),'release',{flag:'wx'});
 assert.equal((await stopped).data.record.state,'acknowledged');const focused=await pending;assert.equal(focused.data.record.state,'rejected');assert.equal(focused.data.record.errorCode,'STALE_CONNECTION');assert.equal(f.service.state().snapshot,null);
 assert.equal(f.clients[0]!.snapshot().connected,true);assert.equal((await f.wire()).filter(row=>row.method==='turn/start').length,1);
});

test('conversation revocation and concurrent Connect during held exact resume cannot seal or dispatch a replacement task',async t=>{
 const f=await fixture(t,{mode:'hold-resume'});await f.ready();await f.send();const origin=f.taskOrigin();await f.finish();await until(()=>f.clients[0]!.snapshot().thread!.turnStatus==='completed');
 const old=f.service.state().snapshot!.connectionId,pending=f.send('Rotating follow-up');await until(async()=> (await f.wire()).some(row=>row.process===1&&row.method==='thread/resume'));
 const competing=await f.post({requestId:randomUUID(),connectionId:null,action:'connect'});assert.equal(competing.data.record.state,'rejected');assert.equal(competing.data.record.errorCode,'BUSY');assert.equal(f.clients.length,2);
 assert.equal((await f.post({requestId:randomUUID(),connectionId:old,action:'revoke-writes',threadId:THREAD})).data.record.state,'acknowledged');
 await writeFile(join(f.root,'finish-1-resume'),'release',{flag:'wx'});const sent=await pending;assert.equal(sent.data.record.state,'rejected');assert.equal(sent.data.record.errorCode,'STALE_CONNECTION');
 assert.equal(f.clients[1]!.snapshot().connected,false);assert.equal((await f.wire()).filter(row=>row.method==='turn/start').length,1);
});

for(const mode of ['hold-preflight','hold-resume'])test('wrong-scope Stop/revoke cannot invalidate a legitimate managed Send during '+mode,async t=>{
 const f=await fixture(t,{mode});await f.ready();
 if(mode==='hold-resume'){await f.send();await f.finish();await until(()=>f.clients[0]!.snapshot().thread!.turnStatus==='completed');}
 const connectionId=f.service.state().snapshot!.connectionId,pending=f.send();
 await until(async()=>{const rows=await f.wire();return mode==='hold-resume'?rows.some(row=>row.process===1&&row.method==='thread/resume'):rows.filter(row=>row.method==='mcpServerStatus/list').length===2;});
 for(const fields of [{action:'revoke-assets',threadId:'foreign.thread'},{action:'revoke-writes',threadId:'foreign.thread'},{action:'task-stop',threadId:THREAD,taskId:randomUUID()},{action:'turn-interrupt',threadId:THREAD,turnId:'foreign.turn'}]){
   const denied=await f.post({requestId:randomUUID(),connectionId,...fields});assert.equal(denied.data.record.state,'rejected');}
 if(mode==='hold-resume'){const stale=f.task().taskId;assert.equal((await f.post({requestId:randomUUID(),connectionId,action:'task-stop',threadId:THREAD,taskId:stale})).data.record.state,'acknowledged');}
 if(mode==='hold-resume')await writeFile(join(f.root,'finish-1-resume'),'release',{flag:'wx'});else await f.releasePreflight();
 assert.equal((await pending).data.record.state,'acknowledged');assert.equal((await f.wire()).filter(row=>row.method==='turn/start').length,mode==='hold-resume'?2:1);
});

test('actual oversized history rejection preserves the original task owner across navigation and cannot lend its repair to a new chat',async t=>{
  const f=await fixture(t,{mode:'history-frame-limit',newThread:index=>index===0?THREAD:'history-target.thread'});
  await f.ready();await f.send();const original=f.clients[0]!,origin=f.taskOrigin(),report=packet();f.prepare(origin,report);
  await f.finish();await until(()=>original.snapshot().thread!.turnStatus==='completed');
  const rejected=await f.action('history-load',{threadId:THREAD});assert.equal(rejected.data.record.state,'rejected');assert.equal(rejected.data.record.errorCode,'FRAME_LIMIT');assert.ok(rejected.data.record.finishedAt);
  assert.equal(original.snapshot().connected,true);assert.equal(original.snapshot().ready,true);assert.deepEqual(f.cancelled,[]);
  assert.equal((await f.action('disconnect',{preserveAssetWork:true})).data.record.state,'acknowledged');assert.equal(original.snapshot().connected,true);
  await f.ready();const current=f.service.state().snapshot!;assert.equal(current.thread!.threadId,'history-target.thread');assert.notEqual(current.connectionId,original.snapshot().connectionId);
  await f.service.playtestTasks!.terminal(origin,report);await until(async()=>(await f.wire()).filter(row=>row.method==='turn/start').length===2);
  assert.deepEqual((await f.wire()).filter(row=>row.method==='turn/start').map(row=>row.process),[0,0]);
  assert.equal(f.clients[1]!.snapshot().thread!.turnStatus,'idle');assert.deepEqual(f.cancelled,[]);
  const receipt=f.service.state().actions.find(row=>row.requestId===rejected.data.record.requestId)!;assert.equal(receipt.state,'rejected');assert.equal(receipt.errorCode,'FRAME_LIMIT');
});
