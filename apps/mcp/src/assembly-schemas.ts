import { z } from 'zod';
import { RECIPE_LIMITS } from '../../../packages/asset-pipeline/src/recipe.js';
import type { AssemblyEvidence, SocketEvidence, MaterialEvidence } from '../../../packages/asset-pipeline/src/types.js';
import { boundedText } from './schemas.js';

export const assetSlug = z.string().min(1).max(48).regex(/^[a-z][a-z0-9-]*$/)
  .refine(value => !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:-|$)/i.test(value), 'Use a safe lowercase asset slug.');
export function boundedVector(min: number, max: number) {
  const channel = z.number().finite().min(min).max(max);
  return z.tuple([channel, channel, channel]);
}
const segments = z.number().int().min(8).max(64).multipleOf(4).optional();
const rotation = boundedVector(-360, 360).optional();
export const assemblyRecipe = z.strictObject({
  schemaVersion: z.literal(1),
  materials: z.array(z.strictObject({
    id: assetSlug, color: boundedVector(0, 1), metallic: z.number().min(0).max(1).optional(), roughness: z.number().min(0).max(1).optional(),
    emission: z.strictObject({ color: boundedVector(0, 1), strength: z.number().min(0).max(10) }).optional(),
    surface: z.strictObject({ profile: z.enum(['bark', 'stone', 'leaf', 'weathered']), resolution: z.union([z.literal(128), z.literal(256), z.literal(512)]).optional() }).optional(),
  })).min(1).max(RECIPE_LIMITS.materials),
  parts: z.array(z.strictObject({
    name: assetSlug, role: z.enum(['render', 'collision', 'lod1']),
    geometry: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('box') }),
      z.strictObject({ kind: z.literal('cylinder'), segments }),
      z.strictObject({ kind: z.literal('cone'), segments }),
      z.strictObject({ kind: z.literal('sphere'), segments, rings: z.number().int().min(4).max(32).optional() }),
      z.strictObject({ kind: z.literal('mesh'), vertices: z.array(boundedVector(-0.5, 0.5)).min(4).max(RECIPE_LIMITS.meshVertices),
        indices: z.array(z.number().int().min(0).max(RECIPE_LIMITS.meshVertices - 1)).min(12).max(RECIPE_LIMITS.meshTriangles * 3) }),
    ]),
    dimensions: boundedVector(0.01, 20), position: boundedVector(-40, 40), rotationDegrees: rotation,
    material: assetSlug.optional(), bevel: z.strictObject({ width: z.number().min(0.00001).max(2), segments: z.number().int().min(1).max(3).optional() }).optional(),
  })).min(2).max(RECIPE_LIMITS.parts),
  sockets: z.array(z.strictObject({ name: assetSlug, kind: z.enum(['socket', 'attachment']), part: assetSlug,
    position: boundedVector(-20, 20), rotationDegrees: rotation })).max(RECIPE_LIMITS.sockets).optional(),
  collisionTriangleBudget: z.number().int().min(12).max(RECIPE_LIMITS.collisionTriangles).optional(),
  lodTriangleBudget: z.number().int().min(12).max(RECIPE_LIMITS.triangles).optional(),
}).describe('Bounded JSON assembly data. Shared preflight additionally checks closed outward-wound topology, IDs/materials, role budgets, floor bounds and socket transforms. No code, files or URLs.');

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const geometryBounds = z.strictObject({ min: boundedVector(-60, 60), max: boundedVector(-60, 60) })
  .refine(value => value.max.every((channel, index) => channel > value.min[index]!), 'Bounds must have positive extent.');
export const socketEvidence: z.ZodType<SocketEvidence> = z.strictObject({
  name: assetSlug, kind: z.enum(['socket', 'attachment']), part: assetSlug,
  nodeName: boundedText(96), matrix: z.array(z.number().finite()).length(16),
});
export const materialEvidence: z.ZodType<MaterialEvidence> = z.strictObject({
  name: boundedText(256), color: boundedVector(0, 1), metallic: z.number().min(0).max(1), roughness: z.number().min(0).max(1),
  emission: z.strictObject({ color: boundedVector(0, 1), strength: z.number().min(0).max(10) }),
  surface: z.strictObject({ profile: z.enum(['bark', 'stone', 'leaf', 'weathered']), resolution: z.union([z.literal(128), z.literal(256), z.literal(512)]),
    generator: z.literal('arcane-tile-v1'), texCoord: z.literal(0), images: z.array(z.strictObject({ role: z.enum(['baseColor', 'normal', 'metallicRoughness']),
      name: boundedText(128), width: z.number().int().min(128).max(512), height: z.number().int().min(128).max(512), sha256: hash, colorSpace: z.enum(['sRGB', 'Non-Color']) })).length(3) }).optional(),
}).transform(({surface,...value})=>({...value,...(surface===undefined?{}:{surface})}));
export const assemblyEvidence: z.ZodType<AssemblyEvidence> = z.strictObject({
  recipeSha256: hash,
  estimatedTriangles: z.strictObject({ render: z.number().int().min(0).max(RECIPE_LIMITS.triangles),
    collision: z.number().int().min(0).max(RECIPE_LIMITS.collisionTriangles), lod1: z.number().int().min(0).max(RECIPE_LIMITS.triangles) }),
  bounds: geometryBounds, sockets: z.array(socketEvidence).max(RECIPE_LIMITS.sockets),
  artisticFidelity: z.literal('unverified'), robloxImport: z.literal('unverified'),
});
