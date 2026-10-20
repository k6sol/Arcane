// Offline host fixtures: no Electron, dialogs, native CLI, daemon, providers or Studio execute.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { win32 } from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import * as managedBootstrap from '../../scripts/managed-luau-compiler.mjs';

const read = name => fs.readFileSync(new URL('../../' + name, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const hostSource = read('apps/desktop/electron/code-verification.cjs');
const policySource = read('apps/desktop/electron/policy.cjs');
const preloadSource = read('apps/desktop/electron/preload.cjs');
const mainSource = read('apps/desktop/electron/main.cjs');
const APPROVED = '74cf7ed3621b8966bac6fec7f1a0caf13616655fa06d346133cd31f6aac439d8';
const COMPILER_BYTES = 1403904;
const syntheticCompiler = Buffer.alloc(COMPILER_BYTES, 0x4c);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const origin = 'http://127.0.0.1:45871';
const generic = /^Luau verification configuration is unavailable\.$/;
const json = value => JSON.parse(JSON.stringify(value));

function loadHost({ filesystem, paths = win32, platform = 'win32', approvedFixture = false }) {
  const policyModule = { exports: {} };
  vm.runInNewContext(policySource, { module: policyModule, URL, process: { platform }, require(name) {
    if (name === 'node:path') return paths;
    if (name === 'node:fs') return filesystem;
    if (name === 'node:fs/promises') return {};
    throw new Error('Unexpected policy dependency.');
  } });
  const module = { exports: {} };
  const fixtureCrypto = approvedFixture ? { ...crypto, createHash(algorithm) {
    const chunks = [];
    return { update(bytes) { chunks.push(Buffer.from(bytes)); return this; }, digest(format) {
      const bytes = Buffer.concat(chunks);
      // This explicit digest double applies only to synthetic fixture bytes. Production has no pin override.
      return bytes.equals(syntheticCompiler) ? APPROVED : crypto.createHash(algorithm).update(bytes).digest(format);
    } };
  } } : crypto;
  vm.runInNewContext(hostSource, { module, URL, Buffer, process: { platform }, require(name) {
    if (name === 'node:path') return paths;
    if (name === 'node:fs') return filesystem;
    if (name === 'node:crypto') return fixtureCrypto;
    if (name === './policy.cjs') return policyModule.exports;
    throw new Error('Unexpected host dependency: ' + name);
  } }, { filename: 'code-verification.cjs' });
  return { host: module.exports, policy: policyModule.exports };
}

function filesystemDouble() {
  const nodes = new Map(), descriptors = new Map(), writes = []; let identity = 0n, fd = 10;
  const key = name => win32.resolve(name).toLowerCase();
  function put(name, options = {}) {
    const value = { path: win32.resolve(name), kind: 'directory', ino: ++identity, dev: 1n, nlink: 1n,
      mode: 0o40700n, mtimeNs: 1n, ctimeNs: 1n, bytes: Buffer.alloc(0), ...options };
    if (value.kind === 'file') value.mode = 0o100600n;
    nodes.set(key(name), value); return value;
  }
  function ensure(name) { for (let current = win32.resolve(name);; current = win32.dirname(current)) {
    if (!nodes.has(key(current))) put(current);
    if (current === win32.dirname(current)) break;
  } }
  function node(name) { const value = nodes.get(key(name)); if (!value) throw Object.assign(new Error('Absent fixture file.'), { code: 'ENOENT' }); return value; }
  function stat(value) { return { ...value, size: BigInt(value.bytes.length), isDirectory: () => value.kind === 'directory',
    isFile: () => value.kind === 'file', isSymbolicLink: () => value.kind === 'link' }; }
  const filesystem = {
    constants: fs.constants,
    lstatSync: name => stat(node(name)), realpathSync: name => node(name).physical ?? node(name).path,
    fstatSync: descriptor => stat(descriptors.get(descriptor).node),
    openSync(name, flags) {
      let value;
      if (typeof flags === 'string' && flags.startsWith('wx')) {
        if (nodes.has(key(name))) throw Object.assign(new Error('Existing fixture file.'), { code: 'EEXIST' });
        node(win32.dirname(name)); value = put(name, { kind: 'file' }); writes.push(['create', name]);
      } else value = node(name);
      const descriptor = ++fd; descriptors.set(descriptor, { node: value, cursor: 0, readable: typeof flags !== 'string' || flags.includes('+') }); return descriptor;
    },
    closeSync: descriptor => { assert.ok(descriptors.delete(descriptor), 'No duplicate descriptor close.'); },
    readSync(descriptor, buffer, offset, length, position) {
      const handle = descriptors.get(descriptor); assert.equal(handle.readable, true);
      const count = Math.max(0, Math.min(length, handle.node.bytes.length - position));
      handle.node.bytes.copy(buffer, offset, position, position + count); return count;
    },
    writeSync(descriptor, bytes, offset, length) {
      const handle = descriptors.get(descriptor), value = handle.node;
      value.bytes = Buffer.concat([value.bytes, bytes.subarray(offset, offset + length)]);
      value.mtimeNs++; value.ctimeNs++; handle.cursor += length; return length;
    },
    fsyncSync() {},
    renameSync(from, to) { const value = node(from); nodes.delete(key(from)); value.path = win32.resolve(to); value.ctimeNs++; nodes.set(key(to), value); writes.push(['rename', from, to]); },
    unlinkSync(name) { node(name); nodes.delete(key(name)); writes.push(['unlink', name]); },
  };
  return { filesystem, ensure, put, node, nodes, descriptors, writes, key };
}

function fixture({ smoke = false, approvedFixture = true, configured = false } = {}) {
  const disk = filesystemDouble(), projectPath = 'C:\\Project', compilerPath = 'C:\\Tools\\luau-compile.exe';
  const projectId = hash(projectPath.toLowerCase()), stateRoot = 'C:\\Owned\\runtime\\projects\\' + projectId;
  disk.ensure(projectPath + '\\evidence'); disk.ensure('C:\\Tools'); disk.ensure(stateRoot);
  disk.put(compilerPath, { kind: 'file', bytes: Buffer.from(syntheticCompiler) });
  const configPath = stateRoot + '\\luau-verification.json';
  const settings = { version: 1, projectId, compilerPath, compilerSha256: APPROVED, evidenceDirectory: 'evidence' };
  if (configured) disk.put(configPath, { kind: 'file', bytes: Buffer.from(JSON.stringify(settings) + '\n') });
  const mainFrame = { url: origin + '/studio#' + 'a'.repeat(64) };
  const window = { isDestroyed: () => false, webContents: { mainFrame, isDestroyed: () => false } };
  let session = { projectId, projectPath, stateRoot, origin, window, epoch: {}, activeSettingsHash: configured ? hash(JSON.stringify(settings) + '\n') : null };
  const opens = [], confirmations = []; let onOpen, onConfirm;
  const dialog = {
    async showOpenDialog(owner, options) {
      assert.equal(owner, window); opens.push(options);
      if (onOpen) return await onOpen(options, opens.length);
      return { canceled: false, filePaths: [options.properties.includes('openFile') ? compilerPath : projectPath + '\\evidence'] };
    },
    async showMessageBox(owner, options) {
      assert.equal(owner, window); confirmations.push(options);
      return onConfirm ? await onConfirm(options) : { response: 1 };
    },
  };
  const { host, policy } = loadHost({ filesystem: disk.filesystem, approvedFixture });
  const api = host.createCodeVerification({ dialog, getSession: () => session, smoke });
  return { disk, api, host, policy, projectId, projectPath, compilerPath, stateRoot, configPath, settings, window, mainFrame, opens, confirmations,
    session: () => session, setSession: value => { session = value; }, onOpen: callback => { onOpen = callback; }, onConfirm: callback => { onConfirm = callback; } };
}

async function rejectsGeneric(action) { await assert.rejects(action, error => { assert.match(error.message, generic); return true; }); }
function throwsGeneric(action) { assert.throws(action, error => { assert.match(error.message, generic); return true; }); }
const expectedStatus = (f, options = {}) => ({ version: 1, projectId: f.projectId, configured: false, pendingRestart: false, evidenceDirectory: null, cancelled: false, ...options });

test('fixed approved pin and minimal persisted tuple; status and configure never launch anything', async () => {
  const f = fixture();
  assert.equal(f.host.COMPILER_SHA256, APPROVED); assert.equal(f.host.COMPILER_BYTES, COMPILER_BYTES);
  assert.deepEqual(json(await f.api.status()), expectedStatus(f));
  assert.deepEqual(json(await f.api.configure()), expectedStatus(f, { configured: true, pendingRestart: true, evidenceDirectory: 'evidence' }));
  assert.deepEqual(JSON.parse(f.disk.node(f.configPath).bytes), f.settings);
  assert.equal(f.opens.length, 2); assert.equal(f.confirmations.length, 1);
  const confirmation = f.confirmations[0];
  assert.equal(confirmation.defaultId, 0); assert.equal(confirmation.cancelId, 0);
  assert.match(confirmation.detail, /next manual Arcane restart/);
  assert.doesNotMatch(confirmation.detail, /reconnect/);
  assert.equal(f.disk.descriptors.size, 0);
  assert.ok(f.disk.writes.every(([, ...names]) => names.every(name => name.startsWith(f.stateRoot + '\\'))));
  assert.doesNotMatch(hostSource, /child_process|spawn\(|execFile|fetch\(|copyFile|mkdir|chmod|powershell/i);
});

test('launch reads settings and validates compiler and evidence; only the three approved env fields are emitted', async () => {
  const f = fixture(); await f.api.configure();
  const configured = f.api.daemonConfiguration(f.session());
  assert.deepEqual(json(configured.environment), { ARCANE_LUAU_COMPILER_PATH: f.compilerPath,
    ARCANE_LUAU_COMPILER_SHA256: APPROVED, ARCANE_LUAU_EVIDENCE_DIRECTORY: 'evidence' });
  f.session().activeSettingsHash = configured.settingsHash;
  assert.equal((await f.api.status()).pendingRestart, false);
  const filtered = f.policy.daemonEnvironment({ ARCANE_LUAU_COMPILER_PATH: 'C:\\Untrusted.exe',
    arcane_luau_compiler_sha256: 'b'.repeat(64), ARCANE_LUAU_EVIDENCE_DIRECTORY: 'foreign' },
  { productRoot: 'C:\\App', stateRoot: f.stateRoot, projectPath: f.projectPath });
  Object.assign(filtered, configured.environment);
  for (const key of f.host.ENV_KEYS) assert.equal(filtered[key], configured.environment[key]);
  assert.equal('arcane_luau_compiler_sha256' in filtered, false);
  assert.match(mainSource, /managedCodeVerificationConfiguration\(\{ codeVerification,[\s\S]*Object\.assign\(env, verification\.environment\)[\s\S]*spawn\(nodeExecutable/);
});

test('missing compiler is isolated with explicit host-only metadata; persisted configuration remains readable', async () => {
  const f = fixture({ configured: true });
  f.disk.nodes.delete(f.disk.key(f.compilerPath));
  assert.equal((await f.api.status()).configured, true);
  assert.deepEqual(json(f.api.daemonConfiguration(f.session())), { environment: {}, settingsHash: null, failure: 'compiler-unavailable' });
  assert.equal(f.disk.writes.length, 0);
});

test('cold-start compiler failures emit no compiler env, retain source config and start no process or tools', async () => {
  for (const invalidate of [
    f => { f.disk.nodes.delete(f.disk.key(f.compilerPath)); },
    f => { f.disk.node(f.compilerPath).bytes = Buffer.alloc(1); },
    f => { f.disk.node(f.compilerPath).bytes[0] = 0; },
    f => { f.disk.node(f.compilerPath).nlink = 2n; },
    f => { f.disk.node('C:\\Tools').kind = 'link'; },
  ]) {
    const f = fixture({ configured: true }), original = Buffer.from(f.disk.node(f.configPath).bytes);
    invalidate(f);
    const configured = f.api.daemonConfiguration(f.session());
    assert.deepEqual(json(configured), { environment: {}, settingsHash: null, failure: 'compiler-unavailable' });
    const environment = f.policy.daemonEnvironment({ ARCANE_LUAU_COMPILER_PATH: 'C:\\foreign.exe',
      ARCANE_LUAU_COMPILER_SHA256: 'b'.repeat(64), ARCANE_LUAU_EVIDENCE_DIRECTORY: 'foreign' },
    { productRoot: 'C:\\App', stateRoot: f.stateRoot, projectPath: f.projectPath });
    Object.assign(environment, configured.environment);
    for (const key of f.host.ENV_KEYS) assert.equal(Object.hasOwn(environment, key), false);
    f.session().activeSettingsHash = configured.settingsHash;
    assert.deepEqual(json(await f.api.status()), expectedStatus(f, { configured: true, pendingRestart: true, evidenceDirectory: 'evidence' }));
    assert.deepEqual(f.disk.node(f.configPath).bytes, original);
    assert.equal(f.disk.writes.length, 0); assert.equal(f.opens.length, 0); assert.equal(f.confirmations.length, 0);
    assert.equal(f.disk.descriptors.size, 0);
  }
});

test('compiler isolation does not swallow project, state, evidence or persisted-settings security failures', () => {
  for (const invalidate of [
    f => { f.disk.node(f.projectPath).kind = 'link'; },
    f => { f.disk.node(f.stateRoot).physical = 'C:\\foreign'; },
    f => { f.disk.node(f.configPath).nlink = 2n; },
    f => { f.disk.node(f.configPath).bytes = Buffer.from('{corrupt'); },
    f => { f.disk.nodes.delete(f.disk.key(f.projectPath + '\\evidence')); },
    f => { const lstat = f.disk.filesystem.lstatSync;
      f.disk.filesystem.lstatSync = name => {
        if (f.disk.key(name) === f.disk.key(f.compilerPath)) {
          f.disk.node(f.configPath).bytes = Buffer.from('{changed during compiler check');
          throw new Error('C:\\secret\\compiler error');
        }
        return lstat(name);
      };
    },
  ]) {
    const f = fixture({ configured: true }); invalidate(f);
    throwsGeneric(() => f.api.daemonConfiguration(f.session()));
    assert.equal(f.disk.writes.length, 0); assert.equal(f.disk.descriptors.size, 0);
  }
});

test('an unavailable compiler can be corrected through native dialog doubles without restarting active work', async () => {
  const f = fixture({ configured: true }); f.disk.nodes.delete(f.disk.key(f.compilerPath));
  const unavailable = f.api.daemonConfiguration(f.session()); f.session().activeSettingsHash = unavailable.settingsHash;
  assert.equal((await f.api.status()).pendingRestart, true);
  const session = f.session();
  f.disk.put(f.compilerPath, { kind: 'file', bytes: Buffer.from(syntheticCompiler) });
  assert.deepEqual(json(await f.api.configure()), expectedStatus(f, { configured: true, pendingRestart: true, evidenceDirectory: 'evidence' }));
  assert.equal(f.session(), session); assert.equal(f.session().activeSettingsHash, null);
  assert.equal(f.opens.length, 2); assert.equal(f.confirmations.length, 1); assert.equal(f.disk.descriptors.size, 0);
  // Only a subsequent startup consumes the corrected compiler; configuration alone leaves the active session unchanged.
  const nextStart = f.api.daemonConfiguration(f.session()); assert.equal(nextStart.failure, null);
  assert.equal(nextStart.environment.ARCANE_LUAU_COMPILER_PATH, f.compilerPath);
});

test('main cold start passes an isolated unavailable compiler to the core daemon double with a generic warning', async () => {
  const f = fixture({ configured: true }), original = Buffer.from(f.disk.node(f.configPath).bytes);
  f.disk.nodes.delete(f.disk.key(f.compilerPath));
  const begin = mainSource.indexOf('async function startDaemon('), end = mainSource.indexOf('function makeWindow()', begin);
  assert.ok(begin >= 0 && end > begin);
  const warnings = [], requested = [], owned = [], child = new EventEmitter();
  const warning = /const CODE_VERIFICATION_WARNING = ('[^']*');/.exec(mainSource)?.[1];
  assert.ok(warning);
  const context = { projectSession: null, child: null, origin: '', token: '', closing: false, switching: false,
    projectPath: '', userRoot: 'C:\\Owned', productRoot: 'C:\\App', nodeExecutable: 'C:\\App\\node.exe',
    process: { platform: 'win32', env: { ARCANE_LUAU_COMPILER_PATH: 'C:\\foreign.exe' } },
    performance: { now: () => 0 }, started: 0, daemonReadyMs: 0, join: win32.join, resolve: win32.resolve, createHash: crypto.createHash, Buffer,
    fs: { ...f.disk.filesystem, writeFileSync(fd, bytes) { const value = Buffer.from(bytes); f.disk.filesystem.writeSync(fd, value, 0, value.length); } },
    codeVerification: f.api, managedBootstrap, URL, setTimeout: () => 1, clearTimeout() {}, console: { warn: text => warnings.push(text) },
    policy: { ...f.policy, directPath: async value => value },
    ownedDirectory: async value => { owned.push(value); return value; },
    smoke: false, window: null, nativeHandoff: null, providerSetup: { cancelPending() {} },
    recordStartupDiagnostic() {}, attachDiagnosticChild() {},
    // Compiler isolation is the boundary under test. The separate handoff suite
    // executes its actual broker; here the newly mounted host capability has no actions.
    require(name) {
      assert.equal(name, './native-handoff-host.cjs');
      return { createNativeHandoffHost(ports) {
        assert.deepEqual(Object.keys(ports).sort(), ['confirm', 'getChoices', 'getSession', 'launchTerminal']);
        assert.equal(ports.getSession(), null, 'A compiler fixture has no desktop window.');
        return Object.freeze({ dispose: async () => ({ revoked: 0, unknown: 0, retained: 0 }), cancelPending() {} });
      } };
    },
    readFile: async () => { throw Object.assign(new Error('Fixture has no saved listener.'), { code: 'ENOENT' }); },
    writeFile: async (name, bytes) => { assert.equal(name, f.stateRoot + '\\listener-port.json'); assert.equal(JSON.parse(bytes).port, 45871); },
    spawn: (executable, args, options) => {
      requested.push({ executable, args, options });
      queueMicrotask(() => child.emit('message', { type: 'arcane-ready', protocolVersion: 1, origin, token: 'a'.repeat(64) }));
      return child;
    }, runtimeStopped() { assert.fail('Core startup must survive only this compiler-specific failure.'); },
  };
  vm.createContext(context);
  // Substitute only the module loader in this VM; run the real managed resolver
  // and existing host adapter. This fixture has saved settings, so no managed FS is touched.
  const bootstrap = mainSource.slice(begin, end);
  const moduleLoad = "await import(require('node:url').pathToFileURL(join(productRoot, 'scripts/managed-luau-compiler.mjs')).href)";
  assert.ok(bootstrap.includes(moduleLoad));
  vm.runInContext('const CODE_VERIFICATION_WARNING = ' + warning + ';\n' + bootstrap.replace(moduleLoad, 'managedBootstrap') + '\nglobalThis.coldStart = startDaemon;', context);
  await context.coldStart(f.projectPath);
  assert.equal(requested.length, 1, 'Only an in-memory core daemon spawn request is observed; no process executes.');
  // State ownership precedes the spawn; the handoff directory is owned only after readiness.
  assert.deepEqual(owned, [f.stateRoot, f.stateRoot + '\\native-handoffs']);
  for (const key of f.host.ENV_KEYS) assert.equal(Object.hasOwn(requested[0].options.env, key), false);
  assert.equal(context.projectSession.activeSettingsHash, null);
  assert.equal(context.projectSession.verificationUnavailable, true); assert.equal(context.projectSession.verificationEnvironmentAbsent, true);
  assert.equal(warnings.length, 1); assert.match(warnings[0], /opened without Luau verification/);
  for (const value of [f.compilerPath, f.projectPath, f.stateRoot]) assert.equal(warnings[0].includes(value), false);
  assert.deepEqual(f.disk.node(f.configPath).bytes, original); assert.deepEqual(f.disk.writes, [['create', f.stateRoot + '\\daemon-stderr.log'], ['create', f.stateRoot + '\\listener-port.json']]); assert.equal(f.opens.length, 0);
  // Settings validation remains fatal in main, before even the daemon double is requested.
  f.disk.node(f.configPath).bytes = Buffer.from('{corrupt'); context.origin = ''; context.token = '';
  await rejectsGeneric(context.coldStart(f.projectPath)); assert.equal(requested.length, 1);
});

test('compiler warning is native and generic, suppressed in smoke, and cannot make core startup fail', async () => {
  const begin = mainSource.indexOf('async function showCodeVerificationWarning()'), end = mainSource.indexOf('async function loadWorkspace()', begin);
  assert.ok(begin >= 0 && end > begin);
  const warnings = [], dialogs = [];
  const context = { smoke: true, closing: false, window: { isDestroyed: () => false }, projectSession: { verificationUnavailable: true },
    CODE_VERIFICATION_WARNING: 'Generic warning fixture.', console: { warn: text => warnings.push(text) },
    dialog: { async showMessageBox(_owner, options) { dialogs.push(options); } } };
  vm.createContext(context);
  vm.runInContext(mainSource.slice(begin, end) + '\nglobalThis.showWarning = showCodeVerificationWarning;', context);
  await context.showWarning(); assert.equal(dialogs.length, 0);
  context.smoke = false; await context.showWarning(); assert.equal(dialogs.length, 1); assert.equal(dialogs[0].type, 'warning');
  context.dialog.showMessageBox = async () => { throw new Error('C:\\secret\\dialog error'); };
  await assert.doesNotReject(context.showWarning());
  assert.deepEqual(warnings, ['Luau verification warning could not be displayed.']);
  assert.match(mainSource, /optionalCodeVerificationFailureContained:/);
  assert.match(mainSource, /codeVerification: \{ configuredUnavailable: projectSession\.verificationUnavailable \}/);
});

test('compiler hash, filename, size, hardlinks, redirects and physical ancestors reject before confirmation', async () => {
  for (const change of [
    f => { f.disk.node(f.compilerPath).bytes[0] = 0; },
    f => { f.disk.node(f.compilerPath).bytes = Buffer.alloc(1); },
    f => { f.disk.node(f.compilerPath).nlink = 2n; },
    f => { f.disk.node(f.compilerPath).kind = 'link'; },
    f => { f.disk.node('C:\\Tools').physical = 'C:\\Other'; },
    f => { f.disk.node('C:\\Tools').kind = 'link'; },
    f => { f.onOpen(() => ({ canceled: false, filePaths: ['C:\\Tools\\wrong.exe'] })); },
  ]) {
    const f = fixture(); change(f); await rejectsGeneric(f.api.configure());
    assert.equal(f.confirmations.length, 0); assert.equal(f.disk.writes.length, 0); assert.equal(f.disk.descriptors.size, 0);
  }
  const realDigest = fixture({ approvedFixture: false });
  await rejectsGeneric(realDigest.api.configure());
  assert.equal(realDigest.confirmations.length, 0);
});

test('compiler mutations or replacements during human confirmation cannot save', async () => {
  for (const mutate of [
    f => { const file = f.disk.node(f.compilerPath); file.bytes[0] = 0; file.mtimeNs++; },
    f => { f.disk.put(f.compilerPath, { kind: 'file', bytes: Buffer.from(syntheticCompiler) }); },
    f => { f.disk.node(f.compilerPath).nlink = 2n; },
    f => { f.disk.put('C:\\Tools'); },
    f => { f.disk.node('C:\\Tools').physical = 'C:\\Other'; },
  ]) {
    const f = fixture(); f.onConfirm(() => { mutate(f); return { response: 1 }; });
    await rejectsGeneric(f.api.configure()); assert.equal(f.disk.writes.length, 0); assert.equal(f.disk.descriptors.size, 0);
  }
});

test('evidence must exist strictly inside the physical project and have a safe bounded relative path', async () => {
  for (const selected of ['C:\\Project', 'C:\\Project-other\\evidence', 'D:\\Project\\evidence', 'C:\\Project\\missing',
    'C:\\Project\\.git', 'C:\\Project\\secrets', 'C:\\Project\\auth.json', 'C:\\Project\\folder.key',
    'C:\\Project\\CON', 'C:\\Project\\NUL.txt', 'C:\\Project\\COM1.txt', 'C:\\Project\\evidence:stream',
    'C:\\Project\\folder.', 'C:\\Project\\ evidence', 'C:\\Project\\..\\Other', 'C:\\Project\\' + 'é'.repeat(123)]) {
    const f = fixture(); if (!selected.includes('missing')) f.disk.ensure(selected);
    f.onOpen((options) => ({ canceled: false, filePaths: [options.properties.includes('openFile') ? f.compilerPath : selected] }));
    await rejectsGeneric(f.api.configure()); assert.equal(f.confirmations.length, 0); assert.equal(f.disk.writes.length, 0);
  }
  for (const mutate of [f => { f.disk.node(f.projectPath + '\\evidence').kind = 'link'; },
    f => { f.disk.node(f.projectPath).physical = 'C:\\Other'; }]) {
    const f = fixture(); mutate(f); await rejectsGeneric(f.api.configure()); assert.equal(f.disk.writes.length, 0);
  }
});

test('replacement of project, state or evidence while the confirmation is open is refused', async () => {
  for (const target of [f => f.projectPath, f => f.stateRoot, f => f.projectPath + '\\evidence']) {
    const f = fixture(); f.onConfirm(() => { f.disk.put(target(f)); return { response: 1 }; });
    await rejectsGeneric(f.api.configure()); assert.equal(f.disk.writes.length, 0);
  }
});

test('cancel at either selection or final default-cancel confirmation leaves settings and active session intact', async () => {
  for (const cancelAt of [1, 2, 3]) {
    const f = fixture({ configured: true }), session = f.session();
    f.onOpen((options, index) => index === cancelAt ? { canceled: true, filePaths: [] }
      : { canceled: false, filePaths: [options.properties.includes('openFile') ? f.compilerPath : f.projectPath + '\\evidence'] });
    if (cancelAt === 3) f.onConfirm(() => ({ response: 0 }));
    assert.deepEqual(json(await f.api.configure()), expectedStatus(f, { configured: true, evidenceDirectory: 'evidence', cancelled: true }));
    assert.equal(f.disk.writes.length, 0); assert.equal(f.session(), session); assert.equal(f.disk.descriptors.size, 0);
  }
});

test('corrupt, oversized, linked, extra-key or unsupported persisted settings are refused without resetting', async () => {
  for (const mutate of [
    f => { f.disk.node(f.configPath).bytes = Buffer.from('{bad'); },
    f => { f.disk.node(f.configPath).bytes = Buffer.alloc(4097, 0x20); },
    f => { f.disk.node(f.configPath).nlink = 2n; },
    f => { f.disk.node(f.configPath).kind = 'link'; },
    f => { f.disk.node(f.configPath).bytes = Buffer.from(JSON.stringify({ ...f.settings, flags: ['--unsafe'] }) + '\n'); },
    f => { f.disk.node(f.configPath).bytes = Buffer.from(JSON.stringify({ ...f.settings, compilerSha256: 'b'.repeat(64) }) + '\n'); },
    f => { f.disk.node(f.configPath).bytes = Buffer.from(JSON.stringify({ ...f.settings, evidenceDirectory: '.codex' }) + '\n'); },
    f => { f.disk.node(f.configPath).bytes = Buffer.from(JSON.stringify({ ...f.settings, projectId: 'b'.repeat(64) }) + '\n'); },
  ]) {
    const f = fixture({ configured: true }); mutate(f);
    await rejectsGeneric(f.api.status()); await rejectsGeneric(f.api.configure());
    throwsGeneric(() => f.api.daemonConfiguration(f.session()));
    assert.equal(f.disk.writes.length, 0); assert.equal(f.opens.length, 0); assert.equal(f.disk.descriptors.size, 0);
  }
});

test('observed settings cannot be deleted, modified or replaced; refusal remains sticky', async () => {
  for (const mutate of [
    f => { f.disk.nodes.delete(f.disk.key(f.configPath)); },
    f => { f.disk.node(f.configPath).ctimeNs++; },
    f => { f.disk.put(f.configPath, { kind: 'file', bytes: Buffer.from(JSON.stringify(f.settings) + '\n') }); },
  ]) {
    const f = fixture({ configured: true }); await f.api.status(); mutate(f);
    await rejectsGeneric(f.api.status()); await rejectsGeneric(f.api.status()); await rejectsGeneric(f.api.configure());
    assert.equal(f.disk.writes.length, 0);
  }
});

test('config appearing or changing during confirmation is refused and never overwritten', async () => {
  for (const configured of [false, true]) {
    const f = fixture({ configured }); f.onConfirm(() => {
      f.disk.put(f.configPath, { kind: 'file', bytes: Buffer.from(JSON.stringify(f.settings) + '\n') }); return { response: 1 };
    });
    await rejectsGeneric(f.api.configure()); assert.equal(f.disk.writes.length, 0);
  }
});

test('exclusive atomic replacement retains the prior file until rename; foreign lock is never removed', async () => {
  const f = fixture({ configured: true }); f.disk.ensure(f.projectPath + '\\next-evidence');
  f.onOpen(options => ({ canceled: false, filePaths: [options.properties.includes('openFile') ? f.compilerPath : f.projectPath + '\\next-evidence'] }));
  const original = Buffer.from(f.disk.node(f.configPath).bytes), rename = f.disk.filesystem.renameSync;
  f.disk.filesystem.renameSync = (from, to) => { assert.deepEqual(f.disk.node(to).bytes, original); assert.match(from, /\.tmp$/); rename(from, to); };
  const saved = await f.api.configure(); assert.equal(saved.evidenceDirectory, 'next-evidence'); assert.equal(saved.pendingRestart, true);
  assert.equal(f.disk.descriptors.size, 0);
  assert.equal([...f.disk.nodes.values()].filter(node => node.path.endsWith('.lock') || node.path.endsWith('.tmp')).length, 0);
  const locked = fixture({ configured: true }), lockPath = locked.configPath + '.lock';
  const lock = locked.disk.put(lockPath, { kind: 'file', bytes: Buffer.from('foreign') });
  await rejectsGeneric(locked.api.configure()); assert.equal(locked.disk.node(lockPath), lock); assert.equal(locked.disk.writes.length, 0);
});

test('native FS read boundary rejects non-integer, negative, nonfinite and oversized counts', async () => {
  for (const count of [-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, undefined, '1', remaining => remaining + 1]) {
    const f = fixture({ configured: true });
    f.disk.filesystem.readSync = (_fd, _bytes, _offset, remaining) => typeof count === 'function' ? count(remaining) : count;
    await rejectsGeneric(f.api.status());
    assert.equal(f.disk.writes.length, 0); assert.equal(f.disk.descriptors.size, 0);
  }
  // Valid short reads and zero at EOF must remain supported.
  const f = fixture({ configured: true }), read = f.disk.filesystem.readSync;
  f.disk.filesystem.readSync = (fd, bytes, offset, remaining, position) => read(fd, bytes, offset, Math.min(remaining, 23), position);
  assert.equal((await f.api.status()).configured, true); assert.equal(f.disk.descriptors.size, 0);
  const truncated = fixture({ configured: true }), readTruncated = truncated.disk.filesystem.readSync;
  const prefixBytes = truncated.disk.node(truncated.configPath).bytes.length;
  truncated.disk.node(truncated.configPath).bytes = Buffer.concat([truncated.disk.node(truncated.configPath).bytes, Buffer.from('trailing')]);
  truncated.disk.filesystem.readSync = (fd, bytes, offset, remaining, position) => position >= prefixBytes ? 0
    : readTruncated(fd, bytes, offset, Math.min(remaining, prefixBytes - position), position);
  await rejectsGeneric(truncated.api.status()); assert.equal(truncated.disk.descriptors.size, 0);
});

test('native FS write boundary rejects zero, non-integer, negative, nonfinite and oversized counts', async () => {
  for (const count of [0, -1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, undefined, '1', remaining => remaining + 1]) {
    const f = fixture();
    f.disk.filesystem.writeSync = (_fd, _bytes, _offset, remaining) => typeof count === 'function' ? count(remaining) : count;
    await rejectsGeneric(f.api.configure());
    assert.equal(f.disk.nodes.has(f.disk.key(f.configPath)), false);
    assert.equal(f.disk.writes.some(([operation]) => operation === 'rename'), false);
    assert.equal(f.disk.descriptors.size, 0);
  }
  const f = fixture(), write = f.disk.filesystem.writeSync;
  f.disk.filesystem.writeSync = (fd, bytes, offset, remaining) => write(fd, bytes, offset, Math.min(remaining, 23));
  assert.equal((await f.api.configure()).configured, true); assert.equal(f.disk.descriptors.size, 0);
});

test('stale project, window, origin or closing sessions stop dialogs at each await boundary', async () => {
  for (const stage of [1, 2, 3]) for (const change of [
    f => f.setSession(null), f => f.setSession({ ...f.session(), epoch: {} }),
    f => f.setSession({ ...f.session(), origin: 'http://127.0.0.1:45872' }),
    f => f.setSession({ ...f.session(), window: { ...f.window } }),
  ]) {
    const f = fixture();
    f.onOpen((options, count) => { if (count === stage) change(f);
      return { canceled: false, filePaths: [options.properties.includes('openFile') ? f.compilerPath : f.projectPath + '\\evidence'] }; });
    f.onConfirm(() => { if (stage === 3) change(f); return { response: 1 }; });
    await rejectsGeneric(f.api.configure()); assert.equal(f.disk.writes.length, 0);
    assert.equal(f.opens.length, Math.min(stage, 2)); assert.equal(f.confirmations.length, stage === 3 ? 1 : 0);
    assert.equal(f.disk.descriptors.size, 0);
  }
});

test('concurrent configuration is refused without releasing the first dialog fence; status stays usable', async () => {
  const f = fixture(); let release;
  f.onOpen((_options, count) => count === 1 ? new Promise(resolve => { release = resolve; })
    : { canceled: false, filePaths: [f.projectPath + '\\evidence'] });
  const pending = f.api.configure();
  await rejectsGeneric(f.api.configure()); await rejectsGeneric(f.api.configure());
  assert.equal((await f.api.status()).configured, false); assert.equal(f.opens.length, 1);
  release({ canceled: true, filePaths: [] }); assert.equal((await pending).cancelled, true);
  f.onOpen(() => ({ canceled: true, filePaths: [] })); assert.equal((await f.api.configure()).cancelled, true);
});

function ipcFixture(f) {
  const handlers = new Map(); f.api.installIpc({ handle: (name, handler) => handlers.set(name, handler) });
  return { handlers, event: { sender: f.window.webContents, senderFrame: f.mainFrame } };
}
test('IPC requires exact main window, main frame, canonical current origin and zero arguments', async () => {
  const f = fixture(), { handlers, event } = ipcFixture(f);
  assert.deepEqual([...handlers.keys()], ['arcane:luau-status', 'arcane:luau-configure']);
  assert.equal((await handlers.get('arcane:luau-status')(event)).configured, false);
  for (const channel of handlers.keys()) {
    await rejectsGeneric(handlers.get(channel)(event, { compilerPath: f.compilerPath }));
    await rejectsGeneric(handlers.get(channel)({ ...event, sender: {} }));
    await rejectsGeneric(handlers.get(channel)({ ...event, senderFrame: { url: f.mainFrame.url } }));
    for (const url of ['http://localhost:45871/studio', 'http://127.0.0.1:045871/studio', origin + '/studio?x=1',
      'http://user:pass@127.0.0.1:45871/studio', 'http://127.0.0.1:45872/studio', origin + '/a/../studio', origin + '/v1/product/state']) {
      f.mainFrame.url = url; await rejectsGeneric(handlers.get(channel)(event));
    }
    f.mainFrame.url = origin + '/studio';
  }
  assert.equal(f.opens.length, 0); assert.equal(f.disk.writes.length, 0);
});

test('smoke disables configuring via API and IPC while status remains safe', async () => {
  const f = fixture({ smoke: true }), { handlers, event } = ipcFixture(f);
  assert.equal((await handlers.get('arcane:luau-status')(event)).configured, false);
  await rejectsGeneric(f.api.configure()); await rejectsGeneric(handlers.get('arcane:luau-configure')(event));
  assert.equal(f.opens.length, 0); assert.equal(f.disk.writes.length, 0);
  assert.match(mainSource, /Configure Luau verification[\s\S]*?enabled: !smoke/);
});

test('smoke read-only observation distinguishes a mounted controller from disabled static HTML without native calls', () => {
  const checkSmoke = mainSource.slice(mainSource.indexOf('async function checkSmoke()'), mainSource.indexOf('if (profilePreparationFailed) app.whenReady()'));
  const probe = /executeJavaScript\(`([\s\S]*?)`\)/.exec(checkSmoke)?.[1];
  assert.ok(probe, 'Expected a read-only renderer smoke observation.');
  assert.match(checkSmoke, /desktopVerificationSetupMounted: renderer\.codeVerificationBridge === true && renderer\.desktopVerificationController === true/);
  const bridge = Object.freeze({ version: 1, status() { assert.fail('Smoke must not call status.'); },
    configure() { assert.fail('Smoke must not call configure.'); } });
  const elements = new Map([
    ['desktop-verification', { getAttribute: () => 'false' }],
    ['desktop-verification-setup', { disabled: false }], ['desktop-verification-refresh', { disabled: false }],
  ]);
  function observe(native = bridge) {
    return JSON.parse(vm.runInNewContext(probe, { window: { arcaneDesktop: { codeVerification: native } },
      document: { title: 'Fixture', documentElement: { scrollWidth: 1200 }, getElementById: id => elements.get(id), querySelectorAll: () => [] },
      innerWidth: 1200, innerHeight: 900 }));
  }
  assert.equal(observe().codeVerificationBridge, true); assert.equal(observe().desktopVerificationController, true);
  elements.get('desktop-verification-setup').disabled = true;
  assert.equal(observe().desktopVerificationController, false);
  elements.get('desktop-verification-setup').disabled = false;
  elements.get('desktop-verification-refresh').disabled = true;
  assert.equal(observe().desktopVerificationController, false);
  elements.get('desktop-verification-refresh').disabled = false;
  elements.get('desktop-verification').getAttribute = () => 'true';
  assert.equal(observe().desktopVerificationController, false);
  assert.equal(observe({ ...bridge }).codeVerificationBridge, false);
  assert.equal(observe(Object.freeze({ ...bridge, version: 2 })).codeVerificationBridge, false);
  assert.equal(observe(Object.freeze({ version: 1, status: bridge.status })).codeVerificationBridge, false);
});

test('sandboxed preload exposes a frozen v1 API; paths, flags and generic errors cannot cross', async () => {
  let exposed, unavailable = null; const calls = [];
  vm.runInNewContext(preloadSource, { require(name) {
    assert.equal(name, 'electron'); return { contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'arcaneDesktop'); exposed = value; } },
      ipcRenderer: { invoke(...args) {
        calls.push(args);
        if (unavailable === 'sync') throw new Error('C:\\secret\\compiler.exe');
        if (unavailable === 'async') return Promise.reject(new Error('C:\\secret\\compiler.exe'));
        return Promise.resolve({ version: 1 });
      } } };
  } });
  assert.equal(Object.isFrozen(exposed), true); assert.equal(Object.isFrozen(exposed.codeVerification), true);
  assert.equal(exposed.codeVerification.version, 1);
  await exposed.codeVerification.status(); await exposed.codeVerification.configure();
  assert.deepEqual(calls, [['arcane:luau-status'], ['arcane:luau-configure']]);
  for (const name of ['status', 'configure']) await rejectsGeneric(exposed.codeVerification[name]({ path: 'secret', flags: [] }));
  assert.equal(calls.length, 2);
  for (const failure of ['sync', 'async']) for (const name of ['status', 'configure']) {
    unavailable = failure;
    let pending; assert.doesNotThrow(() => { pending = exposed.codeVerification[name](); });
    await rejectsGeneric(pending);
  }
});

test('owned real files: bounded corruption fails closed without resetting', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'arcane-luau-host-test-'));
  t.after(async () => {
    const relative = path.relative(tmpdir(), root);
    assert.ok(relative.startsWith('arcane-luau-host-test-') && !relative.includes(path.sep) && !path.isAbsolute(relative));
    assert.equal((await lstat(root)).isSymbolicLink(), false); await rm(root, { recursive: true, force: true });
  });
  const projectPath = path.join(root, 'project'), projectId = hash(process.platform === 'win32' ? projectPath.toLowerCase() : projectPath);
  const stateRoot = path.join(root, 'owned', 'runtime', 'projects', projectId), compilerPath = path.join(root, 'luau-compile.exe');
  await mkdir(path.join(projectPath, 'evidence'), { recursive: true }); await mkdir(stateRoot, { recursive: true });
  // Deliberately wrong synthetic bytes; never a real compiler and never executed.
  await writeFile(compilerPath, 'synthetic fixture, cannot execute');
  const settings = { version: 1, projectId, compilerPath, compilerSha256: APPROVED, evidenceDirectory: 'evidence' };
  const configPath = path.join(stateRoot, 'luau-verification.json'); await writeFile(configPath, JSON.stringify(settings) + '\n');
  const { host } = loadHost({ filesystem: fs, paths: path, platform: process.platform });
  const window = { isDestroyed: () => false }, session = { projectId, projectPath, stateRoot, window, origin, epoch: {}, activeSettingsHash: hash(JSON.stringify(settings) + '\n') };
  const api = host.createCodeVerification({ getSession: () => session, dialog: { showOpenDialog() { assert.fail('No real dialog.'); } } });
  assert.equal((await api.status()).configured, true);
  if (process.platform === 'win32') assert.deepEqual(json(api.daemonConfiguration(session)), { environment: {}, settingsHash: null, failure: 'compiler-unavailable' });
  else throwsGeneric(() => api.daemonConfiguration(session));
  await writeFile(configPath, Buffer.alloc(4097, 0x20));
  await rejectsGeneric(api.status());
  const fresh = host.createCodeVerification({ getSession: () => session, dialog: {} });
  await rejectsGeneric(fresh.status());
  assert.equal(fs.statSync(configPath).size, 4097);
});
