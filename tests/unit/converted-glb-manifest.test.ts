import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm, link, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import { validateGlb } from '../../apps/desktop/src/glb-preflight.js';
import { prepareGlbConversionSource } from '../../packages/asset-pipeline/src/glb-conversion-source.js';
import { convertedGlbObjectId, convertedGlbAssetId, GLB_CONVERSION_WORKERS } from '../../packages/asset-pipeline/src/converted-glb.js';
import { parseConvertedGlbManifest, parseConvertedGlbJson, validateConvertedGlbManifestFiles, CONVERTED_GLB_ARTIFACT_LIMITS } from '../../packages/asset-pipeline/src/converted-glb-manifest.js';
import { AssetError, type Artifact } from '../../packages/asset-pipeline/src/types.js';

// These genuine constructed GLB/PNG/file bytes test retained-data admission.
// The audit/runtime/scene/script fixtures are explicitly synthetic, do not run
// Blender, and cannot establish native execution, owned close, review or import.
type Doc = Record<string, any>;
const JOB = '11111111-1111-4111-8111-111111111111', PARENT = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const json = (value: unknown) => Buffer.from(JSON.stringify(value));
const roles: Record<string, Artifact['role']> = { 'source.glb': 'request', 'import-source.glb': 'request', 'parent-manifest.json': 'request',
  'source-map.json': 'request', 'request.json': 'request', 'convert_glb.py': 'worker', 'conversion_audit.py': 'worker', 'probe.py': 'worker',
  'asset.blend': 'scene', 'asset.glb': 'export', 'conversion-audit.json': 'audit', 'preview-hero.png': 'preview', 'preview-side.png': 'preview', 'collision.glb': 'export' };
function pack(doc: Doc, bin: Buffer): Buffer {
  doc.buffers[0].byteLength = bin.length;
  const encoded = json(doc), j = Math.ceil(encoded.length / 4) * 4, b = Math.ceil(bin.length / 4) * 4, result = Buffer.alloc(28 + j + b);
  result.writeUInt32LE(0x46546c67); result.writeUInt32LE(2, 4); result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(j, 12); result.writeUInt32LE(0x4e4f534a, 16); result.fill(32, 20, 20 + j); encoded.copy(result, 20);
  result.writeUInt32LE(b, 20 + j); result.writeUInt32LE(0x004e4942, 24 + j); bin.copy(result, 28 + j); return result;
}
function geometry(positions: number[][], faces: number[], material = false): { doc: Doc; bin: Buffer } {
  const p = Buffer.alloc(positions.length * 12), ix = Buffer.alloc(faces.length * 2);
  positions.flat().forEach((value, at) => p.writeFloatLE(value, at * 4)); faces.forEach((value, at) => ix.writeUInt16LE(value, at * 2));
  const doc: Doc = { asset: { version: '2.0', generator: 'synthetic GLB byte fixture, not native proof' }, buffers: [{ byteLength: 0 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: p.length }, { buffer: 0, byteOffset: p.length, byteLength: ix.length }],
    accessors: [{ bufferView: 0, componentType: 5126, count: positions.length, type: 'VEC3',
      min: [0, 1, 2].map(axis => Math.min(...positions.map(row => row[axis]!))), max: [0, 1, 2].map(axis => Math.max(...positions.map(row => row[axis]!))) },
    { bufferView: 1, componentType: 5123, count: faces.length, type: 'SCALAR' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }], nodes: [{ mesh: 0 }], scene: 0, scenes: [{ nodes: [0] }] };
  if (material) { doc.materials = [{ doubleSided: true, alphaMode: 'MASK', pbrMetallicRoughness: { baseColorFactor: [.2, .5, .1, 1], metallicFactor: 0, roughnessFactor: .8 } },
    { pbrMetallicRoughness: { baseColorFactor: [.5, .2, .1, 1] } }];
    doc.meshes[0].primitives = [0, 1].map(index => ({ attributes: { POSITION: 0 }, indices: 1, material: index }));
    doc.nodes = [{ translation: [2, 3, 4], children: [1, 2, 3] }, { mesh: 0 }, { mesh: 0, translation: [4, 0, 0] }, { translation: [0, 1, 0] }];
  }
  return { doc, bin: Buffer.concat([p, ix]) };
}
function png(size = 128, uniform = false): Buffer {
  const chunk = (kind: string, bytes: Buffer) => { const result = Buffer.alloc(bytes.length + 12); result.writeUInt32BE(bytes.length); result.write(kind, 4); bytes.copy(result, 8);
    let crc = 0xffffffff; for (const byte of result.subarray(4, bytes.length + 8)) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1; }
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, bytes.length + 8); return result; };
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { const at = y * (size * 4 + 1) + 1 + x * 4, value = uniform ? 64 : x < size / 2 ? 0 : 255; pixels.fill(value, at, at + 3); pixels[at + 3] = 255; }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
type CollisionKind = 'valid' | 'seams' | 'open' | 'flipped' | 'inward' | 'planar' | 'duplicate' | 'cracked' | 'disconnected';
async function fixture(t: TestContext, collision = false) {
  const directory = await mkdtemp(join(tmpdir(), 'arcane-conversion-files-')); t.after(() => rm(directory, { recursive: true, force: true }));
  // Two real adjacent faces with duplicated seam positions, two materials, two
  // shared instances and an empty leaf; no closed-solid assumption for foliage.
  const original = geometry([[0, 0, 0], [2, 0, 0], [0, 1, 0], [2, 0, 0], [2, 1, 0], [0, 1, 0]], [0, 1, 2, 3, 4, 5], true);
  const source = pack(original.doc, original.bin), prepared = prepareGlbConversionSource(source, sha(source));
  const files = new Map<string, Buffer>([['source.glb', source], ['import-source.glb', prepared.importBytes], ['asset.blend', Buffer.from('BLENDER-v300 synthetic retained bytes; no native process ran')],
    ['preview-hero.png', png()], ['preview-side.png', png()]]);
  for (const worker of GLB_CONVERSION_WORKERS) files.set(worker, Buffer.from('# synthetic fixed-worker artifact, never executed\n'));
  const adopted = { schemaVersion: 1, template: 'adopted-glb', name: 'original-tree', path: 'never-reopened/missing-project-source.glb', sourceSha256: sha(source), sourceBytes: source.length };
  const parent: Doc = { schemaVersion: 1, jobId: PARENT, createdAt: '2026-10-26T00:00:00.000Z', request: adopted,
    provenance: { kind: 'native-project-glb', projectId: sha('synthetic-project'), conversation: { provider: 'claude-code', threadId: 'app:' + OTHER, sessionId: null }, sourceSha256: sha(source), sourceBytes: source.length },
    validation: { kind: 'glb-preview-preflight', metadata: validateGlb(Uint8Array.from(source).buffer), imageDecode: 'not-run', engineVerification: 'pending' },
    engineImport: { status: 'unavailable', reason: 'adopted-origin-requires-safe-conversion' }, artifacts: [
      { path: 'asset.glb', role: 'export', bytes: source.length, sha256: sha(source) }, { path: 'request.json', role: 'request', bytes: json(adopted).length, sha256: sha(json(adopted)) }], limitations: ['Original adopted source remains preview-only.'] };
  const map: Doc = { schemaVersion: 1, sourceSha256: sha(source), importSha256: prepared.importSha256, sourceSceneIndex: prepared.sourceSceneIndex,
    declaredSceneCount: prepared.declaredSceneCount, parts: prepared.parts };
  const request: Doc = { schemaVersion: 1, kind: 'converted-glb', jobId: JOB, parentJobId: PARENT, parentManifestSha256: '', name: 'converted-tree',
    sourceSha256: sha(source), sourceBytes: source.length, importSha256: prepared.importSha256, importBytes: prepared.importBytes.length, sourceMapSha256: '', collision: collision ? 'convex-hull' : 'none', renderResolution: 128, renderSamples: 8 };
  const j = prepared.importBytes.readUInt32LE(12), outputDoc: Doc = JSON.parse(prepared.importBytes.subarray(20, 20 + j).toString('utf8')) as Doc;
  const outputBin = Buffer.from(prepared.importBytes.subarray(28 + j)); outputDoc.asset.generator = 'synthetic GLB byte fixture, not native proof';
  for (const part of prepared.parts) Object.assign(outputDoc.nodes[part.importNodeIndex].extras, { arcane_identity_scheme: 'arcane-converted-v1',
    arcane_source_object_id: convertedGlbObjectId(request.sourceSha256, 'render', part.sourceKey), arcane_source_key: part.sourceKey,
    arcane_role: 'render', arcane_pivot: [0, 0, 0], arcane_collision_for: '[]' });
  files.set('asset.glb', pack(outputDoc, outputBin));
  const measured = prepared.parts.map(part => ({ sourceKey: part.sourceKey, originMarker: part.originMarker, sourceObjectId: convertedGlbObjectId(request.sourceSha256, 'render', part.sourceKey),
    vertices: 6, triangles: 2, boundaryEdges: 6, nonManifoldEdges: 6, looseVertices: 0, looseEdges: 0, degenerateFaces: 0, invalidUVs: 0, uvLayers: 0, finitePositions: true,
    geometrySha256: sha('synthetic observed geometry, not native proof'), materialSha256: sha('synthetic observed material, not native proof') }));
  const audit: Doc = { schemaVersion: 1, kind: 'arcane-glb-conversion-audit', jobId: JOB, parentJobId: PARENT, parentManifestSha256: '', requestSha256: '',
    sourceSha256: request.sourceSha256, importSha256: request.importSha256, sourceMapSha256: '', identityScheme: 'arcane-converted-v1', assetId: convertedGlbAssetId(request.sourceSha256),
    blenderVersion: 'synthetic observed version', collision: request.collision, importedParts: measured, reopenedParts: structuredClone(measured),
    models: [{ path: 'asset.glb', sha256: '', byteLength: 1, generator: outputDoc.asset.generator, objects: prepared.parts.map(part => ({ sourceObjectId: convertedGlbObjectId(request.sourceSha256, 'render', part.sourceKey),
      sourceKey: part.sourceKey, nodeIndex: part.importNodeIndex, role: 'render', pivot: [0, 0, 0], collisionFor: [], originMarker: part.originMarker })), anchors: [] }],
    renders: ['preview-hero.png', 'preview-side.png'].map(path => ({ path, width: 128, height: 128, finitePixels: true, minLuminance: 0, maxLuminance: 1, meanLuminance: .4, standardDeviation: .1 })),
    savedSceneReopened: true, errors: [], warnings: ['open-render-surfaces', 'delivery-support-pending', ...(collision ? [] : ['no-collision-proxy'])] };
  function collisionBytes(kind: CollisionKind = 'valid'): Buffer {
    let positions = [[0, 0, 0], [2, 0, 0], [0, 2, 0], kind === 'planar' ? [.5, .5, 0] : [0, 0, 2]], indices = [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3];
    if (kind === 'open') { positions.push([1, 1, 0]); indices = [0, 1, 3, 0, 3, 2, 1, 4, 3, 4, 2, 3]; }
    if (kind === 'flipped') [indices[0], indices[1]] = [indices[1]!, indices[0]!];
    if (kind === 'inward') for (let at = 0; at < indices.length; at += 3) [indices[at], indices[at + 1]] = [indices[at + 1]!, indices[at]!];
    if (kind === 'duplicate') indices.push(...indices.slice(0, 3));
    if (kind === 'disconnected') { positions.push(...positions.map(row => [row[0]! + 10, row[1]!, row[2]!])); indices.push(...indices.map(value => value + 4)); }
    if (kind === 'seams' || kind === 'cracked') { positions = indices.map(value => [...positions[value]!]); indices = positions.map((_, at) => at); if (kind === 'cracked') positions[0]![0] = .0000001; }
    const { doc, bin } = geometry(positions, indices);
    doc.nodes[0].extras = { arcane_identity_scheme: 'arcane-converted-v1', arcane_source_object_id: convertedGlbObjectId(request.sourceSha256, 'collision', 'proxy'), arcane_source_key: 'proxy',
      arcane_role: 'collision', arcane_pivot: [0, 0, 0], arcane_collision_for: JSON.stringify(prepared.parts.map(part => convertedGlbObjectId(request.sourceSha256, 'render', part.sourceKey)).sort()) };
    return pack(doc, bin);
  }
  if (collision) { files.set('collision.glb', collisionBytes()); audit.models.push({ path: 'collision.glb', sha256: '', byteLength: 1, generator: outputDoc.asset.generator,
    objects: [{ sourceObjectId: convertedGlbObjectId(request.sourceSha256, 'collision', 'proxy'), sourceKey: 'proxy', nodeIndex: 0, role: 'collision', pivot: [0, 0, 0],
      collisionFor: prepared.parts.map(part => convertedGlbObjectId(request.sourceSha256, 'render', part.sourceKey)).sort(), originMarker: null }], anchors: [] }); }
  let value: Doc = {};
  async function seal(overrides: { requestRaw?: Buffer; mapRaw?: Buffer; auditRaw?: Buffer } = {}): Promise<void> {
    files.set('parent-manifest.json', json(parent)); request.parentManifestSha256 = sha(files.get('parent-manifest.json')!);
    request.sourceSha256 = sha(files.get('source.glb')!); request.sourceBytes = files.get('source.glb')!.length;
    request.importSha256 = sha(files.get('import-source.glb')!); request.importBytes = files.get('import-source.glb')!.length;
    map.sourceSha256 = request.sourceSha256; map.importSha256 = request.importSha256;
    files.set('source-map.json', overrides.mapRaw ?? json(map)); request.sourceMapSha256 = sha(files.get('source-map.json')!);
    files.set('request.json', overrides.requestRaw ?? json(request));
    Object.assign(audit, { parentManifestSha256: request.parentManifestSha256, sourceSha256: request.sourceSha256, importSha256: request.importSha256,
      sourceMapSha256: request.sourceMapSha256, requestSha256: sha(files.get('request.json')!) });
    for (const model of audit.models) { model.sha256 = sha(files.get(model.path)!); model.byteLength = files.get(model.path)!.length; }
    files.set('conversion-audit.json', overrides.auditRaw ?? json(audit));
    value = { schemaVersion: 1, origin: 'converted-glb', jobId: JOB, createdAt: '2026-10-26T00:00:01.000Z', request,
      runtime: { executable: join(directory, 'never-launched-fixture.exe'), version: audit.blenderVersion, pythonVersion: 'synthetic', background: true,
        capabilities: { glbExport: true, glbImport: true, fbxExport: true, fbxImport: true, cycles: true } },
      workerBundleSha256: sha(GLB_CONVERSION_WORKERS.map(name => sha(files.get(name)!)).join('\n')),
      coordinateSystem: { units: 'meters', sceneUp: 'Z', glbUp: 'Y', pivot: 'source', robloxScaleVerified: false }, sourceMap: map, validation: audit,
      artifacts: [...files].map(([path, bytes]) => ({ path, role: roles[path], bytes: bytes.length, sha256: sha(bytes) })), limitations: ['File validation is not owned-process, review or native import proof.'] };
    for (const [path, bytes] of files) await writeFile(join(directory, path), bytes);
  }
  await seal();
  return { directory, files, parent, request, map, audit, outputDoc, outputBin, collisionBytes, seal, get value(): Doc { return value; } };
}
const manifestError = (error: unknown) => error instanceof AssetError && error.code === 'ASSET_CONVERSION_MANIFEST';
const collisionError = (error: unknown) => error instanceof AssetError && error.code === 'ASSET_CONVERSION_COLLISION';

test('conversion raw JSON parser preserves valid escaped data and rejects duplicate keys, invalid UTF8 and structural overflow', () => {
  const text = '{"escaped":"quote\\\" and slash\\\\","unicode":"🧩","array":[true,null,-0.25e2]}';
  assert.equal(JSON.stringify(parseConvertedGlbJson(Buffer.from(text))), JSON.stringify(JSON.parse(text) as unknown));
  for (const raw of [Buffer.from('{"a":1,"\\u0061":2}'), Buffer.from('{"nested":{"a":1,"a":2}}'), Buffer.from('[1,]'), Buffer.from('{"a":1} true'),
    Buffer.from('"\\ud800"'), Buffer.from('{"__proto__":{}}'), Buffer.from([0xff]), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{}')]),
    Buffer.from('['.repeat(18) + '0' + ']'.repeat(18)), Buffer.from('1e999'), Buffer.alloc(CONVERTED_GLB_ARTIFACT_LIMITS.jsonBytes + 1, 32)]) {
    assert.throws(() => parseConvertedGlbJson(raw), manifestError);
  }
});

test('conversion retained files validate actual multimesh/material/seam/open surfaces without inventing native closure or authority', async t => {
  const f = await fixture(t), manifest = await validateConvertedGlbManifestFiles(f.directory, f.value);
  assert.equal(manifest.artifacts.length, 13); assert.equal(manifest.sourceMap.parts.length, 4); assert.ok(Object.isFrozen(manifest.sourceMap.parts[0]!.worldMatrix));
  assert.equal(manifest.coordinateSystem.robloxScaleVerified, false); assert.equal('ownedProcessClosed' in manifest, false); assert.equal('approved' in manifest, false);
  assert.equal('engineImport' in manifest, false); assert.equal(manifest.runtime.executable.endsWith('never-launched-fixture.exe'), true);
  await assert.rejects(readFile(manifest.runtime.executable), { code: 'ENOENT' });
  assert.deepEqual(await validateConvertedGlbManifestFiles(f.directory, structuredClone(manifest)), manifest);
});
test('conversion manifest refuses proxies/getters/unknown fields and escaped byte amplification without invoking code', async t => {
  const f = await fixture(t); let invoked = 0;
  const getter = Object.defineProperty({ ...f.value }, 'runtime', { enumerable: true, get() { invoked++; return f.value.runtime; } });
  assert.throws(() => parseConvertedGlbManifest(getter), manifestError);
  const proxy = new Proxy({}, { ownKeys() { invoked++; throw Error('must not inspect'); } }); assert.throws(() => parseConvertedGlbManifest(proxy), manifestError); assert.equal(invoked, 0);
  assert.throws(() => parseConvertedGlbManifest({ ...f.value, ownedProcessClosed: true }), manifestError);
  assert.throws(() => parseConvertedGlbManifest({ ...f.value, amplification: Array.from({ length: 100 }, () => '\u0000'.repeat(1024)) }), manifestError);
});
test('conversion artifact inventory is exact, fixed-role, unique and bounded before any file authority', async t => {
  const f = await fixture(t);
  for (const mutate of [(v: Doc) => v.artifacts.pop(), (v: Doc) => v.artifacts.push({ ...v.artifacts[0] }),
    (v: Doc) => v.artifacts.push({ ...v.artifacts.find((a: Artifact) => a.path === 'asset.glb'), path: 'collision.glb' }),
    (v: Doc) => v.artifacts[0].path = '../source.glb', (v: Doc) => v.artifacts[0].role = 'export',
    (v: Doc) => v.artifacts[0].bytes = CONVERTED_GLB_ARTIFACT_LIMITS.sourceBytes + 1,
    (v: Doc) => v.runtime.capabilities.glbImport = false, (v: Doc) => v.runtime.version = 'other-version']) {
    const value = structuredClone(f.value); mutate(value); assert.throws(() => parseConvertedGlbManifest(value), manifestError);
  }
  const excessive = structuredClone(f.value);
  for (const artifact of excessive.artifacts) if (artifact.path === 'source.glb' || artifact.path === 'import-source.glb') artifact.bytes = CONVERTED_GLB_ARTIFACT_LIMITS.sourceBytes;
  excessive.artifacts.find((a: Artifact) => a.path === 'asset.blend').bytes = CONVERTED_GLB_ARTIFACT_LIMITS.blendBytes;
  assert.throws(() => parseConvertedGlbManifest(excessive), manifestError);
});
test('conversion source/worker/scene artifact byte changes and hardlinks fail actual retained-file checks', async t => {
  for (const path of ['source.glb', 'convert_glb.py', 'asset.blend']) { const f = await fixture(t), changed = Buffer.from(f.files.get(path)!); const at = Math.floor(changed.length / 2); changed[at] = changed[at]! ^ 1;
    await writeFile(join(f.directory, path), changed); await assert.rejects(validateConvertedGlbManifestFiles(f.directory, f.value), (error: unknown) => error instanceof AssetError && error.code === 'HASH'); }
  const linked = await fixture(t); await link(join(linked.directory, 'source.glb'), join(linked.directory, 'unlisted-hardlink'));
  await assert.rejects(validateConvertedGlbManifestFiles(linked.directory, linked.value), AssetError);
});
test('conversion retained directory junction/symlink is refused without authorizing unrelated directory files', async t => {
  const f = await fixture(t), alias = f.directory + '-link'; t.after(() => rm(alias, { force: true, recursive: true }));
  await symlink(f.directory, alias, process.platform === 'win32' ? 'junction' : 'dir'); await assert.rejects(validateConvertedGlbManifestFiles(alias, f.value), AssetError);
});
test('conversion parent job, actual preview metadata and provider scope remain original retained provenance', async t => {
  for (const mutate of [(p: Doc) => p.jobId = OTHER, (p: Doc) => p.validation.metadata.triangleEstimate++,
    (p: Doc) => p.provenance.conversation.sessionId = 'invented-provider-session', (p: Doc) => p.provenance.sourceBytes++]) {
    const f = await fixture(t); mutate(f.parent); await f.seal(); await assert.rejects(validateConvertedGlbManifestFiles(f.directory, f.value), AssetError);
  }
});
test('conversion import copy must equal exact C31 regeneration even when new bytes and all hash claims agree', async t => {
  const f = await fixture(t), raw = f.files.get('import-source.glb')!, j = raw.readUInt32LE(12), doc = JSON.parse(raw.subarray(20, 20 + j).toString('utf8')) as Doc;
  doc.asset.generator = 'altered harmless metadata, not original marked bytes'; f.files.set('import-source.glb', pack(doc, raw.subarray(28 + j)));
  await f.seal(); await assert.rejects(validateConvertedGlbManifestFiles(f.directory, f.value), manifestError);
});
test('conversion fixed raw JSON files require unique keys and exact structural agreement, not hash-only acceptance', async t => {
  const duplicate = await fixture(t), ordinary = json(duplicate.request).toString('utf8');
  await duplicate.seal({ requestRaw: Buffer.from('{"schemaVersion":1,' + ordinary.slice(1)) });
  await assert.rejects(validateConvertedGlbManifestFiles(duplicate.directory, duplicate.value), manifestError);
  const changed = await fixture(t), observed = structuredClone(changed.audit); observed.renders[0].meanLuminance = .6;
  await changed.seal({ auditRaw: json(observed) }); await assert.rejects(validateConvertedGlbManifestFiles(changed.directory, changed.value), manifestError);
});
test('conversion rejects resealed actual output material/geometry loss independently of matching synthetic worker claims', async t => {
  for (const change of [(doc: Doc) => doc.materials[0].pbrMetallicRoughness.baseColorFactor[0] = .9,
    (doc: Doc) => doc.nodes[0].translation[0]++, (doc: Doc) => delete doc.nodes[4].extras.arcane_conversion_origin_v1]) {
    const f = await fixture(t); change(f.outputDoc); f.files.set('asset.glb', pack(f.outputDoc, f.outputBin)); await f.seal();
    await assert.rejects(validateConvertedGlbManifestFiles(f.directory, f.value), AssetError);
  }
});
test('conversion decodes real preview dimensions and rejects actual uniform pixels despite positive audit statistics', async t => {
  for (const image of [png(256), png(128, true)]) { const f = await fixture(t); f.files.set('preview-hero.png', image); await f.seal(); await assert.rejects(validateConvertedGlbManifestFiles(f.directory, f.value), AssetError); }
});
test('conversion validates real closed positive collision and permits normal-seam duplicate indices without welding render geometry', async t => {
  for (const kind of ['valid', 'seams'] as const) { const f = await fixture(t, true); f.files.set('collision.glb', f.collisionBytes(kind)); await f.seal();
    const result = await validateConvertedGlbManifestFiles(f.directory, f.value); assert.equal(result.artifacts.length, 14); assert.equal(result.validation.collision, 'convex-hull'); }
});
for (const kind of ['open', 'flipped', 'inward', 'planar', 'duplicate', 'cracked', 'disconnected'] as const)
  test('conversion collision refuses actual ' + kind + ' topology with fully resealed model hashes', async t => {
    const f = await fixture(t, true); f.files.set('collision.glb', f.collisionBytes(kind)); await f.seal();
    await assert.rejects(validateConvertedGlbManifestFiles(f.directory, f.value), collisionError);
  });
test('conversion collision actual extras/materials/targets must agree with exact mapped source objects', async t => {
  for (const change of [(doc: Doc) => doc.nodes[0].extras.arcane_collision_for = '[]',
    (doc: Doc) => doc.nodes[0].extras.arcane_source_object_id = convertedGlbObjectId(sha('foreign'), 'collision', 'proxy'),
    (doc: Doc) => { doc.materials = [{}]; doc.meshes[0].primitives[0].material = 0; }]) {
    const f = await fixture(t, true), raw = f.files.get('collision.glb')!, j = raw.readUInt32LE(12), doc = JSON.parse(raw.subarray(20, 20 + j).toString('utf8')) as Doc;
    change(doc); f.files.set('collision.glb', pack(doc, raw.subarray(28 + j))); await f.seal(); await assert.rejects(validateConvertedGlbManifestFiles(f.directory, f.value), collisionError);
  }
});
