/// <reference lib="dom" />
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SettingsKeyRecord } from '../../apps/desktop/src/studio-key-settings.js';

const browserModule = process.env.ARCANE_UI_BROWSER_MODULE;
const KEY_ID = '11111111-1111-4111-8111-111111111111', NEW_ID = '22222222-2222-4222-8222-222222222222';
const TOKEN = 'a'.repeat(64), DRAFT = 'Keep this same chat and unsent draft.  ';
type KeyFixture = { calls: { method: string; keyId?: string }[]; copied: string[]; saved: Record<string, string>;
  delay: boolean; settle: (() => void) | null; remembered: { keyId: string; apiKey: string } | null };
type FixtureWindow = Window & { keyFixture: KeyFixture };

// Full production HTML, CSS and module graph against an owned synthetic HTTP
// fixture and fake in-memory native bridge. No daemon, real vault, installed CLI,
// provider login, model, Blender or Studio operation is started.
async function fixture(t: TestContext, native: boolean) {
  const build = process.env.ARCANE_UI_BUILD_DIR; assert.ok(build, 'Use explicit private compilation.');
  const proof = await mkdtemp(join('C:/Users/alexk/AppData/Local/Temp/arcane-settings-ui-proof', 'key-settings-'));
  const playwright = await import(pathToFileURL(resolve(browserModule!)).href) as typeof import('playwright-core');
  let origin = '', project = 'b'.repeat(64), records: SettingsKeyRecord[] = native ? [{ keyId: KEY_ID, allowedRoots: ['Workspace'], allowWrites: false,
    issuedAt: '2026-10-13T12:00:00.000Z', revokedAt: null, lastUsedAt: null }] : [];
  const posts: { path: string; body: Record<string, unknown> }[] = [], errors: string[] = [], unexpected: string[] = [];
  const originalRecords=structuredClone(records);
  const files = new Map([
    ['/studio', [resolve('apps/desktop/public/studio.html'), 'text/html']],
    ['/studio.css', [resolve('apps/desktop/public/studio.css'), 'text/css']],
    ['/brand/arcane-ridges.png', [resolve('apps/desktop/public/brand/arcane-ridges.png'), 'image/png']],
  ]);
  for (const name of ['studio', 'studio-key-settings', 'codex-chat', 'codex-history', 'learning-panel', 'workspace-shell', 'provider-setup', 'desktop-verification', 'asset-downloads', 'workflow-panel', 'chat-tabs', 'task-usage', 'task-usage-ui'])
    files.set('/' + name + '.js', [resolve(build, 'apps/desktop/src/' + name + '.js'), 'text/javascript']);
  const server = createServer((request, reply) => { void (async () => {
    const path = new URL(request.url ?? '/', origin).pathname;
    const send = (value: unknown, status = 200) => { reply.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); reply.end(JSON.stringify(value)); };
    const file = files.get(path);
    if (file && request.method === 'GET') { reply.writeHead(200, { 'Content-Type': file[1]! }); reply.end(await readFile(file[0]!)); return; }
    if (path === '/favicon.ico') { reply.writeHead(204); reply.end(); return; }
    assert.equal(request.headers.authorization, 'Bearer ' + TOKEN);
    if (request.method === 'GET') {
      if (path === '/v1/product/state') { send({ protocolVersion: 1, projectId: project, projectPath: 'C:\\Synthetic\\' + project.slice(0, 8), studioSessions: [], commandCounts: {}, features: {}, buildTasks: [] }); return; }
      if (path === '/v1/studio/keys') { send({ keys: records }); return; }
      if (path === '/v1/studio/sessions') { send({ sessions: [] }); return; }
      if (path === '/v1/work/runs') { send({ runs: [] }); return; }
      if (path === '/v1/work/ready') { send({ tasks: [] }); return; }
      if (path === '/v1/codex/state') { send({ state: { provider: 'codex', use: 'personal-local', projectPath: 'C:\\Synthetic\\' + project.slice(0, 8), connecting: false,
        closing: false, busy: false, actions: [], snapshot: null, lastSnapshot: null, nativeTools: { configured: false, verified: false } } }); return; }
      if (['/v1/learning/state', '/v1/codex/history', '/v1/workflows'].includes(path)) { send({ error: 'FIXTURE_UNAVAILABLE', message: 'Synthetic UI fixture only.' }, 503); return; }
      if (path === '/v1/assets/conversation-jobs') { send({ error: 'NO_NATIVE_THREAD', message: 'No native thread in this UI fixture.' }, 409); return; }
    }
    if (request.method === 'POST' && ['/v1/studio/keys', '/v1/studio/keys/revoke'].includes(path)) {
      let body = ''; for await (const part of request) body += String(part);
      const input = JSON.parse(body) as Record<string, unknown>; posts.push({ path, body: input });
      if (path.endsWith('/revoke')) { const key = records.find(key => key.keyId === input.keyId); assert.ok(key); key.revokedAt = '2026-10-13T13:00:00.000Z'; send({ revoked: true }); return; }
      assert.deepEqual(input, { allowedRoots: ['Workspace'], allowWrites: false });
      const key = { keyId: NEW_ID, allowedRoots: ['Workspace'], allowWrites: false, issuedAt: '2026-10-13T12:30:00.000Z', revokedAt: null, lastUsedAt: null };
      records.push(key); send({ ...key, apiKey: 'arcane_local_v1_' + new URL(origin).port + '_' + 'd'.repeat(64) }); return;
    }
    unexpected.push((request.method ?? '') + ' ' + path); send({ error: 'FIXTURE_ROUTE' }, 404);
  })().catch(error => { errors.push(String(error)); reply.destroy(); }); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); assert.ok(address && typeof address !== 'string'); origin = 'http://127.0.0.1:' + address.port;
  const secret = 'arcane_local_v1_' + address.port + '_' + 'c'.repeat(64);
  const context = await playwright.chromium.launchPersistentContext(join(proof, 'edge-profile'), {
    executablePath: process.env.ARCANE_UI_BROWSER_EXE ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: true, viewport: { width: 1440, height: 900 }, args: ['--disable-gpu'], serviceWorkers: 'block',
  });
  t.after(async () => { try { await context.close(); } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); } });
  await context.route('**/*', async route => {
    if (new URL(route.request().url()).origin === origin) await route.continue();
    else { unexpected.push(route.request().url()); await route.abort(); }
  });
  await context.addInitScript(({ native, secret, keyId }) => {
    const f: KeyFixture = { calls: [], copied: [], saved: native ? { [keyId]: secret } : {}, delay: false, settle: null, remembered: null };
    Object.assign(window, { keyFixture: f });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (value: string) => { f.copied.push(value); } } });
    if (native) Object.defineProperty(window, 'arcaneDesktop', { value: Object.freeze({ studioKeys: Object.freeze({ version: 1,
      list: async () => { f.calls.push({ method: 'list' }); return { available: true, items: Object.keys(f.saved).map(keyId => ({ keyId })) }; },
      remember: async (input: { keyId: string; apiKey: string }) => { f.calls.push({ method: 'remember', keyId: input.keyId }); f.remembered = input; f.saved[input.keyId] = input.apiKey; return { remembered: true }; },
      reveal: async ({ keyId }: { keyId: string }) => { f.calls.push({ method: 'reveal', keyId }); const apiKey = f.saved[keyId]; if (f.delay) await new Promise<void>(done => { f.settle = done; }); return { apiKey }; },
      forget: async ({ keyId }: { keyId: string }) => { f.calls.push({ method: 'forget', keyId }); delete f.saved[keyId]; return { forgotten: true }; },
    }) }) });
  }, { native, secret, keyId: KEY_ID });
  const page = await context.newPage(); page.setDefaultTimeout(6000); page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/studio#' + TOKEN);
  await page.waitForFunction(() => document.getElementById('key-status')?.textContent === 'Key service responding');
  await page.locator('#codex-composer').fill(DRAFT);
  const counts = () => page.evaluate(() => (window as unknown as FixtureWindow).keyFixture.calls);
  const clean = async () => {
    assert.equal(await page.locator('#codex-composer').inputValue(), DRAFT);
    assert.equal(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage, location.href]).includes('arcane_local_v1_')), false);
    assert.deepEqual(unexpected, []); assert.deepEqual(errors, []);
  };
  const open = async () => { await page.locator('#app-sidebar [data-workspace-target="workspace-settings"]').click(); assert.equal(await page.locator('#settings-drawer').evaluate(node => node.matches(':modal')), true); };
  t.diagnostic('Synthetic HTTP + fake native bridge only. Edge ' + context.browser()!.version() + '; proof ' + proof);
  return { page, proof, posts, counts, clean, open, secret, projectSwitch: () => { project = 'e'.repeat(64); records = []; }, projectRestore: () => { project = 'b'.repeat(64); records = structuredClone(originalRecords); } };
}

test('real Edge synthetic native key fixture: masked mount, trusted Show/Copy, close/project/pagehide discard pending reveals',
  { skip: !browserModule, timeout: 30000 }, async t => {
    const f = await fixture(t, true), { page } = f;
    assert.equal(await page.locator('#settings-drawer').isVisible(), false); assert.deepEqual(await f.counts(), []);
    await f.open(); await page.waitForFunction(() => !(document.getElementById('settings-key-show') as HTMLButtonElement).disabled);
    assert.equal((await page.locator('body').textContent())?.includes(f.secret), false);
    assert.equal(await page.locator('#workspace-settings .settings-card').count(), 2);
    assert.equal(await page.locator('#key-form').isVisible(), false);
    assert.equal(await page.locator('#settings-key-select').inputValue(), KEY_ID);
    assert.equal(await page.locator('#settings-key-select option').textContent(), 'Studio key 1 · Read-only');
    assert.equal((await page.locator('#workspace-settings').innerText()).includes(KEY_ID), false);
    await page.screenshot({ path: join(f.proof, 'general-desktop-masked.png') });
    await page.locator('#settings-key-show').evaluate(node => (node as HTMLButtonElement).click());
    assert.equal((await f.counts()).filter(call => call.method === 'reveal').length, 0);
    await page.locator('#settings-key-show').click(); assert.equal(await page.locator('#settings-key-secret').textContent(), f.secret);
    await page.locator('#settings-key-copy').click(); assert.deepEqual(await page.evaluate(() => (window as unknown as FixtureWindow).keyFixture.copied), [f.secret]);
    await page.keyboard.press('Escape'); await page.locator('#settings-drawer').waitFor({ state: 'hidden' });
    assert.equal((await page.locator('body').textContent())?.includes(f.secret), false);
    await f.open(); await page.evaluate(() => { (window as unknown as FixtureWindow).keyFixture.delay = true; });
    await page.locator('#settings-key-show').click(); await page.waitForFunction(() => !!(window as unknown as FixtureWindow).keyFixture.settle);
    await page.keyboard.press('Escape');
    await page.evaluate(() => (window as unknown as FixtureWindow).keyFixture.settle?.());
    assert.equal((await page.locator('body').textContent())?.includes(f.secret), false);
    await f.open(); await page.locator('#settings-key-show').click();
    f.projectSwitch(); await page.waitForFunction(() => document.getElementById('project-path')?.textContent?.endsWith('eeeeeeee'), { timeout: 6000 });
    await page.evaluate(() => (window as unknown as FixtureWindow).keyFixture.settle?.());
    assert.equal((await page.locator('body').textContent())?.includes(f.secret), false);
    await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: join(f.proof, 'general-mobile-masked.png') });
    assert.equal(await page.locator('#settings-key-copy').isDisabled(), true);
    assert.equal(await page.locator('#codex-composer').inputValue(), '', 'A foreign project must not display the previous project draft.');
    f.projectRestore();
    await page.waitForFunction(() => document.getElementById('project-path')?.textContent?.endsWith('bbbbbbbb'));
    await page.waitForFunction(expected => (document.getElementById('codex-composer') as HTMLTextAreaElement).value === expected, DRAFT);
    assert.equal((await page.locator('body').textContent())?.includes(f.secret), false);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
    assert.equal((await page.locator('body').textContent())?.includes(f.secret), false); await f.clean();
  });

test('real Edge synthetic HTTP issuance: remembers exact validated human response, revocation forgets exact ID, browser fresh key clears',
  { skip: !browserModule, timeout: 30000 }, async t => {
    for (const native of [true, false]) {
      const f = await fixture(t, native), { page } = f;
      await f.open(); await page.locator('#workspace-settings [data-workspace-target="key-heading"]').click();
      assert.equal(await page.locator('#settings-advanced').isVisible(), true);
      assert.equal(await page.locator('#key-heading').evaluate(node => document.activeElement === node), true);
      await page.locator('input[name="key-root"][value="Workspace"]').check();
      await page.locator('#key-form').evaluate(node => node.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
      assert.equal(f.posts.length, 0, 'Synthetic submit cannot issue or remember.');
      await page.locator('#key-issue').click(); await page.waitForFunction(() => !document.getElementById('key-result')?.hidden);
      const issued = 'arcane_local_v1_' + new URL(page.url()).port + '_' + 'd'.repeat(64);
      if (native) {
        assert.deepEqual(await page.evaluate(() => (window as unknown as FixtureWindow).keyFixture.remembered), { keyId: NEW_ID, apiKey: issued });
        await page.locator('[data-settings-section-target="workspace-settings"]').click();
        await page.locator('#settings-key-details > summary').click();
        await page.locator('#settings-key-select').selectOption(NEW_ID); await page.waitForFunction(() => !(document.getElementById('settings-key-show') as HTMLButtonElement).disabled);
        assert.equal((await page.locator('body').textContent())?.includes(issued), false);
        await page.locator('#settings-key-show').click(); assert.equal(await page.locator('#settings-key-secret').textContent(), issued);
        await page.locator('#workspace-settings [data-workspace-target="key-heading"]').click();
        await page.locator('.key-history-details > summary').click();
        await page.locator('#key-history button[data-key-id="' + NEW_ID + '"]').click();
        assert.equal(await page.locator('dialog:modal').count(), 2); assert.equal(await page.locator('#confirm-action').isDisabled(), true);
        assert.ok((await page.locator('#confirm-preview').textContent())?.includes(NEW_ID));
        await page.locator('#confirm-check').check(); await page.locator('#confirm-action').click();
        await page.waitForFunction(id => (window as unknown as FixtureWindow).keyFixture.calls.some(call => call.method === 'forget' && call.keyId === id), NEW_ID);
        assert.deepEqual(f.posts.at(-1), { path: '/v1/studio/keys/revoke', body: { keyId: NEW_ID } });
        assert.equal((await page.locator('body').textContent())?.includes(issued), false);
      } else {
        await page.locator('#key-reveal').click(); assert.equal(await page.locator('#key-secret').textContent(), issued);
        await page.keyboard.press('Escape'); await page.locator('#settings-drawer').waitFor({ state: 'hidden' }); await f.open();
        assert.equal((await page.locator('body').textContent())?.includes(issued), false);
        assert.equal(await page.locator('#settings-key-show').isDisabled(), true);
        assert.match(await page.locator('#settings-key-storage').textContent() ?? '', /Browser keys are temporary/);
        assert.deepEqual(await f.counts(), []);
      }
      await f.clean();
    }
  });
