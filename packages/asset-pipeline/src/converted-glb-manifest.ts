import { createHash } from 'node:crypto';
import { types, isDeepStrictEqual } from 'node:util';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { validateGlb } from '../../../apps/desktop/src/glb-preflight.js';
import { AssetError, type Artifact, type RuntimeEvidence } from './types.js';
import { artifactPath, noLinks, regularFile, readRegularFile } from './paths.js';
import { inspectPng } from './validation.js';
import { decodeMaterialPng, materialPngPixels } from './material-png.js';
import { parseAdoptedGlbManifest } from './adopted-glb.js';
import { parseConvertedGlbRequest, parseConvertedGlbSourceMap, parseConvertedGlbAudit,
  GLB_CONVERSION_WORKERS, type ConvertedGlbRequest, type ConvertedGlbSourceMap, type ConvertedGlbAudit } from './converted-glb.js';
import { prepareGlbConversionSource } from './glb-conversion-source.js';
import { verifyGlbConversionFidelity } from './glb-conversion-fidelity.js';
import { validateConvertedGlbCollision } from './converted-glb-collision.js';

export interface ConvertedGlbManifest {
  schemaVersion: 2; origin: 'converted-glb'; jobId: string; createdAt: string;
  request: ConvertedGlbRequest; runtime: RuntimeEvidence; workerBundleSha256: string;
  coordinateSystem: { units: 'meters'; sceneUp: 'Z'; glbUp: 'Y'; pivot: 'source'; robloxScaleVerified: false };
  sourceMap: ConvertedGlbSourceMap; validation: ConvertedGlbAudit; artifacts: Artifact[]; limitations: string[];
}
export const CONVERTED_GLB_ARTIFACT_LIMITS = Object.freeze({ totalBytes: 256 * 1024 * 1024,
  sourceBytes: 64 * 1024 * 1024, blendBytes: 128 * 1024 * 1024, exportBytes: 20_000_000,
  previewBytes: 8 * 1024 * 1024, jsonBytes: 512 * 1024, workerBytes: 1024 * 1024 });
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function fail(code = 'ASSET_CONVERSION_MANIFEST'): never { throw new AssetError(code, 'Retained converted-model artifacts do not match their bounded lineage and file contract.'); }

/** Copy data before schema traversal. No proxy trap, getter, symbol, executable
 * object, sparse array or oversized escaped serialization is admitted. */
function snapshot(input: unknown): unknown {
  let nodes = 0, bytes = 0;
  function charge(value: number): void { bytes += value; if (bytes > CONVERTED_GLB_ARTIFACT_LIMITS.jsonBytes) fail(); }
  function copy(value: unknown, depth: number): unknown {
    if (++nodes > 100000 || depth > 16) fail();
    if (value === null || typeof value === 'boolean') { charge(JSON.stringify(value).length); return value; }
    if (typeof value === 'string') {
      if (value.length > CONVERTED_GLB_ARTIFACT_LIMITS.jsonBytes || Buffer.from(value).toString('utf8') !== value) fail();
      charge(Buffer.byteLength(JSON.stringify(value))); return value;
    }
    // Raw Python JSON may retain -0.0 while a later JS manifest writes 0.
    if (typeof value === 'number') { if (!Number.isFinite(value)) fail(); charge(JSON.stringify(value).length); return value === 0 ? 0 : value; }
    if (!value || typeof value !== 'object' || types.isProxy(value)) fail();
    const array = Array.isArray(value), proto: unknown = Object.getPrototypeOf(value);
    if ((!array && proto !== Object.prototype && proto !== null) || Object.getOwnPropertySymbols(value).length) fail();
    const descriptors = Object.getOwnPropertyDescriptors(value), result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    charge(2); let entries = 0;
    for (const [name, descriptor] of Object.entries(descriptors)) {
      if (array && name === 'length') continue;
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || name.length > 64 || ['__proto__', 'constructor', 'prototype'].includes(name)) fail();
      if (entries) charge(1); if (!array) charge(Buffer.byteLength(JSON.stringify(name)) + 1);
      result[name] = copy(descriptor.value as unknown, depth + 1); entries++;
    }
    if (!array) return result;
    const length: unknown = descriptors.length?.value;
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length !== entries || Object.keys(result).some(name => !/^(0|[1-9][0-9]*)$/.test(name) || Number(name) >= length)) fail();
    return Array.from({ length }, (_, at) => result[String(at)]);
  }
  return copy(input, 0);
}

/** Fixed retained JSON decoder also refuses duplicate keys. A normal reviver
 * cannot detect duplicates already overwritten by JSON.parse. */
function jsonFile(raw: Buffer): unknown {
  if (types.isProxy(raw) || !Buffer.isBuffer(raw) || types.isSharedArrayBuffer(raw.buffer)) fail();
  if (!raw.length || raw.length > CONVERTED_GLB_ARTIFACT_LIMITS.jsonBytes) fail();
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw); } catch { fail(); }
  let at = 0, count = 0;
  const whitespace = () => { while (at < text.length && /[\x20\t\r\n]/.test(text[at]!)) at++; };
  function string(): string {
    if (text[at] !== '"') fail(); const start = at++; let escaped = false;
    while (at < text.length) {
      const char = text[at++]!;
      if (char === '"' && !escaped) {
        let value: unknown; try { value = JSON.parse(text.slice(start, at)) as unknown; } catch { fail(); }
        if (typeof value !== 'string') fail(); return value;
      }
      if (char === '\\' && !escaped) escaped = true; else escaped = false;
    }
    fail();
  }
  function value(depth: number): unknown {
    if (++count > 100000 || depth > 16) fail(); whitespace();
    if (text[at] === '"') return string();
    if (text[at] === '{') {
      at++; whitespace(); const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      if (text[at] === '}') { at++; return result; }
      while (true) {
        whitespace(); const key = string(); whitespace();
        if (Object.hasOwn(result, key) || ['__proto__', 'constructor', 'prototype'].includes(key) || text[at++] !== ':') fail();
        result[key] = value(depth + 1); whitespace();
        const separator = text[at++]; if (separator === '}') return result; if (separator !== ',') fail();
      }
    }
    if (text[at] === '[') {
      at++; whitespace(); const result: unknown[] = [];
      if (text[at] === ']') { at++; return result; }
      while (true) {
        result.push(value(depth + 1)); whitespace(); const separator = text[at++];
        if (separator === ']') return result; if (separator !== ',') fail();
      }
    }
    const token = /(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/y;
    token.lastIndex = at; const match = token.exec(text); if (!match) fail(); at = token.lastIndex;
    try { return JSON.parse(match[0]) as unknown; } catch { fail(); }
  }
  const result = value(0); whitespace(); if (at !== text.length) fail(); return snapshot(result);
}

/** Bounded duplicate-key-safe raw retained JSON data, without native authority. */
export const parseConvertedGlbJson: (raw: Buffer) => unknown = jsonFile;

const hash = z.string().regex(/^[a-f0-9]{64}(?![\s\S])/);
const uuid = z.string().regex(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}(?![\s\S])/);
const text = (maximum: number) => z.string().min(1).max(maximum).refine(value => !/[\x00-\x1f\x7f]/.test(value));
const runtimeSchema = z.strictObject({ executable: text(4096), version: text(128), pythonVersion: text(128), background: z.literal(true),
  capabilities: z.strictObject({ glbExport: z.literal(true), glbImport: z.literal(true), fbxExport: z.literal(true), fbxImport: z.literal(true), cycles: z.literal(true) }) });
const artifactSchema = z.strictObject({ path: z.string().min(1).max(96), role: z.enum(['scene', 'checkpoint', 'export', 'preview', 'audit', 'request', 'worker']),
  bytes: z.number().int().min(1).max(CONVERTED_GLB_ARTIFACT_LIMITS.blendBytes), sha256: hash });
const manifestSchema = z.strictObject({ schemaVersion: z.literal(2), origin: z.literal('converted-glb'), jobId: uuid,
  createdAt: text(64).refine(value => Number.isFinite(Date.parse(value))), request: z.unknown(), runtime: runtimeSchema, workerBundleSha256: hash,
  coordinateSystem: z.strictObject({ units: z.literal('meters'), sceneUp: z.literal('Z'), glbUp: z.literal('Y'), pivot: z.literal('source'), robloxScaleVerified: z.literal(false) }),
  sourceMap: z.unknown(), validation: z.unknown(), artifacts: z.array(artifactSchema).min(13).max(14), limitations: z.array(text(2048)).max(32) });

function inventory(collision: ConvertedGlbRequest['collision']): ReadonlyMap<string, Readonly<{ role: Artifact['role']; limit: number }>> {
  const limits = CONVERTED_GLB_ARTIFACT_LIMITS;
  const entries: [string, { role: Artifact['role']; limit: number }][] = [
    ['source.glb', { role: 'request', limit: limits.sourceBytes }], ['import-source.glb', { role: 'request', limit: limits.sourceBytes }],
    ['parent-manifest.json', { role: 'request', limit: limits.jsonBytes }], ['source-map.json', { role: 'request', limit: limits.jsonBytes }],
    ['request.json', { role: 'request', limit: limits.jsonBytes }], ...GLB_CONVERSION_WORKERS.map(path => [path, { role: 'worker' as const, limit: limits.workerBytes }] as [string, { role: Artifact['role']; limit: number }]),
    ['asset.blend', { role: 'scene', limit: limits.blendBytes }], ['asset.glb', { role: 'export', limit: limits.exportBytes }],
    ['conversion-audit.json', { role: 'audit', limit: limits.jsonBytes }], ['preview-hero.png', { role: 'preview', limit: limits.previewBytes }],
    ['preview-side.png', { role: 'preview', limit: limits.previewBytes }],
  ];
  if (collision === 'convex-hull') entries.push(['collision.glb', { role: 'export', limit: limits.exportBytes }]);
  return new Map(entries);
}
function frozen<T>(value: T): T { if (value && typeof value === 'object') { for (const child of Object.values(value)) frozen(child); Object.freeze(value); } return value; }

/** Closed retained attribution/measurements only. Runtime strings and worker
 * digests are never executed or promoted into owned-process/permission proof. */
export function parseConvertedGlbManifest(value: unknown): ConvertedGlbManifest {
  const result = manifestSchema.safeParse(snapshot(value)); if (!result.success) fail();
  const raw = result.data, request = parseConvertedGlbRequest(raw.request), map = parseConvertedGlbSourceMap(raw.sourceMap, request);
  const expected = inventory(request.collision), artifacts = new Map<string, Artifact>(); let total = 0;
  for (const artifact of raw.artifacts) {
    const fixed = expected.get(artifact.path);
    if (!fixed || artifacts.has(artifact.path) || fixed.role !== artifact.role || artifact.bytes > fixed.limit) fail();
    artifacts.set(artifact.path, artifact); total += artifact.bytes;
  }
  if (artifacts.size !== expected.size || total > CONVERTED_GLB_ARTIFACT_LIMITS.totalBytes) fail();
  const get = (name: string) => { const artifact = artifacts.get(name); if (!artifact) fail(); return artifact; };
  const validation = parseConvertedGlbAudit(raw.validation, request, map, get('request.json').sha256);
  if (raw.jobId !== request.jobId || raw.runtime.version !== validation.blenderVersion || request.parentManifestSha256 !== get('parent-manifest.json').sha256 ||
      request.sourceSha256 !== get('source.glb').sha256 || request.sourceBytes !== get('source.glb').bytes || request.importSha256 !== get('import-source.glb').sha256 ||
      request.importBytes !== get('import-source.glb').bytes || request.sourceMapSha256 !== get('source-map.json').sha256 ||
      raw.workerBundleSha256 !== sha(GLB_CONVERSION_WORKERS.map(name => get(name).sha256).join('\n'))) fail();
  for (const model of validation.models) if (model.sha256 !== get(model.path).sha256 || model.byteLength !== get(model.path).bytes) fail();
  return frozen({ ...raw, request, sourceMap: map, validation });
}

/** Revalidates only direct managed retained snapshots, never original project
 * paths or executable evidence. Native execution/owned close is a separate
 * supervisor obligation, and file validation grants no review/import authority. */
export async function validateConvertedGlbManifestFiles(directory: string, value: unknown): Promise<ConvertedGlbManifest> {
  const manifest = parseConvertedGlbManifest(value), expected = inventory(manifest.request.collision);
  if (typeof directory !== 'string' || !isAbsolute(directory)) fail();
  await noLinks(directory);
  const retained = new Map<string, Buffer>(); let total = 0;
  const keep = new Set(['source.glb', 'import-source.glb', 'parent-manifest.json', 'source-map.json', 'request.json', 'asset.glb', 'conversion-audit.json', 'preview-hero.png', 'preview-side.png', 'collision.glb']);
  for (const artifact of manifest.artifacts) {
    const path = artifactPath(directory, artifact.path), limit = expected.get(artifact.path)!.limit;
    const size = await regularFile(path, limit); total += size;
    if (size !== artifact.bytes || total > CONVERTED_GLB_ARTIFACT_LIMITS.totalBytes) fail();
    const bytes = await readRegularFile(path, limit);
    if (bytes.length !== artifact.bytes || sha(bytes) !== artifact.sha256) fail('HASH');
    if (keep.has(artifact.path)) retained.set(artifact.path, bytes);
  }
  const bytes = (name: string) => { const value = retained.get(name); if (!value) fail(); return value; };
  const request = parseConvertedGlbRequest(jsonFile(bytes('request.json'))), map = parseConvertedGlbSourceMap(jsonFile(bytes('source-map.json')), request);
  const requestHash = sha(bytes('request.json')), audit = parseConvertedGlbAudit(jsonFile(bytes('conversion-audit.json')), request, map, requestHash);
  if (!isDeepStrictEqual(request, manifest.request) || !isDeepStrictEqual(map, manifest.sourceMap) || !isDeepStrictEqual(audit, manifest.validation)) fail();
  const parent = parseAdoptedGlbManifest(jsonFile(bytes('parent-manifest.json')));
  if (parent.jobId !== request.parentJobId || parent.jobId === manifest.jobId || parent.provenance.sourceSha256 !== request.sourceSha256 ||
      parent.provenance.sourceBytes !== request.sourceBytes || parent.request.sourceSha256 !== request.sourceSha256 || parent.request.sourceBytes !== request.sourceBytes) fail();
  let metadata: ReturnType<typeof validateGlb>;
  try { metadata = validateGlb(Uint8Array.from(bytes('source.glb')).buffer); } catch { fail(); }
  if (!isDeepStrictEqual(metadata, parent.validation.metadata)) fail();
  const prepared = prepareGlbConversionSource(bytes('source.glb'), request.sourceSha256);
  if (prepared.importSha256 !== request.importSha256 || prepared.importBytes.length !== request.importBytes || !prepared.importBytes.equals(bytes('import-source.glb')) ||
      prepared.sourceSceneIndex !== map.sourceSceneIndex || prepared.declaredSceneCount !== map.declaredSceneCount || !isDeepStrictEqual(prepared.parts, map.parts) || !isDeepStrictEqual(prepared.nodes, map.nodes)) fail();
  verifyGlbConversionFidelity(bytes('source.glb'), bytes('asset.glb'), request, map, audit, requestHash);
  for (const name of ['preview-hero.png', 'preview-side.png']) {
    const png = bytes(name); inspectPng(png, request.renderResolution);
    const decoded = decodeMaterialPng(png);
    if (decoded.width !== request.renderResolution || decoded.height !== request.renderResolution) fail();
    const rgba = materialPngPixels(decoded); let low = Infinity, high = -Infinity;
    for (let at = 0; at < rgba.length; at += 4) { const luminance = .2126 * rgba[at]! + .7152 * rgba[at + 1]! + .0722 * rgba[at + 2]!; low = Math.min(low, luminance); high = Math.max(high, luminance); }
    if (!(high > low)) fail('RENDER');
    // Encoded PNG samples are not bpy linear render pixels: do not manufacture
    // equality to worker min/mean/stddev observations from a different space.
  }
  if (request.collision === 'convex-hull') validateConvertedGlbCollision(bytes('collision.glb'), request, map, audit, requestHash);
  await noLinks(directory);
  return manifest;
}
