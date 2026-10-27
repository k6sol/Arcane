import {randomUUID} from 'node:crypto';
import {canonical,parseStudioImportObservationWitness,validateStudioImportContextReceipt,validateStudioImportObservationReceipt} from '../../../packages/core/src/studio-policy.js';
import {ArcaneError} from '../../../packages/protocol/src/providers.js';
import {instanceRef,object,type StudioCommand,type StudioImportContextObservation,type StudioImportObservationArgs,type StudioImportObservationReceipt,type StudioImportObservationWitness,type StudioSession,type InstanceRef} from '../../../packages/protocol/src/studio.js';
import {snapshotConvertedStudioImportBaseline,studioImportObservationReceiptDigest,type ConvertedStudioImportBaselineV2,type ConvertedStudioImportManifestV2,type PreparedStudioImport,type StudioImportSelection} from '../../../packages/asset-pipeline/src/studio-import-manifest.js';
import {StudioStore,type ConvertedImportSourcePin} from '../../../packages/storage/src/studio-store.js';
import {ConversationWorkStore} from '../../../packages/storage/src/conversation-work-store.js';
import {assertStudioImportJobScope} from './asset-import-adapter.js';
import {acquireNativeAssetWork,type NativeAssetActor,type NativeAssetScope} from './native-asset-authority.js';
import type {StudioImportPreparationStore} from './studio-import-preparation-store.js';

export interface ObservedBaselineContext {readonly jobId:string;readonly actor:NativeAssetActor;readonly guard:()=>void}
export interface StudioImportObservedBaselineConfiguration {
  projectPath:string;workAssociations:ConversationWorkStore;studio:StudioStore;pluginArtifactHash:string;
  readPreparation:StudioImportPreparationStore['get'];now?:()=>number;
}
interface Entry {
  scope:string;jobId:string;pin:ConvertedImportSourcePin;modelRef:InstanceRef;preparationAttemptId:string|undefined;manifest:ConvertedStudioImportManifestV2;baseline:ConvertedStudioImportBaselineV2|null;
  context:StudioImportContextObservation;stamp:string;preparedDigest:string|null;recordSha256:string;
}
interface CurrentRead {actor:NativeAssetActor;jobId:string;original:string;witness:StudioImportObservationWitness;stamp:string}
const MAX_ENTRIES=64,DEADLINE_MS=10_000;
const key=(scope:NativeAssetScope)=>canonical({projectId:scope.projectId,conversation:scope.conversation});
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
function fail(code:string):never {throw new ArcaneError(code,'The original converted import observation is unavailable or changed. Nothing was applied; never replay an uncertain outcome.');}
function sessionStamp(session:StudioSession):string {
  return canonical({id:session.id,clientSessionId:session.clientSessionId,placeId:session.placeId,universeId:session.universeId,
    pluginVersion:session.pluginVersion,allowedRoots:session.allowedRoots,allowWrites:session.allowWrites,capabilities:session.capabilities,
    artifact:session.proof?.pluginArtifactHash,lifetime:session.proof?.clientLifetimeId,marker:session.proof?.markerName,epoch:session.proof?.playEpoch,mode:session.proof?.mode});
}
function admitted(entry:Entry):ConvertedStudioImportBaselineV2 {if(!entry.baseline)fail('STUDIO_IMPORT_OBSERVATION');return entry.baseline;}
function withoutObservationId(value:StudioImportObservationReceipt):unknown {const {observationId,...state}=value;return state;}

/** Private, process-local custody. Durable journals discover historical source;
 * only a new authenticated queue read observes current private plugin resources. */
export function createStudioImportObservedBaselineStore(config:StudioImportObservedBaselineConfiguration) {
  const {studio,workAssociations,projectPath,pluginArtifactHash}=config,now=config.now??Date.now;
  if(!(studio instanceof StudioStore)||!(workAssociations instanceof ConversationWorkStore)||workAssociations.projectPath!==projectPath||typeof config.readPreparation!=='function')fail('STUDIO_IMPORT_CONFIGURATION');
  const entries=new Map<string,Entry>(),activeReads=new WeakMap<NativeAssetActor,Map<string,CurrentRead>>();let closed=false;
  function check(scope:NativeAssetScope,jobId:string,actor:NativeAssetActor,guard:()=>void):void {
    guard();if(closed||scope.projectPath!==projectPath||key(assertStudioImportJobScope(projectPath,workAssociations,actor,jobId))!==key(scope))fail('STUDIO_IMPORT_SCOPE');
  }
  function boundary(entry:Entry,scope:NativeAssetScope,jobId:string,actor:NativeAssetActor,guard:()=>void):void {
    check(scope,jobId,actor,guard);check(scope,entry.pin.source.jobId,actor,guard);studio.assertConvertedImportSource(entry.pin);
    const session=studio.session(entry.pin.target.sessionId),proof=session.proof,t=now();
    if(session.revokedAt||!session.allowWrites||!session.allowedRoots.includes('Workspace')||!proof||!proof.connected||!proof.continuitySupported||proof.mode!=='Edit'
      ||proof.clientLifetimeId!==entry.pin.continuity.clientLifetimeId||session.clientSessionId!==proof.clientLifetimeId
      ||proof.pluginArtifactHash!==pluginArtifactHash||proof.pluginArtifactHash!==entry.pin.continuity.pluginArtifactHash
      ||proof.playEpoch!==entry.pin.continuity.playEpoch||proof.placeId!==session.placeId||proof.universeId!==session.universeId
      ||!Number.isFinite(Date.parse(proof.expiresAt))||Date.parse(proof.expiresAt)<=t||!Number.isFinite(Date.parse(session.lastSeenAt))||Date.parse(session.lastSeenAt)>t||t-Date.parse(session.lastSeenAt)>30_000
      ||sessionStamp(session)!==entry.stamp)fail('STUDIO_IMPORT_CONTINUITY');
  }
  async function read<T>(actor:NativeAssetActor,start:()=>StudioCommand,parse:(command:StudioCommand)=>T,guard:()=>void):Promise<{value:T;command:StudioCommand}> {
    const work=acquireNativeAssetWork(actor,'preparation'),end=now()+DEADLINE_MS;let command:StudioCommand|undefined,attempted=false;
    try{return await work.run(async()=>{
      guard();attempted=true;command=start();
      while(true){
        guard();if(now()>=end)fail('STUDIO_IMPORT_CONTEXT_TIMEOUT');const actual=studio.command(command.id);
        if(actual.id!==command.id||actual.requestId!==command.requestId||actual.sessionId!==command.sessionId||actual.clientSessionId!==command.clientSessionId
          ||actual.method!==command.method||actual.leaseEpoch!==command.leaseEpoch||!same(actual.args,command.args))fail('STUDIO_IMPORT_RECEIPT');
        if(actual.state==='succeeded'){const value=parse(actual);guard();return{value,command:actual};}
        if(['failed','cancelled','needs_reconciliation'].includes(actual.state))fail('STUDIO_IMPORT_RECEIPT');
        await studio.waitForCommandResult(command.id,Math.min(25,Math.max(1,end-now())));
      }
    });}finally{
      let complete=!attempted;
      if(command)try{const actual=studio.command(command.id);complete=actual.id===command.id&&actual.requestId===command.requestId&&actual.sessionId===command.sessionId&&actual.clientSessionId===command.clientSessionId
        &&actual.method===command.method&&actual.leaseEpoch===command.leaseEpoch&&same(actual.args,command.args)&&['succeeded','failed','cancelled'].includes(actual.state);}catch{complete=false;}
      work.finish(complete?'closed':'unresolved');
    }
  }
  async function observe(entry:Entry,scope:NativeAssetScope,jobId:string,actor:NativeAssetActor,guard:()=>void):Promise<StudioImportObservationWitness> {
    const check=()=>boundary(entry,scope,jobId,actor,guard),intent=entry.pin;check();
    const context=await read(actor,()=>studio.enqueue({sessionId:intent.target.sessionId,requestId:'observe_context_'+randomUUID().replaceAll('-',''),method:'scene.import_context',args:{}}),
      command=>validateStudioImportContextReceipt(command,studio.session(intent.target.sessionId)),check);check();
    if(!same(context.value,entry.context))fail('STUDIO_IMPORT_CONTINUITY');
    const modelRef=entry.modelRef;
    const args:StudioImportObservationArgs={formatVersion:2,observationId:randomUUID(),source:entry.pin.source,target:intent.target,continuity:intent.continuity,modelRef};
    const observed=await read(actor,()=>studio.enqueueImportObservation(args,check),command=>validateStudioImportObservationReceipt(args,command.result),check);check();
    const witness=parseStudioImportObservationWitness({commandId:observed.command.id,receiptSha256:studioImportObservationReceiptDigest(observed.value),observation:observed.value});
    // This also checks the complete original selected node/object inventory and
    // intentional mesh-bearing node/ref overlap, not just advertised digests.
    snapshotConvertedStudioImportBaseline({manifest:entry.manifest,receipt:witness});
    for(const mesh of witness.observation.objects){
      if(mesh.meshAssetId===null)continue;
      const recorded=studio.convertedImportKeepObjects(entry.pin).some(row=>row.sourceObjectId===mesh.sourceObjectId&&row.meshAssetId===mesh.meshAssetId&&row.instanceRef===mesh.instanceRef);
      if(!recorded)fail('STUDIO_IMPORT_SOURCE');
    }
    return witness;
  }
  async function retained(entry:Entry,scope:NativeAssetScope,jobId:string,actor:NativeAssetActor,guard:()=>void):Promise<void> {
    boundary(entry,scope,jobId,actor,guard);
    const record=await config.readPreparation(actor,entry.pin.source.jobId,guard,entry.preparationAttemptId);
    boundary(entry,scope,jobId,actor,guard);
    if(!record||record.recordSha256!==entry.recordSha256||record.prepared.manifest.schemaVersion!==2||!same(record.prepared.manifest,entry.manifest)||record.prepared.digest!==entry.pin.source.preparedDigest)fail('STUDIO_IMPORT_SOURCE');
  }
  function validate(scope:NativeAssetScope,jobId:string,actor:NativeAssetActor,value:unknown,guard:()=>void):Entry {
    const witness=parseStudioImportObservationWitness(value),entry=entries.get(jobId);
    if(!entry||entry.scope!==key(scope)||!same(admitted(entry).receipt,witness))fail('STUDIO_IMPORT_OBSERVATION');
    boundary(entry,scope,jobId,actor,guard);
    const command=studio.command(witness.commandId);
    if(command.method!=='scene.observe_import'||command.state!=='succeeded'||command.clientSessionId!==entry.pin.continuity.clientLifetimeId
      ||!same(validateStudioImportObservationReceipt(command.args,command.result),witness.observation))fail('STUDIO_IMPORT_RECEIPT');
    return entry;
  }
  return Object.freeze({
    async load(scope:NativeAssetScope,assetId:string,target:StudioImportSelection['target'],context:ObservedBaselineContext):Promise<ConvertedStudioImportBaselineV2|null>{
      const {jobId,actor,guard}=context;check(scope,jobId,actor,guard);
      const source=studio.readConvertedImportSource(scope.projectId,scope.conversation,assetId,target);check(scope,jobId,actor,guard);
      if(!source)return null;
      check(scope,source.source.jobId,actor,guard);
      const record=await config.readPreparation(actor,source.source.jobId,guard,source.run.intent.preparationAttemptId);check(scope,jobId,actor,guard);check(scope,source.source.jobId,actor,guard);
      if(!record||record.projectId!==scope.projectId||!same(record.conversation,scope.conversation)||record.prepared.manifest.schemaVersion!==2
        ||record.prepared.digest!==source.source.preparedDigest||record.prepared.manifest.digest!==source.source.manifestDigest
        ||record.prepared.manifest.assetId!==assetId||record.prepared.manifest.sourceSha256!==source.source.sourceSha256
        ||record.prepared.manifest.graph.digest!==source.source.graphDigest||!same(record.prepared.manifest.target,target)
        ||!same(record.witness,{initialContextReceiptId:record.witness.initialContextReceiptId,confirmedContextReceiptId:record.witness.confirmedContextReceiptId,...source.run.intent.continuity}))fail('STUDIO_IMPORT_SOURCE');
      const session=studio.session(target.sessionId),oldContext=validateStudioImportContextReceipt(studio.command(record.witness.confirmedContextReceiptId),session);
      // Temporary baseline is used only as a manifest holder until the real live
      // read is returned; it is never published or parsed as a receipt.
      const placement=source.placement,result=object(placement.result),modelRef=instanceRef(placement.method==='asset.apply_revision'?result.modelRef:object(result.mutation).ref);
      const entry:Entry={scope:key(scope),jobId,pin:studio.captureConvertedImportSource(source),modelRef,preparationAttemptId:source.run.intent.preparationAttemptId,manifest:record.prepared.manifest,baseline:null,context:oldContext,stamp:sessionStamp(session),preparedDigest:null,recordSha256:record.recordSha256};
      boundary(entry,scope,jobId,actor,guard);
      const witness=await observe(entry,scope,jobId,actor,guard);await retained(entry,scope,jobId,actor,guard);
      const baseline=snapshotConvertedStudioImportBaseline({manifest:record.prepared.manifest,receipt:witness});entry.baseline=baseline;entry.manifest=baseline.manifest;
      if(!entries.has(jobId)&&entries.size>=MAX_ENTRIES)fail('STUDIO_IMPORT_BUSY');entries.set(jobId,entry);return baseline;
    },
    record(scope:NativeAssetScope,jobId:string,actor:NativeAssetActor,prepared:PreparedStudioImport,guard:()=>void):void {
      if(prepared.manifest.schemaVersion!==2||!('observation'in prepared.delta)||prepared.delta.observation===null)return;
      const entry=validate(scope,jobId,actor,prepared.delta.observation,guard);
      if(prepared.manifest.sourceSha256!==entry.pin.source.sourceSha256||prepared.manifest.assetId!==entry.pin.source.assetId||!same(prepared.manifest.target,entry.pin.target))fail('STUDIO_IMPORT_SOURCE');
      entry.preparedDigest=prepared.digest;
    },
    validate(scope:NativeAssetScope,jobId:string,actor:NativeAssetActor,value:unknown,guard:()=>void):void {
      const entry=validate(scope,jobId,actor,value,guard);if(!entry.preparedDigest)fail('STUDIO_IMPORT_OBSERVATION');
      const run=studio.readStageRun(scope.projectId,jobId);
      if(run&&(run.intent.preparedDigest!==entry.preparedDigest||run.commands.length>0&&!same(object(object(JSON.parse(run.commands[0]!.command.args.packet as string)).delta).observation,admitted(entry).receipt)))fail('STUDIO_IMPORT_OBSERVATION');
      const current=activeReads.get(actor)?.get(jobId);
      if(current){const command=studio.command(current.witness.commandId);
        if(current.original!==canonical(admitted(entry).receipt)||current.stamp!==entry.stamp||command.state!=='succeeded'
          ||!same(validateStudioImportObservationReceipt(command.args,command.result),current.witness.observation))fail('STUDIO_IMPORT_RECEIPT');}
    },
    async refresh(scope:NativeAssetScope,jobId:string,actor:NativeAssetActor,value:unknown,guard:()=>void):Promise<StudioImportObservationWitness>{
      const entry=validate(scope,jobId,actor,value,guard);if(!entry.preparedDigest)fail('STUDIO_IMPORT_OBSERVATION');
      await retained(entry,scope,jobId,actor,guard);
      const witness=await observe(entry,scope,jobId,actor,guard);await retained(entry,scope,jobId,actor,guard);
      if(witness.commandId===admitted(entry).receipt.commandId||witness.observation.observationId===admitted(entry).receipt.observation.observationId
        ||!same(withoutObservationId(witness.observation),withoutObservationId(admitted(entry).receipt.observation)))fail('STUDIO_IMPORT_OBSERVATION');
      const current={actor,jobId,original:canonical(admitted(entry).receipt),witness,stamp:entry.stamp};
      let byJob=activeReads.get(actor);if(!byJob){byJob=new Map();activeReads.set(actor,byJob);}byJob.set(jobId,current);return witness;
    },
    close(){closed=true;entries.clear();},
  });
}
