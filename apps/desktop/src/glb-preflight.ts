/// <reference lib="dom" />
/**
 * Data-only admission gate for the offline GLTFLoader preview, not a glTF
 * conformance validator or image decoder. No fetch, DOM, GPU, eval or imports.
 * Rules checked against https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html
 * (GLB, accessors/alignment/sparse, mesh, skin, node and animation sections) and
 * https://github.com/KhronosGroup/glTF/tree/main/extensions/2.0/Khronos.
 * Accepts embedded uncompressed core geometry, PBR, skins, morphs and animation.
 * Unknown extensions are refused, even optional ones; explicitly typed material
 * extensions below are admitted. PNG/JPEG headers/chunks are checked without
 * decompressing pixels. Browser decoding and loader errors still need handling.
 */
export const GLB_PREFLIGHT_LIMITS = Object.freeze({
  bytes: 64 * 1024 * 1024, jsonBytes: 4 * 1024 * 1024,
  treeValues: 250_000, jsonDepth: 64, arrayLength: 16_384, stringLength: 16_384,
  nodes: 4096, nodeDepth: 128, meshes: 2048, primitives: 4096, drawCalls: 4096,
  accessors: 8192, bufferViews: 8192, accessorElements: 1_000_000,
  accessorComponents: 16_000_000, accessorAllocationBytes: 128 * 1024 * 1024,
  triangles: 2_000_000, submittedVertices: 8_000_000,
  materials: 1024, images: 256, textures: 256, imageDimension: 8192,
  imagePixels: 32_000_000, imageChunks: 16_384, imageEncodedBytes: 64 * 1024 * 1024,
  skins: 256, joints: 256, morphTargets: 32, attributes: 32,
  animations: 128, animationChannels: 4096, magnitude: 1_000_000,
});

export interface GlbMetadata {
  nodeCount: number;
  meshCount: number;
  /** Max of all mesh definitions and their instances across all nodes/scenes. */
  triangleEstimate: number;
  /** Counts each image, and extra texture entries reusing it, conservatively. */
  imagePixels: number;
  /** Number of clips; no animation is evaluated or played by this function. */
  animations: number;
}

type Obj = Record<string, unknown>;
const L = GLB_PREFLIGHT_LIMITS;
function fail(path: string, reason: string): never { throw new Error(`GLB preflight: ${path}: ${reason}`); }
function obj(v: unknown, p: string): Obj {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail(p, 'expected a data object');
  return v as Obj;
}
function arr(v: unknown, p: string, max: number, min = 0): unknown[] {
  if (!Array.isArray(v) || v.length < min || v.length > max) fail(p, `array budget/length must be ${min}..${max}`);
  return v;
}
function int(v: unknown, p: string, max: number, min = 0): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) fail(p, `integer bound must be ${min}..${max}`);
  return v;
}
function num(v: unknown, p: string, min: number = -L.magnitude, max: number = L.magnitude): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) fail(p, `finite number bound must be ${min}..${max}`);
  return v;
}
function vector(v: unknown, p: string, size: number, min: number = -L.magnitude, max: number = L.magnitude): number[] {
  return arr(v, p, size, size).map((n, i) => num(n, `${p}[${i}]`, min, max));
}
function choice(v: unknown, p: string, allowed: readonly unknown[]): void {
  if (!allowed.includes(v)) fail(p, 'unsupported value');
}
function optionalNumber(o: Obj, k: string, p: string, min: number, max: number): void {
  if (o[k] !== undefined) num(o[k], `${p}.${k}`, min, max);
}
function optionalBoolean(o: Obj, k: string, p: string): void {
  if (o[k] !== undefined && typeof o[k] !== 'boolean') fail(`${p}.${k}`, 'expected boolean');
}
const ref = (v: unknown, rows: readonly unknown[], p: string): number => int(v, p, rows.length - 1);
function budget(n: number, max: number, p: string): number {
  if (!Number.isSafeInteger(n) || n > max) fail(p, `resource budget exceeded (${max})`);
  return n;
}

// Bound nesting and token work BEFORE JSON.parse, which only creates data
// properties and never calls asset-provided getters/toJSON. Walk every value,
// including extras and unused resources, then remove object prototypes.
function parseData(bytes: Uint8Array): Obj {
  if (bytes.length > L.jsonBytes) fail('JSON', 'JSON byte budget exceeded');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return fail('JSON', 'invalid UTF-8'); }
  let depth = 0, tokens = 0, quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue; }
    if (c === '"') quoted = true;
    else if (c === '{' || c === '[') { if (++depth > L.jsonDepth) fail('JSON', 'tree depth budget exceeded'); tokens++; }
    else if (c === '}' || c === ']') depth--;
    else if (c === ',' || c === ':') tokens++;
    if (tokens > L.treeValues * 2) fail('JSON', 'tree token budget exceeded');
  }
  // GLB alignment padding is spaces, not NULs, tabs, newlines or a BOM.
  for (let i = text.length - 1; i >= 0; i--) {
    const c = text.charCodeAt(i);
    if (c === 32) continue;
    if (c === 9 || c === 10 || c === 13) fail('JSON', 'alignment padding must use spaces');
    break;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return fail('JSON', 'invalid JSON text or padding'); }
  let values = 0;
  function visit(v: unknown, p: string, d: number): void {
    budget(++values, L.treeValues, 'JSON tree');
    if (d > L.jsonDepth) fail(p, 'tree depth budget exceeded');
    if (typeof v === 'number' && !Number.isFinite(v)) fail(p, 'non-finite JSON number');
    if (typeof v === 'string') {
      if (v.length > L.stringLength) fail(p, 'string budget exceeded');
      if (/^\s*(?:[a-z][a-z0-9+.-]*:|[\\/]{2})/i.test(v)) fail(p, 'external URLs and data URIs are forbidden');
    } else if (Array.isArray(v)) {
      arr(v, p, L.arrayLength);
      v.forEach((x, i) => visit(x, `${p}[${i}]`, d + 1));
    } else if (v && typeof v === 'object') {
      const o = v as Obj;
      Object.setPrototypeOf(o, null);
      for (const [k, x] of Object.entries(o)) {
        if (['__proto__', 'prototype', 'constructor'].includes(k)) fail(p, 'prototype keys are forbidden');
        if (k.length > L.stringLength) fail(p, 'key budget exceeded');
        if (/(?:uri|url|uris|urls)$/i.test(k)) fail(`${p}.${k}`, 'URI/URL fields are forbidden; embed resources in BIN');
        visit(x, `${p}.${k}`, d + 1);
      }
    }
  }
  visit(parsed, '$', 0);
  return obj(parsed, '$');
}

interface View { offset: number; length: number; stride: number | undefined; target: unknown }
interface Sparse { count: number; indices: number; indexType: number; indexWidth: number; values: number }
interface Accessor {
  type: string; componentType: number; width: number; count: number; normalized: boolean;
  offsets: number[]; size: number; span: number; stride: number; start: number | undefined;
  view: View | undefined; sparse: Sparse | undefined; min: number[]; max: number[];
  declared: Obj;
}
const WIDTHS = new Map([[5120, 1], [5121, 1], [5122, 2], [5123, 2], [5125, 4], [5126, 4]]);
const SHAPES = new Map([['SCALAR', [1, 1]], ['VEC2', [2, 1]], ['VEC3', [3, 1]], ['VEC4', [4, 1]], ['MAT2', [2, 2]], ['MAT3', [3, 3]], ['MAT4', [4, 4]]]);
function read(bin: DataView, type: number, at: number): number {
  switch (type) {
    case 5120: return bin.getInt8(at);
    case 5121: return bin.getUint8(at);
    case 5122: return bin.getInt16(at, true);
    case 5123: return bin.getUint16(at, true);
    case 5125: return bin.getUint32(at, true);
    case 5126: return bin.getFloat32(at, true);
    default: return fail('accessor', 'unsupported component type');
  }
}
function normalized(a: Accessor, v: number): number {
  if (!a.normalized) return v;
  switch (a.componentType) {
    case 5120: return Math.max(v / 127, -1);
    case 5121: return v / 255;
    case 5122: return Math.max(v / 32767, -1);
    case 5123: return v / 65535;
    default: return v;
  }
}
// Stream effective sparse values without allocating a count-sized array.
function eachElement(a: Accessor, bin: DataView, visit: (at: number | undefined, i: number) => void): void {
  let s = 0;
  for (let i = 0; i < a.count; i++) {
    let at = a.start === undefined ? undefined : a.start + i * a.stride;
    if (a.sparse && s < a.sparse.count && read(bin, a.sparse.indexType, a.sparse.indices + s * a.sparse.indexWidth) === i) {
      at = a.sparse.values + s * a.size; s++;
    }
    visit(at, i);
  }
}

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) { let n = i; for (let b = 0; b < 8; b++) n = (n & 1) ? 0xedb88320 ^ (n >>> 1) : n >>> 1; CRC_TABLE[i] = n >>> 0; }
function crc(bytes: Uint8Array, start: number, end: number): number {
  let n = 0xffffffff;
  for (let i = start; i < end; i++) n = CRC_TABLE[(n ^ bytes[i]!) & 255]! ^ (n >>> 8);
  return (n ^ 0xffffffff) >>> 0;
}
function pixels(w: number, h: number, p: string): number {
  int(w, `${p}.width`, L.imageDimension, 1); int(h, `${p}.height`, L.imageDimension, 1);
  return budget(w * h, L.imagePixels, p + ' pixels');
}
function pngPixels(bytes: Uint8Array, p: string): number {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 45 || [137, 80, 78, 71, 13, 10, 26, 10].some((b, i) => bytes[i] !== b) || v.getUint32(8) !== 13 || v.getUint32(12) !== 0x49484452) fail(p, 'invalid PNG signature/IHDR');
  const result = pixels(v.getUint32(16), v.getUint32(20), p);
  const depths = new Map([[0, [1, 2, 4, 8, 16]], [2, [8, 16]], [3, [1, 2, 4, 8]], [4, [8, 16]], [6, [8, 16]]]);
  if (!depths.get(bytes[25]!)?.includes(bytes[24]!) || bytes[26] !== 0 || bytes[27] !== 0 || ![0, 1].includes(bytes[28]!)) fail(p, 'invalid PNG format');
  let at = 8, chunks = 0, idat = false, idatBytes = 0;
  while (at < bytes.length) {
    budget(++chunks, L.imageChunks, p + ' chunks');
    if (at + 12 > bytes.length) fail(p, 'truncated PNG chunk');
    const len = v.getUint32(at), kind = v.getUint32(at + 4), end = at + 12 + len;
    if (end > bytes.length) fail(p, 'PNG chunk exceeds bufferView');
    if (crc(bytes, at + 4, end - 4) !== v.getUint32(end - 4)) fail(p, 'PNG CRC mismatch');
    if (kind === 0x6163544c || kind === 0x6663544c || kind === 0x66644154) fail(p, 'animated PNG is unsupported');
    if (kind === 0x49484452 && at !== 8) fail(p, 'duplicate PNG IHDR');
    if (kind === 0x49444154) { idat = true; idatBytes += len; }
    if (kind === 0x49454e44) {
      if (len !== 0 || !idat || idatBytes === 0 || end !== bytes.length) fail(p, 'invalid PNG IEND/IDAT or trailing bytes');
      return result;
    }
    at = end;
  }
  return fail(p, 'missing PNG IEND');
}
function jpegPixels(bytes: Uint8Array, p: string): number {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) fail(p, 'invalid JPEG signature');
  let at = 2, result = 0, markers = 0, scan = false;
  while (at < bytes.length) {
    budget(++markers, L.imageChunks, p + ' markers');
    if (bytes[at++] !== 0xff) fail(p, 'invalid JPEG marker');
    while (bytes[at] === 0xff) at++;
    const kind = bytes[at++];
    if (kind === 0xd9) {
      if (!result || !scan || at !== bytes.length) fail(p, 'invalid JPEG EOI or trailing bytes');
      return result;
    }
    if (kind === undefined || kind === 0 || kind === 0xd8 || (kind >= 0xd0 && kind <= 0xd7) || at + 2 > bytes.length) fail(p, 'invalid/truncated JPEG marker');
    const length = v.getUint16(at), end = at + length;
    if (length < 2 || end > bytes.length) fail(p, 'JPEG segment exceeds bufferView');
    if (kind === 0xdc) fail(p, 'JPEG DNL dimension changes are unsupported');
    if (kind >= 0xc0 && kind <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(kind)) {
      if (![0xc0, 0xc1, 0xc2].includes(kind) || result || scan || length < 11 || bytes[at + 2] !== 8) fail(p, 'unsupported JPEG frame');
      const components = bytes[at + 7]!;
      if (![1, 3, 4].includes(components) || length !== 8 + components * 3) fail(p, 'invalid JPEG frame components');
      result = pixels(v.getUint16(at + 5), v.getUint16(at + 3), p);
    }
    if (kind === 0xda) {
      if (!result || length < 8 || length !== 6 + 2 * bytes[at + 2]!) fail(p, 'invalid JPEG scan');
      scan = true; at = end;
      // Entropy bytes: skip escaped FF and restart markers; return to marker
      // parser for subsequent progressive scans and EOI. No pixel decoding.
      while (at < bytes.length) {
        if (bytes[at] !== 0xff) { at++; continue; }
        let next = at + 1; while (bytes[next] === 0xff) next++;
        if (bytes[next] === 0 || (bytes[next]! >= 0xd0 && bytes[next]! <= 0xd7)) { at = next + 1; continue; }
        break;
      }
    } else at = end;
  }
  return fail(p, 'missing JPEG EOI');
}

type Rule = readonly [number, number] | 'texture' | 'normalTexture' | 'color';
const MATERIAL_EXTENSIONS = new Map<string, Record<string, Rule>>([
  ['KHR_materials_unlit', {}],
  ['KHR_materials_emissive_strength', { emissiveStrength: [0, 1000] }],
  ['KHR_materials_ior', { ior: [1, 10] }],
  ['KHR_materials_specular', { specularFactor: [0, 1], specularTexture: 'texture', specularColorFactor: 'color', specularColorTexture: 'texture' }],
  ['KHR_materials_clearcoat', { clearcoatFactor: [0, 1], clearcoatTexture: 'texture', clearcoatRoughnessFactor: [0, 1], clearcoatRoughnessTexture: 'texture', clearcoatNormalTexture: 'normalTexture' }],
  ['KHR_materials_transmission', { transmissionFactor: [0, 1], transmissionTexture: 'texture' }],
  ['KHR_materials_volume', { thicknessFactor: [0, 1000], thicknessTexture: 'texture', attenuationDistance: [0, L.magnitude], attenuationColor: 'color' }],
  ['KHR_materials_sheen', { sheenColorFactor: 'color', sheenColorTexture: 'texture', sheenRoughnessFactor: [0, 1], sheenRoughnessTexture: 'texture' }],
]);
const SAFE_EXTENSIONS = new Set([...MATERIAL_EXTENSIONS.keys(), 'KHR_texture_transform']);
const COMPRESSED = new Set(['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_meshopt_compression', 'KHR_texture_basisu']);
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const inputBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const inputOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!;
const inputLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;

/**
 * Synchronous; returns only metadata, or throws Error("GLB preflight: ...").
 * Validate the exact immutable bytes subsequently passed to parseAsync. Shared
 * memory is refused; callers must prevent mutation between preflight and load.
 * Limits are preview policy, often stricter than glTF. Static world transforms,
 * raw samples and morph deltas are bounded; evaluated deformed/animated poses
 * and complete glTF/image conformance are not certified.
 */
export function validateGlb(input: ArrayBuffer | Uint8Array): GlbMetadata {
  let bytes: Uint8Array;
  try {
    if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
    else if (input instanceof Uint8Array) {
      // Use native internal-slot getters, never asset-supplied/shadow getters.
      const buffer: unknown = inputBuffer.call(input);
      if (!(buffer instanceof ArrayBuffer)) fail('input', 'expected ArrayBuffer or Uint8Array backed by non-shared memory');
      bytes = new Uint8Array(buffer, inputOffset.call(input) as number, inputLength.call(input) as number);
    } else return fail('input', 'expected ArrayBuffer or Uint8Array backed by non-shared memory');
  } catch { return fail('input', 'expected ArrayBuffer or Uint8Array with valid non-shared, non-detached storage'); }
  if (bytes.length > L.bytes) fail('header', '64 MiB byte budget exceeded');
  if (bytes.length < 28 || bytes.length % 4) fail('header', 'truncated or unaligned GLB');
  const container = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  if (container.getUint32(0, true) !== 0x46546c67 || container.getUint32(4, true) !== 2) fail('header', 'expected GLB magic and version 2');
  if (container.getUint32(8, true) !== bytes.length) fail('header', 'declared length does not match exact input');
  const jsonLength = container.getUint32(12, true), binHeader = 20 + jsonLength;
  if (!jsonLength || jsonLength % 4 || container.getUint32(16, true) !== 0x4e4f534a || binHeader + 8 > bytes.length) fail('chunks', 'expected aligned JSON followed by BIN');
  const binLength = container.getUint32(binHeader, true);
  if (!binLength || binLength % 4 || container.getUint32(binHeader + 4, true) !== 0x004e4942 || binHeader + 8 + binLength !== bytes.length) fail('chunks', 'expected exactly one aligned JSON and one BIN chunk, without trailing chunks');
  const root = parseData(bytes.subarray(20, binHeader));
  const asset = obj(root.asset, 'asset');
  if (asset.version !== '2.0' || (asset.minVersion !== undefined && asset.minVersion !== '2.0')) fail('asset', 'only glTF 2.0 is supported');
  const used = new Set<string>(), required = new Set<string>();
  for (const [key, set] of [['extensionsUsed', used], ['extensionsRequired', required]] as const) {
    for (const name of arr(root[key] ?? [], key, 32)) {
      if (typeof name !== 'string' || set.has(name)) fail(key, 'expected unique extension names');
      if (COMPRESSED.has(name)) fail(key, `extension ${name} needs an unavailable local decoder`);
      if (!SAFE_EXTENSIONS.has(name)) fail(key, `unsupported extension ${name}`);
      set.add(name);
    }
  }
  for (const name of required) if (!used.has(name)) fail('extensionsRequired', 'required extension must be listed in extensionsUsed');
  const extensionObjects = new Set<Obj>();
  function checkExtensions(v: unknown, p: string): void {
    if (Array.isArray(v)) { v.forEach((x, i) => checkExtensions(x, `${p}[${i}]`)); return; }
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      if (k === 'extensions') {
        for (const [name, payload] of Object.entries(obj(x, `${p}.extensions`))) {
          if (COMPRESSED.has(name)) fail(p, `extension ${name} needs an unavailable local decoder`);
          if (!SAFE_EXTENSIONS.has(name) || !used.has(name)) fail(p, `unsupported or undeclared extension ${name}`);
          extensionObjects.add(obj(payload, `${p}.extensions.${name}`));
        }
      }
      checkExtensions(x, `${p}.${k}`);
    }
  }
  checkExtensions(root, '$');
  const rows = (k: string, max: number, min = 0): Obj[] => arr(root[k] ?? [], k, max, min).map((x, i) => obj(x, `${k}[${i}]`));
  const buffers = rows('buffers', 1, 1), bufferLength = int(buffers[0]!.byteLength, 'buffers[0].byteLength', binLength, 1);
  if (binLength - bufferLength > 3) fail('BIN', 'length differs from buffer byteLength by more than alignment padding');
  const binBytes = bytes.subarray(binHeader + 8), bin = new DataView(binBytes.buffer, binBytes.byteOffset, bufferLength);
  for (let i = bufferLength; i < binLength; i++) if (binBytes[i] !== 0) fail('BIN', 'padding must be zero');
  const views: View[] = rows('bufferViews', L.bufferViews).map((v, i) => {
    const p = `bufferViews[${i}]`;
    ref(v.buffer, buffers, p + '.buffer');
    const offset = int(v.byteOffset ?? 0, p + '.byteOffset', bufferLength), length = int(v.byteLength, p + '.byteLength', bufferLength, 1);
    if (offset + length > bufferLength) fail(p, 'range exceeds embedded buffer');
    const stride = v.byteStride === undefined ? undefined : int(v.byteStride, p + '.byteStride', 252, 4);
    if (stride !== undefined && stride % 4) fail(p, 'byteStride must be a multiple of four');
    if (v.target !== undefined) choice(v.target, p + '.target', [34962, 34963]);
    return { offset, length, stride, target: v.target };
  });
  let components = 0, allocation = 0;
  const range = (view: View, offset: number, count: number, stride: number, span: number, width: number, p: string): number => {
    if (offset % width || (view.offset + offset) % width || stride % width) fail(p, 'component alignment is invalid');
    if (offset + (count - 1) * stride + span > view.length) fail(p, 'accessor range exceeds bufferView');
    return view.offset + offset;
  };
  const accessors: Accessor[] = rows('accessors', L.accessors).map((a, i) => {
    const p = `accessors[${i}]`, componentType = int(a.componentType, p + '.componentType', 5126), width = WIDTHS.get(componentType);
    const shape = typeof a.type === 'string' ? SHAPES.get(a.type) : undefined;
    if (!width || !shape) fail(p, 'unsupported accessor type/componentType');
    const [r, c] = shape as [number, number], count = int(a.count, p + '.count', L.accessorElements, 1);
    optionalBoolean(a, 'normalized', p);
    if (a.normalized === true && [5125, 5126].includes(componentType)) fail(p, 'normalized requires byte/short integer components');
    const column = c > 1 ? Math.ceil(r * width / 4) * 4 : r * width;
    const size = column * c, offsets = Array.from({ length: r * c }, (_, j) => Math.floor(j / r) * column + (j % r) * width);
    const span = offsets[offsets.length - 1]! + width;
    components = budget(components + count * offsets.length, L.accessorComponents, 'accessor components');
    // Four bytes/component covers normalized arrays; padded stride covers the
    // backing storage some loaders copy for an interleaved/sparse accessor.
    const view = a.bufferView === undefined ? undefined : views[ref(a.bufferView, views, p + '.bufferView')]!;
    const stride = view?.stride ?? size, offset = int(a.byteOffset ?? 0, p + '.byteOffset', bufferLength);
    if (stride < size) fail(p, 'stride is smaller than padded accessor element');
    allocation = budget(allocation + count * Math.max(stride, offsets.length * 4), L.accessorAllocationBytes, 'accessor allocation');
    if (!view && offset !== 0) fail(p, 'byteOffset requires a bufferView');
    const start = view ? range(view, offset, count, stride, span, c > 1 ? Math.max(width, 4) : width, p) : undefined;
    let sparse: Sparse | undefined;
    if (a.sparse !== undefined) {
      const s = obj(a.sparse, p + '.sparse'), n = int(s.count, p + '.sparse.count', count, 1);
      const indices = obj(s.indices, p + '.sparse.indices'), values = obj(s.values, p + '.sparse.values');
      const indexType = int(indices.componentType, p + '.sparse.indices.componentType', 5125);
      choice(indexType, p + '.sparse.indices.componentType', [5121, 5123, 5125]);
      const indexWidth = WIDTHS.get(indexType)!;
      const iv = views[ref(indices.bufferView, views, p + '.sparse.indices.bufferView')]!, vv = views[ref(values.bufferView, views, p + '.sparse.values.bufferView')]!;
      if (iv.stride !== undefined || vv.stride !== undefined || iv.target !== undefined || vv.target !== undefined) fail(p, 'sparse views must have no byteStride or target');
      sparse = { count: n, indexType, indexWidth,
        indices: range(iv, int(indices.byteOffset ?? 0, p + '.sparse.indices.byteOffset', bufferLength), n, indexWidth, indexWidth, indexWidth, p + '.sparse.indices'),
        values: range(vv, int(values.byteOffset ?? 0, p + '.sparse.values.byteOffset', bufferLength), n, size, span, c > 1 ? Math.max(width, 4) : width, p + '.sparse.values') };
      let previous = -1;
      for (let j = 0; j < n; j++) {
        const index = read(bin, indexType, sparse.indices + j * indexWidth);
        if (index <= previous || index >= count) fail(p, 'sparse indices must be increasing and within accessor count');
        previous = index;
      }
    }
    const result: Accessor = { type: a.type as string, componentType, width, count, normalized: a.normalized === true, offsets, size, span, stride, start, view, sparse, min: offsets.map(() => Infinity), max: offsets.map(() => -Infinity), declared: a };
    // Check underlying float samples as well as replacements (even an invalid
    // base sample hidden by a sparse override must never reach the loader).
    if (componentType === 5126) {
      const check = (at: number): void => { for (const o of offsets) num(read(bin, componentType, at + o), p + ' binary sample'); };
      if (start !== undefined) for (let j = 0; j < count; j++) check(start + j * stride);
      if (sparse) for (let j = 0; j < sparse.count; j++) check(sparse.values + j * size);
    }
    eachElement(result, bin, at => {
      offsets.forEach((o, k) => {
        const value = at === undefined ? 0 : read(bin, componentType, at + o);
        result.min[k] = Math.min(result.min[k]!, value); result.max[k] = Math.max(result.max[k]!, value);
      });
    });
    for (const key of ['min', 'max'] as const) if (a[key] !== undefined) {
      const declared = vector(a[key], p + '.' + key, offsets.length, -3.4028234663852886e38, 3.4028234663852886e38);
      declared.forEach((n, k) => {
        const actual = result[key][k]!;
        if ((componentType === 5126 ? Math.fround(n) : n) !== actual) fail(p + '.' + key, 'declared bounds disagree with actual accessor data');
      });
    }
    return result;
  });
  const getAccessor = (v: unknown, p: string): Accessor => accessors[ref(v, accessors, p)]!;
  const packed = (a: Accessor, p: string): void => { if (a.view?.stride !== undefined) fail(p, 'non-vertex accessors must be tightly packed'); };
  const format = (a: Accessor, types: readonly string[], allowed: readonly number[], p: string): void => {
    if (!types.includes(a.type) || !allowed.includes(a.componentType)) fail(p, 'invalid accessor format for this use');
  };

  const images = rows('images', L.images), imageSizes: number[] = [];
  let encodedImageBytes = 0;
  for (let i = 0; i < images.length; i++) {
    const image = images[i]!, p = `images[${i}]`, view = views[ref(image.bufferView, views, p + '.bufferView')]!;
    if (view.stride !== undefined || view.target !== undefined) fail(p, 'image view must have no byteStride/target');
    // Overlapping/aliased views must not multiply decode/check work beyond the
    // file budget (a tiny claimed image may still contain a large payload).
    encodedImageBytes = budget(encodedImageBytes + view.length, L.imageEncodedBytes, 'aggregate encoded image bytes');
    const encoded = binBytes.subarray(view.offset, view.offset + view.length);
    if (image.mimeType !== 'image/png' && image.mimeType !== 'image/jpeg') fail(p, 'only embedded PNG/JPEG images are supported');
    imageSizes.push(image.mimeType === 'image/png' ? pngPixels(encoded, p) : jpegPixels(encoded, p));
    budget(imageSizes.reduce((a, b) => a + b, 0), L.imagePixels, 'aggregate image pixels');
  }
  const samplers = rows('samplers', L.textures);
  samplers.forEach((s, i) => {
    for (const [key, values] of [['magFilter', [9728, 9729]], ['minFilter', [9728, 9729, 9984, 9985, 9986, 9987]], ['wrapS', [33071, 33648, 10497]], ['wrapT', [33071, 33648, 10497]]] as const) {
      if (s[key] !== undefined) choice(s[key], `samplers[${i}].${key}`, values);
    }
  });
  const textures = rows('textures', L.textures), imageUses = imageSizes.map(() => 0);
  textures.forEach((t, i) => { const image = ref(t.source, images, `textures[${i}].source`); imageUses[image] = imageUses[image]! + 1; if (t.sampler !== undefined) ref(t.sampler, samplers, `textures[${i}].sampler`); });
  const imagePixels = budget(imageSizes.reduce((sum, size, i) => sum + size * Math.max(1, imageUses[i]!), 0), L.imagePixels, 'aggregate texture pixels');
  function textureInfo(v: unknown, p: string, kind = 'texture'): void {
    const t = obj(v, p); ref(t.index, textures, p + '.index');
    if (t.texCoord !== undefined) int(t.texCoord, p + '.texCoord', 7);
    if (kind === 'normalTexture') optionalNumber(t, 'scale', p, -1000, 1000);
    if (kind === 'occlusionTexture') optionalNumber(t, 'strength', p, 0, 1);
    if (t.extensions !== undefined) {
      const ext = obj(t.extensions, p + '.extensions');
      for (const name of Object.keys(ext)) {
        if (name !== 'KHR_texture_transform') fail(p, 'extension not allowed on texture info');
        const e = obj(ext[name], p + '.extensions.' + name); extensionObjects.delete(e);
        for (const key of Object.keys(e)) {
          if (key === 'offset' || key === 'scale') vector(e[key], p + '.' + key, 2, -1000, 1000);
          else if (key === 'rotation') num(e[key], p + '.rotation', -1000, 1000);
          else if (key === 'texCoord') int(e[key], p + '.texCoord', 7);
          else fail(p, 'unknown texture transform field');
        }
      }
    }
  }
  const materials = rows('materials', L.materials);
  materials.forEach((m, i) => {
    const p = `materials[${i}]`;
    optionalBoolean(m, 'doubleSided', p);
    if (m.alphaMode !== undefined) choice(m.alphaMode, p + '.alphaMode', ['OPAQUE', 'MASK', 'BLEND']);
    optionalNumber(m, 'alphaCutoff', p, 0, 1);
    if (m.emissiveFactor !== undefined) vector(m.emissiveFactor, p + '.emissiveFactor', 3, 0, 1);
    for (const key of ['normalTexture', 'occlusionTexture', 'emissiveTexture']) if (m[key] !== undefined) textureInfo(m[key], p + '.' + key, key);
    if (m.pbrMetallicRoughness !== undefined) {
      const b = obj(m.pbrMetallicRoughness, p + '.pbrMetallicRoughness');
      if (b.baseColorFactor !== undefined) vector(b.baseColorFactor, p + '.baseColorFactor', 4, 0, 1);
      for (const k of ['metallicFactor', 'roughnessFactor']) optionalNumber(b, k, p, 0, 1);
      for (const k of ['baseColorTexture', 'metallicRoughnessTexture']) if (b[k] !== undefined) textureInfo(b[k], p + '.' + k);
    }
    if (m.extensions !== undefined) for (const [name, raw] of Object.entries(obj(m.extensions, p + '.extensions'))) {
      const rules = MATERIAL_EXTENSIONS.get(name);
      if (!rules) fail(p, 'extension not allowed on material');
      const e = obj(raw, p + '.extensions.' + name); extensionObjects.delete(e);
      for (const [key, value] of Object.entries(e)) {
        const rule = Object.hasOwn(rules, key) ? rules[key] : undefined;
        if (!rule) fail(p + '.' + name, 'unknown material extension field');
        if (rule === 'color') vector(value, p + '.' + key, 3, 0, 1);
        else if (typeof rule === 'string') textureInfo(value, p + '.' + key, rule);
        else num(value, p + '.' + key, rule[0], rule[1]);
      }
    }
  });

  let primitiveCount = 0, meshTriangles = 0, meshVertices = 0, meshDraws = 0;
  const meshes = rows('meshes', L.meshes, 1);
  const metrics = meshes.map((m, i) => {
    const p = `meshes[${i}]`, primitives = arr(m.primitives, p + '.primitives', L.primitives, 1);
    let triangles = 0, vertices = 0, draws = 0, targets = -1;
    const joints: Accessor[] = [], positionBounds: { min: number[]; max: number[] }[] = [];
    for (let j = 0; j < primitives.length; j++) {
      budget(++primitiveCount, L.primitives, 'primitives');
      const primitive = obj(primitives[j], `${p}.primitives[${j}]`), q = `${p}.primitives[${j}]`, attributes = obj(primitive.attributes, q + '.attributes');
      const position = getAccessor(attributes.POSITION, q + '.POSITION');
      format(position, ['VEC3'], [5126], q + '.POSITION');
      if (position.declared.min === undefined || position.declared.max === undefined) fail(q, 'POSITION requires min and max');
      positionBounds.push({ min: position.min, max: position.max });
      const attribute = (semantic: string, value: unknown, morph: boolean): Accessor => {
        const a = getAccessor(value, q + '.' + semantic);
        if (a.count !== position.count) fail(q, 'attribute/morph accessor counts must match POSITION');
        if (a.start !== undefined && ((a.start - a.view!.offset) % 4 || a.start % 4 || a.stride % 4)) fail(q, 'vertex attributes must be four-byte aligned');
        if (morph) {
          if (attributes[semantic] === undefined) fail(q, 'morph attribute needs matching base attribute');
          if (!['POSITION', 'NORMAL', 'TANGENT'].includes(semantic)) fail(q, 'unsupported morph semantic');
          format(a, ['VEC3'], [5126], q + '.targets.' + semantic);
          if (semantic === 'POSITION' && (a.declared.min === undefined || a.declared.max === undefined)) fail(q, 'morph POSITION requires min and max');
        } else if (semantic === 'POSITION' || semantic === 'NORMAL' || semantic === 'TANGENT') format(a, [semantic === 'TANGENT' ? 'VEC4' : 'VEC3'], [5126], q + '.' + semantic);
        else if (/^(TEXCOORD|COLOR|JOINTS|WEIGHTS)_(0|[1-7])$/.test(semantic)) {
          const joint = semantic.startsWith('JOINTS'), uv = semantic.startsWith('TEXCOORD'), color = semantic.startsWith('COLOR');
          format(a, uv ? ['VEC2'] : color ? ['VEC3', 'VEC4'] : ['VEC4'], joint ? [5121, 5123] : [5121, 5123, 5126], q + '.' + semantic);
          if (joint && a.normalized) fail(q, 'JOINTS must not be normalized');
          if (!joint && a.componentType !== 5126 && !a.normalized) fail(q, 'integer colors/UVs/weights must be normalized');
          if (joint) { joints.push(a); if (attributes[semantic.replace('JOINTS', 'WEIGHTS')] === undefined) fail(q, 'JOINTS requires matching WEIGHTS'); }
          if (semantic.startsWith('WEIGHTS') && attributes[semantic.replace('WEIGHTS', 'JOINTS')] === undefined) fail(q, 'WEIGHTS requires matching JOINTS');
        } else if (!semantic.startsWith('_') || a.componentType === 5125 || a.type.startsWith('MAT')) fail(q, 'unsupported attribute semantic/format');
        return a;
      };
      const entries = Object.entries(attributes);
      if (entries.length > L.attributes) fail(q, 'attribute budget exceeded');
      let perVertex = 0;
      for (const [name, value] of entries) perVertex += attribute(name, value, false).offsets.length * 4;
      const morphs = arr(primitive.targets ?? [], q + '.targets', L.morphTargets);
      if (targets !== -1 && targets !== morphs.length) fail(p, 'primitives must have matching morph target counts');
      targets = morphs.length;
      for (const target of morphs) {
        const entries = Object.entries(obj(target, q + '.target'));
        if (!entries.length || entries.length > 3) fail(q, 'invalid morph attributes');
        for (const [name, value] of entries) perVertex += attribute(name, value, true).offsets.length * 4;
      }
      let count = position.count;
      if (primitive.indices !== undefined) {
        const a = getAccessor(primitive.indices, q + '.indices'); format(a, ['SCALAR'], [5121, 5123, 5125], q + '.indices'); packed(a, q + '.indices');
        if (a.normalized || a.max[0]! >= position.count || a.max[0] === 2 ** (a.width * 8) - 1) fail(q, 'index value out of vertex bounds or primitive-restart sentinel');
        count = a.count;
      }
      const mode = int(primitive.mode ?? 4, q + '.mode', 6);
      if ((mode === 1 && count % 2) || (mode === 4 && count % 3) || ([2, 3].includes(mode) && count < 2) || ([5, 6].includes(mode) && count < 3)) fail(q, 'element count incompatible with primitive topology');
      triangles += mode === 4 ? count / 3 : mode >= 5 ? count - 2 : 0;
      vertices += count;
      let drawCost = 1;
      if (primitive.material !== undefined) { const m = materials[ref(primitive.material, materials, q + '.material')]!; if (m.doubleSided === true && m.alphaMode === 'BLEND') drawCost = 2; }
      draws += drawCost;
      // Flat normal generation and strip/fan conversion may expand indexed
      // attributes. Bound this derived allocation as well as stored accessors.
      if (attributes.NORMAL === undefined || mode >= 5) allocation = budget(allocation + (mode >= 5 ? (count - 2) * 3 : count) * (perVertex + 12), L.accessorAllocationBytes, 'derived geometry allocation');
    }
    if (m.weights !== undefined) vector(m.weights, p + '.weights', targets, -1000, 1000);
    meshTriangles = budget(meshTriangles + triangles, L.triangles, 'mesh triangles');
    meshVertices = budget(meshVertices + vertices, L.submittedVertices, 'mesh submitted vertices');
    meshDraws = budget(meshDraws + draws, L.drawCalls, 'mesh draw calls');
    return { triangles, vertices, draws, targets, joints, positionBounds, primitives };
  });

  const nodes = rows('nodes', L.nodes), skins = rows('skins', L.skins), cameras = rows('cameras', L.nodes), scenes = rows('scenes', 256);
  cameras.forEach((camera, i) => {
    const p = `cameras[${i}]`;
    choice(camera.type, p + '.type', ['perspective', 'orthographic']);
    const settings = obj(camera[camera.type as string], p + '.' + camera.type);
    const near = num(settings.znear, p + '.znear', camera.type === 'perspective' ? Number.EPSILON : 0);
    if (settings.zfar !== undefined && num(settings.zfar, p + '.zfar', 0) <= near) fail(p, 'zfar must exceed znear');
    if (camera.type === 'perspective') {
      num(settings.yfov, p + '.yfov', Number.EPSILON, Math.PI - Number.EPSILON);
      if (settings.aspectRatio !== undefined) num(settings.aspectRatio, p + '.aspectRatio', Number.EPSILON);
    } else {
      num(settings.xmag, p + '.xmag', Number.EPSILON); num(settings.ymag, p + '.ymag', Number.EPSILON);
      if (settings.zfar === undefined) fail(p, 'orthographic camera requires zfar');
    }
  });
  const parents = nodes.map(() => -1), children: number[][] = [], local: number[][] = [];
  const identity = (): number[] => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  let instanceTriangles = 0, instanceVertices = 0, instanceDraws = 0;
  nodes.forEach((n, i) => {
    const p = `nodes[${i}]`;
    const kids = arr(n.children ?? [], p + '.children', L.nodes).map(v => ref(v, nodes, p + '.child'));
    for (const child of kids) { if (parents[child] !== -1) fail(p, 'node has duplicate/multiple parents'); parents[child] = i; }
    children.push(kids);
    if (n.camera !== undefined) ref(n.camera, cameras, p + '.camera');
    if (n.skin !== undefined) { ref(n.skin, skins, p + '.skin'); if (n.mesh === undefined) fail(p, 'skin requires mesh'); }
    if (n.mesh !== undefined) {
      const m = metrics[ref(n.mesh, meshes, p + '.mesh')]!;
      instanceTriangles = budget(instanceTriangles + m.triangles, L.triangles, 'instance triangles');
      instanceVertices = budget(instanceVertices + m.vertices, L.submittedVertices, 'instance submitted vertices');
      instanceDraws = budget(instanceDraws + m.draws, L.drawCalls, 'instance draw calls');
      if (n.weights !== undefined) vector(n.weights, p + '.weights', m.targets, -1000, 1000);
    } else if (n.weights !== undefined) fail(p, 'weights requires morph mesh');
    if (n.matrix !== undefined) {
      if (['translation', 'rotation', 'scale'].some(k => n[k] !== undefined)) fail(p, 'matrix and TRS are mutually exclusive');
      const matrix = vector(n.matrix, p + '.matrix', 16);
      if (matrix[3] !== 0 || matrix[7] !== 0 || matrix[11] !== 0 || matrix[15] !== 1) fail(p, 'matrix must be affine');
      local.push(matrix);
    } else {
      const t = n.translation === undefined ? [0, 0, 0] : vector(n.translation, p + '.translation', 3);
      const s = n.scale === undefined ? [1, 1, 1] : vector(n.scale, p + '.scale', 3);
      const q = n.rotation === undefined ? [0, 0, 0, 1] : vector(n.rotation, p + '.rotation', 4, -1, 1);
      if (Math.abs(Math.hypot(...q) - 1) > 0.001) fail(p, 'rotation must be a unit quaternion');
      const [x, y, z, w] = q as [number, number, number, number];
      local.push([(1 - 2 * (y*y + z*z))*s[0]!, (2*(x*y + z*w))*s[0]!, (2*(x*z - y*w))*s[0]!, 0,
        (2*(x*y - z*w))*s[1]!, (1 - 2*(x*x + z*z))*s[1]!, (2*(y*z + x*w))*s[1]!, 0,
        (2*(x*z + y*w))*s[2]!, (2*(y*z - x*w))*s[2]!, (1 - 2*(x*x + y*y))*s[2]!, 0, t[0]!, t[1]!, t[2]!, 1]);
    }
  });
  const state = new Uint8Array(nodes.length);
  function visitNode(i: number, parent: number[], depth: number): void {
    if (state[i] === 1) fail(`nodes[${i}]`, 'node cycle detected');
    if (state[i] === 2) return;
    if (depth > L.nodeDepth) fail(`nodes[${i}]`, 'node hierarchy depth budget exceeded');
    state[i] = 1;
    const world = identity(), matrix = local[i]!;
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      let value = 0; for (let k = 0; k < 4; k++) value += parent[k * 4 + r]! * matrix[c * 4 + k]!;
      world[c * 4 + r] = num(value, `nodes[${i}].worldTransform`);
    }
    const node = nodes[i]!;
    if (node.mesh !== undefined) for (const b of metrics[node.mesh as number]!.positionBounds) {
      for (let r = 0; r < 3; r++) {
        let lo = world[12 + r]!, hi = lo;
        for (let c = 0; c < 3; c++) { const x = world[c * 4 + r]! * b.min[c]!, y = world[c * 4 + r]! * b.max[c]!; lo += Math.min(x, y); hi += Math.max(x, y); }
        num(lo, `nodes[${i}].worldPosition`); num(hi, `nodes[${i}].worldPosition`);
      }
    }
    for (const child of children[i]!) visitNode(child, world, depth + 1);
    state[i] = 2;
  }
  for (let i = 0; i < nodes.length; i++) if (parents[i] === -1) visitNode(i, identity(), 1);
  // Any unreached component of a single-parent graph contains a cycle.
  if (state.some(s => s !== 2)) fail('nodes', 'node cycle detected');
  scenes.forEach((s, i) => {
    const roots = arr(s.nodes ?? [], `scenes[${i}].nodes`, L.nodes).map(v => ref(v, nodes, `scenes[${i}].node`));
    if (new Set(roots).size !== roots.length || roots.some(r => parents[r] !== -1)) fail(`scenes[${i}]`, 'scene nodes must be unique hierarchy roots');
  });
  if (root.scene !== undefined) ref(root.scene, scenes, 'scene');
  const skinJoints = skins.map((s, i) => {
    const p = `skins[${i}]`, joints = arr(s.joints, p + '.joints', L.joints, 1).map(v => ref(v, nodes, p + '.joint'));
    if (new Set(joints).size !== joints.length) fail(p, 'duplicate skin joints');
    if (s.skeleton !== undefined) ref(s.skeleton, nodes, p + '.skeleton');
    if (s.inverseBindMatrices !== undefined) {
      const a = getAccessor(s.inverseBindMatrices, p + '.inverseBindMatrices'); format(a, ['MAT4'], [5126], p); packed(a, p);
      if (a.count < joints.length) fail(p, 'inverse bind matrix count is smaller than joint count');
    }
    return joints.length;
  });
  nodes.forEach((n, i) => {
    if (n.skin === undefined) return;
    const m = metrics[n.mesh as number]!, jointCount = skinJoints[n.skin as number]!;
    for (const raw of m.primitives) { const a = obj(obj(raw, 'primitive').attributes, 'attributes'); if (a.JOINTS_0 === undefined || a.WEIGHTS_0 === undefined) fail(`nodes[${i}]`, 'skinned primitives require JOINTS_0/WEIGHTS_0'); }
    for (const a of m.joints) if (a.max.some(v => v >= jointCount)) fail(`nodes[${i}]`, 'JOINTS value exceeds skin joint count');
  });

  const animations = rows('animations', L.animations);
  let channelCount = 0;
  const timeChecked = new Set<Accessor>();
  const rotationsChecked = new Map<Accessor, Set<number>>();
  animations.forEach((animation, i) => {
    const p = `animations[${i}]`, samplers = arr(animation.samplers, p + '.samplers', L.animationChannels, 1).map(v => obj(v, p + '.sampler'));
    const pairs = samplers.map((s, j) => {
      const q = `${p}.samplers[${j}]`, input = getAccessor(s.input, q + '.input'), output = getAccessor(s.output, q + '.output');
      format(input, ['SCALAR'], [5126], q + '.input'); packed(input, q + '.input'); packed(output, q + '.output');
      if (input.declared.min === undefined || input.declared.max === undefined) fail(q, 'animation input requires min/max');
      const interpolation = s.interpolation ?? 'LINEAR'; choice(interpolation, q + '.interpolation', ['LINEAR', 'STEP', 'CUBICSPLINE']);
      if (interpolation === 'CUBICSPLINE' && input.count < 2) fail(q, 'CUBICSPLINE needs at least two keys');
      if (!timeChecked.has(input)) {
        let previous = -1;
        eachElement(input, bin, at => { const time = at === undefined ? 0 : read(bin, 5126, at); if (time < 0 || time <= previous) fail(q, 'animation times must be nonnegative and strictly increasing'); previous = time; });
        timeChecked.add(input);
      }
      return { input, output, factor: interpolation === 'CUBICSPLINE' ? 3 : 1 };
    });
    const seen = new Set<string>();
    for (const raw of arr(animation.channels, p + '.channels', L.animationChannels, 1)) {
      budget(++channelCount, L.animationChannels, 'animation channels');
      const channel = obj(raw, p + '.channel'), target = obj(channel.target, p + '.target');
      const pair = pairs[ref(channel.sampler, samplers, p + '.channel.sampler')]!;
      choice(target.path, p + '.target.path', ['translation', 'rotation', 'scale', 'weights']);
      const path = target.path as string;
      const nodeIndex = target.node === undefined ? undefined : ref(target.node, nodes, p + '.target.node');
      if (nodeIndex !== undefined) {
        const key = `${nodeIndex}:${path}`; if (seen.has(key)) fail(p, 'duplicate animation target'); seen.add(key);
        if (path !== 'weights' && nodes[nodeIndex]!.matrix !== undefined) fail(p, 'TRS animation cannot target a matrix node');
      }
      let targetCount = 1;
      if (path === 'weights') {
        if (nodeIndex === undefined || nodes[nodeIndex]!.mesh === undefined) fail(p, 'weights animation needs a morph mesh node');
        targetCount = metrics[nodes[nodeIndex]!.mesh as number]!.targets;
        if (!targetCount) fail(p, 'weights animation needs morph targets');
      }
      const a = pair.output;
      format(a, [path === 'weights' ? 'SCALAR' : path === 'rotation' ? 'VEC4' : 'VEC3'], ['rotation', 'weights'].includes(path) ? [5120, 5121, 5122, 5123, 5126] : [5126], p + '.output');
      if (a.componentType !== 5126 && !a.normalized) fail(p, 'integer animation output must be normalized');
      if (a.count !== pair.input.count * pair.factor * targetCount) fail(p, 'animation output count does not match keys/interpolation/morph targets');
      if (path === 'rotation' && !rotationsChecked.get(a)?.has(pair.factor)) {
        eachElement(a, bin, (at, key) => {
          if (pair.factor === 3 && key % 3 !== 1) return; // Derivative tangents are not unit quaternions.
          let norm = 0;
          for (const o of a.offsets) { const n = normalized(a, at === undefined ? 0 : read(bin, a.componentType, at + o)); norm += n * n; }
          if (Math.abs(Math.sqrt(norm) - 1) > 0.01) fail(p, 'animation rotation keys must be unit quaternions');
        });
        const checked = rotationsChecked.get(a) ?? new Set<number>(); checked.add(pair.factor); rotationsChecked.set(a, checked);
      }
    }
  });
  if (extensionObjects.size) fail('extensions', 'known extension used in an unsupported location');
  return { nodeCount: nodes.length, meshCount: meshes.length, triangleEstimate: Math.max(meshTriangles, instanceTriangles), imagePixels, animations: animations.length };
}
