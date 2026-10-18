/// <reference lib="dom" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { ChatState } from '../../apps/desktop/src/codex-chat.js';
import { patchMessageText, renderMessageText, TRANSCRIPT_WINDOW, transcriptWindowStart } from '../../apps/desktop/src/codex-chat.js';
import { workflowNativeModel } from '../../apps/daemon/src/workflow-native-model.js';

// Rendering cost of long conversations and streamed replies in the shared chat transcript (both providers), measured in
// headless Edge with in-page doubles only: no Electron, CLI, network, Studio or inference. Timings are reported as test
// diagnostics; assertions cover the structural guarantees (kept nodes, windowing, no listener growth), not machine speed.
const browserModule = process.env.ARCANE_UI_BROWSER_MODULE;
const FENCE = '`'.repeat(3);

test('streamed markdown patches keep finished blocks and match a full render', () => {
  // A minimal DOM double with isEqualNode, enough for the reconciliation contract.
  class Node0 {
    children: Node0[] = []; parent: Node0 | null = null; className = ''; dataset: Record<string, string> = {}; attrs = new Map<string, string>(); text = '';
    constructor(readonly tagName: string) {}
    get childNodes() { return this.children; }
    get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
    set textContent(value: string) { this.text = String(value); for (const child of this.children) child.parent = null; this.children = []; }
    append(...nodes: Node0[]) { for (const node of nodes) { node.remove(); node.parent = this; this.children.push(node); } }
    remove() { if (this.parent) { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; } }
    setAttribute(name: string, value: string) { this.attrs.set(name, value); }
    getAttribute(name: string) { return this.attrs.get(name) ?? null; }
    set tabIndex(value: number) { this.attrs.set('tabindex', String(value)); }
    matches(selector: string) { return selector.startsWith('.') && this.className.split(' ').includes(selector.slice(1)); }
    isEqualNode(other: Node0): boolean {
      return other.tagName === this.tagName && other.className === this.className && other.text === this.text && JSON.stringify([...other.attrs]) === JSON.stringify([...this.attrs])
        && JSON.stringify(other.dataset) === JSON.stringify(this.dataset) && other.children.length === this.children.length && this.children.every((child, index) => child.isEqualNode(other.children[index]!));
    }
  }
  const doc = { createElement: (tag: string) => new Node0(tag.toUpperCase()) } as unknown as Document;
  const reply = '## Plan\n\nFirst **bold** step.\n\n- one\n- two\n\n' + FENCE + 'lua\nprint(1)\n' + FENCE + '\n\nClosing words go here.';
  let body: HTMLElement | null = null; const seen = new Set<unknown>(); let first: unknown = null;
  for (let end = 1; end <= reply.length; end += 3) {
    const next = patchMessageText(doc, body, reply.slice(0, end));
    if (body && next !== body) seen.add('replaced');
    body = next;
    if (end > 20 && !first) first = (body as unknown as Node0).children[0];
  }
  body = patchMessageText(doc, body, reply);
  const full = renderMessageText(doc, reply) as unknown as Node0;
  assert.ok((body as unknown as Node0).isEqualNode(full), 'the patched body equals a fresh render of the same text');
  assert.equal((body as unknown as Node0).children[0], first, 'the finished heading node is kept across every later delta');
  assert.ok(TRANSCRIPT_WINDOW.turns >= 50, 'at least the last 50 turns render immediately');
});

test('the transcript window keeps at least the last 50 turns and moves in steps', () => {
  const starts = (turns: number) => Array.from({ length: turns }, (_, index) => index * 3);
  assert.equal(transcriptWindowStart(starts(10)), 0);
  assert.equal(transcriptWindowStart(starts(TRANSCRIPT_WINDOW.turns + TRANSCRIPT_WINDOW.step - 1)), 0, 'a little over the window still renders everything');
  for (const turns of [75, 99, 100, 260, 1000]) {
    const first = transcriptWindowStart(starts(turns)), visible = turns - first / 3;
    assert.ok(first % 3 === 0, 'the window starts at a turn'); assert.ok(visible >= TRANSCRIPT_WINDOW.turns && visible < TRANSCRIPT_WINDOW.turns + TRANSCRIPT_WINDOW.step, turns + ' turns show ' + visible);
  }
  assert.equal(transcriptWindowStart(starts(100)), transcriptWindowStart(starts(124)), 'new turns do not move the window until a whole step is added');
});

function codexState(events: unknown[], turnStatus = 'idle'): ChatState {
  const selection = { model: 'gpt-6.1-sol', effort: 'low' };
  const result = {
    provider: 'codex', use: 'personal-local', projectPath: resolve('.'), connecting: false, closing: false, busy: false,
    actions: [], lastSnapshot: null, nativeTools: { configured: true, verified: false }, nativeAssets: { available: true, sealed: true, granted: false, admissionOpen: false },
    snapshot: {
      connectionId: CONNECTION, provenance: 'spawned-node-fixture', connected: true, ready: true,
      account: { auth: 'subscription', plan: 'fixture', requiresOpenaiAuth: true },
      models: [{ model: 'gpt-6.1-sol', id: 'opaque-sol', displayName: 'GPT-6.1-Sol', efforts: ['low', 'medium', 'high'], defaultEffort: 'low', entitlement: 'unverified' }],
      selection, thread: { threadId: 'perf-thread', sessionId: 'perf-session', selection, configured: true, writeGranted: false, turnId: 'turn-live', turnStatus },
      operations: [], approvals: [], droppedEvents: 0, lastEventSeq: events.length, failureCode: null, events,
    },
  } as unknown as ChatState;
  const proof = workflowNativeModel(result)?.proof; if (proof) result.workflowModel = proof;
  return result;
}
const CONNECTION = randomUUID();

test('Edge: long transcripts, streamed replies and chat switches stay bounded in both providers', { skip: !browserModule, timeout: 240000 }, async t => {
  const build = process.env.ARCANE_UI_BUILD_DIR ?? 'dist';
  const modules = ['codex-chat', 'chat-tabs', 'codex-history', 'provider-setup', 'workspace-shell', 'claude-chat', 'task-usage', 'task-usage-ui', 'script-diff'];
  // Codex: 120 public items over 60 turns (tool calls and markdown replies); the live turn then streams 40 more deltas.
  const events: unknown[] = [];
  const reply = (n: number) => '### Step ' + n + '\n\nPlaced **part ' + n + '** with `Anchored = true`.\n\n- size 4x1x4\n- colour teal\n\n' + FENCE + 'lua\nprint(' + n + ')\n' + FENCE;
  for (let turn = 0; turn < 60; turn++) {
    const ids = { threadId: 'perf-thread', turnId: 'turn-' + turn };
    events.push({ seq: events.length + 1, type: 'item', ...ids, itemId: 'tool-' + turn, itemType: 'mcpToolCall', status: 'completed', tool: { server: 'arcane', tool: 'scene_children', args: { root: 'Workspace' } } });
    events.push({ seq: events.length + 1, type: 'delta', ...ids, itemId: 'reply-' + turn, text: reply(turn) });
  }
  let served = codexState(events);
  const fixture = `import {CodexChat,CodexChatApi} from '/codex-chat.js';
    import {startProviderSetup} from '/provider-setup.js';
    import {startWorkspaceShell} from '/workspace-shell.js';
    import {ClaudeChat} from '/claude-chat.js';
    const f = window.fx = { calls: [] };
    const chat = new CodexChat(document, new CodexChatApi('${'a'.repeat(64)}'));
    f.codex = chat;
    const native = Object.freeze({ version: 1, ...Object.fromEntries(['status','login','install','launch'].map(action => [action, async provider =>
      ({ version: 1, provider, installed: true, auth: 'subscription', cliVersion: '2.1.177', busy: false, message: null })])) });
    const setup = startProviderSetup(document, { chat, nativeBridge: native });
    const fence = '${FENCE}';
    const histories = new Map();
    const tool = (id, n) => ({ id, role: 'tool', text: 'scene_create', at: '', tool: { name: 'scene_create', status: 'finished',
      input: JSON.stringify({ parent: { instanceId: 'i', sessionId: 's', root: 'Workspace', pathSegments: [], className: 'Folder' }, className: 'Part', name: 'P' + n }),
      result: JSON.stringify({ commandId: 'cmd-' + id, state: 'succeeded', terminal: true, command: { method: 'scene.create', args: { className: 'Part', name: 'P' + n } } }) } });
    const big = [];
    for (let n = 0; n < 260; n++) {
      big.push({ id: 'u' + n, role: 'user', text: 'Question ' + n, at: '' });
      big.push({ id: 'a' + n, role: 'assistant', at: '', text: '## Answer ' + n + '\\n\\nSome **bold** text with ' + '\`code\`' + '.\\n\\n- item a\\n- item b\\n\\n' + fence + 'lua\\nprint(' + n + ')\\n' + fence
        + (n % 10 === 0 ? '\\n\\n' + fence + 'arcane-choices\\n{"question":"Next?","options":["Red","Blue"]}\\n' + fence : '') });
    }
    histories.set('conv-big', big);
    const tools = [];
    for (let n = 0; n < 12; n++) {
      tools.push({ id: 'tu' + n, role: 'user', text: 'Build row ' + n, at: '' });
      for (let k = 0; k < 40; k++) tools.push(tool('t' + n + '-' + k, n * 100 + k));
      tools.push({ id: 'ta' + n, role: 'assistant', text: 'Built row ' + n + '.', at: '' });
    }
    histories.set('conv-tools', tools);
    for (const id of ['conv-a', 'conv-b']) {
      const rows = [];
      for (let n = 0; n < 30; n++) {
        rows.push({ id: id + 'u' + n, role: 'user', text: 'Step ' + n, at: '' });
        for (let k = 0; k < 4; k++) rows.push(tool(id + 't' + n + '-' + k, n * 10 + k));
        rows.push({ id: id + 'a' + n, role: 'assistant', at: '', text: 'Done ' + n + '.\\n\\n' + fence + 'arcane-choices\\n{"question":"Next?","options":["Red","Blue"]}\\n' + fence
          + '\\n\\n' + fence + 'arcane-memory\\nThe lobby uses teal parts.\\n' + fence });
      }
      histories.set(id, rows);
    }
    const conversations = [...histories.keys()].map(id => ({ conversationId: id, title: id, updatedAt: '2026-10-01T00:00:00Z', model: 'opus', effort: 'high' }));
    const bridge = Object.freeze({ version: 1,
      status: async () => ({ installed: true, signedIn: true, cliVersion: '2.1.177', models: ['opus', 'sonnet'], efforts: ['low', 'medium', 'high'], defaultModel: 'opus', resolved: { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5' }, message: null }),
      list: async () => ({ conversations }), history: async id => ({ conversationId: id, messages: histories.get(id) ?? [] }),
      send: async request => { f.calls.push(request); return { turnId: 'turn-' + f.calls.length, conversationId: 'conv-stream' }; },
      stop: async () => true, remove: async () => true, onEvent: listener => { f.emit = listener; return () => {}; } });
    const claude = new ClaudeChat(document, { bridge, storage: null });
    f.claude = claude;
    setup.subscribeChatSurface(() => { if (setup.chatSurface() === 'claude') { chat.yieldSurface(true); claude.activate(); f.refreshed = claude.refresh(); } else { claude.deactivate(); chat.yieldSurface(false); } });
    startWorkspaceShell(document);
    await chat.start(); f.ready = true;`;
  // Counts live listeners (on window, document or connected nodes) and active observers, wrapped before any module loads.
  const instrument = () => {
    const w = window as any, listeners = new Map<EventTarget, number>(), key = (type: string, capture: unknown) => type + ':' + (typeof capture === 'object' ? !!(capture as any)?.capture : !!capture);
    const seen = new WeakMap<EventTarget, Set<string>>();
    const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
    EventTarget.prototype.addEventListener = function (this: EventTarget, type: string, fn: any, options?: any) {
      if (fn) { const set = seen.get(this) ?? new Set(); const id = key(type, options) + ':' + (fn.__id ??= Math.random()); if (!set.has(id)) { set.add(id); seen.set(this, set); listeners.set(this, (listeners.get(this) ?? 0) + 1); } }
      return add.call(this, type, fn, options);
    };
    EventTarget.prototype.removeEventListener = function (this: EventTarget, type: string, fn: any, options?: any) {
      const set = seen.get(this), id = fn ? key(type, options) + ':' + fn.__id : ''; if (set?.delete(id)) listeners.set(this, (listeners.get(this) ?? 1) - 1);
      return remove.call(this, type, fn, options);
    };
    let observers = 0;
    for (const name of ['MutationObserver', 'ResizeObserver', 'IntersectionObserver']) {
      const Base = w[name]; if (!Base) continue;
      w[name] = class extends Base { live = false; observe(...args: unknown[]) { if (!this.live) { this.live = true; observers++; } return super.observe(...args); } disconnect() { if (this.live) { this.live = false; observers--; } return super.disconnect(); } };
    }
    w.__liveListeners = () => { let count = 0; for (const [target, n] of listeners) if (n > 0 && (target === window || target === document || (target instanceof Node && target.isConnected))) count += n; return count; };
    w.__observers = () => observers;
    // Work done inside animation-frame callbacks is part of the streaming cost.
    w.__rafTime = 0; const raf = w.requestAnimationFrame.bind(w);
    w.requestAnimationFrame = (fn: FrameRequestCallback) => raf((time: number) => { const start = performance.now(); try { fn(time); } finally { w.__rafTime += performance.now() - start; } });
  };
  const server = createServer((request, response) => { void (async () => {
    const url = request.url?.split('?')[0] ?? '';
    if (url === '/v1/codex/state') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ state: served })); return; }
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.setDefaultTimeout(60000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(instrument);
  await page.goto('http://127.0.0.1:' + (server.address() as { port: number }).port + '/studio');
  await page.waitForFunction(() => (window as any).fx?.ready === true);
  const report: Record<string, unknown> = {};
  const frames = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));

  // ---- Codex: 60 saved turns, then the live turn streams 40 updates (each one a state refresh + render). ----
  await page.waitForFunction(() => document.querySelectorAll('#codex-messages .codex-message.codex').length > 0);
  await frames();
  const codexInitial = await page.evaluate(() => ({ cards: document.querySelectorAll('#codex-messages .codex-message').length, earlier: !!document.querySelector('#codex-messages .chat-earlier') }));
  await page.evaluate(() => {
    const w = window as any, chat = w.fx.codex, render = chat.render.bind(chat); w.__codexRender = [] as number[];
    chat.render = () => { const start = performance.now(); try { render(); } finally { w.__codexRender.push(performance.now() - start); } };
    w.__added = 0; new MutationObserver(records => { for (const record of records) w.__added += record.addedNodes.length; }).observe(document.getElementById('codex-messages')!, { childList: true, subtree: true });
  });
  const firstCodexCard = await page.evaluateHandle(() => document.querySelector('#codex-messages .codex-message.codex'));
  let streamed = '';
  for (let n = 0; n < 40; n++) {
    const piece = (n % 8 === 7 ? '\n\n' : '') + 'Streaming sentence ' + n + ' with **detail**. ';
    streamed += piece;
    events.push({ seq: events.length + 1, type: 'delta', threadId: 'perf-thread', turnId: 'turn-live', itemId: 'reply-live', text: piece });
    served = codexState(events, 'inProgress');
    await page.evaluate(() => (window as any).fx.codex.refresh());
  }
  const codex = await page.evaluate(() => {
    const w = window as any, times = (w.__codexRender as number[]).filter(value => value > 0.05), sum = times.reduce((a, b) => a + b, 0);
    return { renders: times.length, meanMs: +(sum / Math.max(1, times.length)).toFixed(2), totalMs: +sum.toFixed(1), addedNodes: w.__added,
      cards: document.querySelectorAll('#codex-messages .codex-message').length, live: document.querySelector('#codex-messages .codex-message.codex:last-of-type')?.textContent ?? '' };
  });
  const codexKept = await page.evaluate(node => !!node && (node as Element).isConnected, firstCodexCard);
  report.codex = { ...codexInitial, ...codex, live: undefined, firstCardKept: codexKept };
  t.diagnostic('codex ' + JSON.stringify(report.codex));
  assert.ok(codex.live.includes('Streaming sentence 39'), 'the streamed Codex reply is shown');

  // ---- Claude: switch the shared surface to Claude. ----
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('workspace:providerpreference', { detail: { provider: 'claude' } })));
  await page.waitForFunction(() => !document.getElementById('claude-chat-tabs')!.hidden);
  await page.evaluate(() => (window as any).fx.refreshed);
  const open = async (id: string) => page.evaluate(async id => {
    const box = document.getElementById('codex-messages')!, start = performance.now();
    await (window as any).fx.claude.open(id); void box.scrollHeight;
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
    const opened = performance.now() - start;
    // A forced relayout of the whole transcript (width change) approximates scroll/resize cost.
    const width = box.style.width; box.style.width = '700px'; const layoutStart = performance.now(); void box.scrollHeight; const layout = performance.now() - layoutStart; box.style.width = width; void box.scrollHeight;
    // Scrolling through the transcript: 20 steps from top to bottom, each forcing layout and a paint frame.
    const scrollStart = performance.now();
    for (let step = 0; step <= 20; step++) { box.scrollTop = (box.scrollHeight - box.clientHeight) * step / 20; void box.getBoundingClientRect(); await new Promise(done => requestAnimationFrame(done)); }
    const scroll = performance.now() - scrollStart;
    return { openMs: +opened.toFixed(1), relayoutMs: +layout.toFixed(1), scroll20FramesMs: +scroll.toFixed(1), elements: box.querySelectorAll('*').length,
      messages: box.querySelectorAll('.codex-message').length, earlier: box.querySelector('.chat-earlier')?.textContent ?? null };
  }, id);
  report.claudeBig = await open('conv-big');
  report.claudeTools = await open('conv-tools');
  t.diagnostic('claude 520 messages ' + JSON.stringify(report.claudeBig));
  t.diagnostic('claude 504 tool-heavy messages ' + JSON.stringify(report.claudeTools));
  const big = report.claudeBig as { messages: number; earlier: string | null };
  assert.ok(big.messages <= (TRANSCRIPT_WINDOW.turns + TRANSCRIPT_WINDOW.step) * 2, 'old turns stay collapsed until asked for');
  assert.match(big.earlier ?? '', /Show \d+ earlier messages/);
  // Expanding restores every message (nothing is lost for assistive technology) and keeps the reading position.
  await open('conv-big');
  const expanded = await page.evaluate(async () => {
    const box = document.getElementById('codex-messages')!, button = box.querySelector<HTMLButtonElement>('.chat-earlier')!;
    box.scrollTop = 0; const anchor = box.querySelectorAll('.codex-message')[0]!, top = anchor.getBoundingClientRect().top;
    const start = performance.now(); button.click(); void box.scrollHeight; const ms = performance.now() - start;
    return { ms: +ms.toFixed(1), messages: box.querySelectorAll('.codex-message').length, button: !!box.querySelector('.chat-earlier'), shift: Math.round(anchor.getBoundingClientRect().top - top),
      focused: document.activeElement?.classList.contains('codex-message') ?? false, live: box.querySelectorAll('[aria-live]:not([role=status])').length,
      first: box.querySelector('.codex-message .message-text')?.textContent ?? '' };
  });
  report.expand = expanded; t.diagnostic('expand earlier ' + JSON.stringify(expanded));
  assert.equal(expanded.messages, 520); assert.equal(expanded.button, false); assert.equal(expanded.first, 'Question 0');
  assert.ok(Math.abs(expanded.shift) <= 1, 'the message that was on screen stays in place'); assert.equal(expanded.focused, true, 'focus moves to the first revealed message');
  assert.equal(expanded.live, 0, 'no saved message is a live region');

  // ---- Claude streaming: a long markdown reply in 2400 deltas, delivered in bursts like a real stream. ----
  await page.evaluate(() => (window as any).fx.claude.newChat());
  await page.evaluate(() => (window as any).fx.claude.send('Write the long plan'));
  await page.waitForFunction(() => (window as any).fx.calls.length === 1);
  const stream = await page.evaluate(async () => {
    const w = window as any, box = document.getElementById('codex-messages')!;
    const parts: string[] = [];
    for (let n = 0; n < 120; n++) parts.push('## Section ' + n + '\n\nThis paragraph explains **step ' + n + '** in detail with `code` and more words to read.\n\n- first point\n- second point\n\n');
    const text = parts.join(''), size = Math.ceil(text.length / 2400), deltas: string[] = [];
    for (let i = 0; i < text.length; i += size) deltas.push(text.slice(i, i + size));
    let removed = 0; const observer = new MutationObserver(records => { for (const record of records) removed += record.removedNodes.length; });
    observer.observe(box, { childList: true, subtree: true });
    w.__rafTime = 0; let sync = 0, kept: Element | null = null; const start = performance.now();
    for (let i = 0; i < deltas.length; i += 8) {
      const t0 = performance.now();
      for (const delta of deltas.slice(i, i + 8)) w.fx.emit({ turnId: 'turn-1', conversationId: 'conv-stream', type: 'delta', text: delta });
      sync += performance.now() - t0;
      if (i === 800) kept = box.querySelector('.codex-message[aria-busy=true] .message-text > *');
      await new Promise(done => setTimeout(done, 4));
    }
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
    const wall = performance.now() - start, bubble = box.querySelector('.codex-message[aria-busy=true]');
    const result = { deltas: deltas.length, chars: text.length, syncMs: +sync.toFixed(1), frameMs: +w.__rafTime.toFixed(1), mainThreadMs: +(sync + w.__rafTime).toFixed(1), wallMs: +wall.toFixed(0),
      removedNodes: removed, firstBlockKept: !!kept && kept.isConnected, live: bubble?.getAttribute('aria-live') ?? null,
      complete: (bubble?.textContent ?? '').includes('Section 119'), nearBottom: box.scrollHeight - box.scrollTop - box.clientHeight < 96 };
    w.fx.emit({ turnId: 'turn-1', conversationId: 'conv-stream', type: 'message', message: { id: 'final', role: 'assistant', text, at: '' } });
    w.fx.emit({ turnId: 'turn-1', conversationId: 'conv-stream', type: 'done', ok: true, error: null, usage: null });
    observer.disconnect();
    return { ...result, liveAfter: box.querySelectorAll('[aria-live]:not([role=status])').length };
  });
  report.stream = stream; t.diagnostic('claude stream ' + JSON.stringify(stream));
  assert.equal(stream.complete, true, 'every delta reaches the reply'); assert.equal(stream.nearBottom, true, 'the reply follows the bottom while the reader is there');
  assert.equal(stream.firstBlockKept, true, 'finished blocks are not rebuilt by later deltas');
  assert.equal(stream.live, 'polite', 'only the reply being written is a live region'); assert.equal(stream.liveAfter, 0);

  // ---- Memory: 50 chat switches (and 10 provider switches) must not grow live listeners or observers. ----
  await page.evaluate(() => (window as any).fx.claude.open('conv-a'));
  const counts: { listeners: number; observers: number }[] = [];
  for (let n = 0; n < 50; n++) {
    await page.evaluate(id => (window as any).fx.claude.open(id), n % 2 ? 'conv-a' : 'conv-b');
    if (n === 1 || n === 49) counts.push(await page.evaluate(() => ({ listeners: (window as any).__liveListeners(), observers: (window as any).__observers() })));
  }
  for (let n = 0; n < 10; n++) {
    await page.evaluate(provider => document.dispatchEvent(new CustomEvent('workspace:providerpreference', { detail: { provider } })), n % 2 ? 'claude' : 'codex');
    await frames();
  }
  await page.evaluate(() => (window as any).fx.claude.open('conv-b'));
  counts.push(await page.evaluate(() => ({ listeners: (window as any).__liveListeners(), observers: (window as any).__observers() })));
  report.memory = counts; t.diagnostic('listeners/observers after 2, 50 chat switches and 10 provider switches ' + JSON.stringify(counts));
  assert.ok(counts[1]!.listeners <= counts[0]!.listeners, 'chat switches release card, choice and diff listeners');
  assert.ok(counts[2]!.listeners <= counts[0]!.listeners, 'provider switches release their listeners');
  assert.ok(counts[1]!.observers <= counts[0]!.observers && counts[2]!.observers <= counts[0]!.observers, 'no observer accumulates');
  assert.deepEqual(errors, []);
  if (process.env.ARCANE_PERF_REPORT) await import('node:fs/promises').then(fs => fs.writeFile(process.env.ARCANE_PERF_REPORT!, JSON.stringify(report, null, 2)));
});
