import test from 'node:test';
import assert from 'node:assert/strict';
import {studioUploadContextObservation, type StudioSession} from '../../packages/protocol/src/studio.js';
import {validateCommandArgs} from '../../packages/core/src/studio-policy.js';
import {importContextFixture} from './studio-import-context-fixture.js';
import {StudioStore} from '../../packages/storage/src/studio-store.js';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import type {Json} from '../../packages/protocol/src/studio.js';

function pinFixture(t:test.TestContext){
  const directory=mkdtempSync(join(tmpdir(),'arcane-upload-context-pin-')),now=Date.now();
  let store=new StudioStore({directory,now:()=>now});
  t.after(()=>{store.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));rmSync(directory,{recursive:true,force:true});});
  const grant=store.createGrant({allowedRoots:['Workspace','ServerStorage'],allowWrites:true});
  const paired=store.pair({code:grant.code,protocolVersion:1,capabilities:['scene.upload_context','scene.children'],identity:{clientSessionId:'pin-client',placeId:12,universeId:34,name:'Pin fixture',pluginVersion:'0.1.7'}});
  const proof=(playEpoch=0)=>({sessionId:paired.sessionId,clientLifetimeId:'pin-client',pluginArtifactHash:'a'.repeat(64),markerName:'ArcaneTestProof_pin',placeId:12,universeId:34,placeName:'Pin fixture',mode:'Edit',playEpoch,continuitySupported:true,connected:true});
  const enqueue=(requestId='pin-context-request')=>store.enqueue({sessionId:paired.sessionId,requestId,method:'scene.upload_context',args:{}});
  return {directory,paired,proof,enqueue,get store(){return store;},restart(){store.close();store=new StudioStore({directory,now:()=>now});}};
}

test('upload context pins the actual enqueue proof and survives a later Edit epoch and restart',t=>{
  const f=pinFixture(t);f.store.poll(f.paired.sessionId,f.proof());const command=f.enqueue();
  const original={sessionId:f.paired.sessionId,clientLifetimeId:'pin-client',pluginArtifactHash:'a'.repeat(64),playEpoch:0,placeId:12,universeId:34};
  assert.deepEqual(f.store.assetUploadContextPin(command.id),original);
  const {observation}=importContextFixture();f.store.poll(f.paired.sessionId);
  f.store.result({sessionId:f.paired.sessionId,commandId:command.id,state:'succeeded',result:{...observation,sessionId:f.paired.sessionId,parentRef:{...observation.parentRef,sessionId:f.paired.sessionId},uploader:{status:'available',id:78,provenance:'StudioService:GetUserId'}} as unknown as Json});
  f.store.poll(f.paired.sessionId,f.proof(1));assert.equal(f.store.session(f.paired.sessionId).proof!.playEpoch,1);
  assert.deepEqual(f.store.assetUploadContextPin(command.id),original);
  assert.equal(f.enqueue().id,command.id,'Idempotent lookup must not manufacture a new pin.');
  Object.assign(f.store.assetUploadContextPin(command.id)!,{playEpoch:999});assert.deepEqual(f.store.assetUploadContextPin(command.id),original);
  f.restart();assert.deepEqual(f.store.assetUploadContextPin(command.id),original);
});

test('missing proof, legacy receipt, unrelated and fabricated command IDs gain no upload pin',t=>{
  const f=pinFixture(t),legacy=f.enqueue();assert.equal(f.store.assetUploadContextPin(legacy.id),null);
  f.store.poll(f.paired.sessionId,f.proof(1));assert.equal(f.enqueue().id,legacy.id);assert.equal(f.store.assetUploadContextPin(legacy.id),null);
  const other=f.store.enqueue({sessionId:f.paired.sessionId,requestId:'pin-other-request',method:'scene.children',args:{root:'Workspace'}});
  assert.equal(f.store.assetUploadContextPin(other.id),null);assert.equal(f.store.assetUploadContextPin('11111111-1111-4111-8111-111111111111'),null);
  assert.throws(()=>f.store.assetUploadContextPin(legacy.id+'\n'),{code:'UPLOAD_CONTEXT_PIN'});
});

test('upload context command and actual proof pin commit or roll back together',t=>{
  const f=pinFixture(t);f.store.poll(f.paired.sessionId,f.proof());const db=new DatabaseSync(join(f.directory,'studio.sqlite'));
  try{
    db.exec("CREATE TRIGGER fixture_pin_failure BEFORE INSERT ON asset_upload_context_pins BEGIN SELECT RAISE(ABORT,'pin fault'); END;");
    assert.throws(()=>f.enqueue(),/pin fault/);assert.equal(f.store.commands().length,0);
    assert.equal((db.prepare('SELECT epoch FROM sessions WHERE id=?').get(f.paired.sessionId) as {epoch:number}).epoch,0);
    db.exec('DROP TRIGGER fixture_pin_failure');const command=f.enqueue();assert.ok(f.store.assetUploadContextPin(command.id));assert.equal(command.leaseEpoch,1);
    db.prepare('UPDATE asset_upload_context_pins SET payload=? WHERE command_id=?').run(JSON.stringify({...f.store.assetUploadContextPin(command.id),clientLifetimeId:'forged'}),command.id);
    assert.throws(()=>f.store.assetUploadContextPin(command.id),{code:'UPLOAD_CONTEXT_PIN'});
  }finally{db.close();}
});

test('published uploader is observed independently of the place creator and grants no permission', () => {
  const {observation} = importContextFixture();
  for (const uploader of [{status: 'available', id: 78, provenance: 'StudioService:GetUserId'}, {status: 'unavailable', id: null, provenance: 'StudioService:GetUserId'}]) {
    const result = studioUploadContextObservation({...observation, uploader});
    assert.deepEqual(result.uploader, uploader); assert.equal(result.creator.id, 56);
    assert.equal(result.studioUser.status, 'not_applicable');
    assert.equal(Object.hasOwn(result, 'uploadAllowed'), false); assert.equal(Object.hasOwn(result, 'rightsCertified'), false);
  }
});
test('upload observation rejects inferred IDs, permission claims and accessor records', () => {
  const {observation} = importContextFixture();
  const input = {...observation, uploader: {status: 'available', id: 78, provenance: 'StudioService:GetUserId'}};
  for (const uploader of [{...input.uploader, id: 0}, {...input.uploader, id: '78'}, {...input.uploader, id: Infinity},
    {...input.uploader, provenance: 'game.CreatorId'}, {...input.uploader, uploadAllowed: true}, {status: 'unavailable', id: 56, provenance: 'StudioService:GetUserId'}])
    assert.throws(() => studioUploadContextObservation({...input, uploader}), {code: 'INPUT'});
  assert.throws(() => studioUploadContextObservation({...input, rightsCertified: true}), {code: 'INPUT'});
  let called = false;
  const accessor = {...input}; Object.defineProperty(accessor, 'uploader', {get() {called = true; return input.uploader;}});
  assert.throws(() => studioUploadContextObservation(accessor), {code: 'INPUT'}); assert.equal(called, false);
});
test('upload context is a fixed empty read confined to the granted Workspace', () => {
  const {session} = importContextFixture();
  const paired: StudioSession = {...session, capabilities: ['scene.upload_context']};
  assert.deepEqual(validateCommandArgs('scene.upload_context', {}, paired), {});
  for (const args of [[], {creatorId: 56}, {uploaderId: 78}, {rightsCertified: true}])
    assert.throws(() => validateCommandArgs('scene.upload_context', args, paired), {code: 'INPUT'});
  assert.throws(() => validateCommandArgs('scene.upload_context', {}, {...paired, allowedRoots: ['ServerStorage']}), {code: 'SCOPE'});
});
