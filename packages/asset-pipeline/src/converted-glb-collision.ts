import { types, isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { validateGlb } from '../../../apps/desktop/src/glb-preflight.js';
import { matrixFromTrs, multiplyMatrix4, transformPoint3, type SpatialVector3 } from '../../core/src/spatial-math.js';
import { parseConvertedGlbRequest, parseConvertedGlbSourceMap, parseConvertedGlbAudit, convertedGlbObjectId,
  GLB_CONVERSION_IDENTITY, GLB_CONVERSION_LIMITS, type ConvertedGlbRequest, type ConvertedGlbSourceMap, type ConvertedGlbAudit } from './converted-glb.js';
import { AssetError } from './types.js';

type Data = Record<string, unknown>;
function fail(): never { throw new AssetError('ASSET_CONVERSION_COLLISION', 'Retained collision GLB failed independent mapped geometry validation.'); }
function record(value: unknown): Data { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(); return value as Data; }
function list(value: unknown, maximum: number): unknown[] { if (!Array.isArray(value) || value.length > maximum) fail(); return value; }
function index(value: unknown, maximum: number): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value >= maximum) fail(); return value; }
function number(value: unknown): number { if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1000000) fail(); return value; }
function item(values: unknown[], at: unknown): Data { return record(values[index(at, values.length)]); }
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Analysis only. Position keys account for normal-seam index duplication; no
 * vertices/indices are welded, rewritten or returned as replacement geometry. */
export function validateConvertedGlbCollision(input: Buffer, request: ConvertedGlbRequest, sourceMap: ConvertedGlbSourceMap,
  auditValue: ConvertedGlbAudit, requestSha256: string): Readonly<{ triangles: number; measuredPositionVertices: number; volumeMeters3: number }> {
  const r = parseConvertedGlbRequest(request), map = parseConvertedGlbSourceMap(sourceMap, r), audit = parseConvertedGlbAudit(auditValue, r, map, requestSha256);
  if (r.collision !== 'convex-hull' || types.isProxy(input) || !Buffer.isBuffer(input) || types.isSharedArrayBuffer(input.buffer) || input.length > GLB_CONVERSION_LIMITS.exportedBytes) fail();
  const bytes = Buffer.from(input), model = audit.models.find(model => model.path === 'collision.glb');
  if (!model || model.objects.length !== 1 || bytes.length !== model.byteLength || sha(bytes) !== model.sha256) fail();
  try { validateGlb(Uint8Array.from(bytes).buffer); } catch { fail(); }
  const jsonBytes = bytes.readUInt32LE(12), doc = record(JSON.parse(bytes.subarray(20, 20 + jsonBytes).toString('utf8')) as unknown), bin = bytes.subarray(28 + jsonBytes);
  if (record(doc.asset).generator !== model.generator) fail();
  for (const field of ['materials', 'images', 'textures', 'skins', 'animations', 'cameras']) if (doc[field] !== undefined && list(doc[field], 4096).length) fail();
  const nodes = list(doc.nodes, 4096), meshes = list(doc.meshes, 128), scenes = list(doc.scenes, 4096), accessors = list(doc.accessors, 16384), views = list(doc.bufferViews, 16384);
  if (meshes.length !== 1) fail();
  const scene = item(scenes, doc.scene ?? 0), identity = [...matrixFromTrs()];
  const pending = list(scene.nodes ?? [], 4096).map(at => ({ at, parent: identity })), worlds = new Map<number, number[]>();
  while (pending.length) {
    const { at, parent } = pending.pop()!, atIndex = index(at, nodes.length), node = item(nodes, atIndex);
    if (worlds.has(atIndex) || node.skin !== undefined || node.weights !== undefined || node.camera !== undefined || node.extensions !== undefined) fail();
    let local: number[];
    try {
      local = node.matrix === undefined ? [...matrixFromTrs(node.translation as SpatialVector3 | undefined, node.rotation as [number, number, number, number] | undefined, node.scale as SpatialVector3 | undefined)] : list(node.matrix, 16).map(number);
    } catch { fail(); }
    if (local.length !== 16 || local[3] !== 0 || local[7] !== 0 || local[11] !== 0 || local[15] !== 1) fail();
    const world = multiplyMatrix4(parent, local);
    if (world.some(value => !Number.isFinite(value) || Math.abs(value) > 1000000)) fail();
    const determinant = world[0]! * (world[5]! * world[10]! - world[6]! * world[9]!) - world[4]! * (world[1]! * world[10]! - world[2]! * world[9]!) + world[8]! * (world[1]! * world[6]! - world[2]! * world[5]!);
    if (!Number.isFinite(determinant) || determinant === 0) fail();
    worlds.set(atIndex, world);
    for (const child of list(node.children ?? [], 4096)) pending.push({ at: child, parent: world });
  }
  const meshNodes = nodes.map((value, at) => ({ node: record(value), at })).filter(({ node }) => node.mesh !== undefined);
  if (meshNodes.length !== 1) fail();
  const { node, at } = meshNodes[0]!, expected = model.objects[0]!, world = worlds.get(at);
  if (!world || expected.nodeIndex !== at || index(node.mesh, meshes.length) !== 0) fail();
  const extra = record(node.extras), targets = map.parts.map(part => convertedGlbObjectId(r.sourceSha256, 'render', part.sourceKey)).sort();
  if (!isDeepStrictEqual(Object.keys(extra).sort(), ['arcane_collision_for', 'arcane_identity_scheme', 'arcane_pivot', 'arcane_role', 'arcane_source_key', 'arcane_source_object_id']) ||
      extra.arcane_identity_scheme !== GLB_CONVERSION_IDENTITY || extra.arcane_source_object_id !== convertedGlbObjectId(r.sourceSha256, 'collision', 'proxy') ||
      extra.arcane_source_key !== 'proxy' || extra.arcane_role !== 'collision' || !isDeepStrictEqual(extra.arcane_pivot, [0, 0, 0]) || extra.arcane_collision_for !== JSON.stringify(targets)) fail();
  const primitives = list(item(meshes, 0).primitives, 16);
  if (primitives.length !== 1) fail();
  const primitive = record(primitives[0]), attributes = record(primitive.attributes);
  if ((primitive.mode ?? 4) !== 4 || primitive.material !== undefined || primitive.targets !== undefined || primitive.extensions !== undefined ||
      Object.keys(attributes).some(name => name !== 'POSITION' && name !== 'NORMAL')) fail();
  const position = item(accessors, attributes.POSITION), indices = item(accessors, primitive.indices);
  if (position.type !== 'VEC3' || position.componentType !== 5126 || position.normalized || indices.type !== 'SCALAR' ||
      ![5121, 5123, 5125].includes(indices.componentType as number) || indices.normalized) fail();
  function read(accessor: Data, components: number): number[][] {
    const count = index(accessor.count, 60001);
    if (!count) fail();
    const component = accessor.componentType, width = component === 5121 ? 1 : component === 5123 ? 2 : component === 5125 || component === 5126 ? 4 : 0;
    if (!width) fail();
    function sample(at: number): number { return component === 5121 ? bin.readUInt8(at) : component === 5123 ? bin.readUInt16LE(at) : component === 5125 ? bin.readUInt32LE(at) : bin.readFloatLE(at); }
    function span(viewIndex: unknown, offsetValue: unknown, length: number, size: number, unit: number, decode: (at: number) => number, strided: boolean): number[][] {
      const view = item(views, viewIndex), offset = index(offsetValue ?? 0, bin.length + 1), start = index(view.byteOffset ?? 0, bin.length + 1), extent = index(view.byteLength, bin.length + 1);
      const stride = index(view.byteStride ?? size * unit, 253);
      if (view.buffer !== 0 || !extent || stride < size * unit || offset % unit || (start + offset) % unit || stride % unit || (!strided && view.byteStride !== undefined) ||
          start + extent > bin.length || offset + (length - 1) * stride + size * unit > extent) fail();
      return Array.from({ length }, (_, row) => Array.from({ length: size }, (_, c) => decode(start + offset + row * stride + c * unit)));
    }
    const rows = accessor.bufferView === undefined ? Array.from({ length: count }, () => Array<number>(components).fill(0)) : span(accessor.bufferView, accessor.byteOffset, count, components, width, sample, true);
    if (accessor.sparse !== undefined) {
      const sparse = record(accessor.sparse), n = index(sparse.count, count + 1), ix = record(sparse.indices), values = record(sparse.values);
      const type = ix.componentType, iw = type === 5121 ? 1 : type === 5123 ? 2 : type === 5125 ? 4 : 0;
      if (!n || !iw) fail();
      const at = span(ix.bufferView, ix.byteOffset, n, 1, iw, at => type === 5121 ? bin.readUInt8(at) : type === 5123 ? bin.readUInt16LE(at) : bin.readUInt32LE(at), false);
      const data = span(values.bufferView, values.byteOffset, n, components, width, sample, false);
      let previous = -1;
      for (let i = 0; i < n; i++) { const target = index(at[i]![0], count); if (target <= previous) fail(); previous = target; rows[target] = data[i]!; }
    }
    for (const row of rows) for (const value of row) if (!Number.isFinite(value)) fail();
    return rows;
  }
  const positions = read(position, 3).map(row => [...transformPoint3(world, row as unknown as SpatialVector3)]);
  if (positions.length < 4 || positions.some(row => row.some(value => !Number.isFinite(value) || Math.abs(value) > 1000000))) fail();
  const corners = read(indices, 1).map(row => index(row[0], positions.length));
  const triangleCount = corners.length / 3;
  if (!Number.isSafeInteger(triangleCount) || triangleCount < 4 || triangleCount > 20000 || map.parts.reduce((sum, part) => sum + part.triangles, 0) + triangleCount > 100000 || new Set(corners).size !== positions.length) fail();
  const key = (row: number[]) => JSON.stringify(row.map(value => value === 0 ? 0 : value));
  const keys = positions.map(key), unique = new Map(keys.map((value, at) => [value, positions[at]!]));
  if (unique.size < 4) fail();
  const center = [0, 1, 2].map(axis => [...unique.values()].reduce((sum, row) => sum + row[axis]!, 0) / unique.size);
  const edges = new Map<string, { count: number; direction: number; faces: number[] }>(), faceKeys = new Set<string>(), neighbors: number[][] = Array.from({ length: triangleCount }, () => []);
  let volume = 0, correction = 0;
  for (let face = 0; face < triangleCount; face++) {
    const ids = corners.slice(face * 3, face * 3 + 3), values = ids.map(at => positions[at]!), names = ids.map(at => keys[at]!);
    if (new Set(names).size !== 3) fail();
    const faceKey = [...names].sort().join('|'); if (faceKeys.has(faceKey)) fail(); faceKeys.add(faceKey);
    const [a, b, c] = values as [number[], number[], number[]], u = b.map((v, axis) => v - a[axis]!), v = c.map((n, axis) => n - a[axis]!);
    if (Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!) <= 1e-10) fail();
    for (let side = 0; side < 3; side++) {
      const from = names[side]!, to = names[(side + 1) % 3]!, forward = from < to, edgeKey = forward ? from + '|' + to : to + '|' + from;
      const edge = edges.get(edgeKey) ?? { count: 0, direction: 0, faces: [] };
      edge.count++; edge.direction += forward ? 1 : -1; edge.faces.push(face); edges.set(edgeKey, edge);
    }
    const p = a.map((n, i) => n - center[i]!), q = b.map((n, i) => n - center[i]!), t = c.map((n, i) => n - center[i]!);
    const term = (p[0]! * (q[1]! * t[2]! - q[2]! * t[1]!) + p[1]! * (q[2]! * t[0]! - q[0]! * t[2]!) + p[2]! * (q[0]! * t[1]! - q[1]! * t[0]!)) / 6;
    const corrected = term - correction, next = volume + corrected; correction = (next - volume) - corrected; volume = next;
  }
  for (const edge of edges.values()) {
    if (edge.count !== 2 || edge.direction !== 0) fail();
    const [a, b] = edge.faces as [number, number]; neighbors[a]!.push(b); neighbors[b]!.push(a);
  }
  const reached = new Set<number>(), todo = [0];
  while (todo.length) { const face = todo.pop()!; if (reached.has(face)) continue; reached.add(face); todo.push(...neighbors[face]!); }
  if (reached.size !== triangleCount || !Number.isFinite(volume) || volume <= 1e-12) fail();
  return Object.freeze({ triangles: triangleCount, measuredPositionVertices: unique.size, volumeMeters3: volume });
}
