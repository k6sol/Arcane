import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { audit, glb, manifestFixture, png } from '../../packages/asset-pipeline/testing/fixture.js';
import { AssetPipeline } from '../../packages/asset-pipeline/src/index.js';
import { AssetError, type AssetManifest, type SurfaceEvidence } from '../../packages/asset-pipeline/src/types.js';
import { inspectGlb, inspectPng, normalizeRequest, sha256, validateAudit, validateManifestFiles, validateSurfaceGlb } from '../../packages/asset-pipeline/src/validation.js';
import { decodeAssetJobError, failureMessage, hostFailure } from '../../packages/asset-pipeline/src/failure-diagnostics.js';

type Doc = Record<string, any>;
function unpack(bytes = glb()): { doc: Doc; bin: Buffer } {
  const size = bytes.readUInt32LE(12);
  return { doc: JSON.parse(bytes.toString('utf8', 20, 20 + size).trim()), bin: Buffer.from(bytes.subarray(28 + size)) };
}
function pack(doc: Doc, bin: Buffer): Buffer {
  const raw = Buffer.from(JSON.stringify(doc)), size = Math.ceil(raw.length / 4) * 4, length = Math.ceil(bin.length / 4) * 4;
  const bytes = Buffer.alloc(28 + size + length);
  bytes.writeUInt32LE(0x46546c67); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(size, 12); bytes.writeUInt32LE(0x4e4f534a, 16); bytes.fill(32, 20, 20 + size); raw.copy(bytes, 20);
  bytes.writeUInt32LE(length, 20 + size); bytes.writeUInt32LE(0x004e4942, 24 + size); bin.copy(bytes, 28 + size);
  return bytes;
}
function rejected(action: () => unknown, code: string, ...messages: RegExp[]): AssetError {
  let caught: unknown;
  try { action(); } catch (error) { caught = error; }
  assert.ok(caught instanceof AssetError); assert.equal(caught.code, code);
  for (const pattern of messages) assert.match(caught.message, pattern);
  assert.ok(caught.message.length < 600); return caught;
}
async function fixture(t: test.TestContext) {
  const base = await realpath(tmpdir()), directory = await mkdtemp(join(base, 'arcane-artifact-diagnostic-test-'));
  t.after(async () => {
    const child = relative(base, await realpath(directory));
    assert.ok(!isAbsolute(child) && child.startsWith('arcane-artifact-diagnostic-test-') && !child.includes(sep) && !child.includes('..'));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, manifest: await manifestFixture(directory) };
}
async function replace(directory: string, manifest: AssetManifest, name: string, bytes: Buffer) {
  await writeFile(join(directory, name), bytes);
  const artifact = manifest.artifacts.find(artifact => artifact.path === name)!;
  artifact.bytes = bytes.length; artifact.sha256 = sha256(bytes);
}
async function manifestError(directory: string, manifest: AssetManifest, code: string, ...messages: RegExp[]) {
  let caught: unknown;
  try { await validateManifestFiles(directory, manifest); } catch (error) { caught = error; }
  assert.ok(caught instanceof AssetError); assert.equal(caught.code, code);
  for (const pattern of messages) assert.match(caught.message, pattern);
  assert.ok(!caught.message.includes(directory)); assert.ok(caught.message.length < 600);
  return caught;
}

test('actual GLB attribute data reports primitive, accessor, count and finite-value reasons', () => {
  assert.deepEqual(inspectGlb(glb()), { triangles: 4, primitives: 1, vertices: 4 });
  const missing = unpack(); missing.doc.meshes[0].primitives.push({ attributes: { POSITION: 0 }, indices: 2 });
  rejected(() => inspectGlb(pack(missing.doc, missing.bin)), 'EXPORT', /mesh\[0\] primitive\[1\]/, /NORMAL accessor is missing/);
  const count = unpack(); count.doc.accessors[1].count = 3;
  rejected(() => inspectGlb(pack(count.doc, count.bin)), 'EXPORT', /NORMAL count 3 must match POSITION count 4/);
  const normal = unpack(); normal.bin.writeFloatLE(2, 56);
  rejected(() => inspectGlb(pack(normal.doc, normal.bin)), 'EXPORT', /NORMAL element\[0\] length 2/, /within 0\.05 of 1/);
  const finite = unpack(); finite.bin.writeFloatLE(NaN, 0);
  rejected(() => inspectGlb(pack(finite.doc, finite.bin)), 'EXPORT', /POSITION accessor\[0\] element\[0\] component\[0\] must be finite/);
  const range = unpack(); range.doc.bufferViews[0].byteLength = 47;
  rejected(() => inspectGlb(pack(range.doc, range.bin)), 'EXPORT', /POSITION accessor\[0\] byte range or stride/, /count 4/, /view length 47/);
});

test('actual index and degenerate triangle bytes retain strict rejection and precise locations', () => {
  const index = unpack(); index.bin[96] = 4;
  rejected(() => inspectGlb(pack(index.doc, index.bin)), 'EXPORT', /Index element\[0\] is 4; required 0\.\.3/);
  const count = unpack(); count.doc.accessors[2].count = 11;
  rejected(() => inspectGlb(pack(count.doc, count.bin)), 'EXPORT', /Index count 11 must be divisible by 3/);
  const triangle = unpack(); triangle.bin[97] = triangle.bin[96]!;
  rejected(() => inspectGlb(pack(triangle.doc, triangle.bin)), 'EXPORT', /Triangle\[0\] is degenerate/, /exceed 1e-10/);
});

function surfaced() {
  const request = normalizeRequest({ template: 'custom-assembly', name: 'diagnostic-surface', recipe: { schemaVersion: 1,
    materials: [{ id: 'timber', color: [.2, .1, .04], surface: { profile: 'bark', resolution: 128 } }], parts: [
      { name: 'body', role: 'render', geometry: { kind: 'box' }, dimensions: [1, 1, 1], position: [0, 0, .5], material: 'timber' },
      { name: 'proxy', role: 'collision', geometry: { kind: 'box' }, dimensions: [1, 1, 1], position: [0, 0, .5] },
    ] } });
  const { doc, bin: geometry } = unpack(), uv = Buffer.alloc(32), image = png(), measured = audit();
  [0, 0, 1, 0, 0, 1, 1, 1].forEach((value, index) => uv.writeFloatLE(value, index * 4));
  const bin = Buffer.concat([geometry, uv, image, image, image]); doc.buffers[0].byteLength = bin.length;
  doc.bufferViews.push({ buffer: 0, byteOffset: geometry.length, byteLength: uv.length });
  doc.accessors.push({ bufferView: 3, componentType: 5126, count: 4, type: 'VEC2' });
  Object.assign(doc.meshes[0].primitives[0], { material: 0 }); doc.meshes[0].primitives[0].attributes.TEXCOORD_0 = 3;
  const roles = ['baseColor', 'normal', 'metallicRoughness'] as const, suffixes = ['BaseColor', 'Normal', 'MetallicRoughness'];
  doc.images = roles.map((role, index) => { doc.bufferViews.push({ buffer: 0, byteOffset: geometry.length + uv.length + index * image.length, byteLength: image.length });
    return { name: `T_timber_${suffixes[index]}`, mimeType: 'image/png', bufferView: 4 + index }; });
  doc.textures = roles.map((role, index) => ({ source: index, sampler: 0 })); doc.samplers = [{ wrapS: 10497, wrapT: 10497, magFilter: 9729, minFilter: 9987 }];
  doc.materials = [{ name: 'MAT_timber', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicRoughnessTexture: { index: 2 } }, normalTexture: { index: 1 } }];
  const surface: SurfaceEvidence = { profile: 'bark', resolution: 128, generator: 'arcane-tile-v1', texCoord: 0,
    images: roles.map((role, index) => ({ role, name: `T_timber_${suffixes[index]}`, width: 128, height: 128, colorSpace: role === 'baseColor' ? 'sRGB' : 'Non-Color', sha256: sha256(image) })) };
  measured.meshes[0]!.materialProperties = [{ name: 'MAT_timber', color: [.2, .1, .04], metallic: 0, roughness: .5, emission: { color: [1, 1, 1], strength: 0 }, surface }];
  return { doc, bin, request, measured, geometryBytes: geometry.length, image };
}

test('actual UV bytes report mesh location and observed UV without exposing GLB names', () => {
  const f = surfaced(); f.doc.meshes[0].name = 'private-source-text'; f.bin.writeFloatLE(1.25, f.geometryBytes);
  const error = rejected(() => inspectGlb(pack(f.doc, f.bin)), 'EXPORT', /mesh\[0\] primitive\[0\]/, /TEXCOORD_0 element\[0\]/, /observed 1\.25, 0/);
  assert.ok(!error.message.includes('private-source-text'));
});

test('PBR map failures identify material and map role while preserving valid baked defaults', () => {
  const good = surfaced(); validateSurfaceGlb(pack(good.doc, good.bin), good.request, good.measured);
  const changes: [(f: ReturnType<typeof surfaced>) => void, RegExp[]][] = [
    [f => { f.doc.materials[0].normalTexture.texCoord = 1; }, [/material\[0\] normal map/, /texCoord 1 must be 0/]],
    [f => { f.doc.materials[0].normalTexture.scale = .5; }, [/normal map/, /Normal scale 0\.5 must equal 1/]],
    [f => { f.doc.materials[0].pbrMetallicRoughness.roughnessFactor = .25; }, [/material\[0\]/, /roughnessFactor 0\.25 must equal 1/]],
    [f => { delete f.doc.meshes[0].primitives[0].attributes.TEXCOORD_0; }, [/Mesh\[0\] primitive\[0\]/, /missing required TEXCOORD_0/]],
    [f => { f.doc.images[0].uri = 'https://private.invalid/secret-token'; }, [/baseColor map/, /embedded image\/png/]],
    [f => { f.doc.samplers[0].wrapS = 33071; }, [/baseColor map/, /REPEAT \(10497\)/]],
    [f => { f.measured.meshes[0]!.materialProperties![0]!.surface!.images[1]!.sha256 = '0'.repeat(64); }, [/normal map/, /SHA-256 differs/]],
    [f => { f.doc.images[2].name = 'private-image-name'; }, [/metallicRoughness map/, /identity differs/]],
    [f => { f.doc.textures[1].source = 99; }, [/normal map/, /image index 99 must be within 0\.\.2/]],
  ];
  for (const [change, patterns] of changes) {
    const f = surfaced(); change(f);
    const error = rejected(() => validateSurfaceGlb(pack(f.doc, f.bin), f.request, f.measured), 'EXPORT', /^asset\.glb:/, ...patterns);
    for (const forbidden of ['secret-token', 'private-image-name', 'https://']) assert.ok(!error.message.includes(forbidden));
  }
});

test('embedded PNG decode failure keeps its original cause internal', () => {
  const f = surfaced(), start = f.doc.bufferViews[4].byteOffset; f.bin[start] = 0;
  const error = rejected(() => validateSurfaceGlb(pack(f.doc, f.bin), f.request, f.measured), 'EXPORT', /baseColor map/, /bounded image decoding/);
  assert.ok(error.cause instanceof Error); assert.equal(Object.getOwnPropertyDescriptor(error, 'cause')?.enumerable, false);
  assert.ok(!JSON.stringify(error).includes('cause'));
});

test('host audit explains structural counters, totals and triangle budgets', () => {
  const request = normalizeRequest({ template: 'environment-kit', name: 'diagnostic', renderResolution: 128 });
  const structural = audit(); structural.meshes[0]!.duplicateVertices = 3; structural.meshes[0]!.name = 'SM_private-source-text';
  const error = rejected(() => validateAudit(structural, request), 'MESH', /audit\.json mesh\[0\]/, /duplicateVertices is 3; required 0/);
  assert.ok(!error.message.includes('private-source-text'));
  const totals = audit(); totals.totals.renderTriangles = 9;
  rejected(() => validateAudit(totals, request), 'MESH', /renderTriangles total 9/, /measured mesh sum 4/);
  const budget = audit(); budget.meshes[0]!.triangles = 101; budget.totals.renderTriangles = 101;
  rejected(() => validateAudit(budget, { ...request, triangleBudget: 100 }), 'MESH', /Render triangles 101 must be within 1\.\.100/);
});

for (const name of ['asset.glb', 'collision.glb']) test(`manifest pins actual failing geometry filename: ${name}`, async t => {
  const f = await fixture(t), broken = glb((_doc, bin) => bin.writeFloatLE(NaN, 0)); await replace(f.directory, f.manifest, name, broken);
  await manifestError(f.directory, f.manifest, 'EXPORT', new RegExp('^' + name.replace('.', '\\.') + ':'), /mesh\[0\] primitive\[0\]/, /POSITION/, /must be finite/);
});

test('LOD failure identifies asset-lod1.glb with unchanged audit and code admission', async t => {
  const f = await fixture(t), measured = f.manifest.validation, lod = structuredClone(measured.meshes[0]!);
  lod.name = 'SM_Lod'; lod.role = 'lod1'; lod.triangles = 2; measured.meshes.push(lod); measured.totals.lod1Triangles = 2;
  measured.exports.push({ path: 'asset-lod1.glb', objects: 1, triangles: 2, materials: 1, finitePositions: true });
  const bytes = glb((_doc, bin) => { bin[96] = 99; }); await writeFile(join(f.directory, 'asset-lod1.glb'), bytes);
  f.manifest.artifacts.push({ path: 'asset-lod1.glb', role: 'export', bytes: bytes.length, sha256: sha256(bytes) });
  await manifestError(f.directory, f.manifest, 'EXPORT', /^asset-lod1\.glb:/, /Index element\[0\] is 99/);
});

test('manifest triangle count mismatch includes measured and audited counts', async t => {
  const f = await fixture(t); await replace(f.directory, f.manifest, 'asset.glb', glb(doc => { (doc.accessors as Doc[])[2]!.count = 9; }));
  await manifestError(f.directory, f.manifest, 'EXPORT', /^asset\.glb:/, /triangle count 3/, /export audit 4/);
});

test('known review PNG failure identifies file, actual dimensions and CRC reason', async t => {
  const f = await fixture(t), uniform = png(true); await replace(f.directory, f.manifest, 'preview-side.png', uniform);
  await manifestError(f.directory, f.manifest, 'RENDER', /^preview-side\.png:/, /luminance range 0 must be at least 12/);
  rejected(() => inspectPng(png(), 256), 'RENDER', /observed 128x128, required 256x256/);
  const corrupt = png(); corrupt[41] = corrupt[41]! ^ 1; await replace(f.directory, f.manifest, 'preview-side.png', corrupt);
  await manifestError(f.directory, f.manifest, 'RENDER', /^preview-side\.png:/, /CRC integrity/);
});

test('known artifact hash, size and missing-file errors are precise and omit absolute paths', async t => {
  const f = await fixture(t), artifact = f.manifest.artifacts.find(a => a.path === 'asset.glb')!;
  const original = artifact.sha256; artifact.sha256 = '0'.repeat(64);
  await manifestError(f.directory, f.manifest, 'HASH', /^asset\.glb:/, /SHA-256 no longer matches/);
  artifact.sha256 = original; artifact.bytes++;
  await manifestError(f.directory, f.manifest, 'MANIFEST', /^asset\.glb:/, /observed \d+, manifest \d+/);
  artifact.bytes--; await rm(join(f.directory, 'asset.glb'));
  const error = await manifestError(f.directory, f.manifest, 'ARTIFACT', /^asset\.glb: Required artifact is missing\.$/);
  assert.equal((error.cause as NodeJS.ErrnoException).code, 'ENOENT'); assert.equal(Object.getOwnPropertyDescriptor(error, 'cause')?.enumerable, false);
});

test('untrusted artifact and embedded metadata strings cannot become diagnostic labels', async t => {
  const f = await fixture(t); f.manifest.artifacts[0]!.path = 'private-token.glb';
  const error = await manifestError(f.directory, f.manifest, 'MANIFEST', /outside the fixed templates/);
  assert.ok(!error.message.includes('private-token'));
  const data = unpack(); data.doc.buffers[0].uri = 'https://private.invalid/token';
  const external = rejected(() => inspectGlb(pack(data.doc, data.bin)), 'EXPORT', /must be embedded/);
  assert.ok(!external.message.includes('private.invalid')); assert.ok(!external.message.includes('token'));
});

test('artifact details retain host-validation stage and survive bounded journal decoding', async t => {
  const f = await fixture(t); await replace(f.directory, f.manifest, 'asset.glb', glb((_doc, bin) => { bin[96] = 7; }));
  const error = await manifestError(f.directory, f.manifest, 'EXPORT', /^asset\.glb:/, /Index element\[0\] is 7/);
  const diagnostic = hostFailure('host-validation'), saved = { code: error.code, message: failureMessage(error.message, diagnostic), diagnostic };
  assert.match(saved.message, /^Asset failed at host-validation: asset\.glb:/); assert.deepEqual(decodeAssetJobError(saved), saved);
  assert.ok(!(await readFile(join(f.directory, 'asset.glb'))).equals(glb()), 'the test changes actual artifact bytes');
});

test('real pipeline host rejection persists precise artifact details and recovers without replay', async t => {
  const f = await fixture(t), workers = join(f.directory, 'workers'); await mkdir(workers);
  for (const name of ['asset_worker.py', 'audit.py', 'probe.py']) await writeFile(join(workers, name), '# synthetic worker never executed\n');
  let generations = 0;
  const pipeline = new AssetPipeline({ workspaceRoot: f.directory, outputRoot: join(f.directory, 'jobs'), workerRoot: workers }, {
    discover: async () => ({ blender: [process.execPath], python: [] }),
    queryHost: { platform: 'linux', systemRoot: undefined, execFile: () => { throw Error('No process inspection in artifact diagnostics tests.'); } },
    run: async (spec, options = {}) => {
      await options.supervise?.spawned({ pid: 12345, exited: () => true });
      try {
        if (spec.args.includes('--mode')) {
          generations++; await manifestFixture(spec.cwd);
          await writeFile(join(spec.cwd, 'asset.glb'), glb((_doc, bin) => { bin[96] = 7; }));
          return { exitCode: 0, signal: null, stderr: '', stdout: 'ARCANE_RESULT {"audit":"audit.json"}\n' };
        }
        return { exitCode: 0, signal: null, stderr: '', stdout: 'ARCANE_RESULT ' + JSON.stringify({ version: '4.5.0', pythonVersion: '3.11.0', background: true,
          capabilities: { glbExport: true, glbImport: true, fbxExport: true, fbxImport: true, cycles: true } }) + '\n' };
      } finally { options.supervise?.closed(); }
    },
  });
  const job = pipeline.start({ template: 'environment-kit', name: 'test-kit', renderResolution: 128 }), result = await job.completion;
  assert.equal(result.state, 'failed'); assert.equal(result.error?.code, 'EXPORT'); assert.equal(result.manifestPath, null);
  assert.match(result.error!.message, /^Asset failed at host-validation: asset\.glb: GLB mesh\[0\] primitive\[0\]: Index element\[0\] is 7; required 0\.\.3/);
  assert.equal(result.error!.diagnostic?.stage, 'host-validation'); assert.equal(result.error!.diagnostic?.logPath, 'failure.json');
  assert.ok(!result.error!.message.includes(job.directory)); assert.deepEqual((await pipeline.recover(job.directory)).result.error, result.error);
  assert.equal(generations, 1);
  const journal = JSON.parse(await readFile(join(job.directory, 'job.json'), 'utf8')) as { workers: { state: string }[] };
  assert.equal(journal.workers.length, 2); assert.ok(journal.workers.every(record => record.state === 'closed'));
});
