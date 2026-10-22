/// <reference lib="dom" />
// C31 motion, exits (studio.ts startExitMotion) in real Edge under the production CSP: the real studio.html and studio.css,
// the compiled WorkspaceShell and the exported helper. A closing surface hides at once for scripts, focus and the
// accessibility tree, while an inert, aria-hidden copy in a closed shadow root fades on the exit curve and is removed.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Page } from 'playwright-core';

const browserModule = process.env.ARCANE_UI_BROWSER_MODULE;
const options = { skip: !browserModule, timeout: 120_000 };
const POLICY = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' blob:; img-src 'self' blob:; object-src 'none'; worker-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

async function exitPage(t: TestContext, reducedMotion: 'reduce' | 'no-preference'): Promise<Page> {
  const build = process.env.ARCANE_UI_BUILD_DIR;
  assert.ok(build, 'Set ARCANE_UI_BUILD_DIR to the private compiled output.');
  const assets = 'apps/desktop/public';
  const playwright = await import(pathToFileURL(resolve(browserModule!)).href) as typeof import('playwright-core');
  const browser = await playwright.chromium.launch({ headless: true, args: ['--disable-gpu'],
    executablePath: process.env.ARCANE_UI_BROWSER_EXE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', reducedMotion, serviceWorkers: 'block' });
  const page = await context.newPage(), errors: string[] = [], unexpected: string[] = [];
  page.setDefaultTimeout(8_000);
  const html = (await readFile(resolve(assets, 'studio.html'), 'utf8'))
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
    .replace('</body>', '<script type="module" src="/exit-fixture.js"></script></body>');
  // The exported helpers only: the compiled studio.js up to its page bootstrap (the same cut the viewer product test uses).
  const workbench = await readFile(join(build, 'apps/desktop/src/studio.js'), 'utf8');
  const bootstrap = workbench.indexOf("if (typeof window !== 'undefined' && typeof document !== 'undefined')");
  assert.ok(bootstrap > 0, 'the page bootstrap is identified');
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://exit.fixture' || route.request().method() !== 'GET') { unexpected.push(route.request().url()); await route.abort(); return; }
    const csp = { 'Content-Security-Policy': POLICY };
    if (url.pathname === '/studio') { await route.fulfill({ contentType: 'text/html', body: html, headers: csp }); return; }
    if (url.pathname === '/exit-fixture.js') {
      await route.fulfill({ contentType: 'text/javascript', headers: csp, body: `
        import {startWorkspaceShell} from '/workspace-shell.js';
        import {startExitMotion} from '/studio.js';
        document.getElementById('workspace-stage').classList.remove('provider-required');
        document.getElementById('provider-login-gate').hidden = true;
        window.exitFixture = { shell: startWorkspaceShell(document, () => {}), motion: startExitMotion(document), csp: 0 };
        document.addEventListener('securitypolicyviolation', () => { window.exitFixture.csp++; });
      ` }); return;
    }
    if (url.pathname === '/studio.css') { await route.fulfill({ contentType: 'text/css', headers: csp, body: await readFile(resolve(assets, 'studio.css')) }); return; }
    if (url.pathname === '/studio.js') { await route.fulfill({ contentType: 'text/javascript', headers: csp, body: workbench.slice(0, bootstrap) }); return; }
    if (/^\/[a-z][a-z0-9-]*\.js$/.test(url.pathname)) {
      try { await route.fulfill({ contentType: 'text/javascript', headers: csp, body: await readFile(join(build, 'apps/desktop/src', url.pathname.slice(1))) }); }
      catch { unexpected.push(url.pathname); await route.abort(); }
      return;
    }
    if (/^\/(fonts|brand)\/[\w.-]+$/.test(url.pathname)) {
      try { await route.fulfill({ body: await readFile(resolve(assets, url.pathname.slice(1))), contentType: url.pathname.endsWith('.woff2') ? 'font/woff2' : 'image/png' }); }
      catch { await route.fulfill({ status: 404, body: '' }); }
      return;
    }
    unexpected.push(url.pathname); await route.abort();
  });
  await page.addInitScript(() => { window.fetch = async () => { throw new Error('No backend in the exit motion fixture.'); }; });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://exit.fixture/studio');
  await page.waitForFunction(() => !!(window as unknown as { exitFixture?: unknown }).exitFixture);
  // The copies' stylesheet is built once the window is idle; until then surfaces close as they always did.
  await page.evaluate(() => new Promise<void>(done => requestIdleCallback(() => done(), { timeout: 2000 })));
  await page.waitForTimeout(400);
  t.after(() => {
    assert.deepEqual(errors, [], 'no page errors'); assert.deepEqual(unexpected, [], 'only fixture files');
  });
  return page;
}
const frames = (page: Page) => page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
/** The copies on the page right now: the host element, its accessibility exposure and whether scripts can reach inside. */
const copies = (page: Page) => page.evaluate(() => Array.from(document.querySelectorAll('arcane-exit')).map(host => ({
  hidden: host.getAttribute('aria-hidden'), inert: (host as HTMLElement).inert, open: host.shadowRoot !== null,
  parent: host.parentElement === document.documentElement, events: getComputedStyle(host).pointerEvents })));
const slow = async (page: Page, rate: number) => { const cdp = await page.context().newCDPSession(page); await cdp.send('Animation.enable'); await cdp.send('Animation.setPlaybackRate', { playbackRate: rate }); };

test('Edge: a closing menu hides at once while an inert copy fades out and is removed', options, async t => {
  const page = await exitPage(t, 'no-preference');
  const menu = page.locator('#sidebar-menu'), toggle = page.locator('#sidebar-menu-toggle');
  const items = await menu.locator('button').count();
  assert.ok(items > 0, 'the footer menu has items');
  await toggle.click(); await frames(page);
  assert.equal(await menu.getAttribute('data-open'), 'true');
  // Slow the document timeline so the exit can be inspected; the helper reads no wall-clock time.
  await slow(page, .05);
  await page.keyboard.press('Escape');
  // The real menu is closed immediately: hidden from layout, hit testing, focus and the accessibility tree.
  assert.equal(await menu.getAttribute('data-open'), 'false');
  assert.equal(await menu.isVisible(), false);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'sidebar-menu-toggle', 'focus returns to the toggle');
  assert.equal(await page.getByRole('menuitem').count() + await page.locator('#sidebar-menu button:visible').count(), 0, 'no visible menu item for scripts or assistive technology');
  assert.equal(await page.locator('#sidebar-menu button').count(), items, 'the copy adds no reachable buttons');
  assert.deepEqual(await copies(page), [{ hidden: 'true', inert: true, open: false, parent: true, events: 'none' }], 'one inert, aria-hidden copy in a closed shadow root');
  const box = (await toggle.boundingBox())!;
  assert.ok(await page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.closest('#sidebar-menu-toggle') !== null, [box.x + box.width / 2, box.y + box.height / 2]), 'the copy never takes a press');
  await slow(page, 1);
  await page.waitForFunction(() => document.querySelectorAll('arcane-exit').length === 0, null, { timeout: 4000 });
  // Reopening while a copy fades removes the copy at once.
  await toggle.click(); await frames(page); await slow(page, .05);
  await page.keyboard.press('Escape'); assert.equal((await copies(page)).length, 1);
  await toggle.click(); assert.equal((await copies(page)).length, 0, 'a reopened surface drops its fading copy');
  assert.equal(await page.evaluate(() => (window as unknown as { exitFixture: { csp: number } }).exitFixture.csp), 0, 'no CSP violation (CSSOM and adopted sheets only)');
});

test('Edge: the settings drawer and its scrim fade out after close(); the dialog is closed for every reader at once', options, async t => {
  const page = await exitPage(t, 'no-preference');
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('workspace:settingsrequest', { detail: { target: 'workspace-settings' } })));
  await page.waitForFunction(() => (document.getElementById('settings-drawer') as HTMLDialogElement).open);
  await frames(page); await slow(page, .05);
  await page.locator('#settings-drawer [data-settings-close]').first().click();
  assert.equal(await page.evaluate(() => (document.getElementById('settings-drawer') as HTMLDialogElement).open), false);
  assert.equal(await page.locator('#settings-drawer').isVisible(), false);
  assert.equal((await copies(page)).length, 1, 'the drawer leaves as a copy');
  await slow(page, 1);
  await page.waitForFunction(() => document.querySelectorAll('arcane-exit').length === 0, null, { timeout: 4000 });
});

test('Edge: with reduced motion nothing is copied; surfaces close instantly', options, async t => {
  const page = await exitPage(t, 'reduce');
  const toggle = page.locator('#sidebar-menu-toggle');
  await toggle.click(); await frames(page);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#sidebar-menu').getAttribute('data-open'), 'false');
  await frames(page);
  assert.equal((await copies(page)).length, 0);
});
