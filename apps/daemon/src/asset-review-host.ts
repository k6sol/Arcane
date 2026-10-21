import type {IncomingMessage} from 'node:http';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {ConversationWorkStore,type ConversationWorkBinding} from '../../../packages/storage/src/conversation-work-store.js';
import {workflowProjectIdentity} from '../../../packages/storage/src/workflow-store.js';
import {assertLearningHumanRequest,LearningHttpError} from './learning-service.js';
import {createAssetReviewReceiptAuthority} from './workflow-host.js';
import {AssetReviewStore} from './asset-review-store.js';
import {assetReviewDigest,assetReviewFailure,assetReviewFields,assetReviewUuid,snapshotAssetReviewDecision,snapshotAssetReviewScope,
  type AssetReviewDecisionReceipt,type AssetReviewReceiptAuthority,type AssetReviewReference,type AssetReviewScope,
  type AssetReviewSubject,type AssetReviewView} from './asset-review.js';

export interface AssetReviewHttpAuthority {controlToken:string;origin:string;agentToken:string}
export interface AssetReviewHostOptions {
  directory:string;projectPath:string;workAssociations:ConversationWorkStore;
  /** Current trusted UI conversation selection, never browser identity fields. */
  bindingHuman:(jobId:string)=>ConversationWorkBinding|null;
  /** Opaque parent-owned focus incarnation; never supplied by an HTTP caller. */
  selectionEpoch?:()=>object;
  /** Actual AssetService read, not a browser/MCP manifest or artifact hash. */
  readSubject:(jobId:string,scope:AssetReviewScope,guard:()=>void)=>Promise<AssetReviewSubject>;
  /** Trusted fixture port only; production uses fixed private signed storage. */
  receiptAuthority?:AssetReviewReceiptAuthority;
}
export interface AssetReviewStatus {
  readonly subject:AssetReviewSubject;readonly subjectDigest:string;readonly review:AssetReviewView|null;
  /** Ephemeral human-open proof; not a persisted approval or native capability. */
  readonly openWitness:string|null;readonly retry:false;
}
function human(request:IncomingMessage,authority:AssetReviewHttpAuthority):void {
  assertLearningHumanRequest(request,authority.controlToken,authority.origin,authority.agentToken);
  if(request.method!=='POST')throw new LearningHttpError('METHOD',405);
}
/** Human controls and model gate share one private store. A native actor can
 * read the gate's result but cannot manufacture its human decision permit. */
export function createAssetReviewHost(options:AssetReviewHostOptions){
  const project=workflowProjectIdentity(options.projectPath),associations=options.workAssociations;
  if(!(associations instanceof ConversationWorkStore)||associations.projectId!==project.projectId||associations.projectPath!==project.projectPath
    ||typeof options.bindingHuman!=='function'||typeof options.readSubject!=='function'
    ||(options.selectionEpoch!==undefined&&typeof options.selectionEpoch!=='function'))assetReviewFailure('CONFIGURATION');
  let selected:AssetReviewStore|undefined,receipts:AssetReviewReceiptAuthority|undefined,closed=false;
  let permit:{proof:symbol;reviewId:string;decision:'approved'|'rejected';idempotencyKey:string;subjectDigest:string}|undefined;
  const legacyEpoch=Object.freeze({});
  const opens=new Map<string,{reviewId:string;subjectDigest:string;epoch:object}>(),latestOpen=new Map<string,string>();
  function selectionEpoch():object {
    const epoch=options.selectionEpoch?options.selectionEpoch():legacyEpoch;
    if(epoch===null||typeof epoch!=='object')assetReviewFailure('CONFIGURATION');return epoch;
  }
  function forgetOpen(witness:string):void {
    const open=opens.get(witness);if(!open)return;opens.delete(witness);
    if(latestOpen.get(open.reviewId)===witness)latestOpen.delete(open.reviewId);
  }
  function freshOpen(review:AssetReviewView,epoch:object):string {
    const previous=latestOpen.get(review.reviewId);if(previous)forgetOpen(previous);
    while(opens.size>=128)forgetOpen(opens.keys().next().value!);
    const witness=randomUUID();if(opens.has(witness))assetReviewFailure('CONFIGURATION');
    opens.set(witness,{reviewId:review.reviewId,subjectDigest:review.subjectDigest,epoch});latestOpen.set(review.reviewId,witness);return witness;
  }
  function requireOpen(witness:string,reviewId:string):{subjectDigest:string;guard:()=>void} {
    if(closed)assetReviewFailure('CLOSED');const open=opens.get(witness);if(!open)assetReviewFailure('STALE');
    const guard=()=>{if(opens.get(witness)!==open||latestOpen.get(reviewId)!==witness
      ||open.reviewId!==reviewId||selectionEpoch()!==open.epoch)assetReviewFailure('STALE');};
    guard();return {subjectDigest:open.subjectDigest,guard};
  }
  function opened():AssetReviewStore {
    if(closed)assetReviewFailure('CLOSED');
    if(!selected){
      receipts=options.receiptAuthority??createAssetReviewReceiptAuthority(options.directory,project.projectId);
      try{selected=new AssetReviewStore({projectPath:project.projectPath,authority:receipts,authorizeHuman(command,proof){
        return permit!==undefined&&proof===permit.proof&&command.projectId===project.projectId&&command.reviewId===permit.reviewId
          &&command.decision===permit.decision&&command.idempotencyKey===permit.idempotencyKey&&command.subjectDigest===permit.subjectDigest;
      }});}catch(error){receipts.close();receipts=undefined;throw error;}
    }
    return selected;
  }
  function scopeFor(jobId:string):AssetReviewScope {
    if(closed)assetReviewFailure('CLOSED');
    const binding=options.bindingHuman(jobId),stored=associations.binding('asset-job',jobId);
    if(!binding||!stored||binding.kind!=='asset-job'||binding.id!==jobId||binding.projectId!==project.projectId
      ||!isDeepStrictEqual(binding,stored))assetReviewFailure('NOT_FOUND');
    return snapshotAssetReviewScope({projectId:project.projectId,conversation:stored.conversation});
  }
  function current(jobId:string,scope:AssetReviewScope,epoch:object,request:IncomingMessage,authority:AssetReviewHttpAuthority):()=>void {
    return ()=>{human(request,authority);if(request.aborted||request.socket.destroyed)assetReviewFailure('CANCELLED');
      if(selectionEpoch()!==epoch||!isDeepStrictEqual(scopeFor(jobId),scope))assetReviewFailure('SCOPE');};
  }
  async function subject(jobId:string,request:IncomingMessage,authority:AssetReviewHttpAuthority):Promise<{subject:AssetReviewSubject;guard:()=>void;epoch:object}> {
    human(request,authority);const epoch=selectionEpoch(),scope=scopeFor(jobId),guard=current(jobId,scope,epoch,request,authority);guard();
    const value=await options.readSubject(jobId,scope,guard);guard();
    if(value.jobId!==jobId||value.projectId!==scope.projectId||!isDeepStrictEqual(value.conversation,scope.conversation))assetReviewFailure('SCOPE');
    return {subject:value,guard,epoch};
  }
  return Object.freeze({
    async prepare(input:unknown,request:IncomingMessage,authority:AssetReviewHttpAuthority):Promise<AssetReviewStatus>{
      human(request,authority);const args=assetReviewFields(input,['jobId']),jobId=assetReviewUuid(args.jobId);
      const verified=await subject(jobId,request,authority),review=opened().prepare(verified.subject,verified.guard);verified.guard();
      const openWitness=review?freshOpen(review,verified.epoch):null;verified.guard();
      return {subject:verified.subject,subjectDigest:assetReviewDigest(verified.subject),review,openWitness,retry:false};
    },
    async status(input:unknown,request:IncomingMessage,authority:AssetReviewHttpAuthority):Promise<AssetReviewStatus>{
      human(request,authority);const args=assetReviewFields(input,['jobId']),verified=await subject(assetReviewUuid(args.jobId),request,authority);
      const review=opened().status(verified.subject);verified.guard();return {subject:verified.subject,subjectDigest:assetReviewDigest(verified.subject),review,openWitness:null,retry:false};
    },
    async decide(input:unknown,request:IncomingMessage,authority:AssetReviewHttpAuthority):Promise<AssetReviewDecisionReceipt>{
      human(request,authority);const fields=assetReviewFields(input,['reviewId','decision','idempotencyKey','openWitness']);
      const witness=assetReviewUuid(fields.openWitness),args=snapshotAssetReviewDecision({reviewId:fields.reviewId,decision:fields.decision,idempotencyKey:fields.idempotencyKey});
      const open=requireOpen(witness,args.reviewId),store=opened(),prepared=store.read(args.reviewId);
      if(open.subjectDigest!==prepared.subjectDigest)assetReviewFailure('STALE');
      const verified=await subject(prepared.subject.jobId,request,authority);
      const guard=()=>{verified.guard();open.guard();};guard();
      if(assetReviewDigest(verified.subject)!==prepared.subjectDigest)assetReviewFailure('STALE');
      const proof=Symbol('human-asset-model-review');permit={proof,...args,subjectDigest:prepared.subjectDigest};
      try{return store.decide(args,verified.subject,proof,guard);}finally{permit=undefined;}
    },
    async receipt(input:unknown,request:IncomingMessage,authority:AssetReviewHttpAuthority){
      human(request,authority);const args=assetReviewFields(input,['reviewId','idempotencyKey']),store=opened(),prepared=store.read(assetReviewUuid(args.reviewId));
      const verified=await subject(prepared.subject.jobId,request,authority);verified.guard();
      if(assetReviewDigest(verified.subject)!==prepared.subjectDigest)return {state:'stale' as const,review:null,retry:false as const};
      const recorded=store.decisionReceipt(prepared.reviewId,assetReviewUuid(args.idempotencyKey));verified.guard();
      return recorded??{state:'not-recorded' as const,review:store.read(prepared.reviewId),retry:false as const};
    },
    assertApproved(value:AssetReviewSubject,expected?:AssetReviewReference):AssetReviewReference{return opened().assertApproved(value,expected);},
    assertReference(value:AssetReviewSubject,reference:AssetReviewReference):void {opened().assertReference(value,reference);},
    close():void {if(closed)return;closed=true;permit=undefined;opens.clear();latestOpen.clear();try{selected?.close();}finally{selected=undefined;receipts?.close();receipts=undefined;}},
  });
}
export type AssetReviewHost=ReturnType<typeof createAssetReviewHost>;
