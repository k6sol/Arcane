import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {ArcaneError} from '../../../packages/protocol/src/providers.js';
import {STUDIO_ASSET_TRANSFER_LIMITS, studioImportContextObservation, type Json, type StudioAssetStageArgs, type StudioAssetStageReceipt, type StudioCommand, type StudioAssetReconstructReceipt} from '../../../packages/protocol/src/studio.js';
import {StudioStore, type StageRunHandle} from '../../../packages/storage/src/studio-store.js';
import {ConversationWorkStore} from '../../../packages/storage/src/conversation-work-store.js';
import {snapshotStudioImportSelection} from '../../../packages/asset-pipeline/src/studio-import-manifest.js';
import {assertDecodedStudioImportPayload} from '../../../packages/asset-pipeline/src/studio-import-payload.js';
import {createStudioImportTransfer} from '../../../packages/asset-pipeline/src/studio-import-transfer.js';
import type {AssetService} from './asset-service.js';
import {assertStudioImportJobScope} from './asset-import-adapter.js';
import type {StudioImportHostOptions} from './asset-import-adapter.js';
import {assertNativeAssetActor,nativeAssetActorScope,assertNativeAssetStageOperationAvailable,claimNativeAssetStageOperation,type NativeAssetActor} from './native-asset-authority.js';

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
      busy=true;let admitted=false;
      try {
        const review=await assets.reviewImport(jobId,actor,run.intent.modelReview,guard);
        reviewCheck=()=>review.assertCurrent();boundary();
        // Observe the ORIGINAL target, never select/capture another live place.
        const contextCommand=studio.enqueue({sessionId:target.sessionId,requestId:'reconstruct_context_'+randomUUID().replaceAll('-',''),method:'scene.import_context',args:{}});
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
          await new Promise<void>(resolve=>setTimeout(resolve,25));
        }
        boundary();admitted=true;
        const queued=studio.enqueueStageReconstruction(scope.projectId,jobId,run.runId,boundary);
        while(true){
          boundary();const record=studio.readStageReconstruction(scope.projectId,jobId,run.runId);
          if(!record||record.command.id!==queued.id)fail('STUDIO_RECONSTRUCT_RECEIPT');
          if(record.receipt){boundary();return {...record.receipt,commandId:queued.id};}
          if(['failed','cancelled','needs_reconciliation'].includes(record.command.state))fail('STUDIO_RECONSTRUCT_RECEIPT');
          await new Promise<void>(resolve=>setTimeout(resolve,25));
        }
      } finally {
        try{if(admitted)studio.abandonStageReconstruction(scope.projectId,jobId,run.runId);}finally{busy=false;}
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
        if(!proof)fail('STUDIO_STAGE_CONTINUITY');
        if(current[0]!.id===previous.intent.target.sessionId&&proof.clientLifetimeId===previous.intent.continuity.clientLifetimeId&&proof.playEpoch<=previous.intent.continuity.playEpoch)fail('STUDIO_STAGE_EXISTS');
      }
      assertNativeAssetStageOperationAvailable(actor, jobId);
      busy = true;
      const expires = now() + STUDIO_STAGING_LIMITS.totalDeadlineMs;
      let reviewCheck:(()=>void)|undefined;
      const base = () => {
        guard();reviewCheck?.();
        const current = assertStudioImportJobScope(projectPath, workAssociations, actor, jobId);
        if (closed || !isDeepStrictEqual(current, scope)) fail('STUDIO_STAGE_SCOPE');
        if (now() >= expires) fail('STUDIO_STAGE_TIMEOUT');
      };
      let captured = false, handle:StageRunHandle|null=null;
      try {
        base();
        const preparationAttempt = host.beginPreparationAttempt!(scope,jobId,actor,base);
        const data = await assets.prepareStudioImportPayload(jobId, actor, preparationAttempt);
        reviewCheck=()=>data.review.assertCurrent();base(); assertDecodedStudioImportPayload(data.payload);
        // Rebuild from process-branded immutable decoded chunks. Serialized
        // lookalikes and caller-mutated convenience buffers grant nothing.
        const transfer = createStudioImportTransfer(data.prepared, data.payload);
        if (!isDeepStrictEqual(transfer, data.transfer)) fail('STUDIO_STAGE_IDENTITY');
        const selection = await host.selectTarget(scope, jobId, actor, base);
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
          if (!actual || actual.clientLifetimeId !== continuity.clientLifetimeId || actual.pluginArtifactHash !== pluginArtifactHash
            || actual.playEpoch !== continuity.playEpoch || actual.mode !== 'Edit' || !actual.connected || !actual.continuitySupported
            || Date.parse(actual.expiresAt) <= now()) fail('STUDIO_STAGE_CONTINUITY');
        };
        boundary();
        // Account for JSON-string escaping and the COMPLETE queue argument
        // envelope before the first command. Keep space for existing receipts.
        const argumentsList: StudioAssetStageArgs[] = transfer.packets.map(packet => ({
          expected: {digest: transfer.digest, payloadDigest: transfer.payloadDigest, manifestDigest: data.prepared.manifest.digest},
          packet: packet.json, target: selection.target, continuity,
        }));
        const sizes = argumentsList.map(args => Buffer.byteLength(JSON.stringify(args)));
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
        boundary(); claimNativeAssetStageOperation(actor, jobId);
        const started=previous?studio.beginStageAttempt(intent,previous.runId,boundary):studio.beginStageRun(intent,boundary);
        if(!started.created)fail('STUDIO_STAGE_EXISTS');handle=started.handle;
        const commandIds: string[] = [];
        let last: StudioAssetStageReceipt | null = null, bytes = 0;
        for (const [ordinal, args] of argumentsList.entries()) {
          boundary();
          const queued = studio.enqueueStagePacket(handle,ordinal,args,boundary);
          commandIds.push(queued.id);
          const deadline = Math.min(expires, now() + STUDIO_STAGING_LIMITS.packetDeadlineMs);
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
            await new Promise<void>(resolve => setTimeout(resolve, Math.min(25, Math.max(1, deadline - now()))));
          }
        }
        boundary(); if (!last || last.state !== 'sealed') fail('STUDIO_STAGE_RECEIPT');
        return {...last, status: 'staged', imported: false, runId:started.runId, commandIds};
      } finally {
        // Cancel only an undispatched packet; a delivered unknown result is
        // retained in the durable queue for reconciliation, never replayed.
        try { if (handle) studio.closeStageRun(handle); }
        finally { try { if (captured) host.releaseTarget!(scope, jobId); } finally {busy = false;} }
      }
    },
    close() {closed = true;},
  });
}
