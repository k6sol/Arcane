import { createHash } from 'node:crypto';
import { decodeMaterialPng, materialPngPixels, MaterialPngError, type DecodedMaterialPng } from './material-png.js';
import type { StudioImportManifest } from './studio-import-manifest.js';

/** Local pixel conversion, never an uploader, image URL loader or permission grant. */
export const STUDIO_TEXTURE_LIMITS = Object.freeze({ dimension: 1024, maps: 256, rgbaBytes: 32 * 1024 * 1024 });
export type StudioTextureSlot = 'ColorMap' | 'NormalMap' | 'RoughnessMap' | 'MetalnessMap';
export interface StudioTexturePixels {
  readonly imageId: string; readonly materialSha256: string; readonly semantic: StudioTextureSlot;
  readonly sourceSha256: string; readonly sourceRgbaSha256: string; readonly channel: 'rgba' | 'rgb' | 'g' | 'b';
  readonly factors: readonly number[]; readonly width: number; readonly height: number;
  readonly colorSpace: 'srgb' | 'linear'; readonly orientation: 'top-left'; readonly normalConvention: 'OpenGL' | null;
  readonly sha256: string; readonly bytes: Uint8Array;
}
type Json = Record<string, any>;
export class StudioTextureError extends Error {
  constructor(public readonly code: 'UNSUPPORTED_TEXTURE' | 'BUDGET' | 'CHECKSUM', message: string) { super(message); this.name = 'StudioTextureError'; }
}
function fail(code: StudioTextureError['code'], message: string): never { throw new StudioTextureError(code, message); }
const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical((value as Json)[k])).join(',') + '}';
  return JSON.stringify(value);
}
export interface StudioEmbeddedImages { readonly hashes: readonly string[]; readonly images: ReadonlyMap<string, DecodedMaterialPng> }
export function decodeEmbeddedStudioImages(doc: Json, bin: Buffer, manifest: StudioImportManifest, fileId: string, maximumRgbaBytes = STUDIO_TEXTURE_LIMITS.rgbaBytes): StudioEmbeddedImages {
  const images = new Map<string, DecodedMaterialPng>();
  const uniqueSources = new Set<string>();
  let rgbaBytes = 0;
  // Bound every unique source before the first PNG inflate/allocation. A small
  // compressed file must not amplify into many unbounded decoded source images.
  const sources = (doc.images ?? []).map((image: Json, imageIndex: number) => {
    if (image.uri !== undefined || image.mimeType !== 'image/png' || !Number.isSafeInteger(image.bufferView))
      fail('UNSUPPORTED_TEXTURE', 'Texture delivery requires bufferView-backed embedded PNG; JPEG and image URIs remain unsupported.');
    const view = doc.bufferViews[image.bufferView];
    const source = bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    if (source.length < 24 || source.readUInt32BE(16) > STUDIO_TEXTURE_LIMITS.dimension || source.readUInt32BE(20) > STUDIO_TEXTURE_LIMITS.dimension)
      fail('BUDGET', 'Editable-image texture delivery is limited to 1024 pixels per axis; bake a smaller PNG.');
    const sourceSha256 = sha(source), width = source.readUInt32BE(16), height = source.readUInt32BE(20);
    if (!uniqueSources.has(sourceSha256)) {
      rgbaBytes += width * height * 4;
      if (rgbaBytes > maximumRgbaBytes) fail('BUDGET', 'Decoded source PNG pixels exceed the aggregate RGBA8 budget.');
      uniqueSources.add(sourceSha256);
    }
    const prepared = manifest.textures.find(t => t.sha256 === sourceSha256);
    if (!prepared || prepared.contentType !== 'image/png' || prepared.byteLength !== source.length || prepared.width !== width || prepared.height !== height ||
        !prepared.locations.some(l => l.fileId === fileId && l.imageIndex === imageIndex)) fail('CHECKSUM', 'Decoded image differs from prepared image identity or dimensions.');
    return {source, sourceSha256};
  });
  const hashes = sources.map(({source, sourceSha256}: {source: Buffer; sourceSha256: string}) => {
    const existing = images.get(sourceSha256);
    if (existing) return existing.sourceSha256;
    let decoded: DecodedMaterialPng;
    try { decoded = decodeMaterialPng(source); }
    catch (error) { if (error instanceof MaterialPngError) fail(error.code === 'LIMIT' ? 'BUDGET' : 'UNSUPPORTED_TEXTURE', 'Embedded PNG pixel decoding failed.'); throw error; }
    images.set(decoded.sourceSha256, decoded); return decoded.sourceSha256;
  });
  return { hashes, images };
}

/** Reconstruct exact prepared material references; sampler policy is explicit.
 * Engine-selected filtering and mip generation remain pending native verification. */
export function studioTextureUse(info: Json | undefined, channel: 'rgba' | 'rgb' | 'g' | 'b', doc: Json, images: StudioEmbeddedImages): Json | null {
  if (!info) return null;
  if ((info.texCoord ?? 0) !== 0 || info.extensions !== undefined) fail('UNSUPPORTED_TEXTURE', 'Only untransformed UV0 texture references are supported.');
  const texture = doc.textures?.[info.index];
  if (!texture || texture.extensions !== undefined || !Number.isSafeInteger(texture.source) || !images.hashes[texture.source]) fail('UNSUPPORTED_TEXTURE', 'Expected an embedded PNG texture source.');
  if (texture.sampler !== undefined) {
    const sampler = doc.samplers?.[texture.sampler];
    if (!sampler || (sampler.wrapS ?? 10497) !== 10497 || (sampler.wrapT ?? 10497) !== 10497 ||
        (sampler.magFilter !== undefined && sampler.magFilter !== 9729) || (sampler.minFilter !== undefined && ![9729, 9987].includes(sampler.minFilter)))
      fail('UNSUPPORTED_TEXTURE', 'Texture delivery supports repeat wrapping and linear filtering only; bake unsupported sampler behavior.');
  }
  return { sha256: images.hashes[texture.source], channel, texCoord: 0 };
}
const linear = (byte: number) => { const v = byte / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const srgbByte = (v: number) => Math.floor((v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055) * 255 + 0.5);

/** Bake supported glTF factors into RGBA8 maps. Source bytes and channel identity
 * remain recorded separately; normals never receive an sRGB transfer or green flip. */
export function materialStudioTexturePixels(material: StudioImportManifest['materials'][number], images: StudioEmbeddedImages, maximumRgbaBytes = STUDIO_TEXTURE_LIMITS.rgbaBytes): StudioTexturePixels[] {
  const slots = [['ColorMap', material.colorMap], ['NormalMap', material.normalMap], ['RoughnessMap', material.roughnessMap], ['MetalnessMap', material.metalnessMap]] as const;
  let projectedBytes = 0;
  for (const [, use] of slots) if (use) {
    const image = images.images.get(use.sha256);
    if (!image) fail('CHECKSUM', 'Prepared material image was not decoded from its owned export.');
    projectedBytes += image.width * image.height * 4;
    if (projectedBytes > maximumRgbaBytes) fail('BUDGET', 'Converted material maps exceed the remaining aggregate RGBA8 budget.');
  }
  if (material.alphaMode !== 'OPAQUE' && material.alphaMode !== 'MASK') fail('UNSUPPORTED_TEXTURE', 'Only OPAQUE and MASK alpha are delivered; BLEND is not approximated.');
  if (!Number.isFinite(material.alphaCutoff) || material.alphaCutoff < 0 || material.alphaCutoff > 1) fail('UNSUPPORTED_TEXTURE', 'alphaCutoff must be finite within [0,1].');
  const mask = material.alphaMode === 'MASK', cutoff = material.alphaCutoff;
  const output: StudioTexturePixels[] = [];
  for (const [semantic, use] of slots) {
    if (!use) continue;
    const image = images.images.get(use.sha256);
    if (!image || use.texCoord !== 0) fail('CHECKSUM', 'Prepared material image was not decoded from its owned export.');
    if (semantic === 'NormalMap' && material.normalScale !== 1) fail('UNSUPPORTED_TEXTURE', 'Normal texture scale must be baked to 1 before delivery.');
    const pixels = materialPngPixels(image, semantic === 'ColorMap' ? 'rgba' : semantic === 'NormalMap' ? 'rgb' : use.channel);
    const factors = semantic === 'ColorMap' ? material.baseColor.slice(0, 3) : semantic === 'NormalMap' ? [material.normalScale] : [semantic === 'RoughnessMap' ? material.roughness : material.metallic];
    for (let i = 0; i < pixels.length; i += 4) {
      if (semantic === 'ColorMap') for (let c = 0; c < 3; c++) pixels[i + c] = factors[c] === 1 ? pixels[i + c]! : srgbByte(linear(pixels[i + c]!) * factors[c]!);
      else if (semantic !== 'NormalMap') { const value = Math.floor(pixels[i]! * factors[0]! + 0.5); pixels.fill(value, i, i + 3); }
      // glTF OPAQUE ignores source alpha; MASK is an exact binary cutout of
      // ColorMap coverage (alpha/255 >= alphaCutoff). Data maps stay opaque.
      pixels[i + 3] = mask && semantic === 'ColorMap' ? (pixels[i + 3]! / 255 >= cutoff ? 255 : 0) : 255;
    }
    const metadata = { materialSha256: material.sha256, semantic, sourceSha256: image.sourceSha256, sourceRgbaSha256: image.rgbaSha256,
      channel: use.channel, factors, width: image.width, height: image.height, colorSpace: semantic === 'ColorMap' ? 'srgb' as const : 'linear' as const,
      orientation: 'top-left' as const, normalConvention: semantic === 'NormalMap' ? 'OpenGL' as const : null, sha256: sha(pixels) };
    output.push({ ...metadata, imageId: sha(canonical(metadata)), bytes: pixels });
  }
  return output;
}
