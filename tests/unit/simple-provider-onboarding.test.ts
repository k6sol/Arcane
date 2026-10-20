/// <reference lib="dom" />
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const browserModule = process.env.ARCANE_UI_BROWSER_MODULE;
const htmlPath = 'apps/desktop/public/studio.html', cssPath = 'apps/desktop/public/studio.css';

test('production onboarding keeps empty mounts, a minimal sign-in gate and concise hidden setup controls', async () => {
  const html = await readFile(htmlPath, 'utf8'), css = await readFile(cssPath, 'utf8');
  const topbar = html.slice(html.indexOf('<header id="workspace-topbar"'), html.indexOf('</header>'));
  assert.match(topbar, /id="workspace-chat-tabs"[^>]*role="tablist"[^>]*aria-label="Open chats"><\/div>/);
  assert.match(topbar, /id="workspace-new-chat"[^>]*aria-label="New chat"/);
  assert.doesNotMatch(topbar, /All tools|Roblox|Blender|data-workspace-tool/);
  assert.match(html, /id="codex-task-usage"[^>]*aria-live="polite"[^>]*hidden><\/div>/);
  assert.match(html, /id="provider-login-heading">Sign in<\/h2>/);
  const gate = html.slice(html.indexOf('<section id="provider-login-gate"'), html.indexOf('</section>', html.indexOf('<section id="provider-login-gate"')));
  assert.match(gate, /aria-describedby="provider-login-message"/);
  assert.match(gate, /id="provider-login-start"[^>]*disabled>Sign in with ChatGPT/);
  assert.match(gate, /id="provider-login-refresh"[^>]*disabled hidden/);
  assert.equal((gate.match(/class="button-row provider-next"/g) ?? []).length, 1);
  assert.doesNotMatch(gate, /type="password"|type="email"|install|Version|token|model catalogue/);
  assert.match(html.slice(html.indexOf('<section id="settings-advanced"')), /id="provider-setup-details"/);
  const pickerSetup = html.match(/<div\b[^>]*class="picker-setup-actions"[^>]*\bhidden[^>]*>([\s\S]*?)<\/div>/)?.[1];
  assert.ok(pickerSetup, 'Provider setup controls stay hidden in the model picker');
  assert.match(pickerSetup, /id="codex-picker-claude"[^>]*type="button"[^>]*data-workspace-target="provider-setup-panel">Claude CLI<\/button>/);
  assert.doesNotMatch(pickerSetup, /native terminal/);
  assert.match(html, /Claude Code opens in its native terminal\./);
  assert.match(css, /--accent:#ff3340/); assert.match(css, /var\(--accent\)/);
  assert.match(css, /font-family:"Segoe UI",system-ui,-apple-system,BlinkMacSystemFont,Arial,sans-serif/);
  assert.match(css, /prefers-reduced-motion:reduce/);
  assert.match(css, /\[hidden\]\{display:none!important\}/);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'Every existing hook and new mount has one ID');
});

async function fixture(t: TestContext, native = false, denyStorage = false) {
  assert.ok(process.env.ARCANE_UI_BUILD_DIR, 'Compile into private output; do not rebuild the accepted EXE');
  const { chromium } = await import(pathToFileURL(resolve(browserModule!)).href) as typeof import('playwright-core');
  const root = await mkdtemp(join(process.env.ARCANE_UI_FIXTURE_DIR ?? tmpdir(), 'arcane-simple-signin-'));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.ARCANE_UI_BROWSER_EXE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', args: ['--disable-gpu'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  if (denyStorage) await page.addInitScript(() => Object.defineProperty(window, 'localStorage', { get() { throw new Error('Storage denied'); } }));
  const html = await readFile(htmlPath), css = await readFile(cssPath);
  const build = process.env.ARCANE_UI_BUILD_DIR!;
  const modules = new Map([
    ['/provider-setup.js', await readFile(join(build, 'apps/desktop/src/provider-setup.js'))],
    ['/workspace-shell.js', await readFile(join(build, 'apps/desktop/src/workspace-shell.js'))],
    ['/brand/arcane-ridges.png', await readFile('apps/desktop/public/brand/arcane-ridges.png')],
  ]);
  // Serve byte-identical production HTML/CSS. Only the test entrypoint supplies
  // controlled state; no daemon, credential file, native CLI or inference exists.
  const bootstrap = `
    import { startProviderSetup, PROVIDER_PRESENTATION_KEY } from '/provider-setup.js';
    import { startWorkspaceShell } from '/workspace-shell.js';
    const f = window.providerUI = { calls: [], sessionActions: [], preferences: [], account: null, hold: false,
      response: { version: 1, installed: true, auth: 'unknown', cliVersion: '1.0.0', busy: false, message: null } };
    const native = ${native ? `Object.freeze({ version: 1, ...Object.fromEntries(['status','login','install','launch'].map(action => [action, async provider => {
      f.calls.push({ action, provider });
      const response = { ...f.response, provider };
      if (f.hold) await new Promise(done => f.release = done);
      return response;
    }])) })` : 'null'};
    document.addEventListener('workspace:providerpreference', event => f.preferences.push(event.detail));
    f.controller = startProviderSetup(document, { nativeBridge: native, chat: {
      providerConnectionStatus: () => f.account, subscribeProviderStateChange: fn => { f.refresh = fn; return () => {}; }
    }});
    f.shell = startWorkspaceShell(document);
    f.presentationKey = PROVIDER_PRESENTATION_KEY;
    const connect = document.getElementById('codex-connect'); connect.disabled = false;
    connect.addEventListener('click', () => f.sessionActions.push('connect'));
    for (const id of ['codex-thread-start', 'codex-thread-resume', 'codex-select', 'codex-grant', 'codex-assets-grant', 'codex-submit', 'asset-start']) {
      document.getElementById(id)?.addEventListener('click', () => f.sessionActions.push(id));
    }
    document.getElementById('codex-compose').addEventListener('submit', event => { event.preventDefault(); f.sessionActions.push('submit'); });
    f.ready = true;
  `;
  const unexpected: string[] = [], errors: string[] = [];
  const server = createServer((req, res) => {
    const path = req.url?.split('?')[0];
    if (req.method === 'GET' && path === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    const body = path === '/studio' ? html : path === '/studio.css' ? css : path === '/studio.js' ? bootstrap : modules.get(path ?? '');
    if (req.method !== 'GET' || !body) { unexpected.push(req.method + ' ' + req.url); res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': path === '/studio' ? 'text/html' : path === '/studio.css' ? 'text/css' : path?.endsWith('.png') ? 'image/png' : 'text/javascript', 'Cache-Control': 'no-store' }); res.end(body);
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
  page.on('pageerror', error => errors.push(error.message));
  const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  await page.goto(origin + '/studio'); await page.waitForFunction(() => (window as any).providerUI?.ready);
  await page.waitForFunction(() => document.getElementById('provider-login-gate')?.getAttribute('aria-busy') === 'false');
  const calls = () => page.evaluate(() => (window as any).providerUI.calls);
  return { page, browser, root, origin, calls, unexpected, errors, html, css };
}

test('Edge production surface: three viewports, real disabled browser setup, remembered choice never signs in',
  { skip: !browserModule, timeout: 60000 }, async t => {
    const f = await fixture(t), { page } = f;
    assert.deepEqual(await f.calls(), []);
    assert.equal(await page.locator('#workspace-chat-tabs').textContent(), '');
    assert.equal(await page.locator('#codex-task-usage').isVisible(), false);
    assert.equal(await page.locator('#provider-login-start').isDisabled(), true);
    assert.equal(await page.locator('#provider-login-refresh').isVisible(), false);
    assert.equal(await page.locator('#provider-login-gate').isVisible(), true);
    assert.equal(await page.locator('#codex-submit').isDisabled(), true);
    assert.equal(await page.locator('#settings-drawer').isVisible(), false);
    assert.equal(await page.locator('#codex-picker-claude').isVisible(), false);
    const proof: object[] = [];
    for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      for (const id of ['provider-login-start', 'provider-login-codex', 'provider-login-claude']) {
        const rect = await page.locator('#' + id).boundingBox(); assert.ok(rect, id);
        assert.ok(rect.x >= 0 && rect.x + rect.width <= viewport.width + 1, id + ': ' + JSON.stringify(rect));
        assert.ok(rect.height >= 44, id + ' has a usable target');
      }
      assert.equal(await page.locator('#provider-login-heading').innerText(), 'Sign in');
      assert.equal(await page.locator('#provider-login-start').isDisabled(), true);
      for (const id of ['codex-composer', 'codex-model-trigger', 'workspace-new-chat', 'codex-submit', 'codex-messages', 'workflow-details', 'artifact-panel']) {
        assert.equal(await page.locator('#' + id).isVisible(), false, id + ' stays hidden while logged out');
      }
      const screenshot = join(f.root, 'production-' + viewport.width + '.png'); await page.screenshot({ path: screenshot });
      proof.push({ ...viewport, screenshot, nativeCalls: 0 });
      // A recorded unsafe outcome remains reviewable even with the sign-in gate.
      await page.locator('#codex-unknown').evaluate((node: HTMLElement) => node.hidden = false);
      assert.equal(await page.locator('#codex-unknown').isVisible(), true);
      assert.equal(await page.locator('#codex-reconcile').isVisible(), true);
      assert.equal(await page.locator('#codex-acknowledge').isDisabled(), true);
      assert.equal(await page.locator('#provider-login-gate').isVisible(), true);
      assert.equal(await page.locator('#codex-composer').isVisible(), false);
      await page.locator('#codex-unknown').evaluate((node: HTMLElement) => node.hidden = true);
    }
    await page.locator('#provider-login-claude').click();
    assert.equal(await page.locator('#provider-login-claude').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#provider-login-start').isDisabled(), true);
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem((window as any).providerUI.presentationKey)!)), { version: 1, provider: 'claude' });
    await page.reload(); await page.waitForFunction(() => (window as any).providerUI?.ready);
    assert.equal(await page.locator('#provider-login-claude').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#provider-login-gate').isVisible(), true);
    assert.equal(await page.locator('#codex-submit').isDisabled(), true);
    assert.deepEqual(await f.calls(), []);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.locator('#provider-login-start').evaluate(node => getComputedStyle(node).transitionDuration), '0s');
    await page.locator('#provider-login-codex').focus(); await page.keyboard.press('Tab');
    assert.equal(await page.locator('#provider-login-claude').evaluate(node => node === document.activeElement), true);
    assert.equal(await page.locator('#provider-login-claude').evaluate(node => getComputedStyle(node).outlineStyle), 'solid');
    // Settings navigation is available only after the fixture observes a fresh
    // account binding; changing a remembered provider never supplies that state.
    await page.evaluate(() => { const f = (window as any).providerUI; f.account = { connected: true, ready: true, fresh: true, auth: 'subscription' };
      document.dispatchEvent(new CustomEvent('workspace:providerpreference', { detail: { provider: 'codex' } })); f.refresh(); });
    await page.locator('#app-sidebar [data-workspace-target="workspace-settings"]').click();
    await page.locator('[data-workspace-target="provider-setup-details"]').click();
    assert.equal(await page.locator('#settings-advanced').isVisible(), true);
    assert.equal(await page.locator('#provider-setup-details').evaluate(node => node === document.activeElement), true);
    await page.keyboard.press('Escape');
    // An explicit signed-out observation clears the retained chat binding (a missing or stale read alone keeps the chat visible).
    await page.evaluate(() => { const f = (window as any).providerUI; f.account = { connected: true, ready: true, fresh: true, auth: 'signed-out' }; f.refresh(); });
    // Even a modified disabled DOM cannot manufacture an absent native bridge.
    await page.locator('#provider-login-start').evaluate((node: HTMLButtonElement) => node.disabled = false);
    await page.locator('#provider-login-start').click(); assert.deepEqual(await f.calls(), []);
    assert.deepEqual(await page.evaluate(() => (window as any).providerUI.sessionActions), []);
    assert.deepEqual(f.errors, []); assert.deepEqual(f.unexpected, []);
    await writeFile(join(f.root, 'proof.json'), JSON.stringify({ edge: f.browser.version(), htmlSHA256: createHash('sha256').update(f.html).digest('hex'), cssSHA256: createHash('sha256').update(f.css).digest('hex'), proof }, null, 2));
    t.diagnostic('Production HTML/CSS, zero native operations; proof=' + f.root);
  });

test('Edge native-contract fixture: metadata status reads, explicit login/connect, Claude handoff, expiry and no automatic model request or grant',
  { skip: !browserModule, timeout: 60000 }, async t => {
    const f = await fixture(t, true), { page } = f;
    // Seed a retained draft while the logged-out composer is hidden.
    await page.locator('#codex-composer').evaluate((node: HTMLTextAreaElement) => node.value = 'Keep my unsent draft.');
    const startup = [{ action: 'status', provider: 'codex' }];
    assert.deepEqual(await f.calls(), startup);
    assert.deepEqual(await page.evaluate(() => (window as any).providerUI.sessionActions), []);
    await page.locator('#provider-login-start').evaluate((node: HTMLElement) => node.click());
    await page.locator('#provider-login-start').click({ modifiers: ['Shift'] });
    assert.deepEqual(await f.calls(), startup);
    assert.equal(await page.locator('#provider-login-start').innerText(), 'Check sign-in', 'An unknown sign-in is checked before any browser sign-in starts');
    await page.evaluate(() => (window as any).providerUI.response.auth = 'signed-out');
    await page.locator('#provider-login-start').focus(); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.getElementById('provider-login-start')?.textContent === 'Sign in with ChatGPT');
    assert.deepEqual(await f.calls(), [...startup, { action: 'status', provider: 'codex' }]);
    await page.evaluate(() => (window as any).providerUI.response.auth = 'unknown'); // the browser handoff reports no account yet
    await page.locator('#provider-login-start').focus(); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.getElementById('provider-login-start')?.textContent === 'Check sign-in');
    assert.deepEqual(await f.calls(), [...startup, { action: 'status', provider: 'codex' }, { action: 'login', provider: 'codex' }]);
    assert.equal(await page.locator('#provider-login-gate').isVisible(), true, 'A terminal handoff never means signed in');
    await page.evaluate(() => (window as any).providerUI.response.auth = 'subscription');
    await page.locator('#provider-login-start').click();
    await page.waitForFunction(() => document.getElementById('provider-login-start')?.textContent === 'Connect Codex');
    assert.equal(await page.locator('#provider-login-gate').isVisible(), true, 'Native sign-in metadata alone never creates a chat binding');
    await page.locator('#provider-login-start').click();
    assert.deepEqual(await page.evaluate(() => (window as any).providerUI.sessionActions), ['connect']);
    assert.deepEqual((await f.calls()).map((call: any) => call.action), ['status', 'status', 'login', 'status']);
    await page.evaluate(() => { const f = (window as any).providerUI; f.account = { connected: true, ready: true, fresh: true, auth: 'subscription' }; f.refresh(); });
    assert.equal(await page.locator('#provider-login-gate').isVisible(), false);
    assert.equal(await page.locator('#codex-composer').isVisible(), true);
    // A temporary read failure keeps the signed-in conversation visible; native authority still requires fresh state.
    await page.evaluate(() => { const f = (window as any).providerUI; f.account.fresh = false; f.refresh(); });
    assert.equal(await page.locator('#provider-login-gate').isVisible(), false);
    assert.equal(await page.locator('#codex-composer').isVisible(), true);
    assert.equal(await page.evaluate(() => (window as any).providerUI.controller.isSignedIn()), false);
    await page.evaluate(() => { const f = (window as any).providerUI; f.account = null; const original = Date.now; Date.now = () => original() + 60001; f.refresh(); });
    assert.equal(await page.locator('#provider-login-start').innerText(), 'Check sign-in', 'Expired native metadata cannot authorize reuse');
    assert.equal(await page.locator('#provider-login-gate').isVisible(), false, 'A missing read keeps the retained conversation visible');
    // A fresh signed-out observation clears the retained binding and shows the sign-in card again.
    await page.evaluate(() => { const f = (window as any).providerUI; f.account = { connected: false, ready: false, fresh: true, auth: 'signed-out' }; f.refresh(); });
    assert.equal(await page.locator('#provider-login-gate').isVisible(), true);
    await page.evaluate(() => (window as any).providerUI.response.auth = 'unknown');
    await page.locator('#provider-login-claude').click();
    await page.waitForFunction(() => document.getElementById('provider-login-gate')?.getAttribute('aria-busy') === 'false');
    assert.deepEqual((await f.calls()).at(-1), { action: 'status', provider: 'claude' });
    assert.equal(await page.locator('#provider-login-message').innerText(), 'Claude Code opens in its native terminal.');
    await page.locator('#provider-login-start').click();
    await page.waitForFunction(() => document.getElementById('provider-login-start')?.textContent === 'Check sign-in');
    await page.evaluate(() => (window as any).providerUI.response.auth = 'subscription');
    await page.locator('#provider-login-start').click();
    await page.waitForFunction(() => document.getElementById('provider-login-start')?.textContent === 'Open Claude Code');
    const beforeLaunch = (await f.calls()).length;
    // A fresh signed-in Claude status hands the shared chat surface to Claude: the same composer and transcript stay,
    // only the provider-specific tabs strip and notices swap.
    assert.equal(await page.locator('#provider-login-gate').isVisible(), false);
    assert.equal(await page.locator('#codex-compose').isVisible(), true, 'both providers use the same composer');
    assert.equal(await page.locator('#claude-chat-notice').evaluate(node => (node as HTMLElement).hidden), false, 'the Claude notice line is shown');
    assert.equal(await page.locator('#codex-notice').isVisible(), false, 'Codex notices are hidden, not destroyed');
    assert.equal(await page.locator('#workspace-chat-tabs').isVisible(), false);
    assert.equal(await page.locator('#workspace-new-chat').isVisible(), true);
    await page.locator('#claude-chat-terminal').click(); await page.waitForFunction(n => (window as any).providerUI.calls.length === n + 1, beforeLaunch);
    assert.deepEqual((await f.calls()).at(-1), { action: 'launch', provider: 'claude' });
    assert.equal(await page.locator('#claude-chat-terminal').isVisible(), true, 'Terminal handoff stays a secondary action beside the chat');
    assert.equal(await page.locator('#codex-submit').isDisabled(), true);
    assert.equal(await page.locator('#codex-composer').inputValue(), 'Keep my unsent draft.');
    assert.equal((await f.calls()).some((call: any) => call.action === 'install'), false);
    assert.deepEqual(await page.evaluate(() => (window as any).providerUI.sessionActions), ['connect'], 'Setup never starts a thread, model request or grant');
    assert.deepEqual(await page.evaluate(() => (window as any).providerUI.preferences.map((value: object) => Object.keys(value))), [['provider']]);
    assert.deepEqual(f.errors, []); assert.deepEqual(f.unexpected, []);
  });

test('Edge setup guards: late provider/lifecycle responses, exact preference restore, storage denial and hostile status',
  { skip: !browserModule, timeout: 60000 }, async t => {
    const f = await fixture(t, true, true), { page } = f;
    await page.evaluate(() => { const f = (window as any).providerUI; f.hold = true; f.response.auth = 'subscription'; });
    await page.locator('#provider-login-start').click();
    await page.waitForFunction(() => typeof (window as any).providerUI.release === 'function');
    assert.equal(await page.locator('#provider-login-start').isDisabled(), true);
    await page.locator('#provider-login-claude').click();
    await page.evaluate(() => { const f = (window as any).providerUI; f.hold = false; f.response.auth = 'unknown'; f.release(); });
    await page.waitForFunction(() => document.getElementById('provider-login-gate')?.getAttribute('aria-busy') === 'false');
    assert.equal(await page.locator('#provider-login-start').innerText(), 'Check sign-in', 'An unknown Claude sign-in is checked, never treated as signed in');
    assert.equal(await page.locator('#provider-login-gate').isVisible(), true);
    assert.equal(await page.evaluate(() => (window as any).providerUI.controller.isSignedIn()), false, 'A stale response for Codex cannot sign in Claude');
    await page.evaluate(() => {
      const f = (window as any).providerUI; f.hold = false;
      document.dispatchEvent(new CustomEvent('workspace:providerpreference', { detail: { provider: 'codex' } }));
      document.dispatchEvent(new CustomEvent('workspace:providerpreference', { detail: { provider: 'claude', auth: 'subscription' } }));
      let reads = 0; const detail = {}; Object.defineProperty(detail, 'provider', { enumerable: true, get() { reads++; return 'claude'; } });
      document.dispatchEvent(new CustomEvent('workspace:providerpreference', { detail })); f.accessorReads = reads;
    });
    assert.equal(await page.locator('#provider-login-codex').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#settings-drawer').isVisible(), false, 'Preference restoration never opens Settings');
    assert.equal(await page.evaluate(() => (window as any).providerUI.accessorReads), 0);
    await page.waitForFunction(() => document.getElementById('provider-login-gate')?.getAttribute('aria-busy') === 'false');
    assert.deepEqual(await f.calls(), [
      { action: 'status', provider: 'codex' }, { action: 'status', provider: 'codex' },
      { action: 'status', provider: 'claude' }, { action: 'status', provider: 'codex' },
    ], 'Only valid provider changes read metadata; hostile preference payloads cause no action');
    await page.evaluate(() => { const f = (window as any).providerUI; f.hold = true; f.release = null; f.response.auth = 'subscription'; });
    await page.locator('#provider-login-start').click(); await page.waitForFunction(() => typeof (window as any).providerUI.release === 'function');
    await page.evaluate(() => { const f = (window as any).providerUI; f.controller.stop(); f.controller.resume(); f.hold = false; f.response.auth = 'unknown'; f.release(); });
    await page.waitForFunction(() => document.getElementById('provider-login-gate')?.getAttribute('aria-busy') === 'false');
    assert.equal(await page.locator('#provider-login-start').innerText(), 'Check sign-in', 'A late response after stop/resume cannot sign in');
    await page.evaluate(() => { const f = (window as any).providerUI; f.hold = false; f.response.token = 'not-allowed'; });
    await page.locator('#provider-login-start').click();
    await page.waitForFunction(() => document.getElementById('provider-login-message')?.textContent?.includes('Setup unavailable'));
    assert.equal(await page.locator('#provider-login-gate').isVisible(), true);
    assert.equal(await page.locator('#codex-submit').isDisabled(), true);
    await page.evaluate(() => {
      const f = (window as any).providerUI; f.controller.cleanup();
      (document.getElementById('provider-login-start') as HTMLButtonElement).disabled = false;
    });
    const count = (await f.calls()).length; await page.locator('#provider-login-start').click(); assert.equal((await f.calls()).length, count);
    assert.deepEqual(await page.evaluate(() => (window as any).providerUI.sessionActions), []);
    assert.deepEqual(f.errors, []); assert.deepEqual(f.unexpected, []);
  });
