import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexSession } from '../../packages/codex-client/src/session.js';
import { nativeEnvironment } from '../../packages/codex-client/src/transport.js';
import { limits } from '../../packages/codex-client/src/validation.js';
import type { LimitOptions, NativeAssetHooks } from '../../packages/codex-client/src/types.js';
import { ARCANE_NATIVE_TOOL_NAMES } from '../../packages/protocol/src/arcane-tools.js';
import { createNativeAssetRegistry, assertNativeAssetActor, nativeAssetOperationSignal } from '../../apps/daemon/src/native-asset-authority.js';
import { createCodexService, codexActionInput } from '../../apps/daemon/src/codex-service.js';
import { SubmittedChatStore, type SubmittedChatMessage } from '../../packages/storage/src/submitted-chat-store.js';

const HUMAN={initiatedBy:'human'} as const,THREAD='steer.thread',SESSION='steer.session',TURN='steer.turn';
const PAIR={model:'steer-model',effort:'low'};
type Wire={method:string;params:Record<string,unknown>};
// A synthetic owned Node JSONL peer only. No native CLI, account/auth file,
// inference, Studio, shell command, provider endpoint or upload is accessed.
const PEER=String.raw`
const {createInterface}=require('node:readline'),{appendFileSync,existsSync,readFileSync}=require('node:fs');
const [scenario,audit,gate,encodedTools]=process.argv.slice(1),tools=JSON.parse(encodedTools);let active=false;
const send=value=>process.stdout.write(JSON.stringify(value)+'\n'),reply=(id,result)=>send({id,result});
const terminal=status=>{active=false;send({method:'turn/completed',params:{threadId:'steer.thread',turn:{id:'steer.turn',status}}});};
createInterface({input:process.stdin}).on('line',line=>{
 const {id,method,params={}}=JSON.parse(line);appendFileSync(audit,JSON.stringify({method,params})+'\n');
 if(!method||method==='initialized')return;
 if(method==='initialize')return reply(id,{});
 if(method==='account/read')return reply(id,{account:{type:'chatgpt',planType:'plus',email:'synthetic@example.test'},requiresOpenaiAuth:true});
 if(method==='model/list')return reply(id,{data:[{id:'steer-model',model:'steer-model',displayName:'Steering fixture',supportedReasoningEfforts:[{reasoningEffort:'low'}]}],nextCursor:null});
 if(method==='mcpServerStatus/list')return reply(id,{data:[{name:'arcane',runtimeStatus:'connected',toolsError:null,pluginId:null,tools:Object.fromEntries(tools.map(name=>[name,{}]))}],nextCursor:null});
 if(method==='thread/start')return reply(id,{thread:{id:'steer.thread',sessionId:'steer.session',turns:[],status:{type:'idle'}},model:params.model,modelProvider:'openai',cwd:process.cwd(),approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:{type:'readOnly',networkAccess:false}});
 if(method==='turn/start'){
  active=true;send({method:'turn/started',params:{threadId:'steer.thread',turn:{id:'steer.turn',status:'inProgress'}}});
  return reply(id,{turn:{id:'steer.turn',status:'inProgress'}});
 }
 if(method==='turn/steer'){
  if(!active||params.threadId!=='steer.thread'||params.expectedTurnId!=='steer.turn')return send({id,error:{code:-32602,message:'Synthetic active-turn rejection'}});
  if(scenario==='reject')return send({id,error:{code:-32602,message:'Synthetic steering rejection'}});
  if(scenario==='lost')return;
  if(scenario==='malformed')return reply(id,{});
  if(scenario==='wrong-id')return reply(id,{turnId:'other-turn'});
  const accept=()=>{send({method:'item/completed',params:{threadId:'steer.thread',turnId:'steer.turn',item:{type:'userMessage',id:params.clientUserMessageId,content:params.input}}});reply(id,{turnId:'steer.turn'});send({method:'item/agentMessage/delta',params:{threadId:'steer.thread',turnId:'steer.turn',itemId:'steer-answer',delta:'after-steer-ack'}});};
  if(scenario==='terminal-before-ack'){terminal('completed');return accept();}
  if(scenario==='held'){
   const timer=setInterval(()=>{if(!existsSync(gate))return;clearInterval(timer);const command=JSON.parse(readFileSync(gate,'utf8'));if(command.complete)terminal('completed');accept();},5);return;
  }
  return accept();
 }
 if(method==='turn/interrupt'){reply(id,{});terminal('interrupted');return;}
 throw Error('Unexpected synthetic request '+method);
});
`;
const errorCode=(code:string)=>(error:unknown)=>!!error&&typeof error==='object'&&'code' in error&&error.code===code;
async function until(check:()=>boolean|Promise<boolean>):Promise<void>{
 const deadline=Date.now()+5000;while(!await check()){if(Date.now()>deadline)assert.fail('Synthetic steering evidence did not arrive.');await delay(5);}
}
async function fixture(t:test.TestContext,scenario='normal',options:LimitOptions={},serviceMode=false){
 const boundary=await realpath(tmpdir()),root=await realpath(await mkdtemp(join(boundary,'arcane-steer-'))),project=join(root,'project');await mkdir(project);
 const registry=createNativeAssetRegistry({projectPath:await realpath(project)}),audit=join(root,'wire.jsonl'),gate=join(root,'release.json');
 const bounds=limits({requestTimeoutMs:5000,...options});let session!:CodexSession,service:ReturnType<typeof createCodexService>|null=null;
 const observed:{dispatches:string[];ends:string[];retirements:number}={dispatches:[],ends:[],retirements:0};
 t.after(async()=>{try{if(service)await service.close();else await session?.close();}finally{registry.close();const part=relative(boundary,root);assert.ok(part.startsWith('arcane-steer-')&&!part.includes(sep)&&!isAbsolute(part));assert.equal((await lstat(root)).isSymbolicLink(),false);await rm(root,{recursive:true,force:true});}});
 const connect=async(hooks?:NativeAssetHooks)=>{
  // Consume the same one-use launch credential boundary as the real factory;
  // this synthetic peer never receives or publishes the credential itself.
  hooks?.finalCredential();
  const wrapped=hooks&&Object.freeze({finalCredential:()=>hooks.finalCredential(),dispatched:(intent:Parameters<NativeAssetHooks['dispatched']>[0])=>{observed.dispatches.push(intent.operationId);hooks.dispatched(intent);},
   ended:(intent:Parameters<NativeAssetHooks['ended']>[0])=>{observed.ends.push(intent.operationId);hooks.ended(intent);},retired:()=>{observed.retirements++;hooks.retired();}});
  session=new CodexSession({command:process.execPath,args:['-e',PEER,scenario,audit,gate,JSON.stringify(ARCANE_NATIVE_TOOL_NAMES)],cwd:project,env:nativeEnvironment()},bounds,'spawned-node-fixture','arcane-only',wrapped);
  await session.initialize();return session;
 };
 service=serviceMode?createCodexService({directory:join(root,'journal'),projectPath:project,assetRegistry:registry,connect}):null;
 const handle=serviceMode?null:registry.issue();
 if(!serviceMode){await connect(Object.freeze({finalCredential:()=>handle!.credential(),dispatched:(value:Parameters<NativeAssetHooks['dispatched']>[0])=>handle!.dispatched(value),ended:(value:Parameters<NativeAssetHooks['ended']>[0])=>handle!.ended(value.operationId),retired:()=>handle!.retire()}));
  session.selectModel({...HUMAN,...PAIR});await session.startThread(HUMAN);
  handle!.seal({connectionId:session.snapshot().connectionId,provider:'codex',threadId:THREAD,sessionId:SESSION});handle!.grant({connectionId:session.snapshot().connectionId,threadId:THREAD});}
 const wire=async():Promise<Wire[]>=>{try{return (await readFile(audit,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line) as Wire);}catch{return [];}};
 const steer=(text='Adjust the existing build',clientUserMessageId=randomUUID())=>session.steerTurn({...HUMAN,threadId:THREAD,expectedTurnId:TURN,text,clientUserMessageId});
 return {root,project,registry,handle,observed,bounds,service,get session(){return session;},wire,steer,release:(complete=false)=>writeFile(gate,JSON.stringify({complete}))};
}
async function started(t:test.TestContext,scenario='normal',options:LimitOptions={}){
 const f=await fixture(t,scenario,options);await f.session.startTurn({...HUMAN,threadId:THREAD,text:'Original human task',allowWorkspaceWrites:true});return f;
}

test('pinned native steering protocol and documentation agree on expected turn, text input and ACK identity',async()=>{
 const params=await readFile('packages/codex-client/.protocol/v2/TurnSteerParams.ts','utf8'),response=await readFile('packages/codex-client/.protocol/v2/TurnSteerResponse.ts','utf8');
 assert.match(params,/expectedTurnId: string/);assert.match(params,/clientUserMessageId\?: string \| null/);assert.match(params,/input: Array<UserInput>/);
 assert.doesNotMatch(params,/sandboxPolicy|approvalsReviewer|cwd:|model:|outputSchema/);assert.match(response,/turnId: string/);
});
test('steering appends multiple request identities to one active turn without changing original grants, intent, approvals or task continuation',async t=>{
 const f=await fixture(t),managed=await f.session.startManagedTask({...HUMAN,threadId:THREAD,text:'Original task',allowWorkspaceWrites:true});
 const actor=f.registry.capture(f.handle!.credential(),'mutate'),signal=nativeAssetOperationSignal(actor),before=f.session.snapshot(),first=randomUUID(),second=randomUUID();
 assert.deepEqual(await f.steer('First amendment',first),{turnId:TURN});assert.deepEqual(await f.steer('Second amendment',second),{turnId:TURN});
 await assert.rejects(f.steer('First amendment',first),errorCode('STEER_REPLAY'));
 const after=f.session.snapshot(),wire=await f.wire(),calls=wire.filter(row=>row.method==='turn/steer');
 assert.equal(wire.filter(row=>row.method==='turn/start').length,1);assert.equal(wire.filter(row=>row.method==='thread/start').length,1);
 assert.deepEqual(calls.map(row=>row.params),[
  {threadId:THREAD,expectedTurnId:TURN,clientUserMessageId:first,input:[{type:'text',text:'First amendment',text_elements:[]}]},
  {threadId:THREAD,expectedTurnId:TURN,clientUserMessageId:second,input:[{type:'text',text:'Second amendment',text_elements:[]}]},
 ]);
 assert.deepEqual(after.thread,before.thread);assert.deepEqual(after.approvals,before.approvals);assert.deepEqual(after.selection,before.selection);
 assert.equal(after.events.filter(row=>row.type==='turn').length,before.events.filter(row=>row.type==='turn').length);
 assert.equal(after.operations.filter(row=>row.method==='turn/steer'&&row.state==='acknowledged').length,2);
 assertNativeAssetActor(actor,'mutate');assert.equal(signal.aborted,false);assert.equal(f.observed.dispatches.length,1);assert.equal(f.observed.ends.length,0);assert.equal(f.observed.retirements,0);
 assert.doesNotThrow(()=>f.session.openIncorporationChain({continuation:managed.continuation,maxSteps:1}));
});
test('steering refuses nonhuman input, expanded envelopes, getters, proxies, wrong thread/turn and UTF-8 excess before dispatch',async t=>{
 const f=await started(t),valid={...HUMAN,threadId:THREAD,expectedTurnId:TURN,text:'Update',clientUserMessageId:randomUUID()};let reads=0;
 const invalid=[{...valid,initiatedBy:'agent'},{...valid,model:'other'},{...valid,allowAssets:true},{...valid,cwd:'other'},
  {...valid,clientUserMessageId:'not-a-uuid'},{...valid,text:'\0'},{...valid,text:'🌲'.repeat(32769)},
  Object.defineProperty({...valid},'text',{enumerable:true,get(){reads++;return 'Do not evaluate';}}),new Proxy(valid,{get(){reads++;throw Error('Do not evaluate');}})];
 for(const value of invalid)await assert.rejects(f.session.steerTurn(value as never));
 await assert.rejects(f.session.steerTurn({...valid,threadId:'other'}),errorCode('THREAD'));
 await assert.rejects(f.session.steerTurn({...valid,expectedTurnId:'other'}),errorCode('STEER_SCOPE_CHANGED'));
 assert.equal(reads,0);assert.equal((await f.wire()).some(row=>row.method==='turn/steer'),false);
 assert.equal(f.session.snapshot().thread?.turnId,TURN);assert.equal(f.session.snapshot().thread?.writeGranted,true);
});
test('steering requires an active acknowledged turn, and full frame or operation history refuses without ending it',async t=>{
 const f=await fixture(t);await assert.rejects(f.steer(),errorCode('STEER_SCOPE_CHANGED'));
 await f.session.startTurn({...HUMAN,threadId:THREAD,text:'Original'});const actor=f.registry.capture(f.handle!.credential(),'mutate');
 Object.assign(f.bounds,{maxFrameBytes:100});await assert.rejects(f.steer(),errorCode('FRAME_LIMIT'));Object.assign(f.bounds,{maxFrameBytes:1048576,maxOperations:f.session.snapshot().operations.length});
 await assert.rejects(f.steer(),errorCode('OPERATION_LIMIT'));assertNativeAssetActor(actor,'mutate');
 assert.equal(f.observed.ends.length,0);assert.equal(f.observed.retirements,0);assert.equal((await f.wire()).some(row=>row.method==='turn/steer'),false);
});
for(const [scenario,expected]of [['reject','rejected'],['malformed','unknown'],['wrong-id','unknown']] as const)
 test('steering '+scenario+' retains '+expected+' outcome while original native and asynchronous asset work stay active',async t=>{
  const f=await started(t,scenario),actor=f.registry.capture(f.handle!.credential(),'mutate'),signal=nativeAssetOperationSignal(actor);
  await assert.rejects(f.steer());const state=f.session.snapshot(),operation=state.operations.at(-1)!;
  assert.equal(operation.method,'turn/steer');assert.equal(operation.state,expected);assert.equal(operation.turnId,TURN);
  assert.equal(state.connected,true);assert.equal(state.ready,true);assert.equal(state.thread?.turnStatus,'inProgress');assert.equal(state.thread?.writeGranted,true);
  assertNativeAssetActor(actor,'mutate');assert.equal(signal.aborted,false);assert.equal(f.observed.dispatches.length,1);assert.equal(f.observed.ends.length,0);assert.equal(f.observed.retirements,0);
  if(expected==='unknown')await assert.rejects(f.steer('Do not retry'),errorCode('BUSY'));
  assert.equal((await f.wire()).filter(row=>row.method==='turn/steer').length,1);
 });
test('lost steering ACK is request-local, never retries, and leaves the exact original turn and asset signal active',async t=>{
 const f=await started(t,'lost'),actor=f.registry.capture(f.handle!.credential(),'mutate'),signal=nativeAssetOperationSignal(actor);
 Object.assign(f.bounds,{requestTimeoutMs:100});await assert.rejects(f.steer(),errorCode('STEER_TIMEOUT'));
 const state=f.session.snapshot();assert.equal(state.operations.at(-1)?.state,'unknown');assert.equal(state.connected,true);assert.equal(state.thread?.turnId,TURN);assert.equal(state.thread?.turnStatus,'inProgress');
 assertNativeAssetActor(actor,'mutate');assert.equal(signal.aborted,false);assert.equal(f.observed.ends.length,0);await assert.rejects(f.steer(),errorCode('BUSY'));
 assert.equal((await f.wire()).filter(row=>row.method==='turn/steer').length,1);
});
test('terminal notification before a steering ACK remains terminal and preserves an unknown amendment without resurrecting assets',async t=>{
 const f=await started(t,'terminal-before-ack');await assert.rejects(f.steer(),errorCode('STEER_SCOPE_CHANGED'));
 assert.equal(f.session.snapshot().thread?.turnStatus,'completed');assert.equal(f.session.snapshot().thread?.writeGranted,false);
 assert.equal(f.session.snapshot().operations.at(-1)?.state,'unknown');assert.equal(f.observed.dispatches.length,1);assert.equal(f.observed.ends.length,1);
});
test('a late steering ACK cannot upgrade an unknown receipt while original streamed progress continues',async t=>{
 const f=await started(t,'held');Object.assign(f.bounds,{requestTimeoutMs:100});await assert.rejects(f.steer(),errorCode('STEER_TIMEOUT'));
 await f.release();await until(()=>f.session.snapshot().events.some(event=>event.type==='delta'&&event.text==='after-steer-ack'));
 assert.equal(f.session.snapshot().operations.at(-1)?.state,'unknown');assert.equal(f.session.snapshot().thread?.turnStatus,'inProgress');
 assert.equal(f.observed.retirements,0);assert.equal(f.observed.ends.length,0);assert.equal((await f.wire()).filter(row=>row.method==='turn/steer').length,1);
});
test('human interruption while steering awaits ACK fences it without a second turn or any implicit permission',async t=>{
 const f=await started(t,'held'),pending=f.steer();const outcome=assert.rejects(pending,errorCode('STEER_SCOPE_CHANGED'));
 await until(async()=>(await f.wire()).some(row=>row.method==='turn/steer'));
 await f.session.interruptTurn({...HUMAN,threadId:THREAD,turnId:TURN});await f.release();await outcome;
 assert.equal(f.session.snapshot().thread?.turnStatus,'interrupted');assert.equal(f.session.snapshot().thread?.writeGranted,false);
 assert.equal((await f.wire()).filter(row=>row.method==='turn/start').length,1);
});

async function serviceStarted(t:test.TestContext,scenario='normal'){
 const f=await fixture(t,scenario,{},true),service=f.service!;
 const open=await service.action({requestId:randomUUID(),action:'connect',connectionId:null}),connectionId=open.state.snapshot!.connectionId;
 await service.action({requestId:randomUUID(),action:'select',connectionId,...PAIR});
 await service.action({requestId:randomUUID(),action:'thread-start',connectionId});
 const original=await service.action({requestId:randomUUID(),action:'turn-start',connectionId,threadId:THREAD,text:'Original task',allowAssets:true,allowWorkspaceWrites:true});
 assert.equal(original.record.state,'acknowledged');return {...f,service,connectionId,original};
}
test('human steer action schema refuses grants, model/cwd overrides, alternate turn keys and unbounded input',()=>{
 const valid={requestId:randomUUID(),action:'turn-steer',connectionId:randomUUID(),threadId:THREAD,expectedTurnId:TURN,text:'Amend the active task'};
 assert.equal(codexActionInput.safeParse(valid).success,true);
 for(const value of [{...valid,turnId:TURN},{...valid,allowAssets:true},{...valid,allowWorkspaceWrites:true},{...valid,model:'other'},{...valid,displayText:'hidden input'},
  {...valid,references:[]},{...valid,text:'x'.repeat(131073)},{...valid,text:'\0'}, {...valid,expectedTurnId:''}])assert.equal(codexActionInput.safeParse(value).success,false);
});
test('service journals original plus every same-turn amendment by request identity and replays only the receipt',async t=>{
 const f=await serviceStarted(t),before=f.service.state(),first=randomUUID(),second=randomUUID();
 for(const requestId of [first,second]){
  const value={requestId,action:'turn-steer',connectionId:f.connectionId,threadId:THREAD,expectedTurnId:TURN,text:'Same amendment text'};
  const result=await f.service.action(value);assert.equal(result.record.state,'acknowledged');assert.equal(result.record.turnId,TURN);assert.equal(result.record.requestId,requestId);
  const replay=await f.service.action(value);assert.equal(replay.replayed,true);assert.deepEqual(replay.record,result.record);
 }
 const after=f.service.state(),messages=after.submittedMessages!.messages;
 assert.deepEqual(messages.map(row=>row.requestId),[f.original.record.requestId,first,second]);assert.deepEqual(messages.map(row=>row.kind),[undefined,'steer','steer']);
 assert.ok(messages.every(row=>row.turnId===TURN&&row.state==='acknowledged'));assert.deepEqual(after.nativeAssets,before.nativeAssets);
 assert.equal(f.observed.dispatches.length,1);assert.equal(f.observed.ends.length,0);assert.equal(f.observed.retirements,0);
 assert.equal((await f.wire()).filter(row=>row.method==='turn/steer').length,2);assert.equal((await f.wire()).filter(row=>row.method==='turn/start').length,1);
 await assert.rejects(f.service.action({requestId:first,action:'turn-steer',connectionId:f.connectionId,threadId:THREAD,expectedTurnId:TURN,text:'Changed payload'}),errorCode('IDEMPOTENCY'));
});
for(const scenario of ['reject','malformed','lost'] as const)test('service '+scenario+' amendment preserves request outcome and never retires the original task or repeats delivery',async t=>{
 const f=await serviceStarted(t,scenario);Object.assign(f.bounds,{requestTimeoutMs:100});const before=f.service.state().nativeAssets;
 const value={requestId:randomUUID(),action:'turn-steer',connectionId:f.connectionId,threadId:THREAD,expectedTurnId:TURN,text:'Amend original'};
 const result=await f.service.action(value);assert.equal(result.record.state,scenario==='reject'?'rejected':'unknown');assert.equal(result.record.turnId,TURN);
 assert.equal(result.state.submittedMessages!.messages.at(-1)?.kind,'steer');assert.equal(result.state.submittedMessages!.messages.at(-1)?.state,result.record.state);
 assert.deepEqual(result.state.nativeAssets,before);assert.equal(result.state.snapshot?.thread?.turnStatus,'inProgress');assert.equal(result.state.snapshot?.thread?.writeGranted,true);
 assert.equal(f.observed.retirements,0);assert.equal(f.observed.ends.length,0);
 const replay=await f.service.action(value);assert.equal(replay.replayed,true);assert.equal((await f.wire()).filter(row=>row.method==='turn/steer').length,1);
});
test('service stale connection/thread/turn refusals never dispatch or silently adopt another current turn',async t=>{
 const f=await serviceStarted(t),valid={action:'turn-steer',connectionId:f.connectionId,threadId:THREAD,expectedTurnId:TURN,text:'Amend original'};
 for(const change of [{connectionId:randomUUID()},{threadId:'other-thread'},{expectedTurnId:'other-turn'}]){
  const result=await f.service.action({...valid,...change,requestId:randomUUID()});assert.equal(result.record.state,'rejected');
  assert.equal(result.record.threadId,'threadId' in change?change.threadId:THREAD);assert.equal(result.record.turnId,'expectedTurnId' in change?change.expectedTurnId:TURN);
 }
 assert.equal((await f.wire()).some(row=>row.method==='turn/steer'),false);assert.equal(f.observed.retirements,0);
});
test('submitted storage keeps legacy JSON and all duplicate-text same-turn steer request identities across recovery',()=>{
 const db=new DatabaseSync(':memory:');try{
  const store=new SubmittedChatStore(db,'synthetic-project','codex'),binding={threadId:THREAD,sessionId:SESSION};
  const original:SubmittedChatMessage={requestId:randomUUID(),turnId:TURN,text:'Same text',model:PAIR.model,effort:PAIR.effort,state:'pending',createdAt:'2026-10-20T12:00:00.000Z',finishedAt:null,errorCode:null,contextIncluded:false,transmittedBytes:9};
  store.put(binding,original);store.finish(original.requestId,{turnId:TURN,model:PAIR.model,effort:PAIR.effort,state:'acknowledged',finishedAt:'2026-10-20T12:00:01.000Z',errorCode:null});
  const before=db.prepare('SELECT payload FROM submitted_chat_messages WHERE request_id=?').get(original.requestId)?.payload;
  const first={...original,kind:'steer' as const,requestId:randomUUID()},second={...original,kind:'steer' as const,requestId:randomUUID()};store.put(binding,first);store.put(binding,second);
  store.finish(first.requestId,{turnId:TURN,model:PAIR.model,effort:PAIR.effort,state:'acknowledged',finishedAt:'2026-10-20T12:00:02.000Z',errorCode:null});
  store.recoverPending('2026-10-20T12:00:03.000Z');const messages=store.read(binding).messages;
  assert.deepEqual(messages.map(row=>row.requestId),[original.requestId,first.requestId,second.requestId]);assert.deepEqual(messages.map(row=>row.state),['acknowledged','acknowledged','unknown']);
  assert.equal(messages[0]?.kind,undefined);assert.ok(messages.slice(1).every(row=>row.kind==='steer'&&row.turnId===TURN));
  assert.equal(db.prepare('SELECT payload FROM submitted_chat_messages WHERE request_id=?').get(original.requestId)?.payload,before);
 }finally{db.close();}
});
