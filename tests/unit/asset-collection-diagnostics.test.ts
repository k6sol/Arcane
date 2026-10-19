import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { AssetError, AssetPipeline } from '../../packages/asset-pipeline/src/index.js';
import { hostFailure } from '../../packages/asset-pipeline/src/failure-diagnostics.js';
import { manifestFixture } from '../../packages/asset-pipeline/testing/fixture.js';
import type { AssetJobResult } from '../../packages/asset-pipeline/src/types.js';

// Real pipeline, filesystem and journals; explicit inert worker port, no native process.
// Builtin fault hooks are serial, restored explicitly, and synchronized for named ESM imports.
const realFs = { ...fs }, serial = { concurrency: false }, secret = 'private-filesystem-token';
async function fixture(t: test.TestContext, mutate?: (directory: string) => Promise<void>) {
  const base = await realFs.realpath(tmpdir()), root = await realFs.mkdtemp(join(base, 'arcane-collection-diagnostics-'));
  t.after(async () => {
    const child = relative(base, await realFs.realpath(root));
    assert.ok(!isAbsolute(child) && child.startsWith('arcane-collection-diagnostics-') && !child.includes(sep) && !child.includes('..'));
    await realFs.rm(root, { recursive: true, force: true });
  });
  const workers = join(root, 'workers'), outputRoot = join(root, 'jobs'); await realFs.mkdir(workers);
  for (const name of ['asset_worker.py', 'audit.py', 'probe.py']) await realFs.writeFile(join(workers, name), '# inert synthetic worker\n');
  const calls = { probe: 0, generation: 0 };
  const pipeline = new AssetPipeline({ workspaceRoot: root, outputRoot, workerRoot: workers }, {
    discover: async () => ({ blender: [process.execPath], python: [] }),
    queryHost: { platform: 'linux', systemRoot: undefined, execFile: () => { throw Error('Collection tests must never query native processes.'); } },
    run: async (spec, options = {}) => {
      await options.supervise?.spawned({ pid: 12345, exited: () => true });
      try {
        if (spec.args.includes('--mode')) {
          calls.generation++; await manifestFixture(spec.cwd); await mutate?.(spec.cwd);
          return { exitCode: 0, signal: null, stdout: 'ARCANE_RESULT {"audit":"audit.json"}\n', stderr: '' };
        }
        calls.probe++;
        return { exitCode: 0, signal: null, stderr: '', stdout: 'ARCANE_RESULT ' + JSON.stringify({ version: '4.5.0', pythonVersion: '3.11.0', background: true,
          capabilities: { glbExport: true, glbImport: true, fbxExport: true, fbxImport: true, cycles: true } }) + '\n' };
      } finally { options.supervise?.closed(); }
    },
  });
  const start = (options = {}) => pipeline.start({ template: 'environment-kit', name: 'test-kit', renderResolution: 128 }, options);
  return { root, workers, outputRoot, pipeline, calls, start };
}
async function verifyFailure(f: Awaited<ReturnType<typeof fixture>>, result: AssetJobResult, name: string, code = 'ARTIFACT', workers = 2) {
  assert.equal(result.state, 'failed'); assert.equal(result.error?.code, code); assert.equal(result.manifestPath, null);
  assert.equal(result.error!.diagnostic?.stage, workers === 2 ? 'host-validation' : 'probe');
  assert.match(result.error!.message, new RegExp('^Asset failed at ' + (workers === 2 ? 'host-validation' : 'probe') + ': ' + name.replace('.', '\\.') + ':'));
  assert.ok(!result.error!.message.includes(f.root)); assert.ok(!JSON.stringify(result.error).includes(secret));
  assert.ok(!JSON.stringify(result.error).includes('cause'));
  const journal = JSON.parse(await realFs.readFile(join(result.directory, 'job.json'), 'utf8'));
  assert.equal(journal.workers.length, workers); assert.ok(journal.workers.every((worker: { state: string }) => worker.state === 'closed'));
  const before = { ...f.calls }; assert.deepEqual((await f.pipeline.recover(result.directory)).result.error, result.error); assert.deepEqual(f.calls, before);
  return journal;
}

for (const name of ['asset.glb', 'collision.glb', 'preview-side.png', 'asset.fbx']) test(`initial artifact collection names an actual missing ${name}`, serial, async t => {
  const f = await fixture(t, directory => realFs.rm(join(directory, name))), result = await f.start().completion;
  await verifyFailure(f, result, name); assert.match(result.error!.message, /Required artifact is missing/); assert.equal(f.calls.generation, 1);
});

test('initial audit read names a missing audit.json before collection begins', serial, async t => {
  const f = await fixture(t, directory => realFs.rm(join(directory, 'audit.json'))), result = await f.start().completion;
  await verifyFailure(f, result, 'audit.json'); assert.match(result.error!.message, /Required artifact is missing/);
});

test('initial audit rejection retains existing mesh context without duplicating its filename', serial, async t => {
  const f = await fixture(t, async directory => {
    const path = join(directory, 'audit.json'), audit = JSON.parse(await realFs.readFile(path, 'utf8'));
    audit.meshes[0].duplicateVertices = 3; await realFs.writeFile(path, JSON.stringify(audit));
  });
  const result = await f.start().completion; assert.equal(result.state, 'failed'); assert.equal(result.error?.code, 'MESH');
  assert.match(result.error!.message, /^Asset failed at host-validation: audit\.json mesh\[0\]: duplicateVertices is 3; required 0\./);
  assert.ok(!result.error!.message.includes('audit.json: audit.json')); assert.equal((await f.pipeline.recover(result.directory)).result.error?.message, result.error!.message);
  assert.equal(f.calls.generation, 1);
});

for (const kind of ['empty', 'directory'] as const) test(`initial collection preserves domain rejection for an actual ${kind} artifact`, serial, async t => {
  const f = await fixture(t, async directory => {
    const path = join(directory, 'asset.glb');
    if (kind === 'empty') await realFs.writeFile(path, ''); else { await realFs.rm(path); await realFs.mkdir(path); }
  });
  const result = await f.start().completion; await verifyFailure(f, result, 'asset.glb');
  assert.match(result.error!.message, /Artifact is empty, oversized or not a regular file/);
});

for (const replacement of ['missing', 'directory'] as const) test(`a real filesystem open failure after regular-file checks is bounded: ${replacement}`, serial, async t => {
  const f = await fixture(t); let intercepted = false, nativeError: NodeJS.ErrnoException | undefined;
  const mock = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    if (!intercepted && typeof args[0] === 'string' && basename(args[0]) === 'asset.glb' && args[0].startsWith(f.outputRoot)) {
      intercepted = true; await realFs.rm(args[0]); if (replacement === 'directory') await realFs.mkdir(args[0]);
      try { return await realFs.open(...args); } catch (error) { nativeError = error as NodeJS.ErrnoException; throw error; }
    }
    return realFs.open(...args);
  });
  syncBuiltinESMExports();
  try {
    const result = await f.start().completion; assert.equal(intercepted, true);
    await verifyFailure(f, result, 'asset.glb');
    if (replacement === 'missing') { assert.equal(nativeError?.code, 'ENOENT'); assert.match(result.error!.message, /Required artifact is missing/); }
    else assert.match(result.error!.message, /could not be read safely|not a bounded regular file/);
    if (nativeError) assert.ok(!result.error!.message.includes(nativeError.message));
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
});

test('an existing AssetError keeps identity, code, diagnostic and original cause through collection', serial, async t => {
  const f = await fixture(t), diagnostic = hostFailure('host-validation'), cause = new Error(secret);
  const original = new AssetError('OUTPUT_PATH', 'Synthetic domain path refusal.', diagnostic); Object.defineProperty(original, 'cause', { value: cause });
  let thrown = 0;
  const mock = t.mock.method(fs, 'stat', async (...args: Parameters<typeof fs.stat>) => {
    if (typeof args[0] === 'string' && basename(args[0]) === 'asset.glb' && args[0].startsWith(f.outputRoot)) { thrown++; throw original; }
    return realFs.stat(...args);
  });
  syncBuiltinESMExports();
  try {
    const result = await f.start().completion; await verifyFailure(f, result, 'asset.glb', 'OUTPUT_PATH');
    assert.equal(thrown, 1); assert.equal(original.message, 'asset.glb: Synthetic domain path refusal.');
    assert.equal(original.code, 'OUTPUT_PATH'); assert.equal(original.diagnostic, diagnostic); assert.equal(result.error!.diagnostic, diagnostic);
    assert.equal(original.cause, cause); assert.equal(Object.getOwnPropertyDescriptor(original, 'cause')?.enumerable, false);
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
});

for (const name of ['probe.py', 'audit.py']) test(`trusted worker lookup names missing ${name} without starting generation`, serial, async t => {
  const f = await fixture(t); await realFs.rm(join(f.workers, name)); const result = await f.start().completion;
  await verifyFailure(f, result, name, 'ARTIFACT', name === 'probe.py' ? 0 : 1);
  assert.equal(f.calls.probe, name === 'probe.py' ? 0 : 1); assert.equal(f.calls.generation, 0);
});

test('public probe retains the actual native missing-file cause internally without serializing its path', serial, async t => {
  const f = await fixture(t); await realFs.rm(join(f.workers, 'probe.py'));
  await assert.rejects(f.pipeline.probe(), error => {
    assert.ok(error instanceof AssetError); assert.equal(error.code, 'ARTIFACT'); assert.equal(error.message, 'probe.py: Required artifact is missing.');
    assert.equal((error.cause as NodeJS.ErrnoException).code, 'ENOENT'); assert.equal(Object.getOwnPropertyDescriptor(error, 'cause')?.enumerable, false);
    assert.ok(!JSON.stringify(error).includes(f.root)); assert.ok(!JSON.stringify(error).includes('cause'));
    return true;
  });
  assert.deepEqual(f.calls, { probe: 0, generation: 0 });
});

test('trusted worker copy failure names its script without changing probe stage or replaying generation', serial, async t => {
  const f = await fixture(t), mock = t.mock.method(fs, 'copyFile', async (...args: Parameters<typeof fs.copyFile>) => {
    if (typeof args[0] === 'string' && basename(args[0]) === 'audit.py' && typeof args[1] === 'string' && args[1].startsWith(f.outputRoot)) {
      await realFs.rm(args[0]); return realFs.copyFile(...args);
    }
    return realFs.copyFile(...args);
  });
  syncBuiltinESMExports();
  try { const result = await f.start().completion; await verifyFailure(f, result, 'audit.py', 'ARTIFACT', 1); assert.equal(f.calls.generation, 0); }
  finally { mock.mock.restore(); syncBuiltinESMExports(); }
});

test('successful collection still creates a validated manifest and recovers without generation replay', serial, async t => {
  const f = await fixture(t), result = await f.start().completion;
  assert.equal(result.state, 'succeeded'); assert.equal(result.error, null); assert.ok(result.manifestPath);
  assert.equal((await f.pipeline.validate(result.manifestPath!)).jobId, result.jobId);
  assert.equal((await f.pipeline.recover(result.directory)).result.state, 'succeeded'); assert.deepEqual(f.calls, { probe: 1, generation: 1 });
  const journal = JSON.parse(await realFs.readFile(join(result.directory, 'job.json'), 'utf8'));
  assert.equal(journal.workers.length, 2); assert.ok(journal.workers.every((worker: { state: string }) => worker.state === 'closed'));
});

test('cancellation after worker completion keeps cancellation truth before collection', serial, async t => {
  const controller = new AbortController(), f = await fixture(t, async directory => { await realFs.rm(join(directory, 'asset.glb')); controller.abort(); });
  const result = await f.start({ signal: controller.signal }).completion;
  assert.equal(result.state, 'cancelled'); assert.equal(result.error?.code, 'CANCELLED'); assert.equal(result.error?.diagnostic?.stage, 'host-validation');
  assert.ok(!result.error!.message.includes('asset.glb:')); assert.equal(f.calls.generation, 1);
  assert.equal((await f.pipeline.recover(result.directory)).result.state, 'cancelled'); assert.equal(f.calls.generation, 1);
});

test('deadline expiry after worker completion remains a timeout instead of a missing-artifact failure', serial, async t => {
  const now = Date.now(); let mock: ReturnType<typeof t.mock.method> | undefined;
  const f = await fixture(t, async directory => { await realFs.rm(join(directory, 'asset.glb')); mock = t.mock.method(Date, 'now', () => now + 600001); });
  try {
    const result = await f.start().completion;
    assert.equal(result.state, 'timed_out'); assert.equal(result.error?.code, 'DEADLINE'); assert.equal(result.error?.diagnostic?.stage, 'host-validation');
    assert.ok(!result.error!.message.includes('asset.glb:')); assert.equal(f.calls.generation, 1);
    assert.equal((await f.pipeline.recover(result.directory)).result.state, 'timed_out'); assert.equal(f.calls.generation, 1);
  } finally { mock?.mock.restore(); }
});
