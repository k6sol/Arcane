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
