import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { prepareGlbConversionSource } from '../../packages/asset-pipeline/src/glb-conversion-source.js';
import { parseConvertedGlbRequest, parseConvertedGlbSourceMap, parseConvertedGlbAudit, convertedGlbObjectId, convertedGlbAssetId,
  type ConvertedGlbRequest, type ConvertedGlbAudit } from '../../packages/asset-pipeline/src/converted-glb.js';
import { verifyGlbConversionFidelity, conversionMillionths } from '../../packages/asset-pipeline/src/glb-conversion-fidelity.js';
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
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=','base64');
function fixture(textured=false,worldScale=1) {
  const doc:Doc={asset:{version:'2.0'},buffers:[{byteLength:0}],bufferViews:[],accessors:[],
    materials:[{doubleSided:true,alphaMode:'MASK',pbrMetallicRoughness:{baseColorFactor:[0.2,0.4,0.6,1],metallicFactor:0.25,roughnessFactor:0.7}},
      {pbrMetallicRoughness:{baseColorFactor:[0.8,0.6,0.2,1]}}],meshes:[],
    nodes:[{children:[1,2],translation:[2,3,4],scale:[worldScale,worldScale,worldScale]},{mesh:0,scale:[2,3,4]},{mesh:0,translation:[5,0,0]}],scene:0,scenes:[{nodes:[0]}]};
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
  const position=accessor([0,0,0,2,0,0,2,1,0,0,1,0],3),normal=accessor([0,0,1,0,0,1,0,0,1,0,0,1],3),
    uv=accessor([0,0,1,0,1,1,0,1],2),color=accessor([0.2,0.4,0.6,1,0.2,0.4,0.6,1,0.2,0.4,0.6,1,0.2,0.4,0.6,1],4),indices=accessor([0,1,2,0,2,3],1,5123);
  doc.meshes=[{primitives:[0,1].map(material=>({attributes:{POSITION:position,NORMAL:normal,TEXCOORD_0:uv,COLOR_0:color},indices,material}))}];
  if(textured){const at=Math.ceil(bin.length/4)*4;doc.images=[{bufferView:doc.bufferViews.length,mimeType:'image/png'}];
    doc.bufferViews.push({buffer:0,byteOffset:at,byteLength:PNG.length});bin=Buffer.concat([bin,Buffer.alloc(at-bin.length),PNG]);
    doc.textures=[{source:0}];doc.materials[0].pbrMetallicRoughness.baseColorTexture={index:0};}
  const source=pack(doc,bin),prepared=prepareGlbConversionSource(source,sha(source));
  const mapValue={schemaVersion:1,sourceSha256:sha(source),importSha256:prepared.importSha256,sourceSceneIndex:prepared.sourceSceneIndex,
    declaredSceneCount:prepared.declaredSceneCount,parts:prepared.parts};
  const request=parseConvertedGlbRequest({schemaVersion:1,kind:'converted-glb',jobId:JOB,parentJobId:PARENT,parentManifestSha256:sha('synthetic-parent'),
    name:'original-model',sourceSha256:sha(source),sourceBytes:source.length,importSha256:prepared.importSha256,importBytes:prepared.importBytes.length,
    sourceMapSha256:sha(JSON.stringify(mapValue)),collision:'none',renderResolution:256,renderSamples:8});
  const map=parseConvertedGlbSourceMap(mapValue,request),requestHash=sha(JSON.stringify(request)),size=prepared.importBytes.readUInt32LE(12),
    outputDoc=JSON.parse(prepared.importBytes.subarray(20,20+size).toString('utf8')) as Doc;
  let outputBin=Buffer.from(prepared.importBytes.subarray(28+size));
  outputDoc.asset.generator='Khronos glTF Blender I/O synthetic byte fixture';
  for(const part of map.parts) Object.assign(outputDoc.nodes[part.importNodeIndex].extras,{arcane_identity_scheme:'arcane-converted-v1',
    arcane_source_object_id:convertedGlbObjectId(request.sourceSha256,'render',part.sourceKey),arcane_source_key:part.sourceKey,
    arcane_role:'render',arcane_pivot:[0,0,0],arcane_collision_for:'[]'});
  const measured=map.parts.map(part=>({sourceKey:part.sourceKey,originMarker:part.originMarker,sourceObjectId:convertedGlbObjectId(request.sourceSha256,'render',part.sourceKey),
    vertices:4,triangles:2,boundaryEdges:4,nonManifoldEdges:4,looseVertices:0,looseEdges:0,degenerateFaces:0,invalidUVs:0,uvLayers:1,finitePositions:true,
    geometrySha256:sha('synthetic-measured-geometry'),materialSha256:sha('synthetic-measured-material')}));
  function audit(bytes:Buffer):ConvertedGlbAudit {
    return parseConvertedGlbAudit({schemaVersion:1,kind:'arcane-glb-conversion-audit',jobId:JOB,parentJobId:PARENT,parentManifestSha256:request.parentManifestSha256,
      requestSha256:requestHash,sourceSha256:request.sourceSha256,importSha256:request.importSha256,sourceMapSha256:request.sourceMapSha256,
      identityScheme:'arcane-converted-v1',assetId:convertedGlbAssetId(request.sourceSha256),blenderVersion:'synthetic metadata only',collision:'none',
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
  return {source,request,map,requestHash,outputDoc,get outputBin(){return outputBin;},output,audit,verify,position,uv,color,indices,replaceImage};
}
const schemaError=(e:unknown)=>e instanceof AssetError&&e.code==='ASSET_CONVERSION_SCHEMA';
const fidelityError=(e:unknown)=>e instanceof AssetError&&e.code==='ASSET_CONVERSION_FIDELITY';

test('conversion contracts copy/freeze exact derived lineage without granting native or review authority',()=>{
  const f=fixture(),rows=f.verify();assert.equal(rows.length,4);assert.equal(new Set(rows.map(row=>row.sourceKey)).size,4);
  assert.ok(Object.isFrozen(f.request)&&Object.isFrozen(f.map.parts[0]!.worldMatrix)&&Object.isFrozen(rows));
  assert.equal('engineVerification' in f.audit(f.output()),false);assert.equal('approved' in f.request,false);
  assert.notEqual(f.request.jobId,f.request.parentJobId);
});
test('conversion precision is explicit half away from zero, including negative ties and zero',()=>{
  assert.equal(conversionMillionths(0.0000005),1);assert.equal(conversionMillionths(-0.0000005),-1);
  assert.equal(Object.is(conversionMillionths(-0),-0),false);assert.throws(()=>conversionMillionths(Infinity),fidelityError);
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
test('collision reservation and source-map uniqueness are checked before any worker can start',()=>{
  const f=fixture(),map=structuredClone(f.map);
  map.parts[1]!.originMarker=map.parts[0]!.originMarker;assert.throws(()=>parseConvertedGlbSourceMap(map,f.request),schemaError);
  const request={...f.request,collision:'convex-hull'} as ConvertedGlbRequest;
  const many=Array.from({length:128},(_,i)=>({...f.map.parts[0]!,sourceNodeIndex:i,sourceKey:`node${i}_primitive0`,importNodeIndex:i,originMarker:`glb_${f.request.sourceSha256}:${i}:0`}));
  assert.throws(()=>parseConvertedGlbSourceMap({...f.map,parts:many},request),schemaError);
  assert.equal(parseConvertedGlbSourceMap({...f.map,parts:many},f.request).parts.length,128);
});
for(const field of ['requestSha256','sourceSha256','importSha256','sourceMapSha256','parentManifestSha256'] as const)
  test('conversion audit cannot relabel '+field,()=>{const f=fixture(),a=structuredClone(f.audit(f.output()));a[field]=sha('changed');assert.throws(()=>parseConvertedGlbAudit(a,f.request,f.map,f.requestHash),schemaError);});
test('reopened geometry, missing parts, invented node mappings and empty renders cannot be accepted as measured statements',()=>{
  const f=fixture();for(const change of [
    (a:Doc)=>a.reopenedParts[0].geometrySha256=sha('changed'),(a:Doc)=>a.importedParts.pop(),
    (a:Doc)=>a.models[0].objects[1].nodeIndex=a.models[0].objects[0].nodeIndex,(a:Doc)=>a.renders[0].maxLuminance=0,
  ]){const a=structuredClone(f.audit(f.output()));change(a);assert.throws(()=>parseConvertedGlbAudit(a,f.request,f.map,f.requestHash),schemaError);}
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
test('different valid PNG encoding needs independent pixel preservation evidence, not a worker hash assertion',()=>{
  const f=fixture(true),data=Buffer.from('description\0different encoding'),chunk=Buffer.alloc(data.length+12);
  chunk.writeUInt32BE(data.length);chunk.write('tEXt',4);data.copy(chunk,8);
  let crc=0xffffffff;for(const byte of chunk.subarray(4,8+data.length)){crc^=byte;for(let bit=0;bit<8;bit++)crc=crc&1?(crc>>>1)^0xedb88320:crc>>>1;}
  chunk.writeUInt32BE((crc^0xffffffff)>>>0,8+data.length);
  f.replaceImage(Buffer.concat([PNG.subarray(0,-12),chunk,PNG.subarray(-12)]));assert.throws(f.verify,fidelityError);
});
