/// <reference lib="dom" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { startProviderSetup, ARCANE_CREDITS_OFFER, ARCANE_CREDITS_TARGET, PROVIDER_PRESENTATION_KEY, type ProviderSetupState, type SetupProvider } from '../../apps/desktop/src/provider-setup.js';
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
function fixture(options: { autoSelect?: boolean; preferred?: SetupProvider; state?: Partial<ProviderSetupState>; connectSavedLogin?: () => Promise<void>; noBridge?: boolean } = {}) {
  const elements = new Map(['provider-setup-panel', 'provider-login-gate', 'provider-setup-provider',
    'provider-login-start', 'provider-login-refresh', 'provider-login-codex', 'provider-login-claude',
    'provider-login-message', 'provider-setup-status', 'provider-setup-details', 'provider-setup-refresh',
    'provider-setup-login', 'provider-setup-install', 'provider-setup-launch', 'workspace-stage', 'codex-connect', 'codex-disconnect',
    'provider-login-credits', 'provider-login-credits-note'].map(id => [id, new Control()]));
  const doc = new EventTarget() as EventTarget & { getElementById(id: string): Control | null; defaultView: unknown };
  doc.getElementById = id => elements.get(id) ?? null;
  const stored = new Map<string, string>();
  if (options.preferred) stored.set(PROVIDER_PRESENTATION_KEY, JSON.stringify({ version: 1, provider: options.preferred }));
  doc.defaultView = { CustomEvent, location: { protocol: 'http:', origin: 'http://fixture.test' },
    localStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) } };
  let connection: ProviderConnectionStatus | null = null, subscriber = () => {};
  let state: ProviderSetupState = { version: 1, provider: 'codex', installed: true,
    auth: 'signed-out', cliVersion: '0.162.0-alpha.17.2', busy: false, message: null, ...options.state };
  const calls: string[] = [];
  let reply: (() => Promise<unknown>) | null = null;
  const native = Object.freeze({ version: 1, ...Object.fromEntries(['status', 'login', 'install', 'launch'].map(action =>
    [action, async (provider: string) => { calls.push(action + ':' + provider); return reply ? reply() : { ...state, provider }; }])) });
  const controller = startProviderSetup(doc as unknown as Document, { ...(options.autoSelect ? { autoSelectSignedIn: true } : {}), nativeBridge: options.noBridge ? null : native, chat: {
    providerConnectionStatus: () => connection,
    subscribeProviderStateChange(listener) { subscriber = listener; return () => { subscriber = () => {}; }; },
    ...(options.connectSavedLogin ? { connectForSavedLogin: options.connectSavedLogin } : {}),
  } });
  return { controller, calls, doc, elements, stored,
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
  await settled();
  f.choose('codex'); f.controller.resume();
  assert.equal(f.controller.isSignedIn(), false); assert.deepEqual(f.calls, ['status:codex']); assert.deepEqual(changes, []);
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
  assert.deepEqual(f.calls, ['status:codex', 'status:codex']);
});

test('Claude sign-in requires a fresh non-busy native status ACK; expiry notifies without polling', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const f = fixture({ preferred: 'claude', state: { auth: 'subscription', busy: true } }); t.after(() => f.controller.cleanup());
  const changes: boolean[] = []; f.controller.subscribeSignInChange(() => changes.push(f.controller.isSignedIn()));
  await settled();
  assert.equal(f.controller.isSignedIn(), false); assert.deepEqual(changes, []);
  f.state({ busy: false }); f.control('provider-setup-refresh').emit('click'); await settled();
  assert.equal(f.controller.isSignedIn(), true); assert.deepEqual(changes, [true]);
  t.mock.timers.tick(60000); assert.equal(f.controller.isSignedIn(), true);
  t.mock.timers.tick(1); assert.equal(f.controller.isSignedIn(), false); assert.deepEqual(changes, [true, false]);
  assert.deepEqual(f.calls, ['status:claude', 'status:claude']);
});

test('handoff choices follow fresh Claude status, provider selection and lifecycle without automatic launch', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const choices = { cliVersion: '2.1.177', aliases: ['opus', 'sonnet'], efforts: ['high', 'max'] };
  const f = fixture({ preferred: 'claude', state: { auth: 'subscription', cliVersion: choices.cliVersion, claudeChoices: choices } });
  t.after(() => f.controller.cleanup());
  const changes: unknown[] = []; f.controller.subscribeHandoffChoices(() => changes.push(f.controller.handoffChoices()));
  await settled(); assert.deepEqual(f.controller.handoffChoices(), choices);
  assert.ok(Object.isFrozen(f.controller.handoffChoices()));
  assert.deepEqual(f.calls, ['status:claude']);
  t.mock.timers.tick(60001); assert.equal(f.controller.handoffChoices(), null); assert.equal(changes.at(-1), null);
  assert.deepEqual(f.calls, ['status:claude'], 'expiry never probes or launches');
  f.control('provider-setup-refresh').emit('click'); await settled(); assert.deepEqual(f.controller.handoffChoices(), choices);
  f.controller.stop(); assert.equal(f.controller.handoffChoices(), null);
  f.controller.resume(); await settled(); assert.deepEqual(f.controller.handoffChoices(), choices);
  f.choose('codex'); await settled(); assert.equal(f.controller.handoffChoices(), null);
  assert.ok(f.calls.every(call => call.startsWith('status:')), 'only explicit status and resume metadata reads');
});

test('cached auth from install cannot extend Claude metadata freshness or establish sign-in', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const f = fixture({ preferred: 'claude' }); t.after(() => f.controller.cleanup()); await settled(); f.state({ auth: 'subscription' });
  f.control('provider-setup-install').emit('click'); await settled(); assert.equal(f.controller.isSignedIn(), false);
  f.control('provider-setup-refresh').emit('click'); await settled(); assert.equal(f.controller.isSignedIn(), true);
  t.mock.timers.tick(50000); f.control('provider-setup-install').emit('click'); await settled();
  t.mock.timers.tick(10001); assert.equal(f.controller.isSignedIn(), false);
  f.control('provider-setup-install').emit('click'); await settled(); assert.equal(f.controller.isSignedIn(), false);
  f.state({ auth: 'api-or-cloud' }); f.control('provider-setup-refresh').emit('click'); await settled();
  assert.equal(f.controller.isSignedIn(), false); assert.equal(f.calls.length, 6);
});

test('provider/lifecycle changes notify, unsubscribe detaches, and missing mount has the same inert contract', async t => {
  const f = fixture(); t.after(() => f.controller.cleanup()); await settled(); const changes: boolean[] = [];
  f.controller.subscribeSignInChange(() => changes.push(f.controller.isSignedIn()));
  f.connection(connected); f.choose('claude'); await settled(); f.choose('codex'); await settled();
  f.controller.stop(); assert.equal(f.controller.isSignedIn(), false); f.controller.resume(); await settled();
  f.controller.cleanup(); f.controller.resume(); f.connection(connected);
  assert.deepEqual(changes, [true, false, true, false, true, false]); assert.deepEqual(f.calls, ['status:codex', 'status:claude', 'status:codex', 'status:codex']);
  const missing = startProviderSetup({ getElementById: () => null } as unknown as Document, {
    chat: { providerConnectionStatus: () => connected, subscribeProviderStateChange: () => () => {} },
  });
  assert.equal(missing.isSignedIn(), false); assert.doesNotThrow(missing.subscribeSignInChange(() => assert.fail()));
  missing.stop(); missing.resume(); missing.cleanup();
});

test('late Claude status replies and malformed states cannot notify sign-in after a provider epoch change', async t => {
  const f = fixture({ preferred: 'claude' }); t.after(() => f.controller.cleanup()); await settled();
  const changes: boolean[] = []; f.controller.subscribeSignInChange(() => changes.push(f.controller.isSignedIn()));
  let release!: (value: unknown) => void;
  f.reply(() => new Promise(resolve => { release = resolve; })); f.control('provider-setup-refresh').emit('click');
  f.choose('codex'); f.choose('claude');
  f.reply(async () => ({ version: 1, provider: 'claude', installed: true, auth: 'signed-out', busy: false, cliVersion: '1.0.0', message: null }));
  release({ version: 1, provider: 'claude', installed: true, auth: 'subscription', busy: false, cliVersion: '1.0.0', message: null });
  await settled(); assert.equal(f.controller.isSignedIn(), false); assert.deepEqual(changes, []);
  f.reply(async () => ({ version: 1, provider: 'claude', installed: true, auth: 'subscription', busy: false, cliVersion: '1.0.0', message: null, token: 'fixture' }));
  f.control('provider-setup-refresh').emit('click'); await settled(); assert.equal(f.controller.isSignedIn(), false); assert.deepEqual(changes, []);
});

test('mount recognizes saved CLI login and calls the optional metadata hook once per connection snapshot', async t => {
  let connections = 0;
  const f = fixture({ state: { auth: 'subscription' }, connectSavedLogin: async () => { connections++; } });
  t.after(() => f.controller.cleanup());
  assert.deepEqual(f.calls, ['status:codex']); assert.equal(connections, 0);
  await settled();
  assert.equal(connections, 1); assert.equal(f.control('provider-setup-status').textContent, 'ChatGPT signed in.');
  assert.equal(f.control('provider-setup-login').hidden, true);
  assert.equal(f.controller.isSignedIn(), false, 'CLI auth does not forge a ready native session');
  assert.equal(f.control('provider-login-gate').hidden, false);
  f.choose('codex'); f.controller.resume();
  for (let i = 0; i < 5; i++) { f.doc.dispatchEvent(new Event('input')); f.connection(null); }
  assert.deepEqual(f.calls, ['status:codex']); assert.equal(connections, 1);
  f.control('provider-setup-refresh').emit('click'); await settled(); assert.equal(connections, 1);
  f.connection({ connected: false, ready: false, fresh: true, auth: 'unknown' });
  assert.equal(connections, 1, 'a chat render cannot start a connection');
  f.control('provider-setup-refresh').emit('click'); await settled(); assert.equal(connections, 2);
  f.connection(connected); assert.equal(f.controller.isSignedIn(), true); assert.equal(f.control('provider-login-gate').hidden, true);
  f.control('provider-setup-refresh').emit('click'); await settled(); assert.equal(connections, 2);
  assert.ok(f.calls.every(call => call === 'status:codex'));
  assert.equal(f.stored.size, 1); assert.deepEqual(JSON.parse(f.stored.get(PROVIDER_PRESENTATION_KEY)!), { version: 1, provider: 'codex' });
});

test('remembered Claude preference probes only Claude and never invokes the Codex metadata hook', async t => {
  let connections = 0;
  const f = fixture({ preferred: 'claude', state: { auth: 'subscription' }, connectSavedLogin: async () => { connections++; } });
  t.after(() => f.controller.cleanup()); await settled();
  assert.deepEqual(f.calls, ['status:claude']); assert.equal(connections, 0);
  assert.equal(f.controller.isSignedIn(), true); assert.equal(f.control('provider-setup-launch').hidden, false);
  f.choose('claude'); assert.deepEqual(f.calls, ['status:claude']);
});

test('selection coalesces in-flight status to the latest provider and discards stale authentication', async t => {
  let connections = 0;
  const f = fixture({ connectSavedLogin: async () => { connections++; } }); t.after(() => f.controller.cleanup()); await settled();
  let release!: (value: unknown) => void;
  f.reply(() => new Promise(resolve => { release = resolve; }));
  f.control('provider-setup-refresh').emit('click');
  f.choose('claude'); f.choose('codex'); f.choose('claude');
  assert.deepEqual(f.calls, ['status:codex', 'status:codex']);
  f.reply(async () => ({ version: 1, provider: 'claude', installed: true, auth: 'subscription', busy: false, cliVersion: '1.0.0', message: null }));
  release({ version: 1, provider: 'codex', installed: true, auth: 'subscription', busy: false, cliVersion: '1.0.0', message: null });
  await settled();
  assert.deepEqual(f.calls, ['status:codex', 'status:codex', 'status:claude']); assert.equal(connections, 0);
  assert.equal(f.controller.isSignedIn(), true); assert.equal(f.control('provider-setup-provider').value, 'claude');
});

test('busy, API/cloud, signed-out, unavailable and hostile status cannot connect saved login', async t => {
  for (const state of [{ auth: 'subscription' as const, busy: true }, { auth: 'api-or-cloud' as const },
    { auth: 'signed-out' as const }, { installed: false, cliVersion: null, auth: 'unknown' as const }]) {
    let connections = 0;
    const f = fixture({ state, connectSavedLogin: async () => { connections++; } });
    await settled(); assert.equal(connections, 0); assert.equal(f.controller.isSignedIn(), false);
    assert.equal(f.control('provider-setup-launch').hidden, true);
    assert.equal(f.control('provider-setup-install').hidden, state.installed !== false);
    f.reply(async () => ({ version: 1, provider: 'codex', installed: true, auth: 'subscription', busy: false, cliVersion: '1', message: null, token: 'fixture' }));
    f.control('provider-setup-refresh').emit('click'); await settled();
    assert.equal(connections, 0); assert.match(f.control('provider-setup-status').textContent, /Setup unavailable/);
    f.controller.cleanup();
  }
  const browser = fixture({ noBridge: true }); t.after(() => browser.controller.cleanup());
  browser.choose('claude'); browser.controller.stop(); browser.controller.resume(); await settled();
  assert.deepEqual(browser.calls, []); assert.equal(browser.control('provider-login-start').disabled, true);
  assert.equal(browser.control('provider-setup-login').hidden, true);
  assert.equal(browser.control('provider-setup-install').hidden, true);
});

test('status expiry updates controls locally and resume performs exactly one new read', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const f = fixture({ preferred: 'claude', state: { auth: 'subscription' } }); t.after(() => f.controller.cleanup());
  const changes: boolean[] = []; f.controller.subscribeSignInChange(() => changes.push(f.controller.isSignedIn()));
  await settled(); assert.deepEqual(changes, [true]);
  t.mock.timers.tick(60001);
  assert.equal(f.controller.isSignedIn(), false); assert.equal(f.control('provider-setup-launch').hidden, true);
  assert.deepEqual(changes, [true, false]); assert.deepEqual(f.calls, ['status:claude']);
  f.controller.stop(); f.controller.resume(); f.controller.resume(); await settled();
  assert.deepEqual(f.calls, ['status:claude', 'status:claude']); assert.equal(f.controller.isSignedIn(), true);
  assert.deepEqual(changes, [true, false, true]);
});

test('status is bounded and late responses after timeout, stop or cleanup cannot connect', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  let connections = 0;
  const f = fixture({ connectSavedLogin: async () => { connections++; } }); t.after(() => f.controller.cleanup()); await settled();
  let release!: (value: unknown) => void;
  const saved = { version: 1, provider: 'codex', installed: true, auth: 'subscription', busy: false, cliVersion: '1', message: null };
  f.reply(() => new Promise(resolve => { release = resolve; })); f.control('provider-setup-refresh').emit('click');
  t.mock.timers.tick(35000); await settled();
  assert.equal(f.control('provider-login-start').disabled, false); assert.equal(f.control('provider-login-start').textContent, 'Check sign-in');
  release(saved); await settled(); assert.equal(connections, 0); assert.match(f.control('provider-setup-status').textContent, /Setup unavailable/);
  f.control('provider-setup-refresh').emit('click'); f.controller.stop(); release(saved); await settled(); assert.equal(connections, 0);
  f.reply(async () => ({ ...saved, auth: 'signed-out' })); f.controller.resume(); await settled();
  f.reply(() => new Promise(resolve => { release = resolve; })); f.control('provider-setup-refresh').emit('click');
  f.controller.cleanup(); release(saved); await settled(); assert.equal(connections, 0); assert.equal(f.controller.isSignedIn(), false);
});

test('metadata connection failure preserves observed auth and never loops on renders or refresh', async t => {
  let connections = 0;
  const f = fixture({ state: { auth: 'subscription' }, connectSavedLogin: async () => { connections++; throw Error('unavailable'); } });
  t.after(() => f.controller.cleanup()); await settled();
  assert.equal(connections, 1); assert.equal(f.controller.isSignedIn(), false);
  assert.match(f.control('provider-login-message').textContent, /Signed in\. Connection unavailable/);
  f.connection(null); f.control('provider-setup-refresh').emit('click'); await settled();
  assert.equal(connections, 1); assert.equal(f.control('provider-setup-status').textContent, 'ChatGPT signed in.');
});

test('pending saved-login metadata connects once, does not offer an extra Connect action, and ignores stale failure', async t => {
  let connections = 0, fail!: (reason: Error) => void;
  const f = fixture({ state: { auth: 'subscription' }, connectSavedLogin: () => {
    connections++; return new Promise((_resolve, reject) => { fail = reject; });
  } });
  t.after(() => f.controller.cleanup()); await settled();
  assert.equal(connections, 1); assert.equal(f.control('provider-login-start').textContent, 'Connecting Codex…');
  assert.equal(f.control('provider-login-start').disabled, true);
  f.connection({ connected: false, ready: false, fresh: true, auth: 'unknown' });
  f.control('provider-setup-refresh').emit('click'); await settled(); assert.equal(connections, 1, 'no overlapping hooks');
  f.choose('claude'); await settled(); fail(Error('previous connection unavailable')); await settled();
  assert.equal(f.control('provider-setup-status').textContent, 'Claude Code signed in.');
  assert.equal(f.control('provider-login-start').textContent, 'Open Claude Code');
  assert.deepEqual(f.calls, ['status:codex', 'status:codex', 'status:claude']);
});

test('ChatGPT browser labels and sanitized native pending/failure messages remain visible in the sign-in card', async t => {
  const f = fixture(); t.after(() => f.controller.cleanup());
  assert.equal(f.control('provider-login-start').textContent, 'Checking sign-in…');
  assert.equal(f.control('provider-login-start').disabled, true);
  await settled();
  assert.equal(f.control('provider-login-start').textContent, 'Sign in with ChatGPT');
  assert.equal(f.control('provider-setup-login').textContent, 'Sign in with ChatGPT');
  assert.match(f.control('provider-login-message').textContent, /ChatGPT in your browser/);
  f.control('provider-login-start').emit('click', false); assert.deepEqual(f.calls, ['status:codex']);
  const pending = 'Complete ChatGPT sign-in in your browser. Authentication is not yet verified.';
  f.state({ auth: 'unknown', busy: true, message: pending }); f.control('provider-login-start').emit('click'); await settled();
  assert.equal(f.control('provider-login-message').textContent, pending); assert.equal(f.controller.isSignedIn(), false);
  assert.equal(f.control('provider-login-start').textContent, 'Check sign-in');
  const failure = 'Native browser sign-in expired. No completion was verified.';
  f.state({ busy: false, message: failure }); f.control('provider-login-start').emit('click'); await settled();
  assert.equal(f.control('provider-login-message').textContent, failure); assert.equal(f.controller.isSignedIn(), false);
});

// Sign in once: a saved sign-in on the other provider is used automatically until the human picks explicitly.
const signedInOnly = (f: ReturnType<typeof fixture>, signed: SetupProvider) => f.reply(async () => {
  const provider = f.calls.at(-1)!.split(':')[1] as SetupProvider;
  return { version: 1, provider, installed: true, auth: provider === signed ? 'subscription' : 'signed-out', cliVersion: '2.1.301', busy: false, message: null };
});
test('startup switches to the provider that already reports a saved sign-in', async t => {
  const f = fixture({ autoSelect: true }); t.after(() => f.controller.cleanup());
  signedInOnly(f, 'claude');
  for (let i = 0; i < 10; i++) await settled();
  assert.deepEqual(f.calls.slice(0, 3), ['status:codex', 'status:claude', 'status:claude']);
  assert.equal(f.controller.chatSurface(), 'claude');
  assert.equal(JSON.parse(f.stored.get(PROVIDER_PRESENTATION_KEY)!).provider, 'claude');
});
test('an explicit provider choice is never overridden by automatic selection', async t => {
  const f = fixture({ autoSelect: true }); t.after(() => f.controller.cleanup());
  f.reply(() => new Promise(() => {})); // hold the startup status
  f.control('provider-login-codex').emit('click');
  signedInOnly(f, 'claude');
  f.control('provider-setup-refresh').emit('click');
  for (let i = 0; i < 10; i++) await settled();
  assert.equal(f.calls.includes('status:claude'), false);
  assert.equal(f.controller.chatSurface(), 'codex');
});
test('no switch happens when neither provider reports a saved sign-in', async t => {
  const f = fixture({ autoSelect: true }); t.after(() => f.controller.cleanup());
  for (let i = 0; i < 10; i++) await settled();
  assert.deepEqual(f.calls, ['status:codex', 'status:claude']);
  assert.equal(f.controller.chatSurface(), 'codex');
});

test('a temporary connection outage preserves the chat surface without presenting stale state as signed in',async t=>{
  const f=fixture({state:{auth:'subscription'}});t.after(()=>f.controller.cleanup());await settled();
  f.connection(connected);assert.equal(f.control('provider-login-gate').hidden,true);
  f.connection({...connected,fresh:false});
  assert.equal(f.controller.isSignedIn(),false,'stale state grants no authority');
  assert.equal(f.control('provider-login-gate').hidden,true,'an interrupted read does not log the person out');
  f.connection({...connected,auth:'signed-out'});
  assert.equal(f.control('provider-login-gate').hidden,false,'a confirmed sign-out still closes the gate');
});

test('unknown native status offers a check instead of another login',async t=>{
  const f=fixture({state:{auth:'unknown'}});t.after(()=>f.controller.cleanup());await settled();
  assert.equal(f.control('provider-login-start').textContent,'Check sign-in');
  assert.ok(f.calls.every(call=>call.startsWith('status:')));
});

test('saved sign-in retries metadata connection after an outage and stops once connected',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:100000});
  let attempts=0;
  const f=fixture({state:{auth:'subscription'},connectSavedLogin:async()=>{attempts++;if(attempts===1)throw Error('Temporary outage');f.connection(connected);}});
  t.after(()=>f.controller.cleanup());await settled();assert.equal(attempts,1);
  t.mock.timers.tick(5000);await settled();await settled();
  assert.equal(attempts,2);assert.equal(f.control('provider-login-gate').hidden,true);
  t.mock.timers.tick(120000);await settled();assert.equal(attempts,2);
  f.controller.stop();t.mock.timers.tick(120000);await settled();assert.equal(attempts,2);
  assert.ok(f.calls.every(call=>call==='status:codex'),'recovery never starts login or a model turn');
});

test('a transient Claude status failure preserves an already open chat but not handoff freshness',async t=>{
  const f=fixture({preferred:'claude',state:{auth:'subscription'}});t.after(()=>f.controller.cleanup());await settled();
  assert.equal(f.controller.chatSurface(),'claude');
  f.reply(async()=>{throw Error('CLI temporarily unavailable');});f.control('provider-setup-refresh').emit('click');await settled();
  assert.equal(f.controller.chatSurface(),'claude');assert.equal(f.controller.isSignedIn(),false);assert.equal(f.controller.handoffChoices(),null);
  f.reply(async()=>({version:1,provider:'claude',installed:true,auth:'signed-out',busy:false,cliVersion:'1',message:null}));
  f.control('provider-setup-refresh').emit('click');await settled();assert.equal(f.controller.chatSurface(),'codex');
});

test('unknown Claude status cannot open a chat without a prior subscription acknowledgement',async t=>{
  const f=fixture({preferred:'claude',state:{auth:'unknown'}});t.after(()=>f.controller.cleanup());await settled();
  assert.equal(f.controller.chatSurface(),'codex');assert.equal(f.controller.isSignedIn(),false);
  assert.equal(f.control('provider-login-start').textContent,'Check sign-in');
});

test('confirmed sign-out cancels saved-login recovery and never starts browser login',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:100000});let attempts=0;
  const f=fixture({state:{auth:'subscription'},connectSavedLogin:async()=>{attempts++;throw Error('Offline');}});
  t.after(()=>f.controller.cleanup());await settled();assert.equal(attempts,1);
  f.state({auth:'signed-out'});f.control('provider-setup-refresh').emit('click');await settled();
  assert.equal(f.control('provider-login-start').textContent,'Sign in with ChatGPT');
  t.mock.timers.tick(120000);await settled();assert.equal(attempts,1);
  assert.equal(f.control('provider-login-start').textContent,'Check sign-in','expired evidence is checked again before another login');
  assert.ok(f.calls.every(call=>call==='status:codex'));
});

test('explicit disconnect is retained across background status checks',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:100000});let attempts=0;
  const f=fixture({state:{auth:'subscription'},connectSavedLogin:async()=>{attempts++;}});
  t.after(()=>f.controller.cleanup());await settled();assert.equal(attempts,1);
  f.connection(connected);f.control('codex-disconnect').emit('click');f.connection(null);
  f.control('provider-setup-refresh').emit('click');await settled();
  t.mock.timers.tick(120000);await settled();assert.equal(attempts,1);
  assert.ok(f.calls.every(call=>call==='status:codex'));
});

test('first run without a CLI or subscription: the card offers the install steps, an honest API-key note and Arcane Credits', async t => {
  // Not installed: one click opens the official install steps (native confirm), then the card checks again.
  const f = fixture({ state: { installed: false, auth: 'unknown', cliVersion: null } }); t.after(() => f.controller.cleanup()); await settled();
  const start = f.control('provider-login-start');
  assert.equal(start.textContent, 'Get Codex'); assert.equal(start.disabled, false);
  assert.match(f.control('provider-login-message').textContent, /^Codex is not installed on this PC yet\. Click Get Codex/);
  start.emit('click'); await settled();
  assert.deepEqual(f.calls, ['status:codex', 'install:codex']);
  assert.equal(start.textContent, 'Check sign-in', 'after the install steps open, the next click re-checks');
  start.emit('click'); await settled();
  assert.deepEqual(f.calls.at(-1), 'status:codex'); assert.equal(start.textContent, 'Get Codex', 'still missing: offer the steps again');
  start.emit('click', false); await settled(); assert.equal(f.calls.length, 3, 'synthetic clicks do nothing');
  // An API-key or cloud sign-in is not a subscription: say so and offer the subscription sign-in instead of a check loop.
  f.state({ installed: true, auth: 'api-or-cloud', cliVersion: '1.0.0' }); f.control('provider-setup-refresh').emit('click'); await settled();
  assert.equal(start.textContent, 'Sign in with ChatGPT'); assert.match(f.control('provider-login-message').textContent, /API key or cloud account.*ChatGPT subscription.*Arcane Credits/);
  assert.equal(f.controller.isSignedIn(), false);

  // No subscription: a plain line about what Arcane Credits still need, then the account step, then a one-click switch.
  const credits = f.control('provider-login-credits'), note = f.control('provider-login-credits-note');
  const requests: unknown[] = []; f.doc.addEventListener('workspace:settingsrequest', event => requests.push((event as CustomEvent).detail));
  assert.equal(note.textContent, ARCANE_CREDITS_OFFER.none.note); assert.match(note.textContent, /not connected to an Arcane Credits service/);
  credits.emit('click'); assert.deepEqual(requests, [{ target: ARCANE_CREDITS_TARGET }]); assert.equal(f.controller.chatSurface(), 'codex');
  f.controller.setArcaneSetup?.('signed-out');
  assert.equal(credits.textContent, 'Connect Arcane account'); assert.equal(note.textContent, ARCANE_CREDITS_OFFER['signed-out'].note);
  f.controller.setArcaneAvailable(true);
  assert.equal(credits.textContent, 'Use Arcane Credits');
  credits.emit('click', false); assert.equal(f.controller.chatSurface(), 'codex', 'synthetic clicks never switch');
  credits.emit('click'); assert.equal(f.controller.chatSurface(), 'arcane'); assert.equal(f.control('provider-login-gate').hidden, true);
  assert.equal(requests.length, 1);
});
