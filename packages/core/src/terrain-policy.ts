import { ArcaneError } from '../../protocol/src/providers.js';
import { object, TERRAIN_LIMITS as L, type Json, type StudioSession } from '../../protocol/src/studio.js';

/** Wire validation for terrain.generate. The plugin (TerrainGen.luau) re-validates every field,
 * snaps the region to the 4-stud voxel grid and owns the engine writes. */
export const TERRAIN_SURFACE_MATERIALS = ['Grass', 'LeafyGrass', 'Ground', 'Mud', 'Rock', 'Slate', 'Sand', 'Sandstone', 'Limestone', 'Basalt', 'Granite', 'Pebble', 'Snow', 'Ice', 'Glacier', 'Salt', 'Cobblestone', 'Asphalt', 'Concrete', 'Brick', 'WoodPlanks', 'CrackedLava'] as const;
export const TERRAIN_FEATURE_KINDS = ['hill', 'mountain', 'valley', 'crater', 'plateau', 'flatten', 'lake', 'river', 'path'] as const;
export const TERRAIN_NOISE_TYPES = ['fbm', 'ridged'] as const;

function keys(input: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Object.keys(input).some(k => !allowed.includes(k))) throw new ArcaneError('INPUT', `Unexpected ${label} field.`);
}
function num(value: unknown, low: number, high: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < low || value > high) throw new ArcaneError('INPUT', `${label} must be ${low}..${high}.`);
  return value;
}
function opt(value: unknown, low: number, high: number, label: string): void { if (value !== undefined) num(value, low, high, label); }
function pair(value: unknown, low: number, high: number, label: string): number[] {
  if (!Array.isArray(value) || value.length !== 2) throw new ArcaneError('INPUT', `${label} needs two numbers.`);
  return value.map(n => num(n, low, high, label));
}
function material(value: unknown, label: string): void {
  if (value !== undefined && !TERRAIN_SURFACE_MATERIALS.includes(value as typeof TERRAIN_SURFACE_MATERIALS[number])) throw new ArcaneError('PROPERTY', `Unsupported ${label}.`);
}
const cells = (studs: number) => Math.floor(studs / L.voxel + 0.5);

/** Exact voxel count the plugin writes (and reports in its receipt) for validated args. */
export function terrainVoxelCount(args: Record<string, unknown>): number {
  const size = args.size as number[];
  return cells(size[0]!) * cells(size[1]!) * cells(args.height as number);
}

function feature(raw: unknown): void {
  const f = object(raw, 'terrain feature'), kind = f.kind;
  if (!TERRAIN_FEATURE_KINDS.includes(kind as typeof TERRAIN_FEATURE_KINDS[number])) throw new ArcaneError('INPUT', 'Unsupported terrain feature kind.');
  if (kind === 'river' || kind === 'path') {
    keys(f, ['kind', 'points', 'width', 'depth', 'bank', 'material'], String(kind));
    if (!Array.isArray(f.points) || f.points.length < 2 || f.points.length > L.points) throw new ArcaneError('INPUT', `A ${kind} needs 2..${L.points} points.`);
    for (const point of f.points) pair(point, -L.coordinate, L.coordinate, `${kind} point`);
    num(f.width, 2, 256, `${kind} width`); opt(f.depth, 0, 64, `${kind} depth`); opt(f.bank, 0, 256, `${kind} bank`); material(f.material, `${kind} material`);
    return;
  }
  pair(f.center, -L.coordinate, L.coordinate, `${kind} center`);
  if (kind === 'lake') {
    keys(f, ['kind', 'center', 'radius', 'level', 'depth', 'material'], 'lake');
    num(f.radius, 8, 1024, 'lake radius'); num(f.level, 0, L.height, 'lake level'); opt(f.depth, 1, 256, 'lake depth'); material(f.material, 'lake material');
  } else if (kind === 'plateau' || kind === 'flatten') {
    keys(f, ['kind', 'center', 'radius', 'level', 'blend', 'material'], kind);
    num(f.radius, 4, L.extent, `${kind} radius`);
    if (kind === 'plateau' && f.level === undefined) throw new ArcaneError('INPUT', 'A plateau needs level.');
    opt(f.level, 0, L.height, `${kind} level`); opt(f.blend, 0, 512, `${kind} blend`); material(f.material, `${kind} material`);
  } else {
    keys(f, ['kind', 'center', 'radius', 'height', 'roughness'], String(kind));
    num(f.radius, 4, L.extent, `${kind} radius`); num(f.height, 0, L.height, `${kind} height`); opt(f.roughness, 0, 1, `${kind} roughness`);
  }
}

export function validateTerrainGenerate(a: Record<string, Json>, session: StudioSession): Record<string, Json> {
  keys(a, ['center', 'size', 'floor', 'height', 'baseHeight', 'seed', 'noise', 'edge', 'snowLine', 'features', 'materials'], 'terrain');
  if (!session.allowedRoots.includes('Workspace')) throw new ArcaneError('SCOPE', 'Terrain requires the Workspace grant.');
  pair(a.center, -L.coordinate, L.coordinate, 'Terrain center');
  pair(a.size, L.minExtent, L.extent, 'Terrain size');
  const height = num(a.height, L.minHeight, L.height, 'Terrain height');
  opt(a.floor, -L.floor, L.floor, 'Terrain floor');
  num(a.baseHeight, 0, cells(height) * L.voxel, 'baseHeight');
  if (!Number.isInteger(a.seed) || (a.seed as number) < 0 || (a.seed as number) > 2147483647) throw new ArcaneError('INPUT', 'seed must be an integer 0..2147483647.');
  if (a.noise !== undefined) {
    const n = object(a.noise, 'terrain noise'); keys(n, ['type', 'octaves', 'frequency', 'amplitude', 'persistence'], 'noise');
    if (n.type !== undefined && !TERRAIN_NOISE_TYPES.includes(n.type as typeof TERRAIN_NOISE_TYPES[number])) throw new ArcaneError('INPUT', 'Noise type must be fbm or ridged.');
    if (n.octaves !== undefined && (!Number.isInteger(n.octaves) || (n.octaves as number) < 1 || (n.octaves as number) > L.octaves)) throw new ArcaneError('INPUT', `octaves must be 1..${L.octaves}.`);
    opt(n.frequency, 0.1, 100, 'frequency'); opt(n.amplitude, 0, L.height, 'amplitude'); opt(n.persistence, 0.2, 0.8, 'persistence');
  }
  opt(a.edge, 0, 1024, 'edge'); opt(a.snowLine, 0, L.height, 'snowLine');
  if (a.features !== undefined) {
    if (!Array.isArray(a.features) || a.features.length > L.features) throw new ArcaneError('INPUT', `Use at most ${L.features} terrain features.`);
    for (const raw of a.features) feature(raw);
  }
  if (a.materials !== undefined) {
    const m = object(a.materials, 'terrain materials'); keys(m, ['rules', 'fallback', 'deep'], 'materials');
    material(m.fallback, 'fallback material'); material(m.deep, 'deep material');
    if (m.rules !== undefined) {
      if (!Array.isArray(m.rules) || m.rules.length > L.rules) throw new ArcaneError('INPUT', `Use at most ${L.rules} material rules.`);
      for (const raw of m.rules) {
        const r = object(raw, 'material rule'); keys(r, ['material', 'minHeight', 'maxHeight', 'minSlope', 'maxSlope', 'minNoise', 'maxNoise', 'nearWater'], 'material rule');
        if (r.material === undefined) throw new ArcaneError('INPUT', 'A material rule needs material.');
        material(r.material, 'rule material');
        opt(r.minHeight, 0, L.height, 'minHeight'); opt(r.maxHeight, 0, L.height, 'maxHeight'); opt(r.minSlope, 0, 90, 'minSlope'); opt(r.maxSlope, 0, 90, 'maxSlope');
        opt(r.minNoise, -1, 1, 'minNoise'); opt(r.maxNoise, -1, 1, 'maxNoise'); opt(r.nearWater, 0, 64, 'nearWater');
      }
    }
  }
  if (terrainVoxelCount(a) > L.voxels) throw new ArcaneError('BODY_LIMIT', 'Terrain region exceeds the voxel budget.');
  return a;
}
