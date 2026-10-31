/// <reference lib="dom" />
// C31 first-launch sign-in page: provider-setup presentation only (in-memory DOM/bridge doubles; no browser, native CLI,
// network or credentials). The view must go checking -> setup for a signed-out first launch, checking -> workspace for a
// usable sign-in, never show the workspace before the page or the page before the workspace, and "Continue without
// signing in" is remembered presentation that the checklist can reopen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startProviderSetup, readSignInPage, SIGN_IN_PAGE_KEY, type ProviderSetupState, type SetupProvider } from '../../apps/desktop/src/provider-setup.js';
import type { ProviderConnectionStatus } from '../../apps/desktop/src/codex-chat.js';

class Control {
  textContent = ''; value = ''; disabled = false; parentElement = null; tagName = 'DIV';
  attributes = new Map<string, string>();
  listeners = new Map<string, Set<(event: Event) => void>>();
  classes = new Set<string>();
  views: string[] = [];
  focused = 0;
  #hidden = false; hiddenLog: boolean[] = [];
  get hidden() { return this.#hidden; }
  set hidden(value: boolean) { if (value !== this.#hidden) this.hiddenLog.push(value); this.#hidden = value; }
  classList = { toggle: (name: string, force: boolean) => { if (force) this.classes.add(name); else this.classes.delete(name); }, contains: (name: string) => this.classes.has(name) };
  setAttribute(name: string, value: string) { if (name === 'data-provider-view' && this.views.at(-1) !== value) this.views.push(value); this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  addEventListener(name: string, listener: (event: Event) => void) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(listener);
  }
  removeEventListener(name: string, listener: (event: Event) => void) { this.listeners.get(name)?.delete(listener); }
  closest() { return null; } focus() { this.focused++; } scrollIntoView() {}
  emit(name: string, trusted = true) {
    for (const listener of this.listeners.get(name) ?? []) listener({ isTrusted: trusted, defaultPrevented: false } as Event);
  }
}
type Status = (provider: SetupProvider) => Promise<unknown>;
function fixture(options: { page?: boolean; stored?: Map<string, string>; status?: Status; connectSavedLogin?: () => Promise<void> } = {}) {
  const elements = new Map(['provider-setup-panel', 'provider-login-gate', 'provider-setup-provider',
    'provider-login-start', 'provider-login-refresh', 'provider-login-codex', 'provider-login-claude', 'provider-login-skip',
    'provider-login-message', 'provider-setup-status', 'provider-setup-details', 'provider-setup-refresh',
    'provider-setup-login', 'provider-setup-install', 'provider-setup-launch', 'workspace-stage', 'codex-connect', 'codex-disconnect',
    'provider-login-credits', 'provider-login-credits-note', 'codex-composer', 'codex-heading'].map(id => [id, new Control()]));
  elements.get('provider-login-skip')!.hidden = true; elements.get('provider-login-skip')!.hiddenLog.length = 0;
  const doc = new EventTarget() as EventTarget & { getElementById(id: string): Control | null; defaultView: unknown; documentElement: Control };
  doc.getElementById = id => elements.get(id) ?? null;
  doc.documentElement = new Control();
  const stored = options.stored ?? new Map<string, string>();
  doc.defaultView = { CustomEvent, location: { protocol: 'http:', origin: 'http://fixture.test' },
    localStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); }, removeItem: (key: string) => { stored.delete(key); } } };
  let connection: ProviderConnectionStatus | null = null, subscriber = () => {};
  const calls: string[] = [];
  const signedOut = (provider: SetupProvider) => ({ version: 1, provider, installed: true, auth: 'signed-out', cliVersion: '1.0.0', busy: false, message: null });
  const native = Object.freeze({ version: 1, ...Object.fromEntries(['status', 'login', 'install', 'launch'].map(action =>
    [action, async (provider: SetupProvider) => { calls.push(action + ':' + provider); return action === 'status' && options.status ? options.status(provider) : signedOut(provider); }])) });
  const controller = startProviderSetup(doc as unknown as Document, { autoSelectSignedIn: true, nativeBridge: native, ...(options.page === false ? {} : { signInPage: true }), chat: {
    providerConnectionStatus: () => connection,
    subscribeProviderStateChange(listener) { subscriber = listener; return () => { subscriber = () => {}; }; },
    ...(options.connectSavedLogin ? { connectForSavedLogin: options.connectSavedLogin } : {}),
  } });
  return { controller, calls, doc, stored,
    control: (id: string) => elements.get(id)!,
    view: () => elements.get('workspace-stage')!.attributes.get('data-provider-view'),
    views: () => elements.get('workspace-stage')!.views,
    connection(value: ProviderConnectionStatus | null) { connection = value; subscriber(); },
  };
}
const settled = async () => { for (let i = 0; i < 4; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
const subscription = (provider: SetupProvider): ProviderSetupState => ({ version: 1, provider, installed: true, auth: 'subscription', cliVersion: '1.0.0', busy: false, message: null });
const signedOutState = (provider: SetupProvider): ProviderSetupState => ({ version: 1, provider, installed: true, auth: 'signed-out', cliVersion: '1.0.0', busy: false, message: null });
const ready: ProviderConnectionStatus = { connected: true, ready: true, fresh: true, auth: 'subscription' };

test('the sign-in page memory accepts only its own bounded presentation shape', () => {
  assert.equal(readSignInPage('{"version":1,"state":"skipped"}'), 'skipped');
  assert.equal(readSignInPage('{"version":1,"state":"signed-in"}'), 'signed-in');
  for (const value of [null, '', '{}', '{"version":2,"state":"skipped"}', '{"version":1,"state":"admin"}', '{"version":1,"state":"skipped","token":"x"}',
    '{"version":1,"state":"skipped"}' + ' '.repeat(80), 'not json', 42]) assert.equal(readSignInPage(value), 'none', String(value));
});

test('fresh signed-out first launch: checking, then the full sign-in page with Continue without signing in; never the workspace', async t => {
  let release!: (value: unknown) => void;
  const f = fixture({ status: provider => provider === 'codex' ? new Promise(resolve => { release = resolve; }) : Promise.resolve(signedOutState(provider)) });
  t.after(() => f.controller.cleanup());
  assert.equal(f.view(), 'checking');
  assert.equal(f.control('provider-login-gate').hidden, true);
  assert.equal(f.doc.documentElement.attributes.get('data-provider-ready'), 'true');
  release(signedOutState('codex')); await settled();
  assert.equal(f.view(), 'setup');
  assert.equal(f.control('provider-login-gate').hidden, false);
  assert.equal(f.control('workspace-stage').classes.has('provider-required'), true);
  assert.equal(f.control('provider-login-skip').hidden, false);
  assert.deepEqual(f.views(), ['checking', 'setup'], 'no workspace before the page');
  assert.deepEqual(f.calls, ['status:codex', 'status:claude']);
  assert.equal(f.stored.has(SIGN_IN_PAGE_KEY), false);
  assert.equal(f.controller.isSignedIn(), false);
});

test('Continue without signing in opens the workspace, is remembered, grants nothing and the checklist step reopens the page', async t => {
  const f = fixture(); t.after(() => f.controller.cleanup()); await settled();
  assert.equal(f.view(), 'setup');
  f.control('provider-login-skip').emit('click', false); // untrusted clicks are ignored
  assert.equal(f.view(), 'setup');
  f.control('provider-login-skip').emit('click');
  assert.equal(f.view(), 'workspace');
  assert.equal(f.control('provider-login-gate').hidden, true);
  assert.equal(f.control('workspace-stage').classes.has('provider-required'), false);
  assert.equal(f.control('codex-composer').focused, 1, 'focus moves into the workspace (the message box)');
  assert.equal(f.controller.signInSkipped?.(), true);
  assert.equal(f.controller.isSignedIn(), false, 'skipping is never sign-in evidence');
  assert.equal(f.stored.get(SIGN_IN_PAGE_KEY), '{"version":1,"state":"skipped"}');
  assert.deepEqual(f.calls, ['status:codex', 'status:claude'], 'no native action from skipping');

  // Next launch: the remembered choice shows the workspace at once, with no splash or page in between.
  let release!: (value: unknown) => void;
  const next = fixture({ stored: f.stored, status: provider => provider === 'codex' ? new Promise(resolve => { release = resolve; }) : Promise.resolve(signedOutState(provider)) });
  t.after(() => next.controller.cleanup());
  assert.equal(next.view(), 'workspace');
  release(signedOutState('codex')); await settled();
  assert.deepEqual(next.views(), ['workspace']);

  // The checklist's Sign in step calls showSignIn() (exercised in Edge by sign-in-page-c31-browser): the page comes back.
  assert.equal(next.controller.showSignIn?.(), true);
  assert.equal(next.view(), 'setup');
  assert.equal(next.control('provider-login-gate').hidden, false);
  assert.equal(next.controller.signInSkipped?.(), false);
  assert.equal(next.stored.has(SIGN_IN_PAGE_KEY), false);
  assert.equal(next.controller.showSignIn?.(), false, 'nothing to reopen once the page shows');
});

test('sign-in success leaves the page for the workspace; signing out returns to the page', async t => {
  const f = fixture(); t.after(() => f.controller.cleanup()); await settled();
  assert.equal(f.view(), 'setup');
  f.connection(ready);
  assert.equal(f.view(), 'workspace');
  assert.equal(f.controller.isSignedIn(), true);
  assert.equal(f.stored.get(SIGN_IN_PAGE_KEY), '{"version":1,"state":"signed-in"}');
  f.connection({ ...ready, auth: 'signed-out' });
  assert.equal(f.view(), 'setup');
  assert.equal(f.control('provider-login-gate').hidden, false);
  assert.deepEqual(f.views(), ['checking', 'setup', 'workspace', 'setup']);
});

test('signing in after Continue without signing in clears the choice, so a later sign-out shows the page', async t => {
  const f = fixture(); t.after(() => f.controller.cleanup()); await settled();
  f.control('provider-login-skip').emit('click');
  assert.equal(f.view(), 'workspace');
  f.connection(ready);
  assert.equal(f.stored.get(SIGN_IN_PAGE_KEY), '{"version":1,"state":"signed-in"}');
  assert.equal(f.controller.signInSkipped?.(), false);
  f.connection({ ...ready, auth: 'signed-out' });
  assert.equal(f.view(), 'setup');
});

test('a saved Claude sign-in goes straight from checking to the workspace, with no page flash', async t => {
  const f = fixture({ status: provider => Promise.resolve(provider === 'claude' ? subscription('claude') : signedOutState('codex')) });
  t.after(() => f.controller.cleanup()); await settled();
  assert.equal(f.controller.chatSurface(), 'claude');
  assert.equal(f.view(), 'workspace');
  assert.deepEqual(f.views(), ['checking', 'workspace']);
  assert.equal(f.control('provider-login-gate').hiddenLog.includes(false), false, 'the page never showed');
  assert.equal(f.stored.get(SIGN_IN_PAGE_KEY), '{"version":1,"state":"signed-in"}');
});

test('first launch with a saved ChatGPT login: checking while metadata connects, then the workspace once it is usable', async t => {
  let resolve!: () => void;
  const f = fixture({ status: provider => Promise.resolve(provider === 'codex' ? subscription('codex') : signedOutState(provider)),
    connectSavedLogin: () => new Promise<void>(done => { resolve = done; }) });
  t.after(() => f.controller.cleanup()); await settled();
  assert.equal(f.view(), 'checking', 'a saved login alone does not open the workspace on first launch');
  assert.equal(f.control('provider-login-gate').hidden, true);
  f.connection(ready); resolve(); await settled();
  assert.equal(f.view(), 'workspace');
  assert.deepEqual(f.views(), ['checking', 'workspace']);
  assert.equal(f.control('provider-login-gate').hiddenLog.includes(false), false);
});

test('first launch with a saved ChatGPT login whose connection fails shows the page with the reason, not a workspace that says Sign in', async t => {
  let fail!: (error: Error) => void;
  const f = fixture({ status: provider => Promise.resolve(provider === 'codex' ? subscription('codex') : signedOutState(provider)),
    connectSavedLogin: () => new Promise<void>((_done, reject) => { fail = reject; }) });
  t.after(() => f.controller.cleanup()); await settled();
  assert.equal(f.view(), 'checking');
  fail(Error('Metadata unavailable')); await settled();
  assert.equal(f.view(), 'setup');
  assert.equal(f.control('provider-login-gate').hidden, false);
  assert.match(f.control('provider-login-message').textContent, /^Error 415 · Connection unavailable/);
  assert.match(f.control('provider-login-message').textContent, /Details: Metadata unavailable$/);
  assert.equal(f.controller.isSignedIn(), false);
  assert.equal(f.views().includes('workspace'), false);
  f.connection(ready);
  assert.equal(f.view(), 'workspace');
});

test('after a usable sign-in, a saved login keeps the workspace during held metadata (unchanged behaviour)', async t => {
  const stored = new Map([[SIGN_IN_PAGE_KEY, '{"version":1,"state":"signed-in"}']]);
  const f = fixture({ stored, status: provider => Promise.resolve(provider === 'codex' ? subscription('codex') : signedOutState(provider)),
    connectSavedLogin: () => new Promise<void>(() => {}) });
  t.after(() => f.controller.cleanup()); await settled();
  assert.equal(f.view(), 'workspace');
  assert.equal(f.controller.isSignedIn(), false);
});

test('without the option the page is the previous gate: no skip control, no memory, saved login opens the workspace', async t => {
  const f = fixture({ page: false, status: provider => Promise.resolve(provider === 'codex' ? subscription('codex') : signedOutState(provider)),
    connectSavedLogin: () => new Promise<void>(() => {}) });
  t.after(() => f.controller.cleanup()); await settled();
  assert.equal(f.view(), 'workspace');
  assert.equal(f.control('provider-login-skip').hidden, true);
  f.control('provider-login-skip').emit('click');
  assert.equal(f.stored.has(SIGN_IN_PAGE_KEY), false);
  assert.equal(f.controller.signInSkipped?.(), false);
  assert.equal(f.controller.showSignIn?.(), false);
});
