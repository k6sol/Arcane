import {types} from 'node:util';
import {z} from 'zod';
import {ArcaneError} from '../../protocol/src/providers.js';
import {parseStudioImportRevisionReceipt} from '../../core/src/studio-policy.js';

/** Detached public metadata only. Historical success grants no current resource,
 * approval, native rendering, persistence or replay authority. */
export const NATIVE_STUDIO_REVISION_RESPONSE_BYTES=256*1024;
const uuid=z.string().length(36).regex(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}(?![\s\S])/);
const hash=z.string().length(64).regex(/^[a-f0-9]{64}(?![\s\S])/);
function detached(value:unknown):unknown {
  let values=0,bytes=0;const active=new Set<object>();
  const walk=(v:unknown,depth:number):unknown=>{
    if(++values>30000||depth>20)throw Error('bound');
    if(v===null||typeof v==='boolean')return v;
    if(typeof v==='number'){if(!Number.isFinite(v))throw Error('number');return Object.is(v,-0)?0:v;}
    if(typeof v==='string'){bytes+=Buffer.byteLength(v);if(v.length>4096||bytes>NATIVE_STUDIO_REVISION_RESPONSE_BYTES)throw Error('string');return v;}
    if(!v||typeof v!=='object'||types.isProxy(v)||active.has(v))throw Error('data');
    const array=Array.isArray(v),prototype=Object.getPrototypeOf(v),keys=Reflect.ownKeys(v);
    if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)throw Error('prototype');
    active.add(v);
    try{
      if(array){const d=Object.getOwnPropertyDescriptor(v,'length'),length:unknown=d?.value;
        if(typeof length!=='number'||!Number.isSafeInteger(length)||length<0||length>128||keys.length!==length+1)throw Error('array');
        const out:unknown[]=[];for(let i=0;i<length;i++){const item=Object.getOwnPropertyDescriptor(v,String(i));if(!item||!item.enumerable||!Object.hasOwn(item,'value'))throw Error('descriptor');out.push(walk(item.value,depth+1));}return out;
      }
      if(keys.length>32)throw Error('object');const out:Record<string,unknown>=Object.create(null);
      for(const key of keys){if(typeof key!=='string'||key.length>64||['__proto__','constructor','prototype'].includes(key))throw Error('key');const d=Object.getOwnPropertyDescriptor(v,key);if(!d||!d.enumerable||!Object.hasOwn(d,'value'))throw Error('descriptor');out[key]=walk(d.value,depth+1);}return out;
    }finally{active.delete(v);}
  };
  try{const out=walk(value,0);return Buffer.byteLength(JSON.stringify(out))<=NATIVE_STUDIO_REVISION_RESPONSE_BYTES?out:undefined;}catch{return undefined;}
}
function freeze<T>(value:T):T {if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
const receipt=z.unknown().transform((value,ctx)=>{
  try{return parseStudioImportRevisionReceipt(value);}catch{ctx.addIssue({code:'custom',message:'Invalid detached revision receipt.'});return z.NEVER;}
});
const applied=z.unknown().transform((value,ctx)=>{
  try{
    if(!value||typeof value!=='object'||Array.isArray(value)||!Object.hasOwn(value,'commandId'))throw Error('execution');
    const commandId:unknown=Object.getOwnPropertyDescriptor(value,'commandId')!.value;
    const body=Object.fromEntries(Object.entries(value).filter(([key])=>key!=='commandId'));return {...parseStudioImportRevisionReceipt(body),commandId:uuid.parse(commandId)};
  }catch{ctx.addIssue({code:'custom',message:'Invalid applied revision evidence.'});return z.NEVER;}
});
const commandState=z.enum(['queued','dispatched','succeeded','failed','cancelled','needs_reconciliation']);
const status=z.strictObject({runId:uuid,commandId:uuid,state:commandState,receipt:receipt.nullable(),receiptScope:z.literal('historical-revision'),
  currentResources:z.literal('unobserved'),imported:z.literal(false),engineVerification:z.literal('pending'),retry:z.literal(false)})
  .refine(v=>(v.state==='succeeded')===(v.receipt!==null)&&(!v.receipt||v.receipt.runId===v.runId));
export const nativeStudioRevisionResponse=z.preprocess(detached,z.strictObject({jobId:uuid,projectId:hash,applied}))
  .refine(v=>v.applied.source.jobId===v.jobId&&v.applied.source.projectId===v.projectId).transform(value=>freeze(value));
export const nativeStudioRevisionStatusResponse=z.preprocess(detached,z.strictObject({jobId:uuid,projectId:hash,revision:status.nullable()}))
  .refine(v=>!v.revision?.receipt||v.revision.receipt.source.jobId===v.jobId&&v.revision.receipt.source.projectId===v.projectId).transform(value=>freeze(value));
export type NativeStudioRevisionResponse=z.output<typeof nativeStudioRevisionResponse>;
export type NativeStudioRevisionStatusResponse=z.output<typeof nativeStudioRevisionStatusResponse>;
export function parseNativeStudioRevisionResponse(value:unknown,requestedJobId?:string,projectId?:string):NativeStudioRevisionResponse {
  const parsed=nativeStudioRevisionResponse.safeParse(value);
  if(!parsed.success||requestedJobId!==undefined&&parsed.data.jobId!==requestedJobId||projectId!==undefined&&parsed.data.projectId!==projectId)throw new ArcaneError('STUDIO_REVISION_RESPONSE','Invalid detached revision evidence.');
  return parsed.data;
}
export function parseNativeStudioRevisionStatusResponse(value:unknown,requestedJobId?:string,projectId?:string):NativeStudioRevisionStatusResponse {
  const parsed=nativeStudioRevisionStatusResponse.safeParse(value);
  if(!parsed.success||requestedJobId!==undefined&&parsed.data.jobId!==requestedJobId||projectId!==undefined&&parsed.data.projectId!==projectId)throw new ArcaneError('STUDIO_REVISION_STATUS_RESPONSE','Invalid historical revision evidence.');
  return parsed.data;
}
