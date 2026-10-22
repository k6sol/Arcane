/// <reference lib="dom" />
// C30 compact (docked panel, window 520px wide or less): static markup/CSS contract, the Studio line view, and the real
// WorkspaceShell in Edge: the header card, the Menu sheet (the sidebar itself), Escape and focus return, outside press,
// choices, resize, Ctrl K and overflow. No provider, native thread, Studio session or account is involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compactStudioView, COMPACT_PANEL_QUERY } from '../../apps/desktop/src/workspace-shell.js';

const html = await readFile('apps/desktop/public/studio.html', 'utf8');
const css = await readFile('apps/desktop/public/studio.css', 'utf8');
const start = css.indexOf('/* C30 compact */'), end = css.indexOf('/* end C30 compact */'), c22 = css.indexOf('/* ---- End C22 revamp ---- */');
const reset = css.lastIndexOf('@media(prefers-reduced-motion:reduce)');
const block = css.slice(start, end), clean = block.replace(/\/\*[\s\S]*?\*\//g, '');
const header = html.slice(html.indexOf('<div id="compact-header"'), html.indexOf('<header id="workspace-topbar"'));

test('the header card ships in the main column before the top bar, with the official mark, Menu and a hidden Expand', () => {
  assert.ok(html.indexOf('<div class="app-main">') < html.indexOf('<div id="compact-header"') && header.length > 0, 'card first in .app-main');
  // Tests elsewhere slice the top bar up to the first </header>: the card must not add one before it.
  assert.ok(html.indexOf('</header>') > html.indexOf('<header id="workspace-topbar"'));
  const logo = /<svg class="arcane-logo"[^>]*>[\s\S]*?<\/svg>/;
  assert.equal(header.match(logo)?.[0], html.match(logo)?.[0], 'the same official mark as the wordmark');
  assert.match(header, /<span id="compact-title" class="compact-title" aria-hidden="true">/);
  assert.match(header, /<button id="compact-studio-action" type="button" class="compact-studio-action" hidden>/);
  assert.match(header, /<span id="compact-studio-status" class="visually-hidden" role="status" aria-live="polite">/);
  assert.match(header, /<button id="compact-menu" type="button" class="compact-icon-button" aria-label="Menu" aria-expanded="false" aria-controls="app-sidebar">/);
  assert.match(header, /<button id="compact-expand" type="button" class="compact-icon-button" aria-label="Expand to full window" hidden>/);
  assert.match(html, /<div id="compact-scrim" class="compact-scrim" data-open="false" aria-hidden="true"><\/div>/);
  assert.doesNotMatch(header, /eyebrow|text-transform/);
});

test('the C30 compact block is owned, static, inside the C22 block and keeps the 12px floor', () => {
  assert.ok(start > 0 && end > start && c22 > end && reset > c22 && css.indexOf('/* ---- C22 revamp') < start);
  assert.doesNotMatch(clean, /transition|animation|@keyframes|will-change|text-transform:uppercase/);
  assert.equal((clean.match(/\{/g) ?? []).length, (clean.match(/\}/g) ?? []).length);
  for (const [, size] of clean.matchAll(/font-size:(\d+)px/g)) assert.ok(Number(size) >= 12, size);
  for (const [, size] of clean.matchAll(/font:\d+ (\d+)px/g)) assert.ok(Number(size) >= 12, size);
  assert.equal(COMPACT_PANEL_QUERY, '(max-width:520px)');
  assert.match(clean, /\.arcane-app :is\(\.compact-header,\.compact-scrim\)\{display:none\}/);
  assert.match(clean, /@media \(max-width:520px\)\{/);
  // Closed sheet: only its Settings gear is drawn (in the card); the sign-in page has no card; protected controls are never display:none.
  assert.match(clean, /:root body\.arcane-app #app-sidebar:not\(\[data-sheet=open\]\)>:not\(\.sidebar-status-card\),[^{]*\{display:none\}/);
  assert.match(clean, /:root:is\(\[data-provider-view=checking\],\[data-provider-view=setup\]\) body\.arcane-app:has\(\.workspace-stage\.provider-required\) #compact-header\{display:none\}/);
  for (const id of ['#sidebar-toggle', '#codex-submit', '#codex-model', '#workspace-search', '#codex-heading']) assert.doesNotMatch(clean, new RegExp(id + '[^{,]*\\{[^}]*display:none'), id);
  assert.match(clean, /@media \(max-width:520px\) and \(forced-colors:active\)\{/);
  assert.match(clean, /@media \(max-width:520px\) and \(prefers-reduced-transparency:reduce\)\{/);
});

test('Studio line: green and the place only from a paired card; Reconnect is actionable; anything else is neutral', () => {
  assert.deepEqual(compactStudioView('paired', 'Studio paired', 'Baseplate'), { state: 'paired', text: 'Studio paired \u00b7 Baseplate', actionable: false, label: 'Studio paired \u00b7 Baseplate' });
  assert.equal(compactStudioView('paired', 'Studio paired', null).text, 'Studio paired');
  assert.equal(compactStudioView('paired', '  Studio\n paired ', '  Forest   caves ').text, 'Studio paired \u00b7 Forest caves');
  const reconnect = compactStudioView('reconnect', 'Reconnect Studio', 'Baseplate');
  assert.deepEqual(reconnect, { state: 'reconnect', text: 'Reconnect Studio', actionable: true, label: 'Reconnect Studio. The plugin went offline' });
  assert.equal(compactStudioView('reconnect', 'Reconnecting\u2026').text, 'Reconnecting\u2026');
  assert.deepEqual(compactStudioView('none', 'Studio offline', 'Baseplate'), { state: 'none', text: 'Studio offline', actionable: true, label: 'Studio offline. Open Studio settings' });
  for (const kind of [null, undefined, '', 'setup', 'invalid', 'paired ']) {
    const view = compactStudioView(kind, '', 'Baseplate');
    assert.equal(view.state, 'unknown', String(kind)); assert.equal(view.text, 'Checking Studio\u2026'); assert.equal(view.actionable, false);
  }
  assert.equal(compactStudioView('paired', 'Studio paired', 'x'.repeat(300)).text.length, 'Studio paired \u00b7 '.length + 100);
});

const browserModule = process.env.ARCANE_UI_BROWSER_MODULE;
test('Edge: header card, Menu sheet, Escape and focus return, choices, outside press, resize, Ctrl K and no overflow', { skip: !browserModule, timeout: 60000 }, async t => {
  const build = process.env.ARCANE_UI_BUILD_DIR; assert.ok(build, 'Controller interactions require an explicit compiled output.');
  const page_ = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace('</body>', '<script type="module" src="/fixture.js"></script></body>');
  const fixture = `import {startWorkspaceShell} from '/workspace-shell.js';
    document.documentElement.dataset.providerView='workspace';document.getElementById('workspace-stage').classList.remove('provider-required');
    if (location.search.includes('host')) { window.expanded=0; window.arcaneDesktop=Object.freeze({panel:Object.freeze({version:1,expand:()=>{window.expanded++;return Promise.resolve(true);}})}); }
    document.getElementById('new-chat').disabled=false;
    window.chosen=[];
    const list=document.getElementById('conversation-library');
    for (const name of ['Caves and spawn pillar','Swap placeholder trees']) { const b=document.createElement('button'); b.type='button'; b.className='library-chat'; b.textContent=name; b.addEventListener('click',()=>window.chosen.push(name)); list.append(b); }
    const banner=document.createElement('div'); banner.id='studio-connection-banner'; const again=document.createElement('button'); again.type='button'; again.className='studio-connection-reconnect'; again.textContent='Reconnect Studio';
    window.reconnects=0; again.addEventListener('click',()=>window.reconnects++); banner.append(again); document.getElementById('codex-messages').before(banner);
    window.shell=startWorkspaceShell(document);`;
  const server = createServer((request, response) => { void (async () => {
    const path = (request.url ?? '').split('?')[0] ?? '', name = /^\/([a-z-]+)\.js$/.exec(path)?.[1];
    const body = path === '/studio' ? page_ : path === '/studio.css' ? css : path === '/fixture.js' ? fixture
      : name === 'workspace-shell' ? await readFile(join(build, 'apps/desktop/src', name + '.js'), 'utf8') : null;
    response.writeHead(body === null ? 404 : 200, { 'content-type': path === '/studio' ? 'text/html' : path === '/studio.css' ? 'text/css' : 'text/javascript' }); response.end(body ?? '');
  })(); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const { chromium } = await import(pathToFileURL(resolve(browserModule!)).href) as typeof import('playwright-core');
  const browser = await chromium.launch({ headless: true, args: ['--disable-gpu'], executablePath: process.env.ARCANE_UI_BROWSER_EXE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 420, height: 1000 }, reducedMotion: 'reduce', colorScheme: 'dark' }), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:' + address.port + '/studio'); await page.waitForFunction(() => !!(window as unknown as { shell?: unknown }).shell);
  const box = (selector: string) => page.locator(selector).evaluate(node => { const r = node.getBoundingClientRect(), cs = getComputedStyle(node); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), display: cs.display, visibility: cs.visibility }; });
  const sheet = () => page.evaluate(() => ({ open: document.getElementById('app-sidebar')?.getAttribute('data-sheet') ?? null, expanded: document.getElementById('compact-menu')?.getAttribute('aria-expanded'), focus: document.activeElement?.id || document.activeElement?.className }));
  const noOverflow = async (label: string) => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth), label);

  // Docked: the card is drawn, the sidebar is a closed sheet, the top bar is out of sight and the chat heading is visually hidden.
  assert.deepEqual(await box('#compact-header'), { x: 8, y: 8, w: 404, h: 56, display: 'flex', visibility: 'visible' });
  // Closed, the sheet draws only its Settings gear, in the card between the conversation menu and Menu.
  assert.deepEqual(await box('#app-sidebar').then(b => [b.x, b.y, b.w, b.h]), [332, 20, 32, 32]);
  assert.equal(await page.locator('#app-sidebar .sidebar-gear').isVisible(), true);
  for (const selector of ['#new-chat', '#sidebar-search', '#conversation-library', '.sidebar-links', '#sidebar-menu-toggle']) assert.equal(await page.locator(selector).isVisible(), false, selector);
  assert.deepEqual(await box('#codex-panel>.chat-head-actions').then(b => [b.x, b.y, b.h]), [260, 20, 32]);
  assert.ok((await box('#workspace-topbar')).h <= 1, 'top bar out of sight');
  assert.ok((await box('#codex-panel>summary.chat-heading')).h <= 1, 'chat heading kept for assistive tech only');
  assert.equal(await page.locator('#compact-expand').isVisible(), false, 'no Expand without a desktop host that can restore the window');
  await noOverflow('420 closed');

  // Title and Studio line mirror the chat heading and the sidebar card (filled by the live-session painter).
  await page.evaluate(() => {
    document.getElementById('codex-heading')!.textContent = 'Forest with caves and a spawn pillar that keeps going far past the card';
    const card = document.getElementById('sidebar-status-card')!; card.setAttribute('data-studio', 'paired'); card.setAttribute('data-place', 'Baseplate');
    document.getElementById('sidebar-studio-status')!.textContent = 'Studio paired';
  });
  await page.waitForFunction(() => document.getElementById('compact-header')?.getAttribute('data-studio') === 'paired');
  assert.equal(await page.locator('#compact-title').textContent(), 'Forest with caves and a spawn pillar that keeps going far past the card');
  assert.equal(await page.locator('#compact-title').evaluate(node => node.scrollWidth > node.clientWidth && getComputedStyle(node).textOverflow === 'ellipsis'), true, 'one line with an ellipsis');
  assert.equal(await page.locator('#compact-studio-text').textContent(), 'Studio paired \u00b7 Baseplate');
  assert.equal(await page.locator('#compact-studio-status').textContent(), 'Studio paired \u00b7 Baseplate');
  assert.equal(await page.locator('#compact-studio-action').isVisible(), false);
  assert.equal(await page.locator('#compact-studio-line .compact-studio-dot').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(63, 191, 127)');
  // The session drops: an actionable yellow Reconnect that uses the banner's own control.
  await page.evaluate(() => { const card = document.getElementById('sidebar-status-card')!; card.setAttribute('data-studio', 'reconnect'); card.removeAttribute('data-place'); document.getElementById('sidebar-studio-status')!.textContent = 'Reconnect Studio'; });
  await page.waitForFunction(() => document.getElementById('compact-header')?.getAttribute('data-studio') === 'reconnect');
  assert.equal(await page.locator('#compact-studio-line').isVisible(), false);
  assert.equal(await page.locator('#compact-studio-action').getAttribute('aria-label'), 'Reconnect Studio. The plugin went offline');
  assert.equal(await page.locator('#compact-studio-action .compact-studio-dot').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(242, 193, 78)');
  await page.locator('#compact-studio-action').click();
  assert.equal(await page.evaluate(() => (window as unknown as { reconnects: number }).reconnects), 1);
  // Neutral (no session yet): no green, yellow or red.
  await page.evaluate(() => { document.getElementById('sidebar-status-card')!.setAttribute('data-studio', 'unknown'); document.getElementById('sidebar-studio-status')!.textContent = 'Checking Studio\u2026'; });
  await page.waitForFunction(() => document.getElementById('compact-header')?.getAttribute('data-studio') === 'unknown');
  assert.equal(await page.locator('#compact-studio-line .compact-studio-dot').evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(244, 239, 239, 0.45)');

  // Menu opens the sidebar as a sheet under the card; focus moves to New chat; Escape closes it and returns focus to Menu.
  await page.locator('#compact-menu').click();
  assert.deepEqual(await sheet(), { open: 'open', expanded: 'true', focus: 'new-chat' });
  const opened = await box('#app-sidebar');
  assert.deepEqual([opened.x, opened.y, opened.w, opened.display, opened.visibility], [8, 68, 404, 'flex', 'visible']);
  assert.deepEqual(await page.locator('#app-sidebar .sidebar-foot-toggle .sidebar-status-text').evaluate(node => [node.getBoundingClientRect().width > 40, getComputedStyle(node).position]), [true, 'static']);
  assert.equal((await box('#compact-scrim')).display, 'block');
  for (const selector of ['#new-chat', '#sidebar-search', '#conversation-library', '.sidebar-links', '#sidebar-status-card']) assert.equal(await page.locator(selector).isVisible(), true, selector);
  assert.equal(await page.locator('#app-sidebar .wordmark').isVisible(), false);
  await noOverflow('420 open');
  await page.keyboard.press('Escape');
  assert.deepEqual(await sheet(), { open: null, expanded: 'false', focus: 'compact-menu' });
  // Keyboard: Enter on Menu opens it; Tab stays in the sheet; a chat choice runs its own action and closes the sheet.
  await page.keyboard.press('Enter'); assert.equal((await sheet()).open, 'open');
  await page.keyboard.press('Tab'); assert.equal((await sheet()).focus, 'sidebar-search');
  await page.locator('#app-sidebar .library-chat').nth(1).click();
  assert.deepEqual(await page.evaluate(() => (window as unknown as { chosen: string[] }).chosen), ['Swap placeholder trees']);
  assert.equal((await sheet()).open, null);
  await page.waitForFunction(() => document.activeElement?.id === 'compact-menu');
  // The footer menu inside the sheet: Escape closes only that menu first.
  await page.locator('#compact-menu').click(); await page.locator('#sidebar-menu-toggle').click();
  await page.keyboard.press('Escape');
  assert.deepEqual([(await sheet()).open, (await sheet()).focus], ['open', 'sidebar-menu-toggle']);
  await page.keyboard.press('Escape'); assert.equal((await sheet()).open, null);
  // An outside press closes it; so does growing the window past the docked width.
  await page.locator('#compact-menu').click(); await page.mouse.click(210, 980); assert.equal((await sheet()).open, null);
  await page.locator('#compact-menu').click(); assert.equal((await sheet()).open, 'open');
  await page.setViewportSize({ width: 900, height: 900 }); await page.waitForTimeout(100);
  assert.deepEqual([(await sheet()).open, (await sheet()).expanded], [null, 'false']);
  assert.equal((await box('#compact-header')).display, 'none');
  assert.deepEqual(await box('#app-sidebar').then(b => [b.display, b.visibility]), ['flex', 'visible']);
  assert.ok((await box('#workspace-topbar')).h >= 48, 'top bar back above 520px');
  // Ctrl K at the docked width: the search is focused and drawn as a card over the header.
  await page.setViewportSize({ width: 420, height: 1000 }); await page.waitForTimeout(100);
  // (Ctrl K is left to a text field that has focus, so it is pressed from Menu.)
  await page.locator('#compact-menu').focus(); await page.keyboard.press('Control+k');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'workspace-search');
  assert.deepEqual(await box('#workspace-topbar').then(b => [b.x, b.y, b.w, b.h]), [8, 8, 404, 56]);
  assert.equal(await page.locator('.workspace-search').isVisible(), true);
  await page.keyboard.press('Escape'); await page.locator('#codex-composer').focus();
  assert.ok((await box('#workspace-topbar')).h <= 1);
  // Settings stays one click away in the card.
  await page.locator('#app-sidebar .sidebar-gear').click();
  assert.equal(await page.locator('#settings-drawer').evaluate(node => node.matches(':modal')), true);
  await page.keyboard.press('Escape'); assert.equal(await page.locator('#settings-drawer').evaluate(node => node.matches(':modal')), false);
  // 360 and 520: the card fits, the sheet fits, nothing scrolls sideways.
  for (const [width, height] of [[360, 800], [520, 900]] as const) {
    await page.setViewportSize({ width, height }); await page.waitForTimeout(100);
    assert.deepEqual(await box('#compact-header').then(b => [b.x, b.w]), [8, width - 16], String(width));
    await noOverflow(width + ' closed');
    await page.locator('#compact-menu').click();
    assert.deepEqual(await box('#app-sidebar').then(b => [b.x, b.y, b.w]), [8, 68, width - 16], String(width));
    await noOverflow(width + ' open');
    await page.keyboard.press('Escape');
  }
  // With a desktop host that can restore the window, Expand shows and asks it.
  const hosted = await browser.newPage({ viewport: { width: 420, height: 900 }, reducedMotion: 'reduce', colorScheme: 'dark' });
  hosted.on('pageerror', error => errors.push(error.message));
  await hosted.goto('http://127.0.0.1:' + address.port + '/studio?host'); await hosted.waitForFunction(() => !!(window as unknown as { shell?: unknown }).shell);
  assert.equal(await hosted.locator('#compact-expand').isVisible(), true);
  assert.deepEqual(await hosted.locator('#app-sidebar').evaluate(node => Math.round(node.getBoundingClientRect().x)), 292, 'the gear moves one slot left of Menu');
  await hosted.locator('#compact-expand').click();
  assert.equal(await hosted.evaluate(() => (window as unknown as { expanded: number }).expanded), 1);
  assert.deepEqual(errors, []);
});
