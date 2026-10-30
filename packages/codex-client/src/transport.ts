import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { CODEX_LIMITS, CodexClientError, type Limits } from './types.js';
import { fail, object } from './validation.js';

type Method = 'initialize' | 'account/read' | 'account/rateLimits/read' | 'model/list' | 'thread/start' | 'thread/resume' | 'turn/start' | 'turn/steer' | 'turn/interrupt' | 'mcpServerStatus/list';
const METHODS = new Set<Method>(['initialize', 'account/read', 'account/rateLimits/read', 'model/list', 'thread/start', 'thread/resume', 'turn/start', 'turn/steer', 'turn/interrupt', 'mcpServerStatus/list']);
interface Pending { resolve(value: unknown): void; reject(error: CodexClientError): void; timer: NodeJS.Timeout; dispatched: boolean; method: Method }
const FRAME_METHODS: readonly Method[] = ['initialize', 'account/read', 'account/rateLimits/read', 'model/list', 'thread/start', 'thread/resume', 'turn/start', 'turn/steer', 'turn/interrupt', 'mcpServerStatus/list'];
const CONNECT_FRAME_PHASES = ['direct-initialize', 'discovery-initialize', 'discovery-inventory', 'discovery-close', 'final-initialize'] as const;
export type NativeConnectFramePhase = typeof CONNECT_FRAME_PHASES[number];
export interface NativeFrameEvidence {
  readonly schemaVersion: 1;
  readonly direction: 'inbound' | 'outbound';
  readonly byteCountKind: 'exact' | 'at-least';
  readonly byteCount: number;
  readonly frameLimitBytes: number;
  /** Outstanding requests only; never attribution of an unparsed inbound line. */
  readonly pendingMethodMask: number;
  readonly pendingCount: number;
  readonly connectPhase: 'not-connect' | NativeConnectFramePhase;
}
// Only the two actual refusal sites below mint evidence. Error properties,
// serialized objects and caller-supplied FRAME_LIMIT codes cannot mint it.
const frameEvidence = new WeakMap<object, Readonly<NativeFrameEvidence>>();
export function readNativeFrameEvidence(error: unknown): Readonly<NativeFrameEvidence> | null {
  try { return error !== null && typeof error === 'object' ? frameEvidence.get(error) ?? null : null; }
  catch { return null; }
}
/** Internal factory annotation only, and only on an already-owned error. */
export function annotateNativeConnectFrame(error: unknown, phase: NativeConnectFramePhase): void {
  try {
    const original = readNativeFrameEvidence(error);
    if (original && error !== null && typeof error === 'object' && (CONNECT_FRAME_PHASES as readonly unknown[]).includes(phase))
      frameEvidence.set(error, Object.freeze({ ...original, connectPhase: phase }));
  } catch { /* Diagnostic observation cannot replace an operational failure. */ }
}
export interface InternalProcess { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }
export function nativeEnvironment(): NodeJS.ProcessEnv {
  // No caller environment and no credentials, endpoint, auth-location or provider overrides.
  const names = new Set(['path','systemroot','windir','systemdrive','comspec','pathext','temp','tmp','home','userprofile','appdata','localappdata','lang','lc_all','lc_ctype']);
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => names.has(key.toLowerCase())));
}
export class JsonlTransport {
  #child: ChildProcessWithoutNullStreams;
  #pending = new Map<number, Pending>();
  #nextId = 1;
  #frame: Buffer;
  #partBytes = 0;
  #outputBytes = 0;
  #stderrBytes = 0;
  #closed = false;
  #exited = false;
  #closedPromise: Promise<void>;
  #resolveClosed!: () => void;
  #fullyClosed = false;
  #joining: Promise<void> | null = null;
  #ownedCloseRequestErrors = new WeakSet<object>();
  constructor(spec: InternalProcess, readonly bounds: Limits, private readonly onMessage: (message: Record<string, unknown>) => void, private readonly onDisconnect: (error: CodexClientError) => void) {
    if (!isAbsolute(spec.command) || !isAbsolute(spec.cwd)) fail('PROCESS_PATH', 'Executable and workspace must be absolute.');
    this.#frame = Buffer.alloc(bounds.maxFrameBytes);
    this.#closedPromise = new Promise(resolve => { this.#resolveClosed = resolve; });
    this.#child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, shell: false, windowsHide: true, stdio: 'pipe' });
    this.#child.stdout.on('data', (chunk: Buffer) => this.#receive(chunk));
    this.#child.stderr.on('data', (chunk: Buffer) => {
      if (this.#closed) return;
      this.#stderrBytes += chunk.length; // Never retain or publish stderr.
      this.#outputBytes += chunk.length;
      if (this.#stderrBytes > bounds.maxStderrBytes || this.#outputBytes > bounds.maxOutputBytes) this.stop(new CodexClientError('OUTPUT_LIMIT', 'Native output exceeded its bound.'));
    });
    this.#child.stdin.on('error', () => this.stop(new CodexClientError('IO', 'Native input disconnected.')));
    this.#child.stdout.on('error', () => this.stop(new CodexClientError('IO', 'Native output disconnected.')));
    this.#child.stderr.on('error', () => this.stop(new CodexClientError('IO', 'Native diagnostics disconnected.')));
    this.#child.on('error', () => this.stop(new CodexClientError('PROCESS_START', 'Native CLI could not start.')));
    // Invalidate approvals on exit, before close is delivered or buffered output is drained.
    this.#child.on('exit', () => {
      this.#exited = true;
      this.stop(new CodexClientError('DISCONNECTED', 'Native CLI disconnected.'));
    });
    this.#child.on('close', () => {
      this.#exited = true;
      this.#fullyClosed = true;
      this.stop(new CodexClientError('DISCONNECTED', 'Native CLI disconnected.'));
      this.#resolveClosed();
    });
  }
  get connected(): boolean { return !this.#closed && !this.#exited; }
  request(method: Method, params: unknown, onId?: (id: number) => void, onDispatched?: () => void): Promise<unknown> {
    if (!METHODS.has(method)) return Promise.reject(new CodexClientError('METHOD', 'Method is outside the fixed client surface.'));
    if (onDispatched && method !== 'turn/start') return Promise.reject(new CodexClientError('METHOD', 'Dispatch callbacks are only supported for turn/start.'));
    if (!this.connected) return Promise.reject(new CodexClientError('DISCONNECTED', 'Native CLI is disconnected.'));
    if (this.#pending.size >= this.bounds.maxPendingRequests) return Promise.reject(new CodexClientError('PENDING_LIMIT', 'Too many pending requests.'));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // This optional, side-effect-free observation has no lifecycle outcome
        // to reconcile. Its timeout must not interrupt a working model turn.
        if (method === 'account/rateLimits/read') {
          this.#pending.delete(id);
          reject(new CodexClientError('RATE_LIMITS_TIMEOUT', 'Native account usage did not arrive before the read deadline.', entry.dispatched));
        } else if (method === 'turn/steer') {
          // Delivery is unknown, not permission to retry or end the original
          // turn/asset intent. A late response cannot settle another request.
          this.#pending.delete(id);
          reject(new CodexClientError('STEER_TIMEOUT', 'Steering acknowledgement did not arrive; inspect the retained request before continuing.', entry.dispatched));
        } else this.stop(new CodexClientError('TIMEOUT', 'Native request timed out.'));
      }, this.bounds.requestTimeoutMs);
      const entry = { resolve, reject, timer, dispatched: false, method };
      this.#pending.set(id, entry);
      try {
        onId?.(id);
        this.#write({ id, method, params }); entry.dispatched = true;
        onDispatched?.();
      }
      catch (error) {
        if (entry.dispatched) {
          // The bytes have crossed the write boundary; callback failure cannot make them retryable.
          this.stop(new CodexClientError('UNKNOWN', 'Native dispatch completion is uncertain.', true));
          return;
        }
        clearTimeout(timer); this.#pending.delete(id);
        reject(error instanceof CodexClientError ? error : new CodexClientError('IO', 'Native request could not be written.'));
      }
    });
  }
  initialized(): void { this.#write({ method: 'initialized', params: {} }); }
  respond(id: string | number, result: unknown): void { this.#write({ id, result }); }
  refuse(id: string | number): void { this.#write({ id, error: { code: -32601, message: 'Unsupported by this local client.' } }); }
  #write(message: unknown): void {
    if (!this.connected || this.#child.stdin.destroyed || this.#child.exitCode !== null || this.#child.signalCode !== null) fail('DISCONNECTED', 'Native CLI is disconnected.');
    const data = JSON.stringify(message) + '\n';
    const bytes = Buffer.byteLength(data);
    if (bytes > this.bounds.maxFrameBytes) throw this.#frameFailure('outbound', bytes);
    if (this.#child.stdin.writableLength + bytes > this.bounds.maxQueuedBytes) fail('QUEUE_LIMIT', 'Native input queue exceeded its bound.');
    this.#child.stdin.write(data);
  }
  #receive(chunk: Buffer): void {
    if (this.#closed) return;
    this.#outputBytes += chunk.length;
    if (this.#outputBytes > this.bounds.maxOutputBytes) return this.stop(new CodexClientError('OUTPUT_LIMIT', 'Native output exceeded its bound.'));
    let offset = 0;
    try {
      while (offset < chunk.length && !this.#closed) {
        const newline = chunk.indexOf(10, offset);
        const end = newline < 0 ? chunk.length : newline;
        const part = chunk.subarray(offset, end);
        if (this.#partBytes + part.length > this.bounds.maxFrameBytes) throw this.#frameFailure('inbound', this.#partBytes + part.length);
        // A fixed buffer also bounds allocation overhead for one-byte chunks.
        if (part.length) { part.copy(this.#frame, this.#partBytes); this.#partBytes += part.length; }
        offset = end + 1;
        if (newline < 0) break;
        const frame = this.#frame.subarray(0, this.#partBytes);
        this.#partBytes = 0;
        const text = new TextDecoder('utf-8', { fatal: true }).decode(frame);
        if (!text.trim()) continue;
        this.#message(object(JSON.parse(text)));
      }
    } catch (error) {
      this.stop(error instanceof CodexClientError && ['FRAME_LIMIT','OUTPUT_LIMIT'].includes(error.code) ? error : new CodexClientError('PROTOCOL', 'Native CLI returned an invalid frame.'));
    }
  }
  #message(message: Record<string, unknown>): void {
    if (typeof message.method === 'string') { this.onMessage(message); return; }
    if (!Number.isSafeInteger(message.id)) throw new Error('Invalid response ID');
    const pending = this.#pending.get(message.id as number);
    if (!pending) return; // Late/unknown IDs cannot settle another request.
    const hasResult = Object.hasOwn(message, 'result');
    const hasError = Object.hasOwn(message, 'error');
    if (hasResult === hasError) throw new Error('Incomplete response');
    // Validate the error before removing the pending request, so malformed errors settle it through stop().
    const raw = hasError ? object(message.error) : null;
    clearTimeout(pending.timer); this.#pending.delete(message.id as number);
    if (raw) {
      const code = typeof raw.code === 'number' && Number.isSafeInteger(raw.code) ? raw.code : null;
      pending.reject(new CodexClientError('REMOTE_REJECTED', 'Native CLI rejected the request.', pending.dispatched, code));
    } else pending.resolve(message.result);
  }
  /** Exact errors created by this transport while its explicit close stops pending requests. */
  isOwnedCloseRequestError(error: unknown): boolean {
    return typeof error === 'object' && error !== null && this.#ownedCloseRequestErrors.has(error);
  }
  #frameFailure(direction: 'inbound' | 'outbound', bytes: number): CodexClientError {
    const error = new CodexClientError('FRAME_LIMIT', direction === 'inbound' ? 'Inbound frame exceeded its bound.' : 'Outbound frame exceeded its bound.');
    try {
      let mask = 0;
      for (const pending of this.#pending.values()) mask |= 1 << FRAME_METHODS.indexOf(pending.method);
      const count = this.#pending.size, limit = this.bounds.maxFrameBytes;
      if (Number.isSafeInteger(bytes) && bytes >= 0 && Number.isSafeInteger(limit) && limit >= 1 && limit <= CODEX_LIMITS.maxFrameBytes &&
          count <= CODEX_LIMITS.maxPendingRequests && mask >= 0 && mask <= 1023) {
        frameEvidence.set(error, Object.freeze({ schemaVersion: 1, direction,
          byteCountKind: direction === 'inbound' || bytes > CODEX_LIMITS.maxOutputBytes ? 'at-least' : 'exact',
          byteCount: Math.min(bytes, CODEX_LIMITS.maxOutputBytes), frameLimitBytes: limit,
          pendingMethodMask: mask, pendingCount: count, connectPhase: 'not-connect' }));
      }
    } catch { /* Keep the exact original refusal if diagnostic collection fails. */ }
    return error;
  }
  stop(reason = new CodexClientError('DISCONNECTED', 'Local client disconnected.')): void {
    this.#stop(reason, false);
  }
  #stop(reason: CodexClientError, ownedClose: boolean): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#frame = Buffer.alloc(0); this.#partBytes = 0;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      const error = new CodexClientError(reason.code, reason.message, pending.dispatched, reason.remoteCode);
      try { const evidence = readNativeFrameEvidence(reason); if (evidence) frameEvidence.set(error, evidence); }
      catch { /* The original pending rejection and cleanup remain authoritative. */ }
      if (ownedClose) this.#ownedCloseRequestErrors.add(error);
      pending.reject(error);
    }
    this.#pending.clear();
    this.onDisconnect(reason);
    this.#child.stdin.destroy();
    if (!this.#exited) { try { this.#child.kill(); } catch { /* close() reports an unconfirmed exit after bounded escalation. */ } }
  }
  close(): Promise<void> {
    this.#stop(new CodexClientError('DISCONNECTED', 'Local client disconnected.'), true);
    return this.#joining ??= this.#join();
  }
  async #waitForClose(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([this.#closedPromise,new Promise<void>(resolve=>{timer=setTimeout(resolve,1000);})]);
    } finally { if(timer)clearTimeout(timer); }
  }
  async #join(): Promise<void> {
    await this.#waitForClose();
    if(this.#fullyClosed)return;
    if(!this.#exited){try{this.#child.kill('SIGKILL');}catch{/* The bounded confirmation below remains authoritative. */}}
    // Sending a signal is not evidence that the owned process and its streams
    // closed. Join the close event after escalation, or report uncertainty.
    await this.#waitForClose();
    if(!this.#fullyClosed)throw new CodexClientError('PROCESS_EXIT_UNCONFIRMED','Native process closure was not confirmed.');
  }
}
