import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { prepareGlbConversionSource } from '../../packages/asset-pipeline/src/glb-conversion-source.js';
import { parseConvertedGlbRequest, parseConvertedGlbSourceMap, parseConvertedGlbAudit, convertedGlbObjectId, convertedGlbAssetId,
  type ConvertedGlbRequest, type ConvertedGlbAudit } from '../../packages/asset-pipeline/src/converted-glb.js';
import { verifyGlbConversionFidelity, conversionMillionths } from '../../packages/asset-pipeline/src/glb-conversion-fidelity.js';
import { parseConvertedGlbJson } from '../../packages/asset-pipeline/src/converted-glb-manifest.js';
import { CONVERSION_FIDELITY_POLICY, CONVERSION_VERTEX_ID, CONVERSION_NODE_KEY, conversionCorrespondenceSha256 } from '../../packages/asset-pipeline/src/conversion-fidelity-policy.js';
import { AssetError } from '../../packages/asset-pipeline/src/types.js';

// Constructed actual GLB bytes and deliberately synthetic audit rows exercise
// independent host verification. No Blender execution, worker closure, human
// review, native import or successful production conversion is represented.
type Doc = Record<string, any>;
const sha=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
const JOB='11111111-1111-4111-8111-111111111111',PARENT='22222222-2222-4222-8222-222222222222';
function pack(doc:Doc,bin:Buffer):Buffer {
  doc.buffers[0].byteLength=bin.length;
  const json=Buffer.from(JSON.stringify(doc)),j=Math.ceil(json.length/4)*4,b=Math.ceil(bin.length/4)*4,out=Buffer.alloc(28+j+b);
  out.writeUInt32LE(0x46546c67);out.writeUInt32LE(2,4);out.writeUInt32LE(out.length,8);
  out.writeUInt32LE(j,12);out.writeUInt32LE(0x4e4f534a,16);out.fill(32,20,20+j);json.copy(out,20);
  out.writeUInt32LE(b,20+j);out.writeUInt32LE(0x004e4942,24+j);bin.copy(out,28+j);return out;
}
function pngChunk(kind:string,data:Buffer):Buffer {
  const chunk=Buffer.alloc(data.length+12);chunk.writeUInt32BE(data.length);chunk.write(kind,4);data.copy(chunk,8);
  let crc=0xffffffff;for(const byte of chunk.subarray(4,8+data.length)){crc^=byte;for(let bit=0;bit<8;bit++)crc=crc&1?(crc>>>1)^0xedb88320:crc>>>1;}
  chunk.writeUInt32BE((crc^0xffffffff)>>>0,8+data.length);return chunk;
}
function materialPng(rgba:readonly number[],depth:8|16=8):Buffer {
  const header=Buffer.alloc(13);header.writeUInt32BE(1);header.writeUInt32BE(1,4);header[8]=depth;header[9]=6;
  const samples=depth===8?rgba:rgba.flatMap(value=>[value,value]);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),pngChunk('IHDR',header),pngChunk('IDAT',deflateSync(Buffer.from([0,...samples]))),pngChunk('IEND',Buffer.alloc(0))]);
}
const PNG=materialPng([255,255,255,255]);
function jpeg(quantizer=1):Buffer {
  const segment=(marker:number,data:number[]):number[]=>[255,marker,(data.length+2)>>>8,(data.length+2)&255,...data],counts=[1,...Array<number>(15).fill(0)];
  return Buffer.from([255,216,...segment(0xdb,[0,...Array<number>(64).fill(quantizer)]),
    ...segment(0xc0,[8,0,1,0,1,1,1,0x11,0]),...segment(0xc4,[0,...counts,0,0x10,...counts,0]),...segment(0xda,[1,1,0,0,63,0]),0x3f,255,217]);
}
function fixture(textured=false,worldScale=1,seams=false,image=PNG,mimeType='image/png',nestedConditioning=false) {
  const doc:Doc={asset:{version:'2.0'},buffers:[{byteLength:0}],bufferViews:[],accessors:[],
    materials:[{doubleSided:true,alphaMode:'MASK',pbrMetallicRoughness:{baseColorFactor:[0.2,0.4,0.6,1],metallicFactor:0.25,roughnessFactor:0.7}},
      {pbrMetallicRoughness:{baseColorFactor:[0.8,0.6,0.2,1]}}],meshes:[],
    nodes:[{children:[1,2],translation:[2,3,4],scale:[worldScale,worldScale,worldScale]},{mesh:0,scale:[2,3,4]},{mesh:0,translation:[5,0,0]}],scene:0,scenes:[{nodes:[0]}]};
  if(nestedConditioning)doc.nodes=[{scale:[100,1,1],children:[1]},{scale:[100,1,1],children:[2]},{scale:[0.0001,1,1],mesh:0}];
  let bin:Buffer=Buffer.alloc(0);
  function accessor(values:number[],size:number,type=5126):number {
    const width=type===5123?2:4,raw=Buffer.alloc(values.length*width);
    values.forEach((v,i)=>type===5123?raw.writeUInt16LE(v,i*width):raw.writeFloatLE(v,i*width));
    const offset=Math.ceil(bin.length/4)*4,view=doc.bufferViews.length,index=doc.accessors.length;
    bin=Buffer.concat([bin,Buffer.alloc(offset-bin.length),raw]);doc.bufferViews.push({buffer:0,byteOffset:offset,byteLength:raw.length});
    const a:Doc={bufferView:view,componentType:type,count:values.length/size,type:size===1?'SCALAR':'VEC'+size};
    if(size===3){a.min=[0,1,2].map(c=>Math.min(...values.filter((_,i)=>i%3===c)));a.max=[0,1,2].map(c=>Math.max(...values.filter((_,i)=>i%3===c)));}
    doc.accessors.push(a);return index;
  }
  const vertices=seams?6:4,faces=seams?[[0,1,2],[3,4,5]]:[[0,1,2],[0,2,3]],
    position=accessor(seams?[0,0,0,2,0,0,0,1,0,2,0,0,2,1,0,0,1,0]:[0,0,0,2,0,0,2,1,0,0,1,0],3),
    normal=accessor(Array.from({length:vertices},()=>[0,0,1]).flat(),3),
    uv=accessor(seams?[0,0,1,0,0,1,.25,.5,1,1,.75,.5]:[0,0,1,0,1,1,0,1],2),
    color=accessor(Array.from({length:vertices},()=>[0.2,0.4,0.6,1]).flat(),4),indices=accessor(faces.flat(),1,5123);
  doc.meshes=[{primitives:[0,1].map(material=>({attributes:{POSITION:position,NORMAL:normal,TEXCOORD_0:uv,COLOR_0:color},indices,material}))}];
  if(textured){const at=Math.ceil(bin.length/4)*4;doc.images=[{bufferView:doc.bufferViews.length,mimeType}];
    doc.bufferViews.push({buffer:0,byteOffset:at,byteLength:image.length});bin=Buffer.concat([bin,Buffer.alloc(at-bin.length),image]);
    doc.textures=[{source:0}];doc.materials[0].pbrMetallicRoughness.baseColorTexture={index:0};}
  const source=pack(doc,bin),prepared=prepareGlbConversionSource(source,sha(source));
  const mapValue={schemaVersion:2,fidelityPolicy:CONVERSION_FIDELITY_POLICY,sourceSha256:sha(source),importSha256:prepared.importSha256,sourceSceneIndex:prepared.sourceSceneIndex,
    declaredSceneCount:prepared.declaredSceneCount,parts:prepared.parts,nodes:prepared.nodes};
  const request=parseConvertedGlbRequest({schemaVersion:2,fidelityPolicy:CONVERSION_FIDELITY_POLICY,kind:'converted-glb',jobId:JOB,parentJobId:PARENT,parentManifestSha256:sha('synthetic-parent'),
    name:'original-model',sourceSha256:sha(source),sourceBytes:source.length,importSha256:prepared.importSha256,importBytes:prepared.importBytes.length,
    sourceMapSha256:sha(JSON.stringify(mapValue)),collision:'none',renderResolution:256,renderSamples:8});
  const map=parseConvertedGlbSourceMap(mapValue,request),requestHash=sha(JSON.stringify(request)),size=prepared.importBytes.readUInt32LE(12),
    outputDoc=JSON.parse(prepared.importBytes.subarray(20,20+size).toString('utf8')) as Doc;
  let outputBin=Buffer.from(prepared.importBytes.subarray(28+size));
  outputDoc.asset.generator='Khronos glTF Blender I/O synthetic byte fixture';
  for(const part of map.parts) Object.assign(outputDoc.nodes[part.importNodeIndex].extras,{arcane_identity_scheme:'arcane-converted-v2',
    arcane_source_object_id:convertedGlbObjectId(request.sourceSha256,'render',part.sourceKey),arcane_source_key:part.sourceKey,
    arcane_role:'render',arcane_pivot:[0,0,0],arcane_collision_for:'[]'});
  const measured=map.parts.map(part=>({sourceKey:part.sourceKey,originMarker:part.originMarker,sourceObjectId:convertedGlbObjectId(request.sourceSha256,'render',part.sourceKey),
    vertices,triangles:2,boundaryEdges:seams?6:4,nonManifoldEdges:seams?6:4,looseVertices:0,looseEdges:0,degenerateFaces:0,invalidUVs:0,uvLayers:1,finitePositions:true,
    geometrySha256:sha('synthetic-measured-geometry'),correspondenceSha256:conversionCorrespondenceSha256(faces),materialSha256:sha('synthetic-measured-material')}));
  function audit(bytes:Buffer):ConvertedGlbAudit {
    return parseConvertedGlbAudit({schemaVersion:2,fidelityPolicy:CONVERSION_FIDELITY_POLICY,kind:'arcane-glb-conversion-audit',jobId:JOB,parentJobId:PARENT,parentManifestSha256:request.parentManifestSha256,
      requestSha256:requestHash,sourceSha256:request.sourceSha256,importSha256:request.importSha256,sourceMapSha256:request.sourceMapSha256,
      identityScheme:'arcane-converted-v2',assetId:convertedGlbAssetId(request.sourceSha256),blenderVersion:'synthetic metadata only',collision:'none',
      importedParts:measured,reopenedParts:structuredClone(measured),models:[{path:'asset.glb',sha256:sha(bytes),byteLength:bytes.length,generator:outputDoc.asset.generator,
        objects:map.parts.map(part=>({sourceObjectId:convertedGlbObjectId(request.sourceSha256,'render',part.sourceKey),sourceKey:part.sourceKey,
          nodeIndex:part.importNodeIndex,role:'render',pivot:[0,0,0],collisionFor:[],originMarker:part.originMarker})),anchors:[]}],
      renders:['preview-hero.png','preview-side.png'].map(path=>({path,width:256,height:256,finitePixels:true,minLuminance:0,maxLuminance:1,meanLuminance:0.4,standardDeviation:0.1})),
      savedSceneReopened:true,errors:[],warnings:['open-render-surfaces','no-collision-proxy','delivery-support-pending']},request,map,requestHash);
  }
  const output=()=>pack(outputDoc,outputBin);
  const verify=()=>{const bytes=output();return verifyGlbConversionFidelity(source,bytes,request,map,audit(bytes),requestHash);};
  function replaceImage(bytes:Buffer){const at=Math.ceil(outputBin.length/4)*4;outputDoc.images[0].bufferView=outputDoc.bufferViews.length;
    outputDoc.bufferViews.push({buffer:0,byteOffset:at,byteLength:bytes.length});outputBin=Buffer.concat([outputBin,Buffer.alloc(at-outputBin.length),bytes]);}
  return {source,request,map,requestHash,outputDoc,get outputBin(){return outputBin;},output,audit,verify,position,normal,uv,color,indices,replaceImage};
}
const schemaError=(e:unknown)=>e instanceof AssetError&&e.code==='ASSET_CONVERSION_SCHEMA';
const fidelityError=(e:unknown)=>e instanceof AssetError&&e.code==='ASSET_CONVERSION_FIDELITY';

test('conversion contracts copy/freeze exact derived lineage without granting native or review authority',()=>{
  const f=fixture(),rows=f.verify();assert.equal(rows.length,4);assert.equal(new Set(rows.map(row=>row.sourceKey)).size,4);
  assert.ok(Object.isFrozen(f.request)&&Object.isFrozen(f.map.parts[0]!.worldMatrix)&&Object.isFrozen(rows));
  assert.ok(Object.isFrozen(f.map.nodes)&&Object.isFrozen(f.map.nodes[0]!.localMatrix));
  assert.equal(f.request.schemaVersion,2);assert.equal(f.request.fidelityPolicy,CONVERSION_FIDELITY_POLICY);
  assert.equal(f.audit(f.output()).importedParts[0]!.correspondenceSha256,conversionCorrespondenceSha256([[0,1,2],[0,2,3]]));
  assert.notEqual(f.audit(f.output()).importedParts[0]!.geometrySha256,f.audit(f.output()).importedParts[0]!.correspondenceSha256);
  assert.equal('engineVerification' in f.audit(f.output()),false);assert.equal('approved' in f.request,false);
  assert.notEqual(f.request.jobId,f.request.parentJobId);
});
test('conversion precision is explicit half away from zero, including negative ties and zero',()=>{
  assert.equal(conversionMillionths(0.0000005),1);assert.equal(conversionMillionths(-0.0000005),-1);
  assert.equal(Object.is(conversionMillionths(-0),-0),false);assert.throws(()=>conversionMillionths(Infinity),fidelityError);
});
test('conversion source-map parsing canonicalizes typed and raw JSON signed zeros without rounding nonzero matrices',()=>{
  const f=fixture(),tiny=2**-80,value=structuredClone(f.map);
  value.sourceSceneIndex=-0;value.nodes[0]!.importNodeIndex=-0;
  value.nodes[0]!.localMatrix[1]=-0;value.nodes[0]!.localMatrix[2]=-0;
  value.nodes[0]!.localMatrix[12]=tiny;value.nodes[0]!.localMatrix[13]=-tiny;
  value.parts[0]!.sourceMeshIndex=-0;value.parts[0]!.sourcePrimitiveIndex=-0;value.parts[0]!.sourceMaterialIndex=-0;
  value.parts[0]!.worldMatrix[2]=-0;value.parts[0]!.worldMatrix[12]=tiny;value.parts[0]!.worldMatrix[13]=-tiny;
  const parsed=parseConvertedGlbSourceMap(value,f.request);
  assert.ok(!Object.is(parsed.sourceSceneIndex,-0)&&!Object.is(parsed.nodes[0]!.importNodeIndex,-0));
  for(const index of [parsed.parts[0]!.sourceMeshIndex,parsed.parts[0]!.sourcePrimitiveIndex,parsed.parts[0]!.sourceMaterialIndex])
    assert.equal(Object.is(index,-0),false);
  for(const matrix of [...parsed.parts.map(part=>part.worldMatrix),...parsed.nodes.map(node=>node.localMatrix)]){
    assert.ok(Object.isFrozen(matrix));assert.ok(matrix.every(number=>!Object.is(number,-0)));
  }
  for(const matrix of [parsed.nodes[0]!.localMatrix,parsed.parts[0]!.worldMatrix]){
    assert.equal(matrix[12],tiny);assert.equal(matrix[13],-tiny);
  }
  assert.ok(Object.is(value.nodes[0]!.localMatrix[1],-0),'Parsing does not mutate typed input.');
  assert.deepEqual(parseConvertedGlbSourceMap(JSON.parse(JSON.stringify(parsed)),f.request),parsed);
  const raw=JSON.stringify(value).replace('"sourceSceneIndex":0','"sourceSceneIndex":-0')
    .replace('"sourceMeshIndex":0','"sourceMeshIndex":-0.0').replace('"localMatrix":[1,0,0,0','"localMatrix":[1,-0.0,-0,0');
  const rawValue=JSON.parse(raw) as Doc;
  assert.ok(Object.is(rawValue.sourceSceneIndex,-0)&&Object.is(rawValue.parts[0].sourceMeshIndex,-0));
  assert.ok(Object.is(rawValue.nodes[0].localMatrix[1],-0)&&Object.is(rawValue.nodes[0].localMatrix[2],-0));
  assert.deepEqual(parseConvertedGlbSourceMap(rawValue,f.request),parsed);
  const bytes=Buffer.from(raw),before=Buffer.from(bytes),hash=sha(bytes);
  assert.deepEqual(parseConvertedGlbSourceMap(parseConvertedGlbJson(bytes),f.request),parsed);
  assert.deepEqual(bytes,before);assert.equal(sha(bytes),hash,'Retained raw JSON bytes are not normalized in place.');
});
test('conversion audit parsing survives Python-style -0.0 and host JSON serialization without weakening finite bounds',()=>{
  const f=fixture(),tiny=2**-80,value=structuredClone(f.audit(f.output()));
  value.importedParts[0]!.looseVertices=-0;value.reopenedParts[0]!.looseVertices=-0;
  value.models[0]!.objects[0]!.pivot=[-0,-0,-0];
  value.renders[0]!.minLuminance=-0;value.renders[0]!.meanLuminance=tiny;
  const parse=(input:unknown)=>parseConvertedGlbAudit(input,f.request,f.map,f.requestHash),parsed=parse(value);
  assert.equal(Object.is(parsed.importedParts[0]!.looseVertices,-0),false);
  assert.equal(Object.is(parsed.reopenedParts[0]!.looseVertices,-0),false);
  assert.ok(parsed.models[0]!.objects[0]!.pivot.every(number=>Object.is(number,0)));
  assert.equal(Object.is(parsed.renders[0]!.minLuminance,-0),false);assert.equal(parsed.renders[0]!.meanLuminance,tiny);
  assert.ok(Object.isFrozen(parsed.models[0]!.objects[0]!.pivot));
  assert.deepEqual(parse(JSON.parse(JSON.stringify(parsed))),parsed);
  const raw=JSON.stringify(value).replace('"looseVertices":0','"looseVertices":-0')
    .replace('"pivot":[0,0,0]','"pivot":[-0.0,-0,0]').replace('"minLuminance":0','"minLuminance":-0.0');
  const rawValue=JSON.parse(raw) as Doc;
  assert.ok(Object.is(rawValue.importedParts[0].looseVertices,-0)&&Object.is(rawValue.renders[0].minLuminance,-0));
  assert.ok(Object.is(rawValue.models[0].objects[0].pivot[0],-0));assert.deepEqual(parse(rawValue),parsed);
  const bytes=Buffer.from(raw),before=Buffer.from(bytes),hash=sha(bytes),retained=parse(parseConvertedGlbJson(bytes));
  assert.deepEqual(retained,parsed);assert.deepEqual(parse(JSON.parse(JSON.stringify(retained))),parsed);
  assert.deepEqual(bytes,before);assert.equal(sha(bytes),hash);
  const negative=structuredClone(value);negative.renders[0]!.minLuminance=-tiny;
  assert.throws(()=>parse(negative),schemaError,'A tiny negative luminance stays invalid rather than becoming zero.');
});
test('conversion JSON refuses getters, proxies, unknown fields and same parent ID without invoking code',()=>{
  const f=fixture();let calls=0;
  const getter=Object.defineProperty({...f.request},'name',{enumerable:true,get(){calls++;return 'unsafe';}});
  assert.throws(()=>parseConvertedGlbRequest(getter),schemaError);
  const proxy=new Proxy({}, {ownKeys(){calls++;throw Error('must not execute');}});
  assert.throws(()=>parseConvertedGlbRequest(proxy),schemaError);assert.equal(calls,0);
  assert.throws(()=>parseConvertedGlbRequest({...f.request,worker:'custom.py'}),schemaError);
  assert.throws(()=>parseConvertedGlbRequest({...f.request,parentJobId:JOB}),schemaError);
  assert.throws(()=>parseConvertedGlbRequest({...f.request,extra:Array.from({length:1000},()=> '\u0000'.repeat(1024))}),schemaError);
});

test('conversion v2 refuses legacy contracts, caller-selected precision and old producer identities',()=>{
  const f=fixture(),audit=f.audit(f.output());
  for(const change of [{schemaVersion:1},{fidelityPolicy:'caller-selected-policy'},{positionTolerance:1}]) {
    assert.throws(()=>parseConvertedGlbRequest({...f.request,...change}),schemaError);
    assert.throws(()=>parseConvertedGlbSourceMap({...f.map,...change},f.request),schemaError);
    assert.throws(()=>parseConvertedGlbAudit({...audit,...change},f.request,f.map,f.requestHash),schemaError);
  }
  assert.throws(()=>parseConvertedGlbAudit({...audit,identityScheme:'arcane-converted-v1'},f.request,f.map,f.requestHash),schemaError);
});
test('collision reservation and source-map uniqueness are checked before any worker can start',()=>{
  const f=fixture(),map=structuredClone(f.map);
  map.parts[1]!.originMarker=map.parts[0]!.originMarker;assert.throws(()=>parseConvertedGlbSourceMap(map,f.request),schemaError);
  const request={...f.request,collision:'convex-hull'} as ConvertedGlbRequest;
  const many=Array.from({length:128},(_,i)=>({...f.map.parts[0]!,sourceNodeIndex:i,sourceKey:`node${i}_primitive0`,importNodeIndex:128+i,originMarker:`glb_${f.request.sourceSha256}:${i}:0`}));
  const localMatrix=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],nodes=many.flatMap((part,i)=>[
    {nodeKey:`node${i}`,importNodeIndex:i,parentKey:null,localMatrix},
    {nodeKey:part.sourceKey,importNodeIndex:part.importNodeIndex,parentKey:`node${i}`,localMatrix}]);
  assert.throws(()=>parseConvertedGlbSourceMap({...f.map,parts:many,nodes},request),schemaError);
  assert.equal(parseConvertedGlbSourceMap({...f.map,parts:many,nodes},f.request).parts.length,128);
});
for(const field of ['requestSha256','sourceSha256','importSha256','sourceMapSha256','parentManifestSha256'] as const)
  test('conversion audit cannot relabel '+field,()=>{const f=fixture(),a=structuredClone(f.audit(f.output()));a[field]=sha('changed');assert.throws(()=>parseConvertedGlbAudit(a,f.request,f.map,f.requestHash),schemaError);});
test('reopened geometry, missing parts, invented node mappings and empty renders cannot be accepted as measured statements',()=>{
  const f=fixture();for(const change of [
    (a:Doc)=>a.reopenedParts[0].geometrySha256=sha('changed'),(a:Doc)=>a.reopenedParts[0].correspondenceSha256=sha('changed'),(a:Doc)=>a.importedParts.pop(),
    (a:Doc)=>a.models[0].objects[1].nodeIndex=a.models[0].objects[0].nodeIndex,(a:Doc)=>a.renders[0].maxLuminance=0,
  ]){const a=structuredClone(f.audit(f.output()));change(a);assert.throws(()=>parseConvertedGlbAudit(a,f.request,f.map,f.requestHash),schemaError);}
});

test('conversion source-map hierarchy requires unique, complete acyclic parent correspondence',()=>{
  const f=fixture();for(const change of [
    (map:Doc)=>map.nodes[1].nodeKey=map.nodes[0].nodeKey,
    (map:Doc)=>map.nodes[1].importNodeIndex=map.nodes[0].importNodeIndex,
    (map:Doc)=>map.nodes[1].parentKey='node9999',
    (map:Doc)=>map.nodes[0].parentKey=map.nodes[1].nodeKey,
    (map:Doc)=>map.nodes.find((node:Doc)=>node.nodeKey===map.parts[0].sourceKey).parentKey='node2',
  ]) { const map=structuredClone(f.map);change(map);assert.throws(()=>parseConvertedGlbSourceMap(map,f.request),schemaError); }
});
test('independent GLB fidelity ignores forged matching worker hashes and detects actual UV and color loss',()=>{
  for(const semantic of ['TEXCOORD_0','COLOR_0']) {
    const f=fixture();for(const mesh of f.outputDoc.meshes)delete mesh.primitives[0].attributes[semantic];
    assert.throws(f.verify,fidelityError);
  }
});
test('independent GLB fidelity rejects actual changed material factors and node placement with fully resealed output claims',()=>{
  const material=fixture();material.outputDoc.materials[0].pbrMetallicRoughness.baseColorFactor[0]=0.9;assert.throws(material.verify,fidelityError);
  const placement=fixture();placement.outputDoc.nodes[0].translation[0]+=1;assert.throws(placement.verify,fidelityError);
});
test('independent GLB fidelity checks real positions and the original world-matrix lineage',()=>{
  const f=fixture(),a=f.outputDoc.accessors[f.position],view=f.outputDoc.bufferViews[a.bufferView];
  f.outputBin.writeFloatLE(3,(view.byteOffset??0)+2*3*4);a.max[0]=3;assert.throws(f.verify,fidelityError);
  const original=fixture(),changed=structuredClone(original.map);changed.parts[0]!.worldMatrix[12]=changed.parts[0]!.worldMatrix[12]!+1;
  const bytes=original.output();assert.throws(()=>verifyGlbConversionFidelity(original.source,bytes,original.request,changed,original.audit(bytes),original.requestHash),fidelityError);
});
test('independent GLB fidelity rejects reparenting or moving local transforms even when world geometry remains unchanged',()=>{
  const f=fixture();f.outputDoc.nodes[0].translation=[0,0,0];f.outputDoc.nodes[1].translation=[2,3,4];f.outputDoc.nodes[2].translation=[7,3,4];
  assert.throws(f.verify,fidelityError);
});

test('independent GLB fidelity retains empty nodes and refuses duplicate or forged hierarchy keys',()=>{
  for(const change of [
    (doc:Doc)=>delete doc.nodes[0].extras[CONVERSION_NODE_KEY],
    (doc:Doc)=>doc.nodes[1].extras[CONVERSION_NODE_KEY]=doc.nodes[0].extras[CONVERSION_NODE_KEY],
    (doc:Doc)=>{doc.nodes.push({extras:{[CONVERSION_NODE_KEY]:'node9999'}});doc.nodes[0].children.push(doc.nodes.length-1);},
  ]) { const f=fixture();change(f.outputDoc);assert.throws(f.verify,fidelityError); }
});

test('independent GLB fidelity accepts bounded component roundoff and refuses changes beyond the fixed policy',()=>{
  for(const [semantic,accepted,refused] of [['POSITION',1e-5,2e-4],['NORMAL',1e-5,.001],['TEXCOORD_0',2**-21,2**-19],['COLOR_0',1/131070,2/65535]] as const) {
    for(const [delta,allowed] of [[accepted,true],[refused,false]] as const) {
      const f=fixture(),primitive=f.outputDoc.meshes[0].primitives[0],a=f.outputDoc.accessors[primitive.attributes[semantic]],view=f.outputDoc.bufferViews[a.bufferView],at=(view.byteOffset??0)+(a.byteOffset??0);
      f.outputBin.writeFloatLE(f.outputBin.readFloatLE(at)+delta,at);if(semantic==='NORMAL')a.max[0]=f.outputBin.readFloatLE(at);
      if(allowed)assert.equal(f.verify().length,4);else assert.throws(f.verify,fidelityError);
    }
  }
});

test('independent GLB fidelity requires exact finite integer vertex IDs and retained correspondence topology',()=>{
  for(const change of ['missing','nonfinite','fractional','foreign','duplicate','normalized','wrong-type'] as const) {
    const f=fixture(),primitive=f.outputDoc.meshes[0].primitives[0],index=primitive.attributes[CONVERSION_VERTEX_ID],a=f.outputDoc.accessors[index],view=f.outputDoc.bufferViews[a.bufferView];
    if(change==='missing')delete primitive.attributes[CONVERSION_VERTEX_ID];
    else if(change==='normalized')a.normalized=true;
    else if(change==='wrong-type')a.componentType=5125;
    else f.outputBin.writeFloatLE(change==='nonfinite'?NaN:change==='fractional'?.5:change==='foreign'?4:1,view.byteOffset??0);
    assert.throws(f.verify,fidelityError);
  }
  const f=fixture(),bytes=f.output(),audit=structuredClone(f.audit(bytes));
  for(const row of [...audit.importedParts,...audit.reopenedParts])row.correspondenceSha256=sha('forged matching topology claim');
  assert.throws(()=>verifyGlbConversionFidelity(f.source,bytes,f.request,f.map,audit,f.requestHash),fidelityError);
});

test('independent GLB fidelity binds coincident seam vertices to their own UVs rather than nearby positions',()=>{
  const f=fixture(false,1,true);assert.equal(f.verify().length,4);
  // Swapping coincident vertices and the corresponding face corners preserves
  // positions and exact oriented ID faces, but assigns the wrong seam UVs.
  for(const mesh of f.outputDoc.meshes) {
    const ids=f.outputDoc.accessors[mesh.primitives[0].attributes[CONVERSION_VERTEX_ID]],view=f.outputDoc.bufferViews[ids.bufferView];
    f.outputBin.writeFloatLE(3,(view.byteOffset??0)+4);f.outputBin.writeFloatLE(1,(view.byteOffset??0)+12);
  }
  const indices=f.outputDoc.accessors[f.indices],indexView=f.outputDoc.bufferViews[indices.bufferView];
  f.outputBin.writeUInt16LE(3,(indexView.byteOffset??0)+2);f.outputBin.writeUInt16LE(1,(indexView.byteOffset??0)+6);
  assert.throws(f.verify,fidelityError);
  const uv=f.outputDoc.accessors[f.uv],uvView=f.outputDoc.bufferViews[uv.bufferView],at=uvView.byteOffset??0,
    first=[f.outputBin.readFloatLE(at+8),f.outputBin.readFloatLE(at+12)],second=[f.outputBin.readFloatLE(at+24),f.outputBin.readFloatLE(at+28)];
  second.forEach((value,index)=>f.outputBin.writeFloatLE(value,at+8+index*4));first.forEach((value,index)=>f.outputBin.writeFloatLE(value,at+24+index*4));
  assert.equal(f.verify().length,4,'Reordering the seam UVs with their IDs restores the exact original association.');
});
test('independent GLB fidelity rejects reversed winding but accepts a cyclic corner rotation',()=>{
  for(const [indices,accepted] of [[[1,2,0,2,3,0],true],[[0,2,1,0,3,2],false]] as const){
    const f=fixture(),a=f.outputDoc.accessors[f.indices],v=f.outputDoc.bufferViews[a.bufferView];
    indices.forEach((value,i)=>f.outputBin.writeUInt16LE(value,(v.byteOffset??0)+i*2));
    if(accepted)assert.equal(f.verify().length,4);else assert.throws(f.verify,fidelityError);
  }
});
test('independent GLB fidelity rejects changed original bytes and forged export identities',()=>{
  const f=fixture(),changed=Buffer.from(f.source);changed[changed.length-1]=changed[changed.length-1]!^1;
  const bytes=f.output();assert.throws(()=>verifyGlbConversionFidelity(changed,bytes,f.request,f.map,f.audit(bytes),f.requestHash),fidelityError);
  f.outputDoc.nodes[f.map.parts[0]!.importNodeIndex].extras.arcane_source_object_id=convertedGlbObjectId(f.request.sourceSha256,'collision','proxy');
  assert.throws(f.verify,fidelityError);
});
test('conversion fidelity enforces actual retained source length and explicit world-meter face area',()=>{
  const f=fixture(),bytes=f.output();
  assert.throws(()=>verifyGlbConversionFidelity(f.source,bytes,{...f.request,sourceBytes:f.request.sourceBytes+1},f.map,f.audit(bytes),f.requestHash),fidelityError);
  assert.throws(fixture(false,0.000001).verify,fidelityError);
  assert.equal(fixture(false,0.0001).verify().length,4);
});
test('independent GLB fidelity preserves embedded image bytes, bindings and explicit sampler semantics',()=>{
  const same=fixture(true);assert.equal(same.verify().length,4);
  const binding=fixture(true);delete binding.outputDoc.materials[0].pbrMetallicRoughness.baseColorTexture;assert.throws(binding.verify,fidelityError);
  const sampler=fixture(true);sampler.outputDoc.samplers=[{wrapS:33071}];sampler.outputDoc.textures[0].sampler=0;assert.throws(sampler.verify,fidelityError);
});
test('independent GLB fidelity accepts different supported PNG encoding only when decoded dimensions and RGBA pixels match',()=>{
  const f=fixture(true),data=Buffer.from('description\0different encoding'),chunk=Buffer.alloc(data.length+12);
  chunk.writeUInt32BE(data.length);chunk.write('tEXt',4);data.copy(chunk,8);
  let crc=0xffffffff;for(const byte of chunk.subarray(4,8+data.length)){crc^=byte;for(let bit=0;bit<8;bit++)crc=crc&1?(crc>>>1)^0xedb88320:crc>>>1;}
  chunk.writeUInt32BE((crc^0xffffffff)>>>0,8+data.length);
  f.replaceImage(Buffer.concat([PNG.subarray(0,-12),chunk,PNG.subarray(-12)]));assert.equal(f.verify().length,4);
  const changed=fixture(true);changed.replaceImage(materialPng([254,255,255,255]));assert.throws(changed.verify,fidelityError);
  const alpha=fixture(true);alpha.replaceImage(materialPng([255,255,255,254]));assert.throws(alpha.verify,fidelityError);
});

test('independent GLB fidelity keeps JPEG and unsupported PNG encodings exact without a pixel decoder',()=>{
  const jpegSource=fixture(true,1,false,jpeg(),'image/jpeg');assert.equal(jpegSource.verify().length,4);
  jpegSource.replaceImage(jpeg(2));assert.throws(jpegSource.verify,fidelityError);
  const image=materialPng([255,255,255,255],16),unsupported=fixture(true,1,false,image);assert.equal(unsupported.verify().length,4);
  unsupported.replaceImage(Buffer.concat([image.subarray(0,-12),pngChunk('tEXt',Buffer.from('description\0same unsupported pixels')),image.subarray(-12)]));
  assert.throws(unsupported.verify,fidelityError);
});

test('independent GLB fidelity checks world conditioning on empty ancestors even when mesh world transforms pass',()=>{
  const f=fixture(false,1,false,PNG,'image/png',true);
  assert.equal(f.verify().length,2);
  // Every local matrix remains within its bound, and the mesh transform stays
  // near identity. The intermediate empty node nevertheless crosses condition
  // number 10,000 and must be rejected by the independent file validator.
  f.outputDoc.nodes[1].scale[0]+=0.00005;
  assert.throws(f.verify,fidelityError);
});
