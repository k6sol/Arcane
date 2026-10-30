import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {CallToolResultSchema} from '@modelcontextprotocol/sdk/types.js';
import type {StudioStore} from '../../../packages/storage/src/studio-store.js';
import {digest,StudioTestError,type Scheduler} from '../../../packages/studio-test-controller/src/contracts.js';
import {nativeAssetSearchSchema,nativeAssetInsertSchema,nativeAssetGenerateSchema,searchNativeAssets,insertNativeAsset,startNativeGeneration,waitNativeJob,
  NATIVE_REFUSAL_CODES,NativeAssetRefusal,type NativeAssetContext,type JobState,type NativeRefusal} from '../../../packages/studio-test-controller/src/native-assets.js';
import {decodeTestInventory,decodeTestMode} from './studio-test-decoders.js';
import type {NativeTestConnection} from './studio-test-service.js';
import {assertNativeModelSource,type NativeAssetActor} from './native-asset-authority.js';

/** Rolling ten-minute budgets per daemon (one native asset operation at a time). */
export const NATIVE_ASSET_RATE=Object.freeze({windowMs:600_000,search:40,insert:24,generate:8,searchedTtlMs:30*60_000,searchedIds:512,jobs:16,jobTtlMs:30*60_000});
const DEADLINE=Object.freeze({search:18_000,insert:23_000,generate:28_000,job:28_000});
const jobInput=z.strictObject({jobId:z.string().uuid()});
/** Host refusals with fixed route messages (never native text). */
export class NativeAssetHostRefusal extends Error {
  constructor(readonly code:'RATE_LIMITED'|'ASSET_NOT_SEARCHED'|'ASSET_WATCH_REQUIRED'|'ASSET_JOB_NOT_FOUND'|'TOOLBOX_MODELS_DISABLED'|'BLENDER_REQUIRED'){super(code);this.name='NativeAssetHostRefusal';}
}
type Session=ReturnType<StudioStore['session']>;
function rejected(code:'BUSY'|'STALE_PROOF'|'BINDING_CHANGED'|'HUMAN_AUTH_REQUIRED'|'INVALID_REQUEST'):never{throw new StudioTestError(code);}
interface Job{id:string;actor:string;sessionId:string;nativeStudioId:string;kind:'mesh'|'material'|'texture';nativeJobId:string|null;state:JobState;
  refusal:NativeRefusal|null;watch:string|null;materialVariant:string|null;baseMaterial:string|null;createdAt:number}
export interface NativeAssetDependencies{
  store:StudioStore;pluginArtifactHash:string;connect:(operation:'asset-search'|'asset-insert'|'asset-job')=>Promise<NativeTestConnection>;fixtureScheduler?:Scheduler;
  assertCurrent?:(connection:NativeTestConnection)=>void;assertReady?:()=>void;
  /** Exact eligible pairing (unpublished place, write grant) or a thrown refusal. */
  eligible(sessionId:string):Session;identity(session:Session):string;
  /** True while a playtest, preparation or viewport capture owns the native connection. */
  busy():boolean;
  revokeModelSource?:(sessionId:string)=>void;
}
/** Internal HTTP lifecycle only. No field is accepted in tool/request JSON. */
export interface NativeAssetRequestScope { guard():void; signal:AbortSignal; dispatched():void; readonly modelSource?:NativeAssetActor }

/** Native asset search/insert/generation for the exact paired Edit session. The built-in tools
 * run only after a fresh mapping witness and Edit-mode check, which are repeated afterwards. */
export function createNativeAssetRequests(deps:NativeAssetDependencies){
  let active=false,closed=false;
  // Only the authenticated human-control surface may change this session choice.
  // A fresh daemon, pairing, proof epoch or expired choice restores original assets.
  const modelChoices=new Map<string,{binding:string;expires:number}>();
  const modelPolicyInput=z.strictObject({sessionId:z.string().min(1).max(128),allowModels:z.boolean().optional()});
  const binding=(session:Session)=>digest({scope:deps.identity(session),proof:session.proof&&{lifetime:session.proof.clientLifetimeId,epoch:session.proof.playEpoch,marker:session.proof.markerName,artifact:session.proof.pluginArtifactHash}});
  const modelsAllowed=(sessionId:string)=>{const s=deps.eligible(sessionId),choice=modelChoices.get(sessionId);return !!choice&&choice.expires>Date.now()&&choice.binding===binding(s)&&s.proof?.connected===true&&Date.parse(s.proof.expiresAt)>Date.now();};
  const releasePolicy=deps.store.bindModelSourcePolicy((sessionId,admission)=>{
    if(closed)return false;
    if(admission===undefined)return modelsAllowed(sessionId); // Explicit human/manual route only.
    try{assertNativeModelSource(admission as NativeAssetActor,sessionId);return true;}catch{return false;}
  });
  const requireModels=(sessionId:string,actor:string,request?:NativeAssetRequestScope)=>{
    if(closed)throw new NativeAssetHostRefusal('TOOLBOX_MODELS_DISABLED');
    if(actor==='human'){if(modelsAllowed(sessionId))return;}
    else if(request?.modelSource){try{assertNativeModelSource(request.modelSource,sessionId);return;}catch{/* Fixed denial; never expose private scope. */}}
    throw new NativeAssetHostRefusal('TOOLBOX_MODELS_DISABLED');
  };
  const times={search:[] as number[],insert:[] as number[],generate:[] as number[]};
  const searched=new Map<string,number>(),jobs=new Map<string,Job>();
  const admit=(kind:keyof typeof times)=>{
    const now=Date.now(),list=times[kind];while(list.length&&now-list[0]!>NATIVE_ASSET_RATE.windowMs)list.shift();
    if(list.length>=NATIVE_ASSET_RATE[kind])throw new NativeAssetHostRefusal('RATE_LIMITED');
    list.push(now);
  };
  const idle=()=>{deps.assertReady?.();if(active||deps.busy())rejected('BUSY');};
  const actorOk=(actor:string)=>{if(!/^[A-Za-z0-9_-]{1,128}$/.test(actor))rejected('HUMAN_AUTH_REQUIRED');};
  const current=(request?:NativeAssetRequestScope)=>{request?.guard();request?.signal.throwIfAborted();};
  const watched=(session:Session,watch:string)=>deps.store.commands(session.id).some(command=>command.method==='scene.asset_watch'&&command.state==='succeeded'
    &&command.finishedAt!==null&&Date.now()-Date.parse(command.finishedAt)<=600_000&&(command.result as {watch?:unknown}|null)?.watch===watch);
  /** Bracket one operation with the exact paired session's native binding. */
  const withNative=async<T>(operation:'asset-search'|'asset-insert'|'asset-job',sessionId:string,requested:string|undefined,deadlineMs:number,action:(context:NativeAssetContext,session:Session,nativeStudioId:string,signal:AbortSignal)=>Promise<T>,policy:()=>void=()=>{},request?:NativeAssetRequestScope):Promise<T>=>{
    current(request);deps.assertReady?.();
    if(active||deps.busy())rejected('BUSY');
    const session=deps.eligible(sessionId),p=session.proof;
    if(!p||!p.connected||p.pluginArtifactHash!==deps.pluginArtifactHash||Date.parse(p.expiresAt)<=Date.now())rejected('STALE_PROOF');
    if(p.mode!=='Edit')throw new StudioTestError('MODE_MISMATCH');
    active=true;let connection:NativeTestConnection|undefined,failed=false;
    try{
      connection=await deps.connect(operation);
      deps.assertCurrent?.(connection);current(request);
      if(deps.fixtureScheduler&&connection.evidence!=='fixture')rejected('INVALID_REQUEST');
      const native=connection,timeout=AbortSignal.timeout(deadlineMs),signal=request?AbortSignal.any([timeout,request.signal]):timeout;
      const inventory=decodeTestInventory(await native.client.callTool({name:'list_roblox_studios',arguments:{}},CallToolResultSchema,{signal,timeout:5000,maxTotalTimeout:5000})) as {id:string;name:string}[];
      deps.assertCurrent?.(native);
      const candidates=requested?inventory.filter(s=>s.id===requested):inventory.filter(s=>s.name===session.name);
      if(candidates.length!==1)rejected('BINDING_CHANGED');
      const nativeStudioId=candidates[0]!.id,scope=deps.identity(session);
      const verifyBinding=async(local:AbortSignal)=>{
        deps.assertCurrent?.(native);
        const s=deps.eligible(session.id),proof=s.proof;
        if(!proof||!proof.connected||proof.mode!=='Edit'||Date.parse(proof.expiresAt)<=Date.now()||proof.clientLifetimeId!==p.clientLifetimeId||proof.pluginArtifactHash!==deps.pluginArtifactHash||proof.markerName!==p.markerName||deps.identity(s)!==scope)rejected('BINDING_CHANGED');
        const witness=await native.witness(nativeStudioId,proof.markerName,'Edit',local);
        deps.assertCurrent?.(native);
        if(witness.placeId!==0||witness.universeId!==s.universeId||witness.sessionId!==s.id||witness.clientLifetimeId!==s.clientSessionId||witness.pluginArtifactHash!==deps.pluginArtifactHash)rejected('BINDING_CHANGED');
        return digest({scope,nativeStudioId,clientLifetimeId:proof.clientLifetimeId,playEpoch:proof.playEpoch,markerName:proof.markerName});
      };
      const context:NativeAssetContext={client:native.client,nativeStudioId,verifyBinding,authorize:()=>{deps.assertCurrent?.(native);current(request);policy();},...(request?{dispatched:request.dispatched}:{}),decodeMode:decodeTestMode,...(deps.fixtureScheduler?{scheduler:deps.fixtureScheduler}:{})};
      const result=await action(context,session,nativeStudioId,signal);deps.assertCurrent?.(native);return result;
    }catch(error){failed=true;throw error;}finally{try{if(connection)await connection.close();}catch(error){if(!failed)throw error;}finally{active=false;}}
  };
  const view=(job:Job)=>({job:{jobId:job.id,kind:job.kind,state:job.state,sessionId:job.sessionId,nativeStudioId:job.nativeStudioId,
    watch:job.watch,materialVariant:job.state==='completed'?job.materialVariant:null,baseMaterial:job.baseMaterial,
    failure:job.state==='failed'?NATIVE_REFUSAL_CODES[job.refusal??'rejected']:null}});
  const prune=()=>{const now=Date.now();for(const [id,job] of jobs)if(now-job.createdAt>NATIVE_ASSET_RATE.jobTtlMs)jobs.delete(id);for(const [key,expires] of searched)if(expires<=now)searched.delete(key);};
  return Object.freeze({
    active:()=>active,
    close(){closed=true;releasePolicy();modelChoices.clear();},
    toolboxPolicy(input:unknown,guard:()=>void){
      guard();const a=modelPolicyInput.parse(input),s=deps.eligible(a.sessionId);
      if(a.allowModels!==undefined){
        if(a.allowModels){if(!s.proof?.connected||s.proof.mode!=='Edit'||Date.parse(s.proof.expiresAt)<=Date.now())rejected('STALE_PROOF');guard();if(!modelChoices.has(s.id)&&modelChoices.size>=128)modelChoices.delete(modelChoices.keys().next().value!);modelChoices.set(s.id,{binding:binding(s),expires:Date.now()+NATIVE_ASSET_RATE.searchedTtlMs});}
        else {guard();modelChoices.delete(s.id);deps.revokeModelSource?.(s.id);for(const key of searched.keys())if(key.startsWith(s.id+':'))searched.delete(key);}
      }
      return {sessionId:s.id,allowModels:modelsAllowed(s.id)};
    },
    /** Read-only Creator Store/inventory search: free results only, bounded pages. */
    async search(input:unknown,actor:string,request?:NativeAssetRequestScope){
      actorOk(actor);current(request);const a=nativeAssetSearchSchema.parse(input);if(a.category!=='Audio')requireModels(a.sessionId,actor,request);prune();idle();admit('search');
      return withNative('asset-search',a.sessionId,a.nativeStudioId,DEADLINE.search,async(context,session,nativeStudioId,signal)=>{
        const found=await searchNativeAssets(context,a,signal);
        // Audio ids are Sound.SoundId values only; they never become insertable.
        for(const item of a.category==='Audio'?[]:found.results){
          searched.delete(session.id+':'+actor+':'+item.id);searched.set(session.id+':'+actor+':'+item.id,Date.now()+NATIVE_ASSET_RATE.searchedTtlMs);
          while(searched.size>NATIVE_ASSET_RATE.searchedIds)searched.delete(searched.keys().next().value!);
        }
        return {search:{sessionId:session.id,nativeStudioId,query:a.query,category:a.category,page:a.page,pageSize:a.pageSize,results:found.results,hasMore:found.hasMore}};
      },()=>{if(a.category!=='Audio')requireModels(a.sessionId,actor,request);},request);
    },
    /** Insert one previously searched free asset; the plugin adopts it under the armed watch. */
    async insert(input:unknown,actor:string,request?:NativeAssetRequestScope){
      actorOk(actor);current(request);const a=nativeAssetInsertSchema.parse(input);requireModels(a.sessionId,actor,request);prune();
      if((searched.get(a.sessionId+':'+actor+':'+a.assetId)??0)<=Date.now())throw new NativeAssetHostRefusal('ASSET_NOT_SEARCHED');
      if(!watched(deps.eligible(a.sessionId),a.watch))throw new NativeAssetHostRefusal('ASSET_WATCH_REQUIRED');
      idle();admit('insert');
      return withNative('asset-insert',a.sessionId,a.nativeStudioId,DEADLINE.insert,async(context,session,nativeStudioId,signal)=>{
        const inserted=await insertNativeAsset(context,a,signal);
        return {insert:{sessionId:session.id,nativeStudioId,assetId:a.assetId,assetName:inserted.assetName,acknowledgement:inserted.outcome}};
      },()=>requireModels(a.sessionId,actor,request),request);
    },
    async generate(input:unknown,actor:string,request?:NativeAssetRequestScope):Promise<never>{
      actorOk(actor);current(request);nativeAssetGenerateSchema.parse(input);
      // Geometry, UVs, textures and PBR are authored locally; this policy is
      // enforced before connecting to Studio, including direct HTTP callers.
      throw new NativeAssetHostRefusal('BLENDER_REQUIRED');
    },
    /** Bounded wait on one caller-owned generation job; never restarts it. */
    async job(input:unknown,actor:string,request?:NativeAssetRequestScope){
      actorOk(actor);current(request);const a=jobInput.parse(input);prune();
      const job=jobs.get(a.jobId);
      if(!job||!(actor==='human'||actor===job.actor))throw new NativeAssetHostRefusal('ASSET_JOB_NOT_FOUND');
      if(job.state!=='running'||!job.nativeJobId)return view(job);
      return withNative('asset-job',job.sessionId,job.nativeStudioId,DEADLINE.job,async(context,_session,nativeStudioId,signal)=>{
        if(nativeStudioId!==job.nativeStudioId)rejected('BINDING_CHANGED');
        const waited=await waitNativeJob(context,job.nativeJobId!,18_000,signal);job.state=waited.state;job.refusal=waited.refusal;
        return view(job);
      },()=>{},request);
    },
  });
}
export type NativeAssetRequests=ReturnType<typeof createNativeAssetRequests>;
