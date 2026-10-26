/// <reference lib="dom" />
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Page } from 'playwright-core';
import type { StudioDiagnosticsDock } from '../../apps/desktop/src/studio-diagnostics.js';

// Synthetic loopback capability for this fixture server only.
const HUMAN = 'c'.repeat(64), browserModule = process.env.ARCANE_UI_BROWSER_MODULE;
const browserOptions = { skip: !browserModule, timeout: 60_000 };
declare global { interface Window { dockFixture: { ready: boolean; submits: number; inputs: number; token: string; dock: StudioDiagnosticsDock } } }

const at = (s: number) => new Date(Date.UTC(2026, 9, 17, 10, 0, s)).toISOString();
const report = () => ({ diagnostics: [{ sessionId: 'session-obby', placeName: 'Obby Prototype', placeId: 0, live: true, entries: [
  { id: 'd1', kind: 'error', message: "attempt to index nil with 'Humanoid'", source: 'ServerScriptService.SpawnHandler', line: 42, stack: "Script 'ServerScriptService.SpawnHandler', Line 42", count: 3, firstAt: at(1), lastAt: at(9) },
  { id: 'd2', kind: 'warning', message: 'Infinite yield possible on \'Workspace:WaitForChild("Door")\'', source: null, line: null, stack: null, count: 1, firstAt: at(2), lastAt: at(4) },
  { id: 'd3', kind: 'error', message: 'Coins is not a valid member of Folder "Workspace.Map"', source: 'Workspace.Map.CoinSpawner', line: 7, stack: null, count: 1, firstAt: at(3), lastAt: at(3) },
] }] });

/** Real studio.html markup and studio.css with only the dock module booted; synthetic HTTP, no daemon, chat or Studio. */
async function fixture(t: TestContext, initial: unknown = report()) {
  const build = resolve(process.env.ARCANE_UI_BUILD_DIR ?? 'dist');
  const html = (await readFile(resolve('apps/desktop/public/studio.html'), 'utf8'))
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
    // A signed-in workspace shows its topbar; the provider gate hides it before sign-in.
    .replace('class="workspace-stage provider-required"', 'class="workspace-stage"')
    .replace('</body>', '<script type="module" src="/dock-fixture.js"></script></body>');
  const bootstrap = `
    import { startStudioDiagnostics } from '/studio-diagnostics.js';
    const audit = { ready: false, submits: 0, inputs: 0, token: '${HUMAN}', dock: null };
    window.dockFixture = audit;
    document.getElementById('codex-compose').addEventListener('submit', event => { event.preventDefault(); audit.submits++; });
    document.getElementById('codex-composer').addEventListener('input', () => { audit.inputs++; });
    audit.dock = startStudioDiagnostics(document, { token: () => audit.token, intervalMs: 600000,
      formatTime: value => new Date(value).toISOString().slice(11, 19) });
    await audit.dock.refresh();
    audit.ready = true;
  `;
  const requests: { method: string; path: string; authorization: string | undefined; body: string }[] = [];
  const errors: string[] = [], unexpected: string[] = [];
  // `current` may be made malformed and `failure` makes the read route fail, to prove the dock never turns clear on either.
  let current: unknown = initial, failure: number | null = null;
  const files = new Map<string, [string, string]>([
    ['/studio.css', [resolve('apps/desktop/public/studio.css'), 'text/css']],
    ['/studio-diagnostics.js', [join(build, 'apps/desktop/src/studio-diagnostics.js'), 'text/javascript']],
    // Exact same-origin font inventory from public/fonts/manifest.json and studio.css; never a general file route.
    ['/fonts/ibm-plex-sans-latin-wght-normal.woff2', [resolve('apps/desktop/public/fonts/ibm-plex-sans-latin-wght-normal.woff2'), 'font/woff2']],
    ['/fonts/ibm-plex-sans-latin-ext-wght-normal.woff2', [resolve('apps/desktop/public/fonts/ibm-plex-sans-latin-ext-wght-normal.woff2'), 'font/woff2']],
    ['/fonts/archivo-latin-wght-normal.woff2', [resolve('apps/desktop/public/fonts/archivo-latin-wght-normal.woff2'), 'font/woff2']],
    ['/fonts/archivo-latin-ext-wght-normal.woff2', [resolve('apps/desktop/public/fonts/archivo-latin-ext-wght-normal.woff2'), 'font/woff2']],
    ['/fonts/ibm-plex-mono-latin-400-normal.woff2', [resolve('apps/desktop/public/fonts/ibm-plex-mono-latin-400-normal.woff2'), 'font/woff2']],
    ['/fonts/ibm-plex-mono-latin-ext-400-normal.woff2', [resolve('apps/desktop/public/fonts/ibm-plex-mono-latin-ext-400-normal.woff2'), 'font/woff2']],
    ['/fonts/ibm-plex-mono-latin-500-normal.woff2', [resolve('apps/desktop/public/fonts/ibm-plex-mono-latin-500-normal.woff2'), 'font/woff2']],
    ['/fonts/ibm-plex-mono-latin-ext-500-normal.woff2', [resolve('apps/desktop/public/fonts/ibm-plex-mono-latin-ext-500-normal.woff2'), 'font/woff2']],
  ]);
  const server = createServer((request, response) => { void (async () => {
    const path = new URL(request.url ?? '/', 'http://fixture').pathname;
    let body = ''; for await (const chunk of request) body += chunk;
    let content: string | Buffer, type = 'application/json';
    if (path === '/studio') { content = html; type = 'text/html'; }
    else if (path === '/dock-fixture.js') { content = bootstrap; type = 'text/javascript'; }
    else if (path.startsWith('/v1/')) {
      requests.push({ method: request.method ?? '', path, authorization: request.headers.authorization, body });
      if (path === '/v1/studio/diagnostics' && request.method === 'GET') {
        if (failure !== null) { response.writeHead(failure); response.end(); return; }
        content = JSON.stringify(current);
      }
      else if (path === '/v1/studio/diagnostics/clear' && request.method === 'POST') { current = { diagnostics: [] }; content = JSON.stringify({ cleared: 1 }); }
      else { unexpected.push(request.method + ' ' + path); response.writeHead(404); response.end(); return; }
    } else {
      const file = files.get(path);
      if (!file) { if (path !== '/favicon.ico') unexpected.push(path); response.writeHead(404); response.end(); return; }
      content = await readFile(file[0]); type = file[1];
    }
    response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" });
    response.end(content);
  })().catch(error => { errors.push(String(error)); response.writeHead(500); response.end(); }); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = 'http://127.0.0.1:' + address.port;
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
  const playwright = await import(pathToFileURL(resolve(browserModule!)).href) as typeof import('playwright-core');
  const browser = await playwright.chromium.launch({ headless: true, args: ['--disable-gpu'],
    executablePath: process.env.ARCANE_UI_BROWSER_EXE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  const page: Page = await context.newPage();
  page.setDefaultTimeout(8_000); page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', async route => {
    if (new URL(route.request().url()).origin !== origin) { unexpected.push(route.request().url()); await route.abort(); }
    else await route.continue();
  });
  await page.goto(origin + '/studio');
  await page.waitForFunction(() => window.dockFixture?.ready === true);
  t.after(() => { assert.deepEqual(errors, [], 'No page or fixture server errors'); assert.deepEqual(unexpected, [], 'Only the fixed diagnostics routes are used'); });
  t.diagnostic('Actual Edge ' + browser.version() + '; synthetic HTTP; build=' + build);
  return { page, requests, setReport: (value: unknown) => { current = value; }, failWith: (status: number | null) => { failure = status; } };
}

/** The studio-diagnostics--<tone> classes on the dock host, space-separated (exactly one is expected). */
const tones = (page: Page) => page.locator('#studio-diagnostics').evaluate(el => Array.from(el.classList).filter(name => name.startsWith('studio-diagnostics--')).join(' '));

async function shot(page: Page, name: string) {
  const directory = process.env.ARCANE_UI_SCREENSHOT;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.waitForTimeout(500); // Let inherited colour-scheme transitions settle before capturing.
  const badge = await page.locator('#studio-diagnostics').boundingBox(); assert.ok(badge);
  const panel = await page.locator('#studio-diagnostics-panel').boundingBox();
  const viewport = page.viewportSize()!;
  const left = Math.max(0, Math.min(badge.x, panel?.x ?? badge.x) - 320), top = 0;
  const right = Math.min(viewport.width, Math.max(badge.x + badge.width, (panel?.x ?? 0) + (panel?.width ?? 0)) + 16);
  const bottom = Math.min(viewport.height, Math.max(badge.y + badge.height, (panel?.y ?? 0) + (panel?.height ?? 0)) + 16);
  await page.screenshot({ path: join(directory, 'studio-diagnostics-' + name + '.png'), clip: { x: left, y: top, width: right - left, height: bottom - top } });
}

test('Studio output dock shows a counted badge and an expandable list in the real workspace topbar', browserOptions, async t => {
  const { page, requests } = await fixture(t);
  const dock = page.locator('#studio-diagnostics');
  await dock.waitFor({ state: 'visible' });
  assert.equal(await page.locator('#studio-diagnostics').evaluate(el => el.closest('#workspace-topbar') !== null), true);
  assert.equal(await page.locator('.studio-diagnostics-count').textContent(), '3');
  const toggle = page.locator('#studio-diagnostics-toggle');
  assert.equal(await toggle.getAttribute('aria-label'), 'Studio output: 2 errors, 1 warning');
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator('#studio-diagnostics-panel').isVisible(), false);
  assert.equal(await dock.getAttribute('data-severity'), 'error');
  // Severity classes come from this current read only (C22.1 hooks); exactly one is present.
  assert.equal(await dock.getAttribute('data-reader'), 'current');
  assert.equal(await tones(page), 'studio-diagnostics--errors');
  assert.equal(await page.locator('.studio-diagnostics-label').textContent(), 'Studio');
  assert.equal(await page.locator('#studio-diagnostics-toggle rect').count(), 1, 'preserve the current terminal glyph');
  assert.equal(await page.locator('.studio-diagnostics-label').isVisible(), false, 'preserve the current glyph-and-count presentation');
  await toggle.click();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  const rows = page.locator('.studio-diagnostic');
  assert.equal(await rows.count(), 3);
  assert.deepEqual(await rows.evaluateAll(list => list.map(row => (row as HTMLElement).dataset.id)), ['d1', 'd2', 'd3'], 'newest first');
  const first = rows.nth(0);
  assert.equal(await first.locator('.studio-diagnostic-kind').textContent(), 'Error');
  assert.equal(await first.locator('.studio-diagnostic-message').textContent(), "attempt to index nil with 'Humanoid'");
  assert.equal(await first.locator('.studio-diagnostic-meta').textContent(), 'ServerScriptService.SpawnHandler · line 42 · ×3 · 10:00:09');
  assert.equal(await first.locator('.studio-diagnostic-meta').getAttribute('title'), "Script 'ServerScriptService.SpawnHandler', Line 42");
  assert.equal(await rows.nth(1).locator('.studio-diagnostic-meta').textContent(), 'Studio output · 10:00:04');
  assert.equal(await first.locator('.studio-diagnostic-place').textContent(), 'Obby Prototype');
  // Text stays text: untrusted output is never parsed as markup.
  assert.equal(await page.locator('.studio-diagnostic-message img').count(), 0);
  // White text on the badge count and Fix button keeps AA contrast on the Arcane red.
  const contrast = await page.locator('.studio-diagnostic-fix').first().evaluate(el => {
    const rgb = (value: string) => value.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
    const lum = (value: string) => { const [r, g, b] = rgb(value); return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!; };
    const style = getComputedStyle(el), a = lum(style.color), b = lum(style.backgroundColor);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
  assert.ok(contrast >= 4.5, 'Fix button contrast ' + contrast);
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await shot(page, 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, 'no horizontal page scroll at phone width');
  const mobilePanel = await page.locator('#studio-diagnostics-panel').boundingBox(); assert.ok(mobilePanel);
  assert.ok(mobilePanel.x >= 15 && mobilePanel.x + mobilePanel.width <= 390 - 15, 'panel keeps its 16px gutters');
  await shot(page, 'mobile');
  await page.setViewportSize({ width: 1440, height: 900 });
  // Escape closes the list and returns focus to the badge.
  await page.locator('.studio-diagnostic-fix').first().focus();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#studio-diagnostics-panel').isVisible(), false);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'studio-diagnostics-toggle');
  assert.ok(requests.every(r => r.method === 'GET' && r.path === '/v1/studio/diagnostics' && r.authorization === 'Bearer ' + HUMAN));
});

test('Fix prefills the active composer with a precise request and never sends it; only a person can Clear, and Clear is not a clean read', browserOptions, async t => {
  const { page, requests } = await fixture(t);
  await page.locator('#studio-diagnostics-toggle').click();
  await page.locator('.studio-diagnostic').nth(0).locator('.studio-diagnostic-fix').click();
  const expected = "Fix this Studio error: attempt to index nil with 'Humanoid' in ServerScriptService.SpawnHandler line 42. Read the live script first with script_read.";
  assert.equal(await page.locator('#codex-composer').inputValue(), expected);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'codex-composer');
  assert.deepEqual(await page.evaluate(() => [window.dockFixture.submits, window.dockFixture.inputs]), [0, 1], 'input is announced to the chat; nothing is submitted');
  assert.equal(await page.locator('#studio-diagnostics-panel').isVisible(), false);
  // An existing draft is kept; the request is appended rather than replacing it.
  await page.locator('#codex-composer').fill('Also keep the door animation.');
  await page.locator('#studio-diagnostics-toggle').click();
  await page.locator('.studio-diagnostic').nth(1).locator('.studio-diagnostic-fix').click();
  assert.equal(await page.locator('#codex-composer').inputValue(), 'Also keep the door animation.\n\nFix this Studio warning: Infinite yield possible on \'Workspace:WaitForChild("Door")\'. Read the live script first with script_read.');
  // The public prefill event works for either chat surface without importing it.
  await page.locator('#codex-composer').fill('');
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('workspace:prefill', { detail: { text: 'Prefilled by event.' } })));
  assert.equal(await page.locator('#codex-composer').inputValue(), 'Prefilled by event.');
  assert.equal(await page.evaluate(() => window.dockFixture.submits), 0);
  assert.ok(requests.every(r => r.path.startsWith('/v1/studio/diagnostics')), 'no chat, provider or Studio command request is made');
  await page.locator('#studio-diagnostics-toggle').click();
  // A scripted click is not a person: nothing is cleared and nothing is sent.
  await page.evaluate(() => (document.querySelector('.studio-diagnostics-clear') as HTMLButtonElement).click());
  assert.equal(requests.some(r => r.path === '/v1/studio/diagnostics/clear'), false);
  assert.equal(await page.locator('.studio-diagnostic').count(), 3);
  await page.locator('.studio-diagnostics-clear').click();
  await page.waitForFunction(() => document.querySelectorAll('.studio-diagnostic').length === 0
    && document.querySelector('.studio-diagnostics-status')?.textContent !== 'Clearing Studio output.');
  const clear = requests.find(r => r.path === '/v1/studio/diagnostics/clear');
  assert.ok(clear); assert.equal(clear.method, 'POST'); assert.equal(clear.authorization, 'Bearer ' + HUMAN); assert.equal(clear.body, '{}');
  // Cleared is neutral, not a clean read: no clear class, no "No Studio errors" claim until the next read proves it.
  assert.equal(await page.locator('.studio-diagnostics-status').textContent(), 'Cleared.');
  assert.equal(await page.locator('#studio-diagnostics').getAttribute('data-reader'), 'neutral');
  assert.equal(await page.locator('#studio-diagnostics').getAttribute('data-severity'), 'unknown');
  assert.equal(await tones(page), 'studio-diagnostics--neutral');
  assert.equal(await page.locator('.studio-diagnostics-clear').isDisabled(), true);
  assert.equal(await page.locator('.studio-diagnostics-count').textContent(), '–', 'cleared never presents an all-clear count');
  // Active Studio keeps the pill in place when its list closes, as in the current workspace presentation.
  await page.locator('#studio-diagnostics-toggle').click();
  assert.equal(await page.locator('#studio-diagnostics').isVisible(), true);
  // The next proven read (the store is now empty) is what shows clean.
  await page.evaluate(() => window.dockFixture.dock.refresh());
  assert.equal(await page.locator('#studio-diagnostics').getAttribute('data-reader'), 'current');
  assert.equal(await page.locator('#studio-diagnostics').getAttribute('data-severity'), 'none');
  assert.equal(await tones(page), 'studio-diagnostics--clear');
  assert.equal(await page.locator('.studio-diagnostics-count').textContent(), '', 'a complete clean read shows a dot');
  assert.equal(await page.locator('#studio-diagnostics-toggle').getAttribute('aria-label'), 'Studio output: no errors or warnings');
  assert.equal(await page.locator('.studio-diagnostics-status').textContent(), 'No Studio errors or warnings.');
  assert.equal(requests.filter(r => r.method === 'POST').length, 1, 'only the one human click cleared');
  await page.evaluate(() => window.dockFixture.dock.stop());
});

test('A failed or malformed read keeps the last output, labelled stale, and never turns clear', browserOptions, async t => {
  const { page, requests, setReport, failWith } = await fixture(t);
  const dock = page.locator('#studio-diagnostics'), toggle = page.locator('#studio-diagnostics-toggle'), status = page.locator('.studio-diagnostics-status');
  const refresh = () => page.evaluate(() => window.dockFixture.dock.refresh());
  assert.equal(await tones(page), 'studio-diagnostics--errors');
  failWith(500); await refresh();
  assert.equal(await dock.getAttribute('data-reader'), 'stale');
  assert.equal(await dock.getAttribute('data-severity'), 'unknown');
  assert.equal(await tones(page), 'studio-diagnostics--neutral');
  assert.equal(await page.locator('.studio-diagnostics-count').textContent(), '3', 'the last output is kept');
  assert.equal(await page.locator('.studio-diagnostics-label').textContent(), 'Studio (stale)');
  assert.match(await toggle.getAttribute('aria-label') ?? '', /^Studio output is stale \(the read failed \(HTTP 500\)\)\. Last read at \d\d:\d\d:\d\d: 2 errors, 1 warning\.$/);
  await toggle.click();
  assert.equal(await page.locator('.studio-diagnostic').count(), 3);
  assert.match(await status.textContent() ?? '', /^Stale: the read failed \(HTTP 500\)\. Showing the output read at \d\d:\d\d:\d\d\.$/);
  await shot(page, 'stale');
  failWith(null); setReport({ sessions: [] }); await refresh();
  assert.equal(await dock.getAttribute('data-reader'), 'stale');
  assert.match(await status.textContent() ?? '', /^Stale: the reply was unreadable\./);
  assert.equal(await page.locator('.studio-diagnostic').count(), 3);
  // A clean read is the only way to clear; a failure right after it is stale, not clear.
  setReport({ diagnostics: [] }); await refresh();
  assert.equal(await dock.getAttribute('data-reader'), 'current');
  assert.equal(await dock.getAttribute('data-severity'), 'none');
  assert.equal(await tones(page), 'studio-diagnostics--clear');
  assert.equal(await status.textContent(), 'No Studio errors or warnings.');
  // HTTP 200 receipts that the item reader would clean up are never a clean read: every entry malformed, then truncated.
  setReport({ diagnostics: [{ entries: [{ id: 'bad', kind: 'error' }], sessionId: 'session-obby' }] }); await refresh();
  assert.equal(await dock.getAttribute('data-reader'), 'stale');
  assert.equal(await dock.getAttribute('data-severity'), 'unknown');
  assert.equal(await tones(page), 'studio-diagnostics--neutral');
  assert.match(await status.textContent() ?? '', /^Stale: the reply was unreadable\./);
  const flood = Array.from({ length: 101 }, (_, i) => ({ id: 'w' + i, kind: 'warning', message: 'Warning ' + i, source: null, line: null, stack: null, count: 1, firstAt: at(i % 50), lastAt: at(i % 50) }));
  setReport({ diagnostics: [{ sessionId: 'session-obby', placeName: 'Obby Prototype', placeId: 0, live: true, entries: flood }] }); await refresh();
  assert.equal(await dock.getAttribute('data-reader'), 'partial');
  assert.equal(await dock.getAttribute('data-severity'), 'warning');
  assert.equal(await tones(page), 'studio-diagnostics--warnings');
  assert.equal(await page.locator('.studio-diagnostics-count').textContent(), '100+');
  assert.match(await status.textContent() ?? '', /^Incomplete Studio output\. At least 100 warnings captured\./);
  assert.equal(await page.locator('.studio-diagnostic').count(), 100, 'fresh partial warnings replace the older clean list');
  assert.doesNotMatch(await toggle.getAttribute('aria-label') ?? '', /no errors/i);
  failWith(503); await refresh();
  assert.equal(await dock.getAttribute('data-reader'), 'stale');
  assert.equal(await dock.getAttribute('data-severity'), 'unknown');
  assert.equal(await tones(page), 'studio-diagnostics--neutral');
  assert.match(await status.textContent() ?? '', /HTTP 503/);
  assert.doesNotMatch(await toggle.getAttribute('aria-label') ?? '', /no errors/i);
  assert.ok(requests.every(r => r.method === 'GET' && r.path === '/v1/studio/diagnostics'), 'reads never clear anything');
  // Preserve the current-main recovery check: a new exact complete read restores the original errors presentation.
  setReport(report()); await refresh();
  assert.equal(await dock.getAttribute('data-reader'), 'current');
  assert.equal(await tones(page), 'studio-diagnostics--errors');
  assert.equal(await dock.getAttribute('data-severity'), 'error');
  assert.equal(await page.locator('.studio-diagnostic').count(), 3);
  assert.equal(await status.textContent(), '');
  await page.evaluate(() => window.dockFixture.dock.dispose());
});

test('Losing the local session drops the shown output and sends nothing until a bearer is back; the bearer is never rendered', browserOptions, async t => {
  const { page, requests } = await fixture(t);
  const dock = page.locator('#studio-diagnostics'), refresh = () => page.evaluate(() => window.dockFixture.dock.refresh());
  assert.equal(await tones(page), 'studio-diagnostics--errors');
  const sent = requests.length;
  await page.evaluate(() => { window.dockFixture.token = ''; });
  await refresh();
  assert.equal(requests.length, sent, 'no request without the bearer');
  assert.equal(await dock.getAttribute('data-reader'), 'failed');
  assert.equal(await dock.getAttribute('data-severity'), 'unknown');
  assert.equal(await tones(page), 'studio-diagnostics--neutral');
  assert.equal(await page.locator('.studio-diagnostic').count(), 0, 'output from the old session is not kept');
  // The same bearer back is a new epoch: only its own read shows output again.
  await page.evaluate(token => { window.dockFixture.token = token; }, HUMAN);
  await refresh();
  assert.equal(await dock.getAttribute('data-reader'), 'current');
  assert.equal(await tones(page), 'studio-diagnostics--errors');
  assert.equal(await page.evaluate(token => document.documentElement.outerHTML.includes(token), HUMAN), false, 'the bearer is never rendered');
  assert.ok(requests.every(r => r.authorization === 'Bearer ' + HUMAN));
  await page.evaluate(() => window.dockFixture.dock.dispose());
});

test('Valid partial output shows captured errors or warnings with bounded counts; an empty partial result is visibly unknown', browserOptions, async t => {
  const flood = (kind: 'error' | 'warning') => ({ diagnostics: [{ sessionId: 'partial-session', placeName: 'Partial output', live: true,
    entries: Array.from({ length: 101 }, (_, i) => ({ id: kind + i, kind, message: kind + ' captured ' + i, source: null, line: null,
      stack: null, count: 1, firstAt: at(i % 50), lastAt: at(i % 50) })) }] });
  const { page, requests, setReport } = await fixture(t, flood('error'));
  const dock = page.locator('#studio-diagnostics'), status = page.locator('.studio-diagnostics-status'), refresh = () => page.evaluate(() => window.dockFixture.dock.refresh());
  const assertPartial = async (severity: string, tone: string, count: string, rows: number) => {
    assert.equal(await dock.getAttribute('data-reader'), 'partial');
    assert.equal(await dock.getAttribute('data-severity'), severity);
    assert.equal(await tones(page), 'studio-diagnostics--' + tone);
    assert.equal(await page.locator('.studio-diagnostics-count').textContent(), count);
    assert.equal(await page.locator('.studio-diagnostic').count(), rows);
    assert.equal(await dock.isVisible(), true);
    assert.match(await status.textContent() ?? '', /^Incomplete Studio output\./);
    assert.doesNotMatch(await page.locator('#studio-diagnostics-toggle').getAttribute('aria-label') ?? '', /no errors/i);
    assert.notEqual(tone, 'clear');
  };
  await assertPartial('error', 'errors', '100+', 100);
  await page.locator('#studio-diagnostics-toggle').click();
  assert.match(await page.locator('.studio-diagnostic-message').first().textContent() ?? '', /^error captured /);
  // Fix on a captured error is still only a composer prefill; no provider or Studio request is made.
  const sent = requests.length;
  await page.locator('.studio-diagnostic-fix').first().click();
  assert.match(await page.locator('#codex-composer').inputValue(), /^Fix this Studio error: error captured /);
  assert.equal(await page.evaluate(() => window.dockFixture.submits), 0);
  assert.equal(requests.length, sent);
  setReport(flood('warning')); await refresh();
  await assertPartial('warning', 'warnings', '100+', 100);
  setReport({ diagnostics: Array.from({ length: 17 }, (_, i) => ({ sessionId: 'empty-' + i, entries: [] })) }); await refresh();
  await assertPartial('unknown', 'neutral', '–', 0);
  assert.match(await status.textContent() ?? '', /No entries captured; the total is unknown\./);
  assert.equal(await page.locator('.studio-diagnostics-clear').isDisabled(), false, 'human Clear remains available for partial output');
  setReport({ diagnostics: [{ sessionId: 'malformed', entries: [{ id: 'bad' }] }] }); await refresh();
  assert.equal(await dock.getAttribute('data-reader'), 'stale');
  assert.equal(await tones(page), 'studio-diagnostics--neutral');
  assert.match(await status.textContent() ?? '', /^Stale: the reply was unreadable\./);
  assert.match(await status.textContent() ?? '', /incomplete captured output/);
  assert.equal(await page.evaluate(token => document.documentElement.outerHTML.includes(token), HUMAN), false);
  assert.ok(requests.every(request => request.method === 'GET' && request.path === '/v1/studio/diagnostics'), 'no implicit clear, chat or provider request');
  await page.evaluate(() => window.dockFixture.dock.dispose());
});
