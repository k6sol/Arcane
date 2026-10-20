import { isDeepStrictEqual as same } from 'node:util';
import { jsonSnapshot, preflightRecipe, CUSTOM_REQUEST_BYTES, JOB_JOURNAL_BYTES } from './recipe.js';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { discoverExecutables } from './discovery.js';
import { artifactPath, noLinks, prepareOutputRoot, regularFile, readRegularFile, within } from './paths.js';
import { runBounded, workerEnvironment, type CommandOptions, type CommandResult, type CommandSpec } from './process.js';
import { workerLaunchDirectory, workerFileArgument, workerDirectoryArgument } from './launch-paths.js';
import { WorkerSupervision } from './worker-journal.js';
import type { ProcessQueryHost, WorkerRole } from './worker-identity.js';
import { normalizeRequest, readJson, record, sha256, UV_WORKER_SCRIPTS, validateAudit, validateManifestFiles, workerScripts } from './validation.js';
import { MODEL_WORKER_SCRIPTS } from './model-spec.js';
import { AssetError } from './types.js';
import { atomicAssetJson, AtomicJsonFailure } from './atomic-json.js';
import { decodeAssetJobError, failureMessage, failureStage, hostFailure, workerFailure } from './failure-diagnostics.js';
import type { Artifact, AssetInput, AssetJob, AssetJobEvent, AssetJobResult, AssetManifest, AssetProbe, AssetRequest, JobOptions, OperationOptions, PipelineOptions, RuntimeEvidence } from './types.js';
export * from './types.js';
export { discoverExecutables } from './discovery.js';
export { normalizeRecipe, preflightRecipe, RECIPE_LIMITS, CUSTOM_REQUEST_BYTES } from './recipe.js';
export { normalizeRequest } from './validation.js';
export { normalizeProcedural, PROCEDURAL_KINDS, PROCEDURAL_LIMITS, PROCEDURAL_PART_MATERIALS } from './procedural.js';

// Two independent generation jobs per Node worker, including across pipeline instances.
// Maintenance operations remain exclusive. A cancelled or unresolved child still owns its slot
// until its own close is observed, even if an injected/failed runner has already returned.
export const MAX_CONCURRENT_ASSET_JOBS = 2;
interface OperationClaim {
  readonly exclusive: boolean;
  supervise(hooks?: CommandOptions['supervise']): NonNullable<CommandOptions['supervise']>;
  finish(): void;
}
const operations = new Set<OperationClaim>();
const activeDirectories = new Set<string>();
const directoryKey = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
function claim(exclusive = true, onRelease?: () => void): OperationClaim {
  if ([...operations].some(operation => operation.exclusive) || operations.size >= MAX_CONCURRENT_ASSET_JOBS || (exclusive && operations.size)) {
    throw new AssetError('BUSY', 'Blender operation capacity is already reserved in this worker.');
  }
  let finished = false, workers = 0;
  const release = () => {
    if (finished && !workers && operations.delete(operation)) onRelease?.();
  };
  const operation: OperationClaim = {
    exclusive,
    supervise(hooks) {
      let spawned = false, closed = false;
      return {
        async spawned(info) {
          if (!spawned && !closed && info.pid !== undefined) { spawned = true; workers++; }
          return hooks ? hooks.spawned(info) : 'continue';
        },
        closed() {
          if (closed) return;
          closed = true;
          try { hooks?.closed(); }
          finally { if (spawned) workers--; release(); }
        }
      };
    },
    finish() { finished = true; release(); }
  };
  operations.add(operation); return operation;
}
function deadline(options: OperationOptions, fallback: number): number {
  const ms = options.deadlineMs ?? fallback;
  if (!Number.isSafeInteger(ms) || ms < 1 || ms > 600000) throw new AssetError('INPUT', 'Deadline must be 1..600000 milliseconds.');
  return Date.now() + ms;
}
function remaining(end: number, signal?: AbortSignal): number {
  if (signal?.aborted) throw new AssetError('CANCELLED', 'Operation cancelled.');
  const ms = end - Date.now();
  if (ms < 1) throw new AssetError('DEADLINE', 'Asset operation exceeded its deadline.');
  return Math.min(ms, 600000);
}
function resultLine(stdout: string): Record<string, unknown> {
  const lines = stdout.split(/\r?\n/).filter(line => line.startsWith('ARCANE_RESULT '));
  if (lines.length !== 1) throw new AssetError('WORKER_PROTOCOL', 'Worker did not return exactly one result.');
  try { return record(JSON.parse(lines[0]!.slice(14)), 'worker result'); }
  catch { throw new AssetError('WORKER_PROTOCOL', 'Worker result is not valid JSON.'); }
}
async function atomicJson(directory: string, filename: string, value: unknown): Promise<void> {
  try { await atomicAssetJson(directory, filename, (filename === 'job.json' ? JSON.stringify(value) : JSON.stringify(value, null, 2)) + '\n'); }
  catch (error) {
    if (error instanceof AtomicJsonFailure) throw new AssetError('PERSISTENCE', error.message);
    throw error;
  }
}
const COLLECTION_FILENAMES = new Set(['asset.blend', 'blockout.blend', 'asset.glb', 'asset.fbx', 'collision.glb', 'asset-lod1.glb',
  'preview-hero.png', 'preview-side.png', 'audit.json', 'request.json', 'input.json', 'assembly.json',
  'asset_worker.py', 'audit.py', 'probe.py', 'assembly.py', 'procedural.py', 'variation.py', 'textures.py', ...MODEL_WORKER_SCRIPTS, ...UV_WORKER_SCRIPTS]);
/** Only host-selected inventory filenames may appear in collection errors. */
async function withArtifactFile<T>(name: string, action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) {
    const label = COLLECTION_FILENAMES.has(name) ? name : 'Artifact';
    if (error instanceof AssetError) {
      if (!error.message.startsWith(label + ':') && !error.message.startsWith(label + ' ')) error.message = `${label}: ${error.message}`;
      throw error;
    }
    const missing = error && typeof error === 'object' && 'code' in error && ['ENOENT', 'ENOTDIR'].includes(String(error.code));
    const failure = new AssetError('ARTIFACT', `${label}: ${missing ? 'Required artifact is missing.' : 'Artifact could not be read safely.'}`);
    Object.defineProperty(failure, 'cause', { value: error });
    throw failure;
  }
}

/** Trusted in-process boundaries, injectable for synthetic tests only (never from HTTP, MCP or a model). */
export interface PipelineInternals {
  run?: (spec: CommandSpec, options?: CommandOptions) => Promise<CommandResult>;
  discover?: typeof discoverExecutables;
  queryHost?: ProcessQueryHost;
}
const SUPERVISION_FATAL = new Set(['CANCELLED', 'DEADLINE', 'PERSISTENCE', 'SUPERVISION_UNRESOLVED', 'SUPERVISION_STATE']);
const PROBE_SCRATCH_PREFIX = 'arcane-blender-probe-';

export class AssetPipeline {
  private readonly root: string;
  private readonly outputRoot: string;
  private readonly workerRoot: string;
  private readonly run: NonNullable<PipelineInternals['run']>;
  private readonly discover: typeof discoverExecutables;
  private readonly queryHost: ProcessQueryHost | undefined;
  constructor(private readonly config: PipelineOptions, internals: PipelineInternals = {}) {
    if (!isAbsolute(config.workspaceRoot) || !isAbsolute(config.outputRoot) || (config.workerRoot !== undefined && !isAbsolute(config.workerRoot))) throw new AssetError('OUTPUT_PATH', 'Pipeline configuration requires absolute paths.');
    this.root = resolve(config.workspaceRoot); this.outputRoot = resolve(config.outputRoot);
    this.workerRoot = config.workerRoot ?? join(this.root, 'workers', 'blender');
    this.run = internals.run ?? runBounded; this.discover = internals.discover ?? discoverExecutables; this.queryHost = internals.queryHost;
  }
  /** Reserve durably, run, then record closure only from the runner's observed close. A failed reservation
   * starts nothing; a supervision failure after the run supersedes the run's own outcome. */
  private async supervisedRun(operation: OperationClaim, supervision: WorkerSupervision | undefined, role: WorkerRole, spec: CommandSpec, options: CommandOptions): Promise<CommandResult> {
    // Deep inspection has no durable job transition, but must still join each observed child close
    // before trying another executable or releasing its exclusive operation.
    const owner = supervision ?? new WorkerSupervision({ capture: false, persist: async () => undefined });
    const launch = await owner.begin(role, spec.executable);
    let result: CommandResult | undefined, failure: unknown, failed = false;
    try { result = await this.run(spec, { ...options, supervise: operation.supervise(launch.hooks) }); } catch (error) { failure = error; failed = true; }
    await launch.finish();
    if (failed) throw failure;
    return result!;
  }
  private async script(name: string): Promise<string> {
    return withArtifactFile(name, async () => {
      // variation.py is the workers/blender/variation package, copied into jobs as one flat module.
      // uv_*.py are the workers/blender/uv engine modules, copied into jobs beside procedural.py.
      // model_*.py are the workers/blender/grammar model spec compiler, copied flat for kind "spec".
      const path = name === 'variation.py' ? join(this.workerRoot, 'variation', '__init__.py') : UV_WORKER_SCRIPTS.includes(name) ? artifactPath(join(this.workerRoot, 'uv'), name)
        : MODEL_WORKER_SCRIPTS.includes(name) ? artifactPath(join(this.workerRoot, 'grammar'), name) : artifactPath(this.workerRoot, name); await regularFile(path, 256 * 1024); return realpath(path);
    });
  }
  private discoveryOptions() {
    return { ...(this.config.blenderExecutable ? { blenderExecutable: this.config.blenderExecutable } : {}),
      ...(this.config.pythonExecutable ? { pythonExecutable: this.config.pythonExecutable } : {}) };
  }
  /** With `supervision`, every attempt is reserved before spawn and one record stays free for generation. */
  private async probeIn(operation: OperationClaim, directory: string, end: number, signal?: AbortSignal, supervision?: WorkerSupervision): Promise<AssetProbe> {
    const installed = await this.discover(this.discoveryOptions());
    const evidence: AssetProbe = { observedAt: new Date().toISOString(), available: false, blender: null, python: null, attempts: [] };
    const probeScript = await this.script('probe.py');
    const bounded = (executable: string) => {
      if (!supervision || supervision.hasRoom(1)) return false;
      evidence.attempts.push({ executable, code: 'SUPERVISION_BOUND' }); return true;
    };
    for (const executable of installed.blender) {
      if (bounded(executable)) break;
      try {
        const process = await this.supervisedRun(operation, supervision, 'probe', { executable, args: ['--background', '--factory-startup', '--disable-autoexec', '--threads', '2', '--python-exit-code', '1', '--python', workerFileArgument(probeScript)], cwd: workerLaunchDirectory(executable, directory), env: workerEnvironment(directory) },
          { ...(signal ? { signal } : {}), deadlineMs: Math.min(15000, remaining(end, signal)) });
        if (process.exitCode !== 0) throw new AssetError('BLENDER_PROBE', 'Installed Blender failed its runtime probe.');
        const result = resultLine(process.stdout), capabilities = record(result.capabilities, 'Blender capabilities');
        if (typeof result.version !== 'string' || !/^\d+\.\d+/.test(result.version) || typeof result.pythonVersion !== 'string' || result.background !== true) throw new AssetError('BLENDER_PROBE', 'Invalid native runtime evidence.');
        if (['glbExport', 'glbImport', 'fbxExport', 'fbxImport', 'cycles'].some(key => capabilities[key] !== true)) throw new AssetError('BLENDER_CAPABILITY', 'Installed Blender is missing required template capabilities.');
        evidence.blender = { ...result, executable } as unknown as RuntimeEvidence; evidence.available = true; break;
      } catch (error) {
        if (error instanceof AssetError && SUPERVISION_FATAL.has(error.code)) throw error;
        evidence.attempts.push({ executable, code: error instanceof AssetError ? error.code : 'BLENDER_PROBE' });
      }
    }
    const pythonCode = 'import json,platform; print("ARCANE_RESULT "+json.dumps({"version":platform.python_version()}))';
    for (const executable of installed.python) {
      if (bounded(executable)) break;
      try {
        const process = await this.supervisedRun(operation, supervision, 'python-probe', { executable, args: ['-I', '-B', '-c', pythonCode], cwd: workerLaunchDirectory(executable, directory), env: workerEnvironment(directory) },
          { ...(signal ? { signal } : {}), deadlineMs: Math.min(5000, remaining(end, signal)) });
        if (process.exitCode !== 0) throw new AssetError('PYTHON_PROBE', 'Python runtime probe failed.');
        const result = resultLine(process.stdout);
        if (typeof result.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(result.version)) throw new AssetError('PYTHON_PROBE', 'Python did not return a runtime version.');
        evidence.python = { executable, version: result.version }; break;
      } catch (error) {
        if (error instanceof AssetError && SUPERVISION_FATAL.has(error.code)) throw error;
        evidence.attempts.push({ executable, code: error instanceof AssetError ? error.code : 'PYTHON_PROBE' });
      }
    }
    remaining(end, signal); return evidence;
  }
  /** Standalone probes run in OS-temp scratch owned by this invocation only. Reservations and observed closures
   * are tracked in memory (no identity, no persistent recovery claim). The scratch is removed only once every
   * owned worker's close was observed and it is still the exact direct child created here; otherwise it is kept. */
  async probe(options: OperationOptions = {}): Promise<AssetProbe> {
    const end = deadline(options, 30000), operation = claim();
    let temp: string | undefined, directory: string | undefined, supervision: WorkerSupervision | undefined;
    try {
      temp = await realpath(tmpdir());
      directory = await mkdtemp(join(temp, PROBE_SCRATCH_PREFIX));
      supervision = new WorkerSupervision({ capture: false, persist: async () => undefined });
      return await this.probeIn(operation, directory, end, options.signal, supervision);
    } finally {
      try {
        if (temp && directory && supervision && supervision.records.every(r => r.state === 'closed')) {
          const actual = await realpath(directory);
          if (directoryKey(dirname(actual)) === directoryKey(temp) && basename(actual).startsWith(PROBE_SCRATCH_PREFIX) && within(temp, actual)) {
            await noLinks(actual); await rm(actual, { recursive: true, force: true });
          }
        }
      } finally { operation.finish(); }
    }
  }
  start(input: AssetInput, options: JobOptions = {}): AssetJob {
    const sourceInput = jsonSnapshot(input), request = normalizeRequest(sourceInput), end = deadline(options, 180000);
    const id = randomUUID(), directory = join(this.outputRoot, request.name + '-' + id), controller = new AbortController();
    const operation = claim(false, () => activeDirectories.delete(directoryKey(directory)));
    const abort = () => controller.abort(); options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) controller.abort();
    const emit = (stage: string, state: AssetJobEvent['state'] = 'running') => {
      try { options.onEvent?.({ jobId: id, at: new Date().toISOString(), stage, state }); } catch { /* telemetry observer only */ }
    };
    activeDirectories.add(directoryKey(directory));
    const completion = this.generate(id, directory, request, sourceInput, end, controller.signal, emit, operation).finally(() => {
      options.signal?.removeEventListener('abort', abort); operation.finish();
    });
    return { id, directory, completion, cancel: abort };
  }
  private async generate(id: string, directory: string, request: AssetRequest, sourceInput: unknown, end: number, signal: AbortSignal, emit: (stage: string, state?: AssetJobEvent['state']) => void, operation: OperationClaim): Promise<AssetJobResult> {
    let created = false;
    let stage = 'prepare-output', workerOutput: CommandResult | undefined;
    const progress = (next: string) => { stage = failureStage(next); emit(stage); };
    const startedAt = new Date().toISOString();
    const base = { jobId: id, directory, manifestPath: null, error: null };
    // Every job.json rewrite carries the supervisor's truthful worker records (reservation before each spawn).
    const supervision = new WorkerSupervision({ ...(this.queryHost ? { host: this.queryHost } : {}),
      persist: workers => atomicJson(directory, 'job.json', { schemaVersion: 1, ...base, state: 'running', request, startedAt, workers }) });
    try {
      await prepareOutputRoot(this.root, this.outputRoot); await mkdir(directory); created = true; await noLinks(directory);
      await mkdir(join(directory, '.worker')); const environmentDirectory = join(directory, '.worker');
      await atomicJson(directory, 'job.json', { schemaVersion: 1, ...base, state: 'running', request, startedAt, workers: supervision.records });
      await writeFile(artifactPath(directory, 'input.json'), JSON.stringify(sourceInput) + '\n', { flag: 'wx' });
      remaining(end, signal); progress('probe');
      const evidence = await this.probeIn(operation, environmentDirectory, end, signal, supervision);
      if (!evidence.blender || !evidence.available) throw new AssetError('BLENDER_UNAVAILABLE', 'No installed Blender passed the required runtime probe.');
      for (const name of workerScripts(request)) await withArtifactFile(name, async () => copyFile(await this.script(name), artifactPath(directory, name), 1));
      const requestText = JSON.stringify(request, null, request.recipe ? undefined : 2) + '\n';
      await writeFile(artifactPath(directory, 'request.json'), requestText, { flag: 'wx' });
      const recipeArguments = request.recipe ? ['--recipe-sha256', sha256(Buffer.from(JSON.stringify(request.recipe))), '--estimated-triangles', JSON.stringify(preflightRecipe(request.recipe, request.triangleBudget).estimatedTriangles)] : [];
      progress('generate');
      const process = await this.supervisedRun(operation, supervision, 'generate', { executable: evidence.blender.executable,
        args: ['--background', '--factory-startup', '--disable-autoexec', '--threads', '2', '--python-exit-code', '1', '--python', workerFileArgument(artifactPath(directory, 'asset_worker.py')), '--', '--mode', 'generate', '--directory', workerDirectoryArgument(directory), '--request-sha256', sha256(Buffer.from(requestText)), ...recipeArguments],
        cwd: workerLaunchDirectory(evidence.blender.executable, directory), env: workerEnvironment(environmentDirectory) }, { signal, deadlineMs: remaining(end, signal), onLine: line => {
          if (!line.startsWith('ARCANE_EVENT ')) return;
          try { const e = JSON.parse(line.slice(13)) as { stage?: unknown }; if (typeof e.stage === 'string' && failureStage(e.stage) === e.stage) progress(e.stage); } catch { /* progress line is optional */ }
        } });
      workerOutput = process;
      if (process.exitCode !== 0) throw workerFailure(process, stage);
      if (resultLine(process.stdout).audit !== 'audit.json') throw new AssetError('WORKER_PROTOCOL', 'Worker did not return its audit artifact.');
      progress('host-validation'); remaining(end, signal);
      const audit = await withArtifactFile('audit.json', async () => validateAudit(await readJson(artifactPath(directory, 'audit.json')), request));
      const artifacts: Artifact[] = [];
      const files: [string, Artifact['role']][] = [['asset.blend', 'scene'], ['blockout.blend', 'checkpoint'], ['asset.glb', 'export'], ['asset.fbx', 'export'], ['collision.glb', 'export'], ['preview-hero.png', 'preview'], ['preview-side.png', 'preview'], ['audit.json', 'audit'], ['request.json', 'request'], ['asset_worker.py', 'worker'], ['audit.py', 'worker'], ['probe.py', 'worker']];
      files.push(['input.json', 'request']);
      if (request.recipe) files.push(['assembly.py', 'worker'], ['assembly.json', 'audit']);
      if (request.recipe?.materials.some(material => material.surface) || request.procedural?.finish === 'natural') files.push(['textures.py', 'worker']);
      if (request.procedural) files.push(['procedural.py', 'worker']);
      if (request.procedural?.finish === 'natural' || request.procedural?.kind === 'spec') files.push(...UV_WORKER_SCRIPTS.map(name => [name, 'worker'] as [string, Artifact['role']]));
      if (request.procedural?.variant) files.push(['variation.py', 'worker']);
      if (request.procedural?.kind === 'spec') files.push(...MODEL_WORKER_SCRIPTS.map(name => [name, 'worker'] as [string, Artifact['role']]));
      if (audit.totals.lod1Triangles) files.push(['asset-lod1.glb', 'export']);
      for (const [name, role] of files) {
        remaining(end, signal);
        artifacts.push(await withArtifactFile(name, async () => {
          const path = artifactPath(directory, name), size = await regularFile(path, 128 * 1024 * 1024);
          return { path: name, role, bytes: size, sha256: sha256(await readRegularFile(path, 128 * 1024 * 1024)) };
        }));
      }
      const manifest: AssetManifest = { schemaVersion: 2, jobId: id, createdAt: new Date().toISOString(), request, runtime: evidence.blender,
        templateSha256: sha256(Buffer.from(workerScripts(request).map(name => artifacts.find(a => a.path === name)!.sha256).join('\n'))),
        sourceRequestSha256: artifacts.find(a => a.path === 'input.json')!.sha256, ...(audit.assembly ? { assembly: audit.assembly } : {}),
        coordinateSystem: { units: 'meters', sceneUp: 'Z', glbUp: 'Y', fbxUp: 'Y', pivot: 'floor', robloxScaleVerified: false },
        validation: audit, artifacts, limitations: [...(request.procedural ? [request.procedural.finish === 'natural'
          ? 'Original procedural geometry with generated opaque UV0 PBR images; photographic fidelity and in-engine appearance require visual review.'
          : 'Procedural mesh from a bundled, parameter-only Blender generator; the selected flat or legacy finish has no image textures.'] : []), 'Supervised native process; not a sandbox for arbitrary Python.', 'Artistic fidelity, UV overlap/texel density and inter-object intersections require review.', 'No Roblox import, scale/collision verification, upload, install or publication has run.'] };
      await validateManifestFiles(directory, manifest); remaining(end, signal);
      await atomicJson(directory, 'manifest.json', manifest);
      const result: AssetJobResult = { ...base, state: 'succeeded', manifestPath: artifactPath(directory, 'manifest.json') };
      await atomicJson(directory, 'job.json', { schemaVersion: 1, ...result, request, startedAt, finishedAt: new Date().toISOString(), workers: supervision.records });
      emit('complete', 'succeeded'); return result;
    } catch (error) {
      // A stage without observed closure is never terminal: `interrupted` keeps the service's existing
      // reconciliation fence, and recovery/restart keep it interrupted. Its records stay reserved/captured.
      const unresolved = supervision.records.some(r => r.state !== 'closed');
      const code = unresolved ? 'SUPERVISION_UNRESOLVED' : error instanceof AssetError ? error.code : 'ASSET_FAILED';
      const state = unresolved ? 'interrupted' : code === 'CANCELLED' ? 'cancelled' : code === 'DEADLINE' ? 'timed_out' : 'failed';
      const diagnostic = unresolved ? hostFailure(stage) : error instanceof AssetError && error.diagnostic ? error.diagnostic : hostFailure(stage);
      const message = unresolved ? 'Worker closure was not observed; the job stays fenced and no retry is permitted.'
        : error instanceof AssetError ? error.message : 'Asset operation failed; partial output is preserved.';
      // Persist only decoded tokens, counters and hashes. Native output/tracebacks can contain paths or
      // arbitrary data and are never copied into journals, diagnostic logs or API responses.
      if (created) {
        try {
          await atomicJson(directory, 'failure.json', { schemaVersion: 1, jobId: id, code, diagnostic,
            ...(workerOutput ? { output: { exitCode: workerOutput.exitCode, signal: workerOutput.signal,
              stdoutBytes: Buffer.byteLength(workerOutput.stdout), stderrBytes: Buffer.byteLength(workerOutput.stderr),
              stdoutSha256: sha256(Buffer.from(workerOutput.stdout)), stderrSha256: sha256(Buffer.from(workerOutput.stderr)) } } : {}) });
          diagnostic.logPath = 'failure.json';
        } catch { /* A failed evidence write cannot change cancellation, deadline or supervision truth. */ }
      }
      const result: AssetJobResult = { ...base, state, error: { code, message: failureMessage(message, diagnostic), diagnostic } };
      if (created) {
        try { await atomicJson(directory, 'job.json', { schemaVersion: 1, ...result, request, startedAt, finishedAt: new Date().toISOString(), workers: supervision.records }); }
        catch { result.error = { code: 'RECOVERY_STATE', message: 'Asset operation failed and its terminal journal could not be saved; inspect the job directory.' }; }
      }
      emit('complete', state); return result;
    }
  }
  private async jobDirectory(directory: string): Promise<string> {
    const root = await realpath(this.outputRoot), target = resolve(directory);
    if (!isAbsolute(directory) || directoryKey(dirname(target)) !== directoryKey(root)) throw new AssetError('OUTPUT_PATH', 'Only direct job directories under this pipeline output root are accepted.');
    await noLinks(target); return realpath(target);
  }
  /** Hash/GLB/PNG validation always runs. Deep mode rereads the saved scene in Blender. */
  async validate(manifestPath: string, options: OperationOptions & { deep?: boolean } = {}): Promise<AssetManifest> {
    const end = deadline(options, 60000);
    if (!isAbsolute(manifestPath) || basename(manifestPath) !== 'manifest.json') throw new AssetError('OUTPUT_PATH', 'Pass an absolute job manifest.json path.');
    const directory = await this.jobDirectory(dirname(manifestPath)); remaining(end, options.signal);
    if (activeDirectories.has(directoryKey(directory))) throw new AssetError('BUSY', 'This job is still supervised.');
    const manifest = await validateManifestFiles(directory, await readJson(manifestPath, 4 * 1024 * 1024)); remaining(end, options.signal);
    if (options.deep) {
      const operation = claim(true, () => activeDirectories.delete(directoryKey(directory)));
      activeDirectories.add(directoryKey(directory));
      try {
        const probe = await this.probeIn(operation, directory, end, options.signal);
        if (!probe.blender) throw new AssetError('BLENDER_UNAVAILABLE', 'Deep validation requires an installed Blender runtime.');
        const process = await this.supervisedRun(operation, undefined, 'generate', { executable: probe.blender.executable, args: ['--background', '--factory-startup', '--disable-autoexec', '--threads', '2', '--python-exit-code', '1', '--python', workerFileArgument(await this.script('asset_worker.py')), '--', '--mode', 'audit', '--directory', workerDirectoryArgument(directory), '--request-sha256', manifest.artifacts.find(a => a.path === 'request.json')!.sha256, ...(manifest.request.recipe ? ['--recipe-sha256', sha256(Buffer.from(JSON.stringify(manifest.request.recipe))), '--estimated-triangles', JSON.stringify(preflightRecipe(manifest.request.recipe, manifest.request.triangleBudget).estimatedTriangles)] : [])], cwd: workerLaunchDirectory(probe.blender.executable, directory), env: workerEnvironment(directory) },
          { ...(options.signal ? { signal: options.signal } : {}), deadlineMs: remaining(end, options.signal) });
        if (process.exitCode !== 0) throw new AssetError('MESH', 'Saved scene failed the native Blender audit.');
        const audit = resultLine(process.stdout);
        if (manifest.request.recipe && !same(audit.assembly, manifest.assembly)) throw new AssetError('MESH', 'Saved custom recipe/socket evidence changed.');
        if (!Array.isArray(audit.errors) || audit.errors.length || !isDeepStrictEqual(audit.totals, manifest.validation.totals) || !Array.isArray(audit.meshes) || audit.meshes.length !== manifest.validation.meshes.length) throw new AssetError('MESH', 'Saved scene disagrees with manifest metrics.');
        const actualMeshes = new Map(audit.meshes.map(raw => { const m = record(raw, 'native mesh audit'); return [m.name, m]; }));
        for (const mesh of manifest.validation.meshes) if (!isDeepStrictEqual(actualMeshes.get(mesh.name), mesh)) throw new AssetError('MESH', 'Saved mesh changed since the original audit.');
      } finally { operation.finish(); }
    }
    return manifest;
  }
  /** Read/mark a lost job; never auto-replay generation or claim a worker has stopped. */
  async recover(directory: string): Promise<{ result: AssetJobResult; checkpointPath: string | null }> {
    const target = await this.jobDirectory(directory);
    if (activeDirectories.has(directoryKey(target))) throw new AssetError('BUSY', 'This job is still supervised.');
    const journal = record(await readJson(artifactPath(target, 'job.json'), JOB_JOURNAL_BYTES), 'job journal');
    if (journal.schemaVersion !== 1 || typeof journal.jobId !== 'string' || !['running', 'succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(String(journal.state))) throw new AssetError('RECOVERY', 'Invalid recovery journal.');
    if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(journal.jobId)) throw new AssetError('RECOVERY', 'Invalid recovery job identity.');
    const state = journal.state === 'running' ? 'interrupted' : journal.state as AssetJobResult['state'];
    let savedError: AssetJobResult['error'] = null;
    if (journal.error !== null && journal.error !== undefined) {
      savedError = decodeAssetJobError(journal.error);
    }
    if (state === 'succeeded' && savedError) throw new AssetError('RECOVERY', 'A succeeded journal cannot carry a failure.');
    const result: AssetJobResult = { jobId: journal.jobId, directory: target, state, manifestPath: null,
      error: state === 'interrupted' ? { code: 'SUPERVISION_LOST', message: 'Previous supervision ended. The old worker may still be alive; no automatic retry or overwrite is permitted.' } : savedError };
    if (state === 'succeeded') { const manifest = await this.validate(artifactPath(target, 'manifest.json')); if (manifest.jobId !== journal.jobId) throw new AssetError('RECOVERY', 'Manifest job identity differs from the journal.'); result.manifestPath = artifactPath(target, 'manifest.json'); }
    // The spread retains `workers` exactly as saved (valid, invalid or absent for legacy jobs); recovery never
    // rewrites, resolves or drops supervision evidence, and invalid/absent records stay unknown/fenced.
    if (journal.state === 'running') await atomicJson(target, 'job.json', { ...journal, schemaVersion: 1, ...result, recoveredAt: new Date().toISOString() });
    let checkpointPath: string | null = null;
    try { await regularFile(artifactPath(target, 'blockout.blend'), 128 * 1024 * 1024); checkpointPath = artifactPath(target, 'blockout.blend'); } catch { /* no valid checkpoint */ }
    return { result, checkpointPath };
  }
}

export const createAssetPipeline = (options: PipelineOptions): AssetPipeline => new AssetPipeline(options);
