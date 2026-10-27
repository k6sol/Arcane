import { z } from 'zod';
import { ASSET_CONVERSATION_PROVIDERS } from '../../../packages/protocol/src/asset-conversation.js';
import { isDeepStrictEqual, types } from 'node:util';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import {parseAdoptGlbInput,parseAdoptedGlbRequest,parseAdoptedGlbManifest,type AdoptedGlbRequest} from '../../../packages/asset-pipeline/src/adopted-glb.js';
import {parseConvertGlbInput} from '../../daemon/src/conversion-start.js';
import type {AssetPreviewManifest} from '../../daemon/src/asset-service.js';
import { normalizeRequest, validateAudit } from '../../../packages/asset-pipeline/src/validation.js';
import { jsonSnapshot, JOB_JOURNAL_BYTES } from '../../../packages/asset-pipeline/src/recipe.js';
import { decodeAssetJobError } from '../../../packages/asset-pipeline/src/failure-diagnostics.js';
import { parseConvertedGlbJobMetadata } from '../../../packages/asset-pipeline/src/converted-glb-creation.js';
import { parseConvertedGlbManifest } from '../../../packages/asset-pipeline/src/converted-glb-manifest.js';
import type { AssetInput, AssetRequest, AssetProbe, AssetManifest } from '../../../packages/asset-pipeline/src/types.js';
import { id, boundedText } from './schemas.js';
import { HISTORY_PAGE_BYTES,HISTORY_RECORD_LIMIT, type AssetJobRecord, type AssetJobPage } from '../../daemon/src/asset-service.js';
import { assetSlug, assemblyRecipe, assemblyEvidence, geometryBounds, socketEvidence, materialEvidence, boundedVector } from './assembly-schemas.js';

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const finite = z.number().finite();
const vector = z.tuple([finite, finite, finite]);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().max(8192);
const path = boundedText(4096);
const artifactName = id.max(96).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/).refine(value => !value.includes('..'));
const runtime = z.object({ executable: path, version: id, pythonVersion: id, background: z.boolean(),
  capabilities: z.object({ glbExport: z.boolean(), glbImport: z.boolean(), fbxExport: z.boolean(), fbxImport: z.boolean(), cycles: z.boolean() }) });
const template = z.enum(['hero-prop', 'environment-kit', 'custom-assembly', 'procedural']);

export const assetInput = z.strictObject({
  template, name: assetSlug, seed: z.number().int().min(0).max(2147483647).optional(),
  sizeMeters: boundedVector(0.1, 20).optional(), color: boundedVector(0, 1).optional(),
  triangleBudget: z.number().int().min(100).max(50000).optional(),
  renderResolution: z.number().int().min(128).max(1024).optional(), renderSamples: z.number().int().min(4).max(64).optional(),
  recipe: assemblyRecipe.optional(),
  // Typed by assets_procedural; shared normalization (normalizeProcedural) bounds every field.
  procedural: z.record(z.string(), z.unknown()).optional(),
});
export type SafeAssetInput = z.output<typeof assetInput>;
export const nativeAdoptGlbInput=z.strictObject({name:assetSlug,path:z.string().min(1).max(4096)}).superRefine((value,context)=>{
 try{parseAdoptGlbInput(value);}catch{context.addIssue({code:'custom',message:'Use a direct project-relative .glb path, not URLs, links, traversal or authority fields.'});}
});
export const nativeConvertGlbInput=z.strictObject({
 parentJobId:z.string().length(36).regex(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}(?![\s\S])/),
 name:assetSlug,collision:z.enum(['none','convex-hull']),
 renderResolution:z.number().int().min(128).max(1024),renderSamples:z.number().int().min(1).max(64),
}).superRefine((value,context)=>{
 try{parseConvertGlbInput(value);}catch{context.addIssue({code:'custom',message:'Choose a managed parent job, safe name, collision mode and bounded preview settings.'});}
});
export const adoptedGlbRequest:z.ZodType<AdoptedGlbRequest>=z.unknown().transform((value,context)=>{
 try{return parseAdoptedGlbRequest(value);}catch{context.addIssue({code:'custom',message:'Invalid adopted GLB request provenance.'});return z.NEVER;}
});
export function safeAssetInput(input: SafeAssetInput): AssetInput {
  // Keep optional settings and recipe defaults omitted in the submitted source request.
  // The shared validator snapshots plain JSON, checks topology/preflight, and returns a typed normalized request.
  const body = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
  normalizeRequest(body);
  return jsonSnapshot(body) as AssetInput;
}

// Custom response dimensions/color are derived by shared preflight, rather than caller overrides.
const requestShape = assetInput.omit({ sizeMeters: true, color: true, recipe: true, procedural: true }).required().extend({
  schemaVersion: z.literal(1), sizeMeters: boundedVector(0.01, 40), color: boundedVector(0, 1), recipe: assemblyRecipe.optional(),
  procedural: z.record(z.string(), z.unknown()).optional(),
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
const jobError = z.unknown().transform((value, context) => {
  try { return decodeAssetJobError(value); }
  catch { context.addIssue({ code: 'custom', message: 'Invalid asset failure evidence.' }); return z.NEVER; }
});
const legacyAssetJob = z.object({
  schemaVersion: z.literal(1), jobId: assetJobId, reportId:assetJobId.optional(), directory: path, state: jobState,
  manifestPath: path.nullable(), error: jobError.nullable(), request: z.union([assetRequest,adoptedGlbRequest]),
  stage: id.max(48), startedAt: id, updatedAt: id, manifestAvailable: z.boolean(),
  events: z.array(z.object({ jobId: assetJobId, at: id, stage: id.max(48), state: jobState })).max(64), finishedAt: id.optional(),
  retention:z.strictObject({status:z.literal('archived'),archivedAt:z.iso.datetime()}).optional(),
  resolution:z.union([z.strictObject({status:z.literal('resolved'),resolvedAt:z.iso.datetime({precision:7})}),z.strictObject({status:z.enum(['invalid','uncertain'])})]).optional(),
}).refine(job => job.events.every(event => event.jobId === job.jobId)&&(!job.resolution||job.state==='interrupted')&&
    (!job.retention||job.state!=='running'&&(job.state!=='interrupted'||job.resolution?.status==='resolved')), 'Asset history evidence must match this exact job and terminal state.')
  // The marker is checked before transformation, but human recovery controls
  // are never exposed to an agent as a reusable approval or effect capability.
  .transform(({ finishedAt,retention,reportId,resolution:_resolution, ...job }) => ({ ...job, ...(finishedAt === undefined ? {} : { finishedAt }),...(reportId===undefined?{}:{reportId}),
    ...(retention===undefined?{}:{retention}) }));

const convertedAssetJob = z.strictObject({
  schemaVersion: z.literal(1), jobId: assetJobId, reportId:assetJobId.length(36).optional(), directory: path, state: jobState,
  manifestPath: path.nullable(), error: jobError.nullable(), request: z.unknown(),
  kind: z.literal('converted-glb'), form: z.enum(['new-pending', 'new-prepared', 'legacy-pending', 'legacy-prepared']),
  creation: z.unknown().optional(), stage: id.max(48), startedAt: id, updatedAt: id, manifestAvailable: z.boolean(),
  events: z.array(z.strictObject({ jobId: assetJobId, at: id, stage: id.max(48), state: jobState })).max(64), finishedAt: id.optional(),
  retention:z.strictObject({status:z.literal('archived'),archivedAt:z.iso.datetime()}).optional(),
  resolution:z.union([z.strictObject({status:z.literal('resolved'),resolvedAt:z.iso.datetime({precision:7})}),z.strictObject({status:z.enum(['invalid','uncertain'])})]).optional(),
});
/** Select conversion before a legacy object schema can strip its discriminator.
 * Inspect descriptors only; the conversion parser rejects nested caller code. */
function hasOwnWireField(value: unknown, fields: readonly string[]): boolean {
  if (!value || typeof value !== 'object') return false;
  if (types.isProxy(value)) throw new Error('Proxy wire record.');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return fields.some(field => Object.hasOwn(descriptors, field));
}
function hasConversionWireSignal(value: unknown, fields: readonly string[]): boolean {
  const outer = hasOwnWireField(value, fields);
  const request = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'request') : undefined;
  if (request && !Object.hasOwn(request, 'value')) throw new Error('Accessor wire request.');
  return outer || hasOwnWireField(request?.value, ['kind', 'fidelityPolicy']);
}
export const assetJob: z.ZodType<AssetJobRecord> = z.unknown().transform((value, context) => {
  try {
    if (!hasConversionWireSignal(value, ['kind', 'form', 'creation'])) return legacyAssetJob.parse(value);
    // The metadata parser copies/bounds the original plain data before Zod can
    // read values, and validates the actual request rather than inventing one.
    const metadata = parseConvertedGlbJobMetadata(value), parsed = convertedAssetJob.parse(value);
    if (parsed.form !== metadata.form || parsed.events.some(event => event.jobId !== parsed.jobId) ||
        (parsed.resolution && parsed.state !== 'interrupted') ||
        (parsed.retention && (parsed.state === 'running' || parsed.state === 'interrupted' && parsed.resolution?.status !== 'resolved')) ||
        (!metadata.request && (parsed.manifestAvailable || parsed.manifestPath !== null)) ||
        ((parsed.manifestPath !== null) !== parsed.manifestAvailable) ||
        (parsed.manifestAvailable && parsed.state !== 'succeeded') || (parsed.state === 'succeeded' && parsed.error !== null) ||
        (parsed.reportId !== undefined && parsed.error === null)) throw new Error('Inconsistent converted job.');
    const { creation: _creation, request: _request, form: _form, resolution: _resolution, finishedAt, retention, reportId, ...job } = parsed;
    return { ...job, form: metadata.form, ...(metadata.creation ? { creation: metadata.creation } : {}), request: metadata.request,
      ...(finishedAt === undefined ? {} : { finishedAt }), ...(reportId === undefined ? {} : { reportId }),
      ...(retention === undefined ? {} : { retention }) } as AssetJobRecord;
  } catch { context.addIssue({ code: 'custom', message: 'Invalid converted or legacy asset job record.' }); return z.NEVER; }
});

export const assetHistoryInput = z.strictObject({ limit: z.number().int().min(1).max(64).optional(), after: assetJobId.optional() });
const unavailableAsset=z.strictObject({jobId:assetJobId.length(36),name:z.string().min(1).max(48).regex(/^[a-z][a-z0-9-]*(?![\s\S])/).optional(),status:z.enum(['missing','changed','conflict','unclassified'])})
  .transform(({name,...item})=>({...item,...(name===undefined?{}:{name})}));
export const assetJobPage: z.ZodType<AssetJobPage> = z.object({ schemaVersion: z.literal(1), jobs: z.array(assetJob).max(64),
  total: z.number().int().min(0).max(HISTORY_RECORD_LIMIT), nextCursor: assetJobId.nullable(), byteLimit: z.literal(HISTORY_PAGE_BYTES),unavailable:z.array(unavailableAsset).max(64).optional(),
}).transform(({unavailable,...page})=>({...page,...(unavailable===undefined?{}:{unavailable})})).refine(page => page.total >= page.jobs.length+(page.unavailable?.length??0) && page.jobs.length+(page.unavailable?.length??0)<=64&&
  new Set([...page.jobs.map(job => job.jobId),...(page.unavailable??[]).map(item=>item.jobId)]).size === page.jobs.length+(page.unavailable?.length??0)
  && (page.nextCursor === null || page.nextCursor === page.jobs.at(-1)?.jobId || page.nextCursor===page.unavailable?.at(-1)?.jobId)
  && Buffer.byteLength(JSON.stringify(page)) <= HISTORY_PAGE_BYTES, 'Invalid bounded asset history page.');

// Native envelopes are response evidence, never caller-supplied authority.
export const nativeAssetJobId = assetJobId.length(36);
const nativeId = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*(?![\s\S])/);
const nativeScope = {
  projectId: z.string().length(64).regex(/^[a-f0-9]{64}$/),
  projectPath: path.refine(value => isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value)
    && Buffer.byteLength(value) <= 4096, 'Expected a bounded absolute project path.'),
  conversation: z.strictObject({ provider: z.enum(ASSET_CONVERSATION_PROVIDERS), threadId: nativeId, sessionId: nativeId.nullable() }),
};
export const nativeAssetCursor = z.string().min(66).max(81).regex(/^[a-f0-9]{64}:[1-9][0-9]{0,15}(?![\s\S])/)
  .refine(value => Number.isSafeInteger(Number(value.slice(65))), 'Cursor sequence exceeds its bounds.');
export const nativeAssetHistoryInput = z.strictObject({ limit: z.number().int().min(1).max(64).optional(), after: nativeAssetCursor.optional() });

function boundedNativeRecord(max: number) {
  // Check the wire record before existing schemas can strip unknown fields.
  return z.unknown().refine(value => Buffer.byteLength(JSON.stringify(value) ?? '') <= max, 'Native asset record exceeds its byte bound.');
}
const nativeJob = boundedNativeRecord(JOB_JOURNAL_BYTES).pipe(assetJob)
  .refine(job => nativeAssetJobId.safeParse(job.jobId).success, 'Expected an exact job UUID.');
export function nativeAssetCursorMatchesScope(cursor: string, scope: z.output<z.ZodObject<typeof nativeScope>>): boolean {
  const { projectId, conversation } = scope;
  const digest = createHash('sha256').update(JSON.stringify([projectId, conversation.provider, conversation.threadId, conversation.sessionId, 'asset-job'])).digest('hex');
  return cursor.slice(0, 64) === digest;
}
export const nativeAssetJobPage = boundedNativeRecord(HISTORY_PAGE_BYTES).pipe(z.strictObject({
  ...nativeScope, jobs: z.array(nativeJob).max(64), nextCursor: nativeAssetCursor.nullable(), byteLimit: z.literal(HISTORY_PAGE_BYTES),unavailable:z.array(unavailableAsset).max(64).optional(),
})).refine(page => page.jobs.length+(page.unavailable?.length??0)<=64&&new Set([...page.jobs.map(job => job.jobId),...(page.unavailable??[]).map(item=>item.jobId)]).size === page.jobs.length+(page.unavailable?.length??0)
  && (page.nextCursor === null || nativeAssetCursorMatchesScope(page.nextCursor, page)), 'Invalid scoped native asset history page.');
export const nativeAssetStart = boundedNativeRecord(JOB_JOURNAL_BYTES).pipe(z.strictObject({
  ...nativeScope, jobId: nativeAssetJobId.nullable(), association: z.enum(['bound', 'unknown']),
  creation: z.enum(['created', 'unknown']), retry: z.literal(false), job: nativeJob.optional(),
})).refine(ack => (ack.association !== 'bound' || (ack.creation === 'created' && ack.jobId !== null))
  && (ack.jobId !== null || (ack.creation === 'unknown' && ack.association === 'unknown'))
  && (ack.job === undefined || ack.job.jobId === ack.jobId), 'Invalid native creation or association acknowledgement.');

export const nativeAssetCancel = boundedNativeRecord(JOB_JOURNAL_BYTES).pipe(z.union([
  z.object({ job: nativeJob }),
  z.strictObject({ jobId: nativeAssetJobId, state: z.literal('unknown'), retry: z.literal(false) }),
]));

// Measured UV quality of natural-finish parts (bounded numbers/null plus the verdict lists).
const uvQuality = z.object({ intent: z.enum(['unique', 'periodic', 'tiled', 'atlas']), errors: z.array(text).max(32), warnings: z.array(text).max(32) })
  .catchall(z.union([z.number().finite(), z.null()]));
const mesh = z.object({ name: id, role: z.enum(['render', 'lod1', 'collision']), vertices: count, edges: count, faces: count, triangles: count,
  nonManifoldEdges: count, looseVertices: count, looseEdges: count, duplicateVertices: count, duplicateFaces: count, degenerateFaces: count,
  inconsistentNormals: count, invertedComponents: count, finitePositions: z.boolean(), uvLayers: count, uvLoops: count, invalidUVs: count,
  degenerateUVFaces: count, dimensions: vector, scale: vector, rotation: vector, materials: z.array(id).max(32), errors: z.array(text).max(128),
  geometrySha256: hash.optional(), bounds: geometryBounds.optional(), position: boundedVector(-60, 60).optional(), materialProperties: z.array(materialEvidence).max(8).optional(),
  uvQuality: uvQuality.optional(),
}).transform(({ geometrySha256, bounds, position, materialProperties, uvQuality, ...value }) => ({ ...value, ...(uvQuality === undefined ? {} : { uvQuality }),
  ...(geometrySha256 === undefined ? {} : { geometrySha256 }), ...(bounds === undefined ? {} : { bounds }),
  ...(position === undefined ? {} : { position }), ...(materialProperties === undefined ? {} : { materialProperties }) }));
const exported = z.object({ path: artifactName, objects: count, triangles: count, materials: count, finitePositions: z.boolean(),
  sockets: z.array(socketEvidence).max(64).optional(),
}).transform(({ sockets, ...value }) => ({ ...value, ...(sockets === undefined ? {} : { sockets }) }));
const audit = z.object({ schemaVersion: z.literal(1), template, meshes: z.array(mesh).min(1).max(128),
  totals: z.object({ renderTriangles: count, lod1Triangles: count, collisionTriangles: count, materials: count }),
  renders: z.array(z.object({ path: artifactName, width: count, height: count, finitePixels: z.boolean(), minLuminance: finite, maxLuminance: finite,
    meanLuminance: finite, standardDeviation: finite })).max(32), exports: z.array(exported).max(32),
  savedSceneReopened: z.boolean(), errors: z.array(text).max(128), warnings: z.array(text).max(128), assembly: assemblyEvidence.optional(),
  // Model spec self-check metrics (workers/blender/grammar/model_review.py): bounded, informational.
  review: z.record(z.string(), z.unknown()).refine(value => Buffer.byteLength(JSON.stringify(value)) <= 64 * 1024, 'Review metrics exceed 64 KiB.').optional(),
}).transform(({ assembly, review, ...value }) => ({ ...value, ...(assembly === undefined ? {} : { assembly }), ...(review === undefined ? {} : { review }) }));
const generatedAssetManifest: z.ZodType<AssetManifest> = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]), jobId: assetJobId, createdAt: id, request: assetRequest, runtime, templateSha256: hash,
  sourceRequestSha256: hash.optional(), assembly: assemblyEvidence.optional(),
  coordinateSystem: z.object({ units: z.literal('meters'), sceneUp: z.literal('Z'), glbUp: z.literal('Y'), fbxUp: z.literal('Y'), pivot: z.literal('floor'), robloxScaleVerified: z.literal(false) }),
  validation: audit,
  artifacts: z.array(z.object({ path: artifactName, role: z.enum(['scene', 'checkpoint', 'export', 'preview', 'audit', 'request', 'worker']), bytes: count, sha256: hash })).max(128),
  limitations: z.array(text).max(128),
}).transform(({ sourceRequestSha256, assembly, ...value }) => ({ ...value,
  ...(sourceRequestSha256 === undefined ? {} : { sourceRequestSha256 }), ...(assembly === undefined ? {} : { assembly }) }))
  .superRefine((value, context) => {
    if (value.validation.template !== value.request.template) context.addIssue({ code: 'custom', message: 'Manifest audit template differs from its request.' });
    if (value.sourceRequestSha256 !== undefined && value.artifacts.find(artifact => artifact.path === 'input.json')?.sha256 !== value.sourceRequestSha256) context.addIssue({ code:'custom',message:'Source request digest differs from its input artifact.' });
    if (value.request.template !== 'custom-assembly') return;
    try {
      if (!value.sourceRequestSha256 || !value.assembly || !isDeepStrictEqual(value.assembly, value.validation.assembly)) throw new Error('Missing/mismatched provenance.');
      validateAudit(value.validation, value.request, value.schemaVersion);
    } catch { context.addIssue({ code: 'custom', message: 'Custom manifest requires matching assembly, source digest, mesh bounds/digests, export sockets and shared audit evidence.' }); }
  });

const legacyAssetManifest=z.union([generatedAssetManifest,z.unknown().transform((value,context)=>{
 try{return parseAdoptedGlbManifest(value);}catch{context.addIssue({code:'custom',message:'Invalid preview-only adopted GLB manifest.'});return z.NEVER;}
})]);
export const assetManifest:z.ZodType<AssetPreviewManifest>=z.unknown().transform((value,context)=>{
 try {
  if(hasConversionWireSignal(value,['origin']))return parseConvertedGlbManifest(value);
  return legacyAssetManifest.parse(value);
 } catch {context.addIssue({code:'custom',message:'Invalid asset preview manifest.'});return z.NEVER;}
});
