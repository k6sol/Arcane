import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {buildConvertedGraph,type ConvertedGraphSourceBytes} from '../../packages/asset-pipeline/src/studio-import-graph.js';
import {prepareGlbConversionSource} from '../../packages/asset-pipeline/src/glb-conversion-source.js';
import {convertedGlbObjectId,convertedGlbAssetId,parseConvertedGlbRequest} from '../../packages/asset-pipeline/src/converted-glb.js';
import {CONVERSION_FIDELITY_POLICY,CONVERSION_NODE_KEY,conversionCorrespondenceSha256} from '../../packages/asset-pipeline/src/conversion-fidelity-policy.js';
import {createStudioImportManifestAuthority,type HostConvertedStudioImportV2,type ConvertedPreparedStudioImportV2,type HostStudioImport} from '../../packages/asset-pipeline/src/studio-import-manifest.js';
import {decodeStudioImportPayload,type ConvertedStudioImportPayloadV2} from '../../packages/asset-pipeline/src/studio-import-payload.js';
import {createStudioImportTransfer,inspectConvertedStudioImportTransfer} from '../../packages/asset-pipeline/src/studio-import-transfer.js';
import {STUDIO_ASSET_TRANSFER_LIMITS,type StudioCommand,type StudioAssetReconstructArgs,type Json} from '../../packages/protocol/src/studio.js';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {join,relative,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {StudioStore} from '../../packages/storage/src/studio-store.js';
import {ConversationWorkStore} from '../../packages/storage/src/conversation-work-store.js';
import {createNativeAssetRegistry,assertNativeAssetActor,assertNativeAssetStageOperationAvailable} from '../../apps/daemon/src/native-asset-authority.js';
import {createStudioImportStagingController} from '../../apps/daemon/src/studio-import-staging-controller.js';
import type {AssetService} from '../../apps/daemon/src/asset-service.js';
import type {StudioImportHostOptions} from '../../apps/daemon/src/asset-import-adapter.js';
import {convertedGraphDigest} from '../../packages/asset-pipeline/src/studio-import-graph.js';
// Constructed exact GLBs and synthetic audit metadata only; no native/Studio/resource execution.
type Doc=Record<string,any>;
const JOB='11111111-1111-4111-8111-111111111111',PARENT='22222222-2222-4222-8222-222222222222';
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const json=(value:unknown)=>Buffer.from(JSON.stringify(value));
const identity=()=>[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
function pack(doc:Doc,bin:Buffer):Buffer {
  doc.buffers[0].byteLength=bin.length;const text=json(doc),j=(text.length+3)&~3,b=(bin.length+3)&~3,out=Buffer.alloc(28+j+b);
  out.writeUInt32LE(0x46546c67);out.writeUInt32LE(2,4);out.writeUInt32LE(out.length,8);out.writeUInt32LE(j,12);out.writeUInt32LE(0x4e4f534a,16);
  out.fill(32,20,20+j);text.copy(out,20);out.writeUInt32LE(b,20+j);out.writeUInt32LE(0x004e4942,24+j);bin.copy(out,28+j);return out;
}
function geometry(positions:number[][],faces:number[]):{doc:Doc;bin:Buffer}{
  const p=Buffer.alloc(positions.length*12),i=Buffer.alloc(faces.length*2);
  positions.flat().forEach((v,at)=>p.writeFloatLE(v,at*4));faces.forEach((v,at)=>i.writeUInt16LE(v,at*2));
  return{doc:{asset:{version:'2.0'},buffers:[{byteLength:0}],bufferViews:[{buffer:0,byteOffset:0,byteLength:p.length},{buffer:0,byteOffset:p.length,byteLength:i.length}],
    accessors:[{bufferView:0,componentType:5126,count:positions.length,type:'VEC3',min:[0,1,2].map(a=>Math.min(...positions.map(v=>v[a]!))),max:[0,1,2].map(a=>Math.max(...positions.map(v=>v[a]!)))},
      {bufferView:1,componentType:5123,count:faces.length,type:'SCALAR'}],meshes:[{primitives:[{attributes:{POSITION:0},indices:1}]}],nodes:[{mesh:0}],scene:0,scenes:[{nodes:[0]}]},bin:Buffer.concat([p,i])};
}
function fixture(collision=false,affine:'rigid'|'scale'|'shear'|'reflection'='rigid'){
  const original=geometry([[3,1,0],[5,1,0],[5,2,0],[3,2,0]],[0,1,2,0,2,3]);
  const matrix=identity();if(affine==='scale'){matrix[0]=2;matrix[5]=3;}if(affine==='shear')matrix[4]=.25;if(affine==='reflection')matrix[0]=-1;
  original.doc.nodes=[{name:'Root',children:[1,3],translation:[2,3,4]},{name:'Empty ancestor',children:[2],matrix},{name:'Off-centre mesh',mesh:0},
    {name:'Empty leaf',translation:[0,2**-80,0]},{name:'Second root',mesh:0,translation:[-4,0,1]}];original.doc.scenes=[{nodes:[0,4]}];
  original.doc.materials=[{pbrMetallicRoughness:{baseColorFactor:[.2,.4,.6,1],metallicFactor:.3,roughnessFactor:.7}}];original.doc.meshes[0].primitives[0].material=0;
  original.doc.nodes[0].rotation=[0,0,Math.SQRT1_2,Math.SQRT1_2];
  if(affine==='rigid')original.doc.nodes[1].matrix=[1,0,0,0,0,0,1,0,0,-1,0,0,0,0,0,1];
  const source=pack(original.doc,original.bin),prepared=prepareGlbConversionSource(source,sha(source));
  const map:Doc={schemaVersion:2,fidelityPolicy:CONVERSION_FIDELITY_POLICY,sourceSha256:sha(source),importSha256:prepared.importSha256,
    sourceSceneIndex:prepared.sourceSceneIndex,declaredSceneCount:prepared.declaredSceneCount,parts:prepared.parts,nodes:prepared.nodes};
  const request:Doc={schemaVersion:2,fidelityPolicy:CONVERSION_FIDELITY_POLICY,kind:'converted-glb',jobId:JOB,parentJobId:PARENT,parentManifestSha256:sha('synthetic parent metadata'),
    name:'graph-model',sourceSha256:sha(source),sourceBytes:source.length,importSha256:prepared.importSha256,importBytes:prepared.importBytes.length,sourceMapSha256:'',
    collision:collision?'convex-hull':'none',renderResolution:128,renderSamples:8};
  const j=prepared.importBytes.readUInt32LE(12),output:Doc=JSON.parse(prepared.importBytes.subarray(20,20+j).toString('utf8')) as Doc,
    outputBin=Buffer.from(prepared.importBytes.subarray(28+j));output.asset.generator='Synthetic graph buffer fixture; no native proof';
  for(const part of prepared.parts)Object.assign(output.nodes[part.importNodeIndex].extras,{arcane_identity_scheme:'arcane-converted-v2',
    arcane_source_object_id:convertedGlbObjectId(request.sourceSha256,'render',part.sourceKey),arcane_source_key:part.sourceKey,arcane_role:'render',arcane_pivot:[0,0,0],arcane_collision_for:'[]'});
  // Reorder every export node. Audit indexes must refer to actual marker matches,
  // while source-map import indexes deliberately remain the original ones.
  const count=output.nodes.length;output.nodes.reverse();
  for(const n of output.nodes)if(n.children)n.children=n.children.map((at:number)=>count-1-at);
  for(const scene of output.scenes)scene.nodes=scene.nodes.map((at:number)=>count-1-at);
  const measured=prepared.parts.map(part=>({sourceKey:part.sourceKey,originMarker:part.originMarker,sourceObjectId:convertedGlbObjectId(request.sourceSha256,'render',part.sourceKey),
    vertices:4,triangles:2,boundaryEdges:4,nonManifoldEdges:4,looseVertices:0,looseEdges:0,degenerateFaces:0,invalidUVs:0,uvLayers:0,finitePositions:true,
    geometrySha256:sha('synthetic measured geometry'),correspondenceSha256:conversionCorrespondenceSha256([[0,1,2],[0,2,3]]),materialSha256:sha('synthetic measured material')}));
  const audit:Doc={schemaVersion:2,fidelityPolicy:CONVERSION_FIDELITY_POLICY,kind:'arcane-glb-conversion-audit',jobId:JOB,parentJobId:PARENT,parentManifestSha256:request.parentManifestSha256,
    requestSha256:'',sourceSha256:request.sourceSha256,importSha256:request.importSha256,sourceMapSha256:'',identityScheme:'arcane-converted-v2',assetId:convertedGlbAssetId(request.sourceSha256),
    blenderVersion:'synthetic metadata',collision:request.collision,importedParts:measured,reopenedParts:structuredClone(measured),models:[],
    renders:['preview-hero.png','preview-side.png'].map(path=>({path,width:128,height:128,finitePixels:true,minLuminance:0,maxLuminance:1,meanLuminance:.4,standardDeviation:.1})),
    savedSceneReopened:true,errors:[],warnings:['open-render-surfaces','delivery-support-pending',...(collision?[]:['no-collision-proxy'])]};
  const byKey=(key:string):Doc=>output.nodes.find((n:Doc)=>n.extras?.[CONVERSION_NODE_KEY]===key)!;
  function collisionGlb(open=false):Buffer {
    const {doc,bin}=geometry([[0,0,0],[2,0,0],[0,2,0],[0,0,2]],open?[0,2,1,0,1,3,0,3,2]:[0,2,1,0,1,3,0,3,2,1,2,3]);
    doc.asset.generator=output.asset.generator;doc.nodes[0].extras={arcane_identity_scheme:'arcane-converted-v2',arcane_source_object_id:convertedGlbObjectId(request.sourceSha256,'collision','proxy'),
      arcane_source_key:'proxy',arcane_role:'collision',arcane_pivot:[0,0,0],arcane_collision_for:JSON.stringify(prepared.parts.map(p=>convertedGlbObjectId(request.sourceSha256,'render',p.sourceKey)).sort())};
    return pack(doc,bin);
  }
  let collisionBytes=collision?collisionGlb():undefined;
  function bytes():ConvertedGraphSourceBytes {
    const sourceMapBytes=json(map);request.sourceMapSha256=sha(sourceMapBytes);const requestBytes=json(request),renderBytes=pack(output,outputBin);
    Object.assign(audit,{requestSha256:sha(requestBytes),sourceMapSha256:request.sourceMapSha256,sourceSha256:request.sourceSha256,importSha256:request.importSha256});
    audit.models=[{path:'asset.glb',sha256:sha(renderBytes),byteLength:renderBytes.length,generator:output.asset.generator,anchors:[],objects:prepared.parts.map(part=>({
      sourceObjectId:convertedGlbObjectId(request.sourceSha256,'render',part.sourceKey),sourceKey:part.sourceKey,nodeIndex:output.nodes.indexOf(byKey(part.sourceKey)),role:'render',
      pivot:[0,0,0],collisionFor:[],originMarker:part.originMarker}))}];
    if(collisionBytes)audit.models.push({path:'collision.glb',sha256:sha(collisionBytes),byteLength:collisionBytes.length,generator:output.asset.generator,anchors:[],objects:[{
      sourceObjectId:convertedGlbObjectId(request.sourceSha256,'collision','proxy'),sourceKey:'proxy',nodeIndex:0,role:'collision',pivot:[0,0,0],originMarker:null,
      collisionFor:prepared.parts.map(p=>convertedGlbObjectId(request.sourceSha256,'render',p.sourceKey)).sort()}]});
    return{requestBytes,sourceMapBytes,auditBytes:json(audit),sourceBytes:source,importBytes:prepared.importBytes,renderBytes,...(collisionBytes?{collisionBytes}:{})};
  }
  return{map,request,audit,output,outputBin,prepared,byKey,bytes,collisionGlb,setCollision(value:Buffer){collisionBytes=value;}};
}
const selection={target:{sessionId:'studio-session',placeId:0,universeId:0,root:'Workspace' as const,parentRef:'selected-parent',creator:{kind:'user' as const,id:'123'}},placement:{mode:'origin' as const},studsPerMeter:2};
function hostFixture(collision=false,affine:'rigid'|'scale'|'shear'|'reflection'='rigid'){
  const f=fixture(collision,affine);
  function host(revision=JOB):HostConvertedStudioImportV2 {
    f.request.jobId=revision;f.audit.jobId=revision;const bytes=f.bytes(),graph=buildConvertedGraph(bytes),request=parseConvertedGlbRequest(JSON.parse(bytes.requestBytes.toString('utf8')));
    const fileId=(path:string)=>path==='asset.glb'?'asset-glb':'collision-glb';
    return{schemaVersion:2,origin:'converted-glb',identityScheme:'arcane-converted-v2',projectId:sha('project'),assetId:convertedGlbAssetId(request.sourceSha256),revisionId:revision,
      sourceSha256:request.sourceSha256,producer:{blenderVersion:f.audit.blenderVersion,exporterVersion:f.output.asset.generator},...structuredClone(selection),conversionRequest:request,graph,
      files:f.audit.models.map((m:Doc)=>{const data=m.path==='asset.glb'?bytes.renderBytes:bytes.collisionBytes!;return{fileId:fileId(m.path),contentType:'model/gltf-binary' as const,sha256:sha(data),bytes:data};}),
      models:f.audit.models.map((m:Doc)=>({fileId:fileId(m.path),resources:[],objects:m.objects.map((o:Doc)=>({sourceObjectId:o.sourceObjectId,sourceKey:o.sourceKey,nodeIndex:o.nodeIndex,role:o.role,pivot:o.pivot,collisionFor:o.collisionFor}))})),anchors:[],baseline:null};
  }return{...f,host};
}
async function prepare(input:HostStudioImport){const authority=createStudioImportManifestAuthority({loadGeneratedFiles:async()=>input});try{return authority.prepare(await authority.admit(input.revisionId));}finally{authority.close();}}
async function converted(input:HostConvertedStudioImportV2):Promise<ConvertedPreparedStudioImportV2>{const result=await prepare(input);assert.equal(result.manifest.schemaVersion,2);return result as ConvertedPreparedStudioImportV2;}
const PLUGIN=sha('owned-synthetic-plugin');
// Actual controller/policy/SQLite/CWS/opaque registry, with explicitly synthetic
// source host/review ports and authenticated plugin ACKs. No engine runs here.
async function stagingFixture(t:test.TestContext,collision=false){
  const base=await realpath(tmpdir()),root=await realpath(await mkdtemp(join(base,'arcane-converted-staging-'))),projectPath=root;
  const work=new ConversationWorkStore({directory:join(root,'work'),projectPath}),conversation={provider:'codex' as const,threadId:'converted-staging',sessionId:null};work.bind({conversation,kind:'asset-job',id:JOB});
  const registry=createNativeAssetRegistry({projectPath}),incarnation=registry.issue(),binding={connectionId:'converted-stage',threadId:conversation.threadId};
  incarnation.seal({...binding,...conversation});incarnation.grant(binding);let operation='stage';incarnation.dispatched({...binding,operationId:operation});let actor=registry.capture(incarnation.credential(),'mutate');
  let store=new StudioStore({directory:join(root,'studio')});
  const grant=store.createGrant({allowedRoots:['Workspace','ServerStorage'],allowWrites:true}),pair=store.pair({code:grant.code,protocolVersion:1,capabilities:['asset.stage_packet','asset.reconstruct','scene.import_context'],identity:{clientSessionId:'converted-plugin',pluginVersion:'0.1.9',name:'Synthetic converted staging',placeId:12,universeId:34}});
  const proof=()=>({sessionId:pair.sessionId,clientLifetimeId:'converted-plugin',pluginArtifactHash:PLUGIN,markerName:'ArcaneTestProof_converted',placeId:12,universeId:34,placeName:'Synthetic converted staging',mode:'Edit',playEpoch:0,continuitySupported:true,connected:true});store.poll(pair.sessionId,proof());
  const target={sessionId:pair.sessionId,placeId:12,universeId:34,root:'Workspace' as const,parentRef:'converted-parent',creator:{kind:'group' as const,id:'56'}};
  async function bundle(padding=0){const source=hostFixture(collision);if(padding){
      assert.ok(Number.isSafeInteger(padding)&&padding>0&&padding<=64*4096);
      // Fixed array shape lets the probe include all escaping overhead while every GLB string stays bounded.
      source.output.extras={padding:Array.from({length:64},(_,index)=>'A'.repeat(Math.max(0,Math.min(4096,padding-index*4096))))};
    }const input=source.host();input.projectId=work.projectId;input.target=target;
    const prepared=await converted(input),payload=decodeStudioImportPayload(prepared,new Map(input.files.map(file=>[file.fileId,file.bytes])));assert.equal(payload.formatVersion,2);
    return {prepared,payload:payload as ConvertedStudioImportPayloadV2,transfer:createStudioImportTransfer(prepared,payload)};
  }
  let data=await bundle(),approved=true,current=true,selectionActive=false,wrongAck=false,hold=false;let bytes=0,count=0,selected=0,released=0;
  const reference={reviewId:'99999999-9999-4999-8999-999999999999',subjectDigest:sha('synthetic reviewed source host'),revision:1};
  const check=()=>{assertNativeAssetActor(actor,'mutate');if(!approved||!current)throw Object.assign(Error('Synthetic reviewed source changed'),{code:'ASSET_REVIEW_REQUIRED'});};
  const review={reference,assertCurrent:check};
  const assets={async prepareStudioImportPayload(){check();return {...data,review};},async reviewImport(){check();return review;}} as unknown as Pick<AssetService,'prepareStudioImportPayload'|'reviewImport'>;
  const host:StudioImportHostOptions={workAssociations:work,beginPreparationAttempt(_scope,_job,_actor,guard){guard();return Object.freeze({kind:'studio-import-preparation-attempt',id:randomUUID()});},
    selectTarget(_scope,_job,_actor,guard){guard();selected++;selectionActive=true;return {target,placement:{mode:'origin'},studsPerMeter:2};},validateTarget(){if(!selectionActive)throw Error('Selection is not active');},releaseTarget(){released++;selectionActive=false;}};
  const bind=()=>store.bindAssetModelReview(intent=>{assert.deepEqual(intent.modelReview,reference);check();});let release=bind(),controller=createStudioImportStagingController({projectPath,workAssociations:work,studio:store,assets,host,pluginArtifactHash:PLUGIN});
  const failures:unknown[]=[],delivered:StudioCommand[]=[];
  const pump=setInterval(()=>{if(hold)return;try{for(const command of store.poll(pair.sessionId,proof())){delivered.push(command);let result:unknown;
    if(command.method==='asset.stage_packet'){const packet=JSON.parse(command.args.packet as string);assert.equal(packet.ordinal,count);count++;bytes+=Buffer.byteLength(command.args.packet as string);result={transferDigest:data.transfer.digest,packetCount:count,byteLength:bytes+(wrongAck?1:0),state:packet.kind==='seal'?'sealed':'receiving',engineVerification:'pending'};}
    else if(command.method==='scene.import_context')result={sessionId:pair.sessionId,root:'Workspace',parentRef:{instanceId:target.parentRef,sessionId:pair.sessionId,root:'Workspace',pathSegments:[],className:'Workspace'},placeId:12,universeId:34,mode:'Edit',modeProvenance:'StudioTestService.EditModeActive',creator:{status:'available',kind:'group',id:56,provenance:'game.CreatorType/CreatorId'},studioUser:{status:'not_applicable',id:null,provenance:'StudioService:GetUserId'}};
    else {assert.equal(command.method,'asset.reconstruct');const args=command.args as unknown as StudioAssetReconstructArgs;result={runId:args.runId,transferDigest:args.expected.digest,state:'reconstructed',objects:args.objects,imported:false,engineVerification:'pending',...('formatVersion'in args&&args.formatVersion===2?{formatVersion:2,graphDigest:args.graphDigest,nodeCount:args.nodeCount,nodes:args.nodes}:{})};}
    store.result({sessionId:pair.sessionId,commandId:command.id,state:'succeeded',result:result as Json});
  }}catch(error){failures.push(error);controller.close();}},5);
  t.after(async()=>{clearInterval(pump);controller.close();release();store.close();registry.close();work.close();const child=relative(base,root);assert.ok(child.startsWith('arcane-converted-staging-')&&!isAbsolute(child)&&!child.includes('..'));await rm(root,{recursive:true,force:true});assert.deepEqual(failures,[]);});
  return {root,work,registry,pair,target,reference,conversation,failures,delivered,get store(){return store;},get controller(){return controller;},get actor(){return actor;},get data(){return data;},checks:()=>({count,bytes,selected,released}),
    reject(){approved=false;},changeSource(){current=false;},wrongAck(){wrongAck=true;},hold(){hold=true;},
    newActor(){incarnation.ended(operation);operation='reconstruct';incarnation.dispatched({...binding,operationId:operation});actor=registry.capture(incarnation.credential(),'mutate');},
    async oversized(){const probe=await bundle(1),minimal=Buffer.byteLength(JSON.stringify({packet:probe.transfer.packets[0]!.json}));data=await bundle(STUDIO_ASSET_TRANSFER_LIMITS.packetBytes-minimal-63);},
    restart(){hold=true;controller.close();release();store.close();store=new StudioStore({directory:join(root,'studio')});release=bind();controller=createStudioImportStagingController({projectPath,workAssociations:work,studio:store,assets,host,pluginArtifactHash:PLUGIN});},
  };
}
for(const collision of [false,true])test('actual converted '+(collision?'hull':'none')+' controller and SQLite journal derive sealed logical reconstruction graph',async t=>{
  const f=await stagingFixture(t,collision),staged=await f.controller.stage(JOB,f.actor);assert.equal(staged.imported,false);assert.equal(staged.engineVerification,'pending');
  const run=f.store.readStageRun(f.work.projectId,JOB)!;assert.equal(run.phase,'cpu-staged');assert.equal(Object.hasOwn(run.intent,'graph'),false);assert.equal(Object.hasOwn(run.intent,'formatVersion'),false);
  assert.equal(run.intent.plan.length,f.data.transfer.packets.length);assert.equal(f.checks().released,1);f.newActor();const reconstructed=await f.controller.reconstruct(JOB,f.actor);
  assert.ok('formatVersion'in reconstructed&&reconstructed.formatVersion===2);assert.equal(reconstructed.graphDigest,f.data.prepared.manifest.graph.digest);assert.equal(reconstructed.nodeCount,f.data.prepared.manifest.graph.nodes.length);
  const expectedNodes=f.data.transfer.packets.filter(packet=>packet.kind==='node').map(packet=>{const node=JSON.parse(packet.json).node,mesh=f.data.prepared.manifest.graph.meshes.find(row=>row.nodeKey===node.nodeKey);return {nodeKey:node.nodeKey,parentKey:node.parentKey,sourceObjectId:mesh?.sourceObjectId??null};});
  assert.deepEqual(reconstructed.nodes,expectedNodes);assert.ok(reconstructed.nodes.some(node=>node.sourceObjectId===null));assert.equal(reconstructed.imported,false);assert.equal(reconstructed.engineVerification,'pending');
  const snapshot=f.store.readStageReconstruction(f.work.projectId,JOB,run.runId)!;assert.equal('instanceRef'in reconstructed.nodes[0]!,false);f.restart();
  assert.deepEqual(f.store.readStageReconstruction(f.work.projectId,JOB,run.runId)?.receipt,snapshot.receipt);
  const status=await f.controller.reconstructionStatus(JOB,f.actor);assert.equal(status.reconstruction?.currentResources,'unobserved');assert.equal(status.reconstruction?.imported,false);
  await assert.rejects(f.controller.reconstruct(JOB,f.actor),{code:'STUDIO_RECONSTRUCT_EXISTS'});
});
test('actual complete escaped envelope overage refuses before stage claim, journal and command allocation',async t=>{
  const f=await stagingFixture(t);await f.oversized();
  assert.ok(Buffer.byteLength(JSON.stringify({packet:f.data.transfer.packets[0]!.json}))<=STUDIO_ASSET_TRANSFER_LIMITS.packetBytes);
  await assert.rejects(f.controller.stage(JOB,f.actor),(error:unknown)=>!!error&&typeof error==='object'&&'code'in error&&['BUDGET','STUDIO_STAGE_BUDGET'].includes(String(error.code)));
  assert.equal(f.store.commands().length,0);assert.equal(f.store.readStageRun(f.work.projectId,JOB),null);assertNativeAssetStageOperationAvailable(f.actor,JOB);assert.equal(f.checks().released,1);
});
for(const fault of ['review','source','wrong-ack'] as const)test('converted '+fault+' refusal preserves original once-only staging boundary',async t=>{
  const f=await stagingFixture(t);if(fault==='review')f.reject();if(fault==='source')f.changeSource();if(fault==='wrong-ack')f.wrongAck();
  await assert.rejects(f.controller.stage(JOB,f.actor));
  if(fault==='wrong-ack'){const run=f.store.readStageRun(f.work.projectId,JOB)!;assert.equal(run.phase,'needs_reconciliation');assert.equal(run.receipt,null);assert.equal(run.commands.length,1);const count=f.store.commands().length;await assert.rejects(f.controller.stage(JOB,f.actor));assert.equal(f.store.commands().length,count);}
  else {assert.equal(f.store.commands().length,0);assert.equal(f.store.readStageRun(f.work.projectId,JOB),null);assertNativeAssetStageOperationAvailable(f.actor,JOB);}
});
test('converted retained original packet tampering invalidates a previously sealed SQLite run',async t=>{
  const f=await stagingFixture(t);await f.controller.stage(JOB,f.actor);const run=f.store.readStageRun(f.work.projectId,JOB)!,node=run.commands.find(row=>JSON.parse(row.command.args.packet as string).kind==='node')!;
  const db=new DatabaseSync(join(f.root,'studio','studio.sqlite'));try{const payload=JSON.parse(String(db.prepare('SELECT payload FROM commands WHERE id=?').get(node.commandId)!.payload));const packet=JSON.parse(payload.args.packet);packet.node.name='changed saved name';payload.args.packet=JSON.stringify(packet);db.prepare('UPDATE commands SET payload=? WHERE id=?').run(JSON.stringify(payload),node.commandId);}finally{db.close();}
  assert.throws(()=>f.store.readStageRun(f.work.projectId,JOB),{code:'STUDIO_STAGE_RECEIPT'});
});
test('queued converted reconstruction survives restart as its original cancelled command without replay',async t=>{
  const f=await stagingFixture(t);await f.controller.stage(JOB,f.actor);f.hold();const run=f.store.readStageRun(f.work.projectId,JOB)!;
  const command=f.store.enqueueStageReconstruction(f.work.projectId,JOB,run.runId,()=>{});f.restart();const record=f.store.readStageReconstruction(f.work.projectId,JOB,run.runId)!;
  assert.equal(record.command.id,command.id);assert.equal(record.command.state,'cancelled');assert.equal(record.receipt,null);assert.equal(f.store.commands().filter(row=>row.method==='asset.reconstruct').length,1);
  await assert.rejects(f.controller.reconstruct(JOB,f.actor),{code:'STUDIO_RECONSTRUCT_EXISTS'});
});
test('foreign native conversation cannot stage converted bytes or spend the original actor claim',async t=>{
  const f=await stagingFixture(t),owner=f.registry.issue(),conversation={provider:'codex' as const,threadId:'foreign-conversation',sessionId:null},binding={connectionId:'foreign-connection',threadId:conversation.threadId};
  owner.seal({...binding,...conversation});owner.grant(binding);owner.dispatched({...binding,operationId:'foreign-stage'});const actor=f.registry.capture(owner.credential(),'mutate');
  await assert.rejects(f.controller.stage(JOB,actor));assert.equal(f.store.commands().length,0);assert.equal(f.store.readStageRun(f.work.projectId,JOB),null);assertNativeAssetStageOperationAvailable(f.actor,JOB);
});
test('converted reconstruction SQLite association fault rolls back queue and spends uncertain admission without replay',async t=>{
  const f=await stagingFixture(t);await f.controller.stage(JOB,f.actor);f.hold();const run=f.store.readStageRun(f.work.projectId,JOB)!,db=new DatabaseSync(join(f.root,'studio','studio.sqlite'));
  try{db.exec("CREATE TRIGGER converted_reconstruction_fault BEFORE INSERT ON asset_stage_reconstructions BEGIN SELECT RAISE(ABORT,'converted association fault'); END;");
    assert.throws(()=>f.store.enqueueStageReconstruction(f.work.projectId,JOB,run.runId,()=>{}),/converted association fault/);
    assert.equal(f.store.commands().filter(command=>command.method==='asset.reconstruct').length,0);assert.equal(f.store.readStageReconstruction(f.work.projectId,JOB,run.runId),null);
    db.exec('DROP TRIGGER converted_reconstruction_fault');assert.throws(()=>f.store.enqueueStageReconstruction(f.work.projectId,JOB,run.runId,()=>{}),{code:'STUDIO_RECONSTRUCT_EXISTS'});
  }finally{db.close();}
});
test('coherently resealed serialized graph and payload cannot substitute a non-derived source object identity',async t=>{
  const f=await stagingFixture(t),transfer=f.data.transfer;assert.equal(transfer.formatVersion,2);
  const inspected=inspectConvertedStudioImportTransfer(transfer),original=(inspected.payload.objects as Doc[]).find(row=>row.object.role==='render')!.object.sourceObjectId as string,wrong='arcane_'+sha('foreign role and source key');
  const payload=JSON.parse(JSON.stringify(inspected.payload).replaceAll(original,wrong)) as Doc;
  payload.graph.meshes.sort((a:Doc,b:Doc)=>a.sourceObjectId<b.sourceObjectId?-1:1);const {digest:_graphDigest,...graphBody}=payload.graph;payload.graph.digest=convertedGraphDigest(graphBody);
  const canonical=(value:any):string=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}':JSON.stringify(value);
  const payloadDigest=sha(canonical(payload)),bodies=transfer.packets.map(packet=>JSON.parse(packet.json.replaceAll(original,wrong)) as Doc);
  for(const body of bodies){body.payloadDigest=payloadDigest;if(body.kind==='begin'){body.graph.digest=payload.graph.digest;body.delta.graph.nextDigest=payload.graph.digest;}
    if(body.kind==='object'&&body.object.sourceObjectId===wrong)body.primitives.forEach((primitive:Doc,index:number)=>{for(const stream of [...Object.values(primitive.attributes),primitive.indices] as Doc[])stream.streamId=sha([wrong,String(index),stream.semantic].join('\0'));});
    if(body.kind==='chunk'&&body.sourceObjectId===wrong)body.streamId=sha([wrong,String(body.primitiveIndex),body.semantic].join('\0'));
  }
  const packets:Doc[]=[];let bytes=0;
  for(const [ordinal,body]of bodies.entries()){if(body.kind==='seal')Object.assign(body,{precedingPacketCount:ordinal,precedingByteLength:bytes,contentDigest:sha(packets.map(packet=>[packet.ordinal,packet.kind,packet.byteLength,packet.sha256].join(':')).join('\n'))});
    const json=JSON.stringify(body),byteLength=Buffer.byteLength(json);packets.push({ordinal,kind:body.kind,json,byteLength,sha256:sha(json)});bytes+=byteLength;
  }
  const resealed={...transfer,payloadDigest,graphDigest:payload.graph.digest,packets,byteLength:bytes,digest:sha(packets.map(packet=>packet.sha256).join('\n'))};
  assert.throws(()=>inspectConvertedStudioImportTransfer(resealed),(error:unknown)=>error instanceof Error&&'code'in error&&error.code==='IDENTITY'&&/not derived/.test(error.message));
  assert.equal(f.store.commands().length,0);assertNativeAssetStageOperationAvailable(f.actor,JOB);
});
