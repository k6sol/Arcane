import {types} from 'node:util';
import {z} from 'zod';
import {ArcaneError} from '../../protocol/src/providers.js';
import {STUDIO_RECONSTRUCTION_LIMITS} from '../../protocol/src/studio.js';

/** Detached evidence only: hashes and IDs establish neither live resources nor
 * upload rights, insertion, rendering correctness or permission to retry. */
export const NATIVE_STUDIO_RECONSTRUCTION_RESPONSE_BYTES=64*1024;
const uuid=z.string().length(36).regex(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}(?![\s\S])/);
const hash=z.string().length(64).regex(/^[a-f0-9]{64}(?![\s\S])/);
const source=z.strictObject({sourceObjectId:z.string().min(1).max(128).refine(v=>!v.includes('\0')),meshExportSha256:hash,
  vertexCount:z.number().int().min(1).max(60000),triangleCount:z.number().int().min(1).max(20000)});
const receipt=z.strictObject({runId:uuid,transferDigest:hash,state:z.literal('reconstructed'),objects:z.array(source).min(1).max(STUDIO_RECONSTRUCTION_LIMITS.objects),
  imported:z.literal(false),engineVerification:z.literal('pending')}).refine(v=>new Set(v.objects.map(o=>o.sourceObjectId)).size===v.objects.length
    &&v.objects.reduce((n,o)=>n+o.vertexCount,0)<=STUDIO_RECONSTRUCTION_LIMITS.vertices&&v.objects.reduce((n,o)=>n+o.triangleCount,0)<=STUDIO_RECONSTRUCTION_LIMITS.triangles);
const nodeKey=z.string().regex(/^node[0-9]{1,4}(?:_primitive[0-9]{1,4})?(?![\s\S])/);
const convertedSource=source.extend({sourceObjectId:z.string().regex(/^arcane_[a-f0-9]{64}(?![\s\S])/)});
const logicalNode=z.strictObject({nodeKey,parentKey:nodeKey.nullable(),sourceObjectId:convertedSource.shape.sourceObjectId.nullable()});
const convertedReceiptFields={runId:uuid,transferDigest:hash,state:z.literal('reconstructed'),objects:z.array(convertedSource).min(1).max(STUDIO_RECONSTRUCTION_LIMITS.objects),
  imported:z.literal(false),engineVerification:z.literal('pending'),formatVersion:z.literal(2),graphDigest:hash,
  nodeCount:z.number().int().min(1).max(STUDIO_RECONSTRUCTION_LIMITS.objects),nodes:z.array(logicalNode).min(1).max(STUDIO_RECONSTRUCTION_LIMITS.objects)};
/** Logical sealed-source summaries only, never observed instance mappings or
 * proof that current native resources, physical transforms or pivots survive. */
const convertedReceipt=z.strictObject(convertedReceiptFields).refine(value=>{
  const {formatVersion:_version,graphDigest:_graph,nodeCount,nodes,...legacy}=value;
  if(!receipt.safeParse(legacy).success||nodeCount!==nodes.length)return false;
  const keys=new Set<string>(),associated=new Set<string>(),objects=new Set(value.objects.map(object=>object.sourceObjectId));
  for(const node of nodes){
    const primitive=node.nodeKey.includes('_primitive');
    if(keys.has(node.nodeKey)||node.parentKey!==null&&!keys.has(node.parentKey)||
      (primitive?node.parentKey!==node.nodeKey.split('_primitive')[0]||node.sourceObjectId===null:node.sourceObjectId!==null))return false;
    if(node.sourceObjectId!==null){if(!objects.has(node.sourceObjectId)||associated.has(node.sourceObjectId))return false;associated.add(node.sourceObjectId);}
    keys.add(node.nodeKey);
  }
  // The receipt has no role field. Permit at most the one unassociated derived
  // mesh allowed by protocol v2, without inferring that a collision was observed.
  return associated.size>0&&objects.size-associated.size<=1&&nodeCount+objects.size-associated.size<=STUDIO_RECONSTRUCTION_LIMITS.objects;
});
const anyReceipt=z.union([receipt,convertedReceipt]);
const commandState=z.enum(['queued','dispatched','succeeded','failed','cancelled','needs_reconciliation']);
const status=z.strictObject({runId:uuid,commandId:uuid,state:commandState,receipt:anyReceipt.nullable(),receiptScope:z.literal('historical-reconstruction'),
  currentResources:z.literal('unobserved'),imported:z.literal(false),engineVerification:z.literal('pending'),retry:z.literal(false)})
  .refine(v=>(v.state==='succeeded')===(v.receipt!==null)&&(!v.receipt||v.receipt.runId===v.runId));
function snapshot(value:unknown):unknown {
  let nodes=0;
  const copy=(v:unknown,depth:number):unknown=>{
    if(++nodes>3000||depth>8)throw Error('bound');
    if(v===null||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v))return v;
    if(typeof v==='string'){if(Buffer.byteLength(v)>512)throw Error('bound');return v;}
    if(!v||typeof v!=='object'||types.isProxy(v))throw Error('data');
    const array=Array.isArray(v),proto=Object.getPrototypeOf(v),keys=Reflect.ownKeys(v),descriptors=Object.getOwnPropertyDescriptors(v);
    if(array?proto!==Array.prototype:proto!==Object.prototype&&proto!==null)throw Error('data');
    if(keys.length>129)throw Error('bound');
    const out:Record<string,unknown>={};
    for(const key of keys){
      if(array&&key==='length')continue;
      const d=typeof key==='string'?descriptors[key]:undefined;
      if(!d||!Object.hasOwn(d,'value')||!d.enumerable||key==='__proto__'||key==='constructor'||key==='prototype')throw Error('data');
      out[key as string]=copy(d.value,depth+1);
    }
    if(!array)return out;
    const length=descriptors.length!.value as number;
    if(keys.length!==length+1||Object.keys(out).some((k,i)=>k!==String(i)))throw Error('array');
    return Object.values(out);
  };
  try{const result=copy(value,0);return Buffer.byteLength(JSON.stringify(result))<=NATIVE_STUDIO_RECONSTRUCTION_RESPONSE_BYTES?result:null;}catch{return null;}
}
const execution=z.strictObject({runId:uuid,transferDigest:hash,state:z.literal('reconstructed'),objects:z.array(source).min(1).max(128),
  imported:z.literal(false),engineVerification:z.literal('pending'),commandId:uuid}).refine(({commandId,...value})=>receipt.safeParse(value).success);
const convertedExecution=z.strictObject({...convertedReceiptFields,commandId:uuid}).refine(({commandId,...value})=>convertedReceipt.safeParse(value).success);
export const nativeStudioReconstructionResponse=z.preprocess(snapshot,z.strictObject({jobId:uuid,projectId:hash,reconstructed:z.union([execution,convertedExecution])}));
export const nativeStudioReconstructionStatusResponse=z.preprocess(snapshot,z.strictObject({jobId:uuid,projectId:hash,reconstruction:status.nullable()}));
export type NativeStudioReconstructionResponse=z.output<typeof nativeStudioReconstructionResponse>;
export type NativeStudioReconstructionStatusResponse=z.output<typeof nativeStudioReconstructionStatusResponse>;
export function parseNativeStudioReconstructionResponse(value:unknown,jobId:string,projectId?:string):NativeStudioReconstructionResponse {
  const parsed=nativeStudioReconstructionResponse.safeParse(value);
  if(!parsed.success||parsed.data.jobId!==jobId||projectId!==undefined&&parsed.data.projectId!==projectId)throw new ArcaneError('STUDIO_RECONSTRUCT_RESPONSE','Invalid detached reconstruction evidence.');
  return parsed.data;
}
export function parseNativeStudioReconstructionStatusResponse(value:unknown,jobId:string,projectId?:string):NativeStudioReconstructionStatusResponse {
  const parsed=nativeStudioReconstructionStatusResponse.safeParse(value);
  if(!parsed.success||parsed.data.jobId!==jobId||projectId!==undefined&&parsed.data.projectId!==projectId)throw new ArcaneError('STUDIO_RECONSTRUCT_STATUS_RESPONSE','Invalid historical reconstruction evidence.');
  return parsed.data;
}
