import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createAssetService } from '../../apps/daemon/src/asset-service.js';
import type { AssetService, AssetStartAdmission } from '../../apps/daemon/src/asset-service.js';
import { AssetError, AssetPipeline, normalizeRequest } from '../../packages/asset-pipeline/src/index.js';
import { noLinks, within } from '../../packages/asset-pipeline/src/paths.js';
import { ArcaneError } from '../../packages/protocol/src/providers.js';

// Builtin mocks require serial tests in node --test's default isolated process.
// Use the exact service/pipeline, real journals and the existing worker-root seam.
// Explicit missing executables plus a process double prohibit native launches.
const serial = { concurrency: false, timeout: 10000 };
const realFs = { ...fs }, realStart = AssetPipeline.prototype.start;
const input = { template: 'hero-prop' as const, name: 'admitted' };
const code = (expected: string) => (error: unknown) =>
  (error instanceof ArcaneError || error instanceof AssetError) && error.code === expected;

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function fixture(t: test.TestContext) {
  const temporaryRoot = await realFs.realpath(tmpdir());
  const directory = await realFs.mkdtemp(join(temporaryRoot, 'arcane-asset-admission-'));
  const outputRoot = join(directory, 'assets'), workerRoot = join(directory, 'worker');
  await realFs.mkdir(workerRoot);
  await realFs.writeFile(join(workerRoot, 'probe.py'), '# inert fixture; never executed\n');
  const options = { cwd: resolve(process.cwd()), outputRoot, workerRoot,
    blenderExecutable: join(directory, 'missing-blender.exe'), pythonExecutable: join(directory, 'missing-python.exe') };
  const services: AssetService[] = [], gates: ReturnType<typeof barrier>[] = [], order: string[] = [];
  const starts = t.mock.method(AssetPipeline.prototype, 'start', function (this: AssetPipeline, ...args: Parameters<typeof realStart>) {
    order.push('pipeline.start');
    return realStart.apply(this, args);
  });
  const spawn = t.mock.method(childProcess, 'spawn', () => { throw new Error('No native process is permitted.'); });
  syncBuiltinESMExports();
  t.after(async () => {
    for (const gate of gates) gate.release();
    try {
      for (const service of services) {
        try { await service.close(); } catch (error) { assert.ok(code('PERSISTENCE')(error)); }
      }
      assert.equal(spawn.mock.callCount(), 0);
    } finally {
      t.mock.restoreAll(); syncBuiltinESMExports();
      assert.ok(directory !== temporaryRoot && within(temporaryRoot, directory));
      await noLinks(directory);
      await realFs.rm(directory, { recursive: true, force: true });
    }
  });
  async function open() { const service = await createAssetService(options); services.push(service); return service; }
  return { directory, outputRoot, order, starts, open,
    gate() { const gate = barrier(); gates.push(gate); return gate; } };
}

function indexTemporary(outputRoot: string, path: unknown) {
  return typeof path === 'string' && dirname(path) === outputRoot && /^state-[a-f0-9-]{36}\.tmp$/.test(basename(path));
}

// Keep genuine handles and all path, sync, identity and replacement checks.
function mockWrites(t: test.TestContext, intercept: (path: unknown, data: unknown, write: () => Promise<void>) => Promise<void>) {
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await realFs.open(...args);
    if (args[1] === 'wx') {
      const write = handle.writeFile.bind(handle);
      t.mock.method(handle, 'writeFile', async (...data: Parameters<typeof handle.writeFile>) => intercept(args[0], data[0], () => write(...data)));
    }
    return handle;
  });
  syncBuiltinESMExports();
}

test('admission runs directly before creation and witnesses once before any queued persistence', serial, async t => {
  const f = await fixture(t), service = await f.open();
  let witnessed = '', writes = 0;
  mockWrites(t, async (_path, _data, write) => { writes++; assert.ok(witnessed); return write(); });
  const admission: AssetStartAdmission = {
    beforeCreate() { f.order.push('beforeCreate'); queueMicrotask(() => f.order.push('microtask')); },
    created(jobId) {
      f.order.push('created'); witnessed = jobId;
      assert.equal(writes, 0);
      assert.equal(service.jobs()[0]?.jobId, jobId);
    }
  };
  const job = await service.start(input, admission);
  assert.deepEqual(f.order, ['beforeCreate', 'pipeline.start', 'created', 'microtask']);
  assert.equal(job.jobId, witnessed); assert.equal(f.starts.mock.callCount(), 1);
  await service.cancel(witnessed);
  assert.equal(f.order.filter(step => step === 'created').length, 1);
});

test('revocation while an actual terminal history flush is queued causes zero additional starts', serial, async t => {
  const f = await fixture(t), service = await f.open();
  const journalEntered = f.gate(), journalRelease = f.gate(), indexEntered = f.gate(), indexRelease = f.gate();
  let firstJournal = true;
  mockWrites(t, async (path, data, write) => {
    if (typeof path === 'string' && dirname(path) !== f.outputRoot && basename(path).startsWith('state-') && firstJournal) {
      firstJournal = false; journalEntered.release(); await journalRelease.promise;
    }
    if (indexTemporary(f.outputRoot, path) && String(data).includes('"stage": "complete"')) {
      indexEntered.release(); await indexRelease.promise;
    }
    return write();
  });
  const first = service.start({ ...input, name: 'prior' });
  await journalEntered.promise; await first; journalRelease.release();
  await indexEntered.promise; await nextTurn();
  assert.equal(service.jobs()[0]?.stage, 'complete', 'The previous active slot has been cleaned up.');
  const directories = async () => (await realFs.readdir(f.outputRoot, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name);
  const before = await directories(), denied = new ArcaneError('REVOKED', 'Authority was revoked.');
  let revoked = false, checks = 0, witnesses = 0, settled = false;
  const rejected = assert.rejects(service.start(input, {
    beforeCreate() { checks++; assert.ok(revoked); throw denied; },
    created() { witnesses++; }
  }), error => error === denied).then(() => { settled = true; });
  await nextTurn(); assert.equal(checks, 0); assert.equal(settled, false);
  revoked = true; indexRelease.release(); await rejected;
  assert.equal(checks, 1); assert.equal(witnesses, 0); assert.equal(f.starts.mock.callCount(), 1);
  assert.deepEqual(await directories(), before); assert.equal(service.jobs().length, 1);
});

for (const callbackThrows of [false, true]) {
  test(`created ID and owned outcome survive a later persistence failure (callback throws: ${callbackThrows})`, serial, async t => {
    const f = await fixture(t), service = await f.open();
    const originalIndex = await realFs.readFile(join(f.outputRoot, 'index.json'));
    const journalEntered = f.gate(), journalRelease = f.gate(), indexFailed = f.gate();
    let firstJournal = true, fail = true, witnessed = '', witnesses = 0, settled = false;
    mockWrites(t, async (path, _data, write) => {
      if (typeof path === 'string' && dirname(path) !== f.outputRoot && basename(path).startsWith('state-') && firstJournal) {
        firstJournal = false; journalEntered.release(); await journalRelease.promise;
      }
      if (indexTemporary(f.outputRoot, path) && fail) {
        assert.ok(witnessed); indexFailed.release(); throw Object.assign(new Error('Injected write failure'), { code: 'ENOSPC' });
      }
      return write();
    });
    const rejected = assert.rejects(service.start(input, {
      beforeCreate() {},
      created(jobId) { witnessed = jobId; witnesses++; if (callbackThrows) throw new ArcaneError('REVOKED', 'Too late for a safe rejection.'); }
    }), error => {
      assert.ok(code(callbackThrows ? 'ADMISSION_CREATED' : 'PERSISTENCE')(error));
      if (callbackThrows) assert.match((error as Error).message, new RegExp(witnessed));
      return true;
    }).then(() => { settled = true; });
    await Promise.all([journalEntered.promise, indexFailed.promise]); await nextTurn();
    assert.equal(settled, false, 'The cancelled worker must settle before a persistence failure is returned.');
    assert.equal(service.jobs()[0]?.jobId, witnessed);
    await assert.rejects(f.open, code('BUSY'));
    journalRelease.release(); await rejected;
    const retained = service.jobs()[0]!;
    assert.equal(retained.state, 'cancelled'); assert.equal(retained.error?.code, 'CANCELLED');
    const journal = await realFs.readFile(join(retained.directory, 'job.json'));
    assert.equal(JSON.parse(journal.toString()).jobId, witnessed);
    assert.equal(JSON.parse(journal.toString()).state, retained.state);
    assert.deepEqual(await realFs.readFile(join(f.outputRoot, 'index.json')), originalIndex);
    await assert.rejects(() => service.start({ ...input, name: 'no-replay' }), code('PERSISTENCE'));
    assert.equal(f.starts.mock.callCount(), 1); assert.equal(witnesses, 1);
    await assert.rejects(service.close(), code('PERSISTENCE'));
    fail = false;
    const reopened = await f.open();
    assert.equal(reopened.jobs()[0]?.jobId, witnessed); assert.equal(reopened.jobs()[0]?.state, 'cancelled');
    assert.deepEqual(await realFs.readFile(join(retained.directory, 'job.json')), journal);
  });
}

test('a throwing created callback retains active supervision, persistence, cancellation and future admission', serial, async t => {
  const f = await fixture(t), service = await f.open(), entered = f.gate(), release = f.gate();
  let block = true, witnessed = '';
  mockWrites(t, async (path, _data, write) => {
    if (block && typeof path === 'string' && dirname(path) !== f.outputRoot && basename(path).startsWith('state-')) {
      block = false; entered.release(); await release.promise;
    }
    return write();
  });
  await assert.rejects(service.start(input, {
    beforeCreate() {}, created(jobId) { witnessed = jobId; throw new ArcaneError('REVOKED', 'Already created.'); }
  }), error => code('ADMISSION_CREATED')(error) && (error as Error).message.includes(witnessed));
  await entered.promise;
  assert.equal(service.jobs()[0]?.jobId, witnessed);
  const index = JSON.parse(await realFs.readFile(join(f.outputRoot, 'index.json'), 'utf8'));
  assert.equal(index.jobs[0].jobId, witnessed);
  await assert.rejects(() => service.start({ ...input, name: 'still-busy' }), code('BUSY'));
  let settled = false;
  const cancelling = service.cancel(witnessed).then(job => { settled = true; return job; });
  await nextTurn(); assert.equal(settled, false);
  release.release(); assert.equal((await cancelling).state, 'cancelled');
  const later = await service.start({ ...input, name: 'later' });
  await service.cancel(later.jobId); assert.equal(f.starts.mock.callCount(), 2);
  await service.close();
  const reopened = await f.open();
  assert.equal(reopened.jobs().find(job => job.jobId === witnessed)?.state, 'cancelled');
});

test('close called inside a throwing created callback sees installed cleanup and releases ownership', serial, async t => {
  const f = await fixture(t), service = await f.open();
  let closing: Promise<void> | undefined, witnessed = '';
  await assert.rejects(service.start(input, {
    beforeCreate() {}, created(jobId) { witnessed = jobId; closing = service.close(); throw new Error('Witness failed.'); }
  }), code('ADMISSION_CREATED'));
  assert.ok(closing); await closing;
  assert.equal(service.jobs()[0]?.state, 'cancelled');
  const reopened = await f.open(); assert.equal(reopened.jobs()[0]?.jobId, witnessed);
  const later = await reopened.start({ ...input, name: 'after-close' }); await reopened.cancel(later.jobId);
});

for (const kind of ['promise', 'function-thenable'] as const) {
  test(`thenable callback returns are rejected synchronously (${kind})`, serial, async t => {
    const f = await fixture(t), service = await f.open();
    let consumed = 0, witnesses = 0;
    const result = kind === 'promise' ? Promise.resolve() : Object.assign(() => {}, { then() { consumed++; } });
    await assert.rejects(() => service.start(input, {
      beforeCreate() { return result; }, created() { witnesses++; }
    }), code('ADMISSION_ASYNC'));
    assert.equal(f.starts.mock.callCount(), 0); assert.equal(service.jobs().length, 0); assert.equal(witnesses, 0);
    await assert.rejects(() => service.start(input, {
      beforeCreate() {}, created() { witnesses++; return result; }
    }), code('ADMISSION_CREATED'));
    assert.equal(f.starts.mock.callCount(), 1); assert.equal(witnesses, 1); assert.equal(consumed, 0);
    await service.cancel(service.jobs()[0]!.jobId);
  });
}

test('generic starts and existing input, busy and closed guards do not acquire admission callbacks', serial, async t => {
  const f = await fixture(t), service = await f.open();
  let calls = 0;
  const admission = { beforeCreate() { calls++; }, created() { calls++; } };
  for (const extra of [{ admission }, { beforeCreate: admission.beforeCreate }, { created: admission.created }, { admission: { beforeCreate: 'untrusted JSON' } }]) {
    await assert.rejects(() => service.start({ ...input, ...extra }, admission), code('INPUT'));
  }
  assert.equal(calls, 0); assert.equal(f.starts.mock.callCount(), 0);
  const entered = f.gate(), release = f.gate(); let block = true;
  mockWrites(t, async (path, _data, write) => {
    if (block && typeof path === 'string' && dirname(path) !== f.outputRoot && basename(path).startsWith('state-')) {
      block = false; entered.release(); await release.promise;
    }
    return write();
  });
  const starting = service.start(input); await entered.promise; const job = await starting;
  await assert.rejects(() => service.start({ ...input, name: 'busy' }, admission), code('BUSY'));
  release.release();
  const terminal = await service.cancel(job.jobId);
  assert.equal(terminal.state, 'cancelled'); assert.equal(calls, 0); assert.equal(f.starts.mock.callCount(), 1);
  await service.close();
  await assert.rejects(() => service.start(input, admission), code('CLOSED')); assert.equal(calls, 0);
});

test('a worker status check mid-commit refuses start before admission; a resolved check then admits exactly once', serial, async t => {
  const f = await fixture(t);
  const jobId = '43333333-4444-4444-8444-444444444444', jobDir = join(f.outputRoot, 'lost-' + jobId);
  await realFs.mkdir(jobDir, { recursive: true });
  await realFs.writeFile(join(jobDir, 'job.json'), JSON.stringify({ schemaVersion: 1, jobId, state: 'interrupted', directory: '/outside', error: null,
    request: normalizeRequest({ template: 'hero-prop', name: 'lost' }),
    workers: [{ schemaVersion: 1, role: 'probe', reservationId: '00000000-0000-4000-8000-000000000001', reservedAt: '2026-10-16T02:00:01.0000000Z',
      state: 'closed', closure: 'exit-observed', closedAt: '2026-10-16T02:00:02.0000000Z', identity: null }] }));
  const service = await f.open();
  const gate = f.gate(); let gated = false;
  mockWrites(t, async (path, _data, write) => { if (dirname(String(path)) === jobDir) { gated = true; await gate.promise; } return write(); });
  let checks = 0;
  const admission: AssetStartAdmission = { beforeCreate() { checks++; }, created() {} };
  await assert.rejects(service.start(input, admission), code('RECONCILIATION'));
  assert.equal(checks, 0);
  const resolving = service.resolveInterrupted(jobId);
  while (!gated) await nextTurn();
  await assert.rejects(service.start(input, admission), code('BUSY'));
  assert.equal(checks, 0, 'no admission callback while the check holds the operation');
  gate.release();
  assert.equal((await resolving).status, 'resolved');
  const job = await service.start(input, admission);
  assert.equal(checks, 1); assert.equal(f.starts.mock.callCount(), 1);
  await service.cancel(job.jobId);
});
