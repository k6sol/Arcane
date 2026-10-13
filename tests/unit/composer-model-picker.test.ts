/// <reference lib="dom" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
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
  assert.equal(input.action, 'select');
  return { requestId: input.requestId, connectionId: input.connectionId, action: input.action, threadId: null, turnId: null,
    model: input.model, effort: input.effort, state: status, errorCode: status === 'rejected' ? 'FIXTURE_REJECTED' : null,
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
    'workspace-preview-toggle', 'workspace-preview-close', 'codex-model-trigger', 'codex-model-popover', 'codex-model', 'codex-effort', 'codex-select'];
  for (const id of ids) assert.equal(html.split('id="' + id + '"').length - 1, 1, id);
  assert.match(html, /id="artifact-panel"[^>]*\bhidden/);
  const gate = html.match(/<section[^>]*id="provider-login-gate"[^>]*>/)![0];
  assert.doesNotMatch(gate, /\bhidden\b/); assert.match(gate, /aria-labelledby="provider-login-heading"/);
  assert.match(html, /id="provider-login-start"[^>]*disabled/);
  assert.match(html, /id="codex-model-popover"[^>]*role="dialog"[^>]*aria-modal="false"[^>]*hidden/);
  const select = html.match(/<select id="provider-setup-provider">([\s\S]*?)<\/select>/)![1]!;
  assert.deepEqual([...select.matchAll(/value="([^"]+)"/g)].map(match => match[1]), ['codex', 'claude']);
});

async function browserFixture(t: test.TestContext, initial = state()) {
  let observed = structuredClone(initial), readFailed = false;
  const posts: ChatAction[] = [], errors: string[] = [];
  let handler: ((input: ChatAction) => Promise<{ record: ChatActionRecord; state: ChatState }>) | null = null;
  const files = new Map([
    ['/studio', [resolve('apps/desktop/public/studio.html'), 'text/html']], ['/studio.css', [resolve('apps/desktop/public/studio.css'), 'text/css']],
    ['/codex-chat.js', [resolve(process.env.ARCANE_UI_BUILD_DIR ?? 'dist', 'apps/desktop/src/codex-chat.js'), 'text/javascript']],
    ['/workspace-shell.js', [resolve(process.env.ARCANE_UI_BUILD_DIR ?? 'dist', 'apps/desktop/src/workspace-shell.js'), 'text/javascript']],
    ['/chat-tabs.js', [resolve(process.env.ARCANE_UI_BUILD_DIR ?? 'dist', 'apps/desktop/src/chat-tabs.js'), 'text/javascript']],
    ['/codex-history.js', [resolve(process.env.ARCANE_UI_BUILD_DIR ?? 'dist', 'apps/desktop/src/codex-history.js'), 'text/javascript']],
  ]);
  const server = createServer((request, response) => { void (async () => {
    if (request.url === '/picker-fixture.js') {
      response.writeHead(200, { 'content-type': 'text/javascript' });
      response.end(`import {CodexChat,CodexChatApi} from '/codex-chat.js';
        import {startWorkspaceShell} from '/workspace-shell.js';
        const chat = new CodexChat(document,new CodexChatApi('${TOKEN}')); window.fixtureChat=chat;
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
      const input = JSON.parse(body) as ChatAction; posts.push(input); assert.equal(input.action, 'select', 'Picker may only delegate select');
      let outcome;
      if (handler) outcome = await handler(input);
      else {
        observed.snapshot!.selection = { model: input.model, effort: input.effort };
        if (observed.snapshot!.thread) observed.snapshot!.thread!.selection = { model: input.model, effort: input.effort };
        if (observed.snapshot!.thread?.configured) observed.workflowModel = workflowNativeModel(observed)!.proof;
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
  const playwright = await import(pathToFileURL(resolve(browserModule!)).href);
  const browser = await playwright.chromium.launch({ headless: true, args: ['--disable-gpu'], ...(process.env.ARCANE_UI_BROWSER_EXE ? { executablePath: process.env.ARCANE_UI_BROWSER_EXE } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (error: Error) => errors.push(error.message));
  await page.goto('http://127.0.0.1:' + address.port + '/studio'); await page.waitForFunction(() => (window as any).fixtureReady === true);
  t.after(() => assert.deepEqual(errors, []));
  const refresh = () => page.evaluate(() => (window as any).fixtureChat.refresh());
  const open = async () => { await page.locator('#codex-model-trigger').click(); await page.locator('#codex-model-search').waitFor(); };
  const choose = async (model = 'fixture-beta', effort = 'medium') => {
    await open(); await page.locator('#codex-model-options [data-picker-model="' + model + '"]').click();
    await page.locator('#codex-picker-efforts [data-picker-effort="' + effort + '"]').click();
  };
  return { page, posts, refresh, open, choose, observed: () => structuredClone(observed), set: (value: ChatState) => { observed = structuredClone(value); },
    fail: (value: boolean) => { readFailed = value; }, handler: (value: typeof handler) => { handler = value; } };
}

test('browser picker searches only native rows, supports keyboard/focus/IME and closes without submitting', { skip: !browserModule, timeout: 30000 }, async t => {
  const f = await browserFixture(t), { page } = f;
  const draft = 'Unsent draft 🧩\nKeep whitespace.  '; await page.locator('#codex-composer').fill(draft);
  await f.open(); assert.equal(await page.locator('#codex-model-search').evaluate((el: HTMLElement) => el === document.activeElement), true);
  assert.equal(await page.locator('#codex-model-search').evaluate((el: HTMLInputElement) => el.form === null), true, 'Picker search has no implicit conversation submission');
  assert.equal(await page.locator('#codex-model-options [role=option]').count(), 2);
  assert.equal(await page.locator('#codex-model-options small').count(),0,'Compact model rows expose IDs in titles, not a second text line');
  assert.equal(await page.locator('#codex-model-options [aria-selected=true] .picker-selected-check[data-selected=true]').count(),1);
  assert.equal(await page.locator('#codex-picker-efforts').isVisible(),false,'Reasoning stays collapsed until requested');
  assert.equal(await page.locator('#codex-model-options button[tabindex="0"]').count(),1,'Model list has a Tab-reachable option');
  await page.locator('#codex-model-search').fill('BETA fixture'); assert.equal(await page.locator('#codex-model-options button').count(), 1);
  assert.equal(await page.locator('#codex-model-popover img').count(), 0);
  await page.locator('#codex-model-search').press('ArrowDown'); await page.keyboard.press('Enter');
  assert.equal(await page.locator('#codex-model').inputValue(), 'fixture-beta'); assert.equal(await page.locator('#codex-effort').inputValue(), '');
  assert.deepEqual(await page.locator('#codex-picker-efforts button').allTextContents(), ['medium', 'high']);
  await page.keyboard.press('ArrowRight'); assert.equal(await page.locator('#codex-effort').inputValue(), 'high');
  assert.equal(await page.locator('#codex-model-label').textContent(), 'Fixture Alpha', 'Staging is never reported as applied');
  await page.keyboard.press('Escape');assert.equal(await page.locator('#codex-picker-efforts').isVisible(),false);
  assert.equal(await page.locator('#codex-picker-reasoning-trigger').evaluate((el:HTMLElement)=>el===document.activeElement),true);
  await page.keyboard.press('Escape'); assert.equal(await page.locator('#codex-model-popover').isVisible(), false);
  assert.equal(await page.locator('#codex-model-trigger').evaluate((el: HTMLElement) => el === document.activeElement), true);
  await f.open(); await page.locator('#codex-model-search').fill('not-reported'); assert.equal(await page.locator('#codex-model-options button').count(), 0);
  await page.locator('#codex-model-search').press('Enter'); assert.equal(f.posts.length, 0);
  await page.locator('#codex-composer').click(); assert.equal(await page.locator('#codex-model-popover').isVisible(), false);
  await f.open(); await page.locator('#codex-model-search').evaluate((el: HTMLElement) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true })));
  assert.equal(await page.locator('#codex-model-popover').isVisible(), true);
  await page.locator('#codex-composer').focus(); assert.equal(await page.locator('#codex-model-popover').isVisible(), false);
  assert.equal(await page.locator('#codex-composer').inputValue(), draft); assert.equal(f.posts.length, 0);
});

test('browser select waits for ACK, preserves grants/drafts and requires provenance review after the actual model changes', { skip: !browserModule, timeout: 30000 }, async t => {
  const initial = state(), f = await browserFixture(t, initial), { page } = f;
  const origin = { projectPath: initial.projectPath, projectId: 'b'.repeat(64), workflowId: 'fixture-workflow', workflowRevision: 1, stepKey: 'requirements',
    conversation: { provider: 'codex', threadId: 'fixture-thread', sessionId: 'fixture-session' }, model: initial.workflowModel!.selection };
  assert.equal(await page.evaluate((origin: unknown) => (window as any).fixtureChat.appendWorkflowDraft('Workflow draft, preserve every byte.  ', origin), origin), true);
  const draft = await page.locator('#codex-composer').inputValue();
  let release!: () => void; const held = new Promise<void>(done => { release = done; });
  f.handler(async input => { await held; const next = f.observed(); assert.equal(input.action, 'select');
    next.snapshot!.selection = { model: input.model, effort: input.effort }; next.snapshot!.thread!.selection = { ...next.snapshot!.selection };
    next.workflowModel = workflowNativeModel(next)!.proof; const record = receipt(input); next.actions = [record]; f.set(next); return { record, state: next }; });
  await f.choose(); await page.locator('#codex-picker-apply').click();
  await page.waitForFunction(() => document.getElementById('codex-model-trigger')?.getAttribute('aria-busy') === 'true');
  assert.equal(await page.locator('#codex-model-label').textContent(), 'Fixture Alpha');
  assert.equal(await page.locator('#codex-model-trigger').isDisabled(), true); assert.equal(await page.locator('#codex-composer').inputValue(), draft);
  release(); await page.waitForFunction(() => document.getElementById('codex-effort-label')?.textContent === 'medium');
  await page.waitForFunction(() => !(document.getElementById('codex-model-trigger') as HTMLButtonElement).disabled);
  assert.equal(f.posts.length, 1); assert.equal(f.posts[0]!.action, 'select');
  assert.equal(await page.locator('#codex-model').inputValue(), 'fixture-beta'); assert.equal(await page.locator('#codex-effort').inputValue(), 'medium');
  assert.equal(await page.locator('#codex-composer').inputValue(), draft); assert.equal(await page.locator('#codex-draft-review').isVisible(), true);
  assert.equal(await page.locator('#codex-submit').isDisabled(), true); assert.equal(f.observed().snapshot!.thread!.writeGranted, true);
  assert.deepEqual(f.observed().nativeAssets, initial.nativeAssets); assert.equal(f.observed().snapshot!.thread!.threadId, initial.snapshot!.thread!.threadId);
  await page.locator('#codex-draft-review-button').click(); await page.locator('#codex-confirm-check').check(); await page.locator('#codex-confirm-submit').click();
  await page.waitForFunction(() => !(document.getElementById('codex-submit') as HTMLButtonElement).disabled);
  assert.equal(await page.locator('#codex-submit').isDisabled(), false); assert.equal(f.posts.length, 1);
});

test('browser pre-thread selection starts no thread and the settings fallback shares the same applied display', { skip: !browserModule, timeout: 30000 }, async t => {
  const initial = state(); initial.snapshot!.thread = null; initial.snapshot!.selection = null; delete initial.workflowModel;
  const f = await browserFixture(t, initial), { page } = f;
  await page.locator('#codex-composer').fill('A draft before the thread exists.');
  assert.equal(await page.locator('#codex-model-label').textContent(), 'Choose model');
  await f.choose('fixture-alpha', 'ultra'); await page.locator('#codex-picker-apply').click();
  await page.waitForFunction(() => document.getElementById('codex-effort-label')?.textContent === 'ultra');
  assert.equal(f.observed().snapshot!.thread, null); assert.equal(f.posts.length, 1);
  // This controller fixture enables the production shell only for the Settings
  // fallback; the isolated provider-event fixture keeps its existing boundary.
  await page.evaluate(() => {
    (window as any).fixtureEnableSettings();
    document.dispatchEvent(new CustomEvent('workspace:settingsrequest', { detail: { target: 'native-conversation-heading' } }));
  });
  assert.equal(await page.locator('#settings-drawer').evaluate((drawer: HTMLDialogElement) => drawer.matches(':modal')), true);
  assert.equal(await page.locator('#settings-drawer [data-settings-section]:visible').count(), 1);
  assert.equal(await page.locator('#settings-advanced').isVisible(), true);
  assert.equal(await page.locator('#codex-model').isVisible(), true);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'native-conversation-heading');
  await page.locator('#codex-model').selectOption('fixture-beta'); await page.locator('#codex-effort').selectOption('high');
  await page.locator('#codex-select').click();
  await page.waitForFunction(() => document.getElementById('codex-effort-label')?.textContent === 'high');
  await page.locator('[data-settings-close]').click();
  assert.equal(await page.locator('#codex-model-trigger').isVisible(), true);
  assert.match(await page.locator('#codex-model-label').textContent(), /Fixture Beta/);
  assert.equal(await page.locator('#codex-composer').inputValue(), 'A draft before the thread exists.');
  assert.equal(f.observed().snapshot!.thread, null); assert.equal(f.posts.length, 2);
});

test('browser rejects optimistic labels and blocks busy, unconfigured, stale, unknown and unresolved select actions', { skip: !browserModule, timeout: 30000 }, async t => {
  const f = await browserFixture(t), { page } = f;
  f.handler(async input => { const record = receipt(input, 'rejected'), next = f.observed(); next.actions = [record]; f.set(next); return { record, state: next }; });
  await f.choose(); await page.locator('#codex-picker-apply').click();
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
    await page.locator('#codex-select').evaluate((el: HTMLElement) => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    assert.equal(f.posts.length, 1, guard);
  }
  f.set(baseline); await f.refresh(); await f.open(); f.fail(true); await f.refresh();
  assert.equal(await page.locator('#codex-model-popover').isVisible(), false); assert.equal(await page.locator('#codex-model-trigger').isDisabled(), true);
  f.fail(false); await f.refresh();
  f.handler(async input => { const record = receipt(input, 'unknown'), next = f.observed(); next.actions = [record]; f.set(next); return { record, state: next }; });
  await f.choose(); await page.locator('#codex-picker-apply').click(); await page.locator('#codex-unknown').waitFor();
  assert.equal(await page.locator('#codex-model-label').textContent(), 'Fixture Alpha'); assert.equal(await page.locator('#codex-model-trigger').isDisabled(), true);
  await f.refresh(); assert.equal(f.posts.length, 2); assert.equal(await page.locator('#codex-acknowledge').isDisabled(), true);
});

test('browser disconnected setup stays unknown, emits only provider choices and clamps the popover on small viewports', { skip: !browserModule, timeout: 30000 }, async t => {
  const initial = state(); initial.snapshot = null; delete initial.workflowModel;
  const f = await browserFixture(t, initial), { page } = f;
  assert.equal(await page.locator('#provider-login-gate').isVisible(), true); assert.equal(await page.locator('#provider-login-start').isDisabled(), true);
  assert.equal(await page.locator('#artifact-panel').isVisible(), false);
  assert.equal(await page.locator('#codex-model-label').textContent(), 'Choose model');
  assert.equal(await page.locator('#provider-setup-status').textContent(), 'Setup status has not been read.');
  for (const id of ['refresh', 'login', 'install', 'launch']) assert.equal(await page.locator('#provider-setup-' + id).isDisabled(), true);
  await f.open(); assert.equal(await page.locator('#codex-model-options button').count(), 0);
  await page.locator('#codex-picker-connect').click(); await f.open(); await page.locator('#codex-picker-claude').click();
  assert.deepEqual(await page.evaluate(() => (window as any).fixtureSetupChoices), [{ provider: 'codex' }, { provider: 'claude' }]); assert.equal(f.posts.length, 0);
  f.set(state()); await f.refresh();
  for (const [width, height] of [[390, 844], [320, 568], [1440, 640]]) {
    await page.setViewportSize({ width, height }); await f.open();
    const bounds = await page.locator('#codex-model-popover').boundingBox(); assert.ok(bounds);
    assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width! + 1 && bounds.y + bounds.height <= height! + 1, JSON.stringify(bounds));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.locator('#workspace-stage').evaluate((el: HTMLElement) => getComputedStyle(el).gridTemplateColumns.split(' ').length), 1);
    if (process.env.ARCANE_UI_SCREENSHOT) { await mkdir(resolve(process.env.ARCANE_UI_SCREENSHOT), { recursive: true }); await page.screenshot({ path: join(resolve(process.env.ARCANE_UI_SCREENSHOT), 'composer-' + width + '-' + height + '.png') }); }
    await page.keyboard.press('Escape');
  }
  // Shell owner controls these attributes; this checks the owned layout contract only.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => { document.getElementById('artifact-panel')!.hidden = false; document.getElementById('workspace-stage')!.classList.add('preview-open'); });
  assert.equal(await page.locator('#workspace-stage').evaluate((el: HTMLElement) => getComputedStyle(el).gridTemplateColumns.split(' ').length), 2);
  assert.equal(await page.locator('#artifact-panel').isVisible(), true);
  await page.evaluate(() => { (window as any).fixtureChat.stop(); (window as any).fixtureChat.resume(); }); await f.refresh();
  await f.open(); await page.locator('#codex-picker-claude').click();
  assert.equal((await page.evaluate(() => (window as any).fixtureSetupChoices)).length, 3, 'Resume binds exactly one picker handler');
  assert.equal(f.posts.length, 0);
});

test('compact reasoning menus expose only reported efforts and restore exact per-chat draft choices', {skip:!browserModule,timeout:30000},async t=>{
  const initial=state();initial.snapshot!.thread=null;delete initial.workflowModel;
  initial.nativeAssets={available:true,sealed:true,granted:false,admissionOpen:false};
  initial.snapshot!.models.push({model:'fixture-custom',id:'custom-id',displayName:'Custom reported model',efforts:['reported-balanced','reported-deep'],defaultEffort:'reported-deep',entitlement:'unverified'});
  const f=await browserFixture(t,initial),{page}=f;
  await page.evaluate(()=>(window as any).fixtureChat.enableChatTabs());
  await f.choose('fixture-alpha','ultra');await page.locator('#codex-picker-apply').click();
  const first=await page.evaluate(()=>(window as any).fixtureChat.currentStateView().activeChat.key);
  const draft='First model draft 🧩\nExact whitespace.  ';await page.locator('#codex-composer').fill(draft);
  assert.equal(await page.evaluate(()=>(window as any).fixtureChat.newChat()),true);
  await f.choose('fixture-custom','reported-balanced');
  assert.deepEqual(await page.locator('#codex-picker-efforts [role=radio]').allTextContents(),['reported-balanced','reported-deep']);
  await page.locator('#codex-picker-apply').click();
  const second=await page.evaluate(()=>(window as any).fixtureChat.currentStateView().activeChat.key);
  assert.equal(f.posts.length,0,'Draft preferences never select or start native work');
  await page.locator('#codex-composer').fill('Second draft');
  assert.equal(await page.evaluate((key:string)=>(window as any).fixtureChat.selectChat(key),first),true);
  assert.equal(await page.locator('#codex-composer').inputValue(),draft);
  assert.equal(await page.locator('#codex-effort-label').textContent(),'ultra');
  await f.open();assert.equal(await page.locator('[data-picker-model="fixture-alpha"]').getAttribute('aria-selected'),'true');
  await page.locator('#codex-picker-reasoning-trigger').click();
  assert.equal(await page.locator('[data-picker-effort="ultra"]').getAttribute('aria-checked'),'true');
  await page.keyboard.press('ArrowLeft');assert.equal(await page.locator('#codex-picker-efforts').isVisible(),false);
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate((key:string)=>(window as any).fixtureChat.selectChat(key),second),true);
  // pagehide must flush the final input before the controller debounce can run.
  await page.evaluate(()=>{const input=document.getElementById('codex-composer') as HTMLTextAreaElement;input.value='Final reload text 🧩  ';input.dispatchEvent(new Event('input'));dispatchEvent(new Event('pagehide'));});
  await page.reload();await page.waitForFunction(()=>(window as any).fixtureReady===true);
  await page.evaluate(()=>(window as any).fixtureChat.enableChatTabs());
  assert.equal(await page.locator('#codex-composer').inputValue(),'Final reload text 🧩  ');
  assert.equal(await page.locator('#codex-effort-label').textContent(),'reported-balanced');
  assert.equal(await page.locator('#codex-model').inputValue(),'fixture-custom');assert.equal(f.posts.length,0);
});
