import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,realpath,rm} from 'node:fs/promises';
import {join,relative,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {createAssetService,type AssetService} from '../../apps/daemon/src/asset-service.js';
import {createAssetConversationHost} from '../../apps/daemon/src/asset-conversation-host.js';
import {createNativeAssetRegistry} from '../../apps/daemon/src/native-asset-authority.js';
import {AssetReviewStore} from '../../apps/daemon/src/asset-review-store.js';
import {assetReviewCanonical,type AssetReviewReceiptAuthority} from '../../apps/daemon/src/asset-review.js';
import {ConversationWorkStore} from '../../packages/storage/src/conversation-work-store.js';
import {AssetPipeline,makeConvertedGlbCreation} from '../../packages/asset-pipeline/src/index.js';
import {convertedGlbAssetId,convertedGlbObjectId,GLB_CONVERSION_WORKERS} from '../../packages/asset-pipeline/src/converted-glb.js';
import {CONVERSION_FIDELITY_POLICY,CONVERSION_NODE_KEY,conversionCorrespondenceSha256} from '../../packages/asset-pipeline/src/conversion-fidelity-policy.js';
import {prepareGlbConversionSource} from '../../packages/asset-pipeline/src/glb-conversion-source.js';
import {parseConvertedGlbManifest} from '../../packages/asset-pipeline/src/converted-glb-manifest.js';
import type {Artifact} from '../../packages/asset-pipeline/src/types.js';
import type {ConvertedGraphSourceBytes} from '../../packages/asset-pipeline/src/studio-import-graph.js';
import {inspectConvertedStudioImportTransfer} from '../../packages/asset-pipeline/src/studio-import-transfer.js';
// Actual service/data integration with synthetic producer declarations; no native or Studio execution.
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
function graphFixture(collision=false,affine:'rigid'|'scale'|'shear'|'reflection'='rigid'){
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

// Source geometry, correspondence, graph compilation, payload decoding and transfer
// sealing are real data operations. Ancillary Blender scene/render/worker audit
// declarations are synthetic behind the explicitly mocked producer validator.
// This proves service integration, never native execution or Studio acceptance.
const h=sha;
const refused=(code:string)=>(value:unknown)=>!!value&&typeof value==='object'&&'code'in value&&value.code===code;
function metadata(parentRaw:Buffer,source:Buffer,collision:'none'|'convex-hull',affine:'rigid'|'scale'='rigid'){
  const core=graphFixture(collision==='convex-hull',affine),parent=JSON.parse(parentRaw.toString('utf8')) as {jobId:string};
  assert.deepEqual(core.bytes().sourceBytes,source);
  Object.assign(core.request,{parentJobId:parent.jobId,parentManifestSha256:sha(parentRaw),name:'review-fixture'});
  Object.assign(core.audit,{parentJobId:parent.jobId,parentManifestSha256:sha(parentRaw)});
  const b=core.bytes(),files=new Map<string,Buffer>([
    ['request.json',b.requestBytes],['source-map.json',b.sourceMapBytes],['conversion-audit.json',b.auditBytes],
    ['source.glb',b.sourceBytes],['import-source.glb',b.importBytes],['asset.glb',b.renderBytes],['parent-manifest.json',parentRaw],
    ...(b.collisionBytes?[['collision.glb',b.collisionBytes] as [string,Buffer]]:[]),
  ]);
  for(const path of GLB_CONVERSION_WORKERS)files.set(path,Buffer.from('# synthetic never executed'));
  files.set('asset.blend',Buffer.from('Synthetic scene declaration; no native evidence.'));
  for(const path of ['preview-hero.png','preview-side.png'])files.set(path,Buffer.from('Synthetic preview declaration; no native pixels.'));
  const role=(path:string):Artifact['role']=>path.endsWith('.py')?'worker':path==='asset.blend'?'scene':path.startsWith('preview-')?'preview':
    path==='conversion-audit.json'?'audit':path==='asset.glb'||path==='collision.glb'?'export':'request';
  const manifest=parseConvertedGlbManifest({schemaVersion:2,origin:'converted-glb',jobId:JOB,createdAt:'2026-10-27T00:00:00Z',
    request:core.request,sourceMap:core.map,validation:core.audit,
    artifacts:[...files].map(([path,bytes])=>({path,role:role(path),bytes:bytes.length,sha256:sha(bytes)})),
    limitations:['Synthetic ancillary producer declarations; actual graph and mesh buffers; no engine proof.'],
    runtime:{executable:'synthetic/never-executed',version:core.audit.blenderVersion,pythonVersion:'synthetic metadata',background:true,
      capabilities:{glbExport:true,glbImport:true,fbxExport:true,fbxImport:true,cycles:true}},
    workerBundleSha256:sha(GLB_CONVERSION_WORKERS.map(path=>sha(files.get(path)!)).join('\n')),
    coordinateSystem:{units:'meters',sceneUp:'Z',glbUp:'Y',pivot:'source',robloxScaleVerified:false}});
  return {manifest,files};
}
async function fixture(t:test.TestContext,collision:'none'|'convex-hull'='none',affine:'rigid'|'scale'='rigid'){
  const state='succeeded';
  const spawn=t.mock.method(childProcess,'spawn',()=>{throw Error('Review policy fixture cannot launch native processes.');});syncBuiltinESMExports();
  t.after(()=>{spawn.mock.restore();syncBuiltinESMExports();});
  const boundary=await realpath(tmpdir()),directory=await realpath(await mkdtemp(join(boundary,'arcane-converted-review-service-'))),project=join(directory,'project');await mkdir(project);
  const projectPath=await realpath(project),outputRoot=join(directory,'outputs'),bindings=join(directory,'bindings');
  const work=new ConversationWorkStore({directory:bindings,projectPath}),registry=createNativeAssetRegistry({projectPath}),incarnation=registry.issue();
  const conversation={provider:'codex' as const,threadId:'converted-service-review',sessionId:null},binding={connectionId:'fixture-connection',threadId:conversation.threadId};
  incarnation.seal({...binding,...conversation});incarnation.grant(binding);incarnation.dispatched({...binding,operationId:'fixture-intent'});
  const actor=registry.capture(incarnation.credential(),'mutate'),scope={projectId:work.projectId,conversation};
  const privateDirectory=join(directory,'private');await mkdir(privateDirectory);
  const sign=(value:unknown)=>createHmac('sha256','synthetic-owned-converted-review-key').update('review-service-fixture\0').update(assetReviewCanonical(value)).digest('hex');
  const authority:AssetReviewReceiptAuthority={directory:privateDirectory,sign,verify:(value,signature)=>typeof signature==='string'&&signature===sign(value),withSnapshot:evaluate=>evaluate(),close(){}};
  const proof=Symbol('fixture human'),review=new AssetReviewStore({projectPath,authority,authorizeHuman:(_command,actual)=>actual===proof});let selected=0,targetHook:(()=>void)|undefined;
  const options={cwd:directory,projectPath,outputRoot,modelReview:review,studioImport:{workAssociations:work,selectTarget(){selected++;targetHook?.();return {target:{sessionId:'offline-fixture-target',placeId:1,universeId:2,root:'Workspace' as const,parentRef:'owned-parent',creator:{kind:'user' as const,id:'123'}},placement:{mode:'origin' as const},studsPerMeter:2};}}};
  const services:AssetService[]=[];let service=await createAssetService(options);services.push(service);
  t.after(async()=>{try{for(const opened of services)await opened.close();}finally{review.close();registry.close();work.close();const child=relative(boundary,directory);assert.ok(child.startsWith('arcane-converted-review-service-')&&!isAbsolute(child)&&!child.includes('..'));await rm(directory,{recursive:true,force:true});}});
  const source=graphFixture(collision==='convex-hull',affine).bytes().sourceBytes;await writeFile(join(projectPath,'original.glb'),source);
  const host=createAssetConversationHost({projectPath,workAssociations:work,conversation:()=>conversation,start:async()=>{throw Error('No generation route in review fixture.');},
    adoptNative:async(input,original,admission)=>(await service.adoptProjectGlb(input,original,admission)).jobId});
  const adopted=await host.adoptNative(actor,{name:'original-card',path:'original.glb'});assert.equal(adopted.association,'bound');assert.ok(adopted.jobId);
  const parentId=adopted.jobId,parentDirectory=join(outputRoot,'original-card-'+parentId),parentRaw=await readFile(join(parentDirectory,'manifest.json'));
  await service.close();
  const controlled=metadata(parentRaw,source,collision,affine),childDirectory=join(outputRoot,'review-fixture-'+JOB);await mkdir(childDirectory);
  for(const[path,bytes]of controlled.files)await writeFile(join(childDirectory,path),bytes);
  await writeFile(join(childDirectory,'manifest.json'),JSON.stringify(controlled.manifest)+'\n');
  const request=controlled.manifest.request,creation=makeConvertedGlbCreation(JOB,{parentJobId:parentId,parentManifestSha256:request.parentManifestSha256,name:request.name,
    collision:request.collision,renderResolution:request.renderResolution,renderSamples:request.renderSamples});
  const journal:Record<string,unknown>={schemaVersion:1,kind:'converted-glb',jobId:JOB,directory:childDirectory,manifestPath:join(childDirectory,'manifest.json'),
    creation,request,state,error:null,startedAt:'2026-10-27T00:00:00Z',finishedAt:'2026-10-27T00:00:01Z',
    workers:[{schemaVersion:1,role:'generate',reservationId:randomUUID(),reservedAt:'2026-10-27T00:00:00.0000000Z',
      state:'closed',closure:'not-started',closedAt:'2026-10-27T00:00:01.0000000Z',identity:null}]};
  await writeFile(join(childDirectory,'job.json'),JSON.stringify(journal)+'\n');work.bind({conversation,kind:'asset-job',id:JOB});
  let validations=0,hook:(()=>Promise<void>)|undefined;
  t.mock.method(AssetPipeline.prototype,'validateConversion',async(manifestPath:string)=>{
    validations++;assert.equal(manifestPath,join(childDirectory,'manifest.json'));
    const manifest=parseConvertedGlbManifest(JSON.parse(await readFile(manifestPath,'utf8')));
    for(const artifact of manifest.artifacts){const bytes=await readFile(join(childDirectory,artifact.path));assert.equal(bytes.length,artifact.bytes);assert.equal(h(bytes),artifact.sha256);}
    await hook?.();return manifest;
  });
  service=await createAssetService(options);services.push(service);
  return {directory,projectPath,childDirectory,parentDirectory,parentId,work,registry,incarnation,actor,scope,review,proof,controlled,journal,
    get service(){return service;},selections:()=>selected,setTargetHook(value:()=>void){targetHook=value;},validations:()=>validations,setHook(value:(()=>Promise<void>)|undefined){hook=value;},
    mutateParentBinding(){const db=new DatabaseSync(join(bindings,'conversation-work.sqlite'));try{db.prepare("UPDATE conversation_work_bindings SET thread_id=? WHERE kind='asset-job' AND work_id=?").run('foreign-parent-thread',parentId);}finally{db.close();}},
    async approve(){const subject=await service.modelReviewSubject(JOB,scope),pending=review.prepare(subject);return review.decide({reviewId:pending.reviewId,decision:'approved',idempotencyKey:randomUUID()},subject,proof);},
    async restart(){await service.close();service=await createAssetService(options);services.push(service);},
  };
}


for(const collision of ['none','convex-hull'] as const)test('actual converted service prepares '+collision+' full hierarchy and sealed payload only after exact human review',async t=>{
  const f=await fixture(t,collision),plan=await f.service.prepareStudioImport(JOB,f.actor);
  assert.equal(plan.manifest.schemaVersion,2);assert.ok(plan.manifest.schemaVersion===2);
  assert.equal(plan.manifest.origin,'converted-glb');assert.equal(plan.manifest.conversion.sourceUp,'Y');
  assert.equal(plan.manifest.graph.nodes.length,7);assert.equal(plan.manifest.graph.meshes.length,collision==='none'?2:3);
  assert.equal(plan.manifest.graph.nodes.find(n=>n.nodeKey==='node2')?.parentKey,'node1');
  assert.equal(plan.manifest.graph.nodes.find(n=>n.nodeKey==='node3')?.name,'Empty leaf');
  assert.equal(plan.manifest.conversionRequest.parentJobId,f.parentId);assert.equal(f.selections(),1);
  await assert.rejects(f.service.prepareStudioImportPayload(JOB,f.actor),refused('ASSET_REVIEW_REQUIRED'));assert.equal(f.selections(),1);
  const approved=await f.approve(),data=await f.service.prepareStudioImportPayload(JOB,f.actor);
  assert.equal(data.review.reference.reviewId,approved.review.reviewId);data.review.assertCurrent();
  assert.equal(data.payload.formatVersion,2);assert.equal(data.transfer.formatVersion,2);
  assert.ok(data.payload.formatVersion===2&&data.transfer.formatVersion===2);
  assert.deepEqual(data.payload.graph,plan.manifest.graph);assert.deepEqual(data.payload.conversionRequest,plan.manifest.conversionRequest);
  assert.deepEqual(data.payload.objects.map(o=>o.object.pivot),data.payload.objects.map(()=>[0,0,0]));
  assert.equal(data.payload.sourceSha256,f.controlled.manifest.request.sourceSha256);
  const inspected=inspectConvertedStudioImportTransfer(data.transfer);
  assert.equal(inspected.graph.digest,data.payload.graph.digest);assert.equal(data.transfer.engineVerification,'pending');
  assert.equal(data.prepared.manifest.engineVerification,'pending');assert.equal(f.selections(),2);
});
test('changed converted raw bytes reject service preparation before any target capture',async t=>{
  const f=await fixture(t);await f.approve();const path=join(f.childDirectory,'asset.glb'),original=await readFile(path);
  await writeFile(path,Buffer.concat([original,Buffer.from([32])]));
  await assert.rejects(f.service.prepareStudioImportPayload(JOB,f.actor));assert.equal(f.selections(),0);
});
test('parent binding changed during target selection invalidates approved converted preparation',async t=>{
  const f=await fixture(t);await f.approve();f.setTargetHook(()=>f.mutateParentBinding());
  await assert.rejects(f.service.prepareStudioImportPayload(JOB,f.actor));assert.equal(f.selections(),1);
});
test('conditioned group scale remains in prepared metadata and receives an explicit native representability refusal',async t=>{
  const f=await fixture(t,'none','scale'),plan=await f.service.prepareStudioImport(JOB,f.actor);
  assert.ok(plan.manifest.schemaVersion===2);const group=plan.manifest.graph.nodes.find(n=>n.nodeKey==='node1');assert.ok(group);
  assert.equal(group.localMatrix[0],2);assert.equal(group.localMatrix[5],3);
  await f.approve();await assert.rejects(f.service.prepareStudioImportPayload(JOB,f.actor),
    (error:unknown)=>!!error&&typeof error==='object'&&'code'in error&&error.code==='UNSUPPORTED_TRANSFORM');
  // No staging controller/queue/native engine exists in this fixture. The data
  // gate is an interim target limitation, not full affine-delivery acceptance.
});
