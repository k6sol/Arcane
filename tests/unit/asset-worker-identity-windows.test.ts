import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, lstat, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, sep, win32 } from 'node:path';
import { captureWorkerIdentity, attestRecordedWorker, canonicalTimestamp, defaultProcessQueryHost, QUERY_MAX_OUTPUT_BYTES, QUERY_WATCHDOG_MS,
  type ProcessQueryHost, type WorkerIdentity } from '../../packages/asset-pipeline/src/worker-identity.js';
import { makeFixtureDirectory, fixtureTempDirectory } from './windows-fixture-paths.js';

// Actual default Windows query against this test's original fixed Node child.
// No Blender/Studio/provider, protected PID, process enumeration, ACL or privilege change.
const CHILD = "process.stdout.write('ready\\n');process.stdin.resume();process.stdin.once('end',()=>process.exit(0));";
type Exit = { code: number | null; signal: NodeJS.Signals | null };

// Observe only the original query callback; never publish process output or retry it.
const QUERY_STAGES = ['setup', 'emit-imports', 'wrapper', 'type-readback', 'open', 'first-wait', 'times', 'path', 'final-wait', 'close', 'serialize'] as const;
const METADATA_STAGES = ['unavailable', 'type-create', 'method-lookup', 'attribute-read', 'attribute-count', 'library', 'entrypoint', 'last-error', 'exact-spelling', 'charset', 'calling-convention', 'preserve-signature'] as const;
function observeQueries(t: TestContext) {
  const original = defaultProcessQueryHost.execFile; let reports = 0;
  const report = (started: number, outcome: 'ok' | 'exit4' | 'timeout' | 'max-buffer' | 'failed' | 'threw', stdout: unknown, stderr: unknown) => {
    try {
      if (reports >= 6) return;
      const stage = typeof stderr === 'string' ? /^ARCANE_WORKER_QUERY_STAGE:(0|[1-9]|10)$/.exec(stderr) : null;
      const metadata = typeof stderr === 'string' ? /^ARCANE_WORKER_QUERY_STAGE:3:([1-9]|10|11):([0-5])$/.exec(stderr) : null;
      const validMetadata = metadata && (Number(metadata[1]) === 1 ? Number(metadata[2]) === 5 : Number(metadata[2]) < 5);
      t.diagnostic(JSON.stringify({ schemaVersion: 1, kind: 'original-worker-query', sequence: ++reports, outcome,
        stage: validMetadata ? 'type-readback' : stage ? QUERY_STAGES[Number(stage[1])] ?? 'unavailable' : 'unavailable',
        metadataStage: metadata && validMetadata ? METADATA_STAGES[Number(metadata[1])] ?? 'unavailable' : 'unavailable',
        importIndex: metadata && validMetadata ? Number(metadata[2]) : null,
        stdoutBytes: typeof stdout === 'string' ? Math.min(QUERY_MAX_OUTPUT_BYTES + 1, Buffer.byteLength(stdout, 'utf8')) : 0,
        stderrBytes: typeof stderr === 'string' ? Math.min(QUERY_MAX_OUTPUT_BYTES + 1, Buffer.byteLength(stderr, 'utf8')) : 0,
        elapsedMs: Math.max(0, Math.min(QUERY_WATCHDOG_MS * 2, Math.round(performance.now() - started))) }));
    } catch { /* Diagnostic failure cannot change the original query outcome. */ }
  };
  const wrapped: ProcessQueryHost['execFile'] = function (this: ProcessQueryHost, file, args, options, callback) {
    let started = 0; try { started = performance.now(); } catch { /* Observation only. */ }
    const observed: Parameters<ProcessQueryHost['execFile']>[3] = function (this: unknown, error, stdout, stderr) {
      let category: 'ok' | 'exit4' | 'timeout' | 'max-buffer' | 'failed' = 'failed';
      try { category = error === null ? 'ok' : error.killed === true || error.signal === 'SIGTERM' ? 'timeout'
        : error.code === 4 ? 'exit4' : error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'max-buffer' : 'failed'; } catch { /* Keep finite fallback. */ }
      report(started, category, stdout, stderr);
      return Reflect.apply(callback, this, [error, stdout, stderr]);
    };
    try { return Reflect.apply(original, this, [file, args, options, observed]); }
    catch (error) { report(started, 'threw', undefined, undefined); throw error; }
  };
  t.mock.method(defaultProcessQueryHost, 'execFile', wrapped);
}

async function fixture(t: TestContext) {
  observeQueries(t);
  const root = makeFixtureDirectory('arcane-worker-native-query-'), identity = await lstat(root);
  const owners: { close(): Promise<Exit>; observed(): boolean }[] = []; let unownedAttempt = false;
  t.after(async () => {
    let failed = false, first: unknown;
    for (const owner of [...owners].reverse()) try { await owner.close(); } catch (error) { if (!failed) { failed = true; first = error; } }
    if (!unownedAttempt && owners.every(owner => owner.observed())) {
      const now = await lstat(root), actual = await realpath(root), child = relative(fixtureTempDirectory(), actual);
      assert.ok(now.isDirectory() && !now.isSymbolicLink() && now.ino === identity.ino && now.dev === identity.dev);
      assert.equal(actual, root); assert.ok(child.startsWith('arcane-worker-native-query-') && !isAbsolute(child) && !child.includes(sep) && !child.includes('..'));
      await rm(root, { recursive: true, force: true });
    } else { assert.fail('Original query-test child closure was not established; owned files retained.'); }
    if (failed) throw first;
  });
  async function start(executable: string) {
    t.signal.throwIfAborted(); unownedAttempt = true;
    const child = spawn(executable, ['-e', CHILD], { cwd: root, shell: false, windowsHide: true, stdio: 'pipe', signal: t.signal,
      env: { ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) } });
    let observed = false, closing: Promise<Exit> | null = null;
    const closed = new Promise<Exit>(resolve => child.once('close', (code, signal) => { observed = true; resolve({ code, signal }); }));
    child.on('error', () => { /* Ready rejects below; original close remains the only closure proof. */ });
    child.stderr.on('data', () => { /* Drain, never retain or publish process text. */ });
    async function wait(ms: number) {
      if (observed) return true; let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([closed, new Promise<void>(resolve => { timer = setTimeout(resolve, ms); })]); }
      finally { if (timer) clearTimeout(timer); }
      return observed;
    }
    function close(): Promise<Exit> {
      if (!closing) closing = (async () => {
        if (!observed) { try { child.stdin.end(); } catch { /* Still join the original close. */ } }
        if (!await wait(1000)) { try { child.kill('SIGTERM'); } catch { /* Kill is not closure. */ } }
        if (!await wait(1000)) { try { child.kill('SIGKILL'); } catch { /* Keep unknown ownership if close never arrives. */ } }
        assert.ok(await wait(2000), 'Original query-test child close must be observed.');
        return await closed;
      })();
      return closing;
    }
    owners.push({ close, observed: () => observed }); unownedAttempt = false;
    await new Promise<void>((resolve, reject) => {
      let bytes = 0, ready = '', done = false;
      const finish = (failure?: Error) => { if (done) return; done = true; clearTimeout(timer); child.stdout.off('data', data); child.off('error', error); child.off('close', early); failure ? reject(failure) : resolve(); };
      const error = () => finish(new Error('Original fixed query-test child could not start.'));
      const early = () => finish(new Error('Original fixed query-test child closed before readiness.'));
      const data = (chunk: Buffer) => { bytes += chunk.length; if (bytes > 32) return finish(new Error('Original fixed child readiness exceeded its bound.')); ready += chunk.toString('utf8'); if (ready === 'ready\n') finish(); };
      const timer = setTimeout(() => finish(new Error('Original fixed child readiness did not arrive.')), 3000);
      child.stdout.on('data', data); child.once('error', error); child.once('close', early);
      if (observed) early();
    });
    const pid = child.pid; assert.ok(typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0);
    return { pid, executable, close };
  }
  return { root, start };
}

async function capture(t: TestContext, child: { pid: number; executable: string }): Promise<WorkerIdentity> {
  t.signal.throwIfAborted();
  const result = await captureWorkerIdentity({ pid: child.pid, role: 'generate', executable: child.executable });
  assert.ok(result.status === 'captured', 'Actual bounded Windows query must capture the original held child: ' + (result.status === 'uncertain' ? result.reason : 'captured'));
  assert.equal(result.identity.schemaVersion, 2); assert.ok(result.identity.pid === child.pid);
  assert.ok(canonicalTimestamp(result.identity.processCreatedAt));
  assert.ok(win32.normalize(result.identity.executable).toLowerCase() === win32.normalize(child.executable).toLowerCase());
  assert.deepEqual(Object.keys(result.identity).sort(), ['executable', 'pid', 'processCreatedAt', 'role', 'schemaVersion']);
  return result.identity;
}

test('actual default Windows same-handle query captures a held Node child and proves its original close', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  const f = await fixture(t), child = await f.start(await realpath(process.execPath));
  const identity = await capture(t, child); t.signal.throwIfAborted();
  assert.deepEqual(await attestRecordedWorker(identity), { verdict: 'same-worker-running', reason: 'identity-matched' });
  const second = await capture(t, child); assert.ok(second.processCreatedAt === identity.processCreatedAt, 'Repeated native creation time must remain exact.');
  const exit = await child.close(); assert.equal(exit.code, 0); assert.equal(exit.signal, null); t.signal.throwIfAborted();
  const gone = await attestRecordedWorker(identity); assert.equal(gone.verdict, 'recorded-worker-gone');
  assert.ok(gone.reason === 'pid-absent' || gone.reason === 'pid-reused', 'Only exact OS absence or a new native creation time can prove gone.');
});

test('actual default Windows query preserves an owned Unicode executable path as UTF8', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  const f = await fixture(t), source = await realpath(process.execPath), target = join(f.root, 'worker-é.exe');
  const before = await lstat(source); assert.ok(before.isFile() && before.size > 0 && before.size <= 512 * 1024 * 1024);
  await copyFile(source, target); const copied = await lstat(target);
  assert.ok(copied.isFile() && !copied.isSymbolicLink() && copied.nlink === 1 && copied.size === before.size);
  const child = await f.start(await realpath(target)), identity = await capture(t, child);
  assert.ok(identity.executable.includes('é')); t.signal.throwIfAborted();
  assert.deepEqual(await attestRecordedWorker(identity), { verdict: 'same-worker-running', reason: 'identity-matched' });
  const exit = await child.close(); assert.equal(exit.code, 0); assert.equal(exit.signal, null);
});
