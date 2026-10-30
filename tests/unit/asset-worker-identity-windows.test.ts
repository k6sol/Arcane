import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, lstat, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, sep, win32 } from 'node:path';
import { captureWorkerIdentity, attestRecordedWorker, canonicalTimestamp, type WorkerIdentity } from '../../packages/asset-pipeline/src/worker-identity.js';
import { makeFixtureDirectory, fixtureTempDirectory } from './windows-fixture-paths.js';

// Actual default Windows query against this test's original fixed Node child.
// No Blender/Studio/provider, protected PID, process enumeration, ACL or privilege change.
const CHILD = "process.stdout.write('ready\\n');process.stdin.resume();process.stdin.once('end',()=>process.exit(0));";
type Exit = { code: number | null; signal: NodeJS.Signals | null };

async function fixture(t: TestContext) {
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
  assert.ok(result.status === 'captured', 'Actual bounded Windows query must capture the original held child.');
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
