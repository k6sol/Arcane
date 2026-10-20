/**
 * scene_build composition kits, expanded locally before compileSceneBuild so the wire form stays the strict, validated
 * prototype/placement build. A `plinth` kit is a circular stone landmark (stepped tiers with trim, optional fluted column,
 * weathering) with a SpawnLocation centred on its top; a `forest` kit is a layered, seeded scatter (species groves with
 * per-species spacing, clearing + rim falloff, tilt variants, undergrowth hugging tree bases, terrain drop).
 * This module has no runtime import from scene-build.ts (that file imports it); input types are type-only.
 */
import { SCENE_BUILD_LIMITS } from '../../../packages/protocol/src/studio.js';
import { PROCEDURAL_LIMITS } from '../../../packages/asset-pipeline/src/procedural.js';
import { BridgeError } from './daemon-client.js';
import type { SceneBuildInput } from './scene-build.js';

type Vec = [number, number, number];
type Mat = [Vec, Vec, Vec];
type Proto = NonNullable<SceneBuildInput['prototypes']>[string];
type ProtoPart = NonNullable<Proto['parts']>[number];
type Item = SceneBuildInput['items'][number];
type Scatter = SceneBuildInput['scatter'][number];
export type Kit = NonNullable<SceneBuildInput['kits']>[number];
type Layer = NonNullable<Kit['species']>[number] & { footprint?: number };
/** A plinth kit with every default resolved. */
interface PlinthKit { kind: 'plinth'; key?: string | undefined; in?: string | undefined; name?: string | undefined; at: Vec; seed: number; radius: number;
  tiers: number; riser: number; style: 'fluted' | 'smooth' | 'platform'; height: number; flutes: number; column?: string | undefined;
  material: NonNullable<Props['Material']>; trim: NonNullable<Props['Material']>; color?: unknown; weathering: number; spawn: boolean; life?: 'day' | 'dusk' | undefined }
const PLINTH_ONLY = ['style', 'tiers', 'height', 'column', 'material', 'color', 'weathering', 'spawn', 'life'] as const;
const FOREST_ONLY = ['clearing', 'trees', 'undergrowth', 'species', 'cover', 'paths'] as const;
function only(kit: Kit, label: string, forbidden: readonly string[]) {
  const extra = forbidden.filter(field => (kit as Record<string, unknown>)[field] !== undefined);
  if (extra.length) throw new BridgeError('INPUT', `A ${kit.kind} kit (${label}) does not take ${extra.join(', ')}.`);
}
function resolvePlinth(kit: Kit, label: string): PlinthKit {
  only(kit, label, FOREST_ONLY);
  const radius = kit.radius ?? 10;
  if (radius > 60) throw new BridgeError('INPUT', `Plinth "${label}": radius must be at most 60.`);
  const material = kit.material ?? 'Limestone', style = kit.style ?? 'smooth';
  return { kind: 'plinth', key: kit.key, in: kit.in, name: kit.name, at: kit.at as Vec, seed: kit.seed, radius, tiers: kit.tiers ?? 3, riser: 1, style,
    height: kit.height ?? 18, flutes: style === 'fluted' ? 16 : 0, column: kit.column, material, trim: material === 'Limestone' ? 'Marble' : material,
    color: kit.color, weathering: kit.weathering ?? 0.5, spawn: kit.spawn ?? true, life: kit.life };
}

/** Per-kit summary returned with the build receipt (a template clone counts the layer's `tris`, else its recipe generator's
 * assets_procedural budget for `<use>-<n>` originals, else TEMPLATE_TRIANGLES). */
export interface KitReport { kind: 'plinth' | 'forest'; key: string; parts: number; triangles: number;
  spawn?: { at: number[]; top: number }; top?: number; placed?: number; requested?: number;
  /** Plinth ambient life: effect/sound instance count and the steady-state particle budget (sum of Rate x max Lifetime). */
  life?: { instances: number; particles: number; sounds: string[] };
  /** Forest layers cloned from Blender original template variants (`<use>-<n>`), and the ones that fell back to blockouts. */
  originals?: Record<string, string[]>; blockouts?: string[]; note?: string; recipe?: OriginalVariant[] }
/** Internal bookkeeping consumed by compileSceneBuild: which items/scatter specs belong to each kit. */
export interface KitPlan { report: KitReport; items: [number, number]; scatter: number[]; tris: Map<string, number> }

/** Rough render cost of Roblox primitives, used only for kit budgets. */
export const PRIMITIVE_TRIANGLES: Record<string, number> = { Block: 12, Cylinder: 64, Ball: 256, WedgePart: 8, CornerWedgePart: 6 };
/** Estimated triangles for a template clone when no `tris` is given (assets_procedural default budgets are 6k-16k). */
export const TEMPLATE_TRIANGLES = 8000;
/** A kit whose estimate exceeds this is refused; lower counts or triangleBudget instead of shipping an unplayable scene. */
export const KIT_TRIANGLE_BUDGET = 3_000_000;

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const r2 = (value: number) => Number(value.toFixed(2)), r3 = (value: number) => Number(value.toFixed(3));
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const DEG = Math.PI / 180;

// ---- rotation helpers (Roblox Orientation is applied Y, then X, then Z) ----
function mul(a: Mat, b: Mat): Mat {
  return [0, 1, 2].map(i => [0, 1, 2].map(j => a[i]![0] * b[0]![j]! + a[i]![1] * b[1]![j]! + a[i]![2] * b[2]![j]!)) as Mat;
}
function apply(m: Mat, v: readonly number[]): Vec { return [0, 1, 2].map(i => m[i]![0] * v[0]! + m[i]![1] * v[1]! + m[i]![2] * v[2]!) as Vec; }
export function fromOrientation(o: readonly number[]): Mat {
  const [x, y, z] = [o[0]! * DEG, o[1]! * DEG, o[2]! * DEG];
  const rx: Mat = [[1, 0, 0], [0, Math.cos(x), -Math.sin(x)], [0, Math.sin(x), Math.cos(x)]];
  const ry: Mat = [[Math.cos(y), 0, Math.sin(y)], [0, 1, 0], [-Math.sin(y), 0, Math.cos(y)]];
  const rz: Mat = [[Math.cos(z), -Math.sin(z), 0], [Math.sin(z), Math.cos(z), 0], [0, 0, 1]];
  return mul(mul(ry, rx), rz);
}
export function toOrientation(m: Mat): Vec {
  const sx = clamp(-m[1][2], -1, 1), x = Math.asin(sx);
  if (Math.abs(sx) > 0.99999) return [r2(x / DEG), r2(Math.atan2(-m[2][0], m[0][0]) / DEG), 0];
  return [r2(x / DEG), r2(Math.atan2(m[0][2], m[2][2]) / DEG), r2(Math.atan2(m[1][0], m[1][1]) / DEG)];
}
/** Rotation by `angle` radians about a unit axis (Rodrigues). */
function axisAngle(axis: readonly number[], angle: number): Mat {
  const [x, y, z] = axis as Vec, c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  return [[t * x * x + c, t * x * y - s * z, t * x * z + s * y], [t * x * y + s * z, t * y * y + c, t * y * z - s * x], [t * x * z - s * y, t * y * z + s * x, t * z * z + c]];
}
/** Orientation of a Cylinder (axis = local X) whose axis points along `dir`. */
function cylinderAlong(dir: readonly number[]): Vec {
  const length = Math.hypot(dir[0]!, dir[1]!, dir[2]!), d = dir.map(v => v / length);
  const upright = fromOrientation([0, 0, 90]); // local X -> world Y
  const axis = [d[2]!, 0, -d[0]!], s = Math.hypot(axis[0]!, axis[2]!); // Y x d
  if (s < 1e-9) return toOrientation(upright);
  return toOrientation(mul(axisAngle(axis.map(v => v / s), Math.acos(clamp(d[1]!, -1, 1))), upright));
}
const vec = (value: unknown): number[] | undefined => Array.isArray(value) ? value as number[]
  : value && typeof value === 'object' && Array.isArray((value as { value?: unknown }).value) ? (value as { value: number[] }).value : undefined;
function rgb(value: unknown): Vec {
  if (typeof value === 'string') { const h = value.replace('#', ''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255) as Vec; }
  return (vec(value) ?? [0.8, 0.78, 0.72]).slice(0, 3) as Vec;
}
/** Brightness/warmth jitter: coherent across channels so weathered stone reads as one material, not confetti. */
function jitter(color: Vec, random: () => number, amount: number): Vec {
  const light = 1 + (random() - 0.5) * 0.18 * amount, warm = (random() - 0.5) * 0.05 * amount;
  return [r3(clamp(color[0] * light + warm, 0, 1)), r3(clamp(color[1] * light, 0, 1)), r3(clamp(color[2] * light - warm, 0, 1))];
}

// ---- part builders in the compact prototype/item form ----
type Props = NonNullable<ProtoPart['props']>;
const part = (name: string, props: Props, className: ProtoPart['className'] = 'Part', tint = true): ProtoPart => ({ name, className, props, tint });
/** Upright cylinder centred at (x, y, z). */
const column = (name: string, x: number, y: number, z: number, height: number, diameter: number, rest: Props): ProtoPart =>
  part(name, { Shape: 'Cylinder', Size: [r2(height), r2(diameter), r2(diameter)], Position: [r2(x), r2(y), r2(z)], Orientation: [0, 0, 90], ...rest });
const ball = (name: string, x: number, y: number, z: number, d: number, rest: Props): ProtoPart =>
  part(name, { Shape: 'Ball', Size: [r2(d), r2(d), r2(d)], Position: [r2(x), r2(y), r2(z)], ...rest });
const block = (name: string, size: number[], at: number[], orientation: number[], rest: Props): ProtoPart =>
  part(name, { Size: size.map(r2) as Vec, Position: at.map(r2) as Vec, Orientation: orientation.map(r2) as Vec, ...rest });

const BARK = '#4a3627', LEAF = { CanCollide: false } as const, SMALL = { CanCollide: false, CastShadow: false } as const;
/** Stylised blockout species used when a kit names one that is not declared; realistic work passes Blender templates instead. */
function builtin(kind: string): Proto | undefined {
  const parts: ProtoPart[] = [];
  const add = (...items: ProtoPart[]) => { parts.push(...items); };
  switch (kind) {
    case 'pine': {
      add({ ...column('Trunk', 0, 3.2, 0, 7.4, 1.5, { Material: 'Wood', Color: BARK }), tint: false },
        { ...column('TrunkTop', 0.08, 9.5, 0.05, 5.4, 0.9, { Material: 'Wood', Color: '#523b2a' }), tint: false });
      [[9.6, 4.6, 0.25, 0.1], [8.2, 6.8, -0.2, 0.2], [6.6, 9, 0.15, -0.2], [4.9, 11.1, -0.1, 0.1], [3.1, 13.1, 0.05, 0.05]].forEach(([d, y, x, z], i) =>
        add(column('Bough' + i, x!, y!, z!, 2.3 - i * 0.22, d!, { Material: 'Grass', Color: i % 2 ? '#2e4f2c' : '#355a31', ...LEAF, Orientation: [i * 4 - 8, i * 37, 90] })));
      add(column('Tip', 0, 14.6, 0, 1.6, 1.2, { Material: 'Grass', Color: '#3a6234', ...SMALL }));
      break;
    }
    case 'oak': {
      add({ ...column('Trunk', 0, 3.6, 0, 8.4, 2.4, { Material: 'Wood', Color: '#4b3828' }), tint: false },
        { ...part('Limb1', { Shape: 'Cylinder', Size: [5.5, 1.1, 1.1], Position: [1.6, 8.6, 0.4], Orientation: cylinderAlong([0.55, 1, 0.12]), Material: 'Wood', Color: '#4b3828' }), tint: false },
        { ...part('Limb2', { Shape: 'Cylinder', Size: [5, 1, 1], Position: [-1.4, 8.8, -0.8], Orientation: cylinderAlong([-0.5, 1, -0.3]), Material: 'Wood', Color: '#4b3828' }), tint: false });
      [[3.2, 11.5, 1, 7.5], [-2.8, 12, -1.8, 7], [0.2, 13.6, 2.4, 6.5], [1.8, 14.2, -2.4, 6], [-1.6, 15, 0.8, 5.5], [0.4, 10.8, -3.4, 5.6]].forEach(([x, y, z, d], i) =>
        add(ball('Crown' + i, x!, y!, z!, d!, { Material: 'Grass', Color: ['#45703a', '#52803f', '#3d6534'][i % 3]!, ...LEAF })));
      break;
    }
    case 'birch': {
      add({ ...column('Trunk', 0, 5.4, 0, 11.6, 0.95, { Material: 'Wood', Color: '#d8d3c6' }), tint: false },
        { ...block('Mark1', [0.35, 0.2, 0.98], [0, 3.1, 0], [0, 25, 0], { Material: 'Wood', Color: '#2f2a26', ...SMALL }), tint: false },
        { ...block('Mark2', [0.3, 0.18, 0.98], [0, 6.7, 0], [0, -40, 0], { Material: 'Wood', Color: '#2f2a26', ...SMALL }), tint: false });
      [[0.8, 11, 0.3, 4.6], [-0.9, 12.4, -0.5, 4], [0.2, 13.8, 0.6, 3.4], [-0.3, 9.8, -0.9, 3.6]].forEach(([x, y, z, d], i) =>
        add(ball('Crown' + i, x!, y!, z!, d!, { Material: 'Grass', Color: ['#7ea04a', '#6f9442', '#8aab55'][i % 3]!, ...LEAF })));
      break;
    }
    case 'bush':
      [[0, 0.9, 0, 2.4], [1.1, 0.75, 0.5, 1.9], [-0.9, 0.8, -0.6, 2], [0.2, 1.5, -0.3, 1.6]].forEach(([x, y, z, d], i) =>
        add(ball('Leaves' + i, x!, y!, z!, d!, { Material: 'Grass', Color: ['#47703a', '#3c6233', '#55803f'][i % 3]!, ...SMALL })));
      break;
    case 'fern':
      for (let i = 0; i < 5; i++) {
        const a = i * 72 + (i % 2) * 17, dx = Math.cos(a * DEG), dz = Math.sin(a * DEG);
        add(block('Frond' + i, [2.2, 0.12, 0.55], [dx * 0.95, 0.42, -dz * 0.95], [0, a, 24], { Material: 'Grass', Color: i % 2 ? '#4f7d39' : '#5b8a3f', ...SMALL }));
      }
      break;
    case 'rock':
      add({ ...block('Boulder', [2.6, 1.6, 2], [0, 0.45, 0], [8, 20, -6], { Material: 'Rock', Color: '#77746c' }), tint: true },
        block('Chip', [1.2, 0.9, 1.1], [1.2, 0.2, 0.6], [-12, 55, 10], { Material: 'Rock', Color: '#6c6a63' }));
      break;
    case 'log':
      add({ ...part('Log', { Shape: 'Cylinder', Size: [6.5, 1.3, 1.3], Position: [0, 0.5, 0], Orientation: [0, 0, 3], Material: 'Wood', Color: '#5a4634' }), tint: false },
        column('Moss', 0.8, 1.08, 0, 2.6, 0.7, { Material: 'Grass', Color: '#4d6b35', Orientation: [0, 0, 0], ...SMALL }));
      break;
    default: return undefined;
  }
  return { parts, weld: false };
}
export const BUILTIN_SPECIES = ['pine', 'oak', 'birch', 'bush', 'fern', 'rock', 'log'] as const;

/** One assets_procedural call for a forest original; its name is also the scene_build template name. */
export interface OriginalVariant { name: string; seed: number; generator: Record<string, string | number> }
/** Original Blender variants per built-in forest species (log: the fallen-log generator; stumps are user templates). */
export const ORIGINAL_VARIANTS: Record<string, { count: number; generator: Record<string, string | number> }> = {
  oak: { count: 3, generator: { kind: 'tree', species: 'oak', height: 6 } }, birch: { count: 2, generator: { kind: 'tree', species: 'birch', height: 7 } },
  pine: { count: 3, generator: { kind: 'tree', species: 'pine', height: 8 } }, bush: { count: 2, generator: { kind: 'foliage', style: 'bush' } },
  fern: { count: 2, generator: { kind: 'foliage', style: 'fern', radius: 0.5, height: 0.4 } }, rock: { count: 3, generator: { kind: 'rock' } },
  log: { count: 2, generator: { kind: 'log', species: 'oak', length: 3, radius: 0.25 } },
};
/**
 * Deterministic assets_procedural plan for a forest kit's species: `<use>-<n>` names, natural finish (the default),
 * seed = kit seed x 100 + n. Placing each user-approved result once and passing it as templates[`<use>-<n>`] makes the
 * kit clone those variants instead of blockouts.
 */
export function forestOriginals(seed: number, uses: readonly string[]): OriginalVariant[] {
  return uses.flatMap(use => {
    const spec = ORIGINAL_VARIANTS[use];
    return spec ? Array.from({ length: spec.count }, (_, i) => ({ name: `${use}-${i + 1}`, seed: (seed * 100 + i + 1) % 2 ** 31, generator: { ...spec.generator } })) : [];
  });
}

/** Copy of a part prototype tilted `degrees` about a horizontal axis at `heading` through its ground origin. */
export function tiltPrototype(proto: Proto, degrees: number, heading: number): Proto {
  const t = axisAngle([Math.cos(heading * DEG), 0, Math.sin(heading * DEG)], degrees * DEG);
  return { ...proto, parts: proto.parts!.map(source => {
    const props = { ...(source.props ?? {}) } as Props & Record<string, unknown>;
    props.Position = apply(t, vec(props.Position) ?? [0, 0, 0]).map(r2) as Vec;
    props.Orientation = toOrientation(mul(t, fromOrientation(vec(props.Orientation) ?? [0, 0, 0])));
    return { ...source, props };
  }) };
}

export function triangles(proto: Proto | undefined): { parts: number; tris: number } {
  if (!proto?.parts) return { parts: 0, tris: 0 };
  return { parts: proto.parts.length, tris: proto.parts.reduce((sum, p) => sum + (p.className === 'Part' ? PRIMITIVE_TRIANGLES[p.props?.Shape ?? 'Block']! : PRIMITIVE_TRIANGLES[p.className] ?? 12), 0) };
}

// ---- plinth ----
interface Built { items: Item[]; report: KitReport }
function plinth(kit: PlinthKit, index: number): Built {
  const random = mulberry32(kit.seed * 7919 + 13), w = kit.weathering, key = kit.key ?? `plinth${index}`;
  const [x0, y0, z0] = kit.at, R = kit.radius, T = kit.tiers, rise = kit.riser;
  const stone = rgb(kit.color ?? '#c8c1b2'), trimColor = jitter(stone.map(v => Math.min(1, v * 1.06)) as Vec, random, 0.3);
  const tread = clamp(R * 0.12, 0.9, 2.5), top = R - (T - 1) * tread;
  if (top < 2) throw new BridgeError('INPUT', `Plinth "${key}": too many tiers for radius ${R}; the top tier would be ${r2(top)} studs.`);
  const parts: ProtoPart[] = [];
  const S = (props: Props) => ({ Material: kit.material, Color: jitter(stone, random, w), ...props });
  // Foundation below grade so uneven terrain never shows a gap under the first step.
  parts.push(column('Foundation', 0, -0.75, 0, 1.5, (R + 0.5) * 2, { Material: 'Slate', Color: jitter([0.42, 0.41, 0.39], random, w) }));
  for (let i = 0; i < T; i++) {
    const r = R - i * tread, bottom = i === 0 ? -0.5 : i * rise, topY = (i + 1) * rise;
    parts.push(column('Step' + (i + 1), 0, (bottom + topY) / 2, 0, topY - bottom, r * 2, S({})));
    // Nosing: a lighter trim lip whose top sits just under the tread, so its ring shows without z-fighting.
    parts.push(column('Trim' + (i + 1), 0, topY - 0.14, 0, 0.22, (r + 0.16) * 2, { Material: kit.trim, Color: jitter(trimColor, random, w * 0.5) }));
  }
  const deck = T * rise + 0.1;
  parts.push(column('InlayRing', 0, T * rise + 0.03, 0, 0.06, top * 1.6, { Material: kit.trim, Color: trimColor }),
    column('Deck', 0, T * rise + 0.05, 0, 0.1, top * 1.44, S({})));
  let surface = deck, spawnRadius = clamp(top * 0.45, 2.5, 8);
  let columnTop: number | undefined;
  if (kit.style !== 'platform') {
    const cr = clamp(R * 0.32, 1.2, 10);
    if (cr * 1.32 + 0.6 > top) throw new BridgeError('INPUT', `Plinth "${key}": the top tier (radius ${r2(top)}) is too small for a column of radius ${r2(cr)}; raise radius or lower tiers/columnRadius.`);
    const H = kit.height, b0 = deck;
    if (kit.column) columnTop = b0 + H; // A template/prototype shaft (e.g. an assets_procedural column) placed below.
    else {
      parts.push(column('BaseTorus', 0, b0 + 0.25, 0, 0.5, cr * 2.64, S({})), column('BaseRing', 0, b0 + 0.72, 0, 0.45, cr * 2.36, S({})),
        column('Scotia', 0, b0 + 1.1, 0, 0.3, cr * 2.12, S({})));
      const s0 = b0 + 1.25, cap = 2.25, s1 = b0 + H - cap, topR = cr * 0.86;
      if (s1 - s0 < 2) throw new BridgeError('INPUT', `Plinth "${key}": height must be at least ${r2(cap + 3.25)} for a column.`);
      const drums = clamp(Math.round((s1 - s0) / 5), 2, 8), step = (s1 - s0) / drums;
      for (let d = 0; d < drums; d++) { // Stone drums taper slightly (entasis); each reads as its own block.
        const mid = (d + 0.5) / drums, rr = cr - (cr - topR) * mid ** 1.3;
        parts.push(column('Drum' + (d + 1), 0, s0 + step * (d + 0.5), 0, step - 0.03, rr * 1.86, S({})));
      }
      for (let f = 0; f < kit.flutes; f++) { // Fillets follow the taper, so the shaft keeps one continuous profile.
        const a = (f / kit.flutes) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a), rb = cr * 0.93, rt = topR * 0.93;
        const p0 = [rb * c, s0, rb * s], p1 = [rt * c, s1, rt * s], len = Math.hypot(p1[0]! - p0[0]!, s1 - s0, p1[2]! - p0[2]!);
        parts.push(part('Flute' + (f + 1), { Shape: 'Cylinder', Size: [r2(len), r2(Math.max(0.12, (2 * Math.PI * cr / kit.flutes) * 0.42)), r2(Math.max(0.12, (2 * Math.PI * cr / kit.flutes) * 0.42))],
          Position: [r2((p0[0]! + p1[0]!) / 2), r2((s0 + s1) / 2), r2((p0[2]! + p1[2]!) / 2)], Orientation: cylinderAlong([p1[0]! - p0[0]!, s1 - s0, p1[2]! - p0[2]!]),
          Material: kit.material, Color: jitter(stone, random, w * 0.4) }));
      }
      spawnRadius = clamp(cr * 1.25, 2.5, 8);
      const abacus = Math.max(cr * 1.55, spawnRadius + 0.6);
      parts.push(column('Necking', 0, s1 + 0.175, 0, 0.35, topR * 2.16, { Material: kit.trim, Color: trimColor }),
        column('Echinus', 0, s1 + 0.625, 0, 0.55, topR * 2.44, S({})), column('EchinusLip', 0, s1 + 1.125, 0, 0.45, topR * 2.76, S({})),
        column('Abacus', 0, s1 + 1.8, 0, 0.9, abacus * 2, S({})), column('AbacusTrim', 0, s1 + 2.11, 0, 0.22, (abacus + 0.12) * 2, { Material: kit.trim, Color: trimColor }));
      columnTop = b0 + H;
    }
    surface = columnTop;
  }
  // Weathering: moss in the step corners and on the ground, plus a few fallen fragments around the base.
  const mossCount = Math.round(w * 8), fragments = Math.round(w * 5);
  for (let m = 0; m < mossCount; m++) {
    const tier = Math.floor(random() * (T + 1)), outer = tier === 0 ? R + 1.6 : R - (tier - 1) * tread, inner = tier === 0 ? R + 0.2 : outer - tread * 0.6;
    const a = random() * Math.PI * 2, rr = inner + random() * Math.max(0.1, outer - inner - 0.3), d = Math.min(0.7 + random() * 1.4, tier === 0 ? 2.1 : tread * 0.8);
    parts.push(column('Moss' + (m + 1), rr * Math.cos(a), (tier === 0 ? 0 : tier * rise) + 0.05, rr * Math.sin(a), 0.1, d, { Material: 'Grass', Color: jitter([0.3, 0.42, 0.21], random, 1), ...SMALL }));
  }
  for (let f = 0; f < fragments; f++) {
    const a = random() * Math.PI * 2, rr = R + 1 + random() * 3.5, s = 0.5 + random() * 1.1;
    parts.push(block('Fragment' + (f + 1), [s * 1.3, s * 0.8, s], [rr * Math.cos(a), s * 0.22, rr * Math.sin(a)], [random() * 30 - 15, random() * 360 - 180, random() * 30 - 15],
      { Material: kit.material, Color: jitter(stone.map(v => v * 0.85) as Vec, random, w) }));
  }
  const items: Item[] = [{ key, className: 'Model', name: kit.name ?? 'Plinth', ...(kit.in ? { in: kit.in } : {}) }];
  for (const p of parts) {
    const at = vec(p.props!.Position)!;
    items.push({ name: p.name, className: p.className, in: key, props: { ...p.props, Position: [r2(x0 + at[0]!), r2(y0 + at[1]!), r2(z0 + at[2]!)] } });
  }
  if (kit.column && kit.style !== 'platform') items.push({ name: 'Column', in: key, use: kit.column, at: [x0, r2(y0 + deck), z0], yaw: 0, scale: 1 });
  const report: KitReport = { kind: 'plinth', key, parts: parts.length, triangles: parts.reduce((sum, p) => sum + triangles({ parts: [p], weld: false }).tris, 0), top: r2(y0 + surface) };
  if (kit.spawn) {
    const sy = y0 + surface + 0.5;
    items.push({ key: key + '-spawn', name: 'SpawnLocation', className: 'SpawnLocation', in: key, props: { Shape: 'Cylinder', Size: [1, r2(spawnRadius * 2), r2(spawnRadius * 2)],
      Position: [r2(x0), r2(sy), r2(z0)], Orientation: [0, 0, 90], Material: kit.trim, Color: trimColor } });
    report.parts++; report.triangles += PRIMITIVE_TRIANGLES.Cylinder!;
    report.spawn = { at: [r2(x0), r2(sy), r2(z0)], top: r2(sy + 0.5) };
  }
  if (kit.life) items.push(...ambientLife(kit, key, report));
  return { items, report };
}

/** Optional plinth ambience (`life`), budgeted for phones: clearing dust motes (vfx Dust motes preset, Rate x max Lifetime <= 100),
 * a soft unshadowed rune light in the spawn, dusk fireflies (<= 40 live) and SoundGroup/Sound hooks without SoundIds: no
 * verified built-in wind or bird audio exists, so the user or studio_asset_search (Audio) supplies the ids. */
function ambientLife(kit: PlinthKit, key: string, report: KitReport): Item[] {
  const [x0, y0, z0] = kit.at, R = kit.radius, dusk = kit.life === 'dusk', motes = r2((R + 6) * 2);
  const hidden = { Transparency: 1, CanCollide: false, CastShadow: false } as const;
  const rate = clamp(Math.round(4 * motes * motes / 100), 2, 10);
  const items: Item[] = [
    { key: key + '-motes', name: 'MoteVolume', className: 'Part', in: key, props: { Size: [motes, 8, motes], Position: [r2(x0), r2(y0 + 4.5), r2(z0)], ...hidden } },
    { name: 'DustMotes', className: 'ParticleEmitter', in: key + '-motes', fx: { Texture: 'rbxasset://textures/particles/sparkles_main.dds', Rate: rate, Lifetime: [6, 10],
      Speed: [0.1, 0.3], SpreadAngle: [180, 180], Size: 0.1, Transparency: [[0, 1], [0.3, 0.5], [0.7, 0.5], [1, 1]], Color: '#fff3d6', Shape: 'Box', ShapeStyle: 'Volume',
      LightEmission: dusk ? 0.2 : 0.4, LightInfluence: 1, Drag: 0.6, Rotation: [0, 360], RotSpeed: [-15, 15] } },
  ];
  let particles = rate * 10, instances = 2;
  if (kit.spawn) {
    items.push({ name: 'RuneLight', className: 'PointLight', in: key + '-spawn', fx: { Color: '#a8d8ff', Brightness: dusk ? 1.2 : 0.5, Range: clamp(R * 0.8, 6, 12), Shadows: false } });
    instances++;
  }
  if (dusk) {
    const span = r2((R + 30) * 2);
    items.push({ key: key + '-fireflies', name: 'FireflyVolume', className: 'Part', in: key, props: { Size: [span, 5, span], Position: [r2(x0), r2(y0 + 4.5), r2(z0)], ...hidden } },
      { name: 'Fireflies', className: 'ParticleEmitter', in: key + '-fireflies', fx: { Texture: 'rbxasset://textures/particles/sparkles_main.dds', Rate: 4, Lifetime: [6, 9],
        Speed: [0.3, 0.8], SpreadAngle: [180, 180], Size: [[0, 0.1], [0.5, 0.22], [1, 0.1]], Transparency: [[0, 1], [0.2, 0], [0.4, 0.6], [0.6, 0], [0.8, 0.5], [1, 1]],
        Color: '#d8ff6a', Shape: 'Box', ShapeStyle: 'Volume', LightEmission: 1, LightInfluence: 0, Drag: 1 } });
    particles += 4 * 9; instances += 2;
  }
  const ambience = key + '-ambience', layer = dusk ? 'Crickets' : 'Birds';
  items.push({ key: ambience, name: 'Ambience', className: 'SoundGroup', in: key, fx: { Volume: 0.6 } },
    { name: 'Wind', className: 'Sound', in: key, fx: { Volume: 0.25, Looped: true, Playing: false, SoundGroup: ambience } },
    { name: layer, className: 'Sound', in: key + '-motes', fx: { Volume: dusk ? 0.3 : 0.35, Looped: true, Playing: false, RollOffMode: 'InverseTapered',
      RollOffMinDistance: 15, RollOffMaxDistance: 120, SoundGroup: ambience } });
  report.parts += dusk ? 2 : 1;
  report.life = { instances: instances + 3, particles, sounds: ['Wind', layer] };
  return items;
}

// ---- forest ----
const DEFAULT_SPECIES: Layer[] = [{ use: 'pine', share: 5, spacing: 9, footprint: 4.5 }, { use: 'oak', share: 3, spacing: 13, footprint: 6 }, { use: 'birch', share: 2, spacing: 7, footprint: 2.5 }];
const DEFAULT_COVER: Layer[] = [{ use: 'bush', share: 4, spacing: 3.2 }, { use: 'fern', share: 4, spacing: 2.4 }, { use: 'rock', share: 2, spacing: 3.6 }, { use: 'log', share: 1, spacing: 7 }];
/** Largest-remainder split of `total` by share. */
function split(total: number, layers: Layer[]): number[] {
  const sum = layers.reduce((s, l) => s + (l.share ?? 1), 0), raw = layers.map(l => total * (l.share ?? 1) / sum), out = raw.map(Math.floor);
  let rest = total - out.reduce((a, b) => a + b, 0);
  for (const i of raw.map((v, i) => [v - Math.floor(v), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]).map(([, i]) => i)) { if (rest-- <= 0) break; out[i]!++; }
  return out;
}

/**
 * Expands every kit into ordinary prototypes, items and scatter specs (plus tilt variants for any tilted scatter).
 * Returns the expanded input and per-kit plans; the caller compiles and fills in placement counts.
 */
export function expandKits(input: SceneBuildInput): { input: SceneBuildInput; plans: KitPlan[] } {
  const prototypes = { ...(input.prototypes ?? {}) }, templates = input.templates ?? {};
  const items = [...input.items], scatter = [...input.scatter], plans: KitPlan[] = [];
  const declared = (use: string) => use in prototypes || use in templates, blockout = new Set<string>();
  const ensure = (use: string) => {
    if (declared(use)) return;
    const proto = builtin(use);
    if (!proto) throw new BridgeError('INPUT', `Unknown prototype or template "${use}". Declare it, or use a built-in species: ${BUILTIN_SPECIES.join(', ')}.`);
    prototypes[use] = proto; blockout.add(use);
  };
  const kits = input.kits ?? [];
  const plinths = kits.flatMap((kit, i) => kit.kind === 'plinth' ? [resolvePlinth(kit, kit.key ?? `plinth${i}`)] : []);
  for (const [index, raw] of kits.entries()) {
    const start = items.length;
    if (raw.kind === 'plinth') {
      const kit = resolvePlinth(raw, raw.key ?? `plinth${index}`);
      if (kit.column) ensure(kit.column);
      const built = plinth(kit, index);
      items.push(...built.items);
      plans.push({ report: built.report, items: [start, items.length], scatter: [], tris: new Map() });
      continue;
    }
    const key = raw.key ?? `forest${index}`;
    only(raw, key, PLINTH_ONLY);
    if (raw.radius === undefined || raw.radius < 16) throw new BridgeError('INPUT', `Forest "${key}" needs radius 16..2048.`);
    const trees = raw.trees ?? 80;
    const kit = { ...raw, radius: raw.radius, center: raw.at as Vec, trees, undergrowth: raw.undergrowth ?? trees * 2, edge: raw.radius * 0.2, ground: true }, seed = kit.seed;
    const tris = new Map<string, number>(), originals: Record<string, string[]> = {}, blockouts = new Set<string>();
    /** A declared use is placed as is; otherwise its `<use>-<n>` template variants (Blender originals); otherwise a blockout. */
    const resolve = (use: string): string[] => {
      if (declared(use) && !blockout.has(use)) return [use];
      const variants = Object.keys(templates).map(name => [name, /^(.+)-(\d{1,3})$/.exec(name)] as const)
        .filter(([, m]) => m?.[1] === use).sort((a, b) => Number(a[1]![2]) - Number(b[1]![2])).map(([name]) => name).slice(0, 16);
      if (variants.length) return originals[use] = variants;
      ensure(use); blockouts.add(use); return [use];
    };
    items.push({ key, className: 'Model', name: kit.name ?? 'Forest', ...(kit.in ? { in: kit.in } : {}) },
      { key: key + '-trees', className: 'Model', name: 'Trees', in: key }, { key: key + '-cover', className: 'Model', name: 'Undergrowth', in: key });
    // Landmarks reserve their footprint; with no explicit clearing the first plinth defines one with a soft ramp.
    const first = plinths[0];
    const clearing = kit.clearing ?? (first ? { center: [first.at[0], first.at[2]] as [number, number], inner: first.radius + 8, outer: first.radius + 30 } : undefined);
    const avoid = plinths.map(p => ({ at: [p.at[0]!, p.at[2]!] as [number, number], radius: p.radius + 2 })).slice(0, 32);
    const tint = { min: [0.86, 0.9, 0.85] as Vec, max: [1.08, 1.1, 1.04] as Vec };
    const edge = kit.edge;
    const layer = (l: Layer, count: number, group: string, i: number, under: boolean): Scatter => {
      const uses = resolve(l.use);
      // Recipe originals default to their generator's assets_procedural budget (a 16k-triangle tree, not the 8k guess).
      const kind = originals[l.use] ? ORIGINAL_VARIANTS[l.use]?.generator.kind as keyof typeof PROCEDURAL_LIMITS.defaultTriangles | undefined : undefined;
      const each = l.tris ?? (kind ? PROCEDURAL_LIMITS.defaultTriangles[kind] : undefined);
      if (each !== undefined) for (const use of uses) tris.set(use, each);
      return { use: uses.length === 1 ? uses[0]! : uses, in: group, count, center: kit.center, radius: kit.radius, minSpacing: l.spacing,
        // Each species gets its own grove centres (own seed), so species zone naturally instead of mixing uniformly.
        ...(under ? { hug: 0.75 } : { clusters: Math.max(2, Math.round(kit.radius / 45)) }),
        ...(clearing ? { clearing: under ? { center: clearing.center, inner: clearing.inner * 0.85, outer: clearing.inner + (clearing.outer - clearing.inner) * 0.6 } : clearing } : {}),
        ...(avoid.length ? { avoid } : {}), ...(kit.paths ? { avoidPaths: kit.paths } : {}),
        footprintRadius: l.footprint ?? l.spacing * (under ? 0.3 : 0.4), edge, scale: under ? [0.6, 1.4] : [0.72, 1.3],
        tint, seed: (seed * 1009 + i * 97 + (under ? 53 : 0)) % 2 ** 31, ground: kit.ground, tilt: under ? 0 : 4 };
    };
    const species = kit.species ?? DEFAULT_SPECIES, cover = kit.cover ?? DEFAULT_COVER;
    const treeLayers = split(kit.trees, species).map((count, i) => ({ l: species[i]!, count, i })).filter(s => s.count > 0)
      .sort((a, b) => b.l.spacing - a.l.spacing || a.i - b.i); // big crowns first, smaller species fill the gaps
    const under = split(kit.undergrowth, cover).map((count, i) => ({ l: cover[i]!, count, i })).filter(s => s.count > 0)
      .sort((a, b) => b.l.spacing - a.l.spacing || a.i - b.i);
    const indices: number[] = [];
    for (const t of treeLayers) { indices.push(scatter.length); scatter.push(layer(t.l, t.count, key + '-trees', t.i, false)); }
    for (const u of under) { indices.push(scatter.length); scatter.push(layer(u.l, u.count, key + '-cover', u.i, true)); }
    const report: KitReport = { kind: 'forest', key, parts: 0, triangles: 0, placed: 0, requested: treeLayers.reduce((s, t) => s + t.count, 0) + under.reduce((s, u) => s + u.count, 0) };
    if (Object.keys(originals).length) report.originals = originals;
    if (blockouts.size) {
      const fallback = [...blockouts], recipe = forestOriginals(seed, fallback);
      report.blockouts = fallback;
      report.note = `Blockout primitives for ${fallback.join(', ')}: no <use>-<n> Blender original templates were passed. ` + (recipe.length
        ? 'If assets_procedural is available: run recipe, the user approves each preview, place one copy each in a hidden template Folder, rebuild with templates. Otherwise tell the user the forest is a blockout.'
        : 'Tell the user these layers are blockouts.');
      if (recipe.length) report.recipe = recipe;
    }
    plans.push({ report, items: [start, items.length], scatter: indices, tris });
  }
  // Tilt: a few pre-tilted copies per part prototype (the wire placement only carries yaw), chosen per point like any variant.
  const tilted = scatter.filter(s => (s.tilt ?? 0) > 0);
  const tiltUses = [...new Set(tilted.flatMap(s => Array.isArray(s.use) ? s.use : [s.use]).filter(use => prototypes[use]?.parts))];
  const room = SCENE_BUILD_LIMITS.prototypes - Object.keys(prototypes).length;
  const variants = tiltUses.length ? clamp(Math.floor(room / tiltUses.length), 0, 3) : 0;
  const out = scatter.map((spec, si) => {
    if (!(spec.tilt ?? 0) || !variants) return spec;
    const random = mulberry32(spec.seed * 31 + si), uses: string[] = [];
    for (const use of Array.isArray(spec.use) ? spec.use : [spec.use]) {
      uses.push(use);
      if (!prototypes[use]?.parts) continue;
      for (let v = 1; v <= variants; v++) {
        const name = `${use}~${spec.tilt}~${v}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
        prototypes[name] ??= tiltPrototype(prototypes[use]!, spec.tilt! * (0.45 + 0.55 * v / variants), random() * 360);
        uses.push(name);
      }
    }
    return { ...spec, use: uses };
  });
  if (!kits.length && !tilted.length) return { input, plans };
  return { input: { ...input, prototypes, items, scatter: out }, plans };
}
