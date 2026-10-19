import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { AssetError, AssetPipeline } from '../../packages/asset-pipeline/src/index.js';
import { decodeAssetJobError, workerFailure } from '../../packages/asset-pipeline/src/failure-diagnostics.js';
import type { CommandOptions, CommandResult, CommandSpec } from '../../packages/asset-pipeline/src/process.js';
import { createAssetService } from '../../apps/daemon/src/asset-service.js';
import { AssetArchiveStore } from '../../apps/daemon/src/asset-archive-store.js';
import { assetJobPage } from '../../apps/mcp/src/asset-schemas.js';

const report = { schemaVersion: 1, stage: 'mesh-validation', reasonCode: 'MESH_AUDIT', exceptionType: 'ValueError',
  metrics: { renderTriangles: 420, triangleBudget: 100, collisionTriangles: 12, invalidMeshes: 0, errorCount: 1 }, auditPath: 'audit.json' };
const secret = 'synthetic-private-key-DO-NOT-PERSIST';
const output = (value: unknown = report): CommandResult => ({ exitCode: 1, signal: null,
  stdout: `ARCANE_EVENT {"stage":"mesh-validation"}\n${secret}\nARCANE_FAILURE ${JSON.stringify(value)}\n`,
  stderr: `Traceback C:\\private\\source.py: ${secret}\nrequest: {"source":"private source text"}` });
const probe: CommandResult = { exitCode: 0, signal: null, stderr: '', stdout: 'ARCANE_RESULT ' + JSON.stringify({
  version: '4.5.0', pythonVersion: '3.11.0', background: true,
  capabilities: { glbExport: true, glbImport: true, fbxExport: true, fbxImport: true, cycles: true } }) + '\n' };
async function fixture(t: test.TestContext, generation: (spec: CommandSpec, options: CommandOptions) => Promise<CommandResult> = async () => output(), close = true) {
  const base = await realpath(tmpdir()), root = await mkdtemp(join(base, 'arcane-failure-test-'));
  t.after(async () => {
    const actual = await realpath(root), child = relative(base, actual);
    assert.ok(!isAbsolute(child) && child.startsWith('arcane-failure-test-') && !child.includes(sep) && !child.includes('..'));
    await rm(actual, { recursive: true, force: true });
  });
  const workers = join(root, 'workers'), outputRoot = join(root, 'assets'); await mkdir(workers);
  for (const name of ['asset_worker.py', 'audit.py', 'probe.py']) await writeFile(join(workers, name), '# fixed synthetic worker\n');
  const pipeline = new AssetPipeline({ workspaceRoot: root, outputRoot, workerRoot: workers }, {
    discover: async () => ({ blender: [process.execPath], python: [] }),
    queryHost: { platform: 'linux', systemRoot: undefined, execFile: () => { throw Error('Synthetic diagnostics cannot query processes.'); } },
    run: async (spec, options = {}) => {
      await options.supervise?.spawned({ pid: 12345, exited: () => true });
      if (spec.args.includes('--mode')) {
        try {
          const result = await generation(spec, options);
          for (const line of result.stdout.split('\n')) options.onLine?.(line);
          return result;
        } finally { if (close) options.supervise?.closed(); }
      }
      options.supervise?.closed(); return probe;
    },
  });
  return { root, outputRoot, pipeline };
}

test('worker failure identifies stage and reason, retains sanitized evidence and survives journal recovery', async t => {
  const f = await fixture(t), job = f.pipeline.start({ template: 'hero-prop', name: 'crate' }), result = await job.completion;
  assert.equal(result.state, 'failed'); assert.equal(result.error?.code, 'BLENDER_FAILED');
  assert.match(result.error!.message, /mesh-validation: Render triangle count 420 is outside 1\.\.100/);
  assert.match(result.error!.message, /failure\.json and audit\.json/);
  assert.deepEqual(result.error?.diagnostic?.metrics, report.metrics);
  assert.equal(result.error?.diagnostic?.reasonCode, 'MESH_AUDIT');
  const log = await readFile(join(job.directory, 'failure.json'), 'utf8'), journal = await readFile(join(job.directory, 'job.json'), 'utf8');
  for (const text of [log, journal, JSON.stringify(result.error)]) {
    assert.ok(!text.includes(secret)); assert.ok(!text.includes('private source text')); assert.ok(!text.includes('source.py'));
  }
  const evidence = JSON.parse(log); assert.equal(evidence.output.exitCode, 1);
  assert.equal(evidence.output.stderrBytes, Buffer.byteLength(output().stderr)); assert.match(evidence.output.stderrSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual((await f.pipeline.recover(job.directory)).result.error, result.error);
});

test('malformed and arbitrary worker failures fall back to stage plus observed exit without copying text', () => {
  for (const value of [{ ...report, reason: secret }, { ...report, exceptionType: secret }, { ...report, stage: '../secret' },
    { ...report, metrics: { source: secret } }, { ...report, auditPath: '../source.py' }, { ...report, reasonCode: secret }]) {
    const error = workerFailure(output(value), 'review-render');
    assert.equal(error.diagnostic?.reasonCode, 'WORKER_EXIT'); assert.equal(error.diagnostic?.stage, 'review-render');
    assert.match(error.message, /Exit code: 1/); assert.ok(!JSON.stringify(error).includes(secret));
  }
  const native = workerFailure({ ...output(), stdout: '', exitCode: null, signal: 'SIGTERM' }, 'export');
  assert.equal(native.diagnostic?.stage, 'export'); assert.match(native.message, /SIGTERM/);
  const located = workerFailure(output({ ...report, stage: 'export', reasonCode: 'BLENDER_API', exceptionType: 'AttributeError', artifactPath: 'asset.fbx' }), 'generate');
  assert.equal(located.diagnostic?.artifactPath, 'asset.fbx'); assert.match(located.message, /AttributeError; BLENDER_API/);
  assert.equal(workerFailure(output({ ...report, artifactPath: '../private.blend' }), 'export').diagnostic?.reasonCode, 'WORKER_EXIT');
});

test('journal decoder accepts legacy errors and rejects forged diagnostic text, paths and unbounded counters', () => {
  const legacy = { code: 'BLENDER_UNAVAILABLE', message: 'No installed runtime.' }; assert.deepEqual(decodeAssetJobError(legacy), legacy);
  const error = workerFailure(output(), 'generate');
  const valid = { code: error.code, message: error.message, diagnostic: { ...error.diagnostic!, logPath: 'failure.json' } };
  assert.deepEqual(decodeAssetJobError(valid), valid);
  for (const diagnostic of [{ ...valid.diagnostic, logPath: '../secret' }, { ...valid.diagnostic, reason: secret },
    { ...valid.diagnostic, metrics: { renderTriangles: 1e20 } }, { ...valid.diagnostic, source: secret }]) {
    assert.throws(() => decodeAssetJobError({ ...valid, diagnostic }), { code: 'RECOVERY' });
  }
});

test('service active and archived history and MCP assets_jobs retain actionable errors across reopen', async t => {
  const f = await fixture(t), handle = f.pipeline.start({ template: 'hero-prop', name: 'crate' }), result = await handle.completion;
  let service = await createAssetService({ cwd: resolve(process.cwd()), outputRoot: f.outputRoot });
  try {
    const page = service.jobPage(); assert.deepEqual(page.jobs[0]?.error, result.error);
    assert.deepEqual(assetJobPage.parse(page).jobs[0]?.error, result.error);
  } finally { await service.close(); }
  const archive = await AssetArchiveStore.open({ root: f.outputRoot });
  try { await archive.archive({ jobIds: [handle.id], activeCount: 1, guard: () => {}, facts: async () => ({ active: false, readPinned: false,
    importCaptured: false, preparationRecord: false, pendingStage: false, uncertainLatch: false, manifestVerified: false }) }); }
  finally { archive.close(); }
  service = await createAssetService({ cwd: resolve(process.cwd()), outputRoot: f.outputRoot });
  try {
    const page = await service.historyPage({ limit: 1 }); assert.equal(page.jobs[0]?.retention?.status, 'archived');
    assert.deepEqual(page.jobs[0]?.error, result.error); assert.deepEqual(assetJobPage.parse(page).jobs[0]?.error, result.error);
    assert.deepEqual((await service.lookupJobs([handle.id])).jobs[0]?.error, result.error);
  } finally { await service.close(); }
});

for (const [code, state] of [['CANCELLED', 'cancelled'], ['DEADLINE', 'timed_out']] as const) {
  test(`${code} keeps terminal truth when writing its diagnostic log fails`, async t => {
    const f = await fixture(t, async spec => { await mkdir(join(spec.cwd, 'failure.json')); throw new AssetError(code, 'Owned synthetic stop.'); });
    const handle = f.pipeline.start({ template: 'hero-prop', name: 'stopped' }), result = await handle.completion;
    assert.equal(result.state, state); assert.equal(result.error?.code, code); assert.equal(result.error?.diagnostic?.logPath, undefined);
    assert.match(result.error!.message, /generate/); assert.ok(!result.error!.message.includes('See failure.json'));
    assert.equal((await f.pipeline.recover(handle.directory)).result.state, state);
  });
}

test('diagnostic output cannot make an unobserved worker closure terminal', async t => {
  const f = await fixture(t, async () => output(), false), result = await f.pipeline.start({ template: 'hero-prop', name: 'unknown' }).completion;
  assert.equal(result.state, 'interrupted'); assert.equal(result.error?.code, 'SUPERVISION_UNRESOLVED');
  assert.match(result.error!.message, /closure was not observed/);
});
