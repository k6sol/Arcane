import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { browserDaemonEnvironment } from '../../scripts/start-product.mjs';
import * as managed from '../../scripts/managed-luau-compiler.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = fs.readFileSync(join(repository, 'scripts/start-product.mjs'), 'utf8');
const keys = ['ARCANE_LUAU_COMPILER_PATH', 'ARCANE_LUAU_COMPILER_SHA256', 'ARCANE_LUAU_EVIDENCE_DIRECTORY'];
const windows = { skip: process.platform !== 'win32' };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.parse(JSON.stringify(value));
const read = path => fs.readFileSync(join(repository, path));

function write(root, path, bytes) {
  const full = join(root, path);
  fs.mkdirSync(dirname(full), { recursive: true });
  fs.writeFileSync(full, bytes);
  return full;
}
function fixture(t, { packaged = false } = {}) {
  const boundary = fs.realpathSync.native(tmpdir());
  const root = fs.realpathSync.native(fs.mkdtempSync(join(boundary, 'arcane-browser-compiler-test-')));
  t.after(() => {
    const path = relative(boundary, root);
    assert.ok(path.startsWith('arcane-browser-compiler-test-') && !isAbsolute(path) && !path.includes(sep));
    assert.equal(fs.lstatSync(root).isSymbolicLink(), false);
    assert.equal(fs.realpathSync.native(root), root);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const productRoot = join(root, packaged ? 'bundle/resources/product' : 'checkout');
  for (const path of managed.REQUIRED_MANAGED_LUAU_FILES) write(productRoot, path, read(path));
  const projectPath = join(root, 'Caller project with spaces');
  fs.mkdirSync(projectPath);
  write(projectPath, 'keep.txt', 'Caller project contents must remain exact.\n');
  const configure = env => browserDaemonEnvironment({ repository: productRoot, env });
  return { root, productRoot, projectPath, configure };
}
// Record files and direct directories without following fixture redirects.
function inventory(root) {
  const entries = {};
  function inspect(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const full = join(directory, name), path = relative(root, full), stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) entries[path] = 'link:' + fs.readlinkSync(full);
      else if (stat.isDirectory()) { entries[path] = 'directory'; inspect(full); }
      else entries[path] = hash(fs.readFileSync(full));
    }
  }
  inspect(root);
  return entries;
}
function expected(f) {
  return {
    ARCANE_LUAU_COMPILER_PATH: join(f.productRoot, managed.MANAGED_LUAU_FILES[0]),
    ARCANE_LUAU_COMPILER_SHA256: managed.MANAGED_LUAU_SHA256,
    ARCANE_LUAU_EVIDENCE_DIRECTORY: managed.MANAGED_LUAU_EVIDENCE_DIRECTORY,
  };
}

test('browser default uses the real first-party bundle with fixed native, digest and provenance pins', () => {
  const verified = managed.verifyManagedLuauCompiler(repository);
  const bytes = read(managed.MANAGED_LUAU_FILES[0]);
  assert.equal(bytes.length, 1403904);
  assert.equal(bytes.toString('ascii', 0, 2), 'MZ');
  assert.equal(verified.sha256, '74cf7ed3621b8966bac6fec7f1a0caf13616655fa06d346133cd31f6aac439d8');
  assert.equal(hash(bytes), verified.sha256);
  assert.equal(verified.executablePath, join(repository, managed.MANAGED_LUAU_FILES[0]));
  const manifest = JSON.parse(read(managed.MANAGED_LUAU_FILES[2]));
  assert.equal(manifest.version, '0.742');
  assert.equal(manifest.archive.sha256, '1114966cd8198f407069f07e8b4e6bacf2ded933e4a57d6ddc75617969278c75');
  assert.equal(hash(read(managed.MANAGED_LUAU_FILES[1])), manifest.license.sha256);
});

test('absent browser configuration prepares only project-scoped evidence in checkout and direct packaged resources', windows, t => {
  const parentEnvironment = { ...process.env };
  for (const packaged of [false, true]) {
    const f = fixture(t, { packaged });
    const env = Object.freeze({ ARCANE_PROJECT: f.projectPath, ARCANE_RESOURCE_DIRECTORY: join(f.root, 'unselected resources'),
      ARCANE_STATE_DIRECTORY: join(f.root, 'unselected runtime'), PRESERVE_CALLER_VALUE: ' exact value ' });
    const before = inventory(f.root), result = f.configure(env);
    assert.deepEqual(result, { ...env, ...expected(f) });
    const after = inventory(f.root);
    for (const [path, value] of Object.entries(before)) assert.equal(after[path], value, path);
    assert.deepEqual(Object.keys(after).filter(path => !Object.hasOwn(before, path)).sort(), [
      relative(f.root, join(f.projectPath, 'arcane-evidence')),
      relative(f.root, join(f.projectPath, managed.MANAGED_LUAU_EVIDENCE_DIRECTORY)),
    ].sort());
    assert.deepEqual(f.configure(env), result);
    assert.deepEqual(inventory(f.root), after, 'Repeated preparation does not modify files or add configuration.');
  }
  assert.deepEqual({ ...process.env }, parentEnvironment);
});

test('project fallback and relative ARCANE_PROJECT resolve from the resource repository, independent of host cwd', windows, t => {
  const f = fixture(t);
  assert.deepEqual(f.configure({}), expected(f));
  assert.equal(fs.lstatSync(join(f.productRoot, managed.MANAGED_LUAU_EVIDENCE_DIRECTORY)).isDirectory(), true);
  assert.equal(fs.existsSync(join(f.projectPath, 'arcane-evidence')), false);
  const env = { ARCANE_PROJECT: relative(f.productRoot, f.projectPath), KEEP: 'caller' };
  assert.deepEqual(f.configure(env), { ...env, ...expected(f) });
  assert.equal(fs.lstatSync(join(f.projectPath, managed.MANAGED_LUAU_EVIDENCE_DIRECTORY)).isDirectory(), true);
  assert.equal(fs.realpathSync.native(f.projectPath), f.projectPath);
});

test('valid explicit custom configuration wins even with an unavailable managed bundle and remains byte-for-byte exact', t => {
  const f = fixture(t);
  const customCompiler = write(f.projectPath, 'Custom tools/luau-compile.exe', read(managed.MANAGED_LUAU_FILES[0]));
  fs.mkdirSync(join(f.projectPath, 'custom-evidence'));
  const env = Object.freeze({ ARCANE_PROJECT: f.projectPath, ARCANE_LUAU_COMPILER_PATH: customCompiler,
    ARCANE_LUAU_COMPILER_SHA256: managed.MANAGED_LUAU_SHA256, ARCANE_LUAU_EVIDENCE_DIRECTORY: 'custom-evidence', KEEP: ' exact ' });
  fs.unlinkSync(join(f.productRoot, managed.MANAGED_LUAU_FILES[0]));
  const before = inventory(f.root);
  const result = f.configure(env);
  assert.notEqual(result, env);
  assert.deepEqual(result, env);
  assert.deepEqual(inventory(f.root), before);
  assert.equal(fs.existsSync(join(f.projectPath, 'arcane-evidence')), false);
});

test('every explicit partial tuple and invalid or empty value is preserved without seeding any evidence directory', t => {
  const f = fixture(t), managedTuple = expected(f);
  for (let mask = 1; mask < 8; mask++) {
    for (const invalid of [false, true]) {
      const env = { ARCANE_PROJECT: f.projectPath, KEEP: 'exact' };
      keys.forEach((key, index) => { if (mask & (1 << index)) env[key] = invalid ? '' : managedTuple[key]; });
      const before = inventory(f.root);
      assert.deepEqual(f.configure(Object.freeze(env)), env);
      assert.deepEqual(inventory(f.root), before);
    }
  }
  for (const tuple of [
    { ...managedTuple, ARCANE_LUAU_COMPILER_PATH: join(f.root, 'missing.exe') },
    { ...managedTuple, ARCANE_LUAU_COMPILER_SHA256: ' invalid digest ' },
    { ...managedTuple, ARCANE_LUAU_EVIDENCE_DIRECTORY: '../outside' },
    { ...managedTuple, ARCANE_LUAU_EVIDENCE_DIRECTORY: 'missing-configured-evidence' },
    { ARCANE_LUAU_COMPILER_PATH: undefined },
  ]) {
    const env = { ARCANE_PROJECT: join(f.root, 'missing project'), ...tuple };
    const before = inventory(f.root);
    assert.deepEqual(f.configure(env), env);
    assert.deepEqual(inventory(f.root), before);
  }
});

test('Windows case-insensitive explicit compiler keys cannot trigger a managed fallback', windows, t => {
  const f = fixture(t);
  for (const key of keys) {
    const env = { ARCANE_PROJECT: f.projectPath, [key.toLowerCase()]: '' };
    const before = inventory(f.root);
    assert.deepEqual(f.configure(env), env);
    assert.deepEqual(inventory(f.root), before);
  }
});

test('Windows project name casing still confines evidence preparation to the selected project', windows, t => {
  const f = fixture(t), env = { arcane_project: f.projectPath };
  assert.deepEqual(f.configure(env), { ...env, ...expected(f) });
  assert.equal(fs.lstatSync(join(f.projectPath, managed.MANAGED_LUAU_EVIDENCE_DIRECTORY)).isDirectory(), true);
  assert.equal(fs.existsSync(join(f.productRoot, 'arcane-evidence')), false);
});

test('managed corruption or missing pinned files never produce a replacement compiler or repair the resource bundle', windows, t => {
  for (const mode of ['compiler', 'manifest', 'license', 'missing', 'extra']) {
    const f = fixture(t);
    if (mode === 'compiler') write(f.productRoot, managed.MANAGED_LUAU_FILES[0], 'Untrusted source text');
    if (mode === 'manifest') write(f.productRoot, managed.MANAGED_LUAU_FILES[2], '{"compiler":{"sha256":"caller pin"}}');
    if (mode === 'license') write(f.productRoot, managed.MANAGED_LUAU_FILES[1], 'Untrusted license');
    if (mode === 'missing') fs.unlinkSync(join(f.productRoot, managed.MANAGED_LUAU_FILES[0]));
    if (mode === 'extra') write(f.productRoot, managed.MANAGED_LUAU_DIRECTORY + '/alternate.exe', 'Unselected');
    const before = inventory(f.productRoot), env = { ARCANE_PROJECT: f.projectPath, KEEP: 'exact' };
    assert.deepEqual(f.configure(env), env);
    assert.deepEqual(inventory(f.productRoot), before);
    assert.equal(fs.existsSync(join(f.projectPath, 'keep.txt')), true);
  }
});

function createRedirect(t, target, path) {
  try { fs.symlinkSync(target, path, 'junction'); return true; }
  catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
    t.skip('Windows denied creation of a temporary junction fixture.');
    return false;
  }
}

test('project and evidence redirects cannot write beyond the caller project; missing projects are never created', windows, async t => {
  for (const mode of ['project', 'ancestor', 'evidence', 'nested-evidence', 'missing']) {
    await t.test(mode, t => {
      const f = fixture(t), outside = join(f.root, 'outside');
      fs.mkdirSync(outside);
      let projectPath = f.projectPath, redirect;
      if (mode === 'project') { redirect = join(f.root, 'project redirect'); projectPath = redirect; }
      if (mode === 'ancestor') {
        fs.mkdirSync(join(outside, 'nested project'));
        redirect = join(f.root, 'ancestor redirect'); projectPath = join(redirect, 'nested project');
      }
      if (mode === 'evidence') redirect = join(projectPath, 'arcane-evidence');
      if (mode === 'nested-evidence') { fs.mkdirSync(join(projectPath, 'arcane-evidence')); redirect = join(projectPath, managed.MANAGED_LUAU_EVIDENCE_DIRECTORY); }
      if (mode === 'missing') projectPath = join(f.root, 'missing project');
      if (redirect && !createRedirect(t, outside, redirect)) return;
      const before = inventory(f.root), env = { ARCANE_PROJECT: projectPath };
      assert.deepEqual(f.configure(env), env);
      assert.deepEqual(inventory(f.root), before);
      if (redirect) fs.unlinkSync(redirect);
    });
  }
});

test('redirected resource repositories and hardlinked compilers cannot supply browser defaults', windows, async t => {
  for (const mode of ['resource', 'hardlink']) {
    await t.test(mode, t => {
      const f = fixture(t);
      let productRoot = f.productRoot, alias;
      if (mode === 'resource') { alias = join(f.root, 'resource redirect'); if (!createRedirect(t, productRoot, alias)) return; productRoot = alias; }
      else {
        alias = join(f.root, 'compiler alias.exe');
        try { fs.linkSync(join(productRoot, managed.MANAGED_LUAU_FILES[0]), alias); }
        catch (error) {
          if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
          t.skip('Windows denied creation of a temporary hardlink fixture.'); return;
        }
      }
      const before = inventory(f.productRoot), env = { ARCANE_PROJECT: f.projectPath };
      assert.deepEqual(browserDaemonEnvironment({ repository: productRoot, env }), env);
      assert.deepEqual(inventory(f.productRoot), before);
      fs.unlinkSync(alias);
    });
  }
});

test('absent-state shim opens only fixed managed resource files and never reads Electron configuration or credentials', windows, t => {
  const f = fixture(t);
  const profile = join(f.root, 'Opaque Electron profile');
  write(profile, 'runtime/code-verification.json', '{corrupt opaque settings');
  write(profile, 'credentials.json', 'Opaque fixture bytes');
  const before = inventory(profile), allowed = new Set(managed.REQUIRED_MANAGED_LUAU_FILES.map(path => join(f.productRoot, path)));
  const opened = [], open = fs.openSync, readFile = fs.readFileSync;
  t.mock.method(fs, 'openSync', (path, ...args) => { assert.ok(allowed.has(path), 'Only managed resources may be opened.'); opened.push(path); return open(path, ...args); });
  t.mock.method(fs, 'readFileSync', (path, ...args) => { assert.ok(allowed.has(path), 'Only managed resources may be read.'); return readFile(path, ...args); });
  const env = { ARCANE_PROJECT: f.projectPath, ARCANE_STATE_DIRECTORY: profile, APPDATA: profile, LOCALAPPDATA: profile };
  assert.deepEqual(f.configure(env), { ...env, ...expected(f) });
  t.mock.restoreAll();
  assert.deepEqual(opened.sort(), [...allowed].sort());
  assert.deepEqual(inventory(profile), before);
});

function cleanEnvironment(extra) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.toUpperCase().startsWith('ARCANE_')) delete env[name];
  return { ...env, ...extra };
}

test('actual browser CLI forwards managed/default and exact explicit environments to the IPC child without launching a user app', windows, t => {
  const f = fixture(t, { packaged: true });
  write(f.productRoot, 'scripts/start-product.mjs', source);
  // Only readiness and the daemon are process-boundary fixtures. The launcher,
  // managed helper, native compiler bytes, hashes and filesystem checks are real.
  write(f.productRoot, 'scripts/product-doctor.mjs', 'export async function productDoctor() { return { readyToLaunch: true, checks: [] }; }\n');
  write(f.productRoot, 'dist/apps/daemon/src/product-main.js', `console.log(JSON.stringify({ browserFixture: true, cwd: process.cwd(), ipc: process.connected,
    project: process.env.ARCANE_PROJECT, preserve: process.env.BROWSER_TEST_PRESERVE,
    compiler: Object.fromEntries(${JSON.stringify(keys)}.filter(key => Object.hasOwn(process.env, key)).map(key => [key, process.env[key]])) }));\n`);
  const customPath = write(f.projectPath, 'custom tools/luau-compile.exe', read(managed.MANAGED_LUAU_FILES[0]));
  for (const tuple of [null, { ARCANE_LUAU_COMPILER_PATH: customPath, ARCANE_LUAU_COMPILER_SHA256: managed.MANAGED_LUAU_SHA256,
    ARCANE_LUAU_EVIDENCE_DIRECTORY: 'custom-evidence' }, { ARCANE_LUAU_COMPILER_PATH: '' }]) {
    const run = spawnSync(process.execPath, [join(f.productRoot, 'scripts/start-product.mjs')], {
      cwd: f.root, env: cleanEnvironment({ ARCANE_PROJECT: f.projectPath, BROWSER_TEST_PRESERVE: ' exact ', ...tuple }),
      shell: false, windowsHide: true, encoding: 'utf8', timeout: 10000, maxBuffer: 16384,
    });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.equal(run.stderr, '');
    const observed = run.stdout.split(/\r?\n/).filter(line => line.startsWith('{')).map(line => JSON.parse(line))[0];
    assert.equal(observed.browserFixture, true);
    assert.equal(observed.ipc, true);
    assert.equal(observed.cwd, f.productRoot);
    assert.equal(observed.project, f.projectPath);
    assert.equal(observed.preserve, ' exact ');
    assert.deepEqual(observed.compiler, tuple ?? expected(f));
    assert.equal(fs.existsSync(join(f.projectPath, 'custom-evidence')), false);
  }
});

function launchHarness(f, { ready = true, extraArgument = false, connected = true, sendError = false } = {}) {
  const child = new EventEmitter(), host = new EventEmitter(), spawns = [], sends = [], timers = [], cleared = [], errors = [];
  Object.assign(host, { argv: [process.execPath, join(f.productRoot, 'scripts/start-product.mjs'), ...(extraArgument ? ['--compiler'] : [])],
    execPath: process.execPath, env: { ARCANE_PROJECT: f.projectPath } });
  Object.assign(child, { exitCode: null, connected, kills: 0,
    send(message, callback) { sends.push(message); callback(sendError ? new Error('IPC fixture failure') : null); },
    kill() { child.kills++; } });
  const context = vm.createContext({ repository: f.productRoot, join, process: host,
    productDoctor: async () => ({ readyToLaunch: ready, checks: [{ id: 'fixture', status: 'fail', detail: 'Missing fixture' }] }),
    browserDaemonEnvironment: () => f.configure(host.env),
    spawn(executable, args, options) { spawns.push({ executable, args, options }); return child; },
    console: { log() {}, error(message) { errors.push(message); } },
    setTimeout(callback, delay) { const timer = { callback, delay, unreferenced: false, unref() { this.unreferenced = true; } }; timers.push(timer); return timer; },
    clearTimeout(timer) { cleared.push(timer); },
  });
  const begin = source.indexOf('async function main()'), end = source.indexOf('\nif (process.argv[1]', begin);
  assert.ok(begin >= 0 && end > begin);
  vm.runInContext(source.slice(begin, end) + '\nglobalThis.launch = main;', context);
  return { child, host, spawns, sends, timers, cleared, errors, launch: context.launch };
}

test('launcher retains private child IPC, one-shot graceful shutdown, timeout fallback and child exit/error propagation', windows, async t => {
  for (const mode of ['graceful', 'disconnected', 'send-error', 'timeout']) {
    const f = fixture(t), h = launchHarness(f, { connected: mode !== 'disconnected', sendError: mode === 'send-error' });
    await h.launch();
    assert.equal(h.spawns.length, 1);
    assert.equal(h.spawns[0].executable, process.execPath);
    assert.deepEqual(json(h.spawns[0].args), [join(f.productRoot, 'dist/apps/daemon/src/product-main.js')]);
    assert.deepEqual(json(h.spawns[0].options), { cwd: f.productRoot, env: { ARCANE_PROJECT: f.projectPath, ...expected(f) },
      shell: false, windowsHide: true, stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
    h.host.emit('SIGINT'); h.host.emit('SIGTERM');
    assert.deepEqual(JSON.parse(JSON.stringify(h.sends)), mode === 'disconnected' ? [] : [{ type: 'arcane-shutdown', protocolVersion: 1 }]);
    assert.equal(h.timers.length, 1);
    assert.equal(h.timers[0].delay, 15000);
    assert.equal(h.timers[0].unreferenced, true);
    assert.equal(h.child.kills, mode === 'disconnected' || mode === 'send-error' ? 1 : 0);
    if (mode === 'timeout') { h.timers[0].callback(); assert.equal(h.child.kills, 1); }
    h.child.exitCode = 0; h.child.emit('close', 0);
    assert.equal(h.host.exitCode, 0);
    assert.deepEqual(h.cleared, [h.timers[0]]);
    h.timers[0].callback();
    assert.equal(h.child.kills, mode === 'graceful' ? 0 : 1);
  }
  const h = launchHarness(fixture(t)); await h.launch();
  h.child.emit('error', new Error('private fixture detail'));
  assert.equal(h.host.exitCode, 1);
  assert.equal(h.errors.length, 1);
  assert.doesNotMatch(h.errors[0], /private fixture detail/);
  h.child.emit('close', null); assert.equal(h.host.exitCode, 1);
  const exited = launchHarness(fixture(t)); await exited.launch();
  exited.child.exitCode = 7; exited.child.emit('close', 7); assert.equal(exited.host.exitCode, 7);
  exited.host.emit('SIGTERM'); assert.equal(exited.timers.length, 0);
});

test('failed readiness and extra CLI arguments never prepare compiler directories or spawn a child', async t => {
  for (const extraArgument of [false, true]) {
    const f = fixture(t), before = inventory(f.root), h = launchHarness(f, { ready: false, extraArgument });
    if (extraArgument) await assert.rejects(h.launch(), /Usage: node scripts\/start-product.mjs/);
    else { await h.launch(); assert.equal(h.host.exitCode, 1); assert.deepEqual(h.errors, ['fixture: Missing fixture']); }
    assert.deepEqual(h.spawns, []);
    assert.deepEqual(inventory(f.root), before);
  }
});

test('non-Windows absent configuration remains absent without preparing evidence or selecting another compiler', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t), env = { ARCANE_PROJECT: f.projectPath, KEEP: 'exact' }, before = inventory(f.root);
  assert.deepEqual(f.configure(env), env);
  assert.deepEqual(inventory(f.root), before);
});
