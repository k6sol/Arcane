import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { validateGlb } from '../../../apps/desktop/src/glb-preflight.js';
import { STUDIO_IMPORT_LIMITS, type PreparedStudioImport, type StudioImportManifest } from './studio-import-manifest.js';
import { parseNativeStudioImportResponse } from './studio-import-wire.js';

/** Data conversion only. Main must bind the SAME native actor, owned job and target.
 * Neither digests nor this pending payload grant upload/Studio/engine authority. */
export const STUDIO_IMPORT_PAYLOAD_VERSION = 1;
export const STUDIO_IMPORT_PAYLOAD_LIMITS = Object.freeze({
  chunkBytes: 180 * 1024, encodedChunkBytes: 256 * 1024 - 4096,
  binaryBytes: 32 * 1024 * 1024, encodedBytes: 48 * 1024 * 1024, chunks: 4096,
  meshVertices: 60_000,
});
type Limits = { -readonly [K in keyof typeof STUDIO_IMPORT_PAYLOAD_LIMITS]: number };
type Json = Record<string, any>; // Bounded JSON parsed locally; never caller objects.
type Semantic = 'POSITION' | 'NORMAL' | 'TEXCOORD_0' | 'indices';
type SourceObject = StudioImportManifest['objects'][number];
export class StudioImportPayloadError extends Error {
  constructor(public readonly code: 'SCHEMA' | 'CHECKSUM' | 'BUDGET' | 'EXPORT' | 'MAPPING' | 'UNSUPPORTED_ATTRIBUTE' | 'UNSUPPORTED_MATERIAL' | 'UNSUPPORTED_TEXTURE' | 'UNSUPPORTED_TRANSFORM', message: string) {
    super(message); this.name = 'StudioImportPayloadError';
  }
}
export interface StudioImportPayloadChunk {
  readonly formatVersion: 1; readonly manifestDigest: string; readonly sourceObjectId: string;
  readonly primitiveIndex: number; readonly semantic: Semantic; readonly bufferSha256: string;
  readonly offset: number; readonly byteLength: number; readonly sha256: string;
  readonly encoding: 'base64'; readonly data: string;
}
export interface StudioImportPayloadBuffer {
  readonly semantic: Semantic; readonly componentType: 5121 | 5123 | 5125 | 5126;
  readonly type: 'SCALAR' | 'VEC2' | 'VEC3'; readonly count: number; readonly normalized: boolean;
  readonly byteLength: number; readonly sha256: string;
  /** Caller-owned copy, densely packed little endian; never aliases input or another stream.
   * Typed-array elements cannot be frozen. Immutable chunks/digests bind the original copy. */
  readonly bytes: Uint8Array;
  readonly source: Readonly<{ accessorIndex: number; accessor: Readonly<Record<string, unknown>>; bufferView: Readonly<Record<string, unknown>> }> | null;
  readonly chunks: readonly StudioImportPayloadChunk[];
}
export interface StudioImportPayloadPrimitive {
  readonly mode: 4; readonly vertexCount: number; readonly triangleCount: number;
  readonly attributes: Readonly<Partial<Record<Exclude<Semantic, 'indices'>, StudioImportPayloadBuffer>>>;
  readonly indices: StudioImportPayloadBuffer;
  readonly source: Readonly<Record<string, unknown>>;
}
export interface StudioImportPayloadObject {
  readonly object: SourceObject;
  readonly material: StudioImportManifest['materials'][number] | null;
  readonly primitives: readonly StudioImportPayloadPrimitive[];
  readonly provenance: Readonly<{ generator: string; node: Readonly<Record<string, unknown>>; mesh: Readonly<Record<string, unknown>>; material: Readonly<Record<string, unknown>> | null }>;
}
export interface StudioImportPayload {
  readonly formatVersion: 1; readonly engineVerification: 'pending'; readonly digest: string;
  readonly preparedDigest: string; readonly manifestDigest: string;
  readonly projectId: string; readonly assetId: string; readonly revisionId: string; readonly sourceSha256: string;
  readonly producer: StudioImportManifest['producer']; readonly files: StudioImportManifest['files'];
  readonly conversion: StudioImportManifest['conversion']; readonly placement: StudioImportManifest['placement'];
  readonly bounds: StudioImportManifest['bounds']; readonly anchors: StudioImportManifest['anchors'];
  /** Original bounded GLB JSON, including anchor/ancestor extras and raw accessor semantics. */
  readonly sourceDocuments: readonly Readonly<{ fileId: string; jsonSha256: string; document: Readonly<Record<string, unknown>> }>[];
  readonly objects: readonly StudioImportPayloadObject[];
  readonly binaryByteLength: number; readonly aggregateEncodedByteLength: number; readonly chunkCount: number;
}
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
  return Array.from({ length: 16 }, (_, i) => [0, 1, 2, 3].reduce((n, k) => n + a[k * 4 + i % 4]! * b[Math.floor(i / 4) * 4 + k]!, 0));
}
function local(n: Json): number[] {
  if (n.matrix) return n.matrix;
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1], s = n.scale ?? [1, 1, 1], t = n.translation ?? [0, 0, 0];
  return [(1-2*(y*y+z*z))*s[0], 2*(x*y+z*w)*s[0], 2*(x*z-y*w)*s[0], 0,
    2*(x*y-z*w)*s[1], (1-2*(x*x+z*z))*s[1], 2*(y*z+x*w)*s[1], 0,
    2*(x*z+y*w)*s[2], 2*(y*z-x*w)*s[2], (1-2*(x*x+y*y))*s[2], 0, ...t, 1];
}
function rigid(m: readonly number[]): number[] {
  if (m.length !== 16 || m.some(n => !Number.isFinite(n) || Math.abs(n) > 1_000_000) || m[3] !== 0 || m[7] !== 0 || m[11] !== 0 || m[15] !== 1) fail('UNSUPPORTED_TRANSFORM', 'Invalid bounded affine transform.');
  const scale = [0, 4, 8].map(at => Math.hypot(...m.slice(at, at + 3)));
  const det = m[0]!*(m[5]!*m[10]!-m[6]!*m[9]!)-m[4]!*(m[1]!*m[10]!-m[2]!*m[9]!)+m[8]!*(m[1]!*m[6]!-m[2]!*m[5]!);
  if (scale.some(n => n <= 0) || det <= 0 || [[0,1],[0,2],[1,2]].some(([a,b]) => Math.abs([0,1,2].reduce((s,r)=>s+m[a!*4+r]!*m[b!*4+r]!,0)/(scale[a!]!*scale[b!]!)) > 1e-6)) fail('UNSUPPORTED_TRANSFORM', 'Shear, singular or mirrored transform requires baking.');
  return scale;
}
function document(bytes: Buffer, producer: StudioImportManifest['producer']): { doc: Json; bin: Buffer } {
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
  if (doc.asset.generator !== producer.exporterVersion.replace(' IO ', ' I/O ') || !/^Khronos glTF Blender I\/O v[0-9]+(?:\.[0-9]+){1,3}$/.test(doc.asset.generator)) fail('MAPPING', 'Export generator differs from prepared producer.');
  if ((doc.images?.length ?? 0) || (doc.textures?.length ?? 0) || (doc.samplers?.length ?? 0)) fail('UNSUPPORTED_TEXTURE', 'Embedded textures/images/samplers require decoded image/channel support (payload v1).');
  if ([...(doc.extensionsUsed ?? []), ...(doc.extensionsRequired ?? [])].some(k => k !== 'KHR_materials_emissive_strength')) fail('EXPORT', 'Unsupported static export extension.');
  for (const a of doc.accessors ?? []) if (a.sparse || a.bufferView === undefined) fail('EXPORT', 'Dense bufferView-backed accessors required.');
  for (const m of doc.meshes) {
    keys(m, ['name','primitives','extras']);
    for (const p of m.primitives) {
      keys(p, ['attributes','indices','material','mode','extras']);
      if ((p.mode ?? 4) !== 4) fail('EXPORT', 'Triangle primitives required.');
      keys(p.attributes, ['POSITION','NORMAL','TEXCOORD_0'], 'attributes', 'UNSUPPORTED_ATTRIBUTE');
    }
  }
  for (const n of doc.nodes) keys(n, ['name','mesh','children','matrix','translation','rotation','scale','extras']);
  bound((doc.materials ?? []).length, STUDIO_IMPORT_LIMITS.materials, 'Materials');
  return { doc, bin: bytes.subarray(at + 8, at + 8 + doc.buffers[0].byteLength) };
}
function material(m: Json): Json {
  for (const k of ['normalTexture','occlusionTexture','emissiveTexture']) if (m[k] !== undefined) fail('UNSUPPORTED_TEXTURE', 'Material ' + k + ' requires texture decode (payload v1).');
  keys(m, ['name','extras','pbrMetallicRoughness','alphaMode','alphaCutoff','doubleSided','emissiveFactor','extensions'], 'material', 'UNSUPPORTED_MATERIAL');
  const p = m.pbrMetallicRoughness ?? {}, ext = m.extensions ?? {};
  for (const k of ['baseColorTexture','metallicRoughnessTexture']) if (p[k] !== undefined) fail('UNSUPPORTED_TEXTURE', 'Material ' + k + ' requires texture decode (payload v1).');
  keys(p, ['baseColorFactor','metallicFactor','roughnessFactor','extras'], 'pbr', 'UNSUPPORTED_MATERIAL');
  keys(ext, ['KHR_materials_emissive_strength'], 'material.extensions', 'UNSUPPORTED_MATERIAL');
  const factor = m.emissiveFactor ?? [0,0,0], strength = ext.KHR_materials_emissive_strength?.emissiveStrength ?? 1;
  if ((m.alphaMode ?? 'OPAQUE') !== 'OPAQUE' || (p.baseColorFactor?.[3] ?? 1) !== 1) fail('UNSUPPORTED_MATERIAL', 'Payload v1 requires OPAQUE alpha=1.');
  return { baseColor: p.baseColorFactor ?? [1,1,1,1], metallic: p.metallicFactor ?? 1, roughness: p.roughnessFactor ?? 1,
    alphaMode: m.alphaMode ?? 'OPAQUE', alphaCutoff: m.alphaCutoff ?? 0.5, doubleSided: m.doubleSided ?? false, normalScale: 1,
    colorMap: null, normalMap: null, roughnessMap: null, metalnessMap: null,
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
export function decodeStudioImportPayload(prepared: PreparedStudioImport, files: ReadonlyMap<string, Uint8Array>, tighten: Partial<Record<keyof Limits, number>> = {}): StudioImportPayload {
  const revision = field(field(prepared, 'manifest'), 'revisionId');
  if (typeof revision !== 'string') fail('SCHEMA', 'Expected prepared revision.');
  let plan: PreparedStudioImport;
  try { plan = parseNativeStudioImportResponse({ prepared }, revision).prepared; } catch { return fail('SCHEMA', 'Prepared schema or digest mismatch.'); }
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
  if (manifest.textures.length || manifest.objects.some(o=>o.textureSha256s.length)) fail('UNSUPPORTED_TEXTURE', 'Prepared texture references require decoded image/channel support (payload v1).');
  let binary = 0, encoded = 0, chunks = 0, triangles = 0;
  const objects: StudioImportPayloadObject[] = [], seenAnchors = new Set<string>(), usedMaterials = new Set<string>();
  const sourceDocuments: { fileId: string; jsonSha256: string; document: Readonly<Record<string, unknown>> }[] = [];
  const buffer = (raw: Uint8Array, semantic: Semantic, componentType: StudioImportPayloadBuffer['componentType'], type: StudioImportPayloadBuffer['type'], count: number, normalized: boolean, source: StudioImportPayloadBuffer['source'], o: SourceObject, primitiveIndex: number): StudioImportPayloadBuffer => {
    const hash = sha(raw), records: StudioImportPayloadChunk[] = [];
    for (let offset = 0; offset < raw.length; offset += limits.chunkBytes) {
      const part = raw.subarray(offset, offset + limits.chunkBytes);
      const record: StudioImportPayloadChunk = { formatVersion: 1, manifestDigest: manifest.digest, sourceObjectId: o.sourceObjectId, primitiveIndex, semantic, bufferSha256: hash, offset, byteLength: part.length, sha256: sha(part), encoding: 'base64', data: Buffer.from(part).toString('base64') };
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
    const materials: Json[] = (doc.materials ?? []).map(material);
    for (const m of materials) { const hash=sha(canonical(m)); if (!manifest.materials.some(v=>v.sha256===hash&&same(v,{...m,sha256:hash}))) fail('CHECKSUM', 'Scalar material differs from prepared material.'); usedMaterials.add(hash); }
    for (const o of mapped) {
      const n=nodes[o.nodeIndex], e=n?.extras, mesh=doc.meshes[n?.mesh];
      if (new Set(o.collisionFor).size!==o.collisionFor.length) fail('MAPPING','Duplicate collision target.');
      if (!n || n.mesh===undefined || !e || e.arcane_identity_scheme!=='arcane-semantic-v1' || !/^arcane_[a-f0-9]{64}$/.test(o.sourceObjectId) || e.arcane_source_object_id!==o.sourceObjectId || e.arcane_role!==o.role || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(e.arcane_source_key) || !same(e.arcane_pivot,o.pivot) || e.arcane_collision_for!==JSON.stringify(o.collisionFor)) fail('MAPPING', 'Prepared role/object/node disagrees with generator extras.');
      const transform=world(o.nodeIndex); let parent=parents.get(o.nodeIndex);
      while (parent!==undefined&&!byNode.has(parent)) parent=parents.get(parent);
      if (!same(transform,o.exportTransform)||!same(rigid(transform),o.scale)||o.parentSourceObjectId!==(parent===undefined?null:byNode.get(parent)!.sourceObjectId)||o.name!==(n.name??mesh.name??o.sourceObjectId)) fail('MAPPING', 'Prepared transform/parent/name disagrees with export.');
      const primitives: StudioImportPayloadPrimitive[] = [], geometry: Json[] = [], positions: number[][] = [], slots=new Set<number|null>(); let vertices=0, objectTriangles=0;
      for (const [pi,p] of (mesh.primitives as Json[]).entries()) {
        const values: Record<string,number[][]> = {}, attrs: Partial<Record<Exclude<Semantic,'indices'>,StudioImportPayloadBuffer>> = {};
        const read = (ai:number, semantic:Semantic): StudioImportPayloadBuffer => {
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
        for (const k of Object.keys(p.attributes).sort()) attrs[k as keyof typeof attrs]=read(p.attributes[k],k as Semantic);
        const pos=attrs.POSITION!;
        if (Object.values(attrs).some(a=>a.count!==pos.count)) fail('EXPORT','Attribute counts differ.');
        vertices=bound(vertices+pos.count,limits.meshVertices,'Per-object vertices'); positions.push(...values.POSITION!);
        let indices: StudioImportPayloadBuffer;
        if (p.indices!==undefined) indices=read(p.indices,'indices');
        else { binary=bound(binary+pos.count*4,limits.binaryBytes,'Implicit indices'); const raw=new Uint8Array(pos.count*4), v=new DataView(raw.buffer); for(let i=0;i<pos.count;i++)v.setUint32(i*4,i,true); values.indices=Array.from({length:pos.count},(_,i)=>[i]); indices=buffer(raw,'indices',5125,'SCALAR',pos.count,false,null,o,pi); }
        if (indices.count%3 || values.indices!.some(r=>r[0]!>=pos.count||r[0]===2**(indices.componentType===5121?8:indices.componentType===5123?16:32)-1)) fail('EXPORT','Invalid triangle indices.');
        objectTriangles=bound(objectTriangles+indices.count/3,STUDIO_IMPORT_LIMITS.meshTriangles,'Per-object triangles');
        slots.add(p.material??null); geometry.push({attributes:Object.fromEntries(Object.entries(values).filter(([k])=>k!=='indices')),indices:values.indices!.flat(),mode:4});
        primitives.push({mode:4,vertexCount:pos.count,triangleCount:indices.count/3,attributes:attrs,indices,source:p});
      }
      triangles=bound(triangles+objectTriangles,STUDIO_IMPORT_LIMITS.triangles,'Aggregate triangles');
      if (slots.size!==1||objectTriangles!==o.triangles||sha(canonical(geometry))!==o.meshExportSha256||!same(measured(positions),o.bounds)||!same(measured(positions.map(p=>[0,1,2].map(i=>transform[i]!*p[0]!+transform[4+i]!*p[1]!+transform[8+i]!*p[2]!+transform[12+i]!))),o.worldBounds)) fail('CHECKSUM','Prepared geometry/material-slot/bounds mismatch.');
      const slot=[...slots][0]!, mat=slot===null?null:materials[slot]!, hash=mat===null?null:sha(canonical(mat));
      if (hash!==o.materialSha256||o.role==='collision'&&hash!==null) fail('CHECKSUM','Prepared object material mismatch.');
      objects.push({object:o,material:hash===null?null:manifest.materials.find(m=>m.sha256===hash)!,primitives,provenance:{generator:doc.asset.generator,node:n,mesh,material:slot===null?null:doc.materials[slot]}});
    }
    nodes.forEach((n,i)=>{
      const e=n.extras; if (!e?.arcane_source_anchor_id) return;
      const a=manifest.anchors.find(a=>a.sourceAnchorId===e.arcane_source_anchor_id), p=parents.get(i), w=world(i);
      if (!a||seenAnchors.has(a.sourceAnchorId)||n.mesh!==undefined||e.arcane_identity_scheme!=='arcane-semantic-v1'||e.arcane_source_object_id!==a.sourceObjectId||e.arcane_socket_kind!==a.kind||p===undefined||byNode.get(p)?.sourceObjectId!==a.sourceObjectId||w.some((x,j)=>Math.abs(x-a.transform[j]!)>1e-5)) fail('MAPPING','Prepared anchor differs from exported semantic node.');
      rigid(a.transform); seenAnchors.add(a.sourceAnchorId);
    });
  }
  if (objects.length!==manifest.objects.length||seenAnchors.size!==manifest.anchors.length||usedMaterials.size!==manifest.materials.length) fail('MAPPING','Incomplete prepared object/anchor/material coverage.');
  const renderBounds=objects.filter(o=>o.object.role==='render').flatMap(o=>[Array.from(o.object.worldBounds.min),Array.from(o.object.worldBounds.max)]);
  if (!same(measured(renderBounds),manifest.bounds)) fail('CHECKSUM','Prepared aggregate bounds mismatch.');
  objects.sort((a,b)=>a.object.sourceObjectId<b.object.sourceObjectId?-1:1);
  const content = { formatVersion: 1 as const, engineVerification: 'pending' as const, preparedDigest: plan.digest, manifestDigest: manifest.digest,
    projectId: manifest.projectId, assetId: manifest.assetId, revisionId: manifest.revisionId, sourceSha256: manifest.sourceSha256,
    producer: manifest.producer, files: manifest.files, conversion: manifest.conversion, placement: manifest.placement, bounds: manifest.bounds, anchors: manifest.anchors,
    objects, sourceDocuments, binaryByteLength: binary, chunkCount: chunks };
  const metadataBytes=Buffer.byteLength(JSON.stringify(content,(k,v)=>k==='bytes'||k==='chunks'?undefined:v));
  const aggregateEncodedByteLength=bound(encoded+metadataBytes+4096,limits.encodedBytes,'Encoded payload aggregate');
  const body={...content,aggregateEncodedByteLength}; return freeze({...body,digest:sha(canonical(body))});
}
