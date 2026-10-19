import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {mkdtemp,mkdir,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute} from 'node:path';
import {STUDIO_ASSET_TRANSFER_LIMITS as LIMITS,type StudioAssetStageArgs,type StudioCommand,type Json} from '../../packages/protocol/src/studio.js';
import {StudioStore,type StageRunIntent} from '../../packages/storage/src/studio-store.js';
import {ConversationWorkStore} from '../../packages/storage/src/conversation-work-store.js';
import {validateCommandArgs} from '../../packages/core/src/studio-policy.js';
import {createNativeAssetRegistry,assertNativeAssetActor,assertNativeAssetStageOperationAvailable} from '../../apps/daemon/src/native-asset-authority.js';
import {createStudioImportStagingController,STUDIO_STAGING_LIMITS} from '../../apps/daemon/src/studio-import-staging-controller.js';
import {createStudioImportManifestAuthority,type HostGeneratedStudioImport} from '../../packages/asset-pipeline/src/studio-import-manifest.js';
import {decodeStudioImportPayload} from '../../packages/asset-pipeline/src/studio-import-payload.js';
import {createStudioImportTransfer,STUDIO_IMPORT_TRANSFER_LIMITS} from '../../packages/asset-pipeline/src/studio-import-transfer.js';
import {parseNativeStudioStagingResponse} from '../../packages/asset-pipeline/src/studio-staging-wire.js';
import {pngCrc} from '../../packages/asset-pipeline/src/validation.js';
import type {AssetService} from '../../apps/daemon/src/asset-service.js';
import type {StudioImportHostOptions} from '../../apps/daemon/src/asset-import-adapter.js';

// Actual branded PNG/GLB decoding, controller, native authority, policy and SQLite.
// Source/model-review/host-hook ports and authenticated plugin ACKs are fixtures;
// this does not claim actual human UI or public AssetService source-host acceptance.
const JOB='11111111-1111-4111-8111-111111111111',PLUGIN='a'.repeat(64),hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
type Doc=Record<string,any>;
function png(size:number,role:number):Buffer{
  const chunk=(kind:string,data:Buffer)=>{const out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);out.write(kind,4);data.copy(out,8);out.writeUInt32BE(pngCrc(out.subarray(4,data.length+8)),data.length+8);return out;};
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(size);ihdr.writeUInt32BE(size,4);ihdr[8]=8;ihdr[9]=6;
  const pixels=Buffer.alloc((size*4+1)*size);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){const at=y*(size*4+1)+1+x*4;pixels[at]=role===1?128:role===2?255:40+(x%2)*20;pixels[at+1]=role===1?128:role===2?192:120;pixels[at+2]=role===1?255:role===2?0:20;pixels[at+3]=255;}
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}
function generated(projectId:string,target:HostGeneratedStudioImport['target']):HostGeneratedStudioImport{
  const doc:Doc={asset:{version:'2.0',generator:'Khronos glTF Blender I/O v4.5.48'},buffers:[{byteLength:0}],bufferViews:[],accessors:[],meshes:[],nodes:[],scenes:[{nodes:[0,1,2]}],scene:0};let bin=Buffer.alloc(0);
  const view=(bytes:Buffer)=>{const at=Math.ceil(bin.length/4)*4,index=doc.bufferViews.length;bin=Buffer.concat([bin,Buffer.alloc(at-bin.length),bytes]);doc.bufferViews.push({buffer:0,byteOffset:at,byteLength:bytes.length});return index;};
  const accessor=(values:number[],type:string,componentType=5126)=>{const bytes=Buffer.alloc(values.length*(componentType===5126?4:1));values.forEach((n,i)=>componentType===5126?bytes.writeFloatLE(n,i*4):bytes.writeUInt8(n,i));const index=doc.accessors.length,a:Doc={bufferView:view(bytes),componentType,type,count:values.length/(type==='VEC3'?3:type==='VEC2'?2:1)};if(type==='VEC3'){a.min=[0,1,2].map(c=>Math.min(...values.filter((_,i)=>i%3===c)));a.max=[0,1,2].map(c=>Math.max(...values.filter((_,i)=>i%3===c)));}doc.accessors.push(a);return index;};
  const position=accessor([0,0,0,1,0,0,0,1,0,0,0,1],'VEC3'),normal=accessor([0,0,1,0,0,1,0,0,1,0,0,1],'VEC3'),uv=accessor([0,0,1,0,1,1,0,1],'VEC2'),indices=accessor([0,2,1,0,1,3,0,3,2,1,2,3],'SCALAR',5121);
  doc.images=[];for(const size of [1024,512])for(let role=0;role<3;role++)doc.images.push({mimeType:'image/png',bufferView:view(png(size,role))});
  doc.samplers=[{wrapS:10497,wrapT:10497,magFilter:9729,minFilter:9987}];doc.textures=doc.images.map((_:unknown,source:number)=>({source,sampler:0}));
  doc.materials=[0,3].map(i=>({pbrMetallicRoughness:{baseColorTexture:{index:i},metallicRoughnessTexture:{index:i+2}},normalTexture:{index:i+1}}));
  const ids=[hash('large-one'),hash('large-two'),hash('large-collision')].map(s=>'arcane_'+s),objects:HostGeneratedStudioImport['models'][number]['objects']=[];
  for(let i=0;i<3;i++){const role=i===2?'collision':'render',collisionFor=i===2?ids.slice(0,2).sort():[];doc.meshes.push({primitives:[{attributes:{POSITION:position,NORMAL:normal,TEXCOORD_0:uv},indices,...(i<2?{material:i}:{})}]});
    doc.nodes.push({mesh:i,extras:{arcane_identity_scheme:'arcane-semantic-v1',arcane_source_object_id:ids[i],arcane_role:role,arcane_source_key:'part'+i,arcane_pivot:[0,0,0],arcane_collision_for:JSON.stringify(collisionFor)}});objects.push({sourceObjectId:ids[i]!,nodeIndex:i,role,pivot:[0,0,0],collisionFor});}
  doc.buffers[0].byteLength=bin.length;const text=Buffer.from(JSON.stringify(doc)),size=Math.ceil(text.length/4)*4,n=Math.ceil(bin.length/4)*4,bytes=Buffer.alloc(28+size+n);
  bytes.writeUInt32LE(0x46546c67);bytes.writeUInt32LE(2,4);bytes.writeUInt32LE(bytes.length,8);bytes.writeUInt32LE(size,12);bytes.writeUInt32LE(0x4e4f534a,16);bytes.fill(32,20,20+size);text.copy(bytes,20);bytes.writeUInt32LE(n,20+size);bytes.writeUInt32LE(0x004e4942,24+size);bin.copy(bytes,28+size);
  return {schemaVersion:1,projectId,assetId:'arcane_'+hash('large-budget'),revisionId:JOB,sourceSha256:hash(bytes),producer:{blenderVersion:'4.5.3 LTS',exporterVersion:'Khronos glTF Blender IO v4.5.48'},target,placement:{mode:'bottom-centre'},studsPerMeter:1/.28,files:[{fileId:'export',contentType:'model/gltf-binary',sha256:hash(bytes),bytes}],models:[{fileId:'export',resources:[],objects}],anchors:[],baseline:null};
}
async function fixture(t:test.TestContext,options:{wrongAck?:boolean;chunkBytes?:number}={}){
  const base=await realpath(tmpdir()),root=await mkdtemp(join(base,'arcane-pbr-budget-')),projectPath=await realpath(root),work=new ConversationWorkStore({directory:join(root,'work'),projectPath});
  const conversation={provider:'codex' as const,threadId:'pbr-budget',sessionId:null};work.bind({conversation,kind:'asset-job',id:JOB});
  const registry=createNativeAssetRegistry({projectPath}),incarnation=registry.issue(),binding={connectionId:'pbr-budget-connection',threadId:conversation.threadId};incarnation.seal({...binding,...conversation});incarnation.grant(binding);incarnation.dispatched({...binding,operationId:'pbr-stage'});let actor=registry.capture(incarnation.credential(),'mutate');
  let store=new StudioStore({directory:join(root,'studio')});const grant=store.createGrant({allowedRoots:['Workspace','ServerStorage'],allowWrites:true}),pair=store.pair({code:grant.code,protocolVersion:1,capabilities:['asset.stage_packet','asset.reconstruct','scene.import_context'],identity:{clientSessionId:'pbr-plugin',pluginVersion:'0.1.9',name:'PBR budget fixture',placeId:12,universeId:34}});
  const proof=()=>({sessionId:pair.sessionId,clientLifetimeId:'pbr-plugin',pluginArtifactHash:PLUGIN,markerName:'ArcaneTestProof_pbr',placeId:12,universeId:34,placeName:'PBR budget fixture',mode:'Edit',playEpoch:0,continuitySupported:true,connected:true});store.poll(pair.sessionId,proof());
  const target={sessionId:pair.sessionId,placeId:12,universeId:34,root:'Workspace' as const,parentRef:'pbr-parent',creator:{kind:'group' as const,id:'56'}},g=generated(work.projectId,target),authority=createStudioImportManifestAuthority({loadGeneratedFiles:async()=>g}),prepared=authority.prepare(await authority.admit(JOB));authority.close();
  const payload=decodeStudioImportPayload(prepared,new Map(g.files.map(f=>[f.fileId,f.bytes])),options.chunkBytes?{chunkBytes:options.chunkBytes}:{}),transfer=createStudioImportTransfer(prepared,payload),reference={reviewId:'99999999-9999-4999-8999-999999999999',subjectDigest:hash('reviewed-exact-source'),revision:1};let approved=true,sourceCurrent=true,reviewChecks=0,selected=0,released=0;
  const check=()=>{reviewChecks++;assertNativeAssetActor(actor,'mutate');if(!approved||!sourceCurrent)throw Object.assign(Error('Reviewed source unavailable'),{code:'ASSET_REVIEW_REQUIRED'});};
  const review={reference,assertCurrent:check},assets={async prepareStudioImportPayload(){check();return {prepared,payload,transfer,review};},async reviewImport(){check();return review;}} as unknown as Pick<AssetService,'prepareStudioImportPayload'|'reviewImport'>;
  const host:StudioImportHostOptions={workAssociations:work,beginPreparationAttempt(_scope,_job,_actor,guard){guard();return Object.freeze({kind:'studio-import-preparation-attempt',id:randomUUID()});},selectTarget(_scope,_job,_actor,guard){guard();selected++;return {target,placement:{mode:'bottom-centre'},studsPerMeter:1/.28};},validateTarget(){assert.deepEqual(prepared.manifest.target,target);},releaseTarget(){released++;}};
  const bind=()=>store.bindAssetModelReview(intent=>{assert.deepEqual(intent.modelReview,reference);check();});let release=bind(),controller=createStudioImportStagingController({projectPath,workAssociations:work,studio:store,assets,host,pluginArtifactHash:PLUGIN});
  let bytes=0,envelopes=0,count=0,wrongAck=0;const failures:unknown[]=[],delivered:StudioCommand[]=[];
  const pump=setInterval(()=>{try{for(const c of store.poll(pair.sessionId,proof())){delivered.push(c);if(c.method==='asset.stage_packet'){const packet=JSON.parse(c.args.packet as string);assert.equal(packet.ordinal,count);bytes+=Buffer.byteLength(c.args.packet as string);envelopes+=Buffer.byteLength(JSON.stringify(c.args));count++;const receipt={transferDigest:transfer.digest,packetCount:count,byteLength:bytes,state:packet.kind==='seal'?'sealed':'receiving',engineVerification:'pending'};
    if(options.wrongAck&&!wrongAck){wrongAck++;store.result({sessionId:pair.sessionId,commandId:c.id,state:'succeeded',result:{...receipt,byteLength:envelopes}});}else store.result({sessionId:pair.sessionId,commandId:c.id,state:'succeeded',result:receipt});
  }else if(c.method==='scene.import_context'){store.result({sessionId:pair.sessionId,commandId:c.id,state:'succeeded',result:{sessionId:pair.sessionId,root:'Workspace',parentRef:{instanceId:'pbr-parent',sessionId:pair.sessionId,root:'Workspace',pathSegments:[],className:'Workspace'},placeId:12,universeId:34,mode:'Edit',modeProvenance:'StudioTestService.EditModeActive',creator:{status:'available',kind:'group',id:56,provenance:'game.CreatorType/CreatorId'},studioUser:{status:'not_applicable',id:null,provenance:'StudioService:GetUserId'}}});}
    else{assert.equal(c.method,'asset.reconstruct');store.result({sessionId:pair.sessionId,commandId:c.id,state:'succeeded',result:{runId:c.args.runId,transferDigest:transfer.digest,state:'reconstructed',objects:c.args.objects,imported:false,engineVerification:'pending'}});}}}catch(error){failures.push(error);}},10);
  t.after(()=>{clearInterval(pump);controller.close();release();store.close();registry.close();work.close();assert.ok(!isAbsolute(relative(base,root))&&relative(base,root).startsWith('arcane-pbr-budget-'));return rm(root,{recursive:true,force:true}).then(()=>assert.deepEqual(failures,[]));});
  return {root,pair,proof,prepared,payload,transfer,work,reference,target,conversation,failures,delivered,get store(){return store;},get actor(){return actor;},get controller(){return controller;},get checks(){return {reviewChecks,selected,released,bytes,envelopes,count,wrongAck};},reject(){approved=false;},changeSource(){sourceCurrent=false;},newActor(){incarnation.ended('pbr-stage');incarnation.dispatched({...binding,operationId:'pbr-reconstruct'});actor=registry.capture(incarnation.credential(),'mutate');},restart(){controller.close();release();store.close();store=new StudioStore({directory:join(root,'studio')});release=bind();controller=createStudioImportStagingController({projectPath,workAssociations:work,studio:store,assets,host,pluginArtifactHash:PLUGIN});}};
}

test('full-resolution 20 MiB PBR maps stage, seal, reconstruct and recover through actual production boundaries',{timeout:120000},async t=>{
  const f=await fixture(t),started=Date.now();assert.equal(f.payload.textures!.reduce((n,x)=>n+x.bytes.byteLength,0),20*1024*1024);assert.equal(f.payload.textures!.length,8);assert.ok(f.transfer.byteLength>8*1024*1024);assert.ok(f.transfer.byteLength<=LIMITS.rawBytes);
  const staged=await f.controller.stage(JOB,f.actor);assert.deepEqual(f.failures,[]);assert.equal(staged.byteLength,f.transfer.byteLength);assert.equal(staged.packetCount,f.transfer.packets.length);assert.equal(staged.imported,false);assert.equal(staged.state,'sealed');
  assert.ok(f.checks.envelopes>8*1024*1024&&f.checks.envelopes<=LIMITS.envelopeBytes);assert.ok(f.checks.envelopes>staged.byteLength);assert.equal(f.checks.wrongAck,0);assert.ok(f.checks.reviewChecks>staged.packetCount);assert.equal(f.checks.selected,1);assert.equal(f.checks.released,1);
  assert.deepEqual(parseNativeStudioStagingResponse({jobId:JOB,projectId:f.work.projectId,staged},JOB,f.work.projectId).staged,staged);
  const run=f.store.readStageRun(f.work.projectId,JOB)!;assert.deepEqual(run.intent.modelReview,f.reference);assert.equal(run.intent.transferDigest,f.transfer.digest);assert.equal(run.intent.payloadDigest,f.payload.digest);
  assert.ok(f.delivered.some(c=>c.method==='asset.stage_packet'&&JSON.parse(c.args.packet as string).kind==='texture'));f.newActor();const reconstructed=await f.controller.reconstruct(JOB,f.actor);assert.equal(reconstructed.objects.length,3);assert.equal(reconstructed.imported,false);
  const elapsedMs=Date.now()-started;assert.ok(elapsedMs<STUDIO_STAGING_LIMITS.totalDeadlineMs);t.diagnostic(JSON.stringify({rawRgbaBytes:20*1024*1024,packets:staged.packetCount,rawTransferBytes:staged.byteLength,envelopeBytes:f.checks.envelopes,elapsedMs,transferDigest:staged.transferDigest}));
  f.restart();const historical=f.store.readStageRun(f.work.projectId,JOB)!;assert.deepEqual(historical.receipt,run.receipt);assert.equal(historical.intent.plan.length,staged.packetCount);const {commandId:_command,...recorded}=reconstructed;assert.deepEqual(f.store.readStageReconstruction(f.work.projectId,JOB,run.runId)?.receipt,recorded);
});

function accounting(f:Awaited<ReturnType<typeof fixture>>,raw:number,envelope:number,count=512):StageRunIntent{
  let bytes=0;return {projectId:f.work.projectId,jobId:randomUUID(),conversation:f.conversation,modelReview:f.reference,transferDigest:f.transfer.digest,payloadDigest:f.payload.digest,manifestDigest:f.prepared.manifest.digest,preparedDigest:f.prepared.digest,target:f.target,continuity:{clientLifetimeId:'pbr-plugin',pluginArtifactHash:PLUGIN,playEpoch:0},plan:Array.from({length:count},(_,ordinal)=>{
    const packetByteLength=Math.floor(raw/count)+(ordinal<raw%count?1:0),envelopeByteLength=Math.floor(envelope/count)+(ordinal<envelope%count?1:0);bytes+=packetByteLength;return {ordinal,argsSha256:'e'.repeat(64),packetByteLength,envelopeByteLength,expectedReceipt:{transferDigest:f.transfer.digest,packetCount:ordinal+1,byteLength:bytes,state:ordinal===count-1?'sealed':'receiving',engineVerification:'pending'}};})};
}
test('raw, complete-envelope and per-packet overages refuse before durable effects; raw and receipt budgets stay distinct',async t=>{
  const f=await fixture(t);for(const [raw,envelope,count]of [[LIMITS.rawBytes+1,LIMITS.rawBytes+10000,512],[LIMITS.rawBytes,LIMITS.envelopeBytes+1,512],[LIMITS.packetBytes+1,LIMITS.packetBytes+1,1],[512,512,513]]){
    const intent=accounting(f,raw!,envelope!,count!);assert.throws(()=>f.store.beginStageRun(intent,()=>{}));assert.equal(f.store.readStageRun(f.work.projectId,intent.jobId),null);assert.equal(f.store.commands().length,0);assertNativeAssetStageOperationAvailable(f.actor,JOB);
  }
  assert.equal(STUDIO_IMPORT_TRANSFER_LIMITS.totalBytes,LIMITS.rawBytes);assert.equal(LIMITS.envelopeBytes,50*1024*1024);assert.equal(LIMITS.packetBytes,256*1024);assert.equal(STUDIO_STAGING_LIMITS.packetDeadlineMs,10000);assert.equal(STUDIO_STAGING_LIMITS.totalDeadlineMs,120000);
  const ids=Array.from({length:512},()=>randomUUID()),staged={status:'staged',runId:randomUUID(),imported:false,engineVerification:'pending',state:'sealed',transferDigest:f.transfer.digest,packetCount:512,byteLength:LIMITS.rawBytes,commandIds:ids};
  assert.doesNotThrow(()=>parseNativeStudioStagingResponse({jobId:JOB,projectId:f.work.projectId,staged},JOB));assert.throws(()=>parseNativeStudioStagingResponse({jobId:JOB,projectId:f.work.projectId,staged:{...staged,byteLength:LIMITS.rawBytes+1}},JOB));
});
test('PBR texture descriptors are known packets, arbitrary kinds and mismatched authority remain refused',async t=>{
  const f=await fixture(t),texture=f.transfer.packets.find(p=>p.kind==='texture')!,expected={digest:f.transfer.digest,payloadDigest:f.payload.digest,manifestDigest:f.prepared.manifest.digest},args={expected,packet:texture.json,target:f.target,continuity:{clientLifetimeId:'pbr-plugin',pluginArtifactHash:PLUGIN,playEpoch:0}};
  assert.doesNotThrow(()=>validateCommandArgs('asset.stage_packet',args,f.store.session(f.pair.sessionId)));
  for(const kind of ['material','unknown','upload'])assert.throws(()=>validateCommandArgs('asset.stage_packet',{...args,packet:JSON.stringify({...JSON.parse(texture.json),kind})},f.store.session(f.pair.sessionId)));
  assert.throws(()=>validateCommandArgs('asset.stage_packet',{...args,expected:{...expected,payloadDigest:'0'.repeat(64)}},f.store.session(f.pair.sessionId)));
  f.reject();await assert.rejects(f.controller.stage(JOB,f.actor),{code:'ASSET_REVIEW_REQUIRED'});assert.equal(f.store.commands().length,0);assertNativeAssetStageOperationAvailable(f.actor,JOB);
});
test('complete-envelope byte counts cannot substitute for raw packet receipt accounting or authorize replay',async t=>{
  const f=await fixture(t,{wrongAck:true});await assert.rejects(f.controller.stage(JOB,f.actor),{code:'STUDIO_STAGE_RECEIPT'});
  const run=f.store.readStageRun(f.work.projectId,JOB)!;assert.equal(run.receipt,null);assert.equal(run.phase,'needs_reconciliation');assert.equal(f.checks.wrongAck,1);
  const count=f.store.commands().length;await assert.rejects(f.controller.stage(JOB,f.actor));assert.equal(f.store.commands().length,count);
});
test('actual over-count decoded transfer reports measured budgets before effect claim or queueing',async t=>{
  const f=await fixture(t,{chunkBytes:16*1024});assert.ok(f.transfer.packets.length>LIMITS.packets);
  await assert.rejects(f.controller.stage(JOB,f.actor),(error:unknown)=>{
    assert.ok(error&&typeof error==='object'&&'code'in error&&'message'in error);assert.equal(error.code,'STUDIO_STAGE_BUDGET');
    assert.match(String(error.message),new RegExp('packets '+f.transfer.packets.length+'/512'));assert.match(String(error.message),/raw bytes \d+\/50331648/);assert.match(String(error.message),/complete-envelope bytes \d+\/52428800/);assert.match(String(error.message),/No stage command was queued/);return true;
  });
  assert.equal(f.store.commands().length,0);assert.equal(f.store.readStageRun(f.work.projectId,JOB),null);assertNativeAssetStageOperationAvailable(f.actor,JOB);
});
