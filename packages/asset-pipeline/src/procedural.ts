import { AssetError } from './types.js';
import type { AssemblyMaterial, MaterialSurface, ProceduralSpec, Vec3 } from './types.js';

/** Bounded parameters for the bundled Blender generators (workers/blender/procedural.py).
 * Data only: typed numbers/enums, never code, paths or imports. Normalization is
 * canonical (fixed key order, explicit defaults) so a stored request re-normalizes
 * to itself. Triangle budgets follow the 20,000-triangle per-mesh Roblox limit. */
export const PROCEDURAL_KINDS = ['tree', 'rock', 'column', 'foliage', 'log', 'stump'] as const;
export const TREE_SPECIES = ['pine', 'oak', 'birch', 'palm'] as const;
export const COLUMN_BASES = ['none', 'plinth', 'attic'] as const;
export const COLUMN_CAPITALS = ['none', 'doric', 'ionic', 'corinthian'] as const;
export const FOLIAGE_STYLES = ['bush', 'grass', 'fern'] as const;
/** Fallen log / stump: species bark (oak, birch), sawn or broken ends, optional moss band. */
export const DEADWOOD_SPECIES = ['oak', 'birch'] as const;
export const LOG_ENDS = ['cut', 'broken', 'mixed'] as const;
export const STUMP_TOPS = ['cut', 'broken'] as const;
export const PROCEDURAL_FINISHES = ['natural', 'flat'] as const;
export const PROCEDURAL_SURFACE_RESOLUTION = 256;
/** Natural oak/birch/pine: species bark tile and leaf/needle-spray cutout atlas (glTF MASK leaves) at 512 px. */
export const PROCEDURAL_TREE_SURFACE_RESOLUTION = 512;
const PATTERN_SPECIES: readonly string[] = ['oak', 'birch', 'pine'];
export const PROCEDURAL_LIMITS = Object.freeze({
  minTriangles: 2500, maxTriangles: 20000,
  defaultTriangles: { tree: 16000, rock: 6000, column: 12000, foliage: 8000, log: 4000, stump: 4000 } as const,
  treeHeight: [2, 20] as const, trunkRadius: [0.03, 1.5] as const, rockSize: [0.1, 12] as const,
  columnRadius: [0.05, 2] as const, columnHeight: [0.5, 20] as const, flutes: [8, 32] as const,
  foliageRadius: [0.1, 5] as const, foliageHeight: [0.1, 5] as const,
  logLength: [0.5, 12] as const, logRadius: [0.05, 1.2] as const, stumpRadius: [0.05, 1.5] as const, stumpHeight: [0.1, 2.5] as const,
});
/** Per-species default colours (linear RGB) and approximate crown width/height ratio. */
const SPECIES = {
  pine: { bark: [0.24, 0.14, 0.09], leaves: [0.05, 0.16, 0.07], width: 0.7 },
  oak: { bark: [0.22, 0.18, 0.14], leaves: [0.12, 0.25, 0.06], width: 0.9 },
  birch: { bark: [0.82, 0.8, 0.75], leaves: [0.24, 0.42, 0.1], width: 0.55 },
  palm: { bark: [0.42, 0.34, 0.24], leaves: [0.14, 0.32, 0.08], width: 0.8 },
} as const;
const PRIMARY = { rock: [0.2, 0.19, 0.17], column: [0.78, 0.75, 0.68], foliage: [0.13, 0.3, 0.08] } as const;

function fail(message: string): never { throw new AssetError('INPUT', message); }
function fields(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('procedural must be an object.');
  const r = value as Record<string, unknown>;
  const extra = Object.keys(r).find(k => !allowed.includes(k));
  if (extra !== undefined) fail('Unsupported procedural field: ' + extra.slice(0, 64) + '.');
  return r;
}
function num(v: unknown, [low, high]: readonly [number, number], fallback: number, label: string): number {
  const n = v ?? fallback;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < low || n > high) fail(`${label} must be ${low}..${high}.`);
  return n;
}
function int(v: unknown, [low, high]: readonly [number, number], fallback: number, label: string): number {
  const n = num(v, [low, high], fallback, label);
  if (!Number.isInteger(n)) fail(`${label} must be an integer.`);
  return n;
}
function choice<T extends string>(v: unknown, options: readonly T[], fallback: T, label: string): T {
  const value = v ?? fallback;
  if (typeof value !== 'string' || !(options as readonly string[]).includes(value)) fail(`${label} must be one of ${options.join(', ')}.`);
  return value as T;
}
function flag(v: unknown, label: string): boolean {
  const value = v ?? false;
  if (typeof value !== 'boolean') fail(`${label} must be true or false.`);
  return value;
}
function color(v: unknown, label: string): Vec3 | null {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || v.length !== 3 || v.some(n => typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1)) fail(`${label} must be three linear 0..1 numbers.`);
  return [...v] as Vec3;
}
function vec(v: unknown, range: readonly [number, number], fallback: Vec3, label: string): Vec3 {
  const value = v ?? fallback;
  if (!Array.isArray(value) || value.length !== 3) fail(`${label} needs three numbers.`);
  return value.map(n => num(n, range, 0, label)) as Vec3;
}

export function normalizeProcedural(value: unknown): ProceduralSpec {
  const kind = choice((value as { kind?: unknown } | null)?.kind, PROCEDURAL_KINDS, 'tree', 'procedural.kind');
  // Omitted legacy requests keep their exact canonical bytes and flat-material meaning.
  // The reviewed assets_procedural tool explicitly selects the natural finish by default.
  const finished = <T extends ProceduralSpec>(r: Record<string, unknown>, spec: T): T => r.finish === undefined ? spec
    : { ...spec, finish: typeof r.finish === 'string' && (PROCEDURAL_FINISHES as readonly string[]).includes(r.finish)
      ? r.finish as typeof PROCEDURAL_FINISHES[number] : fail('procedural.finish must be natural or flat.') };
  if (kind === 'tree') {
    const r = fields(value, ['kind', 'species', 'height', 'trunkTaper', 'branchLevels', 'leafDensity', 'trunkRadius', 'secondaryColor', 'finish']);
    const height = num(r.height, PROCEDURAL_LIMITS.treeHeight, 9, 'Tree height (m)'), species = choice(r.species, TREE_SPECIES, 'oak', 'Tree species');
    return finished(r, { kind, species, height,
      trunkTaper: num(r.trunkTaper, [0.2, 0.95], 0.55, 'trunkTaper'), branchLevels: int(r.branchLevels, [1, 3], 2, 'branchLevels'),
      leafDensity: num(r.leafDensity, [0, 1], 0.7, 'leafDensity'),
      trunkRadius: r.trunkRadius === null || r.trunkRadius === undefined ? null : num(r.trunkRadius, PROCEDURAL_LIMITS.trunkRadius, 0, 'trunkRadius (m)'),
      secondaryColor: color(r.secondaryColor, 'secondaryColor') ?? [...SPECIES[species].leaves] as Vec3 });
  }
  if (kind === 'rock') {
    const r = fields(value, ['kind', 'size', 'roughness', 'finish']);
    return finished(r, { kind, size: vec(r.size, PROCEDURAL_LIMITS.rockSize, [1.6, 1.2, 0.9], 'Rock size (m)'), roughness: num(r.roughness, [0, 1], 0.5, 'roughness') });
  }
  if (kind === 'column') {
    const r = fields(value, ['kind', 'radius', 'height', 'flutes', 'base', 'capital', 'finish']);
    const radius = num(r.radius, PROCEDURAL_LIMITS.columnRadius, 0.35, 'Column radius (m)'), height = num(r.height, PROCEDURAL_LIMITS.columnHeight, 4, 'Column height (m)');
    const flutes = int(r.flutes, [0, PROCEDURAL_LIMITS.flutes[1]], 20, 'flutes');
    if (flutes !== 0 && flutes < PROCEDURAL_LIMITS.flutes[0]) fail('flutes must be 0 (smooth) or 8..32.');
    if (height < radius * 4) fail('Column height must be at least four times its radius.');
    return finished(r, { kind, radius, height, flutes, base: choice(r.base, COLUMN_BASES, 'attic', 'Column base'), capital: choice(r.capital, COLUMN_CAPITALS, 'doric', 'Column capital') });
  }
  if (kind === 'log') {
    const r = fields(value, ['kind', 'species', 'length', 'radius', 'ends', 'moss', 'finish']);
    return finished(r, { kind, species: choice(r.species, DEADWOOD_SPECIES, 'oak', 'Log species'), length: num(r.length, PROCEDURAL_LIMITS.logLength, 3, 'Log length (m)'),
      radius: num(r.radius, PROCEDURAL_LIMITS.logRadius, 0.25, 'Log radius (m)'), ends: choice(r.ends, LOG_ENDS, 'mixed', 'Log ends'), moss: flag(r.moss, 'moss') });
  }
  if (kind === 'stump') {
    const r = fields(value, ['kind', 'species', 'radius', 'height', 'top', 'moss', 'finish']);
    return finished(r, { kind, species: choice(r.species, DEADWOOD_SPECIES, 'oak', 'Stump species'), radius: num(r.radius, PROCEDURAL_LIMITS.stumpRadius, 0.35, 'Stump radius (m)'),
      height: num(r.height, PROCEDURAL_LIMITS.stumpHeight, 0.5, 'Stump height (m)'), top: choice(r.top, STUMP_TOPS, 'cut', 'Stump top'), moss: flag(r.moss, 'moss') });
  }
  const r = fields(value, ['kind', 'style', 'radius', 'height', 'density', 'finish']);
  return finished(r, { kind, style: choice(r.style, FOLIAGE_STYLES, 'bush', 'Foliage style'), radius: num(r.radius, PROCEDURAL_LIMITS.foliageRadius, 0.8, 'Foliage radius (m)'),
    height: num(r.height, PROCEDURAL_LIMITS.foliageHeight, 0.9, 'Foliage height (m)'), density: num(r.density, [0, 1], 0.7, 'density') });
}

/** Exact render membership from normalized parameters; never inferred from scene claims. */
export function proceduralRenderSourceKeys(spec: ProceduralSpec, manifestVersion: 1 | 2 = 2): string[] {
  return spec.kind === 'tree' ? (manifestVersion === 2 && spec.leafDensity === 0 ? ['bark'] : ['bark', 'leaves'])
    : [spec.kind === 'column' ? 'stone' : spec.kind === 'rock' ? 'rock' : spec.kind === 'log' || spec.kind === 'stump' ? 'bark' : 'foliage'];
}

/** Exact opaque PBR authoring contract shared by generation, persisted audit and GLB verification. */
export function proceduralSurfaceMaterials(spec: ProceduralSpec, primary: Vec3, manifestVersion: 1 | 2 = 2): AssemblyMaterial[] {
  if (spec.finish !== 'natural') return [];
  const rows: [string, MaterialSurface['profile'], Vec3, number][] = spec.kind === 'tree' ? [['Bark', 'bark', primary, .92], ['Leaves', 'leaf', spec.secondaryColor, .8]]
    : spec.kind === 'log' || spec.kind === 'stump' ? [['Bark', 'bark', primary, .92]]
    : spec.kind === 'rock' ? [['Rock', 'stone', primary, .88]] : spec.kind === 'column' ? [['Stone', 'weathered', primary, .8]]
    : [['Foliage', 'leaf', primary, .8]];
  const keys = proceduralRenderSourceKeys(spec, manifestVersion);
  const resolution = (spec.kind === 'tree' && PATTERN_SPECIES.includes(spec.species)) || spec.kind === 'log' || spec.kind === 'stump' ? PROCEDURAL_TREE_SURFACE_RESOLUTION : PROCEDURAL_SURFACE_RESOLUTION;
  return rows.filter(([id]) => keys.includes(id.toLowerCase())).map(([id, profile, color, roughness]) => ({ id, color: [...color] as Vec3, metallic: 0, roughness,
    surface: { profile, resolution } }));
}

/** Worker pattern evidence for a natural oak/birch/pine surface (e.g. 'pine-leaves', log/stump 'birch-log'), else undefined. */
export function proceduralSurfacePattern(spec: ProceduralSpec, id: string): string | undefined {
  if (spec.kind === 'log' || spec.kind === 'stump') return spec.finish === 'natural' ? spec.species + '-log' : undefined;
  return spec.finish === 'natural' && spec.kind === 'tree' && PATTERN_SPECIES.includes(spec.species) ? spec.species + '-' + id.toLowerCase() : undefined;
}

const clamp = (n: number) => Math.min(20, Math.max(0.1, Math.round(n * 1e4) / 1e4));
/** Approximate bounding size, informational only; the worker measures the real bounds. */
export function proceduralSize(spec: ProceduralSpec): Vec3 {
  if (spec.kind === 'tree') { const w = clamp(spec.height * SPECIES[spec.species].width); return [w, w, clamp(spec.height)]; }
  if (spec.kind === 'rock') return spec.size.map(clamp) as Vec3;
  if (spec.kind === 'column') { const w = clamp(spec.radius * (spec.base === 'none' ? 2.6 : 2.7)); return [w, w, clamp(spec.height)]; }
  if (spec.kind === 'log') return [clamp(spec.length), clamp(spec.radius * 2.4), clamp(spec.radius * 2.2)];
  if (spec.kind === 'stump') return [clamp(spec.radius * 3.2), clamp(spec.radius * 3.2), clamp(spec.height + (spec.top === 'broken' ? spec.radius * .8 : 0))];
  return [clamp(spec.radius * 2), clamp(spec.radius * 2), clamp(spec.height)];
}
export function proceduralColor(spec: ProceduralSpec): Vec3 {
  return [...(spec.kind === 'tree' || spec.kind === 'log' || spec.kind === 'stump' ? SPECIES[spec.species].bark : PRIMARY[spec.kind])] as Vec3;
}
export function proceduralDefaultBudget(spec: ProceduralSpec): number { return PROCEDURAL_LIMITS.defaultTriangles[spec.kind]; }
/** Worst-case preflight so an impossible budget fails before Blender starts. */
export function proceduralMinimumTriangles(spec: ProceduralSpec): number {
  if (spec.kind === 'column') { const segments = spec.flutes ? Math.max(32, spec.flutes * 4) : 32; return 2 * segments * 26 + 2 * (segments - 2) + 3500; }
  return PROCEDURAL_LIMITS.minTriangles;
}
/** Roblox material the Studio plugin applies per generated part (by source key). */
export const PROCEDURAL_PART_MATERIALS = Object.freeze({ bark: 'Wood', leaves: 'Grass', rock: 'Slate', stone: 'Marble', foliage: 'Grass' } as const);
