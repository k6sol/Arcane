import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { matrixFromTrs, quaternionFromAxisAngle } from '../../packages/core/src/spatial-math.js';
import { AssetError } from '../../packages/asset-pipeline/src/types.js';
import { CONVERSION_PRECISION, compareConversionPrimitive, conversionCorrespondenceSha256, compareConversionTransforms,
  compareConversionDirection, checkConversionMatrix, type ConversionPrimitiveSamples } from '../../packages/asset-pipeline/src/conversion-fidelity-policy.js';

// Pure numerical/correspondence cases, not Blender or customer acceptance.
type Mutable = { attributes: Record<string, number[][]>; triangles: number[][]; world: number[]; vertexIds: number[] };
const refusal = (error: unknown) => error instanceof AssetError && error.code === 'ASSET_CONVERSION_FIDELITY';
function fixture(world = matrixFromTrs()): { source: ConversionPrimitiveSamples; output: Mutable } {
  const attributes = { POSITION: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], NORMAL: Array.from({ length: 4 }, () => [0, 0, 1]),
    TANGENT: Array.from({ length: 4 }, () => [1, 0, 0, 1]), TEXCOORD_0: [[0, 0], [1, 0], [1, 1], [0, 1]], COLOR_0: Array.from({ length: 4 }, () => [0.5, 0.25, 0.125, 1]) };
  const source = { attributes, triangles: [[0, 1, 2], [0, 2, 3]], world };
  return { source, output: { ...structuredClone(source), vertexIds: [0, 1, 2, 3] } };
}
test('correspondence encoding uses numeric cyclic tuple order and retains face multiplicity', () => {
  const expected = createHash('sha256').update('[[0,10,2],[2,3,10]]').digest('hex');
  assert.equal(conversionCorrespondenceSha256([[10, 2, 3], [0, 10, 2]]), expected);
  assert.equal(conversionCorrespondenceSha256([[2, 0, 10], [3, 10, 2]]), expected);
  assert.notEqual(conversionCorrespondenceSha256([[0, 10, 2], [2, 3, 10], [2, 3, 10]]), expected);
  assert.notEqual(conversionCorrespondenceSha256([[0, 2, 10], [2, 3, 10]]), expected);
});
test('actual vertex reordering and duplicated export seam representations preserve exact source correspondence', () => {
  const f = fixture(), order = [3, 2, 1, 0, 0];
  for (const key of Object.keys(f.output.attributes)) f.output.attributes[key] = order.map(id => [...f.source.attributes[key]![id]!]);
  f.output.vertexIds = order; f.output.triangles = [[3, 2, 1], [4, 1, 0]];
  assert.equal(compareConversionPrimitive(f.source, f.output), conversionCorrespondenceSha256(f.source.triangles));
});
test('position comparison accepts values straddling a former hash bucket while retaining the actual samples', () => {
  const f = fixture();
  (f.source.attributes.POSITION![0] as number[])[0] = 0.12345649;
  f.output.attributes.POSITION![0]![0] = 0.12345651;
  const actual = structuredClone(f.output);
  compareConversionPrimitive(f.source, f.output);
  assert.deepEqual(f.output, actual);
  assert.notEqual(f.source.attributes.POSITION![0]![0], f.output.attributes.POSITION![0]![0]);
});
test('the physical position limit accepts bounded representation changes and refuses an excess', () => {
  const f = fixture(); f.output.attributes.POSITION![0]![0] = CONVERSION_PRECISION.positionMeters * 0.99;
  compareConversionPrimitive(f.source, f.output);
  f.output.attributes.POSITION![0]![0] = CONVERSION_PRECISION.positionMeters * 1.01;
  assert.throws(() => compareConversionPrimitive(f.source, f.output), refusal);
});
test('large and tiny world scales cannot conceal local or world vertex displacement', () => {
  for (const [scale, displacement] of [[10000, 0.000001], [0.0001, 0.01]]) {
    const f = fixture(matrixFromTrs(undefined, undefined, [scale!, scale!, scale!]));
    f.output.attributes.POSITION![0]![0] = displacement!;
    assert.throws(() => compareConversionPrimitive(f.source, f.output), refusal);
  }
});
test('full affine instances retain their physical and directional constraints', () => {
  const f = fixture(matrixFromTrs([12, -4, 8], quaternionFromAxisAngle([0, 1, 0], Math.PI / 6), [2, 3, 4]));
  f.output.attributes.POSITION![0]![0]! += 0.000001;
  compareConversionPrimitive(f.source, f.output);
  f.output.world[12]! += 0.01;
  assert.throws(() => compareConversionPrimitive(f.source, f.output), refusal);
});
test('opposite winding, lost faces and duplicate faces are refused', () => {
  for (const change of [
    (f: Mutable) => { f.triangles[0] = [0, 2, 1]; },
    (f: Mutable) => { f.triangles.pop(); },
    (f: Mutable) => { f.triangles.push([0, 1, 2]); },
  ]) { const f = fixture(); change(f.output); assert.throws(() => compareConversionPrimitive(f.source, f.output), refusal); }
});
test('shared accessor storage preserves each material primitive without treating unindexed slots as faces', () => {
  const f = fixture();
  (f.source.triangles as number[][]).splice(1, 1); f.output.triangles.splice(1, 1);
  compareConversionPrimitive(f.source, f.output);
  // A real exporter may compact that same primitive to its three used slots.
  for (const name of Object.keys(f.output.attributes)) f.output.attributes[name]!.pop();
  f.output.vertexIds.pop(); compareConversionPrimitive(f.source, f.output);
  // It may also share a larger accessor; unindexed slots are not rendered faces.
  for (const name of Object.keys(f.output.attributes)) f.output.attributes[name]!.push([...f.source.attributes[name]![3]!]);
  f.output.vertexIds.push(3); f.output.attributes.TEXCOORD_0![3]![0] = 0.5;
  compareConversionPrimitive(f.source, f.output);
  f.output.attributes.TEXCOORD_0![0]![0] = 0.5;
  assert.throws(() => compareConversionPrimitive(f.source, f.output), refusal);
});
test('fractional foreign and nonfinite correspondence cannot borrow nearby source vertices', () => {
  for (const id of [0.5, -1, 4, NaN, Infinity]) {
    const f = fixture(); f.output.vertexIds[0] = id;
    assert.throws(() => compareConversionPrimitive(f.source, f.output), refusal);
  }
});
test('coincident source seam vertices retain distinct UV-to-ID associations', () => {
  const f = fixture();
  for (const name of Object.keys(f.output.attributes)) {
    (f.source.attributes[name] as number[][]).push([...f.source.attributes[name]![0]!]);
    f.output.attributes[name]!.push([...f.output.attributes[name]![0]!]);
  }
  (f.source.attributes.TEXCOORD_0![4] as number[])[0] = 0.5; f.output.attributes.TEXCOORD_0![4]![0] = 0.5;
  (f.source.triangles as number[][])[1] = [4, 2, 3]; f.output.triangles[1] = [4, 2, 3]; f.output.vertexIds.push(4);
  compareConversionPrimitive(f.source, f.output);
  [f.output.attributes.TEXCOORD_0![0], f.output.attributes.TEXCOORD_0![4]] = [f.output.attributes.TEXCOORD_0![4]!, f.output.attributes.TEXCOORD_0![0]!];
  assert.throws(() => compareConversionPrimitive(f.source, f.output), refusal);
});
test('angular direction budgets do not accept a changed tangent handedness', () => {
  const angle = CONVERSION_PRECISION.directionRadians;
  compareConversionDirection([0, 0, 1], [Math.sin(angle * 0.99), 0, Math.cos(angle * 0.99)]);
  assert.throws(() => compareConversionDirection([0, 0, 1], [Math.sin(angle * 1.01), 0, Math.cos(angle * 1.01)]), refusal);
  for (const name of ['NORMAL', 'TANGENT']) {
    const f = fixture(); f.output.attributes[name]![0]![1] = 0.01;
    assert.throws(() => compareConversionPrimitive(f.source, f.output), refusal);
  }
  const f = fixture(); f.output.attributes.TANGENT![0]![3] = -1;
  assert.throws(() => compareConversionPrimitive(f.source, f.output), refusal);
});
test('every source UV and color layer remains constrained including alpha', () => {
  for (const [name, component, limit] of [['TEXCOORD_7', 1, CONVERSION_PRECISION.uv], ['COLOR_7', 3, CONVERSION_PRECISION.color]] as const) {
    const f = fixture(), values = name.startsWith('TEXCOORD') ? [[0, 0], [1, 0], [1, 1], [0, 1]] : Array.from({ length: 4 }, () => [0.2, 0.3, 0.4, 0.5]);
    (f.source.attributes as Record<string, number[][]>)[name] = structuredClone(values); f.output.attributes[name] = structuredClone(values);
    f.output.attributes[name]![0]![component]! += limit * 0.99; compareConversionPrimitive(f.source, f.output);
    f.output.attributes[name]![0]![component]! += limit * 0.02; assert.throws(() => compareConversionPrimitive(f.source, f.output), refusal);
  }
});
test('missing source semantics and nonfinite samples remain explicit refusals', () => {
  const missing = fixture(); delete missing.output.attributes.NORMAL;
  assert.throws(() => compareConversionPrimitive(missing.source, missing.output), refusal);
  const nonfinite = fixture(); nonfinite.output.attributes.TEXCOORD_0![1]![0] = NaN;
  assert.throws(() => compareConversionPrimitive(nonfinite.source, nonfinite.output), refusal);
});
test('local hierarchy precision preserves handedness and refuses unsupported conditioning', () => {
  const reference = matrixFromTrs(), allowed = [...reference]; allowed[12] = CONVERSION_PRECISION.localTranslationMeters * 0.99;
  allowed[0]! += CONVERSION_PRECISION.linearRelative * 0.99; compareConversionTransforms(reference, allowed);
  const moved = [...reference]; moved[12] = CONVERSION_PRECISION.localTranslationMeters * 1.01;
  assert.throws(() => compareConversionTransforms(reference, moved), refusal);
  assert.throws(() => compareConversionTransforms(reference, matrixFromTrs(undefined, undefined, [-1, 1, 1])), refusal);
  assert.throws(() => checkConversionMatrix(matrixFromTrs(undefined, undefined, [1, 0.00001, 1])), refusal);
  checkConversionMatrix(matrixFromTrs(undefined, undefined, [0.0001, 0.0001, 0.0001]));
});
