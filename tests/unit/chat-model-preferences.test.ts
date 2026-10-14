/// <reference lib="dom" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { CodexChat, CodexChatApi, type ChatAction, type ChatActionRecord, type ChatState } from '../../apps/desktop/src/codex-chat.js';
import { ChatTabs, nativeChatKey, type ChatSelection, type ChatTabPreferences } from '../../apps/desktop/src/chat-tabs.js';
import { workflowNativeModel } from '../../apps/daemon/src/workflow-native-model.js';

// Offline synthetic controller/services only. These unit seams do not prove UI
// access; composer-model-picker exercises the visible controls in actual Edge.
const TOKEN = 'a'.repeat(64), PROJECT = resolve('.');
const actual = { model: 'fixture-alpha', effort: 'low' };
const preferred = { model: 'fixture-beta', effort: 'high' };
const tick = () => new Promise<void>(done => setImmediate(done));
class ElementFixture extends EventTarget {
  tagName = 'DIV'; id = ''; value = ''; checked = false; disabled = false; hidden = false; open = false;
  type = ''; className = ''; title = ''; tabIndex = 0; dataset: Record<string, string> = {};
  children: ElementFixture[] = []; scrollHeight = 0; scrollTop = 0; clientHeight = 0;
  private content = ''; private attributes = new Map<string, string>();
  get textContent(): string { return this.content + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.content = value; this.children = []; }
  append(...children: ElementFixture[]) { this.children.push(...children); }
  replaceChildren(...children: ElementFixture[]) { this.content = ''; this.children = children; }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  querySelectorAll(): ElementFixture[] { return []; }
  querySelector() { return null; }
  contains() { return false; }
  after() {} remove() {} focus() {} showModal() { this.open = true; } close() { this.open = false; }
}
class DocumentFixture extends EventTarget {
  hidden = false; activeElement = null; private elements = new Map<string, ElementFixture>();
  constructor() { super(); this.getElementById('workspace-chat-tabs').setAttribute('role', 'tablist'); }
  getElementById(id: string) {
    let element = this.elements.get(id);
    if (!element) { element = new ElementFixture(); element.id = id; if (id === 'codex-composer') element.tagName = 'TEXTAREA'; this.elements.set(id, element); }
    return element;
  }
  createElement() { return new ElementFixture(); }
  asDocument() { return this as unknown as Document; }
}
function storageFixture() {
  const data = new Map<string, string>();
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
}
function state(active = false): ChatState {
  const result: ChatState = { provider: 'codex', use: 'personal-local', projectPath: PROJECT, connecting: false, closing: false, busy: active,
    actions: [], lastSnapshot: null, nativeTools: { configured: true, verified: false },
    nativeAssets: { available: true, sealed: true, granted: false, admissionOpen: false },
    snapshot: { connectionId: randomUUID(), provenance: 'spawned-node-fixture', connected: true, ready: true,
      account: { auth: 'subscription', plan: 'synthetic', requiresOpenaiAuth: true }, models: [
        { model: actual.model, id: 'opaque-alpha', displayName: 'Synthetic Alpha', efforts: ['low', 'ultra'], defaultEffort: 'low', entitlement: 'unverified' },
        { model: preferred.model, id: 'opaque-beta', displayName: 'Synthetic Beta', efforts: ['medium', 'high'], defaultEffort: 'high', entitlement: 'unverified' },
      ], selection: { ...actual }, thread: { threadId: 'owned-first', sessionId: 'session-first', configured: true, writeGranted: false,
        selection: { ...actual }, turnId: active ? 'exact-active-turn' : null, turnStatus: active ? 'inProgress' : 'idle' },
      operations: [], approvals: [], events: [], droppedEvents: 0, lastEventSeq: 0, failureCode: null },
    nativeThreads: ['first', 'second'].map(name => ({ provider: 'codex', projectPath: PROJECT, threadId: 'owned-' + name, sessionId: 'session-' + name, selection: { ...actual } })),
  };
  result.workflowModel = workflowNativeModel(result)!.proof; return result;
}
const callbacks = { select: async () => true, close: async () => true, newChat: async () => true, openSaved: async () => true };
function tabsFixture(t: test.TestContext, storage = storageFixture(), initial = state()) {
  const tabs = new ChatTabs(new DocumentFixture().asDocument(), value => value, callbacks, { storage });
  t.after(() => tabs.stop()); tabs.sync(initial); return { tabs, storage };
}
function record(input: ChatAction, status: ChatActionRecord['state']): ChatActionRecord {
  assert.ok(input.action === 'select' || input.action === 'turn-start');
  return { requestId: input.requestId, connectionId: input.connectionId, action: input.action,
    threadId: input.action === 'turn-start' ? input.threadId : null, turnId: null,
    model: input.action === 'select' ? input.model : null, effort: input.action === 'select' ? input.effort : null,
    state: status, errorCode: status === 'rejected' ? 'SYNTHETIC_REJECTED' : null,
    createdAt: new Date().toISOString(), finishedAt: ['acknowledged', 'rejected'].includes(status) ? new Date().toISOString() : null };
}
async function controllerFixture(t: test.TestContext, initial = state(true), storage = storageFixture()) {
  const doc = new DocumentFixture(), posts: ChatAction[] = [];
  let observed = structuredClone(initial), readFailed = false;
  let handler: ((input: ChatAction) => Promise<Response>) | null = null;
  const respond = (input: ChatAction, status: ChatActionRecord['state'] = 'acknowledged') => {
    const receipt = record(input, status);
    if (status === 'acknowledged' && input.action === 'select') {
      observed.snapshot!.selection = { model: input.model, effort: input.effort };
      observed.snapshot!.thread!.selection = { ...observed.snapshot!.selection };
      observed.nativeThreads![0]!.selection = { ...observed.snapshot!.selection };
      observed.workflowModel = workflowNativeModel(observed)!.proof;
    }
    if (status === 'acknowledged' && input.action === 'turn-start') { observed.snapshot!.thread!.turnId = 'synthetic-next-turn'; observed.snapshot!.thread!.turnStatus = 'inProgress'; }
    observed.actions = [receipt];
    return Response.json({ record: receipt, state: observed, replayed: false }, { status: status === 'acknowledged' ? 200 : status === 'rejected' ? 409 : 202 });
  };
  const chat = new CodexChat(doc.asDocument(), new CodexChatApi(TOKEN, async (path, init) => {
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer ' + TOKEN);
    if (init?.method === 'GET') { assert.equal(path, '/v1/codex/state'); if (readFailed) throw new Error('Synthetic read unavailable'); return Response.json({ state: observed }); }
    assert.equal(path, '/v1/codex/action'); const input = JSON.parse(String(init?.body)) as ChatAction; posts.push(input);
    assert.ok(input.action === 'select' || input.action === 'turn-start', 'Preference/Send cannot dispatch grants or other lifecycle actions');
    return handler ? handler(input) : respond(input);
  }));
  t.after(() => chat.stop()); await chat.enableChatTabs({ storage });
  // Direct controller seams are deliberate unit inputs, never a hidden-control
  // click presented as human access to the picker.
  const controller = chat as unknown as { dispatch(action: string, fields: Record<string, unknown>): Promise<void>; submitMessage(): Promise<void>; canSelectModel(): boolean };
  return { chat, doc, posts, storage, controller, respond, observed: () => structuredClone(observed),
    set: (next: ChatState) => { observed = structuredClone(next); }, fail: (value: boolean) => { readFailed = value; },
    handler: (value: typeof handler) => { handler = value; }, stage: (pair: ChatSelection = preferred) => controller.dispatch('select', { ...pair }) };
}

test('synthetic active task stages a per-chat preference while actual model, workflow provenance, drafts, attachments and grants remain exact', async t => {
  const initial = state(true); initial.snapshot!.thread!.writeGranted = true; initial.nativeAssets!.granted = true; initial.nativeAssets!.admissionOpen = true;
  const f = await controllerFixture(t, initial), actualTaskModel = f.chat.workflowModelSelection();
  const origin = { projectPath: PROJECT, projectId: 'c'.repeat(64), workflowId: 'synthetic-workflow', workflowRevision: 1, stepKey: 'requirements',
    conversation: { provider: 'codex' as const, threadId: 'owned-first', sessionId: 'session-first' }, model: actualTaskModel! };
  assert.equal(f.chat.appendWorkflowDraft('Pinned workflow instructions 🧩  ', origin), true);
  const draft = f.doc.getElementById('codex-composer').value;
  let cleared = 0; const attachment = { name: 'synthetic.txt', text: 'Exact attachment bytes.  ' };
  f.chat.enableTextAttachments({ syncScope() {}, prepareText: (text: string) => text + '\n' + attachment.text, clear() { cleared++; }, stop() {}, cleanup() {} } as unknown as Parameters<CodexChat['enableTextAttachments']>[0]);
  let contextChanges = 0; f.chat.subscribeWorkflowContextChange(() => contextChanges++);
  assert.equal(f.controller.canSelectModel(), true); await f.stage();
  for (let i = 0; i < 3; i++) await f.chat.refresh();
  assert.deepEqual(f.chat.currentStateView().activeChat!.selection, preferred);
  assert.deepEqual(f.chat.currentStateView().state!.snapshot!.thread!.selection, actual);
  assert.deepEqual(f.chat.workflowModelSelection(), actualTaskModel); assert.equal(contextChanges, 0);
  assert.equal(f.doc.getElementById('codex-composer').value, draft); assert.equal(cleared, 0);
  assert.equal(f.chat.currentStateView().state!.snapshot!.thread!.writeGranted, true);
  assert.deepEqual(f.chat.currentStateView().state!.nativeAssets, initial.nativeAssets);
  assert.deepEqual(f.posts, []); assert.equal(f.doc.getElementById('codex-draft-review').hidden, true);
  const reloaded = await controllerFixture(t, initial, f.storage);
  assert.deepEqual(reloaded.chat.currentStateView().activeChat!.selection, preferred);
  assert.deepEqual(reloaded.chat.workflowModelSelection(), actualTaskModel); assert.deepEqual(reloaded.posts, []);
});

test('synthetic two owned chats retain separate preferences through stale catalogues, reload and actual ACK convergence', t => {
  const initial = state(), f = tabsFixture(t, undefined, initial), first = f.tabs.active()!.key;
  f.tabs.updateDraft('First draft 🧩  ', preferred); f.tabs.sync(initial);
  const second = f.tabs.ensureSaved('owned-second')!; assert.ok(second); assert.equal(f.tabs.activate(second.key), true);
  const other = { model: actual.model, effort: 'ultra' }; f.tabs.updateDraft('Second draft\n  ', other); f.tabs.sync(initial);
  assert.equal(f.tabs.hasPreferredSelection(), true);
  const reloaded = tabsFixture(t, f.storage, initial).tabs;
  assert.deepEqual(reloaded.active()!.selection, other); assert.equal(reloaded.active()!.draft, 'Second draft\n  ');
  assert.equal(reloaded.activate(first), true); assert.deepEqual(reloaded.active()!.selection, preferred); assert.equal(reloaded.active()!.draft, 'First draft 🧩  ');
  const ack = structuredClone(initial); ack.nativeThreads![0]!.selection = { ...preferred }; reloaded.sync(ack);
  assert.equal(reloaded.hasPreferredSelection(), false, 'Native evidence agreeing with the preference consumes it');
  ack.nativeThreads![0]!.selection = { ...actual }; reloaded.sync(ack);
  assert.deepEqual(reloaded.active()!.selection, actual, 'After convergence, later actual evidence remains authoritative');
  reloaded.activate(second.key); assert.deepEqual(reloaded.active()!.selection, other); assert.equal(reloaded.hasPreferredSelection(), true);
});

test('synthetic signed-in restored owned unbound chat stages without native calls and never promotes preference to actual evidence', async t => {
  const initial = state(); initial.snapshot!.thread = null; delete initial.workflowModel;
  const persisted = storageFixture(), tabs = tabsFixture(t, persisted, initial).tabs;
  const saved = tabs.ensureSaved('owned-first')!; tabs.activate(saved.key); tabs.updateDraft('Saved unbound draft.  ', actual); tabs.stop();
  const f = await controllerFixture(t, initial, persisted);
  assert.equal(f.chat.currentStateView().activeChat!.kind, 'native'); assert.equal(f.chat.currentStateView().nativeBoundToActiveChat, false);
  assert.equal(f.controller.canSelectModel(), true); await f.stage(); await f.chat.refresh();
  assert.deepEqual(f.chat.currentStateView().activeChat!.selection, preferred); assert.equal(f.chat.workflowModelSelection(), null);
  assert.equal(f.chat.currentStateView().state!.snapshot!.thread, null); assert.deepEqual(f.posts, []);
  assert.equal(f.doc.getElementById('codex-composer').value, 'Saved unbound draft.  ');
  const removed = structuredClone(initial); removed.nativeThreads = []; f.set(removed); await f.chat.refresh();
  assert.equal(f.chat.currentStateView().activeChat!.kind, 'draft', 'Lost host ownership recovers text; stored IDs never authorize native work');
  assert.equal(f.chat.workflowModelSelection(), null); assert.deepEqual(f.posts, []);
});

test('synthetic explicit Send applies the staged pair metadata-only, waits for exact ACK and then starts one turn', async t => {
  const f = await controllerFixture(t); await f.stage();
  const idle = f.observed(); idle.busy = false; idle.snapshot!.thread!.turnStatus = 'interrupted'; f.set(idle); await f.chat.refresh();
  const draft = 'Explicit synthetic send 🧩  '; f.doc.getElementById('codex-composer').value = draft;
  let release!: () => void; const held = new Promise<void>(done => { release = done; }); t.after(() => release());
  f.handler(async input => { if (input.action === 'select') await held; return f.respond(input); });
  const send = f.controller.submitMessage(); await tick();
  assert.deepEqual(f.posts.map(input => input.action), ['select']); assert.deepEqual(f.posts[0], { requestId: f.posts[0]!.requestId, connectionId: idle.snapshot!.connectionId, action: 'select', ...preferred });
  assert.deepEqual(f.chat.currentStateView().state!.snapshot!.thread!.selection, actual);
  assert.equal(f.doc.getElementById('codex-composer').value, draft); await f.controller.submitMessage(); assert.equal(f.posts.length, 1);
  release(); await send;
  assert.deepEqual(f.posts.map(input => input.action), ['select', 'turn-start']);
  const turn = f.posts[1]!; assert.equal(turn.action, 'turn-start'); assert.equal(turn.threadId, 'owned-first'); assert.equal(turn.text, draft);
  assert.deepEqual(f.chat.currentStateView().state!.snapshot!.thread!.selection, preferred);
  assert.equal(f.chat.currentStateView().state!.snapshot!.thread!.writeGranted, false);
});

test('synthetic failed, rejected, pending and unknown preference ACKs preserve unsent draft and never start/replay a turn after refresh or reload', async t => {
  for (const outcome of ['rejected', 'pending', 'unknown', 'lost'] as const) {
    const f = await controllerFixture(t); await f.stage(); const idle = f.observed(); idle.busy = false; idle.snapshot!.thread!.turnStatus = 'idle'; f.set(idle); await f.chat.refresh();
    const draft = 'Keep every failed-send byte 🧩  '; f.doc.getElementById('codex-composer').value = draft;
    f.handler(async input => { if (outcome === 'lost') throw new Error('Synthetic acknowledgement lost'); return f.respond(input, outcome); });
    await f.controller.submitMessage(); await f.chat.refresh();
    assert.deepEqual(f.posts.map(input => input.action), ['select'], outcome); assert.equal(f.doc.getElementById('codex-composer').value, draft, outcome);
    assert.deepEqual(f.chat.currentStateView().state!.snapshot!.thread!.selection, actual, outcome);
    assert.deepEqual(f.chat.currentStateView().activeChat!.selection, preferred, outcome);
    const reloaded = await controllerFixture(t, f.observed(), f.storage); await reloaded.chat.refresh();
    assert.deepEqual(reloaded.posts, [], outcome + ': reload is read-only'); assert.deepEqual(reloaded.chat.currentStateView().activeChat!.selection, preferred);
    if (outcome === 'pending' || outcome === 'unknown') assert.equal(reloaded.controller.canSelectModel(), false, 'Unresolved service receipts survive reload');
  }
});

test('synthetic draft edit during select ACK prevents Send and workflow drafts retain actual-model provenance review', async t => {
  for (const mode of ['edit', 'workflow'] as const) {
    const f = await controllerFixture(t); await f.stage(); const idle = f.observed(); idle.busy = false; idle.snapshot!.thread!.turnStatus = 'idle'; f.set(idle); await f.chat.refresh();
    if (mode === 'workflow') assert.equal(f.chat.appendWorkflowDraft('Pinned to actual model.', { projectPath: PROJECT, projectId: 'c'.repeat(64), workflowId: 'synthetic-workflow', workflowRevision: 1, stepKey: 'requirements',
      conversation: { provider: 'codex', threadId: 'owned-first', sessionId: 'session-first' }, model: f.chat.workflowModelSelection()! }), true);
    else f.doc.getElementById('codex-composer').value = 'Original draft.  ';
    const original = f.doc.getElementById('codex-composer').value;
    let release!: () => void; const held = new Promise<void>(done => { release = done; }); t.after(() => release());
    f.handler(async input => { await held; return f.respond(input); }); const send = f.controller.submitMessage(); await tick();
    if (mode === 'edit') f.doc.getElementById('codex-composer').value += 'Human edit.  ';
    release(); await send;
    assert.deepEqual(f.posts.map(input => input.action), ['select'], mode);
    assert.equal(f.doc.getElementById('codex-composer').value, original + (mode === 'edit' ? 'Human edit.  ' : ''), mode);
    if (mode === 'workflow') { assert.equal(f.doc.getElementById('codex-draft-review').hidden, false); assert.equal(f.doc.getElementById('codex-submit').disabled, true); }
  }
});

test('synthetic preference picker fails closed on auth, stale reads, unknown receipts and unconfigured threads', async t => {
  const f = await controllerFixture(t);
  for (const auth of ['signed-out', 'unsupported', 'unknown'] as const) {
    const next = state(true); if (auth === 'unknown') next.snapshot!.account = null; else next.snapshot!.account!.auth = auth;
    delete next.workflowModel; f.set(next); await f.chat.refresh();
    assert.equal(f.controller.canSelectModel(), false, auth); await f.stage(); assert.deepEqual(f.posts, []);
  }
  const next = state(true); next.snapshot!.thread!.configured = false; delete next.workflowModel; f.set(next); await f.chat.refresh();
  assert.equal(f.controller.canSelectModel(), false); await f.stage(); assert.deepEqual(f.posts, []);
  f.set(state(true)); await f.chat.refresh(); f.fail(true); await f.chat.refresh();
  assert.equal(f.controller.canSelectModel(), false); await f.stage(); assert.deepEqual(f.posts, []);
});

test('synthetic asynchronous preference save failure retains staged model and draft with explicit persistence failure', async t => {
  const initial = state(), doc = new DocumentFixture(); let fail = false, saved: ChatTabPreferences | null = null;
  const tabs = new ChatTabs(doc.asDocument(), value => value, callbacks, { preferences: { read: async () => saved,
    save: async value => { await tick(); if (fail) throw new Error('Synthetic encrypted-preference save failed'); saved = structuredClone(value); } } });
  t.after(() => tabs.stop()); await tabs.initializePreferences(PROJECT); tabs.sync(initial); await tick(); await tick();
  fail = true; tabs.updateDraft('Unsent save failure draft 🧩  ', preferred); await tick(); await tick();
  assert.equal(tabs.persistenceStatus(), 'native-error'); assert.equal(tabs.preferencesSaved(), false);
  assert.deepEqual(tabs.active()!.selection, preferred); assert.equal(tabs.active()!.draft, 'Unsent save failure draft 🧩  ');
  tabs.sync(initial); assert.deepEqual(tabs.active()!.selection, preferred); assert.deepEqual(initial.snapshot!.thread!.selection, actual);
  assert.equal(tabs.active()!.key, nativeChatKey(initial.nativeThreads![0]!));
});
