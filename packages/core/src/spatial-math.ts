/** Pure spatial calculations. No engine, transport, filesystem or authority decisions.
 * Matrices are affine, column-major, acting on column vectors: world = parent * local.
 * CFrame components and row-major socket evidence require the explicit adapters below.
 * Callers retain their own coordinate, scale and import budgets. Inputs must be data arrays.
 */
export type SpatialVector3 = readonly [number, number, number];
export type SpatialQuaternion = readonly [number, number, number, number]; // x, y, z, w
export interface SpatialBounds { readonly min: SpatialVector3; readonly max: SpatialVector3 }
export class SpatialMathError extends RangeError {
  constructor(public readonly code: 'NON_FINITE' | 'DEGENERATE' | 'NON_AFFINE' | 'NON_RIGID', message: string) {
    super(message); this.name = 'SpatialMathError';
  }
}
function fail(code: SpatialMathError['code'], message: string): never { throw new SpatialMathError(code, message); }
function finite(values: readonly number[], size: number): void {
  if (values.length !== size || Array.from({ length: size }, (_, i) => values[i]).some(n => typeof n !== 'number' || !Number.isFinite(n)))
    fail('NON_FINITE', 'Expected ' + size + ' finite components.');
}
function result(values: number[]): number[] { finite(values, values.length); return values; }
function vector(values: number[]): SpatialVector3 { return result(values) as unknown as SpatialVector3; }
export function dot3(a: SpatialVector3, b: SpatialVector3): number {
  finite(a, 3); finite(b, 3); const value = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (!Number.isFinite(value)) fail('NON_FINITE', 'Dot product overflow.'); return value;
}
export function cross3(a: SpatialVector3, b: SpatialVector3): SpatialVector3 {
  finite(a, 3); finite(b, 3); return vector([a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]);
}
export function normalize3(value: SpatialVector3): SpatialVector3 {
  finite(value, 3); const length = Math.hypot(...value);
  if (length === 0 || !Number.isFinite(length)) fail('DEGENERATE', 'Cannot normalize a zero or overflowing vector.');
  return vector(value.map(n => n / length));
}
export function identityMatrix4(): number[] { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }
function affine(matrix: readonly number[]): void {
  finite(matrix, 16);
  if (matrix[3] !== 0 || matrix[7] !== 0 || matrix[11] !== 0 || matrix[15] !== 1)
    fail('NON_AFFINE', 'Expected an affine column-major matrix.');
}
/** Composition applies b first, then a. Returns new storage and never mutates inputs. */
export function multiplyMatrix4(a: readonly number[], b: readonly number[]): number[] {
  affine(a); affine(b);
  return result(Array.from({ length: 16 }, (_, i) => [0, 1, 2, 3].reduce((n, k) => n + a[k * 4 + i % 4]! * b[Math.floor(i / 4) * 4 + k]!, 0)));
}
/** glTF TRS order T * R * S. Requires unit quaternion norm within the existing
 * glTF admission tolerance (1e-3); does not normalize or silently repair it.
 * rigidScale3 additionally detects shear when a proper rotation is required. */
export function matrixFromTrs(translation: readonly number[] = [0, 0, 0], rotation: readonly number[] = [0, 0, 0, 1], scale: readonly number[] = [1, 1, 1]): number[] {
  finite(translation, 3); finite(rotation, 4); finite(scale, 3);
  if (Math.abs(Math.hypot(...rotation) - 1) > 0.001) fail('NON_RIGID', 'Expected a unit quaternion.');
  const [x, y, z, w] = rotation as unknown as SpatialQuaternion, s = scale, t = translation;
  return result([(1 - 2 * (y * y + z * z)) * s[0]!, (2 * (x * y + z * w)) * s[0]!, (2 * (x * z - y * w)) * s[0]!, 0,
    (2 * (x * y - z * w)) * s[1]!, (1 - 2 * (x * x + z * z)) * s[1]!, (2 * (y * z + x * w)) * s[1]!, 0,
    (2 * (x * z + y * w)) * s[2]!, (2 * (y * z - x * w)) * s[2]!, (1 - 2 * (x * x + y * y)) * s[2]!, 0, ...t, 1]);
}
export function quaternionFromAxisAngle(axis: SpatialVector3, radians: number): SpatialQuaternion {
  finite([radians], 1); const n = normalize3(axis), s = Math.sin(radians / 2);
  return [...n.map(v => v * s), Math.cos(radians / 2)] as unknown as SpatialQuaternion;
}
/** Explicit row/column layout conversion; applies equally to socket evidence. */
export function matrixFromRowMajor4(matrix: readonly number[]): number[] {
  finite(matrix, 16); const out = Array.from({ length: 16 }, (_, i) => matrix[(i % 4) * 4 + Math.floor(i / 4)]!);
  affine(out); return out;
}
export function matrixToRowMajor4(matrix: readonly number[]): number[] {
  affine(matrix); return Array.from({ length: 16 }, (_, i) => matrix[(i % 4) * 4 + Math.floor(i / 4)]!);
}
/** Positive scale, proper rotation and no shear. Mirroring must be baked by the producer. */
export function rigidScale3(matrix: readonly number[], tolerance = 1e-6): number[] {
  affine(matrix); finite([tolerance], 1); if (tolerance < 0 || tolerance >= 1) fail('NON_RIGID', 'Invalid rigid transform tolerance.');
  const scale = [0, 4, 8].map(at => Math.hypot(...matrix.slice(at, at + 3)));
  if (scale.some(n => !Number.isFinite(n) || n <= 0)) fail('NON_RIGID', 'Singular scale requires baking.');
  // Test normalized columns, so very small or large scales do not erase the
  // determinant sign or turn a shear test into an overflowing dot product.
  const columns = [0, 1, 2].map(i => matrix.slice(4 * i, 4 * i + 3).map(n => n / scale[i]!) as unknown as SpatialVector3);
  const det = dot3(columns[0]!, cross3(columns[1]!, columns[2]!));
  if (det <= 0 || [[0, 1], [0, 2], [1, 2]].some(([a, b]) => Math.abs(dot3(columns[a!]!, columns[b!]!)) > tolerance))
    fail('NON_RIGID', 'Shear, singular or mirrored transform requires baking.');
  return scale;
}
export function matrixFromCFrame(components: readonly number[]): number[] {
  finite(components, 12); const c = components;
  const matrix = [c[3]!, c[6]!, c[9]!, 0, c[4]!, c[7]!, c[10]!, 0, c[5]!, c[8]!, c[11]!, 0, c[0]!, c[1]!, c[2]!, 1];
  matrixToCFrame(matrix); return matrix;
}
/** CFrame has rotation and translation, so scale/shear/reflection are refused. */
export function matrixToCFrame(matrix: readonly number[]): number[] {
  const scale = rigidScale3(matrix);
  if (scale.some(n => Math.abs(n - 1) > 1e-6)) fail('NON_RIGID', 'CFrame cannot contain scale.');
  const m = matrix; return [m[12]!, m[13]!, m[14]!, m[0]!, m[4]!, m[8]!, m[1]!, m[5]!, m[9]!, m[2]!, m[6]!, m[10]!];
}
/** Point includes translation; vector includes scale and shear, without translation. */
export function transformPoint3(matrix: readonly number[], point: SpatialVector3): SpatialVector3 {
  affine(matrix); finite(point, 3);
  return vector([0, 1, 2].map(i => matrix[i]! * point[0] + matrix[4 + i]! * point[1] + matrix[8 + i]! * point[2] + matrix[12 + i]!));
}
export function transformVector3(matrix: readonly number[], value: SpatialVector3): SpatialVector3 {
  affine(matrix); finite(value, 3);
  return vector([0, 1, 2].map(i => matrix[i]! * value[0] + matrix[4 + i]! * value[1] + matrix[8 + i]! * value[2]));
}
/** Direction uses only the proper rotation, preserving magnitude under nonuniform scale. */
export function transformDirection3(matrix: readonly number[], direction: SpatialVector3): SpatialVector3 {
  const scale = rigidScale3(matrix); finite(direction, 3);
  return vector([0, 1, 2].map(i => matrix[i]! / scale[0]! * direction[0] + matrix[4 + i]! / scale[1]! * direction[1] + matrix[8 + i]! / scale[2]! * direction[2]));
}
/** Inverse of any nonsingular affine transform, including shear and reflection. */
export function inverseAffine4(matrix: readonly number[]): number[] {
  affine(matrix);
  const lengths = [0, 4, 8].map(i => Math.hypot(...matrix.slice(i, i + 3)));
  if (lengths.some(n => n === 0 || !Number.isFinite(n))) fail('DEGENERATE', 'Cannot invert a singular transform.');
  const cols = [0, 1, 2].map(i => matrix.slice(i * 4, i * 4 + 3).map(v => v / lengths[i]!) as unknown as SpatialVector3);
  const rows = [cross3(cols[1]!, cols[2]!), cross3(cols[2]!, cols[0]!), cross3(cols[0]!, cols[1]!)], det = dot3(cols[0]!, rows[0]!);
  if (Math.abs(det) <= 1e-12) fail('DEGENERATE', 'Transform is singular or ill-conditioned.');
  const invRows = rows.map((row, i) => row.map(v => v / det / lengths[i]!));
  const out = [invRows[0]![0]!, invRows[1]![0]!, invRows[2]![0]!, 0, invRows[0]![1]!, invRows[1]![1]!, invRows[2]![1]!, 0,
    invRows[0]![2]!, invRows[1]![2]!, invRows[2]![2]!, 0, ...invRows.map(row => -(row[0]! * matrix[12]! + row[1]! * matrix[13]! + row[2]! * matrix[14]!)), 1];
  return result(out);
}
/** Normal is transformed by inverse transpose, then normalized. */
export function transformNormal3(matrix: readonly number[], normal: SpatialVector3): SpatialVector3 {
  finite(normal, 3); const inv = inverseAffine4(matrix);
  return normalize3(vector([0, 1, 2].map(i => inv[4 * i]! * normal[0] + inv[4 * i + 1]! * normal[1] + inv[4 * i + 2]! * normal[2])));
}
function axisRotation(axis: SpatialVector3, degrees: number): number[] {
  return matrixFromTrs(undefined, quaternionFromAxisAngle(axis, degrees * Math.PI / 180));
}
/** Blender Euler XYZ: Rz(z) * Ry(y) * Rx(x), angles in degrees. */
export function blenderXyzRotation(degrees: SpatialVector3): number[] {
  finite(degrees, 3); return multiplyMatrix4(multiplyMatrix4(axisRotation([0, 0, 1], degrees[2]), axisRotation([0, 1, 0], degrees[1])), axisRotation([1, 0, 0], degrees[0]));
}
/** Studio Orientation/fromOrientation: Ry(y) * Rx(x) * Rz(z), degrees. */
export function studioOrientationRotation(degrees: SpatialVector3): number[] {
  finite(degrees, 3); return multiplyMatrix4(multiplyMatrix4(axisRotation([0, 1, 0], degrees[1]), axisRotation([1, 0, 0], degrees[0])), axisRotation([0, 0, 1], degrees[2]));
}
/** Blender Z-up to glTF/Studio Y-up, a proper rotation: [x,y,z] -> [x,z,-y]. */
export function blenderToYUpBasis(): number[] { return [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1]; }
function unitScale(studsPerMeter: number): void { finite([studsPerMeter], 1); if (studsPerMeter <= 0) fail('DEGENERATE', 'Unit conversion needs a positive scale.'); }
/** Explicit conversion factor; no assumed project or engine scale. Geometry points convert too. */
export function blenderPointToStudio(point: SpatialVector3, studsPerMeter: number): SpatialVector3 {
  unitScale(studsPerMeter); return vector(transformPoint3(blenderToYUpBasis(), point).map(n => n * studsPerMeter));
}
/** Change both local and world basis: B * M * inverse(B), then convert translation units.
 * Do not apply the Blender basis to GLB nodes: the exporter already applied it. */
export function blenderTransformToStudio(matrix: readonly number[], studsPerMeter: number): number[] {
  unitScale(studsPerMeter); const basis = blenderToYUpBasis();
  return gltfTransformToStudio(multiplyMatrix4(multiplyMatrix4(basis, matrix), inverseAffine4(basis)), studsPerMeter);
}
export function gltfTransformToStudio(matrix: readonly number[], studsPerMeter: number): number[] {
  affine(matrix); unitScale(studsPerMeter); const out = [...matrix];
  for (const i of [12, 13, 14]) out[i] = out[i]! * studsPerMeter; return result(out);
}
function boundsValid(bounds: SpatialBounds): void {
  finite(bounds.min, 3); finite(bounds.max, 3);
  if (bounds.min.some((n, i) => n > bounds.max[i]!)) fail('DEGENERATE', 'Bounds min must not exceed max.');
}
export function boundsFromPoints3(points: readonly SpatialVector3[]): SpatialBounds {
  if (!points.length) fail('DEGENERATE', 'Bounds need at least one point.');
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const point of points) { finite(point, 3); for (const i of [0, 1, 2]) { min[i] = Math.min(min[i]!, point[i]!); max[i] = Math.max(max[i]!, point[i]!); } }
  return { min: vector(min), max: vector(max) };
}
/** Exact bounds of the transformed box; conservative for a mesh contained by that box. */
export function transformBounds3(matrix: readonly number[], bounds: SpatialBounds): SpatialBounds {
  affine(matrix); boundsValid(bounds); const points: SpatialVector3[] = [];
  for (const x of [bounds.min[0], bounds.max[0]]) for (const y of [bounds.min[1], bounds.max[1]]) for (const z of [bounds.min[2], bounds.max[2]]) points.push(transformPoint3(matrix, [x, y, z]));
  return boundsFromPoints3(points);
}
/** Root transform that makes a local anchor coincide with a target world anchor. Same units. */
export function alignAnchors4(localAnchor: readonly number[], targetAnchor: readonly number[]): number[] {
  matrixToCFrame(localAnchor); matrixToCFrame(targetAnchor); return multiplyMatrix4(targetAnchor, inverseAffine4(localAnchor));
}
/** Fits AFTER yaw, using a bottom-centre pivot. Bounds and target are already in target units.
 * Returned bounds describe a conservative box, not a measured engine mesh. */
export function planBoxPlacement(bounds: SpatialBounds, target: SpatialVector3, yawDegrees: number, maxSize?: SpatialVector3): { transform: number[]; scale: number; bounds: SpatialBounds; size: SpatialVector3 } {
  boundsValid(bounds); finite(target, 3); finite([yawDegrees], 1);
  const bottom: SpatialVector3 = [bounds.min[0] / 2 + bounds.max[0] / 2, bounds.min[1], bounds.min[2] / 2 + bounds.max[2] / 2];
  const yaw = studioOrientationRotation([0, yawDegrees, 0]), rotated = transformBounds3(yaw, bounds);
  const extents = rotated.max.map((n, i) => n - rotated.min[i]!); let scale = 1;
  if (maxSize) {
    finite(maxSize, 3); if (maxSize.some(n => n <= 0)) fail('DEGENERATE', 'maxSize must be positive.');
    const ratios = extents.flatMap((n, i) => n > 0 ? [maxSize[i]! / n] : []);
    if (!ratios.length) fail('DEGENERATE', 'Cannot fit a point-sized box.'); scale = Math.min(...ratios);
    if (!Number.isFinite(scale) || scale <= 0) fail('DEGENERATE', 'Invalid fitted scale.');
  }
  const transform = multiplyMatrix4(multiplyMatrix4(matrixFromTrs(target), yaw), multiplyMatrix4(matrixFromTrs(undefined, undefined, [scale, scale, scale]), matrixFromTrs(bottom.map(n => -n))));
  const placed = transformBounds3(transform, bounds);
  return { transform, scale, bounds: placed, size: vector(placed.max.map((n, i) => n - placed.min[i]!)) };
}
/** Forward ray interval against a closed AABB. Direction need not be normalized;
 * t is a parameter, and is distance only when direction has unit length. */
export function rayBoundsInterval(origin: SpatialVector3, direction: SpatialVector3, bounds: SpatialBounds): { enter: number; exit: number } | null {
  finite(origin, 3); finite(direction, 3); boundsValid(bounds);
  if (direction.every(n => n === 0)) fail('DEGENERATE', 'Ray direction cannot be zero.');
  let enter = 0, exit = Infinity;
  for (const i of [0, 1, 2]) {
    if (direction[i] === 0) { if (origin[i]! < bounds.min[i]! || origin[i]! > bounds.max[i]!) return null; continue; }
    const a = (bounds.min[i]! - origin[i]!) / direction[i]!, b = (bounds.max[i]! - origin[i]!) / direction[i]!;
    enter = Math.max(enter, Math.min(a, b)); exit = Math.min(exit, Math.max(a, b)); if (enter > exit) return null;
  }
  if (!Number.isFinite(enter) || !Number.isFinite(exit)) fail('NON_FINITE', 'Ray interval overflow.');
  return { enter, exit };
}
