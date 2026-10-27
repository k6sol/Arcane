import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {buildConvertedGraph,parseConvertedGraph,convertedGraphDigest,STUDIO_IMPORT_GRAPH_LIMITS,type ConvertedGraphSourceBytes} from '../../packages/asset-pipeline/src/studio-import-graph.js';
import {prepareGlbConversionSource} from '../../packages/asset-pipeline/src/glb-conversion-source.js';
import {convertedGlbObjectId,convertedGlbAssetId} from '../../packages/asset-pipeline/src/converted-glb.js';
import {CONVERSION_FIDELITY_POLICY,CONVERSION_NODE_KEY,CONVERSION_VERTEX_ID,conversionCorrespondenceSha256} from '../../packages/asset-pipeline/src/conversion-fidelity-policy.js';
import {AssetError} from '../../packages/asset-pipeline/src/types.js';

// Real constructed buffers and explicitly synthetic audit measurements only.
// No worker/runtime, process closure, human approval or native target is proved.
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
const graphError=(error:unknown)=>error instanceof AssetError&&error.code==='STUDIO_IMPORT_GRAPH';
const anyRefusal=(error:unknown)=>error instanceof AssetError;
function reseal(value:Doc):Doc {const {digest:_digest,...body}=value;return{...body,digest:convertedGraphDigest(body)};}

test('actual buffers preserve the complete selected graph, names, direct parents and asymmetric source-origin pivots despite reordered export indexes',()=>{
  const f=fixture(),bytes=f.bytes(),before=Object.fromEntries(Object.entries(bytes).map(([k,v])=>[k,sha(v)])),g=buildConvertedGraph(bytes);
  assert.equal(g.nodes.length,7);assert.equal(g.meshes.length,2);assert.equal(g.nodes.filter(n=>n.parentKey===null).length,2);
  assert.equal(g.nodes.find(n=>n.nodeKey==='node1')?.name,'Empty ancestor');assert.equal(g.nodes.find(n=>n.nodeKey==='node3')?.name,'Empty leaf');
  assert.equal(g.nodes.find(n=>n.nodeKey==='node2_primitive0')?.parentKey,'node2');assert.equal(g.nodes.find(n=>n.nodeKey==='node2')?.parentKey,'node1');
  assert.equal(g.nodes.find(n=>n.nodeKey==='node3')!.localMatrix[13],2**-80);
  assert.ok(f.prepared.parts.some(p=>f.output.nodes.indexOf(f.byKey(p.sourceKey))!==p.importNodeIndex));
  for(const m of g.meshes){assert.deepEqual(m.sourcePivot,[0,0,0]);assert.equal(m.correspondenceSha256,conversionCorrespondenceSha256([[0,1,2],[0,2,3]]));}
  assert.ok(Object.isFrozen(g)&&Object.isFrozen(g.nodes)&&Object.isFrozen(g.nodes[0]!.localMatrix)&&Object.isFrozen(g.meshes[0]!.sourcePivot));
  assert.deepEqual(parseConvertedGraph(JSON.parse(JSON.stringify(g))),g);assert.equal('engineVerification'in g,false);assert.equal('approved'in g,false);
  assert.deepEqual(Object.fromEntries(Object.entries(bytes).map(([k,v])=>[k,sha(v)])),before);
});

for(const affine of ['scale','shear','reflection'] as const)test('graph construction retains the full converter '+affine+' data domain without claiming target representability',()=>{
  const f=fixture(false,affine),g=buildConvertedGraph(f.bytes()),local=g.nodes.find(n=>n.nodeKey==='node1')!.localMatrix;
  assert.deepEqual(local,f.byKey('node1').matrix);assert.equal('nativeSupported'in g,false);
});

test('graph digest is deterministic under metadata ordering, normalizes only signed zero and retains every tiny nonzero',()=>{
  const f=fixture(),g=buildConvertedGraph(f.bytes()),value=structuredClone(g) as unknown as Doc;
  value.nodes.reverse();value.meshes.reverse();value.nodes[0].localMatrix[3]=-0;
  assert.deepEqual(parseConvertedGraph(value),g);
  const node=value.nodes.find((n:Doc)=>n.nodeKey==='node3');node.localMatrix[12]=2**-90;node.localMatrix[14]=-(2**-90);
  const next=parseConvertedGraph(reseal(value));assert.notEqual(next.digest,g.digest);assert.equal(next.nodes.find(n=>n.nodeKey==='node3')!.localMatrix[12],2**-90);
  assert.equal(next.nodes.find(n=>n.nodeKey==='node3')!.localMatrix[14],-(2**-90));assert.ok(next.nodes.every(n=>n.localMatrix.every(x=>!Object.is(x,-0))));
  assert.ok(Object.is(value.nodes[0].localMatrix[3],-0),'The caller metadata is not mutated');
});

test('builder retains actual accepted export numbers rather than replacing them with expected source-map transforms',()=>{
  const f=fixture(),n=f.byKey('node3');n.translation=[0,2**-60,0];const g=buildConvertedGraph(f.bytes());
  assert.equal(f.map.nodes.find((v:Doc)=>v.nodeKey==='node3').localMatrix[13],2**-80);
  assert.equal(g.nodes.find(v=>v.nodeKey==='node3')!.localMatrix[13],2**-60);
});

test('metadata parsing is distinct from source-byte verification and cannot make a compensating parent change faithful',()=>{
  const f=fixture(),g=buildConvertedGraph(f.bytes()),different=structuredClone(g) as unknown as Doc;
  different.nodes.find((n:Doc)=>n.nodeKey==='node3').parentKey='node1';
  assert.notEqual(parseConvertedGraph(reseal(different)).digest,g.digest,'A self-consistent metadata graph is not a source witness');
  const root=f.byKey('node0'),leaf=f.byKey('node3'),parent=f.byKey('node1'),leafIndex=f.output.nodes.indexOf(leaf);
  root.children=root.children.filter((index:number)=>index!==leafIndex);parent.children.push(leafIndex);
  assert.throws(()=>buildConvertedGraph(f.bytes()),anyRefusal,'Unchanged world transform cannot replace exact direct parentage');
});

test('missing or duplicated EMPTY correspondence refuses even after the audit model checksum is resealed',()=>{
  for(const mutate of [(f:ReturnType<typeof fixture>)=>{delete f.byKey('node3').extras[CONVERSION_NODE_KEY];},
    (f:ReturnType<typeof fixture>)=>{f.byKey('node3').extras[CONVERSION_NODE_KEY]='node0';},
    (f:ReturnType<typeof fixture>)=>{const at=f.output.nodes.indexOf(f.byKey('node3'));f.output.nodes.splice(at,1);
      for(const n of f.output.nodes)if(n.children)n.children=n.children.filter((i:number)=>i!==at).map((i:number)=>i>at?i-1:i);
      for(const scene of f.output.scenes)scene.nodes=scene.nodes.filter((i:number)=>i!==at).map((i:number)=>i>at?i-1:i);}]){
    const f=fixture();mutate(f);assert.throws(()=>buildConvertedGraph(f.bytes()),anyRefusal);
  }
});

test('fractional, duplicate or reassociated vertex IDs and substituted correspondence digests refuse with resealed export hashes',()=>{
  for(const value of [.5,1]){const f=fixture(),p=f.byKey('node2_primitive0'),primitive=f.output.meshes[p.mesh].primitives[0],a=f.output.accessors[primitive.attributes[CONVERSION_VERTEX_ID]],v=f.output.bufferViews[a.bufferView];
    f.outputBin.writeFloatLE(value,(v.byteOffset??0)+(a.byteOffset??0));assert.throws(()=>buildConvertedGraph(f.bytes()),anyRefusal);}
  const swapped=fixture(),node=swapped.byKey('node2_primitive0'),primitive=swapped.output.meshes[node.mesh].primitives[0],a=swapped.output.accessors[primitive.attributes[CONVERSION_VERTEX_ID]],v=swapped.output.bufferViews[a.bufferView],at=(v.byteOffset??0)+(a.byteOffset??0);
  swapped.outputBin.writeFloatLE(1,at);swapped.outputBin.writeFloatLE(0,at+4);assert.throws(()=>buildConvertedGraph(swapped.bytes()),anyRefusal,'A complete ID set still cannot reassign the source vertex association');
  const f=fixture();f.audit.importedParts[0].correspondenceSha256=sha('different IDs');f.audit.reopenedParts=structuredClone(f.audit.importedParts);
  assert.throws(()=>buildConvertedGraph(f.bytes()),anyRefusal);
});

test('actual export identity, zero pivot and audit marker-index associations cannot be spoofed',()=>{
  for(const mutate of [(n:Doc)=>{n.extras.arcane_pivot=[1,0,0];},(n:Doc)=>{n.extras.arcane_source_object_id='arcane_'+sha('foreign source');}]){
    const f=fixture();mutate(f.byKey('node2_primitive0'));assert.throws(()=>buildConvertedGraph(f.bytes()),anyRefusal);
  }
  const f=fixture(),b=f.bytes(),audit=JSON.parse(b.auditBytes.toString('utf8')) as Doc;
  audit.models[0].objects[0].nodeIndex=f.prepared.parts[0]!.importNodeIndex;
  assert.throws(()=>buildConvertedGraph({...b,auditBytes:json(audit)}),anyRefusal,'An import index cannot substitute for actual marked export-node identity');
});

test('declared raw JSON hashes/lengths and exact regenerated marked import bytes remain mandatory',()=>{
  const f=fixture(),b=f.bytes();for(const field of ['sourceBytes','importBytes','renderBytes'] as const){const changed=Buffer.from(b[field]);changed[changed.length-1]=changed[changed.length-1]!^1;assert.throws(()=>buildConvertedGraph({...b,[field]:changed}),anyRefusal);}
  assert.throws(()=>buildConvertedGraph({...b,sourceMapBytes:Buffer.concat([b.sourceMapBytes,Buffer.from(' ')])}),anyRefusal);
  assert.throws(()=>buildConvertedGraph({...b,requestBytes:Buffer.from(b.requestBytes.toString().replace('"name":"graph-model"','"name":"graph-model","name":"graph-model"'))}),anyRefusal);
  f.request.sourceBytes++;assert.throws(()=>buildConvertedGraph(f.bytes()),anyRefusal);
});

test('raw retained map signed zeros round-trip without rewriting the bytes or changing graph identity',()=>{
  const f=fixture(),b=f.bytes(),expected=buildConvertedGraph(b),sourceMapBytes=Buffer.from(b.sourceMapBytes.toString('utf8').replace('"sourceSceneIndex":0','"sourceSceneIndex":-0.0'));
  const request=JSON.parse(b.requestBytes.toString('utf8')) as Doc;request.sourceMapSha256=sha(sourceMapBytes);const requestBytes=json(request),audit=JSON.parse(b.auditBytes.toString('utf8')) as Doc;
  audit.sourceMapSha256=request.sourceMapSha256;audit.requestSha256=sha(requestBytes);const before=sha(sourceMapBytes);
  assert.deepEqual(buildConvertedGraph({...b,sourceMapBytes,requestBytes,auditBytes:json(audit)}),expected);assert.equal(sha(sourceMapBytes),before);
});

test('actual convex collision bytes produce only the explicit derived-root association, while missing/open/extra bytes refuse',()=>{
  const f=fixture(true),b=f.bytes(),g=buildConvertedGraph(b),derived=g.meshes.filter(m=>m.nodeKey===null);
  assert.equal(derived.length,1);assert.equal(derived[0]!.sourceObjectId,convertedGlbObjectId(f.request.sourceSha256,'collision','proxy'));
  assert.equal(derived[0]!.correspondenceSha256,null);assert.deepEqual(derived[0]!.sourcePivot,[0,0,0]);assert.equal(g.nodes.length,7);
  const {collisionBytes:_collision,...missing}=b;assert.throws(()=>buildConvertedGraph(missing),anyRefusal);
  f.setCollision(f.collisionGlb(true));assert.throws(()=>buildConvertedGraph(f.bytes()),anyRefusal);
  const none=fixture();assert.throws(()=>buildConvertedGraph({...none.bytes(),collisionBytes:b.collisionBytes!}),anyRefusal);
});

test('closed metadata rejects graph/pivot/digest/parent/mesh faults even when a caller requests a new digest',()=>{
  const g=buildConvertedGraph(fixture().bytes());
  for(const mutate of [(v:Doc)=>{v.engineVerification='verified';},(v:Doc)=>{v.nodes[0].parentKey='node9999';},
    (v:Doc)=>{v.nodes[0].parentKey=v.nodes[0].nodeKey;},(v:Doc)=>{v.nodes.push(v.nodes[0]);},
    (v:Doc)=>{v.meshes.push(v.meshes[0]);},(v:Doc)=>{v.meshes[0].sourcePivot=[1,0,0];},
    (v:Doc)=>{v.meshes[0].nodeKey='node0';},(v:Doc)=>{v.meshes[0].correspondenceSha256=null;},
    (v:Doc)=>{v.nodes.find((n:Doc)=>n.nodeKey==='node2_primitive0').parentKey='node0';}]){
    const v=structuredClone(g) as unknown as Doc;mutate(v);assert.throws(()=>reseal(v),graphError);
  }
  assert.throws(()=>parseConvertedGraph({...g,digest:sha('foreign')}),graphError);
});

test('proxy/getter/prototype/symbol/hidden/sparse metadata and builder inputs refuse without executing caller code',()=>{
  const g=buildConvertedGraph(fixture().bytes());let calls=0;
  const proxy=new Proxy({}, {ownKeys(){calls++;throw Error('Not invoked');}}),getter=Object.defineProperty({...g},'nodes',{enumerable:true,get(){calls++;return g.nodes;}});
  const symbol={...g,[Symbol('extra')]:1},hidden=Object.defineProperty({...g},'hidden',{value:1}),prototype=Object.assign(Object.create({foreign:true}) as object,g);
  const sparse=structuredClone(g) as unknown as Doc;delete sparse.nodes[0].localMatrix[1];
  const nullArray=structuredClone(g) as unknown as Doc;Object.setPrototypeOf(nullArray.nodes,null);
  for(const value of [proxy,getter,symbol,hidden,prototype,sparse,nullArray])assert.throws(()=>parseConvertedGraph(value),graphError);
  assert.deepEqual(parseConvertedGraph(Object.assign(Object.create(null) as object,g)),g,'Plain null-prototype records remain supported');
  const b=fixture().bytes(),options=Object.defineProperty({...b},'renderBytes',{enumerable:true,get(){calls++;return b.renderBytes;}});
  assert.throws(()=>buildConvertedGraph(options),graphError);assert.throws(()=>buildConvertedGraph(proxy as ConvertedGraphSourceBytes),graphError);
  assert.throws(()=>buildConvertedGraph({...b,importBytes:new Proxy(b.importBytes,{get(){calls++;throw Error('Not invoked');}})}),graphError);
  assert.throws(()=>buildConvertedGraph({...b,importBytes:Buffer.from(new SharedArrayBuffer(b.importBytes.length))}),graphError);assert.equal(calls,0);
});

test('finite, conditioned, depth and size metadata budgets fail closed with iterative hierarchy checks',()=>{
  const g=buildConvertedGraph(fixture().bytes());
  for(const number of [NaN,Infinity,1000001,0,1e-8]){const v=structuredClone(g) as unknown as Doc;v.nodes[0].localMatrix[0]=number;assert.throws(()=>reseal(v),graphError);}
  const tooMany=structuredClone(g) as unknown as Doc;tooMany.nodes=Array.from({length:STUDIO_IMPORT_GRAPH_LIMITS.nodes+1},(_,i)=>({nodeKey:'node'+i,parentKey:null,localMatrix:identity(),name:null}));
  assert.throws(()=>reseal(tooMany),graphError);
  const deep={schemaVersion:1,sourceSceneIndex:0,nodes:Array.from({length:128},(_,i)=>({nodeKey:'node'+i,parentKey:i?'node'+(i-1):null,localMatrix:identity(),name:null})),
    meshes:[{sourceObjectId:'arcane_'+sha('metadata'),nodeKey:'node127_primitive0',sourcePivot:[0,0,0],correspondenceSha256:sha('topology')}]};
  deep.nodes.push({nodeKey:'node127_primitive0',parentKey:'node127',localMatrix:identity(),name:null});assert.throws(()=>convertedGraphDigest(deep),graphError);
});
