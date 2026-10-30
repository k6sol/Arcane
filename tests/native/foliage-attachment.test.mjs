import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBounded, workerEnvironment } from '../../dist/packages/asset-pipeline/src/process.js';
import { atomicAssetJson } from '../../dist/packages/asset-pipeline/src/atomic-json.js';
import { noLinks, readRegularFile, regularFile } from '../../dist/packages/asset-pipeline/src/paths.js';
import { decodeMaterialPng, materialPngPixels } from '../../dist/packages/asset-pipeline/src/material-png.js';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sha = value => createHash('sha256').update(value).digest('hex');
const sourceNames = ['workers/blender/procedural.py', 'workers/blender/textures.py', 'tests/native/foliage-attachment.py'];
const sourceHashes = async () => Object.fromEntries(await Promise.all(sourceNames.map(async name => [name, sha(await readRegularFile(join(repository, name), 512 * 1024))])));

// Separate mandatory hosted test: the original conversion acceptance inventory,
// deadlines, source fixtures, supervisor and evidence names are untouched.
test('real Blender preserves a cupped foliage card declared root through native save/reopen', { timeout: 210000 }, async t => {
  const configured = process.env.ARCANE_TEST_BLENDER_EXECUTABLE;
  assert.ok(typeof configured === 'string' && isAbsolute(configured), 'Explicit owned pinned Blender is required; this native regression cannot skip.');
  assert.equal(process.env.ARCANE_TEST_BLENDER_VERSION, '5.2.3');
  const executable = await realpath(configured); await regularFile(executable, 512 * 1024 * 1024);
  const before = await sourceHashes(), base = await realpath(tmpdir());
  const root = await realpath(await mkdtemp(join(base, 'arcane-foliage-attachment-')));
  await mkdir(join(root, '.worker')); await noLinks(root);
  const evidence = join(repository, 'runtime', 'ci-foliage-attachment-artifacts');
  await mkdir(evidence); // Exclusive fresh evidence set, matching conversion's no-reuse boundary.
  const supervision = { spawned: false, pid: null, closed: false };
  let outcome = { exitCode: null, signal: null, errorCode: null }, native = null, checked = false;
  const cleanup = { temporaryDataRemoved: false, retainedForUnprovedClosure: false };
  const persist = complete => atomicAssetJson(evidence, 'foliage-attachment.json', JSON.stringify({ schemaVersion: 1,
    expectedVersion: '5.2.3', sourceHashes: before, supervision, outcome, native, complete, cleanup,
    studioOperations: 0, inferenceStarted: false, nativeStudioVerified: false }) + '\n');
  await persist(false);
  t.after(async () => {
    try {
      try {
        native = JSON.parse((await readRegularFile(join(root, 'native-foliage.json'), 65536)).toString('utf8'));
      } catch { native = null; }
      for (const name of ['foliage-front.png', 'foliage-side.png']) {
        try {
          const encoded = await readRegularFile(join(root, name), 8 * 1024 * 1024);
          const decoded = decodeMaterialPng(encoded); assert.equal(decoded.width, 512); assert.equal(decoded.height, 512);
          assert.equal(encoded[24], 8, 'Native PNG must retain 8-bit samples.');
          assert.equal(encoded[25], 6, 'Native PNG must retain the requested RGBA channels.');
          assert.equal(encoded[28], 0, 'Native PNG must be noninterlaced for the production decoder.');
          const pixels = materialPngPixels(decoded); assert.ok(pixels.some((value, index) => index % 4 < 3 && value !== pixels[index % 4]), 'Contact render must contain actual geometry contrast.');
          await writeFile(join(evidence, name), encoded, { flag: 'wx' });
        } catch (error) { if (error?.code !== 'ENOENT') throw error; }
      }
      if (supervision.closed) {
        const actual = await realpath(root), child = relative(base, actual);
        assert.ok(!isAbsolute(child) && child.startsWith('arcane-foliage-attachment-') && !child.includes(sep) && !child.includes('..'));
        await noLinks(actual); await rm(actual, { recursive: true, force: true }); cleanup.temporaryDataRemoved = true;
      } else { cleanup.retainedForUnprovedClosure = true; t.diagnostic('Owned data retained because child closure was not observed.'); }
    } finally { await persist(checked && supervision.closed && cleanup.temporaryDataRemoved); }
  });
  let result;
  try {
    result = await runBounded({ executable, cwd: root, env: workerEnvironment(join(root, '.worker')),
      args: ['--background', '--factory-startup', '--disable-autoexec', '--threads', '2', '--python-exit-code', '1',
        '--python', join(repository, 'tests', 'native', 'foliage-attachment.py'), '--', '--directory', root,
        '--worker-sha256', before['workers/blender/procedural.py']] },
    { deadlineMs: 180000, maxOutputBytes: 2 * 1024 * 1024, supervise: {
      spawned: async info => { supervision.spawned = true; supervision.pid = info.pid ?? null; await persist(false); return 'continue'; },
      closed: () => { supervision.closed = true; },
    } });
    outcome = { exitCode: result.exitCode, signal: result.signal, errorCode: null };
  } catch (error) { outcome.errorCode = typeof error?.code === 'string' && /^[A-Z_]{1,64}$/.test(error.code) ? error.code : 'NATIVE_TEST_FAILED'; throw error; }
  assert.equal(supervision.closed, true, 'Only the observed owned close permits cleanup.');
  assert.equal(result.exitCode, 0, result.stdout + '\n' + result.stderr); assert.equal(result.signal, null);
  assert.deepEqual(await sourceHashes(), before, 'Actual imported production sources must remain unchanged.');
  native = JSON.parse((await readRegularFile(join(root, 'native-foliage.json'), 65536)).toString('utf8'));
  assert.equal(native.schemaVersion, 1); assert.deepEqual(native.versionTuple, [5, 2, 3]);
  assert.match(native.version, /^5\.2\.3(?: LTS)?$/); assert.equal(native.complete, true);
  assert.equal(native.workerSha256, before['workers/blender/procedural.py']); assert.equal(native.texturesSha256, before['workers/blender/textures.py']);
  assert.equal(native.cases.length, 39); assert.deepEqual(native.failures, []); assert.equal(native.savedSceneReopened, true);
  assert.ok(native.cases.every(item => item.vertices === 8 && item.triangles === 12 && item.nativeRootErrorMeters <= 4e-6));
  assert.ok(native.contactGapMeters <= 4e-6); assert.equal(native.atlasDiagnostics.length, 24);
  assert.equal(native.nativeStudioVerified, false);
  checked = true;
});
