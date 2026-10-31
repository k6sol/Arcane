/// <reference lib="dom" />
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { Page } from 'playwright-core';
import type { ChatAction, ChatActionRecord, ChatState, CodexChat } from '../../apps/desktop/src/codex-chat.js';
import type { WorkspaceShell } from '../../apps/desktop/src/workspace-shell.js';
// The shipped faces (studio.css @font-face, same-origin /fonts) are part of the product page, so fixtures serve them.
const shippedFonts = () => readdirSync('apps/desktop/public/fonts').filter(name => name.endsWith('.woff2'))
  .map(name => ['/fonts/' + name, [resolve('apps/desktop/public/fonts', name), 'font/woff2']] as [string, [string, string]]);

const TOKEN = 'a'.repeat(64), THREAD = 'opaque/native thread:settings.1';
const DRAFT = 'Unsent settings draft 🧩\nPreserve trailing spaces.  ';
const edge = process.env.ARCANE_UI_BROWSER_EXE ?? process.env.ARCANE_ASSET_UI_BROWSER_EXE;
type FixtureWindow = Window & { layerFixture: { chat: CodexChat; shell: WorkspaceShell } };

// Same exact JSON shape as codex-asset-permission-ui.test.ts. No service,
// backend, native process, provider login or live account is used.
function state(): ChatState {
  return {
    provider: 'codex', use: 'personal-local', projectPath: 'C:\\Fixture\\Settings scope',
    connecting: false, closing: false, busy: false, actions: [], lastSnapshot: null,
    nativeTools: { configured: true, verified: false },
    nativeAssets: { available: true, sealed: true, granted: false, admissionOpen: false },
    snapshot: {
      connectionId: randomUUID(), provenance: 'spawned-node-fixture', connected: true, ready: true,
      account: { auth: 'subscription', plan: 'fixture', requiresOpenaiAuth: true },
      models: [{ id: 'fixture', model: 'fixture', displayName: 'Fixture', efforts: ['low'], defaultEffort: 'low', entitlement: 'unverified' }],
      selection: { model: 'fixture', effort: 'low' },
      thread: { threadId: THREAD, sessionId: null, selection: { model: 'fixture', effort: 'low' }, configured: true,
        writeGranted: false, turnId: null, turnStatus: 'idle' },
      operations: [], approvals: [], events: [], droppedEvents: 0, lastEventSeq: 0, failureCode: null,
    },
  };
}

async function fixture(t: TestContext) {
  const { chromium } = await import(pathToFileURL(resolve(process.env.ARCANE_UI_BROWSER_MODULE ?? 'node_modules/playwright-core/index.mjs')).href) as typeof import('playwright-core');
  const build = process.env.ARCANE_UI_BUILD_DIR;
  assert.ok(build, 'Use an explicit private compiled output, never root dist.');
  const proof = await mkdtemp(join(process.env.ARCANE_UI_FIXTURE_DIR ?? tmpdir(), 'settings-confirmation-layer-'));
  const files = new Map([
    ...shippedFonts(), ['/studio.css', [resolve('apps/desktop/public/studio.css'), 'text/css']],
    ['/user-errors.js', [resolve(build, 'apps/desktop/src/user-errors.js'), 'text/javascript']],
    ['/codex-chat.js', [resolve(build, 'apps/desktop/src/codex-chat.js'), 'text/javascript']],
    ['/workspace-shell.js', [resolve(build, 'apps/desktop/src/workspace-shell.js'), 'text/javascript']],
    ['/brand/arcane-ridges.png', [resolve('apps/desktop/public/brand/arcane-ridges.png'), 'image/png']],
  ]);
  // Only replace the application bootstrap. Keep production dialog markup,
  // styles and layout: no inline-settings/show() workaround or CSS overrides.
  const html = (await readFile(resolve('apps/desktop/public/studio.html'), 'utf8'))
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
    .replace('</body>', '<script type="module" src="/layer-fixture.js"></script></body>');
  const bootstrap = `
    import { CodexChat, CodexChatApi } from '/codex-chat.js';
    import { startWorkspaceShell } from '/workspace-shell.js';
    // The production page starts behind the sign-in gate; provider setup (not loaded here) lifts it after sign-in.
    document.getElementById('workspace-stage')?.classList.remove('provider-required');
    document.getElementById('provider-login-gate')?.setAttribute('hidden', '');
    const shell = startWorkspaceShell(document);
    const chat = new CodexChat(document, new CodexChatApi(${JSON.stringify(TOKEN)}));
    await chat.start();
    window.layerFixture = { chat, shell };
  `;
  const posts: ChatAction[] = [], errors: string[] = [], unexpected: string[] = [];
  let observed = state(), origin = '';
  const server = createServer((request, reply) => { void (async () => {
    const path = new URL(request.url ?? '/', origin).pathname;
    if (path === '/v1/codex/state' || path === '/v1/codex/action') {
      assert.equal(request.headers.authorization, 'Bearer ' + TOKEN);
      reply.setHeader('Content-Type', 'application/json');
      if (path === '/v1/codex/state' && request.method === 'GET') {
        reply.end(JSON.stringify({ state: observed })); return;
      }
      assert.equal(request.method, 'POST'); assert.equal(path, '/v1/codex/action');
      let body = ''; for await (const part of request) body += String(part);
      const input = JSON.parse(body) as ChatAction; posts.push(input);
      assert.equal(input.action, 'grant-writes');
      assert.equal(input.connectionId, observed.snapshot!.connectionId);
      assert.ok('threadId' in input); assert.equal(input.threadId, observed.snapshot!.thread!.threadId);
      assert.deepEqual(Object.keys(input).sort(), ['action', 'connectionId', 'requestId', 'threadId']);
      const record: ChatActionRecord = {
        requestId: input.requestId, connectionId: input.connectionId, action: input.action,
        threadId: input.threadId, turnId: null, model: null, effort: null,
        state: 'acknowledged', errorCode: null, createdAt: '2026-10-13T12:00:00.000Z',
        finishedAt: '2026-10-13T12:00:00.001Z',
      };
      observed.snapshot!.thread!.writeGranted = true; observed.actions = [record];
      reply.end(JSON.stringify({ record, replayed: false, state: observed })); return;
    }
    if (request.method !== 'GET') throw new Error('Unexpected fixture method: ' + request.method);
    if (path === '/fixture' || path === '/layer-fixture.js') {
      reply.setHeader('Content-Type', path === '/fixture' ? 'text/html' : 'text/javascript');
      reply.end(path === '/fixture' ? html : bootstrap); return;
    }
    const file = files.get(path);
    if (file) { reply.setHeader('Content-Type', file[1]!); reply.end(await readFile(file[0]!)); return; }
    if (path !== '/favicon.ico') unexpected.push(path);
    reply.writeHead(404); reply.end();
  })().catch(error => { errors.push(String(error)); reply.destroy(); }); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  origin = 'http://127.0.0.1:' + address.port;
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
  const context = await chromium.launchPersistentContext(join(proof, 'edge-profile'), {
    executablePath: edge!, headless: true, viewport: { width: 1440, height: 900 }, args: ['--disable-gpu'],
  });
  const page = await context.newPage(); page.setDefaultTimeout(6000);
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', async route => {
    if (new URL(route.request().url()).origin === origin) await route.continue();
    else { unexpected.push(route.request().url()); await route.abort(); }
  });
  t.after(async () => {
    try {
      await page.screenshot({ path: join(proof, 'final.png') });
      await writeFile(join(proof, 'audit.json'), JSON.stringify({ edge: context.browser()!.version(), posts, state: observed, errors, unexpected }, null, 2));
      t.diagnostic('Owned Edge proof: ' + proof);
    } finally { await context.close(); }
  });
  await page.goto(origin + '/fixture');
  await page.waitForFunction(() => !!(window as unknown as FixtureWindow).layerFixture);
  await page.locator('#codex-composer').fill(DRAFT);
  await page.locator('#workspace-preview-toggle').click();
  await page.locator('#app-sidebar [data-workspace-target="workspace-settings"]').click();
  await page.locator('#settings-drawer [data-settings-section-target="settings-advanced"]').click();
  await page.locator('#native-conversation-settings').evaluate(node => { for (let p = node.parentElement; p; p = p.parentElement) if (p.tagName === 'DETAILS') (p as HTMLDetailsElement).open = true; });
  assert.equal(await page.locator('#settings-drawer').evaluate(node => node.matches(':modal')), true);
  assert.equal(await page.locator('#workspace-settings').evaluate(node => !!node.closest('#settings-drawer')), true);
  assert.equal(await page.locator('#codex-confirm').evaluate(node => node.parentElement === document.body && !node.closest('#settings-drawer')), true);
  assert.equal(posts.length, 0);
  const retained = async () => {
    assert.equal(await page.locator('#settings-drawer').evaluate(node => node.matches(':modal')), true);
    assert.equal(await page.locator('#settings-advanced').isVisible(), true);
    assert.equal(await page.locator('#workspace-settings').isVisible(), false);
    assert.equal(await page.locator('#artifact-panel').isVisible(), true);
    assert.equal(await page.locator('#codex-composer').inputValue(), DRAFT);
    assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
  };
  return { page, posts, proof, retained, observed: () => observed };
}

async function openConfirmation(page: Page) {
  await page.locator('#codex-grant').click();
  await page.locator('#codex-confirm').waitFor({ state: 'visible' });
  assert.equal(await page.locator('dialog:modal').count(), 2);
  assert.equal(await page.locator('#codex-confirm').evaluate(node => node.matches(':modal')), true);
  assert.equal(await page.locator('#codex-confirm-check').isChecked(), false);
  assert.equal(await page.locator('#codex-confirm-submit').isDisabled(), true);
  assert.equal(await page.locator('#codex-confirm-check').evaluate(node => {
    const box = node.getBoundingClientRect();
    return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === node;
  }), true, 'The real checkbox must be hit-testable above the settings modal.');
}

test('real Edge production modal stack: exact checked scope posts one acknowledged human grant and retains settings/draft',
  { skip: !edge, timeout: 30000 }, async t => {
    const f = await fixture(t), { page } = f;
    await openConfirmation(page);
    const current = f.observed(), preview = await page.locator('#codex-confirm-preview').textContent();
    for (const value of [current.snapshot!.connectionId, THREAD, current.projectPath, 'network disabled', 'individual native approvals remain required'])
      assert.ok(preview?.includes(value), 'Review exposes exact scope: ' + value);
    assert.equal(f.posts.length, 0);
    await page.locator('#codex-confirm-check').check();
    assert.equal(await page.locator('#codex-confirm-submit').isEnabled(), true);
    await page.screenshot({ path: join(f.proof, 'layered-confirmation.png') });
    await page.locator('#codex-confirm-submit').click();
    await page.waitForFunction(() => document.getElementById('codex-notice')?.textContent?.includes('Workspace editing enabled'));
    assert.equal(await page.locator('#codex-confirm').isVisible(), false);
    assert.equal(f.posts.length, 1);
    assert.deepEqual(f.posts[0], { requestId: f.posts[0]!.requestId, connectionId: current.snapshot!.connectionId, action: 'grant-writes', threadId: THREAD });
    assert.match(f.posts[0]!.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(f.observed().actions[0]!.state, 'acknowledged');
    assert.equal(f.observed().snapshot!.thread!.writeGranted, true);
    assert.equal(f.observed().nativeAssets!.granted, false);
    await f.retained();
  });

test('real Edge production modal stack: Cancel/Escape post nothing, restore grant focus, and changed scope blocks confirmation',
  { skip: !edge, timeout: 30000 }, async t => {
    const f = await fixture(t), { page } = f;
    await openConfirmation(page); await page.locator('#codex-confirm-check').check();
    await page.locator('#codex-confirm-cancel').click();
    await page.locator('#codex-confirm').waitFor({ state: 'hidden' });
    assert.equal(f.posts.length, 0); await f.retained();
    await openConfirmation(page); await page.locator('#codex-confirm-check').check();
    await page.keyboard.press('Escape'); await page.locator('#codex-confirm').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#codex-grant').evaluate(node => document.activeElement === node), true);
    assert.equal(f.posts.length, 0); await f.retained();
    await openConfirmation(page);
    assert.equal(await page.locator('#codex-confirm-check').isChecked(), false, 'Escape discards the prior review.');
    await page.locator('#codex-confirm-check').check();
    f.observed().snapshot!.thread!.threadId = 'changed/native thread:settings.2';
    await page.evaluate(() => (window as unknown as FixtureWindow).layerFixture.chat.refresh());
    // A periodic read can supersede the awaited manual read. Observe the current
    // rendered state within the existing fixture deadline, not that older read.
    await page.waitForFunction(() => (document.getElementById('codex-confirm-submit') as HTMLButtonElement).disabled);
    assert.equal(await page.locator('#codex-confirm-submit').isDisabled(), true);
    assert.ok((await page.locator('#codex-confirm-preview').textContent())?.includes(THREAD), 'Stale review cannot silently adopt another thread.');
    assert.equal(f.posts.length, 0); assert.equal(f.observed().snapshot!.thread!.writeGranted, false);
    await page.screenshot({ path: join(f.proof, 'stale-scope-blocked.png') });
    await page.locator('#codex-confirm-cancel').click(); await f.retained();
  });
