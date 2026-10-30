import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AssetPipeline, normalizeRequest } from '../../dist/packages/asset-pipeline/src/index.js';
import { validateManifestFiles, workerScripts, workerSourcePath } from '../../dist/packages/asset-pipeline/src/validation.js';
import { parseWorkerRecords } from '../../dist/packages/asset-pipeline/src/worker-journal.js';
import { noLinks, readRegularFile, regularFile } from '../../dist/packages/asset-pipeline/src/paths.js';
import { decodeMaterialPng, materialPngPixels } from '../../dist/packages/asset-pipeline/src/material-png.js';
import { validateGlb } from '../../dist/apps/desktop/src/glb-preflight.js';
import { matrixFromTrs, multiplyMatrix4 } from '../../dist/packages/core/src/spatial-math.js';

// Mandatory hosted acceptance of ONE current original boulder, not an artistic
// pass or native Studio acceptance. No injected runners, algorithms or audits.
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DEADLINE = 180000, TEST_TIMEOUT = 210000, PNG_LIMIT = 8 * 1024 * 1024;
const evidenceNames = ['rock-hero.png', 'rock-quality.json', 'rock-side.png'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const input = Object.freeze({ template: 'procedural', name: 'rock-current-quality', seed: 31, triangleBudget: 6000,
  renderResolution: 512, renderSamples: 16,
  procedural: Object.freeze({ kind: 'rock', form: 'boulder', moss: false, finish: 'natural', size: Object.freeze([1.6, 1.2, .9]), roughness: .7 }) });
const expectedRequest = normalizeRequest(input);
const stages = new Set(['prepare-output', 'probe', 'generate', 'request-validation', 'blockout', 'identity', 'checkpoint-save',
  'mesh-validation', 'texture-authoring', 'review-render', 'scene-save', 'export', 'export-identity', 'export-roundtrip', 'scene-reopen', 'audit-write', 'host-validation', 'complete']);

function requireCurrentBoulder(request) {
  assert.deepEqual(request, expectedRequest, 'Evidence must be the exact current explicit boulder request, never legacy omitted-form output.');
}
function requireClosed(journal, job, result) {
  assert.equal(journal.schemaVersion, 1); assert.equal(journal.jobId, job.id); assert.equal(journal.directory, job.directory);
  assert.equal(journal.state, result.state); assert.notEqual(result.state, 'interrupted');
  const workers = parseWorkerRecords(journal.workers);
  assert.ok(workers && workers.length >= 1 && workers.length <= 6, 'Closure requires the original bounded worker journal.');
  assert.ok(workers.every(worker => worker.state === 'closed'), 'Unresolved original worker ownership forbids evidence success and cleanup.');
  return workers;
}
function requirePreview(bytes) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= PNG_LIMIT, 'An actual bounded preview is required.');
  const decoded = decodeMaterialPng(bytes); assert.ok(decoded, 'The actual preview must decode.');
  assert.equal(decoded.width, 512); assert.equal(decoded.height, 512);
  const pixels = materialPngPixels(decoded); let low = Infinity, high = -Infinity;
  for (let at = 0; at < pixels.length; at += 4) {
    const luminance = .2126 * pixels[at] + .7152 * pixels[at + 1] + .0722 * pixels[at + 2];
    low = Math.min(low, luminance); high = Math.max(high, luminance);
  }
  assert.ok(high > low, 'A nonuniform image is required; it is not a visual quality verdict.');
  return { width: decoded.width, height: decoded.height, bytes: bytes.length, sha256: sha(bytes) };
}
async function pinnedRuntime(executable) {
  const receiptPath = process.env.ARCANE_TEST_BLENDER_RUNTIME_RECEIPT;
  assert.ok(typeof receiptPath === 'string' && isAbsolute(receiptPath), 'The original pinned runtime acquisition receipt is required.');
  const raw = await readRegularFile(receiptPath, 65536), receipt = JSON.parse(raw.toString('utf8'));
  assert.deepEqual(Object.keys(receipt).sort(), ['archive', 'executableBytes', 'executableRun', 'executableSha256', 'extracted', 'kind', 'platform', 'schemaVersion', 'version']);
  assert.equal(receipt.schemaVersion, 1); assert.equal(receipt.kind, 'arcane-blender-test-runtime');
  assert.equal(receipt.version, '5.2.3'); assert.equal(receipt.platform, process.platform); assert.equal(receipt.executableRun, false);
  const pins = {
    linux: ['blender-5.2.3-linux-x64.tar.xz', 385331224, '78486c018b4443efe5e75ab54c290ed8c15abafd249b862c2c9ce2530a918eec'],
    win32: ['blender-5.2.3-windows-x64.zip', 405839452, '723f08a4401502561eb763cdeacf8745b31e5f3f154d287d3830d97cf75dc2fb'],
  };
  const pin = pins[process.platform]; assert.ok(pin);
  assert.deepEqual(receipt.archive, { url: 'https://download.blender.org/release/Blender5.2/' + pin[0], bytes: pin[1], sha256: pin[2] });
  assert.deepEqual(Object.keys(receipt.extracted).sort(), ['bytes', 'files']);
  assert.ok(Number.isSafeInteger(receipt.extracted.files) && receipt.extracted.files >= 1 && receipt.extracted.files <= 100000);
  assert.ok(Number.isSafeInteger(receipt.extracted.bytes) && receipt.extracted.bytes >= 1 && receipt.extracted.bytes <= 4 * 1024 * 1024 * 1024);
  assert.ok(Number.isSafeInteger(receipt.executableBytes) && receipt.executableBytes >= 1 && receipt.executableBytes <= 512 * 1024 * 1024);
  assert.match(receipt.executableSha256, /^[a-f0-9]{64}$/);
  await regularFile(executable, 512 * 1024 * 1024); const named = await lstat(executable), handle = await open(executable, 'r');
  const hash = createHash('sha256'); let total = 0;
  try {
    const before = await handle.stat(); assert.ok(before.isFile() && before.nlink === 1);
    assert.equal(before.size, receipt.executableBytes); assert.equal(before.ino, named.ino); assert.equal(before.dev, named.dev);
    const block = Buffer.alloc(65536);
    while (true) { const value = await handle.read(block, 0, block.length, total); if (!value.bytesRead) break;
      total += value.bytesRead; assert.ok(total <= receipt.executableBytes); hash.update(block.subarray(0, value.bytesRead)); }
    const after = await handle.stat(); assert.equal(after.size, before.size); assert.equal(after.mtimeMs, before.mtimeMs); assert.equal(after.ctimeMs, before.ctimeMs); assert.equal(after.nlink, 1);
    await noLinks(executable); const current = await lstat(executable); assert.equal(current.ino, before.ino); assert.equal(current.dev, before.dev);
  } finally { await handle.close(); }
  const executableSha256 = hash.digest('hex'); assert.equal(total, receipt.executableBytes); assert.equal(executableSha256, receipt.executableSha256);
  return { receiptSha256: sha(raw), archive: receipt.archive, executableBytes: total, executableSha256 };
}

// Read the actual exported POSITION values through the actual selected scene's
// matrices. This bounded metadata measurement is not a conversion or import grant.
function exportedBounds(raw) {
  validateGlb(raw); const jsonBytes = raw.readUInt32LE(12), doc = JSON.parse(raw.toString('utf8', 20, 20 + jsonBytes)), bin = raw.subarray(28 + jsonBytes);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity], seen = new Set(); let vertices = 0;
  const pending = (doc.scenes[doc.scene ?? 0].nodes ?? []).map(index => ({ index, parent: matrixFromTrs() }));
  while (pending.length) {
    const { index, parent } = pending.pop(); assert.ok(!seen.has(index)); seen.add(index);
    const node = doc.nodes[index], matrix = multiplyMatrix4(parent, node.matrix ?? matrixFromTrs(node.translation, node.rotation, node.scale));
    assert.ok(matrix.every(Number.isFinite));
    for (const child of node.children ?? []) pending.push({ index: child, parent: matrix });
    if (node.mesh === undefined) continue;
    for (const primitive of doc.meshes[node.mesh].primitives) {
      const accessor = doc.accessors[primitive.attributes.POSITION], view = doc.bufferViews[accessor.bufferView];
      assert.equal(accessor.componentType, 5126); assert.equal(accessor.type, 'VEC3'); assert.equal(accessor.sparse, undefined); assert.equal(view.buffer, 0);
      const stride = view.byteStride ?? 12, offset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
      assert.ok(stride >= 12 && Number.isSafeInteger(accessor.count) && accessor.count > 0);
      vertices += accessor.count; assert.ok(vertices <= 200000);
      for (let vertex = 0; vertex < accessor.count; vertex++) {
        const p = [0, 1, 2].map(axis => bin.readFloatLE(offset + vertex * stride + axis * 4)); assert.ok(p.every(Number.isFinite));
        for (let axis = 0; axis < 3; axis++) {
          const value = matrix[axis] * p[0] + matrix[4 + axis] * p[1] + matrix[8 + axis] * p[2] + matrix[12 + axis];
          assert.ok(Number.isFinite(value)); min[axis] = Math.min(min[axis], value); max[axis] = Math.max(max[axis], value);
        }
      }
    }
  }
  assert.ok(vertices > 0); const size = max.map((value, axis) => value - min[axis]);
  [1.6, .9, 1.2].forEach((value, axis) => assert.ok(Math.abs(size[axis] - value) <= .0001, 'Actual exported metre dimensions must match the fixed source request.'));
  assert.ok(Math.abs(min[1]) <= .0001 && Math.abs(min[0] + max[0]) <= .0001 && Math.abs(min[2] + max[2]) <= .0001, 'Actual Y-up export must preserve the centered floor pivot.');
  return { coordinateSpace: 'glTF-Y-up-meters', min, max, size, measuredVertices: vertices };
}

test('real current boulder: original native geometry, 512px world bake, saved scene and two actual review views', { timeout: TEST_TIMEOUT }, async t => {
  const configured = process.env.ARCANE_TEST_BLENDER_EXECUTABLE;
  assert.ok(typeof configured === 'string' && isAbsolute(configured)); assert.equal(process.env.ARCANE_TEST_BLENDER_VERSION, '5.2.3');
  const executable = await realpath(configured), temporaryRoot = await realpath(tmpdir());
  const root = await mkdtemp(join(temporaryRoot, 'arcane-native-rock-')), rootIdentity = await lstat(root);
  await noLinks(root); await mkdir(join(repository, 'runtime'), { recursive: true }); await noLinks(join(repository, 'runtime'));
  const evidenceDirectory = join(repository, 'runtime', 'ci-rock-quality-artifacts'); await mkdir(evidenceDirectory); await noLinks(evidenceDirectory);
  let job = null, result = null, assertionsComplete = false;
  const cleanup = { temporaryDataRemoved: false, retainedForUnprovedClosure: false };
  const evidence = { schemaVersion: 1, kind: 'arcane-current-boulder-native-review', platform: process.platform,
    sourceRevision: /^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? '') ? process.env.GITHUB_SHA : null,
    request: expectedRequest, runtimeAcquisition: null, runtime: null, result: null, stages: [], artifacts: [], sources: [], validation: null,
    nativeEvidence: null, cleanup, visualReview: 'pending', nativeStudioVerification: 'unverified', complete: false };
  t.after(async () => {
    let safe = false;
    if (job) {
      job.cancel();
      const observed = await new Promise(done => {
        const timer = setTimeout(() => done(null), 30000);
        void job.completion.then(value => { clearTimeout(timer); done(value); }, () => { clearTimeout(timer); done(null); });
      });
      if (observed) {
        try { requireClosed(JSON.parse((await readRegularFile(join(job.directory, 'job.json'), 1024 * 1024)).toString('utf8')), job, observed); safe = true; }
        catch { /* A terminal label never substitutes for original observed closure. */ }
      }
    }
    if (safe) {
      await noLinks(root); const actual = await realpath(root), current = await lstat(root), child = relative(temporaryRoot, actual);
      assert.equal(actual, root); assert.equal(current.ino, rootIdentity.ino); assert.equal(current.dev, rootIdentity.dev);
      assert.ok(current.isDirectory() && !current.isSymbolicLink());
      assert.ok(!isAbsolute(child) && child.startsWith('arcane-native-rock-') && !child.includes(sep) && !child.includes('..'));
      await rm(actual, { recursive: true, force: true }); cleanup.temporaryDataRemoved = true;
    } else { cleanup.retainedForUnprovedClosure = true; t.diagnostic('Original rock temporary data retained: closure was not established.'); }
    evidence.complete = assertionsComplete && cleanup.temporaryDataRemoved && !cleanup.retainedForUnprovedClosure;
    const json = Buffer.from(JSON.stringify(evidence) + '\n'); assert.ok(json.length <= 65536);
    await writeFile(join(evidenceDirectory, 'rock-quality.json'), json, { flag: 'wx' });
    if (assertionsComplete) { assert.deepEqual((await readdir(evidenceDirectory)).sort(), evidenceNames); assert.equal(evidence.complete, true); }
  });
  evidence.runtimeAcquisition = await pinnedRuntime(executable);
  const workerRoot = await realpath(join(repository, 'workers', 'blender'));
  const pipeline = new AssetPipeline({ workspaceRoot: root, outputRoot: join(root, 'assets'), workerRoot, blenderExecutable: executable });
  job = pipeline.start(input, { deadlineMs: DEADLINE, signal: t.signal, onEvent(event) {
    const stage = stages.has(event.stage) ? event.stage : 'other'; if (!evidence.stages.includes(stage) && evidence.stages.length < 32) evidence.stages.push(stage);
  } });
  result = await job.completion;
  evidence.result = { state: result.state, code: result.error && /^[A-Z0-9_]{1,64}$/.test(result.error.code) ? result.error.code : result.error ? 'OTHER' : null };
  assert.equal(result.state, 'succeeded', JSON.stringify(evidence.result)); assert.equal(result.error, null); assert.equal(result.manifestPath, join(job.directory, 'manifest.json'));
  const manifestRaw = await readRegularFile(result.manifestPath, 1024 * 1024), manifest = await validateManifestFiles(job.directory, JSON.parse(manifestRaw.toString('utf8')));
  requireCurrentBoulder(manifest.request); assert.equal(manifest.schemaVersion, 2); assert.equal(manifest.jobId, job.id);
  const journalRaw = await readRegularFile(join(job.directory, 'job.json'), 1024 * 1024), journal = JSON.parse(journalRaw.toString('utf8')), workers = requireClosed(journal, job, result);
  requireCurrentBoulder(journal.request);
  for (const role of ['probe', 'python-probe', 'generate']) {
    const matching = workers.filter(worker => worker.role === role); assert.equal(matching.length, 1);
    assert.equal(matching[0].closure, 'exit-observed');
  }
  assert.equal(await realpath(manifest.runtime.executable), executable); assert.match(manifest.runtime.version, /^5\.2\.3(?: LTS)?$/);
  assert.equal(manifest.runtime.background, true); assert.deepEqual(manifest.runtime.capabilities, { glbExport: true, glbImport: true, fbxExport: true, fbxImport: true, cycles: true });
  evidence.runtime = { version: manifest.runtime.version, pythonVersion: manifest.runtime.pythonVersion, background: manifest.runtime.background, capabilities: manifest.runtime.capabilities };
  assert.equal(manifest.validation.savedSceneReopened, true); assert.deepEqual(manifest.validation.errors, []);
  for (const required of ['texture-authoring', 'export-roundtrip', 'scene-reopen', 'host-validation']) assert.ok(evidence.stages.includes(required));
  assert.equal(manifest.coordinateSystem.robloxScaleVerified, false); assert.equal('approved' in manifest, false);
  const artifacts = new Map(manifest.artifacts.map(artifact => [artifact.path, artifact]));
  for (const name of workerScripts(expectedRequest)) {
    const source = await readRegularFile(join(workerRoot, ...workerSourcePath(name)), 256 * 1024), copied = await readRegularFile(join(job.directory, name), 256 * 1024), artifact = artifacts.get(name);
    assert.ok(artifact && artifact.role === 'worker'); assert.deepEqual(copied, source); assert.equal(artifact.sha256, sha(source)); assert.equal(artifact.bytes, source.length);
    evidence.sources.push({ path: workerSourcePath(name).join('/'), bytes: source.length, sha256: sha(source) });
  }
  assert.equal(manifest.templateSha256, sha(Buffer.from(evidence.sources.map(source => source.sha256).join('\n'))));
  for (const [role, sourcePath] of [['pipeline-source', join(repository, 'packages', 'asset-pipeline', 'src', 'index.ts')], ['pipeline-built', join(repository, 'dist', 'packages', 'asset-pipeline', 'src', 'index.js')], ['native-fixture', fileURLToPath(import.meta.url)]]) {
    const raw = await readRegularFile(sourcePath, 256 * 1024); evidence.sources.push({ role, bytes: raw.length, sha256: sha(raw) });
  }
  const render = manifest.validation.meshes.filter(mesh => mesh.role === 'render'); assert.equal(render.length, 1);
  // The current UV stage labels deliberately authored rock charts 'tiled';
  // do not invent a different native audit intent from the source's unique packing.
  assert.equal(render[0].materials.length, 1); assert.ok(render[0].uvQuality && render[0].uvQuality.intent === 'tiled');
  const material = render[0].materialProperties[0], surface = material.surface;
  assert.equal(surface.profile, 'stone'); assert.equal(surface.pattern, 'rock-boulder'); assert.equal(surface.resolution, 512); assert.equal(surface.alphaMode, 'OPAQUE');
  assert.deepEqual(surface.images.map(image => image.role).sort(), ['baseColor', 'metallicRoughness', 'normal']);
  for (const image of surface.images) { assert.equal(image.width, 512); assert.equal(image.height, 512); assert.match(image.sha256, /^[a-f0-9]{64}$/); }
  const glb = await readRegularFile(join(job.directory, 'asset.glb'), 128 * 1024 * 1024), bounds = exportedBounds(glb);
  for (const view of ['hero', 'side']) {
    const original = 'preview-' + view + '.png', artifact = artifacts.get(original); assert.ok(artifact && artifact.role === 'preview');
    const bytes = await readRegularFile(join(job.directory, original), PNG_LIMIT), measured = requirePreview(bytes);
    assert.equal(artifact.sha256, measured.sha256); assert.equal(artifact.bytes, measured.bytes);
    const path = 'rock-' + view + '.png'; await writeFile(join(evidenceDirectory, path), bytes, { flag: 'wx' }); evidence.artifacts.push({ path, ...measured });
  }
  evidence.validation = { auditSha256: artifacts.get('audit.json').sha256, manifestSha256: sha(manifestRaw), requestSha256: artifacts.get('request.json').sha256,
    sourceRequestSha256: manifest.sourceRequestSha256, templateSha256: manifest.templateSha256, exportSha256: sha(glb), bounds,
    manifestSchemaVersion: manifest.schemaVersion, inventory: manifest.artifacts, audit: manifest.validation, coordinateSystem: manifest.coordinateSystem };
  evidence.nativeEvidence = { journalSha256: sha(journalRaw), workers: workers.map(worker => ({ role: worker.role, state: worker.state, closure: worker.closure,
    identitySha256: worker.identity === null ? null : sha(Buffer.from(JSON.stringify(worker.identity))) })), allOriginalWorkersClosed: true };
  // Negative controls exercise this evidence gate with actual completed input,
  // without another generation or pretending edited metadata is native evidence.
  const legacy = { ...input.procedural }; delete legacy.form; delete legacy.moss;
  assert.throws(() => requireCurrentBoulder(normalizeRequest({ ...input, procedural: legacy })), /current explicit boulder/);
  assert.throws(() => requirePreview(undefined), /actual bounded preview/);
  assert.throws(() => requirePreview(Buffer.from('not a PNG')));
  const unclosed = JSON.parse(journalRaw.toString('utf8')), first = workers[0];
  unclosed.workers[0] = { schemaVersion: first.schemaVersion, role: first.role, reservationId: first.reservationId, reservedAt: first.reservedAt, state: 'reserved' };
  assert.throws(() => requireClosed(unclosed, job, result), /Unresolved original worker/);
  assert.throws(() => requireClosed({ ...journal, workers: [] }, job, result), /original bounded worker journal/);
  assertionsComplete = true;
});
