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
  class FaultBudget extends ChatTaskProposalBudget {override release(closed:boolean){super.release(closed);throw later;}}
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
