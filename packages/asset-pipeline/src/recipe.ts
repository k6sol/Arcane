import { AssetError } from './types.js';
import type { AssemblyGeometry, AssemblyPart, AssemblyRecipe, AssemblyRole, SocketEvidence, Vec3 } from './types.js';
export const CUSTOM_REQUEST_BYTES = 256 * 1024;
export const JOB_JOURNAL_BYTES = 512 * 1024;
export const RECIPE_LIMITS = Object.freeze({ parts: 96, materials: 8, sockets: 64, meshVertices: 4096, meshTriangles: 8192, totalVertices: 20000, collisionTriangles: 4096, triangles: 50000 });

function fail(message: string): never { throw new AssetError('INPUT', message); }
export function jsonSnapshot(value: unknown): unknown {
  let nodes = 0;
  function visit(v: unknown, depth: number): void {
    if (++nodes > 100000 || depth > 12) fail('Recipe JSON exceeds its structural bound.');
    if (v === null || typeof v === 'boolean') return;
    if (typeof v === 'number') { if (!Number.isFinite(v)) fail('Recipe JSON requires finite numbers.'); return; }
    if (typeof v === 'string') { if (v.length > CUSTOM_REQUEST_BYTES) fail('Recipe JSON string is too large.'); return; }
    if (!v || typeof v !== 'object') fail('Asset inputs must be JSON data only.');
    const array = Array.isArray(v);
    if (!array && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) fail('Asset inputs require plain JSON objects.');
    if (Object.getOwnPropertySymbols(v).length) fail('Symbols are not JSON data.');
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(v))) {
      if (array && key === 'length') continue;
      if (!descriptor.enumerable || !('value' in descriptor)) fail('Accessors and hidden properties are not JSON data.');
      if (key.length > 64) fail('JSON field name is too long.');
      visit(descriptor.value, depth + 1);
    }
    if (array && Object.keys(v).length !== v.length) fail('Sparse arrays are not JSON data.');
  }
  visit(value, 0);
  const bytes = JSON.stringify(value);
  if (Buffer.byteLength(bytes) > CUSTOM_REQUEST_BYTES) fail('Asset request exceeds 256 KiB.');
  return JSON.parse(bytes) as unknown;
}
function object(v: unknown, allowed: string[], required: string[], label: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail(label + ' must be an object.');
  const r = v as Record<string, unknown>;
  if (Object.keys(r).some(k => !allowed.includes(k)) || required.some(k => r[k] === undefined)) fail('Unsupported or missing ' + label + ' field.');
  return r;
}
function num(v: unknown, min: number, max: number, label: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) fail('Invalid ' + label + '.');
  return v;
}
function int(v: unknown, min: number, max: number, label: string): number {
  const n = num(v, min, max, label); if (!Number.isSafeInteger(n)) fail(label + ' must be an integer.'); return n;
}
export function vec(v: unknown, min: number, max: number, label: string): Vec3 {
  if (!Array.isArray(v) || v.length !== 3) fail('Expected three coordinates for ' + label + '.');
  return v.map(n => num(n, min, max, label)) as Vec3;
}
function name(v: unknown): string {
  if (typeof v !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(v) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:-|$)/i.test(v)) fail('Recipe IDs must be safe lowercase slugs up to 48 characters.');
  return v;
}
function list(v: unknown, min: number, max: number, label: string): unknown[] {
  if (!Array.isArray(v) || v.length < min || v.length > max) fail('Invalid ' + label + ' count.'); return v;
}
function segments(v: unknown): number { const n = int(v ?? 24, 8, 64, 'segments'); if (n % 4) fail('Segments must be a multiple of four.'); return n; }

function meshCheck(vertices: Vec3[], indices: number[]): void {
  if (new Set(vertices.map(v => v.join(','))).size !== vertices.length) fail('Custom mesh has duplicate vertices.');
  const edges = new Map<string, { a: number; b: number; faces: number[] }>(), faces = new Set<string>(), used = new Set<number>(), volumes: number[] = [];
  for (let f = 0; f < indices.length / 3; f++) {
    const ids = indices.slice(f * 3, f * 3 + 3), [a, b, c] = ids.map(i => vertices[i]!) as [Vec3, Vec3, Vec3];
    const key = [...ids].sort((a, b) => a - b).join(',');
    if (new Set(ids).size !== 3 || faces.has(key)) fail('Custom mesh has duplicate or collapsed triangles.');
    faces.add(key); ids.forEach(i => used.add(i));
    const u = b.map((n, k) => n - a[k]!), v = c.map((n, k) => n - a[k]!);
    if (Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!) < 1e-8) fail('Custom mesh has a degenerate triangle.');
    volumes.push((a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6);
    for (let k = 0; k < 3; k++) {
      const x = ids[k]!, y = ids[(k + 1) % 3]!, e = [Math.min(x, y), Math.max(x, y)].join(',');
      const prior = edges.get(e);
      if (prior) {
        if (prior.faces.length !== 1 || prior.a !== y || prior.b !== x) fail('Custom mesh must be closed and consistently wound.');
        prior.faces.push(f);
      } else edges.set(e, { a: x, b: y, faces: [f] });
    }
  }
  if (used.size !== vertices.length || [...edges.values()].some(e => e.faces.length !== 2)) fail('Custom mesh has loose vertices or open/non-manifold edges.');
  // Closed edge incidence alone permits two shells touching at a single non-manifold vertex.
  const vertexFaces = vertices.map(() => new Set<number>());
  indices.forEach((v, i) => vertexFaces[v]!.add(Math.floor(i / 3)));
  const vertexAdjacency = vertices.map(() => new Map<number, number[]>());
  for (const edge of edges.values()) for (const v of [edge.a, edge.b]) {
    const [a, b] = edge.faces as [number, number], adjacency = vertexAdjacency[v]!;
    adjacency.set(a, [...(adjacency.get(a) ?? []), b]); adjacency.set(b, [...(adjacency.get(b) ?? []), a]);
  }
  for (let v = 0; v < vertices.length; v++) {
    const remaining = new Set(vertexFaces[v]), stack = [remaining.values().next().value!];
    remaining.delete(stack[0]!);
    while (stack.length) for (const next of vertexAdjacency[v]!.get(stack.pop()!) ?? []) if (remaining.delete(next)) stack.push(next);
    if (remaining.size) fail('Custom mesh has a non-manifold vertex fan.');
  }
  const adjacency = volumes.map(() => [] as number[]);
  for (const edge of edges.values()) { const [a, b] = edge.faces; adjacency[a!]!.push(b!); adjacency[b!]!.push(a!); }
  const unseen = new Set(volumes.map((_, i) => i));
  while (unseen.size) {
    const first = unseen.values().next().value!; unseen.delete(first); const stack = [first]; let volume = 0;
    while (stack.length) { const f = stack.pop()!; volume += volumes[f]!; for (const next of adjacency[f]!) if (unseen.delete(next)) stack.push(next); }
    if (volume <= 1e-9) fail('Each custom mesh component must have outward winding and nonzero volume.');
  }
}
function geometry(v: unknown): AssemblyGeometry {
  const g = object(v, ['kind', 'segments', 'rings', 'vertices', 'indices'], ['kind'], 'geometry');
  if (g.kind === 'box') { object(g, ['kind'], ['kind'], 'box'); return { kind: 'box' }; }
  if (g.kind === 'cylinder' || g.kind === 'cone') { object(g, ['kind', 'segments'], ['kind'], g.kind); return { kind: g.kind, segments: segments(g.segments) }; }
  if (g.kind === 'sphere') { object(g, ['kind', 'segments', 'rings'], ['kind'], 'sphere'); return { kind: 'sphere', segments: segments(g.segments), rings: int(g.rings ?? 12, 4, 32, 'sphere rings') }; }
  if (g.kind !== 'mesh') fail('Unsupported geometry primitive.');
  object(g, ['kind', 'vertices', 'indices'], ['kind', 'vertices', 'indices'], 'mesh');
  const vertices = list(g.vertices, 4, RECIPE_LIMITS.meshVertices, 'mesh vertices').map(v => vec(v, -0.5, 0.5, 'unit-cube mesh vertex'));
  const indices = list(g.indices, 12, RECIPE_LIMITS.meshTriangles * 3, 'mesh indices').map(i => int(i, 0, vertices.length - 1, 'mesh index'));
  if (indices.length % 3) fail('Mesh indices must form complete triangles.');
  meshCheck(vertices, indices);
  return { kind: 'mesh', vertices, indices };
}
export function normalizeRecipe(value: unknown, triangleBudget: number): AssemblyRecipe {
  const r = object(value, ['schemaVersion', 'materials', 'parts', 'sockets', 'collisionTriangleBudget', 'lodTriangleBudget'], ['schemaVersion', 'materials', 'parts'], 'recipe');
  if (r.schemaVersion !== 1) fail('Unsupported assembly recipe version.');
  const materialIds = new Set<string>();
  const materials = list(r.materials, 1, RECIPE_LIMITS.materials, 'materials').map(raw => {
    const m = object(raw, ['id', 'color', 'metallic', 'roughness', 'emission', 'surface'], ['id', 'color'], 'material'), id = name(m.id);
    if (materialIds.has(id)) fail('Duplicate material ID.'); materialIds.add(id);
    const emission = m.emission === undefined ? undefined : object(m.emission, ['color', 'strength'], ['color', 'strength'], 'emission');
    let surface: import('./types.js').MaterialSurface | undefined;
    if (m.surface !== undefined) {
      const s = object(m.surface, ['profile', 'resolution'], ['profile'], 'material surface');
      if (!['bark', 'stone', 'leaf', 'weathered'].includes(String(s.profile)) || ![128, 256, 512].includes(Number(s.resolution ?? 256))) fail('Unsupported material surface profile or resolution.');
      surface = { profile: s.profile as import('./types.js').MaterialSurface['profile'], resolution: int(s.resolution ?? 256, 128, 512, 'texture resolution') as 128 | 256 | 512 };
    }
    return { id, color: vec(m.color, 0, 1, 'material color'), metallic: num(m.metallic ?? 0, 0, 1, 'metallic'), roughness: num(m.roughness ?? 0.5, 0, 1, 'roughness'),
      ...(emission ? { emission: { color: vec(emission.color, 0, 1, 'emission color'), strength: num(emission.strength, 0, 10, 'emission strength') } } : {}), ...(surface ? { surface } : {}) };
  });
  const ids = new Set<string>();
  const parts = list(r.parts, 2, RECIPE_LIMITS.parts, 'parts').map(raw => {
    const p = object(raw, ['name', 'role', 'geometry', 'dimensions', 'position', 'rotationDegrees', 'material', 'bevel'], ['name', 'role', 'geometry', 'dimensions', 'position'], 'part');
    const id = name(p.name); if (ids.has(id)) fail('Duplicate part name.'); ids.add(id);
    if (!['render', 'collision', 'lod1'].includes(String(p.role))) fail('Unsupported part role.');
    const dimensions = vec(p.dimensions, 0.01, 20, 'dimensions'), g = geometry(p.geometry), role = p.role as AssemblyRole;
    const mat = p.material === undefined ? undefined : name(p.material);
    if (role === 'collision' ? mat !== undefined : !mat || !materialIds.has(mat)) fail('Render/LOD parts require a declared material; collision parts cannot have one.');
    let bevel: AssemblyPart['bevel'];
    if (p.bevel !== undefined) {
      if (g.kind === 'sphere' || g.kind === 'mesh' || role === 'collision') fail('Bevels are supported only for render/LOD boxes, cylinders and cones.');
      const b = object(p.bevel, ['width', 'segments'], ['width'], 'bevel');
      bevel = { width: num(b.width, 0.00001, Math.min(...dimensions) * 0.1, 'bevel width'), segments: int(b.segments ?? 1, 1, 3, 'bevel segments') };
    }
    return { name: id, role, geometry: g, dimensions, position: vec(p.position, -40, 40, 'position'), rotationDegrees: vec(p.rotationDegrees ?? [0, 0, 0], -360, 360, 'rotation degrees'), ...(mat ? { material: mat } : {}), ...(bevel ? { bevel } : {}) };
  });
  if (!parts.some(p => p.role === 'render') || !parts.some(p => p.role === 'collision')) fail('An assembly requires explicit render and collision parts.');
  const usedMaterials = new Set(parts.flatMap(p => p.material ? [p.material] : []));
  if (materials.some(m => !usedMaterials.has(m.id))) fail('Unused recipe materials are not permitted.');
  const socketIds = new Set<string>();
  const sockets = list(r.sockets ?? [], 0, RECIPE_LIMITS.sockets, 'sockets').map(raw => {
    const s = object(raw, ['name', 'kind', 'part', 'position', 'rotationDegrees'], ['name', 'kind', 'part', 'position'], 'socket'), id = name(s.name), part = name(s.part);
    if (socketIds.has(id) || !parts.some(p => p.name === part && p.role === 'render')) fail('Socket IDs must be unique and reference a render part.'); socketIds.add(id);
    if (s.kind !== 'socket' && s.kind !== 'attachment') fail('Unsupported socket kind.');
    return { name: id, kind: s.kind as 'socket' | 'attachment', part, position: vec(s.position, -20, 20, 'socket position'), rotationDegrees: vec(s.rotationDegrees ?? [0, 0, 0], -360, 360, 'socket rotation') };
  });
  const recipe: AssemblyRecipe = { schemaVersion: 1, materials, parts, sockets,
    collisionTriangleBudget: int(r.collisionTriangleBudget ?? 2048, 12, RECIPE_LIMITS.collisionTriangles, 'collision triangle budget'),
    lodTriangleBudget: int(r.lodTriangleBudget ?? triangleBudget, 12, triangleBudget, 'LOD triangle budget') };
  preflightRecipe(recipe, triangleBudget); expectedSockets(recipe);
  return recipe;
}
export function rotate(v: Vec3, degrees: Vec3): Vec3 {
  const [x, y, z] = degrees.map(a => a * Math.PI / 180), [cx, sx, cy, sy, cz, sz] = [Math.cos(x!), Math.sin(x!), Math.cos(y!), Math.sin(y!), Math.cos(z!), Math.sin(z!)];
  const a = v[1] * cx! - v[2] * sx!, b = v[1] * sx! + v[2] * cx!, c = v[0] * cy! + b * sy!, d = -v[0] * sy! + b * cy!;
  return [c * cz! - a * sz!, c * sz! + a * cz!, d];
}
function geometryFacts(g: AssemblyGeometry): { points: Vec3[]; vertices: number; edges: number; triangles: number } {
  if (g.kind === 'mesh') return { points: g.vertices, vertices: g.vertices.length, edges: g.indices.length / 2, triangles: g.indices.length / 3 };
  if (g.kind === 'box') {
    const points: Vec3[] = [];
    for (const x of [-0.5, 0.5]) for (const y of [-0.5, 0.5]) for (const z of [-0.5, 0.5]) points.push([x, y, z]);
    return { points, vertices: 8, edges: 12, triangles: 12 };
  }
  const n = g.segments ?? 24, points: Vec3[] = [];
  if (g.kind === 'sphere') {
    const rings = g.rings ?? 12;
    points.push([0, 0, -0.5], [0, 0, 0.5]);
    for (let ring = 1; ring < rings; ring++) for (let j = 0; j < n; j++) {
      const angle = ring * Math.PI / rings, phi = j * 2 * Math.PI / n;
      points.push([0.5 * Math.sin(angle) * Math.cos(phi), 0.5 * Math.sin(angle) * Math.sin(phi), -0.5 * Math.cos(angle)]);
    }
    return { points, vertices: points.length, edges: 3 * n * (rings - 1), triangles: 2 * n * (rings - 1) };
  }
  for (let j = 0; j < n; j++) {
    const x = 0.5 * Math.cos(j * 2 * Math.PI / n), y = 0.5 * Math.sin(j * 2 * Math.PI / n);
    points.push([x, y, -0.5]); if (g.kind === 'cylinder') points.push([x, y, 0.5]);
  }
  if (g.kind === 'cone') points.push([0, 0, 0.5]);
  return { points, vertices: points.length, edges: (g.kind === 'cone' ? 2 : 3) * n, triangles: (g.kind === 'cone' ? 2 : 4) * n - (g.kind === 'cone' ? 2 : 4) };
}
export function preflightPart(part: AssemblyPart) {
  const facts = geometryFacts(part.geometry), steps = part.bevel?.segments ?? 1;
  const triangles = facts.triangles + (part.bevel ? facts.edges * 4 * steps + facts.vertices * 8 * steps * steps : 0);
  const vertices = facts.vertices + (part.bevel ? facts.edges * 2 * steps + facts.vertices * (steps + 1) ** 2 : 0);
  const points = facts.points.map(vertex => rotate(vertex.map((v, k) => v * part.dimensions[k]!) as Vec3, part.rotationDegrees ?? [0, 0, 0]).map((v, k) => v + part.position[k]!) as Vec3);
  return { triangles, vertices, bounds: { min: [0, 1, 2].map(k => Math.min(...points.map(v => v[k]!))) as Vec3, max: [0, 1, 2].map(k => Math.max(...points.map(v => v[k]!))) as Vec3 } };
}
export function preflightRecipe(recipe: AssemblyRecipe, triangleBudget: number) {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  const estimatedTriangles = { render: 0, collision: 0, lod1: 0 }; let vertices = 0;
  for (const part of recipe.parts) {
    const facts = preflightPart(part);
    vertices += facts.vertices;
    estimatedTriangles[part.role] += facts.triangles;
    if ([...facts.bounds.min, ...facts.bounds.max].some(v => !Number.isFinite(v) || Math.abs(v) > 60)) fail('Assembly geometry exceeds the world bounds.');
    if (part.role === 'render') for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k]!, facts.bounds.min[k]!); max[k] = Math.max(max[k]!, facts.bounds.max[k]!); }
  }
  if (vertices > RECIPE_LIMITS.totalVertices || estimatedTriangles.render > triangleBudget || estimatedTriangles.collision > recipe.collisionTriangleBudget! || estimatedTriangles.lod1 > recipe.lodTriangleBudget! || (estimatedTriangles.lod1 > 0 && estimatedTriangles.lod1 >= estimatedTriangles.render)) fail('Assembly conservative triangle/vertex budget failed before launch.');
  if (Math.abs(min[2]) > 1e-5 || min[2] < -1e-5 || max.some((v, k) => v - min[k]! > 40)) fail('Render geometry must touch the Z=0 floor and fit a 40-metre assembly.');
  return { estimatedTriangles, bounds: { min, max } };
}
export function socketMatrix(part: AssemblyPart, socket: NonNullable<AssemblyRecipe['sockets']>[number]): number[] {
  const basis = [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as Vec3[];
  const columns = basis.map(v => rotate(rotate(v, socket.rotationDegrees ?? [0, 0, 0]), part.rotationDegrees ?? [0, 0, 0]));
  const position = rotate(socket.position, part.rotationDegrees ?? [0, 0, 0]).map((n, k) => n + part.position[k]!);
  if (position.some(n => Math.abs(n) > 60)) fail('Socket is outside the assembly world bounds.');
  return [columns[0]![0], columns[1]![0], columns[2]![0], position[0]!, columns[0]![1], columns[1]![1], columns[2]![1], position[1]!, columns[0]![2], columns[1]![2], columns[2]![2], position[2]!, 0, 0, 0, 1];
}
export function expectedSockets(recipe: AssemblyRecipe): SocketEvidence[] {
  return (recipe.sockets ?? []).map(s => ({ name: s.name, kind: s.kind, part: s.part, nodeName: (s.kind === 'socket' ? 'SOCK_' : 'ATT_') + s.name, matrix: socketMatrix(recipe.parts.find(p => p.name === s.part)!, s) }));
}
export function checkSockets(raw: unknown, recipe: AssemblyRecipe): void {
  const expected = expectedSockets(recipe);
  if (!Array.isArray(raw) || raw.length !== expected.length) throw new AssetError('MESH', 'Socket evidence is incomplete.');
  const ids = new Set<string>();
  for (const item of raw) {
    const actual = object(item, ['name', 'kind', 'part', 'nodeName', 'matrix'], ['name', 'kind', 'part', 'nodeName', 'matrix'], 'socket evidence'), match = expected.find(s => s.name === actual.name);
    if (!match || ids.has(match.name) || actual.kind !== match.kind || actual.part !== match.part || actual.nodeName !== match.nodeName || !Array.isArray(actual.matrix) || actual.matrix.length !== 16 || actual.matrix.some((n, i) => typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n - match.matrix[i]!) > 0.0001)) throw new AssetError('MESH', 'Saved/exported socket pose differs from recipe.');
    ids.add(match.name);
  }
}
