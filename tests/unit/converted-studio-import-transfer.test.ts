import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {buildConvertedGraph,type ConvertedGraphSourceBytes} from '../../packages/asset-pipeline/src/studio-import-graph.js';
import {prepareGlbConversionSource} from '../../packages/asset-pipeline/src/glb-conversion-source.js';
import {convertedGlbObjectId,convertedGlbAssetId,parseConvertedGlbRequest} from '../../packages/asset-pipeline/src/converted-glb.js';
import {CONVERSION_FIDELITY_POLICY,CONVERSION_NODE_KEY,conversionCorrespondenceSha256} from '../../packages/asset-pipeline/src/conversion-fidelity-policy.js';
import {createStudioImportManifestAuthority,type HostConvertedStudioImportV2,type ConvertedPreparedStudioImportV2,type HostStudioImport} from '../../packages/asset-pipeline/src/studio-import-manifest.js';
import {decodeStudioImportPayload,type ConvertedStudioImportPayloadV2} from '../../packages/asset-pipeline/src/studio-import-payload.js';
import {createStudioImportTransfer,inspectConvertedStudioImportTransfer,measureStudioImportTransferArguments,parseConvertedStudioImportTransferPacket,type ConvertedStudioImportTransferV2} from '../../packages/asset-pipeline/src/studio-import-transfer.js';
import {STUDIO_ASSET_TRANSFER_LIMITS} from '../../packages/protocol/src/studio.js';
// Constructed exact GLBs and synthetic audit metadata only; no native/Studio/resource execution.
type Doc=Record<string,any>;
function packetAt(bodies:Doc[],index:number):Doc {
  const packet=bodies[index];assert.ok(packet,'Expected packet at '+index);return packet;
}
function packetMatching(bodies:Doc[],predicate:(packet:Doc)=>boolean):Doc {
  const packet=bodies.find(predicate);assert.ok(packet,'Expected matching mutation packet');return packet;
}
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
const selection={target:{sessionId:'studio-session',placeId:0,universeId:0,root:'Workspace' as const,parentRef:'selected-parent',creator:{kind:'user' as const,id:'123'}},placement:{mode:'origin' as const},studsPerMeter:2};
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
const continuity={clientLifetimeId:'owned-lifetime',pluginArtifactHash:sha('plugin'),playEpoch:0};
async function transferFixture(collision=false,decorate?:(fixture:ReturnType<typeof hostFixture>)=>void){
  const f=hostFixture(collision);decorate?.(f);const input=f.host(),prepared=await converted(input),payload=decodeStudioImportPayload(prepared,new Map(input.files.map(file=>[file.fileId,file.bytes])));
  assert.equal(payload.formatVersion,2);const v2=payload as ConvertedStudioImportPayloadV2;
  return {f,input,prepared,payload:v2,transfer:()=>createStudioImportTransfer(prepared,v2)};
}
function reseal(transfer:ConvertedStudioImportTransferV2,mutate:(bodies:Doc[])=>void):Doc {
  const copy=JSON.parse(JSON.stringify(transfer)) as Doc,bodies=copy.packets.map((p:Doc)=>JSON.parse(p.json));mutate(bodies);
  const packets:Doc[]=[];let size=0;
  for(let i=0;i<bodies.length;i++){
    const body=bodies[i]!;body.ordinal=i;
    if(i===bodies.length-1&&body.kind==='seal')Object.assign(body,{precedingPacketCount:i,precedingByteLength:size,contentDigest:sha(packets.map(p=>[p.ordinal,p.kind,p.byteLength,p.sha256].join(':')).join('\n'))});
    const text=JSON.stringify(body),byteLength=Buffer.byteLength(text);packets.push({ordinal:i,kind:body.kind,json:text,byteLength,sha256:sha(text)});size+=byteLength;
  }
  return {...copy,packets,byteLength:size,digest:sha(packets.map(p=>p.sha256).join('\n'))};
}
for(const collision of [false,true])test('converted transfer '+(collision?'hull':'none')+' seals every root, EMPTY, local matrix, name and source pivot',async()=>{
  const f=await transferFixture(collision),transfer=f.transfer(),inspected=inspectConvertedStudioImportTransfer(transfer),bodies=transfer.packets.map(p=>JSON.parse(p.json));
  assert.equal(transfer.formatVersion,2);assert.equal(transfer.engineVerification,'pending');assert.equal(transfer.payloadDigest,f.payload.digest);
  assert.deepEqual(transfer,f.transfer());assert.deepEqual(inspected.graph,f.prepared.manifest.graph);assert.equal(inspected.payloadDigest,f.payload.digest);
  const nodePackets=bodies.filter(b=>b.kind==='node'),seen=new Set<string>();
  assert.equal(nodePackets.length,f.prepared.manifest.graph.nodes.length);assert.equal(nodePackets.filter(b=>b.node.parentKey===null).length,2);
  for(const packet of nodePackets){assert.ok(packet.node.parentKey===null||seen.has(packet.node.parentKey));seen.add(packet.node.nodeKey);const original=f.prepared.manifest.graph.nodes.find(n=>n.nodeKey===packet.node.nodeKey)!;assert.deepEqual(packet.node,original);}
  assert.ok(nodePackets.some(b=>b.node.name==='Empty leaf'));assert.ok(nodePackets.some(b=>b.node.localMatrix[13]===2**-80));
  const objectPackets=bodies.filter(b=>b.kind==='object');assert.deepEqual(objectPackets.map(b=>b.association),f.payload.objects.map(o=>o.association));
  for(const object of objectPackets){assert.deepEqual(object.object.pivot,[0,0,0]);for(const primitive of object.primitives){assert.equal('_ARCANE_SOURCE_VERTEX_ID'in primitive.attributes,false);assert.equal(primitive.correspondence===null,object.object.role==='collision');}}
  assert.equal(bodies.filter(b=>b.kind==='chunk'&&b.semantic==='_ARCANE_SOURCE_VERTEX_ID').length,0);
  const measured=measureStudioImportTransferArguments(transfer,f.prepared.manifest.target,continuity);
  assert.equal(measured.byteLength,measured.arguments.reduce((sum,args)=>sum+Buffer.byteLength(JSON.stringify(args)),0));
  assert.ok(measured.byteLengths.every(bytes=>bytes<=STUDIO_ASSET_TRANSFER_LIMITS.packetBytes));assert.ok(Object.isFrozen(measured)&&Object.isFrozen(measured.arguments[0]!.target));
  assert.equal(measured.digest,sha(measured.arguments.map(args=>sha(JSON.stringify(args))).join('\n')));
});
test('converted immutable chunks reconstruct exact source/proof metadata after mutable convenience bytes change',async()=>{
  const f=await transferFixture(),before=f.transfer();f.payload.objects[0]!.primitives[0]!.attributes.POSITION!.bytes.fill(255);
  const after=f.transfer();assert.deepEqual(after,before);assert.equal(inspectConvertedStudioImportTransfer(after).payloadDigest,f.payload.digest);
});
test('ordinary resealed checksums cannot hide omitted EMPTYs, reordered hierarchy, changed names/pivots or source metadata',async()=>{
  const f=await transferFixture(true),transfer=f.transfer();
  const changes:((bodies:Doc[])=>void)[]=[b=>b.splice(b.findIndex(p=>p.kind==='node'&&p.node.name==='Empty leaf'),1),
    b=>{const i=b.findIndex(p=>p.kind==='node'&&p.node.parentKey!==null);const first=packetAt(b,1),child=packetAt(b,i);b[1]=child;b[i]=first;},
    b=>packetMatching(b,p=>p.kind==='node').node.name='changed name',b=>packetMatching(b,p=>p.kind==='node'&&p.node.parentKey!==null).node.parentKey=null,
    b=>packetMatching(b,p=>p.kind==='object').association.sourcePivot=[1,0,0],b=>packetMatching(b,p=>p.kind==='object').provenance.node.name='changed source',
    b=>packetMatching(b,p=>p.kind==='object'&&p.object.role==='render').primitives[0].correspondence.ids[0]=999,b=>packetAt(b,0).sourceDocuments[0].document.asset.generator='substituted',
    b=>packetAt(b,0).conversionRequest.parentManifestSha256=sha('foreign parent'),b=>packetAt(b,0).graph.digest=sha('foreign graph')];
  for(const change of changes){const changed=reseal(transfer,change);assert.throws(()=>inspectConvertedStudioImportTransfer(changed));}
});
test('converted chunk omission, duplicate offsets, foreign streams and changed bytes refuse after ordinary resealing',async()=>{
  const f=await transferFixture(),transfer=f.transfer();
  for(const change of [(b:Doc[])=>b.splice(b.findIndex(p=>p.kind==='chunk'),1),(b:Doc[])=>packetMatching(b,p=>p.kind==='chunk').offset++,
    (b:Doc[])=>packetMatching(b,p=>p.kind==='chunk').streamId=sha('foreign stream'),(b:Doc[])=>packetMatching(b,p=>p.kind==='chunk').data='AAAA']){
    const changed=reseal(transfer,change);assert.throws(()=>inspectConvertedStudioImportTransfer(changed));}
});
test('converted data inspection never revives serialized decoded provenance or a partial/resumable transfer claim',async()=>{
  const f=await transferFixture(),transfer=f.transfer(),copy=JSON.parse(JSON.stringify(transfer));
  assert.equal(inspectConvertedStudioImportTransfer(copy).payloadDigest,transfer.payloadDigest);
  assert.throws(()=>measureStudioImportTransferArguments(copy,f.prepared.manifest.target,continuity),/created from decoded data/);
  assert.throws(()=>createStudioImportTransfer(f.prepared,structuredClone(f.payload)),/decoded payload/);
  assert.throws(()=>inspectConvertedStudioImportTransfer({...copy,packets:copy.packets.slice(0,-1)}));
  assert.throws(()=>inspectConvertedStudioImportTransfer({...copy,packets:copy.packets.slice(1)}));
  let reads=0;const proxy=new Proxy(copy,{getOwnPropertyDescriptor(){reads++;throw Error('trap');},getPrototypeOf(){reads++;throw Error('trap');}});
  assert.throws(()=>inspectConvertedStudioImportTransfer(proxy));const getter={...copy};Object.defineProperty(getter,'packets',{enumerable:true,get(){reads++;return copy.packets;}});assert.throws(()=>inspectConvertedStudioImportTransfer(getter));assert.equal(reads,0);
});
test('converted packet reader refuses mixed versions, unknown fields, duplicate keys and over-budget packet counts',async()=>{
  const f=await transferFixture(),transfer=f.transfer(),begin=JSON.parse(transfer.packets[0]!.json);
  assert.throws(()=>parseConvertedStudioImportTransferPacket(JSON.stringify({...begin,formatVersion:1})));
  assert.throws(()=>parseConvertedStudioImportTransferPacket(JSON.stringify({...begin,approved:true})));
  assert.throws(()=>parseConvertedStudioImportTransferPacket('{"formatVersion":2,'+transfer.packets[0]!.json.slice(1)));
  assert.throws(()=>inspectConvertedStudioImportTransfer({...transfer,packets:Array.from({length:513},()=>transfer.packets[0]!)}));
  assert.throws(()=>measureStudioImportTransferArguments(transfer,{...f.prepared.manifest.target,parentRef:'another-parent'},continuity));
});
test('actual escaped converted metadata is refused before a transfer can be staged',async()=>{
  const f=await transferFixture(false,fixture=>{fixture.output.extras={ownedMetadata:'"\\'.repeat(40_000)};});
  assert.throws(()=>f.transfer(),(error:unknown)=>!!error&&typeof error==='object'&&'code'in error&&error.code==='BUDGET');
});
