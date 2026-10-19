import test from 'node:test';
import assert from 'node:assert/strict';
import { audit, glb } from '../../packages/asset-pipeline/testing/fixture.js';
import { normalizeRequest, validateAudit, validateSurfaceGlb, workerScripts } from '../../packages/asset-pipeline/src/validation.js';
import { proceduralSurfaceMaterials } from '../../packages/asset-pipeline/src/procedural.js';
import type { AssetAudit, MaterialEvidence } from '../../packages/asset-pipeline/src/types.js';

const input = (finish?: unknown) => ({ template: 'procedural', name: 'quality', renderResolution: 128,
  procedural: { kind: 'tree', ...(finish === undefined ? {} : { finish }) } });

test('procedural natural finish is controlled, canonical and preserves legacy requests', () => {
  const legacy = normalizeRequest(input());
  assert.equal(Object.hasOwn(legacy.procedural!, 'finish'), false);
  assert.deepEqual(normalizeRequest(JSON.parse(JSON.stringify(legacy))), legacy);
  assert.deepEqual(workerScripts(legacy), ['asset_worker.py', 'audit.py', 'probe.py', 'procedural.py']);
  for (const finish of ['natural', 'flat']) {
    const normalized = normalizeRequest(input(finish));
    assert.equal(normalized.procedural!.finish, finish);
    assert.deepEqual(normalizeRequest(JSON.parse(JSON.stringify(normalized))), normalized);
  }
  assert.deepEqual(workerScripts(normalizeRequest(input('natural'))), [...workerScripts(legacy), 'textures.py']);
  for (const finish of [null, 1, {}, 'photo', 'https://example.test/bark.png', 'import os']) assert.throws(() => normalizeRequest(input(finish)));
});

test('original procedural surfaces use fixed profiles and resolution with one existing material per part', () => {
  const expected = { tree: ['bark', 'leaf'], rock: ['stone'], column: ['weathered'], foliage: ['leaf'] };
  for (const kind of ['tree', 'rock', 'column', 'foliage'] as const) {
    const request = normalizeRequest({ template: 'procedural', name: 'quality', procedural: { kind, finish: 'natural' } });
    const materials = proceduralSurfaceMaterials(request.procedural!, request.color);
    assert.deepEqual(materials.map(material => material.surface!.profile), expected[kind]);
    assert.ok(materials.every(material => material.surface!.resolution === 256 && material.metallic === 0));
    assert.ok(materials.length <= 2);
  }
});

function measured(): AssetAudit {
  const request = normalizeRequest(input('natural')), base = audit(), render = base.meshes[0]!, collision = base.meshes[1]!;
  const materials = proceduralSurfaceMaterials(request.procedural!, request.color);
  return { ...base, template: 'procedural', meshes: [...materials.map(material => {
    const roles = ['baseColor', 'normal', 'metallicRoughness'] as const, suffix = ['BaseColor', 'Normal', 'MetallicRoughness'];
    const evidence: MaterialEvidence = { name: 'MAT_' + material.id, color: material.color, metallic: material.metallic!, roughness: material.roughness!,
      emission: { color: [1, 1, 1], strength: 0 }, surface: { profile: material.surface!.profile, resolution: 256, generator: 'arcane-tile-v1', texCoord: 0,
        images: roles.map((role, index) => ({ role, name: `T_${material.id}_${suffix[index]}`, width: 256, height: 256, colorSpace: role === 'baseColor' ? 'sRGB' : 'Non-Color', sha256: 'a'.repeat(64) })) } };
    return { ...render, name: 'SM_quality_' + material.id.toLowerCase(), materials: [evidence.name], materialProperties: [evidence] };
  }), { ...collision, name: 'COL_quality' }], totals: { renderTriangles: 8, lod1Triangles: 0, collisionTriangles: 4, materials: 2 },
  exports: [{ path: 'asset.glb', objects: 2, triangles: 8, materials: 2, finitePositions: true }, { path: 'asset.fbx', objects: 2, triangles: 8, materials: 2, finitePositions: true },
    { path: 'collision.glb', objects: 1, triangles: 4, materials: 0, finitePositions: true }] };
}

test('natural procedural audit refuses missing, wrong or incomplete generated material evidence', () => {
  const request = normalizeRequest(input('natural'));
  assert.doesNotThrow(() => validateAudit(measured(), request));
  for (const change of [
    (value: AssetAudit) => { delete value.meshes[0]!.materialProperties; },
    (value: AssetAudit) => { value.meshes[0]!.materialProperties![0]!.surface!.profile = 'stone'; },
    (value: AssetAudit) => { value.meshes[1]!.materialProperties![0]!.surface!.images.pop(); },
    (value: AssetAudit) => { value.meshes[0]!.materialProperties![0]!.surface!.images[0]!.sha256 = 'forged'; },
    (value: AssetAudit) => { value.meshes[0]!.materialProperties![0]!.roughness = .01; },
    (value: AssetAudit) => { value.meshes[0]!.materialProperties![0]!.emission.strength = 1; },
  ]) { const value = measured(); change(value); assert.throws(() => validateAudit(value, request)); }
});

test('procedural natural finish cannot silently export a flat GLB without embedded PBR images', () => {
  assert.throws(() => validateSurfaceGlb(glb(), normalizeRequest(input('natural')), measured()));
  assert.doesNotThrow(() => validateSurfaceGlb(glb(), normalizeRequest(input()), measured()));
});
