import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep, resolve, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import vm from 'node:vm';
import { createConnectionLab } from '../../apps/daemon/src/lab-server.js';
import { createAssetService } from '../../apps/daemon/src/asset-service.js';
import { StudioStore } from '../../packages/storage/src/studio-store.js';
import { WorkStore } from '../../packages/storage/src/work-store.js';
import { CodexSession } from '../../packages/codex-client/src/session.js';
import { nativeEnvironment } from '../../packages/codex-client/src/transport.js';
import { limits } from '../../packages/codex-client/src/validation.js';
import { ARCANE_NATIVE_TOOL_NAMES } from '../../packages/protocol/src/arcane-tools.js';
// Owned scripted Codex app-server peer: metadata only, never a turn (no Send happens in this test).
const CODEX_PEER = String.raw`
const{createInterface}=require('node:readline');const c=JSON.parse(process.argv[1]);const send=v=>process.stdout.write(JSON.stringify(v)+'\n');
createInterface({input:process.stdin}).on('line',line=>{const{id,method,params={}}=JSON.parse(line);if(!method||method==='initialized')return;const reply=result=>send({id,result});
if(method==='initialize')return reply({});
if(method==='account/read')return reply({account:{type:'chatgpt',email:'boot@example.invalid',planType:'plus'},requiresOpenaiAuth:true});
if(method==='model/list')return reply({data:[{id:'fixture',model:'fixture',displayName:'Fixture',supportedReasoningEfforts:[{reasoningEffort:'low'}]}],nextCursor:null});
if(method==='thread/start'||method==='thread/resume')return reply({thread:{id:'boot.thread',sessionId:'boot.session',turns:[],status:{type:'idle'}},model:params.model,modelProvider:'openai',cwd:process.cwd(),approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:{type:'readOnly',networkAccess:false}});
if(method==='mcpServerStatus/list')return reply({data:[{name:'arcane',runtimeStatus:'connected',toolsError:null,pluginId:null,tools:Object.fromEntries(c.tools.map(n=>[n,{}]))}],nextCursor:null});
if(method==='thread/list')return reply({data:[],nextCursor:null});
throw Error('Unexpected fixture method '+method);});`;

// ACTUAL product boot: createConnectionLab delivers studio.html/studio.js/native-handoff.js from the product root, real
// Edge renders it, and real fetch reaches the actual handoff routes. The desktop side is ACTUAL where possible:
// provider-setup.cjs (its native CLI, PowerShell and dialog are SCRIPTED fakes: no process is spawned), the actual
// native-handoff-host.cjs broker with its real preparer on owned temp paths, the actual native-handoff-ipc.cjs and
// the actual preload.cjs evaluated in an isolated VM. The page reaches the preload API only through one OWNED
// exposed function; the human control token and the scoped credential are never passed into page code by this bridge.
// No installed CLI, provider, terminal, Studio, Electron app or package is exercised.
const productRoot = process.cwd(), cjs = createRequire(join(productRoot, 'package.json'));
const { createProviderSetup } = cjs('./apps/desktop/electron/provider-setup.cjs');
const { createNativeHandoffHost } = cjs('./apps/desktop/electron/native-handoff-host.cjs');
const { installNativeHandoffIpc } = cjs('./apps/desktop/electron/native-handoff-ipc.cjs');
const preloadSource = readFileSync(join(productRoot, 'apps/desktop/electron/preload.cjs'), 'utf8');
const HELP = ['Usage: claude [options] [command] [prompt]', '', 'Options:',
  '  --effort <level>                      Effort level for the current session', '                                        (low, medium, high, xhigh, max)',
  '  --model <model>                       Model for the current session. Provide', "                                        an alias for the latest model (e.g.",
  "                                        'fable', 'opus', or 'sonnet') or a", "                                        model's full name (e.g. 'claude-fable-5').",
  '  -n, --name <name>                     Set a display name', ''].join('\n');
const unhandled: unknown[] = []; process.on('unhandledRejection', error => { unhandled.push(error); });
async function until(check: () => boolean | Promise<boolean>, what: string, ms = 15000) { const end = Date.now() + ms; while (!await check()) { assert.ok(Date.now() < end, 'Expected ' + what); await delay(10); } }

async function fixture(t: TestContext) {
  const base = await realpath(tmpdir()), root = await realpath(await mkdtemp(join(base, 'arcane-handoff-boot-')));
  const project = join(root, 'project'), runtimeDirectory = join(root, 'native-handoffs'), bin = join(root, 'bin');
  for (const dir of [project, runtimeDirectory, bin]) await mkdir(dir);
  const nodePath = join(bin, 'node.exe'), mcpEntry = join(bin, 'main.js'); await writeFile(nodePath, 'not executed'); await writeFile(mcpEntry, 'not executed');
  const studio = new StudioStore({ directory: join(root, 'studio') }), work = new WorkStore({ directory: join(root, 'work'), projectPath: project });
  const assets = await createAssetService({ cwd: productRoot, projectPath: project, outputRoot: join(root, 'assets') });
  // REQUIRED: an owned scripted CodexSession peer. Without codexConnect the lab's default factory would locate and start an
  // installed Codex when the renderer auto-connects a saved login. Every connect must reach this peer.
  const codexConnects: string[] = [], codexClients: CodexSession[] = [];
  const lab = await createConnectionLab({ cwd: productRoot, stateDirectory: join(root, 'lab'), projectPath: project, studioStore: studio, workStore: work, assetService: assets,
    codexConnect: async hooks => {
      codexConnects.push('owned-peer');
      const client = new CodexSession({ command: process.execPath, args: ['-e', CODEX_PEER, JSON.stringify({ tools: ARCANE_NATIVE_TOOL_NAMES })], cwd: project, env: nativeEnvironment() },
        limits({ requestTimeoutMs: 2000 }), 'spawned-node-fixture', 'arcane-only', hooks);
      codexClients.push(client); await client.initialize(); return client;
    } });
  // SCRIPTED native CLI/PowerShell/dialog for the ACTUAL provider-setup module (fake fs + spawn; no process).
  const home = 'C:\\Users\\fixture', tools = 'C:\\Tools', system = 'C:\\Windows', claude = win32.join(tools, 'claude.exe');
  const powershell = win32.join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const entries = new Map<string, { full: string; kind: string }>(), key = (v: string) => win32.normalize(v).toLowerCase();
  const put = (value: string, kind = 'directory') => { let dir = win32.dirname(value); while (dir !== win32.dirname(dir)) { entries.set(key(dir), { full: dir, kind: 'directory' }); dir = win32.dirname(dir); } entries.set(key(dir), { full: dir, kind: 'directory' }); entries.set(key(value), { full: win32.normalize(value), kind }); };
  // Scripted sign-in metadata lets the onboarding gate connect to the owned peer and open the workspace.
  const codex = win32.join(tools, 'codex.exe');
  for (const dir of [home, tools, project]) put(dir); put(claude, 'file'); put(codex, 'file'); put(powershell, 'file');
  const get = (v: string) => { const entry = entries.get(key(v)); if (!entry) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return entry; };
  const fs = { async realpath(v: string) { return get(v).full; }, async stat(v: string) { const e = get(v); return { isFile: () => e.kind === 'file', isDirectory: () => e.kind === 'directory', mode: 0o755 }; },
    async opendir() { throw Object.assign(new Error('none'), { code: 'ENOENT' }); } };
  const spawned: { command: string; args: string[]; env: Record<string, string> }[] = [], dialogs: string[] = [];
  const control = { launcherHold: null as Promise<void> | null };
  const spawn = (command: string, args: string[], options: { env: Record<string, string> }) => {
    spawned.push({ command, args: [...args], env: { ...options.env } });
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill() {} });
    void (async () => {
      await Promise.resolve();
      if (command === powershell && control.launcherHold) await control.launcherHold;
      const isCodex = command === codex;
      const out = command === powershell ? '' : args[0] === '--version' ? (isCodex ? 'codex-cli 0.143.0\n' : '2.1.177 (Claude Code)\n') : args.join(' ') === 'auth status --json' ?
        JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }) : args[0] === '--help' ? HELP : '';
      if (out) child.stdout.emit('data', Buffer.from(out));
      if (isCodex && args.join(' ') === 'login status') child.stderr.emit('data', Buffer.from('Logged in using ChatGPT\n'));
      child.emit('close', 0);
    })();
    return child;
  };
  const frame = { url: lab.origin + '/studio' }, contents = { isDestroyed: () => false, mainFrame: frame }, window = { isDestroyed: () => false, webContents: contents };
  const providerSetup = createProviderSetup({ getWindow: () => window, getOrigin: () => lab.origin, getProjectPath: () => project, fs, spawn, platform: 'win32', arch: 'x64',
    homedir: () => home, env: { PATH: tools, SystemRoot: system, USERPROFILE: home }, timeoutMs: 5000,
    dialog: { async showMessageBox(_w: unknown, config: { detail: string }) { dialogs.push(config.detail); return { response: 1 }; } } });
  // Actual broker, composed like main.cjs, with the real preparer and owned paths.
  const epoch = Object.freeze({});
  const broker = createNativeHandoffHost({
    getSession: () => ({ projectPath: project, runtimeDirectory, nodePath, mcpEntry, origin: lab.origin, controlToken: lab.token, epoch }),
    getChoices: () => providerSetup.getHandoffChoices(), confirm: (p: unknown, s: unknown) => providerSetup.confirmHandoff(p, s),
    launchTerminal: (r: unknown) => providerSetup.launchHandoffTerminal(r) });
  // ACTUAL human IPC adapter and ACTUAL preload in an isolated VM; provider IPC mirrors main's handler body (frame checks shown via the handoff IPC).
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>();
  installNativeHandoffIpc({ handle: (channel: string, fn: any) => handlers.set(channel, fn) }, { getSession: () => ({ window, origin: lab.origin, epoch }), host: broker });
  let exposed: any = null;
  // Electron IPC structured-clones across the renderer/main boundary; emulate that with plain-data copies into each realm.
  const ipcCopy = (value: unknown) => value === undefined ? value : JSON.parse(JSON.stringify(value));
  const preloadContext = vm.createContext({ require(name: string) { assert.equal(name, 'electron'); return {
    contextBridge: { exposeInMainWorld(name: string, api: unknown) { assert.equal(name, 'arcaneDesktop'); exposed = api; } },
    ipcRenderer: { async invoke(channel: string, ...rendererArgs: unknown[]) {
      const args = rendererArgs.map(ipcCopy);
      const reply = channel.startsWith('arcane:native-handoff-') ? await handlers.get(channel)!({ sender: contents, senderFrame: frame }, ...args) :
        channel.startsWith('arcane:provider-') ? await providerSetup[channel.slice('arcane:provider-'.length)](args[0]) : assert.fail('unexpected channel ' + channel);
      return toPreload(reply);
    } } }; } });
  const preloadJson = vm.runInContext('JSON', preloadContext), toPreload = (value: unknown) => value === undefined ? value : preloadJson.parse(JSON.stringify(value));
  vm.runInContext(preloadSource, preloadContext, { filename: 'preload.cjs' });
  assert.ok(exposed?.providerSetup && exposed?.nativeHandoff, 'actual preload exposes both bridges');
  t.after(async () => {
    for (const close of [() => broker.dispose(), () => providerSetup.dispose(), () => lab.close(), ...codexClients.map(c => () => c.close()), () => assets.close(), () => work.close(), () => studio.close()]) try { await close(); } catch { /* owned cleanup */ }
    const part = relative(base, root); assert.ok(part.startsWith('arcane-handoff-boot-') && !isAbsolute(part) && !part.includes(sep)); await rm(root, { recursive: true, force: true });
  });
  const call = async (token: string, path: string, body?: unknown) => {
    const response = await fetch(lab.origin + path, { method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(10000),
      headers: { Authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: lab.origin }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text(); let parsed: any = {}; try { parsed = JSON.parse(text); } catch { /* non-JSON */ } return { status: response.status, body: parsed, text };
  };
  const credentials = () => spawned.filter(s => s.command === powershell && s.env.ARCANE_LOCAL_TOKEN).map(s => s.env.ARCANE_LOCAL_TOKEN!);
  return { codexClients, lab, work, studio, exposed, toPreload, spawned, dialogs, control, call, credentials, runtimeDirectory, powershell, codexConnects };
}

const browserModule = process.env.ARCANE_UI_BROWSER_MODULE;
test('owned Windows Edge: actual product boot launches a scoped handoff and user revoke retires it',
  { skip: !browserModule || process.platform !== 'win32', timeout: 90000 }, async t => {
  const f = await fixture(t);
  const { chromium } = await import(pathToFileURL(resolve(browserModule!)).href) as typeof import('playwright-core');
  const browser = await chromium.launch({ headless: true, ...(process.env.ARCANE_UI_BROWSER_EXE ? { executablePath: process.env.ARCANE_UI_BROWSER_EXE } : {}) }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }), errors: string[] = [], csp: string[] = [], modules: string[] = [];
  page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (/Content Security Policy/i.test(message.text())) csp.push(message.text()); });
  page.on('response', response => { const path = new URL(response.url()).pathname; if (/\.js$/.test(path)) modules.push(path + ' ' + response.status()); });
  // OWNED bridge: one exposed function forwarding to the actual preload API (results are its own validated replies).
  // contextBridge copies page arguments into the preload realm; do the same with plain-data copies.
  await page.exposeFunction('__arcaneOwnedBridge', async (namespace: string, method: string, args: unknown[]) => f.exposed[namespace][method](...args.map(f.toPreload)));
  const shape = { providerSetup: Object.keys(f.exposed.providerSetup), nativeHandoff: Object.keys(f.exposed.nativeHandoff) };
  await page.addInitScript((keys: Record<string, string[]>) => {
    const w = window as any; w.__arcaneLaunchReplies = 0;
    const wrap = (namespace: string) => Object.freeze(Object.fromEntries(keys[namespace]!.map(name => [name,
      name === 'version' ? 1 : async (...args: unknown[]) => {
        try { return await w.__arcaneOwnedBridge(namespace, name, args); }
        finally { if (namespace === 'nativeHandoff' && name === 'launch') w.__arcaneLaunchReplies++; }
      }])));
    Object.defineProperty(window, 'arcaneDesktop', { value: Object.freeze({ version: '0.1.0', platform: 'win32', runtime: 'desktop', providerSetup: wrap('providerSetup'), nativeHandoff: wrap('nativeHandoff') }), enumerable: true });
  }, shape);
  await page.goto(f.lab.origin + '/studio#' + f.lab.token);
  await page.locator('#provider-setup-provider').waitFor({ state: 'attached' });
  assert.ok(modules.some(m => m === '/native-handoff.js 200'), 'actual native-handoff module delivered by the lab: ' + modules.join(', '));
  // Settings > General: choose Claude and read its status through the actual preload/provider-setup chain.
  await page.locator('[data-workspace-target="workspace-settings"]:visible').first().click();
  await page.waitForFunction(() => (document.getElementById('settings-drawer') as HTMLDialogElement).open);
  // The provider select only honours trusted input, so use real keyboard selection (Codex -> Claude).
  await page.locator('#provider-setup-provider').focus(); await page.keyboard.press('ArrowDown');
  await page.waitForFunction(() => (document.getElementById('provider-setup-provider') as HTMLSelectElement).value === 'claude');
  await page.locator('#provider-setup-refresh').click();
  await until(async () => /signed in|ready|subscription/i.test(await page.locator('#provider-setup-status').innerText()) || f.spawned.some(s => s.args[0] === '--help'), 'Claude status read');
  await page.getByRole('button', { name: 'Connections' }).click();
  const model = page.locator('#native-handoff-model'), effort = page.locator('#native-handoff-effort'), launch = page.locator('#native-handoff-launch');
  await page.waitForFunction(() => (document.getElementById('native-handoff-model') as HTMLSelectElement).options.length > 1);
  assert.deepEqual([await model.inputValue(), await effort.inputValue(), await launch.isDisabled()], ['', '', true], 'explicit blank selections, launch disabled');
  assert.deepEqual(await model.locator('option').allInnerTexts(), ['Choose model', 'fable', 'opus', 'sonnet']);
  await model.selectOption('opus'); await effort.selectOption('high'); assert.equal(await launch.isEnabled(), true);
  await launch.click();
  await until(async () => /Terminal opened with Arcane tools configured/.test(await page.locator('#native-handoff-status').innerText()), 'opened status');
  assert.match(await page.locator('#native-handoff-status').innerText(), /Confirm the connection in the terminal/);
  // Node host side: exactly one sealed handoff on the actual daemon; the dialog showed the exact selection.
  const listed = await f.call(f.lab.token, '/v1/native-handoffs'); assert.deepEqual(listed.body.handoffs.map((h: any) => h.state), ['sealed']);
  assert.equal(f.dialogs.length, 1); assert.match(f.dialogs[0]!, /model opus and effort high/);
  const [credential] = f.credentials(); assert.ok(credential, 'the scoped credential reached only the scripted launcher env');
  const launcher = f.spawned.find(s => s.command === f.powershell)!;
  assert.ok(!JSON.stringify(launcher.args).includes(credential!), 'credential absent from launcher argv');
  const pageText = await page.evaluate(() => document.documentElement.outerHTML + JSON.stringify(localStorage) + JSON.stringify(sessionStorage));
  assert.ok(!pageText.includes(credential!), 'credential never reached page code');
  assert.equal((await f.call(credential!, '/v1/work/runs')).status, 200, 'scoped bearer: allowed work route');
  for (const [path, body] of [['/v1/work/review', { taskId: '00000000-0000-4000-8000-000000000000', approved: true, note: 'x' }], ['/v1/product/mcp-token', {}], ['/v1/native-handoffs', undefined], ['/v1/codex/state', undefined]] as const) {
    const reply = await f.call(credential!, path, body); assert.ok(reply.status === 401 || reply.status === 403, path + ' -> ' + reply.status);
  }
  assert.equal((await readdir(f.runtimeDirectory)).length, 1, 'one owned per-launch config directory');
  // The user revokes from the actual list UI.
  const row = page.getByRole('button', { name: /^Revoke handoff / }); await row.waitFor(); await row.click();
  await until(async () => /Handoff revoked/.test(await page.locator('#native-handoff-status').innerText()), 'revoked status');
  assert.equal((await f.call(credential!, '/v1/work/runs')).status, 401, 'revoked bearer retired');
  assert.deepEqual(await readdir(f.runtimeDirectory), [], 'owned config removed');
  assert.deepEqual((await f.call(f.lab.token, '/v1/native-handoffs')).body.handoffs.map((h: any) => h.state), ['revoked']);
  // pagehide while a launch reply is held: the stale reply never updates the page or triggers a follow-up read.
  let release!: () => void; f.control.launcherHold = new Promise<void>(done => { release = done; });
  await model.selectOption('sonnet'); await effort.selectOption('max'); await launch.click();
  await until(() => f.spawned.filter(s => s.command === f.powershell).length === 2, 'second launcher held');
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  const before = await page.locator('#native-handoff-status').innerText(); release(); f.control.launcherHold = null;
  await until(async () => (await f.call(f.lab.token, '/v1/native-handoffs')).body.handoffs.some((h: any) => h.state === 'sealed'), 'held launch completed host-side');
  await page.waitForFunction(() => (window as any).__arcaneLaunchReplies === 2);
  assert.equal(await page.locator('#native-handoff-status').innerText(), before, 'the held reply after pagehide did not update the page');
  assert.ok(!/Terminal opened/.test(before));
  assert.ok(f.codexConnects.length >= 1 && f.codexConnects.every(c => c === 'owned-peer'), 'every Codex connection reached the injected owned peer');
  assert.equal(f.codexClients.flatMap(c => c.snapshot().operations).filter(op => op.method === 'turn/start').length, 0, 'no native turn or inference');
  assert.equal(f.studio.commands().length, 0, 'no Studio command'); assert.deepEqual(errors, []); assert.deepEqual(csp, []); assert.deepEqual(unhandled, []);
  t.diagnostic('Actual lab route delivery + product boot in real Edge ' + browser.version() + '; actual preload/IPC/broker/preparer/provider-setup with scripted CLI/PowerShell/dialog.');
});
