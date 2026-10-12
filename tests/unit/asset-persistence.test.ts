import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createAssetService } from '../../apps/daemon/src/asset-service.js';
import type { AssetService } from '../../apps/daemon/src/asset-service.js';
import { AssetError, normalizeRequest } from '../../packages/asset-pipeline/src/index.js';
import { noLinks, within } from '../../packages/asset-pipeline/src/paths.js';
import { ArcaneError } from '../../packages/protocol/src/providers.js';

// Builtin mocks are process-wide: run this file in node --test's default dedicated
// child process, with serial tests. ESM namespaces are immutable; patch the
// genuine builtin default and synchronize the service's already-imported bindings.
const serial = { concurrency: false, timeout: 10000 };
const ROOT = resolve(process.cwd());
const realFs = { ...fs };
const JOB_ID = '11111111-1111-4111-8111-111111111111';
const instant = '2026-01-01T00:00:00.000Z';
type Phase = 'path-check' | 'write' | 'replace';

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

const errorCode = (expected: string) => (error: unknown) =>
  (error instanceof ArcaneError || error instanceof AssetError) && error.code === expected;

function persistence(phase: Phase, errno: string) {
  return (error: unknown) => {
    assert.ok(error instanceof ArcaneError);
    assert.equal(error.code, 'PERSISTENCE');
    assert.equal(error.message, `Asset history could not be saved (${phase}/${errno}); inspect retained job journals.`);
    assert.equal(error.cause, undefined, 'Raw filesystem errors must not escape through a cause.');
    return true;
  };
}

async function fixture(t: test.TestContext) {
  const temporaryRoot = await realFs.realpath(tmpdir());
  const directory = await realFs.mkdtemp(join(temporaryRoot, 'arcane-asset-persistence-'));
  const outputRoot = join(directory, 'assets'), workerRoot = join(directory, 'worker');
  const jobDirectory = join(outputRoot, 'retained-' + JOB_ID);
  await realFs.mkdir(jobDirectory, { recursive: true });
  await realFs.mkdir(workerRoot);
  await realFs.writeFile(join(workerRoot, 'probe.py'), '# inert fixture; never executed\n');
  const journal = Buffer.from(JSON.stringify({
    schemaVersion: 1, jobId: JOB_ID, state: 'failed',
    request: normalizeRequest({ template: 'hero-prop', name: 'retained' }),
    directory: '/untrusted/original-directory', manifestPath: null,
    error: { code: 'BLENDER_UNAVAILABLE', message: 'Retained synthetic failure.' },
    startedAt: instant, finishedAt: instant
  }) + '\n');
  const checkpoint = Buffer.from('retained synthetic checkpoint; never opened by Blender\n');
  const index = Buffer.from(JSON.stringify({ schemaVersion: 1, jobs: [{ jobId: JOB_ID, events: [] }] }) + '\n');
  await realFs.writeFile(join(jobDirectory, 'job.json'), journal);
  await realFs.writeFile(join(jobDirectory, 'blockout.blend'), checkpoint);
  await realFs.writeFile(join(outputRoot, 'index.json'), index);

  const services: AssetService[] = [];
  const gates: ReturnType<typeof barrier>[] = [];
  const spawn = t.mock.method(childProcess, 'spawn', () => {
    throw new Error('Persistence tests must never launch a native process.');
  });
  syncBuiltinESMExports();
  const restore = () => { Object.assign(fs, realFs); syncBuiltinESMExports(); };
  t.after(async () => {
    for (const gate of gates) gate.release();
    try {
      for (const service of services) {
        try { await service.close(); }
        catch (error) { assert.ok(error instanceof ArcaneError && error.code === 'PERSISTENCE'); }
      }
      assert.equal(spawn.mock.callCount(), 0, 'Neither recovery nor an unavailable-runtime job may spawn.');
    } finally {
      t.mock.restoreAll(); syncBuiltinESMExports();
      assert.ok(directory !== temporaryRoot && within(temporaryRoot, directory));
      await noLinks(directory);
      await realFs.rm(directory, { recursive: true, force: true });
    }
  });
  const options = {
    cwd: ROOT, outputRoot, workerRoot,
    blenderExecutable: join(directory, 'missing-blender.exe'),
    pythonExecutable: join(directory, 'missing-python.exe')
  };
  async function open() {
    const service = await createAssetService(options);
    services.push(service);
    return service;
  }
  async function retained() {
    assert.deepEqual(await realFs.readFile(join(jobDirectory, 'job.json')), journal);
    assert.deepEqual(await realFs.readFile(join(jobDirectory, 'blockout.blend')), checkpoint);
  }
  return {
    directory, outputRoot, jobDirectory, index, open, retained, restore,
    gate() { const gate = barrier(); gates.push(gate); return gate; }
  };
}

function indexTemporary(outputRoot: string, path: unknown) {
  return typeof path === 'string' && dirname(path) === outputRoot &&
    /^state-[a-f0-9-]{36}\.tmp$/.test(basename(path));
}

// Keep real FileHandles, including sync/close and identity checks. Only the
// exclusive temporary's write is intercepted; every read uses the genuine fs.
function mockWrites(t: test.TestContext, intercept: (path: unknown, data: unknown, write: () => Promise<void>) => Promise<void>) {
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await realFs.open(...args);
    if (args[1] === 'wx') {
      assert.equal(args[2], 0o600);
      const write = handle.writeFile.bind(handle);
      t.mock.method(handle, 'writeFile', async (...data: Parameters<typeof handle.writeFile>) =>
        intercept(args[0], data[0], () => write(...data)));
    }
    return handle;
  });
  syncBuiltinESMExports();
}

function injectedFailure(directory: string, code: unknown) {
  return Object.assign(new Error(`private fault message ${directory}/private-journal.json`), {
    code, path: join(directory, 'private-journal.json'), dest: join(directory, 'private-index.json')
  });
}

const faults: { phase: Phase; code: unknown; publicCode: string }[] = [
  { phase: 'write', code: 'ENOSPC', publicCode: 'ENOSPC' },
  { phase: 'write', code: 'EIO', publicCode: 'EIO' },
  { phase: 'write', code: 'EMFILE', publicCode: 'EMFILE' },
  { phase: 'replace', code: 'EACCES', publicCode: 'EACCES' },
  { phase: 'replace', code: 'EBUSY', publicCode: 'EBUSY' },
  { phase: 'replace', code: 'EPERM', publicCode: 'EPERM' },
  { phase: 'path-check', code: 'EPERM', publicCode: 'EPERM' },
  { phase: 'path-check', code: 'OUTPUT_PATH', publicCode: 'OUTPUT_PATH' },
  { phase: 'write', code: 'E_PRIVATE:/secret/path\nraw', publicCode: 'UNKNOWN' },
  { phase: 'replace', code: 13, publicCode: 'UNKNOWN' },
  { phase: 'path-check', code: undefined, publicCode: 'UNKNOWN' }
];

for (const fault of faults) {
  test(`asset persistence startup redacts ${fault.phase}/${fault.publicCode} and releases ownership`, serial, async t => {
    const f = await fixture(t), injected = injectedFailure(f.directory, fault.code);
    let writes = 0, replacements = 0, checks = 0;
    t.mock.method(fs, 'lstat', async (...args: Parameters<typeof fs.lstat>) => {
      if (fault.phase === 'path-check' && args[0] === join(f.outputRoot, 'index.json')) {
        checks++;
        throw injected;
      }
      return realFs.lstat(...args);
    });
    mockWrites(t, async (path, _data, write) => {
      if (indexTemporary(f.outputRoot, path)) {
        writes++;
        if (fault.phase === 'write') throw injected;
      }
      return write();
    });
    t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
      if (args[1] === join(f.outputRoot, 'index.json')) {
        replacements++;
        assert.ok(indexTemporary(f.outputRoot, args[0]));
        if (fault.phase === 'replace') throw injected;
      }
      return realFs.rename(...args);
    });
    syncBuiltinESMExports();

    await assert.rejects(f.open, persistence(fault.phase, fault.publicCode));
    assert.equal(writes, fault.phase === 'path-check' ? 0 : 1);
    const lock = fault.code === 'EBUSY' || fault.code === 'EPERM';
    assert.equal(replacements, fault.phase === 'replace' ? (lock && process.platform === 'win32' ? 4 : 1) : 0);
    assert.ok(replacements <= 4, 'Permanent sharing locks have a fixed four-attempt upper limit.');
    if (fault.phase === 'path-check') assert.ok(checks > 0, 'The real noLinks guard must use the patched lstat.');
    await f.retained();
    assert.deepEqual(await realFs.readFile(join(f.outputRoot, 'index.json')), f.index);
    const directories = (await realFs.readdir(f.outputRoot, { withFileTypes: true })).filter(d => d.isDirectory());
    assert.deepEqual(directories.map(d => d.name), [basename(f.jobDirectory)], 'Startup failure must never replay retained jobs.');

    f.restore();
    const reopened = await f.open();
    assert.deepEqual(reopened.jobs().map(j => [j.jobId, j.state]), [[JOB_ID, 'failed']]);
    await f.retained();
    await reopened.close();
  });
}

test('asset persistence rejects start only after its cancelled job settles, latches the first fault and preserves journals', serial, async t => {
  const f = await fixture(t), service = await f.open();
  const originalIndex = await realFs.readFile(join(f.outputRoot, 'index.json'));
  const journalEntered = f.gate(), journalRelease = f.gate(), indexFailed = f.gate();
  let firstJournal = true, failIndex = true, writes = 0;
  mockWrites(t, async (path, _data, write) => {
    if (typeof path === 'string' && dirname(path) !== f.outputRoot && basename(path).startsWith('state-') && firstJournal) {
      firstJournal = false; journalEntered.release(); await journalRelease.promise;
    }
    if (indexTemporary(f.outputRoot, path)) {
      writes++;
      if (failIndex) { indexFailed.release(); throw injectedFailure(f.directory, writes === 1 ? 'ENOSPC' : 'EACCES'); }
    }
    return write();
  });
  syncBuiltinESMExports();
  let startSettled = false;
  const starting = service.start({ template: 'hero-prop', name: 'cancelled-by-persistence' });
  const rejected = assert.rejects(starting, persistence('write', 'ENOSPC')).finally(() => { startSettled = true; });
  await Promise.all([journalEntered.promise, indexFailed.promise]);
  await nextTurn();
  assert.equal(startSettled, false, 'A failed start still owns its cancelled pipeline until completion.');
  const closing = assert.rejects(service.close(), persistence('write', 'ENOSPC'));
  await assert.rejects(f.open, errorCode('BUSY'));
  journalRelease.release();
  await Promise.all([rejected, closing]);
  assert.equal(writes, 1, 'The failure latch suppresses later queued index replacements.');
  await f.retained();
  assert.deepEqual(await realFs.readFile(join(f.outputRoot, 'index.json')), originalIndex);
  const cancelled = service.jobs().find(j => j.jobId !== JOB_ID);
  assert.ok(cancelled);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.error?.code, 'CANCELLED');
  const cancelledJournal = await realFs.readFile(join(cancelled.directory, 'job.json'));
  assert.equal(JSON.parse(cancelledJournal.toString()).state, 'cancelled');
  assert.equal(JSON.parse(cancelledJournal.toString()).error.code, 'CANCELLED');
  failIndex = false;
  f.restore();
  const reopened = await f.open();
  assert.equal(reopened.jobs().length, 2, 'Close must release root ownership even when flushing fails.');
  assert.deepEqual(await realFs.readFile(join(cancelled.directory, 'job.json')), cancelledJournal);
  await f.retained();
  await reopened.close();
});

test('asset persistence remains latched after filesystem recovery without creating or replaying another job', serial, async t => {
  const f = await fixture(t), service = await f.open();
  let fail = true, writes = 0;
  mockWrites(t, async (path, _data, write) => {
    if (indexTemporary(f.outputRoot, path)) {
      writes++;
      if (fail) throw injectedFailure(f.directory, writes === 1 ? 'EIO' : 'ENOSPC');
    }
    return write();
  });
  syncBuiltinESMExports();
  await assert.rejects(() => service.start({ template: 'hero-prop', name: 'first-fault' }), persistence('write', 'EIO'));
  const attempted = service.jobs().find(j => j.jobId !== JOB_ID);
  assert.ok(attempted);
  // This rejected admission drains the queued completion snapshot before the
  // filesystem heals. It cannot reach the pipeline while the latch is set.
  await assert.rejects(() => service.start({ template: 'hero-prop', name: 'latched-drain' }), persistence('write', 'EIO'));
  const jobs = service.jobs(), before = await realFs.readdir(f.outputRoot), beforeWrites = writes;
  const journal = await realFs.readFile(join(attempted.directory, 'job.json'));
  fail = false;
  for (const name of ['after-recovery-one', 'after-recovery-two']) {
    await assert.rejects(() => service.start({ template: 'hero-prop', name }), persistence('write', 'EIO'));
  }
  assert.equal(writes, beforeWrites, 'A healed filesystem cannot reset the latch or schedule job replay.');
  assert.deepEqual(service.jobs(), jobs);
  assert.deepEqual(await realFs.readdir(f.outputRoot), before);
  assert.deepEqual(await realFs.readFile(join(attempted.directory, 'job.json')), journal);
  await f.retained();
  await assert.rejects(service.close(), persistence('write', 'EIO'));
  f.restore();
  const reopened = await f.open();
  assert.equal(reopened.jobs().length, jobs.length);
  assert.deepEqual(await realFs.readFile(join(attempted.directory, 'job.json')), journal);
  await reopened.close();
});

for (const fail of [false, true]) {
  test(`terminal cancel awaits queued persistence after active removal (${fail ? 'write failure' : 'successful write'})`, serial, async t => {
    const f = await fixture(t), service = await f.open();
    const journalEntered = f.gate(), journalRelease = f.gate(), indexEntered = f.gate(), indexRelease = f.gate();
    let blockedJournal = false, blockedIndex = false;
    const snapshots: string[] = [];
    mockWrites(t, async (path, data, write) => {
      if (indexTemporary(f.outputRoot, path)) {
        snapshots.push(String(data));
        const snapshot = JSON.parse(String(data)) as { jobs: { events: { stage: string }[] }[] };
        if (snapshot.jobs.some(j => j.events.some(e => e.stage === 'complete'))) {
          if (!blockedIndex) { blockedIndex = true; indexEntered.release(); await indexRelease.promise; }
          if (fail) throw injectedFailure(f.directory, 'EIO');
        }
      } else if (!blockedJournal && typeof path === 'string' && basename(path).startsWith('state-')) {
        blockedJournal = true; journalEntered.release(); await journalRelease.promise;
      }
      return write();
    });
    syncBuiltinESMExports();
    const starting = service.start({ template: 'hero-prop', name: 'terminal-with-pending-index' });
    await journalEntered.promise;
    const job = await starting;
    journalRelease.release();
    await indexEntered.promise;
    await nextTurn();
    const terminal = service.jobs().find(j => j.jobId === job.jobId);
    assert.ok(terminal);
    assert.equal(terminal.state, 'failed');
    assert.equal(terminal.stage, 'complete', 'Completion has updated the terminal record before cancel admission.');
    assert.equal(terminal.error?.code, 'BLENDER_UNAVAILABLE');
    const journal = await realFs.readFile(join(job.directory, 'job.json'));
    let settled = false;
    const cancellation = service.cancel(job.jobId).then(
      value => { settled = true; return { value, error: null as unknown }; },
      error => { settled = true; return { value: null, error: error as unknown }; }
    );
    try {
      await nextTurn();
      assert.equal(settled, false, 'Terminal cancel must wait even after the active handle was removed.');
    } finally { indexRelease.release(); }
    const outcome = await cancellation;
    if (fail) persistence('write', 'EIO')(outcome.error);
    else {
      assert.equal(outcome.error, null); assert.deepEqual(outcome.value, terminal);
      const index = JSON.parse(await realFs.readFile(join(f.outputRoot, 'index.json'), 'utf8'));
      assert.deepEqual(index.jobs.find((j: { jobId: string }) => j.jobId === job.jobId).events, terminal.events);
    }
    assert.deepEqual(terminal.events.map(e => [e.stage, e.state]), [['probe', 'running'], ['complete', 'failed']]);
    assert.equal(snapshots.length, 3, 'Admission, probe and terminal events each queue one distinct snapshot.');
    assert.equal(new Set(snapshots).size, snapshots.length, 'Completion cannot replace byte-identical observed event history.');
    assert.deepEqual(await realFs.readFile(join(job.directory, 'job.json')), journal);
    await f.retained();
    if (fail) await assert.rejects(service.close(), persistence('write', 'EIO'));
    else await service.close();
    f.restore();
    const reopened = await f.open();
    assert.equal(reopened.jobs().length, 2);
    if (!fail) assert.deepEqual(reopened.jobs().find(j => j.jobId === job.jobId)?.events, terminal.events);
    assert.deepEqual(await realFs.readFile(join(job.directory, 'job.json')), journal);
    await reopened.close();
  });
}

test('start drains an event tail queued behind its blocked index write and coalesces completion', serial, async t => {
  const f = await fixture(t), service = await f.open();
  const indexEntered = f.gate(), indexRelease = f.gate(), journalEntered = f.gate(), journalRelease = f.gate();
  const terminalJournal = f.gate(), terminalIndex = f.gate(), terminalRelease = f.gate();
  let blockedJournal = false;
  const snapshots: string[] = [];
  mockWrites(t, async (path, data, write) => {
    if (indexTemporary(f.outputRoot, path)) {
      snapshots.push(String(data));
      if (snapshots.length === 1) { indexEntered.release(); await indexRelease.promise; }
      const snapshot = JSON.parse(String(data)) as { jobs: { events: { stage: string }[] }[] };
      if (snapshot.jobs.some(j => j.events.some(e => e.stage === 'complete'))) {
        terminalIndex.release(); await terminalRelease.promise;
      }
    } else if (!blockedJournal && typeof path === 'string' && basename(path).startsWith('state-')) {
      blockedJournal = true; journalEntered.release(); await journalRelease.promise;
    }
    return write();
  });
  t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    await realFs.rename(...args);
    if (typeof args[1] === 'string' && basename(args[1]) === 'job.json') {
      const journal = JSON.parse(await realFs.readFile(args[1], 'utf8'));
      if (journal.state === 'failed') terminalJournal.release();
    }
  });
  syncBuiltinESMExports();
  let settled = false;
  const starting = service.start({ template: 'hero-prop', name: 'growing-history-tail' }).then(
    value => { settled = true; return { value, error: null as unknown }; },
    error => { settled = true; return { value: null, error: error as unknown }; }
  );
  await Promise.all([indexEntered.promise, journalEntered.promise]);
  journalRelease.release();
  await terminalJournal.promise;
  await nextTurn();
  assert.equal(service.jobs().find(j => j.jobId !== JOB_ID)?.stage, 'complete');
  indexRelease.release();
  await terminalIndex.promise;
  try {
    await nextTurn();
    assert.equal(settled, false, 'flushed() must follow the new tail instead of settling with its captured first write.');
  } finally { terminalRelease.release(); }
  const outcome = await starting;
  assert.equal(outcome.error, null); assert.ok(outcome.value);
  assert.equal(outcome.value.state, 'failed');
  assert.equal(outcome.value.error?.code, 'BLENDER_UNAVAILABLE');
  await service.close();
  assert.equal(snapshots.length, 3);
  assert.equal(new Set(snapshots).size, 3, 'Terminal completion must coalesce the event-identical final snapshot.');
  const index = JSON.parse(await realFs.readFile(join(f.outputRoot, 'index.json'), 'utf8'));
  const observed = index.jobs.find((j: { jobId: string }) => j.jobId === outcome.value!.jobId);
  assert.deepEqual(Object.keys(observed).sort(), ['events', 'jobId']);
  assert.deepEqual(observed.events, outcome.value.events);
  await f.retained();
  const reopened = await f.open();
  assert.deepEqual(reopened.jobs().find(j => j.jobId === outcome.value!.jobId)?.events, outcome.value.events);
  await reopened.close();
});

test('concurrent asset starts admit one job while its genuine journal write is blocked', serial, async t => {
  const f = await fixture(t), service = await f.open();
  const entered = f.gate(), release = f.gate();
  let blocked = false;
  mockWrites(t, async (path, _data, write) => {
    if (!blocked && typeof path === 'string' && dirname(path) !== f.outputRoot && basename(path).startsWith('state-')) {
      blocked = true; entered.release(); await release.promise;
    }
    return write();
  });
  syncBuiltinESMExports();
  const first = service.start({ template: 'hero-prop', name: 'admitted' });
  const second = assert.rejects(() => service.start({ template: 'hero-prop', name: 'must-stay-busy' }), errorCode('BUSY'));
  await entered.promise;
  const job = await first;
  await second;
  assert.equal(job.state, 'running');
  assert.equal(service.jobs().length, 2);
  const closing = service.close();
  await assert.rejects(f.open, errorCode('BUSY'));
  release.release();
  await closing;
  const journal = JSON.parse(await realFs.readFile(join(job.directory, 'job.json'), 'utf8'));
  assert.equal(journal.state, 'cancelled');
  assert.equal(journal.error.code, 'CANCELLED');
  await f.retained();
  const reopened = await f.open();
  assert.equal(reopened.jobs().length, 2);
  await reopened.close();
});

test('close callers share the persistence barrier and a waiting start cannot cross closure', serial, async t => {
  const f = await fixture(t), service = await f.open();
  const indexEntered = f.gate(), indexRelease = f.gate(), journalEntered = f.gate(), journalRelease = f.gate();
  let blockedIndex = false, blockedJournal = false, indexWrites = 0, replacements = 0;
  mockWrites(t, async (path, _data, write) => {
    if (indexTemporary(f.outputRoot, path)) indexWrites++;
    else if (!blockedJournal && typeof path === 'string' && basename(path).startsWith('state-')) {
      blockedJournal = true; journalEntered.release(); await journalRelease.promise;
    }
    return write();
  });
  t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (args[1] === join(f.outputRoot, 'index.json')) {
      replacements++;
      if (!blockedIndex) { blockedIndex = true; indexEntered.release(); await indexRelease.promise; }
    }
    return realFs.rename(...args);
  });
  syncBuiltinESMExports();
  const starting = service.start({ template: 'hero-prop', name: 'owned-before-close' });
  await Promise.all([indexEntered.promise, journalEntered.promise]);
  const waiting = assert.rejects(() => service.start({ template: 'hero-prop', name: 'waiting-before-close' }), errorCode('CLOSED'));
  let firstClosed = false, secondClosed = false;
  const firstClose = service.close().then(() => { firstClosed = true; });
  const secondClose = service.close().then(() => { secondClosed = true; });
  try {
    await nextTurn();
    assert.equal(firstClosed, false);
    assert.equal(secondClosed, false, 'Every close caller must wait for the owned work and index flush.');
    await assert.rejects(f.open, errorCode('BUSY'));
    assert.equal(indexWrites, 1, 'Queued history snapshots cannot overtake a blocked replacement.');
  } finally {
    indexRelease.release(); journalRelease.release();
    await Promise.allSettled([starting, waiting, firstClose, secondClose]);
  }
  await Promise.all([starting, waiting, firstClose, secondClose]);
  assert.equal(firstClosed, true); assert.equal(secondClosed, true);
  assert.equal(indexWrites, replacements, 'Close must drain every successfully queued index snapshot.');
  assert.equal(service.jobs().length, 2);
  assert.throws(() => service.jobPage(), errorCode('CLOSED'));
  await assert.rejects(() => service.start({ template: 'hero-prop', name: 'after-close' }), errorCode('CLOSED'));
  await f.retained();
  const reopened = await f.open();
  assert.equal(reopened.jobs().length, 2);
  await reopened.close();
});
