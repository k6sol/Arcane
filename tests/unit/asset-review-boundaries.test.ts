import test from 'node:test';
import assert from 'node:assert/strict';
import {REVIEW_JOB,reviewBoundaryFixture,reviewRefused} from '../helpers/asset-review-boundary-fixture.js';
import type {InstanceRef} from '../../packages/protocol/src/studio.js';

test('actual staging controller denies missing authority and pending human review before any effect is queued',async t=>{
  for(const serviceGate of [false,true]){
    const f=await reviewBoundaryFixture(t,{serviceGate});
    await assert.rejects(f.stage(),reviewRefused('ASSET_REVIEW_REQUIRED'));
    assert.equal(f.studio.commands().length,0);
    assert.equal(f.studio.readStageRun(f.scope.projectId,REVIEW_JOB),null);
  }
});

test('approved stage intent retains the exact human revision and unchanged native actor/target guards',async t=>{
  const f=await reviewBoundaryFixture(t),approved=await f.approve(),result=await f.stage();
  const run=f.studio.readStageRun(f.scope.projectId,REVIEW_JOB);assert.ok(run);
  assert.deepEqual(run.intent.modelReview,{reviewId:approved.review.reviewId,subjectDigest:approved.review.subjectDigest,revision:approved.review.revision});
  assert.equal(run.runId,result.runId);assert.equal(run.receipt?.state,'sealed');assert.equal(result.imported,false);
  f.retireActor();await assert.rejects(f.reconstruct(),reviewRefused('NATIVE_ASSET_AUTHORITY'));
  f.newActor();f.changePlayEpoch();await assert.rejects(f.reconstruct(),reviewRefused('STUDIO_STAGE_CONTINUITY'));
  assert.equal(f.delivered.some(c=>c.method==='asset.reconstruct'),false);
});

for(const mutation of ['reject','collision.glb','manifest.json'] as const){
  test('queued stage packet is cancelled before plugin poll after '+mutation,async t=>{
    const f=await reviewBoundaryFixture(t);await f.approve();f.hold('asset.stage_packet');
    const outcome=f.stage().then(value=>({value}),error=>({error}));await f.until(()=>!!f.queued('asset.stage_packet'),'queued first packet');
    const queued=f.queued('asset.stage_packet')!;
    if(mutation==='reject')await f.reject();else await f.changeSource(mutation);
    assert.deepEqual(f.studio.poll(f.pair.sessionId,f.proof()),[]);
    assert.equal(f.studio.command(queued.id).state,'cancelled');f.resume();
    assert.ok('error'in await outcome);assert.equal(f.delivered.some(c=>c.method==='asset.stage_packet'),false);
  });
}

for(const mutation of ['reject','collision.glb'] as const){
  test('queued reconstruction is cancelled before plugin poll after '+mutation,async t=>{
    const f=await reviewBoundaryFixture(t);await f.approve();await f.stage();f.newActor();f.hold('asset.reconstruct');
    const outcome=f.reconstruct().then(value=>({value}),error=>({error}));await f.until(()=>!!f.queued('asset.reconstruct'),'queued reconstruction');
    const queued=f.queued('asset.reconstruct')!;
    if(mutation==='reject')await f.reject();else await f.changeSource(mutation);
    assert.deepEqual(f.studio.poll(f.pair.sessionId,f.proof()),[]);assert.equal(f.studio.command(queued.id).state,'cancelled');f.resume();
    assert.ok('error'in await outcome);assert.equal(f.delivered.some(c=>c.method==='asset.reconstruct'),false);
    assert.equal(f.studio.readStageReconstruction(f.scope.projectId,REVIEW_JOB,queued.args.runId as string)?.receipt,null);
  });
}

for(const method of ['asset.stage_packet','asset.reconstruct'] as const){
  test('original opaque native actor is checked again at '+method+' dispatch',async t=>{
    const f=await reviewBoundaryFixture(t);await f.approve();
    if(method==='asset.reconstruct'){await f.stage();f.newActor();}
    f.hold(method);
    const outcome=(method==='asset.stage_packet'?f.stage():f.reconstruct()).then(value=>({value}),error=>({error}));
    await f.until(()=>!!f.queued(method),'queued '+method);const queued=f.queued(method)!;
    f.retireActor();assert.deepEqual(f.studio.poll(f.pair.sessionId,f.proof()),[]);
    assert.equal(f.studio.command(queued.id).state,'cancelled');f.resume();assert.ok('error'in await outcome);
    assert.equal(f.delivered.some(c=>c.method===method),false);
  });
}

test('default missing queue gate cannot dispatch a stage packet even with a genuine human decision and actor',async t=>{
  const f=await reviewBoundaryFixture(t,{queueGate:false});await f.approve();f.hold('asset.stage_packet');
  const outcome=f.stage().then(value=>({value}),error=>({error}));await f.until(()=>!!f.queued('asset.stage_packet'),'queued first packet');const queued=f.queued('asset.stage_packet')!;
  assert.deepEqual(f.studio.poll(f.pair.sessionId,f.proof()),[]);assert.equal(f.studio.command(queued.id).state,'cancelled');f.resume();assert.ok('error'in await outcome);
});

for(const mutation of ['reject','asset.glb'] as const){
  test('generic parent placement rechecks original reviewed reconstruction at dispatch after '+mutation,async t=>{
    const f=await reviewBoundaryFixture(t);await f.approve();const stage=await f.stage();f.newActor();await f.reconstruct();f.hold('scene.place_asset');
    const queued=f.place('editable-'+stage.transferDigest);
    if(mutation==='reject')await f.reject();else await f.changeSource(mutation);
    assert.deepEqual(f.studio.poll(f.pair.sessionId,f.proof()),[]);assert.equal(f.studio.command(queued.id).state,'cancelled');
    assert.throws(()=>f.place('editable-'+stage.transferDigest));assert.equal(f.delivered.some(c=>c.method==='scene.place_asset'),false);
  });
}

test('approved original placement and exact template clones remain usable; known rejection defeats external-model opt-in',async t=>{
  const f=await reviewBoundaryFixture(t);await f.approve();const stage=await f.stage();f.newActor();await f.reconstruct();
  const placement=f.place('editable-'+stage.transferDigest);await f.until(()=>f.studio.command(placement.id).state==='succeeded','recorded original placement');
  const result=f.studio.command(placement.id).result as unknown as {ref:InstanceRef};assert.equal(result.ref.instanceId,'reviewed-model');
  f.hold('scene.build');const one=f.clone(result.ref),scatter=f.clone(result.ref,4);assert.equal(one.state,'queued');assert.equal(scatter.state,'queued');
  assert.equal(f.studio.poll(f.pair.sessionId,f.proof())[0]?.id,one.id,'approved exact original clone dispatches');
  f.acknowledge(one);assert.equal(f.studio.command(one.id).state,'succeeded');
  await f.reject();f.externalModels(true);
  assert.deepEqual(f.studio.poll(f.pair.sessionId,f.proof()),[]);assert.equal(f.studio.command(scatter.id).state,'cancelled');
  assert.throws(()=>f.clone(result.ref,4),reviewRefused('ASSET_REVIEW_REJECTED'));
});
