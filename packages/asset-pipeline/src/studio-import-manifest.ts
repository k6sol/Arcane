import { SpatialMathError, matrixFromTrs, multiplyMatrix4 } from '../../core/src/spatial-math.js';
import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { z } from 'zod';
import { validateGlb } from '../../../apps/desktop/src/glb-preflight.js';
import { decodeMaterialPng, MaterialPngError } from './material-png.js';

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

export type HostGeneratedStudioImport = z.input<typeof inputSchema>;
export type StudioImportSelection = Pick<HostGeneratedStudioImport, 'target' | 'placement' | 'studsPerMeter'>;
export type StudioImportManifest = DeepReadonly<z.infer<typeof manifestSchema>>;
export type StudioImportBaseline = z.input<typeof baselineSchema>;
type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
/** A serialized/lookalike token never admits files or a previous Studio receipt. */
export interface StudioImportAdmission { readonly kind: 'studio-import-admission' }
export interface StudioImportRevisionDelta {
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
export interface PreparedStudioImport {
  readonly status: 'prepared';
  readonly manifest: StudioImportManifest;
  readonly delta: StudioImportRevisionDelta;
  readonly digest: string;
}
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
function snapshot(value: unknown, limits: Limits): unknown {
  let values = 0, bytes = 0;
  const seen = new Set<object>();
  const typed = Object.getPrototypeOf(Uint8Array.prototype) as object;
  const internal = (key: string, v: object): unknown => Object.getOwnPropertyDescriptor(typed, key)!.get!.call(v);
  const walk = (v: unknown, depth: number): unknown => {
    if (++values > 60_000 || depth > 32) fail('BUDGET', 'Metadata complexity budget exceeded.');
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
    if (prototype !== (array ? Array.prototype : Object.prototype) && prototype !== null) fail('SCHEMA', 'Expected plain metadata.');
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
function compile(input: z.infer<typeof inputSchema>, limits: Limits): z.infer<typeof manifestSchema> {
  bound(input.files.length, limits.files, 'File count'); unique(input.files.map(f => f.fileId), 'file ID'); unique(input.models.map(m => m.fileId), 'model ID');
  bound(input.models.reduce((n, m) => n + m.objects.length, 0), limits.objects, 'Source objects');
  const files = new Map(input.files.map(f => [f.fileId, f])), used = new Set<string>();
  for (const f of input.files) if (byteHash(f.bytes) !== f.sha256) fail('EXPORT', 'Generated file hash mismatch.');
  const objects: z.infer<typeof objectManifest>[] = [], textures = new Map<string, z.infer<typeof textureManifest>>(), materials = new Map<string, z.infer<typeof materialManifest>>();
  let triangles = 0, pixels = 0;
  for (const model of input.models) {
    const { doc, bin } = readModel(model, files, used, limits), nodes: Obj[] = doc.nodes ?? [], parents = new Map<number, number>();
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
        if ((p.mode ?? 4) !== 4 || p.targets || p.extensions || Object.keys(p.attributes).some(k => !['POSITION', 'NORMAL', 'TANGENT', 'TEXCOORD_0', 'COLOR_0'].includes(k))) fail('EXPORT', 'Static import requires baked triangle primitives and UV0.');
        const vertexCount = doc.accessors[p.attributes.POSITION].count as number;
        bound(vertexCount, limits.meshTriangles * 3, 'Per-mesh vertices');
        count += (p.indices === undefined ? vertexCount : doc.accessors[p.indices].count) / 3;
        bound(count, limits.meshTriangles, 'Per-mesh triangles');
        const attrs = Object.fromEntries(Object.keys(p.attributes).sort().map(k => [k, accessor(doc, bin, p.attributes[k])])), pts = attrs.POSITION!;
        const indices = p.indices === undefined ? pts.map((_, i) => [i]) : accessor(doc, bin, p.indices);
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
      if (scale.some(n => n <= 0) || determinant <= 0) fail('EXPORT', 'Bake singular or mirrored transforms before import.');
      if (source.role === 'collision' && materialSha256 !== null) fail('EXPORT', 'Collision proxies must not carry materials.');
      let parent = parents.get(source.nodeIndex);
      while (parent !== undefined && !sourceNodes.has(parent)) parent = parents.get(parent);
      const material = materialSha256 ? materials.get(materialSha256)! : null;
      const textureSha256s = material ? sorted([material.colorMap, material.normalMap, material.roughnessMap, material.metalnessMap, material.emission?.map].flatMap(m => m ? [m.sha256] : [])) : [];
      objects.push(parse(objectManifest, { ...source, name: node.name ?? mesh.name ?? source.sourceObjectId, parentSourceObjectId: parent === undefined ? null : sourceNodes.get(parent),
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
  const content = parse(manifestContent, { schemaVersion: 1, status: 'prepared', engineVerification: 'pending', projectId: input.projectId, assetId: input.assetId,
    revisionId: input.revisionId, sourceSha256: input.sourceSha256, producer: input.producer, target: input.target, placement: input.placement,
    conversion: { sourceUnits: 'meters', sourceUp: 'Z', exportUnits: 'meters', exportUp: 'Y', targetUnits: 'studs', targetUp: 'Y', studsPerMeter: input.studsPerMeter },
    files: input.files.map(f => ({ fileId: f.fileId, contentType: f.contentType, sha256: f.sha256, byteLength: f.bytes.length })).sort((a, b) => compare(a.fileId, b.fileId)),
    objects: objects.sort((a, b) => compare(a.sourceObjectId, b.sourceObjectId)), materials: [...materials.values()].sort((a, b) => compare(a.sha256, b.sha256)),
    textures: [...textures.values()].map(t => ({ ...t, locations: t.locations.sort((a, b) => compare(a.fileId, b.fileId) || a.imageIndex - b.imageIndex) })).sort((a, b) => compare(a.sha256, b.sha256)),
    anchors: input.anchors.sort((a, b) => compare(a.sourceAnchorId, b.sourceAnchorId)), bounds: measuredBounds(objects.filter(o => o.role === 'render').flatMap(o => [o.worldBounds.min, o.worldBounds.max])),
    limitations: ['Prepared files are not uploaded, moderated, inserted or verified in Studio.', 'Axes, scale, placement, collision and appearance require in-engine verification.',
      'PBR factors, alpha modes and packed G/B maps require host-supported baking/conversion before SurfaceAppearance assignment.', 'LOD switching, rigs and animation require separate supported adapters.'] });
  bound(Buffer.byteLength(canonical(content)), limits.manifestBytes, 'Manifest bytes');
  return { ...content, digest: digest(content) };
}

function revision(next: z.infer<typeof manifestSchema>, baseline: z.infer<typeof baselineSchema> | null): StudioImportRevisionDelta {
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
  loadGeneratedFiles(jobId: string): Promise<HostGeneratedStudioImport>;
  limits?: Partial<Record<keyof Limits, number>>;
}): StudioImportManifestAuthority {
  if (!options || typeof options !== 'object' || types.isProxy(options)) fail('AUTHORITY', 'Host loader is required.');
  const descriptors = Object.getOwnPropertyDescriptors(options);
  if (Reflect.ownKeys(options).some(k => k !== 'loadGeneratedFiles' && k !== 'limits') ||
      !descriptors.loadGeneratedFiles || !Object.hasOwn(descriptors.loadGeneratedFiles, 'value') || typeof descriptors.loadGeneratedFiles.value !== 'function' ||
      descriptors.limits && !Object.hasOwn(descriptors.limits, 'value')) fail('AUTHORITY', 'Expected host-code loader and limits.');
  const load = descriptors.loadGeneratedFiles.value as (jobId: string) => Promise<HostGeneratedStudioImport>;
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
      const input = parse(inputSchema, snapshot(raw, limits));
      if (input.revisionId !== requested) fail('AUTHORITY', 'Host-generated revision does not match requested job.');
      const manifest = compile(input, limits), delta = revision(manifest, input.baseline);
      const prepared = freeze({ status: 'prepared' as const, manifest, delta, digest: digest({ manifestDigest: manifest.digest, delta }) });
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
