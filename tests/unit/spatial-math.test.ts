import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SpatialMathError, identityMatrix4, multiplyMatrix4, matrixFromTrs, matrixFromRowMajor4, matrixToRowMajor4,
  rigidScale3, matrixFromCFrame, matrixToCFrame, transformPoint3, transformVector3, transformDirection3, transformNormal3,
  inverseAffine4, quaternionFromAxisAngle, blenderXyzRotation, studioOrientationRotation, normalize3, dot3, cross3,
  blenderToYUpBasis, blenderPointToStudio, blenderTransformToStudio, gltfTransformToStudio,
  boundsFromPoints3, transformBounds3, alignAnchors4, planBoxPlacement, rayBoundsInterval,
  type SpatialVector3,
} from '../../packages/core/src/spatial-math.js';

function close(actual: readonly number[], expected: readonly number[], epsilon = 1e-10): void {
  assert.equal(actual.length, expected.length);
  for (const [i, value] of actual.entries()) assert.ok(Math.abs(value - expected[i]!) <= epsilon * Math.max(1, Math.abs(expected[i]!)), `${i}: ${value} != ${expected[i]}`);
}
function refuses(callback: () => unknown, code: SpatialMathError['code']): void {
  assert.throws(callback, error => error instanceof SpatialMathError && error.code === code);
}

test('column-major composition applies local before parent and adapters retain translation', () => {
  const local = matrixFromTrs([1, 0, 0]), parent = matrixFromTrs([10, 20, 30], quaternionFromAxisAngle([0, 1, 0], Math.PI / 2));
  const actual = multiplyMatrix4(parent, local);
  close(transformPoint3(actual, [0, 0, 0]), [10, 20, 29]);
  const row = matrixToRowMajor4(actual);
  close(row.slice(0, 4), [0, 0, 1, 10]);
  close(matrixFromRowMajor4(row), actual);
  assert.notDeepEqual(matrixFromRowMajor4(row), row);
  close(transformPoint3(multiplyMatrix4(local, parent), [0, 0, 0]), [11, 20, 30]);
});

test('point, vector, direction and normal have distinct nonuniform scale semantics', () => {
  const matrix = matrixFromTrs([10, -4, 8], quaternionFromAxisAngle([0, 0, 1], Math.PI / 2), [2, 3, 4]);
  close(transformPoint3(matrix, [1, 1, 1]), [7, -2, 12]);
  close(transformVector3(matrix, [1, 1, 1]), [-3, 2, 4]);
  close(transformDirection3(matrix, [1, 1, 1]), [-1, 1, 1]);
  const normal = transformNormal3(matrix, normalize3([1, 1, 0]));
  const tangent = transformVector3(matrix, [1, -1, 0]);
  assert.ok(Math.abs(dot3(normal, tangent)) < 1e-10);
  close([Math.hypot(...normal)], [1]);
});

test('affine inverse handles nonuniform scale, shear and reflection without treating them as a CFrame', () => {
  const matrix = [2, 0, 0, 0, 1, 3, 0, 0, 0.2, -0.4, -4, 0, 50, -20, 12, 1];
  const inv = inverseAffine4(matrix);
  close(multiplyMatrix4(matrix, inv), identityMatrix4());
  close(multiplyMatrix4(inv, matrix), identityMatrix4());
  close(transformPoint3(inv, transformPoint3(matrix, [3, -4, 5])), [3, -4, 5]);
  refuses(() => rigidScale3(matrix), 'NON_RIGID');
  refuses(() => matrixToCFrame(matrix), 'NON_RIGID');
});

test('singular, near-collinear, mirrored, sheared and projective matrices are rejected in the proper operation', () => {
  const singular = matrixFromTrs(undefined, undefined, [1, 0, 1]);
  refuses(() => inverseAffine4(singular), 'DEGENERATE');
  refuses(() => rigidScale3(singular), 'NON_RIGID');
  refuses(() => rigidScale3(matrixFromTrs(undefined, undefined, [-1, 1, 1])), 'NON_RIGID');
  const shear = identityMatrix4(); shear[4] = 0.1;
  refuses(() => rigidScale3(shear), 'NON_RIGID');
  const nearSingular = identityMatrix4(); nearSingular[4] = 1; nearSingular[5] = 1e-14;
  refuses(() => inverseAffine4(nearSingular), 'DEGENERATE');
  const projective = identityMatrix4(); projective[3] = 1;
  refuses(() => transformPoint3(projective, [0, 0, 0]), 'NON_AFFINE');
});

test('CFrame components use position then row-major rotation, never GLB serialization order', () => {
  const components = [4, 5, 6, 0, 0, 1, 0, 1, 0, -1, 0, 0];
  const matrix = matrixFromCFrame(components);
  close(transformPoint3(matrix, [2, 3, 4]), [8, 8, 4]);
  close(matrixToCFrame(matrix), components);
  close(rigidScale3(matrix), [1, 1, 1]);
  refuses(() => matrixToCFrame(matrixFromTrs(undefined, undefined, [2, 1, 1])), 'NON_RIGID');
});

test('Euler order is explicit: Blender XYZ differs from Studio Orientation YXZ at compound angles', () => {
  const v: SpatialVector3 = [2, -3, 5], degrees: SpatialVector3 = [31, -47, 68];
  const [x, y, z] = degrees.map(n => n * Math.PI / 180);
  const a = v[1] * Math.cos(x!) - v[2] * Math.sin(x!), b = v[1] * Math.sin(x!) + v[2] * Math.cos(x!);
  const c = v[0] * Math.cos(y!) + b * Math.sin(y!), d = -v[0] * Math.sin(y!) + b * Math.cos(y!);
  close(transformVector3(blenderXyzRotation(degrees), v), [c * Math.cos(z!) - a * Math.sin(z!), c * Math.sin(z!) + a * Math.cos(z!), d]);
  const sx = Math.sin(x!), cx = Math.cos(x!), sy = Math.sin(y!), cy = Math.cos(y!), sz = Math.sin(z!), cz = Math.cos(z!);
  const r = [cy * cz + sy * sx * sz, -cy * sz + sy * sx * cz, sy * cx, cx * sz, cx * cz, -sx, -sy * cz + cy * sx * sz, sy * sz + cy * sx * cz, cy * cx];
  close(transformVector3(studioOrientationRotation(degrees), v), [0, 1, 2].map(i => r[3 * i]! * v[0] + r[3 * i + 1]! * v[1] + r[3 * i + 2]! * v[2]));
  assert.ok(transformVector3(blenderXyzRotation(degrees), v).some((n, i) => Math.abs(n - transformVector3(studioOrientationRotation(degrees), v)[i]!) > 0.1));
});

test('basis and unit conversion preserve handedness and commute with point transformation', () => {
  const scale = 1 / 0.28, matrix = multiplyMatrix4(matrixFromTrs([2, -3, 4]), blenderXyzRotation([27, -41, 83]));
  close(blenderPointToStudio([1, 2, 3], scale), [scale, 3 * scale, -2 * scale]);
  const basis = blenderToYUpBasis();
  close(cross3(transformVector3(basis, [1, 0, 0]), transformVector3(basis, [0, 1, 0])), transformVector3(basis, [0, 0, 1]));
  const point: SpatialVector3 = [0.3, 0.5, -0.4], converted = blenderTransformToStudio(matrix, scale);
  close(transformPoint3(converted, blenderPointToStudio(point, scale)), blenderPointToStudio(transformPoint3(matrix, point), scale));
  const gltf = gltfTransformToStudio(matrixFromTrs([1, 2, 3]), scale);
  close(gltf.slice(12, 15), [scale, 2 * scale, 3 * scale]);
  close(gltf.slice(0, 12), identityMatrix4().slice(0, 12));
});

test('anchor alignment composes target world with inverse source local', () => {
  const local = multiplyMatrix4(matrixFromTrs([2, 3, -4]), blenderXyzRotation([17, -29, 51]));
  const target = multiplyMatrix4(matrixFromTrs([-10, 8, 20]), studioOrientationRotation([23, 64, -31]));
  const root = alignAnchors4(local, target);
  close(multiplyMatrix4(root, local), target);
  assert.ok(multiplyMatrix4(local, root).some((n, i) => Math.abs(n - target[i]!) > 0.01));
  refuses(() => alignAnchors4(matrixFromTrs(undefined, undefined, [2, 1, 1]), target), 'NON_RIGID');
});

test('proper basis conversion preserves triangle winding; reflection requires winding repair before import', () => {
  const a: SpatialVector3 = [0, 0, 0], b: SpatialVector3 = [1, 0, 0], c: SpatialVector3 = [0, 1, 0];
  const basis = blenderToYUpBasis();
  const ab = transformVector3(basis, b), ac = transformVector3(basis, c);
  close(normalize3(cross3(ab, ac)), transformNormal3(basis, [0, 0, 1]));
  close(transformPoint3(basis, a), a);
  const mirror = matrixFromTrs(undefined, undefined, [-1, 1, 1]);
  close(cross3(transformVector3(mirror, b), transformVector3(mirror, c)), [0, 0, -1]);
  close(transformNormal3(mirror, [0, 0, 1]), [0, 0, 1]);
  refuses(() => rigidScale3(mirror), 'NON_RIGID');
});

test('AABB transform includes all corners under reflection, shear, rotation and translation', () => {
  const bounds = { min: [-2, -1, 3] as const, max: [5, 4, 8] as const };
  const matrix = [1, 0, 0.5, 0, 2, 3, 0, 0, 0, 0, -2, 0, 10, -20, 30, 1];
  const transformed = transformBounds3(matrix, bounds);
  close(transformed.min, [6, -23, 13]); close(transformed.max, [23, -8, 26.5]);
  const point = boundsFromPoints3([[4, 5, 6]]);
  close(point.min, [4, 5, 6]); close(point.max, [4, 5, 6]);
  refuses(() => boundsFromPoints3([]), 'DEGENERATE');
  refuses(() => transformBounds3(matrix, { min: [1, 0, 0], max: [0, 1, 1] }), 'DEGENERATE');
});

test('fitting uses final yaw, keeps the floor and XZ centre at the requested target', () => {
  const bounds = { min: [-5, 0, -1] as const, max: [5, 2, 1] as const };
  const placed = planBoxPlacement(bounds, [20, 3, -7], 90, [10, 10, 2]);
  close([placed.scale], [0.2]); close(placed.size, [0.4, 0.4, 2]);
  close(transformPoint3(placed.transform, [0, 0, 0]), [20, 3, -7]);
  close([placed.bounds.min[1]], [3]);
  close([(placed.bounds.min[0] + placed.bounds.max[0]) / 2, (placed.bounds.min[2] + placed.bounds.max[2]) / 2], [20, -7]);
  const oldFit = Math.min(10 / 10, 10 / 2, 2 / 2);
  assert.equal(oldFit, 1); assert.ok(10 * oldFit > 2, 'pre-yaw fit violates final Z cap');
});

test('offset pivots and arbitrary yaw retain correct bottom centre', () => {
  const bounds = { min: [6, -3, -9] as const, max: [16, 7, -5] as const };
  const placed = planBoxPlacement(bounds, [40, 12, -10], 37, [9, 7, 5]);
  close(transformPoint3(placed.transform, [11, -3, -7]), [40, 12, -10]);
  close([placed.bounds.min[1]], [12]);
  assert.ok(placed.size.every((n, i) => n <= [9, 7, 5][i]! + 1e-10));
  assert.ok(placed.size.some((n, i) => Math.abs(n - [9, 7, 5][i]!) < 1e-10));
  refuses(() => planBoxPlacement({ min: [0, 0, 0], max: [0, 0, 0] }, [0, 0, 0], 0, [1, 1, 1]), 'DEGENERATE');
});

test('ray slab queries cover inside, tangent, parallel, signed zero and behind-origin cases', () => {
  const bounds = { min: [-1, -2, -3] as const, max: [1, 2, 3] as const };
  assert.deepEqual(rayBoundsInterval([0, 0, -5], [0, 0, 2], bounds), { enter: 1, exit: 4 });
  assert.deepEqual(rayBoundsInterval([0, 0, 0], [1, 0, 0], bounds), { enter: 0, exit: 1 });
  assert.deepEqual(rayBoundsInterval([1, 2, -5], [-0, 0, 1], bounds), { enter: 2, exit: 8 });
  assert.equal(rayBoundsInterval([2, 0, -5], [0, 0, 1], bounds), null);
  assert.equal(rayBoundsInterval([0, 0, 5], [0, 0, 1], bounds), null);
  refuses(() => rayBoundsInterval([0, 0, 0], [0, 0, 0], bounds), 'DEGENERATE');
});

test('finite shape checks reject NaN, Infinity, sparse arrays, overflow and invalid factors', () => {
  refuses(() => matrixFromTrs([0, Infinity, 0]), 'NON_FINITE');
  refuses(() => matrixFromTrs([0, 0]), 'NON_FINITE');
  refuses(() => matrixFromTrs(new Array(3) as number[]), 'NON_FINITE');
  refuses(() => normalize3([0, 0, 0]), 'DEGENERATE');
  refuses(() => matrixFromTrs(undefined, [NaN, 0, 0, 1]), 'NON_FINITE');
  refuses(() => matrixFromTrs(undefined, [0, 0, 0, 0]), 'NON_RIGID');
  refuses(() => transformPoint3(matrixFromTrs([Number.MAX_VALUE, 0, 0]), [Number.MAX_VALUE, 0, 0]), 'NON_FINITE');
  refuses(() => blenderPointToStudio([0, 0, 0], 0), 'DEGENERATE');
  refuses(() => blenderPointToStudio([0, 0, 0], Infinity), 'NON_FINITE');
  refuses(() => rigidScale3(identityMatrix4(), NaN), 'NON_FINITE');
});

test('rigidity and inverse checks retain scale information across very different magnitudes', () => {
  const matrix = matrixFromTrs(undefined, undefined, [1e-200, 1e-200, 1e100]);
  close(rigidScale3(matrix), [1e-200, 1e-200, 1e100]);
  close(multiplyMatrix4(matrix, inverseAffine4(matrix)), identityMatrix4());
  const shear = [...matrix]; shear[4] = 1e-200;
  refuses(() => rigidScale3(shear), 'NON_RIGID');
});

test('deterministic compound transform properties and fit caps hold for 500 cases', () => {
  let seed = 0x2468abcd;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
  for (let i = 0; i < 500; i++) {
    const v = (): SpatialVector3 => [random() * 20 - 10, random() * 20 - 10, random() * 20 - 10];
    const matrix = matrixFromTrs(v(), quaternionFromAxisAngle(normalize3(v()), random() * 6), [0.1 + random() * 10, 0.1 + random() * 10, 0.1 + random() * 10]);
    const p = v(); close(transformPoint3(inverseAffine4(matrix), transformPoint3(matrix, p)), p, 1e-9);
    close(multiplyMatrix4(matrix, inverseAffine4(matrix)), identityMatrix4(), 1e-9);
    const rotation = studioOrientationRotation(v()); close(matrixFromCFrame(matrixToCFrame(rotation)), rotation, 1e-9);
    const maxSize: SpatialVector3 = [0.1 + random() * 10, 0.1 + random() * 10, 0.1 + random() * 10];
    const target = v(), placement = planBoxPlacement({ min: [-2, -3, -1], max: [4, 5, 7] }, target, random() * 720 - 360, maxSize);
    close(transformPoint3(placement.transform, [1, -3, 3]), target, 1e-9);
    assert.ok(placement.size.every((n, axis) => n <= maxSize[axis]! + 1e-9));
  }
});
