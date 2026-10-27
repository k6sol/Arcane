import type {StudioImportObservationReceipt} from '../../packages/protocol/src/studio.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {adaptCompletedConvertedStudioImport,type ConvertedImportRetainedFiles,type ConvertedImportRetainedPath} from '../../apps/daemon/src/converted-asset-import-adapter.js';
import {parseConvertedGlbManifest} from '../../packages/asset-pipeline/src/converted-glb-manifest.js';
import {convertedGlbObjectId,convertedGlbAssetId,GLB_CONVERSION_WORKERS} from '../../packages/asset-pipeline/src/converted-glb.js';
import {buildConvertedGraph,type ConvertedGraphSourceBytes} from '../../packages/asset-pipeline/src/studio-import-graph.js';
import {prepareGlbConversionSource} from '../../packages/asset-pipeline/src/glb-conversion-source.js';
import {CONVERSION_FIDELITY_POLICY,CONVERSION_NODE_KEY,conversionCorrespondenceSha256} from '../../packages/asset-pipeline/src/conversion-fidelity-policy.js';
import {AssetError,type Artifact} from '../../packages/asset-pipeline/src/types.js';
import {createStudioImportManifestAuthority,studioImportObservationReceiptDigest,type StudioImportSelection,type ConvertedStudioImportBaselineV2} from '../../packages/asset-pipeline/src/studio-import-manifest.js';

// The fixed byte constructor below is borrowed from frozen C114. Its audit and
// runtime statements are synthetic metadata, never worker or authority proof.
// Real constructed buffers and explicitly synthetic audit measurements only.
// No worker/runtime, process closure, human approval or native target is proved.
type Doc=Record<string,any>;
const JOB='11111111-1111-4111-8111-111111111111',PARENT='22222222-2222-4222-8222-222222222222';
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const json=(value:unknown)=>Buffer.from(JSON.stringify(value));
const canonical=(value:unknown):string=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value!==null&&typeof value==='object'?'{'+Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,child])=>JSON.stringify(key)+':'+canonical(child)).join(',')+'}':JSON.stringify(value);
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

const PROJECT='a'.repeat(64);
const selection=():StudioImportSelection=>({target:{sessionId:'fixture-session',placeId:1,universeId:2,root:'Workspace',parentRef:'fixture-parent',creator:{kind:'user',id:'123'}},placement:{mode:'origin'},studsPerMeter:2});
const required:readonly ConvertedImportRetainedPath[]=['request.json','source-map.json','conversion-audit.json','source.glb','import-source.glb','asset.glb'];
const evidenceRefusal=(error:unknown)=>error instanceof AssetError;
function completedFixture(collision=false){
  const core=fixture(collision);
  core.output.asset.generator='Khronos glTF Blender I/O v5.2.3 (synthetic fixture)';
  if(collision)core.setCollision(core.collisionGlb());
  function refresh(){
    const b=core.bytes(),files=new Map<ConvertedImportRetainedPath,Buffer>([
      ['request.json',b.requestBytes],['source-map.json',b.sourceMapBytes],['conversion-audit.json',b.auditBytes],
      ['source.glb',b.sourceBytes],['import-source.glb',b.importBytes],['asset.glb',b.renderBytes],
      ...(b.collisionBytes?[['collision.glb',b.collisionBytes] as [ConvertedImportRetainedPath,Buffer]]:[]),
    ]);
    // The adapter verifies ONLY its six/seven byte subset. Other inventory rows
    // are explicitly synthetic declarations, not a full-file/native validation.
    const declared=new Map<string,Buffer>(files);
    declared.set('parent-manifest.json',Buffer.from('synthetic parent metadata'));
    for(const name of GLB_CONVERSION_WORKERS)declared.set(name,Buffer.from('# Synthetic worker metadata; never run.\n'));
    declared.set('asset.blend',Buffer.from('Synthetic scene declaration; not native evidence.'));
    for(const name of ['preview-hero.png','preview-side.png'])declared.set(name,Buffer.from('Synthetic preview declaration; not native pixels.'));
    const role=(path:string):Artifact['role']=>path.endsWith('.py')?'worker':path==='asset.blend'?'scene':
      path.startsWith('preview-')?'preview':path==='conversion-audit.json'?'audit':path==='asset.glb'||path==='collision.glb'?'export':'request';
    const manifest:Doc={schemaVersion:2,origin:'converted-glb',jobId:JOB,createdAt:'2026-10-27T00:00:00.000Z',request:structuredClone(core.request),
      runtime:{executable:'/synthetic/not-launched',version:core.audit.blenderVersion,pythonVersion:'synthetic metadata',background:true,
        capabilities:{glbExport:true,glbImport:true,fbxExport:true,fbxImport:true,cycles:true}},
      workerBundleSha256:sha(GLB_CONVERSION_WORKERS.map(name=>sha(declared.get(name)!)).join('\n')),
      coordinateSystem:{units:'meters',sceneUp:'Z',glbUp:'Y',pivot:'source',robloxScaleVerified:false},
      sourceMap:structuredClone(core.map),validation:structuredClone(core.audit),
      artifacts:[...declared].map(([path,bytes])=>({path,role:role(path),bytes:bytes.length,sha256:sha(bytes)})),
      limitations:['Synthetic metadata; no full retained-file, process, review or engine proof.']};
    parseConvertedGlbManifest(manifest); // Every negative starts from a valid closed metadata seed.
    return{files,manifest,b};
  }
  return{core,refresh,...refresh()};
}
function put(files:Map<ConvertedImportRetainedPath,Buffer>,manifest:Doc,path:ConvertedImportRetainedPath,bytes:Buffer){
  files.set(path,bytes);const artifact=manifest.artifacts.find((a:Doc)=>a.path===path);assert.ok(artifact);
  artifact.sha256=sha(bytes);artifact.bytes=bytes.length;
}

for(const hull of [false,true])test('converted host adapter binds exact retained '+(hull?'hull':'none')+' evidence and complete actual graph without granting authority',()=>{
  const f=completedFixture(hull),host=selection(),before=new Map([...f.files].map(([name,bytes])=>[name,sha(bytes)]));
  const result=adaptCompletedConvertedStudioImport(f.manifest,f.files,PROJECT,host,null);
  assert.equal(result.schemaVersion,2);assert.equal(result.origin,'converted-glb');assert.equal(result.identityScheme,'arcane-converted-v2');
  assert.equal(result.assetId,convertedGlbAssetId(f.core.request.sourceSha256));assert.equal(result.revisionId,JOB);assert.equal(result.sourceSha256,f.core.request.sourceSha256);
  assert.deepEqual(result.conversionRequest,f.manifest.request);assert.deepEqual(result.graph,buildConvertedGraph(f.b));
  assert.equal(result.graph.nodes.length,7);assert.equal(result.graph.meshes.length,hull?3:2);
  assert.equal(result.graph.nodes.find(n=>n.nodeKey==='node3')?.name,'Empty leaf');assert.equal(result.graph.nodes.find(n=>n.nodeKey==='node2')?.parentKey,'node1');
  assert.equal(result.producer.blenderVersion,f.core.audit.blenderVersion);assert.equal(result.producer.exporterVersion,f.core.output.asset.generator);
  assert.deepEqual(result.target,host.target);assert.deepEqual(result.placement,host.placement);assert.equal(result.studsPerMeter,2);
  assert.deepEqual(result.anchors,[]);assert.equal(result.baseline,null);assert.deepEqual(result.files.map(file=>file.fileId),hull?['asset-glb','collision-glb']:['asset-glb']);
  for(const model of result.models){
    const path=model.fileId==='asset-glb'?'asset.glb':'collision.glb',actual=f.core.audit.models.find((m:Doc)=>m.path===path);assert.ok(actual);
    assert.deepEqual(model.resources,[]);assert.deepEqual(model.objects,actual.objects.map(({originMarker:_origin,...object}:Doc)=>object));
    const file=result.files.find(file=>file.fileId===model.fileId)!;
    assert.equal(file.contentType,'model/gltf-binary');assert.equal(file.sha256,sha(f.files.get(path)!));assert.deepEqual(Buffer.from(file.bytes),f.files.get(path));
    assert.notEqual(file.bytes,f.files.get(path));
  }
  assert.ok(f.core.prepared.parts.some(p=>f.core.output.nodes.indexOf(f.core.byKey(p.sourceKey))!==p.importNodeIndex),'Export indexes are deliberately reordered');
  assert.deepEqual(Object.keys(result).sort(),['schemaVersion','origin','identityScheme','projectId','assetId','revisionId','sourceSha256','conversionRequest','graph','producer','target','placement','studsPerMeter','files','models','anchors','baseline'].sort());
  assert.equal('runtime'in result,false);assert.equal('approved'in result,false);assert.equal('engineVerification'in result,false);
  assert.ok(Object.isFrozen(result)&&Object.isFrozen(result.models[0]!.objects)&&Object.isFrozen(result.graph));
  assert.deepEqual(new Map([...f.files].map(([name,bytes])=>[name,sha(bytes)])),before);
  host.target.parentRef='changed-after-return';const originalFile=f.files.get('asset.glb')!;originalFile[0]=originalFile[0]!^1;
  assert.equal(result.target.parentRef,'fixture-parent');assert.notEqual(sha(result.files[0]!.bytes),sha(f.files.get('asset.glb')!));
});

test('every fixed raw file is hash-bound and missing, extra or substituted keys never produce an adapter fallback',()=>{
  const f=completedFixture(true);
  for(const path of [...required,'collision.glb' as const]){
    const files=new Map(f.files),bytes=Buffer.from(files.get(path)!);bytes[bytes.length-1]=bytes[bytes.length-1]!^1;files.set(path,bytes);
    assert.throws(()=>adaptCompletedConvertedStudioImport(f.manifest,files,PROJECT,selection(),null),evidenceRefusal,path);
    const missing=new Map(f.files);missing.delete(path);assert.throws(()=>adaptCompletedConvertedStudioImport(f.manifest,missing,PROJECT,selection(),null),evidenceRefusal,path);
  }
  const extra=new Map<string,Buffer>(f.files);extra.set('unexpected.glb',Buffer.from('extra'));
  assert.throws(()=>adaptCompletedConvertedStudioImport(f.manifest,extra as unknown as ConvertedImportRetainedFiles,PROJECT,selection(),null),evidenceRefusal);
  const none=completedFixture(),foreign=new Map(none.files);foreign.delete('asset.glb');(foreign as Map<string,Buffer>).set('renamed.glb',f.files.get('asset.glb')!);
  assert.throws(()=>adaptCompletedConvertedStudioImport(none.manifest,foreign,PROJECT,selection(),null),evidenceRefusal);
  const surplus=new Map(none.files);surplus.set('collision.glb',f.files.get('collision.glb')!);
  assert.throws(()=>adaptCompletedConvertedStudioImport(none.manifest,surplus,PROJECT,selection(),null),evidenceRefusal);
});

for(const part of ['request','map','audit'] as const)test('parsed raw '+part+' must match the manifest even after matching artifact hashes are resealed',()=>{
  const f=completedFixture(),files=new Map(f.files),manifest=structuredClone(f.manifest) as Doc;
  const request=JSON.parse(files.get('request.json')!.toString()) as Doc,map=JSON.parse(files.get('source-map.json')!.toString()) as Doc,audit=JSON.parse(files.get('conversion-audit.json')!.toString()) as Doc;
  if(part==='request')request.name='other-valid-name';
  if(part==='map'){
    map.nodes.find((n:Doc)=>n.nodeKey==='node3').localMatrix[13]=.000001;put(files,manifest,'source-map.json',json(map));
    request.sourceMapSha256=manifest.request.sourceMapSha256=sha(files.get('source-map.json')!);
    audit.sourceMapSha256=manifest.validation.sourceMapSha256=request.sourceMapSha256;
  }
  if(part!=='audit'){
    put(files,manifest,'request.json',json(request));audit.requestSha256=manifest.validation.requestSha256=sha(files.get('request.json')!);
  }else audit.warnings=['open-render-surfaces','no-collision-proxy'];
  put(files,manifest,'conversion-audit.json',json(audit));parseConvertedGlbManifest(manifest);
  assert.throws(()=>adaptCompletedConvertedStudioImport(manifest,files,PROJECT,selection(),null),evidenceRefusal);
});

test('resealed actual graph, render identity and open collision corruption still fails independent byte validation',()=>{
  for(const mutate of [(f:ReturnType<typeof completedFixture>)=>{f.core.byKey('node3').translation=[1,0,0];},
    (f:ReturnType<typeof completedFixture>)=>{f.core.byKey('node2_primitive0').extras.arcane_source_object_id='arcane_'+sha('foreign');},
    (f:ReturnType<typeof completedFixture>)=>{delete f.core.byKey('node3').extras[CONVERSION_NODE_KEY];}]){
    const f=completedFixture();mutate(f);const changed=f.refresh();assert.throws(()=>adaptCompletedConvertedStudioImport(changed.manifest,changed.files,PROJECT,selection(),null),evidenceRefusal);
  }
  const hull=completedFixture(true);hull.core.setCollision(hull.core.collisionGlb(true));const changed=hull.refresh();
  assert.throws(()=>adaptCompletedConvertedStudioImport(changed.manifest,changed.files,PROJECT,selection(),null),evidenceRefusal);
});

test('foreign schemas, roles, identity or original-source declarations are refused rather than treated as generated imports',()=>{
  for(const mutate of [(m:Doc)=>{m.schemaVersion=1;},(m:Doc)=>{m.origin='generated';},
    (m:Doc)=>{m.validation.models[0].objects[0].sourceObjectId='arcane_'+sha('foreign');},
    (m:Doc)=>{m.artifacts.find((a:Doc)=>a.path==='source.glb').role='export';},
    (m:Doc)=>{m.request.sourceBytes++;},(m:Doc)=>{m.request.sourceSha256=sha('foreign source');}]){
    const f=completedFixture(),manifest=structuredClone(f.manifest) as Doc;mutate(manifest);
    assert.throws(()=>adaptCompletedConvertedStudioImport(manifest,f.files,PROJECT,selection(),null),evidenceRefusal);
  }
});

test('map, byte and metadata guards refuse hostile inputs without invoking supplied getters, iterators or proxy traps',()=>{
  const f=completedFixture();let calls=0;const trap=()=>{calls++;throw Error('Must not invoke caller code');};
  const proxy=new Proxy(f.files,{get:trap,ownKeys:trap,getPrototypeOf:trap});
  const iterator=new Map(f.files);Object.defineProperty(iterator,Symbol.iterator,{value:trap});
  const method=new Map(f.files);Object.defineProperty(method,'get',{get:trap});
  const custom=Object.create(Map.prototype) as ConvertedImportRetainedFiles;
  for(const value of [proxy,iterator,method,custom])assert.throws(()=>adaptCompletedConvertedStudioImport(f.manifest,value,PROJECT,selection(),null),evidenceRefusal);
  const bytes=new Map(f.files);bytes.set('source.glb',new Proxy(f.files.get('source.glb')!,{get:trap}));
  assert.throws(()=>adaptCompletedConvertedStudioImport(f.manifest,bytes,PROJECT,selection(),null),evidenceRefusal);
  const shared=new Map(f.files);shared.set('source.glb',Buffer.from(new SharedArrayBuffer(f.files.get('source.glb')!.length)));
  assert.throws(()=>adaptCompletedConvertedStudioImport(f.manifest,shared,PROJECT,selection(),null),evidenceRefusal);
  const getter=Object.defineProperty({...f.manifest},'request',{enumerable:true,get:trap});
  assert.throws(()=>adaptCompletedConvertedStudioImport(getter,f.files,PROJECT,selection(),null),evidenceRefusal);
  const host=Object.defineProperty(selection(),'target',{enumerable:true,get:trap});
  assert.throws(()=>adaptCompletedConvertedStudioImport(f.manifest,f.files,PROJECT,host,null));
  assert.equal(calls,0);
});

test('buffer copying uses intrinsic storage slots and not overridden buffer, byteLength or iterator values',()=>{
  const f=completedFixture();let calls=0;const source=Buffer.from(f.files.get('source.glb')!);
  for(const name of ['buffer','byteLength',Symbol.iterator])Object.defineProperty(source,name,{get(){calls++;throw Error('Not called');}});
  const files=new Map(f.files);files.set('source.glb',source);
  const result=adaptCompletedConvertedStudioImport(f.manifest,files,PROJECT,selection(),null);
  assert.equal(result.sourceSha256,f.core.request.sourceSha256);assert.equal(calls,0);
});

test('converted baseline and selection are detached metadata only, with matching project, source asset and target required',async()=>{
  const f=completedFixture(),host=selection(),first=adaptCompletedConvertedStudioImport(f.manifest,f.files,PROJECT,host,null);
  const authority=createStudioImportManifestAuthority({loadGeneratedFiles:async()=>first});
  try{
    const admission=await authority.admit(JOB),prepared=authority.prepare(admission);assert.equal(prepared.manifest.schemaVersion,2);
    if(prepared.manifest.schemaVersion!==2)assert.fail('Expected the actual converted preparation branch');
    assert.equal(prepared.manifest.conversion.sourceUp,'Y');assert.equal(prepared.manifest.conversion.exportUp,'Y');
    const manifest=prepared.manifest;
    // Synthetic observed mappings test the closed metadata handoff, not Studio.
    const observation:StudioImportObservationReceipt={formatVersion:2,observationId:'55555555-5555-4555-8555-555555555555',
      source:{projectId:manifest.projectId,jobId:manifest.revisionId,assetId:manifest.assetId,sourceSha256:manifest.sourceSha256,preparedDigest:prepared.digest,
        manifestDigest:manifest.digest,payloadDigest:sha('synthetic previous payload'),transferDigest:sha('synthetic previous transfer'),graphDigest:manifest.graph.digest,conversionRequestDigest:sha(canonical(manifest.conversionRequest))},
      target:structuredClone(manifest.target),continuity:{clientLifetimeId:'fixture-plugin',pluginArtifactHash:sha('synthetic plugin'),playEpoch:0},
      modelRef:{instanceId:'fixture-model',sessionId:manifest.target.sessionId,root:'Workspace',pathSegments:['Observed model'],className:'Model'},modelOwnedStateSha256:sha('synthetic model state'),
      objects:manifest.objects.map((object,i)=>({sourceObjectId:object.sourceObjectId,instanceRef:'mesh-'+i,meshAssetId:String(100+i),ownedStateSha256:sha('mesh-'+i),authoredChildren:[]})),
      nodes:manifest.graph.nodes.map((node,i)=>({nodeKey:node.nodeKey,instanceRef:'node-'+i,ownedStateSha256:sha('node-'+i),authoredChildren:[]})),
      receiptScope:'live-import-observation',imported:false,engineVerification:'pending'};
    // Mesh nodes and object mappings refer to the SAME observed instance.
    for(const object of observation.objects){const association=manifest.graph.meshes.find(mesh=>mesh.sourceObjectId===object.sourceObjectId)!;
      const mapped=observation.nodes.find(node=>node.nodeKey===association.nodeKey)!;mapped.instanceRef=object.instanceRef;mapped.ownedStateSha256=object.ownedStateSha256;}
    const raw={manifest,receipt:{commandId:'66666666-6666-4666-8666-666666666666',receiptSha256:studioImportObservationReceiptDigest(observation),observation}};
    const baseline:ConvertedStudioImportBaselineV2=raw;
    const next=adaptCompletedConvertedStudioImport(f.manifest,f.files,PROJECT,host,baseline);
    assert.deepEqual(next.baseline,baseline);assert.notEqual(next.baseline,baseline);assert.ok(Object.isFrozen(next.baseline!.receipt.observation.nodes));
    raw.receipt.observation.nodes[0]!.ownedStateSha256=sha('later caller mutation');assert.notDeepEqual(next.baseline,raw);
    // Reseal only synthetic metadata so following scope assertions reach their original checks.
    raw.receipt.receiptSha256=studioImportObservationReceiptDigest(raw.receipt.observation);
    assert.throws(()=>adaptCompletedConvertedStudioImport(f.manifest,f.files,'b'.repeat(64),host,baseline));
    const elsewhere=selection();elsewhere.target.parentRef='elsewhere';assert.throws(()=>adaptCompletedConvertedStudioImport(f.manifest,f.files,PROJECT,elsewhere,baseline));
    assert.throws(()=>adaptCompletedConvertedStudioImport(f.manifest,f.files,PROJECT,host,{...baseline,manifest:{...manifest,schemaVersion:1}} as unknown as ConvertedStudioImportBaselineV2));
  }finally{authority.close();}
});
