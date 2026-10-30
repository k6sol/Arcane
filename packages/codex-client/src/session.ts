import { randomUUID, createHash } from 'node:crypto';
import { types } from 'node:util';
import { spawn } from 'node:child_process';
import { CODEX_HISTORY_MAX_PAGES, CODEX_HISTORY_PAGE_SIZE, NATIVE_HISTORY_LIMITS, codexThreadHistoryMode, codexTurnsPageProgress,
  parseCodexPaginatedHistory, parseCodexThreadRead, redactNativeHistoryText, type CodexHistoryScope, type NativeHistoryResult } from './history.js';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { JsonlTransport, type InternalProcess } from './transport.js';
import { arcaneThreadIsIsolated, proposalThreadIsIsolated, requireArcaneBuildTools, type McpInventoryRow } from './mcp-isolation.js';
import { ARCANE_TASK_INSTRUCTIONS, ARCANE_NATIVE_TOOL_NAMES } from '../../protocol/src/arcane-tools.js';
import { CodexClientError, validateNativeAssetHooks, type Account, type Approval, type ApprovalMethod, type FileChangePreview, type HumanAction, type Limits, type Model, type NativeAssetHooks, type NativeAssetIntent, type Operation, type Selection, type SessionEvent, type SessionEventValue, type Snapshot, type ThreadState } from './types.js';
import { exact, fail, human, object, optionalText, str } from './validation.js';
import type { NativeTokenUsage, TokenUsageBreakdown, TokenUsageReport } from './types.js';
import type { NativeTaskContinuation, ManagedTaskStart, NativeIncorporationChain, NativeIncorporationPermit } from './types.js';
import type { SteerTurnAction, SteerTurnAck } from './types.js';
import { summarizeMcpToolCall } from './tool-call.js';
import { snapshotReferenceImages, type ReferenceImage } from './reference-images.js';
import { parseNativeRateLimits, mergeNativeRateLimitUpdate, type NativeRateLimits } from './rate-limits.js';

const USAGE_COUNT_LIMIT = 1_000_000_000_000;
const USAGE_KEYS = ['totalTokens', 'inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens'] as const;
function usageObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Reflect.ownKeys(value).length <= 32 && Reflect.ownKeys(value).every(key =>
      typeof key === 'string' && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'));
}
function usageCount(value: unknown, limit = USAGE_COUNT_LIMIT): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= limit;
}
function usageBreakdown(value: unknown): TokenUsageBreakdown | null {
  if (!usageObject(value) || USAGE_KEYS.some(key => !Object.hasOwn(value, key) || !usageCount(value[key])) ||
      value.cacheWriteInputTokens !== undefined && !usageCount(value.cacheWriteInputTokens)) return null;
  const counts = Object.fromEntries(USAGE_KEYS.map(key => [key, value[key]])) as unknown as TokenUsageBreakdown;
  if (value.cacheWriteInputTokens !== undefined) counts.cacheWriteInputTokens = value.cacheWriteInputTokens as number;
  if (counts.inputTokens + counts.outputTokens > counts.totalTokens ||
      counts.cachedInputTokens > counts.inputTokens || counts.reasoningOutputTokens > counts.outputTokens ||
      (counts.cacheWriteInputTokens ?? 0) + counts.cachedInputTokens > counts.inputTokens) return null;
  return counts;
}
/** Bounded whitelist for the v2 native notification; never reads auth or logs raw frames. */
export function parseNativeTokenUsage(value: unknown): NativeTokenUsage | null {
  if (!usageObject(value) || !['total', 'last', 'modelContextWindow'].every(key => Object.hasOwn(value, key))) return null;
  const total = usageBreakdown(value.total), last = usageBreakdown(value.last);
  if (!total || !last || !(value.modelContextWindow === null || usageCount(value.modelContextWindow, 1_000_000_000)) ||
      USAGE_KEYS.some(key => last[key] > total[key]) ||
      total.cacheWriteInputTokens !== undefined && last.cacheWriteInputTokens !== undefined && last.cacheWriteInputTokens > total.cacheWriteInputTokens) return null;
  return { source: 'thread/tokenUsage/updated', total, last, modelContextWindow: value.modelContextWindow as number | null, continuity: 'reported' };
}

interface PendingApproval { value: Approval; timer: NodeJS.Timeout; wireKey: string; safeToAccept: boolean }
export const INCORPORATION_MAX_STEPS = 3;
interface IncorporationChain {
  readonly chain: NativeIncorporationChain; readonly continuation: NativeTaskContinuation; readonly thread: ThreadState; readonly sessionId: string | null;
  readonly selection: Selection; readonly accountRevision: number; readonly accountIdentity: string; readonly allowWrites: boolean; readonly maxSteps: number;
  issued: number; last: Operation; permit: { readonly token: NativeIncorporationPermit; readonly step: number; used: boolean } | null; inFlight: boolean; revoked: boolean;
}
/** Exact own data properties only: accessors and extra or symbol keys are refused before any use. */
function ownData(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) ||
      ![Object.prototype,null].includes(Object.getPrototypeOf(value))) fail('ARGUMENTS', 'Expected an exact host capability envelope.');
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) fail('ARGUMENTS', 'Unexpected field.');
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field || !Object.hasOwn(field, 'value')) fail('ARGUMENTS', 'Capability fields must be plain data.');
    result[key] = field.value;
  }
  return result;
}
interface TurnPreflight { thread: ThreadState; selection: Selection; accountRevision: number; turnId: string | null; turnStatus: ThreadState['turnStatus']; revoked: boolean }
const APPROVALS = new Set(['item/commandExecution/requestApproval','item/fileChange/requestApproval']);
const TERMINAL = new Set(['completed','failed','interrupted']);
const PLANS = new Set(['free','go','plus','pro','team','business','enterprise','edu','unknown']);
function wireKey(id: string | number): string { return typeof id + ':' + id; }
function requestId(value: unknown): string | number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  return str(value, 256);
}
function status(value: unknown): ThreadState['turnStatus'] {
  if (value === 'inProgress' || value === 'completed' || value === 'failed' || value === 'interrupted') return value;
  fail('PROTOCOL', 'Unknown turn status.');
}

/**
 * One-shot public read path. The lifecycle transport deliberately has no history method.
 * Sequence: initialize → metadata-only thread/read (exact scope and storage mode) → either a legacy hydrated
 * thread/read, or bounded ascending itemsView:'full' thread/turns/list pages for paginated threads.
 */
function readHistoryProcess(spec: InternalProcess, bounds: Limits, scope: CodexHistoryScope) {
  const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, shell: false, windowsHide: true, stdio: 'pipe' });
  let done = false, stage = 1, bytes = 0, stderrBytes = 0, used = 0, serverRequests = 0;
  let phase: 'initialize' | 'metadata' | 'legacy' | 'pages' = 'initialize', metadata: unknown = null, pagedTurns = 0;
  const pages: unknown[] = [];
  const request = (method: string, params: Record<string, unknown>) => { stage++; send({ id: stage, method, params }); };
  const nextPage = (cursor: string | null) => request('thread/turns/list', { threadId: scope.threadId, limit: CODEX_HISTORY_PAGE_SIZE,
    sortDirection: 'asc', itemsView: 'full', ...(cursor === null ? {} : { cursor }) });
  const frame = Buffer.alloc(bounds.maxFrameBytes);
  let resolveResult!: (value: NativeHistoryResult) => void;
  let rejectResult!: (error: CodexClientError) => void;
  const promise = new Promise<NativeHistoryResult>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  let resolveClosed!: () => void;
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  child.once('exit', resolveClosed);
  child.once('close', resolveClosed);
  const finish = (error: CodexClientError | null, value?: NativeHistoryResult) => {
    if (done) return;
    done = true; clearTimeout(deadline);
    child.kill();
    const killTimer = setTimeout(() => { child.kill('SIGKILL'); resolveClosed(); }, 1000);
    void closed.then(() => {
      clearTimeout(killTimer);
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      if (error) rejectResult(error); else resolveResult(value!);
    });
  };
  const deadline = setTimeout(() => finish(new CodexClientError('TIMEOUT', 'Native history read timed out.', true)), bounds.requestTimeoutMs);
  const send = (value: unknown) => {
    if (done) return;
    const wire = JSON.stringify(value) + '\n';
    if (Buffer.byteLength(wire) > bounds.maxFrameBytes || child.stdin.writableLength + Buffer.byteLength(wire) > bounds.maxQueuedBytes) {
      finish(new CodexClientError('FRAME_LIMIT', 'Native history request exceeds its bound.')); return;
    }
    child.stdin.write(wire);
  };
  const protocolError = () => finish(new CodexClientError('PROTOCOL', 'Invalid public native history response.', true));
  child.on('error', () => finish(new CodexClientError('PROCESS_START', 'Native history process could not start.')));
  child.on('exit', () => { if (!done) finish(new CodexClientError('DISCONNECTED', 'Native history process disconnected.', true)); });
  child.stdin.on('error', () => { if (!done) finish(new CodexClientError('IO', 'Native history input disconnected.', true)); });
  child.stdout.on('error', protocolError); child.stderr.on('error', protocolError);
  child.stderr.on('data', (chunk: Buffer) => {
    if (done) return;
    stderrBytes += chunk.length; bytes += chunk.length;
    if (stderrBytes > bounds.maxStderrBytes || bytes > bounds.maxOutputBytes) finish(new CodexClientError('OUTPUT_LIMIT', 'Native history diagnostics exceeded their bound.', true));
  });
  child.stdout.on('data', (chunk: Buffer) => {
    if (done) return;
    bytes += chunk.length;
    if (bytes > bounds.maxOutputBytes) { finish(new CodexClientError('OUTPUT_LIMIT', 'Native history output exceeded its bound.', true)); return; }
    try {
      let offset = 0;
      while (offset < chunk.length && !done) {
        const newline = chunk.indexOf(10, offset), end = newline < 0 ? chunk.length : newline;
        const part = chunk.subarray(offset, end);
        if (used + part.length > bounds.maxFrameBytes) { finish(new CodexClientError('FRAME_LIMIT', 'Native history frame exceeded its bound.', true)); return; }
        part.copy(frame, used); used += part.length; offset = end + 1;
        if (newline < 0) break;
        const text = new TextDecoder('utf-8', { fatal: true }).decode(frame.subarray(0, used)); used = 0;
        if (!text.trim()) continue;
        const message = object(JSON.parse(text));
        if (typeof message.method === 'string') {
          if (Object.hasOwn(message, 'id')) {
            if (++serverRequests > bounds.maxServerRequests) { finish(new CodexClientError('OUTPUT_LIMIT', 'Native history callbacks exceeded their bound.', true)); return; }
            if ((typeof message.id !== 'string' || Buffer.byteLength(message.id) > 256) && !Number.isSafeInteger(message.id)) { protocolError(); return; }
            // No approval, tool execution or account callback can be accepted by a read.
            send({ id: message.id, error: { code: -32601, message: 'Unsupported by the history reader.' } });
          }
          continue;
        }
        if (message.id !== stage || Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error')) { protocolError(); return; }
        if (Object.hasOwn(message, 'error')) { finish(new CodexClientError('REMOTE_REJECTED', 'Native history read was refused.', true)); return; }
        if (phase === 'initialize') {
          object(message.result); phase = 'metadata';
          send({ method: 'initialized', params: {} });
          request('thread/read', { threadId: scope.threadId, includeTurns: false });
        } else if (phase === 'metadata') {
          metadata = message.result;
          const mode = codexThreadHistoryMode(metadata, scope);
          // A scope, mode or persistence refusal is final; no content is requested.
          if (typeof mode !== 'string') { finish(null, mode); return; }
          if (mode === 'legacy') { phase = 'legacy'; request('thread/read', { threadId: scope.threadId, includeTurns: true }); }
          else { phase = 'pages'; nextPage(null); }
        } else if (phase === 'legacy') finish(null, parseCodexThreadRead(message.result, scope));
        else {
          pages.push(message.result);
          const progress = codexTurnsPageProgress(message.result);
          if (progress) pagedTurns += progress.turns;
          // Bounded enumeration: an unresolved cursor at the page/turn cap is reported as incomplete, never complete.
          if (progress && progress.nextCursor !== null && pages.length < CODEX_HISTORY_MAX_PAGES && pagedTurns <= NATIVE_HISTORY_LIMITS.maxTurns) nextPage(progress.nextCursor);
          else finish(null, parseCodexPaginatedHistory(metadata, pages, scope));
        }
      }
    } catch { protocolError(); }
  });
  send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'arcane_history_reader', title: 'Arcane History', version: '0.1.0' }, capabilities: { experimentalApi: false } } });
  return { promise, stop: () => finish(new CodexClientError('STALE_CONNECTION', 'Native history read was cancelled.', true)) };
}

/** Internal construction seam. The public index exposes only the installed-CLI factory. */
/** Host callback returning text appended after the fixed task instructions (project memory). Never imports host modules. */
export type ProjectInstructions = (cwd: string) => Promise<string> | string;
const PROJECT_INSTRUCTIONS_MAX_CHARS = 64 * 1024;

export class CodexSession {
  #connectionId = randomUUID();
  #historyRead: ReturnType<typeof readHistoryProcess> | null = null;
  #processSpec: InternalProcess;
  #transport: JsonlTransport;
  readonly #ownedCloseRequestErrors = new WeakSet<object>();
  #ready = false;
  #initializing = false;
  #account: Account | null = null;
  #accountIdentity: string | null = null;
  #models: Model[] = [];
  #selection: Selection | null = null;
  #thread: ThreadState | null = null;
  #threadAcknowledgement: Readonly<{ threadId: string; sessionId: string | null }> | null = null;
  #threadSessionObserved = false;
  #operations: Operation[] = [];
  #approvals = new Map<string, PendingApproval>();
  #serverIds = new Set<string>();
  #fileProposals = new Map<string, { turnId: string; changes: FileChangePreview[]; bytes: number }>();
  #events: { value: SessionEvent; bytes: number }[] = [];
  #eventBytes = 0;
  #droppedEvents = 0;
  #lastEventSeq = 0;
  #usage: TokenUsageReport | undefined;
  #rateLimits: NativeRateLimits | undefined;
  #rateLimitsReading = false;
  #rateLimitsRevision = 0;
  #cwd: string;
  #mcpIsolated=false;
  #turnPreflight: TurnPreflight | null = null;
  #accountRevision = 0;
  #accountReads = 0;
  #failureCode: string | null = null;
  #threadOperation: Operation | null = null;
  #turnOperation: Operation | null = null;
  #steerOperation: Operation | null = null;
  #steerMessageIds = new Set<string>();
  #automaticWriteOperation: Operation | null = null;
  #automaticWriteStarts = new WeakSet<Operation>();
  #taskContinuation: { token: NativeTaskContinuation; thread: ThreadState; operation: Operation;
    selection: Selection; accountRevision: number; accountIdentity:string; allowWrites: boolean; used: boolean; revoked: boolean } | null = null;
  #incorporation: IncorporationChain | null = null;
  readonly #incorporationOpened = new WeakSet<NativeTaskContinuation>();
  #managedStarting = false;
  #catalogueLoading = false;
  #cancelledTurnId: string | null = null;
  #knownTurnIds = new Set<string>();
  #nativeAssetHooks: NativeAssetHooks | undefined;
  #assetIntent: { operation: Operation; scope: NativeAssetIntent } | null = null;
  #assetsRetired = false;
  readonly #projectInstructions: ProjectInstructions | undefined;
  constructor(spec: InternalProcess, private readonly bounds: Limits, private readonly provenance: Snapshot['provenance'], private readonly mcpPolicy: 'native-config'|'arcane-only'|'proposal' = 'native-config', hooks?: NativeAssetHooks, private readonly proposalOwner?:()=>void, projectInstructions?: ProjectInstructions) {
    if (projectInstructions !== undefined && typeof projectInstructions !== 'function') fail('ARGUMENTS', 'Project instructions must be a host callback.');
    this.#projectInstructions = projectInstructions;
    if(mcpPolicy==='proposal'&&typeof proposalOwner!=='function')fail('PARENT_SCOPE','Proposal workers require an original-task owner.');
    if (hooks !== undefined) {
      this.#nativeAssetHooks = validateNativeAssetHooks(hooks);
      if (mcpPolicy !== 'arcane-only') fail('MCP_PROFILE', 'Native asset hooks require Arcane isolation.');
      // Only validated host hooks select the final child's native surface. The
      // discovery/history specs and sessions without hooks keep their inventory.
      const toolKey = 'mcp_servers.arcane.enabled_tools=';
      spec = { ...spec, args: spec.args.map((arg, index) => spec.args[index - 1] === '-c' && arg.startsWith(toolKey)
        ? toolKey + JSON.stringify(ARCANE_NATIVE_TOOL_NAMES) : arg) };
    }
    this.#cwd = spec.cwd;
    this.#processSpec = { ...spec, args: [...spec.args], env: { ...spec.env } };
    this.#transport = new JsonlTransport(spec, bounds, message => this.#message(message), error => this.#disconnect(error));
  }
  async initialize(): Promise<void> {
    if (this.#ready || this.#initializing) fail('STATE', 'Initialize once per connection.');
    this.#initializing = true;
    try {
      await this.#transport.request('initialize', {
        clientInfo: { name: 'arcane_personal_local', title: 'Arcane Local', version: '0.1.0' },
        capabilities: { experimentalApi: false },
      });
      this.#transport.initialized();
      const initialRevision = this.#accountRevision;
      await Promise.all([this.#readAccount(), this.#listModels()]);
      let stableAccount = this.#accountRevision === initialRevision + 2 && this.#account !== null;
      // Startup account announcements are normal before any thread/authority
      // exists. Reconcile METADATA only, bounded to two extra complete reads.
      for (let attempt = 0; !stableAccount && attempt < 2; attempt++) {
        const revision = this.#accountRevision;
        await this.#readAccount();
        stableAccount = this.#accountRevision === revision + 2 && this.#account !== null;
      }
      if (!stableAccount) fail('ACCOUNT_CHANGED', 'Native account metadata did not stabilize during initialization.');
      if (!this.#transport.connected) fail('DISCONNECTED', 'Native CLI is disconnected.');
      if (this.#assetsRetired) fail('ACCOUNT_CHANGED', 'Native asset authority retired during initialization.');
      this.#ready = true;
    } catch (error) {
      this.#transport.stop(error instanceof CodexClientError ? error : new CodexClientError('PROTOCOL', 'Initialization failed.'));
      await this.#transport.close();
      throw error;
    }
  }
  /** Bounded native MCP inventory only; does not execute a tool, login, or expose endpoints/auth material. */
  async inspectMcpServers(action: HumanAction & {threadId?:string}): Promise<McpInventoryRow[]> {
    exact(action,['initiatedBy','threadId']);human({initiatedBy:action.initiatedBy});this.#ensureReady();
    const threadId=action.threadId===undefined?undefined:str(action.threadId),thread=this.#thread;
    return this.#inspectMcpServers(threadId,()=>{
      this.#ensureReady();
      if(threadId!==undefined&&(this.#thread!==thread||thread?.threadId!==threadId))fail('STATE','Inspect only the exact current native thread.');
    });
  }
  async #inspectMcpServers(threadId: string | undefined, check: () => void): Promise<McpInventoryRow[]> {
    const rows: McpInventoryRow[] = [];
    const cursors = new Set<string>(), names = new Set<string>();
    let cursor: string | null = null, totalTools = 0;
    try {
      for (let page = 0; page < 8; page++) {
        check();
        const response = await this.#transport.request('mcpServerStatus/list', { cursor, limit: 4, detail: 'toolsAndAuthOnly', ...(threadId === undefined ? {} : { threadId }) });
        check();
        const result = object(response);
        if (this.mcpPolicy !== 'native-config' && !Object.hasOwn(result, 'nextCursor')) fail('MCP_INVENTORY', 'Native MCP inventory lacks pagination metadata.');
        if (!Array.isArray(result.data) || result.data.length > 4) fail('MCP_INVENTORY', 'Native MCP inventory exceeds its page bound.');
        for (const value of result.data) {
          const raw = object(value), name = str(raw.name, 256);
          if (names.has(name) || rows.length >= 64) fail('MCP_INVENTORY', 'Duplicate or excessive native MCP servers.');
          names.add(name);
          if (this.mcpPolicy !== 'native-config' &&
              (!['runtimeStatus','pluginId','toolsError'].every(key => Object.hasOwn(raw, key)) || raw.toolsError !== null && typeof raw.toolsError !== 'string')) {
            fail('MCP_INVENTORY', 'Native MCP inventory lacks valid isolation metadata.');
          }
          const runtimeStatus = raw.runtimeStatus == null ? null : str(raw.runtimeStatus, 64);
          if (runtimeStatus !== null && !['notStarted','starting','connected','authenticationRequired','failed','cancelled','disabled'].includes(runtimeStatus)) fail('MCP_INVENTORY', 'Unknown native MCP runtime status.');
          const tools = object(raw.tools), toolNames = Object.keys(tools);
          totalTools += toolNames.length;
          if (totalTools > 2048) fail('MCP_INVENTORY', 'Native MCP tool names exceed their bound.');
          for (const tool of toolNames) {
            str(tool, 256);
            if (this.mcpPolicy !== 'native-config') object(tools[tool]);
          }
          rows.push({ name, runtimeStatus, toolNames, toolsError: raw.toolsError != null, plugin: raw.pluginId != null, pluginId: raw.pluginId == null ? null : str(raw.pluginId, 256) });
        }
        if (result.nextCursor == null) return rows;
        cursor = str(result.nextCursor, 1024);
        if (cursors.has(cursor)) fail('MCP_INVENTORY', 'Native MCP inventory pagination repeated.');
        cursors.add(cursor);
      }
      fail('MCP_INVENTORY', 'Native MCP inventory pagination exceeds its bound.');
    } catch (error) {
      if (error instanceof CodexClientError && error.code === 'ARGUMENTS') fail('MCP_INVENTORY', 'Malformed native MCP inventory.');
      throw error;
    }
  }
  snapshot(): Snapshot {
    // Defensive copies: the host cannot grant writes or mutate approval scope by editing metadata.
    return structuredClone({
      connectionId: this.#connectionId, provenance: this.provenance,
      mcpIsolation:this.mcpPolicy==='native-config'?'native-config':this.mcpPolicy==='proposal'?(this.#mcpIsolated?'proposal-verified':'proposal-pending'):this.#mcpIsolated?'arcane-only-verified':'arcane-only-pending',
      connected: this.#transport.connected, ready: this.#ready && this.#transport.connected,
      account: this.#account, models: this.#models, selection: this.#selection, thread: this.#thread,
      operations: this.#operations, approvals: [...this.#approvals.values()].map(entry => ({ ...entry.value, canAccept: this.#canAccept(entry) })),
      events: this.#events.map(entry => entry.value), droppedEvents: this.#droppedEvents, lastEventSeq: this.#lastEventSeq, failureCode: this.#failureCode,
      ...(this.#usage ? { usage: this.#usage } : {}),
      ...(this.#rateLimits ? { rateLimits: this.#rateLimits } : {}),
    });
  }
  async readAccount(): Promise<Account> {
    this.#ensureReady();
    try { return await this.#readAccount(); }
    catch (error) {
      const automatic = this.#endAutomaticWrites();
      this.#retireNativeAssets();
      this.#account = null;
      this.#accountIdentity = null;
      this.#rateLimits = undefined;
      if (this.#thread) this.#thread.writeGranted = false;
      this.#clearApprovals('cancel');
      if (automatic) this.#transport.stop(new CodexClientError('ACCOUNT_CHANGED', 'Account verification failed during a writable turn.'));
      throw error;
    }
  }
  /** Host-only reported identity comparison; never part of snapshots or prompts. */
  taskAccountIdentity(): string | null { return this.#account?.auth === 'subscription' ? this.#accountIdentity : null; }
  /** Explicit read only; no inference, earned-reset redemption, email or model fallback. */
  async readRateLimits(action: HumanAction): Promise<NativeRateLimits> {
    exact(action, ['initiatedBy']); human(action); this.#ensureSubscription();
    if (this.#rateLimitsReading || this.#accountReads) fail('BUSY', 'An account usage read is already pending.');
    this.#rateLimitsReading = true;
    const accountRevision = this.#accountRevision, revision = this.#rateLimitsRevision;
    try {
      const raw = await this.#transport.request('account/rateLimits/read', { supportsLunaReserve: false, excludeResetCreditDetails: true });
      if (!this.#transport.connected || !this.#ready || this.#accountRevision !== accountRevision || this.#account?.auth !== 'subscription')
        fail('ACCOUNT_CHANGED', 'Account usage changed ownership while the read was pending.');
      const parsed = parseNativeRateLimits(raw, Date.now());
      if (!parsed) fail('RATE_LIMITS_UNAVAILABLE', 'The native usage snapshot is unavailable or unsupported.');
      // A rolling update received after dispatch is newer than this full read's unknown sampling time.
      if (this.#rateLimitsRevision !== revision) fail('RATE_LIMITS_CHANGED', 'Usage changed during refresh. The newer observation is retained.');
      this.#rateLimits = parsed; this.#rateLimitsRevision++;
      return structuredClone(parsed);
    } finally { this.#rateLimitsReading = false; }
  }
  async listModels(): Promise<Model[]> { this.#ensureReady(); await this.#listModels(); return structuredClone(this.#models); }
  selectModel(action: HumanAction & Selection): Selection {
    this.#ensureReady();
    exact(action, ['initiatedBy','model','effort']); human({ initiatedBy: action.initiatedBy });
    if (this.#turnPreflight || this.#threadOperation || this.#turnOperation || this.#operations.some(operation => operation.state === 'pending' || operation.state === 'unknown')) {
      fail('STATE', 'Reconcile the native lifecycle before changing its model or effort.');
    }
    const thread = this.#thread;
    if (thread && (!thread.configured || !['idle','completed','failed','interrupted'].includes(thread.turnStatus))) {
      fail('STATE', 'Change model or effort only on an idle or terminal configured thread.');
    }
    const pair = { model: str(action.model), effort: str(action.effort, 64) };
    this.#validatePair(pair); // Also fences catalogue refreshes, including a same-pair action.
    this.revokeTaskContinuation();
    if (this.#selection?.model === pair.model && this.#selection.effort === pair.effort &&
        (!thread || thread.selection.model === pair.model && thread.selection.effort === pair.effort)) return structuredClone(pair);
    if (thread) {
      this.#endAutomaticWrites();
      thread.writeGranted = false;
      // Only stale, non-active previews can remain here. Invalidate locally without an RPC.
      this.#clearApprovals(null);
      thread.selection = { ...pair };
    }
    this.#selection = { ...pair };
    return structuredClone(pair);
  }
  async startThread(action: HumanAction): Promise<ThreadState> {
    human(action); return this.#openThread(null);
  }
  async resumeThread(action: HumanAction & { threadId: string }): Promise<ThreadState> {
    exact(action, ['initiatedBy','threadId']); human({ initiatedBy: action.initiatedBy });
    return this.#openThread(str(action.threadId));
  }
  /** Trusted host-code seam; public history checks human/live/exact scope before consulting it. */
  protected historyProcessSpec(): InternalProcess { return this.#processSpec; }
  /** Host supplies the durable binding; this read never adopts/resumes a thread or selects a model. */
  async readThreadHistory(action: HumanAction & { threadId: string; sessionId?: string }): Promise<NativeHistoryResult> {
    exact(action, ['initiatedBy','threadId','sessionId']); human({ initiatedBy: action.initiatedBy }); this.#ensureReady();
    const threadId = str(action.threadId), sessionId = action.sessionId === undefined ? undefined : str(action.sessionId);
    for (const id of [threadId, sessionId]) if (id !== undefined && (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(id) || redactNativeHistoryText(id) !== id)) fail('ARGUMENTS', 'Invalid native history identity.');
    if (this.#thread && (this.#thread.threadId !== threadId || (sessionId !== undefined && this.#thread.sessionId !== sessionId))) fail('THREAD', 'Read only the exact current native thread.');
    if (this.#historyRead || this.#turnPreflight || this.#threadOperation || this.#turnOperation) fail('BUSY', 'A native request is already pending.');
    const read = readHistoryProcess(this.historyProcessSpec(), this.bounds, { threadId, cwd: this.#cwd, includeTurns: true, ...(sessionId === undefined ? {} : { sessionId }) });
    this.#historyRead = read;
    try {
      const result = await read.promise;
      this.#ensureReady();
      if (this.#thread && this.#thread.threadId !== threadId) fail('THREAD', 'Native thread changed during history read.');
      return result;
    } finally { if (this.#historyRead === read) this.#historyRead = null; }
  }
  grantThreadWrites(action: HumanAction & { threadId: string }): ThreadState {
    if(this.mcpPolicy==='proposal')fail('PROPOSAL_READ_ONLY','Proposal workers cannot receive write grants.');
    exact(action, ['initiatedBy','threadId']); human({ initiatedBy: action.initiatedBy });
    const thread = this.#requireThread(action.threadId);
    if (this.#turnPreflight) fail('STATE', 'Wait for the current turn isolation check before granting writes.');
    if (thread.turnStatus === 'cancelling' || thread.turnStatus === 'unknown' || thread.turnStatus === 'starting') fail('STATE', 'Writes cannot be granted during an uncertain lifecycle.');
    // An explicit thread grant may promote an active one-turn permission.
    this.#automaticWriteOperation = null;
    thread.writeGranted = true;
    return structuredClone(thread);
  }
  revokeThreadWrites(action: HumanAction & { threadId: string }): void {
    exact(action, ['initiatedBy','threadId']); human({ initiatedBy: action.initiatedBy });
    const thread = this.#requireThread(action.threadId, false);
    this.revokeTaskContinuation();
    if (this.#turnPreflight?.thread === thread) this.#turnPreflight.revoked = true;
    this.#endAutomaticWrites();
    thread.writeGranted = false;
    this.#clearApprovals('cancel');
    // Stop the active turn as well: a sandbox already sent on turn/start cannot be downgraded locally.
    if (thread.turnStatus === 'inProgress' || thread.turnStatus === 'starting') {
      this.#transport.stop(new CodexClientError('GRANT_REVOKED', 'Write grant revoked during an active turn; explicit recovery is required.'));
    }
  }
  #humanTurn(action: HumanAction & { threadId: string; text: string; allowWorkspaceWrites?: boolean; references?:readonly ReferenceImage[] }) {
    exact(action, ['initiatedBy','threadId','text','allowWorkspaceWrites','references']); human({ initiatedBy: action.initiatedBy });
    if (Object.hasOwn(action, 'allowWorkspaceWrites') && typeof action.allowWorkspaceWrites !== 'boolean') fail('ARGUMENTS', 'Send workspace permission must be a boolean.');
    const references=action.references===undefined?undefined:snapshotReferenceImages(action.references);
    return { threadId: str(action.threadId), text: str(action.text, this.bounds.maxInputBytes), allowWorkspaceWrites: action.allowWorkspaceWrites === true,...(references?{references}:{}) };
  }
  async startTurn(action: HumanAction & { threadId: string; text: string; allowWorkspaceWrites?: boolean; references?:readonly ReferenceImage[] }): Promise<ThreadState> {
    const input = this.#humanTurn(action);this.#requireThread(input.threadId);
    if(this.#managedStarting)fail('BUSY','A managed start is already awaiting its acknowledgement.');
    this.revokeTaskContinuation();
    return this.#startTurn(input, false);
  }
  async startManagedTask(action: HumanAction & { threadId: string; text: string; allowWorkspaceWrites?: boolean; references?:readonly ReferenceImage[] }): Promise<ManagedTaskStart> {
    const input = this.#humanTurn(action);this.#requireThread(input.threadId);
    if(this.#managedStarting)fail('BUSY','A managed start is already awaiting its acknowledgement.');
    this.revokeTaskContinuation();
    if (this.mcpPolicy !== 'arcane-only' || !this.#nativeAssetHooks) fail('MCP_PROFILE', 'Managed tasks require an owned isolated MCP incarnation.');
    if(!this.#accountIdentity)fail('ACCOUNT_IDENTITY','Managed continuation requires a reported native subscription identity.');
    this.#managedStarting = true;
    try {
      const thread = await this.#startTurn(input, true);
      if (!this.#taskContinuation) throw new CodexClientError('TASK_SCOPE', 'The managed task continuation was not established.', true);
      return { thread, continuation: this.#taskContinuation.token };
    } finally { this.#managedStarting = false; }
  }
  /** Private application port, never a human action or provider/MCP parameter. */
  async continueTask(action: { continuation: NativeTaskContinuation; text: string }): Promise<ThreadState> {
    exact(action, ['continuation','text']);
    const permit = this.#taskContinuation;
    if (!permit || action.continuation !== permit.token || permit.used || permit.revoked) fail('TASK_SCOPE', 'Task continuation is unavailable.');
    const thread = this.#requireThread(permit.thread.threadId);
    if (thread !== permit.thread || permit.operation.state !== 'acknowledged' ||
        !['completed','failed'].includes(thread.turnStatus) || this.#accountRevision !== permit.accountRevision || this.#accountIdentity!==permit.accountIdentity ||
        thread.selection.model !== permit.selection.model || thread.selection.effort !== permit.selection.effort ||
        this.#selection?.model !== permit.selection.model || this.#selection.effort !== permit.selection.effort ||
        !permit.allowWrites && thread.writeGranted) fail('TASK_SCOPE', 'The original task identity, policy or terminal operation changed.');
    const text = str(action.text, this.bounds.maxInputBytes);
    if (this.#incorporation?.inFlight) fail('BUSY', 'An incorporation turn is still being dispatched.');
    permit.used = true; // Reserve before asynchronous preflight; uncertain starts are never retried.
    this.#revokeIncorporation(); // Repair ends incorporation continuity; incorporation never spends repair.
    return this.#startTurn({ threadId: thread.threadId, text, allowWorkspaceWrites: permit.allowWrites }, false);
  }
  /** Open the one bounded incorporation chain for this exact live managed task. It does not spend repair. */
  openIncorporationChain(action: { continuation: NativeTaskContinuation; maxSteps: number }): NativeIncorporationChain {
    const input = ownData(action, ['continuation','maxSteps']), repair = this.#taskContinuation;
    if (this.mcpPolicy !== 'arcane-only' || !repair || input.continuation !== repair.token || repair.used || repair.revoked || this.#incorporationOpened.has(repair.token))
      fail('TASK_SCOPE', 'Incorporation requires the exact live managed task continuation.');
    const maxSteps = input.maxSteps;
    if (typeof maxSteps !== 'number' || !Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > INCORPORATION_MAX_STEPS) fail('ARGUMENTS', 'Incorporation steps must be 1..3.');
    this.#incorporationOpened.add(repair.token);
    const chain: NativeIncorporationChain = Object.freeze({ kind: 'native-incorporation-chain' });
    this.#revokeIncorporation();
    this.#incorporation = { chain, continuation: repair.token, thread: repair.thread, sessionId: repair.thread.sessionId, selection: { ...repair.selection },
      accountRevision: repair.accountRevision, accountIdentity: repair.accountIdentity, allowWrites: repair.allowWrites, maxSteps,
      issued: 0, last: repair.operation, permit: null, inFlight: false, revoked: false };
    return chain;
  }
  /** Issue exactly the next single-use step after the previous owned turn is acknowledged and terminal. */
  issueIncorporationPermit(action: { chain: NativeIncorporationChain }): NativeIncorporationPermit {
    const input = ownData(action, ['chain']), state = this.#incorporation;
    if (!state || input.chain !== state.chain || state.revoked || state.inFlight || state.permit && !state.permit.used || state.issued >= state.maxSteps)
      fail('TASK_SCOPE', 'No incorporation step is available.');
    this.#checkIncorporation(state);
    const token: NativeIncorporationPermit = Object.freeze({ kind: 'native-incorporation-permit' });
    state.issued++; state.permit = { token, step: state.issued, used: false };
    return token;
  }
  /** Private application port. The permit is consumed before asynchronous preflight and is never replayed. */
  async continueIncorporation(action: { chain: NativeIncorporationChain; permit: NativeIncorporationPermit; text: string }): Promise<ThreadState> {
    const input = ownData(action, ['chain','permit','text']), state = this.#incorporation, record = state?.permit;
    if (!state || input.chain !== state.chain || state.revoked || state.inFlight || !record || input.permit !== record.token || record.used || record.step !== state.issued)
      fail('TASK_SCOPE', 'Incorporation permit is unavailable.');
    const text = str(input.text, this.bounds.maxInputBytes);
    this.#checkIncorporation(state);
    record.used = true; state.inFlight = true;
    try { return await this.#startTurn({ threadId: state.thread.threadId, text, allowWorkspaceWrites: state.allowWrites }, false, state); }
    catch (error) { state.revoked = true; throw error; } // Refused or uncertain: fence the whole chain; no replacement step.
    finally { state.inFlight = false; }
  }
  #checkIncorporation(state: IncorporationChain): void {
    const repair = this.#taskContinuation;
    if (!repair || repair.token !== state.continuation || repair.revoked || repair.used) fail('TASK_SCOPE', 'The original task continuation is unavailable.');
    const thread = this.#requireThread(state.thread.threadId), last = state.last;
    if (this.#managedStarting || thread !== state.thread || this.#thread !== thread || thread.sessionId !== state.sessionId ||
        last.method !== 'turn/start' || last.state !== 'acknowledged' || !last.turnId || thread.turnId !== last.turnId || !['completed','failed'].includes(thread.turnStatus) ||
        this.#accountReads || this.#accountRevision !== state.accountRevision || this.#accountIdentity !== state.accountIdentity ||
        thread.selection.model !== state.selection.model || thread.selection.effort !== state.selection.effort ||
        this.#selection?.model !== state.selection.model || this.#selection.effort !== state.selection.effort ||
        !state.allowWrites && thread.writeGranted || this.#turnPreflight || this.#turnOperation || this.#threadOperation ||
        this.#operations.some(operation => operation.state === 'pending' || operation.state === 'unknown'))
      fail('TASK_SCOPE', 'The original task identity, policy or terminal operation changed.');
  }
  #revokeIncorporation(): void {
    const state = this.#incorporation;
    if (!state || state.revoked) return;
    state.revoked = true;
    if (state.inFlight && this.#turnPreflight) this.#turnPreflight.revoked = true;
  }
  revokeTaskContinuation(): void {
    this.#revokeIncorporation(); // Works even after repair was spent or revoked.
    if (this.#managedStarting && this.#turnPreflight) this.#turnPreflight.revoked = true;
    if (!this.#taskContinuation || this.#taskContinuation.revoked) return;
    this.#taskContinuation.revoked = true;
    if (this.#turnPreflight) this.#turnPreflight.revoked = true;
  }
  async #startTurn(action: { threadId: string; text: string; allowWorkspaceWrites: boolean; references?:readonly ReferenceImage[] }, managed: boolean, incorporation?: IncorporationChain): Promise<ThreadState> {
    const allowWorkspaceWrites = action.allowWorkspaceWrites === true;
    if(this.mcpPolicy==='proposal'&&(allowWorkspaceWrites||this.#operations.some(operation=>operation.method==='turn/start')))
      fail('PROPOSAL_READ_ONLY','Proposal workers permit one read-only turn and no automatic replay.');
    const thread = this.#requireThread(action.threadId);
    if (this.#turnPreflight || this.#threadOperation || this.#turnOperation || this.#operations.some(operation => operation.state === 'pending' || operation.state === 'unknown') ||
        !['idle','completed','failed','interrupted'].includes(thread.turnStatus)) fail('BUSY', 'The previous turn must be reconciled before starting another.');
    const text = str(action.text, this.bounds.maxInputBytes);
    this.#validatePair(thread.selection);
    if (this.mcpPolicy !== 'native-config') {
      const preflight: TurnPreflight = { thread, selection: { ...thread.selection }, accountRevision: this.#accountRevision,
        turnId: thread.turnId, turnStatus: thread.turnStatus, revoked: false };
      // Reserve the entire asynchronous check without inventing a turn or an operation ID.
      this.#turnPreflight = preflight; this.#mcpIsolated = false;
      try {
        this.#clearApprovals('cancel');
        const rows = await this.#inspectMcpServers(thread.threadId, () => this.#checkTurnPreflight(preflight));
        this.#checkTurnPreflight(preflight);
        if(this.mcpPolicy==='proposal') {
          if(!proposalThreadIsIsolated(rows))fail('MCP_ISOLATION','The proposal worker exposes an effective MCP server. No turn was sent.');
        } else {
          if (!arcaneThreadIsIsolated(rows)) fail('MCP_ISOLATION', 'The current native thread is not isolated to Arcane. No turn was sent.');
          requireArcaneBuildTools(rows, this.#nativeAssetHooks !== undefined);
        }
        this.#mcpIsolated = true;
      } catch (error) {
        this.#invalidateIsolation(error);
        // A dispatched metadata request is not a dispatched turn. The host persists this distinction.
        const refused = error instanceof CodexClientError
          ? new CodexClientError(error.code, error.message, false, error.remoteCode)
          : new CodexClientError('MCP_ISOLATION', 'Native isolation could not be verified. No turn was sent.');
        // Preserve provenance only across this exact host-created projection.
        if (this.#transport.isOwnedCloseRequestError(error)) this.#ownedCloseRequestErrors.add(refused);
        throw refused;
      }
      finally { this.#turnPreflight = null; }
    }
    // The fresh, acknowledged catalogue belongs to this exact native client.
    // Older catalogues use the vendor-documented text/image compatibility default.
    const references=action.references;
    if(references?.length){const model=this.#models.find(m=>m.model===thread.selection.model);
      if(!model||model.inputModalities&&!model.inputModalities.includes('image'))fail('IMAGE_UNSUPPORTED','The selected native model does not advertise image input.');}
    // The pinned TurnStartParams has no per-turn developer note, so per-turn UI state (the Playtest switch) is never
    // appended to the user's text; it applies only as host-side automatic approval of playtest requests.
    const params={threadId:thread.threadId,input:[{type:'text',text,text_elements:[]},...(references?.map(image=>({type:'image',url:image.dataUrl}))??[])],
      cwd:this.#cwd,model:thread.selection.model,effort:thread.selection.effort,approvalPolicy:this.mcpPolicy==='proposal'?'never':'on-request',approvalsReviewer:'user',
      sandboxPolicy:allowWorkspaceWrites||thread.writeGranted
        ?{type:'workspaceWrite',writableRoots:[this.#cwd],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true}
        :{type:'readOnly',networkAccess:false}};
    // Include the complete UTF-8 envelope before allocating an operation/grant.
    if(references?.length&&Buffer.byteLength(JSON.stringify({id:Number.MAX_SAFE_INTEGER,method:'turn/start',params})+'\n')>this.bounds.maxFrameBytes)
      fail('FRAME_LIMIT','The complete native message and references exceed the frame limit. Reduce the message or images.');
    if (incorporation?.revoked) fail('GRANT_REVOKED', 'The incorporation chain was revoked before dispatch. No turn was sent.');
    if (incorporation) this.#checkIncorporation(incorporation);
    const operation = this.#newOperation('turn/start', thread.threadId, null);
    if (incorporation) incorporation.last = operation; // Continuity is only this exact owned operation.
    if (managed) this.#taskContinuation = { token: Object.freeze({ kind: 'native-task-continuation' }), thread, operation,
      selection: { ...thread.selection }, accountRevision: this.#accountRevision,
      accountIdentity:this.#accountIdentity!,
      allowWrites: allowWorkspaceWrites || thread.writeGranted, used: false, revoked: false };
    this.#turnOperation = operation;
    this.#cancelledTurnId = null;
    this.#clearApprovals('cancel');
    thread.turnId = null; thread.turnStatus = 'starting';
    delete thread.durationMs;
    // Arm only the actual operation after every asynchronous isolation check.
    // The flag is host intent, never provider metadata or a persistent grant.
    if (allowWorkspaceWrites && !thread.writeGranted) {
      this.#automaticWriteOperation = operation;
      this.#automaticWriteStarts.add(operation);
      thread.writeGranted = true;
    }
    try {
      const result = await this.#requestOperation(operation, params);
      this.#decodeAcknowledgement(() => {
        const turn = object(object(result).turn);
        const turnId = str(turn.id);
        const turnStatus = status(turn.status);
        if (operation.turnId && operation.turnId !== turnId) fail('PROTOCOL', 'Turn acknowledgement changed the observed ID.');
        operation.turnId = turnId; thread.turnId = turnId; this.#knownTurnIds.add(turnId);
        // A late acknowledgement cannot resurrect a completed or cancelled turn.
        if (thread.turnStatus === 'starting' || TERMINAL.has(turnStatus) && thread.turnStatus === 'inProgress') thread.turnStatus = turnStatus;
        if (TERMINAL.has(turnStatus) && usageCount(turn.durationMs, 31_536_000_000)) thread.durationMs = turn.durationMs;
        if (TERMINAL.has(turnStatus)) this.#endAutomaticWrites(operation);
        if (TERMINAL.has(turnStatus) && !this.#endNativeAssetIntent(operation)) {
          throw new CodexClientError('UNKNOWN', 'Native asset completion is uncertain.', true);
        }
        operation.state = 'acknowledged';
      });
      return structuredClone(thread);
    } catch (error) {
      this.#operationFailed(operation, error);
      if (operation.state === 'rejected' || operation.state === 'not-sent') thread.turnStatus = 'idle';
      else if (!TERMINAL.has(thread.turnStatus)) thread.turnStatus = 'unknown';
      throw error;
    } finally { this.#turnOperation = null; }
  }
  async steerTurn(action: SteerTurnAction): Promise<SteerTurnAck> {
    const input=ownData(action,['initiatedBy','threadId','expectedTurnId','text','clientUserMessageId']);
    human({initiatedBy:input.initiatedBy as HumanAction['initiatedBy']});
    if(this.mcpPolicy==='proposal')fail('PROPOSAL_READ_ONLY','Proposal workers cannot steer a parent turn.');
    const thread=this.#requireThread(str(input.threadId)),expectedTurnId=str(input.expectedTurnId),text=str(input.text,this.bounds.maxInputBytes);
    const clientUserMessageId=str(input.clientUserMessageId,36);
    if(!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}(?![\s\S])/.test(clientUserMessageId))fail('ARGUMENTS','A unique steering request UUID is required.');
    if(this.#steerMessageIds.has(clientUserMessageId))fail('STEER_REPLAY','This steering request was already admitted. Inspect its original receipt; do not resend it.');
    if(this.#steerOperation||this.#turnPreflight||this.#threadOperation||this.#turnOperation||
      this.#operations.some(operation=>operation.state==='pending'||operation.state==='unknown'))fail('BUSY','Wait for the original turn acknowledgement and reconcile pending operations before steering.');
    const sessionId=thread.sessionId,selection={...thread.selection},revision=this.#accountRevision,assetIntent=this.#assetIntent;
    const check=()=>{
      const current=this.#requireThread(thread.threadId);
      if(current!==thread||current.sessionId!==sessionId||current.turnId!==expectedTurnId||current.turnStatus!=='inProgress'||
        current.selection.model!==selection.model||current.selection.effort!==selection.effort||this.#accountRevision!==revision||this.#assetIntent!==assetIntent)
        fail('STEER_SCOPE_CHANGED','The exact active turn changed before steering was acknowledged.');
    };
    check();
    const params={threadId:thread.threadId,expectedTurnId,clientUserMessageId,input:[{type:'text',text,text_elements:[]}]};
    if(Buffer.byteLength(JSON.stringify({id:Number.MAX_SAFE_INTEGER,method:'turn/steer',params})+'\n')>this.bounds.maxFrameBytes)
      fail('FRAME_LIMIT','The complete steering message exceeds the native frame limit.');
    if(this.#operations.length>=this.bounds.maxOperations)fail('OPERATION_LIMIT','Steering operation history is full. The original turn remains active; do not replay this request.');
    const operation=this.#newOperation('turn/steer',thread.threadId,expectedTurnId);this.#steerOperation=operation;
    this.#steerMessageIds.add(clientUserMessageId); // At most one per bounded retained operation.
    let responseReceived=false;
    try{
      // Recheck at the synchronous write boundary without opening a new task or
      // asset intent, changing automatic writes, or clearing existing approvals.
      const result=await this.#transport.request('turn/steer',params,id=>{check();operation.requestId=id;});responseReceived=true;
      const ack=ownData(result,['turnId']),turnId=str(ack.turnId);
      if(turnId!==expectedTurnId)fail('PROTOCOL','Steering acknowledgement changed the exact turn ID.');
      check();operation.state='acknowledged';return {turnId};
    }catch(error){
      const raw=error instanceof CodexClientError?error:new CodexClientError('PROTOCOL','Invalid steering acknowledgement.',responseReceived);
      const native=responseReceived?new CodexClientError(raw.code==='ARGUMENTS'?'PROTOCOL':raw.code,'Steering outcome requires review of the retained request.',true,raw.remoteCode):raw;
      operation.errorCode=native.code;
      operation.state=native.code==='REMOTE_REJECTED'?'rejected':native.dispatched||operation.state==='unknown'?'unknown':'not-sent';
      // An uncertain amendment fences later admissions through operation history;
      // it never retires, cancels or regrants the original accepted work.
      throw native;
    }finally{this.#steerOperation=null;}
  }
  async interruptTurn(action: HumanAction & { threadId: string; turnId: string }): Promise<void> {
    exact(action, ['initiatedBy','threadId','turnId']); human({ initiatedBy: action.initiatedBy });
    const thread = this.#requireThread(action.threadId, false);
    if (this.#turnPreflight) fail('STATE', 'No turn has been dispatched during the isolation check.');
    const turnId = str(action.turnId);
    if (thread.turnId !== turnId || !['starting','inProgress'].includes(thread.turnStatus)) fail('STATE', 'Select the exact active turn to interrupt.');
    const operation = this.#newOperation('turn/interrupt', thread.threadId, turnId);
    this.revokeTaskContinuation();
    // Fence first, synchronously, before any write or acknowledgement. Late prompts cannot be accepted.
    this.#cancelledTurnId = turnId; thread.turnStatus = 'cancelling'; thread.writeGranted = false;
    this.#endAutomaticWrites();
    this.#endNativeAssetIntent();
    this.#clearApprovals('cancel');
    try {
      await this.#requestOperation(operation, { threadId: thread.threadId, turnId });
      operation.state = 'acknowledged'; // Cancellation is only complete upon turn/completed.
    } catch (error) {
      this.#operationFailed(operation, error);
      this.#transport.stop(new CodexClientError('INTERRUPT_UNCERTAIN', 'Turn interruption requires explicit reconciliation.'));
      throw error;
    }
  }
  respondApproval(action: HumanAction & { handle: string; connectionId: string; threadId: string; turnId: string; decision: 'accept' | 'decline' | 'cancel' }): void {
    exact(action, ['initiatedBy','handle','connectionId','threadId','turnId','decision']); human({ initiatedBy: action.initiatedBy });
    this.#ensureReady();
    const pending = this.#approvals.get(str(action.handle));
    if (!pending || action.connectionId !== this.#connectionId || action.threadId !== pending.value.threadId || action.turnId !== pending.value.turnId) fail('STALE_APPROVAL', 'Approval does not belong to this connection and active turn.');
    if (!['accept','decline','cancel'].includes(action.decision)) fail('ARGUMENTS', 'Only a single human accept, decline or cancel is supported.');
    if (pending.value.expiresAt <= Date.now() || !this.#scopeActive(pending.value.threadId, pending.value.turnId)) {
      this.#removeApproval(pending, 'cancel');
      fail('STALE_APPROVAL', 'Approval has expired or its turn has ended.');
    }
    if (action.decision === 'accept' && !this.#canAccept(pending)) fail('WRITE_GRANT_REQUIRED', 'Accept requires an explicit thread write grant and an eligible local approval.');
    this.#removeApproval(pending, action.decision);
  }
  /** Private host observation, never a code/message or physical-closure claim. */
  isOwnedCloseRequestError(error: unknown): boolean {
    return this.#transport.isOwnedCloseRequestError(error) ||
      typeof error === 'object' && error !== null && this.#ownedCloseRequestErrors.has(error);
  }
  async close(): Promise<void> {
    this.revokeTaskContinuation();
    this.#retireNativeAssets();
    const read = this.#historyRead; read?.stop();
    const settled=await Promise.allSettled([this.#transport.close(), ...(read ? [read.promise] : [])]);
    const transport=settled[0]!;
    if(transport.status==='rejected')throw transport.reason;
  }
  #ensureReady(): void {
    if (!this.#ready || !this.#transport.connected || this.#assetsRetired) fail('DISCONNECTED', 'A ready local connection is required.');
  }
  #ensureSubscription(): void {
    this.#ensureReady();
    if (this.#account?.auth !== 'subscription' || !this.#account.requiresOpenaiAuth) fail('SUBSCRIPTION_REQUIRED', 'A native ChatGPT subscription account is required; no billing fallback is available.');
  }
  #requireThread(id: string, requireSubscription = true): ThreadState {
    if (requireSubscription) this.#ensureSubscription(); else this.#ensureReady();
    if (!this.#thread || !this.#thread.configured || this.#thread.threadId !== str(id)) fail('THREAD', 'Select this connection’s exact configured thread.');
    return this.#thread;
  }
  #validatePair(pair: Selection): void {
    if (this.#catalogueLoading) fail('BUSY', 'Wait for the current catalogue refresh.');
    const model = this.#models.find(entry => entry.model === pair.model);
    if (!model || !model.efforts.includes(pair.effort)) fail('SELECTION', 'The exact selected model and effort must occur in the current native catalogue.');
  }
  #checkIsolationContext(thread: ThreadState, pair: Selection, accountRevision: number): void {
    this.#ensureSubscription();
    const identity = this.#threadAcknowledgement;
    if (!identity || thread.threadId !== identity.threadId || thread.sessionId !== identity.sessionId) {
      fail('PROTOCOL', 'Native thread acknowledgement identity changed during the isolation check.');
    }
    if (this.#accountReads || this.#accountRevision !== accountRevision || this.#thread !== thread ||
        this.#selection?.model !== pair.model || this.#selection.effort !== pair.effort ||
        thread.selection.model !== pair.model || thread.selection.effort !== pair.effort) {
      fail('STATE', 'Native account, thread or selection changed during the isolation check.');
    }
    this.#validatePair(pair);
  }
  #checkTurnPreflight(preflight: TurnPreflight): void {
    this.#checkIsolationContext(preflight.thread, preflight.selection, preflight.accountRevision);
    if (preflight.revoked) fail('GRANT_REVOKED', 'Write permission was revoked before turn dispatch. No turn was sent.');
    if (this.#turnPreflight !== preflight || !preflight.thread.configured || this.#threadOperation || this.#turnOperation ||
        preflight.thread.turnId !== preflight.turnId || preflight.thread.turnStatus !== preflight.turnStatus ||
        this.#operations.some(operation => operation.state === 'pending' || operation.state === 'unknown')) {
      fail('STATE', 'Native lifecycle changed during the isolation check. No turn was sent.');
    }
  }
  #invalidateIsolation(error: unknown): void {
    this.#retireNativeAssets();
    this.#mcpIsolated = false;
    if (this.#thread) { this.#thread.configured = false; this.#thread.writeGranted = false; }
    // Disconnect clears cached approvals without replaying an uncertain callback delivery.
    this.#transport.stop(error instanceof CodexClientError ? error : new CodexClientError('MCP_ISOLATION', 'Native isolation could not be verified.'));
  }
  async #readAccount(): Promise<Account> {
    this.#accountReads++; this.#accountRevision++;
    try {
      const result = object(await this.#transport.request('account/read', { refreshToken: false }));
      if (!Object.hasOwn(result, 'account') || typeof result.requiresOpenaiAuth !== 'boolean') fail('PROTOCOL', 'Account response lacks provider metadata.');
      const raw = result.account === null ? null : object(result.account);
      const account: Account = {
        auth: raw === null ? 'signed-out' : raw.type === 'chatgpt' ? 'subscription' : 'unsupported',
        plan: raw?.type === 'chatgpt' && typeof raw.planType === 'string' && PLANS.has(raw.planType) ? raw.planType : null,
        requiresOpenaiAuth: result.requiresOpenaiAuth,
      };
      const identity = raw?.type === 'chatgpt' && typeof raw.email === 'string' && raw.email.length > 0 && raw.email.length <= 1024 && !/[\x00-\x1f\x7f]/.test(raw.email)
        ? createHash('sha256').update('codex-reported-account\0'+raw.email).digest('hex') : null;
      if ((this.#ready || this.#thread) && this.#account && (this.#account.auth !== account.auth || this.#account.plan !== account.plan || this.#account.requiresOpenaiAuth !== account.requiresOpenaiAuth || this.#accountIdentity !== identity)) {
        this.#rateLimits = undefined;
        const automatic = this.#endAutomaticWrites();
        this.#retireNativeAssets();
        if (automatic) this.#transport.stop(new CodexClientError('ACCOUNT_CHANGED', 'Account metadata changed during a writable turn.'));
      }
      this.#account = account;
      this.#accountIdentity = identity;
      if (account.auth !== 'subscription' && this.#thread) {
        this.#thread.writeGranted = false; this.#clearApprovals('cancel');
        if (['starting','inProgress','cancelling'].includes(this.#thread.turnStatus)) this.#transport.stop(new CodexClientError('ACCOUNT_CHANGED', 'Subscription authentication changed during an active turn.'));
      }
      return structuredClone(account);
    } finally { this.#accountReads--; this.#accountRevision++; }
  }
  async #listModels(): Promise<void> {
    if (this.#catalogueLoading) fail('BUSY', 'A catalogue refresh is already pending.');
    this.#catalogueLoading = true;
    try {
      const models: Model[] = [];
      const seenCursors = new Set<string>();
      const seenModels = new Set<string>();
      let cursor: string | null = null;
      for (let page = 0; page < this.bounds.maxCatalogPages; page++) {
        const result = object(await this.#transport.request('model/list', { limit: 100, includeHidden: false, ...(cursor === null ? {} : { cursor }) }));
        if (!Array.isArray(result.data) || result.data.length > 100) fail('CATALOGUE', 'Invalid bounded model page.');
        for (const entry of result.data) {
          const raw = object(entry);
          if (raw.hidden === true) continue;
          const model = str(raw.model);
          const id = str(raw.id);
          if (seenModels.has(model)) fail('CATALOGUE', 'Duplicate model ID.');
          if (!Array.isArray(raw.supportedReasoningEfforts) || !raw.supportedReasoningEfforts.length || raw.supportedReasoningEfforts.length > 16) fail('CATALOGUE', 'Invalid reported effort list.');
          const efforts = raw.supportedReasoningEfforts.map(value => str(object(value).reasoningEffort, 64));
          if (new Set(efforts).size !== efforts.length) fail('CATALOGUE', 'Duplicate reported effort.');
          seenModels.add(model);
          const modalities=raw.inputModalities===undefined?['text','image']:raw.inputModalities;
          if(!Array.isArray(modalities)||modalities.length>3||modalities.some(x=>!['text','image','audio'].includes(x))||new Set(modalities).size!==modalities.length)fail('CATALOGUE','Invalid native input modality list.');
          models.push({ model, id, displayName: str(raw.displayName, 256), efforts,
            inputModalities:[...modalities] as ('text'|'image'|'audio')[],inputModalitiesSource:raw.inputModalities===undefined?'compatibility-default':'reported',
            defaultEffort: typeof raw.defaultReasoningEffort === 'string' && efforts.includes(raw.defaultReasoningEffort) ? raw.defaultReasoningEffort : null,
            entitlement: 'unverified' });
          if (models.length > this.bounds.maxModels) fail('CATALOGUE_LIMIT', 'Model catalogue exceeded its bound.');
        }
        if (result.nextCursor == null) { this.#models = models; return; }
        cursor = str(result.nextCursor, 1024);
        if (seenCursors.has(cursor)) fail('CATALOGUE', 'Repeated model cursor.');
        seenCursors.add(cursor);
      }
      fail('CATALOGUE_LIMIT', 'Model pagination exceeded its bound.');
    } catch (error) { this.#models = []; throw error; }
    finally { this.#catalogueLoading = false; }
  }
  /** Bounded host text appended after the task instructions. A failing or malformed callback adds nothing. */
  async #readProjectInstructions(): Promise<string> {
    if (!this.#projectInstructions) return '';
    try {
      const text = await this.#projectInstructions(this.#cwd);
      return typeof text === 'string' && text.length <= PROJECT_INSTRUCTIONS_MAX_CHARS ? text : '';
    } catch { return ''; }
  }
  async #openThread(id: string | null): Promise<ThreadState> {
    if(this.mcpPolicy==='proposal'&&id!==null)fail('PROPOSAL_READ_ONLY','Proposal workers always start a fresh thread.');
    this.#ensureSubscription();
    if (!this.#selection) fail('SELECTION', 'Select an exact model and effort first.');
    this.#validatePair(this.#selection);
    if (this.#thread || this.#threadOperation) fail('STATE', 'This connection already owns a thread lifecycle.');
    if (this.mcpPolicy !== 'native-config' && this.#accountReads) fail('BUSY', 'Wait for the current native account read before opening a thread.');
    const accountRevision = this.#accountRevision;
    const pair = { ...this.#selection };
    const operation = this.#newOperation(id === null ? 'thread/start' : 'thread/resume', id, null);
    this.#threadOperation = operation;
    try {
      // Host-supplied project memory (ARCANE.md) follows the unchanged task instructions; read fresh per thread.
      const projectNotes = this.mcpPolicy === 'arcane-only' ? await this.#readProjectInstructions() : '';
      const result = await this.#requestOperation(operation, {
        // Lifecycle resume needs identity/settings and live status, not a copy
        // of every historic inline image. Explicit history reads stay bounded.
        ...(id === null ? {} : { threadId: id, excludeTurns: true }), model: pair.model, modelProvider: 'openai',
        cwd: this.#cwd, approvalPolicy: this.mcpPolicy==='proposal'?'never':'on-request', approvalsReviewer: 'user', sandbox: 'read-only',
        ...(this.mcpPolicy==='proposal'?{developerInstructions:'Return a bounded code or review proposal from the supplied context. Do not edit files, run commands, access Studio, request permissions, or delegate work. The parent task owns implementation and verification. Your response is a proposal, not evidence of acceptance.'}:{}),
        ...(this.mcpPolicy==='arcane-only' ? { developerInstructions: ARCANE_TASK_INSTRUCTIONS + projectNotes } : {}),
      });
      this.#decodeAcknowledgement(() => {
        const resultObject = object(result);
        const rawThread = object(object(result).thread);
        const threadId = str(rawThread.id);
        if ((id && threadId !== id) || (operation.threadId && operation.threadId !== threadId)) fail('PROTOCOL', 'Thread acknowledgement changed the exact ID.');
        operation.threadId = threadId;
        this.#acknowledgeThread(threadId, pair, optionalText(rawThread.sessionId, 256));
        const sandbox = object(resultObject.sandbox);
        if (resultObject.model !== pair.model || resultObject.modelProvider !== 'openai' || resultObject.approvalPolicy !== (this.mcpPolicy==='proposal'?'never':'on-request') || resultObject.approvalsReviewer !== 'user' || sandbox.type !== 'readOnly' || sandbox.networkAccess !== false || typeof resultObject.cwd !== 'string' || resolve(resultObject.cwd) !== resolve(this.#cwd)) {
          fail('SETTINGS_MISMATCH', 'Native thread settings do not match the requested local policy and model.');
        }
        const thread = this.#thread!;
        if(this.mcpPolicy==='proposal'&&(!Array.isArray(rawThread.turns)||rawThread.turns.length!==0||rawThread.status==null||object(rawThread.status).type!=='idle'))
          fail('SETTINGS_MISMATCH','A proposal worker must acknowledge a fresh idle thread.');
        if (Array.isArray(rawThread.turns)) {
          const active = rawThread.turns.filter(value => object(value).status === 'inProgress');
          if (active.length > 1) fail('PROTOCOL', 'Resume reported multiple active turns.');
          if (active.length) { thread.turnId = str(object(active[0]).id); this.#knownTurnIds.add(thread.turnId); thread.turnStatus = 'inProgress'; }
        }
        if (rawThread.status != null && object(rawThread.status).type === 'active' && thread.turnId === null) thread.turnStatus = 'unknown';
        thread.configured = this.mcpPolicy==='native-config'; operation.state = 'acknowledged';
      });
      const thread = this.#thread!;
      if(this.mcpPolicy!=='native-config') {
        const turnId=thread.turnId,turnStatus=thread.turnStatus;
        const check=()=>{
          this.#checkIsolationContext(thread,pair,accountRevision);
          if(this.#threadOperation!==operation||thread.turnId!==turnId||thread.turnStatus!==turnStatus)fail('STATE','Thread setup changed during the isolation check.');
        };
        try {
          const inventory=await this.#inspectMcpServers(thread.threadId,check);
          check();
          if(this.mcpPolicy==='proposal') {
            if(!proposalThreadIsIsolated(inventory))fail('MCP_ISOLATION','The proposal worker exposes an effective MCP server. No turn can be started.');
          } else {
            if(!arcaneThreadIsIsolated(inventory))fail('MCP_ISOLATION','The native thread exposes an inherited tool server or Arcane is not connected. No turn can be started.');
            requireArcaneBuildTools(inventory, this.#nativeAssetHooks !== undefined);
          }
          this.#mcpIsolated=true;thread.configured=true;
        } catch(error) { this.#invalidateIsolation(error);throw error; }
      }
      return structuredClone(thread);
    } catch (error) {
      this.#operationFailed(operation, error);
      if (operation.state === 'unknown' || this.#thread) this.#transport.stop(new CodexClientError('THREAD_UNCERTAIN', 'Thread setup requires explicit reconciliation.'));
      throw error;
    } finally { this.#threadOperation = null; }
  }
  #acknowledgeThread(id: string, selection: Selection, sessionId: string | null): void {
    const identity = this.#threadAcknowledgement;
    if (this.#thread && this.#thread.threadId !== id || identity && (identity.threadId !== id || identity.sessionId !== sessionId)) {
      fail('PROTOCOL', 'Thread acknowledgement changed identity.');
    }
    const conflict = this.#threadSessionObserved && this.#thread?.sessionId !== sessionId;
    // The decoded ACK is canonical evidence, including null, even when earlier
    // provisional notification evidence conflicts and setup must fail closed.
    this.#thread ??= { threadId: id, sessionId, selection, configured: false, writeGranted: false, turnId: null, turnStatus: 'idle' };
    this.#thread.sessionId = sessionId;
    this.#threadAcknowledgement ??= Object.freeze({ threadId: id, sessionId });
    if (conflict) fail('PROTOCOL', 'Thread notification conflicts with its acknowledgement session.');
  }
  #adoptThread(id: string, selection: Selection, sessionId: string | null, sessionSpecified: boolean): void {
    if (this.#thread && this.#thread.threadId !== id) fail('PROTOCOL', 'Thread notification changed identity.');
    const identity = this.#threadAcknowledgement;
    if (sessionSpecified && (identity ? identity.sessionId !== sessionId : this.#threadSessionObserved && this.#thread?.sessionId !== sessionId)) {
      fail('PROTOCOL', 'Thread notification changed the exact session.');
    }
    this.#thread ??= { threadId: id, sessionId, selection, configured: false, writeGranted: false, turnId: null, turnStatus: 'idle' };
    // Omission makes no session claim. Once acknowledged, notifications never
    // replace or enrich the canonical tuple, even with a later non-null value.
    if (!identity && sessionSpecified) { this.#thread.sessionId = sessionId; this.#threadSessionObserved = true; }
  }
  #newOperation(method: Operation['method'], threadId: string | null, turnId: string | null): Operation {
    if (this.#operations.length >= this.bounds.maxOperations) {
      if (this.#nativeAssetHooks) {
        this.#retireNativeAssets();
        this.#transport.stop(new CodexClientError('OPERATION_LIMIT', 'Operation history exhausted; explicit reconciliation is required.'));
      }
      if (method === 'turn/interrupt') this.#transport.stop(new CodexClientError('OPERATION_LIMIT', 'Operation history exhausted during cancellation; explicit reconciliation is required.'));
      fail('OPERATION_LIMIT', 'Reconnect explicitly after reconciling the bounded operation history.');
    }
    const operation: Operation = { operationId: randomUUID(), method, requestId: null, threadId, turnId, state: 'pending', errorCode: null };
    this.#operations.push(operation); return operation;
  }
  #requestOperation(operation: Operation, params: unknown): Promise<unknown> {
    return this.#transport.request(operation.method, params, id => {
      if(this.mcpPolicy==='proposal'&&operation.method==='turn/start')this.proposalOwner!();
      operation.requestId = id;
    },
      this.#nativeAssetHooks && operation.method === 'turn/start' ? () => this.#dispatchNativeAssetIntent(operation) : undefined);
  }
  #dispatchNativeAssetIntent(operation: Operation): void {
    if (this.#assetsRetired || !this.#transport.connected || !this.#mcpIsolated || !this.#thread?.configured ||
        this.#turnOperation !== operation || this.#thread.threadId !== operation.threadId || this.#assetIntent) {
      fail('STATE', 'Native asset dispatch scope is unavailable.');
    }
    const scope = Object.freeze({ connectionId: this.#connectionId, threadId: this.#thread.threadId, operationId: operation.operationId });
    this.#assetIntent = { operation, scope };
    this.#nativeAssetHooks!.dispatched(scope);
  }
  #endNativeAssetIntent(operation?: Operation): boolean {
    const intent = this.#assetIntent;
    if (!intent || operation && intent.operation !== operation) return true;
    this.#assetIntent = null; // Fence before calling host code, including reentrant close.
    try { this.#nativeAssetHooks!.ended(intent.scope); return true; }
    catch {
      this.#retireNativeAssets();
      this.#transport.stop(new CodexClientError('UNKNOWN', 'Native asset completion is uncertain.', true));
      return false;
    }
  }
  #retireNativeAssets(): void {
    this.revokeTaskContinuation();
    if (!this.#nativeAssetHooks || this.#assetsRetired) return;
    this.#assetsRetired = true;
    this.#ready = false;
    this.#endNativeAssetIntent();
    try { this.#nativeAssetHooks.retired(); } catch { /* Cleanup must continue even if trusted host code fails. */ }
  }
  #decodeAcknowledgement(decode: () => void): void {
    // This boundary runs only after a successful RPC response, never before dispatch.
    // Shared argument validators must not turn malformed native ACKs into safe-to-retry operations.
    try {
      decode();
      if (this.#nativeAssetHooks && !this.#transport.connected) {
        throw new CodexClientError('UNKNOWN', 'Native lifecycle acknowledgement arrived after disconnect.', true);
      }
    }
    catch (error) {
      const code = error instanceof CodexClientError && error.code !== 'ARGUMENTS' ? error.code : 'PROTOCOL';
      throw new CodexClientError(code, 'Invalid native lifecycle acknowledgement.', true);
    }
  }
  #endAutomaticWrites(operation?: Operation): boolean {
    const automatic = this.#automaticWriteOperation;
    if (!automatic || operation && operation !== automatic) return false;
    this.#automaticWriteOperation = null;
    if (this.#thread?.threadId === automatic.threadId) this.#thread.writeGranted = false;
    return true;
  }
  #operationFailed(operation: Operation, error: unknown): void {
    const native = error instanceof CodexClientError ? error : new CodexClientError('PROTOCOL', 'Invalid native response.', true);
    operation.errorCode = native.code;
    const observed = operation.method === 'thread/start' ? operation.threadId !== null : operation.method === 'turn/start' ? operation.turnId !== null : false;
    operation.state = native.code === 'REMOTE_REJECTED' && !observed ? 'rejected' : native.dispatched ? 'unknown' : operation.state === 'unknown' || observed ? 'unknown' : 'not-sent';
    const automatic = this.#automaticWriteStarts.has(operation);
    this.#endAutomaticWrites(operation);
    if (operation.method === 'turn/start') this.#endNativeAssetIntent(operation);
    if ((this.#nativeAssetHooks || automatic) && operation.state === 'unknown') {
      this.#retireNativeAssets(); this.#transport.stop(native);
    }
    if (native.code === 'SETTINGS_MISMATCH' || native.code === 'PROTOCOL') {
      operation.state = 'unknown'; this.#transport.stop(native);
    }
  }
  #disconnect(error: CodexClientError): void {
    this.#endAutomaticWrites();
    this.#retireNativeAssets();
    this.#ready = false; this.#failureCode ??= error.code;
    if (this.mcpPolicy !== 'native-config') {
      this.#mcpIsolated = false;
      if (this.#thread) this.#thread.configured = false;
    }
    this.#historyRead?.stop();
    this.#clearApprovals(null);
    if (this.#thread) {
      this.#thread.writeGranted = false;
      if (['starting','inProgress','cancelling'].includes(this.#thread.turnStatus)) this.#thread.turnStatus = 'unknown';
    }
    for (const operation of this.#operations) if (operation.state === 'pending') {
      operation.state = 'unknown'; operation.errorCode = error.code;
    }
  }
  #message(message: Record<string, unknown>): void {
    if (Object.hasOwn(message, 'id')) { this.#serverRequest(message); return; }
    const method = message.method;
    if (method === 'account/rateLimits/updated') {
      if (!this.#ready || !this.#transport.connected || this.#account?.auth !== 'subscription' || this.#accountReads) return;
      const parsed = mergeNativeRateLimitUpdate(this.#rateLimits, message.params, Date.now());
      if (parsed) { this.#rateLimits = parsed; this.#rateLimitsRevision++; }
      return;
    }
    if (method === 'thread/tokenUsage/updated') {
      // Usage cannot adopt a thread/turn or revive a disconnected/unknown task.
      const params = message.params, thread = this.#thread;
      if (!this.#transport.connected || !thread || !usageObject(params) || params.threadId !== thread.threadId ||
          params.turnId !== thread.turnId || thread.turnId === null || thread.turnStatus === 'unknown') return;
      const usage = parseNativeTokenUsage(params.tokenUsage);
      if (!usage) return; // Optional malformed telemetry must not terminate a real turn.
      const previous = this.#usage;
      if (previous && (USAGE_KEYS.some(key => usage.total[key] < previous.total[key]) ||
          previous.total.cacheWriteInputTokens !== undefined && usage.total.cacheWriteInputTokens !== undefined &&
          usage.total.cacheWriteInputTokens < previous.total.cacheWriteInputTokens || previous.continuity === 'uncertain')) usage.continuity = 'uncertain';
      if (previous?.turnId === thread.turnId && JSON.stringify(usage) === JSON.stringify({
          source: previous.source, total: previous.total, last: previous.last,
          modelContextWindow: previous.modelContextWindow, continuity: previous.continuity })) return;
      this.#usage = { ...usage, threadId: thread.threadId, turnId: thread.turnId, seq: this.#lastEventSeq + 1 };
      this.#event({ type: 'usage', threadId: thread.threadId, turnId: thread.turnId, usage });
      return;
    }
    if (method === 'account/updated') {
      this.#rateLimits = undefined;
      const automatic = this.#endAutomaticWrites();
      if (!this.#initializing || this.#ready || this.#thread) this.#retireNativeAssets();
      this.#accountRevision++;
      this.#account = null;
      this.#accountIdentity = null;
      if (this.#thread) this.#thread.writeGranted = false;
      this.#clearApprovals('cancel'); this.#event({ type: 'account-changed' });
      const auth = object(message.params).authMode;
      if ((auth !== 'chatgpt' || automatic || this.mcpPolicy==='proposal') && this.#thread && ['starting','inProgress','cancelling'].includes(this.#thread.turnStatus)) this.#transport.stop(new CodexClientError('ACCOUNT_CHANGED', 'Subscription authentication changed during an active turn.'));
      return;
    }
    // Ignore all other auth, configuration, raw reasoning and unknown notifications.
    if (!['thread/started','turn/started','turn/completed','item/started','item/completed','item/agentMessage/delta','serverRequest/resolved','error'].includes(method as string)) return;
    const params = object(message.params);
    if (method === 'serverRequest/resolved') {
      const key = wireKey(requestId(params.requestId));
      for (const pending of this.#approvals.values()) if (pending.wireKey === key && pending.value.threadId === params.threadId) this.#removeApproval(pending, null);
      return;
    }
    if (method === 'thread/started') {
      if (!this.#threadOperation && !this.#threadAcknowledgement) return;
      const raw = object(params.thread); const id = str(raw.id);
      // Ignore unrelated late threads; same-thread identity conflicts must still
      // retire a configured connection and any active asset intent.
      if (!this.#threadOperation && id !== this.#threadAcknowledgement!.threadId) return;
      if (this.#threadOperation) {
        if (this.#threadOperation.threadId && this.#threadOperation.threadId !== id) fail('PROTOCOL', 'Thread notification changed the exact ID.');
        this.#threadOperation.threadId = id;
      }
      this.#adoptThread(id, this.#selection!, optionalText(raw.sessionId, 256), Object.hasOwn(raw, 'sessionId'));
      if (this.#threadOperation) this.#event({ type: 'thread', threadId: id });
      return;
    }
    if (!this.#thread || params.threadId !== this.#thread.threadId) return;
    const thread = this.#thread;
    if (method === 'turn/started' || method === 'turn/completed') {
      const raw = object(params.turn); const id = str(raw.id);
      if (thread.turnId !== id && this.#knownTurnIds.has(id)) return; // Delayed previous-turn events cannot bind a new start.
      if (thread.turnId !== id && !this.#turnOperation) return;
      if (this.#turnOperation?.turnId && this.#turnOperation.turnId !== id) fail('PROTOCOL', 'Turn notification changed the exact ID.');
      thread.turnId = id; this.#knownTurnIds.add(id);
      if (this.#turnOperation) this.#turnOperation.turnId = id;
      const state = status(raw.status);
      if (method === 'turn/completed' && !TERMINAL.has(state)) fail('PROTOCOL', 'Completion lacks a terminal turn status.');
      if (method === 'turn/started' && this.#cancelledTurnId === id) return;
      if (method === 'turn/started' && TERMINAL.has(thread.turnStatus)) return;
      thread.turnStatus = state;
      if (TERMINAL.has(state) && usageCount(raw.durationMs, 31_536_000_000)) thread.durationMs = raw.durationMs;
      if (TERMINAL.has(state)) { this.#endAutomaticWrites(); this.#endNativeAssetIntent(); this.#clearApprovals(null); }
      this.#event({ type: 'turn', threadId: thread.threadId, turnId: id, status: state,
        ...(TERMINAL.has(state) && thread.durationMs !== undefined ? { durationMs: thread.durationMs } : {}) }); return;
    }
    // A response and its first item notifications can share one transport chunk.
    // Promise continuations decode the ACK after this synchronous notification
    // pass, so retain the provisional exact turn while its start is pending.
    // The eventual ACK must still match, and known previous turns cannot bind it.
    if (thread.turnId === null && this.#turnOperation?.method === 'turn/start' &&
        ['item/started','item/completed','item/agentMessage/delta','error'].includes(method as string)) {
      const turnId = str(params.turnId);
      if (this.#knownTurnIds.has(turnId)) return;
      if (this.#turnOperation.turnId && this.#turnOperation.turnId !== turnId) fail('PROTOCOL', 'Item notification changed the pending turn ID.');
      thread.turnId = turnId; this.#turnOperation.turnId = turnId; this.#knownTurnIds.add(turnId);
    }
    if (params.turnId !== thread.turnId || !this.#scopeActive(thread.threadId, thread.turnId)) return;
    const turnId = thread.turnId!;
    if (method === 'item/agentMessage/delta') {
      const delta = typeof params.delta === 'string' ? params.delta : fail('PROTOCOL', 'Invalid agent delta.');
      this.#event({ type: 'delta', threadId: thread.threadId, turnId, itemId: str(params.itemId), text: delta });
    } else if (method === 'item/started' || method === 'item/completed') {
      const item = object(params.item);
      if (method === 'item/started' && item.type === 'fileChange') this.#captureFileProposal(item, turnId);
      if (method === 'item/completed') {
        const itemId = str(item.id);
        for (const pending of [...this.#approvals.values()]) if (pending.value.itemId === itemId && pending.value.turnId === turnId) this.#removeApproval(pending, null);
        this.#fileProposals.delete(itemId);
      }
      // Live MCP calls carry only an allowlisted, bounded identity (server, tool, display args) for activity lines.
      const tool = item.type === 'mcpToolCall' ? summarizeMcpToolCall(item) : null;
      this.#event({ type: 'item', threadId: thread.threadId, turnId, itemId: str(item.id), itemType: str(item.type, 64), status: optionalText(item.status, 64), ...(tool ? { tool } : {}) });
    } else if (method === 'error') {
      // Only the provider's classified usage limit is distinguished (a fixed code); its message never crosses.
      const info = params.error && typeof params.error === 'object' ? (params.error as Record<string, unknown>).codexErrorInfo : undefined;
      const usageLimit = info === 'usageLimitExceeded' || info === 'usage_limit_exceeded' ||
        !!info && typeof info === 'object' && !Array.isArray(info) && (Object.hasOwn(info, 'usageLimitExceeded') || Object.hasOwn(info, 'usage_limit_exceeded'));
      this.#event({ type: 'error', threadId: thread.threadId, turnId, code: usageLimit ? 'USAGE_LIMIT_EXCEEDED' : 'TURN_ERROR' });
    }
  }
  #scopeActive(threadId: string, turnId: string | null): boolean {
    const thread = this.#thread;
    return this.#transport.connected && thread !== null && thread.threadId === threadId && turnId !== null && thread.turnId === turnId &&
      (this.mcpPolicy === 'native-config' || thread.configured && this.#mcpIsolated) &&
      this.#cancelledTurnId !== turnId && ['starting','inProgress'].includes(thread.turnStatus);
  }
  #serverRequest(message: Record<string, unknown>): void {
    const id = requestId(message.id);
    const key = wireKey(id);
    // Reused IDs cannot make an old UI handle answer a different callback.
    if (this.#serverIds.has(key)) { this.#transport.stop(new CodexClientError('PROTOCOL', 'Server reused an approval request ID.')); return; }
    if (this.#serverIds.size >= this.bounds.maxServerRequests) { this.#transport.stop(new CodexClientError('APPROVAL_LIMIT', 'Server request history exceeded its bound.')); return; }
    this.#serverIds.add(key);
    if(this.mcpPolicy==='proposal') {
      if(APPROVALS.has(message.method as string))this.#transport.respond(id,{decision:'cancel'});
      else this.#transport.refuse(id);
      return;
    }
    if (!APPROVALS.has(message.method as string)) { this.#transport.refuse(id); return; }
    const params = object(message.params);
    const threadId = str(params.threadId); const turnId = str(params.turnId);
    // Apply the same previous-turn fence as lifecycle notifications before adopting an unknown ID.
    if (this.#thread?.turnId !== turnId && this.#knownTurnIds.has(turnId)) {
      this.#transport.respond(id, { decision: 'cancel' }); return;
    }
    if (this.#thread && this.#thread.threadId === threadId && this.#turnOperation && this.#thread.turnId === null) {
      this.#thread.turnId = turnId; this.#knownTurnIds.add(turnId); this.#turnOperation.turnId = turnId;
    }
    if (!this.#scopeActive(threadId, turnId)) { this.#transport.respond(id, { decision: 'cancel' }); return; }
    if (this.#approvals.size >= this.bounds.maxApprovals) {
      this.#transport.respond(id, { decision: 'cancel' });
      this.#transport.stop(new CodexClientError('APPROVAL_LIMIT', 'Pending approvals exceeded their bound.')); return;
    }
    const method = message.method as ApprovalMethod;
    const cwd = optionalText(params.cwd, 4096);
    const proposal = this.#fileProposals.get(str(params.itemId));
    const safeToAccept = (params.availableDecisions == null || (Array.isArray(params.availableDecisions) && params.availableDecisions.includes('accept'))) && params.networkApprovalContext == null && params.additionalPermissions == null &&
      params.grantRoot == null && params.environmentId == null &&
      (method === 'item/fileChange/requestApproval' ? proposal?.turnId === turnId : (typeof params.command === 'string' && cwd !== null && isAbsolute(cwd) && resolve(cwd) === resolve(this.#cwd) && (params.kind == null || params.kind === 'command')));
    const approval: Approval = {
      handle: randomUUID(), connectionId: this.#connectionId, serverRequestId: id,
      method, threadId, turnId, itemId: str(params.itemId),
      reason: optionalText(params.reason), command: optionalText(params.command, 8192), cwd,
      changes: method === 'item/fileChange/requestApproval' && proposal?.turnId === turnId ? proposal.changes : null,
      canAccept: false, expiresAt: Date.now() + this.bounds.approvalTimeoutMs,
    };
    const entry: PendingApproval = {
      value: approval, wireKey: key, safeToAccept,
      timer: setTimeout(() => {
        try { this.#removeApproval(entry, 'cancel'); }
        catch { this.#transport.stop(new CodexClientError('IO', 'Expired approval could not be cancelled.')); }
      }, this.bounds.approvalTimeoutMs),
    };
    this.#approvals.set(approval.handle, entry);
    this.#event({ type: 'approval', handle: approval.handle, threadId, turnId });
  }
  #canAccept(entry: PendingApproval): boolean {
    return entry.safeToAccept && this.#thread?.writeGranted === true && this.#account?.auth === 'subscription' &&
      entry.value.expiresAt > Date.now() && this.#scopeActive(entry.value.threadId, entry.value.turnId);
  }
  #removeApproval(entry: PendingApproval, decision: 'accept' | 'decline' | 'cancel' | null): void {
    clearTimeout(entry.timer); this.#approvals.delete(entry.value.handle);
    this.#fileProposals.delete(entry.value.itemId);
    this.#event({ type: 'approval-cleared', handle: entry.value.handle });
    if (decision !== null && this.#transport.connected) {
      try { this.#transport.respond(entry.value.serverRequestId, { decision }); }
      catch (error) {
        this.#transport.stop(new CodexClientError('APPROVAL_UNKNOWN', 'Approval delivery is uncertain; it cannot be replayed.'));
        throw error;
      }
    }
  }
  #clearApprovals(decision: 'cancel' | null): void {
    for (const entry of [...this.#approvals.values()]) this.#removeApproval(entry, decision);
    this.#fileProposals.clear();
  }
  #captureFileProposal(item: Record<string, unknown>, turnId: string): void {
    const itemId = str(item.id);
    // Changed review content invalidates the old callback before storing a new preview.
    for (const pending of [...this.#approvals.values()]) if (pending.value.itemId === itemId && pending.value.turnId === turnId) this.#removeApproval(pending, 'cancel');
    this.#fileProposals.delete(itemId);
    try {
      if (!Array.isArray(item.changes) || !item.changes.length || item.changes.length > 32) return;
      const inWorkspace = (path: string): boolean => {
        const child = relative(this.#cwd, resolve(this.#cwd, path));
        return child !== '' && child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child);
      };
      const changes: FileChangePreview[] = item.changes.map(value => {
        const raw = object(value); const kind = object(raw.kind);
        const path = str(raw.path, 4096);
        const movePath = optionalText(kind.move_path, 4096);
        if (!['add','delete','update'].includes(kind.type as string) || !inWorkspace(path) || (movePath !== null && !inWorkspace(movePath))) fail('PREVIEW', 'Unreviewable file proposal.');
        if (typeof raw.diff !== 'string' || Buffer.byteLength(raw.diff) > 65_536) fail('PREVIEW', 'File diff exceeds the preview bound.');
        return { path, kind: kind.type as FileChangePreview['kind'], movePath, diff: raw.diff };
      });
      const bytes = Buffer.byteLength(JSON.stringify(changes));
      const retained = [...this.#fileProposals.values()].reduce((sum, proposal) => sum + proposal.bytes, 0);
      if (this.#fileProposals.size >= this.bounds.maxApprovals || retained + bytes > this.bounds.maxEventBytes) return;
      this.#fileProposals.set(itemId, { turnId, changes, bytes });
    } catch { /* Keep the item summary, but refuse acceptance without a complete scoped preview. */ }
  }
  #event(input: SessionEventValue): void {
    const value: SessionEvent = { ...input, seq: ++this.#lastEventSeq };
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > this.bounds.maxEventBytes) { this.#droppedEvents++; return; }
    while (this.#events.length && (this.#events.length >= this.bounds.maxEvents || this.#eventBytes + bytes > this.bounds.maxEventBytes)) {
      this.#eventBytes -= this.#events.shift()!.bytes; this.#droppedEvents++;
    }
    this.#events.push({ value, bytes }); this.#eventBytes += bytes;
  }
}


