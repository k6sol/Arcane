import { JOB_JOURNAL_BYTES, CUSTOM_REQUEST_BYTES } from '../../../packages/asset-pipeline/src/recipe.js';
import type { Stats } from 'node:fs';
import { lstat, opendir, mkdir, writeFile, rename } from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {parseAdoptGlbInput, parseAdoptedGlbRequest, isAdoptedGlbRequest, isAdoptedGlbManifest, readOwnedProjectGlb, validateAdoptedGlbManifest, ADOPTED_GLB_LIMITS, type AdoptedGlbRequest, type AdoptedGlbManifest} from '../../../packages/asset-pipeline/src/adopted-glb.js';
export type AssetPreviewManifest = AssetManifest | AdoptedGlbManifest;
import { atomicAssetJson, AtomicJsonFailure } from '../../../packages/asset-pipeline/src/atomic-json.js';
import { isAbsolute, join, resolve } from 'node:path';
import { ArcaneError } from '../../../packages/protocol/src/providers.js';
import { AssetError, createAssetPipeline, normalizeRequest } from '../../../packages/asset-pipeline/src/index.js';
import type { AssetInput, AssetJob, AssetJobEvent, AssetJobState, AssetManifest, AssetProbe, AssetRequest, OperationOptions } from '../../../packages/asset-pipeline/src/index.js';
import { artifactPath, noLinks, prepareOutputRoot, readRegularFile, regularFile } from '../../../packages/asset-pipeline/src/paths.js';
import { inspectPng, readJson, record, sha256 } from '../../../packages/asset-pipeline/src/validation.js';
import { createStudioImportManifestAuthority, snapshotStudioImportSelection, STUDIO_IMPORT_LIMITS, type PreparedStudioImport } from '../../../packages/asset-pipeline/src/studio-import-manifest.js';
import { adaptCompletedStudioImport, assertStudioImportJobScope, type StudioImportHostOptions, type StudioImportPreparationAttempt } from './asset-import-adapter.js';
import { assertNativeAssetActor, nativeAssetActorScope, type NativeAssetActor } from './native-asset-authority.js';
import { ConversationWorkStore } from '../../../packages/storage/src/conversation-work-store.js';
import { decodeStudioImportPayload, type StudioImportPayload } from '../../../packages/asset-pipeline/src/studio-import-payload.js';
import { createStudioImportTransfer, type StudioImportTransfer } from '../../../packages/asset-pipeline/src/studio-import-transfer.js';


export interface PreparedStudioImportPayload {
  readonly prepared: PreparedStudioImport;
  readonly payload: StudioImportPayload;
  readonly transfer: StudioImportTransfer;
}
interface StudioImportReaders {
  manifest(jobId: unknown): Promise<AssetPreviewManifest>;
  artifact(jobId: unknown, path: unknown): Promise<{ bytes: Buffer; filename: string; contentType: string }>;
}

export interface AssetServiceOptions {
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
}
/** Trusted host-code admission only; never an AssetInput or HTTP JSON field. */
export interface AssetStartAdmission {
  beforeCreate(): void;
  created(jobId: string): void;
}
function synchronousAdmissionResult(result: unknown): void {
  if (result !== null && (typeof result === 'object' || typeof result === 'function') && typeof (result as { then?: unknown }).then === 'function') {
    throw new ArcaneError('ADMISSION_ASYNC', 'Asset start admission callbacks must be synchronous.');
  }
}
export interface AssetJobRecord {
  schemaVersion: 1;
  jobId: string;
  directory: string;
  manifestPath: string | null;
  finishedAt?: string;
  request: AssetRequest | AdoptedGlbRequest;
  state: AssetJobState;
  stage: string;
  startedAt: string;
  updatedAt: string;
  events: AssetJobEvent[];
  manifestAvailable: boolean;
  error: { code: string; message: string } | null;
}
const ID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const LIMIT = 256;
export const HISTORY_PAGE_BYTES = 512 * 1024;
export const ARTIFACT_DOWNLOAD_BYTES = 64 * 1024 * 1024;
export const ARTIFACT_DOWNLOAD_TIMEOUT_MS = 30000;
const DOWNLOADS = new Map([
  ['asset.glb', { role: 'export', contentType: 'model/gltf-binary' }],
  ['collision.glb', { role: 'export', contentType: 'model/gltf-binary' }],
  ['asset-lod1.glb', { role: 'export', contentType: 'model/gltf-binary' }],
  ['asset.fbx', { role: 'export', contentType: 'application/octet-stream' }],
  ['asset.blend', { role: 'scene', contentType: 'application/octet-stream' }]
]);
async function unchangedFile(path: string, before: Stats): Promise<void> {
  await noLinks(path);
  const after = await lstat(path);
  if (!after.isFile() || after.nlink !== 1 || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
    throw new AssetError('ARTIFACT', 'Artifact or manifest changed during download verification.');
  }
}
export interface AssetJobPage { schemaVersion: 1; jobs: AssetJobRecord[]; total: number; nextCursor: string | null; byteLimit: number }
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
  if (importHost && (!(importHost.workAssociations instanceof ConversationWorkStore) || importHost.workAssociations.projectPath !== projectPath ||
      typeof importHost.selectTarget !== 'function' || (importHost.loadObservedBaseline !== undefined && typeof importHost.loadObservedBaseline !== 'function'))) {
    throw new ArcaneError('STUDIO_IMPORT_SCOPE', 'Studio import host configuration must borrow the exact project store and host callbacks.');
  }
  const root = await prepareOutputRoot(options.cwd, options.outputRoot ?? join(options.cwd, 'runtime', 'assets'));
  const ownerKey = process.platform === 'win32' ? root.toLowerCase() : root;
  if (outputOwners.has(ownerKey)) throw new AssetError('BUSY', 'An asset service already owns this output root in this process.');
  outputOwners.add(ownerKey);
  const pipeline = createAssetPipeline({ workspaceRoot: options.cwd, outputRoot: root, workerRoot: options.workerRoot ?? join(options.cwd, 'workers', 'blender'),
    ...(options.blenderExecutable ? { blenderExecutable: options.blenderExecutable } : {}),
    ...(options.pythonExecutable ? { pythonExecutable: options.pythonExecutable } : {}) });
  const entries = new Map<string, { directory: string; job: AssetJobRecord }>();
  const active = new Map<string, { handle: AssetJob; completion: Promise<void> }>();
  let probeActive: AbortController | null = null;
  let adoption: Promise<AssetJobRecord> | null = null;
  let artifactReadActive = false;
  let studioImportActive = false;
  let pending: Promise<void> = Promise.resolve(), persistenceError = false, closed = false;
  let scheduledIndex: string | null = null;
  let closing: Promise<void> | null = null;
  let persistenceIssue: {phase:'path-check'|'write'|'replace';code:string}|null=null;
  const ordered = () => [...entries.values()].map(e => e.job).sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.jobId.localeCompare(a.jobId));
  const snapshot = () => structuredClone(ordered());
  const persist = () => {
    // The advisory index stores only observed events. Full requests remain in journals/manifests.
    if (persistenceError) return;
    const jobs = [...entries.values()].map(({ job }) => ({ jobId: job.jobId, events: structuredClone(job.events) }));
    const text = JSON.stringify({ schemaVersion: 1, jobs }, null, 2) + '\n';
    // Completion changes job state, not the event-only index. Avoid replacing identical bytes.
    if (text === scheduledIndex) return;
    scheduledIndex = text;
    pending = pending.then(async () => {
      if (persistenceError) return;
      await atomicAssetJson(root, 'index.json', text);
    }).catch((error: unknown) => {
      persistenceError = true;
      if (!persistenceIssue) persistenceIssue = error instanceof AtomicJsonFailure
        ? { phase: error.phase, code: error.code } : { phase: 'path-check', code: 'UNKNOWN' };
      // First fatal failure latches. Keep original journals and the uncommitted snapshot.
    });
  };
  const flushed = async () => {
    // Events may enqueue a new snapshot while the previous tail is being awaited.
    for (;;) { const tail = pending; await tail; if (tail === pending) break; }
    if (persistenceError) throw new ArcaneError('PERSISTENCE', 'Asset history could not be saved' +
      (persistenceIssue ? ' (' + persistenceIssue.phase + '/' + persistenceIssue.code + ')' : '') + '; inspect retained job journals.');
  };
  const ensureOpen = () => { if (closed) throw new ArcaneError('CLOSED', 'Asset service is closed.'); };
  const entry = (jobId: unknown) => {
    const e = entries.get(id(jobId));
    if (!e) throw new ArcaneError('NOT_FOUND', 'Unknown asset job.');
    return e;
  };
  try {
    // Ignore index contents as path authority. Scan only direct, fixed-name job directories.
    const directories = await opendir(root);
    let inspected = 0;
    for await (const d of directories) {
      if (++inspected > 1024) throw new ArcaneError('HISTORY_LIMIT', 'Asset output root has too many entries to scan safely.');
      const match = /^([a-z][a-z0-9-]{0,47})-([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/.exec(d.name);
      if (!match) continue;
      if (!d.isDirectory() || d.isSymbolicLink()) throw new AssetError('OUTPUT_PATH', 'Job directories must be regular directories without links.');
      if (entries.size >= LIMIT) throw new ArcaneError('HISTORY_LIMIT', 'Asset history exceeds 256 jobs; use a fresh trusted output root.');
      const directory = join(root, d.name);
      await noLinks(directory);
      const journal = record(await readJson(join(directory, 'job.json'), JOB_JOURNAL_BYTES), 'job journal');
      if (id(journal.jobId) !== match[2]) throw new AssetError('RECOVERY', 'Job directory and journal identities disagree.');
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
        entries.set(match[2]!,{directory,job:{schemaVersion:1,jobId:match[2]!,directory,request,state,stage:'complete',startedAt,
          updatedAt:timestamp(journal.updatedAt,startedAt),...(typeof journal.finishedAt==='string'?{finishedAt:journal.finishedAt}:{}),
          manifestPath:state==='succeeded'?join(directory,'manifest.json'):null,manifestAvailable:state==='succeeded',events:[],error}});
        continue;
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
          const e = record(recovered.result.error, 'job error');
          if (typeof e.code !== 'string' || e.code.length > 64 || typeof e.message !== 'string' || e.message.length > 1024) throw new AssetError('RECOVERY', 'Invalid job error.');
          error = { code: e.code, message: e.message };
        }
      } catch (e) {
        if (e instanceof AssetError && e.code === 'BUSY') throw e;
        state = 'failed'; error = { code: 'HISTORY_INTEGRITY', message: 'Retained job evidence failed verification; inspect local artifacts.' };
      }
      const now = new Date().toISOString();
      entries.set(match[2]!, { directory, job: { schemaVersion: 1, jobId: match[2]!, directory, manifestPath: state === 'succeeded' ? join(directory, 'manifest.json') : null, ...(typeof journal.finishedAt === 'string' ? { finishedAt: journal.finishedAt } : {}), request, state, stage: state === 'interrupted' ? 'supervision-lost' : 'complete',
        startedAt: timestamp(journal.startedAt, timestamp(journal.finishedAt, now)), updatedAt: timestamp(journal.finishedAt, now), events: [],
        manifestAvailable: state === 'succeeded', error } });
    }
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
        }
      }
    } catch { /* Index is rebuildable; verified journals remain the authority. */ }
    persist(); await flushed();
  } catch (e) { outputOwners.delete(ownerKey); throw e; }

  function prepareImport(jobId: unknown, actor: NativeAssetActor, readers: StudioImportReaders, includePayload: false): Promise<PreparedStudioImport>;
  function prepareImport(jobId: unknown, actor: NativeAssetActor, readers: StudioImportReaders, includePayload: true, attempt?: StudioImportPreparationAttempt): Promise<PreparedStudioImportPayload>;
  async function prepareImport(jobId: unknown, actor: NativeAssetActor, readers: StudioImportReaders, includePayload: boolean, attempt?: StudioImportPreparationAttempt): Promise<PreparedStudioImport | PreparedStudioImportPayload> {
    ensureOpen();
    if (!importHost) throw new ArcaneError('STUDIO_IMPORT_UNAVAILABLE', 'Studio import host target/receipt selection has not been configured.');
    const requested = id(jobId);
    const end = Date.now() + ARTIFACT_DOWNLOAD_TIMEOUT_MS;
    let selected: import('../../../packages/asset-pipeline/src/studio-import-manifest.js').StudioImportSelection | undefined;
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
    const check = () => { guard(); return assertStudioImportJobScope(projectPath, importHost.workAssociations, actor, requested); };
    const originalScope = check();
    const e = entry(requested);
    if (isAdoptedGlbRequest(e.job.request)) throw new ArcaneError('STUDIO_IMPORT_UNSUPPORTED','Adopted GLB origin requires safe conversion and observed source mapping; engine import is unavailable.');
    if (e.job.state !== 'succeeded' || !e.job.manifestAvailable || active.has(requested)) throw new ArcaneError('JOB_STATE', 'Import preparation requires a verified completed job.');
    if (studioImportActive) throw new AssetError('BUSY', 'A Studio import preparation is already running.');
    studioImportActive = true;
    // Bounds waits as well as reads; late host callbacks cannot expose a result.
    const wait = async <T>(promise: T | Promise<T>): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([Promise.resolve(promise), new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new ArcaneError('STUDIO_IMPORT_TIMEOUT', 'Studio import preparation exceeded its 30 second deadline.')), Math.max(1, end - Date.now()));
        })]);
        check(); return result;
      } finally { if (timer) clearTimeout(timer); }
    };
    const payloadFiles = new Map<string, Uint8Array>();
    const authority = createStudioImportManifestAuthority({ loadGeneratedFiles: async value => {
      if (value !== requested) throw new ArcaneError('STUDIO_IMPORT_SCOPE', 'Import job identity changed.');
      const scope = check();
      // Tighten import size BEFORE the service's existing complete manifest proof.
      for (const name of ['asset.glb', 'collision.glb'] as const) await wait(regularFile(artifactPath(e.directory, name), STUDIO_IMPORT_LIMITS.fileBytes));
      const manifest = await wait(readers.manifest(requested));
      if (isAdoptedGlbManifest(manifest)) throw new ArcaneError('STUDIO_IMPORT_UNSUPPORTED','Adopted GLB has preview-only provenance; engine import is unavailable.');
      if (!manifest.validation.studioImport) throw new AssetError('STUDIO_IMPORT_UNSUPPORTED', 'This completed job predates producer import identities; generate a new owned job.');
      const selection = snapshotStudioImportSelection(await wait(importHost.selectTarget(scope, requested, actor, guard)));
      selected = selection;
      check();
      const exports = new Map<'asset.glb' | 'collision.glb', Buffer>();
      for (const name of ['asset.glb', 'collision.glb'] as const) {
        const result = await wait(readers.artifact(requested, name));
        const pinned = manifest.artifacts.find(a => a.path === name && a.role === 'export');
        if (!pinned || result.contentType !== 'model/gltf-binary' || pinned.bytes !== result.bytes.length || pinned.sha256 !== sha256(result.bytes)) throw new AssetError('HASH', 'Import exports changed since the pinned manifest.');
        exports.set(name, result.bytes);
        if (includePayload) payloadFiles.set(name === 'asset.glb' ? 'render-export' : 'collision-export', Buffer.from(result.bytes));
      }
      // Validate producer IDs BEFORE looking up previous mappings.
      const generated = adaptCompletedStudioImport(manifest, exports, scope.projectId, selection, null);
      const baseline = importHost.loadObservedBaseline ? await wait(importHost.loadObservedBaseline(scope, generated.assetId, selection.target)) : null;
      check();
      return { ...generated, baseline };
    } });
    try {
      const admission = await wait(authority.admit(requested));
      check();
      const prepared = authority.prepare(admission);
      const payload = includePayload ? decodeStudioImportPayload(prepared, payloadFiles) : null;
      const transfer = payload ? createStudioImportTransfer(prepared, payload) : null;
      check();
      if (attempt && !importHost.recordPrepared) throw new ArcaneError('STUDIO_IMPORT_UNAVAILABLE', 'Preparation attempt persistence is required.');
      if (importHost.recordPrepared) await wait(importHost.recordPrepared(originalScope, requested, prepared, actor, guard, attempt));
      check();
      if (includePayload) {
        if (!payload || !transfer) throw new ArcaneError('STUDIO_IMPORT_PAYLOAD', 'Owned import payload was not prepared.');
        return Object.freeze({ prepared, payload, transfer });
      }
      return prepared;
    } finally {
      authority.close();
      payloadFiles.clear();
      try { if (importHost.releaseTarget) synchronousAdmissionResult(importHost.releaseTarget(originalScope, requested)); }
      finally { studioImportActive = false; }
    }
  }

  return {
    outputRoot: root,
    projectPath,
    async probe(operation: OperationOptions = {}): Promise<AssetProbe> {
      ensureOpen();
      if (active.size || probeActive || adoption) throw new AssetError('BUSY', 'A Blender operation is already running.');
      const controller = new AbortController();
      probeActive = controller;
      const abort = () => controller.abort();
      operation.signal?.addEventListener('abort', abort, { once: true });
      if (operation.signal?.aborted) abort();
      try { return await pipeline.probe({ ...operation, signal: controller.signal }); }
      finally { operation.signal?.removeEventListener('abort', abort); probeActive = null; }
    },
    jobs(): AssetJobRecord[] { return snapshot(); },
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
    adoptProjectGlb(input: unknown, actor: NativeAssetActor, admission: AssetStartAdmission): Promise<AssetJobRecord> {
      ensureOpen();
      const source = parseAdoptGlbInput(input), associations = importHost?.workAssociations;
      assertNativeAssetActor(actor,'mutate');
      const original = nativeAssetActorScope(actor);
      if (!(associations instanceof ConversationWorkStore) || associations.projectPath !== projectPath
        || original.projectPath !== projectPath || original.projectId !== associations.projectId || original.conversation.provider !== 'codex'
        || typeof admission?.beforeCreate !== 'function' || typeof admission.created !== 'function') throw new ArcaneError('ASSET_ADOPT_SCOPE','Exact native project/store admission is required.');
      if (adoption || probeActive || active.size) throw new AssetError('BUSY','An asset operation is already running.');
      const end = Date.now() + ADOPTED_GLB_LIMITS.deadlineMs;
      const guard = () => {
        ensureOpen(); assertNativeAssetActor(actor,'mutate');
        if (Date.now() >= end || !isDeepStrictEqual(nativeAssetActorScope(actor),original)
          || associations.projectPath !== projectPath || associations.projectId !== original.projectId) throw new ArcaneError('ASSET_ADOPT_SCOPE','Original adoption scope expired or changed.');
        associations.list(original.conversation,'asset-job',{limit:1});
      };
      const wait = async <T>(p:Promise<T>):Promise<T> => {const value=await p;guard();return value;};
      const run = async ():Promise<AssetJobRecord> => {
        let job:AssetJobRecord|null=null;
        try {
          await wait(flushed());
          if(entries.size>=LIMIT) throw new ArcaneError('HISTORY_LIMIT','Asset history is full.');
          guard();
          // Actual bytes + all preview geometry/image budgets are checked BEFORE
          // creating/copying anything into managed storage. No source execution.
          const owned=await readOwnedProjectGlb(projectPath,root,source,guard);guard();
          if(admission.beforeCreate()!==undefined) throw new ArcaneError('ASSET_ADOPT_ADMISSION','Synchronous void admission required.');
          guard();
          const jobId=randomUUID(),directory=join(root,source.name+'-'+jobId),staging=join(root,'.adopting-'+jobId),now=new Date().toISOString();
          const request:AdoptedGlbRequest={schemaVersion:1,template:'adopted-glb',...source,sourceSha256:sha256(owned.bytes),sourceBytes:owned.bytes.length};
          const initial:AssetJobRecord={schemaVersion:1,jobId,directory,manifestPath:null,request,state:'running',stage:'adopting',startedAt:now,updatedAt:now,events:[],manifestAvailable:false,error:null};
          // Publish a discoverable job only AFTER its first fsynced journal.
          // A crash before publication leaves owned staging evidence, not a
          // matching journal-less directory that prevents all history reopening.
          guard();await wait(mkdir(staging));
          await wait(atomicAssetJson(staging,'job.json',JSON.stringify(initial)+'\n'));
          guard();await rename(staging,directory);
          job=initial;
          entries.set(jobId,{directory,job});
          // Publication FACT: bind the original conversation once even if the
          // actor retired while rename yielded. Never rebind an unknown ACK.
          if(admission.created(jobId)!==undefined) throw new ArcaneError('ASSET_ADOPT_ADMISSION','Synchronous void creation witness required.');
          guard();await wait(noLinks(directory));
          const requestBytes=Buffer.from(JSON.stringify(request)+'\n');
          guard();await wait(writeFile(artifactPath(directory,'asset.glb'),owned.bytes,{flag:'wx'}));
          guard();await wait(writeFile(artifactPath(directory,'request.json'),requestBytes,{flag:'wx'}));
          const manifest:AdoptedGlbManifest={schemaVersion:1,jobId,createdAt:now,request,
            provenance:{kind:'native-project-glb',projectId:original.projectId,conversation:{provider:'codex',threadId:original.conversation.threadId,sessionId:original.conversation.sessionId},sourceSha256:sha256(owned.bytes),sourceBytes:owned.bytes.length},
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
          if(!job) throw error;
          job.state='failed';job.stage='complete';job.manifestAvailable=false;job.manifestPath=null;
          job.finishedAt=new Date().toISOString();job.updatedAt=job.finishedAt;
          job.error={code:'ASSET_ADOPT_INCOMPLETE',message:'Managed adoption is incomplete or acknowledgement unknown; inspect this original job without replay.'};
          await atomicAssetJson(job.directory,'job.json',JSON.stringify(job)+'\n');
          persist();await flushed();return structuredClone(job);
        }
      };
      const task=run();adoption=task;
      return task.finally(()=>{if(adoption===task) adoption=null;});
    },
    async start(input: AssetInput, admission?: AssetStartAdmission): Promise<AssetJobRecord> {
      ensureOpen(); await flushed(); ensureOpen();
      if (probeActive || active.size || adoption) throw new AssetError('BUSY', 'A Blender operation is already running.');
      if ([...entries.values()].some(e => e.job.state === 'interrupted' && !isAdoptedGlbRequest(e.job.request))) throw new ArcaneError('RECONCILIATION', 'Lost worker supervision requires inspection before starting work in this output root. Use a fresh trusted output root after confirming the old worker has stopped.');
      if (entries.size >= LIMIT) throw new ArcaneError('HISTORY_LIMIT', 'Asset history is full; use a fresh trusted output root.');
      const request = normalizeRequest(input);
      const now = new Date().toISOString();
      const operation = { ...(options.jobDeadlineMs ? { deadlineMs: options.jobDeadlineMs } : {}), onEvent: (event: AssetJobEvent) => {
        const e = entries.get(event.jobId);
        if (!e || closed) return;
        e.job.stage = event.stage; e.job.updatedAt = event.at;
        // The terminal event precedes completion; completion verifies the result before exposing it.
        if (event.state === 'running') e.job.state = event.state;
        e.job.events.push(event); e.job.events = e.job.events.slice(-64); persist();
      } };
      if (admission) synchronousAdmissionResult(admission.beforeCreate());
      const handle = pipeline.start(input, operation);
      const job: AssetJobRecord = { schemaVersion: 1, jobId: handle.id, directory: handle.directory, manifestPath: null, request, state: 'running', stage: 'starting', startedAt: now, updatedAt: now, events: [], manifestAvailable: false, error: null };
      entries.set(handle.id, { directory: handle.directory, job });
      const completion = handle.completion.then(async result => {
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
      }).catch(() => { job.state = 'interrupted'; job.stage = 'supervision-lost'; job.error = { code: 'SUPERVISION_LOST', message: 'Asset supervision ended unexpectedly; inspect the job directory.' }; })
        .finally(() => { active.delete(handle.id); persist(); });
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
    },
    async cancel(jobId: unknown): Promise<AssetJobRecord> {
      ensureOpen();
      const e = entry(jobId), running = active.get(e.job.jobId);
      if (running) { running.handle.cancel(); await running.completion; }
      // A completed worker may already have left active while its history write is pending.
      await flushed();
      return structuredClone(e.job);
    },
    async manifest(jobId: unknown): Promise<AssetPreviewManifest> {
      ensureOpen();
      const e = entry(jobId);
      if (!e.job.manifestAvailable || e.job.state !== 'succeeded') throw new ArcaneError('JOB_STATE', 'A verified completed manifest is unavailable for this job.');
      const manifest = isAdoptedGlbRequest(e.job.request)
        ? await validateAdoptedGlbManifest(e.directory, await readJson(join(e.directory,'manifest.json')))
        : await pipeline.validate(join(e.directory, 'manifest.json'));
      if (manifest.jobId !== e.job.jobId || manifest.request.name !== e.job.request.name) throw new AssetError('MANIFEST', 'Manifest identity does not match the indexed job.');
      if(isAdoptedGlbManifest(manifest)){
        const binding=importHost?.workAssociations.binding('asset-job',e.job.jobId);
        if(!isDeepStrictEqual(manifest.request,e.job.request)||!binding||binding.projectId!==manifest.provenance.projectId
          ||!isDeepStrictEqual(binding.conversation,manifest.provenance.conversation)) throw new AssetError('MANIFEST','Adopted snapshot differs from its original request or durable conversation binding.');
      }
      return manifest;
    },
    /** Production host preparation. Only a completed owned job UUID and the SAME
     * native actor enter here; files, target and baseline come from host evidence.
     * Host context reads and pending metadata persistence do not upload, import,
     * verify an engine result or authorize a Studio write. */
    prepareStudioImport(jobId: unknown, actor: NativeAssetActor): Promise<PreparedStudioImport> {
      return prepareImport(jobId, actor, this, false);
    },
    /** Trusted host-only staging from the SAME completed-job admission and owned
     * bytes. The returned data does not authorize uploads or editor writes and
     * is never exposed by the native HTTP/MCP preparation endpoint. */
    prepareStudioImportPayload(jobId: unknown, actor: NativeAssetActor, attempt?: StudioImportPreparationAttempt): Promise<PreparedStudioImportPayload> {
      return prepareImport(jobId, actor, this, true, attempt);
    },
    async preview(jobId: unknown, path: unknown): Promise<Buffer> {
      ensureOpen();
      const e = entry(jobId);
      if (path !== 'preview-hero.png' && path !== 'preview-side.png') throw new ArcaneError('INPUT', 'Only the two fixed manifest previews may be read.');
      const manifest = await this.manifest(e.job.jobId);
      const artifact = manifest.artifacts.find(a => a.path === path && a.role === 'preview');
      if (!artifact) throw new ArcaneError('NOT_FOUND', 'Preview is not approved by the manifest.');
      const bytes = await readRegularFile(artifactPath(e.directory, path), 8 * 1024 * 1024);
      if (bytes.length !== artifact.bytes || sha256(bytes) !== artifact.sha256) throw new AssetError('HASH', 'Preview changed since manifest verification.');
      if (isAdoptedGlbManifest(manifest)) throw new ArcaneError('NOT_FOUND','Adopted GLB uses the existing interactive viewer; no rendered PNG was produced.');
      inspectPng(bytes, manifest.request.renderResolution);
      return bytes;
    },
    async artifact(jobId: unknown, path: unknown): Promise<{ bytes: Buffer; filename: string; contentType: string }> {
      ensureOpen();
      const e = entry(jobId), download = typeof path === 'string' ? DOWNLOADS.get(path) : undefined;
      if (!download) throw new ArcaneError('INPUT', 'Only the fixed GLB, FBX and completed Blender scene artifacts may be downloaded.');
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
    },
    close(): Promise<void> {
      if (closing) return closing;
      closed = true; probeActive?.abort();
      closing = (async () => {
        for (const run of active.values()) run.handle.cancel();
        if (adoption) await adoption.catch(() => {});
        try {
          await Promise.all([...active.values()].map(run => run.completion));
          while (probeActive) await new Promise<void>(r => setTimeout(r, 10));
          await flushed();
        } finally { outputOwners.delete(ownerKey); }
      })();
      return closing;
    }
  };
}
export type AssetService = Awaited<ReturnType<typeof createAssetService>>;
