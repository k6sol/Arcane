/// <reference lib="dom" />
// C31 first-launch sign-in page in Edge: byte-identical production studio.html/studio.css with the compiled provider-setup
// and setup-checklist modules. A controlled native bridge stands in for the desktop host; there is no daemon, native CLI,
// credential file or inference. Every animation frame is sampled so a flash of the page or the workspace would be seen.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const browserModule = process.env.ARCANE_UI_BROWSER_MODULE;
const shots = process.env.ARCANE_SIGNIN_SHOTS;

async function fixture(t: TestContext, viewport = { width: 1440, height: 900 }) {
  assert.ok(process.env.ARCANE_UI_BUILD_DIR, 'Compile into private output first');
  const { chromium } = await import(pathToFileURL(resolve(browserModule!)).href) as typeof import('playwright-core');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.ARCANE_UI_BROWSER_EXE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', args: ['--disable-gpu'] });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport, colorScheme: 'dark', reducedMotion: 'reduce' });
  const page = await context.newPage();
  const html = await readFile('apps/desktop/public/studio.html'), css = await readFile('apps/desktop/public/studio.css');
  const build = process.env.ARCANE_UI_BUILD_DIR!;
  const modules = new Map([
    ['/user-errors.js', await readFile(join(build, 'apps/desktop/src/user-errors.js'))],
    ['/provider-setup.js', await readFile(join(build, 'apps/desktop/src/provider-setup.js'))],
    ['/setup-checklist.js', await readFile(join(build, 'apps/desktop/src/setup-checklist.js'))],
  ]);
  // The entry point waits until the test lets it boot, so the moment before provider setup runs can be observed.
  const bootstrap = `
    import { startProviderSetup } from '/provider-setup.js';
    import { startSetupChecklist } from '/setup-checklist.js';
    const f = window.ui = { calls: [], account: null, held: [], hold: false,
      status: { codex: 'signed-out', claude: 'signed-out' } };
    await new Promise(done => { window.bootNow = done; if (window.bootRequested) done(); });
    const native = Object.freeze({ version: 1, ...Object.fromEntries(['status', 'login', 'install', 'launch'].map(action => [action, async provider => {
      f.calls.push(action + ':' + provider);
      if (f.hold) await new Promise(done => f.held.push(done));
      return { version: 1, provider, installed: true, auth: f.status[provider], cliVersion: '1.0.0', busy: false, message: null };
    }])) });
    f.controller = startProviderSetup(document, { autoSelectSignedIn: true, signInPage: true, nativeBridge: native, chat: {
      providerConnectionStatus: () => f.account, subscribeProviderStateChange: fn => { f.refresh = fn; return () => {}; } } });
    const subs = [], sub = fn => { subs.push(fn); return () => {}; };
    f.checklist = startSetupChecklist(document, { provider: f.controller, storage: window.localStorage,
      workbench: { studioConnected: () => false, subscribeStudioChange: sub, getCurrentProduct: () => null, subscribeProjectChange: sub } });
    f.ready = true;
  `;
  const server = createServer((req, res) => {
    const path = req.url?.split('?')[0] ?? '';
    if (/^\/fonts\/[a-z0-9-]+\.woff2$/.test(path) || /^\/brand\/[a-z0-9-]+\.(png|svg)$/.test(path)) {
      void readFile(join('apps/desktop/public', path.slice(1))).then(bytes => { res.writeHead(200, { 'Content-Type': path.endsWith('.woff2') ? 'font/woff2' : path.endsWith('.svg') ? 'image/svg+xml' : 'image/png' }); res.end(bytes); },
        () => { res.writeHead(404); res.end(); }); return;
    }
    const body = path === '/studio' ? html : path === '/studio.css' ? css : path === '/studio.js' ? bootstrap : modules.get(path);
    if (!body) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': path === '/studio' ? 'text/html' : path === '/studio.css' ? 'text/css' : 'text/javascript', 'Cache-Control': 'no-store' }); res.end(body);
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  // Frame sampler: what a person could see on every painted frame.
  await page.addInitScript(() => {
    const w = window as any; w.__frames = [];
    const shown = (id: string) => { const node = document.getElementById(id); return !!node && node.checkVisibility() && node.getBoundingClientRect().height > 0; };
    const sample = () => {
      if (document.body) {
        const frame = { view: document.documentElement.dataset.providerView ?? '', page: shown('provider-login-gate'), splash: shown('provider-checking'),
          composer: shown('codex-compose'), checklist: shown('setup-checklist'), sidebar: shown('app-sidebar') };
        const last = w.__frames.at(-1);
        if (!last || JSON.stringify(last) !== JSON.stringify(frame)) w.__frames.push(frame);
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  const frames = () => page.evaluate(() => (window as any).__frames as { view: string; page: boolean; splash: boolean; composer: boolean; checklist: boolean; sidebar: boolean }[]);
  const nextFrames = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  const shot = async (name: string) => { if (shots) { await mkdir(shots, { recursive: true }); await page.screenshot({ path: join(shots, name + '.png') }); } };
  // The entry script pauses before booting, so wait for it (and the render-blocking stylesheet) instead of the load event.
  const open = async () => { await page.goto(origin + '/studio', { waitUntil: 'commit' }); await page.waitForFunction(() => typeof (window as any).bootNow === 'function' && !!document.getElementById('provider-checking')); };
  return { page, origin, errors, frames, nextFrames, shot, open };
}

test('Edge first launch: splash, then the full sign-in page; continue without signing in; checklist reopens it; sign in and sign out',
  { skip: !browserModule, timeout: 90000 }, async t => {
    const f = await fixture(t), { page } = f;
    await f.open();
    // Before provider setup runs, the static page is held back: the splash shows, never the page or the checklist.
    await f.nextFrames();
    assert.equal(await page.locator('#provider-checking').isVisible(), true);
    assert.equal(await page.locator('#provider-login-gate').isVisible(), false);
    assert.equal(await page.locator('#setup-checklist').isVisible(), false);
    assert.equal(await page.locator('#app-sidebar').isVisible(), false);
    await f.shot('splash-1440');
    // Boot with the status read held: 'checking' keeps the same splash.
    await page.evaluate(() => { const w = window as any; w.ui.hold = true; w.bootRequested = true; w.bootNow?.(); });
    await page.waitForFunction(() => (window as any).ui?.ready === true);
    await page.waitForFunction(() => (window as any).ui.held.length === 1);
    assert.equal(await page.locator('html').getAttribute('data-provider-view'), 'checking');
    assert.equal(await page.locator('#provider-checking').isVisible(), true);
    assert.equal(await page.locator('#provider-checking').innerText(), 'Checking sign-in…');
    assert.equal(await page.locator('#setup-checklist').isVisible(), false, 'the checklist is not shown while checking');
    assert.equal(await page.locator('#codex-compose').isVisible(), false);
    // Signed out everywhere: the page.
    await page.evaluate(() => { const w = window as any; w.ui.hold = false; for (const done of w.ui.held.splice(0)) done(); });
    await page.waitForFunction(() => document.documentElement.dataset.providerView === 'setup');
    await page.waitForFunction(() => (window as any).ui.calls.length === 2);
    await f.nextFrames();
    assert.equal(await page.locator('#provider-login-gate').isVisible(), true);
    assert.equal(await page.locator('#provider-checking').isVisible(), false);
    assert.equal(await page.locator('#setup-checklist').isVisible(), false, 'the page carries no checklist');
    assert.equal(await page.locator('#provider-login-skip').isVisible(), true);
    assert.equal(await page.locator('#provider-login-skip').innerText(), 'Continue without signing in');
    for (const viewport of [{ width: 1440, height: 900 }, { width: 1040, height: 680 }, { width: 420, height: 900 }]) {
      await page.setViewportSize(viewport); await f.nextFrames();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no horizontal scroll at ' + viewport.width);
      for (const id of ['provider-login-codex', 'provider-login-claude', 'provider-login-start', 'provider-login-skip']) {
        const box = await page.locator('#' + id).boundingBox(); assert.ok(box, id);
        assert.ok(box.x >= 0 && box.x + box.width <= viewport.width + 1, id + ' inside at ' + viewport.width);
        assert.ok(box.height >= 32, id + ' target');
      }
      await f.shot('signin-' + viewport.width);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    const before = await f.frames();
    assert.equal(before.some(frame => frame.composer || frame.checklist || frame.sidebar), false, 'no workspace before the page: ' + JSON.stringify(before));
    assert.equal(before.some(frame => frame.page && frame.splash), false);
    assert.equal(before.findIndex(frame => frame.page), before.length - 1, 'the page appears once, at the end: ' + JSON.stringify(before));

    // Keyboard: the skip control is reachable and has a visible focus ring.
    await page.locator('#provider-login-start').focus().catch(() => {});
    await page.locator('#provider-login-skip').focus();
    assert.equal(await page.locator('#provider-login-skip').evaluate(node => getComputedStyle(node).outlineStyle), 'solid');
    await f.shot('signin-1440-skip-focus');

    // Continue without signing in: the workspace, remembered, no native call.
    const callsBefore = await page.evaluate(() => (window as any).ui.calls.length);
    await page.locator('#provider-login-skip').click();
    await page.waitForFunction(() => document.documentElement.dataset.providerView === 'workspace');
    await f.nextFrames();
    assert.equal(await page.locator('#provider-login-gate').isVisible(), false);
    assert.equal(await page.locator('#codex-compose').isVisible(), true);
    assert.equal(await page.locator('#setup-checklist').isVisible(), true);
    assert.equal(await page.locator('#setup-checklist [data-setup-action=sign-in]').isVisible(), true);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'codex-composer', 'focus moves to the message box');
    assert.equal(await page.evaluate(() => (window as any).ui.controller.isSignedIn()), false);
    assert.equal(await page.evaluate(() => (window as any).ui.calls.length), callsBefore);
    assert.equal(await page.evaluate(() => localStorage.getItem('arcane.sign-in-page.v1')), '{"version":1,"state":"skipped"}');
    await f.shot('workspace-after-skip-1440');

    // The checklist's Sign in step reopens the page.
    await page.locator('#setup-checklist [data-setup-action=sign-in]').click();
    await page.waitForFunction(() => document.documentElement.dataset.providerView === 'setup');
    assert.equal(await page.locator('#provider-login-gate').isVisible(), true);
    assert.equal(await page.locator('#codex-compose').isVisible(), false);
    assert.ok(await page.evaluate(() => ['provider-login-start', 'provider-login-codex'].includes(document.activeElement?.id ?? '')), 'focus is on the page');
    assert.equal(await page.evaluate(() => localStorage.getItem('arcane.sign-in-page.v1')), null);

    // A usable sign-in (fresh ready ChatGPT connection) leaves for the workspace.
    await page.evaluate(() => { const w = window as any; w.ui.account = { connected: true, ready: true, fresh: true, auth: 'subscription' }; w.ui.refresh(); });
    await page.waitForFunction(() => document.documentElement.dataset.providerView === 'workspace');
    assert.equal(await page.locator('#provider-login-gate').isVisible(), false);
    assert.equal(await page.locator('#codex-compose').isVisible(), true);
    assert.equal(await page.evaluate(() => localStorage.getItem('arcane.sign-in-page.v1')), '{"version":1,"state":"signed-in"}');

    // Signing out returns to the page.
    await page.evaluate(() => { const w = window as any; w.ui.account = { connected: true, ready: true, fresh: true, auth: 'signed-out' }; w.ui.refresh(); });
    await page.waitForFunction(() => document.documentElement.dataset.providerView === 'setup');
    assert.equal(await page.locator('#provider-login-gate').isVisible(), true);
    assert.equal(await page.locator('#codex-compose').isVisible(), false);
    assert.deepEqual(f.errors, []);
  });

test('Edge saved Claude sign-in: splash straight to the workspace, the page never paints', { skip: !browserModule, timeout: 60000 }, async t => {
  const f = await fixture(t), { page } = f;
  await f.open();
  await page.evaluate(() => { const w = window as any; w.ui.status.claude = 'subscription'; w.bootRequested = true; w.bootNow?.(); });
  await page.waitForFunction(() => document.documentElement.dataset.providerView === 'workspace');
  await f.nextFrames();
  const seen = await f.frames();
  assert.equal(seen.some(frame => frame.page), false, 'no page flash: ' + JSON.stringify(seen));
  assert.equal(seen.at(-1)?.composer, true);
  assert.equal(await page.evaluate(() => (window as any).ui.controller.chatSurface()), 'claude');
  assert.equal(await page.evaluate(() => localStorage.getItem('arcane.sign-in-page.v1')), '{"version":1,"state":"signed-in"}');
  assert.deepEqual(f.errors, []);
});

test('Edge remembered Continue without signing in: the next launch opens the workspace without showing the page', { skip: !browserModule, timeout: 60000 }, async t => {
  const f = await fixture(t), { page } = f;
  await page.addInitScript(() => { try { localStorage.setItem('arcane.sign-in-page.v1', '{"version":1,"state":"skipped"}'); } catch { /* Fixture only. */ } });
  await f.open();
  await page.evaluate(() => { const w = window as any; w.bootRequested = true; w.bootNow?.(); });
  await page.waitForFunction(() => (window as any).ui?.ready === true && (window as any).ui.calls.length >= 2);
  await f.nextFrames();
  assert.equal(await page.locator('html').getAttribute('data-provider-view'), 'workspace');
  const seen = await f.frames();
  assert.equal(seen.some(frame => frame.page), false, JSON.stringify(seen));
  assert.equal(await page.locator('#codex-compose').isVisible(), true);
  await f.shot('relaunch-skipped-1440');
  assert.deepEqual(f.errors, []);
});

test('Edge narrow window (420): page and splash fit with no horizontal scroll', { skip: !browserModule, timeout: 60000 }, async t => {
  const f = await fixture(t, { width: 420, height: 900 }), { page } = f;
  await f.open();
  await f.nextFrames();
  assert.equal(await page.locator('#provider-checking').isVisible(), true);
  await f.shot('splash-420');
  await page.evaluate(() => { const w = window as any; w.bootRequested = true; w.bootNow?.(); });
  await page.waitForFunction(() => document.documentElement.dataset.providerView === 'setup');
  await f.nextFrames();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await page.locator('#provider-login-skip').isVisible(), true);
  assert.deepEqual(f.errors, []);
});
