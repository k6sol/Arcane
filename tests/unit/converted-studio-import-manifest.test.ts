import type {StudioImportObservationReceipt} from '../../packages/protocol/src/studio.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {buildConvertedGraph,convertedGraphDigest,type ConvertedGraphSourceBytes} from '../../packages/asset-pipeline/src/studio-import-graph.js';
import {prepareGlbConversionSource} from '../../packages/asset-pipeline/src/glb-conversion-source.js';
import {convertedGlbObjectId,convertedGlbAssetId,parseConvertedGlbRequest} from '../../packages/asset-pipeline/src/converted-glb.js';
import {CONVERSION_FIDELITY_POLICY,CONVERSION_NODE_KEY,CONVERSION_VERTEX_ID,conversionCorrespondenceSha256} from '../../packages/asset-pipeline/src/conversion-fidelity-policy.js';
import {createStudioImportManifestAuthority,parseConvertedStudioImportManifest,snapshotConvertedStudioImportBaseline,studioImportObservationReceiptDigest,StudioImportManifestError,
  type HostConvertedStudioImportV2,type HostGeneratedStudioImportV1,type ConvertedPreparedStudioImportV2,type GeneratedPreparedStudioImportV1,
  type ConvertedStudioImportBaselineV2,type HostStudioImport} from '../../packages/asset-pipeline/src/studio-import-manifest.js';
import {parseNativeStudioImportResponse} from '../../packages/asset-pipeline/src/studio-import-wire.js';
// Actual constructed GLB bytes and explicitly synthetic audit/receipt records.
// These data fixtures prove no worker, closure, approval or native materialization.
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
const NEXT='33333333-3333-4333-8333-333333333333';
const selection={target:{sessionId:'studio-session',placeId:0,universeId:0,root:'Workspace' as const,parentRef:'selected-parent',creator:{kind:'user' as const,id:'123'}},placement:{mode:'origin' as const},studsPerMeter:2};
const canonical=(v:unknown):string=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v!==null&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical((v as Doc)[k])).join(',')+'}':JSON.stringify(v);
const digest=(v:unknown)=>sha(canonical(v));
function resealGraph(v:Doc):void {const {digest:_digest,...body}=v.graph;v.graph={...body,digest:convertedGraphDigest(body)};}
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
function baseline(prepared:ConvertedPreparedStudioImportV2,live=false):ConvertedStudioImportBaselineV2 {
  const objects=prepared.manifest.objects.map((o,i)=>({sourceObjectId:o.sourceObjectId,instanceRef:'mesh-'+i,meshAssetId:live?null:String(100+i),ownedStateSha256:sha('mesh-state-'+i),
    authoredChildren:[{instanceRef:'script-'+i,kind:'script' as const,stateSha256:sha('script-state-'+i)}]}));
  // Synthetic read metadata exercises schema/delta custody only, never a native witness.
  const observation:StudioImportObservationReceipt={formatVersion:2,observationId:'55555555-5555-4555-8555-555555555555',
    source:{projectId:prepared.manifest.projectId,jobId:prepared.manifest.revisionId,assetId:prepared.manifest.assetId,sourceSha256:prepared.manifest.sourceSha256,
      preparedDigest:prepared.digest,manifestDigest:prepared.manifest.digest,payloadDigest:sha('synthetic previous payload'),transferDigest:sha('synthetic previous transfer'),graphDigest:prepared.manifest.graph.digest,conversionRequestDigest:digest(prepared.manifest.conversionRequest)},
    target:structuredClone(prepared.manifest.target),continuity:{clientLifetimeId:'fixture-plugin',pluginArtifactHash:sha('synthetic plugin'),playEpoch:0},
    modelRef:{instanceId:'model-root',sessionId:prepared.manifest.target.sessionId,root:'Workspace',pathSegments:['Observed model'],className:'Model'},modelOwnedStateSha256:sha('synthetic model state'),objects,
    nodes:prepared.manifest.graph.nodes.map((n,i)=>{const mesh=prepared.manifest.graph.meshes.find(m=>m.nodeKey===n.nodeKey),object=mesh?objects.find(o=>o.sourceObjectId===mesh.sourceObjectId):undefined;
      return {nodeKey:n.nodeKey,instanceRef:object?.instanceRef??'group-'+i,ownedStateSha256:object?.ownedStateSha256??sha('group-state-'+i),authoredChildren:object?.authoredChildren??[]};}),
    receiptScope:'live-import-observation',imported:false,engineVerification:'pending'};
  return {manifest:prepared.manifest,receipt:{commandId:'66666666-6666-4666-8666-666666666666',receiptSha256:studioImportObservationReceiptDigest(observation),observation}};
}

function mutateModel(input:HostConvertedStudioImportV2,mutate:(doc:Doc,bin:Buffer)=>void,fileId='asset-glb'):void {
  const file=input.files.find(f=>f.fileId===fileId)!,bytes=Buffer.from(file.bytes),size=bytes.readUInt32LE(12),doc=JSON.parse(bytes.subarray(20,20+size).toString('utf8')) as Doc,bin=Buffer.from(bytes.subarray(28+size));
  mutate(doc,bin);const changed=pack(doc,bin);file.bytes=changed;file.sha256=sha(changed);
}
const refused=(error:unknown)=>error instanceof Error;
const renderPrimitive=(doc:Doc):Doc=>doc.meshes[doc.nodes.find((n:Doc)=>n.extras?.[CONVERSION_NODE_KEY]==='node2_primitive0').mesh].primitives[0];

test('converted manifest v2 retains complete actual marker hierarchy, source pivots, material values and Y-up request binding',async()=>{
  const f=hostFixture(),input=f.host(),p=await converted(input),m=p.manifest;
  assert.equal(m.origin,'converted-glb');assert.equal(m.identityScheme,'arcane-converted-v2');assert.equal(m.engineVerification,'pending');
  assert.deepEqual(m.conversionRequest,input.conversionRequest);assert.deepEqual(m.graph,input.graph);assert.equal(m.graph.nodes.length,7);
  assert.equal(m.graph.nodes.filter(n=>n.parentKey===null).length,2);assert.equal(m.graph.nodes.find(n=>n.nodeKey==='node3')?.name,'Empty leaf');
  assert.equal(m.graph.nodes.find(n=>n.nodeKey==='node3')!.localMatrix[13],2**-80);assert.equal(m.conversion.sourceUp,'Y');assert.equal(m.conversion.exportUp,'Y');
  assert.deepEqual(m.files.map(file=>file.fileId),['asset-glb']);assert.equal(m.files[0]!.sha256,sha(input.files[0]!.bytes));
  assert.ok(m.objects.every(o=>!Object.hasOwn(o,'parentSourceObjectId')&&o.sourceKey.startsWith('node')&&canonical(o.pivot)==='[0,0,0]'));
  assert.ok(m.objects.some(o=>o.nodeIndex!==f.prepared.parts.find(part=>part.sourceKey===o.sourceKey)!.importNodeIndex));
  assert.deepEqual(m.objects[0]!.bounds,{min:[3,1,0],max:[5,2,0]});assert.deepEqual(m.materials[0]!.baseColor,[.2,.4,.6,1]);
  assert.equal(m.producer.exporterVersion,f.output.asset.generator);assert.equal(p.delta.graph.nextDigest,m.graph.digest);assert.equal(p.delta.graph.previousDigest,null);
  assert.equal(p.delta.graph.changed,true);assert.equal(p.delta.nodes.length,7);assert.ok(p.delta.nodes.every(n=>n.action==='create'&&n.instanceRef===null));
  assert.ok(Object.isFrozen(p)&&Object.isFrozen(m.graph.nodes[0]!.localMatrix)&&Object.isFrozen(p.delta.nodes));
  assert.deepEqual(parseConvertedStudioImportManifest(JSON.parse(JSON.stringify(m))),m);
  assert.deepEqual(parseNativeStudioImportResponse({prepared:p},JOB,input.projectId).prepared,p);
  assert.equal('approved' in m,false);assert.equal('nativeSupported' in m,false);
});

for(const affine of ['scale','shear','reflection'] as const)test('converted manifest data retains '+affine+' before a separate native representability gate',async()=>{
  const f=hostFixture(false,affine),input=f.host(),p=await converted(input);
  assert.deepEqual(p.manifest.graph.nodes.find(n=>n.nodeKey==='node1')!.localMatrix,f.byKey('node1').matrix);
  assert.equal(p.manifest.engineVerification,'pending');assert.ok(p.manifest.objects.some(o=>o.exportTransform[0]===f.byKey('node1').matrix[0]));
});

test('none/hull inventory is exact and collision is a derived root association without an invented source node',async()=>{
  const f=hostFixture(true),input=f.host(),p=await converted(input),collision=p.manifest.objects.find(o=>o.role==='collision')!;
  assert.deepEqual(p.manifest.files.map(f=>f.fileId),['asset-glb','collision-glb']);assert.equal(collision.sourceKey,'proxy');
  assert.equal(p.manifest.graph.meshes.find(m=>m.sourceObjectId===collision.sourceObjectId)!.nodeKey,null);assert.equal(p.manifest.graph.nodes.length,7);
  assert.deepEqual(collision.collisionFor,p.manifest.objects.filter(o=>o.role==='render').map(o=>o.sourceObjectId).sort());
  for(const mutate of [(v:Doc)=>{v.files.pop();v.models.pop();},(v:Doc)=>{v.conversionRequest.collision='none';},
    (v:Doc)=>{v.models[1].objects[0].collisionFor=[];},(v:Doc)=>{v.files.push({...v.files[0],fileId:'extra'});}]){
    const bad=structuredClone(input) as unknown as Doc;mutate(bad);await assert.rejects(prepare(bad as unknown as HostStudioImport),refused);
  }
});

test('complete observed v2 node mappings support exact reuse and preserve authored children',async()=>{
  const first=await converted(hostFixture().host()),next=hostFixture().host(NEXT);next.baseline=baseline(first);
  const p=await converted(next);assert.equal(p.delta.graph.changed,false);assert.equal(p.delta.graph.previousDigest,first.manifest.graph.digest);
  assert.ok(p.delta.nodes.every(n=>n.action==='reuse'));assert.ok(p.delta.objects.every(o=>o.action==='reuse'));
  for(const mesh of p.manifest.graph.meshes){const n=p.delta.nodes.find(n=>n.nodeKey===mesh.nodeKey)!,o=p.delta.objects.find(o=>o.sourceObjectId===mesh.sourceObjectId)!;
    assert.equal(n.instanceRef,o.instanceRef);assert.equal(n.expectedOwnedStateSha256,o.expectedOwnedStateSha256);assert.deepEqual(n.preserveChildren,o.preserveChildren);assert.equal(o.preserveChildren[0]!.kind,'script');}
  assert.deepEqual(snapshotConvertedStudioImportBaseline(next.baseline),next.baseline);
  assert.deepEqual(parseNativeStudioImportResponse({prepared:p},NEXT,next.projectId).prepared,p);
});

test('live converted session baselines retain actual nullable mesh IDs without inventing a cloud Model ID',async()=>{
  const first=await converted(hostFixture().host()),next=hostFixture().host(NEXT);next.baseline=baseline(first,true);const p=await converted(next);
  assert.equal(p.delta.modelAssetId,null);assert.equal(p.delta.modelRef,'model-root');assert.ok(p.delta.objects.every(object=>object.action==='reuse'&&object.meshAssetId===null));
  assert.deepEqual(p.delta.observation,next.baseline.receipt);assert.deepEqual(snapshotConvertedStudioImportBaseline(next.baseline),next.baseline);
  assert.deepEqual(parseNativeStudioImportResponse({prepared:p},NEXT,next.projectId).prepared,p);
  const bad={...next.baseline,receipt:{...next.baseline.receipt,receiptSha256:sha('forged receipt checksum')}};assert.throws(()=>snapshotConvertedStudioImportBaseline(bad),refused);
  assert.throws(()=>snapshotConvertedStudioImportBaseline({...next.baseline,receipt:{...next.baseline.receipt,modelAssetId:'999'}}),refused,'A mesh upload cannot acquire a fictitious Model asset ID through baseline metadata.');
});

test('actual EMPTY name and inherited tiny transform edits update affected nodes and cannot reuse the prior sealed graph',async()=>{
  const first=await converted(hostFixture().host()),f=hostFixture();f.byKey('node1').name='Renamed empty';f.byKey('node1').matrix[12]=1e-6;
  const next=f.host(NEXT);next.baseline=baseline(first);const p=await converted(next);
  assert.equal(p.delta.graph.changed,true);assert.notEqual(p.delta.graph.nextDigest,p.delta.graph.previousDigest);
  const changed=p.delta.nodes.find(n=>n.nodeKey==='node1')!;assert.equal(changed.action,'update-in-place');assert.deepEqual(changed.changed,['matrix','name']);
  assert.ok(p.delta.nodes.find(n=>n.nodeKey==='node2_primitive0')!.changed.includes('matrix'),'A parent world change affects the mesh node');
  assert.equal(p.delta.nodes.find(n=>n.nodeKey==='node3')!.action,'reuse');assert.ok(p.delta.objects.some(o=>o.changed.includes('transform')));
  assert.notEqual(p.manifest.digest,first.manifest.digest);assert.notEqual(p.digest,first.digest);
});

test('graph node/name/parent/matrix/pivot/digest edits cannot be admitted against unchanged actual export bytes',async()=>{
  for(const mutate of [(v:Doc)=>{v.graph.nodes.find((n:Doc)=>n.nodeKey==='node3').name='fake name';resealGraph(v);},
    (v:Doc)=>{v.graph.nodes.find((n:Doc)=>n.nodeKey==='node3').parentKey='node1';resealGraph(v);},
    (v:Doc)=>{v.graph.nodes.find((n:Doc)=>n.nodeKey==='node3').localMatrix[12]=2**-90;resealGraph(v);},
    (v:Doc)=>{v.graph.nodes=v.graph.nodes.filter((n:Doc)=>n.nodeKey!=='node3');resealGraph(v);},
    (v:Doc)=>{v.graph.meshes[0].sourcePivot=[1,0,0];},(v:Doc)=>{v.models[0].objects[0].pivot=[1,0,0];},
    (v:Doc)=>{v.graph.digest=sha('wrong graph');}]){
    const input=structuredClone(hostFixture().host()) as unknown as Doc;mutate(input);await assert.rejects(prepare(input as unknown as HostStudioImport),refused);
  }
});

test('the compiler independently checks actual export markers, IDs, topology, generator, attributes and fixed identities',async()=>{
  for(const mutate of [(doc:Doc)=>{delete doc.nodes.find((n:Doc)=>n.extras?.[CONVERSION_NODE_KEY]==='node3').extras[CONVERSION_NODE_KEY];},
    (doc:Doc)=>{doc.nodes.find((n:Doc)=>n.mesh!==undefined).extras.arcane_pivot=[1,0,0];},
    (doc:Doc)=>{doc.asset.generator='different actual generator';},
    (doc:Doc)=>{const p=renderPrimitive(doc);p.attributes._CALLER_PROOF=p.attributes[CONVERSION_VERTEX_ID];},
    (doc:Doc)=>{delete renderPrimitive(doc).attributes[CONVERSION_VERTEX_ID];},
    (doc:Doc,bin:Buffer)=>{const p=renderPrimitive(doc),a=doc.accessors[p.attributes[CONVERSION_VERTEX_ID]],v=doc.bufferViews[a.bufferView];bin.writeFloatLE(.5,(v.byteOffset??0)+(a.byteOffset??0));},
    (doc:Doc,bin:Buffer)=>{const p=renderPrimitive(doc),a=doc.accessors[p.attributes[CONVERSION_VERTEX_ID]],v=doc.bufferViews[a.bufferView],at=(v.byteOffset??0)+(a.byteOffset??0);bin.writeFloatLE(1,at);bin.writeFloatLE(0,at+4);}]){
    const input=hostFixture().host();mutateModel(input,mutate);await assert.rejects(prepare(input),refused);
  }
});

test('converted baselines refuse graphless/version1, incomplete, duplicate, stale or conflicting instance mappings',async()=>{
  const first=await converted(hostFixture().host());
  for(const mutate of [(v:Doc)=>{delete v.receipt.observation.source.graphDigest;},(v:Doc)=>{v.manifest.schemaVersion=1;},
    (v:Doc)=>{v.receipt.observation.nodes.pop();},(v:Doc)=>{v.receipt.observation.nodes.push(v.receipt.observation.nodes[0]);},
    (v:Doc)=>{v.receipt.observation.source.graphDigest=sha('stale graph');},(v:Doc)=>{v.receipt.observation.nodes[0].instanceRef=v.receipt.observation.modelRef.instanceId;},
    (v:Doc)=>{v.receipt.observation.nodes.find((n:Doc)=>n.nodeKey==='node2_primitive0').instanceRef='foreign-mesh';},
    (v:Doc)=>{v.manifest.graph.nodes[0].name='stale name';}]){
    const input=hostFixture().host(NEXT),observed=structuredClone(baseline(first)) as unknown as Doc;mutate(observed);observed.receipt.receiptSha256=digest(observed.receipt.observation);input.baseline=observed as ConvertedStudioImportBaselineV2;
    await assert.rejects(prepare(input),refused);assert.throws(()=>snapshotConvertedStudioImportBaseline(observed),refused);
  }
});

test('converted closed schemas, opaque admission and detached snapshots reject caller authority and executable shapes',async()=>{
  let calls=0;const input=hostFixture().host();
  for(const mutate of [(v:Doc)=>{v.schemaVersion=1;},(v:Doc)=>{v.conversionRequest.schemaVersion=1;},(v:Doc)=>{v.identityScheme='arcane-generated-v1';},
    (v:Doc)=>{v.graph.approved=true;},(v:Doc)=>{v.conversionRequest.fidelityPolicy='caller-policy';},(v:Doc)=>{v.models[0].objects[0].parentSourceObjectId=null;},
    (v:Doc)=>{v.path='C:/caller.glb';}]){const bad=structuredClone(input) as unknown as Doc;mutate(bad);await assert.rejects(prepare(bad as unknown as HostStudioImport),refused);}
  const getter=Object.defineProperty({...input},'graph',{enumerable:true,get(){calls++;return input.graph;}}),proxy=new Proxy({}, {ownKeys(){calls++;return [];}});
  for(const bad of [getter,proxy]){const host=createStudioImportManifestAuthority({loadGeneratedFiles:async()=>bad as unknown as HostStudioImport});await assert.rejects(host.admit(JOB),refused);host.close();}
  const nullArray=structuredClone(input) as unknown as Doc;Object.setPrototypeOf(nullArray.graph.nodes,null);await assert.rejects(prepare(nullArray as unknown as HostStudioImport),refused);assert.equal(calls,0);
  const authority=createStudioImportManifestAuthority({loadGeneratedFiles:async()=>input}),token=await authority.admit(JOB),before=authority.prepare(token);
  input.files[0]!.bytes.fill(0);assert.deepEqual(authority.prepare(token),before);assert.throws(()=>authority.prepare(structuredClone(token)),StudioImportManifestError);authority.revoke(token);assert.throws(()=>authority.prepare(token),StudioImportManifestError);authority.close();
});

test('generated v1 preserves exact legacy serialized manifest, delta and prepared bytes with no optional graph extension',async()=>{
  const positions=[[0,0,0],[1,0,0],[0,1,0]],{doc,bin}=geometry(positions,[0,1,2]);doc.nodes[0].name='Generated triangle';const bytes=pack(doc,bin),H=sha('generated source');
  const input:HostGeneratedStudioImportV1={schemaVersion:1,projectId:sha('project'),assetId:'generated-prop',revisionId:JOB,sourceSha256:H,producer:{blenderVersion:'synthetic',exporterVersion:'synthetic'},
    ...structuredClone(selection),files:[{fileId:'model',contentType:'model/gltf-binary',sha256:sha(bytes),bytes}],models:[{fileId:'model',resources:[],objects:[{sourceObjectId:'part',nodeIndex:0,role:'render',pivot:[0,0,0],collisionFor:[]}]}],anchors:[],baseline:null};
  const p=await prepare(input) as GeneratedPreparedStudioImportV1,meshHash=digest([{attributes:{POSITION:positions},indices:[0,1,2],mode:4}]),b={min:[0,0,0],max:[1,1,0]};
  const content={schemaVersion:1,status:'prepared',engineVerification:'pending',projectId:input.projectId,assetId:'generated-prop',revisionId:JOB,sourceSha256:H,producer:input.producer,
    target:input.target,placement:input.placement,conversion:{sourceUnits:'meters',sourceUp:'Z',exportUnits:'meters',exportUp:'Y',targetUnits:'studs',targetUp:'Y',studsPerMeter:2},
    files:[{fileId:'model',contentType:'model/gltf-binary',sha256:sha(bytes),byteLength:bytes.length}],objects:[{sourceObjectId:'part',name:'Generated triangle',role:'render',parentSourceObjectId:null,
      exportFileId:'model',nodeIndex:0,meshExportSha256:meshHash,triangles:1,materialSha256:null,textureSha256s:[],exportTransform:identity(),scale:[1,1,1],pivot:[0,0,0],bounds:b,worldBounds:b,collisionFor:[]}],
    materials:[],textures:[],anchors:[],bounds:b,limitations:['Prepared files are not uploaded, moderated, inserted or verified in Studio.','Axes, scale, placement, collision and appearance require in-engine verification.',
      'PBR factors, alpha modes and packed G/B maps require host-supported baking/conversion before SurfaceAppearance assignment.','LOD switching, rigs and animation require separate supported adapters.']};
  const manifest={...content,digest:digest(content)},delta={previousDigest:null,nextDigest:manifest.digest,receiptSha256:null,modelRef:null,modelAssetId:null,placementChanged:false,
    objects:[{sourceObjectId:'part',action:'create',changed:[],instanceRef:null,meshAssetId:null,expectedOwnedStateSha256:null,preserveChildren:[],replaceInstance:false,deleteInstance:false}],
    reviewRemovals:[],reviewAnchors:[],geometry:{prepare:[meshHash],reuse:[]},textures:{prepare:[],reuse:[]},preservation:'preserve-all-scripts-attachments-constraints'};
  assert.equal(JSON.stringify(p),JSON.stringify({status:'prepared',manifest,delta,digest:digest({manifestDigest:manifest.digest,delta})}));
  assert.deepEqual(parseNativeStudioImportResponse(JSON.parse(JSON.stringify({prepared:p})),JOB,input.projectId).prepared,p);
  assert.equal('graph' in p.manifest,false);assert.equal('origin' in p.manifest,false);assert.equal('graph' in p.delta,false);
  await assert.rejects(prepare({...input,graph:hostFixture().host().graph} as HostGeneratedStudioImportV1),StudioImportManifestError);
});
