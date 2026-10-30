import { JOB_JOURNAL_BYTES, CUSTOM_REQUEST_BYTES,jsonSnapshot } from '../../../packages/asset-pipeline/src/recipe.js';
import type { Stats } from 'node:fs';
import {lstatSync,realpathSync} from 'node:fs';
import { lstat, opendir, mkdir, writeFile, rename } from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {parseAdoptGlbInput, parseAdoptedGlbRequest, parseAdoptedGlbManifest, snapshotAdoptedGlbConversation, isAdoptedGlbRequest, isAdoptedGlbManifest, readOwnedProjectGlb, validateAdoptedGlbManifest, ADOPTED_GLB_LIMITS, type AdoptedGlbRequest, type AdoptedGlbManifest} from '../../../packages/asset-pipeline/src/adopted-glb.js';
export type AssetPreviewManifest = AssetManifest | AdoptedGlbManifest | ConvertedGlbManifest;
import { parseConvertedGlbJobMetadata, type ConvertedGlbCreation, type ConvertedGlbJobMetadata } from '../../../packages/asset-pipeline/src/converted-glb-creation.js';
import { parseConvertedGlbJson, CONVERTED_GLB_ARTIFACT_LIMITS, type ConvertedGlbManifest } from '../../../packages/asset-pipeline/src/converted-glb-manifest.js';
import { GLB_CONVERSION_LIMITS, type ConvertedGlbRequest } from '../../../packages/asset-pipeline/src/converted-glb.js';
import { parseConvertGlbInput } from './conversion-start.js';
import { atomicAssetJson, AtomicJsonFailure } from '../../../packages/asset-pipeline/src/atomic-json.js';
import { isAbsolute, join, resolve } from 'node:path';
import { ArcaneError } from '../../../packages/protocol/src/providers.js';
import { AssetError, AssetPipeline, MAX_CONCURRENT_ASSET_JOBS, normalizeRequest } from '../../../packages/asset-pipeline/src/index.js';
import type { ProcessQueryHost } from '../../../packages/asset-pipeline/src/worker-identity.js';
import { parseWorkerRecords } from '../../../packages/asset-pipeline/src/worker-journal.js';
import { RESOLUTION_RECORD_BYTES, assessJobForResolution, validateResolution,
  type ResolutionEvidence, type ResolutionReason, type WorkerResolutionRecord } from '../../../packages/asset-pipeline/src/worker-resolution.js';
import type { AssetInput, AssetJob, AssetJobEvent, AssetJobState, AssetManifest, AssetProbe, AssetRequest, OperationOptions } from '../../../packages/asset-pipeline/src/index.js';
import { artifactPath, noLinks, prepareOutputRoot, readRegularFile, regularFile } from '../../../packages/asset-pipeline/src/paths.js';
import { inspectPng, readJson, record, sha256 } from '../../../packages/asset-pipeline/src/validation.js';
import { createStudioImportManifestAuthority, snapshotStudioImportSelection, snapshotConvertedStudioImportBaseline, CONVERTED_STUDIO_IMPORT_FILE_IDS, STUDIO_IMPORT_LIMITS, type PreparedStudioImport, type StudioImportBaseline, type GeneratedStudioImportBaselineV1 } from '../../../packages/asset-pipeline/src/studio-import-manifest.js';
import { adaptCompletedConvertedStudioImport, type ConvertedImportRetainedPath } from './converted-asset-import-adapter.js';
import { adaptCompletedStudioImport, assertStudioImportJobScope, type StudioImportHostOptions, type StudioImportPreparationAttempt } from './asset-import-adapter.js';
import { assertNativeAssetActor, nativeAssetActorScope, nativeAssetOperationSignal, acquireNativeAssetWork, assertNativeAssetWorkLease, type NativeAssetActor, type NativeAssetWorkLease } from './native-asset-authority.js';
import { ConversationWorkStore } from '../../../packages/storage/src/conversation-work-store.js';
import { decodeStudioImportPayload, type StudioImportPayload } from '../../../packages/asset-pipeline/src/studio-import-payload.js';
import { createStudioImportTransfer, type StudioImportTransfer } from '../../../packages/asset-pipeline/src/studio-import-transfer.js';
import {AssetArchiveStore,type AssetArchiveScan,type AssetJobDirectory} from './asset-archive-store.js';
import {captureAssetSave,type AssetSaveOutcome} from './asset-save-tail.js';
import { decodeAssetJobError } from '../../../packages/asset-pipeline/src/failure-diagnostics.js';
import type { AssetJobError } from '../../../packages/asset-pipeline/src/types.js';
import type {ArchiveHostFacts} from '../../../packages/asset-pipeline/src/archive-ledger.js';
import {assetFailureEvent,type FailureReporter} from './diagnostic-reporter.js';
import {assetReviewCanonical,assetReviewFailure,modelReviewSubject,convertedModelReviewSubject,snapshotAssetReviewScope,snapshotAssetReviewReference,
  type AssetReviewGate,type AssetReviewImportGuard,type AssetReviewReference,type AssetReviewScope,type AssetReviewSubject} from './asset-review.js';


export interface PreparedStudioImportPayload {
  readonly prepared: PreparedStudioImport;
  readonly payload: StudioImportPayload;
  readonly transfer: StudioImportTransfer;
  readonly review:AssetReviewImportGuard;
}
interface StudioImportReaders {
  manifest(jobId: unknown): Promise<AssetPreviewManifest>;
  artifact(jobId: unknown, path: unknown): Promise<{ bytes: Buffer; filename: string; contentType: string }>;
}

export interface AssetServiceOptions {
  /** Private daemon composition only. A returned id proves the main host committed a redacted report. */
  reportFailure?:FailureReporter;
  /** Trusted repository installation root, independent of the selected project. */
  cwd: string;
  projectPath?: string;
  outputRoot?: string;
  workerRoot?: string;
  blenderExecutable?: string;
  pythonExecutable?: string;
  jobDeadlineMs?: number;
  /** Trusted daemon composition only. Never populated from an HTTP/tool payload. */
  studioImport?: StudioImportHostOptions;
  /** Trusted human-review host only. Missing review authority denies payload/staging admission. */
  modelReview?:AssetReviewGate;
  /** Optional borrowed exact project store for human review before Studio is configured. */
  modelReviewAssociations?:ConversationWorkStore;
  /** Trusted daemon composition/fixtures only: the fixed exact-PID worker query host. */
  workerQueryHost?: ProcessQueryHost;
  /** Trusted fixtures only: replaces the atomic resolution-marker write to exercise commit faults. */
  resolutionMarkerWriter?: (directory: string, filename: string, text: string) => Promise<void>;
  /** Host-owned retained-work facts. Never accepted from HTTP or model inputs. */
  retentionPins?:{
    preparationRecord(jobId:string):Promise<boolean>;
    pendingStage(jobId:string):boolean;
    importCaptured(jobId:string):boolean;
  };
}
/** Outcome of a human worker-status check for one interrupted job. Refusals carry fixed reasons only. */
export type WorkerResolutionOutcome =
  | { readonly jobId: string; readonly status: 'resolved'; readonly resolvedAt: string; readonly evidence: readonly ResolutionEvidence[]; readonly alreadyResolved: boolean }
  | { readonly jobId: string; readonly status: 'refused'; readonly reason: ResolutionReason | 'resolution-stale' };
const RESOLUTION_MARKER = 'worker-resolution.json';
/** Trusted host-code admission only; never an AssetInput or HTTP JSON field. */
export interface AssetStartAdmission {
  /** Volatile signal selected from the actual host operation, never input JSON. */
  readonly signal?: AbortSignal;
  /** Private generation lifetime from the original native host; never input JSON. */
  readonly work?: NativeAssetWorkLease;
  beforeCreate(): void;
  created(jobId: string): void;
}
function synchronousAdmissionResult(result: unknown): void {
  if (result !== null && (typeof result === 'object' || typeof result === 'function') && typeof (result as { then?: unknown }).then === 'function') {
    throw new ArcaneError('ADMISSION_ASYNC', 'Asset start admission callbacks must be synchronous.');
  }
}
export interface AssetJobBase {
  schemaVersion: 1;
  reportId?:string;
  jobId: string;
  directory: string;
  manifestPath: string | null;
  finishedAt?: string;
  state: AssetJobState;
  stage: string;
  startedAt: string;
  updatedAt: string;
  events: AssetJobEvent[];
  manifestAvailable: boolean;
  error: AssetJobError | null;
  /** Display only for interrupted jobs; admission always re-validates the stored marker from disk. */
  resolution?: { status: 'resolved'; resolvedAt: string } | { status: 'invalid' | 'uncertain' };
  retention?:{status:'archived';archivedAt:string};
}
/** Existing generated/adopted wire records keep their original shape. */
export interface GeneratedOrAdoptedAssetJobRecord extends AssetJobBase {
  request: AssetRequest | AdoptedGlbRequest;
  kind?: never;
  form?: never;
  creation?: never;
}
export type LegacyAssetJobRecord = GeneratedOrAdoptedAssetJobRecord;
export type ConvertedAssetJobRecord = AssetJobBase & { kind: 'converted-glb' } & (
  | { form: 'new-pending'; creation: ConvertedGlbCreation; request: null }
  | { form: 'new-prepared'; creation: ConvertedGlbCreation; request: ConvertedGlbRequest }
  | { form: 'legacy-pending'; creation?: never; request: null }
  | { form: 'legacy-prepared'; creation?: never; request: ConvertedGlbRequest }
);
export type AssetJobRecord = GeneratedOrAdoptedAssetJobRecord | ConvertedAssetJobRecord;
type WithoutJobBase<T> = T extends AssetJobBase ? Omit<T, keyof AssetJobBase> : never;
type ConvertedRecordMetadata = WithoutJobBase<ConvertedAssetJobRecord>;
function conversionRecordMetadata(metadata: ConvertedGlbJobMetadata): ConvertedRecordMetadata {
  switch (metadata.form) {
    case 'new-pending': return { kind: 'converted-glb', form: metadata.form, creation: metadata.creation, request: null };
    case 'new-prepared': return { kind: 'converted-glb', form: metadata.form, creation: metadata.creation, request: metadata.request };
    case 'legacy-pending': return { kind: 'converted-glb', form: metadata.form, request: null };
    case 'legacy-prepared': return { kind: 'converted-glb', form: metadata.form, request: metadata.request };
  }
}
function convertedManifest(value: AssetPreviewManifest): value is ConvertedGlbManifest {
  return 'origin' in value && value.origin === 'converted-glb';
}
export interface AssetHistoryUnavailable {jobId:string;name?:string;status:'missing'|'changed'|'conflict'|'unclassified'}
class UnavailableAssetHistory extends ArcaneError {
  constructor(readonly item:AssetHistoryUnavailable){super('HISTORY_INTEGRITY','This retained job needs inspection before its content can be used. Its files have been kept.');}
}
const ID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const LIMIT = 256;
export const HISTORY_PAGE_BYTES = 512 * 1024;
/** Archived identities plus a bounded degraded root inventory; not an admission capacity. */
export const HISTORY_RECORD_LIMIT=8768;
export const ARTIFACT_DOWNLOAD_BYTES = 64 * 1024 * 1024;
export const ARTIFACT_DOWNLOAD_TIMEOUT_MS = 30000;
const DOWNLOADS = new Map([
  ['asset.glb', { role: 'export', contentType: 'model/gltf-binary' }],
  ['collision.glb', { role: 'export', contentType: 'model/gltf-binary' }],
  ['asset-lod1.glb', { role: 'export', contentType: 'model/gltf-binary' }],
  ['asset.fbx', { role: 'export', contentType: 'application/octet-stream' }],
  ['asset.blend', { role: 'scene', contentType: 'application/octet-stream' }],
  ['request.json', { role: 'request', contentType: 'application/json' }],
  ['audit.json', { role: 'audit', contentType: 'application/json' }]
]);
async function unchangedFile(path: string, before: Stats): Promise<void> {
  await noLinks(path);
  const after = await lstat(path);
  if (!after.isFile() || after.nlink !== 1 || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
    throw new AssetError('ARTIFACT', 'Artifact or manifest changed during download verification.');
  }
}
export interface AssetJobPage { schemaVersion: 1; jobs: AssetJobRecord[]; total: number; nextCursor: string | null; byteLimit: number;unavailable?:AssetHistoryUnavailable[] }
const outputOwners = new Set<string>();
function id(value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value)) throw new ArcaneError('INPUT', 'Expected a job UUID.');
  return value;
}
function timestamp(value: unknown, fallback: string): string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : fallback;
}

/** One actor per output root. Journals are authoritative; index.json is a rebuildable history view. */
export async function createAssetService(options: AssetServiceOptions) {
  if (!isAbsolute(options.cwd) || (options.projectPath !== undefined && !isAbsolute(options.projectPath)) || (options.workerRoot !== undefined && !isAbsolute(options.workerRoot))) throw new ArcaneError('INPUT', 'Trusted service roots must be absolute.');
  if (options.jobDeadlineMs !== undefined && (!Number.isSafeInteger(options.jobDeadlineMs) || options.jobDeadlineMs < 1 || options.jobDeadlineMs > 600000)) throw new ArcaneError('INPUT', 'Job deadline must be 1..600000 ms.');
  const projectPath = resolve(options.projectPath ?? options.cwd);
  const importHost = options.studioImport ? Object.freeze({ ...options.studioImport }) : null;
  const reviewAssociations=options.modelReviewAssociations??importHost?.workAssociations;
  if(reviewAssociations&&(!(reviewAssociations instanceof ConversationWorkStore)||reviewAssociations.projectPath!==projectPath))assetReviewFailure('CONFIGURATION');
  if (importHost && (!(importHost.workAssociations instanceof ConversationWorkStore) || importHost.workAssociations.projectPath !== projectPath ||
      typeof importHost.selectTarget !== 'function' || (importHost.loadObservedBaseline !== undefined && typeof importHost.loadObservedBaseline !== 'function'))) {
    throw new ArcaneError('STUDIO_IMPORT_SCOPE', 'Studio import host configuration must borrow the exact project store and host callbacks.');
  }
  const root = await prepareOutputRoot(options.cwd, options.outputRoot ?? join(options.cwd, 'runtime', 'assets'));
  const ownerKey = process.platform === 'win32' ? root.toLowerCase() : root;
  if (outputOwners.has(ownerKey)) throw new AssetError('BUSY', 'An asset service already owns this output root in this process.');
  outputOwners.add(ownerKey);
  const pipeline = new AssetPipeline({ workspaceRoot: options.cwd, outputRoot: root, workerRoot: options.workerRoot ?? join(options.cwd, 'workers', 'blender'),
    ...(options.blenderExecutable ? { blenderExecutable: options.blenderExecutable } : {}),
    ...(options.pythonExecutable ? { pythonExecutable: options.pythonExecutable } : {}) },
    options.workerQueryHost ? { queryHost: options.workerQueryHost } : {});
  const writeMarker = options.resolutionMarkerWriter ?? ((directory: string, filename: string, text: string) => atomicAssetJson(directory, filename, text));
  const entries = new Map<string, { directory: string; job: AssetJobRecord }>();
  let archives:AssetArchiveStore;
  let archiveScan:AssetArchiveScan;
  const unavailableHistory=new Map<string,AssetHistoryUnavailable>();
  const unclassifiedHistory=new Map<string,AssetJobDirectory>();
  const active = new Map<string, { handle: AssetJob; completion: Promise<void> }>();
  const historyReads=new Set<Promise<unknown>>();
  const reviewedImports=new Map<string,{subject:AssetReviewSubject;reference:AssetReviewReference;assertSourceCurrent():void}>();
  let probeActive: AbortController | null = null;
  let adoption: Promise<GeneratedOrAdoptedAssetJobRecord> | null = null;
  // The parent remains read-pinned across actual accepted worker cleanup. An
  // unresolved child retains this pin until its exact human resolution proof.
  const conversionParents = new Map<string, { parentJobId: string; release(): void }>();
  let artifactReadActive = false;
  let studioImportActive = false;
  let pending: Promise<void> = Promise.resolve(), persistenceError = false, closed = false;
  let saveTail:Promise<AssetSaveOutcome>=Promise.resolve<AssetSaveOutcome>({ok:true});
  let scheduledIndex: string | null = null;
  let closing: Promise<void> | null = null;
  let persistenceIssue: {phase:'path-check'|'write'|'replace';code:string}|null=null;
  async function reportFailure(job:AssetJobRecord):Promise<void>{
    if(!job.error||!options.reportFailure)return;
    try{const event=assetFailureEvent(job.jobId,job.error),reportId=await options.reportFailure(event);if(reportId===event.eventId)job.reportId=reportId;}
    catch{/* Diagnostic storage cannot replace the original failure or change job state. */}
  }
  const ordered = () => [...entries.values()].map(e => e.job).sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.jobId.localeCompare(a.jobId));
  const snapshot = () => structuredClone(ordered());
  const persist = ():Promise<AssetSaveOutcome> => {
    // The advisory index stores only observed events. Full requests remain in journals/manifests.
    if (persistenceError) return saveTail;
    const jobs = [...entries.values()].map(({ job }) => ({ jobId: job.jobId, events: structuredClone(job.events),...(job.reportId?{reportId:job.reportId}:{}) }));
    const text = JSON.stringify({ schemaVersion: 1, jobs }, null, 2) + '\n';
    // Completion changes job state, not the event-only index. Avoid replacing identical bytes.
    if (text === scheduledIndex) return saveTail;
    scheduledIndex = text;
    const captured=captureAssetSave(saveTail,()=>atomicAssetJson(root,'index.json',text));
    saveTail=captured;
    pending = captured.then(outcome => {
      if(outcome.ok)return;
      const error=outcome.error;
      persistenceError = true;
      if (!persistenceIssue) persistenceIssue = error instanceof AtomicJsonFailure
        ? { phase: error.phase, code: error.code } : { phase: 'path-check', code: 'UNKNOWN' };
      // First fatal failure latches. Keep original journals and the uncommitted snapshot.
    });
    return captured;
  };
  const flushed = async () => {
    // Events may enqueue a new snapshot while the previous tail is being awaited.
    for (;;) { const tail = pending; await tail; if (tail === pending) break; }
    if (persistenceError) throw new ArcaneError('PERSISTENCE', 'Asset history could not be saved' +
      (persistenceIssue ? ' (' + persistenceIssue.phase + '/' + persistenceIssue.code + ')' : '') + '; inspect retained job journals.');
  };
  const ensureOpen = () => { if (closed) throw new ArcaneError('CLOSED', 'Asset service is closed.'); };
  // Worker-status resolution: one human check at a time, mutually exclusive with admission and Blender work.
  let resolution: { controller: AbortController; task: Promise<WorkerResolutionOutcome> } | null = null;
  let retentionOperation:{controller:AbortController;task:Promise<unknown>}|null=null;
  const lifetime=new AbortController();
  let admitting = false;
  // A marker write whose commit could not be confirmed keeps that job fenced for this process lifetime.
  const uncertainResolutions = new Set<string>();
  type Witness = { directory: string; jobId: string; markerSha256: string; journalSha256: string };
  type Stored = { status: 'absent' } | { status: 'invalid' } | { status: 'resolved'; record: WorkerResolutionRecord; witness: Witness };
  /** Validate the stored marker against the CURRENT journal bytes (never an index or in-memory claim). */
  const storedResolution = async (directory: string, jobId: string): Promise<Stored> => {
    let marker: Buffer;
    try { marker = await readRegularFile(artifactPath(directory, RESOLUTION_MARKER), RESOLUTION_RECORD_BYTES); }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { status: 'absent' } : { status: 'invalid' }; }
    try {
      const journal = await readRegularFile(artifactPath(directory, 'job.json'), JOB_JOURNAL_BYTES);
      const validity = validateResolution({ jobId, journal, record: marker });
      return validity.valid ? { status: 'resolved', record: validity.record, witness: { directory, jobId, markerSha256: sha256(marker), journalSha256: sha256(journal) } } : { status: 'invalid' };
    } catch { return { status: 'invalid' }; }
  };
  /** Re-read every witnessed marker/journal; any byte change, read fault or uncertainty fails the witness. */
  const witnessUnchanged = async (witnesses: readonly Witness[]): Promise<boolean> => {
    for (const w of witnesses) {
      if (uncertainResolutions.has(w.jobId)) return false;
      try {
        const marker = await readRegularFile(artifactPath(w.directory, RESOLUTION_MARKER), RESOLUTION_RECORD_BYTES);
        const journal = await readRegularFile(artifactPath(w.directory, 'job.json'), JOB_JOURNAL_BYTES);
        if (sha256(marker) !== w.markerSha256 || sha256(journal) !== w.journalSha256) return false;
      } catch { return false; }
    }
    return true;
  };
  const showResolution = (job: AssetJobRecord, stored: Stored) => {
    if (uncertainResolutions.has(job.jobId)) job.resolution = { status: 'uncertain' };
    else if (stored.status === 'resolved') job.resolution = { status: 'resolved', resolvedAt: stored.record.assessedAt };
    else if (stored.status === 'invalid') job.resolution = { status: 'invalid' };
    else delete job.resolution;
    if (job.kind === 'converted-glb' && job.state === 'interrupted') {
      if (stored.status === 'resolved' && !uncertainResolutions.has(job.jobId)) releaseConversionParent(job.jobId);
      else retainConversionParent(job);
    }
  };
  function releaseConversionParent(jobId: string): void {
    const held = conversionParents.get(jobId);
    if (held) { conversionParents.delete(jobId); held.release(); }
  }
  function retainConversionParent(job: ConvertedAssetJobRecord, release?: () => void): void {
    const parentJobId = job.creation?.parentJobId ?? job.request?.parentJobId;
    if (!parentJobId) { release?.(); return; } // Genuine legacy absence is not lineage.
    const held = conversionParents.get(job.jobId);
    if (held) {
      release?.();
      if (held.parentJobId !== parentJobId) throw new AssetError('RECOVERY', 'Converted parent lineage changed.');
      return;
    }
    conversionParents.set(job.jobId, { parentJobId, release: release ?? archives.pin([parentJobId]) });
  }
  async function readConversionJournal(directory: string): Promise<{ journal: Record<string, unknown>; metadata: ConvertedGlbJobMetadata }> {
    const journal = record(parseConvertedGlbJson(await readRegularFile(artifactPath(directory, 'job.json'), JOB_JOURNAL_BYTES)), 'conversion journal');
    return { journal, metadata: parseConvertedGlbJobMetadata(journal) };
  }
  function convertedWorkersClosed(journal: Record<string, unknown>): boolean {
    const workers = Object.hasOwn(journal, 'workers') ? parseWorkerRecords(journal.workers) : null;
    // An explicit empty list is a pre-worker outcome. Absent, malformed or
    // unresolved records never establish closure from a terminal state label.
    return workers !== null && workers.every(worker => worker.state === 'closed');
  }
  const holdsFence = (job: AssetJobRecord) => job.state === 'interrupted' && !isAdoptedGlbRequest(job.request);
  /** Blocked while any interrupted job lacks a currently valid, confirmed marker; otherwise the witnessed bytes. */
  const fenced = async (): Promise<{ blocked: boolean; witnesses: Witness[] }> => {
    let blocked = false; const witnesses: Witness[] = [];
    for (const e of entries.values()) {
      if (!holdsFence(e.job)) continue;
      const stored = await storedResolution(e.directory, e.job.jobId);
      showResolution(e.job, stored);
      if (stored.status !== 'resolved' || uncertainResolutions.has(e.job.jobId)) blocked = true;
      else witnesses.push(stored.witness);
    }
    return { blocked, witnesses };
  };
  async function recoverEntry(ref:AssetJobDirectory,readOnly=false):Promise<{directory:string;job:AssetJobRecord}>{
    const directory=ref.directory,match=[ref.name+'-'+ref.jobId,ref.name,ref.jobId];
      const journal = record(await readJson(join(directory, 'job.json'), JOB_JOURNAL_BYTES), 'job journal');
      if(journal.schemaVersion!==1||!['running','succeeded','failed','cancelled','timed_out','interrupted'].includes(String(journal.state)))
        throw new AssetError('RECOVERY','The saved job state cannot be verified.');
      if (id(journal.jobId) !== match[2]) throw new AssetError('RECOVERY', 'Job directory and journal identities disagree.');
      // Reclassification is read-only. A newly discovered running journal retains
      // its admission fence instead of being rewritten as part of rebuilding an index.
      if(readOnly&&journal.state==='running')throw new AssetError('RECOVERY','The saved job still needs supervision recovery.');
      if (journal.kind === 'converted-glb' || Object.hasOwn(journal, 'creation')) {
        const saved = await readConversionJournal(directory);
        if (saved.metadata.jobId !== ref.jobId || saved.metadata.name !== null && saved.metadata.name !== ref.name) throw new AssetError('RECOVERY', 'Converted job directory and metadata disagree.');
        let state: AssetJobState, error: AssetJobError | null = null;
        try {
          const recovered = await pipeline.recover(directory);
          state = recovered.result.state;
          if (recovered.result.error) error = decodeAssetJobError(recovered.result.error);
        } catch (e) {
          if (e instanceof AssetError && e.code === 'BUSY') throw e;
          // A recovery exception is not proof that the original worker closed.
          state = 'interrupted'; error = { code: 'HISTORY_INTEGRITY', message: 'Converted retained evidence or worker closure could not be verified.' };
        }
        const latest = await readConversionJournal(directory), now = new Date().toISOString();
        if (!isDeepStrictEqual(latest.metadata, saved.metadata)) throw new AssetError('RECOVERY', 'Converted metadata changed during recovery.');
        if (!convertedWorkersClosed(latest.journal)) {
          state = 'interrupted'; error = { code: 'SUPERVISION_LOST', message: 'Converted worker closure remains unverified; no replay.' };
        }
        const startedAt = timestamp(latest.journal.startedAt, now);
        const job: ConvertedAssetJobRecord = { schemaVersion: 1, jobId: ref.jobId, directory,
          ...conversionRecordMetadata(latest.metadata), state, error,
          manifestPath: state === 'succeeded' ? join(directory, 'manifest.json') : null,
          manifestAvailable: state === 'succeeded', stage: state === 'interrupted' ? 'supervision-lost' : 'complete',
          startedAt, updatedAt: timestamp(latest.journal.finishedAt, startedAt), events: [],
          ...(typeof latest.journal.finishedAt === 'string' ? { finishedAt: latest.journal.finishedAt } : {}) };
        if (state === 'succeeded') {
          try { await verifiedSavedManifest(directory, ref.jobId, job); }
          catch { job.state = 'failed'; job.error = { code: 'HISTORY_INTEGRITY', message: 'Converted retained scope or artifacts failed verification.' }; job.manifestPath = null; job.manifestAvailable = false; }
        }
        if (job.state === 'interrupted') retainConversionParent(job);
        return { directory, job };
      }
      if (isAdoptedGlbRequest(journal.request)) {
        const request = parseAdoptedGlbRequest(journal.request);
        if (request.name !== match[1]) throw new AssetError('RECOVERY','Adopted job identity disagrees.');
        const startedAt = timestamp(journal.startedAt, new Date().toISOString());
        let state: AssetJobState = journal.state === 'running' ? 'interrupted' : journal.state === 'succeeded' ? 'succeeded' : 'failed';
        let error: AssetJobRecord['error'] = state === 'interrupted' ? {code:'SUPERVISION_LOST',message:'Adoption completion is unknown; no replay.'} : null;
        if (state === 'succeeded') {
          try {
            const manifest = await validateAdoptedGlbManifest(directory, await readJson(join(directory,'manifest.json')));
            if(manifest.jobId !== match[2] || !isDeepStrictEqual(manifest.request,request) || !importHost || manifest.provenance.projectId !== importHost.workAssociations.projectId) throw new Error('scope');
          } catch {state='failed';error={code:'HISTORY_INTEGRITY',message:'Managed adopted GLB evidence failed verification.'};}
        }
        return {directory,job:{schemaVersion:1,jobId:match[2]!,directory,request,state,stage:'complete',startedAt,
          updatedAt:timestamp(journal.updatedAt,startedAt),...(typeof journal.finishedAt==='string'?{finishedAt:journal.finishedAt}:{}),
          manifestPath:state==='succeeded'?join(directory,'manifest.json'):null,manifestAvailable:state==='succeeded',events:[],error}};
      }
      let request: AssetRequest;
      try { request = normalizeRequest(journal.request ?? await readJson(join(directory, 'request.json'), CUSTOM_REQUEST_BYTES)); }
      catch { throw new AssetError('RECOVERY', 'Job history has no valid request.'); }
      if (request.name !== match[1]) throw new AssetError('RECOVERY', 'Job directory and request names disagree.');
      let state: AssetJobState, error: AssetJobRecord['error'] = null;
      try {
        const recovered = await pipeline.recover(directory);
        state = recovered.result.state;
        if (recovered.result.error) {
          error = decodeAssetJobError(recovered.result.error);
        }
      } catch (e) {
        if (e instanceof AssetError && e.code === 'BUSY') throw e;
        state = 'failed'; error = { code: 'HISTORY_INTEGRITY', message: 'Retained job evidence failed verification; inspect local artifacts.' };
      }
      const now = new Date().toISOString();
      return { directory, job: { schemaVersion: 1, jobId: match[2]!, directory, manifestPath: state === 'succeeded' ? join(directory, 'manifest.json') : null, ...(typeof journal.finishedAt === 'string' ? { finishedAt: journal.finishedAt } : {}), request, state, stage: state === 'interrupted' ? 'supervision-lost' : 'complete',
        startedAt: timestamp(journal.startedAt, timestamp(journal.finishedAt, now)), updatedAt: timestamp(journal.finishedAt, now), events: [],
        manifestAvailable: state === 'succeeded', error } };
  }
  try {
    archives=await AssetArchiveStore.open({root});archiveScan=await archives.scan();
    for(const ref of archiveScan.unclassified)unclassifiedHistory.set(ref.jobId,ref);
    for(const ref of archiveScan.active){
      try{const entry=await recoverEntry(ref);entries.set(ref.jobId,entry);
        if(entry.job.error?.code==='HISTORY_INTEGRITY')unavailableHistory.set(ref.jobId,{jobId:ref.jobId,name:ref.name,status:'conflict'});}
      catch(error){
        if(error instanceof AssetError&&error.code==='BUSY')throw error;
        unavailableHistory.set(ref.jobId,{jobId:ref.jobId,name:ref.name,status:'conflict'});
      }
    }
    // Interrupted jobs show their stored worker-status check, validated against the exact journal bytes.
    for (const e of entries.values()) if (holdsFence(e.job)) showResolution(e.job, await storedResolution(e.directory, e.job.jobId));
    // Restore bounded observed events from the advisory index; it never supplies paths or states.
    try {
      const previous = record(await readJson(join(root, 'index.json'), 8 * 1024 * 1024), 'history index');
      if (previous.schemaVersion === 1 && Array.isArray(previous.jobs) && previous.jobs.length <= LIMIT) {
        for (const raw of previous.jobs) {
          const old = record(raw, 'history entry'), current = typeof old.jobId === 'string' ? entries.get(old.jobId) : undefined;
          if (!current || !Array.isArray(old.events) || old.events.length > 64) continue;
          const events: AssetJobEvent[] = [];
          for (const rawEvent of old.events) {
            const event = record(rawEvent, 'history event');
            if (event.jobId !== current.job.jobId || typeof event.at !== 'string' || !Number.isFinite(Date.parse(event.at)) || typeof event.stage !== 'string' || !/^[a-z-]{1,48}$/.test(event.stage) || !['running', 'succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(String(event.state))) throw new AssetError('RECOVERY', 'Invalid observed history event.');
            events.push(event as unknown as AssetJobEvent);
          }
          current.job.events = events;
          // Display-only correlation to an acknowledged host report; never job state or write authority.
          if(current.job.error&&typeof old.reportId==='string'&&ID.test(old.reportId))current.job.reportId=old.reportId;
        }
      }
    } catch { /* Index is rebuildable; verified journals remain the authority. */ }
    // Preserve the advisory index too when the locator cannot classify every retained record.
    if(!archiveScan.degraded&&!unavailableHistory.size){persist();await flushed();}
  } catch (e) { outputOwners.delete(ownerKey); throw e; }

  function retainedRead<T>(jobIds:readonly string[],read:()=>Promise<T>):Promise<T>{
    ensureOpen();const release=archives.pin(jobIds);
    const task=Promise.resolve().then(read).finally(()=>{release();historyReads.delete(task);});
    historyReads.add(task);return task;
  }
  async function verifiedSavedManifest(directory:string,jobId:string,job:AssetJobRecord,bindFullRequest=true):Promise<AssetPreviewManifest>{
    if (job.kind === 'converted-glb') {
      if (!job.request) throw new AssetError('MANIFEST', 'Converted manifest requires an observed prepared request.');
      const manifest = await pipeline.validateConversion(join(directory, 'manifest.json'));
      if (manifest.jobId !== jobId || !isDeepStrictEqual(manifest.request, job.request)) throw new AssetError('MANIFEST', 'Converted manifest differs from its recorded request.');
      const rawParent = await readRegularFile(artifactPath(directory, 'parent-manifest.json'), GLB_CONVERSION_LIMITS.jsonBytes);
      const parent = parseAdoptedGlbManifest(parseConvertedGlbJson(rawParent));
      if (sha256(rawParent) !== job.request.parentManifestSha256 || parent.jobId !== job.request.parentJobId) throw new AssetError('MANIFEST', 'Converted parent snapshot differs from its recorded lineage.');
      const associations = importHost?.workAssociations;
      const childBinding = associations?.captureBinding('asset-job', jobId), parentBinding = associations?.captureBinding('asset-job', parent.jobId);
      if (!associations || associations.projectPath !== projectPath || !childBinding || !parentBinding ||
          associations.projectId !== parent.provenance.projectId || childBinding.binding.projectId !== parent.provenance.projectId ||
          parentBinding.binding.projectId !== parent.provenance.projectId ||
          !isDeepStrictEqual(childBinding.binding.conversation, parent.provenance.conversation) ||
          !isDeepStrictEqual(parentBinding.binding.conversation, parent.provenance.conversation)) throw new AssetError('MANIFEST', 'Converted lineage differs from its durable conversation bindings.');
      childBinding.assertCurrent(); parentBinding.assertCurrent();
      return manifest;
    }
    const request = job.request;
    const manifest=isAdoptedGlbRequest(request)
      ?await validateAdoptedGlbManifest(directory,await readJson(join(directory,'manifest.json')))
      :await pipeline.validate(join(directory,'manifest.json'));
    if(manifest.jobId!==jobId||manifest.request.name!==request.name||bindFullRequest&&!isDeepStrictEqual(manifest.request,request))throw new AssetError('MANIFEST','Manifest identity differs from its saved job request.');
    if(isAdoptedGlbManifest(manifest)){
      const binding=importHost?.workAssociations.binding('asset-job',jobId);
      if(!isDeepStrictEqual(manifest.request,request)||!binding||binding.projectId!==manifest.provenance.projectId||!isDeepStrictEqual(binding.conversation,manifest.provenance.conversation))
        throw new AssetError('MANIFEST','Adopted snapshot differs from its durable conversation binding.');
    }
    return manifest;
  }

  async function loadEntry(jobId:unknown):Promise<{directory:string;job:AssetJobRecord}>{
    return retainedRead([id(jobId)],async()=>{
    ensureOpen();const requested=id(jobId),current=entries.get(requested);
    const unavailable=unavailableHistory.get(requested);if(unavailable)throw new UnavailableAssetHistory(unavailable);
    if(current)return current;
    if(unclassifiedHistory.has(requested))throw new UnavailableAssetHistory({jobId:requested,name:unclassifiedHistory.get(requested)!.name,status:'unclassified'});
    if(!archives.isArchived(requested))throw new ArcaneError('NOT_FOUND','Unknown asset job.');
    const retained=await archives.read(requested);ensureOpen();
    if(retained.status!=='archived'||!retained.journal)throw new UnavailableAssetHistory({jobId:requested,name:retained.entry.name,status:retained.status==='archived'?'conflict':retained.status});
    // Read-only hydration: never call recover() for archived bytes (it can rewrite a running journal).
    const journal=record(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(retained.journal)),'archived job');
    if (journal.kind === 'converted-glb' || Object.hasOwn(journal, 'creation')) {
      try {
      const strict = record(parseConvertedGlbJson(retained.journal), 'archived conversion'), metadata = parseConvertedGlbJobMetadata(strict);
      if (metadata.jobId !== requested || metadata.name !== null && metadata.name !== retained.entry.name) throw new UnavailableAssetHistory({jobId:requested,name:retained.entry.name,status:'conflict'});
      const startedAt = timestamp(strict.startedAt, retained.entry.archivedAt), finishedAt = timestamp(strict.finishedAt, startedAt);
      const originalError = strict.error === undefined || strict.error === null ? null : decodeAssetJobError(strict.error);
      if (retained.entry.state === 'succeeded' && originalError) throw new UnavailableAssetHistory({jobId:requested,name:retained.entry.name,status:'conflict'});
      const job: ConvertedAssetJobRecord = { schemaVersion:1,jobId:requested,directory:retained.directory,
        ...conversionRecordMetadata(metadata),state:retained.entry.state,
        stage:retained.entry.state==='interrupted'?'supervision-lost':'complete',startedAt,updatedAt:finishedAt,
        ...(typeof strict.finishedAt==='string'?{finishedAt:strict.finishedAt}:{}),manifestPath:null,manifestAvailable:false,events:[],
        error:originalError??(retained.entry.state==='interrupted'?{code:'SUPERVISION_LOST',message:'The interrupted conversion was retained; no replay.'}:null),
        retention:{status:'archived',archivedAt:retained.entry.archivedAt}};
      if (job.state === 'succeeded') {
        try { await verifiedSavedManifest(retained.directory,requested,job);job.manifestAvailable=true;job.manifestPath=join(retained.directory,'manifest.json'); }
        catch { ensureOpen();throw new UnavailableAssetHistory({jobId:requested,name:retained.entry.name,status:'conflict'}); }
      }
      if (job.state === 'interrupted') { retainConversionParent(job);showResolution(job,await storedResolution(retained.directory,requested)); }
      const current = await archives.read(requested);ensureOpen();
      if(current.status!=='archived'||!current.journal?.equals(retained.journal))throw new UnavailableAssetHistory({jobId:requested,name:retained.entry.name,status:'changed'});
      return {directory:retained.directory,job};
      } catch (error) {
        ensureOpen();
        if (error instanceof UnavailableAssetHistory) throw error;
        throw new UnavailableAssetHistory({jobId:requested,name:retained.entry.name,status:'conflict'});
      }
    }
    let request:AssetRequest|AdoptedGlbRequest;
    try{request=isAdoptedGlbRequest(journal.request)?parseAdoptedGlbRequest(journal.request):normalizeRequest(journal.request);}
    catch{throw new UnavailableAssetHistory({jobId:requested,name:retained.entry.name,status:'conflict'});}
    if(request.name!==retained.entry.name||journal.jobId!==requested)throw new UnavailableAssetHistory({jobId:requested,name:retained.entry.name,status:'conflict'});
    const startedAt=timestamp(journal.startedAt,retained.entry.archivedAt),finishedAt=timestamp(journal.finishedAt,startedAt);
    let originalError:AssetJobRecord['error']=null;
    if(journal.error!==undefined&&journal.error!==null){
      try { originalError=decodeAssetJobError(journal.error); }
      catch { throw new UnavailableAssetHistory({jobId:requested,name:retained.entry.name,status:'conflict'}); }
    }
    const job:AssetJobRecord={schemaVersion:1,jobId:requested,directory:retained.directory,request,state:retained.entry.state,
      stage:retained.entry.state==='interrupted'?'supervision-lost':'complete',startedAt,updatedAt:finishedAt,
      ...(typeof journal.finishedAt==='string'?{finishedAt:journal.finishedAt}:{}),
      manifestPath:retained.entry.manifestAvailable?join(retained.directory,'manifest.json'):null,manifestAvailable:retained.entry.manifestAvailable,
      events:[],error:originalError??(retained.entry.state==='interrupted'?{code:'SUPERVISION_LOST',message:'The interrupted job was retained; no replay.'}:null),
      retention:{status:'archived',archivedAt:retained.entry.archivedAt}};
    if(job.state==='succeeded'&&!job.manifestAvailable){
      // A rebuilt ledger cannot infer exports from a terminal state. A scoped
      // history read may establish availability from the actual saved files.
      try{await verifiedSavedManifest(retained.directory,requested,job);job.manifestAvailable=true;job.manifestPath=join(retained.directory,'manifest.json');}
      catch{ensureOpen();job.error={code:'HISTORY_INTEGRITY',message:'Saved exports need inspection before they can be used.'};}
      const current=await archives.read(requested);ensureOpen();
      if(current.status!=='archived'||!current.journal?.equals(retained.journal))throw new UnavailableAssetHistory({jobId:requested,name:retained.entry.name,status:'changed'});
    }
    if(retained.entry.state==='interrupted')showResolution(job,await storedResolution(retained.directory,requested));
    // Archived progress is advisory and never supplies file paths, state or worker authority.
    try{const saved=record(await readJson(join(retained.directory,'observed-events.json'),16384),'archived observations');
      if(saved.schemaVersion===1&&saved.jobId===requested&&Array.isArray(saved.events)&&saved.events.length<=64&&saved.events.every(raw=>{
        const event=record(raw,'archived event');return event.jobId===requested&&typeof event.at==='string'&&Number.isFinite(Date.parse(event.at))&&
          typeof event.stage==='string'&&/^[a-z-]{1,48}$/.test(event.stage)&&['running','succeeded','failed','cancelled','timed_out','interrupted'].includes(String(event.state));
      }))job.events=saved.events as AssetJobEvent[];
    }catch{/* Missing advisory observations do not replace journal authority. */}
    ensureOpen();return{directory:retained.directory,job};
    });
  }
  async function lookupJobs(jobIds:readonly string[]):Promise<{jobs:AssetJobRecord[];unavailable:AssetHistoryUnavailable[]}>{
    ensureOpen();if(!Array.isArray(jobIds)||jobIds.length>64||new Set(jobIds).size!==jobIds.length||jobIds.some(value=>typeof value!=='string'||value.length!==36||!ID.test(value)))throw new ArcaneError('INPUT','Choose at most 64 exact unique job UUIDs.');
    const ids=[...jobIds],release=archives.pin(ids),jobs:AssetJobRecord[]=[],unavailable:AssetHistoryUnavailable[]=[];
    try{for(const requested of ids){
      try{jobs.push(structuredClone((await loadEntry(requested)).job));}
      catch(error){ensureOpen();if(error instanceof UnavailableAssetHistory)unavailable.push(structuredClone(error.item));
        else if(error instanceof ArcaneError&&error.code==='NOT_FOUND')unavailable.push({jobId:requested,status:'missing'});
        else throw error;}
    }return{jobs,unavailable};}finally{release();}
  }
  async function retentionFacts(jobId:string):Promise<ArchiveHostFacts>{
    ensureOpen();if(importHost&&!options.retentionPins)throw new ArcaneError('HISTORY_INTEGRITY','Retained import state needs host inspection before archival.');
    const preparationRecord=options.retentionPins?await options.retentionPins.preparationRecord(jobId):false;ensureOpen();
    // Refresh relevant child witnesses before parent retention effects. A marker
    // that was once valid cannot permanently release a changed/uncertain child.
    for (const {job,directory} of entries.values()) if (job.kind === 'converted-glb' && job.state === 'interrupted' &&
        (job.creation?.parentJobId ?? job.request?.parentJobId) === jobId) showResolution(job,await storedResolution(directory,job.jobId));
    const pendingStage=options.retentionPins?.pendingStage(jobId)??false,importCaptured=options.retentionPins?.importCaptured(jobId)??false;
    if(typeof preparationRecord!=='boolean'||typeof pendingStage!=='boolean'||typeof importCaptured!=='boolean')throw new ArcaneError('HISTORY_INTEGRITY','Retained-work facts are unavailable.');
    return{active:active.has(jobId),readPinned:false,importCaptured,preparationRecord,pendingStage,uncertainLatch:uncertainResolutions.has(jobId),manifestVerified:entries.get(jobId)?.job.manifestAvailable===true};
  }
  /** Reconcile a committed classification from current bytes without restarting work.
   * Unreadable, malformed or still-running records remain visible and keep admission fenced. */
  async function reconcileHistory():Promise<{active:number;archived:number;unavailable:number;degraded:boolean}>{
    const previous=new Map(entries);archiveScan=await archives.scan();
    entries.clear();unavailableHistory.clear();unclassifiedHistory.clear();
    for(const ref of archiveScan.unclassified)unclassifiedHistory.set(ref.jobId,ref);
    for(const ref of archiveScan.active){
      try{
        const entry=await recoverEntry(ref,true);
        entry.job.events=previous.get(ref.jobId)?.job.events??[];
        if(holdsFence(entry.job))showResolution(entry.job,await storedResolution(entry.directory,ref.jobId));
        entries.set(ref.jobId,entry);
        if(entry.job.error?.code==='HISTORY_INTEGRITY')unavailableHistory.set(ref.jobId,{jobId:ref.jobId,name:ref.name,status:'conflict'});
      }catch{unavailableHistory.set(ref.jobId,{jobId:ref.jobId,name:ref.name,status:'conflict'});}
    }
    const degraded=archiveScan.degraded||unavailableHistory.size>0||unclassifiedHistory.size>0;
    if(!degraded){persist();await flushed();}
    return{active:archiveScan.active.length,archived:archiveScan.archived.length,unavailable:unavailableHistory.size,degraded};
  }
  async function maintainHistory(kind:'rebuild'|'confirm',signal?:AbortSignal):Promise<{active:number;archived:number;unavailable:number;degraded:boolean;backup:string|null}>{
    ensureOpen();
    if(retentionOperation||admitting||resolution||active.size||probeActive||adoption||artifactReadActive||studioImportActive||historyReads.size)
      throw new AssetError('BUSY','Wait for the current asset operation before inspecting retained history.');
    const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    const guard=()=>{ensureOpen();if(controller.signal.aborted)throw new ArcaneError('CANCELLED','History inspection was cancelled before its ledger write.');};
    const run=async()=>{
      await flushed();guard();let backup:string|null=null,committed=false;
      try{
        if(kind==='rebuild')backup=(await archives.rebuild({facts:retentionFacts,guard})).backup;
        else await archives.confirm(guard);
        committed=true;
        // Once the store reports a committed/confirmed outcome, finish the view
        // even after caller retirement. Closing joins this owned operation.
        return{...await reconcileHistory(),backup};
      }catch(error){
        if(committed)throw new ArcaneError('ASSET_ARCHIVE_UNCERTAIN','The history change was saved, but its refreshed view could not be confirmed. Inspect recorded history before another change.');
        if(error instanceof ArcaneError&&error.code==='ASSET_ARCHIVE_BACKUP'){
          const scan=await archives.scan();if(scan.reasons.includes('commit-uncertain'))throw new ArcaneError('ASSET_ARCHIVE_UNCERTAIN','The history change needs inspection before its outcome can be confirmed.');
        }
        throw error;
      }
    };
    const task=run();retentionOperation={controller,task};
    try{return await task;}finally{signal?.removeEventListener('abort',abort);if(retentionOperation?.task===task)retentionOperation=null;}
  }
  async function ensureHistoryRoom(guard:()=>void):Promise<void>{
    archiveScan=await archives.scan();ensureOpen();synchronousAdmissionResult(guard());
    if(archiveScan.degraded||unavailableHistory.size||unclassifiedHistory.size)throw new ArcaneError('HISTORY_INTEGRITY','Retained history needs inspection before new asset work. Existing files are kept.');
    if(entries.size<LIMIT)return;
    if(artifactReadActive||studioImportActive)throw new AssetError('BUSY','Wait for retained asset reads or import preparation before archiving history.');
    const selected:string[]=[];
    for(const job of ordered().toReversed()){
      if(selected.length>=32)break;
      if(job.state==='running'||uncertainResolutions.has(job.jobId))continue;
      const facts=await retentionFacts(job.jobId);synchronousAdmissionResult(guard());
      if(await archives.eligible(job.jobId,facts))selected.push(job.jobId);ensureOpen();synchronousAdmissionResult(guard());
    }
    if(!selected.length)throw new ArcaneError('HISTORY_LIMIT','Retained work pins the active history limit. Inspect interrupted jobs and pending imports before starting another job.');
    for(const jobId of selected){const e=entries.get(jobId)!;
      await atomicAssetJson(e.directory,'observed-events.json',JSON.stringify({schemaVersion:1,jobId,events:e.job.events})+'\n');
      ensureOpen();synchronousAdmissionResult(guard());
    }
    const archived=await archives.archive({jobIds:selected,activeCount:entries.size,facts:retentionFacts,guard:()=>{ensureOpen();synchronousAdmissionResult(guard());}});
    // Ledger authority committed; the active index is advisory. Retained UUIDs load through the archive store.
    for(const jobId of archived)entries.delete(jobId);persist();await flushed();ensureOpen();synchronousAdmissionResult(guard());
    archiveScan=await archives.scan();ensureOpen();synchronousAdmissionResult(guard());
  }

  function reviewScope(input:AssetReviewScope,jobId:string,guard:()=>void):AssetReviewScope {
    ensureOpen();guard();const scope=snapshotAssetReviewScope(input);
    if(!reviewAssociations||reviewAssociations.projectPath!==projectPath||reviewAssociations.projectId!==scope.projectId)assetReviewFailure('SCOPE');
    const binding=reviewAssociations.binding('asset-job',jobId);
    if(!binding||binding.projectId!==scope.projectId||!isDeepStrictEqual(binding.conversation,scope.conversation))assetReviewFailure('SCOPE');
    return scope;
  }
  async function readModelReview(jobId:unknown,inputScope:AssetReviewScope,guard:()=>void):Promise<{subject:AssetReviewSubject;assertCurrent():void;assertSourceCurrent():void}> {
    const requested=id(jobId),scope=reviewScope(inputScope,requested,guard),end=Date.now()+ARTIFACT_DOWNLOAD_TIMEOUT_MS;
    const binding=reviewAssociations!.captureBinding('asset-job',requested);
    if(!binding||binding.binding.projectId!==scope.projectId||!isDeepStrictEqual(binding.binding.conversation,scope.conversation))assetReviewFailure('SCOPE');
    const lineageBindings=[binding];
    const currentBinding=()=>{ensureOpen();try{for(const witness of lineageBindings)witness.assertCurrent();}catch{assetReviewFailure('SCOPE');}};
    const check=()=>{guard();currentBinding();if(Date.now()>=end)assetReviewFailure('TIMEOUT');};
    const entry=await loadEntry(requested);check();
    if(entry.job.state!=='succeeded'||!entry.job.manifestAvailable||active.has(requested)||isAdoptedGlbRequest(entry.job.request))assetReviewFailure('JOB_STATE');
    const converted=entry.job.kind==='converted-glb';
    if(entry.job.kind==='converted-glb'){
      if(!entry.job.request)assetReviewFailure('JOB_STATE');
      // Capture the original parent witness before asynchronous artifact verification.
      // A later binding with identical fields cannot revive this review opening.
      const associations=importHost?.workAssociations;
      const parent=associations?.captureBinding('asset-job',entry.job.request.parentJobId);
      if(!associations||associations.projectPath!==projectPath||associations.projectId!==scope.projectId||!parent||
          parent.binding.projectId!==scope.projectId||!isDeepStrictEqual(parent.binding.conversation,scope.conversation))assetReviewFailure('SCOPE');
      lineageBindings.push(parent);currentBinding();
    }
    const verifyJournal=async()=>{
      if(entry.job.kind!=='converted-glb')return;
      const {journal,metadata}=await readConversionJournal(entry.directory);check();
      if(journal.state!=='succeeded'||!convertedWorkersClosed(journal)||metadata.jobId!==requested||metadata.form!==entry.job.form||
          !isDeepStrictEqual(metadata.request,entry.job.request)||!isDeepStrictEqual(metadata.creation,entry.job.creation??null))assetReviewFailure('JOB_STATE');
    };
    if(converted){await verifyJournal();check();}
    const first=await verifiedSavedManifest(entry.directory,requested,entry.job);check();
    if(isAdoptedGlbManifest(first)||convertedManifest(first)!==converted)assetReviewFailure('JOB_STATE');
    const paths=[join(entry.directory,'manifest.json'),...first.artifacts.map(a=>artifactPath(entry.directory,a.path)),
      ...(converted?[join(entry.directory,'job.json')]:[])];
    const fingerprint=(path:string):string=>{
      try{
        const stat=lstatSync(path,{bigint:true}),actual=process.platform==='win32'?realpathSync.native(path):realpathSync(path),same=process.platform==='win32'?actual.toLowerCase()===path.toLowerCase():actual===path;
        if(!stat.isFile()||stat.nlink!==1n||stat.isSymbolicLink()||!same)assetReviewFailure('SOURCE');
        return [stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(':');
      }catch{assetReviewFailure('SOURCE');}
    };
    const witnesses=new Map(paths.map(path=>[path,fingerprint(path)]));
    const sourceCurrent=()=>{currentBinding();for(const[path,saved]of witnesses)if(fingerprint(path)!==saved)assetReviewFailure('SOURCE');};
    const unchanged=()=>{guard();sourceCurrent();};
    // Verify once more INSIDE the captured metadata window. A source replaced
    // between the first proof and capture cannot become a valid new witness.
    const manifest=await verifiedSavedManifest(entry.directory,requested,entry.job);check();unchanged();
    if(isAdoptedGlbManifest(manifest)||convertedManifest(manifest)!==converted||assetReviewCanonical(manifest)!==assetReviewCanonical(first))assetReviewFailure('SOURCE');
    if(converted){await verifyJournal();check();unchanged();}
    const exports=new Map<'asset.glb'|'collision.glb',Buffer>();
    const exportPaths=convertedManifest(manifest)&&manifest.request.collision==='none'?['asset.glb'] as const:['asset.glb','collision.glb'] as const;
    for(const name of exportPaths){
      const bytes=await readRegularFile(artifactPath(entry.directory,name),STUDIO_IMPORT_LIMITS.fileBytes);check();unchanged();exports.set(name,bytes);
    }
    const subject=convertedManifest(manifest)?convertedModelReviewSubject(scope,manifest,exports):modelReviewSubject(scope,manifest,exports);unchanged();
    return Object.freeze({subject,assertCurrent:unchanged,assertSourceCurrent:sourceCurrent});
  }
  async function reviewImport(jobId:unknown,actor:NativeAssetActor,expected:AssetReviewReference|undefined,guard:()=>void):Promise<AssetReviewImportGuard> {
    if(!options.modelReview)assetReviewFailure('REQUIRED');
    const requested=id(jobId);
    const check=()=>{guard();assertStudioImportJobScope(projectPath,reviewAssociations!,actor,requested);};
    check();const scope=nativeAssetActorScope(actor),source=await readModelReview(requested,{projectId:scope.projectId,conversation:scope.conversation},check);check();
    const reference=snapshotAssetReviewReference(options.modelReview.assertApproved(source.subject,expected));
    const assertCurrent=()=>{source.assertCurrent();const result=options.modelReview!.assertReference(source.subject,reference);if(result!==undefined)assetReviewFailure('CONFIGURATION');};
    assertCurrent();
    const key=assetReviewCanonical({projectId:scope.projectId,conversation:scope.conversation,jobId:requested});
    if(!reviewedImports.has(key)&&reviewedImports.size>=64)assetReviewFailure('CAPACITY');
    reviewedImports.set(key,{subject:source.subject,reference,assertSourceCurrent:source.assertSourceCurrent});
    return Object.freeze({subject:source.subject,reference,assertCurrent});
  }
  function prepareImport(jobId: unknown, actor: NativeAssetActor, readers: StudioImportReaders, includePayload: false): Promise<PreparedStudioImport>;
  function prepareImport(jobId: unknown, actor: NativeAssetActor, readers: StudioImportReaders, includePayload: true, attempt?: StudioImportPreparationAttempt): Promise<PreparedStudioImportPayload>;
  async function prepareImport(jobId: unknown, actor: NativeAssetActor, readers: StudioImportReaders, includePayload: boolean, attempt?: StudioImportPreparationAttempt): Promise<PreparedStudioImport | PreparedStudioImportPayload> {
    ensureOpen();
    if (!importHost) throw new ArcaneError('STUDIO_IMPORT_UNAVAILABLE', 'Studio import host target/receipt selection has not been configured.');
    const requested = id(jobId);
    const work = acquireNativeAssetWork(actor, 'preparation');
    try {
    const end = Date.now() + ARTIFACT_DOWNLOAD_TIMEOUT_MS;
    let selected: import('../../../packages/asset-pipeline/src/studio-import-manifest.js').StudioImportSelection | undefined;
    let review:AssetReviewImportGuard|undefined;
    let convertedSource:{assertCurrent():void}|undefined;
    // Child host/store operations validate their own exact durable binding
    // around every await. Pass only the service lifetime/actor/target guard to
    // them, rather than performing the same expensive store scan twice at
    // each boundary. The service still rechecks its binding after every wait.
    const guard = () => {
      ensureOpen();
      if (Date.now() >= end) throw new ArcaneError('STUDIO_IMPORT_TIMEOUT', 'Studio import preparation exceeded its 30 second deadline.');
      assertNativeAssetActor(actor, 'mutate');
      const scope = nativeAssetActorScope(actor);
      if (selected && importHost.validateTarget) synchronousAdmissionResult(importHost.validateTarget(scope, requested, selected));
    };
    const check = () => { guard();review?.assertCurrent();convertedSource?.assertCurrent(); return assertStudioImportJobScope(projectPath, importHost.workAssociations, actor, requested); };
    const originalScope = check();
    const e = await loadEntry(requested);check();
    if (isAdoptedGlbRequest(e.job.request)) throw new ArcaneError('STUDIO_IMPORT_UNSUPPORTED','Adopted GLB origin requires safe conversion and observed source mapping; engine import is unavailable.');
    if (e.job.state !== 'succeeded' || !e.job.manifestAvailable || active.has(requested)) throw new ArcaneError('JOB_STATE', 'Import preparation requires a verified completed job.');
    if (studioImportActive) throw new AssetError('BUSY', 'A Studio import preparation is already running.');
    studioImportActive = true;
    // Bounds waits as well as reads; late host callbacks cannot expose a result.
    const wait = async <T>(start: () => T | Promise<T>,joinOnClose=false): Promise<T> => {
      const promise = work.run(start);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onClose:(()=>void)|undefined, onStop:(()=>void)|undefined;
      try {
        const waits:Promise<T>[]=[Promise.resolve(promise), new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new ArcaneError('STUDIO_IMPORT_TIMEOUT', 'Studio import preparation exceeded its 30 second deadline.')), Math.max(1, end - Date.now()));
        })];
        if(!joinOnClose)waits.push(new Promise<never>((_resolve,reject)=>{
          onClose=()=>reject(new ArcaneError('CLOSED','Asset service is closed.'));
          if(lifetime.signal.aborted)onClose();else lifetime.signal.addEventListener('abort',onClose,{once:true});
        }));
        // A preparation journal write that already began is still joined,
        // including on Stop; its original immutable-write outcome is preserved.
        if(!joinOnClose)waits.push(new Promise<never>((_resolve,reject)=>{
          onStop=()=>reject(new ArcaneError('CANCELLED','The original asset work was stopped.'));
          if(work.signal.aborted)onStop();else work.signal.addEventListener('abort',onStop,{once:true});
        }));
        const result = await Promise.race(waits);
        check(); return result;
      } finally { if (timer) clearTimeout(timer);if(onClose)lifetime.signal.removeEventListener('abort',onClose);if(onStop)work.signal.removeEventListener('abort',onStop); }
    };
    const payloadFiles = new Map<string, Uint8Array>();
    const authority = createStudioImportManifestAuthority({ loadGeneratedFiles: async value => {
      if (value !== requested) throw new ArcaneError('STUDIO_IMPORT_SCOPE', 'Import job identity changed.');
      const scope = check();
      // Tighten import size BEFORE the service's existing complete manifest proof.
      const exportPaths=e.job.kind==='converted-glb'&&e.job.request?.collision==='none'?['asset.glb'] as const:['asset.glb','collision.glb'] as const;
      for (const name of exportPaths) await wait(() => regularFile(artifactPath(e.directory, name), STUDIO_IMPORT_LIMITS.fileBytes));
      const manifest = await wait(() => readers.manifest(requested));
      if (convertedManifest(manifest)) {
        if(e.job.kind!=='converted-glb'||!e.job.request||!isDeepStrictEqual(manifest.request,e.job.request))throw new AssetError('HASH','Converted import request changed.');
        // These paths are fixed host-owned retained inputs, not public artifact
        // requests or caller-selected files. The source witness spans every read.
        const files=new Map<ConvertedImportRetainedPath,Buffer>();
        const paths:readonly ConvertedImportRetainedPath[]=['request.json','source-map.json','conversion-audit.json','source.glb','import-source.glb',...exportPaths];
        for(const path of paths){
          const declared=manifest.artifacts.find(row=>row.path===path);
          const isExport=path==='asset.glb'||path==='collision.glb';
          const maximum=isExport?STUDIO_IMPORT_LIMITS.fileBytes:path==='source.glb'||path==='import-source.glb'?CONVERTED_GLB_ARTIFACT_LIMITS.sourceBytes:CONVERTED_GLB_ARTIFACT_LIMITS.jsonBytes;
          const result=isExport?await wait(()=>readers.artifact(requested,path)):null;
          if(result&&result.contentType!=='model/gltf-binary')throw new AssetError('HASH','Converted export content type changed.');
          const bytes=result?result.bytes:await wait(()=>readRegularFile(artifactPath(e.directory,path),maximum));
          if(!declared||bytes.length!==declared.bytes||sha256(bytes)!==declared.sha256)throw new AssetError('HASH','Converted retained inputs changed during preparation.');
          files.set(path,bytes);
          if(includePayload&&isExport)payloadFiles.set(path==='asset.glb'?CONVERTED_STUDIO_IMPORT_FILE_IDS.render:CONVERTED_STUDIO_IMPORT_FILE_IDS.collision,Buffer.from(bytes));
        }
        const selection=snapshotStudioImportSelection(await wait(()=>importHost.selectTarget(scope,requested,actor,guard)));
        selected=selection;check();
        const converted=adaptCompletedConvertedStudioImport(manifest,files,scope.projectId,selection,null);
        const baseline=importHost.loadObservedBaseline?await wait(()=>importHost.loadObservedBaseline!(scope,converted.assetId,selection.target,{jobId:requested,actor,guard:()=>{check();}})):null;
        check();
        return {...converted,baseline:baseline===null?null:snapshotConvertedStudioImportBaseline(baseline)};
      }
      if(e.job.kind==='converted-glb')throw new AssetError('HASH','Converted import cannot use generated provenance.');
      if (isAdoptedGlbManifest(manifest)) throw new ArcaneError('STUDIO_IMPORT_UNSUPPORTED','Adopted GLB has preview-only provenance; engine import is unavailable.');
      if (!manifest.validation.studioImport) throw new AssetError('STUDIO_IMPORT_UNSUPPORTED', 'This completed job predates producer import identities; generate a new owned job.');
      const selection = snapshotStudioImportSelection(await wait(() => importHost.selectTarget(scope, requested, actor, guard)));
      selected = selection;
      check();
      const exports = new Map<'asset.glb' | 'collision.glb', Buffer>();
      for (const name of ['asset.glb', 'collision.glb'] as const) {
        const result = await wait(() => readers.artifact(requested, name));
        const pinned = manifest.artifacts.find(a => a.path === name && a.role === 'export');
        if (!pinned || result.contentType !== 'model/gltf-binary' || pinned.bytes !== result.bytes.length || pinned.sha256 !== sha256(result.bytes)) throw new AssetError('HASH', 'Import exports changed since the pinned manifest.');
        exports.set(name, result.bytes);
        if (includePayload) payloadFiles.set(name === 'asset.glb' ? 'render-export' : 'collision-export', Buffer.from(result.bytes));
      }
      // Validate producer IDs BEFORE looking up previous mappings.
      const generated = adaptCompletedStudioImport(manifest, exports, scope.projectId, selection, null);
      const baseline = importHost.loadObservedBaseline ? await wait(() => importHost.loadObservedBaseline!(scope,generated.assetId,selection.target,{jobId:requested,actor,guard:()=>{check();}})) : null;
      check();
      const isGeneratedBaseline=(value:StudioImportBaseline|null):value is GeneratedStudioImportBaselineV1|null=>value===null||value.manifest.schemaVersion===1;
      if(!isGeneratedBaseline(baseline))throw new AssetError('STUDIO_IMPORT_BASELINE','Generated import requires an observed generated baseline.');
      return { ...generated, baseline };
    } });
    try {
      // The returned review outlives this preparation's target capture and deadline.
      // reviewImport independently retains exact native actor/job/service checks.
      if(includePayload)review=await work.run(() => reviewImport(requested,actor,undefined,()=>{}));
      else if(e.job.kind==='converted-glb')convertedSource=await work.run(()=>readModelReview(requested,
        {projectId:originalScope.projectId,conversation:originalScope.conversation},()=>{guard();assertStudioImportJobScope(projectPath,importHost.workAssociations,actor,requested);}));
      const admission = await wait(() => authority.admit(requested));
      check();
      const prepared = authority.prepare(admission);
      const payload = includePayload ? decodeStudioImportPayload(prepared, payloadFiles) : null;
      const transfer = payload ? createStudioImportTransfer(prepared, payload) : null;
      check();
      if (attempt && !importHost.recordPrepared) throw new ArcaneError('STUDIO_IMPORT_UNAVAILABLE', 'Preparation attempt persistence is required.');
      if (importHost.recordPrepared) await wait(() => importHost.recordPrepared!(originalScope, requested, prepared, actor, guard, attempt),true);
      check();
      if (includePayload) {
        if (!payload || !transfer || !review) throw new ArcaneError('STUDIO_IMPORT_PAYLOAD', 'Owned import payload was not prepared.');
        review.assertCurrent();return Object.freeze({ prepared, payload, transfer,review });
      }
      return prepared;
    } finally {
      authority.close();
      payloadFiles.clear();
      try { if (importHost.releaseTarget) synchronousAdmissionResult(importHost.releaseTarget(originalScope, requested)); }
      finally { studioImportActive = false; }
    }
    } finally { work.finish('closed'); }
  }

  return {
    outputRoot: root,
    projectPath,
    async probe(operation: OperationOptions = {}): Promise<AssetProbe> {
      ensureOpen();
      if (active.size || probeActive || adoption || resolution || admitting || retentionOperation) throw new AssetError('BUSY', 'An asset operation or retained-history change is already running.');
      const controller = new AbortController();
      probeActive = controller;
      const abort = () => controller.abort();
      operation.signal?.addEventListener('abort', abort, { once: true });
      if (operation.signal?.aborted) abort();
      try { return await pipeline.probe({ ...operation, signal: controller.signal }); }
      finally { operation.signal?.removeEventListener('abort', abort); probeActive = null; }
    },
    jobs(): AssetJobRecord[] { return snapshot(); },
    lookupJobs,
    rebuildHistory:(signal?:AbortSignal)=>maintainHistory('rebuild',signal),
    confirmHistory:(signal?:AbortSignal)=>maintainHistory('confirm',signal),
    async historyStatus(){
      return retainedRead([],async()=>{
      ensureOpen();const scan=await archives.scan();ensureOpen();
      return{degraded:scan.degraded||unavailableHistory.size>0,reasons:[...scan.reasons],active:scan.active.length,
        archived:scan.archived.length,unclassified:scan.unclassified.length,unavailable:unavailableHistory.size};

      });
    },
    /** Human host operation only. Restoring history never starts a worker or imports an artifact. */
    async restoreHistory(jobId:unknown,signal?:AbortSignal):Promise<{jobId:string;swappedOut:string|null;activeAfter:number}>{
      ensureOpen();const requested=id(jobId);
      if(retentionOperation||admitting||resolution||active.size||probeActive||adoption||artifactReadActive||studioImportActive)throw new AssetError('BUSY','Wait for the current asset operation before restoring history.');
      const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
      const guard=()=>{ensureOpen();if(controller.signal.aborted)throw new ArcaneError('CANCELLED','History restoration was cancelled before its ledger write.');};
      const run=async()=>{
        await flushed();guard();archiveScan=await archives.scan();guard();
        if(archiveScan.degraded||unavailableHistory.size||unclassifiedHistory.size)throw new ArcaneError('HISTORY_INTEGRITY','Retained history needs inspection before restoration.');
        if(!archives.isArchived(requested))throw new ArcaneError('JOB_STATE','Choose an archived job to restore.');
        const restored=await loadEntry(requested);guard();let swapJobId:string|undefined;
        if(entries.size>=LIMIT){
          for(const job of ordered().toReversed()){
            const facts=await retentionFacts(job.jobId);guard();
            if(await archives.eligible(job.jobId,facts)){swapJobId=job.jobId;break;}guard();
          }
          if(!swapJobId)throw new ArcaneError('HISTORY_LIMIT','No retained job can be swapped while active work or pending imports pin history.');
          const job=entries.get(swapJobId)!.job;
          await atomicAssetJson(job.directory,'observed-events.json',JSON.stringify({schemaVersion:1,jobId:swapJobId,events:job.events})+'\n');guard();
        }
        const result=await archives.restore({jobId:requested,activeCount:entries.size,...(swapJobId?{swapJobId}:{}),facts:retentionFacts,guard});
        // The ledger committed. Synchronize the advisory view even after cancellation or host close.
        if(result.swappedOut)entries.delete(result.swappedOut);
        delete restored.job.retention;entries.set(requested,restored);persist();
        try{await flushed();}catch{throw new ArcaneError('ASSET_ARCHIVE_UNCERTAIN','The restoration was saved, but its refreshed view could not be confirmed. Inspect recorded history before another change.');}return result;
      };
      const task=run();retentionOperation={controller,task};
      try{return await task;}finally{signal?.removeEventListener('abort',abort);if(retentionOperation?.task===task)retentionOperation=null;}
    },
    async historyPage(options:{limit?:number;after?:string}={}):Promise<AssetJobPage>{
      return retainedRead([],async()=>{
      ensureOpen();if(Object.keys(options).some(key=>key!=='limit'&&key!=='after'))throw new ArcaneError('INPUT','Unexpected history option.');
      const limit=options.limit??32;if(!Number.isSafeInteger(limit)||limit<1||limit>64)throw new ArcaneError('INPUT','History limit must be 1..64.');
      archiveScan=await archives.scan();ensureOpen();
      unclassifiedHistory.clear();
      const catalog=new Map<string,{jobId:string;at:string}>();
      for(const e of entries.values())catalog.set(e.job.jobId,{jobId:e.job.jobId,at:e.job.startedAt});
      for(const e of archiveScan.archived)catalog.set(e.jobId,{jobId:e.jobId,at:e.entry.startedAt??e.entry.archivedAt});
      for(const e of unavailableHistory.values())catalog.set(e.jobId,{jobId:e.jobId,at:''});
      for(const e of archiveScan.unclassified){unclassifiedHistory.set(e.jobId,e);catalog.set(e.jobId,{jobId:e.jobId,at:''});}
      for(const e of archiveScan.active)if(!catalog.has(e.jobId)){unclassifiedHistory.set(e.jobId,e);catalog.set(e.jobId,{jobId:e.jobId,at:''});}
      const all=[...catalog.values()].sort((a,b)=>b.at.localeCompare(a.at)||b.jobId.localeCompare(a.jobId));
      const after=options.after===undefined?-1:all.findIndex(e=>e.jobId===id(options.after));
      if(options.after!==undefined&&after<0)throw new ArcaneError('NOT_FOUND','Unknown history cursor.');
      const page:AssetJobPage={schemaVersion:1,jobs:[],total:all.length,nextCursor:null,byteLimit:HISTORY_PAGE_BYTES};
      let consumed=0;
      for(const item of all.slice(after+1,after+1+limit)){
        const loaded=await lookupJobs([item.jobId]);ensureOpen();
        const candidate:AssetJobPage={...page,jobs:[...page.jobs,...loaded.jobs],
          ...((page.unavailable?.length??0)+loaded.unavailable.length?{unavailable:[...(page.unavailable??[]),...loaded.unavailable]}:{}),
          nextCursor:item.jobId};
        if(Buffer.byteLength(JSON.stringify(candidate))>HISTORY_PAGE_BYTES){
          if(!consumed)throw new ArcaneError('HISTORY_LIMIT','One retained history record exceeds the response bound.');break;
        }
        page.jobs=candidate.jobs;if(candidate.unavailable)page.unavailable=candidate.unavailable;consumed++;
      }
      if(after+1+consumed<all.length)page.nextCursor=all[after+consumed]!.jobId;
      return page;

      });
    },
    jobPage(options: { limit?: number; after?: string } = {}): AssetJobPage {
      ensureOpen();
      if (Object.keys(options).some(k => k !== 'limit' && k !== 'after')) throw new ArcaneError('INPUT', 'Unexpected history option.');
      const limit = options.limit ?? 32;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) throw new ArcaneError('INPUT', 'History limit must be 1..64.');
      const all = ordered(), after = options.after === undefined ? -1 : all.findIndex(job => job.jobId === id(options.after));
      if (options.after !== undefined && after < 0) throw new ArcaneError('NOT_FOUND', 'Unknown history cursor.');
      const page: AssetJobPage = { schemaVersion: 1, jobs: [], total: all.length, nextCursor: null, byteLimit: HISTORY_PAGE_BYTES };
      // Reserve wrapper/cursor space. Bound bytes, including complete recipes and observed events.
      let bytes = 256;
      for (const job of all.slice(after + 1, after + 1 + limit)) {
        const size = Buffer.byteLength(JSON.stringify(job)) + 1;
        if (bytes + size > HISTORY_PAGE_BYTES) {
          if (!page.jobs.length) throw new ArcaneError('HISTORY_LIMIT', 'One history record exceeds the response bound; inspect its retained journal.');
          break;
        }
        page.jobs.push(structuredClone(job)); bytes += size;
      }
      if (after + 1 + page.jobs.length < all.length) page.nextCursor = page.jobs.at(-1)!.jobId;
      if (Buffer.byteLength(JSON.stringify(page)) > HISTORY_PAGE_BYTES) throw new ArcaneError('HISTORY_LIMIT', 'History response exceeds its byte bound.');
      return page;
    },
    /** Native-only ordinary-file adoption. Actor/project authority is private;
     * request JSON carries only a name and project-relative .glb path. */
    adoptProjectGlb(input: unknown, actor: NativeAssetActor, admission: AssetStartAdmission): Promise<GeneratedOrAdoptedAssetJobRecord> {
      ensureOpen();
      const source = parseAdoptGlbInput(input), associations = importHost?.workAssociations,work=admission?.work;
      if(!work)throw new ArcaneError('ADMISSION_WORK','Adoption requires the original native work lifetime.');
      assertNativeAssetWorkLease(work);
      if(admission.signal!==work.signal)throw new ArcaneError('ADMISSION_WORK','Adoption requires the original native work signal.');
      assertNativeAssetActor(actor,'mutate');
      if(work.signal!==nativeAssetOperationSignal(actor))throw new ArcaneError('ADMISSION_WORK','Adoption work must belong to the original native operation.');
      const original = nativeAssetActorScope(actor);
      if (!(associations instanceof ConversationWorkStore) || associations.projectPath !== projectPath
        || original.projectPath !== projectPath || original.projectId !== associations.projectId
        || typeof admission?.beforeCreate !== 'function' || typeof admission.created !== 'function') throw new ArcaneError('ASSET_ADOPT_SCOPE','Exact native project/store admission is required.');
      const conversation=snapshotAdoptedGlbConversation(original.conversation);
      if (adoption || probeActive || active.size || resolution || admitting || retentionOperation) throw new AssetError('BUSY','An asset operation or retained-history change is already running.');
      const end = Date.now() + ADOPTED_GLB_LIMITS.deadlineMs;
      let scopeFailed=false;
      const guard = () => {
        try{
          ensureOpen(); assertNativeAssetActor(actor,'mutate');
          if (Date.now() >= end || !isDeepStrictEqual(nativeAssetActorScope(actor),original)
            || associations.projectPath !== projectPath || associations.projectId !== original.projectId) throw new ArcaneError('ASSET_ADOPT_SCOPE','Original adoption scope expired or changed.');
          associations.list(original.conversation,'asset-job',{limit:1});
        }catch(error){scopeFailed=true;throw error;}
      };
      const wait = async <T>(p:Promise<T>):Promise<T> => {const value=await p;guard();return value;};
      const run = async ():Promise<GeneratedOrAdoptedAssetJobRecord> => {
        let job:GeneratedOrAdoptedAssetJobRecord|null=null;
        let allocationAttempted=false,creationConfirmed=false;
        try {
          await wait(flushed());
          await ensureHistoryRoom(guard);
          guard();
          // Actual bytes + all preview geometry/image budgets are checked BEFORE
          // creating/copying anything into managed storage. No source execution.
          const owned=await readOwnedProjectGlb(projectPath,root,source,guard);guard();
          if(admission.beforeCreate()!==undefined) throw new ArcaneError('ASSET_ADOPT_ADMISSION','Synchronous void admission required.');
          guard();
          const jobId=randomUUID(),directory=join(root,source.name+'-'+jobId),staging=join(root,'.adopting-'+jobId),now=new Date().toISOString();
          const request:AdoptedGlbRequest={schemaVersion:1,template:'adopted-glb',...source,sourceSha256:sha256(owned.bytes),sourceBytes:owned.bytes.length};
          const initial:GeneratedOrAdoptedAssetJobRecord={schemaVersion:1,jobId,directory,manifestPath:null,request,state:'running',stage:'adopting',startedAt:now,updatedAt:now,events:[],manifestAvailable:false,error:null};
          // Publish a discoverable job only AFTER its first fsynced journal.
          // A crash before publication leaves owned staging evidence, not a
          // matching journal-less directory that prevents all history reopening.
          guard();allocationAttempted=true;await wait(mkdir(staging));
          await wait(atomicAssetJson(staging,'job.json',JSON.stringify(initial)+'\n'));
          guard();await rename(staging,directory);
          job=initial;
          entries.set(jobId,{directory,job});
          // Publication FACT: bind the original conversation once even if the
          // actor retired while rename yielded. Never rebind an unknown ACK.
          if(admission.created(jobId)!==undefined) throw new ArcaneError('ASSET_ADOPT_ADMISSION','Synchronous void creation witness required.');
          creationConfirmed=true;
          guard();await wait(noLinks(directory));
          const requestBytes=Buffer.from(JSON.stringify(request)+'\n');
          guard();await wait(writeFile(artifactPath(directory,'asset.glb'),owned.bytes,{flag:'wx'}));
          guard();await wait(writeFile(artifactPath(directory,'request.json'),requestBytes,{flag:'wx'}));
          const manifest:AdoptedGlbManifest={schemaVersion:1,jobId,createdAt:now,request,
            provenance:{kind:'native-project-glb',projectId:original.projectId,conversation,sourceSha256:sha256(owned.bytes),sourceBytes:owned.bytes.length},
            validation:{kind:'glb-preview-preflight',metadata:owned.metadata,imageDecode:'not-run',engineVerification:'pending'},
            engineImport:{status:'unavailable',reason:'adopted-origin-requires-safe-conversion'},
            artifacts:[{path:'asset.glb',role:'export',bytes:owned.bytes.length,sha256:sha256(owned.bytes)},
              {path:'request.json',role:'request',bytes:requestBytes.length,sha256:sha256(requestBytes)}],
            limitations:['Adopted project bytes, not bundled Blender worker output; producer/ownership rights are not inferred from GLB metadata.',
              'Preview preflight only; no Python execution, image pixel decode, native render, Studio import, upload or engine acceptance.',
              'Engine import unavailable until a safe owned conversion supplies actual producer/source mapping evidence.']};
          guard();await wait(writeFile(artifactPath(directory,'manifest.json'),JSON.stringify(manifest)+'\n',{flag:'wx'}));
          await wait(validateAdoptedGlbManifest(directory,manifest));
          job.state='succeeded';job.stage='complete';job.manifestAvailable=true;job.manifestPath=join(directory,'manifest.json');
          job.finishedAt=new Date().toISOString();job.updatedAt=job.finishedAt;
          guard();await atomicAssetJson(directory,'job.json',JSON.stringify(job)+'\n');
          // Persist completion FACT even if continuation retires while COMMIT
          // returns. No new operation or original source mutation follows.
          persist();await flushed();return structuredClone(job);
        } catch(error) {
          if(!job){if(allocationAttempted)work.finish('unresolved');throw error;}
          // A known failed job may close after its exact attribution and failed
          // journal commit. Unknown publication/ownership/commit remains held.
          // These are file-operation facts, never worker or engine proof.
          if(!scopeFailed)try{guard();}catch{/* Record the original failure under the same retained job. */}
          job.state='failed';job.stage='complete';job.manifestAvailable=false;job.manifestPath=null;
          job.finishedAt=new Date().toISOString();job.updatedAt=job.finishedAt;
          job.error={code:'ASSET_ADOPT_INCOMPLETE',message:'Managed adoption is incomplete or acknowledgement unknown; inspect this original job without replay.'};
          try{
            await atomicAssetJson(job.directory,'job.json',JSON.stringify(job)+'\n');
            persist();await flushed();
          }catch(failure){work.finish('unresolved');throw failure;}
          if(!creationConfirmed||scopeFailed)work.finish('unresolved');
          return structuredClone(job);
        }
      };
      const task=work.run(run);adoption=task;
      return task.finally(()=>{if(adoption===task) adoption=null;});
    },
    /** Native-only conversion of an exact already managed adopted parent. Public
     * input never supplies bytes, paths, hashes, identity or a fidelity policy. */
    async convertProjectGlb(input: unknown, actor: NativeAssetActor, admission: AssetStartAdmission): Promise<ConvertedAssetJobRecord> {
      ensureOpen();
      const requested = parseConvertGlbInput(input), work = admission?.work, associations = importHost?.workAssociations;
      if (!work || admission.signal !== work.signal || typeof admission.beforeCreate !== 'function' || typeof admission.created !== 'function') throw new ArcaneError('ADMISSION_WORK','Conversion requires the original native work lifetime.');
      assertNativeAssetWorkLease(work);assertNativeAssetActor(actor,'mutate');
      const original = nativeAssetActorScope(actor);
      if (!(associations instanceof ConversationWorkStore) || associations.projectPath !== projectPath ||
          original.projectPath !== projectPath || original.projectId !== associations.projectId) throw new ArcaneError('ASSET_CONVERT_SCOPE','Exact native project/store admission is required.');
      const parentBinding = associations.captureBinding('asset-job',requested.parentJobId);
      if (!parentBinding || parentBinding.binding.projectId !== original.projectId ||
          !isDeepStrictEqual(parentBinding.binding.conversation,original.conversation)) throw new ArcaneError('ASSET_CONVERT_SCOPE','The managed parent is not bound to the original conversation.');
      if (admitting || resolution || retentionOperation || probeActive || adoption || active.size >= MAX_CONCURRENT_ASSET_JOBS) throw new AssetError('BUSY','An asset operation or retained-history change is already running.');
      const releaseParent = archives.pin([requested.parentJobId]);
      let transferred = false;
      admitting = true;
      const end = Date.now()+ARTIFACT_DOWNLOAD_TIMEOUT_MS;
      const guard = () => {
        ensureOpen();assertNativeAssetActor(actor,'mutate');parentBinding.assertCurrent();
        if (work.signal.aborted) throw new ArcaneError('CANCELLED','Conversion admission was stopped.');
        if (Date.now() >= end || !isDeepStrictEqual(nativeAssetActorScope(actor),original) ||
            associations.projectPath !== projectPath || associations.projectId !== original.projectId) throw new ArcaneError('ASSET_CONVERT_SCOPE','Original conversion admission expired or changed.');
      };
      const wait = async <T>(task: Promise<T>): Promise<T> => {const value=await task;guard();return value;};
      try {
        await wait(flushed());
        const fence = await wait(fenced());
        if (fence.blocked) throw new ArcaneError('RECONCILIATION','An interrupted asset job still needs a confirmed worker status check.');
        await ensureHistoryRoom(guard);guard();
        const parent = await wait(loadEntry(requested.parentJobId));
        if (parent.job.kind === 'converted-glb' || parent.job.state !== 'succeeded' || !parent.job.manifestAvailable || active.has(requested.parentJobId) ||
            !isAdoptedGlbRequest(parent.job.request)) throw new ArcaneError('ASSET_CONVERT_PARENT','Conversion requires a verified succeeded adopted managed parent.');
        const manifestPath = artifactPath(parent.directory,'manifest.json'), sourcePath = artifactPath(parent.directory,'asset.glb');
        const manifestBefore = await wait(lstat(manifestPath)), sourceBefore = await wait(lstat(sourcePath));
        const parentManifest = await wait(readRegularFile(manifestPath,GLB_CONVERSION_LIMITS.jsonBytes));
        const adopted = parseAdoptedGlbManifest(parseConvertedGlbJson(parentManifest));guard();
        if (adopted.jobId !== requested.parentJobId || !isDeepStrictEqual(adopted.request,parent.job.request) ||
            adopted.provenance.projectId !== original.projectId || !isDeepStrictEqual(adopted.provenance.conversation,original.conversation)) throw new ArcaneError('ASSET_CONVERT_SCOPE','Managed parent provenance differs from its exact binding.');
        await wait(validateAdoptedGlbManifest(parent.directory,adopted));
        const sourceGlb = await wait(readRegularFile(sourcePath,GLB_CONVERSION_LIMITS.sourceBytes));
        if (sourceGlb.length !== adopted.provenance.sourceBytes || sha256(sourceGlb) !== adopted.provenance.sourceSha256) throw new AssetError('HASH','Managed parent source changed during conversion admission.');
        await wait(unchangedFile(manifestPath,manifestBefore));await wait(unchangedFile(sourcePath,sourceBefore));
        if (fence.witnesses.length && !await wait(witnessUnchanged(fence.witnesses))) throw new ArcaneError('RECONCILIATION','An interrupted job changed during conversion admission.');
        guard();
        if (probeActive || adoption || active.size >= MAX_CONCURRENT_ASSET_JOBS) throw new AssetError('BUSY','Blender operation capacity is already reserved.');
        synchronousAdmissionResult(admission.beforeCreate());guard();
        const now = new Date().toISOString();
        let handle!: ReturnType<AssetPipeline['startConversion']>, job!: ConvertedAssetJobRecord;
        const operation = { ...(options.jobDeadlineMs ? { deadlineMs: options.jobDeadlineMs } : {}), signal:work.signal,
          onEvent(event:AssetJobEvent):void {
            const entry=entries.get(event.jobId);if(!entry||closed)return;
            entry.job.stage=event.stage;entry.job.updatedAt=event.at;
            entry.job.events.push(event);entry.job.events=entry.job.events.slice(-64);persist();
          } };
        const supervise = ():Promise<void> => {
          handle=pipeline.startConversion({sourceGlb,parentManifest,parentManifestSha256:sha256(parentManifest),
            name:requested.name,collision:requested.collision,renderResolution:requested.renderResolution,renderSamples:requested.renderSamples},operation);
          job={schemaVersion:1,jobId:handle.id,directory:handle.directory,kind:'converted-glb',form:'new-pending',creation:handle.creation,request:null,
            state:'running',stage:'starting',startedAt:now,updatedAt:now,events:[],manifestAvailable:false,manifestPath:null,error:null};
          entries.set(handle.id,{directory:handle.directory,job});
          retainConversionParent(job,releaseParent);transferred=true;
          let closedResult=false;
          return handle.completion.then(async result=>{
            if(result.state==='interrupted')work.finish('unresolved');
            const saved=await readConversionJournal(handle.directory);
            if(saved.metadata.jobId!==handle.id||!saved.metadata.creation||!isDeepStrictEqual(saved.metadata.creation,handle.creation)||saved.journal.state!==result.state)
              throw new AssetError('RECOVERY','Converted completion metadata differs from the allocated job.');
            Object.assign(job,conversionRecordMetadata(saved.metadata));
            let state:AssetJobState=result.state,error=result.error,manifestPath:string|null=null;
            if(!convertedWorkersClosed(saved.journal)) {
              state='interrupted';error={code:'SUPERVISION_LOST',message:'Converted worker closure remains unverified; no replay.'};work.finish('unresolved');
            }
            if(state==='succeeded'&&result.manifestPath){
              try {await verifiedSavedManifest(handle.directory,handle.id,job);manifestPath=join(handle.directory,'manifest.json');}
              catch {state='failed';error={code:'HISTORY_INTEGRITY',message:'Completed converted artifacts or conversation lineage failed verification.'};}
            } else if(state==='succeeded') {state='failed';error={code:'HISTORY_INTEGRITY',message:'Completed conversion has no verified manifest.'};}
            const finishedAt=new Date().toISOString();
            Object.assign(job,{state,stage:state==='interrupted'?'supervision-lost':'complete',updatedAt:finishedAt,finishedAt,error,manifestPath,manifestAvailable:manifestPath!==null});
            closedResult=state!=='interrupted';
            await reportFailure(job);
          }).catch(async()=>{
            closedResult=false;work.finish('unresolved');job.state='interrupted';job.stage='supervision-lost';job.manifestAvailable=false;job.manifestPath=null;
            job.error={code:'SUPERVISION_LOST',message:'Converted supervision or retained completion is unknown; inspect the original job without replay.'};
            await reportFailure(job);
          }).finally(async()=>{
            active.delete(handle.id);if(closedResult)releaseConversionParent(handle.id);
            const saved=await persist();if(!saved.ok)work.finish('unresolved');
          });
        };
        // The real completion owns the work hold before a creation/binding ACK
        // can throw, retire the host or return to a model caller.
        const completion=work.run(supervise);
        active.set(handle.id,{handle,completion});
        let admissionFailure:ArcaneError|undefined;
        try{synchronousAdmissionResult(admission.created(handle.id));}
        catch{admissionFailure=new ArcaneError('ADMISSION_CREATED','The original conversion job was created, but its attribution acknowledgement is unknown; inspect retained history without replay.');}
        persist();
        try{await flushed();}catch(error){handle.cancel();await completion;throw admissionFailure??error;}
        if(admissionFailure)throw admissionFailure;
        return structuredClone(job);
      } finally {admitting=false;if(!transferred)releaseParent();}
    },
    async start(input: AssetInput, admission?: AssetStartAdmission): Promise<GeneratedOrAdoptedAssetJobRecord> {
      ensureOpen();
      const work = admission?.work;
      if (work) {
        assertNativeAssetWorkLease(work);
        if (admission.signal !== work.signal) throw new ArcaneError('ADMISSION_WORK','Original asset work lifetime is required.');
      }
      if (resolution || retentionOperation) throw new AssetError('BUSY', 'A worker status check or retained-history change is already running.');
      if (admitting) {
        // Preserve the durability barrier for waiting callers, then recheck closure before reporting busy.
        await flushed(); ensureOpen();
        throw new AssetError('BUSY', 'Another asset start is already running.');
      }
      // Validate and detach the original request before any await or retention write.
      const originalInput=jsonSnapshot(input) as unknown as AssetInput,request=normalizeRequest(originalInput);
      admitting = true;
      try {
        await flushed(); ensureOpen();
        if (probeActive || active.size >= MAX_CONCURRENT_ASSET_JOBS || adoption) throw new AssetError('BUSY', 'Blender generation capacity is already reserved.');
        // Coarse project fence: every interrupted job must hold a currently valid, confirmed marker (re-read now).
        const fence = await fenced();
        if (fence.blocked) throw new ArcaneError('RECONCILIATION', 'An interrupted asset job still needs a confirmed worker status check before new asset work can start.');
        ensureOpen();
        if (probeActive || active.size >= MAX_CONCURRENT_ASSET_JOBS || adoption) throw new AssetError('BUSY', 'Blender generation capacity is already reserved.');
        await ensureHistoryRoom(()=>{
          ensureOpen();if(admission?.signal?.aborted){
            // Preserve the original host's definitive authority refusal before
            // allocation rather than turning it into an unwitnessed unknown start.
            synchronousAdmissionResult(admission.beforeCreate());
            throw new ArcaneError('CANCELLED','Asset admission was cancelled.');
          }
        });
        const now = new Date().toISOString();
        const operation = { ...(options.jobDeadlineMs ? { deadlineMs: options.jobDeadlineMs } : {}),
          ...(admission?.signal ? { signal: admission.signal } : {}), onEvent: (event: AssetJobEvent) => {
          const e = entries.get(event.jobId);
          if (!e || closed) return;
          e.job.stage = event.stage; e.job.updatedAt = event.at;
          // The terminal event precedes completion; completion verifies the result before exposing it.
          if (event.state === 'running') e.job.state = event.state;
          e.job.events.push(event); e.job.events = e.job.events.slice(-64); persist();
        } };
        // Final re-read of every witnessed marker/journal. No await follows until the pipeline starts; a change
        // after this last read is the remaining non-atomic filesystem boundary (no cross-file transaction).
        if (fence.witnesses.length && !await witnessUnchanged(fence.witnesses)) {
          throw new ArcaneError('RECONCILIATION', 'An interrupted job changed while new asset work was being admitted; check its worker status again.');
        }
        ensureOpen();
        if (probeActive || active.size >= MAX_CONCURRENT_ASSET_JOBS || adoption) throw new AssetError('BUSY', 'Blender generation capacity is already reserved.');
        if (admission) synchronousAdmissionResult(admission.beforeCreate());
        let handle!: AssetJob, job!: GeneratedOrAdoptedAssetJobRecord;
        const supervise = () => {
        handle = pipeline.start(originalInput, operation);
        job = { schemaVersion: 1, jobId: handle.id, directory: handle.directory, manifestPath: null, request, state: 'running', stage: 'starting', startedAt: now, updatedAt: now, events: [], manifestAvailable: false, error: null };
        entries.set(handle.id, { directory: handle.directory, job });
        const completion = handle.completion.then(async result => {
          if (result.state === 'interrupted') work?.finish('unresolved');
          let state: AssetJobState = result.state, error = result.error;
          let manifestPath: string | null = null;
          if (result.state === 'succeeded' && result.manifestPath) {
            try {
              const manifest = await pipeline.validate(result.manifestPath);
              if (manifest.jobId !== handle.id) throw new AssetError('MANIFEST', 'Result identity does not match its job.');
              manifestPath = result.manifestPath;
            } catch { state = 'failed'; error = { code: 'HISTORY_INTEGRITY', message: 'Completed artifacts failed manifest verification.' }; }
          }
          const finishedAt = new Date().toISOString();
          Object.assign(job, { state, stage: 'complete', updatedAt: finishedAt, finishedAt, error, manifestPath, manifestAvailable: manifestPath !== null });
          await reportFailure(job);
        }).catch(async() => { work?.finish('unresolved'); job.state = 'interrupted'; job.stage = 'supervision-lost'; job.error = { code: 'SUPERVISION_LOST', message: 'Asset supervision ended unexpectedly; inspect the job directory.' };
          await reportFailure(job);
        })
          .finally(async() => { active.delete(handle.id);const saved=await persist();if(!saved.ok)work?.finish('unresolved'); });
        return completion;
        };
        // Register the real pipeline and its listener-cleanup completion BEFORE
        // allocation; a returned HTTP/admission result does not release it.
        const completion = work ? work.run(supervise) : supervise();
        active.set(handle.id, { handle, completion });
        // Install supervision before host bookkeeping can throw. A created job is
        // never a safe pre-creation rejection, even if its witness callback fails.
        let admissionFailure: ArcaneError | undefined;
        try { if (admission) synchronousAdmissionResult(admission.created(handle.id)); }
        catch { admissionFailure = new ArcaneError('ADMISSION_CREATED', 'Asset job ' + handle.id + ' was created, but its admission callback failed; inspect retained job history.'); }
        persist();
        try { await flushed(); } catch (e) { handle.cancel(); await completion; throw admissionFailure ?? e; }
        if (admissionFailure) throw admissionFailure;
        return structuredClone(job);
      } finally { admitting = false; }
    },
    /** Human-owned worker-status check for ONE interrupted job (trusted host/route only, never an agent/model).
     * Only exact digest-bound evidence that every recorded worker is gone/closed releases this job's share of
     * the coarse fence. The job stays interrupted with no artifacts, success, import or replay.
     * Commit boundary: an abort before the marker write starts cancels with nothing changed; once the write
     * starts it is joined, then re-read from disk, and its actual outcome is reported. */
    async resolveInterrupted(jobId: unknown, signal?: AbortSignal): Promise<WorkerResolutionOutcome> {
      ensureOpen();
      const e = await loadEntry(jobId), requested = e.job.jobId;
      if (resolution || admitting || probeActive || active.size || adoption || artifactReadActive || studioImportActive || retentionOperation) {
        throw new AssetError('BUSY', 'Another asset operation or worker status check is running; try again when it finishes.');
      }
      if (isAdoptedGlbRequest(e.job.request)) throw new ArcaneError('NOT_APPLICABLE', 'Adopted GLB jobs never start a worker and do not pause new asset work.');
      if (e.job.state !== 'interrupted') throw new ArcaneError('JOB_STATE', 'Only an interrupted asset job needs a worker status check.');
      const controller = new AbortController(), abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
      const cancelled = () => new ArcaneError('CANCELLED', 'The worker status check was cancelled before anything was saved. Nothing changed.');
      const uncertain = (message: string) => {
        uncertainResolutions.add(requested); e.job.resolution = { status: 'uncertain' };
        return new ArcaneError('RESOLUTION_UNCERTAIN', message);
      };
      const run = async (): Promise<WorkerResolutionOutcome> => {
        await flushed(); // A latched history failure refuses before anything is written.
        if (controller.signal.aborted || closed) throw cancelled();
        const stored = await storedResolution(e.directory, requested);
        // A retired or aborted request must not confirm a previously uncertain marker through the fast path.
        if (controller.signal.aborted || closed) throw cancelled();
        if (stored.status === 'resolved') { // Idempotent; also confirms a previously uncertain commit from disk.
          uncertainResolutions.delete(requested); showResolution(e.job, stored);
          return { jobId: requested, status: 'resolved', resolvedAt: stored.record.assessedAt, evidence: stored.record.basis.map(b => b.evidence), alreadyResolved: true };
        }
        if (controller.signal.aborted) throw cancelled();
        let journal: Buffer;
        try { journal = await readRegularFile(artifactPath(e.directory, 'job.json'), JOB_JOURNAL_BYTES); }
        catch { return { jobId: requested, status: 'refused', reason: 'journal-malformed' }; }
        const assessment = await assessJobForResolution({ jobId: requested, journal, signal: controller.signal,
          ...(options.workerQueryHost ? { host: options.workerQueryHost } : {}) });
        if (assessment.status === 'refused') { if (assessment.reason === 'cancelled') throw cancelled(); return { jobId: requested, status: 'refused', reason: assessment.reason }; }
        const record = assessment.record;
        // Freshness: the journal must still be the exact bytes assessed.
        let current: Buffer | null = null;
        try { current = await readRegularFile(artifactPath(e.directory, 'job.json'), JOB_JOURNAL_BYTES); } catch { /* stale below */ }
        if (!current || sha256(current) !== record.journalSha256) return { jobId: requested, status: 'refused', reason: 'resolution-stale' };
        if (controller.signal.aborted || closed) throw cancelled();
        // COMMIT BOUNDARY. From here an abort is joined, never reported as a clean cancellation.
        let writeError: unknown = null;
        try { await writeMarker(e.directory, RESOLUTION_MARKER, JSON.stringify(record) + '\n'); } catch (error) { writeError = error; }
        const after = await storedResolution(e.directory, requested);
        const committed = after.status === 'resolved' && after.record.journalSha256 === record.journalSha256 &&
          after.record.workersSha256 === record.workersSha256 && after.record.assessedAt === record.assessedAt;
        if (writeError !== null) {
          if (writeError instanceof AtomicJsonFailure && writeError.phase !== 'replace' && after.status === 'absent') {
            throw new ArcaneError('PERSISTENCE', 'The worker status check could not be saved. Nothing changed; new asset work stays paused.');
          }
          throw uncertain('Saving the worker status check may not have completed. New asset work stays paused; check the worker status again.');
        }
        if (!committed) throw uncertain('The saved worker status check could not be confirmed. New asset work stays paused; check the worker status again.');
        uncertainResolutions.delete(requested); showResolution(e.job, after);
        persist();
        try { await flushed(); }
        catch { throw uncertain('The worker status check was saved, but asset history could not be saved. New asset work stays paused; inspect retained history.'); }
        return { jobId: requested, status: 'resolved', resolvedAt: record.assessedAt, evidence: record.basis.map(b => b.evidence), alreadyResolved: false };
      };
      const task = run();
      resolution = { controller, task };
      try { return await task; }
      finally { signal?.removeEventListener('abort', abort); if (resolution?.task === task) resolution = null; }
    },
    async cancel(jobId: unknown): Promise<AssetJobRecord> {
      ensureOpen();
      const e = await loadEntry(jobId), running = active.get(e.job.jobId);
      if (running) { running.handle.cancel(); await running.completion; }
      // A completed worker may already have left active while its history write is pending.
      await flushed();
      return structuredClone(e.job);
    },
    async manifest(jobId: unknown): Promise<AssetPreviewManifest> {
      return retainedRead([id(jobId)],async()=>{
      ensureOpen();
      const e = await loadEntry(jobId);
      if (!e.job.manifestAvailable || e.job.state !== 'succeeded') throw new ArcaneError('JOB_STATE', 'A verified completed manifest is unavailable for this job.');
      // Inspection may expose a changed generated manifest; artifact and import
      // admission still compare its full request before authorizing any use.
      return verifiedSavedManifest(e.directory,e.job.jobId,e.job,false);

      });
    },
    /** Read-only canonical subject from current verified files and exact durable attribution. */
    async modelReviewSubject(jobId:unknown,scope:AssetReviewScope,guard:()=>void=()=>{}):Promise<AssetReviewSubject> {
      return retainedRead([id(jobId)],async()=>(await readModelReview(jobId,scope,guard)).subject);
    },
    /** Rebuild a process-local source/decision guard; durable JSON references alone never authorize effects. */
    async reviewImport(jobId:unknown,actor:NativeAssetActor,expected?:AssetReviewReference,guard:()=>void=()=>{}):Promise<AssetReviewImportGuard> {
      return retainedRead([id(jobId)],()=>reviewImport(jobId,actor,expected,guard));
    },
    /** Model witness only. The parent queue must separately enforce its CURRENT
     * opaque native actor, exact target/continuity and original stage binding. */
    assertReviewedImport(jobId:unknown,inputScope:AssetReviewScope,expected:AssetReviewReference):void {
      ensureOpen();const requested=id(jobId),scope=snapshotAssetReviewScope(inputScope),reference=snapshotAssetReviewReference(expected);
      if(!reviewAssociations||reviewAssociations.projectPath!==projectPath||reviewAssociations.projectId!==scope.projectId)assetReviewFailure('SCOPE');
      const owned=reviewedImports.get(assetReviewCanonical({...scope,jobId:requested}));
      if(!owned||assetReviewCanonical(owned.reference)!==assetReviewCanonical(reference)||!options.modelReview)assetReviewFailure('REQUIRED');
      owned.assertSourceCurrent();const result=options.modelReview.assertReference(owned.subject,reference);if(result!==undefined)assetReviewFailure('CONFIGURATION');
    },
    /** Production host preparation. Only a completed owned job UUID and the SAME
     * native actor enter here; files, target and baseline come from host evidence.
     * Host context reads and pending metadata persistence do not upload, import,
     * verify an engine result or authorize a Studio write. */
    async prepareStudioImport(jobId: unknown, actor: NativeAssetActor): Promise<PreparedStudioImport> {
      return retainedRead([id(jobId)],()=>prepareImport(jobId, actor, this, false));
    },
    /** Trusted host-only staging from the SAME completed-job admission and owned
     * bytes. The returned data does not authorize uploads or editor writes and
     * is never exposed by the native HTTP/MCP preparation endpoint. */
    async prepareStudioImportPayload(jobId: unknown, actor: NativeAssetActor, attempt?: StudioImportPreparationAttempt): Promise<PreparedStudioImportPayload> {
      return retainedRead([id(jobId)],()=>prepareImport(jobId, actor, this, true, attempt));
    },
    async preview(jobId: unknown, path: unknown): Promise<Buffer> {
      return retainedRead([id(jobId)],async()=>{
      ensureOpen();
      if (path !== 'preview-hero.png' && path !== 'preview-side.png' && path !== 'preview-structure.png') throw new ArcaneError('INPUT', 'Only fixed manifest previews may be read.');
      const e = await loadEntry(jobId);
      const manifest = await this.manifest(e.job.jobId);
      const artifact = manifest.artifacts.find(a => a.path === path && a.role === 'preview');
      if (!artifact) throw new ArcaneError('NOT_FOUND', 'Preview is not approved by the manifest.');
      const bytes = await readRegularFile(artifactPath(e.directory, path), 8 * 1024 * 1024);
      if (bytes.length !== artifact.bytes || sha256(bytes) !== artifact.sha256) throw new AssetError('HASH', 'Preview changed since manifest verification.');
      if (isAdoptedGlbManifest(manifest)) throw new ArcaneError('NOT_FOUND','Adopted GLB uses the existing interactive viewer; no rendered PNG was produced.');
      inspectPng(bytes, manifest.request.renderResolution);
      return bytes;

      });
    },
    async artifact(jobId: unknown, path: unknown): Promise<{ bytes: Buffer; filename: string; contentType: string }> {
      return retainedRead([id(jobId)],async()=>{
      ensureOpen();
      const download = typeof path === 'string' ? DOWNLOADS.get(path) : undefined;
      if (!download) throw new ArcaneError('INPUT', 'Only the fixed GLB, FBX, completed Blender scene, request.json and audit.json artifacts may be downloaded.');
      const e = await loadEntry(jobId);
      if (!e.job.manifestAvailable || e.job.state !== 'succeeded') throw new ArcaneError('JOB_STATE', 'Artifact downloads require a verified completed job.');
      if (artifactReadActive) throw new AssetError('BUSY', 'An artifact download is already being verified.');
      artifactReadActive = true;
      const end = Date.now() + ARTIFACT_DOWNLOAD_TIMEOUT_MS;
      const checkDeadline = () => {
        if (Date.now() >= end) throw new ArcaneError('ARTIFACT_TIMEOUT', 'Artifact verification exceeded its 30 second deadline.');
        ensureOpen();
      };
      try {
        const target = artifactPath(e.directory, path), manifestPath = join(e.directory, 'manifest.json');
        let before: Stats;
        try { await noLinks(target); before = await lstat(target); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            const manifest = await this.manifest(e.job.jobId);
            checkDeadline();
            if (!manifest.artifacts.some(a => a.path === path)) throw new ArcaneError('NOT_FOUND', 'Artifact is not approved by the completed manifest.');
          }
          throw error;
        }
        if (!before.isFile() || before.nlink !== 1 || before.size < 1) throw new AssetError('ARTIFACT', 'Download must be a nonempty regular file without links.');
        if (before.size > ARTIFACT_DOWNLOAD_BYTES) throw new ArcaneError('ARTIFACT_LIMIT', 'Artifact download exceeds 64 MiB.');
        await regularFile(target, ARTIFACT_DOWNLOAD_BYTES);
        await regularFile(manifestPath, 4 * 1024 * 1024);
        const manifestBefore = await lstat(manifestPath), manifestBytes = await readRegularFile(manifestPath, 4 * 1024 * 1024);
        checkDeadline();
        // Reuse the complete job/manifest proof; this is structural validation only, never deep Blender validation.
        const manifest = await this.manifest(e.job.jobId);
        checkDeadline();
        if (JSON.stringify(JSON.parse(manifestBytes.toString('utf8'))) !== JSON.stringify(manifest) || JSON.stringify(manifest.request) !== JSON.stringify(e.job.request)) {
          throw new AssetError('MANIFEST', 'Download manifest differs from the pinned manifest or indexed request.');
        }
        const artifact = manifest.artifacts.find(a => a.path === path);
        if (!artifact) throw new ArcaneError('NOT_FOUND', 'Artifact is not approved by the completed manifest.');
        if (artifact.role !== download.role) throw new AssetError('MANIFEST', 'Artifact role is not approved for download.');
        if (artifact.bytes > ARTIFACT_DOWNLOAD_BYTES) throw new ArcaneError('ARTIFACT_LIMIT', 'Artifact download exceeds 64 MiB.');
        await unchangedFile(target, before);
        const bytes = await readRegularFile(target, ARTIFACT_DOWNLOAD_BYTES);
        if (bytes.length !== artifact.bytes || sha256(bytes) !== artifact.sha256) throw new AssetError('HASH', 'Download bytes changed since manifest verification.');
        const manifestAfter = await readRegularFile(manifestPath, 4 * 1024 * 1024);
        if (sha256(manifestAfter) !== sha256(manifestBytes)) throw new AssetError('MANIFEST', 'Manifest changed during download verification.');
        await unchangedFile(manifestPath, manifestBefore);
        await unchangedFile(target, before);
        checkDeadline();
        return { bytes, filename: String(path).replace(/[^a-zA-Z0-9._-]/g, '_'), contentType: download.contentType };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new AssetError('ARTIFACT', 'Completed artifact or manifest disappeared during download verification.');
        throw error;
      } finally { artifactReadActive = false; }

      });
    },
    close(): Promise<void> {
      if (closing) return closing;
      closed = true;reviewedImports.clear();lifetime.abort(); probeActive?.abort(); resolution?.controller.abort();retentionOperation?.controller.abort();
      closing = (async () => {
        for (const run of active.values()) run.handle.cancel();
        if (adoption) await adoption.catch(() => {});
        // Abort the worker-status check and join any marker write it already started.
        while (resolution) await resolution.task.catch(() => {});
        while(retentionOperation)await retentionOperation.task.catch(()=>{});
        try {
          await Promise.all([...active.values()].map(run => run.completion));
          while (probeActive) await new Promise<void>(r => setTimeout(r, 10));
          while(admitting)await new Promise<void>(r=>setTimeout(r,10));
          while(historyReads.size)await Promise.allSettled([...historyReads]);
          await flushed();
        } finally { archives.close();outputOwners.delete(ownerKey); }
      })();
      return closing;
    }
  };
}
export type AssetService = Awaited<ReturnType<typeof createAssetService>>;
