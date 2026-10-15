import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {StudioStore,type StageRunIntent} from '../../packages/storage/src/studio-store.js';
import type {StudioAssetStageArgs,Json} from '../../packages/protocol/src/studio.js';

// Real temporary SQLite stores; all plugin identities/ACKs are synthetic.
const projectId='a'.repeat(64),jobId='11111111-1111-4111-8111-111111111111',guard=()=>{};
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
function fixture(t:test.TestContext,count=2){
  const directory=mkdtempSync(join(tmpdir(),'arcane-stage-journal-')),now=Date.now();
  let store=new StudioStore({directory,now:()=>now});
  t.after(()=>{store.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));rmSync(directory,{recursive:true,force:true});});
  const grant=store.createGrant({allowedRoots:['Workspace','ServerStorage'],allowWrites:true});
  const pair=store.pair({code:grant.code,protocolVersion:1,capabilities:['asset.stage_packet'],identity:{clientSessionId:'fixture-client',placeId:12,universeId:34,name:'Fixture',pluginVersion:'0.1.7'}});
  store.poll(pair.sessionId,{sessionId:pair.sessionId,clientLifetimeId:'fixture-client',pluginArtifactHash:'b'.repeat(64),markerName:'ArcaneTestProof_fixture',placeId:12,universeId:34,placeName:'Fixture',mode:'Edit',playEpoch:0,continuitySupported:true,connected:true});
  const expected={digest:'c'.repeat(64),payloadDigest:'d'.repeat(64),manifestDigest:'e'.repeat(64)};
  const target:StudioAssetStageArgs['target']={sessionId:pair.sessionId,placeId:12,universeId:34,root:'Workspace',parentRef:'fixture-parent',creator:{kind:'group',id:'56'}};
  const continuity={clientLifetimeId:'fixture-client',pluginArtifactHash:'b'.repeat(64),playEpoch:0};
  const args:StudioAssetStageArgs[]=Array.from({length:count},(_,ordinal)=>({expected,packet:JSON.stringify({formatVersion:1,payloadDigest:expected.payloadDigest,manifestDigest:expected.manifestDigest,ordinal,kind:ordinal===count-1?'seal':ordinal===0?'begin':'object'}),target,continuity}));
  let bytes=0;
  const intent:StageRunIntent={projectId,jobId,conversation:{provider:'codex',threadId:'fixture-thread',sessionId:null},transferDigest:expected.digest,payloadDigest:expected.payloadDigest,manifestDigest:expected.manifestDigest,preparedDigest:'f'.repeat(64),target,continuity,
    plan:args.map((a,ordinal)=>{const packetByteLength=Buffer.byteLength(a.packet);bytes+=packetByteLength;return {ordinal,argsSha256:sha(JSON.stringify(a)),packetByteLength,envelopeByteLength:Buffer.byteLength(JSON.stringify(a)),expectedReceipt:{transferDigest:expected.digest,packetCount:ordinal+1,byteLength:bytes,state:ordinal===count-1?'sealed':'receiving',engineVerification:'pending'}};})};
  return {directory,pair,args,intent,get store(){return store;},restart(){store.close();store=new StudioStore({directory,now:()=>now});},
    ack(id:string,ordinal:number){assert.equal(store.poll(pair.sessionId)[0]?.id,id);store.result({sessionId:pair.sessionId,commandId:id,state:'succeeded',result:intent.plan[ordinal]!.expectedReceipt as unknown as Json});}};
}
test('begin is durable before commands, unique per project/job and returns detached evidence',t=>{
  const f=fixture(t),started=f.store.beginStageRun(f.intent,guard);assert.equal(started.created,true);
  assert.equal(started.record.commands.length,0);assert.equal(started.record.phase,'running');
  assert.equal(f.store.commands().length,0);started.record.intent.target.parentRef='changed';
  assert.equal(f.store.readStageRun(projectId,jobId)!.intent.target.parentRef,'fixture-parent');
  const same=f.store.beginStageRun(f.intent,guard);assert.equal(same.created,false);assert.equal(same.handle,null);assert.equal(same.runId,started.runId);
  assert.throws(()=>f.store.beginStageRun({...f.intent,preparedDigest:'0'.repeat(64)},guard),{code:'STUDIO_STAGE_CONFLICT'});
});

test('async and generator guards are refused before running and rejected Promise wrappers grant nothing',async t=>{
  const f=fixture(t);let calls=0;
  const asyncGuard=async()=>{calls++;throw Error('This guard must never execute.');};
  const generatorGuard=function*(){calls++;};
  for(const candidate of [asyncGuard,generatorGuard])assert.throws(()=>f.store.beginStageRun(f.intent,candidate),{code:'STUDIO_STAGE_GUARD'});
  assert.equal(calls,0);
  assert.throws(()=>f.store.beginStageRun(f.intent,()=>Promise.reject(Error('Unexpected deferred guard.'))),{code:'STUDIO_STAGE_GUARD'});
  await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(f.store.readStageRun(projectId,jobId),null);assert.equal(f.store.commands().length,0);
});
test('queue and association rollback together on a real SQLite insert failure',t=>{
  const f=fixture(t),started=f.store.beginStageRun(f.intent,guard);assert.ok(started.created);
  const db=new DatabaseSync(join(f.directory,'studio.sqlite'));
  try{
    db.exec("CREATE TRIGGER fixture_stage_failure BEFORE INSERT ON asset_stage_commands BEGIN SELECT RAISE(ABORT,'fixture fault'); END;");
    assert.throws(()=>f.store.enqueueStagePacket(started.handle,0,f.args[0]!,guard),/fixture fault/);
    assert.equal(f.store.commands().length,0);assert.equal(f.store.readStageRun(projectId,jobId)!.commands.length,0);
    assert.equal((db.prepare('SELECT epoch FROM sessions WHERE id=?').get(f.pair.sessionId) as {epoch:number}).epoch,0);
    db.exec('DROP TRIGGER fixture_stage_failure');
    const c=f.store.enqueueStagePacket(started.handle,0,f.args[0]!,guard);assert.equal(c.leaseEpoch,1);
    assert.equal(f.store.enqueueStagePacket(started.handle,0,f.args[0]!,guard).id,c.id);
  }finally{db.close();}
});
test('scope retirement after insertion rolls back command, association and lease in one transaction',t=>{
  const f=fixture(t),started=f.store.beginStageRun(f.intent,guard);assert.ok(started.created);let checks=0;
  assert.throws(()=>f.store.enqueueStagePacket(started.handle,0,f.args[0]!,()=>{if(++checks===3)throw Error('retired');}),/retired/);
  assert.equal(f.store.commands().length,0);assert.equal(f.store.readStageRun(projectId,jobId)!.commands.length,0);
});
test('only all original cumulative receipts establish CPU staging, including beyond display limits',t=>{
  const f=fixture(t,101),started=f.store.beginStageRun(f.intent,guard);assert.ok(started.created);
  assert.throws(()=>f.store.enqueueStagePacket(started.handle,1,f.args[1]!,guard),{code:'STUDIO_STAGE_STATE'});
  for(let ordinal=0;ordinal<f.args.length;ordinal++){
    const c=f.store.enqueueStagePacket(started.handle,ordinal,f.args[ordinal]!,guard);f.ack(c.id,ordinal);
    if(ordinal===0)assert.equal(f.store.readStageRun(projectId,jobId)!.receipt,null);
  }
  const result=f.store.closeStageRun(started.handle);assert.equal(result.phase,'cpu-staged');assert.equal(result.commands.length,101);
  assert.deepEqual(result.receipt,f.intent.plan.at(-1)!.expectedReceipt);assert.equal(result.receipt!.engineVerification,'pending');
  f.restart();assert.equal(f.store.readStageRun(projectId,jobId)!.phase,'cpu-staged');assert.equal(f.store.readStageRun(projectId,jobId)!.commands.length,101);
});
for(const dispatched of [false,true])test('restart retains original '+(dispatched?'dispatched unknown':'queued')+' association without replay',t=>{
  const f=fixture(t),started=f.store.beginStageRun(f.intent,guard);assert.ok(started.created);
  const c=f.store.enqueueStagePacket(started.handle,0,f.args[0]!,guard);if(dispatched)f.store.poll(f.pair.sessionId);
  f.restart();const record=f.store.readStageRun(projectId,jobId)!;
  assert.equal(record.commands[0]!.commandId,c.id);assert.equal(record.commands[0]!.command.state,dispatched?'needs_reconciliation':'cancelled');
  assert.equal(record.phase,dispatched?'needs_reconciliation':'stopped');assert.equal(record.receipt,null);
  assert.equal(f.store.beginStageRun(f.intent,guard).created,false);
  assert.throws(()=>f.store.enqueueStagePacket(started.handle,0,f.args[0]!,guard),{code:'STUDIO_STAGE_HANDLE'});
  assert.equal(f.store.commands().length,1);
});
test('forged handles, changed pins and malformed digests never create journal commands',t=>{
  const f=fixture(t),started=f.store.beginStageRun(f.intent,guard);assert.ok(started.created);
  assert.throws(()=>f.store.enqueueStagePacket({kind:'studio-stage-run-handle'},0,f.args[0]!,guard),{code:'STUDIO_STAGE_HANDLE'});
  assert.throws(()=>f.store.enqueueStagePacket(started.handle,0,{...f.args[0]!,target:{...f.intent.target,parentRef:'other'}},guard),{code:'STUDIO_STAGE_CONFLICT'});
  for(const patch of [{projectId:projectId+'\n'},{jobId:jobId+'\n'},{jobId:jobId.toUpperCase().replace('1','A')},{transferDigest:'c'.repeat(64)+'\n'}])assert.throws(()=>f.store.beginStageRun({...f.intent,...patch},guard),{code:'STUDIO_STAGE_INPUT'});
  let reads=0;const value={...f.intent};Object.defineProperty(value,'target',{enumerable:true,get(){reads++;return f.intent.target;}});
  assert.throws(()=>f.store.beginStageRun(value,guard),{code:'STUDIO_STAGE_INPUT'});assert.equal(reads,0);
  assert.equal(f.store.commands().length,0);
});
test('caps reject 513 ordinals, over-8-MiB plans and over-256-KiB actual argument envelopes',t=>{
  const f=fixture(t),started=f.store.beginStageRun(f.intent,guard);assert.ok(started.created);
  assert.throws(()=>f.store.beginStageRun({...f.intent,plan:Array(513).fill(f.intent.plan[0])},guard),{code:'STUDIO_STAGE_BUDGET'});
  const big=fixture(t,33);for(const p of big.intent.plan)p.envelopeByteLength=256*1024;
  assert.throws(()=>big.store.beginStageRun(big.intent,guard),{code:'STUDIO_STAGE_BUDGET'});
  assert.throws(()=>f.store.enqueueStagePacket(started.handle,0,{...f.args[0]!,packet:'x'.repeat(256*1024)},guard),{code:'STUDIO_STAGE_BUDGET'});
});
test('bad cumulative original ACK remains reconciliation evidence, never a sealed CPU claim',t=>{
  const f=fixture(t),started=f.store.beginStageRun(f.intent,guard);assert.ok(started.created);
  const c=f.store.enqueueStagePacket(started.handle,0,f.args[0]!,guard);f.store.poll(f.pair.sessionId);
  f.store.result({sessionId:f.pair.sessionId,commandId:c.id,state:'succeeded',result:{...f.intent.plan[0]!.expectedReceipt,byteLength:f.intent.plan[0]!.expectedReceipt.byteLength+1}});
  const read=f.store.readStageRun(projectId,jobId)!;assert.equal(read.phase,'needs_reconciliation');assert.equal(read.receipt,null);assert.equal(read.commands[0]!.commandId,c.id);
  assert.throws(()=>f.store.enqueueStagePacket(started.handle,1,f.args[1]!,guard),{code:'STUDIO_STAGE_STATE'});
  assert.equal(f.store.closeStageRun(started.handle).phase,'needs_reconciliation');
});
