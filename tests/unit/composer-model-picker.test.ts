/// <reference lib="dom" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';
import { CodexChat, CodexChatApi, type ChatState, type ChatAction, type ChatActionRecord } from '../../apps/desktop/src/codex-chat.js';
import { workflowNativeModel } from '../../apps/daemon/src/workflow-native-model.js';

const TOKEN = 'a'.repeat(64), browserModule = process.env.ARCANE_UI_BROWSER_MODULE;
function state(): ChatState {
  const result: ChatState = {
    provider: 'codex', use: 'personal-local', projectPath: resolve('.'), connecting: false, closing: false, busy: false,
    actions: [], lastSnapshot: null, nativeTools: { configured: true, verified: false },
    nativeAssets: { available: true, sealed: true, granted: true, admissionOpen: true },
    snapshot: {
      connectionId: randomUUID(), provenance: 'spawned-node-fixture', connected: true, ready: true,
      account: { auth: 'subscription', plan: 'fixture', requiresOpenaiAuth: true },
      models: [
        { model: 'fixture-alpha', id: 'opaque-alpha', displayName: 'Fixture Alpha', efforts: ['low', 'ultra'], defaultEffort: 'low', entitlement: 'unverified' },
        { model: 'fixture-beta', id: 'opaque-beta', displayName: 'Fixture Beta <img src=x onerror=alert(1)>', efforts: ['medium', 'high'], defaultEffort: 'high', entitlement: 'unverified' },
      ],
      selection: { model: 'fixture-alpha', effort: 'low' },
      thread: { threadId: 'fixture-thread', sessionId: 'fixture-session', selection: { model: 'fixture-alpha', effort: 'low' }, configured: true, writeGranted: true, turnId: null, turnStatus: 'idle' },
      operations: [], approvals: [], events: [], droppedEvents: 0, lastEventSeq: 0, failureCode: null,
    },
  };
  result.workflowModel = workflowNativeModel(result)!.proof;
  return result;
}
function receipt(input: ChatAction, status: ChatActionRecord['state'] = 'acknowledged'): ChatActionRecord {
  assert.ok(input.action === 'select' || input.action === 'turn-interrupt');
  return { requestId: input.requestId, connectionId: input.connectionId, action: input.action,
    threadId: input.action === 'turn-interrupt' ? input.threadId : null, turnId: input.action === 'turn-interrupt' ? input.turnId : null,
    model: input.action === 'select' ? input.model : null, effort: input.action === 'select' ? input.effort : null,
    state: status, errorCode: status === 'rejected' ? 'FIXTURE_REJECTED' : null,
    createdAt: new Date().toISOString(), finishedAt: status === 'acknowledged' || status === 'rejected' ? new Date().toISOString() : null };
}

// A legacy document with no picker/setup markup: presentation hooks remain optional.
class LegacyElement {
  value = ''; checked = false; disabled = false; hidden = false; open = false; type = ''; className = '';
  dataset: Record<string, string> = {}; children: LegacyElement[] = []; scrollHeight = 0; scrollTop = 0; clientHeight = 0;
  private content = ''; private attributes = new Map<string, string>();
  get textContent(): string { return this.content + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.content = value; this.children = []; }
  append(...children: LegacyElement[]) { this.children.push(...children); }
  replaceChildren(...children: LegacyElement[]) { this.content = ''; this.children = children; }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  // This fixture reads presentation state and never dispatches user input.
  addEventListener(_type: string, _listener: EventListener): void {}
  querySelectorAll() { return []; }
  close() { this.open = false; }
}
class LegacyDocument {
  private elements = new Map<string, LegacyElement>();
  getElementById(id: string) {
    let value = this.elements.get(id); if (!value) { value = new LegacyElement(); this.elements.set(id, value); } return value;
  }
  createElement() { return new LegacyElement(); }
}

test('provider status is validated presentation data, preserves unknown, and publishes stale/stop changes without actions', async () => {
  const doc = new LegacyDocument(); let observed = state(), fail = false, calls = 0;
  const chat = new CodexChat(doc as unknown as Document, new CodexChatApi(TOKEN, async (_path, init) => {
    assert.equal(init?.method, 'GET'); calls++; if (fail) throw new Error('Fixture unavailable'); return Response.json({ state: observed });
  }));
  assert.equal(chat.providerConnectionStatus(), null);
  const statuses: ReturnType<CodexChat['providerConnectionStatus']>[] = [];
  const unsubscribe = chat.subscribeProviderStateChange(() => statuses.push(chat.providerConnectionStatus()));
  // A failing presentation callback must not invalidate the native lifecycle.
  chat.subscribeProviderStateChange(() => { throw new Error('Fixture observer failure'); });
  await chat.refresh();
  assert.deepEqual(chat.providerConnectionStatus(), { connected: true, ready: true, fresh: true, auth: 'subscription' });
  const detached = chat.providerConnectionStatus()!; detached.auth = 'signed-out';
  assert.equal(chat.providerConnectionStatus()!.auth, 'subscription');
  fail = true; await chat.refresh(); assert.equal(statuses.at(-1)!.fresh, false); assert.equal(statuses.at(-1)!.auth, 'subscription');
  fail = false; observed.snapshot!.account = null; delete observed.workflowModel; await chat.refresh();
  assert.equal(statuses.at(-1)!.auth, 'unknown');
  observed.snapshot!.account = { auth: 'signed-out', plan: null, requiresOpenaiAuth: true }; await chat.refresh();
  assert.equal(statuses.at(-1)!.auth, 'signed-out');
  observed.lastSnapshot = observed.snapshot; observed.snapshot = null; await chat.refresh();
  assert.deepEqual(statuses.at(-1), { connected: false, ready: false, fresh: true, auth: 'unknown' });
  chat.stop(); assert.equal(statuses.at(-1)!.fresh, false);
  const count = statuses.length; unsubscribe(); observed = state(); chat.resume(); await chat.refresh(); chat.stop();
  assert.equal(statuses.length, count); assert.ok(calls >= 6);
});

test('markup exposes exact setup/preview hooks and a hidden nonmodal picker with only Codex/Claude setup choices', async () => {
  const html = await readFile(resolve('apps/desktop/public/studio.html'), 'utf8');
  const ids = ['provider-setup-panel', 'provider-setup-provider', 'provider-setup-status', 'provider-setup-refresh', 'provider-setup-login', 'provider-setup-install', 'provider-setup-launch',
    'provider-login-gate', 'provider-login-message', 'provider-login-codex', 'provider-login-claude', 'provider-login-start', 'provider-login-refresh',
    'workspace-preview-toggle', 'workspace-preview-close', 'codex-model-trigger', 'codex-model-popover', 'codex-model', 'codex-effort', 'codex-select',
    'codex-picker-summary', 'codex-picker-current-model', 'codex-picker-model-list', 'codex-picker-back', 'codex-picker-effort-slider', 'codex-picker-reset'];
  for (const id of ids) assert.equal(html.split('id="' + id + '"').length - 1, 1, id);
  assert.match(html, /id="artifact-panel"[^>]*\bhidden/);
  const gate = html.match(/<section[^>]*id="provider-login-gate"[^>]*>/)![0];
  assert.doesNotMatch(gate, /\bhidden\b/); assert.match(gate, /aria-labelledby="provider-login-heading"/);
  assert.match(html, /id="provider-login-start"[^>]*disabled/);
  assert.match(html, /id="codex-model-popover"[^>]*role="dialog"[^>]*aria-modal="false"[^>]*hidden/);
  const implementation = html.match(/<div[^>]*class="composer-model-state"[^>]*>([\s\S]*?)<\/div>/);
  assert.ok(implementation); assert.match(implementation[0], /\bhidden\s+inert\s+aria-hidden="true"/);
  for (const id of ['codex-model', 'codex-effort', 'codex-select']) assert.match(implementation[1]!, new RegExp('id="' + id + '"'));
  assert.ok(html.indexOf(implementation[0]) > html.indexOf('id="codex-model-popover"'));
  assert.match(html, /id="codex-picker-effort-slider"[^>]*type="range"[^>]*step="1"/);
  assert.match(html, /id="codex-picker-model-list"[^>]*hidden/);
  assert.match(html, /id="codex-picker-apply"[^>]*hidden/);
  const select = html.match(/<select id="provider-setup-provider">([\s\S]*?)<\/select>/)![1]!;
  assert.deepEqual([...select.matchAll(/value="([^"]+)"/g)].map(match => match[1]), ['codex', 'claude']);
});

async function browserFixture(t: test.TestContext, initial = state()) {
  // Real product HTML/CSS/controllers with synthetic HTTP state and receipts.
  // This verifies browser delegation, never installed CLI inference or entitlement.
  let observed = structuredClone(initial), readFailed = false;
  const posts: ChatAction[] = [], errors: string[] = [];
  let handler: ((input: ChatAction) => Promise<{ record: ChatActionRecord; state: ChatState }>) | null = null;
  const files = new Map([
    ['/studio', [resolve('apps/desktop/public/studio.html'), 'text/html']], ['/studio.css', [resolve('apps/desktop/public/studio.css'), 'text/css']],
    ['/codex-chat.js', [resolve(process.env.ARCANE_UI_BUILD_DIR ?? 'dist', 'apps/desktop/src/codex-chat.js'), 'text/javascript']],
    ['/workspace-shell.js', [resolve(process.env.ARCANE_UI_BUILD_DIR ?? 'dist', 'apps/desktop/src/workspace-shell.js'), 'text/javascript']],
    ['/chat-tabs.js', [resolve(process.env.ARCANE_UI_BUILD_DIR ?? 'dist', 'apps/desktop/src/chat-tabs.js'), 'text/javascript']],
    ['/codex-history.js', [resolve(process.env.ARCANE_UI_BUILD_DIR ?? 'dist', 'apps/desktop/src/codex-history.js'), 'text/javascript']],
    ['/provider-setup.js', [resolve(process.env.ARCANE_UI_BUILD_DIR ?? 'dist', 'apps/desktop/src/provider-setup.js'), 'text/javascript']],
  ]);
  const server = createServer((request, response) => { void (async () => {
    if (request.url === '/picker-fixture.js') {
      response.writeHead(200, { 'content-type': 'text/javascript' });
      response.end(`import {CodexChat,CodexChatApi} from '/codex-chat.js';
        import {startWorkspaceShell} from '/workspace-shell.js';
        import {startProviderSetup} from '/provider-setup.js';
        const chat = new CodexChat(document,new CodexChatApi('${TOKEN}')); window.fixtureChat=chat;
        window.fixtureSetup=startProviderSetup(document,{chat});
        window.fixtureProviderStates=[]; chat.subscribeProviderStateChange(()=>window.fixtureProviderStates.push(chat.providerConnectionStatus()));
        window.fixtureSetupChoices=[]; document.addEventListener('workspace:providersetup',e=>window.fixtureSetupChoices.push(e.detail));
        window.fixtureEnableSettings=()=>startWorkspaceShell(document);
        await chat.start(); window.fixtureReady=true;`); return;
    }
    if (request.url === '/v1/codex/state') {
      response.writeHead(readFailed ? 503 : 200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(readFailed ? { error: 'FIXTURE_READ_UNAVAILABLE' } : { state: observed })); return;
    }
    if (request.url === '/v1/codex/action') {
      assert.equal(request.headers.authorization, 'Bearer ' + TOKEN);
      let body = ''; for await (const chunk of request) body += String(chunk);
      const input = JSON.parse(body) as ChatAction; posts.push(input);
      assert.ok(input.action === 'select' || input.action === 'turn-interrupt', 'Picker/Stop must never start native work');
      let outcome;
      if (handler) outcome = await handler(input);
      else {
        if (input.action === 'select') {
          observed.snapshot!.selection = { model: input.model, effort: input.effort };
          if (observed.snapshot!.thread) observed.snapshot!.thread!.selection = { model: input.model, effort: input.effort };
          const proof = workflowNativeModel(observed)?.proof;
          if (proof) observed.workflowModel = proof; else delete observed.workflowModel;
        } else {
          assert.equal(input.connectionId, observed.snapshot!.connectionId);
          assert.equal(input.threadId, observed.snapshot!.thread!.threadId);
          assert.equal(input.turnId, observed.snapshot!.thread!.turnId);
          assert.equal(observed.snapshot!.thread!.configured, true);
          observed.snapshot!.thread!.turnStatus = 'interrupted';
        }
        const record = receipt(input); observed.actions = [record, ...observed.actions]; outcome = { record, state: observed };
      }
      response.writeHead(outcome.record.state === 'acknowledged' ? 200 : outcome.record.state === 'rejected' ? 409 : 202, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ...outcome, replayed: false })); return;
    }
    const file = files.get(request.url ?? ''); if (!file) { response.writeHead(404); response.end(); return; }
    let bytes = await readFile(file[0]!);
    if (request.url === '/studio') bytes = Buffer.from(bytes.toString().replace('src="/studio.js"', 'src="/picker-fixture.js"'));
    response.writeHead(200, { 'content-type': file[1]!, 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'" }); response.end(bytes);
  })().catch(error => { errors.push(String(error)); response.writeHead(500); response.end(); }); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const playwright = await import(pathToFileURL(resolve(browserModule!)).href) as typeof import('playwright-core');
  const browser = await playwright.chromium.launch({ headless: true, args: ['--disable-gpu'],
    ...(process.env.ARCANE_UI_BROWSER_EXE ? { executablePath: process.env.ARCANE_UI_BROWSER_EXE } : process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(5000);
  page.on('pageerror', (error: Error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.goto('http://127.0.0.1:' + address.port + '/studio');
  try { await page.waitForFunction(() => (window as any).fixtureReady === true); }
  catch (error) { t.diagnostic('Controller fixture mount: ' + JSON.stringify({ errors, notice: await page.locator('#codex-notice').textContent() })); throw error; }
  const refresh = () => page.evaluate(() => (window as any).fixtureChat.refresh());
  const open = async () => { await page.locator('#codex-model-trigger').click(); await page.locator('#codex-picker-summary').waitFor(); };
  const list = async () => {
    await page.locator('#codex-picker-current-model').click(); await page.locator('#codex-model-search').waitFor();
  };
  const choose = async (model = 'fixture-beta') => {
    await open(); await list(); await page.locator('#codex-model-options [data-picker-model="' + model + '"]').click();
  };
  const settled = async () => page.waitForFunction(() => document.getElementById('codex-model-trigger')?.getAttribute('aria-busy') === 'false' &&
    !(document.getElementById('codex-model-trigger') as HTMLButtonElement).disabled && document.getElementById('codex-notice')?.textContent === 'Model updated.');
  return { page, posts, refresh, open, list, choose, settled, observed: () => structuredClone(observed), set: (value: ChatState) => { observed = structuredClone(value); },
    fail: (value: boolean) => { readFailed = value; }, handler: (value: typeof handler) => { handler = value; } };
}

test('browser chip opens reasoning; model list searches reported rows and returns to summary with guarded autoapply', { skip: !browserModule, timeout: 30000 }, async t => {
  const f = await browserFixture(t), { page } = f;
  const draft = 'Unsent draft 🧩\nKeep whitespace.  '; await page.locator('#codex-composer').fill(draft);
  await f.open();
  assert.equal(await page.locator('#codex-picker-summary').isVisible(), true);
  assert.equal(await page.locator('#codex-picker-model-list').isVisible(), false);
  assert.equal(await page.locator('#codex-picker-effort-slider').evaluate(el => el === document.activeElement), true);
  assert.equal(await page.locator('#codex-picker-effort-value').textContent(), 'Low');
  assert.equal(await page.locator('#codex-picker-effort-slider').getAttribute('type'), 'range');
  assert.equal(await page.locator('#codex-picker-effort-slider').getAttribute('max'), '1');
  assert.equal(await page.locator('#codex-picker-efforts').isVisible(), false);
  assert.equal(await page.locator('#codex-picker-apply').isVisible(), false);
  assert.equal(f.posts.length, 0);
  await f.list();
  assert.equal(await page.locator('#codex-picker-summary').isVisible(), false);
  assert.equal(await page.locator('#codex-picker-current-model').getAttribute('aria-expanded'), 'true');
  assert.equal(await page.locator('#codex-model-search').evaluate(el => el === document.activeElement), true);
  assert.equal(await page.locator('#codex-model-search').evaluate((el: HTMLInputElement) => el.form === null), true);
  assert.deepEqual(await page.locator('#codex-model-options button').evaluateAll(rows => rows.map(row => (row as HTMLElement).dataset.pickerModel)), ['fixture-alpha', 'fixture-beta']);
  assert.equal(await page.locator('#codex-model-options small').count(), 0);
  assert.equal(await page.locator('#codex-model-options [aria-selected=true] .picker-selected-check[data-selected=true]').count(), 1);
  assert.equal(await page.locator('#codex-model-options button[tabindex="0"]').count(), 1);
  await page.locator('#codex-model-search').fill('BETA fixture');
  assert.equal(await page.locator('#codex-model-options button').count(), 1);
  assert.equal(await page.locator('#codex-model-options button').getAttribute('title'), 'fixture-beta');
  assert.equal(await page.locator('#codex-model-popover img').count(), 0, 'Reported names are text, never HTML');
  await page.locator('#codex-model-search').press('ArrowDown'); await page.keyboard.press('Enter');
  await f.settled();
  assert.equal(await page.locator('#codex-picker-summary').evaluate(el => (el as HTMLElement).hidden), false);
  assert.equal(await page.locator('#codex-picker-model-list').isVisible(), false);
  assert.equal(await page.locator('#codex-model-popover').getAttribute('data-view'), 'reasoning');
  assert.equal(await page.locator('#codex-model').inputValue(), 'fixture-beta');
  assert.equal(await page.locator('#codex-effort').inputValue(), 'high', 'A model change uses this model\'s reported default');
  assert.deepEqual(await page.locator('#codex-effort option').evaluateAll(rows => rows.map(row => (row as HTMLOptionElement).value).filter(Boolean)), ['medium', 'high']);
  assert.equal(await page.locator('#codex-select').isDisabled(), true, 'The acknowledged pair is not applied twice');
  assert.equal(f.posts.length, 1); assert.equal(f.posts[0]!.action, 'select');
  await f.open(); assert.equal(await page.locator('#codex-picker-effort-slider').isDisabled(), false);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#codex-model-popover').isVisible(), false);
  assert.equal(await page.locator('#codex-model-trigger').evaluate(el => el === document.activeElement), true);
  await f.open(); await f.list(); await page.locator('#codex-model-search').fill('not-reported');
  assert.equal(await page.locator('#codex-model-options button').count(), 0);
  assert.equal(await page.locator('#codex-model-empty').isVisible(), true);
  await page.locator('#codex-model-search').press('Enter'); assert.equal(f.posts.length, 1);
  await page.locator('#codex-model-search').evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true })));
  assert.equal(await page.locator('#codex-picker-model-list').isVisible(), true, 'IME Escape does not navigate');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#codex-model-popover').isVisible(), true);
  assert.equal(await page.locator('#codex-picker-summary').isVisible(), true);
  assert.equal(await page.locator('#codex-picker-current-model').evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#codex-model-popover').isVisible(), false);
  await f.open(); await f.list(); await page.locator('#codex-picker-back').click();
  assert.equal(await page.locator('#codex-picker-current-model').evaluate(el => el === document.activeElement), true);
  await page.locator('#codex-composer').click(); assert.equal(await page.locator('#codex-model-popover').isVisible(), false);
  await f.open(); await page.locator('#codex-composer').focus();
  assert.equal(await page.locator('#codex-model-popover').isVisible(), false);
  assert.equal(await page.locator('#codex-composer').inputValue(), draft); assert.deepEqual(f.posts.map(input => input.action), ['select']);
});

test('browser native reasoning change applies an exact pair once and rechoosing it is a no-op after resume', { skip: !browserModule, timeout: 30000 }, async t => {
  const f = await browserFixture(t), { page } = f;
  await f.open(); await page.locator('#codex-picker-effort-slider').press('End'); await f.settled();
  assert.equal(f.posts.length, 1);
  assert.deepEqual(f.posts[0], { requestId: f.posts[0]!.requestId, connectionId: f.observed().snapshot!.connectionId, action: 'select', model: 'fixture-alpha', effort: 'ultra' });
  assert.equal(await page.locator('#codex-effort-label').textContent(), 'ultra');
  await f.open(); await f.list(); await page.locator('[data-picker-model="fixture-alpha"]').click();
  assert.equal(await page.locator('#codex-picker-summary').isVisible(), true);
  assert.equal(await page.locator('#codex-picker-model-list').isVisible(), false);
  assert.equal(f.posts.length, 1, 'Rechoosing the acknowledged pair is a no-op');
  await page.keyboard.press('Escape');
  await page.evaluate(() => { (window as any).fixtureChat.stop(); (window as any).fixtureChat.resume(); }); await f.refresh();
  await f.open(); await page.locator('#codex-picker-effort-slider').press('Home'); await f.settled();
  assert.equal(f.posts.length, 2, 'Resume binds a single model selection handler');
});

test('browser native range previews on trusted input and commits once on change; reset uses the reported default', { skip: !browserModule, timeout: 30000 }, async t => {
  const f = await browserFixture(t), { page } = f;
  await page.locator('#codex-composer').fill('Preserve the range draft.  '); await f.open();
  await page.locator('#codex-picker-effort-slider').evaluate(el => {
    (window as any).fixtureRangeEvents = [];
    for (const type of ['input', 'change']) el.addEventListener(type, event => (window as any).fixtureRangeEvents.push({ type: event.type, trusted: event.isTrusted }));
  });
  const range = await page.locator('#codex-picker-effort-slider').boundingBox(); assert.ok(range);
  await page.mouse.move(range.x + range.width - 2, range.y + range.height / 2); await page.mouse.down();
  t.after(() => page.mouse.up().catch(() => {}));
  assert.equal(await page.locator('#codex-picker-effort-value').textContent(), 'Ultra');
  assert.equal(await page.locator('#codex-picker-effort-slider').getAttribute('aria-valuetext'), 'Ultra');
  assert.equal(await page.locator('#codex-effort').inputValue(), 'ultra');
  assert.equal(await page.locator('#codex-effort-label').textContent(), 'low');
  assert.equal(f.observed().snapshot!.selection!.effort, 'low'); assert.equal(f.posts.length, 0);
  await page.mouse.up(); await f.settled();
  assert.equal(f.posts.length, 1); assert.equal(f.posts[0]!.action, 'select');
  assert.deepEqual(await page.evaluate(() => (window as any).fixtureRangeEvents), [{ type: 'input', trusted: true }, { type: 'change', trusted: true }]);
  await f.open(); await page.locator('#codex-picker-reset').click(); await f.settled();
  assert.equal(f.posts.length, 2); assert.equal(f.posts[1]!.action, 'select');
  assert.equal((f.posts[1] as Extract<ChatAction, { action: 'select' }>).effort, 'low');
  assert.equal(await page.locator('#codex-effort-label').textContent(), 'low');
  await f.open(); await page.locator('#codex-picker-reset').click(); assert.equal(f.posts.length, 2, 'Resetting the current default is a no-op');
  await page.locator('#codex-picker-effort-slider').focus(); await page.keyboard.press('ArrowRight'); await f.settled();
  assert.equal(f.posts.length, 3, 'Native keyboard range change commits once');
  assert.equal(await page.locator('#codex-composer').inputValue(), 'Preserve the range draft.  ');
});

test('browser select waits for ACK, preserves grants/drafts and requires provenance review after the actual model changes', { skip: !browserModule, timeout: 30000 }, async t => {
  const initial = state(), f = await browserFixture(t, initial), { page } = f;
  const origin = { projectPath: initial.projectPath, projectId: 'b'.repeat(64), workflowId: 'fixture-workflow', workflowRevision: 1, stepKey: 'requirements',
    conversation: { provider: 'codex', threadId: 'fixture-thread', sessionId: 'fixture-session' }, model: initial.workflowModel!.selection };
  assert.equal(await page.evaluate(origin => (window as any).fixtureChat.appendWorkflowDraft('Workflow draft, preserve every byte.  ', origin), origin), true);
  const draft = await page.locator('#codex-composer').inputValue();
  let release!: () => void; const held = new Promise<void>(done => { release = done; }); t.after(() => release());
  f.handler(async input => { await held; const next = f.observed(); assert.equal(input.action, 'select');
    next.snapshot!.selection = { model: input.model, effort: input.effort }; next.snapshot!.thread!.selection = { ...next.snapshot!.selection };
    next.workflowModel = workflowNativeModel(next)!.proof; const record = receipt(input); next.actions = [record]; f.set(next); return { record, state: next }; });
  await f.choose();
  await page.waitForFunction(() => document.getElementById('codex-model-trigger')?.getAttribute('aria-busy') === 'true');
  assert.equal(await page.locator('#codex-model-label').textContent(), 'Fixture Alpha');
  assert.equal(await page.locator('#codex-model-trigger').isDisabled(), true);
  assert.equal(await page.locator('#codex-model-popover').isVisible(), false);
  assert.equal(await page.locator('#codex-composer').inputValue(), draft);
  release(); await f.settled();
  assert.equal(f.posts.length, 1); assert.equal(f.posts[0]!.action, 'select');
  assert.equal(await page.locator('#codex-model').inputValue(), 'fixture-beta'); assert.equal(await page.locator('#codex-effort').inputValue(), 'high');
  assert.equal(await page.locator('#codex-composer').inputValue(), draft); assert.equal(await page.locator('#codex-draft-review').isVisible(), true);
  assert.equal(await page.locator('#codex-submit').isDisabled(), true); assert.equal(f.observed().snapshot!.thread!.writeGranted, true);
  assert.deepEqual(f.observed().nativeAssets, initial.nativeAssets); assert.equal(f.observed().snapshot!.thread!.threadId, initial.snapshot!.thread!.threadId);
  await page.locator('#codex-draft-review-button').click(); await page.locator('#codex-confirm-check').check(); await page.locator('#codex-confirm-submit').click();
  await page.waitForFunction(() => !(document.getElementById('codex-submit') as HTMLButtonElement).disabled);
  assert.equal(f.posts.length, 1, 'Draft context review never submits a turn');
});

test('browser pre-thread model choice uses only the visible chat picker and starts no thread', { skip: !browserModule, timeout: 30000 }, async t => {
  const initial = state(); initial.snapshot!.thread = null; initial.snapshot!.selection = null; delete initial.workflowModel;
  const f = await browserFixture(t, initial), { page } = f;
  await page.locator('#codex-composer').fill('A draft before the thread exists.');
  assert.equal(await page.locator('#codex-model-label').textContent(), 'Choose model');
  await f.choose('fixture-alpha'); await f.settled();
  assert.equal(await page.locator('#codex-effort-label').textContent(), 'low');
  assert.equal(f.observed().snapshot!.thread, null); assert.equal(f.posts.length, 1);
  await page.evaluate(() => {
    (window as any).fixtureEnableSettings();
    document.dispatchEvent(new CustomEvent('workspace:settingsrequest', { detail: { target: 'native-conversation-heading' } }));
  });
  assert.equal(await page.locator('#settings-drawer').evaluate((drawer: HTMLDialogElement) => drawer.matches(':modal')), true);
  assert.equal(await page.locator('#settings-drawer [data-settings-section]:visible').count(), 1);
  assert.equal(await page.locator('#settings-advanced').isVisible(), true);
  for (const id of ['codex-model', 'codex-effort', 'codex-select']) {
    assert.equal(await page.locator('#' + id).isVisible(), false, id + ' is an implementation field');
  }
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'native-conversation-heading');
  await page.locator('[data-settings-close]').click();
  await f.choose('fixture-beta'); await f.settled();
  assert.equal(await page.locator('#codex-model-trigger').isVisible(), true);
  assert.match((await page.locator('#codex-model-label').textContent())!, /Fixture Beta/);
  assert.equal(await page.locator('#codex-effort-label').textContent(), 'high');
  assert.equal(await page.locator('#codex-composer').inputValue(), 'A draft before the thread exists.');
  assert.equal(f.observed().snapshot!.thread, null); assert.equal(f.posts.length, 2);
});

test('browser rejects optimistic labels and blocks busy, unconfigured, stale and unresolved select actions', { skip: !browserModule, timeout: 30000 }, async t => {
  const f = await browserFixture(t), { page } = f;
  f.handler(async input => { const record = receipt(input, 'rejected'), next = f.observed(); next.actions = [record]; f.set(next); return { record, state: next }; });
  await f.choose();
  await page.waitForFunction(() => document.getElementById('codex-notice')?.textContent?.includes('rejected'));
  assert.equal(await page.locator('#codex-model-label').textContent(), 'Fixture Alpha'); assert.equal(f.posts.length, 1);
  const baseline = f.observed();
  for (const guard of ['busy', 'unconfigured', 'starting', 'inProgress', 'cancelling', 'unknown', 'limited', 'disconnected', 'notReady', 'connecting', 'closing'] as const) {
    const next = structuredClone(baseline); delete next.workflowModel;
    if (guard === 'busy') next.busy = true; else if (guard === 'unconfigured') next.snapshot!.thread!.configured = false;
    else if (guard === 'limited') next.displayLimited = true; else if (guard === 'disconnected') next.snapshot!.connected = false;
    else if (guard === 'notReady') next.snapshot!.ready = false; else if (guard === 'connecting') next.connecting = true; else if (guard === 'closing') next.closing = true;
    else next.snapshot!.thread!.turnStatus = guard;
    f.set(next); await f.refresh(); assert.equal(await page.locator('#codex-model-trigger').isDisabled(), true, guard);
    await page.locator('#codex-model-trigger').dispatchEvent('click');
    assert.equal(await page.locator('#codex-model-popover').isVisible(), false, guard);
    assert.equal(f.posts.length, 1, guard);
  }
  f.set(baseline); await f.refresh(); await f.open(); f.fail(true); await f.refresh();
  assert.equal(await page.locator('#codex-model-popover').isVisible(), false); assert.equal(await page.locator('#codex-model-trigger').isDisabled(), true);
  f.fail(false); await f.refresh();
  f.handler(async input => { const record = receipt(input, 'unknown'), next = f.observed(); next.actions = [record]; f.set(next); return { record, state: next }; });
  await f.choose(); await page.locator('#codex-unknown').waitFor();
  assert.equal(await page.locator('#codex-model-label').textContent(), 'Fixture Alpha'); assert.equal(await page.locator('#codex-model-trigger').isDisabled(), true);
  await f.refresh(); assert.equal(f.posts.length, 2); assert.equal(await page.locator('#codex-acknowledge').isDisabled(), true);
});

test('browser auth gate hides composer and prevents opening the picker for disconnected, unknown and unsupported accounts', { skip: !browserModule, timeout: 30000 }, async t => {
  const initial = state(); initial.snapshot = null; delete initial.workflowModel;
  const f = await browserFixture(t, initial), { page } = f;
  for (const auth of ['disconnected', 'signed-out', 'unsupported', 'unknown', 'notReady'] as const) {
    const next = state(); delete next.workflowModel;
    if (auth === 'disconnected') next.snapshot = null;
    else if (auth === 'unknown') next.snapshot!.account = null;
    else if (auth === 'notReady') next.snapshot!.ready = false;
    else next.snapshot!.account = { auth, plan: null, requiresOpenaiAuth: true };
    f.set(next); await f.refresh();
    assert.equal(await page.locator('#provider-login-gate').isVisible(), true, auth);
    assert.equal(await page.locator('#workspace-stage').evaluate(el => el.classList.contains('provider-required')), true, auth);
    assert.equal(await page.locator('#codex-compose').isVisible(), false, auth);
    assert.equal(await page.locator('#artifact-panel').isVisible(), false, auth);
    assert.equal(await page.locator('#codex-model-trigger').isDisabled(), true, auth);
    await page.locator('#codex-model-trigger').dispatchEvent('click');
    assert.equal(await page.locator('#codex-model-popover').isVisible(), false, auth); assert.equal(f.posts.length, 0);
  }
  assert.equal(await page.locator('#provider-login-start').isDisabled(), true, 'No native setup bridge in this controller fixture');
  f.set(state()); await f.refresh();
  assert.equal(await page.locator('#provider-login-gate').isVisible(), false);
  assert.equal(await page.locator('#codex-compose').isVisible(), true);
  await f.open(); assert.equal(await page.locator('#codex-picker-summary').isVisible(), true); assert.equal(f.posts.length, 0);
});

test('browser summary and model list fit desktop/mobile viewports using actual controller positioning', { skip: !browserModule, timeout: 30000 }, async t => {
  const f = await browserFixture(t), { page } = f;
  const viewports: [number, number][] = [[1440, 900], [1440, 640], [760, 844], [390, 844], [320, 568]];
  for (const [width, height] of viewports) {
    await page.setViewportSize({ width, height }); await f.open();
    const fits = async (view: string, expectedWidth: number) => {
      const bounds = await page.locator('#codex-model-popover').boundingBox(); assert.ok(bounds);
      assert.ok(bounds.x >= 11 && bounds.y >= 11 && bounds.x + bounds.width <= width - 11 && bounds.y + bounds.height <= height - 11, view + ' ' + JSON.stringify(bounds));
      assert.equal(Math.round(bounds.width), Math.min(expectedWidth, width - 24));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      if (process.env.ARCANE_UI_SCREENSHOT) {
        await mkdir(resolve(process.env.ARCANE_UI_SCREENSHOT), { recursive: true });
        await page.screenshot({ path: join(resolve(process.env.ARCANE_UI_SCREENSHOT), 'composer-' + view + '-' + width + '-' + height + '.png') });
      }
    };
    await fits('reasoning', 240); await f.list(); await fits('models', 300);
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    const composer = await page.locator('#codex-compose').boundingBox(), input = await page.locator('#codex-composer').boundingBox();
    const plus = await page.locator('#workspace-add-context').boundingBox(), chip = await page.locator('#codex-model-trigger').boundingBox(), send = await page.locator('#codex-submit').boundingBox();
    assert.ok(composer && input && plus && chip && send);
    assert.ok(input.y + input.height <= plus.y, 'Input sits above controls');
    assert.ok(plus.x + plus.width <= chip.x + 1 && chip.x + chip.width <= send.x + 1, 'Attachment, model and send fit one row');
    assert.ok(Math.abs(plus.y - send.y) <= 1 && Math.abs(chip.y + chip.height / 2 - send.y - send.height / 2) <= 1);
    assert.equal(send.width, send.height); assert.equal(await page.locator('#codex-submit').evaluate(el => getComputedStyle(el).borderRadius), '50%');
    assert.ok(send.x + send.width <= composer.x + composer.width && composer.x + composer.width <= width);
  }
  await f.open(); await f.list(); await page.setViewportSize({ width: 390, height: 700 });
  await page.waitForFunction(() => { const r = document.getElementById('codex-model-popover')!.getBoundingClientRect(); return r.right <= innerWidth - 11 && r.bottom <= innerHeight - 11; });
  assert.equal(await page.locator('#codex-picker-model-list').isVisible(), true, 'Resize repositions the current list');
  assert.equal(f.posts.length, 0);
});

test('browser picker keeps Tab inside the open popover in both views; Escape closes back to the picker button', { skip: !browserModule, timeout: 30000 }, async t => {
  const f = await browserFixture(t), { page } = f;
  const focusedInside = () => page.evaluate(() => { const a = document.activeElement; return !!a && a !== document.body && document.getElementById('codex-model-popover')!.contains(a); });
  const focusedId = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.id || (document.activeElement as HTMLElement | null)?.dataset.pickerModel || '');
  for (const view of ['reasoning', 'models'] as const) {
    await f.open(); if (view === 'models') await f.list();
    const stops = await page.evaluate(() => Array.from(document.getElementById('codex-model-popover')!.querySelectorAll<HTMLElement>('a[href],button,input,select,textarea,[tabindex]'))
      .filter(node => node.tabIndex >= 0 && !(node as HTMLButtonElement).disabled && !node.closest('[hidden],[inert]') && node.getClientRects().length > 0).length);
    assert.ok(stops >= 1, view);
    const forward: string[] = [];
    for (let index = 0; index < stops + 2; index++) { await page.keyboard.press('Tab'); assert.equal(await focusedInside(), true, view + ' Tab ' + index); forward.push(await focusedId()); }
    assert.equal(forward[stops], forward[0], view + ' Tab wraps to the first control');
    for (let index = 0; index < stops + 2; index++) { await page.keyboard.press('Shift+Tab'); assert.equal(await focusedInside(), true, view + ' Shift+Tab ' + index); }
    assert.equal(await page.locator('#codex-model-popover').isVisible(), true);
    if (view === 'models') { await page.keyboard.press('Escape'); assert.equal(await page.locator('#codex-picker-summary').isVisible(), true); }
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#codex-model-popover').isVisible(), false);
    assert.equal(await page.locator('#codex-model-trigger').evaluate(el => el === document.activeElement), true, view + ' Escape returns focus to the picker button');
  }
  assert.equal(f.posts.length, 0, 'Tabbing never applies a selection');
});

test('browser catalogue refresh excludes removed rows and exposes only reported range levels/defaults', { skip: !browserModule, timeout: 30000 }, async t => {
  const initial = state(); initial.snapshot!.thread = null; delete initial.workflowModel;
  initial.snapshot!.models.push({ model: 'fixture-custom', id: 'opaque-custom', displayName: 'Custom reported model', efforts: ['reported-balanced', 'reported-deep', 'reported-quick'], defaultEffort: 'reported-deep', entitlement: 'unverified' });
  const f = await browserFixture(t, initial), { page } = f;
  await f.open(); await f.list(); const removed = await page.locator('[data-picker-model="fixture-beta"]').elementHandle(); assert.ok(removed);
  const next = f.observed(); next.snapshot!.models = next.snapshot!.models.filter(model => model.model !== 'fixture-beta'); f.set(next); await f.refresh();
  assert.deepEqual(await page.locator('#codex-model-options button').evaluateAll(rows => rows.map(row => (row as HTMLElement).dataset.pickerModel)), ['fixture-alpha', 'fixture-custom']);
  await removed.dispatchEvent('click'); assert.equal(f.posts.length, 0, 'A detached stale row cannot select a removed model');
  await page.locator('[data-picker-model="fixture-custom"]').click();
  await f.settled();
  assert.equal((f.posts[0] as Extract<ChatAction, { action: 'select' }>).effort, 'reported-deep', 'Default comes from the report, not the first level or a fixed vocabulary');
  await f.open();
  assert.deepEqual(await page.locator('#codex-picker-efforts [role=radio]').allTextContents(), ['reported-balanced', 'reported-deep', 'reported-quick']);
  assert.equal(await page.locator('#codex-picker-effort-slider').getAttribute('max'), '2');
  assert.equal(await page.locator('#codex-picker-effort-slider').inputValue(), '1');
  assert.equal(await page.locator('#codex-picker-effort-slider').getAttribute('aria-valuetext'), 'Reported-deep');
  await page.locator('#codex-picker-effort-slider').focus(); await page.keyboard.press('End'); await f.settled();
  assert.equal((f.posts[1] as Extract<ChatAction, { action: 'select' }>).effort, 'reported-quick');
  const single = f.observed(); const model = single.snapshot!.models.find(row => row.model === 'fixture-custom')!;
  model.efforts = ['reported-quick']; model.defaultEffort = null; f.set(single); await f.refresh(); await f.open();
  assert.equal(await page.locator('#codex-picker-effort-slider').getAttribute('max'), '0');
  assert.equal(await page.locator('#codex-picker-effort-slider').isDisabled(), true);
  assert.equal(await page.locator('#codex-picker-reset').isDisabled(), true);
  assert.deepEqual(await page.locator('#codex-picker-efforts [role=radio]').allTextContents(), ['reported-quick']);
  model.defaultEffort = 'not-reported'; f.set(single); await f.refresh();
  assert.equal(await page.locator('#codex-picker-reset').isDisabled(), true, 'An absent default never invents a reasoning level');
  await page.locator('#codex-picker-reset').dispatchEvent('click'); assert.equal(f.posts.length, 2);
  for (const defaultEffort of [null, 'not-reported'] as const) {
    const reported = f.observed(), modelId = defaultEffort === null ? 'fixture-no-default' : 'fixture-invalid-default';
    reported.snapshot!.models.push({ model: modelId, id: modelId, displayName: modelId, efforts: ['reported-first', 'reported-second'], defaultEffort, entitlement: 'unverified' });
    f.set(reported); await f.refresh(); await f.list(); await page.locator('[data-picker-model="' + modelId + '"]').click(); await f.settled();
    const selected = f.posts.at(-1)!; assert.equal(selected.action, 'select');
    assert.equal(selected.model, modelId); assert.equal(selected.effort, 'reported-first', 'Without a valid default, model selection uses a supported reported effort');
    await f.open(); assert.equal(await page.locator('#codex-picker-reset').isDisabled(), true, 'Supported fallback is not a reported default');
    assert.equal(await page.locator('#codex-picker-effort-slider').inputValue(), '0');
  }
  assert.equal(f.posts.length, 4);
});

test('browser reasoning choices restore exact per-chat drafts and never select or start native work', { skip: !browserModule, timeout: 30000 }, async t => {
  const initial = state(); initial.snapshot!.thread = null; delete initial.workflowModel;
  initial.nativeAssets = { available: true, sealed: true, granted: false, admissionOpen: false };
  initial.snapshot!.models.push({ model: 'fixture-custom', id: 'custom-id', displayName: 'Custom reported model', efforts: ['reported-balanced', 'reported-deep'], defaultEffort: 'reported-deep', entitlement: 'unverified' });
  const f = await browserFixture(t, initial), { page } = f;
  await page.evaluate(() => (window as any).fixtureChat.enableChatTabs());
  await f.choose('fixture-alpha');
  await f.open(); await page.locator('#codex-picker-effort-slider').press('ArrowRight');
  const first = await page.evaluate(() => (window as any).fixtureChat.currentStateView().activeChat.key);
  const draft = 'First model draft 🧩\nExact whitespace.  '; await page.locator('#codex-composer').fill(draft);
  assert.equal(await page.evaluate(() => (window as any).fixtureChat.newChat()), true);
  await f.choose('fixture-custom');
  await f.open(); await page.locator('#codex-picker-effort-slider').press('ArrowLeft');
  const second = await page.evaluate(() => (window as any).fixtureChat.currentStateView().activeChat.key);
  assert.equal(f.posts.length, 0); assert.equal(f.observed().snapshot!.thread, null);
  await page.locator('#codex-composer').fill('Second draft');
  assert.equal(await page.evaluate(key => (window as any).fixtureChat.selectChat(key), first), true);
  assert.equal(await page.locator('#codex-composer').inputValue(), draft);
  assert.equal(await page.locator('#codex-effort-label').textContent(), 'ultra');
  await f.open(); assert.equal(await page.locator('#codex-picker-effort-slider').inputValue(), '1');
  await f.list(); assert.equal(await page.locator('[data-picker-model="fixture-alpha"]').getAttribute('aria-selected'), 'true');
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(key => (window as any).fixtureChat.selectChat(key), second), true);
  await page.evaluate(() => {
    const input = document.getElementById('codex-composer') as HTMLTextAreaElement;
    input.value = 'Final reload text 🧩  '; input.dispatchEvent(new Event('input')); dispatchEvent(new Event('pagehide'));
  });
  await page.reload(); await page.waitForFunction(() => (window as any).fixtureReady === true);
  await page.evaluate(() => (window as any).fixtureChat.enableChatTabs());
  assert.equal(await page.locator('#codex-composer').inputValue(), 'Final reload text 🧩  ');
  assert.equal(await page.locator('#codex-effort-label').textContent(), 'reported-balanced');
  assert.equal(await page.locator('#codex-model').inputValue(), 'fixture-custom'); assert.equal(f.posts.length, 0);
  const unavailable = f.observed(); unavailable.snapshot!.models = unavailable.snapshot!.models.filter(model => model.model !== 'fixture-custom');
  f.set(unavailable); await f.refresh();
  assert.equal(await page.locator('#codex-model-label').textContent(), 'Choose model');
  assert.equal(await page.locator('#codex-effort-label').isVisible(), false);
  assert.equal(await page.locator('#codex-model').inputValue(), '', 'An unavailable saved pair never falls back');
  f.set(initial); await f.refresh(); assert.equal(await page.locator('#codex-effort-label').textContent(), 'reported-balanced');
  assert.equal(await page.locator('#codex-model').inputValue(), 'fixture-custom'); assert.equal(f.posts.length, 0);
});

function activeState(status: 'starting' | 'inProgress' | 'cancelling' = 'inProgress') {
  const initial = state(); initial.busy = true;
  initial.snapshot!.thread!.turnId = 'exact-active-turn'; initial.snapshot!.thread!.turnStatus = status;
  initial.nativeThreads = [{ provider: 'codex', projectPath: initial.projectPath, threadId: 'fixture-thread', sessionId: 'fixture-session', selection: initial.snapshot!.thread!.selection }];
  return initial;
}

test('browser visible picker stages active and restored unbound owned preferences without changing actual task model or starting native work', { skip: !browserModule, timeout: 30000 }, async t => {
  const initial = activeState(), f = await browserFixture(t, initial), { page } = f;
  await page.evaluate(() => (window as any).fixtureChat.enableChatTabs());
  const actualTaskModel = await page.evaluate(() => (window as any).fixtureChat.workflowModelSelection());
  let draft = 'Active task next-message draft 🧩\n  '; await page.locator('#codex-composer').fill(draft);
  await f.choose();
  assert.match((await page.locator('#codex-model-label').textContent())!, /Fixture Beta/);
  assert.deepEqual(await page.evaluate(() => (window as any).fixtureChat.currentStateView().activeChat.selection), { model: 'fixture-beta', effort: 'high' });
  assert.deepEqual(await page.evaluate(() => (window as any).fixtureChat.workflowModelSelection()), actualTaskModel);
  assert.deepEqual(f.observed().snapshot!.thread!.selection, initial.snapshot!.thread!.selection);
  assert.equal(await page.locator('#codex-submit').getAttribute('aria-label'), 'Stop task');
  await f.open(); await page.locator('#codex-picker-effort-slider').press('Home');
  assert.equal(await page.locator('#codex-effort-label').textContent(), 'medium');
  await page.locator('#codex-composer').press('Enter');
  draft += '\n'; // An active task leaves Enter as native textarea editing.
  assert.equal(await page.locator('#codex-composer').inputValue(), draft); assert.deepEqual(f.posts, []);
  await f.refresh();
  assert.deepEqual(await page.evaluate(() => (window as any).fixtureChat.workflowModelSelection()), actualTaskModel);
  assert.deepEqual(f.observed().nativeAssets, initial.nativeAssets); assert.equal(f.observed().snapshot!.thread!.writeGranted, true);
  if (process.env.ARCANE_UI_SCREENSHOT) {
    await mkdir(resolve(process.env.ARCANE_UI_SCREENSHOT), { recursive: true });
    await f.open(); await page.screenshot({ path: join(resolve(process.env.ARCANE_UI_SCREENSHOT), 'composer-active-preference.png') }); await page.keyboard.press('Escape');
  }
  const unbound = f.observed(); unbound.busy = false; unbound.snapshot!.thread = null; delete unbound.workflowModel;
  unbound.nativeAssets = { available: true, sealed: true, granted: false, admissionOpen: false }; f.set(unbound);
  await page.reload(); await page.waitForFunction(() => (window as any).fixtureReady === true);
  await page.evaluate(() => (window as any).fixtureChat.enableChatTabs());
  assert.equal(await page.evaluate(() => (window as any).fixtureChat.currentStateView().activeChat.kind), 'native');
  assert.equal(await page.evaluate(() => (window as any).fixtureChat.currentStateView().nativeBoundToActiveChat), false);
  assert.equal(await page.locator('#codex-composer').inputValue(), draft);
  assert.equal(await page.locator('#codex-effort-label').textContent(), 'medium');
  assert.equal(await page.evaluate(() => (window as any).fixtureChat.workflowModelSelection()), null);
  await f.choose('fixture-alpha'); assert.equal(await page.locator('#codex-effort-label').textContent(), 'low');
  assert.equal(f.observed().snapshot!.thread, null); assert.deepEqual(f.posts, []);
  await f.open();
  for (const id of ['codex-model', 'codex-effort', 'codex-select']) {
    assert.equal(await page.locator('#' + id).isVisible(), false, id + ' remains hidden even while the picker is open');
    assert.equal(await page.locator('#' + id).evaluate(el => !!el.closest('[hidden][inert][aria-hidden="true"]')), true);
  }
});

// Decode only the test's own browser PNG to verify rendered pixels. No image
// dependency, install, product screenshot mutation or inferred pseudo style.
function pngPixels(png: Buffer) {
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20), type = png[25];
  assert.equal(png[24], 8); assert.equal(png[28], 0); assert.ok(type === 2 || type === 6);
  const channels = type === 6 ? 4 : 3, chunks: Buffer[] = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset), kind = png.toString('ascii', offset + 4, offset + 8);
    if (kind === 'IDAT') chunks.push(png.subarray(offset + 8, offset + 8 + length)); offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks)), stride = width * channels, pixels = Buffer.alloc(stride * height);
  const paeth = (a: number, b: number, c: number) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!; assert.ok(filter <= 4);
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[y * stride + x - channels]! : 0, up = y ? pixels[(y - 1) * stride + x]! : 0;
      const corner = y && x >= channels ? pixels[(y - 1) * stride + x - channels]! : 0;
      const predictor = filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : filter === 4 ? paeth(left, up, corner) : 0;
      pixels[y * stride + x] = (raw[y * (stride + 1) + x + 1]! + predictor) & 255;
    }
  }
  return { width, height, rgb: (x: number, y: number) => [...pixels.subarray(y * stride + x * channels, y * stride + x * channels + 3)] };
}

test('actual Edge native range fills to the thumb centre with flat Arcane red, Ultra-only crimson-to-red and dark remainder', { skip: !browserModule, timeout: 30000 }, async t => {
  const initial = state(); initial.snapshot!.models[0]!.efforts = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']; initial.workflowModel = workflowNativeModel(initial)!.proof;
  const levels = initial.snapshot!.models[0]!.efforts, lastIndex = levels.length - 1;
  const f = await browserFixture(t, initial), { page } = f;
  for (const [index, effort] of levels.entries()) {
    await f.open(); const slider = page.locator('#codex-picker-effort-slider');
    if (index) { await slider.press('ArrowRight'); await f.settled(); await f.open(); }
    const computed = await slider.evaluate(el => {
      const input = el as HTMLInputElement, css = getComputedStyle(input), rect = input.getBoundingClientRect();
      return { value: input.value, width: rect.width, height: rect.height, tone: input.dataset.effortTone,
        position: css.getPropertyValue('--effort-position').trim(), offset: css.getPropertyValue('--effort-offset').trim(),
        fill: css.getPropertyValue('--effort-fill').trim(), end: css.getPropertyValue('--effort-fill-end').trim(), rest: css.getPropertyValue('--effort-rest').trim() };
    });
    assert.equal(computed.value, String(index)); assert.equal(computed.height, 28);
    assert.equal(computed.tone, effort === 'ultra' ? 'ultra' : 'standard');
    const fraction = index / lastIndex, thumbCentre = 12 + (computed.width - 24) * fraction;
    assert.ok(Math.abs(parseFloat(computed.position) / 100 - fraction) < 0.000001);
    assert.equal(parseFloat(computed.offset), fraction * 24);
    assert.ok(Math.abs(12 + computed.width * parseFloat(computed.position) / 100 - parseFloat(computed.offset) - thumbCentre) < 0.001);
    assert.equal(computed.fill, effort === 'ultra' ? '#9b0b22' : '#ff3340'); assert.equal(computed.end, effort === 'ultra' ? '#ff6b75' : '#ff3340'); assert.equal(computed.rest, '#2a2a30');
    const png = await slider.screenshot(), pixels = pngPixels(png), y = Math.floor(pixels.height / 2);
    const near = (value: number[], expected: number[]) => assert.ok(value.every((channel, i) => Math.abs(channel - expected[i]!) <= 3), JSON.stringify({ value, expected, index }));
    if (index < lastIndex) near(pixels.rgb(Math.floor((thumbCentre + 18 + pixels.width - 5) / 2), y), [42, 42, 48]);
    if (index > 0 && effort !== 'ultra') {
      near(pixels.rgb(18, y), [255, 51, 64]); near(pixels.rgb(Math.floor(thumbCentre - 18), y), [255, 51, 64]);
    }
    if (effort === 'ultra') {
      const left = pixels.rgb(18, y), right = pixels.rgb(pixels.width - 30, y);
      assert.ok(left[0]! > left[1]! + 60 && right[0]! > right[1]! + 60); assert.ok(right[0]! > left[0]! + 30, 'Actual Ultra pixels progress from deep crimson to bright red');
    }
    if (process.env.ARCANE_UI_SCREENSHOT) {
      await mkdir(resolve(process.env.ARCANE_UI_SCREENSHOT), { recursive: true });
      await page.screenshot({ path: join(resolve(process.env.ARCANE_UI_SCREENSHOT), 'composer-effort-' + initial.snapshot!.models[0]!.efforts[index] + '.png') });
    }
    await page.keyboard.press('Escape');
  }
  assert.deepEqual(f.posts.map(input => input.action), levels.slice(1).map(() => 'select'));
  t.diagnostic('Fresh headless Edge instance, real HTML/CSS, native range keys, measured thumb geometry and rendered PNG pixels; synthetic HTTP only.');
});

test('browser Stop interrupts the exact configured active chat once, preserves draft and cannot submit a new turn', { skip: !browserModule, timeout: 30000 }, async t => {
  const initial = activeState(), f = await browserFixture(t, initial), { page } = f;
  await page.evaluate(() => (window as any).fixtureChat.enableChatTabs());
  assert.equal(await page.evaluate(() => (window as any).fixtureChat.currentStateView().nativeBoundToActiveChat), true);
  const draft = 'Unsent next turn 🧩\nKeep it.  '; await page.locator('#codex-composer').fill(draft);
  assert.equal(await page.locator('#codex-submit').getAttribute('type'), 'button');
  assert.equal(await page.locator('#codex-submit').getAttribute('aria-label'), 'Stop task');
  assert.equal(await page.locator('#codex-submit').getAttribute('data-task-state'), 'active');
  assert.equal(await page.locator('.composer-controls').getAttribute('data-task-active'), 'true');
  assert.equal(await page.locator('#codex-submit').isDisabled(), false, 'Busy native work remains interruptible');
  assert.equal(await page.locator('#codex-model-trigger').isDisabled(), false,'An active task may stage a preference while Stop retains its target');
  assert.equal(await page.locator('#codex-submit svg path').getAttribute('fill'), 'currentColor');
  let release!: () => void; const held = new Promise<void>(done => { release = done; }); t.after(() => release());
  f.handler(async input => {
    assert.equal(input.action, 'turn-interrupt'); await held; const next = f.observed();
    next.busy = false; next.snapshot!.thread!.turnStatus = 'interrupted';
    const record = receipt(input); next.actions = [record]; f.set(next); return { record, state: next };
  });
  await page.locator('#codex-submit').click();
  await page.waitForFunction(() => (document.getElementById('codex-submit') as HTMLButtonElement).disabled);
  await page.waitForFunction(() => document.getElementById('codex-notice')?.textContent === 'Waiting for confirmation…');
  assert.equal(f.posts.length, 1);
  assert.deepEqual(f.posts[0], { requestId: f.posts[0]!.requestId, connectionId: initial.snapshot!.connectionId, action: 'turn-interrupt', threadId: 'fixture-thread', turnId: 'exact-active-turn' });
  await page.locator('#codex-submit').dispatchEvent('click');
  await page.locator('#codex-compose').dispatchEvent('submit');
  assert.equal(f.posts.length, 1, 'Pending Stop is deduplicated and form submission cannot start a turn');
  assert.equal(await page.locator('#codex-composer').inputValue(), draft);
  release(); await page.waitForFunction(() => document.getElementById('codex-submit')?.getAttribute('aria-label') === 'Send message');
  assert.equal(await page.locator('#codex-submit').getAttribute('type'), 'submit');
  assert.equal(await page.locator('.composer-controls').getAttribute('data-task-active'), 'false');
  assert.equal(await page.locator('#codex-composer').inputValue(), draft);
  assert.deepEqual(f.posts.map(input => input.action), ['turn-interrupt']);
});

test('browser active Stop modes respect missing turn IDs, cancellation, freshness, provider and exact chat binding', { skip: !browserModule, timeout: 30000 }, async t => {
  const f = await browserFixture(t, activeState('starting')), { page } = f;
  await page.evaluate(() => (window as any).fixtureChat.enableChatTabs());
  assert.equal(await page.locator('#codex-submit').getAttribute('aria-label'), 'Stop task');
  assert.equal(await page.locator('#codex-submit').isDisabled(), false);
  await page.locator('#codex-submit').click();
  await page.waitForFunction(() => document.getElementById('codex-submit')?.getAttribute('aria-label') === 'Send message');
  assert.equal(f.posts.length, 1); assert.equal(f.posts[0]!.action, 'turn-interrupt');
  const cancelled = activeState('cancelling'); f.set(cancelled); await f.refresh();
  assert.equal(await page.locator('#codex-submit').getAttribute('type'), 'button');
  assert.equal(await page.locator('#codex-submit').getAttribute('aria-label'), 'Stop task');
  assert.equal(await page.locator('#codex-submit').isDisabled(), true);
  const missing = activeState('starting'); missing.snapshot!.thread!.turnId = null; f.set(missing); await f.refresh();
  assert.equal(await page.locator('#codex-submit').isDisabled(), true);
  f.set(activeState()); await f.refresh(); f.fail(true); await f.refresh();
  assert.equal(await page.locator('#codex-submit').isDisabled(), true);
  assert.equal(await page.locator('#codex-compose').isVisible(), true, 'A temporary read failure keeps the signed-in conversation visible; native actions still need fresh state');
  f.fail(false); await f.refresh();
  await page.evaluate(() => (window as any).fixtureChat.setChatProviderPreference('claude'));
  assert.equal(await page.locator('#codex-submit').isDisabled(), true);
  await page.locator('#codex-submit').dispatchEvent('click'); assert.equal(f.posts.length, 1);
  await page.evaluate(() => (window as any).fixtureChat.setChatProviderPreference('codex'));
  const unconfigured = activeState(); unconfigured.snapshot!.thread!.configured = false; delete unconfigured.workflowModel; f.set(unconfigured); await f.refresh();
  assert.equal(await page.locator('#codex-submit').isDisabled(), true);
  await page.locator('#codex-submit').dispatchEvent('click'); await page.locator('#codex-compose').dispatchEvent('submit');
  assert.equal(f.posts.length, 1, 'An unconfigured thread authorizes neither Stop nor Send');
  const wrongThread = activeState(); wrongThread.snapshot!.thread!.threadId = 'other-active-thread'; delete wrongThread.workflowModel; f.set(wrongThread); await f.refresh();
  assert.equal(await page.evaluate(() => (window as any).fixtureChat.currentStateView().nativeBoundToActiveChat), false);
  assert.equal(await page.locator('#codex-submit').isDisabled(), true);
  await page.locator('#codex-submit').dispatchEvent('click'); await page.locator('#codex-compose').dispatchEvent('submit');
  const wrongSession = activeState(); wrongSession.snapshot!.thread!.sessionId = 'other-session'; delete wrongSession.workflowModel; f.set(wrongSession); await f.refresh();
  assert.equal(await page.evaluate(() => (window as any).fixtureChat.currentStateView().nativeBoundToActiveChat), false);
  await page.locator('#codex-submit').dispatchEvent('click'); assert.equal(f.posts.length, 1);
  f.set(activeState()); await f.refresh();
  assert.equal(await page.locator('#codex-submit').isDisabled(), false);
  assert.deepEqual(f.posts.map(input => input.action), ['turn-interrupt']);
});
