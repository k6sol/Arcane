import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { audit, glb, png } from '../../packages/asset-pipeline/testing/fixture.js';
import { normalizeRequest, sha256, validateManifestFiles, validateSurfaceGlb, workerScripts } from '../../packages/asset-pipeline/src/validation.js';
import type { AssetAudit, SurfaceEvidence } from '../../packages/asset-pipeline/src/types.js';
import { assemblyRecipe, materialEvidence } from '../../apps/mcp/src/assembly-schemas.js';
import { decodeMaterialPng, materialPngPixels } from '../../packages/asset-pipeline/src/material-png.js';

function input(surface: unknown = { profile: 'bark' }): Record<string, unknown> {
  return { template: 'custom-assembly', name: 'surface-study', recipe: { schemaVersion: 1,
    materials: [{ id: 'timber', color: [.2, .1, .04], surface }], parts: [
      { name: 'body', role: 'render', geometry: { kind: 'box' }, dimensions: [1, 1, 1], position: [0, 0, .5], material: 'timber' },
      { name: 'collider', role: 'collision', geometry: { kind: 'box' }, dimensions: [1, 1, 1], position: [0, 0, .5] },
    ] } };
}

test('surface profiles have deterministic defaults and reject paths, image data, unbounded sizes and executable knobs', () => {
  const normalized = normalizeRequest(input());
  assert.deepEqual(normalized.recipe!.materials[0]!.surface, { profile: 'bark', resolution: 256 });
  for (const profile of ['bark', 'stone', 'leaf', 'weathered']) for (const resolution of [128, 256, 512]) {
    assert.deepEqual(normalizeRequest(input({ profile, resolution })).recipe!.materials[0]!.surface, { profile, resolution });
  }
  for (const surface of [null, [], { profile: 'noise' }, { profile: 'bark', resolution: 1024 }, { profile: 'bark', resolution: '256' },
    { profile: 'bark', path: 'C:/source.png' }, { profile: 'bark', url: 'https://example.test/image.png' },
    { profile: 'bark', data: 'base64' }, { profile: 'bark', nodes: [] }, { profile: 'bark', seed: 1 }]) {
    assert.throws(() => normalizeRequest(input(surface)));
  }
  const flat = input(); delete (flat.recipe as { materials: Record<string, unknown>[] }).materials[0]!.surface;
  assert.equal(normalizeRequest(flat).recipe!.materials[0]!.surface, undefined);
});

test('MCP strict recipe schema exposes only bounded authoring and keeps flat material evidence compatible', () => {
  assert.equal(assemblyRecipe.safeParse(input().recipe).success, true);
  assert.equal(assemblyRecipe.safeParse(input({ profile: 'leaf', resolution: 512 }).recipe).success, true);
  assert.equal(assemblyRecipe.safeParse(input({ profile: 'leaf', file: 'leaf.png' }).recipe).success, false);
  const flat = { name: 'MAT_timber', color: [.2, .1, .04], metallic: 0, roughness: .5, emission: { color: [1, 1, 1], strength: 0 } };
  assert.deepEqual(materialEvidence.parse(flat), flat);
  assert.equal(Object.hasOwn(materialEvidence.parse(flat), 'surface'), false);
});

test('texture generator joins the fixed bundled worker digest only for surfaced assemblies', () => {
  const textured = normalizeRequest(input()), flat = structuredClone(textured);
  delete flat.recipe!.materials[0]!.surface;
  assert.deepEqual(workerScripts(flat), ['asset_worker.py', 'audit.py', 'probe.py', 'assembly.py']);
  assert.deepEqual(workerScripts(textured), [...workerScripts(flat), 'textures.py']);
});

function exported(change?: (doc: any) => void): { bytes: Buffer; request: ReturnType<typeof normalizeRequest>; measured: AssetAudit } {
  const request = normalizeRequest(input({ profile: 'bark', resolution: 128 })), measured = audit(), image = png();
  const bytes = glb(), jsonSize = bytes.readUInt32LE(12), doc = JSON.parse(bytes.toString('utf8', 20, 20 + jsonSize).trim());
  const geometry = bytes.subarray(28 + jsonSize), uv = Buffer.alloc(32);
  [0, 0, 1, 0, 0, 1, 1, 1].forEach((value, index) => uv.writeFloatLE(value, index * 4));
  const binary = Buffer.concat([geometry, uv, image, image, image]);
  const padding = Buffer.alloc((4 - binary.length % 4) % 4), bin = Buffer.concat([binary, padding]);
  doc.buffers[0].byteLength = binary.length;
  doc.bufferViews.push({ buffer: 0, byteOffset: geometry.length, byteLength: uv.length });
  doc.accessors.push({ bufferView: 3, componentType: 5126, count: 4, type: 'VEC2' });
  doc.meshes[0].primitives[0].attributes.TEXCOORD_0 = 3;
  doc.meshes[0].primitives[0].material = 0;
  const roles = ['baseColor', 'normal', 'metallicRoughness'] as const, suffixes = ['BaseColor', 'Normal', 'MetallicRoughness'];
  doc.images = roles.map((role, index) => {
    doc.bufferViews.push({ buffer: 0, byteOffset: geometry.length + uv.length + index * image.length, byteLength: image.length });
    return { name: `T_timber_${suffixes[index]}`, mimeType: 'image/png', bufferView: 4 + index };
  });
  doc.samplers = [{ wrapS: 10497, wrapT: 10497, magFilter: 9729, minFilter: 9987 }];
  doc.textures = roles.map((role, index) => ({ source: index, sampler: 0 }));
  doc.materials = [{ name: 'MAT_timber', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicRoughnessTexture: { index: 2 } }, normalTexture: { index: 1 } }];
  const surface: SurfaceEvidence = { profile: 'bark', resolution: 128, generator: 'arcane-tile-v1', texCoord: 0,
    images: roles.map((role, index) => ({ role, name: `T_timber_${suffixes[index]}`, width: 128, height: 128, colorSpace: role === 'baseColor' ? 'sRGB' : 'Non-Color', sha256: sha256(image) })) };
  measured.meshes[0]!.materialProperties = [{ name: 'MAT_timber', color: [.2, .1, .04], metallic: 0, roughness: .5, emission: { color: [1, 1, 1], strength: 0 }, surface }];
  change?.(doc);
  const raw = Buffer.from(JSON.stringify(doc)), json = Buffer.alloc(Math.ceil(raw.length / 4) * 4, 0x20); raw.copy(json);
  const out = Buffer.alloc(28 + json.length + bin.length);
  out.writeUInt32LE(0x46546c67); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8); out.writeUInt32LE(json.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16); json.copy(out, 20); out.writeUInt32LE(bin.length, 20 + json.length);
  out.writeUInt32LE(0x004e4942, 24 + json.length); bin.copy(out, 28 + json.length);
  return { bytes: out, request, measured };
}

test('surface GLB validation checks embedded PNG bytes, UV0 and all three PBR bindings', () => {
  const fixture = exported(); validateSurfaceGlb(fixture.bytes, fixture.request, fixture.measured);
  for (const change of [
    (doc: any) => { doc.images[0].uri = 'external.png'; },
    (doc: any) => { doc.materials[0].normalTexture.texCoord = 1; },
    (doc: any) => { doc.materials[0].normalTexture.scale = .5; },
    (doc: any) => { doc.materials[0].pbrMetallicRoughness.baseColorFactor = [.2, .1, .04, 1]; },
    (doc: any) => { doc.materials[0].pbrMetallicRoughness.metallicFactor = .3; },
    (doc: any) => { doc.samplers[0].wrapS = 33071; },
    (doc: any) => { delete doc.meshes[0].primitives[0].attributes.TEXCOORD_0; },
    (doc: any) => { doc.images[1].name = 'changed'; },
    (doc: any) => { doc.materials[0].pbrMetallicRoughness.metallicRoughnessTexture.extensions = {}; },
  ]) { const bad = exported(change); assert.throws(() => validateSurfaceGlb(bad.bytes, bad.request, bad.measured)); }
  const changed = exported(); changed.measured.meshes[0]!.materialProperties![0]!.surface!.images[0]!.sha256 = '0'.repeat(64);
  assert.throws(() => validateSurfaceGlb(changed.bytes, changed.request, changed.measured));
});

test('surface GLB alpha mode must match the audited surface: opaque tiles stay OPAQUE, cutout atlases MASK at 0.5', () => {
  assert.throws(() => { const bad = exported(doc => { doc.materials[0].alphaMode = 'MASK'; }); validateSurfaceGlb(bad.bytes, bad.request, bad.measured); }, /alphaMode MASK must be OPAQUE/);
  const cutout = (alphaMode?: string, alphaCutoff?: number) => {
    const fixture = exported(doc => { if (alphaMode) doc.materials[0].alphaMode = alphaMode; if (alphaCutoff !== undefined) doc.materials[0].alphaCutoff = alphaCutoff; });
    fixture.measured.meshes[0]!.materialProperties![0]!.surface!.alphaMode = 'MASK';
    return () => validateSurfaceGlb(fixture.bytes, fixture.request, fixture.measured);
  };
  assert.doesNotThrow(cutout('MASK'));
  assert.doesNotThrow(cutout('MASK', .5));
  assert.throws(cutout(), /must be MASK/);
  assert.throws(cutout('BLEND'), /must be MASK/);
  assert.throws(cutout('MASK', .3), /must be MASK/);
});

test('native textured Blender manifest preserves generated surfaces and worker provenance', { skip: !process.env.ARCANE_TEXTURE_NATIVE_REPORT }, async () => {
  const report = JSON.parse(await readFile(process.env.ARCANE_TEXTURE_NATIVE_REPORT!, 'utf8'));
  assert.equal(report.result.state, 'succeeded');
  const manifest = await validateManifestFiles(report.directory, JSON.parse(await readFile(report.manifestPath, 'utf8')));
  assert.ok(manifest.artifacts.some(artifact => artifact.path === 'textures.py' && artifact.role === 'worker'));
  for (const material of manifest.request.recipe!.materials) assert.ok(material.surface);
  const bytes = await readFile(join(report.directory, 'asset.glb'));
  validateSurfaceGlb(bytes, manifest.request, manifest.validation);
  const size = bytes.readUInt32LE(12), doc = JSON.parse(bytes.toString('utf8', 20, 20 + size).trim()), bin = bytes.subarray(28 + size);
  for (const image of doc.images) {
    const view = doc.bufferViews[image.bufferView], decoded = decodeMaterialPng(bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength));
    const pixels = materialPngPixels(decoded), stride = decoded.width * 4;
    assert.deepEqual(pixels.subarray(0, stride), pixels.subarray((decoded.height - 1) * stride), `${image.name}: vertical tile edge`);
    for (let y = 0; y < decoded.height; y++) assert.deepEqual(pixels.subarray(y * stride, y * stride + 4), pixels.subarray((y + 1) * stride - 4, (y + 1) * stride), `${image.name}: horizontal tile edge`);
    assert.ok(new Set(Array.from({ length: decoded.width * decoded.height }, (_, index) => pixels.subarray(index * 4, index * 4 + 3).toString('hex'))).size > 1, `${image.name}: nonuniform generated map`);
  }
  assert.equal(report.events.some((event: { stage: string }) => event.stage === 'texture-authoring'), true);
});
