import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { AssetError } from '../../packages/asset-pipeline/src/types.js';
import { AssetPipeline } from '../../packages/asset-pipeline/src/index.js';
import { ChildProcess } from 'node:child_process';
import { runBounded, type CommandOptions, type CommandResult, type CommandSpec } from '../../packages/asset-pipeline/src/process.js';
import type { ProcessQueryHost, WorkerIdentity } from '../../packages/asset-pipeline/src/worker-identity.js';
import { MAX_WORKER_RECORDS, WorkerSupervision, attestJobWorkers, parseWorkerRecords, recordClosed, reserveWorker,
  type WorkerRecord } from '../../packages/asset-pipeline/src/worker-journal.js';

// Synthetic boundaries: a simulated process table and query host, and an injected runner that follows the
// runBounded contract. No PowerShell/CIM, Blender, Python, provider, product process or Studio.
// The runBounded contract tests at the end spawn only tiny owned `node -e` children, as assets.test.ts does.
const BLENDER = 'C:\\Program Files\\Blender Foundation\\Blender 4.2\\blender.exe';
const PYTHON = 'C:\\Program Files\\Blender Foundation\\Blender 4.2\\4.2\\python\\bin\\python.exe';
const T = (n: number) => '2026-10-16T' + String(Math.floor(n / 3600) % 24).padStart(2, '0') + ':' + String(Math.floor(n / 60) % 60).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0') + '.0000000Z';
const id = (n: number) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
type Proc = { created: string; executable: string; alive: boolean };
const code = (value: string) => (error: unknown) => error instanceof AssetError && error.code === value;

class World {
  procs = new Map<number, Proc>(); clock = 0; queries = 0; nextPid = 1000;
  constructor(public platform = 'win32', public metadataInaccessible = false) {}
  start(executable: string, pid = this.nextPid++): number { this.procs.set(pid, { created: T(++this.clock), executable, alive: true }); return pid; }
  stop(pid: number) { const p = this.procs.get(pid); if (p) p.alive = false; }
  alive() { return [...this.procs.values()].some(p => p.alive); }
  snapshot(): World { const w = new World(this.platform, this.metadataInaccessible); w.clock = this.clock; for (const [k, v] of this.procs) w.procs.set(k, { ...v }); return w; }
  host(): ProcessQueryHost {
    return { platform: this.platform, systemRoot: 'C:\\Windows', execFile: (_f, _a, options, callback) => {
      this.queries++;
      const pid = Number(options.env.ARCANE_WORKER_PID), p = this.procs.get(pid);
      const out = !p || !p.alive ? { v: 1, found: false } : { v: 1, found: true, pid, created: p.created, executable: this.metadataInaccessible ? null : p.executable };
      queueMicrotask(() => callback(null, JSON.stringify(out), ''));
      return undefined;
    } };
  }
}
type Step = { exitBeforeCapture?: boolean; spawnFails?: boolean; exitCode?: number; stdout?: string; ignoreStop?: boolean; noClose?: boolean; onUnresolved?: (close: () => void) => void };
/** Injected runner obeying the runBounded contract: hooks.spawned right after creation, hooks.closed only on close. */
function runner(world: World, steps: Step[], seen: { spec: CommandSpec; pid?: number }[] = [], onSpawn?: (pid: number) => Promise<void>) {
  return async (spec: CommandSpec, options: CommandOptions = {}): Promise<CommandResult> => {
    const step = steps.shift() ?? {}, hooks = options.supervise;
    if (step.spawnFails) { seen.push({ spec }); throw new AssetError('PROCESS_START', 'Native worker could not start.'); }
    const pid = world.start(spec.executable); seen.push({ spec, pid });
    await onSpawn?.(pid);
    if (step.exitBeforeCapture) world.stop(pid);
    const decision = hooks ? await hooks.spawned({ pid, exited: () => !world.procs.get(pid)!.alive }) : 'continue';
    if (decision === 'stop') {
      if (step.ignoreStop) return new Promise<never>(() => { /* No close is ever observed. */ });
      world.stop(pid); hooks?.closed(); throw new AssetError('SUPERVISION_UNRECORDED', 'stopped');
    }
    if (step.noClose) {
      step.onUnresolved?.(() => { world.stop(pid); hooks?.closed(); });
      return { stdout: step.stdout ?? '', stderr: '', exitCode: step.exitCode ?? 0, signal: null }; // Contract violation: settled without close.
    }
    world.stop(pid); hooks?.closed();
    return { stdout: step.stdout ?? '', stderr: '', exitCode: step.exitCode ?? 0, signal: null };
  };
}
const blenderOk = { stdout: 'ARCANE_RESULT ' + JSON.stringify({ version: '4.2.0', pythonVersion: '3.11.7', background: true,
  capabilities: { glbExport: true, glbImport: true, fbxExport: true, fbxImport: true, cycles: true } }) + '\n' };
const pythonOk = { stdout: 'ARCANE_RESULT {"version":"3.11.7"}\n' };

async function scratchRoot(t: test.TestContext): Promise<string> {
  const base = await realpath(tmpdir()), root = await mkdtemp(join(base, 'arcane-worker-journal-'));
  t.after(async () => {
    const actual = await realpath(root), child = relative(base, actual);
    assert.ok(!isAbsolute(child) && child.startsWith('arcane-worker-journal-') && !child.includes(sep) && !child.includes('..'));
    await rm(actual, { recursive: true, force: true });
  });
  return root;
}
async function pipelineFixture(t: test.TestContext, world: World, steps: Step[], options: { blender?: string[]; python?: string[] } = {}, onSpawn?: (pid: number) => Promise<void>) {
  const root = await scratchRoot(t), workers = join(root, 'workers'), output = join(root, 'assets');
  await mkdir(workers);
  for (const name of ['asset_worker.py', 'audit.py', 'probe.py']) await writeFile(join(workers, name), '# synthetic worker script\n');
  const seen: { spec: CommandSpec; pid?: number }[] = [];
  const pipeline = new AssetPipeline({ workspaceRoot: root, outputRoot: output, workerRoot: workers }, {
    run: runner(world, steps, seen, onSpawn), queryHost: world.host(),
    discover: async () => ({ blender: options.blender ?? [BLENDER], python: options.python ?? [PYTHON] }) });
  return { pipeline, seen, root, output };
}
const job = async (directory: string) => JSON.parse(await readFile(join(directory, 'job.json'), 'utf8')) as Record<string, unknown>;
const roles = (records: unknown) => (parseWorkerRecords(records) ?? []).map(r => r.role + ':' + r.state + (r.state === 'closed' ? ':' + r.closure : ''));
const request = { name: 'crate', template: 'hero-prop' as const };

test('journal parsing is strict, frozen and fails closed on any invalid record', () => {
  const identity: WorkerIdentity = { schemaVersion: 1, role: 'generate', pid: 7, processCreatedAt: T(1), executable: BLENDER };
  const records = parseWorkerRecords([{ schemaVersion: 1, role: 'python-probe', reservationId: id(1), reservedAt: T(1), state: 'reserved' },
    { schemaVersion: 1, role: 'generate', reservationId: id(2), reservedAt: T(1), state: 'captured', identity }]);
  assert.ok(records && Object.isFrozen(records) && Object.isFrozen(records[1]));
  for (const value of [
    [{ schemaVersion: 1, role: 'shell', reservationId: id(1), reservedAt: T(1), state: 'reserved' }],
    [{ schemaVersion: 1, role: 'probe', reservationId: id(1), reservedAt: '2026-02-30T00:00:00.0000000Z', state: 'reserved' }],
    [{ schemaVersion: 1, role: 'probe', reservationId: id(1), reservedAt: T(1), state: 'captured', identity }],
    [{ schemaVersion: 1, role: 'probe', reservationId: id(1), reservedAt: T(1), state: 'closed', closure: 'not-started', closedAt: T(2), identity: { ...identity, role: 'probe' } }],
    [{ schemaVersion: 1, role: 'probe', reservationId: id(1), reservedAt: T(1), state: 'reserved', extra: 1 }],
    [{ schemaVersion: 1, role: 'probe', reservationId: id(1), reservedAt: T(1), state: 'reserved' }, { schemaVersion: 1, role: 'generate', reservationId: id(1), reservedAt: T(1), state: 'reserved' }],
    Array.from({ length: MAX_WORKER_RECORDS + 1 }, (_, i) => ({ schemaVersion: 1, role: 'probe', reservationId: id(i + 1), reservedAt: T(1), state: 'closed', closure: 'not-started', closedAt: T(2), identity: null })),
    {}, 'records',
  ]) assert.equal(parseWorkerRecords(value), null, JSON.stringify(value).slice(0, 80));
});

test('six-record bound refuses safely and never evicts an unresolved record', () => {
  let records: readonly WorkerRecord[] = reserveWorker([], 'probe', id(1), T(1));
  assert.throws(() => reserveWorker(records, 'probe', id(2), T(1)), code('SUPERVISION_STATE'));
  for (let i = 2; i <= MAX_WORKER_RECORDS; i++) { records = recordClosed(records, id(i - 1), 'not-started', T(2)); records = reserveWorker(records, i % 2 ? 'probe' : 'python-probe', id(i), T(1)); }
  assert.equal(records.length, MAX_WORKER_RECORDS);
  assert.throws(() => reserveWorker(records, 'generate', id(99), T(1)), code('SUPERVISION_BOUND'));
  assert.equal(records.filter(r => r.state === 'reserved').length, 1);
});

test('job attestation: legacy/empty/invalid/reserved stay unknown without queries; closed records need no query', async () => {
  const world = new World(), host = world.host();
  assert.deepEqual(await attestJobWorkers(undefined, host), { verdict: 'unknown', reason: 'no-workers-recorded' });
  assert.deepEqual(await attestJobWorkers([], host), { verdict: 'unknown', reason: 'no-workers-recorded' });
  assert.deepEqual(await attestJobWorkers([{ bogus: true }], host), { verdict: 'unknown', reason: 'records-invalid' });
  let records = reserveWorker([], 'generate', id(1), T(1));
  assert.deepEqual(await attestJobWorkers(records, host), { verdict: 'unknown', reason: 'reservation-unresolved' });
  records = recordClosed(records, id(1), 'exit-observed', T(2));
  assert.deepEqual(await attestJobWorkers(records, host), { verdict: 'recorded-worker-gone', reason: 'pid-absent' });
  assert.equal(world.queries, 0);
});

test('reservation-write failure starts no process and blocks every later launch', async () => {
  const world = new World(); let runs = 0, writes = 0;
  const supervision = new WorkerSupervision({ host: world.host(), persist: async () => { if (++writes === 1) throw new Error('disk C:\\private'); } });
  await assert.rejects(supervision.begin('probe', BLENDER), code('PERSISTENCE'));
  assert.equal(supervision.broken, true);
  await assert.rejects(supervision.begin('python-probe', PYTHON), code('PERSISTENCE'));
  assert.equal(runs, 0); assert.equal(world.procs.size, 0);
  // Pipeline level: an unwritable journal before the first probe means no spawn at all.
  const t2 = new World(), seen: unknown[] = [];
  const s2 = new WorkerSupervision({ host: t2.host(), persist: async () => { throw new Error('disk'); } });
  await assert.rejects(s2.begin('generate', BLENDER).then(launch => runner(t2, [], seen as never)({ executable: BLENDER, args: [], cwd: 'C:\\' }, { supervise: launch.hooks })), code('PERSISTENCE'));
  assert.equal(seen.length, 0); assert.equal(t2.procs.size, 0);
});

test('crash at every write/spawn/capture/close instant never attests gone while a worker lives (all three roles)', async () => {
  const world = new World(); const instants: { label: string; journal: unknown; world: World }[] = [];
  let journal: unknown = undefined, n = 0;
  const mark = (label: string) => instants.push({ label, journal: structuredClone(journal), world: world.snapshot() });
  const supervision = new WorkerSupervision({ host: world.host(), newId: () => id(++n), now: () => T(++world.clock),
    persist: async records => { journal = structuredClone(records); mark('write'); } });
  for (const [role, exe, step] of [['probe', BLENDER, blenderOk], ['python-probe', PYTHON, { ...pythonOk, exitBeforeCapture: true }], ['generate', BLENDER, {}]] as const) {
    const launch = await supervision.begin(role, exe);
    const run = runner(world, [step], [], async () => { mark('spawned:' + role); });
    await run({ executable: exe, args: [], cwd: 'C:\\' }, { supervise: { spawned: async info => { const d = await launch.hooks.spawned(info); mark('decided:' + role); return d; }, closed: () => { mark('closed:' + role); launch.hooks.closed(); } } });
    await launch.finish();
  }
  assert.ok(instants.length >= 15, String(instants.length));
  for (const [index, instant] of instants.entries()) {
    const result = await attestJobWorkers(instant.journal, instant.world.host());
    if (instant.world.alive()) assert.notEqual(result.verdict, 'recorded-worker-gone', index + ' ' + instant.label + ' ' + JSON.stringify(result));
  }
  assert.deepEqual(roles(journal), ['probe:closed:exit-observed', 'python-probe:closed:exit-observed', 'generate:closed:exit-observed']);
  assert.deepEqual(await attestJobWorkers(journal, world.host()), { verdict: 'recorded-worker-gone', reason: 'pid-absent' });
});

test('CRITICAL: closed probe plus an unrecorded generation reservation stays fenced while generation runs', async () => {
  const world = new World(); let journal: unknown;
  const supervision = new WorkerSupervision({ host: world.host(), persist: async r => { journal = structuredClone(r); } });
  const probe = await supervision.begin('probe', BLENDER);
  await runner(world, [blenderOk])({ executable: BLENDER, args: [], cwd: 'C:\\' }, { supervise: probe.hooks }); await probe.finish();
  await supervision.begin('generate', BLENDER); world.start(BLENDER); // Host crash after spawn, before capture.
  assert.deepEqual(await attestJobWorkers(journal, world.host()), { verdict: 'unknown', reason: 'reservation-unresolved' });
});

test('pipeline: reservation is durable before each spawn and every rewrite (incl. failure) carries the records', async t => {
  const world = new World(); let directory = '';
  const reservedAtSpawn: string[][] = [];
  const f = await pipelineFixture(t, world, [blenderOk, { ...pythonOk, exitBeforeCapture: true }, { exitCode: 1 }], {}, async () => {
    const dir = (await readdir(join(f.output))).find(name => name.startsWith('crate-'))!;
    directory = join(f.output, dir); reservedAtSpawn.push(roles((await job(directory)).workers));
  });
  const handle = f.pipeline.start(request);
  const result = await handle.completion;
  assert.equal(result.state, 'failed'); assert.equal(result.error?.code, 'BLENDER_FAILED');
  assert.deepEqual(reservedAtSpawn, [['probe:reserved'], ['probe:closed:exit-observed', 'python-probe:reserved'],
    ['probe:closed:exit-observed', 'python-probe:closed:exit-observed', 'generate:reserved']]);
  const saved = await job(handle.directory);
  assert.equal(saved.state, 'failed');
  assert.deepEqual(roles(saved.workers), ['probe:closed:exit-observed', 'python-probe:closed:exit-observed', 'generate:closed:exit-observed']);
  const generate = parseWorkerRecords(saved.workers)![2]!;
  assert.ok(generate.state === 'closed' && generate.identity?.pid === f.seen[2]!.pid, 'captured exact identity retained after closure');
  const python = parseWorkerRecords(saved.workers)![1]!;
  assert.ok(python.state === 'closed' && python.identity === null, 'normal exit before capture: closure observed, no identity, no failure');
});

test('pipeline: Windows incomplete metadata stops the live worker and records closure only after close', async t => {
  const world = new World('win32', true);
  const f = await pipelineFixture(t, world, [{}], { python: [] });
  const handle = f.pipeline.start(request); const result = await handle.completion;
  assert.equal(result.error?.code, 'BLENDER_UNAVAILABLE');
  assert.equal(world.alive(), false);
  assert.deepEqual(roles((await job(handle.directory)).workers), ['probe:closed:exit-observed']);
});

test('pipeline: unsupported OS keeps the stage reserved while it runs; only observed close resolves it', async t => {
  const world = new World('linux'); let during: string[] = [];
  const f = await pipelineFixture(t, world, [blenderOk, pythonOk, { exitCode: 1 }], {}, async () => {
    const dir = (await readdir(f.output)).find(name => name.startsWith('crate-'))!; during = roles((await job(join(f.output, dir))).workers);
  });
  const handle = f.pipeline.start(request); await handle.completion;
  assert.equal(world.queries, 0, 'no identity query off Windows');
  assert.deepEqual(during.at(-1), 'generate:reserved');
  const saved = parseWorkerRecords((await job(handle.directory)).workers)!;
  assert.deepEqual(saved.map(r => r.state === 'closed' && r.closure), ['exit-observed', 'exit-observed', 'exit-observed']);
  // A restart before observation: the reserved generation stays unknown/fenced.
  assert.deepEqual(await attestJobWorkers([...saved.slice(0, 2), { ...reserveWorker([], 'generate', id(77), T(1))[0]! }], world.host()),
    { verdict: 'unknown', reason: 'reservation-unresolved' });
});

test('pipeline: a captured-identity write failure stops and confirms the worker and blocks further launches', async t => {
  const world = new World(); let writes = 0;
  const supervision = new WorkerSupervision({ host: world.host(), persist: async () => { if (++writes === 2) throw new Error('disk'); } });
  const launch = await supervision.begin('generate', BLENDER);
  await assert.rejects(runner(world, [{}])({ executable: BLENDER, args: [], cwd: 'C:\\' }, { supervise: launch.hooks }), code('SUPERVISION_UNRECORDED'));
  assert.equal(world.alive(), false);
  await assert.rejects(launch.finish(), code('PERSISTENCE')); // Broken journal: closure is retained in memory, never another launch.
  assert.deepEqual(roles(supervision.records), ['generate:closed:exit-observed']);
  await assert.rejects(supervision.begin('probe', BLENDER), code('PERSISTENCE'));
});

test('pipeline: probe attempts keep one record free for generation and never exceed the bound', async t => {
  const world = new World();
  const failing = Array.from({ length: 8 }, (_, i) => 'C:\\Blender' + i + '\\blender.exe');
  const f = await pipelineFixture(t, world, Array.from({ length: 8 }, () => ({ exitCode: 1 })), { blender: failing });
  const handle = f.pipeline.start(request); const result = await handle.completion;
  assert.equal(result.error?.code, 'BLENDER_UNAVAILABLE');
  const saved = parseWorkerRecords((await job(handle.directory)).workers)!;
  assert.equal(saved.length, MAX_WORKER_RECORDS - 1); assert.equal(f.seen.length, MAX_WORKER_RECORDS - 1);
});

test('pipeline: spawn failure records not-started; runner settling without close leaves the stage unresolved', async t => {
  const world = new World();
  const f = await pipelineFixture(t, world, [{ spawnFails: true }], { python: [] });
  const handle = f.pipeline.start(request); await handle.completion;
  assert.deepEqual(roles((await job(handle.directory)).workers), ['probe:closed:not-started']);
  const w2 = new World(); const s = new WorkerSupervision({ host: w2.host(), persist: async () => undefined });
  const launch = await s.begin('generate', BLENDER);
  await runner(w2, [{ noClose: true }])({ executable: BLENDER, args: [], cwd: 'C:\\' }, { supervise: launch.hooks });
  await assert.rejects(launch.finish(), code('SUPERVISION_UNRESOLVED'));
  assert.deepEqual(roles(s.records), ['generate:captured']);
});

test('recovery retains valid, invalid and legacy supervision evidence exactly', async t => {
  const root = await scratchRoot(t), output = join(root, 'assets'); await mkdir(output);
  const pipeline = new AssetPipeline({ workspaceRoot: root, outputRoot: output, workerRoot: root });
  const cases: [string, unknown][] = [['valid', reserveWorker([], 'generate', id(5), T(5))], ['invalid', [{ bogus: true }]], ['legacy', undefined]];
  for (const [label, workers] of cases) {
    const jobId = '11111111-1111-4111-8111-' + String(cases.findIndex(c => c[0] === label)).padStart(12, '0'), dir = join(output, 'crate-' + jobId);
    await mkdir(dir);
    await writeFile(join(dir, 'job.json'), JSON.stringify({ schemaVersion: 1, jobId, directory: dir, manifestPath: null, error: null, state: 'running', request, startedAt: T(1), ...(workers === undefined ? {} : { workers }) }));
    const { result } = await pipeline.recover(dir);
    assert.equal(result.state, 'interrupted');
    const saved = await job(dir);
    if (workers === undefined) assert.equal('workers' in saved, false, label); else assert.deepEqual(saved.workers, JSON.parse(JSON.stringify(workers)), label);
    assert.notEqual((await attestJobWorkers(saved.workers, new World().host())).verdict, 'recorded-worker-gone', label);
  }
});

test('standalone probe scratch: only the scratch of this invocation is removed, after observed closure; nothing else is swept', async t => {
  const root = await scratchRoot(t), temp = join(root, 'temp'); await mkdir(temp);
  const previous = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
  process.env.TEMP = process.env.TMP = process.env.TMPDIR = temp;
  t.after(() => { for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  // Unrelated leftovers from other runs are never inspected or deleted, whatever they contain.
  for (const name of ['finished-closed', 'legacy']) { const dir = join(temp, 'arcane-blender-probe-' + name); await mkdir(dir); await writeFile(join(dir, 'marker'), name); }
  const world = new World(), workers = join(root, 'workers'); await mkdir(workers); await writeFile(join(workers, 'probe.py'), '# synthetic\n');
  const pipeline = new AssetPipeline({ workspaceRoot: root, outputRoot: join(root, 'assets'), workerRoot: workers },
    { run: runner(world, [blenderOk, pythonOk]), queryHost: world.host(), discover: async () => ({ blender: [BLENDER], python: [PYTHON] }) });
  const probe = await pipeline.probe();
  assert.equal(probe.available, true); assert.equal(world.queries, 0, 'scratch supervision never queries identity');
  assert.deepEqual((await readdir(temp)).sort(), ['arcane-blender-probe-finished-closed', 'arcane-blender-probe-legacy']);
  // A runner that settles without an observed close: this invocation's scratch is retained, never assumed clean.
  let closeUnresolved!: () => void;
  const stuck = new AssetPipeline({ workspaceRoot: root, outputRoot: join(root, 'assets'), workerRoot: workers },
    { run: runner(new World(), [{ noClose: true, onUnresolved: close => { closeUnresolved = close; } }]), discover: async () => ({ blender: [BLENDER], python: [] }) });
  await assert.rejects(stuck.probe(), code('SUPERVISION_UNRESOLVED'));
  assert.equal((await readdir(temp)).length, 3);
  assert.throws(() => pipeline.start(request), code('BUSY'));
  closeUnresolved();
});

test('unresolved stage closure ends the job as interrupted (fenced), persisted and kept on restart', async t => {
  const world = new World();
  let closeUnresolved!: () => void;
  const f = await pipelineFixture(t, world, [blenderOk, pythonOk, { noClose: true, onUnresolved: close => { closeUnresolved = close; } }]);
  const handle = f.pipeline.start(request); const result = await handle.completion;
  assert.equal(result.state, 'interrupted'); assert.equal(result.error?.code, 'SUPERVISION_UNRESOLVED');
  const saved = await job(handle.directory);
  assert.equal(saved.state, 'interrupted');
  assert.deepEqual(roles(saved.workers), ['probe:closed:exit-observed', 'python-probe:closed:exit-observed', 'generate:captured']);
  await assert.rejects(f.pipeline.recover(handle.directory), code('BUSY'));
  assert.equal(world.alive(), true);
  assert.deepEqual(await attestJobWorkers(saved.workers, world.host()), { verdict: 'same-worker-running', reason: 'identity-matched' });
  closeUnresolved();
  const recovered = await f.pipeline.recover(handle.directory);
  assert.equal(recovered.result.state, 'interrupted');
  assert.deepEqual(roles((await job(handle.directory)).workers), roles(saved.workers));
  // Only the eventual observed close releases live ownership. Saved unresolved evidence stays unchanged.
  assert.deepEqual(await attestJobWorkers(saved.workers, world.host()), { verdict: 'recorded-worker-gone', reason: 'pid-absent' });
});

test('runBounded contract: closed fires on close before settling; stop decision kills and still awaits close', async () => {
  const order: string[] = [];
  const ok = await runBounded({ executable: process.execPath, args: ['-e', "console.log('ran')"], cwd: tmpdir() }, { supervise: {
    spawned: async ({ pid }) => { order.push('spawned:' + typeof pid); await new Promise(r => setTimeout(r, 50)); order.push('decided'); return 'continue'; },
    closed: () => { order.push('closed'); } } });
  order.push('settled');
  assert.equal(ok.exitCode, 0); assert.deepEqual(order.filter(x => x !== 'closed').slice(0, 2), ['spawned:number', 'decided']);
  assert.equal(order.at(-1), 'settled'); assert.ok(order.indexOf('closed') >= 0 && order.indexOf('closed') < order.indexOf('settled'));
  let closedSeen = false;
  await assert.rejects(runBounded({ executable: process.execPath, args: ['-e', 'setTimeout(()=>{},10000)'], cwd: tmpdir() }, { supervise: {
    spawned: async () => 'stop', closed: () => { closedSeen = true; } } }), code('SUPERVISION_UNRECORDED'));
  assert.equal(closedSeen, true);
  await assert.rejects(runBounded({ executable: process.execPath, args: ['-e', 'setTimeout(()=>{},10000)'], cwd: tmpdir() }, { supervise: {
    spawned: async () => { throw new Error('hook'); }, closed: () => undefined } }), code('SUPERVISION_UNRECORDED'));
});

test('initial records are validated into a frozen copy; an invalid journal is rejected whole', () => {
  const initial = [...reserveWorker([], 'probe', id(1), T(1))].map(r => ({ ...r }));
  const supervision = new WorkerSupervision({ persist: async () => undefined }, initial);
  (initial[0] as Record<string, unknown>).state = 'closed';
  assert.equal(supervision.records[0]!.state, 'reserved'); assert.ok(Object.isFrozen(supervision.records));
  for (const bad of [[{ bogus: true }], 'x', [...initial, { ...initial[0]!, reservationId: 'bad' }]]) {
    assert.throws(() => new WorkerSupervision({ persist: async () => undefined }, bad), code('SUPERVISION_STATE'));
  }
});

test('overlapping transitions are serialized: a stalled older write cannot overwrite a newer reservation', async () => {
  const persisted: string[][] = []; let releaseFirst!: () => void; let calls = 0;
  const supervision = new WorkerSupervision({ host: new World('linux').host(), newId: () => id(++calls),
    persist: async records => { const snapshot = roles(records); if (calls === 1 && persisted.length === 0) await new Promise<void>(r => { releaseFirst = r; }); persisted.push(snapshot); } });
  const first = supervision.begin('probe', BLENDER), second = supervision.begin('python-probe', PYTHON);
  let secondResolved = false; void second.then(() => { secondResolved = true; });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(secondResolved, false, 'second reservation waits for the first persist');
  releaseFirst();
  await first; await second;
  assert.deepEqual(persisted, [['probe:reserved'], ['probe:reserved', 'python-probe:reserved']]);
  assert.deepEqual(roles(supervision.records), ['probe:reserved', 'python-probe:reserved']);
});

test('runBounded: a throwing kill neither escapes nor releases early; settlement still waits for the real close', async t => {
  const original = ChildProcess.prototype.kill; let attempts = 0;
  ChildProcess.prototype.kill = function () { attempts++; throw new Error('kill failed'); };
  t.after(() => { ChildProcess.prototype.kill = original; });
  const uncaught: unknown[] = []; const onUncaught = (e: unknown) => { uncaught.push(e); };
  process.on('uncaughtException', onUncaught); t.after(() => process.off('uncaughtException', onUncaught));
  const started = Date.now(); let closed = false;
  await assert.rejects(runBounded({ executable: process.execPath, args: ['-e', 'setTimeout(()=>{},700)'], cwd: tmpdir() }, { supervise: {
    spawned: async () => 'stop', closed: () => { closed = true; } } }), code('SUPERVISION_UNRECORDED'));
  assert.ok(Date.now() - started >= 600, 'settled only after the child exited on its own');
  assert.equal(closed, true); assert.ok(attempts >= 2, 'SIGTERM and SIGKILL escalation both attempted'); assert.equal(uncaught.length, 0);
});
