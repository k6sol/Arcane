import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { CodexChat, CodexChatApi, type ChatState } from '../../apps/desktop/src/codex-chat.js';
import { createCodexService, type CodexAction, type CodexActionRecord, type CodexHostClient } from '../../apps/daemon/src/codex-service.js';
import { workflowNativeModel } from '../../apps/daemon/src/workflow-native-model.js';
import { CodexClientError, type Snapshot, type ThreadState } from '../../packages/codex-client/src/types.js';

// Adapted from chat-tabs-focused.test.ts: labelled SDK/document fixtures only.
// Real CodexChat binding methods, HTTP envelopes and durable service receipts;
// no installed native client, acceptance claim, external service or inference.
const TOKEN = 'a'.repeat(64);
const PAIR = { model: 'fixture-sol', effort: 'high' };
class Element extends EventTarget {
  tagName: string; id = ''; children: Element[] = []; value = ''; checked = false;
  disabled = false; hidden = false; open = false; className = ''; type = ''; title = '';
  tabIndex = 0; scrollHeight = 0; scrollTop = 0; clientHeight = 0;
  dataset: Record<string, string> = {}; private content = ''; private attributes = new Map<string, string>();
  private listeners = new Map<string, EventListenerOrEventListenerObject[]>();
  constructor(tag = 'div') { super(); this.tagName = tag.toUpperCase(); }
  get textContent(): string { return this.content + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.content = value; this.children = []; }
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.content = ''; this.children = children; }
  after(..._children: Element[]) {} remove() {} focus(_options?: unknown) {} contains(_value: unknown) { return false; }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  getAttribute(key: string) { return this.attributes.get(key) ?? null; }
  querySelectorAll(selector: string): Element[] { return this.children.flatMap(child => [...(selector === '[role=tab]' && child.getAttribute('role') === 'tab' ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector() { return null; } showModal() { this.open = true; } close() { this.open = false; }
  override addEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
    super.addEventListener(type, callback, options);
    if (callback) this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]);
  }
  // Trusted-shaped listener data is a document fixture, not a real browser event.
  human(type: string, fields: Record<string, unknown> = {}) {
    let prevented = false;
    const event = { type, isTrusted: true, button: 0, defaultPrevented: false, target: this,
      ...fields, preventDefault() { prevented = true; } } as unknown as Event;
    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === 'function') listener.call(this, event); else listener.handleEvent(event);
    }
    return prevented;
  }
}
class DocumentFixture extends EventTarget {
  hidden = false; activeElement: Element | null = null; private elements = new Map<string, Element>();
  constructor() { super(); this.getElementById('workspace-chat-tabs').setAttribute('role', 'tablist'); }
  getElementById(id: string): Element {
    let el = this.elements.get(id);
    if (!el) { el = new Element(id === 'codex-composer' ? 'textarea' : 'div'); el.id = id; this.elements.set(id, el); }
    return el;
  }
  createElement(tag: string) { return new Element(tag); }
  asDocument() { return this as unknown as Document; }
}
function snapshot(): Snapshot {
  return { connectionId: randomUUID(), provenance: 'spawned-node-fixture', connected: true, ready: true,
    account: { auth: 'subscription', plan: 'fixture', requiresOpenaiAuth: true }, models: [
      { model: 'fixture-sol', id: 'sol', displayName: 'Fixture Sol', efforts: ['low', 'high'], defaultEffort: 'low', entitlement: 'unverified' },
      { model: 'fixture-alt', id: 'alt', displayName: 'Fixture Alt', efforts: ['high'], defaultEffort: 'high', entitlement: 'unverified' },
    ], selection: null, thread: null, operations: [], approvals: [], events: [], droppedEvents: 0, lastEventSeq: 0, failureCode: null };
}
function deferred() {
  let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) { if (check()) return; await tick(); }
  assert.fail('Fixture did not reach the expected receipt/control state');
}

async function fixture(t: test.TestContext) {
  const temp = await realpath(tmpdir()), directory = await mkdtemp(join(temp, 'arcane-chat-send-fixture-'));
  await mkdir(join(directory, 'project')); const projectPath = await realpath(join(directory, 'project'));
  const actual = new Map<string, ThreadState>(), posts: CodexAction[] = [], receipts: CodexActionRecord[] = [];
  const trace: string[] = [], data = new Map<string, string>();
  let current: Snapshot | null = null, serial = 0;
  const controls = { gate: null as ReturnType<typeof deferred> | null, failure: null as 'rejected' | 'unknown' | null,
    loseStartReceipt: false, failRead: false, project: projectPath, attest: false };
  const service = createCodexService({ directory: join(directory, 'journal'), projectPath, nativeToolsConfigured: true,
    connect: async (): Promise<CodexHostClient> => {
      const s = snapshot(); current = s;
      return {
        snapshot: () => structuredClone(s),
        selectModel: action => { s.selection = { model: action.model, effort: action.effort }; if (s.thread) s.thread.selection = { ...s.selection }; return { ...s.selection }; },
        startThread: async () => {
          if (controls.gate) await controls.gate.promise;
          if (controls.failure) throw new CodexClientError('FIXTURE_START', 'Controlled start failure', controls.failure === 'unknown');
          const n = ++serial;
          const thread: ThreadState = { threadId: 'fixture-thread-' + n, sessionId: 'fixture-session-' + n,
            selection: { ...s.selection! }, configured: true, writeGranted: false, turnId: null, turnStatus: 'idle' };
          s.thread = thread; actual.set(thread.threadId, structuredClone(thread)); return structuredClone(thread);
        },
        resumeThread: async action => { const owned = actual.get(action.threadId); assert.ok(owned); s.thread = { ...structuredClone(owned), selection: { ...s.selection! }, writeGranted: false }; return structuredClone(s.thread); },
        readThreadHistory: async () => ({ entries: [], completeness: 'complete', gaps: [], truncated: false, marker: null, excludedItems: 0, droppedGaps: 0, redacted: false }),
        grantThreadWrites: () => { assert.fail('Send never grants workspace writes'); }, revokeThreadWrites: () => {},
        startTurn: async action => {
          assert.equal(action.initiatedBy, 'human'); assert.equal(action.threadId, s.thread?.threadId);
          assert.equal(s.thread!.writeGranted, false); assert.equal(s.thread!.turnStatus, 'idle');
          s.thread!.turnId = 'fixture-turn-' + (++serial); s.thread!.turnStatus = 'inProgress';
          return structuredClone(s.thread!);
        },
        interruptTurn: async action => { assert.equal(action.turnId, s.thread!.turnId); s.thread!.turnStatus = 'interrupted'; },
        respondApproval: () => { assert.fail('Send never answers approvals'); },
        close: async () => { s.connected = false; s.ready = false; },
      };
    },
  });
  const act = (action: string, fields: Record<string, unknown> = {}) => service.action({ requestId: randomUUID(),
    connectionId: action === 'connect' ? null : service.state().snapshot!.connectionId, action, ...fields });
  await act('connect');
  const doc = new DocumentFixture();
  const projectState = (state: ChatState) => {
    state.projectPath = controls.project;
    if (state.nativeHistory) state.nativeHistory.projectPath = controls.project;
    for (const row of state.nativeThreads ?? []) row.projectPath = controls.project;
    if (controls.attest) state.workflowModel = workflowNativeModel(state)?.proof ?? null;
    return state;
  };
  const api = new CodexChatApi(TOKEN, async (path, init) => {
    if (path === '/v1/codex/state') {
      assert.equal(init?.method, 'GET'); if (controls.failRead) throw new Error('Controlled stale read');
      return Response.json({ state: projectState(service.state()) });
    }
    assert.equal(path, '/v1/codex/action'); assert.equal(init?.method, 'POST');
    const input = JSON.parse(String(init?.body)) as CodexAction; posts.push(input); trace.push('post:' + input.action);
    if (input.action === 'turn-start') assert.ok(service.state().actions.some(record =>
      ['thread-start', 'thread-resume'].includes(record.action) && record.threadId === input.threadId && record.state === 'acknowledged'), 'a durable binding receipt precedes the turn');
    const outcome = await service.action(input); receipts.push(outcome.record); trace.push(outcome.record.state + ':' + input.action);
    if (input.action === 'thread-start' && controls.loseStartReceipt) throw new Error('Controlled lost HTTP receipt');
    return Response.json({ ...outcome, state: projectState(outcome.state) },
      { status: outcome.record.state === 'acknowledged' ? 200 : outcome.record.state === 'rejected' ? 409 : 202 });
  });
  const chat = new CodexChat(doc.asDocument(), api);
  t.after(async () => {
    controls.gate?.release(); chat.stop(); await service.close();
    const child = relative(temp, resolve(directory));
    assert.ok(!isAbsolute(child) && child.startsWith('arcane-chat-send-fixture-') && !child.includes('..'));
    await rm(directory, { recursive: true, force: true });
  });
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
  return { chat, doc, service, controls, posts, receipts, trace, data, act, storage,
    current: () => { assert.ok(current); return current; },
    mount: async () => { await chat.enableChatTabs({ storage }); await chat.start(); },
    text: (value: string) => { doc.getElementById('codex-composer').value = value; doc.getElementById('codex-composer').dispatchEvent(new Event('input')); },
    pair: (model = PAIR.model, effort = PAIR.effort) => {
      doc.getElementById('codex-model').value = model; doc.getElementById('codex-model').dispatchEvent(new Event('change'));
      doc.getElementById('codex-effort').value = effort; doc.getElementById('codex-effort').dispatchEvent(new Event('change'));
      doc.getElementById('codex-select').dispatchEvent(new Event('click'));
    },
    // Await the existing private method; never replace submit/start/bind/dispatch.
    submit: () => (chat as unknown as { submitMessage(): Promise<void> }).submitMessage(),
  };
}

test('valid signed-in local draft enables Send; the form binds via real receipts before one exact turn', async t => {
  const f = await fixture(t); await f.mount();
  const button = f.doc.getElementById('codex-submit');
  assert.equal(button.disabled, true); f.text('  Send this public draft 🧩\nunchanged.  ');
  assert.equal(button.disabled, true, 'typing alone cannot choose a model');
  f.pair(); assert.equal(button.disabled, false); assert.equal(f.current().selection, null);
  assert.equal(f.chat.currentStateView().activeChat!.kind, 'draft'); assert.equal(f.posts.length, 0);
  await f.chat.refresh(); assert.equal(f.posts.length, 0, 'startup, staging and refresh never start a chat or turn');
  f.doc.getElementById('codex-compose').human('submit');
  await until(() => f.receipts.some(record => record.action === 'turn-start'));
  assert.deepEqual(f.posts.map(post => post.action), ['select', 'thread-start', 'turn-start']);
  assert.deepEqual(f.current().thread!.selection, PAIR); assert.equal(f.chat.currentStateView().nativeBoundToActiveChat, true);
  const turn = f.posts.find(post => post.action === 'turn-start')!;
  assert.equal(turn.text, '  Send this public draft 🧩\nunchanged.  '); assert.equal(turn.threadId, f.current().thread!.threadId);
  assert.ok(f.trace.indexOf('acknowledged:thread-start') < f.trace.indexOf('post:turn-start'));
  assert.equal(new Set(f.posts.map(post => post.requestId)).size, f.posts.length);
  assert.ok(f.receipts.every(record => record.state === 'acknowledged')); assert.equal(f.doc.getElementById('codex-composer').value, '');
});

test('duplicate Send during pending setup cannot create a second POST or change its tab', async t => {
  const f = await fixture(t); await f.mount(); const other = f.chat.chatTabsView()[0]!.key;
  await f.chat.newChat(); f.pair(); f.text('One pending message'); f.controls.gate = deferred();
  const first = f.submit(); await until(() => f.posts.some(post => post.action === 'thread-start'));
  assert.equal(f.doc.getElementById('codex-submit').disabled, true);
  const before = f.posts.length; await f.submit();
  assert.equal(await f.chat.newChat(), false); assert.equal(await f.chat.selectChat(other), false);
  assert.equal(await f.chat.closeChat(f.chat.currentStateView().activeChat!.key), false);
  assert.equal(f.posts.length, before); assert.ok(!f.posts.some(post => post.action === 'turn-start'));
  assert.equal(f.service.state().actions.find(record => record.action === 'thread-start')!.state, 'pending');
  f.controls.gate.release(); await first;
  assert.equal(f.posts.filter(post => post.action === 'thread-start').length, 1);
  assert.equal(f.posts.filter(post => post.action === 'turn-start').length, 1);
});

test('textarea Enter uses setup-before-send; Shift+Enter and IME Enter never send', async t => {
  const f = await fixture(t); await f.mount(); f.pair(); f.text('Keyboard draft 🧩');
  const composer = f.doc.getElementById('codex-composer');
  for (const fields of [{ shiftKey: true }, { isComposing: true }, { keyCode: 229 },
    { altKey: true }, { ctrlKey: true }, { metaKey: true }]) {
    assert.equal(composer.human('keydown', { key: 'Enter', ...fields }), false);
    await tick(); assert.equal(f.posts.length, 0); assert.equal(composer.value, 'Keyboard draft 🧩');
  }
  f.controls.gate = deferred(); assert.equal(composer.human('keydown', { key: 'Enter' }), true);
  await until(() => f.posts.some(post => post.action === 'thread-start'));
  composer.human('keydown', { key: 'Enter' }); f.doc.getElementById('codex-compose').human('submit');
  assert.equal(f.posts.filter(post => post.action === 'thread-start').length, 1);
  f.controls.gate.release(); await until(() => f.receipts.some(record => record.action === 'turn-start'));
  assert.deepEqual(f.posts.map(post => post.action), ['select', 'thread-start', 'turn-start']);
  assert.equal(f.posts.find(post => post.action === 'turn-start')!.text, 'Keyboard draft 🧩');
});

test('Send resumes only an owned saved native chat; an already-bound Send and Stop retain their paths', async t => {
  const f = await fixture(t); await f.act('select', { model: 'fixture-alt', effort: 'high' });
  const seed = await f.act('thread-start'), threadId = seed.record.threadId!;
  await f.act('disconnect'); await f.act('connect'); await f.mount(); f.text('Resume this owned conversation');
  assert.equal(f.chat.currentStateView().activeChat!.threadId, threadId);
  assert.equal(f.chat.currentStateView().nativeBoundToActiveChat, false); assert.equal(f.doc.getElementById('codex-submit').disabled, false);
  assert.equal(f.posts.length, 0); await f.submit();
  assert.deepEqual(f.posts.map(post => post.action), ['select', 'thread-resume', 'history-load', 'turn-start']);
  assert.equal(f.posts.find(post => post.action === 'thread-resume')!.threadId, threadId);
  assert.deepEqual(f.current().thread!.selection, { model: 'fixture-alt', effort: 'high' });
  const button = f.doc.getElementById('codex-submit'); assert.equal(button.getAttribute('aria-label'), 'Stop task');
  assert.equal(button.type, 'button'); assert.equal(button.disabled, false);
  button.human('click'); await until(() => f.receipts.some(record => record.action === 'turn-interrupt'));
  await until(() => f.chat.currentStateView().state!.snapshot!.thread!.turnStatus === 'interrupted');
  f.current().thread!.turnStatus = 'idle'; await f.chat.refresh(); f.text('Already bound message');
  const before = f.posts.length; await f.submit();
  assert.deepEqual(f.posts.slice(before).map(post => post.action), ['turn-start']);
  assert.equal(f.posts.at(-1)!.action, 'turn-start'); assert.equal(f.doc.getElementById('codex-composer').value, '');
});

test('rejected, unknown and lost HTTP thread-start receipts preserve every byte and never auto-send or retry', async t => {
  for (const failure of ['rejected', 'unknown', 'lost-receipt'] as const) await t.test(failure, async t => {
    const f = await fixture(t); await f.mount(); f.pair(); const draft = 'Keep unsent 🧩\n  text.  '; f.text(draft);
    if (failure === 'lost-receipt') f.controls.loseStartReceipt = true; else f.controls.failure = failure;
    await f.submit(); await f.chat.refresh();
    assert.equal(f.doc.getElementById('codex-composer').value, draft);
    assert.ok(f.chat.chatTabsView().some(row => row.draft === draft)); assert.ok(!f.posts.some(post => post.action === 'turn-start'));
    assert.equal(f.receipts.find(record => record.action === 'thread-start')!.state, failure === 'lost-receipt' ? 'acknowledged' : failure);
    assert.equal(f.posts.filter(post => post.action === 'thread-start').length, 1);
    if (failure !== 'rejected') { const before = f.posts.length; await f.submit(); assert.equal(f.posts.length, before); assert.equal(f.doc.getElementById('codex-submit').disabled, true); }
  });
});

test('edits and changed project/model/lifecycle while setup awaits ACK keep text and suppress the original turn', async t => {
  for (const change of ['draft', 'project', 'model', 'stop-resume'] as const) await t.test(change, async t => {
    const f = await fixture(t); await f.mount(); f.pair(); f.text('Original unsent draft'); f.controls.gate = deferred();
    const sending = f.submit(); await until(() => f.posts.some(post => post.action === 'thread-start'));
    if (change === 'draft') f.text('Edited unsent draft 🧩');
    if (change === 'project') { f.controls.project += '-other'; await f.chat.refresh(); }
    if (change === 'model') f.current().selection = { model: 'fixture-alt', effort: 'high' };
    if (change === 'stop-resume') { f.chat.stop(); f.chat.resume(); await f.chat.refresh(); }
    f.controls.gate.release(); await sending;
    assert.ok(!f.posts.some(post => post.action === 'turn-start'), change);
    if (change === 'project') {
      assert.ok([...f.data.values()].some(value => value.includes('Original unsent draft')), 'outgoing project draft remains saved');
    } else assert.equal(f.doc.getElementById('codex-composer').value, change === 'draft' ? 'Edited unsent draft 🧩' : 'Original unsent draft');
  });
});

test('signed-out, stale, wrong-provider, unreported pairs and unresolved operations remain fenced', async t => {
  for (const fence of ['signed-out', 'stale', 'claude', 'unreported-model', 'unreported-effort', 'pending', 'unknown'] as const) await t.test(fence, async t => {
    const f = await fixture(t); await f.mount(); f.pair(); f.text('Fenced unsent draft');
    if (fence === 'signed-out') { f.current().account!.auth = 'signed-out'; await f.chat.refresh(); }
    if (fence === 'stale') { f.controls.failRead = true; await f.chat.refresh(); }
    if (fence === 'claude') f.chat.setChatProviderPreference('claude');
    if (fence === 'unreported-model') f.pair('not-reported', 'high');
    if (fence === 'unreported-effort') f.pair('fixture-sol', 'ultra');
    if (fence === 'pending' || fence === 'unknown') {
      f.current().operations = [{ operationId: 'unresolved', method: 'thread/start', requestId: 1, threadId: null, turnId: null, state: fence, errorCode: null }]; await f.chat.refresh();
    }
    assert.equal(f.doc.getElementById('codex-submit').disabled, true, fence); await f.submit();
    assert.equal(f.posts.length, 0); assert.equal(f.doc.getElementById('codex-composer').value, 'Fenced unsent draft');
  });
});

test('workflow provenance still fences Send after its attested model changes', async t => {
  const f = await fixture(t); await f.mount(); f.pair(); assert.equal(await f.chat.startCurrentChat(), true);
  f.controls.attest = true; await f.chat.refresh(); const state = f.chat.currentStateView().state!;
  assert.equal(f.chat.appendWorkflowDraft('Pinned workflow draft 🧩', { projectPath: state.projectPath,
    projectId: 'b'.repeat(64), workflowId: 'fixture-workflow', workflowRevision: 1, stepKey: 'requirements',
    conversation: { provider: 'codex', threadId: state.snapshot!.thread!.threadId, sessionId: state.snapshot!.thread!.sessionId },
    model: { ...state.workflowModel!.selection } }), true);
  f.current().selection!.effort = 'low'; f.current().thread!.selection.effort = 'low'; await f.chat.refresh();
  const before = f.posts.length; assert.equal(f.doc.getElementById('codex-submit').disabled, true); await f.submit();
  assert.equal(f.posts.length, before); assert.equal(f.doc.getElementById('codex-composer').value, 'Pinned workflow draft 🧩');
  assert.equal(f.doc.getElementById('codex-draft-review').hidden, false);
});
