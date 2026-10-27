import {parseStudioImportObservationWitness} from '../../core/src/studio-policy.js';
import {createHash} from 'node:crypto';
import {types} from 'node:util';
import {z} from 'zod';
import {ArcaneError} from '../../protocol/src/providers.js';
import {STUDIO_IMPORT_LIMITS,parseConvertedStudioImportManifest,studioImportObservationReceiptDigest,type PreparedStudioImport,type ConvertedPreparedStudioImportV2} from './studio-import-manifest.js';
import {convertedGlbObjectId} from './converted-glb.js';
const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}(?![\s\S])/;
function fail(code:string):never {throw new ArcaneError(code,'Native chat asset request refused.');}
// The native route and MCP client share this data-only wire gate. It cannot
// admit files, select a target, load a baseline or grant Studio write consent.
export const NATIVE_STUDIO_IMPORT_RESPONSE_BYTES=STUDIO_IMPORT_LIMITS.manifestBytes+13; // {"prepared":...}
const importId=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}(?![\s\S])/);
const importHash=z.string().regex(/^[a-f0-9]{64}(?![\s\S])/);
const importAssetId=z.string().regex(/^[1-9][0-9]{0,19}(?![\s\S])/);
const importNumber=z.number().finite().min(-1_000_000).max(1_000_000);
const importVector=z.tuple([importNumber,importNumber,importNumber]);
const importIndex=z.number().int().nonnegative().max(4095);
const importMatrix=z.array(importNumber).length(16).refine(m=>m[3]===0&&m[7]===0&&m[11]===0&&m[15]===1);
const importBounds=z.strictObject({min:importVector,max:importVector}).refine(b=>
 b.min.every((n,i)=>n<=b.max[i]!)&&b.min.filter((n,i)=>n<b.max[i]!).length>=2);
const importTextureUse=z.strictObject({sha256:importHash,channel:z.enum(['rgba','rgb','g','b']),texCoord:z.literal(0)});
const importChild=z.strictObject({instanceRef:importId,kind:z.enum(['script','attachment','constraint']),stateSha256:importHash});
const importMapping={sourceObjectId:importId,instanceRef:importId,meshAssetId:importAssetId,ownedStateSha256:importHash,
 authoredChildren:z.array(importChild).max(128)};
const importCFrame=z.array(importNumber).length(12).refine(m=>{
 const r=m.slice(3),row=(i:number)=>r.slice(i*3,i*3+3);
 return [0,1,2].every(i=>Math.abs(Math.hypot(...row(i))-1)<1e-6)&&[[0,1],[0,2],[1,2]].every(([a,b])=>
  Math.abs(row(a!).reduce((s,n,i)=>s+n*row(b!)[i]!,0))<1e-6)&&
  Math.abs(r[0]!*(r[4]!*r[8]!-r[5]!*r[7]!)-r[1]!*(r[3]!*r[8]!-r[5]!*r[6]!)+r[2]!*(r[3]!*r[7]!-r[4]!*r[6]!)-1)<1e-6;
});
const importResources=z.strictObject({prepare:z.array(importHash).max(128),reuse:z.array(importHash).max(128)});
const importResponse=z.strictObject({prepared:z.strictObject({status:z.literal('prepared'),digest:importHash,
 manifest:z.strictObject({schemaVersion:z.literal(1),status:z.literal('prepared'),engineVerification:z.literal('pending'),
  projectId:importHash,assetId:importId,revisionId:z.string().length(36).regex(UUID),sourceSha256:importHash,
  producer:z.strictObject({blenderVersion:z.string().regex(/^[A-Za-z0-9 .+_-]{1,128}(?![\s\S])/),exporterVersion:z.string().regex(/^[A-Za-z0-9 .+_-]{1,128}(?![\s\S])/)}),
  target:z.strictObject({sessionId:importId,placeId:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
   universeId:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),root:z.literal('Workspace'),parentRef:importId,
   creator:z.strictObject({kind:z.enum(['user','group']),id:importAssetId})}),
  placement:z.discriminatedUnion('mode',[
   z.strictObject({mode:z.literal('origin')}),z.strictObject({mode:z.literal('bottom-centre')}),
   z.strictObject({mode:z.literal('custom-anchor'),anchorId:importId}),
   z.strictObject({mode:z.literal('selected-attachment'),attachmentRef:importId,expectedStateSha256:importHash}),
   z.strictObject({mode:z.literal('cframe'),value:importCFrame})]),
  conversion:z.strictObject({sourceUnits:z.literal('meters'),sourceUp:z.literal('Z'),exportUnits:z.literal('meters'),exportUp:z.literal('Y'),
   targetUnits:z.literal('studs'),targetUp:z.literal('Y'),studsPerMeter:z.number().positive().max(1000)}),
  files:z.array(z.strictObject({fileId:importId,contentType:z.enum(['model/gltf-binary','model/gltf+json','application/octet-stream','image/png','image/jpeg']),
   sha256:importHash,byteLength:z.number().int().positive().max(STUDIO_IMPORT_LIMITS.fileBytes)})).min(1).max(32),
  objects:z.array(z.strictObject({sourceObjectId:importId,name:z.string().min(1).max(256),role:z.enum(['render','collision']),parentSourceObjectId:importId.nullable(),
   exportFileId:importId,nodeIndex:importIndex,meshExportSha256:importHash,triangles:z.number().int().positive().max(STUDIO_IMPORT_LIMITS.meshTriangles),
   materialSha256:importHash.nullable(),textureSha256s:z.array(importHash).max(4),exportTransform:importMatrix,scale:importVector,pivot:importVector,
   bounds:importBounds,worldBounds:importBounds,collisionFor:z.array(importId).max(128)}).refine(o=>o.role!=='collision'||
    [o.bounds,o.worldBounds].every(b=>b.min.every((n,i)=>n<b.max[i]!)))).min(1).max(128),
  materials:z.array(z.strictObject({sha256:importHash,baseColor:z.tuple([importNumber,importNumber,importNumber,importNumber]),
   metallic:z.number().min(0).max(1),roughness:z.number().min(0).max(1),alphaMode:z.enum(['OPAQUE','MASK','BLEND']),alphaCutoff:z.number().min(0).max(1),
   doubleSided:z.boolean(),normalScale:importNumber,colorMap:importTextureUse.nullable(),normalMap:importTextureUse.nullable(),
   roughnessMap:importTextureUse.nullable(),metalnessMap:importTextureUse.nullable(),
   emission:z.strictObject({factor:z.tuple([z.number().min(0).max(1),z.number().min(0).max(1),z.number().min(0).max(1)]),
    strength:z.number().min(0).max(1000),map:importTextureUse.nullable()}).optional()})).max(64),
  textures:z.array(z.strictObject({sha256:importHash,byteLength:z.number().int().positive().max(STUDIO_IMPORT_LIMITS.fileBytes),
   width:z.number().int().positive().max(STUDIO_IMPORT_LIMITS.textureDimension),height:z.number().int().positive().max(STUDIO_IMPORT_LIMITS.textureDimension),
   contentType:z.enum(['image/png','image/jpeg']),locations:z.array(z.strictObject({fileId:importId,imageIndex:importIndex})).min(1).max(128)})).max(64),
  anchors:z.array(z.strictObject({sourceAnchorId:importId,sourceObjectId:importId,kind:z.enum(['socket','attachment']),transform:importMatrix})).max(128),
  bounds:importBounds,limitations:z.array(z.string().max(256)).max(8),digest:importHash}),
 delta:z.strictObject({previousDigest:importHash.nullable(),nextDigest:importHash,receiptSha256:importHash.nullable(),modelRef:importId.nullable(),modelAssetId:importAssetId.nullable(),
  placementChanged:z.boolean(),objects:z.array(z.strictObject({sourceObjectId:importId,action:z.enum(['create','update-in-place','reuse']),
   changed:z.array(z.enum(['geometry','material','textures','transform','collision','identity'])).max(6),instanceRef:importId.nullable(),meshAssetId:importAssetId.nullable(),
   expectedOwnedStateSha256:importHash.nullable(),preserveChildren:z.array(importChild).max(128),replaceInstance:z.literal(false),deleteInstance:z.literal(false)})).min(1).max(128),
  reviewRemovals:z.array(z.strictObject({...importMapping,action:z.literal('retain-for-review')})).max(128),reviewAnchors:z.array(importId).max(256),
  geometry:importResources,textures:importResources,preservation:z.literal('preserve-all-scripts-attachments-constraints')})})});
const importNodeKey=z.string().regex(/^node[0-9]{1,4}(?:_primitive[0-9]{1,4})?(?![\s\S])/);
const convertedDelta=importResponse.shape.prepared.shape.delta.extend({
 observation:z.unknown().transform(value=>value===null?null:parseStudioImportObservationWitness(value)),modelAssetId:z.null(),
 reviewRemovals:z.array(z.strictObject({...importMapping,meshAssetId:importAssetId.nullable(),action:z.literal('retain-for-review')})).max(128),
 graph:z.strictObject({previousDigest:importHash.nullable(),nextDigest:importHash,changed:z.boolean()}),
 nodes:z.array(z.strictObject({nodeKey:importNodeKey,action:z.enum(['create','update-in-place','reuse']),
  changed:z.array(z.enum(['parent','matrix','name','mesh','pivot'])).max(5),instanceRef:importId.nullable(),expectedOwnedStateSha256:importHash.nullable(),
  preserveChildren:z.array(importChild).max(128),replaceInstance:z.literal(false),deleteInstance:z.literal(false)})).min(1).max(4096),
 reviewNodeRemovals:z.array(z.strictObject({nodeKey:importNodeKey,instanceRef:importId,ownedStateSha256:importHash,authoredChildren:z.array(importChild).max(128),action:z.literal('retain-for-review')})).max(4096)});
const convertedResponse=z.strictObject({prepared:z.strictObject({status:z.literal('prepared'),digest:importHash,
 manifest:z.unknown().transform(value=>parseConvertedStudioImportManifest(value)),delta:convertedDelta})});
function convertedEnvelope(value:unknown):boolean {
 for(const key of ['prepared','manifest','schemaVersion']){
  if(!value||typeof value!=='object'||types.isProxy(value))return false;
  const descriptor=Object.getOwnPropertyDescriptor(value,key);if(!descriptor||!Object.hasOwn(descriptor,'value'))return false;value=descriptor.value as unknown;
 }return value===2;
}
function importSnapshot(value:unknown,converted=false):unknown {
 let nodes=0,bytes=0;const seen=new Set<object>();
 const walk=(v:unknown,depth:number):unknown=>{
  if(++nodes>(converted?200_000:60_000)||depth>16)fail('STUDIO_IMPORT_RESPONSE');
  if(v===null||typeof v==='boolean')return v;
  if(typeof v==='number'){if(!Number.isFinite(v))fail('STUDIO_IMPORT_RESPONSE');return v;}
  if(typeof v==='string'){bytes+=Buffer.byteLength(v);if(v.length>4096||bytes>NATIVE_STUDIO_IMPORT_RESPONSE_BYTES)fail('STUDIO_IMPORT_RESPONSE');return v;}
  if(!v||typeof v!=='object'||types.isProxy(v)||seen.has(v))fail('STUDIO_IMPORT_RESPONSE');
  const array=Array.isArray(v),prototype:unknown=Object.getPrototypeOf(v);
  if(converted&&array?prototype!==Array.prototype:prototype!==(array?Array.prototype:Object.prototype)&&prototype!==null)fail('STUDIO_IMPORT_RESPONSE');
  const keys=Reflect.ownKeys(v);if(keys.length>4097)fail('STUDIO_IMPORT_RESPONSE');
  const descriptors=Object.getOwnPropertyDescriptors(v),out:Record<string,unknown>=Object.create(null) as Record<string,unknown>;seen.add(v);
  for(const key of keys){
   if(array&&key==='length')continue;
   if(typeof key!=='string'||key.length>64||['__proto__','constructor','prototype'].includes(key))fail('STUDIO_IMPORT_RESPONSE');
   const d=descriptors[key]!;if(!Object.hasOwn(d,'value')||!d.enumerable)fail('STUDIO_IMPORT_RESPONSE');
   out[key]=walk(d.value as unknown,depth+1);
  }
  seen.delete(v);if(!array)return out;
  const length=descriptors.length!.value as number;
  if(length>4096||Object.keys(out).length!==length||Object.keys(out).some(k=>!/^(0|[1-9][0-9]*)$/.test(k)||Number(k)>=length))fail('STUDIO_IMPORT_RESPONSE');
  return Array.from({length},(_,i)=>out[String(i)]);
 };return walk(value,0);
}
function importCanonical(value:unknown):string {
 if(Array.isArray(value))return '['+value.map(importCanonical).join(',')+']';
 if(value!==null&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+importCanonical((value as Record<string,unknown>)[k])).join(',')+'}';
 return JSON.stringify(value);
}
const importDigest=(value:unknown)=>createHash('sha256').update(importCanonical(value)).digest('hex');
function convertedPreparedChecks(prepared:ConvertedPreparedStudioImportV2):void {
 const {manifest,delta}=prepared,initial=delta.previousDigest===null;
 if((delta.observation===null)!==initial||delta.modelAssetId!==null)fail('STUDIO_IMPORT_RESPONSE');
 if(delta.observation){
  const witness=delta.observation,before=witness.observation,source=before.source;
  const children=(values:typeof before.nodes[number]['authoredChildren'])=>[...values].sort((a,b)=>a.instanceRef<b.instanceRef?-1:a.instanceRef>b.instanceRef?1:0);
  if(witness.receiptSha256!==studioImportObservationReceiptDigest(before)||delta.receiptSha256!==witness.receiptSha256||delta.modelRef!==before.modelRef.instanceId||
   source.manifestDigest!==delta.previousDigest||source.graphDigest!==delta.graph.previousDigest||source.projectId!==manifest.projectId||source.assetId!==manifest.assetId||source.sourceSha256!==manifest.sourceSha256||importCanonical(before.target)!==importCanonical(manifest.target))fail('STUDIO_IMPORT_RESPONSE');
  for(const object of delta.objects){const mapped=before.objects.find(row=>row.sourceObjectId===object.sourceObjectId);
   if((mapped===undefined)!==(object.action==='create')||object.instanceRef!==(mapped?.instanceRef??null)||object.meshAssetId!==(mapped?.meshAssetId??null)||object.expectedOwnedStateSha256!==(mapped?.ownedStateSha256??null)||importCanonical(object.preserveChildren)!==importCanonical(children(mapped?.authoredChildren??[])))fail('STUDIO_IMPORT_RESPONSE');
  }
  for(const node of delta.nodes){const mapped=before.nodes.find(row=>row.nodeKey===node.nodeKey);
   if((mapped===undefined)!==(node.action==='create')||node.instanceRef!==(mapped?.instanceRef??null)||node.expectedOwnedStateSha256!==(mapped?.ownedStateSha256??null)||importCanonical(node.preserveChildren)!==importCanonical(children(mapped?.authoredChildren??[])))fail('STUDIO_IMPORT_RESPONSE');
  }
  const removedObjects=before.objects.filter(row=>!manifest.objects.some(object=>object.sourceObjectId===row.sourceObjectId)).map(row=>({...row,authoredChildren:children(row.authoredChildren),action:'retain-for-review'})).sort((a,b)=>a.sourceObjectId<b.sourceObjectId?-1:a.sourceObjectId>b.sourceObjectId?1:0);
  const removedNodes=before.nodes.filter(row=>!manifest.graph.nodes.some(node=>node.nodeKey===row.nodeKey)).map(row=>({...row,authoredChildren:children(row.authoredChildren),action:'retain-for-review'})).sort((a,b)=>a.nodeKey<b.nodeKey?-1:a.nodeKey>b.nodeKey?1:0);
  if(importCanonical(removedObjects)!==importCanonical(delta.reviewRemovals)||importCanonical(removedNodes)!==importCanonical(delta.reviewNodeRemovals))fail('STUDIO_IMPORT_RESPONSE');
 }
 const unique=(values:readonly string[])=>new Set(values).size===values.length;
 if(delta.graph.nextDigest!==manifest.graph.digest||(delta.graph.previousDigest===null)!==initial||
  delta.graph.changed!==(initial||delta.graph.previousDigest!==delta.graph.nextDigest)||
  !unique(delta.nodes.map(n=>n.nodeKey))||delta.nodes.length!==manifest.graph.nodes.length||
  manifest.graph.nodes.some(n=>!delta.nodes.some(d=>d.nodeKey===n.nodeKey))||
  !unique(delta.reviewNodeRemovals.map(n=>n.nodeKey))||delta.reviewNodeRemovals.some(n=>manifest.graph.nodes.some(d=>d.nodeKey===n.nodeKey))||
  (initial&&delta.reviewNodeRemovals.length>0))fail('STUDIO_IMPORT_RESPONSE');
 for(const n of delta.nodes){const create=n.action==='create';
  if((initial&&!create)||[n.instanceRef,n.expectedOwnedStateSha256].some(v=>(v===null)!==create)||!unique(n.changed)||
   (create&&(n.changed.length>0||n.preserveChildren.length>0))||(n.action==='reuse'&&n.changed.length>0)||
   (n.action==='update-in-place'&&n.changed.length===0)||!unique(n.preserveChildren.map(c=>c.instanceRef)))fail('STUDIO_IMPORT_RESPONSE');
  const mesh=manifest.graph.meshes.find(m=>m.nodeKey===n.nodeKey),object=mesh?delta.objects.find(o=>o.sourceObjectId===mesh.sourceObjectId):undefined;
  if(object&&(n.instanceRef!==object.instanceRef||n.expectedOwnedStateSha256!==object.expectedOwnedStateSha256||
   importCanonical(n.preserveChildren)!==importCanonical(object.preserveChildren)))fail('STUDIO_IMPORT_RESPONSE');
 }
 if(delta.graph.changed&&!initial&&!delta.nodes.some(n=>n.action!=='reuse')&&delta.reviewNodeRemovals.length===0)fail('STUDIO_IMPORT_RESPONSE');
 const references:string[]=[];if(delta.modelRef!==null)references.push(delta.modelRef);
 for(const o of [...delta.objects,...delta.reviewRemovals]){
  if(o.instanceRef!==null)references.push(o.instanceRef);
  references.push(...('preserveChildren' in o?o.preserveChildren:o.authoredChildren).map(c=>c.instanceRef));
 }
 for(const n of delta.nodes)if(!manifest.graph.meshes.some(m=>m.nodeKey===n.nodeKey)){
  if(n.instanceRef!==null)references.push(n.instanceRef);references.push(...n.preserveChildren.map(c=>c.instanceRef));
 }
 for(const n of delta.reviewNodeRemovals){
  // Removed mesh nodes share their exact object mapping; EMPTYs do not.
  const object=/_primitive[0-9]+$/.test(n.nodeKey)?delta.reviewRemovals.find(o=>o.sourceObjectId===convertedGlbObjectId(manifest.sourceSha256,'render',n.nodeKey)):undefined;
  if(object){if(n.instanceRef!==object.instanceRef||n.ownedStateSha256!==object.ownedStateSha256||importCanonical(n.authoredChildren)!==importCanonical(object.authoredChildren))fail('STUDIO_IMPORT_RESPONSE');}
  else references.push(n.instanceRef,...n.authoredChildren.map(c=>c.instanceRef));
 }
 if(!unique(references))fail('STUDIO_IMPORT_RESPONSE');
}
/** Verifies bounded serialized evidence, not generated bytes or engine acceptance. */
export function parseNativeStudioImportResponse(value:unknown,expectedJobId:string,expectedProjectId?:string):{prepared:PreparedStudioImport} {
 const converted=convertedEnvelope(value),snapshot=importSnapshot(value,converted);
 if(Buffer.byteLength(JSON.stringify(snapshot))>NATIVE_STUDIO_IMPORT_RESPONSE_BYTES)fail('STUDIO_IMPORT_RESPONSE');
 let parsed:ReturnType<typeof importResponse.safeParse>|ReturnType<typeof convertedResponse.safeParse>;
 try{parsed=converted?convertedResponse.safeParse(snapshot):importResponse.safeParse(snapshot);}catch{fail('STUDIO_IMPORT_RESPONSE');}
 if(!parsed.success)fail('STUDIO_IMPORT_RESPONSE');
 const {prepared}=parsed.data,{manifest,delta}=prepared,{digest,...content}=manifest;
 if(manifest.revisionId!==expectedJobId||(expectedProjectId!==undefined&&manifest.projectId!==expectedProjectId)||
  digest!==importDigest(content)||delta.nextDigest!==digest||prepared.digest!==importDigest({manifestDigest:digest,delta}))fail('STUDIO_IMPORT_RESPONSE');
 const unique=(ids:readonly string[])=>new Set(ids).size===ids.length;
 const same=(a:readonly string[],b:readonly string[])=>unique(a)&&unique(b)&&a.length===b.length&&a.every(id=>b.includes(id));
 if(!unique(manifest.files.map(f=>f.fileId))||!unique(manifest.objects.map(o=>o.sourceObjectId))||!unique(manifest.materials.map(m=>m.sha256))||
  !unique(manifest.textures.map(t=>t.sha256))||!unique(manifest.anchors.map(a=>a.sourceAnchorId))||
  !same(manifest.objects.map(o=>o.sourceObjectId),delta.objects.map(o=>o.sourceObjectId))||
  [...manifest.files].reduce((n,f)=>n+f.byteLength,0)>STUDIO_IMPORT_LIMITS.totalBytes||manifest.objects.reduce((n,o)=>n+o.triangles,0)>STUDIO_IMPORT_LIMITS.triangles)fail('STUDIO_IMPORT_RESPONSE');
 for(const o of manifest.objects)if(!manifest.files.some(f=>f.fileId===o.exportFileId)||
  ('parentSourceObjectId' in o&&o.parentSourceObjectId!==null&&!manifest.objects.some(p=>p.sourceObjectId===o.parentSourceObjectId))||
  (o.materialSha256!==null&&!manifest.materials.some(m=>m.sha256===o.materialSha256))||o.textureSha256s.some(h=>!manifest.textures.some(t=>t.sha256===h))||
  (o.role==='render'?o.collisionFor.length!==0:o.collisionFor.length===0)||o.collisionFor.some(id=>!manifest.objects.some(r=>r.sourceObjectId===id&&r.role==='render')))fail('STUDIO_IMPORT_RESPONSE');
 for(const a of manifest.anchors)if(!manifest.objects.some(o=>o.sourceObjectId===a.sourceObjectId&&o.role==='render'))fail('STUDIO_IMPORT_RESPONSE');
 for(const m of manifest.materials)if([m.colorMap,m.normalMap,m.roughnessMap,m.metalnessMap,m.emission?.map]
  .some(map=>map&&!manifest.textures.some(t=>t.sha256===map.sha256)))fail('STUDIO_IMPORT_RESPONSE');
 if(manifest.placement.mode==='custom-anchor'&&!manifest.anchors.some(a=>a.sourceAnchorId===(manifest.placement as {anchorId:string}).anchorId))fail('STUDIO_IMPORT_RESPONSE');
 const initial=delta.previousDigest===null;
 if((converted?[delta.receiptSha256,delta.modelRef]:[delta.receiptSha256,delta.modelRef,delta.modelAssetId]).some(v=>(v===null)!==initial)||
  (initial&&(delta.placementChanged||delta.reviewRemovals.length>0))||!unique(delta.reviewAnchors)||
  !unique(delta.reviewRemovals.map(o=>o.sourceObjectId))||delta.reviewRemovals.some(r=>manifest.objects.some(o=>o.sourceObjectId===r.sourceObjectId)))fail('STUDIO_IMPORT_RESPONSE');
 for(const o of delta.objects){
  const create=o.action==='create';
  if((initial&&!create)||(converted?[o.instanceRef,o.expectedOwnedStateSha256]:[o.instanceRef,o.meshAssetId,o.expectedOwnedStateSha256]).some(v=>(v===null)!==create)||(create&&o.meshAssetId!==null)||
   !unique(o.changed)||(create&&(o.changed.length>0||o.preserveChildren.length>0))||
   (o.action==='reuse'&&o.changed.length>0)||(o.action==='update-in-place'&&o.changed.length===0)||!unique(o.preserveChildren.map(c=>c.instanceRef)))fail('STUDIO_IMPORT_RESPONSE');
 }
 for(const [resources,hashes] of [[delta.geometry,manifest.objects.map(o=>o.meshExportSha256)],[delta.textures,manifest.textures.map(t=>t.sha256)]] as const)
  if(!same([...resources.prepare,...resources.reuse],[...new Set(hashes)])||(initial&&resources.reuse.length>0))fail('STUDIO_IMPORT_RESPONSE');
 if(converted)convertedPreparedChecks(prepared as ConvertedPreparedStudioImportV2);
 return parsed.data;
}
