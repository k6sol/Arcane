import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createServer} from 'node:http';
import {studioRoutes} from '../../apps/daemon/src/studio-routes.js';
import {StudioStore,type StageRunIntent} from '../../packages/storage/src/studio-store.js';
import type {StudioAssetStageArgs,StudioAssetReconstructArgs} from '../../packages/protocol/src/studio.js';

// Real SQLite + production Store. Plugin ACKs/geometry here are synthetic; the
// companion Luau suite executes actual sealed packets and production mesh code.
const projectId='a'.repeat(64),jobId='11111111-1111-4111-8111-111111111111',guard=()=>{};
// Trusted synthetic model-only review port; the real human gate is exercised by asset-review-boundaries.test.ts.
const fixtureModelReview={reviewId:'99999999-9999-4999-8999-999999999999',subjectDigest:'9'.repeat(64),revision:1};
const bindFixtureReview=(value:StudioStore)=>value.bindAssetModelReview(intent=>{assert.deepEqual(intent.modelReview,fixtureModelReview);});
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
function fixture(t:test.TestContext){
  const directory=mkdtempSync(join(tmpdir(),'arcane-reconstruction-journal-'));let now=Date.now(),store=new StudioStore({directory,now:()=>now});bindFixtureReview(store);
  t.after(()=>{store.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));rmSync(directory,{recursive:true,force:true});});
  const grant=store.createGrant({allowedRoots:['Workspace','ServerStorage'],allowWrites:true});
  const paired=store.pair({code:grant.code,protocolVersion:1,capabilities:['asset.stage_packet','asset.reconstruct','scene.import_context'],identity:{clientSessionId:'fixture-client',placeId:12,universeId:34,name:'Fixture',pluginVersion:'0.1.9'}});
  store.poll(paired.sessionId,{sessionId:paired.sessionId,clientLifetimeId:'fixture-client',pluginArtifactHash:'b'.repeat(64),markerName:'ArcaneTestProof_fixture',placeId:12,universeId:34,placeName:'Fixture',mode:'Edit',playEpoch:0,continuitySupported:true,connected:true});
  const expected={digest:'c'.repeat(64),payloadDigest:'d'.repeat(64),manifestDigest:'e'.repeat(64)};
  const target:StudioAssetStageArgs['target']={sessionId:paired.sessionId,placeId:12,universeId:34,root:'Workspace',parentRef:'fixture-parent',creator:{kind:'group',id:'56'}};
  const continuity={clientLifetimeId:'fixture-client',pluginArtifactHash:'b'.repeat(64),playEpoch:0};
  const bodies=[{kind:'begin'},{kind:'object',object:{sourceObjectId:'fixture-mesh',meshExportSha256:'f'.repeat(64)},primitives:[{vertexCount:4,triangleCount:4}]},{kind:'seal'}];
  const args:StudioAssetStageArgs[]=bodies.map((body,ordinal)=>({expected,target,continuity,packet:JSON.stringify({formatVersion:1,payloadDigest:expected.payloadDigest,manifestDigest:expected.manifestDigest,ordinal,...body})}));
  let bytes=0;const intent:StageRunIntent={projectId,jobId,modelReview:fixtureModelReview,conversation:{provider:'codex',threadId:'fixture-thread',sessionId:null},transferDigest:expected.digest,payloadDigest:expected.payloadDigest,manifestDigest:expected.manifestDigest,preparedDigest:'1'.repeat(64),target,continuity,
    plan:args.map((a,ordinal)=>{const packetByteLength=Buffer.byteLength(a.packet);bytes+=packetByteLength;return {ordinal,argsSha256:sha(JSON.stringify(a)),packetByteLength,envelopeByteLength:Buffer.byteLength(JSON.stringify(a)),expectedReceipt:{transferDigest:expected.digest,packetCount:ordinal+1,byteLength:bytes,state:ordinal===2?'sealed':'receiving',engineVerification:'pending'}};})};
  const begun=store.beginStageRun(intent,guard);assert.ok(begun.created);
  for(const [i,a]of args.entries()){
    const c=store.enqueueStagePacket(begun.handle,i,a,guard);assert.equal(store.poll(paired.sessionId)[0]?.id,c.id);
    store.result({sessionId:paired.sessionId,commandId:c.id,state:'succeeded',result:intent.plan[i]!.expectedReceipt});
  }
  store.closeStageRun(begun.handle);
  const expectedReceipt=(commandId:string)=>{
    const a=store.command(commandId).args as unknown as StudioAssetReconstructArgs;
    return {runId:a.runId,transferDigest:a.expected.digest,state:'reconstructed',objects:a.objects,imported:false,engineVerification:'pending'};
  };
  return {directory,paired,runId:begun.runId,get store(){return store;},advance(ms:number){now+=ms;},observation(){
    const {observedAt,expiresAt,...proof}=store.session(paired.sessionId).proof!;return proof;
  },enqueue:(check=guard)=>store.enqueueStageReconstruction(projectId,jobId,begun.runId,check),
    expectedReceipt,restart(){store.close();store=new StudioStore({directory,now:()=>now});}};
}

test('one original-run association derives exact sources; generic JSON and boolean guards cannot admit it',t=>{
  const f=fixture(t);
  assert.throws(()=>f.enqueue(()=>true),{code:'STUDIO_STAGE_GUARD'});
  const c=f.enqueue(),a=c.args as unknown as StudioAssetReconstructArgs;
  assert.deepEqual(a.objects,[{sourceObjectId:'fixture-mesh',meshExportSha256:'f'.repeat(64),vertexCount:4,triangleCount:4}]);
  assert.equal(a.runId,f.runId);assert.equal(f.enqueue().id,c.id);
  assert.throws(()=>f.store.enqueue({sessionId:c.sessionId,requestId:c.requestId,method:c.method,args:c.args}),{code:'ASSET_STAGE_AUTHORITY'});
  assert.throws(()=>f.store.enqueueStageReconstruction(projectId,'22222222-2222-4222-8222-222222222222',f.runId,guard),{code:'STUDIO_STAGE_NOT_FOUND'});
  assert.equal(f.store.commands().filter(x=>x.method==='asset.reconstruct').length,1);
});

test('real SQLite association failure rolls back allocation command and permanently spends uncertain local admission',t=>{
  const f=fixture(t),db=new DatabaseSync(join(f.directory,'studio.sqlite'));
  try{
    db.exec("CREATE TRIGGER fixture_reconstruct_failure BEFORE INSERT ON asset_stage_reconstructions BEGIN SELECT RAISE(ABORT,'fixture failure'); END;");
    assert.throws(()=>f.enqueue(),/fixture failure/);assert.equal(f.store.commands().filter(x=>x.method==='asset.reconstruct').length,0);
    assert.equal(f.store.readStageReconstruction(projectId,jobId,f.runId),null);db.exec('DROP TRIGGER fixture_reconstruct_failure');
    assert.throws(()=>f.enqueue(),{code:'STUDIO_RECONSTRUCT_EXISTS'});
  }finally{db.close();}
});

test('scope retirement at the transaction boundary rolls back both records without minting another permit',t=>{
  const f=fixture(t);
  assert.throws(()=>f.enqueue(()=>{if(f.store.commands().some(c=>c.method==='asset.reconstruct'))throw Error('retired');}),/retired/);
  assert.equal(f.store.readStageReconstruction(projectId,jobId,f.runId),null);
  assert.throws(()=>f.enqueue(),{code:'STUDIO_RECONSTRUCT_EXISTS'});
});

for(const dispatched of [false,true])test('restart retains '+(dispatched?'unknown dispatched':'cancelled queued')+' reconstruction without a second command',t=>{
  const f=fixture(t),c=f.enqueue();if(dispatched)assert.equal(f.store.poll(f.paired.sessionId)[0]?.id,c.id);
  f.restart();const record=f.store.readStageReconstruction(projectId,jobId,f.runId)!;
  assert.equal(record.command.id,c.id);assert.equal(record.command.state,dispatched?'needs_reconciliation':'cancelled');assert.equal(record.receipt,null);
  assert.throws(()=>f.enqueue(),{code:'REVOKED'});assert.equal(f.store.commands().filter(x=>x.method==='asset.reconstruct').length,1);
});

test('receipt must exactly match original source counts and can never claim imported or native verification',t=>{
  const f=fixture(t),c=f.enqueue();f.store.poll(f.paired.sessionId);const receipt=f.expectedReceipt(c.id);
  for(const patch of [{imported:true},{engineVerification:'verified'},{runId:jobId},{objects:[{...receipt.objects[0]!,triangleCount:5}]},{editableMesh:{}}]){
    assert.throws(()=>f.store.result({sessionId:c.sessionId,commandId:c.id,state:'succeeded',result:{...receipt,...patch}}),{code:'RECEIPT'});
  }
  assert.equal(f.store.command(c.id).state,'dispatched');
  f.store.result({sessionId:c.sessionId,commandId:c.id,state:'succeeded',result:receipt});
  f.store.abandonStageReconstruction(projectId,jobId,f.runId);f.restart();
  assert.deepEqual(f.store.readStageReconstruction(projectId,jobId,f.runId)?.receipt,receipt);
  assert.throws(()=>f.store.restore({commandId:c.id,requestId:'fixture_restore_reconstructed'}),{code:'RESTORE'});
});

test('exact in-flight progress keeps real proof fresh beyond six seconds without a new lease or queue dispatch',t=>{
  const f=fixture(t),c=f.enqueue();assert.equal(f.store.poll(c.sessionId)[0]?.id,c.id);
  const originalLease=f.store.command(c.id).expiresAt;
  // Queue a read behind the reconstruction. Progress is NOT permission to pull it.
  const next=f.store.enqueue({sessionId:c.sessionId,requestId:'fixture_queued_after_reconstruction',method:'scene.import_context',args:{}});
  for(let step=0;step<10;step++){
    f.advance(2000);assert.deepEqual(f.store.poll(c.sessionId,f.observation(),{commandId:c.id,leaseEpoch:c.leaseEpoch}),[]);
    const proof=f.store.session(c.sessionId).proof!;assert.equal(Date.parse(proof.expiresAt)-Date.parse(proof.observedAt),6000);
    assert.equal(f.store.command(c.id).expiresAt,originalLease);assert.equal(f.store.command(c.id).state,'dispatched');assert.equal(f.store.command(next.id).state,'queued');
  }
  assert.equal(f.store.readStageReconstruction(projectId,jobId,f.runId)?.command.id,c.id);
});

test('wrong command/lease, changed epoch and missing proof cannot renew in-flight authority',t=>{
  const f=fixture(t),c=f.enqueue();f.store.poll(c.sessionId);f.advance(2000);const originalSession=f.store.session(c.sessionId),original=originalSession.proof!;
  for(const [identity,observation]of [
    [{commandId:jobId,leaseEpoch:c.leaseEpoch},f.observation()],
    [{commandId:c.id,leaseEpoch:c.leaseEpoch+1},f.observation()],
    [{commandId:c.id,leaseEpoch:c.leaseEpoch,permission:true},f.observation()],
    [{commandId:c.id,leaseEpoch:c.leaseEpoch},{...f.observation(),playEpoch:1}],
    [{commandId:c.id,leaseEpoch:c.leaseEpoch},{...f.observation(),clientLifetimeId:'different-life'}],
    [{commandId:c.id,leaseEpoch:c.leaseEpoch},{...f.observation(),pluginArtifactHash:'0'.repeat(64)}],
    [{commandId:c.id,leaseEpoch:c.leaseEpoch},undefined],
  ]){
    assert.throws(()=>f.store.poll(c.sessionId,observation,identity));assert.deepEqual(f.store.session(c.sessionId),originalSession,'denial rolls back proof AND lastSeenAt');
  }
  f.advance(4001);assert.throws(()=>f.store.poll(c.sessionId,f.observation(),{commandId:c.id,leaseEpoch:c.leaseEpoch}),{code:'COMMAND_STATE'});
  assert.deepEqual(f.store.session(c.sessionId).proof,original,'an expired proof cannot be revived by progress');
});

test('queued and unknown reconstructions cannot renew proof or dispatch a later command',t=>{
  const f=fixture(t),c=f.enqueue(),before=f.store.session(c.sessionId);f.advance(1000);
  assert.throws(()=>f.store.poll(c.sessionId,f.observation(),{commandId:c.id,leaseEpoch:c.leaseEpoch}),{code:'COMMAND_STATE'});
  assert.deepEqual(f.store.session(c.sessionId),before);assert.equal(f.store.command(c.id).state,'queued');
  f.store.poll(c.sessionId);f.store.abandonStageReconstruction(projectId,jobId,f.runId);const unknown=f.store.session(c.sessionId);f.advance(1000);
  assert.throws(()=>f.store.poll(c.sessionId,f.observation(),{commandId:c.id,leaseEpoch:c.leaseEpoch}),{code:'COMMAND_STATE'});
  assert.deepEqual(f.store.session(c.sessionId),unknown);assert.equal(f.store.command(c.id).state,'needs_reconciliation');
});

test('terminal reconstruction and original command expiry cannot use progress to dispatch queued work',t=>{
  const f=fixture(t),c=f.enqueue();f.store.poll(c.sessionId);
  f.store.result({sessionId:c.sessionId,commandId:c.id,state:'succeeded',result:f.expectedReceipt(c.id)});
  const next=f.store.enqueue({sessionId:c.sessionId,requestId:'fixture_read_after_complete',method:'scene.import_context',args:{}}),proof=f.store.session(c.sessionId).proof!;
  f.advance(1000);assert.throws(()=>f.store.poll(c.sessionId,f.observation(),{commandId:c.id,leaseEpoch:c.leaseEpoch}),{code:'COMMAND_STATE'});
  assert.equal(f.store.command(next.id).state,'queued');assert.deepEqual(f.store.session(c.sessionId).proof,proof);
  const g=fixture(t),running=g.enqueue();g.store.poll(running.sessionId);
  for(let step=0;step<89;step++){g.advance(2000);g.store.poll(running.sessionId,g.observation(),{commandId:running.id,leaseEpoch:running.leaseEpoch});}
  const before=g.store.session(running.sessionId).proof!;g.advance(3000);
  assert.throws(()=>g.store.poll(running.sessionId,g.observation(),{commandId:running.id,leaseEpoch:running.leaseEpoch}),{code:'COMMAND_STATE'});
  assert.deepEqual(g.store.session(running.sessionId).proof,before,'fresh proof never extends the original allocation lease');
});

test('authenticated plugin poll carries exact no-new-work progress through the actual HTTP route',async t=>{
  const f=fixture(t),c=f.enqueue();f.store.poll(c.sessionId);let origin='';
  const route=studioRoutes(f.store,f.directory),server=createServer((request,response)=>{
    void route(request,response,new URL(request.url??'/',origin),'synthetic-human-control',origin).then(handled=>{if(!handled){response.writeHead(404);response.end('{}');}});
  });
  await new Promise<void>((accept,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',accept);});
  const address=server.address();assert.ok(address&&typeof address!=='string');origin='http://127.0.0.1:'+address.port;
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(accept=>server.close(()=>accept()));});
  const send=(token=f.paired.token,commandId=c.id)=>fetch(origin+'/v1/plugin/poll',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},
    body:JSON.stringify({sessionId:c.sessionId,observation:f.observation(),executingCommand:{commandId,leaseEpoch:c.leaseEpoch}})});
  f.advance(2000);const before=f.store.session(c.sessionId).proof!;
  assert.equal((await send('synthetic-wrong-token')).status,401);assert.deepEqual(f.store.session(c.sessionId).proof,before);
  assert.equal((await send(f.paired.token,jobId)).status,400);assert.deepEqual(f.store.session(c.sessionId).proof,before);
  for(let step=0;step<8;step++){
    const response=await send();assert.equal(response.status,200);
    const body=await response.json() as {commands:unknown[];progress:{commandId:string;leaseEpoch:number;observedAt:string;expiresAt:string}};
    assert.deepEqual(body.commands,[]);assert.equal(body.progress.commandId,c.id);assert.equal(body.progress.leaseEpoch,c.leaseEpoch);
    assert.equal(Date.parse(body.progress.expiresAt)-Date.parse(body.progress.observedAt),6000);f.advance(2000);
  }
  assert.equal(f.store.command(c.id).state,'dispatched');assert.ok(Date.parse(f.store.session(c.sessionId).proof!.expiresAt)>Date.parse(before.expiresAt)+6000);
});
