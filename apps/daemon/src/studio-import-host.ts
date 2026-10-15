import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ArcaneError } from '../../../packages/protocol/src/providers.js';
import { studioImportContextObservation, type StudioImportContextObservation, type StudioSession } from '../../../packages/protocol/src/studio.js';
import { StudioStore } from '../../../packages/storage/src/studio-store.js';
import { ConversationWorkStore } from '../../../packages/storage/src/conversation-work-store.js';
import { snapshotStudioImportSelection, type PreparedStudioImport, type StudioImportSelection } from '../../../packages/asset-pipeline/src/studio-import-manifest.js';
import { assertStudioImportJobScope, type StudioImportHostOptions } from './asset-import-adapter.js';
import type { NativeAssetActor, NativeAssetScope } from './native-asset-authority.js';
import type { StudioImportPreparationAttempt } from './asset-import-adapter.js';

export interface ImportContextReceiptWitness {
  initialContextReceiptId: string;
  confirmedContextReceiptId: string;
  pluginArtifactHash: string;
  clientLifetimeId: string;
  playEpoch: number;
}
export interface StudioImportHostConfiguration {
  projectPath: string;
  workAssociations: ConversationWorkStore;
  studio: StudioStore;
  pluginArtifactHash: string;
  /** Owned host persistence. JSON claims and receipts never grant engine access. */
  persistPreparation(actor: NativeAssetActor, jobId: string, prepared: PreparedStudioImport,
    witness: ImportContextReceiptWitness, guard: () => void, attemptId?: string): Promise<void>;
  now?: () => number;
}
const CONTEXT_DEADLINE_MS = 10_000;
const LIVE_SESSION_MS = 30_000;
const MAX_CAPTURES = 64;
const STUDS_PER_METER = 1 / 0.28;
function fail(code: string): never { throw new ArcaneError(code, 'Studio import target is unavailable, ambiguous or changed.'); }
function scopeKey(scope: NativeAssetScope): string {
  return createHash('sha256').update(JSON.stringify({ projectId: scope.projectId, conversation: scope.conversation })).digest('hex');
}
function stamp(session: StudioSession): string {
  const proof = session.proof;
  return JSON.stringify({ id: session.id, clientSessionId: session.clientSessionId, placeId: session.placeId,
    universeId: session.universeId, pluginVersion: session.pluginVersion, roots: session.allowedRoots, allowWrites: session.allowWrites,
    capabilities: session.capabilities, artifact: proof?.pluginArtifactHash, lifetime: proof?.clientLifetimeId,
    marker: proof?.markerName, playEpoch: proof?.playEpoch, mode: proof?.mode });
}
interface Capture {
  scopeKey: string; sessionId: string; stamp: string; contextReceiptId: string;
  context: StudioImportContextObservation; selection: StudioImportSelection;
}

/** Production host composition. Queues only a fixed read against a genuinely
 * paired target; it never invokes Studio SDK, imports, uploads or runs source.
 * All generated files still enter through AssetService's owned byte admission. */
export function createStudioImportHost(configuration: StudioImportHostConfiguration) {
  const { studio, workAssociations, projectPath, pluginArtifactHash } = configuration;
  if (!(studio instanceof StudioStore) || !(workAssociations instanceof ConversationWorkStore) ||
    projectPath !== workAssociations.projectPath || !/^[a-f0-9]{64}$/.test(pluginArtifactHash) ||
    typeof configuration.persistPreparation !== 'function') fail('STUDIO_IMPORT_CONFIGURATION');
  const now = configuration.now ?? Date.now;
  const captures = new Map<string, Capture>();
  const attempts = new WeakMap<StudioImportPreparationAttempt, { actor: NativeAssetActor; jobId: string; scope: string; used: boolean }>();
  let closed = false;
  function live(session: StudioSession): void {
    if (closed) fail('STUDIO_IMPORT_CLOSED');
    const time = now(), proof = session.proof;
    if (session.revokedAt || !Number.isFinite(Date.parse(session.lastSeenAt)) || Date.parse(session.lastSeenAt) > time ||
      time - Date.parse(session.lastSeenAt) > LIVE_SESSION_MS || !session.allowedRoots.includes('Workspace') ||
      !session.capabilities.includes('scene.import_context')) fail('STUDIO_IMPORT_TARGET');
    if (!proof || proof.sessionId !== session.id || proof.clientLifetimeId !== session.clientSessionId ||
      proof.placeId !== session.placeId || proof.universeId !== session.universeId || !proof.connected ||
      !proof.continuitySupported || proof.mode !== 'Edit' || proof.pluginArtifactHash !== pluginArtifactHash ||
      !Number.isFinite(Date.parse(proof.expiresAt)) || Date.parse(proof.expiresAt) <= time) fail('STUDIO_IMPORT_CONTINUITY');
  }
  function check(actor: NativeAssetActor, scope: NativeAssetScope, jobId: string, guard: () => void): void {
    guard();
    const actual = assertStudioImportJobScope(projectPath, workAssociations, actor, jobId);
    if (actual.projectId !== scope.projectId || scopeKey(actual) !== scopeKey(scope) || closed) fail('STUDIO_IMPORT_SCOPE');
  }
  function validate(scope: NativeAssetScope, jobId: string, selection: StudioImportSelection): Capture {
    if (closed) fail('STUDIO_IMPORT_CLOSED');
    const captured = captures.get(jobId);
    if (!captured || captured.scopeKey !== scopeKey(scope) || !isDeepStrictEqual(captured.selection, selection)) fail('STUDIO_IMPORT_SCOPE');
    const session = studio.session(captured.sessionId); live(session);
    if (stamp(session) !== captured.stamp) fail('STUDIO_IMPORT_CONTINUITY');
    return captured;
  }
  async function observe(sessionId: string, expectedStamp: string, actor: NativeAssetActor, scope: NativeAssetScope,
    jobId: string, guard: () => void): Promise<{ context: StudioImportContextObservation; receiptId: string }> {
    const deadline = now() + CONTEXT_DEADLINE_MS;
    const boundary = () => {
      check(actor, scope, jobId, guard);
      const current = studio.session(sessionId); live(current);
      if (stamp(current) !== expectedStamp) fail('STUDIO_IMPORT_CONTINUITY');
      return current;
    };
    boundary();
    const queued = studio.enqueue({ sessionId, requestId: 'import-context-' + randomUUID(), method: 'scene.import_context', args: {} });
    while (true) {
      const session = boundary(), command = studio.command(queued.id);
      if (command.sessionId !== sessionId || command.clientSessionId !== session.clientSessionId ||
        command.method !== 'scene.import_context' || command.leaseEpoch !== queued.leaseEpoch) fail('STUDIO_IMPORT_RECEIPT');
      if (command.state === 'succeeded') {
        const context = studioImportContextObservation(command.result);
        if (context.sessionId !== sessionId || context.placeId !== session.placeId || context.universeId !== session.universeId || context.mode !== 'Edit') fail('STUDIO_IMPORT_RECEIPT');
        boundary(); return { context, receiptId: command.id };
      }
      if (['failed', 'cancelled', 'needs_reconciliation'].includes(command.state)) fail('STUDIO_IMPORT_RECEIPT');
      if (now() >= deadline) fail('STUDIO_IMPORT_CONTEXT_TIMEOUT');
      await new Promise<void>(resolve => setTimeout(resolve, Math.min(25, Math.max(1, deadline - now()))));
    }
  }
  const hooks: StudioImportHostOptions = {
    workAssociations,
    beginPreparationAttempt(scope, jobId, actor, guard) {
      check(actor, scope, jobId, guard);
      const attempt = Object.freeze({kind: 'studio-import-preparation-attempt' as const, id: randomUUID()});
      attempts.set(attempt, {actor, jobId, scope: scopeKey(scope), used: false});
      return attempt;
    },
    async selectTarget(scope, jobId, actor, guard) {
      check(actor, scope, jobId, guard);
      if (captures.has(jobId) || captures.size >= MAX_CAPTURES) fail('STUDIO_IMPORT_BUSY');
      // Count all recent live pairings BEFORE capability filtering. A stale or
      // older plugin must never make a second live place silently disappear.
      const candidates = studio.activeSessions().filter(session => Number.isFinite(Date.parse(session.lastSeenAt)) &&
        Date.parse(session.lastSeenAt) <= now() && now() - Date.parse(session.lastSeenAt) <= LIVE_SESSION_MS);
      if (candidates.length !== 1) fail(candidates.length ? 'STUDIO_IMPORT_AMBIGUOUS' : 'STUDIO_IMPORT_TARGET');
      const session = candidates[0]!; live(session);
      const identity = stamp(session), observed = await observe(session.id, identity, actor, scope, jobId, guard);
      const { context } = observed;
      let creator: StudioImportSelection['target']['creator'];
      if (context.creator.status === 'available') creator = { kind: context.creator.kind, id: String(context.creator.id) };
      else if (context.placeId === 0 && context.universeId === 0 && context.creator.id === 0 && context.studioUser.status === 'available')
        creator = { kind: 'user', id: String(context.studioUser.id) };
      else fail('STUDIO_IMPORT_CREATOR');
      const selection = snapshotStudioImportSelection({ target: { sessionId: session.id, placeId: session.placeId,
        universeId: session.universeId, root: 'Workspace', parentRef: context.parentRef.instanceId, creator },
        placement: { mode: 'bottom-centre' }, studsPerMeter: STUDS_PER_METER });
      check(actor, scope, jobId, guard); live(studio.session(session.id));
      if (stamp(studio.session(session.id)) !== identity) fail('STUDIO_IMPORT_CONTINUITY');
      captures.set(jobId, { scopeKey: scopeKey(scope), sessionId: session.id, stamp: identity,
        contextReceiptId: observed.receiptId, context, selection });
      return selection;
    },
    validateTarget(scope, jobId, selection) { validate(scope, jobId, selection); },
    async recordPrepared(scope, jobId, prepared, actor, guard, attempt) {
      check(actor, scope, jobId, guard);
      const admission = attempt ? attempts.get(attempt) : undefined;
      if (attempt && (!admission || admission.actor !== actor || admission.jobId !== jobId || admission.scope !== scopeKey(scope) || admission.used)) fail('STUDIO_IMPORT_SCOPE');
      const captured = validate(scope, jobId, snapshotStudioImportSelection({ target: prepared.manifest.target,
        placement: prepared.manifest.placement, studsPerMeter: prepared.manifest.conversion.studsPerMeter }));
      // Observe again after export validation. Account, creator and opaque root
      // changes are not inferred from a still-live transport heartbeat.
      const confirmed = await observe(captured.sessionId, captured.stamp, actor, scope, jobId, guard);
      if (!isDeepStrictEqual(captured.context, confirmed.context)) fail('STUDIO_IMPORT_CONTINUITY');
      check(actor, scope, jobId, guard); validate(scope, jobId, captured.selection);
      const proof = studio.session(captured.sessionId).proof!;
      if (admission) admission.used = true;
      await configuration.persistPreparation(actor, jobId, prepared, { initialContextReceiptId: captured.contextReceiptId,
        confirmedContextReceiptId: confirmed.receiptId, pluginArtifactHash, clientLifetimeId: proof.clientLifetimeId,
        playEpoch: proof.playEpoch }, guard, attempt?.id);
      check(actor, scope, jobId, guard); validate(scope, jobId, captured.selection);
    },
    releaseTarget(scope, jobId) {
      if (captures.get(jobId)?.scopeKey === scopeKey(scope)) captures.delete(jobId);
    },
  };
  return Object.freeze({ hooks: Object.freeze(hooks), close() { closed = true; captures.clear(); } });
}
