import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

/** Bounds for an Edit-mode viewport image handed to a model. Input bounds cover
 * a native full-window capture; output bounds keep one image small in tokens. */
export const VIEWPORT_LIMITS = Object.freeze({
  inputBytes: 12 * 1024 * 1024, inputDimension: 8192, inputPixels: 16 * 1024 * 1024,
  wireBytes: 18 * 1024 * 1024,
  minDimension: 256, defaultDimension: 768, maxDimension: 1024, outputBytes: 600 * 1024,
  coordinate: 100_000, minCameraDistance: 0.5, maxCameraDistance: 5_000,
});

export interface ViewportImage {
  png: Buffer; width: number; height: number; originalWidth: number; originalHeight: number;
  downscaled: boolean; bytes: number; sha256: string;
}

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  return table;
})();
function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const bad = (): never => { throw new Error('Unsupported or invalid viewport PNG.'); };

/** Decode a bounded, CRC-checked, noninterlaced 8-bit RGB/RGBA PNG into RGB pixels. */
export function decodeViewportPng(bytes: Buffer): { width: number; height: number; rgb: Buffer } {
  if (bytes.length > VIEWPORT_LIMITS.inputBytes || bytes.length < 8 || !bytes.subarray(0, 8).equals(SIGNATURE)) bad();
  let at = 8, width = 0, height = 0, channels = 0, ended = false, afterData = false, idatBytes = 0;
  const parts: Buffer[] = [];
  for (let count = 0; at < bytes.length && count < 8192; count++) {
    if (at + 12 > bytes.length) bad();
    const length = bytes.readUInt32BE(at), kind = bytes.toString('latin1', at + 4, at + 8), end = at + length + 12;
    if (end > bytes.length || !/^[A-Za-z]{4}$/.test(kind) || crc32(bytes.subarray(at + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) bad();
    const data = bytes.subarray(at + 8, end - 4);
    if (!width && kind !== 'IHDR') bad();
    if (kind === 'IHDR') {
      if (width || length !== 13) bad();
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      if (!width || !height || width > VIEWPORT_LIMITS.inputDimension || height > VIEWPORT_LIMITS.inputDimension ||
          width * height > VIEWPORT_LIMITS.inputPixels || data[8] !== 8 || ![2, 6].includes(data[9]!) || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) bad();
      channels = data[9] === 6 ? 4 : 3;
    } else if (kind === 'IDAT') { if (afterData || !length) bad(); parts.push(data); idatBytes += length; }
    else if (kind === 'IEND') { if (length || !parts.length || end !== bytes.length) bad(); ended = true; at = end; break; }
    else { if (parts.length) afterData = true; if (/^[A-Z]/.test(kind) || ['acTL', 'fcTL', 'fdAT'].includes(kind)) bad(); }
    at = end;
  }
  if (!ended || at !== bytes.length || idatBytes > VIEWPORT_LIMITS.inputBytes) bad();
  const stride = width * channels, size = (stride + 1) * height;
  let raw: Buffer;
  try { raw = inflateSync(Buffer.concat(parts), { maxOutputLength: size }); } catch { return bad(); }
  if (raw.length !== size) bad();
  const current = Buffer.alloc(stride), previous = Buffer.alloc(stride), rgb = Buffer.alloc(width * height * 3);
  for (let row = 0; row < height; row++) {
    const base = row * (stride + 1), filter = raw[base]!;
    if (filter > 4) bad();
    for (let i = 0; i < stride; i++) {
      const x = raw[base + 1 + i]!, a = i >= channels ? current[i - channels]! : 0, b = previous[i]!, c = i >= channels ? previous[i - channels]! : 0;
      let value: number;
      if (filter === 0) value = x;
      else if (filter === 1) value = x + a;
      else if (filter === 2) value = x + b;
      else if (filter === 3) value = x + ((a + b) >> 1);
      else { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); value = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      current[i] = value & 0xff;
    }
    for (let x = 0, out = row * width * 3; x < width; x++, out += 3) {
      const source = x * channels;
      rgb[out] = current[source]!; rgb[out + 1] = current[source + 1]!; rgb[out + 2] = current[source + 2]!;
    }
    current.copy(previous);
  }
  return { width, height, rgb };
}

/** Area-average downscale of packed RGB pixels. */
export function downscaleRgb(rgb: Buffer, width: number, height: number, targetWidth: number, targetHeight: number): Buffer {
  if (targetWidth === width && targetHeight === height) return rgb;
  const out = Buffer.alloc(targetWidth * targetHeight * 3);
  for (let ty = 0; ty < targetHeight; ty++) {
    const y0 = Math.floor(ty * height / targetHeight), y1 = Math.max(y0 + 1, Math.floor((ty + 1) * height / targetHeight));
    for (let tx = 0; tx < targetWidth; tx++) {
      const x0 = Math.floor(tx * width / targetWidth), x1 = Math.max(x0 + 1, Math.floor((tx + 1) * width / targetWidth));
      let r = 0, g = 0, b = 0;
      for (let y = y0; y < y1; y++) for (let x = x0, i = (y * width + x0) * 3; x < x1; x++, i += 3) { r += rgb[i]!; g += rgb[i + 1]!; b += rgb[i + 2]!; }
      const n = (y1 - y0) * (x1 - x0), o = (ty * targetWidth + tx) * 3;
      out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n); out[o + 2] = Math.round(b / n);
    }
  }
  return out;
}

function chunk(kind: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(kind, 4, 'latin1');
  const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}

/** Encode packed RGB as a minimal PNG (IHDR, one IDAT, IEND) with adaptive row filters. */
export function encodeRgbPng(rgb: Buffer, width: number, height: number): Buffer {
  const stride = width * 3, raw = Buffer.alloc((stride + 1) * height), candidate = Buffer.alloc(stride);
  for (let row = 0; row < height; row++) {
    const line = rgb.subarray(row * stride, (row + 1) * stride), prior = row ? rgb.subarray((row - 1) * stride, row * stride) : null;
    let bestFilter = 0, bestScore = Infinity;
    for (let filter = 0; filter <= 4; filter++) {
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const x = line[i]!, a = i >= 3 ? line[i - 3]! : 0, b = prior ? prior[i]! : 0, c = prior && i >= 3 ? prior[i - 3]! : 0;
        let predicted = 0;
        if (filter === 1) predicted = a; else if (filter === 2) predicted = b; else if (filter === 3) predicted = (a + b) >> 1;
        else if (filter === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
        const value = (x - predicted) & 0xff; score += value < 128 ? value : 256 - value;
      }
      if (score < bestScore) { bestScore = score; bestFilter = filter; }
    }
    const base = row * (stride + 1); raw[base] = bestFilter;
    for (let i = 0; i < stride; i++) {
      const x = line[i]!, a = i >= 3 ? line[i - 3]! : 0, b = prior ? prior[i]! : 0, c = prior && i >= 3 ? prior[i - 3]! : 0;
      let predicted = 0;
      if (bestFilter === 1) predicted = a; else if (bestFilter === 2) predicted = b; else if (bestFilter === 3) predicted = (a + b) >> 1;
      else if (bestFilter === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      candidate[i] = (x - predicted) & 0xff;
    }
    candidate.copy(raw, base + 1);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** Re-encode a native capture as a normalized RGB PNG whose longest side is at
 * most maxDimension and whose size is at most outputBytes, shrinking further if
 * needed. Ancillary chunks and alpha never reach the model. */
export function boundViewportPng(bytes: Buffer, maxDimension: number = VIEWPORT_LIMITS.defaultDimension, outputBytes: number = VIEWPORT_LIMITS.outputBytes): ViewportImage {
  if (!Number.isInteger(maxDimension) || maxDimension < VIEWPORT_LIMITS.minDimension || maxDimension > VIEWPORT_LIMITS.maxDimension ||
      !Number.isInteger(outputBytes) || outputBytes < 16 * 1024 || outputBytes > VIEWPORT_LIMITS.outputBytes) throw new Error('Invalid viewport bounds.');
  const { width, height, rgb } = decodeViewportPng(bytes);
  let limit = maxDimension;
  for (let attempt = 0; attempt < 8; attempt++) {
    const scale = Math.min(1, limit / Math.max(width, height));
    const targetWidth = Math.max(1, Math.round(width * scale)), targetHeight = Math.max(1, Math.round(height * scale));
    const png = encodeRgbPng(downscaleRgb(rgb, width, height, targetWidth, targetHeight), targetWidth, targetHeight);
    if (png.length <= outputBytes) return Object.freeze({ png, width: targetWidth, height: targetHeight, originalWidth: width, originalHeight: height,
      downscaled: targetWidth !== width || targetHeight !== height, bytes: png.length, sha256: createHash('sha256').update(png).digest('hex') });
    limit = Math.max(64, Math.floor(Math.min(limit, Math.max(width, height)) * 0.75));
  }
  throw new Error('Viewport image exceeds its byte bound.');
}
