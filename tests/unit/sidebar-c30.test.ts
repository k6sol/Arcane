/// <reference lib="dom" />
// C30 sidebar: static markup/CSS contract plus the real SharedConversations and WorkspaceShell controllers in Edge with a
// synthetic library bridge. No provider, native thread, Studio session or account is involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const html = await readFile('apps/desktop/public/studio.html', 'utf8');
const css = await readFile('apps/desktop/public/studio.css', 'utf8');
const sidebar = html.slice(html.indexOf('<aside class="app-sidebar"'), html.indexOf('</aside>'));
const start = css.indexOf('/* C30 sidebar */'), end = css.indexOf('/* end C30 sidebar */'), c22 = css.indexOf('/* ---- End C22 revamp ---- */'), reset = css.lastIndexOf('@media(prefers-reduced-motion:reduce)');
const block = css.slice(start, end);

test('sign-in ships as a standalone page: the static document is the signed-out setup view, with no sidebar until the workspace view', () => {
  assert.match(html, /<html lang="en" data-provider-view="setup">/);
  assert.doesNotMatch(html.match(/<section id="provider-login-gate"[^>]*>/)![0], /\bhidden\b/);
  assert.match(block, /:root:is\(\[data-provider-view=checking\],\[data-provider-view=setup\]\) body\.arcane-app:has\(\.workspace-stage\.provider-required\) #app-sidebar\{display:none\}/);
});

test('the sidebar keeps every control reachable without a native select or bottom link list', () => {
  assert.doesNotMatch(sidebar, /<select|Manage folders|Build worlds faster/);
  assert.match(sidebar, /<button id="new-chat"[^>]*aria-keyshortcuts="Control\+N"[^>]*>[\s\S]*?<kbd>Ctrl N<\/kbd>/);
  assert.match(sidebar, /<button id="sidebar-search"[^>]*aria-controls="workspace-search"[^>]*aria-keyshortcuts="Control\+K"/);
  assert.match(sidebar, /<button id="sidebar-menu-toggle"[^>]*aria-expanded="false"[^>]*aria-controls="sidebar-menu"/);
  for (const target of ['project-settings', 'codex-history-heading', 'workspace-settings']) assert.equal(sidebar.split('data-workspace-target="' + target + '"').length - 1, 1, target);
  assert.match(sidebar, /<div id="sidebar-menu" class="sidebar-menu"[^>]*>[\s\S]*data-workspace-target="project-settings"[\s\S]*data-workspace-target="codex-history-heading"[\s\S]*id="sidebar-compact-toggle"/);
  assert.match(sidebar, /class="nav-link sidebar-gear" data-workspace-target="workspace-settings"/);
  assert.ok(sidebar.indexOf('id="conversation-library"') < sidebar.indexOf('class="sidebar-links"'), 'Tools sit below the chats, above the footer card');
  assert.match(sidebar, /<h2 class="sidebar-label">Tools<\/h2>/);
});

test('the C30 block is owned, static, sentence case and sits inside the C22 block, before the reduced-motion reset', () => {
  assert.ok(start > 0 && end > start && c22 > end && reset > c22 && css.indexOf('/* ---- C22 revamp') < start);
  const clean = block.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(clean, /transition|animation|@keyframes|will-change|text-transform:uppercase/);
  assert.equal((clean.match(/\{/g) ?? []).length, (clean.match(/\}/g) ?? []).length);
  for (const [, size] of clean.matchAll(/font-size:(\d+)px/g)) assert.ok(Number(size) >= 12, size);
  for (const [, size] of clean.matchAll(/font:\d+ (\d+)px/g)) assert.ok(Number(size) >= 12, size);
  assert.match(clean, /text-transform:none/);
  // Green and yellow are the Studio status colours only (tokens, used by the dot).
  assert.equal(clean.split('#3fbf7f').length - 1, 1); assert.equal(clean.split('#f2c14e').length - 1, 1);
  assert.match(clean, /@media \(forced-colors:active\)\{/); assert.match(clean, /@media \(prefers-reduced-transparency:reduce\)\{/);
  assert.match(clean, /mask-image:linear-gradient\(180deg,transparent 0,#000 8px,#000 calc\(100% - 24px\),transparent 100%\)/);
});

const browserModule = process.env.ARCANE_UI_BROWSER_MODULE;
test('Edge: folder tree, folder menu, Show all and the footer menu use the existing library APIs and host persistence', { skip: !browserModule, timeout: 60000 }, async t => {
  const build = process.env.ARCANE_UI_BUILD_DIR; assert.ok(build, 'Controller interactions require an explicit compiled output.');
  const page_ = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace('</body>', '<script type="module" src="/fixture.js"></script></body>');
  const fixture = `import {SharedConversations} from '/shared-conversations.js';import {startWorkspaceShell} from '/workspace-shell.js';
    document.documentElement.dataset.providerView='workspace';document.getElementById('workspace-stage').classList.remove('provider-required');
    const P='C:/Fixture',at=i=>new Date(Date.UTC(2026,9,20)-i*3600e3).toISOString();
    const conv=(id,folderId,i,provider='claude')=>({id,title:'Chat '+id,folderId,bindings:[{provider,conversationId:'n-'+id,sessionId:null}],messages:[{provider,conversationId:'n-'+id,id:'m-'+id,role:'user',text:'Chat '+id,at:at(i),model:null}]});
    const library={version:1,projectPath:P,activeId:'a',folders:[{id:'forest',name:'Forest'},{id:'shop',name:'Shop'}],expandedFolderIds:['forest'],
      conversations:[conv('a','forest',1),conv('b','shop',2),...[1,2,3,4,5,6,7].map(i=>conv('u'+i,null,10+i,i%2?'codex':'arcane'))]};
    window.saves=[];window.opened=[];
    const peer=p=>({recordedTranscript:()=>({provider:p,projectPath:P,conversationId:null,sessionId:null,messages:[]}),conversationSource:()=>({projectPath:P,localId:p+'-fixture'}),isDraftConversation:()=>false,subscribeTranscriptChange:()=>()=>{},setBeforeMessageSubmit(){},showConversationNotice(){},open:async id=>{window.opened.push(id);return true;},openDraftConversation:async()=>false,newChat:async()=>true});
    window.shell=startWorkspaceShell(document);
    window.library=new SharedConversations(document,{bridge:{version:1,read:async()=>({available:true,projectPath:P,preferences:library}),save:async v=>{window.saves.push(v);return{saved:true};}},provider:()=>'claude',requestProvider:()=>true,peers:{claude:peer('claude'),codex:peer('codex')}});`;
  const server = createServer((request, response) => { void (async () => {
    const path = request.url ?? '', name = /^\/([a-z-]+)\.js$/.exec(path)?.[1];
    const body = path === '/studio' ? page_ : path === '/studio.css' ? css : path === '/fixture.js' ? fixture
      : name && ['shared-conversations', 'conversation-library', 'workspace-shell', 'user-errors'].includes(name) ? await readFile(join(build, 'apps/desktop/src', name + '.js'), 'utf8') : null;
    response.writeHead(body === null ? 404 : 200, { 'content-type': path === '/studio' ? 'text/html' : path === '/studio.css' ? 'text/css' : 'text/javascript' }); response.end(body ?? '');
  })(); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const { chromium } = await import(pathToFileURL(resolve(browserModule!)).href) as typeof import('playwright-core');
  const browser = await chromium.launch({ headless: true, args: ['--disable-gpu'], executablePath: process.env.ARCANE_UI_BROWSER_EXE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' }), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:' + address.port + '/studio'); await page.waitForSelector('#conversation-library .library-section');
  const saved = () => page.evaluate(() => (window as unknown as { saves: { expandedFolderIds?: string[]; folders: { id: string; name: string }[]; conversations: { id: string; folderId: string | null }[] }[] }).saves.at(-1));
  assert.equal(await page.locator('#app-sidebar select').count(), 0);
  assert.deepEqual(await page.locator('#app-sidebar .sidebar-label').allTextContents(), ['Folders', 'Chats', 'Tools']);
  assert.equal(await page.locator('#library-folder-0').isVisible(), true); assert.equal(await page.locator('#library-folder-1').isVisible(), false);
  // Five most recent unfiled chats, then Show all 7.
  assert.equal(await page.locator('#library-chats .library-chat').count(), 5);
  await page.locator('.library-show-all').click(); assert.equal(await page.locator('#library-chats .library-chat').count(), 7);
  assert.equal(await page.locator('.library-show-all').getAttribute('aria-expanded'), 'true');
  // Expand/collapse persists through the host bridge (never browser storage).
  await page.locator('.library-folder[aria-label="Shop"] .library-folder-toggle').click();
  await page.waitForFunction(() => (window as unknown as { saves: unknown[] }).saves.length > 0);
  assert.deepEqual((await saved())?.expandedFolderIds, ['forest', 'shop']);
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  // ⋯ menu: keyboard reachable, Escape returns focus; right-click opens the same menu.
  const more = page.locator('.library-folder[aria-label="Forest"] .library-folder-more');
  await more.focus(); await page.keyboard.press('Enter');
  assert.deepEqual(await page.locator('#library-folder-menu [role=menuitem]').evaluateAll(items => items.map(item => item.getAttribute('aria-label') ?? item.textContent)),
    ['Rename folder', 'Move current chat to Chats', 'Remove folder: chats move to Chats']);
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Rename folder');
  await page.keyboard.press('Escape'); assert.equal(await page.locator('#library-folder-menu').count(), 0);
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Actions for Forest');
  await page.locator('.library-folder[aria-label="Shop"] .library-folder-row').click({ button: 'right' });
  assert.equal(await page.locator('#library-folder-menu').getAttribute('aria-label'), 'Shop folder actions');
  // Existing APIs: rename, move the current chat, remove (its chats move to Chats).
  await page.locator('#library-folder-menu [role=menuitem]', { hasText: 'Rename folder' }).click();
  await page.keyboard.press('Control+A'); await page.keyboard.type('Shop screens'); await page.keyboard.press('Enter');
  await page.locator('.library-folder[aria-label="Shop screens"] .library-folder-more').click();
  await page.locator('#library-folder-menu [role=menuitem]', { hasText: 'Move current chat here' }).click();
  await page.locator('.library-folder[aria-label="Forest"] .library-folder-more').click();
  await page.locator('#library-folder-menu [role=menuitem]', { hasText: 'Remove folder' }).click();
  const last = await saved();
  assert.deepEqual(last?.folders.map(f => f.name), ['Shop screens']);
  assert.equal(last?.conversations.find(c => c.id === 'a')?.folderId, 'shop');
  assert.deepEqual(last?.expandedFolderIds, ['shop']);
  // New folder from the Folders heading.
  await page.locator('.library-new-folder').click(); await page.keyboard.type('Lobby'); await page.keyboard.press('Enter');
  assert.deepEqual((await saved())?.folders.map(f => f.name), ['Shop screens', 'Lobby']);
  // C31: typing a name shows Create (and Cancel); an empty name never creates; Escape cancels; Create creates.
  await page.locator('.library-new-folder').click();
  assert.equal(await page.locator('.library-create-submit').getAttribute('aria-disabled'), 'true');
  await page.keyboard.press('Enter'); await page.locator('.library-create-submit').click({ force: true });
  assert.equal(await page.locator('.library-create').count(), 1, 'An empty name keeps the field open and creates nothing');
  await page.locator('.library-create-input').focus(); await page.keyboard.type('Arena');
  assert.equal(await page.locator('.library-create-submit').getAttribute('aria-disabled'), 'false');
  await page.keyboard.press('Escape'); assert.equal(await page.locator('.library-create').count(), 0);
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'New folder');
  await page.locator('.library-new-folder').click(); await page.keyboard.type('Arena'); await page.locator('.library-create-submit').click();
  assert.deepEqual((await saved())?.folders.map(f => f.name), ['Shop screens', 'Lobby', 'Arena']);
  await page.locator('.library-new-folder').click(); await page.locator('.library-create-cancel').click(); assert.equal(await page.locator('.library-create').count(), 0);
  // Shared-context glyph: named, described by its tooltip; the open folder is a bubble holding its chats, with a summary line.
  const glyph = page.locator('.library-folder[aria-label="Shop screens"] .library-context');
  assert.equal(await glyph.getAttribute('aria-label'), 'Shared context');
  assert.equal(await page.locator('#' + await glyph.getAttribute('aria-describedby')).textContent(), 'Chats in this folder share memory and context');
  assert.match(await page.locator('.library-folder[aria-label="Shop screens"]').evaluate(n => getComputedStyle(n).backgroundImage), /gradient/);
  assert.match(await page.locator('.library-folder[aria-label="Shop screens"] .library-folder-totals').textContent() ?? '', /^2 chats · active \d+(m|h|d|w|mo) ago$/);
  // Footer menu: Project and History, then Escape back to the toggle; the gear opens Settings.
  await page.locator('#sidebar-menu-toggle').click();
  assert.equal(await page.locator('#sidebar-menu').isVisible(), true);
  assert.deepEqual((await page.locator('#sidebar-menu button').allTextContents()).map(s => s.trim()), ['Project', 'History', 'Collapse sidebar to icons']);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#sidebar-menu').isVisible(), false); assert.equal(await page.evaluate(() => document.activeElement?.id), 'sidebar-menu-toggle');
  await page.locator('.sidebar-secondary [data-workspace-target="workspace-settings"]').click();
  assert.equal(await page.locator('#settings-drawer').evaluate(node => node.matches(':modal')), true);
  assert.deepEqual(errors, []);
});
