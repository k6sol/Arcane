import {createHash} from 'node:crypto';
import {types} from 'node:util';
import {STUDIO_ASSET_TRANSFER_LIMITS,type StudioAssetStageArgs} from '../../protocol/src/studio.js';
import {assertDecodedStudioImportPayload,assertConvertedStudioImportRepresentable, type StudioImportPayload, type GeneratedStudioImportPayloadV1, type ConvertedStudioImportPayloadV2, type StudioImportPayloadBuffer} from './studio-import-payload.js';
import {parseNativeStudioImportResponse} from './studio-import-wire.js';
import {parseConvertedGraph,type ConvertedGraphNode} from './studio-import-graph.js';
import {parseConvertedGlbRequest,convertedGlbAssetId,convertedGlbObjectId} from './converted-glb.js';
import type {PreparedStudioImport,GeneratedPreparedStudioImportV1,ConvertedPreparedStudioImportV2} from './studio-import-manifest.js';

/** Internal transport data, not registered Studio commands or upload consent. */
export const STUDIO_IMPORT_TRANSFER_LIMITS = Object.freeze({argumentBytes: 256 * 1024, totalBytes: STUDIO_ASSET_TRANSFER_LIMITS.rawBytes, packets: 8192});
export interface GeneratedStudioImportTransferPacketV1 {
  readonly ordinal: number;
  readonly kind: 'begin' | 'texture' | 'object' | 'chunk' | 'seal';
  /** Exact serialized UTF-8 arguments. Do not reserialize caller-owned objects. */
  readonly json: string;
  readonly byteLength: number;
  readonly sha256: string;
}
function canonical(value:unknown):string {
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value!==null&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical((value as Record<string,unknown>)[key])).join(',')+'}';
  return JSON.stringify(value);
}
function fixed(value:unknown,keys:readonly string[]):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)||types.isProxy(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail('IDENTITY','Transfer requires fixed plain data.');
  const own=Reflect.ownKeys(value);if(own.length!==keys.length||own.some(key=>typeof key!=='string'||!keys.includes(key)))fail('IDENTITY','Transfer has unknown or missing fields.');
  const out:Record<string,unknown>={};for(const key of keys){const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!Object.hasOwn(d,'value')||!d.enumerable)fail('IDENTITY','Transfer accessors are not data.');out[key]=d.value;}return out;
}
function frozen<T>(value:T):T {if(value&&typeof value==='object'){for(const child of Object.values(value))frozen(child);Object.freeze(value);}return value;}
const hashPattern=/^[a-f0-9]{64}(?![\s\S])/;
const bodies={
  begin:['projectId','assetId','revisionId','sourceSha256','origin','identityScheme','preparedDigest','target','conversionRequest','conversionRequestDigest','graph','producer','files','sourceDocuments','conversion','placement','bounds','anchors','objectCount','textureCount','texturesPresent','binaryByteLength','aggregateEncodedByteLength','chunkCount','delta'],
  node:['node'],texture:['texture'],object:['object','association','material','provenance','primitives'],
  chunk:['sourceObjectId','primitiveIndex','streamId','semantic','bufferSha256','offset','byteLength','sha256','encoding','data'],seal:['precedingPacketCount','precedingByteLength','contentDigest'],
} as const;
/** Closed packet metadata only. Original UTF-8 is hashed by the batch reader;
 * decoding never admits resources, durable work or same-process provenance. */
export function parseConvertedStudioImportTransferPacket(json:unknown):Readonly<Record<string,unknown>> {
  if(typeof json!=='string'||Buffer.byteLength(json)>STUDIO_ASSET_TRANSFER_LIMITS.packetBytes)fail('BUDGET','Converted packet exceeds its raw argument bound.');
  let depth=0,nodes=0,quoted=false,escaped=false;
  for(const character of json){if(quoted){if(escaped)escaped=false;else if(character==='\\')escaped=true;else if(character==='"')quoted=false;continue;}if(character==='"')quoted=true;else if(character==='['||character==='{'){if(++depth>48||++nodes>100000)fail('BUDGET','Converted packet metadata exceeds bounded JSON depth.');}else if(character===']'||character==='}')depth--;else if(character===','&&++nodes>100000)fail('BUDGET','Converted packet metadata exceeds its JSON node bound.');}
  let value:unknown;try{value=JSON.parse(json);}catch{fail('IDENTITY','Converted packet is not JSON.');}
  if(!value||typeof value!=='object'||Array.isArray(value))fail('IDENTITY','Converted packet must be an object.');
  const raw=value as Record<string,unknown>,kind=raw.kind;
  if(typeof kind!=='string'||!Object.hasOwn(bodies,kind))fail('IDENTITY','Unknown converted packet kind.');
  const keys=[...bodies[kind as keyof typeof bodies]] as string[];if(kind==='object'&&Object.hasOwn(raw,'textureBindings'))keys.push('textureBindings');
  const result=fixed(value,['formatVersion','payloadDigest','manifestDigest','ordinal','kind',...keys]);
  if(result.formatVersion!==2||typeof result.payloadDigest!=='string'||!hashPattern.test(result.payloadDigest)||typeof result.manifestDigest!=='string'||!hashPattern.test(result.manifestDigest)||typeof result.ordinal!=='number'||!Number.isSafeInteger(result.ordinal)||result.ordinal<0||result.ordinal>=STUDIO_ASSET_TRANSFER_LIMITS.packets||JSON.stringify(value)!==json)fail('IDENTITY','Converted packet version, identity or canonical JSON is invalid.');
  return frozen(result);
}
function parentFirst(nodes:readonly ConvertedGraphNode[]):readonly ConvertedGraphNode[] {
  const compare=(a:ConvertedGraphNode,b:ConvertedGraphNode)=>a.nodeKey<b.nodeKey?-1:a.nodeKey>b.nodeKey?1:0;
  const children=new Map<string|null,ConvertedGraphNode[]>();
  for(const node of nodes){const rows=children.get(node.parentKey)??[];rows.push(node);children.set(node.parentKey,rows);}
  const stack=[...(children.get(null)??[])].sort(compare).reverse(),result:ConvertedGraphNode[]=[];
  while(stack.length){const node=stack.pop()!;result.push(node);stack.push(...[...(children.get(node.nodeKey)??[])].sort(compare).reverse());}
  if(result.length!==nodes.length)fail('IDENTITY','Converted graph did not retain a complete rooted hierarchy.');return result;
}
function createConvertedTransfer(prepared:PreparedStudioImport,payload:ConvertedStudioImportPayloadV2):ConvertedStudioImportTransferV2 {
  const plan=parseNativeStudioImportResponse({prepared},payload.revisionId).prepared;
  if(plan.manifest.schemaVersion!==2||!('graph'in plan.delta))fail('IDENTITY','Converted payload requires exact version-two preparation.');
  const manifest=plan.manifest,graph=parseConvertedGraph(payload.graph),requestDigest=sha(canonical(payload.conversionRequest));
  if(payload.preparedDigest!==plan.digest||payload.manifestDigest!==manifest.digest||payload.projectId!==manifest.projectId||payload.assetId!==manifest.assetId||payload.revisionId!==manifest.revisionId||
    canonical(payload.conversionRequest)!==canonical(manifest.conversionRequest)||canonical(graph)!==canonical(manifest.graph))fail('IDENTITY','Converted payload differs from its sealed preparation.');
  const packets:ConvertedStudioImportTransferPacketV2[]=[];let byteLength=0;
  const packet=(kind:ConvertedStudioImportTransferPacketV2['kind'],body:Record<string,unknown>)=>{
    const ordinal=packets.length,json=JSON.stringify({formatVersion:2,payloadDigest:payload.digest,manifestDigest:manifest.digest,ordinal,kind,...body}),size=Buffer.byteLength(json);
    if(size>STUDIO_ASSET_TRANSFER_LIMITS.packetBytes||Buffer.byteLength(JSON.stringify({packet:json}))>STUDIO_ASSET_TRANSFER_LIMITS.packetBytes||ordinal>=STUDIO_ASSET_TRANSFER_LIMITS.packets||byteLength+size>STUDIO_ASSET_TRANSFER_LIMITS.rawBytes)
      fail('BUDGET','Converted transfer exceeds actual escaped packet or aggregate bridge limits before staging.');
    packets.push(Object.freeze({ordinal,kind,json,byteLength:size,sha256:sha(json)}));byteLength+=size;
  };
  const describe=(stream:StudioImportPayloadBuffer,sourceObjectId:string,primitiveIndex:number)=>{
    const streamId=sha([sourceObjectId,String(primitiveIndex),stream.semantic].join('\0'));let offset=0;const digest=createHash('sha256');
    for(const chunk of stream.chunks){const bytes=Buffer.from(chunk.data,'base64');
      if(chunk.formatVersion!==2||chunk.sourceObjectId!==sourceObjectId||chunk.primitiveIndex!==primitiveIndex||chunk.semantic!==stream.semantic||chunk.manifestDigest!==manifest.digest||chunk.bufferSha256!==stream.sha256||
        chunk.offset!==offset||chunk.byteLength!==bytes.length||sha(bytes)!==chunk.sha256||bytes.toString('base64')!==chunk.data)fail('CHECKSUM','Converted stream chunks changed or lost their exact ordered binding.');
      digest.update(bytes);offset+=bytes.length;
    }
    if(offset!==stream.byteLength||digest.digest('hex')!==stream.sha256)fail('CHECKSUM','Converted stream bytes do not match their immutable digest.');
    return {streamId,semantic:stream.semantic,componentType:stream.componentType,type:stream.type,count:stream.count,normalized:stream.normalized,byteLength:stream.byteLength,sha256:stream.sha256,source:stream.source,
      chunks:stream.chunks.map(chunk=>({offset:chunk.offset,byteLength:chunk.byteLength,sha256:chunk.sha256}))};
  };
  const chunks=(stream:StudioImportPayloadBuffer,sourceObjectId:string,primitiveIndex:number,streamId:string)=>{
    for(const chunk of stream.chunks)packet('chunk',{sourceObjectId,primitiveIndex,streamId,semantic:stream.semantic,bufferSha256:stream.sha256,offset:chunk.offset,byteLength:chunk.byteLength,sha256:chunk.sha256,encoding:'base64',data:chunk.data});
  };
  packet('begin',{projectId:payload.projectId,assetId:payload.assetId,revisionId:payload.revisionId,sourceSha256:payload.sourceSha256,origin:payload.origin,identityScheme:payload.identityScheme,
    preparedDigest:plan.digest,target:manifest.target,conversionRequest:payload.conversionRequest,conversionRequestDigest:requestDigest,
    graph:{schemaVersion:1,sourceSceneIndex:graph.sourceSceneIndex,nodeCount:graph.nodes.length,meshCount:graph.meshes.length,digest:graph.digest},
    producer:payload.producer,files:payload.files,sourceDocuments:payload.sourceDocuments,conversion:payload.conversion,placement:payload.placement,bounds:payload.bounds,anchors:payload.anchors,
    objectCount:payload.objects.length,textureCount:payload.textures?.length??0,texturesPresent:Object.hasOwn(payload,'textures'),binaryByteLength:payload.binaryByteLength,aggregateEncodedByteLength:payload.aggregateEncodedByteLength,chunkCount:payload.chunkCount,
    delta:plan.delta});
  for(const node of parentFirst(graph.nodes))packet('node',{node});
  for(const texture of payload.textures??[]){const {bytes:_bytes,chunks:_chunks,source:_source,...metadata}=texture;
    const sourceObjectId='texture-'+texture.imageId,descriptor=describe(texture,sourceObjectId,-1);packet('texture',{texture:{...metadata,stream:descriptor}});chunks(texture,sourceObjectId,-1,descriptor.streamId);
  }
  for(const entry of payload.objects){const streams:{streamId:string;primitiveIndex:number;stream:StudioImportPayloadBuffer}[]=[];
    const primitives=entry.primitives.map((primitive,primitiveIndex)=>{
      const describePrimitive=(stream:StudioImportPayloadBuffer)=>{const descriptor=describe(stream,entry.object.sourceObjectId,primitiveIndex);streams.push({streamId:descriptor.streamId,primitiveIndex,stream});return descriptor;};
      return {mode:primitive.mode,vertexCount:primitive.vertexCount,triangleCount:primitive.triangleCount,source:primitive.source,correspondence:primitive.correspondence,
        attributes:Object.fromEntries(Object.entries(primitive.attributes).map(([name,stream])=>[name,describePrimitive(stream!)])),indices:describePrimitive(primitive.indices)};
    });
    packet('object',{object:entry.object,association:entry.association,material:entry.material,provenance:entry.provenance,primitives,...(entry.textureBindings?{textureBindings:entry.textureBindings}:{})});
    for(const stream of streams)chunks(stream.stream,entry.object.sourceObjectId,stream.primitiveIndex,stream.streamId);
  }
  const contentDigest=sha(packets.map(p=>[p.ordinal,p.kind,p.byteLength,p.sha256].join(':')).join('\n'));
  packet('seal',{precedingPacketCount:packets.length,precedingByteLength:byteLength,contentDigest});
  const digest=sha(packets.map(p=>p.sha256).join('\n'));
  const transfer=Object.freeze({formatVersion:2 as const,engineVerification:'pending' as const,preparedDigest:plan.digest,payloadDigest:payload.digest,digest,packets:Object.freeze(packets),byteLength,
    graphDigest:graph.digest,nodeCount:graph.nodes.length,conversionRequestDigest:requestDigest});
  inspectConvertedStudioImportTransfer(transfer);return transfer;
}

export interface MeasuredStudioImportTransferArguments {
  readonly arguments:readonly StudioAssetStageArgs[];readonly byteLengths:readonly number[];readonly byteLength:number;readonly digest:string;
}
/** Host preflight data only, before any durable claim or resource allocation.
 * A serialized transfer cannot recover same-process decoded-data provenance. */
export function measureStudioImportTransferArguments(transfer:StudioImportTransfer,target:StudioAssetStageArgs['target'],continuity:StudioAssetStageArgs['continuity']):MeasuredStudioImportTransferArguments {
  const expectedTarget=transfer&&typeof transfer==='object'?transferTargets.get(transfer):undefined;
  if(!expectedTarget)fail('IDENTITY','Expected a transfer created from decoded data in this process.');
  const plain=(value:unknown,keys:readonly string[])=>{
    if(!value||typeof value!=='object'||types.isProxy(value)||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail('IDENTITY','Expected fixed host context data.');
    const own=Reflect.ownKeys(value);if(own.length!==keys.length||own.some(key=>typeof key!=='string'||!keys.includes(key)))fail('IDENTITY','Unexpected host context field.');
    const out:Record<string,unknown>={};for(const key of keys){const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!Object.hasOwn(d,'value')||!d.enumerable)fail('IDENTITY','Host context accessors are not data.');out[key]=d.value;}return out;
  };
  const t=plain(target,['sessionId','placeId','universeId','root','parentRef','creator']),creator=plain(t.creator,['kind','id']),c=plain(continuity,['clientLifetimeId','pluginArtifactHash','playEpoch']);
  if(typeof t.sessionId!=='string'||t.sessionId.length>256||typeof t.parentRef!=='string'||t.parentRef.length>256||t.root!=='Workspace'||typeof t.placeId!=='number'||!Number.isSafeInteger(t.placeId)||t.placeId<0||typeof t.universeId!=='number'||!Number.isSafeInteger(t.universeId)||t.universeId<0||creator.kind!=='user'&&creator.kind!=='group'||typeof creator.id!=='string'||!/^\d{1,20}(?![\s\S])/.test(creator.id)||canonical({...t,creator})!==canonical(expectedTarget)||typeof c.clientLifetimeId!=='string'||!c.clientLifetimeId.length||c.clientLifetimeId.length>256||typeof c.pluginArtifactHash!=='string'||!hashPattern.test(c.pluginArtifactHash)||typeof c.playEpoch!=='number'||!Number.isSafeInteger(c.playEpoch)||c.playEpoch<0)fail('IDENTITY','Transfer target or continuity differs from bounded host context.');
  const argumentsList:StudioAssetStageArgs[]=[],sizes:number[]=[];let total=0;
  for(const packet of transfer.packets){const json=JSON.stringify({expected:{digest:transfer.digest,payloadDigest:transfer.payloadDigest,manifestDigest:JSON.parse(packet.json).manifestDigest},packet:packet.json,target:{...t,creator},continuity:c}),size=Buffer.byteLength(json);
    if(size>STUDIO_ASSET_TRANSFER_LIMITS.packetBytes||total+size>STUDIO_ASSET_TRANSFER_LIMITS.envelopeBytes||argumentsList.length>=STUDIO_ASSET_TRANSFER_LIMITS.packets||transfer.byteLength>STUDIO_ASSET_TRANSFER_LIMITS.rawBytes)fail('BUDGET','Complete escaped staging arguments exceed bridge limits before admission.');
    const args=JSON.parse(json) as StudioAssetStageArgs;Object.freeze(args.expected);Object.freeze(args.target.creator);Object.freeze(args.target);Object.freeze(args.continuity);Object.freeze(args);argumentsList.push(args);sizes.push(size);total+=size;
  }
  return Object.freeze({arguments:Object.freeze(argumentsList),byteLengths:Object.freeze(sizes),byteLength:total,digest:sha(argumentsList.map(args=>sha(JSON.stringify(args))).join('\n'))});
}
/** Read-only, digest-checked metadata reconstruction for durable readers. This
 * does not register decoded payload/transfer provenance or permit replay. */
export function inspectConvertedStudioImportTransfer(input:unknown):Readonly<{graph:ReturnType<typeof parseConvertedGraph>;payloadDigest:string;conversionRequestDigest:string;payload:Readonly<Record<string,unknown>>;begin:Readonly<Record<string,unknown>>}> {
  const transfer=fixed(input,['formatVersion','engineVerification','preparedDigest','payloadDigest','digest','packets','byteLength','graphDigest','nodeCount','conversionRequestDigest']);
  for(const key of ['preparedDigest','payloadDigest','digest','graphDigest','conversionRequestDigest']){const value=transfer[key];if(typeof value!=='string'||!hashPattern.test(value))fail('IDENTITY','Converted transfer identity must use canonical SHA-256.');}
  if(transfer.formatVersion!==2||transfer.engineVerification!=='pending'||!Array.isArray(transfer.packets)||types.isProxy(transfer.packets)||Object.getPrototypeOf(transfer.packets)!==Array.prototype||!transfer.packets.length||transfer.packets.length>STUDIO_ASSET_TRANSFER_LIMITS.packets||Reflect.ownKeys(transfer.packets).length!==transfer.packets.length+1)fail('IDENTITY','Converted transfer version or packet inventory is invalid.');
  const packets:{ordinal:number;kind:string;json:string;byteLength:number;sha256:string;body:Readonly<Record<string,unknown>>}[]=[];let rawBytes=0;
  for(let i=0;i<transfer.packets.length;i++){
    const d=Object.getOwnPropertyDescriptor(transfer.packets,i);if(!d||!Object.hasOwn(d,'value')||!d.enumerable)fail('IDENTITY','Converted packet inventory must be dense data.');
    const p=fixed(d.value,['ordinal','kind','json','byteLength','sha256']),body=parseConvertedStudioImportTransferPacket(p.json);
    if(typeof p.json!=='string'||p.ordinal!==i||p.kind!==body.kind||body.ordinal!==i||p.byteLength!==Buffer.byteLength(p.json)||p.sha256!==sha(p.json)||body.payloadDigest!==transfer.payloadDigest)fail('CHECKSUM','Converted packet bytes, ordinal or payload binding changed.');
    rawBytes+=p.byteLength as number;if(rawBytes>STUDIO_ASSET_TRANSFER_LIMITS.rawBytes)fail('BUDGET','Converted raw transfer exceeds its aggregate bound.');
    packets.push({ordinal:i,kind:p.kind as string,json:p.json,byteLength:p.byteLength as number,sha256:p.sha256 as string,body});
  }
  if(rawBytes!==transfer.byteLength||sha(packets.map(p=>p.sha256).join('\n'))!==transfer.digest)fail('CHECKSUM','Converted transfer byte chain changed.');
  const begin=packets[0]!.body,seal=packets.at(-1)!.body,preceding=packets.slice(0,-1);
  if(begin.kind!=='begin'||seal.kind!=='seal'||seal.precedingPacketCount!==preceding.length||seal.precedingByteLength!==preceding.reduce((n,p)=>n+p.byteLength,0)||seal.contentDigest!==sha(preceding.map(p=>[p.ordinal,p.kind,p.byteLength,p.sha256].join(':')).join('\n'))||packets.some(p=>p.body.manifestDigest!==begin.manifestDigest)||begin.preparedDigest!==transfer.preparedDigest)fail('CHECKSUM','Converted begin/seal metadata does not close its exact byte chain.');
  const header=fixed(begin.graph,['schemaVersion','sourceSceneIndex','nodeCount','meshCount','digest']);
  if(header.schemaVersion!==1||typeof header.nodeCount!=='number'||!Number.isSafeInteger(header.nodeCount)||header.nodeCount<1||header.nodeCount>128||header.nodeCount!==transfer.nodeCount||header.digest!==transfer.graphDigest)fail('IDENTITY','Converted graph header is incomplete or over budget.');
  let at=1;const nodes:unknown[]=[],meshes:unknown[]=[],objects:unknown[]=[],textures:unknown[]=[];
  while(packets[at]?.kind==='node'){nodes.push(packets[at++]!.body.node);}
  if(nodes.length!==header.nodeCount)fail('IDENTITY','Converted node phase omitted or duplicated a selected node.');
  const streamIds=new Set<string>();let decodedBytes=0,encodedBytes=0,chunkCount=0;
  const stream=(input:unknown,objectId:string,primitiveIndex:number):Record<string,unknown>=>{
    const d=fixed(input,['streamId','semantic','componentType','type','count','normalized','byteLength','sha256','source','chunks']);
    if(d.streamId!==sha([objectId,String(primitiveIndex),String(d.semantic)].join('\0'))||streamIds.has(d.streamId as string)||!Array.isArray(d.chunks)||!d.chunks.length)fail('IDENTITY','Converted stream identity is duplicate or invalid.');streamIds.add(d.streamId as string);
    const chunks:unknown[]=[],digest=createHash('sha256');let offset=0;
    for(const declared of d.chunks){const descriptor=fixed(declared,['offset','byteLength','sha256']),p=packets[at++];
      if(!p||p.kind!=='chunk')fail('IDENTITY','Converted chunks are missing or reordered.');const c=p.body;
      if(typeof c.data!=='string'||c.encoding!=='base64'||c.sourceObjectId!==objectId||c.primitiveIndex!==primitiveIndex||c.streamId!==d.streamId||c.semantic!==d.semantic||c.bufferSha256!==d.sha256||c.offset!==offset)fail('IDENTITY','Converted chunk belongs to another stream or offset.');
      const bytes=Buffer.from(c.data,'base64');if(bytes.toString('base64')!==c.data||c.byteLength!==bytes.length||c.sha256!==sha(bytes)||descriptor.offset!==offset||descriptor.byteLength!==c.byteLength||descriptor.sha256!==c.sha256)fail('CHECKSUM','Converted stream chunk bytes disagree with their declaration.');
      digest.update(bytes);offset+=bytes.length;decodedBytes+=bytes.length;encodedBytes+=Buffer.byteLength(c.data);chunkCount++;
      if(decodedBytes>32*1024*1024||encodedBytes>48*1024*1024||chunkCount>4096)fail('BUDGET','Converted decoded streams exceed payload bounds.');
      chunks.push({formatVersion:2,manifestDigest:begin.manifestDigest,sourceObjectId:objectId,primitiveIndex,semantic:d.semantic,bufferSha256:d.sha256,offset:c.offset,byteLength:c.byteLength,sha256:c.sha256,encoding:'base64',data:c.data});
    }
    if(offset!==d.byteLength||digest.digest('hex')!==d.sha256)fail('CHECKSUM','Converted immutable stream digest changed.');
    return {semantic:d.semantic,componentType:d.componentType,type:d.type,count:d.count,normalized:d.normalized,byteLength:d.byteLength,sha256:d.sha256,bytes:{byteLength:d.byteLength,sha256:d.sha256},source:d.source,chunks};
  };
  while(packets[at]?.kind==='texture'){
    const raw=packets[at++]!.body.texture;if(!raw||typeof raw!=='object'||Array.isArray(raw))fail('IDENTITY','Invalid converted texture declaration.');
    const {stream:descriptor,...metadata}=raw as Record<string,unknown>;textures.push({...metadata,...stream(descriptor,'texture-'+String(metadata.imageId),-1)});
  }
  while(packets[at]?.kind==='object'){
    const row=packets[at++]!.body,object=row.object as Record<string,unknown>;
    if(!object||typeof object.sourceObjectId!=='string'||!Array.isArray(row.primitives))fail('IDENTITY','Invalid converted object declaration.');
    const pending:{input:unknown;semantic:string;primitiveIndex:number;assign(value:Record<string,unknown>):void}[]=[],primitives:Record<string,unknown>[]=[];
    for(const [primitiveIndex,raw]of row.primitives.entries()){
      const p=fixed(raw,['mode','vertexCount','triangleCount','source','correspondence','attributes','indices']);
      if(!p.attributes||typeof p.attributes!=='object'||Array.isArray(p.attributes))fail('IDENTITY','Invalid converted primitive attributes.');
      const attributes:Record<string,unknown>={},result={mode:p.mode,vertexCount:p.vertexCount,triangleCount:p.triangleCount,source:p.source,correspondence:p.correspondence,attributes,indices:null as unknown};
      for(const [semantic,input]of Object.entries(p.attributes)){if(!['POSITION','NORMAL','TEXCOORD_0'].includes(semantic))fail('IDENTITY','Unsupported converted authoring stream.');pending.push({input,semantic,primitiveIndex,assign(value){attributes[semantic]=value;}});}
      pending.push({input:p.indices,semantic:'indices',primitiveIndex,assign(value){result.indices=value;}});primitives.push(result);
    }
    for(const p of pending){const decoded=stream(p.input,object.sourceObjectId,p.primitiveIndex);if(decoded.semantic!==p.semantic)fail('IDENTITY','Converted attribute semantic changed.');p.assign(decoded);}
    meshes.push(row.association);objects.push({object,association:row.association,material:row.material,provenance:row.provenance,primitives,...(Object.hasOwn(row,'textureBindings')?{textureBindings:row.textureBindings}:{})});
  }
  if(at!==packets.length-1||objects.length!==begin.objectCount||textures.length!==begin.textureCount||meshes.length!==header.meshCount||typeof begin.texturesPresent!=='boolean'||!begin.texturesPresent&&textures.length)fail('IDENTITY','Converted transfer phases or complete counts disagree.');
  const graph=parseConvertedGraph({schemaVersion:1,sourceSceneIndex:header.sourceSceneIndex,nodes,meshes,digest:header.digest});
  if(canonical(nodes)!==canonical(parentFirst(graph.nodes)))fail('IDENTITY','Converted graph order is not deterministic parent-before-child.');
  assertConvertedStudioImportRepresentable(graph,objects.map(row=>(row as {object:ConvertedPreparedStudioImportV2['manifest']['objects'][number]}).object));
  const totals=(objects as {primitives:{vertexCount:unknown;triangleCount:unknown}[]}[]).flatMap(row=>row.primitives).reduce((sum,p)=>{
    if(typeof p.vertexCount!=='number'||!Number.isSafeInteger(p.vertexCount)||p.vertexCount<3||typeof p.triangleCount!=='number'||!Number.isSafeInteger(p.triangleCount)||p.triangleCount<1)fail('IDENTITY','Converted native geometry counts are invalid.');
    return {vertices:sum.vertices+p.vertexCount,triangles:sum.triangles+p.triangleCount};
  },{vertices:0,triangles:0});
  if(totals.vertices>120000||totals.triangles>40000)fail('BUDGET','Converted native geometry exceeds reconstruction bounds.');
  const request=parseConvertedGlbRequest(begin.conversionRequest),requestDigest=sha(canonical(request));
  let collisionObjects=0;
  for(const row of objects as {object:Record<string,unknown>;association:unknown}[]){const object=row.object;
    if(object.role!=='render'&&object.role!=='collision'||typeof object.sourceKey!=='string'||object.sourceObjectId!==convertedGlbObjectId(request.sourceSha256,object.role,object.sourceKey))fail('IDENTITY','Converted object ID is not derived from its retained source role and key.');
    const association=graph.meshes.find(mesh=>mesh.sourceObjectId===object.sourceObjectId);
    if(!association||canonical(association)!==canonical(row.association)||canonical(object.pivot)!==canonical(association.sourcePivot)||association.nodeKey!==(object.role==='collision'?null:object.sourceKey))fail('IDENTITY','Converted source object does not retain its exact graph association.');
    if(object.role==='collision')collisionObjects++;
  }
  if(collisionObjects!==(request.collision==='convex-hull'?1:0))fail('IDENTITY','Converted collision inventory differs from its sealed request.');
  const renderIds=(objects as {object:Record<string,unknown>}[]).filter(row=>row.object.role==='render').map(row=>row.object.sourceObjectId as string).sort();
  for(const row of objects as {object:Record<string,unknown>}[])if(canonical(row.object.collisionFor)!==canonical(row.object.role==='collision'?renderIds:[]))fail('IDENTITY','Converted collision targets differ from the exact derived render objects.');
  if(typeof begin.projectId!=='string'||!hashPattern.test(begin.projectId)||begin.origin!=='converted-glb'||begin.identityScheme!=='arcane-converted-v2'||requestDigest!==begin.conversionRequestDigest||requestDigest!==transfer.conversionRequestDigest||request.jobId!==begin.revisionId||request.sourceSha256!==begin.sourceSha256||convertedGlbAssetId(request.sourceSha256)!==begin.assetId)fail('IDENTITY','Converted request and source identity changed.');
  if(decodedBytes!==begin.binaryByteLength||chunkCount!==begin.chunkCount)fail('CHECKSUM','Converted reconstructed payload counts disagree.');
  const payload={formatVersion:2,engineVerification:'pending',preparedDigest:begin.preparedDigest,manifestDigest:begin.manifestDigest,projectId:begin.projectId,assetId:begin.assetId,revisionId:begin.revisionId,sourceSha256:begin.sourceSha256,
    origin:begin.origin,identityScheme:begin.identityScheme,conversionRequest:request,graph,producer:begin.producer,files:begin.files,conversion:begin.conversion,placement:begin.placement,bounds:begin.bounds,anchors:begin.anchors,sourceDocuments:begin.sourceDocuments,
    objects,...(begin.texturesPresent?{textures}:{}),binaryByteLength:begin.binaryByteLength,aggregateEncodedByteLength:begin.aggregateEncodedByteLength,chunkCount:begin.chunkCount};
  const payloadDigest=sha(canonical(payload));if(payloadDigest!==transfer.payloadDigest)fail('CHECKSUM','Converted packet metadata does not reconstruct the exact sealed payload digest.');
  return frozen({graph,payloadDigest,conversionRequestDigest:requestDigest,payload,begin});
}
export interface GeneratedStudioImportTransferV1 {
  readonly formatVersion: 1;
  readonly engineVerification: 'pending';
  readonly preparedDigest: string;
  readonly payloadDigest: string;
  readonly digest: string;
  readonly packets: readonly GeneratedStudioImportTransferPacketV1[];
  readonly byteLength: number;
}
export interface ConvertedStudioImportTransferPacketV2 extends Omit<GeneratedStudioImportTransferPacketV1,'kind'> {readonly kind:'begin'|'node'|'texture'|'object'|'chunk'|'seal'}
export interface ConvertedStudioImportTransferV2 extends Omit<GeneratedStudioImportTransferV1,'formatVersion'|'packets'> {
  readonly formatVersion:2;readonly graphDigest:string;readonly nodeCount:number;readonly conversionRequestDigest:string;
  readonly packets:readonly ConvertedStudioImportTransferPacketV2[];
}
export type StudioImportTransferPacket=GeneratedStudioImportTransferPacketV1|ConvertedStudioImportTransferPacketV2;
export type StudioImportTransfer=GeneratedStudioImportTransferV1|ConvertedStudioImportTransferV2;
const transferTargets=new WeakMap<object,StudioAssetStageArgs['target']>();
export class StudioImportTransferError extends Error {
  constructor(public readonly code: 'IDENTITY' | 'CHECKSUM' | 'BUDGET', message: string) {super(message); this.name = 'StudioImportTransferError';}
}
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function fail(code: StudioImportTransferError['code'], message: string): never {throw new StudioImportTransferError(code, message);}

/** Packages immutable decoded chunks, not mutable convenience buffer copies.
 * Same-actor/job/target checks still belong to the AssetService and executor.
 * No dispatch callback exists here; these packets authorize no side effects. */
export function createStudioImportTransfer(prepared:GeneratedPreparedStudioImportV1,payload:GeneratedStudioImportPayloadV1):GeneratedStudioImportTransferV1;
export function createStudioImportTransfer(prepared:ConvertedPreparedStudioImportV2,payload:ConvertedStudioImportPayloadV2):ConvertedStudioImportTransferV2;
export function createStudioImportTransfer(prepared:PreparedStudioImport,payload:StudioImportPayload):StudioImportTransfer;
export function createStudioImportTransfer(prepared:PreparedStudioImport,payload:StudioImportPayload):StudioImportTransfer {
  assertDecodedStudioImportPayload(payload);
  const transfer=payload.formatVersion===2?createConvertedTransfer(prepared,payload):createGeneratedTransfer(prepared,payload);
  transferTargets.set(transfer,frozen(JSON.parse(transfer.packets[0]!.json).target as StudioAssetStageArgs['target']));return transfer;
}
function createGeneratedTransfer(prepared:PreparedStudioImport,payload:GeneratedStudioImportPayloadV1):GeneratedStudioImportTransferV1 {
  assertDecodedStudioImportPayload(payload);
  const plan = parseNativeStudioImportResponse({prepared}, payload.revisionId).prepared;
  const manifest = plan.manifest;
  if(manifest.schemaVersion!==1)fail('IDENTITY','Generated payload requires version-one preparation.');
  if (payload.preparedDigest !== plan.digest || payload.manifestDigest !== manifest.digest ||
      payload.projectId !== manifest.projectId || payload.assetId !== manifest.assetId || payload.revisionId !== manifest.revisionId) {
    fail('IDENTITY', 'Payload and preparation belong to different revisions.');
  }
  const packets: GeneratedStudioImportTransferPacketV1[] = [];
  let byteLength = 0;
  const packet = (kind: GeneratedStudioImportTransferPacketV1['kind'], body: Record<string, unknown>) => {
    const ordinal = packets.length;
    const json = JSON.stringify({formatVersion: 1, payloadDigest: payload.digest, manifestDigest: manifest.digest, ordinal, kind, ...body});
    const bytes = Buffer.byteLength(json);
    if (bytes > STUDIO_IMPORT_TRANSFER_LIMITS.argumentBytes || ordinal >= STUDIO_IMPORT_TRANSFER_LIMITS.packets ||
        byteLength + bytes > STUDIO_IMPORT_TRANSFER_LIMITS.totalBytes) fail('BUDGET', 'Actual serialized transfer exceeds bridge limits.');
    packets.push(Object.freeze({ordinal, kind, json, byteLength: bytes, sha256: sha(json)}));
    byteLength += bytes;
  };
  const describe = (stream: StudioImportPayloadBuffer, sourceObjectId: string, primitiveIndex: number) => {
    const streamId = sha([sourceObjectId, String(primitiveIndex), stream.semantic].join('\0'));
    let offset = 0; const digest = createHash('sha256');
    for (const chunk of stream.chunks) {
      const bytes = Buffer.from(chunk.data, 'base64');
      if (chunk.sourceObjectId !== sourceObjectId || chunk.primitiveIndex !== primitiveIndex || chunk.semantic !== stream.semantic ||
          chunk.manifestDigest !== manifest.digest || chunk.bufferSha256 !== stream.sha256 || chunk.offset !== offset ||
          chunk.byteLength !== bytes.length || sha(bytes) !== chunk.sha256 || bytes.toString('base64') !== chunk.data)
        fail('CHECKSUM', 'Decoded stream chunks are incomplete or changed.');
      digest.update(bytes); offset += bytes.length;
    }
    if (offset !== stream.byteLength || digest.digest('hex') !== stream.sha256) fail('CHECKSUM', 'Decoded stream digest differs from its immutable chunks.');
    return {streamId, semantic: stream.semantic, componentType: stream.componentType, type: stream.type, count: stream.count,
      normalized: stream.normalized, byteLength: stream.byteLength, sha256: stream.sha256,
      chunks: stream.chunks.map(c => ({offset: c.offset, byteLength: c.byteLength, sha256: c.sha256}))};
  };
  const sendChunks = (stream: StudioImportPayloadBuffer, sourceObjectId: string, primitiveIndex: number, streamId: string) => {
    for (const chunk of stream.chunks) packet('chunk', {sourceObjectId, primitiveIndex, streamId, semantic: stream.semantic,
      bufferSha256: stream.sha256, offset: chunk.offset, byteLength: chunk.byteLength, sha256: chunk.sha256, encoding: 'base64', data: chunk.data});
  };
  packet('begin', {projectId: manifest.projectId, assetId: manifest.assetId, revisionId: manifest.revisionId,
    preparedDigest: plan.digest, target: manifest.target, conversion: manifest.conversion, placement: manifest.placement,
    bounds: manifest.bounds, anchors: manifest.anchors, objectCount: payload.objects.length,
    preservation: plan.delta.preservation, previousDigest: plan.delta.previousDigest,
    ...(payload.textures?.length ? {textureCount: payload.textures.length} : {})});
  for (const texture of payload.textures ?? []) {
    const {bytes: _bytes, chunks: _chunks, source: _source, ...metadata} = texture;
    const sourceObjectId = 'texture-' + texture.imageId, descriptor = describe(texture, sourceObjectId, -1);
    packet('texture', {texture: {...metadata, stream: descriptor}});
    sendChunks(texture, sourceObjectId, -1, descriptor.streamId);
  }
  for (const entry of payload.objects) {
    const streams: {streamId: string; primitiveIndex: number; stream: StudioImportPayloadBuffer}[] = [];
    const primitives = entry.primitives.map((primitive, primitiveIndex) => {
      const describePrimitive = (stream: StudioImportPayloadBuffer) => {
        const descriptor = describe(stream, entry.object.sourceObjectId, primitiveIndex);
        streams.push({streamId: descriptor.streamId, primitiveIndex, stream}); return descriptor;
      };
      return {mode: primitive.mode, vertexCount: primitive.vertexCount, triangleCount: primitive.triangleCount,
        attributes: Object.fromEntries(Object.entries(primitive.attributes).map(([name, stream]) => [name, describePrimitive(stream!)])),
        indices: describePrimitive(primitive.indices)};
    });
    packet('object', {object: entry.object, material: entry.material, primitives, ...(entry.textureBindings ? {textureBindings: entry.textureBindings} : {})});
    for (const {streamId, primitiveIndex, stream} of streams) sendChunks(stream, entry.object.sourceObjectId, primitiveIndex, streamId);
  }
  const contentDigest = sha(packets.map(p => [p.ordinal, p.kind, p.byteLength, p.sha256].join(':')).join('\n'));
  packet('seal', {precedingPacketCount: packets.length, precedingByteLength: byteLength, contentDigest});
  const digest = sha(packets.map(p => p.sha256).join('\n'));
  return Object.freeze({formatVersion: 1, engineVerification: 'pending', preparedDigest: plan.digest,
    payloadDigest: payload.digest, digest, packets: Object.freeze(packets), byteLength});
}
