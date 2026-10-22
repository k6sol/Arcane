/// <reference lib="dom" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { ClaudeChat, usageLimitNoticeText } from '../../apps/desktop/src/claude-chat.js';
import { CodexChat, CodexChatApi, COMPOSER_GUIDE_ID, groupToolCards, installComposerCommands, turnReplyUsage, type ChatMessage, type ChatState } from '../../apps/desktop/src/codex-chat.js';
import { codexReplyUsageView } from '../../apps/desktop/src/task-usage-ui.js';

// Parity: the same Arcane tool sequence rendered by the Claude chat and the ChatGPT chat produces the same transcript
// structure (tool lines, grouped cards, change card, reply usage line) and the same usage-limit notice wording.
// In-memory DOM and bridge/API doubles only: no Electron, CLI, network, Studio or inference.
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
class Element extends EventTarget {
  tagName: string; id = ''; className = ''; type = ''; title = ''; value = ''; hidden = false; disabled = false; open = false; checked = false;
  tabIndex = 0; max = ''; scrollTop = 0; scrollHeight = 0; clientHeight = 0; children: Element[] = []; parent: Element | null = null;
  dataset: Record<string, string> = {}; style = { setProperty: (_name: string, _value: string) => {} };
  private content = ''; private attributes = new Map<string, string>();
  constructor(tag: string, readonly ownerDocument: DocumentFixture) { super(); this.tagName = tag.toUpperCase(); }
  get classList() { return { contains: (name: string) => this.className.split(/\s+/).includes(name) }; }
  get textContent(): string { return this.content + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.content = String(value); this.children = []; }
  set innerHTML(_value: string) { throw Error('innerHTML is forbidden'); }
  private detach(child: Element) { const parent = child.parent; if (parent) { const at = parent.children.indexOf(child); if (at >= 0) parent.children.splice(at, 1); } }
  append(...children: Element[]) { for (const child of children) { this.detach(child); child.parent = this; this.children.push(child); this.ownerDocument.register(child); } this.scrollHeight += 100 * children.length; }
  insertBefore(child: Element, before: Element | null) { this.detach(child); child.parent = this; const at = before ? this.children.indexOf(before) : -1; if (at < 0) this.children.push(child); else this.children.splice(at, 0, child); return child; }
  remove() { this.detach(this); this.parent = null; }
  replaceChildren(...children: Element[]) { this.content = ''; this.children = []; this.append(...children); }
  setAttribute(name: string, value: string) { this.attributes.set(name, String(value)); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string) { this.attributes.delete(name); }
  prepend(child: Element) { this.append(child); this.children.unshift(this.children.pop()!); }
  replaceWith(next: Element) { const parent = this.parent!; next.parent = parent; parent.children[parent.children.indexOf(this)] = next; this.ownerDocument.register(next); }
  after() {} focus() {} close() { this.open = false; } showModal() { this.open = true; }
  click() { this.dispatchEvent(new Event('click', { cancelable: true })); }
  contains(node: unknown): boolean { return node === this || this.children.some(child => child.contains(node)); }
  all(): Element[] { return this.children.flatMap(child => [child, ...child.all()]); }
  matches(selector: string): boolean {
    const parts = selector.trim().split(/\s*>\s*|\s+/); let node: Element | null = this;
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
  if (selector.startsWith('.')) return selector.slice(1).split('.').every(name => node.className.split(/\s+/).includes(name));
  if (selector.startsWith('#')) return node.id === selector.slice(1);
  const attribute = /^\[([a-z-]+)=([^\]]+)\]$/.exec(selector); if (attribute) return node.getAttribute(attribute[1]!) === attribute[2];
  return node.tagName === selector.toUpperCase();
}
class DocumentFixture extends EventTarget {
  activeElement: Element | null = null; hidden = false; nodes = new Map<string, Element>();
  constructor(readonly auto: boolean, readonly defaultView: EventTarget | null) { super(); }
  createElement(tag: string) { return new Element(tag, this); }
  createElementNS(_ns: string, tag: string) { return new Element(tag, this); }
  register(node: Element) { if (node.id) this.nodes.set(node.id, node); for (const child of node.children) this.register(child); }
  getElementById(id: string) {
    let node = this.nodes.get(id) ?? null;
    if (!node && this.auto) { node = new Element(id === 'codex-composer' ? 'textarea' : 'div', this); node.id = id; this.nodes.set(id, node); }
    return node;
  }
}

// The shared sequence: three parts created in one folder (one grouped card), a script edit and a failed update.
const ref = (...segments: string[]) => ({ instanceId: 'i-' + segments.join('-'), sessionId: 's', root: segments[0], pathSegments: segments.slice(1), className: 'Folder' });
const receipt = (commandId: string, method: string, args: Record<string, unknown>, state = 'succeeded') =>
  JSON.stringify({ commandId, requestId: 'r', sessionId: 's', state, terminal: true, ambiguous: false, wait: 'terminal', command: { id: commandId, method, args, state, result: null } });
const forest = ref('Workspace', 'Forest');
const SEQUENCE = [
  { id: 't1', name: 'scene_create', method: 'scene.create', args: { sessionId: 's', parent: forest, className: 'Part', name: 'Tree1' }, state: 'succeeded' },
  { id: 't2', name: 'scene_create', method: 'scene.create', args: { sessionId: 's', parent: forest, className: 'Part', name: 'Tree2' }, state: 'succeeded' },
  { id: 't3', name: 'scene_create', method: 'scene.create', args: { sessionId: 's', parent: forest, className: 'Part', name: 'Tree3' }, state: 'succeeded' },
  { id: 't4', name: 'script_update', method: 'script.update', args: { sessionId: 's', ref: ref('ServerScriptService', 'Spawner'), expectedSource: 'a', source: 'b' }, state: 'succeeded' },
  { id: 't5', name: 'scene_update', method: 'scene.update', args: { sessionId: 's', ref: ref('Workspace', 'Door'), expected: {}, properties: { Color: {} } }, state: 'failed' },
] as const;
const REPLY = 'Built the forest and the spawner.', TOKENS = { input: 12000, cached: 0, output: 800 };

/** Comparable transcript structure: one row per top-level child, with grouped cards, change cards and usage lines. */
function structure(container: Element): unknown[] {
  const tool = (article: Element) => (article.dataset.toolState ?? '') + ' ' + article.querySelector('.tool-activity-text')!.textContent;
  // A usage line reads 'N tokens · ~$x'; the comparison keeps the token count and whether a cost is shown.
  const tokens = (text: string) => text.replace(/\s*·\s*~?[^·]*$/, ''), usage = (node: Element) => { const text = node.querySelector('.reply-usage')?.textContent; return text === undefined ? null : tokens(text); };
  return container.children.map(node => {
    if (node.classList.contains('tool-group')) return { group: node.querySelector('.tool-group-text')!.textContent, count: node.querySelector('.tool-group-count')!.textContent,
      state: node.dataset.toolState, items: node.querySelector('.tool-group-items')!.children.map(tool) };
    if (node.classList.contains('chat-change-card')) return { change: node.querySelector('.chat-change-summary')!.textContent, rows: node.querySelectorAll('.chat-change-text').map(row => row.textContent) };
    if (node.classList.contains('message-usage')) return { usage: tokens(node.querySelector('.reply-usage')?.textContent ?? '') };
    if (node.classList.contains('tool')) return { tool: tool(node) };
    if (node.classList.contains('human')) return { human: node.querySelector('.message-text')?.textContent ?? '' };
    if (node.classList.contains('codex')) return { reply: node.querySelector('.message-text')?.textContent ?? '', usage: usage(node), costed: /·\s*~?\S+$/.test(node.querySelector('.reply-usage')?.textContent ?? '') };
    return { other: node.className };
  });
}

async function claudeTranscript(t: test.TestContext): Promise<Element> {
  const doc = new DocumentFixture(false, null);
  const make = (tag: string, id: string, className = '', ...children: Element[]) => { const node = doc.createElement(tag); node.id = id; node.className = className; node.append(...children); return node; };
  const composer = make('textarea', 'codex-composer'), submit = make('button', 'codex-submit'); submit.type = 'submit';
  const root = make('main', 'root', '', make('div', 'claude-chat-tabs'), make('details', 'claude-saved-chats'), make('button', 'workspace-new-chat'), make('span', 'claude-chat-status'),
    make('p', 'claude-chat-notice'), make('div', 'codex-messages', 'codex-messages'),
    make('form', 'codex-compose', 'composer', composer, make('div', '', 'composer-controls', make('button', 'codex-model-trigger', '', make('span', 'codex-model-label'), make('span', 'codex-effort-label')), submit)),
    make('div', 'codex-model-popover', '', make('div', 'codex-model-options')));
  doc.register(root);
  let listener: ((event: unknown) => void) | null = null;
  const bridge = Object.freeze({ version: 1,
    status: async () => ({ installed: true, signedIn: true, cliVersion: '2.1.177', models: ['sonnet'], efforts: ['low'], defaultModel: 'sonnet', message: null, resolved: { sonnet: 'claude-sonnet-5-5' } }),
    list: async () => ({ conversations: [] }), history: async (id: string) => ({ conversationId: id, messages: [] }),
    send: async () => ({ turnId: 'turn-1', conversationId: 'conv-1' }), stop: async () => true, remove: async () => true,
    onEvent: (fn: (event: unknown) => void) => { listener = fn; return () => { listener = null; }; } });
  const data = new Map<string, string>();
  const chat = new ClaudeChat(doc as unknown as Document, { bridge, storage: { getItem: k => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } } });
  chat.activate(); t.after(() => chat.stop()); await chat.refresh();
  composer.value = 'Plant a forest'; composer.dispatchEvent(new Event('input'));
  const enter = new Event('keydown', { cancelable: true }); Object.defineProperties(enter, { key: { value: 'Enter' }, shiftKey: { value: false }, isComposing: { value: false } });
  composer.dispatchEvent(enter); await tick();
  const emit = (event: Record<string, unknown>) => listener!({ conversationId: 'conv-1', turnId: 'turn-1', ...event });
  for (const step of SEQUENCE) {
    emit({ type: 'tool', message: { id: step.id, role: 'tool', text: step.name, at: '', tool: { name: step.name, status: 'started', input: JSON.stringify(step.args) } } });
    emit({ type: 'tool', message: { id: step.id, role: 'tool', text: step.name, at: '', tool: { name: step.name, status: step.state === 'failed' ? 'failed' : 'finished',
      result: receipt('cmd-' + step.id, step.method, step.args, step.state) } } });
  }
  emit({ type: 'message', message: { id: 'a1', role: 'assistant', text: REPLY, at: '' } });
  emit({ type: 'done', ok: true, error: null, usage: { inputTokens: TOKENS.input, outputTokens: TOKENS.output, costUsd: null } }); await tick();
  return doc.getElementById('codex-messages')!;
}

async function codexTranscript(t: test.TestContext): Promise<Element> {
  const doc = new DocumentFixture(true, new EventTarget()), threadId = 'thread-1', turnId = 'turn-1';
  const usage = { inputTokens: TOKENS.input, cachedInputTokens: TOKENS.cached, outputTokens: TOKENS.output, reasoningOutputTokens: 0, totalTokens: TOKENS.input + TOKENS.output };
  const selection = { model: 'gpt-5.1', effort: 'low' };
  const state = { provider: 'codex', use: 'personal-local', projectPath: resolve('.'), connecting: false, closing: false, busy: false, actions: [], lastSnapshot: null,
    nativeTools: { configured: true, verified: false }, snapshot: {
      connectionId: randomUUID(), provenance: 'spawned-node-fixture', connected: true, ready: true, account: { auth: 'subscription', plan: 'fixture', requiresOpenaiAuth: true },
      models: [{ model: 'gpt-5.1', id: 'gpt-5.1', displayName: 'GPT-5.1', efforts: ['low'], defaultEffort: 'low', entitlement: 'unverified' }], selection,
      thread: { threadId, sessionId: 'session-1', selection, configured: true, writeGranted: true, turnId, turnStatus: 'completed' }, operations: [], approvals: [], droppedEvents: 0, failureCode: null,
      lastEventSeq: 3, events: [
        { seq: 1, type: 'delta', threadId, turnId, itemId: 'reply', text: REPLY },
        { seq: 2, type: 'usage', threadId, turnId, usage: { source: 'thread/tokenUsage/updated', continuity: 'reported', total: usage, last: usage, modelContextWindow: null } },
        { seq: 3, type: 'turn', threadId, turnId, status: 'completed' }] } } as unknown as ChatState;
  const chat = new CodexChat(doc as unknown as Document, new CodexChatApi('a'.repeat(64), async () => Response.json({ state })));
  await chat.start(); t.after(() => chat.stop());
  chat.setReplyUsage(input => codexReplyUsageView(input, { preferences: { show: true, currency: 'USD', rate: null }, locale: 'en-US' }));
  // Saved history keeps each tool call's result text; the human message and tool items share the reply's turn.
  const internals = chat as unknown as { transcript: { messages: ChatMessage[] }; messageSignature: string; render(): void };
  const row = (itemId: string, role: ChatMessage['role'], text: string): ChatMessage => ({ key: threadId + '\0' + turnId + '\0' + itemId, role, threadId, scope: threadId + ' · ' + turnId + ' · ' + itemId, text });
  const reply = internals.transcript.messages.find(message => message.role === 'codex')!;
  internals.transcript.messages.splice(0, internals.transcript.messages.length, row('human', 'human', 'Plant a forest'),
    ...SEQUENCE.map(step => row(step.id, 'tool', receipt('cmd-' + step.id, step.method, step.args, step.state))), reply);
  internals.messageSignature = ''; internals.render();
  return doc.getElementById('codex-messages')!;
}

test('parity: one tool sequence renders the same tool lines, grouped card, change card and usage line for Claude and ChatGPT', async t => {
  const claude = await claudeTranscript(t), codex = await codexTranscript(t);
  groupToolCards(claude as unknown as HTMLElement); groupToolCards(codex as unknown as HTMLElement);
  const expected = [
    { human: 'Plant a forest' },
    { group: 'Created 3 parts in Workspace.Forest', count: '3 steps', state: 'finished', items: ['finished Creating Part "Tree1" in Workspace.Forest', 'finished Creating Part "Tree2" in Workspace.Forest', 'finished Creating Part "Tree3" in Workspace.Forest'] },
    { tool: 'finished Updating script ServerScriptService.Spawner' },
    { tool: 'failed Updating Workspace.Door (Color)' },
    { reply: REPLY, usage: '12.8k tokens', costed: true },
    { change: '3 created · 1 script edited', rows: ['Created Part "Tree1" in Workspace.Forest', 'Created Part "Tree2" in Workspace.Forest', 'Created Part "Tree3" in Workspace.Forest', 'Edited script ServerScriptService.Spawner'] },
  ];
  const claudeRows = structure(claude), codexRows = structure(codex);
  assert.deepEqual(codexRows, claudeRows, 'both providers render the same transcript structure');
  assert.deepEqual(claudeRows.map(row => Object.keys(row as object)[0]), expected.map(row => Object.keys(row)[0]));
  assert.deepEqual(claudeRows, expected);
});

test('parity: ChatGPT reply usage counts only the turn\'s own tokens and the usage-limit notice reads the same for both providers', () => {
  assert.deepEqual(turnReplyUsage({ baseline: { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 50 }, latest: { inputTokens: 4000, cachedInputTokens: 900, outputTokens: 450 } }, 'gpt-5.1'),
    { model: 'gpt-5.1', tokens: 3400, inputTokens: 3000, cachedInputTokens: 700, outputTokens: 400 });
  assert.equal(turnReplyUsage({ baseline: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 10 }, latest: { inputTokens: 5, cachedInputTokens: 0, outputTokens: 10 } }, null), null, 'a reset is not a negative reply');
  const display = { preferences: { show: false, currency: 'USD', rate: null }, locale: 'en-US' };
  assert.equal(codexReplyUsageView({ model: 'gpt-5.1', tokens: 3400, inputTokens: 3000, cachedInputTokens: 700, outputTokens: 400 }, display).text, '3.4k tokens', 'hidden costs leave tokens only');
  const at = Date.UTC(2026, 9, 18, 12), soon = Math.floor(at / 1000) + 3600;
  for (const limit of [{ resetsAt: null }, { resetsAt: soon }, { resetsAt: Math.floor(at / 1000) - 60 }])
    assert.equal(usageLimitNoticeText('codex', limit, at).replace('ChatGPT', 'X'), usageLimitNoticeText('claude', limit, at).replace('Claude', 'X'));
});

test('/help shows the shared tips and opens the Settings guide through the shell\'s settings request', () => {
  const doc = new DocumentFixture(false, null);
  const form = doc.createElement('form'); form.id = 'codex-compose'; const input = doc.createElement('textarea'); input.id = 'codex-composer'; form.append(input);
  const guide = doc.createElement('section'); guide.id = COMPOSER_GUIDE_ID; const root = doc.createElement('main'); root.append(form, guide); doc.register(root);
  installComposerCommands(doc as unknown as Document);
  const requests: unknown[] = []; doc.addEventListener('workspace:settingsrequest', event => requests.push((event as CustomEvent).detail));
  input.value = '/help'; input.dispatchEvent(new Event('input'));
  const enter = new Event('keydown', { cancelable: true }); Object.defineProperties(enter, { key: { value: 'Enter' }, shiftKey: { value: false }, isComposing: { value: false } });
  input.dispatchEvent(enter);
  const menu = doc.getElementById('composer-command-menu')!;
  assert.equal(menu.hidden, false); assert.match(menu.textContent, /style, scale and mood[\s\S]*Playtest/);
  const button = menu.querySelector('button')!; assert.equal(button.textContent, 'Open the full guide');
  button.click();
  assert.deepEqual(requests, [{ target: 'settings-guide' }]); assert.equal(menu.hidden, true);
});
