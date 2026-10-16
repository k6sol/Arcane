import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import { inspect } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';

// Preparation helper only: real temporary files, no Electron, spawn, native CLI, provider, credential store or Studio.
const require = createRequire(import.meta.url);
const modulePath = new URL('../../apps/desktop/electron/native-handoff.cjs', import.meta.url);
const { createNativeHandoff, NativeHandoffPreparationError } = require(modulePath.pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const unhandled = []; process.on('unhandledRejection', error => { unhandled.push(error); });
const code = name => error => error instanceof NativeHandoffPreparationError && error.code === name;
const credential = () => randomBytes(32).toString('base64url');

async function fixture(t) {
  const base = await fsp.realpath(tmpdir()), root = await fsp.realpath(await fsp.mkdtemp(join(base, 'arcane-native-handoff-')));
  const project = join(root, 'project'), runtime = join(root, 'runtime'), bin = join(root, 'bin');
  for (const dir of [project, runtime, bin]) await fsp.mkdir(dir);
  const nodePath = join(bin, 'node.exe'), mcpEntry = join(bin, 'main.js');
  await fsp.writeFile(nodePath, 'not executed'); await fsp.writeFile(mcpEntry, 'not executed');
  t.after(async () => { const part = relative(base, root); assert.ok(part.startsWith('arcane-native-handoff-') && !isAbsolute(part) && !part.includes(sep)); await fsp.rm(root, { recursive: true, force: true }); });
  const options = (overrides = {}) => ({ projectPath: project, runtimeDirectory: runtime, nodePath, mcpEntry, daemonUrl: 'http://127.0.0.1:45871',
    credential: credential(), model: 'opus', effort: 'high', assertCurrent: () => {}, ...overrides });
  return { root, project, runtime, nodePath, mcpEntry, options, entries: () => fsp.readdir(runtime) };
}
const tokenFree = (value, token) => { for (const text of [JSON.stringify(value) ?? '', inspect(value, { depth: 8 }), String(value)]) assert.ok(!text.includes(token), 'token leaked'); };

test('exact Arcane-only config, argv and fixed env overlay; the credential exists only in the non-enumerable env', async t => {
  const f = await fixture(t), host = createNativeHandoff(), input = f.options(), receipt = await host.prepare(input);
  assert.deepEqual(Object.keys(receipt).sort(), ['argv', 'configPath', 'configSha256', 'handoffDirectory']); assert.ok(Object.isFrozen(receipt));
  assert.match(relative(f.runtime, receipt.handoffDirectory), /^claude-handoff-[0-9a-f-]{36}$/); assert.equal(receipt.configPath, join(receipt.handoffDirectory, 'arcane.mcp.json'));
  assert.deepEqual([...receipt.argv], ['--mcp-config', receipt.configPath, '--strict-mcp-config', '--model', 'opus', '--effort', 'high', '--permission-mode', 'default']);
  assert.ok(Object.isFrozen(receipt.argv));
  const descriptor = Object.getOwnPropertyDescriptor(receipt, 'env');
  assert.deepEqual([descriptor.enumerable, descriptor.writable, descriptor.configurable, typeof descriptor.get], [false, false, false, 'undefined'], 'plain non-enumerable data');
  assert.deepEqual({ ...receipt.env }, { ARCANE_DAEMON_URL: 'http://127.0.0.1:45871', ARCANE_LOCAL_TOKEN: input.credential }, 'only the fixed overlay, no host environment copy');
  const text = await fsp.readFile(receipt.configPath, 'utf8');
  assert.deepEqual(JSON.parse(text), { mcpServers: { arcane: { type: 'stdio', command: f.nodePath, args: [f.mcpEntry, '--project', f.project],
    env: { ARCANE_DAEMON_URL: '${ARCANE_DAEMON_URL}', ARCANE_LOCAL_TOKEN: '${ARCANE_LOCAL_TOKEN}' } } } });
  for (const value of [receipt, receipt.argv, text, receipt.argv.join(' ')]) tokenFree(value, input.credential);
  assert.deepEqual(await fsp.readdir(receipt.handoffDirectory), ['arcane.mcp.json']);
  assert.deepEqual(await host.cleanup(receipt), { state: 'removed', reason: null }); assert.deepEqual(await f.entries(), []);
});

test('each launch gets a unique scoped file; cleanup is exact, once, and forged receipts are refused', async t => {
  const f = await fixture(t), host = createNativeHandoff(), a = await host.prepare(f.options()), b = await host.prepare(f.options());
  assert.notEqual(a.handoffDirectory, b.handoffDirectory); assert.equal((await f.entries()).length, 2);
  for (const forged of [{ ...a }, JSON.parse(JSON.stringify(a)), null, 'receipt']) await assert.rejects(host.cleanup(forged), code('RECEIPT'));
  await assert.rejects(createNativeHandoff().cleanup(a), code('RECEIPT'), 'a receipt only works in its issuing host');
  assert.equal((await host.cleanup(a)).state, 'removed');
  assert.deepEqual(await host.cleanup(a), { state: 'unavailable', reason: 'already_cleaned' });
  assert.deepEqual(await f.entries(), [relative(f.runtime, b.handoffDirectory)]); assert.equal((await host.cleanup(b)).state, 'removed');
});

test('explicit selection, loopback daemon and a handoff credential are required; refusals write nothing', async t => {
  const f = await fixture(t), host = createNativeHandoff();
  for (const [overrides, name] of [
    [{ model: '' }, 'SELECTION'], [{ model: 'opus 4' }, 'SELECTION'], [{ model: '../opus' }, 'SELECTION'], [{ model: 'a'.repeat(65) }, 'SELECTION'],
    [{ effort: 'ultra' }, 'SELECTION'], [{ effort: 'none' }, 'SELECTION'], [{ effort: 'minimal' }, 'SELECTION'], [{ effort: 'High' }, 'SELECTION'], [{ effort: null }, 'SELECTION'],
    [{ credential: 'a'.repeat(64) }, 'CREDENTIAL'], [{ credential: credential().slice(1) }, 'CREDENTIAL'], [{ credential: '' }, 'CREDENTIAL'], [{ credential: undefined }, 'CREDENTIAL'],
    [{ daemonUrl: 'http://localhost:45871' }, 'DAEMON_URL'], [{ daemonUrl: 'https://127.0.0.1:45871' }, 'DAEMON_URL'], [{ daemonUrl: 'http://[::1]:45871' }, 'DAEMON_URL'],
    [{ daemonUrl: 'http://127.0.0.1:45871/v1' }, 'DAEMON_URL'], [{ daemonUrl: 'http://127.0.0.1:0' }, 'DAEMON_URL'], [{ daemonUrl: 'http://127.0.0.1:65536' }, 'DAEMON_URL'],
  ]) {
    const input = f.options(overrides);
    await assert.rejects(host.prepare(input), code(name), JSON.stringify(Object.keys(overrides)) + ' ' + String(Object.values(overrides)[0]).slice(0, 16));
  }
  assert.deepEqual(await f.entries(), [], 'no config was written for any refusal');
});

test('owner fencing: nonvoid, thrown, rejected (cross-realm) and thenable owner results refuse; a change at every await retains no owned material', async t => {
  const f = await fixture(t), host = createNativeHandoff(); let thenCalls = 0;
  for (const result of [() => true, () => { throw new Error('retired'); }, () => Promise.reject(new Error('async owner')),
    () => runInNewContext('Promise.reject(new Error("cross-realm owner"))'), () => ({ then() { thenCalls++; } })])
    await assert.rejects(host.prepare(f.options({ assertCurrent: result })), code('OWNER'));
  let succeededAt = 0;
  for (let failAt = 1; failAt <= 20 && !succeededAt; failAt++) {
    let calls = 0;
    try { const receipt = await host.prepare(f.options({ assertCurrent: () => { if (++calls === failAt) throw new Error('owner changed'); } })); succeededAt = failAt; await host.cleanup(receipt); }
    catch (error) { assert.ok(code('OWNER')(error), 'fence at owner check ' + failAt); }
    assert.deepEqual(await f.entries(), [], 'owned material removed after a fence at check ' + failAt);
  }
  t.diagnostic('owner checks before a completed preparation: ' + (succeededAt - 1));
  assert.ok(succeededAt >= 8, 'the owner is checked before and after every await');
  await delay(20); assert.equal(thenCalls, 0); assert.deepEqual(unhandled, []);
});

test('forged, redirected, linked and non-canonical paths and proxy/accessor envelopes are refused without traps', async t => {
  const f = await fixture(t), host = createNativeHandoff();
  const junction = join(f.root, 'junction'); await fsp.symlink(f.runtime, junction, 'junction');
  const hardlink = join(f.root, 'bin', 'linked.js'); await fsp.link(f.mcpEntry, hardlink);
  for (const overrides of [{ runtimeDirectory: 'runtime' }, { runtimeDirectory: f.runtime + sep }, { runtimeDirectory: junction }, { runtimeDirectory: join(f.root, 'missing') },
    { projectPath: f.nodePath }, { nodePath: f.runtime }, { mcpEntry: hardlink }, { mcpEntry: f.mcpEntry + '‮' }, { nodePath: 'node' }])
    await assert.rejects(host.prepare(f.options(overrides)), code('PATH'), JSON.stringify(overrides).slice(0, 60));
  let traps = 0, getters = 0; const valid = f.options();
  const proxy = new Proxy(valid, { get() { traps++; }, ownKeys() { traps++; return Reflect.ownKeys(valid); }, getOwnPropertyDescriptor() { traps++; } });
  const accessor = Object.defineProperty({ ...valid }, 'credential', { get() { getters++; return valid.credential; }, enumerable: true });
  class Options { constructor() { Object.assign(this, valid); } }
  for (const input of [proxy, accessor, new Options(), { ...valid, extra: 1 }, { ...valid, [Symbol('x')]: 1 }, (({ effort, ...rest }) => rest)(valid), null, 'options',
    { ...valid, assertCurrent: new Proxy(() => {}, {}) }, { ...valid, assertCurrent: 1 }])
    await assert.rejects(host.prepare(input), code('INPUT'));
  assert.equal(traps, 0); assert.equal(getters, 0);
  assert.throws(() => createNativeHandoff({ spawn: () => {} }), code('INPUT'), 'no process seam exists');
  assert.deepEqual(await f.entries(), []);
});

test('cleanup retains changed, replaced or extra owned-directory content and reports unavailable', async t => {
  const f = await fixture(t), host = createNativeHandoff();
  const changed = await host.prepare(f.options()); await fsp.appendFile(changed.configPath, ' ');
  assert.deepEqual(await host.cleanup(changed), { state: 'unavailable', reason: 'owned_material_changed' }); assert.ok((await fsp.stat(changed.configPath)).isFile());
  const extra = await host.prepare(f.options()); await fsp.writeFile(join(extra.handoffDirectory, 'user-notes.txt'), 'keep');
  assert.equal((await host.cleanup(extra)).reason, 'owned_material_changed'); assert.deepEqual((await fsp.readdir(extra.handoffDirectory)).sort(), ['arcane.mcp.json', 'user-notes.txt']);
  const replaced = await host.prepare(f.options()), same = await fsp.readFile(replaced.configPath, 'utf8');
  // Keep the old inode allocated: unlink/recreate may immediately reuse it on Linux.
  const originalFile = join(f.root, 'retained-original-config.json');
  await fsp.rename(replaced.configPath, originalFile); await fsp.writeFile(replaced.configPath, same);
  const originalIdentity=await fsp.stat(originalFile),replacementIdentity=await fsp.stat(replaced.configPath);
  assert.notDeepEqual([replacementIdentity.dev,replacementIdentity.ino],[originalIdentity.dev,originalIdentity.ino],'the replacement fixture has a distinct file identity');
  assert.equal((await host.cleanup(replaced)).reason, 'owned_material_changed', 'identical content in a different file is not owned'); assert.equal(await fsp.readFile(replaced.configPath, 'utf8'), same);
  const linked = await host.prepare(f.options()); await fsp.link(linked.configPath, join(f.root, 'outside-link.json'));
  assert.equal((await host.cleanup(linked)).reason, 'owned_material_changed', 'a hardlinked owned file is retained');
  const moved = await host.prepare(f.options()), originalDirectory=join(f.root,'retained-original-directory');
  await fsp.rename(moved.handoffDirectory,originalDirectory); await fsp.mkdir(moved.handoffDirectory);
  const oldDirectoryIdentity=await fsp.stat(originalDirectory),newDirectoryIdentity=await fsp.stat(moved.handoffDirectory);
  assert.notDeepEqual([newDirectoryIdentity.dev,newDirectoryIdentity.ino],[oldDirectoryIdentity.dev,oldDirectoryIdentity.ino],'the replacement fixture has a distinct directory identity');
  assert.equal((await host.cleanup(moved)).reason, 'owned_material_changed', 'a replaced directory is not owned'); assert.ok((await fsp.stat(moved.handoffDirectory)).isDirectory());
  assert.equal((await host.cleanup(changed)).state, 'unavailable', 'a refused cleanup is not marked complete');
});

test('the helper performs only bounded owned filesystem operations and has no process or native lifecycle seam', async t => {
  const f = await fixture(t), calls = [];
  const fs = Object.fromEntries(['realpath', 'lstat', 'mkdir', 'open', 'readdir', 'readFile', 'unlink', 'rmdir'].map(name => [name, (...args) => { calls.push(name); return fsp[name](...args); }]));
  const host = createNativeHandoff({ fs }), receipt = await host.prepare(f.options()); await host.cleanup(receipt);
  assert.deepEqual([...new Set(calls)].sort(), ['lstat', 'mkdir', 'open', 'readFile', 'readdir', 'realpath', 'rmdir', 'unlink']);
  const source = readFileSync(modulePath, 'utf8');
  for (const forbidden of ['child_process', 'spawn(', 'execFile', 'execSync', 'shell:', 'EncodedCommand', 'process.env', 'keytar', 'safeStorage', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', '.claude'])
    assert.ok(!source.includes(forbidden), 'no ' + forbidden);
});

const alnumCredential = () => { for (;;) { const value = credential(); if (/^[A-Za-z0-9]/.test(value)) return value; } };
const recordingFs = (calls, hooks = {}) => Object.fromEntries(['realpath', 'lstat', 'mkdir', 'open', 'readdir', 'readFile', 'unlink', 'rmdir'].map(name =>
  [name, async (...args) => { calls.push(name); if (hooks[name]) await hooks[name](...args); return fsp[name](...args); }]));
const tree = async root => { const out = []; for (const entry of await fsp.readdir(root, { recursive: true })) out.push(entry); return out.sort(); };

test('the credential can never enter argv, JSON, config or errors through a valid model or path; refusal precedes any I/O', async t => {
  const f = await fixture(t), calls = [], host = createNativeHandoff({ fs: recordingFs(calls) }), token = alnumCredential();
  const tokenRuntime = join(f.root, 'rt' + token); await fsp.mkdir(tokenRuntime);
  for (const overrides of [{ model: token }, { model: token.slice(0, 20) + token.slice(20) }, { runtimeDirectory: tokenRuntime }, { projectPath: join(f.root, token) },
    { nodePath: join(f.root, 'bin', token + '.exe') }, { mcpEntry: join(f.root, token, 'main.js') }]) {
    let error; try { await host.prepare(f.options({ ...overrides, credential: token })); } catch (caught) { error = caught; }
    assert.ok(code('CREDENTIAL')(error), 'refused: ' + Object.keys(overrides)[0]);
    tokenFree(error, token); tokenFree(String(error.stack), token);
  }
  assert.deepEqual(calls, [], 'refused before any filesystem I/O');
  assert.deepEqual(await fsp.readdir(tokenRuntime), [], 'no material written into a token-named runtime directory'); assert.deepEqual(await f.entries(), []);
});

test('a runtime parent replaced after validation is refused before any config is written; owned material is never removed through a redirect', async t => {
  for (const mode of ['junction', 'replaced directory']) {
    const f = await fixture(t), calls = [], original = f.runtime + '.orig', decoy = join(f.root, 'decoy');
    await fsp.mkdir(decoy); await fsp.writeFile(join(decoy, 'canary.txt'), 'keep'); await fsp.writeFile(join(f.runtime, 'canary.txt'), 'keep');
    let swapped = false;
    const host = createNativeHandoff({ fs: recordingFs(calls, { mkdir: async () => {
      if (swapped) return; swapped = true; await fsp.rename(f.runtime, original);
      if (mode === 'junction') await fsp.symlink(decoy, f.runtime, 'junction'); else await fsp.mkdir(f.runtime);
    } }) });
    await assert.rejects(host.prepare(f.options()), code('PATH'), mode + ' parent swap after validation');
    assert.ok(!(await tree(decoy)).some(entry => entry.endsWith('arcane.mcp.json')), mode + ': no config written into the redirected parent');
    assert.ok(!(await tree(original)).some(entry => entry.startsWith('claude-handoff-')), mode + ': nothing created in the moved original');
    assert.equal(await fsp.readFile(join(decoy, 'canary.txt'), 'utf8'), 'keep'); assert.equal(await fsp.readFile(join(original, 'canary.txt'), 'utf8'), 'keep');
    t.diagnostic(mode + ' retained after refusal: decoy=' + JSON.stringify(await tree(decoy)) + ' runtime=' + JSON.stringify(mode === 'junction' ? [] : await tree(f.runtime)));
    if (mode === 'junction') await fsp.unlink(f.runtime);
  }
  // Cleanup after preparation: the owned directory is now reachable only through a junction at its original path.
  const f = await fixture(t), host = createNativeHandoff(), receipt = await host.prepare(f.options()), moved = f.runtime + '.moved';
  await fsp.rename(f.runtime, moved); await fsp.symlink(moved, f.runtime, 'junction');
  assert.deepEqual(await host.cleanup(receipt), { state: 'unavailable', reason: 'owned_material_changed' }, 'never removes owned material through a redirected parent');
  assert.ok((await fsp.stat(join(moved, relative(f.runtime, receipt.configPath)))).isFile(), 'owned config retained');
  await fsp.unlink(f.runtime);
});

test('the createNativeHandoff envelope refuses class, proxy and accessor fs options without invoking getters or traps', async () => {
  let getters = 0, traps = 0;
  class Options { constructor() { this.fs = fsp; } }
  class FsLike { realpath() {} }
  for (const options of [new Options(), Object.defineProperty({}, 'fs', { get() { getters++; return fsp; }, enumerable: true }),
    { fs: new Proxy({ ...fsp }, { get() { traps++; }, getOwnPropertyDescriptor() { traps++; }, ownKeys() { traps++; return []; } }) },
    { fs: new FsLike() }, { fs: Object.defineProperty({ ...fsp }, 'lstat', { get() { getters++; return fsp.lstat; }, enumerable: true }) },
    { fs: { ...fsp, mkdir: 1 } }, { fs: null }, { fs: undefined }, { spawn: () => {} }, new Proxy({}, { ownKeys() { traps++; return []; } }), null])
    assert.throws(() => createNativeHandoff(options), code('INPUT'));
  assert.equal(getters, 0); assert.equal(traps, 0);
  assert.equal(typeof createNativeHandoff().prepare, 'function'); assert.equal(typeof createNativeHandoff({}).prepare, 'function');
  assert.equal(typeof createNativeHandoff({ fs: { ...fsp } }).prepare, 'function');
});
