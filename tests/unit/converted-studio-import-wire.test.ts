import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {buildConvertedGraph,convertedGraphDigest,type ConvertedGraphSourceBytes} from '../../packages/asset-pipeline/src/studio-import-graph.js';
import {prepareGlbConversionSource} from '../../packages/asset-pipeline/src/glb-conversion-source.js';
import {convertedGlbObjectId,convertedGlbAssetId,parseConvertedGlbRequest} from '../../packages/asset-pipeline/src/converted-glb.js';
import {CONVERSION_FIDELITY_POLICY,CONVERSION_NODE_KEY,CONVERSION_VERTEX_ID,conversionCorrespondenceSha256} from '../../packages/asset-pipeline/src/conversion-fidelity-policy.js';
import {createStudioImportManifestAuthority,parseConvertedStudioImportManifest,snapshotConvertedStudioImportBaseline,StudioImportManifestError,
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
function baseline(prepared:ConvertedPreparedStudioImportV2):ConvertedStudioImportBaselineV2 {
  const objects=prepared.manifest.objects.map((o,i)=>({sourceObjectId:o.sourceObjectId,instanceRef:'mesh-'+i,meshAssetId:String(100+i),ownedStateSha256:sha('mesh-state-'+i),
    authoredChildren:[{instanceRef:'script-'+i,kind:'script' as const,stateSha256:sha('script-state-'+i)}]}));
  return{manifest:prepared.manifest,receipt:{manifestDigest:prepared.manifest.digest,graphDigest:prepared.manifest.graph.digest,receiptSha256:sha('synthetic observed receipt'),modelRef:'model-root',modelAssetId:'999',objects,
    nodes:prepared.manifest.graph.nodes.map((n,i)=>{const mesh=prepared.manifest.graph.meshes.find(m=>m.nodeKey===n.nodeKey),object=mesh?objects.find(o=>o.sourceObjectId===mesh.sourceObjectId):undefined;
      return{nodeKey:n.nodeKey,instanceRef:object?.instanceRef??'group-'+i,ownedStateSha256:object?.ownedStateSha256??sha('group-state-'+i),authoredChildren:object?.authoredChildren??[]};})}};
}
function mutateModel(input:HostConvertedStudioImportV2,mutate:(doc:Doc,bin:Buffer)=>void,fileId='asset-glb'):void {
  const file=input.files.find(f=>f.fileId===fileId)!,bytes=Buffer.from(file.bytes),size=bytes.readUInt32LE(12),doc=JSON.parse(bytes.subarray(20,20+size).toString('utf8')) as Doc,bin=Buffer.from(bytes.subarray(28+size));
  mutate(doc,bin);const changed=pack(doc,bin);file.bytes=changed;file.sha256=sha(changed);
}
const refused=(error:unknown)=>error instanceof Error;

function resealPrepared(value:Doc):void {
  const manifest=value.prepared.manifest,{digest:_digest,...body}=manifest;manifest.digest=digest(body);
  value.prepared.delta.nextDigest=manifest.digest;value.prepared.digest=digest({manifestDigest:manifest.digest,delta:value.prepared.delta});
}
const wire=(v:unknown,job=JOB)=>parseNativeStudioImportResponse(v,job,sha('project'));

for(const hull of [false,true])test('converted '+(hull?'hull':'none')+' wire round-trips actual compiled buffers without granting import authority',async()=>{
  const input=hostFixture(hull).host(),p=await converted(input),serialized=JSON.parse(JSON.stringify({prepared:p}));
  assert.deepEqual(wire(serialized).prepared,p);assert.equal(serialized.prepared.manifest.schemaVersion,2);
  assert.equal(serialized.prepared.manifest.origin,'converted-glb');assert.equal(serialized.prepared.manifest.graph.nodes.length,7);
  assert.equal(serialized.prepared.manifest.graph.meshes.length,hull?3:2);assert.equal(serialized.prepared.manifest.engineVerification,'pending');
  assert.equal('admission' in serialized.prepared,false);assert.equal('approved' in serialized.prepared,false);
  assert.equal('graph' in serialized.prepared.delta,true);assert.ok(serialized.prepared.delta.nodes.every((n:Doc)=>n.replaceInstance===false&&n.deleteInstance===false));
});

test('closed converted wire refuses mixed versions, omitted request/graph, caller policy and wrong expected scope',async()=>{
  const p=await converted(hostFixture().host());
  for(const mutate of [(v:Doc)=>{v.prepared.manifest.schemaVersion=1;},(v:Doc)=>{v.prepared.manifest.schemaVersion=3;},
    (v:Doc)=>{delete v.prepared.manifest.graph;},(v:Doc)=>{delete v.prepared.manifest.conversionRequest;},
    (v:Doc)=>{v.prepared.manifest.conversionRequest.schemaVersion=1;},(v:Doc)=>{v.prepared.manifest.conversionRequest.fidelityPolicy='caller-policy';},
    (v:Doc)=>{v.prepared.manifest.conversion.sourceUp='Z';},(v:Doc)=>{v.prepared.manifest.objects[0].parentSourceObjectId=null;},
    (v:Doc)=>{v.prepared.manifest.graph.hostApproved=true;},(v:Doc)=>{v.prepared.manifest.authority=true;},
    (v:Doc)=>{v.prepared.manifest.identityScheme='arcane-generated-v1';}]){
    const v=structuredClone({prepared:p}) as unknown as Doc;mutate(v);resealPrepared(v);assert.throws(()=>wire(v),refused);
  }
  assert.throws(()=>wire({prepared:p},NEXT),refused);assert.throws(()=>parseNativeStudioImportResponse({prepared:p},JOB,sha('foreign project')),refused);
});

test('graph/request/manifest/prepared digests and exact graph node coverage remain mutually bound',async()=>{
  const p=await converted(hostFixture().host());
  for(const mutate of [(v:Doc)=>{v.prepared.manifest.graph.digest=sha('foreign');},(v:Doc)=>{v.prepared.delta.graph.nextDigest=sha('foreign');},
    (v:Doc)=>{v.prepared.delta.graph.previousDigest=sha('foreign');},(v:Doc)=>{v.prepared.delta.graph.changed=false;},
    (v:Doc)=>{v.prepared.delta.nodes.pop();},(v:Doc)=>{v.prepared.delta.nodes.push(v.prepared.delta.nodes[0]);},
    (v:Doc)=>{v.prepared.delta.nodes[0].nodeKey='node999';},(v:Doc)=>{v.prepared.manifest.conversionRequest.sourceSha256=sha('foreign');},
    (v:Doc)=>{v.prepared.manifest.objects[0].sourceKey='node999_primitive0';},(v:Doc)=>{v.prepared.manifest.objects[0].pivot=[1,0,0];}]){
    const v=structuredClone({prepared:p}) as unknown as Doc;mutate(v);resealPrepared(v);assert.throws(()=>wire(v),refused);
  }
  const v=structuredClone({prepared:p}) as unknown as Doc;v.prepared.digest=sha('unbound prepared');assert.throws(()=>wire(v),refused);
});

test('graph name or direct-parent edits cannot silently carry forward an all-reuse observed node plan',async()=>{
  const first=await converted(hostFixture().host()),input=hostFixture().host(NEXT);input.baseline=baseline(first);const p=await converted(input);
  assert.ok(p.delta.nodes.every(n=>n.action==='reuse'));assert.deepEqual(wire({prepared:p},NEXT).prepared,p);
  for(const mutate of [(g:Doc)=>{g.nodes.find((n:Doc)=>n.nodeKey==='node3').name='resealed name';},
    (g:Doc)=>{g.nodes.find((n:Doc)=>n.nodeKey==='node3').parentKey='node1';}]){
    const v=structuredClone({prepared:p}) as unknown as Doc;mutate(v.prepared.manifest.graph);resealGraph(v.prepared.manifest);
    v.prepared.delta.graph.nextDigest=v.prepared.manifest.graph.digest;v.prepared.delta.graph.changed=true;resealPrepared(v);
    assert.throws(()=>wire(v,NEXT),refused,'A new sealed graph cannot be paired with an unchanged all-reuse graph plan');
  }
});

test('converted node actions and mesh/node observed mappings preserve exact ownership and authored children',async()=>{
  const first=await converted(hostFixture().host()),input=hostFixture().host(NEXT);input.baseline=baseline(first);const p=await converted(input);
  const meshKey=p.manifest.graph.meshes.find(m=>m.nodeKey!==null)!.nodeKey;
  for(const mutate of [(v:Doc)=>{v.prepared.delta.nodes.find((n:Doc)=>n.nodeKey===meshKey).instanceRef='foreign';},
    (v:Doc)=>{v.prepared.delta.nodes.find((n:Doc)=>n.nodeKey===meshKey).expectedOwnedStateSha256=sha('foreign');},
    (v:Doc)=>{v.prepared.delta.nodes.find((n:Doc)=>n.nodeKey===meshKey).preserveChildren=[];},
    (v:Doc)=>{v.prepared.delta.nodes[0].replaceInstance=true;},(v:Doc)=>{v.prepared.delta.nodes[0].deleteInstance=true;},
    (v:Doc)=>{v.prepared.delta.nodes[0].changed=['name'];},(v:Doc)=>{v.prepared.delta.nodes[0].action='update-in-place';},
    (v:Doc)=>{v.prepared.delta.nodes.find((n:Doc)=>n.nodeKey==='node3').instanceRef=v.prepared.delta.modelRef;},
    (v:Doc)=>{v.prepared.delta.reviewNodeRemovals.push({nodeKey:'node3',instanceRef:'removed',ownedStateSha256:sha('removed'),authoredChildren:[],action:'retain-for-review'});}]){
    const v=structuredClone({prepared:p}) as unknown as Doc;mutate(v);resealPrepared(v);assert.throws(()=>wire(v,NEXT),refused);
  }
});

test('wire descriptors, arrays and finite envelope bounds reject executable metadata without invoking it',async()=>{
  const p=await converted(hostFixture().host());let calls=0;
  const proxy=new Proxy({}, {ownKeys(){calls++;throw Error('Not invoked');}}),getter=Object.defineProperty({},'prepared',{enumerable:true,get(){calls++;return p;}});
  const hidden=Object.defineProperty({prepared:p},'hidden',{value:1}),symbol={prepared:p,[Symbol('authority')]:true};
  const nullArray=structuredClone({prepared:p}) as unknown as Doc;Object.setPrototypeOf(nullArray.prepared.manifest.graph.nodes,null);
  const sparse=structuredClone({prepared:p}) as unknown as Doc;delete sparse.prepared.delta.nodes[0];
  for(const v of [proxy,getter,hidden,symbol,nullArray,sparse])assert.throws(()=>wire(v),refused);assert.equal(calls,0);
  const oversized=structuredClone({prepared:p}) as unknown as Doc;oversized.prepared.delta.nodes=Array.from({length:4097},()=>oversized.prepared.delta.nodes[0]);assert.throws(()=>wire(oversized),refused);
});
