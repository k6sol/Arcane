import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {isAbsolute,join,relative} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {buildConvertedGraph,type ConvertedGraphSourceBytes} from '../../packages/asset-pipeline/src/studio-import-graph.js';
import {prepareGlbConversionSource} from '../../packages/asset-pipeline/src/glb-conversion-source.js';
import {convertedGlbObjectId,convertedGlbAssetId,parseConvertedGlbRequest} from '../../packages/asset-pipeline/src/converted-glb.js';
import {CONVERSION_FIDELITY_POLICY,CONVERSION_NODE_KEY,conversionCorrespondenceSha256} from '../../packages/asset-pipeline/src/conversion-fidelity-policy.js';
import {createStudioImportManifestAuthority,type HostConvertedStudioImportV2,type ConvertedPreparedStudioImportV2,type HostStudioImport,studioImportObservationReceiptDigest,snapshotConvertedStudioImportBaseline} from '../../packages/asset-pipeline/src/studio-import-manifest.js';
import {assetReviewDigest,type AssetReviewImportGuard,type AssetReviewSubject} from '../../apps/daemon/src/asset-review.js';
import type {NativeAssetActor} from '../../apps/daemon/src/native-asset-authority.js';
import type {ConvertedStudioImportPayloadV2} from '../../packages/asset-pipeline/src/studio-import-payload.js';
import type {ConvertedStudioImportTransferV2} from '../../packages/asset-pipeline/src/studio-import-transfer.js';
import {decodeStudioImportPayload} from '../../packages/asset-pipeline/src/studio-import-payload.js';
import {createStudioImportTransfer} from '../../packages/asset-pipeline/src/studio-import-transfer.js';
import {StudioStore} from '../../packages/storage/src/studio-store.js';
import {ConversationWorkStore} from '../../packages/storage/src/conversation-work-store.js';
import {READ_METHODS,WRITE_METHODS,ASSET_STAGE_METHODS,object,jsonObject,type StudioCommand,type Json,type StudioImportObservationReceipt,type StudioImportRevisionReceipt,type StudioAssetReconstructArgs} from '../../packages/protocol/src/studio.js';
import {createNativeAssetRegistry,assertNativeAssetActor,nativeAssetActorScope} from '../../apps/daemon/src/native-asset-authority.js';
import {createStudioImportHost} from '../../apps/daemon/src/studio-import-host.js';
import {createStudioImportPreparationStore} from '../../apps/daemon/src/studio-import-preparation-store.js';
import {createStudioImportObservedBaselineStore} from '../../apps/daemon/src/studio-import-observed-baseline-store.js';
import {createStudioImportStagingController} from '../../apps/daemon/src/studio-import-staging-controller.js';
import type {AssetService} from '../../apps/daemon/src/asset-service.js';
// Actual host/store/CWS/registry/compiler/queue. Constructed source/audit metadata
// and authenticated controlled plugin results are synthetic, not engine/native proof.
// The fixed GLB construction below is copied from the committed staging fixture.
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

const NEXT='33333333-3333-4333-8333-333333333333',THIRD='44444444-4444-4444-8444-444444444444',PLUGIN=sha('owned-observation-plugin');
type Bundle={prepared:ConvertedPreparedStudioImportV2;payload:ConvertedStudioImportPayloadV2;transfer:ConvertedStudioImportTransferV2};
const refused=(code:string)=>(error:unknown)=>!!error&&typeof error==='object'&&'code'in error&&error.code===code;
function fixedRef(label:string):string {const value=sha(label);return[value.slice(0,8),value.slice(8,12),value.slice(12,16),value.slice(16,20),value.slice(20,32)].join('-');}
async function baselineFixture(t:test.TestContext,collision=false){
  const boundary=await realpath(tmpdir()),root=await realpath(await mkdtemp(join(boundary,'arcane-converted-baseline-'))),projectPath=root;
  const work=new ConversationWorkStore({directory:join(root,'work'),projectPath}),conversation={provider:'codex' as const,threadId:'observed-converted',sessionId:null};
  for(const id of [JOB,NEXT,THIRD])work.bind({conversation,kind:'asset-job',id});
  const registry=createNativeAssetRegistry({projectPath}),incarnation=registry.issue(),binding={connectionId:'observed-converted',threadId:conversation.threadId};
  incarnation.seal({...binding,...conversation});incarnation.grant(binding);let operation='operation-0',counter=0;incarnation.dispatched({...binding,operationId:operation});let actor=registry.capture(incarnation.credential(),'mutate');
  const studio=new StudioStore({directory:join(root,'studio')}),grant=studio.createGrant({allowedRoots:['Workspace','ServerStorage'],allowWrites:true});
  const pair=studio.pair({code:grant.code,protocolVersion:1,capabilities:[...READ_METHODS,...WRITE_METHODS,...ASSET_STAGE_METHODS],identity:{clientSessionId:'observed-plugin',pluginVersion:'0.1.9',name:'Synthetic observation target',placeId:12,universeId:34}});
  let epoch=0,stateVersion=0,meshId:string|null=null;
  const proof=()=>({sessionId:pair.sessionId,clientLifetimeId:'observed-plugin',pluginArtifactHash:PLUGIN,markerName:'ArcaneTestProof_observation',placeId:12,universeId:34,placeName:'Synthetic observation target',mode:'Edit',playEpoch:epoch,continuitySupported:true,connected:true});studio.poll(pair.sessionId,proof());
  const context=()=>({sessionId:pair.sessionId,root:'Workspace',parentRef:{instanceId:'observed-parent',sessionId:pair.sessionId,root:'Workspace',pathSegments:[],className:'Workspace'},placeId:12,universeId:34,
    mode:'Edit',modeProvenance:'StudioTestService.EditModeActive',creator:{status:'available',kind:'group',id:56,provenance:'game.CreatorType/CreatorId'},studioUser:{status:'not_applicable',id:null,provenance:'StudioService:GetUserId'}});
  const ledger=await createStudioImportPreparationStore({projectPath,directory:join(root,'preparations'),workAssociations:work,studio});
  const host=createStudioImportHost({projectPath,workAssociations:work,studio,pluginArtifactHash:PLUGIN,persistPreparation:(...args)=>ledger.save(...args),readPreparation:(...args)=>ledger.get(...args)});
  const source=hostFixture(collision),bundles=new Map<string,Bundle>();
  const subjects=new Map<string,AssetReviewImportGuard>();let approved=true;
  function review(job:string,owner:NativeAssetActor,guard:()=>void=()=>{}):AssetReviewImportGuard {
    const data=bundles.get(job)!;
    const subject:AssetReviewSubject={schemaVersion:2,kind:'converted-glb',projectId:work.projectId,conversation,jobId:job,manifestSha256:sha('synthetic verified source manifest '+job),
      requestSha256:sha(json(data.prepared.manifest.conversionRequest)),parentJobId:PARENT,parentManifestSha256:data.prepared.manifest.conversionRequest.parentManifestSha256,
      sourceSha256:data.prepared.manifest.sourceSha256,sourceMapSha256:data.prepared.manifest.conversionRequest.sourceMapSha256,auditSha256:sha('synthetic native audit'),collision:collision?'convex-hull':'none',
      artifacts:data.prepared.manifest.files.map((file):AssetReviewSubject['artifacts'][number]=>({path:file.fileId==='asset-glb'?'asset.glb':'collision.glb',sha256:file.sha256,bytes:file.byteLength}))};
    const reference={reviewId:'99999999-9999-4999-8999-999999999999',subjectDigest:assetReviewDigest(subject),revision:1};
    const result={subject,reference,assertCurrent(){guard();assertNativeAssetActor(owner,'mutate');assert.ok(approved,'controlled model review revoked');}};subjects.set(job,result);return result;
  }
  const assets:Pick<AssetService,'prepareStudioImportPayload'|'reviewImport'>={
    async prepareStudioImportPayload(value,owner,attempt){
      assert.equal(typeof value,'string');const job=String(value),scope=nativeAssetActorScope(owner),guard=()=>assertNativeAssetActor(owner,'mutate');
      const selected=await host.hooks.selectTarget(scope,job,owner,guard);
      try{
        const input=source.host(job);input.projectId=work.projectId;input.target=selected.target;input.placement=selected.placement;input.studsPerMeter=selected.studsPerMeter;
        const baseline=host.hooks.loadObservedBaseline?await host.hooks.loadObservedBaseline(scope,input.assetId,selected.target,{jobId:job,actor:owner,guard}):null;
        input.baseline=baseline===null?null:snapshotConvertedStudioImportBaseline(baseline);
        const prepared=await converted(input),payload=decodeStudioImportPayload(prepared,new Map(input.files.map(file=>[file.fileId,file.bytes]))),transfer=createStudioImportTransfer(prepared,payload);
        const data={prepared,payload,transfer};bundles.set(job,data);
        await host.hooks.recordPrepared!(scope,job,prepared,owner,guard,attempt);return{...data,review:review(job,owner,guard)};
      }finally{host.hooks.releaseTarget!(scope,job);}
    },
    async reviewImport(value,owner,expected,guard=()=>{}){const result=review(String(value),owner,guard);assert.deepEqual(expected,result.reference);return result;},
  };
  const unbind=studio.bindAssetModelReview(intent=>{assert.ok(approved);assert.deepEqual(intent.modelReview,subjects.get(intent.jobId)!.reference);});
  const controller=createStudioImportStagingController({projectPath,workAssociations:work,studio,assets,host:host.hooks,pluginArtifactHash:PLUGIN});
  const delivered:StudioCommand[]=[],failures:unknown[]=[],counts=new Map<string,{count:number;bytes:number}>();let onObserve:(()=>boolean)|null=null,onApply:(()=>boolean)|null=null;
  const modelRef={instanceId:fixedRef('observed-model'),sessionId:pair.sessionId,root:'Workspace' as const,pathSegments:['Converted model'],className:'Model'};
  function observedState(job:string){
    const graph=bundles.get(job)!.prepared.manifest.graph;
    const nodes=graph.nodes.map(node=>({nodeKey:node.nodeKey,instanceRef:fixedRef(node.nodeKey),ownedStateSha256:sha('state-'+stateVersion+'-'+node.nodeKey),
      authoredChildren:node.nodeKey===graph.nodes[0]!.nodeKey?[{instanceRef:fixedRef('actual-preserved-script'),kind:'script' as const,stateSha256:sha('unchanged-script')}]:[]}));
    const objects=graph.meshes.map(mesh=>{const node=nodes.find(node=>node.nodeKey===mesh.nodeKey);return{sourceObjectId:mesh.sourceObjectId,instanceRef:node?.instanceRef??fixedRef(mesh.sourceObjectId),
      ownedStateSha256:node?.ownedStateSha256??sha('state-'+stateVersion+'-'+mesh.sourceObjectId),authoredChildren:node?.authoredChildren??[],meshAssetId:meshId};});
    return{modelOwnedStateSha256:sha('actual-root-'+stateVersion),nodes,objects};
  }
  const pump=setInterval(()=>{try{for(const command of studio.poll(pair.sessionId,proof())){
    delivered.push(command);let result:unknown;
    if(command.method==='scene.import_context')result=context();
    else if(command.method==='asset.stage_packet'){
      const packet=JSON.parse(command.args.packet as string),digest=object(command.args.expected).digest as string,prior=counts.get(digest)??{count:0,bytes:0};
      assert.equal(packet.ordinal,prior.count);prior.count++;prior.bytes+=Buffer.byteLength(command.args.packet as string);counts.set(digest,prior);
      result={transferDigest:digest,packetCount:prior.count,byteLength:prior.bytes,state:packet.kind==='seal'?'sealed':'receiving',engineVerification:'pending'};
    }else if(command.method==='asset.reconstruct'){
      const args=command.args as unknown as StudioAssetReconstructArgs;assert.ok('formatVersion'in args&&args.formatVersion===2);
      result={runId:args.runId,transferDigest:args.expected.digest,state:'reconstructed',objects:args.objects,imported:false,engineVerification:'pending',formatVersion:2,graphDigest:args.graphDigest,nodeCount:args.nodeCount,nodes:args.nodes};
    }else if(command.method==='scene.place_asset'){
      const state=observedState(JOB);result={ref:modelRef,mutation:{kind:'scene.place_asset',ref:modelRef,before:null,after:{descendants:state.nodes.length+1,removedScripts:0,keptScripts:1,scale:1}},converted:{formatVersion:2,receiptScope:'studio-session-observation',imported:false,engineVerification:'pending',graphDigest:bundles.get(JOB)!.prepared.manifest.graph.digest,
        conversionRequestDigest:sha(json(bundles.get(JOB)!.prepared.manifest.conversionRequest)),nodes:state.nodes,objects:state.objects}};
    }else if(command.method==='scene.observe_import'){
      if(onObserve&&!onObserve())continue;const args=command.args,source=object(args.source);
      result={...args,...observedState(String(source.jobId)),receiptScope:'live-import-observation',imported:false,engineVerification:'pending'};
    }else if(command.method==='asset.apply_revision'){
      if(onApply&&!onApply())continue;const args=command.args,source=object(args.source),current=object(object(args.currentObservation).observation);
      result={formatVersion:2,runId:args.runId,state:'applied',observationId:current.observationId,source:args.source,target:args.target,continuity:args.continuity,modelRef,
        ...observedState(String(source.jobId)),receiptScope:'live-import-revision',imported:false,engineVerification:'pending'};
    }else throw Error('Unexpected controlled fixture method '+command.method);
    studio.result({sessionId:pair.sessionId,commandId:command.id,state:'succeeded',result:jsonObject(result)});
  }}catch(error){failures.push(error);controller.close();}},5);
  t.after(async()=>{clearInterval(pump);controller.close();host.close();unbind();await ledger.close();registry.close();work.close();studio.close();const path=relative(boundary,root);assert.ok(path.startsWith('arcane-converted-baseline-')&&!isAbsolute(path)&&!path.includes('..'));await rm(root,{recursive:true,force:true});assert.deepEqual(failures,[]);});
  function nextActor(){incarnation.ended(operation);operation='operation-'+(++counter);incarnation.dispatched({...binding,operationId:operation});actor=registry.capture(incarnation.credential(),'mutate');return actor;}
  async function initial(){await controller.stage(JOB,actor);await controller.reconstruct(JOB,nextActor());
    const command=studio.enqueue({sessionId:pair.sessionId,requestId:'observed_initial_place',method:'scene.place_asset',args:{watch:'editable-'+bundles.get(JOB)!.transfer.digest,parent:context().parentRef,name:'Converted model',position:[0,0,0],yaw:0,ground:true,anchor:true,allowScripts:false}});
    while(studio.command(command.id).state!=='succeeded')await studio.waitForCommandResult(command.id,100);
  }
  return{root,projectPath,work,registry,incarnation,studio,host,ledger,controller,pair,proof,conversation,delivered,bundles,modelRef,context,initial,nextActor,get actor(){return actor;},
    get scope(){return nativeAssetActorScope(actor);},get operation(){return operation;},observe:(callback:(()=>boolean)|null)=>{onObserve=callback;},apply:(callback:(()=>boolean)|null)=>{onApply=callback;},
    changeState(){stateVersion++;},changeEpoch(){epoch++;studio.poll(pair.sessionId,proof());},unrecordedMeshId(){meshId='12345';},
    async staged(){await controller.stage(NEXT,nextActor());await controller.reconstruct(NEXT,nextActor());},
    addDisplayHistory(){for(let i=0;i<110;i++){const c=studio.enqueue({sessionId:pair.sessionId,requestId:'unrelated_context_'+i,method:'scene.import_context',args:{}});studio.poll(pair.sessionId,proof());studio.result({sessionId:pair.sessionId,commandId:c.id,state:'succeeded',result:jsonObject(context())});}},
  };
}

for(const collision of [false,true])test('converted '+(collision?'hull':'none')+' baseline uses original joined evidence and fresh actor reads, then applies once and chains the new source',{timeout:30_000},async t=>{
  const f=await baselineFixture(t,collision);await f.initial();f.addDisplayHistory();assert.equal(f.studio.commands(f.pair.sessionId).some(c=>c.method==='scene.place_asset'),false,'the display window no longer contains placement');
  await f.staged();const data=f.bundles.get(NEXT)!;assert.ok(data.prepared.delta.observation);assert.equal(data.prepared.delta.modelAssetId,null);
  assert.equal(data.prepared.delta.modelRef,f.modelRef.instanceId);assert.ok(data.prepared.delta.objects.every(object=>object.meshAssetId===null));
  assert.ok(data.prepared.delta.nodes.some(node=>node.preserveChildren.some(child=>child.instanceRef===fixedRef('actual-preserved-script'))));
  const original=data.prepared.delta.observation,applied=await f.controller.applyRevision(NEXT,f.nextActor());
  assert.equal(applied.imported,false);assert.equal(applied.engineVerification,'pending');assert.equal(applied.receiptScope,'live-import-revision');assert.deepEqual(applied.modelRef,f.modelRef);
  const write=f.delivered.filter(command=>command.method==='asset.apply_revision');assert.equal(write.length,1);
  assert.deepEqual(write[0]!.args.observation,original);assert.notEqual(object(write[0]!.args.currentObservation).commandId,original.commandId);
  assert.notEqual(applied.observationId,original.observation.observationId);assert.ok(applied.objects.every(object=>object.meshAssetId===null));
  const status=await f.controller.revisionStatus(NEXT,f.registry.capture(f.incarnation.credential(),'read'));
  assert.equal(status.revision?.commandId,applied.commandId);assert.equal(status.revision?.retry,false);assert.equal(status.revision?.currentResources,'unobserved');assert.equal(status.revision?.receipt?.source.jobId,NEXT);
  await assert.rejects(()=>f.controller.applyRevision(NEXT,f.actor),refused('STUDIO_REVISE_EXISTS'));assert.equal(f.delivered.filter(command=>command.method==='asset.apply_revision').length,1);
  await f.controller.stage(THIRD,f.nextActor());assert.equal(f.bundles.get(THIRD)!.prepared.delta.observation!.observation.source.jobId,NEXT,'a later revision discovers the actual applied tip');
});

test('known serialized baseline metadata cannot revive private custody in another provider',{timeout:30_000},async t=>{
  const f=await baselineFixture(t);await f.initial();await f.staged();const observation=f.bundles.get(NEXT)!.prepared.delta.observation!;
  const fresh=createStudioImportObservedBaselineStore({projectPath:f.projectPath,workAssociations:f.work,studio:f.studio,pluginArtifactHash:PLUGIN,readPreparation:(...args)=>f.ledger.get(...args)});
  assert.throws(()=>fresh.validate(f.scope,NEXT,f.actor,structuredClone(observation),()=>{}),refused('STUDIO_IMPORT_OBSERVATION'));fresh.close();
  for(const method of ['scene.observe_import','asset.apply_revision'] as const){const command=f.delivered.find(row=>row.method===method)??f.delivered.find(row=>row.method==='scene.observe_import')!;
    assert.throws(()=>f.studio.enqueue({sessionId:f.pair.sessionId,requestId:command.requestId,method,args:command.args}),refused('ASSET_STAGE_AUTHORITY'));}
});

test('changed live owned state refuses fresh application without changing its sealed baseline',{timeout:30_000},async t=>{
  const f=await baselineFixture(t);await f.initial();await f.staged();const before=JSON.stringify(f.bundles.get(NEXT)!.prepared.delta);f.changeState();
  await assert.rejects(()=>f.controller.applyRevision(NEXT,f.nextActor()),refused('STUDIO_IMPORT_OBSERVATION'));
  assert.equal(JSON.stringify(f.bundles.get(NEXT)!.prepared.delta),before);assert.equal(f.delivered.some(command=>command.method==='asset.apply_revision'),false);
});

test('epoch change during the current read cannot admit an application',{timeout:30_000},async t=>{
  const f=await baselineFixture(t);await f.initial();await f.staged();f.observe(()=>{f.changeEpoch();return true;});
  await assert.rejects(()=>f.controller.applyRevision(NEXT,f.nextActor()),refused('STUDIO_IMPORT_CONTINUITY'));
  assert.equal(f.delivered.some(command=>command.method==='asset.apply_revision'),false);
});

test('delivered application with an unknown ACK is retained for status and never queued again',{timeout:30_000},async t=>{
  const f=await baselineFixture(t);await f.initial();await f.staged();let current=true;f.apply(()=>{current=false;return false;});
  await assert.rejects(()=>f.controller.applyRevision(NEXT,f.nextActor(),()=>{if(!current)throw Object.assign(Error('controlled caller closed'),{code:'CLOSED'});}),refused('CLOSED'));
  const read=f.registry.capture(f.incarnation.credential(),'read'),status=await f.controller.revisionStatus(NEXT,read);
  assert.equal(status.revision?.state,'needs_reconciliation');assert.equal(status.revision?.receipt,null);assert.equal(status.revision?.retry,false);
  await assert.rejects(()=>f.controller.applyRevision(NEXT,f.actor),refused('STUDIO_REVISE_EXISTS'));assert.equal(f.delivered.filter(command=>command.method==='asset.apply_revision').length,1);
});

test('retained preparation tamper during a fresh read refuses before application',{timeout:30_000},async t=>{
  const f=await baselineFixture(t);await f.initial();await f.staged();const old=f.studio.readStageRun(f.work.projectId,JOB)!,path=join(f.root,'preparations',old.intent.preparationAttemptId!+'.json');
  const before=readFileSync(path);f.observe(()=>{const body=JSON.parse(before.toString('utf8'));body.recordSha256='0'.repeat(64);writeFileSync(path,JSON.stringify(body));return true;});
  await assert.rejects(()=>f.controller.applyRevision(NEXT,f.nextActor()),refused('STUDIO_IMPORT_PREPARATION_CORRUPT'));
  assert.equal(f.delivered.some(command=>command.method==='asset.apply_revision'),false);
});

test('fresh read cannot invent persistent mesh IDs without an actual successful keep',{timeout:30_000},async t=>{
  const f=await baselineFixture(t);await f.initial();f.unrecordedMeshId();
  await assert.rejects(()=>f.controller.stage(NEXT,f.nextActor()),refused('STUDIO_IMPORT_SOURCE'));
  assert.equal(f.studio.readStageRun(f.work.projectId,NEXT),null);assert.equal(f.delivered.some(command=>command.method==='asset.apply_revision'),false);
});

test('tampered original raw stage packet refuses baseline discovery rather than using its journal label',{timeout:30_000},async t=>{
  const f=await baselineFixture(t);await f.initial();const run=f.studio.readStageRun(f.work.projectId,JOB)!,command=run.commands[0]!.command;
  const db=new DatabaseSync(join(f.root,'studio','studio.sqlite'));try{const row=db.prepare('SELECT payload FROM commands WHERE id=?').get(command.id);assert.ok(row&&typeof row.payload==='string');const body=JSON.parse(row.payload),packet=JSON.parse(body.args.packet);packet.sourceSha256='0'.repeat(64);body.args.packet=JSON.stringify(packet);db.prepare('UPDATE commands SET payload=? WHERE id=?').run(JSON.stringify(body),command.id);}finally{db.close();}
  const observations=f.delivered.filter(command=>command.method==='scene.observe_import').length;
  await assert.rejects(()=>f.controller.stage(NEXT,f.nextActor()),refused('STUDIO_STAGE_RECEIPT'));
  assert.equal(f.delivered.filter(command=>command.method==='scene.observe_import').length,observations);assert.equal(f.studio.readStageRun(f.work.projectId,NEXT),null);
});

test('foreign native conversation cannot use the known prepared revision or observe its old model',{timeout:30_000},async t=>{
  const f=await baselineFixture(t);await f.initial();await f.staged();const registry=createNativeAssetRegistry({projectPath:f.projectPath}),incarnation=registry.issue(),binding={connectionId:'foreign-converted',threadId:'another-conversation'};
  try{incarnation.seal({...binding,provider:'codex',sessionId:null});incarnation.grant(binding);incarnation.dispatched({...binding,operationId:'foreign-op'});
    const before=f.delivered.length;await assert.rejects(()=>f.controller.applyRevision(NEXT,registry.capture(incarnation.credential(),'mutate')),refused('NOT_FOUND'));
    assert.equal(f.delivered.length,before);assert.equal(f.delivered.some(command=>command.method==='asset.apply_revision'),false);
  }finally{registry.close();}
});

test('retiring the current actor while its observation ACK is held cannot arm application',{timeout:30_000},async t=>{
  const f=await baselineFixture(t);await f.initial();await f.staged();f.observe(()=>{f.incarnation.ended(f.operation);return false;});
  await assert.rejects(()=>f.controller.applyRevision(NEXT,f.nextActor()),refused('NATIVE_ASSET_AUTHORITY'));
  assert.equal(f.delivered.some(command=>command.method==='asset.apply_revision'),false);assert.equal((await f.controller.revisionStatus(NEXT,f.registry.capture(f.incarnation.credential(),'read'))).revision,null);
});
