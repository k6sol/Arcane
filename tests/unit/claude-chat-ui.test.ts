/// <reference lib="dom" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { ChatState } from '../../apps/desktop/src/codex-chat.js';
import { workflowNativeModel } from '../../apps/daemon/src/workflow-native-model.js';
import {
  ClaudeChat, CLAUDE_CHAT_CHOICE_KEY, CLAUDE_CHAT_EMPTY_TEXT, CLAUDE_CHAT_NO_BRIDGE_TEXT, CLAUDE_CHAT_TABS_KEY,
  claudeEffortLabel, claudeModelName, linkChatProviders, readClaudeChatBridge,
} from '../../apps/desktop/src/claude-chat.js';

// In-memory DOM and preload-bridge doubles only: no Electron, CLI, network, Studio or inference.
// The fixture mirrors the shared chat surface ids from studio.html that both providers render into.
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
let innerHtmlWrites = 0;
class Element extends EventTarget {
  tagName: string; id = ''; className = ''; type = ''; title = ''; value = ''; hidden = false; disabled = false; open = false;
  tabIndex = 0; max = ''; scrollTop = 0; scrollHeight = 0; clientHeight = 0; children: Element[] = []; parent: Element | null = null; focused = 0;
  dataset: Record<string, string> = {}; style = { setProperty: (_name: string, _value: string) => {} };
  private content = ''; private attributes = new Map<string, string>();
  constructor(tag: string, readonly ownerDocument: DocumentFixture) { super(); this.tagName = tag.toUpperCase(); }
  get textContent(): string { return this.content + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.content = String(value); this.children = []; }
  set innerHTML(_value: string) { innerHtmlWrites++; throw Error('innerHTML is forbidden'); }
  append(...children: Element[]) { for (const child of children) { child.parent = this; this.children.push(child); this.ownerDocument.register(child); } this.scrollHeight += 100 * children.length; }
  replaceChildren(...children: Element[]) { this.content = ''; this.children = []; this.append(...children); }
  setAttribute(name: string, value: string) { this.attributes.set(name, String(value)); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string) { this.attributes.delete(name); }
  prepend(child: Element) { this.append(child); this.children.unshift(this.children.pop()!); }
  replaceWith(next: Element) { const parent = this.parent!; next.parent = parent; parent.children[parent.children.indexOf(this)] = next; this.ownerDocument.register(next); }
  focus() { this.focused++; this.ownerDocument.activeElement = this; }
  click() { this.dispatchEvent(new Event('click', { cancelable: true })); }
  contains(node: unknown): boolean { return node === this || this.children.some(child => child.contains(node)); }
  all(): Element[] { return this.children.flatMap(child => [child, ...child.all()]); }
  matches(selector: string): boolean {
    const parts = selector.trim().split(/\s+/); let node: Element | null = this;
    if (!simple(this, parts.pop()!)) return false;
    for (const part of parts.reverse()) { node = node!.parent; while (node && !simple(node, part)) node = node.parent; if (!node) return false; }
    return true;
  }
  closest(selector: string): Element | null { let node: Element | null = this; while (node && !node.matches(selector)) node = node.parent; return node; }
  querySelectorAll(selector: string): Element[] { return this.all().filter(node => node.matches(selector)); }
  querySelector(selector: string): Element | null { return this.querySelectorAll(selector)[0] ?? null; }
}
function simple(node: Element, selector: string): boolean {
  const not = selector.endsWith(':not(:disabled)'); if (not) { if (node.disabled) return false; selector = selector.slice(0, -':not(:disabled)'.length); }
  if (selector.startsWith('.')) return node.className.split(/\s+/).includes(selector.slice(1));
  if (selector.startsWith('#')) return node.id === selector.slice(1);
  const attribute = /^\[([a-z-]+)=([^\]]+)\]$/.exec(selector); if (attribute) return node.getAttribute(attribute[1]!) === attribute[2];
  return node.tagName === selector.toUpperCase();
}
class DocumentFixture extends EventTarget {
  defaultView = null; activeElement: Element | null = null; nodes = new Map<string, Element>();
  createElement(tag: string) { return new Element(tag, this); }
  createElementNS(_ns: string, tag: string) { return new Element(tag, this); }
  register(node: Element) { if (node.id) this.nodes.set(node.id, node); for (const child of node.children) this.register(child); }
  getElementById(id: string) { return this.nodes.get(id) ?? null; }
}

function key(target: Element, value: string, shiftKey = false) {
  const event = new Event('keydown', { cancelable: true });
  Object.defineProperties(event, { key: { value }, shiftKey: { value: shiftKey }, isComposing: { value: false } });
  target.dispatchEvent(event); return event;
}
const click = (target: Element) => target.dispatchEvent(new Event('click', { cancelable: true }));
function surface() {
  const doc = new DocumentFixture();
  const make = (tag: string, id: string, className = '', ...children: Element[]) => { const node = doc.createElement(tag); node.id = id; node.className = className; node.append(...children); return node; };
  const svg = doc.createElement('svg'); svg.append(doc.createElement('path'));
  const submit = make('button', 'codex-submit'); submit.type = 'submit'; submit.append(svg);
  const composer = make('textarea', 'codex-composer');
  const form = make('form', 'codex-compose', 'composer', make('div', 'codex-attachments'), composer, make('div', '', 'composer-controls',
    make('button', 'codex-model-trigger', 'composer-model-trigger', make('span', 'codex-model-label'), make('span', 'codex-effort-label', 'picker-effort')),
    make('span', 'codex-model-picker-status'), make('button', 'workspace-add-context'), submit), make('div', 'codex-draft-review'));
  const popover = make('div', 'codex-model-popover', 'composer-model-popover',
    make('section', 'codex-picker-summary', 'picker-summary', make('strong', 'codex-picker-effort-value'), make('button', 'codex-picker-reset'),
      make('button', 'codex-picker-current-model', '', make('span', 'codex-picker-current-model-label')), make('input', 'codex-picker-effort-slider'),
      make('div', '', 'picker-effort-section', make('button', 'codex-picker-reasoning-trigger'), make('div', 'codex-picker-efforts'), make('p', 'codex-picker-effort-hint'))),
    make('section', 'codex-picker-model-list', '', make('button', 'codex-picker-back'), make('input', 'codex-model-search'), make('div', 'codex-model-options'), make('p', 'codex-model-empty')));
  popover.hidden = true;
  const root = make('main', 'root', '', make('div', 'claude-chat-tabs', 'workspace-chat-tabs'), make('details', 'claude-saved-chats', 'chat-tabs-history'),
    make('button', 'workspace-new-chat'), make('span', 'claude-chat-status'), make('p', 'claude-chat-notice'), make('div', 'codex-messages', 'codex-messages'),
    make('button', 'welcome-connect'), make('button', 'codex-conversation-start'), form, popover);
  doc.register(root);
  const el = (id: string) => doc.getElementById(id)!;
  el('codex-messages').clientHeight = 300;
  return { doc, root, el };
}
function mount(bridge: unknown, storage: Pick<Storage, 'getItem' | 'setItem'> | null = memory(), activate = true) {
  const { doc, root, el } = surface();
  const chat = new ClaudeChat(doc as unknown as Document, { bridge, storage });
  if (activate) chat.activate();
  const input = el('codex-composer'), messages = el('codex-messages');
  const type = (text: string) => { input.value = text; input.dispatchEvent(new Event('input')); };
  const bubbles = () => messages.querySelectorAll('.codex-message').map(node => ({ role: node.getAttribute('data-role'), text: node.querySelector('.message-text')!.textContent }));
  const tabs = () => el('claude-chat-tabs').querySelectorAll('[role=tab]');
  const saved = () => el('claude-saved-chats').querySelectorAll('button').filter(node => node.dataset.conversationId);
  const remove = () => el('claude-saved-chats').querySelector('.claude-chat-delete');
  return { chat, doc, root, el, input, messages, submit: el('codex-submit'), form: el('codex-compose'), notice: el('claude-chat-notice'), trigger: el('codex-model-trigger'), type, bubbles, tabs, saved, remove };
}
function memory() { const data = new Map<string, string>(); return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } }; }
const signedIn = { installed: true, signedIn: true, cliVersion: '2.1.177', models: ['opus', 'sonnet', 'claude-haiku-4-5-20251001'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultModel: 'sonnet', message: null };
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
const sends = (b: ReturnType<typeof fakeBridge>) => b.calls.filter(call => call[0] === 'send').map(call => call[1]);

test('friendly model names show the family and any version; efforts get readable labels', () => {
  assert.deepEqual(claudeModelName('opus'), { short: 'Opus', full: 'Claude Opus' });
  assert.deepEqual(claudeModelName('sonnet'), { short: 'Sonnet', full: 'Claude Sonnet' });
  assert.deepEqual(claudeModelName('haiku'), { short: 'Haiku', full: 'Claude Haiku' });
  assert.equal(claudeModelName('claude-opus-4-1-20250805').full, 'Claude Opus 4.1');
  assert.equal(claudeModelName('claude-sonnet-4-5').full, 'Claude Sonnet 4.5');
  assert.equal(claudeModelName('claude-3-5-haiku-20241022').full, 'Claude Haiku 3.5');
  assert.equal(claudeModelName('claude-haiku-4-5-20251001').short, 'Haiku 4.5');
  assert.equal(claudeModelName('sonnet[1m]').full, 'Claude Sonnet (1M context)');
  assert.equal(claudeModelName('opusplan').full, 'Claude Opus Plan');
  assert.deepEqual(claudeModelName('mystery-model'), { short: 'mystery-model', full: 'mystery-model' });
  assert.deepEqual(['low', 'medium', 'high', 'xhigh', 'max'].map(claudeEffortLabel), ['Low', 'Medium', 'High', 'Extra high', 'Max']);
});

test('bridge detection is strict and absence shows a clear desktop-only state', async () => {
  assert.equal(readClaudeChatBridge(null), null);
  assert.equal(readClaudeChatBridge({ arcaneDesktop: { claudeChat: { version: 2 } } }), null);
  assert.equal(readClaudeChatBridge({ arcaneDesktop: { claudeChat: { ...fakeBridge().bridge, send: 'nope' } } }), null);
  assert.ok(readClaudeChatBridge({ arcaneDesktop: { claudeChat: fakeBridge().bridge } }));
  const f = mount(undefined);
  await f.chat.refresh();
  assert.equal(f.chat.available(), false);
  assert.equal(f.notice.textContent, CLAUDE_CHAT_NO_BRIDGE_TEXT);
  assert.equal(f.input.disabled, true); assert.equal(f.submit.disabled, true); assert.equal(f.trigger.disabled, true);
  assert.equal(f.messages.querySelector('.empty')?.textContent, CLAUDE_CHAT_EMPTY_TEXT);
  f.type('hello'); key(f.input, 'Enter'); await tick();
  assert.equal(f.bubbles().length, 0);
});

test('activation takes over the shared surface and deactivation hands it back untouched', async t => {
  const b = fakeBridge(); const f = mount(b.bridge, memory(), false); t.after(() => f.chat.stop());
  f.input.value = 'Codex draft'; f.el('workspace-add-context').hidden = false;
  await f.chat.refresh();
  assert.equal(f.input.value, 'Codex draft', 'an inactive Claude chat never writes the shared composer');
  key(f.input, 'Enter'); await tick(); assert.deepEqual(sends(b), [], 'handlers are inert while Codex owns the surface');
  f.chat.activate();
  assert.equal(f.chat.isActive(), true);
  assert.equal(f.input.value, '', 'the Claude tab draft is shown');
  for (const id of ['workspace-add-context', 'welcome-connect', 'codex-conversation-start']) assert.equal(f.el(id).hidden, true, id);
  assert.equal(f.doc.getElementById('codex-model-provider'), null, 'No provider tag: the model name carries the provider');
  assert.equal(f.tabs().length, 1); assert.equal(f.tabs()[0]!.textContent, 'New chat'); assert.equal(f.tabs()[0]!.getAttribute('aria-controls'), 'codex-messages');
  f.type('Claude draft');
  f.chat.deactivate();
  assert.equal(f.el('workspace-add-context').hidden, false);
  f.input.value = 'Codex again'; key(f.input, 'Enter'); await tick(); assert.deepEqual(sends(b), []);
  f.chat.activate(); assert.equal(f.input.value, 'Claude draft', 'the Claude draft survives the round trip');
});

test('the shared picker shows provider type, friendly model and reasoning, and choices persist', async t => {
  const b = fakeBridge(), storage = memory();
  storage.setItem(CLAUDE_CHAT_CHOICE_KEY, JSON.stringify({ model: 'opus', effort: 'max' }));
  const f = mount(b.bridge, storage); t.after(() => f.chat.stop());
  await f.chat.refresh();
  assert.equal(f.el('codex-model-label').textContent, 'Claude Opus', 'the full model name carries the provider'); assert.equal(f.el('codex-effort-label').textContent, 'max');
  assert.equal(f.el('codex-effort-label').hidden, false);
  assert.equal(f.trigger.getAttribute('aria-label'), 'Claude model: Claude Opus (opus), reasoning: Max');
  assert.equal(f.trigger.disabled, false); assert.equal(f.input.disabled, false);
  assert.equal(f.submit.disabled, true, 'empty draft cannot be sent');
  f.type('  '); assert.equal(f.submit.disabled, true); f.type('Build a lobby'); assert.equal(f.submit.disabled, false);
  click(f.trigger);
  assert.equal(f.el('codex-model-popover').hidden, false); assert.equal(f.trigger.getAttribute('aria-expanded'), 'true');
  assert.equal(f.el('codex-picker-effort-value').textContent, 'Max');
  assert.equal(f.el('codex-picker-current-model-label').textContent, 'Claude Opus');
  const slider = f.el('codex-picker-effort-slider');
  assert.equal(slider.max, '4'); assert.equal(slider.value, '4'); assert.equal(slider.dataset.effortTone, 'ultra');
  slider.value = '1'; slider.dispatchEvent(new Event('input'));
  assert.equal(f.el('codex-effort-label').textContent, 'medium'); assert.equal(f.el('codex-picker-effort-value').textContent, 'Medium');
  assert.deepEqual(JSON.parse(storage.data.get(CLAUDE_CHAT_CHOICE_KEY)!), { model: 'opus', effort: 'medium' });
  click(f.el('codex-picker-reset')); assert.equal(f.el('codex-effort-label').textContent, 'high');
  click(f.el('codex-picker-current-model'));
  assert.equal(f.el('codex-picker-model-list').hidden, false); assert.equal(f.el('codex-picker-summary').hidden, true);
  const options = () => f.el('codex-model-options').querySelectorAll('.picker-model-option');
  assert.deepEqual(options().map(row => row.textContent), ['Claude Opus', 'Claude Sonnet', 'Claude Haiku 4.5']);
  assert.deepEqual(options().map(row => row.getAttribute('aria-selected')), ['true', 'false', 'false']);
  assert.equal(options()[1]!.title, 'sonnet · Claude Code default');
  const search = f.el('codex-model-search'); search.value = 'hai'; search.dispatchEvent(new Event('input'));
  assert.deepEqual(options().map(row => row.textContent), ['Claude Haiku 4.5']);
  click(options()[0]!);
  assert.equal(f.el('codex-model-label').textContent, 'Claude Haiku 4.5'); assert.equal(f.el('codex-picker-summary').hidden, false);
  assert.deepEqual(JSON.parse(storage.data.get(CLAUDE_CHAT_CHOICE_KEY)!), { model: 'claude-haiku-4-5-20251001', effort: 'high' });
  key(f.el('codex-picker-current-model'), 'Escape'); // keydown bubbles from inside the popover
  f.el('codex-model-popover').dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' }));
  assert.equal(f.el('codex-model-popover').hidden, true); assert.equal(f.trigger.getAttribute('aria-expanded'), 'false');
  key(f.input, 'Enter'); await tick();
  assert.deepEqual(sends(b), [{ conversationId: null, text: 'Build a lobby', model: 'claude-haiku-4-5-20251001', effort: 'high' }]);
  const denied = { getItem: () => { throw Error('denied'); }, setItem: () => { throw Error('denied'); } };
  const g = mount(fakeBridge().bridge, denied); t.after(() => g.chat.stop());
  await g.chat.refresh();
  assert.equal(g.el('codex-model-label').textContent, 'Claude Sonnet', 'falls back to the reported default'); assert.equal(g.el('codex-effort-label').textContent, 'high');
  click(g.trigger); assert.doesNotThrow(() => click(g.el('codex-picker-reset')));
});

test('signed-out or missing CLI keeps sending and the picker disabled with the native message', async t => {
  const b = fakeBridge({ status: async () => ({ ...signedIn, signedIn: false, message: 'Run claude to sign in.' }) });
  const f = mount(b.bridge); t.after(() => f.chat.stop()); await f.chat.refresh();
  assert.equal(f.notice.textContent, 'Run claude to sign in.'); assert.equal(f.input.disabled, true); assert.equal(f.submit.disabled, true);
  assert.equal(f.trigger.disabled, true); assert.equal(f.el('claude-chat-status').textContent, 'Not signed in');
  const c = fakeBridge({ status: async () => ({ ...signedIn, installed: false, signedIn: true, message: null }) });
  const g = mount(c.bridge); t.after(() => g.chat.stop()); await g.chat.refresh();
  assert.match(g.notice.textContent, /Install Claude Code/); assert.equal(g.submit.disabled, true);
});

test('Enter sends; streamed deltas, messages, tools and usage render as Codex transcript markup', async t => {
  const b = fakeBridge(); let resolveSend!: (value: unknown) => void;
  b.reply(() => new Promise(resolve => { resolveSend = resolve; }));
  const f = mount(b.bridge); t.after(() => f.chat.stop()); await f.chat.refresh();
  f.type('Build a lobby');
  const shifted = key(f.input, 'Enter', true); assert.equal(shifted.defaultPrevented, false);
  assert.equal(sends(b).length, 0);
  const enter = key(f.input, 'Enter'); assert.equal(enter.defaultPrevented, true);
  assert.deepEqual(sends(b)[0], { conversationId: null, text: 'Build a lobby', model: 'sonnet', effort: 'high' });
  assert.equal(f.input.value, ''); assert.deepEqual(f.bubbles(), [{ role: 'user', text: 'Build a lobby' }]);
  const human = f.messages.querySelector('.codex-message')!;
  assert.equal(human.className, 'codex-message human'); assert.equal(human.getAttribute('aria-label'), 'Your message');
  assert.ok(human.querySelector('.message-details'), 'messages carry the same details disclosure as Codex');
  assert.equal(f.submit.getAttribute('aria-label'), 'Stop task'); assert.equal(f.submit.type, 'button');
  assert.equal(f.submit.disabled, true, 'stop waits for a turn id');
  assert.equal(f.el('codex-submit').querySelector('svg path')!.getAttribute('d'), 'M7 7h10v10H7Z');
  // Events can arrive before send() resolves; they are buffered for the returned turn.
  b.emit({ type: 'message', message: { id: 'u1', role: 'user', text: 'Build a lobby', at: '' } });
  b.emit({ type: 'delta', text: 'Sure, ' });
  resolveSend({ turnId: 'turn-1', conversationId: 'conv-new' }); await tick();
  assert.equal(f.chat.activeConversation(), 'conv-new');
  assert.deepEqual(f.bubbles(), [{ role: 'user', text: 'Build a lobby' }, { role: 'assistant', text: 'Sure, ' }], 'user echo is not duplicated');
  assert.equal(f.messages.querySelectorAll('.codex-message').at(-1)!.className, 'codex-message codex');
  b.emit({ type: 'delta', text: 'building it.' });
  assert.equal(f.bubbles().at(-1)!.text, 'Sure, building it.');
  assert.equal(f.messages.querySelectorAll('.codex-message').at(-1)!.getAttribute('aria-busy'), 'true');
  assert.equal(f.messages.scrollTop, f.messages.scrollHeight, 'auto-scrolls while near the bottom');
  b.emit({ type: 'message', message: { id: 'a1', role: 'assistant', text: 'Sure, building it.', at: '' } });
  b.emit({ type: 'tool', message: { id: 't1', role: 'tool', text: 'Edit', at: '', tool: { name: 'Edit', status: 'started' } } });
  const tool = f.messages.querySelectorAll('.codex-message').at(-1)!;
  assert.equal(tool.className, 'codex-message tool'); assert.equal(tool.querySelector('.message-text')!.textContent, 'Edit · running');
  b.emit({ type: 'tool', message: { id: 't1', role: 'tool', text: 'Edit', at: '', tool: { name: 'Edit', status: 'finished' } } });
  assert.equal(f.messages.querySelectorAll('.tool').length, 1); assert.equal(tool.querySelector('.message-text')!.textContent, 'Edit · done');
  f.messages.scrollTop = 0; f.messages.scrollHeight = 5000; // user scrolled up: no forced scroll
  b.emit({ type: 'delta', text: 'Done.' });
  assert.equal(f.messages.scrollTop, 0);
  b.emit({ type: 'done', ok: true, error: null, usage: { inputTokens: 12, outputTokens: 34, costUsd: 0.0123 } });
  await tick();
  assert.deepEqual(f.bubbles().map(row => row.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(f.notice.textContent, 'Done · 12 input tokens · 34 output tokens · $0.0123');
  assert.equal(f.submit.getAttribute('aria-label'), 'Send message'); assert.equal(f.chat.running(), false);
  assert.equal(f.tabs()[0]!.textContent, 'Build a lobby', 'the new conversation names its tab');
  assert.deepEqual(f.saved().map(row => row.textContent), ['Build a lobby']); assert.equal(f.saved()[0]!.getAttribute('aria-current'), 'true');
  f.type('Next'); f.form.dispatchEvent(new Event('submit', { cancelable: true }));
  assert.deepEqual(sends(b).at(-1), { conversationId: 'conv-new', text: 'Next', model: 'sonnet', effort: 'high' });
});

test('the composer button stops the running turn once and a stopped turn ends without an error bubble', async t => {
  const b = fakeBridge(); const f = mount(b.bridge); t.after(() => f.chat.stop()); await f.chat.refresh();
  f.type('Long task'); key(f.input, 'Enter'); await tick();
  assert.equal(f.submit.getAttribute('aria-label'), 'Stop task'); assert.equal(f.submit.disabled, false);
  click(f.submit); click(f.submit); await tick();
  assert.deepEqual(b.calls.filter(call => call[0] === 'stop'), [['stop', 'turn-1']]);
  assert.equal(f.notice.textContent, 'Stopping…');
  b.emit({ type: 'done', ok: false, error: null, usage: null }); await tick();
  assert.equal(f.bubbles().some(row => row.role === 'error'), false); assert.equal(f.notice.textContent, 'Stopped.');
  assert.equal(f.submit.getAttribute('aria-label'), 'Send message');
});

test('Saved chats list newest first; opening adds a tab, loads history and ignores stale responses', async t => {
  const b = fakeBridge();
  b.setList([
    { conversationId: 'old', title: 'Old chat', updatedAt: '2026-01-01T00:00:00Z', model: 'opus', effort: 'low' },
    { conversationId: 'new', title: 'Newer chat', updatedAt: '2026-05-01T00:00:00Z', model: 'opus', effort: 'max' },
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
  const storage = memory();
  const f = mount(b.bridge, storage); t.after(() => f.chat.stop()); await f.chat.refresh();
  assert.deepEqual(f.saved().map(item => item.textContent), ['Newer chat', 'Old chat']);
  assert.equal(f.saved()[0]!.title, 'Claude Opus · max · 2026-05-01T00:00:00Z');
  click(f.saved()[1]!); await tick();
  assert.equal(f.messages.querySelector('.empty')!.textContent, 'Loading conversation…');
  assert.deepEqual(f.tabs().map(tab => tab.textContent), ['Old chat'], 'the empty draft tab is reused');
  click(f.saved()[0]!); await tick();
  releaseOld({ conversationId: 'old', messages: [{ id: 'x', role: 'user', text: 'STALE', at: '' }] }); await tick();
  assert.deepEqual(f.bubbles().map(row => row.role), ['user', 'tool', 'assistant', 'error']);
  assert.equal(f.bubbles().some(row => row.text.includes('STALE')), false);
  const rich = f.messages.querySelectorAll('.codex-message')[2]!.querySelector('.message-text')!;
  assert.deepEqual(rich.children.map(child => child.tagName), ['P', 'PRE'], 'paragraphs and fenced code render as DOM nodes');
  const code = rich.querySelector('code')!; assert.equal(code.textContent, 'print(1)'); assert.equal(code.getAttribute('data-language'), 'lua');
  assert.equal(rich.className, 'message-text claude-message-body');
  assert.deepEqual(f.tabs().map(tab => [tab.textContent, tab.getAttribute('aria-selected')]), [['Old chat', 'false'], ['Newer chat', 'true']]);
  assert.equal(f.el('codex-model-label').textContent, 'Claude Opus'); assert.equal(f.el('codex-effort-label').textContent, 'max', 'conversation choice is applied');
  assert.deepEqual(JSON.parse(storage.data.get(CLAUDE_CHAT_TABS_KEY)!), { version: 1, open: ['old', 'new'], active: 'new' });
  // Tabs switch, close and keep per-tab drafts.
  f.type('half-written');
  click(f.tabs()[0]!); await tick();
  assert.equal(f.chat.activeConversation(), 'old'); assert.equal(f.input.value, '');
  click(f.tabs()[1]!); await tick(); assert.equal(f.input.value, 'half-written');
  click(f.el('claude-chat-tabs').querySelectorAll('button').find(button => button.getAttribute('aria-label') === 'Close Newer chat')!); await tick();
  assert.deepEqual(f.tabs().map(tab => tab.textContent), ['Old chat']); assert.equal(f.chat.activeConversation(), 'old');
  f.chat.newChat();
  assert.equal(f.chat.activeConversation(), null); assert.equal(f.messages.querySelector('.empty')!.textContent, CLAUDE_CHAT_EMPTY_TEXT);
  assert.deepEqual(f.tabs().map(tab => tab.textContent), ['Old chat', 'New chat']);
  assert.equal(f.input.focused, 1);
  f.chat.newChat(); assert.equal(f.tabs().length, 2, 'an empty draft tab is reused');
  // Restored tabs reopen; ones whose conversation vanished close.
  storage.setItem(CLAUDE_CHAT_TABS_KEY, JSON.stringify({ version: 1, open: ['gone', 'new'], active: 'new' }));
  const g = mount(b.bridge, storage); t.after(() => g.chat.stop()); await g.chat.refresh(); await tick();
  assert.deepEqual(g.tabs().map(tab => tab.textContent), ['Newer chat']); assert.equal(g.chat.activeConversation(), 'new');
});

test('bridge failures produce safe messages and keep the draft', async t => {
  const failing = fakeBridge({ status: async () => { throw Error('C:/secret/path boom'); } });
  const f = mount(failing.bridge); t.after(() => f.chat.stop()); await f.chat.refresh();
  assert.match(f.notice.textContent, /status is unavailable/); assert.doesNotMatch(f.notice.textContent, /secret/);
  assert.equal(f.submit.disabled, true);

  const b = fakeBridge(); b.reply(async () => { throw Error('ipc exploded'); });
  b.setList([{ conversationId: 'c', title: 'C', updatedAt: '2026-01-01T00:00:00Z', model: '', effort: '' }]);
  b.histories.set('c', () => Promise.reject(Error('gone')));
  const g = mount(b.bridge); t.after(() => g.chat.stop()); await g.chat.refresh();
  g.type('Keep me'); key(g.input, 'Enter'); await tick();
  assert.deepEqual(g.bubbles().map(row => row.role), ['user', 'error']);
  assert.equal(g.bubbles()[1]!.text, 'Claude could not start this message. Try again.');
  assert.equal(g.input.value, 'Keep me'); assert.equal(g.chat.running(), false); assert.equal(g.submit.disabled, false);
  g.input.value = ''; click(g.saved()[0]!); await tick();
  assert.equal(g.notice.textContent, 'This conversation could not be loaded. Try again.');

  b.reply(async () => ({ turnId: 'turn-1', conversationId: 'conv-new' }));
  g.chat.newChat(); g.type('Go'); key(g.input, 'Enter'); await tick();
  b.emit({ type: 'done', ok: false, error: 'Claude usage limit reached.', usage: null }); await tick();
  assert.deepEqual(g.bubbles().at(-1), { role: 'error', text: 'Claude usage limit reached.' });
  const brokenList = fakeBridge({ list: async () => { throw Error('x'); } });
  const h = mount(brokenList.bridge); t.after(() => h.chat.stop()); await h.chat.refresh();
  assert.equal(h.notice.textContent, 'Saved Claude conversations could not be read.'); assert.equal(h.input.disabled, false);
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
});

test('stop() detaches the event listener and refresh re-attaches it', async () => {
  const b = fakeBridge(); const f = mount(b.bridge); await f.chat.refresh();
  assert.equal(b.listening(), true); f.chat.stop(); assert.equal(b.listening(), false); assert.equal(f.chat.isActive(), false);
  await f.chat.refresh(); assert.equal(b.listening(), true); f.chat.stop();
});

test('provider setup swaps only the provider-specific nodes of the shared chat surface after a signed-in Claude status', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const { startProviderSetup, PROVIDER_PRESENTATION_KEY, CODEX_SURFACE_SELECTORS, CLAUDE_SURFACE_SELECTORS } = await import('../../apps/desktop/src/provider-setup.js');
  const codexIds = CODEX_SURFACE_SELECTORS.map(selector => selector.slice(1)), claudeIds = CLAUDE_SURFACE_SELECTORS.map(selector => selector.slice(1));
  const shared = ['codex-compose', 'codex-messages', 'workspace-new-chat'];
  const ids = ['provider-setup-panel', 'provider-login-gate', 'provider-setup-provider', 'provider-login-start', 'provider-setup-refresh',
    'provider-setup-launch', 'claude-chat-terminal', ...codexIds, ...claudeIds, ...shared];
  const doc = new EventTarget() as EventTarget & { getElementById(id: string): unknown; defaultView: unknown };
  const nodes = new Map<string, Element>(ids.map(id => [id, new DocumentFixture().createElement('div')]));
  for (const id of [...claudeIds, 'claude-chat-terminal']) nodes.get(id)!.hidden = true;
  doc.getElementById = id => nodes.get(id) ?? null;
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
  const hidden = (list: string[]) => list.map(id => nodes.get(id)!.hidden);
  await tick();
  assert.equal(controller.chatSurface(), 'claude'); assert.deepEqual(surfaces, ['claude']);
  assert.equal(nodes.get('provider-login-gate')!.hidden, true);
  assert.ok(hidden(codexIds).every(Boolean)); assert.ok(hidden(claudeIds).every(value => !value));
  assert.ok(hidden(shared).every(value => !value), 'the shared transcript, composer and New chat stay visible');
  assert.equal(nodes.get('claude-chat-terminal')!.hidden, false);
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
  assert.ok(hidden(codexIds).every(value => !value)); assert.ok(hidden(claudeIds).every(Boolean));
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
  g.type('Hi'); assert.equal(g.submit.disabled, true); key(g.input, 'Enter'); await tick();
  assert.equal(empty.calls.some(call => call[0] === 'send'), false);
  assert.match(g.notice.textContent, /no model or reasoning choices/);
  assert.equal(g.trigger.disabled, true);
});

// Per-conversation delete with a two-click confirm step, from Saved chats.
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
  return { b, failNext: () => { failRemove = true; } };
}
const removals = (b: ReturnType<typeof fakeBridge>) => b.calls.filter(call => call[0] === 'remove');

test('the open chat can be deleted from Saved chats after a confirming second click', async t => {
  const { b } = deletable(); b.histories.set('drop', { conversationId: 'drop', messages: [{ id: '1', role: 'user', text: 'Old text', at: '' }] });
  const f = mount(b.bridge); t.after(() => f.chat.stop()); await f.chat.refresh();
  assert.equal(f.remove(), null, 'a new chat has nothing to delete');
  await f.chat.open('drop'); assert.deepEqual(f.bubbles().map(row => row.text), ['Old text']);
  assert.equal(f.remove()!.textContent, 'Delete this chat'); assert.equal(f.remove()!.type, 'button');
  click(f.remove()!); await tick();
  assert.deepEqual(removals(b), [], 'the first click only asks for confirmation');
  assert.equal(f.remove()!.textContent, 'Click again to delete this chat'); assert.equal(f.remove()!.getAttribute('data-confirm'), 'true');
  const lists = b.calls.filter(call => call[0] === 'list').length;
  click(f.remove()!); await tick(); await tick();
  assert.deepEqual(removals(b), [['remove', 'drop']]);
  assert.ok(b.calls.filter(call => call[0] === 'list').length > lists, 'the list is refreshed');
  assert.deepEqual(f.saved().map(item => item.textContent), ['Keep me']);
  assert.equal(f.chat.activeConversation(), null);
  assert.equal(f.messages.querySelector('.empty')!.textContent, CLAUDE_CHAT_EMPTY_TEXT); assert.deepEqual(f.bubbles(), []);
  assert.deepEqual(f.tabs().map(tab => tab.textContent), ['New chat']);
});

test('delete is disabled while that conversation has a running turn and failures keep the row', async t => {
  const { b, failNext } = deletable(); const f = mount(b.bridge); t.after(() => f.chat.stop()); await f.chat.refresh();
  await f.chat.open('drop');
  b.reply(async () => ({ turnId: 'turn-1', conversationId: 'drop' }));
  f.type('Keep working'); key(f.input, 'Enter'); await tick();
  assert.equal(f.chat.running(), true);
  assert.equal(f.remove()!.disabled, true, 'the running conversation cannot be deleted');
  click(f.remove()!); click(f.remove()!); await tick();
  assert.deepEqual(removals(b), []);
  b.emit({ conversationId: 'drop', type: 'done', ok: true, error: null, usage: null }); await tick(); await tick();
  assert.equal(f.remove()!.disabled, false, 'enabled again once the turn finished');
  await f.chat.open('keep');
  failNext(); click(f.remove()!); click(f.remove()!); await tick(); await tick();
  assert.deepEqual(removals(b), [['remove', 'keep']]);
  assert.equal(f.notice.textContent, 'This conversation could not be deleted. Try again.');
  assert.doesNotMatch(f.notice.textContent, /private|EPERM/);
  assert.deepEqual(f.saved().map(item => item.textContent).sort(), ['Drop me', 'Keep me']);
  assert.equal(f.chat.activeConversation(), 'keep');
});

// Real production HTML/CSS and controllers in headless Edge: Codex and Claude render into the same chat surface.
// Synthetic Codex HTTP state and a fake Claude preload bridge only; no daemon, CLI, network or inference.
// ---- Cross-provider model list: one list with ChatGPT and Claude sections; picking the other provider switches. ----
const chatgpt = (available = true) => ({ provider: 'codex' as const, label: 'ChatGPT', available, hint: available ? 'Connect to choose a model' : 'Sign in to use',
  models: available ? [{ id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' }, { id: 'gpt-6.1-mini', label: 'GPT-6.1-Mini' }] : [] });
type Cross = import('../../apps/desktop/src/codex-chat.js').CrossProviderModels;
function linked(initial: 'codex' | 'claude', codexGroup = chatgpt(), bridge: unknown = fakeBridge().bridge) {
  const f = mount(bridge, memory(), false);
  const calls: unknown[][] = []; let source: Cross | null = null;
  let codexDraft = '', yielded = false;
  // Codex double: owns the shared composer while not yielded, exactly like CodexChat.yieldSurface.
  const codex = {
    yieldSurface(value: boolean) { if (value === yielded) return; calls.push(['yield', value]); if (value) codexDraft = f.input.value; else f.input.value = codexDraft; yielded = value; },
    setCrossProviderModels(value: Cross | null) { source = value; },
    crossProviderChanged() { calls.push(['changed']); },
    modelGroup: () => codexGroup,
    currentEffort: () => 'low',
    takeComposerDraft() { const value = f.input.value; f.input.value = ''; calls.push(['take', value]); return value; },
    receiveHandoff(handoff: { draft: string; model: string | null; effort: string | null }) { calls.push(['receive', handoff]); if (handoff.draft) f.input.value = handoff.draft; },
  };
  let surface: 'codex' | 'claude' = initial; const listeners = new Set<() => void>(); const requests: string[] = [];
  const provider = { chatSurface: () => surface, subscribeChatSurface: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    requestProvider: (next: 'codex' | 'claude') => { requests.push(next); return true; } };
  const setSurface = (next: 'codex' | 'claude') => { surface = next; for (const fn of [...listeners]) fn(); };
  const link = linkChatProviders({ codex, claude: f.chat, provider });
  const layout = () => f.el('codex-model-options').children.map(node => node.className === 'model-group-heading' ? '# ' + node.textContent : node.textContent + (node.disabled ? ' [disabled]' : ''));
  const row = (id: string) => f.el('codex-model-options').querySelectorAll('.picker-model-option').find(node => node.dataset.pickerModel === id)!;
  const press = (target: Element, value: string) => {
    const event = new Event('keydown', { cancelable: true });
    Object.defineProperties(event, { key: { value }, isComposing: { value: false }, target: { value: target } });
    f.el('codex-model-popover').dispatchEvent(event); return f.doc.activeElement?.textContent;
  };
  return { ...f, calls, requests, setSurface, link, layout, row, press, codexSource: () => source!, codexYielded: () => yielded };
}

test('Claude mode: the model list shows ChatGPT and Claude sections; search filters both; same-provider choice is unchanged', async t => {
  const f = linked('claude'); t.after(() => f.chat.stop());
  await tick(); await tick();
  assert.equal(f.chat.isActive(), true); assert.equal(f.codexYielded(), true);
  click(f.trigger); click(f.el('codex-picker-current-model'));
  assert.deepEqual(f.layout(), ['# ChatGPT', 'GPT-6.1-Sol', 'GPT-6.1-Mini', '# Claude', 'Claude Opus', 'Claude Sonnet', 'Claude Haiku 4.5']);
  assert.equal(f.row('gpt-6.1-sol').dataset.pickerProvider, 'codex'); assert.equal(f.row('opus').dataset.pickerProvider, undefined);
  const search = f.el('codex-model-search'); search.value = 'mini'; search.dispatchEvent(new Event('input'));
  assert.deepEqual(f.layout(), ['# ChatGPT', 'GPT-6.1-Mini'], 'search filters both sections and hides empty headings');
  search.value = ''; search.dispatchEvent(new Event('input'));
  click(f.row('opus')); assert.equal(f.el('codex-model-label').textContent, 'Claude Opus'); assert.deepEqual(f.requests, []);
  f.chat.setCrossProviderModels(null); click(f.el('codex-picker-current-model'));
  assert.deepEqual(f.layout(), ['Claude Opus', 'Claude Sonnet', 'Claude Haiku 4.5'], 'without a link the list is unchanged');
});

test('Claude mode: choosing a ChatGPT model requests Codex explicitly and carries the draft, model and effort', async t => {
  const f = linked('claude'); t.after(() => f.chat.stop());
  await tick(); await tick();
  f.type('ok, make the spawn point higher and');
  click(f.trigger); const slider = f.el('codex-picker-effort-slider'); slider.value = '2'; slider.dispatchEvent(new Event('input'));
  click(f.el('codex-picker-current-model')); click(f.row('gpt-6.1-mini'));
  assert.deepEqual(f.requests, ['codex']); assert.equal(f.el('codex-model-popover').hidden, true);
  assert.equal(f.chat.isActive(), true, 'nothing switches until provider setup reports the Codex surface');
  f.setSurface('codex');
  assert.equal(f.chat.isActive(), false); assert.equal(f.codexYielded(), false);
  assert.deepEqual(f.calls.find(call => call[0] === 'receive'), ['receive', { draft: 'ok, make the spawn point higher and', model: 'gpt-6.1-mini', effort: 'high' }]);
  assert.equal(f.input.value, 'ok, make the spawn point higher and', 'the draft follows the switch');
  f.input.value = '';
  f.setSurface('claude'); assert.equal(f.input.value, '', 'the Claude tab kept no copy of the moved draft');
  assert.equal(f.calls.filter(call => call[0] === 'take').length, 0, 'a switch the user did not pick from the list moves no draft');
});

test('Codex mode: choosing a Claude model switches surface, selects it with a supported effort and keeps the draft', async t => {
  const f = linked('codex'); t.after(() => f.chat.stop());
  assert.equal(f.chat.isActive(), false);
  const source = f.codexSource();
  assert.deepEqual([source.group()!.available, source.group()!.hint], [false, 'Sign in to use'], 'Claude status has not been read yet');
  source.opened!(); await tick(); await tick();
  assert.ok(f.calls.some(call => call[0] === 'changed'), 'an open Codex list redraws once Claude models arrive');
  assert.deepEqual(source.group()!.models.map(row => row.label), ['Claude Opus', 'Claude Sonnet', 'Claude Haiku 4.5']);
  f.input.value = 'ok, make the spawn point higher and';
  source.choose('opus');
  assert.deepEqual(f.requests, ['claude']); assert.equal(f.chat.isActive(), false);
  f.setSurface('claude'); await tick();
  assert.equal(f.chat.isActive(), true);
  assert.equal(f.input.value, 'ok, make the spawn point higher and');
  assert.equal(f.el('codex-model-label').textContent, 'Claude Opus');
  assert.equal(f.el('codex-effort-label').textContent, 'low', 'the Codex effort is kept because Claude reports it');
  assert.deepEqual(f.calls.filter(call => call[0] === 'take'), [['take', 'ok, make the spawn point higher and']]);
  const g = linked('codex'); t.after(() => g.chat.stop());
  await g.chat.loadModels(); g.chat.activate();
  g.chat.receiveHandoff({ draft: '', model: 'sonnet', effort: 'minimal' });
  assert.equal(g.el('codex-model-label').textContent, 'Claude Sonnet'); assert.equal(g.el('codex-effort-label').textContent, 'high', 'an unsupported effort uses Claude’s default');
});

test('a signed-out provider section is one disabled row and keyboard navigation crosses both sections', async t => {
  const f = linked('claude', chatgpt(false)); t.after(() => f.chat.stop());
  await tick(); await tick();
  click(f.trigger); click(f.el('codex-picker-current-model'));
  assert.deepEqual(f.layout(), ['# ChatGPT', 'ChatGPTSign in to use [disabled]', '# Claude', 'Claude Opus', 'Claude Sonnet', 'Claude Haiku 4.5']);
  assert.equal(f.press(f.el('codex-model-search'), 'ArrowDown'), 'Claude Opus', 'disabled rows are skipped');
  const g = linked('claude'); t.after(() => g.chat.stop());
  await tick(); await tick();
  click(g.trigger); click(g.el('codex-picker-current-model'));
  assert.equal(g.press(g.el('codex-model-search'), 'ArrowDown'), 'GPT-6.1-Sol');
  assert.equal(g.press(g.doc.activeElement!, 'ArrowDown'), 'GPT-6.1-Mini');
  assert.equal(g.press(g.doc.activeElement!, 'ArrowDown'), 'Claude Opus', 'ArrowDown moves from the ChatGPT section into Claude');
  assert.equal(g.press(g.doc.activeElement!, 'End'), 'Claude Haiku 4.5');
  assert.equal(g.press(g.doc.activeElement!, 'ArrowDown'), 'GPT-6.1-Sol', 'navigation wraps across sections');
  assert.equal(g.press(g.doc.activeElement!, 'ArrowUp'), 'Claude Haiku 4.5');
  g.press(g.el('codex-model-search'), 'Enter');
  assert.deepEqual(g.requests, [], 'search Enter prefers the active provider’s first match');
  assert.equal(g.el('codex-model-label').textContent, 'Claude Opus');
  click(g.el('codex-picker-current-model'));
  const search = g.el('codex-model-search'); search.value = 'sol'; search.dispatchEvent(new Event('input'));
  g.press(search, 'Enter');
  assert.deepEqual(g.requests, ['codex'], 'Enter on a search that only matches ChatGPT switches provider explicitly');
});

test('provider setup requestProvider is an explicit, persisted choice that still waits for a signed-in Claude status', async t => {
  const { startProviderSetup, PROVIDER_PRESENTATION_KEY, PROVIDER_PREFERENCE_EVENT } = await import('../../apps/desktop/src/provider-setup.js');
  const ids = ['provider-setup-panel', 'provider-login-gate', 'provider-setup-provider', 'provider-login-start', 'claude-chat-terminal'];
  const doc = new EventTarget() as EventTarget & { getElementById(id: string): unknown; defaultView: unknown };
  const nodes = new Map<string, Element>(ids.map(id => [id, new DocumentFixture().createElement('div')]));
  nodes.get('provider-setup-provider')!.value = 'codex';
  doc.getElementById = id => nodes.get(id) ?? null;
  const stored = new Map<string, string>();
  doc.defaultView = { CustomEvent, location: { protocol: 'http:', origin: 'http://fixture.test' },
    localStorage: { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => stored.set(k, v) } };
  let claudeAuth = 'signed-out'; const calls: string[] = [];
  const native = Object.freeze({ version: 1, ...Object.fromEntries(['status', 'login', 'install', 'launch'].map(action => [action, async (provider: string) => {
    calls.push(action + ':' + provider);
    return { version: 1, provider, installed: true, auth: provider === 'claude' ? claudeAuth : 'subscription', cliVersion: '2.1.177', busy: false, message: null };
  }])) });
  const controller = startProviderSetup(doc as unknown as Document, { nativeBridge: native, autoSelectSignedIn: true, chat: {
    providerConnectionStatus: () => ({ connected: true, ready: true, fresh: true, auth: 'subscription' }), subscribeProviderStateChange: () => () => {} } });
  t.after(() => controller.cleanup());
  const published: unknown[] = []; doc.addEventListener(PROVIDER_PREFERENCE_EVENT, event => published.push((event as CustomEvent).detail));
  await tick();
  assert.equal(controller.selectedProvider(), 'codex');
  assert.equal(controller.requestProvider('claude'), true);
  assert.equal(controller.selectedProvider(), 'claude');
  assert.deepEqual(JSON.parse(stored.get(PROVIDER_PRESENTATION_KEY)!), { version: 1, provider: 'claude' });
  assert.deepEqual(published, [{ provider: 'claude' }]);
  await tick(); await tick();
  assert.equal(controller.chatSurface(), 'codex', 'a signed-out Claude status does not open the Claude surface');
  assert.equal(controller.selectedProvider(), 'claude', 'an explicit choice ends startup auto-selection');
  claudeAuth = 'subscription'; assert.equal(controller.requestProvider('claude'), true); await tick(); await tick();
  assert.equal(controller.chatSurface(), 'claude', 'repeating the choice re-reads Claude status');
  assert.equal(controller.requestProvider('codex'), true); assert.equal(controller.chatSurface(), 'codex', 'switching back is immediate');
  controller.stop(); assert.equal(controller.requestProvider('claude'), false);
  assert.ok(calls.every(call => call.startsWith('status:')), 'only status is read; no login, install or launch');
});

const browserModule = process.env.ARCANE_UI_BROWSER_MODULE;
const CONNECTION = randomUUID();
function codexState(): ChatState {
  const thread = { threadId: 'fixture-thread', sessionId: 'fixture-session', selection: { model: 'gpt-6.1-sol', effort: 'low' }, configured: true, writeGranted: false, turnId: null, turnStatus: 'idle' };
  const result = {
    provider: 'codex', use: 'personal-local', projectPath: resolve('.'), connecting: false, closing: false, busy: false,
    actions: [], lastSnapshot: null, nativeTools: { configured: true, verified: false }, nativeAssets: { available: true, sealed: true, granted: false, admissionOpen: false },
    snapshot: {
      connectionId: CONNECTION, provenance: 'spawned-node-fixture', connected: true, ready: true,
      account: { auth: 'subscription', plan: 'fixture', requiresOpenaiAuth: true },
      models: [{ model: 'gpt-6.1-sol', id: 'opaque-sol', displayName: 'GPT-6.1-Sol', efforts: ['low', 'medium', 'high'], defaultEffort: 'low', entitlement: 'unverified' }],
      selection: { model: 'gpt-6.1-sol', effort: 'low' }, thread,
      operations: [], approvals: [], droppedEvents: 0, lastEventSeq: 1, failureCode: null,
      events: [{ seq: 1, type: 'delta', threadId: 'fixture-thread', turnId: 'turn-a', itemId: 'item-a', text: 'Here is the lobby plan.\n\n```lua\nlocal lobby = workspace.Lobby\n```' }],
    },
  } as unknown as ChatState;
  const proof = workflowNativeModel(result)?.proof; if (proof) result.workflowModel = proof;
  return result;
}
const FENCE = '`'.repeat(3);
test('Edge: Codex and Claude share one chat surface; only provider labels differ', { skip: !browserModule, timeout: 60000 }, async t => {
  const build = process.env.ARCANE_UI_BUILD_DIR ?? 'dist', shots = resolve(process.env.ARCANE_UI_SCREENSHOT ?? 'runtime/claude-codex-team/claude-audit/unify/shots');
  await mkdir(shots, { recursive: true });
  const modules = ['codex-chat', 'chat-tabs', 'codex-history', 'provider-setup', 'workspace-shell', 'claude-chat'];
  const reply = JSON.stringify('Here is the lobby plan.\n\n' + FENCE + 'lua\nlocal lobby = workspace.Lobby\n' + FENCE);
  const fixture = `import {CodexChat,CodexChatApi} from '/codex-chat.js';
    import {startProviderSetup} from '/provider-setup.js';
    import {startWorkspaceShell} from '/workspace-shell.js';
    import {ClaudeChat} from '/claude-chat.js';
    const f = window.fx = { calls: [] };
    const chat = new CodexChat(document, new CodexChatApi('${'a'.repeat(64)}'));
    const native = Object.freeze({ version: 1, ...Object.fromEntries(['status','login','install','launch'].map(action => [action, async provider =>
      ({ version: 1, provider, installed: true, auth: 'subscription', cliVersion: '2.1.177', busy: false, message: null })])) });
    const setup = startProviderSetup(document, { chat, nativeBridge: native });
    const conversations = [{ conversationId: 'conv-lobby', title: 'Lobby plan', updatedAt: '2026-10-01T00:00:00Z', model: 'opus', effort: 'high' }];
    const bridge = Object.freeze({ version: 1,
      status: async () => ({ installed: true, signedIn: true, cliVersion: '2.1.177', models: ['opus', 'sonnet', 'haiku'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultModel: 'sonnet', message: null }),
      list: async () => ({ conversations }),
      history: async id => ({ conversationId: id, messages: [
        { id: '1', role: 'user', text: 'Plan a lobby for my obby.', at: '' },
        { id: '2', role: 'assistant', text: ${reply}, at: '' }] }),
      send: async request => { f.calls.push(request); return { turnId: 'turn-1', conversationId: 'conv-lobby' }; },
      stop: async () => true, remove: async () => true, onEvent: listener => { f.emit = listener; return () => {}; } });
    const claude = new ClaudeChat(document, { bridge, storage: null });
    f.claude = claude;
    const sync = () => {
      if (setup.chatSurface() === 'claude') { chat.yieldSurface(true); claude.activate(); f.refreshed = claude.refresh(); }
      else { claude.deactivate(); chat.yieldSurface(false); }
    };
    setup.subscribeChatSurface(sync); sync();
    startWorkspaceShell(document);
    await chat.start(); f.ready = true;`;
  const server = createServer((request, response) => { void (async () => {
    const url = request.url?.split('?')[0] ?? '';
    if (url === '/v1/codex/state') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ state: codexState() })); return; }
    if (url === '/studio.js') { response.writeHead(200, { 'content-type': 'text/javascript' }); response.end(fixture); return; }
    const file = url === '/studio' ? 'apps/desktop/public/studio.html' : url === '/studio.css' ? 'apps/desktop/public/studio.css'
      : url.endsWith('.js') && modules.includes(url.slice(1, -3)) ? join(build, 'apps/desktop/src', url.slice(1)) : null;
    if (!file) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-type': url === '/studio' ? 'text/html' : url.endsWith('.css') ? 'text/css' : 'text/javascript' });
    response.end(await readFile(resolve(file)));
  })().catch(() => { response.writeHead(500); response.end(); }); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
  const { chromium } = await import(pathToFileURL(resolve(browserModule!)).href) as typeof import('playwright-core');
  const browser = await chromium.launch({ headless: true, args: ['--disable-gpu'], executablePath: process.env.ARCANE_UI_BROWSER_EXE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } }); page.setDefaultTimeout(8000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:' + (server.address() as { port: number }).port + '/studio');
  await page.waitForFunction(() => (window as any).fx?.ready === true);
  await page.waitForFunction(() => document.getElementById('provider-login-gate')?.hidden === true);
  await page.locator('#codex-messages .codex-message.codex').waitFor();
  await page.locator('#codex-composer').fill('Codex draft stays put');
  const trigger = () => page.locator('#codex-model-trigger').innerText();
  assert.match(await trigger(), /^GPT-6\.1-Sol\s*low$/);
  assert.equal(await page.locator('#codex-model-provider').count(), 0, 'No provider tag: the model name carries the provider');
  assert.equal(await page.locator('#codex-messages .codex-message.codex pre code').innerText(), 'local lobby = workspace.Lobby', 'Codex fenced code renders as a code block');
  await page.screenshot({ path: join(shots, 'codex-mode.png') });
  await page.locator('#codex-model-trigger').click(); await page.locator('#codex-picker-summary').waitFor();
  await page.screenshot({ path: join(shots, 'codex-picker.png') }); await page.keyboard.press('Escape');
  const layout = () => page.evaluate(() => Object.fromEntries(['codex-compose', 'codex-composer', 'codex-submit', 'workspace-new-chat'].map(id => {
    const box = document.getElementById(id)!.getBoundingClientRect(); return [id, [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)]];
  })));
  const codexLayout = await layout();
  // Choose Claude: the same surface now shows Claude tabs, transcript and picker.
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('workspace:providerpreference', { detail: { provider: 'claude' } })));
  await page.waitForFunction(() => !document.getElementById('claude-chat-tabs')!.hidden);
  await page.evaluate(() => (window as any).fx.refreshed);
  await page.evaluate(() => (window as any).fx.claude.open('conv-lobby'));
  await page.locator('#codex-messages .codex-message.human').waitFor();
  assert.equal(await page.locator('#codex-composer').inputValue(), '', 'the Codex draft is not shown in Claude');
  assert.equal(await page.locator('#workspace-chat-tabs').isVisible(), false);
  assert.deepEqual(await page.locator('#claude-chat-tabs [role=tab]').allInnerTexts(), ['Lobby plan']);
  assert.match(await trigger(), /^Claude Opus\s*high$/);
  assert.equal(await page.locator('#codex-messages .codex-message.codex pre code').innerText(), 'local lobby = workspace.Lobby');
  assert.equal(await page.locator('#codex-messages .codex-message.codex p').innerText(), 'Here is the lobby plan.');
  assert.deepEqual(await layout(), codexLayout, 'composer and New chat keep the exact Codex geometry');
  await page.screenshot({ path: join(shots, 'claude-mode.png') });
  await page.locator('#codex-model-trigger').click(); await page.locator('#codex-picker-summary').waitFor();
  assert.equal(await page.locator('#codex-picker-current-model-label').innerText(), 'Claude Opus');
  assert.equal(await page.locator('#codex-picker-effort-value').innerText(), 'High');
  await page.screenshot({ path: join(shots, 'claude-picker.png') });
  await page.locator('#codex-picker-current-model').click(); await page.locator('#codex-model-options').waitFor();
  assert.deepEqual(await page.locator('#codex-model-options .picker-model-option').allInnerTexts(), ['Claude Opus', 'Claude Sonnet', 'Claude Haiku']);
  await page.screenshot({ path: join(shots, 'claude-models.png') });
  await page.locator('#codex-model-options [data-picker-model="sonnet"]').click();
  assert.match(await trigger(), /^Claude Sonnet\s*high$/); await page.keyboard.press('Escape');
  await page.locator('#codex-composer').fill('Add a spawn pad'); await page.locator('#codex-composer').press('Enter');
  await page.waitForFunction(() => (window as any).fx.calls.length === 1);
  assert.deepEqual(await page.evaluate(() => (window as any).fx.calls[0]), { conversationId: 'conv-lobby', text: 'Add a spawn pad', model: 'sonnet', effort: 'high' });
  await page.evaluate(() => (window as any).fx.emit({ turnId: 'turn-1', conversationId: 'conv-lobby', type: 'done', ok: true, error: null, usage: null }));
  // Back to Codex: its transcript, picker and draft return untouched.
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('workspace:providerpreference', { detail: { provider: 'codex' } })));
  await page.waitForFunction(() => document.getElementById('claude-chat-tabs')!.hidden);
  assert.equal(await page.locator('#codex-composer').inputValue(), 'Codex draft stays put');
  assert.equal(await page.locator('#codex-messages .codex-message.human').count(), 0);
  assert.match(await trigger(), /^GPT-6\.1-Sol\s*low$/, 'Codex model name replaces the Claude label');
  assert.deepEqual(errors, []);
});

test('Edge: one model list switches between ChatGPT and Claude in one click and the draft follows', { skip: !browserModule, timeout: 60000 }, async t => {
  const build = process.env.ARCANE_UI_BUILD_DIR ?? 'dist', shots = resolve(process.env.ARCANE_UI_SCREENSHOT ?? 'runtime/claude-codex-team/claude-audit/xprovider/shots');
  await mkdir(shots, { recursive: true });
  const modules = ['codex-chat', 'chat-tabs', 'codex-history', 'provider-setup', 'workspace-shell', 'claude-chat'];
  const fixture = `import {CodexChat,CodexChatApi} from '/codex-chat.js';
    import {startProviderSetup} from '/provider-setup.js';
    import {startWorkspaceShell} from '/workspace-shell.js';
    import {ClaudeChat, linkChatProviders} from '/claude-chat.js';
    const f = window.fx = { calls: [], status: 0 };
    const chat = new CodexChat(document, new CodexChatApi('${'a'.repeat(64)}'));
    const native = Object.freeze({ version: 1, ...Object.fromEntries(['status','login','install','launch'].map(action => [action, async provider =>
      ({ version: 1, provider, installed: true, auth: 'subscription', cliVersion: '2.1.177', busy: false, message: null })])) });
    const setup = startProviderSetup(document, { chat, nativeBridge: native });
    const bridge = Object.freeze({ version: 1,
      status: async () => { f.status++; return { installed: true, signedIn: true, cliVersion: '2.1.177', models: ['opus', 'sonnet', 'haiku'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultModel: 'sonnet', message: null }; },
      list: async () => ({ conversations: [] }), history: async id => ({ conversationId: id, messages: [] }),
      send: async request => { f.calls.push(request); return { turnId: 'turn-1', conversationId: 'conv-1' }; },
      stop: async () => true, remove: async () => true, onEvent: () => () => {} });
    const claude = new ClaudeChat(document, { bridge, storage: null });
    f.claude = claude;
    linkChatProviders({ codex: chat, claude, provider: setup });
    startWorkspaceShell(document);
    await chat.start(); f.ready = true;`;
  const state = () => { const value = codexState() as unknown as { snapshot: { models: unknown[] } };
    value.snapshot.models.push({ model: 'gpt-6.1-mini', id: 'opaque-mini', displayName: 'GPT-6.1-Mini', efforts: ['low', 'medium'], defaultEffort: 'medium', entitlement: 'unverified' });
    return value; };
  const server = createServer((request, response) => { void (async () => {
    const url = request.url?.split('?')[0] ?? '';
    if (url === '/v1/codex/state') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ state: state() })); return; }
    if (url === '/studio.js') { response.writeHead(200, { 'content-type': 'text/javascript' }); response.end(fixture); return; }
    const file = url === '/studio' ? 'apps/desktop/public/studio.html' : url === '/studio.css' ? 'apps/desktop/public/studio.css'
      : url.endsWith('.js') && modules.includes(url.slice(1, -3)) ? join(build, 'apps/desktop/src', url.slice(1)) : null;
    if (!file) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-type': url === '/studio' ? 'text/html' : url.endsWith('.css') ? 'text/css' : 'text/javascript' });
    response.end(await readFile(resolve(file)));
  })().catch(() => { response.writeHead(500); response.end(); }); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
  const { chromium } = await import(pathToFileURL(resolve(browserModule!)).href) as typeof import('playwright-core');
  const browser = await chromium.launch({ headless: true, args: ['--disable-gpu'], executablePath: process.env.ARCANE_UI_BROWSER_EXE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } }); page.setDefaultTimeout(8000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:' + (server.address() as { port: number }).port + '/studio');
  await page.waitForFunction(() => (window as any).fx?.ready === true);
  await page.waitForFunction(() => document.getElementById('provider-login-gate')?.hidden === true);
  const draft = 'ok, make the spawn point higher and';
  await page.locator('#codex-composer').fill(draft);
  const trigger = () => page.locator('#codex-model-trigger').innerText();
  const layout = () => page.locator('#codex-model-options').evaluate(host => Array.from(host.children).map(node =>
    node.classList.contains('model-group-heading') ? '# ' + node.textContent : (node as HTMLButtonElement).innerText.replace(/\s+/g, ' ').trim() + ((node as HTMLButtonElement).disabled ? ' [disabled]' : '')));
  assert.match(await trigger(), /^GPT-6\.1-Sol\s*low$/);
  // Codex mode: open the list; Claude models load lazily under their own heading.
  await page.locator('#codex-model-trigger').click(); await page.locator('#codex-picker-current-model').click();
  await page.waitForFunction(() => !!document.querySelector('#codex-model-options [data-picker-model="opus"]'));
  assert.deepEqual(await layout(), ['# ChatGPT', 'GPT-6.1-Sol', 'GPT-6.1-Mini', '# Claude', 'Claude Opus', 'Claude Sonnet', 'Claude Haiku']);
  // Keyboard: from search, ArrowDown walks from the ChatGPT section into Claude.
  await page.locator('#codex-model-search').focus(); await page.keyboard.press('ArrowDown');
  const focused = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.pickerModel ?? null);
  assert.equal(await focused(), 'gpt-6.1-sol');
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); assert.equal(await focused(), 'opus');
  await page.keyboard.press('ArrowUp'); assert.equal(await focused(), 'gpt-6.1-mini');
  await page.keyboard.press('ArrowDown');
  await page.screenshot({ path: join(shots, 'codex-mode-both-groups.png') });
  // One click on a Claude model: provider switches, Claude Opus is selected with the Codex effort, the draft stays.
  await page.locator('#codex-model-options [data-picker-model="opus"]').click();
  await page.waitForFunction(() => !document.getElementById('claude-chat-tabs')!.hidden);
  await page.waitForFunction(() => /Claude Opus/.test(document.getElementById('codex-model-trigger')!.innerText));
  assert.equal(await page.locator('#codex-composer').inputValue(), draft, 'the typed draft carried across the switch');
  assert.match(await trigger(), /^Claude Opus\s*low$/);
  assert.equal(await page.locator('#provider-setup-provider').inputValue(), 'claude', 'the switch is the persisted provider choice');
  assert.deepEqual(await page.evaluate(() => (window as any).fx.calls), [], 'switching never sends');
  await page.screenshot({ path: join(shots, 'after-switch-to-claude.png') });
  // Claude mode: the list again shows both providers; the effort slider follows Claude's five levels.
  await page.locator('#codex-model-trigger').click(); await page.locator('#codex-picker-summary').waitFor();
  assert.equal(await page.locator('#codex-picker-effort-slider').getAttribute('max'), '4');
  await page.locator('#codex-picker-current-model').click(); await page.locator('#codex-model-options [data-picker-model="gpt-6.1-sol"]').waitFor();
  assert.deepEqual(await layout(), ['# ChatGPT', 'GPT-6.1-Sol', 'GPT-6.1-Mini', '# Claude', 'Claude Opus', 'Claude Sonnet', 'Claude Haiku']);
  await page.screenshot({ path: join(shots, 'claude-mode-both-groups.png') });
  // Back to ChatGPT in one click: the draft follows again and the Codex catalogue applies the carried effort.
  await page.locator('#codex-model-options [data-picker-model="gpt-6.1-sol"]').click();
  await page.waitForFunction(() => document.getElementById('claude-chat-tabs')!.hidden);
  assert.equal(await page.locator('#codex-composer').inputValue(), draft);
  assert.match(await trigger(), /^GPT-6\.1-Sol\s*low$/);
  assert.equal(await page.locator('#provider-setup-provider').inputValue(), 'codex');
  await page.screenshot({ path: join(shots, 'after-switch-back-to-chatgpt.png') });
  assert.deepEqual(errors, []);
});
