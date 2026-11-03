import test from 'node:test';
import assert from 'node:assert/strict';
import {rmSync} from 'node:fs';
import {relative,isAbsolute} from 'node:path';
import {StudioStore} from '../../packages/storage/src/studio-store.js';
import {fixtureTempDirectory,makeFixtureDirectory} from './windows-fixture-paths.js';

for(const step of [1,-1])test('continuity proof keeps an exact six-second lifetime with a '+step+'ms advancing clock',t=>{
  const directory=makeFixtureDirectory('arcane-proof-clock-');
  let now=Date.UTC(2026,9,16),increment=0;
  const store=new StudioStore({directory,now:()=>{const sampled=now;now+=increment;return sampled;}});
  t.after(()=>{
    store.close();const child=relative(fixtureTempDirectory(),directory);
    assert.ok(child.startsWith('arcane-proof-clock-')&&!isAbsolute(child)&&!child.includes('..')&&!child.includes('/')&&!child.includes('\\'));
    rmSync(directory,{recursive:true,force:true});
  });
  const grant=store.createGrant({allowedRoots:['Workspace','ServerStorage'],allowWrites:true});
  const pair=store.pair({code:grant.code,protocolVersion:1,identity:{clientSessionId:'proof-clock-fixture',placeId:0,universeId:0,name:'Fixture',pluginVersion:'fixture'},capabilities:['scene.children']});
  increment=step;
  store.poll(pair.sessionId,{sessionId:pair.sessionId,clientLifetimeId:'proof-clock-fixture',pluginArtifactHash:'a'.repeat(64),markerName:'ArcaneTestProof_clock',
    placeId:0,universeId:0,placeName:'Fixture',mode:'Edit',playEpoch:0,continuitySupported:true,connected:true});
  const proof=store.session(pair.sessionId,false).proof!;
  assert.ok(proof);
  assert.equal(Date.parse(proof.expiresAt)-Date.parse(proof.observedAt),6000);
  assert.equal(proof.clientLifetimeId,'proof-clock-fixture');
});

function lifecycleFixture(t: test.TestContext) {
  const directory=makeFixtureDirectory('arcane-proof-lifecycle-');
  const store=new StudioStore({directory});
  t.after(()=>{
    store.close();const child=relative(fixtureTempDirectory(),directory);
    assert.ok(child.startsWith('arcane-proof-lifecycle-')&&!isAbsolute(child)&&!child.includes('..')&&!child.includes('/')&&!child.includes('\\'));
    rmSync(directory,{recursive:true,force:true});
  });
  const grant=store.createGrant({allowedRoots:['Workspace','ServerStorage'],allowWrites:true});
  const pair=store.pair({code:grant.code,protocolVersion:1,identity:{clientSessionId:'lifecycle-fixture',placeId:0,universeId:0,name:'Private fixture name',pluginVersion:'fixture'},capabilities:['scene.children']});
  const observation={sessionId:pair.sessionId,clientLifetimeId:'lifecycle-fixture',pluginArtifactHash:'a'.repeat(64),markerName:'ArcaneTestProof_private',
    placeId:0,universeId:0,placeName:'Private fixture name',mode:'Edit',playEpoch:0,continuitySupported:true,connected:true};
  const events=()=>store.events().filter(e=>e!==null&&typeof e==='object'&&!Array.isArray(e)&&e.kind==='studio_continuity_changed');
  return {store,pair,observation,events};
}

test('authenticated lifecycle history records Play and Edit while ordinary heartbeats stay silent',t=>{
  const f=lifecycleFixture(t);
  f.store.poll(f.pair.sessionId,f.observation);
  for(let i=0;i<12;i++)f.store.poll(f.pair.sessionId,f.observation);
  assert.equal(f.events().length,1);
  f.store.poll(f.pair.sessionId,{...f.observation,mode:'Play',playEpoch:1});
  f.store.poll(f.pair.sessionId,{...f.observation,mode:'Edit',playEpoch:2});
  assert.deepEqual(f.events().map(e=>(e as {detail:unknown}).detail),[
    {previousMode:'Play',mode:'Edit',previousPlayEpoch:1,playEpoch:2,connected:true,continuitySupported:true},
    {previousMode:'Edit',mode:'Play',previousPlayEpoch:0,playEpoch:1,connected:true,continuitySupported:true},
    {previousMode:null,mode:'Edit',previousPlayEpoch:null,playEpoch:0,connected:true,continuitySupported:true},
  ]);
  assert.equal(f.store.session(f.pair.sessionId).revokedAt,null);
  const serialized=JSON.stringify(f.events());
  for(const privateValue of [f.pair.token,f.observation.placeName,f.observation.markerName,f.observation.pluginArtifactHash])assert.ok(!serialized.includes(privateValue));
});

test('continuity history records marker loss and recovery without changing mode or pairing',t=>{
  const f=lifecycleFixture(t);
  f.store.poll(f.pair.sessionId,f.observation);
  f.store.poll(f.pair.sessionId,{...f.observation,connected:false,continuitySupported:false});
  f.store.poll(f.pair.sessionId,f.observation);
  assert.equal(f.events().length,3);
  assert.equal(f.store.session(f.pair.sessionId).proof?.connected,true);
  assert.equal(f.store.session(f.pair.sessionId).revokedAt,null);
});

test('rejected identity, mode and epoch observations cannot enter the authenticated timeline',t=>{
  const f=lifecycleFixture(t);
  f.store.poll(f.pair.sessionId,f.observation);
  const before=f.events();
  for(const bad of [{mode:'Play'}, {placeName:'Different place'}, {playEpoch:-1}, {pluginArtifactHash:'b'.repeat(64)}]){
    assert.throws(()=>f.store.poll(f.pair.sessionId,{...f.observation,...bad}));
    assert.deepEqual(f.events(),before);
    assert.equal(f.store.session(f.pair.sessionId).proof?.mode,'Edit');
  }
});
