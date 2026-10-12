/// <reference lib="dom" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  CodexHistoryPanel, CODEX_HISTORY_IDS, HISTORY_UI_LIMITS, HISTORY_INCOMPLETE_MARKER,
  validateHistoryBinding, validateHistoryResult, type HistoryBinding, type HistoryEntry,
  type HistoryResult, type CodexHistoryOptions,
} from '../../apps/desktop/src/codex-history.js';

const TOKEN = 'a'.repeat(64), PROJECT = 'C:\\Arcane', THREAD = 'native-thread', SESSION = 'native-session';
const CONNECTION = '00000000-0000-4000-8000-000000000001', REQUEST = '00000000-0000-4000-8000-000000000002';
const AT = '2026-10-12T12:00:00.000Z';
const clone = <T>(value: T): T => structuredClone(value);
function entry(role: HistoryEntry['role'] = 'assistant', text = 'Recorded public text.', turnId = 'native-turn', itemId = 'native-item'): HistoryEntry {
  return { role, text, ids: { threadId: THREAD, sessionId: SESSION, turnId, itemId } };
}
function result(patch: Partial<HistoryResult> = {}): HistoryResult {
  return { entries: [entry('user', 'Recorded question.', 'native-turn', 'question'), entry(), entry('tool', 'Public tool output.', 'native-turn', 'tool')],
    completeness: 'complete', gaps: [], truncated: false, marker: null, excludedItems: 1, droppedGaps: 0, redacted: false, ...patch };
}
function binding(patch: Partial<HistoryBinding> = {}): HistoryBinding {
  return { projectPath: PROJECT, threadId: THREAD, sessionId: SESSION,
    recorded: { requestId: REQUEST, connectionId: CONNECTION, provenance: 'spawned-node-fixture', loadedAt: AT, result: result() }, ...patch };
}
function state(known: HistoryBinding | null = binding()) {
  return { provider: 'codex', use: 'personal-local', projectPath: PROJECT, connecting: false, closing: false, busy: false,
    nativeHistory: known, snapshot: { connectionId: CONNECTION, connected: true, ready: true, provenance: 'spawned-node-fixture',
      thread: { threadId: THREAD, sessionId: SESSION },
      events: [{ type: 'delta', text: 'CURRENT_STREAM_MUST_STAY_SEPARATE' }], approvals: [{ reason: 'PRIVATE_APPROVAL' }] },
    lastSnapshot: { events: [{ text: 'OLD_STREAM_MUST_STAY_SEPARATE' }] }, actions: [] };
}

// A small explicit DOM fixture models trusted human events separately from
// synthetic dispatch. HTML sinks fail; tests never launch a daemon or provider.
class ElementFixture {
  readonly nodeType = 1;
  children: ElementFixture[] = [];
  value = ''; type = ''; disabled = false; className = ''; id = '';
  private content = '';
  private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  private readonly attributes = new Map<string, string>();
  constructor(readonly ownerDocument: DocumentFixture, readonly tagName: string) {}
  get textContent(): string { return this.content + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.replaceChildren(); this.content = value; }
  set innerHTML(_value: string) { assert.fail('HTML sink used'); }
  get innerHTML(): never { throw new Error('HTML sink used'); }
  append(...children: ElementFixture[]): void { this.children.push(...children); }
  replaceChildren(...children: ElementFixture[]): void { this.content = ''; this.children = [...children]; }
  setAttribute(key: string, value: string): void { this.attributes.set(key, value); }
  getAttribute(key: string): string | null { return this.attributes.get(key) ?? null; }
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void { this.listeners.get(type)?.delete(listener); }
  dispatchEvent(event: Event): boolean {
    for (const listener of this.listeners.get(event.type) ?? []) typeof listener === 'function' ? listener(event) : listener.handleEvent(event);
    return !event.defaultPrevented;
  }
  human(type: string): void {
    if (this.disabled) return;
    this.dispatchEvent({ type, isTrusted: true, preventDefault() {} } as unknown as Event);
  }
  all(): ElementFixture[] { return this.children.flatMap(child => [child, ...child.all()]); }
  querySelector(selector: string): ElementFixture | null {
    const match = /^\[id="([A-Za-z][A-Za-z0-9_-]*)"\]$/.exec(selector); assert.ok(match);
    return this.all().find(child => child.id === match[1]) ?? null;
  }
}
class DocumentFixture {
  readonly nodeType = 9;
  readonly defaultView = new EventTarget();
  readonly elements = new Map<string, ElementFixture>();
  createElement(tag: string): ElementFixture { return new ElementFixture(this, tag.toUpperCase()); }
  getElementById(id: string): ElementFixture | null { return this.elements.get(id) ?? null; }
  el(key: keyof typeof CODEX_HISTORY_IDS): ElementFixture { const value = this.getElementById(CODEX_HISTORY_IDS[key]); assert.ok(value); return value; }
}
interface Call { path: string; init: RequestInit; body: Record<string, unknown> | null }
function fixture(known: HistoryBinding | null = binding(), options: Partial<CodexHistoryOptions> = {}) {
  const doc = new DocumentFixture(), root = doc.createElement('section');
  for (const [key, id] of Object.entries(CODEX_HISTORY_IDS)) {
    const element = doc.createElement(key === 'refresh' || key === 'load' ? 'button' : key === 'thread' ? 'select' : 'div');
    element.id = id; doc.elements.set(id, element); root.append(element);
  }
  const live = doc.createElement('div'); live.id = 'codex-messages'; live.textContent = 'Existing live transcript'; doc.elements.set(live.id, live);
  const calls: Call[] = [];
  let token = TOKEN, projectPath = PROJECT, current = state(clone(known)), tokenReads = 0, projectReads = 0;
  let handler: (call: Call) => Promise<Response> = async call => {
    if (call.path === '/v1/codex/history') return Response.json({ nativeHistory: known });
    if (call.path === '/v1/codex/state') return Response.json({ state: current });
    assert.equal(call.path, '/v1/codex/action'); const native = clone(known); assert.ok(native);
    native.recorded = { requestId: String(call.body!.requestId), connectionId: String(call.body!.connectionId),
      provenance: 'spawned-node-fixture', loadedAt: AT, result: result({ entries: [entry('assistant', 'Fresh recorded answer.')] }) };
    return Response.json({ record: { ...call.body, state: 'acknowledged' }, replayed: false,
      state: { ...current, nativeHistory: native } });
  };
  const panel = new CodexHistoryPanel(root as unknown as HTMLElement, {
    getToken: () => { tokenReads++; return token; }, getProjectPath: () => { projectReads++; return projectPath; },
    requestId: () => REQUEST, transport: async (path, init) => {
      const call = { path: String(path), init: init!, body: init!.body ? JSON.parse(String(init!.body)) as Record<string, unknown> : null };
      calls.push(call); return handler(call);
    }, ...options,
  });
  return { doc, root, live, panel, calls, setToken: (value: string) => { token = value; }, setProject: (value: string) => { projectPath = value; },
    setState: (value: typeof current) => { current = value; }, getState: () => current,
    setHandler: (value: typeof handler) => { handler = value; }, reads: () => ({ tokenReads, projectReads }) };
}
async function settled(predicate: () => boolean): Promise<void> {
  for (let n = 0; n < 150; n++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 2)); } assert.fail('Fixture did not settle');
}
async function refresh(f: ReturnType<typeof fixture>): Promise<void> {
  f.doc.el('refresh').human('click'); await settled(() => !f.doc.el('refresh').disabled);
}
function select(f: ReturnType<typeof fixture>): void { f.doc.el('thread').value = THREAD; f.doc.el('thread').human('change'); }
async function load(f: ReturnType<typeof fixture>): Promise<void> { f.doc.el('load').human('click'); await settled(() => !f.doc.el('refresh').disabled); }

for (const documentRoot of [false, true]) test(`mount/start/resume are inert (${documentRoot ? 'Document' : 'element'} root) and stop disposes safely`, async () => {
  const f = fixture();
  const panel = documentRoot ? new CodexHistoryPanel(f.doc as unknown as Document, {
    getToken: () => { assert.fail('Startup token read'); }, getProjectPath: () => { assert.fail('Startup project read'); },
    transport: async () => { assert.fail('Startup request'); },
  }) : f.panel;
  panel.start(); panel.start(); panel.resume(); await new Promise(resolve => setTimeout(resolve, 15));
  assert.deepEqual(f.reads(), { tokenReads: 0, projectReads: 0 }); assert.equal(f.calls.length, 0);
  assert.equal(f.doc.el('entries').children.length, 0); assert.equal(f.doc.el('load').disabled, true);
  assert.equal(f.doc.el('refresh').type, 'button'); assert.equal(f.doc.el('load').type, 'button');
  assert.match(f.doc.el('status').textContent, /not been read/);
  panel.stop(); panel.resume(); panel.dispose(); panel.resume(); f.doc.el('refresh').human('click');
  assert.equal(f.calls.length, 0); assert.equal(f.live.textContent, 'Existing live transcript');
});

test('trusted refresh admits only the singleton recorded binding, exact relative human API and no automatic load', async () => {
  const f = fixture(); f.panel.start(); await refresh(f);
  assert.equal(f.calls.length, 1); const call = f.calls[0]!;
  assert.equal(call.path, '/v1/codex/history'); assert.equal(call.init.method, 'GET'); assert.equal(call.body, null);
  assert.deepEqual(call.init.headers, { Authorization: 'Bearer ' + TOKEN });
  for (const [key, value] of Object.entries({ credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-store', mode: 'same-origin' })) assert.equal((call.init as Record<string, unknown>)[key], value);
  assert.ok(call.init.signal); assert.equal(f.doc.el('thread').children.length, 2); assert.equal(f.doc.el('thread').value, '');
  assert.equal(f.doc.el('entries').children.length, 0); assert.equal(f.doc.el('load').disabled, true);
  select(f); assert.equal(f.calls.length, 1); assert.equal(f.doc.el('entries').children.length, 3);
  assert.match(f.doc.el('scope').textContent, /Project: C:\\Arcane/); assert.match(f.doc.el('status').textContent, /spawned-node-fixture/); f.panel.dispose();
});

test('synthetic refresh/load/change and forged selections never fetch, even while controls are enabled', async () => {
  const f = fixture(); f.panel.start();
  for (const key of ['refresh', 'load', 'thread'] as const) f.doc.el(key).dispatchEvent(new Event(key === 'thread' ? 'change' : 'click'));
  assert.equal(f.calls.length, 0); await refresh(f);
  f.doc.el('thread').value = THREAD; f.doc.el('thread').dispatchEvent(new Event('change'));
  f.doc.el('load').human('click'); assert.equal(f.calls.length, 1);
  select(f); f.doc.el('load').dispatchEvent(new Event('click')); assert.equal(f.calls.length, 1);
  f.doc.el('thread').value = 'foreign-thread'; f.doc.el('load').human('click'); assert.equal(f.calls.length, 1); f.panel.dispose();
});

test('exact selected load checks existing connection then posts only history-load and validates its scoped acknowledgement', async () => {
  const f = fixture(); f.panel.start(); await refresh(f); select(f); await load(f);
  assert.deepEqual(f.calls.map(call => call.path), ['/v1/codex/history', '/v1/codex/state', '/v1/codex/action']);
  assert.deepEqual(f.calls[2]!.body, { requestId: REQUEST, connectionId: CONNECTION, action: 'history-load', threadId: THREAD });
  assert.equal((f.calls[2]!.init.headers as Record<string, string>)['Content-Type'], 'application/json');
  assert.equal(f.doc.el('entries').children.length, 1); assert.match(f.doc.el('entries').textContent, /Fresh recorded answer/);
  assert.match(f.doc.el('entries').textContent, /CodexNative thread: native-thread · Turn: native-turn · Item: native-item · Session: native-session/);
  assert.ok(!f.root.textContent.includes('CURRENT_STREAM_MUST_STAY_SEPARATE')); assert.ok(!f.root.textContent.includes('OLD_STREAM_MUST_STAY_SEPARATE'));
  assert.ok(!f.root.textContent.includes('PRIVATE_APPROVAL')); assert.equal(f.live.textContent, 'Existing live transcript');
  await refresh(f); select(f); await load(f); assert.equal(f.doc.el('entries').children.length, 1); f.panel.dispose();
});

test('reconnection with no resumed thread/model can read the known binding without lifecycle actions', async () => {
  const f = fixture(); const st = f.getState(); st.snapshot!.thread = null as unknown as typeof st.snapshot.thread; f.setState(st);
  f.panel.start(); await refresh(f); select(f); await load(f);
  assert.equal(f.calls.filter(call => call.body).length, 1); assert.equal(f.calls.at(-1)!.body!.action, 'history-load'); f.panel.dispose();
});

test('restart/offline cache is readable and a native load never connects or resumes automatically', async () => {
  const f = fixture(); const st = f.getState(); st.snapshot = null as unknown as typeof st.snapshot; f.setState(st);
  f.panel.start(); await refresh(f); select(f); assert.match(f.doc.el('entries').textContent, /Recorded public text/); await load(f);
  assert.deepEqual(f.calls.map(call => call.init.method), ['GET', 'GET']); assert.match(f.doc.el('notice').textContent, /Connect Codex explicitly/);
  assert.match(f.doc.el('entries').textContent, /Recorded public text/); f.panel.dispose();
});

test('null binding and unrecorded binding give honest empty states without reads or invented sample messages', async () => {
  for (const known of [null, binding({ recorded: null })]) {
    const f = fixture(known); f.panel.start(); await refresh(f);
    if (known) { select(f); assert.match(f.doc.el('status').textContent, /No public history has been recorded/); }
    else { assert.match(f.doc.el('status').textContent, /No native thread has been recorded/); assert.equal(f.doc.el('load').disabled, true); }
    assert.equal(f.doc.el('entries').children.length, 0); assert.equal(f.calls.length, 1); f.panel.dispose();
  }
});

test('plain text rendering preserves senders and IDs, does not interpret markup, and removes the host token', async () => {
  const known = binding(); known.recorded!.result.entries[1]!.text = '<img src=x onerror="throw 1"> <script>throw 2</script> ' + TOKEN;
  const f = fixture(known); f.panel.start(); await refresh(f); select(f);
  assert.match(f.doc.el('entries').textContent, /<script>throw 2<\/script>/); assert.ok(!f.root.textContent.includes(TOKEN));
  assert.match(f.doc.el('entries').textContent, /\[REDACTED\]/); assert.deepEqual(f.doc.el('entries').children.map(e => e.children[0]!.textContent), ['User', 'Codex', 'Tool']);
  assert.ok(!f.doc.el('entries').all().some(e => e.tagName === 'SCRIPT' || e.tagName === 'IMG')); f.panel.dispose();
});

test('gaps, truncation, dropped diagnostics, and excluded private items remain explicit without claiming full history', async () => {
  const known = binding(); known.recorded!.result = result({ completeness: 'complete', truncated: true,
    gaps: [{ reason: 'non-text-content', turnId: 'gap-turn', itemId: 'gap-item' }], droppedGaps: 7, redacted: true });
  const f = fixture(known); f.panel.start(); await refresh(f); select(f);
  assert.match(f.doc.el('status').textContent, /History incomplete/); assert.match(f.doc.el('status').textContent, /Private items excluded: 1/);
  assert.match(f.doc.el('status').textContent, /Credentials redacted/); assert.ok(f.doc.el('gaps').textContent.includes(HISTORY_INCOMPLETE_MARKER));
  assert.match(f.doc.el('gaps').textContent, /non-text-content · Turn: gap-turn · Item: gap-item/);
  assert.match(f.doc.el('gaps').textContent, /Additional gap details omitted: 7/); f.panel.dispose();
});

test('fully hydrated empty public history differs from empty incomplete history', async () => {
  for (const incomplete of [false, true]) {
    const known = binding(); known.recorded!.result = result({ entries: [], completeness: incomplete ? 'incomplete' : 'complete' });
    const f = fixture(known); f.panel.start(); await refresh(f); select(f);
    assert.match(f.doc.el('entries').textContent, incomplete ? /could be shown/ : /No public text entries in this recording/);
    assert.equal(f.doc.el('gaps').textContent.includes(HISTORY_INCOMPLETE_MARKER), incomplete); f.panel.dispose();
  }
});

test('projection rejects foreign project/thread/session, private/raw kinds, extras and getter-based payloads without traversal', () => {
  for (const known of [binding({ projectPath: 'C:\\Other' }), binding({ threadId: 'foreign' }), binding({ sessionId: 'foreign' })]) assert.throws(() => validateHistoryBinding(known, PROJECT));
  const privatePayload = { ...result(), reasoning: null };
  Object.defineProperty(privatePayload, 'reasoning', { get() { assert.fail('Private reasoning accessed'); } });
  assert.throws(() => validateHistoryResult(privatePayload, binding()));
  for (const role of ['reasoning', 'analysis', 'plan', 'delta']) assert.throws(() => validateHistoryResult({ ...result(), entries: [{ ...entry(), role }] }, binding()));
  for (const patch of [{ completeness: 'rejected' }, { marker: 'invented marker' }, { droppedGaps: -1 }, { excludedItems: 257 }, { gaps: [{ reason: 'private' }] }]) assert.throws(() => validateHistoryResult({ ...result(), ...patch }, binding()));
  const accessor = [entry()]; Object.defineProperty(accessor, '0', { get() { assert.fail('Array accessor invoked'); } });
  assert.throws(() => validateHistoryResult({ ...result(), entries: accessor }, binding()));
  const raw = { thread: { turns: [{ items: [{ type: 'reasoning', text: 'PRIVATE' }] }] } }; assert.throws(() => validateHistoryResult(raw, binding()));
});

test('bounds reject more than 256 entries, 64 distinct turns, 328 gaps, and 2 MiB UTF-8/escaped projected bytes', () => {
  for (const patch of [
    { entries: Array.from({ length: 257 }, (_, n) => entry('assistant', 'a', 'turn', 'item-' + n)) },
    { entries: Array.from({ length: 65 }, (_, n) => entry('assistant', 'a', 'turn-' + n, 'item')) },
    { gaps: Array.from({ length: 329 }, () => ({ reason: 'non-text-content' })) },
    { entries: [entry('assistant', 'é'.repeat(HISTORY_UI_LIMITS.maxHistoryBytes / 2))] },
    { entries: [entry('assistant', '\u0001'.repeat(HISTORY_UI_LIMITS.maxHistoryBytes / 5))] },
    { entries: [entry('assistant', 'x'.repeat(1_100_000), 'turn', 'first'), entry('assistant', 'x'.repeat(1_100_000), 'turn', 'second')] },
  ]) assert.throws(() => validateHistoryResult({ ...result(), ...patch }, binding()));
  const allowed = result({ entries: Array.from({ length: 256 }, (_, n) => entry('assistant', 'a', 'turn-' + n % 64, 'item-' + n)) });
  assert.equal(validateHistoryResult(allowed, binding()).entries.length, 256);
});

test('native IDs deduplicate identical snapshots, preserve repeated text across different IDs, and reject conflicts', () => {
  const first = entry(); const parsed = validateHistoryResult(result({ entries: [first, clone(first), entry('assistant', first.text, 'other-turn')] }), binding());
  assert.equal(parsed.entries.length, 2); first.text = 'mutated input'; assert.equal(parsed.entries[0]!.text, 'Recorded public text.');
  assert.throws(() => validateHistoryResult(result({ entries: [entry(), entry('assistant', 'Conflicting snapshot')] }), binding()));
});

test('invalid human tokens and absent/foreign projects refuse network requests on a trusted click', async () => {
  for (const token of ['', 'bad', TOKEN.toUpperCase(), TOKEN + '\r\nX-Test: bad']) {
    const f = fixture(); f.setToken(token); f.panel.start(); await refresh(f); assert.equal(f.calls.length, 0); assert.match(f.doc.el('notice').textContent, /valid human control/); f.panel.dispose();
  }
  const f = fixture(); f.setProject('relative'); f.panel.start(); await refresh(f); assert.equal(f.calls.length, 0); f.panel.dispose();
});

test('busy/unready/wrong-thread/wrong-session/changed binding cannot POST, and private transport errors never appear', async () => {
  for (const mutation of [
    (st: ReturnType<typeof state>) => { st.busy = true; },
    (st: ReturnType<typeof state>) => { st.snapshot!.ready = false; },
    (st: ReturnType<typeof state>) => { st.snapshot!.thread.threadId = 'foreign'; },
    (st: ReturnType<typeof state>) => { st.snapshot!.thread.sessionId = 'foreign'; },
    (st: ReturnType<typeof state>) => { st.nativeHistory!.threadId = 'foreign'; st.nativeHistory!.recorded = null; },
  ]) {
    const f = fixture(); const st = f.getState(); mutation(st); f.setState(st); f.panel.start(); await refresh(f); select(f); await load(f);
    assert.equal(f.calls.filter(call => call.body).length, 0); assert.match(f.doc.el('entries').textContent, /Recorded public text/); f.panel.dispose();
  }
  const f = fixture(); f.panel.start(); await refresh(f); select(f);
  f.setHandler(async () => { throw new Error('Connect Codex explicitly PRIVATE_TRANSPORT_ERROR'); }); await load(f);
  assert.ok(!f.root.textContent.includes('PRIVATE_TRANSPORT_ERROR')); f.panel.dispose();
});

test('wrong receipt IDs, missing acknowledgement, and swapped projection never replace the verified cached recording', async () => {
  for (const variant of ['request', 'connection', 'action', 'thread', 'pending', 'recorded-request', 'project', 'provenance', 'http-error']) {
    const f = fixture(); f.panel.start(); await refresh(f); select(f);
    f.setHandler(async call => {
      if (call.path === '/v1/codex/state') return Response.json({ state: state() });
      const native = binding(); native.recorded!.result.entries = [entry('assistant', 'UNVERIFIED_NEW_RECORDING')];
      const record: Record<string, unknown> = { ...call.body, state: 'acknowledged' };
      if (variant === 'request') record.requestId = CONNECTION;
      if (variant === 'connection') record.connectionId = REQUEST;
      if (variant === 'action') record.action = 'turn-start';
      if (variant === 'thread') record.threadId = 'foreign';
      if (variant === 'pending') record.state = 'pending';
      if (variant === 'recorded-request') native.recorded!.requestId = CONNECTION;
      if (variant === 'project') native.projectPath = 'C:\\Other';
      if (variant === 'provenance') native.recorded!.provenance = 'installed-cli';
      return Response.json({ record, state: { ...state(native) } }, { status: variant === 'http-error' ? 409 : 200 });
    });
    await load(f); assert.ok(!f.root.textContent.includes('UNVERIFIED_NEW_RECORDING')); assert.match(f.doc.el('entries').textContent, /Recorded public text/);
    assert.match(f.doc.el('notice').textContent, new RegExp(REQUEST)); assert.equal(f.doc.el('load').disabled, true);
    f.doc.el('load').human('click'); assert.equal(f.calls.length, 3); f.panel.dispose();
  }
});

test('MIME, advertised/streamed byte caps, malformed UTF-8 and redirects fail closed and cancel the response body', async () => {
  let cancelled = 0;
  const bad = [
    () => new Response('{"nativeHistory":null}', { headers: { 'Content-Type': 'text/html' } }),
    () => new Response('{"nativeHistory":null}', { headers: { 'Content-Type': 'application/json', 'Content-Length': 'bad' } }),
    () => new Response('{"nativeHistory":null}', { headers: { 'Content-Type': 'application/json', 'Content-Length': String(HISTORY_UI_LIMITS.maxResponseBytes + 1) } }),
    () => new Response(new Uint8Array([0xc3, 0x28]), { headers: { 'Content-Type': 'application/json' } }),
    () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(HISTORY_UI_LIMITS.maxResponseBytes + 1)); }, cancel() { cancelled++; } }), { headers: { 'Content-Type': 'application/json' } }),
    () => { const response = Response.json({ nativeHistory: binding() }); Object.defineProperty(response, 'redirected', { value: true }); return response; },
  ];
  for (const response of bad) {
    const f = fixture(); f.setHandler(async () => response()); f.panel.start(); await refresh(f);
    assert.equal(f.doc.el('entries').children.length, 0); assert.equal(f.doc.el('thread').disabled, true); assert.match(f.doc.el('status').textContent, /could not be read/); f.panel.dispose();
  }
  assert.equal(cancelled, 1);
});

test('stop/pagehide/timeout settle even when transport ignores abort; late replies cannot repopulate or POST', async () => {
  for (const reason of ['stop', 'pagehide', 'timeout']) {
    const f = fixture(binding(), { deadlineMs: reason === 'timeout' ? 10 : 1000 });
    let release!: (response: Response) => void; f.setHandler(() => new Promise(resolve => { release = resolve; }));
    f.panel.start(); f.doc.el('refresh').human('click'); assert.equal(f.calls.length, 1);
    if (reason === 'stop') f.panel.stop();
    if (reason === 'pagehide') f.doc.defaultView.dispatchEvent(new Event('pagehide'));
    await settled(() => reason === 'timeout' ? !f.doc.el('refresh').disabled : f.doc.el('refresh').disabled);
    release(Response.json({ nativeHistory: binding() })); await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(f.doc.el('entries').children.length, 0); assert.equal(f.doc.el('thread').children.length, 1); assert.equal(f.calls.length, 1);
    f.panel.resume(); assert.equal(f.calls.length, 1); f.panel.dispose();
  }
});

test('project/control changes during a request or before selection clear stale scope without another request', async () => {
  for (const change of ['project', 'token']) {
    const f = fixture(); f.panel.start(); await refresh(f);
    if (change === 'project') f.setProject('C:\\Other'); else f.setToken('b'.repeat(64));
    select(f); assert.equal(f.doc.el('entries').children.length, 0); assert.equal(f.doc.el('load').disabled, true); assert.equal(f.calls.length, 1); f.panel.dispose();
  }
  const f = fixture(); f.panel.start(); await refresh(f); select(f);
  let release!: (response: Response) => void; f.setHandler(() => new Promise(resolve => { release = resolve; }));
  f.doc.el('load').human('click'); f.setProject('C:\\Other'); release(Response.json({ state: state() }));
  await settled(() => !f.doc.el('refresh').disabled); assert.equal(f.calls.length, 2); assert.equal(f.doc.el('entries').children.length, 0); f.panel.dispose();
});

test('duplicate clicks stay single-flight, pending native read stop exposes uncertainty and never replays', async () => {
  const f = fixture(); f.panel.start(); await refresh(f); select(f);
  let release!: (response: Response) => void;
  f.setHandler(async call => call.path === '/v1/codex/state' ? Response.json({ state: state() }) : new Promise(resolve => { release = resolve; }));
  f.doc.el('load').human('click'); f.doc.el('load').human('click'); await settled(() => f.calls.length === 3);
  f.panel.stop(); assert.match(f.doc.el('notice').textContent, /not received/); f.panel.resume();
  assert.equal(f.calls.length, 3); release(Response.json({ record: {}, state: state() })); await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(f.doc.el('entries').children.length, 0); assert.equal(f.calls.length, 3); f.panel.dispose();
});

test('required controls resolve atomically; element IDs can be overridden without CSS/HTML routing changes', () => {
  const f = fixture(); f.doc.elements.delete(CODEX_HISTORY_IDS.gaps);
  assert.throws(() => new CodexHistoryPanel(f.doc as unknown as Document, { getToken: () => TOKEN, getProjectPath: () => PROJECT }).start(), /Missing native history/);
  f.doc.el('refresh').human('click'); assert.equal(f.calls.length, 0);
  const renamed = fixture(); const ids = Object.fromEntries(Object.entries(CODEX_HISTORY_IDS).map(([key, id]) => [key, 'alternate-' + id]));
  for (const [key, id] of Object.entries(ids)) { const element = renamed.doc.el(key as keyof typeof CODEX_HISTORY_IDS); element.id = id; renamed.doc.elements.set(id, element); }
  const panel = new CodexHistoryPanel(renamed.root as unknown as HTMLElement, { getToken: () => TOKEN, getProjectPath: () => PROJECT, ids });
  panel.start(); assert.equal(renamed.calls.length, 0); panel.dispose();
});

test('browser source has no runtime imports, account enumeration, live transcript inputs, model/lifecycle actions or HTML sinks', async () => {
  const root = process.env.ARCANE_HISTORY_UI_SOURCE_ROOT;
  if (!root) return; // Optional source audit when focused compiled output is outside the checkout.
  const source = await readFile(root + '/apps/desktop/src/codex-history.ts', 'utf8');
  assert.ok(!/^import\s/m.test(source));
  for (const prohibited of ['innerHTML', 'insertAdjacentHTML', 'EventSource', 'setInterval', 'thread/list', 'thread/resume', 'turn/start', 'account/read', 'model/list', '/v1/codex/actions', 'codex-messages', 'auth.json', '.jsonl']) assert.ok(!source.includes(prohibited), prohibited);
});
