import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { win32, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';

// Executes the EXACT production main.cjs blocks (broker construction, human IPC mount, main-frame navigation
// cancellation and stopDaemon) in isolated VM contexts with scripted Electron/child/provider ports, plus the
// ACTUAL native-handoff-ipc.cjs and native-handoff-host.cjs. No Electron app, process, PowerShell, CLI or Studio.
const require = createRequire(import.meta.url);
const electronDir = new URL('../../apps/desktop/electron/', import.meta.url);
const mainSource = readFileSync(new URL('main.cjs', electronDir), 'utf8').replaceAll('\r\n', '\n');
const hostModule = require(fileURLToPath(new URL('native-handoff-host.cjs', electronDir)));
const ipcModule = require(fileURLToPath(new URL('native-handoff-ipc.cjs', electronDir)));
function block(begin, end) {
  const start = mainSource.indexOf(begin), stop = mainSource.indexOf(end, start + begin.length);
  assert.ok(start >= 0 && stop > start, 'expected the named production block: ' + begin.trim().slice(0, 50));
  return mainSource.slice(start, stop);
}
const origin = 'http://127.0.0.1:45871', token = 'b'.repeat(64);
const deferred = () => { let resolve, reject; const promise = new Promise((ok, no) => { resolve = ok; reject = no; }); return { promise, resolve, reject }; };

/** Evaluate the ACTUAL broker source inside the same VM realm as the main.cjs block (as in production, where both
 * share one realm; the broker correctly refuses cross-realm plain objects). */
function hostInRealm(context) {
  const source = readFileSync(new URL('native-handoff-host.cjs', electronDir), 'utf8');
  const factory = vm.runInContext('(function (module, exports, require) {\n' + source + '\n})', context);
  const module = { exports: {} };
  factory(module, module.exports, name => name === './native-handoff.cjs' ? require(new URL('native-handoff.cjs', electronDir).pathname.replace(/^\/([A-Za-z]:)/, '$1')) : require(name));
  return module.exports;
}
/** Production broker-construction block with captured (actual) broker ports. */
async function constructBroker(overrides = {}) {
  const code = block("  const handoffDirectory = await ownedDirectory(join(stateRoot, 'native-handoffs'));", '  if (projectSession.verificationUnavailable)');
  const projectSession = Object.freeze({ projectId: 'p', projectPath: 'C:\\Projects\\Door' });
  const providerCalls = [];
  const context = vm.createContext({
    // Runtime globals the Electron main realm provides to the broker (its default fetch port is never called here).
    fetch: globalThis.fetch, AbortController, AbortSignal, TextDecoder, Buffer,
    smoke: false, closing: false, switching: false, origin, token, projectSession, projectPath: 'C:\\Projects\\Door',
    nodeExecutable: 'C:\\Program Files\\Arcane\\resources\\node\\node.exe', productRoot: 'C:\\Program Files\\Arcane\\resources\\product',
    stateRoot: 'C:\\Users\\u\\AppData\\Roaming\\Arcane\\runtime\\projects\\abc', window: { isDestroyed: () => false }, nativeHandoff: null, captured: null,
    join: win32.join, ownedDirectory: async path => path,
    providerSetup: {
      getHandoffChoices: () => { providerCalls.push(['choices']); return Object.freeze({ cliVersion: '2.1.177', aliases: Object.freeze(['opus']), efforts: Object.freeze(['high']) }); },
      confirmHandoff: (profile, session) => { providerCalls.push(['confirm', profile, session]); return true; },
      launchHandoffTerminal: request => { providerCalls.push(['launch', request]); return 'opened'; },
    },
    require(name) { assert.equal(name, './native-handoff-host.cjs'); const actual = hostInRealm(context); return { createNativeHandoffHost(ports) { context.captured = ports; return actual.createNativeHandoffHost(ports); } }; },
    ...overrides,
  });
  await vm.runInContext('(async () => {\n' + code + '\n})()', context);
  return { context, ports: context.captured, providerCalls, projectSession };
}

test('broker construction passes exact private node/MCP/project/state paths and binds the session to this project epoch', async () => {
  const f = await constructBroker(), session = f.ports.getSession();
  assert.ok(f.context.nativeHandoff && typeof f.context.nativeHandoff.launch === 'function', 'the actual broker is mounted');
  assert.deepEqual({ ...session, epoch: undefined }, { projectPath: 'C:\\Projects\\Door', runtimeDirectory: win32.join(f.context.stateRoot, 'native-handoffs'),
    nodePath: f.context.nodeExecutable, mcpEntry: win32.join(f.context.productRoot, 'dist/apps/mcp/src/main.js'), origin, controlToken: token, epoch: undefined });
  assert.equal(session.epoch, f.projectSession, 'the opaque epoch is the exact projectSession object');
  for (const [what, change] of [['smoke', c => { c.smoke = true; }], ['closing', c => { c.closing = true; }], ['switching', c => { c.switching = true; }],
    ['no window', c => { c.window = null; }], ['destroyed window', c => { c.window = { isDestroyed: () => true }; }], ['no origin', c => { c.origin = ''; }],
    ['no human token', c => { c.token = ''; }], ['new project session', c => { c.projectSession = Object.freeze({ projectId: 'p' }); }]]) {
    const g = await constructBroker(); change(g.context); assert.equal(g.ports.getSession(), null, what);
  }
  const profile = Object.freeze({ provider: 'claude', model: 'opus', effort: 'high', cliVersion: '2.1.177' }), request = Object.freeze({ argv: [], env: {}, projectPath: 'x', epoch: {} });
  assert.deepEqual(f.ports.getChoices().aliases, ['opus']);
  assert.equal(await f.ports.confirm(profile, session), true); assert.equal(await f.ports.launchTerminal(request), 'opened');
  assert.deepEqual(f.providerCalls.map(call => call[0]), ['choices', 'confirm', 'launch']);
  assert.equal(f.providerCalls[1][1], profile, 'explicit profile passed through unchanged'); assert.equal(f.providerCalls[1][2], session);
  assert.equal(f.providerCalls[2][1], request, 'exact launch request (with its overlay) passed through unchanged');
  const none = await constructBroker({ providerSetup: null }); assert.equal(none.ports.getChoices(), null, 'no provider setup: no choices');
});

/** Production human IPC mount with the ACTUAL native-handoff-ipc.cjs and a scripted broker. */
function mountIpc() {
  const code = block("      require('./native-handoff-ipc.cjs').installNativeHandoffIpc(ipcMain, {", '      providerSetup = createProviderSetup(');
  const handlers = new Map(), calls = [];
  const frame = { url: origin + '/studio' }, contents = { isDestroyed: () => false, mainFrame: frame }, window = { isDestroyed: () => false, webContents: contents };
  const broker = name => Object.freeze({ launch: async input => { calls.push([name, 'launch', input]); return Object.freeze({ state: 'opened' }); },
    list: async () => { calls.push([name, 'list']); return Object.freeze({ state: 'listed' }); }, revoke: async id => { calls.push([name, 'revoke', id]); return Object.freeze({ state: 'revoked' }); } });
  const context = vm.createContext({ smoke: false, closing: false, switching: false, window, origin, token, projectSession: Object.freeze({ projectId: 'p' }), nativeHandoff: broker('first'),
    ipcMain: { handle(channel, handler) { handlers.set(channel, handler); } }, require(name) { assert.equal(name, './native-handoff-ipc.cjs'); return ipcModule; } });
  vm.runInContext(code, context);
  const event = (overrides = {}) => ({ sender: contents, senderFrame: frame, ...overrides });
  const invoke = (action, args, e = event()) => handlers.get('arcane:native-handoff-' + action)(e, ...args);
  return { context, handlers, calls, invoke, event, broker, frame, contents };
}

test('human IPC mounts in normal mode, delegates to the CURRENT broker, and refuses smoke/closing/switching/stale project/subframe contexts', async () => {
  const f = mountIpc(), id = randomUUID();
  assert.deepEqual([...f.handlers.keys()].sort(), ['arcane:native-handoff-launch', 'arcane:native-handoff-list', 'arcane:native-handoff-revoke']);
  assert.equal((await f.invoke('launch', [{ model: 'opus', effort: 'high' }])).state, 'opened');
  assert.equal((await f.invoke('list', [])).state, 'listed'); assert.equal((await f.invoke('revoke', [id])).state, 'revoked');
  assert.deepEqual(f.calls.map(c => c.slice(0, 2)), [['first', 'launch'], ['first', 'list'], ['first', 'revoke']]);
  assert.deepEqual({ ...f.calls[0][2] }, { model: 'opus', effort: 'high' }); assert.ok(Object.isFrozen(f.calls[0][2]), 'explicit frozen selection only');
  f.context.nativeHandoff = f.broker('second'); await f.invoke('list', []); assert.equal(f.calls.at(-1)[0], 'second', 'late-bound to the current broker');
  const before = f.calls.length;
  for (const [what, change, e] of [['smoke', c => { c.smoke = true; }], ['closing', c => { c.closing = true; }], ['switching', c => { c.switching = true; }],
    ['no broker', c => { c.nativeHandoff = null; }], ['no human token', c => { c.token = ''; }], ['foreign sender', () => {}, f.event({ sender: {} })],
    ['subframe', () => {}, f.event({ senderFrame: { url: origin + '/studio' } })], ['foreign frame url', () => {}, f.event({ senderFrame: f.frame, sender: f.contents })]]) {
    const g = mountIpc(); change(g.context);
    if (what === 'foreign frame url') g.frame.url = 'https://evil.example/';
    await assert.rejects(g.invoke('list', [], e ?? g.event()), /Native handoff is unavailable/, what); assert.equal(g.calls.length, 0, what + ': broker not reached');
  }
  const swap = mountIpc(); swap.context.nativeHandoff = Object.freeze({ ...swap.broker('first'), list: async () => { swap.context.projectSession = Object.freeze({ projectId: 'q' }); return { state: 'listed' }; } });
  await assert.rejects(swap.invoke('list', []), /Native handoff is unavailable/, 'project epoch changed across the await: the reply is withheld');
  for (const args of [[], [{ model: 'opus' }], [{ model: 'opus', effort: 'high', extra: 1 }], [{ model: 'opus 4', effort: 'high' }], ['x', 'y']]) await assert.rejects(f.invoke('launch', args), /unavailable/);
  assert.equal(f.calls.length, before, 'malformed launch envelopes never reach the broker');
});

test('main-frame navigation cancels broker and provider work; subframe navigation does not', () => {
  const code = block("  window.webContents.on('did-start-navigation'", "  window.webContents.on('render-process-gone'");
  const handlers = new Map(), counts = { handoff: 0, provider: 0 };
  const context = vm.createContext({ window: { webContents: { on(name, handler) { handlers.set(name, handler); } } },
    nativeHandoff: { cancelPending() { counts.handoff++; } }, providerSetup: { cancelPending() { counts.provider++; } } });
  vm.runInContext(code, context);
  const navigate = handlers.get('did-start-navigation');
  navigate({}, origin + '/x', false, false); assert.deepEqual(counts, { handoff: 0, provider: 0 }, 'subframe');
  navigate({}, origin + '/studio', false, true); assert.deepEqual(counts, { handoff: 1, provider: 1 }, 'main frame');
  context.nativeHandoff = null; navigate({}, origin + '/studio', true, true); assert.deepEqual(counts, { handoff: 1, provider: 2 }, 'no broker: provider still cancelled, no throw');
});

/** Production stopDaemon with a scripted owned child and broker. */
function stopFixture(child, broker) {
  const code = block('async function stopDaemon()', 'async function startDaemon(');
  const timers = [];
  const context = vm.createContext({ child, token, origin, nativeHandoff: broker, providerSetup: { cancelled: 0, cancelPending() { this.cancelled++; } },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {} });
  vm.runInContext(code + '\nglobalThis.stopOwned = stopDaemon;', context);
  return { context, timers };
}
function ownedChild() {
  const child = new EventEmitter(); child.exitCode = null; child.signalCode = null; child.connected = true; child.sent = []; child.killed = 0;
  child.send = (message, callback) => { child.sent.push(message); callback?.(null); }; child.kill = () => { child.killed++; };
  return child;
}

test('stopDaemon starts broker disposal and the daemon shutdown request together, clears authority first, and waits for cleanup before returning', async () => {
  const cleanup = deferred(), child = ownedChild(); let disposeCalls = 0;
  const broker = { dispose() { disposeCalls++; return cleanup.promise; }, cancelPending() {} };
  const f = stopFixture(child, broker);
  let returned = false; const stopping = f.context.stopOwned().then(value => { returned = true; return value; });
  // Synchronously, before any await completes: authority cleared, disposal started, shutdown requested.
  assert.deepEqual([f.context.nativeHandoff, f.context.token, f.context.origin, f.context.child], [null, '', '', null]);
  assert.equal(disposeCalls, 1, 'broker disposal initiated');
  assert.deepEqual(JSON.parse(JSON.stringify(child.sent)), [{ type: 'arcane-shutdown', protocolVersion: 1 }], 'daemon shutdown requested in the same turn, not after cleanup');
  assert.equal(f.context.providerSetup.cancelled, 1);
  child.emit('exit', 0); await Promise.resolve(); await Promise.resolve();
  assert.equal(returned, false, 'the daemon exited but config cleanup is still pending: stopDaemon has not returned');
  cleanup.resolve({ revoked: 0, unknown: 1, retained: 0 });
  assert.equal(await stopping, true); assert.equal(returned, true);
  // A rejected disposal never blocks or fails a clean shutdown.
  const failingChild = ownedChild(), rejected = stopFixture(failingChild, { dispose: () => Promise.reject(new Error('cleanup')), cancelPending() {} });
  const rejectedStop = rejected.context.stopOwned(); assert.equal(rejected.context.nativeHandoff, null);
  failingChild.emit('exit', 0); assert.equal(await rejectedStop, true);
  // No broker and no child still return; an already-exited child still waits for config cleanup.
  const none = stopFixture(null, null); assert.equal(await none.context.stopOwned(), true);
  const exited = ownedChild(); exited.exitCode = 0; const waitCleanup = deferred(); let done = false;
  const g = stopFixture(exited, { dispose: () => waitCleanup.promise, cancelPending() {} }); const p = g.context.stopOwned().then(v => { done = true; return v; });
  await Promise.resolve(); assert.equal(done, false, 'an already-exited child still waits for config cleanup'); waitCleanup.resolve(null); assert.equal(await p, true);
  assert.equal(exited.sent.length, 0, 'no shutdown message to an already-exited child');
});

test('actual broker dispose fans revocations out concurrently (bounded by its records), so one slow daemon is not multiplied', async () => {
  const pending = [], begun = [];
  let inflight = 0, peak = 0;
  const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  const projectId = 'a'.repeat(64), handoffs = new Map(), iso = () => new Date().toISOString();
  const fetchPort = async (url, init) => {
    const path = url.slice(origin.length), body = init.body ? JSON.parse(init.body) : undefined;
    if (path === '/v1/native-handoffs') return json(200, { projectId, handoffs: [] });
    if (path === '/v1/native-handoffs/begin') { const h = { handoffId: randomUUID(), state: 'pending', projectId, createdAt: iso(), expiresAt: iso(), sealedAt: null, endedAt: null }; handoffs.set(h.handoffId, h); begun.push(h.handoffId);
      return json(200, { handoff: h, credential: 'C'.repeat(43) }); }
    const h = handoffs.get(body.handoffId);
    if (path === '/v1/native-handoffs/seal') { h.state = 'sealed'; h.sealedAt = iso(); return json(200, { handoff: { ...h } }); }
    if (path === '/v1/native-handoffs/revoke') {
      inflight++; peak = Math.max(peak, inflight); const gate = deferred(); pending.push(gate);
      await gate.promise; inflight--; h.state = 'revoked'; h.endedAt = iso(); return json(200, { handoff: { ...h } });
    }
    return json(404, {});
  };
  let cleaned = 0;
  const host = hostModule.createNativeHandoffHost({
    getSession: () => ({ projectPath: resolve('/p'), runtimeDirectory: resolve('/r'), nodePath: resolve('/n.exe'), mcpEntry: resolve('/m.js'), origin, controlToken: token, epoch: sessionEpoch }),
    getChoices: () => ({ cliVersion: '2.1.177', aliases: ['opus'], efforts: ['high'] }), confirm: async () => true, launchTerminal: async () => 'opened', fetch: fetchPort,
    preparer: { prepare: async () => Object.freeze({ argv: Object.freeze(['--mcp-config', 'C:\\r\\x\\arcane.mcp.json']), env: Object.freeze({}) }), cleanup: async () => { cleaned++; return { state: 'removed' }; } } });
  for (let i = 0; i < 3; i++) assert.equal((await host.launch({ model: 'opus', effort: 'high' })).state, 'opened');
  const disposing = host.dispose();
  for (let spin = 0; spin < 50 && pending.length < 3; spin++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 3, 'all three revocations are in flight before any completes'); assert.equal(peak, 3);
  for (const gate of pending) gate.resolve();
  assert.deepEqual(await disposing, { revoked: 3, unknown: 0, retained: 0 }); assert.equal(cleaned, 3); assert.equal(begun.length, 3);
});
const sessionEpoch = Object.freeze({});
