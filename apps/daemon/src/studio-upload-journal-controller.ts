import {createHash} from 'node:crypto';
import {isDeepStrictEqual, types} from 'node:util';
import {ArcaneError} from '../../../packages/protocol/src/providers.js';
import {studioUploadContextObservation, type StudioUploadContextObservation} from '../../../packages/protocol/src/studio.js';
import {StudioStore, type AssetUploadContextPin, type AssetUploadIntent, type AssetUploadJournalRecord, type AssetUploadJournalTicket} from '../../../packages/storage/src/studio-store.js';
import {ConversationWorkStore} from '../../../packages/storage/src/conversation-work-store.js';
import {assertDecodedStudioImportPayload, type StudioImportPayload, type StudioImportPayloadObject} from '../../../packages/asset-pipeline/src/studio-import-payload.js';
import {parseNativeStudioImportResponse} from '../../../packages/asset-pipeline/src/studio-import-wire.js';
import type {PreparedStudioImport, StudioImportSelection} from '../../../packages/asset-pipeline/src/studio-import-manifest.js';
import {assertStudioImportJobScope} from './asset-import-adapter.js';
import type {NativeAssetActor, NativeAssetScope} from './native-asset-authority.js';

/** Exact metadata shape consumed by plugin AssetUpload. It is NOT authority. */
export interface StudioUploadTicket {
  readonly attemptId: string; readonly assetType: 'Mesh';
  readonly creator: Readonly<{kind: 'user' | 'group'; id: number}>;
  readonly source: Readonly<{jobId: string; resourceId: string; sha256: string}>;
  readonly uploader: Readonly<{status: 'available'; id: number; provenance: 'StudioService:GetUserId'}>;
  readonly continuity: Readonly<{sessionId: string; clientLifetimeId: string; pluginArtifactHash: string;
    playEpoch: number; placeId: number; universeId: number}>;
  readonly name: string; readonly description: string;
}
export interface StudioUploadRecordingHandle {readonly kind: 'studio-upload-recording-handle'}
export interface StudioUploadSourceIdentity {
  readonly projectId: string; readonly jobId: string; readonly payloadDigest: string;
  readonly manifestDigest: string; readonly preparedDigest: string;
  readonly sourceId: string; readonly sourceSha256: string; readonly assetType: 'Mesh';
}
export interface StudioUploadAdmission {
  readonly actor: NativeAssetActor; readonly scope: NativeAssetScope;
  readonly payload: StudioImportPayload; readonly sourceObject: StudioImportPayloadObject;
  readonly sourceIdentity: StudioUploadSourceIdentity;
  readonly target: StudioImportSelection['target']; readonly context: StudioUploadContextObservation;
  /** Original Store-owned enqueue-time continuity; never supplied by the caller. */
  readonly contextPin: Readonly<AssetUploadContextPin>;
  readonly contextReceiptId: string; readonly ticket: StudioUploadTicket;
  readonly intent: Readonly<AssetUploadIntent>;
}
export interface StudioUploadJournalConfiguration {
  projectPath: string; workAssociations: ConversationWorkStore; studio: StudioStore;
  pluginArtifactHash: string;
  /** Metadata-only admission before the durable begin. This never admits a
   * borrowed resource or substitutes for the execution admission below. */
  beginAdmissionGuard: (admission: StudioUploadAdmission) => void;
  /** TRUSTED host composition only. Authenticate the exact receipt and current
   * target/uploader/resource binding. Must synchronously throw or return void.
   * This adapter cannot observe a current Studio account or editable resource. */
  admissionGuard: (admission: StudioUploadAdmission, resource: object) => void;
  /** Require actual host-owned consent/rights admission for the exact source,
   * creator and separately observed uploader. rightsGrantId is correlation ONLY.
   * No default, boolean, promise, group-owner inference or serialized grant. */
  rightsAdmission: (admission: StudioUploadAdmission, resource: object | null) => void;
  now?: () => number;
}
export interface StudioUploadJournalInput {
  attemptId: string; actor: NativeAssetActor; prepared: PreparedStudioImport;
  payload: StudioImportPayload; sourceObject: StudioImportPayloadObject;
  contextReceiptId: string; rightsGrantId: string; name: string; description: string;
}
export interface StudioUploadJournalCallbacks {
  assertAdmission(ticket: StudioUploadTicket, resource: object): void;
  liveGuard(ticket: StudioUploadTicket, resource: object): void;
  /** One-use ACK, and only after the already committed fresh intent. It is the
   * permission boundary for ONE future engine call, never an engine invocation. */
  recordIntent(ticket: StudioUploadTicket): Readonly<{phase: 'intent'; ticket: StudioUploadTicket}>;
  /** Trusted fact recording; deliberately independent of continuing admission. */
  recordResult(ticket: StudioUploadTicket, observation: {attemptId: string; assetId: number}):
    Readonly<{phase: 'result'; ticket: StudioUploadTicket; assetId: number}>;
}
export type StudioUploadJournalBeginResult =
  | Readonly<{fresh: true; handle: StudioUploadRecordingHandle; ticket: StudioUploadTicket; record: AssetUploadJournalRecord}>
  | Readonly<{fresh: false; handle: null; ticket: null; record: AssetUploadJournalRecord}>;

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const CONTEXT_AGE_MS = 10_000, CAPACITY = 256;
// Shared across controllers using this actual store. Failed/unknown begin calls
// are latched too: a second controller cannot turn an ACK/COMMIT failure into a
// fresh permission. Across restart, SQLite's unique logical resource key applies.
const attempted = new WeakMap<StudioStore, Map<string, string>>();
function fail(code: string): never {
  throw new ArcaneError(code, 'Private upload journal admission is unavailable, changed or requires reconciliation.');
}
function fields(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) fail('STUDIO_UPLOAD_INPUT');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail('STUDIO_UPLOAD_INPUT');
  const keys = Reflect.ownKeys(value), descriptors = Object.getOwnPropertyDescriptors(value);
  if (keys.length > required.length + optional.length || keys.some(k => typeof k !== 'string' || ![...required, ...optional].includes(k))
    || required.some(k => !Object.hasOwn(descriptors, k))) fail('STUDIO_UPLOAD_INPUT');
  const out: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const d = descriptors[key]!;
    if (!Object.hasOwn(d, 'value') || !d.enumerable) fail('STUDIO_UPLOAD_INPUT');
    out[key] = d.value as unknown;
  }
  return out;
}
/** Bounded descriptor-only copy; never runs toJSON/accessors/proxy traps. */
function snapshot(value: unknown, depth = 0): any {
  if (depth > 10) fail('STUDIO_UPLOAD_INPUT');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {if (Buffer.byteLength(value) > 8192) fail('STUDIO_UPLOAD_INPUT'); return value;}
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object' || types.isProxy(value)) fail('STUDIO_UPLOAD_INPUT');
  const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) fail('STUDIO_UPLOAD_INPUT');
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(value);
  if (keys.length > 65) fail('STUDIO_UPLOAD_INPUT');
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (array && key === 'length') continue;
    if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)) fail('STUDIO_UPLOAD_INPUT');
    const d = descriptors[key]!;
    if (!Object.hasOwn(d, 'value') || !d.enumerable) fail('STUDIO_UPLOAD_INPUT');
    out[key] = snapshot(d.value, depth + 1);
  }
  if (!array) return Object.freeze(out);
  const length = descriptors.length!.value as number;
  if (length > 64 || Object.keys(out).length !== length || Object.keys(out).some(k => !/^(0|[1-9][0-9]*)$/.test(k) || Number(k) >= length)) fail('STUDIO_UPLOAD_INPUT');
  return Object.freeze(Array.from({length}, (_, i) => out[String(i)]));
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value || value.length > maximum || value.includes('\0')) fail('STUDIO_UPLOAD_INPUT');
  return value;
}
function synchronous(callback: () => void, code: string): void {
  let result: unknown;
  try {result = callback();} catch {fail(code);}
  // Avoid an unhandled rejection while refusing promises as synchronous guards.
  if (types.isPromise(result)) void Promise.prototype.then.call(result, undefined, () => {});
  if (result !== undefined) fail(code);
}

/** Private composition component only. No HTTP/queue/SDK/engine registration.
 * Only decoded Mesh sources exist in payload v1; Image admission is intentionally
 * unavailable until it has an independently verified source brand. */
export function createStudioUploadJournalController(configuration: StudioUploadJournalConfiguration) {
  const c = fields(configuration, ['projectPath', 'workAssociations', 'studio', 'pluginArtifactHash', 'beginAdmissionGuard', 'admissionGuard', 'rightsAdmission'], ['now']);
  const {projectPath, workAssociations: work, studio, pluginArtifactHash} = c;
  if (typeof projectPath !== 'string' || types.isProxy(work) || !(work instanceof ConversationWorkStore)
    || types.isProxy(studio) || !(studio instanceof StudioStore) || work.projectPath !== projectPath
    || typeof pluginArtifactHash !== 'string' || !HASH.test(pluginArtifactHash)) fail('STUDIO_UPLOAD_CONFIGURATION');
  const canonicalProjectPath: string = projectPath;
  const workAssociations: ConversationWorkStore = work;
  const admissionGuard = c.admissionGuard as StudioUploadJournalConfiguration['admissionGuard'];
  const beginAdmissionGuard = c.beginAdmissionGuard as StudioUploadJournalConfiguration['beginAdmissionGuard'];
  const rightsAdmission = c.rightsAdmission as StudioUploadJournalConfiguration['rightsAdmission'];
  for (const callback of [beginAdmissionGuard, admissionGuard, rightsAdmission]) {
    if (typeof callback !== 'function' || types.isProxy(callback) || types.isAsyncFunction(callback) || types.isGeneratorFunction(callback)) fail('STUDIO_UPLOAD_UNAVAILABLE');
  }
  if (c.now !== undefined && (typeof c.now !== 'function' || types.isProxy(c.now))) fail('STUDIO_UPLOAD_CONFIGURATION');
  const now = (c.now ?? Date.now) as () => number;
  // Snapshot methods as well as callbacks before any host callback can replace them.
  const beginUpload = studio.beginAssetUpload.bind(studio), finishUpload = studio.finishAssetUpload.bind(studio);
  const readUpload = studio.assetUpload.bind(studio), readSession = studio.session.bind(studio), readCommand = studio.command.bind(studio);
  const readContextPin = studio.assetUploadContextPin.bind(studio);
  const attempts = attempted.get(studio) ?? new Map<string, string>(); attempted.set(studio, attempts);
  type Entry = {admission: StudioUploadAdmission; storageTicket: AssetUploadJournalTicket;
    receipt: unknown; claimed: boolean; issued: boolean; executionRetired: boolean;
    resource?: object; recordedAssetId?: number; callbacks?: StudioUploadJournalCallbacks};
  const handles = new WeakMap<object, Entry>();
  let busy = false, closed = false;
  function serial<T>(action: () => T): T {
    if (busy) fail('STUDIO_UPLOAD_REENTRY');
    busy = true; try {return action();} finally {busy = false;}
  }
  function entry(handle: StudioUploadRecordingHandle): Entry {
    if (!handle || typeof handle !== 'object' || types.isProxy(handle)) fail('STUDIO_UPLOAD_HANDLE');
    const value = handles.get(handle); if (!value) fail('STUDIO_UPLOAD_HANDLE'); return value;
  }
  function baseline(a: StudioUploadAdmission, receipt: unknown): void {
    if (closed) fail('STUDIO_UPLOAD_CLOSED');
    const scope = assertStudioImportJobScope(canonicalProjectPath, workAssociations, a.actor, a.sourceIdentity.jobId);
    if (!isDeepStrictEqual(scope, a.scope)) fail('STUDIO_UPLOAD_SCOPE');
    const session = readSession(a.ticket.continuity.sessionId), proof = session.proof, time = now();
    if (!Number.isFinite(time) || session.revokedAt || !session.allowWrites || !session.allowedRoots.includes('Workspace')
      || !session.capabilities.includes('scene.upload_context') || !proof || proof.sessionId !== session.id
      || proof.clientLifetimeId !== a.ticket.continuity.clientLifetimeId || session.clientSessionId !== proof.clientLifetimeId
      || proof.pluginArtifactHash !== pluginArtifactHash || proof.playEpoch !== a.ticket.continuity.playEpoch
      || proof.placeId !== a.target.placeId || proof.universeId !== a.target.universeId
      || session.placeId !== a.target.placeId || session.universeId !== a.target.universeId
      || !proof.connected || !proof.continuitySupported || proof.mode !== 'Edit'
      || !Number.isFinite(Date.parse(proof.expiresAt)) || Date.parse(proof.expiresAt) <= time) fail('STUDIO_UPLOAD_CONTINUITY');
    const command = snapshot(readCommand(a.contextReceiptId));
    if (!isDeepStrictEqual(snapshot(readContextPin(a.contextReceiptId)), a.contextPin)) fail('STUDIO_UPLOAD_CONTEXT');
    if (!isDeepStrictEqual(command, receipt) || !command.finishedAt || !Number.isFinite(Date.parse(command.finishedAt))
      || Date.parse(command.finishedAt) > time || time - Date.parse(command.finishedAt) > CONTEXT_AGE_MS) fail('STUDIO_UPLOAD_CONTEXT');
  }
  function check(a: StudioUploadAdmission, receipt: unknown): void {
    baseline(a, receipt);
    synchronous(() => beginAdmissionGuard(a), 'STUDIO_UPLOAD_ADMISSION'); baseline(a, receipt);
    synchronous(() => rightsAdmission(a, null), 'STUDIO_UPLOAD_RIGHTS'); baseline(a, receipt);
  }
  function executionState(e: Entry): void {
    if (e.executionRetired) fail('STUDIO_UPLOAD_RETIRED');
    const record = readUpload(e.admission.ticket.attemptId);
    if (!isDeepStrictEqual(record.intent, e.admission.intent)) fail('STUDIO_UPLOAD_RECONCILIATION');
    // AssetUpload runs its FINAL live guard after its result ACK. Its own logged
    // successful fact may pass that check, but never yields another intent ACK.
    // Unknown outcomes or unrelated terminal writes always retire execution.
    if (record.state !== 'intent' && !(record.state === 'succeeded' && e.issued
      && e.recordedAssetId !== undefined && record.assetId === e.recordedAssetId)) {
      e.executionRetired = true; fail('STUDIO_UPLOAD_RETIRED');
    }
  }
  function executionCheck(e: Entry, resource: object): void {
    executionState(e); baseline(e.admission, e.receipt);
    synchronous(() => admissionGuard(e.admission, resource), 'STUDIO_UPLOAD_ADMISSION');
    executionState(e); baseline(e.admission, e.receipt);
    synchronous(() => rightsAdmission(e.admission, resource), 'STUDIO_UPLOAD_RIGHTS');
    executionState(e); baseline(e.admission, e.receipt);
  }
  function borrowed(resource: unknown): asserts resource is object {
    if (!resource || typeof resource !== 'object' || types.isProxy(resource)) fail('STUDIO_UPLOAD_RESOURCE');
  }
  function matching(value: unknown, ticket: StudioUploadTicket): void {
    if (!isDeepStrictEqual(snapshot(value), ticket)) fail('STUDIO_UPLOAD_TICKET');
  }
  return Object.freeze({
    begin(input: StudioUploadJournalInput): StudioUploadJournalBeginResult {
      return serial(() => {
        if (closed) fail('STUDIO_UPLOAD_CLOSED');
        const v = fields(input, ['attemptId', 'actor', 'prepared', 'payload', 'sourceObject', 'contextReceiptId', 'rightsGrantId', 'name', 'description']);
        const attemptId = text(v.attemptId, 128); if (!UUID.test(attemptId)) fail('STUDIO_UPLOAD_INPUT');
        const actor = v.actor as NativeAssetActor, payload = v.payload as StudioImportPayload;
        assertDecodedStudioImportPayload(payload); // WeakSet provenance BEFORE any payload property reads.
        const scope = assertStudioImportJobScope(projectPath, work, actor, payload.revisionId);
        const prepared = parseNativeStudioImportResponse({prepared: v.prepared}, payload.revisionId, scope.projectId).prepared;
        if (payload.projectId !== scope.projectId || payload.preparedDigest !== prepared.digest || payload.manifestDigest !== prepared.manifest.digest) fail('STUDIO_UPLOAD_SOURCE');
        const sourceObject = v.sourceObject as StudioImportPayloadObject;
        if (!sourceObject || types.isProxy(sourceObject) || !payload.objects.some(object => object === sourceObject)
          || !isDeepStrictEqual(sourceObject.object, prepared.manifest.objects.find(o => o.sourceObjectId === sourceObject.object.sourceObjectId))) fail('STUDIO_UPLOAD_SOURCE');
        const target = snapshot(prepared.manifest.target) as StudioImportSelection['target'];
        const contextReceiptId = text(v.contextReceiptId, 128), receipt = snapshot(readCommand(contextReceiptId));
        if (receipt.method !== 'scene.upload_context' || receipt.state !== 'succeeded' || receipt.sessionId !== target.sessionId
          || receipt.clientSessionId !== readSession(target.sessionId).clientSessionId || !isDeepStrictEqual(receipt.args, {})) fail('STUDIO_UPLOAD_CONTEXT');
        const context = snapshot(studioUploadContextObservation(receipt.result)) as StudioUploadContextObservation;
        const creator = context.creator.status === 'available' ? {kind: context.creator.kind, id: context.creator.id}
          : context.placeId === 0 && context.universeId === 0 && context.creator.id === 0 && context.studioUser.status === 'available'
            ? {kind: 'user' as const, id: context.studioUser.id} : null;
        if (!creator || context.mode !== 'Edit' || context.sessionId !== target.sessionId || context.placeId !== target.placeId
          || context.universeId !== target.universeId || context.parentRef.instanceId !== target.parentRef
          || creator.kind !== target.creator.kind || String(creator.id) !== target.creator.id || context.uploader.status !== 'available') fail('STUDIO_UPLOAD_CONTEXT');
        // A new heartbeat cannot relabel an old creator/uploader observation.
        // Only the actual Store's private enqueue-time pin supplies these IDs.
        const pin = snapshot(readContextPin(contextReceiptId)) as Readonly<AssetUploadContextPin> | null;
        if (!pin || pin.sessionId !== target.sessionId || pin.clientLifetimeId !== receipt.clientSessionId
          || pin.pluginArtifactHash !== pluginArtifactHash || pin.placeId !== target.placeId
          || pin.universeId !== target.universeId) fail('STUDIO_UPLOAD_CONTINUITY');
        const name = text(v.name, 100), description = v.description;
        if (!name.trim() || Array.from(name).length > 50 || Buffer.byteLength(name) > 200 || /[\x00-\x1f\x7f]/.test(name)
          || typeof description !== 'string' || description.length > 1000 || Buffer.byteLength(description) > 4096
          || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(description)
          || Buffer.from(name).toString() !== name || Buffer.from(description).toString() !== description) fail('STUDIO_UPLOAD_INPUT');
        const intent = snapshot({projectId: scope.projectId, jobId: payload.revisionId, sourceId: sourceObject.object.sourceObjectId,
          sourceSha256: sourceObject.object.meshExportSha256, assetType: 'Mesh', sessionId: target.sessionId,
          clientLifetimeId: pin.clientLifetimeId, pluginArtifactHash: pin.pluginArtifactHash, playEpoch: pin.playEpoch,
          placeId: target.placeId, universeId: target.universeId, creator, uploaderId: context.uploader.id,
          rightsGrantId: text(v.rightsGrantId, 256), name, description}) as AssetUploadIntent;
        const ticket = snapshot({attemptId, assetType: 'Mesh', creator, source: {jobId: intent.jobId, resourceId: intent.sourceId, sha256: intent.sourceSha256},
          uploader: context.uploader, continuity: {sessionId: intent.sessionId, clientLifetimeId: intent.clientLifetimeId,
            pluginArtifactHash, playEpoch: intent.playEpoch, placeId: intent.placeId, universeId: intent.universeId}, name, description}) as StudioUploadTicket;
        const sourceIdentity = snapshot({projectId: scope.projectId, jobId: intent.jobId, payloadDigest: payload.digest,
          preparedDigest: payload.preparedDigest, manifestDigest: payload.manifestDigest, sourceId: intent.sourceId,
          sourceSha256: intent.sourceSha256, assetType: 'Mesh'}) as StudioUploadSourceIdentity;
        const admission: StudioUploadAdmission = Object.freeze({actor, scope, payload, sourceObject, sourceIdentity, target, context, contextPin: pin, contextReceiptId, ticket, intent});
        check(admission, receipt); // All metadata is detached BEFORE either host callback.
        const resourceKey = createHash('sha256').update(JSON.stringify([intent.projectId, intent.jobId, intent.sourceId, intent.sourceSha256, intent.assetType])).digest('hex');
        const prior = attempts.get(resourceKey);
        if (prior) {
          if (prior !== attemptId) fail('UPLOAD_CONFLICT');
          let record: AssetUploadJournalRecord;
          try {record = readUpload(prior);} catch {fail('STUDIO_UPLOAD_RECONCILIATION');}
          if (!isDeepStrictEqual(record.intent, intent)) fail('UPLOAD_CONFLICT');
          return Object.freeze({fresh: false, handle: null, ticket: null, record: snapshot(record)});
        }
        if (attempts.size >= CAPACITY) fail('STUDIO_UPLOAD_CAPACITY');
        attempts.set(resourceKey, attemptId); // Latch BEFORE durable writes/reentrant callbacks.
        const started = beginUpload(attemptId, intent, () => check(admission, receipt));
        if (!started.fresh || !started.ticket) return Object.freeze({fresh: false, handle: null, ticket: null, record: snapshot(started.record)});
        // Failure here leaves the durable intent reserved, never a fresh permit.
        check(admission, receipt);
        const handle: StudioUploadRecordingHandle = Object.freeze({kind: 'studio-upload-recording-handle'});
        handles.set(handle, {admission, storageTicket: started.ticket, receipt, claimed: false, issued: false, executionRetired: false});
        return Object.freeze({fresh: true, handle, ticket, record: snapshot(started.record)});
      });
    },
    callbacks(handle: StudioUploadRecordingHandle, resource: object): StudioUploadJournalCallbacks {
      return serial(() => {
      const e = entry(handle);
      borrowed(resource);
      if (e.callbacks) {
        if (e.resource !== resource) fail('STUDIO_UPLOAD_RESOURCE');
        executionState(e); return e.callbacks;
      }
      // Only the TRUSTED identity-binding guard can admit this actual resource.
      // A class name, JSON clone or source digest cannot prove its ownership.
      executionCheck(e, resource);
      e.resource = resource;
      const assert = (ticket: StudioUploadTicket, actualResource: object): void => serial(() => {
        executionState(e); matching(ticket, e.admission.ticket); borrowed(actualResource);
        if (actualResource !== e.resource) fail('STUDIO_UPLOAD_RESOURCE');
        executionCheck(e, actualResource);
      });
      e.callbacks = Object.freeze({assertAdmission: assert, liveGuard: assert,
        recordIntent(ticket: StudioUploadTicket) {
          return serial(() => {
            matching(ticket, e.admission.ticket);
            executionState(e);
            if (e.claimed) fail('STUDIO_UPLOAD_CONSUMED');
            e.claimed = true; // BEFORE guards, including failed/reentrant claims.
            executionCheck(e, resource);
            const record = readUpload(e.admission.ticket.attemptId);
            if (record.state !== 'intent' || !isDeepStrictEqual(record.intent, e.admission.intent)) fail('STUDIO_UPLOAD_RECONCILIATION');
            e.issued = true;
            return Object.freeze({phase: 'intent' as const, ticket: e.admission.ticket});
          });
        },
        recordResult(ticket: StudioUploadTicket, observation: {attemptId: string; assetId: number}) {
          return serial(() => {
            matching(ticket, e.admission.ticket);
            const observed = fields(observation, ['attemptId', 'assetId']);
            if (!e.issued || observed.attemptId !== e.admission.ticket.attemptId || typeof observed.assetId !== 'number'
              || !Number.isSafeInteger(observed.assetId) || observed.assetId <= 0) fail('STUDIO_UPLOAD_OBSERVATION');
            // No live guard here: an already-created ID is a fact, even after
            // actor/rights/target retirement. This does NOT authorize continuation.
            finishUpload(e.storageTicket, {state: 'succeeded', assetId: observed.assetId});
            e.recordedAssetId = observed.assetId;
            return Object.freeze({phase: 'result' as const, ticket: e.admission.ticket, assetId: observed.assetId});
          });
        },
      });
      return e.callbacks;
      });
    },
    finishUnknown(handle: StudioUploadRecordingHandle): AssetUploadJournalRecord {
      return serial(() => {
        const e = entry(handle);
        e.executionRetired = true; // BEFORE logging, including failure/ACK loss.
        return snapshot(finishUpload(e.storageTicket, {state: 'needs_reconciliation', assetId: null}));
      });
    },
    close(): void {closed = true;},
  });
}
