import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire,syncBuiltinESMExports} from 'node:module';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute,sep} from 'node:path';
import {createNativeAssetRegistry,acquireNativeAssetWork,assertNativeAssetActor,assertNativeAssetWorkLease,
  claimNativeAssetStageOperation,type NativeAssetIncarnation,type NativeAssetActor,type NativeAssetWorkLease} from '../../apps/daemon/src/native-asset-authority.js';
const denied={code:'NATIVE_ASSET_AUTHORITY'};
const JOB='11111111-1111-4111-8111-111111111111';
function gate(){let release!:()=>void;const promise=new Promise<void>(accept=>{release=accept;});return {promise,release};}
function fixture(t:test.TestContext){
  const boundary=realpathSync(tmpdir()),projectPath=realpathSync(mkdtempSync(join(boundary,'arcane-work-leases-')));
  const registry=createNativeAssetRegistry({projectPath});let sequence=0;
  t.after(()=>{registry.close();const part=relative(boundary,projectPath);assert.ok(part.startsWith('arcane-work-leases-')&&!isAbsolute(part)&&!part.includes(sep));rmSync(projectPath,{recursive:true,force:true});});
  function ready(provider:'codex'|'claude-code'|'arcane'='codex'){
    const incarnation=registry.issue(),credential=incarnation.credential(),id=++sequence;
    const binding={connectionId:'connection-'+id,threadId:provider==='codex'?'thread-'+id:'app:'+JOB};
    if(provider==='codex')incarnation.seal({...binding,provider,sessionId:null});
    else if(provider==='claude-code')incarnation.bindAppConversation({kind:'app-conversation',connectionId:binding.connectionId,provider,conversationId:JOB,transport:{kind:'claude-code-process',incarnationId:'owned-process-'+id,nativeSessionId:null}});
    else incarnation.bindAppConversation({kind:'app-conversation',connectionId:binding.connectionId,provider,conversationId:JOB,transport:{kind:'arcane-gateway-loop',incarnationId:'owned-loop-'+id}});
    const operationId='intent-'+id;incarnation.grantNextIntent({...binding,sessionId:null});incarnation.dispatched({...binding,operationId});
    return {incarnation,credential,binding,operationId,actor:registry.capture(credential,'mutate')};
  }
  return {registry,ready};
}
// Real volatile registry with controlled ownership promises only. These tests
// neither launch a provider nor infer that a model/HTTP response closed a worker.
test('retirement needs actual transport closure even when no work was allocated',t=>{
  const f=fixture(t),owner=f.ready();owner.incarnation.ended(owner.operationId);owner.incarnation.retire();
  assert.equal(owner.incarnation.status().released,false);assert.equal(f.registry.recognizes(owner.credential),false);
  assert.throws(()=>f.registry.capture(owner.credential,'read'),denied);
  owner.incarnation.transportClosed();assert.equal(owner.incarnation.status().released,true);
  owner.incarnation.transportClosed();owner.incarnation.retire();assert.equal(owner.incarnation.status().released,true);
  assert.throws(()=>owner.incarnation.credential(),denied);assert.throws(()=>owner.incarnation.grant(owner.binding),denied);
});
for(const provider of ['claude-code','arcane'] as const)test(provider+' accepted pending work survives end/retirement and releases only after actual cleanup',async t=>{
  const f=fixture(t),owner=f.ready(provider),lease=acquireNativeAssetWork(owner.actor,'generation'),held=gate();
  const pending=lease.run(()=>held.promise);lease.finish('closed');
  owner.incarnation.ended(owner.operationId);owner.incarnation.retire();owner.incarnation.transportClosed();
  assert.equal(lease.signal.aborted,false);assert.equal(owner.incarnation.status().released,false);
  assert.throws(()=>assertNativeAssetActor(owner.actor,'mutate'),denied);
  held.release();await pending;assert.equal(owner.incarnation.status().released,true);
  const replacement=f.ready(provider),next=acquireNativeAssetWork(replacement.actor,'generation');
  owner.incarnation.cancelWork('incarnation');lease.finish('unresolved');
  assert.equal(next.signal.aborted,false);assert.equal(replacement.incarnation.status().released,false);
  assert.throws(()=>claimNativeAssetStageOperation(owner.actor,JOB),denied);next.finish('closed');
});
test('exact Stop selects the original operation or incarnation and never a foreign chat',async t=>{
  const f=fixture(t),owner=f.ready(),first=acquireNativeAssetWork(owner.actor,'generation'),held=gate();
  const pending=first.run(()=>held.promise);first.finish('closed');owner.incarnation.ended(owner.operationId);
  owner.incarnation.grantNextIntent({...owner.binding,sessionId:null});owner.incarnation.dispatched({...owner.binding,operationId:'later-intent'});
  const later=acquireNativeAssetWork(f.registry.capture(owner.credential,'mutate'),'stage'),foreignOwner=f.ready(),foreign=acquireNativeAssetWork(foreignOwner.actor,'generation');
  owner.incarnation.cancelWork('active-operation');assert.equal(later.signal.aborted,true);assert.equal(first.signal.aborted,false);assert.equal(foreign.signal.aborted,false);
  let startedAfterStop=false;assert.throws(()=>later.run(()=>{startedAfterStop=true;}),denied);assert.equal(startedAfterStop,false);
  owner.incarnation.retire();owner.incarnation.transportClosed();owner.incarnation.cancelWork('incarnation');
  assert.equal(first.signal.aborted,true);assert.equal(foreign.signal.aborted,false);assert.equal(owner.incarnation.status().released,false);
  later.finish('closed');held.release();await pending;assert.equal(owner.incarnation.status().released,true);foreign.finish('closed');
});
test('synchronous failed allocation drops only its own hold and duplicate cleanup cannot reopen it',t=>{
  const f=fixture(t),owner=f.ready(),lease=acquireNativeAssetWork(owner.actor,'generation');let calls=0;
  const failure=Error('Controlled pre-allocation failure.');
  assert.throws(()=>lease.run(()=>{calls++;throw failure;}),value=>value===failure);
  lease.finish('closed');lease.finish('closed');assert.equal(calls,1);
  assert.throws(()=>lease.run(()=>{calls++;}),denied);assert.equal(calls,1);
  owner.incarnation.retire();owner.incarnation.transportClosed();assert.equal(owner.incarnation.status().released,true);
});
test('an unresolved worker stays pinned after its promise settles and repeated closed labels cannot release it',async t=>{
  const f=fixture(t),owner=f.ready(),lease=acquireNativeAssetWork(owner.actor,'generation'),held=gate();
  const pending=lease.run(()=>held.promise);lease.finish('closed');owner.incarnation.retire();owner.incarnation.transportClosed();
  lease.finish('unresolved');held.release();await pending;lease.finish('closed');
  assert.equal(owner.incarnation.status().released,false);assert.equal(f.registry.recognizes(owner.credential),false);
});
test('128 genuinely draining incarnations refuse another without evicting accepted work',async t=>{
  const f=fixture(t),owners:{incarnation:NativeAssetIncarnation;lease:NativeAssetWorkLease;held:ReturnType<typeof gate>;pending:Promise<void>}[]=[];
  for(let index=0;index<128;index++){
    const owner=f.ready(),lease=acquireNativeAssetWork(owner.actor,'generation'),held=gate(),pending=lease.run(()=>held.promise);
    lease.finish('closed');owner.incarnation.retire();owner.incarnation.transportClosed();owners.push({incarnation:owner.incarnation,lease,held,pending});
  }
  assert.throws(()=>f.registry.issue(),denied);assert.equal(owners.every(owner=>!owner.incarnation.status().released&&!owner.lease.signal.aborted),true);
  owners[0]!.held.release();await owners[0]!.pending;assert.equal(owners[0]!.incarnation.status().released,true);
  const replacement=f.ready();assert.match(replacement.credential,/^[a-f0-9]{64}$/);
  for(const owner of owners.slice(1))owner.held.release();await Promise.all(owners.map(owner=>owner.pending));
  assert.equal(owners.every(owner=>owner.incarnation.status().released),true);
});
test('more than128 sequential owned transports reuse only quiescent slots and keep old credentials and actors retired',t=>{
  const f=fixture(t),old:{credential:string;actor:NativeAssetActor;incarnation:NativeAssetIncarnation}[]=[],tokens=new Set<string>();
  for(let index=0;index<260;index++){
    const owner=f.ready(index%2?'claude-code':'arcane');claimNativeAssetStageOperation(owner.actor,JOB);
    assert.equal(tokens.has(owner.credential),false);tokens.add(owner.credential);
    owner.incarnation.retire();owner.incarnation.transportClosed();assert.equal(owner.incarnation.status().released,true);old.push(owner);
  }
  const current=f.ready();for(const owner of old){
    assert.equal(f.registry.recognizes(owner.credential),false);assert.throws(()=>f.registry.capture(owner.credential,'read'),denied);
    assert.throws(()=>assertNativeAssetActor(owner.actor,'mutate'),denied);assert.throws(()=>claimNativeAssetStageOperation(owner.actor,JOB),denied);
    owner.incarnation.cancelWork('incarnation');owner.incarnation.retire();owner.incarnation.transportClosed();
  }
  assertNativeAssetActor(current.actor,'mutate');
});
test('a repeated random suffix cannot reissue a retired bearer and randomness failure consumes its prefix',t=>{
  const f=fixture(t),crypto=createRequire(import.meta.url)('node:crypto') as typeof import('node:crypto');
  const bad=t.mock.method(crypto,'randomBytes',()=>{throw Error('Controlled entropy failure.');});
  t.after(()=>{bad.mock.restore();syncBuiltinESMExports();});syncBuiltinESMExports();
  assert.throws(()=>f.registry.issue(),/Controlled entropy failure/);bad.mock.restore();
  const fixed=t.mock.method(crypto,'randomBytes',(size:number)=>Buffer.alloc(size,23));syncBuiltinESMExports();
  t.after(()=>{fixed.mock.restore();syncBuiltinESMExports();});
  const first=f.ready();assert.equal(first.credential.slice(0,16),'0000000000000001');
  first.incarnation.retire();first.incarnation.transportClosed();const second=f.ready();
  assert.equal(first.credential.slice(16),second.credential.slice(16));assert.notEqual(first.credential,second.credential);
  assert.equal(f.registry.recognizes(first.credential),false);assert.throws(()=>f.registry.capture(first.credential,'mutate'),denied);
  assertNativeAssetActor(second.actor,'mutate');
});
test('forged leases, borrowed methods and finished scopes cannot start factories or release another owner',t=>{
  const f=fixture(t),owner=f.ready(),lease=acquireNativeAssetWork(owner.actor,'preparation');let calls=0;
  const forged={...lease};assert.throws(()=>assertNativeAssetWorkLease(forged),denied);
  assert.throws(()=>lease.run.call(forged,()=>{calls++;}),denied);assert.throws(()=>lease.finish.call(forged,'closed'),denied);
  assert.throws(()=>acquireNativeAssetWork({kind:'native-asset-actor'},'generation'),denied);
  lease.finish('closed');assert.throws(()=>assertNativeAssetWorkLease(lease),denied);
  assert.throws(()=>lease.run(()=>{calls++;}),denied);assert.equal(calls,0);
  owner.incarnation.transportClosed();assert.equal(owner.incarnation.status().released,true);
});
test('lease and concurrent hold bounds refuse before running another factory',async t=>{
  const f=fixture(t),owner=f.ready(),leases=Array.from({length:128},()=>acquireNativeAssetWork(owner.actor,'preparation'));
  assert.throws(()=>acquireNativeAssetWork(owner.actor,'preparation'),denied);
  const held=gate(),first=leases[0]!,pending=Array.from({length:128},()=>first.run(()=>held.promise));let called=false;
  assert.throws(()=>first.run(()=>{called=true;}),denied);assert.equal(called,false);
  for(const lease of leases)lease.finish('closed');owner.incarnation.transportClosed();assert.equal(owner.incarnation.status().released,false);
  held.release();await Promise.all(pending);assert.equal(owner.incarnation.status().released,true);
});
