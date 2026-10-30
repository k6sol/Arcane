import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {StudioStore} from '../../packages/storage/src/studio-store.js';
import {ConversationWorkStore} from '../../packages/storage/src/conversation-work-store.js';
import {saveStudioFixture} from '../../packages/asset-pipeline/testing/studio-import-fixture.js';
import {adaptCompletedStudioImport,type StudioImportHostOptions} from '../../apps/daemon/src/asset-import-adapter.js';
import {createStudioImportManifestAuthority} from '../../packages/asset-pipeline/src/studio-import-manifest.js';
import {decodeStudioImportPayload} from '../../packages/asset-pipeline/src/studio-import-payload.js';
import {createStudioImportTransfer} from '../../packages/asset-pipeline/src/studio-import-transfer.js';
import {createStudioImportStagingController,studioStagingFailureDiagnostic} from '../../apps/daemon/src/studio-import-staging-controller.js';
import {createNativeAssetRegistry,assertNativeAssetActor,assertNativeAssetStageOperationAvailable} from '../../apps/daemon/src/native-asset-authority.js';
import {readStudioStagingDiagnostic,studioStagingDiagnosticMessage,type StudioStagingDiagnostic} from '../../packages/asset-pipeline/src/failure-diagnostics.js';
import {ArcaneError} from '../../packages/protocol/src/providers.js';
import type {AssetService} from '../../apps/daemon/src/asset-service.js';

const JOB='11111111-1111-4111-8111-111111111111',PLUGIN='a'.repeat(64);
type Proof=NonNullable<ReturnType<StudioStore['session']>['proof']>;
// Real decode/controller/SQLite/native authority. Source, review and target ports
// plus selected session-read facts are controlled doubles; no engine is used.
async function fixture(t:test.TestContext){
  const base=await realpath(tmpdir()),root=await mkdtemp(join(base,'arcane-stage-detail-')),projectPath=await realpath(root);
  const work=new ConversationWorkStore({directory:join(root,'work'),projectPath}),conversation={provider:'codex' as const,threadId:'staging-details',sessionId:null};
  work.bind({conversation,kind:'asset-job',id:JOB});
  const registry=createNativeAssetRegistry({projectPath}),incarnation=registry.issue(),binding={connectionId:'staging-details',threadId:conversation.threadId};
  incarnation.seal({...binding,...conversation});incarnation.grant(binding);incarnation.dispatched({...binding,operationId:'stage-details'});
  const actor=registry.capture(incarnation.credential(),'mutate');let clock=Date.UTC(2026,9,30),checks=0,released=0,onCheck=()=>{};
  const studio=new StudioStore({directory:join(root,'studio'),now:()=>clock}),grant=studio.createGrant({allowedRoots:['Workspace','ServerStorage'],allowWrites:true});
  const pair=studio.pair({code:grant.code,protocolVersion:1,capabilities:['asset.stage_packet'],identity:{clientSessionId:'details-plugin',pluginVersion:'fixture',name:'Details fixture',placeId:12,universeId:34}});
  const proof=()=>({sessionId:pair.sessionId,clientLifetimeId:'details-plugin',pluginArtifactHash:PLUGIN,markerName:'ArcaneTestProof_details',placeId:12,universeId:34,placeName:'Details fixture',mode:'Edit',playEpoch:0,continuitySupported:true,connected:true});
  studio.poll(pair.sessionId,proof());
  const selection={target:{sessionId:pair.sessionId,placeId:12,universeId:34,root:'Workspace' as const,parentRef:'details-parent',creator:{kind:'group' as const,id:'56'}},placement:{mode:'bottom-centre' as const},studsPerMeter:1/.28};
  const job=join(root,'job');await mkdir(job);const manifest=await saveStudioFixture(job,JOB),exports=new Map<'asset.glb'|'collision.glb',Buffer>();
  for(const path of ['asset.glb','collision.glb'] as const)exports.set(path,await readFile(join(job,path)));
  const generated=adaptCompletedStudioImport(manifest,exports,work.projectId,selection,null),authority=createStudioImportManifestAuthority({loadGeneratedFiles:async()=>generated});
  const prepared=authority.prepare(await authority.admit(JOB));authority.close();
  const payload=decodeStudioImportPayload(prepared,new Map(generated.files.map(file=>[file.fileId,file.bytes]))),transfer=createStudioImportTransfer(prepared,payload);
  const reference={reviewId:'99999999-9999-4999-8999-999999999999',subjectDigest:'b'.repeat(64),revision:1};
  const review={reference,assertCurrent:()=>assertNativeAssetActor(actor,'mutate')};
  const assets={async prepareStudioImportPayload(){review.assertCurrent();return {prepared,payload,transfer,review};},async reviewImport(){return review;}} as unknown as Pick<AssetService,'prepareStudioImportPayload'|'reviewImport'>;
  const host:StudioImportHostOptions={workAssociations:work,beginPreparationAttempt(_s,_j,_a,guard){guard();return Object.freeze({kind:'studio-import-preparation-attempt',id:randomUUID()});},
    selectTarget(_s,_j,_a,guard){guard();return selection;},validateTarget(){checks++;onCheck();},releaseTarget(){released++;}};
  const release=studio.bindAssetModelReview(intent=>{assert.deepEqual(intent.modelReview,reference);review.assertCurrent();});
  const controller=createStudioImportStagingController({projectPath,workAssociations:work,studio,assets,host,pluginArtifactHash:PLUGIN,now:()=>clock});
  t.after(async()=>{controller.close();release();studio.close();registry.close();work.close();const child=relative(base,root);assert.ok(child.startsWith('arcane-stage-detail-')&&!isAbsolute(child)&&!child.includes('..'));await rm(root,{recursive:true,force:true});});
  return {studio,work,actor,controller,pair,proof,get checks(){return checks;},get released(){return released;},onCheck(fn:()=>void){onCheck=fn;},expire(){clock+=6000;}};
}
async function failure(start:()=>Promise<unknown>):Promise<unknown>{try{await start();assert.fail('Expected the original controller refusal.');}catch(error){return error;}}

test('actual target/admission checks retain their code and observed phase without consuming a claim',async t=>{
  for(const at of [1,2]){
    const f=await fixture(t);f.onCheck(()=>{if(f.checks===at)f.expire();});
    const error=await failure(()=>f.controller.stage(JOB,f.actor));assert.ok(error instanceof ArcaneError);assert.equal(error.code,'STUDIO_STAGE_CONTINUITY');
    const diagnostic=studioStagingFailureDiagnostic(error);assert.deepEqual(diagnostic,{schemaVersion:1,operation:'stage',phase:at===1?'target-check':'admission',reason:'proof-expired',packetOrdinal:null});
    assert.equal(error.message,studioStagingDiagnosticMessage(diagnostic!));assert.equal(f.studio.commands().length,0);assert.equal(f.studio.readStageRun(f.work.projectId,JOB),null);
    assert.equal(f.released,1);assertNativeAssetStageOperationAvailable(f.actor,JOB);
  }
});

test('the controller reports the first false continuity predicate without reading later expiry facts',async t=>{
  const rows:[StudioStagingDiagnostic['reason'],(proof:Proof)=>Proof|null][]=[
    ['proof-missing',()=>null],['plugin-lifetime-changed',proof=>({...proof,clientLifetimeId:'changed',mode:'Play'})],
    ['plugin-artifact-changed',proof=>({...proof,pluginArtifactHash:'c'.repeat(64)})],['edit-epoch-changed',proof=>({...proof,playEpoch:1})],
    ['not-edit',proof=>({...proof,mode:'Play'})],['disconnected',proof=>({...proof,connected:false})],['continuity-unsupported',proof=>({...proof,continuitySupported:false})],
  ];
  for(const [reason,change] of rows){
    const f=await fixture(t),session=f.studio.session.bind(f.studio);let changed=false;
    f.onCheck(()=>{changed=true;});
    t.mock.method(f.studio,'session',(...args:Parameters<StudioStore['session']>)=>{
      const value=session(...args);if(!changed||!value.proof)return value;
      const proof=change(value.proof);if(proof)Object.defineProperty(proof,'expiresAt',{get(){throw Error('A later expiry predicate was read.');}});
      return {...value,proof};
    });
    const error=await failure(()=>f.controller.stage(JOB,f.actor));assert.ok(error instanceof ArcaneError);assert.equal(error.code,'STUDIO_STAGE_CONTINUITY');
    assert.equal(studioStagingFailureDiagnostic(error)?.reason,reason);assert.equal(f.studio.commands().length,0);assertNativeAssetStageOperationAvailable(f.actor,JOB);
  }
});

test('receipt-loop expiry keeps the exact ordinal and original cancelled/unknown command evidence without replay',async t=>{
  for(const delivered of [false,true]){
    const f=await fixture(t),enqueue=f.studio.enqueueStagePacket.bind(f.studio);
    t.mock.method(f.studio,'enqueueStagePacket',(...args:Parameters<StudioStore['enqueueStagePacket']>)=>{
      const command=enqueue(...args);if(delivered)assert.equal(f.studio.poll(f.pair.sessionId,f.proof()).length,1);f.expire();return command;
    });
    const error=await failure(()=>f.controller.stage(JOB,f.actor));assert.ok(error instanceof ArcaneError);assert.equal(error.code,'STUDIO_STAGE_CONTINUITY');
    assert.deepEqual(studioStagingFailureDiagnostic(error),{schemaVersion:1,operation:'stage',phase:'packet-receipt',reason:'proof-expired',packetOrdinal:0});
    assert.equal(f.studio.commands().length,1);assert.equal(f.studio.commands()[0]!.state,delivered?'needs_reconciliation':'cancelled');
    assert.equal(f.studio.readStageRun(f.work.projectId,JOB)!.receipt,null);assert.throws(()=>assertNativeAssetStageOperationAvailable(f.actor,JOB));
    await assert.rejects(f.controller.stage(JOB,f.actor));assert.equal(f.studio.commands().length,1);
  }
});

test('descriptors are exact bounded data and matching foreign errors cannot mint host diagnostics',()=>{
  const value={schemaVersion:1,operation:'stage',phase:'packet-receipt',reason:'proof-expired',packetOrdinal:511};
  assert.equal(readStudioStagingDiagnostic(value)?.packetOrdinal,511);
  for(const invalid of [{...value,packetOrdinal:512},{...value,packetOrdinal:-1},{...value,packetOrdinal:.5},{...value,phase:'target-check'},
    {...value,sourcePath:'private'},{...value,reason:'arbitrary model text'},{...value,schemaVersion:2},new Proxy(value,{})])assert.equal(readStudioStagingDiagnostic(invalid),null);
  let reads=0;const accessor={...value};Object.defineProperty(accessor,'reason',{enumerable:true,get(){reads++;return 'proof-expired';}});
  assert.equal(readStudioStagingDiagnostic(accessor),null);assert.equal(reads,0);
  const foreign=Object.assign(new ArcaneError('STUDIO_STAGE_CONTINUITY','private source text'),{diagnostic:value});assert.equal(studioStagingFailureDiagnostic(foreign),null);
});
