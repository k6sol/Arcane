/// <reference lib="dom" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startWorkspaceShell } from '../../apps/desktop/src/workspace-shell.js';

// Small DOM fixture with bubbling and button/form defaults. No browser, host,
// daemon, native client, or inferred workspace data is involved.
class FixtureTarget {
  private readonly listeners = new Map<string, Set<EventListener>>();
  protected get eventParent(): FixtureTarget | null { return null; }
  addEventListener(type: string, listener: EventListener): void {
    let listeners = this.listeners.get(type);
    if (!listeners) { listeners = new Set(); this.listeners.set(type, listeners); }
    listeners.add(listener);
  }
  removeEventListener(type: string, listener: EventListener): void { this.listeners.get(type)?.delete(listener); }
  get listenerCount(): number { return [...this.listeners.values()].reduce((total, listeners) => total + listeners.size, 0); }
  dispatchEvent(event: Event): boolean {
    Object.defineProperty(event, 'target', { value: this, configurable: true });
    this.deliver(event);
    return !event.defaultPrevented;
  }
  private deliver(event: Event): void {
    for (const listener of [...this.listeners.get(event.type) ?? []]) listener(event);
    if (event.bubbles && !event.cancelBubble) this.eventParent?.deliver(event);
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
      if(/^\.[a-z][\w-]*$/.test(part.trim()))return this.classList.contains(part.trim().slice(1));
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
    this.defaultView = { Event, MutationObserver: class {
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
  const form = add('form'), sidebar = add('div', 'app-sidebar', form);
  const targets = new Map<string, FixtureElement>(), navigation = new Map<string, FixtureElement>();
  for (const [id, label] of [['codex-heading', 'Conversation'], ['session-heading', 'Session'], ['asset-heading', 'Assets'], ['work-heading', 'Work queue'], ['diagnostics-heading', 'Native reads'], ['build-heading', 'Builder']]) {
    const section = add('section', '', form), heading = add('h2', id!, section, label!);
    targets.set(id!, heading);
    const button = add('button', '', sidebar, label!); button.setAttribute('data-workspace-target', id!); navigation.set(id!, button);
  }
  const tab = add('button', '', form, 'Conversation'); tab.setAttribute('data-workspace-target', 'codex-heading');
  const composer = add('textarea', 'codex-composer', form), messages = add('div', 'codex-messages', form, 'Existing native conversation');
  const draft = add('button', '', form, 'Draft a request'); draft.setAttribute('data-draft', 'Inspect the current workspace.');
  const search = add('input', 'workspace-search', add('div', '', form));
  const toggle = add('button', 'sidebar-toggle', form), newChat = add('button', 'new-chat', form);
  const preview = add('section', 'artifact-panel', form), previews = add('div', 'asset-previews', preview);
  const expand = add('button', 'preview-expand', form), settings = add('button', 'preview-settings', form), notice = add('div', 'shell-notice', form);
  notice.hidden = true;
  let nativeDispatches = 0, submissions = 0, inputs = 0;
  for (const id of ['codex-connect', 'codex-thread-start', 'codex-submit', 'command-submit', 'asset-create', 'work-create']) add('button', id, form).addEventListener('click', () => nativeDispatches++);
  form.addEventListener('submit', () => submissions++);
  form.addEventListener('input', event => { if (event.target === composer as unknown as EventTarget) inputs++; });
  const untouched = () => { assert.equal(nativeDispatches, 0); assert.equal(submissions, 0); assert.equal(messages.textContent, 'Existing native conversation'); };
  return { doc, add, sidebar, navigation, targets, tab, composer, draft, search, toggle, newChat, preview, previews, expand, settings, notice, untouched, get inputs() { return inputs; } };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

test('shortcuts focus search or the existing composer without native actions, respect editing and clean up', () => {
  const f = fixture(), baseline = f.doc.allListenerCount, shell = startWorkspaceShell(f.doc.document);
  f.composer.value = 'Keep this existing draft';
  assert.equal(f.doc.body.key('k', { ctrlKey: true }).defaultPrevented, true); assert.equal(f.doc.activeElement, f.search);
  assert.equal(f.doc.body.key('K', { metaKey: true }).defaultPrevented, true); assert.equal(f.doc.activeElement, f.search);
  assert.equal(f.search.key('n', { ctrlKey: true }).defaultPrevented, true); assert.equal(f.doc.activeElement, f.composer);
  assert.equal(f.doc.body.key('N', { metaKey: true }).defaultPrevented, true);
  assert.equal(f.composer.value, 'Keep this existing draft'); assert.equal(f.inputs, 0);
  assert.equal(f.composer.key('k', { ctrlKey: true }).defaultPrevented, false);
  const editable = f.add('div'); editable.setAttribute('contenteditable', '');
  assert.equal(editable.key('k', { metaKey: true }).defaultPrevented, false);
  for (const modifiers of [{ ctrlKey: true, shiftKey: true }, { ctrlKey: true, altKey: true }, { ctrlKey: true, isComposing: true }, { ctrlKey: true, repeat: true }]) assert.equal(f.doc.body.key('n', modifiers).defaultPrevented, false);
  assert.equal(f.composer.key('a', { ctrlKey: true }).defaultPrevented, false);
  assert.equal(f.composer.key('c', { metaKey: true }).defaultPrevented, false);
  f.untouched(); shell.cleanup(); assert.equal(f.doc.allListenerCount, baseline);
  assert.equal(f.doc.body.key('k', { ctrlKey: true }).defaultPrevented, false);
  assert.equal(f.doc.body.key('n', { metaKey: true }).defaultPrevented, false);
});

test('explicit New chat belongs to chat tabs, while the navigation hook preserves the draft and dismisses secrets',()=>{
  const f=fixture();f.newChat.setAttribute('data-chat-action','new');f.newChat.setAttribute('aria-label','New chat');
  let dismissals=0;const shell=startWorkspaceShell(f.doc.document,()=>{dismissals++;});
  f.composer.value='Keep the exact unsent draft.\n  ';
  f.newChat.click();assert.equal(dismissals,0);assert.equal(f.newChat.getAttribute('aria-label'),'New chat');
  assert.equal(f.doc.body.key('n',{ctrlKey:true}).defaultPrevented,false);
  shell.showConversation();assert.ok(dismissals>0);assert.equal(f.doc.activeElement,f.composer);
  assert.equal(f.composer.value,'Keep the exact unsent draft.\n  ');assert.equal(f.inputs,0);
  f.untouched();shell.cleanup();
});

test('navigation hook dismisses secrets before drafts, focus, search and settings, with no duplicate binding', () => {
  const f = fixture(); let secret = true, calls = 0;
  const dismiss = () => { secret = false; calls++; };
  const shell = startWorkspaceShell(f.doc.document, dismiss), bound = f.doc.allListenerCount;
  assert.equal(calls, 0); assert.equal(startWorkspaceShell(f.doc.document, dismiss), shell); assert.equal(f.doc.allListenerCount, bound);
  for (const target of [...f.targets.values(), f.composer, f.search]) {
    const focus = target.focus.bind(target); target.focus = () => { assert.equal(secret, false); focus(); };
  }
  f.composer.addEventListener('input', () => { assert.equal(secret, false); });
  const move = (action: () => void) => { secret = true; const before = calls; action(); assert.equal(secret, false); assert.ok(calls > before); };
  move(() => { f.navigation.get('asset-heading')!.click(); });
  move(() => { f.tab.click(); }); move(() => { f.draft.click(); }); move(() => { f.newChat.click(); }); move(() => { f.settings.click(); });
  move(() => { f.search.input('Assets'); });
  move(() => { f.doc.getElementById('workspace-search-results')!.querySelector('button')!.click(); });
  move(() => { f.doc.body.key('k', { ctrlKey: true }); }); move(() => { f.doc.body.key('n', { metaKey: true }); });
  f.untouched(); shell.cleanup(); const before = calls; f.doc.body.key('n', { ctrlKey: true }); assert.equal(calls, before);
});

test('preview guide mirrors sanitized real DOM status only while actual canvas figures exist', () => {
  const f = fixture(), summary = f.add('p', 'asset-job-summary'), status = f.add('p', 'preview-guide-status');
  summary.textContent = 'Recorded job · succeeded · stage complete';
  const shell = startWorkspaceShell(f.doc.document);
  assert.equal(status.textContent, 'No model is selected. Nothing is generated automatically.');
  const figure = f.add('figure'); f.add('canvas', '', figure); f.previews.append(figure);
  assert.equal(status.textContent, summary.textContent);
  summary.textContent = 'Actual <img src=x>\u0000\u202e · Bearer private-token · password=private';
  assert.equal(status.textContent, 'Actual <img src=x> · Bearer [REDACTED] · password=[REDACTED]');
  assert.equal(status.children.length, 0);
  summary.textContent = 'Updated recorded receipt'; assert.equal(status.textContent, summary.textContent);
  f.previews.replaceChildren(); assert.equal(status.textContent, 'No model is selected. Nothing is generated automatically.');
  summary.textContent = 'running'; assert.equal(status.textContent, 'No model is selected. Nothing is generated automatically.');
  shell.cleanup(); status.textContent = 'After cleanup'; summary.textContent = 'Late status'; assert.equal(status.textContent, 'After cleanup');
  assert.equal(f.doc.observers.size, 0); f.untouched();
});

test('secret dismissal clears key and scoped-token memory/DOM and invalidates a pending fixture token response', async () => {
  const f = fixture();
  for (const id of ['key-result', 'key-secret', 'key-grants', 'key-reveal', 'key-copy', 'native-token', 'native-scopes', 'native-token-result', 'native-copy-token', 'native-get-token', 'native-notice']) f.add('div', id);
  const studioPath = '../../apps/desktop/src/studio.js', { StudioWorkbench } = await import(studioPath);
  let finish: (value: unknown) => void = () => {}, requests = 0;
  const api = { agentToken() { requests++; return new Promise(resolve => { finish = resolve; }); } };
  const workbench = new StudioWorkbench(f.doc.document, api, 'http://127.0.0.1:1234', 'a'.repeat(64));
  workbench.renderKeyControls = () => {}; // Unrelated grant validation is exercised in the existing Studio tests.
  workbench.issuedKey = { apiKey: 'fixture-issued-secret' }; workbench.keyRevealed = true; workbench.nativeToken = 'b'.repeat(64);
  const shell = startWorkspaceShell(f.doc.document, () => workbench.dismissConnectionSecrets());
  f.newChat.click();
  assert.equal(workbench.issuedKey, null); assert.equal(workbench.keyRevealed, false); assert.equal(workbench.nativeToken, '');
  for (const id of ['key-secret', 'key-grants', 'native-token', 'native-scopes']) assert.equal(f.doc.getElementById(id)!.textContent, '');
  for (const id of ['key-result', 'native-token-result']) assert.equal(f.doc.getElementById(id)!.hidden, true);
  for (const id of ['key-copy', 'key-reveal', 'native-copy-token']) assert.equal(f.doc.getElementById(id)!.disabled, true);
  assert.equal(requests, 0);
  const pending = workbench.getNativeToken(); assert.equal(requests, 1);
  f.draft.click(); finish({ token: 'b'.repeat(64), canReview: false, expires: 'daemon lifetime', scopes: ['fixture'] }); await pending;
  assert.equal(workbench.nativeToken, ''); assert.equal(f.doc.getElementById('native-token')!.textContent, '');
  assert.equal(f.doc.getElementById('native-token-result')!.hidden, true); assert.equal(f.doc.getElementById('native-copy-token')!.disabled, true);
  shell.cleanup(); f.untouched();
});

test('Node imports of shell and Studio do not initialize DOM, storage or native transport', async t => {
  assert.equal(typeof globalThis.document, 'undefined');
  assert.equal(typeof globalThis.window, 'undefined');
  t.mock.method(globalThis, 'fetch', () => { throw new Error('No transport during Node import'); });
  const studioPath = '../../apps/desktop/src/studio.js';
  const studio = await import(studioPath) as { prepareCommand: unknown };
  assert.equal(typeof studio.prepareCommand, 'function');
  const source = await readFile(resolve('apps/desktop/src/workspace-shell.ts'), 'utf8');
  assert.doesNotMatch(source, /\.innerHTML|\.outerHTML|\bfetch\s*\(|localStorage|sessionStorage|\.requestSubmit\s*\(|\.submit\s*\(/);
  const boot = await readFile(resolve('apps/desktop/src/studio.ts'), 'utf8');
  assert.match(boot, /typeof window !== 'undefined' && typeof document !== 'undefined'[\s\S]*startWorkspaceShell\(document, dismissConnectionSecrets\)/);
  assert.match(boot, /'pagehide',[^\n]*workspaceShell\.cleanup\(\)/);
  assert.match(boot, /'pageshow',[^\n]*event\.persisted[^\n]*workspaceShell = startWorkspaceShell\(document, dismissConnectionSecrets\)/);
});

test('sidebar and tabs navigate by literal ID, synchronize aria-current, and never submit native forms', () => {
  const f = fixture(); f.tab.className = 'is-active';
  const shell = startWorkspaceShell(f.doc.document);
  const conversation = f.targets.get('codex-heading')!;
  assert.equal(f.navigation.get('codex-heading')!.click().defaultPrevented, true);
  assert.equal(f.doc.activeElement, conversation); assert.equal(conversation.scrollCount, 1);
  assert.equal(f.tab.getAttribute('aria-current'), 'page');
  assert.equal(conversation.getAttribute('tabindex'), '-1');
  f.navigation.get('asset-heading')!.click();
  assert.equal(f.tab.getAttribute('aria-current'), null);
  assert.equal(f.tab.classList.contains('is-active'), false);
  assert.equal(f.navigation.get('asset-heading')!.classList.contains('is-active'), true);
  assert.equal(f.navigation.get('asset-heading')!.getAttribute('aria-current'), 'page');
  f.tab.click(); assert.equal(f.navigation.get('codex-heading')!.getAttribute('aria-current'), 'page');
  const invalid = f.navigation.get('session-heading')!; invalid.setAttribute('data-workspace-target', 'absent');
  invalid.click(); assert.equal(f.doc.activeElement, conversation);
  const literal = f.add('h2', 'literal["target]', f.doc.body, 'Exact ID');
  invalid.setAttribute('data-workspace-target', literal.id); invalid.click(); assert.equal(f.doc.activeElement, literal);
  for (const target of f.targets.values()) assert.equal(target.parentElement!.hidden, false);
  f.untouched(); shell.cleanup(); assert.equal(conversation.getAttribute('tabindex'), null);
});

test('drafts emit one bubbling input and conversation focus preserves the draft and existing conversation', () => {
  const f = fixture(), shell = startWorkspaceShell(f.doc.document);
  const draft = '<img src=x onerror=alert(1)>\nA draft, never an action.';
  f.draft.setAttribute('data-draft', draft); f.draft.click();
  assert.equal(f.composer.value, draft); assert.equal(f.inputs, 1);
  assert.equal(f.doc.activeElement, f.composer); assert.equal(f.composer.scrollCount, 1);
  assert.equal(f.composer.children.length, 0);
  f.newChat.click(); assert.equal(f.composer.value, draft); assert.equal(f.inputs, 1);
  assert.equal(f.newChat.getAttribute('aria-label'), 'Focus current conversation'); assert.equal(f.doc.activeElement, f.composer);
  f.composer.remove(); f.draft.click(); f.newChat.click(); assert.equal(f.inputs, 1);
  f.untouched(); shell.cleanup();
});

test('search lists real, available navigation matches, escapes labels, deduplicates and leaves panels visible', () => {
  const f = fixture();
  const duplicate = f.add('button', '', f.sidebar, 'Assets'); duplicate.setAttribute('data-workspace-target', 'asset-heading');
  const unavailable = f.add('button', '', f.sidebar, 'Assets unavailable'); unavailable.setAttribute('data-workspace-target', 'missing');
  const hidden = f.add('button', '', f.add('div', '', f.sidebar), 'Assets hidden'); hidden.setAttribute('data-workspace-target', 'work-heading'); hidden.parentElement!.hidden = true;
  const disabled = f.add('button', '', f.sidebar, 'Assets disabled'); disabled.setAttribute('data-workspace-target', 'session-heading'); disabled.setAttribute('disabled', '');
  const item = f.add('section', 'recorded-preview', f.doc.body); item.setAttribute('data-search-item', 'mesh');
  const label = 'Verified preview <img src=x onerror=alert(1)>';
  f.add('h2', '', item, label); f.add('div', '', item, 'private fixture prompt must not become a search label');
  const shell = startWorkspaceShell(f.doc.document), results = f.doc.getElementById('workspace-search-results')!;
  f.search.input(' aSsEtS ');
  assert.equal(results.hidden, false); assert.equal(results.querySelectorAll('button').length, 1);
  assert.equal(results.querySelector('button')!.textContent, 'Assets');
  assert.equal(results.querySelector('button')!.type, 'button');
  results.querySelector('button')!.click(); assert.equal(f.doc.activeElement, f.targets.get('asset-heading')); assert.equal(results.hidden, true);
  f.search.input('mesh'); const match = results.querySelector('button')!;
  assert.equal(match.textContent, label); assert.equal(match.children.length, 0);
  f.search.focus();
  assert.equal(f.search.key('ArrowDown').defaultPrevented, true); assert.equal(f.doc.activeElement, f.search);
  assert.equal(f.search.getAttribute('aria-activedescendant'), match.id);
  match.key('Escape'); assert.equal(results.hidden, true); assert.equal(f.doc.activeElement, f.search);
  f.search.input('mesh'); assert.equal(f.search.key('Enter').defaultPrevented, true); assert.equal(f.doc.activeElement, item);
  f.search.input('private fixture prompt'); assert.equal(results.querySelectorAll('button').length, 0);
  assert.match(results.textContent, /No matching workspace sections/);
  f.search.key('Escape'); assert.equal(results.hidden, true);
  f.search.input(''); assert.ok(results.querySelectorAll('button').length > 0); assert.equal(f.search.getAttribute('aria-expanded'), 'true');
  f.search.key('Escape'); f.search.key('Enter');
  for (const target of f.targets.values()) assert.equal(target.parentElement!.hidden, false);
  f.untouched(); shell.cleanup();
});

test('keyboard navigator discovers tools, selects with arrows and returns recent destinations first', () => {
  const f = fixture(), shell = startWorkspaceShell(f.doc.document);
  f.composer.value = 'Retain this unsent draft';
  f.doc.body.key('k', { ctrlKey: true });
  const results = f.doc.getElementById('workspace-search-results')!;
  const rows = results.querySelectorAll('button');
  assert.equal(results.hidden, false);
  assert.equal(f.search.getAttribute('role'), 'combobox');
  assert.equal(f.search.getAttribute('aria-controls'), 'workspace-search-options');
  assert.equal(f.doc.getElementById('workspace-search-options')!.getAttribute('role'), 'listbox');
  assert.equal(rows.length, 6); assert.equal(rows[0]!.getAttribute('aria-selected'), 'true');
  assert.ok(rows.every(row => row.getAttribute('role') === 'option' && row.tabIndex === -1));
  f.search.key('ArrowDown'); f.search.key('ArrowDown'); f.search.key('ArrowUp');
  assert.equal(f.doc.activeElement, f.search);
  assert.equal(f.search.getAttribute('aria-activedescendant'), rows[1]!.id);
  assert.equal(rows.filter(row => row.getAttribute('aria-selected') === 'true').length, 1);
  f.search.key('Enter');
  assert.equal(f.doc.activeElement, f.targets.get('session-heading')); assert.equal(results.hidden, true);
  f.doc.body.key('k', { ctrlKey: true });
  assert.equal(results.querySelector('button')!.getAttribute('data-workspace-target'), 'session-heading');
  f.search.key('Tab'); assert.equal(results.hidden, true);
  assert.equal(f.search.getAttribute('aria-activedescendant'), null);
  f.search.key('ArrowUp');
  assert.equal(f.search.getAttribute('aria-activedescendant'), results.querySelectorAll('button').at(-1)!.id);
  assert.equal(f.composer.value, 'Retain this unsent draft'); assert.equal(f.inputs, 0);
  f.untouched(); shell.cleanup();
  for (const attribute of ['role', 'aria-controls', 'aria-autocomplete', 'aria-haspopup', 'aria-activedescendant']) assert.equal(f.search.getAttribute(attribute), null);
});

test('search ranks exact names, matches unordered keywords and accents, and chooses the best duplicate label', () => {
  const f = fixture();
  f.navigation.get('session-heading')!.textContent = 'Studio session';
  const alias = f.add('button', '', f.sidebar, 'Asset downloads'); alias.setAttribute('data-workspace-target', 'asset-heading');
  const keywords = f.add('button', '', f.sidebar, 'Work queue');
  keywords.setAttribute('data-workspace-target', 'work-heading'); keywords.setAttribute('data-search-item', 'assets review');
  const accent = f.add('h2', 'cafe-heading', f.doc.body, 'Café tools'); accent.setAttribute('data-search-item', 'reference');
  const shell = startWorkspaceShell(f.doc.document), results = f.doc.getElementById('workspace-search-results')!;
  f.search.input('assets');
  assert.equal(results.querySelector('button')!.textContent, 'Assets');
  f.search.input('downloads asset');
  assert.equal(results.querySelectorAll('button').length, 1); assert.equal(results.querySelector('button')!.textContent, 'Asset downloads');
  f.search.input('session studio'); assert.equal(results.querySelector('button')!.textContent, 'Studio session');
  f.search.input('review assets'); assert.equal(results.querySelector('button')!.textContent, 'Work queue');
  f.search.input('cafe reference'); assert.equal(results.querySelector('button')!.textContent, 'Café tools');
  f.search.input('review missing-term'); assert.equal(results.querySelectorAll('button').length, 0);
  f.untouched(); shell.cleanup();
});

test('discovery keeps tool contexts distinct and ignores unavailable targets and starter drafts', () => {
  const f = fixture();
  const blender = f.add('button', '', f.sidebar, 'Blender');
  blender.setAttribute('data-workspace-target', 'codex-heading'); blender.setAttribute('data-workspace-tool', 'blender');
  const roblox = f.add('button', '', f.sidebar, 'Roblox Studio');
  roblox.setAttribute('data-workspace-target', 'codex-heading'); roblox.setAttribute('data-workspace-tool', 'roblox');
  const starter = f.add('button', '', f.sidebar, 'Private starter');
  starter.setAttribute('data-workspace-target', 'codex-heading'); starter.setAttribute('data-draft', 'Starter text');
  f.targets.get('work-heading')!.parentElement!.setAttribute('inert', '');
  const shell = startWorkspaceShell(f.doc.document), results = f.doc.getElementById('workspace-search-results')!;
  f.search.input('');
  assert.equal(results.querySelectorAll('button').length, 7);
  assert.equal(results.querySelectorAll('button').filter(row => row.hasAttribute('data-workspace-tool')).length, 2);
  f.search.input('roblox'); f.search.key('Enter'); assert.equal(shell.activeTool, 'roblox');
  f.search.input('blender'); results.querySelector('button')!.click(); assert.equal(shell.activeTool, 'blender');
  f.search.input('starter'); assert.equal(results.querySelectorAll('button').length, 0);
  f.search.input('queue'); assert.equal(results.querySelectorAll('button').length, 0);
  f.search.input('Assets'); f.targets.get('asset-heading')!.parentElement!.hidden = true;
  const before = f.doc.activeElement; f.search.key('Enter'); assert.equal(f.doc.activeElement, before);
  assert.equal(f.inputs, 0); f.untouched(); shell.cleanup();
});

test('search closes on outside interaction and leaves composition and modified editing keys untouched', () => {
  const f = fixture(), shell = startWorkspaceShell(f.doc.document), results = f.doc.getElementById('workspace-search-results')!;
  f.search.input('Assets');
  for (const modifiers of [{ isComposing: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
    assert.equal(f.search.key('Enter', modifiers).defaultPrevented, false);
  }
  // The fixture models form defaults even during IME; only inspect shell dispatch here.
  f.search.input('Assets'); f.doc.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  assert.equal(results.hidden, true);
  f.search.input('Assets'); f.composer.dispatchEvent(new Event('focusin', { bubbles: true }));
  assert.equal(results.hidden, true);
  assert.equal(f.search.key('Tab', { shiftKey: true }).defaultPrevented, false);
  shell.cleanup();
});

test('sidebar collapse and preview settings only change presentation; absent optional selectors are no-ops', () => {
  const oldDocument = new FixtureDocument(), oldShell = startWorkspaceShell(oldDocument.document);
  assert.equal(oldDocument.body.children.length, 0); oldShell.cleanup(); oldShell.cleanup();
  const f = fixture(); f.settings.setAttribute('data-workspace-target', 'asset-heading');
  const shell = startWorkspaceShell(f.doc.document);
  assert.equal(f.toggle.getAttribute('aria-expanded'), 'true');
  f.toggle.click(); assert.equal(f.sidebar.classList.contains('collapsed'), true); assert.equal(f.toggle.getAttribute('aria-expanded'), 'false');
  f.toggle.click(); assert.equal(f.sidebar.classList.contains('collapsed'), false);
  f.settings.click(); assert.equal(f.doc.activeElement, f.targets.get('asset-heading'));
  assert.equal(f.targets.get('asset-heading')!.scrollCount, 1);
  f.untouched(); shell.cleanup();
});

test('preview fullscreen uses the native API, reports bounded failures inline and ignores completion after cleanup', async () => {
  const f = fixture(), shell = startWorkspaceShell(f.doc.document);
  f.expand.click(); assert.equal(f.notice.hidden, false); assert.match(f.notice.textContent, /unavailable/);
  let enters = 0, exits = 0;
  f.preview.requestFullscreen = async () => { enters++; f.doc.fullscreenElement = f.preview; f.doc.dispatchEvent(new Event('fullscreenchange')); };
  f.doc.exitFullscreen = async () => { exits++; f.doc.fullscreenElement = null; f.doc.dispatchEvent(new Event('fullscreenchange')); };
  f.expand.click(); await flush(); assert.equal(enters, 1); assert.equal(f.expand.getAttribute('aria-pressed'), 'true'); assert.equal(f.notice.hidden, true);
  f.expand.click(); await flush(); assert.equal(exits, 1); assert.equal(f.expand.getAttribute('aria-pressed'), 'false');
  f.preview.requestFullscreen = async () => { throw new Error('private host details must not be rendered'); };
  f.expand.click(); await flush(); assert.match(f.notice.textContent, /Unable/); assert.doesNotMatch(f.notice.textContent, /private/);
  let finish: () => void = () => {};
  f.preview.requestFullscreen = () => { enters++; return new Promise<void>(done => { finish = done; }); };
  f.expand.click(); f.expand.click(); assert.equal(enters, 2);
  shell.cleanup(); f.notice.textContent = 'After cleanup'; finish(); await flush(); assert.equal(f.notice.textContent, 'After cleanup');
  f.untouched();
});

test('delegated preview selection uses only real canvas figures and survives replacement without invented output', () => {
  const f = fixture(), shell = startWorkspaceShell(f.doc.document);
  assert.equal(f.previews.children.length, 0);
  const figure = (caption: string) => { const node = f.add('figure'); f.add('canvas', '', node); f.add('figcaption', '', node, caption); return node; };
  const first = figure('Fixture verified hero'), second = figure('Fixture verified side'); f.previews.append(first, second);
  assert.equal(first.getAttribute('aria-pressed'), 'true'); assert.equal(second.getAttribute('aria-pressed'), 'false');
  assert.equal(first.getAttribute('role'), 'button'); assert.equal(second.getAttribute('tabindex'), '0');
  second.querySelector('figcaption')!.click(); assert.equal(second.classList.contains('is-selected'), true); assert.equal(first.getAttribute('aria-pressed'), 'false');
  assert.equal(first.key(' ').defaultPrevented, true); assert.equal(first.getAttribute('aria-pressed'), 'true');
  second.key('Enter'); assert.equal(second.getAttribute('aria-pressed'), 'true');
  const empty = f.add('figure'); f.add('figcaption', '', empty, 'No canvas'); f.previews.replaceChildren(empty);
  empty.click(); assert.equal(empty.hasAttribute('aria-pressed'), false);
  const replacement = figure('New recorded preview'); f.previews.replaceChildren(replacement);
  assert.equal(replacement.getAttribute('aria-pressed'), 'true'); assert.equal(replacement.hidden, false);
  assert.equal(first.hidden, false); assert.equal(second.hidden, false);
  shell.cleanup(); assert.equal(f.doc.observers.size, 0); assert.equal(f.previews.listenerCount, 0);
  replacement.setAttribute('aria-pressed', 'false'); replacement.click(); assert.equal(replacement.getAttribute('aria-pressed'), 'false');
  f.untouched();
});

test('duplicate starts share bindings and pagehide/pageshow cycles cleanly rebind without duplicate input or form submission', () => {
  const f = fixture(), baseline = f.doc.allListenerCount, lifecycle = new FixtureTarget();
  let shell = startWorkspaceShell(f.doc.document);
  const bound = f.doc.allListenerCount;
  assert.equal(startWorkspaceShell(f.doc.document), shell); assert.equal(f.doc.allListenerCount, bound);
  lifecycle.addEventListener('pagehide', () => shell.cleanup());
  lifecycle.addEventListener('pageshow', event => { if ((event as PageTransitionEvent).persisted) shell = startWorkspaceShell(f.doc.document); });
  const pageshow = (persisted: boolean) => { const event = new Event('pageshow'); Object.defineProperty(event, 'persisted', { value: persisted }); lifecycle.dispatchEvent(event); };
  for (let cycle = 0; cycle < 3; cycle++) {
    f.draft.click(); assert.equal(f.inputs, cycle + 1);
    f.search.input('Assets');
    lifecycle.dispatchEvent(new Event('pagehide')); shell.cleanup();
    assert.equal(f.doc.allListenerCount, baseline); assert.equal(f.doc.observers.size, 0);
    assert.equal(f.doc.getElementById('workspace-search-results'), null);
    assert.equal(f.search.getAttribute('aria-controls'), null); assert.equal(f.search.getAttribute('aria-expanded'), null);
    const draft = f.composer.value; f.draft.setAttribute('data-draft', 'After hide'); f.draft.click(); assert.equal(f.composer.value, draft);
    pageshow(false); assert.equal(f.doc.allListenerCount, baseline);
    pageshow(true); assert.equal(f.doc.allListenerCount, bound); assert.equal(startWorkspaceShell(f.doc.document), shell);
    f.toggle.click(); assert.equal(f.sidebar.classList.contains('collapsed'), cycle % 2 === 0);
  }
  f.untouched(); shell.cleanup(); assert.equal(f.doc.allListenerCount, baseline);
});

test('discoverable shortcuts focus the composer, open the model picker, close the current tab and dismiss popovers through existing controls', () => {
  const f = fixture();
  const trigger = f.add('button', 'codex-model-trigger'), popover = f.add('div', 'codex-model-popover');
  let picks = 0; trigger.addEventListener('click', () => { picks++; popover.hidden = !popover.hidden; trigger.setAttribute('aria-expanded', String(!popover.hidden)); });
  popover.hidden = true; trigger.setAttribute('aria-expanded', 'false');
  const strip = f.add('div', 'workspace-chat-tabs'), wrap = f.add('span', '', strip), tab = f.add('button', '', wrap, 'Chat 1'), close = f.add('button', '', wrap, '×');
  tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', 'true');
  let closes = 0; close.addEventListener('click', () => closes++);
  f.composer.value = 'Keep this draft';
  const shell = startWorkspaceShell(f.doc.document);
  // Advertised to assistive technology on the controls themselves.
  assert.equal(f.composer.getAttribute('aria-keyshortcuts'), 'Control+/'); assert.equal(trigger.getAttribute('aria-keyshortcuts'), 'Control+Shift+M');
  assert.equal(f.search.getAttribute('aria-keyshortcuts'), 'Control+K');
  assert.equal(f.search.key('/', { ctrlKey: true }).defaultPrevented, true); assert.equal(f.doc.activeElement, f.composer);
  assert.equal(f.composer.value, 'Keep this draft'); assert.equal(f.inputs, 0);
  assert.equal(f.doc.body.key('M', { ctrlKey: true, shiftKey: true }).defaultPrevented, true); assert.equal(picks, 1); assert.equal(popover.hidden, false);
  assert.equal(f.doc.body.key('M', { ctrlKey: true, shiftKey: true }).defaultPrevented, true); assert.equal(picks, 1, 'An open picker stays open');
  assert.equal(f.doc.body.key('Escape').defaultPrevented, true); assert.equal(popover.hidden, true); assert.equal(picks, 2); assert.equal(f.doc.activeElement, trigger);
  assert.equal(f.doc.body.key('Escape').defaultPrevented, false, 'Nothing open: Escape is left alone');
  assert.equal(f.doc.body.key('w', { ctrlKey: true }).defaultPrevented, true); assert.equal(closes, 1);
  close.disabled = true; assert.equal(f.doc.body.key('w', { ctrlKey: true }).defaultPrevented, false); assert.equal(closes, 1, 'A busy tab keeps its close rule');
  close.disabled = false; const dialog = f.add('dialog', 'confirm-dialog'); dialog.setAttribute('open', '');
  assert.equal(f.doc.body.key('w', { ctrlKey: true }).defaultPrevented, false); assert.equal(f.doc.body.key('M', { ctrlKey: true, shiftKey: true }).defaultPrevented, false);
  assert.equal(closes, 1); assert.equal(picks, 2); dialog.remove();
  trigger.disabled = true; assert.equal(f.doc.body.key('M', { ctrlKey: true, shiftKey: true }).defaultPrevented, false);
  assert.equal(f.doc.body.key(',', { ctrlKey: true }).defaultPrevented, true);
  f.untouched(); shell.cleanup();
  assert.equal(f.doc.body.key('w', { ctrlKey: true }).defaultPrevented, false); assert.equal(closes, 1);
});
