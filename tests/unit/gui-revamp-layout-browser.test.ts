/// <reference lib="dom" />
// Static shell geometry plus production picker/settings handlers with fixed offline native state.
// Neither case exercises provider inference, Studio, a real account, or an actual message send.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const browserModule = process.env.ARCANE_UI_BROWSER_MODULE;
const sizes: [number, number][] = [[360, 900], [400, 1000], [520, 900], [760, 900], [768, 1024], [900, 900], [1024, 900], [1100, 900], [1280, 900], [1440, 900], [1600, 1000], [2560, 1440], [3840, 2160], [1536, 864], [1280, 720], [960, 540]];

test('Edge: static C22 shell geometry holds at 360px, 768px and 3840px, with preview open and closed', { skip: !browserModule, timeout: 180000 }, async t => {
  const shots = resolve(process.env.ARCANE_UI_SCREENSHOT ?? 'runtime/claude-codex-team/claude-audit/c22/shots');
  await mkdir(shots, { recursive: true });
  const html = (await readFile('apps/desktop/public/studio.html', 'utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  const css = await readFile('apps/desktop/public/studio.css', 'utf8');
  const server = createServer((request, response) => {
    if (request.url === '/studio.css') { response.writeHead(200, { 'content-type': 'text/css' }); response.end(css); return; }
    response.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "default-src 'none'; style-src 'self'; img-src 'self'" }); response.end(html);
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const { chromium } = await import(pathToFileURL(resolve(browserModule!)).href) as typeof import('playwright-core');
  const browser = await chromium.launch({ headless: true, args: ['--disable-gpu'], executablePath: process.env.ARCANE_UI_BROWSER_EXE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  t.after(() => browser.close());
  for (const scheme of ['dark', 'light'] as const) {
    const page = await browser.newPage({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.goto('http://127.0.0.1:' + address.port + '/studio');
    await page.evaluate(() => {
      const stage = document.getElementById('workspace-stage')!; stage.classList.remove('provider-required');
      // Synthetic layout state only: enabling Send permits a real pointer hit check, never a send.
      (document.getElementById('codex-submit') as HTMLButtonElement).disabled = false;
      document.getElementById('provider-login-gate')!.hidden = true;
    });
    for (const [width, height] of sizes) for (const preview of [false, true]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(open => {
        const stage = document.getElementById('workspace-stage')!, panel = document.getElementById('artifact-panel')!;
        stage.classList.toggle('preview-open', open); panel.hidden = !open;
      }, preview);
      const facts = await page.evaluate(() => {
        const box = (id: string) => document.getElementById(id)!.getBoundingClientRect();
        const send = box('codex-submit'), composer = box('codex-compose');
        const scrollers = (node: Element | null) => { let count = 0; for (let n = node?.parentElement ?? null; n; n = n.parentElement) { const s = getComputedStyle(n); if (/(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight) count++; } return count; };
        const heading = document.querySelector('.chat-heading')!.getBoundingClientRect(), status = box('codex-status');
        return {
          horizontal: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          sendVisible: send.width > 0 && send.height > 0 && send.bottom <= innerHeight && send.right <= innerWidth && send.top >= 0 && send.left >= 0,
          composerTop: Boolean(document.elementFromPoint(composer.left + composer.width / 2, composer.top + 8)?.closest('#codex-compose')),
          sendHit: Boolean(document.elementFromPoint(send.left + send.width / 2, send.top + send.height / 2)?.closest('#codex-submit')),
          scrollers: scrollers(document.getElementById('codex-messages')),
          statusInside: status.top >= heading.top - 1 && status.bottom <= heading.bottom + 1,
          scrollbarWidth: getComputedStyle(document.querySelector('.conversation-scroll')!).scrollbarWidth,
        };
      });
      const label = scheme + ' ' + width + 'x' + height + (preview ? ' preview' : '');
      assert.ok(facts.horizontal <= 0, label + ': no horizontal page scroll');
      assert.ok(facts.sendVisible, label + ': Send stays in the viewport');
      assert.ok(facts.composerTop, label + ': pointer resolves to the composer');
      assert.ok(facts.sendHit, label + ': pointer resolves to Send, including with preview open');
      assert.ok(facts.scrollers <= 1, label + ': one scroller around the transcript');
      assert.ok(facts.statusInside, label + ': status text stays inside the header strip');
      assert.equal(facts.scrollbarWidth, 'none', label + ': no drawn scrollbar');
      if ([400, 768, 900, 1280, 1600, 3840].includes(width)) await page.screenshot({ path: join(shots, scheme + '-' + width + (preview ? '-preview' : '') + '.png') });
    }
    // Open model/settings interactions are covered below using production handlers.
    await page.setViewportSize({ width: 1280, height: 720 });
    if (scheme === 'dark') { await page.emulateMedia({ forcedColors: 'active' }); await page.screenshot({ path: join(shots, 'forced-colors-1280.png') }); await page.emulateMedia({ forcedColors: null }); }
    await page.close();
  }
});

// Unlike the shell matrix above, these open/close gestures use the real
// CodexChat picker and WorkspaceShell settings handlers. Native state is a
// fixed offline fixture: there is no provider inference, CLI, grant or submit.
test('Edge: production picker and settings handlers open reachable surfaces after the static refresh', { skip: !browserModule, timeout: 60000 }, async t => {
  const build = process.env.ARCANE_UI_BUILD_DIR;
  assert.ok(build, 'Controller interactions require an explicit compiled output.');
  const fixtureState = {
    provider: 'codex', use: 'personal-local', projectPath: resolve('.'), connecting: false, closing: false, busy: false,
    actions: [], lastSnapshot: null, nativeTools: { configured: true, verified: false },
    nativeAssets: { available: true, sealed: true, granted: true, admissionOpen: true },
    snapshot: {
      connectionId: '00000000-0000-4000-8000-000000000001', provenance: 'spawned-node-fixture', connected: true, ready: true,
      account: { auth: 'subscription', plan: 'fixture', requiresOpenaiAuth: true },
      models: [{ model: 'fixture-alpha', id: 'fixture-alpha', displayName: 'Fixture Alpha', efforts: ['low', 'medium'], defaultEffort: 'low', entitlement: 'unverified' }],
      selection: { model: 'fixture-alpha', effort: 'low' },
      thread: { threadId: 'fixture-thread', sessionId: 'fixture-session', selection: { model: 'fixture-alpha', effort: 'low' }, configured: true, writeGranted: true, turnId: null, turnStatus: 'idle' },
      operations: [], approvals: [], events: [], droppedEvents: 0, lastEventSeq: 0, failureCode: null,
    },
  };
  const html = (await readFile('apps/desktop/public/studio.html', 'utf8'))
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
    .replace('</body>', '<script type="module" src="/gui-controller-fixture.js"></script></body>');
  const files = new Map([
    ['/studio.css', [resolve('apps/desktop/public/studio.css'), 'text/css']],
    ['/codex-chat.js', [resolve(build, 'apps/desktop/src/codex-chat.js'), 'text/javascript']],
    ['/workspace-shell.js', [resolve(build, 'apps/desktop/src/workspace-shell.js'), 'text/javascript']],
    ['/packages/protocol/src/chat-queue.js', [resolve(build, 'packages/protocol/src/chat-queue.js'), 'text/javascript']],
  ]);
  const bootstrap = `import {CodexChat,CodexChatApi} from '/codex-chat.js';
    import {startWorkspaceShell} from '/workspace-shell.js';
    document.getElementById('workspace-stage').classList.remove('provider-required');
    document.getElementById('provider-login-gate').hidden=true;
    const state=${JSON.stringify(fixtureState)};
    window.guiFixtureReads=[]; window.guiFixtureActions=[];
    const api=new CodexChatApi('a'.repeat(64),async(path,init)=>{
      if(init?.method&&init.method!=='GET'){window.guiFixtureActions.push(String(path));throw new Error('Unexpected native action in layout fixture');}
      window.guiFixtureReads.push(String(path));
      return String(path)==='/v1/codex/state'?Response.json({state}):new Response('',{status:404});
    });
    const shell=startWorkspaceShell(document),chat=new CodexChat(document,api);
    await chat.start(); window.guiFixtureDispose=()=>{chat.stop();shell.cleanup();}; window.guiFixtureReady=true;`;
  const errors: string[] = [], unexpected: string[] = [];
  const server = createServer((request, response) => { void (async () => {
    if (request.url === '/studio' || request.url === '/gui-controller-fixture.js') {
      response.writeHead(200, { 'content-type': request.url === '/studio' ? 'text/html' : 'text/javascript', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'" });
      response.end(request.url === '/studio' ? html : bootstrap); return;
    }
    const file = files.get(request.url ?? '');
    if (file) { response.writeHead(200, { 'content-type': file[1]! }); response.end(await readFile(file[0]!)); return; }
    if (request.url !== '/favicon.ico' && request.url !== '/brand/arcane-ridges.png') unexpected.push(request.url ?? '');
    response.writeHead(404); response.end();
  })().catch(error => { errors.push(String(error)); response.destroy(); }); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = 'http://127.0.0.1:' + address.port;
  const { chromium } = await import(pathToFileURL(resolve(browserModule!)).href) as typeof import('playwright-core');
  const browser = await chromium.launch({ headless: true, args: ['--disable-gpu'], executablePath: process.env.ARCANE_UI_BROWSER_EXE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  t.after(() => browser.close());
  const page = await browser.newPage({ reducedMotion: 'reduce' }); page.setDefaultTimeout(6000);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    if (new URL(route.request().url()).origin === origin) await route.continue();
    else { unexpected.push(route.request().url()); await route.abort(); }
  });
  await page.goto(origin + '/studio');
  await page.waitForFunction(() => Boolean((window as Window & { guiFixtureReady?: boolean }).guiFixtureReady));
  const fitsAndHit = async (selector: string, label: string) => {
    const facts = await page.locator(selector).evaluate(node => {
      const r = node.getBoundingClientRect();
      return { fits: r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
        hit: node.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)), width: Math.round(r.width) };
    });
    assert.ok(facts.fits, label + ': surface fits viewport'); assert.ok(facts.hit, label + ': actual pointer target is inside surface'); return facts;
  };
  for (const [width, height] of [[768, 1024], [1280, 720], [3840, 2160]] as const) {
    await page.setViewportSize({ width, height });
    await page.locator('#codex-model-trigger').click();
    await page.locator('#codex-picker-summary').waitFor({ state: 'visible' });
    assert.equal((await fitsAndHit('#codex-model-popover', 'reasoning ' + width)).width, 240, 'existing reasoning popover width');
    await page.locator('#codex-picker-current-model').click();
    await page.locator('#codex-model-search').waitFor({ state: 'visible' });
    assert.equal((await fitsAndHit('#codex-model-popover', 'models ' + width)).width, 300, 'existing model-list width');
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    assert.equal(await page.locator('#codex-model-popover').isVisible(), false);
    await page.locator('.sidebar-secondary [data-workspace-target="workspace-settings"]').click();
    assert.equal(await page.locator('#settings-drawer').evaluate(node => node.matches(':modal')), true, 'production handler opens a modal');
    await fitsAndHit('#settings-drawer', 'settings ' + width);
    await page.locator('[data-settings-close]').click();
    assert.equal(await page.locator('#settings-drawer').isVisible(), false);
  }
  assert.deepEqual(await page.evaluate(() => (window as Window & { guiFixtureActions?: string[] }).guiFixtureActions), [], 'No native action or message was submitted');
  assert.ok((await page.evaluate(() => (window as Window & { guiFixtureReads?: string[] }).guiFixtureReads))!.includes('/v1/codex/state'), 'production state reader ran');
  await page.evaluate(() => (window as Window & { guiFixtureDispose?: () => void }).guiFixtureDispose?.());
  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
});
