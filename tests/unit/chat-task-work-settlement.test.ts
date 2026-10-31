import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,rmSync} from 'node:fs';
import {join,relative,isAbsolute} from 'node:path';
import {ChatTaskCoordinator,ChatTaskProposalBudget,type ChatTaskOwner} from '../../apps/daemon/src/chat-task-coordinator.js';
import {ChatTaskStore} from '../../packages/storage/src/chat-task-store.js';
import type {Snapshot} from '../../packages/codex-client/src/types.js';
import type {StudioTestTaskOrigin,StudioTestTaskPrepared,StudioTestTaskSettled,StudioTestTaskWork,StudioTestTaskWorkRegistration} from '../../packages/protocol/src/chat-task-playtest.js';
import {makeFixtureDirectory,fixtureTempDirectory} from './windows-fixture-paths.js';
import {createCodexService} from '../../apps/daemon/src/codex-service.js';
import {createNativeAssetRegistry} from '../../apps/daemon/src/native-asset-authority.js';
import {CodexSession} from '../../packages/codex-client/src/session.js';
import {nativeEnvironment} from '../../packages/codex-client/src/transport.js';
import {limits} from '../../packages/codex-client/src/validation.js';
import {ARCANE_NATIVE_TOOL_NAMES} from '../../packages/protocol/src/arcane-tools.js';
import {readFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';

// Actual coordinator and SQLite, controlled host ports and deferred lifetimes.
// These schedules establish accounting/error behavior, never native closure,
// controller acceptance, provider inference or Studio gameplay evidence.
const ACCOUNT='a'.repeat(64);
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
function deferred(){let resolve!:()=>void,reject!:(error:unknown)=>void;const promise=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function report(prepared:StudioTestTaskPrepared,kind:'idle'|'passed'|'failed'='idle'):StudioTestTaskSettled {
  const idle=kind==='idle';
  return {...prepared,reportDigest:sha(prepared.jobId+kind),review:{runId:idle?null:prepared.jobId,evidence:'fixture',nativeAcceptance:false,binding:null,scopeDigest:null,
    phase:idle?'idle':'done',outcome:idle?null:kind==='passed'?'succeeded':'failed',code:kind==='failed'?'ASSERTION_FAILED':'OK',cleanup:idle?'not_started':'complete',
    startedAt:null,deadline:null,cleanupDeadline:null,watchdog:{armed:false,fired:false,reason:null},observations:0,logs:[],logsTruncated:false,
    requiresHumanReview:false,canStartAnotherOperation:!idle},scenario:idle?null:{outcome:kind==='passed'?'passed':'failed',requiredEvidence:'complete',inputRelease:'complete',restoration:'not_required',subjects:'current'}};
}
type Job={origin:StudioTestTaskOrigin;identity:StudioTestTaskWork;prepared:StudioTestTaskPrepared;life:ReturnType<typeof deferred>;packet:StudioTestTaskSettled|null};
function fixture(t:TestContext,budget:ChatTaskProposalBudget=new ChatTaskProposalBudget()){
  const root=makeFixtureDirectory('arcane-task-work-'),project=join(root,'project');mkdirSync(project);
  const directory=join(root,'state'),coordinator=new ChatTaskCoordinator({directory,projectPath:project,proposalBudget:budget});
  const jobs=new Map<string,Job>(),releases:(()=>void)[]=[],counts={exact:0,unpublished:0,owner:0,revalidation:0};
  let expectedClose:{value:unknown}|null=null;
  const hooks:{exact?:(job:Job)=>Promise<void>;revalidate?:(job:Job)=>Promise<'current'|'changed'|'unobserved'>}={};
  coordinator.attachCancellation(Object.freeze({async cancelExact(jobId:string,origin:StudioTestTaskOrigin){
    const job=jobs.get(jobId);assert.ok(job);assert.equal(job.origin,origin);counts.exact++;
    if(hooks.exact)return hooks.exact(job);
    if(job.packet===null){job.packet=report(job.prepared);coordinator.playtests.terminal(origin,job.packet,job.identity);}
    job.life.resolve();
  },async revalidateExact(jobId:string,origin:StudioTestTaskOrigin,digest:string){
    const job=jobs.get(jobId);assert.ok(job);assert.equal(job.origin,origin);assert.equal(job.packet?.reportDigest,digest);counts.revalidation++;
    return hooks.revalidate?hooks.revalidate(job):'current';
  }}));
  t.after(async()=>{for(const release of releases)release();try{
    if(expectedClose){const expected=expectedClose.value;await assert.rejects(coordinator.close(),error=>Object.is(error,expected));await assert.rejects(coordinator.close(),error=>Object.is(error,expected));}
    else await coordinator.close();
  }finally{const inside=relative(fixtureTempDirectory(),root);assert.ok(!isAbsolute(inside)&&inside.startsWith('arcane-task-work-')&&!inside.startsWith('..'));rmSync(root,{recursive:true,force:true});}});
  const gate=()=>{const value=deferred();releases.push(value.resolve);return value;};
  const own=()=>{
    const id=randomUUID(),actorId='work-'+id;
    const snapshot:Snapshot={connectionId:randomUUID(),provenance:'spawned-node-fixture',mcpIsolation:'arcane-only-verified',connected:true,ready:true,
      account:{auth:'subscription',plan:null,requiresOpenaiAuth:true},models:[],selection:{model:'fixture',effort:'low'},
      thread:{threadId:'thread-'+id,sessionId:'session-'+id,selection:{model:'fixture',effort:'low'},configured:true,writeGranted:false,turnId:null,turnStatus:'inProgress'},
      operations:[],approvals:[],events:[],droppedEvents:0,lastEventSeq:0,failureCode:null};
    const owner:ChatTaskOwner={snapshot:()=>snapshot,accountIdentity:()=>ACCOUNT,revoke(){},async cancel(){counts.owner++;},async repair(){assert.fail('Unexpected repair.');}};
    coordinator.begin({id,actorId,snapshot,allowWorkspaceWrites:false,allowAssets:false,owner,accountIdentity:ACCOUNT});
    const dispatch=()=>{
      const operationId=randomUUID(),turnId=randomUUID();snapshot.thread!.turnId=turnId;snapshot.thread!.turnStatus='inProgress';
      snapshot.operations.push({operationId,method:'turn/start',requestId:1,threadId:snapshot.thread!.threadId,turnId,state:'acknowledged',errorCode:null});
      coordinator.dispatched(id,operationId);const origin=coordinator.playtests.capture(actorId);assert.ok(origin);return {origin,operationId,turnId};
    };
    const first=dispatch();
    const acknowledge=()=>{snapshot.thread!.turnStatus='completed';coordinator.acknowledged(id);};
    return {id,actorId,snapshot,owner,origin:first.origin,dispatch,acknowledge};
  };
  const prepare=(parent:ReturnType<typeof own>)=>{
    const life=gate(),prepared={jobId:randomUUID(),displayDigest:sha('display'),scenarioDigest:sha('scenario'),subjectDigest:sha('subjects')};
    const identity=coordinator.playtests.registerWork(parent.origin,Object.freeze({kind:'prepare' as const,completion:life.promise,cancel:async()=>{counts.unpublished++;life.resolve();}}));
    const job:Job={origin:parent.origin,identity,prepared,life,packet:null};jobs.set(prepared.jobId,job);coordinator.playtests.prepared(parent.origin,prepared,identity);return job;
  };
  const terminal=(job:Job,kind:'idle'|'passed'|'failed'='passed')=>{job.packet=report(job.prepared,kind);coordinator.playtests.terminal(job.origin,job.packet,job.identity);return job.packet;};
  return {directory,project,coordinator,counts,hooks,jobs,gate,own,prepare,terminal,expectClose:(value:unknown)=>{expectedClose={value};}};
}

test('work registration refuses unsafe records and Promise hooks without evaluating them',t=>{
  const f=fixture(t),parent=f.own(),life=f.gate();let invoked=0;
  const cancel=async()=>{};
  const invalid=(value:unknown)=>assert.throws(()=>f.coordinator.playtests.registerWork(parent.origin,value as StudioTestTaskWorkRegistration));
  invalid(new Proxy({}, {ownKeys(){invoked++;return [];},getPrototypeOf(){invoked++;return null;}}));
  invalid(Object.freeze({kind:'prepare',get completion(){invoked++;return life.promise;},cancel}));
  invalid(Object.freeze(Object.defineProperty({kind:'prepare',completion:life.promise,cancel},'hidden',{value:true})));
  invalid(Object.freeze({kind:'prepare',completion:life.promise,cancel,[Symbol('extra')]:true}));
  invalid(Object.freeze({kind:'prepare',completion:{get then(){invoked++;return ()=>{};}},cancel}));
  const hooked=f.gate();Object.defineProperty(hooked.promise,'constructor',{get(){invoked++;return Promise;}});
  invalid(Object.freeze({kind:'prepare',completion:hooked.promise,cancel}));
  class ForeignPromise extends Promise<void>{}
  const subclass=new ForeignPromise(resolve=>resolve());invalid(Object.freeze({kind:'prepare',completion:subclass,cancel}));
  invalid(Object.freeze({kind:'prepare',completion:life.promise,cancel:new Proxy(cancel,{apply(){invoked++;}})}));
  assert.equal(invoked,0);
  const valid=f.coordinator.playtests.registerWork(parent.origin,Object.freeze({kind:'prepare' as const,completion:life.promise,cancel:async()=>life.resolve()}));
  assert.ok(Object.isFrozen(valid));assert.equal(valid.signal.aborted,false);
  invalid(Object.freeze({kind:'prepare',completion:life.promise,cancel}));
});

test('work registration accepts runtime symbol fields on ordinary Promises but refuses symbol accessors',t=>{
  const f=fixture(t),parent=f.own(),tagged=f.gate(),accessor=f.gate();let invoked=0;
  // Mirrors the inert symbol data fields Node attaches while async hooks are enabled.
  Object.defineProperty(tagged.promise,Symbol('runtime async id'),{value:1,writable:true,enumerable:false,configurable:true});
  const work=f.coordinator.playtests.registerWork(parent.origin,Object.freeze({kind:'prepare' as const,completion:tagged.promise,cancel:async()=>tagged.resolve()}));
  assert.ok(Object.isFrozen(work));
  Object.defineProperty(accessor.promise,Symbol('hook'),{get(){invoked++;return 1;}});
  assert.throws(()=>f.coordinator.playtests.registerWork(parent.origin,Object.freeze({kind:'prepare' as const,completion:accessor.promise,cancel:async()=>accessor.resolve()})));
  assert.equal(invoked,0);tagged.resolve();accessor.resolve();
});

test('completed or foreign work cannot acquire a new job or first terminal',async t=>{
  const f=fixture(t),parent=f.own(),other=f.own(),life=f.gate();
  const work=f.coordinator.playtests.registerWork(parent.origin,Object.freeze({kind:'prepare' as const,completion:life.promise,cancel:async()=>life.resolve()}));
  const prepared={jobId:randomUUID(),displayDigest:sha('d'),scenarioDigest:null,subjectDigest:null};
  assert.throws(()=>f.coordinator.playtests.prepared(other.origin,prepared,work),/Foreign/);
  assert.throws(()=>f.coordinator.playtests.prepared(parent.origin,prepared,{...work}),/Foreign/);
  assert.throws(()=>f.coordinator.playtests.prepared(parent.origin,prepared,new Proxy(work,{})),/Foreign/);
  life.resolve();await turn();assert.throws(()=>f.coordinator.playtests.prepared(parent.origin,prepared,work),/late/);
  const job=f.prepare(parent);job.life.resolve();await turn();
  assert.throws(()=>f.coordinator.playtests.terminal(job.origin,report(job.prepared),job.identity),/after its lifetime/);
  let cleanupFailure:unknown;
  await assert.rejects(f.coordinator.cancel(parent.id,'retire malformed lifetime'),error=>{
    assert.ok(error instanceof Error);assert.match(error.message,/after its lifetime/);cleanupFailure=error;return true;
  });
  f.expectClose(cleanupFailure);
});

test('retirement joins late unpublished allocation and close once, with reentrant cancellation', {timeout:10000},async t=>{
  const f=fixture(t),parent=f.own(),allocated=f.gate(),closed=f.gate(),life=f.gate(),cancelEntered=f.gate();let compensation=0,lateEffects=0;
  let work!:StudioTestTaskWork;
  const registration=Object.freeze({kind:'prepare' as const,completion:life.promise,cancel:async()=>{compensation++;cancelEntered.resolve();await allocated.promise;await closed.promise;life.resolve();}});
  work=f.coordinator.playtests.registerWork(parent.origin,registration);
  let nested:Promise<void>|null=null;
  parent.owner.revoke=()=>{nested=f.coordinator.cancel(parent.id,'reentrant notification');};
  const first=f.coordinator.cancel(parent.id,'stop');let finished=false;void first.then(()=>{finished=true;});
  await cancelEntered.promise;assert.equal(f.counts.owner,1,'owner cancellation starts before the held preparation is joined');
  await turn();assert.equal(finished,false);assert.ok(nested);assert.equal(work.signal.aborted,true);
  allocated.resolve();assert.throws(()=>{work.assertActive();lateEffects++;});await turn();assert.equal(finished,false);
  closed.resolve();await first;await nested;assert.equal(compensation,1);assert.equal(lateEffects,0);
  await f.coordinator.cancel(parent.id,'same outcome');assert.equal(compensation,1);assert.equal(f.counts.owner,1);
});

test('published work uses exact cancellation alone and terminal callback never joins its finalizer',async t=>{
  const f=fixture(t),parent=f.own(),job=f.prepare(parent),closed=f.gate(),entered=f.gate();
  f.hooks.exact=async original=>{assert.equal(original,job);entered.resolve();await closed.promise;f.terminal(job,'idle');job.life.resolve();};
  const cancelled=f.coordinator.cancel(parent.id,'stop');await entered.promise;await turn();assert.equal(f.counts.unpublished,0);assert.equal(f.counts.owner,1);
  closed.resolve();await cancelled;assert.equal(f.counts.exact,1);
  f.coordinator.playtests.terminal(job.origin,job.packet!,job.identity);
  await f.coordinator.cancel(parent.id,'same stop');assert.equal(f.counts.exact,1);
});

test('fulfilled terminal work releases on retirement without calling a released service handle',async t=>{
  const f=fixture(t),parent=f.own(),job=f.prepare(parent),packet=f.terminal(job);job.life.resolve();await turn();
  f.hooks.exact=async()=>assert.fail('The fulfilled terminal service handle was legitimately released.');
  await f.coordinator.cancel(parent.id,'retire');assert.equal(f.counts.exact,0);
  f.coordinator.playtests.terminal(job.origin,packet,job.identity);
});

test('expired unstarted report replay cannot cross a fresh preparation',async t=>{
  const f=fixture(t),parent=f.own(),first=f.prepare(parent),packet=f.terminal(first,'idle');first.life.resolve();await turn();
  const second=f.prepare(parent);assert.notEqual(first.prepared.jobId,second.prepared.jobId);
  assert.throws(()=>f.coordinator.playtests.terminal(first.origin,packet,first.identity),/scope changed/);
  await f.coordinator.cancel(parent.id,'stop');
});

test('read-only old-job revalidation survives operation rotation and is joined with the held advance', {timeout:10000},async t=>{
  const f=fixture(t),parent=f.own(),job=f.prepare(parent),repairEntered=f.gate(),repairDone=f.gate(),readerClosed=f.gate(),readerLife=f.gate();
  parent.owner.repair=async()=>{parent.dispatch();repairEntered.resolve();await repairDone.promise;};
  parent.owner.cancel=async()=>{f.counts.owner++;repairDone.resolve();};
  const packet=f.terminal(job,'failed');job.life.resolve();parent.acknowledge();await repairEntered.promise;
  assert.notEqual(f.coordinator.playtests.capture(parent.actorId),job.origin);
  const reader=f.coordinator.playtests.registerWork(job.origin,Object.freeze({kind:'revalidate' as const,jobId:job.prepared.jobId,reportDigest:packet.reportDigest,completion:readerLife.promise,
    cancel:async()=>{await readerClosed.promise;readerLife.resolve();}}));
  reader.assertActive();const cancelled=f.coordinator.cancel(parent.id,'stop');let done=false;void cancelled.then(()=>{done=true;});await turn();assert.equal(done,false);
  assert.throws(()=>reader.assertActive());readerClosed.resolve();await cancelled;assert.equal(f.counts.exact,0);
});

test('advance repair failure requests cleanup without self-joining and close retains its original failure', {timeout:10000},async t=>{
  const f=fixture(t),parent=f.own(),job=f.prepare(parent),failed=new Error('original repair failure');f.expectClose(failed);
  parent.owner.repair=async()=>{throw failed;};f.terminal(job,'failed');job.life.resolve();parent.acknowledge();
  await f.coordinator.drain();assert.equal(f.counts.owner,1);assert.equal(f.coordinator.list().find(value=>value.id===parent.id)!.state,'paused');
  await assert.rejects(f.coordinator.cancel(parent.id,'observe cleanup'),error=>error===failed);
});

test('plan evidence callback is joined after original owner cancellation, with no later incorporation', {timeout:15000},async t=>{
  const f=fixture(t),parent=f.own(),evidenceEntered=f.gate(),evidenceDone=f.gate();let incorporated=0,workers=0,workerCloses=0;
  parent.owner.plan=()=>({async waitForInitial(){},async incorporate(_text,acknowledge){incorporated++;const op=parent.dispatch();parent.snapshot.thread!.turnStatus='completed';acknowledge({operationId:op.operationId,turnId:op.turnId});return 'completed';}});
  f.coordinator.startPlan({taskId:parent.id,objective:'Controlled original task',inputSha256:sha('original'),factory:async()=>({
    async propose(){workers++;return {threadId:'proposal',sessionId:null,turnId:'turn',text:'Controlled suggestion'};},async close(){workerCloses++;}}),
    evidence:async()=>{evidenceEntered.resolve();await evidenceDone.promise;return {runId:randomUUID()};}});
  await evidenceEntered.promise;assert.equal(incorporated,1);assert.equal(workers,5);assert.equal(workerCloses,5);
  const cancelled=f.coordinator.cancel(parent.id,'stop');let done=false;void cancelled.then(()=>{done=true;});await turn();assert.equal(f.counts.owner,1);assert.equal(done,false);
  evidenceDone.resolve();await cancelled;assert.equal(incorporated,1);assert.equal(workers,5);
});

test('one shared 64-work pool retains successful published handles until actual task retirement', {timeout:30000},async t=>{
  const f=fixture(t),parents=[];
  for(let i=0;i<64;i++){const parent=f.own(),job=f.prepare(parent);f.terminal(job);job.life.resolve();parents.push(parent);}
  await turn();const next=f.own(),life=f.gate(),registration=Object.freeze({kind:'prepare' as const,completion:life.promise,cancel:async()=>life.resolve()});
  assert.throws(()=>f.coordinator.playtests.registerWork(next.origin,registration),/full/);
  await Promise.all(parents.map(parent=>f.coordinator.cancel(parent.id,'retire closed task')));assert.equal(f.counts.exact,0);
  const admitted=f.coordinator.playtests.registerWork(next.origin,registration);admitted.assertActive();await f.coordinator.cancel(next.id,'stop');
});

test('failed original lifetimes retain all 64 charges after cancellation without eviction or replay', {timeout:15000},async t=>{
  const f=fixture(t),parent=f.own(),failure=new Error('controlled unknown lifetime');f.expectClose(failure);let compensated=0;
  for(let i=0;i<64;i++){const life=f.gate();f.coordinator.playtests.registerWork(parent.origin,Object.freeze({kind:'prepare' as const,completion:life.promise,cancel:async()=>{compensated++;}}));life.reject(failure);}
  await turn();await assert.rejects(f.coordinator.cancel(parent.id,'stop'),error=>error===failure);assert.equal(compensated,64);
  const next=f.own(),life=f.gate();assert.throws(()=>f.coordinator.playtests.registerWork(next.origin,Object.freeze({kind:'prepare' as const,completion:life.promise,cancel:async()=>life.resolve()})),/full/);
  await assert.rejects(f.coordinator.cancel(parent.id,'same failure'),error=>error===failure);assert.equal(compensated,64);
});

test('original proposal close failure precedes a later budget fault and remains quarantined',async t=>{
  for(const failedDuringPropose of [false,true])await t.test(failedDuringPropose?'propose close failure first':'explicit close failure first',async st=>{
  const original=Object.assign(new Error('original worker close'),{code:'PROCESS_EXIT_UNCONFIRMED'}),next=new Error('later repeated close'),later=new Error('later budget release');
  class FaultBudget extends ChatTaskProposalBudget {override release(closed:boolean,identity?:Parameters<ChatTaskProposalBudget['release']>[1]){super.release(closed,identity);throw later;}}
  const budget=new FaultBudget(),f=fixture(st,budget),parent=f.own();f.expectClose(original);let closes=0;
  const proposal=f.coordinator.startProposal({taskId:parent.id,requestId:randomUUID(),text:'Controlled suggestion',factory:async()=>({
    async propose(){if(failedDuringPropose)throw original;return {threadId:'proposal',sessionId:null,turnId:'turn',text:'suggestion'};},async close(){closes++;throw failedDuringPropose?next:original;}})});
  await f.coordinator.drain();assert.equal(f.coordinator.proposals(parent.id).find(value=>value.id===proposal.id)!.reason,'worker_close_unconfirmed');
  await assert.rejects(f.coordinator.cancel(parent.id,'stop'),error=>error===original);assert.equal(closes,1);assert.equal(budget.quarantined,1);
  await assert.rejects(f.coordinator.cancel(parent.id,'same failure'),error=>error===original);assert.equal(closes,1);
  });
});

test('synchronous fence retirement failure is retained through cached close while original cleanup still runs',async t=>{
  for(const value of [new Error('original revoke failure'),null,undefined,false,0])await t.test(String(value),async st=>{
    const f=fixture(st),parent=f.own();f.expectClose(value);parent.owner.revoke=()=>{throw value;};
    f.coordinator.fence();await assert.rejects(f.coordinator.close(),error=>Object.is(error,value));assert.equal(f.counts.owner,1);
    await assert.rejects(f.coordinator.close(),error=>Object.is(error,value));assert.equal(f.counts.owner,1);
    const reopened=new ChatTaskStore({directory:f.directory,projectPath:f.project});
    try{assert.equal(reopened.get(parent.id).state,'cancelled');}finally{reopened.close();}
  });
});

const REPAIR_PEER=String.raw`
const {createInterface}=require('node:readline'),{appendFileSync,writeFileSync}=require('node:fs');
const s=JSON.parse(process.argv[1]);let turns=0;
const send=value=>process.stdout.write(JSON.stringify(value)+'\n'),reply=(id,result)=>send({id,result});
createInterface({input:process.stdin}).on('line',line=>{
 const message=JSON.parse(line),{id,method,params={}}=message;
 appendFileSync(s.audit,JSON.stringify({method})+'\n');if(!method||method==='initialized')return;
 if(method==='initialize')return reply(id,{});
 if(method==='account/read')return reply(id,{account:{type:'chatgpt',email:'owned-close@example.invalid',planType:'plus'},requiresOpenaiAuth:true});
 if(method==='model/list')return reply(id,{data:[{id:'fixture',model:'fixture',displayName:'Fixture',supportedReasoningEfforts:[{reasoningEffort:'low'}]}],nextCursor:null});
 if(method==='thread/start')return reply(id,{thread:{id:'owned-close-thread',sessionId:'owned-close-session',turns:[],status:{type:'idle'}},model:params.model,modelProvider:'openai',cwd:process.cwd(),approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:{type:'readOnly',networkAccess:false}});
 if(method==='mcpServerStatus/list'){
  if(turns===1&&s.mode==='preflight'){writeFileSync(s.entered,'held');return;}
  return reply(id,{data:[{name:'arcane',runtimeStatus:'connected',toolsError:null,pluginId:null,tools:Object.fromEntries(s.tools.map(name=>[name,{}]))}],nextCursor:null});
 }
 if(method==='turn/start'){
  if(++turns===1)return reply(id,{turn:{id:'owned-initial-turn',status:'completed'}});
  writeFileSync(s.entered,'held');if(s.mode==='remote')return send({id,error:{code:-32001,message:'Controlled original repair rejection'}});return;
 }
 throw Error('Unexpected controlled peer method');
});`;
async function repairServiceFixture(t:TestContext,mode:'preflight'|'ack'|'remote',closeFailure?:Error,foreignRepairFailure?:{value:unknown}){
  const root=makeFixtureDirectory('arcane-owned-repair-'),project=join(root,'project');mkdirSync(project);
  const registry=createNativeAssetRegistry({projectPath:project}),audit=join(root,'methods.jsonl'),entered=join(root,'repair-entered');
  let client:CodexSession|undefined,credential='',repairFailure:unknown,hasRepairFailure=false,closes=0,expectedClose:{value:unknown}|null=null;
  const service=createCodexService({directory:join(root,'journal'),projectPath:project,assetRegistry:registry,connect:async hooks=>{
    assert.ok(hooks);credential=hooks.finalCredential();client=new CodexSession({command:process.execPath,args:['-e',REPAIR_PEER,JSON.stringify({mode,audit,entered,tools:ARCANE_NATIVE_TOOL_NAMES})],cwd:project,env:nativeEnvironment()},limits({requestTimeoutMs:5000}),'spawned-node-fixture','arcane-only',hooks);
    const originalRepair=client.continueTask.bind(client),originalClose=client.close.bind(client);
    client.continueTask=async input=>{try{return await originalRepair(input);}catch(error){const failure=foreignRepairFailure?foreignRepairFailure.value:error;repairFailure=failure;hasRepairFailure=true;throw failure;}};
    client.close=async()=>{closes++;await originalClose();if(closeFailure)throw closeFailure;};
    await client.initialize();return client;
  }});
  let job:{origin:StudioTestTaskOrigin;packet:StudioTestTaskSettled;work:StudioTestTaskWork;life:ReturnType<typeof deferred>}|null=null;
  service.attachPlaytestCancellation(Object.freeze({async cancelExact(jobId:string,origin:StudioTestTaskOrigin){assert.ok(job);assert.equal(job.packet.jobId,jobId);assert.equal(job.origin,origin);service.playtestTasks!.terminal(origin,job.packet,job.work);job.life.resolve();},async revalidateExact(){return 'current' as const;}}));
  t.after(async()=>{try{if(expectedClose)await assert.rejects(service.close(),error=>error===expectedClose!.value);else await service.close();}
    finally{try{if(client){if(closeFailure)await assert.rejects(client.close(),error=>error===closeFailure);else await client.close();}}finally{registry.close();const tail=relative(fixtureTempDirectory(),root);assert.ok(!isAbsolute(tail)&&tail.startsWith('arcane-owned-repair-')&&!tail.startsWith('..'));rmSync(root,{recursive:true,force:true});}}});
  const action=(name:string,fields:Record<string,unknown>={})=>service.action({requestId:randomUUID(),connectionId:name==='connect'?null:service.state().snapshot!.connectionId,action:name,...fields});
  for(const[name,fields]of [['connect',{}],['select',{model:'fixture',effort:'low'}],['thread-start',{}],['turn-start',{threadId:'owned-close-thread',text:'Controlled task'}]]as const)
    assert.equal((await action(name,fields)).record.state,'acknowledged',name);
  assert.ok(client);const originalClient=client,connectionId=client.snapshot().connectionId,taskId=service.state().chatTasks![0]!.taskId;
  const origin=service.playtestTasks!.capture('agent-'+sha(credential));assert.ok(origin);
  const prepared={jobId:randomUUID(),displayDigest:sha('display'),scenarioDigest:sha('scenario'),subjectDigest:sha('subject')},life=deferred();
  const work=service.playtestTasks!.registerWork(origin,Object.freeze({kind:'prepare' as const,completion:life.promise,cancel:async()=>assert.fail('Published original job uses exact cancellation.')}));
  const packet=report(prepared,'failed');job={origin,packet,work,life};service.playtestTasks!.prepared(origin,prepared,work);service.playtestTasks!.terminal(origin,packet,work);life.resolve();
  const waitFor=async(check:()=>boolean|Promise<boolean>)=>{const end=Date.now()+6000;while(!await check()){assert.ok(Date.now()<end,'Expected actual controlled repair dispatch.');await delay(5);}};
  await waitFor(async()=>{try{return await readFile(entered,'utf8')==='held';}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}});
  return {service,client:originalClient,waitFor,repairFailure:()=>({seen:hasRepairFailure,value:repairFailure}),closes:()=>closes,
    expectClose:(value:unknown)=>{expectedClose={value};},methods:async()=>(await readFile(audit,'utf8')).trim().split('\n').map(line=>(JSON.parse(line)as {method:string}).method),
    stop:()=>service.action({requestId:randomUUID(),connectionId,action:'task-stop',threadId:'owned-close-thread',taskId})};
}
for(const mode of ['preflight','ack']as const)test('actual Stop joins a deliberately closed held repair '+mode+' without inventing a cleanup failure',{timeout:20000},async t=>{
  const f=await repairServiceFixture(t,mode),stopped=await f.stop();assert.equal(stopped.record.state,'acknowledged');
  assert.equal(f.repairFailure().seen,true);const error=f.repairFailure().value;assert.equal(f.client.isOwnedCloseRequestError(error),true);
  assert.ok(error instanceof Error);assert.equal(f.client.isOwnedCloseRequestError({...error}),false);
  assert.equal((await f.methods()).filter(method=>method==='turn/start').length,mode==='preflight'?1:2);
  await f.service.close();await f.service.close();assert.equal(f.closes(),1);
});
test('actual Stop preserves the independent owned close failure after its repair request was intentionally interrupted',{timeout:20000},async t=>{
  const original=new Error('original owned close failure'),f=await repairServiceFixture(t,'ack',original);f.expectClose(original);
  assert.equal((await f.stop()).record.state,'rejected');assert.equal(f.client.isOwnedCloseRequestError(f.repairFailure().value),true);
  await assert.rejects(f.service.close(),error=>error===original);await assert.rejects(f.service.close(),error=>error===original);
});
test('an actual original repair rejection remains a failure after later owned closure',{timeout:20000},async t=>{
  const f=await repairServiceFixture(t,'remote');await f.waitFor(()=>f.repairFailure().seen);
  const original=f.repairFailure().value;assert.equal(f.client.isOwnedCloseRequestError(original),false);f.expectClose(original);
  await assert.rejects(f.service.close(),error=>error===original);await assert.rejects(f.service.close(),error=>error===original);
});
test('another actual session\'s deliberate-close error cannot settle this original service task',{timeout:20000},async t=>{
  const first=await repairServiceFixture(t,'preflight');assert.equal((await first.stop()).record.state,'acknowledged');
  const foreign=first.repairFailure().value;assert.equal(first.client.isOwnedCloseRequestError(foreign),true);
  const second=await repairServiceFixture(t,'ack',undefined,{value:foreign});second.expectClose(foreign);
  assert.equal(second.client.isOwnedCloseRequestError(foreign),false);assert.equal((await second.stop()).record.state,'rejected');
  await assert.rejects(second.service.close(),error=>error===foreign);await assert.rejects(second.service.close(),error=>error===foreign);
  await first.service.close();assert.equal(first.closes(),1);
});
test('revocation cannot relabel a copied close error or a failed/missing classifier',{timeout:15000},async t=>{
  for(const mode of ['missing','false','throws']as const)await t.test(mode,async st=>{
    const f=fixture(st),parent=f.own(),job=f.prepare(parent),entered=f.gate(),released=f.gate();
    const original=Object.assign(new Error('Local client disconnected.'),{code:'DISCONNECTED',dispatched:true});f.expectClose(original);
    parent.owner.repair=async()=>{entered.resolve();await released.promise;throw original;};
    parent.owner.cancel=async()=>{f.counts.owner++;released.resolve();};
    if(mode==='false')parent.owner.isOwnedCloseRequestError=()=>false;
    if(mode==='throws')parent.owner.isOwnedCloseRequestError=()=>{throw new Error('Later classifier fault');};
    f.terminal(job,'failed');job.life.resolve();parent.acknowledge();await entered.promise;
    await assert.rejects(f.coordinator.cancel(parent.id,'actual Stop'),error=>error===original);assert.equal(f.counts.owner,1);
    await assert.rejects(f.coordinator.close(),error=>error===original);
  });
});
