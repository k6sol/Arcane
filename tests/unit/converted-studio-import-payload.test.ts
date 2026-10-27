import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {buildConvertedGraph,convertedGraphDigest,type ConvertedGraphSourceBytes} from '../../packages/asset-pipeline/src/studio-import-graph.js';
import {prepareGlbConversionSource} from '../../packages/asset-pipeline/src/glb-conversion-source.js';
import {convertedGlbObjectId,convertedGlbAssetId,parseConvertedGlbRequest} from '../../packages/asset-pipeline/src/converted-glb.js';
import {CONVERSION_FIDELITY_POLICY,CONVERSION_NODE_KEY,CONVERSION_VERTEX_ID,conversionCorrespondenceSha256} from '../../packages/asset-pipeline/src/conversion-fidelity-policy.js';
import {createStudioImportManifestAuthority,type HostConvertedStudioImportV2,type HostGeneratedStudioImportV1,type HostStudioImport,type ConvertedPreparedStudioImportV2} from '../../packages/asset-pipeline/src/studio-import-manifest.js';
import {decodeStudioImportPayload,assertDecodedStudioImportPayload,assertConvertedStudioImportRepresentable,StudioImportPayloadError,STUDIO_IMPORT_PAYLOAD_LIMITS,type ConvertedStudioImportPayloadV2,type StudioImportPayloadBuffer} from '../../packages/asset-pipeline/src/studio-import-payload.js';

// Reused C119 bounded source/graph constructor, enriched with duplicate-position
// seam vertices, source normals/UV0 and supported PBR. Audit/runtime are synthetic.
// No native execution, worker closure, review or Studio materialization is proved.
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
function fixture(collision=false,affine:'rigid'|'scale'|'shear'|'reflection'='rigid',edit?:(doc:Doc,add:(rows:number[][],type:string)=>number)=>void){
  const original=geometry([[3,1,0],[5,1,0],[5,2,0],[3,1,0],[5,2,0],[3,2,0]],[0,1,2,3,4,5]);
  const matrix=identity();if(affine==='scale'){matrix[0]=2;matrix[5]=3;}if(affine==='shear')matrix[4]=.25;if(affine==='reflection')matrix[0]=-1;
  original.doc.nodes=[{name:'Root',children:[1,3],translation:[2,3,4]},{name:'Empty ancestor',children:[2],matrix},{name:'Off-centre mesh',mesh:0},
    {name:'Empty leaf',translation:[0,2**-80,0]},{name:'Second root',mesh:0,translation:[-4,0,1]}];original.doc.scenes=[{nodes:[0,4]}];
  original.doc.materials=[{pbrMetallicRoughness:{baseColorFactor:[.2,.4,.6,1],metallicFactor:.3,roughnessFactor:.7}}];original.doc.meshes[0].primitives[0].material=0;
  const add=(rows:number[][],type:string):number=>{
    const raw=Buffer.alloc(rows.flat().length*4);rows.flat().forEach((n,i)=>raw.writeFloatLE(n,i*4));
    const offset=(original.bin.length+3)&~3,view=original.doc.bufferViews.length,index=original.doc.accessors.length;
    original.bin=Buffer.concat([original.bin,Buffer.alloc(offset-original.bin.length),raw]);
    original.doc.bufferViews.push({buffer:0,byteOffset:offset,byteLength:raw.length});
    original.doc.accessors.push({bufferView:view,componentType:5126,count:rows.length,type});return index;
  };
  original.doc.meshes[0].primitives[0].attributes.NORMAL=add(Array.from({length:6},()=>[0,0,1]),'VEC3');
  original.doc.meshes[0].primitives[0].attributes.TEXCOORD_0=add([[0,0],[1,0],[1,1],[.25,0],[1,1],[0,1]],'VEC2');
  Object.assign(original.doc.materials[0],{doubleSided:true,alphaMode:'MASK',alphaCutoff:.5});edit?.(original.doc,add);
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
    vertices:6,triangles:2,boundaryEdges:6,nonManifoldEdges:6,looseVertices:0,looseEdges:0,degenerateFaces:0,invalidUVs:0,uvLayers:0,finitePositions:true,
    geometrySha256:sha('synthetic measured geometry'),correspondenceSha256:conversionCorrespondenceSha256([[0,1,2],[3,4,5]]),materialSha256:sha('synthetic measured material')}));
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
function hostFixture(collision=false,affine:'rigid'|'scale'|'shear'|'reflection'='rigid',edit?:(doc:Doc,add:(rows:number[][],type:string)=>number)=>void){
  const f=fixture(collision,affine,edit);
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

const failCode=(code:StudioImportPayloadError['code'])=>(error:unknown)=>error instanceof StudioImportPayloadError&&error.code===code;
const files=(input:HostConvertedStudioImportV2)=>new Map(input.files.map(file=>[file.fileId,file.bytes]));
function payloadCanonical(value:unknown):string {
  if(value instanceof Uint8Array)return payloadCanonical({byteLength:value.byteLength,sha256:sha(value)});
  return Array.isArray(value)?'['+value.map(payloadCanonical).join(',')+']':value!==null&&typeof value==='object'?'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+payloadCanonical((value as Doc)[key])).join(',')+'}':JSON.stringify(value);
}
function verifyPayload(payload:ConvertedStudioImportPayloadV2){
  let binary=0,count=0;
  for(const object of payload.objects)for(const primitive of object.primitives){
    for(const buffer of [...Object.values(primitive.attributes),primitive.indices] as StudioImportPayloadBuffer[]){
      binary+=buffer.byteLength;let offset=0;const parts:Buffer[]=[];
      for(const chunk of buffer.chunks){assert.equal(chunk.formatVersion,2);assert.equal(chunk.manifestDigest,payload.manifestDigest);assert.equal(chunk.semantic,buffer.semantic);
        assert.equal(chunk.offset,offset);const part=Buffer.from(chunk.data,'base64');assert.equal(sha(part),chunk.sha256);assert.equal(part.length,chunk.byteLength);
        offset+=part.length;parts.push(part);count++;assert.ok(Buffer.byteLength(JSON.stringify(chunk))<=STUDIO_IMPORT_PAYLOAD_LIMITS.encodedChunkBytes);}
      assert.equal(offset,buffer.byteLength);assert.equal(sha(Buffer.concat(parts)),buffer.sha256);assert.deepEqual(Buffer.concat(parts),Buffer.from(buffer.bytes));
    }
  }
  assert.equal(binary,payload.binaryByteLength);assert.equal(count,payload.chunkCount);
  const {digest:actual,...body}=payload;assert.equal(sha(payloadCanonical(body)),actual);
}
function changedExport(prepared:ConvertedPreparedStudioImportV2,input:HostConvertedStudioImportV2,mutate:(doc:Doc,bin:Buffer)=>void){
  const map=files(input),bytes=Buffer.from(map.get('asset-glb')!),size=bytes.readUInt32LE(12),doc=JSON.parse(bytes.subarray(20,20+size).toString()) as Doc,bin=Buffer.from(bytes.subarray(28+size));
  mutate(doc,bin);const changed=pack(doc,bin),next=structuredClone(prepared) as unknown as Doc;
  const file=next.manifest.files.find((f:Doc)=>f.fileId==='asset-glb');file.sha256=sha(changed);file.byteLength=changed.length;
  const {digest:_digest,...content}=next.manifest;next.manifest.digest=digest(content);next.delta.nextDigest=next.manifest.digest;
  next.digest=digest({manifestDigest:next.manifest.digest,delta:next.delta});map.set('asset-glb',changed);
  return{prepared:next as ConvertedPreparedStudioImportV2,map};
}
const primitive=(doc:Doc)=>doc.meshes[doc.nodes.find((node:Doc)=>node.extras?.[CONVERSION_NODE_KEY]==='node2_primitive0').mesh].primitives[0] as Doc;

for(const hull of [false,true])test('payload2 retains full '+(hull?'hull':'none')+' graph, source pivots, seam attributes and sealed host ID proof',async()=>{
  const f=hostFixture(hull),input=f.host(),prepared=await converted(input),map=files(input),original=new Map([...map].map(([key,bytes])=>[key,sha(bytes)]));
  const payload=decodeStudioImportPayload(prepared,map);assert.equal(payload.formatVersion,2);if(payload.formatVersion!==2)assert.fail('Expected converted payload2');
  assertDecodedStudioImportPayload(payload);assert.equal(payload.origin,'converted-glb');assert.equal(payload.identityScheme,'arcane-converted-v2');
  assert.deepEqual(payload.conversionRequest,prepared.manifest.conversionRequest);assert.deepEqual(payload.graph,prepared.manifest.graph);
  assert.equal(payload.graph.nodes.length,7);assert.equal(payload.graph.nodes.filter(node=>node.parentKey===null).length,2);
  assert.equal(payload.graph.nodes.find(node=>node.nodeKey==='node3')!.name,'Empty leaf');assert.equal(payload.graph.nodes.find(node=>node.nodeKey==='node2')!.parentKey,'node1');
  assert.equal(payload.conversion.sourceUp,'Y');assert.equal(payload.conversion.exportUp,'Y');assert.equal(payload.conversion.studsPerMeter,2);
  assert.equal(payload.engineVerification,'pending');assert.equal('approved'in payload,false);assert.deepEqual(payload.anchors,[]);
  for(const object of payload.objects){
    assert.deepEqual(object.association,payload.graph.meshes.find(mesh=>mesh.sourceObjectId===object.object.sourceObjectId));assert.deepEqual(object.association.sourcePivot,[0,0,0]);
    assert.equal('parentSourceObjectId'in object.object,false);
    for(const p of object.primitives){
      assert.equal(CONVERSION_VERTEX_ID in p.attributes,false);assert.equal(p.source.attributes!==undefined,true);
      if(object.object.role==='collision'){assert.equal(p.correspondence,null);continue;}
      assert.equal(p.vertexCount,6,'Duplicate-position seam vertices remain distinct');assert.equal(p.triangleCount,2);
      assert.deepEqual(p.correspondence!.ids,[0,1,2,3,4,5]);assert.equal(p.correspondence!.orientedTriangleSha256,object.association.correspondenceSha256);
      assert.equal(p.correspondence!.semantic,CONVERSION_VERTEX_ID);assert.ok(Object.isFrozen(p.correspondence!.ids));
      assert.deepEqual(Array.from(new Float32Array(p.attributes.POSITION!.bytes.buffer)),[3,1,0,5,1,0,5,2,0,3,1,0,5,2,0,3,2,0]);
      assert.deepEqual(Array.from(new Float32Array(p.attributes.TEXCOORD_0!.bytes.buffer)),[0,0,1,0,1,1,.25,0,1,1,0,1]);
      assert.ok(p.attributes.NORMAL);assert.equal(object.material!.doubleSided,true);assert.equal(object.material!.alphaMode,'MASK');
      assert.deepEqual(object.material!.baseColor,[.2,.4,.6,1]);
    }
  }
  assert.equal(payload.sourceDocuments.length,hull?2:1);assert.equal((payload.sourceDocuments.find(doc=>doc.fileId==='asset-glb')!.document.nodes as unknown[]).length,7);
  assert.ok(payload.sourceDocuments.every(doc=>doc.jsonSha256.length===64));verifyPayload(payload);
  assert.deepEqual(new Map([...map].map(([key,bytes])=>[key,sha(bytes)])),original);
  const serialized=JSON.parse(JSON.stringify(payload)) as ConvertedStudioImportPayloadV2;
  assert.throws(()=>assertDecodedStudioImportPayload(serialized),failCode('SCHEMA'));
  assertConvertedStudioImportRepresentable(serialized.graph,serialized.objects.map(object=>object.object));
  assert.throws(()=>assertDecodedStudioImportPayload(serialized),failCode('SCHEMA'),'A metadata-only eligibility check cannot create decoded authority');
});

test('proper noncommuting grouping rotations retain actual matrices, empty ancestry and off-centre pivots without flattening',async()=>{
  const f=hostFixture(false,'rigid',doc=>{doc.nodes[0].rotation=[0,Math.sin(.3),0,Math.cos(.3)];const c=Math.cos(.4),s=Math.sin(.4);
    doc.nodes[1].matrix=[c,s,0,0,-s,c,0,0,0,0,1,0,0,0,0,1];});
  const input=f.host(),prepared=await converted(input),payload=decodeStudioImportPayload(prepared,files(input));assert.equal(payload.formatVersion,2);
  if(payload.formatVersion!==2)assert.fail('Expected converted payload2');
  assert.deepEqual(payload.graph,prepared.manifest.graph);assert.ok(payload.objects.some(object=>object.object.exportTransform.some(value=>value!==0&&value!==1)));
  assert.ok(payload.objects.every(object=>canonical(object.object.pivot)==='[0,0,0]'));verifyPayload(payload);
});

for(const affine of ['scale','shear','reflection'] as const)test('native target refuses '+affine+' grouping while retaining the full converted metadata domain',async()=>{
  const f=hostFixture(false,affine),input=f.host(),prepared=await converted(input),before=JSON.stringify(prepared);
  assert.equal(prepared.manifest.schemaVersion,2);assert.deepEqual(prepared.manifest.graph,input.graph);
  assert.throws(()=>decodeStudioImportPayload(prepared,files(input)),failCode('UNSUPPORTED_TRANSFORM'));
  assert.equal(JSON.stringify(prepared),before);assert.deepEqual(f.output.nodes.find((node:Doc)=>node.extras?.[CONVERSION_NODE_KEY]==='node1').matrix,input.graph.nodes.find(node=>node.nodeKey==='node1')!.localMatrix);
});

for(const value of [.5,1])test('payload2 independently refuses '+(value===.5?'fractional':'reassociated')+' host IDs after export checksums are resealed',async()=>{
  const input=hostFixture().host(),prepared=await converted(input),changed=changedExport(prepared,input,(doc,bin)=>{
    const p=primitive(doc),a=doc.accessors[p.attributes[CONVERSION_VERTEX_ID]],view=doc.bufferViews[a.bufferView],at=(view.byteOffset??0)+(a.byteOffset??0);bin.writeFloatLE(value,at);
    // Keep the GLB structurally valid so the independent ID mapping check is reached.
    const ids=Array.from({length:a.count},(_,index)=>bin.readFloatLE(at+index*(view.byteStride??4)));a.min=[Math.min(...ids)];a.max=[Math.max(...ids)];
  });
  assert.throws(()=>decodeStudioImportPayload(changed.prepared,changed.map),failCode('MAPPING'));
});

test('reordered markers, omitted EMPTYs and local-name/parent faults cannot hide behind resealed file checksums',async()=>{
  const input=hostFixture().host(),prepared=await converted(input);
  for(const mutate of [(doc:Doc)=>{doc.nodes.find((node:Doc)=>node.extras?.[CONVERSION_NODE_KEY]==='node3').name='changed';},
    (doc:Doc)=>{delete doc.nodes.find((node:Doc)=>node.extras?.[CONVERSION_NODE_KEY]==='node3').extras[CONVERSION_NODE_KEY];},
    (doc:Doc)=>{const root=doc.nodes.find((node:Doc)=>node.extras?.[CONVERSION_NODE_KEY]==='node0'),parent=doc.nodes.find((node:Doc)=>node.extras?.[CONVERSION_NODE_KEY]==='node1'),leaf=doc.nodes.findIndex((node:Doc)=>node.extras?.[CONVERSION_NODE_KEY]==='node3');
      root.children=root.children.filter((i:number)=>i!==leaf);parent.children.push(leaf);}]){
    const changed=changedExport(prepared,input,doc=>mutate(doc));assert.throws(()=>decodeStudioImportPayload(changed.prepared,changed.map),failCode('MAPPING'));
  }
});

for(const semantic of ['TANGENT','COLOR_0'] as const)test('authored '+semantic+' remains source-bound conversion data and explicitly refuses the initial native payload subset',async()=>{
  const f=hostFixture(false,'rigid',(doc,add)=>{doc.meshes[0].primitives[0].attributes[semantic]=add(Array.from({length:6},()=>semantic==='TANGENT'?[1,0,0,1]:[1,0,.5,1]),'VEC4');});
  const input=f.host(),prepared=await converted(input);assert.ok(primitive(f.output).attributes[semantic]!==undefined);
  assert.throws(()=>decodeStudioImportPayload(prepared,files(input)),failCode('UNSUPPORTED_ATTRIBUTE'));
});

test('extra UV, unknown custom attributes and unsupported blending never become silently truncated authoring data',async()=>{
  const input=hostFixture().host(),prepared=await converted(input);
  for(const semantic of ['TEXCOORD_1','_UNKNOWN']){
    const changed=changedExport(prepared,input,doc=>{primitive(doc).attributes[semantic]=primitive(doc).attributes.TEXCOORD_0;});
    assert.throws(()=>decodeStudioImportPayload(changed.prepared,changed.map),failCode('UNSUPPORTED_ATTRIBUTE'));
  }
  const blend=hostFixture(false,'rigid',doc=>{doc.materials[0].alphaMode='BLEND';}),blended=blend.host(),plan=await converted(blended);
  assert.throws(()=>decodeStudioImportPayload(plan,files(blended)),failCode('UNSUPPORTED_MATERIAL'));
});

test('payload2 metadata/chunk budgets and genuine per-process admission remain fail-closed',async()=>{
  const input=hostFixture().host(),prepared=await converted(input);
  assert.throws(()=>decodeStudioImportPayload(prepared,files(input),{binaryBytes:1}),failCode('BUDGET'));
  assert.throws(()=>decodeStudioImportPayload(prepared,files(input),{encodedBytes:1}),failCode('BUDGET'));
  const expanded=structuredClone(input.graph) as unknown as Doc;
  for(let i=10;i<140;i++)expanded.nodes.push({nodeKey:'node'+i,parentKey:null,name:'retained empty',localMatrix:identity()});
  const {digest:_digest,...body}=expanded;expanded.digest=convertedGraphDigest(body);
  assert.throws(()=>assertConvertedStudioImportRepresentable(expanded as unknown as typeof input.graph,prepared.manifest.objects),failCode('BUDGET'));
  const foreign={...prepared,manifest:{...prepared.manifest,schemaVersion:1}} as unknown as ConvertedPreparedStudioImportV2;
  assert.throws(()=>decodeStudioImportPayload(foreign,files(input)),failCode('SCHEMA'));
  let called=0;const getter=Object.defineProperty({...prepared},'manifest',{get(){called++;return prepared.manifest;}});
  assert.throws(()=>decodeStudioImportPayload(getter,files(input)),failCode('SCHEMA'));
  const map=files(input);Object.defineProperty(map,Symbol.iterator,{get(){called++;throw Error('Not invoked');}});
  assert.throws(()=>decodeStudioImportPayload(prepared,map),failCode('SCHEMA'));assert.equal(called,0);
});

test('generated v1 retains its graphless shape, Z-up declaration, version1 chunks and per-process decoded admission',async()=>{
  const source=geometry([[0,0,0],[1,0,0],[0,1,0]],[0,1,2]),id='arcane_'+sha('legacy-render');
  source.doc.asset.generator='Khronos glTF Blender I/O v4.5.48';source.doc.nodes[0].name='body';
  source.doc.nodes[0].extras={arcane_identity_scheme:'arcane-semantic-v1',arcane_source_object_id:id,arcane_source_key:'body',arcane_role:'render',arcane_pivot:[0,0,0],arcane_collision_for:'[]'};
  const bytes=pack(source.doc,source.bin),before=Buffer.from(bytes),input:HostGeneratedStudioImportV1={schemaVersion:1,projectId:sha('project'),assetId:'arcane_'+sha('legacy-asset'),revisionId:JOB,sourceSha256:sha('legacy-source'),
    producer:{blenderVersion:'4.5.3 LTS',exporterVersion:'Khronos glTF Blender IO v4.5.48'},...structuredClone(selection),
    files:[{fileId:'legacy-export',contentType:'model/gltf-binary',sha256:sha(bytes),bytes}],models:[{fileId:'legacy-export',resources:[],objects:[{sourceObjectId:id,nodeIndex:0,role:'render',pivot:[0,0,0],collisionFor:[]}]}],anchors:[],baseline:null};
  const prepared=await prepare(input),payload=decodeStudioImportPayload(prepared,new Map([['legacy-export',bytes]]));
  assert.equal(payload.formatVersion,1);if(payload.formatVersion!==1)assert.fail('Expected original generated v1');
  assertDecodedStudioImportPayload(payload);assert.equal(payload.conversion.sourceUp,'Z');assert.equal('graph'in payload,false);assert.equal('origin'in payload,false);assert.equal('conversionRequest'in payload,false);
  assert.equal('association'in payload.objects[0]!,false);assert.equal('correspondence'in payload.objects[0]!.primitives[0]!,false);
  assert.ok(payload.objects.flatMap(object=>object.primitives.flatMap(p=>[...Object.values(p.attributes),p.indices])).every(buffer=>buffer.chunks.every(chunk=>chunk.formatVersion===1)));
  const {digest:actual,...body}=payload;assert.equal(sha(payloadCanonical(body)),actual);assert.deepEqual(bytes,before);
  assert.throws(()=>assertDecodedStudioImportPayload(JSON.parse(JSON.stringify(payload))),failCode('SCHEMA'));
});

for(const collision of [false,true])for(const accepted of [true,false])test(`converted native graph budget counts the outer Model (${collision?'hull':'none'}, ${accepted?'boundary accepted':'one over refused'})`,async()=>{
  const selectedCount=(collision?126:127)+(accepted?0:1);
  const input=hostFixture(collision,'rigid',(doc:Doc)=>{
    // This fixed source fixture emits two primitive leaf nodes in addition to
    // its original nodes. Add real selected EMPTY roots to reach the boundary.
    while(doc.nodes.length<selectedCount-2){const at=doc.nodes.length;doc.nodes.push({name:'Budget EMPTY '+at});doc.scenes[0].nodes.push(at);}
  }).host();
  assert.equal(input.graph.nodes.length,selectedCount);
  const prepared=await converted(input);
  assert.equal(prepared.manifest.graph.nodes.length,selectedCount,'The full source graph is retained even when native delivery refuses.');
  if(!accepted){
    assert.throws(()=>decodeStudioImportPayload(prepared,files(input)),failCode('BUDGET'));
    assert.throws(()=>assertConvertedStudioImportRepresentable(input.graph,prepared.manifest.objects),failCode('BUDGET'));
    return;
  }
  const payload=decodeStudioImportPayload(prepared,files(input));
  if(payload.formatVersion!==2)assert.fail('Expected converted payload2');
  assert.equal(1+payload.graph.nodes.length+payload.graph.meshes.filter(mesh=>mesh.nodeKey===null).length,128);
  assert.equal(payload.objects.filter(object=>object.object.role==='collision').length,collision?1:0);
});
