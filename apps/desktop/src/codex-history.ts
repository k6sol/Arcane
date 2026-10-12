/// <reference lib="dom" />

// Browser-only projections: no runtime dependency on the daemon or native client.
export const HISTORY_UI_LIMITS = Object.freeze({
  maxResponseBytes: 4 * 1024 * 1024, maxHistoryBytes: 2 * 1024 * 1024,
  maxEntries: 256, maxTurns: 64, maxGaps: 328,
});
export const HISTORY_INCOMPLETE_MARKER = '[History incomplete: some content was omitted or truncated.]';
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const TOKEN = /^[a-f0-9]{64}$/;
const GAP_REASONS = [
  'malformed-response', 'rpc-error', 'unsupported-envelope', 'scope-mismatch',
  'unsupported-history-mode', 'ephemeral-thread', 'turns-not-requested', 'missing-turns',
  'malformed-turn', 'malformed-item', 'items-not-full', 'unsupported-item', 'non-text-content',
  'context-compaction', 'unfinished-turn', 'failed-turn', 'duplicate-turn', 'conflicting-item',
  'byte-limit', 'turn-limit', 'item-limit',
] as const;
type GapReason = typeof GAP_REASONS[number];
export interface HistoryIds { threadId: string; sessionId: string | null; turnId: string; itemId: string }
export interface HistoryEntry { role: 'user' | 'assistant' | 'tool'; text: string; ids: HistoryIds }
export interface HistoryGap { reason: GapReason; turnId?: string; itemId?: string }
export interface HistoryResult {
  entries: HistoryEntry[]; completeness: 'complete' | 'incomplete'; gaps: HistoryGap[];
  truncated: boolean; marker: string | null; excludedItems: number; droppedGaps: number; redacted: boolean;
}
export interface RecordedHistory {
  requestId: string; connectionId: string; provenance: 'installed-cli' | 'spawned-node-fixture';
  loadedAt: string; result: HistoryResult;
}
export interface HistoryBinding {
  projectPath: string; threadId: string; sessionId: string | null; recorded: RecordedHistory | null;
}
class HistoryControlError extends Error {}
const size = (value: string) => new TextEncoder().encode(value).byteLength;
function invalid(): never { throw new Error('Invalid or out-of-scope native history. Read the recorded thread again.'); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  return value as Record<string, unknown>;
}
function field(row: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(row, key);
  if (!descriptor || !('value' in descriptor)) invalid();
  return descriptor.value;
}
function shape(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  const row = object(value), keys = Reflect.ownKeys(row);
  if (required.some(key => !Object.hasOwn(row, key)) ||
      keys.some(key => typeof key !== 'string' || ![...required, ...optional].includes(key))) invalid();
  for (const key of keys) field(row, key as string);
  return row;
}
function string(value: unknown, maximum: number, empty = false): string {
  if (typeof value !== 'string' || value.length > maximum || size(value) > maximum || (!empty && !value.trim())) invalid();
  return value;
}
function identifier(value: unknown): string { const result = string(value, 256); if (!ID.test(result)) invalid(); return result; }
function uuid(value: unknown): string { const result = string(value, 36); if (!UUID.test(result)) invalid(); return result; }
function nullableId(value: unknown): string | null { return value === null ? null : identifier(value); }
function boolean(value: unknown): boolean { if (typeof value !== 'boolean') invalid(); return value; }
function integer(value: unknown, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) invalid();
  return value;
}
function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) invalid();
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor || !('value' in descriptor)) invalid();
  }
  return value;
}
function project(value: unknown): string {
  const result = string(value, 4096);
  if (!/^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(result) || /[\x00-\x1f\x7f]/.test(result)) invalid();
  return result;
}
function timestamp(value: unknown): string {
  const result = string(value, 32);
  if (!Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) invalid();
  return result;
}
function sameBinding(a: HistoryBinding, b: HistoryBinding): boolean {
  return a.projectPath === b.projectPath && a.threadId === b.threadId && a.sessionId === b.sessionId;
}

/** Only a bounded public projection is accepted; raw items/reasoning/events have no fallback. */
export function validateHistoryResult(value: unknown, binding: Pick<HistoryBinding, 'threadId' | 'sessionId'>): HistoryResult {
  const row = shape(value, ['entries', 'completeness', 'gaps', 'truncated', 'marker', 'excludedItems', 'droppedGaps', 'redacted']);
  if (!['complete', 'incomplete'].includes(row.completeness as string) ||
      (row.marker !== null && row.marker !== HISTORY_INCOMPLETE_MARKER)) invalid();
  const threadId = identifier(binding.threadId), sessionId = nullableId(binding.sessionId);
  const turns = new Set<string>(), seen = new Map<string, HistoryEntry>(), entries: HistoryEntry[] = [];
  let used = 0;
  for (const value of array(row.entries, HISTORY_UI_LIMITS.maxEntries)) {
    const entry = shape(value, ['role', 'text', 'ids']), ids = shape(entry.ids, ['threadId', 'sessionId', 'turnId', 'itemId']);
    if (!['user', 'assistant', 'tool'].includes(entry.role as string)) invalid();
    const parsed: HistoryEntry = {
      role: entry.role as HistoryEntry['role'], text: string(entry.text, HISTORY_UI_LIMITS.maxHistoryBytes, true),
      ids: { threadId: identifier(ids.threadId), sessionId: nullableId(ids.sessionId), turnId: identifier(ids.turnId), itemId: identifier(ids.itemId) },
    };
    if (parsed.ids.threadId !== threadId || (sessionId !== null && parsed.ids.sessionId !== sessionId)) invalid();
    used += size(JSON.stringify(parsed));
    if (used > HISTORY_UI_LIMITS.maxHistoryBytes) invalid();
    turns.add(parsed.ids.turnId); if (turns.size > HISTORY_UI_LIMITS.maxTurns) invalid();
    const key = JSON.stringify(parsed.ids), prior = seen.get(key);
    if (prior && (prior.role !== parsed.role || prior.text !== parsed.text)) invalid();
    if (!prior) { seen.set(key, parsed); entries.push(parsed); }
  }
  const gaps = array(row.gaps, HISTORY_UI_LIMITS.maxGaps).map(value => {
    const gap = shape(value, ['reason'], ['turnId', 'itemId']);
    if (!GAP_REASONS.includes(gap.reason as GapReason)) invalid();
    return { reason: gap.reason as GapReason,
      ...(Object.hasOwn(gap, 'turnId') ? { turnId: identifier(gap.turnId) } : {}),
      ...(Object.hasOwn(gap, 'itemId') ? { itemId: identifier(gap.itemId) } : {}) };
  });
  const truncated = boolean(row.truncated), droppedGaps = integer(row.droppedGaps, 1_000_000);
  const incomplete = row.completeness === 'incomplete' || truncated || gaps.length > 0 || droppedGaps > 0 || row.marker !== null;
  const result: HistoryResult = { entries, completeness: incomplete ? 'incomplete' : 'complete', gaps, truncated,
    marker: incomplete ? HISTORY_INCOMPLETE_MARKER : null, excludedItems: integer(row.excludedItems, 256),
    droppedGaps, redacted: boolean(row.redacted) };
  if (size(JSON.stringify(result)) > HISTORY_UI_LIMITS.maxHistoryBytes) invalid();
  return result;
}
export function validateHistoryBinding(value: unknown, expectedProjectPath: string): HistoryBinding | null {
  const expected = project(expectedProjectPath);
  if (value === null) return null;
  const row = shape(value, ['projectPath', 'threadId', 'sessionId', 'recorded']);
  if (project(row.projectPath) !== expected) invalid();
  const binding: HistoryBinding = { projectPath: expected, threadId: identifier(row.threadId), sessionId: nullableId(row.sessionId), recorded: null };
  if (row.recorded !== null) {
    const recorded = shape(row.recorded, ['requestId', 'connectionId', 'provenance', 'loadedAt', 'result']);
    if (!['installed-cli', 'spawned-node-fixture'].includes(recorded.provenance as string)) invalid();
    binding.recorded = { requestId: uuid(recorded.requestId), connectionId: uuid(recorded.connectionId),
      provenance: recorded.provenance as RecordedHistory['provenance'], loadedAt: timestamp(recorded.loadedAt),
      result: validateHistoryResult(recorded.result, binding) };
  }
  return binding;
}
export interface CodexHistoryIds {
  refresh: string; thread: string; load: string; status: string; notice: string; scope: string; entries: string; gaps: string;
}
export const CODEX_HISTORY_IDS: Readonly<CodexHistoryIds> = Object.freeze({
  refresh: 'codex-history-refresh', thread: 'codex-history-thread', load: 'codex-history-load',
  status: 'codex-history-status', notice: 'codex-history-notice', scope: 'codex-history-scope',
  entries: 'codex-history-entries', gaps: 'codex-history-gaps',
});
export interface CodexHistoryOptions {
  getToken: () => string;
  /** Trusted host's current canonical project path; never infer it from a native ID. */
  getProjectPath: () => string;
  ids?: Partial<CodexHistoryIds>;
  transport?: typeof fetch;
  deadlineMs?: number;
  requestId?: () => string;
}
interface Operation { controller: AbortController; generation: number; token: string; projectPath: string; requestId?: string; sent: boolean }

/** start/resume/import are inert. Only trusted refresh, selection and load events act. */
export class CodexHistoryPanel {
  private readonly doc: Document;
  private readonly ids: CodexHistoryIds;
  private readonly transport: typeof fetch;
  private bound = false;
  private stopped = true;
  private disposed = false;
  private generation = 0;
  private operation: Operation | null = null;
  private known: HistoryBinding | null = null;
  private selected = false;
  private knownFresh = false;
  private token = '';
  private readonly listeners: Array<() => void> = [];
  constructor(private readonly root: Document | HTMLElement, private readonly options: CodexHistoryOptions) {
    this.doc = root.nodeType === 9 ? root as Document : (root as HTMLElement).ownerDocument;
    this.ids = { ...CODEX_HISTORY_IDS, ...options.ids };
    if (new Set(Object.values(this.ids)).size !== 8 || Object.values(this.ids).some(id => !/^[A-Za-z][A-Za-z0-9_-]{0,99}$/.test(id))) invalid();
    if (options.deadlineMs !== undefined && (!Number.isSafeInteger(options.deadlineMs) || options.deadlineMs < 1 || options.deadlineMs > 60000)) invalid();
    this.transport = options.transport ?? (this.doc.defaultView?.fetch ? this.doc.defaultView.fetch.bind(this.doc.defaultView) : globalThis.fetch);
  }
  private el<T extends HTMLElement = HTMLElement>(key: keyof CodexHistoryIds): T {
    const id = this.ids[key];
    const element = this.root.nodeType === 9 ? this.doc.getElementById(id) : (this.root as HTMLElement).querySelector(`[id="${id}"]`);
    if (!element) throw new Error('Missing native history control: ' + id);
    return element as T;
  }
  private safe(value: string): string { return this.token ? value.replaceAll(this.token, '[REDACTED]') : value; }
  private make<K extends keyof HTMLElementTagNameMap>(tag: K, text: string, className?: string): HTMLElementTagNameMap[K] {
    const element = this.doc.createElement(tag); element.textContent = this.safe(text);
    if (className) element.className = className;
    return element;
  }
  private status(text: string): void { this.el('status').textContent = this.safe(text); }
  private notice(text: string): void { this.el('notice').textContent = this.safe(text); }
  private controls(): void {
    const disabled = this.stopped || this.disposed || this.operation !== null;
    this.el<HTMLButtonElement>('refresh').disabled = disabled;
    this.el<HTMLSelectElement>('thread').disabled = disabled || !this.known;
    this.el<HTMLButtonElement>('load').disabled = disabled || !this.known || !this.selected || !this.knownFresh;
  }
  private clear(): void {
    this.known = null; this.selected = false; this.knownFresh = false;
    this.el('entries').replaceChildren(); this.el('gaps').replaceChildren(); this.el('scope').textContent = '';
    const placeholder = this.make('option', 'Select a recorded thread'); placeholder.value = '';
    this.el('thread').replaceChildren(placeholder); this.el<HTMLSelectElement>('thread').value = '';
  }
  private bind(target: EventTarget, name: string, action: (event: Event) => void): void {
    target.addEventListener(name, action); this.listeners.push(() => target.removeEventListener(name, action));
  }
  start(): void {
    if (this.bound || this.disposed) return;
    for (const key of Object.keys(this.ids) as Array<keyof CodexHistoryIds>) this.el(key);
    if (this.el('refresh').tagName !== 'BUTTON' || this.el('load').tagName !== 'BUTTON' || this.el('thread').tagName !== 'SELECT') invalid();
    this.el<HTMLButtonElement>('refresh').type = 'button'; this.el<HTMLButtonElement>('load').type = 'button';
    this.el('refresh').textContent = 'Read recorded thread'; this.el('load').textContent = 'Load native history';
    this.el('thread').setAttribute('aria-label', 'Recorded native Codex thread');
    this.el('status').setAttribute('role', 'status'); this.el('status').setAttribute('aria-live', 'polite');
    this.el('notice').setAttribute('role', 'status');
    this.bind(this.el('refresh'), 'click', event => { event.preventDefault(); if (event.isTrusted) void this.refresh(); });
    this.bind(this.el('load'), 'click', event => { event.preventDefault(); if (event.isTrusted) void this.load(); });
    this.bind(this.el('thread'), 'change', event => {
      if (!event.isTrusted || this.stopped || this.disposed || this.operation) return;
      try {
        if (!this.known || this.options.getProjectPath() !== this.known.projectPath || this.options.getToken() !== this.token) {
          this.clear(); this.status('Project or control link changed. Read the recorded thread explicitly.'); this.controls(); return;
        }
      } catch { this.clear(); this.status('Project or control link could not be checked.'); this.controls(); return; }
      this.selected = this.el<HTMLSelectElement>('thread').value === this.known.threadId;
      this.el('entries').replaceChildren(); this.el('gaps').replaceChildren();
      if (this.selected) this.render(this.known!); else this.status('Select the recorded thread to inspect its history.');
      this.controls();
    });
    if (this.doc.defaultView) this.bind(this.doc.defaultView, 'pagehide', () => this.stop());
    this.bound = true; this.stopped = false; this.clear();
    this.status('History has not been read.'); this.notice('Read this project’s recorded thread, then select it. Private reasoning is excluded.'); this.controls();
  }
  stop(): void {
    if (!this.bound || this.disposed) return;
    const op = this.operation; this.stopped = true; this.generation++; this.operation = null; op?.controller.abort();
    this.clear(); this.status('History paused. Read the recorded thread explicitly after returning.');
    this.notice(op?.sent ? 'History read acknowledgement was not received. No request is replayed automatically.' : 'Private reasoning is excluded.');
    this.controls();
  }
  resume(): void {
    if (this.disposed) return;
    if (!this.bound) { this.start(); return; }
    if (!this.stopped) return;
    this.stopped = false; this.clear(); this.status('History has not been read.');
    this.notice('Read the recorded thread explicitly. Private reasoning is excluded.'); this.controls();
  }
  dispose(): void {
    if (this.disposed) return;
    this.stop(); for (const remove of this.listeners) remove(); this.listeners.length = 0; this.disposed = true;
  }
  private current(op: Operation): boolean {
    if (this.stopped || this.disposed || this.operation !== op || this.generation !== op.generation || op.controller.signal.aborted) return false;
    try { return this.options.getToken() === op.token && this.options.getProjectPath() === op.projectPath; } catch { return false; }
  }
  private begin(): Operation | null {
    if (this.stopped || this.disposed || this.operation) return null;
    try {
      const token = this.options.getToken();
      if (typeof token !== 'string' || !TOKEN.test(token)) throw new Error();
      const projectPath = project(this.options.getProjectPath()); this.token = token;
      const op: Operation = { controller: new AbortController(), generation: this.generation, token, projectPath, sent: false };
      this.operation = op; this.notice(''); this.controls(); return op;
    } catch { this.clear(); this.status('History has not been read.'); this.notice('A valid human control link and current project are required.'); this.controls(); return null; }
  }
  private finish(op: Operation): void {
    if (this.operation !== op) return;
    if (!this.current(op)) {
      this.clear(); this.status('History was not applied. Read the recorded thread again.');
      this.notice(op.sent ? `The read may have completed. Request: ${op.requestId}. No request is replayed automatically.` : 'The control link, project, or request changed.');
    }
    this.operation = null; this.controls();
  }
  private async request(op: Operation, path: '/v1/codex/history' | '/v1/codex/state' | '/v1/codex/action', input?: object): Promise<{ ok: boolean; value: unknown }> {
    const signal = op.controller.signal;
    let cancel!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      cancel = () => reject(new Error('History request cancelled or timed out. Read the recorded thread explicitly.'));
      signal.addEventListener('abort', cancel, { once: true });
    });
    const timer = setTimeout(() => op.controller.abort(), this.options.deadlineMs ?? 45000);
    const work = async () => {
      if (!this.current(op)) throw new Error();
      if (input !== undefined) op.sent = true;
      const response = await this.transport(path, { method: input === undefined ? 'GET' : 'POST',
        headers: { Authorization: 'Bearer ' + op.token, ...(input === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal,
        credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-store', mode: 'same-origin' });
      if (!this.current(op) || response.redirected || response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json' || !response.body) {
        void response.body?.cancel().catch(() => {}); throw new Error();
      }
      const length = response.headers.get('Content-Length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > HISTORY_UI_LIMITS.maxResponseBytes)) {
        void response.body.cancel().catch(() => {}); throw new Error();
      }
      const reader = response.body.getReader(), chunks: Uint8Array[] = [];
      const abortRead = () => { void reader.cancel().catch(() => {}); };
      signal.addEventListener('abort', abortRead, { once: true });
      let total = 0, ended = false;
      try {
        for (;;) {
          const part = await reader.read(); if (!this.current(op)) throw new Error();
          if (part.done) { ended = true; break; }
          total += part.value.byteLength; if (total > HISTORY_UI_LIMITS.maxResponseBytes) throw new Error(); chunks.push(part.value);
        }
        const buffer = new Uint8Array(total); let offset = 0;
        for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
        return { ok: response.ok, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)) as unknown };
      } finally { signal.removeEventListener('abort', abortRead); if (!ended) abortRead(); reader.releaseLock(); }
    };
    try { return await Promise.race([work(), cancelled]); }
    finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); }
  }
  private async refresh(): Promise<void> {
    const op = this.begin(); if (!op) return;
    this.clear(); this.status('Reading the project’s recorded thread…');
    try {
      const response = await this.request(op, '/v1/codex/history'); if (!this.current(op)) return;
      if (!response.ok) throw new Error();
      const envelope = shape(response.value, ['nativeHistory']);
      this.known = validateHistoryBinding(envelope.nativeHistory, op.projectPath); this.knownFresh = true;
      if (this.known) {
        const option = this.make('option', this.known.threadId); option.value = this.known.threadId; this.el('thread').append(option);
        this.el('scope').textContent = this.safe(`Project: ${this.known.projectPath}\nNative thread: ${this.known.threadId}\nNative session: ${this.known.sessionId ?? 'not recorded'}`);
        this.status('Recorded thread found. Select it to inspect cached history.');
      } else this.status('No native thread has been recorded for this project.');
      this.notice('Only this project’s recorded binding is shown. Private reasoning is excluded.');
    } catch { if (this.current(op)) { this.clear(); this.status('Recorded thread could not be read.'); this.notice('Check the human control link and project, then read again explicitly.'); } }
    finally { this.finish(op); }
  }
  private connection(value: unknown, expected: HistoryBinding): { connectionId: string; provenance: RecordedHistory['provenance'] } {
    const state = object(field(object(value), 'state'));
    if (field(state, 'provider') !== 'codex' || field(state, 'use') !== 'personal-local' || field(state, 'projectPath') !== expected.projectPath) invalid();
    const binding = validateHistoryBinding(field(state, 'nativeHistory'), expected.projectPath);
    if (!binding || !sameBinding(expected, binding)) invalid();
    if (boolean(field(state, 'connecting')) || boolean(field(state, 'closing')) || boolean(field(state, 'busy'))) throw new HistoryControlError('Wait for the current native action to finish, then load explicitly.');
    const snapshotValue = field(state, 'snapshot');
    if (snapshotValue === null) throw new HistoryControlError('Connect Codex explicitly before loading native history. Cached history remains available.');
    const snapshot = object(snapshotValue);
    if (!boolean(field(snapshot, 'connected')) || !boolean(field(snapshot, 'ready'))) throw new HistoryControlError('Connect Codex explicitly before loading native history. Cached history remains available.');
    const threadValue = field(snapshot, 'thread');
    if (threadValue !== null) {
      const thread = object(threadValue);
      if (field(thread, 'threadId') !== expected.threadId || (expected.sessionId !== null && field(thread, 'sessionId') !== expected.sessionId)) invalid();
    }
    const provenance = field(snapshot, 'provenance');
    if (!['installed-cli', 'spawned-node-fixture'].includes(provenance as string)) invalid();
    return { connectionId: uuid(field(snapshot, 'connectionId')), provenance: provenance as RecordedHistory['provenance'] };
  }
  private async load(): Promise<void> {
    if (!this.known || !this.selected || !this.knownFresh || this.el<HTMLSelectElement>('thread').value !== this.known.threadId) return;
    const binding = this.known, op = this.begin(); if (!op) return;
    if (binding.projectPath !== op.projectPath) { this.clear(); this.notice('Project changed. Read its recorded thread explicitly.'); this.finish(op); return; }
    this.status('Checking the existing native connection…');
    try {
      const fresh = await this.request(op, '/v1/codex/state'); if (!this.current(op)) return;
      if (!fresh.ok) throw new HistoryControlError('Existing native connection could not be checked. Read the recorded thread again.');
      const connection = this.connection(fresh.value, binding);
      op.requestId = uuid((this.options.requestId ?? (() => this.doc.defaultView?.crypto.randomUUID() ?? globalThis.crypto.randomUUID()))());
      this.status('Loading the selected native thread’s public history…');
      const response = await this.request(op, '/v1/codex/action', { requestId: op.requestId,
        connectionId: connection.connectionId, action: 'history-load', threadId: binding.threadId });
      if (!this.current(op)) return;
      const outcome = object(response.value), record = object(field(outcome, 'record'));
      if (field(record, 'requestId') !== op.requestId || field(record, 'connectionId') !== connection.connectionId ||
          field(record, 'action') !== 'history-load' || field(record, 'threadId') !== binding.threadId) invalid();
      if (!response.ok || field(record, 'state') !== 'acknowledged') throw new Error('Native history was not acknowledged. Read the recorded thread explicitly before another load.');
      const state = object(field(outcome, 'state'));
      if (field(state, 'projectPath') !== binding.projectPath) invalid();
      const loaded = validateHistoryBinding(field(state, 'nativeHistory'), binding.projectPath);
      if (!loaded || !sameBinding(binding, loaded) || loaded.recorded?.requestId !== op.requestId ||
          loaded.recorded.connectionId !== connection.connectionId || loaded.recorded.provenance !== connection.provenance) invalid();
      this.known = loaded; this.render(loaded); this.notice('Private reasoning is excluded. This recording does not grant execution permissions.');
    } catch (error) {
      if (this.current(op)) {
        if (op.sent) this.knownFresh = false;
        this.render(binding); this.notice(op.sent ? `Native history acknowledgement was not verified. Request: ${op.requestId}. Read the recorded thread explicitly; no request is replayed automatically.` :
          error instanceof HistoryControlError ? error.message : 'The project or thread binding could not be verified. Read the recorded thread again.');
      }
    } finally { this.finish(op); }
  }
  private render(binding: HistoryBinding): void {
    this.el('entries').replaceChildren(); this.el('gaps').replaceChildren();
    const recorded = binding.recorded;
    if (!recorded) { this.status('No public history has been recorded for this thread.'); return; }
    const result = recorded.result;
    for (const entry of result.entries) {
      const article = this.make('article', '', 'codex-history-entry');
      const sender = entry.role === 'user' ? 'User' : entry.role === 'assistant' ? 'Codex' : 'Tool';
      article.append(this.make('strong', sender, 'codex-history-sender'),
        this.make('p', `Native thread: ${entry.ids.threadId} · Turn: ${entry.ids.turnId} · Item: ${entry.ids.itemId} · Session: ${entry.ids.sessionId ?? 'not recorded'}`, 'codex-history-meta'),
        this.make('pre', entry.text, 'codex-history-text'));
      this.el('entries').append(article);
    }
    if (result.marker) this.el('gaps').append(this.make('p', result.marker, 'codex-history-incomplete'));
    for (const gap of result.gaps) this.el('gaps').append(this.make('p',
      `Omitted: ${gap.reason}${gap.turnId ? ' · Turn: ' + gap.turnId : ''}${gap.itemId ? ' · Item: ' + gap.itemId : ''}`, 'codex-history-gap'));
    if (result.droppedGaps) this.el('gaps').append(this.make('p', `Additional gap details omitted: ${result.droppedGaps}.`));
    if (!result.entries.length) this.el('entries').append(this.make('p', result.completeness === 'complete' ? 'No public text entries in this recording.' : 'No public text entries could be shown.'));
    this.status(`Recorded history: ${result.entries.length} public text entries · ${result.completeness === 'complete' ? 'Public history complete' : 'History incomplete'} · Loaded: ${recorded.loadedAt} · Source: ${recorded.provenance} · Private items excluded: ${result.excludedItems}${result.redacted ? ' · Credentials redacted' : ''}`);
  }
}
