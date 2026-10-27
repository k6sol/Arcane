import { createHash } from 'node:crypto';
import { types, isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { assetName } from './paths.js';
import { AssetError } from './types.js';
import { CONVERSION_FIDELITY_POLICY, checkConversionMatrix } from './conversion-fidelity-policy.js';

/** Closed data contracts for a derived conversion, not native execution evidence
 * or review authority. The supervised host must verify retained files separately. */
export const GLB_CONVERSION_LIMITS = Object.freeze({ jsonBytes: 512 * 1024, sourceBytes: 64 * 1024 * 1024,
  parts: 128, meshTriangles: 20000, triangles: 100000, exportedBytes: 20 * 1000 * 1000 });
export const GLB_CONVERSION_WORKERS = Object.freeze(['convert_glb.py', 'conversion_audit.py', 'probe.py'] as const);
export const GLB_CONVERSION_IDENTITY = 'arcane-converted-v2';
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const hash = z.string().regex(/^[a-f0-9]{64}(?![\s\S])/);
const uuid = z.string().regex(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}(?![\s\S])/);
const natural = (max: number, min = 0) => z.number().int().min(min).max(max);
const finite = z.number().finite().min(-1000000).max(1000000);
const index = natural(4095);
const key = z.string().regex(/^node[0-9]{1,4}_primitive[0-9]{1,4}(?![\s\S])/);
const id = z.string().regex(/^arcane_[a-f0-9]{64}(?![\s\S])/);
const marker = z.string().regex(/^glb_[a-f0-9]{64}:[0-9]{1,4}:[0-9]{1,4}(?![\s\S])/);
function failed(message: string): never { throw new AssetError('ASSET_CONVERSION_SCHEMA', message); }

/** Reject proxy/accessor input before inspecting a value; copy plain data only. */
function snapshot(input: unknown): unknown {
  let nodes = 0, bytes = 0;
  const charge = (count: number) => { bytes += count; if (bytes > GLB_CONVERSION_LIMITS.jsonBytes) failed('Conversion JSON exceeds 512 KiB.'); };
  function copy(value: unknown, depth: number): unknown {
    if (++nodes > 100000 || depth > 16) failed('Conversion JSON exceeds its structural bound.');
    if (value === null || typeof value === 'boolean') { charge(JSON.stringify(value).length); return value; }
    if (typeof value === 'string') { if (value.length > GLB_CONVERSION_LIMITS.jsonBytes) failed('Conversion string exceeds its bound.'); charge(Buffer.byteLength(JSON.stringify(value))); return value; }
    if (typeof value === 'number') { if (!Number.isFinite(value)) failed('Conversion numbers must be finite.'); charge(JSON.stringify(value).length); return value; }
    if (!value || typeof value !== 'object' || types.isProxy(value)) failed('Conversion requires plain JSON data.');
    const array = Array.isArray(value);
    if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) failed('Conversion requires plain records.');
    if (Object.getOwnPropertySymbols(value).length) failed('Conversion symbols are not data.');
    const descriptors = Object.getOwnPropertyDescriptors(value), out: Record<string, unknown> = Object.create(null);
    charge(2);
    let entries = 0;
    for (const [name, descriptor] of Object.entries(descriptors)) {
      if (array && name === 'length') continue;
      if (!descriptor.enumerable || !('value' in descriptor) || name.length > 64 || ['__proto__', 'constructor', 'prototype'].includes(name)) failed('Conversion accessors or unsupported fields are not data.');
      if (entries) charge(1);
      if (!array) charge(Buffer.byteLength(JSON.stringify(name)) + 1);
      out[name] = copy(descriptor.value, depth + 1); entries++;
    }
    if (array) {
      const length = (descriptors.length as PropertyDescriptor).value as number;
      if (!Number.isSafeInteger(length) || length !== entries || Object.keys(out).some(name => !/^(0|[1-9][0-9]*)$/.test(name) || Number(name) >= length)) failed('Conversion arrays must be dense.');
      return Array.from({ length }, (_, at) => out[String(at)]);
    }
    return out;
  }
  const result = copy(input, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > GLB_CONVERSION_LIMITS.jsonBytes) failed('Conversion JSON exceeds 512 KiB.');
  return result;
}
function parsed<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(snapshot(value));
  if (!result.success) failed('Conversion data does not match its closed contract.');
  return result.data;
}
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) frozen(child); Object.freeze(value); }
  return value;
}
const requestSchema = z.strictObject({ schemaVersion: z.literal(2), fidelityPolicy: z.literal(CONVERSION_FIDELITY_POLICY), kind: z.literal('converted-glb'), jobId: uuid, parentJobId: uuid,
  parentManifestSha256: hash, name: z.string().min(1).max(48), sourceSha256: hash, sourceBytes: natural(GLB_CONVERSION_LIMITS.sourceBytes, 20),
  importSha256: hash, importBytes: natural(GLB_CONVERSION_LIMITS.sourceBytes, 20), sourceMapSha256: hash,
  collision: z.enum(['none', 'convex-hull']), renderResolution: natural(1024, 128), renderSamples: natural(64, 1) });
export type ConvertedGlbRequest = z.infer<typeof requestSchema>;
export function parseConvertedGlbRequest(value: unknown): ConvertedGlbRequest {
  const request = parsed(requestSchema, value); assetName(request.name);
  if (request.jobId === request.parentJobId) failed('Conversion must allocate a distinct derived job.');
  return frozen(request);
}
const partSchema = z.strictObject({ sourceNodeIndex: index, sourceMeshIndex: index, sourcePrimitiveIndex: index, sourceMaterialIndex: index.nullable(),
  sourceKey: key, importNodeIndex: index, originMarker: marker, worldMatrix: z.array(finite).length(16), triangles: natural(20000, 1), vertexCount: natural(60000, 3) });
const nodeKey = z.string().regex(/^node[0-9]{1,4}(?:_primitive[0-9]{1,4})?(?![\s\S])/);
const nodeSchema = z.strictObject({ nodeKey, importNodeIndex: index, parentKey: nodeKey.nullable(), localMatrix: z.array(finite).length(16) });
const mapSchema = z.strictObject({ schemaVersion: z.literal(2), fidelityPolicy: z.literal(CONVERSION_FIDELITY_POLICY), sourceSha256: hash, importSha256: hash, sourceSceneIndex: index,
  declaredSceneCount: natural(4096, 1), parts: z.array(partSchema).min(1).max(128), nodes: z.array(nodeSchema).min(1).max(4096) });
export type ConvertedGlbSourceMap = z.infer<typeof mapSchema>;
export function parseConvertedGlbSourceMap(value: unknown, request: ConvertedGlbRequest): ConvertedGlbSourceMap {
  const r = parseConvertedGlbRequest(request), map = parsed(mapSchema, value);
  if (map.sourceSha256 !== r.sourceSha256 || map.importSha256 !== r.importSha256 || map.sourceSceneIndex >= map.declaredSceneCount ||
      map.parts.length + (r.collision === 'convex-hull' ? 1 : 0) > GLB_CONVERSION_LIMITS.parts ||
      map.parts.reduce((sum, p) => sum + p.triangles, 0) > GLB_CONVERSION_LIMITS.triangles) failed('Conversion map disagrees with retained inputs or budgets.');
  for (const field of ['sourceKey', 'originMarker', 'importNodeIndex'] as const)
    if (new Set(map.parts.map(part => part[field])).size !== map.parts.length) failed('Conversion source mappings must be unique.');
  if (new Set(map.nodes.map(node => node.nodeKey)).size !== map.nodes.length || new Set(map.nodes.map(node => node.importNodeIndex)).size !== map.nodes.length)
    failed('Conversion hierarchy correspondence must be unique.');
  const nodes = new Map(map.nodes.map(node => [node.nodeKey, node]));
  for (const node of map.nodes) {
    try { checkConversionMatrix(node.localMatrix); } catch { failed('Conversion hierarchy has an unsupported affine transform.'); }
    const seen = new Set<string>([node.nodeKey]); let parent = node.parentKey;
    while (parent !== null) {
      if (seen.has(parent) || !nodes.has(parent)) failed('Conversion hierarchy must have complete acyclic parent correspondence.');
      seen.add(parent); if (seen.size > 128) failed('Conversion hierarchy exceeds its admitted depth.'); parent = nodes.get(parent)!.parentKey;
    }
  }
  for (const part of map.parts) {
    if (part.sourceKey !== `node${part.sourceNodeIndex}_primitive${part.sourcePrimitiveIndex}` ||
        part.originMarker !== `glb_${r.sourceSha256}:${part.sourceNodeIndex}:${part.sourcePrimitiveIndex}` ||
        part.worldMatrix[3] !== 0 || part.worldMatrix[7] !== 0 || part.worldMatrix[11] !== 0 || part.worldMatrix[15] !== 1)
      failed('Conversion lineage must identify the actual source primitive and affine transform.');
    try { checkConversionMatrix(part.worldMatrix); } catch { failed('Conversion part has an unsupported world transform.'); }
    const node = nodes.get(part.sourceKey);
    if (!node || node.importNodeIndex !== part.importNodeIndex || node.parentKey !== `node${part.sourceNodeIndex}`)
      failed('Conversion primitive must retain its exact selected source parent.');
  }
  return frozen(map);
}
export function convertedGlbAssetId(sourceSha256: string): string {
  if (!hash.safeParse(sourceSha256).success) failed('Conversion identity needs the retained source digest.');
  return 'arcane_' + sha(sourceSha256 + '\nconverted-root');
}
export function convertedGlbObjectId(sourceSha256: string, role: 'render' | 'collision', sourceKey: string): string {
  if (!hash.safeParse(sourceSha256).success || role !== 'render' && role !== 'collision' ||
      (role === 'render' ? !key.safeParse(sourceKey).success : sourceKey !== 'proxy')) failed('Conversion identity needs exact source lineage.');
  return 'arcane_' + sha(sourceSha256 + '\n' + role + '\n' + sourceKey);
}
const measuredPart = z.strictObject({ sourceKey: key, originMarker: marker, sourceObjectId: id,
  vertices: natural(60000, 3), triangles: natural(20000, 1), boundaryEdges: natural(180000), nonManifoldEdges: natural(180000),
  looseVertices: z.literal(0), looseEdges: z.literal(0), degenerateFaces: z.literal(0), invalidUVs: z.literal(0), uvLayers: natural(8),
  finitePositions: z.literal(true), geometrySha256: hash, correspondenceSha256: hash, materialSha256: hash });
const exportObject = z.strictObject({ sourceObjectId: id, sourceKey: z.union([key, z.literal('proxy')]), nodeIndex: index,
  role: z.enum(['render', 'collision']), pivot: z.tuple([z.literal(0), z.literal(0), z.literal(0)]),
  collisionFor: z.array(id).max(128), originMarker: marker.nullable() });
const exportModel = z.strictObject({ path: z.enum(['asset.glb', 'collision.glb']), sha256: hash,
  byteLength: natural(GLB_CONVERSION_LIMITS.exportedBytes, 20), generator: z.string().min(1).max(256).regex(/^[\x20-\x7e]+(?![\s\S])/),
  objects: z.array(exportObject).min(1).max(128), anchors: z.array(z.never()).max(0) });
const render = z.strictObject({ path: z.enum(['preview-hero.png', 'preview-side.png']), width: natural(1024, 128), height: natural(1024, 128),
  finitePixels: z.literal(true), minLuminance: z.number().finite().min(0).max(1000000), maxLuminance: z.number().finite().min(0).max(1000000),
  meanLuminance: z.number().finite().min(0).max(1000000), standardDeviation: z.number().finite().positive().max(1000000) });
const auditSchema = z.strictObject({ schemaVersion: z.literal(2), fidelityPolicy: z.literal(CONVERSION_FIDELITY_POLICY), kind: z.literal('arcane-glb-conversion-audit'), jobId: uuid, parentJobId: uuid,
  parentManifestSha256: hash, requestSha256: hash, sourceSha256: hash, importSha256: hash, sourceMapSha256: hash,
  identityScheme: z.literal(GLB_CONVERSION_IDENTITY), assetId: id, blenderVersion: z.string().min(1).max(128).regex(/^[\x20-\x7e]+(?![\s\S])/),
  collision: z.enum(['none', 'convex-hull']), importedParts: z.array(measuredPart).min(1).max(128), reopenedParts: z.array(measuredPart).min(1).max(128),
  models: z.array(exportModel).min(1).max(2), renders: z.array(render).length(2), savedSceneReopened: z.literal(true),
  errors: z.array(z.never()).max(0), warnings: z.array(z.enum(['open-render-surfaces', 'no-collision-proxy', 'delivery-support-pending'])).max(3) });
export type ConvertedGlbAudit = z.infer<typeof auditSchema>;

/** Checks closed observed statements against host-owned lineage. This cannot
 * establish that Blender ran; actual file validation and owned close are mandatory. */
export function parseConvertedGlbAudit(value: unknown, request: ConvertedGlbRequest, sourceMap: ConvertedGlbSourceMap, requestSha256: string): ConvertedGlbAudit {
  const r = parseConvertedGlbRequest(request), map = parseConvertedGlbSourceMap(sourceMap, r), audit = parsed(auditSchema, value);
  if (!hash.safeParse(requestSha256).success || audit.requestSha256 !== requestSha256 || audit.jobId !== r.jobId || audit.parentJobId !== r.parentJobId ||
      audit.parentManifestSha256 !== r.parentManifestSha256 || audit.sourceSha256 !== r.sourceSha256 || audit.importSha256 !== r.importSha256 ||
      audit.sourceMapSha256 !== r.sourceMapSha256 || audit.collision !== r.collision || audit.assetId !== convertedGlbAssetId(r.sourceSha256))
    failed('Conversion audit disagrees with its derived request.');
  for (const rows of [audit.importedParts, audit.reopenedParts]) {
    if (rows.length !== map.parts.length || new Set(rows.map(p => p.sourceKey)).size !== rows.length) failed('Conversion audit lost or duplicated source parts.');
    for (const part of map.parts) {
      const row = rows.find(p => p.sourceKey === part.sourceKey);
      if (!row || row.originMarker !== part.originMarker || row.sourceObjectId !== convertedGlbObjectId(r.sourceSha256, 'render', part.sourceKey) || row.triangles !== part.triangles ||
          row.boundaryEdges > row.nonManifoldEdges) failed('Conversion observation disagrees with mapped source geometry.');
    }
  }
  const sort = <T extends { sourceKey: string }>(rows: T[]) => [...rows].sort((a, b) => a.sourceKey.localeCompare(b.sourceKey, 'en'));
  if (!isDeepStrictEqual(sort(audit.importedParts), sort(audit.reopenedParts))) failed('Saved-scene reopen changed measured source geometry or materials.');
  const paths = r.collision === 'none' ? ['asset.glb'] : ['asset.glb', 'collision.glb'];
  if (!isDeepStrictEqual(audit.models.map(m => m.path).sort(), paths) || new Set(audit.models.map(m => m.generator)).size !== 1) failed('Conversion export inventory disagrees with collision policy.');
  const renderIds = map.parts.map(p => convertedGlbObjectId(r.sourceSha256, 'render', p.sourceKey)).sort();
  for (const model of audit.models) {
    if (new Set(model.objects.map(o => o.nodeIndex)).size !== model.objects.length || new Set(model.objects.map(o => o.sourceObjectId)).size !== model.objects.length)
      failed('Conversion exported duplicate node or object mappings.');
    if (model.path === 'asset.glb') {
      if (model.objects.length !== map.parts.length) failed('Conversion export lost mapped render parts.');
      for (const part of map.parts) {
        const object = model.objects.find(o => o.sourceKey === part.sourceKey);
        if (!object || object.role !== 'render' || object.sourceObjectId !== convertedGlbObjectId(r.sourceSha256, 'render', part.sourceKey) ||
            object.originMarker !== part.originMarker || object.collisionFor.length) failed('Conversion export lost original render lineage.');
      }
    } else {
      const object = model.objects[0];
      if (model.objects.length !== 1 || !object || object.role !== 'collision' || object.sourceKey !== 'proxy' || object.originMarker !== null ||
          object.sourceObjectId !== convertedGlbObjectId(r.sourceSha256, 'collision', 'proxy') || !isDeepStrictEqual(object.collisionFor, renderIds))
        failed('Conversion collision export disagrees with its explicit mapped targets.');
    }
  }
  if (new Set(audit.renders.map(r => r.path)).size !== 2 || new Set(audit.warnings).size !== audit.warnings.length) failed('Conversion review images or warnings are duplicated.');
  for (const image of audit.renders) if (image.width !== r.renderResolution || image.height !== r.renderResolution ||
      image.maxLuminance - image.minLuminance <= 1e-3 || image.standardDeviation <= 1e-4 ||
      image.meanLuminance < image.minLuminance || image.meanLuminance > image.maxLuminance) failed('Conversion review render is empty or has inconsistent measured pixels.');
  return frozen(audit);
}
