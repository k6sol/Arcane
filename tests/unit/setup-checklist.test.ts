import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checklistRows, checklistVisible, isStarterProject, pluginBannerKind, PLUGIN_BANNER_TEXT, readChecklistMemory, readPluginPreference, readPluginStatus, SETUP_CHECKLIST_KEY, type ChecklistSignals } from '../../apps/desktop/src/setup-checklist.js';
import { studioPluginOutdated, studioPluginReport } from '../../apps/daemon/src/studio-routes.js';
import { READ_METHODS, WRITE_METHODS, ASSET_STAGE_METHODS, STUDIO_FEATURE_CAPABILITIES, type StudioSession } from '../../packages/protocol/src/studio.js';
import { STUDIO_PLUGIN_VERSION } from '../../packages/protocol/src/studio-plugin-artifact.js';

const ready: ChecklistSignals = { signedIn: true, providerName: 'Claude', plugin: { state: 'installed', pluginVersion: '0.1.9', message: 'ok' }, desktop: true, studioConnected: true, projectPath: 'C:\\Games\\Obby' };
const states = (s: ChecklistSignals) => Object.fromEntries(checklistRows(s).map(row => [row.step, [row.state, row.action?.kind ?? null]]));

test('checklist rows map each signal to done/todo with its one-click fix', () => {
  assert.deepEqual(states(ready), { provider: ['done', null], plugin: ['done', null], studio: ['done', null], project: ['done', null] });
  assert.deepEqual(states({ ...ready, signedIn: false, plugin: { state: 'missing', pluginVersion: '0.1.9', message: '' }, studioConnected: false, projectPath: null }),
    { provider: ['todo', 'sign-in'], plugin: ['todo', 'install-plugin'], studio: ['todo', 'show-key'], project: ['todo', 'open-project'] });
  assert.equal(checklistRows({ ...ready, plugin: { state: 'outdated', pluginVersion: '0.1.9', message: '' } })[1]!.action?.label, 'Update plugin');
  assert.deepEqual(states({ ...ready, plugin: { state: 'unavailable', pluginVersion: null, message: 'Studio plugin setup is unavailable.' } }).plugin, ['unavailable', 'check-plugin']);
  assert.deepEqual(states({ ...ready, plugin: null, studioConnected: null }).plugin, ['checking', null]);
  assert.deepEqual(states({ ...ready, studioConnected: null }).studio, ['checking', 'show-key']);
  // A plain browser has no native bridge: no install or project picker is offered.
  assert.deepEqual(states({ ...ready, desktop: false, projectPath: null }), { provider: ['done', null], plugin: ['unavailable', null], studio: ['done', null], project: ['todo', null] });
  assert.match(checklistRows(ready)[0]!.detail, /Claude/);
  assert.equal(checklistRows({ ...ready, projectPath: 'C:\\Users\\me\\AppData\\Roaming\\Arcane\\projects\\Untitled' })[3]!.detail, 'Starter project. Open your own folder anytime.');
  assert.equal(checklistRows(ready)[3]!.detail, 'Obby');
});

test('with one-click pairing the Studio row offers Connect Studio, then shows the waiting code with the API key as fallback', () => {
  const idle = { phase: 'idle', code: null, message: '' } as const;
  const studio = (pairing: NonNullable<ChecklistSignals['pairing']> | null, connected: boolean | null = false) => checklistRows({ ...ready, studioConnected: connected, pairing })[2]!;
  assert.deepEqual([studio(idle).state, studio(idle).action], ['todo', { kind: 'connect-studio', label: 'Connect Studio' }]);
  const waiting = studio({ phase: 'waiting', code: '042718', message: '' });
  assert.equal(waiting.detail, 'Waiting for Studio… In Roblox Studio, type 042 718 into the Arcane plugin and click Connect.');
  const approval = studio({ phase: 'approval', code: null, message: 'Roblox Studio place “Obby” (place 1) wants to connect.' });
  assert.deepEqual([approval.state, approval.detail, approval.action?.kind], ['todo', 'Roblox Studio place “Obby” (place 1) wants to connect.', 'review-studio'], 'Approve/Deny live next to the place on the Studio plugin card.');
  assert.deepEqual([studio({ phase: 'approved', code: null, message: 'Approved.' }).state, studio({ phase: 'approved', code: null, message: 'Approved.' }).action], ['checking', null]);
  assert.deepEqual(waiting.action, { kind: 'show-key', label: 'Use API key' });
  assert.deepEqual([studio({ phase: 'starting', code: null, message: '' }).state, studio({ phase: 'starting', code: null, message: '' }).action], ['checking', null]);
  assert.equal(studio({ phase: 'busy', code: null, message: 'Another Arcane window is waiting.' }).action?.kind, 'show-key');
  assert.equal(studio({ phase: 'expired', code: null, message: 'Expired.' }).detail, 'Expired.');
  assert.equal(studio(idle, null).state, 'checking');
  assert.equal(studio({ phase: 'waiting', code: '0427', message: '' }, true).state, 'done', 'A live session always wins.');
  assert.equal(studio(null).action?.kind, 'show-key', 'Without pairing the original key flow is unchanged.');
});

test('starter project detection is exact', () => {
  assert.equal(isStarterProject('C:\\Users\\me\\AppData\\Roaming\\Arcane\\projects\\Untitled'), true);
  assert.equal(isStarterProject('/home/me/.config/Arcane/projects/Untitled/'), true);
  assert.equal(isStarterProject('C:\\Games\\Untitled'), false);
  assert.equal(isStarterProject('C:\\projects\\Untitled Game'), false);
});

test('memory accepts only the exact bounded record and visibility honours completion, dismissal and later', () => {
  assert.equal(SETUP_CHECKLIST_KEY, 'arcane.setup-checklist.v1');
  assert.deepEqual(readChecklistMemory(JSON.stringify({ version: 1, completed: true, dismissed: false })), { version: 1, completed: true, dismissed: false });
  for (const raw of [null, '', '{', '[]', 'null', JSON.stringify({ version: 2, completed: true, dismissed: true }), JSON.stringify({ version: 1, completed: 'yes', dismissed: false }),
    JSON.stringify({ version: 1, completed: true, dismissed: false, token: 'x' }), ' '.repeat(200), '{"version":1,"completed":true,"dismissed":true,"__proto__":{"x":1}}'])
    assert.deepEqual(readChecklistMemory(raw), { version: 1, completed: false, dismissed: false }, String(raw));
  const pending = checklistRows({ ...ready, studioConnected: false }), done = checklistRows(ready);
  const fresh = { version: 1, completed: false, dismissed: false } as const;
  assert.equal(checklistVisible(pending, fresh, false), true);
  assert.equal(checklistVisible(done, fresh, false), false, 'Auto-hides when everything is green.');
  assert.equal(checklistVisible(pending, { ...fresh, dismissed: true }, false), false);
  assert.equal(checklistVisible(pending, { ...fresh, completed: true }, false), false, 'Returning users who finished setup skip it.');
  assert.equal(checklistVisible(pending, fresh, true), false);
});

test('plugin replies are copied to fixed fields; anything unexpected is unavailable', () => {
  assert.deepEqual(readPluginStatus({ version: 1, state: 'missing', pluginVersion: '0.1.9', message: 'Not installed.' }), { state: 'missing', pluginVersion: '0.1.9', message: 'Not installed.' });
  for (const bad of [null, {}, { version: 1, state: 'hacked', pluginVersion: null, message: '' }, { version: 1, state: 'missing', pluginVersion: '../x', message: '' },
    { version: 1, state: 'missing', pluginVersion: null, message: 'line\nbreak' }, { version: 1, state: 'missing', pluginVersion: null, message: 'x'.repeat(513) }])
    assert.equal(readPluginStatus(bad).state, 'unavailable');
});

test('real Edge checklist: status reads only, one-click actions, persistence and screenshots', { skip: !process.env.ARCANE_UI_BROWSER_MODULE, timeout: 60000 }, async t => {
  const { chromium } = await import(pathToFileURL(resolve(process.env.ARCANE_UI_BROWSER_MODULE!)).href);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.ARCANE_UI_BROWSER_EXE }); t.after(() => browser.close());
  const build = process.env.ARCANE_UI_BUILD_DIR ?? resolve('dist');
  const html = (await readFile('apps/desktop/public/studio.html', 'utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  const js = await readFile(join(build, 'apps/desktop/src/setup-checklist.js'), 'utf8'), css = await readFile('apps/desktop/public/studio.css', 'utf8');
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const p = req.url?.split('?')[0] ?? ''; requests.push(p);
    const value = p === '/fixture' ? html : p === '/setup-checklist.js' ? js : p === '/studio.css' ? css : '';
    res.writeHead(value ? 200 : 404, { 'Content-Type': p === '/fixture' ? 'text/html' : p === '/studio.css' ? 'text/css' : 'text/javascript' }); res.end(value);
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
  const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  const shots = process.env.ARCANE_UI_SCREENSHOT; if (shots) await mkdir(shots, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: 'dark' });
  const page = await context.newPage(), errors: string[] = []; page.on('pageerror', (e: Error) => errors.push(e.message));
  let nativeMemory: {version:1;completed:boolean;dismissed:boolean}|null = null, releaseRead:(()=>void)|null = null, holdRead = false;
  const savedNativeMemory = (): {version:1;completed:boolean;dismissed:boolean}|null => nativeMemory;
  await page.exposeFunction('fixtureChecklistRead',async()=>{
    if(holdRead)await new Promise<void>(done=>{releaseRead=done;});
    return {available:true,memory:nativeMemory};
  });
  await page.exposeFunction('fixtureChecklistSave',async(memory:{version:1;completed:boolean;dismissed:boolean})=>{nativeMemory=structuredClone(memory);return {saved:true};});
  const boot = async (useNative = false) => {
    await page.goto(origin + '/fixture');
    await page.evaluate(async (useNative:boolean) => {
      const path: string = '/setup-checklist.js', m = await import(path); const w = window as any;
      w.calls = []; w.events = []; w.signedIn = false; w.studio = false; w.project = null; w.plugin = 'missing'; w.listeners = [];
      for (const type of ['workspace:providersetup', 'workspace:settingsrequest']) document.addEventListener(type, (e: Event) => w.events.push([type, (e as CustomEvent).detail]));
      const sub = (fn: () => void) => { w.listeners.push(fn); return () => {}; };
      const desktop = { studioPlugin: Object.freeze({ version: 1,
        status: async () => { w.calls.push('status'); return { version: 1, state: w.plugin, pluginVersion: '0.1.9', message: w.plugin === 'installed' ? 'The Arcane Studio plugin is installed and current.' : 'The Arcane Studio plugin is not installed yet.' }; },
        install: async () => { w.calls.push('install'); w.plugin = 'installed'; return { version: 1, state: 'installed', pluginVersion: '0.1.9', changed: true, message: 'Arcane Studio plugin installed. Restart Roblox Studio to load it.' }; } }),
        workspaceProject: Object.freeze({ version: 1, open: async () => { w.calls.push('open'); return { requested: true }; } }),
        ...(useNative ? {setupChecklist:Object.freeze({version:1,read:()=>w.fixtureChecklistRead(),save:(memory:unknown)=>w.fixtureChecklistSave(memory)})} : {}) };
      if(useNative)localStorage.removeItem('arcane.setup-checklist.v1');
      document.getElementById('provider-login-gate')!.hidden = true;
      w.controller = m.startSetupChecklist(document, {
        provider: { isSignedIn: () => w.signedIn, chatSurface: () => 'codex', selectedProvider: () => 'claude', subscribeSignInChange: sub, subscribeChatSurface: sub },
        workbench: { studioConnected: () => w.studio, subscribeStudioChange: sub, getCurrentProduct: () => w.project ? { projectId: 'a'.repeat(64), projectPath: w.project } : null, subscribeProjectChange: sub },
        desktop, storage: window.localStorage });
      w.notify = () => { for (const fn of w.listeners) fn(); };
    },useNative);
  };
  await boot();
  await page.waitForFunction(() => document.querySelector('#setup-checklist [data-step=plugin]')?.getAttribute('data-state') === 'todo');
  assert.equal(await page.locator('#setup-checklist').isVisible(), true);
  assert.equal(await page.locator('#setup-checklist-progress').textContent(), '0 of 4 ready');
  assert.deepEqual(await page.evaluate(() => (window as any).calls), ['status'], 'Mount reads plugin status once and nothing else.');
  assert.equal(await page.locator('#studio-plugin-state').textContent(), 'Not installed');
  if (shots) await page.locator('.codex-panel').screenshot({ path: join(shots, 'setup-checklist-first-run.png') });

  // Actions: sign in opens provider setup for the selected provider; pairing opens the key card; open project asks the host.
  await page.locator('#setup-checklist [data-setup-action=sign-in]').click();
  await page.locator('#setup-checklist [data-setup-action=show-key]').click();
  await page.locator('#setup-checklist [data-setup-action=open-project]').click();
  assert.deepEqual(await page.evaluate(() => (window as any).events), [['workspace:providersetup', { provider: 'claude' }], ['workspace:settingsrequest', { target: 'settings-key-heading' }]]);
  await page.locator('#setup-checklist [data-setup-action=install-plugin]').click();
  await page.waitForFunction(() => document.querySelector('#setup-checklist [data-step=plugin]')?.getAttribute('data-state') === 'done');
  assert.deepEqual(await page.evaluate(() => (window as any).calls), ['status', 'open', 'install', 'status'], 'Install is re-verified by a fresh status read.');
  assert.match(await page.locator('#setup-checklist-notice').textContent() ?? '', /Restart Roblox Studio/);
  assert.equal(await page.locator('#studio-plugin-state').textContent(), 'Installed');
  // Synthetic clicks never trigger native actions.
  await page.evaluate(() => (document.querySelector('#setup-checklist [data-setup-action=open-project]') as HTMLButtonElement).click());
  assert.equal((await page.evaluate(() => (window as any).calls)).filter((c: string) => c === 'open').length, 1);

  await page.evaluate(() => { const w = window as any; w.signedIn = true; w.project = 'C:\\Games\\Obby'; w.notify(); });
  assert.equal(await page.locator('#setup-checklist-progress').textContent(), '3 of 4 ready');
  if (shots) await page.locator('.codex-panel').screenshot({ path: join(shots, 'setup-checklist-almost.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  if (shots) await page.screenshot({ path: join(shots, 'setup-checklist-mobile.png'), fullPage: false });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'No horizontal overflow at phone width.');
  await page.setViewportSize({ width: 1280, height: 860 });

  // Both dismissal actions survive a new renderer; completed setup stays available in Settings.
  await page.locator('#setup-checklist-later').click();
  assert.equal(await page.locator('#setup-checklist').isVisible(), false);
  assert.equal(JSON.parse(await page.evaluate((k: string) => localStorage.getItem(k), SETUP_CHECKLIST_KEY) ?? 'null').dismissed, true);
  await boot();
  assert.equal(await page.locator('#setup-checklist').isVisible(), false, 'Later survives a reload.');
  await page.evaluate(() => (document.getElementById('settings-drawer') as HTMLDialogElement).showModal());
  await page.locator('#setup-checklist-show').click();
  await page.evaluate(() => (document.getElementById('settings-drawer') as HTMLDialogElement).close());
  await page.waitForFunction(() => !document.getElementById('setup-checklist')!.hidden);
  await page.locator('#setup-checklist-hide').click();
  assert.deepEqual(JSON.parse(await page.evaluate((k: string) => localStorage.getItem(k), SETUP_CHECKLIST_KEY) ?? 'null'), { version: 1, completed: false, dismissed: true });
  await boot();
  assert.equal(await page.locator('#setup-checklist').isVisible(), false, 'Dismissal survives a reload.');
  await page.evaluate(() => { const d = document.getElementById('settings-drawer') as HTMLDialogElement; d.showModal(); });
  assert.equal(await page.locator('#setup-checklist-show').isVisible(), true);
  if (shots) await page.locator('#studio-plugin-settings').screenshot({ path: join(shots, 'settings-studio-plugin.png') });
  await page.locator('#setup-checklist-show').click();
  await page.evaluate(() => (document.getElementById('settings-drawer') as HTMLDialogElement).close());
  assert.equal(await page.locator('#setup-checklist').isVisible(), true);
  await page.evaluate(async () => { const w = window as any; w.signedIn = true; w.studio = true; w.project = 'C:\\Games\\Obby'; w.plugin = 'installed'; await w.controller.refreshPlugin(); w.notify(); });
  await page.waitForFunction(() => document.getElementById('setup-checklist')!.hidden);
  assert.deepEqual(JSON.parse(await page.evaluate((k: string) => localStorage.getItem(k), SETUP_CHECKLIST_KEY) ?? 'null'), { version: 1, completed: true, dismissed: false });
  await page.evaluate(() => { const w = window as any; w.studio = false; }); await boot();
  assert.equal(await page.locator('#setup-checklist').isVisible(), false, 'A returning user who finished setup skips it.');

  // The desktop bridge stores the choice outside the temporary renderer; each boot starts with empty localStorage.
  await boot(true);await page.waitForFunction(()=>!document.getElementById('setup-checklist')!.hidden);
  await page.locator('#setup-checklist-later').click();
  for(let attempts=0;attempts<100&&!savedNativeMemory()?.dismissed;attempts++)await new Promise(done=>setTimeout(done,10));
  assert.equal(savedNativeMemory()?.dismissed,true,'Later is acknowledged by app-owned storage.');
  await boot(true);await page.waitForTimeout(200);
  assert.equal(await page.locator('#setup-checklist').isVisible(),false,'Later survives empty renderer storage.');
  await page.evaluate(()=>(document.getElementById('settings-drawer') as HTMLDialogElement).showModal());
  await page.locator('#setup-checklist-show').click();await page.evaluate(()=>(document.getElementById('settings-drawer') as HTMLDialogElement).close());
  await page.locator('#setup-checklist-hide').click();
  await page.waitForFunction(()=>document.getElementById('setup-checklist')!.hidden);
  for(let attempts=0;attempts<100&&!savedNativeMemory()?.dismissed;attempts++)await new Promise(done=>setTimeout(done,10));
  assert.equal(savedNativeMemory()?.dismissed,true);
  holdRead=true;await boot(true);await page.waitForTimeout(500);
  assert.equal(await page.locator('#setup-checklist').isVisible(),false,'never flash before a slow app-owned preference read');
  holdRead=false;assert.ok(releaseRead);(releaseRead as ()=>void)();
  await page.waitForTimeout(200);assert.equal(await page.locator('#setup-checklist').isVisible(),false,'native Hide survives a fresh renderer');
  await page.evaluate(()=>(document.getElementById('settings-drawer') as HTMLDialogElement).showModal());
  await page.locator('#setup-checklist-show').click();await page.evaluate(()=>(document.getElementById('settings-drawer') as HTMLDialogElement).close());
  assert.equal(await page.locator('#setup-checklist').isVisible(),true);
  await page.evaluate(async()=>{const w=window as any;w.signedIn=true;w.studio=true;w.project='C:\\Games\\Obby';w.plugin='installed';await w.controller.refreshPlugin();w.notify();});
  await page.waitForFunction(()=>document.getElementById('setup-checklist')!.hidden);
  for(let attempts=0;attempts<100&&!savedNativeMemory()?.completed;attempts++)await new Promise(done=>setTimeout(done,10));
  assert.equal(savedNativeMemory()?.completed,true);await boot(true);await page.waitForTimeout(200);
  assert.equal(await page.locator('#setup-checklist').isVisible(),false,'native completion survives a new renderer');
  await page.evaluate(()=>(document.getElementById('settings-drawer') as HTMLDialogElement).showModal());
  await page.locator('#setup-checklist-show').click();await page.evaluate(()=>(document.getElementById('settings-drawer') as HTMLDialogElement).close());
  assert.equal(await page.locator('#setup-checklist').isVisible(),true,'completed setup remains available on demand');

  // Status checks never spend model calls: only the fixture page, stylesheet and module were requested.
  assert.deepEqual([...new Set(requests)].sort(), ['/fixture', '/setup-checklist.js', '/studio.css'].concat(requests.includes('/favicon.ico') ? ['/favicon.ico'] : []).sort());
  assert.deepEqual(errors, []);
});

test('plugin update banner: file update, Studio restart, stale pairing and the confirmation', () => {
  const installed = { state: 'installed', pluginVersion: '0.2.0', message: '' } as const, outdated = { ...installed, state: 'outdated' } as const;
  const base = { desktop: true, plugin: installed, pairedCurrent: true, justUpdated: false } as const;
  assert.equal(pluginBannerKind(base), 'hidden');
  assert.equal(pluginBannerKind({ ...base, plugin: outdated }), 'available', 'An older plugin file offers Update plugin.');
  assert.equal(pluginBannerKind({ ...base, plugin: outdated, pairedCurrent: false }), 'available');
  assert.equal(pluginBannerKind({ ...base, plugin: null }), 'hidden', 'Nothing before the first native read.');
  assert.equal(pluginBannerKind({ ...base, plugin: { ...installed, state: 'missing' } }), 'hidden', 'First install stays in the setup checklist.');
  assert.equal(pluginBannerKind({ ...base, pairedCurrent: false }), 'stale', 'Studio still runs the old plugin.');
  assert.equal(pluginBannerKind({ ...base, justUpdated: true, pairedCurrent: null }), 'restart');
  assert.equal(pluginBannerKind({ ...base, justUpdated: true, pairedCurrent: false }), 'restart');
  assert.equal(pluginBannerKind({ ...base, justUpdated: true, pairedCurrent: true }), 'ready', 'The new plugin paired.');
  assert.equal(pluginBannerKind({ ...base, desktop: false, plugin: null, pairedCurrent: false }), 'stale', 'A plain browser still warns about the paired plugin.');
  assert.equal(pluginBannerKind({ ...base, desktop: false, plugin: outdated }), 'hidden');
  assert.match(PLUGIN_BANNER_TEXT.available, /^Studio plugin update available/);
  assert.deepEqual(readPluginPreference({ version: 1, autoUpdate: true, message: 'On.' }), { autoUpdate: true, message: 'On.' });
  for (const bad of [null, {}, { version: 1, autoUpdate: 'yes', message: '' }, { version: 1, autoUpdate: true, message: 'a\nb' }]) assert.equal(readPluginPreference(bad), null);
});

test('daemon plugin report flags a paired plugin older than the bundled one by version or missing capability', () => {
  const full: string[] = [...READ_METHODS, ...WRITE_METHODS, ...ASSET_STAGE_METHODS, ...STUDIO_FEATURE_CAPABILITIES];
  assert.equal(studioPluginOutdated({ pluginVersion: STUDIO_PLUGIN_VERSION, capabilities: full }), false);
  assert.equal(studioPluginOutdated({ pluginVersion: STUDIO_PLUGIN_VERSION, capabilities: [...full, 'asset.keep_mesh'] }), false);
  assert.equal(studioPluginOutdated({ pluginVersion: STUDIO_PLUGIN_VERSION, capabilities: full.filter(c => c !== 'environment.forest') }), true, 'Same version, missing capability.');
  assert.equal(studioPluginOutdated({ pluginVersion: '0.1.9', capabilities: full }), true);
  assert.equal(studioPluginOutdated({ pluginVersion: '1.0.0', capabilities: full }, '0.2.0'), false, 'A newer plugin is not outdated.');
  assert.equal(studioPluginOutdated({ pluginVersion: '0.2.0', capabilities: full }, '0.10.0'), true, 'Numeric, not lexical, comparison.');
  assert.equal(studioPluginOutdated({ pluginVersion: 'fixture', capabilities: full }), true);
  const session = (id: string, revokedAt: string | null, capabilities: string[]) => ({ id, revokedAt, pluginVersion: STUDIO_PLUGIN_VERSION, capabilities }) as unknown as StudioSession;
  assert.deepEqual(studioPluginReport([session('a', null, full), session('b', null, ['scene.children']), session('c', 'x', [])]), { bundledVersion: STUDIO_PLUGIN_VERSION, outdatedSessionIds: ['b'] });
});

test('real Edge plugin update banner: one click, restart guidance, pairing confirmation and opt-in automatic updates', { skip: !process.env.ARCANE_UI_BROWSER_MODULE, timeout: 60000 }, async t => {
  const { chromium } = await import(pathToFileURL(resolve(process.env.ARCANE_UI_BROWSER_MODULE!)).href);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.ARCANE_UI_BROWSER_EXE }); t.after(() => browser.close());
  const build = process.env.ARCANE_UI_BUILD_DIR ?? resolve('dist');
  const html = (await readFile('apps/desktop/public/studio.html', 'utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  const js = await readFile(join(build, 'apps/desktop/src/setup-checklist.js'), 'utf8'), css = await readFile('apps/desktop/public/studio.css', 'utf8');
  const server = createServer((req, res) => {
    const p = req.url?.split('?')[0] ?? '';
    const value = p === '/fixture' ? html : p === '/setup-checklist.js' ? js : p === '/studio.css' ? css : '';
    res.writeHead(value ? 200 : 404, { 'Content-Type': p === '/fixture' ? 'text/html' : p === '/studio.css' ? 'text/css' : 'text/javascript' }); res.end(value);
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
  const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  const shots = process.env.ARCANE_UI_SCREENSHOT; if (shots) await mkdir(shots, { recursive: true });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: 'dark' })).newPage(), errors: string[] = [];
  page.on('pageerror', (e: Error) => errors.push(e.message));
  const boot = async (auto: boolean) => {
    await page.goto(origin + '/fixture');
    await page.evaluate(async (auto: boolean) => {
      const path: string = '/setup-checklist.js', m = await import(path); const w = window as any;
      w.calls = []; w.plugin = 'outdated'; w.paired = false; w.auto = auto; w.listeners = []; w.timers = [];
      const sub = (fn: () => void) => { w.listeners.push(fn); return () => {}; };
      const reply = (changed?: boolean) => ({ version: 1, state: w.plugin, pluginVersion: '0.2.0', message: 'fixed', ...(changed === undefined ? {} : { changed }) });
      const studioPlugin = Object.freeze({ version: 1,
        status: async () => { w.calls.push('status'); return reply(); },
        install: async () => { w.calls.push('install'); w.plugin = 'installed'; return { ...reply(true), message: 'Arcane Studio plugin installed. Restart Roblox Studio to load it.' }; },
        autoUpdate: async () => { w.calls.push('autoUpdate'); if (!w.auto) return reply(false); w.plugin = 'installed'; return { ...reply(true), message: 'Arcane updated the Studio plugin automatically. Restart Roblox Studio to load it.' }; },
        preference: async () => { w.calls.push('preference'); return { version: 1, autoUpdate: w.auto, message: '' }; },
        enableAutoUpdate: async () => { w.calls.push('enable'); w.auto = true; return { version: 1, autoUpdate: true, message: 'Arcane will update the Studio plugin automatically.' }; },
        disableAutoUpdate: async () => { w.calls.push('disable'); w.auto = false; return { version: 1, autoUpdate: false, message: 'Arcane will ask before updating the Studio plugin.' }; } });
      // Signed in: the provider gate (which hides everything above the chat) is gone.
      document.getElementById('provider-login-gate')!.hidden = true; document.getElementById('workspace-stage')!.classList.remove('provider-required');
      w.controller = m.startSetupChecklist(document, {
        provider: { isSignedIn: () => true, chatSurface: () => 'codex', selectedProvider: () => 'codex', subscribeSignInChange: sub, subscribeChatSurface: sub },
        workbench: { studioConnected: () => w.paired !== null, studioPluginCurrent: () => w.paired, subscribeStudioChange: sub, getCurrentProduct: () => ({ projectPath: 'C:\\Games\\Obby' }), subscribeProjectChange: sub },
        desktop: { studioPlugin }, storage: null, timers: { set: (fn: () => void) => { w.timers.push(fn); return w.timers.length; }, clear: () => {} } });
      w.notify = () => { for (const fn of w.listeners) fn(); };
    }, auto);
  };
  const kind = () => page.evaluate(() => (window as any).controller.pluginBanner());
  await boot(false);
  await page.waitForFunction(() => (window as any).controller.pluginBanner() === 'available');
  const banner = page.locator('#studio-plugin-banner');
  assert.match(await banner.textContent() ?? '', /Studio plugin update available/);
  assert.equal(await banner.locator('[data-plugin-banner=update]').isVisible(), true);
  assert.equal(await banner.locator('[data-plugin-banner=auto]').isVisible(), true, 'Automatic updates are offered while off.');
  assert.equal((await page.evaluate(() => (window as any).calls)).includes('autoUpdate'), false, 'Off by default: nothing installs without a click.');
  if (shots) await page.locator('.codex-panel').screenshot({ path: join(shots, 'plugin-update-banner.png') });
  // Synthetic clicks never install.
  await page.evaluate(() => (document.querySelector('#studio-plugin-banner [data-plugin-banner=update]') as HTMLButtonElement).click());
  assert.equal((await page.evaluate(() => (window as any).calls)).includes('install'), false);
  await banner.locator('[data-plugin-banner=update]').click();
  await page.waitForFunction(() => (window as any).controller.pluginBanner() === 'restart');
  assert.match(await banner.textContent() ?? '', /Restart Roblox Studio/);
  assert.deepEqual((await page.evaluate(() => (window as any).calls)).filter((c: string) => c === 'install'), ['install']);
  if (shots) await page.locator('.codex-panel').screenshot({ path: join(shots, 'plugin-update-restart.png') });
  // Studio restarts and pairs with the new plugin: a short confirmation that clears itself.
  await page.evaluate(() => { const w = window as any; w.paired = true; w.notify(); });
  assert.equal(await kind(), 'ready');
  assert.match(await banner.textContent() ?? '', /running the updated Arcane plugin/);
  await page.evaluate(() => { for (const fn of (window as any).timers.splice(0)) fn(); });
  assert.equal(await kind(), 'hidden');
  // A later pairing with an old plugin while the file is current asks for a restart, and re-reads the file once.
  const before = (await page.evaluate(() => (window as any).calls)).filter((c: string) => c === 'status').length;
  await page.evaluate(() => { const w = window as any; w.paired = false; w.notify(); });
  await page.waitForFunction((n: number) => (window as any).calls.filter((c: string) => c === 'status').length === n + 1, before);
  assert.equal(await kind(), 'stale');
  await banner.locator('[data-plugin-banner=dismiss]').click();
  assert.equal(await kind(), 'hidden', 'Not now hides it.');

  // Opt-in from the banner: the host confirms natively, then updates without another click.
  await boot(false);
  await page.waitForFunction(() => (window as any).controller.pluginBanner() === 'available');
  await banner.locator('[data-plugin-banner=auto]').click();
  await page.waitForFunction(() => (window as any).controller.pluginBanner() === 'restart');
  assert.deepEqual((await page.evaluate(() => (window as any).calls)).filter((c: string) => c !== 'status'), ['preference', 'enable', 'autoUpdate']);
  assert.equal(await page.locator('#studio-plugin-auto').isChecked(), true);
  // Saved on: the next start updates by itself; the Settings switch turns it off again.
  await boot(true);
  await page.waitForFunction(() => (window as any).calls.includes('autoUpdate') && (window as any).controller.pluginBanner() === 'restart');
  assert.match(await banner.textContent() ?? '', /Restart Roblox Studio/);
  await page.evaluate(() => (document.getElementById('settings-drawer') as HTMLDialogElement).showModal());
  await page.locator('#studio-plugin-auto').click();
  await page.waitForFunction(() => (window as any).calls.includes('disable'));
  assert.equal(await page.locator('#studio-plugin-auto').isChecked(), false);
  if (shots) await page.locator('#studio-plugin-settings').screenshot({ path: join(shots, 'settings-studio-plugin-auto.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'No horizontal overflow at phone width.');
  assert.deepEqual(errors, []);
});
