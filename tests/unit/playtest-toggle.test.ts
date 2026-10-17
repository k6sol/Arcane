/// <reference lib="dom" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PLAYTEST_TOGGLE_HINT, playtestToggleOn, startPlaytestToggle } from '../../apps/desktop/src/playtest-toggle.js';
import { describeToolActivity, type ChatState } from '../../apps/desktop/src/codex-chat.js';
import { workflowNativeModel } from '../../apps/daemon/src/workflow-native-model.js';
import { randomUUID } from 'node:crypto';

const require = createRequire(join(process.cwd(), 'package.json'));
const engine = require(join(process.cwd(), 'apps/desktop/electron/claude-chat.cjs')) as {
  sendInput(value: unknown): Record<string, unknown>; playtestNote(value: unknown): string;
};

// ---- Minimal DOM fixture for the switch ----
class FakeElement {
  attributes = new Map<string, string>(); dataset: Record<string, string> = {}; title = ''; disabled = false; textContent = '';
  listeners: ((event: Event) => void)[] = []; state: FakeElement | null = null;
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  querySelector(selector: string) { return selector === '.playtest-toggle-state' ? this.state : null; }
  addEventListener(_type: string, listener: (event: Event) => void) { this.listeners.push(listener); }
  removeEventListener(_type: string, listener: (event: Event) => void) { this.listeners = this.listeners.filter(value => value !== listener); }
  click() { for (const listener of [...this.listeners]) listener({ preventDefault() {} } as Event); }
}
function fakeDocument() {
  const button = new FakeElement(); button.state = new FakeElement(); button.setAttribute('aria-checked', 'false');
  const doc = { getElementById: (id: string) => id === 'playtest-toggle' ? button : null, defaultView: null } as unknown as Document;
  return { doc, button };
}
function memoryStorage(fail = false) {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => { if (fail) throw new Error('blocked'); return values.get(key) ?? null; },
    setItem: (key: string, value: string) => { if (fail) throw new Error('blocked'); values.set(key, value); } };
}

test('the switch is off by default, flips on click and is remembered per project', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const storage = memoryStorage(), { doc, button } = fakeDocument();
  let project: string | null = 'project-a';
  const toggle = startPlaytestToggle(doc, { storage, projectKey: () => project });
  t.after(() => toggle.stop());
  assert.equal(toggle.enabled(), false); assert.equal(button.getAttribute('role'), 'switch');
  assert.equal(button.getAttribute('aria-checked'), 'false'); assert.equal(button.state!.textContent, 'Off');
  assert.equal(button.title, PLAYTEST_TOGGLE_HINT + ' (off)'); assert.equal(playtestToggleOn(doc), false);
  const seen: boolean[] = []; toggle.subscribe(value => seen.push(value));
  button.click();
  assert.equal(toggle.enabled(), true); assert.equal(button.getAttribute('aria-checked'), 'true');
  assert.equal(button.state!.textContent, 'On', 'state is text, not colour alone'); assert.equal(button.dataset.state, 'on');
  assert.equal(playtestToggleOn(doc), true); assert.deepEqual(seen, [true]);
  assert.equal(storage.values.get('arcane.playtest-toggle.v1:project-a'), 'on');
  // Another project starts off; coming back restores its own choice.
  project = 'project-b'; assert.equal(toggle.enabled(), false); assert.equal(button.getAttribute('aria-checked'), 'false');
  project = 'project-a'; assert.equal(toggle.enabled(), true);
  // A fresh page for the same project reads the remembered choice.
  const second = fakeDocument(), again = startPlaytestToggle(second.doc, { storage, projectKey: () => 'project-a' });
  t.after(() => again.stop());
  assert.equal(again.enabled(), true); assert.equal(second.button.getAttribute('aria-checked'), 'true');
});

test('blocked storage keeps the choice for this page; stop() ends it', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { doc, button } = fakeDocument(), toggle = startPlaytestToggle(doc, { storage: memoryStorage(true), projectKey: () => { throw new Error('not ready'); } });
  assert.equal(toggle.enabled(), false); button.click(); assert.equal(toggle.enabled(), true);
  toggle.stop(); assert.equal(toggle.enabled(), false, 'a stopped switch never reports on'); button.click(); assert.equal(button.getAttribute('aria-checked'), 'true');
});

test('the engine accepts the switch as a plain boolean and turns it into a short system note', () => {
  const base = { conversationId: null, text: 'Build a forest', model: 'opus', effort: 'high' };
  assert.deepEqual({ ...engine.sendInput({ ...base, playtest: true }) }, { ...base, playtest: true });
  assert.deepEqual({ ...engine.sendInput(base) }, base, 'older renderers send no switch');
  assert.throws(() => engine.sendInput({ ...base, playtest: 'yes' }));
  assert.match(engine.playtestNote(true), /Playtest is ON[\s\S]*playtest_request[\s\S]*approves playtests you request in this chat automatically/);
  assert.match(engine.playtestNote(false), /Playtest is OFF\. Do not call playtest_request/);
  assert.equal(engine.playtestNote(undefined), '');
});

test('tool calls carry a grouping key by kind and target container', () => {
  const ref = (...pathSegments: string[]) => ({ instanceId: 'i', sessionId: 's', root: 'Workspace', pathSegments, className: 'Part' });
  const create = (name: string, className = 'Part') => describeToolActivity('mcp__arcane__scene_create', { parent: ref('Forest'), className, name }, null, 'started').group!;
  assert.equal(create('A').key, create('B').key);
  assert.deepEqual([create('A').verbs, create('A').noun, create('A').container], [['Creating', 'Created'], ['part', 'parts'], 'Workspace.Forest']);
  assert.deepEqual(create('M', 'MeshPart').noun, ['mesh part', 'mesh parts']);
  const update = describeToolActivity('scene_update', { ref: ref('Forest', 'Pine'), properties: { Color: {} } }, null, 'finished').group!;
  assert.equal(update.container, 'Workspace.Forest'); assert.notEqual(update.key, create('A').key);
  assert.equal(describeToolActivity('playtest_request', { sessionId: 's' }, null, 'started').group, null, 'playtests stay on their own line');
});

// ---- Edge: the composer switch, the Claude system note flag and grouped tool cards in the shared transcript ----
const browserModule = process.env.ARCANE_UI_BROWSER_MODULE;
test('Edge: Playtest switch in the composer and grouped tool cards', { skip: !browserModule, timeout: 90000 }, async t => {
  const build = process.env.ARCANE_UI_BUILD_DIR ?? 'dist', shots = resolve(process.env.ARCANE_UI_SCREENSHOT ?? 'runtime/claude-codex-team/claude-audit/playtest-toggle/shots');
  await mkdir(shots, { recursive: true });
  const modules = ['codex-chat', 'chat-tabs', 'codex-history', 'provider-setup', 'workspace-shell', 'claude-chat', 'task-usage', 'task-usage-ui', 'playtest-toggle'];
  const fixture = `import {CodexChat,CodexChatApi} from '/codex-chat.js';
    import {startProviderSetup} from '/provider-setup.js';
    import {startWorkspaceShell} from '/workspace-shell.js';
    import {ClaudeChat} from '/claude-chat.js';
    import {startPlaytestToggle} from '/playtest-toggle.js';
    const f = window.fx = { calls: [] };
    const chat = new CodexChat(document, new CodexChatApi('${'a'.repeat(64)}'));
    const native = Object.freeze({ version: 1, ...Object.fromEntries(['status','login','install','launch'].map(action => [action, async provider =>
      ({ version: 1, provider, installed: true, auth: 'subscription', cliVersion: '2.1.177', busy: false, message: null })])) });
    const setup = startProviderSetup(document, { chat, nativeBridge: native });
    const bridge = Object.freeze({ version: 1,
      status: async () => ({ installed: true, signedIn: true, cliVersion: '2.1.177', models: ['opus', 'sonnet'], efforts: ['low', 'medium', 'high'], defaultModel: 'opus', resolved: { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5' }, message: null }),
      list: async () => ({ conversations: [] }), history: async id => ({ conversationId: id, messages: [] }),
      send: async request => { f.calls.push(request); return { turnId: 'turn-' + f.calls.length, conversationId: 'conv-forest' }; },
      stop: async () => true, remove: async () => true, onEvent: listener => { f.emit = listener; return () => {}; } });
    const claude = new ClaudeChat(document, { bridge, storage: null });
    f.toggle = startPlaytestToggle(document, { storage: null, projectKey: () => 'fixture-project' });
    setup.subscribeChatSurface(() => { if (setup.chatSurface() === 'claude') { chat.yieldSurface(true); claude.activate(); f.refreshed = claude.refresh(); } else { claude.deactivate(); chat.yieldSurface(false); } });
    startWorkspaceShell(document);
    await chat.start(); f.ready = true;`;
  const thread = { threadId: 'fixture-thread', sessionId: 'fixture-session', selection: { model: 'gpt-6.1-sol', effort: 'low' }, configured: true, writeGranted: false, turnId: null, turnStatus: 'idle' };
  const codexState = {
    provider: 'codex', use: 'personal-local', projectPath: resolve('.'), connecting: false, closing: false, busy: false,
    actions: [], lastSnapshot: null, nativeTools: { configured: true, verified: false }, nativeAssets: { available: true, sealed: true, granted: false, admissionOpen: false },
    snapshot: {
      connectionId: randomUUID(), provenance: 'spawned-node-fixture', connected: true, ready: true,
      account: { auth: 'subscription', plan: 'fixture', requiresOpenaiAuth: true },
      models: [{ model: 'gpt-6.1-sol', id: 'opaque-sol', displayName: 'GPT-6.1-Sol', efforts: ['low', 'medium', 'high'], defaultEffort: 'low', entitlement: 'unverified' }],
      selection: { model: 'gpt-6.1-sol', effort: 'low' }, thread,
      operations: [], approvals: [], droppedEvents: 0, lastEventSeq: 0, failureCode: null, events: [],
    },
  } as unknown as ChatState;
  const proof = workflowNativeModel(codexState)?.proof; if (proof) codexState.workflowModel = proof;
  const server = createServer((request, response) => { void (async () => {
    const url = request.url?.split('?')[0] ?? '';
    if (url === '/v1/codex/state') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ state: codexState })); return; }
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
    const toggle = page.locator('#playtest-toggle'), composer = page.locator('#codex-composer'), form = page.locator('#codex-compose');
    assert.equal(await toggle.getAttribute('role'), 'switch'); assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    assert.equal(await toggle.isVisible(), true); assert.match(await toggle.innerText(), /Playtest\s*Off/);
    assert.equal(await page.getByRole('switch', { name: /Playtest/ }).count(), 1, 'named by its visible label');
    const plus = await page.locator('#workspace-add-context').boundingBox(), box = await toggle.boundingBox();
    await form.screenshot({ path: join(shots, 'composer-playtest-off-' + scheme + '.png') });
    const send = await page.locator('#codex-submit').boundingBox(), picker = await page.locator('.composer-model-picker').boundingBox();
    assert.ok(box && send && picker && Math.abs((box.y + box.height / 2) - (send.y + send.height / 2)) < 8 && box.x + box.width < picker.x && (!plus || box.x >= plus.x + plus.width), 'on the bottom bar, left of the model picker and right of +');
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-checked'), 'true'); assert.match(await toggle.innerText(), /Playtest\s*On/);
    await toggle.focus(); await page.keyboard.press('Space'); assert.equal(await toggle.getAttribute('aria-checked'), 'false', 'keyboard operable');
    await page.keyboard.press('Enter'); assert.equal(await toggle.getAttribute('aria-checked'), 'true');
    await page.mouse.move(0, 0); await composer.focus();
    await form.screenshot({ path: join(shots, 'composer-playtest-on-' + scheme + '.png') });
    await composer.fill('Plant a pine forest'); await composer.press('Enter');
    await page.waitForFunction(() => (window as any).fx.calls.length === 1);
    assert.equal(await page.evaluate(() => (window as any).fx.calls[0].playtest), true, 'Claude is told the switch is on');
    // Many creates in one container collapse into one card with a live count.
    await page.evaluate(() => {
      const fx = (window as any).fx, parent = { instanceId: 'i', sessionId: 's', root: 'Workspace', pathSegments: ['Forest'], className: 'Folder' };
      const tool = (id: string, name: string, status: string, input?: unknown, result?: string) => fx.emit({ turnId: 'turn-1', conversationId: 'conv-forest', type: 'tool',
        message: { id, role: 'tool', text: name, at: '', tool: { name, status, ...(input ? { input: JSON.stringify(input) } : {}), ...(result ? { result } : {}) } } });
      fx.tool = tool; fx.create = (index: number) => ({ parent, className: 'Part', name: 'TallPineTier' + index });
      tool('r1', 'scene_children', 'started', { root: 'Workspace' }); tool('r1', 'scene_children', 'finished', undefined, '{"nodes":[]}');
      for (let index = 1; index <= 3; index++) tool('c' + index, 'scene_create', 'started', fx.create(index));
    });
    const group = page.locator('#codex-messages .tool-group');
    await group.waitFor();
    assert.equal(await group.count(), 1);
    assert.equal(await group.locator('.tool-group-text').innerText(), 'Creating 3 parts in Workspace.Forest…');
    assert.equal(await group.getAttribute('data-tool-state'), 'started');
    await page.evaluate(() => {
      const fx = (window as any).fx, ok = (index: number) => JSON.stringify({ commandId: 'cmd-' + index, state: 'succeeded', terminal: true, command: { method: 'scene.create', args: fx.create(index) } });
      for (let index = 1; index <= 3; index++) fx.tool('c' + index, 'scene_create', 'finished', undefined, ok(index));
      for (let index = 4; index <= 8; index++) { fx.tool('c' + index, 'scene_create', 'started', fx.create(index)); fx.tool('c' + index, 'scene_create', index === 6 ? 'failed' : 'finished', undefined, index === 6 ? 'Studio is not in edit mode.' : ok(index)); }
    });
    await page.waitForFunction(() => document.querySelector('#codex-messages .tool-group .tool-group-text')?.textContent === 'Created 7 parts in Workspace.Forest · 1 failed');
    assert.equal(await group.getAttribute('data-tool-state'), 'failed');
    assert.equal(await group.locator('.tool-group-count').innerText(), '8 steps');
    assert.equal(await group.locator('.codex-message.tool').count(), 8, 'each call keeps its own line');
    assert.equal(await group.locator('.codex-message.tool .tool-details').count(), 8, 'and its own Details');
    assert.equal(await page.locator('#codex-messages > .codex-message.tool').count(), 1, 'the single read stays on its own line');
    assert.equal(await group.evaluate(node => (node as HTMLDetailsElement).open), false, 'collapsed by default');
    await group.scrollIntoViewIfNeeded();
    await page.locator('#codex-messages').screenshot({ path: join(shots, 'grouped-card-collapsed-' + scheme + '.png') });
    await group.locator('.tool-group-summary').click();
    assert.equal(await group.evaluate(node => (node as HTMLDetailsElement).open), true);
    assert.equal(await group.locator('.tool-activity-text').first().innerText(), 'Creating Part "TallPineTier1" in Workspace.Forest');
    await page.locator('#codex-messages').screenshot({ path: join(shots, 'grouped-card-expanded-' + scheme + '.png') });
    // A different kind breaks the run; finishing the reply keeps the change card after the group.
    await page.evaluate(() => {
      const fx = (window as any).fx;
      fx.emit({ turnId: 'turn-1', conversationId: 'conv-forest', type: 'message', message: { id: 'a1', role: 'assistant', text: 'Planted the forest.', at: '' } });
      fx.emit({ turnId: 'turn-1', conversationId: 'conv-forest', type: 'done', ok: true, error: null, usage: { inputTokens: 1200, outputTokens: 300, costUsd: 0.01 } });
    });
    await page.locator('#codex-messages .chat-change-card').waitFor();
    assert.equal(await page.locator('#codex-messages .chat-change-summary').innerText(), '7 created');
    assert.equal(await group.locator('.tool-group-text').innerText(), 'Created 7 parts in Workspace.Forest · 1 failed', 'stable once settled');
    await page.locator('#codex-messages').screenshot({ path: join(shots, 'grouped-card-with-changes-' + scheme + '.png') });
    // Phone width: the switch stays on the bar without overlapping the model picker or the send button.
    await page.setViewportSize({ width: 390, height: 844 }); await composer.focus();
    const narrow = await toggle.boundingBox(), narrowPicker = await page.locator('.composer-model-picker').boundingBox(), narrowForm = await form.boundingBox();
    assert.ok(narrow && narrowPicker && narrowForm && narrow.x >= narrowForm.x && narrow.x + narrow.width <= narrowForm.x + narrowForm.width &&
      (narrow.x + narrow.width <= narrowPicker.x || narrow.y >= narrowPicker.y + narrowPicker.height || narrow.y + narrow.height <= narrowPicker.y), 'no overlap at phone width');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no horizontal page scroll');
    await form.screenshot({ path: join(shots, 'composer-playtest-phone-' + scheme + '.png') });
    assert.deepEqual(errors, []);
    await page.close();
  }
});
