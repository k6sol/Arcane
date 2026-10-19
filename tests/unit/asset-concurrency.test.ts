import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, isAbsolute, sep } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { AssetError, AssetPipeline, MAX_CONCURRENT_ASSET_JOBS } from '../../packages/asset-pipeline/src/index.js';
import { createAssetService, type AssetService } from '../../apps/daemon/src/asset-service.js';
import { ArcaneError } from '../../packages/protocol/src/providers.js';
import type { CommandOptions, CommandSpec, CommandResult } from '../../packages/asset-pipeline/src/process.js';
import type { ProcessQueryHost } from '../../packages/asset-pipeline/src/worker-identity.js';

// Real output roots/journals and the actual pipeline/service. The injected held runner never executes
// Blender/Python, queries the host, calls providers or touches Studio. Only explicit close releases it.
const serial = { concurrency: false, timeout: 15000 };
const code = (expected: string) => (error: unknown) => (error instanceof AssetError || error instanceof ArcaneError) && error.code === expected;
const input = { template: 'hero-prop' as const, name: 'parallel' };
const noQuery: ProcessQueryHost = { platform: 'linux', systemRoot: undefined, execFile() { throw new Error('No native query permitted.'); } };
const result = (stdout = '', exitCode = 0): CommandResult => ({ stdout, stderr: '', exitCode, signal: null });
const probe = 'ARCANE_RESULT ' + JSON.stringify({ version: '4.2.0', pythonVersion: '3.11.7', background: true,
  capabilities: { glbExport: true, glbImport: true, fbxExport: true, fbxImport: true, cycles: true } }) + '\n';
const until = async (condition: () => boolean) => {
  const end = Date.now() + 5000;
  while (!condition()) { if (Date.now() > end) throw new Error('Held runner did not reach its gate.'); await nextTurn(); }
};
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
type Held = { spec: CommandSpec; options: CommandOptions; close(): void; returnUnclosed(): void; closed: boolean };

async function fixture(t: test.TestContext) {
  const base = await realpath(tmpdir()), root = await mkdtemp(join(base, 'arcane-two-assets-')), workers = join(root, 'workers');
  await mkdir(workers);
  for (const name of ['asset_worker.py', 'audit.py', 'probe.py']) await writeFile(join(workers, name), '# inert fixture; never executed\n');
  const held: Held[] = [], services: AssetService[] = [], completions: Promise<unknown>[] = [];
  let pid = 9000, live = 0, maximum = 0;
  const run = async (spec: CommandSpec, options: CommandOptions = {}): Promise<CommandResult> => {
    const hooks = options.supervise;
    assert.ok(hooks, 'Every native launch carries the operation claim.');
    await hooks.spawned({ pid: ++pid, exited: () => false });
    if (!spec.args.includes('generate')) {
      hooks.closed(); return result(spec.args.includes('-c') ? 'ARCANE_RESULT {"version":"3.11.7"}\n' : probe);
    }
    const exit = gate(); let unresolved = false;
    const entry: Held = { spec, options, closed: false,
      close() { if (!entry.closed) { entry.closed = true; live--; hooks.closed(); } exit.release(); },
      returnUnclosed() { unresolved = true; exit.release(); } };
    live++; maximum = Math.max(maximum, live); held.push(entry);
    await exit.promise;
    if (unresolved) return result(); // Deliberate runner failure: no observed child close.
    if (options.signal?.aborted) throw new AssetError('CANCELLED', 'Owned worker cancelled after close.');
    return result('', 1); // Intentional generation failure; artifacts are not fabricated.
  };
  const pipeline = (outputRoot: string) => {
    const pipeline = new AssetPipeline({ workspaceRoot: root, outputRoot, workerRoot: workers },
      { run, queryHost: noQuery, discover: async () => ({ blender: [process.execPath], python: [] }) });
    const start = pipeline.start.bind(pipeline);
    pipeline.start = (...args) => { const handle = start(...args); completions.push(handle.completion); return handle; };
    return pipeline;
  };
  t.after(async () => {
    for (const entry of held) entry.close();
    for (const service of services) await service.close();
    await Promise.allSettled(completions);
    const actual = await realpath(root), child = relative(base, actual);
    assert.ok(!isAbsolute(child) && child.startsWith('arcane-two-assets-') && !child.includes(sep) && !child.includes('..'));
    await rm(actual, { recursive: true, force: true });
  });
  return { root, workers, held, services, pipeline, live: () => live, maximum: () => maximum };
}

test('two independent pipelines overlap; third is refused before disk allocation; cancellation joins only its child', serial, async t => {
  const f = await fixture(t), outputA = join(f.root, 'a'), outputB = join(f.root, 'b'), outputC = join(f.root, 'c');
  const a = f.pipeline(outputA), b = f.pipeline(outputB), c = f.pipeline(outputC);
  const first = a.start(input), second = b.start(input);
  await until(() => f.held.length === 2);
  const firstWorker = f.held.find(entry => entry.spec.cwd === first.directory)!, secondWorker = f.held.find(entry => entry.spec.cwd === second.directory)!;
  assert.equal(MAX_CONCURRENT_ASSET_JOBS, 2); assert.equal(f.maximum(), 2); assert.equal(f.live(), 2);
  assert.notEqual(first.id, second.id); assert.notEqual(first.directory, second.directory);
  for (const entry of f.held) {
    assert.equal(entry.spec.cwd, dirname(entry.spec.args[entry.spec.args.indexOf('--python') + 1]!));
    assert.equal(entry.spec.env?.HOME, join(entry.spec.cwd, '.worker'));
    assert.equal(entry.spec.env?.BLENDER_USER_CONFIG, entry.spec.env?.HOME);
  }
  assert.throws(() => c.start(input), code('BUSY'));
  await assert.rejects(readdir(outputC), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
  await assert.rejects(a.probe(), code('BUSY'));
  const journal = await readFile(join(first.directory, 'job.json'));
  await assert.rejects(a.recover(first.directory), code('BUSY'));
  await assert.rejects(a.validate(join(first.directory, 'manifest.json'), { deep: true }), code('BUSY'));
  assert.deepEqual(await readFile(join(first.directory, 'job.json')), journal);
  first.cancel(); let settled = false; void first.completion.then(() => { settled = true; });
  await nextTurn(); assert.equal(settled, false); assert.equal(firstWorker.options.signal?.aborted, true);
  assert.equal(secondWorker.options.signal?.aborted, false);
  assert.throws(() => c.start(input), code('BUSY'));
  firstWorker.close(); assert.equal((await first.completion).state, 'cancelled');
  const third = c.start(input); await until(() => f.held.length === 3);
  assert.equal(f.live(), 2); assert.equal(f.maximum(), 2);
  secondWorker.close(); f.held[2]!.close();
  await Promise.all([second.completion, third.completion]);
  assert.equal(f.live(), 0); assert.equal((await a.recover(first.directory)).result.state, 'cancelled');
});

test('an unresolved returned worker retains capacity and its directory fence until actual close', serial, async t => {
  const f = await fixture(t), a = f.pipeline(join(f.root, 'a')), b = f.pipeline(join(f.root, 'b')), c = f.pipeline(join(f.root, 'c'));
  const first = a.start(input), second = b.start(input); await until(() => f.held.length === 2);
  const firstWorker = f.held.find(entry => entry.spec.cwd === first.directory)!, secondWorker = f.held.find(entry => entry.spec.cwd === second.directory)!;
  firstWorker.returnUnclosed();
  const failed = await first.completion;
  assert.equal(failed.state, 'interrupted'); assert.equal(failed.error?.code, 'SUPERVISION_UNRESOLVED');
  const bytes = await readFile(join(first.directory, 'job.json'));
  assert.throws(() => c.start(input), code('BUSY'));
  await assert.rejects(a.recover(first.directory), code('BUSY'));
  await assert.rejects(a.validate(join(first.directory, 'manifest.json')), code('BUSY'));
  assert.deepEqual(await readFile(join(first.directory, 'job.json')), bytes);
  firstWorker.close();
  const recovered = await a.recover(first.directory);
  assert.equal(recovered.result.state, 'interrupted');
  assert.deepEqual(await readFile(join(first.directory, 'job.json')), bytes, 'Late close does not rewrite unresolved evidence.');
  const third = c.start(input); await until(() => f.held.length === 3);
  assert.equal(f.maximum(), 2);
  secondWorker.close(); f.held[2]!.close(); await Promise.all([second.completion, third.completion]);
});

test('service admits two distinct jobs, refuses a third before authority callbacks, and close drains both children', serial, async t => {
  const f = await fixture(t), outputRoot = join(f.root, 'service'), pipeline = f.pipeline(outputRoot);
  const originalStart = AssetPipeline.prototype.start;
  t.mock.method(AssetPipeline.prototype, 'start', function (this: AssetPipeline, ...args: Parameters<typeof originalStart>) {
    return originalStart.apply(pipeline, args);
  });
  const service = await createAssetService({ cwd: f.root, outputRoot, workerRoot: f.workers }); f.services.push(service);
  const first = await service.start(input), second = await service.start(input);
  await until(() => f.held.length === 2);
  assert.notEqual(first.jobId, second.jobId); assert.notEqual(first.directory, second.directory); assert.equal(f.maximum(), 2);
  const before = (await readdir(outputRoot)).sort(); let callbacks = 0;
  await assert.rejects(service.start(input, { beforeCreate() { callbacks++; }, created() { callbacks++; } }), code('BUSY'));
  assert.equal(callbacks, 0); assert.deepEqual((await readdir(outputRoot)).sort(), before);
  let drained = false; const closing = service.close().then(() => { drained = true; });
  await nextTurn(); assert.equal(drained, false);
  assert.equal(f.held[0]!.options.signal?.aborted, true); assert.equal(f.held[1]!.options.signal?.aborted, true);
  f.held[0]!.close(); await nextTurn(); assert.equal(drained, false);
  f.held[1]!.close(); await closing;
  assert.equal(f.live(), 0); assert.ok(service.jobs().every(job => job.state === 'cancelled'));
});

test('service interruption fences later admission and restart until owned close, then preserves reconciliation evidence', serial, async t => {
  const f = await fixture(t), outputRoot = join(f.root, 'service'), pipeline = f.pipeline(outputRoot);
  const originalStart = AssetPipeline.prototype.start;
  t.mock.method(AssetPipeline.prototype, 'start', function (this: AssetPipeline, ...args: Parameters<typeof originalStart>) {
    return originalStart.apply(pipeline, args);
  });
  const options = { cwd: f.root, outputRoot, workerRoot: f.workers };
  const service = await createAssetService(options); f.services.push(service);
  const job = await service.start(input); await until(() => f.held.length === 1);
  f.held[0]!.returnUnclosed(); await until(() => service.jobs()[0]?.state === 'interrupted');
  let callbacks = 0;
  await assert.rejects(service.start(input, { beforeCreate() { callbacks++; }, created() { callbacks++; } }), code('RECONCILIATION'));
  assert.equal(callbacks, 0);
  const bytes = await readFile(join(job.directory, 'job.json'));
  await service.close();
  await assert.rejects(createAssetService(options), code('BUSY'));
  assert.deepEqual(await readFile(join(job.directory, 'job.json')), bytes);
  f.held[0]!.close();
  const reopened = await createAssetService(options); f.services.push(reopened);
  assert.equal(reopened.jobs()[0]?.state, 'interrupted');
  await assert.rejects(reopened.start(input), code('RECONCILIATION'));
  const assessment = await reopened.resolveInterrupted(job.jobId);
  assert.equal(assessment.status, 'refused');
  assert.deepEqual(await readFile(join(job.directory, 'job.json')), bytes, 'No replay or unresolved-evidence rewrite.');
});

test('spawn failure with no child releases both admissions for later work', serial, async t => {
  const f = await fixture(t), config = { workspaceRoot: f.root, outputRoot: join(f.root, 'failed-spawn'), workerRoot: f.workers };
  let attempts = 0;
  const p = new AssetPipeline(config, { queryHost: noQuery, discover: async () => ({ blender: [process.execPath], python: [] }),
    run: async () => { attempts++; throw new AssetError('PROCESS_START', 'No child was created.'); } });
  const first = p.start(input), second = p.start(input); await Promise.all([first.completion, second.completion]);
  const third = p.start(input); assert.equal((await third.completion).state, 'failed'); assert.equal(attempts, 3);
});
