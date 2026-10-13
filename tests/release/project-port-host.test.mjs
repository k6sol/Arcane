// Native startup boundary + owned loopback/real-store proof. No Electron or Studio.
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const test = (name, options, fn) => typeof options === 'function' ? nodeTest(name, { timeout: 10000 }, options) : nodeTest(name, options, fn);

const require = createRequire(import.meta.url);
const policy = require('../../apps/desktop/electron/policy.cjs');
const source = name => fs.readFileSync(new URL('../../' + name, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const main = source('apps/desktop/electron/main.cjs');
const start = main.slice(main.indexOf('async function startDaemon('), main.indexOf('function makeWindow()'));
const stop = main.slice(main.indexOf('async function stopDaemon()'), main.indexOf('async function startDaemon('));
const hash = value => createHash('sha256').update(value).digest('hex');
const id = project => hash(process.platform === 'win32' ? project.toLowerCase() : project);
const envelope = port => ({ type: 'arcane-ready', protocolVersion: 1, origin: 'http://127.0.0.1:' + port, token: 'a'.repeat(64) });
const record = port => JSON.stringify({ protocolVersion: 1, port }) + '\n';
const fixtureBase = fileURLToPath(new URL('../../', import.meta.url));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fixtureBase, 'arcane-project-port-'));
  const cleanup = [];
  const project = path.join(root, 'project'), userRoot = path.join(root, 'profile'), productRoot = path.join(root, 'product');
  for (const full of [project, userRoot, path.join(productRoot, 'dist/apps/daemon/src')]) fs.mkdirSync(full, { recursive: true });
  fs.writeFileSync(path.join(productRoot, 'dist/apps/daemon/src/product-main.js'), '// Owned fixture entry.\n');
  const stateRoot = path.join(userRoot, 'runtime/projects', id(project)); fs.mkdirSync(stateRoot, { recursive: true });
  const portFile = path.join(stateRoot, 'listener-port.json');
  t.after(async () => {
    for (const close of cleanup.reverse()) await close();
    const rel = path.relative(path.resolve(fixtureBase), path.resolve(root));
    assert.ok(rel.startsWith('arcane-project-port-') && !rel.includes(path.sep) && !path.isAbsolute(rel));
    assert.equal(fs.lstatSync(root).isSymbolicLink(), false);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, project, userRoot, productRoot, stateRoot, portFile, cleanup };
}

function host(f, { filesystem = fs, action, real = false } = {}) {
  const calls = [], timers = new Map(); let timerId = 0;
  const context = {
    child: null, origin: '', token: '', projectSession: null, projectPath: '', closing: false, switching: false,
    ...f, nodeExecutable: process.execPath, process: { platform: process.platform, env: { ARCANE_PORT: '9', ARCANE_DAEMON_URL: 'https://invalid.example', NODE_OPTIONS: 'untrusted' } },
    fs: filesystem, Buffer, URL, join: path.join, resolve: path.resolve, createHash, policy,
    performance: { now: () => 0 }, started: 0, daemonReadyMs: 0, CODE_VERIFICATION_WARNING: 'Fixture warning.', console,
    providerSetup: { cancelPending() {} },
    codeVerification: { daemonConfiguration: () => ({ environment: {}, settingsHash: null, failure: null }) },
    ownedDirectory: async full => { await policy.directPath(full, 'directory', true); fs.mkdirSync(full, { recursive: true }); return policy.directPath(full); },
    setTimeout: real ? (fn, ms) => setTimeout(fn, Math.min(ms, 5000)) : fn => { timers.set(++timerId, fn); return timerId; },
    clearTimeout: real ? clearTimeout : timer => timers.delete(timer),
    failStartup() { assert.fail('No unexpected post-adoption child exit.'); },
    spawn(executable, args, options) {
      calls.push({ executable, args, options });
      if (real) return spawn(executable, args, options);
      const owned = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill() { assert.fail('No process kill or fallback.'); } });
      queueMicrotask(() => action ? action(owned, options, context) : owned.emit('message', envelope(Number(options.env.ARCANE_PORT) || 45071)));
      return owned;
    },
  };
  vm.createContext(context); vm.runInContext(start + '\n' + stop + '\nglobalThis.start = startDaemon; globalThis.stop = stopDaemon;', context);
  return { context, calls, timers, start: project => context.start(project ?? f.project), stop: () => context.stop() };
}

test('first ACK persists the existing v1 tuple; restart reuses exact port, state and project hash', async t => {
  const f = fixture(t), first = host(f); await first.start();
  assert.equal(first.calls[0].options.env.ARCANE_PORT, '0');
  assert.equal(fs.readFileSync(f.portFile, 'utf8'), record(45071));
  const before = fs.statSync(f.portFile, { bigint: true }), second = host(f); await second.start();
  assert.equal(second.calls[0].options.env.ARCANE_PORT, '45071');
  assert.equal(second.calls[0].options.env.ARCANE_STATE_DIRECTORY, f.stateRoot);
  assert.equal(second.context.projectSession.projectId, id(f.project));
  assert.equal(fs.statSync(f.portFile, { bigint: true }).ino, before.ino);
  assert.equal(fs.statSync(f.portFile, { bigint: true }).mtimeNs, before.mtimeNs);
  assert.equal(second.calls.length, 1); assert.equal(second.calls[0].options.env.NODE_OPTIONS, undefined);
});

test('a changed canonical project path selects its own state and has no remembered port', async t => {
  const f = fixture(t); fs.writeFileSync(f.portFile, record(45071));
  const other = path.join(f.root, 'other'); fs.mkdirSync(other); const h = host(f); await h.start(other);
  assert.equal(h.calls[0].options.env.ARCANE_PORT, '0');
  assert.equal(h.context.projectSession.projectId, id(other));
  assert.notEqual(h.context.projectSession.stateRoot, f.stateRoot);
  assert.equal(fs.readFileSync(f.portFile, 'utf8'), record(45071));
});

test('numeric metadata is strict, bounded and never causes a spawn on rejection', async t => {
  const f = fixture(t);
  for (const bytes of ['null', '[]', '{}', '{broken', ' '.repeat(1025), ...[0, -1, 65536, 1.5, '45071', null].map(port => JSON.stringify({ protocolVersion: 1, port })),
    JSON.stringify({ protocolVersion: 2, port: 45071 }), JSON.stringify({ protocolVersion: 1, port: 45071, origin: 'http://127.0.0.1:9' }),
    '{"protocolVersion":1,"port":45071,"__proto__":{}}']) {
    fs.writeFileSync(f.portFile, bytes); const h = host(f); await assert.rejects(h.start());
    assert.equal(h.calls.length, 0); assert.equal(fs.readFileSync(f.portFile, 'utf8'), bytes);
  }
  for (const port of [1, 80, 65535]) { fs.writeFileSync(f.portFile, record(port)); const h = host(f); await h.start(); assert.equal(h.calls[0].options.env.ARCANE_PORT, String(port)); }
});

test('oversized metadata is rejected before allocating a file-sized read', async t => {
  const f = fixture(t); fs.writeFileSync(f.portFile, Buffer.alloc(1025)); let reads = 0;
  const h = host(f, { filesystem: { ...fs, readSync(...args) { reads++; return fs.readSync(...args); } } });
  await assert.rejects(h.start()); assert.equal(reads, 0); assert.equal(h.calls.length, 0);
});

test('direct regular path policy rejects directory records, hardlinks and physical aliases', async t => {
  const f = fixture(t); fs.mkdirSync(f.portFile); await assert.rejects(host(f).start()); fs.rmdirSync(f.portFile);
  fs.writeFileSync(f.portFile, record(45071));
  // Stat double exercises the hardlink guard without requesting Windows link privileges.
  await assert.rejects(host(f, { filesystem: { ...fs, lstatSync(full, options) {
    const stat = fs.lstatSync(full, options);
    return full === f.portFile ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { nlink: 2n }) : stat;
  } } }).start());
  for (const target of [f.portFile, f.stateRoot, f.project]) {
    const h = host(f, { filesystem: { ...fs, realpathSync(full) { return full === target ? path.join(f.root, 'redirected') : fs.realpathSync(full); } } });
    await assert.rejects(h.start()); assert.equal(h.calls.length, 0);
  }
});

test('record replacement, disappearance and parent identity change during ACK wait fail before adoption', async t => {
  const f = fixture(t);
  for (const change of ['replace', 'delete', 'parent']) {
    fs.writeFileSync(f.portFile, record(45071)); let changed = false;
    const h = host(f, { filesystem: { ...fs, lstatSync(full, options) {
      const stat = fs.lstatSync(full, options);
      if (changed && change === 'parent' && full === f.stateRoot) return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { ino: stat.ino + 1n });
      return stat;
    } }, action(owned) {
      if (change === 'replace') { fs.renameSync(f.portFile, f.portFile + '.old'); fs.writeFileSync(f.portFile, record(45071)); }
      if (change === 'delete') fs.unlinkSync(f.portFile);
      changed = true; owned.emit('message', envelope(45071));
    } });
    await assert.rejects(h.start()); assert.equal(h.context.origin, ''); assert.equal(h.context.token, ''); assert.equal(h.context.projectSession, null);
  }
});

test('a competing first record is retained; no overwrite, alternate listener or adopted credential', async t => {
  const f = fixture(t), h = host(f, { action(owned) { fs.writeFileSync(f.portFile, record(45072)); owned.emit('message', envelope(45071)); } });
  await assert.rejects(h.start()); assert.equal(fs.readFileSync(f.portFile, 'utf8'), record(45072)); assert.equal(h.context.origin, ''); assert.equal(h.calls.length, 1);
});

test('exclusive creation catches a record inserted after the final absence check', async t => {
  const f = fixture(t), h = host(f, { filesystem: { ...fs, openSync(full, flags, mode) {
    if (full === f.portFile && flags === 'wx+') fs.writeFileSync(full, record(45072));
    return fs.openSync(full, flags, mode);
  } } });
  await assert.rejects(h.start(), { code: 'EEXIST' }); assert.equal(fs.readFileSync(f.portFile, 'utf8'), record(45072)); assert.equal(h.context.token, '');
});

test('mismatched ACK rejects immediately without adopting origin/token or changing saved metadata', async t => {
  const f = fixture(t); fs.writeFileSync(f.portFile, record(45071));
  const h = host(f, { action: owned => owned.emit('message', envelope(45072)) });
  await assert.rejects(h.start(), { code: 'ARCANE_PROJECT_PORT' });
  assert.equal(h.context.origin, ''); assert.equal(h.context.token, ''); assert.equal(h.context.projectSession, null); assert.equal(h.timers.size, 0);
  assert.equal(fs.readFileSync(f.portFile, 'utf8'), record(45071));
});

test('malformed ACK cannot write a record; timeout has no retry or process kill', async t => {
  const f = fixture(t), h = host(f, { action(owned) { owned.emit('message', envelope(0)); owned.emit('message', { ...envelope(45071), extra: true }); queueMicrotask(() => [...h.timers.values()][0]()); } });
  await assert.rejects(h.start(), /timed out/); assert.equal(fs.existsSync(f.portFile), false); assert.equal(h.context.origin, ''); assert.equal(h.calls.length, 1);
});

test('owned child failure preserves saved port and emits conditional recovery guidance', async t => {
  const f = fixture(t); fs.writeFileSync(f.portFile, record(45071));
  const h = host(f, { action(owned) { owned.exitCode = 1; owned.emit('exit', 1); } });
  await assert.rejects(h.start(), /Check for another app using the local port/);
  assert.equal(fs.readFileSync(f.portFile, 'utf8'), record(45071)); assert.equal(h.context.origin, ''); assert.equal(h.calls.length, 1);
});

test('fresh and legacy state without a port record request 0 and do not inspect credentials or infer migration', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.stateRoot, 'legacy-key-metadata.json'), '{"hash":"fixture-no-authoritative-port"}');
  const opened = [], h = host(f, { filesystem: { ...fs, openSync(full, ...args) { opened.push(full); assert.equal(full, f.portFile); return fs.openSync(full, ...args); } } });
  await h.start(); assert.equal(h.calls[0].options.env.ARCANE_PORT, '0'); assert.equal(fs.readFileSync(f.portFile, 'utf8'), record(45071));
  assert.ok(opened.length > 0); assert.equal(fs.readFileSync(path.join(f.stateRoot, 'legacy-key-metadata.json'), 'utf8'), '{"hash":"fixture-no-authoritative-port"}');
  const storeSource = source('packages/storage/src/studio-store.ts');
  const issuance = storeSource.slice(storeSource.indexOf('  issueKey('), storeSource.indexOf('  revokeKey('));
  assert.match(issuance, /hash\(apiKey\)/); assert.doesNotMatch(issuance, /issuedPort|port\s*[:,]\s*port/);
});

test('owned Node loopback restart: exact persisted endpoint and original real-store key authenticate after busy failure', { timeout: 20000 }, async t => {
  const f = fixture(t);
  // Compile only the four current store dependencies into this owned fixture,
  // using Node's type erasure. Never import stale dist or execute product services.
  for (const name of ['packages/storage/src/studio-store.ts', 'packages/protocol/src/providers.ts', 'packages/protocol/src/studio.ts', 'packages/core/src/studio-policy.ts']) {
    const full = path.join(f.productRoot, name.replace(/\.ts$/, '.js')); fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, stripTypeScriptTypes(source(name), { mode: 'transform' }));
  }
  fs.writeFileSync(path.join(f.productRoot, 'package.json'), '{"type":"module"}\n');
  fs.writeFileSync(path.join(f.productRoot, 'dist/apps/daemon/src/product-main.js'), `
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { StudioStore } from '../../../../packages/storage/src/studio-store.js';
const store = new StudioStore({ directory: process.env.ARCANE_STATE_DIRECTORY });
const server = createServer((_req,res) => res.end('owned fixture'));
server.once('error',()=>{store.close();process.exit(1)});
server.listen(Number(process.env.ARCANE_PORT),'127.0.0.1',()=>process.send({type:'arcane-ready',protocolVersion:1,origin:'http://127.0.0.1:'+server.address().port,token:randomBytes(32).toString('hex')}));
const close=()=>{server.closeAllConnections();server.close(()=>{store.close();process.exit(0)})};
process.on('message',message=>{
  if(message.type==='arcane-shutdown'&&message.protocolVersion===1)return close();
  if(message.type!=='fixture-store')return;
  try {
    const port=server.address().port;
    if(message.routedPort!==port)throw Error('Wrong endpoint');
    const result=message.action==='issue' ? store.issueKey({allowedRoots:['Workspace'],allowWrites:false},port) : store.connectWithKey(message.input,port);
    if(message.action!=='issue')store.authenticate(result.sessionId,result.token);
    process.send({type:'fixture-store-result',id:message.id,ok:true,result});
  } catch {process.send({type:'fixture-store-result',id:message.id,ok:false})}
});
process.once('disconnect',close);
`);
  const owned = []; f.cleanup.push(async () => { for (const h of owned) if (h.context.child) { h.context.closing = true; await h.stop(); } });
  let requestId = 0;
  const exchange = (h, action, routedPort, input) => new Promise((resolve, reject) => {
    const id = ++requestId, child = h.context.child;
    const timeout = setTimeout(() => { child.off('message', receive); reject(new Error('Owned fixture exchange timed out.')); }, 3000);
    function receive(message) { if (message.type !== 'fixture-store-result' || message.id !== id) return; clearTimeout(timeout); child.off('message', receive); resolve(message); }
    child.on('message', receive); child.send({ type: 'fixture-store', id, action, routedPort, input });
  });
  const first = host(f, { real: true }); owned.push(first); await first.start();
  const firstOrigin = first.context.origin, port = Number(firstOrigin.split(':').at(-1));
  const issued = (await exchange(first, 'issue', port)).result;
  assert.equal(issued.apiKey.split('_')[3], String(port)); assert.notEqual(port, 0);
  const input = { apiKey: issued.apiKey, protocolVersion: 1, identity: { clientSessionId: 'owned-loopback-fixture', placeId: 0, universeId: 0, name: 'Store authentication fixture; no Studio', pluginVersion: 'fixture' }, capabilities: ['selection.read'] };
  assert.equal((await exchange(first, 'authenticate', port, input)).ok, true);
  assert.equal(await first.stop(), true); const before = fs.readFileSync(f.portFile);
  const busy = createServer((_req, res) => res.end('owned unrelated listener'));
  await new Promise((resolve, reject) => { busy.once('error', reject); busy.listen(port, '127.0.0.1', resolve); });
  f.cleanup.push(() => { busy.closeAllConnections(); busy.close(); });
  const blocked = host(f, { real: true }); owned.push(blocked); await assert.rejects(blocked.start());
  assert.equal(blocked.context.origin, ''); assert.equal(blocked.calls.length, 1); assert.deepEqual(fs.readFileSync(f.portFile), before);
  assert.equal(busy.listening, true); assert.equal(busy.address().port, port);
  blocked.context.child = null; busy.closeAllConnections(); await new Promise(resolve => busy.close(resolve));
  const restarted = host(f, { real: true }); owned.push(restarted); await restarted.start();
  assert.equal(restarted.context.origin, firstOrigin); assert.equal(restarted.calls[0].options.env.ARCANE_PORT, String(port));
  const routedOrigin = 'http://127.0.0.1:' + issued.apiKey.split('_')[3];
  assert.equal(routedOrigin, restarted.context.origin);
  assert.equal((await exchange(restarted, 'authenticate', Number(routedOrigin.split(':').at(-1)), input)).ok, true);
  assert.equal((await exchange(restarted, 'authenticate', port, { ...input, apiKey: issued.apiKey.slice(0, -1) + (issued.apiKey.endsWith('0') ? '1' : '0') })).ok, false);
  assert.equal(await restarted.stop(), true); assert.deepEqual(fs.readFileSync(f.portFile), before);
});
