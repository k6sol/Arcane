/// <reference lib="dom" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ArcaneChat, ARCANE_CHAT_EMPTY_TEXT, ARCANE_CHAT_NO_CREDITS_TEXT, ARCANE_CHAT_TABS_KEY, arcaneBalanceText, arcaneModelPriceText, formatArcaneUsage, formatCredits,
  readArcaneChatBridge, readArcaneChatStatus,
} from '../../apps/desktop/src/arcane-chat.js';
import { ClaudeChat, CLAUDE_CHAT_TABS_KEY, linkChatProviders, usageLimitNoticeText } from '../../apps/desktop/src/claude-chat.js';

// In-memory DOM and preload-bridge doubles only (the shared chat surface ids from studio.html), plus one headless Edge
// layout check with the production HTML/CSS. No Electron, gateway, model API, network or inference.
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };
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
  defaultView: unknown = null; activeElement: Element | null = null; nodes = new Map<string, Element>();
  createElement(tag: string) { return new Element(tag, this); }
  createElementNS(_ns: string, tag: string) { return new Element(tag, this); }
  register(node: Element) { if (node.id) this.nodes.set(node.id, node); for (const child of node.children) this.register(child); }
  getElementById(id: string) { return this.nodes.get(id) ?? null; }
}
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
  return { doc, el };
}
function memory() { const data = new Map<string, string>(); return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } }; }
const click = (target: Element) => target.dispatchEvent(new Event('click', { cancelable: true }));
function key(target: Element, value: string) {
  const event = new Event('keydown', { cancelable: true });
  Object.defineProperties(event, { key: { value }, shiftKey: { value: false }, isComposing: { value: false } });
  target.dispatchEvent(event); return event;
}

const claudeStatus = { installed: true, signedIn: true, cliVersion: '2.1.177', models: ['opus', 'sonnet'], efforts: ['low', 'medium', 'high'], defaultModel: 'sonnet', message: null,
  resolved: { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5' } };
const ready = { available: true, state: 'ready', efforts: ['standard'], defaultModel: 'arcane-default', message: null, balance: { credits: 1200, actionsRemaining: 40, plan: 'Pro' },
  models: [{ id: 'arcane-default', label: 'Arcane default', pricing: { inputPerMTok: 360, outputPerMTok: 1800 } }, { id: 'vendor/fast:1', label: 'Fast', pricing: null }] };
const disabled = { available: false, state: 'disabled', efforts: ['standard'], defaultModel: null, message: 'Arcane Credits are not connected yet.', balance: null, models: [] };
function fakeBridge(initial: unknown, conversation = 'conv-arcane') {
  const calls: unknown[][] = []; let listener: ((event: unknown) => void) | null = null; let status = initial;
  const bridge = Object.freeze({ version: 1,
    status: async () => { calls.push(['status']); return status; },
    list: async () => { calls.push(['list']); return { conversations: [] }; },
    history: async (id: string) => ({ conversationId: id, messages: [] }),
    send: async (request: unknown) => { calls.push(['send', request]); return { turnId: 'turn-a', conversationId: conversation, messageId: '6f1c1f2e-0000-4000-8000-000000000001' }; },
    stop: async () => true, remove: async () => true,
    onEvent: (fn: (event: unknown) => void) => { listener = fn; return () => { listener = null; }; } });
  return { bridge, calls, setStatus: (next: unknown) => { status = next; }, emit: (event: Record<string, unknown>) => listener?.({ turnId: 'turn-a', conversationId: conversation, ...event }) };
}
const chatgpt = { provider: 'codex' as const, label: 'ChatGPT', available: true, hint: 'Connect to choose a model', models: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' }] };
type Cross = import('../../apps/desktop/src/codex-chat.js').CrossProviderModels;
async function linked(initial: 'codex' | 'claude' | 'arcane', arcaneStatus: unknown = ready) {
  const { doc, el } = surface(), storage = memory();
  const claudeBridge = fakeBridge(claudeStatus, 'conv-claude'), arcaneBridge = fakeBridge(arcaneStatus);
  const claude = new ClaudeChat(doc as unknown as Document, { bridge: claudeBridge.bridge, storage });
  const arcane = new ArcaneChat(doc as unknown as Document, { bridge: arcaneBridge.bridge, storage });
  const calls: unknown[][] = []; let source: Cross | null = null, yielded = false, codexDraft = '';
  const input = el('codex-composer');
  const codex = {
    yieldSurface(value: boolean) { if (value === yielded) return; calls.push(['yield', value]); if (value) codexDraft = input.value; else input.value = codexDraft; yielded = value; },
    setCrossProviderModels(value: Cross | null) { source = value; }, crossProviderChanged() { calls.push(['changed']); },
    modelGroup: () => chatgpt, currentEffort: () => 'low',
    takeComposerDraft() { const value = input.value; input.value = ''; calls.push(['take', value]); return value; },
    receiveHandoff(handoff: unknown) { calls.push(['receive', handoff]); },
    usageLimit: () => null,
  };
  let current: 'codex' | 'claude' | 'arcane' = initial; const listeners = new Set<() => void>(); const requests: string[] = [];
  const provider = { chatSurface: () => current, subscribeChatSurface: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    requestProvider: (next: string) => { requests.push(next); return true; } };
  const link = linkChatProviders({ codex, claude, provider });
  link.setArcane(arcane);
  await arcane.loadModels(); await settle();
  const setSurface = (next: typeof current) => { current = next; for (const fn of [...listeners]) fn(); };
  const item = (node: Element): string => node.className === 'model-group-heading' ? '# ' + node.textContent : node.className.includes('model-column-note') ? '~ ' + node.textContent
    : node.className.includes('model-column-empty') ? '(' + node.textContent + ')' : node.textContent + (node.disabled ? ' [disabled]' : '');
  const layout = () => el('codex-model-options').children.flatMap(node => node.className === 'model-column' ? node.children.map(item) : [item(node)]);
  const columns = () => el('codex-model-options').children.filter(node => node.className === 'model-column').map(node => node.dataset.pickerGroup);
  const row = (id: string) => el('codex-model-options').querySelectorAll('.picker-model-option').find(node => node.dataset.pickerModel === id)!;
  return { doc, el, claude, arcane, claudeBridge, arcaneBridge, link, calls, requests, setSurface, layout, columns, row, input, codexSource: () => source!, storage };
}

test('status, bridge and copy helpers are strict and readable', () => {
  assert.equal(readArcaneChatBridge(null), null);
  assert.equal(readArcaneChatBridge({ arcaneDesktop: { arcaneChat: { version: 2 } } }), null);
  assert.ok(readArcaneChatBridge({ arcaneDesktop: { arcaneChat: fakeBridge(ready).bridge } }));
  assert.equal(readArcaneChatBridge({ arcaneDesktop: { claudeChat: fakeBridge(ready).bridge } }), null, 'only the Arcane bridge');
  const status = readArcaneChatStatus({ ...ready, models: [...ready.models, { id: '../x', label: 'bad' }, { id: 'ok', label: '' }, { id: 'arcane-default', label: 'dup' }], balance: { credits: -1 } });
  assert.deepEqual(status.models.map(model => model.id), ['arcane-default', 'vendor/fast:1']);
  assert.equal(status.balance, null);
  assert.throws(() => readArcaneChatStatus({ available: true, state: 'odd', models: [] }));
  assert.equal(formatCredits(1), '1 credit'); assert.equal(formatCredits(1200), '1,200 credits');
  assert.equal(arcaneModelPriceText({ inputPerMTok: 360, outputPerMTok: 1800 }), '360 in · 1.8k out per 1M tokens');
  assert.equal(arcaneModelPriceText(null), null);
  assert.equal(arcaneBalanceText({ credits: 1200, actionsRemaining: 40, plan: 'Pro' }), '1,200 credits left · Pro (40 actions)');
  assert.equal(arcaneBalanceText({ credits: 5, actionsRemaining: null, plan: null }), '5 credits left');
  assert.equal(formatArcaneUsage({ inputTokens: 250, outputTokens: 20, costUsd: null, credits: 3 }), 'Done · 270 tokens · 3 credits');
  assert.equal(formatArcaneUsage(null), null);
  assert.equal(usageLimitNoticeText('arcane', { resetsAt: null }), 'You\u2019re out of Arcane Credits.');
});

test('not configured: no Arcane column anywhere, the lists stay ChatGPT and Claude', async t => {
  const f = await linked('claude', disabled); t.after(() => { f.claude.stop(); f.arcane.stop(); });
  assert.equal(f.arcane.modelGroup(), null); assert.equal(f.arcane.usable(), false);
  click(f.el('codex-model-trigger')); click(f.el('codex-picker-current-model'));
  assert.deepEqual(f.columns(), ['codex', 'claude']); assert.equal(f.el('codex-model-options').dataset.columns, undefined);
  assert.deepEqual(f.codexSource().groups!().map(group => group.provider), ['claude']);
});

test('connected: a third Arcane column with prices and the balance; choosing an Arcane model switches provider explicitly with the draft', async t => {
  const f = await linked('claude'); t.after(() => { f.claude.stop(); f.arcane.stop(); });
  assert.equal(f.arcane.usable(), true);
  f.input.value = 'make the lobby brighter'; f.input.dispatchEvent(new Event('input'));
  click(f.el('codex-model-trigger')); click(f.el('codex-picker-current-model'));
  assert.equal(f.el('codex-model-options').dataset.layout, 'columns'); assert.equal(f.el('codex-model-options').dataset.columns, '3');
  assert.deepEqual(f.columns(), ['codex', 'claude', 'arcane'], 'fixed order: ChatGPT, Claude, Arcane');
  assert.deepEqual(f.layout(), ['# ChatGPT', 'GPT-6.1-Sol', '# Claude', 'Opus 5.5', 'Sonnet 5.5',
    '# Arcane', '~ 1,200 credits left · Pro (40 actions)', 'Arcane default360 in · 1.8k out per 1M tokens', 'Fast']);
  const logo = f.el('codex-model-options').children[2]!.children[0]!.children[0]!;
  assert.equal(logo.getAttribute('data-provider'), 'arcane'); assert.match(logo.children[0]!.getAttribute('d')!, /^M12 1\.5/);
  click(f.row('arcane-default'));
  assert.deepEqual(f.requests, ['arcane']); assert.equal(f.claude.isActive(), true, 'nothing switches until provider setup reports Arcane');
  f.setSurface('arcane'); await settle();
  assert.equal(f.claude.isActive(), false); assert.equal(f.arcane.isActive(), true);
  assert.equal(f.input.value, 'make the lobby brighter', 'the draft follows the switch');
  assert.equal(f.el('codex-model-label').textContent, 'Arcane default');
  assert.equal(f.el('claude-chat-tabs').querySelectorAll('[role=tab]')[0]!.dataset.provider, 'arcane', 'Arcane tabs lead with the Arcane mark');
  assert.equal(f.el('claude-chat-status').textContent, '1,200 credits left · Pro (40 actions)');
  // From the Arcane surface the other two providers are columns too; choosing Claude goes back explicitly.
  click(f.el('codex-model-trigger')); click(f.el('codex-picker-current-model'));
  assert.deepEqual(f.columns(), ['codex', 'claude', 'arcane']);
  assert.equal(f.row('arcane-default').dataset.pickerProvider, undefined, 'own rows are the active provider');
  click(f.row('sonnet')); assert.deepEqual(f.requests, ['arcane', 'claude']);
  f.setSurface('claude'); await settle();
  assert.equal(f.arcane.isActive(), false); assert.equal(f.claude.isActive(), true);
  assert.ok(f.storage.data.has(ARCANE_CHAT_TABS_KEY) && f.storage.data.has(CLAUDE_CHAT_TABS_KEY), 'each chat remembers its own tabs under its own key');
});

test('Arcane surface: sends text with the fixed level, renders the reply, tools and credits, then re-reads the balance', async t => {
  const f = await linked('arcane'); t.after(() => { f.claude.stop(); f.arcane.stop(); });
  assert.equal(f.arcane.isActive(), true);
  assert.equal(f.el('codex-messages').querySelector('.empty')?.textContent, ARCANE_CHAT_EMPTY_TEXT);
  f.input.value = 'Add a spawn pad'; f.input.dispatchEvent(new Event('input'));
  key(f.input, 'Enter'); await settle();
  assert.deepEqual(f.arcaneBridge.calls.filter(call => call[0] === 'send').map(call => call[1]), [{ conversationId: null, text: 'Add a spawn pad', model: 'arcane-default', effort: 'standard' }]);
  assert.deepEqual(f.claudeBridge.calls.filter(call => call[0] === 'send'), [], 'nothing reaches the Claude bridge');
  f.arcaneBridge.emit({ type: 'delta', text: 'Placing ' });
  f.arcaneBridge.emit({ type: 'message', message: { id: 'a1', role: 'assistant', text: 'Placing a pad.', at: '2026-10-18T12:00:00.000Z' } });
  f.arcaneBridge.emit({ type: 'tool', message: { id: 't1', role: 'tool', text: 'scene_children', at: '2026-10-18T12:00:01.000Z', tool: { name: 'scene_children', status: 'started' } } });
  f.arcaneBridge.emit({ type: 'tool', message: { id: 't1', role: 'tool', text: 'scene_children', at: '2026-10-18T12:00:01.000Z', tool: { name: 'scene_children', status: 'finished' } } });
  const statusReads = f.arcaneBridge.calls.filter(call => call[0] === 'status').length;
  f.arcaneBridge.emit({ type: 'done', ok: true, error: null, usage: { inputTokens: 250, outputTokens: 20, costUsd: null, credits: 3 }, usageLimit: null });
  await settle();
  assert.equal(f.el('claude-chat-notice').textContent, 'Done · 270 tokens · 3 credits');
  const usageLine = f.el('codex-messages').querySelector('.reply-usage')!;
  assert.ok(!/\$/.test(usageLine.textContent), 'no USD estimate for credit replies: ' + usageLine.textContent);
  assert.ok(f.arcaneBridge.calls.filter(call => call[0] === 'status').length > statusReads, 'the balance is read again after a reply');
  assert.deepEqual(f.el('codex-messages').querySelectorAll('.codex-message').map(node => node.getAttribute('data-role')), ['user', 'assistant', 'tool']);
  assert.equal(innerHtmlWrites, 0);
});

test('out of credits: the notice offers Buy credits (Plans & credits), restores the unanswered message and never resends', async t => {
  const f = await linked('arcane'); t.after(() => { f.claude.stop(); f.arcane.stop(); });
  const requests: unknown[] = []; f.doc.addEventListener('workspace:settingsrequest', event => requests.push((event as CustomEvent).detail));
  (f.doc as unknown as { defaultView: unknown }).defaultView = { CustomEvent };
  f.input.value = 'Add a spawn pad'; f.input.dispatchEvent(new Event('input'));
  key(f.input, 'Enter'); await settle();
  f.arcaneBridge.emit({ type: 'done', ok: false, error: ARCANE_CHAT_NO_CREDITS_TEXT, usage: null, usageLimit: { resetsAt: null } });
  await settle();
  const notice = f.el('usage-limit-notice'), action = f.el('usage-limit-action');
  assert.equal(notice.hidden, false); assert.equal(notice.dataset.provider, 'arcane');
  assert.equal(f.el('usage-limit-message').textContent, 'You\u2019re out of Arcane Credits. This message was not answered; your draft stays here.');
  assert.deepEqual([action.textContent, action.hidden, action.disabled], ['Buy credits', false, false]);
  assert.equal(f.input.value, 'Add a spawn pad', 'the unanswered message is back in the composer');
  click(action);
  assert.deepEqual(requests, [{ target: 'settings-plans' }]);
  assert.deepEqual(f.requests, [], 'Buy credits switches nothing');
  assert.equal(f.arcaneBridge.calls.filter(call => call[0] === 'send').length, 1, 'no automatic resend');
  // A finished reply clears it.
  key(f.input, 'Enter'); await settle();
  f.arcaneBridge.emit({ type: 'done', ok: true, error: null, usage: null, usageLimit: null }); await settle();
  assert.equal(notice.hidden, true);
});

test('provider setup: Arcane can be chosen only while available; ChatGPT or Claude choices leave it; the choice is remembered', async t => {
  const { startProviderSetup, ARCANE_SURFACE_KEY } = await import('../../apps/desktop/src/provider-setup.js');
  const ids = ['provider-setup-panel', 'provider-login-gate', 'provider-setup-provider', 'provider-login-start', 'claude-chat-terminal', 'claude-chat-tabs', 'workspace-chat-tabs'];
  const make = () => {
    const doc = new EventTarget() as EventTarget & { getElementById(id: string): unknown; defaultView: unknown };
    const nodes = new Map<string, Element>(ids.map(id => [id, new DocumentFixture().createElement('div')]));
    nodes.get('provider-setup-provider')!.value = 'codex'; nodes.get('claude-chat-tabs')!.hidden = true;
    doc.getElementById = id => nodes.get(id) ?? null;
    return { doc, nodes };
  };
  const stored = new Map<string, string>();
  const storage = { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => { stored.set(k, v); }, removeItem: (k: string) => { stored.delete(k); } };
  const native = Object.freeze({ version: 1, ...Object.fromEntries(['status', 'login', 'install', 'launch'].map(action => [action, async (provider: string) =>
    ({ version: 1, provider, installed: true, auth: 'signed-out', cliVersion: '2.1.177', busy: false, message: null })])) });
  const start = () => {
    const { doc, nodes } = make();
    doc.defaultView = { CustomEvent, location: { protocol: 'http:', origin: 'http://fixture.test' }, localStorage: storage };
    const controller = startProviderSetup(doc as unknown as Document, { nativeBridge: native, chat: {
      providerConnectionStatus: () => ({ connected: false, ready: false, fresh: true, auth: 'signed-out' }), subscribeProviderStateChange: () => () => {} } });
    t.after(() => controller.cleanup());
    return { controller, nodes };
  };
  const { controller, nodes } = start();
  await tick();
  const surfaces: string[] = []; controller.subscribeChatSurface(() => surfaces.push(controller.chatSurface()));
  assert.equal(controller.requestProvider('arcane'), false, 'refused until the Arcane chat reports it is usable');
  assert.equal(controller.chatSurface(), 'codex'); assert.equal(stored.has(ARCANE_SURFACE_KEY), false);
  controller.setArcaneAvailable(true);
  assert.equal(controller.chatSurface(), 'codex', 'availability alone switches nothing');
  assert.equal(controller.requestProvider('arcane'), true);
  assert.equal(controller.chatSurface(), 'arcane'); assert.deepEqual(surfaces, ['arcane']);
  assert.equal(nodes.get('provider-login-gate')!.hidden, true, 'the sign-in gate is not shown over the Arcane chat');
  assert.equal(nodes.get('claude-chat-tabs')!.hidden, false, 'the Arcane chat renders into the shared non-ChatGPT nodes');
  assert.equal(nodes.get('claude-chat-terminal')!.hidden, true, 'no Claude Code terminal button for Arcane');
  assert.equal(stored.get(ARCANE_SURFACE_KEY), '{"version":1,"chosen":true}');
  controller.setArcaneAvailable(false);
  assert.equal(controller.chatSurface(), 'codex', 'disconnecting the account falls back at once');
  controller.setArcaneAvailable(true); assert.equal(controller.chatSurface(), 'arcane', 'the remembered choice returns with availability');
  // A restored preference keeps Arcane; an explicit ChatGPT choice leaves it.
  const again = start(); again.controller.setArcaneAvailable(true);
  assert.equal(again.controller.chatSurface(), 'arcane', 'remembered across reloads');
  assert.equal(controller.requestProvider('codex'), true);
  assert.equal(controller.chatSurface(), 'codex'); assert.equal(stored.has(ARCANE_SURFACE_KEY), false);
});

// ---- Production HTML/CSS in headless Edge: three columns side by side when there is room, stacked when narrow. ----
const browserModule = process.env.ARCANE_UI_BROWSER_MODULE;
test('Edge: the composer model list shows ChatGPT, Claude and Arcane columns, stacking on narrow widths', { skip: !browserModule, timeout: 60000 }, async t => {
  const build = process.env.ARCANE_UI_BUILD_DIR ?? 'dist', shots = resolve(process.env.ARCANE_UI_SCREENSHOT ?? 'runtime/claude-codex-team/claude-audit/arcane-chat/shots');
  await mkdir(shots, { recursive: true });
  const modules = ['codex-chat', 'user-errors', 'chat-tabs', 'codex-history', 'workspace-shell', 'claude-chat', 'claude-preferences', 'arcane-chat', 'task-usage', 'task-usage-ui', 'script-diff'];
  const fixture = `import {ClaudeChat, linkChatProviders} from '/claude-chat.js';
    import {ArcaneChat} from '/arcane-chat.js';
    const f = window.fx = {};
    const bridge = status => Object.freeze({ version: 1, status: async () => status, list: async () => ({ conversations: [] }),
      history: async id => ({ conversationId: id, messages: [] }), send: async () => ({ turnId: 't', conversationId: 'c' }), stop: async () => true, remove: async () => true, onEvent: () => () => {} });
    const claude = new ClaudeChat(document, { bridge: bridge(${JSON.stringify(claudeStatus)}), storage: null });
    const arcane = new ArcaneChat(document, { bridge: bridge(${JSON.stringify(ready)}), storage: null });
    const codex = { yieldSurface() {}, setCrossProviderModels() {}, crossProviderChanged() {}, currentEffort: () => 'low', takeComposerDraft: () => '', receiveHandoff() {},
      modelGroup: () => (${JSON.stringify(chatgpt)}) };
    const provider = { chatSurface: () => 'arcane', subscribeChatSurface: () => () => {}, requestProvider: () => true };
    for (const id of ['codex-notice', 'codex-status', 'workspace-chat-tabs', 'workspace-saved-chats']) { const node = document.getElementById(id); if (node) node.hidden = true; }
    for (const id of ['claude-chat-notice', 'claude-chat-status', 'claude-chat-tabs', 'claude-saved-chats']) { const node = document.getElementById(id); if (node) node.hidden = false; }
    const gate = document.getElementById('provider-login-gate'); if (gate) gate.hidden = true;
    document.getElementById('workspace-stage')?.classList.remove('provider-required');
    const link = linkChatProviders({ codex, claude, provider });
    await claude.loadModels(); await arcane.loadModels(); link.setArcane(arcane); await arcane.refresh();
    f.ready = true;`;
  const server = createServer((request, response) => { void (async () => {
    const url = request.url?.split('?')[0] ?? '';
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
  const open = async (width: number, height: number) => {
    const page = await browser.newPage({ viewport: { width, height } }); page.setDefaultTimeout(8000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:' + (server.address() as { port: number }).port + '/studio');
    await page.waitForFunction(() => (window as any).fx?.ready === true).catch(error => { throw new Error(String(error) + ' page errors: ' + errors.join(' | ')); });
    await page.locator('#codex-model-trigger').click(); await page.locator('#codex-picker-current-model').click();
    await page.waitForFunction(() => document.querySelectorAll('#codex-model-options .model-column').length === 3);
    return page;
  };
  const boxes = (page: import('playwright-core').Page) => page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('#codex-model-options .model-column')).map(column => {
    const box = column.getBoundingClientRect(); return { group: column.dataset.pickerGroup, x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width) };
  }));
  const wide = await open(1280, 860);
  assert.equal(await wide.locator('#codex-model-popover').getAttribute('data-columns'), 'split');
  let geometry = await boxes(wide);
  assert.deepEqual(geometry.map(box => box.group), ['codex', 'claude', 'arcane']);
  assert.ok(geometry[0]!.x < geometry[1]!.x && geometry[1]!.x < geometry[2]!.x && geometry.every(box => box.y === geometry[0]!.y), JSON.stringify(geometry));
  assert.equal(await wide.locator('#codex-model-options [data-picker-group="arcane"] .model-column-note').innerText(), '1,200 credits left · Pro (40 actions)');
  assert.equal(await wide.locator('#codex-model-options [data-picker-model="arcane-default"] .picker-model-detail').innerText(), '360 in · 1.8k out per 1M tokens');
  const popover = (await wide.locator('#codex-model-popover').boundingBox())!;
  assert.ok(popover.x >= 0 && popover.x + popover.width <= 1280, 'inside the viewport');
  await wide.screenshot({ path: join(shots, 'three-columns-wide.png') });
  const narrow = await open(560, 860);
  assert.equal(await narrow.locator('#codex-model-popover').getAttribute('data-columns'), 'stacked');
  geometry = await boxes(narrow);
  assert.ok(geometry[0]!.y < geometry[1]!.y && geometry[1]!.y < geometry[2]!.y && geometry.every(box => box.x === geometry[0]!.x), 'stacked: ' + JSON.stringify(geometry));
  assert.ok(await narrow.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no horizontal page scroll');
  await narrow.screenshot({ path: join(shots, 'three-columns-narrow.png') });
  assert.deepEqual(errors, []);
});
