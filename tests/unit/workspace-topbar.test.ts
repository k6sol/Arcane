/// <reference lib="dom" />
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile as read } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Page } from 'playwright-core';
import { chatHeaderTitle, studioPillState, STUDIO_PILL_TEXT, type WorkspaceTopbar } from '../../apps/desktop/src/workspace-topbar.js';
import { codexRequestNotice } from '../../apps/desktop/src/codex-chat.js';
import { headerUsageText } from '../../apps/desktop/src/claude-chat.js';
import { studioDiagnosticsTone } from '../../apps/desktop/src/studio-diagnostics.js';

const html = readFileSync('apps/desktop/public/studio.html', 'utf8');
const css = readFileSync('apps/desktop/public/studio.css', 'utf8');
const UUID = '06c807a6-04cf-4b83-baaf-4f16b70d0fea';

test('the Studio pill is green only for a live session; everything else is neutral and names no key problem', () => {
  assert.equal(studioPillState(true), 'paired');
  assert.equal(studioPillState(false), 'none');
  assert.equal(studioPillState(null), 'unknown');
  assert.equal(studioPillState(undefined), 'unknown');
  assert.deepEqual(Object.values(STUDIO_PILL_TEXT), ['Studio connected', 'Studio not connected', 'Checking for Studio\u2026']);
  assert.doesNotMatch(Object.values(STUDIO_PILL_TEXT).join(' '), /key|invalid|plugin|reconnect/i);
});

test('the header names the current chat; with none open it says New chat', () => {
  assert.equal(chatHeaderTitle('  Forest with caves and a spawn pillar '), 'Forest with caves and a spawn pillar');
  assert.equal(chatHeaderTitle('Saved chats'), 'New chat');
  assert.equal(chatHeaderTitle(''), 'New chat');
  assert.equal(chatHeaderTitle(null), 'New chat');
  assert.equal(chatHeaderTitle('Chat\n 1'), 'Chat 1');
});

test('a rejected or unconfirmed request reads in plain words; its ID, action and state go only to Details', () => {
  const rejected = codexRequestNotice('history-load', 'rejected', UUID);
  assert.equal(rejected.text, 'Couldn\u2019t load this chat\u2019s saved history.');
  assert.equal(rejected.detail, 'Request ' + UUID + ' \u00b7 history-load \u00b7 rejected');
  const timedOut = codexRequestNotice('history-load', 'rejected', UUID, 'TIMEOUT');
  assert.match(timedOut.text, /^Couldn\u2019t load this chat\u2019s saved history\. Codex did not answer in time\./);
  assert.match(timedOut.detail, / \u00b7 TIMEOUT$/);
  for (const state of ['pending', 'unknown']) {
    const unsure = codexRequestNotice('turn-start', state, UUID, null, 'Unreadable native acknowledgement.');
    assert.match(unsure.text, /^Arcane couldn\u2019t confirm that this went through, so nothing was sent again\./);
    assert.match(unsure.detail, new RegExp('^Request ' + UUID + ' \u00b7 turn-start \u00b7 ' + state + ' \u00b7 Unreadable native acknowledgement\\.$'));
  }
  assert.equal(codexRequestNotice('something-new', 'rejected', UUID).text, 'That request didn\u2019t go through.');
  for (const action of ['connect', 'disconnect', 'select', 'thread-start', 'thread-resume', 'history-load', 'turn-start', 'turn-steer', 'turn-interrupt',
    'task-stop', 'task-focus', 'grant-writes', 'revoke-writes', 'grant-assets', 'revoke-assets', 'approval', 'unlisted'])
    for (const state of ['rejected', 'pending', 'unknown']) {
      const { text } = codexRequestNotice(action, state, UUID, 'REMOTE_REJECTED', 'raw ' + UUID);
      assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}-|acknowledgement|history-load|turn-start| \u00b7 /, action + ' ' + state + ': ' + text);
    }
});

test('the header usage summary is tokens and an estimated cost, or tokens alone when the cost is unknown or hidden', () => {
  const usage = { inputTokens: 8_000_000, outputTokens: 300_000, costUsd: 4.33, replies: 9, tableCostReplies: 0, uncostedReplies: 0 };
  const shown = { preferences: { show: true, currency: 'USD', rate: null }, locale: 'en-US' };
  assert.equal(headerUsageText(usage, shown), '8.3M tokens \u00b7 ~$4.33');
  assert.equal(headerUsageText({ ...usage, costUsd: null }, shown), '8.3M tokens');
  assert.equal(headerUsageText(usage, { ...shown, preferences: { ...shown.preferences, show: false } }), '8.3M tokens');
  assert.equal(headerUsageText({ ...usage, inputTokens: 1, outputTokens: 0 }, shown), '1 token \u00b7 ~$4.33');
});

test('the Studio output pill takes a severity colour only from a current read', () => {
  const error = { kind: 'error' as const }, warning = { kind: 'warning' as const };
  assert.equal(studioDiagnosticsTone('current', []), 'clear');
  assert.equal(studioDiagnosticsTone('current', [warning]), 'warnings');
  assert.equal(studioDiagnosticsTone('current', [warning, error]), 'errors');
  for (const read of ['none', 'stale', 'failed'] as const) for (const items of [[], [warning], [error]]) assert.equal(studioDiagnosticsTone(read, items), 'neutral');
});

test('studio.html: one top bar row in the canvas order, with the Studio pill and no Saved chats link', () => {
  const start = html.indexOf('<header id="workspace-topbar"'), end = html.indexOf('</header>', start), bar = html.slice(start, end);
  const order = ['id="sidebar-toggle"', 'id="workspace-chat-tabs"', 'id="claude-saved-chats"', 'id="workspace-new-chat"', 'id="workspace-search"',
    'id="arcane-balance-chip"', 'id="studio-connection-pill"', 'id="studio-diagnostics"'].map(id => bar.indexOf(id));
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1]!)), 'canvas order: ' + order.join(','));
  assert.match(bar, /<input id="workspace-search" type="search" maxlength="256" placeholder="Search" aria-label="Search tools and settings"/);
  assert.match(bar, /<kbd>Ctrl K<\/kbd>/);
  assert.match(bar, /id="studio-connection-pill" type="button" class="studio-connection-pill studio-connection-pill--neutral" data-workspace-target="session-heading"/);
  assert.doesNotMatch(bar, />Saved chats</, 'Saved chats lives in the chip menu, not as a link');
  // Header: title row with the usage summary; Preview and the more menu beside it; the notice keeps Review and Details.
  assert.match(html, /<span id="chat-usage-summary" class="chat-usage-summary" hidden><\/span><\/summary>\s*<div class="chat-head-actions"><button id="workspace-preview-toggle"/);
  assert.match(html, /<details id="chat-head-more" class="chat-head-more">[\s\S]*?<button id="claude-chat-terminal"[\s\S]*?data-workspace-target="native-conversation-settings"[\s\S]*?<\/details><\/div><div class="chat-topline">/);
  assert.match(html, /<p id="codex-notice" role="status" aria-live="polite">Sign in to start\.<\/p><div id="codex-notice-actions" class="notice-actions" hidden><button id="codex-notice-review" type="button" class="notice-action" data-workspace-target="codex-actions">Review<\/button><details id="codex-notice-details" class="notice-details"><summary>Details<\/summary>/);
});

test('studio.css: the owned top bar block sits inside the C22 block, static and canvas-sized', () => {
  const open = css.indexOf('/* C30 topbar */'), close = css.indexOf('/* end C30 topbar */'), revampEnd = css.indexOf('/* ---- End C22 revamp ---- */');
  assert.ok(open > 0 && close > open && revampEnd > close, 'before the end of the C22 block');
  assert.equal(css.indexOf('/* C30 topbar */', open + 1), -1, 'one block');
  const block = css.slice(open, close), clean = block.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(clean, /@keyframes|animation|transition|will-change/);
  assert.equal((clean.match(/\{/g) ?? []).length, (clean.match(/\}/g) ?? []).length, 'balanced braces');
  for (const rule of [
    '.arcane-app .workspace-topbar{min-height:48px;padding:12px 24px 0 12px;gap:8px;',
    '.arcane-app .workspace-topbar #sidebar-toggle{flex:none;width:36px;min-width:36px;height:36px;',
    '.arcane-app .workspace-topbar #workspace-new-chat{flex:none;width:28px;min-width:28px;height:28px;',
    'height:36px;min-height:36px;padding:0 8px 0 12px;border:1px solid transparent;border-radius:10px;',
    '.arcane-app .workspace-topbar .workspace-search{position:relative;flex:1 1 200px;width:auto;min-width:0;max-width:400px;height:36px;min-height:36px;margin:0 auto;',
    '.arcane-app .workspace-topbar .arcane-balance-chip{display:flex;align-items:center;flex:none;gap:7px;height:36px;',
    '.arcane-app .workspace-topbar .studio-connection-pill{display:flex;align-items:center;flex:none;gap:8px;height:36px;',
    '.arcane-app .workspace-topbar .studio-diagnostics-badge{display:flex;align-items:center;gap:8px;height:36px;min-height:36px;padding:0 8px 0 10px;',
    '.arcane-app .workspace-topbar .studio-diagnostics-label{display:none}',
    '.arcane-app .chat-heading #codex-heading{',
    '.arcane-app .chat-heading .chat-usage-summary{flex:none;',
  ]) assert.ok(block.includes(rule), rule);
  // Green comes from the classes a current read sets, never from data-severity alone.
  assert.doesNotMatch(clean, /data-severity=(none|warning|error)/);
});

// ---- Edge: the real studio.html and studio.css with only the top bar module booted (synthetic workbench, no daemon). ----
const browserModule = process.env.ARCANE_UI_BROWSER_MODULE;
const browserOptions = { skip: !browserModule, timeout: 60_000 };
declare global { interface Window { topbarFixture: { ready: boolean; live: boolean | null; notify(): void; bar: WorkspaceTopbar } } }

async function fixture(t: TestContext, width = 1440) {
  const build = resolve(process.env.ARCANE_UI_BUILD_DIR ?? 'dist');
  const page = (await read(resolve('apps/desktop/public/studio.html'), 'utf8'))
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
    .replace('class="workspace-stage provider-required"', 'class="workspace-stage"')
    .replace('</body>', '<script type="module" src="/topbar-fixture.js"></script></body>');
  const bootstrap = `
    import { startWorkspaceTopbar } from '/workspace-topbar.js';
    import { chatSwitchSummary, chatSwitchOpenSection } from '/chat-tabs.js';
    const listeners = new Set();
    const audit = { ready: false, live: null, notify() { for (const listener of [...listeners]) listener(); }, bar: null };
    window.topbarFixture = audit;
    document.getElementById('provider-login-gate').hidden = true;
    // The Claude chip as claude-chat.ts renders it: the current chat, the open chats, New chat and one saved chat.
    const chip = document.getElementById('claude-saved-chats');
    chip.hidden = false;
    const saved = document.createElement('button'); saved.type = 'button'; saved.textContent = 'Lighting pass'; saved.dataset.conversationId = 'conv-light';
    chip.replaceChildren(chatSwitchSummary(document, 'Forest with caves and a spawn pillar', 'claude'),
      chatSwitchOpenSection(document, chip, [{ key: 'a', label: 'Forest with caves and a spawn pillar', current: true, selectDisabled: false, closeDisabled: false },
        { key: 'b', label: 'Swap placeholder trees', current: false, selectDisabled: false, closeDisabled: false }],
        { select() {}, close() {}, newChat() {}, newDisabled: false }), saved);
    document.getElementById('workspace-chat-tabs').hidden = true;
    const balance = document.getElementById('arcane-balance-chip'); balance.hidden = false;
    document.getElementById('arcane-balance-chip-value').textContent = '312';
    audit.bar = startWorkspaceTopbar(document, { noticeRestMs: 300, workbench: { studioConnected: () => audit.live, subscribeStudioChange: listener => { listeners.add(listener); return () => listeners.delete(listener); } } });
    audit.ready = true;
  `;
  const errors: string[] = [], unexpected: string[] = [];
  const files = new Map<string, [string, string]>([
    ['/studio.css', [resolve('apps/desktop/public/studio.css'), 'text/css']],
    ['/workspace-topbar.js', [join(build, 'apps/desktop/src/workspace-topbar.js'), 'text/javascript']],
    ['/chat-tabs.js', [join(build, 'apps/desktop/src/chat-tabs.js'), 'text/javascript']],
  ]);
  const server = createServer((request, response) => { void (async () => {
    const path = new URL(request.url ?? '/', 'http://fixture').pathname;
    let content: string | Buffer, type = 'text/html';
    if (path === '/studio') content = page;
    else if (path === '/topbar-fixture.js') { content = bootstrap; type = 'text/javascript'; }
    else {
      const file = files.get(path) ?? (path.startsWith('/packages/') && path.endsWith('.js') ? [join(build, path.slice(1)), 'text/javascript'] as [string, string]
        : /^\/[a-z0-9-]+\.js$/.test(path) ? [join(build, 'apps/desktop/src', path.slice(1)), 'text/javascript'] as [string, string] : undefined);
      if (!file) { if (path !== '/favicon.ico' && !path.startsWith('/fonts/')) unexpected.push(path); response.writeHead(404); response.end(); return; }
      try { content = await read(file[0]); type = file[1]; } catch { response.writeHead(404); response.end(); return; }
    }
    response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
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
  const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block', colorScheme: 'dark', reducedMotion: 'reduce' });
  const tab: Page = await context.newPage();
  tab.setDefaultTimeout(8_000); tab.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', async route => {
    if (new URL(route.request().url()).origin !== origin) { unexpected.push(route.request().url()); await route.abort(); }
    else await route.continue();
  });
  await tab.goto(origin + '/studio');
  await tab.waitForFunction(() => window.topbarFixture?.ready === true);
  t.after(() => { assert.deepEqual(errors, [], 'no page or fixture errors'); assert.deepEqual(unexpected, [], 'only fixture files'); });
  return tab;
}

test('Edge: the top bar draws one 36px row in the canvas order and the header names the chat', browserOptions, async t => {
  const page = await fixture(t);
  const boxes = await page.evaluate(() => Object.fromEntries(['sidebar-toggle', 'claude-saved-chats', 'workspace-new-chat', 'workspace-search', 'arcane-balance-chip', 'studio-connection-pill', 'studio-diagnostics', 'codex-heading']
    .map(id => { const node = id === 'workspace-search' ? document.querySelector('.workspace-search')! : id === 'claude-saved-chats' ? document.querySelector('#claude-saved-chats > summary')! : document.getElementById(id)!;
      const r = node.getBoundingClientRect(); return [id, { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), shown: r.width > 0 }]; })));
  for (const id of ['sidebar-toggle', 'claude-saved-chats', 'workspace-search', 'arcane-balance-chip', 'studio-connection-pill']) {
    assert.equal(boxes[id]!.h, 36, id + ' is 36px tall'); assert.equal(boxes[id]!.y, 12, id + ' sits 12px from the top');
  }
  assert.equal(boxes['workspace-new-chat']!.h, 28);
  const xs = ['sidebar-toggle', 'claude-saved-chats', 'workspace-new-chat', 'workspace-search', 'arcane-balance-chip', 'studio-connection-pill'].map(id => boxes[id]!.x);
  assert.deepEqual([...xs].sort((a, b) => a - b), xs, 'left to right in the canvas order');
  assert.equal(boxes['workspace-search']!.w, 400, 'search is 400px wide at 1440');
  assert.equal(await page.locator('#workspace-chat-tabs').isVisible(), false);
  assert.equal(await page.locator('#claude-saved-chats .chat-switch-label').evaluate(node => getComputedStyle(node).width), '1px', '"Saved chats" is not drawn');
  assert.equal(await page.locator('#codex-heading').textContent(), 'Forest with caves and a spawn pillar');
  // Studio pill: neutral until the current session says paired, and back to neutral when it drops.
  const pill = page.locator('#studio-connection-pill');
  assert.equal(await pill.getAttribute('data-studio'), 'unknown');
  assert.equal(await pill.getAttribute('aria-label'), 'Checking for Studio\u2026. Open Studio settings.');
  await page.evaluate(() => { window.topbarFixture.live = true; window.topbarFixture.notify(); });
  assert.match(await pill.getAttribute('class') ?? '', /studio-connection-pill--paired/);
  assert.equal(await pill.locator('.studio-connection-dot').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(63, 191, 127)');
  await page.evaluate(() => { window.topbarFixture.live = false; window.topbarFixture.notify(); });
  assert.match(await pill.getAttribute('class') ?? '', /studio-connection-pill--neutral/);
  assert.equal(await pill.getAttribute('aria-label'), 'Studio not connected. Open Studio settings.');
  assert.equal(await pill.locator('.studio-connection-dot').evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)');
});

test('Edge: the chip opens its switcher under itself and closes on an outside press; the title follows the chip', browserOptions, async t => {
  const page = await fixture(t);
  const summary = page.locator('#claude-saved-chats > summary');
  const before = await summary.boundingBox(); assert.ok(before);
  await summary.click();
  const after = await summary.boundingBox(); assert.ok(after);
  assert.deepEqual([after.x, after.y], [before.x, before.y], 'the chip stays put while its menu is open');
  const row = await page.locator('#claude-saved-chats .chat-switch-select').first().boundingBox(); assert.ok(row);
  assert.ok(row.y >= before.y + before.height, 'the menu opens under the chip');
  assert.equal(await page.locator('#claude-saved-chats .chat-switch-select[aria-current=true]').textContent(), 'Forest with caves and a spawn pillar');
  assert.equal(await page.getByRole('button', { name: 'Lighting pass' }).isVisible(), true, 'saved chats live in the chip menu');
  await page.mouse.click(700, 500);
  assert.equal(await page.locator('#claude-saved-chats').evaluate(node => (node as HTMLDetailsElement).open), false);
  await page.evaluate(() => { document.querySelector('#claude-saved-chats .chat-switch-current')!.lastChild!.textContent = 'Lighting pass'; });
  await page.waitForFunction(() => document.getElementById('codex-heading')?.textContent === 'Lighting pass');
});

test('Edge: a request notice keeps Review and Details; a plain status rests out of view', browserOptions, async t => {
  const page = await fixture(t);
  const line = page.locator('#codex-panel .chat-topline');
  await page.evaluate(() => { document.getElementById('codex-notice')!.textContent = 'Model updated.'; });
  await page.waitForFunction(() => document.querySelector('#codex-panel .chat-topline')?.getAttribute('data-notice') === 'shown');
  await page.waitForFunction(() => document.querySelector('#codex-panel .chat-topline')?.getAttribute('data-notice') === 'rest');
  assert.equal(await line.evaluate(node => getComputedStyle(node).position), 'absolute', 'resting status takes no space');
  await page.evaluate(id => {
    document.getElementById('codex-notice')!.textContent = 'Couldn\u2019t load this chat\u2019s saved history.';
    document.getElementById('codex-notice-detail')!.textContent = 'Request ' + id + ' \u00b7 history-load \u00b7 rejected';
    document.getElementById('codex-notice-actions')!.hidden = false;
  }, UUID);
  await page.waitForTimeout(800);
  assert.equal(await line.getAttribute('data-notice'), 'shown', 'a notice with Review and Details stays');
  assert.equal(await page.locator('#codex-notice-review').isVisible(), true);
  assert.equal(await page.locator('#codex-notice-detail').isVisible(), false, 'the request ID stays inside Details');
  await page.locator('#codex-notice-details > summary').click();
  assert.equal(await page.locator('#codex-notice-detail').isVisible(), true);
  assert.doesNotMatch(await page.locator('#codex-notice').textContent() ?? '', /[0-9a-f]{8}-[0-9a-f]{4}-/);
  // The routine working line (queued messages already show as rows) never takes the line, yet stays in the live region.
  await page.evaluate(() => {
    document.getElementById('codex-notice')!.hidden = true; document.getElementById('codex-notice-actions')!.hidden = true;
    const claude = document.getElementById('claude-chat-notice')!; claude.hidden = false; claude.setAttribute('data-routine', 'working'); claude.textContent = 'Claude is working… 2 messages queued.';
  });
  await page.waitForFunction(() => document.querySelector('#codex-panel .chat-topline')?.getAttribute('data-notice') === 'rest');
  assert.equal(await page.locator('#claude-chat-notice').getAttribute('role'), 'status');
  assert.equal(await line.evaluate(node => getComputedStyle(node).position), 'absolute', 'the routine line takes no space');
});

test('Edge: at phone width the bar keeps one row with no page scroll', browserOptions, async t => {
  const page = await fixture(t, 420);
  const facts = await page.evaluate(() => {
    const bar = document.getElementById('workspace-topbar')!, rows = new Set<number>();
    for (const node of Array.from(bar.children) as HTMLElement[]) { const r = node.getBoundingClientRect(); if (r.width && getComputedStyle(node).display !== 'none') rows.add(Math.round(r.top + r.height / 2)); }
    return { rows: [...rows], scroll: document.documentElement.scrollWidth - innerWidth, right: Math.max(...(Array.from(bar.children) as HTMLElement[]).map(node => node.getBoundingClientRect().right)) };
  });
  assert.equal(facts.rows.length, 1, 'one row: ' + facts.rows.join(','));
  assert.ok(facts.scroll <= 0, 'no horizontal page scroll');
  assert.ok(facts.right <= 420, 'nothing past the right edge');
});
