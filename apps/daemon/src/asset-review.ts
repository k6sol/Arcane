import {createHash} from 'node:crypto';
import {types} from 'node:util';
import {ArcaneError} from '../../../packages/protocol/src/providers.js';
import type {NativeConversation} from '../../../packages/storage/src/conversation-work-store.js';
import type {AssetManifest} from '../../../packages/asset-pipeline/src/types.js';

/** Model bytes only. This never grants a Studio target, native actor or write permission. */
export interface AssetReviewScope {readonly projectId:string;readonly conversation:Readonly<NativeConversation>}
export interface AssetReviewSubject extends AssetReviewScope {
  readonly schemaVersion:1;readonly jobId:string;readonly manifestSha256:string;readonly sourceRequestSha256:string;
  readonly artifacts:readonly {readonly path:'asset.glb'|'collision.glb';readonly sha256:string;readonly bytes:number}[];
}
export interface AssetReviewReference {readonly reviewId:string;readonly subjectDigest:string;readonly revision:number}
export interface AssetReviewView {
  readonly reviewId:string;readonly subject:AssetReviewSubject;readonly subjectDigest:string;
  readonly status:'pending'|'approved'|'rejected';readonly revision:number;readonly preparedAt:string;readonly decidedAt:string|null;
}
export interface AssetReviewGate {
  assertApproved(subject:AssetReviewSubject,expected?:AssetReviewReference):AssetReviewReference;
  assertReference(subject:AssetReviewSubject,reference:AssetReviewReference):void;
}
/** A host closure over current source witnesses. No serialized copy grants authority. */
export interface AssetReviewImportGuard {
  readonly subject:AssetReviewSubject;readonly reference:AssetReviewReference;assertCurrent():void;
}
export interface AssetReviewDecisionInput {readonly reviewId:string;readonly decision:'approved'|'rejected';readonly idempotencyKey:string}
export interface AssetReviewDecisionReceipt {
  readonly state:'recorded';readonly review:AssetReviewView;
  readonly command:{readonly idempotencyKey:string;readonly decision:'approved'|'rejected';readonly revision:number};readonly retry:false;
}
export interface AssetReviewReceiptAuthority {
  /** Host-private, fixed app storage; never a request-selected directory. */
  readonly directory:string;
  sign(value:unknown):string;verify(value:unknown,signature:unknown):boolean;
  withSnapshot<T>(evaluate:()=>T):T;close():void;
}
export const ASSET_REVIEW_LIMITS=Object.freeze({reviews:1024,commands:4096,recordBytes:16*1024,totalBytes:16*1024*1024});
const HASH=/^[a-f0-9]{64}(?![\s\S])/;
const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}(?![\s\S])/;
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}(?![\s\S])/;
export function assetReviewFailure(code:string):never {throw new ArcaneError('ASSET_REVIEW_'+code,'This exact model requires a current human review before Studio import.');}
export function assetReviewFields(value:unknown,keys:readonly string[]):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)||types.isProxy(value))assetReviewFailure('INPUT');
  const proto=Object.getPrototypeOf(value),own=Reflect.ownKeys(value);
  if(proto!==Object.prototype&&proto!==null||own.length!==keys.length||own.some(k=>typeof k!=='string'||!keys.includes(k)))assetReviewFailure('INPUT');
  const out:Record<string,unknown>={};
  for(const key of keys){const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!Object.hasOwn(d,'value')||!d.enumerable)assetReviewFailure('INPUT');out[key]=d.value;}
  return out;
}
export function assetReviewUuid(value:unknown):string {if(typeof value!=='string'||!UUID.test(value))assetReviewFailure('INPUT');return value;}
export function assetReviewHash(value:unknown):string {if(typeof value!=='string'||!HASH.test(value))assetReviewFailure('INPUT');return value;}
export function assetReviewCanonical(value:unknown):string {
  if(Array.isArray(value))return '['+value.map(assetReviewCanonical).join(',')+']';
  if(value!==null&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+assetReviewCanonical((value as Record<string,unknown>)[k])).join(',')+'}';
  return JSON.stringify(value);
}
export function assetReviewDigest(value:unknown):string {return createHash('sha256').update(assetReviewCanonical(value)).digest('hex');}
export function assetReviewFreeze<T>(value:T):T {
  if(value&&typeof value==='object'){for(const child of Object.values(value))assetReviewFreeze(child);Object.freeze(value);}return value;
}
export function snapshotAssetReviewScope(value:unknown):AssetReviewScope {
  const a=assetReviewFields(value,['projectId','conversation']),c=assetReviewFields(a.conversation,['provider','threadId','sessionId']);
  if(c.provider!=='codex'&&c.provider!=='claude-code'||typeof c.threadId!=='string'||!ID.test(c.threadId)
    ||c.sessionId!==null&&(typeof c.sessionId!=='string'||!ID.test(c.sessionId)))assetReviewFailure('INPUT');
  return assetReviewFreeze({projectId:assetReviewHash(a.projectId),conversation:{provider:c.provider,threadId:c.threadId,sessionId:c.sessionId}} as AssetReviewScope);
}
export function snapshotAssetReviewSubject(value:unknown):AssetReviewSubject {
  const a=assetReviewFields(value,['schemaVersion','projectId','conversation','jobId','manifestSha256','sourceRequestSha256','artifacts']);
  if(a.schemaVersion!==1||!Array.isArray(a.artifacts)||types.isProxy(a.artifacts)||a.artifacts.length!==2
    ||Object.getPrototypeOf(a.artifacts)!==Array.prototype||Reflect.ownKeys(a.artifacts).length!==3)assetReviewFailure('INPUT');
  const scope=snapshotAssetReviewScope({projectId:a.projectId,conversation:a.conversation});
  const artifacts=Array.from({length:2},(_,index)=>{
    const d=Object.getOwnPropertyDescriptor(a.artifacts,index);
    if(!d||!Object.hasOwn(d,'value')||!d.enumerable)assetReviewFailure('INPUT');
    const t=assetReviewFields(d.value,['path','sha256','bytes']);
    if(t.path!==['asset.glb','collision.glb'][index]||typeof t.bytes!=='number'||!Number.isSafeInteger(t.bytes)||t.bytes<1||t.bytes>64*1024*1024)assetReviewFailure('INPUT');
    return {path:t.path as 'asset.glb'|'collision.glb',sha256:assetReviewHash(t.sha256),bytes:t.bytes};
  });
  return assetReviewFreeze({schemaVersion:1,...scope,jobId:assetReviewUuid(a.jobId),manifestSha256:assetReviewHash(a.manifestSha256),sourceRequestSha256:assetReviewHash(a.sourceRequestSha256),artifacts});
}
export function snapshotAssetReviewReference(value:unknown):AssetReviewReference {
  const a=assetReviewFields(value,['reviewId','subjectDigest','revision']);
  if(typeof a.revision!=='number'||!Number.isSafeInteger(a.revision)||a.revision<1||a.revision>4096)assetReviewFailure('INPUT');
  return Object.freeze({reviewId:assetReviewUuid(a.reviewId),subjectDigest:assetReviewHash(a.subjectDigest),revision:a.revision});
}
export function snapshotAssetReviewDecision(value:unknown):AssetReviewDecisionInput {
  const a=assetReviewFields(value,['reviewId','decision','idempotencyKey']);
  if(a.decision!=='approved'&&a.decision!=='rejected')assetReviewFailure('INPUT');
  return Object.freeze({reviewId:assetReviewUuid(a.reviewId),decision:a.decision,idempotencyKey:assetReviewUuid(a.idempotencyKey)});
}
/** Called only with a completely verified service manifest and exact owned export bytes. */
export function modelReviewSubject(scope:AssetReviewScope,manifest:AssetManifest,exports:ReadonlyMap<'asset.glb'|'collision.glb',Buffer>):AssetReviewSubject {
  const canonicalScope=snapshotAssetReviewScope(scope);
  const artifacts=(['asset.glb','collision.glb'] as const).map(path=>{
    const file=manifest.artifacts.find(a=>a.path===path&&a.role==='export'),bytes=exports.get(path);
    if(!file||!bytes||file.bytes!==bytes.length||file.sha256!==createHash('sha256').update(bytes).digest('hex'))assetReviewFailure('SOURCE');
    return {path,sha256:file.sha256,bytes:file.bytes};
  });
  return snapshotAssetReviewSubject({schemaVersion:1,...canonicalScope,jobId:manifest.jobId,
    manifestSha256:assetReviewDigest(manifest),sourceRequestSha256:manifest.sourceRequestSha256,artifacts});
}
