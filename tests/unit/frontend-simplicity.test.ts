/// <reference lib="dom" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const browserModule = process.env.ARCANE_UI_BROWSER_MODULE;
const source = (file: string) => readFile(resolve(file), 'utf8');

test('General keeps one key action and initial guards without permission or history selectors', async () => {
  const html = await source('apps/desktop/public/studio.html');
  const general = html.slice(html.indexOf('<section id="workspace-settings"'), html.indexOf('<section id="settings-connections"'));
  const details = general.match(/<details id="settings-key-details"[^>]*>[\s\S]*?<\/details>/)?.[0];
  assert.ok(details);
  assert.match(details.slice(0, details.indexOf('>')), /\bhidden\b/);
  assert.doesNotMatch(details.slice(0, details.indexOf('>')), /\bopen\b/);
  assert.match(details, /<summary>Key details<\/summary>/);
  for (const id of ['settings-key-select', 'settings-key-metadata', 'settings-key-storage']) {
    assert.equal(details.split('id="' + id + '"').length - 1, 1, id);
  }
  assert.match(general, /id="settings-key-heading">Arcane API key<\/h3>/);
  assert.match(general, /id="settings-key-generate"[^>]*disabled>Generate API key/);
  assert.doesNotMatch(html, /id="key-writes"|id="key-roots"|name="key-root"/);
  for (const id of ['settings-key-secret', 'settings-key-show', 'settings-key-copy', 'settings-key-notice']) {
    assert.equal(general.split('id="' + id + '"').length - 1, 1, id);
    assert.doesNotMatch(details, new RegExp('id="' + id + '"'));
  }
  assert.match(general, /id="settings-key-show"[^>]*aria-pressed="false"[^>]*disabled/);
  assert.match(general, /id="settings-key-copy"[^>]*disabled/);
  assert.match(html, /id="codex-input-size" class="visually-hidden"/);
  assert.match(html, /id="codex-unknown"[^>]*hidden/);
  assert.match(html, /id="codex-approval-section"[^>]*hidden/);
});

// Production HTML/CSS and shell, in a fresh owned Edge profile. The unchanged
// chat/key controllers are loaded only to verify empty-picker and warning guards.
// No model catalogue, daemon, native bridge, provider or Studio is started.
test('Edge simplicity: optional key details, exact navigation, one draft, empty model chooser and visible warnings',
  { skip: !browserModule, timeout: 60000 }, async t => {
    const build = process.env.ARCANE_UI_BUILD_DIR;
    assert.ok(build, 'Use private output for the shell; never root dist.');
    const playwright = await import(pathToFileURL(resolve(browserModule!)).href) as typeof import('playwright-core');
    const root = await mkdtemp(join(process.env.ARCANE_UI_FIXTURE_DIR ?? tmpdir(), 'frontend-simplicity-edge-'));
    const context = await playwright.chromium.launchPersistentContext(join(root, 'edge-profile'), {
      headless: true, viewport: { width: 1440, height: 900 }, args: ['--disable-gpu'],
      executablePath: process.env.ARCANE_UI_BROWSER_EXE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    });
    t.after(() => context.close());
    const page = await context.newPage(), unexpected: string[] = [], errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const files = new Map([
      ['/studio.css', ['apps/desktop/public/studio.css', 'text/css']],
      ['/workspace-shell.js', [join(build, 'apps/desktop/src/workspace-shell.js'), 'text/javascript']],
      ['/codex-chat.js', [join(build, 'apps/desktop/src/codex-chat.js'), 'text/javascript']],
      ['/studio-key-settings.js', [join(build, 'apps/desktop/src/studio-key-settings.js'), 'text/javascript']],
      ['/brand/arcane-ridges.png', ['apps/desktop/public/brand/arcane-ridges.png', 'image/png']],
    ]);
    const html = (await source('apps/desktop/public/studio.html')).replace('src="/studio.js"', 'src="/simplicity-fixture.js"');
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== 'http://simplicity.fixture' || request.method() !== 'GET') {
        unexpected.push(request.method() + ' ' + request.url()); await route.abort(); return;
      }
      if (url.pathname === '/studio') {
        await route.fulfill({ contentType: 'text/html', body: html }); return;
      }
      if (url.pathname === '/simplicity-fixture.js') {
        await route.fulfill({ contentType: 'text/javascript', body: `
          import { startWorkspaceShell } from '/workspace-shell.js';
          import { StudioKeySettings } from '/studio-key-settings.js';
          import { CodexChat, CodexChatApi } from '/codex-chat.js';
          const counters = { fetches: 0, submits: 0, transport: 0 };
          // Layout-only fixture: deliberately show the dormant conversation.
          // This is not signed-in evidence; native model controls remain disabled.
          document.getElementById('workspace-stage').classList.remove('provider-required');
          document.getElementById('provider-login-gate').hidden=true;
          window.fetch = async () => { counters.fetches++; throw new Error('No network in presentation fixture'); };
          document.addEventListener('submit', event => { counters.submits++; event.preventDefault(); }, true);
          const keys = new StudioKeySettings(document, 'http://127.0.0.1:1');
          let shell = startWorkspaceShell(document, () => keys.hide());
          const chat = new CodexChat(document, new CodexChatApi('', async () => {
            counters.transport++; throw new Error('No native transport in presentation fixture');
          }));
          window.simplicityFixture = { counters, startChat: () => chat.start(), stopChat: () => chat.stop(),
            rebind: () => { shell.cleanup(); shell = startWorkspaceShell(document, () => keys.hide()); } };
        ` }); return;
      }
      const file = files.get(url.pathname);
      if (!file) { unexpected.push(request.url()); await route.abort(); return; }
      await route.fulfill({ contentType: file[1]!, body: await readFile(resolve(file[0]!)) });
    });
    await page.goto('http://simplicity.fixture/studio');
    await page.waitForFunction(() => 'simplicityFixture' in window);
    const draft = 'Keep the unsent draft.\nKeep its spacing.  ';
    await page.locator('#codex-composer').fill(draft);
    const drawer = page.locator('#settings-drawer'), details = page.locator('#settings-key-details');
    const opener = page.locator('#app-sidebar [data-workspace-target="workspace-settings"]');
    const capture = async (name: string) => page.screenshot({ path: join(root, name + '.png') });
    const fits = async (id: string) => {
      const rect = await page.locator('#' + id).boundingBox(); assert.ok(rect, id);
      const viewport = page.viewportSize()!;
      assert.ok(rect.x >= -1 && rect.x + rect.width <= viewport.width + 1, id + ': ' + JSON.stringify(rect));
      assert.ok(rect.y >= -1 && rect.y + rect.height <= viewport.height + 1, id + ': ' + JSON.stringify(rect));
    };
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
      await page.setViewportSize(viewport);
      await capture('conversation-' + viewport.width);
      assert.equal(await page.locator('.composer-tool-context').isVisible(), false);
      await fits('codex-model-trigger'); await fits('codex-submit');
      await opener.click();
      assert.equal(await drawer.evaluate(node => node.matches(':modal')), true);
      assert.equal(await details.getAttribute('open'), null);
      assert.equal(await page.locator('#settings-key-select').isVisible(), false);
      assert.equal(await page.locator('#settings-key-show').isVisible(), true);
      assert.equal(await page.locator('#settings-key-show').isDisabled(), true);
      assert.equal(await page.locator('#settings-key-copy').isDisabled(), true);
      await fits('settings-key-show');
      await capture('general-' + viewport.width);
      assert.equal(await details.isVisible(), false);
      assert.equal(await page.locator('#settings-key-generate').isVisible(), true);
      assert.equal(await page.locator('#settings-key-generate').isDisabled(), true);
      await fits('settings-key-generate');
      assert.match((await page.locator('#settings-key-storage').textContent())!, /temporary|unavailable/i);
      assert.equal(await details.getAttribute('open'), null);
      await page.keyboard.press('Escape'); await drawer.waitFor({ state: 'hidden' });
      assert.equal(await opener.evaluate(node => node === document.activeElement), true);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('workspace:settingsrequest', { detail: { target: 'settings-key-generate' } })));
    assert.equal(await details.getAttribute('open'), null);
    assert.equal(await page.locator('#settings-key-select').isVisible(), false);
    assert.equal(await page.locator('#settings-advanced').isVisible(), false);
    assert.equal(await page.locator('#settings-key-generate').evaluate(node => node === document.activeElement), false, 'Disabled generation cannot gain focus or grant access.');
    await page.keyboard.press('Escape');
    await page.locator('#go-assets').click();
    assert.equal(await page.locator('.composer-tool-context').isVisible(), false, 'Chat needs no manual tool context badge.');
    assert.equal(await page.locator('#workspace-tool-label').textContent(), 'Blender');
    assert.equal(await drawer.isVisible(), false);
    assert.equal(await page.locator('#codex-composer').inputValue(), draft);
    assert.equal(await page.locator('#codex-compose').count(), 1);
    await page.evaluate(async () => {
      const f = (window as unknown as { simplicityFixture: { startChat(): Promise<void>; rebind(): void } }).simplicityFixture;
      f.rebind(); await f.startChat();
    });
    assert.equal(await page.locator('#codex-model-trigger').isDisabled(), true, 'No model actions before actual authenticated native metadata.');
    assert.equal(await page.locator('#codex-model-popover').isVisible(), false);
    assert.equal(await page.locator('#codex-model-options').locator('button').count(), 0);
    assert.equal(await page.locator('#codex-picker-apply').isDisabled(), true);
    assert.equal(await page.locator('#codex-composer').inputValue(), draft);
    await page.locator('#codex-composer').evaluate(node => {
      (node as HTMLTextAreaElement).value = 'é'.repeat(65537);
      node.dispatchEvent(new Event('input', { bubbles: true }));
    });
    assert.equal(await page.locator('#codex-input-size').isVisible(), true);
    assert.equal(await page.locator('#codex-input-size').getAttribute('class'), 'hint warning');
    assert.equal(await page.locator('#codex-submit').isDisabled(), true);
    await page.evaluate(() => { (window as unknown as { simplicityFixture: { stopChat(): void } }).simplicityFixture.stopChat(); });
    assert.deepEqual(await page.evaluate(() => (window as unknown as { simplicityFixture: { counters: object } }).simplicityFixture.counters),
      { fetches: 0, submits: 0, transport: 0 });
    assert.deepEqual(unexpected, []); assert.deepEqual(errors, []);
    t.diagnostic('Fresh private Edge ' + context.browser()!.version() + '; actual HTML/CSS; three viewports; no catalogue, API or native activity; screenshots=' + root);
  });
