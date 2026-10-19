import {createHash} from 'node:crypto';
import {STUDIO_ASSET_TRANSFER_LIMITS} from '../../protocol/src/studio.js';
import {assertDecodedStudioImportPayload, type StudioImportPayload, type StudioImportPayloadBuffer} from './studio-import-payload.js';
import {parseNativeStudioImportResponse} from './studio-import-wire.js';
import type {PreparedStudioImport} from './studio-import-manifest.js';

/** Internal transport data, not registered Studio commands or upload consent. */
export const STUDIO_IMPORT_TRANSFER_LIMITS = Object.freeze({argumentBytes: 256 * 1024, totalBytes: STUDIO_ASSET_TRANSFER_LIMITS.rawBytes, packets: 8192});
export interface StudioImportTransferPacket {
  readonly ordinal: number;
  readonly kind: 'begin' | 'texture' | 'object' | 'chunk' | 'seal';
  /** Exact serialized UTF-8 arguments. Do not reserialize caller-owned objects. */
  readonly json: string;
  readonly byteLength: number;
  readonly sha256: string;
}
export interface StudioImportTransfer {
  readonly formatVersion: 1;
  readonly engineVerification: 'pending';
  readonly preparedDigest: string;
  readonly payloadDigest: string;
  readonly digest: string;
  readonly packets: readonly StudioImportTransferPacket[];
  readonly byteLength: number;
}
export class StudioImportTransferError extends Error {
  constructor(public readonly code: 'IDENTITY' | 'CHECKSUM' | 'BUDGET', message: string) {super(message); this.name = 'StudioImportTransferError';}
}
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function fail(code: StudioImportTransferError['code'], message: string): never {throw new StudioImportTransferError(code, message);}

/** Packages immutable decoded chunks, not mutable convenience buffer copies.
 * Same-actor/job/target checks still belong to the AssetService and executor.
 * No dispatch callback exists here; these packets authorize no side effects. */
export function createStudioImportTransfer(prepared: PreparedStudioImport, payload: StudioImportPayload): StudioImportTransfer {
  assertDecodedStudioImportPayload(payload);
  const plan = parseNativeStudioImportResponse({prepared}, payload.revisionId).prepared;
  const manifest = plan.manifest;
  if (payload.preparedDigest !== plan.digest || payload.manifestDigest !== manifest.digest ||
      payload.projectId !== manifest.projectId || payload.assetId !== manifest.assetId || payload.revisionId !== manifest.revisionId) {
    fail('IDENTITY', 'Payload and preparation belong to different revisions.');
  }
  const packets: StudioImportTransferPacket[] = [];
  let byteLength = 0;
  const packet = (kind: StudioImportTransferPacket['kind'], body: Record<string, unknown>) => {
    const ordinal = packets.length;
    const json = JSON.stringify({formatVersion: 1, payloadDigest: payload.digest, manifestDigest: manifest.digest, ordinal, kind, ...body});
    const bytes = Buffer.byteLength(json);
    if (bytes > STUDIO_IMPORT_TRANSFER_LIMITS.argumentBytes || ordinal >= STUDIO_IMPORT_TRANSFER_LIMITS.packets ||
        byteLength + bytes > STUDIO_IMPORT_TRANSFER_LIMITS.totalBytes) fail('BUDGET', 'Actual serialized transfer exceeds bridge limits.');
    packets.push(Object.freeze({ordinal, kind, json, byteLength: bytes, sha256: sha(json)}));
    byteLength += bytes;
  };
  const describe = (stream: StudioImportPayloadBuffer, sourceObjectId: string, primitiveIndex: number) => {
    const streamId = sha([sourceObjectId, String(primitiveIndex), stream.semantic].join('\0'));
    let offset = 0; const digest = createHash('sha256');
    for (const chunk of stream.chunks) {
      const bytes = Buffer.from(chunk.data, 'base64');
      if (chunk.sourceObjectId !== sourceObjectId || chunk.primitiveIndex !== primitiveIndex || chunk.semantic !== stream.semantic ||
          chunk.manifestDigest !== manifest.digest || chunk.bufferSha256 !== stream.sha256 || chunk.offset !== offset ||
          chunk.byteLength !== bytes.length || sha(bytes) !== chunk.sha256 || bytes.toString('base64') !== chunk.data)
        fail('CHECKSUM', 'Decoded stream chunks are incomplete or changed.');
      digest.update(bytes); offset += bytes.length;
    }
    if (offset !== stream.byteLength || digest.digest('hex') !== stream.sha256) fail('CHECKSUM', 'Decoded stream digest differs from its immutable chunks.');
    return {streamId, semantic: stream.semantic, componentType: stream.componentType, type: stream.type, count: stream.count,
      normalized: stream.normalized, byteLength: stream.byteLength, sha256: stream.sha256,
      chunks: stream.chunks.map(c => ({offset: c.offset, byteLength: c.byteLength, sha256: c.sha256}))};
  };
  const sendChunks = (stream: StudioImportPayloadBuffer, sourceObjectId: string, primitiveIndex: number, streamId: string) => {
    for (const chunk of stream.chunks) packet('chunk', {sourceObjectId, primitiveIndex, streamId, semantic: stream.semantic,
      bufferSha256: stream.sha256, offset: chunk.offset, byteLength: chunk.byteLength, sha256: chunk.sha256, encoding: 'base64', data: chunk.data});
  };
  packet('begin', {projectId: manifest.projectId, assetId: manifest.assetId, revisionId: manifest.revisionId,
    preparedDigest: plan.digest, target: manifest.target, conversion: manifest.conversion, placement: manifest.placement,
    bounds: manifest.bounds, anchors: manifest.anchors, objectCount: payload.objects.length,
    preservation: plan.delta.preservation, previousDigest: plan.delta.previousDigest,
    ...(payload.textures?.length ? {textureCount: payload.textures.length} : {})});
  for (const texture of payload.textures ?? []) {
    const {bytes: _bytes, chunks: _chunks, source: _source, ...metadata} = texture;
    const sourceObjectId = 'texture-' + texture.imageId, descriptor = describe(texture, sourceObjectId, -1);
    packet('texture', {texture: {...metadata, stream: descriptor}});
    sendChunks(texture, sourceObjectId, -1, descriptor.streamId);
  }
  for (const entry of payload.objects) {
    const streams: {streamId: string; primitiveIndex: number; stream: StudioImportPayloadBuffer}[] = [];
    const primitives = entry.primitives.map((primitive, primitiveIndex) => {
      const describePrimitive = (stream: StudioImportPayloadBuffer) => {
        const descriptor = describe(stream, entry.object.sourceObjectId, primitiveIndex);
        streams.push({streamId: descriptor.streamId, primitiveIndex, stream}); return descriptor;
      };
      return {mode: primitive.mode, vertexCount: primitive.vertexCount, triangleCount: primitive.triangleCount,
        attributes: Object.fromEntries(Object.entries(primitive.attributes).map(([name, stream]) => [name, describePrimitive(stream!)])),
        indices: describePrimitive(primitive.indices)};
    });
    packet('object', {object: entry.object, material: entry.material, primitives, ...(entry.textureBindings ? {textureBindings: entry.textureBindings} : {})});
    for (const {streamId, primitiveIndex, stream} of streams) sendChunks(stream, entry.object.sourceObjectId, primitiveIndex, streamId);
  }
  const contentDigest = sha(packets.map(p => [p.ordinal, p.kind, p.byteLength, p.sha256].join(':')).join('\n'));
  packet('seal', {precedingPacketCount: packets.length, precedingByteLength: byteLength, contentDigest});
  const digest = sha(packets.map(p => p.sha256).join('\n'));
  return Object.freeze({formatVersion: 1, engineVerification: 'pending', preparedDigest: plan.digest,
    payloadDigest: payload.digest, digest, packets: Object.freeze(packets), byteLength});
}
