import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checklistRows, checklistVisible, isStarterProject, readChecklistMemory, readPluginStatus, SETUP_CHECKLIST_KEY, type ChecklistSignals } from '../../apps/desktop/src/setup-checklist.js';

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

  // Later hides only for this page; Hide checklist persists; all green completes and auto-hides for good.
  await page.locator('#setup-checklist-later').click();
  assert.equal(await page.locator('#setup-checklist').isVisible(), false);
  assert.equal(await page.evaluate((k: string) => localStorage.getItem(k), SETUP_CHECKLIST_KEY), null);
  await boot();
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
