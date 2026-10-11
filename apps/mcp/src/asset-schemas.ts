import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { normalizeRequest, validateAudit } from '../../../packages/asset-pipeline/src/validation.js';
import { jsonSnapshot } from '../../../packages/asset-pipeline/src/recipe.js';
import type { AssetInput, AssetRequest, AssetProbe, AssetManifest } from '../../../packages/asset-pipeline/src/types.js';
import { id, boundedText } from './schemas.js';
import type { AssetJobRecord } from '../../daemon/src/asset-service.js';
import { assetSlug, assemblyRecipe, assemblyEvidence, geometryBounds, socketEvidence, boundedVector } from './assembly-schemas.js';

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const finite = z.number().finite();
const vector = z.tuple([finite, finite, finite]);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().max(8192);
const path = boundedText(4096);
const artifactName = id.max(96).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/).refine(value => !value.includes('..'));
const runtime = z.object({ executable: path, version: id, pythonVersion: id, background: z.boolean(),
  capabilities: z.object({ glbExport: z.boolean(), glbImport: z.boolean(), fbxExport: z.boolean(), fbxImport: z.boolean(), cycles: z.boolean() }) });
const template = z.enum(['hero-prop', 'environment-kit', 'custom-assembly']);

export const assetInput = z.strictObject({
  template, name: assetSlug, seed: z.number().int().min(0).max(2147483647).optional(),
  sizeMeters: boundedVector(0.1, 20).optional(), color: boundedVector(0, 1).optional(),
  triangleBudget: z.number().int().min(100).max(50000).optional(),
  renderResolution: z.number().int().min(128).max(1024).optional(), renderSamples: z.number().int().min(4).max(64).optional(),
  recipe: assemblyRecipe.optional(),
});
export type SafeAssetInput = z.output<typeof assetInput>;
export function safeAssetInput(input: SafeAssetInput): AssetInput {
  // Keep optional settings and recipe defaults omitted in the submitted source request.
  // The shared validator snapshots plain JSON, checks topology/preflight, and returns a typed normalized request.
  const body = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
  normalizeRequest(body);
  return jsonSnapshot(body) as AssetInput;
}

// Custom response dimensions/color are derived by shared preflight, rather than caller overrides.
const requestShape = assetInput.omit({ sizeMeters: true, color: true, recipe: true }).required().extend({
  schemaVersion: z.literal(1), sizeMeters: boundedVector(0.01, 40), color: boundedVector(0, 1), recipe: assemblyRecipe.optional(),
});
export const assetRequest: z.ZodType<AssetRequest> = requestShape.transform((value, context) => {
  try {
    const normalized = normalizeRequest(value);
    if (!isDeepStrictEqual(value, normalized)) throw new Error('Request is not normalized.');
    return normalized;
  } catch { context.addIssue({ code: 'custom', message: 'Daemon request must match shared normalization and preflight.' }); return z.NEVER; }
});
export const assetProbe: z.ZodType<AssetProbe> = z.object({ observedAt: id, available: z.boolean(), blender: runtime.nullable(),
  python: z.object({ executable: path, version: id }).nullable(), attempts: z.array(z.object({ executable: path, code: id.max(64) })).max(1000) });
export const assetJobId = z.string().regex(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
const jobState = z.enum(['running', 'succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted']);
export const assetJob: z.ZodType<AssetJobRecord> = z.object({
  schemaVersion: z.literal(1), jobId: assetJobId, directory: path, state: jobState,
  manifestPath: path.nullable(), error: z.object({ code: id.max(64), message: text }).nullable(), request: assetRequest,
  stage: id.max(48), startedAt: id, updatedAt: id, manifestAvailable: z.boolean(),
  events: z.array(z.object({ jobId: assetJobId, at: id, stage: id.max(48), state: jobState })).max(64), finishedAt: id.optional(),
}).transform(({ finishedAt, ...job }) => ({ ...job, ...(finishedAt === undefined ? {} : { finishedAt }) }))
  .refine(job => job.events.every(event => event.jobId === job.jobId), 'Events must belong to this exact asset job.');

const mesh = z.object({ name: id, role: z.enum(['render', 'lod1', 'collision']), vertices: count, edges: count, faces: count, triangles: count,
  nonManifoldEdges: count, looseVertices: count, looseEdges: count, duplicateVertices: count, duplicateFaces: count, degenerateFaces: count,
  inconsistentNormals: count, invertedComponents: count, finitePositions: z.boolean(), uvLayers: count, uvLoops: count, invalidUVs: count,
  degenerateUVFaces: count, dimensions: vector, scale: vector, rotation: vector, materials: z.array(id).max(32), errors: z.array(text).max(128),
  geometrySha256: hash.optional(), bounds: geometryBounds.optional(),
}).transform(({ geometrySha256, bounds, ...value }) => ({ ...value,
  ...(geometrySha256 === undefined ? {} : { geometrySha256 }), ...(bounds === undefined ? {} : { bounds }) }));
const exported = z.object({ path: artifactName, objects: count, triangles: count, materials: count, finitePositions: z.boolean(),
  sockets: z.array(socketEvidence).max(64).optional(),
}).transform(({ sockets, ...value }) => ({ ...value, ...(sockets === undefined ? {} : { sockets }) }));
const audit = z.object({ schemaVersion: z.literal(1), template, meshes: z.array(mesh).min(1).max(128),
  totals: z.object({ renderTriangles: count, lod1Triangles: count, collisionTriangles: count, materials: count }),
  renders: z.array(z.object({ path: artifactName, width: count, height: count, finitePixels: z.boolean(), minLuminance: finite, maxLuminance: finite,
    meanLuminance: finite, standardDeviation: finite })).max(32), exports: z.array(exported).max(32),
  savedSceneReopened: z.boolean(), errors: z.array(text).max(128), warnings: z.array(text).max(128), assembly: assemblyEvidence.optional(),
}).transform(({ assembly, ...value }) => ({ ...value, ...(assembly === undefined ? {} : { assembly }) }));
export const assetManifest: z.ZodType<AssetManifest> = z.object({
  schemaVersion: z.literal(1), jobId: assetJobId, createdAt: id, request: assetRequest, runtime, templateSha256: hash,
  sourceRequestSha256: hash.optional(), assembly: assemblyEvidence.optional(),
  coordinateSystem: z.object({ units: z.literal('meters'), sceneUp: z.literal('Z'), glbUp: z.literal('Y'), fbxUp: z.literal('Y'), pivot: z.literal('floor'), robloxScaleVerified: z.literal(false) }),
  validation: audit,
  artifacts: z.array(z.object({ path: artifactName, role: z.enum(['scene', 'checkpoint', 'export', 'preview', 'audit', 'request', 'worker']), bytes: count, sha256: hash })).max(128),
  limitations: z.array(text).max(128),
}).transform(({ sourceRequestSha256, assembly, ...value }) => ({ ...value,
  ...(sourceRequestSha256 === undefined ? {} : { sourceRequestSha256 }), ...(assembly === undefined ? {} : { assembly }) }))
  .superRefine((value, context) => {
    if (value.validation.template !== value.request.template) context.addIssue({ code: 'custom', message: 'Manifest audit template differs from its request.' });
    if (value.request.template !== 'custom-assembly') return;
    try {
      if (!value.sourceRequestSha256 || !value.assembly || !isDeepStrictEqual(value.assembly, value.validation.assembly)) throw new Error('Missing/mismatched provenance.');
      validateAudit(value.validation, value.request);
    } catch { context.addIssue({ code: 'custom', message: 'Custom manifest requires matching assembly, source digest, mesh bounds/digests, export sockets and shared audit evidence.' }); }
  });
