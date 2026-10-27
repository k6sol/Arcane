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
import {CONVERSION_FIDELITY_POLICY} from '../../packages/asset-pipeline/src/conversion-fidelity-policy.js';
import {prepareGlbConversionSource} from '../../packages/asset-pipeline/src/glb-conversion-source.js';
import {parseConvertedGlbManifest} from '../../packages/asset-pipeline/src/converted-glb-manifest.js';
import type {Artifact} from '../../packages/asset-pipeline/src/types.js';
// Policy/custody seam only: real project adoption, service, CWS, raw journals,
// immutable file witnesses and SQLite/HMAC review. validateConversion is a
// trusted synthetic retained-metadata adapter, NOT native producer proof.
const JOB='11111111-1111-4111-8111-111111111111';
const h=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const refused=(code:string)=>(value:unknown)=>!!value&&typeof value==='object'&&'code'in value&&value.code===code;
function triangleGlb():Buffer {
  const bin=Buffer.alloc(80);
  [0,0,0,1,0,0,0,1,0,0,0,1,0,0,1,0,0,1].forEach((v,i)=>bin.writeFloatLE(v,i*4));
  [0,1,2].forEach((v,i)=>bin.writeUInt16LE(v,72+i*2));
  const doc={asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0}],meshes:[{primitives:[{attributes:{POSITION:0,NORMAL:1},indices:2}]}],
    buffers:[{byteLength:78}],bufferViews:[{buffer:0,byteOffset:0,byteLength:36},{buffer:0,byteOffset:36,byteLength:36},{buffer:0,byteOffset:72,byteLength:6}],
    accessors:[{bufferView:0,componentType:5126,type:'VEC3',count:3,min:[0,0,0],max:[1,1,0]},
      {bufferView:1,componentType:5126,type:'VEC3',count:3},{bufferView:2,componentType:5123,type:'SCALAR',count:3}]};
  const text=Buffer.from(JSON.stringify(doc)),length=(text.length+3)&~3,out=Buffer.alloc(28+length+bin.length);
  out.writeUInt32LE(0x46546c67,0);out.writeUInt32LE(2,4);out.writeUInt32LE(out.length,8);
  out.writeUInt32LE(length,12);out.writeUInt32LE(0x4e4f534a,16);out.fill(0x20,20,20+length);text.copy(out,20);
  out.writeUInt32LE(bin.length,20+length);out.writeUInt32LE(0x004e4942,24+length);bin.copy(out,28+length);return out;
}
function metadata(parentRaw:Buffer,source:Buffer,collision:'none'|'convex-hull'){
  const parent=JSON.parse(parentRaw.toString('utf8')) as {jobId:string},prepared=prepareGlbConversionSource(source,h(source));
  const files=new Map<string,Buffer>(),json=(value:unknown)=>Buffer.from(JSON.stringify(value));
  const pin=(path:string,bytes:Buffer,role:Artifact['role']):Artifact=>{files.set(path,bytes);return {path,role,bytes:bytes.length,sha256:h(bytes)};};
  const artifacts:Artifact[]=[];
  artifacts.push(pin('source.glb',source,'request'),pin('import-source.glb',prepared.importBytes,'request'),pin('parent-manifest.json',parentRaw,'request'));
  const sha=(path:string)=>h(files.get(path)!);
  const sourceKey='node0_primitive0',originMarker=`glb_${sha('source.glb')}:0:0`;
  const map={schemaVersion:2,fidelityPolicy:CONVERSION_FIDELITY_POLICY,sourceSha256:h(source),importSha256:prepared.importSha256,sourceSceneIndex:prepared.sourceSceneIndex,declaredSceneCount:prepared.declaredSceneCount,parts:prepared.parts,nodes:prepared.nodes};
  artifacts.push(pin('source-map.json',json(map),'request'));
  const request={schemaVersion:2,fidelityPolicy:CONVERSION_FIDELITY_POLICY,kind:'converted-glb',jobId:JOB,parentJobId:parent.jobId,parentManifestSha256:sha('parent-manifest.json'),name:'review-fixture',
    sourceSha256:sha('source.glb'),sourceBytes:source.length,importSha256:sha('import-source.glb'),importBytes:prepared.importBytes.length,sourceMapSha256:sha('source-map.json'),collision,renderResolution:128,renderSamples:1};
  artifacts.push(pin('request.json',json(request),'request'));
  for(const path of GLB_CONVERSION_WORKERS)artifacts.push(pin(path,Buffer.from('# synthetic never executed'),'worker'));
  artifacts.push(pin('asset.blend',Buffer.from('synthetic scene, not native evidence'),'scene'),pin('asset.glb',Buffer.alloc(24,41),'export'));
  if(collision==='convex-hull')artifacts.push(pin('collision.glb',Buffer.alloc(24,42),'export'));
  const objectId=convertedGlbObjectId(request.sourceSha256,'render',sourceKey);
  const measured={sourceKey,originMarker,sourceObjectId:objectId,vertices:3,triangles:1,boundaryEdges:3,nonManifoldEdges:3,looseVertices:0,looseEdges:0,degenerateFaces:0,invalidUVs:0,uvLayers:0,finitePositions:true,
    geometrySha256:h('geometry'),correspondenceSha256:h('correspondence'),materialSha256:h('material')};
  const paths=collision==='none'?['asset.glb']:['asset.glb','collision.glb'];
  const audit={schemaVersion:2,fidelityPolicy:CONVERSION_FIDELITY_POLICY,kind:'arcane-glb-conversion-audit',jobId:JOB,parentJobId:parent.jobId,parentManifestSha256:request.parentManifestSha256,
    requestSha256:sha('request.json'),sourceSha256:request.sourceSha256,importSha256:request.importSha256,sourceMapSha256:request.sourceMapSha256,
    identityScheme:'arcane-converted-v2',assetId:convertedGlbAssetId(request.sourceSha256),blenderVersion:'synthetic-v1',collision,importedParts:[measured],reopenedParts:[{...measured}],
    models:paths.map(path=>({path,sha256:sha(path),byteLength:24,generator:'synthetic, not native evidence',anchors:[],objects:[path==='asset.glb'?{
      sourceObjectId:objectId,sourceKey,nodeIndex:1,role:'render',pivot:[0,0,0],collisionFor:[],originMarker}:{sourceObjectId:convertedGlbObjectId(request.sourceSha256,'collision','proxy'),sourceKey:'proxy',nodeIndex:0,role:'collision',pivot:[0,0,0],collisionFor:[objectId],originMarker:null}]})),
    renders:['preview-hero.png','preview-side.png'].map(path=>({path,width:128,height:128,finitePixels:true,minLuminance:0,maxLuminance:1,meanLuminance:.5,standardDeviation:.2})),
    savedSceneReopened:true,errors:[],warnings:collision==='none'?['no-collision-proxy','delivery-support-pending']:['delivery-support-pending']};
  artifacts.push(pin('conversion-audit.json',json(audit),'audit'));
  for(const path of ['preview-hero.png','preview-side.png'])artifacts.push(pin(path,Buffer.from('synthetic image, never rendered'),'preview'));
  const manifest=parseConvertedGlbManifest({schemaVersion:2,origin:'converted-glb',jobId:JOB,createdAt:'2026-10-27T00:00:00Z',request,sourceMap:map,validation:audit,artifacts,limitations:['Synthetic review fixture.'],
    runtime:{executable:'synthetic/never-executed',version:'synthetic-v1',pythonVersion:'synthetic-v1',background:true,capabilities:{glbExport:true,glbImport:true,fbxExport:true,fbxImport:true,cycles:true}},
    workerBundleSha256:h(GLB_CONVERSION_WORKERS.map(path=>sha(path)).join('\n')),coordinateSystem:{units:'meters',sceneUp:'Z',glbUp:'Y',pivot:'source',robloxScaleVerified:false}});
  return {manifest,exports:new Map(paths.map(path=>[path as 'asset.glb'|'collision.glb',files.get(path)!])),files};
}
async function fixture(t:test.TestContext,collision:'none'|'convex-hull'='none',state:'succeeded'|'running'='succeeded',workers:'closed'|'reserved'|'absent'='closed'){
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
  const proof=Symbol('fixture human'),review=new AssetReviewStore({projectPath,authority,authorizeHuman:(_command,actual)=>actual===proof});let selected=0;
  const options={cwd:directory,projectPath,outputRoot,modelReview:review,studioImport:{workAssociations:work,selectTarget(){selected++;throw Error('Review fixture cannot select a Studio target.');}}};
  const services:AssetService[]=[];let service=await createAssetService(options);services.push(service);
  t.after(async()=>{try{for(const opened of services)await opened.close();}finally{review.close();registry.close();work.close();const child=relative(boundary,directory);assert.ok(child.startsWith('arcane-converted-review-service-')&&!isAbsolute(child)&&!child.includes('..'));await rm(directory,{recursive:true,force:true});}});
  const source=triangleGlb();await writeFile(join(projectPath,'original.glb'),source);
  const host=createAssetConversationHost({projectPath,workAssociations:work,conversation:()=>conversation,start:async()=>{throw Error('No generation route in review fixture.');},
    adoptNative:async(input,original,admission)=>(await service.adoptProjectGlb(input,original,admission)).jobId});
  const adopted=await host.adoptNative(actor,{name:'original-card',path:'original.glb'});assert.equal(adopted.association,'bound');assert.ok(adopted.jobId);
  const parentId=adopted.jobId,parentDirectory=join(outputRoot,'original-card-'+parentId),parentRaw=await readFile(join(parentDirectory,'manifest.json'));
  await service.close();
  const controlled=metadata(parentRaw,source,collision),childDirectory=join(outputRoot,'review-fixture-'+JOB);await mkdir(childDirectory);
  for(const[path,bytes]of controlled.files)await writeFile(join(childDirectory,path),bytes);
  await writeFile(join(childDirectory,'manifest.json'),JSON.stringify(controlled.manifest)+'\n');
  const request=controlled.manifest.request,creation=makeConvertedGlbCreation(JOB,{parentJobId:parentId,parentManifestSha256:request.parentManifestSha256,name:request.name,
    collision:request.collision,renderResolution:request.renderResolution,renderSamples:request.renderSamples});
  const journal:Record<string,unknown>={schemaVersion:1,kind:'converted-glb',jobId:JOB,directory:childDirectory,manifestPath:state==='succeeded'?join(childDirectory,'manifest.json'):null,
    creation,request:state==='running'?null:request,state,error:null,startedAt:'2026-10-27T00:00:00Z',...(state==='succeeded'?{finishedAt:'2026-10-27T00:00:01Z'}:{}),
    ...(workers==='absent'?{}:{workers:[{schemaVersion:1,role:'generate',reservationId:randomUUID(),reservedAt:'2026-10-27T00:00:00.0000000Z',
      ...(workers==='reserved'?{state:'reserved'}:{state:'closed',closure:'not-started',closedAt:'2026-10-27T00:00:01.0000000Z',identity:null})}]})};
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
    get service(){return service;},selections:()=>selected,validations:()=>validations,setHook(value:(()=>Promise<void>)|undefined){hook=value;},
    mutateParentBinding(){const db=new DatabaseSync(join(bindings,'conversation-work.sqlite'));try{db.prepare("UPDATE conversation_work_bindings SET thread_id=? WHERE kind='asset-job' AND work_id=?").run('foreign-parent-thread',parentId);}finally{db.close();}},
    async approve(){const subject=await service.modelReviewSubject(JOB,scope),pending=review.prepare(subject);return review.decide({reviewId:pending.reviewId,decision:'approved',idempotencyKey:randomUUID()},subject,proof);},
    async restart(){await service.close();service=await createAssetService(options);services.push(service);},
  };
}

for(const collision of ['none','convex-hull'] as const)test('actual converted service review binds '+collision+' child exports and requires a fresh durable human decision',async t=>{
  const f=await fixture(t,collision),subject=await f.service.modelReviewSubject(JOB,f.scope);
  assert.equal(subject.schemaVersion,2);assert.ok(subject.schemaVersion===2);assert.equal(subject.parentJobId,f.parentId);
  assert.equal(subject.parentManifestSha256,h(await readFile(join(f.parentDirectory,'manifest.json'))));
  assert.deepEqual(subject.artifacts.map(a=>a.path),collision==='none'?['asset.glb']:['asset.glb','collision.glb']);
  assert.deepEqual(f.work.binding('asset-job',JOB)?.conversation,f.scope.conversation);assert.deepEqual(f.work.binding('asset-job',f.parentId)?.conversation,f.scope.conversation);
  await assert.rejects(f.service.reviewImport(JOB,f.actor),refused('ASSET_REVIEW_REQUIRED'),'parent attribution and completed child metadata grant no child approval');
  const pending=f.review.prepare(subject);assert.throws(()=>f.review.decide({reviewId:pending.reviewId,decision:'approved',idempotencyKey:randomUUID()},subject,{approved:true}),refused('ASSET_REVIEW_HUMAN_REQUIRED'));
  const approved=await f.approve(),guard=await f.service.reviewImport(JOB,f.actor);assert.equal(guard.reference.reviewId,approved.review.reviewId);guard.assertCurrent();
  f.service.assertReviewedImport(JOB,f.scope,guard.reference);assert.equal(f.selections(),0);assert.ok(f.validations()>=2);
  assert.equal(f.selections(),0,'Model review does not select or mutate a Studio target.');
  await f.restart();assert.throws(()=>f.service.assertReviewedImport(JOB,f.scope,guard.reference),refused('ASSET_REVIEW_REQUIRED'),'process-local witness must be rebuilt after restart');
  const reopened=await f.service.reviewImport(JOB,f.actor,guard.reference);assert.deepEqual(reopened.reference,guard.reference);reopened.assertCurrent();
});
for(const path of ['asset.glb','collision.glb','conversion-audit.json','parent-manifest.json','job.json'] as const)test('converted review effect witness rejects changed retained '+path,async t=>{
  const f=await fixture(t,'convex-hull');await f.approve();const guard=await f.service.reviewImport(JOB,f.actor),target=join(f.childDirectory,path),bytes=await readFile(target);
  await writeFile(target,path==='job.json'?JSON.stringify({...JSON.parse(bytes.toString('utf8')),state:'interrupted'}):Buffer.concat([bytes,Buffer.from([32])]));
  assert.throws(()=>guard.assertCurrent(),refused('ASSET_REVIEW_SOURCE'));assert.throws(()=>f.service.assertReviewedImport(JOB,f.scope,guard.reference),refused('ASSET_REVIEW_SOURCE'));
  await assert.rejects(f.service.reviewImport(JOB,f.actor));assert.equal(f.selections(),0);
});
test('converted review rejects a changed original parent CWS binding both in issued witnesses and fresh reads',async t=>{
  const f=await fixture(t);await f.approve();const guard=await f.service.reviewImport(JOB,f.actor);f.mutateParentBinding();
  assert.throws(()=>guard.assertCurrent());assert.throws(()=>f.service.assertReviewedImport(JOB,f.scope,guard.reference));
  await assert.rejects(f.service.modelReviewSubject(JOB,f.scope));assert.equal(f.selections(),0);
});
test('parent binding replaced while converted validation awaits cannot become a new review opening',async t=>{
  const f=await fixture(t);let once=false;f.setHook(async()=>{if(!once){once=true;f.mutateParentBinding();}});
  await assert.rejects(f.service.modelReviewSubject(JOB,f.scope));assert.equal(once,true);assert.equal(f.selections(),0);
});
for(const [state,workers]of [['running','closed'],['succeeded','reserved'],['succeeded','absent']] as const)test('converted '+state+' journal with '+workers+' workers cannot open a model review',async t=>{
  const f=await fixture(t,'none',state,workers);await assert.rejects(f.service.modelReviewSubject(JOB,f.scope),refused('ASSET_REVIEW_JOB_STATE'));
  await assert.rejects(f.service.reviewImport(JOB,f.actor),refused('ASSET_REVIEW_JOB_STATE'));assert.equal(f.selections(),0);
});
test('succeeded in-memory state does not override changed raw creation/request completion metadata',async t=>{
  const f=await fixture(t),journal={...f.journal,request:{...f.controlled.manifest.request,renderSamples:2}};
  await writeFile(join(f.childDirectory,'job.json'),JSON.stringify(journal)+'\n');
  await assert.rejects(f.service.modelReviewSubject(JOB,f.scope));assert.equal(f.selections(),0);
});
