// Offline VM host/IPC fixtures. AES-GCM safeStorage TEST DOUBLE, never native DPAPI proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { win32 } from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { types } from 'node:util';

const read = name => fs.readFileSync(new URL('../../' + name, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const preferencesSource = read('apps/desktop/electron/workspace-preferences.cjs');
const policySource = read('apps/desktop/electron/policy.cjs');
const mainSource = read('apps/desktop/electron/main.cjs');
const preloadSource = read('apps/desktop/electron/preload.cjs');
const ERROR = { message: 'Arcane workspace preferences are unavailable.' };
const origin = 'http://127.0.0.1:45871';
const tab = (n = 1, values = {}) => ({ localId: 'draft:'+n, title: 'Chat '+n, provider: 'codex', threadId: null, sessionId: null, draft: '', modelId: null, effort: null, tool: 'all', previewOpen: false, ...values });
const snapshot = (values = {}) => ({ version: 1, projectPath: 'C:\\Project', provider: 'codex', tabs: [tab()], activeTabId: 'draft:1', ...values });
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

function fixture({ disk = filesystemDouble(), safeStorage = encryptedTestDouble(), smoke = false, platform = 'win32', projectPath = 'C:\\Project', origin: fixtureOrigin = origin, includeClaude = false } = {}) {
  const userRoot = 'C:\\Owned', projectId = hash(projectPath.toLowerCase());
  const stateRoot = win32.join(userRoot, 'runtime', 'projects', projectId), handlers = new Map(), ipcCalls = [];
  disk.ensure(projectPath); disk.ensure(stateRoot);
  const window = { isDestroyed: () => false, webContents: { isDestroyed: () => false, mainFrame: { url: fixtureOrigin + '/studio#fixture' } } };
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  const module = { exports: {} }, policyModule = { exports: {} };
  vm.runInNewContext(policySource, { module: policyModule, URL, process: { platform }, require(name) {
    if (name === 'node:path') return win32;
    if (name === 'node:fs') return disk.filesystem;
    if (name === 'node:fs/promises') return {};
    assert.fail('Unexpected policy dependency.');
  } });
  const hostContext = vm.createContext({ module, Buffer, URL, process: { platform }, require(name) {
    if (name === 'node:fs') return disk.filesystem;
    if (name === 'node:path') return win32;
    if (name === 'node:crypto') return crypto;
    if (name === 'node:util') return { types };
    if (name === './policy.cjs') return policyModule.exports;
    assert.fail('Unexpected preferences dependency; no provider/daemon/process/network capability.');
  } });
  vm.runInContext(preferencesSource, hostContext, { filename: 'workspace-preferences.cjs' });
  const begin = mainSource.indexOf("workspacePreferences = require('./workspace-preferences.cjs').createWorkspacePreferences(");
  const end = mainSource.indexOf('workspacePreferences.installIpc(ipcMain);', begin) + 'workspacePreferences.installIpc(ipcMain);'.length;
  assert.ok(begin > 0 && end > begin);
  const mainContext = vm.createContext({ safeStorage, smoke, initial: { window, origin: fixtureOrigin, userRoot, token: 'fixture-token',
    projectSession: Object.freeze({ projectId, projectPath, stateRoot }) },
    require(name) { assert.equal(name, './workspace-preferences.cjs'); return module.exports; },
    ipcMain: { handle(channel, handler) { assert.equal(handlers.has(channel), false); handlers.set(channel, handler); } },
  });
  // Execute the actual main-owned session accessor and actual installIpc, not a substitute gate.
  vm.runInContext('let workspacePreferences, claudePreferences, runtimeRecovery=null, closing=false, switching=false; let {window,origin,userRoot,token,projectSession}=initial;\n' +
    'globalThis.setState = next => {' + ['closing', 'switching', 'window', 'origin', 'userRoot', 'token', 'projectSession']
      .map(name => `if(Object.hasOwn(next,'${name}')) ${name}=next.${name};`).join('') + '};\n' +
    mainSource.slice(begin, end), mainContext, { filename: 'workspace-preferences-main-wiring.cjs' });
  if (includeClaude) {
    const beginClaude = mainSource.indexOf("claudePreferences = require('./workspace-preferences.cjs').createWorkspacePreferences(");
    const endClaude = mainSource.indexOf('claudePreferences.installIpc(ipcMain);', beginClaude) + 'claudePreferences.installIpc(ipcMain);'.length;
    assert.ok(beginClaude > 0 && endClaude > beginClaude, 'Production Claude preference wiring exists.');
    vm.runInContext(mainSource.slice(beginClaude, endClaude), mainContext, { filename: 'claude-preferences-main-wiring.cjs' });
  }
  let exposed, activeEvent = event, invokeError, replyOverride;
  const preloadContext = vm.createContext({ TextEncoder, require(name) {
    assert.equal(name, 'electron');
    return { contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'arcaneDesktop'); exposed = value; } },
      ipcRenderer: { async invoke(channel, ...args) {
        ipcCalls.push(channel); if (invokeError) throw new Error(invokeError);
        const handler = handlers.get(channel); assert.ok(handler, 'Real production channel registered.');
        hostContext.serialized = JSON.stringify(args);
        const hostArgs = vm.runInContext('JSON.parse(serialized)', hostContext);
        const value = await handler(activeEvent, ...hostArgs);
        preloadContext.serializedReply = JSON.stringify(replyOverride === undefined ? value : replyOverride);
        return vm.runInContext('JSON.parse(serializedReply)', preloadContext);
      } },
    };
  } });
  vm.runInContext(preloadSource, preloadContext, { filename: 'preload.cjs' });
  const full = win32.join(stateRoot, 'workspace-preferences.v1.json');
  return { disk, safeStorage, event, window, full, projectId, projectPath, stateRoot, userRoot, handlers, exposed, ipcCalls,
    hostValue: code => vm.runInContext(code, hostContext), preloadValue: code => vm.runInContext(code, preloadContext),
    setState: mainContext.setState, setEvent(value) { activeEvent = value; },
    setInvokeError(value) { invokeError = value; }, setReply(value) { replyOverride = value; },
    raw(action, ...args) {
      hostContext.serialized = JSON.stringify(args);
      return handlers.get('arcane:workspace-preferences-' + action)(activeEvent, ...vm.runInContext('JSON.parse(serialized)', hostContext));
    },
    call(action, ...args) {
      preloadContext.serializedArgs = JSON.stringify(args);
      return exposed.workspacePreferences[action](...vm.runInContext('JSON.parse(serializedArgs)', preloadContext));
    },
    claude(action, ...args) {
      preloadContext.serializedArgs = JSON.stringify(args);
      return exposed.claudePreferences[action](...vm.runInContext('JSON.parse(serializedArgs)', preloadContext));
    },
    tour(action, ...args) {
      preloadContext.serializedArgs = JSON.stringify(args);
      return exposed.welcomeTour[action](...vm.runInContext('JSON.parse(serializedArgs)', preloadContext));
    },
    checklist(action, ...args) {
      preloadContext.serializedArgs = JSON.stringify(args);
      return exposed.setupChecklist[action](...vm.runInContext('JSON.parse(serializedArgs)', preloadContext));
    },
  };
}

test('production wiring and preload expose only frozen version 1 read/save; installation is inert', () => {
  const f = fixture();
  assert.equal(f.disk.reads, 0); assert.equal(f.disk.writes.length, 0); assert.deepEqual(f.safeStorage.calls, []);
  assert.equal(Object.isFrozen(f.exposed), true); assert.equal(Object.isFrozen(f.exposed.workspacePreferences), true);
  assert.equal(f.exposed.workspacePreferences.version, 1);
  assert.deepEqual(Object.keys(f.exposed.workspacePreferences).sort(), ['read', 'save', 'version']);
  assert.deepEqual([...f.handlers.keys()].sort(), ['arcane:setup-checklist-read', 'arcane:setup-checklist-save', 'arcane:welcome-tour-dismiss', 'arcane:welcome-tour-read', ...['read', 'save'].map(a => 'arcane:workspace-preferences-' + a)]);
  assert.match(mainSource, /partition: 'arcane-workspace'/);
  assert.match(mainSource, /workspacePreferences: \{ enabled: false,[^\n]+encryptionRoundTripTested: false \}/);
});

test('encrypted TEST DOUBLE: raw drafts/provider/tabs survive restart, reload and changed daemon port', async () => {
  const f = fixture();
  assert.deepEqual(json(await f.call('read')), { available: true, preferences: null });
  const draft = '  Unsent user text\r\n\t雪 🧪 e\u0301\u0000\n';
  const input = snapshot({ provider: 'claude', tabs: [tab(1, { draft, modelId: 'gpt-5.6', effort: 'high' }),
    tab(2, { provider: 'claude', threadId: 'advisory.thread:2', sessionId: 'session-2', draft: 'Second draft', tool: 'blender', previewOpen: true })], activeTabId: 'draft:2' });
  assert.deepEqual(json(await f.call('save', input)), { saved: true });
  const bytes = f.disk.node(f.full).bytes;
  for (const value of [draft, input.tabs[1].draft, f.projectId, input.tabs[1].threadId]) assert.equal(bytes.includes(value), false);
  assert.deepEqual(Object.keys(JSON.parse(bytes)).sort(), ['ciphertext', 'version']);
  assert.ok(bytes.length <= 1024 * 1024);
  assert.ok(f.disk.writes.filter(([op]) => op === 'rename').every(([, , to]) => to === f.full));
  for (const value of f.disk.nodes.values()) assert.equal(value.bytes.includes(draft), false);
  for (const changedOrigin of [origin, 'http://127.0.0.1:59123']) {
    const restarted = fixture({ disk: f.disk, safeStorage: f.safeStorage, origin: changedOrigin });
    assert.deepEqual(json(await restarted.call('read')), { available: true, preferences: input });
    assert.equal(restarted.disk.descriptors.size, 0);
  }
  assert.ok(f.ipcCalls.every(channel => channel.startsWith('arcane:workspace-preferences-')));
});

test('welcome tour dismissal survives a fresh renderer, daemon port and project', async () => {
  for (const how of ['finished', 'skipped']) {
    const f=fixture();
    assert.equal(Object.isFrozen(f.exposed.welcomeTour),true);
    assert.deepEqual(json(await f.exposed.welcomeTour.read()),{available:true,seen:false});
    assert.deepEqual(json(await f.tour('dismiss',{how})),{saved:true});
    const restarted=fixture({disk:f.disk,safeStorage:f.safeStorage,origin:'http://127.0.0.1:59123',projectPath:'C:\\OtherProject'});
    assert.deepEqual(json(await restarted.exposed.welcomeTour.read()),{available:true,seen:true});
    assert.equal(f.disk.descriptors.size,0);assert.equal(restarted.disk.descriptors.size,0);
    const count=f.disk.writes.length;
    await restarted.tour('dismiss',{how});
    assert.equal(f.disk.writes.length,count,'dismissal is monotonic; replay does not rewrite the record');
  }
});

test('welcome tour IPC refuses foreign frames, arbitrary input and disabled writes',async()=>{
  const f=fixture(),before=f.disk.writes.length;
  for(const args of [[],[{how:'paused'}],[{how:'skipped',path:'C:\\Other'}],[{how:'finished'},{}]])await assert.rejects(f.exposed.welcomeTour.dismiss(...args));
  await assert.rejects(f.exposed.welcomeTour.read({}));
  f.setEvent({...f.event,senderFrame:{url:origin+'/studio#fixture'}});
  await assert.rejects(f.exposed.welcomeTour.read());await assert.rejects(f.exposed.welcomeTour.dismiss({how:'skipped'}));
  assert.equal(f.disk.writes.length,before);
  const disabled=fixture({smoke:true});
  assert.deepEqual(json(await disabled.exposed.welcomeTour.read()),{available:false,seen:false});
  await assert.rejects(disabled.exposed.welcomeTour.dismiss({how:'finished'}));assert.equal(disabled.disk.reads,0);
});

test('welcome tour dismissal does not compete with a pending chat preference save',async()=>{
  const f=fixture(),saving=f.call('save',snapshot());
  assert.deepEqual(json(await f.tour('dismiss',{how:'skipped'})),{saved:true});
  assert.deepEqual(json(await saving),{saved:true});
  assert.deepEqual(json(await f.tour('read')),{available:true,seen:true});
});

test('setup checklist Hide, completion and Show survive native restart, port and project changes',async()=>{
  const f=fixture();assert.equal(Object.isFrozen(f.exposed.setupChecklist),true);
  assert.deepEqual(json(await f.checklist('read')),{available:true,memory:null});
  for(const memory of [{version:1,completed:false,dismissed:true},{version:1,completed:true,dismissed:false},{version:1,completed:false,dismissed:false}]){
    const saving=f.call('save',snapshot());
    assert.deepEqual(json(await f.checklist('save',memory)),{saved:true});await saving;
    const reopened=fixture({disk:f.disk,safeStorage:f.safeStorage,origin:'http://127.0.0.1:59123',projectPath:'C:\\AnotherProject'});
    assert.deepEqual(json(await reopened.checklist('read')),{available:true,memory});
    assert.deepEqual(json(await reopened.tour('read')),{available:true,seen:false},'checklist does not dismiss the guided tour');
    assert.equal(f.disk.descriptors.size,0);assert.equal(reopened.disk.descriptors.size,0);
  }
});

test('setup checklist bridge rejects untrusted input and preserves malformed or redirected records',async()=>{
  const f=fixture();
  for(const value of [{version:2,completed:false,dismissed:true},{version:1,completed:false,dismissed:1},{version:1,completed:false,dismissed:true,path:'C:\\Other'}]){
    await assert.rejects(f.checklist('save',value));
    await assert.rejects(f.handlers.get('arcane:setup-checklist-save')(f.event,f.hostValue('('+JSON.stringify(value)+')')));
  }
  f.setEvent({...f.event,senderFrame:{url:origin+'/studio#fixture'}});await assert.rejects(f.checklist('read'));assert.equal(f.disk.writes.length,0);
  const disabled=fixture({smoke:true});assert.deepEqual(json(await disabled.checklist('read')),{available:false,memory:null});
  await assert.rejects(disabled.checklist('save',{version:1,completed:false,dismissed:true}));assert.equal(disabled.disk.reads,0);
  for(const options of [{kind:'file',bytes:Buffer.from('{"version":2}\n')},{kind:'link'}]){
    const other=fixture(),full=win32.join(other.userRoot,'setup-checklist.v1.json');other.disk.put(full,options);const before=other.disk.node(full);
    await assert.rejects(other.checklist('read'));await assert.rejects(other.checklist('save',{version:1,completed:false,dismissed:true}));
    assert.equal(other.disk.node(full),before);assert.equal(other.disk.writes.length,0);assert.equal(other.disk.descriptors.size,0);
  }
});

test('welcome tour preserves malformed and redirected records',async()=>{
  for(const options of [{kind:'file',bytes:Buffer.from('{"version":2,"seen":true}\n')},{kind:'link'}]){
    const f=fixture(),full=win32.join(f.userRoot,'welcome-tour.v1.json');f.disk.put(full,options);
    const before=f.disk.node(full),writes=f.disk.writes.length;
    await assert.rejects(f.tour('read'));await assert.rejects(f.tour('dismiss',{how:'finished'}));
    assert.equal(f.disk.node(full),before);assert.equal(f.disk.writes.length,writes);assert.equal(f.disk.descriptors.size,0);
  }
});

test('presentation choices and drafts are isolated across canonical projects', async () => {
  const a = fixture(), inputA = snapshot({ provider: 'claude', tabs: [tab(1, { draft: 'Project A' })] });
  await a.call('save', inputA);
  const b = fixture({ disk: a.disk, safeStorage: a.safeStorage, projectPath: 'C:\\OtherProject' });
  assert.notEqual(a.full, b.full);
  assert.deepEqual(json(await b.call('read')), { available: true, preferences: null });
  const inputB = snapshot({ projectPath: b.projectPath, tabs: [tab(1, { draft: 'Project B' })] }); await b.call('save', inputB);
  const reopened = fixture({ disk: a.disk, safeStorage: a.safeStorage, origin: 'http://127.0.0.1:49999' });
  assert.deepEqual(json(await reopened.call('read')), { available: true, preferences: inputA });
  assert.deepEqual(json(await b.call('read')), { available: true, preferences: inputB });
  b.disk.put(b.full, { kind: 'file', bytes: Buffer.from(a.disk.node(a.full).bytes) });
  const before = b.disk.writes.length;
  await assert.rejects(b.raw('read'), ERROR); await assert.rejects(b.raw('save', inputB), ERROR);
  assert.equal(b.disk.writes.length, before);
});

test('advisory projectPath is required, compared with trusted scope and canonicalized on read', async () => {
  const f = fixture();
  const withoutPath = snapshot(); delete withoutPath.projectPath;
  await assert.rejects(f.raw('save', withoutPath), ERROR); await assert.rejects(f.call('save', withoutPath), ERROR);
  for (const projectPath of ['C:\\OtherProject', 'C:\\Project\\..\\Project', 'C:/Project', '\\\\network\\Project', 'C:\\Project\\auth.json']) {
    await assert.rejects(f.raw('save', snapshot({ projectPath })), ERROR);
  }
  assert.equal(f.disk.reads, 0); assert.equal(f.disk.writes.length, 0); assert.deepEqual(f.safeStorage.calls, []);
  await f.call('save', snapshot({ projectPath: 'c:\\project' }));
  assert.deepEqual(json(await f.call('read')), { available: true, preferences: snapshot() });
  const reopened = fixture({ disk: f.disk, safeStorage: f.safeStorage, projectPath: 'c:\\PROJECT', origin: 'http://127.0.0.1:55555' });
  assert.deepEqual(json(await reopened.call('read')), { available: true, preferences: snapshot({ projectPath: reopened.projectPath }) });
  const b = fixture({ disk: f.disk, safeStorage: f.safeStorage, projectPath: 'C:\\OtherProject' });
  await assert.rejects(b.call('save', snapshot()), ERROR);
  assert.equal(b.disk.nodes.has(b.disk.key(b.full)), false);
  const validButWrongPath = { version: 1, projectId: f.projectId, preferences: snapshot({ projectPath: b.projectPath }) };
  const cipher = f.safeStorage.encryptString(JSON.stringify(validButWrongPath));
  f.disk.put(f.full, { kind: 'file', bytes: Buffer.from(JSON.stringify({ version: 1, ciphertext: cipher.toString('base64') }) + '\n') });
  await assert.rejects(f.call('read'), ERROR); await assert.rejects(f.call('save', snapshot()), ERROR);
});

test('foreign lock/stage replacement immediately after creation is never adopted or deleted', async () => {
  for (const kind of ['.lock', '.tmp']) {
    const f = fixture(), open = f.disk.filesystem.openSync;
    let foreign, foreignPath;
    f.disk.filesystem.openSync = (name, flags, ...args) => {
      const fd = open(name, flags, ...args);
      if (typeof flags === 'string' && flags.startsWith('wx') && name.endsWith(kind)) {
        foreignPath = name; foreign = f.disk.put(name, { kind: 'file', bytes: Buffer.from('foreign') });
      }
      return fd;
    };
    await assert.rejects(f.call('save', snapshot()), ERROR);
    assert.ok(f.disk.node(foreignPath) === foreign); assert.equal(f.disk.descriptors.size, 0);
    assert.equal(f.disk.nodes.has(f.disk.key(f.full)), false);
  }
});

test('schema rejects unknown fields, auth/grants, paths and invalid IDs before disk/encryption', async () => {
  const f = fixture();
  const bad = [null, [], {}, snapshot({ version: 2 }), snapshot({ provider: 'other' }), snapshot({ projectPath: 'C:\\OtherProject' }),
    snapshot({ token: 'never-stored' }), snapshot({ auth: {} }), snapshot({ grants: [] }), snapshot({ activeTabId: 'missing' }),
    snapshot({ tabs: [tab(1, { path: 'C:\\Provider\\auth.json' })] }), snapshot({ tabs: [tab(1, { liveRun: {} })] }),
    snapshot({ tabs: [tab(1, { credentials: 'never-stored' })] }), snapshot({ tabs: [tab(1, { localId: '../auth.json' })] }),
    snapshot({ tabs: [tab(1, { threadId: 'C:\\Provider\\auth.json' })] }), snapshot({ tabs: [tab(1, { sessionId: '\\network' })] }),
    snapshot({ tabs: [tab(1, { localId: '..' })] }), snapshot({ tabs: [tab(1, { localId: '' })] }),
    snapshot({ tabs: [tab(1, { threadId: '' })] }), snapshot({ tabs: [tab(1, { modelId: 'name\n' })] }),
    snapshot({ tabs: [tab(1, { effort: 'grant/execute' })] }), snapshot({ tabs: [tab(1, { tool: 'shell' })] }),
    snapshot({ tabs: [tab(1, { title: 'bad\nlabel' })] }), snapshot({ tabs: [tab(1, { previewOpen: 1 })] }),
    snapshot({ tabs: [tab(1, { draft: 1 })] }), snapshot({ tabs: [tab(1), tab(1)] })];
  for (const input of bad) {
    await assert.rejects(f.raw('save', input), ERROR); await assert.rejects(f.call('save', input), ERROR);
  }
  await assert.rejects(f.raw('read', {}), ERROR); await assert.rejects(f.call('read', {}), ERROR);
  await assert.rejects(f.raw('save'), ERROR); await assert.rejects(f.call('save'), ERROR);
  await assert.rejects(f.raw('save', snapshot(), {}), ERROR); await assert.rejects(f.call('save', snapshot(), {}), ERROR);
  assert.equal(f.disk.reads, 0); assert.equal(f.disk.writes.length, 0); assert.deepEqual(f.safeStorage.calls, []);
  // Only the native host knows whether an advisory project path belongs to this scope.
  assert.deepEqual(f.ipcCalls, ['arcane:workspace-preferences-save']);
});

test('accessors, exotic prototypes, proxies, sparse and augmented arrays never cross host validation', async () => {
  const f = fixture();
  const base = JSON.stringify(snapshot());
  const expressions = [
    `Object.assign(Object.create(null), ${base})`,
    `Object.assign(Object.create({}), ${base})`,
    `new Proxy(${base}, {getPrototypeOf(){throw Error('trap must not execute')}})`,
    `(()=>{const x=${base}; x.tabs=new Proxy(x.tabs,{get(){throw Error('trap must not execute')}});return x})()`,
    `(()=>{const x=${base}; Object.defineProperty(x,'provider',{enumerable:true,get(){globalThis.getterRead=true;return 'codex'}});return x})()`,
    `(()=>{const x=${base}; Object.defineProperty(x.tabs[0],'draft',{enumerable:true,get(){globalThis.getterRead=true;return 'data'}});return x})()`,
    `(()=>{const x=${base}; Object.defineProperty(x.tabs,'0',{enumerable:true,get(){globalThis.getterRead=true;return {}}});return x})()`,
    `(()=>{const x=${base}; delete x.tabs[0];return x})()`,
    `(()=>{const x=${base}; x.tabs.toJSON=()=>[];return x})()`,
    `(()=>{const x=${base}; x.tabs[0][Symbol('grant')]=true;return x})()`,
    `(()=>{const x=${base}; Object.defineProperty(x.tabs[0],'title',{value:'hidden',enumerable:false});return x})()`,
    `(()=>{const x=${base}; Object.setPrototypeOf(x.tabs,{});return x})()`,
  ];
  for (const expression of expressions) await assert.rejects(f.handlers.get('arcane:workspace-preferences-save')(f.event, f.hostValue(expression)), ERROR);
  assert.equal(f.hostValue('globalThis.getterRead'), undefined);
  for (const expression of expressions.filter(x => !x.includes('Proxy'))) await assert.rejects(f.exposed.workspacePreferences.save(f.preloadValue(expression)), ERROR);
  assert.equal(f.preloadValue('globalThis.getterRead'), undefined);
  assert.equal(f.ipcCalls.length, 0); assert.equal(f.disk.reads, 0); assert.deepEqual(f.safeStorage.calls, []);
});

test('pending input is copied before await and later caller edits cannot change the saved draft', async () => {
  const f = fixture(), value = f.hostValue('(' + JSON.stringify(snapshot({ tabs: [tab(1, { draft: 'before' })] })) + ')');
  const pending = f.handlers.get('arcane:workspace-preferences-save')(f.event, value);
  value.tabs[0].draft = 'after'; value.provider = 'claude'; await pending;
  assert.deepEqual(json(await f.call('read')), { available: true, preferences: snapshot({ tabs: [tab(1, { draft: 'before' })] }) });
});

test('16 tabs, UTF-8 field limits and total serialized bounds are enforced without truncation', async () => {
  const f = fixture();
  const maximal = snapshot({ tabs: Array.from({ length: 16 }, (_, i) => tab(i + 1)), activeTabId: 'draft:16' });
  await f.call('save', maximal); assert.deepEqual(json((await f.call('read')).preferences), maximal);
  const boundary = snapshot({ tabs: [tab(1, { draft: '🧪'.repeat(32768), title: 'a'.repeat(512), threadId: 't'.repeat(256),
    sessionId: 's'.repeat(256), modelId: 'm'.repeat(256), effort: 'e'.repeat(64) })] });
  await f.call('save', boundary); assert.deepEqual(json((await f.call('read')).preferences), boundary);
  const prior = Buffer.from(f.disk.node(f.full).bytes), writes = f.disk.writes.length, calls = f.safeStorage.calls.length;
  const bad = [snapshot({ tabs: Array.from({ length: 17 }, (_, i) => tab(i + 1)) }),
    snapshot({ tabs: [tab(1, { draft: '🧪'.repeat(32768) + 'x' })] }), snapshot({ tabs: [tab(1, { draft: '\ud800' })] }),
    snapshot({ tabs: [tab(1, { draft: '\udc00' })] }), snapshot({ tabs: [tab(1, { title: 'a'.repeat(513) })] }),
    snapshot({ tabs: [tab(1, { localId: 'a'.repeat(129) })] }), snapshot({ tabs: [tab(1, { threadId: 't'.repeat(257) })] }),
    snapshot({ tabs: [tab(1, { sessionId: 's'.repeat(257) })] }), snapshot({ tabs: [tab(1, { modelId: 'm'.repeat(257) })] }),
    snapshot({ tabs: [tab(1, { effort: 'e'.repeat(65) })] }),
    snapshot({ tabs: Array.from({ length: 5 }, (_, i) => tab(i + 1, { draft: 'x'.repeat(128 * 1024) })) }),
    snapshot({ tabs: [tab(1, { draft: '\u0000'.repeat(128 * 1024) })] })];
  for (const input of bad) { await assert.rejects(f.raw('save', input), ERROR); await assert.rejects(f.call('save', input), ERROR); }
  assert.ok(f.disk.node(f.full).bytes.equals(prior)); assert.equal(f.disk.writes.length, writes); assert.equal(f.safeStorage.calls.length, calls);
  await f.call('save', snapshot({ tabs: [], activeTabId: null }));
  assert.deepEqual(json((await f.call('read')).preferences), snapshot({ tabs: [], activeTabId: null }));
});

test('production IPC gate rejects foreign owners, subframes and noncanonical URLs before effects', async () => {
  for (const change of [f => ({ sender: {}, senderFrame: f.event.senderFrame }),
    f => ({ sender: f.event.sender, senderFrame: { url: f.event.senderFrame.url } }),
    f => { f.event.senderFrame.url = 'https://foreign.invalid/studio'; return f.event; },
    f => { f.event.senderFrame.url = origin + '/studio?x=1'; return f.event; },
    f => { f.event.senderFrame.url = origin + '/a/../studio'; return f.event; },
    f => { f.event.senderFrame.url = origin + '/studio/'; return f.event; },
    f => { f.window.webContents.isDestroyed = () => true; return f.event; },
    f => { f.window.isDestroyed = () => true; return f.event; }]) {
    const f = fixture(); f.setEvent(change(f));
    await assert.rejects(f.raw('read'), ERROR); await assert.rejects(f.raw('save', snapshot()), ERROR);
    assert.equal(f.disk.reads, 0); assert.equal(f.disk.writes.length, 0); assert.deepEqual(f.safeStorage.calls, []);
  }
});

test('owner, epoch, origin, frame and project/directory identities are rechecked after await', async () => {
  for (const invalidate of [f => f.setState({ closing: true }), f => f.setState({ switching: true }),
    f => f.setState({ token: '' }), f => f.setState({ origin: 'http://127.0.0.1:45872' }),
    f => f.setState({ userRoot: 'C:\\OtherProfile' }), f => f.setState({ window: null }),
    f => f.setState({ projectSession: { projectId: f.projectId, projectPath: f.projectPath, stateRoot: f.stateRoot } }),
    f => { f.window.webContents.mainFrame = { url: origin + '/studio#fixture' }; },
    f => { f.event.senderFrame.url = origin + '/studio#new-frame'; },
    f => f.disk.put(f.projectPath), f => f.disk.put(f.stateRoot), f => f.disk.put(f.userRoot)]) {
    for (const action of ['read', 'save']) {
      const f = fixture(), pending = f.raw(action, ...action === 'save' ? [snapshot()] : []); invalidate(f);
      await assert.rejects(pending, ERROR);
      assert.equal(f.disk.writes.length, 0); assert.equal(f.safeStorage.calls.includes('encrypt'), false);
      assert.equal(f.safeStorage.calls.includes('decrypt'), false); assert.equal(f.disk.descriptors.size, 0);
    }
  }
});

test('disabled smoke, unsupported operating systems and unavailable encryption have no disk fallback', async () => {
  for (const options of [{ smoke: true }, { platform: 'linux' }, { platform: 'darwin' }, { unavailable: true }]) {
    const f = fixture(options); if (options.unavailable) f.safeStorage.setAvailable(false);
    assert.deepEqual(json(await f.call('read')), { available: false, preferences: null });
    await assert.rejects(f.call('save', snapshot()), ERROR);
    assert.equal(f.disk.reads, 0); assert.equal(f.disk.writes.length, 0);
    assert.equal(f.safeStorage.calls.some(c => c === 'encrypt' || c === 'decrypt'), false);
    if (!options.unavailable) assert.deepEqual(f.safeStorage.calls, []);
    f.setEvent({ sender: {}, senderFrame: f.event.senderFrame }); await assert.rejects(f.raw('read'), ERROR);
  }
});

test('host-selected project SHA path refuses inconsistent roots, links, redirections and hardlinks', async () => {
  for (const corrupt of [f => f.disk.put(f.full, { kind: 'file', nlink: 2n }),
    f => f.disk.put(f.full, { kind: 'link', physical: 'C:\\Provider\\auth.json' }),
    f => { f.disk.node(f.stateRoot).physical = 'C:\\Elsewhere'; },
    f => { f.disk.node(f.userRoot).kind = 'link'; }, f => { f.disk.node(f.projectPath).kind = 'link'; },
    f => { f.disk.node('C:\\Owned\\runtime').physical = 'C:\\Other'; },
    f => f.setState({ projectSession: { projectId: 'f'.repeat(64), projectPath: f.projectPath, stateRoot: f.stateRoot } }),
    f => f.setState({ projectSession: { projectId: f.projectId, projectPath: f.projectPath, stateRoot: 'C:\\Elsewhere' } }),
    f => f.setState({ projectSession: { projectId: f.projectId, projectPath: 'C:\\Project\\..\\Project', stateRoot: f.stateRoot } })]) {
    const f = fixture(); corrupt(f);
    await assert.rejects(f.raw('read'), ERROR); await assert.rejects(f.raw('save', snapshot()), ERROR);
    assert.equal(f.disk.writes.length, 0); assert.equal(f.safeStorage.calls.includes('decrypt'), false);
    assert.equal(f.safeStorage.calls.includes('encrypt'), false); assert.equal(f.disk.descriptors.size, 0);
  }
});

test('unknown versions, malformed, oversized and corrupt records are preserved with no repair', async () => {
  const corruptions = [Buffer.alloc(1024 * 1024 + 1), Buffer.from('not json'),
    Buffer.from('{"version":2,"ciphertext":"YQ=="}\n'), Buffer.from('{"version":1,"ciphertext":"bad"}\n'),
    Buffer.from('{"version":1,"ciphertext":"YQ==","path":"auth.json"}\n'),
    Buffer.from('{ "version":1,"ciphertext":"YQ=="}\n'), Buffer.from('{"version":1,"ciphertext":""}\n')];
  for (const bytes of corruptions) {
    const f = fixture(); f.disk.put(f.full, { kind: 'file', bytes });
    await assert.rejects(f.raw('read'), ERROR); await assert.rejects(f.raw('save', snapshot()), ERROR);
    assert.ok(f.disk.node(f.full).bytes.equals(bytes)); assert.equal(f.disk.writes.length, 0); assert.equal(f.disk.descriptors.size, 0);
  }
  for (const mutate of [p => { p.version = 2; }, p => { p.projectId = 'f'.repeat(64); }, p => { p.preferences.auth = {}; },
    p => { p.preferences.tabs[0].grants = []; }, p => { p.preferences.tabs.push(p.preferences.tabs[0]); },
    p => { p.preferences.activeTabId = 'unbound'; }, p => { p.preferences.tabs[0].draft = '\ud800'; }]) {
    const f = fixture(), payload = { version: 1, projectId: f.projectId, preferences: snapshot() }; mutate(payload);
    const bytes = Buffer.from(JSON.stringify({ version: 1, ciphertext: f.safeStorage.encryptString(JSON.stringify(payload)).toString('base64') }) + '\n');
    f.disk.put(f.full, { kind: 'file', bytes });
    await assert.rejects(f.raw('read'), ERROR); await assert.rejects(f.raw('save', snapshot()), ERROR);
    assert.ok(f.disk.node(f.full).bytes.equals(bytes)); assert.equal(f.disk.writes.length, 0); assert.equal(f.disk.descriptors.size, 0);
  }
});

test('foreign locks stop both read and save and concurrent IPC cannot overwrite', async () => {
  const f = fixture(), pending = f.raw('save', snapshot());
  const competingRead = f.raw('read'), competingSave = f.raw('save', snapshot({ provider: 'claude' }));
  await assert.rejects(competingRead, ERROR); await assert.rejects(competingSave, ERROR); await pending;
  const prior = Buffer.from(f.disk.node(f.full).bytes), writes = f.disk.writes.length;
  const foreign = f.disk.put(f.full + '.lock', { kind: 'file', bytes: Buffer.from('foreign') });
  await assert.rejects(f.raw('read'), ERROR); await assert.rejects(f.raw('save', snapshot()), ERROR);
  assert.ok(f.disk.node(f.full + '.lock') === foreign); assert.ok(f.disk.node(f.full).bytes.equals(prior));
  assert.equal(f.disk.writes.length, writes); assert.equal(f.disk.descriptors.size, 0);
});

test('write, flush and rename failures preserve previous ciphertext and clean only owned staging', async () => {
  for (const method of ['writeSync', 'fsyncSync', 'renameSync']) {
    const f = fixture(); await f.call('save', snapshot());
    const previous = Buffer.from(f.disk.node(f.full).bytes);
    f.disk.filesystem[method] = () => { throw new Error('Sensitive failure must never reach renderer.'); };
    await assert.rejects(f.call('save', snapshot({ provider: 'claude' })), ERROR);
    assert.ok(f.disk.node(f.full).bytes.equals(previous)); assert.equal(f.disk.descriptors.size, 0);
    assert.equal([...f.disk.nodes.values()].some(node => /\.(?:tmp|lock)$/.test(node.path)), false);
  }
});

test('safeStorage failures and mid-encryption changes cannot replace previous ciphertext', async () => {
  for (const mutate of [f => { throw new Error('Private encryption error.'); }, f => f.setState({ switching: true }),
    f => { f.disk.node(f.stateRoot).physical = 'C:\\Elsewhere'; }, f => { f.disk.node(f.full).nlink = 2n; },
    f => f.safeStorage.setAvailable(false), f => f.disk.put(f.full + '.lock', { kind: 'file', bytes: Buffer.from('foreign') })]) {
    const f = fixture(); await f.raw('save', snapshot());
    const previous = Buffer.from(f.disk.node(f.full).bytes), encrypt = f.safeStorage.encryptString;
    f.safeStorage.encryptString = plain => { const bytes = encrypt(plain); mutate(f); return bytes; };
    await assert.rejects(f.raw('save', snapshot({ provider: 'claude' })), ERROR);
    assert.ok(f.disk.node(f.full).bytes.equals(previous)); assert.equal(f.disk.descriptors.size, 0);
  }
});

test('decryption rechecks current owner, origin, project, file identity and encryption availability', async () => {
  for (const mutate of [f => f.setState({ switching: true }), f => f.setState({ origin: 'http://127.0.0.1:49999' }),
    f => f.disk.put(f.projectPath), f => { f.disk.node(f.full).bytes[0] ^= 1; },
    f => f.safeStorage.setAvailable(false), f => f.disk.put(f.full + '.lock', { kind: 'file' })]) {
    const f = fixture(); await f.raw('save', snapshot());
    const decrypt = f.safeStorage.decryptString;
    f.safeStorage.decryptString = bytes => { const plain = decrypt(bytes); mutate(f); return plain; };
    const writes = f.disk.writes.length;
    await assert.rejects(f.raw('read'), ERROR); assert.equal(f.disk.writes.length, writes); assert.equal(f.disk.descriptors.size, 0);
  }
});

test('1 MiB encrypted-envelope cap rejects unexpected safeStorage expansion before creating files', async () => {
  for (const returned of [null, '', Buffer.alloc(0), Buffer.alloc(1024 * 1024), Buffer.alloc(1024 * 1024 + 1)]) {
    const f = fixture(); f.safeStorage.encryptString = () => returned;
    await assert.rejects(f.call('save', snapshot()), ERROR);
    assert.equal(f.disk.writes.length, 0); assert.equal(f.disk.descriptors.size, 0);
  }
});

test('lost ownership after atomic rename never returns saved; failed lock cleanup never acknowledges', async () => {
  for (const afterWrite of [f => f.setState({ switching: true }), f => f.safeStorage.setAvailable(false)]) {
    const f = fixture(), rename = f.disk.filesystem.renameSync;
    f.disk.filesystem.renameSync = (from, to) => { rename(from, to); afterWrite(f); };
    await assert.rejects(f.call('save', snapshot()), ERROR);
    assert.equal(f.disk.descriptors.size, 0);
    assert.equal(f.disk.node(f.full).bytes.includes('Chat 1'), false);
  }
  const f = fixture(); f.disk.filesystem.unlinkSync = () => { throw new Error('Locked fixture.'); };
  await assert.rejects(f.call('save', snapshot()), ERROR);
  assert.equal(f.disk.descriptors.size, 0); await assert.rejects(f.call('read'), ERROR);
});

test('preload validates all replies and sanitizes IPC failures without draft or path values', async () => {
  const f = fixture(); f.setInvokeError('Private draft / profile path / encryption exception');
  await assert.rejects(f.call('read'), ERROR); await assert.rejects(f.call('save', snapshot()), ERROR);
  f.setInvokeError(undefined);
  for (const reply of [{ available: true }, { available: false, preferences: snapshot() }, { available: 'yes', preferences: null },
    { available: true, preferences: null, auth: {} }, { available: true, preferences: snapshot({ version: 2 }) }]) {
    f.setReply(reply); await assert.rejects(f.call('read'), ERROR);
  }
  for (const reply of [{ saved: false }, { saved: true, draft: 'private' }, { saved: 1 }, null]) {
    f.setReply(reply); await assert.rejects(f.call('save', snapshot()), ERROR);
  }
  f.setReply(undefined); assert.deepEqual(json(await f.call('save', snapshot())), { saved: true });
});

test('lock/stage substitution during a write preserves foreign nodes and the previous record', async () => {
  for (const target of ['lock', 'stage']) {
    const f = fixture(); await f.call('save', snapshot());
    const previous = Buffer.from(f.disk.node(f.full).bytes), write = f.disk.filesystem.writeSync;
    let foreign, foreignPath;
    f.disk.filesystem.writeSync = (...args) => {
      const count = write(...args);
      foreignPath = target === 'lock' ? f.full + '.lock' : [...f.disk.nodes.values()].find(n => n.path.endsWith('.tmp')).path;
      foreign = f.disk.put(foreignPath, { kind: 'file', bytes: Buffer.from('foreign') }); return count;
    };
    await assert.rejects(f.call('save', snapshot({ provider: 'claude' })), ERROR);
    assert.ok(f.disk.node(foreignPath) === foreign); assert.ok(f.disk.node(f.full).bytes.equals(previous));
    assert.equal(f.disk.descriptors.size, 0);
  }
});

test('non-progress writes are bounded; short successful writes are handled until complete', async () => {
  for (const count of [0, -1, NaN, 1.5, 1024 * 1024 + 1]) {
    const f = fixture(); f.disk.filesystem.writeSync = () => count;
    await assert.rejects(f.call('save', snapshot()), ERROR);
    assert.equal(f.disk.nodes.has(f.disk.key(f.full)), false); assert.equal(f.disk.descriptors.size, 0);
    assert.equal([...f.disk.nodes.values()].some(n => /\.(?:lock|tmp)$/.test(n.path)), false);
  }
  const f = fixture(), write = f.disk.filesystem.writeSync;
  f.disk.filesystem.writeSync = (fd, bytes, offset, length) => write(fd, bytes, offset, Math.min(length, 17));
  await f.call('save', snapshot()); assert.deepEqual(json((await f.call('read')).preferences), snapshot());
});

test('serialized decrypted limits and noncanonical plaintext are rejected without repair', async () => {
  for (const plain of [JSON.stringify({ version: 1, projectId: 'f'.repeat(64), preferences: snapshot() }) + ' ',
    'x'.repeat(512 * 1024 + 1)]) {
    const f = fixture(), bytes = Buffer.from(JSON.stringify({ version: 1, ciphertext: f.safeStorage.encryptString(plain).toString('base64') }) + '\n');
    f.disk.put(f.full, { kind: 'file', bytes });
    await assert.rejects(f.call('read'), ERROR); await assert.rejects(f.call('save', snapshot()), ERROR);
    assert.equal(f.disk.writes.length, 0); assert.ok(f.disk.node(f.full).bytes.equals(bytes)); assert.equal(f.disk.descriptors.size, 0);
  }
});

test('native operations never read credential files or use presentation IDs as filesystem paths', async () => {
  const f = fixture(), observed = [], open = f.disk.filesystem.openSync, stat = f.disk.filesystem.lstatSync;
  f.disk.filesystem.openSync = (name, ...args) => { observed.push(name); return open(name, ...args); };
  f.disk.filesystem.lstatSync = (name, ...args) => { observed.push(name); return stat(name, ...args); };
  const input = snapshot({ tabs: [tab(1, { threadId: 'auth.json', sessionId: 'provider.credentials', modelId: 'config.json', draft: 'Untouched raw user bytes' })] });
  await f.call('save', input); assert.deepEqual(json((await f.call('read')).preferences), input);
  assert.ok(observed.every(name => !/\\(?:auth\.json|provider\.credentials|config\.json)$/.test(name)));
  assert.ok(observed.every(name => name === 'C:\\' || name === f.projectPath || name === f.userRoot ||
    name === 'C:\\Owned\\runtime' || name === 'C:\\Owned\\runtime\\projects' || name === f.stateRoot || name.startsWith(f.full)));
});

test('unprepared state parents fail closed without creating directories', async () => {
  const f = fixture(); f.disk.nodes.delete(f.disk.key(f.stateRoot));
  await assert.rejects(f.raw('read'), ERROR); await assert.rejects(f.raw('save', snapshot()), ERROR);
  assert.equal(f.disk.writes.length, 0); assert.equal(f.safeStorage.calls.includes('encrypt'), false);
});


test('optional workflowDraft flag round-trips through preload and host; legacy rows stay plain; malformed values are refused', async () => {
  const f = fixture();
  const flagged = snapshot({ tabs: [tab(1, { draft: 'Workflow generated text', workflowDraft: true }), tab(2, { draft: 'Typed text', workflowDraft: false })] });
  assert.deepEqual(json(await f.call('save', flagged)), { saved: true });
  assert.deepEqual(json(await f.call('read')), { available: true, preferences: flagged });
  assert.deepEqual(json(await f.raw('read')), { available: true, preferences: flagged });
  // Rows without the flag (written before it existed) are accepted and read back without inventing one.
  const legacy = snapshot({ tabs: [tab(1, { draft: 'Legacy typed text' })] });
  assert.deepEqual(json(await f.call('save', legacy)), { saved: true });
  const legacyRead = json(await f.call('read'));
  assert.deepEqual(legacyRead, { available: true, preferences: legacy }); assert.equal(Object.hasOwn(legacyRead.preferences.tabs[0], 'workflowDraft'), false);
  // A canonical encrypted record from an older build still decrypts and validates unchanged.
  const g = fixture(), payload = { version: 1, projectId: g.projectId, preferences: legacy };
  g.disk.put(g.full, { kind: 'file', bytes: Buffer.from(JSON.stringify({ version: 1, ciphertext: g.safeStorage.encryptString(JSON.stringify(payload)).toString('base64') }) + '\n') });
  assert.deepEqual(json(await g.call('read')), { available: true, preferences: legacy });
  const prior = Buffer.from(f.disk.node(f.full).bytes), writes = f.disk.writes.length;
  for (const workflowDraft of ['yes', 'true', 1, 0, null, {}, []]) {
    const bad = snapshot({ tabs: [tab(1, { workflowDraft })] });
    await assert.rejects(f.raw('save', bad), ERROR); await assert.rejects(f.call('save', bad), ERROR);
    f.setReply({ available: true, preferences: bad }); await assert.rejects(f.call('read'), ERROR); f.setReply(undefined);
  }
  assert.ok(f.disk.node(f.full).bytes.equals(prior)); assert.equal(f.disk.writes.length, writes);
  const stored = fixture(), badPayload = { version: 1, projectId: stored.projectId, preferences: snapshot({ tabs: [tab(1, { workflowDraft: 'yes' })] }) };
  stored.disk.put(stored.full, { kind: 'file', bytes: Buffer.from(JSON.stringify({ version: 1, ciphertext: stored.safeStorage.encryptString(JSON.stringify(badPayload)).toString('base64') }) + '\n') });
  await assert.rejects(stored.raw('read'), ERROR); await assert.rejects(stored.call('read'), ERROR);
});


const claudeSnapshot = (values = {}) => snapshot({provider:'claude',tabs:[tab(1,{provider:'claude',threadId:'conversation-1',draft:'Unsent Claude text\n  keep whitespace 🧩',modelId:'claude-opus-4-6',effort:'low'})],...values});
test('Claude preferences use their own encrypted record and retain drafts, tabs and model across host restart',async()=>{
 const f=fixture({includeClaude:true});
 assert.equal(Object.isFrozen(f.exposed.claudePreferences),true);
 assert.deepEqual(json(await f.claude('read')),{available:true,projectPath:f.projectPath,preferences:null});
 const codex=snapshot({tabs:[tab(1,{draft:'Codex draft'})]});await f.call('save',codex);
 const claude=claudeSnapshot();await f.claude('save',claude);
 const full=win32.join(f.stateRoot,'claude-preferences.v1.json');
 assert.equal(f.disk.node(full).bytes.includes(Buffer.from(claude.tabs[0].draft)),false);
 assert.deepEqual(json((await f.call('read')).preferences),codex);
 const restarted=fixture({disk:f.disk,safeStorage:f.safeStorage,origin:'http://127.0.0.1:45872',includeClaude:true});
 assert.deepEqual(json(await restarted.claude('read')),{available:true,projectPath:f.projectPath,preferences:claude});
 assert.deepEqual(json((await restarted.call('read')).preferences),codex);
 assert.equal(f.disk.descriptors.size,0);
});

test('encrypted Claude preference records reject cross-record substitution and non-Claude rows',async()=>{
 const f=fixture({includeClaude:true});await f.call('save',snapshot());await f.claude('save',claudeSnapshot());
 const full=win32.join(f.stateRoot,'claude-preferences.v1.json'),original=Buffer.from(f.disk.node(full).bytes);
 f.disk.put(full,{kind:'file',bytes:Buffer.from(f.disk.node(f.full).bytes)});
 await assert.rejects(f.claude('read'),ERROR);
 f.disk.put(full,{kind:'file',bytes:original});
 for(const value of [snapshot(),claudeSnapshot({tabs:[tab(1,{provider:'claude',sessionId:'foreign-session'})]}),claudeSnapshot({tabs:[tab(1,{provider:'claude',workflowDraft:false})]})])await assert.rejects(f.claude('save',value),ERROR);
 assert.deepEqual(json((await f.claude('read')).preferences),claudeSnapshot());
 assert.equal(f.disk.descriptors.size,0);
});

test('Claude preference channels preserve exact frame/project guards and are inert when disabled',async()=>{
 const f=fixture({includeClaude:true});
 f.setEvent({...f.event,senderFrame:{url:origin+'/studio#fixture'}});await assert.rejects(f.claude('read'),ERROR);
 f.setEvent(f.event);await assert.rejects(f.claude('read','invented-record'),ERROR);
 await assert.rejects(f.claude('save',claudeSnapshot({projectPath:'C:\\Other'})),ERROR);
 assert.equal(f.disk.writes.length,0);
 const disabled=fixture({includeClaude:true,smoke:true});assert.deepEqual(json(await disabled.claude('read')),{available:false,projectPath:null,preferences:null});
 await assert.rejects(disabled.claude('save',claudeSnapshot()),ERROR);assert.deepEqual(disabled.safeStorage.calls,[]);assert.equal(disabled.disk.writes.length,0);
});

test('concurrent Claude and Codex preference saves remain independent',async()=>{
 const f=fixture({includeClaude:true}),claude=claudeSnapshot(),codex=snapshot({tabs:[tab(1,{draft:'Independent Codex text'})]});
 await Promise.all([f.claude('save',claude),f.call('save',codex)]);
 const [a,b]=await Promise.all([f.claude('read'),f.call('read')]);assert.deepEqual(json(a.preferences),claude);assert.deepEqual(json(b.preferences),codex);assert.equal(f.disk.descriptors.size,0);
});


test('Claude preferences preserve reported model aliases without changing the Codex record schema',async()=>{
 const f=fixture({includeClaude:true}),value=claudeSnapshot({tabs:[tab(1,{provider:'claude',modelId:'sonnet[1m]',draft:'Model alias draft'})]});
 await f.claude('save',value);assert.deepEqual(json((await f.claude('read')).preferences),value);
 await assert.rejects(f.call('save',snapshot({tabs:[tab(1,{modelId:'sonnet[1m]'})]})),ERROR);
});
