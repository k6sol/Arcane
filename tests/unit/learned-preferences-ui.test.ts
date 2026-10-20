/// <reference lib="dom" />
// Edge: the chat feedback controls, the implicit "Learning" note and Settings > What Arcane has learned, against the real
// daemon routes and store (temporary directories), driven through the real Claude chat controller.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPreferenceStore } from '../../packages/core/src/preference-store.js';
import { preferenceRoutes } from '../../apps/daemon/src/preference-routes.js';
import { startLearnedPreferences, type ChatFeedbackTool } from '../../apps/desktop/src/learned-preferences.js';
import { LearningDocument, learningTick } from './learning-ui-fixture.js';
import { codexFeedbackTools, type ChatMessage } from '../../apps/desktop/src/codex-chat.js';

const browserModule = process.env.ARCANE_UI_BROWSER_MODULE;
const TOKEN = 'a'.repeat(64);

function scopedLearning() {
  const doc = new LearningDocument(), signals: { source: string; polarity?: string; tools: { name: string; input: string }[] }[] = [];
  let time = 1000;
  const controller = startLearnedPreferences(doc.asDocument(), { token: () => TOKEN, now: () => time,
    fetch: async (path, init) => {
      assert.equal(path, '/v1/preferences/signal'); signals.push(JSON.parse(String(init!.body)));
      return Response.json({ enabled: true, learned: false });
    } });
  return { doc, controller, signals, advance: (ms: number) => { time += ms; }, review: (detail: Record<string, unknown>) => doc.dispatchEvent(new CustomEvent('arcane-learning-signal', { detail: { source: 'review', positive: true, ...detail } })) };
}
const made = (jobId: string, name: string, status = 'finished', state = 'succeeded'): ChatFeedbackTool => ({ name: 'assets_procedural', status,
  input: JSON.stringify({ name, generator: { kind: name === 'tree-A' ? 'tree' : 'rock' } }), result: JSON.stringify({ job: { jobId, state } }) });

test('reviewing tree A after generating rock B learns only the exact reviewed job', async t => {
  const f = scopedLearning(); t.after(() => f.controller.stop());
  const tree = made('job-A', 'tree-A'), rock = made('job-B', 'rock-B');
  f.controller.hooks.turnFinished({ key: 'claude:tree-tab', ok: true, tools: [tree], box: null });
  f.controller.hooks.turnFinished({ key: 'claude:rock-tab', ok: true, tools: [rock], box: null });
  f.review({ jobId: 'job-A' }); f.review({ jobId: 'job-B', positive: false }); await learningTick();
  assert.deepEqual(f.signals.map(signal => [signal.polarity, signal.tools]), [
    ['positive', [{ name: 'assets_procedural', input: tree.input }]], ['negative', [{ name: 'assets_procedural', input: rock.input }]],
  ]);
});

test('unknown, mismatched, incomplete and failed jobs never fall back to another model; keep is not a review', async t => {
  const f = scopedLearning(); t.after(() => f.controller.stop());
  f.controller.hooks.turnFinished({ key: 'claude:a', ok: true, tools: [made('known', 'tree-A'), made('failed-call', 'x', 'failed'), made('unfinished', 'x', 'started'),
    made('failed-job', 'x', 'finished', 'failed'), { ...made('other', 'x'), result: JSON.stringify({ jobId: 'mismatch', job: { jobId: 'different', state: 'succeeded' } }) }], box: null });
  for (const jobId of ['unknown', 'failed-call', 'unfinished', 'failed-job', 'mismatch', 'different', '', 'bad job']) f.review({ jobId });
  f.review({}); f.review({ jobId: 'known', positive: undefined }); f.review({ source: 'keep', jobId: 'known' }); await learningTick();
  assert.deepEqual(f.signals, []);
});

test('conflicting inputs fence a job instead of replacing its subject; remembered jobs are bounded and expire', async t => {
  const f = scopedLearning(); t.after(() => f.controller.stop());
  const done = (tool: ChatFeedbackTool) => f.controller.hooks.turnFinished({ key: 'claude:a', ok: true, tools: [tool], box: null });
  done(made('conflict', 'tree-A')); done(made('conflict', 'rock-B')); done(made('conflict', 'tree-A')); f.review({ jobId: 'conflict' });
  await learningTick(); assert.equal(f.signals.length, 0);
  for (let i = 0; i < 129; i++) done(made('bounded-' + i, 'tree-A'));
  f.review({ jobId: 'bounded-0' }); f.review({ jobId: 'bounded-128' }); await learningTick();
  assert.equal(f.signals.length, 1, 'only the retained subject is taught');
  f.advance(6 * 3600 * 1000 + 1); f.review({ jobId: 'bounded-128' }); await learningTick();
  assert.equal(f.signals.length, 1, 'expired subjects do not teach');
});

test('a model preview gets feedback only when both its input and result match the remembered job', async t => {
  const f = scopedLearning(); t.after(() => f.controller.stop());
  const tree = made('job-A', 'tree-A');
  f.controller.hooks.turnFinished({ key: 'claude:a', ok: true, tools: [tree], box: null });
  const box = f.doc.createElement('div'); f.doc.root.append(box);
  const preview = (input: string, result: string) => {
    const article = f.doc.createElement('article'); box.append(article);
    f.controller.hooks.turnFinished({ key: 'claude:preview', ok: true, tools: [{ name: 'assets_preview', status: 'finished', input: JSON.stringify({ jobId: input }), result: JSON.stringify({ jobId: result }), article: article as unknown as HTMLElement }], box: box as unknown as HTMLElement });
    return article;
  };
  assert.equal(preview('unknown', 'unknown').querySelector('.model-feedback'), null);
  assert.equal(preview('job-A', 'job-B').querySelector('.model-feedback'), null);
  const card = preview('job-A', 'job-A'); card.querySelector('.model-feedback')!.querySelectorAll('button')[0]!.trustedClick(); await learningTick();
  assert.deepEqual(f.signals[0]?.tools, [{ name: 'assets_procedural', input: tree.input }]);
  const staleCard = preview('job-A', 'job-A');
  f.controller.hooks.turnFinished({ key: 'claude:other', ok: true, tools: [made('job-A', 'rock-B')], box: null });
  staleCard.querySelector('.model-feedback')!.querySelectorAll('button')[0]!.trustedClick(); await learningTick();
  assert.equal(f.signals.length, 1, 'an existing card rechecks the later subject fence when clicked');
  assert.match(staleCard.textContent, /Refresh this model preview/);
});

test('GPT turn feedback stays with its own scoped command after another chat finishes', async t => {
  const f = scopedLearning(); t.after(() => f.controller.stop());
  const row = (threadId: string, turnId: string, name: string): ChatMessage => ({ key: [threadId, turnId, 'item'].join('\0'), role: 'tool', scope: '',
    toolCall: { name: 'scene_build', input: { name: 'display-only' } }, text: JSON.stringify({ state: 'succeeded', terminal: true,
      command: { method: 'scene.build', args: { name, kits: [{ kind: 'forest', radius: name === 'tree-A' ? 50 : 5 }] } } }) });
  const messages = [row('thread-A', 'turn-A', 'tree-A'), row('thread-B', 'turn-B', 'rock-B')];
  f.controller.hooks.turnFinished({ key: 'codex:thread-A', ok: true, tools: codexFeedbackTools(messages, 'thread-A', 'turn-A'), box: null });
  f.controller.hooks.turnFinished({ key: 'codex:thread-B', ok: true, tools: codexFeedbackTools(messages, 'thread-B', 'turn-B'), box: null });
  f.controller.hooks.userMessage({ key: 'codex:thread-A', text: 'perfect', box: null, anchor: null }); await learningTick();
  assert.equal(f.signals.length, 1);
  assert.equal(JSON.parse(f.signals[0]!.tools[0]!.input).name, 'tree-A');
});

test('markup: the learned card sits in Settings > Project memory with a switch, status, list and Forget all; styles have no motion', async () => {
  const html = await readFile('apps/desktop/public/studio.html', 'utf8'), css = await readFile('apps/desktop/public/studio.css', 'utf8');
  const section = html.slice(html.indexOf('<section id="settings-memory"'), html.indexOf('<section id="settings-plans"'));
  for (const id of ['learned-preferences', 'learned-enabled', 'learned-status', 'learned-list', 'learned-forget']) assert.match(section, new RegExp('id="' + id + '"'), id);
  assert.match(section, />What Arcane has learned</); assert.doesNotMatch(section, /\bstyle=|<script|\bon[a-z]+=/i);
  const start = css.indexOf('/* Learning from feedback'), end = css.indexOf('\n', css.indexOf('@media (forced-colors:active){.arcane-app :is(.feedback-button'));
  assert.ok(start > 0 && end > start && css.lastIndexOf('@media(prefers-reduced-motion:reduce)') > end, 'owned block sits before the final reduced-motion reset');
  assert.doesNotMatch(css.slice(start, end), /transition|animation|#[0-9a-f]{3,8}\b/i, 'shared tokens only; no motion');
  const studio = await readFile('apps/desktop/src/studio.ts', 'utf8');
  assert.ok(studio.includes('setChatFeedbackHooks(learned.hooks);'));
});

test('Edge: rate a build, explain it, get a Learning note from the next message, and review the learned panel', { skip: !browserModule, timeout: 120000 }, async t => {
  const build = process.env.ARCANE_UI_BUILD_DIR ?? 'dist', shots = resolve(process.env.ARCANE_UI_SCREENSHOT ?? 'runtime/claude-codex-team/claude-audit/learning');
  await mkdir(shots, { recursive: true });
  const root = await mkdtemp(join(tmpdir(), 'arcane-learned-ui-')); t.after(() => rm(root, { recursive: true, force: true }));
  const store = createPreferenceStore({ projectDirectory: join(root, 'project'), globalDirectory: join(root, 'global') });
  const routes = preferenceRoutes({ store, agent: () => false });
  const modules = ['codex-chat', 'chat-tabs', 'codex-history', 'provider-setup', 'workspace-shell', 'claude-chat', 'claude-preferences', 'task-usage', 'task-usage-ui', 'learned-preferences'];
  const fixture = `import {CodexChat,CodexChatApi} from '/codex-chat.js';
    import {startProviderSetup} from '/provider-setup.js';
    import {startWorkspaceShell} from '/workspace-shell.js';
    import {ClaudeChat,setChatFeedbackHooks} from '/claude-chat.js';
    import {startLearnedPreferences} from '/learned-preferences.js';
    const f = window.fx = { calls: [] };
    const chat = new CodexChat(document, new CodexChatApi('${TOKEN}'));
    const native = Object.freeze({ version: 1, ...Object.fromEntries(['status','login','install','launch'].map(action => [action, async provider =>
      ({ version: 1, provider, installed: true, auth: 'subscription', cliVersion: '2.1.177', busy: false, message: null })])) });
    const setup = startProviderSetup(document, { chat, nativeBridge: native });
    const bridge = Object.freeze({ version: 1,
      status: async () => ({ installed: true, signedIn: true, cliVersion: '2.1.177', models: ['opus'], efforts: ['low', 'medium', 'high'], defaultModel: 'opus', resolved: { opus: 'claude-opus-5-5' }, message: null }),
      list: async () => ({ conversations: [] }), history: async id => ({ conversationId: id, messages: [] }),
      send: async request => { f.calls.push(request); return { turnId: 'turn-' + f.calls.length, conversationId: 'conv-forest' }; },
      stop: async () => true, remove: async () => true, onEvent: listener => { f.emit = listener; return () => {}; } });
    const claude = new ClaudeChat(document, { bridge, storage: null });
    const learned = startLearnedPreferences(document, { token: () => '${TOKEN}' });
    setChatFeedbackHooks(learned.hooks);
    setup.subscribeChatSurface(() => { if (setup.chatSurface() === 'claude') { chat.yieldSurface(true); claude.activate(); f.refreshed = claude.refresh(); } else { claude.deactivate(); chat.yieldSurface(false); } });
    startWorkspaceShell(document);
    await chat.start(); f.ready = true;`;
  let origin = '';
  const server = createServer((request, response) => { void (async () => {
    const url = new URL(request.url ?? '/', origin);
    if (await routes.handle(request, response, url, TOKEN, origin)) return;
    const path = url.pathname;
    if (path === '/v1/codex/state') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ state: { provider: 'codex', connecting: false, closing: false, busy: false, actions: [], snapshot: null } })); return; }
    if (path === '/studio.js') { response.writeHead(200, { 'content-type': 'text/javascript' }); response.end(fixture); return; }
    const file = path === '/studio' ? 'apps/desktop/public/studio.html' : path === '/studio.css' ? 'apps/desktop/public/studio.css'
      : path.endsWith('.js') && modules.includes(path.slice(1, -3)) ? join(build, 'apps/desktop/src', path.slice(1)) : null;
    if (!file) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-type': path === '/studio' ? 'text/html' : path.endsWith('.css') ? 'text/css' : 'text/javascript' });
    response.end(await readFile(resolve(file)));
  })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); }); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
  origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  const { chromium } = await import(pathToFileURL(resolve(browserModule!)).href) as typeof import('playwright-core');
  const browser = await chromium.launch({ headless: true, args: ['--disable-gpu'], executablePath: process.env.ARCANE_UI_BROWSER_EXE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' }); page.setDefaultTimeout(8000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/studio');
  await page.waitForFunction(() => (window as any).fx?.ready === true);
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('workspace:providerpreference', { detail: { provider: 'claude' } })));
  await page.waitForFunction(() => !document.getElementById('claude-chat-tabs')!.hidden);
  await page.evaluate(() => (window as any).fx.refreshed);
  const composer = page.locator('#codex-composer');
  const turn = async (n: number, tools: [string, string, unknown, unknown][], reply: string) => page.evaluate(([n, tools, reply]) => {
    const fx = (window as any).fx, turnId = 'turn-' + n, conversationId = 'conv-forest';
    for (const [id, name, input, result] of tools) {
      fx.emit({ turnId, conversationId, type: 'tool', message: { id, role: 'tool', text: name, at: new Date().toISOString(), tool: { name, status: 'started', input: JSON.stringify(input) } } });
      fx.emit({ turnId, conversationId, type: 'tool', message: { id, role: 'tool', text: name, at: '', tool: { name, status: 'finished', result: JSON.stringify(result) } } });
    }
    fx.emit({ turnId, conversationId, type: 'message', message: { id: 'a' + n, role: 'assistant', text: reply, at: '' } });
    fx.emit({ turnId, conversationId, type: 'done', ok: true, error: null, usage: null });
  }, [n, tools, reply] as const);
  const parent = { instanceId: 'i', sessionId: 's', root: 'Workspace', pathSegments: ['Forest'], className: 'Folder' };
  const built = { commandId: 'cmd-1', state: 'succeeded', terminal: true, command: { method: 'scene.build', args: {}, result: { created: { count: 120 } } } };

  // Turn 1: a forest and a spawn plinth with defaults, plus a generated oak model and its preview card.
  await composer.fill('Build a forest with a spawn plinth'); await composer.press('Enter');
  await page.waitForFunction(() => (window as any).fx.calls.length === 1);
  await turn(1, [
    ['t1', 'assets_procedural', { name: 'oak-large', generator: { kind: 'tree', species: 'oak' } }, { jobId: 'job-oak', state: 'queued' }],
    ['t2', 'assets_preview', { jobId: 'job-oak', view: 'hero' }, { jobId: 'job-oak', view: 'hero' }],
    ['t3', 'scene_build', { parent, name: 'Forest', kits: [{ kind: 'forest', at: [0, 0, 0], radius: 100, seed: 3 }, { kind: 'plinth', at: [0, 0, 0], seed: 1 }] }, built],
  ], 'Built the forest and the spawn plinth.');
  const row = page.locator('#codex-messages .turn-feedback').last();
  await row.waitFor();
  assert.equal(await row.getAttribute('aria-label'), 'Rate this result');
  assert.equal(await row.locator('.feedback-button').count(), 2);
  assert.equal(await page.locator('#codex-messages .model-feedback').count(), 1, 'the generated-model card has its own rating');
  await row.screenshot({ path: join(shots, 'feedback-controls.png') });
  // Thumbs down opens the optional reason; sending it learns and says what changes next time.
  await row.locator('[data-vote=down]').click();
  assert.equal(await row.locator('[data-vote=down]').getAttribute('aria-pressed'), 'true');
  await row.locator('.feedback-reason-input').fill('too plain, the stone is boring');
  await page.locator('#codex-messages').evaluate(box => { box.scrollTop = box.scrollHeight; });
  await row.screenshot({ path: join(shots, 'feedback-reason.png') });
  await row.locator('.feedback-send').click();
  await page.waitForFunction(() => /Got it/.test(document.querySelector('#codex-messages .turn-feedback:last-of-type .feedback-status')?.textContent ?? '') ||
    /Got it/.test([...document.querySelectorAll('#codex-messages .turn-feedback .feedback-status')].pop()?.textContent ?? ''));
  const status = await row.locator('.feedback-status').textContent();
  assert.match(status ?? '', /^Got it — I'll avoid .*plain stone/);
  await page.locator('#codex-messages').evaluate(box => { box.scrollTop = box.scrollHeight; });
  await page.locator('#codex-messages').screenshot({ path: join(shots, 'feedback-learned.png') });

  // Turn 2: the next message is read as feedback on turn 1 and a Learning note appears under it.
  await composer.fill('the trees all look the same'); await composer.press('Enter');
  await page.waitForFunction(() => (window as any).fx.calls.length === 2);
  const note = page.locator('#codex-messages .learning-note');
  await note.waitFor();
  assert.match(await note.innerText(), /Learning\s*Got it — I'll /);
  await turn(2, [['t4', 'scene_build', { parent, name: 'Forest', scatter: [{ use: 'oak', count: 40, center: [0, 0, 0], minSpacing: 6 }] }, built]], 'Rebuilt with more variety.');
  await page.waitForFunction(() => document.querySelectorAll('#codex-messages .turn-feedback').length === 2);
  await page.locator('#codex-messages').evaluate(box => { box.scrollTop = box.scrollHeight; });
  await page.locator('#codex-messages').screenshot({ path: join(shots, 'learning-note.png') });

  // Settings > What Arcane has learned lists the preferences with evidence and controls.
  await page.evaluate(() => {
    (document.getElementById('settings-drawer') as HTMLDialogElement).showModal();
    for (const pane of document.querySelectorAll<HTMLElement>('[data-settings-section]')) pane.hidden = pane.id !== 'settings-memory';
  });
  const items = page.locator('#learned-list .learned-item');
  await items.first().waitFor();
  const labels = await page.locator('#learned-list .learned-label').allInnerTexts();
  assert.ok(labels.some(label => /plain stone; use ashlar with weathering/.test(label)), labels.join(' | '));
  assert.ok(labels.some(label => /identical trees/.test(label)), labels.join(' | '));
  assert.match(await page.locator('#learned-list .learned-meta').first().innerText(), /signals? · (this|all) project/);
  assert.equal(await page.locator('#learned-enabled').isChecked(), true);
  await page.locator('#learned-preferences').scrollIntoViewIfNeeded();
  await page.locator('#learned-preferences').screenshot({ path: join(shots, 'learned-panel.png') });
  // Edit: Avoid a liked item; Remove one; Forget all needs a second click.
  const liked = page.locator('#learned-list .learned-item[data-stance=like]').first(), likedId = await liked.getAttribute('data-id');
  await liked.locator('.learned-action', { hasText: 'Avoid' }).click();
  await page.waitForFunction(id => document.querySelector<HTMLElement>(`#learned-list .learned-item[data-id="${id}"]`)?.dataset.stance === 'dislike', likedId);
  assert.match(await page.locator('#learned-status').innerText(), /Saved\. Arcane will follow this/);
  const bias = await store.bias();
  assert.equal(bias.prefer['scatter.variation'], 'varied'); assert.ok(bias.avoid['stone.surface']?.includes('plain'));
  await page.locator('#learned-enabled').click();
  await page.waitForFunction(() => /Learning is off/.test(document.getElementById('learned-status')?.textContent ?? ''));
  assert.equal(await store.context(), '', 'off: nothing is used');
  await page.locator('#learned-enabled').click();
  await page.waitForFunction(() => /Learning is on/.test(document.getElementById('learned-status')?.textContent ?? ''));
  await page.locator('#learned-forget').click();
  assert.equal(await page.locator('#learned-forget').innerText(), 'Click again to forget everything');
  await page.locator('#learned-forget').click();
  await page.waitForFunction(() => /Forgotten/.test(document.getElementById('learned-status')?.textContent ?? ''));
  assert.equal(await items.count(), 0);
  assert.equal((await store.snapshot()).project.length, 0);
  assert.equal(await page.evaluate(() => Object.keys(localStorage).filter(key => /learn|prefer/i.test(key)).length + Object.keys(sessionStorage).filter(key => /learn|prefer/i.test(key)).length), 0, 'nothing in browser storage');
  // Light theme of the panel and the feedback row.
  await page.emulateMedia({ colorScheme: 'light' });
  await page.locator('#learned-preferences').screenshot({ path: join(shots, 'learned-panel-empty-light.png') });
  assert.deepEqual(errors, []);
});
