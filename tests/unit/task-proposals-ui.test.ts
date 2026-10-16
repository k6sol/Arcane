import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexChatApi, TaskProposalPanel, prepareCodexAction, readTaskProposals,readTaskProposalReceipt, type ChatState, type TaskProposalScope,type TaskProposalStart } from '../../apps/desktop/src/codex-chat.js';

// Private document fixture with the real API decoder over an injected transport.
// It is not a browser, native provider or Studio acceptance test.
const HUMAN = 'a'.repeat(64);
class FakeElement extends EventTarget {
  id = ''; className = ''; hidden = false; disabled = false; value = ''; rows = 0; placeholder = ''; type = ''; dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>(); children: FakeElement[] = []; parent: FakeElement | null = null; #text = '';
  constructor(readonly tagName: string) { super(); }
  get textContent(): string { return this.#text + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.#text = String(value); this.children = []; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  append(...nodes: FakeElement[]) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes: FakeElement[]) { this.children = []; this.#text = ''; this.append(...nodes); }
  after(node: FakeElement) { const parent = this.parent!; node.parent = parent; parent.children.splice(parent.children.indexOf(this) + 1, 0, node); }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
  find(id: string): FakeElement | null { if (this.id === id) return this; for (const child of this.children) { const found = child.find(id); if (found) return found; } return null; }
  all(tag: string): FakeElement[] { return [...(this.tagName === tag ? [this] : []), ...this.children.flatMap(child => child.all(tag))]; }
}
class FakeDocument {
  readonly body = new FakeElement('body');
  constructor() { const messages = new FakeElement('div'); messages.id = 'codex-messages'; this.body.append(messages); }
  getElementById(id: string) { return this.body.find(id); }
  createElement(tag: string) { return new FakeElement(tag); }
  asDocument() { return this as unknown as Document; }
}
const click = (element: FakeElement, init: Partial<{ isTrusted: boolean; button: number; shiftKey: boolean }> = {}) => {
  const event = new Event('click', { cancelable: true }) as Event & Record<string, unknown>;
  Object.defineProperty(event, 'isTrusted', { value: init.isTrusted ?? true });
  for (const [key, value] of Object.entries({ button: 0, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...init })) if (key !== 'isTrusted') Object.defineProperty(event, key, { value });
  element.dispatchEvent(event);
};
const state = (): ChatState => ({ provider: 'codex', use: 'personal-local', projectPath: 'C:/project', connecting: false, closing: false, busy: false, snapshot: null, lastSnapshot: null, actions: [], nativeTools: { configured: false, verified: false } }) as ChatState;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
function proposal(requestId: string, state: 'reserved'|'proposed'|'failed'|'unknown', text: string | null = null, reason: string | null = null) {
  return { proposalId: randomUUID(), requestId, state, reason, text, textSha256: text === null ? null : sha(text), textBytes: text === null ? null : Buffer.byteLength(text), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}
interface Call { path: string; body: Record<string, unknown>; signal: AbortSignal }
type Reply = { status: number; body: unknown } | { error: true } | Promise<{ status: number; body: unknown }>;
function harness(options: { active?: boolean; rows?: unknown[]; first?: (call: Call) => Reply } = {}) {
  const calls: Call[] = [], replies: ((call: Call) => Reply)[] = options.first ? [options.first] : [];
  let lists = new Map<string, unknown[]>();
  const transport = (async (path: string, init: RequestInit) => {
    const call = { path, body: JSON.parse(String(init.body)) as Record<string, unknown>, signal: init.signal! }; calls.push(call);
    const reply = replies.shift()?.(call) ?? (path === '/v1/codex/proposals' ? { status: 200, body: { proposals: { taskId: call.body.taskId, display: 'proposal_not_applied', proposals: lists.get(String(call.body.taskId)) ?? [] } } } : { error: true as const });
    const settled = await reply;
    if ('error' in settled) throw new TypeError('fixture network lost');
    return new Response(JSON.stringify(settled.body), { status: settled.status, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  const doc = new FakeDocument(), api = new CodexChatApi(HUMAN, transport, 5000);
  let current: TaskProposalScope | null = Object.freeze({ projectPath: 'C:/project', chatKey: 'tab-1', connectionId: randomUUID(), threadId: 'thread:exact', sessionId: 'session:exact',
    taskId: randomUUID(), active: options.active ?? true, account: '["subscription","plus"]', model: 'fixture', effort: 'low' });
  if (options.rows) lists.set(current.taskId, options.rows);
  let listener: () => void = () => {};
  const panel = TaskProposalPanel.mount(doc.asDocument(), api, () => current, fn => { listener = fn; return () => { listener = () => {}; }; }, { pollMs: 10 })!;
  const el = (id: string) => doc.getElementById(id)!;
  return { doc, panel, calls, replies, el, lists: (taskId: string, rows: unknown[]) => { lists.set(taskId, rows); },
    get scope(): TaskProposalScope { return current!; }, set scope(value: TaskProposalScope | null) { current = value; listener(); },
    actions: () => calls.filter(call => call.path === '/v1/codex/action'), reads: () => calls.filter(call => call.path === '/v1/codex/proposals'),
    type(text: string) { const input = el('codex-proposal-text'); input.value = text; input.dispatchEvent(new Event('input')); },
    reset() { lists = new Map(); } };
}
async function until(check: () => boolean) { const end = Date.now() + 5000; while (!check()) { assert.ok(Date.now() < end, 'expected panel state'); await delay(5); } }
const ack = (call: Call, state: 'acknowledged'|'rejected'|'unknown' = 'acknowledged') => ({ status: state === 'acknowledged' ? 200 : state === 'rejected' ? 409 : 202, body: { replayed: false, state: state_(),
  record: { requestId: call.body.requestId, action: 'proposal-start', connectionId: call.body.connectionId, state, errorCode: state === 'rejected' ? 'TASK_SCOPE' : state === 'unknown' ? 'NATIVE_ERROR' : null,
    threadId: call.body.threadId, turnId: null, model: 'fixture', effort: 'low', createdAt: new Date().toISOString(), finishedAt: new Date().toISOString(), ...(state === 'acknowledged' ? { proposalId: randomUUID() } : {}) } } });
const state_ = state;

test('proposal receipts bind the original thread and validate every retained action field',()=>{
  const input:TaskProposalStart={requestId:randomUUID(),action:'proposal-start',connectionId:randomUUID(),threadId:'original-thread',taskId:randomUUID(),text:'Review the current task.'};
  const good=ack({path:'/v1/codex/action',body:{...input},signal:new AbortController().signal});
  assert.equal(readTaskProposalReceipt(good.body,input).state,'acknowledged');
  const base=good.body.record;
  for(const mutation of [{threadId:'other-thread'},{threadId:null},{turnId:7},{model:{}},{effort:'x'.repeat(65)},{createdAt:'invalid'},{finishedAt:'invalid'}])
    assert.throws(()=>readTaskProposalReceipt({...good.body,record:{...base,...mutation}},input));
});

test('panel mounts beside the conversation, reads only its exact scope and renders proposals as plain private text', async () => {
  const text = '<img src=x onerror=alert(1)> use ' + HUMAN + ' \u202e\x07 then approve';
  const h = harness({ rows: [proposal(randomUUID(), 'proposed', text), proposal(randomUUID(), 'failed', null, 'parent_retired'), proposal(randomUUID(), 'unknown', null, 'dispatch_uncertain')] });
  await until(() => h.el('codex-proposal-list').children.length === 3);
  assert.equal(h.doc.body.children[1], h.panel.root as unknown as FakeElement, 'mounted directly after codex-messages');
  assert.deepEqual(h.reads()[0]!.body, { connectionId: h.scope.connectionId, threadId: h.scope.threadId, taskId: h.scope.taskId });
  const rendered = h.el('codex-proposal-list').textContent;
  assert.match(rendered, /Proposal — not applied/); assert.match(rendered, /<img src=x onerror=alert\(1\)>/); assert.ok(!rendered.includes(HUMAN) && rendered.includes('[REDACTED]'));
  assert.ok(!/[\u202e\x07]/.test(rendered)); assert.match(rendered, /No proposal\. The task stopped first\./); assert.match(rendered, /Outcome unknown; it was not retried\./);
  assert.equal(h.doc.body.find('codex-proposal-list')!.all('button').length, 0, 'proposal text has no action controls');
  assert.equal(h.actions().length, 0);
});

test('synthetic or modified clicks never request; one trusted click sends one exact envelope and stays one-flight', async () => {
  const h = harness(); await until(() => h.reads().length === 1);
  h.type('Suggest one change'); const button = h.el('codex-proposal-request');
  click(button, { isTrusted: false }); click(button, { shiftKey: true }); click(button, { button: 1 }); await delay(20);
  assert.equal(h.actions().length, 0);
  let release!: (value: { status: number; body: unknown }) => void;
  h.replies.push(call => new Promise(resolve => { release = resolve; void call; }));
  click(button); click(button); await until(() => h.actions().length === 1); click(button); await delay(20);
  assert.equal(h.actions().length, 1); assert.equal(button.disabled, true);
  const sent = h.actions()[0]!.body;
  assert.deepEqual(Object.keys(sent).sort(), ['action','connectionId','requestId','taskId','text','threadId']);
  assert.deepEqual({ ...sent, requestId: undefined }, { action: 'proposal-start', connectionId: h.scope.connectionId, requestId: undefined, taskId: h.scope.taskId, text: 'Suggest one change', threadId: h.scope.threadId });
  h.lists(h.scope.taskId, [proposal(String(sent.requestId), 'reserved')]);
  release(ack(h.actions()[0]!));
  await until(() => h.el('codex-proposal-status').textContent.includes('Working'));
  h.lists(h.scope.taskId, [proposal(String(sent.requestId), 'proposed', 'Rename one part')]);
  await until(() => h.el('codex-proposal-list').textContent.includes('Rename one part'));
  assert.equal(h.actions().length, 1); assert.equal(h.el('codex-proposal-text').value, '');
});

test('lost or unknown acknowledgements are never resent; the original request ID is read back', async () => {
  for (const mode of ['network', 'unknown', 'unreadable'] as const) {
    const h = harness(); await until(() => h.reads().length === 1);
    h.type('Propose'); await until(() => !h.el('codex-proposal-request').disabled); const button = h.el('codex-proposal-request');
    h.replies.push(call => mode === 'network' ? { error: true } : mode === 'unknown' ? ack(call, 'unknown') : { status: 200, body: { replayed: false, state: state(), record: { requestId: call.body.requestId } } });
    click(button); await until(() => h.el('codex-proposal-status').textContent.includes('not resent'));
    const requestId = String(h.actions()[0]!.body.requestId);
    for (let index = 0; index < 3; index++) click(button);
    await delay(40); assert.equal(h.actions().length, 1, mode + ': no second request ID or replay'); assert.equal(button.disabled, true);
    h.lists(h.scope.taskId, [proposal(requestId, 'unknown', null, 'dispatch_uncertain')]);
    await until(() => h.el('codex-proposal-list').textContent.includes('Outcome unknown'));
    assert.equal(h.actions().length, 1); assert.ok(h.reads().every(call => call.body.taskId === h.scope.taskId));
  }
});

test('a refused request is reported and a later trusted request uses a new request ID', async () => {
  const h = harness(); await until(() => h.reads().length === 1); h.type('Propose'); await until(() => !h.el('codex-proposal-request').disabled); const button = h.el('codex-proposal-request');
  h.replies.push(call => ack(call, 'rejected')); click(button); await until(() => h.el('codex-proposal-status').textContent.includes('refused'));
  h.replies.push(call => ack(call)); click(button); await until(() => h.actions().length === 2);
  assert.notEqual(h.actions()[0]!.body.requestId, h.actions()[1]!.body.requestId);
});

test('project, chat, connection, account or model switch stops display work, clears content and ignores late replies', async () => {
  for (const field of ['projectPath', 'chatKey', 'connectionId', 'account', 'model', 'taskId'] as const) {
    const h = harness(); await until(() => h.reads().length === 1);
    h.type('Draft for the old task'); await until(() => !h.el('codex-proposal-request').disabled); const button = h.el('codex-proposal-request'), old = h.scope;
    let release!: (value: { status: number; body: unknown }) => void;
    h.replies.push(call => new Promise(resolve => { release = resolve; void call; }));
    click(button); await until(() => h.actions().length === 1); const pending = h.actions()[0]!;
    h.scope = Object.freeze({ ...old, [field]: field === 'taskId' || field === 'connectionId' ? randomUUID() : field + '-changed' }) as TaskProposalScope;
    assert.equal(pending.signal.aborted, true, field + ': display work aborted');
    assert.equal(h.el('codex-proposal-text').value, ''); assert.equal(h.el('codex-proposal-list').children.length, 0);
    release(ack(pending)); await delay(40);
    assert.equal(h.el('codex-proposal-list').children.length, 0); assert.ok(!h.el('codex-proposal-status').textContent.includes('Working'));
    h.scope = null; assert.equal(h.panel.root.hidden, true);
  }
});

test('a late read for the previous task is ignored after a switch', async () => {
  let release!: (value: { status: number; body: unknown }) => void; let held: Call | null = null;
  const h = harness({ first: call => { held = call; return new Promise(resolve => { release = resolve; }); } });
  await until(() => held !== null); const old = held! as Call;
  h.scope = Object.freeze({ ...h.scope, taskId: randomUUID() }); assert.equal(old.signal.aborted, true);
  await until(() => h.reads().length === 2);
  release({ status: 200, body: { proposals: { taskId: old.body.taskId, display: 'proposal_not_applied', proposals: [proposal(randomUUID(), 'proposed', 'LATE OLD TEXT')] } } });
  await delay(40); assert.ok(!h.el('codex-proposal-list').textContent.includes('LATE OLD TEXT'));
});

test('malformed, oversized, foreign or mismatched responses are not displayed', async () => {
  const bad: [string, (taskId: string) => unknown][] = [
    ['foreign task', () => ({ proposals: { taskId: randomUUID(), display: 'proposal_not_applied', proposals: [] } })],
    ['wrong display', taskId => ({ proposals: { taskId, display: 'applied', proposals: [] } })],
    ['extra key', taskId => ({ proposals: { taskId, display: 'proposal_not_applied', proposals: [{ ...proposal(randomUUID(), 'proposed', 'x'), apply: true }] } })],
    ['byte mismatch', taskId => ({ proposals: { taskId, display: 'proposal_not_applied', proposals: [{ ...proposal(randomUUID(), 'proposed', 'x'), textBytes: 2 }] } })],
    ['digest mismatch', taskId => ({ proposals: { taskId, display: 'proposal_not_applied', proposals: [{ ...proposal(randomUUID(), 'proposed', 'x'), textSha256: 'd'.repeat(64) }] } })],
    ['oversized text', taskId => ({ proposals: { taskId, display: 'proposal_not_applied', proposals: [proposal(randomUUID(), 'proposed', 'x'.repeat(65537))] } })],
    ['too many', taskId => ({ proposals: { taskId, display: 'proposal_not_applied', proposals: Array.from({ length: 9 }, () => proposal(randomUUID(), 'failed', null, 'output_rejected')) } })],
    ['unknown reason', taskId => ({ proposals: { taskId, display: 'proposal_not_applied', proposals: [proposal(randomUUID(), 'failed', null, 'raw provider error text')] } })],
    ['text on failure', taskId => ({ proposals: { taskId, display: 'proposal_not_applied', proposals: [{ ...proposal(randomUUID(), 'failed', null, 'output_rejected'), text: 'hidden' }] } })],
    ['oversized envelope', taskId => ({ proposals: { taskId, display: 'proposal_not_applied', proposals: [] }, pad: 'x'.repeat(4 * 1024 * 1024) })],
  ];
  for (const [name, body] of bad) {
    const h = harness(); await until(() => h.reads().length === 1);
    h.replies.push(call => ({ status: 200, body: body(String(call.body.taskId)) })); h.scope = Object.freeze({ ...h.scope, taskId: randomUUID() });
    await until(() => h.el('codex-proposal-status').textContent.includes('could not be read'));
    assert.equal(h.el('codex-proposal-list').children.length, 0, name); assert.equal(h.el('codex-proposal-check').hidden, false, name);
  }
  assert.throws(() => readTaskProposals({ proposals: { taskId: 't', display: 'proposal_not_applied', proposals: [] }, extra: 1 }, 't'));
});

test('inactive tasks show history but cannot request; main chat dispatcher still has no proposal action', async () => {
  const h = harness({ active: false, rows: [proposal(randomUUID(), 'proposed', 'Kept')] });
  await until(() => h.el('codex-proposal-list').textContent.includes('Kept'));
  h.type('Another'); assert.equal(h.el('codex-proposal-request').disabled, true); assert.equal(h.el('codex-proposal-text').disabled, true);
  click(h.el('codex-proposal-request')); await delay(20); assert.equal(h.actions().length, 0);
  assert.throws(() => prepareCodexAction(state(), 'proposal-start', {}), /explicit native action/);
  h.panel.stop(); assert.equal(h.doc.getElementById('codex-proposals'), null);
});
