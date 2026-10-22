/// <reference lib="dom" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { CodexChat, CodexChatApi, CodexTranscript, describeToolActivity, groupToolCards, readCodexState, renderCodexToolArticle, type ChatState } from '../../apps/desktop/src/codex-chat.js';

// Live ChatGPT tool activity: the native item event's bounded tool identity renders the same friendly lines and
// grouped cards as the Claude chat while the turn runs. In-memory DOM and API doubles only.
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

const threadId = 'thread-1', turnId = 'turn-1', forest = { root: 'Workspace', pathSegments: ['Forest'] };
const create = (name: string) => ({ server: 'arcane', tool: 'scene_create', args: { parent: forest, className: 'Part', name } });
const item = (seq: number, itemId: string, status: string, tool?: unknown) => ({ seq, type: 'item', threadId, turnId, itemId, itemType: 'mcpToolCall', status, ...(tool ? { tool } : {}) });
function state(events: unknown[], turnStatus = 'inProgress'): ChatState {
  const selection = { model: 'gpt-5.1', effort: 'low' };
  return { provider: 'codex', use: 'personal-local', projectPath: resolve('.'), connecting: false, closing: false, busy: false, actions: [], lastSnapshot: null,
    nativeTools: { configured: true, verified: false }, snapshot: {
      connectionId: randomUUID(), provenance: 'spawned-node-fixture', connected: true, ready: true, account: { auth: 'subscription', plan: 'fixture', requiresOpenaiAuth: true },
      models: [{ model: 'gpt-5.1', id: 'gpt-5.1', displayName: 'GPT-5.1', efforts: ['low'], defaultEffort: 'low', entitlement: 'unverified' }], selection,
      thread: { threadId, sessionId: 'session-1', selection, configured: true, writeGranted: true, turnId, turnStatus }, operations: [], approvals: [], droppedEvents: 0, failureCode: null,
      lastEventSeq: events.length, events } } as unknown as ChatState;
}
const lines = (container: Element) => container.children.map(node => node.classList.contains('tool-group')
  ? { group: node.querySelector('.tool-group-text')!.textContent, state: node.dataset.toolState, count: node.querySelector('.tool-group-count')!.textContent }
  : { tool: node.querySelector('.tool-activity-text')?.textContent ?? null, state: node.dataset.toolState ?? null });

test('public state accepts only the exact bounded live tool identity', () => {
  assert.doesNotThrow(() => readCodexState(state([item(1, 'a', 'inProgress', create('Tree')), item(2, 'b', 'inProgress', { server: 'other', tool: 'x', args: null })])));
  const bad: unknown[] = [
    { ...create('Tree'), args: { ...create('Tree').args, source: 'print(1)' } },
    { ...create('Tree'), args: { ...create('Tree').args, properties: { Color: 'red' } } },
    { ...create('Tree'), args: { name: 'x'.repeat(101) } },
    { ...create('Tree'), args: {} },
    { ...create('Tree'), extra: true },
    { server: 'other', tool: 'x', args: { name: 'y' } },
    { server: 'arcane', tool: 'bad tool', args: null },
    { ...create('Tree'), args: { parent: { ...forest, instanceId: 'i' } } },
  ];
  for (const tool of bad) assert.throws(() => readCodexState(state([item(1, 'a', 'inProgress', tool)])), String(JSON.stringify(tool)));
  assert.throws(() => readCodexState(state([{ seq: 1, type: 'delta', threadId, turnId, itemId: 'm', text: 'x', tool: create('Tree') }])));
});

test('live transcript lines use the same friendly mapping as the Claude chat, with grouped live counts', () => {
  const doc = new DocumentFixture(false, null), container = doc.createElement('div'), transcript = new CodexTranscript();
  const render = () => { container.replaceChildren(...transcript.messages.map(message => renderCodexToolArticle(doc as unknown as Document, message).article as unknown as Element));
    groupToolCards(container as unknown as HTMLElement); return lines(container); };
  const snapshot = (events: unknown[]) => state(events).snapshot!;
  transcript.consume(snapshot([item(1, 't1', 'inProgress', create('Tree1'))]));
  assert.deepEqual(render(), [{ tool: 'Creating Part "Tree1" in Workspace.Forest…', state: 'started' }]);
  const events = [item(1, 't1', 'inProgress', create('Tree1')), item(2, 't1', 'completed', create('Tree1')), item(3, 't2', 'inProgress', create('Tree2')),
    item(4, 't3', 'inProgress', create('Tree3'))];
  transcript.consume(snapshot(events));
  assert.deepEqual(render(), [{ group: 'Creating 3 parts in Workspace.Forest…', state: 'started', count: '3 steps' }]);
  transcript.consume(snapshot([...events, item(5, 't2', 'completed'), item(6, 't3', 'failed', create('Tree3')),
    item(7, 's1', 'inProgress', { server: 'arcane', tool: 'script_update', args: { ref: { root: 'ServerScriptService', pathSegments: ['Spawner'] } } }),
    item(8, 'o1', 'inProgress', { server: 'other', tool: 'scene_create', args: null }), item(9, 'n1', 'inProgress')]));
  assert.deepEqual(render(), [{ group: 'Created 2 parts in Workspace.Forest · 1 failed', state: 'failed', count: '3 steps' },
    { tool: 'Updating script ServerScriptService.Spawner…', state: 'started' },
    { tool: 'Running a step…', state: 'started' }, { tool: 'Running a step…', state: 'started' }]);
  for (const [tool, expected] of [['assets_procedural', 'Modelling a procedural mesh…'], ['assets_preview', 'Previewing a mesh…'], ['assets_place_studio_import', 'Placing a mesh in Studio…']] as const)
    assert.equal(describeToolActivity(tool, null, null, 'started').text, expected);
  assert.deepEqual(describeToolActivity('assets_procedural', null, null, 'started').group?.noun, ['mesh', 'meshes']);
  assert.equal(transcript.messages.find(message => message.key.endsWith('\0t2'))?.toolCall?.name, 'scene_create', 'a completion without identity keeps the started call');
});

test('saved ChatGPT history uses the same labels: a named result, a recognised shape or text, then one neutral label (never a raw id)', () => {
  const doc = new DocumentFixture(false, null);
  const saved = (text: string, toolState?: 'failed') => renderCodexToolArticle(doc as unknown as Document, { key: 't\0v\0i', scope: 't · v · i', text, ...(toolState ? { toolState } : {}) }).article as unknown as Element;
  const label = (article: Element) => article.querySelector('.tool-activity-text')!.textContent;
  assert.equal(label(saved(JSON.stringify({ sessions: [] }))), 'Checking the Studio connection');
  const playtest = saved('A playtest operation is already in progress.', 'failed');
  assert.equal(label(playtest), 'Starting a playtest');
  assert.equal(playtest.querySelector('.tool-activity-reason')!.textContent, 'A playtest operation is already in progress.');
  for (const text of [JSON.stringify({ ok: true }), 'done', '']) assert.equal(label(saved(text)), 'Running a step', 'neutral label for ' + JSON.stringify(text));
  assert.equal(label(saved(JSON.stringify({ x: 1 }), 'failed')), 'Running a step', 'a failed step without a name is not "A step failed"');
  // The row is the disclosure for its raw details: no Details link to click, Enter or a click opens them.
  const row = playtest.querySelector('.tool-activity')!, details = playtest.querySelector('.tool-details')!;
  assert.equal(row.getAttribute('role'), 'button'); assert.equal(row.getAttribute('aria-controls'), details.id); assert.equal(row.getAttribute('aria-expanded'), 'false');
  row.click(); assert.equal(details.open, true); assert.equal(row.getAttribute('aria-expanded'), 'true');
  const enter = new Event('keydown', { cancelable: true }); Object.defineProperty(enter, 'key', { value: 'Enter' }); row.dispatchEvent(enter);
  assert.equal(details.open, false); assert.equal(enter.defaultPrevented, true);
});

test('the ChatGPT chat renders live tool lines from public state while the turn runs', async t => {
  const doc = new DocumentFixture(true, new EventTarget());
  const live = state([item(1, 't1', 'inProgress', create('Tree1')), item(2, 't2', 'inProgress', create('Tree2'))]);
  const chat = new CodexChat(doc as unknown as Document, new CodexChatApi('a'.repeat(64), async () => Response.json({ state: live })));
  await chat.start(); t.after(() => chat.stop());
  const messages = doc.getElementById('codex-messages')!;
  groupToolCards(messages as unknown as HTMLElement);
  const liveLines = messages.children.filter(node => node.classList.contains('message-usage'));
  assert.deepEqual(liveLines.map(node => [node.getAttribute('data-live'), node.textContent]), [['true', 'Working…']], 'a quiet live line follows the running turn');
  assert.deepEqual(lines({ children: messages.children.filter(node => !liveLines.includes(node)) } as unknown as Element), [{ group: 'Creating 2 parts in Workspace.Forest…', state: 'started', count: '2 steps' }]);
  assert.deepEqual(messages.querySelectorAll('.tool-activity-text').map(node => node.textContent),
    ['Creating Part "Tree1" in Workspace.Forest…', 'Creating Part "Tree2" in Workspace.Forest…']);
});
