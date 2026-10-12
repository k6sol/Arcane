import { Buffer } from 'node:buffer';

/** Pure public-protocol projection. No transport, persistence, or native actions. */
export interface NativeHistoryLimits { maxBytes: number; maxTurns: number; maxItems: number }
export const NATIVE_HISTORY_LIMITS: Readonly<NativeHistoryLimits> = Object.freeze({ maxBytes: 2 * 1024 * 1024, maxTurns: 64, maxItems: 256 });
export const HISTORY_GAP_MARKER = '[History incomplete: some content was omitted or truncated.]';

export interface NativeHistoryIds {
  threadId: string;
  sessionId: string | null;
  turnId: string;
  itemId: string;
}
export interface NativeHistoryEntry {
  role: 'user' | 'assistant' | 'tool';
  text: string;
  ids: NativeHistoryIds;
}
export interface CodexHistoryScope {
  threadId: string;
  cwd: string;
  /** Request provenance: an empty summary is not a hydrated empty history. */
  includeTurns: boolean;
  sessionId?: string;
}
export type HistoryGapReason =
  | 'malformed-response' | 'rpc-error' | 'unsupported-envelope' | 'scope-mismatch'
  | 'unsupported-history-mode' | 'ephemeral-thread' | 'turns-not-requested'
  | 'missing-turns' | 'malformed-turn' | 'malformed-item' | 'items-not-full'
  | 'unsupported-item' | 'non-text-content' | 'context-compaction'
  | 'unfinished-turn' | 'failed-turn' | 'duplicate-turn' | 'conflicting-item'
  | 'byte-limit' | 'turn-limit' | 'item-limit';
export interface NativeHistoryGap {
  reason: HistoryGapReason;
  turnId?: string;
  itemId?: string;
}
export interface NativeHistoryResult {
  entries: NativeHistoryEntry[];
  completeness: 'complete' | 'incomplete' | 'rejected';
  gaps: NativeHistoryGap[];
  truncated: boolean;
  marker: string | null;
  /** Reasoning and explicitly private item kinds excluded by policy. */
  excludedItems: number;
  droppedGaps: number;
  redacted: boolean;
}
export type NativeHistoryBounds = Partial<NativeHistoryLimits>;
type RecordValue = Record<string, unknown>;
class InvalidShape extends Error {}
class ByteLimit extends Error {}

function record(value: unknown): RecordValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new InvalidShape();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new InvalidShape();
  return value as RecordValue;
}
/** Never invoke a getter, toJSON, or recursively inspect an unknown field. */
function field(value: RecordValue, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, 'value')) throw new InvalidShape();
  return descriptor.value;
}
function has(value: RecordValue, key: string): boolean {
  return Object.getOwnPropertyDescriptor(value, key) !== undefined;
}
function arrayField(value: unknown[], key: number | 'length'): unknown {
  return field(value as unknown as RecordValue, String(key));
}
function arrayLength(value: unknown[]): number {
  const length = arrayField(value, 'length');
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) throw new InvalidShape();
  return length;
}

/** Defense in depth for recognized public text, not an arbitrary-secret detector. */
export function redactNativeHistoryText(text: string): string {
  if (typeof text !== 'string' || text.length > NATIVE_HISTORY_LIMITS.maxBytes ||
      Buffer.byteLength(text) > NATIVE_HISTORY_LIMITS.maxBytes) throw new ByteLimit();
  return text
    .replace(/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)/g, '[REDACTED]')
    .replace(/\b(?:sk-(?:proj-|ant-|svcacct-)?[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,})\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/\b[0-9a-f]{64}\b/gi, '[REDACTED]')
    .replace(/\b(Bearer|Basic)[ \t]+[A-Za-z0-9+/_=.-]+/gi, '$1 [REDACTED]')
    .replace(/\b(https?:\/\/)[^/\s:@]+:[^/@\s]+@/gi, '$1[REDACTED]@')
    .replace(/\b([A-Za-z0-9_-]{0,64}(?:api[_-]?key|token|client[_-]?secret|password|passwd|authorization|set-cookie|cookie|secret|credential)[A-Za-z0-9_-]{0,64}["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&}\r\n]+)/gi, '$1[REDACTED]');
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value) ||
      redactNativeHistoryText(value) !== value) throw new InvalidShape();
  return value;
}
function cwd(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value) ||
      !/^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+|\/)/.test(value)) throw new InvalidShape();
  return value;
}
function bounds(options: NativeHistoryBounds): NativeHistoryLimits {
  const raw = record(options);
  const result = { ...NATIVE_HISTORY_LIMITS };
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(result, key)) throw new InvalidShape();
    const name = key as keyof typeof result;
    const value = field(raw, key);
    if (typeof value !== 'number' || !Number.isSafeInteger(value) ||
        value < (name === 'maxBytes' ? 1024 : 1) || value > result[name]) throw new InvalidShape();
    result[name] = value;
  }
  return result;
}
function empty(): NativeHistoryResult {
  return { entries: [], completeness: 'complete', gaps: [], truncated: false, marker: null, excludedItems: 0, droppedGaps: 0, redacted: false };
}
function reject(reason: HistoryGapReason): NativeHistoryResult {
  return { ...empty(), completeness: 'rejected', gaps: [{ reason }], marker: HISTORY_GAP_MARKER,
    truncated: reason === 'byte-limit' };
}

/**
 * Project public thread/read results with explicit hydration evidence for paginated turns.
 * Wire strings are bounded before JSON.parse; objects visit only allowlisted fields.
 * Return public entries plus evidence of omissions; never return the raw response.
 */
export function parseCodexThreadRead(
  response: unknown, expected: CodexHistoryScope, options: NativeHistoryBounds = {},
): NativeHistoryResult {
  const result = empty();
  let limit: NativeHistoryLimits;
  let thread: RecordValue;
  let threadId: string;
  let sessionId: string | null;
  let paginated = false;
  const gap = (reason: HistoryGapReason, turnId?: string, itemId?: string) => {
    const entry: NativeHistoryGap = { reason };
    if (turnId !== undefined) entry.turnId = turnId;
    if (itemId !== undefined) entry.itemId = itemId;
    // At most one gap per inspected item/turn plus bounded global diagnostics.
    if (result.gaps.length < NATIVE_HISTORY_LIMITS.maxItems + NATIVE_HISTORY_LIMITS.maxTurns + 8) result.gaps.push(entry);
    else { result.droppedGaps++; result.truncated = true; }
    result.completeness = 'incomplete';
    result.marker = HISTORY_GAP_MARKER;
    if (reason === 'byte-limit' || reason === 'turn-limit' || reason === 'item-limit') result.truncated = true;
  };
  try {
    limit = bounds(options);
    const scope = record(expected);
    threadId = id(field(scope, 'threadId'));
    const expectedCwd = cwd(field(scope, 'cwd'));
    const expectedSession = field(scope, 'sessionId');
    if (expectedSession !== undefined) id(expectedSession);
    const includeTurns = field(scope, 'includeTurns');
    if (typeof includeTurns !== 'boolean') throw new InvalidShape();
    if (typeof response === 'string') {
      if (response.length > limit.maxBytes || Buffer.byteLength(response) > limit.maxBytes) return reject('byte-limit');
      response = JSON.parse(response) as unknown;
    }
    let body = record(response);
    if (has(body, 'method')) return reject('unsupported-envelope');
    if (has(body, 'error')) return reject('rpc-error');
    if (has(body, 'result')) {
      const rpcId = field(body, 'id');
      if ((typeof rpcId !== 'string' && typeof rpcId !== 'number') ||
          (typeof rpcId === 'number' && !Number.isSafeInteger(rpcId))) throw new InvalidShape();
      const version = field(body, 'jsonrpc');
      if (version !== undefined && version !== '2.0') throw new InvalidShape();
      body = record(field(body, 'result'));
    }
    if (has(body, 'nextCursor') || has(body, 'backwardsCursor') || has(body, 'data')) return reject('unsupported-envelope');
    thread = record(field(body, 'thread'));
    if (id(field(thread, 'id')) !== threadId || cwd(field(thread, 'cwd')) !== expectedCwd) return reject('scope-mismatch');
    const nativeSession = field(thread, 'sessionId');
    sessionId = nativeSession == null ? null : id(nativeSession);
    if (expectedSession !== undefined && expectedSession !== sessionId) return reject('scope-mismatch');
    const mode = field(thread, 'historyMode');
    if (mode !== undefined && mode !== 'legacy' && mode !== 'paginated') return reject('unsupported-history-mode');
    paginated = mode === 'paginated';
    if (field(thread, 'ephemeral') === true) return reject('ephemeral-thread');
    if (field(thread, 'ephemeral') !== false) throw new InvalidShape();
    if (!includeTurns) return { ...reject('turns-not-requested'), completeness: 'incomplete' };
  } catch {
    return reject('malformed-response');
  }

  let turns: unknown;
  let turnCount: number;
  try {
    turns = field(thread, 'turns');
    turnCount = Array.isArray(turns) ? arrayLength(turns) : 0;
  } catch { return reject('malformed-response'); }
  if (!Array.isArray(turns)) return { ...reject('missing-turns'), completeness: 'incomplete' };
  // A paginated summary with no hydrated turns is not evidence of an empty chat.
  if (paginated && turnCount === 0) return { ...reject('missing-turns'), completeness: 'incomplete' };
  let inputTextBytes = 0;
  let entryBytes = 0;
  let inspectedItems = 0;
  const seenTurns = new Set<string>();
  const seenItems = new Map<string, NativeHistoryEntry | null>();
  const readText = (value: unknown): string => {
    if (typeof value !== 'string') throw new InvalidShape();
    if (value.length > limit.maxBytes - inputTextBytes) throw new ByteLimit();
    inputTextBytes += Buffer.byteLength(value);
    if (inputTextBytes > limit.maxBytes) throw new ByteLimit();
    return value;
  };
  const blocks = (value: unknown, kind: string, turnId: string, itemId: string): string => {
    if (!Array.isArray(value)) throw new InvalidShape();
    const length = arrayLength(value);
    if (length > limit.maxItems) throw new ByteLimit();
    const parts: string[] = [];
    for (let index = 0; index < length; index++) {
      const block = record(arrayField(value, index));
      if (field(block, 'type') === kind) parts.push(readText(field(block, 'text')));
      else gap('non-text-content', turnId, itemId);
    }
    // Sanitize after joining: a credential can span multiple public text blocks.
    return parts.join('\n');
  };
  const excludedKinds = new Set(['reasoning', 'plan', 'hookPrompt', 'collabAgentToolCall', 'subAgentActivity']);
  if (turnCount > limit.maxTurns) gap('turn-limit');
  outer: for (let turnIndex = 0; turnIndex < Math.min(turnCount, limit.maxTurns); turnIndex++) {
    let turn: RecordValue;
    let turnId: string;
    let items: unknown;
    let itemCount: number;
    try {
      turn = record(arrayField(turns, turnIndex));
      turnId = id(field(turn, 'id'));
      if (seenTurns.has(turnId)) { gap('duplicate-turn', turnId); continue; }
      seenTurns.add(turnId);
      const view = field(turn, 'itemsView');
      if (view !== 'full' && (paginated || view !== undefined)) { gap('items-not-full', turnId); continue; }
      const status = field(turn, 'status');
      if (status === 'inProgress') gap('unfinished-turn', turnId);
      else if (status === 'failed' || status === 'interrupted') gap('failed-turn', turnId);
      else if (status !== 'completed') throw new InvalidShape();
      items = field(turn, 'items');
      if (!Array.isArray(items)) throw new InvalidShape();
      itemCount = arrayLength(items);
    } catch { gap('malformed-turn'); continue; }
    for (let itemIndex = 0; itemIndex < itemCount; itemIndex++) {
      if (inspectedItems >= limit.maxItems) { gap('item-limit', turnId); break outer; }
      inspectedItems++;
      let itemId: string | undefined;
      try {
        const item = record(arrayField(items, itemIndex));
        itemId = id(field(item, 'id'));
        const type = field(item, 'type');
        if (typeof type !== 'string') throw new InvalidShape();
        if (excludedKinds.has(type)) { result.excludedItems++; continue; }
        let role: NativeHistoryEntry['role'];
        let text: string;
        switch (type) {
          case 'userMessage':
            role = 'user'; text = blocks(field(item, 'content'), 'text', turnId, itemId); break;
          case 'agentMessage': {
            const phase = field(item, 'phase');
            if (phase != null && phase !== 'commentary' && phase !== 'partial_answer' && phase !== 'final_answer') throw new InvalidShape();
            role = 'assistant'; text = readText(field(item, 'text')); break;
          }
          case 'commandExecution': {
            role = 'tool';
            const output = field(item, 'aggregatedOutput');
            text = output == null ? '' : readText(output);
            break;
          }
          case 'mcpToolCall': {
            role = 'tool';
            const output = field(item, 'result');
            text = output == null ? '' : blocks(field(record(output), 'content'), 'text', turnId, itemId);
            break;
          }
          case 'dynamicToolCall': {
            role = 'tool';
            const output = field(item, 'contentItems');
            text = output == null ? '' : blocks(output, 'inputText', turnId, itemId);
            break;
          }
          case 'functionCallOutput': {
            role = 'tool';
            const output = field(item, 'output');
            text = typeof output === 'string' ? readText(output) : blocks(output, 'input_text', turnId, itemId);
            break;
          }
          case 'contextCompaction': gap('context-compaction', turnId, itemId); continue;
          default: gap('unsupported-item', turnId, itemId); continue;
        }
        const safeText = redactNativeHistoryText(text);
        result.redacted ||= safeText !== text;
        const entry: NativeHistoryEntry = { role, text: safeText, ids: { threadId, sessionId, turnId, itemId } };
        const key = JSON.stringify([turnId, itemId]);
        if (seenItems.has(key)) {
          const previous = seenItems.get(key);
          if (previous && (previous.role !== role || previous.text !== safeText)) {
            // Neither conflicting version is reliable; expose a gap instead.
            result.entries = result.entries.filter(value => value !== previous);
            entryBytes -= Buffer.byteLength(JSON.stringify(previous)) + 1;
            seenItems.set(key, null);
            gap('conflicting-item', turnId, itemId);
          }
          continue;
        }
        const bytes = Buffer.byteLength(JSON.stringify(entry)) + 1;
        if (entryBytes + bytes > limit.maxBytes) throw new ByteLimit();
        seenItems.set(key, entry);
        result.entries.push(entry);
        entryBytes += bytes;
      } catch (error) {
        if (error instanceof ByteLimit) { gap('byte-limit', turnId, itemId); break outer; }
        gap('malformed-item', turnId, itemId);
      }
    }
  }
  // Bound the entire public result, including JSON escapes, IDs, gaps and marker.
  const overhead = () => Buffer.byteLength(JSON.stringify({ ...result, entries: [] }));
  if (entryBytes + overhead() > limit.maxBytes) {
    gap('byte-limit');
    while (result.entries.length && entryBytes + overhead() > limit.maxBytes) {
      const entry = result.entries.pop()!;
      entryBytes -= Buffer.byteLength(JSON.stringify(entry)) + 1;
    }
    while (overhead() > limit.maxBytes && result.gaps.length > 1) { result.gaps.splice(0, 1); result.droppedGaps++; }
  }
  return result;
}

export interface NativeHistoryCapability {
  api: string;
  support: 'supported' | 'experimental' | 'unsupported' | 'unverified';
  availableInPlan: boolean;
  reason: string;
}
export interface NativeHistoryPlanInput {
  provider: 'codex' | 'claude-code';
  cwd: string;
  /** Exact provider-native ID; the planner never invents one or forks a chat. */
  nativeId?: string;
  historyMode?: 'legacy' | 'paginated';
  experimentalApi?: boolean;
  turnPaginationSchemaAvailable?: boolean;
}
export interface PlannedNativeHistoryRequest {
  method: 'thread/start' | 'thread/list' | 'thread/read' | 'thread/resume' | 'thread/turns/list';
  params: Record<string, string | boolean | number | string[]>;
}
export interface NativeHistoryPlan {
  provider: 'codex' | 'claude-code';
  status: 'planned' | 'unsupported' | 'invalid';
  wiring: 'not-wired';
  nativeId: string | null;
  nativeApis: NativeHistoryCapability[];
  requests: PlannedNativeHistoryRequest[];
  cli: { startArgs: string[] | null; resumeArgs: string[] | null } | null;
  desktopVisibility: { status: 'unverified'; requires: 'real-desktop-test' };
  runtimeVerified: false;
}

/** Documentation/schema capability planning only; contains no executable side effects. */
export function planNativeHistoryCapabilities(input: NativeHistoryPlanInput): NativeHistoryPlan {
  const plan: NativeHistoryPlan = {
    provider: 'codex', status: 'invalid', wiring: 'not-wired', nativeId: null,
    nativeApis: [], requests: [], cli: null,
    desktopVisibility: { status: 'unverified', requires: 'real-desktop-test' }, runtimeVerified: false,
  };
  try {
    const raw = record(input);
    const allowed = ['provider', 'cwd', 'nativeId', 'historyMode', 'experimentalApi', 'turnPaginationSchemaAvailable'];
    if (Object.keys(raw).some(key => !allowed.includes(key))) throw new InvalidShape();
    const provider = field(raw, 'provider');
    if (provider !== 'codex' && provider !== 'claude-code') throw new InvalidShape();
    plan.provider = provider;
    const directory = cwd(field(raw, 'cwd'));
    const nativeId = field(raw, 'nativeId');
    const exactId = nativeId === undefined ? null : id(nativeId);
    const selectedMode = field(raw, 'historyMode');
    const mode = selectedMode === undefined ? 'legacy' : selectedMode;
    if (mode !== 'legacy' && mode !== 'paginated') throw new InvalidShape();
    const experimental = field(raw, 'experimentalApi');
    const schema = field(raw, 'turnPaginationSchemaAvailable');
    if ((experimental !== undefined && typeof experimental !== 'boolean') ||
        (schema !== undefined && typeof schema !== 'boolean')) throw new InvalidShape();
    if (provider === 'claude-code' && (mode !== 'legacy' || experimental !== undefined || schema !== undefined)) throw new InvalidShape();
    if (provider === 'claude-code' && exactId !== null &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(exactId)) throw new InvalidShape();
    plan.nativeId = exactId;
    plan.status = mode === 'paginated' ? 'unsupported' : 'planned';
    const capability = (api: string, support: NativeHistoryCapability['support'], availableInPlan: boolean, reason: string) =>
      plan.nativeApis.push({ api, support, availableInPlan, reason });
    if (provider === 'claude-code') {
      capability('--session-id', 'supported', exactId !== null, 'Caller-supplied UUID for a native Claude Code conversation.');
      capability('--resume', 'supported', exactId !== null, 'Resume the exact UUID without --fork-session.');
      capability('--output-format stream-json', 'supported', true, 'Print-mode public stream; a Claude stream parser remains to be implemented.');
      capability('history list/read API', 'unverified', false, 'The cited CLI reference does not establish a standalone public history-read API.');
      capability('claude.ai / Claude Design sync', 'unverified', false, 'No supported synchronization contract verified.');
      const outputArgs = ['--print', '--output-format', 'stream-json', '--verbose'];
      plan.cli = {
        startArgs: exactId === null ? null : ['--session-id', exactId, ...outputArgs],
        resumeArgs: exactId === null ? null : ['--resume', exactId, ...outputArgs],
      };
      return plan;
    }
    const legacy = mode === 'legacy';
    capability('thread/start', legacy ? 'supported' : 'unsupported', legacy, 'Persistent creation with ephemeral:false; paginated creation fails closed.');
    capability('thread/list', 'supported', true, 'Cursor-based metadata listing with exact workspace and explicit source filters.');
    capability('thread/read', 'supported', exactId !== null, 'Metadata supported; full includeTurns reads require legacy history.');
    capability('thread/resume', legacy ? 'supported' : 'unsupported', legacy && exactId !== null, 'Resume by threadId only; no path, injected history, or fork.');
    const pages = legacy && exactId !== null && experimental === true && schema === true;
    capability('thread/turns/list', legacy ? 'experimental' : 'unsupported', pages,
      'Requires experimental negotiation and matching schema; page parsing is outside this foundation.');
    plan.requests.push({ method: 'thread/list', params: { cwd: directory, limit: 64, sourceKinds: ['cli', 'vscode', 'appServer', 'exec'], modelProviders: ['openai'] } });
    if (legacy) plan.requests.push({ method: 'thread/start', params: { cwd: directory, ephemeral: false } });
    if (legacy && exactId !== null) {
      plan.requests.push({ method: 'thread/read', params: { threadId: exactId, includeTurns: true } });
      plan.requests.push({ method: 'thread/resume', params: { threadId: exactId, cwd: directory } });
    } else if (!legacy && exactId !== null) {
      plan.requests.push({ method: 'thread/read', params: { threadId: exactId, includeTurns: false } });
    }
    if (pages) plan.requests.push({ method: 'thread/turns/list', params: { threadId: exactId!, limit: 64, sortDirection: 'asc', itemsView: 'full' } });
    return plan;
  } catch {
    return { ...plan, status: 'invalid', nativeId: null, requests: [], cli: null, nativeApis: [] };
  }
}
