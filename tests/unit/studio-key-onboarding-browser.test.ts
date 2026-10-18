/// <reference lib="dom" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { StudioStore } from '../../packages/storage/src/studio-store.js';
import { studioRoutes } from '../../apps/daemon/src/studio-routes.js';
import { ROOTS, READ_METHODS, WRITE_METHODS } from '../../packages/protocol/src/studio.js';
import type { ChatState } from '../../apps/desktop/src/codex-chat.js';

const browserModule = process.env.ARCANE_UI_BROWSER_MODULE;
const HUMAN = 'a'.repeat(64), AGENT = 'b'.repeat(64);
const DRAFT = 'Keep my exact draft.\nIncluding café and trailing spaces.  ';
const PUBLIC = 'Existing public message <img src=x onerror=alert(1)>';
const CONNECTION = '11111111-1111-4111-8111-111111111111';

for (const storageAvailable of [true, false]) test('key onboarding: trusted rotation outside Settings with desktop storage ' + (storageAvailable ? 'available' : 'unavailable'),
  { skip: !browserModule, timeout: 60000 }, async t => {
    const build = process.env.ARCANE_UI_BUILD_DIR; assert.ok(build, 'Compile into an owned runtime directory.');
    const directory = await mkdtemp(join(tmpdir(), 'arcane-key-onboarding-'));
    const store = new StudioStore({ directory: join(directory, 'store') });
    t.after(() => store.close());
    const bridgeRoutes = studioRoutes(store, resolve('.'), undefined, directory, AGENT);
    let signedIn = false, origin = '';
    const selection = { model: 'fixture-sol', effort: 'ultra' };
    const state = (): ChatState => ({ provider: 'codex', use: 'personal-local', projectPath: directory,
      connecting: false, closing: false, busy: false, actions: [], lastSnapshot: null, nativeTools: { configured: false, verified: false },
      nativeThreads: [{ provider: 'codex', projectPath: directory, threadId: 'fixture-thread', sessionId: 'fixture-session', selection }],
      nativeHistory: { projectPath: directory, threadId: 'fixture-thread', sessionId: 'fixture-session', recorded: null },
      snapshot: { connectionId: CONNECTION, provenance: 'spawned-node-fixture', connected: signedIn, ready: signedIn,
        account: { auth: signedIn ? 'subscription' : 'signed-out', plan: signedIn ? 'fixture' : null, requiresOpenaiAuth: true },
        models: [{ model: 'fixture-sol', id: 'fixture-picker-id', displayName: 'Synthetic model', efforts: ['low', 'ultra'], defaultEffort: 'low', entitlement: 'unverified' }],
        selection, thread: { threadId: 'fixture-thread', sessionId: 'fixture-session', selection, configured: true, writeGranted: false, turnId: null, turnStatus: 'idle' },
        operations: [], approvals: [], events: [{ seq: 1, type: 'delta', threadId: 'fixture-thread', turnId: 'fixture-turn', itemId: 'fixture-public', text: PUBLIC }],
        droppedEvents: 0, lastEventSeq: 1, failureCode: null } });
    const requests: { method: string; path: string; body: unknown }[] = [], errors: string[] = [], unexpected: string[] = [];
    t.after(() => { if (errors.length || unexpected.length) t.diagnostic(JSON.stringify({ errors, unexpected })); });
    const nativeCalls: { method: string; input: unknown }[] = [], copied: string[] = [], browserCopied: string[] = [];
    // A full legacy vault exercises replacement at the old 32-item limit. These
    // are fake in-memory secrets; no credential file or native vault is accessed.
    let saved = Object.fromEntries(Array.from({ length: 32 }, (_, i) =>
      ['33333333-3333-4333-8333-' + String(i).padStart(12, '0'), 'unused-fixture-secret']));
    const files = new Map<string, string>([['/studio', resolve('apps/desktop/public/studio.html')], ['/studio.css', resolve('apps/desktop/public/studio.css')],
      ['/brand/arcane-ridges.png', resolve('apps/desktop/public/brand/arcane-ridges.png')]]);
    for (const name of await readdir(resolve(build, 'apps/desktop/src'))) {
      if (name.endsWith('.js')) files.set('/' + name, resolve(build, 'apps/desktop/src', name));
    }
    const server = createServer((request, response) => { void (async () => {
      const url = new URL(request.url ?? '/', origin), path = url.pathname;
      const send = (json: unknown, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(json)); };
      const file = files.get(path);
      if (request.method === 'GET' && file) { response.writeHead(200, { 'Content-Type': path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : path.endsWith('.png') ? 'image/png' : 'text/html' }); response.end(await readFile(file)); return; }
      if (path === '/favicon.ico') { response.writeHead(204); response.end(); return; }
      if (request.method === 'POST') {
        if (!['/v1/studio/keys/rotate', '/v1/plugin/connect', '/v1/plugin/poll'].includes(path)) { unexpected.push('POST ' + path); send({ error: 'FIXTURE_WRITE_DENIED' }, 403); return; }
        // Observe request bytes without consuming the real route's stream.
        let body = ''; request.on('data', chunk => { body += String(chunk); });
        request.on('end', () => requests.push({ method: 'POST', path, body: JSON.parse(body) }));
      }
      if (path === '/v1/codex/state' && request.method === 'GET') {
        assert.equal(request.headers.authorization, 'Bearer ' + HUMAN);
        requests.push({ method: 'GET', path, body: null }); send({ state: state() }); return;
      }
      if (await bridgeRoutes(request, response, url, HUMAN, origin)) return;
      assert.equal(request.headers.authorization, 'Bearer ' + HUMAN);
      // Plans & credits reads local usage once at start for the top-bar chip; the fixture leaves it unavailable.
      if (['/v1/learning/state', '/v1/codex/history', '/v1/workflows', '/v1/work/runs', '/v1/work/ready', '/v1/assets/conversation-jobs', '/v1/playtests', '/v1/plans/state'].includes(path) && request.method === 'GET') {
        send({ error: 'FIXTURE_UNAVAILABLE', message: 'Synthetic metadata only.' }, 503); return;
      }
      unexpected.push(request.method + ' ' + path); send({ error: 'FIXTURE_ROUTE' }, 404);
    })().catch(error => { errors.push(String(error)); response.destroy(); }); });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    t.after(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
    const address = server.address(); assert.ok(address && typeof address !== 'string'); origin = 'http://127.0.0.1:' + address.port;
    const { chromium } = await import(pathToFileURL(resolve(browserModule!)).href) as typeof import('playwright-core');
    const browser = await chromium.launch({ headless: true, executablePath: process.env.ARCANE_UI_BROWSER_EXE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', args: ['--disable-gpu'] });
    t.after(() => browser.close());
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
    await context.route('**/*', async route => { if (new URL(route.request().url()).origin === origin) await route.continue(); else { unexpected.push(route.request().url()); await route.abort(); } });
    await context.exposeBinding('keyOnboardingVault', async (_source, method: string, input?: { keyId: string; apiKey?: string }) => {
      nativeCalls.push({ method, input: input ?? null });
      if (!storageAvailable) throw new Error('Fixture desktop storage unavailable.');
      if (method === 'list') return { available: true, items: Object.keys(saved).map(keyId => ({ keyId })) };
      assert.ok(input); assert.deepEqual(Object.keys(input).sort(), ['remember', 'replace'].includes(method) ? ['apiKey', 'keyId'] : ['keyId']);
      if (method === 'replace') { saved = { [input.keyId]: input.apiKey! }; return { remembered: true }; }
      if (method === 'remember') { assert.ok(Object.keys(saved).length < 32, 'Old remember cannot fit a full vault.'); saved[input.keyId] = input.apiKey!; return { remembered: true }; }
      if (method === 'forget') { delete saved[input.keyId]; return { forgotten: true }; }
      assert.ok(saved[input.keyId]);
      if (method === 'copy') { copied.push(saved[input.keyId]!); return { copied: true }; }
      assert.equal(method, 'reveal'); return { apiKey: saved[input.keyId] };
    });
    await context.exposeBinding('keyOnboardingClipboard', async (_source, value: string) => { browserCopied.push(value); });
    await context.addInitScript(() => {
      const fixture = window as unknown as { keyOnboardingVault(method: string, input?: unknown): Promise<unknown>; keyOnboardingClipboard(value: string): Promise<void> };
      Object.defineProperty(window, 'arcaneDesktop', { value: Object.freeze({ studioKeys: Object.freeze({ version: 1,
        list: () => fixture.keyOnboardingVault('list'),
        remember: (input: unknown) => fixture.keyOnboardingVault('remember', input),
        replace: (input: unknown) => fixture.keyOnboardingVault('replace', input),
        reveal: (input: unknown) => fixture.keyOnboardingVault('reveal', input),
        copy: (input: unknown) => fixture.keyOnboardingVault('copy', input),
        forget: (input: unknown) => fixture.keyOnboardingVault('forget', input),
      }) }) });
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: (value: string) => fixture.keyOnboardingClipboard(value) } });
    });
    const page = await context.newPage(); page.setDefaultTimeout(6000); page.setDefaultNavigationTimeout(20000); page.on('pageerror', error => errors.push(error.message));
    const text = async (id: string, value: string) => page.waitForFunction(({ id, value }) => document.getElementById(id)?.textContent?.includes(value), { id, value });
    const posts = () => requests.filter(request => request.method === 'POST');
    const chatView = () => page.evaluate(() => ({ messages: document.getElementById('codex-messages')?.textContent,
      model: (document.getElementById('codex-model') as HTMLSelectElement).value, effort: (document.getElementById('codex-effort') as HTMLSelectElement).value,
      scope: document.getElementById('codex-scope')?.textContent, tabs: document.getElementById('workspace-chat-tabs')?.textContent,
      activeKey: document.querySelector('#workspace-chat-tabs [role="tab"][aria-selected="true"]')?.getAttribute('data-chat-key'),
      draft: (document.getElementById('codex-composer') as HTMLTextAreaElement).value }));
    await page.goto(origin + '/studio#' + HUMAN); await text('key-status', 'Key service responding'); await text('codex-messages', PUBLIC);
    assert.equal(await page.locator('#key-setup-gate').isVisible(), false); assert.equal(await page.locator('#key-setup-generate').isDisabled(), true);
    assert.deepEqual(posts(), []); assert.equal(nativeCalls.length, 0);
    assert.ok(requests.some(request => request.path === '/v1/codex/state'), 'Provider evidence comes from the actual validated GET.');
    await page.evaluate(() => { localStorage.setItem('arcane.provider-presentation.v1', JSON.stringify({ version: 1, provider: 'codex' }));
      document.getElementById('provider-setup-status')!.textContent = 'Signed in'; document.dispatchEvent(new CustomEvent('workspace:providerpreference', { detail: { provider: 'codex' } })); });
    assert.equal(await page.locator('#key-setup-gate').isVisible(), false, 'Presentation and stored choice cannot manufacture sign-in evidence.');
    signedIn = true; await page.locator('#key-setup-gate').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#provider-login-gate').isVisible(), false); assert.equal(await page.locator('#key-setup-generate').isEnabled(), true);
    await page.locator('#codex-composer').fill(DRAFT);
    const before = await chatView(); assert.equal(before.draft, DRAFT); assert.equal(before.model, selection.model); assert.equal(before.effort, selection.effort);
    assert.match(before.scope ?? '', /fixture-thread/); assert.match(before.scope ?? '', new RegExp(CONNECTION));
    assert.deepEqual(JSON.parse(before.activeKey!), [directory, 'codex', 'fixture-thread', 'fixture-session']);
    await page.locator('#key-setup-generate').evaluate(node => (node as HTMLButtonElement).click());
    await page.locator('#key-setup-generate').click({ modifiers: ['Shift'] }); assert.deepEqual(posts(), []);
    assert.equal(await page.locator('#settings-drawer').isVisible(), false);
    const response = page.waitForResponse(origin + '/v1/studio/keys/rotate'); await page.locator('#key-setup-generate').click(); const first = await (await response).json();
    await page.waitForFunction(() => document.getElementById('settings-key-status')?.textContent === 'Active');
    assert.deepEqual(posts(), [{ method: 'POST', path: '/v1/studio/keys/rotate', body: {} }]);
    assert.deepEqual(first.allowedRoots, [...ROOTS]); assert.equal(first.allowWrites, true);
    assert.equal(await page.locator('#settings-drawer').evaluate(node => node.matches(':modal')), true);
    assert.equal(await page.locator('#workspace-settings').isVisible(), true); assert.equal(await page.locator('#key-setup-gate').isVisible(), false);
    if (!storageAvailable) {
      await page.waitForFunction(() => !(document.getElementById('settings-key-show') as HTMLButtonElement).disabled);
      await page.locator('#settings-key-show').click();
      assert.equal(await page.locator('#settings-key-secret').textContent(), first.apiKey);
      await page.locator('#settings-key-copy').click();
      assert.deepEqual(browserCopied, [first.apiKey]); assert.deepEqual(copied, []);
      assert.deepEqual(await chatView(), before);
      await page.keyboard.press('Escape'); await page.locator('#settings-drawer').waitFor({state:'hidden'});
      assert.equal((await page.locator('body').textContent())?.includes(first.apiKey), false);
      await page.locator('#app-sidebar [data-workspace-target="workspace-settings"]').click();
      assert.equal(await page.locator('#settings-key-show').isDisabled(), true);
      assert.equal(await page.locator('#settings-key-copy').isDisabled(), true);
      assert.equal(posts().filter(request => request.path === '/v1/studio/keys/rotate').length, 1);
      assert.equal(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage, location.href]).includes('arcane_local_v1_')), false);
      assert.deepEqual(unexpected, []); assert.deepEqual(errors, []);
      t.diagnostic('Unavailable desktop storage: fresh key remains usable until Settings closes; no native keys or clipboard.');
      return;
    }
    assert.deepEqual(saved, { [first.keyId]: first.apiKey }); assert.equal(nativeCalls.filter(call => call.method === 'replace').length, 1);
    assert.equal(nativeCalls.some(call => call.method === 'remember' || call.method === 'reveal' || call.method === 'copy'), false);
    assert.equal(await page.locator('#settings-key-secret').textContent(), '••••••••••••••••••••••••');
    await page.waitForFunction(() => !(document.getElementById('settings-key-copy') as HTMLButtonElement).disabled);
    await page.locator('#settings-key-copy').click(); assert.deepEqual(copied, [first.apiKey]); assert.deepEqual(browserCopied, []);
    assert.deepEqual(await chatView(), before, 'Key generation and native Copy preserve public messages, exact model/effort, thread/session, tab and draft.');
    const metadata = await fetch(origin + '/v1/studio/keys', { headers: { Authorization: 'Bearer ' + HUMAN } }); assert.equal(metadata.status, 200);
    assert.equal((await metadata.text()).includes(first.apiKey), false);
    const identity = { clientSessionId: 'key-onboarding-plugin-fixture', placeId: 0, universeId: 0, name: 'Synthetic HTTP plugin', pluginVersion: 'fixture' };
    const connect = async (apiKey: string) => fetch(origin + '/v1/plugin/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey, protocolVersion: 1, identity, capabilities: [...READ_METHODS, ...WRITE_METHODS] }) });
    const pairResponse = await connect(first.apiKey); assert.equal(pairResponse.status, 200); const pair = await pairResponse.json() as { sessionId: string; token: string };
    const regeneratedResponse = page.waitForResponse(origin + '/v1/studio/keys/rotate');
    await page.locator('#settings-key-generate').click(); const second = await (await regeneratedResponse).json();
    await page.waitForFunction(id => (document.getElementById('settings-key-select') as HTMLSelectElement).value === id, second.keyId);
    assert.deepEqual(saved, { [second.keyId]: second.apiKey }); assert.notEqual(second.keyId, first.keyId);
    assert.ok(store.keys().find(key => key.keyId === first.keyId)?.revokedAt); assert.equal(store.keys().filter(key => !key.revokedAt).length, 1);
    assert.ok(store.sessions().find(session => session.id === pair.sessionId)?.revokedAt); assert.equal((await connect(first.apiKey)).status, 401);
    const poll = await fetch(origin + '/v1/plugin/poll', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + pair.token }, body: JSON.stringify({ sessionId: pair.sessionId }) });
    assert.equal(poll.status, 409); assert.equal((await poll.text()).includes(pair.token), false);
    assert.equal(await page.locator('#session-picker').inputValue(), '', 'Rotation never selects or authorizes a plugin session automatically.');
    await page.keyboard.press('Escape'); await page.locator('#settings-drawer').waitFor({ state: 'hidden' });
    assert.equal((await page.locator('body').textContent())?.includes(second.apiKey), false);
    await page.locator('#app-sidebar [data-workspace-target="workspace-settings"]').click();
    await page.waitForFunction(() => !(document.getElementById('settings-key-copy') as HTMLButtonElement).disabled);
    await page.locator('#settings-key-copy').click(); assert.deepEqual(copied, [first.apiKey, second.apiKey]);
    assert.equal(nativeCalls.some(call => call.method === 'reveal'), false); assert.deepEqual(await chatView(), before);
    signedIn = false;
    await page.waitForFunction(() => (document.getElementById('settings-key-generate') as HTMLButtonElement).disabled);
    await page.keyboard.press('Escape'); await page.locator('#provider-login-gate').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#key-setup-gate').isVisible(), false);
    assert.equal(await page.locator('#settings-key-generate').isDisabled(), true);
    assert.equal(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage, location.href]).includes('arcane_local_v1_')), false);
    assert.equal(await page.locator('#codex-messages img, #codex-messages script').count(), 0);
    assert.equal(posts().filter(request => request.path === '/v1/studio/keys/rotate').length, 2);
    assert.deepEqual(browserCopied, []); assert.deepEqual(unexpected, []); assert.deepEqual(errors, []);
    t.diagnostic('Full production module graph; real key HTTP/store contracts; synthetic provider and vault only; no native CLI/inference/Studio. Proof ' + directory);
  });
