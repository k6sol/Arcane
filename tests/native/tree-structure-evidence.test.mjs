import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { captureFailureAudit, FAILURE_AUDIT_LIMITS } from './tree-structure-evidence.mjs';

const name = 'tree-structure-proof';
const mesh = (role = 'render', source = 'bark') => ({ name: role === 'collision' ? 'COL_' + name : 'SM_' + name + '_' + source,
  role, vertices: 3225, edges: 9669, faces: 6446, triangles: 6446, nonManifoldEdges: 0, looseVertices: 0, looseEdges: 0,
  duplicateVertices: 0, duplicateFaces: 0, degenerateFaces: 0, inconsistentNormals: 0, invertedComponents: 0,
  uvLayers: 1, uvLoops: 19338, invalidUVs: 0, degenerateUVFaces: 0, finitePositions: true,
  dimensions: [4, 5, 9], scale: [1, 1, 1], rotation: [0, 0, 0], materials: role === 'collision' ? [] : ['PRIVATE_MATERIAL_NAME'], errors: [] });
const audit = meshes => ({ meshes, totals: { renderTriangles: 10310, lod1Triangles: 0, collisionTriangles: 12, materials: 2 }, errors: [] });
const capture = value => captureFailureAudit('owned-job', name, async () => Buffer.from(JSON.stringify(value)));

test('actual producer count and UV error forms retain finite source measurements without raw labels', async () => {
  const bark = mesh(), leaves = mesh('render', 'leaves'), proxy = mesh('collision');
  bark.degenerateUVFaces = 1; bark.errors = ['Missing, incomplete or degenerate UVs'];
  bark.uvQuality = { intent: 'tiled', faces: 6446, islands: 7, degenerateTriangles: 1, flippedFaces: 2,
    foldedFaces: 1, foldedFraction: .000155, mirroredFaces: 0, angleDistortion: .613, angleDistortionP95: 2.34,
    stretchedShare: .0606, areaDistortion: .22, stretchL2: 1.2, texelsPerMetre: 512, densityCV: .42,
    islandDensityRatio: 2, seamRatio: .1, smoothSeamRatio: .2, visibleSeamShare: .3, borderPx: .5,
    textureSize: 512, texelAspect: .9, overlapFaces: 12, overlapTexels: 50, utilization: .4, islandGapPx: null,
    errors: ['UV angleDistortionP95 2.34 above (1.5)'], warnings: ['UV stretchedShare 0.0606 above (0.05)'] };
  leaves.errors = ['nonManifoldEdges: 3', 'Invalid material node link', 'Library material PRIVATE_LIBRARY_MESSAGE'];
  const input = audit([bark, leaves, proxy]);
  input.errors = [bark.name + ': Missing, incomplete or degenerate UVs', leaves.name + ': nonManifoldEdges: 3', 'Render triangle budget failed'];
  input.request = 'PRIVATE_REQUEST_TEXT'; input.path = 'PRIVATE_SOURCE_PATH'; input.exception = 'PRIVATE_EXCEPTION';
  const result = await capture(input);
  assert.equal(result.state, 'available'); assert.equal(result.meshCount, 3);
  assert.deepEqual(result.meshes.map(row => [row.role, row.sourceKind]), [['render', 'bark'], ['render', 'leaves'], ['collision', 'proxy']]);
  assert.equal(result.meshes[0].measurements.values.degenerateUVFaces, 1);
  assert.equal(result.meshes[0].uvQuality.measurements.values.angleDistortionP95, 2.34);
  assert.equal(result.meshes[0].uvQuality.measurements.values.islandGapPx, null);
  assert.deepEqual(result.meshes[0].uvQuality.errors.classifications, [{ code: 'uv-limit', metric: 'angleDistortionP95', relation: 'above', observed: 2.34, limit: 1.5 }]);
  assert.deepEqual(result.meshes[1].errors.classifications, [{ code: 'mesh-count', metric: 'nonManifoldEdges', observed: 3 }, { code: 'material-link' }, { code: 'library-material' }]);
  assert.deepEqual(result.errors.classifications, [{ meshOrdinal: 0, code: 'uv-layout' }, { meshOrdinal: 1, code: 'mesh-count', metric: 'nonManifoldEdges', observed: 3 }, { code: 'render-triangle-budget' }]);
  assert.equal(result.meshes[0].materialCount, 1); assert.equal(result.meshes[2].uvQuality.state, 'absent');
  const serialized = JSON.stringify(result);
  for (const text of ['PRIVATE_', bark.name, leaves.name, proxy.name, 'Missing, incomplete', 'Invalid material']) assert.ok(!serialized.includes(text));
});

test('unrecognised names, roles, errors and nonfinite data remain bounded explicit unknowns', async () => {
  const row = mesh(); row.name = 'PRIVATE_ARBITRARY_NAME'; row.role = 'PRIVATE_ROLE'; row.vertices = -1;
  row.errors = ['PRIVATE_UNKNOWN_ERROR', 'UV PRIVATE_METRIC 1 above (0)', 'degenerateFaces: 9007199254740992'];
  row.uvQuality = { intent: 'PRIVATE_INTENT', faces: 1, errors: [], warnings: [] };
  const raw = JSON.stringify(audit([row])).replace('"faces":1,"errors":[]', '"faces":1,"angleDistortion":1e400,"errors":[]');
  const result = await captureFailureAudit('owned-job', name, async () => Buffer.from(raw));
  assert.equal(result.state, 'available'); assert.equal(result.meshes[0].role, 'unknown'); assert.equal(result.meshes[0].sourceKind, 'unclassified');
  assert.ok(result.meshes[0].measurements.invalid.includes('vertices')); assert.ok(!Object.hasOwn(result.meshes[0].measurements.values, 'vertices'));
  assert.equal(result.meshes[0].uvQuality.intent, 'unknown'); assert.ok(result.meshes[0].uvQuality.measurements.invalid.includes('angleDistortion'));
  assert.deepEqual(result.meshes[0].errors.classifications, [{ code: 'unclassified' }, { code: 'unclassified' }, { code: 'unclassified' }]);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_')); assert.ok(!JSON.stringify(result).includes('Infinity'));
});

test('mesh and error caps retain original counts and explicit truncation without source text', async () => {
  const row = mesh(); row.errors = Array(FAILURE_AUDIT_LIMITS.errors + 1).fill('PRIVATE_UNKNOWN');
  row.errors[0] = 'PRIVATE_' + 'x'.repeat(1024);
  const input = audit(Array.from({ length: FAILURE_AUDIT_LIMITS.meshes + 1 }, () => row));
  input.errors = Array(FAILURE_AUDIT_LIMITS.errors + 1).fill('PRIVATE_GLOBAL');
  const result = await capture(input);
  assert.equal(result.meshCount, FAILURE_AUDIT_LIMITS.meshes + 1); assert.equal(result.meshesTruncated, true);
  assert.equal(result.meshes.length, FAILURE_AUDIT_LIMITS.meshes);
  for (const list of [result.errors, result.meshes[0].errors]) {
    assert.equal(list.count, FAILURE_AUDIT_LIMITS.errors + 1); assert.equal(list.truncated, true);
    assert.equal(list.classifications.length, FAILURE_AUDIT_LIMITS.errors);
    assert.ok(list.classifications.every(row => row.code === 'unclassified'));
  }
  assert.ok(!JSON.stringify(result).includes('PRIVATE_'));
});

test('read failure, invalid bytes and malformed audit retain finite unavailable states', async () => {
  const calls = [];
  const missing = await captureFailureAudit('owned-job', name, async (...args) => { calls.push(args); throw Error('PRIVATE_SOURCE_PATH'); });
  assert.deepEqual(calls, [[join('owned-job', 'audit.json'), FAILURE_AUDIT_LIMITS.bytes]]);
  assert.deepEqual(missing, { schemaVersion: 1, state: 'unavailable', reason: 'read-failed' });
  for (const bytes of [Buffer.from('{'), Buffer.from([0xff])])
    assert.deepEqual(await captureFailureAudit('owned-job', name, async () => bytes), { schemaVersion: 1, state: 'invalid', reason: 'json-invalid' });
  assert.deepEqual(await captureFailureAudit('owned-job', name, async () => Buffer.alloc(FAILURE_AUDIT_LIMITS.bytes + 1)), { schemaVersion: 1, state: 'invalid', reason: 'byte-bound' });
  for (const value of [null, [], { meshes: [], errors: [], totals: null }])
    assert.deepEqual(await capture(value), { schemaVersion: 1, state: 'invalid', reason: 'audit-shape' });
});
