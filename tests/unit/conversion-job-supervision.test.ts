import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { AssetPipeline, AssetError, type GlbConversionInput } from '../../packages/asset-pipeline/src/index.js';
import { snapshotGlbConversionInput, prepareRetainedGlbConversionInput } from '../../packages/asset-pipeline/src/conversion-input.js';
import type { CommandOptions, CommandResult, CommandSpec } from '../../packages/asset-pipeline/src/process.js';
import { validateGlb } from '../../apps/desktop/src/glb-preflight.js';

const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
function input(): GlbConversionInput {
  const positions = Buffer.alloc(36);
  [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((value, index) => positions.writeFloatLE(value, index * 4));
  const doc = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], accessors: [{ bufferView: 0, componentType: 5126, type: 'VEC3', count: 3, min: [0, 0, 0], max: [1, 1, 0] }],
    bufferViews: [{ buffer: 0, byteLength: positions.length }], buffers: [{ byteLength: positions.length }] };
  const json = Buffer.from(JSON.stringify(doc)), padded = Buffer.alloc((json.length + 3) & ~3, 32); json.copy(padded);
  const header = Buffer.alloc(20), binHeader = Buffer.alloc(8);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(20 + padded.length + 8 + positions.length, 8);
  header.writeUInt32LE(padded.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  binHeader.writeUInt32LE(positions.length, 0); binHeader.writeUInt32LE(0x004e4942, 4);
  const sourceGlb = Buffer.concat([header, padded, binHeader, positions]);
  const request = { schemaVersion: 1, template: 'adopted-glb', name: 'retained', path: 'models/retained.glb', sourceSha256: sha(sourceGlb), sourceBytes: sourceGlb.length };
  const parentManifest = Buffer.from(JSON.stringify({ schemaVersion: 1, jobId: randomUUID(), createdAt: '2026-10-26T12:00:00.000Z', request,
    provenance: { kind: 'native-project-glb', projectId: 'a'.repeat(64), conversation: { provider: 'codex', threadId: 'conversion-fixture', sessionId: null },
      sourceSha256: sha(sourceGlb), sourceBytes: sourceGlb.length },
    validation: { kind: 'glb-preview-preflight', metadata: validateGlb(Uint8Array.from(sourceGlb).buffer), imageDecode: 'not-run', engineVerification: 'pending' },
    engineImport: { status: 'unavailable', reason: 'adopted-origin-requires-safe-conversion' },
    artifacts: [{ path: 'asset.glb', role: 'export', bytes: sourceGlb.length, sha256: sha(sourceGlb) },
      { path: 'request.json', role: 'request', bytes: 2, sha256: sha('{}') }], limitations: [] }));
  return { sourceGlb, parentManifest, parentManifestSha256: sha(parentManifest), name: 'converted', collision: 'none', renderResolution: 128, renderSamples: 1 };
}
const secret = 'private-native-traceback-not-for-retained-errors';
const output = (): CommandResult => ({ exitCode: 1, signal: null, stderr: secret,
  stdout: secret + '\nARCANE_FAILURE {"stage":"source-map","reason":"MAP","type":"conversion-refused"}\n' });
const probe: CommandResult = { exitCode: 0, signal: null, stderr: '', stdout: 'ARCANE_RESULT ' + JSON.stringify({
  version: '5.2.3', pythonVersion: '3.11.0', background: true,
  capabilities: { glbExport: true, glbImport: true, fbxExport: true, fbxImport: true, cycles: true } }) + '\n' };
async function fixture(t: test.TestContext, convert: (spec: CommandSpec, options: CommandOptions) => Promise<CommandResult> = async () => output(), close = true, probeResult: CommandResult = probe) {
  const base = await realpath(tmpdir()), root = await mkdtemp(join(base, 'arcane-conversion-supervision-'));
  const workers = join(root, 'workers'), outputRoot = join(root, 'assets'); await mkdir(workers);
  for (const name of ['probe.py', 'convert_glb.py', 'conversion_audit.py']) await writeFile(join(workers, name), '# synthetic fixed worker: never executed\n');
  const calls: CommandSpec[] = [], deferredClosures: (() => void)[] = [];
  t.after(async () => {
    for (const closed of deferredClosures) closed();
    // Only the exact owned direct temporary child is removed.
    const actual = await realpath(root), child = relative(base, actual);
    assert.ok(!isAbsolute(child) && child.startsWith('arcane-conversion-supervision-') && !child.includes(sep) && !child.includes('..'));
    await rm(actual, { recursive: true, force: true });
  });
  const pipeline = new AssetPipeline({ workspaceRoot: root, outputRoot, workerRoot: workers }, {
    discover: async () => ({ blender: [process.execPath], python: [] }),
    queryHost: { platform: 'linux', systemRoot: undefined, execFile: () => { throw Error('Synthetic fixture cannot query native processes.'); } },
    run: async (spec, options = {}) => {
      calls.push(spec); await options.supervise?.spawned({ pid: 12345, exited: () => true });
      if (!spec.args.some(argument => argument.endsWith('convert_glb.py'))) { options.supervise?.closed(); return probeResult; }
      try {
        const result = await convert(spec, options);
        for (const line of result.stdout.split('\n')) options.onLine?.(line);
        return result;
      } finally {
        if (close) options.supervise?.closed();
        else if (options.supervise) deferredClosures.push(() => options.supervise!.closed());
      }
    },
  });
  return { root, pipeline, calls };
}

test('conversion captures independent source and parent bytes before asynchronous inspection', () => {
  const original = input(), captured = snapshotGlbConversionInput(original), sourceHash = sha(captured.sourceGlb);
  original.sourceGlb.fill(0); original.parentManifest.fill(0);
  assert.equal(sha(captured.sourceGlb), sourceHash);
  const prepared = prepareRetainedGlbConversionInput(captured);
  assert.equal(prepared.source.parts.length, 1); assert.equal(prepared.source.parts[0]?.triangles, 1);
  assert.equal(prepared.parent.engineImport.status, 'unavailable');
});

test('conversion input refuses outer proxies and getters before calling user code', () => {
  let called = 0;
  const proxy = new Proxy({}, { get() { called++; throw Error('must not run'); }, getPrototypeOf() { called++; throw Error('must not run'); }, ownKeys() { called++; throw Error('must not run'); } });
  assert.throws(() => snapshotGlbConversionInput(proxy));
  const getter = input(); Object.defineProperty(getter, 'sourceGlb', { enumerable: true, get() { called++; throw Error('must not run'); } });
  assert.throws(() => snapshotGlbConversionInput(getter)); assert.equal(called, 0);
  assert.throws(() => snapshotGlbConversionInput({ ...input(), name: 'converted\n' }));
});

test('source snapshot ignores Buffer shadow accessors and refuses shared memory', () => {
  const original = input(); let called = 0;
  for (const name of ['buffer', 'length', 'byteOffset', 'byteLength']) Object.defineProperty(original.sourceGlb, name, { get() { called++; throw Error('must not run'); } });
  assert.ok(snapshotGlbConversionInput(original).sourceGlb.length > 20); assert.equal(called, 0);
  assert.throws(() => snapshotGlbConversionInput({ ...input(), sourceGlb: Buffer.from(new SharedArrayBuffer(32)) }));
});

test('actual source and parent hashes, metadata and duplicate JSON keys are checked before native work', () => {
  const original = input();
  assert.throws(() => snapshotGlbConversionInput({ ...original, parentManifestSha256: '0'.repeat(64) }));
  const captured = snapshotGlbConversionInput(original), last = captured.sourceGlb.length - 1;
  captured.sourceGlb[last] = captured.sourceGlb[last]! ^ 1;
  assert.throws(() => prepareRetainedGlbConversionInput(captured));
  for (const change of ['metadata', 'duplicate']) {
    const value = input(), parent = JSON.parse(value.parentManifest.toString('utf8'));
    if (change === 'metadata') { parent.validation.metadata.nodeCount++; value.parentManifest = Buffer.from(JSON.stringify(parent)); }
    else value.parentManifest = Buffer.from(value.parentManifest.toString('utf8').replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'));
    value.parentManifestSha256 = sha(value.parentManifest);
    assert.throws(() => prepareRetainedGlbConversionInput(snapshotGlbConversionInput(value)));
  }
});

test('conversion returns a handle then records precise failure and fixed argv without leaking native text', async t => {
  const f = await fixture(t), original = input(), job = f.pipeline.startConversion(original);
  assert.equal(f.calls.length, 0); assert.notEqual(job.id, JSON.parse(original.parentManifest.toString()).jobId);
  const result = await job.completion;
  assert.equal(result.state, 'failed'); assert.equal(result.error?.code, 'BLENDER_FAILED');
  assert.equal(result.error?.diagnostic?.stage, 'source-map'); assert.equal(result.error?.diagnostic?.reasonCode, 'CONVERSION_MAP');
  assert.match(result.error!.message, /source primitive map/);
  assert.equal(f.calls.length, 2);
  assert.equal(await realpath(f.calls[0]!.args[f.calls[0]!.args.indexOf('--python') + 1]!), await realpath(join(job.directory, 'probe.py')));
  const spec = f.calls[1]!;
  for (const option of ['--background', '--factory-startup', '--disable-autoexec', '--threads', '--python-exit-code', '--request-sha256']) assert.ok(spec.args.includes(option));
  assert.equal(spec.args[spec.args.indexOf('--threads') + 1], '2');
  assert.equal(spec.args[spec.args.indexOf('--python-exit-code') + 1], '1');
  assert.equal(spec.env?.PYTHONNOUSERSITE, '1'); assert.equal(spec.env?.PYTHONDONTWRITEBYTECODE, '1');
  assert.deepEqual(await readFile(join(job.directory, 'source.glb')), original.sourceGlb);
  assert.deepEqual(await readFile(join(job.directory, 'parent-manifest.json')), original.parentManifest);
  const log = await readFile(join(job.directory, 'failure.json'), 'utf8'), journalText = await readFile(join(job.directory, 'job.json'), 'utf8');
  for (const text of [log, journalText, JSON.stringify(result)]) assert.ok(!text.includes(secret));
  const journal = JSON.parse(journalText);
  assert.equal(journal.kind, 'converted-glb'); assert.equal(journal.request.kind, 'converted-glb');
  assert.ok(journal.workers.every((worker: { state: string }) => worker.state === 'closed'));
  assert.deepEqual((await f.pipeline.recover(job.directory)).result.error, result.error);
});

test('an exit-zero result without an actual audit file never becomes a converted success', async t => {
  const f = await fixture(t, async () => ({ stdout: 'ARCANE_RESULT {"audit":"conversion-audit.json"}', stderr: '', exitCode: 0, signal: null }));
  const result = await f.pipeline.startConversion(input()).completion;
  assert.equal(result.state, 'failed'); assert.equal(result.manifestPath, null); assert.equal(result.error?.diagnostic?.stage, 'host-validation');
});

test('cancel before inspection starts no native worker and remains recoverably cancelled', async t => {
  const f = await fixture(t), job = f.pipeline.startConversion(input()); job.cancel();
  const result = await job.completion;
  assert.equal(result.state, 'cancelled'); assert.equal(result.error?.code, 'CANCELLED'); assert.equal(f.calls.length, 0);
  assert.equal((await f.pipeline.recover(job.directory)).result.state, 'cancelled');
});

for (const [code, state] of [['CANCELLED', 'cancelled'], ['DEADLINE', 'timed_out']] as const) {
  test(`conversion preserves ${code} after observed close even when the failure log cannot be saved`, async t => {
    const f = await fixture(t, async spec => { const directory = spec.args[spec.args.indexOf('--directory') + 1]!; await mkdir(join(directory, 'failure.json')); throw new AssetError(code, 'Synthetic owned stop.'); });
    const job = f.pipeline.startConversion(input()), result = await job.completion;
    assert.equal(result.state, state); assert.equal(result.error?.code, code); assert.equal(result.error?.diagnostic?.logPath, undefined);
    assert.equal((await f.pipeline.recover(job.directory)).result.state, state);
  });
}

test('conversion with unobserved child closure stays interrupted and holds its operation slot', async t => {
  const f = await fixture(t, async () => output(), false);
  const first = f.pipeline.startConversion(input()), firstResult = await first.completion;
  assert.equal(firstResult.state, 'interrupted'); assert.equal(firstResult.error?.code, 'SUPERVISION_UNRESOLVED');
  await assert.rejects(f.pipeline.recover(first.directory), { code: 'BUSY' });
  const second = f.pipeline.startConversion({ ...input(), name: 'second' }); await second.completion;
  assert.throws(() => f.pipeline.startConversion({ ...input(), name: 'third' }), { code: 'BUSY' });
});

test('conversion retains the actual failed runtime probe reason without starting generation or leaking loader paths', async t => {
  const privatePath = '/private-native-runtime-directory/blender';
  const loader: CommandResult = { exitCode: 127, signal: null, stdout: '', stderr:
    privatePath + ': error while loading shared libraries: libXxf86vm.so.1: cannot open shared object file: No such file or directory\n' };
  const f = await fixture(t, async () => { throw Error('Generation must not start after a failed runtime probe.'); }, true, loader);
  const job = f.pipeline.startConversion(input()), result = await job.completion;
  assert.equal(f.calls.length, 1); assert.equal(result.state, 'failed'); assert.equal(result.error?.code, 'BLENDER_UNAVAILABLE');
  assert.equal(result.error?.diagnostic?.stage, 'probe'); assert.equal(result.error?.diagnostic?.reasonCode, 'RUNTIME_LIB_XXF86VM');
  assert.match(result.error!.diagnostic!.reason, /libXxf86vm\.so\.1/);
  assert.equal(result.manifestPath, null);
  const journal = JSON.parse(await readFile(join(job.directory, 'job.json'), 'utf8'));
  assert.equal(journal.workers.length, 1); assert.equal(journal.workers[0].role, 'probe'); assert.equal(journal.workers[0].state, 'closed');
  const failure = await readFile(join(job.directory, 'failure.json'), 'utf8');
  for (const value of [JSON.stringify(result), JSON.stringify(journal), failure]) assert.ok(!value.includes(privatePath));
  assert.deepEqual((await f.pipeline.recover(job.directory)).result.error, result.error);
});
