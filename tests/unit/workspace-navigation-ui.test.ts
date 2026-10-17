/// <reference lib="dom" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const browserModule = process.env.ARCANE_UI_BROWSER_MODULE;

test('Edge workspace navigator: ranked tools, keyboard selection, shared draft, responsive layout and reference palette',
  { skip: !browserModule, timeout: 60000 }, async t => {
    const files = new Map([
      ['/studio', ['apps/desktop/public/studio.html', 'text/html']],
      ['/studio.css', ['apps/desktop/public/studio.css', 'text/css']],
      ['/workspace-shell.js', [join(process.env.ARCANE_UI_BUILD_DIR ?? 'dist', 'apps/desktop/src/workspace-shell.js'), 'text/javascript']],
      ['/brand/arcane-ridges.png', ['apps/desktop/public/brand/arcane-ridges.png', 'image/png']],
    ]);
    // Exercise the real markup and compiled shell with synthetic signed-in presentation.
    // No native controller is mounted; navigation must still make zero API requests.
    const server = createServer((request, response) => {
      void (async () => {
        if (request.url === '/navigation-fixture.js') {
          response.writeHead(200, { 'content-type': 'text/javascript' });
          response.end(`import {startWorkspaceShell} from "/workspace-shell.js";
            // Fixture presentation only; no authentication or native connection.
            document.getElementById('provider-login-gate').hidden=true;
            document.getElementById('workspace-stage').classList.remove('provider-required');
            window.navigationShell = startWorkspaceShell(document);`);
          return;
        }
        const file = files.get(request.url ?? '');
        if (!file) { response.writeHead(404); response.end(); return; }
        let bytes = await readFile(resolve(file[0]!));
        if (request.url === '/studio') bytes = Buffer.from(bytes.toString('utf8').replace('src="/studio.js"', 'src="/navigation-fixture.js"'));
        response.writeHead(200, { 'content-type': file[1]!, 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'" });
        response.end(bytes);
      })().catch(() => { response.writeHead(500); response.end(); });
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    t.after(() => new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const origin = 'http://127.0.0.1:' + address.port;
    const playwright = await import(pathToFileURL(browserModule!).href);
    const browser = await playwright.chromium.launch({ headless: true, args: ['--disable-gpu'],
      ...(process.env.ARCANE_UI_BROWSER_EXE ? { executablePath: process.env.ARCANE_UI_BROWSER_EXE } : {}) });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1586, height: 992 } });
    const errors: string[] = [], apiRequests: string[] = [];
    page.on('pageerror', (error: Error) => errors.push(error.message));
    page.on('request', (request: { url(): string }) => { if (new URL(request.url()).pathname.startsWith('/v1/')) apiRequests.push(request.url()); });
    await page.goto(origin + '/studio');
    await page.waitForFunction(() => document.getElementById('workspace-search')?.getAttribute('role') === 'combobox');
    assert.equal(await page.locator('#provider-login-gate').isVisible(), false);
    assert.equal(await page.locator('#codex-composer').isVisible(), true);
    const screenshotRoot = process.env.ARCANE_UI_SCREENSHOT ? dirname(resolve(process.env.ARCANE_UI_SCREENSHOT)) : null;
    const capture = async (name: string) => {
      if (screenshotRoot) { await mkdir(screenshotRoot, { recursive: true }); await page.screenshot({ path: join(screenshotRoot, name + '.png') }); }
    };
    const search = page.locator('#workspace-search'), results = page.locator('#workspace-search-results');
    const draft = 'Keep the original project request.\nAnd its whitespace.  ';
    await page.locator('#codex-composer').fill(draft);
    const drawer = page.locator('#settings-drawer');
    assert.equal(await drawer.isVisible(), false);
    // Global search indexes the selected pane. Visit Tools through the actual
    // section navigation, then close the modal before testing tool search.
    const settings = page.locator('#app-sidebar [data-workspace-target="workspace-settings"]');
    await settings.click();
    assert.equal(await drawer.evaluate((dialog: HTMLDialogElement) => dialog.matches(':modal')), true);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'workspace-settings');
    await drawer.locator('[data-settings-section-target="settings-tools"]').click();
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'settings-tools');
    assert.equal(await drawer.locator('[data-settings-section]:visible').count(), 1);
    await drawer.locator('[data-settings-close]').click();
    assert.equal(await drawer.isVisible(), false);
    assert.equal(await settings.evaluate((control: HTMLElement) => document.activeElement === control), true);
    assert.equal(await page.locator('#codex-composer').inputValue(), draft);
    await page.locator('#codex-notice').click();
    await page.keyboard.press('Control+k');
    assert.equal(await search.getAttribute('aria-expanded'), 'true');
    const optionCount = await results.getByRole('option').count();
    assert.ok(optionCount >= 2 && optionCount <= 16);
    assert.equal(await results.getByRole('option', { name: 'Blender', exact: true }).count(), 1);
    assert.equal(await results.getByRole('option', { name: 'All tools', exact: true }).count(), 0);
    assert.equal(await page.locator('#workspace-topbar [data-workspace-tool]:not([role="option"])').count(), 0);
    assert.equal(await page.locator('#workspace-chat-tabs').getAttribute('role'), 'tablist');
    assert.equal(await page.locator('#workspace-chat-tabs').getAttribute('aria-label'), 'Open chats');
    assert.equal(await page.locator('#workspace-new-chat').getAttribute('aria-label'), 'New chat');
    await search.fill('textures models');
    assert.equal(await results.getByRole('option').count(), 1);
    assert.equal(await results.getByRole('option').textContent(), 'Blender');
    await search.press('Enter');
    assert.equal(await page.locator('#workspace-stage').getAttribute('data-workspace-tool'), 'blender');
    assert.equal(await page.locator('#workspace-settings').getAttribute('open'), null);
    assert.equal(await page.locator('#settings-drawer').isVisible(), false);
    assert.equal(await page.locator('#codex-composer').inputValue(), draft);
    await search.fill('');
    assert.equal(await results.getByRole('option').first().textContent(), 'Blender');
    await search.press('ArrowDown');
    const active = await search.getAttribute('aria-activedescendant');
    assert.ok(active);
    assert.equal(await page.locator('#' + active).getAttribute('aria-selected'), 'true');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'workspace-search');
    await capture('workspace-search-desktop');
    await search.fill('export files');
    await search.press('Enter');
    assert.equal(await page.locator('#workspace-settings').getAttribute('open'), null);
    assert.equal(await page.locator('#settings-drawer').evaluate((dialog: HTMLDialogElement) => dialog.matches(':modal')), true);
    assert.equal(await page.locator('#settings-tools').isVisible(), true);
    assert.equal(await page.locator('#settings-drawer [data-settings-section]:visible').count(), 1);
    assert.equal(await page.locator('[data-settings-section-target="settings-tools"]').getAttribute('aria-current'), 'page');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'asset-heading');
    assert.equal(await page.locator('#asset-heading').isVisible(), true);
    assert.equal(await results.isVisible(), false);
    await page.locator('[data-settings-close]').click();
    assert.equal(await page.locator('#new-chat').isDisabled(),true,'Shell-only layout has no chat controller; it cannot create a chat.');
    await page.evaluate(()=>(window as unknown as {navigationShell:{showConversation():void}}).navigationShell.showConversation());
    assert.equal(await page.locator('#codex-composer').inputValue(), draft);
    // Capture the main workspace with its advanced settings folded away.
    await capture('workspace-desktop');
    const palette = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return ['--bg', '--text', '--accent'].map(name => style.getPropertyValue(name).trim());
    });
    assert.deepEqual(palette, ['#f5f5f5', '#080808', '#ff3340']);
    for (const viewport of [{ width: 945, height: 618 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.evaluate(()=>(window as unknown as {navigationShell:{showConversation():void}}).navigationShell.showConversation());
      const layout = await page.evaluate(() => {
        const composer = document.getElementById('codex-compose')!.getBoundingClientRect();
        return { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, composerTop: composer.top, composerBottom: composer.bottom };
      });
      assert.ok(layout.scrollWidth <= layout.width, JSON.stringify(layout));
      assert.ok(layout.composerTop >= 0 && layout.composerBottom <= layout.height, JSON.stringify(layout));
      await capture('workspace-' + viewport.width);
      await search.fill('');
      const popup = await results.boundingBox(); assert.ok(popup);
      assert.ok(popup.x >= 0 && popup.x + popup.width <= viewport.width + 1, JSON.stringify(popup));
      assert.ok(popup.y + popup.height <= viewport.height + 1, JSON.stringify(popup));
      await capture('workspace-search-' + viewport.width);
      await search.press('Escape');
    }
    await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
    await search.fill('textures');
    assert.equal(await results.getByRole('option').evaluate((row: HTMLElement) => getComputedStyle(row).outlineStyle), 'solid');
    await search.press('Tab'); assert.equal(await results.isVisible(), false);
    assert.deepEqual(errors, []); assert.deepEqual(apiRequests, []);
    t.diagnostic('Installed Edge ' + browser.version() + '; three viewports; real compiled shell; zero API requests.');
  });
