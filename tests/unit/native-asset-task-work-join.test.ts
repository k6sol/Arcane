import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute,sep} from 'node:path';
import {createNativeAssetRegistry,acquireNativeAssetWork,assertNativeAssetActor} from '../../apps/daemon/src/native-asset-authority.js';

// Actual registry and original guarded filesystem callbacks; transportClosed
// below is a controlled host signal, not proof of a provider or Studio process.
function gate(){let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return{promise,resolve};}
const denied={code:'NATIVE_ASSET_AUTHORITY'};
async function fixture(t:test.TestContext){
  const boundary=await realpath(tmpdir()),root=await realpath(await mkdtemp(join(boundary,'arcane-task-asset-join-')));
  const registry=createNativeAssetRegistry({projectPath:root});let count=0;
  t.after(async()=>{registry.close();const part=relative(boundary,root);assert.ok(part.startsWith('arcane-task-asset-join-')&&!isAbsolute(part)&&!part.includes(sep));await rm(root,{recursive:true,force:true});});
  const own=()=>{
    const incarnation=registry.issue(),credential=incarnation.credential(),id=++count,binding={connectionId:'connection-'+id,threadId:'thread-'+id};
    incarnation.seal({...binding,provider:'codex',sessionId:null});incarnation.grantNextIntent({...binding,sessionId:null});
    const operationId='operation-'+id;incarnation.dispatched({...binding,operationId});
    return{incarnation,credential,binding,operationId,actor:registry.capture(credential,'mutate')};
  };
  return{root,registry,own};
}

test('normal admission fence preserves actual original actor guards through accepted read/write/finally tails',async t=>{
  const f=await fixture(t),owner=f.own(),lease=acquireNativeAssetWork(owner.actor,'generation'),held=gate(),entered=gate();
  await writeFile(join(f.root,'source.txt'),'original bytes');let written=false,joined=false;
  const accepted=lease.run(async()=>{
    assertNativeAssetActor(owner.actor,'mutate');const bytes=await readFile(join(f.root,'source.txt'));assertNativeAssetActor(owner.actor,'mutate');
    entered.resolve();await held.promise;assertNativeAssetActor(owner.actor,'mutate');
    await writeFile(join(f.root,'published.txt'),bytes,{flag:'wx'});assertNativeAssetActor(owner.actor,'mutate');written=true;
  });await entered.promise;
  const normal=owner.incarnation.retireAndJoinWork();void normal.then(()=>{joined=true;});
  assert.equal(owner.incarnation.retireAndJoinWork(),normal);assert.equal(lease.signal.aborted,false);assert.equal(joined,false);
  assert.equal(f.registry.recognizes(owner.credential),false);assert.throws(()=>f.registry.capture(owner.credential,'read'),denied);
  assert.throws(()=>acquireNativeAssetWork(owner.actor,'preparation'),denied);
  assert.throws(()=>owner.incarnation.grant(owner.binding),denied);
  assert.throws(()=>owner.incarnation.dispatched({...owner.binding,operationId:'new-dispatch'}),denied);
  assertNativeAssetActor(owner.actor,'mutate');assert.equal(owner.incarnation.status().retired,false);
  held.resolve();await accepted;assert.equal(written,true);assert.equal(joined,false,'run completion does not invent the original host finish.');
  lease.finish('closed');await normal;assert.equal(await readFile(join(f.root,'published.txt'),'utf8'),'original bytes');
  assert.equal(owner.incarnation.status().retired,true);assert.equal(owner.incarnation.status().released,false);
  owner.incarnation.transportClosed();assert.equal(owner.incarnation.status().released,true);
  assert.throws(()=>assertNativeAssetActor(owner.actor,'mutate'),denied);
});

test('a real ended scope still invalidates acquired guards during normal joining',async t=>{
  const f=await fixture(t),owner=f.own(),lease=acquireNativeAssetWork(owner.actor,'preparation'),held=gate();
  const pending=lease.run(async()=>{await held.promise;assertNativeAssetActor(owner.actor,'mutate');});
  const normal=owner.incarnation.retireAndJoinWork();owner.incarnation.ended(owner.operationId);held.resolve();
  await assert.rejects(pending,denied);lease.finish('closed');await normal;
  assert.equal(lease.signal.aborted,false);assert.equal(owner.incarnation.status().released,false);
});

test('explicit Stop remains immediate after the normal admission fence and excludes another original chat',async t=>{
  const f=await fixture(t),owner=f.own(),foreign=f.own(),lease=acquireNativeAssetWork(owner.actor,'generation'),other=acquireNativeAssetWork(foreign.actor,'generation'),held=gate();
  const pending=lease.run(()=>held.promise),normal=owner.incarnation.retireAndJoinWork();let done=false;void normal.then(()=>{done=true;});
  owner.incarnation.cancelWork('incarnation');assert.equal(lease.signal.aborted,true);assert.equal(other.signal.aborted,false);assert.equal(done,false);
  assert.throws(()=>assertNativeAssetActor(owner.actor,'mutate'),denied);assertNativeAssetActor(foreign.actor,'mutate');
  held.resolve();await pending;lease.finish('closed');await normal;other.finish('closed');
  assert.equal(owner.incarnation.status().released,false);owner.incarnation.transportClosed();assert.equal(owner.incarnation.status().released,true);
});

test('unfinished work and sticky unresolved outcomes never become normal or reusable through labels',async t=>{
  const f=await fixture(t),owner=f.own(),lease=acquireNativeAssetWork(owner.actor,'revision');
  const normal=owner.incarnation.retireAndJoinWork();let settled=false;void normal.then(()=>{settled=true;},()=>{settled=true;});
  assert.equal(settled,false);lease.finish('unresolved');
  await assert.rejects(normal,{code:'NATIVE_ASSET_UNRESOLVED'});assert.equal(owner.incarnation.retireAndJoinWork(),normal);
  lease.finish('closed');owner.incarnation.transportClosed();assert.equal(owner.incarnation.status().released,false);
  await assert.rejects(owner.incarnation.retireAndJoinWork(),{code:'NATIVE_ASSET_UNRESOLVED'});
});

test('finish closed does not release an accepted late finally tail before its original promise',async t=>{
  const f=await fixture(t),owner=f.own(),lease=acquireNativeAssetWork(owner.actor,'generation'),body=gate(),final=gate(),entered=gate();
  const run=lease.run(async()=>{try{await body.promise;}finally{entered.resolve();await final.promise;}});lease.finish('closed');
  const normal=owner.incarnation.retireAndJoinWork();let joined=false;void normal.then(()=>{joined=true;});
  body.resolve();await entered.promise;assert.equal(joined,false);assert.equal(lease.signal.aborted,false);
  final.resolve();await run;await normal;assert.equal(owner.incarnation.status().released,false);
});

test('closed successes fold without turning the simultaneous lease limit into an unbounded history',async t=>{
  const f=await fixture(t),owner=f.own();
  for(let i=0;i<260;i++){const lease=acquireNativeAssetWork(owner.actor,'preparation');await lease.run(async()=>{assertNativeAssetActor(owner.actor,'mutate');});lease.finish('closed');}
  await owner.incarnation.retireAndJoinWork();assert.equal(owner.incarnation.status().released,false);
  owner.incarnation.transportClosed();assert.equal(owner.incarnation.status().released,true);
  assertNativeAssetActor(f.own().actor,'mutate');
});

test('the unchanged simultaneous lease bound stays closed during normal joining',async t=>{
  const f=await fixture(t),owner=f.own(),leases=Array.from({length:128},()=>acquireNativeAssetWork(owner.actor,'preparation'));
  assert.throws(()=>acquireNativeAssetWork(owner.actor,'preparation'),denied);const normal=owner.incarnation.retireAndJoinWork();
  for(const lease of leases){assert.equal(lease.signal.aborted,false);lease.finish('closed');}await normal;
  assert.equal(owner.incarnation.status().released,false);owner.incarnation.transportClosed();assert.equal(owner.incarnation.status().released,true);
});
