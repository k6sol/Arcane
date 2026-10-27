import { decodeEmbeddedStudioImages, materialStudioTexturePixels, studioTextureUse, StudioTextureError, STUDIO_TEXTURE_LIMITS, type StudioTexturePixels, type StudioTextureSlot, type StudioEmbeddedImages } from './studio-import-textures.js';
import { SpatialMathError, matrixFromTrs, multiplyMatrix4 } from '../../core/src/spatial-math.js';
import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { validateGlb } from '../../../apps/desktop/src/glb-preflight.js';
import { STUDIO_IMPORT_LIMITS, type PreparedStudioImport, type StudioImportManifest, type GeneratedPreparedStudioImportV1, type ConvertedPreparedStudioImportV2, type GeneratedStudioImportManifestV1, type ConvertedStudioImportManifestV2 } from './studio-import-manifest.js';
import { parseNativeStudioImportResponse } from './studio-import-wire.js';
import { STUDIO_RECONSTRUCTION_LIMITS } from '../../protocol/src/studio.js';
import { CONVERSION_NODE_KEY, CONVERSION_VERTEX_ID, conversionCorrespondenceSha256 } from './conversion-fidelity-policy.js';
import { parseConvertedGraph, STUDIO_IMPORT_GRAPH_LIMITS, type ConvertedGraphV1, type ConvertedGraphMesh } from './studio-import-graph.js';
import { type ConvertedGlbRequest } from './converted-glb.js';

/** Data conversion only. Main must bind the SAME native actor, owned job and target.
 * Neither digests nor this pending payload grant upload/Studio/engine authority. */
export const STUDIO_IMPORT_PAYLOAD_VERSION = 1;
export const CONVERTED_STUDIO_IMPORT_PAYLOAD_VERSION = 2;
// Data provenance only; possession never grants upload/editor authority.
const decodedPayloads = new WeakSet<object>();
export function assertDecodedStudioImportPayload(value: StudioImportPayload): void {
  if (!value || typeof value !== 'object' || !decodedPayloads.has(value)) {
    throw new StudioImportPayloadError('SCHEMA', 'Expected a decoded payload from this process, not serialized claims.');
  }
}
export const STUDIO_IMPORT_PAYLOAD_LIMITS = Object.freeze({
  chunkBytes: 180 * 1024, encodedChunkBytes: 256 * 1024 - 4096,
  binaryBytes: 32 * 1024 * 1024, encodedBytes: 48 * 1024 * 1024, chunks: 4096,
  meshVertices: 60_000,
});
type Limits = { -readonly [K in keyof typeof STUDIO_IMPORT_PAYLOAD_LIMITS]: number };
type Json = Record<string, any>; // Bounded JSON parsed locally; never caller objects.
type MeshSemantic = 'POSITION' | 'NORMAL' | 'TEXCOORD_0' | 'indices';
type Semantic = MeshSemantic | StudioTextureSlot;
type SourceObject = GeneratedStudioImportManifestV1['objects'][number];
export class StudioImportPayloadError extends Error {
  constructor(public readonly code: 'SCHEMA' | 'CHECKSUM' | 'BUDGET' | 'EXPORT' | 'MAPPING' | 'UNSUPPORTED_ATTRIBUTE' | 'UNSUPPORTED_MATERIAL' | 'UNSUPPORTED_TEXTURE' | 'UNSUPPORTED_TRANSFORM', message: string) {
    super(message); this.name = 'StudioImportPayloadError';
  }
}
export interface GeneratedStudioImportPayloadChunkV1 {
  readonly formatVersion: 1; readonly manifestDigest: string; readonly sourceObjectId: string;
  readonly primitiveIndex: number; readonly semantic: Semantic; readonly bufferSha256: string;
  readonly offset: number; readonly byteLength: number; readonly sha256: string;
  readonly encoding: 'base64'; readonly data: string;
}
export interface ConvertedStudioImportPayloadChunkV2 extends Omit<GeneratedStudioImportPayloadChunkV1,'formatVersion'> {readonly formatVersion:2}
export type StudioImportPayloadChunk=GeneratedStudioImportPayloadChunkV1|ConvertedStudioImportPayloadChunkV2;
export interface StudioImportPayloadBuffer {
  readonly semantic: Semantic; readonly componentType: 5121 | 5123 | 5125 | 5126;
  readonly type: 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4'; readonly count: number; readonly normalized: boolean;
  readonly byteLength: number; readonly sha256: string;
  /** Caller-owned copy, densely packed little endian; never aliases input or another stream.
   * Typed-array elements cannot be frozen. Immutable chunks/digests bind the original copy. */
  readonly bytes: Uint8Array;
  readonly source: Readonly<{ accessorIndex: number; accessor: Readonly<Record<string, unknown>>; bufferView: Readonly<Record<string, unknown>> }> | null;
  readonly chunks: readonly StudioImportPayloadChunk[];
}
export interface StudioImportPayloadTexture extends StudioImportPayloadBuffer, StudioTexturePixels {
  readonly semantic: StudioTextureSlot; readonly componentType: 5121; readonly type: 'VEC4';
}
export interface StudioImportPayloadPrimitive {
  readonly mode: 4; readonly vertexCount: number; readonly triangleCount: number;
  readonly attributes: Readonly<Partial<Record<Exclude<MeshSemantic, 'indices'>, StudioImportPayloadBuffer>>>;
  readonly indices: StudioImportPayloadBuffer;
  readonly source: Readonly<Record<string, unknown>>;
}
export interface GeneratedStudioImportPayloadObjectV1 {
  readonly object: SourceObject;
  readonly material: StudioImportManifest['materials'][number] | null;
  readonly textureBindings?: Readonly<Partial<Record<StudioTextureSlot, string>>>;
  readonly primitives: readonly StudioImportPayloadPrimitive[];
  readonly provenance: Readonly<{ generator: string; node: Readonly<Record<string, unknown>>; mesh: Readonly<Record<string, unknown>>; material: Readonly<Record<string, unknown>> | null }>;
}
export interface GeneratedStudioImportPayloadV1 {
  readonly formatVersion: 1; readonly engineVerification: 'pending'; readonly digest: string;
  readonly preparedDigest: string; readonly manifestDigest: string;
  readonly projectId: string; readonly assetId: string; readonly revisionId: string; readonly sourceSha256: string;
  readonly producer: GeneratedStudioImportManifestV1['producer']; readonly files: GeneratedStudioImportManifestV1['files'];
  readonly conversion: GeneratedStudioImportManifestV1['conversion']; readonly placement: GeneratedStudioImportManifestV1['placement'];
  readonly bounds: GeneratedStudioImportManifestV1['bounds']; readonly anchors: GeneratedStudioImportManifestV1['anchors'];
  /** Original bounded GLB JSON, including anchor/ancestor extras and raw accessor semantics. */
  readonly sourceDocuments: readonly Readonly<{ fileId: string; jsonSha256: string; document: Readonly<Record<string, unknown>> }>[];
  readonly objects: readonly GeneratedStudioImportPayloadObjectV1[];
  readonly textures?: readonly StudioImportPayloadTexture[];
  readonly binaryByteLength: number; readonly aggregateEncodedByteLength: number; readonly chunkCount: number;
}
/** Host proof only; these IDs never become mesh authoring attributes/chunks. */
export interface ConvertedStudioImportCorrespondenceV2 {
  readonly semantic:'_ARCANE_SOURCE_VERTEX_ID';readonly accessorIndex:number;readonly count:number;
  readonly sha256:string;readonly orientedTriangleSha256:string;readonly ids:readonly number[];
  readonly accessor:Readonly<Record<string,unknown>>;readonly bufferView:Readonly<Record<string,unknown>>;
}
export interface ConvertedStudioImportPayloadPrimitiveV2 extends StudioImportPayloadPrimitive {readonly correspondence:ConvertedStudioImportCorrespondenceV2|null}
export interface ConvertedStudioImportPayloadObjectV2 extends Omit<GeneratedStudioImportPayloadObjectV1,'object'|'primitives'> {
  readonly object:ConvertedStudioImportManifestV2['objects'][number];readonly association:ConvertedGraphMesh;
  readonly primitives:readonly ConvertedStudioImportPayloadPrimitiveV2[];
}
export type StudioImportPayloadObject=GeneratedStudioImportPayloadObjectV1|ConvertedStudioImportPayloadObjectV2;
export interface ConvertedStudioImportPayloadV2 extends Omit<GeneratedStudioImportPayloadV1,'formatVersion'|'objects'|'conversion'|'anchors'> {
  readonly formatVersion:2;readonly origin:'converted-glb';readonly identityScheme:'arcane-converted-v2';
  readonly conversionRequest:ConvertedGlbRequest;readonly graph:ConvertedGraphV1;
  readonly conversion:ConvertedStudioImportManifestV2['conversion'];readonly anchors:ConvertedStudioImportManifestV2['anchors'];
  readonly objects:readonly ConvertedStudioImportPayloadObjectV2[];
}
export type StudioImportPayload=GeneratedStudioImportPayloadV1|ConvertedStudioImportPayloadV2;
function fail(code: StudioImportPayloadError['code'], message: string): never { throw new StudioImportPayloadError(code, message); }
const sha = (v: Uint8Array | string) => createHash('sha256').update(v).digest('hex');
function canonical(v: unknown): string {
  if (types.isUint8Array(v)) return canonical({ byteLength: v.byteLength, sha256: sha(v) });
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v !== null && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical((v as Json)[k])).join(',') + '}';
  return JSON.stringify(v);
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
function freeze<T>(v: T): T {
  if (v && typeof v === 'object' && !types.isUint8Array(v)) { for (const x of Object.values(v)) freeze(x); Object.freeze(v); }
  return v;
}
function bound(v: number, max: number, label: string, min = 0): number {
  if (!Number.isSafeInteger(v) || v < min || v > max) fail('BUDGET', label + ' bound exceeded.'); return v;
}
function field(v: unknown, key: string): unknown {
  if (!v || typeof v !== 'object' || types.isProxy(v)) fail('SCHEMA', 'Expected data record.');
  const d = Object.getOwnPropertyDescriptor(v, key);
  if (!d || !Object.hasOwn(d, 'value')) fail('SCHEMA', 'Missing data field ' + key + '.'); return d.value;
}
const typed = Object.getPrototypeOf(Uint8Array.prototype) as object;
function owned(v: unknown, length: number): Buffer {
  if (types.isProxy(v) || !types.isUint8Array(v)) fail('SCHEMA', 'Expected nonshared Uint8Array export.');
  const slot = (key: string): any => Object.getOwnPropertyDescriptor(typed, key)!.get!.call(v);
  try {
    if (types.isSharedArrayBuffer(slot('buffer'))) fail('SCHEMA', 'Shared export bytes refused.');
    if (slot('byteLength') !== length) fail('CHECKSUM', 'Export byte length differs from prepared manifest.');
    return Buffer.from(new Uint8Array(slot('buffer'), slot('byteOffset'), length));
  } catch (e) { if (e instanceof StudioImportPayloadError) throw e; return fail('SCHEMA', 'Detached export bytes refused.'); }
}
function keys(o: Json, allowed: string[], path = '$', code: StudioImportPayloadError['code'] = 'EXPORT'): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(code, path + '.' + k + ' is unsupported.');
}
const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function multiply(a: number[], b: number[]): number[] {
  try { return multiplyMatrix4(a, b); }
  catch (error) { if (error instanceof SpatialMathError) fail('UNSUPPORTED_TRANSFORM', 'Invalid affine import transform.'); throw error; }
}
function local(n: Json): number[] {
  if (n.matrix) return n.matrix;
  try { return matrixFromTrs(n.translation, n.rotation, n.scale); }
  catch (error) { if (error instanceof SpatialMathError) fail('UNSUPPORTED_TRANSFORM', 'Invalid affine import transform.'); throw error; }
}
function rigid(m: readonly number[]): number[] {
  if (m.length !== 16 || m.some(n => !Number.isFinite(n) || Math.abs(n) > 1_000_000) || m[3] !== 0 || m[7] !== 0 || m[11] !== 0 || m[15] !== 1) fail('UNSUPPORTED_TRANSFORM', 'Invalid bounded affine transform.');
  const scale = [0, 4, 8].map(at => Math.hypot(...m.slice(at, at + 3)));
  const det = m[0]!*(m[5]!*m[10]!-m[6]!*m[9]!)-m[4]!*(m[1]!*m[10]!-m[2]!*m[9]!)+m[8]!*(m[1]!*m[6]!-m[2]!*m[5]!);
  if (scale.some(n => n <= 0) || det <= 0 || [[0,1],[0,2],[1,2]].some(([a,b]) => Math.abs([0,1,2].reduce((s,r)=>s+m[a!*4+r]!*m[b!*4+r]!,0)/(scale[a!]!*scale[b!]!)) > 1e-6)) fail('UNSUPPORTED_TRANSFORM', 'Shear, singular or mirrored transform requires baking.');
  return scale;
}
function document(bytes: Buffer, producer: StudioImportManifest['producer'], converted=false): { doc: Json; bin: Buffer } {
  if (bytes.length < 28 || bytes.length % 4 || bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) fail('EXPORT', 'Invalid exact GLB v2 header.');
  const n = bound(bytes.readUInt32LE(12), STUDIO_IMPORT_LIMITS.jsonBytes, 'GLB JSON', 1), at = 20 + n;
  if (n % 4 || bytes.readUInt32LE(16) !== 0x4e4f534a || at + 8 > bytes.length || bytes.readUInt32LE(at + 4) !== 0x004e4942 || at + 8 + bytes.readUInt32LE(at) !== bytes.length) fail('EXPORT', 'Expected exact JSON/BIN GLB chunks.');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(20, at)); } catch { return fail('EXPORT', 'Invalid GLB UTF-8.'); }
  let depth = 0, tokens = 0, quoted = false, escaped = false;
  for (const c of text) {
    if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue; }
    if (c === '"') quoted = true;
    if ('[{'.includes(c)) bound(++depth, 32, 'JSON depth');
    if (']}'.includes(c)) depth--;
    if (',:[{'.includes(c)) bound(++tokens, 60_000, 'JSON complexity');
  }
  let doc: Json;
  try { doc = JSON.parse(text) as Json; } catch { return fail('EXPORT', 'Invalid GLB JSON.'); }
  // The general gate validates every view/accessor/sample, even unused ones.
  try { validateGlb(bytes); } catch (e) { return fail('EXPORT', e instanceof Error ? e.message : 'GLB preflight failed.'); }
  keys(doc, ['asset','buffers','bufferViews','accessors','meshes','nodes','scenes','scene','materials','extras','extensionsUsed','extensionsRequired','skins','animations','images','textures','samplers','cameras']);
  if ((doc.skins?.length ?? 0) || (doc.animations?.length ?? 0) || (doc.cameras?.length ?? 0)) fail('EXPORT', 'Only static mesh/anchor nodes are supported.');
  if (converted?doc.asset.generator!==producer.exporterVersion:doc.asset.generator !== producer.exporterVersion.replace(' IO ', ' I/O ') || !/^Khronos glTF Blender I\/O v[0-9]+(?:\.[0-9]+){1,3}$/.test(doc.asset.generator)) fail('MAPPING', 'Export generator differs from prepared producer.');
  bound((doc.images ?? []).length, STUDIO_IMPORT_LIMITS.textures, 'Image count');
  bound((doc.textures ?? []).length, STUDIO_IMPORT_LIMITS.textures, 'Texture count');
  bound((doc.samplers ?? []).length, STUDIO_IMPORT_LIMITS.textures, 'Sampler count');
  if ([...(doc.extensionsUsed ?? []), ...(doc.extensionsRequired ?? [])].some(k => k !== 'KHR_materials_emissive_strength')) fail('EXPORT', 'Unsupported static export extension.');
  for (const a of doc.accessors ?? []) if (a.sparse || a.bufferView === undefined) fail('EXPORT', 'Dense bufferView-backed accessors required.');
  for (const m of doc.meshes) {
    keys(m, ['name','primitives','extras']);
    for (const p of m.primitives) {
      keys(p, ['attributes','indices','material','mode','extras']);
      if ((p.mode ?? 4) !== 4) fail('EXPORT', 'Triangle primitives required.');
      keys(p.attributes, converted?['POSITION','NORMAL','TEXCOORD_0',CONVERSION_VERTEX_ID]:['POSITION','NORMAL','TEXCOORD_0'], 'attributes', 'UNSUPPORTED_ATTRIBUTE');
    }
  }
  for (const n of doc.nodes) keys(n, ['name','mesh','children','matrix','translation','rotation','scale','extras']);
  bound((doc.materials ?? []).length, STUDIO_IMPORT_LIMITS.materials, 'Materials');
  return { doc, bin: bytes.subarray(at + 8, at + 8 + doc.buffers[0].byteLength) };
}
function material(m: Json, doc: Json, images: StudioEmbeddedImages, version:1|2=1): Json {
  for (const k of ['occlusionTexture','emissiveTexture']) if (m[k] !== undefined) fail('UNSUPPORTED_TEXTURE', 'Material ' + k + ' remains unsupported; bake it into supported maps.');
  keys(m, ['name','extras','pbrMetallicRoughness','normalTexture','alphaMode','alphaCutoff','doubleSided','emissiveFactor','extensions'], 'material', 'UNSUPPORTED_MATERIAL');
  const p = m.pbrMetallicRoughness ?? {}, ext = m.extensions ?? {};
  keys(p, ['baseColorFactor','metallicFactor','roughnessFactor','baseColorTexture','metallicRoughnessTexture','extras'], 'pbr', 'UNSUPPORTED_MATERIAL');
  keys(ext, ['KHR_materials_emissive_strength'], 'material.extensions', 'UNSUPPORTED_MATERIAL');
  const factor = m.emissiveFactor ?? [0,0,0], strength = ext.KHR_materials_emissive_strength?.emissiveStrength ?? 1;
  // glTF MASK is an exact per-texel cutout (alpha >= alphaCutoff); BLEND is never approximated.
  const alphaMode = m.alphaMode ?? 'OPAQUE', alphaCutoff = m.alphaCutoff ?? 0.5;
  if ((alphaMode !== 'OPAQUE' && alphaMode !== 'MASK') || (p.baseColorFactor?.[3] ?? 1) !== 1) fail('UNSUPPORTED_MATERIAL', 'Payload v'+version+' requires OPAQUE or MASK with baseColorFactor alpha=1; BLEND is not approximated.');
  if (typeof alphaCutoff !== 'number' || !Number.isFinite(alphaCutoff) || alphaCutoff < 0 || alphaCutoff > 1) fail('UNSUPPORTED_MATERIAL', 'alphaCutoff must be finite within [0,1].');
  return { baseColor: p.baseColorFactor ?? [1,1,1,1], metallic: p.metallicFactor ?? 1, roughness: p.roughnessFactor ?? 1,
    alphaMode, alphaCutoff, doubleSided: m.doubleSided ?? false, normalScale: m.normalTexture?.scale ?? 1,
    colorMap: studioTextureUse(p.baseColorTexture, 'rgba', doc, images), normalMap: studioTextureUse(m.normalTexture, 'rgb', doc, images),
    roughnessMap: studioTextureUse(p.metallicRoughnessTexture, 'g', doc, images), metalnessMap: studioTextureUse(p.metallicRoughnessTexture, 'b', doc, images),
    ...(factor.some((n: number) => n !== 0) || m.extensions?.KHR_materials_emissive_strength ? { emission: { factor, strength, map: null } } : {}) };
}

function measured(points: number[][]): { min: number[]; max: number[] } {
  return { min: [0,1,2].map(i => points.reduce((n,p)=>Math.min(n,p[i]!),Infinity)), max: [0,1,2].map(i => points.reduce((n,p)=>Math.max(n,p[i]!),-Infinity)) };
}
/** Re-read every prepared export from owned bytes, never recipes or paths. Throws
 * before returning anything on unsupported data. No uploader/callback/effect exists.
 * Binary copies are mutable caller data; frozen chunks preserve exact upload bytes.
 * Finite UV0 tiling is preserved within +/-1e6; sampling conversion stays pending.
 * Future transport must validate its final envelope within the reserved 4096 bytes. */
function decodeGeneratedStudioImportPayloadV1(prepared: PreparedStudioImport, files: ReadonlyMap<string, Uint8Array>, tighten: Partial<Record<keyof Limits, number>> = {}): GeneratedStudioImportPayloadV1 {
  const revision = field(field(prepared, 'manifest'), 'revisionId');
  if (typeof revision !== 'string') fail('SCHEMA', 'Expected prepared revision.');
  let plan: GeneratedPreparedStudioImportV1;
  try { const parsed=parseNativeStudioImportResponse({ prepared }, revision).prepared;if(!generatedPrepared(parsed))fail('SCHEMA','Expected generated v1 preparation.');plan=parsed; } catch { return fail('SCHEMA', 'Prepared schema or digest mismatch.'); }
  const manifest = plan.manifest, limits: Limits = { ...STUDIO_IMPORT_PAYLOAD_LIMITS };
  if (types.isProxy(tighten) || Object.getPrototypeOf(tighten) !== Object.prototype) fail('SCHEMA', 'Expected plain limits.');
  for (const k of Reflect.ownKeys(tighten)) {
    if (typeof k !== 'string' || !Object.hasOwn(limits,k)) fail('BUDGET', 'Unknown payload limit.');
    limits[k as keyof Limits] = bound(field(tighten,k) as number, limits[k as keyof Limits], 'Tightened '+k, 1);
  }
  if (types.isProxy(files) || !(files instanceof Map)) fail('SCHEMA', 'Expected host-owned Map of exports.');
  const count = Object.getOwnPropertyDescriptor(Map.prototype,'size')!.get!.call(files) as number;
  if (count !== manifest.files.length) fail('CHECKSUM', 'Exact prepared export set required.');
  const copies = new Map<string, Buffer>(); let inputBytes = 0;
  for (const f of manifest.files) {
    if (f.contentType !== 'model/gltf-binary') fail('EXPORT', 'Payload v1 supports owned static GLB exports only.');
    inputBytes = bound(inputBytes + f.byteLength, STUDIO_IMPORT_LIMITS.totalBytes, 'Export aggregate bytes');
    const bytes = owned(Map.prototype.get.call(files,f.fileId), f.byteLength);
    if (sha(bytes) !== f.sha256) fail('CHECKSUM', 'Export SHA-256 mismatch: ' + f.fileId); copies.set(f.fileId, bytes);
  }
  const textureMaps = new Map<string, StudioImportPayloadTexture>(), imageLocations = new Set<string>();
  const textureError = (error: unknown): never => { if (error instanceof StudioTextureError) fail(error.code, error.message); throw error; };
  let binary = 0, encoded = 0, chunks = 0, triangles = 0;
  const objects: GeneratedStudioImportPayloadObjectV1[] = [], seenAnchors = new Set<string>(), usedMaterials = new Set<string>();
  const sourceDocuments: { fileId: string; jsonSha256: string; document: Readonly<Record<string, unknown>> }[] = [];
  const buffer = (raw: Uint8Array, semantic: Semantic, componentType: StudioImportPayloadBuffer['componentType'], type: StudioImportPayloadBuffer['type'], count: number, normalized: boolean, source: StudioImportPayloadBuffer['source'], o: Pick<SourceObject, 'sourceObjectId'>, primitiveIndex: number): StudioImportPayloadBuffer => {
    const hash = sha(raw), records: GeneratedStudioImportPayloadChunkV1[] = [];
    for (let offset = 0; offset < raw.length; offset += limits.chunkBytes) {
      const part = raw.subarray(offset, offset + limits.chunkBytes);
      const record: GeneratedStudioImportPayloadChunkV1 = { formatVersion: 1, manifestDigest: manifest.digest, sourceObjectId: o.sourceObjectId, primitiveIndex, semantic, bufferSha256: hash, offset, byteLength: part.length, sha256: sha(part), encoding: 'base64', data: Buffer.from(part).toString('base64') };
      encoded += bound(Buffer.byteLength(JSON.stringify(record)), limits.encodedChunkBytes, 'Encoded chunk');
      bound(encoded, limits.encodedBytes, 'Encoded aggregate'); bound(++chunks, limits.chunks, 'Chunk count'); records.push(record);
    }
    return { semantic, componentType, type, count, normalized, byteLength: raw.length, sha256: hash, bytes: raw, source, chunks: records };
  };
  for (const [fileId, bytes] of copies) {
    const { doc, bin } = document(bytes, manifest.producer), nodes: Json[] = doc.nodes ?? [], parents = new Map<number,number>(), worlds = new Map<number,number[]>();
    sourceDocuments.push({fileId,jsonSha256:sha(bytes.subarray(20,20+bytes.readUInt32LE(12))),document:doc});
    nodes.forEach((n,i)=>(n.children??[]).forEach((c:number)=>parents.set(c,i)));
    const world = (i:number): number[] => { if (!worlds.has(i)) { const p=parents.get(i), m=multiply(p===undefined?I:world(p),local(nodes[i]!)); rigid(m); worlds.set(i,m); } return worlds.get(i)!; };
    nodes.forEach((n,i)=>{ rigid(local(n)); world(i); });
    if (doc.scenes?.length !== 1 || (doc.scene ?? 0) !== 0 || !same([...(doc.scenes[0].nodes ?? [])].sort((a,b)=>a-b),nodes.map((_,i)=>i).filter(i=>!parents.has(i)))) fail('MAPPING', 'All exported roots must belong to the one active scene.');
    const mapped = manifest.objects.filter(o=>o.exportFileId===fileId), byNode = new Map(mapped.map(o=>[o.nodeIndex,o]));
    if (byNode.size !== mapped.length || mapped.length !== nodes.filter(n=>n.mesh!==undefined).length) fail('MAPPING', 'Every mesh node requires one unique prepared object.');
    let images: StudioEmbeddedImages, materials: Json[];
    try { images = decodeEmbeddedStudioImages(doc, bin, manifest, fileId, limits.binaryBytes); materials = (doc.materials ?? []).map((m: Json) => material(m, doc, images)); }
    catch (error) { return textureError(error); }
    images.hashes.forEach((_, i) => imageLocations.add(fileId + '\0' + i));
    for (const m of materials) {
      const hash = sha(canonical(m)), source = manifest.materials.find(v => v.sha256 === hash && same(v, {...m, sha256: hash}));
      if (!source) fail('CHECKSUM', 'Material differs from prepared material.'); usedMaterials.add(hash);
      if ([...textureMaps.values()].some(map => map.materialSha256 === hash)) continue;
      let maps: StudioTexturePixels[];
      try { maps = materialStudioTexturePixels(source, images, limits.binaryBytes - binary); } catch (error) { return textureError(error); }
      for (const map of maps) if (!textureMaps.has(map.imageId)) {
        bound(textureMaps.size + 1, STUDIO_TEXTURE_LIMITS.maps, 'Texture map count');
        binary = bound(binary + map.bytes.byteLength, limits.binaryBytes, 'Decoded texture/mesh aggregate');
        const stream = buffer(map.bytes, map.semantic, 5121, 'VEC4', map.width * map.height, false, null, {sourceObjectId: 'texture-' + map.imageId}, -1);
        textureMaps.set(map.imageId, {...stream, ...map, componentType: 5121, type: 'VEC4'});
      }
    }
    for (const o of mapped) {
      const n=nodes[o.nodeIndex], e=n?.extras, mesh=doc.meshes[n?.mesh];
      if (new Set(o.collisionFor).size!==o.collisionFor.length) fail('MAPPING','Duplicate collision target.');
      if (!n || n.mesh===undefined || !e || e.arcane_identity_scheme!=='arcane-semantic-v1' || !/^arcane_[a-f0-9]{64}$/.test(o.sourceObjectId) || e.arcane_source_object_id!==o.sourceObjectId || e.arcane_role!==o.role || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(e.arcane_source_key) || !same(e.arcane_pivot,o.pivot) || e.arcane_collision_for!==JSON.stringify(o.collisionFor)) fail('MAPPING', 'Prepared role/object/node disagrees with generator extras.');
      const transform=world(o.nodeIndex); let parent=parents.get(o.nodeIndex);
      while (parent!==undefined&&!byNode.has(parent)) parent=parents.get(parent);
      if (!same(transform,o.exportTransform)||!same(rigid(transform),o.scale)||o.parentSourceObjectId!==(parent===undefined?null:byNode.get(parent)!.sourceObjectId)||o.name!==(n.name??mesh.name??o.sourceObjectId)) fail('MAPPING', 'Prepared transform/parent/name disagrees with export.');
      const primitives: StudioImportPayloadPrimitive[] = [], geometry: Json[] = [], positions: number[][] = [], slots=new Set<number|null>(); let vertices=0, objectTriangles=0;
      for (const [pi,p] of (mesh.primitives as Json[]).entries()) {
        const values: Record<string,number[][]> = {}, attrs: Partial<Record<Exclude<MeshSemantic,'indices'>,StudioImportPayloadBuffer>> = {};
        const read = (ai:number, semantic:MeshSemantic): StudioImportPayloadBuffer => {
          const a=doc.accessors[ai], v=doc.bufferViews[a.bufferView], width=a.componentType===5121?1:a.componentType===5123?2:4, size=a.type==='SCALAR'?1:a.type==='VEC2'?2:3;
          if (semantic==='indices' ? a.type!=='SCALAR'||![5121,5123,5125].includes(a.componentType)||a.normalized||v.byteStride!==undefined : a.type!==(semantic==='TEXCOORD_0'?'VEC2':'VEC3') || (semantic==='TEXCOORD_0'?![5121,5123,5126].includes(a.componentType)||a.componentType!==5126&&!a.normalized:a.componentType!==5126)) fail('UNSUPPORTED_ATTRIBUTE','Unsupported dense '+semantic+' format.');
          bound(a.count,semantic==='indices'?STUDIO_IMPORT_LIMITS.meshTriangles*3:limits.meshVertices,'Accessor count',1);
          const stride=v.byteStride??size*width, offset=a.byteOffset??0, start=(v.byteOffset??0)+offset, length=a.count*size*width;
          if (offset%width||start%width||stride<size*width||offset+(a.count-1)*stride+size*width>v.byteLength||start+(a.count-1)*stride+size*width>bin.length) fail('EXPORT','Dense accessor range/stride/alignment mismatch.');
          binary=bound(binary+length,limits.binaryBytes,'Binary aggregate'); const raw=new Uint8Array(length), rows:number[][]=[];
          for (let i=0;i<a.count;i++) { const row:number[]=[]; raw.set(bin.subarray(start+i*stride,start+i*stride+size*width),i*size*width);
            for (let c=0;c<size;c++) { const at=start+i*stride+c*width; let x=a.componentType===5126?bin.readFloatLE(at):width===4?bin.readUInt32LE(at):width===2?bin.readUInt16LE(at):bin.readUInt8(at);
              if (a.normalized) x/=width===1?255:65535;
              if (!Number.isFinite(x)||Math.abs(x)>1_000_000) fail('EXPORT','Nonfinite/out-of-bounds '+semantic+' sample.'); row.push(Object.is(x,-0)?0:x); }
            rows.push(row); }
          values[semantic]=rows; return buffer(raw,semantic,a.componentType,a.type,a.count,a.normalized??false,{accessorIndex:ai,accessor:a,bufferView:v},o,pi);
        };
        for (const k of Object.keys(p.attributes).sort()) attrs[k as keyof typeof attrs]=read(p.attributes[k],k as MeshSemantic);
        const pos=attrs.POSITION!;
        if (Object.values(attrs).some(a=>a.count!==pos.count)) fail('EXPORT','Attribute counts differ.');
        vertices=bound(vertices+pos.count,limits.meshVertices,'Per-object vertices'); positions.push(...values.POSITION!);
        let indices: StudioImportPayloadBuffer;
        if (p.indices!==undefined) indices=read(p.indices,'indices');
        else { binary=bound(binary+pos.count*4,limits.binaryBytes,'Implicit indices'); const raw=new Uint8Array(pos.count*4), v=new DataView(raw.buffer); for(let i=0;i<pos.count;i++)v.setUint32(i*4,i,true); values.indices=Array.from({length:pos.count},(_,i)=>[i]); indices=buffer(raw,'indices',5125,'SCALAR',pos.count,false,null,o,pi); }
        if (indices.count%3 || values.indices!.some(r=>r[0]!>=pos.count||r[0]===2**(indices.componentType===5121?8:indices.componentType===5123?16:32)-1)) fail('EXPORT','Invalid triangle indices.');
        // Independently enforce the same Arcane doubled-area policy as host
        // preparation; positive AABB extents do not prove a nondegenerate face.
        for(let at=0;at<values.indices!.length;at+=3){
          const a=values.POSITION![values.indices![at]![0]!]!,b=values.POSITION![values.indices![at+1]![0]!]!,c=values.POSITION![values.indices![at+2]![0]!]!;
          const u=b.map((n,i)=>n-a[i]!),v=c.map((n,i)=>n-a[i]!);
          if(Math.hypot(u[1]!*v[2]!-u[2]!*v[1]!,u[2]!*v[0]!-u[0]!*v[2]!,u[0]!*v[1]!-u[1]!*v[0]!)<=1e-10)
            fail('EXPORT','Degenerate triangle; doubled area must exceed 1e-10.');
        }
        objectTriangles=bound(objectTriangles+indices.count/3,STUDIO_IMPORT_LIMITS.meshTriangles,'Per-object triangles');
        slots.add(p.material??null); geometry.push({attributes:Object.fromEntries(Object.entries(values).filter(([k])=>k!=='indices')),indices:values.indices!.flat(),mode:4});
        primitives.push({mode:4,vertexCount:pos.count,triangleCount:indices.count/3,attributes:attrs,indices,source:p});
      }
      triangles=bound(triangles+objectTriangles,STUDIO_IMPORT_LIMITS.triangles,'Aggregate triangles');
      if (slots.size!==1||objectTriangles!==o.triangles||sha(canonical(geometry))!==o.meshExportSha256||!same(measured(positions),o.bounds)||!same(measured(positions.map(p=>[0,1,2].map(i=>transform[i]!*p[0]!+transform[4+i]!*p[1]!+transform[8+i]!*p[2]!+transform[12+i]!))),o.worldBounds)) fail('CHECKSUM','Prepared geometry/material-slot/bounds mismatch.');
      const slot=[...slots][0]!, mat=slot===null?null:materials[slot]!, hash=mat===null?null:sha(canonical(mat));
      if (hash!==o.materialSha256||o.role==='collision'&&hash!==null) fail('CHECKSUM','Prepared object material mismatch.');
      const bindings = Object.fromEntries([...textureMaps.values()].filter(t => t.materialSha256 === hash).map(t => [t.semantic, t.imageId]));
      if (Object.keys(bindings).length && primitives.some(p => !p.attributes.TEXCOORD_0)) fail('UNSUPPORTED_TEXTURE', 'Textured mesh primitives require UV0.');
      objects.push({object:o,material:hash===null?null:manifest.materials.find(m=>m.sha256===hash)!,primitives,
        ...(Object.keys(bindings).length ? {textureBindings: bindings} : {}),
        provenance:{generator:doc.asset.generator,node:n,mesh,material:slot===null?null:doc.materials[slot]}});
    }
    nodes.forEach((n,i)=>{
      const e=n.extras; if (!e?.arcane_source_anchor_id) return;
      const a=manifest.anchors.find(a=>a.sourceAnchorId===e.arcane_source_anchor_id), p=parents.get(i), w=world(i);
      if (!a||seenAnchors.has(a.sourceAnchorId)||n.mesh!==undefined||e.arcane_identity_scheme!=='arcane-semantic-v1'||e.arcane_source_object_id!==a.sourceObjectId||e.arcane_socket_kind!==a.kind||p===undefined||byNode.get(p)?.sourceObjectId!==a.sourceObjectId||w.some((x,j)=>Math.abs(x-a.transform[j]!)>1e-5)) fail('MAPPING','Prepared anchor differs from exported semantic node.');
      rigid(a.transform); seenAnchors.add(a.sourceAnchorId);
    });
  }
  if (manifest.textures.some(t => t.locations.some(l => !imageLocations.has(l.fileId + '\0' + l.imageIndex)))) fail('CHECKSUM', 'Prepared image locations were not re-decoded.');
  if (objects.length!==manifest.objects.length||seenAnchors.size!==manifest.anchors.length||usedMaterials.size!==manifest.materials.length) fail('MAPPING','Incomplete prepared object/anchor/material coverage.');
  const renderBounds=objects.filter(o=>o.object.role==='render').flatMap(o=>[Array.from(o.object.worldBounds.min),Array.from(o.object.worldBounds.max)]);
  if (!same(measured(renderBounds),manifest.bounds)) fail('CHECKSUM','Prepared aggregate bounds mismatch.');
  objects.sort((a,b)=>a.object.sourceObjectId<b.object.sourceObjectId?-1:1);
  const content = { formatVersion: 1 as const, engineVerification: 'pending' as const, preparedDigest: plan.digest, manifestDigest: manifest.digest,
    projectId: manifest.projectId, assetId: manifest.assetId, revisionId: manifest.revisionId, sourceSha256: manifest.sourceSha256,
    producer: manifest.producer, files: manifest.files, conversion: manifest.conversion, placement: manifest.placement, bounds: manifest.bounds, anchors: manifest.anchors,
    objects, ...(textureMaps.size ? {textures: [...textureMaps.values()].sort((a, b) => a.imageId < b.imageId ? -1 : 1)} : {}), sourceDocuments, binaryByteLength: binary, chunkCount: chunks };
  const metadataBytes=Buffer.byteLength(JSON.stringify(content,(k,v)=>k==='bytes'||k==='chunks'?undefined:v));
  const aggregateEncodedByteLength=bound(encoded+metadataBytes+4096,limits.encodedBytes,'Encoded payload aggregate');
  const body={...content,aggregateEncodedByteLength};
  const result = freeze({...body,digest:sha(canonical(body))});
  decodedPayloads.add(result); return result;
}

function generatedPrepared(value:PreparedStudioImport):value is GeneratedPreparedStudioImportV1 {return value.manifest.schemaVersion===1;}
function convertedPrepared(value:PreparedStudioImport):value is ConvertedPreparedStudioImportV2 {return value.manifest.schemaVersion===2;}
function graphWorlds(graph:ConvertedGraphV1):Map<string,number[]> {
  const byKey=new Map(graph.nodes.map(node=>[node.nodeKey,node])),worlds=new Map<string,number[]>();
  for(const node of graph.nodes){
    const chain:typeof graph.nodes[number][]=[],seen=new Set<string>();let next:string|null=node.nodeKey;
    while(next!==null&&!worlds.has(next)){
      const current=byKey.get(next);if(!current||seen.has(next)||chain.length>=STUDIO_IMPORT_GRAPH_LIMITS.depth)fail('MAPPING','Incomplete converted parent graph.');
      seen.add(next);chain.push(current);next=current.parentKey;
    }
    let parent=next===null?I:worlds.get(next)!;
    while(chain.length){const current=chain.pop()!;parent=multiply(parent,Array.from(current.localMatrix));worlds.set(current.nodeKey,parent);}
  }
  return worlds;
}
function ownMatrix(value:unknown):number[] {
  if(!value||types.isProxy(value)||!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||Reflect.ownKeys(value).length!==17||field(value,'length')!==16)fail('SCHEMA','Expected a detached matrix.');
  return Array.from({length:16},(_,i)=>{const number=field(value,String(i));if(typeof number!=='number'||!Number.isFinite(number))fail('UNSUPPORTED_TRANSFORM','Invalid converted matrix.');return number;});
}
/** Necessary algebraic target eligibility only, not an observed engine result or
 * a MeshSize/centering/CFrame/PivotOffset implementation. Materialization must
 * independently construct a faithful plan or refuse before allocations.
 * Source conversion keeps its full affine domain.
 * Parsed metadata/provenance and actual byte validation are separate obligations.
 * This NEVER registers decoded provenance or grants allocation/Studio authority. */
export function assertConvertedStudioImportRepresentable(graphValue:ConvertedGraphV1,objectValues:readonly ConvertedStudioImportManifestV2['objects'][number][]):void {
  let graph:ConvertedGraphV1;try{graph=parseConvertedGraph(graphValue);}catch{fail('MAPPING','Invalid converted graph metadata.');}
  const count=1+graph.nodes.length+graph.meshes.filter(mesh=>mesh.nodeKey===null).length;
  // Count the actual outer placement Model, every selected Model/MeshPart node,
  // and each derived collision MeshPart once. No collision group is invented.
  bound(count,STUDIO_RECONSTRUCTION_LIMITS.objects,'Complete materialized graph instances',1);
  if(!objectValues||types.isProxy(objectValues)||!Array.isArray(objectValues)||Object.getPrototypeOf(objectValues)!==Array.prototype||
    field(objectValues,'length')!==graph.meshes.length||Reflect.ownKeys(objectValues).length!==graph.meshes.length+1)fail('MAPPING','Exact converted object coverage required.');
  const worlds=graphWorlds(graph),seen=new Set<string>();
  for(const node of graph.nodes){
    const localScale=rigid(node.localMatrix),worldScale=rigid(worlds.get(node.nodeKey)!);
    if(!graph.meshes.some(mesh=>mesh.nodeKey===node.nodeKey)&&[...localScale,...worldScale].some(scale=>Math.abs(scale-1)>1e-6))
      fail('UNSUPPORTED_TRANSFORM','Scaled grouping pivots require a separately verified faithful native representation.');
  }
  for(let at=0;at<graph.meshes.length;at++){
    const object=field(objectValues,String(at));
    if(!object||typeof object!=='object'||types.isProxy(object)||![Object.prototype,null].includes(Object.getPrototypeOf(object)))fail('SCHEMA','Expected converted object metadata.');
    const id=field(object,'sourceObjectId'),key=field(object,'sourceKey'),role=field(object,'role'),matrix=ownMatrix(field(object,'exportTransform'));
    if(typeof id!=='string'||seen.has(id))fail('MAPPING','Duplicate converted object.');seen.add(id);
    const association=graph.meshes.find(mesh=>mesh.sourceObjectId===id);
    if(!association||(association.nodeKey===null?role!=='collision'||key!=='proxy':role!=='render'||key!==association.nodeKey)||
      association.nodeKey!==null&&!same(matrix,worlds.get(association.nodeKey)))fail('MAPPING','Converted object transform or graph association differs.');
    rigid(matrix);
  }
}
function convertedDocumentWorlds(doc:Json,manifest:ConvertedStudioImportManifestV2,fileId:string):Map<number,number[]> {
  const render=manifest.objects.some(object=>object.exportFileId===fileId&&object.role==='render'),nodes:Json[]=doc.nodes,parents=new Map<number,number>(),byKey=new Map<string,number>();
  nodes.forEach((node,at)=>{for(const child of node.children??[]){if(parents.has(child))fail('MAPPING','Ambiguous converted parent.');parents.set(child,at);}
    if(render){const key=node.extras?.[CONVERSION_NODE_KEY];if(typeof key!=='string'||byKey.has(key))fail('MAPPING','Missing or duplicate converted node marker.');byKey.set(key,at);}});
  if(doc.scenes.length!==1||(doc.scene??0)!==0)fail('MAPPING','Expected the complete canonical converted scene.');
  const worlds=new Map<number,number[]>(),pending=(doc.scenes[0].nodes??[]).map((at:number)=>({at,parent:I,depth:1}));
  while(pending.length){const current=pending.pop()!,node=nodes[current.at];
    if(!node||worlds.has(current.at)||current.depth>STUDIO_IMPORT_GRAPH_LIMITS.depth)fail('MAPPING','Invalid converted selected hierarchy.');
    const world=multiply(current.parent,local(node));worlds.set(current.at,world);
    for(const child of node.children??[])pending.push({at:child,parent:world,depth:current.depth+1});
  }
  if(worlds.size!==nodes.length)fail('MAPPING','Every converted node must belong to the selected scene.');
  if(!render){if(nodes.length!==1||nodes[0]!.mesh===undefined||parents.size)fail('MAPPING','Expected one derived collision root.');rigid(local(nodes[0]!));return worlds;}
  if(nodes.length!==manifest.graph.nodes.length)fail('MAPPING','Converted EMPTY or mesh node coverage differs.');
  for(const expected of manifest.graph.nodes){const at=byKey.get(expected.nodeKey);if(at===undefined)fail('MAPPING','Converted graph node is missing.');
    const actual=nodes[at]!,parent=parents.get(at),key=parent===undefined?null:nodes[parent]!.extras?.[CONVERSION_NODE_KEY],mesh=manifest.graph.meshes.find(mesh=>mesh.nodeKey===expected.nodeKey);
    if(key!==expected.parentKey||!same(local(actual),expected.localMatrix)||(actual.name??null)!==expected.name||(actual.mesh!==undefined)!==Boolean(mesh))
      fail('MAPPING','Converted direct parent, local matrix, name or EMPTY/mesh association differs.');
    if(mesh&&!manifest.objects.some(object=>object.nodeIndex===at&&object.sourceObjectId===mesh.sourceObjectId&&object.sourceKey===expected.nodeKey))fail('MAPPING','Converted actual node index differs from its marker.');
  }
  return worlds;
}
function correspondenceInput(doc:Json,bin:Buffer,index:unknown,vertices:number):Omit<ConvertedStudioImportCorrespondenceV2,'orientedTriangleSha256'> {
  if(typeof index!=='number'||!Number.isSafeInteger(index)||index<0)fail('MAPPING','Missing host vertex correspondence.');
  const accessor=doc.accessors[index],view=doc.bufferViews[accessor?.bufferView];
  if(!accessor||!view||accessor.type!=='SCALAR'||accessor.componentType!==5126||accessor.normalized||accessor.sparse||accessor.count!==vertices)
    fail('MAPPING','Expected exact unnormalized FLOAT scalar host vertex IDs.');
  const stride=view.byteStride??4,offset=accessor.byteOffset??0,start=(view.byteOffset??0)+offset;
  if(stride<4||stride%4||offset%4||start%4||offset+(vertices-1)*stride+4>view.byteLength||start+(vertices-1)*stride+4>bin.length)fail('EXPORT','Invalid host correspondence range.');
  const raw=new Uint8Array(vertices*4),ids:number[]=[];
  for(let i=0;i<vertices;i++){const at=start+i*stride,id=bin.readFloatLE(at);if(!Number.isInteger(id)||id<0||id>=60000)fail('MAPPING','Host correspondence requires bounded exact integer IDs.');
    ids.push(id===0?0:id);raw.set(bin.subarray(at,at+4),i*4);}
  return{semantic:CONVERSION_VERTEX_ID,accessorIndex:index,count:vertices,sha256:sha(raw),ids,accessor,bufferView:view};
}
export function decodeStudioImportPayload(prepared:GeneratedPreparedStudioImportV1,files:ReadonlyMap<string,Uint8Array>,tighten?:Partial<Record<keyof Limits,number>>):GeneratedStudioImportPayloadV1;
export function decodeStudioImportPayload(prepared:ConvertedPreparedStudioImportV2,files:ReadonlyMap<string,Uint8Array>,tighten?:Partial<Record<keyof Limits,number>>):ConvertedStudioImportPayloadV2;
export function decodeStudioImportPayload(prepared:PreparedStudioImport,files:ReadonlyMap<string,Uint8Array>,tighten?:Partial<Record<keyof Limits,number>>):StudioImportPayload;
export function decodeStudioImportPayload(prepared:PreparedStudioImport,files:ReadonlyMap<string,Uint8Array>,tighten:Partial<Record<keyof Limits,number>>={}):StudioImportPayload {
  const version=field(field(prepared,'manifest'),'schemaVersion');
  if(version===1)return decodeGeneratedStudioImportPayloadV1(prepared,files,tighten);
  if(version===2)return decodeConvertedStudioImportPayloadV2(prepared,files,tighten);
  return fail('SCHEMA','Unknown studio import payload version.');
}

function decodeConvertedStudioImportPayloadV2(prepared: PreparedStudioImport, files: ReadonlyMap<string, Uint8Array>, tighten: Partial<Record<keyof Limits, number>> = {}): ConvertedStudioImportPayloadV2 {
  const revision = field(field(prepared, 'manifest'), 'revisionId');
  if (typeof revision !== 'string') fail('SCHEMA', 'Expected prepared revision.');
  let plan: ConvertedPreparedStudioImportV2;
  try { const parsed=parseNativeStudioImportResponse({ prepared }, revision).prepared;if(!convertedPrepared(parsed))fail('SCHEMA','Expected converted v2 preparation.');plan=parsed; } catch { return fail('SCHEMA', 'Prepared schema or digest mismatch.'); }
  const manifest = plan.manifest, limits: Limits = { ...STUDIO_IMPORT_PAYLOAD_LIMITS };
  assertConvertedStudioImportRepresentable(manifest.graph,manifest.objects);
  if (!tighten || typeof tighten!=='object' || types.isProxy(tighten) || Object.getPrototypeOf(tighten) !== Object.prototype) fail('SCHEMA', 'Expected plain limits.');
  for (const k of Reflect.ownKeys(tighten)) {
    if (typeof k !== 'string' || !Object.hasOwn(limits,k)) fail('BUDGET', 'Unknown payload limit.');
    limits[k as keyof Limits] = bound(field(tighten,k) as number, limits[k as keyof Limits], 'Tightened '+k, 1);
  }
  if (!files || types.isProxy(files) || !types.isMap(files) || Object.getPrototypeOf(files)!==Map.prototype || Reflect.ownKeys(files).length) fail('SCHEMA', 'Expected host-owned Map of exports.');
  const count = Object.getOwnPropertyDescriptor(Map.prototype,'size')!.get!.call(files) as number;
  if (count !== manifest.files.length) fail('CHECKSUM', 'Exact prepared export set required.');
  const copies = new Map<string, Buffer>(); let inputBytes = 0;
  for (const f of manifest.files) {
    if (f.contentType !== 'model/gltf-binary') fail('EXPORT', 'Payload v2 supports owned static GLB exports only.');
    inputBytes = bound(inputBytes + f.byteLength, STUDIO_IMPORT_LIMITS.totalBytes, 'Export aggregate bytes');
    const bytes = owned(Map.prototype.get.call(files,f.fileId), f.byteLength);
    if (sha(bytes) !== f.sha256) fail('CHECKSUM', 'Export SHA-256 mismatch: ' + f.fileId); copies.set(f.fileId, bytes);
  }
  const textureMaps = new Map<string, StudioImportPayloadTexture>(), imageLocations = new Set<string>();
  const textureError = (error: unknown): never => { if (error instanceof StudioTextureError) fail(error.code, error.message); throw error; };
  let binary = 0, encoded = 0, chunks = 0, triangles = 0, reconstructionVertices=0;
  const objects: ConvertedStudioImportPayloadObjectV2[] = [], usedMaterials = new Set<string>();
  const sourceDocuments: { fileId: string; jsonSha256: string; document: Readonly<Record<string, unknown>> }[] = [];
  const buffer = (raw: Uint8Array, semantic: Semantic, componentType: StudioImportPayloadBuffer['componentType'], type: StudioImportPayloadBuffer['type'], count: number, normalized: boolean, source: StudioImportPayloadBuffer['source'], o: Pick<SourceObject, 'sourceObjectId'>, primitiveIndex: number): StudioImportPayloadBuffer => {
    const hash = sha(raw), records: ConvertedStudioImportPayloadChunkV2[] = [];
    for (let offset = 0; offset < raw.length; offset += limits.chunkBytes) {
      const part = raw.subarray(offset, offset + limits.chunkBytes);
      const record: ConvertedStudioImportPayloadChunkV2 = { formatVersion: 2, manifestDigest: manifest.digest, sourceObjectId: o.sourceObjectId, primitiveIndex, semantic, bufferSha256: hash, offset, byteLength: part.length, sha256: sha(part), encoding: 'base64', data: Buffer.from(part).toString('base64') };
      encoded += bound(Buffer.byteLength(JSON.stringify(record)), limits.encodedChunkBytes, 'Encoded chunk');
      bound(encoded, limits.encodedBytes, 'Encoded aggregate'); bound(++chunks, limits.chunks, 'Chunk count'); records.push(record);
    }
    return { semantic, componentType, type, count, normalized, byteLength: raw.length, sha256: hash, bytes: raw, source, chunks: records };
  };
  for (const [fileId, bytes] of copies) {
    const { doc, bin } = document(bytes, manifest.producer,true), nodes: Json[] = doc.nodes ?? [], parents = new Map<number,number>(), worlds=convertedDocumentWorlds(doc,manifest,fileId);
    sourceDocuments.push({fileId,jsonSha256:sha(bytes.subarray(20,20+bytes.readUInt32LE(12))),document:doc});
    nodes.forEach((n,i)=>(n.children??[]).forEach((c:number)=>parents.set(c,i)));
    const world=(i:number):number[]=>{const matrix=worlds.get(i);if(!matrix)fail('MAPPING','Converted node is outside its scene.');return matrix;};
    const mapped = manifest.objects.filter(o=>o.exportFileId===fileId), byNode = new Map(mapped.map(o=>[o.nodeIndex,o]));
    if (byNode.size !== mapped.length || mapped.length !== nodes.filter(n=>n.mesh!==undefined).length) fail('MAPPING', 'Every mesh node requires one unique prepared object.');
    let images: StudioEmbeddedImages, materials: Json[];
    try { images = decodeEmbeddedStudioImages(doc, bin, manifest, fileId, limits.binaryBytes); materials = (doc.materials ?? []).map((m: Json) => material(m, doc, images,2)); }
    catch (error) { return textureError(error); }
    images.hashes.forEach((_, i) => imageLocations.add(fileId + '\0' + i));
    for (const m of materials) {
      const hash = sha(canonical(m)), source = manifest.materials.find(v => v.sha256 === hash && same(v, {...m, sha256: hash}));
      if (!source) fail('CHECKSUM', 'Material differs from prepared material.'); usedMaterials.add(hash);
      if ([...textureMaps.values()].some(map => map.materialSha256 === hash)) continue;
      let maps: StudioTexturePixels[];
      try { maps = materialStudioTexturePixels(source, images, limits.binaryBytes - binary); } catch (error) { return textureError(error); }
      for (const map of maps) if (!textureMaps.has(map.imageId)) {
        bound(textureMaps.size + 1, STUDIO_TEXTURE_LIMITS.maps, 'Texture map count');
        binary = bound(binary + map.bytes.byteLength, limits.binaryBytes, 'Decoded texture/mesh aggregate');
        const stream = buffer(map.bytes, map.semantic, 5121, 'VEC4', map.width * map.height, false, null, {sourceObjectId: 'texture-' + map.imageId}, -1);
        textureMaps.set(map.imageId, {...stream, ...map, componentType: 5121, type: 'VEC4'});
      }
    }
    for (const o of mapped) {
      const n=nodes[o.nodeIndex], e=n?.extras, mesh=doc.meshes[n?.mesh];
      if (new Set(o.collisionFor).size!==o.collisionFor.length) fail('MAPPING','Duplicate collision target.');
      const association=manifest.graph.meshes.find(mesh=>mesh.sourceObjectId===o.sourceObjectId),match=/^node([0-9]+)_primitive([0-9]+)$/.exec(o.sourceKey);
      if(!n||n.mesh===undefined||!e||!association||e.arcane_identity_scheme!=='arcane-converted-v2'||e.arcane_source_object_id!==o.sourceObjectId||
        e.arcane_source_key!==o.sourceKey||e.arcane_role!==o.role||!same(e.arcane_pivot,[0,0,0])||!same(o.pivot,association.sourcePivot)||
        e.arcane_collision_for!==JSON.stringify([...o.collisionFor].sort()))fail('MAPPING','Prepared converted identity, role or source pivot differs.');
      if(o.role==='render'?(association.nodeKey!==o.sourceKey||!match||e[CONVERSION_NODE_KEY]!==o.sourceKey||
        e.arcane_conversion_origin_v1!=='glb_'+manifest.sourceSha256+':'+Number(match[1])+':'+Number(match[2])):
        association.nodeKey!==null||o.sourceKey!=='proxy'||e[CONVERSION_NODE_KEY]!==undefined||e.arcane_conversion_origin_v1!==undefined)
        fail('MAPPING','Converted source marker or derived collision association differs.');
      const transform=world(o.nodeIndex);
      if(!same(transform,o.exportTransform)||!same(rigid(transform),o.scale)||o.name!==(n.name??mesh.name??o.sourceObjectId))fail('MAPPING','Prepared converted transform/name differs from actual bytes.');
      const primitives: ConvertedStudioImportPayloadPrimitiveV2[] = [], geometry: Json[] = [], positions: number[][] = [], slots=new Set<number|null>(); let vertices=0, objectTriangles=0;
      for (const [pi,p] of (mesh.primitives as Json[]).entries()) {
        const values: Record<string,number[][]> = {}, attrs: Partial<Record<Exclude<MeshSemantic,'indices'>,StudioImportPayloadBuffer>> = {};
        const read = (ai:number, semantic:MeshSemantic): StudioImportPayloadBuffer => {
          const a=doc.accessors[ai], v=doc.bufferViews[a.bufferView], width=a.componentType===5121?1:a.componentType===5123?2:4, size=a.type==='SCALAR'?1:a.type==='VEC2'?2:3;
          if (semantic==='indices' ? a.type!=='SCALAR'||![5121,5123,5125].includes(a.componentType)||a.normalized||v.byteStride!==undefined : a.type!==(semantic==='TEXCOORD_0'?'VEC2':'VEC3') || (semantic==='TEXCOORD_0'?![5121,5123,5126].includes(a.componentType)||a.componentType!==5126&&!a.normalized:a.componentType!==5126)) fail('UNSUPPORTED_ATTRIBUTE','Unsupported dense '+semantic+' format.');
          bound(a.count,semantic==='indices'?STUDIO_IMPORT_LIMITS.meshTriangles*3:limits.meshVertices,'Accessor count',1);
          const stride=v.byteStride??size*width, offset=a.byteOffset??0, start=(v.byteOffset??0)+offset, length=a.count*size*width;
          if (offset%width||start%width||stride<size*width||offset+(a.count-1)*stride+size*width>v.byteLength||start+(a.count-1)*stride+size*width>bin.length) fail('EXPORT','Dense accessor range/stride/alignment mismatch.');
          binary=bound(binary+length,limits.binaryBytes,'Binary aggregate'); const raw=new Uint8Array(length), rows:number[][]=[];
          for (let i=0;i<a.count;i++) { const row:number[]=[]; raw.set(bin.subarray(start+i*stride,start+i*stride+size*width),i*size*width);
            for (let c=0;c<size;c++) { const at=start+i*stride+c*width; let x=a.componentType===5126?bin.readFloatLE(at):width===4?bin.readUInt32LE(at):width===2?bin.readUInt16LE(at):bin.readUInt8(at);
              if (a.normalized) x/=width===1?255:65535;
              if (!Number.isFinite(x)||Math.abs(x)>1_000_000) fail('EXPORT','Nonfinite/out-of-bounds '+semantic+' sample.'); row.push(Object.is(x,-0)?0:x); }
            rows.push(row); }
          values[semantic]=rows; return buffer(raw,semantic,a.componentType,a.type,a.count,a.normalized??false,{accessorIndex:ai,accessor:a,bufferView:v},o,pi);
        };
        for (const k of Object.keys(p.attributes).sort()) if(k!==CONVERSION_VERTEX_ID)attrs[k as keyof typeof attrs]=read(p.attributes[k],k as MeshSemantic);
        const pos=attrs.POSITION!;
        const proof=o.role==='render'?correspondenceInput(doc,bin,p.attributes[CONVERSION_VERTEX_ID],pos.count):null;
        if(o.role==='collision'&&p.attributes[CONVERSION_VERTEX_ID]!==undefined)fail('MAPPING','Collision has foreign render correspondence.');
        if(proof)values[CONVERSION_VERTEX_ID]=proof.ids.map(id=>[id]);
        reconstructionVertices=bound(reconstructionVertices+pos.count,STUDIO_RECONSTRUCTION_LIMITS.vertices,'Reconstruction aggregate vertices');
        if (Object.values(attrs).some(a=>a.count!==pos.count)) fail('EXPORT','Attribute counts differ.');
        vertices=bound(vertices+pos.count,limits.meshVertices,'Per-object vertices'); positions.push(...values.POSITION!);
        let indices: StudioImportPayloadBuffer;
        if (p.indices!==undefined) indices=read(p.indices,'indices');
        else { binary=bound(binary+pos.count*4,limits.binaryBytes,'Implicit indices'); const raw=new Uint8Array(pos.count*4), v=new DataView(raw.buffer); for(let i=0;i<pos.count;i++)v.setUint32(i*4,i,true); values.indices=Array.from({length:pos.count},(_,i)=>[i]); indices=buffer(raw,'indices',5125,'SCALAR',pos.count,false,null,o,pi); }
        if (indices.count%3 || values.indices!.some(r=>r[0]!>=pos.count||r[0]===2**(indices.componentType===5121?8:indices.componentType===5123?16:32)-1)) fail('EXPORT','Invalid triangle indices.');
        // Independently enforce the same Arcane doubled-area policy as host
        // preparation; positive AABB extents do not prove a nondegenerate face.
        for(let at=0;at<values.indices!.length;at+=3){
          const a=values.POSITION![values.indices![at]![0]!]!,b=values.POSITION![values.indices![at+1]![0]!]!,c=values.POSITION![values.indices![at+2]![0]!]!;
          const u=b.map((n,i)=>n-a[i]!),v=c.map((n,i)=>n-a[i]!);
          if(Math.hypot(u[1]!*v[2]!-u[2]!*v[1]!,u[2]!*v[0]!-u[0]!*v[2]!,u[0]!*v[1]!-u[1]!*v[0]!)<=1e-10)
            fail('EXPORT','Degenerate triangle; doubled area must exceed 1e-10.');
        }
        objectTriangles=bound(objectTriangles+indices.count/3,STUDIO_IMPORT_LIMITS.meshTriangles,'Per-object triangles');
        slots.add(p.material??null); geometry.push({attributes:Object.fromEntries(Object.entries(values).filter(([k])=>k!=='indices')),indices:values.indices!.flat(),mode:4});
        let correspondence:ConvertedStudioImportCorrespondenceV2|null=null;
        if(proof){let oriented:string;try{oriented=conversionCorrespondenceSha256(Array.from({length:indices.count/3},(_,face)=>[0,1,2].map(c=>proof.ids[values.indices![face*3+c]![0]!]!)));}
          catch{fail('MAPPING','Invalid converted oriented vertex correspondence.');}
          if(oriented!==association.correspondenceSha256)fail('MAPPING','Converted oriented ID topology differs from its retained graph.');
          correspondence={...proof,orientedTriangleSha256:oriented};}
        primitives.push({mode:4,vertexCount:pos.count,triangleCount:indices.count/3,attributes:attrs,indices,source:p,correspondence});
      }
      triangles=bound(triangles+objectTriangles,STUDIO_IMPORT_LIMITS.triangles,'Aggregate triangles');bound(triangles,STUDIO_RECONSTRUCTION_LIMITS.triangles,'Reconstruction aggregate triangles');
      if (slots.size!==1||objectTriangles!==o.triangles||sha(canonical(geometry))!==o.meshExportSha256||!same(measured(positions),o.bounds)||!same(measured(positions.map(p=>[0,1,2].map(i=>transform[i]!*p[0]!+transform[4+i]!*p[1]!+transform[8+i]!*p[2]!+transform[12+i]!))),o.worldBounds)) fail('CHECKSUM','Prepared geometry/material-slot/bounds mismatch.');
      const slot=[...slots][0]!, mat=slot===null?null:materials[slot]!, hash=mat===null?null:sha(canonical(mat));
      if (hash!==o.materialSha256||o.role==='collision'&&hash!==null) fail('CHECKSUM','Prepared object material mismatch.');
      const bindings = Object.fromEntries([...textureMaps.values()].filter(t => t.materialSha256 === hash).map(t => [t.semantic, t.imageId]));
      if (Object.keys(bindings).length && primitives.some(p => !p.attributes.TEXCOORD_0)) fail('UNSUPPORTED_TEXTURE', 'Textured mesh primitives require UV0.');
      objects.push({object:o,association,material:hash===null?null:manifest.materials.find(m=>m.sha256===hash)!,primitives,
        ...(Object.keys(bindings).length ? {textureBindings: bindings} : {}),
        provenance:{generator:doc.asset.generator,node:n,mesh,material:slot===null?null:doc.materials[slot]}});
    }
    if(nodes.some(n=>n.extras?.arcane_source_anchor_id!==undefined))fail('MAPPING','Converted models have no declared anchor adapter.');
  }
  if (manifest.textures.some(t => t.locations.some(l => !imageLocations.has(l.fileId + '\0' + l.imageIndex)))) fail('CHECKSUM', 'Prepared image locations were not re-decoded.');
  if (objects.length!==manifest.objects.length||manifest.anchors.length!==0||usedMaterials.size!==manifest.materials.length) fail('MAPPING','Incomplete prepared object/anchor/material coverage.');
  const renderBounds=objects.filter(o=>o.object.role==='render').flatMap(o=>[Array.from(o.object.worldBounds.min),Array.from(o.object.worldBounds.max)]);
  if (!same(measured(renderBounds),manifest.bounds)) fail('CHECKSUM','Prepared aggregate bounds mismatch.');
  objects.sort((a,b)=>a.object.sourceObjectId<b.object.sourceObjectId?-1:1);
  const content = { formatVersion: 2 as const, origin:'converted-glb' as const,identityScheme:'arcane-converted-v2' as const,conversionRequest:manifest.conversionRequest,graph:manifest.graph, engineVerification: 'pending' as const, preparedDigest: plan.digest, manifestDigest: manifest.digest,
    projectId: manifest.projectId, assetId: manifest.assetId, revisionId: manifest.revisionId, sourceSha256: manifest.sourceSha256,
    producer: manifest.producer, files: manifest.files, conversion: manifest.conversion, placement: manifest.placement, bounds: manifest.bounds, anchors: manifest.anchors,
    objects, ...(textureMaps.size ? {textures: [...textureMaps.values()].sort((a, b) => a.imageId < b.imageId ? -1 : 1)} : {}), sourceDocuments, binaryByteLength: binary, chunkCount: chunks };
  const metadataBytes=Buffer.byteLength(JSON.stringify(content,(k,v)=>k==='bytes'||k==='chunks'?undefined:v));
  const aggregateEncodedByteLength=bound(encoded+metadataBytes+4096,limits.encodedBytes,'Encoded payload aggregate');
  const body={...content,aggregateEncodedByteLength};
  const result = freeze({...body,digest:sha(canonical(body))});
  decodedPayloads.add(result); return result;
}
