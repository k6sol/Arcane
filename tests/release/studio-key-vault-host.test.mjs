// Offline VM host/IPC fixtures. AES-GCM safeStorage TEST DOUBLE, never native DPAPI proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { win32 } from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';

const read = name => fs.readFileSync(new URL('../../' + name, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const vaultSource = read('apps/desktop/electron/studio-key-vault.cjs');
const policySource = read('apps/desktop/electron/policy.cjs');
const mainSource = read('apps/desktop/electron/main.cjs');
const preloadSource = read('apps/desktop/electron/preload.cjs');
const ERROR = { message: 'Arcane Studio key storage is unavailable.' };
const origin = 'http://127.0.0.1:45871';
const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const secret = hex => 'arcane_local_v1_' + '45871_' + hex.repeat(64);
const json = value => JSON.parse(JSON.stringify(value));
const hash = text => crypto.createHash('sha256').update(text).digest('hex');

function filesystemDouble() {
  const nodes = new Map(), descriptors = new Map(), writes = []; let identity = 0n, descriptor = 10, reads = 0;
  const key = name => win32.resolve(name).toLowerCase();
  function put(name, options = {}) {
    const node = { path: win32.resolve(name), kind: 'directory', ino: ++identity, dev: 1n, nlink: 1n,
      mode: 0o40700n, mtimeNs: 1n, ctimeNs: 1n, bytes: Buffer.alloc(0), ...options };
    if (node.kind === 'file') node.mode = 0o100600n;
    nodes.set(key(name), node); return node;
  }
  function ensure(name) {
    for (let current = win32.resolve(name);; current = win32.dirname(current)) {
      if (!nodes.has(key(current))) put(current);
      if (current === win32.dirname(current)) break;
    }
  }
  function node(name) {
    const value = nodes.get(key(name));
    if (!value) throw Object.assign(new Error('Missing fixture node.'), { code: 'ENOENT' });
    return value;
  }
  const stat = value => ({ ...value, size: BigInt(value.bytes.length), isDirectory: () => value.kind === 'directory',
    isFile: () => value.kind === 'file', isSymbolicLink: () => value.kind === 'link' });
  const filesystem = {
    constants: fs.constants,
    lstatSync(name) { reads++; return stat(node(name)); },
    realpathSync(name) { reads++; return node(name).physical ?? node(name).path; },
    fstatSync: fd => stat(descriptors.get(fd).node),
    openSync(name, flags) {
      let value;
      if (typeof flags === 'string' && flags.startsWith('wx')) {
        if (nodes.has(key(name))) throw Object.assign(new Error('Existing fixture node.'), { code: 'EEXIST' });
        node(win32.dirname(name)); value = put(name, { kind: 'file' }); writes.push(['create', name]);
      } else value = node(name);
      const fd = ++descriptor; descriptors.set(fd, { node: value }); return fd;
    },
    closeSync(fd) { assert.ok(descriptors.delete(fd), 'Descriptor closed exactly once.'); },
    readSync(fd, bytes, offset, length, position) {
      const value = descriptors.get(fd).node;
      const count = Math.max(0, Math.min(length, value.bytes.length - position));
      value.bytes.copy(bytes, offset, position, position + count); return count;
    },
    writeSync(fd, bytes, offset, length) {
      const value = descriptors.get(fd).node;
      value.bytes = Buffer.concat([value.bytes, bytes.subarray(offset, offset + length)]);
      value.mtimeNs++; value.ctimeNs++; return length;
    },
    fsyncSync() {},
    renameSync(from, to) {
      const value = node(from); nodes.delete(key(from)); value.path = win32.resolve(to); value.ctimeNs++;
      nodes.set(key(to), value); writes.push(['rename', from, to]);
    },
    unlinkSync(name) { node(name); nodes.delete(key(name)); writes.push(['unlink', name]); },
  };
  return { filesystem, nodes, descriptors, writes, ensure, put, node, key, get reads() { return reads; } };
}

function encryptedTestDouble() {
  const key = crypto.randomBytes(32), calls = []; let available = true;
  return {
    calls, setAvailable(value) { available = value; },
    isEncryptionAvailable() { calls.push('available'); return available; },
    encryptString(plain) {
      calls.push('encrypt');
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    decryptString(bytes) {
      calls.push('decrypt');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}

function fixture({ disk = filesystemDouble(), safeStorage = encryptedTestDouble(), smoke = false, platform = 'win32' } = {}) {
  const copied = [];
  const userRoot = 'C:\\Owned', projectPath = 'C:\\Project', projectId = hash(projectPath.toLowerCase());
  const stateRoot = win32.join(userRoot, 'runtime', 'projects', projectId), handlers = new Map(), ipcCalls = [];
  disk.ensure(projectPath); disk.ensure(stateRoot);
  const window = { isDestroyed: () => false, webContents: { isDestroyed: () => false, mainFrame: { url: origin + '/studio#fixture' } } };
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  const module = { exports: {} }, policyModule = { exports: {} };
  vm.runInNewContext(policySource, { module: policyModule, URL, process: { platform }, require(name) {
    if (name === 'node:path') return win32;
    if (name === 'node:fs') return disk.filesystem;
    if (name === 'node:fs/promises') return {};
    assert.fail('Unexpected policy dependency.');
  } });
  const vaultContext = vm.createContext({ module, Buffer, URL, process: { platform }, require(name) {
    if (name === 'node:fs') return disk.filesystem;
    if (name === 'node:path') return win32;
    if (name === 'node:crypto') return crypto;
    if (name === './policy.cjs') return policyModule.exports;
    assert.fail('Unexpected vault dependency; no provider/daemon/process/network capability.');
  } });
  vm.runInContext(vaultSource, vaultContext, { filename: 'studio-key-vault.cjs' });
  const begin = mainSource.indexOf('studioKeyVault = createStudioKeyVault(');
  const end = mainSource.indexOf('studioKeyVault.installIpc(ipcMain);', begin) + 'studioKeyVault.installIpc(ipcMain);'.length;
  assert.ok(begin > 0 && end > begin);
  const mainContext = vm.createContext({ safeStorage, smoke, clipboard: { writeText(value) { copied.push(value); } }, initial: { window, origin, userRoot, token: 'fixture-token',
    projectSession: Object.freeze({ projectId, projectPath, stateRoot }) },
    createStudioKeyVault: module.exports.createStudioKeyVault,
    ipcMain: { handle(channel, handler) { assert.equal(handlers.has(channel), false); handlers.set(channel, handler); } },
  });
  // Execute the actual main-owned session accessor and actual installIpc, not a substitute gate.
  vm.runInContext('let studioKeyVault, closing=false, switching=false; let {window,origin,userRoot,token,projectSession}=initial;\n' +
    'globalThis.setState = next => {' + ['closing', 'switching', 'window', 'origin', 'userRoot', 'token', 'projectSession']
      .map(name => `if(Object.hasOwn(next,'${name}')) ${name}=next.${name};`).join('') + '};\n' +
    mainSource.slice(begin, end), mainContext, { filename: 'studio-key-vault-main-wiring.cjs' });
  let exposed, activeEvent = event, invokeError, replyOverride;
  const preloadContext = vm.createContext({ require(name) {
    assert.equal(name, 'electron');
    return { contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'arcaneDesktop'); exposed = value; } },
      ipcRenderer: { async invoke(channel, ...args) {
        ipcCalls.push(channel); if (invokeError) throw new Error(invokeError);
        const handler = handlers.get(channel); assert.ok(handler, 'Real production channel registered.');
        vaultContext.serialized = JSON.stringify(args);
        const hostArgs = vm.runInContext('JSON.parse(serialized)', vaultContext);
        const value = await handler(activeEvent, ...hostArgs);
        preloadContext.serializedReply = JSON.stringify(replyOverride === undefined ? value : replyOverride);
        return vm.runInContext('JSON.parse(serializedReply)', preloadContext);
      } },
    };
  } });
  vm.runInContext(preloadSource, preloadContext, { filename: 'preload.cjs' });
  const full = win32.join(stateRoot, 'studio-key-vault.v1.json');
  return { disk, safeStorage, copied, event, window, full, projectId, projectPath, stateRoot, userRoot, handlers, exposed, ipcCalls,
    setState: mainContext.setState, setEvent(value) { activeEvent = value; },
    setInvokeError(value) { invokeError = value; }, setReply(value) { replyOverride = value; },
    raw(action, ...args) {
      vaultContext.serialized = JSON.stringify(args);
      return handlers.get('arcane:studio-keys-' + action)(activeEvent, ...vm.runInContext('JSON.parse(serialized)', vaultContext));
    },
    call(action, ...args) {
      preloadContext.serializedArgs = JSON.stringify(args);
      return exposed.studioKeys[action](...vm.runInContext('JSON.parse(serializedArgs)', preloadContext));
    },
  };
}

test('factory and install are inert; the actual preload exposes a frozen version 1 closed API', () => {
  const f = fixture();
  assert.equal(f.disk.reads, 0); assert.equal(f.disk.writes.length, 0); assert.deepEqual(f.safeStorage.calls, []);
  assert.equal(Object.isFrozen(f.exposed), true); assert.equal(Object.isFrozen(f.exposed.studioKeys), true);
  assert.equal(f.exposed.studioKeys.version, 1);
  assert.deepEqual(Object.keys(f.exposed.studioKeys).sort(), ['copy', 'forget', 'list', 'remember', 'reveal', 'version']);
  assert.deepEqual([...f.handlers.keys()].sort(), ['copy', 'forget', 'list', 'remember', 'reveal'].map(a => 'arcane:studio-keys-' + a));
});

test('encrypted TEST DOUBLE: remember persists only ciphertext; reload/restart reveals and list contains IDs only', async () => {
  const f = fixture(), input = { keyId: id(1), apiKey: secret('a') };
  assert.deepEqual(json(await f.call('list')), { available: true, items: [] });
  assert.deepEqual(json(await f.call('remember', input)), { remembered: true });
  const bytes = f.disk.node(f.full).bytes;
  assert.equal(bytes.includes(input.apiKey), false); assert.equal(bytes.includes(input.keyId), false);
  assert.deepEqual(Object.keys(JSON.parse(bytes)).sort(), ['ciphertext', 'version']);
  assert.ok(f.disk.writes.filter(([op]) => op === 'rename').every(([, , to]) => to === f.full));
  for (const value of f.disk.nodes.values()) assert.equal(value.bytes.includes(input.apiKey), false);
  const reloaded = fixture({ disk: f.disk, safeStorage: f.safeStorage });
  assert.deepEqual(json(await reloaded.call('list')), { available: true, items: [{ keyId: id(1) }] });
  assert.ok((await reloaded.call('reveal', { keyId: id(1) })).apiKey === input.apiKey);
  assert.equal(f.disk.descriptors.size, 0);
});

test('exact input schema rejects providers, paths, non-UUID IDs and nonlocal key formats before storage', async () => {
  const f = fixture();
  const bad = [null, [], {}, { keyId: id(1) }, { keyId: id(1), apiKey: secret('a'), path: 'C:\\Other' },
    { keyId: id(1), apiKey: 'sk-fixture-provider-key' }, { keyId: 'claude', apiKey: secret('a') },
    { keyId: id(1) + '\n', apiKey: secret('a') }, { keyId: id(1).replace('4000', '5000'), apiKey: secret('a') },
    { keyId: id(1), apiKey: secret('a') + '\n' }, { keyId: id(1), apiKey: secret('a').replace('45871', '45872') },
    { keyId: id(1), apiKey: secret('a').replace('45871', '045871') }, { keyId: id(1), apiKey: secret('a').toUpperCase() }];
  for (const value of bad) await assert.rejects(f.raw('remember', value), ERROR);
  await assert.rejects(f.raw('list', {}), ERROR);
  await assert.rejects(f.raw('reveal', { keyId: id(1), apiKey: secret('a') }), ERROR);
  await assert.rejects(f.raw('forget', { keyId: '../auth.json' }), ERROR);
  assert.equal(f.disk.reads, 0); assert.equal(f.disk.writes.length, 0); assert.deepEqual(f.safeStorage.calls, []);
  let getterRead = false;
  const value = Object.defineProperty({ apiKey: secret('a') }, 'keyId', { enumerable: true, get() { getterRead = true; return id(1); } });
  await assert.rejects(f.handlers.get('arcane:studio-keys-remember')(f.event, value), ERROR);
  assert.equal(getterRead, false);
});

test('genuine host IPC gate refuses foreign owners, subframes and noncanonical origins', async () => {
  for (const change of [f => ({ sender: {}, senderFrame: f.event.senderFrame }),
    f => ({ sender: f.event.sender, senderFrame: { url: f.event.senderFrame.url } }),
    f => { f.event.senderFrame.url = 'https://foreign.invalid/studio'; return f.event; },
    f => { f.event.senderFrame.url = origin + '/studio?x=1'; return f.event; },
    f => { f.event.senderFrame.url = origin + '/a/../studio'; return f.event; },
    f => { f.window.webContents.isDestroyed = () => true; return f.event; },
    f => { f.window.isDestroyed = () => true; return f.event; }]) {
    const f = fixture(); f.setEvent(change(f));
    for (const action of ['list', 'remember', 'reveal', 'forget']) await assert.rejects(
      f.raw(action, ...action === 'list' ? [] : [action === 'remember' ? { keyId: id(1), apiKey: secret('a') } : { keyId: id(1) }]), ERROR);
    assert.equal(f.disk.reads, 0); assert.equal(f.disk.writes.length, 0); assert.deepEqual(f.safeStorage.calls, []);
  }
});

test('owner, main frame, origin, project epoch and path identities are rechecked after await', async () => {
  for (const invalidate of [f => f.setState({ closing: true }), f => f.setState({ switching: true }),
    f => f.setState({ token: '' }), f => f.setState({ origin: 'http://127.0.0.1:45872' }),
    f => f.setState({ projectSession: { projectId: f.projectId, projectPath: f.projectPath, stateRoot: f.stateRoot } }),
    f => { f.window.webContents.mainFrame = { url: origin + '/studio#fixture' }; },
    f => { f.event.senderFrame.url = origin + '/studio#reloaded'; },
    f => f.disk.put(f.projectPath), f => f.disk.put(f.stateRoot)]) {
    const f = fixture();
    const pending = f.raw('remember', { keyId: id(1), apiKey: secret('a') }); invalidate(f);
    await assert.rejects(pending, ERROR);
    assert.equal(f.disk.writes.length, 0); assert.equal(f.safeStorage.calls.includes('encrypt'), false);
    assert.equal(f.disk.descriptors.size, 0);
  }
});

test('smoke, unsupported platforms and unavailable encryption have no storage or fallback effects', async () => {
  for (const options of [{ smoke: true }, { platform: 'linux' }, { platform: 'darwin' }, { unavailable: true }]) {
    const f = fixture(options); if (options.unavailable) f.safeStorage.setAvailable(false);
    assert.deepEqual(json(await f.call('list')), { available: false, items: [] });
    for (const action of ['remember', 'reveal', 'forget']) await assert.rejects(
      f.call(action, action === 'remember' ? { keyId: id(1), apiKey: secret('a') } : { keyId: id(1) }), ERROR);
    assert.equal(f.disk.reads, 0); assert.equal(f.disk.writes.length, 0);
    assert.equal(f.safeStorage.calls.some(c => c === 'encrypt' || c === 'decrypt'), false);
    if (!options.unavailable) assert.deepEqual(f.safeStorage.calls, []);
  }
});

test('contained vault refuses hardlinks, junctions, oversized files and corrupt ciphertext without repair', async () => {
  for (const corrupt of [f => f.disk.put(f.full, { kind: 'file', nlink: 2n }),
    f => f.disk.put(f.full, { kind: 'link', physical: 'C:\\Provider\\auth.json' }),
    f => { f.disk.node(f.stateRoot).physical = 'C:\\Elsewhere'; },
    f => { f.disk.node(f.userRoot).kind = 'link'; },
    f => f.disk.put(f.full, { kind: 'file', bytes: Buffer.alloc(32769) }),
    f => f.disk.put(f.full, { kind: 'file', bytes: Buffer.from('{"version":1,"ciphertext":"bad"}\n') })]) {
    const f = fixture(); corrupt(f);
    await assert.rejects(f.raw('remember', { keyId: id(1), apiKey: secret('a') }), ERROR);
    await assert.rejects(f.raw('list'), ERROR);
    assert.equal(f.disk.writes.length, 0); assert.equal(f.disk.descriptors.size, 0);
  }
});

test('encrypted project binding refuses another project payload and exact decrypted schema rejects extra fields', async () => {
  for (const payload of [{ version: 1, projectId: 'f'.repeat(64), items: [] },
    { version: 1, items: [{ keyId: id(1), apiKey: secret('a'), provider: 'codex' }] },
    { version: 1, items: [{ keyId: id(1), apiKey: secret('a') }, { keyId: id(1), apiKey: secret('a') }] }]) {
    const f = fixture(); if (!payload.projectId) payload.projectId = f.projectId;
    const ciphertext = f.safeStorage.encryptString(JSON.stringify(payload)).toString('base64');
    f.disk.put(f.full, { kind: 'file', bytes: Buffer.from(JSON.stringify({ version: 1, ciphertext }) + '\n') });
    await assert.rejects(f.raw('list'), ERROR); assert.equal(f.disk.writes.length, 0);
  }
});

test('reentry, immutable key binding, item limits and foreign locks are bounded', async () => {
  const f = fixture();
  const pending = f.raw('remember', { keyId: id(1), apiKey: secret('a') });
  await assert.rejects(f.raw('remember', { keyId: id(2), apiKey: secret('b') }), ERROR); await pending;
  const before = f.disk.writes.length;
  await f.raw('remember', { keyId: id(1), apiKey: secret('a') }); assert.equal(f.disk.writes.length, before);
  await assert.rejects(f.raw('remember', { keyId: id(1), apiKey: secret('b') }), ERROR);
  for (let n = 2; n <= 32; n++) await f.raw('remember', { keyId: id(n), apiKey: secret('a') });
  await assert.rejects(f.raw('remember', { keyId: id(33), apiKey: secret('a') }), ERROR);
  assert.equal((await f.raw('list')).items.length, 32);
  const foreign = f.disk.put(f.full + '.lock', { kind: 'file', bytes: Buffer.from('foreign') });
  await assert.rejects(f.raw('forget', { keyId: id(1) }), ERROR);
  assert.ok(f.disk.node(f.full + '.lock') === foreign); assert.equal(f.disk.descriptors.size, 0);
});

test('write/fsync/rename failures preserve prior ciphertext and clean up only owned staging files', async () => {
  for (const method of ['writeSync', 'fsyncSync', 'renameSync']) {
    const f = fixture(); await f.raw('remember', { keyId: id(1), apiKey: secret('a') });
    const previous = Buffer.from(f.disk.node(f.full).bytes);
    f.disk.filesystem[method] = () => { throw new Error('Sensitive fixture failure: ' + secret('a')); };
    await assert.rejects(f.raw('forget', { keyId: id(1) }), ERROR);
    assert.ok(f.disk.node(f.full).bytes.equals(previous));
    assert.equal([...f.disk.nodes.values()].some(node => /\.(?:tmp|lock)$/.test(node.path)), false);
    assert.equal(f.disk.descriptors.size, 0);
  }
});

test('safeStorage failures and mid-encryption path/owner changes cannot replace previous ciphertext', async () => {
  for (const mutate of [f => { throw new Error(secret('a')); }, f => f.setState({ switching: true }),
    f => { f.disk.node(f.stateRoot).physical = 'C:\\Elsewhere'; },
    f => { f.disk.node(f.full).nlink = 2n; }]) {
    const f = fixture(); await f.raw('remember', { keyId: id(1), apiKey: secret('a') });
    const previous = Buffer.from(f.disk.node(f.full).bytes), encrypt = f.safeStorage.encryptString;
    f.safeStorage.encryptString = plain => { const bytes = encrypt(plain); mutate(f); return bytes; };
    await assert.rejects(f.raw('forget', { keyId: id(1) }), ERROR);
    assert.ok(f.disk.node(f.full).bytes.equals(previous)); assert.equal(f.disk.descriptors.size, 0);
  }
});

test('forget is idempotent and removes the remembered secret; no grant/connection capability exists', async () => {
  const f = fixture();
  await f.call('remember', { keyId: id(1), apiKey: secret('a') });
  assert.deepEqual(json(await f.call('forget', { keyId: id(1) })), { forgotten: true });
  await assert.rejects(f.call('reveal', { keyId: id(1) }), ERROR);
  assert.deepEqual(json(await f.call('list')), { available: true, items: [] });
  const before = f.disk.writes.length;
  assert.deepEqual(json(await f.call('forget', { keyId: id(1) })), { forgotten: true });
  assert.equal(f.disk.writes.length, before);
  assert.ok(f.ipcCalls.every(channel => channel.startsWith('arcane:studio-keys-')));
});

test('preload validates exact arguments/results and sanitizes rejected IPC without leaking details', async () => {
  const f = fixture();
  await assert.rejects(f.call('remember', { keyId: id(1), apiKey: secret('a'), url: origin }), ERROR);
  await assert.rejects(f.call('reveal', id(1)), ERROR);
  await assert.rejects(f.call('list', {}), ERROR); assert.equal(f.ipcCalls.length, 0);
  f.setInvokeError('Sensitive IPC fixture failure: ' + secret('a')); await assert.rejects(f.call('list'), ERROR);
  f.setInvokeError(undefined);
  for (const reply of [{ available: true, items: [], apiKey: secret('a') }, { available: false, items: [{ keyId: id(1) }] },
    { available: true, items: [{ keyId: id(1), apiKey: secret('a') }] }]) {
    f.setReply(reply); await assert.rejects(f.call('list'), ERROR);
  }
  f.setReply({ remembered: true, apiKey: secret('a') });
  await assert.rejects(f.call('remember', { keyId: id(1), apiKey: secret('a') }), ERROR);
  f.setReply({ apiKey: 'sk-provider-fixture' }); await assert.rejects(f.call('reveal', { keyId: id(1) }), ERROR);
});

test('copy uses the validated project vault, not renderer strings or clipboard permission', async () => {
  const f = fixture();
  await assert.rejects(f.call('copy', { keyId: id(1) }), ERROR);
  assert.deepEqual(f.copied, []);
  await f.call('remember', { keyId: id(1), apiKey: secret('a') });
  assert.deepEqual(json(await f.call('copy', { keyId: id(1) })), { copied: true });
  assert.deepEqual(f.copied, [secret('a')]);
  await assert.rejects(f.call('copy', { keyId: id(1), apiKey: secret('b') }), ERROR);
  f.setState({ switching: true });
  await assert.rejects(f.call('copy', { keyId: id(1) }), ERROR);
  assert.deepEqual(f.copied, [secret('a')]);
  assert.equal(f.disk.descriptors.size, 0);
});
