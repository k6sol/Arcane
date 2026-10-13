/// <reference lib="dom" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { startProviderSetup, type ProviderSetupState } from '../../apps/desktop/src/provider-setup.js';
import type { ProviderConnectionStatus } from '../../apps/desktop/src/codex-chat.js';

// In-memory DOM/bridge doubles only: no browser, native CLI, network or credentials.
class Control {
  textContent = ''; value = ''; disabled = false; hidden = false; parentElement = null;
  attributes = new Map<string, string>();
  listeners = new Map<string, Set<(event: Event) => void>>();
  classList = { toggle() {} };
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  addEventListener(name: string, listener: (event: Event) => void) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(listener);
  }
  removeEventListener(name: string, listener: (event: Event) => void) { this.listeners.get(name)?.delete(listener); }
  closest() { return null; } focus() {}
  emit(name: string, trusted = true) {
    for (const listener of this.listeners.get(name) ?? []) listener({ isTrusted: trusted, defaultPrevented: false } as Event);
  }
  click() { this.emit('click', false); }
}
function fixture() {
  const elements = new Map(['provider-setup-panel', 'provider-login-gate', 'provider-setup-provider',
    'provider-login-start', 'provider-login-refresh', 'provider-login-codex', 'provider-login-claude',
    'provider-login-message', 'provider-setup-status', 'provider-setup-details', 'provider-setup-refresh',
    'provider-setup-login', 'provider-setup-install', 'provider-setup-launch', 'workspace-stage', 'codex-connect'].map(id => [id, new Control()]));
  const doc = new EventTarget() as EventTarget & { getElementById(id: string): Control | null; defaultView: unknown };
  doc.getElementById = id => elements.get(id) ?? null;
  doc.defaultView = { CustomEvent, location: { protocol: 'file:' } };
  let connection: ProviderConnectionStatus | null = null, subscriber = () => {};
  let state: ProviderSetupState = { version: 1, provider: 'codex', installed: true,
    auth: 'signed-out', cliVersion: '0.162.0-alpha.17.2', busy: false, message: null };
  const calls: string[] = [];
  let reply: (() => Promise<unknown>) | null = null;
  const native = Object.freeze({ version: 1, ...Object.fromEntries(['status', 'login', 'install', 'launch'].map(action =>
    [action, async (provider: string) => { calls.push(action + ':' + provider); return reply ? reply() : { ...state, provider }; }])) });
  const controller = startProviderSetup(doc as unknown as Document, { nativeBridge: native, chat: {
    providerConnectionStatus: () => connection,
    subscribeProviderStateChange(listener) { subscriber = listener; return () => { subscriber = () => {}; }; },
  } });
  return { controller, calls, doc, elements,
    control: (id: string) => elements.get(id)!,
    choose(provider: string) { doc.dispatchEvent(new CustomEvent('workspace:providerpreference', { detail: { provider } })); },
    connection(value: ProviderConnectionStatus | null) { connection = value; subscriber(); },
    state(value: Partial<ProviderSetupState>) { state = { ...state, ...value }; },
    reply(value: () => Promise<unknown>) { reply = value; },
  };
}
const settled = async () => { await new Promise<void>(resolve => setImmediate(resolve)); };
const connected: ProviderConnectionStatus = { connected: true, ready: true, fresh: true, auth: 'subscription' };

test('sign-in observer requires actual fresh ready Codex connection and not a preference or login snapshot', async t => {
  const f = fixture(); t.after(() => f.controller.cleanup());
  const changes: boolean[] = [], unsubscribe = f.controller.subscribeSignInChange(() => changes.push(f.controller.isSignedIn()));
  f.choose('claude'); f.choose('codex'); f.controller.resume();
  assert.equal(f.controller.isSignedIn(), false); assert.deepEqual(f.calls, []); assert.deepEqual(changes, []);
  f.state({ auth: 'subscription' }); f.control('provider-setup-refresh').emit('click'); await settled();
  assert.equal(f.controller.isSignedIn(), false); assert.deepEqual(changes, []);
  for (const value of [{ ...connected, ready: false }, { ...connected, connected: false },
    { ...connected, fresh: false }, { ...connected, auth: 'signed-out' as const }]) {
    f.connection(value); assert.equal(f.controller.isSignedIn(), false);
  }
  f.connection(connected); assert.equal(f.controller.isSignedIn(), true); assert.deepEqual(changes, [true]);
  f.connection({ ...connected }); assert.deepEqual(changes, [true], 'unchanged renders do not notify');
  f.connection({ ...connected, fresh: false }); assert.deepEqual(changes, [true, false]);
  unsubscribe(); f.connection(connected); assert.deepEqual(changes, [true, false]);
  assert.deepEqual(f.calls, ['status:codex']);
});

test('Claude sign-in requires a fresh non-busy native status ACK; expiry notifies without polling', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const f = fixture(); t.after(() => f.controller.cleanup()); f.choose('claude');
  const changes: boolean[] = []; f.controller.subscribeSignInChange(() => changes.push(f.controller.isSignedIn()));
  f.state({ auth: 'subscription', busy: true }); f.control('provider-setup-refresh').emit('click'); await settled();
  assert.equal(f.controller.isSignedIn(), false); assert.deepEqual(changes, []);
  f.state({ busy: false }); f.control('provider-setup-refresh').emit('click'); await settled();
  assert.equal(f.controller.isSignedIn(), true); assert.deepEqual(changes, [true]);
  t.mock.timers.tick(60000); assert.equal(f.controller.isSignedIn(), true);
  t.mock.timers.tick(1); assert.equal(f.controller.isSignedIn(), false); assert.deepEqual(changes, [true, false]);
  assert.deepEqual(f.calls, ['status:claude', 'status:claude']);
});

test('cached auth from install cannot extend Claude metadata freshness or establish sign-in', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const f = fixture(); t.after(() => f.controller.cleanup()); f.choose('claude'); f.state({ auth: 'subscription' });
  f.control('provider-setup-install').emit('click'); await settled(); assert.equal(f.controller.isSignedIn(), false);
  f.control('provider-setup-refresh').emit('click'); await settled(); assert.equal(f.controller.isSignedIn(), true);
  t.mock.timers.tick(50000); f.control('provider-setup-install').emit('click'); await settled();
  t.mock.timers.tick(10001); assert.equal(f.controller.isSignedIn(), false);
  f.control('provider-setup-install').emit('click'); await settled(); assert.equal(f.controller.isSignedIn(), false);
  f.state({ auth: 'api-or-cloud' }); f.control('provider-setup-refresh').emit('click'); await settled();
  assert.equal(f.controller.isSignedIn(), false); assert.equal(f.calls.length, 5);
});

test('provider/lifecycle changes notify, unsubscribe detaches, and missing mount has the same inert contract', t => {
  const f = fixture(); t.after(() => f.controller.cleanup()); const changes: boolean[] = [];
  f.controller.subscribeSignInChange(() => changes.push(f.controller.isSignedIn()));
  f.connection(connected); f.choose('claude'); f.choose('codex');
  f.controller.stop(); assert.equal(f.controller.isSignedIn(), false); f.controller.resume();
  f.controller.cleanup(); f.controller.resume(); f.connection(connected);
  assert.deepEqual(changes, [true, false, true, false, true, false]); assert.deepEqual(f.calls, []);
  const missing = startProviderSetup({ getElementById: () => null } as unknown as Document, {
    chat: { providerConnectionStatus: () => connected, subscribeProviderStateChange: () => () => {} },
  });
  assert.equal(missing.isSignedIn(), false); assert.doesNotThrow(missing.subscribeSignInChange(() => assert.fail()));
  missing.stop(); missing.resume(); missing.cleanup();
});

test('late Claude status replies and malformed states cannot notify sign-in after a provider epoch change', async t => {
  const f = fixture(); t.after(() => f.controller.cleanup()); f.choose('claude');
  const changes: boolean[] = []; f.controller.subscribeSignInChange(() => changes.push(f.controller.isSignedIn()));
  let release!: (value: unknown) => void;
  f.reply(() => new Promise(resolve => { release = resolve; })); f.control('provider-setup-refresh').emit('click');
  f.choose('codex'); f.choose('claude');
  release({ version: 1, provider: 'claude', installed: true, auth: 'subscription', busy: false, cliVersion: '1.0.0', message: null });
  await settled(); assert.equal(f.controller.isSignedIn(), false); assert.deepEqual(changes, []);
  f.reply(async () => ({ version: 1, provider: 'claude', installed: true, auth: 'subscription', busy: false, cliVersion: '1.0.0', message: null, token: 'fixture' }));
  f.control('provider-setup-refresh').emit('click'); await settled(); assert.equal(f.controller.isSignedIn(), false); assert.deepEqual(changes, []);
});

test('ChatGPT browser labels and sanitized native pending/failure messages remain visible in the sign-in card', async t => {
  const f = fixture(); t.after(() => f.controller.cleanup());
  assert.equal(f.control('provider-login-start').textContent, 'Sign in with ChatGPT');
  assert.equal(f.control('provider-setup-login').textContent, 'Sign in with ChatGPT');
  assert.match(f.control('provider-login-message').textContent, /ChatGPT in your browser/);
  f.control('provider-login-start').emit('click', false); assert.deepEqual(f.calls, []);
  const pending = 'Complete ChatGPT sign-in in your browser. Authentication is not yet verified.';
  f.state({ auth: 'unknown', busy: true, message: pending }); f.control('provider-login-start').emit('click'); await settled();
  assert.equal(f.control('provider-login-message').textContent, pending); assert.equal(f.controller.isSignedIn(), false);
  assert.equal(f.control('provider-login-start').textContent, 'Check sign-in');
  const failure = 'Native browser sign-in expired. No completion was verified.';
  f.state({ busy: false, message: failure }); f.control('provider-login-start').emit('click'); await settled();
  assert.equal(f.control('provider-login-message').textContent, failure); assert.equal(f.controller.isSignedIn(), false);
});
