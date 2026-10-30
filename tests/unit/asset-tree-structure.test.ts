import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { deflateSync } from 'node:zlib';
import { audit, glb, manifestFixture, png } from '../../packages/asset-pipeline/testing/fixture.js';
import { AssetError, type Artifact, type AssetManifest, type MaterialEvidence } from '../../packages/asset-pipeline/src/types.js';
import { normalizeRequest, pngCrc, readTreeStructureReview, sha256, TREE_STRUCTURE_WORKER_SCRIPTS, validateAudit, validateManifestFiles, workerScripts } from '../../packages/asset-pipeline/src/validation.js';

// Synthetic bytes and measured-schema fixtures only; no Blender or native proof.
const refused = (expected: string) => (error: unknown) => error instanceof AssetError && error.code === expected;
const materialPng = () => {
  const side = 512, raw = Buffer.alloc((side * 3 + 1) * side);
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) raw.fill(x < side / 2 ? 25 : 210, y * (side * 3 + 1) + 1 + x * 3, y * (side * 3 + 1) + 1 + (x + 1) * 3);
  const header = Buffer.alloc(13); header.writeUInt32BE(side); header.writeUInt32BE(side, 4); header[8] = 8; header[9] = 2;
  const chunk = (name: string, data: Buffer) => {
    const bytes = Buffer.alloc(data.length + 12); bytes.writeUInt32BE(data.length); bytes.write(name, 4); data.copy(bytes, 8);
    bytes.writeUInt32BE(pngCrc(bytes.subarray(4, 8 + data.length)), 8 + data.length); return bytes;
  };
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
};
function treeFixture(structure = true) {
  const request = normalizeRequest({ template: 'procedural', name: 'review-oak', seed: 17, renderResolution: 128,
    procedural: { kind: 'tree', species: 'oak', finish: 'natural', leafDensity: 0 } });
  const requestText = JSON.stringify(request, null, 2) + '\n', image = materialPng(), a = audit();
  const bark = a.meshes[0]!; bark.name = 'SM_review-oak_bark'; bark.materials = ['MAT_Bark'];
  // The controlled tetrahedron in glb() is the entire synthetic bark mesh.
  const geometrySha256 = sha256(Buffer.from('{"vertices":[[0.0,0.0,0.0],[1.0,0.0,0.0],[0.0,1.0,0.0],[0.0,0.0,1.0]],"triangles":[[0,2,1],[0,1,3],[1,2,3],[2,0,3]]}'));
  if (structure) bark.geometrySha256 = geometrySha256;
  const roles = ['baseColor', 'normal', 'metallicRoughness'] as const, suffixes = ['BaseColor', 'Normal', 'MetallicRoughness'];
  const material: MaterialEvidence = { name: 'MAT_Bark', color: [...request.color], metallic: 0, roughness: .92,
    emission: { color: [1, 1, 1], strength: 0 }, surface: { profile: 'bark', resolution: 512, generator: 'arcane-tile-v1', texCoord: 0, pattern: 'oak-bark', alphaMode: 'OPAQUE',
      images: roles.map((role, index) => ({ role, name: 'T_Bark_' + suffixes[index], width: 512, height: 512, sha256: sha256(image), colorSpace: role === 'baseColor' ? 'sRGB' : 'Non-Color' })) } };
  bark.materialProperties = [material]; a.template = 'procedural';
  const original = glb(), jsonLength = original.readUInt32LE(12), geometry = original.subarray(28 + jsonLength), uv = Buffer.alloc(32);
  [0, 0, 1, 0, 0, 1, 1, 1].forEach((value, index) => uv.writeFloatLE(value, index * 4));
  const bin = Buffer.concat([geometry, uv, image, image, image]);
  const doc = { asset: { version: '2.0' }, buffers: [{ byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 48 }, { buffer: 0, byteOffset: 48, byteLength: 48 }, { buffer: 0, byteOffset: 96, byteLength: 12 }, { buffer: 0, byteOffset: 108, byteLength: 32 },
      ...roles.map((_, index) => ({ buffer: 0, byteOffset: 140 + index * image.length, byteLength: image.length }))],
    accessors: [{ bufferView: 0, componentType: 5126, count: 4, type: 'VEC3' }, { bufferView: 1, componentType: 5126, count: 4, type: 'VEC3' }, { bufferView: 2, componentType: 5121, count: 12, type: 'SCALAR' }, { bufferView: 3, componentType: 5126, count: 4, type: 'VEC2' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 3 }, indices: 2, material: 0 }] }],
    materials: [{ name: 'MAT_Bark', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicRoughnessTexture: { index: 2 } }, normalTexture: { index: 1 } }],
    textures: roles.map((_, index) => ({ source: index, sampler: 0 })), samplers: [{ wrapS: 10497, wrapT: 10497, magFilter: 9729, minFilter: 9987 }],
    images: roles.map((_, index) => ({ name: 'T_Bark_' + suffixes[index], mimeType: 'image/png', bufferView: 4 + index })) };
  const rawJson = Buffer.from(JSON.stringify(doc)), paddedJson = Buffer.alloc(Math.ceil(rawJson.length / 4) * 4, 32); rawJson.copy(paddedJson);
  const paddedBin = Buffer.alloc(Math.ceil(bin.length / 4) * 4); bin.copy(paddedBin);
  const render = Buffer.alloc(28 + paddedJson.length + paddedBin.length);
  render.writeUInt32LE(0x46546c67); render.writeUInt32LE(2, 4); render.writeUInt32LE(render.length, 8); render.writeUInt32LE(paddedJson.length, 12); render.writeUInt32LE(0x4e4f534a, 16); paddedJson.copy(render, 20);
  render.writeUInt32LE(paddedBin.length, 20 + paddedJson.length); render.writeUInt32LE(0x004e4942, 24 + paddedJson.length); paddedBin.copy(render, 28 + paddedJson.length);
  if (structure) {
    a.treeStructure = { schemaVersion: 1, path: 'preview-structure.png', requestSha256: sha256(Buffer.from(requestText)),
      sourceObjects: [{ sourceKey: 'bark', sourceObjectId: 'arcane_' + sha256(Buffer.from(['arcane-semantic-v1', request.template, request.name, 'render', 'bark'].join('\0'))), geometrySha256 }],
      views: ['front', 'side', 'oblique', 'roots'] };
    a.renders.push({ ...a.renders[0]!, path: 'preview-structure.png' });
  }
  return { request, audit: a, requestText, render };
}
async function directory(t: test.TestContext) {
  const base = await realpath(tmpdir()), root = await mkdtemp(join(base, 'arcane-tree-structure-'));
  t.after(async () => { const child = relative(base, await realpath(root)); assert.ok(!isAbsolute(child) && child.startsWith('arcane-tree-structure-') && !child.includes(sep) && !child.includes('..')); await rm(root, { recursive: true, force: true }); });
  return root;
}
async function retained(t: test.TestContext, structure = true) {
  const root = await directory(t), f = treeFixture(structure);
  const scripts = workerScripts(f.request).filter(name => structure || !TREE_STRUCTURE_WORKER_SCRIPTS.includes(name));
  const files: Record<string, Buffer | string> = { 'asset.blend': 'synthetic saved scene', 'blockout.blend': 'synthetic checkpoint', 'asset.glb': f.render, 'asset.fbx': 'synthetic FBX', 'collision.glb': glb(),
    'preview-hero.png': png(), 'preview-side.png': png(), ...(structure ? { 'preview-structure.png': png() } : {}),
    'request.json': f.requestText, 'input.json': JSON.stringify(f.request) + '\n', 'audit.json': JSON.stringify(f.audit), ...Object.fromEntries(scripts.map(name => [name, '# synthetic retained worker; never executed\n'])) };
  const artifacts: Artifact[] = [];
  for (const [path, value] of Object.entries(files)) {
    const bytes = Buffer.from(value); await writeFile(join(root, path), bytes);
    const role: Artifact['role'] = path.endsWith('.blend') ? path === 'blockout.blend' ? 'checkpoint' : 'scene' : /\.(glb|fbx)$/.test(path) ? 'export' : path.endsWith('.png') ? 'preview' : path.endsWith('.py') ? 'worker' : path === 'audit.json' ? 'audit' : 'request';
    artifacts.push({ path, role, bytes: bytes.length, sha256: sha256(bytes) });
  }
  const manifest: AssetManifest = { schemaVersion: 2, jobId: '11111111-1111-4111-8111-111111111111', createdAt: '2026-01-01T00:00:00Z', request: f.request,
    runtime: { executable: 'synthetic-not-run', version: 'synthetic', pythonVersion: 'synthetic', background: true, capabilities: { glbExport: true, glbImport: true, fbxExport: true, fbxImport: true, cycles: true } },
    templateSha256: sha256(Buffer.from(scripts.map(name => artifacts.find(a => a.path === name)!.sha256).join('\n'))), sourceRequestSha256: artifacts.find(a => a.path === 'input.json')!.sha256,
    coordinateSystem: { units: 'meters', sceneUp: 'Z', glbUp: 'Y', fbxUp: 'Y', pivot: 'floor', robloxScaleVerified: false }, validation: f.audit, artifacts,
    limitations: ['Synthetic retained artifacts; no worker, Blender or visual acceptance.'] };
  return { root, manifest };
}

test('tree structure metadata is exact, detached and bound to natural bark, semantic identity and request bytes', () => {
  const f = treeFixture(), value = f.audit.treeStructure!;
  const parsed = readTreeStructureReview(value, f.request, f.audit.meshes, sha256(Buffer.from(f.requestText)));
  assert.deepEqual(parsed, value); assert.notEqual(parsed, value); assert.notEqual(parsed.sourceObjects, value.sourceObjects); assert.notEqual(parsed.views, value.views);
  assert.equal(validateAudit(f.audit, f.request, 2, value.requestSha256).renders.length, 3);
  for (const bad of [{ ...value, schemaVersion: 2 }, { ...value, extra: true }, { ...value, path: '../preview-structure.png' }, { ...value, requestSha256: value.requestSha256 + '\n' },
    { ...value, views: ['front', 'side', 'oblique', 'back'] }, { ...value, views: ['side', 'front', 'oblique', 'roots'] },
    { ...value, sourceObjects: [] }, { ...value, sourceObjects: [...value.sourceObjects, value.sourceObjects[0]] },
    { ...value, sourceObjects: [{ ...value.sourceObjects[0], sourceKey: 'leaves' }] }, { ...value, sourceObjects: [{ ...value.sourceObjects[0], sourceObjectId: 'arcane_' + '0'.repeat(64) }] },
    { ...value, sourceObjects: [{ ...value.sourceObjects[0], geometrySha256: '0'.repeat(64) }] }]) assert.throws(() => readTreeStructureReview(bad, f.request, f.audit.meshes), refused('RENDER'));
  assert.throws(() => readTreeStructureReview(value, { ...f.request, name: 'another-tree' }, f.audit.meshes), refused('RENDER'));
  assert.throws(() => readTreeStructureReview(value, f.request, f.audit.meshes, '0'.repeat(64)), refused('RENDER'));
});

test('tree structure rejects getter/proxy/hidden/extra tuple data before invoking it', () => {
  const f = treeFixture(), value = f.audit.treeStructure!; let reads = 0;
  const getter = Object.defineProperty({ ...value }, 'views', { enumerable: true, get() { reads++; throw new Error('must not execute'); } });
  const proxy = new Proxy(value, { ownKeys() { reads++; throw new Error('must not execute'); } });
  const hidden = Object.defineProperty({ ...value }, 'hidden', { value: true });
  const views = [...value.views]; Object.defineProperty(views, 'extra', { value: true });
  for (const bad of [getter, proxy, hidden, { ...value, views }]) assert.throws(() => readTreeStructureReview(bad, f.request, f.audit.meshes), refused('RENDER'));
  const accessorAudit = Object.defineProperty({ ...f.audit }, 'treeStructure', { enumerable: true, get() { reads++; throw new Error('must not execute'); } });
  assert.throws(() => validateAudit(accessorAudit, f.request), refused('RENDER')); assert.equal(reads, 0);
});

test('legacy two-view audits remain accepted; structure membership is restricted to natural trees', () => {
  const legacy = treeFixture(false); assert.equal(validateAudit(legacy.audit, legacy.request).renders.length, 2);
  const f = treeFixture(), missing = structuredClone(f.audit); missing.renders.pop();
  assert.throws(() => validateAudit(missing, f.request), refused('RENDER'));
  const unmarked = structuredClone(f.audit); delete unmarked.treeStructure;
  assert.throws(() => validateAudit(unmarked, f.request), refused('RENDER'));
  const wrongSize = structuredClone(f.audit); wrongSize.renders[2]!.width = 256;
  assert.throws(() => validateAudit(wrongSize, f.request), refused('RENDER'));
  const empty = structuredClone(f.audit); empty.renders[2]!.standardDeviation = 0;
  assert.throws(() => validateAudit(empty, f.request), refused('RENDER'));
  for (const request of [normalizeRequest({ template: 'environment-kit', name: 'review-oak' }), normalizeRequest({ template: 'procedural', name: 'review-oak', procedural: { kind: 'tree', finish: 'flat' } }),
    normalizeRequest({ template: 'procedural', name: 'review-oak', procedural: { kind: 'rock', finish: 'natural' } })])
    assert.throws(() => readTreeStructureReview(f.audit.treeStructure, request, f.audit.meshes), refused('RENDER'));
});

test('retained natural trees bind all three actual PNGs and the immutable helper, while old jobs need neither', async t => {
  const current = await retained(t), legacy = await retained(t, false);
  assert.equal((await validateManifestFiles(current.root, current.manifest)).validation.treeStructure!.path, 'preview-structure.png');
  assert.equal((await validateManifestFiles(legacy.root, legacy.manifest)).validation.treeStructure, undefined);
  assert.notEqual(current.manifest.validation.treeStructure!.requestSha256, current.manifest.sourceRequestSha256);
  for (const path of ['preview-structure.png', ...workerScripts(current.manifest.request)]) await assert.rejects(() => validateManifestFiles(current.root, { ...current.manifest, artifacts: current.manifest.artifacts.filter(a => a.path !== path) }), refused('MANIFEST'));
  const wrongRole = structuredClone(current.manifest); wrongRole.artifacts.find(a => a.path === 'preview-structure.png')!.role = 'export';
  await assert.rejects(() => validateManifestFiles(current.root, wrongRole), refused('MANIFEST'));
});

test('actual image/helper/request-byte tampering refuses without changing historical request normalization', async t => {
  const f = await retained(t), image = join(f.root, 'preview-structure.png'), original = await readFile(image);
  await writeFile(image, Buffer.from(original).fill(0, 0, 8)); await assert.rejects(() => validateManifestFiles(f.root, f.manifest), refused('HASH')); await writeFile(image, original);
  const helper = join(f.root, TREE_STRUCTURE_WORKER_SCRIPTS[0]!), helperBytes = await readFile(helper);
  await writeFile(helper, Buffer.from(helperBytes).fill(32)); await assert.rejects(() => validateManifestFiles(f.root, f.manifest), refused('HASH')); await writeFile(helper, helperBytes);
  const changed = structuredClone(f.manifest), request = Buffer.concat([await readFile(join(f.root, 'request.json')), Buffer.from(' ')]);
  await writeFile(join(f.root, 'request.json'), request); const artifact = changed.artifacts.find(a => a.path === 'request.json')!; artifact.sha256 = sha256(request); artifact.bytes = request.length;
  await assert.rejects(() => validateManifestFiles(f.root, changed), refused('MANIFEST'));
});

test('non-tree retained jobs cannot claim a structure PNG or tree helper', async t => {
  const root = await directory(t), manifest = await manifestFixture(root);
  assert.equal((await validateManifestFiles(root, manifest)).validation.renders.length, 2);
  for (const path of ['preview-structure.png', ...TREE_STRUCTURE_WORKER_SCRIPTS]) {
    const bytes = path.endsWith('.png') ? png() : Buffer.from('# not a tree'); await writeFile(join(root, path), bytes);
    const added: Artifact = { path, role: path.endsWith('.png') ? 'preview' : 'worker', bytes: bytes.length, sha256: sha256(bytes) };
    await assert.rejects(() => validateManifestFiles(root, { ...manifest, artifacts: [...manifest.artifacts, added] }), refused('MANIFEST'));
  }
});
