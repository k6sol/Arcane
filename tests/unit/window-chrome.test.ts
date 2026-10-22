/// <reference lib="dom" />
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import type { Page } from 'playwright-core';

const main = readFileSync('apps/desktop/electron/main.cjs', 'utf8').replaceAll('\r\n', '\n');
const css = readFileSync('apps/desktop/public/studio.css', 'utf8');

/** The exact options object makeWindow() passes to new BrowserWindow, evaluated with stand-ins for its free names. */
function mainWindowOptions(): Record<string, unknown> {
  const start = main.indexOf('function makeWindow()');
  assert.ok(start > 0, 'makeWindow exists');
  const call = main.indexOf('new BrowserWindow(', start);
  assert.ok(call > start, 'makeWindow creates the BrowserWindow');
  let depth = 0, end = -1;
  const open = main.indexOf('(', call);
  for (let i = open; i < main.length; i++) {
    const ch = main[i];
    if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) { end = i; break; }
  }
  assert.ok(end > open, 'balanced BrowserWindow call');
  const source = main.slice(open + 1, end);
  return vm.runInNewContext('(' + source + ')', { join: (...parts: string[]) => parts.join('/'), __dirname: 'C:/app', app: { isPackaged: true } }) as Record<string, unknown>;
}

test('main window: the system caption is hidden and the native window buttons draw over the Arcane top bar', () => {
  const options = mainWindowOptions();
  assert.equal(options.titleBarStyle, 'hidden', 'no classic caption');
  assert.notEqual(options.frame, false, 'not frameless: native resize, snap layouts and window buttons stay');
  const overlay = options.titleBarOverlay as { color: string; symbolColor: string; height: number };
  assert.ok(overlay && typeof overlay === 'object', 'a Windows title bar overlay');
  assert.match(overlay.color, /^#[0-9a-f]{6}$/i, 'an opaque Arcane dark');
  assert.equal(overlay.symbolColor.toLowerCase(), '#ffffff', 'white window symbols');
  assert.equal(overlay.height, 48, 'as tall as the top bar row');
  assert.equal(options.backgroundColor, '#0b0b0d', 'the window background is unchanged (no white flash)');
  assert.equal(options.show, false, 'shown only once ready');
  assert.equal(options.title, 'Arcane');
});

test('main window: the window buttons take the colour of the surface shown, from two fixed tones, for the trusted workspace only', () => {
  const start = main.indexOf("ipcMain.on('arcane:titlebar-tone'"), end = main.indexOf('\n      });', start);
  assert.ok(start > 0 && end > start, 'the tone handler exists');
  const handlers = new Map<string, (event: unknown, tone: unknown) => void>(), set: unknown[] = [];
  const context = { trusted: true, window: { isDestroyed: () => false, setTitleBarOverlay: (value: unknown) => set.push(value) },
    rendererEvent: () => context.trusted, ipcMain: { on: (channel: string, handler: (event: unknown, tone: unknown) => void) => handlers.set(channel, handler) } };
  vm.runInNewContext(main.slice(start, end + '\n      });'.length), context);
  const tone = handlers.get('arcane:titlebar-tone')!;
  tone({}, 'page'); tone({}, 'workspace');
  assert.deepEqual(JSON.parse(JSON.stringify(set)), [{ color: '#0b0a0b', symbolColor: '#ffffff', height: 48 }, { color: mainWindowOptions().titleBarOverlay && (mainWindowOptions().titleBarOverlay as { color: string }).color, symbolColor: '#ffffff', height: 48 }],
    'the sign-in page tone, then the workspace tone the window opens with');
  for (const bad of ['#ff0000', 'red', null, { color: '#fff' }]) tone({}, bad);
  context.trusted = false; tone({}, 'page');
  assert.equal(set.length, 2, 'no other value and no untrusted sender changes the buttons');
  const preload = readFileSync('apps/desktop/electron/preload.cjs', 'utf8');
  assert.match(preload, /const windowChrome = Object\.freeze\(\{ version: 1,\n  tone: \(\.\.\.args\) => \{\n    if \(args\.length !== 1 \|\| \(args\[0\] !== 'workspace' && args\[0\] !== 'page'\)\) throw/);
  const boot = readFileSync('apps/desktop/src/studio.ts', 'utf8');
  assert.match(boot, /getAttribute\('data-provider-view'\) === 'workspace' \? 'workspace' : 'page'/, 'every view but the workspace (sign-in, checking) takes the page tone');
});

const chrome = (() => {
  const open = css.indexOf('/* C31 window chrome */'), close = css.indexOf('/* end C31 window chrome */');
  assert.ok(open > 0 && close > open, 'one window chrome block');
  assert.equal(css.indexOf('/* C31 window chrome */', open + 1), -1, 'only one');
  // After the C22 block (which allows no container queries), before the final reduced-motion reset.
  assert.ok(open > css.indexOf('/* ---- End C22 revamp ---- */') && close < css.lastIndexOf('@media(prefers-reduced-motion:reduce)'), 'after the C22 block');
  return css.slice(open, close).replace(/\/\*[\s\S]*?\*\//g, '');
})();

test('studio.css: the top bar is the drag region and every control in it opts out', () => {
  assert.doesNotMatch(chrome, /@keyframes|animation|transition|will-change/, 'static');
  assert.equal((chrome.match(/\{/g) ?? []).length, (chrome.match(/\}/g) ?? []).length, 'balanced braces');
  assert.match(chrome, /\.arcane-app \.workspace-topbar\{-webkit-app-region:drag;app-region:drag\}/);
  const noDrag = chrome.match(/([^{}]+)\{-webkit-app-region:no-drag;app-region:no-drag\}/g)?.join('\n') ?? '';
  for (const control of ['button', 'input', 'summary', '[role=button]', '[contenteditable]', '.workspace-topbar>:not([hidden])', '.settings-drawer', '.workspace-search-results', '.studio-diagnostics-panel', '.chat-head-menu'])
    assert.ok(noDrag.includes(control), control + ' is never a drag handle');
  // The band for pages without the top bar is as tall as the overlay and 0 without one.
  assert.match(chrome, /--arcane-titlebar-h:env\(titlebar-area-height,0px\)/);
  assert.match(chrome, /body\.arcane-app::before\{[^}]*height:var\(--arcane-titlebar-h\)[^}]*-webkit-app-region:drag/);
  // The pills keep clear of the window buttons at every width.
  assert.match(chrome, /--arcane-titlebar-inset:max\(0px,calc\(100vw - env\(titlebar-area-x,0px\) - env\(titlebar-area-width,100vw\)\)\)/);
  assert.match(chrome, /\.workspace-topbar\{padding-right:max\(24px,calc\(var\(--arcane-titlebar-inset\) \+ 12px\)\)\}/);
  // The bar steps down by its own width, and the docked icon row (the top row at 521-760px) also drags and keeps clear.
  assert.match(chrome, /\.workspace-topbar\{container:arcane-topbar\/inline-size\}/);
  assert.match(chrome, /@container arcane-topbar \(max-width:520px\)\{/);
  assert.match(chrome, /#app-sidebar:not\(\.collapsed\)\{padding-right:max\(8px,calc\(var\(--arcane-titlebar-inset\) \+ 8px\)\);-webkit-app-region:drag/);
  // Settings: the frame cannot be scrolled by a tab's scroll-into-view, and every page starts at the same offset.
  assert.match(chrome, /\.arcane-app \.settings-drawer,\.arcane-app \.settings-drawer-body\{overflow:clip\}/);
  assert.match(chrome, /\.arcane-app \.settings-pages\{scroll-padding-block:var\(--s-3,24px\)\}/);
  assert.match(chrome, /\.arcane-app \.settings-drawer\{inset:var\(--arcane-titlebar-h\) 0 0 0;/);
});

test('studio.css: the search pill has one focus state and the field inside it none', () => {
  const open = css.indexOf('/* C30 topbar */'), close = css.indexOf('/* end C30 topbar */');
  const block = css.slice(open, close);
  assert.ok(block.includes('.arcane-app .workspace-topbar .workspace-search:focus-within{border-color:var(--tb-red);outline:none;box-shadow:var(--tb-hi),0 0 0 3px var(--tb-red-ring)}'));
  assert.ok(block.includes('.arcane-app .workspace-topbar .workspace-search input[type=search]:is(:focus,:focus-visible){outline:none;box-shadow:none}'));
  assert.ok(block.includes('.arcane-app .workspace-topbar .workspace-search:focus-within{border-color:Highlight;outline:2px solid Highlight;outline-offset:2px;box-shadow:none}'), 'forced colours keep a system ring');
});

// ---- Edge: the real studio.html, studio.css and compiled WorkspaceShell (no provider, daemon or Studio). ----
const browserModule = process.env.ARCANE_UI_BROWSER_MODULE;
const browserOptions = { skip: !browserModule, timeout: 120_000 };
const region = (node: Element) => { const style = getComputedStyle(node); return (style.getPropertyValue('-webkit-app-region') || style.getPropertyValue('app-region')).trim(); };

async function shellPage(t: TestContext, viewport: { width: number; height: number }, overlay = false): Promise<Page> {
  const build = process.env.ARCANE_UI_BUILD_DIR;
  assert.ok(build, 'Set ARCANE_UI_BUILD_DIR to the private compiled output.');
  const assets = 'apps/desktop/public';
  const playwright = await import(pathToFileURL(resolve(browserModule!)).href) as typeof import('playwright-core');
  const browser = await playwright.chromium.launch({ headless: true, args: ['--disable-gpu'],
    executablePath: process.env.ARCANE_UI_BROWSER_EXE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport, colorScheme: 'dark', reducedMotion: 'reduce', serviceWorkers: 'block' });
  const page = await context.newPage(), errors: string[] = [], unexpected: string[] = [];
  page.setDefaultTimeout(8_000);
  // The Window Controls Overlay cannot be switched on in a headless page: the two variables its env() values feed stand in.
  const simulated = overlay ? ':root{--arcane-titlebar-h:48px!important;--arcane-titlebar-inset:138px!important}' : '';
  const html = (await readFile(resolve(assets, 'studio.html'), 'utf8'))
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
    .replace('</head>', simulated ? '<link rel="stylesheet" href="/overlay.css"></head>' : '</head>')
    .replace('</body>', '<script type="module" src="/chrome-fixture.js"></script></body>');
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://chrome.fixture' || route.request().method() !== 'GET') { unexpected.push(route.request().url()); await route.abort(); return; }
    if (url.pathname === '/studio') { await route.fulfill({ contentType: 'text/html', body: html }); return; }
    if (url.pathname === '/overlay.css') { await route.fulfill({ contentType: 'text/css', body: simulated }); return; }
    if (url.pathname === '/chrome-fixture.js') {
      await route.fulfill({ contentType: 'text/javascript', body: `
        import {startWorkspaceShell} from '/workspace-shell.js';
        document.getElementById('workspace-stage').classList.remove('provider-required');
        document.getElementById('provider-login-gate').hidden = true;
        window.chromeFixture = startWorkspaceShell(document, () => {});
      ` }); return;
    }
    if (url.pathname === '/studio.css') { await route.fulfill({ contentType: 'text/css', body: await readFile(resolve(assets, 'studio.css')) }); return; }
    if (url.pathname === '/workspace-shell.js') { await route.fulfill({ contentType: 'text/javascript', body: await readFile(join(build, 'apps/desktop/src/workspace-shell.js')) }); return; }
    if (/^\/(fonts|brand)\/[\w.-]+$/.test(url.pathname)) {
      try { await route.fulfill({ body: await readFile(resolve(assets, url.pathname.slice(1))), contentType: url.pathname.endsWith('.woff2') ? 'font/woff2' : 'image/png' }); }
      catch { await route.fulfill({ status: 404, body: '' }); }
      return;
    }
    unexpected.push(url.pathname); await route.abort();
  });
  await page.addInitScript(() => { window.fetch = async () => { throw new Error('No backend in the window chrome fixture.'); }; });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://chrome.fixture/studio');
  await page.waitForFunction(() => !!(window as unknown as { chromeFixture?: unknown }).chromeFixture);
  t.after(() => { assert.deepEqual(errors, [], 'no page errors'); assert.deepEqual(unexpected, [], 'only fixture files'); });
  return page;
}
const openSettings = async (page: Page) => {
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('workspace:settingsrequest', { detail: { target: 'workspace-settings' } })));
  await page.waitForFunction(() => (document.getElementById('settings-drawer') as HTMLDialogElement).open);
};

test('Edge: clicking into search draws one focus state on the pill and none inside it', browserOptions, async t => {
  const page = await shellPage(t, { width: 1440, height: 900 });
  const read = () => page.evaluate(() => {
    const input = document.getElementById('workspace-search')!, pill = input.closest('.workspace-search')!;
    const i = getComputedStyle(input), p = getComputedStyle(pill);
    return { inputOutline: i.outlineStyle, inputShadow: i.boxShadow, pillOutline: p.outlineStyle, pillBorder: p.borderTopColor, pillShadow: p.boxShadow, focused: document.activeElement === input };
  });
  const rest = await read();
  await page.locator('#workspace-search').click();
  await page.keyboard.type('set');
  const clicked = await read();
  assert.equal(clicked.focused, true);
  assert.equal(clicked.inputOutline, 'none', 'no ring inside the pill');
  assert.equal(clicked.inputShadow, 'none');
  assert.equal(clicked.pillOutline, 'none', 'no second ring outside the pill');
  assert.notEqual(clicked.pillBorder, rest.pillBorder, 'the pill edge carries focus');
  assert.equal(clicked.pillBorder, 'rgb(229, 50, 63)', 'a solid red edge');
  assert.match(clicked.pillShadow, /0px 0px 0px 3px/, 'and a halo');
  // Keyboard focus (Ctrl K) looks the same.
  await page.locator('#workspace-search').evaluate(node => (node as HTMLInputElement).blur());
  await page.keyboard.press('Control+k');
  assert.deepEqual(await read(), clicked);
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 1100, height: 720 }, { width: 700, height: 900 }, { width: 420, height: 900 }])
  test('Edge: settings keeps one frame, header and tab strip across every tab at ' + viewport.width + 'px', browserOptions, async t => {
    const page = await shellPage(t, viewport);
    await openSettings(page);
    const frame = () => page.evaluate(() => {
      const box = (node: Element | null) => { const r = node!.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(v => Math.round(v * 2) / 2); };
      const drawer = document.getElementById('settings-drawer')!;
      return { drawer: box(drawer), header: box(drawer.querySelector('.settings-drawer-header')), title: box(drawer.querySelector('#settings-drawer-heading')),
        close: box(drawer.querySelector('[data-settings-close]')), body: box(drawer.querySelector('.settings-drawer-body')), pages: box(drawer.querySelector('.settings-pages')),
        // A narrow tab strip scrolls to show the chosen tab; the tabs themselves keep their place and size within it.
        tabs: [...drawer.querySelectorAll('.settings-nav button')].map(node => { const [x, y, w, h] = box(node); return [x! + drawer.querySelector('.settings-nav')!.scrollLeft, y, w, h]; }), heading: box(drawer.querySelector('[data-settings-section]:not([hidden]) .settings-page-heading')),
        scrolled: [drawer, drawer.querySelector('.settings-drawer-body')!].map(node => node.scrollTop + node.scrollLeft), page: scrollY + scrollX };
    });
    const tabs = await page.locator('#settings-drawer .settings-nav button').all();
    assert.ok(tabs.length >= 5);
    const first = await frame();
    assert.deepEqual(first.scrolled, [0, 0], 'the frame itself never scrolls');
    for (const tab of tabs) {
      await tab.click();
      assert.deepEqual(await frame(), first, 'no shift on ' + (await tab.textContent()));
    }
    // Back on General after scrolling another tab: the page starts at its top.
    await tabs[tabs.length - 1]!.click();
    await page.locator('#settings-drawer .settings-pages').evaluate(node => { node.scrollTop = 400; });
    await tabs[0]!.click();
    assert.equal(await page.locator('#settings-drawer .settings-pages').evaluate(node => node.scrollTop), 0);
    assert.deepEqual(await frame(), first);
  });

test('Edge: with the window buttons overlay the pills and the settings close button stay clear of it', browserOptions, async t => {
  for (const width of [1440, 1100, 900, 760]) {
    const page = await shellPage(t, { width, height: 820 }, true);
    const clash = () => page.evaluate(() => {
      const out: string[] = [];
      for (const node of document.querySelectorAll('button,input,summary,a,[role=button]')) {
        const r = node.getBoundingClientRect(), s = getComputedStyle(node);
        if (r.width < 2 || r.height < 2 || s.visibility === 'hidden') continue;
        if (r.right > innerWidth - 138 && r.top < 48 && r.bottom > 0) out.push((node.id || node.className.toString()) + '@' + Math.round(r.right));
      }
      return { out, overflow: document.documentElement.scrollWidth - innerWidth };
    });
    const bar = await clash();
    assert.deepEqual(bar.out, [], width + 'px: nothing under the window buttons');
    assert.ok(bar.overflow <= 0, width + 'px: no horizontal overflow');
    assert.equal(await page.locator('#workspace-topbar').evaluate(region), 'drag');
    for (const selector of ['#sidebar-toggle', '.workspace-search', '#workspace-search', '#studio-connection-pill'])
      assert.equal(await page.locator(selector).first().evaluate(region), 'no-drag', selector);
    await openSettings(page);
    assert.ok((await page.locator('#settings-drawer').boundingBox())!.y >= 48, width + 'px: settings opens below the title bar');
    await page.context().close();
  }
});
