import { createHash } from 'node:crypto';
import { inverseAffine4, transformPoint3, transformNormal3, transformVector3, normalize3, type SpatialVector3 } from '../../core/src/spatial-math.js';
import { AssetError } from './types.js';

/** Fixed product precision contract, not a claim of bit-identical conversion.
 * Callers cannot supply larger tolerances. Original and measured hashes remain
 * separate exact observations; correspondence and these checks prove fidelity. */
export const CONVERSION_FIDELITY_POLICY = 'arcane-static-fidelity-v1';
export const CONVERSION_VERTEX_ID = '_ARCANE_SOURCE_VERTEX_ID';
export const CONVERSION_NODE_KEY = 'arcane_conversion_node_v2';
export const CONVERSION_PRECISION = Object.freeze({
  positionMeters: 0.0001, localTranslationMeters: 0.00001,
  directionRadians: 0.02 * Math.PI / 180, uv: 2 ** -20,
  color: 1 / 65535, linearRelative: 2 ** -20, condition: 10000,
});
function refused(message: string): never { throw new AssetError('ASSET_CONVERSION_FIDELITY', message); }
export function conversionDistance(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || !a.length || [...a, ...b].some(n => !Number.isFinite(n))) refused('Conversion components must be finite and correspond exactly.');
  return Math.hypot(...a.map((n, i) => n - b[i]!));
}
function determinant(m: readonly number[]): number {
  return m[0]! * (m[5]! * m[10]! - m[6]! * m[9]!) - m[4]! * (m[1]! * m[10]! - m[2]! * m[9]!) + m[8]! * (m[1]! * m[6]! - m[2]! * m[5]!);
}
export function checkConversionMatrix(matrix: readonly number[]): void {
  if (matrix.length !== 16 || matrix.some(n => !Number.isFinite(n)) || matrix[3] !== 0 || matrix[7] !== 0 || matrix[11] !== 0 || matrix[15] !== 1) refused('Conversion requires a finite affine transform.');
  let inverse: number[];
  try { inverse = inverseAffine4(matrix); } catch { refused('Conversion transform is singular.'); }
  const norm = (m: readonly number[]) => Math.max(...[0, 1, 2].map(row => Math.abs(m[row]!) + Math.abs(m[row + 4]!) + Math.abs(m[row + 8]!)));
  if (!Number.isFinite(norm(matrix) * norm(inverse!)) || norm(matrix) * norm(inverse!) > CONVERSION_PRECISION.condition) refused('Conversion transform exceeds the supported conditioning limit.');
}
export function compareConversionTransforms(expected: readonly number[], actual: readonly number[]): void {
  checkConversionMatrix(expected); checkConversionMatrix(actual);
  if (Math.sign(determinant(expected)) !== Math.sign(determinant(actual))) refused('Conversion changed transform handedness.');
  if (conversionDistance(expected.slice(12, 15), actual.slice(12, 15)) > CONVERSION_PRECISION.localTranslationMeters) refused('Conversion changed a local translation beyond its fixed precision budget.');
  for (let col = 0; col < 3; col++) {
    const a = expected.slice(col * 4, col * 4 + 3), b = actual.slice(col * 4, col * 4 + 3);
    if (conversionDistance(a, b) > Math.hypot(...a) * CONVERSION_PRECISION.linearRelative) refused('Conversion changed a local linear transform beyond its fixed precision budget.');
  }
}
export function compareConversionPosition(expected: readonly number[], actual: readonly number[]): void {
  if (expected.length !== 3 || conversionDistance(expected, actual) > CONVERSION_PRECISION.positionMeters) refused('Conversion changed a vertex beyond its fixed physical precision budget.');
}
export function compareConversionDirection(expected: readonly number[], actual: readonly number[]): void {
  if (expected.length !== 3 || actual.length !== 3 || [...expected, ...actual].some(n => !Number.isFinite(n))) refused('Conversion direction must have three finite components.');
  const aLength = Math.hypot(...expected), bLength = Math.hypot(...actual);
  if (!aLength || !bLength) refused('Conversion direction cannot be normalized.');
  const a = expected.map(n => n / aLength), b = actual.map(n => n / bLength);
  const cross = [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
  const angle = Math.atan2(Math.hypot(...cross), a.reduce((sum, n, i) => sum + n * b[i]!, 0));
  if (!Number.isFinite(angle) || angle > CONVERSION_PRECISION.directionRadians) refused('Conversion changed a surface direction beyond its fixed angular precision budget.');
}
export function compareConversionComponents(expected: readonly number[], actual: readonly number[], kind: 'uv' | 'color'): void {
  if (expected.length !== actual.length || [...expected, ...actual].some(n => !Number.isFinite(n)) || expected.some((n, i) => Math.abs(n - actual[i]!) > CONVERSION_PRECISION[kind])) refused('Conversion changed a ' + kind + ' component beyond its fixed precision budget.');
}

/** Numeric tuple order is shared with Python, rather than JSON string order. */
export function conversionCorrespondenceSha256(faces: readonly (readonly number[])[]): string {
  if (!faces.length || faces.length > 20000) refused('Conversion correspondence exceeds its triangle budget.');
  const order = (a: readonly number[], b: readonly number[]) => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;
  const rows = faces.map(face => {
    if (face.length !== 3 || face.some(id => !Number.isInteger(id) || id < 0 || id >= 60000)) refused('Conversion correspondence requires exact bounded integer vertex IDs.');
    return [[...face], [face[1]!, face[2]!, face[0]!], [face[2]!, face[0]!, face[1]!]].sort(order)[0]!;
  }).sort(order);
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}
export interface ConversionPrimitiveSamples {
  readonly attributes: Readonly<Record<string, readonly (readonly number[])[]>>;
  readonly triangles: readonly (readonly number[])[];
  readonly world: readonly number[];
  readonly vertexIds?: readonly number[];
}
/** Exact oriented topology, then all source-present components at their own
 * immutable vertex IDs. Export seam splits may repeat an ID; none can invent a
 * face or reassign a normal/UV to another source vertex. No nearest-point match. */
export function compareConversionPrimitive(expected: ConversionPrimitiveSamples, actual: ConversionPrimitiveSamples): string {
  const source = expected.attributes, target = actual.attributes, count = source.POSITION?.length ?? 0;
  if (count < 3 || count > 60000 || !target.POSITION || !actual.vertexIds || actual.vertexIds.length !== target.POSITION.length || actual.vertexIds.length > 60000)
    refused('Conversion has incomplete vertex correspondence.');
  const ids = actual.vertexIds!, names = Object.keys(source);
  if (names.some(name => !/^(POSITION|NORMAL|TANGENT|TEXCOORD_[0-7]|COLOR_[0-7])$/.test(name)) || names.some(name => !target[name]) ||
      Object.keys(target).some(name => !names.includes(name) && name !== 'NORMAL' && name !== 'TANGENT')) refused('Conversion lost or substituted a source attribute.');
  for (const name of names) {
    const width = name === 'POSITION' || name === 'NORMAL' ? [3] : name === 'TANGENT' ? [4] : name.startsWith('TEXCOORD_') ? [2] : [3, 4];
    if (source[name]!.length !== count || target[name]!.length !== ids.length ||
        [...source[name]!, ...target[name]!].some(row => !width.includes(row.length) || row.some(n => !Number.isFinite(n)))) refused('Conversion attribute shape or finite component count differs.');
  }
  if (ids.some(id => !Number.isInteger(id) || id < 0 || id >= count)) refused('Conversion contains missing, foreign or fractional vertex correspondence.');
  const usedSource = new Set(expected.triangles.flat()), usedTarget = new Set(actual.triangles.flat());
  // A primitive may index a subset of an accessor shared with another material.
  // Stored but unindexed slots are not faces. Every actual slot is still checked
  // against its source ID below; the exact face multiset proves drawn coverage.
  if (usedSource.size < 3 || [...usedSource].some(id => !Number.isInteger(id) || id < 0 || id >= count) ||
      [...usedTarget].some(id => !Number.isInteger(id) || id < 0 || id >= ids.length)) refused('Conversion face indices are outside their source or exported accessor.');
  const correspondence = conversionCorrespondenceSha256(expected.triangles);
  if (conversionCorrespondenceSha256(actual.triangles.map(face => face.map(vertex => ids[vertex]!))) !== correspondence) refused('Conversion changed oriented source-face correspondence or multiplicity.');
  checkConversionMatrix(expected.world); checkConversionMatrix(actual.world);
  const inverseSource = inverseAffine4(expected.world), expectedSign = Math.sign(determinant(expected.world)), actualSign = Math.sign(determinant(actual.world));
  if (expectedSign !== actualSign) refused('Conversion changed world-transform handedness.');
  const vector = (row: readonly number[]) => row.slice(0, 3) as unknown as SpatialVector3;
  for (let index = 0; index < ids.length; index++) {
    const id = ids[index]!, a = source.POSITION![id]!, b = target.POSITION[index]!;
    const sourceWorld = transformPoint3(expected.world, vector(a)), actualWorld = transformPoint3(actual.world, vector(b));
    compareConversionPosition(a, b);
    compareConversionPosition(sourceWorld, actualWorld);
    compareConversionPosition(a, transformPoint3(inverseSource, actualWorld));
    for (const name of names) {
      if (name === 'POSITION') continue;
      const before = source[name]![id]!, after = target[name]![index]!;
      if (name === 'NORMAL' || name === 'TANGENT') {
        const normal = name === 'NORMAL';
        const transform = (matrix: readonly number[], value: readonly number[]) => normal ? transformNormal3(matrix, vector(value)) : normalize3(transformVector3(matrix, vector(value)));
        const beforeWorld = transform(expected.world, before), afterWorld = transform(actual.world, after);
        compareConversionDirection(vector(before), vector(after));
        compareConversionDirection(beforeWorld, afterWorld);
        compareConversionDirection(vector(before), transform(inverseSource, afterWorld));
        if (!normal && ((![-1, 1].includes(before[3]!)) || before[3] !== after[3] || before[3]! * expectedSign !== after[3]! * actualSign)) refused('Conversion changed tangent handedness.');
      } else if (name.startsWith('TEXCOORD_')) compareConversionComponents(before, after, 'uv');
      else compareConversionComponents(before.length === 3 ? [...before, 1] : before, after.length === 3 ? [...after, 1] : after, 'color');
    }
  }
  return correspondence;
}
