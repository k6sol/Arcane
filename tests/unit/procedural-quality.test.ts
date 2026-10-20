import test from 'node:test';
import assert from 'node:assert/strict';
import { audit, glb } from '../../packages/asset-pipeline/testing/fixture.js';
import { normalizeRequest, validateAudit, validateSurfaceGlb, workerScripts } from '../../packages/asset-pipeline/src/validation.js';
import { proceduralSurfaceMaterials, proceduralSurfacePattern } from '../../packages/asset-pipeline/src/procedural.js';
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
  const expected = { tree: ['bark', 'leaf'], rock: ['stone'], column: ['weathered'], foliage: ['leaf'], log: ['bark'], stump: ['bark'] };
  for (const kind of ['tree', 'rock', 'column', 'foliage', 'log', 'stump'] as const) {
    const request = normalizeRequest({ template: 'procedural', name: 'quality', procedural: { kind, finish: 'natural' } });
    const materials = proceduralSurfaceMaterials(request.procedural!, request.color);
    assert.deepEqual(materials.map(material => material.surface!.profile), expected[kind]);
    // Natural oak (the default species) authors 512 px species bark and leaf-atlas patterns.
    assert.ok(materials.every(material => material.surface!.resolution === (['tree', 'log', 'stump'].includes(kind) ? 512 : 256) && material.metallic === 0));
    assert.ok(materials.length <= 2);
  }
});

function measured(leafDensity = .7, manifestVersion: 1 | 2 = 2, patterned = false): AssetAudit {
  const request = normalizeRequest({ ...input('natural'), procedural: { kind: 'tree', finish: 'natural', leafDensity } }), base = audit(), render = base.meshes[0]!, collision = base.meshes[1]!;
  const materials = proceduralSurfaceMaterials(request.procedural!, request.color, manifestVersion);
  return { ...base, template: 'procedural', meshes: [...materials.map(material => {
    const roles = ['baseColor', 'normal', 'metallicRoughness'] as const, suffix = ['BaseColor', 'Normal', 'MetallicRoughness'];
    const evidence: MaterialEvidence = { name: 'MAT_' + material.id, color: material.color, metallic: material.metallic!, roughness: material.roughness!,
      emission: { color: [1, 1, 1], strength: 0 }, surface: { profile: material.surface!.profile, resolution: patterned ? 512 : 256, generator: 'arcane-tile-v1', texCoord: 0,
        ...(patterned ? { pattern: 'oak-' + material.id.toLowerCase(), alphaMode: material.id === 'Leaves' ? 'MASK' as const : 'OPAQUE' as const } : {}),
        images: roles.map((role, index) => ({ role, name: `T_${material.id}_${suffix[index]}`, width: patterned ? 512 : 256, height: patterned ? 512 : 256, colorSpace: role === 'baseColor' ? 'sRGB' : 'Non-Color', sha256: 'a'.repeat(64) })) } };
    return { ...render, name: 'SM_quality_' + material.id.toLowerCase(), materials: [evidence.name], materialProperties: [evidence] };
  }), { ...collision, name: 'COL_quality' }], totals: { renderTriangles: materials.length * 4, lod1Triangles: 0, collisionTriangles: 4, materials: materials.length },
  exports: [{ path: 'asset.glb', objects: materials.length, triangles: materials.length * 4, materials: materials.length, finitePositions: true }, { path: 'asset.fbx', objects: materials.length, triangles: materials.length * 4, materials: materials.length, finitePositions: true },
    { path: 'collision.glb', objects: 1, triangles: 4, materials: 0, finitePositions: true }] };
}

test('bare natural trees require only bark maps while historical version1 retains its exact leaf material', () => {
  const request = normalizeRequest({ ...input('natural'), procedural: { kind: 'tree', finish: 'natural', leafDensity: 0 } });
  assert.deepEqual(proceduralSurfaceMaterials(request.procedural!, request.color).map(m => m.id), ['Bark']);
  assert.deepEqual(proceduralSurfaceMaterials(request.procedural!, request.color, 1).map(m => m.id), ['Bark', 'Leaves']);
  assert.doesNotThrow(() => validateAudit(measured(0), request));
  assert.doesNotThrow(() => validateAudit(measured(0, 1), request, 1));
  assert.throws(() => validateAudit(measured(0, 1), request), /generator contract/);
  assert.throws(() => validateAudit(measured(0), request, 1), /generator contract/);
  for (const leafDensity of [1e-8, .25, .7, 1]) {
    const positive = normalizeRequest({ ...input('natural'), procedural: { kind: 'tree', finish: 'natural', leafDensity } });
    assert.deepEqual(proceduralSurfaceMaterials(positive.procedural!, positive.color).map(m => m.id), ['Bark', 'Leaves']);
    assert.doesNotThrow(() => validateAudit(measured(leafDensity), positive));
  }
});

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

test('natural oak/birch evidence names its species pattern and cutout leaves; older plain tiles stay valid', () => {
  const request = normalizeRequest(input('natural'));
  assert.equal(request.procedural!.kind === 'tree' && request.procedural!.species, 'oak');
  assert.doesNotThrow(() => validateAudit(measured(.7, 2, true), request));
  assert.doesNotThrow(() => validateAudit(measured(.7, 2, false), request));
  const surface = (value: AssetAudit, index: number) => value.meshes[index]!.materialProperties![0]!.surface!;
  for (const change of [
    (value: AssetAudit) => { surface(value, 1).alphaMode = 'OPAQUE'; },
    (value: AssetAudit) => { surface(value, 0).alphaMode = 'MASK'; },
    (value: AssetAudit) => { surface(value, 1).pattern = 'birch-leaves'; },
    (value: AssetAudit) => { delete surface(value, 1).pattern; },
    (value: AssetAudit) => { surface(value, 0).resolution = 256; },
  ]) { const value = measured(.7, 2, true); change(value); assert.throws(() => validateAudit(value, request), /selected finish/); }
  // A plain 256 tile may not claim a pattern, and other kinds never carry one.
  const plain = measured(.7, 2, false); surface(plain, 1).alphaMode = 'MASK';
  assert.throws(() => validateAudit(plain, request), /selected finish/);
  const rock = normalizeRequest({ template: 'procedural', name: 'quality', renderResolution: 128, procedural: { kind: 'rock', finish: 'natural' } });
  assert.deepEqual(proceduralSurfaceMaterials(rock.procedural!, rock.color).map(m => m.surface), [{ profile: 'stone', resolution: 256 }]);
});

test('natural pine authors 512 px species bark and needle-spray cutout patterns; palm keeps plain tiles', () => {
  for (const [species, size, patterns] of [['pine', 512, ['pine-bark', 'pine-leaves']], ['palm', 256, [undefined, undefined]]] as const) {
    const request = normalizeRequest({ template: 'procedural', name: 'quality', renderResolution: 128, procedural: { kind: 'tree', species, finish: 'natural' } });
    const materials = proceduralSurfaceMaterials(request.procedural!, request.color);
    assert.deepEqual(materials.map(material => material.surface), [{ profile: 'bark', resolution: size }, { profile: 'leaf', resolution: size }]);
    assert.deepEqual(materials.map(material => proceduralSurfacePattern(request.procedural!, material.id)), patterns);
  }
  const flat = normalizeRequest({ template: 'procedural', name: 'quality', renderResolution: 128, procedural: { kind: 'tree', species: 'pine', finish: 'flat' } });
  assert.deepEqual(proceduralSurfaceMaterials(flat.procedural!, flat.color), []);
  assert.equal(proceduralSurfacePattern(flat.procedural!, 'Bark'), undefined);
});

test('natural log/stump evidence is one opaque bark mesh with the species log pattern', () => {
  for (const [kind, species] of [['log', 'oak'], ['stump', 'birch']] as const) {
    const request = normalizeRequest({ template: 'procedural', name: 'quality', renderResolution: 128, procedural: { kind, species, finish: 'natural' } });
    const [material] = proceduralSurfaceMaterials(request.procedural!, request.color);
    assert.deepEqual([material!.id, material!.surface], ['Bark', { profile: 'bark', resolution: 512 }]);
    const value = (pattern: string, alphaMode: 'OPAQUE' | 'MASK' = 'OPAQUE'): AssetAudit => {
      const base = audit(), render = base.meshes[0]!, collision = base.meshes[1]!, roles = ['baseColor', 'normal', 'metallicRoughness'] as const, suffix = ['BaseColor', 'Normal', 'MetallicRoughness'];
      const evidence: MaterialEvidence = { name: 'MAT_Bark', color: material!.color, metallic: 0, roughness: material!.roughness!, emission: { color: [1, 1, 1], strength: 0 },
        surface: { profile: 'bark', resolution: 512, generator: 'arcane-tile-v1', texCoord: 0, pattern, alphaMode,
          images: roles.map((role, index) => ({ role, name: `T_Bark_${suffix[index]}`, width: 512, height: 512, colorSpace: role === 'baseColor' ? 'sRGB' : 'Non-Color', sha256: 'a'.repeat(64) })) } };
      return { ...base, template: 'procedural', meshes: [{ ...render, name: 'SM_quality_bark', materials: ['MAT_Bark'], materialProperties: [evidence] }, { ...collision, name: 'COL_quality' }],
        totals: { renderTriangles: 4, lod1Triangles: 0, collisionTriangles: 4, materials: 1 },
        exports: [{ path: 'asset.glb', objects: 1, triangles: 4, materials: 1, finitePositions: true }, { path: 'asset.fbx', objects: 1, triangles: 4, materials: 1, finitePositions: true },
          { path: 'collision.glb', objects: 1, triangles: 4, materials: 0, finitePositions: true }] };
    };
    assert.doesNotThrow(() => validateAudit(value(species + '-log'), request));
    for (const wrong of [value(species + '-bark'), value(species + '-log', 'MASK'), value((species === 'oak' ? 'birch' : 'oak') + '-log')])
      assert.throws(() => validateAudit(wrong, request), /selected finish/);
  }
});

test('procedural natural finish cannot silently export a flat GLB without embedded PBR images', () => {
  assert.throws(() => validateSurfaceGlb(glb(), normalizeRequest(input('natural')), measured()));
  assert.doesNotThrow(() => validateSurfaceGlb(glb(), normalizeRequest(input()), measured()));
});
