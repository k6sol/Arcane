import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { jsonSnapshot } from '../../../packages/asset-pipeline/src/recipe.js';
import { jsonObject, methodField, instanceRef } from '../../../packages/protocol/src/studio.js';
import type { StudioCommand, StudioMethod, StudioSession, Json } from '../../../packages/protocol/src/studio.js';
import { command, session } from './schemas.js';
import { workTask, workRun, workDefinition, leaseToken } from './work-schemas.js';
import type { WorkTask, WorkRun } from '../../../packages/storage/src/work-store.js';
import { assetInput, assetProbe, assetJob, assetManifest, assetJobId, safeAssetInput, type SafeAssetInput } from './asset-schemas.js';

const RESPONSE_LIMIT = 1024 * 1024; // A command contains up to 256 KiB args plus 512 KiB result.
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'needs_reconciliation']);
const WAIT_LIMIT = 60_000;

export class BridgeError extends Error {
  constructor(readonly code: string, message: string, readonly rejected = false) { super(message); this.name = 'BridgeError'; }
}

export function validateDaemonUrl(value: string | undefined): string {
  const match = typeof value === 'string' ? /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(value) : null;
  if (!match || Number(match[1]) > 65_535) throw new BridgeError('CONFIG_URL', 'ARCANE_DAEMON_URL must be exactly http://127.0.0.1:PORT (1–65535).');
  return value!;
}

function validateToken(value: string | undefined): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._~+\/-]+=*$/.test(value) || value.length > 4096) {
    throw new BridgeError('CONFIG_TOKEN', 'Set ARCANE_LOCAL_TOKEN to the launcher-issued agent bearer in the process environment.');
  }
  return value;
}

export interface WaitOptions { timeoutMs?: number; signal?: AbortSignal }
export interface CommandOutcome {
  commandId: string | null;
  requestId: string;
  sessionId: string | null;
  state: StudioCommand['state'] | 'unknown';
  terminal: boolean;
  ambiguous: boolean;
  wait: 'terminal' | 'timeout' | 'aborted' | 'interrupted';
  command: StudioCommand | null;
  error?: { code: string; message: string };
  nextStep?: string;
}

export class DaemonClient {
  readonly url: string;
  readonly #token: string;
  readonly #pollIntervalMs: number;

  constructor(options: { url: string; token: string; pollIntervalMs?: number }) {
    this.url = validateDaemonUrl(options.url);
    this.#token = validateToken(options.token);
    this.#pollIntervalMs = options.pollIntervalMs ?? 500;
    if (!Number.isInteger(this.#pollIntervalMs) || this.#pollIntervalMs < 5 || this.#pollIntervalMs > 2000) {
      throw new BridgeError('CONFIG_POLL', 'Polling interval must be 5–2000 milliseconds.');
    }
  }

  static fromEnvironment(env: NodeJS.ProcessEnv = process.env): DaemonClient {
    return new DaemonClient({ url: validateDaemonUrl(env.ARCANE_DAEMON_URL), token: validateToken(env.ARCANE_LOCAL_TOKEN) });
  }

  redact<T>(value: T): T {
    return JSON.parse(JSON.stringify(value).replaceAll(this.#token, '[redacted]')) as T;
  }

  private deadline(options: WaitOptions): { signal: AbortSignal; dispose: () => void } {
    const timeout = options.timeoutMs ?? 30_000;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > WAIT_LIMIT) throw new BridgeError('INPUT', 'Wait timeout must be 1–60000 milliseconds.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    return { signal: controller.signal, dispose: () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); } };
  }

  private async http(path: string, signal: AbortSignal, body?: object): Promise<unknown> {
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await fetch(this.url + path, {
        method: body ? 'POST' : 'GET', headers: {
          Authorization: `Bearer ${this.#token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}),
        }, ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal,
      });
    } catch {
      if (signal.aborted) throw new BridgeError('WAIT_ABORTED', 'The wait ended; any submitted command may still execute.');
      throw new BridgeError('DAEMON_UNREACHABLE', 'The local daemon connection failed. Redirects are refused.');
    }
    const contentLength = Number(response.headers.get('content-length'));
    if (contentLength > RESPONSE_LIMIT) { await response.body?.cancel(); throw new BridgeError('RESPONSE_LIMIT', 'Daemon response exceeds 1 MiB.'); }
    const reader = response.body?.getReader();
    if (!reader) throw new BridgeError('PROTOCOL', 'Daemon returned an empty response.');
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > RESPONSE_LIMIT) throw new BridgeError('RESPONSE_LIMIT', 'Daemon response exceeds 1 MiB.');
        chunks.push(chunk.value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    signal.throwIfAborted();
    let payload: unknown;
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new BridgeError('PROTOCOL', 'Daemon response is not valid JSON.'); }
    if (!response.ok) {
      const error = z.object({ error: z.string().min(1).max(64), message: z.string().min(1).max(8192) }).safeParse(payload);
      const rejected = response.status >= 400 && response.status < 500;
      if (error.success) throw new BridgeError(this.redact(error.data.error), this.redact(error.data.message), rejected);
      throw new BridgeError('DAEMON_HTTP', `The local daemon rejected the request (HTTP ${response.status}).`, rejected);
    }
    if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new BridgeError('PROTOCOL', 'Daemon response must be application/json.');
    return payload;
  }

  private parseCommand(value: unknown, expected: { id?: string; sessionId?: string; requestId?: string; method?: StudioMethod }): StudioCommand {
    const parsed = z.object({ command }).safeParse(value);
    if (!parsed.success) throw new BridgeError('PROTOCOL', 'Daemon returned an invalid Studio command.');
    const item: StudioCommand = parsed.data.command;
    for (const key of ['id', 'sessionId', 'requestId', 'method'] as const) {
      if (expected[key] !== undefined && item[key] !== expected[key]) throw new BridgeError('PROTOCOL', 'Daemon returned a command for a different request or session.');
    }
    return item;
  }

  async sessions(options: WaitOptions = {}): Promise<{ sessions: StudioSession[] }> {
    const deadline = this.deadline(options);
    try {
      const parsed = z.object({ sessions: z.array(session).max(1000) }).safeParse(await this.http('/v1/studio/sessions', deadline.signal));
      if (!parsed.success) throw new BridgeError('PROTOCOL', 'Daemon returned invalid Studio sessions.');
      return parsed.data;
    } finally { deadline.dispose(); }
  }

  async receiptStatus(commandId: string, options: WaitOptions = {}): Promise<{ command: StudioCommand }> {
    const deadline = this.deadline(options);
    try { return { command: this.parseCommand(await this.http(`/v1/studio/commands/${encodeURIComponent(commandId)}`, deadline.signal), { id: commandId }) }; }
    finally { deadline.dispose(); }
  }

  async execute(sessionId: string, method: StudioMethod, args: Record<string, Json>, options: WaitOptions = {}): Promise<CommandOutcome> {
    methodField(method);
    if (method === 'scene.restore') throw new BridgeError('METHOD', 'Restore accepts only an immutable receipt command ID.');
    jsonObject(args);
    for (const key of ['ref', 'parent']) {
      if (args[key] !== undefined) {
        const reference = instanceRef(args[key]);
        if (reference.sessionId !== sessionId || (args.root !== undefined && reference.root !== args.root)) {
          throw new BridgeError('REFERENCE_SESSION', 'Reference must belong to the exact selected session and root.');
        }
      }
    }
    const requestId = randomUUID();
    return this.submit('/v1/studio/commands', { sessionId, requestId, method, args }, { sessionId, requestId, method }, options);
  }

  async restore(commandId: string, options: WaitOptions = {}): Promise<CommandOutcome> {
    const requestId = randomUUID();
    return this.submit('/v1/studio/restore', { commandId, requestId }, { requestId, method: 'scene.restore' }, options);
  }

  async workRuns(options: WaitOptions = {}): Promise<{ runs: WorkRun[] }> {
    return this.readRecord('/v1/work/runs', z.object({ runs: z.array(workRun).max(100) }), options);
  }

  async workReady(runId: string | undefined, options: WaitOptions = {}): Promise<{ tasks: WorkTask[] }> {
    const schema = z.object({ tasks: z.array(workTask).max(6400) })
      .refine(value => !runId || value.tasks.every(task => task.runId === runId), 'Wrong work run.');
    return this.readRecord('/v1/work/ready' + (runId ? '?runId=' + encodeURIComponent(runId) : ''), schema, options);
  }

  async workCreate(input: z.output<z.ZodObject<typeof workDefinition>>, options: WaitOptions = {}) {
    const body = z.strictObject(workDefinition).parse(input);
    return this.postOnce('/v1/work/create', body, z.object({ run: workRun }), { title: body.title },
      'Inspect work_runs for this run title and objective. Creation may have applied; do not repeat it automatically.', options);
  }

  async workClaim(input: { taskId: string; worker: string }, options: WaitOptions = {}) {
    const schema = z.object({ task: workTask, leaseToken }).refine(value => value.task.id === input.taskId && value.task.worker === input.worker && value.task.state === 'in_progress', 'Wrong claimed task.');
    return this.postOnce('/v1/work/claim', input, schema, { taskId: input.taskId },
      'Inspect this task with work_runs. Do not repeat the claim automatically. If its acknowledgement was lost, the lease token cannot be recovered through these tools; wait for expiry or use the human panel.', options);
  }

  async workProgress(input: { taskId: string; leaseToken: string; progress: string }, options: WaitOptions = {}) {
    const schema = z.object({ task: workTask }).refine(value => value.task.id === input.taskId && value.task.state === 'in_progress', 'Wrong progress task.');
    return this.postOnce('/v1/work/progress', input, schema, { taskId: input.taskId },
      'Inspect this task with work_runs. Progress may have applied; do not repeat it automatically.', options);
  }

  async workSubmit(input: { taskId: string; leaseToken: string; evidence: { path: string; note: string }[] }, options: WaitOptions = {}) {
    const schema = z.object({ task: workTask }).refine(value => value.task.id === input.taskId && value.task.state === 'needs_review', 'Wrong submitted task.');
    return this.postOnce('/v1/work/submit', input, schema, { taskId: input.taskId },
      'Inspect this task and hashed evidence with work_runs. Submission may have applied; do not repeat it automatically. Human review owns acceptance.', options);
  }

  async assetsProbe(options: WaitOptions = {}) {
    return this.postOnce('/v1/assets/probe', {}, z.object({ probe: assetProbe }), {},
      'The fixed local runtime probe may still be running. Inspect daemon availability before requesting another probe.', options);
  }

  async assetsJobs(options: WaitOptions = {}) {
    return this.readRecord('/v1/assets/jobs', z.object({ jobs: z.array(assetJob).max(1000) }), options);
  }

  async assetsStart(input: SafeAssetInput, options: WaitOptions = {}) {
    const body = safeAssetInput(assetInput.parse(jsonSnapshot(input)));
    return this.postOnce('/v1/assets/start', body, z.object({ job: assetJob }), { jobId: null, name: body.name },
      'Inspect assets_jobs for this asset name and request. The job may have started; do not repeat the start automatically. operationId is diagnostic, not a daemon idempotency key.', options);
  }

  async assetsCancel(jobId: string, options: WaitOptions = {}) {
    assetJobId.parse(jobId);
    const schema = z.object({ job: assetJob }).refine(value => value.job.jobId === jobId, 'Wrong asset job.');
    return this.postOnce('/v1/assets/cancel', { jobId }, schema, { jobId },
      'Inspect this exact job with assets_jobs. Cancellation may have applied; partial artifacts remain. Do not repeat automatically.', options);
  }

  async assetsManifest(jobId: string, options: WaitOptions = {}) {
    assetJobId.parse(jobId);
    const schema = z.object({ manifest: assetManifest }).refine(value => value.manifest.jobId === jobId, 'Wrong asset manifest.');
    return this.readRecord('/v1/assets/manifest?jobId=' + encodeURIComponent(jobId), schema, options);
  }

  private async readRecord<T>(path: string, schema: z.ZodType<T>, options: WaitOptions): Promise<T> {
    const deadline = this.deadline(options);
    try {
      const parsed = schema.safeParse(await this.http(path, deadline.signal));
      if (!parsed.success) throw new BridgeError('PROTOCOL', 'Daemon returned an invalid local record.');
      return parsed.data;
    } finally { deadline.dispose(); }
  }

  private async postOnce<T>(path: string, input: object, schema: z.ZodType<T>, identity: Record<string, string | null>, nextStep: string, options: WaitOptions) {
    const deadline = this.deadline(options);
    // Diagnostic ID only: these endpoints do not promise request-id idempotency.
    const operationId = randomUUID();
    let attempted = false;
    try {
      deadline.signal.throwIfAborted();
      attempted = true;
      const parsed = schema.safeParse(await this.http(path, deadline.signal, input));
      if (!parsed.success) throw new BridgeError('PROTOCOL', 'Daemon returned an invalid local operation record.');
      return parsed.data;
    } catch (error) {
      if (!attempted) throw new BridgeError('ABORTED', 'The caller cancelled before the operation was submitted.');
      if (error instanceof BridgeError && error.rejected) throw error;
      return { ...identity, operationId, state: 'unknown', terminal: false, ambiguous: true,
        wait: deadline.signal.aborted ? options.signal?.aborted ? 'aborted' : 'timeout' : 'interrupted', nextStep };
    } finally { deadline.dispose(); }
  }

  private async submit(path: string, body: object, expected: { sessionId?: string; requestId: string; method: StudioMethod }, options: WaitOptions): Promise<CommandOutcome> {
    const deadline = this.deadline(options);
    let last: StudioCommand | null = null;
    let attempted = false;
    const started = performance.now();
    try {
      deadline.signal.throwIfAborted();
      attempted = true;
      // One POST only: an interrupted enqueue is never automatically replayed.
      last = this.parseCommand(await this.http(path, deadline.signal, body), expected);
      while (!TERMINAL.has(last.state)) {
        await sleep(this.#pollIntervalMs, undefined, { signal: deadline.signal });
        last = this.parseCommand(await this.http(`/v1/studio/commands/${encodeURIComponent(last.id)}`, deadline.signal), { ...expected, id: last.id, sessionId: last.sessionId });
        // Bound even an injected timer implementation or excessively fast responses.
        if (performance.now() - started >= (options.timeoutMs ?? 30_000) && !TERMINAL.has(last.state)) break;
      }
      if (TERMINAL.has(last.state)) return {
        commandId: last.id, requestId: expected.requestId, sessionId: last.sessionId, state: last.state,
        terminal: true, ambiguous: last.state === 'needs_reconciliation', wait: 'terminal', command: last,
        ...(last.state === 'needs_reconciliation' ? { nextStep: 'Inspect receipt_status and reconcile the exact paired session. Do not replay this operation.' } : {}),
      };
      return this.uncertain(last, expected, 'timeout');
    } catch (error) {
      if (!attempted) throw new BridgeError('ABORTED', 'The caller cancelled before enqueue; no command was submitted.');
      if (deadline.signal.aborted) return this.uncertain(last, expected, options.signal?.aborted ? 'aborted' : 'timeout');
      // Definitive HTTP rejections before acceptance are errors; connectivity/protocol failures are ambiguous.
      if (!last && error instanceof BridgeError && error.rejected) throw error;
      const detail = error instanceof BridgeError ? { code: error.code, message: error.message } : { code: 'DAEMON_CONNECTION', message: 'The local daemon response was interrupted.' };
      return { ...this.uncertain(last, expected, 'interrupted'), error: detail };
    } finally { deadline.dispose(); }
  }

  private uncertain(last: StudioCommand | null, expected: { requestId: string; sessionId?: string }, wait: 'timeout' | 'aborted' | 'interrupted'): CommandOutcome {
    return { commandId: last?.id ?? null, requestId: expected.requestId, sessionId: last?.sessionId ?? expected.sessionId ?? null,
      state: last?.state ?? 'unknown', terminal: false, ambiguous: true, wait, command: last,
      nextStep: last ? 'Use receipt_status with commandId. The command may still execute; do not repeat the operation.'
        : 'Enqueue acknowledgement was lost. Find requestId in the daemon command history for this exact session; do not repeat the operation.' };
  }
}
