import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const { installNativeHandoffIpc } = require('../../apps/desktop/electron/native-handoff-ipc.cjs');

// Real IPC adapter and navigation policy, scripted Electron event and host ports only.
function fixture() {
  const handlers = new Map(), calls = [];
  const frame = { url: 'http://127.0.0.1:45871/studio#' + 'a'.repeat(64) };
  const contents = { mainFrame: frame, isDestroyed: () => false };
  const window = { webContents: contents, isDestroyed: () => false };
  const state = { session: { window, origin: 'http://127.0.0.1:45871', epoch: {} } };
  const event = { sender: contents, senderFrame: frame };
  const host = Object.fromEntries(['launch', 'list', 'revoke'].map(action => [action, async (...args) => {
    calls.push({ action, args }); return { state: action === 'list' ? 'listed' : action === 'launch' ? 'opened' : 'revoked' };
  }]));
  installNativeHandoffIpc({ handle: (channel, fn) => handlers.set(channel, fn) }, { getSession: () => state.session, host });
  return { handlers, calls, event, state, frame, contents, window, host,
    invoke: (action, ...args) => handlers.get('arcane:native-handoff-' + action)(event, ...args) };
}
const id = 'a1223344-5566-7788-99aa-bbccddeeff00';
const profile = { model: 'opus', effort: 'high' };

test('human handoff IPC forwards only explicit bounded intents to its host', async () => {
  const f = fixture();
  assert.deepEqual([...f.handlers.keys()], ['launch','list','revoke'].map(action => 'arcane:native-handoff-' + action));
  assert.equal((await f.invoke('launch', profile)).state, 'opened');
  assert.equal((await f.invoke('list')).state, 'listed');
  assert.equal((await f.invoke('revoke', id)).state, 'revoked');
  assert.deepEqual(f.calls, [{ action: 'launch', args: [profile] }, { action: 'list', args: [] }, { action: 'revoke', args: [id] }]);
  assert.ok(Object.isFrozen(f.calls[0].args[0]));
});

test('handoff IPC refuses another sender, subframe, origin, navigation or unavailable session before any host action', async () => {
  for (const mutate of [f => { f.event.sender = {}; }, f => { f.event.senderFrame = { ...f.frame }; },
    f => { f.frame.url = 'https://example.invalid/studio'; }, f => { f.frame.url = f.state.session.origin + '/other'; },
    f => { f.state.session = null; }, f => { f.state.session.epoch = null; },
    f => { f.contents.isDestroyed = () => true; }, f => { f.window.isDestroyed = () => true; }]) {
    for (const action of ['launch', 'list', 'revoke']) {
      const f = fixture(); mutate(f);
      await assert.rejects(f.invoke(action, ...(action === 'launch' ? [profile] : action === 'revoke' ? [id] : [])), /^Error: Native handoff is unavailable\.$/);
      assert.equal(f.calls.length, 0);
    }
  }
});

test('handoff IPC rejects extra arguments, credentials, accessors and proxies without invoking them', async () => {
  const f = fixture(); let reads = 0;
  const accessor = Object.defineProperty({ effort: 'high' }, 'model', { enumerable: true, get() { reads++; return 'opus'; } });
  const proxy = new Proxy(profile, { getPrototypeOf() { reads++; return Object.prototype; } });
  for (const args of [[], [null], [profile, 1], [{ model: 'opus' }], [{ ...profile, token: 'a'.repeat(64) }],
    [{ ...profile, effort: '--permission-mode' }], [accessor], [proxy], [{ ...profile, model: 'a'.repeat(65) }]])
    await assert.rejects(f.invoke('launch', ...args), /Native handoff is unavailable/);
  for (const args of [[id], [null], [{}]]) await assert.rejects(f.invoke('list', ...args), /unavailable/);
  for (const args of [[], [profile], [id, 1], ['a'.repeat(64)]]) await assert.rejects(f.invoke('revoke', ...args), /unavailable/);
  assert.equal(reads, 0); assert.equal(f.calls.length, 0);
});

test('held handoff replies are not delivered after a project, window, frame or navigation change', async () => {
  for (const mutate of [f => { f.state.session = { ...f.state.session, epoch: {} }; },
    f => { f.state.session = null; }, f => { f.frame.url += 'b'; },
    f => { f.contents.mainFrame = { ...f.frame }; }, f => { f.state.session = { ...f.state.session, window: { ...f.window } }; }]) {
    for (const action of ['launch', 'list', 'revoke']) {
      const f = fixture(); let release;
      f.host[action] = () => new Promise(resolve => { release = resolve; });
      const pending = f.invoke(action, ...(action === 'launch' ? [profile] : action === 'revoke' ? [id] : []));
      mutate(f); release({ state: 'opened', marker: 'stale' });
      await assert.rejects(pending, /Native handoff is unavailable/);
    }
  }
});

async function preloadFixture() {
  const calls = [], context = vm.createContext({});
  context.require = name => {
    assert.equal(name, 'electron');
    return { contextBridge: { exposeInMainWorld: (_name, bridge) => { context.bridge = bridge; } },
      ipcRenderer: { invoke: async (channel, ...args) => {
        calls.push({ channel, args: JSON.parse(JSON.stringify(args)) });
        return vm.runInContext('JSON.parse(reply)', context);
      } } };
  };
  vm.runInContext(await readFile(new URL('../../apps/desktop/electron/preload.cjs', import.meta.url), 'utf8'), context);
  const invoke = async (action, args, reply) => {
    context.reply = JSON.stringify(reply); context.args = JSON.stringify(args);
    return JSON.parse(JSON.stringify(await vm.runInContext('bridge.nativeHandoff.' + action + '(...JSON.parse(args))', context)));
  };
  return { context, calls, invoke };
}
const opened = { state: 'opened', reason: null, message: 'Terminal opened.', handoffId: id, expiresAt: '2026-10-16T08:00:00.000Z' };
test('real preload exposes a separate frozen handoff bridge and accepts only bounded metadata replies', async () => {
  const f = await preloadFixture();
  assert.equal(vm.runInContext('Object.isFrozen(bridge)&&Object.isFrozen(bridge.nativeHandoff)', f.context), true);
  assert.deepEqual(Object.keys(f.context.bridge.nativeHandoff).sort(), ['launch','list','revoke','version']);
  assert.deepEqual(Object.keys(f.context.bridge.providerSetup).sort(), ['install','launch','login','status','version']);
  assert.deepEqual(await f.invoke('launch', [profile], opened), opened);
  const listed = { state: 'listed', projectId: 'a'.repeat(64), handoffs: [{ handoffId: id, state: 'sealed', createdAt: '2026-10-16T07:30:00.000Z', expiresAt: opened.expiresAt, sealedAt: '2026-10-16T07:31:00.000Z', endedAt: null, owned: true }] };
  assert.deepEqual(await f.invoke('list', [], listed), listed);
  assert.equal((await f.invoke('revoke', [id], { state: 'revoked', reason: null, message: 'Revoked.', handoffId: id, cleanup: 'removed' })).state, 'revoked');
  assert.deepEqual(f.calls.map(c => c.channel), ['launch','list','revoke'].map(a => 'arcane:native-handoff-' + a));
});

test('preload refuses authority fields, malformed lists, injected profiles and accessor replies', async () => {
  const f = await preloadFixture();
  for (const reply of [{ ...opened, credential: 'a'.repeat(43) }, { ...opened, argv: [] }, { ...opened, expiresAt: 'later' },
    { ...opened, handoffId: null }, { ...opened, cleanup: 'deleted_everything' }, { ...opened, message: 'bad\noutput' },
    { state: 'listed', projectId: 'a'.repeat(64), handoffs: [null] }, { state: 'listed', projectId: 'a'.repeat(64), handoffs: Array(257).fill(null) }])
    await assert.rejects(f.invoke('launch', [profile], reply), /Native handoff is unavailable/);
  const before = f.calls.length;
  for (const [action, args] of [['launch', [{ ...profile, token: 'a'.repeat(64) }]], ['launch', [{ model: 'opus' }]],
    ['list', [1]], ['revoke', [id, 1]], ['revoke', ['a'.repeat(64)]]])
    await assert.rejects(f.invoke(action, args, opened), /unavailable/);
  assert.equal(f.calls.length, before, 'malformed intents never cross IPC');
  assert.equal(vm.runInContext(`let reads=0; const hostile={}; Object.defineProperty(hostile,'state',{get(){reads++;return 'opened';}}); try{handoffReply(hostile);}catch{} reads`, f.context), 0);
});
