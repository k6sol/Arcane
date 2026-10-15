import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {ArcaneError} from '../../../packages/protocol/src/providers.js';
import type {Json, StudioAssetStageArgs, StudioAssetStageReceipt, StudioCommand} from '../../../packages/protocol/src/studio.js';
import {StudioStore, type StageRunHandle} from '../../../packages/storage/src/studio-store.js';
import {ConversationWorkStore} from '../../../packages/storage/src/conversation-work-store.js';
import {snapshotStudioImportSelection} from '../../../packages/asset-pipeline/src/studio-import-manifest.js';
import {assertDecodedStudioImportPayload} from '../../../packages/asset-pipeline/src/studio-import-payload.js';
import {createStudioImportTransfer} from '../../../packages/asset-pipeline/src/studio-import-transfer.js';
import type {AssetService} from './asset-service.js';
import {assertStudioImportJobScope} from './asset-import-adapter.js';
import type {StudioImportHostOptions} from './asset-import-adapter.js';
import {assertNativeAssetActor,nativeAssetActorScope,type NativeAssetActor} from './native-asset-authority.js';

export interface StudioImportStagingConfiguration {
  projectPath: string;
  workAssociations: ConversationWorkStore;
  studio: StudioStore;
  assets: Pick<AssetService, 'prepareStudioImportPayload'>;
  host: StudioImportHostOptions;
  pluginArtifactHash: string;
  now?: () => number;
}
export const STUDIO_STAGING_LIMITS = Object.freeze({packets: 512, envelopeBytes: 8 * 1024 * 1024, packetDeadlineMs: 10_000, totalDeadlineMs: 120_000});
export interface NativeStageStatus {
  jobId:string;projectId:string;
  stage:null|{runId:string;phase:'running'|'cpu-staged'|'stopped'|'needs_reconciliation';transferDigest:string;
    plannedPacketCount:number;plannedEnvelopeBytes:number;commands:{ordinal:number;commandId:string;state:StudioCommand['state']}[];
    receipt:StudioAssetStageReceipt|null;engineVerification:'pending';imported:false;retry:false};
}
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
function fail(code: string): never {throw new ArcaneError(code, 'Native asset staging is unavailable, changed or incomplete. No import/upload was accepted.');}

/** Host composition, not a request decoder. Keeps exact native authority across
 * preparation and every durable packet receipt. This stage does NOT upload,
 * allocate EditableMesh, parent Instances or claim an engine baseline. */
export function createStudioImportStagingController(config: StudioImportStagingConfiguration) {
  const {projectPath, workAssociations, studio, assets, host, pluginArtifactHash} = config;
  if (!(studio instanceof StudioStore) || !(workAssociations instanceof ConversationWorkStore)
    || workAssociations.projectPath !== projectPath || host.workAssociations !== workAssociations
    || typeof assets.prepareStudioImportPayload !== 'function' || typeof host.validateTarget !== 'function'
    || typeof host.releaseTarget !== 'function' || !/^[a-f0-9]{64}$/.test(pluginArtifactHash)) fail('STUDIO_STAGE_CONFIGURATION');
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
        receipt:run.receipt,engineVerification:'pending',imported:false,retry:false}:null};
    },
    async stage(jobId: string, actor: NativeAssetActor, guard: () => void = () => {}): Promise<StudioAssetStageReceipt & {status: 'staged'; imported: false; commandIds: string[]}> {
      const scope = assertStudioImportJobScope(projectPath, workAssociations, actor, jobId);
      guard(); if (closed || busy) fail(closed ? 'STUDIO_STAGE_CLOSED' : 'STUDIO_STAGE_BUSY');
      if(studio.readStageRun(scope.projectId,jobId))fail('STUDIO_STAGE_EXISTS');
      busy = true;
      const expires = now() + STUDIO_STAGING_LIMITS.totalDeadlineMs;
      const base = () => {
        guard();
        const current = assertStudioImportJobScope(projectPath, workAssociations, actor, jobId);
        if (closed || !isDeepStrictEqual(current, scope)) fail('STUDIO_STAGE_SCOPE');
        if (now() >= expires) fail('STUDIO_STAGE_TIMEOUT');
      };
      let captured = false, handle:StageRunHandle|null=null;
      try {
        base();
        const data = await assets.prepareStudioImportPayload(jobId, actor);
        base(); assertDecodedStudioImportPayload(data.payload);
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
        if (argumentsList.length > STUDIO_STAGING_LIMITS.packets || sizes.some(size => size > 256 * 1024)
          || sizes.reduce((sum, size) => sum + size, 0) > STUDIO_STAGING_LIMITS.envelopeBytes) fail('STUDIO_STAGE_BUDGET');
        let cumulativeBytes=0;
        const started=studio.beginStageRun({projectId:scope.projectId,jobId,conversation:scope.conversation,
          transferDigest:transfer.digest,payloadDigest:transfer.payloadDigest,manifestDigest:data.prepared.manifest.digest,preparedDigest:data.prepared.digest,
          target:selection.target,continuity,plan:argumentsList.map((args,ordinal)=>{
            const packetByteLength=transfer.packets[ordinal]!.byteLength;cumulativeBytes+=packetByteLength;
            return {ordinal,argsSha256:sha(JSON.stringify(args)),packetByteLength,envelopeByteLength:sizes[ordinal]!,expectedReceipt:{
              transferDigest:transfer.digest,packetCount:ordinal+1,byteLength:cumulativeBytes,
              state:ordinal===argumentsList.length-1?'sealed' as const:'receiving' as const,engineVerification:'pending' as const}};
          })},boundary);
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
        return {...last, status: 'staged', imported: false, commandIds};
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
