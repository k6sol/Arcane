import {parseStudioImportObservationReceipt,parseStudioImportObservationWitness} from '../../core/src/studio-policy.js';
import type {StudioImportObservationWitness,StudioImportObservedObject} from '../../protocol/src/studio.js';
import { SpatialMathError, matrixFromTrs, multiplyMatrix4 } from '../../core/src/spatial-math.js';
import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { z } from 'zod';
import { validateGlb } from '../../../apps/desktop/src/glb-preflight.js';
import { decodeMaterialPng, MaterialPngError } from './material-png.js';
import {parseConvertedGlbRequest,convertedGlbAssetId,convertedGlbObjectId,type ConvertedGlbRequest} from './converted-glb.js';
import {parseConvertedGraph,type ConvertedGraphV1} from './studio-import-graph.js';
import {CONVERSION_NODE_KEY,CONVERSION_VERTEX_ID,conversionCorrespondenceSha256,checkConversionMatrix} from './conversion-fidelity-policy.js';

/** Host-only preparation; no filesystem, upload, Studio, Blender or provider calls.
 * Reuses the existing data-only GLB gate, then adds static import policy and revisions.
 * Official requirements checked 2026-10-14 (general props, NOT avatar certification):
 * https://create.roblox.com/docs/art/modeling/specifications (20,000 triangles/mesh)
 * https://create.roblox.com/docs/art/modeling/texture-specifications (one material/mesh, 4K)
 * https://create.roblox.com/docs/cloud/guides/usage-assets (Model GLB/glTF, 20 MB/call)
 * https://create.roblox.com/docs/studio/importer (units, pivots, model hierarchy)
 * Other limits below are Arcane policy, not purported engine limits. */
export const STUDIO_IMPORT_LIMITS = Object.freeze({
  fileBytes: 20_000_000, totalBytes: 64 * 1024 * 1024, files: 32,
  objects: 128, meshTriangles: 20_000, triangles: 100_000,
  materials: 64, textures: 64, textureDimension: 4096, texturePixels: 16_777_216,
  jsonBytes: 1024 * 1024, manifestBytes: 1024 * 1024,
});
type Limits = { -readonly [K in keyof typeof STUDIO_IMPORT_LIMITS]: number };
export class StudioImportManifestError extends Error {
  constructor(public readonly code: 'AUTHORITY' | 'SCHEMA' | 'BUDGET' | 'EXPORT' | 'BASELINE', message: string) {
    super(message); this.name = 'StudioImportManifestError';
  }
}
function fail(code: StudioImportManifestError['code'], message: string): never { throw new StudioImportManifestError(code, message); }
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}(?![\s\S])/);
const hash = z.string().regex(/^[a-f0-9]{64}(?![\s\S])/);
const decimalId = z.string().regex(/^[1-9][0-9]{0,19}(?![\s\S])/);
const jobId = z.string().uuid();
const number = z.number().finite().min(-1_000_000).max(1_000_000);
const vec3 = z.tuple([number, number, number]);
const matrix = z.array(number).length(16).refine(m => m[3] === 0 && m[7] === 0 && m[11] === 0 && m[15] === 1, 'Expected affine column-major matrix');
const cframe = z.array(number).length(12).refine(m => {
  const r = m.slice(3);
  const row = (i: number) => r.slice(i * 3, i * 3 + 3);
  return [0, 1, 2].every(i => Math.abs(Math.hypot(...row(i)) - 1) < 1e-6) &&
    [[0, 1], [0, 2], [1, 2]].every(([a, b]) => Math.abs(row(a!).reduce((s, n, i) => s + n * row(b!)[i]!, 0)) < 1e-6) &&
    Math.abs(r[0]! * (r[4]! * r[8]! - r[5]! * r[7]!) - r[1]! * (r[3]! * r[8]! - r[5]! * r[6]!) + r[2]! * (r[3]! * r[7]! - r[4]! * r[6]!) - 1) < 1e-6;
}, 'Expected a rigid, right-handed CFrame');
// Measured surface AABBs may be planar. Triangle area is checked from actual
// indexed positions below; an AABB alone cannot distinguish a diagonal line.
const bounds = z.strictObject({ min: vec3, max: vec3 }).refine(b =>
  b.min.every((n, i) => n <= b.max[i]!) && b.min.filter((n, i) => n < b.max[i]!).length >= 2, 'Expected ordered surface bounds');
const creator = z.strictObject({ kind: z.enum(['user', 'group']), id: decimalId });
const target = z.strictObject({ sessionId: id, placeId: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  universeId: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), root: z.literal('Workspace'), parentRef: id, creator });
const placement = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('origin') }), z.strictObject({ mode: z.literal('bottom-centre') }),
  z.strictObject({ mode: z.literal('custom-anchor'), anchorId: id }),
  z.strictObject({ mode: z.literal('selected-attachment'), attachmentRef: id, expectedStateSha256: hash }),
  z.strictObject({ mode: z.literal('cframe'), value: cframe }),
]);
const anchor = z.strictObject({ sourceAnchorId: id, sourceObjectId: id, kind: z.enum(['socket', 'attachment']), transform: matrix });
const mime = z.enum(['model/gltf-binary', 'model/gltf+json', 'application/octet-stream', 'image/png', 'image/jpeg']);
const generatedFile = z.strictObject({ fileId: id, contentType: mime, sha256: hash, bytes: z.custom<Uint8Array<ArrayBufferLike>>(v => types.isUint8Array(v)) });
const resource = z.strictObject({ uri: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}\.(bin|png|jpg|jpeg)(?![\s\S])/), fileId: id });
const sourceObject = z.strictObject({ sourceObjectId: id, nodeIndex: z.number().int().nonnegative().max(4095),
  role: z.enum(['render', 'collision']), pivot: vec3, collisionFor: z.array(id).max(128) });
const sourceModel = z.strictObject({ fileId: id, resources: z.array(resource).max(32), objects: z.array(sourceObject).min(1).max(128) });
const fileManifest = generatedFile.omit({ bytes: true }).extend({ byteLength: z.number().int().positive().max(STUDIO_IMPORT_LIMITS.fileBytes) });
const textureManifest = z.strictObject({ sha256: hash, byteLength: z.number().int().positive(), width: z.number().int().positive(), height: z.number().int().positive(),
  contentType: z.enum(['image/png', 'image/jpeg']), locations: z.array(z.strictObject({ fileId: id, imageIndex: z.number().int().nonnegative() })).min(1).max(128) });
const textureUse = z.strictObject({ sha256: hash, channel: z.enum(['rgba', 'rgb', 'g', 'b']), texCoord: z.literal(0) });
const emission = z.strictObject({ factor: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)]),
  strength: z.number().min(0).max(1000), map: textureUse.nullable() });
const materialContent = z.strictObject({ baseColor: z.tuple([number, number, number, number]), metallic: z.number().min(0).max(1), roughness: z.number().min(0).max(1),
  alphaMode: z.enum(['OPAQUE', 'MASK', 'BLEND']), alphaCutoff: z.number().min(0).max(1), doubleSided: z.boolean(), normalScale: number,
  colorMap: textureUse.nullable(), normalMap: textureUse.nullable(), roughnessMap: textureUse.nullable(), metalnessMap: textureUse.nullable(),
  emission: emission.optional() });
const materialManifest = materialContent.extend({ sha256: hash });
const objectManifest = z.strictObject({ sourceObjectId: id, name: z.string().min(1).max(256), role: z.enum(['render', 'collision']), parentSourceObjectId: id.nullable(),
  exportFileId: id, nodeIndex: z.number().int().nonnegative(), meshExportSha256: hash, triangles: z.number().int().positive(),
  materialSha256: hash.nullable(), textureSha256s: z.array(hash).max(4), exportTransform: matrix, scale: vec3, pivot: vec3,
  bounds, worldBounds: bounds, collisionFor: z.array(id).max(128) }).refine(o => o.role !== 'collision' ||
    [o.bounds, o.worldBounds].every(b => b.min.every((n, i) => n < b.max[i]!)), 'Collision proxies require nonzero volume bounds');
const manifestContent = z.strictObject({ schemaVersion: z.literal(1), status: z.literal('prepared'), engineVerification: z.literal('pending'),
  projectId: hash, assetId: id, revisionId: jobId, sourceSha256: hash,
  producer: z.strictObject({ blenderVersion: z.string().regex(/^[A-Za-z0-9 .+_-]{1,128}(?![\s\S])/), exporterVersion: z.string().regex(/^[A-Za-z0-9 .+_-]{1,128}(?![\s\S])/) }),
  target, placement, conversion: z.strictObject({ sourceUnits: z.literal('meters'), sourceUp: z.literal('Z'), exportUnits: z.literal('meters'),
    exportUp: z.literal('Y'), targetUnits: z.literal('studs'), targetUp: z.literal('Y'), studsPerMeter: z.number().positive().max(1000) }),
  files: z.array(fileManifest).min(1).max(32), objects: z.array(objectManifest).min(1).max(128),
  materials: z.array(materialManifest).max(64), textures: z.array(textureManifest).max(64), anchors: z.array(anchor).max(128),
  bounds, limitations: z.array(z.string().max(256)).max(8) });
const manifestSchema = manifestContent.extend({ digest: hash });
const preservedChild = z.strictObject({ instanceRef: id, kind: z.enum(['script', 'attachment', 'constraint']), stateSha256: hash });
const mapping = z.strictObject({ sourceObjectId: id, instanceRef: id, meshAssetId: decimalId, ownedStateSha256: hash,
  authoredChildren: z.array(preservedChild).max(128) });
const baselineSchema = z.strictObject({ manifest: manifestSchema, receipt: z.strictObject({ manifestDigest: hash, receiptSha256: hash,
  modelRef: id, modelAssetId: decimalId, objects: z.array(mapping).min(1).max(128) }) });
const inputSchema = z.strictObject({ schemaVersion: z.literal(1), projectId: hash, assetId: id, revisionId: jobId, sourceSha256: hash,
  producer: manifestContent.shape.producer, target, placement, studsPerMeter: z.number().positive().max(1000),
  files: z.array(generatedFile).min(1).max(32), models: z.array(sourceModel).min(1).max(32), anchors: z.array(anchor).max(128), baseline: baselineSchema.nullable() });

const partKey = z.string().regex(/^node[0-9]{1,4}_primitive[0-9]{1,4}(?![\s\S])/);
const nodeKey = z.string().regex(/^node[0-9]{1,4}(?:_primitive[0-9]{1,4})?(?![\s\S])/);
const convertedSourceObject = sourceObject.extend({sourceKey:z.union([partKey,z.literal('proxy')])});
const convertedSourceModel = sourceModel.extend({objects:z.array(convertedSourceObject).min(1).max(128)});
const convertedObjectManifest = z.strictObject({sourceObjectId:id,sourceKey:z.union([partKey,z.literal('proxy')]),name:z.string().min(1).max(256),role:z.enum(['render','collision']),
  exportFileId:id,nodeIndex:z.number().int().nonnegative().max(4095),meshExportSha256:hash,triangles:z.number().int().positive().max(STUDIO_IMPORT_LIMITS.meshTriangles),
  materialSha256:hash.nullable(),textureSha256s:z.array(hash).max(4),exportTransform:matrix,scale:vec3,pivot:vec3,
  bounds,worldBounds:bounds,collisionFor:z.array(id).max(128)}).refine(o=>o.role!=='collision'||
    [o.bounds,o.worldBounds].every(b=>b.min.every((n,i)=>n<b.max[i]!)),'Collision proxies require nonzero volume bounds');
// Snapshot precedes these parsers. Their errors retain the source-specific code.
const convertedRequest = z.unknown().transform(value=>parseConvertedGlbRequest(value));
const convertedGraph = z.unknown().transform(value=>parseConvertedGraph(value));
const convertedProducer=z.strictObject({blenderVersion:z.string().min(1).max(128).regex(/^[\x20-\x7e]+(?![\s\S])/),
  exporterVersion:z.string().min(1).max(256).regex(/^[\x20-\x7e]+(?![\s\S])/)});
const convertedTextureManifest=textureManifest.extend({byteLength:z.number().int().positive().max(STUDIO_IMPORT_LIMITS.fileBytes),
  width:z.number().int().positive().max(STUDIO_IMPORT_LIMITS.textureDimension),height:z.number().int().positive().max(STUDIO_IMPORT_LIMITS.textureDimension),
  locations:z.array(z.strictObject({fileId:id,imageIndex:z.number().int().nonnegative().max(4095)})).min(1).max(128)});
const convertedManifestContent = manifestContent.extend({schemaVersion:z.literal(2),origin:z.literal('converted-glb'),
  identityScheme:z.literal('arcane-converted-v2'),conversionRequest:convertedRequest,graph:convertedGraph,
  producer:convertedProducer,conversion:manifestContent.shape.conversion.extend({sourceUp:z.literal('Y')}),objects:z.array(convertedObjectManifest).min(1).max(128),
  textures:z.array(convertedTextureManifest).max(64),anchors:z.array(z.never()).max(0)});
const convertedManifestSchema = convertedManifestContent.extend({digest:hash});
const nodeMapping = z.strictObject({nodeKey,instanceRef:id,ownedStateSha256:hash,authoredChildren:z.array(preservedChild).max(128)});
const convertedObservationWitness=z.unknown().transform(value=>{try{return parseStudioImportObservationWitness(value);}catch{fail('BASELINE','Expected an exact converted observation witness.');}});
const convertedBaselineSchema=z.strictObject({manifest:convertedManifestSchema,receipt:convertedObservationWitness});
const convertedInputSchema = inputSchema.extend({schemaVersion:z.literal(2),origin:z.literal('converted-glb'),identityScheme:z.literal('arcane-converted-v2'),
  producer:convertedProducer,conversionRequest:convertedRequest,graph:convertedGraph,models:z.array(convertedSourceModel).min(1).max(2),anchors:z.array(z.never()).max(0),baseline:convertedBaselineSchema.nullable()});

export type HostGeneratedStudioImport = z.input<typeof inputSchema>;
export type HostGeneratedStudioImportV1 = HostGeneratedStudioImport;
export type HostConvertedStudioImportV2 = Omit<z.input<typeof convertedInputSchema>,'conversionRequest'|'graph'|'baseline'> & {
  conversionRequest:ConvertedGlbRequest;graph:ConvertedGraphV1;baseline:ConvertedStudioImportBaselineV2|null;
};
export type HostStudioImport = HostGeneratedStudioImportV1 | HostConvertedStudioImportV2;
export type StudioImportSelection = Pick<HostGeneratedStudioImport, 'target' | 'placement' | 'studsPerMeter'>;
export type GeneratedStudioImportManifestV1 = DeepReadonly<z.infer<typeof manifestSchema>>;
export type ConvertedStudioImportManifestV2 = DeepReadonly<z.infer<typeof convertedManifestSchema>>;
export type StudioImportManifest = GeneratedStudioImportManifestV1 | ConvertedStudioImportManifestV2;
export type GeneratedStudioImportBaselineV1 = z.input<typeof baselineSchema>;
export type ConvertedStudioImportBaselineV2 = DeepReadonly<z.infer<typeof convertedBaselineSchema>>;
export type StudioImportBaseline = GeneratedStudioImportBaselineV1 | ConvertedStudioImportBaselineV2;
type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
/** A serialized/lookalike token never admits files or a previous Studio receipt. */
export interface StudioImportAdmission { readonly kind: 'studio-import-admission' }
export interface GeneratedStudioImportRevisionDeltaV1 {
  readonly previousDigest: string | null;
  readonly nextDigest: string;
  readonly receiptSha256: string | null;
  readonly modelRef: string | null;
  readonly modelAssetId: string | null;
  readonly placementChanged: boolean;
  readonly objects: readonly DeepReadonly<{
    sourceObjectId: string; action: 'create' | 'update-in-place' | 'reuse'; changed: string[];
    instanceRef: string | null; meshAssetId: string | null; expectedOwnedStateSha256: string | null;
    preserveChildren: z.infer<typeof preservedChild>[]; replaceInstance: false; deleteInstance: false;
  }>[];
  readonly reviewRemovals: readonly DeepReadonly<z.infer<typeof mapping> & { action: 'retain-for-review' }>[];
  readonly reviewAnchors: readonly string[];
  readonly geometry: Readonly<{ prepare: readonly string[]; reuse: readonly string[] }>;
  readonly textures: Readonly<{ prepare: readonly string[]; reuse: readonly string[] }>;
  readonly preservation: 'preserve-all-scripts-attachments-constraints';
}
export interface ConvertedStudioImportRevisionDeltaV2 extends Omit<GeneratedStudioImportRevisionDeltaV1,'reviewRemovals'> {
  readonly observation:DeepReadonly<StudioImportObservationWitness>|null;
  readonly reviewRemovals:readonly DeepReadonly<StudioImportObservedObject&{action:'retain-for-review'}>[];
  readonly graph:Readonly<{previousDigest:string|null;nextDigest:string;changed:boolean}>;
  readonly nodes:readonly DeepReadonly<{nodeKey:string;action:'create'|'update-in-place'|'reuse';changed:('parent'|'matrix'|'name'|'mesh'|'pivot')[];
    instanceRef:string|null;expectedOwnedStateSha256:string|null;preserveChildren:z.infer<typeof preservedChild>[];replaceInstance:false;deleteInstance:false}>[];
  readonly reviewNodeRemovals:readonly DeepReadonly<z.infer<typeof nodeMapping>&{action:'retain-for-review'}>[];
}
export type StudioImportRevisionDelta = GeneratedStudioImportRevisionDeltaV1 | ConvertedStudioImportRevisionDeltaV2;
export interface GeneratedPreparedStudioImportV1 {
  readonly status: 'prepared';
  readonly manifest: GeneratedStudioImportManifestV1;
  readonly delta: GeneratedStudioImportRevisionDeltaV1;
  readonly digest: string;
}
export interface ConvertedPreparedStudioImportV2 {readonly status:'prepared';readonly manifest:ConvertedStudioImportManifestV2;
  readonly delta:ConvertedStudioImportRevisionDeltaV2;readonly digest:string}
export type PreparedStudioImport = GeneratedPreparedStudioImportV1 | ConvertedPreparedStudioImportV2;
export interface StudioImportManifestAuthority {
  /** HOST ONLY: callback selects a completed job and verifies its generated bytes/ownership. */
  admit(jobId: string): Promise<StudioImportAdmission>;
  prepare(admission: StudioImportAdmission): PreparedStudioImport;
  revoke(admission: StudioImportAdmission): void;
  close(): void;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}';
  return JSON.stringify(value);
}
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const byteHash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
function freeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === 'object') { for (const v of Object.values(value)) freeze(v); Object.freeze(value); }
  return value as DeepReadonly<T>;
}
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const sorted = (xs: string[]) => [...new Set(xs)].sort(compare);
function unique(xs: string[], label: string, code: StudioImportManifestError['code'] = 'SCHEMA'): void { if (new Set(xs).size !== xs.length) fail(code, 'Duplicate ' + label + '.'); }
function bound(n: number, max: number, label: string): void { if (!Number.isSafeInteger(n) || n > max) fail('BUDGET', label + ' budget exceeded.'); }

// Descriptor-only snapshot. Reject getters, proxies, custom prototypes, symbols,
// sparse arrays and shared buffers before invoking Zod or serializing anything.
function snapshot(value: unknown, limits: Limits, converted = false): unknown {
  let values = 0, bytes = 0;
  const seen = new Set<object>();
  const typed = Object.getPrototypeOf(Uint8Array.prototype) as object;
  const internal = (key: string, v: object): unknown => Object.getOwnPropertyDescriptor(typed, key)!.get!.call(v);
  const walk = (v: unknown, depth: number): unknown => {
    if (++values > (converted ? 200_000 : 60_000) || depth > 32) fail('BUDGET', 'Metadata complexity budget exceeded.');
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'string') { if (v.length > 4096) fail('BUDGET', 'Metadata string budget exceeded.'); return v; }
    if (typeof v === 'number') { if (!Number.isFinite(v)) fail('SCHEMA', 'Nonfinite metadata.'); return Object.is(v, -0) ? 0 : v; }
    if (!v || typeof v !== 'object' || types.isProxy(v)) fail('SCHEMA', 'Expected plain data.');
    if (types.isUint8Array(v)) {
      const arrayBuffer = internal('buffer', v) as ArrayBuffer;
      if (types.isSharedArrayBuffer(arrayBuffer)) fail('SCHEMA', 'Shared bytes are not admissible.');
      const size = internal('byteLength', v) as number; bound(size, limits.fileBytes, 'File bytes'); bytes += size; bound(bytes, limits.totalBytes, 'Total bytes');
      try { return Buffer.from(new Uint8Array(arrayBuffer, internal('byteOffset', v) as number, size)); }
      catch { return fail('SCHEMA', 'Detached or invalid bytes.'); }
    }
    if (seen.has(v)) fail('SCHEMA', 'Cyclic metadata.');
    seen.add(v);
    const array = Array.isArray(v), prototype: unknown = Object.getPrototypeOf(v);
    if (converted && array ? prototype !== Array.prototype : prototype !== (array ? Array.prototype : Object.prototype) && prototype !== null) fail('SCHEMA', 'Expected plain metadata.');
    const descriptors = Object.getOwnPropertyDescriptors(v), keys = Reflect.ownKeys(v);
    if (keys.length > 4097) fail('BUDGET', 'Metadata array/key budget exceeded.');
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key)) fail('SCHEMA', 'Invalid metadata key.');
      const d = descriptors[key]!;
      if (!Object.hasOwn(d, 'value') || !d.enumerable) fail('SCHEMA', 'Accessors and hidden metadata are not admissible.');
      out[key] = walk(d.value as unknown, depth + 1);
    }
    seen.delete(v);
    if (array) {
      const length = descriptors.length!.value as number;
      if (Object.keys(out).length !== length || Object.keys(out).some(k => !/^(0|[1-9][0-9]*)$/.test(k) || Number(k) >= length)) fail('SCHEMA', 'Expected dense data array.');
      return Array.from({ length }, (_, i) => out[String(i)]);
    }
    return out;
  };
  return walk(value, 0);
}
function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) fail('SCHEMA', 'Invalid import schema: ' + result.error.issues.slice(0, 3).map(i => i.path.join('.') + ' ' + i.message).join('; '));
  return result.data;
}
/** Detach trusted host target selection before awaits; never invoke accessors. */
export function snapshotStudioImportSelection(value: unknown): StudioImportSelection {
  return freeze(parse(inputSchema.pick({ target: true, placement: true, studsPerMeter: true }),
    snapshot(value, { ...STUDIO_IMPORT_LIMITS }))) as StudioImportSelection;
}
type Obj = Record<string, any>; // Only JSON parsed and admitted by validateGlb below.
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function json(bytes: Buffer, limits: Limits): Obj {
  bound(bytes.length, limits.jsonBytes, 'JSON bytes');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return fail('EXPORT', 'Invalid UTF-8 export.'); }
  let depth = 0, quoted = false, escaped = false, tokens = 0;
  for (const c of text) {
    if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue; }
    if (c === '"') quoted = true;
    if ('[{'.includes(c) && ++depth > 32) fail('BUDGET', 'Export JSON depth exceeded.');
    if (']}'.includes(c)) depth--;
    if (',:[{'.includes(c) && ++tokens > 60_000) fail('BUDGET', 'Export JSON complexity exceeded.');
  }
  try { return JSON.parse(text) as Obj; } catch { return fail('EXPORT', 'Invalid export JSON.'); }
}
function makeGlb(doc: Obj, bin: Buffer, limits: Limits): Buffer {
  const text = Buffer.from(JSON.stringify(doc)); bound(text.length, limits.jsonBytes, 'JSON bytes');
  const jsonSize = Math.ceil(text.length / 4) * 4, binSize = Math.ceil(bin.length / 4) * 4;
  bound(28 + jsonSize + binSize, limits.fileBytes, 'Packed model upload bytes');
  const out = Buffer.alloc(28 + jsonSize + binSize); out.writeUInt32LE(0x46546c67); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(jsonSize, 12); out.writeUInt32LE(0x4e4f534a, 16); out.fill(0x20, 20, 20 + jsonSize); text.copy(out, 20);
  out.writeUInt32LE(binSize, 20 + jsonSize); out.writeUInt32LE(0x004e4942, 24 + jsonSize); bin.copy(out, 28 + jsonSize); return out;
}
function readModel(model: z.infer<typeof sourceModel>, files: Map<string, z.infer<typeof generatedFile>>, used: Set<string>, limits: Limits): { doc: Obj; bin: Buffer } {
  const file = files.get(model.fileId); if (!file) fail('EXPORT', 'Missing generated model file.'); used.add(file.fileId);
  let bytes: Buffer = Buffer.from(file.bytes);
  if (file.contentType === 'model/gltf+json') {
    const doc = json(bytes, limits), dependencies = new Map(model.resources.map(r => [r.uri, r.fileId]));
    unique(model.resources.map(r => r.uri), 'resource URI'); unique(model.resources.map(r => r.fileId), 'resource file');
    const consume = (uri: unknown, contentTypes: string[]): z.infer<typeof generatedFile> => {
      const fileId = typeof uri === 'string' ? dependencies.get(uri) : undefined;
      const dependency = fileId ? files.get(fileId) : undefined;
      if (!dependency || !contentTypes.includes(dependency.contentType)) fail('EXPORT', 'glTF resource must be an exact host-attested generated leaf file.');
      dependencies.delete(uri as string); used.add(dependency.fileId); return dependency;
    };
    if (!Array.isArray(doc.buffers) || doc.buffers.length !== 1) fail('EXPORT', 'Static glTF requires one generated buffer.');
    const sourceBuffer = doc.buffers[0];
    if (!sourceBuffer || typeof sourceBuffer !== 'object') fail('EXPORT', 'Missing glTF buffer.');
    let bin = Buffer.from(consume(sourceBuffer.uri, ['application/octet-stream']).bytes);
    if (sourceBuffer.byteLength !== bin.length) fail('EXPORT', 'glTF buffer length disagrees with generated bytes.');
    delete sourceBuffer.uri;
    if (doc.images !== undefined && (!Array.isArray(doc.images) || doc.images.length > limits.textures)) fail('BUDGET', 'Image count exceeded.');
    for (const image of doc.images ?? []) {
      if (!image || typeof image !== 'object') fail('EXPORT', 'Invalid glTF image.');
      if (image.uri === undefined) continue;
      if (image.bufferView !== undefined) fail('EXPORT', 'Ambiguous glTF image resource.');
      const dependency = consume(image.uri, ['image/png', 'image/jpeg']);
      if (image.mimeType !== undefined && image.mimeType !== dependency.contentType) fail('EXPORT', 'glTF image MIME mismatch.');
      const at = Math.ceil(bin.length / 4) * 4;
      bound(at + dependency.bytes.length, limits.totalBytes, 'Packed image bytes');
      bin = Buffer.concat([bin, Buffer.alloc(at - bin.length), Buffer.from(dependency.bytes)]);
      if (doc.bufferViews === undefined) doc.bufferViews = [];
      if (!Array.isArray(doc.bufferViews) || doc.bufferViews.length > 8192) fail('BUDGET', 'Buffer view count exceeded.');
      image.bufferView = doc.bufferViews.length; image.mimeType = dependency.contentType; delete image.uri;
      doc.bufferViews.push({ buffer: 0, byteOffset: at, byteLength: dependency.bytes.length });
    }
    if (dependencies.size) fail('EXPORT', 'Unused generated glTF resource.');
    sourceBuffer.byteLength = bin.length; bytes = makeGlb(doc, bin, limits);
  } else if (file.contentType !== 'model/gltf-binary' || model.resources.length) fail('EXPORT', 'Expected GLB or attested glTF bundle.');
  let triangleEstimate: number;
  try { triangleEstimate = validateGlb(bytes).triangleEstimate; } catch (error) { fail('EXPORT', error instanceof Error ? error.message : 'GLB preflight failed.'); }
  bound(triangleEstimate, limits.triangles, 'Export triangles');
  const doc = json(bytes.subarray(20, 20 + bytes.readUInt32LE(12)), limits), start = 28 + bytes.readUInt32LE(12);
  const bin = bytes.subarray(start);
  if ((doc.skins?.length ?? 0) || (doc.animations?.length ?? 0)) fail('EXPORT', 'Rigged/animated assets require a separate engine-verified adapter.');
  if ([...(doc.extensionsUsed ?? []), ...(doc.extensionsRequired ?? [])].some((name: string) => name !== 'KHR_materials_emissive_strength'))
    fail('EXPORT', 'Bake unsupported material/geometry extensions before static import.');
  return { doc, bin };
}
function multiply(a: number[], b: number[]): number[] {
  try { return multiplyMatrix4(a, b); }
  catch (error) { if (error instanceof SpatialMathError) fail('SCHEMA', 'Invalid affine import transform.'); throw error; }
}
function localMatrix(node: Obj): number[] {
  if (node.matrix) return node.matrix;
  try { return matrixFromTrs(node.translation, node.rotation, node.scale); }
  catch (error) { if (error instanceof SpatialMathError) fail('SCHEMA', 'Invalid affine import transform.'); throw error; }
}
function imageSize(bytes: Buffer, mimeType: string): [number, number] {
  if (mimeType === 'image/png') return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  let at = 2;
  while (at < bytes.length) {
    while (bytes[at] === 0xff) at++;
    const marker = bytes[at++]!, length = bytes.readUInt16BE(at);
    if ([0xc0, 0xc1, 0xc2].includes(marker)) return [bytes.readUInt16BE(at + 5), bytes.readUInt16BE(at + 3)];
    at += length;
  }
  return fail('EXPORT', 'Missing validated image dimensions.');
}
function accessor(doc: Obj, bin: Buffer, index: number): number[][] {
  const a = doc.accessors[index];
  if (a.sparse) fail('EXPORT', 'Static generated exports require dense accessors.');
  const v = doc.bufferViews[a.bufferView], components = ({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 } as Record<string, number>)[a.type];
  if (!components) fail('EXPORT', 'Unsupported static accessor shape.');
  const widths: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }, width = widths[a.componentType]!;
  const start = (v.byteOffset ?? 0) + (a.byteOffset ?? 0), stride = v.byteStride ?? components * width;
  return Array.from({ length: a.count }, (_, i) => Array.from({ length: components }, (_, c) => {
    const at = start + i * stride + c * width;
    let n = a.componentType === 5126 ? bin.readFloatLE(at) : a.componentType === 5125 ? bin.readUInt32LE(at) :
      a.componentType === 5123 ? bin.readUInt16LE(at) : a.componentType === 5122 ? bin.readInt16LE(at) : a.componentType === 5120 ? bin.readInt8(at) : bin.readUInt8(at);
    if (a.normalized) n = a.componentType === 5120 ? Math.max(n / 127, -1) : a.componentType === 5122 ? Math.max(n / 32767, -1) : n / (a.componentType === 5121 ? 255 : 65535);
    return Object.is(n, -0) ? 0 : n;
  }));
}
function measuredBounds(points: number[][]) {
  return parse(bounds, { min: [0, 1, 2].map(i => points.reduce((n, p) => Math.min(n, p[i]!), Infinity)),
    max: [0, 1, 2].map(i => points.reduce((n, p) => Math.max(n, p[i]!), -Infinity)) });
}
export const CONVERTED_STUDIO_IMPORT_FILE_IDS=Object.freeze({render:'asset-glb',collision:'collision-glb'});
type ConvertedInput=z.infer<typeof convertedInputSchema>;
type GeneratedManifest=z.infer<typeof manifestSchema>;
type ConvertedManifest=z.infer<typeof convertedManifestSchema>;
function convertedIdentity(value:ConvertedManifest|ConvertedInput):void {
  const request=value.conversionRequest;
  if(value.revisionId!==request.jobId||value.sourceSha256!==request.sourceSha256||value.assetId!==convertedGlbAssetId(request.sourceSha256))
    fail('EXPORT','Converted manifest identity differs from its actual request.');
  const expected=[CONVERTED_STUDIO_IMPORT_FILE_IDS.render,...(request.collision==='convex-hull'?[CONVERTED_STUDIO_IMPORT_FILE_IDS.collision]:[])].sort();
  if(canonical(value.files.map(f=>f.fileId).sort())!==canonical(expected)||value.files.some(f=>f.contentType!=='model/gltf-binary'))
    fail('EXPORT','Converted export inventory differs from its actual collision request.');
  const objects='models' in value?value.models.flatMap(m=>m.objects):value.objects;
  unique(objects.map(o=>o.sourceObjectId),'converted object ID');unique(objects.map(o=>o.sourceKey),'converted source key');
  if(objects.length!==value.graph.meshes.length)fail('EXPORT','Converted objects must cover every graph mesh.');
  const renderIds=objects.filter(o=>o.role==='render').map(o=>o.sourceObjectId).sort();
  for(const o of objects){
    const association=value.graph.meshes.find(m=>m.sourceObjectId===o.sourceObjectId);
    if(!association||o.sourceObjectId!==convertedGlbObjectId(request.sourceSha256,o.role,o.sourceKey)||canonical(o.pivot)!=='[0,0,0]'||
      (o.role==='render'?(association.nodeKey!==o.sourceKey||o.sourceKey==='proxy'||o.collisionFor.length!==0):
        (o.sourceKey!=='proxy'||association.nodeKey!==null||association.correspondenceSha256!==null||canonical([...o.collisionFor].sort())!==canonical(renderIds))))
      fail('EXPORT','Converted graph association, identity or source pivot differs.');
  }
  if(objects.filter(o=>o.role==='collision').length!==(request.collision==='convex-hull'?1:0))fail('EXPORT','Converted collision inventory differs.');
}
function convertedModelGraph(input:ConvertedInput,model:ConvertedInput['models'][number],doc:Obj):void {
  const render=model.fileId===CONVERTED_STUDIO_IMPORT_FILE_IDS.render;
  if(doc.asset.generator!==input.producer.exporterVersion)fail('EXPORT','Converted producer presentation differs from the actual export generator.');
  if(model.resources.length||model.objects.some(o=>o.role!==(render?'render':'collision')))fail('EXPORT','Converted exports require their fixed embedded model roles.');
  for(const o of model.objects){const n=doc.nodes[o.nodeIndex],extra=n?.extras;
    if(!extra||extra.arcane_identity_scheme!==input.identityScheme||extra.arcane_source_object_id!==o.sourceObjectId||
      extra.arcane_source_key!==o.sourceKey||extra.arcane_role!==o.role||canonical(extra.arcane_pivot)!=='[0,0,0]'||
      extra.arcane_collision_for!==JSON.stringify([...o.collisionFor].sort()))fail('EXPORT','Actual converted export identity or pivot differs.');
  }
  if(!render){if(doc.nodes.length!==1||model.objects.length!==1||doc.nodes[0].mesh===undefined||canonical(doc.scenes?.[doc.scene??0]?.nodes)!=='[0]')fail('EXPORT','Converted collision must be one derived root.');return;}
  if(doc.nodes.length!==input.graph.nodes.length)fail('EXPORT','Converted export lost or introduced graph nodes.');
  const byKey=new Map<string,number>(),parents=new Map<number,number>();
  doc.nodes.forEach((n:Obj,at:number)=>{const key=n.extras?.[CONVERSION_NODE_KEY];if(typeof key!=='string'||byKey.has(key))fail('EXPORT','Converted export lost unique graph markers.');byKey.set(key,at);
    for(const child of n.children??[]){if(parents.has(child))fail('EXPORT','Converted graph has ambiguous parents.');parents.set(child,at);}});
  const roots:string[]=[];
  for(const n of input.graph.nodes){const at=byKey.get(n.nodeKey);if(at===undefined)fail('EXPORT','Converted export lost a selected EMPTY or mesh node.');
    const actual=doc.nodes[at],parent=parents.get(at),parentKey=parent===undefined?null:doc.nodes[parent].extras?.[CONVERSION_NODE_KEY],association=input.graph.meshes.find(m=>m.nodeKey===n.nodeKey);
    if(parentKey!==n.parentKey||canonical(localMatrix(actual))!==canonical(n.localMatrix)||(actual.name??null)!==n.name||
      (actual.mesh!==undefined)!==Boolean(association))fail('EXPORT','Actual converted direct parent, local matrix, name or mesh differs from the graph.');
    if(parentKey===null)roots.push(n.nodeKey);
    if(association&&!model.objects.some(o=>o.nodeIndex===at&&o.sourceObjectId===association.sourceObjectId&&o.sourceKey===n.nodeKey))fail('EXPORT','Converted mesh index differs from its actual marker association.');
  }
  const scene=doc.scenes?.[doc.scene??0];
  if(!scene||canonical(scene.nodes.map((at:number)=>doc.nodes[at]?.extras?.[CONVERSION_NODE_KEY]).sort())!==canonical(roots.sort()))fail('EXPORT','Converted selected scene roots differ from the graph.');
}
function compile(input:z.infer<typeof inputSchema>,limits:Limits):GeneratedManifest;
function compile(input:ConvertedInput,limits:Limits):ConvertedManifest;
function compile(input: z.infer<typeof inputSchema>|ConvertedInput, limits: Limits): GeneratedManifest|ConvertedManifest {
  const converted=input.schemaVersion===2?input:null;
  if(converted){convertedIdentity(converted);unique(converted.models.map(m=>m.fileId),'converted model');
    if(canonical(converted.models.map(m=>m.fileId).sort())!==canonical(converted.files.map(f=>f.fileId).sort()))fail('EXPORT','Every converted export needs its fixed model inventory.');}
  bound(input.files.length, limits.files, 'File count'); unique(input.files.map(f => f.fileId), 'file ID'); unique(input.models.map(m => m.fileId), 'model ID');
  bound(input.models.reduce((n, m) => n + m.objects.length, 0), limits.objects, 'Source objects');
  const files = new Map(input.files.map(f => [f.fileId, f])), used = new Set<string>();
  for (const f of input.files) if (byteHash(f.bytes) !== f.sha256) fail('EXPORT', 'Generated file hash mismatch.');
  const objects: z.infer<typeof objectManifest>[] = [], textures = new Map<string, z.infer<typeof textureManifest>>(), materials = new Map<string, z.infer<typeof materialManifest>>();
  let triangles = 0, pixels = 0;
  for (const model of input.models) {
    const { doc, bin } = readModel(model, files, used, limits), nodes: Obj[] = doc.nodes ?? [], parents = new Map<number, number>();
    if(converted)convertedModelGraph(converted,model as ConvertedInput['models'][number],doc);
    bound((doc.materials ?? []).length, limits.materials, 'Material definitions'); bound((doc.images ?? []).length, limits.textures, 'Image definitions');
    const imageHashes = (doc.images ?? []).map((image: Obj, imageIndex: number) => {
      const view = doc.bufferViews[image.bufferView], encoded = bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
      const [width, height] = imageSize(encoded, image.mimeType);
      bound(width, limits.textureDimension, 'Texture width'); bound(height, limits.textureDimension, 'Texture height');
      pixels += width * height; bound(pixels, limits.texturePixels, 'Texture pixels');
      if (image.mimeType === 'image/png') {
        try {
          const decoded = decodeMaterialPng(encoded);
          if (decoded.width !== width || decoded.height !== height) fail('EXPORT', 'Material PNG dimensions disagree.');
        } catch (error) {
          if (error instanceof MaterialPngError) fail(error.code === 'LIMIT' ? 'BUDGET' : 'EXPORT', 'Material PNG pixel validation failed.');
          throw error;
        }
      }
      const sha256 = byteHash(encoded), location = { fileId: model.fileId, imageIndex };
      const old = textures.get(sha256);
      if (old) old.locations.push(location);
      else textures.set(sha256, { sha256, byteLength: encoded.length, width, height, contentType: image.mimeType, locations: [location] });
      return sha256;
    });
    const use = (info: Obj | undefined, channel: z.infer<typeof textureUse>['channel']) => {
      if (!info) return null;
      if ((info.texCoord ?? 0) !== 0 || info.extensions) fail('EXPORT', 'Only untransformed UV0 textures are supported.');
      const texture = doc.textures[info.index];
      // Sampling semantics must not silently differ in Studio.
      if (texture.sampler !== undefined) {
        const sampler = doc.samplers[texture.sampler];
        if ((sampler.wrapS ?? 10497) !== 10497 || (sampler.wrapT ?? 10497) !== 10497) fail('EXPORT', 'Bake unsupported texture wrapping before import.');
      }
      return { sha256: imageHashes[texture.source] as string, channel, texCoord: 0 as const };
    };
    const materialHashes = (doc.materials ?? []).map((m: Obj) => {
      if (Object.keys(m.extensions ?? {}).some(name => name !== 'KHR_materials_emissive_strength') || m.occlusionTexture)
        fail('EXPORT', 'Bake unsupported occlusion/material extensions before static import.');
      const p = m.pbrMetallicRoughness ?? {};
      const factor = m.emissiveFactor ?? [0, 0, 0], strength = m.extensions?.KHR_materials_emissive_strength?.emissiveStrength ?? 1;
      // Preserve glTF values, not an asserted engine conversion. SurfaceAppearance
      // exposes EmissiveTint/Strength/MaskContent; actual readback stays pending.
      // Omit zero/default emission to retain old non-emissive material digests.
      const light = m.emissiveTexture || factor.some((n: number) => n !== 0) || m.extensions?.KHR_materials_emissive_strength
        ? { emission: parse(emission, { factor, strength, map: use(m.emissiveTexture, 'rgb') }) } : {};
      const content = parse(materialContent, { baseColor: p.baseColorFactor ?? [1, 1, 1, 1], metallic: p.metallicFactor ?? 1, roughness: p.roughnessFactor ?? 1,
        alphaMode: m.alphaMode ?? 'OPAQUE', alphaCutoff: m.alphaCutoff ?? 0.5, doubleSided: m.doubleSided ?? false, normalScale: m.normalTexture?.scale ?? 1,
        colorMap: use(p.baseColorTexture, 'rgba'), normalMap: use(m.normalTexture, 'rgb'), roughnessMap: use(p.metallicRoughnessTexture, 'g'), metalnessMap: use(p.metallicRoughnessTexture, 'b'), ...light });
      const sha256 = digest(content); materials.set(sha256, { ...content, sha256 }); return sha256;
    });
    nodes.forEach((node, i) => (node.children ?? []).forEach((child: number) => parents.set(child, i)));
    unique(model.objects.map(o => String(o.nodeIndex)), 'source node');
    const sourceNodes = new Map(model.objects.map(o => [o.nodeIndex, o.sourceObjectId])), matrices = new Map<number, number[]>();
    const world = (i: number): number[] => {
      if (matrices.has(i)) return matrices.get(i)!;
      const p = parents.get(i), m = multiply(p === undefined ? IDENTITY : world(p), localMatrix(nodes[i]!));
      parse(matrix, m); matrices.set(i, m); return m;
    };
    if (nodes.filter(n => n.mesh !== undefined).length !== model.objects.length) fail('EXPORT', 'Every exported mesh node needs exactly one stable source object ID.');
    for (const source of model.objects) {
      unique(source.collisionFor, 'collision target');
      const node = nodes[source.nodeIndex]; if (!node || node.mesh === undefined) fail('EXPORT', 'Source object is not an exported mesh node.');
      const mesh = doc.meshes[node.mesh], positions: number[][] = [], geometry: unknown[] = [], slots = new Set<number | null>(); let count = 0;
      for (const p of mesh.primitives) {
        if ((p.mode ?? 4) !== 4 || p.targets || p.extensions || Object.keys(p.attributes).some(k => !['POSITION', 'NORMAL', 'TANGENT', 'TEXCOORD_0', 'COLOR_0'].includes(k)&&!(converted&&source.role==='render'&&k===CONVERSION_VERTEX_ID))) fail('EXPORT', 'Static import requires baked triangle primitives and UV0.');
        const vertexCount = doc.accessors[p.attributes.POSITION].count as number;
        bound(vertexCount, limits.meshTriangles * 3, 'Per-mesh vertices');
        count += (p.indices === undefined ? vertexCount : doc.accessors[p.indices].count) / 3;
        bound(count, limits.meshTriangles, 'Per-mesh triangles');
        const attrs = Object.fromEntries(Object.keys(p.attributes).sort().map(k => [k, accessor(doc, bin, p.attributes[k])])), pts = attrs.POSITION!;
        const indices = p.indices === undefined ? pts.map((_, i) => [i]) : accessor(doc, bin, p.indices);
        if(converted&&source.role==='render'){
          const a=doc.accessors[p.attributes[CONVERSION_VERTEX_ID]],ids=attrs[CONVERSION_VERTEX_ID]?.map(row=>row[0]!);
          if(mesh.primitives.length!==1||!a||a.type!=='SCALAR'||a.componentType!==5126||a.normalized||!ids||ids.length!==pts.length||
            ids.some(n=>!Number.isInteger(n)||n<0||n>=60000))fail('EXPORT','Converted render requires its exact host-owned vertex-ID accessor.');
          const faces:number[][]=[];for(let at=0;at<indices.length;at+=3)faces.push(indices.slice(at,at+3).map(row=>ids[row[0]!]!));
          const association=converted.graph.meshes.find(m=>m.sourceObjectId===source.sourceObjectId);
          if(!association||conversionCorrespondenceSha256(faces)!==association.correspondenceSha256)fail('EXPORT','Actual converted oriented ID topology differs from its graph association.');
        }
        // Existing Arcane generated-GLB policy: doubled triangle area in square
        // meters must exceed 1e-10. Seam duplicates are allowed across faces.
        for (let at = 0; at < indices.length; at += 3) {
          const a = pts[indices[at]![0]!]!, b = pts[indices[at + 1]![0]!]!, c = pts[indices[at + 2]![0]!]!;
          const u = b.map((n, i) => n - a[i]!), v = c.map((n, i) => n - a[i]!);
          if (Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!) <= 1e-10)
            fail('EXPORT', 'Degenerate triangle; doubled area must exceed 1e-10.');
        }
        for (const point of pts) positions.push(point);
        geometry.push({ attributes: attrs, indices: indices.flat(), mode: 4 });
        slots.add(p.material === undefined ? null : p.material);
        if (attrs.TEXCOORD_0?.some(row => row.some(n => n < 0 || n > 1))) fail('EXPORT', 'Roblox import requires UV0 coordinates within 0..1.');
      }
      bound(count, limits.meshTriangles, 'Per-mesh triangles'); triangles += count; bound(triangles, limits.triangles, 'Total triangles');
      if (slots.size !== 1) fail('EXPORT', 'Roblox permits one material per mesh object; split the generated export.');
      const slot = [...slots][0]!, materialSha256 = slot === null ? null : materialHashes[slot]!, transform = world(source.nodeIndex), scale = [0, 4, 8].map(at => Math.hypot(...transform.slice(at, at + 3)));
      const determinant = transform[0]! * (transform[5]! * transform[10]! - transform[6]! * transform[9]!) - transform[4]! * (transform[1]! * transform[10]! - transform[2]! * transform[9]!) + transform[8]! * (transform[1]! * transform[6]! - transform[2]! * transform[5]!);
      if (scale.some(n => n <= 0) || (!converted&&determinant <= 0)) fail('EXPORT', 'Bake singular or mirrored transforms before import.');
      if (source.role === 'collision' && materialSha256 !== null) fail('EXPORT', 'Collision proxies must not carry materials.');
      let parent = parents.get(source.nodeIndex);
      if(!converted)while (parent !== undefined && !sourceNodes.has(parent)) parent = parents.get(parent);
      const material = materialSha256 ? materials.get(materialSha256)! : null;
      const textureSha256s = material ? sorted([material.colorMap, material.normalMap, material.roughnessMap, material.metalnessMap, material.emission?.map].flatMap(m => m ? [m.sha256] : [])) : [];
      const {sourceKey:_sourceKey,...legacySource}=source as z.infer<typeof sourceObject>&{sourceKey?:string};
      objects.push(parse(objectManifest, { ...legacySource, name: node.name ?? mesh.name ?? source.sourceObjectId, parentSourceObjectId: converted||parent === undefined ? null : sourceNodes.get(parent),
        exportFileId: model.fileId, meshExportSha256: digest(geometry), triangles: count, materialSha256, textureSha256s, exportTransform: transform, scale,
        bounds: measuredBounds(positions), worldBounds: measuredBounds(positions.map(p => [0, 1, 2].map(i => transform[i]! * p[0]! + transform[4 + i]! * p[1]! + transform[8 + i]! * p[2]! + transform[12 + i]!))), collisionFor: sorted(source.collisionFor) }));
    }
  }
  if (used.size !== files.size) fail('EXPORT', 'Unreferenced generated files are not admitted.');
  bound(objects.length, limits.objects, 'Source objects'); unique(objects.map(o => o.sourceObjectId), 'source object ID');
  if (!objects.some(o => o.role === 'render')) fail('EXPORT', 'A render mesh is required.');
  for (const o of objects) {
    unique(o.collisionFor, 'collision target');
    if (o.role === 'render' && o.collisionFor.length || o.role === 'collision' && !o.collisionFor.length) fail('EXPORT', 'Collision mappings must be explicit.');
    for (const render of o.collisionFor) if (!objects.some(r => r.sourceObjectId === render && r.role === 'render')) fail('EXPORT', 'Collision mapping target is not a render object.');
  }
  unique(input.anchors.map(a => a.sourceAnchorId), 'anchor ID');
  for (const a of input.anchors) if (!objects.some(o => o.sourceObjectId === a.sourceObjectId && o.role === 'render')) fail('EXPORT', 'Anchor target is not a render object.');
  const selectedPlacement = input.placement;
  if (selectedPlacement.mode === 'custom-anchor' && !input.anchors.some(a => a.sourceAnchorId === selectedPlacement.anchorId)) fail('EXPORT', 'Unknown custom placement anchor.');
  bound(materials.size, limits.materials, 'Materials'); bound(textures.size, limits.textures, 'Textures');
  const rawContent = { schemaVersion: 1, status: 'prepared', engineVerification: 'pending', projectId: input.projectId, assetId: input.assetId,
    revisionId: input.revisionId, sourceSha256: input.sourceSha256, producer: input.producer, target: input.target, placement: input.placement,
    conversion: { sourceUnits: 'meters', sourceUp: 'Z', exportUnits: 'meters', exportUp: 'Y', targetUnits: 'studs', targetUp: 'Y', studsPerMeter: input.studsPerMeter },
    files: input.files.map(f => ({ fileId: f.fileId, contentType: f.contentType, sha256: f.sha256, byteLength: f.bytes.length })).sort((a, b) => compare(a.fileId, b.fileId)),
    objects: objects.sort((a, b) => compare(a.sourceObjectId, b.sourceObjectId)), materials: [...materials.values()].sort((a, b) => compare(a.sha256, b.sha256)),
    textures: [...textures.values()].map(t => ({ ...t, locations: t.locations.sort((a, b) => compare(a.fileId, b.fileId) || a.imageIndex - b.imageIndex) })).sort((a, b) => compare(a.sha256, b.sha256)),
    anchors: input.anchors.sort((a, b) => compare(a.sourceAnchorId, b.sourceAnchorId)), bounds: measuredBounds(objects.filter(o => o.role === 'render').flatMap(o => [o.worldBounds.min, o.worldBounds.max])),
    limitations: ['Prepared files are not uploaded, moderated, inserted or verified in Studio.', 'Axes, scale, placement, collision and appearance require in-engine verification.',
      'PBR factors, alpha modes and packed G/B maps require host-supported baking/conversion before SurfaceAppearance assignment.', 'LOD switching, rigs and animation require separate supported adapters.'] };
  if(converted){
    const keys=new Map(converted.models.flatMap(m=>m.objects.map(o=>[o.sourceObjectId,o.sourceKey] as const)));
    const convertedContent=parse(convertedManifestContent,{...rawContent,schemaVersion:2,origin:'converted-glb',identityScheme:'arcane-converted-v2',
      conversionRequest:converted.conversionRequest,graph:converted.graph,conversion:{...rawContent.conversion,sourceUp:'Y'},
      objects:rawContent.objects.map(o=>{const {parentSourceObjectId:_parent,...object}=o;return{...object,sourceKey:keys.get(o.sourceObjectId)};})});
    bound(Buffer.byteLength(canonical(convertedContent)),limits.manifestBytes,'Converted manifest bytes');
    const manifest={...convertedContent,digest:digest(convertedContent)};convertedManifestChecks(manifest);return manifest;
  }
  const content=parse(manifestContent,rawContent);bound(Buffer.byteLength(canonical(content)),limits.manifestBytes,'Manifest bytes');
  return { ...content, digest: digest(content) };
}

function graphWorlds(graph:ConvertedGraphV1):Map<string,number[]> {
  const nodes=new Map(graph.nodes.map(n=>[n.nodeKey,n])),worlds=new Map<string,number[]>();
  for(const n of graph.nodes){const chain:ConvertedGraphV1['nodes'][number][]= [];let next:string|null=n.nodeKey;
    while(next!==null&&!worlds.has(next)){const current:ConvertedGraphV1['nodes'][number]=nodes.get(next)!;chain.push(current);next=current.parentKey;}
    let world=next===null?IDENTITY:worlds.get(next)!;
    while(chain.length){const current=chain.pop()!;world=multiply(world,[...current.localMatrix]);worlds.set(current.nodeKey,world);}
  }return worlds;
}
function convertedManifestChecks(manifest:ConvertedManifest):void {
  bound(Buffer.byteLength(canonical(manifest)),STUDIO_IMPORT_LIMITS.manifestBytes,'Converted manifest bytes');
  convertedIdentity(manifest);unique(manifest.files.map(f=>f.fileId),'converted file');
  unique(manifest.materials.map(m=>m.sha256),'converted material');unique(manifest.textures.map(t=>t.sha256),'converted texture');
  if(manifest.anchors.length!==0)fail('EXPORT','Converted assets do not declare anchors.');
  bound(manifest.files.reduce((n,f)=>n+f.byteLength,0),STUDIO_IMPORT_LIMITS.totalBytes,'Converted total bytes');
  bound(manifest.objects.reduce((n,o)=>n+o.triangles,0),STUDIO_IMPORT_LIMITS.triangles,'Converted triangles');
  const worlds=graphWorlds(manifest.graph);
  unique(manifest.objects.map(o=>o.exportFileId+'\n'+o.nodeIndex),'converted export node');
  for(const o of manifest.objects){
    unique(o.textureSha256s,'converted object texture');unique(o.collisionFor,'converted collision target');
    bound(o.triangles,STUDIO_IMPORT_LIMITS.meshTriangles,'Converted per-mesh triangles');
    bound(o.nodeIndex,4095,'Converted node index');checkConversionMatrix(o.exportTransform);
    if(o.exportFileId!==(o.role==='render'?CONVERTED_STUDIO_IMPORT_FILE_IDS.render:CONVERTED_STUDIO_IMPORT_FILE_IDS.collision)||
      (o.materialSha256!==null&&!manifest.materials.some(m=>m.sha256===o.materialSha256))||
      o.textureSha256s.some(h=>!manifest.textures.some(t=>t.sha256===h))||
      (o.role==='render'&&canonical(o.exportTransform)!==canonical(worlds.get(o.sourceKey)))||
      canonical(o.scale)!==canonical([0,4,8].map(at=>Math.hypot(...o.exportTransform.slice(at,at+3))))||
      (o.role==='collision'&&o.materialSha256!==null))fail('EXPORT','Converted object files, graph transform or material references differ.');
  }
  for(const m of manifest.materials){const {sha256,...body}=m;if(digest(body)!==sha256)fail('EXPORT','Converted material digest differs.');
    if([m.colorMap,m.normalMap,m.roughnessMap,m.metalnessMap,m.emission?.map].some(map=>map&&!manifest.textures.some(t=>t.sha256===map.sha256)))fail('EXPORT','Converted material references an absent texture.');}
  bound(manifest.textures.reduce((n,t)=>n+t.width*t.height,0),STUDIO_IMPORT_LIMITS.texturePixels,'Converted texture pixels');
  for(const t of manifest.textures)if(t.locations.some(location=>!manifest.files.some(f=>f.fileId===location.fileId)))fail('EXPORT','Converted texture location references an absent export.');
  if(manifest.placement.mode==='custom-anchor')fail('EXPORT','Converted custom anchor is absent.');
}
/** Closed serialized data only; source-bound admission still belongs to the host
 * loader/adapter and the retained-byte graph builder. This grants no authority. */
export function parseConvertedStudioImportManifest(value:unknown):ConvertedStudioImportManifestV2 {
  const manifest=parse(convertedManifestSchema,snapshot(value,{...STUDIO_IMPORT_LIMITS},true)),{digest:actual,...body}=manifest;
  if(digest(body)!==actual)fail('SCHEMA','Converted manifest digest differs.');convertedManifestChecks(manifest);return freeze(manifest);
}
/** Detached observed-baseline data, not a receipt attestation or permission. */
/** Digest of strictly parsed actual observation metadata, not an authority token. */
export function studioImportObservationReceiptDigest(value:unknown):string {
  try{return digest(parseStudioImportObservationReceipt(value));}catch{fail('BASELINE','Invalid converted observation receipt.');}
}
export function snapshotConvertedStudioImportBaseline(value:unknown):ConvertedStudioImportBaselineV2 {
  const baseline=parse(convertedBaselineSchema,snapshot(value,{...STUDIO_IMPORT_LIMITS},true));
  bound(Buffer.byteLength(canonical(baseline)),STUDIO_IMPORT_LIMITS.manifestBytes,'Converted baseline bytes');
  convertedRevision(baseline.manifest,baseline);return freeze(baseline);
}
function revision(next: z.infer<typeof manifestSchema>, baseline: z.infer<typeof baselineSchema> | null): GeneratedStudioImportRevisionDeltaV1 {
  const previous = baseline?.manifest ?? null;
  if (previous) {
    const { digest: oldDigest, ...content } = previous;
    if (digest(content) !== oldDigest || baseline!.receipt.manifestDigest !== oldDigest) fail('BASELINE', 'Previous manifest/receipt digest mismatch.');
    if (previous.projectId !== next.projectId || previous.assetId !== next.assetId || canonical(previous.target) !== canonical(next.target)) fail('BASELINE', 'Previous mapping belongs to a different asset, creator, place, session or parent.');
    unique(baseline!.receipt.objects.map(o => o.sourceObjectId), 'baseline source ID', 'BASELINE');
    const references = [baseline!.receipt.modelRef];
    for (const o of baseline!.receipt.objects) references.push(o.instanceRef, ...o.authoredChildren.map(c => c.instanceRef));
    unique(references, 'baseline instance reference', 'BASELINE');
    if (baseline!.receipt.objects.length !== previous.objects.length || previous.objects.some(o => !baseline!.receipt.objects.some(m => m.sourceObjectId === o.sourceObjectId))) fail('BASELINE', 'Receipt must map every previous source object.');
  }
  const oldObjects = new Map(previous?.objects.map(o => [o.sourceObjectId, o]) ?? []), mapped = new Map(baseline?.receipt.objects.map(o => [o.sourceObjectId, o]) ?? []);
  const placementChanged = previous !== null && (canonical(previous.placement) !== canonical(next.placement) || canonical(previous.conversion) !== canonical(next.conversion));
  const objects = next.objects.map(o => {
    const old = oldObjects.get(o.sourceObjectId), m = mapped.get(o.sourceObjectId);
    const changed: string[] = [];
    if (old) {
      if (o.role !== old.role) fail('BASELINE', 'Changing a mapped object role requires separate conflict review.');
      if (o.meshExportSha256 !== old.meshExportSha256) changed.push('geometry');
      if (o.materialSha256 !== old.materialSha256) changed.push('material');
      if (canonical(o.textureSha256s) !== canonical(old.textureSha256s)) changed.push('textures');
      if (placementChanged || ['exportTransform', 'pivot', 'scale'].some(k => canonical(o[k as keyof typeof o]) !== canonical(old[k as keyof typeof old]))) changed.push('transform');
      if (canonical(o.collisionFor) !== canonical(old.collisionFor)) changed.push('collision');
      if (o.name !== old.name || o.parentSourceObjectId !== old.parentSourceObjectId) changed.push('identity');
    }
    return { sourceObjectId: o.sourceObjectId, action: !old ? 'create' as const : changed.length ? 'update-in-place' as const : 'reuse' as const,
      changed, instanceRef: m?.instanceRef ?? null, meshAssetId: m?.meshAssetId ?? null, expectedOwnedStateSha256: m?.ownedStateSha256 ?? null,
      preserveChildren: [...(m?.authoredChildren ?? [])].sort((a, b) => compare(a.instanceRef, b.instanceRef)), replaceInstance: false as const, deleteInstance: false as const };
  });
  const reviewRemovals = (baseline?.receipt.objects ?? []).filter(m => !next.objects.some(o => o.sourceObjectId === m.sourceObjectId)).map(m => ({ ...m,
    authoredChildren: [...m.authoredChildren].sort((a, b) => compare(a.instanceRef, b.instanceRef)), action: 'retain-for-review' as const })).sort((a, b) => compare(a.sourceObjectId, b.sourceObjectId));
  const resources = (current: string[], old: string[]) => ({ prepare: sorted(current.filter(h => !old.includes(h))), reuse: sorted(current.filter(h => old.includes(h))) });
  const anchorIds = sorted([...next.anchors, ...(previous?.anchors ?? [])].map(a => a.sourceAnchorId));
  return freeze({ previousDigest: previous?.digest ?? null, nextDigest: next.digest, receiptSha256: baseline?.receipt.receiptSha256 ?? null,
    modelRef: baseline?.receipt.modelRef ?? null, modelAssetId: baseline?.receipt.modelAssetId ?? null, placementChanged, objects, reviewRemovals,
    reviewAnchors: anchorIds.filter(a => canonical(next.anchors.find(x => x.sourceAnchorId === a) ?? null) !== canonical(previous?.anchors.find(x => x.sourceAnchorId === a) ?? null)),
    geometry: resources(next.objects.map(o => o.meshExportSha256), previous?.objects.map(o => o.meshExportSha256) ?? []),
    textures: resources(next.textures.map(t => t.sha256), previous?.textures.map(t => t.sha256) ?? []), preservation: 'preserve-all-scripts-attachments-constraints' as const });
}

function convertedRevision(next:ConvertedManifest,baseline:z.infer<typeof convertedBaselineSchema>|null):ConvertedStudioImportRevisionDeltaV2 {
  const previous=baseline?.manifest??null;
  if(previous){
    parseConvertedStudioImportManifest(previous);
    const witness=baseline!.receipt,observed=witness.observation,source=observed.source;
    if(witness.receiptSha256!==studioImportObservationReceiptDigest(observed)||source.manifestDigest!==previous.digest||source.graphDigest!==previous.graph.digest||
      source.projectId!==previous.projectId||source.jobId!==previous.revisionId||source.assetId!==previous.assetId||source.sourceSha256!==previous.sourceSha256||
      source.conversionRequestDigest!==digest(previous.conversionRequest)||canonical(observed.target)!==canonical(previous.target)||
      previous.projectId!==next.projectId||previous.assetId!==next.assetId||previous.sourceSha256!==next.sourceSha256||canonical(previous.target)!==canonical(next.target))
      fail('BASELINE','Converted baseline belongs to another observed source, manifest, graph or target.');
    const receipt=baseline!.receipt.observation;unique(receipt.objects.map(o=>o.sourceObjectId),'converted baseline object','BASELINE');
    unique(receipt.nodes.map(n=>n.nodeKey),'converted baseline node','BASELINE');
    if(receipt.objects.length!==previous.objects.length||previous.objects.some(o=>!receipt.objects.some(m=>m.sourceObjectId===o.sourceObjectId))||
      receipt.nodes.length!==previous.graph.nodes.length||previous.graph.nodes.some(n=>!receipt.nodes.some(m=>m.nodeKey===n.nodeKey)))
      fail('BASELINE','Converted receipt must map every prior mesh and graph node.');
    const references=[receipt.modelRef.instanceId];
    for(const o of receipt.objects){references.push(o.instanceRef,...o.authoredChildren.map(c=>c.instanceRef));}
    for(const n of receipt.nodes){const mesh=previous.graph.meshes.find(m=>m.nodeKey===n.nodeKey),object=mesh?receipt.objects.find(o=>o.sourceObjectId===mesh.sourceObjectId):undefined;
      if(object){if(n.instanceRef!==object.instanceRef||n.ownedStateSha256!==object.ownedStateSha256||canonical(n.authoredChildren)!==canonical(object.authoredChildren))fail('BASELINE','Converted mesh/node receipt mappings disagree.');}
      else references.push(n.instanceRef,...n.authoredChildren.map(c=>c.instanceRef));
    }unique(references,'converted baseline owned instance','BASELINE');
  }
  const oldObjects=new Map(previous?.objects.map(o=>[o.sourceObjectId,o])??[]),mapped=new Map(baseline?.receipt.observation.objects.map(o=>[o.sourceObjectId,o])??[]);
  const placementChanged=previous!==null&&(canonical(previous.placement)!==canonical(next.placement)||canonical(previous.conversion)!==canonical(next.conversion));
  const objects=next.objects.map(o=>{const old=oldObjects.get(o.sourceObjectId),m=mapped.get(o.sourceObjectId),changed:string[]=[];
    if(old){if(o.role!==old.role)fail('BASELINE','Converted mapped object role changes require conflict review.');
      if(o.meshExportSha256!==old.meshExportSha256)changed.push('geometry');if(o.materialSha256!==old.materialSha256)changed.push('material');
      if(canonical(o.textureSha256s)!==canonical(old.textureSha256s))changed.push('textures');
      if(placementChanged||['exportTransform','pivot','scale'].some(k=>canonical(o[k as keyof typeof o])!==canonical(old[k as keyof typeof old])))changed.push('transform');
      if(canonical(o.collisionFor)!==canonical(old.collisionFor))changed.push('collision');if(o.name!==old.name||o.sourceKey!==old.sourceKey)changed.push('identity');
    }return{sourceObjectId:o.sourceObjectId,action:!old?'create' as const:changed.length?'update-in-place' as const:'reuse' as const,changed,
      instanceRef:m?.instanceRef??null,meshAssetId:m?.meshAssetId??null,expectedOwnedStateSha256:m?.ownedStateSha256??null,
      preserveChildren:[...(m?.authoredChildren??[])].sort((a,b)=>compare(a.instanceRef,b.instanceRef)),replaceInstance:false as const,deleteInstance:false as const};});
  const oldNodes=new Map(previous?.graph.nodes.map(n=>[n.nodeKey,n])??[]),nodeMap=new Map(baseline?.receipt.observation.nodes.map(n=>[n.nodeKey,n])??[]);
  const nextWorlds=graphWorlds(next.graph),oldWorlds=previous?graphWorlds(previous.graph):new Map<string,number[]>();
  const nodes=next.graph.nodes.map(n=>{const old=oldNodes.get(n.nodeKey),m=nodeMap.get(n.nodeKey),changed:('parent'|'matrix'|'name'|'mesh'|'pivot')[]=[];
    const before=previous?.graph.meshes.find(mesh=>mesh.nodeKey===n.nodeKey),after=next.graph.meshes.find(mesh=>mesh.nodeKey===n.nodeKey);
    if(old){if(n.parentKey!==old.parentKey)changed.push('parent');
      if(placementChanged||canonical(n.localMatrix)!==canonical(old.localMatrix)||canonical(nextWorlds.get(n.nodeKey))!==canonical(oldWorlds.get(n.nodeKey)))changed.push('matrix');
      if(n.name!==old.name)changed.push('name');
      if(canonical(before?{sourceObjectId:before.sourceObjectId,correspondenceSha256:before.correspondenceSha256}:null)!==canonical(after?{sourceObjectId:after.sourceObjectId,correspondenceSha256:after.correspondenceSha256}:null))changed.push('mesh');
      if(canonical(before?.sourcePivot??null)!==canonical(after?.sourcePivot??null))changed.push('pivot');
    }return{nodeKey:n.nodeKey,action:!old?'create' as const:changed.length?'update-in-place' as const:'reuse' as const,changed,instanceRef:m?.instanceRef??null,
      expectedOwnedStateSha256:m?.ownedStateSha256??null,preserveChildren:[...(m?.authoredChildren??[])].sort((a,b)=>compare(a.instanceRef,b.instanceRef)),replaceInstance:false as const,deleteInstance:false as const};});
  const resources=(current:string[],old:string[])=>({prepare:sorted(current.filter(h=>!old.includes(h))),reuse:sorted(current.filter(h=>old.includes(h)))});
  return freeze({previousDigest:previous?.digest??null,nextDigest:next.digest,receiptSha256:baseline?.receipt.receiptSha256??null,modelRef:baseline?.receipt.observation.modelRef.instanceId??null,
    modelAssetId:null,observation:baseline?.receipt??null,placementChanged,objects,
    reviewRemovals:(baseline?.receipt.observation.objects??[]).filter(m=>!next.objects.some(o=>o.sourceObjectId===m.sourceObjectId)).map(m=>({...m,
      authoredChildren:[...m.authoredChildren].sort((a,b)=>compare(a.instanceRef,b.instanceRef)),action:'retain-for-review' as const})).sort((a,b)=>compare(a.sourceObjectId,b.sourceObjectId)),
    reviewAnchors:[],geometry:resources(next.objects.map(o=>o.meshExportSha256),previous?.objects.map(o=>o.meshExportSha256)??[]),
    textures:resources(next.textures.map(t=>t.sha256),previous?.textures.map(t=>t.sha256)??[]),preservation:'preserve-all-scripts-attachments-constraints' as const,
    graph:{previousDigest:previous?.graph.digest??null,nextDigest:next.graph.digest,changed:previous===null||previous.graph.digest!==next.graph.digest},nodes,
    reviewNodeRemovals:(baseline?.receipt.observation.nodes??[]).filter(m=>!next.graph.nodes.some(n=>n.nodeKey===m.nodeKey)).map(m=>({...m,
      authoredChildren:[...m.authoredChildren].sort((a,b)=>compare(a.instanceRef,b.instanceRef)),action:'retain-for-review' as const})).sort((a,b)=>compare(a.nodeKey,b.nodeKey))});
}

/** Production integration: AssetService.prepareStudioImport owns the loader and
 * admission lifetime. It rechecks the same NativeAssetActor and exact durable
 * ConversationWorkStore binding, reads fixed verified asset.glb/collision.glb,
 * and validates bundled worker semantic IDs against actual exported extras.
 * Its asset-import-adapter pins input/request/scene/worker hashes, measured
 * anchor transforms and actual producer versions. Old jobs without emitted
 * identities are explicitly unsupported; no host fallback IDs are generated.
 * Current AssetService does NOT admit arbitrary glTF paths: glTF bundles here
 * require an equivalent host-generated artifact reader before they can be used.
 * Load baseline ONLY from durable host-observed import mappings and exact Studio
 * receipts; HTTP workflow role labels/verified flags are not receipt authority.
 * After EVERY await, recheck the same captured native/project/session grant in
 * that callback. Throw on revocation; a true/false result is not an attestation.
 * Expose only prepared data, never this factory, loader or admission token.
 * Main wires trusted studioImport options into createAssetService and calls
 * prepareStudioImport(jobId, actor) from the dedicated native audience only.
 * Main must persist the prepared digest/delta before a separately authorized
 * Model upload/import; preserve listed children, compare expectedOwnedStateSha256
 * inside the final engine mutation, retain removed objects for human review,
 * journal async operations before polling, reconcile uncertainty, and record a
 * NEW observed Studio receipt after bounds/material/scale/collision verification.
 * Do not mark a workflow accepted or reuse this admission as Studio write consent.
 */
export function createStudioImportManifestAuthority(options: {
  loadGeneratedFiles(jobId: string): Promise<HostStudioImport>;
  limits?: Partial<Record<keyof Limits, number>>;
}): StudioImportManifestAuthority {
  if (!options || typeof options !== 'object' || types.isProxy(options)) fail('AUTHORITY', 'Host loader is required.');
  const descriptors = Object.getOwnPropertyDescriptors(options);
  if (Reflect.ownKeys(options).some(k => k !== 'loadGeneratedFiles' && k !== 'limits') ||
      !descriptors.loadGeneratedFiles || !Object.hasOwn(descriptors.loadGeneratedFiles, 'value') || typeof descriptors.loadGeneratedFiles.value !== 'function' ||
      descriptors.limits && !Object.hasOwn(descriptors.limits, 'value')) fail('AUTHORITY', 'Expected host-code loader and limits.');
  const load = descriptors.loadGeneratedFiles.value as (jobId: string) => Promise<HostStudioImport>;
  const limits: Limits = { ...STUDIO_IMPORT_LIMITS };
  if (descriptors.limits) {
    const overrides = snapshot(descriptors.limits.value as unknown, limits) as Record<string, unknown>;
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) fail('SCHEMA', 'Expected budget overrides.');
    for (const [key, value] of Object.entries(overrides)) {
      if (!Object.hasOwn(limits, key) || typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > limits[key as keyof Limits]) fail('BUDGET', 'Budgets may only tighten supported limits.');
      limits[key as keyof Limits] = value;
    }
  }
  let closed = false, admissions = new WeakMap<object, PreparedStudioImport>();
  const open = () => { if (closed) fail('AUTHORITY', 'Import manifest authority is closed.'); };
  return Object.freeze({
    async admit(value: string) {
      open(); const requested = parse(jobId, value);
      const raw = await load(requested); open();
      const isConverted=raw&&typeof raw==='object'&&!types.isProxy(raw)&&Object.getOwnPropertyDescriptor(raw,'schemaVersion')?.value===2;
      const detached=snapshot(raw,limits,Boolean(isConverted));let prepared:PreparedStudioImport;
      if(isConverted){const input=parse(convertedInputSchema,detached);
        if(input.revisionId!==requested)fail('AUTHORITY','Host-converted revision does not match requested job.');
        const manifest=compile(input,limits),delta=convertedRevision(manifest,input.baseline);
        prepared=freeze({status:'prepared' as const,manifest,delta,digest:digest({manifestDigest:manifest.digest,delta})});
      }else{const input=parse(inputSchema,detached);
        if (input.revisionId !== requested) fail('AUTHORITY', 'Host-generated revision does not match requested job.');
        const manifest = compile(input, limits), delta = revision(manifest, input.baseline);
        prepared = freeze({ status: 'prepared' as const, manifest, delta, digest: digest({ manifestDigest: manifest.digest, delta }) });
      }
      bound(Buffer.byteLength(canonical(prepared)), limits.manifestBytes, 'Prepared plan bytes');
      const token = Object.freeze({ kind: 'studio-import-admission' as const }); admissions.set(token, prepared); return token;
    },
    prepare(token: StudioImportAdmission) {
      open(); const prepared = token && typeof token === 'object' ? admissions.get(token) : undefined;
      if (!prepared) fail('AUTHORITY', 'An opaque host admission from this authority is required.'); return prepared;
    },
    revoke(token: StudioImportAdmission) { open(); if (!token || typeof token !== 'object' || !admissions.delete(token)) fail('AUTHORITY', 'Unknown import admission.'); },
    close() { closed = true; admissions = new WeakMap(); },
  });
}
