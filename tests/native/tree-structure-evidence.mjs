import { join } from 'node:path';

// Test evidence only: closed producer fields, never names, paths, exception text,
// material strings, request text or a replacement artistic/structural verdict.
export const FAILURE_AUDIT_LIMITS = Object.freeze({ bytes: 4 * 1024 * 1024, meshes: 128, errors: 64, errorChars: 512 });
const MESH_COUNTS = ['vertices', 'edges', 'faces', 'triangles', 'nonManifoldEdges', 'looseVertices', 'looseEdges',
  'duplicateVertices', 'duplicateFaces', 'degenerateFaces', 'inconsistentNormals', 'invertedComponents',
  'uvLayers', 'uvLoops', 'invalidUVs', 'degenerateUVFaces'];
const UV_COUNTS = ['faces', 'islands', 'degenerateTriangles', 'flippedFaces', 'foldedFaces', 'mirroredFaces',
  'overlapFaces', 'overlapTexels', 'textureSize'];
const UV_MEASUREMENTS = ['foldedFraction', 'angleDistortion', 'angleDistortionP95', 'stretchedShare', 'areaDistortion',
  'stretchL2', 'texelsPerMetre', 'densityCV', 'islandDensityRatio', 'seamRatio', 'smoothSeamRatio',
  'visibleSeamShare', 'borderPx', 'texelAspect', 'utilization', 'islandGapPx'];
const UV_FIELDS = [...UV_COUNTS, ...UV_MEASUREMENTS];
const MESH_ERROR_COUNTS = ['nonManifoldEdges', 'looseVertices', 'looseEdges', 'duplicateFaces', 'degenerateFaces', 'inconsistentNormals', 'invertedComponents'];
const MESH_ERRORS = new Map([
  ['Nonfinite coordinates or empty dimensions', 'nonfinite-or-empty'], ['Duplicate vertices within 1e-6 meters', 'duplicate-vertices'],
  ['Unapplied scale/rotation', 'unapplied-transform'], ['Invalid object naming', 'object-naming'],
  ['Missing, incomplete or degenerate UVs', 'uv-layout'], ['Material count outside 1..3', 'material-count'],
  ['Missing named node material', 'material-node'], ['Invalid material node link', 'material-link'],
  ['Material surface is disconnected', 'material-surface'], ['Missing PBR shader', 'pbr-shader'],
  ['Invalid PBR Metallic', 'pbr-metallic'], ['Invalid PBR Roughness', 'pbr-roughness'], ['Collision has materials', 'collision-materials'],
]);
const GLOBAL_ERRORS = new Map([
  ['Render triangle budget failed', 'render-triangle-budget'], ['Global material budget failed', 'global-material-budget'],
  ['Collision budget failed', 'collision-triangle-budget'], ['Hero LOD did not reduce triangle count', 'hero-lod-reduction'],
  ['Custom LOD budget/reduction failed', 'custom-lod-budget'],
]);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const unavailable = reason => ({ schemaVersion: 1, state: 'unavailable', reason });
const invalid = reason => ({ schemaVersion: 1, state: 'invalid', reason });

function measurements(value, integers, floats = []) {
  const values = {}, missing = [], invalid = [];
  for (const key of [...integers, ...floats]) {
    if (!Object.hasOwn(value, key)) { missing.push(key); continue; }
    const item = value[key];
    if ((integers.includes(key) ? count(item) : finite(item)) || key === 'islandGapPx' && item === null) values[key] = item;
    else invalid.push(key);
  }
  return { values, missing, invalid };
}

function classifyMeshError(value) {
  if (typeof value !== 'string' || value.length > FAILURE_AUDIT_LIMITS.errorChars) return { code: 'unclassified' };
  const exact = MESH_ERRORS.get(value); if (exact) return { code: exact };
  if (value.startsWith('Library material ')) return { code: 'library-material' };
  const structural = /^([A-Za-z]+): ([0-9]+)$/.exec(value);
  if (structural && MESH_ERROR_COUNTS.includes(structural[1]) && count(Number(structural[2])))
    return { code: 'mesh-count', metric: structural[1], observed: Number(structural[2]) };
  // uv_metrics.assess emits exactly this fixed metric/value/relation/limit form.
  const uv = /^UV ([A-Za-z][A-Za-z0-9]*) (-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:e[+-]?[0-9]+)?) (above|below) \((-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:e[+-]?[0-9]+)?)\)$/.exec(value);
  if (uv && UV_FIELDS.includes(uv[1]) && finite(Number(uv[2])) && finite(Number(uv[4])))
    return { code: 'uv-limit', metric: uv[1], relation: uv[3], observed: Number(uv[2]), limit: Number(uv[4]) };
  return { code: 'unclassified' };
}

function errors(value, classify = classifyMeshError) {
  if (!Array.isArray(value)) return { state: 'invalid', count: null, truncated: false, classifications: [] };
  return { state: 'available', count: value.length, truncated: value.length > FAILURE_AUDIT_LIMITS.errors,
    classifications: value.slice(0, FAILURE_AUDIT_LIMITS.errors).map(classify) };
}

function sourceKind(row, name) {
  if (row.role === 'render' && row.name === 'SM_' + name + '_bark') return 'bark';
  if (row.role === 'render' && row.name === 'SM_' + name + '_leaves') return 'leaves';
  if (row.role === 'collision' && row.name === 'COL_' + name) return 'proxy';
  return 'unclassified';
}

function meshEvidence(row, ordinal, name) {
  if (!object(row)) return { ordinal, state: 'invalid', role: 'unknown', sourceKind: 'unclassified' };
  const vectors = {};
  for (const key of ['dimensions', 'scale', 'rotation'])
    vectors[key] = Array.isArray(row[key]) && row[key].length === 3 && row[key].every(finite) ? [...row[key]] : null;
  let uvQuality = { state: 'absent' };
  if (Object.hasOwn(row, 'uvQuality')) {
    const uv = row.uvQuality;
    uvQuality = object(uv) ? { state: 'available', intent: ['unique', 'periodic', 'tiled', 'atlas'].includes(uv.intent) ? uv.intent : 'unknown',
      measurements: measurements(uv, UV_COUNTS, UV_MEASUREMENTS), errors: errors(uv.errors), warnings: errors(uv.warnings) } : { state: 'invalid' };
  }
  return { ordinal, state: 'available', role: ['render', 'lod1', 'collision'].includes(row.role) ? row.role : 'unknown', sourceKind: sourceKind(row, name),
    measurements: measurements(row, MESH_COUNTS), finitePositions: typeof row.finitePositions === 'boolean' ? row.finitePositions : null,
    ...vectors, materialCount: Array.isArray(row.materials) ? row.materials.length : null, errors: errors(row.errors), uvQuality };
}

/** Only called after the original worker journal proves exit-observed closure.
 * The caller supplies the production bounded regular-file reader. A missing or
 * malformed audit becomes finite evidence; it never replaces the original test failure. */
export async function captureFailureAudit(directory, expectedName, readFile) {
  let bytes;
  try { bytes = await readFile(join(directory, 'audit.json'), FAILURE_AUDIT_LIMITS.bytes); }
  catch { return unavailable('read-failed'); }
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > FAILURE_AUDIT_LIMITS.bytes) return invalid('byte-bound');
  let audit;
  try { audit = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { return invalid('json-invalid'); }
  try {
    if (!object(audit) || !Array.isArray(audit.meshes) || !Array.isArray(audit.errors) || !object(audit.totals)) return invalid('audit-shape');
    const rows = audit.meshes.slice(0, FAILURE_AUDIT_LIMITS.meshes);
    const globalError = value => {
      if (typeof value !== 'string' || value.length > FAILURE_AUDIT_LIMITS.errorChars) return { code: 'unclassified' };
      const exact = GLOBAL_ERRORS.get(value); if (exact) return { code: exact };
      for (const [ordinal, row] of rows.entries()) {
        if (object(row) && typeof row.name === 'string' && row.name.length <= FAILURE_AUDIT_LIMITS.errorChars && value.startsWith(row.name + ': '))
          return { meshOrdinal: ordinal, ...classifyMeshError(value.slice(row.name.length + 2)) };
      }
      return { code: 'unclassified' };
    };
    return { schemaVersion: 1, state: 'available', meshCount: audit.meshes.length, meshesTruncated: audit.meshes.length > FAILURE_AUDIT_LIMITS.meshes,
      totals: measurements(audit.totals, ['renderTriangles', 'lod1Triangles', 'collisionTriangles', 'materials']), errors: errors(audit.errors, globalError),
      meshes: rows.map((row, ordinal) => meshEvidence(row, ordinal, expectedName)) };
  } catch { return invalid('projection-failed'); }
}
