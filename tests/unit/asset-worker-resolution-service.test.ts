import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import fsp, { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createAssetService, type AssetService, type AssetServiceOptions } from '../../apps/daemon/src/asset-service.js';
import { AssetError, normalizeRequest } from '../../packages/asset-pipeline/src/index.js';
import { AtomicJsonFailure, atomicAssetJson } from '../../packages/asset-pipeline/src/atomic-json.js';
import type { ProcessQueryHost } from '../../packages/asset-pipeline/src/worker-identity.js';
import { ArcaneError } from '../../packages/protocol/src/providers.js';
import { assetJob } from '../../apps/mcp/src/asset-schemas.js';

// Real journals/markers in OS temp, the exact service, a synthetic fixed-PID query host and a synthetic
// marker writer for commit faults. Native launches are prohibited; no CIM/PowerShell, Blender, provider or Studio.
const serial = { concurrency: false, timeout: 20000 };
const BLENDER = 'C:\\Program Files\\Blender Foundation\\Blender 4.2\\blender.exe';
const T = (n: number) => '2026-10-16T02:00:' + String(n).padStart(2, '0') + '.0000000Z';
const rid = (n: number) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const code = (expected: string) => (error: unknown) => (error instanceof ArcaneError || error instanceof AssetError) && error.code === expected;
const request = normalizeRequest({ template: 'hero-prop', name: 'lost' });
type Mode = 'absent' | 'reused' | 'live' | 'malformed' | 'gate';

function queryHost(mode: (pid: number) => Mode) {
  const stats = { calls: 0, gates: [] as (() => void)[] };
  const host: ProcessQueryHost = { platform: 'win32', systemRoot: 'C:\\Windows', execFile: (_f, _a, options, callback) => {
    stats.calls++;
    const pid = Number(options.env.ARCANE_WORKER_PID), m = mode(pid), n = pid - 7000;
    const answer = () => callback(null, m === 'malformed' ? 'garbage C:\\Users\\private' : JSON.stringify(m === 'live'
      ? { v: 2, found: true, pid, created: T(n), executable: BLENDER } : m === 'reused'
        ? { v: 2, found: true, pid, created: T(n + 30), executable: 'C:\\Windows\\notepad.exe' } : { v: 2, found: false }), '');
    if (m === 'gate') stats.gates.push(answer); else queueMicrotask(answer);
    return undefined;
  } };
  return { host, stats };
}
const closed = (n: number) => ({ schemaVersion: 1, role: 'probe', reservationId: rid(n), reservedAt: T(n), state: 'closed', closure: 'exit-observed', closedAt: T(n + 1), identity: null });
const captured = (n: number) => ({ schemaVersion: 1, role: 'generate', reservationId: rid(n), reservedAt: T(n), state: 'captured',
  identity: { schemaVersion: 2, role: 'generate', pid: 7000 + n, processCreatedAt: T(n), executable: BLENDER } });

async function fixture(t: test.TestContext) {
  const base = await realpath(tmpdir()), root = await mkdtemp(join(base, 'arcane-resolution-service-'));
  const outputRoot = join(root, 'assets'), workerRoot = join(root, 'worker');
  await mkdir(outputRoot); await mkdir(workerRoot); await writeFile(join(workerRoot, 'probe.py'), '# inert fixture\n');
  const spawn = t.mock.method(childProcess, 'spawn', () => { throw new Error('No native process is permitted.'); }); syncBuiltinESMExports();
  const services: AssetService[] = [];
  t.after(async () => {
    for (const service of services) await service.close().catch(() => undefined);
    spawn.mock.restore(); syncBuiltinESMExports();
    const actual = await realpath(root), child = relative(base, actual);
    assert.ok(!isAbsolute(child) && child.startsWith('arcane-resolution-service-') && !child.includes(sep) && !child.includes('..'));
    await rm(actual, { recursive: true, force: true });
  });
  const seed = async (workers?: unknown[], jobId = '44444444-4444-4444-8444-444444444444') => {
    const directory = join(outputRoot, 'lost-' + jobId); await mkdir(directory);
    await writeFile(join(directory, 'job.json'), JSON.stringify({ schemaVersion: 1, jobId, directory: '/outside', manifestPath: null, error: null,
      state: 'interrupted', request, startedAt: T(0), ...(workers === undefined ? {} : { workers }) }));
    return { jobId, directory };
  };
  const open = async (extra: Partial<AssetServiceOptions> = {}) => {
    const service = await createAssetService({ cwd: resolve(process.cwd()), outputRoot, workerRoot,
      blenderExecutable: join(root, 'missing-blender.exe'), pythonExecutable: join(root, 'missing-python.exe'), ...extra });
    services.push(service); return service;
  };
  const marker = async (directory: string) => { try { return JSON.parse(await readFile(join(directory, 'worker-resolution.json'), 'utf8')) as Record<string, unknown>; } catch { return null; } };
  return { root, outputRoot, seed, open, marker };
}
const flush = async () => { for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r)); };
/** Bounded wait for real file I/O to reach a synthetic gate. */
const until = async (condition: () => boolean) => { const end = Date.now() + 5000; while (!condition()) { if (Date.now() > end) throw new Error('fixture condition timed out'); await new Promise(r => setTimeout(r, 5)); } };
async function admittedAndSettled(service: AssetService) {
  const job = await service.start(request); await service.cancel(job.jobId); return job;
}

test('legacy, invalid and reserved journals stay fenced with no query and no marker', serial, async t => {
  const f = await fixture(t);
  for (const [label, workers] of [['legacy', undefined], ['invalid', [{ bogus: 1 }]], ['reserved', [{ schemaVersion: 1, role: 'generate', reservationId: rid(1), reservedAt: T(1), state: 'reserved' }]]] as const) {
    const jobId = '4444444' + ['1', '2', '3'][['legacy', 'invalid', 'reserved'].indexOf(label)] + '-4444-4444-8444-444444444444';
    await f.seed(workers as unknown[] | undefined, jobId);
  }
  const q = queryHost(() => 'absent'), service = await f.open({ workerQueryHost: q.host });
  for (const job of service.jobs()) {
    assert.equal(job.state, 'interrupted'); assert.equal(job.resolution, undefined);
    const outcome = await service.resolveInterrupted(job.jobId);
    assert.equal(outcome.status, 'refused');
    assert.ok(['no-workers-recorded', 'records-invalid', 'reservation-unresolved'].includes((outcome as { reason: string }).reason));
    assert.equal(await f.marker(job.directory), null);
  }
  assert.equal(q.stats.calls, 0);
  await assert.rejects(service.start(request), code('RECONCILIATION'));
});

test('all-closed workers resolve with zero queries; the job stays interrupted and only the fence is released', serial, async t => {
  const f = await fixture(t), job = await f.seed([closed(1), closed(3)]);
  const q = queryHost(() => 'live'), service = await f.open({ workerQueryHost: q.host });
  await assert.rejects(service.start(request), code('RECONCILIATION'));
  const outcome = await service.resolveInterrupted(job.jobId);
  assert.deepEqual({ ...outcome, resolvedAt: undefined }, { jobId: job.jobId, status: 'resolved', resolvedAt: undefined, evidence: ['closed-exit-observed', 'closed-exit-observed'], alreadyResolved: false });
  assert.equal(q.stats.calls, 0);
  const shown = service.jobs().find(j => j.jobId === job.jobId)!;
  assert.equal(shown.state, 'interrupted'); assert.equal(shown.manifestAvailable, false); assert.equal(shown.manifestPath, null); assert.equal(shown.resolution?.status, 'resolved');
  await assert.rejects(service.manifest(job.jobId), code('JOB_STATE'));
  assert.equal((JSON.parse(await readFile(join(job.directory, 'job.json'), 'utf8')) as { state: string }).state, 'interrupted');
  await admittedAndSettled(service);
});

test('restart restores a valid resolution without querying; a changed journal or marker re-fences live and on restart', serial, async t => {
  const f = await fixture(t), job = await f.seed([closed(1)]);
  let service = await f.open();
  await service.resolveInterrupted(job.jobId); await service.close();
  const q = queryHost(() => 'live');
  service = await f.open({ workerQueryHost: q.host });
  assert.equal(service.jobs()[0]!.resolution?.status, 'resolved'); assert.equal(q.stats.calls, 0);
  await admittedAndSettled(service);
  // A journal changed after startup: the in-memory display cannot keep stale permission to start.
  const path = join(job.directory, 'job.json'), original = await readFile(path);
  await writeFile(path, Buffer.concat([original, Buffer.from(' ')]));
  await assert.rejects(service.start(request), code('RECONCILIATION'));
  assert.equal(service.jobs().find(j => j.jobId === job.jobId)!.resolution?.status, 'invalid');
  await service.close();
  service = await f.open();
  assert.equal(service.jobs().find(j => j.jobId === job.jobId)!.resolution?.status, 'invalid');
  await assert.rejects(service.start(request), code('RECONCILIATION'));
  // Tampered marker against the restored journal is also refused.
  await writeFile(path, original);
  const marker = (await f.marker(job.directory))!;
  await writeFile(join(job.directory, 'worker-resolution.json'), JSON.stringify({ ...marker, basis: [{ ...(marker.basis as object[])[0], evidence: 'pid-absent' }] }));
  await assert.rejects(service.start(request), code('RECONCILIATION'));
});

test('exact identities: absent and reused resolve; live and unknown refuse without writing', serial, async t => {
  for (const [mode, expected] of [['absent', 'pid-absent'], ['reused', 'pid-reused'], ['live', 'same-worker-running'], ['malformed', 'output-malformed']] as const) {
    await t.test(mode, async t2 => {
      const f = await fixture(t2), job = await f.seed([closed(1), captured(5)]);
      const q = queryHost(() => mode), service = await f.open({ workerQueryHost: q.host });
      const outcome = await service.resolveInterrupted(job.jobId);
      assert.equal(q.stats.calls, 1);
      if (mode === 'absent' || mode === 'reused') {
        assert.equal(outcome.status, 'resolved'); assert.deepEqual((outcome as { evidence: readonly string[] }).evidence, ['closed-exit-observed', expected]);
        await admittedAndSettled(service);
      } else {
        assert.deepEqual(outcome, { jobId: job.jobId, status: 'refused', reason: expected });
        assert.equal(await f.marker(job.directory), null);
        await assert.rejects(service.start(request), code('RECONCILIATION'));
        assert.doesNotMatch(JSON.stringify(outcome), /private|Users|700\d|Blender/);
      }
    });
  }
});

test('one operation at a time: a running check refuses start, probe and a second check; start in flight refuses a check', serial, async t => {
  const f = await fixture(t), job = await f.seed([captured(5)]);
  const q = queryHost(() => 'gate'), service = await f.open({ workerQueryHost: q.host });
  const pending = service.resolveInterrupted(job.jobId);
  await until(() => q.stats.gates.length === 1);
  await assert.rejects(service.start(request), code('BUSY'));
  await assert.rejects(service.resolveInterrupted(job.jobId), code('BUSY'));
  await assert.rejects(service.probe(), code('BUSY'));
  q.stats.gates[0]!();
  assert.equal((await pending).status, 'resolved');
  // A start holding admission refuses a concurrent check and a concurrent start.
  const starting = service.start(request);
  await assert.rejects(service.resolveInterrupted(job.jobId), code('BUSY'));
  await assert.rejects(service.start(request), code('BUSY'));
  const started = await starting; await service.cancel(started.jobId);
});

test('legacy creation-time conflict retains the service fence and original journal without a marker', serial, async t => {
  const f = await fixture(t), native = captured(5), legacy = { ...native, identity: { ...native.identity, schemaVersion: 1 } };
  const job = await f.seed([legacy]), original = await readFile(join(job.directory, 'job.json'));
  const q = queryHost(() => 'reused'), service = await f.open({ workerQueryHost: q.host });
  assert.deepEqual(await service.resolveInterrupted(job.jobId), { jobId: job.jobId, status: 'refused', reason: 'identity-conflict' });
  assert.equal(q.stats.calls, 1); assert.equal(await f.marker(job.directory), null);
  assert.deepEqual(await readFile(join(job.directory, 'job.json')), original);
  await assert.rejects(service.start(request), code('RECONCILIATION'));
  assert.equal(service.jobs().find(record => record.jobId === job.jobId)!.state, 'interrupted');
});

test('a journal changed during assessment is stale and writes nothing', serial, async t => {
  const f = await fixture(t), job = await f.seed([captured(5)]);
  const q = queryHost(() => 'gate'), service = await f.open({ workerQueryHost: q.host });
  const pending = service.resolveInterrupted(job.jobId);
  await until(() => q.stats.gates.length === 1);
  const path = join(job.directory, 'job.json'); await writeFile(path, Buffer.concat([await readFile(path), Buffer.from('\n')]));
  q.stats.gates[0]!();
  assert.deepEqual(await pending, { jobId: job.jobId, status: 'refused', reason: 'resolution-stale' });
  assert.equal(await f.marker(job.directory), null);
});

test('close before the commit boundary cancels with nothing written and releases the output root', serial, async t => {
  const f = await fixture(t), job = await f.seed([captured(5)]);
  const q = queryHost(() => 'gate'), service = await f.open({ workerQueryHost: q.host });
  const pending = service.resolveInterrupted(job.jobId);
  await until(() => q.stats.gates.length === 1);
  const closing = service.close();
  q.stats.gates[0]!(); // The owned query is awaited, but an abort never yields evidence.
  await assert.rejects(pending, code('CANCELLED')); await closing;
  assert.equal(await f.marker(job.directory), null);
  const reopened = await f.open(); assert.equal(reopened.jobs()[0]!.resolution, undefined);
});

test('abort and close during the marker write are joined; the committed outcome is reported, never a clean cancellation', serial, async t => {
  const f = await fixture(t), job = await f.seed([closed(1)]);
  let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  let writing = false;
  const service = await f.open({ resolutionMarkerWriter: async (dir, name, text) => { writing = true; await gate; await atomicAssetJson(dir, name, text); } });
  const controller = new AbortController();
  const pending = service.resolveInterrupted(job.jobId, controller.signal);
  await until(() => writing);
  controller.abort(); const closing = service.close();
  let closeSettled = false; void closing.then(() => { closeSettled = true; });
  await flush(); assert.equal(closeSettled, false, 'close joins the started write');
  release();
  const outcome = await pending; await closing;
  assert.equal(outcome.status, 'resolved');
  assert.ok(await f.marker(job.directory));
  const reopened = await f.open(); assert.equal(reopened.jobs()[0]!.resolution?.status, 'resolved');
});

test('a write failing before replace commits nothing: PERSISTENCE, fence kept', serial, async t => {
  const f = await fixture(t), job = await f.seed([closed(1)]);
  const service = await f.open({ resolutionMarkerWriter: async () => { throw new AtomicJsonFailure('write', Object.assign(new Error('disk'), { code: 'EIO' })); } });
  await assert.rejects(service.resolveInterrupted(job.jobId), code('PERSISTENCE'));
  assert.equal(await f.marker(job.directory), null);
  await assert.rejects(service.start(request), code('RECONCILIATION'));
});

test('an uncertain rename that actually committed stays fenced in-process until re-checked from disk', serial, async t => {
  const f = await fixture(t), job = await f.seed([closed(1)]);
  let fail = true;
  const service = await f.open({ resolutionMarkerWriter: async (dir, name, text) => {
    await atomicAssetJson(dir, name, text);
    if (fail) throw new AtomicJsonFailure('replace', Object.assign(new Error('rename'), { code: 'EPERM' }));
  } });
  await assert.rejects(service.resolveInterrupted(job.jobId), code('RESOLUTION_UNCERTAIN'));
  assert.ok(await f.marker(job.directory), 'the marker may have committed');
  assert.equal(service.jobs()[0]!.resolution?.status, 'uncertain');
  await assert.rejects(service.start(request), code('RECONCILIATION'));
  fail = false;
  const again = await service.resolveInterrupted(job.jobId);
  assert.equal(again.status, 'resolved'); assert.equal((again as { alreadyResolved: boolean }).alreadyResolved, true);
  await admittedAndSettled(service);
});

test('a write that reports success but leaves no valid marker is uncertain, never success', serial, async t => {
  const f = await fixture(t), job = await f.seed([closed(1)]);
  const service = await f.open({ resolutionMarkerWriter: async (dir, name) => { await writeFile(join(dir, name), '{"forged":true}'); } });
  await assert.rejects(service.resolveInterrupted(job.jobId), code('RESOLUTION_UNCERTAIN'));
  await assert.rejects(service.start(request), code('RECONCILIATION'));
});

async function uncertainButCommitted(f: Awaited<ReturnType<typeof fixture>>, jobId?: string) {
  const job = await f.seed([closed(1)], jobId);
  let fail = true;
  const service = await f.open({ resolutionMarkerWriter: async (dir, name, text) => {
    await atomicAssetJson(dir, name, text); if (fail) throw new AtomicJsonFailure('replace', Object.assign(new Error('rename'), { code: 'EPERM' }));
  } });
  await assert.rejects(service.resolveInterrupted(job.jobId), code('RESOLUTION_UNCERTAIN'));
  return { job, service, allow: () => { fail = false; } };
}

test('a pre-aborted request cannot confirm a previously uncertain marker through the fast path', serial, async t => {
  const f = await fixture(t), { job, service } = await uncertainButCommitted(f);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(service.resolveInterrupted(job.jobId, aborted.signal), code('CANCELLED'));
  assert.equal(service.jobs()[0]!.resolution?.status, 'uncertain');
  await assert.rejects(service.start(request), code('RECONCILIATION'));
});

test('close while the initial marker read is pending cancels without confirming an uncertain marker', serial, async t => {
  const f = await fixture(t), { job, service } = await uncertainButCommitted(f);
  let release!: () => void; const gate = new Promise<void>(r => { release = r; }); let reading = false;
  const realOpen = fsp.open;
  t.mock.method(fsp, 'open', async (...args: Parameters<typeof fsp.open>) => {
    if (String(args[0]).endsWith('worker-resolution.json') && !reading) { reading = true; await gate; }
    return realOpen(...args);
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const pending = service.resolveInterrupted(job.jobId);
  await until(() => reading);
  const closing = service.close(); release();
  await assert.rejects(pending, code('CANCELLED')); await closing;
});

test('admission re-reads every witnessed file: a change to an earlier job while a later one is read keeps the fence', serial, async t => {
  const f = await fixture(t);
  const first = await f.seed([closed(1)], '41111111-4444-4444-8444-444444444444');
  const second = await f.seed([closed(1)], '42222222-4444-4444-8444-444444444444');
  const service = await f.open();
  await service.resolveInterrupted(first.jobId); await service.resolveInterrupted(second.jobId);
  const realOpen = fsp.open; let mutated = false;
  t.mock.method(fsp, 'open', async (...args: Parameters<typeof fsp.open>) => {
    // While admission reads the SECOND job's journal, the FIRST job's already-witnessed journal changes.
    if (!mutated && String(args[0]) === join(second.directory, 'job.json')) {
      mutated = true; const path = join(first.directory, 'job.json'); await fsp.writeFile(path, Buffer.concat([await readFile(path), Buffer.from(' ')]));
    }
    return realOpen(...args);
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(service.start(request), code('RECONCILIATION'));
  assert.equal(mutated, true);
  t.mock.restoreAll(); syncBuiltinESMExports();
  await assert.rejects(service.start(request), code('RECONCILIATION')); // The next admission re-validates and refreshes the display.
  assert.equal(service.jobs().find(j => j.jobId === first.jobId)!.resolution?.status, 'invalid');
});

test('MCP job schema accepts a record carrying a resolution and strips it: agents never receive the human check', serial, async t => {
  const f = await fixture(t), job = await f.seed([closed(1)]);
  const service = await f.open(); await service.resolveInterrupted(job.jobId);
  const record = service.jobs()[0]!;
  assert.equal(record.resolution?.status, 'resolved');
  const parsed = assetJob.parse(record) as unknown as Record<string, unknown>;
  assert.equal('resolution' in parsed, false); assert.equal(parsed.state, 'interrupted');
});
