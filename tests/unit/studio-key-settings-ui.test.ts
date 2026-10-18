/// <reference lib="dom" />
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SettingsKeyRecord } from '../../apps/desktop/src/studio-key-settings.js';
import { STUDIO_ROOTS } from '../../apps/desktop/src/studio.js';

const browserModule = process.env.ARCANE_UI_BROWSER_MODULE;
const KEY_ID = '11111111-1111-4111-8111-111111111111', NEW_ID = '22222222-2222-4222-8222-222222222222';
const TOKEN = 'a'.repeat(64), DRAFT = 'Keep this same chat and unsent draft.  ';
type KeyFixture = { calls: { method: string; keyId?: string }[]; copied: string[]; nativeCopied: string[]; saved: Record<string, string>;
  delay: boolean; settle: (() => void) | null; remembered: { keyId: string; apiKey: string } | null };
type FixtureWindow = Window & { keyFixture: KeyFixture };
// Synthetic in-memory failure switches for the fake native bridge and browser clipboard double.
type Failures = { list?: 'throw' | 'unavailable'; copy?: boolean; replace?: boolean; clipboard?: boolean };
const UNREADABLE = 'The saved key cannot be read on this desktop. Use Regenerate API key to create a new connection key.';
const COPY_FAILED = 'The saved key could not be copied. Use Show to view it, or Regenerate API key to create a new connection key.';

// Full production HTML, CSS and module graph against an owned synthetic HTTP
// fixture and fake in-memory native bridge. No daemon, real vault, installed CLI,
// provider login, model, Blender or Studio operation is started.
async function fixture(t: TestContext, native: boolean, legacy = false, fail: Failures = {}) {
  const build = process.env.ARCANE_UI_BUILD_DIR; assert.ok(build, 'Use explicit private compilation.');
  const proof = await mkdtemp(join(process.env.TEMP!, 'arcane-key-settings-'));
  const playwright = await import(pathToFileURL(resolve(browserModule!)).href) as typeof import('playwright-core');
  let origin = '', project = 'b'.repeat(64), records: SettingsKeyRecord[] = native ? [{ keyId: KEY_ID, allowedRoots: [...STUDIO_ROOTS], allowWrites: true,
    issuedAt: '2026-10-13T12:00:00.000Z', revokedAt: null, lastUsedAt: null }] : [];
  const posts: { path: string; body: Record<string, unknown> }[] = [], errors: string[] = [], unexpected: string[] = [];
  const originalRecords=structuredClone(records);
  const files = new Map([
    ['/studio', [resolve('apps/desktop/public/studio.html'), 'text/html']],
    ['/studio.css', [resolve('apps/desktop/public/studio.css'), 'text/css']],
    ['/brand/arcane-ridges.png', [resolve('apps/desktop/public/brand/arcane-ridges.png'), 'image/png']],
  ]);
  // The actual compiled desktop module graph, by exact top-level name only (no fixed list to go stale).
  const moduleFile = async (path: string) => {
    const match = /^\/([a-z0-9-]+)\.js$/.exec(path); if (!match) return null;
    const full = resolve(build, 'apps/desktop/src', match[1] + '.js');
    try { return await readFile(full); } catch { return null; }
  };
  const server = createServer((request, reply) => { void (async () => {
    const path = new URL(request.url ?? '/', origin).pathname;
    const send = (value: unknown, status = 200) => { reply.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); reply.end(JSON.stringify(value)); };
    const file = files.get(path);
    if (file && request.method === 'GET') { reply.writeHead(200, { 'Content-Type': file[1]! }); reply.end(await readFile(file[0]!)); return; }
    const module = request.method === 'GET' ? await moduleFile(path) : null;
    if (module) { reply.writeHead(200, { 'Content-Type': 'text/javascript' }); reply.end(module); return; }
    if (path === '/favicon.ico') { reply.writeHead(204); reply.end(); return; }
    assert.equal(request.headers.authorization, 'Bearer ' + TOKEN);
    if (request.method === 'GET') {
      if (path === '/v1/product/state') { send({ protocolVersion: 1, projectId: project, projectPath: 'C:\\Synthetic\\' + project.slice(0, 8), studioSessions: [], commandCounts: {}, features: {}, buildTasks: [] }); return; }
      if (path === '/v1/studio/keys') { send({ keys: records }); return; }
      if (path === '/v1/studio/sessions') { send({ sessions: [] }); return; }
      if (path === '/v1/work/runs') { send({ runs: [] }); return; }
      if (path === '/v1/work/ready') { send({ tasks: [] }); return; }
      if (path === '/v1/codex/state') { send({ state: { provider: 'codex', use: 'personal-local', projectPath: 'C:\\Synthetic\\' + project.slice(0, 8), connecting: false,
        closing: false, busy: false, actions: [], snapshot: { connectionId: KEY_ID, provenance: 'spawned-node-fixture', connected: true, ready: true,
          account: { auth: 'subscription', plan: 'fixture', requiresOpenaiAuth: true }, models: [], selection: null, thread: null,
          operations: [], approvals: [], events: [], droppedEvents: 0, lastEventSeq: 0, failureCode: null },
        lastSnapshot: null, nativeTools: { configured: false, verified: false } } }); return; }
      // Plans & credits reads local usage once at start for the top-bar chip; the fixture leaves it unavailable.
      if (['/v1/learning/state', '/v1/codex/history', '/v1/workflows', '/v1/playtests', '/v1/plans/state'].includes(path)) { send({ error: 'FIXTURE_UNAVAILABLE', message: 'Synthetic UI fixture only.' }, 503); return; }
      if (path === '/v1/assets/conversation-jobs') { send({ error: 'NO_NATIVE_THREAD', message: 'No native thread in this UI fixture.' }, 409); return; }
    }
    if (request.method === 'POST' && ['/v1/studio/keys/rotate', '/v1/studio/keys/revoke'].includes(path)) {
      let body = ''; for await (const part of request) body += String(part);
      const input = JSON.parse(body) as Record<string, unknown>; posts.push({ path, body: input });
      if (path.endsWith('/revoke')) { const key = records.find(key => key.keyId === input.keyId); assert.ok(key); key.revokedAt = '2026-10-13T13:00:00.000Z'; send({ revoked: true }); return; }
      assert.deepEqual(input, {});
      for (const key of records) if (!key.revokedAt) key.revokedAt = '2026-10-13T12:30:00.000Z';
      const key = { keyId: NEW_ID, allowedRoots: [...STUDIO_ROOTS], allowWrites: true, issuedAt: '2026-10-13T12:30:00.000Z', revokedAt: null, lastUsedAt: null };
      records.push(key); send({ ...key, apiKey: 'arcane_local_v1_' + new URL(origin).port + '_' + 'd'.repeat(64) }); return;
    }
    unexpected.push((request.method ?? '') + ' ' + path); send({ error: 'FIXTURE_ROUTE' }, 404);
  })().catch(error => { errors.push(String(error)); reply.destroy(); }); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string'); origin = 'http://127.0.0.1:' + address.port;
  const secret = 'arcane_local_v1_' + address.port + '_' + 'c'.repeat(64);
  const context = await playwright.chromium.launchPersistentContext(join(proof, 'edge-profile'), {
    executablePath: process.env.ARCANE_UI_BROWSER_EXE ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: true, viewport: { width: 1440, height: 900 }, args: ['--disable-gpu'], serviceWorkers: 'block',
  });
  t.after(() => context.close());
  await context.route('**/*', async route => {
    if (new URL(route.request().url()).origin === origin) await route.continue();
    else { unexpected.push(route.request().url()); await route.abort(); }
  });
  await context.addInitScript(({ native, secret, keyId, legacy, fail }) => {
    const f: KeyFixture = { calls: [], copied: [], nativeCopied: [], saved: native ? { [keyId]: secret } : {}, delay: false, settle: null, remembered: null };
    Object.assign(window, { keyFixture: f });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (value: string) => { if (fail.clipboard) throw Error('Synthetic clipboard rejection'); f.copied.push(value); } } });
    if (native) Object.defineProperty(window, 'arcaneDesktop', { value: Object.freeze({ studioKeys: Object.freeze({ version: 1,
      list: async () => { f.calls.push({ method: 'list' }); if (fail.list === 'throw') throw Error('Synthetic unreadable vault');
        return fail.list === 'unavailable' ? { available: false, items: [] } : { available: true, items: Object.keys(f.saved).map(keyId => ({ keyId })) }; },
      remember: async (input: { keyId: string; apiKey: string }) => { f.calls.push({ method: 'remember', keyId: input.keyId }); f.remembered = input; f.saved[input.keyId] = input.apiKey; return { remembered: true }; },
      reveal: async ({ keyId }: { keyId: string }) => { f.calls.push({ method: 'reveal', keyId }); const apiKey = f.saved[keyId]; if (f.delay) await new Promise<void>(done => { f.settle = done; }); return { apiKey }; },
      forget: async ({ keyId }: { keyId: string }) => { f.calls.push({ method: 'forget', keyId }); delete f.saved[keyId]; return { forgotten: true }; },
      ...(!legacy ? {
        copy: async ({ keyId }: { keyId: string }) => { f.calls.push({ method: 'copy', keyId }); if (fail.copy || !f.saved[keyId]) throw Error('Synthetic native copy failure'); f.nativeCopied.push(f.saved[keyId]!); return { copied: true }; },
        replace: async (input: { keyId: string; apiKey: string }) => { f.calls.push({ method: 'replace', keyId: input.keyId }); if (fail.replace) throw Error('Synthetic storage failure'); f.remembered = input; f.saved = { [input.keyId]: input.apiKey }; return { remembered: true }; },
      } : {}),
    }) }) });
  }, { native, secret, keyId: KEY_ID, legacy, fail });
  const page = await context.newPage(); page.setDefaultTimeout(6000); page.setDefaultNavigationTimeout(20000); page.on('pageerror', error => errors.push(error.message));
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
  return { page, proof, posts, records: () => records, counts, clean, open, secret, projectSwitch: () => { project = 'e'.repeat(64); records = []; }, projectRestore: () => { project = 'b'.repeat(64); records = structuredClone(originalRecords); } };
}

test('real Edge synthetic native key fixture: masked mount, trusted Show/Copy, close/project/pagehide discard pending reveals',
  { skip: !browserModule, timeout: 30000 }, async t => {
    const f = await fixture(t, true), { page } = f;
    assert.equal(await page.locator('#settings-drawer').isVisible(), false); assert.deepEqual(await f.counts(), []);
    await f.open(); await page.waitForFunction(() => !(document.getElementById('settings-key-show') as HTMLButtonElement).disabled);
    assert.equal((await page.locator('body').textContent())?.includes(f.secret), false);
    // General holds the key card first, then the plugin, provider, display, notification, permission and shortcut cards.
    assert.deepEqual(await page.locator('#workspace-settings > .settings-card h3').allTextContents(),
      ['Arcane API key', 'Studio plugin', 'Provider', 'Display', 'Notifications', 'Permissions', 'Keyboard shortcuts']);
    assert.equal(await page.locator('#key-form').isVisible(), false);
    assert.equal(await page.locator('#settings-key-select').inputValue(), KEY_ID);
    assert.equal(await page.locator('#settings-key-select option').textContent(), 'Studio key 1 · Editing');
    assert.equal((await page.locator('#workspace-settings').innerText()).includes(KEY_ID), false);
    await page.screenshot({ path: join(f.proof, 'general-desktop-masked.png') });
    await page.locator('#settings-key-show').evaluate(node => (node as HTMLButtonElement).click());
    assert.equal((await f.counts()).filter(call => call.method === 'reveal').length, 0);
    assert.equal(await page.locator('#settings-key-copy').isEnabled(), true, 'Saved keys can be copied while masked.');
    await page.locator('#settings-key-copy').evaluate(node => (node as HTMLButtonElement).click());
    await page.locator('#settings-key-copy').click({ modifiers: ['Shift'] });
    assert.equal((await f.counts()).filter(call => call.method === 'copy').length, 0);
    await page.locator('#settings-key-copy').click();
    assert.deepEqual((await f.counts()).filter(call => call.method === 'copy'), [{ method: 'copy', keyId: KEY_ID }]);
    assert.deepEqual(await page.evaluate(() => (window as unknown as FixtureWindow).keyFixture.nativeCopied), [f.secret]);
    assert.deepEqual(await page.evaluate(() => (window as unknown as FixtureWindow).keyFixture.copied), []);
    assert.equal((await f.counts()).filter(call => call.method === 'reveal').length, 0);
    assert.equal((await page.locator('body').textContent())?.includes(f.secret), false);
    await page.locator('#settings-key-show').click(); assert.equal(await page.locator('#settings-key-secret').textContent(), f.secret);
    await page.locator('#settings-key-copy').click(); assert.deepEqual(await page.evaluate(() => (window as unknown as FixtureWindow).keyFixture.nativeCopied), [f.secret, f.secret]);
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

test('General Generate/Regenerate rotates all roots, replaces native storage, and metadata-confirmed revocation forgets the exact ID',
  { skip: !browserModule, timeout: 60000 }, async t => {
    for (const native of [true, false]) {
      const f = await fixture(t, native), { page } = f;
      await f.open();
      await page.waitForFunction(() => !(document.getElementById('settings-key-generate') as HTMLButtonElement).disabled);
      assert.equal(await page.locator('#settings-key-generate').textContent(), native ? 'Regenerate API key' : 'Generate API key');
      assert.equal(await page.locator('input[name="key-root"], #key-writes').count(), 0);
      await page.locator('#settings-key-generate').evaluate(node => (node as HTMLButtonElement).click());
      await page.locator('#settings-key-generate').click({ modifiers: ['Shift'] });
      assert.deepEqual(f.posts, [], 'Only a plain trusted human gesture rotates.');
      await page.locator('#settings-key-generate').click();
      await page.waitForFunction(id => (document.getElementById('settings-key-select') as HTMLSelectElement).value === id, NEW_ID);
      assert.deepEqual(f.posts, [{ path: '/v1/studio/keys/rotate', body: {} }]);
      assert.deepEqual(f.records().filter(key => !key.revokedAt).map(key => ({ keyId: key.keyId, allowedRoots: key.allowedRoots, allowWrites: key.allowWrites })),
        [{ keyId: NEW_ID, allowedRoots: [...STUDIO_ROOTS], allowWrites: true }]);
      if (native) assert.ok(f.records().find(key => key.keyId === KEY_ID)?.revokedAt);
      const issued = 'arcane_local_v1_' + new URL(page.url()).port + '_' + 'd'.repeat(64);
      if (native) {
        assert.deepEqual(await page.evaluate(() => (window as unknown as FixtureWindow).keyFixture.remembered), { keyId: NEW_ID, apiKey: issued });
        assert.deepEqual(await page.evaluate(() => (window as unknown as FixtureWindow).keyFixture.saved), { [NEW_ID]: issued });
        assert.deepEqual((await f.counts()).filter(call => call.method === 'replace'), [{ method: 'replace', keyId: NEW_ID }]);
        assert.equal((await f.counts()).some(call => call.method === 'remember'), false, 'Prefer atomic replacement on the new preload.');
        await page.waitForFunction(() => !(document.getElementById('settings-key-copy') as HTMLButtonElement).disabled);
        await page.locator('#settings-key-copy').click();
        assert.deepEqual(await page.evaluate(() => (window as unknown as FixtureWindow).keyFixture.nativeCopied), [issued]);
        await page.locator('#settings-key-show').click(); assert.equal(await page.locator('#settings-key-secret').textContent(), issued);
        await page.keyboard.press('Escape'); await page.locator('#settings-drawer').waitFor({ state: 'hidden' }); await f.open();
        assert.equal((await page.locator('body').textContent())?.includes(issued), false);
        await page.waitForFunction(() => !(document.getElementById('settings-key-copy') as HTMLButtonElement).disabled);
        await page.locator('#settings-key-copy').click();
        assert.deepEqual(await page.evaluate(() => (window as unknown as FixtureWindow).keyFixture.nativeCopied), [issued, issued]);
      } else {
        await page.locator('#settings-key-copy').click();
        assert.deepEqual(await page.evaluate(() => (window as unknown as FixtureWindow).keyFixture.copied), [issued]);
        await page.keyboard.press('Escape'); await page.locator('#settings-drawer').waitFor({ state: 'hidden' }); await f.open();
        assert.equal((await page.locator('body').textContent())?.includes(issued), false);
        assert.equal(await page.locator('#settings-key-show').isDisabled(), true);
        assert.equal(await page.locator('#settings-key-copy').isDisabled(), true);
        assert.match(await page.locator('#settings-key-storage').textContent() ?? '', /Browser keys are temporary/);
        assert.deepEqual(await f.counts(), []);
      }
      assert.equal(await page.locator('.key-history-details').isVisible(), false);
      const revoked = await page.request.post(new URL('/v1/studio/keys/revoke', page.url()).href,
        { headers: { Authorization: 'Bearer ' + TOKEN }, data: { keyId: NEW_ID } });
      assert.equal(revoked.status(), 200); assert.deepEqual(await revoked.json(), { revoked: true });
      await page.waitForFunction(() => document.getElementById('settings-key-status')?.textContent === 'No active key');
      assert.deepEqual(f.posts.at(-1), { path: '/v1/studio/keys/revoke', body: { keyId: NEW_ID } });
      if (native) {
        assert.deepEqual((await f.counts()).filter(call => call.method === 'forget' && call.keyId === NEW_ID), [{ method: 'forget', keyId: NEW_ID }]);
        assert.deepEqual(await page.evaluate(() => (window as unknown as FixtureWindow).keyFixture.saved), {});
      }
      assert.equal((await page.locator('body').textContent())?.includes(issued), false);
      await f.clean();
    }
  });

test('older native preload copies a saved masked key by reveal then browser clipboard without requiring Show',
  { skip: !browserModule, timeout: 30000 }, async t => {
    const f = await fixture(t, true, true), { page } = f;
    await f.open(); await page.waitForFunction(() => !(document.getElementById('settings-key-copy') as HTMLButtonElement).disabled);
    assert.equal((await page.locator('body').textContent())?.includes(f.secret), false);
    await page.locator('#settings-key-copy').click();
    await page.waitForFunction(() => (window as unknown as FixtureWindow).keyFixture.copied.length === 1, undefined, { timeout: 3000 });
    assert.deepEqual(await page.evaluate(() => (window as unknown as FixtureWindow).keyFixture.copied), [f.secret]);
    assert.deepEqual((await f.counts()).filter(call => call.method === 'reveal'), [{ method: 'reveal', keyId: KEY_ID }]);
    await page.keyboard.press('Escape'); assert.equal((await page.locator('body').textContent())?.includes(f.secret), false);
    await f.clean();
  });

test('older native preload remembers a validated generated key and discards a reveal completed after pagehide',
  { skip: !browserModule, timeout: 30000 }, async t => {
    const f = await fixture(t, true, true), { page } = f;
    await f.open(); await page.waitForFunction(() => !(document.getElementById('settings-key-generate') as HTMLButtonElement).disabled);
    await page.locator('#settings-key-generate').click();
    await page.waitForFunction(() => (window as unknown as FixtureWindow).keyFixture.calls.some(call => call.method === 'remember'));
    const issued = 'arcane_local_v1_' + new URL(page.url()).port + '_' + 'd'.repeat(64);
    assert.deepEqual(await page.evaluate(() => (window as unknown as FixtureWindow).keyFixture.remembered), { keyId: NEW_ID, apiKey: issued });
    await page.keyboard.press('Escape'); await page.locator('#settings-drawer').waitFor({ state: 'hidden' }); await f.open();
    await page.waitForFunction(() => !(document.getElementById('settings-key-show') as HTMLButtonElement).disabled);
    await page.evaluate(() => { (window as unknown as FixtureWindow).keyFixture.delay = true; });
    await page.locator('#settings-key-show').click(); await page.waitForFunction(() => !!(window as unknown as FixtureWindow).keyFixture.settle);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
    await page.evaluate(() => (window as unknown as FixtureWindow).keyFixture.settle?.());
    assert.equal((await page.locator('body').textContent())?.includes(issued), false);
    await f.clean();
  });

test('unreadable or unavailable native key storage explains recovery and keeps saved-key Show/Copy disabled',
  { skip: !browserModule, timeout: 60000 }, async t => {
    for (const list of ['throw', 'unavailable'] as const) {
      const f = await fixture(t, true, false, { list }), { page } = f;
      await f.open();
      await page.waitForFunction(expected => document.getElementById('settings-key-storage')?.textContent === expected, UNREADABLE);
      assert.equal(await page.locator('#settings-key-storage').isVisible(), true, 'Recovery guidance must be visible beside the disabled controls.');
      assert.equal(await page.locator('#settings-key-show').isDisabled(), true, list);
      assert.equal(await page.locator('#settings-key-copy').isDisabled(), true, list);
      assert.equal(await page.locator('#settings-key-generate').isEnabled(), true, list);
      assert.deepEqual((await f.counts()).filter(call => call.method !== 'list'), [], list + ': no silent regenerate, read or rewrite');
      assert.equal((await page.locator('body').textContent())?.includes(f.secret), false);
      await f.clean();
    }
  });

test('a rejected native copy says the saved key could not be copied, offers Show or Regenerate, and Show still works',
  { skip: !browserModule, timeout: 30000 }, async t => {
    const f = await fixture(t, true, false, { copy: true }), { page } = f;
    await f.open(); await page.waitForFunction(() => !(document.getElementById('settings-key-copy') as HTMLButtonElement).disabled);
    await page.locator('#settings-key-copy').click();
    await page.waitForFunction(expected => document.getElementById('settings-key-notice')?.textContent === expected, COPY_FAILED);
    assert.deepEqual(await page.evaluate(() => (window as unknown as FixtureWindow).keyFixture.copied), [], 'no browser clipboard fallback for a saved key');
    assert.deepEqual(await page.evaluate(() => (window as unknown as FixtureWindow).keyFixture.nativeCopied), []);
    await page.locator('#settings-key-show').click(); assert.equal(await page.locator('#settings-key-secret').textContent(), f.secret);
    await page.keyboard.press('Escape'); await page.locator('#settings-drawer').waitFor({ state: 'hidden' });
    assert.equal((await page.locator('body').textContent())?.includes(f.secret), false);
    await f.clean();
  });

test('a fresh key stays showable and copyable when desktop storage rejects the save',
  { skip: !browserModule, timeout: 30000 }, async t => {
    const f = await fixture(t, true, false, { replace: true }), { page } = f;
    await f.open(); await page.waitForFunction(() => !(document.getElementById('settings-key-generate') as HTMLButtonElement).disabled);
    await page.locator('#settings-key-generate').click();
    await page.waitForFunction(id => (document.getElementById('settings-key-select') as HTMLSelectElement).value === id, NEW_ID);
    await page.waitForFunction(() => document.getElementById('settings-key-notice')?.textContent === 'Desktop storage unavailable. This fresh key is temporary.');
    const issued = 'arcane_local_v1_' + new URL(page.url()).port + '_' + 'd'.repeat(64);
    assert.deepEqual((await f.counts()).filter(call => call.method === 'replace'), [{ method: 'replace', keyId: NEW_ID }]);
    await page.waitForFunction(() => !(document.getElementById('settings-key-copy') as HTMLButtonElement).disabled);
    await page.locator('#settings-key-copy').click();
    await page.waitForFunction(() => (window as unknown as FixtureWindow).keyFixture.copied.length === 1);
    assert.deepEqual(await page.evaluate(() => (window as unknown as FixtureWindow).keyFixture.copied), [issued]);
    await page.locator('#settings-key-show').click(); assert.equal(await page.locator('#settings-key-secret').textContent(), issued);
    await page.keyboard.press('Escape'); await page.locator('#settings-drawer').waitFor({ state: 'hidden' });
    assert.equal((await page.locator('body').textContent())?.includes(issued), false);
    await f.clean();
  });

test('a rejected browser clipboard write on a fresh key keeps accurate feedback before and after Show',
  { skip: !browserModule, timeout: 30000 }, async t => {
    const f = await fixture(t, true, false, { replace: true, clipboard: true }), { page } = f;
    await f.open(); await page.waitForFunction(() => !(document.getElementById('settings-key-generate') as HTMLButtonElement).disabled);
    await page.locator('#settings-key-generate').click();
    await page.waitForFunction(id => (document.getElementById('settings-key-select') as HTMLSelectElement).value === id, NEW_ID);
    await page.waitForFunction(() => !(document.getElementById('settings-key-copy') as HTMLButtonElement).disabled);
    await page.locator('#settings-key-copy').click();
    await page.waitForFunction(() => document.getElementById('settings-key-notice')?.textContent === 'Clipboard unavailable. Use Show, then select the key to copy it.');
    await page.locator('#settings-key-show').click(); await page.locator('#settings-key-copy').click();
    await page.waitForFunction(() => document.getElementById('settings-key-notice')?.textContent === 'Clipboard unavailable. Select the shown key to copy it.');
    assert.deepEqual(await page.evaluate(() => (window as unknown as FixtureWindow).keyFixture.copied), []);
    await page.keyboard.press('Escape'); await page.locator('#settings-drawer').waitFor({ state: 'hidden' });
    await f.clean();
  });
