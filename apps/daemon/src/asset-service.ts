import { JOB_JOURNAL_BYTES, CUSTOM_REQUEST_BYTES } from '../../../packages/asset-pipeline/src/recipe.js';
import { randomUUID } from 'node:crypto';
import { opendir, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { ArcaneError } from '../../../packages/protocol/src/providers.js';
import { AssetError, createAssetPipeline, normalizeRequest } from '../../../packages/asset-pipeline/src/index.js';
import type { AssetInput, AssetJob, AssetJobEvent, AssetJobState, AssetManifest, AssetProbe, AssetRequest, OperationOptions } from '../../../packages/asset-pipeline/src/index.js';
import { artifactPath, noLinks, prepareOutputRoot, readRegularFile } from '../../../packages/asset-pipeline/src/paths.js';
import { inspectPng, readJson, record, sha256 } from '../../../packages/asset-pipeline/src/validation.js';

export interface AssetServiceOptions {
  /** Trusted repository installation root, independent of the selected project. */
  cwd: string;
  projectPath?: string;
  outputRoot?: string;
  workerRoot?: string;
  blenderExecutable?: string;
  pythonExecutable?: string;
  jobDeadlineMs?: number;
}
export interface AssetJobRecord {
  schemaVersion: 1;
  jobId: string;
  directory: string;
  manifestPath: string | null;
  finishedAt?: string;
  request: AssetRequest;
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
  let pending: Promise<void> = Promise.resolve(), persistenceError = false, closed = false;
  const snapshot = () => structuredClone([...entries.values()].map(e => e.job).sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.jobId.localeCompare(a.jobId)));
  const persist = () => {
    const jobs = [...entries.values()].map(({job}) => ({ ...job, request: { ...job.request, recipe: undefined } }));
    pending = pending.then(async () => {
      const temporary = join(root, 'index-' + randomUUID() + '.tmp'), target = join(root, 'index.json');
      await noLinks(root);
      try { await noLinks(target); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      await writeFile(temporary, JSON.stringify({ schemaVersion: 1, jobs }, null, 2) + '\n', { flag: 'wx' });
      await rename(temporary, target);
    }).catch(() => { persistenceError = true; });
  };
  const flushed = async () => { await pending; if (persistenceError) throw new ArcaneError('PERSISTENCE', 'Asset history could not be saved; inspect retained job journals.'); };
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

  return {
    outputRoot: root,
    projectPath: resolve(options.projectPath ?? options.cwd),
    async probe(operation: OperationOptions = {}): Promise<AssetProbe> {
      ensureOpen();
      if (active.size || probeActive) throw new AssetError('BUSY', 'A Blender operation is already running.');
      const controller = new AbortController();
      probeActive = controller;
      const abort = () => controller.abort();
      operation.signal?.addEventListener('abort', abort, { once: true });
      if (operation.signal?.aborted) abort();
      try { return await pipeline.probe({ ...operation, signal: controller.signal }); }
      finally { operation.signal?.removeEventListener('abort', abort); probeActive = null; }
    },
    jobs(): AssetJobRecord[] { return snapshot(); },
    async start(input: AssetInput): Promise<AssetJobRecord> {
      ensureOpen(); await flushed(); ensureOpen();
      if (probeActive || active.size) throw new AssetError('BUSY', 'A Blender operation is already running.');
      if ([...entries.values()].some(e => e.job.state === 'interrupted')) throw new ArcaneError('RECONCILIATION', 'Lost worker supervision requires inspection before starting work in this output root. Use a fresh trusted output root after confirming the old worker has stopped.');
      if (entries.size >= LIMIT) throw new ArcaneError('HISTORY_LIMIT', 'Asset history is full; use a fresh trusted output root.');
      const request = normalizeRequest(input);
      const now = new Date().toISOString();
      const handle = pipeline.start(input, { ...(options.jobDeadlineMs ? { deadlineMs: options.jobDeadlineMs } : {}), onEvent: event => {
        const e = entries.get(event.jobId);
        if (!e || closed) return;
        e.job.stage = event.stage; e.job.updatedAt = event.at;
        // The terminal event precedes completion; completion verifies the result before exposing it.
        if (event.state === 'running') e.job.state = event.state;
        e.job.events.push(event); e.job.events = e.job.events.slice(-64); persist();
      } });
      const job: AssetJobRecord = { schemaVersion: 1, jobId: handle.id, directory: handle.directory, manifestPath: null, request, state: 'running', stage: 'starting', startedAt: now, updatedAt: now, events: [], manifestAvailable: false, error: null };
      entries.set(handle.id, { directory: handle.directory, job });
      persist();
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
      try { await flushed(); } catch (e) { handle.cancel(); await completion; throw e; }
      return structuredClone(job);
    },
    async cancel(jobId: unknown): Promise<AssetJobRecord> {
      ensureOpen();
      const e = entry(jobId), running = active.get(e.job.jobId);
      if (running) { running.handle.cancel(); await running.completion; await flushed(); }
      return structuredClone(e.job);
    },
    async manifest(jobId: unknown): Promise<AssetManifest> {
      ensureOpen();
      const e = entry(jobId);
      if (!e.job.manifestAvailable || e.job.state !== 'succeeded') throw new ArcaneError('JOB_STATE', 'A verified completed manifest is unavailable for this job.');
      const manifest = await pipeline.validate(join(e.directory, 'manifest.json'));
      if (manifest.jobId !== e.job.jobId || manifest.request.name !== e.job.request.name) throw new AssetError('MANIFEST', 'Manifest identity does not match the indexed job.');
      return manifest;
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
      inspectPng(bytes, manifest.request.renderResolution);
      return bytes;
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true; probeActive?.abort();
      for (const run of active.values()) run.handle.cancel();
      await Promise.all([...active.values()].map(run => run.completion));
      while (probeActive) await new Promise<void>(r => setTimeout(r, 10));
      try { await flushed(); } finally { outputOwners.delete(ownerKey); }
    }
  };
}
export type AssetService = Awaited<ReturnType<typeof createAssetService>>;
