import {createHash} from 'node:crypto';
import {types} from 'node:util';
import {z} from 'zod';
import {matrixFromTrs,multiplyMatrix4} from '../../core/src/spatial-math.js';
import {AssetError} from './types.js';
import {parseConvertedGlbRequest,parseConvertedGlbSourceMap,parseConvertedGlbAudit,GLB_CONVERSION_LIMITS} from './converted-glb.js';
import {parseConvertedGlbJson} from './converted-glb-manifest.js';
import {prepareGlbConversionSource} from './glb-conversion-source.js';
import {verifyGlbConversionFidelity} from './glb-conversion-fidelity.js';
import {validateConvertedGlbCollision} from './converted-glb-collision.js';
import {CONVERSION_NODE_KEY,checkConversionMatrix} from './conversion-fidelity-policy.js';

/** Representation limits, not native materialization support or permission.
 * Keep the converter's full conditioned affine graph; delivery may refuse it. */
export const STUDIO_IMPORT_GRAPH_LIMITS=Object.freeze({nodes:4096,meshes:128,depth:128,jsonBytes:1024*1024,values:200000});
export interface ConvertedGraphNode {
  readonly nodeKey:string;readonly parentKey:string|null;
  readonly localMatrix:readonly number[];readonly name:string|null;
}
export interface ConvertedGraphMesh {
  readonly sourceObjectId:string;readonly nodeKey:string|null;
  readonly sourcePivot:readonly [0,0,0];readonly correspondenceSha256:string|null;
}
export interface ConvertedGraphContent {
  readonly schemaVersion:1;readonly sourceSceneIndex:number;
  readonly nodes:readonly ConvertedGraphNode[];readonly meshes:readonly ConvertedGraphMesh[];
}
export interface ConvertedGraphV1 extends ConvertedGraphContent {readonly digest:string}
function fail():never {throw new AssetError('STUDIO_IMPORT_GRAPH','Converted graph data or retained byte correspondence is invalid.');}
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
const key=z.string().regex(/^node[0-9]{1,4}(?:_primitive[0-9]{1,4})?(?![\s\S])/);
const hash=z.string().regex(/^[a-f0-9]{64}(?![\s\S])/);
const node=z.strictObject({nodeKey:key,parentKey:key.nullable(),localMatrix:z.array(z.number().finite().min(-1000000).max(1000000)).length(16),name:z.string().max(256).nullable()});
const mesh=z.strictObject({sourceObjectId:z.string().regex(/^arcane_[a-f0-9]{64}(?![\s\S])/),nodeKey:key.nullable(),
  sourcePivot:z.tuple([z.literal(0),z.literal(0),z.literal(0)]),correspondenceSha256:hash.nullable()});
const content=z.strictObject({schemaVersion:z.literal(1),sourceSceneIndex:z.number().int().min(0).max(4095),
  nodes:z.array(node).min(1).max(STUDIO_IMPORT_GRAPH_LIMITS.nodes),meshes:z.array(mesh).min(1).max(STUDIO_IMPORT_GRAPH_LIMITS.meshes)});
const graph=content.extend({digest:hash});
function canonical(value:unknown):string {
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value!==null&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical((value as Record<string,unknown>)[k])).join(',')+'}';
  return JSON.stringify(value);
}
function freeze<T>(value:T):T {
  if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;
}
/** Snapshot metadata without invoking caller accessors, iterators or proxy traps. */
function snapshot(input:unknown):unknown {
  let count=0,bytes=0;const seen=new Set<object>();
  const charge=(size:number)=>{bytes+=size;if(bytes>STUDIO_IMPORT_GRAPH_LIMITS.jsonBytes)fail();};
  const copy=(value:unknown,depth:number):unknown=>{
    if(++count>STUDIO_IMPORT_GRAPH_LIMITS.values||depth>16)fail();
    if(value===null||typeof value==='boolean'){charge(JSON.stringify(value).length);return value;}
    if(typeof value==='number'){if(!Number.isFinite(value))fail();const number=value===0?0:value;charge(JSON.stringify(number).length);return number;}
    if(typeof value==='string'){if(value.length>4096)fail();charge(Buffer.byteLength(JSON.stringify(value)));return value;}
    if(!value||typeof value!=='object'||types.isProxy(value)||seen.has(value))fail();
    const array=Array.isArray(value),prototype:unknown=Object.getPrototypeOf(value);
    if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)fail();
    const keys=Reflect.ownKeys(value),descriptors=Object.getOwnPropertyDescriptors(value);
    if(keys.length>4097)fail();charge(2+keys.length);seen.add(value);
    const out:Record<string,unknown>=Object.create(null) as Record<string,unknown>;
    for(const name of keys){
      if(array&&name==='length')continue;
      if(typeof name!=='string'||name.length>64||['__proto__','constructor','prototype'].includes(name))fail();
      const descriptor=descriptors[name]!;if(!descriptor.enumerable||!Object.hasOwn(descriptor,'value'))fail();
      charge(Buffer.byteLength(JSON.stringify(name))+1);out[name]=copy(descriptor.value as unknown,depth+1);
    }
    seen.delete(value);
    if(!array)return out;
    const length=descriptors.length!.value as number;
    if(!Number.isSafeInteger(length)||length>4096||Object.keys(out).length!==length||Object.keys(out).some(k=>!/^(0|[1-9][0-9]*)$/.test(k)||Number(k)>=length))fail();
    return Array.from({length},(_,at)=>out[String(at)]);
  };
  const result=copy(input,0);if(Buffer.byteLength(JSON.stringify(result))>STUDIO_IMPORT_GRAPH_LIMITS.jsonBytes)fail();return result;
}
function checked(value:z.infer<typeof content>):ConvertedGraphContent {
  const nodes=[...value.nodes].sort((a,b)=>compare(a.nodeKey,b.nodeKey)),meshes=[...value.meshes].sort((a,b)=>compare(a.sourceObjectId,b.sourceObjectId));
  const byKey=new Map(nodes.map(n=>[n.nodeKey,n])),objects=new Set<string>(),associated=new Set<string>();
  if(byKey.size!==nodes.length)fail();let collisions=0;
  for(const m of meshes){
    if(objects.has(m.sourceObjectId))fail();objects.add(m.sourceObjectId);
    if(m.nodeKey===null){if(m.correspondenceSha256!==null||++collisions>1)fail();}
    else {
      if(!/_primitive[0-9]+$/.test(m.nodeKey)||!byKey.has(m.nodeKey)||associated.has(m.nodeKey)||m.correspondenceSha256===null)fail();
      associated.add(m.nodeKey);
    }
  }
  if(associated.size===0)fail();
  const worlds=new Map<string,number[]>(),depths=new Map<string,number>();
  for(const n of nodes){
    if(/_primitive[0-9]+$/.test(n.nodeKey)?!associated.has(n.nodeKey)||n.parentKey!==n.nodeKey.split('_primitive')[0]:associated.has(n.nodeKey))fail();
    const chain:typeof nodes=[],seen=new Set<string>();let next:string|null=n.nodeKey;
    while(next!==null&&!worlds.has(next)){
      const current=byKey.get(next);if(!current||seen.has(next)||chain.length>=STUDIO_IMPORT_GRAPH_LIMITS.depth)fail();
      seen.add(next);chain.push(current);next=current.parentKey;
    }
    let world=next===null?[...matrixFromTrs()]:worlds.get(next)!,depth=next===null?0:depths.get(next)!;
    while(chain.length){
      const current=chain.pop()!;if(++depth>STUDIO_IMPORT_GRAPH_LIMITS.depth)fail();
      try{checkConversionMatrix(current.localMatrix);world=multiplyMatrix4(world,current.localMatrix);checkConversionMatrix(world);}catch{fail();}
      worlds.set(current.nodeKey,world);depths.set(current.nodeKey,depth);
    }
  }
  return {schemaVersion:1,sourceSceneIndex:value.sourceSceneIndex,nodes,meshes};
}
/** Closed metadata only. A digest is neither a byte witness nor native proof. */
export function convertedGraphDigest(value:unknown):string {
  const parsed=content.safeParse(snapshot(value));if(!parsed.success)fail();return sha(canonical(checked(parsed.data)));
}
/** Validates/detaches metadata; does not authorize import or verify source bytes. */
export function parseConvertedGraph(value:unknown):ConvertedGraphV1 {
  const parsed=graph.safeParse(snapshot(value));if(!parsed.success)fail();const body=checked(parsed.data);
  if(sha(canonical(body))!==parsed.data.digest)fail();return freeze({...body,digest:parsed.data.digest});
}

export interface ConvertedGraphSourceBytes {
  readonly requestBytes:Buffer;readonly sourceMapBytes:Buffer;readonly auditBytes:Buffer;
  readonly sourceBytes:Buffer;readonly importBytes:Buffer;readonly renderBytes:Buffer;
  readonly collisionBytes?:Buffer;
}
const required=['requestBytes','sourceMapBytes','auditBytes','sourceBytes','importBytes','renderBytes'] as const;
const typed=Object.getPrototypeOf(Uint8Array.prototype) as object;
function owned(value:unknown,maximum:number):Buffer {
  if(!value||types.isProxy(value)||!Buffer.isBuffer(value)||Object.getPrototypeOf(value)!==Buffer.prototype)fail();
  try{
    const slot=(name:string):unknown=>Object.getOwnPropertyDescriptor(typed,name)!.get!.call(value);
    const buffer=slot('buffer');if(types.isSharedArrayBuffer(buffer))fail();
    const size=slot('byteLength') as number;if(size<20||size>maximum)fail();
    return Buffer.from(new Uint8Array(buffer as ArrayBuffer,slot('byteOffset') as number,size));
  }catch{fail();}
}
function inputs(value:unknown):ConvertedGraphSourceBytes {
  if(!value||typeof value!=='object'||types.isProxy(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail();
  const keys=Reflect.ownKeys(value),descriptors=Object.getOwnPropertyDescriptors(value),allowed:readonly string[]=[...required,'collisionBytes'];
  if(keys.length<required.length||keys.length>allowed.length||keys.some(k=>typeof k!=='string'||!allowed.includes(k))||required.some(k=>!Object.hasOwn(descriptors,k)))fail();
  const out:Record<string,Buffer>={};let total=0;
  for(const name of keys){
    if(typeof name!=='string')fail();const d=descriptors[name]!;if(!d.enumerable||!Object.hasOwn(d,'value'))fail();
    const limit=name==='sourceBytes'||name==='importBytes'?GLB_CONVERSION_LIMITS.sourceBytes:name==='renderBytes'||name==='collisionBytes'?GLB_CONVERSION_LIMITS.exportedBytes:GLB_CONVERSION_LIMITS.jsonBytes;
    const bytes=owned(d.value,limit);total+=bytes.length;if(total>256*1024*1024)fail();out[name]=bytes;
  }
  return out as unknown as ConvertedGraphSourceBytes;
}
type Doc=Record<string,any>; // Only locally parsed, independently validated GLB JSON.
/** Builds actual graph data from retained bytes after full independent fidelity
 * and collision gates. Bytes/closed audit statements still prove no process ran,
 * no worker closed, no human approved and no Studio target can represent it. */
export function buildConvertedGraph(value:ConvertedGraphSourceBytes):ConvertedGraphV1 {
  const bytes=inputs(value),request=parseConvertedGlbRequest(parseConvertedGlbJson(bytes.requestBytes));
  if(sha(bytes.sourceMapBytes)!==request.sourceMapSha256)fail();
  const sourceMap=parseConvertedGlbSourceMap(parseConvertedGlbJson(bytes.sourceMapBytes),request),requestHash=sha(bytes.requestBytes);
  const audit=parseConvertedGlbAudit(parseConvertedGlbJson(bytes.auditBytes),request,sourceMap,requestHash);
  if(bytes.sourceBytes.length!==request.sourceBytes||sha(bytes.sourceBytes)!==request.sourceSha256||
    bytes.importBytes.length!==request.importBytes||sha(bytes.importBytes)!==request.importSha256)fail();
  const marked=prepareGlbConversionSource(bytes.sourceBytes,request.sourceSha256);
  if(!marked.importBytes.equals(bytes.importBytes))fail();
  verifyGlbConversionFidelity(bytes.sourceBytes,bytes.renderBytes,request,sourceMap,audit,requestHash);
  if(request.collision==='convex-hull'){
    if(!bytes.collisionBytes)fail();validateConvertedGlbCollision(bytes.collisionBytes,request,sourceMap,audit,requestHash);
  }else if(bytes.collisionBytes!==undefined)fail();
  const jsonLength=bytes.renderBytes.readUInt32LE(12),doc=JSON.parse(bytes.renderBytes.subarray(20,20+jsonLength).toString('utf8')) as Doc;
  const actualNodes=doc.nodes as Doc[],byKey=new Map<string,number>(),parents=new Map<number,number>();
  actualNodes.forEach((n,at)=>{const marker=n.extras?.[CONVERSION_NODE_KEY];if(typeof marker!=='string'||byKey.has(marker))fail();byKey.set(marker,at);for(const child of n.children??[])parents.set(child,at);});
  if(actualNodes.length!==sourceMap.nodes.length||byKey.size!==sourceMap.nodes.length)fail();
  const nodes:ConvertedGraphNode[]=sourceMap.nodes.map(expected=>{
    const at=byKey.get(expected.nodeKey);if(at===undefined)fail();const actual=actualNodes[at]!,parent=parents.get(at);
    const parentKey=parent===undefined?null:actualNodes[parent]!.extras[CONVERSION_NODE_KEY];if(parentKey!==expected.parentKey)fail();
    const localMatrix=actual.matrix===undefined?matrixFromTrs(actual.translation,actual.rotation,actual.scale):actual.matrix;
    return {nodeKey:expected.nodeKey,parentKey,localMatrix,name:actual.name===undefined?null:actual.name};
  });
  const render=audit.models.find(m=>m.path==='asset.glb')!;
  const meshes:ConvertedGraphMesh[]=sourceMap.parts.map(part=>{
    const object=render.objects.find(o=>o.sourceKey===part.sourceKey)!,at=byKey.get(part.sourceKey);
    if(at===undefined||object.nodeIndex!==at||actualNodes[at]!.mesh===undefined)fail();
    const measured=audit.importedParts.find(p=>p.sourceKey===part.sourceKey)!;
    return {sourceObjectId:object.sourceObjectId,nodeKey:part.sourceKey,sourcePivot:[0,0,0],correspondenceSha256:measured.correspondenceSha256};
  });
  if(bytes.collisionBytes){const collision=audit.models.find(m=>m.path==='collision.glb')!.objects[0]!;
    meshes.push({sourceObjectId:collision.sourceObjectId,nodeKey:null,sourcePivot:[0,0,0],correspondenceSha256:null});}
  const body={schemaVersion:1,sourceSceneIndex:sourceMap.sourceSceneIndex,nodes,meshes};
  return parseConvertedGraph({...body,digest:convertedGraphDigest(body)});
}
