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
  claudeEffortLabel, claudeModelLabel, claudeModelName, linkChatProviders, readClaudeChatStatus, readClaudeChatBridge,
  CLAUDE_CHAT_QUEUE_RETURNED_TEXT, CLAUDE_CHAT_USAGE_KEY, compactTokens, usageMeterText,
} from '../../apps/desktop/src/claude-chat.js';
import { changeSummary, CodexTranscript, describeToolActivity, readToolResultText, renderChangeCard, restoreRequestText,
  CHOICE_BLOCK_LIMITS, parseChoiceBlock, PLAN_APPROVE_TEXT, PLAN_CHANGE_TEXT, renderMessageText } from '../../apps/desktop/src/codex-chat.js';
import { CLAUDE_CHAT_EDIT_UNDO_TEXT, CLAUDE_CHAT_IMAGES_TEXT, CLAUDE_CHAT_QUEUE_ATTACHMENTS_TEXT, claudeImageMarkers } from '../../apps/desktop/src/claude-chat.js';
import { claimChatAttachments, sharedChatAttachments, startChatAttachments } from '../../apps/desktop/src/chat-attachments.js';
import type { ChatAttachmentsOwner } from '../../apps/desktop/src/chat-attachments.js';

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
    make('button', 'welcome-connect'), make('button', 'codex-conversation-start'),
    make('div', 'usage-limit-notice', 'notice usage-limit-notice', make('p', 'usage-limit-message'), make('button', 'usage-limit-action')), form, popover);
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
const signedIn = { installed: true, signedIn: true, cliVersion: '2.1.177', models: ['opus', 'sonnet', 'claude-haiku-4-5-20251001'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultModel: 'sonnet', message: null,
  resolved: { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5' } };
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
  assert.deepEqual(claudeModelName('claude-fable-5-1'), { short: 'Fable 5.1', full: 'Claude Fable 5.1' });
  assert.equal(claudeModelName('claude-opus-5-5').short, 'Opus 5.5'); assert.equal(claudeModelName('fable').short, 'Fable', 'a bare alias claims no version');
  // Aliases show the version of the concrete model the engine resolved; unresolved aliases never guess one.
  const resolved = { fable: 'claude-fable-5-1', opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' };
  assert.deepEqual(['fable', 'opus', 'sonnet', 'haiku'].map(alias => claudeModelLabel(alias, resolved).short), ['Fable 5.1', 'Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5']);
  assert.deepEqual(claudeModelLabel('opus', resolved), { short: 'Opus 5.5', full: 'Claude Opus 5.5', id: 'claude-opus-5-5' });
  assert.equal(claudeModelLabel('opus').short, 'Opus'); assert.equal(claudeModelLabel('opus', { opus: 'gpt-5' }).short, 'Opus', 'only Claude model ids resolve');
  assert.equal(claudeModelLabel('claude-haiku-4-5-20251001', resolved).short, 'Haiku 4.5', 'explicit versioned ids name themselves');
  const status = readClaudeChatStatus({ ...signedIn, resolved: { opus: 'claude-opus-5-5', mystery: 'claude-x-1', sonnet: 'Sonnet!' } });
  assert.deepEqual({ ...status.resolved }, { opus: 'claude-opus-5-5' }, 'only reported aliases with concrete ids are kept');
  assert.deepEqual({ ...readClaudeChatStatus({ ...signedIn, resolved: undefined }).resolved }, {}, 'older engines resolve nothing');
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
  assert.equal(f.el('codex-model-label').textContent, 'Opus 5.5', 'the composer shows the resolved model and version'); assert.equal(f.el('codex-effort-label').textContent, 'max');
  assert.equal(f.el('codex-effort-label').hidden, false);
  assert.equal(f.trigger.getAttribute('aria-label'), 'Claude model: Opus 5.5 (opus, claude-opus-5-5), reasoning: Max');
  assert.equal(f.trigger.disabled, false); assert.equal(f.input.disabled, false);
  assert.equal(f.submit.disabled, true, 'empty draft cannot be sent');
  f.type('  '); assert.equal(f.submit.disabled, true); f.type('Build a lobby'); assert.equal(f.submit.disabled, false);
  click(f.trigger);
  assert.equal(f.el('codex-model-popover').hidden, false); assert.equal(f.trigger.getAttribute('aria-expanded'), 'true');
  assert.equal(f.el('codex-picker-effort-value').textContent, 'Max');
  assert.equal(f.el('codex-picker-current-model-label').textContent, 'Opus 5.5');
  const slider = f.el('codex-picker-effort-slider');
  assert.equal(slider.max, '4'); assert.equal(slider.value, '4'); assert.equal(slider.dataset.effortTone, 'ultra');
  slider.value = '1'; slider.dispatchEvent(new Event('input'));
  assert.equal(f.el('codex-effort-label').textContent, 'medium'); assert.equal(f.el('codex-picker-effort-value').textContent, 'Medium');
  assert.deepEqual(JSON.parse(storage.data.get(CLAUDE_CHAT_CHOICE_KEY)!), { model: 'opus', effort: 'medium' });
  click(f.el('codex-picker-reset')); assert.equal(f.el('codex-effort-label').textContent, 'high');
  click(f.el('codex-picker-current-model'));
  assert.equal(f.el('codex-picker-model-list').hidden, false); assert.equal(f.el('codex-picker-summary').hidden, true);
  const options = () => f.el('codex-model-options').querySelectorAll('.picker-model-option');
  assert.deepEqual(options().map(row => row.textContent), ['Opus 5.5', 'Sonnet 5.5', 'Haiku 4.5']);
  assert.deepEqual(options().map(row => row.getAttribute('aria-selected')), ['true', 'false', 'false']);
  assert.equal(options()[1]!.title, 'sonnet → claude-sonnet-5-5 · Claude Code default');
  assert.equal(f.el('codex-model-options').dataset.layout, undefined, 'without the other provider the list stays one plain list');
  const search = f.el('codex-model-search'); search.value = 'hai'; search.dispatchEvent(new Event('input'));
  assert.deepEqual(options().map(row => row.textContent), ['Haiku 4.5']);
  click(options()[0]!);
  assert.equal(f.el('codex-model-label').textContent, 'Haiku 4.5'); assert.equal(f.el('codex-picker-summary').hidden, false);
  assert.deepEqual(JSON.parse(storage.data.get(CLAUDE_CHAT_CHOICE_KEY)!), { model: 'claude-haiku-4-5-20251001', effort: 'high' });
  key(f.el('codex-picker-current-model'), 'Escape'); // keydown bubbles from inside the popover
  f.el('codex-model-popover').dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' }));
  assert.equal(f.el('codex-model-popover').hidden, true); assert.equal(f.trigger.getAttribute('aria-expanded'), 'false');
  key(f.input, 'Enter'); await tick();
  assert.deepEqual(sends(b), [{ conversationId: null, text: 'Build a lobby', model: 'claude-haiku-4-5-20251001', effort: 'high' }]);
  const denied = { getItem: () => { throw Error('denied'); }, setItem: () => { throw Error('denied'); } };
  const g = mount(fakeBridge().bridge, denied); t.after(() => g.chat.stop());
  await g.chat.refresh();
  assert.equal(g.el('codex-model-label').textContent, 'Sonnet 5.5', 'falls back to the reported default'); assert.equal(g.el('codex-effort-label').textContent, 'high');
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
  assert.equal(tool.className, 'codex-message tool'); assert.equal(tool.querySelector('.message-text')!.textContent, 'Using Edit…'); assert.equal(tool.dataset.toolState, 'started');
  b.emit({ type: 'tool', message: { id: 't1', role: 'tool', text: 'Edit', at: '', tool: { name: 'Edit', status: 'finished' } } });
  const finished = f.messages.querySelectorAll('.codex-message').at(-1)!;
  assert.equal(f.messages.querySelectorAll('.tool').length, 1); assert.equal(finished.querySelector('.message-text')!.textContent, 'Using Edit'); assert.equal(finished.dataset.toolState, 'finished');
  f.messages.scrollTop = 0; f.messages.scrollHeight = 5000; // user scrolled up: no forced scroll
  b.emit({ type: 'delta', text: 'Done.' });
  assert.equal(f.messages.scrollTop, 0);
  b.emit({ type: 'done', ok: true, error: null, usage: { inputTokens: 12, outputTokens: 34, costUsd: 0.0123 } });
  await tick();
  assert.deepEqual(f.bubbles().map(row => row.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(f.notice.textContent, 'Done · 46 tokens (~$0.01)');
  const line = f.messages.querySelector('.reply-usage')!;
  assert.equal(line.textContent, '46 tokens (~$0.01)', 'the finished reply shows a subtle tokens and cost line');
  assert.match(line.title, /46 tokens \(12 input including cache, 34 output\)\. ~\$0\.01 is Claude Code's own cost estimate/);
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
  assert.equal(f.saved()[0]!.title, 'Claude Opus 5.5 · max · 2026-05-01T00:00:00Z');
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
  assert.equal(f.el('codex-model-label').textContent, 'Opus 5.5'); assert.equal(f.el('codex-effort-label').textContent, 'max', 'conversation choice is applied');
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
  assert.ok(f.messages.textContent.includes('Using <b onmouseover=x>…'), 'a hostile tool name stays text in its activity line');
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
  let codexLimit: { resetsAt: number | null } | null = null; const codexListeners = new Set<() => void>();
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
    usageLimit: () => codexLimit,
    subscribeStateChange(fn: () => void) { codexListeners.add(fn); return () => { codexListeners.delete(fn); }; },
  };
  let surface: 'codex' | 'claude' = initial; const listeners = new Set<() => void>(); const requests: string[] = [];
  const provider = { chatSurface: () => surface, subscribeChatSurface: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    requestProvider: (next: 'codex' | 'claude') => { requests.push(next); return true; } };
  const setSurface = (next: 'codex' | 'claude') => { surface = next; for (const fn of [...listeners]) fn(); };
  const link = linkChatProviders({ codex, claude: f.chat, provider });
  const item = (node: Element): string => node.className === 'model-group-heading' ? '# ' + node.textContent : node.className.includes('model-column-empty') ? '(' + node.textContent + ')' : node.textContent + (node.disabled ? ' [disabled]' : '');
  // Columns flatten left to right: '# Provider' heading, then that column's rows.
  const layout = () => f.el('codex-model-options').children.flatMap(node => node.className === 'model-column' ? node.children.map(item) : [item(node)]);
  const columns = () => f.el('codex-model-options').children.filter(node => node.className === 'model-column').map(node => node.dataset.pickerGroup);
  const row = (id: string) => f.el('codex-model-options').querySelectorAll('.picker-model-option').find(node => node.dataset.pickerModel === id)!;
  const press = (target: Element, value: string) => {
    const event = new Event('keydown', { cancelable: true });
    Object.defineProperties(event, { key: { value }, isComposing: { value: false }, target: { value: target } });
    f.el('codex-model-popover').dispatchEvent(event); return f.doc.activeElement?.textContent;
  };
  const setCodexLimit = (value: { resetsAt: number | null } | null) => { codexLimit = value; for (const fn of [...codexListeners]) fn(); };
  const usage = { root: f.el('usage-limit-notice'), message: f.el('usage-limit-message'), action: f.el('usage-limit-action') };
  return { ...f, calls, requests, setSurface, link, layout, columns, row, press, codexSource: () => source!, codexYielded: () => yielded, setCodexLimit, usage };
}

test('Claude mode: ChatGPT and Claude columns side by side with logo headings; search filters both; same-provider choice is unchanged', async t => {
  const f = linked('claude'); t.after(() => f.chat.stop());
  await tick(); await tick();
  assert.equal(f.chat.isActive(), true); assert.equal(f.codexYielded(), true);
  click(f.trigger); click(f.el('codex-picker-current-model'));
  assert.equal(f.el('codex-model-options').dataset.layout, 'columns');
  assert.deepEqual(f.columns(), ['codex', 'claude'], 'ChatGPT is the left column and Claude the right, whichever provider is active');
  assert.deepEqual(f.layout(), ['# ChatGPT', 'GPT-6.1-Sol', 'GPT-6.1-Mini', '# Claude', 'Opus 5.5', 'Sonnet 5.5', 'Haiku 4.5']);
  for (const column of f.el('codex-model-options').children) {
    const heading = column.children[0]!, logo = heading.children[0]!;
    assert.equal(column.getAttribute('role'), 'group'); assert.equal(column.getAttribute('aria-label'), heading.textContent + ' models');
    assert.equal(logo.tagName, 'SVG'); assert.equal(logo.getAttribute('data-provider'), column.dataset.pickerGroup);
    assert.equal(logo.getAttribute('aria-hidden'), 'true', 'the mark is decorative beside the provider name');
    assert.match(logo.children[0]!.getAttribute('d')!, /^M[0-9.]+ [0-9.]+/);
  }
  assert.equal(f.row('gpt-6.1-sol').dataset.pickerProvider, 'codex'); assert.equal(f.row('opus').dataset.pickerProvider, undefined);
  assert.equal(f.row('opus').getAttribute('aria-selected'), 'false'); assert.equal(f.row('sonnet').getAttribute('aria-selected'), 'true');
  assert.equal(f.row('sonnet').querySelector('svg')!.getAttribute('data-selected'), 'true', 'the current choice carries the check mark');
  const search = f.el('codex-model-search'); search.value = 'mini'; search.dispatchEvent(new Event('input'));
  assert.deepEqual(f.layout(), ['# ChatGPT', 'GPT-6.1-Mini', '# Claude', '(No matching models)'], 'search filters both columns; both keep their place');
  search.value = '5.5'; search.dispatchEvent(new Event('input'));
  assert.deepEqual(f.layout(), ['# ChatGPT', '(No matching models)', '# Claude', 'Opus 5.5', 'Sonnet 5.5'], 'versions are searchable');
  search.value = ''; search.dispatchEvent(new Event('input'));
  click(f.row('opus')); assert.equal(f.el('codex-model-label').textContent, 'Opus 5.5'); assert.deepEqual(f.requests, []);
  f.chat.setCrossProviderModels(null); click(f.el('codex-picker-current-model'));
  assert.deepEqual(f.layout(), ['Opus 5.5', 'Sonnet 5.5', 'Haiku 4.5'], 'without a link the list is one plain list');
  assert.equal(f.el('codex-model-options').dataset.layout, undefined);
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
  assert.deepEqual(source.group()!.models.map(row => [row.label, row.title]), [['Opus 5.5', 'opus → claude-opus-5-5'], ['Sonnet 5.5', 'sonnet → claude-sonnet-5-5'], ['Haiku 4.5', 'claude-haiku-4-5-20251001']]);
  f.input.value = 'ok, make the spawn point higher and';
  source.choose('opus');
  assert.deepEqual(f.requests, ['claude']); assert.equal(f.chat.isActive(), false);
  f.setSurface('claude'); await tick();
  assert.equal(f.chat.isActive(), true);
  assert.equal(f.input.value, 'ok, make the spawn point higher and');
  assert.equal(f.el('codex-model-label').textContent, 'Opus 5.5');
  assert.equal(f.el('codex-effort-label').textContent, 'low', 'the Codex effort is kept because Claude reports it');
  assert.deepEqual(f.calls.filter(call => call[0] === 'take'), [['take', 'ok, make the spawn point higher and']]);
  const g = linked('codex'); t.after(() => g.chat.stop());
  await g.chat.loadModels(); g.chat.activate();
  g.chat.receiveHandoff({ draft: '', model: 'sonnet', effort: 'minimal' });
  assert.equal(g.el('codex-model-label').textContent, 'Sonnet 5.5'); assert.equal(g.el('codex-effort-label').textContent, 'high', 'an unsupported effort uses Claude’s default');
});

test('a signed-out provider column is one disabled row; arrows stay in a column and Left/Right cross columns', async t => {
  const f = linked('claude', chatgpt(false)); t.after(() => f.chat.stop());
  await tick(); await tick();
  click(f.trigger); click(f.el('codex-picker-current-model'));
  assert.deepEqual(f.layout(), ['# ChatGPT', 'Sign in to use [disabled]', '# Claude', 'Opus 5.5', 'Sonnet 5.5', 'Haiku 4.5']);
  assert.equal(f.press(f.el('codex-model-search'), 'ArrowDown'), 'Opus 5.5', 'search enters the active provider column');
  assert.equal(f.press(f.doc.activeElement!, 'ArrowLeft'), 'Opus 5.5', 'a signed-out column has no row to move to');
  const g = linked('claude'); t.after(() => g.chat.stop());
  await tick(); await tick();
  click(g.trigger); click(g.el('codex-picker-current-model'));
  assert.equal(g.press(g.el('codex-model-search'), 'ArrowDown'), 'Opus 5.5', 'search enters the active (Claude) column first');
  assert.equal(g.press(g.doc.activeElement!, 'ArrowDown'), 'Sonnet 5.5');
  assert.equal(g.press(g.doc.activeElement!, 'ArrowLeft'), 'GPT-6.1-Mini', 'Left moves to the ChatGPT column at the same position');
  assert.equal(g.press(g.doc.activeElement!, 'ArrowDown'), 'GPT-6.1-Sol', 'Down wraps within the column');
  assert.equal(g.press(g.doc.activeElement!, 'ArrowLeft'), 'GPT-6.1-Sol', 'nothing is left of ChatGPT');
  assert.equal(g.press(g.doc.activeElement!, 'ArrowRight'), 'Opus 5.5', 'Right moves back to Claude');
  assert.equal(g.press(g.doc.activeElement!, 'End'), 'Haiku 4.5');
  assert.equal(g.press(g.doc.activeElement!, 'ArrowLeft'), 'GPT-6.1-Mini', 'a shorter column clamps to its last row');
  assert.equal(g.press(g.doc.activeElement!, 'Home'), 'GPT-6.1-Sol');
  assert.equal(g.press(g.doc.activeElement!, 'ArrowUp'), 'GPT-6.1-Mini', 'Up wraps within the column');
  g.press(g.el('codex-model-search'), 'Enter');
  assert.deepEqual(g.requests, [], 'search Enter prefers the active provider’s first match');
  assert.equal(g.el('codex-model-label').textContent, 'Opus 5.5');
  click(g.el('codex-picker-current-model'));
  const search = g.el('codex-model-search'); search.value = 'sol'; search.dispatchEvent(new Event('input'));
  g.press(search, 'Enter');
  assert.deepEqual(g.requests, ['codex'], 'Enter on a search that only matches ChatGPT switches provider explicitly');
});

test('Claude chat tabs lead with the Claude mark; the tab text still names the chat', async t => {
  const b = fakeBridge(); const f = mount(b.bridge); t.after(() => f.chat.stop()); await f.chat.refresh();
  const tab = f.tabs()[0]!, logo = tab.children[0]!;
  assert.equal(tab.textContent, 'New chat'); assert.equal(tab.dataset.provider, 'claude');
  assert.equal(logo.tagName, 'SVG'); assert.equal(logo.getAttribute('data-provider'), 'claude'); assert.equal(logo.getAttribute('aria-hidden'), 'true');
  assert.equal(innerHtmlWrites, 0);
});

// ---- Usage-limit notice: an exhausted provider offers the other one in one click; the draft moves, nothing is resent. ----
const RESET = Math.floor(Date.now() / 1000) + 3 * 3600;
test('ChatGPT out of usage: the notice offers Switch to Claude, keeps the draft and selects Claude without sending', async t => {
  const b = fakeBridge(), f = linked('codex', chatgpt(), b.bridge); t.after(() => f.chat.stop());
  assert.equal(f.usage.root.hidden, true, 'hidden while ChatGPT is not exhausted');
  f.input.value = 'ok, make the spawn point higher and';
  f.setCodexLimit({ resetsAt: RESET });
  assert.equal(f.usage.root.hidden, false);
  assert.match(f.usage.message.textContent, /^ChatGPT usage limit reached \u2014 resets at .+\./);
  await tick(); await tick();
  assert.deepEqual(b.calls.filter(call => call[0] === 'status').length, 1, 'Claude sign-in is read once for the notice');
  assert.deepEqual([f.usage.action.textContent, f.usage.action.hidden, f.usage.action.disabled], ['Switch to Claude', false, false]);
  assert.match(f.usage.message.textContent, /Your draft moves with you\.$/);
  click(f.usage.action);
  assert.deepEqual(f.requests, ['claude']); assert.equal(f.chat.isActive(), false, 'nothing switches until provider setup reports Claude');
  f.setSurface('claude'); await tick();
  assert.equal(f.chat.isActive(), true);
  assert.equal(f.input.value, 'ok, make the spawn point higher and', 'the draft follows the switch');
  assert.deepEqual(f.calls.filter(call => call[0] === 'take'), [['take', 'ok, make the spawn point higher and']]);
  assert.equal(f.usage.root.hidden, true, 'the notice is hidden after switching');
  assert.deepEqual(sends(b), [], 'switching never sends or retries');
  f.setSurface('codex'); assert.equal(f.usage.root.hidden, false, 'back on the exhausted provider the notice returns');
  f.setCodexLimit(null); assert.equal(f.usage.root.hidden, true, 'hidden once ChatGPT is no longer exhausted');
  f.setCodexLimit({ resetsAt: null }); assert.match(f.usage.message.textContent, /^ChatGPT usage limit reached\. /);
});

test('ChatGPT out of usage with Claude signed out: the notice offers sign-in and keeps the draft in place', async t => {
  const b = fakeBridge({ status: async () => ({ ...signedIn, signedIn: false, message: 'Claude Code is not signed in.' }) });
  const f = linked('codex', chatgpt(), b.bridge); t.after(() => f.chat.stop());
  f.input.value = 'keep me';
  f.setCodexLimit({ resetsAt: null }); await tick(); await tick();
  assert.deepEqual([f.usage.action.textContent, f.usage.action.hidden], ['Sign in to Claude', false]);
  assert.match(f.usage.message.textContent, /Your draft stays here\.$/);
  click(f.usage.action);
  assert.deepEqual(f.requests, ['claude'], 'an explicit Claude choice that waits for sign-in');
  assert.equal(f.chat.isActive(), false); assert.equal(f.input.value, 'keep me');
  const none = linked('codex', chatgpt(), null); t.after(() => none.chat.stop());
  none.setCodexLimit({ resetsAt: null });
  assert.deepEqual([none.usage.root.hidden, none.usage.action.hidden], [false, true], 'without the desktop bridge only the notice shows');
});

test('Claude usage limit: the done event shows the mapped notice, restores the unanswered message and offers ChatGPT', async t => {
  const b = fakeBridge(), f = linked('claude', chatgpt(), b.bridge); t.after(() => f.chat.stop());
  await tick(); await tick();
  f.type('Add a spawn pad'); key(f.input, 'Enter'); await tick(); await tick();
  assert.equal(sends(b).length, 1); assert.equal(f.input.value, '');
  b.emit({ type: 'done', ok: false, error: 'Claude usage limit reached. This message was not answered; try again after the limit resets.', usage: null, usageLimit: { resetsAt: RESET } });
  assert.equal(f.usage.root.hidden, false);
  assert.match(f.usage.message.textContent, /^Claude usage limit reached \u2014 resets at .+\. Your draft moves with you\.$/);
  assert.equal(f.input.value, 'Add a spawn pad', 'the unanswered message is back in the composer, not resent');
  assert.equal(f.bubbles().at(-1)!.role, 'error');
  assert.deepEqual([f.usage.action.textContent, f.usage.action.hidden], ['Switch to ChatGPT', false]);
  f.setCodexLimit({ resetsAt: null });
  assert.deepEqual([f.usage.action.hidden, /ChatGPT is also at its usage limit\.$/.test(f.usage.message.textContent)], [true, true], 'no switch to an exhausted ChatGPT');
  f.setCodexLimit(null);
  click(f.usage.action);
  assert.deepEqual(f.requests, ['codex']);
  f.setSurface('codex');
  assert.deepEqual(f.calls.find(call => call[0] === 'receive'), ['receive', { draft: 'Add a spawn pad', model: null, effort: 'high' }]);
  assert.equal(f.usage.root.hidden, true, 'hidden after switching');
  assert.equal(sends(b).length, 1, 'no automatic resend');
  // Back on Claude, a completed reply clears the limit.
  f.setSurface('claude'); await tick();
  assert.equal(f.usage.root.hidden, false);
  f.type('again'); key(f.input, 'Enter'); await tick(); await tick();
  b.emit({ type: 'done', ok: true, error: null, usage: null });
  assert.equal(f.usage.root.hidden, true);
  // The fixed message alone (older engine event) still maps; any other error does not.
  f.type('third'); key(f.input, 'Enter'); await tick(); await tick();
  b.emit({ type: 'done', ok: false, error: 'Claude Code could not finish this reply.', usage: null });
  assert.equal(f.usage.root.hidden, true);
  f.type('fourth'); key(f.input, 'Enter'); await tick(); await tick();
  b.emit({ type: 'done', ok: false, error: 'Claude usage limit reached. This message was not answered; try again after the limit resets.', usage: null });
  assert.match(f.usage.message.textContent, /^Claude usage limit reached\. /);
  f.link.stop(); assert.equal(f.usage.root.hidden, true, 'a stopped link shows no notice');
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
  const modules = ['codex-chat', 'chat-tabs', 'codex-history', 'provider-setup', 'workspace-shell', 'claude-chat', 'task-usage', 'task-usage-ui'];
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
      status: async () => ({ installed: true, signedIn: true, cliVersion: '2.1.177', models: ['opus', 'sonnet', 'haiku'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultModel: 'sonnet', resolved: { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' }, message: null }),
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
  assert.match(await trigger(), /^Opus 5\.5\s*high$/);
  assert.equal(await page.locator('#claude-chat-tabs [role=tab] svg.provider-logo[data-provider=claude]').count(), 1, 'Claude tabs lead with the Claude mark');
  assert.equal(await page.locator('#codex-messages .codex-message.codex pre code').innerText(), 'local lobby = workspace.Lobby');
  assert.equal(await page.locator('#codex-messages .codex-message.codex p').innerText(), 'Here is the lobby plan.');
  assert.deepEqual(await layout(), codexLayout, 'composer and New chat keep the exact Codex geometry');
  await page.screenshot({ path: join(shots, 'claude-mode.png') });
  await page.locator('#codex-model-trigger').click(); await page.locator('#codex-picker-summary').waitFor();
  assert.equal(await page.locator('#codex-picker-current-model-label').innerText(), 'Opus 5.5');
  assert.equal(await page.locator('#codex-picker-effort-value').innerText(), 'High');
  await page.screenshot({ path: join(shots, 'claude-picker.png') });
  await page.locator('#codex-picker-current-model').click(); await page.locator('#codex-model-options').waitFor();
  assert.deepEqual(await page.locator('#codex-model-options .picker-model-option').allInnerTexts(), ['Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5']);
  await page.screenshot({ path: join(shots, 'claude-models.png') });
  await page.locator('#codex-model-options [data-picker-model="sonnet"]').click();
  assert.match(await trigger(), /^Sonnet 5\.5\s*high$/); await page.keyboard.press('Escape');
  await page.locator('#codex-composer').fill('Add a spawn pad'); await page.locator('#codex-composer').press('Enter');
  await page.waitForFunction(() => (window as any).fx.calls.length === 1);
  assert.deepEqual(await page.evaluate(() => (window as any).fx.calls[0]), { conversationId: 'conv-lobby', text: 'Add a spawn pad', model: 'sonnet', effort: 'high', playtest: false },
    'the composer Playtest switch (off by default) travels with the message');
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
  const modules = ['codex-chat', 'chat-tabs', 'codex-history', 'provider-setup', 'workspace-shell', 'claude-chat', 'task-usage', 'task-usage-ui'];
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
      status: async () => { f.status++; return { installed: true, signedIn: true, cliVersion: '2.1.177', models: ['opus', 'sonnet', 'haiku'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultModel: 'sonnet', resolved: { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' }, message: null }; },
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
  const layout = () => page.locator('#codex-model-options').evaluate(host => Array.from(host.querySelectorAll('.model-group-heading, .picker-model-option, .model-column-empty')).map(node =>
    node.classList.contains('model-group-heading') ? '# ' + node.textContent : (node as HTMLButtonElement).innerText.replace(/\s+/g, ' ').trim() + ((node as HTMLButtonElement).disabled ? ' [disabled]' : '')));
  const boxes = () => page.evaluate(() => Object.fromEntries(Array.from(document.querySelectorAll<HTMLElement>('#codex-model-options .model-column')).map(column => {
    const box = column.getBoundingClientRect(), logo = column.querySelector('.model-group-heading svg.provider-logo')!.getBoundingClientRect();
    return [column.dataset.pickerGroup, { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), logo: Math.round(logo.width) }];
  })));
  assert.match(await trigger(), /^GPT-6\.1-Sol\s*low$/);
  // Codex mode: open the list; Claude models load lazily under their own heading.
  await page.locator('#codex-model-trigger').click(); await page.locator('#codex-picker-current-model').click();
  await page.waitForFunction(() => !!document.querySelector('#codex-model-options [data-picker-model="opus"]'));
  assert.deepEqual(await layout(), ['# ChatGPT', 'GPT-6.1-Sol', 'GPT-6.1-Mini', '# Claude', 'Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5']);
  // Two columns side by side: ChatGPT on the left, Claude on the right, each headed by its logo mark.
  let geometry = await boxes();
  assert.ok(geometry.codex!.x < geometry.claude!.x && geometry.codex!.y === geometry.claude!.y, JSON.stringify(geometry));
  assert.ok(geometry.codex!.logo >= 16 && geometry.claude!.logo >= 16, 'logo marks render at heading size');
  assert.equal(await page.locator('#codex-model-popover').getAttribute('data-columns'), 'split');
  // Keyboard: arrows stay within a column; Left/Right cross between the ChatGPT and Claude columns.
  await page.locator('#codex-model-search').focus(); await page.keyboard.press('ArrowDown');
  const focused = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.pickerModel ?? null);
  assert.equal(await focused(), 'gpt-6.1-sol');
  await page.keyboard.press('ArrowDown'); assert.equal(await focused(), 'gpt-6.1-mini');
  await page.keyboard.press('ArrowDown'); assert.equal(await focused(), 'gpt-6.1-sol', 'Down wraps within the ChatGPT column');
  await page.keyboard.press('ArrowRight'); assert.equal(await focused(), 'opus');
  await page.keyboard.press('ArrowDown'); assert.equal(await focused(), 'sonnet');
  await page.keyboard.press('ArrowLeft'); assert.equal(await focused(), 'gpt-6.1-mini');
  assert.equal(await page.locator('#codex-model-popover').isVisible(), true, 'Left/Right never choose a model');
  await page.keyboard.press('ArrowRight');
  for (const scheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.screenshot({ path: join(shots, 'columns-' + scheme + '.png') });
    const box = (await page.locator('#codex-model-popover').boundingBox())!;
    await page.screenshot({ path: join(shots, 'columns-' + scheme + '-popover.png'), clip: { x: Math.max(0, box.x - 16), y: Math.max(0, box.y - 16), width: box.width + 32, height: box.height + 32 } });
  }
  await page.emulateMedia({ colorScheme: null });
  await page.screenshot({ path: join(shots, 'codex-mode-both-groups.png') });
  // A narrow window stacks the columns: ChatGPT above Claude.
  await page.setViewportSize({ width: 400, height: 860 });
  await page.waitForFunction(() => document.getElementById('codex-model-popover')!.dataset.columns === 'stacked');
  geometry = await boxes();
  assert.ok(geometry.codex!.y < geometry.claude!.y && geometry.codex!.x === geometry.claude!.x, JSON.stringify(geometry));
  await page.emulateMedia({ colorScheme: 'dark' }); await page.screenshot({ path: join(shots, 'columns-narrow-dark.png') }); await page.emulateMedia({ colorScheme: null });
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.waitForFunction(() => document.getElementById('codex-model-popover')!.dataset.columns === 'split');
  // One click on a Claude model: provider switches, Claude Opus is selected with the Codex effort, the draft stays.
  await page.locator('#codex-model-options [data-picker-model="opus"]').click();
  await page.waitForFunction(() => !document.getElementById('claude-chat-tabs')!.hidden);
  await page.waitForFunction(() => /Opus 5\.5/.test(document.getElementById('codex-model-trigger')!.innerText));
  assert.equal(await page.locator('#codex-composer').inputValue(), draft, 'the typed draft carried across the switch');
  assert.match(await trigger(), /^Opus 5\.5\s*low$/);
  assert.equal(await page.locator('#provider-setup-provider').inputValue(), 'claude', 'the switch is the persisted provider choice');
  assert.deepEqual(await page.evaluate(() => (window as any).fx.calls), [], 'switching never sends');
  await page.screenshot({ path: join(shots, 'after-switch-to-claude.png') });
  // Claude mode: the list again shows both providers; the effort slider follows Claude's five levels.
  await page.locator('#codex-model-trigger').click(); await page.locator('#codex-picker-summary').waitFor();
  assert.equal(await page.locator('#codex-picker-effort-slider').getAttribute('max'), '4');
  await page.locator('#codex-picker-current-model').click(); await page.locator('#codex-model-options [data-picker-model="gpt-6.1-sol"]').waitFor();
  assert.deepEqual(await layout(), ['# ChatGPT', 'GPT-6.1-Sol', 'GPT-6.1-Mini', '# Claude', 'Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5']);
  geometry = await boxes(); assert.ok(geometry.codex!.x < geometry.claude!.x, 'Claude mode keeps ChatGPT on the left');
  assert.equal(await page.locator('#codex-model-options [data-picker-model="opus"]').getAttribute('aria-selected'), 'true');
  await page.screenshot({ path: join(shots, 'claude-mode-both-groups.png') });
  for (const scheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const tabs = (await page.locator('#claude-chat-tabs').boundingBox())!;
    await page.screenshot({ path: join(shots, 'tabs-claude-' + scheme + '.png'), clip: { x: Math.max(0, tabs.x - 8), y: Math.max(0, tabs.y - 8), width: Math.min(700, tabs.width + 16), height: tabs.height + 16 } });
    await page.screenshot({ path: join(shots, 'claude-columns-' + scheme + '.png') });
  }
  await page.emulateMedia({ colorScheme: null });
  // Back to ChatGPT in one click: the draft follows again and the Codex catalogue applies the carried effort.
  await page.locator('#codex-model-options [data-picker-model="gpt-6.1-sol"]').click();
  await page.waitForFunction(() => document.getElementById('claude-chat-tabs')!.hidden);
  assert.equal(await page.locator('#codex-composer').inputValue(), draft);
  assert.match(await trigger(), /^GPT-6\.1-Sol\s*low$/);
  assert.equal(await page.locator('#provider-setup-provider').inputValue(), 'codex');
  await page.screenshot({ path: join(shots, 'after-switch-back-to-chatgpt.png') });
  assert.deepEqual(errors, []);
});

test('Edge: usage-limit notice offers the other provider in both directions and the draft follows', { skip: !browserModule, timeout: 60000 }, async t => {
  const build = process.env.ARCANE_UI_BUILD_DIR ?? 'dist', shots = resolve(process.env.ARCANE_UI_SCREENSHOT ?? 'runtime/claude-codex-team/claude-audit/usage/shots');
  await mkdir(shots, { recursive: true });
  const modules = ['codex-chat', 'chat-tabs', 'codex-history', 'provider-setup', 'workspace-shell', 'claude-chat', 'task-usage', 'task-usage-ui'];
  const fixture = `import {CodexChat,CodexChatApi} from '/codex-chat.js';
    import {startProviderSetup} from '/provider-setup.js';
    import {startWorkspaceShell} from '/workspace-shell.js';
    import {ClaudeChat, linkChatProviders} from '/claude-chat.js';
    const f = window.fx = { calls: [], listener: null };
    const chat = new CodexChat(document, new CodexChatApi('${'a'.repeat(64)}'));
    const native = Object.freeze({ version: 1, ...Object.fromEntries(['status','login','install','launch'].map(action => [action, async provider =>
      ({ version: 1, provider, installed: true, auth: 'subscription', cliVersion: '2.1.177', busy: false, message: null })])) });
    const setup = startProviderSetup(document, { chat, nativeBridge: native });
    const bridge = Object.freeze({ version: 1,
      status: async () => ({ installed: true, signedIn: true, cliVersion: '2.1.177', models: ['opus', 'sonnet', 'haiku'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultModel: 'sonnet', resolved: { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' }, message: null }),
      list: async () => ({ conversations: [] }), history: async id => ({ conversationId: id, messages: [] }),
      send: async request => { f.calls.push(request); return { turnId: 'turn-1', conversationId: 'conv-1' }; },
      stop: async () => true, remove: async () => true, onEvent: fn => { f.listener = fn; return () => {}; } });
    const claude = new ClaudeChat(document, { bridge, storage: null });
    f.emit = event => f.listener(event);
    linkChatProviders({ codex: chat, claude, provider: setup });
    startWorkspaceShell(document);
    await chat.start(); f.ready = true;`;
  const reset = Math.floor(Date.now() / 1000) + 2 * 3600;
  let exhausted = true;
  const state = () => {
    const value = codexState() as unknown as { snapshot: Record<string, unknown> };
    if (exhausted) value.snapshot.rateLimits = { source: 'account/rateLimits/updated', observedAt: Date.now(), ordinaryUsageAllowed: false, buckets: [{ limitId: 'codex', limitName: 'Codex', normalModelSlug: null,
      primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: reset }, secondary: { usedPercent: 64, windowDurationMins: 10080, resetsAt: reset + 86400 }, credits: null, spendControlReached: null, rateLimitReachedType: 'rate_limit_reached' }] };
    return value;
  };
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
  const errors: string[] = [];
  const open = async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } }); page.setDefaultTimeout(8000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:' + (server.address() as { port: number }).port + '/studio');
    await page.waitForFunction(() => (window as any).fx?.ready === true);
    await page.waitForFunction(() => document.getElementById('provider-login-gate')?.hidden === true);
    return page;
  };
  // ChatGPT exhausted: the notice sits above the composer and offers Claude in one click.
  const page = await open();
  const draft = 'ok, make the spawn point higher and';
  await page.locator('#codex-composer').fill(draft);
  const notice = page.locator('#usage-limit-notice'), action = page.locator('#usage-limit-action');
  await notice.waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.getElementById('usage-limit-action')!.textContent === 'Switch to Claude');
  assert.match(await page.locator('#usage-limit-message').innerText(), /^ChatGPT usage limit reached \u2014 resets at .+\. Your draft moves with you\.$/);
  const above = await page.evaluate(() => document.getElementById('usage-limit-notice')!.getBoundingClientRect().bottom <= document.getElementById('codex-compose')!.getBoundingClientRect().top + 1);
  assert.equal(above, true, 'the notice is above the composer');
  await page.screenshot({ path: join(shots, 'usage-chatgpt-limit-notice.png') });
  await action.click();
  await page.waitForFunction(() => !document.getElementById('claude-chat-tabs')!.hidden);
  assert.equal(await page.locator('#codex-composer').inputValue(), draft, 'the draft carried across the switch');
  await notice.waitFor({ state: 'hidden' });
  assert.deepEqual(await page.evaluate(() => (window as any).fx.calls), [], 'switching never sends');
  await page.screenshot({ path: join(shots, 'usage-after-switch-to-claude.png') });
  await page.close();
  // Claude at its limit while ChatGPT has usage: the same notice offers ChatGPT.
  exhausted = false;
  const second = await open();
  await second.evaluate(() => document.dispatchEvent(new CustomEvent('workspace:providerpreference', { detail: { provider: 'claude' } })));
  await second.waitForFunction(() => !document.getElementById('claude-chat-tabs')!.hidden);
  await second.waitForFunction(() => !(document.getElementById('codex-composer') as HTMLTextAreaElement).disabled);
  await second.locator('#codex-composer').fill('Add a spawn pad'); await second.locator('#codex-composer').press('Enter');
  await second.waitForFunction(() => (window as any).fx.calls.length === 1);
  await second.evaluate(at => (window as any).fx.emit({ turnId: 'turn-1', conversationId: 'conv-1', type: 'done', ok: false,
    error: 'Claude usage limit reached. This message was not answered; try again after the limit resets.', usage: null, usageLimit: { resetsAt: at } }), reset);
  await second.locator('#usage-limit-notice').waitFor({ state: 'visible' });
  assert.equal(await second.locator('#usage-limit-action').innerText(), 'Switch to ChatGPT');
  assert.match(await second.locator('#usage-limit-message').innerText(), /^Claude usage limit reached \u2014 resets at /);
  assert.equal(await second.locator('#codex-composer').inputValue(), 'Add a spawn pad');
  await second.screenshot({ path: join(shots, 'usage-claude-limit-notice.png') });
  await second.locator('#usage-limit-action').click();
  await second.waitForFunction(() => document.getElementById('claude-chat-tabs')!.hidden);
  assert.equal(await second.locator('#codex-composer').inputValue(), 'Add a spawn pad');
  await second.locator('#usage-limit-notice').waitFor({ state: 'hidden' });
  assert.equal(await second.evaluate(() => (window as any).fx.calls.length), 1, 'no automatic resend');
  await second.screenshot({ path: join(shots, 'usage-after-switch-to-chatgpt.png') });
  assert.deepEqual(errors, []);
});

test('codexUsageLimit reads exhaustion from the account report or a usage-limit turn rejection only', async () => {
  const { codexUsageLimit } = await import('../../apps/desktop/src/codex-chat.js');
  const window = (usedPercent: number, resetsAt: number | null) => ({ usedPercent, windowDurationMins: 300, resetsAt });
  const bucket = (extra: Record<string, unknown> = {}) => ({ limitId: 'codex', limitName: 'Codex', normalModelSlug: null, primary: window(40, 1792104000), secondary: null,
    credits: null, spendControlReached: null, rateLimitReachedType: null, ...extra });
  const snap = (rateLimits: unknown, auth = 'subscription') => ({ ...codexState().snapshot!, account: { auth, plan: 'fixture', requiresOpenaiAuth: true }, ...(rateLimits ? { rateLimits } : {}) }) as any;
  const report = (ordinaryUsageAllowed: boolean | null, buckets: unknown[]) => ({ source: 'account/rateLimits/read', observedAt: Date.now(), ordinaryUsageAllowed, buckets });
  assert.equal(codexUsageLimit(snap(null)), null);
  assert.equal(codexUsageLimit(snap(report(true, [bucket()]))), null);
  assert.equal(codexUsageLimit(snap(report(null, [bucket()]))), null);
  assert.deepEqual(codexUsageLimit(snap(report(false, [bucket({ primary: window(100, 1792104000), secondary: window(100, 1792190400) })]))), { resetsAt: 1792190400 });
  assert.deepEqual(codexUsageLimit(snap(report(false, [bucket()]))), { resetsAt: null }, 'blocked without a full window: reset unknown');
  assert.deepEqual(codexUsageLimit(snap(report(null, [bucket({ rateLimitReachedType: 'rate_limit_reached', primary: window(100, 1792104000) })]))), { resetsAt: 1792104000 });
  assert.equal(codexUsageLimit(snap(report(null, [bucket({ normalModelSlug: 'gpt-6.1-spark', primary: window(100, 1792104000) })]))), null, 'one model-specific bucket is not the account');
  assert.equal(codexUsageLimit(snap(report(false, [bucket()]), 'apiKey')), null, 'only the signed-in subscription account');
  const s = snap(null), turn = (state: string, errorCode: string | null) => ({ requestId: randomUUID(), action: 'turn-start', connectionId: s.connectionId, state, errorCode }) as any;
  assert.deepEqual(codexUsageLimit(s, [turn('rejected', 'USAGE_LIMIT_EXCEEDED')]), { resetsAt: null });
  assert.equal(codexUsageLimit(s, [turn('rejected', 'USAGE_LIMIT_EXCEEDED'), turn('acknowledged', null)]), null, 'a later accepted turn clears it');
  assert.equal(codexUsageLimit(s, [turn('rejected', 'REMOTE_REJECTED')]), null);
});

// ---- Chat activity: plain-language tool lines, change cards, queue, usage meter and composer commands. ----
const ws = (...segments: string[]) => ({ instanceId: 'i-' + segments.join('-'), sessionId: 's', root: segments[0], pathSegments: segments.slice(1), className: 'Folder' });
const receipt = (commandId: string, method: string, args: Record<string, unknown>, state = 'succeeded') =>
  JSON.stringify({ commandId, requestId: 'r', sessionId: 's', state, terminal: true, ambiguous: false, wait: 'terminal', command: { id: commandId, method, args, state, result: null } });

test('tool names and inputs become plain-language activity lines with running, done and failed states', () => {
  const line = (name: string, input: unknown, state: 'started' | 'finished' | 'failed' = 'started') => describeToolActivity(name, input, null, state).text;
  assert.equal(line('scene_children', { sessionId: 's', root: 'Workspace' }), 'Reading Workspace…');
  assert.equal(line('mcp__arcane__scene_create', { parent: ws('Workspace'), className: 'Part', name: 'SpawnPlatform' }), 'Creating Part "SpawnPlatform" in Workspace…');
  assert.equal(line('script_update', { ref: ws('ServerScriptService', 'Spawner'), source: '[90 characters]' }), 'Updating script ServerScriptService.Spawner…');
  assert.equal(line('playtest_request', { sessionId: 's' }), 'Starting a playtest…');
  assert.equal(line('scene_update', { ref: ws('Workspace', 'Lobby', 'Door'), expected: {}, properties: { Color: {}, Size: {} } }, 'finished'), 'Updating Workspace.Lobby.Door (Color, Size)');
  assert.equal(line('script_set_enabled', { ref: ws('ServerScriptService', 'Spawner'), enabled: true }, 'failed'), 'Enabling script ServerScriptService.Spawner');
  assert.equal(line('selection_read', null), 'Reading the Studio selection…');
  assert.equal(line('scene_search', { root: 'Workspace', query: 'Door' }), 'Searching Workspace for "Door"…');
  assert.equal(line('receipt_restore', { commandId: 'c' }), 'Restoring an earlier change…');
  assert.equal(line('work_progress', {}), 'Updating the task plan…');
  assert.equal(line('mystery_tool', {}), 'Using mystery_tool…');
  // Only a succeeded receipt is a change; ambiguous or failed outcomes never are.
  const args = { parent: ws('Workspace'), className: 'Part', name: 'SpawnPlatform' };
  assert.deepEqual(describeToolActivity('scene_create', args, JSON.parse(receipt('cmd-1', 'scene.create', args)), 'finished').change,
    { kind: 'created', text: 'Created Part "SpawnPlatform" in Workspace', receipt: 'cmd-1', path: 'Workspace.SpawnPlatform' });
  assert.equal(describeToolActivity('scene_create', args, JSON.parse(receipt('cmd-1', 'scene.create', args, 'needs_reconciliation')), 'finished').change, null);
  assert.equal(describeToolActivity('scene_create', args, JSON.parse(receipt('cmd-1', 'scene.create', args)), 'failed').change, null);
  assert.equal(describeToolActivity('scene_inspect', { ref: ws('Workspace') }, { commandId: 'x', state: 'succeeded' }, 'finished').change, null, 'reads are never changes');
  // Codex history keeps only the result text; an Arcane Studio result names its own command.
  const read = readToolResultText(receipt('cmd-9', 'script.update', { ref: ws('ServerScriptService', 'Spawner'), source: 'x', expectedSource: 'y' }));
  assert.equal(read.name, 'script_update'); assert.equal(read.state, 'finished');
  assert.equal(describeToolActivity(read.name!, read.input, read.result, read.state).change?.text, 'Edited script ServerScriptService.Spawner');
  assert.equal(readToolResultText('{"error":{"code":"SESSION_OFFLINE","message":"x"}}').state, 'failed');
  assert.equal(readToolResultText('plain output').name, null);
});

test('Codex: a live tool item shows a running line that settles in place', () => {
  const transcript = new CodexTranscript(), base = { connectionId: 'c', lastEventSeq: 1, droppedEvents: 0 } as any;
  transcript.consume({ ...base, events: [{ seq: 1, type: 'item', threadId: 't', turnId: 'v', itemId: 'm1', itemType: 'mcpToolCall', status: 'inProgress' }] });
  assert.deepEqual(transcript.messages.map(m => [m.role, m.toolState, m.text]), [['tool', 'started', '']]);
  transcript.consume({ ...base, lastEventSeq: 3, events: [{ seq: 3, type: 'item', threadId: 't', turnId: 'v', itemId: 'm1', itemType: 'mcpToolCall', status: 'completed' }] });
  assert.deepEqual(transcript.messages.map(m => [m.role, m.toolState]), [['tool', 'finished']]);
  transcript.consume({ ...base, lastEventSeq: 4, events: [{ seq: 4, type: 'item', threadId: 't', turnId: 'v', itemId: 'r', itemType: 'reasoning', status: null }] });
  assert.equal(transcript.messages.length, 1, 'other private items stay hidden');
});

test('Claude: tool events render plain lines with collapsed details, and a turn that changed Studio ends with one change card', async t => {
  const b = fakeBridge(); const f = mount(b.bridge); t.after(() => f.chat.stop()); await f.chat.refresh();
  f.type('Add a spawn platform and a spawner'); key(f.input, 'Enter'); await tick();
  const create = { sessionId: 's', parent: ws('Workspace'), className: 'Part', name: 'SpawnPlatform' };
  const update = { sessionId: 's', ref: ws('ServerScriptService', 'Spawner'), expectedSource: '[0 characters]', source: '[120 characters]' };
  const tool = (id: string, name: string, status: string, input?: unknown, result?: string) =>
    b.emit({ type: 'tool', message: { id, role: 'tool', text: name, at: '', tool: { name, status, ...(input ? { input: JSON.stringify(input) } : {}), ...(result ? { result } : {}) } } });
  tool('t1', 'scene_children', 'started', { sessionId: 's', root: 'Workspace' });
  tool('t1', 'scene_children', 'finished', undefined, '{"parentRef":{}}');
  tool('t2', 'scene_create', 'started', create);
  const lines = () => f.messages.querySelectorAll('.tool').map(node => node.dataset.toolState + ' ' + node.querySelector('.message-text')!.textContent);
  assert.deepEqual(lines(), ['finished Reading Workspace', 'started Creating Part "SpawnPlatform" in Workspace…']);
  tool('t2', 'scene_create', 'finished', undefined, receipt('cmd-create', 'scene.create', create));
  tool('t3', 'script_update', 'started', update);
  tool('t3', 'script_update', 'finished', undefined, receipt('cmd-script', 'script.update', update));
  tool('t4', 'scene_update', 'started', { ref: ws('Workspace', 'Door') });
  tool('t4', 'scene_update', 'failed', undefined, 'Studio is not in edit mode.');
  assert.deepEqual(lines(), ['finished Reading Workspace', 'finished Creating Part "SpawnPlatform" in Workspace', 'finished Updating script ServerScriptService.Spawner', 'failed Updating Workspace.Door']);
  const details = f.messages.querySelectorAll('.tool')[1]!.querySelector('.tool-details')!;
  assert.equal(details.open, false, 'raw details stay collapsed'); assert.match(details.textContent, /Details[\s\S]*"commandId": "cmd-create"/);
  assert.equal(f.messages.querySelector('.chat-change-card'), null, 'the card waits for the end of the turn');
  b.emit({ type: 'done', ok: true, error: null, usage: null }); await tick();
  const card = f.messages.querySelector('.chat-change-card')!;
  assert.equal(card.querySelector('.chat-change-summary')!.textContent, '1 created · 1 script edited');
  assert.deepEqual(card.querySelectorAll('.chat-change-text').map(node => node.textContent), ['Created Part "SpawnPlatform" in Workspace', 'Edited script ServerScriptService.Spawner']);
  assert.deepEqual(card.querySelectorAll('.chat-change-copy').map(node => node.getAttribute('aria-label')), ['Copy path ServerScriptService.Spawner']);
  assert.equal(f.messages.children.at(-1), card, 'the card closes the turn');
  // Restore writes an explicit request into the composer, keeps the draft above it, and never sends.
  f.type('Draft first');
  const sent = sends(b).length;
  click(card.querySelector('.chat-change-restore')!); await tick();
  assert.equal(sends(b).length, sent, 'Restore never sends');
  assert.equal(f.input.value, 'Draft first\n\n' + restoreRequestText([{ kind: 'created', text: '', receipt: 'cmd-create', path: null }, { kind: 'script', text: '', receipt: 'cmd-script', path: null }]));
  assert.match(f.input.value, /cmd-script, cmd-create\. Use receipt_restore/, 'newest first');
  assert.match(card.querySelector('.chat-change-status')!.textContent, /Review it, then send/);
  // History reload rebuilds the same lines and card from the saved tool details.
  b.histories.set('conv-new', { conversationId: 'conv-new', messages: [
    { id: 'u1', role: 'user', text: 'Add a spawn platform', at: '' },
    { id: 't2', role: 'tool', text: 'scene_create', at: '', tool: { name: 'scene_create', status: 'finished', input: JSON.stringify(create), result: receipt('cmd-create', 'scene.create', create) } },
    { id: 'a1', role: 'assistant', text: 'Done.', at: '' }, { id: 'u2', role: 'user', text: 'Thanks', at: '' }] });
  f.input.value = ''; f.chat.newChat(); await f.chat.open('conv-new'); await tick();
  assert.deepEqual(f.messages.children.map(node => node.className), ['codex-message human', 'codex-message tool', 'codex-message codex', 'chat-change-card', 'codex-message human']);
});

test('change cards: counts, copy path through the clipboard seam, and restore text naming every receipt', async () => {
  const { doc } = surface(); const copied: string[] = [];
  const changes = [{ kind: 'created' as const, text: 'Created Part "A" in Workspace', receipt: 'c1', path: 'Workspace.A' }, { kind: 'created' as const, text: 'Created Part "B" in Workspace', receipt: 'c2', path: 'Workspace.B' },
    { kind: 'enabled' as const, text: 'Enabled script ServerScriptService.Spawner', receipt: 'c3', path: 'ServerScriptService.Spawner' }, { kind: 'created' as const, text: 'dup', receipt: 'c1', path: null }];
  assert.equal(changeSummary(changes.slice(0, 3)), '2 created · 1 script enabled');
  const card = renderChangeCard(doc as unknown as Document, changes, { copy: async text => { copied.push(text); } }) as unknown as Element;
  assert.equal(card.querySelectorAll('.chat-change-row').length, 3, 'one row per receipt');
  click(card.querySelector('.chat-change-copy')!); await tick();
  assert.deepEqual(copied, ['ServerScriptService.Spawner']); assert.equal(card.querySelector('.chat-change-status')!.textContent, 'Copied ServerScriptService.Spawner');
  assert.equal(renderChangeCard(doc as unknown as Document, []), null);
  assert.match(restoreRequestText(changes), /^Please restore the Studio changes from these receipts, newest first: c3, c2, c1\. Use receipt_restore/);
});

test('Claude queue: Enter during a reply queues a removable chip; it sends after success and returns to the draft on failure, Stop or a usage limit', async t => {
  const b = fakeBridge(); const f = mount(b.bridge); t.after(() => f.chat.stop()); await f.chat.refresh();
  const chips = () => f.el('claude-chat-queue').querySelectorAll('.composer-queue-chip').map(node => node.querySelector('.composer-queue-text')!.textContent);
  f.type('First'); key(f.input, 'Enter'); await tick();
  f.type('Second'); key(f.input, 'Enter'); f.type('Third'); key(f.input, 'Enter'); f.type('Dropped'); key(f.input, 'Enter');
  assert.equal(sends(b).length, 1, 'nothing extra is sent while the reply runs');
  assert.deepEqual(chips(), ['Second', 'Third', 'Dropped']); assert.equal(f.el('claude-chat-queue').hidden, false); assert.equal(f.input.value, '');
  assert.match(f.notice.textContent, /3 messages queued/); assert.equal(f.submit.getAttribute('aria-label'), 'Stop task', 'Stop still works');
  click(f.el('claude-chat-queue').querySelectorAll('.composer-queue-remove')[2]!);
  assert.deepEqual(chips(), ['Second', 'Third']);
  b.emit({ type: 'done', ok: true, error: null, usage: null }); await tick();
  assert.deepEqual(sends(b).map((row: any) => row.text), ['First', 'Second'], 'only the next message is sent');
  assert.deepEqual(chips(), ['Third']); assert.deepEqual(f.bubbles().filter(row => row.role === 'user').map(row => row.text), ['First', 'Second']);
  f.type('Unsent draft');
  b.emit({ type: 'done', ok: false, error: 'Claude stopped before finishing.', usage: null }); await tick();
  assert.equal(sends(b).length, 2, 'a failed reply never sends the queue');
  assert.equal(f.input.value, 'Unsent draft\n\nThird'); assert.equal(f.el('claude-chat-queue').hidden, true);
  assert.equal(f.notice.textContent, CLAUDE_CHAT_QUEUE_RETURNED_TEXT);
  // Stop: the queue returns too.
  f.type(''); f.type('Fourth'); key(f.input, 'Enter'); await tick(); f.type('Fifth'); key(f.input, 'Enter');
  click(f.submit); await tick(); assert.equal(b.calls.filter(call => call[0] === 'stop').length, 1);
  b.emit({ type: 'done', ok: false, error: null, usage: null }); await tick();
  assert.equal(sends(b).length, 3); assert.equal(f.input.value, 'Fifth');
  // Usage limit: the unanswered prompt and the queue both come back; nothing is resent.
  f.type(''); f.type('Sixth'); key(f.input, 'Enter'); await tick(); f.type('Seventh'); key(f.input, 'Enter');
  b.emit({ type: 'done', ok: false, error: 'Claude usage limit reached. This message was not answered; try again after the limit resets.', usageLimit: { resetsAt: null }, usage: null }); await tick();
  assert.equal(sends(b).length, 4); assert.equal(f.input.value, 'Sixth\n\nSeventh');
});

test('Claude usage meter: tokens from finished replies accumulate per conversation with a ring, count and tooltip', async t => {
  const b = fakeBridge(), store = memory(); const f = mount(b.bridge, store); t.after(() => f.chat.stop()); await f.chat.refresh();
  const meter = () => f.el('claude-usage-meter');
  assert.equal(meter().hidden, true, 'no usage before a reply');
  f.type('One'); key(f.input, 'Enter'); await tick();
  b.emit({ type: 'done', ok: true, error: null, usage: { inputTokens: 3584, outputTokens: 400, costUsd: 0.01 } }); await tick();
  assert.equal(meter().hidden, false); assert.equal(meter().querySelector('.usage-meter-count')!.textContent, '4k');
  f.type('Two'); key(f.input, 'Enter'); await tick();
  b.emit({ type: 'done', ok: true, error: null, usage: { inputTokens: 9000, outputTokens: 1000, costUsd: null } }); await tick();
  // The second reply had no reported cost: its estimate comes from the price table for the resolved Sonnet model.
  const usage = f.chat.conversationUsage()!;
  assert.deepEqual({ ...usage, costUsd: Number(usage.costUsd!.toFixed(6)) }, { inputTokens: 12584, outputTokens: 1400, costUsd: 0.038, replies: 2, tableCostReplies: 1, uncostedReplies: 0 });
  assert.equal(meter().querySelector('.usage-meter-count')!.textContent, '14k');
  assert.equal(meter().querySelector('.usage-meter-cost')!.textContent, '~$0.04');
  assert.equal(meter().getAttribute('aria-label'), usageMeterText(usage));
  assert.match(meter().title, /^Tokens used in this conversation: 13,984 \(12,584 input, 1,400 output, ~\$0\.04 estimated\) across 2 replies recorded on this device\. Costs are estimates at API prices, partly from Arcane's price table; your subscription is not charged per token\./);
  // Totals are kept on this device: a new controller over the same storage shows them again.
  assert.match(store.data.get(CLAUDE_CHAT_USAGE_KEY) ?? '', /"replies":2/);
  f.chat.newChat(); assert.equal(meter().hidden, true, 'a new chat has its own meter');
  f.chat.deactivate(); assert.equal(meter().hidden, true);
  assert.deepEqual([950, 12345, 1_250_000].map(compactTokens), ['950', '12.3k', '1.3M']);
});

test('composer commands: "/" opens a keyboard menu (Esc closes, Enter runs without sending) and "@" inserts @selection', async t => {
  const b = fakeBridge(); const f = mount(b.bridge); t.after(() => f.chat.stop()); await f.chat.refresh();
  const menu = () => f.el('composer-command-menu');
  const options = () => menu().querySelectorAll('[role=option]').map(node => node.querySelector('.composer-command-name')!.textContent + (node.getAttribute('aria-selected') === 'true' ? '*' : ''));
  f.type('/');
  assert.equal(menu().hidden, false); assert.deepEqual(options(), ['/new*', '/clear-draft', '/model', '/help']);
  assert.equal(f.input.getAttribute('aria-expanded'), 'true'); assert.equal(f.input.getAttribute('aria-activedescendant'), 'composer-command-option-0');
  key(f.input, 'ArrowDown'); key(f.input, 'ArrowDown'); assert.deepEqual(options(), ['/new', '/clear-draft', '/model*', '/help']);
  key(f.input, 'ArrowUp'); key(f.input, 'ArrowUp'); key(f.input, 'ArrowUp'); assert.deepEqual(options(), ['/new', '/clear-draft', '/model', '/help*'], 'arrows wrap');
  const escape = key(f.input, 'Escape'); assert.equal(escape.defaultPrevented, true); assert.equal(menu().hidden, true); assert.equal(f.input.getAttribute('aria-expanded'), 'false');
  // /model opens the picker; Enter is consumed by the menu and nothing is sent.
  f.type('/mo'); assert.deepEqual(options(), ['/model*']);
  const enter = key(f.input, 'Enter'); await tick();
  assert.equal(enter.defaultPrevented, true); assert.deepEqual(sends(b), []); assert.equal(f.input.value, '');
  assert.equal(f.el('codex-model-popover').hidden, false, '/model opens the model picker'); key(f.el('codex-model-popover'), 'Escape');
  // /clear-draft by Tab; /new presses New chat; /help shows tips until Escape.
  f.type('/clear'); key(f.input, 'Tab'); assert.equal(f.input.value, ''); assert.equal(menu().hidden, true);
  let created = 0; f.el('workspace-new-chat').addEventListener('click', () => { created++; });
  f.type('/new'); key(f.input, 'Enter'); assert.equal(created, 1); assert.deepEqual(sends(b), []);
  f.type('/help'); key(f.input, 'Enter');
  assert.equal(menu().hidden, false); assert.equal(menu().getAttribute('role'), 'note'); assert.match(menu().textContent, /Shift\+Enter[\s\S]*@selection[\s\S]*queue/);
  key(f.input, 'Escape'); assert.equal(menu().hidden, true);
  // Unknown commands close the menu so Enter sends normally.
  f.type('/zzz'); assert.equal(menu().hidden, true);
  // @ mentions: only @selection, inserted as a literal token the assistant resolves with selection_read.
  f.type('Make @se'); assert.deepEqual(options(), ['@selection*']);
  key(f.input, 'Enter'); assert.equal(f.input.value, 'Make @selection '); assert.equal(menu().hidden, true); assert.deepEqual(sends(b), []);
  key(f.input, 'Enter'); await tick();
  assert.deepEqual(sends(b).map((row: any) => row.text), ['Make @selection'], 'with the menu closed Enter sends');
});

// ---- Edit a past message and rewind; interactive choices and plan approval ----
const lobbyCreate = { sessionId: 's', parent: ws('Workspace'), className: 'Part', name: 'Door' };
const lobbyHistory = () => ({ conversationId: 'conv-new', messages: [
  { id: 'u1', role: 'user', text: 'Make a lobby', at: '' }, { id: 'a1', role: 'assistant', text: 'Lobby ready.', at: '' },
  { id: 'u2', role: 'user', text: 'Add a red door', at: '' },
  { id: 't1', role: 'tool', text: 'scene_create', at: '', tool: { name: 'scene_create', status: 'finished', input: JSON.stringify(lobbyCreate), result: receipt('cmd-door', 'scene.create', lobbyCreate) } },
  { id: 'a2', role: 'assistant', text: 'Door added.', at: '' }] });
async function rewindFixture(t: { after: (fn: () => void) => void }, rewind?: (request: any) => Promise<unknown>) {
  const order: string[] = [];
  let b!: ReturnType<typeof fakeBridge>;
  b = fakeBridge({
    rewind: rewind ?? (async (request: any) => { order.push('rewind'); b.calls.push(['rewind', request]); b.histories.set('conv-new', { conversationId: 'conv-new', messages: lobbyHistory().messages.slice(0, 2) }); return { conversationId: 'conv-new', kept: 2 }; }),
  });
  b.histories.set('conv-new', lobbyHistory());
  b.reply(async () => { order.push('send'); return { turnId: 'turn-1', conversationId: 'conv-new', messageId: 'u3' }; });
  const f = mount(b.bridge); t.after(() => f.chat.stop()); await f.chat.refresh();
  await f.chat.open('conv-new'); await tick();
  return { b, f, order };
}
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };

test('Claude edit: Edit rewinds the saved transcript after that message, reloads it and sends the edited text exactly once', async t => {
  const { b, f, order } = await rewindFixture(t);
  const edits = f.messages.querySelectorAll('.chat-message-edit');
  assert.deepEqual(edits.map(node => node.getAttribute('aria-label')), ['Edit this message', 'Edit this message'], 'only the two user messages offer Edit');
  click(edits[1]!);
  const form = f.messages.querySelector('.chat-edit')!, area = form.querySelector('.chat-edit-input')!, box = form.querySelector('.chat-edit-undo-box')!;
  assert.equal(area.value, 'Add a red door'); assert.equal(box.disabled, false);
  assert.match(form.querySelector('.chat-edit-undo')!.textContent, /^Also undo Studio changes made after this message \(1\)$/);
  assert.match(form.querySelector('.chat-edit-hint')!.textContent, /Replies after this message are removed/);
  assert.deepEqual(sends(b), [], 'opening the editor sends nothing');
  area.value = 'Add a blue door';
  form.dispatchEvent(new Event('submit', { cancelable: true })); await settle();
  assert.deepEqual(b.calls.filter(call => call[0] === 'rewind'), [['rewind', { conversationId: 'conv-new', messageId: 'u2' }]]);
  assert.deepEqual(order, ['rewind', 'send'], 'the saved transcript is rewound before the edited text is sent');
  assert.deepEqual(sends(b), [{ conversationId: 'conv-new', text: 'Add a blue door', model: 'sonnet', effort: 'high' }]);
  assert.deepEqual(f.bubbles().map(row => row.role + ':' + row.text), ['user:Make a lobby', 'assistant:Lobby ready.', 'user:Add a blue door'], 'the discarded turn is gone');
  assert.equal(f.messages.querySelector('.chat-change-card'), null);
  assert.equal(f.input.value, '', 'the composer is untouched');
  // The re-sent message is editable once its saved id arrives.
  assert.equal(f.messages.querySelectorAll('.chat-message-edit').length, 2);
});

test('Claude edit: "Also undo Studio changes" writes the restore request into the message box and queues the edit; nothing is sent until Send', async t => {
  const { b, f } = await rewindFixture(t);
  click(f.messages.querySelectorAll('.chat-message-edit')[1]!);
  const form = f.messages.querySelector('.chat-edit')!;
  form.querySelector('.chat-edit-input')!.value = 'Add a blue door'; (form.querySelector('.chat-edit-undo-box') as any).checked = true;
  form.dispatchEvent(new Event('submit', { cancelable: true })); await settle();
  assert.equal(b.calls.filter(call => call[0] === 'rewind').length, 1);
  assert.deepEqual(sends(b), [], 'the restore request is never sent automatically');
  assert.equal(f.input.value, restoreRequestText([{ kind: 'created', text: '', receipt: 'cmd-door', path: null }]));
  assert.deepEqual(f.chat.queued().map(item => item.text), ['Add a blue door']);
  assert.equal(f.notice.textContent, CLAUDE_CHAT_EDIT_UNDO_TEXT);
  // The user reviews and sends the restore request; the edited message follows only after that reply succeeds.
  key(f.input, 'Enter'); await settle();
  assert.deepEqual(sends(b).map((row: any) => row.text), [restoreRequestText([{ kind: 'created', text: '', receipt: 'cmd-door', path: null }])]);
  b.emit({ conversationId: 'conv-new', type: 'done', ok: true, error: null, usage: null }); await settle();
  assert.deepEqual(sends(b).map((row: any) => row.text).at(-1), 'Add a blue door');
  assert.equal(sends(b).length, 2);
});

test('Claude edit: a refused rewind keeps the transcript and sends nothing; Edit needs an idle chat and a rewind-capable bridge', async t => {
  const { b, f } = await rewindFixture(t, async () => { throw new Error('This message can no longer be edited.'); });
  click(f.messages.querySelectorAll('.chat-message-edit')[0]!);
  const form = f.messages.querySelector('.chat-edit')!; form.querySelector('.chat-edit-input')!.value = 'Make a castle';
  assert.equal(form.querySelector('.chat-edit-undo-box')!.disabled, false);
  form.dispatchEvent(new Event('submit', { cancelable: true })); await settle();
  assert.deepEqual(sends(b), []); assert.equal(f.notice.textContent, 'This message can no longer be edited.');
  assert.equal(f.bubbles().length, 5, 'the transcript is unchanged');
  // Cancel (Escape) restores the original message with its Edit action.
  key(f.messages.querySelector('.chat-edit-input')!, 'Escape');
  assert.equal(f.messages.querySelector('.chat-edit'), null); assert.equal(f.messages.querySelectorAll('.chat-message-edit').length, 2);
  // While a reply runs, Edit explains instead of opening.
  f.type('Next'); key(f.input, 'Enter'); await tick();
  click(f.messages.querySelectorAll('.chat-message-edit')[0]!);
  assert.equal(f.messages.querySelector('.chat-edit'), null); assert.match(f.notice.textContent, /Wait for the reply to finish/);
  // Without bridge.rewind (older desktop builds) no Edit action is offered.
  const plain = fakeBridge(); plain.histories.set('conv-new', lobbyHistory());
  const g = mount(plain.bridge); t.after(() => g.chat.stop()); await g.chat.refresh(); await g.chat.open('conv-new'); await tick();
  assert.equal(g.messages.querySelectorAll('.chat-message-edit').length, 0);
});

test('choice blocks: strict JSON parsing; anything invalid stays a plain code block', () => {
  assert.deepEqual(parseChoiceBlock('arcane-choices', '{"question":"Which door?","options":["Red","Blue"]}'), { kind: 'choices', question: 'Which door?', options: ['Red', 'Blue'] });
  assert.deepEqual(parseChoiceBlock('arcane-plan', ' {"steps":["Build the lobby","Add a door"]}\n'), { kind: 'plan', steps: ['Build the lobby', 'Add a door'] });
  const invalid: [string, string][] = [
    ['arcane-choices', '{"question":"Q","options":["Only one"]}'], ['arcane-choices', '{"question":"Q","options":["A","a"]}'],
    ['arcane-choices', '{"question":"Q","options":["A","B"],"extra":1}'], ['arcane-choices', '{"question":"","options":["A","B"]}'],
    ['arcane-choices', '{"question":"Q","options":["A",2]}'], ['arcane-choices', '{"question":"Q","options":' + JSON.stringify(Array.from({ length: 7 }, (_, i) => 'o' + i)) + '}'],
    ['arcane-choices', '{"question":"Q","options":["' + 'x'.repeat(CHOICE_BLOCK_LIMITS.option + 1) + '","B"]}'], ['arcane-choices', '{"question":"Q\\u0007","options":["A","B"]}'],
    ['arcane-choices', '{"question":"Q","options":["A","B"]'], ['arcane-choices', '["A","B"]'], ['arcane-choices', '{"__proto__":{"x":1},"question":"Q","options":["A","B"]}'],
    ['arcane-plan', '{"steps":[]}'], ['arcane-plan', '{"steps":"Build"}'], ['arcane-plan', '{"steps":["A"],"question":"Q"}'],
    ['arcane-plan', JSON.stringify({ steps: Array.from({ length: 13 }, (_, i) => 'Step ' + i) })], ['arcane-plan', '{"steps":["' + 'y'.repeat(5000) + '"]}'],
    ['arcane-other', '{"steps":["A"]}'], ['arcane-plan', '{"options":["A","B"],"question":"Q"}'],
  ];
  for (const [language, body] of invalid) assert.equal(parseChoiceBlock(language, body), null, language + ' ' + body.slice(0, 80));
  const { doc } = surface();
  const text = (value: string) => renderMessageText(doc as unknown as Document, value, { choose: () => true }) as unknown as Element;
  const broken = text('Pick one:\n```arcane-choices\n{"question":"Q","options":["A"]}\n```');
  assert.equal(broken.querySelector('.chat-choices'), null); assert.equal(broken.querySelector('code')!.textContent, '{"question":"Q","options":["A"]}');
  assert.equal(text('Unclosed\n```arcane-plan\n{"steps":["A"]}').querySelector('.chat-choices'), null, 'an unfinished fence is not a block');
  const before = innerHtmlWrites;
  const xss = text('```arcane-choices\n{"question":"<b>Pick</b>","options":["<img src=x onerror=alert(1)>","Safe"]}\n```');
  assert.deepEqual(xss.querySelectorAll('.chat-choice').map(node => node.textContent), ['<img src=x onerror=alert(1)>', 'Safe'], 'options are text, never HTML');
  assert.equal(xss.querySelector('.chat-choices-question')!.textContent, '<b>Pick</b>'); assert.equal(innerHtmlWrites, before);
  const inline = text('```arcane-plan {"steps":["Only step"]}```');
  assert.deepEqual(inline.querySelectorAll('li').map(node => node.textContent), ['Only step'], 'a one-line fence also works');
  const display = renderMessageText(doc as unknown as Document, '```arcane-plan\n{"steps":["A"]}\n```') as unknown as Element;
  assert.ok(display.querySelectorAll('button').every(node => node.disabled), 'without a send callback the block is display-only');
});

test('Claude choices: a click sends exactly one message; plan approval sends once and Change plan only pre-fills', async t => {
  const b = fakeBridge(); const f = mount(b.bridge); t.after(() => f.chat.stop()); await f.chat.refresh();
  f.type('Make a door'); key(f.input, 'Enter'); await tick();
  b.emit({ type: 'message', message: { id: 'a1', role: 'assistant', text: 'Which colour?\n\n```arcane-choices\n{"question":"Which door colour?","options":["Red","Blue"]}\n```', at: '' } });
  const options = () => f.messages.querySelectorAll('.chat-choice');
  assert.deepEqual(options().map(node => node.textContent), ['Red', 'Blue']);
  assert.equal(f.messages.querySelector('.chat-choices')!.getAttribute('aria-label'), 'Question: Which door colour?');
  // While the reply is still running the answer waits in the queue (one message), then sends after it finishes.
  click(options()[1]!); click(options()[1]!); click(options()[0]!);
  assert.deepEqual(sends(b).map((row: any) => row.text), ['Make a door']); assert.deepEqual(f.chat.queued().map(item => item.text), ['Blue']);
  assert.ok(options().every(node => node.disabled)); assert.equal(options()[1]!.getAttribute('aria-pressed'), 'true');
  b.emit({ type: 'done', ok: true, error: null, usage: null }); await tick();
  assert.deepEqual(sends(b).map((row: any) => row.text), ['Make a door', 'Blue'], 'exactly one answer was sent');
  b.emit({ type: 'done', ok: true, error: null, usage: null }); await tick();
  // A plan on an idle chat: Change plan pre-fills without sending; Approve sends exactly once.
  f.chat.newChat(); b.reply(async () => ({ turnId: 'turn-2', conversationId: 'conv-plan' }));
  f.type('Build an obby'); key(f.input, 'Enter'); await tick();
  b.emit({ turnId: 'turn-2', conversationId: 'conv-plan', type: 'message', message: { id: 'p1', role: 'assistant', text: '```arcane-plan\n{"steps":["Platforms","Checkpoints","Kill bricks"]}\n```', at: '' } });
  b.emit({ turnId: 'turn-2', conversationId: 'conv-plan', type: 'done', ok: true, error: null, usage: null }); await tick();
  const plan = f.messages.querySelector('.chat-choices')!;
  assert.deepEqual(plan.querySelectorAll('li').map(node => node.textContent), ['Platforms', 'Checkpoints', 'Kill bricks']);
  const [approve, change] = plan.querySelectorAll('button');
  assert.deepEqual([approve!.textContent, change!.textContent], ['Approve plan', 'Change plan']);
  const sent = sends(b).length;
  click(change!); assert.equal(f.input.value, PLAN_CHANGE_TEXT); assert.equal(sends(b).length, sent, 'Change plan never sends');
  f.type('');
  b.reply(async () => ({ turnId: 'turn-3', conversationId: 'conv-plan' }));
  click(approve!); click(approve!); await tick();
  assert.deepEqual(sends(b).slice(sent).map((row: any) => row.text), [PLAN_APPROVE_TEXT]);
  assert.equal(plan.dataset.state, 'answered');
});

test('Claude choices: saved replies answered by a later message stay closed; the latest open block stays live', async t => {
  const b = fakeBridge();
  b.histories.set('conv-new', { conversationId: 'conv-new', messages: [
    { id: 'u1', role: 'user', text: 'Door?', at: '' }, { id: 'a1', role: 'assistant', text: '```arcane-choices\n{"question":"Colour?","options":["Red","Blue"]}\n```', at: '' },
    { id: 'u2', role: 'user', text: 'Red', at: '' }, { id: 'a2', role: 'assistant', text: '```arcane-choices\n{"question":"Size?","options":["Small","Large"]}\n```', at: '' }] });
  const f = mount(b.bridge); t.after(() => f.chat.stop()); await f.chat.refresh(); await f.chat.open('conv-new'); await tick();
  const blocks = f.messages.querySelectorAll('.chat-choices');
  assert.deepEqual(blocks.map(node => node.dataset.state), ['closed', 'open']);
  assert.ok(blocks[0]!.querySelectorAll('button').every(node => node.disabled));
  click(blocks[1]!.querySelectorAll('button')[1]!); await tick();
  assert.deepEqual(sends(b).map((row: any) => row.text), ['Large']);
});

test('Edge: Claude activity lines, change card, queue chips, usage meter and the composer command menu',{ skip: !browserModule, timeout: 60000 }, async t => {
  const build = process.env.ARCANE_UI_BUILD_DIR ?? 'dist', shots = resolve(process.env.ARCANE_UI_SCREENSHOT ?? 'runtime/claude-codex-team/claude-audit/chatux/shots');
  await mkdir(shots, { recursive: true });
  const modules = ['codex-chat', 'chat-tabs', 'codex-history', 'provider-setup', 'workspace-shell', 'claude-chat', 'task-usage', 'task-usage-ui'];
  const fixture = `import {CodexChat,CodexChatApi} from '/codex-chat.js';
    import {startProviderSetup} from '/provider-setup.js';
    import {startWorkspaceShell} from '/workspace-shell.js';
    import {ClaudeChat} from '/claude-chat.js';
    const f = window.fx = { calls: [] };
    const chat = new CodexChat(document, new CodexChatApi('${'a'.repeat(64)}'));
    const native = Object.freeze({ version: 1, ...Object.fromEntries(['status','login','install','launch'].map(action => [action, async provider =>
      ({ version: 1, provider, installed: true, auth: 'subscription', cliVersion: '2.1.177', busy: false, message: null })])) });
    const setup = startProviderSetup(document, { chat, nativeBridge: native });
    const bridge = Object.freeze({ version: 1,
      status: async () => ({ installed: true, signedIn: true, cliVersion: '2.1.177', models: ['opus', 'sonnet'], efforts: ['low', 'medium', 'high'], defaultModel: 'opus', resolved: { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5' }, message: null }),
      list: async () => ({ conversations: [] }), history: async id => ({ conversationId: id, messages: [] }),
      send: async request => { f.calls.push(request); return { turnId: 'turn-' + f.calls.length, conversationId: 'conv-spawn' }; },
      stop: async () => true, remove: async () => true, onEvent: listener => { f.emit = listener; return () => {}; } });
    const claude = new ClaudeChat(document, { bridge, storage: null });
    f.claude = claude;
    setup.subscribeChatSurface(() => { if (setup.chatSurface() === 'claude') { chat.yieldSurface(true); claude.activate(); f.refreshed = claude.refresh(); } else { claude.deactivate(); chat.yieldSurface(false); } });
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
  for (const scheme of ['dark', 'light'] as const) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: scheme }); page.setDefaultTimeout(8000);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:' + (server.address() as { port: number }).port + '/studio');
    await page.waitForFunction(() => (window as any).fx?.ready === true);
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('workspace:providerpreference', { detail: { provider: 'claude' } })));
    await page.waitForFunction(() => !document.getElementById('claude-chat-tabs')!.hidden);
    await page.evaluate(() => (window as any).fx.refreshed);
    const composer = page.locator('#codex-composer');
    await composer.fill('Add a spawn platform with a spawner script'); await composer.press('Enter');
    await page.waitForFunction(() => (window as any).fx.calls.length === 1);
    await page.evaluate(() => {
      const fx = (window as any).fx, ref = (root: string, ...pathSegments: string[]) => ({ instanceId: 'i', sessionId: 's', root, pathSegments, className: 'Script' });
      const ok = (commandId: string, method: string, args: unknown) => JSON.stringify({ commandId, state: 'succeeded', terminal: true, command: { method, args } });
      const create = { parent: ref('Workspace'), className: 'Part', name: 'SpawnPlatform' }, script = { ref: ref('ServerScriptService', 'Spawner'), source: '[140 characters]' };
      const tool = (id: string, name: string, status: string, input?: unknown, result?: string) => fx.emit({ turnId: 'turn-1', conversationId: 'conv-spawn', type: 'tool',
        message: { id, role: 'tool', text: name, at: '', tool: { name, status, ...(input ? { input: JSON.stringify(input) } : {}), ...(result ? { result } : {}) } } });
      tool('t1', 'scene_children', 'started', { root: 'Workspace' }); tool('t1', 'scene_children', 'finished', undefined, '{"nodes":[]}');
      tool('t2', 'scene_create', 'started', create); tool('t2', 'scene_create', 'finished', undefined, ok('cmd-create-1', 'scene.create', create));
      tool('t3', 'script_update', 'started', script); tool('t3', 'script_update', 'finished', undefined, ok('cmd-script-2', 'script.update', script));
      tool('t4', 'scene_update', 'started', { ref: ref('Workspace', 'Lobby', 'Door'), properties: { Color: {} } }); tool('t4', 'scene_update', 'failed', undefined, 'Studio is not in edit mode.');
      tool('t5', 'playtest_request', 'started', { sessionId: 's' });
    });
    await page.locator('#codex-messages .tool-activity').nth(4).waitFor();
    assert.deepEqual(await page.locator('#codex-messages .tool-activity-text').allInnerTexts(),
      ['Reading Workspace', 'Creating Part "SpawnPlatform" in Workspace', 'Updating script ServerScriptService.Spawner', 'Updating Workspace.Lobby.Door (Color)', 'Starting a playtest…']);
    assert.equal(await page.locator('#codex-messages .tool-details[open]').count(), 0, 'no raw JSON by default');
    // Queue two messages while the reply runs.
    await composer.fill('Now make the platform glow'); await composer.press('Enter');
    await composer.fill('Then add a checkpoint'); await composer.press('Enter');
    assert.deepEqual(await page.locator('#claude-chat-queue .composer-queue-text').allInnerTexts(), ['Now make the platform glow', 'Then add a checkpoint']);
    await page.locator('#codex-messages .tool-activity').nth(4).scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(shots, 'activity-running-' + scheme + '.png') });
    await page.evaluate(() => {
      const fx = (window as any).fx;
      fx.emit({ turnId: 'turn-1', conversationId: 'conv-spawn', type: 'tool', message: { id: 't5', role: 'tool', text: 'playtest_request', at: '', tool: { name: 'playtest_request', status: 'finished', result: '{"state":"needs_approval"}' } } });
      fx.emit({ turnId: 'turn-1', conversationId: 'conv-spawn', type: 'message', message: { id: 'a1', role: 'assistant', text: 'Added SpawnPlatform and the Spawner script. The playtest is waiting for your approval.', at: '' } });
      fx.emit({ turnId: 'turn-1', conversationId: 'conv-spawn', type: 'done', ok: true, error: null, usage: { inputTokens: 18234, outputTokens: 1620, costUsd: 0.0412 } });
    });
    await page.locator('#codex-messages .chat-change-card').waitFor();
    await page.waitForFunction(() => (window as any).fx.calls.length === 2);
    assert.equal(await page.evaluate(() => (window as any).fx.calls[1].text), 'Now make the platform glow', 'the next queued message is sent after success');
    assert.deepEqual(await page.locator('#claude-chat-queue .composer-queue-text').allInnerTexts(), ['Then add a checkpoint']);
    assert.equal(await page.locator('#codex-messages .chat-change-summary').innerText(), '1 created · 1 script edited');
    assert.equal(await page.locator('#claude-usage-meter').isVisible(), true);
    assert.equal(await page.locator('#claude-usage-meter .usage-meter-count').innerText(), '19.9k');
    await page.locator('#codex-messages .chat-change-card').scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(shots, 'activity-change-card-' + scheme + '.png') });
    await page.locator('#codex-messages .chat-change-restore').click();
    assert.match(await composer.inputValue(), /^Please restore the Studio changes from these receipts, newest first: cmd-script-2, cmd-create-1\./);
    assert.equal(await page.evaluate(() => (window as any).fx.calls.length), 2, 'Restore never sends');
    await page.screenshot({ path: join(shots, 'activity-restore-prefill-' + scheme + '.png') });
    // Slash menu and @selection.
    await composer.fill(''); await composer.pressSequentially('/');
    await page.locator('#composer-command-menu [role=option]').first().waitFor();
    assert.deepEqual(await page.locator('#composer-command-menu .composer-command-name').allInnerTexts(), ['/new', '/clear-draft', '/model', '/help']);
    await composer.press('ArrowDown');
    assert.equal(await page.locator('#composer-command-menu [aria-selected=true] .composer-command-name').innerText(), '/clear-draft');
    await page.screenshot({ path: join(shots, 'composer-slash-menu-' + scheme + '.png') });
    await composer.press('Escape'); assert.equal(await page.locator('#composer-command-menu').isVisible(), false);
    await composer.fill(''); await composer.pressSequentially('/help'); await composer.press('Enter');
    assert.equal(await page.locator('#composer-command-menu[data-mode=help]').isVisible(), true);
    await page.screenshot({ path: join(shots, 'composer-help-' + scheme + '.png') });
    await composer.press('Escape');
    await composer.pressSequentially('Make @sel'); await page.locator('#composer-command-menu[data-mode=mention]').waitFor();
    await page.screenshot({ path: join(shots, 'composer-mention-' + scheme + '.png') });
    await composer.press('Enter'); assert.equal(await composer.inputValue(), 'Make @selection ');
    await composer.fill(''); await composer.pressSequentially('/model'); await composer.press('Enter');
    await page.locator('#codex-picker-summary').waitFor(); await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => (window as any).fx.calls.length), 2, 'commands never send');
    // A failed reply returns the queue to the message box.
    await page.evaluate(() => (window as any).fx.emit({ turnId: 'turn-2', conversationId: 'conv-spawn', type: 'done', ok: false, error: 'Claude stopped before finishing.', usage: null }));
    await page.waitForFunction(() => (document.getElementById('codex-composer') as HTMLTextAreaElement).value.includes('Then add a checkpoint'));
    assert.equal(await page.locator('#claude-chat-queue').isVisible(), false);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#codex-messages .chat-change-card').scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(shots, 'activity-mobile-' + scheme + '.png') });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, 'no horizontal scroll at phone width');
    if (scheme === 'dark') { await page.emulateMedia({ forcedColors: 'active' }); await page.screenshot({ path: join(shots, 'activity-forced-colors.png') }); }
    assert.deepEqual(errors, []);
    await page.close();
  }
});

test('Edge: Claude edit and rewind with the undo option, plan approval and option buttons', { skip: !browserModule, timeout: 60000 }, async t => {
  const build = process.env.ARCANE_UI_BUILD_DIR ?? 'dist', shots = resolve(process.env.ARCANE_UI_SCREENSHOT ?? 'runtime/claude-codex-team/claude-audit/rewind/shots');
  await mkdir(shots, { recursive: true });
  const modules = ['codex-chat', 'chat-tabs', 'codex-history', 'provider-setup', 'workspace-shell', 'claude-chat', 'task-usage', 'task-usage-ui'];
  const create = { parent: { instanceId: 'i', sessionId: 's', root: 'Workspace', pathSegments: [], className: 'Folder' }, className: 'Part', name: 'RedDoor' };
  const saved = [
    { id: '00000000-0000-4000-8000-000000000001', role: 'user', text: 'Make a lobby with a spawn point', at: '2026-10-17T10:00:00.000Z' },
    { id: '00000000-0000-4000-8000-000000000002', role: 'assistant', text: 'The lobby and spawn point are ready.', at: '2026-10-17T10:00:05.000Z' },
    { id: '00000000-0000-4000-8000-000000000003', role: 'user', text: 'Add a red door to the lobby', at: '2026-10-17T10:01:00.000Z' },
    { id: '00000000-0000-4000-8000-000000000004', role: 'tool', text: 'scene_create', at: '2026-10-17T10:01:03.000Z', tool: { name: 'scene_create', status: 'finished', input: JSON.stringify(create),
      result: JSON.stringify({ commandId: 'cmd-red-door', state: 'succeeded', terminal: true, command: { method: 'scene.create', args: create } }) } },
    { id: '00000000-0000-4000-8000-000000000005', role: 'assistant', text: 'Added RedDoor to Workspace.', at: '2026-10-17T10:01:06.000Z' }];
  const fixture = `import {CodexChat,CodexChatApi} from '/codex-chat.js';
    import {startProviderSetup} from '/provider-setup.js';
    import {startWorkspaceShell} from '/workspace-shell.js';
    import {ClaudeChat} from '/claude-chat.js';
    const f = window.fx = { calls: [], rewinds: [] };
    let saved = ${JSON.stringify(saved)};
    const chat = new CodexChat(document, new CodexChatApi('${'a'.repeat(64)}'));
    const native = Object.freeze({ version: 1, ...Object.fromEntries(['status','login','install','launch'].map(action => [action, async provider =>
      ({ version: 1, provider, installed: true, auth: 'subscription', cliVersion: '2.1.177', busy: false, message: null })])) });
    const setup = startProviderSetup(document, { chat, nativeBridge: native });
    const bridge = Object.freeze({ version: 1,
      status: async () => ({ installed: true, signedIn: true, cliVersion: '2.1.177', models: ['opus', 'sonnet'], efforts: ['low', 'medium', 'high'], defaultModel: 'opus', resolved: { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5' }, message: null }),
      list: async () => ({ conversations: [{ conversationId: 'conv-lobby', title: 'Lobby', updatedAt: '2026-10-17T10:01:06.000Z', model: 'opus', effort: 'high' }] }),
      history: async id => ({ conversationId: id, messages: saved }),
      rewind: async request => { f.rewinds.push(request); saved = saved.slice(0, saved.findIndex(m => m.id === request.messageId)); return { conversationId: request.conversationId, kept: saved.length }; },
      send: async request => { f.calls.push(request); return { turnId: 'turn-' + f.calls.length, conversationId: 'conv-lobby', messageId: '00000000-0000-4000-8000-00000000010' + f.calls.length }; },
      stop: async () => true, remove: async () => true, onEvent: listener => { f.emit = listener; return () => {}; } });
    const claude = new ClaudeChat(document, { bridge, storage: null });
    f.claude = claude;
    setup.subscribeChatSurface(() => { if (setup.chatSurface() === 'claude') { chat.yieldSurface(true); claude.activate(); f.refreshed = claude.refresh(); } else { claude.deactivate(); chat.yieldSurface(false); } });
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
  for (const scheme of ['dark', 'light'] as const) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: scheme }); page.setDefaultTimeout(8000);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:' + (server.address() as { port: number }).port + '/studio');
    await page.waitForFunction(() => (window as any).fx?.ready === true);
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('workspace:providerpreference', { detail: { provider: 'claude' } })));
    await page.waitForFunction(() => !document.getElementById('claude-chat-tabs')!.hidden);
    await page.evaluate(() => (window as any).fx.refreshed);
    await page.evaluate(() => (window as any).fx.claude.open('conv-lobby'));
    const human = page.locator('#codex-messages .codex-message.human');
    await human.nth(1).waitFor();
    assert.equal(await human.locator('.chat-message-edit').count(), 2);
    await human.nth(1).hover();
    assert.equal(await human.nth(1).locator('.chat-message-edit').evaluate(node => getComputedStyle(node).opacity), '1', 'Edit shows on hover');
    await page.screenshot({ path: join(shots, 'rewind-edit-hover-' + scheme + '.png') });
    await human.nth(1).locator('.chat-message-edit').click();
    const editor = page.locator('#codex-messages .chat-edit');
    await editor.locator('.chat-edit-input').fill('Add a blue door to the lobby');
    await editor.locator('.chat-edit-undo-box').check();
    assert.match(await editor.locator('.chat-edit-undo').innerText(), /Also undo Studio changes made after this message \(1\)/);
    await page.screenshot({ path: join(shots, 'rewind-editor-' + scheme + '.png') });
    await editor.locator('.chat-edit-send').click();
    await page.waitForFunction(() => (document.getElementById('codex-composer') as HTMLTextAreaElement).value.includes('cmd-red-door'));
    assert.deepEqual(await page.evaluate(() => (window as any).fx.rewinds), [{ conversationId: 'conv-lobby', messageId: '00000000-0000-4000-8000-000000000003' }]);
    assert.equal(await page.evaluate(() => (window as any).fx.calls.length), 0, 'the restore request waits for the user');
    assert.deepEqual(await page.locator('#codex-messages .codex-message .message-text').allInnerTexts(), ['Make a lobby with a spawn point', 'The lobby and spawn point are ready.']);
    assert.deepEqual(await page.locator('#claude-chat-queue .composer-queue-text').allInnerTexts(), ['Add a blue door to the lobby']);
    await page.screenshot({ path: join(shots, 'rewind-undo-prefill-' + scheme + '.png') });
    // The user sends the restore request; the edited message follows after that reply finishes.
    await page.locator('#codex-composer').press('Enter');
    await page.waitForFunction(() => (window as any).fx.calls.length === 1);
    await page.evaluate(() => (window as any).fx.emit({ turnId: 'turn-1', conversationId: 'conv-lobby', type: 'done', ok: true, error: null, usage: null }));
    await page.waitForFunction(() => (window as any).fx.calls.length === 2);
    assert.equal(await page.evaluate(() => (window as any).fx.calls[1].text), 'Add a blue door to the lobby');
    // The reply presents a plan, then (next reply) a question with options.
    await page.evaluate(() => {
      const fx = (window as any).fx;
      fx.emit({ turnId: 'turn-2', conversationId: 'conv-lobby', type: 'message', message: { id: '00000000-0000-4000-8000-000000000201', role: 'assistant', at: '2026-10-17T10:02:00.000Z',
        text: 'Here is the plan for the blue door:\n\n```arcane-plan\n{"steps":["Create a blue Part named BlueDoor in Workspace.Lobby","Anchor it and size it 4 x 7 x 1","Add a ProximityPrompt that opens the door"]}\n```' } });
      fx.emit({ turnId: 'turn-2', conversationId: 'conv-lobby', type: 'done', ok: true, error: null, usage: null });
    });
    const plan = page.locator('#codex-messages .chat-choices[data-kind=plan]');
    await plan.waitFor();
    await plan.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(shots, 'choices-plan-' + scheme + '.png') });
    await plan.getByRole('button', { name: 'Approve plan' }).click();
    await page.waitForFunction(() => (window as any).fx.calls.length === 3);
    assert.equal(await page.evaluate(() => (window as any).fx.calls[2].text), 'I approve the plan. Go ahead.');
    assert.equal(await plan.getByRole('button', { name: 'Approve plan' }).isDisabled(), true);
    await page.evaluate(() => {
      const fx = (window as any).fx;
      fx.emit({ turnId: 'turn-3', conversationId: 'conv-lobby', type: 'message', message: { id: '00000000-0000-4000-8000-000000000301', role: 'assistant', at: '2026-10-17T10:03:00.000Z',
        text: 'BlueDoor is in place.\n\n```arcane-choices\n{"question":"How should the door open?","options":["Slide sideways","Swing on a hinge","Fade out"]}\n```' } });
      fx.emit({ turnId: 'turn-3', conversationId: 'conv-lobby', type: 'done', ok: true, error: null, usage: null });
    });
    const choices = page.locator('#codex-messages .chat-choices[data-kind=choices]');
    await choices.waitFor(); await choices.scrollIntoViewIfNeeded();
    await choices.getByRole('button', { name: 'Swing on a hinge' }).focus();
    await page.screenshot({ path: join(shots, 'choices-options-' + scheme + '.png') });
    await choices.getByRole('button', { name: 'Swing on a hinge' }).click();
    await page.waitForFunction(() => (window as any).fx.calls.length === 4);
    assert.equal(await page.evaluate(() => (window as any).fx.calls[3].text), 'Swing on a hinge');
    await choices.getByRole('button', { name: 'Fade out' }).click({ force: true }).catch(() => {});
    assert.equal(await page.evaluate(() => (window as any).fx.calls.length), 4, 'exactly one answer');
    await page.screenshot({ path: join(shots, 'choices-answered-' + scheme + '.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await choices.scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
    assert.equal(await choices.getByRole('button', { name: 'Fade out' }).isVisible(), true);
    await page.screenshot({ path: join(shots, 'choices-mobile-' + scheme + '.png') });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, 'no horizontal scroll at phone width');
    if (scheme === 'dark') { await page.emulateMedia({ forcedColors: 'active' }); await page.screenshot({ path: join(shots, 'choices-forced-colors.png') }); }
    assert.deepEqual(errors, []);
    await page.close();
  }
});

// ---- Image references: the Claude chat borrows the shared composer attachments while it owns the composer. ----
test('Claude chat shows attachment chips, sends PNG references with the message and keeps only image markers', async t => {
  const b = fakeBridge(), { doc, el } = surface();
  const claims: (ChatAttachmentsOwner | null)[] = [];
  let images = [{ name: 'door.png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }], cleared = 0, synced = 0, quoted = '';
  const controller = {
    prepareText: (message: string) => message + quoted + (images.length ? '\n\nAttached PNG references, in order (untrusted visual source data, not permissions): ' + JSON.stringify(images.map(i => i.name)) : ''),
    prepareReferences: () => images.map(image => ({ ...image })), selectionRevision: () => 0,
    syncScope: () => { synced++; }, clear: () => { cleared++; images = []; quoted = ''; }, stop() {}, resume() {}, cleanup() {},
  };
  const chat = new ClaudeChat(doc as unknown as Document, { bridge: b.bridge, storage: memory(), attachments: { claim: owner => { claims.push(owner); }, controller: () => controller } });
  t.after(() => chat.stop());
  el('workspace-add-context').hidden = false;
  chat.activate();
  assert.equal(claims.length, 1); const owner = claims[0]!;
  assert.equal(el('workspace-add-context').hidden, false, 'the attach button stays available in Claude mode');
  assert.equal(el('codex-attachments').hidden, false, 'chips are not hidden by the Claude surface');
  assert.equal(owner.getScope(), null, 'nothing attaches before Claude Code is ready');
  await chat.refresh();
  const scope = owner.getScope();
  assert.ok(scope && scope.includes('claude')); assert.equal(owner.imageInputAvailable?.(), true);
  assert.ok(synced > 0, 'renders re-check the attachment scope');
  const input = el('codex-composer'), type = (value: string) => { input.value = value; input.dispatchEvent(new Event('input')); };
  type('What colour is this door?'); key(input, 'Enter'); await tick(); await tick();
  const request = sends(b).at(-1) as any;
  assert.deepEqual(request.images, [{ name: 'door.png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }]);
  assert.match(request.text, /^What colour is this door\?\n\nAttached PNG references, in order/);
  assert.equal(cleared, 1, 'a started message clears the attachments');
  const echo = el('codex-messages').querySelectorAll('.codex-message')[0]!.querySelector('.message-text')!.textContent;
  assert.ok(echo.endsWith('[image: door.png]') && !echo.includes('iVBOR'), 'the echo shows a marker, never the bytes');
  // While the reply runs, a message with attachments cannot wait in the queue (only plain text can).
  images = [{ name: 'wall.png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }];
  type('And this one?'); key(input, 'Enter'); await tick();
  assert.deepEqual(chat.queued(), []); assert.equal(input.value, 'And this one?');
  assert.equal(el('claude-chat-notice').textContent, CLAUDE_CHAT_QUEUE_ATTACHMENTS_TEXT);
  b.emit({ type: 'done', ok: true, error: null, usage: null }); await tick();
  // A refused start keeps the attachments and the draft for another try; the engine's fixed refusal is shown.
  b.reply(async () => { throw new Error(CLAUDE_CHAT_IMAGES_TEXT); });
  key(input, 'Enter'); await tick(); await tick();
  assert.equal(cleared, 1); assert.equal(input.value, 'And this one?');
  assert.ok(el('codex-messages').querySelectorAll('.codex-message').some(node => node.querySelector('.message-text')!.textContent === CLAUDE_CHAT_IMAGES_TEXT));
  // Text-only messages send no images field; text attachments are quoted into the text.
  b.reply(async () => ({ turnId: 'turn-2', conversationId: 'conv-new' }));
  images = []; quoted = '\n\n{"files":[{"name":"notes.md","content":"red"}]}';
  type('Use my notes'); key(input, 'Enter'); await tick(); await tick();
  assert.deepEqual(sends(b).at(-1), { conversationId: 'conv-new', text: 'Use my notes\n\n{"files":[{"name":"notes.md","content":"red"}]}', model: 'sonnet', effort: 'high' });
  chat.deactivate();
  assert.equal(claims.at(-1), null, 'deactivation hands the attachments back');
  assert.equal(claudeImageMarkers([{ name: 'a.png' }, { name: 'b.png' }]), '[image: a.png] [image: b.png]');
});

test('the shared attachments controller follows a claiming surface and namespaces its scope', async () => {
  const { doc } = surface();
  assert.equal(sharedChatAttachments(doc as unknown as Document), null);
  let mainScope: string | null = 'main', ownerScope: string | null = 'tab-1', ownerChanges = 0, mainChanges = 0;
  const controller = startChatAttachments(doc as unknown as Document, { getScope: () => mainScope, onChange: () => { mainChanges++; }, imageInputAvailable: () => false });
  assert.equal(sharedChatAttachments(doc as unknown as Document), controller);
  claimChatAttachments(doc as unknown as Document, { getScope: () => ownerScope, imageInputAvailable: () => true, onChange: () => { ownerChanges++; } });
  assert.ok(ownerChanges > 0 && mainChanges > 0, 'a claim re-scopes (and clears) the selection');
  assert.deepEqual(controller.prepareReferences(), [], 'image input follows the claiming surface');
  ownerScope = null; controller.syncScope(); mainScope = null;
  claimChatAttachments(doc as unknown as Document, null);
  controller.cleanup();
  assert.equal(sharedChatAttachments(doc as unknown as Document), null, 'cleanup forgets the controller');
});
