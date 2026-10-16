/// <reference lib="dom" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { setImmediate as tick } from 'node:timers/promises';
import {
  startDesktopVerification, DESKTOP_VERIFICATION_DIRECTORY_BYTES,
  type DesktopVerificationOptions, type DesktopVerificationState,
} from '../../apps/desktop/src/desktop-verification.js';

const PROJECT = 'a'.repeat(64), OTHER = 'b'.repeat(64);
const state = (changes: Partial<DesktopVerificationState> = {}): DesktopVerificationState =>
  ({ version: 1, projectId: PROJECT, configured: false, pendingRestart: false, evidenceDirectory: null, cancelled: false, ...changes });
function deferred() {
  let resolve!: (value: unknown) => void, reject!: (error: unknown) => void;
  const promise = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Explicit DOM fixture. emit invokes captured listeners with trusted-shaped data;
 * dispatchEvent uses genuine untrusted Event instances. No native dialog/IPC runs.
 */
class ElementFixture {
  textContent = ''; disabled = true; hidden = false;
  private attributes = new Map<string, string>();
  private listeners = new Map<string, EventListener[]>();
  get innerHTML(): never { throw new Error('HTML sink forbidden'); }
  set innerHTML(_value: string) { throw new Error('HTML sink forbidden'); }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  addEventListener(type: string, fn: EventListener): void { this.listeners.set(type, [...this.listeners.get(type) ?? [], fn]); }
  removeEventListener(type: string, fn: EventListener): void { this.listeners.set(type, (this.listeners.get(type) ?? []).filter(f => f !== fn)); }
  emit(type = 'click', changes: Record<string, unknown> = {}) {
    const event = { type, isTrusted: true, button: 0, detail: 1, target: this, currentTarget: this,
      defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...changes };
    for (const fn of this.listeners.get(type) ?? []) fn(event as unknown as Event);
    return event;
  }
  dispatchEvent(event: Event): void { for (const fn of this.listeners.get(event.type) ?? []) fn(event); }
}
interface Call { action: 'status' | 'configure'; args: unknown[] }
interface FixtureOptions {
  bridge?: unknown;
  view?: object;
  projectId?: string | null;
  options?: (options: DesktopVerificationOptions) => DesktopVerificationOptions;
  missingMount?: boolean;
}
function fixture(t: test.TestContext, settings: FixtureOptions = {}) {
  const elements = new Map(['desktop-verification', 'desktop-verification-status', 'desktop-verification-notice',
    'desktop-verification-evidence', 'desktop-verification-setup', 'desktop-verification-refresh'].map(id => [id, new ElementFixture()]));
  if (settings.missingMount) elements.delete('desktop-verification');
  const calls: Call[] = [];
  let handler = (_call: Call): Promise<unknown> => Promise.resolve(state());
  const invoke = (action: Call['action'], args: unknown[]) => { const call = { action, args }; calls.push(call); return handler(call); };
  const bridge = Object.freeze({
    version: 1, status: (...args: unknown[]) => invoke('status', args), configure: (...args: unknown[]) => invoke('configure', args),
  });
  let projectId = settings.projectId === undefined ? PROJECT : settings.projectId;
  const listeners = new Set<() => void>();
  const options: DesktopVerificationOptions = {
    getProjectId: () => projectId,
    subscribeProjectChange: fn => { listeners.add(fn); return () => { listeners.delete(fn); }; },
  };
  if (Object.hasOwn(settings, 'bridge')) options.nativeBridge = settings.bridge;
  const doc = { defaultView: settings.view ?? { arcaneDesktop: Object.freeze({ codeVerification: bridge }) },
    getElementById: (id: string) => elements.get(id) ?? null };
  Object.defineProperty(doc.defaultView, 'fetch', { get() { assert.fail('Verification UI must never read fetch'); } });
  const controller = startDesktopVerification(doc as unknown as Document, settings.options?.(options) ?? options);
  t.after(() => controller.cleanup());
  const el = (name: string): ElementFixture => { const value = elements.get('desktop-verification-' + name); assert.ok(value); return value; };
  const idle = async () => {
    for (let i = 0; i < 30; i++) { await tick(); if (elements.get('desktop-verification')?.getAttribute('aria-busy') !== 'true') return; }
    assert.fail('Fixture native request remained in flight');
  };
  return { controller, calls, bridge, doc, el, listeners,
    handler(next: typeof handler) { handler = next; },
    change(id: string | null, announce = true) { projectId = id; if (announce) for (const fn of listeners) fn(); },
    async click(name: 'setup' | 'refresh', changes: Record<string, unknown> = {}) { el(name).emit('click', changes); await idle(); },
    idle,
  };
}

test('mount/resume/project notifications are metadata-only; only explicit trusted-shaped refresh reads status', async t => {
  const f = fixture(t);
  assert.equal(f.calls.length, 0); assert.match(f.el('status').textContent, /has not been read/);
  f.controller.resume(); f.change(OTHER); f.change(PROJECT); assert.equal(f.calls.length, 0);
  f.el('refresh').dispatchEvent(new Event('click', { cancelable: true })); await tick();
  assert.equal(f.calls.length, 0);
  await f.click('refresh'); assert.deepEqual(f.calls, [{ action: 'status', args: [] }]);
  assert.match(f.el('status').textContent, /No Luau verification configuration/);
  assert.equal(f.el('setup').disabled, false);
});

test('browser absence, unsupported/malformed/getter/proxy bridges fail closed without invoking methods or getters', async t => {
  let getterReads = 0, methods = 0;
  const method = () => { methods++; return Promise.resolve(state()); };
  const accessor = Object.freeze({ version: 1, get status() { getterReads++; return method; }, configure: method });
  const revoked = Proxy.revocable(Object.freeze({ version: 1, status: method, configure: method }), {}); revoked.revoke();
  const bridges = [undefined, null, {}, [], 'bridge', Object.freeze({ version: 2, status: method, configure: method }),
    { version: 1, status: method, configure: method }, accessor,
    Object.freeze({ version: 1, status: method, configure: 'bad' }),
    Object.freeze({ version: 1, status: method, configure: method, path: 'forbidden' }),
    Object.freeze(Object.create({ version: 1, status: method, configure: method })),
    new Proxy({}, { get() { getterReads++; throw new Error('get trap'); }, ownKeys() { throw new Error('keys trap'); } }), revoked.proxy];
  for (const bridge of bridges) {
    const f = fixture(t, { bridge }); f.controller.resume();
    await f.click('refresh'); await f.click('setup');
    assert.match(f.el('status').textContent, /CLI-only.*unavailable/);
    assert.equal(f.el('setup').disabled, true); assert.equal(f.el('refresh').disabled, true);
  }
  const view = Object.defineProperty({}, 'arcaneDesktop', { get() { getterReads++; return {}; } });
  const f = fixture(t, { view }); await f.click('setup');
  const g = fixture(t, { options: options => Object.defineProperty(options, 'nativeBridge', {
    get() { getterReads++; return Object.freeze({ version: 1, status: method, configure: method }); },
  }) }); await g.click('setup');
  assert.equal(getterReads, 0); assert.equal(methods, 0);
});

test('missing owned mount is inert; invalid/unavailable trusted project identity disables native actions', async t => {
  const missing = fixture(t, { missingMount: true }); missing.controller.stop(); missing.controller.resume();
  assert.equal(missing.calls.length, 0); assert.equal(missing.listeners.size, 0);
  for (const id of [null, '', 'A'.repeat(64), PROJECT + '\n', 'c'.repeat(63), 'c'.repeat(65)]) {
    const f = fixture(t, { projectId: id }); await f.click('setup'); await f.click('refresh');
    assert.equal(f.calls.length, 0); assert.match(f.el('status').textContent, /Project identity unavailable/);
  }
  const failed = fixture(t, { options: options => ({ ...options, getProjectId() { throw new Error('private project error'); } }) });
  assert.doesNotMatch(failed.el('status').textContent, /private/); assert.equal(failed.calls.length, 0);
});

test('configure accepts only trusted primary/unmodified clicks; native keyboard click is allowed and unsafe key repeats are prevented', async t => {
  const f = fixture(t);
  f.el('setup').dispatchEvent(new Event('click', { cancelable: true }));
  for (const changes of [{ isTrusted: false }, { isTrusted: 1 }, { button: 1 }, { button: 2 }, { altKey: true },
    { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { defaultPrevented: true }]) f.el('setup').emit('click', changes);
  for (const key of ['Enter', ' ']) {
    for (const changes of [{ isTrusted: false }, { repeat: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true }])
      assert.equal(f.el('setup').emit('keydown', { key, ...changes }).defaultPrevented, true);
    assert.equal(f.el('setup').emit('keydown', { key, repeat: false }).defaultPrevented, false);
  }
  assert.equal(f.calls.length, 0);
  f.handler(async () => state({ configured: true, pendingRestart: true, evidenceDirectory: 'evidence/luau' }));
  await f.click('setup', { detail: 0 });
  assert.deepEqual(f.calls, [{ action: 'configure', args: [] }]);
  assert.match(f.el('status').textContent, /next manual restart/);
  assert.match(f.el('evidence').textContent, /evidence\/luau/);
  assert.doesNotMatch(f.el('status').textContent, /compiler ready|workflow complete|verification passed/i);
});

test('all native actions share one flight across duplicate clicks, project switches, pagehide and resume', async t => {
  const f = fixture(t), pending = deferred(); f.handler(() => pending.promise);
  f.el('setup').emit(); f.el('setup').emit(); f.el('refresh').emit();
  assert.deepEqual(f.calls, [{ action: 'configure', args: [] }]);
  assert.equal(f.el('setup').disabled, true); assert.equal(f.el('refresh').disabled, true);
  f.change(OTHER); f.el('setup').emit(); f.controller.stop(); assert.equal(f.listeners.size, 0);
  f.controller.resume(); assert.equal(f.listeners.size, 1); f.el('setup').emit(); f.el('refresh').emit();
  assert.equal(f.calls.length, 1);
  pending.resolve(state({ configured: true, pendingRestart: true, evidenceDirectory: 'old/evidence' })); await f.idle();
  assert.doesNotMatch(f.el('status').textContent, /saved|recorded|restart/);
  assert.equal(f.el('evidence').textContent, '');
  f.handler(async () => state({ projectId: OTHER })); await f.click('refresh');
  assert.equal(f.calls.length, 2);
});

test('generation discards delayed status/configure success, cancellation and error through project A → B → A', async t => {
  for (const action of ['refresh', 'setup'] as const) for (const outcome of ['success', 'cancelled', 'error']) {
    const f = fixture(t), pending = deferred(); f.handler(() => pending.promise);
    f.el(action).emit(); f.change(OTHER); f.change(PROJECT);
    if (outcome === 'error') pending.reject(new Error('secret absolute path'));
    else pending.resolve(state({ configured: true, pendingRestart: true, evidenceDirectory: 'old/evidence', cancelled: outcome === 'cancelled' }));
    await f.idle(); assert.equal(f.calls.length, 1);
    assert.match(f.el('status').textContent, /has not been read/);
    assert.equal(f.el('evidence').textContent, ''); assert.equal(f.el('notice').textContent, '');
  }
});

test('callback changes without notifications are checked before actions and responses; detached state is not mutable by host', async t => {
  const f = fixture(t); f.change(OTHER, false); f.handler(async () => state({ projectId: OTHER }));
  await f.click('refresh'); assert.equal(f.calls.length, 1);
  const pending = deferred(); f.handler(() => pending.promise); f.el('refresh').emit(); f.change(PROJECT, false);
  pending.resolve(state({ projectId: OTHER, configured: true, evidenceDirectory: 'other/evidence' })); await f.idle();
  assert.match(f.el('status').textContent, /has not been read/);
  const returned = { ...state({ configured: true, evidenceDirectory: 'this/evidence' }) };
  f.handler(async () => returned); await f.click('refresh'); returned.evidenceDirectory = 'changed/evidence';
  f.el('setup').emit('click', { isTrusted: false });
  assert.equal(f.el('evidence').textContent, 'Evidence folder: this/evidence');
});

test('valid configure cancellation retains prior observed status/evidence; cancellation without observation never invents state', async t => {
  const f = fixture(t); f.handler(async () => state({ configured: true, evidenceDirectory: 'prior/evidence' }));
  await f.click('refresh'); const prior = f.el('status').textContent;
  f.handler(async () => state({ configured: false, evidenceDirectory: null, cancelled: true }));
  await f.click('setup'); assert.equal(f.el('status').textContent, prior);
  assert.equal(f.el('evidence').textContent, 'Evidence folder: prior/evidence');
  assert.match(f.el('notice').textContent, /cancelled.*retained/);
  const g = fixture(t); g.handler(async () => state({ configured: true, pendingRestart: true, evidenceDirectory: 'cancelled/evidence', cancelled: true }));
  await g.click('setup'); assert.match(g.el('status').textContent, /has not been read/); assert.equal(g.el('evidence').textContent, '');
});

test('errors and synchronous failures are generic, never retried; configure requires an explicit successful status refresh after failure', async t => {
  for (const synchronous of [false, true]) {
    const f = fixture(t), sensitive = 'C:/secret/compiler.exe bearer=' + PROJECT;
    f.handler(() => { if (synchronous) throw new Error(sensitive); return Promise.reject(new Error(sensitive)); });
    await f.click('setup'); assert.equal(f.calls.length, 1); assert.equal(f.el('setup').disabled, true);
    assert.match(f.el('status').textContent, /unavailable/); assert.doesNotMatch(f.el('notice').textContent, /secret|bearer/);
    await f.click('setup'); f.controller.resume(); await tick(); assert.equal(f.calls.length, 1);
    await f.click('refresh'); assert.equal(f.calls.length, 2); assert.equal(f.el('setup').disabled, true);
    f.handler(async () => state()); await f.click('refresh'); assert.equal(f.el('setup').disabled, false);
    await f.click('setup'); assert.equal(f.calls.filter(c => c.action === 'configure').length, 2);
  }
});

test('exact response project/version/booleans/data descriptors and configured-evidence consistency fail closed', async t => {
  let getterReads = 0;
  const withGetter = Object.defineProperty({ ...state() }, 'configured', { enumerable: true, get() { getterReads++; return true; } });
  const cases: unknown[] = [null, [], {}, { ...state(), version: 2 }, { ...state(), projectId: OTHER },
    { ...state(), projectId: PROJECT + '\n' }, { ...state(), configured: 1 }, { ...state(), pendingRestart: 'false' },
    { ...state(), cancelled: null }, { ...state(), extra: true }, { ...state(), [Symbol('extra')]: true },
    { ...state(), configured: false, evidenceDirectory: 'evidence' }, { ...state(), configured: true, evidenceDirectory: null },
    withGetter, Object.create(state()), new Proxy({}, { ownKeys() { throw new Error('malformed proxy'); } })];
  for (const value of cases) {
    const f = fixture(t); f.handler(async () => value); await f.click('refresh');
    assert.match(f.el('status').textContent, /unavailable/); assert.equal(f.el('setup').disabled, true);
    assert.equal(f.el('evidence').textContent, ''); assert.equal(f.calls.length, 1);
  }
  assert.equal(getterReads, 0);
  const cancelled = fixture(t); cancelled.handler(async () => state({ cancelled: true }));
  await cancelled.click('refresh'); assert.match(cancelled.el('status').textContent, /unavailable/);
  assert.doesNotMatch(cancelled.el('notice').textContent, /retained/);
});

test('directory metadata uses the exact host 245-byte canonical/private-path bounds', async t => {
  assert.equal(DESKTOP_VERIFICATION_DIRECTORY_BYTES, 245);
  const invalid = ['', '.', '..', '/evidence', '//server/share', 'C:/evidence', 'C:evidence', 'evidence\\luau', 'evidence//luau',
    'evidence/../luau', 'evidence/./luau', 'evidence/', 'evidence/name.', 'evidence/name ', 'evidence/CON.txt', 'evidence/LPT9',
    'evidence\0luau', 'evidence/\u202esecret', 'evidence/\ud800', '<img>', 'https://example.com',
    'ｒｕｎｔｉｍｅ/evidence', 'e'.repeat(246), 'é'.repeat(123), '.GIT/evidence', '.CoDeX/evidence', '.claude-code/evidence',
    '.agents/evidence', '.env.local/evidence', 'credentials/evidence', 'runtime/evidence', 'workflow-human-receipts/evidence',
    'evidence/auth.json', 'evidence/token.json', 'evidence/config.toml', 'evidence/id_rsa', 'evidence/key.pem', 'evidence/secret.sqlite-wal'];
  for (const directory of invalid) {
    const f = fixture(t); f.handler(async () => state({ configured: true, evidenceDirectory: directory }));
    await f.click('refresh'); assert.match(f.el('status').textContent, /unavailable/, JSON.stringify(directory));
    assert.equal(f.el('evidence').textContent, '');
  }
  for (const directory of ['evidence/luau', 'e'.repeat(245), 'é'.repeat(122) + 'e']) {
    const f = fixture(t); f.handler(async () => state({ configured: true, evidenceDirectory: directory }));
    await f.click('refresh'); assert.equal(f.el('evidence').textContent, 'Evidence folder: ' + directory);
  }
});

test('stop/cleanup removes subscriptions and listeners, discards in-flight responses and never auto-reads on resume', async t => {
  const f = fixture(t), pending = deferred(); f.handler(() => pending.promise); f.el('setup').emit();
  f.controller.stop(); assert.equal(f.listeners.size, 0); f.controller.resume(); assert.equal(f.calls.length, 1);
  pending.resolve(state({ configured: true, pendingRestart: true, evidenceDirectory: 'late/evidence' })); await f.idle();
  assert.match(f.el('status').textContent, /has not been read/);
  f.controller.cleanup(); assert.equal(f.listeners.size, 0); f.controller.resume();
  f.el('setup').emit(); f.el('refresh').emit(); assert.equal(f.calls.length, 1);
});

test('real markup is a closed accessible group with honest syntax-only help, native buttons and inherited reference palette', async () => {
  const html = await readFile('apps/desktop/public/studio.html', 'utf8');
  const block = html.match(/<details class="settings-group" id="code-verification-settings">[\s\S]*?<\/details>/)?.[0];
  assert.ok(block); assert.doesNotMatch(block.split('>')[0]!, /\bopen\b/);
  assert.match(block, /<summary id="desktop-verification-heading">Code verification<\/summary>/);
  assert.match(block, /aria-labelledby="desktop-verification-heading"/);
  assert.match(block, /role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(block, /Type, security and regression checks are unsupported/);
  assert.match(block, /next manual restart/); assert.match(block, /does not confirm compiler readiness or workflow completion/);
  assert.equal((block.match(/type="button"/g) ?? []).length, 2);
  assert.equal((block.match(/aria-describedby="desktop-verification-help" disabled/g) ?? []).length, 2);
  assert.doesNotMatch(block, /<input|<form|badge|eyebrow|type="file"/);
  const css = await readFile('apps/desktop/public/studio.css', 'utf8');
  assert.match(css, /\.desktop-verification \.button-row\{[^}]*flex-wrap:wrap/);
  assert.match(css, /\.desktop-verification button\{[^}]*min-height:44px/);
  const studio = await readFile('apps/desktop/src/studio.ts', 'utf8');
  assert.match(studio, /getProjectId: \(\) => workbench\.getCurrentProduct\(\)\?\.projectId \?\? null/);
  assert.match(studio, /subscribeProjectChange: listener => workbench\.subscribeProjectChange\(listener\)/);
  assert.match(studio, /pagehide[\s\S]*desktopVerification\.stop\(\)/);
  assert.match(studio, /pageshow[\s\S]*desktopVerification\.resume\(\)/);
  assert.match(studio, /dismissConnectionSecrets = \(\) => workbench\.dismissConnectionSecrets\(\)/);
});

test('Node import is inert even with hostile window/document/fetch getters', () => {
  const url = new URL('../../apps/desktop/src/desktop-verification.js', import.meta.url).href;
  const script = [
    'for (const key of ["window", "document", "fetch"]) Object.defineProperty(globalThis, key, { configurable: true, get() { throw new Error("import probed " + key); } });',
    'const module = await import(' + JSON.stringify(url) + ');',
    'if (typeof module.startDesktopVerification !== "function") throw new Error("missing controller");',
  ].join('\n');
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, '');
});

const browserModule = process.env.ARCANE_UI_BROWSER_MODULE;
test('browser fixture: native keyboard activation, responsive settings, reference palette and preserved draft without API traffic',
  { skip: !browserModule, timeout: 60000 }, async t => {
    const playwright = await import(pathToFileURL(browserModule!).href);
    const browser = await playwright.chromium.launch({ headless: true, args: ['--disable-gpu'],
      ...(process.env.ARCANE_UI_BROWSER_EXE ? { executablePath: process.env.ARCANE_UI_BROWSER_EXE } : {}) });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 945, height: 850 } });
    const errors: string[] = [], requests: string[] = [];
    page.on('pageerror', (error: Error) => errors.push(error.message));
    await page.route('**/*', (route: { request(): { url(): string }; abort(): Promise<void> }) => {
      requests.push(route.request().url()); return route.abort();
    });
    const html = (await readFile('apps/desktop/public/studio.html', 'utf8'))
      .replace('<script type="module" src="/studio.js"></script>', '')
      .replace('<link rel="stylesheet" href="/studio.css">', '');
    await page.setContent(html);
    await page.addStyleTag({ content: await readFile('apps/desktop/public/studio.css', 'utf8') });
    const compiled = await readFile(resolve(process.env.ARCANE_UI_BUILD_DIR ?? 'dist', 'apps/desktop/src/desktop-verification.js'), 'utf8');
    // The real markup/controller, with an explicitly fake frozen zero-arg bridge.
    // StudioWorkbench, WorkspaceShell, Electron, the daemon and system file dialogs
    // are never mounted. Open the real HTML settings dialog explicitly below.
    await page.addScriptTag({ type: 'module', content: compiled + '\n' + [
      'const calls = [];',
      'const projectId = ' + JSON.stringify(PROJECT) + ';',
      'const value = {version:1,projectId,configured:false,pendingRestart:false,evidenceDirectory:null,cancelled:false};',
      'const bridge = Object.freeze({version:1,status:(...args)=>{calls.push({action:"status",args});return Promise.resolve({...value});},configure:(...args)=>{calls.push({action:"configure",args});return Promise.resolve({...value,configured:true,pendingRestart:true,evidenceDirectory:"evidence/luau"});}});',
      'const controller = startDesktopVerification(document,{getProjectId:()=>projectId,subscribeProjectChange:()=>()=>{},nativeBridge:bridge});',
      'window.verificationFixture = {calls,controller};',
    ].join('\n') });
    await page.waitForFunction(() => !!(window as unknown as { verificationFixture: unknown }).verificationFixture);
    const calls = () => page.evaluate(() => (window as unknown as { verificationFixture: { calls: Call[] } }).verificationFixture.calls);
    assert.deepEqual(await calls(), []);
    assert.equal(await page.locator('#code-verification-settings').getAttribute('open'), null);
    const draft = 'Keep this draft and its whitespace.  ';
    // This controller-only fixture has no provider gate controller. Choose its
    // presentation state explicitly, as the other isolated workspace fixtures do.
    await page.evaluate(()=>document.getElementById('workspace-stage')!.classList.remove('provider-required'));
    await page.locator('#codex-composer').fill(draft);
    const drawer = page.locator('#settings-drawer');
    assert.equal(await drawer.evaluate((dialog: HTMLDialogElement) => dialog.tagName), 'DIALOG');
    assert.equal(await drawer.getAttribute('open'), null);
    assert.equal(await drawer.isVisible(), false);
    await drawer.evaluate((dialog: HTMLDialogElement) => dialog.showModal());
    assert.equal(await drawer.evaluate((dialog: HTMLDialogElement) => dialog.matches(':modal')), true);
    // WorkspaceShell normally selects Tools before expanding the nested group.
    // Keep that pane selection explicit in this controller-only modal fixture.
    assert.equal(await page.locator('#workspace-settings').evaluate((section: HTMLElement) => section.tagName), 'SECTION');
    assert.equal(await page.locator('#workspace-settings').getAttribute('open'), null);
    await page.evaluate(() => {
      for (const section of document.querySelectorAll<HTMLElement>('[data-settings-section]')) section.hidden = section.id !== 'settings-tools';
    });
    assert.equal(await drawer.locator('[data-settings-section]:visible').count(), 1);
    assert.equal(await page.locator('#settings-tools').isVisible(), true);
    assert.deepEqual(await calls(), []);
    await page.locator('#code-verification-settings > summary').click();
    const setup = page.getByRole('button', { name: 'Set up Luau verification', exact: true });
    const refresh = page.getByRole('button', { name: 'Check status', exact: true });
    await setup.evaluate((button: HTMLButtonElement) => button.click());
    assert.deepEqual(await calls(), []);
    await refresh.focus(); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.getElementById('desktop-verification-status')?.textContent?.startsWith('No Luau'));
    assert.deepEqual(await calls(), [{ action: 'status', args: [] }]);
    await setup.focus(); await page.keyboard.press('Space');
    await page.waitForFunction(() => document.getElementById('desktop-verification-status')?.textContent?.includes('next manual restart'));
    assert.deepEqual(await calls(), [{ action: 'status', args: [] }, { action: 'configure', args: [] }]);
    assert.equal(await setup.getAttribute('aria-describedby'), 'desktop-verification-help');
    const palette = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return ['--bg', '--text', '--accent'].map(name => style.getPropertyValue(name).trim());
    });
    assert.deepEqual(palette, ['#faf9f5', '#141413', '#d97757']);
    for (const width of [945, 390]) {
      await page.setViewportSize({ width, height: 850 });
      await setup.scrollIntoViewIfNeeded();
      const dimensions = await page.locator('#desktop-verification').evaluate((root: HTMLElement) => ({
        viewport: innerWidth, width: root.getBoundingClientRect().width, overflow: root.scrollWidth > root.clientWidth,
        buttonHeights: [...root.querySelectorAll('button')].map(button => button.getBoundingClientRect().height),
      }));
      assert.ok(dimensions.width <= dimensions.viewport); assert.equal(dimensions.overflow, false);
      assert.ok(dimensions.buttonHeights.every((height: number) => height >= 44));
    }
    await page.evaluate(() => {
      const fixture = (window as unknown as { verificationFixture: { controller: { stop(): void; resume(): void } } }).verificationFixture;
      fixture.controller.stop(); fixture.controller.resume();
    });
    assert.equal(await page.locator('#codex-composer').inputValue(), draft);
    assert.equal((await calls()).length, 2);
    await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
    await setup.focus();
    assert.equal(await setup.evaluate((button: HTMLElement) => getComputedStyle(button).outlineStyle), 'solid');
    await page.emulateMedia({ forcedColors: 'none', reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 945, height: 850 });
    await page.locator('#desktop-verification').scrollIntoViewIfNeeded();
    if (process.env.ARCANE_UI_SCREENSHOT) {
      await page.locator('#code-verification-settings').scrollIntoViewIfNeeded();
      // The real settings dialog owns scrolling within the viewport.
      await page.screenshot({ path: resolve(process.env.ARCANE_UI_SCREENSHOT) });
    }
    assert.deepEqual(errors, []); assert.ok(requests.every(url => !url.includes('/v1/')));
    t.diagnostic('Fixture-only Edge ' + browser.version() + '; 945/390px; real trusted Enter/Space; zero native/API actions.');
  });
