import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { ChatTabs, closeNeighbour, draftCloseStep, chatSwitchOpenSection, type ChatTabsCallbacks } from '../../apps/desktop/src/chat-tabs.js';
import { CodexChat, CodexChatApi, type ChatState } from '../../apps/desktop/src/codex-chat.js';
import type { Snapshot } from '../../packages/codex-client/src/types.js';

// Controlled document fixtures only: no browser, native provider, Studio or inference. Every Codex API call must be a GET.
const TOKEN = 'a'.repeat(64), PROJECT = resolve('.');
const tick = () => new Promise<void>(done => setImmediate(done));
let current: DocumentFixture | null = null;
class Element extends EventTarget {
  tagName: string; id = ''; children: Element[] = []; value = ''; checked = false; disabled = false; hidden = false; open = false;
  className = ''; type = ''; title = ''; tabIndex = 0; scrollHeight = 0; scrollTop = 0; clientHeight = 0;
  dataset: Record<string, string> = {}; private content = ''; private attributes = new Map<string, string>();
  constructor(tag = 'div') { super(); this.tagName = tag.toUpperCase(); }
  get textContent(): string { return this.content + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.content = value; this.children = []; }
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.content = ''; this.children = children; }
  after(..._children: Element[]) {} remove() {} contains(_value: unknown) { return false; }
  focus(_options?: unknown) { if (current) current.activeElement = this; }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  getAttribute(key: string) { return this.attributes.get(key) ?? null; }
  querySelectorAll(selector: string): Element[] {
    return this.children.flatMap(child => [...(selector === '[role=tab]' && child.getAttribute('role') === 'tab' || selector === 'button' && child.tagName === 'BUTTON' ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector() { return null; } showModal() { this.open = true; } close() { this.open = false; }
  all(): Element[] { return this.children.flatMap(child => [child, ...child.all()]); }
}
class DocumentFixture extends EventTarget {
  hidden = false; activeElement: Element | null = null; private elements = new Map<string, Element>();
  constructor() { super(); current = this; this.getElementById('workspace-chat-tabs').setAttribute('role', 'tablist'); }
  getElementById(id: string): Element { let el = this.elements.get(id); if (!el) { el = new Element(id === 'codex-composer' ? 'textarea' : 'div'); el.id = id; this.elements.set(id, el); } return el; }
  createElement(tag: string) { return new Element(tag); }
  asDocument() { return this as unknown as Document; }
}
const memoryStorage = () => { const data = new Map<string, string>(); return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } }; };
function snapshot(): Snapshot {
  return { connectionId: randomUUID(), provenance: 'spawned-node-fixture', connected: true, ready: true, account: { auth: 'subscription', plan: 'fixture', requiresOpenaiAuth: true },
    models: [{ model: 'fixture-sol', id: 'sol', displayName: 'Fixture Sol', efforts: ['low', 'high'], defaultEffort: 'low', entitlement: 'unverified' }],
    selection: null, thread: null, operations: [], approvals: [], events: [], droppedEvents: 0, lastEventSeq: 0, failureCode: null };
}
function state(): ChatState { return { provider: 'codex', use: 'personal-local', projectPath: PROJECT, connecting: false, closing: false, busy: false, snapshot: null, lastSnapshot: null, actions: [], nativeThreads: [], nativeHistory: null, nativeTools: { configured: true, verified: false } }; }
/** A saved native chat ("Chat 1") that is not resumed: its tab exists, no native thread is live. */
function savedChatState(): ChatState {
  const value = state(); value.snapshot = snapshot();
  value.nativeThreads = [{ provider: 'codex', projectPath: PROJECT, threadId: 'owned', sessionId: null, selection: { model: 'fixture-sol', effort: 'low' } }];
  value.nativeHistory = { projectPath: PROJECT, threadId: 'owned', sessionId: null, recorded: null };
  return value;
}
function controller(initial = state()) {
  const doc = new DocumentFixture(), storage = memoryStorage(), calls: string[] = []; let observed = initial;
  const api = new CodexChatApi(TOKEN, async (path, init) => { calls.push(String(path) + ':' + init?.method); assert.equal(init?.method, 'GET', 'Closing a draft never performs a native action'); return Response.json({ state: observed }); });
  const chat = new CodexChat(doc.asDocument(), api);
  return { doc, chat, storage, calls, set: (value: ChatState) => { observed = value; } };
}
const strip = (doc: DocumentFixture) => doc.getElementById('workspace-chat-tabs').children;
const chip = (doc: DocumentFixture, key: string) => strip(doc).find(wrap => wrap.children[0]!.dataset.chatKey === key)!;
const closeButton = (doc: DocumentFixture, key: string) => chip(doc, key).children.find(node => node.dataset.closeChat === key);
const confirmButton = (doc: DocumentFixture, key: string, action: 'discard' | 'keep') => chip(doc, key).all().find(node => node.dataset.confirmChat === key && node.dataset.confirmAction === action);
const click = (node: Element | undefined) => { assert.ok(node, 'control is rendered'); node.dispatchEvent(new Event('click')); };
const type = (doc: DocumentFixture, text: string) => { const composer = doc.getElementById('codex-composer'); composer.value = text; composer.dispatchEvent(new Event('input')); };
const key = (target: Element, name: string, modifiers: Record<string, boolean> = {}) => {
  const event = new Event('keydown', { bubbles: true, cancelable: true }); Object.defineProperty(event, 'key', { value: name });
  for (const [property, value] of Object.entries(modifiers)) Object.defineProperty(event, property, { value });
  Object.defineProperty(event, 'target', { value: target }); return event;
};
const stored = (storage: ReturnType<typeof memoryStorage>) => [...storage.data.values()].join('\n');

test('draft close steps: empty closes at once, text or live unsent content asks first, sent chats keep their close', () => {
  assert.equal(draftCloseStep({ kind: 'draft', draft: '' }), 'close');
  assert.equal(draftCloseStep({ kind: 'draft', draft: ' \n\t ' }), 'close', 'whitespace is not a draft worth asking about');
  assert.equal(draftCloseStep({ kind: 'draft', draft: 'Build a lobby' }), 'confirm');
  assert.equal(draftCloseStep({ kind: 'draft', draft: '' }, true), 'confirm', 'live composer text or attachments count before the debounce stores them');
  assert.equal(draftCloseStep({ kind: 'native', draft: '' }), 'native');
  assert.equal(draftCloseStep({ kind: 'native', draft: 'unsent reply' }, true), 'native', 'a chat with sent turns never gets the draft path');
  assert.equal(closeNeighbour(['a', 'b', 'c'], 'b'), 'a'); assert.equal(closeNeighbour(['a', 'b', 'c'], 'a'), 'b');
  assert.equal(closeNeighbour(['a', 'b', 'c'], 'c'), 'b'); assert.equal(closeNeighbour(['a'], 'a'), null); assert.equal(closeNeighbour(['a'], 'x'), null);
});

test('an empty draft closes instantly from its x, middle-click or Delete, and focus moves to the neighbouring tab', async t => {
  const f = controller(); t.after(() => f.chat.stop());
  await f.chat.enableChatTabs({ storage: f.storage }); await f.chat.start();
  assert.equal(await f.chat.newChat(), true); assert.equal(await f.chat.newChat(), true);
  const [first, second, third] = f.chat.chatTabsView().map(row => row.key) as [string, string, string];
  assert.equal(f.chat.currentStateView().activeChat!.key, third);
  click(closeButton(f.doc, third)); await tick();
  assert.deepEqual(f.chat.chatTabsView().map(row => row.key), [first, second], 'no question for an empty draft');
  assert.equal(f.chat.currentStateView().activeChat!.key, second, 'the left neighbour takes over');
  assert.equal(f.doc.activeElement?.dataset.chatKey, second, 'focus moves to the neighbouring tab');
  assert.ok(!stored(f.storage).includes(third), 'the closed draft is deleted from the draft store');
  const middle = new Event('auxclick', { cancelable: true }); Object.defineProperty(middle, 'button', { value: 1 });
  chip(f.doc, first).dispatchEvent(middle); await tick();
  assert.equal(middle.defaultPrevented, true); assert.deepEqual(f.chat.chatTabsView().map(row => row.key), [second], 'middle-click closes an inactive empty draft');
  const tab = chip(f.doc, second).children[0]!, del = key(tab, 'Delete');
  f.doc.getElementById('workspace-chat-tabs').dispatchEvent(del); await tick();
  assert.equal(del.defaultPrevented, true);
  const views = f.chat.chatTabsView();
  assert.equal(views.length, 1, 'closing the last tab leaves a fresh chat, never a blank app');
  assert.notEqual(views[0]!.key, second); assert.equal(views[0]!.kind, 'draft'); assert.equal(views[0]!.draft, '');
  assert.equal(f.chat.currentStateView().activeChat!.key, views[0]!.key);
  assert.ok(f.calls.every(call => call.endsWith(':GET')));
});

test('a draft with text asks Discard draft? inline; Keep and Escape keep every byte, Discard deletes it from the store', async t => {
  const f = controller(); t.after(() => f.chat.stop());
  await f.chat.enableChatTabs({ storage: f.storage }); await f.chat.start();
  const first = f.chat.chatTabsView()[0]!.key; assert.equal(await f.chat.newChat(), true);
  const draft = f.chat.chatTabsView()[1]!.key;
  type(f.doc, 'Unsent lobby request typed just now');
  click(closeButton(f.doc, draft)); await tick();
  assert.equal(chip(f.doc, draft).dataset.confirming, 'true');
  assert.match(chip(f.doc, draft).textContent, /Discard draft\?DiscardKeep/);
  assert.equal(closeButton(f.doc, draft), undefined, 'the question replaces the x');
  assert.equal(f.doc.activeElement?.dataset.confirmAction, 'keep', 'the safe answer takes focus');
  assert.equal(f.chat.chatTabsView().length, 2);
  click(confirmButton(f.doc, draft, 'keep')); await tick();
  assert.equal(chip(f.doc, draft).dataset.confirming, undefined); assert.equal(f.doc.activeElement?.dataset.closeChat, draft, 'focus returns to the x');
  assert.equal(f.doc.getElementById('codex-composer').value, 'Unsent lobby request typed just now');
  click(closeButton(f.doc, draft)); await tick();
  const escape = key(confirmButton(f.doc, draft, 'keep')!, 'Escape');
  f.doc.getElementById('workspace-chat-tabs').dispatchEvent(escape); await tick();
  assert.equal(escape.defaultPrevented, true); assert.equal(chip(f.doc, draft).dataset.confirming, undefined);
  assert.equal(f.chat.chatTabsView().find(row => row.key === draft)!.draft, 'Unsent lobby request typed just now');
  click(closeButton(f.doc, draft)); await tick();
  click(confirmButton(f.doc, draft, 'discard')); await tick();
  assert.deepEqual(f.chat.chatTabsView().map(row => row.key), [first]);
  assert.equal(f.chat.currentStateView().activeChat!.key, first); assert.equal(f.doc.activeElement?.dataset.chatKey, first);
  assert.equal(f.doc.getElementById('codex-composer').value, '', 'the neighbour’s own draft is loaded');
  assert.ok(!stored(f.storage).includes('Unsent lobby request'), 'Discard deletes the text from the draft store');
  // An inactive draft with stored text asks too, and Discard there leaves the active chat in place.
  assert.equal(await f.chat.newChat(), true); type(f.doc, 'Second idea'); const idea = f.chat.chatTabsView()[1]!.key;
  assert.equal(await f.chat.selectChat(first), true);
  click(closeButton(f.doc, idea)); await tick(); click(confirmButton(f.doc, idea, 'discard')); await tick();
  assert.deepEqual(f.chat.chatTabsView().map(row => row.key), [first]); assert.equal(f.chat.currentStateView().activeChat!.key, first);
  assert.ok(!stored(f.storage).includes('Second idea'));
  assert.ok(f.calls.every(call => call.endsWith(':GET')));
});

test('closing the last draft with text, after Discard, leaves one fresh empty chat with the same model choice', async t => {
  const f = controller(); t.after(() => f.chat.stop());
  await f.chat.enableChatTabs({ storage: f.storage }); await f.chat.start();
  const only = f.chat.chatTabsView()[0]!; type(f.doc, 'Only draft');
  click(closeButton(f.doc, only.key)); await tick(); click(confirmButton(f.doc, only.key, 'discard')); await tick();
  const views = f.chat.chatTabsView();
  assert.equal(views.length, 1); assert.notEqual(views[0]!.key, only.key); assert.equal(views[0]!.draft, '');
  assert.deepEqual(views[0]!.selection, only.selection);
  assert.equal(f.doc.getElementById('codex-composer').value, ''); assert.equal(f.doc.activeElement?.dataset.chatKey, views[0]!.key);
  assert.ok(!stored(f.storage).includes('Only draft'));
});

test('root cause: an active draft closes while native state blocks chat switching, without resuming its saved neighbour', async t => {
  const f = controller(savedChatState()); t.after(() => f.chat.stop());
  await f.chat.enableChatTabs({ storage: f.storage }); await f.chat.start();
  const saved = f.chat.chatTabsView()[0]!; assert.equal(saved.kind, 'native');
  assert.equal(await f.chat.newChat(), true); const draft = f.chat.chatTabsView()[1]!.key;
  const offline = savedChatState(); offline.snapshot!.connected = false; f.set(offline); await f.chat.refresh();
  assert.equal(f.chat.currentStateView().activeChat!.key, draft);
  assert.equal(closeButton(f.doc, draft)!.disabled, false, 'an unsent draft is never held open by native state');
  assert.equal(chip(f.doc, saved.key).children[0]!.disabled, true, 'switching to a sent chat still waits for native state');
  click(closeButton(f.doc, draft)); await tick();
  assert.deepEqual(f.chat.chatTabsView().map(row => row.key), [saved.key]);
  assert.equal(f.chat.currentStateView().activeChat!.key, saved.key);
  assert.equal(f.chat.currentStateView().nativeBoundToActiveChat, false, 'the saved chat resumes only on its own explicit gesture');
  assert.ok(f.calls.every(call => call.endsWith(':GET')), 'no thread-resume or any other native action');
  assert.equal(closeButton(f.doc, saved.key)!.disabled, true, 'a chat with sent turns keeps its blocked close rule');
});

test('an active draft with a pending or uncertain recorded request closes from x, middle-click or Delete; the receipt stays reviewable', async t => {
  for (const [receiptState, gesture] of [['pending', 'x'], ['unknown', 'middle'], ['unknown', 'delete']] as const) {
    const initial = state(); initial.snapshot = snapshot(); const requestId = randomUUID();
    initial.actions = [{ requestId, action: 'thread-start', connectionId: initial.snapshot.connectionId, state: receiptState, errorCode: receiptState === 'unknown' ? 'TIMEOUT' : null, threadId: null, turnId: null, model: null, effort: null, createdAt: new Date().toISOString(), finishedAt: null }];
    const f = controller(initial); t.after(() => f.chat.stop());
    await f.chat.enableChatTabs({ storage: f.storage });
    const only = f.chat.chatTabsView()[0]!.key; await f.chat.refresh();
    assert.equal(f.doc.getElementById('codex-unknown').hidden, false, receiptState + ': the recovery card shows the receipt');
    assert.equal(closeButton(f.doc, only)!.disabled, false, 'an unsent draft is never held open by its receipt');
    if (gesture === 'x') click(closeButton(f.doc, only));
    else if (gesture === 'middle') { const event = new Event('auxclick', { cancelable: true }); Object.defineProperty(event, 'button', { value: 1 }); chip(f.doc, only).dispatchEvent(event); }
    else f.doc.getElementById('workspace-chat-tabs').dispatchEvent(key(chip(f.doc, only).children[0]!, 'Delete'));
    await tick();
    const after = f.chat.chatTabsView(); assert.equal(after.length, 1); assert.notEqual(after[0]!.key, only); assert.equal(after[0]!.kind, 'draft');
    await f.chat.refresh();
    assert.equal(f.doc.getElementById('codex-unknown').hidden, false, 'the receipt stays in the recovery card after its draft closes');
    assert.match(f.doc.getElementById('codex-unknown-requests').textContent, new RegExp(requestId + ' · thread-start · ' + receiptState));
    assert.equal(f.doc.getElementById('codex-submit').disabled, true, 'Send still waits for the review');
    assert.ok(f.calls.every(call => call.endsWith(':GET')), 'nothing was retried, resumed or sent');
  }
});

test('ChatTabs routes sent chats to their existing close untouched and asks the draft question in the chat switcher too', async () => {
  const doc = new DocumentFixture(), storage = memoryStorage(), closes: string[] = [];
  let tabs: ChatTabs;
  const callbacks: ChatTabsCallbacks = { select: async () => true, newChat: async () => true, openSaved: async () => true, unsent: () => true,
    close: async key => { closes.push(key); return tabs.views().find(row => row.key === key)?.kind === 'draft' ? tabs.closeDraft(key) : tabs.remove(key); } };
  tabs = new ChatTabs(doc.asDocument(), value => value, callbacks, { storage });
  const value = savedChatState(); value.snapshot!.thread = { threadId: 'owned', sessionId: null, selection: { model: 'fixture-sol', effort: 'low' }, configured: true, writeGranted: false, turnId: null, turnStatus: 'idle' };
  tabs.sync(value); tabs.mount(); const native = tabs.views()[0]!; assert.equal(native.kind, 'native');
  const draft = tabs.createDraft()!; tabs.activate(native.key); tabs.render(false);
  tabs.requestClose(native.key);
  assert.deepEqual(closes, [native.key], 'even with unsent text reported, a sent chat closes through its existing callback with no question');
  tabs.requestClose(draft.key); tabs.render(false);
  assert.equal(closes.length, 1, 'live unsent content asks first'); assert.equal(chip(doc, draft.key).dataset.confirming, 'true');
  // The chat switcher lists every open chat with its own x; a close asked there keeps focus in the switcher.
  tabs.keepDraft(draft.key); assert.equal(chip(doc, draft.key).dataset.confirming, undefined);
  const sheet = (tabs as unknown as { savedMenu: Element }).savedMenu; sheet.open = true; tabs.render(false);
  click(sheet.all().find(node => node.dataset.closeChat === draft.key));
  assert.equal(doc.activeElement?.dataset.confirmAction, 'keep'); assert.ok(sheet.all().includes(doc.activeElement!), 'focus stays in the switcher');
  assert.equal(sheet.all().some(node => node.dataset.closeChat === draft.key), false, 'the switcher row shows the question in place of its x');
  click(sheet.all().find(node => node.dataset.confirmChat === draft.key && node.dataset.confirmAction === 'discard')); await tick();
  assert.deepEqual(closes, [native.key, draft.key]); assert.equal(tabs.views().some(row => row.key === draft.key), false);
  // The narrow switcher lists the same question in place of the row's x.
  const menu = new Element('details') as unknown as HTMLDetailsElement, discarded: string[] = [], kept: string[] = [];
  const section = chatSwitchOpenSection(doc.asDocument(), menu, [{ key: draft.key, label: 'Draft 2', current: false, selectDisabled: false, closeDisabled: false, confirm: true }],
    { select() {}, close() {}, newChat() {}, newDisabled: false, discard: k => discarded.push(k), keep: k => kept.push(k) }) as unknown as Element;
  const row = section.all().filter(node => node.dataset.confirmChat === draft.key);
  assert.deepEqual(row.map(node => node.textContent), ['Discard', 'Keep']); assert.equal(section.all().some(node => node.dataset.closeChat === draft.key), false);
  click(row[1]); click(row[0]); assert.deepEqual(kept, [draft.key]); assert.deepEqual(discarded, [draft.key]);
  const plain = chatSwitchOpenSection(doc.asDocument(), menu, [{ key: draft.key, label: 'Draft 2', current: false, selectDisabled: false, closeDisabled: false }],
    { select() {}, close() {}, newChat() {}, newDisabled: false }) as unknown as Element;
  assert.equal(plain.all().filter(node => node.dataset.closeChat === draft.key).length, 1, 'other providers keep the plain x');
  tabs.stop();
});
