import { z } from 'zod';
import type { AssetInput, AssetProbe, AssetManifest } from '../../../packages/asset-pipeline/src/types.js';
import { id, boundedText } from './schemas.js';
import type { AssetJobRecord } from '../../daemon/src/asset-service.js';

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const finite = z.number().finite();
const vector = z.tuple([finite, finite, finite]);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().max(8192);
const path = boundedText(4096);
const artifactName = id.max(96).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/).refine(value => !value.includes('..'));
const runtime = z.object({ executable: path, version: id, pythonVersion: id, background: z.boolean(),
  capabilities: z.object({ glbExport: z.boolean(), glbImport: z.boolean(), fbxExport: z.boolean(), fbxImport: z.boolean(), cycles: z.boolean() }) });

// Mirrors the bundled pipeline's normalized AssetInput, never host process configuration.
export const assetInput = z.strictObject({
  template: z.enum(['hero-prop', 'environment-kit']),
  name: z.string().min(1).max(48).regex(/^[a-z][a-z0-9-]*$/)
    .refine(value => !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:-|$)/i.test(value), 'Use a safe asset slug.'),
  seed: z.number().int().min(0).max(2147483647).optional(),
  sizeMeters: z.tuple([z.number().min(0.1).max(20), z.number().min(0.1).max(20), z.number().min(0.1).max(20)]).optional(),
  color: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)]).optional(),
  triangleBudget: z.number().int().min(100).max(50000).optional(),
  renderResolution: z.number().int().min(128).max(1024).optional(), renderSamples: z.number().int().min(4).max(64).optional(),
});
export type SafeAssetInput = z.output<typeof assetInput>;
// Keep the boundary structurally compatible when pipeline types change.
export function safeAssetInput(input: SafeAssetInput): AssetInput {
  return { template: input.template, name: input.name,
    ...(input.seed === undefined ? {} : { seed: input.seed }),
    ...(input.sizeMeters === undefined ? {} : { sizeMeters: input.sizeMeters }),
    ...(input.color === undefined ? {} : { color: input.color }),
    ...(input.triangleBudget === undefined ? {} : { triangleBudget: input.triangleBudget }),
    ...(input.renderResolution === undefined ? {} : { renderResolution: input.renderResolution }),
    ...(input.renderSamples === undefined ? {} : { renderSamples: input.renderSamples }) };
}
const request = assetInput.required().extend({ schemaVersion: z.literal(1) });
export const assetProbe: z.ZodType<AssetProbe> = z.object({ observedAt: id, available: z.boolean(), blender: runtime.nullable(),
  python: z.object({ executable: path, version: id }).nullable(), attempts: z.array(z.object({ executable: path, code: id.max(64) })).max(1000) });
export const assetJobId = z.string().regex(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
const jobState = z.enum(['running', 'succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted']);
export const assetJob: z.ZodType<AssetJobRecord> = z.object({
  schemaVersion: z.literal(1), jobId: assetJobId, directory: path, state: jobState,
  manifestPath: path.nullable(), error: z.object({ code: id.max(64), message: text }).nullable(), request,
  stage: id.max(48), startedAt: id, updatedAt: id, manifestAvailable: z.boolean(),
  events: z.array(z.object({ jobId: assetJobId, at: id, stage: id.max(48), state: jobState })).max(64),
  finishedAt: id.optional(),
}).transform(({ finishedAt, ...job }) => ({ ...job, ...(finishedAt === undefined ? {} : { finishedAt }) }))
  .refine(job => job.events.every(event => event.jobId === job.jobId), 'Events must belong to this exact asset job.');
export const assetManifest: z.ZodType<AssetManifest> = z.object({
  schemaVersion: z.literal(1), jobId: assetJobId, createdAt: id, request, runtime, templateSha256: hash,
  coordinateSystem: z.object({ units: z.literal('meters'), sceneUp: z.literal('Z'), glbUp: z.literal('Y'), fbxUp: z.literal('Y'), pivot: z.literal('floor'), robloxScaleVerified: z.literal(false) }),
  validation: z.object({ schemaVersion: z.literal(1), template: z.enum(['hero-prop', 'environment-kit']),
    meshes: z.array(z.object({ name: id, role: z.enum(['render', 'lod1', 'collision']), vertices: count, edges: count, faces: count, triangles: count,
      nonManifoldEdges: count, looseVertices: count, looseEdges: count, duplicateVertices: count, duplicateFaces: count, degenerateFaces: count,
      inconsistentNormals: count, invertedComponents: count, finitePositions: z.boolean(), uvLayers: count, uvLoops: count, invalidUVs: count,
      degenerateUVFaces: count, dimensions: vector, scale: vector, rotation: vector, materials: z.array(id).max(32), errors: z.array(text).max(128) })).min(1).max(128),
    totals: z.object({ renderTriangles: count, lod1Triangles: count, collisionTriangles: count, materials: count }),
    renders: z.array(z.object({ path: artifactName, width: count, height: count, finitePixels: z.boolean(), minLuminance: finite, maxLuminance: finite,
      meanLuminance: finite, standardDeviation: finite })).max(32),
    exports: z.array(z.object({ path: artifactName, objects: count, triangles: count, materials: count, finitePositions: z.boolean() })).max(32),
    savedSceneReopened: z.boolean(), errors: z.array(text).max(128), warnings: z.array(text).max(128) }),
  artifacts: z.array(z.object({ path: artifactName, role: z.enum(['scene', 'checkpoint', 'export', 'preview', 'audit', 'request', 'worker']), bytes: count, sha256: hash })).max(128),
  limitations: z.array(text).max(128),
});
