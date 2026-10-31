import nodeTest,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdir,mkdtemp,readFile,readdir,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {isAbsolute,join,relative,sep} from 'node:path';
import {ChatTaskStore,type ChatTaskRecord,type ChatTaskProposalWorkerReservation} from '../../packages/storage/src/chat-task-store.js';
import {sqliteTransportPath} from '../../packages/storage/src/sqlite-path.js';

// Real temporary SQLite journals and labelled in-memory workers only. No native
// process, provider, Studio, descendant containment or automatic recovery proof.
const test=(name:string,run:(t:TestContext)=>void|Promise<void>)=>nodeTest(name,{timeout:10_000},run);
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const tick=()=>new Promise<void>(done=>setImmediate(done));
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};};
async function rejected(promise:Promise<unknown>):Promise<unknown>{let failed=false,fault:unknown;try{await promise;}catch(error){failed=true;fault=error;}assert.equal(failed,true,'Expected the original rejection');return fault;}
function task(state:ChatTaskRecord['state']='cancelled'){
  return{id:randomUUID(),provider:'codex' as const,threadId:'proposal-closure-thread',sessionId:null,connectionId:randomUUID(),incarnationId:randomUUID(),
    model:'fixture-model',effort:'low',allowWorkspaceWrites:false,allowAssets:false,state,round:0 as const,operationId:null,turnId:null,nativeSettled:false,
    acknowledged:false,repairDispatch:'not_requested' as const,prepared:null,evidence:[],reason:null};
}
async function fixture(t:TestContext){
  const boundary=await realpath(tmpdir()),root=await realpath(await mkdtemp(join(boundary,'arcane-proposal-closure-'))),projectPath=join(root,'project'),directory=join(root,'state');
  await mkdir(projectPath);await mkdir(directory);const stores:ChatTaskStore[]=[];
  t.after(async()=>{for(const store of stores)store.close();const tail=relative(boundary,root);assert.ok(tail.startsWith('arcane-proposal-closure-')&&!isAbsolute(tail)&&!tail.includes(sep));await rm(root,{recursive:true,force:true});});
  const open=()=>{const store=new ChatTaskStore({projectPath,directory});stores.push(store);return store;};
  return{directory,projectPath,file:join(directory,'chat-tasks.sqlite'),open};
}
function proposal(store:ChatTaskStore,taskId=store.create(task()).id){return store.reserveProposal({id:randomUUID(),taskId,requestId:randomUUID(),promptSha256:sha('owned synthetic brief'),promptBytes:21});}
function rows(file:string,table='chat_task_proposal_worker_closures'){
  const db=new DatabaseSync(sqliteTransportPath(file),{readOnly:true,allowExtension:false});try{return db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();}finally{db.close();}
}

test('worker capabilities belong to one committed proposal and original store lifetime, never copied JSON',async t=>{
  const f=await fixture(t),store=f.open(),p=proposal(store),token=store.reserveProposalWorker(p.id);
  assert.equal(store.reserveProposalWorker(p.id),token);assert.equal(Object.isFrozen(token),true);assert.deepEqual(Reflect.ownKeys(token),[]);
  for(const fake of [{},structuredClone(token),JSON.parse(JSON.stringify(token)),null,[]])assert.throws(()=>store.proposalWorkerClosure(fake as ChatTaskProposalWorkerReservation),/original proposal worker/);
  const other=await fixture(t),foreign=other.open();assert.throws(()=>foreign.proposalWorkerClosure(token),/original proposal worker/);
  store.close();const reopened=f.open();assert.throws(()=>reopened.reserveProposalWorker(p.id),/this store lifetime/);assert.throws(()=>reopened.recordProposalWorkerNotAllocated(token),/original proposal worker/);
  assert.deepEqual(reopened.unclosedProposalIds(),[p.id]);
});

test('a failed proposal reservation COMMIT cannot mint a worker capability or leave a row',async t=>{
  const f=await fixture(t),store=f.open(),owner=store.create(task()),input={id:randomUUID(),taskId:owner.id,requestId:randomUUID(),promptSha256:sha('synthetic'),promptBytes:9},fault=new Error('Controlled reservation COMMIT refusal'),original=DatabaseSync.prototype.exec;let armed=true;
  t.mock.method(DatabaseSync.prototype,'exec',function(this:DatabaseSync,sql:string){if(armed&&sql==='COMMIT')throw fault;return original.call(this,sql);});
  let caught:unknown;try{store.reserveProposal(input);}catch(error){caught=error;}assert.equal(caught,fault);armed=false;
  assert.throws(()=>store.reserveProposalWorker(input.id),/this store lifetime/);assert.deepEqual(rows(f.file,'chat_task_proposals'),[]);assert.deepEqual(store.unclosedProposalIds(),[]);
});

test('terminal proposal labels cannot mint or invoke a new worker while prior original tokens still track nonallocation',async t=>{
  for(const state of ['proposed','failed','unknown']as const)await t.test(state,async t=>{
    const f=await fixture(t),store=f.open(),unissued=proposal(store),issued=proposal(store),token=store.reserveProposalWorker(issued.id);
    const outcome:Parameters<ChatTaskStore['settleProposal']>[1]=state==='proposed'?{state,result:{threadId:'worker',sessionId:null,turnId:'turn',text:'bounded',textBytes:7,textSha256:sha('bounded')}}:{state,reason:state==='failed'?'worker_unavailable':'dispatch_uncertain'};
    store.settleProposal(unissued.id,outcome);store.settleProposal(issued.id,outcome);
    assert.throws(()=>store.reserveProposalWorker(unissued.id),/original reserved proposal/);assert.equal(store.reserveProposalWorker(issued.id),token);
    let factories=0;await assert.rejects(store.invokeProposalWorker(token,async()=>{factories++;return{close:async()=>{}};}),/original reserved proposal/);assert.equal(factories,0);
    assert.deepEqual(store.proposalWorkerClosure(token),{settled:false,durable:false});store.recordProposalWorkerNotAllocated(token);assert.deepEqual(store.proposalWorkerClosure(token),{settled:true,durable:true});assert.deepEqual(store.unclosedProposalIds(),[unissued.id]);
  });
});

test('pre-invocation nonallocation is durable, one-use and leaves the original proposal payload untouched',async t=>{
  const f=await fixture(t),store=f.open(),p=proposal(store),token=store.reserveProposalWorker(p.id),before=rows(f.file,'chat_task_proposals');
  store.recordProposalWorkerNotAllocated(token);store.recordProposalWorkerNotAllocated(token);assert.deepEqual(store.proposalWorkerClosure(token),{settled:true,durable:true});
  let factories=0;await assert.rejects(store.invokeProposalWorker(token,async()=>{factories++;return{close:async()=>{}};}),/one-use/);assert.equal(factories,0);
  assert.deepEqual(rows(f.file,'chat_task_proposals'),before);assert.deepEqual(store.unclosedProposalIds(),[]);const marker=JSON.parse(rows(f.file)[0]!.payload as string);assert.equal(marker.kind,'not_allocated');assert.equal(marker.proposalId,p.id);assert.equal(marker.requestId,p.requestId);assert.equal(marker.projectPath,f.projectPath);
  store.close();assert.deepEqual(f.open().unclosedProposalIds(),[]);
});

test('held allocation joins the one captured original close even after outcome changes and method replacement',async t=>{
  const f=await fixture(t),store=f.open(),p=proposal(store),token=store.reserveProposalWorker(p.id),allocation=deferred(),closure=deferred();t.after(()=>{allocation.resolve();closure.resolve();});
  let factories=0,closes=0,getters=0,replacement=0;const worker={get close(){getters++;return async function(this:object){assert.equal(this,worker);closes++;await closure.promise;};}};
  const invoking=store.invokeProposalWorker(token,async()=>{factories++;await allocation.promise;return worker;});assert.equal(factories,1);
  const closing=store.closeProposalWorker(token);assert.equal(store.closeProposalWorker(token),closing);assert.deepEqual(store.proposalWorkerClosure(token),{settled:false,durable:false});
  store.settleProposal(p.id,{state:'unknown',reason:'parent_retired'});const retained=rows(f.file,'chat_task_proposals');allocation.resolve();await invoking;
  Object.defineProperty(worker,'close',{value:async()=>{replacement++;},configurable:true});await tick();assert.equal(getters,1);assert.equal(closes,1);assert.equal(replacement,0);assert.equal(rows(f.file).length,0);
  closure.resolve();await closing;assert.equal(closes,1);assert.deepEqual(store.proposalWorkerClosure(token),{settled:true,durable:true});assert.deepEqual(rows(f.file,'chat_task_proposals'),retained);assert.deepEqual(store.unclosedProposalIds(),[]);
  await store.closeProposalWorker(token);assert.equal(closes,1);await assert.rejects(store.invokeProposalWorker(token,async()=>worker),/one-use/);
});

test('factory reentrance sees the already registered allocation and close tails',async t=>{
  const f=await fixture(t),store=f.open(),p=proposal(store),token=store.reserveProposalWorker(p.id);let closes=0,joined:Promise<void>|null=null;
  await store.invokeProposalWorker(token,async()=>{joined=store.closeProposalWorker(token);assert.equal(store.closeProposalWorker(token),joined);return{close:async()=>{closes++;}};});
  assert.notEqual(joined,null);await joined;assert.equal(closes,1);assert.deepEqual(store.proposalWorkerClosure(token),{settled:true,durable:true});
});

for(const failure of [undefined,null,false,0,'',new Error('Original close failure')])test('failed original close never becomes a closure marker: '+String(failure),async t=>{
  const f=await fixture(t),store=f.open(),p=proposal(store),token=store.reserveProposalWorker(p.id);let calls=0;
  await store.invokeProposalWorker(token,async()=>({close:async()=>{calls++;throw failure;}}));const closing=store.closeProposalWorker(token);
  assert.equal(await rejected(closing),failure);assert.equal(store.closeProposalWorker(token),closing);assert.equal(await rejected(closing),failure);assert.equal(calls,1);
  assert.deepEqual(store.proposalWorkerClosure(token),{settled:false,durable:false});assert.deepEqual(store.unclosedProposalIds(),[p.id]);assert.equal(rows(f.file).length,0);
});

test('synchronous and thenable close returns never certify original Promise fulfillment',async t=>{
  for(const result of [undefined,false,null,{then(){throw new Error('A thenable must not be assimilated');}}])await t.test(String(result),async t=>{
    const f=await fixture(t),store=f.open(),p=proposal(store),token=store.reserveProposalWorker(p.id);let closes=0;
    // Deliberately violate the declared private worker port at the runtime boundary.
    const worker={close(){closes++;return result;}} as unknown as {close():Promise<void>};await store.invokeProposalWorker(token,async()=>worker);
    const tail=store.closeProposalWorker(token);assert.match(String(await rejected(tail)),/original Promise/);assert.equal(store.closeProposalWorker(token),tail);assert.equal(closes,1);assert.deepEqual(store.proposalWorkerClosure(token),{settled:false,durable:false});assert.equal(rows(f.file).length,0);assert.deepEqual(store.unclosedProposalIds(),[p.id]);
  });
});

for(const code of ['NOT_FOUND','MCP_UNAVAILABLE','ARGUMENTS','CANCELLED','TIMEOUT','IO'])test('factory throw after invocation is unknown allocation, never code-derived nonallocation: '+code,async t=>{
  const f=await fixture(t),store=f.open(),p=proposal(store),token=store.reserveProposalWorker(p.id),fault=Object.assign(new Error('Controlled factory fault'),{code,dispatched:false});let calls=0;
  assert.equal(await rejected(store.invokeProposalWorker(token,async()=>{calls++;throw fault;})),fault);assert.equal(await rejected(store.closeProposalWorker(token)),fault);
  assert.throws(()=>store.recordProposalWorkerNotAllocated(token),/invoked proposal factory/);await assert.rejects(store.invokeProposalWorker(token,async()=>({close:async()=>{}})),/one-use/);assert.equal(calls,1);assert.equal(rows(f.file).length,0);assert.deepEqual(store.unclosedProposalIds(),[p.id]);
});

test('falsy factory rejections remain exact and can never be relabelled nonallocation',async t=>{
  for(const fault of [undefined,null,false,0])await t.test(String(fault),async t=>{const f=await fixture(t),store=f.open(),p=proposal(store),token=store.reserveProposalWorker(p.id);
    assert.equal(await rejected(store.invokeProposalWorker(token,async()=>{throw fault;})),fault);assert.equal(await rejected(store.closeProposalWorker(token)),fault);assert.throws(()=>store.recordProposalWorkerNotAllocated(token),/invoked proposal factory/);assert.deepEqual(store.proposalWorkerClosure(token),{settled:false,durable:false});assert.deepEqual(store.unclosedProposalIds(),[p.id]);
  });
});

test('physical close still runs when the journal was closed first; its marker fault stays separate',async t=>{
  const f=await fixture(t),store=f.open(),p=proposal(store),token=store.reserveProposalWorker(p.id);let calls=0;await store.invokeProposalWorker(token,async()=>({close:async()=>{calls++;}}));store.close();
  const failure=await rejected(store.closeProposalWorker(token));assert.match(String(failure),/journal is closed/);assert.equal(calls,1);assert.deepEqual(store.proposalWorkerClosure(token),{settled:true,durable:false});assert.deepEqual(f.open().unclosedProposalIds(),[p.id]);
});

test('actual SQLite INSERT refusal keeps settled cleanup and exact cached marker failure without certifying durability',async t=>{
  const f=await fixture(t),store=f.open(),p=proposal(store),token=store.reserveProposalWorker(p.id);let closes=0;await store.invokeProposalWorker(token,async()=>({close:async()=>{closes++;}}));
  const db=new DatabaseSync(sqliteTransportPath(f.file));db.exec("CREATE TRIGGER refuse_closure BEFORE INSERT ON chat_task_proposal_worker_closures BEGIN SELECT RAISE(ABORT,'controlled closure insert refusal');END");
  const closing=store.closeProposalWorker(token),fault=await rejected(closing);assert.match(String(fault),/controlled closure insert refusal/);assert.equal(await rejected(store.closeProposalWorker(token)),fault);assert.equal(closes,1);assert.deepEqual(store.proposalWorkerClosure(token),{settled:true,durable:false});assert.equal(rows(f.file).length,0);assert.deepEqual(store.unclosedProposalIds(),[p.id]);
  db.exec('DROP TRIGGER refuse_closure');db.close();store.close();assert.deepEqual(f.open().unclosedProposalIds(),[p.id]);
});

test('marker COMMIT faults preserve falsy errors and roll back the actual inserted SQLite row',async t=>{
  for(const fault of [undefined,null,false,0])await t.test(String(fault),async t=>{
    const f=await fixture(t),store=f.open(),p=proposal(store),token=store.reserveProposalWorker(p.id);let closes=0,armed=false,commits=0;
    await store.invokeProposalWorker(token,async()=>({close:async()=>{closes++;}}));const original=DatabaseSync.prototype.exec;
    t.mock.method(DatabaseSync.prototype,'exec',function(this:DatabaseSync,sql:string){if(armed&&sql==='COMMIT'){commits++;throw fault;}return original.call(this,sql);});armed=true;
    const tail=store.closeProposalWorker(token);assert.equal(await rejected(tail),fault);assert.equal(await rejected(store.closeProposalWorker(token)),fault);assert.equal(closes,1);assert.equal(commits,1);assert.deepEqual(store.proposalWorkerClosure(token),{settled:true,durable:false});assert.equal(rows(f.file).length,0);assert.deepEqual(store.unclosedProposalIds(),[p.id]);armed=false;
  });
});

test('nonallocation marker refusal seals invocation and retains the exact first error, including false',async t=>{
  const f=await fixture(t),store=f.open(),p=proposal(store),token=store.reserveProposalWorker(p.id),original=DatabaseSync.prototype.exec;let attempts=0;
  t.mock.method(DatabaseSync.prototype,'exec',function(this:DatabaseSync,sql:string){if(sql==='BEGIN IMMEDIATE'){attempts++;throw false;}return original.call(this,sql);});
  const attempt=()=>{let failed=false,fault:unknown;try{store.recordProposalWorkerNotAllocated(token);}catch(error){failed=true;fault=error;}assert.equal(failed,true);assert.equal(fault,false);};attempt();attempt();assert.equal(attempts,1);
  assert.deepEqual(store.proposalWorkerClosure(token),{settled:true,durable:false});await assert.rejects(store.invokeProposalWorker(token,async()=>({close:async()=>{}})),/one-use/);assert.equal(rows(f.file).length,0);assert.deepEqual(store.unclosedProposalIds(),[p.id]);
});

test('legacy terminal proposal and task labels are never backfilled as worker closure and proposal bytes remain exact',async t=>{
  const f=await fixture(t),store=f.open(),ids:string[]=[];
  for(const state of ['working','awaiting_verification','repair_queued','repairing','verified','failed','cancelled','paused','unknown'] as const){const owner=store.create(task(state));
    for(const outcome of ['proposed','failed','unknown'] as const){const p=proposal(store,owner.id);ids.push(p.id);store.settleProposal(p.id,outcome==='proposed'?{state:'proposed',result:{threadId:'worker',sessionId:null,turnId:'turn',text:'bounded',textBytes:7,textSha256:sha('bounded')}}:{state:outcome,reason:outcome==='failed'?'worker_unavailable':'dispatch_uncertain'});}}
  const before=rows(f.file,'chat_task_proposals');store.close();const db=new DatabaseSync(sqliteTransportPath(f.file));db.exec('DROP TABLE chat_task_proposal_worker_closures;PRAGMA user_version=4');db.close();
  const reopened=f.open();assert.deepEqual(reopened.unclosedProposalIds(),ids);assert.deepEqual(rows(f.file,'chat_task_proposals'),before);assert.equal(rows(f.file).length,0);for(const id of ids)assert.throws(()=>reopened.reserveProposalWorker(id),/this store lifetime/);
});

for(const tamper of ['fingerprint','project','request','proposal','task','extra','malformed'])test('invalid closure '+tamper+' is refused before any ownership, WAL or recovery write',async t=>{
  const f=await fixture(t),store=f.open(),p=proposal(store),token=store.reserveProposalWorker(p.id);store.recordProposalWorkerNotAllocated(token);store.close();
  const db=new DatabaseSync(sqliteTransportPath(f.file)),row=db.prepare('SELECT proposal_id,payload FROM chat_task_proposal_worker_closures').get()!,value=JSON.parse(row.payload as string) as Record<string,unknown>;
  if(tamper==='fingerprint')value.reservationFingerprint='f'.repeat(64);else if(tamper==='project')value.projectPath=f.projectPath+'-foreign';else if(tamper==='request')value.requestId=randomUUID();else if(tamper==='proposal')value.proposalId=randomUUID();else if(tamper==='task')value.taskId=randomUUID();else if(tamper==='extra')value.extra=true;
  assert.equal(typeof row.proposal_id,'string');
  db.prepare('UPDATE chat_task_proposal_worker_closures SET payload=? WHERE proposal_id=?').run(tamper==='malformed'?'{':JSON.stringify(value),row.proposal_id as string);db.exec('PRAGMA wal_checkpoint(TRUNCATE);PRAGMA journal_mode=DELETE;');db.close();
  const bytes=await readFile(f.file),names=await readdir(f.directory);assert.throws(()=>f.open(),/closure.*corrupt|closure lost/);assert.deepEqual(await readFile(f.file),bytes);assert.deepEqual(await readdir(f.directory),names);
});

test('host recovery fingerprints cover validated exact RAW task payload bytes and expose no payload or authority',async t=>{
  const f=await fixture(t),store=f.open(),owner=store.create(task()),db=new DatabaseSync(sqliteTransportPath(f.file));
  const raw=JSON.stringify(owner,null,2);db.prepare('UPDATE chat_tasks SET payload=? WHERE id=?').run(raw,owner.id);
  const proof=store.recoveryTaskFingerprints();assert.deepEqual(proof,[{id:owner.id,fingerprint:sha(owner.id+'\0'+raw)}]);assert.equal(Object.isFrozen(proof),true);assert.equal(Object.isFrozen(proof[0]),true);assert.deepEqual(Object.keys(proof[0]!).sort(),['fingerprint','id']);assert.notEqual(proof[0]!.fingerprint,sha(owner.id+'\0'+JSON.stringify(owner)));
  db.prepare('UPDATE chat_tasks SET payload=? WHERE id=?').run('{',owner.id);assert.throws(()=>store.recoveryTaskFingerprints(),/corrupt/);
  db.prepare('UPDATE chat_tasks SET payload=? WHERE id=?').run(raw,owner.id);db.exec('BEGIN IMMEDIATE');
  try{for(let index=0;index<256;index++){const extra={...owner,id:randomUUID()};db.prepare('INSERT INTO chat_tasks VALUES(?,?)').run(extra.id,JSON.stringify(extra));}db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
  assert.throws(()=>store.recoveryTaskFingerprints(),/retention exceeded/);db.close();
});
