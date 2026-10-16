/// <reference lib="dom" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeChat, CLAUDE_CHAT_CHOICE_KEY, CLAUDE_CHAT_EMPTY_TEXT, CLAUDE_CHAT_NO_BRIDGE_TEXT, readClaudeChatBridge, renderClaudeText } from '../../apps/desktop/src/claude-chat.js';

// In-memory DOM and preload-bridge doubles only: no Electron, CLI, network, Studio or inference.
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
let innerHtmlWrites = 0;
class Element extends EventTarget {
  tagName: string; id = ''; className = ''; type = ''; title = ''; value = ''; hidden = false; disabled = false;
  scrollTop = 0; scrollHeight = 0; clientHeight = 0; children: Element[] = []; parent: Element | null = null; focused = 0;
  private content = ''; private attributes = new Map<string, string>();
  constructor(tag: string, readonly ownerDocument: DocumentFixture) { super(); this.tagName = tag.toUpperCase(); }
  get textContent(): string { return this.content + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.content = String(value); this.children = []; }
  set innerHTML(_value: string) { innerHtmlWrites++; throw Error('innerHTML is forbidden'); }
  get options() { return this.children.filter(child => child.tagName === 'OPTION'); }
  append(...children: Element[]) { for (const child of children) { child.parent = this; this.children.push(child); } this.scrollHeight += 100 * children.length; }
  replaceChildren(...children: Element[]) { this.content = ''; this.children = []; this.append(...children); }
  setAttribute(name: string, value: string) { this.attributes.set(name, String(value)); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  focus() { this.focused++; }
  all(): Element[] { return this.children.flatMap(child => [child, ...child.all()]); }
  querySelectorAll(selector: string): Element[] {
    const name = selector.startsWith('.') ? selector.slice(1) : null;
    return this.all().filter(node => name ? node.className.split(/\s+/).includes(name) : node.tagName === selector.toUpperCase());
  }
  querySelector(selector: string): Element | null { return this.querySelectorAll(selector)[0] ?? null; }
}
class DocumentFixture { defaultView = null; createElement(tag: string) { return new Element(tag, this); } }

function key(target: Element, value: string, shiftKey = false) {
  const event = new Event('keydown', { cancelable: true });
  Object.defineProperties(event, { key: { value }, shiftKey: { value: shiftKey }, isComposing: { value: false } });
  target.dispatchEvent(event); return event;
}
function mount(bridge: unknown, storage: Pick<Storage, 'getItem' | 'setItem'> | null = memory()) {
  const doc = new DocumentFixture();
  const make = (tag: string, className: string, ...children: Element[]) => { const node = doc.createElement(tag); node.className = className; node.append(...children); return node; };
  const list = make('nav', 'claude-chat-list'), create = make('button', 'secondary claude-chat-new');
  const status = make('p', 'claude-chat-status'), messages = make('div', 'claude-chat-messages');
  const input = make('textarea', 'claude-chat-input'), model = make('select', 'claude-chat-model'), effort = make('select', 'claude-chat-effort');
  const stop = make('button', 'claude-chat-stop'), send = make('button', 'claude-chat-send');
  const composer = make('form', 'claude-chat-composer', input, model, effort, stop, send);
  const root = make('section', 'claude-chat', make('aside', 'claude-chat-sidebar', create, list), make('div', 'claude-chat-main', status, messages, composer));
  messages.clientHeight = 300;
  const chat = new ClaudeChat(root as unknown as HTMLElement, { bridge, storage });
  const type = (text: string) => { input.value = text; input.dispatchEvent(new Event('input')); };
  const bubbles = () => messages.querySelectorAll('.claude-message').map(node => ({ role: node.getAttribute('data-role'), text: node.textContent }));
  const items = () => list.querySelectorAll('.claude-chat-item');
  return { chat, root, list, create, status, messages, input, model, effort, stop, send, composer, type, bubbles, items };
}
function memory() { const data = new Map<string, string>(); return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } }; }
const signedIn = { installed: true, signedIn: true, cliVersion: '2.1.177', models: ['opus', 'sonnet'], efforts: ['low', 'high', 'max'], defaultModel: 'sonnet', message: null };
function fakeBridge(overrides: Record<string, unknown> = {}) {
  const calls: unknown[][] = []; let listener: ((event: unknown) => void) | null = null;
  const histories = new Map<string, unknown>();
  let sendReply: () => Promise<unknown> = async () => ({ turnId: 'turn-1', conversationId: 'conv-new' });
  let conversations: unknown[] = [];
  const bridge = {
    version: 1,
    status: async () => { calls.push(['status']); return signedIn; },
    list: async () => { calls.push(['list']); return { conversations }; },
    history: async (id: string) => { calls.push(['history', id]); const value = histories.get(id); if (typeof value === 'function') return (value as () => unknown)(); return value ?? { conversationId: id, messages: [] }; },
    send: (request: unknown) => { calls.push(['send', request]); return sendReply(); },
    stop: async (turnId: string) => { calls.push(['stop', turnId]); return true; },
    remove: async (id: string) => { calls.push(['remove', id]); return true; },
    onEvent: (fn: (event: unknown) => void) => { listener = fn; return () => { listener = null; }; },
    ...overrides,
  };
  return { bridge: Object.freeze(bridge), calls, histories,
    emit: (event: Record<string, unknown>) => listener?.({ conversationId: 'conv-new', turnId: 'turn-1', ...event }),
    listening: () => !!listener,
    setList: (rows: unknown[]) => { conversations = rows; },
    reply: (fn: () => Promise<unknown>) => { sendReply = fn; } };
}

test('bridge detection is strict and absence shows a clear desktop-only state', async () => {
  assert.equal(readClaudeChatBridge(null), null);
  assert.equal(readClaudeChatBridge({ arcaneDesktop: { claudeChat: { version: 2 } } }), null);
  assert.equal(readClaudeChatBridge({ arcaneDesktop: { claudeChat: { ...fakeBridge().bridge, send: 'nope' } } }), null);
  assert.ok(readClaudeChatBridge({ arcaneDesktop: { claudeChat: fakeBridge().bridge } }));
  const f = mount(undefined);
  await f.chat.refresh();
  assert.equal(f.chat.available(), false);
  assert.equal(f.status.textContent, CLAUDE_CHAT_NO_BRIDGE_TEXT);
  assert.equal(f.input.disabled, true); assert.equal(f.send.disabled, true); assert.equal(f.create.disabled, true);
  assert.equal(f.messages.querySelector('.claude-chat-empty')?.textContent, CLAUDE_CHAT_EMPTY_TEXT);
  f.type('hello'); key(f.input, 'Enter'); await tick();
  assert.equal(f.bubbles().length, 0);
});

test('status populates model/effort, restores and persists the last choice, and survives storage denial', async t => {
  const b = fakeBridge(), storage = memory();
  storage.setItem(CLAUDE_CHAT_CHOICE_KEY, JSON.stringify({ model: 'opus', effort: 'max' }));
  const f = mount(b.bridge, storage); t.after(() => f.chat.stop());
  await f.chat.refresh();
  assert.deepEqual(f.model.options.map(option => option.value), ['opus', 'sonnet']);
  assert.equal(f.model.options[1]!.textContent, 'sonnet (default)');
  assert.equal(f.model.value, 'opus'); assert.equal(f.effort.value, 'max');
  assert.equal(f.model.disabled, false); assert.equal(f.input.disabled, false);
  assert.equal(f.send.disabled, true, 'empty draft cannot be sent');
  f.type('  '); assert.equal(f.send.disabled, true); f.type('Build a lobby'); assert.equal(f.send.disabled, false);
  f.effort.value = 'low'; f.effort.dispatchEvent(new Event('change'));
  assert.deepEqual(JSON.parse(storage.data.get(CLAUDE_CHAT_CHOICE_KEY)!), { model: 'opus', effort: 'low' });
  const denied = { getItem: () => { throw Error('denied'); }, setItem: () => { throw Error('denied'); } };
  const g = mount(fakeBridge().bridge, denied); t.after(() => g.chat.stop());
  await g.chat.refresh();
  assert.equal(g.model.value, 'sonnet', 'falls back to the reported default'); assert.equal(g.effort.value, 'high');
  g.model.value = 'opus'; assert.doesNotThrow(() => g.model.dispatchEvent(new Event('change')));
});

test('signed-out or missing CLI keeps sending disabled with the native message', async t => {
  const b = fakeBridge({ status: async () => ({ ...signedIn, signedIn: false, message: 'Run claude to sign in.' }) });
  const f = mount(b.bridge); t.after(() => f.chat.stop()); await f.chat.refresh();
  assert.equal(f.status.textContent, 'Run claude to sign in.'); assert.equal(f.input.disabled, true); assert.equal(f.send.disabled, true);
  const c = fakeBridge({ status: async () => ({ ...signedIn, installed: false, signedIn: true, message: null }) });
  const g = mount(c.bridge); t.after(() => g.chat.stop()); await g.chat.refresh();
  assert.match(g.status.textContent, /Install Claude Code/); assert.equal(g.send.disabled, true);
});

test('Enter sends, Shift+Enter does not, and streamed deltas, messages, tools and usage render in order', async t => {
  const b = fakeBridge(); let resolveSend!: (value: unknown) => void;
  b.reply(() => new Promise(resolve => { resolveSend = resolve; }));
  const f = mount(b.bridge); t.after(() => f.chat.stop()); await f.chat.refresh();
  f.type('Build a lobby');
  const shifted = key(f.input, 'Enter', true); assert.equal(shifted.defaultPrevented, false);
  assert.equal(b.calls.filter(call => call[0] === 'send').length, 0);
  const enter = key(f.input, 'Enter'); assert.equal(enter.defaultPrevented, true);
  assert.deepEqual(b.calls.find(call => call[0] === 'send')![1], { conversationId: null, text: 'Build a lobby', model: 'sonnet', effort: 'high' });
  assert.equal(f.input.value, ''); assert.deepEqual(f.bubbles(), [{ role: 'user', text: 'Build a lobby' }]);
  assert.equal(f.send.disabled, true); assert.equal(f.stop.hidden, false); assert.equal(f.stop.disabled, true, 'stop waits for a turn id');
  assert.equal(f.model.disabled, true);
  // Events can arrive before send() resolves; they are buffered for the returned turn.
  b.emit({ type: 'message', message: { id: 'u1', role: 'user', text: 'Build a lobby', at: '' } });
  b.emit({ type: 'delta', text: 'Sure, ' });
  resolveSend({ turnId: 'turn-1', conversationId: 'conv-new' }); await tick();
  assert.equal(f.chat.activeConversation(), 'conv-new');
  assert.deepEqual(f.bubbles(), [{ role: 'user', text: 'Build a lobby' }, { role: 'assistant', text: 'Sure, ' }], 'user echo is not duplicated');
  b.emit({ type: 'delta', text: 'building it.' });
  assert.equal(f.bubbles().at(-1)!.text, 'Sure, building it.');
  assert.equal(f.messages.querySelectorAll('.claude-message').at(-1)!.getAttribute('aria-busy'), 'true');
  assert.equal(f.messages.scrollTop, f.messages.scrollHeight, 'auto-scrolls while near the bottom');
  b.emit({ type: 'message', message: { id: 'a1', role: 'assistant', text: 'Sure, building it.', at: '' } });
  b.emit({ type: 'tool', message: { id: 't1', role: 'tool', text: 'Edit', at: '', tool: { name: 'Edit', status: 'started' } } });
  const chip = f.messages.querySelector('.claude-tool-chip')!;
  assert.equal(chip.getAttribute('data-status'), 'started'); assert.equal(chip.textContent, 'Edit · running');
  b.emit({ type: 'tool', message: { id: 't1', role: 'tool', text: 'Edit', at: '', tool: { name: 'Edit', status: 'finished' } } });
  assert.equal(f.messages.querySelectorAll('.claude-tool-chip').length, 1); assert.equal(chip.getAttribute('data-status'), 'finished');
  f.messages.scrollTop = 0; f.messages.scrollHeight = 5000; // user scrolled up: no forced scroll
  b.emit({ type: 'delta', text: 'Done.' });
  assert.equal(f.messages.scrollTop, 0);
  b.emit({ type: 'done', ok: true, error: null, usage: { inputTokens: 12, outputTokens: 34, costUsd: 0.0123 } });
  await tick();
  assert.deepEqual(f.bubbles().map(row => row.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(f.status.textContent, 'Done · 12 input tokens · 34 output tokens · $0.0123');
  assert.equal(f.stop.hidden, true); assert.equal(f.chat.running(), false);
  assert.equal(f.items().length, 1, 'new conversation is listed'); assert.equal(f.items()[0]!.getAttribute('aria-current'), 'true');
  f.type('Next'); f.composer.dispatchEvent(new Event('submit', { cancelable: true }));
  assert.deepEqual(b.calls.filter(call => call[0] === 'send').at(-1)![1], { conversationId: 'conv-new', text: 'Next', model: 'sonnet', effort: 'high' });
});

test('Stop calls the bridge once and a stopped turn ends without an error bubble', async t => {
  const b = fakeBridge(); const f = mount(b.bridge); t.after(() => f.chat.stop()); await f.chat.refresh();
  f.type('Long task'); key(f.input, 'Enter'); await tick();
  assert.equal(f.stop.hidden, false); assert.equal(f.stop.disabled, false);
  f.stop.dispatchEvent(new Event('click')); f.stop.dispatchEvent(new Event('click')); await tick();
  assert.deepEqual(b.calls.filter(call => call[0] === 'stop'), [['stop', 'turn-1']]);
  assert.equal(f.status.textContent, 'Stopping…');
  b.emit({ type: 'done', ok: false, error: null, usage: null }); await tick();
  assert.equal(f.bubbles().some(row => row.role === 'error'), false); assert.equal(f.status.textContent, 'Stopped.');
  assert.equal(f.stop.hidden, true);
});

test('list is newest first, switching loads history and ignores stale responses', async t => {
  const b = fakeBridge();
  b.setList([
    { conversationId: 'old', title: 'Old chat', updatedAt: '2026-01-01T00:00:00Z', model: 'opus', effort: 'low' },
    { conversationId: 'new', title: 'New chat', updatedAt: '2026-05-01T00:00:00Z', model: 'opus', effort: 'max' },
    { conversationId: 'new', title: 'duplicate', updatedAt: '', model: '', effort: '' }, { bogus: true },
  ]);
  let releaseOld!: (value: unknown) => void;
  b.histories.set('old', () => new Promise(resolve => { releaseOld = resolve; }));
  b.histories.set('new', { conversationId: 'new', messages: [
    { id: '1', role: 'user', text: 'Make a map', at: '' },
    { id: '2', role: 'tool', text: 'Write', at: '', tool: { name: 'Write', status: 'failed' } },
    { id: '3', role: 'assistant', text: 'Here:\n\n```lua\nprint(1)\n```', at: '' },
    { id: '4', role: 'error', text: 'Rate limited', at: '' }, { role: 'system', text: 'ignored' },
  ] });
  const f = mount(b.bridge); t.after(() => f.chat.stop()); await f.chat.refresh();
  assert.deepEqual(f.items().map(item => item.textContent), ['New chat', 'Old chat']);
  assert.ok(f.items().every(item => item.getAttribute('aria-current') === 'false'));
  f.items()[1]!.dispatchEvent(new Event('click')); await tick();
  assert.equal(f.status.textContent, 'Loading conversation…');
  f.items()[0]!.dispatchEvent(new Event('click')); await tick();
  releaseOld({ conversationId: 'old', messages: [{ id: 'x', role: 'user', text: 'STALE', at: '' }] }); await tick();
  assert.deepEqual(f.bubbles().map(row => row.role), ['user', 'tool', 'assistant', 'error']);
  assert.equal(f.bubbles().some(row => row.text.includes('STALE')), false);
  assert.equal(f.items()[0]!.getAttribute('aria-current'), 'true'); assert.equal(f.items()[1]!.getAttribute('aria-current'), 'false');
  assert.equal(f.messages.querySelector('.claude-tool-chip')!.getAttribute('data-status'), 'failed');
  const code = f.messages.querySelector('code')!;
  assert.equal(code.textContent, 'print(1)'); assert.equal(code.getAttribute('data-language'), 'lua'); assert.equal(code.parent!.tagName, 'PRE');
  assert.equal(f.model.value, 'opus'); assert.equal(f.effort.value, 'max', 'conversation choice is applied');
  f.create.dispatchEvent(new Event('click'));
  assert.equal(f.chat.activeConversation(), null); assert.equal(f.messages.querySelector('.claude-chat-empty')!.textContent, CLAUDE_CHAT_EMPTY_TEXT);
  assert.equal(f.input.focused, 1);
});

test('bridge failures produce safe messages and keep the draft', async t => {
  const failing = fakeBridge({ status: async () => { throw Error('C:/secret/path boom'); } });
  const f = mount(failing.bridge); t.after(() => f.chat.stop()); await f.chat.refresh();
  assert.match(f.status.textContent, /status is unavailable/); assert.doesNotMatch(f.status.textContent, /secret/);
  assert.equal(f.send.disabled, true);

  const b = fakeBridge(); b.reply(async () => { throw Error('ipc exploded'); });
  b.setList([{ conversationId: 'c', title: 'C', updatedAt: '2026-01-01T00:00:00Z', model: '', effort: '' }]);
  b.histories.set('c', () => Promise.reject(Error('gone')));
  const g = mount(b.bridge); t.after(() => g.chat.stop()); await g.chat.refresh();
  g.type('Keep me'); key(g.input, 'Enter'); await tick();
  assert.deepEqual(g.bubbles().map(row => row.role), ['user', 'error']);
  assert.equal(g.bubbles()[1]!.text, 'Claude could not start this message. Try again.');
  assert.equal(g.input.value, 'Keep me'); assert.equal(g.chat.running(), false); assert.equal(g.send.disabled, false);
  g.items()[0]!.dispatchEvent(new Event('click')); await tick();
  assert.equal(g.status.textContent, 'This conversation could not be loaded. Try again.');

  b.reply(async () => ({ turnId: 'turn-1', conversationId: 'conv-new' }));
  g.create.dispatchEvent(new Event('click')); g.type('Go'); key(g.input, 'Enter'); await tick();
  b.emit({ type: 'done', ok: false, error: 'Claude usage limit reached.', usage: null }); await tick();
  assert.deepEqual(g.bubbles().at(-1), { role: 'error', text: 'Claude usage limit reached.' });
  const brokenList = fakeBridge({ list: async () => { throw Error('x'); } });
  const h = mount(brokenList.bridge); t.after(() => h.chat.stop()); await h.chat.refresh();
  assert.equal(h.status.textContent, 'Saved Claude conversations could not be read.'); assert.equal(h.input.disabled, false);
  b.emit({ type: 'nonsense' }); b.emit(null as unknown as Record<string, unknown>);
});

test('model text is never parsed as HTML', async t => {
  innerHtmlWrites = 0;
  const b = fakeBridge(); const f = mount(b.bridge); t.after(() => f.chat.stop()); await f.chat.refresh();
  const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  f.type(hostile); key(f.input, 'Enter'); await tick();
  b.emit({ type: 'delta', text: hostile });
  b.emit({ type: 'tool', message: { id: 't', role: 'tool', text: '', at: '', tool: { name: '<b onmouseover=x>', status: 'started' } } });
  b.emit({ type: 'message', message: { id: 'a', role: 'assistant', text: '```html\n' + hostile + '\n```', at: '' } });
  b.emit({ type: 'done', ok: false, error: '<img src=y onerror=z>', usage: null }); await tick();
  const tags = new Set(f.root.all().map(node => node.tagName));
  for (const tag of ['IMG', 'SCRIPT', 'B']) assert.equal(tags.has(tag), false, tag + ' was not created');
  assert.equal(innerHtmlWrites, 0);
  assert.ok(f.bubbles()[0]!.text.includes('<img src=x onerror="alert(1)">'));
  assert.ok(f.messages.textContent.includes('<b onmouseover=x> · running'));
  assert.equal(f.bubbles().at(-1)!.text, '<img src=y onerror=z>');
  const doc = new DocumentFixture(), target = doc.createElement('div');
  renderClaudeText(doc as unknown as Document, target as unknown as HTMLElement, 'One\n\nTwo\n```\nunterminated <i>');
  assert.deepEqual(target.children.map(child => child.tagName), ['P', 'P', 'PRE']);
  assert.equal(target.children[2]!.textContent, 'unterminated <i>');
});

test('stop() detaches the event listener and refresh re-attaches it', async () => {
  const b = fakeBridge(); const f = mount(b.bridge); await f.chat.refresh();
  assert.equal(b.listening(), true); f.chat.stop(); assert.equal(b.listening(), false);
  await f.chat.refresh(); assert.equal(b.listening(), true); f.chat.stop();
});

test('provider setup swaps the Codex panel for the Claude chat only after a signed-in Claude status', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const { startProviderSetup, PROVIDER_PRESENTATION_KEY } = await import('../../apps/desktop/src/provider-setup.js');
  const ids = ['provider-setup-panel', 'provider-login-gate', 'provider-setup-provider', 'provider-login-start', 'provider-setup-refresh',
    'provider-setup-launch', 'claude-chat', 'claude-chat-terminal', 'codex-compose', 'codex-notice', 'codex-status', 'workspace-chat-tabs', 'workspace-new-chat'];
  const doc = new EventTarget() as EventTarget & { getElementById(id: string): unknown; querySelector(selector: string): unknown; defaultView: unknown };
  const nodes = new Map<string, Element>(ids.map(id => [id, new DocumentFixture().createElement('div')]));
  const scroll = new DocumentFixture().createElement('div');
  nodes.get('claude-chat')!.hidden = true; nodes.get('claude-chat-terminal')!.hidden = true;
  doc.getElementById = id => nodes.get(id) ?? null;
  doc.querySelector = selector => selector === '#codex-panel .conversation-scroll' ? scroll : null;
  const stored = new Map([[PROVIDER_PRESENTATION_KEY, JSON.stringify({ version: 1, provider: 'claude' })]]);
  doc.defaultView = { CustomEvent, location: { protocol: 'http:', origin: 'http://fixture.test' },
    localStorage: { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => stored.set(k, v) } };
  let auth = 'subscription'; const calls: string[] = [];
  const native = Object.freeze({ version: 1, ...Object.fromEntries(['status', 'login', 'install', 'launch'].map(action => [action, async (provider: string) => {
    calls.push(action + ':' + provider);
    return { version: 1, provider, installed: true, auth, cliVersion: '2.1.177', busy: false, message: null };
  }])) });
  const controller = startProviderSetup(doc as unknown as Document, { nativeBridge: native, chat: {
    providerConnectionStatus: () => null, subscribeProviderStateChange: () => () => {} } });
  t.after(() => controller.cleanup());
  const surfaces: string[] = []; controller.subscribeChatSurface(() => surfaces.push(controller.chatSurface()));
  const codexHidden = () => [scroll, ...['codex-compose', 'codex-notice', 'codex-status', 'workspace-chat-tabs', 'workspace-new-chat'].map(id => nodes.get(id)!)].map(node => node.hidden);
  await tick();
  assert.equal(controller.chatSurface(), 'claude'); assert.deepEqual(surfaces, ['claude']);
  assert.equal(nodes.get('provider-login-gate')!.hidden, true); assert.equal(nodes.get('claude-chat')!.hidden, false);
  assert.ok(codexHidden().every(Boolean)); assert.equal(nodes.get('claude-chat-terminal')!.hidden, false);
  t.mock.timers.tick(60001);
  assert.equal(controller.isSignedIn(), false, 'presentation freshness still expires');
  assert.equal(controller.chatSurface(), 'claude', 'an open chat is not re-locked by the freshness clock');
  nodes.get('claude-chat-terminal')!.dispatchEvent(Object.assign(new Event('click'), {}));
  const trusted = new Event('click'); Object.defineProperty(trusted, 'isTrusted', { value: true });
  nodes.get('claude-chat-terminal')!.dispatchEvent(trusted); await tick();
  assert.deepEqual(calls, ['status:claude', 'launch:claude'], 'only a trusted click opens the terminal handoff');
  assert.equal(controller.chatSurface(), 'claude', 'a launch snapshot does not change the chat surface');
  auth = 'signed-out'; const refresh = new Event('click'); Object.defineProperty(refresh, 'isTrusted', { value: true });
  nodes.get('provider-setup-refresh')!.dispatchEvent(refresh); await tick();
  assert.equal(controller.chatSurface(), 'codex'); assert.equal(nodes.get('provider-login-gate')!.hidden, false);
  assert.equal(nodes.get('claude-chat')!.hidden, true); assert.ok(codexHidden().every(hidden => !hidden));
  auth = 'subscription'; nodes.get('provider-setup-refresh')!.dispatchEvent(refresh); await tick();
  assert.equal(controller.chatSurface(), 'claude');
  doc.dispatchEvent(new CustomEvent('workspace:providerpreference', { detail: { provider: 'codex' } })); await tick();
  assert.equal(controller.chatSurface(), 'codex', 'Codex keeps its existing gate'); assert.equal(nodes.get('provider-login-gate')!.hidden, false);
  assert.deepEqual(surfaces, ['claude', 'codex', 'claude', 'codex']);
});

test('known preload rejections are shown verbatim and missing choices block sending', async t => {
  const b = fakeBridge(); b.reply(async () => { throw Error('Another Claude chat reply is still running in this conversation.'); });
  const f = mount(b.bridge); t.after(() => f.chat.stop()); await f.chat.refresh();
  f.type('Hi'); key(f.input, 'Enter'); await tick();
  assert.equal(f.bubbles().at(-1)!.text, 'Another Claude chat reply is still running in this conversation.');
  const empty = fakeBridge({ status: async () => ({ ...signedIn, models: [], efforts: [], defaultModel: null }) });
  const g = mount(empty.bridge); t.after(() => g.chat.stop()); await g.chat.refresh();
  g.type('Hi'); assert.equal(g.send.disabled, true); key(g.input, 'Enter'); await tick();
  assert.equal(empty.calls.some(call => call[0] === 'send'), false);
  assert.match(g.status.textContent, /no model or effort choices/);
});

// F3: per-conversation delete with a two-click confirm step.
function deletable() {
  let rows: { conversationId: string; title: string; updatedAt: string; model: string; effort: string }[] = [
    { conversationId: 'keep', title: 'Keep me', updatedAt: '2026-01-01T00:00:00Z', model: 'opus', effort: 'low' },
    { conversationId: 'drop', title: 'Drop me', updatedAt: '2026-05-01T00:00:00Z', model: 'opus', effort: 'high' },
  ];
  let failRemove = false;
  const b = fakeBridge({
    list: async () => { b.calls.push(['list']); return { conversations: rows }; },
    remove: async (id: string) => { b.calls.push(['remove', id]); if (failRemove) throw Error('C:/private/path EPERM'); const before = rows.length; rows = rows.filter(row => row.conversationId !== id); return rows.length !== before; },
  });
  return { b, failNext: () => { failRemove = true; }, rows: () => rows };
}
const deletes = (f: ReturnType<typeof mount>) => f.list.querySelectorAll('.claude-chat-delete');
const removals = (b: ReturnType<typeof fakeBridge>) => b.calls.filter(call => call[0] === 'remove');

test('each conversation has a labelled delete control that needs a second click to confirm', async t => {
  const { b } = deletable(); const f = mount(b.bridge); t.after(() => f.chat.stop()); await f.chat.refresh();
  assert.deepEqual(f.items().map(item => item.textContent), ['Drop me', 'Keep me'], 'the delete control is not part of the item label');
  assert.deepEqual(deletes(f).map(button => button.getAttribute('aria-label')), ['Delete conversation Drop me', 'Delete conversation Keep me']);
  assert.ok(deletes(f).every(button => button.tagName === 'BUTTON' && button.type === 'button' && !button.disabled));
  deletes(f)[0]!.dispatchEvent(new Event('click')); await tick();
  assert.deepEqual(removals(b), [], 'the first click only asks for confirmation');
  assert.equal(deletes(f)[0]!.textContent, 'Delete?'); assert.equal(deletes(f)[0]!.getAttribute('data-confirm'), 'true');
  assert.equal(deletes(f)[1]!.getAttribute('data-confirm'), null);
  const lists = b.calls.filter(call => call[0] === 'list').length;
  deletes(f)[0]!.dispatchEvent(new Event('click')); await tick(); await tick();
  assert.deepEqual(removals(b), [['remove', 'drop']]);
  assert.ok(b.calls.filter(call => call[0] === 'list').length > lists, 'the list is refreshed');
  assert.deepEqual(f.items().map(item => item.textContent), ['Keep me']);
  assert.equal(f.chat.activeConversation(), null);
});

test('deleting the open conversation returns to an empty new chat; deleting another keeps the open one', async t => {
  const { b } = deletable(); b.histories.set('drop', { conversationId: 'drop', messages: [{ id: '1', role: 'user', text: 'Old text', at: '' }] });
  const f = mount(b.bridge); t.after(() => f.chat.stop()); await f.chat.refresh();
  await f.chat.open('drop'); assert.deepEqual(f.bubbles().map(row => row.text), ['Old text']);
  // Confirming a different row first moves the confirm state instead of deleting.
  deletes(f)[1]!.dispatchEvent(new Event('click')); deletes(f)[0]!.dispatchEvent(new Event('click')); await tick();
  assert.deepEqual(removals(b), []); assert.equal(deletes(f)[0]!.textContent, 'Delete?'); assert.equal(deletes(f)[1]!.getAttribute('data-confirm'), null);
  deletes(f)[0]!.dispatchEvent(new Event('click')); await tick(); await tick();
  assert.deepEqual(removals(b), [['remove', 'drop']]);
  assert.equal(f.chat.activeConversation(), null);
  assert.equal(f.messages.querySelector('.claude-chat-empty')!.textContent, CLAUDE_CHAT_EMPTY_TEXT);
  assert.deepEqual(f.bubbles(), []);
  await f.chat.open('keep'); deletes(f)[0]!.dispatchEvent(new Event('click')); deletes(f)[0]!.dispatchEvent(new Event('click')); await tick(); await tick();
  assert.deepEqual(removals(b).at(-1), ['remove', 'keep']); assert.equal(f.items().length, 0);
});

test('delete is disabled while that conversation has a running turn and failures keep the row', async t => {
  const { b, failNext } = deletable(); const f = mount(b.bridge); t.after(() => f.chat.stop()); await f.chat.refresh();
  await f.chat.open('drop');
  b.reply(async () => ({ turnId: 'turn-1', conversationId: 'drop' }));
  f.type('Keep working'); key(f.input, 'Enter'); await tick();
  assert.equal(f.chat.running(), true);
  const byId = (id: string) => deletes(f).find(button => button.parent!.querySelector('.claude-chat-item')!.getAttribute('data-conversation-id') === id)!;
  assert.equal(byId('drop').disabled, true, 'the running conversation cannot be deleted');
  assert.equal(byId('keep').disabled, false, 'other conversations stay deletable');
  byId('drop').dispatchEvent(new Event('click')); byId('drop').dispatchEvent(new Event('click')); await tick();
  assert.deepEqual(removals(b), []);
  b.emit({ conversationId: 'drop', type: 'done', ok: true, error: null, usage: null }); await tick(); await tick();
  assert.equal(byId('drop').disabled, false, 'enabled again once the turn finished');
  failNext(); byId('keep').dispatchEvent(new Event('click')); byId('keep').dispatchEvent(new Event('click')); await tick(); await tick();
  assert.deepEqual(removals(b), [['remove', 'keep']]);
  assert.equal(f.status.textContent, 'This conversation could not be deleted. Try again.');
  assert.doesNotMatch(f.status.textContent, /private|EPERM/);
  assert.deepEqual(f.items().map(item => item.textContent).sort(), ['Drop me', 'Keep me']);
  assert.equal(f.chat.activeConversation(), 'drop');
});
