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
import {mkdtemp,realpath,rm,readFile,writeFile} from 'node:fs/promises';
import {join,relative,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {StudioStore} from '../../packages/storage/src/studio-store.js';
import {ConversationWorkStore} from '../../packages/storage/src/conversation-work-store.js';
import {createNativeAssetRegistry,assertNativeAssetActor} from '../../apps/daemon/src/native-asset-authority.js';
import {createStudioImportStagingController} from '../../apps/daemon/src/studio-import-staging-controller.js';
import type {AssetService} from '../../apps/daemon/src/asset-service.js';
import type {StudioImportHostOptions} from '../../apps/daemon/src/asset-import-adapter.js';
import {validateMeshKeepReceipt,snapshotConvertedMeshKeepObservation,type ConvertedMeshKeepExpected,type MeshKeepMeshReceipt} from '../../packages/core/src/mesh-keep-policy.js';
import {createMeshKeep,MESH_KEEP_CONSENT_MESSAGE} from '../../apps/daemon/src/mesh-keep-routes.js';
import {importContextFixture} from './studio-import-context-fixture.js';
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
  const grant=store.createGrant({allowedRoots:['Workspace','ServerStorage'],allowWrites:true}),pair=store.pair({code:grant.code,protocolVersion:1,capabilities:['asset.stage_packet','asset.reconstruct','scene.import_context','scene.upload_context','scene.place_asset','scene.children','asset.keep_mesh'],identity:{clientSessionId:'converted-plugin',pluginVersion:'0.1.9',name:'Synthetic converted staging',placeId:12,universeId:34}});
  const proof=()=>({sessionId:pair.sessionId,clientLifetimeId:'converted-plugin',pluginArtifactHash:PLUGIN,markerName:'ArcaneTestProof_converted',placeId:12,universeId:34,placeName:'Synthetic converted staging',mode:'Edit',playEpoch:0,continuitySupported:true,connected:true});store.poll(pair.sessionId,proof());
  const target={sessionId:pair.sessionId,placeId:12,universeId:34,root:'Workspace' as const,parentRef:'converted-parent',creator:{kind:'group' as const,id:'56'}};
  async function bundle(padding=0){const source=hostFixture(collision);if(padding)source.output.extras={padding:'A'.repeat(padding)};const input=source.host();input.projectId=work.projectId;input.target=target;
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
  return {root,work,registry,pair,target,reference,conversation,failures,delivered,proof,get store(){return store;},get controller(){return controller;},get actor(){return actor;},get data(){return data;},checks:()=>({count,bytes,selected,released}),
    reject(){approved=false;},changeSource(){current=false;},wrongAck(){wrongAck=true;},hold(){hold=true;},
    newActor(){incarnation.ended(operation);operation='reconstruct';incarnation.dispatched({...binding,operationId:operation});actor=registry.capture(incarnation.credential(),'mutate');},
    async oversized(){const probe=await bundle(1),minimal=Buffer.byteLength(JSON.stringify({packet:probe.transfer.packets[0]!.json}));data=await bundle(STUDIO_ASSET_TRANSFER_LIMITS.packetBytes-minimal-63);},
    restart(){hold=true;controller.close();release();store.close();store=new StudioStore({directory:join(root,'studio')});release=bind();controller=createStudioImportStagingController({projectPath,workAssociations:work,studio:store,assets,host,pluginArtifactHash:PLUGIN});},
  };
}

// Actual controller, SQLite associations and host keep journal; every plugin ACK
// below is synthetic. These tests cannot prove engine upload or pivot persistence.
const CONSENT='e'.repeat(64);
function observations(expected:ConvertedMeshKeepExpected,meshes:readonly MeshKeepMeshReceipt[]){
  const nodes=expected.nodes.map(row=>({nodeKey:row.nodeKey,instanceRef:randomUUID(),ownedStateSha256:sha('synthetic observed '+row.nodeKey),authoredChildren:[]}));
  const objects=expected.meshes.map((row,index)=>{
    const node=row.nodeKey===null?undefined:nodes.find(n=>n.nodeKey===row.nodeKey);
    return {sourceObjectId:row.sourceObjectId,instanceRef:node?.instanceRef??randomUUID(),ownedStateSha256:node?.ownedStateSha256??sha('synthetic derived collision'),authoredChildren:[],meshAssetId:String(meshes[index]!.assetId)};
  });
  return {formatVersion:2,receiptScope:'studio-session-observation',imported:false,engineVerification:'pending',graphDigest:expected.graphDigest,conversionRequestDigest:expected.conversionRequestDigest,nodes,objects};
}
async function keepFixture(t:test.TestContext,collision=false){
  const f=await stagingFixture(t,collision);await f.controller.stage(JOB,f.actor);f.newActor();await f.controller.reconstruct(JOB,f.actor);f.hold();
  const commands=f.store.commands(f.pair.sessionId),reconstructed=commands.find(c=>c.method==='asset.reconstruct')!;
  const inspected=inspectConvertedStudioImportTransfer(f.data.transfer);
  const nodes=f.data.transfer.packets.filter(p=>p.kind==='node').map(p=>(JSON.parse(p.json) as {node:{nodeKey:string;parentKey:string|null}}).node);
  const expected:ConvertedMeshKeepExpected={transferDigest:f.data.transfer.digest,graphDigest:inspected.graph.digest,conversionRequestDigest:inspected.conversionRequestDigest,nodes,meshes:f.data.payload.objects.map(row=>row.association)};
  const parent={instanceId:f.target.parentRef,sessionId:f.pair.sessionId,root:'Workspace',pathSegments:[],className:'Workspace'};
  const place=f.store.enqueue({sessionId:f.pair.sessionId,requestId:'converted-keep-place',method:'scene.place_asset',args:{watch:'editable-'+f.data.transfer.digest,parent,name:'Converted tree',position:[0,0,0],yaw:0,ground:true,anchor:true,allowScripts:false}});
  f.store.poll(f.pair.sessionId,f.proof());
  const ref={...parent,instanceId:randomUUID(),pathSegments:['Converted tree'],className:'Model'};
  f.store.result({sessionId:f.pair.sessionId,commandId:place.id,state:'succeeded',result:{ref,mutation:{kind:'scene.place_asset',ref,before:null,after:{descendants:expected.nodes.length+1,removedScripts:0,keptScripts:0,scale:1}}}});
  const {observation}=importContextFixture();
  const keep=createMeshKeep({store:f.store,stateDirectory:f.root,sleep:async()=>{
    for(const command of f.store.poll(f.pair.sessionId,f.proof())){
      assert.equal(command.method,'scene.upload_context');
      f.store.result({sessionId:f.pair.sessionId,commandId:command.id,state:'succeeded',result:{...observation,sessionId:f.pair.sessionId,parentRef:{...observation.parentRef,sessionId:f.pair.sessionId},uploader:{status:'available',id:78,provenance:'StudioService:GetUserId'}} as unknown as Json});
    }
  }});
  const meshes:MeshKeepMeshReceipt[]=expected.meshes.map((_row,index)=>({index:index+1,name:'Synthetic mesh '+index,assetId:9000+index,upload:'succeeded',reason:null,swapped:true}));
  const receipt=()=>({state:'kept',meshes,uploadsStarted:meshes.length,swapped:meshes.length,persistence:'saved-asset',creatorId:78,ref,converted:observations(expected,meshes)});
  async function start(){keep.enableConsentChannel();const preparation=await keep.prepare({digest:f.data.transfer.digest,sessionId:f.pair.sessionId});
    assert.equal(keep.acceptConsent({type:MESH_KEEP_CONSENT_MESSAGE,protocolVersion:1,prepareId:preparation.prepareId,consent:CONSENT}),true);
    const started=await keep.start({prepareId:preparation.prepareId,consent:CONSENT});return {preparation,started};
  }
  function answer(value:unknown){const commands=f.store.poll(f.pair.sessionId,f.proof()).filter(c=>c.method==='asset.keep_mesh');assert.equal(commands.length,1);const command=commands[0]!;
    f.store.result({sessionId:f.pair.sessionId,commandId:command.id,state:'succeeded',result:value as Json});return command;
  }
  return {...f,keep,expected,reconstructed,meshes,receipt,start,answer,file:join(f.root,'mesh-keep','receipts.json')};
}

for(const collision of [false,true])test('converted '+(collision?'hull':'none')+' keep correlates original staged graph and persists detached historical observations',async t=>{
  const f=await keepFixture(t,collision),{started}=await f.start(),raw=f.receipt();f.answer(raw);
  const state=await f.keep.state(),record=state.receipts.find(row=>row.attemptId===started.receipt.attemptId)!;
  assert.equal(record.state,'kept');assert.ok(record.converted);assert.equal(record.converted.imported,false);assert.equal(record.converted.engineVerification,'pending');
  assert.deepEqual(record.converted.nodes.map(n=>n.nodeKey),f.expected.nodes.map(n=>n.nodeKey));assert.deepEqual(record.converted.objects.map(o=>o.meshAssetId),f.meshes.map(m=>String(m.assetId)));
  raw.converted.nodes[0]!.instanceRef=randomUUID();assert.notEqual(record.converted.nodes[0]!.instanceRef,raw.converted.nodes[0]!.instanceRef);
  assert.ok(Object.isFrozen(record.converted)&&Object.isFrozen(record.converted.nodes));
  const persisted=JSON.parse(await readFile(f.file,'utf8')) as {receipts:{converted:unknown}[]};assert.deepEqual(persisted.receipts[0]!.converted,JSON.parse(JSON.stringify(record.converted)));
  const count=f.store.commands().length,reopened=createMeshKeep({store:f.store,stateDirectory:f.root}),history=await reopened.state();assert.deepEqual(history.receipts[0]!.converted,record.converted);assert.equal(f.store.commands().length,count,'historical observations never replay uploads');
});

test('converted keep requires genuine consent and a consumed confirmation cannot upload twice',async t=>{
  const f=await keepFixture(t);f.keep.enableConsentChannel();const p=await f.keep.prepare({digest:f.data.transfer.digest,sessionId:f.pair.sessionId});
  await assert.rejects(f.keep.start({prepareId:p.prepareId,consent:CONSENT}),{code:'MESH_KEEP_CONSENT'});
  assert.equal(f.store.commands().some(c=>c.method==='asset.keep_mesh'),false);
  const {preparation}=await f.start();await assert.rejects(f.keep.start({prepareId:preparation.prepareId,consent:CONSENT}),{code:'MESH_KEEP_CONSENT'});
  assert.equal(f.store.commands().filter(c=>c.method==='asset.keep_mesh').length,1);
});

test('changed original staged packet leaves real returned mesh IDs unresolved without replay',async t=>{
  const f=await keepFixture(t),{started}=await f.start();f.answer(f.receipt());
  const db=new DatabaseSync(join(f.root,'studio','studio.sqlite'));
  try{const packet=f.store.commands().find(c=>c.method==='asset.stage_packet')!;const row=db.prepare('SELECT payload FROM commands WHERE id=?').get(packet.id) as {payload:string};const value=JSON.parse(row.payload);value.args.packet+=' ';db.prepare('UPDATE commands SET payload=? WHERE id=?').run(JSON.stringify(value),packet.id);}finally{db.close();}
  const state=await f.keep.state(),record=state.receipts.find(r=>r.attemptId===started.receipt.attemptId)!;assert.equal(record.state,'unknown');assert.equal(record.converted,undefined);assert.deepEqual(record.assets.map(a=>a.assetId),f.meshes.map(m=>m.assetId));
  const count=f.store.commands().filter(c=>c.method==='asset.keep_mesh').length;await f.keep.state();assert.equal(f.store.commands().filter(c=>c.method==='asset.keep_mesh').length,count);
});

test('converted complete swap cannot silently become a graphless legacy success',async t=>{
  const f=await keepFixture(t),{started}=await f.start(),{converted:_observation,...legacy}=f.receipt();f.answer(legacy);
  const record=(await f.keep.state()).receipts.find(r=>r.attemptId===started.receipt.attemptId)!;assert.equal(record.state,'unknown');assert.equal(record.converted,undefined);assert.deepEqual(record.assets.map(a=>a.assetId),f.meshes.map(m=>m.assetId));
});

test('host converted intent pin refuses graphless downgrade after both durable lookup identities disappear',async t=>{
  const f=await keepFixture(t),{started}=await f.start(),source=f.store.readStageKeepSource(f.pair.sessionId,f.data.transfer.digest)!;
  const pin=JSON.parse(await readFile(f.file,'utf8')).receipts[0].convertedSource;assert.equal(pin.runId,source.run.runId);assert.equal(pin.transferDigest,f.data.transfer.digest);
  const {converted:_observation,...legacy}=f.receipt();f.answer(legacy);
  const db=new DatabaseSync(join(f.root,'studio','studio.sqlite'));
  try{
    const run=JSON.parse(String(db.prepare('SELECT payload FROM asset_stage_attempts WHERE run_id=?').get(source.run.runId)!.payload));run.intent.transferDigest=sha('changed original digest');
    db.prepare('UPDATE asset_stage_attempts SET payload=? WHERE run_id=?').run(JSON.stringify(run),source.run.runId);
    const command=JSON.parse(String(db.prepare('SELECT payload FROM commands WHERE id=?').get(f.reconstructed.id)!.payload));command.args.expected.digest=sha('changed reconstruction digest');
    db.prepare('UPDATE commands SET payload=? WHERE id=?').run(JSON.stringify(command),f.reconstructed.id);
  }finally{db.close();}
  assert.equal(f.store.readStageKeepSource(f.pair.sessionId,f.data.transfer.digest),null);
  const record=(await f.keep.state()).receipts.find(r=>r.attemptId===started.receipt.attemptId)!;assert.equal(record.state,'unknown');assert.equal(record.converted,undefined);assert.deepEqual(record.convertedSource,pin);assert.deepEqual(record.assets.map(a=>a.assetId),f.meshes.map(m=>m.assetId));
});

test('historical converted keep resolves exact original SQLite custody beyond the newest 100 commands',async t=>{
  const f=await keepFixture(t),{started}=await f.start();f.answer(f.receipt());
  for(let i=0;i<105;i++){
    const command=f.store.enqueue({sessionId:f.pair.sessionId,requestId:'converted-keep-later-read-'+i,method:'scene.children',args:{root:'Workspace',limit:1}});
    const polled=f.store.poll(f.pair.sessionId,f.proof());assert.equal(polled[0]!.id,command.id);
    f.store.result({sessionId:f.pair.sessionId,commandId:command.id,state:'succeeded',result:{children:[]}});
  }
  assert.equal(f.store.commands(f.pair.sessionId).some(c=>c.id===f.reconstructed.id),false);
  const historical=f.store.readStageKeepSource(f.pair.sessionId,f.data.transfer.digest);assert.equal(historical?.reconstruction.command.id,f.reconstructed.id);assert.equal(historical?.run.commands.length,f.data.transfer.packets.length);
  assert.equal(f.store.readStageKeepSource('foreign-session',f.data.transfer.digest),null);assert.equal(f.store.readStageKeepSource(f.pair.sessionId,sha('foreign transfer')),null);
  const record=(await f.keep.state()).receipts.find(r=>r.attemptId===started.receipt.attemptId)!;assert.equal(record.state,'kept');assert.ok(record.converted);
});

test('Finish keeping reuses exact converted mesh IDs and records observations only after the full swap',async t=>{
  const f=await keepFixture(t),{started}=await f.start(),raw=f.receipt(),{converted:_observation,...common}=raw;
  f.answer({...common,state:'uploaded',persistence:'studio-session-only',swapped:0,meshes:common.meshes.map(m=>({...m,swapped:false}))});
  let record=(await f.keep.state()).receipts.find(r=>r.attemptId===started.receipt.attemptId)!;assert.equal(record.state,'uploaded');assert.equal(record.converted,undefined);
  await f.keep.finish({attemptId:record.attemptId});const reused={...raw,meshes:raw.meshes.map(m=>({...m,upload:'reused'})),uploadsStarted:0};const command=f.answer(reused);
  assert.equal(command.args.finish,true);assert.deepEqual(command.args.assetIds,f.meshes.map(m=>m.assetId));
  record=(await f.keep.state()).receipts.find(r=>r.attemptId===started.receipt.attemptId)!;assert.equal(record.state,'kept');assert.ok(record.converted);assert.equal(f.store.commands().filter(c=>c.method==='asset.keep_mesh').length,2);
});

test('partial converted upload retains returned IDs without inventing graph observations',async t=>{
  const f=await keepFixture(t,true),{started}=await f.start(),raw=f.receipt();
  raw.meshes[0]={...raw.meshes[0]!,assetId:null,upload:'failed',reason:'ENGINE_REJECTED',swapped:false};raw.meshes=raw.meshes.map(m=>({...m,swapped:false}));
  const {converted:_observation,...partial}=raw;f.answer({...partial,state:'partial',swapped:0,persistence:'studio-session-only'});
  const record=(await f.keep.state()).receipts.find(r=>r.attemptId===started.receipt.attemptId)!;assert.equal(record.state,'partial');assert.equal(record.converted,undefined);assert.equal(record.assets[0]!.assetId,null);assert.ok(record.assets.slice(1).every(a=>a.assetId!==null));
});

test('converted receipt rejects wrong graph, source IDs, returned asset IDs, references and hidden hostile metadata',async t=>{
  const f=await keepFixture(t),args={source:'editable-'+f.data.transfer.digest,creatorId:78,finish:false},raw=f.receipt();
  const valid=validateMeshKeepReceipt(args,raw,f.expected);assert.ok('converted'in valid);assert.notEqual(valid.converted,raw.converted);
  assert.ok(Object.isFrozen(snapshotConvertedMeshKeepObservation(raw.converted,raw.meshes,f.expected).objects));
  assert.throws(()=>validateMeshKeepReceipt({...args,source:'editable-'+sha('foreign transfer')},raw,f.expected),{code:'RECEIPT'});
  const uppercase=structuredClone(raw);for(const row of [...uppercase.converted.nodes,...uppercase.converted.objects])row.instanceRef=row.instanceRef.toUpperCase();assert.ok('converted'in validateMeshKeepReceipt(args,uppercase,f.expected),'Registry UUID case is retained exactly.');
  const changes=[(r:Doc)=>{r.converted.graphDigest=sha('other graph');},(r:Doc)=>{r.converted.objects[0].sourceObjectId='arcane_'+sha('other source');},(r:Doc)=>{r.converted.objects[0].meshAssetId='12345';},(r:Doc)=>{r.converted.objects[0].instanceRef=randomUUID();},(r:Doc)=>{r.converted.nodes.pop();},(r:Doc)=>{r.converted.imported=true;},(r:Doc)=>{r.converted.objects[0].authoredChildren=['foreign'];}];
  for(const change of changes){const changed=structuredClone(raw);change(changed);assert.throws(()=>validateMeshKeepReceipt(args,changed,f.expected),{code:'RECEIPT'});}
  let reads=0;const getter=structuredClone(raw);Object.defineProperty(getter.converted.nodes[0]!,'instanceRef',{get(){reads++;throw Error('never');},enumerable:true});assert.throws(()=>validateMeshKeepReceipt(args,getter,f.expected));assert.equal(reads,0);
  const proxy=new Proxy(raw,{ownKeys(){reads++;throw Error('never');}});assert.throws(()=>validateMeshKeepReceipt(args,proxy,f.expected));assert.equal(reads,0);
  for(const mutate of [(r:Doc)=>Object.defineProperty(r.converted,'hidden',{value:1}), (r:Doc)=>{r.converted[Symbol('hidden')]=1;},(r:Doc)=>{delete r.converted.nodes[0];}]){const changed=structuredClone(raw);mutate(changed);assert.throws(()=>validateMeshKeepReceipt(args,changed,f.expected));}
});

test('malformed historical converted observations leave existing journal bytes untouched',async t=>{
  const f=await keepFixture(t);await f.start();f.answer(f.receipt());await f.keep.state();
  const stored=JSON.parse(await readFile(f.file,'utf8'));stored.receipts[0].converted.objects[0].meshAssetId='999999';const damaged=JSON.stringify(stored);await writeFile(f.file,damaged);
  const reopened=createMeshKeep({store:f.store,stateDirectory:f.root});await assert.rejects(reopened.state(),{code:'MESH_KEEP_RECEIPTS'});assert.equal(await readFile(f.file,'utf8'),damaged);
});

test('generated graphless keep receipt preserves its exact serialized fields and negative checks',()=>{
  const args={source:'editable-'+sha('generated transfer'),creatorId:78,finish:false};
  const raw={state:'kept',meshes:[{index:1,name:'Generated mesh',assetId:9012,upload:'succeeded',reason:null,swapped:true}],uploadsStarted:1,swapped:1,persistence:'saved-asset',creatorId:78,ref:null};
  assert.equal(JSON.stringify(validateMeshKeepReceipt(args,raw)),JSON.stringify(raw));assert.equal('converted'in validateMeshKeepReceipt(args,raw),false);
  assert.throws(()=>validateMeshKeepReceipt(args,{...raw,extra:true}));assert.throws(()=>validateMeshKeepReceipt({...args,creatorId:79},raw));assert.throws(()=>validateMeshKeepReceipt({...args,finish:true,assetIds:[9012]},raw));
});
