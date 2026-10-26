import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { validateGlb, GLB_PREFLIGHT_LIMITS } from '../../../apps/desktop/src/glb-preflight.js';
import { matrixFromTrs, multiplyMatrix4 } from '../../core/src/spatial-math.js';
import { STUDIO_IMPORT_LIMITS } from './studio-import-manifest.js';
import { AssetError } from './types.js';

/** Host-authored lineage marker, never an exported producer identity or approval. */
export const GLB_CONVERSION_ORIGIN = 'arcane_conversion_origin_v1';
export interface GlbConversionPart {
  readonly sourceNodeIndex: number;
  readonly sourceMeshIndex: number;
  readonly sourcePrimitiveIndex: number;
  readonly sourceMaterialIndex: number | null;
  readonly sourceKey: string;
  readonly importNodeIndex: number;
  readonly originMarker: string;
  readonly worldMatrix: readonly number[];
  readonly triangles: number;
}
export interface GlbConversionSource {
  readonly sourceSha256: string;
  readonly sourceBytes: number;
  readonly sourceSceneIndex: number;
  readonly declaredSceneCount: number;
  readonly importSha256: string;
  /** New disposable import copy. Original managed bytes are never modified. */
  readonly importBytes: Buffer;
  readonly parts: readonly GlbConversionPart[];
}
type Data = Record<string, unknown>;
interface Node extends Data { mesh?: number; children?: number[]; skin?: number; weights?: number[]; camera?: number;
  matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }
interface Primitive extends Data { attributes: Record<string, number>; indices?: number; material?: number; mode?: number; targets?: unknown[] }
interface Mesh extends Data { primitives: Primitive[]; weights?: number[] }
interface Document extends Data { scene?: number; scenes?: { nodes?: number[] }[]; nodes?: Node[]; meshes: Mesh[];
  accessors: { count: number }[]; skins?: unknown[]; animations?: unknown[]; cameras?: unknown[] }
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
function refused(code: string, message: string): never { throw new AssetError(code, message); }
function removeExtras(root: unknown): void {
  const pending: unknown[] = [root];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value)) pending.push(...value);
    else for (const key of Object.keys(value)) {
      if (key === 'extras') delete (value as Data)[key];
      else pending.push((value as Data)[key]);
    }
  }
}

/** Pure preparation for a future supervised converter. This does not run Blender,
 * mint worker evidence, validate a conversion, or grant review/import authority.
 * The service must first admit the parent and supply its immutable managed hash.
 * Core static multi-mesh/material inputs, UV seams and open foliage are preserved;
 * unsupported animated inputs are refused explicitly rather than flattened. */
export function prepareGlbConversionSource(bytes: Buffer, expectedSha256: string): GlbConversionSource {
  if (types.isProxy(bytes) || !Buffer.isBuffer(bytes) || types.isSharedArrayBuffer(bytes.buffer) ||
      bytes.length < 20 || bytes.length > GLB_PREFLIGHT_LIMITS.bytes || typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSha256))
    refused('ASSET_CONVERSION_SOURCE', 'Conversion requires a bounded immutable managed GLB and its exact retained digest.');
  const source = Buffer.from(bytes);
  if (digest(source) !== expectedSha256) refused('ASSET_CONVERSION_SOURCE', 'The retained GLB bytes no longer match their source digest.');
  try { validateGlb(Uint8Array.from(source).buffer); }
  catch { refused('ASSET_CONVERSION_GLB', 'The retained GLB failed preview admission before conversion.'); }
  const oldJsonBytes = source.readUInt32LE(12);
  const doc = JSON.parse(source.subarray(20, 20 + oldJsonBytes).toString('utf8')) as Document;
  const originalNodes = doc.nodes ?? [], scenes = doc.scenes ?? [];
  if ((doc.skins?.length ?? 0) || (doc.animations?.length ?? 0) ||
      originalNodes.some(node => node.skin !== undefined || node.weights !== undefined) ||
      doc.meshes.some(mesh => mesh.weights !== undefined || mesh.primitives.some(p => p.targets !== undefined)))
    refused('ASSET_CONVERSION_ANIMATION', 'Static conversion cannot discard skins, morph targets or animation. Keep the original model for an animation-capable conversion.');
  if ((doc.cameras?.length ?? 0) || originalNodes.some(node => node.camera !== undefined ||
      !!(node.extensions as Data | undefined)?.KHR_lights_punctual))
    refused('ASSET_CONVERSION_SCENE', 'This conversion preserves model geometry; cameras and scene lights require their own explicit conversion.');
  const sceneIndex = doc.scene ?? 0, selected = scenes[sceneIndex];
  if (!selected) refused('ASSET_CONVERSION_SCENE', 'The model has no default scene to convert.');
  const reachable: number[] = [], world = new Map<number, number[]>();
  const identity = matrixFromTrs();
  const pending = [...(selected.nodes ?? [])].reverse().map(index => ({ index, parent: -1 }));
  while (pending.length) {
    const { index, parent } = pending.pop()!;
    const node = originalNodes[index]!;
    if (world.has(index)) refused('ASSET_CONVERSION_SCENE', 'The selected model hierarchy has repeated nodes.');
    const local = node.matrix ?? matrixFromTrs(node.translation, node.rotation, node.scale);
    world.set(index, multiplyMatrix4(parent < 0 ? identity : world.get(parent)!, local));
    reachable.push(index);
    for (const child of [...(node.children ?? [])].reverse()) pending.push({ index: child, parent: index });
  }
  // Preserve the selected hierarchy, but give each actual source primitive its
  // own marked mesh node. Material slots/instances cannot become ambiguous after import.
  const remap = new Map(reachable.map((index, at) => [index, at]));
  const nodes: Node[] = reachable.map(index => {
    const node = { ...originalNodes[index]! };
    delete node.mesh;
    if (node.children) node.children = node.children.map(child => remap.get(child)!);
    return node;
  });
  const meshes: Mesh[] = [], parts: GlbConversionPart[] = [];
  let totalTriangles = 0;
  for (const index of reachable) {
    const original = originalNodes[index]!;
    if (original.mesh === undefined) continue;
    const mesh = doc.meshes[original.mesh]!;
    for (let primitiveIndex = 0; primitiveIndex < mesh.primitives.length; primitiveIndex++) {
      const primitive = mesh.primitives[primitiveIndex]!;
      const count = doc.accessors[primitive.indices ?? primitive.attributes.POSITION!]!.count;
      const mode = primitive.mode ?? 4;
      if (![4, 5, 6].includes(mode)) refused('ASSET_CONVERSION_TOPOLOGY', 'Line and point primitives need an explicit geometric conversion; none were discarded.');
      const triangles = mode === 4 ? count / 3 : count - 2;
      totalTriangles += triangles;
      if (parts.length >= STUDIO_IMPORT_LIMITS.objects || triangles > STUDIO_IMPORT_LIMITS.meshTriangles || totalTriangles > STUDIO_IMPORT_LIMITS.triangles)
        refused('ASSET_CONVERSION_BUDGET', 'The selected model exceeds the current import object or triangle budget. No geometry was simplified.');
      const sourceKey = `node${index}_primitive${primitiveIndex}`;
      const originMarker = `${expectedSha256}:${index}:${primitiveIndex}`;
      const importNodeIndex = nodes.length;
      const split = { ...mesh, primitives: [primitive] };
      meshes.push(split);
      nodes.push({ mesh: meshes.length - 1, name: sourceKey, extras: { [GLB_CONVERSION_ORIGIN]: originMarker } });
      const parent = nodes[remap.get(index)!]!;
      parent.children = [...(parent.children ?? []), importNodeIndex];
      parts.push(Object.freeze({ sourceNodeIndex: index, sourceMeshIndex: original.mesh, sourcePrimitiveIndex: primitiveIndex,
        sourceMaterialIndex: primitive.material ?? null, sourceKey, importNodeIndex, originMarker,
        worldMatrix: Object.freeze([...world.get(index)!]), triangles }));
    }
  }
  if (!parts.length) refused('ASSET_CONVERSION_EMPTY', 'The selected scene contains no mesh primitives to convert.');
  if (nodes.length > GLB_PREFLIGHT_LIMITS.nodes) refused('ASSET_CONVERSION_BUDGET', 'Primitive correspondence would exceed the bounded model node inventory.');
  // Strip every source-supplied extra before installing only host-owned markers.
  // Retained original source bytes keep all original metadata for provenance.
  removeExtras(doc);
  removeExtras(nodes);
  removeExtras(meshes);
  for (const part of parts) nodes[part.importNodeIndex]!.extras = { [GLB_CONVERSION_ORIGIN]: part.originMarker };
  doc.nodes = nodes; doc.meshes = meshes;
  doc.scenes = [{ nodes: (selected.nodes ?? []).map(index => remap.get(index)!) }]; doc.scene = 0;
  const encoded = Buffer.from(JSON.stringify(doc)), padding = (4 - encoded.length % 4) % 4;
  const json = Buffer.concat([encoded, Buffer.alloc(padding, 32)]), tail = source.subarray(20 + oldJsonBytes);
  const output = Buffer.alloc(20 + json.length + tail.length);
  source.copy(output, 0, 0, 12); output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(json.length, 12); output.writeUInt32LE(0x4e4f534a, 16);
  json.copy(output, 20); tail.copy(output, 20 + json.length);
  try { validateGlb(Uint8Array.from(output).buffer); }
  catch { refused('ASSET_CONVERSION_PREPARED', 'The marked import copy failed bounded GLB validation; no converter was started.'); }
  return Object.freeze({ sourceSha256: expectedSha256, sourceBytes: source.length, sourceSceneIndex: sceneIndex,
    declaredSceneCount: scenes.length, importSha256: digest(output), importBytes: output, parts: Object.freeze(parts) });
}
