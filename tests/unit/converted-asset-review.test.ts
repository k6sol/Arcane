import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {workflowProjectIdentity} from '../../packages/storage/src/workflow-store.js';
import {AssetReviewStore} from '../../apps/daemon/src/asset-review-store.js';
import {assetReviewCanonical,assetReviewDigest,convertedModelReviewSubject,snapshotAssetReviewSubject,type AssetReviewReceiptAuthority,type AssetReviewSubject,type ConvertedAssetReviewSubject} from '../../apps/daemon/src/asset-review.js';
import {convertedGlbAssetId,convertedGlbObjectId,GLB_CONVERSION_WORKERS} from '../../packages/asset-pipeline/src/converted-glb.js';
import {CONVERSION_FIDELITY_POLICY} from '../../packages/asset-pipeline/src/conversion-fidelity-policy.js';
import {parseConvertedGlbManifest} from '../../packages/asset-pipeline/src/converted-glb-manifest.js';
import type {Artifact} from '../../packages/asset-pipeline/src/types.js';

// Synthetic retained metadata and dummy export bytes exercise review custody only.
// No native producer, Blender process, Studio import or geometry acceptance runs.
const JOB='11111111-1111-4111-8111-111111111111',PARENT='22222222-2222-4222-8222-222222222222';
const h=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const refused=(code:string)=>(value:unknown)=>!!value&&typeof value==='object'&&'code'in value&&value.code===code;
function metadata(collision:'none'|'convex-hull'='none'){
  const files=new Map<string,Buffer>(),json=(value:unknown)=>Buffer.from(JSON.stringify(value));
  const pin=(path:string,bytes:Buffer,role:Artifact['role']):Artifact=>{files.set(path,bytes);return {path,role,bytes:bytes.length,sha256:h(bytes)};};
  const artifacts:Artifact[]=[];
  for(const path of ['source.glb','import-source.glb','parent-manifest.json'])artifacts.push(pin(path,Buffer.alloc(24,path.length),'request'));
  const sha=(path:string)=>h(files.get(path)!);
  const matrix=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],sourceKey='node0_primitive0',originMarker=`glb_${sha('source.glb')}:0:0`;
  const map={schemaVersion:2,fidelityPolicy:CONVERSION_FIDELITY_POLICY,sourceSha256:sha('source.glb'),importSha256:sha('import-source.glb'),sourceSceneIndex:0,declaredSceneCount:1,
    parts:[{sourceNodeIndex:0,sourceMeshIndex:0,sourcePrimitiveIndex:0,sourceMaterialIndex:null,sourceKey,importNodeIndex:1,originMarker,worldMatrix:matrix,triangles:1,vertexCount:3}],
    nodes:[{nodeKey:'node0',importNodeIndex:0,parentKey:null,localMatrix:matrix},{nodeKey:sourceKey,importNodeIndex:1,parentKey:'node0',localMatrix:matrix}]};
  artifacts.push(pin('source-map.json',json(map),'request'));
  const request={schemaVersion:2,fidelityPolicy:CONVERSION_FIDELITY_POLICY,kind:'converted-glb',jobId:JOB,parentJobId:PARENT,parentManifestSha256:sha('parent-manifest.json'),name:'review-fixture',
    sourceSha256:sha('source.glb'),sourceBytes:24,importSha256:sha('import-source.glb'),importBytes:24,sourceMapSha256:sha('source-map.json'),collision,renderResolution:128,renderSamples:1};
  artifacts.push(pin('request.json',json(request),'request'));
  for(const path of GLB_CONVERSION_WORKERS)artifacts.push(pin(path,Buffer.from('# synthetic never executed'),'worker'));
  artifacts.push(pin('asset.blend',Buffer.from('synthetic scene, not native evidence'),'scene'),pin('asset.glb',Buffer.alloc(24,41),'export'));
  if(collision==='convex-hull')artifacts.push(pin('collision.glb',Buffer.alloc(24,42),'export'));
  const objectId=convertedGlbObjectId(request.sourceSha256,'render',sourceKey);
  const measured={sourceKey,originMarker,sourceObjectId:objectId,vertices:3,triangles:1,boundaryEdges:3,nonManifoldEdges:3,looseVertices:0,looseEdges:0,degenerateFaces:0,invalidUVs:0,uvLayers:0,finitePositions:true,
    geometrySha256:h('geometry'),correspondenceSha256:h('correspondence'),materialSha256:h('material')};
  const paths=collision==='none'?['asset.glb']:['asset.glb','collision.glb'];
  const audit={schemaVersion:2,fidelityPolicy:CONVERSION_FIDELITY_POLICY,kind:'arcane-glb-conversion-audit',jobId:JOB,parentJobId:PARENT,parentManifestSha256:request.parentManifestSha256,
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
const scope={projectId:h('project'),conversation:{provider:'codex' as const,threadId:'review-fixture',sessionId:null}};
for(const collision of ['none','convex-hull'] as const)test('converted review pins the exact '+collision+' export inventory and immutable lineage',()=>{
  const f=metadata(collision),subject=convertedModelReviewSubject(scope,f.manifest,f.exports);
  assert.equal(subject.schemaVersion,2);assert.equal(subject.kind,'converted-glb');assert.equal(subject.manifestSha256,assetReviewDigest(f.manifest));
  assert.equal(subject.auditSha256,h(f.files.get('conversion-audit.json')!));assert.equal(subject.requestSha256,h(f.files.get('request.json')!));
  assert.equal('sourceRequestSha256'in subject,false);assert.deepEqual(subject.artifacts.map(a=>a.path),[...f.exports.keys()]);
  assert.ok(Object.isFrozen(subject)&&Object.isFrozen(subject.conversation)&&Object.isFrozen(subject.artifacts)&&Object.isFrozen(subject.artifacts[0]));
  const changed=new Map(f.exports);changed.set('asset.glb',Buffer.alloc(24,99));assert.throws(()=>convertedModelReviewSubject(scope,f.manifest,changed),refused('ASSET_REVIEW_SOURCE'));
  const extra=new Map(f.exports);extra.set('collision.glb',Buffer.alloc(24,42));
  if(collision==='none')assert.throws(()=>convertedModelReviewSubject(scope,f.manifest,extra),refused('ASSET_REVIEW_SOURCE'));
  const missing=new Map(f.exports);missing.delete('asset.glb');assert.throws(()=>convertedModelReviewSubject(scope,f.manifest,missing),refused('ASSET_REVIEW_SOURCE'));
  assert.throws(()=>convertedModelReviewSubject(scope,{...f.manifest,validation:{...f.manifest.validation,requestSha256:h('forged')}},f.exports));
});
async function storeFixture(t:test.TestContext){
  const directory=await mkdtemp(join(tmpdir(),'arcane-converted-review-')),project=workflowProjectIdentity(directory),privateDirectory=join(directory,'private');await mkdir(privateDirectory);
  const key=Buffer.from('synthetic HMAC review key'),proof=Symbol('actual fixture human permit');let permit=false;
  const sign=(value:unknown)=>createHmac('sha256',key).update('converted-review-fixture\0').update(assetReviewCanonical(value)).digest('hex');
  const authority:AssetReviewReceiptAuthority={directory:privateDirectory,sign,verify:(value,signature)=>typeof signature==='string'&&signature===sign(value),withSnapshot:evaluate=>evaluate(),close(){}};
  const open=()=>new AssetReviewStore({projectPath:project.projectPath,authority,authorizeHuman:(_command,value)=>permit&&value===proof});let store=open();
  t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
  const f=metadata('convex-hull'),subject=convertedModelReviewSubject({...scope,projectId:project.projectId},f.manifest,f.exports);
  return {subject,authority,project,get store(){return store;},restart(){store.close();store=open();},decide(reviewId:string,decision:'approved'|'rejected',fresh:AssetReviewSubject=subject){permit=true;try{return store.decide({reviewId,decision,idempotencyKey:randomUUID()},fresh,proof);}finally{permit=false;}}};
}
test('parent approval never approves a converted child; exact signed child approval survives SQLite restart',async t=>{
  const f=await storeFixture(t),parent=snapshotAssetReviewSubject({schemaVersion:1,projectId:f.subject.projectId,conversation:f.subject.conversation,jobId:PARENT,manifestSha256:f.subject.parentManifestSha256,
    sourceRequestSha256:h('parent request'),artifacts:[{path:'asset.glb',sha256:h('parent export'),bytes:24},{path:'collision.glb',sha256:h('parent collision'),bytes:24}]});
  const parentReview=f.store.prepare(parent);f.decide(parentReview.reviewId,'approved',parent);const parentReference=f.store.assertApproved(parent);
  const child=f.store.prepare(f.subject);assert.notEqual(child.reviewId,parentReview.reviewId);
  assert.throws(()=>f.store.assertApproved(f.subject),refused('ASSET_REVIEW_REQUIRED'));
  assert.throws(()=>f.store.decide({reviewId:child.reviewId,decision:'approved',idempotencyKey:randomUUID()},f.subject,{approved:true}),refused('ASSET_REVIEW_HUMAN_REQUIRED'));
  f.decide(child.reviewId,'approved');const reference=f.store.assertApproved(f.subject);f.restart();assert.deepEqual(f.store.assertApproved(f.subject),reference);
  assert.deepEqual(f.store.assertApproved(parent),parentReference);
  for(const field of ['manifestSha256','requestSha256','parentManifestSha256','sourceSha256','sourceMapSha256','auditSha256'] as const)
    assert.throws(()=>f.store.assertReference({...f.subject,[field]:h('changed '+field)},reference));
  assert.throws(()=>f.store.assertReference({...f.subject,collision:'none',artifacts:[f.subject.artifacts[0]!]},reference));
  f.decide(child.reviewId,'rejected');assert.throws(()=>f.store.assertReference(f.subject,reference),refused('ASSET_REVIEW_REJECTED'));
});
test('converted approval payload forgery cannot replace its HMAC decision',async t=>{
  const f=await storeFixture(t),pending=f.store.prepare(f.subject);f.store.close();
  const db=new DatabaseSync(join(f.authority.directory,'asset-model-reviews-v1.sqlite'));
  const row=db.prepare('SELECT payload FROM asset_reviews WHERE id=?').get(pending.reviewId) as {payload:string};
  const forged=JSON.parse(row.payload);Object.assign(forged,{status:'approved',revision:1,decidedAt:'2026-10-27T00:00:01Z'});
  db.prepare('UPDATE asset_reviews SET payload=? WHERE id=?').run(assetReviewCanonical(forged),pending.reviewId);db.close();
  assert.throws(()=>new AssetReviewStore({projectPath:f.project.projectPath,authority:f.authority}),refused('ASSET_REVIEW_STORAGE'));
});
test('changed converted audit creates a fresh pending review and restoring old bytes cannot revive approval',async t=>{
  const f=await storeFixture(t),first=f.store.prepare(f.subject);f.decide(first.reviewId,'approved');const reference=f.store.assertApproved(f.subject);
  const changed=snapshotAssetReviewSubject({...f.subject,auditSha256:h('new audit')}),second=f.store.prepare(changed);
  assert.notEqual(second.reviewId,first.reviewId);assert.equal(second.status,'pending');
  assert.throws(()=>f.store.assertReference(f.subject,reference),refused('ASSET_REVIEW_REQUIRED'));
  const restored=f.store.prepare(f.subject);assert.notEqual(restored.reviewId,first.reviewId);assert.equal(restored.status,'pending');
  f.restart();assert.throws(()=>f.store.assertApproved(f.subject),refused('ASSET_REVIEW_REQUIRED'));
});
test('converted subject intake rejects hostile descriptors, proxies and non-dense metadata without executing them',()=>{
  const f=metadata(),subject=convertedModelReviewSubject(scope,f.manifest,f.exports);let calls=0;
  const getter={...subject};Object.defineProperty(getter,'schemaVersion',{enumerable:true,get(){calls++;return 2;}});assert.throws(()=>snapshotAssetReviewSubject(getter));
  const proxy=new Proxy(subject,{getPrototypeOf(){calls++;throw Error('trap');},getOwnPropertyDescriptor(){calls++;throw Error('trap');}});assert.throws(()=>snapshotAssetReviewSubject(proxy));
  const artifacts=[...subject.artifacts];Object.defineProperty(artifacts,0,{enumerable:true,get(){calls++;return subject.artifacts[0];}});assert.throws(()=>snapshotAssetReviewSubject({...subject,artifacts}));
  const sparse=new Array(1);assert.throws(()=>snapshotAssetReviewSubject({...subject,artifacts:sparse}));
  const hidden={...subject};Object.defineProperty(hidden,'secret',{value:true});assert.throws(()=>snapshotAssetReviewSubject(hidden));
  assert.throws(()=>snapshotAssetReviewSubject({...subject,[Symbol('authority')]:true}));assert.throws(()=>snapshotAssetReviewSubject({...subject,sourceRequestSha256:h('invented')}));
  assert.throws(()=>snapshotAssetReviewSubject(Object.assign(Object.create({authority:true}),subject)));
  assert.equal(calls,0);
  const render=Buffer.from(f.exports.get('asset.glb')!);Object.defineProperty(render,'buffer',{get(){calls++;throw Error('must not read own accessor');}});
  const ownedExports=new Map(f.exports);ownedExports.set('asset.glb',render);assert.deepEqual(convertedModelReviewSubject(scope,f.manifest,ownedExports),subject);assert.equal(calls,0);
  const detached=snapshotAssetReviewSubject(structuredClone(subject)) as ConvertedAssetReviewSubject;assert.notEqual(detached,subject);assert.notEqual(detached.artifacts,subject.artifacts);
});
