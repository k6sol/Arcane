/// <reference lib="dom" />
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Page } from 'playwright-core';
import type { WorkspaceShell } from '../../apps/desktop/src/workspace-shell.js';

const browserModule = process.env.ARCANE_UI_BROWSER_MODULE;
const draft = 'Preserve this draft.\nAnd its whitespace.  ';
type FixtureWindow = Window & { settingsFixture: {
  shell: WorkspaceShell; fetches: string[]; actions: string[]; submits: number; inputs: number;
  navigations: number; secret: string; restart: () => void; toolChanges: string[];
} };

// Serve the actual markup/styles and compiled production WorkspaceShell.
// No provider, native CLI, daemon, Studio or backend is started.
async function fixture(t: TestContext, viewport: { width: number; height: number }) {
  const build = process.env.ARCANE_UI_BUILD_DIR;
  const assets = process.env.ARCANE_UI_ASSET_DIR ?? 'apps/desktop/public';
  assert.ok(build, 'Set ARCANE_UI_BUILD_DIR to the private compiled output; never read root dist.');
  const playwright = await import(pathToFileURL(resolve(browserModule!)).href) as typeof import('playwright-core');
  const root = await mkdtemp(join(process.env.ARCANE_UI_FIXTURE_DIR ?? tmpdir(), 'workspace-settings-browser-'));
  const context = await playwright.chromium.launchPersistentContext(join(root, 'edge-profile'), {
    headless: true, viewport, args: ['--disable-gpu'],
    executablePath: process.env.ARCANE_UI_BROWSER_EXE ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  });
  const page = await context.newPage(), errors: string[] = [], unexpected: string[] = [];
  t.after(async () => {
    try {
      await page.screenshot({ path: join(root, 'settings-drawer.png') });
      t.diagnostic('Owned Edge ' + context.browser()!.version() + '; viewport ' + viewport.width + 'x' + viewport.height + '; fixture ' + root);
    } finally { await context.close(); }
  });
  const files = new Map([
    ['/studio.css', [join(assets, 'studio.css'), 'text/css']],
    ['/workspace-shell.js', [join(build, 'apps/desktop/src/workspace-shell.js'), 'text/javascript']],
    ['/brand/arcane-ridges.png', [join(assets, 'brand/arcane-ridges.png'), 'image/png']],
  ]);
  const html = (await readFile(resolve(assets, 'studio.html'), 'utf8'))
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
    .replace('</body>', '<script type="module" src="/settings-fixture.js"></script></body>');
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== 'http://settings.fixture' || request.method() !== 'GET') {
      unexpected.push(request.method() + ' ' + request.url()); await route.abort(); return;
    }
    if (url.pathname === '/studio') {
      await route.fulfill({ contentType: 'text/html', body: html }); return;
    }
    if (url.pathname === '/settings-fixture.js') {
      await route.fulfill({ contentType: 'text/javascript', body: `
        import {startWorkspaceShell} from '/workspace-shell.js';
        const f = window.settingsFixture;
        // Layout-only fixture: display the dormant workspace. This is not native
        // authentication evidence; the separate onboarding tests enforce its gate.
        document.getElementById('workspace-stage').classList.remove('provider-required');
        document.getElementById('provider-login-gate').hidden=true;
        const dismiss = () => { f.navigations++; f.secret = ''; };
        f.shell = startWorkspaceShell(document, dismiss);
        f.restart = () => { f.shell.cleanup(); f.shell = startWorkspaceShell(document, dismiss); };
      ` }); return;
    }
    const file = files.get(url.pathname);
    if (!file) { unexpected.push(request.url()); await route.abort(); return; }
    await route.fulfill({ contentType: file[1]!, body: await readFile(resolve(file[0]!)) });
  });
  await page.addInitScript(() => {
    const f = { shell: undefined, fetches: [] as string[], actions: [] as string[], submits: 0, inputs: 0,
      navigations: 0, secret: '', restart: undefined, toolChanges: [] as string[] };
    Object.assign(window, { settingsFixture: f });
    window.fetch = async (input: RequestInfo | URL) => {
      f.fetches.push(String(input)); throw new Error('Unexpected fetch in presentation-only Settings fixture.');
    };
    document.addEventListener('workspace:toolchange', event => { f.toolChanges.push((event as CustomEvent<{ tool: string }>).detail.tool); });
    document.addEventListener('submit', event => { f.submits++; event.preventDefault(); }, true);
    document.addEventListener('input', event => { if ((event.target as HTMLElement)?.id === 'codex-composer') f.inputs++; }, true);
    document.addEventListener('click', event => {
      const id = (event.target as Element)?.closest('button')?.id;
      if (id && ['codex-connect', 'codex-thread-start', 'codex-submit', 'codex-select', 'codex-refresh',
        'asset-create', 'command-submit', 'refresh', 'session-connect'].includes(id)) f.actions.push(id);
    }, true);
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://settings.fixture/studio');
  await page.waitForFunction(() => !!(window as unknown as FixtureWindow).settingsFixture.shell);
  await page.evaluate(value => { (document.getElementById('codex-composer') as HTMLTextAreaElement).value = value; }, draft);
  const drawer = page.locator('#settings-drawer');
  assert.equal(await drawer.count(), 1, 'The real HTML must contain the native settings dialog.');
  assert.equal(await drawer.evaluate(node => node.tagName), 'DIALOG');
  assert.equal(await drawer.getAttribute('open'), null);
  assert.equal(await drawer.isVisible(), false);
  assert.equal(await page.locator('#workspace-settings').isVisible(), false);
  assert.equal(await page.locator('#workspace-settings').getAttribute('open'), null);
  assert.equal(await page.locator('#shell-notice').evaluate(node => !!node.closest('#settings-drawer')), false);
  const untouched = async () => {
    assert.equal(await page.locator('#codex-composer').inputValue(), draft);
    assert.deepEqual(await page.evaluate(() => {
      const f = (window as unknown as FixtureWindow).settingsFixture;
      return { fetches: f.fetches, actions: f.actions, submits: f.submits, inputs: f.inputs };
    }), { fetches: [], actions: [], submits: 0, inputs: 0 });
    assert.deepEqual(unexpected, []); assert.deepEqual(errors, []);
  };
  return { page, drawer, untouched };
}

async function targetVisibleAndFocused(page: Page, id: string, section = id) {
  await page.waitForFunction(id => (document.getElementById('settings-drawer') as HTMLDialogElement)?.open &&
    document.activeElement?.id === id, id);
  assert.equal(await page.locator('#settings-drawer').evaluate(node => node.matches(':modal')), true);
  assert.deepEqual(await page.locator('#settings-drawer [data-settings-section]:visible').evaluateAll(nodes => nodes.map(node => node.id)), [section]);
  assert.equal(await page.locator('#' + id).evaluate(node => node.closest('[data-settings-section]')?.id), section);
  assert.equal(await page.locator('#' + id).evaluate(node => !node.closest('[data-settings-section]')?.hasAttribute('hidden')), true);
  assert.equal(await page.locator('#' + id).isVisible(), true);
  const rect = await page.locator('#' + id).boundingBox(); assert.ok(rect);
  const viewport = page.viewportSize()!;
  assert.ok(rect.x >= -1 && rect.x + rect.width <= viewport.width + 1, JSON.stringify(rect));
  assert.ok(rect.y >= -1 && rect.y < viewport.height, JSON.stringify(rect));
}

test('settings desktop: closed by default, General opens, close and Escape restore the opener',
  { skip: !browserModule, timeout: 60000 }, async t => {
    const { page, drawer, untouched } = await fixture(t, { width: 1440, height: 900 });
    const settings = page.locator('#app-sidebar [data-workspace-target="workspace-settings"]');
    await settings.focus(); await settings.press('Enter');
    await targetVisibleAndFocused(page, 'workspace-settings');
    assert.ok(await drawer.getAttribute('aria-label') || await drawer.getAttribute('aria-labelledby'), 'Dialog needs an accessible name.');
    await drawer.locator('[data-settings-close]').click();
    assert.equal(await drawer.isVisible(), false);
    assert.equal(await settings.evaluate(node => document.activeElement === node), true);
    await settings.press('Space'); await targetVisibleAndFocused(page, 'workspace-settings');
    await page.keyboard.press('Escape'); await drawer.waitFor({ state: 'hidden' });
    assert.equal(await settings.evaluate(node => document.activeElement === node), true);
    await untouched();
  });

test('settings mobile: exact connection navigation selects Advanced, exposes details and restores focus',
  { skip: !browserModule, timeout: 60000 }, async t => {
    const { page, drawer, untouched } = await fixture(t, { width: 390, height: 844 });
    const opener = page.locator('#app-sidebar [data-workspace-target="workspace-settings"]');
    assert.equal(await opener.count(), 1); assert.equal(await opener.isVisible(), true);
    await opener.click(); await targetVisibleAndFocused(page, 'workspace-settings');
    await page.locator('[data-settings-section-target="settings-advanced"]').click();
    await targetVisibleAndFocused(page,'settings-advanced');
    await page.locator('#settings-advanced summary').getByText('Conversation connection',{exact:true}).click();
    assert.equal(await page.locator('#native-conversation-settings').isVisible(),true);
    assert.equal(await page.locator('#native-conversation-settings').evaluate(node => {
      for (let parent = node.parentElement; parent; parent = parent.parentElement)
        if (parent.tagName === 'DETAILS' && !parent.hasAttribute('open')) return false;
      return true;
    }), true);
    await drawer.locator('[data-settings-close]').click();
    assert.equal(await drawer.isVisible(), false);
    assert.equal(await opener.evaluate(node => document.activeElement === node), true);
    await untouched();
  });

test('settings drawer short viewport: panels scroll inside the dialog and backdrop restores the opener',
  { skip: !browserModule, timeout: 60000 }, async t => {
    const { page, drawer, untouched } = await fixture(t, { width: 945, height: 400 });
    const opener = page.locator('#app-sidebar [data-workspace-target="workspace-settings"]');
    assert.equal(await opener.count(), 1); assert.equal(await opener.isVisible(), true);
    await opener.click(); await targetVisibleAndFocused(page,'workspace-settings');
    await page.locator('[data-settings-section-target="settings-advanced"]').click();
    await targetVisibleAndFocused(page,'settings-advanced');
    await page.locator('#settings-advanced summary').getByText('Conversation connection',{exact:true}).click();
    assert.equal(await page.locator('#native-conversation-settings').isVisible(),true);
    const layout = await drawer.evaluate(node => {
      const rect = node.getBoundingClientRect();
      const scrollables = [node, ...node.querySelectorAll('*')].filter(element => {
        const style = getComputedStyle(element);
        return /auto|scroll/.test(style.overflowY) && element.scrollHeight > element.clientHeight;
      });
      const scroll = scrollables[0];
      // Opening a low details section can already scroll to the bottom. Measure
      // actual range from the top rather than mistaking that for no scrolling.
      if(scroll)scroll.scrollTop=0;
      const before = scroll?.scrollTop ?? 0; if (scroll) scroll.scrollTop = before + 80;
      return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right,
        width: innerWidth, height: innerHeight, pageWidth: document.documentElement.scrollWidth,
        scrolls: !!scroll && scroll.scrollTop !== before };
    });
    assert.ok(layout.top >= -1 && layout.bottom <= layout.height + 1, JSON.stringify(layout));
    assert.ok(layout.pageWidth <= layout.width && layout.scrolls, JSON.stringify(layout));
    assert.ok(layout.left > 1 || layout.top > 1 || layout.right < layout.width - 1, 'Backdrop must offer a click target.');
    await page.mouse.click(layout.left > 1 ? layout.left / 2 : layout.right < layout.width - 1 ? (layout.right + layout.width) / 2 : layout.width / 2,
      layout.left > 1 || layout.right < layout.width - 1 ? layout.height / 2 : layout.top / 2);
    await drawer.waitFor({ state: 'hidden' });
    assert.equal(await opener.evaluate(node => document.activeElement === node), true);
    await untouched();
  });

test('visible sidebar tool contexts and exact settings section navigation preserve draft with zero backend actions',
  { skip: !browserModule, timeout: 60000 }, async t => {
    const { page, drawer, untouched } = await fixture(t, { width: 1440, height: 900 });
    const tools = page.getByRole('navigation', { name: 'Tools in this conversation', exact: true });
    assert.equal(await tools.count(), 1);
    assert.equal(await tools.getAttribute('aria-label'), 'Tools in this conversation');
    const contexts = tools.locator('[data-workspace-tool]');
    assert.deepEqual(await contexts.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-workspace-tool'))), ['blender', 'roblox']);
    assert.equal(await page.locator('#workspace-stage').getAttribute('data-workspace-tool'), 'all');
    for (const [tool, label] of [['blender', 'Blender'], ['roblox', 'Roblox Studio'], ['blender', 'Blender']] as const) {
      const actual = tools.locator('[data-workspace-tool="' + tool + '"]');
      assert.equal(await actual.count(), 1); assert.equal(await actual.isVisible(), true);
      await actual.click();
      assert.equal(await page.locator('#workspace-stage').getAttribute('data-workspace-tool'), tool);
      assert.equal(await page.evaluate(() => (window as unknown as FixtureWindow).settingsFixture.shell.activeTool), tool);
      assert.equal(await page.locator('#workspace-tool-label').textContent(), label);
      assert.deepEqual(await contexts.evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-pressed'))),
        tool === 'blender' ? ['true', 'false'] : ['false', 'true']);
      assert.equal(await drawer.isVisible(), false);
      await untouched();
    }
    assert.deepEqual(await page.evaluate(() => (window as unknown as FixtureWindow).settingsFixture.toolChanges), ['blender', 'roblox', 'blender']);
    assert.equal(await page.locator('#workspace-stage').getAttribute('data-workspace-tool'), 'blender');
    assert.equal(await drawer.isVisible(), false);
    await page.locator('#app-sidebar [data-workspace-target="workspace-settings"]').click();
    await targetVisibleAndFocused(page, 'workspace-settings');
    for (const id of ['settings-connections', 'settings-tools', 'settings-advanced', 'workspace-settings']) {
      await drawer.locator('[data-settings-section-target="' + id + '"]').click();
      await targetVisibleAndFocused(page, id);
      assert.equal(await drawer.locator('[data-settings-section]:visible').count(), 1);
    }
    for (const [id, section] of [['asset-heading', 'settings-tools'], ['session-heading', 'settings-connections'], ['diagnostics-heading', 'settings-advanced']] as const) {
      await page.evaluate(target => document.dispatchEvent(new CustomEvent('workspace:settingsrequest', {detail:{target}})), id);
      await targetVisibleAndFocused(page, id, section);
    }
    await page.locator('#settings-search').fill('Blender');
    assert.equal(await drawer.locator('[data-settings-section-target]:visible').count(), 1);
    assert.equal(await drawer.locator('[data-settings-section-target="settings-tools"]').isVisible(), true);
    assert.equal(await page.locator('#settings-tools').isVisible(), true);
    await page.locator('#settings-search').fill('no section matches this');
    assert.equal(await drawer.locator('[data-settings-section-target]:visible').count(), 0);
    assert.equal(await page.locator('#settings-search-empty').isVisible(), true);
    await page.locator('#settings-search').fill('');
    assert.equal(await drawer.locator('[data-settings-section-target]:visible').count(), 4);
    await page.keyboard.press('Escape'); await drawer.waitFor({ state: 'hidden' });
    await page.evaluate(() => { document.getElementById('shell-notice')!.textContent = 'Fixture notice'; });
    assert.equal(await page.locator('#shell-notice').isVisible(), true);
    assert.equal(await page.locator('#workspace-stage').getAttribute('data-workspace-tool'), 'blender');
    assert.deepEqual(await page.evaluate(() => (window as unknown as FixtureWindow).settingsFixture.toolChanges), ['blender', 'roblox', 'blender']);
    await untouched();
  });

test('settings queued close preserves the reopened production modal without navigation; genuine close dismisses secrets and restores its opener',
  { skip: !browserModule, timeout: 60000 }, async t => {
    const { page, drawer, untouched } = await fixture(t, { width: 1440, height: 900 });
    const settings = page.locator('#app-sidebar [data-workspace-target="workspace-settings"]');
    for (const restart of [true, false]) {
      await settings.click(); await targetVisibleAndFocused(page, 'workspace-settings');
      const queued = await page.evaluate(restart => new Promise<{
        before: { open: boolean; modal: boolean; focus: string | null; panes: number; visible: boolean; navigations: number; secret: string };
        after: { open: boolean; modal: boolean; focus: string | null; panes: number; visible: boolean; navigations: number; secret: string };
        trusted: boolean;
      }>(done => {
        const f = (window as unknown as FixtureWindow).settingsFixture;
        const dialog = document.getElementById('settings-drawer') as HTMLDialogElement;
        const snapshot = () => ({ open: dialog.open, modal: dialog.matches(':modal'), focus: document.activeElement?.id ?? null,
          panes: [...dialog.querySelectorAll<HTMLElement>('[data-settings-section]')].filter(section => !section.hidden).length,
          visible: !!document.getElementById('diagnostics-heading')!.getClientRects().length,
          navigations: f.navigations, secret: f.secret });
        // Close and reopen in the same task, before the browser can deliver close.
        // The first case uses the production cleanup/rebind lifecycle; the second
        // keeps the controller and uses the real dialog's external close path.
        if (restart) f.restart(); else dialog.close();
        document.getElementById('sidebar-toggle')!.focus();
        document.dispatchEvent(new CustomEvent('workspace:settingsrequest', { detail: { target: 'diagnostics-heading' } }));
        f.secret = 'fixture secret belonging to the current opening';
        const before = snapshot();
        // Register after the production listener. This observes its result for
        // the genuinely queued browser event, rather than synthesizing close.
        dialog.addEventListener('close', event => done({ before, after: snapshot(), trusted: event.isTrusted }), { once: true });
      }), restart);
      assert.equal(queued.trusted, true, 'The browser must deliver the earlier queued close.');
      assert.deepEqual(queued.before, { open: true, modal: true, focus: 'diagnostics-heading', panes: 1, visible: true,
        navigations: queued.before.navigations, secret: 'fixture secret belonging to the current opening' });
      assert.deepEqual(queued.after, queued.before, 'Stale close must not close, move focus, dismiss the current secret or invoke navigation.');
      assert.equal(await drawer.evaluate(node => node.matches(':modal')), true);
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'diagnostics-heading');
      const genuine = await page.evaluate(() => new Promise<{
        synchronousFocus: string | null; open: boolean; modal: boolean; focus: string | null;
        navigationsBefore: number; navigationsAfter: number; secret: string;
      }>(done => {
        const f = (window as unknown as FixtureWindow).settingsFixture;
        const dialog = document.getElementById('settings-drawer') as HTMLDialogElement;
        const navigationsBefore = f.navigations;
        let synchronousFocus: string | null = null;
        dialog.addEventListener('close', () => done({ synchronousFocus, open: dialog.open, modal: dialog.matches(':modal'),
          focus: document.activeElement?.id ?? null, navigationsBefore, navigationsAfter: f.navigations, secret: f.secret }), { once: true });
        dialog.close();
        // Native dialog.close() can restore focus itself. Move away while its
        // notification is queued so only the shell can restore the stored opener.
        document.getElementById('codex-composer')!.focus();
        synchronousFocus = document.activeElement?.id ?? null;
      }));
      assert.deepEqual(genuine, { synchronousFocus: 'codex-composer', open: false, modal: false, focus: 'sidebar-toggle',
        navigationsBefore: genuine.navigationsBefore, navigationsAfter: genuine.navigationsBefore + 1, secret: '' });
      assert.equal(await drawer.isVisible(), false);
      const afterCleanup = await page.evaluate(() => {
        document.getElementById('codex-composer')!.focus();
        // A further close notification cannot reuse an already consumed opener.
        document.getElementById('settings-drawer')!.dispatchEvent(new Event('close'));
        return document.activeElement?.id;
      });
      assert.equal(afterCleanup, 'codex-composer');
      t.diagnostic('Queued-close production-controller proof: ' + JSON.stringify({ restart, queued, genuine }));
      await untouched();
    }
  });
