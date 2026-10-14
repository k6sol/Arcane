import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { parseCodexThreadRead, redactNativeHistoryText, type CodexHistoryScope, type NativeHistoryResult } from './history.js';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { JsonlTransport, type InternalProcess } from './transport.js';
import { arcaneThreadIsIsolated, requireArcaneBuildTools, type McpInventoryRow } from './mcp-isolation.js';
import { ARCANE_TASK_INSTRUCTIONS, ARCANE_NATIVE_TOOL_NAMES } from '../../protocol/src/arcane-tools.js';
import { CodexClientError, validateNativeAssetHooks, type Account, type Approval, type ApprovalMethod, type FileChangePreview, type HumanAction, type Limits, type Model, type NativeAssetHooks, type NativeAssetIntent, type Operation, type Selection, type SessionEvent, type SessionEventValue, type Snapshot, type ThreadState } from './types.js';
import { exact, fail, human, object, optionalText, str } from './validation.js';
import type { NativeTokenUsage, TokenUsageBreakdown, TokenUsageReport } from './types.js';

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

/** One-shot public read path. The lifecycle transport deliberately has no history method. */
function readHistoryProcess(spec: InternalProcess, bounds: Limits, scope: CodexHistoryScope) {
  const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, shell: false, windowsHide: true, stdio: 'pipe' });
  let done = false, stage = 1, bytes = 0, stderrBytes = 0, used = 0, serverRequests = 0;
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
        if (stage === 1) {
          object(message.result); stage = 2;
          send({ method: 'initialized', params: {} });
          send({ id: 2, method: 'thread/read', params: { threadId: scope.threadId, includeTurns: true } });
        } else finish(null, parseCodexThreadRead(message.result, scope));
      }
    } catch { protocolError(); }
  });
  send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'arcane_history_reader', title: 'Arcane History', version: '0.1.0' }, capabilities: { experimentalApi: false } } });
  return { promise, stop: () => finish(new CodexClientError('STALE_CONNECTION', 'Native history read was cancelled.', true)) };
}

/** Internal construction seam. The public index exposes only the installed-CLI factory. */
export class CodexSession {
  #connectionId = randomUUID();
  #historyRead: ReturnType<typeof readHistoryProcess> | null = null;
  #processSpec: InternalProcess;
  #transport: JsonlTransport;
  #ready = false;
  #initializing = false;
  #account: Account | null = null;
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
  #cwd: string;
  #mcpIsolated=false;
  #turnPreflight: TurnPreflight | null = null;
  #accountRevision = 0;
  #accountReads = 0;
  #failureCode: string | null = null;
  #threadOperation: Operation | null = null;
  #turnOperation: Operation | null = null;
  #catalogueLoading = false;
  #cancelledTurnId: string | null = null;
  #knownTurnIds = new Set<string>();
  #nativeAssetHooks: NativeAssetHooks | undefined;
  #assetIntent: { operation: Operation; scope: NativeAssetIntent } | null = null;
  #assetsRetired = false;
  constructor(spec: InternalProcess, private readonly bounds: Limits, private readonly provenance: Snapshot['provenance'], private readonly mcpPolicy: 'native-config'|'arcane-only' = 'native-config', hooks?: NativeAssetHooks) {
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
        if (this.mcpPolicy === 'arcane-only' && !Object.hasOwn(result, 'nextCursor')) fail('MCP_INVENTORY', 'Native MCP inventory lacks pagination metadata.');
        if (!Array.isArray(result.data) || result.data.length > 4) fail('MCP_INVENTORY', 'Native MCP inventory exceeds its page bound.');
        for (const value of result.data) {
          const raw = object(value), name = str(raw.name, 256);
          if (names.has(name) || rows.length >= 64) fail('MCP_INVENTORY', 'Duplicate or excessive native MCP servers.');
          names.add(name);
          if (this.mcpPolicy === 'arcane-only' &&
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
            if (this.mcpPolicy === 'arcane-only') object(tools[tool]);
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
      mcpIsolation:this.mcpPolicy==='native-config'?'native-config':this.#mcpIsolated?'arcane-only-verified':'arcane-only-pending',
      connected: this.#transport.connected, ready: this.#ready && this.#transport.connected,
      account: this.#account, models: this.#models, selection: this.#selection, thread: this.#thread,
      operations: this.#operations, approvals: [...this.#approvals.values()].map(entry => ({ ...entry.value, canAccept: this.#canAccept(entry) })),
      events: this.#events.map(entry => entry.value), droppedEvents: this.#droppedEvents, lastEventSeq: this.#lastEventSeq, failureCode: this.#failureCode,
      ...(this.#usage ? { usage: this.#usage } : {}),
    });
  }
  async readAccount(): Promise<Account> {
    this.#ensureReady();
    try { return await this.#readAccount(); }
    catch (error) {
      this.#retireNativeAssets();
      this.#account = null;
      if (this.#thread) this.#thread.writeGranted = false;
      this.#clearApprovals('cancel');
      throw error;
    }
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
    if (this.#selection?.model === pair.model && this.#selection.effort === pair.effort &&
        (!thread || thread.selection.model === pair.model && thread.selection.effort === pair.effort)) return structuredClone(pair);
    if (thread) {
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
    exact(action, ['initiatedBy','threadId']); human({ initiatedBy: action.initiatedBy });
    const thread = this.#requireThread(action.threadId);
    if (this.#turnPreflight) fail('STATE', 'Wait for the current turn isolation check before granting writes.');
    if (thread.turnStatus === 'cancelling' || thread.turnStatus === 'unknown' || thread.turnStatus === 'starting') fail('STATE', 'Writes cannot be granted during an uncertain lifecycle.');
    thread.writeGranted = true;
    return structuredClone(thread);
  }
  revokeThreadWrites(action: HumanAction & { threadId: string }): void {
    exact(action, ['initiatedBy','threadId']); human({ initiatedBy: action.initiatedBy });
    const thread = this.#requireThread(action.threadId, false);
    if (this.#turnPreflight?.thread === thread) this.#turnPreflight.revoked = true;
    thread.writeGranted = false;
    this.#clearApprovals('cancel');
    // Stop the active turn as well: a sandbox already sent on turn/start cannot be downgraded locally.
    if (thread.turnStatus === 'inProgress' || thread.turnStatus === 'starting') {
      this.#transport.stop(new CodexClientError('GRANT_REVOKED', 'Write grant revoked during an active turn; explicit recovery is required.'));
    }
  }
  async startTurn(action: HumanAction & { threadId: string; text: string }): Promise<ThreadState> {
    exact(action, ['initiatedBy','threadId','text']); human({ initiatedBy: action.initiatedBy });
    const thread = this.#requireThread(action.threadId);
    if (this.#turnPreflight || this.#threadOperation || this.#turnOperation || this.#operations.some(operation => operation.state === 'pending' || operation.state === 'unknown') ||
        !['idle','completed','failed','interrupted'].includes(thread.turnStatus)) fail('BUSY', 'The previous turn must be reconciled before starting another.');
    const text = str(action.text, this.bounds.maxInputBytes);
    this.#validatePair(thread.selection);
    if (this.mcpPolicy === 'arcane-only') {
      const preflight: TurnPreflight = { thread, selection: { ...thread.selection }, accountRevision: this.#accountRevision,
        turnId: thread.turnId, turnStatus: thread.turnStatus, revoked: false };
      // Reserve the entire asynchronous check without inventing a turn or an operation ID.
      this.#turnPreflight = preflight; this.#mcpIsolated = false;
      try {
        this.#clearApprovals('cancel');
        const rows = await this.#inspectMcpServers(thread.threadId, () => this.#checkTurnPreflight(preflight));
        this.#checkTurnPreflight(preflight);
        if (!arcaneThreadIsIsolated(rows)) fail('MCP_ISOLATION', 'The current native thread is not isolated to Arcane. No turn was sent.');
        requireArcaneBuildTools(rows, this.#nativeAssetHooks !== undefined);
        this.#mcpIsolated = true;
      } catch (error) {
        this.#invalidateIsolation(error);
        // A dispatched metadata request is not a dispatched turn. The host persists this distinction.
        throw error instanceof CodexClientError
          ? new CodexClientError(error.code, error.message, false, error.remoteCode)
          : new CodexClientError('MCP_ISOLATION', 'Native isolation could not be verified. No turn was sent.');
      }
      finally { this.#turnPreflight = null; }
    }
    const operation = this.#newOperation('turn/start', thread.threadId, null);
    this.#turnOperation = operation;
    this.#cancelledTurnId = null;
    this.#clearApprovals('cancel');
    thread.turnId = null; thread.turnStatus = 'starting';
    delete thread.durationMs;
    try {
      const result = await this.#requestOperation(operation, {
        threadId: thread.threadId, input: [{ type: 'text', text, text_elements: [] }],
        cwd: this.#cwd, model: thread.selection.model, effort: thread.selection.effort,
        approvalPolicy: 'on-request', approvalsReviewer: 'user',
        sandboxPolicy: thread.writeGranted
          ? { type: 'workspaceWrite', writableRoots: [this.#cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true }
          : { type: 'readOnly', networkAccess: false },
      });
      this.#decodeAcknowledgement(() => {
        const turn = object(object(result).turn);
        const turnId = str(turn.id);
        const turnStatus = status(turn.status);
        if (operation.turnId && operation.turnId !== turnId) fail('PROTOCOL', 'Turn acknowledgement changed the observed ID.');
        operation.turnId = turnId; thread.turnId = turnId; this.#knownTurnIds.add(turnId);
        // A late acknowledgement cannot resurrect a completed or cancelled turn.
        if (thread.turnStatus === 'starting') thread.turnStatus = turnStatus;
        if (TERMINAL.has(turnStatus) && usageCount(turn.durationMs, 31_536_000_000)) thread.durationMs = turn.durationMs;
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
  async interruptTurn(action: HumanAction & { threadId: string; turnId: string }): Promise<void> {
    exact(action, ['initiatedBy','threadId','turnId']); human({ initiatedBy: action.initiatedBy });
    const thread = this.#requireThread(action.threadId, false);
    if (this.#turnPreflight) fail('STATE', 'No turn has been dispatched during the isolation check.');
    const turnId = str(action.turnId);
    if (thread.turnId !== turnId || !['starting','inProgress'].includes(thread.turnStatus)) fail('STATE', 'Select the exact active turn to interrupt.');
    const operation = this.#newOperation('turn/interrupt', thread.threadId, turnId);
    // Fence first, synchronously, before any write or acknowledgement. Late prompts cannot be accepted.
    this.#cancelledTurnId = turnId; thread.turnStatus = 'cancelling'; thread.writeGranted = false;
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
  async close(): Promise<void> {
    this.#retireNativeAssets();
    const read = this.#historyRead; read?.stop();
    await Promise.allSettled([this.#transport.close(), ...(read ? [read.promise] : [])]);
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
      if ((this.#ready || this.#thread) && this.#account && (this.#account.auth !== account.auth || this.#account.plan !== account.plan || this.#account.requiresOpenaiAuth !== account.requiresOpenaiAuth)) this.#retireNativeAssets();
      this.#account = account;
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
          models.push({ model, id, displayName: str(raw.displayName, 256), efforts,
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
  async #openThread(id: string | null): Promise<ThreadState> {
    this.#ensureSubscription();
    if (!this.#selection) fail('SELECTION', 'Select an exact model and effort first.');
    this.#validatePair(this.#selection);
    if (this.#thread || this.#threadOperation) fail('STATE', 'This connection already owns a thread lifecycle.');
    if (this.mcpPolicy === 'arcane-only' && this.#accountReads) fail('BUSY', 'Wait for the current native account read before opening a thread.');
    const accountRevision = this.#accountRevision;
    const pair = { ...this.#selection };
    const operation = this.#newOperation(id === null ? 'thread/start' : 'thread/resume', id, null);
    this.#threadOperation = operation;
    try {
      const result = await this.#requestOperation(operation, {
        ...(id === null ? {} : { threadId: id }), model: pair.model, modelProvider: 'openai',
        cwd: this.#cwd, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'read-only',
        ...(this.mcpPolicy==='arcane-only' ? { developerInstructions: ARCANE_TASK_INSTRUCTIONS } : {}),
      });
      this.#decodeAcknowledgement(() => {
        const resultObject = object(result);
        const rawThread = object(object(result).thread);
        const threadId = str(rawThread.id);
        if ((id && threadId !== id) || (operation.threadId && operation.threadId !== threadId)) fail('PROTOCOL', 'Thread acknowledgement changed the exact ID.');
        operation.threadId = threadId;
        this.#acknowledgeThread(threadId, pair, optionalText(rawThread.sessionId, 256));
        const sandbox = object(resultObject.sandbox);
        if (resultObject.model !== pair.model || resultObject.modelProvider !== 'openai' || resultObject.approvalPolicy !== 'on-request' || resultObject.approvalsReviewer !== 'user' || sandbox.type !== 'readOnly' || sandbox.networkAccess !== false || typeof resultObject.cwd !== 'string' || resolve(resultObject.cwd) !== resolve(this.#cwd)) {
          fail('SETTINGS_MISMATCH', 'Native thread settings do not match the requested local policy and model.');
        }
        const thread = this.#thread!;
        if (Array.isArray(rawThread.turns)) {
          const active = rawThread.turns.filter(value => object(value).status === 'inProgress');
          if (active.length > 1) fail('PROTOCOL', 'Resume reported multiple active turns.');
          if (active.length) { thread.turnId = str(object(active[0]).id); this.#knownTurnIds.add(thread.turnId); thread.turnStatus = 'inProgress'; }
        }
        if (rawThread.status != null && object(rawThread.status).type === 'active' && thread.turnId === null) thread.turnStatus = 'unknown';
        thread.configured = this.mcpPolicy!=='arcane-only'; operation.state = 'acknowledged';
      });
      const thread = this.#thread!;
      if(this.mcpPolicy==='arcane-only') {
        const turnId=thread.turnId,turnStatus=thread.turnStatus;
        const check=()=>{
          this.#checkIsolationContext(thread,pair,accountRevision);
          if(this.#threadOperation!==operation||thread.turnId!==turnId||thread.turnStatus!==turnStatus)fail('STATE','Thread setup changed during the isolation check.');
        };
        try {
          const inventory=await this.#inspectMcpServers(thread.threadId,check);
          check();
          if(!arcaneThreadIsIsolated(inventory))fail('MCP_ISOLATION','The native thread exposes an inherited tool server or Arcane is not connected. No turn can be started.');
          requireArcaneBuildTools(inventory, this.#nativeAssetHooks !== undefined);
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
    return this.#transport.request(operation.method, params, id => { operation.requestId = id; },
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
  #operationFailed(operation: Operation, error: unknown): void {
    const native = error instanceof CodexClientError ? error : new CodexClientError('PROTOCOL', 'Invalid native response.', true);
    operation.errorCode = native.code;
    const observed = operation.method === 'thread/start' ? operation.threadId !== null : operation.method === 'turn/start' ? operation.turnId !== null : false;
    operation.state = native.code === 'REMOTE_REJECTED' && !observed ? 'rejected' : native.dispatched ? 'unknown' : operation.state === 'unknown' || observed ? 'unknown' : 'not-sent';
    if (operation.method === 'turn/start') this.#endNativeAssetIntent(operation);
    if (this.#nativeAssetHooks && operation.state === 'unknown') {
      this.#retireNativeAssets(); this.#transport.stop(native);
    }
    if (native.code === 'SETTINGS_MISMATCH' || native.code === 'PROTOCOL') {
      operation.state = 'unknown'; this.#transport.stop(native);
    }
  }
  #disconnect(error: CodexClientError): void {
    this.#retireNativeAssets();
    this.#ready = false; this.#failureCode ??= error.code;
    if (this.mcpPolicy === 'arcane-only') {
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
      if (!this.#initializing || this.#ready || this.#thread) this.#retireNativeAssets();
      this.#accountRevision++;
      this.#account = null;
      if (this.#thread) this.#thread.writeGranted = false;
      this.#clearApprovals('cancel'); this.#event({ type: 'account-changed' });
      const auth = object(message.params).authMode;
      if (auth !== 'chatgpt' && this.#thread && ['starting','inProgress','cancelling'].includes(this.#thread.turnStatus)) this.#transport.stop(new CodexClientError('ACCOUNT_CHANGED', 'Subscription authentication changed during an active turn.'));
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
      if (TERMINAL.has(state)) { this.#endNativeAssetIntent(); this.#clearApprovals(null); }
      this.#event({ type: 'turn', threadId: thread.threadId, turnId: id, status: state,
        ...(TERMINAL.has(state) && thread.durationMs !== undefined ? { durationMs: thread.durationMs } : {}) }); return;
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
      this.#event({ type: 'item', threadId: thread.threadId, turnId, itemId: str(item.id), itemType: str(item.type, 64), status: optionalText(item.status, 64) });
    } else if (method === 'error') {
      this.#event({ type: 'error', threadId: thread.threadId, turnId, code: 'TURN_ERROR' });
    }
  }
  #scopeActive(threadId: string, turnId: string | null): boolean {
    const thread = this.#thread;
    return this.#transport.connected && thread !== null && thread.threadId === threadId && turnId !== null && thread.turnId === turnId &&
      (this.mcpPolicy !== 'arcane-only' || thread.configured && this.#mcpIsolated) &&
      this.#cancelledTurnId !== turnId && ['starting','inProgress'].includes(thread.turnStatus);
  }
  #serverRequest(message: Record<string, unknown>): void {
    const id = requestId(message.id);
    const key = wireKey(id);
    // Reused IDs cannot make an old UI handle answer a different callback.
    if (this.#serverIds.has(key)) { this.#transport.stop(new CodexClientError('PROTOCOL', 'Server reused an approval request ID.')); return; }
    if (this.#serverIds.size >= this.bounds.maxServerRequests) { this.#transport.stop(new CodexClientError('APPROVAL_LIMIT', 'Server request history exceeded its bound.')); return; }
    this.#serverIds.add(key);
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


