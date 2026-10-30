import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AssetPipeline, normalizeRequest } from '../../dist/packages/asset-pipeline/src/index.js';
import { validateManifestFiles, workerScripts, workerSourcePath } from '../../dist/packages/asset-pipeline/src/validation.js';
import { readRegularFile } from '../../dist/packages/asset-pipeline/src/paths.js';
import { parseWorkerRecords } from '../../dist/packages/asset-pipeline/src/worker-journal.js';
import { decodeMaterialPng, materialPngPixels } from '../../dist/packages/asset-pipeline/src/material-png.js';
import { captureFailureAudit } from './tree-structure-evidence.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const input = { template: 'procedural', name: 'tree-structure-proof', seed: 31, triangleBudget: 16000,
  renderResolution: 512, renderSamples: 16,
  procedural: { kind: 'tree', species: 'oak', height: 9, trunkTaper: .55, branchLevels: 3, leafDensity: .7, finish: 'natural' } };

test('original Blender tree retains its exact-source structure sheet through export and reopen', { timeout: 210000 }, async t => {
  const executable = process.env.ARCANE_TEST_BLENDER_EXECUTABLE, receiptPath = process.env.ARCANE_TEST_BLENDER_RUNTIME_RECEIPT;
  assert.ok(typeof executable === 'string' && isAbsolute(executable));
  assert.ok(typeof receiptPath === 'string' && isAbsolute(receiptPath));
  assert.equal(process.env.ARCANE_TEST_BLENDER_VERSION, '5.2.3');
  const receiptBytes = await readRegularFile(receiptPath, 65536), receipt = JSON.parse(receiptBytes);
  assert.equal(receipt.schemaVersion, 1); assert.equal(receipt.kind, 'arcane-blender-test-runtime');
  assert.equal(receipt.version, '5.2.3'); assert.equal(receipt.platform, process.platform); assert.equal(receipt.executableRun, false);
  const pins = { linux: ['blender-5.2.3-linux-x64.tar.xz', 385331224, '78486c018b4443efe5e75ab54c290ed8c15abafd249b862c2c9ce2530a918eec'],
    win32: ['blender-5.2.3-windows-x64.zip', 405839452, '723f08a4401502561eb763cdeacf8745b31e5f3f154d287d3830d97cf75dc2fb'] };
  const pin = pins[process.platform]; assert.ok(pin);
  assert.deepEqual(receipt.archive, { url: 'https://download.blender.org/release/Blender5.2/' + pin[0], bytes: pin[1], sha256: pin[2] });
  const executableBytes = await readRegularFile(executable, 512 * 1024 * 1024);
  assert.equal(executableBytes.length, receipt.executableBytes); assert.equal(sha(executableBytes), receipt.executableSha256);
  const root = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'arcane-native-tree-structure-')));
  const retained = join(repository, 'runtime/ci-tree-structure-artifacts'); await mkdir(retained, { recursive: true });
  const evidence = { schemaVersion: 1, kind: 'arcane-original-tree-structure', runtimeReceiptSha256: sha(receiptBytes),
    request: normalizeRequest(input), stages: [], result: null, workers: [], artifacts: [], sources: {},
    failureAudit: { schemaVersion: 1, state: 'not-read', reason: 'closure-unconfirmed' },
    modelArtQualityAccepted: false, studioImported: false, uploaded: false };
  try {
    const workerRoot = join(repository, 'workers/blender');
    for (const name of workerScripts(evidence.request)) evidence.sources[name] = sha(await readRegularFile(join(workerRoot, ...workerSourcePath(name)), 512 * 1024));
    const pipeline = new AssetPipeline({ workspaceRoot: root, outputRoot: join(root, 'assets'), workerRoot, blenderExecutable: executable });
    const job = pipeline.start(input, { deadlineMs: 180000, signal: t.signal, onEvent(event) {
      if (!evidence.stages.includes(event.stage) && evidence.stages.length < 32) evidence.stages.push(event.stage);
    } });
    const result = await job.completion;
    evidence.result = { state: result.state, code: result.error?.code ?? null, diagnostic: result.error?.diagnostic ?? null };
    const journal = JSON.parse((await readRegularFile(join(job.directory, 'job.json'), 1024 * 1024)).toString());
    assert.equal(journal.jobId, job.id); assert.equal(journal.directory, job.directory);
    const workers = parseWorkerRecords(journal.workers); assert.ok(workers && workers.length <= 6);
    evidence.workers = workers.map(worker => ({ role: worker.role, state: worker.state, closure: worker.closure ?? null }));
    assert.ok(workers.every(worker => worker.state === 'closed' && worker.closure === 'exit-observed'));
    if (result.state === 'succeeded') evidence.failureAudit = { schemaVersion: 1, state: 'not-needed' };
    else {
      try { evidence.failureAudit = await captureFailureAudit(job.directory, evidence.request.name, readRegularFile); }
      catch { evidence.failureAudit = { schemaVersion: 1, state: 'unavailable', reason: 'capture-failed' }; }
    }
    assert.equal(result.state, 'succeeded', JSON.stringify(evidence.result));
    for (const role of ['generate', 'probe', 'python-probe']) assert.equal(workers.filter(worker => worker.role === role).length, 1);
    assert.equal(result.manifestPath, join(job.directory, 'manifest.json'));
    const manifest = await validateManifestFiles(job.directory, JSON.parse((await readRegularFile(result.manifestPath, 1024 * 1024)).toString()));
    assert.deepEqual(manifest.request, evidence.request); assert.equal(manifest.jobId, job.id);
    assert.equal(manifest.validation.savedSceneReopened, true); assert.deepEqual(manifest.validation.errors, []);
    assert.deepEqual((await pipeline.validate(result.manifestPath, { deep: true, signal: t.signal })).validation, manifest.validation);
    const reopenedJournal = JSON.parse((await readRegularFile(join(job.directory, 'job.json'), 1024 * 1024)).toString());
    const reopenedWorkers = parseWorkerRecords(reopenedJournal.workers); assert.ok(reopenedWorkers && reopenedWorkers.length <= 6);
    assert.ok(reopenedWorkers.every(worker => worker.state === 'closed' && worker.closure === 'exit-observed'));
    evidence.workers = reopenedWorkers.map(worker => ({ role: worker.role, state: worker.state, closure: worker.closure ?? null }));
    const structure = manifest.validation.treeStructure; assert.ok(structure);
    assert.deepEqual(structure.views, ['front', 'side', 'oblique', 'roots']);
    assert.equal(structure.requestSha256, manifest.artifacts.find(row => row.path === 'request.json').sha256);
    const bark = manifest.validation.meshes.filter(row => row.role === 'render' && row.name === 'SM_' + manifest.request.name + '_bark');
    assert.equal(bark.length, 1); assert.equal(bark[0].geometrySha256, structure.sourceObjects[0].geometrySha256);
    evidence.structure = structure;
    for (const path of ['preview-hero.png', 'preview-side.png', 'preview-structure.png']) {
      const artifact = manifest.artifacts.find(row => row.path === path && row.role === 'preview'); assert.ok(artifact);
      const bytes = await readRegularFile(join(job.directory, path), 8 * 1024 * 1024);
      assert.equal(bytes.length, artifact.bytes); assert.equal(sha(bytes), artifact.sha256);
      const decoded = decodeMaterialPng(bytes); assert.ok(decoded); assert.equal(decoded.width, 512); assert.equal(decoded.height, 512);
      if (path === 'preview-structure.png') {
        const pixels = materialPngPixels(decoded);
        for (const [x, y] of [[0, 0], [256, 0], [0, 256], [256, 256]]) {
          let low = Infinity, high = -Infinity;
          for (let yy = y + 4; yy < y + 252; yy++) for (let xx = x + 4; xx < x + 252; xx++) {
            const at = (yy * 512 + xx) * 4, value = .2126 * pixels[at] + .7152 * pixels[at + 1] + .0722 * pixels[at + 2];
            low = Math.min(low, value); high = Math.max(high, value);
          }
          assert.ok(high - low > .05, 'Each real view must contain nonuniform pixels away from divider lines.');
        }
      }
      await writeFile(join(retained, path), bytes, { flag: 'wx' }); evidence.artifacts.push(artifact);
    }
    for (const [name, digest] of Object.entries(evidence.sources)) {
      const artifact = manifest.artifacts.find(row => row.path === name && row.role === 'worker'); assert.ok(artifact);
      assert.equal(artifact.sha256, digest);
    }
  } finally {
    // Retain original job data when ownership/publication is unproved. No implicit
    // retry, fabricated closure, process kill or recursive cleanup is performed.
    await writeFile(join(retained, 'tree-structure.json'), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
  }
});
