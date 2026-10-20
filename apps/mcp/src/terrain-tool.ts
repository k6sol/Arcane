import { z } from 'zod';
import type { Json } from '../../../packages/protocol/src/studio.js';
import { TERRAIN_LIMITS as L } from '../../../packages/protocol/src/studio.js';
import { TERRAIN_SURFACE_MATERIALS, TERRAIN_NOISE_TYPES } from '../../../packages/core/src/terrain-policy.js';
import { BridgeError } from './daemon-client.js';
import { planCaves, type CaveInput, type CaveReport } from './terrain-caves.js';

/** terrain_generate: one seeded procedural heightfield written to Workspace.Terrain (plugin method terrain.generate). */
export const TERRAIN_TOOL = 'terrain_generate';
const n = (low: number, high: number) => z.number().min(low).max(high);
const coord = n(-L.coordinate, L.coordinate);
const xz = z.tuple([coord, coord]);
const material = z.enum(TERRAIN_SURFACE_MATERIALS);
const level = n(0, L.height);

// Field meanings live in the arcane-natural-scenes:scene-build skill reference; the advertised schema keeps types and limits.
const bump = z.strictObject({ kind: z.enum(['hill', 'mountain', 'valley', 'crater']), center: xz, radius: n(4, L.extent), height: level, roughness: n(0, 1).optional() });
const pad = z.strictObject({ kind: z.enum(['plateau', 'flatten']), center: xz, radius: n(4, L.extent), level: level.optional(),
  blend: n(0, 512).optional(), material: material.optional(), base: n(1, 512).optional() });
const lake = z.strictObject({ kind: z.literal('lake'), center: xz, radius: n(8, 1024), level, depth: n(1, 256).optional(), material: material.optional() });
const line = z.strictObject({ kind: z.enum(['river', 'path']), points: z.array(xz).min(2).max(L.points), width: n(2, 256),
  depth: n(0, 64).optional(), bank: n(0, 256).optional(), material: material.optional() });
const rule = z.strictObject({ material, minHeight: level.optional(), maxHeight: level.optional(), minSlope: n(0, 90).optional(), maxSlope: n(0, 90).optional(),
  minNoise: n(-1, 1).optional(), maxNoise: n(-1, 1).optional(), nearWater: n(0, 64).optional() });

const cave = z.strictObject({ at: xz, radius: n(32, 512).default(90), rise: level.default(56), entrances: z.number().int().min(1).max(4).default(2),
  chambers: z.number().int().min(0).max(4).default(2), tunnel: n(4, 14).default(6), floor: material.default('Slate'),
  avoid: z.array(z.tuple([coord, coord, coord])).max(8).optional() });

export const terrainShape = {
  center: xz,
  size: z.tuple([n(L.minExtent, L.extent), n(L.minExtent, L.extent)]),
  floor: n(-L.floor, L.floor).default(0),
  height: n(L.minHeight, L.height).default(256),
  baseHeight: level.default(32),
  seed: z.number().int().min(0).max(2147483647).default(1),
  noise: z.strictObject({ type: z.enum(TERRAIN_NOISE_TYPES).default('fbm'), octaves: z.number().int().min(1).max(L.octaves).default(5),
    frequency: n(0.1, 100).default(4), amplitude: level.default(24), persistence: n(0.2, 0.8).optional() }).optional(),
  edge: n(0, 1024).optional(),
  snowLine: level.optional(),
  features: z.array(z.union([bump, pad, lake, line])).max(L.features).optional(),
  materials: z.strictObject({ rules: z.array(rule).max(L.rules).optional(),
    fallback: material.optional(), deep: material.optional() }).optional(),
  caves: cave.optional(),
};

export const TERRAIN_DESCRIPTION = `Write: natural terrain in one undo step. Replaces all Terrain in the region box (4-stud grid; ≤${L.extent}x${L.extent} studs, height cap ${L.height}) with a seeded fBm/ridged heightfield plus ordered features: hill, mountain, valley, crater, plateau, flatten (clearing for a focal build; base adds ground-blend rings), lake, river/path (polyline carve); caves (terrain.caves plugin) carve tunnels with hillside mouths and chambers into a rock outcrop, never under pads or keep-outs; result.caves lists mouths, chambers and scene_build fixtures. Points are [x,z]; heights are studs above floor (world Y). Default materials follow height, slope and water (Snow above snowLine); materials.rules (first match wins) replace them. Fields: skills_get arcane-natural-scenes:scene-build. Same seed = same terrain. Revert with Studio Undo (receipt_restore is refused). Workspace grant; never auto-retry.`;

/**
 * Drops undefined keys and expands a pad's `base` into ground-blend rings (later features override earlier materials):
 * the pad's own surface (LeafyGrass), then Ground, Mud and Rock towards the landmark footprint. Rings at a known level
 * are plateaus, whose noisy outlines avoid hard circles. The daemon and plugin validate the same wire fields.
 */
export function compileTerrain(input: Record<string, unknown>): Record<string, Json> { return compileTerrainPlan(input).args; }
/** compileTerrain plus the cave report (mouths, chambers, fixtures) returned with the terrain_generate result. */
export function compileTerrainPlan(input: Record<string, unknown>): { args: Record<string, Json>; caves?: CaveReport } {
  const { caves: caveInput, ...rest } = JSON.parse(JSON.stringify(input)) as Record<string, Json> & { caves?: CaveInput };
  const out = rings(rest);
  if (!caveInput) return { args: out };
  const plan = planCaves(caveInput, out as never);
  if (plan.outcrop) out.features = [plan.outcrop, ...((out.features as Json[] | undefined) ?? [])] as Json;
  if (((out.features as Json[] | undefined)?.length ?? 0) > L.features) throw new BridgeError('INPUT', `The cave outcrop needs one more feature slot (max ${L.features}).`);
  out.caves = plan.caves;
  return { args: out, caves: plan.report };
}
function rings(out: Record<string, Json> & { features?: Record<string, Json>[] }): Record<string, Json> {
  if (!out.features?.some(feature => feature.base !== undefined)) return out;
  out.features = out.features.flatMap(feature => {
    if (feature.base === undefined) return [feature];
    const { base, ...pad } = feature as Record<string, Json> & { base: number; radius: number; level?: number; kind: string; center: Json };
    const rings: Record<string, Json>[] = [{ ...pad, material: pad.material ?? 'LeafyGrass' }];
    let last = pad.radius;
    for (const [material, radius] of [['Ground', base + (pad.radius - base) * 0.55], ['Mud', base + 4], ['Rock', base + 1.5]] as const) {
      if (radius < 4 || radius > last - 1) continue;
      last = radius;
      rings.push(pad.level === undefined ? { kind: 'flatten', center: pad.center, radius: Number(radius.toFixed(2)), blend: 2, material }
        : { kind: 'plateau', center: pad.center, radius: Number(radius.toFixed(2)), level: pad.level, blend: 2, material });
    }
    return rings;
  });
  if (out.features.length > L.features) throw new BridgeError('INPUT', `Ground rings expand features to ${out.features.length} (max ${L.features}); drop a feature or a base.`);
  return out;
}
