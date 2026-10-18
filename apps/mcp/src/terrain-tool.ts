import { z } from 'zod';
import type { Json } from '../../../packages/protocol/src/studio.js';
import { TERRAIN_LIMITS as L } from '../../../packages/protocol/src/studio.js';
import { TERRAIN_SURFACE_MATERIALS, TERRAIN_NOISE_TYPES } from '../../../packages/core/src/terrain-policy.js';

/** terrain_generate: one seeded procedural heightfield written to Workspace.Terrain (plugin method terrain.generate). */
export const TERRAIN_TOOL = 'terrain_generate';
const n = (low: number, high: number) => z.number().min(low).max(high);
const xz = z.tuple([n(-L.coordinate, L.coordinate), n(-L.coordinate, L.coordinate)]);
const material = z.enum(TERRAIN_SURFACE_MATERIALS);
const level = n(0, L.height);

const bump = z.strictObject({ kind: z.enum(['hill', 'mountain', 'valley', 'crater']), center: xz, radius: n(4, L.extent),
  height: level.describe('Rise, or depth for valley/crater.'), roughness: n(0, 1).optional().describe('Mountain ridge detail.') });
const pad = z.strictObject({ kind: z.enum(['plateau', 'flatten']), center: xz, radius: n(4, L.extent),
  level: level.optional().describe('Flat surface above floor; flatten defaults to ground at center.'),
  blend: n(0, 512).optional().describe('Soft edge studs.'), material: material.optional() });
const lake = z.strictObject({ kind: z.literal('lake'), center: xz, radius: n(8, 1024), level: level.describe('Water surface above floor.'),
  depth: n(1, 256).optional(), material: material.optional().describe('Bed (default Mud).') });
const line = z.strictObject({ kind: z.enum(['river', 'path']), points: z.array(xz).min(2).max(L.points), width: n(2, 256),
  depth: n(0, 64).optional().describe('Carve below centreline ground (river 8, path 0.5).'), bank: n(0, 256).optional().describe('Side slope studs (default width).'),
  material: material.optional().describe('Bed/surface (river Pebble, path Ground).') });
const rule = z.strictObject({ material, minHeight: level.optional(), maxHeight: level.optional(), minSlope: n(0, 90).optional(), maxSlope: n(0, 90).optional(),
  minNoise: n(-1, 1).optional(), maxNoise: n(-1, 1).optional(), nearWater: n(0, 64).optional().describe('Within studs of water.') });

export const terrainShape = {
  center: xz.describe('Region centre [x,z].'),
  size: z.tuple([n(L.minExtent, L.extent), n(L.minExtent, L.extent)]).describe('[width,depth] studs.'),
  floor: n(-L.floor, L.floor).default(0).describe('World Y of region bottom.'),
  height: n(L.minHeight, L.height).default(256).describe('Region height cap above floor.'),
  baseHeight: level.default(32).describe('Ground level above floor.'),
  seed: z.number().int().min(0).max(2147483647).default(1),
  noise: z.strictObject({ type: z.enum(TERRAIN_NOISE_TYPES).default('fbm'), octaves: z.number().int().min(1).max(L.octaves).default(5),
    frequency: n(0.1, 100).default(4).describe('Cycles per 1000 studs.'), amplitude: level.default(24), persistence: n(0.2, 0.8).optional() }).optional(),
  edge: n(0, 1024).optional().describe('Fade noise to baseHeight near the border.'),
  snowLine: level.optional().describe('Default rules: Snow above this height.'),
  features: z.array(z.union([bump, pad, lake, line])).max(L.features).optional().describe('Applied in order.'),
  materials: z.strictObject({ rules: z.array(rule).max(L.rules).optional().describe('First match wins; replaces defaults.'),
    fallback: material.optional().describe('Default Grass.'), deep: material.optional().describe('Below 12 studs, cliffs (default Rock).') }).optional(),
};

export const TERRAIN_DESCRIPTION = `Write: generate natural terrain in one undo step. Replaces all Terrain in the region box (snapped to the 4-stud grid; ≤${L.extent}x${L.extent} studs, height cap ${L.height}) with a seeded fBm/ridged heightfield plus ordered features: hill, mountain, valley, crater, plateau, flatten (clearing for a focal build), lake (water level), river/path (polyline carve, width, depth, material). Heights are studs above floor. Default materials: Sand at shores, Mud near water, Rock/Slate on steep slopes, Ground on mid slopes, Grass/LeafyGrass elsewhere, Snow above snowLine; materials.rules (height, slope, noise -1..1, nearWater) replace them. Same seed = same terrain. Written in chunks with yields. Revert with Studio Undo (receipt_restore is refused). Workspace grant; never auto-retry.`;

/** Drops undefined keys; the daemon and plugin validate the same wire fields. */
export function compileTerrain(input: Record<string, unknown>): Record<string, Json> {
  return JSON.parse(JSON.stringify(input)) as Record<string, Json>;
}
