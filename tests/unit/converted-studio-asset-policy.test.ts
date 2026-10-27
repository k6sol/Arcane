import {validateCommandArgs} from '../../packages/core/src/studio-policy.js';
import {STUDIO_ASSET_TRANSFER_LIMITS,type StudioImportObservationReceipt,type StudioSession,type ConvertedStudioAssetReconstructArgsV2,type GeneratedStudioAssetReconstructArgsV1} from '../../packages/protocol/src/studio.js';
import {decodeStudioImportPayload,StudioImportPayloadError} from '../../packages/asset-pipeline/src/studio-import-payload.js';
import {createStudioImportTransfer,measureStudioImportTransferArguments,inspectConvertedStudioImportTransfer,parseConvertedStudioImportTransferPacket} from '../../packages/asset-pipeline/src/studio-import-transfer.js';
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

function session():StudioSession {return{id:'studio-session',clientSessionId:'client-lifetime',placeId:0,universeId:0,name:'Synthetic connection',pluginVersion:'synthetic metadata',protocolVersion:1,
  allowedRoots:['Workspace'],allowWrites:true,capabilities:['asset.stage_packet','asset.reconstruct'],connectedAt:'2026-10-27T00:00:00Z',lastSeenAt:'2026-10-27T00:00:00Z',revokedAt:null,
  proof:{sessionId:'studio-session',clientLifetimeId:'client-lifetime',pluginArtifactHash:sha('synthetic plugin artifact'),markerName:'synthetic-marker',placeId:0,universeId:0,placeName:'Synthetic place',
    mode:'Edit',playEpoch:0,continuitySupported:true,connected:true,observedAt:'2026-10-27T00:00:00Z',expiresAt:'2026-10-27T00:10:00Z'}};}
async function staged(hull=false){const input=hostFixture(hull).host(),prepared=await converted(input),payload=decodeStudioImportPayload(prepared,new Map(input.files.map(f=>[f.fileId,f.bytes])));
  if(payload.formatVersion!==2)assert.fail('Expected converted payload');const transfer=createStudioImportTransfer(prepared,payload),s=session();
  if(transfer.formatVersion!==2)assert.fail('Expected converted transfer');const continuity={clientLifetimeId:s.clientSessionId,pluginArtifactHash:s.proof!.pluginArtifactHash,playEpoch:s.proof!.playEpoch};
  const measured=measureStudioImportTransferArguments(transfer,input.target,continuity);return{input,prepared,payload,transfer,measured,s,continuity};}
function altered(args:unknown,mutate:(p:Doc)=>void):Doc {const value=JSON.parse(JSON.stringify(args)) as Doc,packet=JSON.parse(value.packet) as Doc;mutate(packet);value.packet=JSON.stringify(packet);return value;}

for(const hull of [false,true])test('actual synthetic converted '+(hull?'hull':'none')+' packets pass connected scope policy and complete preclaim inspection',async()=>{
  const f=await staged(hull),inspected=inspectConvertedStudioImportTransfer(f.transfer);
  assert.equal(inspected.graph.nodes.length,7);assert.equal(inspected.graph.meshes.length,hull?3:2);assert.equal(inspected.graph.nodes.filter(n=>n.parentKey===null).length,2);
  assert.equal(inspected.graph.nodes.find(n=>n.nodeKey==='node3')!.localMatrix[13],2**-80);assert.equal(inspected.graph.nodes.find(n=>n.nodeKey==='node1')!.name,'Empty ancestor');
  for(const args of f.measured.arguments){assert.deepEqual(validateCommandArgs('asset.stage_packet',args,f.s),args);assert.ok(Buffer.byteLength(JSON.stringify(args))<=STUDIO_ASSET_TRANSFER_LIMITS.packetBytes);}
  assert.equal(f.measured.byteLengths.reduce((n,v)=>n+v,0),f.measured.byteLength);assert.ok(f.measured.byteLength<=STUDIO_ASSET_TRANSFER_LIMITS.envelopeBytes);
  const nodePackets=f.transfer.packets.filter(p=>p.kind==='node').map(p=>JSON.parse(p.json).node as Doc),seen=new Set<string>();
  for(const n of nodePackets){assert.ok(n.parentKey===null||seen.has(n.parentKey));seen.add(n.nodeKey);}assert.equal(seen.size,7);
  assert.equal(f.transfer.formatVersion,2);assert.equal(f.prepared.manifest.engineVerification,'pending');
});

test('connected converted packet policy closes node/object/proof/header bodies and refuses unsupported versions',async()=>{
  const f=await staged(),find=(kind:string)=>f.measured.arguments.find(a=>JSON.parse(a.packet).kind===kind)!;
  for(const [kind,mutate]of [['node',(p:Doc)=>{p.node.unexpected=true;}],['node',(p:Doc)=>{delete p.node.name;}],['node',(p:Doc)=>{p.node.parentKey=p.node.nodeKey;}],
    ['node',(p:Doc)=>{p.node.localMatrix[15]=0;}],['node',(p:Doc)=>{p.formatVersion=1;}],['node',(p:Doc)=>{p.formatVersion=3;}],
    ['object',(p:Doc)=>{p.object.pivot=[1,0,0];}],['object',(p:Doc)=>{p.association.nodeKey=null;}],
    ['object',(p:Doc)=>{p.primitives[0].correspondence.semantic='_CALLER_PROOF';}],['object',(p:Doc)=>{p.primitives[0].attributes._CALLER_PROOF=p.primitives[0].attributes.POSITION;}],
    ['begin',(p:Doc)=>{p.graph.extra=true;}],['begin',(p:Doc)=>{p.conversionRequest.fidelityPolicy='caller-policy';}],['begin',(p:Doc)=>{p.conversion.sourceUp='Z';}],
    ['begin',(p:Doc)=>{p.delta.graph.nextDigest=sha('foreign');}],['chunk',(p:Doc)=>{p.encoding='url';}],['seal',(p:Doc)=>{p.unexpected=true;}]] as const){
    assert.throws(()=>validateCommandArgs('asset.stage_packet',altered(find(kind),mutate),f.s),refused,kind);
  }
  const duplicate=JSON.parse(JSON.stringify(find('node'))) as Doc;duplicate.packet=duplicate.packet.replace('"formatVersion":2','"formatVersion":2,"formatVersion":2');
  assert.throws(()=>validateCommandArgs('asset.stage_packet',duplicate,f.s),refused);
  const deep=altered(find('begin'),p=>{let value:Doc={};p.sourceDocuments[0].document.extras=value;for(let at=0;at<90;at++){value.child={};value=value.child;}});
  assert.throws(()=>validateCommandArgs('asset.stage_packet',deep,f.s),refused);
  const mixed=JSON.parse(find('object').packet) as Doc;mixed.formatVersion=1;assert.throws(()=>parseConvertedStudioImportTransferPacket(JSON.stringify(mixed)),refused,'The complete converted batch parser refuses a downgraded common packet kind');
});

test('converted staging retains original read-only, exact target and current Edit continuity refusals',async()=>{
  const f=await staged(),args=f.measured.arguments[0]!;
  for(const mutate of [(s:StudioSession)=>{s.allowWrites=false;},(s:StudioSession)=>{s.allowedRoots=[];},(s:StudioSession)=>{s.id='foreign-session';},
    (s:StudioSession)=>{s.proof!.mode='Play';},(s:StudioSession)=>{s.proof!.playEpoch++;},(s:StudioSession)=>{s.proof!.pluginArtifactHash=sha('foreign');},
    (s:StudioSession)=>{s.proof!.continuitySupported=false;},(s:StudioSession)=>{s.proof!.connected=false;}]){
    const s=structuredClone(f.s);mutate(s);assert.throws(()=>validateCommandArgs('asset.stage_packet',args,s),refused);
  }
  const wrong=JSON.parse(JSON.stringify(args)) as Doc;wrong.target.parentRef='foreign-parent';assert.throws(()=>validateCommandArgs('asset.stage_packet',wrong,f.s),refused,'Begin target and exact queue target cannot diverge');
});

test('fully escaped actual argument envelope refuses before a raw packet reaches its own byte ceiling',async()=>{
  const f=await staged(),args=altered(f.measured.arguments[0],p=>{p.sourceDocuments[0].document.extras={diagnostic:'"'.repeat(70000)};});
  assert.ok(Buffer.byteLength(args.packet)<STUDIO_ASSET_TRANSFER_LIMITS.packetBytes);assert.ok(Buffer.byteLength(JSON.stringify(args))>STUDIO_ASSET_TRANSFER_LIMITS.packetBytes);
  assert.throws(()=>validateCommandArgs('asset.stage_packet',args,f.s),refused);
});

test('small synthetic texture declarations keep the exact v2 descriptor fields and refuse extra data',async()=>{
  // Local packet shape only: this is not a decoded image or a complete batch.
  const f=await staged(),bytes=Buffer.from([0,64,128,255]),hash=sha(bytes),imageId=sha('synthetic texture metadata'),streamId=sha(['texture-'+imageId,'-1','ColorMap'].join('\0'));
  const stream={streamId,semantic:'ColorMap',componentType:5121,type:'VEC4',count:1,normalized:false,byteLength:4,sha256:hash,source:null,chunks:[{offset:0,byteLength:4,sha256:hash}]};
  const texture={semantic:'ColorMap',componentType:5121,type:'VEC4',count:1,normalized:false,byteLength:4,sha256:hash,imageId,materialSha256:sha('synthetic material'),sourceSha256:sha('synthetic encoded PNG'),
    sourceRgbaSha256:hash,channel:'rgba',factors:[1,1,1,1],width:1,height:1,colorSpace:'srgb',orientation:'top-left',normalConvention:null,stream};
  const args={...f.measured.arguments[0]!,packet:JSON.stringify({formatVersion:2,payloadDigest:f.transfer.payloadDigest,manifestDigest:f.prepared.manifest.digest,ordinal:8,kind:'texture',texture})};
  assert.deepEqual(validateCommandArgs('asset.stage_packet',args,f.s),args);
  assert.throws(()=>validateCommandArgs('asset.stage_packet',altered(args,p=>{p.texture.unknown=true;}),f.s),refused);
  assert.throws(()=>validateCommandArgs('asset.stage_packet',altered(args,p=>{p.texture.stream.byteLength=3;}),f.s),refused);
});

test('version2 reconstruction binds exact parent-before-child logical node coverage without invented observed instances',async()=>{
  const f=await staged(true),nodes=f.transfer.packets.filter(p=>p.kind==='node').map(p=>{const n=JSON.parse(p.json).node as Doc;return{nodeKey:n.nodeKey,parentKey:n.parentKey,
    sourceObjectId:f.payload.graph.meshes.find(m=>m.nodeKey===n.nodeKey)?.sourceObjectId??null};}),objects=f.payload.objects.map(o=>({sourceObjectId:o.object.sourceObjectId,meshExportSha256:o.object.meshExportSha256,
      vertexCount:o.primitives.reduce((n,p)=>n+p.vertexCount,0),triangleCount:o.primitives.reduce((n,p)=>n+p.triangleCount,0)}));
  const args:ConvertedStudioAssetReconstructArgsV2={formatVersion:2,graphDigest:f.payload.graph.digest,nodeCount:nodes.length,nodes,runId:'44444444-4444-4444-8444-444444444444',
    expected:f.measured.arguments[0]!.expected,packetCount:f.transfer.packets.length,byteLength:f.transfer.byteLength,objects,target:f.input.target,continuity:f.continuity};
  assert.deepEqual(validateCommandArgs('asset.reconstruct',args,f.s),args);assert.equal(args.nodeCount,7);assert.ok(args.nodes.every(n=>!Object.hasOwn(n,'instanceRef')&&!Object.hasOwn(n,'ownedStateSha256')));
  for(const mutate of [(a:Doc)=>{a.nodes.reverse();},(a:Doc)=>{a.nodes.pop();},(a:Doc)=>{a.nodes.push(a.nodes[0]);a.nodeCount++;},
    (a:Doc)=>{a.nodes[0].instanceRef='invented';},(a:Doc)=>{a.nodes.find((n:Doc)=>n.sourceObjectId!==null).sourceObjectId='foreign';},
    (a:Doc)=>{a.nodes.find((n:Doc)=>n.sourceObjectId!==null).sourceObjectId=null;},(a:Doc)=>{a.graphDigest='bad';},
    (a:Doc)=>{delete a.graphDigest;},(a:Doc)=>{delete a.formatVersion;},(a:Doc)=>{a.formatVersion=1;}]){
    const bad=structuredClone(args) as unknown as Doc;mutate(bad);assert.throws(()=>validateCommandArgs('asset.reconstruct',bad,f.s),refused);
  }
});

test('native eligibility refuses unsupported affine grouping before transfer or allocation while source metadata stays intact',async()=>{
  const input=hostFixture(false,'shear').host(),prepared=await converted(input),before=JSON.stringify(prepared.manifest.graph);
  assert.equal(prepared.manifest.graph.nodes.find(n=>n.nodeKey==='node1')!.localMatrix[4],.25);
  assert.throws(()=>decodeStudioImportPayload(prepared,new Map(input.files.map(f=>[f.fileId,f.bytes]))),e=>e instanceof StudioImportPayloadError&&e.code==='UNSUPPORTED_TRANSFORM');
  assert.equal(JSON.stringify(prepared.manifest.graph),before);assert.equal(prepared.manifest.engineVerification,'pending');
});

test('legacy generated staging and reconstruction retain their exact graphless version-absence contracts',()=>{
  const s=session(),expected={digest:sha('legacy transfer'),payloadDigest:sha('legacy payload'),manifestDigest:sha('legacy manifest')},continuity={clientLifetimeId:s.clientSessionId,pluginArtifactHash:s.proof!.pluginArtifactHash,playEpoch:s.proof!.playEpoch};
  const packet=JSON.stringify({formatVersion:1,payloadDigest:expected.payloadDigest,manifestDigest:expected.manifestDigest,ordinal:0,kind:'begin'}),stage={expected,packet,target:selection.target,continuity};
  assert.equal(JSON.stringify(validateCommandArgs('asset.stage_packet',stage,s)),JSON.stringify(stage));
  const args:GeneratedStudioAssetReconstructArgsV1={runId:'44444444-4444-4444-8444-444444444444',expected,packetCount:2,byteLength:100,objects:[{sourceObjectId:'legacy-part',meshExportSha256:sha('legacy mesh'),vertexCount:3,triangleCount:1}],target:selection.target,continuity};
  assert.equal(JSON.stringify(validateCommandArgs('asset.reconstruct',args,s)),JSON.stringify(args));assert.equal('formatVersion'in args,false);assert.equal('nodes'in args,false);
});



test('converted begin requires explicit null observation for an original create-only plan',async()=>{
  const f=await staged(),begin=f.measured.arguments[0]!;
  assert.equal(JSON.parse(begin.packet).delta.observation,null);
  assert.deepEqual(validateCommandArgs('asset.stage_packet',begin,f.s),begin);
  for(const mutate of [(p:Doc)=>{delete p.delta.observation;},(p:Doc)=>{p.delta.observation={};},
    (p:Doc)=>{p.delta.receiptSha256=sha('invented receipt');},(p:Doc)=>{p.delta.modelRef='invented root';},
    (p:Doc)=>{p.delta.modelAssetId='999';},(p:Doc)=>{p.delta.graph.previousDigest=sha('invented graph');},
    (p:Doc)=>{p.delta.placementChanged=true;},(p:Doc)=>{p.delta.reviewRemovals=[{}];}])
    assert.throws(()=>validateCommandArgs('asset.stage_packet',altered(begin,mutate),f.s),refused);
});

async function revisionBegin(hull:boolean,live:boolean){
  const fixture=hostFixture(hull),previous=await converted(fixture.host()),input=fixture.host(NEXT);input.baseline=baseline(previous,live);
  const prepared=await converted(input),payload=decodeStudioImportPayload(prepared,new Map(input.files.map(file=>[file.fileId,file.bytes])));
  if(payload.formatVersion!==2)assert.fail('Expected actual converted decoder');
  const transfer=createStudioImportTransfer(prepared,payload),s=session(),continuity={clientLifetimeId:s.clientSessionId,pluginArtifactHash:s.proof!.pluginArtifactHash,playEpoch:s.proof!.playEpoch};
  const measured=measureStudioImportTransferArguments(transfer,input.target,continuity);return{prepared,begin:measured.arguments[0]!,s};
}
for(const hull of [false,true])test('actual converted '+(hull?'hull':'none')+' revision begin accepts closed observed baseline with nullable live mesh IDs',async()=>{
  for(const live of [false,true]){
    const f=await revisionBegin(hull,live);assert.ok(f.prepared.delta.observation);assert.equal(f.prepared.delta.modelAssetId,null);
    assert.ok(f.prepared.delta.objects.every(row=>live?row.meshAssetId===null:row.meshAssetId!==null));
    assert.deepEqual(validateCommandArgs('asset.stage_packet',f.begin,f.s),f.begin);
  }
});

test('converted begin refuses missing malformed stale or wrong-scope observed witnesses after actual encoding',async()=>{
  const f=await revisionBegin(false,true);
  const mutations:((p:Doc)=>void)[]=[p=>{delete p.delta.observation;},p=>{p.delta.observation=null;},p=>{p.delta.observation.extra=true;},
    p=>{p.delta.observation.commandId='not-a-command';},p=>{p.delta.observation.observation.receiptScope='historical-revision';},
    p=>{p.delta.observation.observation.source.projectId=sha('foreign project');},p=>{p.delta.observation.observation.source.assetId='arcane_'+sha('foreign asset');},
    p=>{p.delta.observation.observation.source.sourceSha256=sha('foreign source');},p=>{p.delta.observation.observation.source.manifestDigest=sha('foreign old manifest');},
    p=>{p.delta.observation.observation.source.graphDigest=sha('foreign old graph');},p=>{p.delta.observation.observation.target.parentRef='foreign-parent';},
    p=>{p.delta.observation.observation.modelRef.instanceId='foreign-root';},p=>{p.delta.modelAssetId='123';},
    p=>{p.delta.observation.receiptSha256=sha('stale checksum');},p=>{p.delta.receiptSha256=sha('different wrapper checksum');}];
  for(const mutate of mutations){
    const bad=altered(f.begin,p=>{mutate(p);
      // Reseal only well-formed synthetic metadata to reach scope/root correlation,
      // while checksum-specific negative cases intentionally remain stale.
      const witness=p.delta.observation;
      if(witness?.observation&&witness.receiptSha256!==sha('stale checksum')&&p.delta.receiptSha256!==sha('different wrapper checksum')){
        try{witness.receiptSha256=studioImportObservationReceiptDigest(witness.observation);p.delta.receiptSha256=witness.receiptSha256;}catch{}
      }
    });
    assert.throws(()=>validateCommandArgs('asset.stage_packet',bad,f.s),refused);
  }
  const tampered=altered(f.begin,p=>{p.delta.observation.observation.modelOwnedStateSha256=sha('changed state without checksum');});
  assert.throws(()=>validateCommandArgs('asset.stage_packet',tampered,f.s),refused);
});
