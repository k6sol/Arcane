/// <reference lib="dom" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { startWorkspaceShell, WORKSPACE_ASSET_ACTIVITY_EVENT } from '../../apps/desktop/src/workspace-shell.js';

// An isolated presentation DOM. Native controls and form/input events are counted;
// there is no provider, Studio connection, model, host or network implementation.
class Target {
  readonly listeners = new Map<string, Set<EventListener>>();
  get eventParent(): Target | null { return null; }
  addEventListener(type: string, listener: EventListener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: EventListener): void { this.listeners.get(type)?.delete(listener); }
  dispatchEvent(event: Event): boolean {
    Object.defineProperty(event, 'target', { value: this, configurable: true });
    this.deliver(event); return !event.defaultPrevented;
  }
  private deliver(event: Event): void {
    for (const listener of [...this.listeners.get(event.type) ?? []]) listener(event);
    if (event.bubbles && !event.cancelBubble) this.eventParent?.deliver(event);
  }
  get listenerCount(): number { return [...this.listeners.values()].reduce((sum, values) => sum + values.size, 0); }
}
class Node extends Target {
  private readonly attributes = new Map<string, string>();
  private text = '';
  readonly children: Node[] = [];
  parentElement: Node | null = null;
  value = '';
  width = 300;
  height = 150;
  requestFullscreen: (() => Promise<void>) | undefined;
  constructor(readonly ownerDocument: Doc, readonly tagName: string) { super(); }
  override get eventParent(): Target | null { return this.parentElement ?? (this === this.ownerDocument.body ? this.ownerDocument : null); }
  get id(): string { return this.getAttribute('id') ?? ''; }
  set id(value: string) { this.setAttribute('id', value); }
  get isConnected(): boolean { return this.ownerDocument.body.contains(this); }
  get hidden(): boolean { return this.hasAttribute('hidden'); }
  set hidden(value: boolean) { if (value) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }
  get tabIndex(): number { return Number(this.getAttribute('tabindex') ?? (/^(BUTTON|TEXTAREA)$/.test(this.tagName) ? 0 : -1)); }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.replaceChildren(); this.text = value; this.ownerDocument.changed(this); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  hasAttribute(name: string): boolean { return this.attributes.has(name); }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  readonly classList = {
    contains: (name: string) => (this.getAttribute('class') ?? '').split(/\s+/).includes(name),
    toggle: (name: string, force?: boolean) => {
      const names = new Set((this.getAttribute('class') ?? '').split(/\s+/).filter(Boolean));
      const enabled = force ?? !names.has(name);
      if (enabled) names.add(name); else names.delete(name);
      this.setAttribute('class', [...names].join(' ')); return enabled;
    },
  };
  append(...nodes: Node[]): void { for (const node of nodes) { node.remove(); node.parentElement = this; this.children.push(node); } this.ownerDocument.changed(this); }
  replaceChildren(...nodes: Node[]): void { for (const node of this.children.splice(0)) node.parentElement = null; this.text = ''; this.append(...nodes); }
  remove(): void { const parent = this.parentElement; if (parent) { parent.children.splice(parent.children.indexOf(this), 1); this.parentElement = null; this.ownerDocument.changed(parent); } }
  contains(node: Node): boolean { return this === node || this.children.some(child => child.contains(node)); }
  private matches(selector: string): boolean {
    return selector.split(',').some(part => {
      const match = /^([a-z][\w-]*)?(?:\[([\w-]+)(?:="([^"]*)")?\])?$/.exec(part.trim());
      assert.ok(match, 'Fixture selector: ' + part);
      return (!match[1] || this.tagName === match[1].toUpperCase()) &&
        (!match[2] || this.hasAttribute(match[2]) && (match[3] === undefined || this.getAttribute(match[2]) === match[3]));
    });
  }
  closest(selector: string): Node | null { for (let node: Node | null = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
  querySelectorAll(selector: string): Node[] {
    const descendants = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]);
    if (selector === '*') return descendants;
    const parts = selector.split(/\s+(?![^[]*\])/);
    const leaf = parts.pop()!;
    return descendants.filter(node => node.matches(leaf) && (!parts.length || !!node.parentElement?.closest(parts.join(' '))));
  }
  querySelector(selector: string): Node | null { return this.querySelectorAll(selector)[0] ?? null; }
  focus(): void { this.ownerDocument.activeElement = this; }
  scrollIntoView(): void {}
  click(): Event {
    const event = new Event('click', { bubbles: true, cancelable: true }); this.dispatchEvent(event);
    if (!event.defaultPrevented && this.tagName === 'BUTTON' && this.getAttribute('type') !== 'button') this.closest('form')?.dispatchEvent(new Event('submit'));
    return event;
  }
}
class Doc extends Target {
  readonly body = new Node(this, 'BODY');
  activeElement: Node | null = this.body;
  fullscreenElement: Node | null = null;
  exitFullscreen: (() => Promise<void>) | undefined;
  readonly observers = new Set<{ root: Node; callback: () => void }>();
  readonly defaultView;
  constructor() {
    super(); const doc = this;
    this.defaultView = { Event, MutationObserver: class {
      private readonly observations: { root: Node; callback: () => void }[] = [];
      constructor(private readonly callback: () => void) {}
      observe(root: Node): void { const observation = { root, callback: this.callback }; this.observations.push(observation); doc.observers.add(observation); }
      disconnect(): void { for (const observation of this.observations) doc.observers.delete(observation); }
    } };
    for (const key of ['fetch', 'localStorage', 'sessionStorage']) Object.defineProperty(this.defaultView, key, { get() { throw new Error('Forbidden presentation access: ' + key); } });
  }
  get document(): Document { return this as unknown as Document; }
  getElementById(id: string): Node | null { return this.body.querySelectorAll('[id]').find(node => node.id === id) ?? null; }
  querySelectorAll(selector: string): Node[] { return this.body.querySelectorAll(selector); }
  changed(node: Node): void { for (const observer of this.observers) if (observer.root.contains(node)) observer.callback(); }
  get allListeners(): number { return this.listenerCount + this.body.listenerCount + this.body.querySelectorAll('*').reduce((sum, node) => sum + node.listenerCount, 0); }
}
function fixture() {
  const doc = new Doc();
  const add = (tag: string, id: string, parent = doc.body) => { const node = new Node(doc, tag.toUpperCase()); node.id = id; parent.append(node); return node; };
  const form = add('form', 'fixture-form'), stage = add('div', 'workspace-stage', form);
  const composer = add('textarea', 'codex-composer', stage), messages = add('div', 'codex-messages', stage);
  composer.value = 'Keep this draft.\nWhitespace too.  '; messages.textContent = 'Recorded native conversation';
  const toggle = add('button', 'workspace-preview-toggle', form), preview = add('section', 'artifact-panel', stage);
  preview.hidden = true;
  const close = add('button', 'workspace-preview-close', preview), previews = add('div', 'asset-previews', preview);
  const summary = add('p', 'asset-job-summary', form), expand = add('button', 'preview-expand', preview), notice = add('p', 'shell-notice', form);
  const tool = add('button', 'fixture-tool', form); tool.setAttribute('data-workspace-target', 'asset-heading'); tool.setAttribute('data-workspace-tool', 'blender');
  let actions = 0, submits = 0, inputs = 0;
  for (const id of ['asset-create', 'command-submit', 'codex-thread-start', 'codex-submit', 'codex-select']) add('button', id, form).addEventListener('click', () => actions++);
  form.addEventListener('submit', () => submits++); composer.addEventListener('input', () => inputs++);
  const activity = (detail: unknown) => { const event = new Event(WORKSPACE_ASSET_ACTIVITY_EVENT); Object.defineProperty(event, 'detail', { value: detail }); doc.dispatchEvent(event); };
  const loaded = () => { const figure = add('figure', '', previews), canvas = add('canvas', '', figure); canvas.setAttribute('role', 'img'); canvas.width = 48; canvas.height = 32; return { figure, canvas }; };
  const visible = (open: boolean) => { assert.equal(preview.hidden, !open); assert.equal(stage.classList.contains('preview-open'), open); assert.equal(toggle.getAttribute('aria-expanded'), String(open)); assert.equal(toggle.getAttribute('aria-pressed'), String(open)); };
  const untouched = () => { assert.equal(actions, 0); assert.equal(submits, 0); assert.equal(inputs, 0); assert.equal(composer.value, 'Keep this draft.\nWhitespace too.  '); assert.equal(messages.textContent, 'Recorded native conversation'); };
  return { doc, add, stage, composer, messages, toggle, preview, close, previews, summary, expand, notice, tool, activity, loaded, visible, untouched };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

test('conversation default; manual toggle and close synchronize presentation, focus and ARIA without actions', () => {
  const f = fixture(); f.stage.classList.toggle('preview-open', true); f.preview.hidden = false;
  const shell = startWorkspaceShell(f.doc.document); f.visible(false);
  assert.equal(f.toggle.getAttribute('aria-controls'), 'artifact-panel');
  assert.equal(f.toggle.getAttribute('aria-label'), 'Show model preview');
  assert.equal(f.toggle.getAttribute('type'), 'button'); assert.equal(f.close.getAttribute('type'), 'button');
  f.toggle.focus(); f.toggle.click(); f.visible(true); assert.equal(f.doc.activeElement, f.close);
  assert.equal(f.toggle.getAttribute('aria-label'), 'Hide model preview');
  f.close.click(); f.visible(false); assert.equal(f.doc.activeElement, f.toggle);
  f.toggle.click(); f.toggle.click(); f.visible(false); assert.equal(f.doc.activeElement, f.toggle);
  f.untouched(); shell.cleanup();
});

test('job events auto-open once without focus theft; dismissal survives state changes, other jobs, polls and tools', () => {
  const f = fixture(), shell = startWorkspaceShell(f.doc.document); f.composer.focus();
  f.activity({ jobId: 'job-a', state: 'queued' }); f.visible(true); assert.equal(f.doc.activeElement, f.composer);
  f.close.click(); f.visible(false); assert.equal(f.doc.activeElement, f.composer);
  for (const state of ['queued', 'running', 'succeeded']) { f.loaded(); f.activity({ jobId: 'job-a', state }); f.visible(false); }
  f.tool.click(); f.summary.textContent = 'Running a test is in the draft, not an asset receipt.'; f.visible(false);
  f.activity({ jobId: 'job-b', state: 'running' }); f.visible(true);
  f.close.click(); f.activity({ jobId: 'job-a', state: 'running' }); f.activity({ jobId: 'job-b', state: 'running' }); f.visible(false);
  f.toggle.click(); f.visible(true); f.close.click(); f.activity({ jobId: 'job-b', state: 'running' }); f.visible(false);
  f.untouched(); shell.cleanup();
});

test('summary text, empty figures and canvas mutations never auto-open; succeeded needs loaded preview evidence', () => {
  const f = fixture(), shell = startWorkspaceShell(f.doc.document);
  f.summary.textContent = 'job-c · running · stage starting'; f.add('figure', '', f.previews); f.visible(false);
  f.activity({ jobId: 'job-c', state: 'succeeded' }); f.visible(false);
  const blank = f.add('canvas', '', f.previews); f.activity({ jobId: 'job-c', state: 'succeeded' }); f.visible(false);
  blank.remove(); const { canvas } = f.loaded(); canvas.width = 0;
  f.activity({ jobId: 'job-c', state: 'succeeded' }); f.visible(false);
  canvas.width = 48; f.visible(false);
  f.activity({ jobId: 'job-c', state: 'succeeded' }); f.visible(true);
  f.close.click(); f.previews.replaceChildren(); f.loaded(); f.summary.textContent = 'job-c · succeeded';
  f.activity({ jobId: 'job-c', state: 'succeeded' }); f.visible(false);
  f.untouched(); shell.cleanup();
});

test('malformed, oversized, inherited and accessor event fields are ignored without reading or rendering them', () => {
  const f = fixture(), shell = startWorkspaceShell(f.doc.document); let getterReads = 0;
  const accessor = { get jobId() { getterReads++; return 'job-invalid'; }, state: 'running' };
  for (const detail of [null, [], 'running', {}, { jobId: '', state: 'running' }, { jobId: 'x'.repeat(129), state: 'running' },
    { jobId: 'job\u0000', state: 'running' }, { jobId: ' job', state: 'running' }, { jobId: 'job', state: 'Running' },
    { jobId: 'job', state: 'failed' }, { jobId: 'job', state: 'running', path: 'private' }, { jobId: 1, state: 'running' },
    Object.create({ jobId: 'job-invalid', state: 'running' }), accessor]) { f.activity(detail); f.visible(false); }
  assert.equal(getterReads, 0); assert.equal(f.notice.textContent, ''); f.untouched(); shell.cleanup();
});

test('Escape inside preview closes and restores a usable opener; handled/composing Escape is left alone', () => {
  const f = fixture(), shell = startWorkspaceShell(f.doc.document);
  const escape = (extra: Record<string, unknown> = {}, handled = false) => {
    const event = new Event('keydown', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'key', { value: 'Escape' }); for (const [key, value] of Object.entries(extra)) Object.defineProperty(event, key, { value });
    if (handled) event.preventDefault(); f.close.dispatchEvent(event); return event;
  };
  f.toggle.click(); escape({ isComposing: true }); f.visible(true); escape({}, true); f.visible(true);
  assert.equal(escape().defaultPrevented, true); f.visible(false); assert.equal(f.doc.activeElement, f.toggle);
  f.toggle.click(); f.toggle.remove(); f.close.click(); assert.equal(f.doc.activeElement, f.composer);
  f.untouched(); shell.cleanup();
});

test('cleanup, duplicate starts and page restoration preserve open/dismissed choices without stale callbacks', () => {
  const f = fixture(), baseline = f.doc.allListeners; let shell = startWorkspaceShell(f.doc.document);
  const bound = f.doc.allListeners; assert.equal(startWorkspaceShell(f.doc.document), shell); assert.equal(f.doc.allListeners, bound);
  f.activity({ jobId: 'job-restore', state: 'running' }); f.close.click();
  for (let cycle = 0; cycle < 3; cycle++) {
    shell.cleanup(); shell.cleanup(); assert.equal(f.doc.allListeners, baseline); assert.equal(f.doc.observers.size, 0);
    f.activity({ jobId: 'late-job', state: 'running' }); f.toggle.click(); f.visible(false);
    shell = startWorkspaceShell(f.doc.document); assert.equal(f.doc.allListeners, bound);
    f.activity({ jobId: 'job-restore', state: 'running' }); f.visible(false);
  }
  f.toggle.click(); shell.cleanup(); shell = startWorkspaceShell(f.doc.document); f.visible(true);
  f.close.click(); f.untouched(); shell.cleanup();
});

test('automatic identity memory is bounded without evicting dismissals; manual preview remains available', () => {
  const f = fixture(), shell = startWorkspaceShell(f.doc.document);
  for (let i = 0; i < 256; i++) { f.activity({ jobId: 'job-' + i, state: 'running' }); f.visible(true); f.close.click(); }
  f.activity({ jobId: 'job-over-limit', state: 'running' }); f.visible(false);
  f.activity({ jobId: 'job-0', state: 'running' }); f.visible(false);
  f.toggle.click(); f.visible(true); f.untouched(); shell.cleanup();
});

test('close exits preview fullscreen and a late fullscreen entry cannot resurrect a hidden preview', async () => {
  const f = fixture(), shell = startWorkspaceShell(f.doc.document); let exits = 0;
  f.doc.exitFullscreen = async () => { exits++; f.doc.fullscreenElement = null; f.doc.dispatchEvent(new Event('fullscreenchange')); };
  f.preview.requestFullscreen = async () => { f.doc.fullscreenElement = f.preview; f.doc.dispatchEvent(new Event('fullscreenchange')); };
  f.toggle.click(); f.expand.click(); await flush(); f.close.click(); await flush(); f.visible(false); assert.equal(exits, 1);
  let finish: () => void = () => {};
  f.preview.requestFullscreen = () => new Promise<void>(done => { finish = () => { f.doc.fullscreenElement = f.preview; done(); }; });
  f.toggle.click(); f.expand.click(); f.close.click(); finish(); await flush();
  f.visible(false); assert.equal(f.doc.fullscreenElement, null); assert.equal(exits, 2);
  assert.equal(f.expand.getAttribute('aria-pressed'), 'false'); f.untouched(); shell.cleanup();
});

test('optional preview selectors can be absent without adding markup or native actions', () => {
  const doc = new Doc(), shell = startWorkspaceShell(doc.document);
  assert.equal(doc.body.children.length, 0); shell.cleanup(); assert.equal(doc.allListeners, 0);
});

const browserModule = process.env.ARCANE_UI_BROWSER_MODULE;
test('owned Edge presentation fixture: keyboard toggle, real canvas, polling, dismissal and rebind with zero API traffic',
  { skip: !browserModule, timeout: 60000 }, async t => {
    const playwright = await import(pathToFileURL(resolve(browserModule!)).href) as typeof import('playwright-core');
    const profile = await mkdtemp(join(process.env.ARCANE_UI_FIXTURE_DIR ?? tmpdir(), 'workspace-preview-browser-'));
    const context = await playwright.chromium.launchPersistentContext(profile, { headless: true, args: ['--disable-gpu'],
      ...(process.env.ARCANE_UI_BROWSER_EXE ? { executablePath: process.env.ARCANE_UI_BROWSER_EXE } : {}) });
    t.after(() => context.close());
    const page = await context.newPage(); const requests: string[] = [], errors: string[] = [];
    await page.route('**/*', route => { requests.push(route.request().url()); return route.abort(); });
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent(`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'"></head><body>
      <form id="fixture-form"><button id="workspace-preview-toggle">Model preview</button>
      <button id="tool" data-workspace-tool="blender" data-workspace-target="asset-heading">Blender</button>
      <div id="workspace-stage"><textarea id="codex-composer"></textarea><div id="codex-messages">Recorded conversation</div>
      <section id="artifact-panel" hidden><button id="workspace-preview-close">Close preview</button><div id="asset-previews"></div></section></div>
      <p id="asset-job-summary"></p></form></body></html>`);
    const source = await readFile(resolve(import.meta.dirname, '../../apps/desktop/src/workspace-shell.js'), 'utf8');
    await page.addScriptTag({ type: 'module', content: source + `\nwindow.previewFixture={shell:startWorkspaceShell(document),startWorkspaceShell,submits:0,inputs:0};
      document.getElementById('fixture-form').addEventListener('submit',e=>{e.preventDefault();window.previewFixture.submits++});
      document.getElementById('codex-composer').addEventListener('input',()=>window.previewFixture.inputs++);` });
    await page.waitForFunction(() => document.getElementById('workspace-preview-toggle')?.getAttribute('aria-expanded') === 'false');
    const draft = 'Same native draft.\nKeep whitespace.  ';
    await page.locator('#codex-composer').fill(draft);
    await page.evaluate(() => { (window as FixtureWindow).previewFixture.inputs = 0; });
    const visible = async (open: boolean) => { assert.equal(await page.locator('#artifact-panel').isVisible(), open); assert.equal(await page.locator('#workspace-preview-toggle').getAttribute('aria-expanded'), String(open)); };
    const activity = (jobId: string, state: string) => page.evaluate(detail => { document.dispatchEvent(new CustomEvent('workspace:assetactivity', { detail })); }, { jobId, state });
    await visible(false);
    await page.locator('#workspace-preview-toggle').focus(); await page.keyboard.press('Enter'); await visible(true);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'workspace-preview-close');
    await page.keyboard.press('Escape'); await visible(false);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'workspace-preview-toggle');
    await page.locator('#codex-composer').focus(); await activity('browser-job-a', 'running'); await visible(true);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'codex-composer');
    await page.locator('#workspace-preview-close').click(); await visible(false);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'codex-composer');
    for (let poll = 0; poll < 3; poll++) {
      await activity('browser-job-a', 'running');
      await page.evaluate(() => { document.getElementById('asset-job-summary')!.textContent = 'running'; document.getElementById('asset-previews')!.replaceChildren(document.createElement('figure')); });
      await page.locator('#tool').click(); await visible(false);
    }
    await activity('browser-job-b', 'succeeded'); await visible(false);
    await page.evaluate(() => {
      const figure = document.createElement('figure'), canvas = document.createElement('canvas');
      canvas.width = 48; canvas.height = 32; canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', 'Fixture loaded preview');
      canvas.getContext('2d')!.fillRect(0, 0, 48, 32); figure.append(canvas); document.getElementById('asset-previews')!.replaceChildren(figure);
    });
    await visible(false); await activity('browser-job-b', 'succeeded'); await visible(true);
    await page.locator('#workspace-preview-close').click();
    await page.evaluate(() => { const f = (window as FixtureWindow).previewFixture; f.shell.cleanup(); f.shell = f.startWorkspaceShell(document); });
    await activity('browser-job-a', 'running'); await activity('browser-job-b', 'succeeded'); await visible(false);
    await activity('browser-job-c', 'queued'); await visible(true);
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport); await page.locator('#workspace-preview-close').click(); await visible(false);
      await page.locator('#workspace-preview-toggle').focus(); await page.keyboard.press('Space'); await visible(true);
    }
    assert.equal(await page.locator('#codex-composer').inputValue(), draft);
    assert.equal(await page.locator('#codex-messages').textContent(), 'Recorded conversation');
    assert.deepEqual(await page.evaluate(() => { const f = (window as FixtureWindow).previewFixture; return { submits: f.submits, inputs: f.inputs }; }), { submits: 0, inputs: 0 });
    assert.deepEqual(requests, []); assert.deepEqual(errors, []);
    t.diagnostic('Owned Edge ' + context.browser()!.version() + '; compiled shell; desktop/mobile keyboard fixture; zero requests, submits or draft events.');
  });
type FixtureWindow = typeof window & { previewFixture: { shell: ReturnType<typeof startWorkspaceShell>; startWorkspaceShell: typeof startWorkspaceShell; submits: number; inputs: number } };
