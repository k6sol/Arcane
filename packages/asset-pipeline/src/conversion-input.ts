import { types, isDeepStrictEqual } from 'node:util';
import { validateGlb } from '../../../apps/desktop/src/glb-preflight.js';
import { parseAdoptedGlbManifest } from './adopted-glb.js';
import { parseConvertedGlbJson } from './converted-glb-manifest.js';
import { prepareGlbConversionSource } from './glb-conversion-source.js';
import { GLB_CONVERSION_LIMITS } from './converted-glb.js';
import { assetName } from './paths.js';
import { sha256 } from './validation.js';
import { AssetError } from './types.js';

/** Trusted in-process snapshots from an admitted managed parent. This is not an
 * HTTP/MCP input, caller-selected script, permission claim or producer receipt. */
export interface GlbConversionInput {
  sourceGlb: Buffer;
  parentManifest: Buffer;
  parentManifestSha256: string;
  name: string;
  collision: 'none' | 'convex-hull';
  renderResolution: number;
  renderSamples: number;
}
function fail(): never { throw new AssetError('ASSET_CONVERSION_INPUT', 'Conversion requires bounded retained source and parent snapshots with matching lineage.'); }
const typedArray = Object.getPrototypeOf(Uint8Array.prototype) as object;
const bufferOf = Object.getOwnPropertyDescriptor(typedArray, 'buffer')!.get!;
const lengthOf = Object.getOwnPropertyDescriptor(typedArray, 'byteLength')!.get!;
const offsetOf = Object.getOwnPropertyDescriptor(typedArray, 'byteOffset')!.get!;
function bytes(value: unknown, limit: number, minimum: number): Buffer {
  if (!value || typeof value !== 'object' || types.isProxy(value) || !Buffer.isBuffer(value) ||
      Object.getPrototypeOf(value) !== Buffer.prototype) fail();
  // Intrinsics ignore shadowed .buffer/.length accessors on a Buffer instance.
  const buffer = Reflect.apply(bufferOf, value, []) as ArrayBuffer;
  const length = Reflect.apply(lengthOf, value, []) as number;
  const offset = Reflect.apply(offsetOf, value, []) as number;
  if (types.isSharedArrayBuffer(buffer) || length < minimum || length > limit) fail();
  return Buffer.from(new Uint8Array(buffer, offset, length));
}
/** Snapshot synchronously before a job is allocated or a native process starts.
 * Returned buffers belong to the pipeline; callers cannot change admitted bytes. */
export function snapshotGlbConversionInput(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || types.isProxy(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail();
  const fields = ['sourceGlb', 'parentManifest', 'parentManifestSha256', 'name', 'collision', 'renderResolution', 'renderSamples'];
  const own = Reflect.ownKeys(input);
  if (own.length !== fields.length || own.some(key => typeof key !== 'string' || !fields.includes(key))) fail();
  const descriptors = Object.getOwnPropertyDescriptors(input), data: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
    data[field] = descriptor.value as unknown;
  }
  const sourceGlb = bytes(data.sourceGlb, GLB_CONVERSION_LIMITS.sourceBytes, 20);
  const parentManifest = bytes(data.parentManifest, GLB_CONVERSION_LIMITS.jsonBytes, 2);
  if (typeof data.parentManifestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(data.parentManifestSha256) ||
      sha256(parentManifest) !== data.parentManifestSha256) fail();
  const name = assetName(data.name), collision = data.collision, resolution = data.renderResolution, samples = data.renderSamples;
  if (name.trim() !== name || (collision !== 'none' && collision !== 'convex-hull') || typeof resolution !== 'number' || !Number.isInteger(resolution) || resolution < 128 || resolution > 1024 ||
      typeof samples !== 'number' || !Number.isInteger(samples) || samples < 1 || samples > 64) fail();
  let parentJobId: string;
  try { parentJobId = parseAdoptedGlbManifest(parseConvertedGlbJson(parentManifest)).jobId; } catch { fail(); }
  return Object.freeze({ sourceGlb, parentManifest, parentManifestSha256: data.parentManifestSha256, parentJobId,
    name, collision, renderResolution: resolution, renderSamples: samples });
}

/** Actual source inspection belongs to the asynchronous job, after its handle is
 * available and its initial journal has been saved. No native process is started. */
export function prepareRetainedGlbConversionInput(input: ReturnType<typeof snapshotGlbConversionInput>) {
  const { sourceGlb, parentManifest, collision } = input;
  if (sha256(parentManifest) !== input.parentManifestSha256) fail();
  const parent = parseAdoptedGlbManifest(parseConvertedGlbJson(parentManifest));
  if (parent.jobId !== input.parentJobId || parent.provenance.sourceSha256 !== sha256(sourceGlb) || parent.provenance.sourceBytes !== sourceGlb.length) fail();
  let metadata: ReturnType<typeof validateGlb>;
  try { metadata = validateGlb(Uint8Array.from(sourceGlb).buffer); } catch { fail(); }
  if (!isDeepStrictEqual(metadata, parent.validation.metadata)) fail();
  const source = prepareGlbConversionSource(sourceGlb, parent.provenance.sourceSha256);
  if (source.parts.length + (collision === 'convex-hull' ? 1 : 0) > GLB_CONVERSION_LIMITS.parts) fail();
  return { ...input, parent, source };
}
