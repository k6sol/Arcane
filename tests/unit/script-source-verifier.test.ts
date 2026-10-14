import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';
import { PassThrough } from 'node:stream';
import { createScriptSourceVerifier } from '../../packages/core/src/script-source-verifier.js';

const hash = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');
const HELP = 'Usage: luau-compile [--mode] [options] [file list]\n' +
  'binary, text, remarks, codegen, codegenir, codegenasm, codegenverbose, codegennull, null\n';
const SUMMARY = 'Compiled 0 KLOC into 0 KB bytecode (read 0.00s, parse 0.00s, compile 0.00s)\n';
const SOURCE = '--!strict\nerror("MUST-NEVER-EXECUTE")\nwhile true do end\nreturn "\u{1f680}"\n';
const FAILURE = /Script source verification failed\.$/;
const NAME = process.platform === 'win32' ? 'luau-compile.exe' : 'luau-compile';

function fixture(t: TestContext) {
  const root = fs.realpathSync.native(fs.mkdtempSync(join(fs.realpathSync.native(tmpdir()), 'arcane-script-verifier-test-')));
  const tools = join(root, 'tools'), directory = join(root, 'state');
  fs.mkdirSync(tools, { mode: 0o700 }); fs.mkdirSync(directory, { mode: 0o700 });
  const executable = join(tools, NAME), compilerBytes = Buffer.from('OWNED SYNTHETIC CLI FIXTURE; NEVER EXECUTED');
  fs.writeFileSync(executable, compilerBytes, { mode: 0o700 });
  // Only this owned fixture tree. Never follow links or recursively delete via a shell.
  const remove = (full: string): void => {
    const inside = relative(root, full);
    assert.ok(!inside.startsWith('..' + sep) && inside !== '..');
    const stat = fs.lstatSync(full);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      assert.equal(fs.realpathSync(full).toLowerCase(), full.toLowerCase());
      for (const name of fs.readdirSync(full)) remove(join(full, name));
      fs.rmdirSync(full);
    } else fs.unlinkSync(full);
  };
  t.after(() => remove(root));
  return { root, directory, executable, compilerBytes,
    options: { compiler: { executablePath: executable, sha256: hash(compilerBytes) }, directory } };
}

type FakeChild = EventEmitter & {
  stdout: PassThrough; stderr: PassThrough; exitCode: number | null; signalCode: NodeJS.Signals | null;
  kills: string[]; unrefs: number; kill: (signal: string) => boolean; unref: () => void;
};
interface Call { executable: string; args: string[]; options: childProcess.SpawnOptions; child: FakeChild }
function complete(child: FakeChild, code: number | null, stdout = '', stderr = '', signal: NodeJS.Signals | null = null): void {
  if (stdout) child.stdout.write(stdout);
  if (stderr) child.stderr.write(stderr);
  child.exitCode = code; child.signalCode = signal;
  child.stdout.end(); child.stderr.end(); child.emit('close', code, signal);
}
function compilerDouble(t: TestContext, act: (call: Call) => void = call => complete(call.child, 0, SUMMARY),
  help: (call: Call) => void = call => complete(call.child, 0, HELP), throwOnCompile = false) {
  const calls: Call[] = [];
  t.mock.method(childProcess, 'spawn', (executable: string, args: string[], options: childProcess.SpawnOptions) => {
    if (throwOnCompile && args[0] === '--null') throw new Error('PRIVATE-SPAWN-ERROR');
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null, kills: [] as string[], unrefs: 0,
      kill(this: FakeChild, signal: string) {
        this.kills.push(signal);
        queueMicrotask(() => complete(this, null, '', '', 'SIGKILL'));
        return true;
      },
      unref(this: FakeChild) { this.unrefs++; },
    });
    const call = { executable, args: [...args], options, child };
    calls.push(call);
    queueMicrotask(() => args[0] === '--help' ? help(call) : act(call));
    return child;
  });
  return calls;
}
function mockFs(t: TestContext, method: 'readSync' | 'lstatSync' | 'writeSync', fn: (...args: unknown[]) => unknown): void {
  const mocked = t.mock.method(fs, method, fn);
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
}

test('synthetic pinned executable / CLI replay: fixed null mode, private files, scrubbed env, fresh bounded proof', async t => {
  const f = fixture(t);
  let firstDirectory = '';
  const calls = compilerDouble(t, call => {
    const file = call.args[1]!;
    assert.equal(fs.readFileSync(file, 'utf8'), SOURCE);
    assert.equal(basename(file), 'script.luau');
    assert.equal(dirname(file), call.options.cwd);
    assert.equal(dirname(dirname(file)), f.directory);
    assert.match(basename(dirname(file)), /^source-verify-[a-f0-9-]{36}$/);
    assert.equal(fs.statSync(file).nlink, 1);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(fs.statSync(dirname(file)).mode & 0o777, 0o700);
    }
    if (!firstDirectory) firstDirectory = dirname(file);
    else assert.notEqual(dirname(file), firstDirectory);
    complete(call.child, 0, SUMMARY);
  });
  const verifier = await createScriptSourceVerifier(f.options);
  t.after(() => verifier.dispose());
  assert.deepEqual(Object.keys(verifier).sort(), ['dispose', 'verify']);
  assert.equal(Object.isFrozen(verifier), true);
  // Configuration is snapshotted; mutating it cannot redirect a later invocation.
  f.options.compiler.executablePath = join(f.root, 'untrusted.exe');
  f.options.compiler.sha256 = hash('different'); f.options.directory = f.root;
  for (let i = 0; i < 2; i++) {
    const proof = await verifier.verify(SOURCE);
    assert.deepEqual(Object.keys(proof).sort(), ['compilerSha256', 'elapsedMs', 'sourceSha256', 'syntaxVerified']);
    assert.equal(proof.sourceSha256, hash(Buffer.from(SOURCE)));
    assert.equal(proof.compilerSha256, hash(f.compilerBytes));
    assert.equal(proof.syntaxVerified, true); assert.equal(Object.isFrozen(proof), true);
    assert.ok(Number.isFinite(proof.elapsedMs) && proof.elapsedMs >= 0 && proof.elapsedMs <= 15_000);
    assert.deepEqual(fs.readdirSync(f.directory), []);
  }
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0]!.args, ['--help']);
  for (const call of calls) {
    assert.equal(call.executable, f.executable);
    assert.equal(call.options.shell, false); assert.equal(call.options.windowsHide, true);
    assert.equal(call.options.detached, false); assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.deepEqual(call.options.env, process.platform === 'win32' && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {});
  }
  for (const call of calls.slice(1)) assert.deepEqual(call.args, ['--null', join(call.options.cwd as string, 'script.luau')]);
});

test('invalid activation sources reject before source I/O or compiler spawn', async t => {
  const f = fixture(t), calls = compilerDouble(t), verifier = await createScriptSourceVerifier(f.options);
  t.after(() => verifier.dispose());
  for (const source of ['', ' \r\n\t', 'return "\0"', '\ud800', '\udfff', 'x\ud800x',
    'x'.repeat(100 * 1024 + 1), '\u{1f680}'.repeat(26 * 1024), null, {}, 1]) {
    await assert.rejects(verifier.verify(source as string), FAILURE);
  }
  assert.equal(calls.length, 1); assert.deepEqual(fs.readdirSync(f.directory), []);
  const boundary = '--' + 'a'.repeat(100 * 1024 - 2);
  assert.equal((await verifier.verify(boundary)).sourceSha256, hash(boundary));
});

test('invalid cancellation objects add no path/diagnostic authority and cause no compiler call', async t => {
  const f = fixture(t), calls = compilerDouble(t), verifier = await createScriptSourceVerifier(f.options);
  t.after(() => verifier.dispose());
  for (const signal of [null, {}, new Proxy(new AbortController().signal, {}),
    { get aborted(): boolean { return assert.fail('caller getter invoked'); } }]) {
    await assert.rejects(verifier.verify(SOURCE, signal as AbortSignal), FAILURE);
  }
  assert.equal(calls.length, 1); assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('trusted configuration has no flags, route paths, accessors, proxy or environment bypass', async t => {
  const f = fixture(t), calls = compilerDouble(t);
  const configurations = [
    { ...f.options, flags: ['--binary'] }, { ...f.options, env: { PATH: f.root } },
    { ...f.options, compiler: { ...f.options.compiler, sha256: hash('wrong') } },
    { ...f.options, compiler: { ...f.options.compiler, sha256: 'A'.repeat(64) } },
    { ...f.options, directory: 'state' }, { ...f.options, directory: join(f.root, 'absent') },
    { ...f.options, directory: f.directory + sep },
    { ...f.options, compiler: { ...f.options.compiler, executablePath: join(f.root, 'fake.exe') } },
    Object.create(f.options), new Proxy(f.options, {}),
    { compiler: f.options.compiler, get directory(): string { return assert.fail('configuration getter invoked'); } },
  ];
  for (const options of configurations) await assert.rejects(createScriptSourceVerifier(options), FAILURE);
  assert.equal(calls.length, 0);
});

test('bounded compiler rejects empty, oversized and hardlinked physical executables', async t => {
  for (const mode of ['empty', 'oversized', 'hardlink'] as const) await t.test(mode, async sub => {
    const f = fixture(sub), calls = compilerDouble(sub);
    if (mode === 'empty') fs.writeFileSync(f.executable, '');
    if (mode === 'oversized') fs.truncateSync(f.executable, 32 * 1024 * 1024 + 1);
    if (mode === 'hardlink') fs.linkSync(f.executable, join(f.root, 'compiler-link'));
    await assert.rejects(createScriptSourceVerifier(f.options), FAILURE);
    assert.equal(calls.length, 0);
  });
});

test('canonical parents: compiler and state junction/symlink aliases reject without following them', async t => {
  for (const mode of ['compiler-parent', 'state', 'state-parent', 'file'] as const) await t.test(mode, async sub => {
    const f = fixture(sub), calls = compilerDouble(sub), alias = join(f.root, mode === 'file' ? NAME : 'alias');
    const target = mode === 'compiler-parent' ? dirname(f.executable) : mode === 'file' ? f.executable : f.directory;
    try { fs.symlinkSync(target, alias, mode === 'file' ? 'file' : process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM' && mode === 'file') { sub.skip('File symlinks require host privilege. Directory junction cases still run.'); return; }
      throw error;
    }
    const options = mode === 'compiler-parent' ? { ...f.options, compiler: { ...f.options.compiler, executablePath: join(alias, NAME) } }
      : mode === 'file' ? { ...f.options, compiler: { ...f.options.compiler, executablePath: alias } }
      : { ...f.options, directory: mode === 'state' ? alias : join(alias, 'nested') };
    if (mode === 'state-parent') fs.mkdirSync(join(f.directory, 'nested'));
    await assert.rejects(createScriptSourceVerifier(options), FAILURE); assert.equal(calls.length, 0);
  });
});

test('ancestor identity changes alone revoke proof without relying on changed compiler bytes', async t => {
  const f = fixture(t), calls = compilerDouble(t), verifier = await createScriptSourceVerifier(f.options);
  t.after(() => verifier.dispose());
  const realStat = fs.lstatSync;
  mockFs(t, 'lstatSync', (...args) => {
    const stat = Reflect.apply(realStat, fs, args) as fs.BigIntStats;
    if (args[0] === dirname(f.executable) && typeof stat.ino === 'bigint') stat.ino++;
    return stat;
  });
  await assert.rejects(verifier.verify(SOURCE), FAILURE);
  assert.equal(calls.length, 1); assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('help is a pinned bounded protocol preflight, never proof by exit zero alone', async t => {
  for (const mode of ['empty', 'wrong-mode', 'stderr', 'nonzero', 'compiler-tamper', 'flood'] as const) await t.test(mode, async sub => {
    const f = fixture(sub), calls = compilerDouble(sub, undefined, call => {
      if (mode === 'compiler-tamper') fs.writeFileSync(f.executable, 'changed');
      if (mode === 'flood') call.child.stdout.write(Buffer.alloc(64 * 1024 + 1));
      else complete(call.child, mode === 'nonzero' ? 1 : 0,
        mode === 'empty' ? '' : mode === 'wrong-mode' ? HELP.replace(', null', '') : HELP,
        mode === 'stderr' ? 'PRIVATE-DIAGNOSTIC' : '');
    });
    await assert.rejects(createScriptSourceVerifier(f.options), FAILURE);
    assert.equal(calls.length, 1);
    if (mode === 'flood') assert.deepEqual(calls[0]!.child.kills, ['SIGKILL']);
  });
});

test('syntax failure, nonzero, signal, malformed UTF-8 and missing/extra summaries issue no proof or private diagnostics', async t => {
  for (const mode of ['syntax', 'nonzero', 'no-proof', 'stderr', 'extra', 'utf8', 'signal', 'spawn-error', 'throw'] as const) await t.test(mode, async sub => {
    const f = fixture(sub), calls = compilerDouble(sub, call => {
      if (mode === 'spawn-error') { call.child.emit('error', new Error(f.directory + '/PRIVATE-SOURCE')); return; }
      if (mode === 'utf8') { call.child.stdout.write(Buffer.from([0xff])); complete(call.child, 0); return; }
      complete(call.child, mode === 'syntax' ? 1 : mode === 'nonzero' ? 27 : mode === 'signal' ? null : 0,
        mode === 'no-proof' ? '' : mode === 'extra' ? SUMMARY + 'extra\n' : SUMMARY,
        mode === 'syntax' ? call.args[1] + '(1,2): SyntaxError: PRIVATE-SOURCE\n' : mode === 'stderr' ? 'PRIVATE-SOURCE' : '',
        mode === 'signal' ? 'SIGTERM' : null);
    }, undefined, mode === 'throw');
    const verifier = await createScriptSourceVerifier(f.options); sub.after(() => verifier.dispose());
    await assert.rejects(verifier.verify(SOURCE), FAILURE);
    assert.deepEqual(fs.readdirSync(f.directory), []);
    if (mode === 'spawn-error') assert.deepEqual(calls[1]!.child.kills, ['SIGKILL']);
  });
});

test('compiler bytes and original file identity stay pinned before every call; no cached/replayed proof', async t => {
  for (const mode of ['contents', 'same-bytes-replacement', 'hardlink', 'parent-replacement'] as const) await t.test(mode, async sub => {
    const f = fixture(sub), calls = compilerDouble(sub), verifier = await createScriptSourceVerifier(f.options);
    sub.after(() => verifier.dispose());
    await verifier.verify(SOURCE);
    if (mode === 'contents') fs.writeFileSync(f.executable, 'tampered compiler');
    if (mode === 'same-bytes-replacement') {
      fs.renameSync(f.executable, join(f.root, 'old-compiler')); fs.writeFileSync(f.executable, f.compilerBytes);
    }
    if (mode === 'hardlink') fs.linkSync(f.executable, join(f.root, 'hardlink'));
    if (mode === 'parent-replacement') {
      // Windows blocks renaming a directory containing an open file. Move only
      // the owned file, then replace the empty directory and restore that inode.
      const saved = join(f.root, 'saved-compiler');
      fs.renameSync(f.executable, saved); fs.rmdirSync(dirname(f.executable));
      fs.mkdirSync(dirname(f.executable)); fs.renameSync(saved, f.executable);
    }
    await assert.rejects(verifier.verify(SOURCE), FAILURE);
    await assert.rejects(verifier.verify(SOURCE), FAILURE);
    assert.equal(calls.length, 2); assert.deepEqual(fs.readdirSync(f.directory), []);
  });
});

test('compiler/source tamper during compilation and read races revoke a zero-exit summary', async t => {
  for (const mode of ['compiler', 'compiler-replace', 'source', 'source-replace', 'source-hardlink', 'read-race'] as const) await t.test(mode, async sub => {
    const f = fixture(sub);
    const calls = compilerDouble(sub, call => {
      if (mode === 'compiler') fs.writeFileSync(f.executable, 'changed');
      if (mode === 'compiler-replace') {
        fs.renameSync(f.executable, join(f.root, 'old-compiler')); fs.writeFileSync(f.executable, f.compilerBytes);
      }
      if (mode === 'source') fs.writeFileSync(call.args[1]!, 'return 2');
      if (mode === 'source-replace') {
        fs.renameSync(call.args[1]!, join(f.root, 'old-source')); fs.writeFileSync(call.args[1]!, SOURCE);
      }
      if (mode === 'source-hardlink') fs.linkSync(call.args[1]!, join(f.root, 'linked-source'));
      complete(call.child, 0, SUMMARY);
    });
    const verifier = await createScriptSourceVerifier(f.options); sub.after(() => verifier.dispose());
    if (mode === 'read-race') {
      const realRead = fs.readSync;
      let changed = false;
      mockFs(sub, 'readSync', (...args) => {
        const count = Reflect.apply(realRead, fs, args) as number;
        if (!changed && count > 0 && (args[1] as Buffer).subarray(0, count).toString() === SOURCE) {
          changed = true;
          const ownDirectory = fs.readdirSync(f.directory)[0]!;
          fs.writeFileSync(join(f.directory, ownDirectory, 'script.luau'), 'return 3');
        }
        return count;
      });
    }
    await assert.rejects(verifier.verify(SOURCE), FAILURE);
    assert.equal(calls.length, mode === 'read-race' ? 1 : 2);
    if (mode === 'source-replace' || mode === 'source-hardlink') {
      const file = calls[1]!.args[1]!;
      assert.equal(fs.readFileSync(file, 'utf8'), SOURCE, 'Unowned replacement/linked evidence is retained');
    } else assert.deepEqual(fs.readdirSync(f.directory), []);
  });
});

test('write failure produces no proof and cleans only its exact owned source', async t => {
  const f = fixture(t), calls = compilerDouble(t), verifier = await createScriptSourceVerifier(f.options);
  t.after(() => verifier.dispose());
  mockFs(t, 'writeSync', () => { throw new Error('PRIVATE-PATH'); });
  await assert.rejects(verifier.verify(SOURCE), FAILURE);
  assert.equal(calls.length, 1); assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('one inflight call is busy; abort waits for close and kills only its own child', async t => {
  const f = fixture(t), calls = compilerDouble(t, () => {}), verifier = await createScriptSourceVerifier(f.options);
  t.after(() => verifier.dispose());
  const signal = new AbortController(), pending = verifier.verify(SOURCE, signal.signal);
  const rejectedCall = assert.rejects(pending, FAILURE);
  await assert.rejects(verifier.verify(SOURCE), /Script source verifier is busy\.$/);
  const call = calls[1]!;
  let settled = false; void pending.then(() => { settled = true; }, () => { settled = true; });
  call.child.kill = signal => { call.child.kills.push(signal); return true; };
  signal.abort();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(settled, false); assert.ok(fs.existsSync(call.args[1]!));
  assert.deepEqual(call.child.kills, ['SIGKILL']); assert.deepEqual(calls[0]!.child.kills, []);
  complete(call.child, null, '', '', 'SIGKILL');
  await rejectedCall; assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('already aborted signal does no source I/O; dispose cancels inflight and is idempotent', async t => {
  const f = fixture(t), calls = compilerDouble(t, () => {}), verifier = await createScriptSourceVerifier(f.options);
  const signal = new AbortController(); signal.abort();
  await assert.rejects(verifier.verify(SOURCE, signal.signal), FAILURE); assert.equal(calls.length, 1);
  const pending = verifier.verify(SOURCE); const rejectedCall = assert.rejects(pending, FAILURE);
  verifier.dispose(); verifier.dispose();
  await rejectedCall;
  assert.deepEqual(calls[1]!.child.kills, ['SIGKILL']);
  await assert.rejects(verifier.verify(SOURCE), FAILURE); assert.equal(calls.length, 2);
  assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('abort immediately after a successful compiler close revokes proof', async t => {
  const f = fixture(t), signal = new AbortController();
  compilerDouble(t, call => { complete(call.child, 0, SUMMARY); signal.abort(); });
  const verifier = await createScriptSourceVerifier(f.options); t.after(() => verifier.dispose());
  await assert.rejects(verifier.verify(SOURCE, signal.signal), FAILURE);
  assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('combined stdout/stderr budget is 64 KiB and never releases proof after stopping', async t => {
  const f = fixture(t), calls = compilerDouble(t, call => {
    call.child.stdout.write(Buffer.alloc(32 * 1024)); call.child.stderr.write(Buffer.alloc(32 * 1024 + 1));
  });
  const verifier = await createScriptSourceVerifier(f.options); t.after(() => verifier.dispose());
  await assert.rejects(verifier.verify(SOURCE), FAILURE);
  assert.deepEqual(calls[1]!.child.kills, ['SIGKILL']);
  assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('deadline cancels a hung compiler within 15s and waits for terminal close before cleanup', async t => {
  const f = fixture(t), calls = compilerDouble(t, () => {}), verifier = await createScriptSourceVerifier(f.options);
  t.after(() => verifier.dispose());
  const start = performance.now();
  await assert.rejects(verifier.verify(SOURCE), FAILURE);
  assert.ok(performance.now() - start < 15_000);
  assert.deepEqual(calls[1]!.child.kills, ['SIGKILL']); assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('unknown termination retains owned evidence, unrefs only own child and poisons verifier', async t => {
  const f = fixture(t), calls = compilerDouble(t, call => {
    call.child.kill = signal => { call.child.kills.push(signal); return false; };
    call.child.stdout.write(Buffer.alloc(64 * 1024 + 1));
  });
  const verifier = await createScriptSourceVerifier(f.options); t.after(() => verifier.dispose());
  const start = performance.now(); await assert.rejects(verifier.verify(SOURCE), FAILURE);
  assert.ok(performance.now() - start < 3000);
  const call = calls[1]!;
  assert.equal(call.child.unrefs, 1); assert.deepEqual(call.child.kills, ['SIGKILL']);
  assert.equal(call.child.stdout.destroyed, true); assert.equal(call.child.stderr.destroyed, true);
  assert.equal(fs.readFileSync(call.args[1]!, 'utf8'), SOURCE);
  await assert.rejects(verifier.verify(SOURCE), FAILURE); verifier.dispose();
  assert.ok(fs.existsSync(call.args[1]!)); assert.equal(calls.length, 2);
});

test('cleanup refuses linked child replacement and preserves adjacent state files', async t => {
  const f = fixture(t), sentinel = join(f.directory, 'keep.json'); fs.writeFileSync(sentinel, 'KEEP');
  let escaped = '';
  const calls = compilerDouble(t, call => {
    const childDirectory = dirname(call.args[1]!);
    escaped = join(f.root, 'escaped'); fs.mkdirSync(escaped); fs.writeFileSync(join(escaped, 'script.luau'), SOURCE);
    fs.renameSync(call.args[1]!, join(f.root, 'original-source')); fs.rmdirSync(childDirectory);
    fs.symlinkSync(escaped, childDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    complete(call.child, 0, SUMMARY);
  });
  const verifier = await createScriptSourceVerifier(f.options); t.after(() => verifier.dispose());
  await assert.rejects(verifier.verify(SOURCE), FAILURE);
  assert.equal(fs.readFileSync(join(escaped, 'script.luau'), 'utf8'), SOURCE);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'KEEP');
  assert.equal(fs.lstatSync(dirname(calls[1]!.args[1]!)).isSymbolicLink(), true);
});

test('REAL pinned installed compiler: syntax passes/fails while execution traps are only compiled', async t => {
  if (process.env.ARCANE_TEST_SCRIPT_SOURCE_REAL_COMPILER !== '1') {
    t.skip('Opt in with ARCANE_TEST_SCRIPT_SOURCE_REAL_COMPILER=1; compiler path and digest are fixed in this test.'); return;
  }
  const executablePath = 'C:/Users/alexk/AppData/Local/Temp/arcane-luau-tools/luau-compile.exe';
  const sha256 = '74cf7ed3621b8966bac6fec7f1a0caf13616655fa06d346133cd31f6aac439d8';
  assert.equal(process.platform, 'win32');
  const f = fixture(t);
  const verifier = await createScriptSourceVerifier({ compiler: { executablePath: executablePath.replaceAll('/', '\\'), sha256 }, directory: f.directory });
  t.after(() => verifier.dispose());
  const proof = await verifier.verify(SOURCE);
  assert.equal(proof.syntaxVerified, true); assert.equal(proof.sourceSha256, hash(SOURCE));
  assert.equal(proof.compilerSha256, sha256);
  await assert.rejects(verifier.verify('--!strict\nlocal broken =\n'), FAILURE);
  const repeat = await verifier.verify('--!strict\nlocal n: number = 42\nreturn n\n');
  assert.equal(repeat.syntaxVerified, true); assert.deepEqual(fs.readdirSync(f.directory), []);
  t.diagnostic('Real luau-compile --help/--null validated; pinned SHA-256 ' + sha256);
});
