import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { AssetPipeline } from '../../dist/packages/asset-pipeline/src/index.js';
import { parseConvertedGlbJson } from '../../dist/packages/asset-pipeline/src/converted-glb-manifest.js';
import { validateConvertedGlbCollision } from '../../dist/packages/asset-pipeline/src/converted-glb-collision.js';
import { decodeMaterialPng, materialPngPixels } from '../../dist/packages/asset-pipeline/src/material-png.js';
import { noLinks, readRegularFile, regularFile } from '../../dist/packages/asset-pipeline/src/paths.js';
import { parseWorkerRecords } from '../../dist/packages/asset-pipeline/src/worker-journal.js';
import { validateGlb } from '../../dist/apps/desktop/src/glb-preflight.js';

// Mandatory native acceptance, invoked only by the separate hosted Blender job.
// There are no injected runners/probes, synthesized worker audits, optional skips,
// Studio operations, provider sessions or user account/profile inputs.
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const JOB_DEADLINE = 180000;
const CASE_TIMEOUT = 210000;
const sha = value => createHash('sha256').update(value).digest('hex');
const encode = value => Buffer.from(JSON.stringify(value));
const evidenceNames = new Set(['native-conversion.json', 'none-hero.png', 'none-side.png', 'hull-hero.png', 'hull-side.png']);
const successes = [];
const results = [];
const attempts = [];
let evidenceDirectory;

async function runtimeAcquisitionEvidence(executable) {
  const configured = process.env.ARCANE_TEST_BLENDER_RUNTIME_RECEIPT;
  if (configured === undefined) return null;
  assert.ok(isAbsolute(configured), 'The optional runtime receipt must be an absolute ordinary file.');
  const receipt = parseConvertedGlbJson(await readRegularFile(configured, 65536));
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
  assert.match(receipt.executableSha256, /^[0-9a-f]{64}$/);
  await regularFile(executable, 512 * 1024 * 1024);
  const namedBefore = await lstat(executable), handle = await open(executable, 'r'), digest = createHash('sha256'); let count = 0;
  try {
    const before = await handle.stat(); assert.ok(before.isFile() && before.nlink === 1); assert.equal(before.size, receipt.executableBytes);
    assert.equal(before.ino, namedBefore.ino); assert.equal(before.dev, namedBefore.dev);
    const bytes = Buffer.alloc(65536);
    while (true) { const read = await handle.read(bytes, 0, bytes.length, count); if (!read.bytesRead) break;
      count += read.bytesRead; assert.ok(count <= receipt.executableBytes); digest.update(bytes.subarray(0, read.bytesRead)); }
    const after = await handle.stat();
    assert.equal(after.size, before.size); assert.equal(after.mtimeMs, before.mtimeMs); assert.equal(after.ctimeMs, before.ctimeMs);
    assert.equal(after.nlink, 1); await noLinks(executable); const namedAfter = await lstat(executable);
    assert.equal(namedAfter.ino, before.ino); assert.equal(namedAfter.dev, before.dev);
  } finally { await handle.close(); }
  assert.equal(count, receipt.executableBytes); const executableSha256 = digest.digest('hex'); assert.equal(executableSha256, receipt.executableSha256);
  // Acquisition evidence is separate from actual pipeline version/capabilities,
  // fidelity, previews and observed child closure, all required below.
  return { installerReceipt: receipt, configuredExecutable: { bytes: count, sha256: executableSha256 }, executableHashMatched: true };
}

function chunk(kind, data) {
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length); output.write(kind, 4); data.copy(output, 8);
  let crc = 0xffffffff;
  for (const byte of output.subarray(4, data.length + 8)) {
    crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, data.length + 8); return output;
}
function originalPng() {
  const size = 4, header = Buffer.alloc(13), pixels = Buffer.alloc((size * 4 + 1) * size);
  header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const at = y * (size * 4 + 1) + 1 + x * 4;
    pixels[at] = 45 + x * 18; pixels[at + 1] = 115 + y * 22; pixels[at + 2] = 30 + x * 9;
    pixels[at + 3] = x === 0 && y === 0 ? 0 : 255;
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
function pack(doc, binary) {
  doc.buffers[0].byteLength = binary.length;
  const json = encode(doc), paddedJson = Math.ceil(json.length / 4) * 4, paddedBin = Math.ceil(binary.length / 4) * 4;
  const output = Buffer.alloc(28 + paddedJson + paddedBin);
  output.writeUInt32LE(0x46546c67); output.writeUInt32LE(2, 4); output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(paddedJson, 12); output.writeUInt32LE(0x4e4f534a, 16); output.fill(32, 20, 20 + paddedJson); json.copy(output, 20);
  output.writeUInt32LE(paddedBin, 20 + paddedJson); output.writeUInt32LE(0x004e4942, 24 + paddedJson); binary.copy(output, 28 + paddedJson);
  return output;
}
const quaternion = (axis, angle) => axis.map(value => value * Math.sin(angle / 2)).concat(Math.cos(angle / 2));
function originalGlb(planar = false) {
  const doc = { asset: { version: '2.0' }, buffers: [{ byteLength: 0 }], bufferViews: [], accessors: [], meshes: [],
    materials: [
      { name: 'Leaf', doubleSided: true, alphaMode: 'MASK', alphaCutoff: .5,
        pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1 } },
      { name: 'Stem', doubleSided: true, pbrMetallicRoughness: { baseColorFactor: [.2, .08, .025, 1], metallicFactor: 0, roughnessFactor: 1 } },
    ], samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }], textures: [{ sampler: 0, source: 0 }], images: [],
    scene: 0, scenes: [{ nodes: [0] }], nodes: [
      { name: 'source-root', translation: [.25, .5, planar ? 0 : .25], rotation: quaternion([0, 0, 1], Math.PI / 2), scale: [1.5, .75, 1.25], children: [1, 5] },
      { name: 'source-branch', translation: [-.25, .125, 0], rotation: quaternion([0, 0, 1], Math.PI / 6), children: [2, 3, 4] },
      { name: 'shared-first', mesh: 0, scale: [1, 1.25, .75] },
      { name: 'shared-second', mesh: 0, translation: [1.25, .25, planar ? 0 : .5], rotation: quaternion(planar ? [0, 0, 1] : [0, 1, 0], Math.PI / 3), scale: [.75, 1.5, 1.25] },
      { name: 'different-mesh', mesh: 1, translation: [-.75, .75, planar ? 0 : -.5], rotation: quaternion([0, 0, 1], -Math.PI / 6), scale: [1.25, .75, 1] },
      { name: 'preserved-empty-leaf', translation: [.125, .25, 0] },
    ] };
  let binary = Buffer.alloc(0);
  function view(bytes) {
    const at = Math.ceil(binary.length / 4) * 4, index = doc.bufferViews.length;
    binary = Buffer.concat([binary, Buffer.alloc(at - binary.length), bytes]); doc.bufferViews.push({ buffer: 0, byteOffset: at, byteLength: bytes.length }); return index;
  }
  function accessor(values, width, indices = false) {
    const raw = Buffer.alloc(values.length * (indices ? 2 : 4));
    values.forEach((value, index) => indices ? raw.writeUInt16LE(value, index * 2) : raw.writeFloatLE(value, index * 4));
    const entry = { bufferView: view(raw), componentType: indices ? 5123 : 5126, count: values.length / width, type: width === 1 ? 'SCALAR' : 'VEC' + width };
    if (width === 3) { entry.min = [0, 1, 2].map(axis => Math.min(...values.filter((_, at) => at % 3 === axis))); entry.max = [0, 1, 2].map(axis => Math.max(...values.filter((_, at) => at % 3 === axis))); }
    doc.accessors.push(entry); return doc.accessors.length - 1;
  }
  function primitive(positions, uvs, indices, material) {
    return { attributes: { POSITION: accessor(positions.flat(), 3), NORMAL: accessor(positions.flatMap(() => [0, 0, 1]), 3), TEXCOORD_0: accessor(uvs.flat(), 2) }, indices: accessor(indices, 1, true), material };
  }
  const leaf = primitive([[-.5, 0, 0], [.5, 0, 0], [-.5, 1, 0], [.5, 0, 0], [.5, 1, 0], [-.5, 1, 0]],
    [[0, 0], [1, 0], [0, 1], [.25, 0], [.25, 1], [1.25, 1]], [0, 1, 2, 3, 4, 5], 0);
  const stem = primitive([[-.04, -.2, 0], [.04, -.2, 0], [.04, 1.1, 0], [-.04, 1.1, 0]], [[0, 0], [1, 0], [1, 1], [0, 1]], [0, 1, 2, 0, 2, 3], 1);
  const otherLeaf = primitive([[-.3, 0, 0], [.3, 0, 0], [.3, .75, 0], [-.3, .75, 0]], [[0, 0], [1, 0], [1, 1], [0, 1]], [0, 1, 2, 0, 2, 3], 0);
  doc.meshes = [{ name: 'shared-two-material-mesh', primitives: [leaf, stem] }, { name: 'second-mesh', primitives: [otherLeaf] }];
  doc.images = [{ name: 'embedded-original-atlas', mimeType: 'image/png', bufferView: view(originalPng()) }];
  return pack(doc, binary);
}
function parentInput(source, name, collision, renderResolution = 128, renderSamples = 4) {
  const request = { schemaVersion: 1, template: 'adopted-glb', name: 'native-original', path: 'originals/model.glb', sourceSha256: sha(source), sourceBytes: source.length };
  const parent = { schemaVersion: 1, jobId: randomUUID(), createdAt: new Date().toISOString(), request,
    provenance: { kind: 'native-project-glb', projectId: sha('isolated-hosted-native-conversion-fixture'), conversation: { provider: 'codex', threadId: 'native-conversion-fixture-data', sessionId: null },
      sourceSha256: sha(source), sourceBytes: source.length },
    validation: { kind: 'glb-preview-preflight', metadata: validateGlb(Uint8Array.from(source).buffer), imageDecode: 'not-run', engineVerification: 'pending' },
    engineImport: { status: 'unavailable', reason: 'adopted-origin-requires-safe-conversion' },
    artifacts: [{ path: 'asset.glb', role: 'export', bytes: source.length, sha256: sha(source) },
      { path: 'request.json', role: 'request', bytes: encode(request).length, sha256: sha(encode(request)) }], limitations: ['Original adopted snapshot has no native import or human review authority.'] };
  const rawParent = encode(parent);
  return { sourceGlb: Buffer.from(source), parentManifest: rawParent, parentManifestSha256: sha(rawParent), name, collision, renderResolution, renderSamples };
}
function boundedResult(result) {
  return JSON.stringify({ state: result.state, code: result.error?.code ?? null, stage: result.error?.diagnostic?.stage ?? null,
    reasonCode: result.error?.diagnostic?.reasonCode ?? null, exceptionType: result.error?.diagnostic?.exceptionType ?? null });
}
async function prefix(path, count) { const handle = await open(path, 'r'); try { const bytes = Buffer.alloc(count); const result = await handle.read(bytes, 0, count, 0); return bytes.subarray(0, result.bytesRead); } finally { await handle.close(); } }
async function closedJournal(job) {
  const journal = JSON.parse(await readFile(join(job.directory, 'job.json'), 'utf8'));
  assert.equal(journal.kind, 'converted-glb'); assert.equal(journal.jobId, job.id);
  const workers = parseWorkerRecords(journal.workers); assert.ok(workers && workers.length >= 2 && workers.length <= 6);
  assert.ok(workers.some(worker => worker.role === 'probe' && worker.state === 'closed' && worker.closure === 'exit-observed'));
  const generators = workers.filter(worker => worker.role === 'generate'); assert.equal(generators.length, 1);
  assert.equal(generators[0].state, 'closed'); assert.equal(generators[0].closure, 'exit-observed');
  for (const worker of workers) assert.equal(worker.state, 'closed');
  return journal;
}
async function caseWorkspace(t, executable) {
  const temporaryRoot = await realpath(tmpdir()), root = await mkdtemp(join(temporaryRoot, 'arcane-native-conversion-'));
  const jobs = [], terminal = new Map(), cleanup = { temporaryDataRemoved: false, retainedForUnprovedClosure: false };
  const pipeline = new AssetPipeline({ workspaceRoot: root, outputRoot: join(root, 'assets'), workerRoot: join(repository, 'workers', 'blender'), blenderExecutable: executable });
  t.after(async () => {
    for (const job of jobs) job.cancel();
    for (const job of jobs) {
      // A bounded cleanup observation can retain unknown work, never turn a
      // timer/kill request into proof of child closure or delete its files.
      const value = await new Promise(resolveResult => {
        const timer = setTimeout(() => resolveResult(null), 30000);
        void job.completion.then(result => { clearTimeout(timer); resolveResult(result); }, () => { clearTimeout(timer); resolveResult(null); });
      });
      if (value) terminal.set(job.id, value);
    }
    let safe = jobs.every(job => terminal.has(job.id) && terminal.get(job.id).state !== 'interrupted');
    for (const job of jobs) {
      try { const journal = JSON.parse(await readFile(join(job.directory, 'job.json'), 'utf8'));
        const workers = parseWorkerRecords(journal.workers);
        safe &&= !!workers && workers.every(worker => worker.state === 'closed');
      } catch { safe = false; }
    }
    if (!safe) { cleanup.retainedForUnprovedClosure = true; t.diagnostic('Owned temporary data retained: native closure was not established.'); return; }
    const actual = await realpath(root), child = relative(temporaryRoot, actual);
    assert.ok(!isAbsolute(child) && child.startsWith('arcane-native-conversion-') && !child.includes(sep) && !child.includes('..'));
    await rm(actual, { recursive: true, force: true });
    cleanup.temporaryDataRemoved = true;
  });
  return { pipeline, cleanup, start(input, options) { const job = pipeline.startConversion(input, options); jobs.push(job); return job; } };
}
async function saveEvidence(name, bytes) {
  assert.ok(evidenceNames.has(name) && evidenceDirectory);
  assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= (name === 'native-conversion.json' ? 65536 : 8 * 1024 * 1024));
  // A retry cannot reuse or overwrite a previous successful native evidence set.
  await writeFile(join(evidenceDirectory, name), bytes, { flag: 'wx' });
}
async function assertSuccess(t, executable, expectedVersion, collision) {
  const source = originalGlb(), input = parentInput(source, 'native-' + (collision === 'none' ? 'none' : 'hull'), collision);
  const originalParent = Buffer.from(input.parentManifest), sourceHash = sha(source), f = await caseWorkspace(t, executable);
  const job = f.start(input, { deadlineMs: JOB_DEADLINE });
  // The actual asynchronous native job must own its inputs after start returns.
  input.sourceGlb.fill(0); input.parentManifest.fill(0);
  const result = await job.completion;
  attempts.push({ case: collision === 'none' ? 'none' : 'hull', ...JSON.parse(boundedResult(result)) });
  assert.equal(result.state, 'succeeded', boundedResult(result)); assert.equal(result.error, null);
  assert.equal(result.manifestPath, join(job.directory, 'manifest.json'));
  const manifest = await f.pipeline.validateConversion(result.manifestPath), journal = await closedJournal(job);
  assert.equal(manifest.origin, 'converted-glb'); assert.equal(manifest.jobId, job.id); assert.equal(journal.state, 'succeeded');
  assert.equal(await realpath(manifest.runtime.executable), executable); assert.equal(manifest.runtime.version, expectedVersion);
  assert.equal(manifest.validation.blenderVersion, expectedVersion); assert.equal(manifest.runtime.background, true);
  assert.deepEqual(manifest.runtime.capabilities, { glbExport: true, glbImport: true, fbxExport: true, fbxImport: true, cycles: true });
  assert.equal(manifest.coordinateSystem.robloxScaleVerified, false); assert.equal('approved' in manifest, false);
  assert.equal(manifest.request.sourceSha256, sourceHash); assert.equal(manifest.request.parentManifestSha256, sha(originalParent));
  assert.deepEqual(await readFile(join(job.directory, 'source.glb')), source);
  assert.deepEqual(await readFile(join(job.directory, 'parent-manifest.json')), originalParent);
  assert.equal(JSON.parse(originalParent.toString()).engineImport.status, 'unavailable');
  assert.equal(manifest.sourceMap.parts.length, 5); assert.equal(new Set(manifest.sourceMap.parts.map(part => part.sourceMeshIndex)).size, 2);
  assert.equal(manifest.sourceMap.parts.filter(part => part.sourceMeshIndex === 0).length, 4);
  assert.equal(manifest.validation.savedSceneReopened, true); assert.deepEqual(manifest.validation.errors, []);
  assert.deepEqual(manifest.validation.importedParts, manifest.validation.reopenedParts);
  assert.ok(manifest.validation.importedParts.every(part => part.uvLayers === 1 && part.finitePositions && part.degenerateFaces === 0 && part.invalidUVs === 0));
  assert.ok(manifest.validation.importedParts.some(part => part.vertices >= 6 && part.boundaryEdges > 0));
  assert.ok(manifest.validation.warnings.includes('open-render-surfaces'));
  assert.ok((await prefix(join(job.directory, 'asset.blend'), 7)).equals(Buffer.from('BLENDER')));
  assert.equal(manifest.artifacts.length, collision === 'none' ? 13 : 14);
  const previews = [];
  for (const view of ['hero', 'side']) {
    const artifact = manifest.artifacts.find(artifact => artifact.path === 'preview-' + view + '.png'); assert.ok(artifact);
    const encoded = await readFile(join(job.directory, artifact.path)); assert.equal(sha(encoded), artifact.sha256); assert.equal(encoded.length, artifact.bytes);
    const decoded = decodeMaterialPng(encoded); assert.equal(decoded.width, 128); assert.equal(decoded.height, 128);
    const pixels = materialPngPixels(decoded); let low = Infinity, high = -Infinity;
    for (let at = 0; at < pixels.length; at += 4) { const value = .2126 * pixels[at] + .7152 * pixels[at + 1] + .0722 * pixels[at + 2]; low = Math.min(low, value); high = Math.max(high, value); }
    assert.ok(high > low); const retainedName = (collision === 'none' ? 'none' : 'hull') + '-' + view + '.png'; await saveEvidence(retainedName, encoded);
    previews.push({ path: retainedName, sha256: sha(encoded), bytes: encoded.length, width: decoded.width, height: decoded.height });
  }
  if (collision === 'none') {
    assert.equal(manifest.artifacts.some(artifact => artifact.path === 'collision.glb'), false);
    await assert.rejects(readFile(join(job.directory, 'collision.glb')), { code: 'ENOENT' });
  } else {
    const raw = await readFile(join(job.directory, 'collision.glb')), requestArtifact = manifest.artifacts.find(artifact => artifact.path === 'request.json');
    const measured = validateConvertedGlbCollision(raw, manifest.request, manifest.sourceMap, manifest.validation, requestArtifact.sha256);
    assert.ok(measured.volumeMeters3 > 1e-12); assert.ok(measured.triangles >= 4 && measured.triangles <= 20000); assert.ok(measured.measuredPositionVertices >= 4);
  }
  const recovered = await f.pipeline.recover(job.directory); assert.equal(recovered.result.state, 'succeeded'); assert.equal(recovered.result.error, null);
  assert.equal(recovered.result.manifestPath, result.manifestPath); assert.deepEqual((await closedJournal(job)).workers, journal.workers);
  successes.push(collision);
  results.push({ case: collision === 'none' ? 'none' : 'hull', state: result.state, version: manifest.runtime.version, sourceParts: manifest.sourceMap.parts.length,
    artifacts: manifest.artifacts.length, previews, sourceSha256: sourceHash, workerBundleSha256: manifest.workerBundleSha256,
    exports: manifest.validation.models.map(model => ({ path: model.path, sha256: model.sha256, bytes: model.byteLength })),
    workerRoles: journal.workers.map(worker => worker.role), allWorkersClosed: true,
    sourcePreserved: manifest.request.sourceSha256 === sourceHash, savedSceneReopened: manifest.validation.savedSceneReopened, cleanup: f.cleanup });
}

test('real Blender static conversion acceptance', { timeout: 900000 }, async t => {
  const configured = process.env.ARCANE_TEST_BLENDER_EXECUTABLE, expectedVersion = process.env.ARCANE_TEST_BLENDER_VERSION;
  assert.ok(typeof configured === 'string' && isAbsolute(configured), 'ARCANE_TEST_BLENDER_EXECUTABLE must identify the explicit owned absolute Blender executable.');
  assert.equal(expectedVersion, '5.2.3', 'ARCANE_TEST_BLENDER_VERSION must match the reviewed pinned native runtime.');
  const executable = await realpath(configured);
  await mkdir(join(repository, 'runtime'), { recursive: true });
  evidenceDirectory = join(repository, 'runtime', 'ci-blender-conversion-artifacts');
  await mkdir(evidenceDirectory); // Exclusive fresh evidence set; no retry reuse.
  let fixtureAssertionsComplete = false, runtimeAcquisition = null;
  t.after(async () => {
    await saveEvidence('native-conversion.json', encode({ schemaVersion: 1, expectedVersion, runtimeAcquisition, nativeCases: results, attempts,
      successfulConversions: successes.length, inferenceStarted: false, studioOperations: 0, nativeStudioVerified: false,
      complete: fixtureAssertionsComplete && results.length === 4 && successes.length === 2 && results.every(result => result.cleanup.temporaryDataRemoved && !result.cleanup.retainedForUnprovedClosure) }));
  });
  runtimeAcquisition = await runtimeAcquisitionEvidence(executable);
  await t.test('none: actual hierarchy/material/UV/shared-mesh/open-card conversion and real retained previews', { timeout: CASE_TIMEOUT }, async child => {
    await assertSuccess(child, executable, expectedVersion, 'none');
  });
  await t.test('convex-hull: actual multimesh open-card source produces independently validated positive-volume collision', { timeout: CASE_TIMEOUT }, async child => {
    await assertSuccess(child, executable, expectedVersion, 'convex-hull');
  });
  await t.test('actual worker source-map event cancellation waits for owned close and never becomes a success or replay', { timeout: CASE_TIMEOUT }, async child => {
    const f = await caseWorkspace(child, executable), source = originalGlb(), input = parentInput(source, 'native-cancel', 'none', 1024, 64);
    let job, cancelledAt = null;
    job = f.start(input, { deadlineMs: JOB_DEADLINE, onEvent(event) {
      // This phase is emitted only from ARCANE_EVENT by the actual Python worker;
      // host pre-spawn source-import progress cannot satisfy this cancellation.
      if (event.stage === 'source-map' && cancelledAt === null) { cancelledAt = event.stage; job.cancel(); }
    } });
    const result = await job.completion;
    attempts.push({ case: 'cancel', ...JSON.parse(boundedResult(result)) });
    assert.equal(cancelledAt, 'source-map'); assert.equal(result.state, 'cancelled', boundedResult(result)); assert.equal(result.error?.code, 'CANCELLED');
    assert.equal(result.manifestPath, null); const journal = await closedJournal(job); assert.equal(journal.state, 'cancelled');
    assert.deepEqual(await readFile(join(job.directory, 'source.glb')), source);
    assert.equal((await f.pipeline.recover(job.directory)).result.state, 'cancelled');
    assert.deepEqual((await closedJournal(job)).workers, journal.workers);
    await assert.rejects(readFile(join(job.directory, 'manifest.json')), { code: 'ENOENT' });
    results.push({ case: 'cancel', state: result.state, code: result.error.code, cancelledAt, allWorkersClosed: true, workerRoles: journal.workers.map(worker => worker.role), recoveryPreservedTerminal: true, cleanup: f.cleanup });
  });
  await t.test('planar source explicitly refuses convex hull at the real collision stage without geometry thickening', { timeout: CASE_TIMEOUT }, async child => {
    const f = await caseWorkspace(child, executable), source = originalGlb(true), input = parentInput(source, 'native-planar', 'convex-hull');
    const job = f.start(input, { deadlineMs: JOB_DEADLINE }), result = await job.completion;
    attempts.push({ case: 'planar-refusal', ...JSON.parse(boundedResult(result)) });
    assert.equal(result.state, 'failed', boundedResult(result)); assert.equal(result.error?.code, 'BLENDER_FAILED');
    assert.equal(result.error?.diagnostic?.stage, 'collision'); assert.equal(result.error?.diagnostic?.reasonCode, 'CONVERSION_COLLISION'); assert.equal(result.manifestPath, null);
    const journal = await closedJournal(job); assert.equal(journal.state, 'failed');
    assert.deepEqual(await readFile(join(job.directory, 'source.glb')), source);
    assert.equal((await f.pipeline.recover(job.directory)).result.error.diagnostic.reasonCode, 'CONVERSION_COLLISION');
    assert.deepEqual((await closedJournal(job)).workers, journal.workers);
    await assert.rejects(readFile(join(job.directory, 'manifest.json')), { code: 'ENOENT' });
    results.push({ case: 'planar-refusal', state: result.state, code: result.error.code, stage: result.error.diagnostic.stage,
      reasonCode: result.error.diagnostic.reasonCode, allWorkersClosed: true, workerRoles: journal.workers.map(worker => worker.role), sourcePreserved: true, cleanup: f.cleanup });
  });
  assert.equal(successes.length, 2); assert.equal(results.length, 4);
  assert.ok(results.every(result => result.cleanup.temporaryDataRemoved && !result.cleanup.retainedForUnprovedClosure), 'Every real owned worker must close before its exact temporary data is removed.');
  fixtureAssertionsComplete = true;
});
