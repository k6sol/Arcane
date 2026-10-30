import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {parseStudioImportObservationWitness} from '../../../packages/core/src/studio-policy.js';
import {ArcaneError} from '../../../packages/protocol/src/providers.js';
import {STUDIO_ASSET_TRANSFER_LIMITS, object, studioImportContextObservation, type Json, type StudioAssetStageArgs, type StudioAssetStageReceipt, type StudioCommand, type StudioAssetReconstructReceipt,type StudioImportRevisionReceipt} from '../../../packages/protocol/src/studio.js';
import {StudioStore, type StageRunHandle} from '../../../packages/storage/src/studio-store.js';
import {ConversationWorkStore} from '../../../packages/storage/src/conversation-work-store.js';
import {snapshotStudioImportSelection} from '../../../packages/asset-pipeline/src/studio-import-manifest.js';
import {assertDecodedStudioImportPayload} from '../../../packages/asset-pipeline/src/studio-import-payload.js';
import {createStudioImportTransfer,inspectConvertedStudioImportTransfer,measureStudioImportTransferArguments} from '../../../packages/asset-pipeline/src/studio-import-transfer.js';
import {readStudioStagingDiagnostic,studioStagingDiagnosticMessage,type StudioStagingDiagnostic} from '../../../packages/asset-pipeline/src/failure-diagnostics.js';
import type {AssetService} from './asset-service.js';
import {assertStudioImportJobScope} from './asset-import-adapter.js';
import type {StudioImportHostOptions} from './asset-import-adapter.js';
import {assertNativeAssetActor,nativeAssetActorScope,assertNativeAssetStageOperationAvailable,claimNativeAssetStageOperation,assertNativeAssetRevisionOperationAvailable,claimNativeAssetRevisionOperation,acquireNativeAssetWork,type NativeAssetActor} from './native-asset-authority.js';

export interface StudioImportStagingConfiguration {
  projectPath: string;
  workAssociations: ConversationWorkStore;
  studio: StudioStore;
  assets: Pick<AssetService, 'prepareStudioImportPayload'|'reviewImport'>;
  host: StudioImportHostOptions;
  pluginArtifactHash: string;
  now?: () => number;
}
export const STUDIO_STAGING_LIMITS = Object.freeze({packets: STUDIO_ASSET_TRANSFER_LIMITS.packets, rawBytes: STUDIO_ASSET_TRANSFER_LIMITS.rawBytes, envelopeBytes: STUDIO_ASSET_TRANSFER_LIMITS.envelopeBytes, packetDeadlineMs: 10_000, totalDeadlineMs: 120_000});
export interface NativeStageStatus {
  jobId:string;projectId:string;
  stage:null|{runId:string;phase:'running'|'cpu-staged'|'stopped'|'needs_reconciliation';transferDigest:string;
    plannedPacketCount:number;plannedEnvelopeBytes:number;commands:{ordinal:number;commandId:string;state:StudioCommand['state']}[];
    receipt:StudioAssetStageReceipt|null;receiptScope:'historical-cpu';currentBuffers:'unobserved';engineVerification:'pending';imported:false;retry:false};
}
export interface NativeReconstructionStatus {
  jobId:string;projectId:string;
  reconstruction:null|{runId:string;commandId:string;state:StudioCommand['state'];receipt:StudioAssetReconstructReceipt|null;
    receiptScope:'historical-reconstruction';currentResources:'unobserved';imported:false;engineVerification:'pending';retry:false};
}
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
function fail(code: string): never {throw new ArcaneError(code, 'Native asset staging is unavailable, changed or incomplete. No import/upload was accepted.');}
const stageContinuityErrors=new WeakMap<object,StudioStagingDiagnostic>();
class StageContinuityError extends ArcaneError {}
function failStageContinuity(phase:StudioStagingDiagnostic['phase'],reason:StudioStagingDiagnostic['reason'],packetOrdinal:number|null=null):never {
  const diagnostic=readStudioStagingDiagnostic({schemaVersion:1,operation:'stage',phase,reason,packetOrdinal})!;
  const error=new StageContinuityError('STUDIO_STAGE_CONTINUITY',studioStagingDiagnosticMessage(diagnostic));
  stageContinuityErrors.set(error,diagnostic);throw error;
}
/** Original host error only; matching codes or serialized properties cannot mint details. */
export function studioStagingFailureDiagnostic(error:unknown):StudioStagingDiagnostic|null {
  return error&&typeof error==='object'?readStudioStagingDiagnostic(stageContinuityErrors.get(error)):null;
}

/** Host composition, not a request decoder. Keeps exact native authority across
 * preparation and every durable packet receipt. stage() admits CPU bytes only;
 * reconstruct() separately admits one detached engine reconstruction from its
 * original sealed run. Neither operation uploads, parents or admits rights. */
export function createStudioImportStagingController(config: StudioImportStagingConfiguration) {
  const {projectPath, workAssociations, studio, assets, host, pluginArtifactHash} = config;
  if (!(studio instanceof StudioStore) || !(workAssociations instanceof ConversationWorkStore)
    || workAssociations.projectPath !== projectPath || host.workAssociations !== workAssociations
    || typeof assets.prepareStudioImportPayload !== 'function' || typeof assets.reviewImport !== 'function' || typeof host.validateTarget !== 'function'
    || typeof host.releaseTarget !== 'function' || typeof host.beginPreparationAttempt !== 'function' || !/^[a-f0-9]{64}$/.test(pluginArtifactHash)) fail('STUDIO_STAGE_CONFIGURATION');
  const now = config.now ?? Date.now;
  let busy = false, closed = false;
  // This owns lifetime only. Every original actor/review/target/packet fence below
  // still decides admission. A timed-out or lost receipt never proves closure.
  function commandWork(actor:NativeAssetActor,kind:'stage'|'reconstruction'|'revision') {
    const work=acquireNativeAssetWork(actor,kind);
    const commands=new Map<string,Pick<StudioCommand,'id'|'requestId'|'sessionId'|'clientSessionId'|'method'|'leaseEpoch'>>();
    const revisionHashes=kind==='revision'?new Map<string,string>():null;
    let uncertain=false;
    return {
      run<T>(start:()=>T|Promise<T>):Promise<T>{return work.run(start);},
      enqueue(start:()=>StudioCommand):StudioCommand {
        uncertain=true;const command=start();
        commands.set(command.id,{id:command.id,requestId:command.requestId,sessionId:command.sessionId,
          clientSessionId:command.clientSessionId,method:command.method,leaseEpoch:command.leaseEpoch});
        revisionHashes?.set(command.id,sha(JSON.stringify(command.args)));
        uncertain=false;return command;
      },
      finish(cleaned:boolean):void {
        let complete=cleaned&&!uncertain;
        try{for(const [id,identity]of commands){
          const actual=studio.command(id);
          if(Object.entries(identity).some(([key,value])=>actual[key as keyof StudioCommand]!==value)||revisionHashes!==null&&revisionHashes.get(id)!==sha(JSON.stringify(actual.args))||
            !['succeeded','failed','cancelled'].includes(actual.state))complete=false;
        }}catch{complete=false;}
        work.finish(complete?'closed':'unresolved');
      },
    };
  }
  return Object.freeze({
    async status(jobId:string,actor:NativeAssetActor,guard:()=>void=()=>{}):Promise<NativeStageStatus> {
      const check=()=>{
        guard();assertNativeAssetActor(actor,'read');const scope=nativeAssetActorScope(actor);
        if(closed||scope.projectPath!==projectPath||scope.projectId!==workAssociations.projectId)fail('STUDIO_STAGE_SCOPE');
        const binding=workAssociations.binding('asset-job',jobId);
        if(!binding||binding.projectId!==scope.projectId||!isDeepStrictEqual(binding.conversation,scope.conversation))fail('NOT_FOUND');
        return scope;
      };
      const scope=check(),run=studio.readStageRun(scope.projectId,jobId);check();
      if(run&&!isDeepStrictEqual(run.intent.conversation,scope.conversation))fail('NOT_FOUND');
      return {jobId,projectId:scope.projectId,stage:run?{runId:run.runId,phase:run.phase,transferDigest:run.intent.transferDigest,
        plannedPacketCount:run.intent.plan.length,plannedEnvelopeBytes:run.intent.plan.reduce((n,p)=>n+p.envelopeByteLength,0),
        commands:run.commands.map(({ordinal,commandId,command})=>({ordinal,commandId,state:command.state})),
        receipt:run.receipt,receiptScope:'historical-cpu',currentBuffers:'unobserved',engineVerification:'pending',imported:false,retry:false}:null};
    },
    async reconstructionStatus(jobId:string,actor:NativeAssetActor,guard:()=>void=()=>{}):Promise<NativeReconstructionStatus> {
      const check=()=>{
        guard();assertNativeAssetActor(actor,'read');const scope=nativeAssetActorScope(actor);
        if(closed||scope.projectPath!==projectPath||scope.projectId!==workAssociations.projectId)fail('STUDIO_STAGE_SCOPE');
        const binding=workAssociations.binding('asset-job',jobId);
        if(!binding||binding.projectId!==scope.projectId||!isDeepStrictEqual(binding.conversation,scope.conversation))fail('NOT_FOUND');
        return scope;
      };
      const scope=check(),run=studio.readStageRun(scope.projectId,jobId);check();
      if(run&&!isDeepStrictEqual(run.intent.conversation,scope.conversation))fail('NOT_FOUND');
      const record=run?studio.readStageReconstruction(scope.projectId,jobId,run.runId):null;check();
      return {jobId,projectId:scope.projectId,reconstruction:record?{runId:record.runId,commandId:record.command.id,state:record.command.state,
        receipt:record.receipt,receiptScope:'historical-reconstruction',currentResources:'unobserved',imported:false,engineVerification:'pending',retry:false}:null};
    },
    async revisionStatus(jobId:string,actor:NativeAssetActor,guard:()=>void=()=>{}) {
      const check=()=>{guard();assertNativeAssetActor(actor,'read');const scope=nativeAssetActorScope(actor);
        if(closed||scope.projectPath!==projectPath||scope.projectId!==workAssociations.projectId)fail('STUDIO_STAGE_SCOPE');
        const binding=workAssociations.binding('asset-job',jobId);if(!binding||!isDeepStrictEqual(binding.conversation,scope.conversation))fail('NOT_FOUND');return scope;};
      const scope=check(),run=studio.readStageRun(scope.projectId,jobId);check();
      if(run&&!isDeepStrictEqual(run.intent.conversation,scope.conversation))fail('NOT_FOUND');
      const record=run?studio.readStageRevision(scope.projectId,jobId,run.runId):null;check();
      return{jobId,projectId:scope.projectId,revision:record?{runId:run!.runId,commandId:record.command.id,state:record.command.state,receipt:record.receipt,
        receiptScope:'historical-revision' as const,currentResources:'unobserved' as const,imported:false as const,engineVerification:'pending' as const,retry:false as const}:null};
    },
    async applyRevision(jobId:string,actor:NativeAssetActor,guard:()=>void=()=>{}):Promise<StudioImportRevisionReceipt&{commandId:string}> {
      const scope=assertStudioImportJobScope(projectPath,workAssociations,actor,jobId);guard();
      if(closed||busy)fail(closed?'STUDIO_STAGE_CLOSED':'STUDIO_STAGE_BUSY');
      if(!host.validateRevisionObservation||!host.refreshRevisionObservation)fail('STUDIO_REVISE_UNAVAILABLE');
      const run=studio.readStageRun(scope.projectId,jobId);
      if(!run||run.phase!=='cpu-staged'||run.closedAt===null||!run.receipt||!isDeepStrictEqual(run.intent.conversation,scope.conversation)
        ||!run.intent.modelReview)fail('STUDIO_REVISE_STATE');
      const reconstruction=studio.readStageReconstruction(scope.projectId,jobId,run.runId);
      if(!reconstruction?.receipt||reconstruction.command.state!=='succeeded'||reconstruction.command.args.formatVersion!==2)fail('STUDIO_REVISE_STATE');
      if(studio.readStageRevision(scope.projectId,jobId,run.runId))fail('STUDIO_REVISE_EXISTS');
      const begin=object(JSON.parse(run.commands[0]!.command.args.packet as string));
      const observation=parseStudioImportObservationWitness(object(begin.delta).observation);
      assertNativeAssetRevisionOperationAvailable(actor,jobId);
      const work=commandWork(actor,'revision'),expires=now()+STUDIO_STAGING_LIMITS.totalDeadlineMs;
      let reviewCheck:(()=>void)|undefined,queued:StudioCommand|undefined;busy=true;
      const base=()=>{guard();reviewCheck?.();if(closed||now()>=expires||!isDeepStrictEqual(assertStudioImportJobScope(projectPath,workAssociations,actor,jobId),scope))fail('STUDIO_STAGE_SCOPE');
        const session=studio.session(run.intent.target.sessionId),proof=session.proof;
        if(session.revokedAt||!session.allowWrites||!session.capabilities.includes('asset.apply_revision')||!proof||proof.mode!=='Edit'||!proof.connected||!proof.continuitySupported
          ||proof.clientLifetimeId!==run.intent.continuity.clientLifetimeId||session.clientSessionId!==proof.clientLifetimeId||proof.pluginArtifactHash!==pluginArtifactHash
          ||proof.playEpoch!==run.intent.continuity.playEpoch||!Number.isFinite(Date.parse(proof.expiresAt))||Date.parse(proof.expiresAt)<=now())fail('STUDIO_STAGE_CONTINUITY');};
      const boundary=()=>{base();host.validateRevisionObservation!(scope,jobId,actor,observation,base);};
      try{
        const review=await work.run(()=>assets.reviewImport(jobId,actor,run.intent.modelReview!,guard));reviewCheck=()=>review.assertCurrent();boundary();
        // A later tool call owns a NEW native actor. Obtain a NEW plugin-private
        // observation, while the original sealed baseline/delta remains exact.
        const currentObservation=await work.run(()=>host.refreshRevisionObservation!(scope,jobId,actor,observation,base));boundary();
        const current=studio.readStageRun(scope.projectId,jobId,run.runId);
        if(!current||current.intentSha256!==run.intentSha256||current.phase!=='cpu-staged'||!studio.readStageReconstruction(scope.projectId,jobId,run.runId)?.receipt)fail('STUDIO_REVISE_SOURCE');
        boundary();claimNativeAssetRevisionOperation(actor,jobId);
        queued=work.enqueue(()=>studio.enqueueStageRevision(scope.projectId,jobId,run.runId,observation,currentObservation,boundary));
        while(true){
          boundary();const record=studio.readStageRevision(scope.projectId,jobId,run.runId);
          if(!record||record.command.id!==queued.id)fail('STUDIO_REVISE_RECEIPT');
          if(record.receipt){boundary();return{...record.receipt,commandId:queued.id};}
          if(['failed','cancelled','needs_reconciliation'].includes(record.command.state))fail('STUDIO_REVISE_RECEIPT');
          await studio.waitForCommandResult(queued.id,Math.min(25,Math.max(1,expires-now())));
        }
      }finally{
        let cleaned=false;
        try{if(queued)studio.abandonImportCommand(queued.id);cleaned=true;}
        finally{busy=false;work.finish(cleaned);}
      }
    },
    async reconstruct(jobId:string,actor:NativeAssetActor,guard:()=>void=()=>{}):Promise<StudioAssetReconstructReceipt & {commandId:string}> {
      const scope=assertStudioImportJobScope(projectPath,workAssociations,actor,jobId);
      guard();if(closed||busy)fail(closed?'STUDIO_STAGE_CLOSED':'STUDIO_STAGE_BUSY');
      const run=studio.readStageRun(scope.projectId,jobId);
      if(!run||run.phase!=='cpu-staged'||run.closedAt===null||!run.receipt||!isDeepStrictEqual(run.intent.conversation,scope.conversation))fail('STUDIO_RECONSTRUCT_STATE');
      if(studio.readStageReconstruction(scope.projectId,jobId,run.runId))fail('STUDIO_RECONSTRUCT_EXISTS');
      if(!run.intent.modelReview)fail('ASSET_REVIEW_REQUIRED');
      const {target,continuity}=run.intent,expires=now()+STUDIO_STAGING_LIMITS.totalDeadlineMs;
      let reviewCheck:(()=>void)|undefined;
      const boundary=()=>{
        guard();reviewCheck?.();if(closed||!isDeepStrictEqual(assertStudioImportJobScope(projectPath,workAssociations,actor,jobId),scope))fail('STUDIO_STAGE_SCOPE');
        if(now()>=expires)fail('STUDIO_STAGE_TIMEOUT');
        const session=studio.session(target.sessionId),proof=session.proof;
        if(session.revokedAt||!session.allowWrites||!session.allowedRoots.includes('Workspace')||!session.capabilities.includes('asset.reconstruct')
          ||!proof||proof.sessionId!==target.sessionId||session.clientSessionId!==continuity.clientLifetimeId
          ||proof.clientLifetimeId!==continuity.clientLifetimeId||proof.pluginArtifactHash!==pluginArtifactHash||proof.pluginArtifactHash!==continuity.pluginArtifactHash
          ||proof.playEpoch!==continuity.playEpoch||proof.placeId!==target.placeId||proof.universeId!==target.universeId
          ||proof.mode!=='Edit'||!proof.connected||!proof.continuitySupported||!Number.isFinite(Date.parse(proof.expiresAt))||Date.parse(proof.expiresAt)<=now())fail('STUDIO_STAGE_CONTINUITY');
      };
      const work=commandWork(actor,'reconstruction');
      busy=true;let admitted=false;
      try {
        const review=await work.run(()=>assets.reviewImport(jobId,actor,run.intent.modelReview!,guard));
        reviewCheck=()=>review.assertCurrent();boundary();
        // Observe the ORIGINAL target, never select/capture another live place.
        const contextCommand=work.enqueue(()=>studio.enqueue({sessionId:target.sessionId,requestId:'reconstruct_context_'+randomUUID().replaceAll('-',''),method:'scene.import_context',args:{}}));
        const contextDeadline=Math.min(expires,now()+STUDIO_STAGING_LIMITS.packetDeadlineMs);
        while(true){
          boundary();const command=studio.command(contextCommand.id);
          if(command.state==='succeeded'){
            const context=studioImportContextObservation(command.result);
            const creator=context.creator.status==='available'?{kind:context.creator.kind,id:String(context.creator.id)}:
              context.placeId===0&&context.universeId===0&&context.creator.id===0&&context.studioUser.status==='available'?{kind:'user',id:String(context.studioUser.id)}:null;
            if(context.mode!=='Edit'||context.sessionId!==target.sessionId||context.placeId!==target.placeId||context.universeId!==target.universeId
              ||context.parentRef.instanceId!==target.parentRef||!isDeepStrictEqual(creator,target.creator))fail('STUDIO_RECONSTRUCT_TARGET');
            break;
          }
          if(['failed','cancelled','needs_reconciliation'].includes(command.state))fail('STUDIO_RECONSTRUCT_TARGET');
          if(now()>=contextDeadline)fail('STUDIO_STAGE_TIMEOUT');
          await studio.waitForCommandResult(contextCommand.id,Math.min(25,Math.max(1,contextDeadline-now())));
        }
        boundary();admitted=true;
        const queued=work.enqueue(()=>studio.enqueueStageReconstruction(scope.projectId,jobId,run.runId,boundary));
        while(true){
          boundary();const record=studio.readStageReconstruction(scope.projectId,jobId,run.runId);
          if(!record||record.command.id!==queued.id)fail('STUDIO_RECONSTRUCT_RECEIPT');
          if(record.receipt){boundary();return {...record.receipt,commandId:queued.id};}
          if(['failed','cancelled','needs_reconciliation'].includes(record.command.state))fail('STUDIO_RECONSTRUCT_RECEIPT');
          await studio.waitForCommandResult(queued.id,Math.min(25,Math.max(1,expires-now())));
        }
      } finally {
        let cleaned=false;
        try{if(admitted)studio.abandonStageReconstruction(scope.projectId,jobId,run.runId);cleaned=true;}
        finally{busy=false;work.finish(cleaned);}
      }
    },
    async stage(jobId: string, actor: NativeAssetActor, guard: () => void = () => {}): Promise<StudioAssetStageReceipt & {status: 'staged'; imported: false; runId: string; commandIds: string[]}> {
      const scope = assertStudioImportJobScope(projectPath, workAssociations, actor, jobId);
      guard(); if (closed || busy) fail(closed ? 'STUDIO_STAGE_CLOSED' : 'STUDIO_STAGE_BUSY');
      const previous=studio.readStageRun(scope.projectId,jobId);
      if(previous){
        if(previous.closedAt===null)fail('STUDIO_STAGE_BUSY');
        const current=studio.activeSessions().filter(s=>!s.revokedAt&&Number.isFinite(Date.parse(s.lastSeenAt))&&Date.parse(s.lastSeenAt)<=now()&&now()-Date.parse(s.lastSeenAt)<=30_000);
        const proof=current.length===1?current[0]!.proof:null;
        if(!proof)failStageContinuity('prior-attempt-check','proof-missing');
        if(current[0]!.id===previous.intent.target.sessionId&&proof.clientLifetimeId===previous.intent.continuity.clientLifetimeId&&proof.playEpoch<=previous.intent.continuity.playEpoch)fail('STUDIO_STAGE_EXISTS');
      }
      assertNativeAssetStageOperationAvailable(actor, jobId);
      const work=commandWork(actor,'stage');
      busy = true;
      const expires = now() + STUDIO_STAGING_LIMITS.totalDeadlineMs;
      let phase:StudioStagingDiagnostic['phase']='target-check',packetOrdinal:number|null=null;
      let reviewCheck:(()=>void)|undefined,observationCheck:(()=>void)|undefined;
      const base = () => {
        guard();reviewCheck?.();observationCheck?.();
        const current = assertStudioImportJobScope(projectPath, workAssociations, actor, jobId);
        if (closed || !isDeepStrictEqual(current, scope)) fail('STUDIO_STAGE_SCOPE');
        if (now() >= expires) fail('STUDIO_STAGE_TIMEOUT');
      };
      let captured = false, handle:StageRunHandle|null=null;
      try {
        base();
        const preparationAttempt = host.beginPreparationAttempt!(scope,jobId,actor,base);
        const data = await work.run(()=>assets.prepareStudioImportPayload(jobId, actor, preparationAttempt));
        reviewCheck=()=>data.review.assertCurrent();base(); assertDecodedStudioImportPayload(data.payload);
        if(data.prepared.manifest.schemaVersion===2&&'observation'in data.prepared.delta&&data.prepared.delta.observation!==null){
          if(!host.validateRevisionObservation)fail('STUDIO_REVISE_UNAVAILABLE');
          const observation=data.prepared.delta.observation;
          observationCheck=()=>host.validateRevisionObservation!(scope,jobId,actor,observation,guard);base();
        }
        // Rebuild from process-branded immutable decoded chunks. Serialized
        // lookalikes and caller-mutated convenience buffers grant nothing.
        const transfer = createStudioImportTransfer(data.prepared, data.payload);
        if (!isDeepStrictEqual(transfer, data.transfer)) fail('STUDIO_STAGE_IDENTITY');
        const selection = await work.run(()=>host.selectTarget(scope, jobId, actor, base));
        captured = true; base();
        const preparedSelection = snapshotStudioImportSelection({target: data.prepared.manifest.target,
          placement: data.prepared.manifest.placement, studsPerMeter: data.prepared.manifest.conversion.studsPerMeter});
        if (!isDeepStrictEqual(selection, preparedSelection)) fail('STUDIO_STAGE_TARGET');
        const session = studio.session(selection.target.sessionId), proof = session.proof;
        if (!proof || proof.pluginArtifactHash !== pluginArtifactHash || !session.allowWrites || !session.capabilities.includes('asset.stage_packet')) fail('STUDIO_STAGE_CAPABILITY');
        const continuity = {clientLifetimeId: proof.clientLifetimeId, pluginArtifactHash, playEpoch: proof.playEpoch};
        const boundary = () => {
          base(); host.validateTarget!(scope, jobId, selection);
          const actual = studio.session(session.id).proof;
          if(!actual)failStageContinuity(phase,'proof-missing',packetOrdinal);
          if(actual.clientLifetimeId!==continuity.clientLifetimeId)failStageContinuity(phase,'plugin-lifetime-changed',packetOrdinal);
          if(actual.pluginArtifactHash!==pluginArtifactHash)failStageContinuity(phase,'plugin-artifact-changed',packetOrdinal);
          if(actual.playEpoch!==continuity.playEpoch)failStageContinuity(phase,'edit-epoch-changed',packetOrdinal);
          if(actual.mode!=='Edit')failStageContinuity(phase,'not-edit',packetOrdinal);
          if(!actual.connected)failStageContinuity(phase,'disconnected',packetOrdinal);
          if(!actual.continuitySupported)failStageContinuity(phase,'continuity-unsupported',packetOrdinal);
          if(Date.parse(actual.expiresAt)<=now())failStageContinuity(phase,'proof-expired',packetOrdinal);
        };
        boundary();
        // Account for JSON-string escaping and the COMPLETE queue argument
        // envelope before the first command. Keep space for existing receipts.
        const convertedInspection=transfer.formatVersion===2?inspectConvertedStudioImportTransfer(transfer):null;
        if(convertedInspection&&(data.prepared.manifest.schemaVersion!==2||
            !isDeepStrictEqual(convertedInspection.graph,data.prepared.manifest.graph)||
            !isDeepStrictEqual(convertedInspection.begin.delta,data.prepared.delta)||
            !isDeepStrictEqual(convertedInspection.begin.target,selection.target)))fail('STUDIO_STAGE_IDENTITY');
        // The actual selected continuity is available only here. Never claim a
        // durable run using a raw-packet estimate or a serialized transfer clone.
        const measured=transfer.formatVersion===2?measureStudioImportTransferArguments(transfer,selection.target,continuity):null;
        const argumentsList: StudioAssetStageArgs[] = measured?[...measured.arguments]:transfer.packets.map(packet => ({
          expected: {digest: transfer.digest, payloadDigest: transfer.payloadDigest, manifestDigest: data.prepared.manifest.digest},
          packet: packet.json, target: selection.target, continuity,
        }));
        const sizes = measured?[...measured.byteLengths]:argumentsList.map(args => Buffer.byteLength(JSON.stringify(args)));
        const envelopeBytes=sizes.reduce((sum,size)=>sum+size,0),largestEnvelopeBytes=Math.max(0,...sizes);
        if (transfer.byteLength > STUDIO_STAGING_LIMITS.rawBytes || argumentsList.length > STUDIO_STAGING_LIMITS.packets || largestEnvelopeBytes > STUDIO_ASSET_TRANSFER_LIMITS.packetBytes
          || envelopeBytes > STUDIO_STAGING_LIMITS.envelopeBytes) throw new ArcaneError('STUDIO_STAGE_BUDGET',
            `Native asset staging budget exceeded before admission: packets ${argumentsList.length}/${STUDIO_STAGING_LIMITS.packets}, raw bytes ${transfer.byteLength}/${STUDIO_STAGING_LIMITS.rawBytes}, complete-envelope bytes ${envelopeBytes}/${STUDIO_STAGING_LIMITS.envelopeBytes}, largest envelope ${largestEnvelopeBytes}/${STUDIO_ASSET_TRANSFER_LIMITS.packetBytes}. No stage command was queued.`);
        let cumulativeBytes=0;
        const intent={projectId:scope.projectId,jobId,conversation:scope.conversation,preparationAttemptId:preparationAttempt.id,modelReview:data.review.reference,
          transferDigest:transfer.digest,payloadDigest:transfer.payloadDigest,manifestDigest:data.prepared.manifest.digest,preparedDigest:data.prepared.digest,
          target:selection.target,continuity,plan:argumentsList.map((args,ordinal)=>{
            const packetByteLength=transfer.packets[ordinal]!.byteLength;cumulativeBytes+=packetByteLength;
            return {ordinal,argsSha256:sha(JSON.stringify(args)),packetByteLength,envelopeByteLength:sizes[ordinal]!,expectedReceipt:{
              transferDigest:transfer.digest,packetCount:ordinal+1,byteLength:cumulativeBytes,
              state:ordinal===argumentsList.length-1?'sealed' as const:'receiving' as const,engineVerification:'pending' as const}};
          })};
        // Known source/context/target/budget preflight failures consume no stage
        // claim. Latch immediately before durable admission, with NO refund:
        // begin/queue uncertainty must never authorize replay in this turn.
        phase='admission';boundary(); claimNativeAssetStageOperation(actor, jobId);
        const started=previous?studio.beginStageAttempt(intent,previous.runId,boundary):studio.beginStageRun(intent,boundary);
        if(!started.created)fail('STUDIO_STAGE_EXISTS');handle=started.handle;
        const commandIds: string[] = [];
        let last: StudioAssetStageReceipt | null = null, bytes = 0;
        for (const [ordinal, args] of argumentsList.entries()) {
          phase='packet-enqueue';packetOrdinal=ordinal;
          boundary();
          const queued = work.enqueue(()=>studio.enqueueStagePacket(handle!,ordinal,args,boundary));
          commandIds.push(queued.id);
          const deadline = Math.min(expires, now() + STUDIO_STAGING_LIMITS.packetDeadlineMs);
          phase='packet-receipt';
          while (true) {
            boundary();
            const command = studio.command(queued.id);
            if (command.sessionId !== session.id || command.clientSessionId !== continuity.clientLifetimeId
              || command.method !== 'asset.stage_packet' || command.leaseEpoch !== queued.leaseEpoch
              || !isDeepStrictEqual(command.args, args)) fail('STUDIO_STAGE_RECEIPT');
            if (command.state === 'succeeded') {
              bytes += transfer.packets[ordinal]!.byteLength;
              const expected: StudioAssetStageReceipt = {transferDigest: transfer.digest, packetCount: ordinal + 1,
                byteLength: bytes, state: ordinal === argumentsList.length - 1 ? 'sealed' : 'receiving', engineVerification: 'pending'};
              if (!isDeepStrictEqual(command.result, expected)) fail('STUDIO_STAGE_RECEIPT');
              boundary(); last = expected; break;
            }
            if (['failed', 'cancelled', 'needs_reconciliation'].includes(command.state)) fail('STUDIO_STAGE_RECEIPT');
            if (now() >= deadline) fail('STUDIO_STAGE_TIMEOUT');
            await studio.waitForCommandResult(queued.id,Math.min(25,Math.max(1,deadline-now())));
          }
        }
        phase='seal-check';packetOrdinal=null;boundary(); if (!last || last.state !== 'sealed') fail('STUDIO_STAGE_RECEIPT');
        return {...last, status: 'staged', imported: false, runId:started.runId, commandIds};
      } finally {
        // Cancel only an undispatched packet; a delivered unknown result is
        // retained in the durable queue for reconciliation, never replayed.
        let cleaned=false;
        try { if (handle) studio.closeStageRun(handle); cleaned=true; }
        finally { try { if (captured) host.releaseTarget!(scope, jobId); }
          catch(error){cleaned=false;throw error;}
          finally {busy = false;work.finish(cleaned);} }
      }
    },
    close() {closed = true;},
  });
}
