/// <reference lib="dom" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { appendWorkflowDraft, createWorkflowContextOptions, StudioApi, StudioWorkbench } from '../../apps/desktop/src/studio.js';
import type { NativeWorkflowConversation } from '../../apps/desktop/src/workflow-panel.js';
import { startWorkspaceShell } from '../../apps/desktop/src/workspace-shell.js';

// Small DOM fixture with bubbling and button/form defaults. No browser, host,
// daemon, native client, or inferred workspace data is involved.
class FixtureTarget {
  private readonly listeners = new Map<string, { listener: EventListener; capture: boolean }[]>();
  protected get eventParent(): FixtureTarget | null { return null; }
  addEventListener(type: string, listener: EventListener, capture = false): void {
    const records = this.listeners.get(type) ?? []; records.push({ listener, capture }); this.listeners.set(type, records);
  }
  removeEventListener(type: string, listener: EventListener, capture = false): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter(record => record.listener !== listener || record.capture !== capture));
  }
  get listenerCount(): number { return [...this.listeners.values()].reduce((n, records) => n + records.length, 0); }
  dispatchEvent(event: Event): boolean {
    Object.defineProperty(event, 'target', { value: this, configurable: true });
    let stopped = false;
    const stop = event.stopImmediatePropagation.bind(event);
    event.stopImmediatePropagation = () => { stopped = true; stop(); };
    const path: FixtureTarget[] = [];
    for (let target: FixtureTarget | null = this; target; target = target.eventParent) path.push(target);
    const deliver = (target: FixtureTarget, capture: boolean) => {
      for (const record of [...target.listeners.get(event.type) ?? []]) {
        if (record.capture === capture) record.listener(event);
        if (stopped) break;
      }
    };
    for (const target of [...path].reverse()) { deliver(target, true); if (stopped) return !event.defaultPrevented; }
    for (const target of path) { deliver(target, false); if (stopped || event.cancelBubble || !event.bubbles) break; }
    return !event.defaultPrevented;
  }
}

class FixtureElement extends FixtureTarget {
  private readonly attributes = new Map<string, string>();
  private text = '';
  readonly children: FixtureElement[] = [];
  parentElement: FixtureElement | null = null;
  value = '';
  focusCount = 0;
  scrollCount = 0;
  requestFullscreen: (() => Promise<void>) | undefined;
  constructor(readonly ownerDocument: FixtureDocument, readonly tagName: string) { super(); }
  protected override get eventParent(): FixtureTarget | null { return this.parentElement ?? (this.tagName === 'BODY' ? this.ownerDocument : null); }
  get id(): string { return this.getAttribute('id') ?? ''; }
  set id(value: string) { this.setAttribute('id', value); }
  get className(): string { return this.getAttribute('class') ?? ''; }
  set className(value: string) { this.setAttribute('class', value); }
  readonly classList = {
    contains: (name: string) => this.className.split(/\s+/).includes(name),
    toggle: (name: string, force?: boolean) => {
      const names = new Set(this.className.split(/\s+/).filter(Boolean));
      const enabled = force ?? !names.has(name);
      if (enabled) names.add(name); else names.delete(name);
      this.className = [...names].join(' ');
      return enabled;
    }
  };
  get type(): string { return this.getAttribute('type') ?? (this.tagName === 'BUTTON' ? 'submit' : 'text'); }
  set type(value: string) { this.setAttribute('type', value); }
  get hidden(): boolean { return this.hasAttribute('hidden'); }
  set hidden(value: boolean) { if (value) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }
  get disabled(): boolean { return this.hasAttribute('disabled'); }
  set disabled(value: boolean) { if (value) this.setAttribute('disabled', ''); else this.removeAttribute('disabled'); }
  get tabIndex(): number { return this.hasAttribute('tabindex') ? Number(this.getAttribute('tabindex')) : /^(BUTTON|INPUT|TEXTAREA)$/.test(this.tagName) ? 0 : -1; }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.replaceChildren(); this.text = value; this.ownerDocument.changed(this); }
  get innerHTML(): never { throw new Error('Untrusted HTML access'); }
  set innerHTML(_value: string) { throw new Error('Untrusted HTML insertion'); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  hasAttribute(name: string): boolean { return this.attributes.has(name); }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  append(...nodes: FixtureElement[]): void {
    for (const node of nodes) { node.remove(); node.parentElement = this; this.children.push(node); }
    this.ownerDocument.changed(this);
  }
  replaceChildren(...nodes: FixtureElement[]): void {
    for (const child of this.children.splice(0)) child.parentElement = null;
    this.text = '';
    this.append(...nodes);
  }
  remove(): void {
    const parent = this.parentElement;
    if (!parent) return;
    parent.children.splice(parent.children.indexOf(this), 1);
    this.parentElement = null;
    this.ownerDocument.changed(parent);
  }
  contains(node: FixtureElement): boolean { return node === this || this.children.some(child => child.contains(node)); }
  private matches(selector: string): boolean {
    return selector.split(',').some(part => {
      const match = /^([a-z][\w-]*)?(?:\[([\w-]+)\])?$/.exec(part.trim());
      assert.ok(match, 'Fixture supports selector ' + part);
      return (!match[1] || this.tagName === match[1].toUpperCase()) && (!match[2] || this.hasAttribute(match[2]));
    });
  }
  closest(selector: string): FixtureElement | null {
    for (let node: FixtureElement | null = this; node; node = node.parentElement) if (node.matches(selector)) return node;
    return null;
  }
  querySelectorAll(selector: string): FixtureElement[] {
    const descendants = this.children.flatMap(child => [child, ...child.descendants()]);
    return descendants.filter(child => child.matches(selector));
  }
  private descendants(): FixtureElement[] { return this.children.flatMap(child => [child, ...child.descendants()]); }
  querySelector(selector: string): FixtureElement | null { return this.querySelectorAll(selector)[0] ?? null; }
  focus(): void { this.focusCount++; this.ownerDocument.activeElement = this; }
  scrollIntoView(): void { this.scrollCount++; }
  click(): Event {
    const event = new Event('click', { bubbles: true, cancelable: true });
    this.dispatchEvent(event);
    if (!event.defaultPrevented && this.tagName === 'BUTTON' && this.type !== 'button') this.closest('form')?.submit();
    return event;
  }
  key(key: string, modifiers: Partial<Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'isComposing' | 'repeat'>> = {}): Event {
    const event = new Event('keydown', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'key', { value: key });
    for (const [name, value] of Object.entries(modifiers)) Object.defineProperty(event, name, { value });
    this.dispatchEvent(event);
    if (!event.defaultPrevented && key === 'Enter' && this.tagName === 'INPUT') this.closest('form')?.submit();
    return event;
  }
  input(value: string): void { this.value = value; this.dispatchEvent(new Event('input', { bubbles: true })); }
  submit(): void { this.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }
  requestSubmit(): void { this.submit(); }
}

interface FixtureObserver { root: FixtureElement; subtree: boolean; callback: () => void }
class FixtureDocument extends FixtureTarget {
  readonly body = new FixtureElement(this, 'BODY');
  readonly observers = new Set<FixtureObserver>();
  readonly defaultView;
  activeElement: FixtureElement | null = null;
  fullscreenElement: FixtureElement | null = null;
  exitFullscreen: (() => Promise<void>) | undefined;
  constructor() {
    super();
    const doc = this;
    this.defaultView = { Event, CustomEvent: class<T> extends Event {
      readonly detail: T;
      constructor(type: string, options: CustomEventInit<T>) { super(type, options); this.detail = options.detail as T; }
    }, MutationObserver: class {
      private readonly records: FixtureObserver[] = [];
      constructor(private readonly callback: () => void) {}
      observe(root: FixtureElement, options: { subtree?: boolean }): void {
        const record = { root, subtree: Boolean(options.subtree), callback: this.callback };
        this.records.push(record); doc.observers.add(record);
      }
      disconnect(): void { for (const record of this.records) doc.observers.delete(record); }
    } };
    for (const name of ['fetch', 'localStorage', 'sessionStorage']) Object.defineProperty(this.defaultView, name, {
      get() { throw new Error('Shell must not access ' + name); }
    });
  }
  get document(): Document { return this as unknown as Document; }
  createElement(tag: string): FixtureElement { return new FixtureElement(this, tag.toUpperCase()); }
  getElementById(id: string): FixtureElement | null { return id ? this.body.querySelectorAll('[id]').find(element => element.id === id) ?? null : null; }
  querySelectorAll(selector: string): FixtureElement[] { return this.body.querySelectorAll(selector); }
  changed(element: FixtureElement): void {
    for (const observer of this.observers) if (observer.root === element || observer.subtree && observer.root.contains(element)) observer.callback();
  }
  get allListenerCount(): number { return this.listenerCount + this.body.listenerCount + this.body.querySelectorAll('button, input, textarea, div, form, section, h2, figure, canvas, figcaption').reduce((count, element) => count + element.listenerCount, 0); }
}


function fixture() {
  const doc = new FixtureDocument();
  const add = (tag: string, id = '', parent = doc.body, text = '') => {
    const element = doc.createElement(tag); element.id = id; element.textContent = text; parent.append(element); return element;
  };
  const stage = add('div', 'workspace-stage'); stage.setAttribute('data-workspace-tool', 'all');
  const sidebar = add('nav', 'app-sidebar');
  const form = add('form', 'codex-compose', stage);
  const composer = add('textarea', 'codex-composer', form); composer.setAttribute('maxlength', '131072');
  const messages = add('div', 'codex-messages', stage, 'Existing conversation');
  const scope = add('pre', 'codex-scope', stage, 'fixture-native-thread');
  const toolButtons = new Map<string, FixtureElement>();
  for (const [tool, id, label, target] of [
    ['all', 'all-tools', 'All tools', 'codex-heading'],
    ['blender', 'go-assets', 'Blender', 'asset-heading'],
    ['roblox', 'roblox-tool', 'Roblox Studio', 'session-heading'],
  ]) {
    const button = add('button', id!, sidebar, label!);
    button.setAttribute('data-workspace-tool', tool!); button.setAttribute('data-workspace-target', target!);
    button.setAttribute('data-search-item', tool === 'blender' ? 'materials textures animations' : label!);
    toolButtons.set(tool!, button);
  }
  add('h2', 'codex-heading', stage);
  const settings = add('details', 'workspace-settings');
  const assetGroup = add('details', '', settings); const assetHeading = add('h2', 'asset-heading', assetGroup);
  const studioGroup = add('details', '', settings); add('h2', 'session-heading', studioGroup);
  const settingsButton = add('button', 'workspace-tool-settings', stage); settingsButton.setAttribute('data-workspace-target', settings.id);
  const context = add('button', 'workspace-add-context', form);
  const contextLabel = add('span', 'workspace-tool-label', stage);
  add('h2', 'workspace-context-heading', stage); add('p', 'workspace-context-description', stage);
  const newChat = add('button', 'new-chat', sidebar);
  const notice = add('p', 'shell-notice', stage);
  const previews = add('div', 'asset-previews', stage);
  const search = add('input', 'workspace-search', add('label', '', stage));
  let inputs = 0, submissions = 0, nativeActions = 0, secretDismissals = 0, legacyScrolls = 0;
  composer.addEventListener('input', () => inputs++);
  form.addEventListener('submit', () => submissions++);
  for (const id of ['codex-connect', 'codex-thread-start', 'codex-thread-resume', 'codex-submit', 'asset-start']) {
    add('button', id, form).addEventListener('click', () => nativeActions++);
  }
  // Installed BEFORE the shell to model a retained workbench handler on pageshow.
  toolButtons.get('blender')!.addEventListener('click', () => { legacyScrolls++; });
  const start = () => startWorkspaceShell(doc.document, () => { secretDismissals++; });
  const untouched = () => {
    assert.equal(nativeActions, 0); assert.equal(submissions, 0);
    assert.equal(messages.textContent, 'Existing conversation'); assert.equal(scope.textContent, 'fixture-native-thread');
    assert.equal(doc.getElementById('codex-composer'), composer); assert.equal(previews.children.length, 0);
  };
  return { doc, start, stage, composer, messages, scope, toolButtons, settings, assetGroup, studioGroup, assetHeading, settingsButton,
    context, contextLabel, newChat, notice, search, untouched, get inputs() { return inputs; }, get secretDismissals() { return secretDismissals; }, get legacyScrolls() { return legacyScrolls; } };
}

test('tool switching keeps one native conversation and its exact draft, owns legacy navigation and leaves settings closed', () => {
  const f = fixture(); f.composer.value = 'Unsent draft 🧩\nKeep its whitespace.  ';
  const original = f.composer.value; const events: string[] = [];
  f.doc.addEventListener('workspace:toolchange', e => events.push((e as CustomEvent<{tool: string}>).detail.tool));
  const shell = f.start(); assert.equal(f.secretDismissals, 0); assert.equal(f.inputs, 0);
  for (const tool of ['blender', 'roblox', 'all', 'blender']) {
    f.toolButtons.get(tool)!.click(); assert.equal(f.composer.value, original);
    assert.equal(shell.activeTool, tool); assert.equal(f.stage.getAttribute('data-workspace-tool'), tool);
    assert.equal(f.toolButtons.get(tool)!.getAttribute('aria-pressed'), 'true');
    assert.equal(f.settings.hasAttribute('open'), false); assert.equal(f.inputs, 0); f.untouched();
  }
  assert.equal(f.legacyScrolls, 0); assert.deepEqual(events, ['blender', 'roblox', 'all', 'blender']);
  assert.ok(f.secretDismissals >= 4); shell.cleanup();
});

test('human context additions append text once without submitting, granting permission or replacing a draft', () => {
  const f = fixture(), shell = f.start(); const original = '<img src=x>\nUnsent draft 🧩 ';
  f.composer.value = original; f.toolButtons.get('blender')!.click(); f.context.click();
  assert.ok(f.composer.value.startsWith(original + '\n\n'));
  assert.match(f.composer.value, /Blender models, materials, textures/);
  assert.match(f.composer.value, /does not grant permission/); assert.equal(f.inputs, 1);
  assert.equal(f.composer.children.length, 0);
  const draft = f.composer.value; f.newChat.click(); assert.equal(f.composer.value, draft);
  assert.equal(f.doc.activeElement, f.composer); f.untouched(); shell.cleanup();
});

test('draft limits reject the entire addition and preserve existing text and input count', () => {
  const f = fixture(), shell = f.start();
  for (const draft of ['x'.repeat(131070), '🧩'.repeat(32767)]) {
    f.composer.value = draft; f.context.click(); assert.equal(f.composer.value, draft); assert.equal(f.inputs, 0);
    assert.match(f.notice.textContent, /limit.*preserved/);
  }
  f.composer.setAttribute('maxlength', '16'); f.composer.value = 'short'; f.context.click();
  assert.equal(f.composer.value, 'short'); assert.equal(f.inputs, 0); f.untouched(); shell.cleanup();
});

test('tool settings explicitly reveal the right group and never reset the active tool or draft', () => {
  const f = fixture(), shell = f.start(); f.composer.value = 'Keep me';
  f.toolButtons.get('blender')!.click(); f.settingsButton.click();
  assert.equal(f.settings.hasAttribute('open'), true); assert.equal(f.assetGroup.hasAttribute('open'), true);
  assert.equal(f.studioGroup.hasAttribute('open'), false); assert.equal(f.doc.activeElement, f.assetHeading);
  assert.equal(shell.activeTool, 'blender'); assert.equal(f.composer.value, 'Keep me');
  f.untouched(); shell.cleanup();
});

test('search selects tool context in the same conversation without revealing advanced panels', () => {
  const f = fixture(), shell = f.start(); f.composer.value = 'Retain draft';
  f.search.input('textures'); const results = f.doc.getElementById('workspace-search-results')!;
  assert.equal(results.querySelectorAll('button').length, 1);
  f.search.key('Enter'); assert.equal(shell.activeTool, 'blender');
  assert.equal(f.settings.hasAttribute('open'), false); assert.equal(f.composer.value, 'Retain draft');
  assert.equal(results.hidden, true); f.untouched(); shell.cleanup();
});

test('cleanup and pageshow restore context without duplicate listeners, native actions or lost drafts', () => {
  const f = fixture(); f.composer.value = 'Retained through pageshow'; let shell = f.start();
  f.toolButtons.get('roblox')!.click(); shell.cleanup();
  assert.equal(f.doc.observers.size, 0); assert.equal(f.doc.getElementById('workspace-search-results'), null);
  shell = f.start(); const count = f.doc.allListenerCount;
  assert.equal(f.start(), shell); assert.equal(f.doc.allListenerCount, count);
  assert.equal(shell.activeTool, 'roblox'); assert.equal(f.contextLabel.textContent, 'Roblox Studio');
  assert.equal(f.composer.value, 'Retained through pageshow'); assert.equal(f.inputs, 0);
  f.toolButtons.get('blender')!.click(); assert.equal(f.legacyScrolls, 0); f.untouched(); shell.cleanup();
});

test('markup has one composer, closed advanced settings, live review notices and an empty real preview', async () => {
  const html = await readFile(resolve('apps/desktop/public/studio.html'), 'utf8');
  assert.equal([...html.matchAll(/id="codex-compose"/g)].length, 1);
  assert.equal([...html.matchAll(/id="codex-composer"/g)].length, 1);
  assert.doesNotMatch(html, /starter-grid|What are we building\?|Textures &amp; Materials|data-draft=/);
  assert.match(html, /<details class="workspace-tools" id="workspace-settings" tabindex="-1">/);
  const settingsAt = html.indexOf('id="workspace-settings"');
  for (const id of ['codex-unknown', 'codex-approval-section']) assert.ok(html.indexOf('id="' + id + '"') < settingsAt);
  assert.match(html, /id="asset-previews" class="asset-previews"><\/div>/);
  assert.ok(html.indexOf('id="codex-model"') > settingsAt); assert.ok(html.indexOf('id="codex-select"') > settingsAt);
  assert.doesNotMatch(html, /medieval|house|Download All|Model generated/);
  assert.doesNotMatch(html, /class="eyebrow"|class="badge /);
  assert.doesNotMatch(html, /LOCAL STUDIO BRIDGE v1|Session grants · editor baselines/);
  assert.match(html, /id="codex-status" class="status-text neutral"/);
  assert.ok(html.indexOf('class="conversation-scroll"') < html.indexOf('id="codex-unknown"'));
  assert.ok(html.indexOf('id="codex-approval-section"') < html.indexOf('id="codex-compose"'));
  const shell = await readFile(resolve('apps/desktop/src/workspace-shell.ts'), 'utf8');
  assert.doesNotMatch(shell, /\.innerHTML|\.outerHTML|\bfetch\s*\(|localStorage|sessionStorage|\.requestSubmit\s*\(|\.submit\s*\(/);
  const chat = await readFile(resolve('apps/desktop/src/codex-chat.ts'), 'utf8');
  assert.doesNotMatch(chat, /CODEX · PUBLIC MESSAGE|'eyebrow'/);
  assert.match(chat, /card\.setAttribute\('aria-label',message\.role==='human'\?'Your message':'Assistant message'\)/);
  const workbench = await readFile(resolve('apps/desktop/src/studio.ts'), 'utf8');
  assert.doesNotMatch(workbench, /item\.className = 'badge '/);
});


function workflowContextFixture() {
  const f = fixture();
  for (const id of ['project-path', 'command-counts', 'product-evidence', 'build-tasks']) {
    const element = f.doc.createElement('div'); element.id = id; f.doc.body.append(element);
  }
  let requests = 0;
  const workbench = new StudioWorkbench(f.doc.document, new StudioApi('a'.repeat(64), async () => {
    requests++; throw new Error('Context projection must not send Studio requests');
  }), 'http://offline.invalid', 'a'.repeat(64));
  const nativeListeners = new Set<() => void>();
  let native: NativeWorkflowConversation | null = null;
  const chat = {
    workflowConversation: () => native,
    subscribeWorkflowContextChange(listener: () => void) { nativeListeners.add(listener); return () => { nativeListeners.delete(listener); }; },
  };
  const project = (projectPath: unknown, protocolVersion = 1) => {
    // Exercise the real incoming product projection without launching the workbench.
    (workbench as unknown as { renderProduct(value: unknown): void }).renderProduct({
      projectPath, protocolVersion, studioSessions: [], commandCounts: { succeeded: 0 }, features: [], buildTasks: [],
    });
  };
  const pollNative = () => { for (const listener of nativeListeners) listener(); };
  return { ...f, workbench, chat, project, pollNative, nativeListeners,
    native(value: NativeWorkflowConversation | null) { native = value; pollNative(); },
    get requests() { return requests; } };
}

test('workflow initial canonical product arrival invalidates and refreshes once without replacing the native draft', async () => {
  const f = workflowContextFixture(), draft = 'Keep my current unsent draft 🧩\n  ';
  f.composer.value = draft;
  let invalidations = 0, refreshes = 0;
  const options = createWorkflowContextOptions(() => 'a'.repeat(64), f.workbench, f.chat, () => { refreshes++; });
  const unsubscribe = options.subscribeContextChange!(() => { invalidations++; });
  assert.equal(options.getProjectPath(), null); assert.equal(options.getNativeConversation!(), null);
  assert.equal(options.getModelSelection!(), null, 'no catalogue revision is fabricated from a saved preference');
  f.project('C:/trusted/project'); assert.equal(invalidations, 1); await Promise.resolve(); assert.equal(refreshes, 1);
  assert.equal(options.getProjectPath(), 'C:/trusted/project');
  for (let i = 0; i < 5; i++) f.project('C:/trusted/project');
  await Promise.resolve(); assert.equal(invalidations, 1); assert.equal(refreshes, 1);
  assert.equal(f.composer.value, draft); assert.equal(f.requests, 0); f.untouched(); unsubscribe();
});

test('workflow controller refresh coalesces canonical changes and ignores duplicate polling and DOM context events', async () => {
  const f = workflowContextFixture(); f.composer.value = 'Existing one-conversation draft';
  let invalidations = 0, refreshes = 0, previewValid = true;
  const options = createWorkflowContextOptions(() => 'a'.repeat(64), f.workbench, f.chat, () => { refreshes++; });
  const unsubscribe = options.subscribeContextChange!(() => { invalidations++; previewValid = false; });
  f.project('C:/trusted/project'); f.native({ provider: 'codex', threadId: 'observed-thread', sessionId: null, projectPath: 'C:/trusted/project' });
  assert.equal(invalidations, 2, 'every actual change stales previews synchronously');
  await Promise.resolve(); assert.equal(refreshes, 1, 'one read refresh for the same observation turn');
  previewValid = true;
  for (let i = 0; i < 8; i++) { f.project('C:/trusted/project'); f.pollNative(); }
  f.doc.getElementById('project-path')!.textContent = 'C:/untrusted/browser-label';
  f.doc.dispatchEvent(new Event('arcane:contextchange')); f.doc.dispatchEvent(new Event('workspace:toolchange'));
  await Promise.resolve(); assert.equal(invalidations, 2); assert.equal(refreshes, 1); assert.equal(previewValid, true);
  assert.equal(options.getProjectPath(), 'C:/trusted/project'); assert.equal(options.getNativeConversation!()!.threadId, 'observed-thread');
  f.native({ provider: 'codex', threadId: 'observed-thread', sessionId: 'new-observed-session', projectPath: 'C:/trusted/project' });
  assert.equal(previewValid, false); await Promise.resolve(); assert.equal(invalidations, 3); assert.equal(refreshes, 2);
  assert.equal(f.composer.value, 'Existing one-conversation draft'); assert.equal(f.requests, 0); f.untouched(); unsubscribe();
});

test('workflow subscriptions ignore invalid project observations and cancel queued refreshes on cleanup', async () => {
  const f = workflowContextFixture(); let invalidations = 0, refreshes = 0;
  f.project('C:/trusted/project');
  const options = createWorkflowContextOptions(() => 'a'.repeat(64), f.workbench, f.chat, () => { refreshes++; });
  const unsubscribe = options.subscribeContextChange!(() => { invalidations++; });
  for (const value of [undefined, null, '', '\0', 'x'.repeat(4097)]) f.project(value);
  f.project('C:/untrusted/protocol', 2); await Promise.resolve();
  assert.equal(options.getProjectPath(), 'C:/trusted/project'); assert.equal(invalidations, 0); assert.equal(refreshes, 0);
  f.project('C:/trusted/other'); assert.equal(invalidations, 1); unsubscribe(); await Promise.resolve(); assert.equal(refreshes, 0);
  assert.equal(f.nativeListeners.size, 0);
  f.project('C:/trusted/third'); f.native({ provider: 'codex', threadId: 'another-thread', sessionId: null });
  await Promise.resolve(); assert.equal(invalidations, 1); assert.equal(refreshes, 0); assert.equal(f.requests, 0);
});

test('workflow boot retains optional dynamic loading and wires only trusted context sources', async () => {
  const source = await readFile(resolve('apps/desktop/src/studio.ts'), 'utf8');
  assert.match(source, /void import\('\.\/workflow-panel\.js'\)\.then/);
  assert.doesNotMatch(source, /^import\s+(?!type\b)[^\n]+from '\.\/workflow-panel\.js'/m);
  assert.match(source, /createWorkflowContextOptions\(\(\) => token, workbench, codexChat, refreshWorkflowContext\)/);
  assert.match(source, /if \(!workflowsStopped\) return workflows\.start\(\)/);
  assert.match(source, /Restart Arcane to load the workflow tools\./);
  assert.doesNotMatch(source, /addEventListener\('arcane:contextchange'/);
  const wiring = source.slice(source.indexOf('export function createWorkflowContextOptions'), source.indexOf("if (typeof window !== 'undefined'"));
  assert.match(wiring, /getModelSelection: \(\) => chat\.workflowModelSelection\?\.\(\)\?\?null/);
  assert.doesNotMatch(wiring, /connectionRevision\s*:|localStorage|sessionStorage|dispatch\(|turn-start|thread-start|thread-resume|grant-writes/);
});


test('workflow metadata model changes invalidate exact previews without changing conversation identity or its draft',async()=>{
  const f=workflowContextFixture();f.project('C:/trusted/project');f.native({provider:'codex',threadId:'observed-thread',sessionId:null,projectPath:'C:/trusted/project'});
  const chat={...f.chat,workflowModelSelection:()=>selected};
  let selected:{provider:'codex';model:string;effort:'high';connectionRevision:string}|null=null;
  let invalidations=0,refreshes=0;
  const options=createWorkflowContextOptions(()=>'a'.repeat(64),f.workbench,chat,()=>refreshes++);
  const stop=options.subscribeContextChange!(()=>invalidations++);
  f.composer.value='Keep my single conversation draft';assert.equal(options.getModelSelection!(),null);
  selected={provider:'codex',model:'observed',effort:'high',connectionRevision:'b'.repeat(64)};f.pollNative();
  assert.deepEqual(options.getModelSelection!(),selected);assert.equal(invalidations,1);await Promise.resolve();assert.equal(refreshes,1);
  f.pollNative();await Promise.resolve();assert.equal(invalidations,1);
  selected={...selected,connectionRevision:'c'.repeat(64)};f.pollNative();assert.equal(invalidations,2);await Promise.resolve();assert.equal(refreshes,2);
  assert.equal(f.composer.value,'Keep my single conversation draft');assert.equal(f.requests,0);stop();
});


test('approved step draft appends atomically to the same composer without a submit or native action',()=>{
  const f=fixture();f.composer.value='My current project request.  ';
  assert.equal(appendWorkflowDraft(f.doc.document,'Reviewed actual workflow step'),true);
  assert.equal(f.composer.value,'My current project request.  \n\nReviewed actual workflow step');
  assert.equal(f.inputs,1);f.untouched();
});
test('workflow draft UTF8 and maxlength limits reject the whole addition and preserve every original byte',()=>{
  const f=fixture();f.composer.value='🧩'.repeat(32760);const original=f.composer.value;
  assert.equal(appendWorkflowDraft(f.doc.document,'x'.repeat(100)),false);assert.equal(f.composer.value,original);
  assert.equal(appendWorkflowDraft(f.doc.document,'x'.repeat(64*1024+1)),false);assert.equal(f.composer.value,original);
  f.composer.value='short';f.composer.setAttribute('maxlength','6');assert.equal(appendWorkflowDraft(f.doc.document,'more'),false);assert.equal(f.composer.value,'short');
  assert.equal(f.inputs,0);f.untouched();
});
