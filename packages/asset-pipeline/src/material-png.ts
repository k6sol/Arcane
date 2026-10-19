import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { inflateSync } from 'node:zlib';

/** Host-side pixel decoding only; no files, uploads or engine authority. These
 * bounds match static import preparation. Native image limits remain separate. */
export const MATERIAL_PNG_LIMITS = Object.freeze({ bytes: 20_000_000, dimension: 4096, pixels: 16_777_216, chunks: 4096 });
export class MaterialPngError extends Error {
  constructor(public readonly code: 'PNG' | 'LIMIT' | 'HANDLE') {
    super(code === 'LIMIT' ? 'Material PNG exceeds pixel or byte limits.' : code === 'HANDLE' ? 'Expected a locally decoded material image.' : 'Unsupported or invalid material PNG.');
    this.name = 'MaterialPngError';
  }
}
export interface DecodedMaterialPng {
  readonly width: number; readonly height: number;
  readonly sourceSha256: string; readonly rgbaSha256: string;
}
const decoded = new WeakMap<DecodedMaterialPng, Buffer>();
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0;
});
const invalid = (): never => { throw new MaterialPngError('PNG'); };
function crc(bytes: Buffer): number {
  let c = 0xffffffff; for (const byte of bytes) c = crcTable[(c ^ byte) & 255]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0;
}
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c, da = Math.abs(p - a), db = Math.abs(p - b), dc = Math.abs(p - c);
  return da <= db && da <= dc ? a : db <= dc ? b : c;
}
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** CRC-checked, non-interlaced 8-bit grey/grey-alpha/RGB/RGBA PNG. Preserve
 * encoded sample values and straight alpha; map-specific colour space belongs
 * to the material consumer. Palette and 16-bit images require explicit baking.
 * Pixel storage is private; channel reads return independent caller copies. */
export function decodeMaterialPng(input: Uint8Array): DecodedMaterialPng {
  if (!types.isUint8Array(input)) invalid();
  if (input.byteLength > MATERIAL_PNG_LIMITS.bytes) throw new MaterialPngError('LIMIT');
  const bytes = Buffer.from(input);
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(signature)) invalid();
  let at = 8, width = 0, height = 0, channels = 0, colour = -1, ended = false, afterData = false, palette = false;
  let transparent: number[] | null = null;
  const parts: Buffer[] = [];
  for (let count = 0; at < bytes.length && count < MATERIAL_PNG_LIMITS.chunks; count++) {
    if (at + 12 > bytes.length) invalid();
    const length = bytes.readUInt32BE(at), kind = bytes.toString('latin1', at + 4, at + 8), end = at + length + 12;
    if (end > bytes.length || !/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(kind) || crc(bytes.subarray(at + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) invalid();
    const data = bytes.subarray(at + 8, end - 4);
    if (!width && kind !== 'IHDR') invalid();
    if (kind === 'IHDR') {
      if (width || length !== 13) invalid();
      width = data.readUInt32BE(0); height = data.readUInt32BE(4); colour = data[9]!;
      if (!width || !height || data[8] !== 8 || ![0, 2, 4, 6].includes(colour) || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) invalid();
      if (width > MATERIAL_PNG_LIMITS.dimension || height > MATERIAL_PNG_LIMITS.dimension || width * height > MATERIAL_PNG_LIMITS.pixels) throw new MaterialPngError('LIMIT');
      channels = colour === 0 ? 1 : colour === 2 ? 3 : colour === 4 ? 2 : 4;
    } else if (kind === 'IDAT') {
      if (afterData || !length) invalid(); parts.push(data);
    } else if (kind === 'IEND') {
      if (length || !parts.length || end !== bytes.length) invalid(); ended = true; at = end; break;
    } else {
      if (parts.length) afterData = true;
      if (kind === 'tRNS') {
        if (transparent || parts.length || ![0, 2].includes(colour) || length !== (colour === 0 ? 2 : 6)) invalid();
        transparent = Array.from({ length: length / 2 }, (_, i) => data.readUInt16BE(i * 2));
        if (transparent.some(value => value > 255)) invalid();
      } else if (kind === 'PLTE') {
        if (palette || parts.length || [0, 4].includes(colour) || !length || length > 768 || length % 3) invalid(); palette = true;
      } else if (/^[A-Z]/.test(kind) || ['acTL', 'fcTL', 'fdAT'].includes(kind)) invalid();
    }
    at = end;
  }
  if (!ended || at !== bytes.length) invalid();
  const stride = width * channels, expected = (stride + 1) * height, packed = Buffer.concat(parts);
  let raw: Buffer;
  try {
    // Node's info result exposes compressed bytes consumed; reject hidden trailing streams/data.
    const value = inflateSync(packed, { maxOutputLength: expected, info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    if (!Buffer.isBuffer(value.buffer) || value.buffer.length !== expected || value.engine.bytesWritten !== packed.length) invalid();
    raw = value.buffer;
  } catch { return invalid(); }
  const rgba = Buffer.alloc(width * height * 4), previous = Buffer.alloc(stride), current = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const base = y * (stride + 1), filter = raw[base]!; if (filter > 4) invalid();
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? current[x - channels]! : 0, up = previous[x]!, corner = x >= channels ? previous[x - channels]! : 0;
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : paeth(left, up, corner);
      current[x] = (raw[base + x + 1]! + predictor) & 255;
    }
    for (let x = 0; x < width; x++) {
      const from = x * channels, to = (y * width + x) * 4;
      const r = current[from]!, g = colour === 0 || colour === 4 ? r : current[from + 1]!, b = colour === 0 || colour === 4 ? r : current[from + 2]!;
      rgba[to] = r; rgba[to + 1] = g; rgba[to + 2] = b;
      rgba[to + 3] = colour === 4 ? current[from + 1]! : colour === 6 ? current[from + 3]! : transparent && r === transparent[0] && (colour === 0 || g === transparent[1] && b === transparent[2]) ? 0 : 255;
    }
    current.copy(previous);
  }
  const image = Object.freeze({ width, height, sourceSha256: hash(bytes), rgbaSha256: hash(rgba) });
  decoded.set(image, rgba); return image;
}

/** RGBA stays exact; RGB makes alpha opaque. A scalar channel is replicated
 * into RGB with opaque alpha, matching red-channel engine PBR map sampling. */
export function materialPngPixels(image: DecodedMaterialPng, channel: 'rgba' | 'rgb' | 'r' | 'g' | 'b' | 'a' = 'rgba'): Buffer {
  const source = decoded.get(image); if (!source || !['rgba', 'rgb', 'r', 'g', 'b', 'a'].includes(channel)) throw new MaterialPngError('HANDLE');
  const result = Buffer.from(source); if (channel === 'rgba') return result;
  const index = channel === 'r' ? 0 : channel === 'g' ? 1 : channel === 'b' ? 2 : 3;
  for (let i = 0; i < result.length; i += 4) {
    if (channel !== 'rgb') result.fill(source[i + index]!, i, i + 3);
    result[i + 3] = 255;
  }
  return result;
}
