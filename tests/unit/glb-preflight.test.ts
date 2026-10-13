import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GLB_PREFLIGHT_LIMITS as L, validateGlb } from '../../apps/desktop/src/glb-preflight.js';

// Fixtures contain real typed binary data. No renderer, image decoder, fetch,
// native tool, generated asset, dependency or fixture file is required.
type Doc = Record<string, any>;
const PNG = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64'));
function glb(doc: Doc | string, bin: Uint8Array, jsonPad = 0x20): Uint8Array {
  const text = new TextEncoder().encode(typeof doc === 'string' ? doc : JSON.stringify(doc));
  const jsonLength = (text.length + 3) & ~3, binLength = (bin.length + 3) & ~3;
  const bytes = new Uint8Array(28 + jsonLength + binLength), v = new DataView(bytes.buffer);
  v.setUint32(0, 0x46546c67, true); v.setUint32(4, 2, true); v.setUint32(8, bytes.length, true);
  v.setUint32(12, jsonLength, true); v.setUint32(16, 0x4e4f534a, true);
  bytes.fill(jsonPad, 20, 20 + jsonLength); bytes.set(text, 20);
  v.setUint32(20 + jsonLength, binLength, true); v.setUint32(24 + jsonLength, 0x004e4942, true); bytes.set(bin, 28 + jsonLength);
  return bytes;
}
function builder() {
  const doc: Doc = { asset: { version: '2.0', generator: 'Arcane data-only test' }, buffers: [{ byteLength: 0 }], bufferViews: [], accessors: [], meshes: [], nodes: [], scenes: [{ nodes: [0] }], scene: 0 };
  const chunks: number[] = [];
  function view(bytes: Uint8Array, options: Doc = {}): number {
    while (chunks.length % 4) chunks.push(0);
    const index = doc.bufferViews.length;
    doc.bufferViews.push({ buffer: 0, byteOffset: chunks.length, byteLength: bytes.length, ...options });
    chunks.push(...bytes); return index;
  }
  function accessor(values: number[], type: string, componentType = 5126, extra: Doc = {}): number {
    const widths: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
    const components: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
    const bytes = new Uint8Array(values.length * widths[componentType]!), v = new DataView(bytes.buffer);
    values.forEach((n, i) => {
      const at = i * widths[componentType]!;
      if (componentType === 5126) v.setFloat32(at, n, true);
      else if (componentType === 5125) v.setUint32(at, n, true);
      else if (componentType === 5123) v.setUint16(at, n, true);
      else if (componentType === 5122) v.setInt16(at, n, true);
      else if (componentType === 5120) v.setInt8(at, n);
      else v.setUint8(at, n);
    });
    const index = doc.accessors.length;
    doc.accessors.push({ bufferView: view(bytes), componentType, count: values.length / components[type]!, type, ...extra });
    return index;
  }
  function finish(): { doc: Doc; bin: Uint8Array; bytes: Uint8Array } {
    const bin = new Uint8Array(chunks); doc.buffers[0].byteLength = bin.length;
    return { doc, bin, bytes: glb(doc, bin) };
  }
  return { doc, accessor, view, finish };
}
function fixture(rich = false) {
  const b = builder(), d = b.doc;
  const position = b.accessor([0, 0, 0, 1, 0, 0, 0, 1, 0], 'VEC3', 5126, { min: [0, 0, 0], max: [1, 1, 0] });
  const normal = b.accessor([0, 0, 1, 0, 0, 1, 0, 0, 1], 'VEC3');
  const indices = b.accessor([0, 1, 2], 'SCALAR', 5123);
  d.meshes = [{ primitives: [{ attributes: { POSITION: position, NORMAL: normal }, indices }] }];
  d.nodes = [{ mesh: 0 }];
  if (rich) {
    const primitive = d.meshes[0].primitives[0];
    primitive.attributes.TEXCOORD_0 = b.accessor([0, 0, 1, 0, 0, 1], 'VEC2');
    primitive.attributes.COLOR_0 = b.accessor([255, 128, 0, 255, 255, 255, 255, 255, 128, 128, 128, 255], 'VEC4', 5121, { normalized: true });
    primitive.attributes.JOINTS_0 = b.accessor([0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0], 'VEC4', 5121);
    primitive.attributes.WEIGHTS_0 = b.accessor([0.5, 0.5, 0, 0, 0.5, 0.5, 0, 0, 1, 0, 0, 0], 'VEC4');
    const morph = b.accessor([0, 0, 0, 0, 0, 0, 0, 0, 0.5], 'VEC3', 5126, { min: [0, 0, 0], max: [0, 0, 0.5] });
    primitive.targets = [{ POSITION: morph }]; d.meshes[0].weights = [0];
    const ibm = b.accessor([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1, 0, 1], 'MAT4');
    d.nodes = [{ children: [1, 2] }, { mesh: 0, skin: 0, weights: [0] }, { children: [3] }, { translation: [0, 1, 0] }];
    d.skins = [{ joints: [2, 3], skeleton: 2, inverseBindMatrices: ibm }];
    const times = b.accessor([0, 1], 'SCALAR', 5126, { min: [0], max: [1] });
    const translation = b.accessor([0, 1, 0, 0, 2, 0], 'VEC3');
    const rotation = b.accessor([0, 0, 0, 1, 0, 0, 1, 0], 'VEC4');
    const weights = b.accessor([0, 1], 'SCALAR');
    d.animations = [{ samplers: [{ input: times, output: translation }, { input: times, output: rotation, interpolation: 'STEP' }, { input: times, output: weights }], channels: [{ sampler: 0, target: { node: 3, path: 'translation' } }, { sampler: 1, target: { node: 2, path: 'rotation' } }, { sampler: 2, target: { node: 1, path: 'weights' } }] }];
    d.images = [{ bufferView: b.view(PNG), mimeType: 'image/png' }];
    d.samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }];
    d.textures = [{ source: 0, sampler: 0 }];
    d.materials = [{ pbrMetallicRoughness: { baseColorFactor: [0.8, 0.5, 0.2, 1], metallicFactor: 0.25, roughnessFactor: 0.6, baseColorTexture: { index: 0, extensions: { KHR_texture_transform: { offset: [0, 0], scale: [1, 1], rotation: 0, texCoord: 0 } } } }, normalTexture: { index: 0, scale: 1 }, occlusionTexture: { index: 0, strength: 1 }, emissiveFactor: [0.1, 0.2, 0.3], emissiveTexture: { index: 0 }, extensions: { KHR_materials_emissive_strength: { emissiveStrength: 2 }, KHR_materials_ior: { ior: 1.5 }, KHR_materials_specular: { specularFactor: 0.5, specularColorFactor: [1, 1, 1], specularTexture: { index: 0 } } } }];
    primitive.material = 0;
    d.extensionsUsed = ['KHR_texture_transform', 'KHR_materials_emissive_strength', 'KHR_materials_ior', 'KHR_materials_specular'];
    d.extras = { name: 'embedded model', tags: ['PBR', 'skin', 'morph'], nested: { harmless: true } };
  }
  return b.finish();
}
function reject(change: (doc: Doc, bin: Uint8Array) => void, pattern: RegExp, rich = false): void {
  const f = fixture(rich); change(f.doc, f.bin); assert.throws(() => validateGlb(glb(f.doc, f.bin)), pattern);
}
function fixCrc(bytes: Uint8Array, start: number, end: number): void {
  let n = 0xffffffff;
  for (let i = start; i < end; i++) { n ^= bytes[i]!; for (let j = 0; j < 8; j++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; }
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(end, (n ^ 0xffffffff) >>> 0);
}
function imageFixture(image: Uint8Array, mimeType: string, copies = 1) {
  const f = fixture(), bin = new Uint8Array(((f.bin.length + 3) & ~3) + image.length), offset = (f.bin.length + 3) & ~3;
  bin.set(f.bin); bin.set(image, offset);
  f.doc.buffers[0].byteLength = bin.length;
  const view = f.doc.bufferViews.length;
  f.doc.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: image.length });
  f.doc.images = Array.from({ length: copies }, () => ({ bufferView: view, mimeType }));
  return glb(f.doc, bin);
}

// Valid baseline grayscale JPEG: a single zero-DC, EOB-only block encodes a
// uniform 128-valued pixel. Minimal DC/AC Huffman tables both use the code 0.
function jpeg(width = 1, height = 1): Uint8Array {
  const segment = (marker: number, data: number[]) => [255, marker, (data.length + 2) >>> 8, (data.length + 2) & 255, ...data];
  const counts = [1, ...Array<number>(15).fill(0)];
  return new Uint8Array([255, 216,
    ...segment(0xdb, [0, ...Array<number>(64).fill(1)]),
    ...segment(0xc0, [8, height >>> 8, height & 255, width >>> 8, width & 255, 1, 1, 0x11, 0]),
    ...segment(0xc4, [0, ...counts, 0, 0x10, ...counts, 0]),
    ...segment(0xda, [1, 1, 0, 0, 63, 0]), 0x3f, 255, 217]);
}

test('legal indexed triangle and realistic PBR/skin/morph/animation/PNG data are admitted', () => {
  assert.deepEqual(validateGlb(fixture().bytes), { nodeCount: 1, meshCount: 1, triangleEstimate: 1, imagePixels: 0, animations: 0 });
  const bytes = fixture(true).bytes;
  assert.deepEqual(validateGlb(bytes.buffer as ArrayBuffer), { nodeCount: 4, meshCount: 1, triangleEstimate: 1, imagePixels: 1, animations: 1 });
  const before = bytes.slice(); validateGlb(bytes); assert.deepEqual(bytes, before);
  // Honor the exact typed-array window, including Buffer and unaligned wrappers.
  const wrapped = new Uint8Array(bytes.length + 7); wrapped.set(bytes, 3);
  assert.deepEqual(validateGlb(wrapped.subarray(3, 3 + bytes.length)), validateGlb(bytes));
  assert.deepEqual(validateGlb(Buffer.from(bytes)), validateGlb(bytes));
});

test('header/chunks reject truncation, extra chunks, misalignment, wrong version and padding', () => {
  const source = fixture().bytes;
  for (let length = 0; length < source.length; length++) assert.throws(() => validateGlb(source.slice(0, length)), /GLB preflight/);
  const mutate = (at: number, n: number) => { const bytes = source.slice(); new DataView(bytes.buffer).setUint32(at, n, true); return bytes; };
  for (const bytes of [mutate(0, 0), mutate(4, 1), mutate(8, source.length + 4), mutate(12, 1), mutate(12, 0xfffffff0), mutate(16, 0x004e4942)]) assert.throws(() => validateGlb(bytes), /header|chunks/);
  const extra = new Uint8Array(source.length + 12); extra.set(source); const v = new DataView(extra.buffer); v.setUint32(8, extra.length, true); v.setUint32(source.length, 4, true); v.setUint32(source.length + 4, 0x12345678, true);
  assert.throws(() => validateGlb(extra), /exactly/);
  const f = fixture(); assert.throws(() => validateGlb(glb(f.doc, f.bin, 0)), /JSON/);
  assert.throws(() => validateGlb(glb(JSON.stringify(f.doc) + '\n', f.bin)), /padding/);
  const padding = source.slice(); padding[padding.length - 1] = 1; assert.throws(() => validateGlb(padding), /padding/);
  reject(d => d.buffers[0].byteLength -= 4, /padding/);
  reject(d => d.asset.version = '1.0', /glTF 2.0/);
  reject(d => d.asset.minVersion = '2.1', /glTF 2.0/);
});

test('fatal UTF-8, non-finite JSON, prototype keys and input kinds are rejected', () => {
  const bytes = fixture().bytes.slice(); bytes[21] = 0xff; assert.throws(() => validateGlb(bytes), /UTF-8/);
  const f = fixture();
  for (const key of ['__proto__', 'constructor', 'prototype', '\\u005f\\u005fproto__']) {
    const text = JSON.stringify(f.doc).replace('"asset":', `"extras":{"${key}":{}},"asset":`);
    assert.throws(() => validateGlb(glb(text, f.bin)), /prototype/);
  }
  assert.throws(() => validateGlb(glb(JSON.stringify(f.doc).replace('"asset":', '"extras":{"bad":1e999},"asset":'), f.bin)), /non-finite/);
  for (const input of [{}, null, new DataView(f.bytes.buffer), new Uint8Array(new SharedArrayBuffer(64))]) assert.throws(() => validateGlb(input as Uint8Array), /expected ArrayBuffer/);
  assert.throws(() => validateGlb(new Uint8Array(L.bytes + 1)), /64 MiB/);
  let getterCalls = 0;
  const guarded = f.bytes.slice();
  for (const key of ['buffer', 'byteOffset', 'byteLength']) Object.defineProperty(guarded, key, { get: () => { getterCalls++; throw new Error('getter ran'); } });
  validateGlb(guarded); assert.equal(getterCalls, 0);
  const hostile = Object.defineProperty({}, 'asset', { get: () => { getterCalls++; throw new Error('getter ran'); } });
  assert.throws(() => validateGlb(hostile as Uint8Array), /input/); assert.equal(getterCalls, 0);
});

test('URI fields and external URLs fail in used/unused resources, extras and extensions', () => {
  for (const uri of ['https://example.invalid/a.bin', '//example.invalid/x', 'file:///a', 'data:application/octet-stream;base64,AA==', 'local.bin', 'blob:x', 'javascript:alert(1)', '']) {
    reject(d => d.buffers[0].uri = uri, /URI\/URL/);
    reject(d => d.images[0].uri = uri, /URI\/URL/, true);
    reject(d => d.extras = { nested: [{ uri }] }, /URI\/URL/);
    reject(d => d.textures[0].URI = uri, /URI\/URL/, true);
  }
  reject(d => d.extras = { harmlessLooking: 'https://example.invalid/x' }, /external URLs/);
  reject(d => d.buffers.push({ byteLength: 4, uri: 'other.bin' }), /URI\/URL/);
  reject(d => d.images.push({ uri: 'unused.png' }), /URI\/URL/, true);
  reject(d => d.materials[0].extensions.KHR_materials_specular.payloadURL = 'secret', /URI\/URL/, true);
});

test('known typed optional/required extensions pass; decoders, unknown fields and locations fail', () => {
  const f = fixture(true); f.doc.extensionsRequired = ['KHR_texture_transform', 'KHR_materials_ior']; validateGlb(glb(f.doc, f.bin));
  for (const name of ['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_meshopt_compression', 'KHR_texture_basisu']) {
    reject(d => { d.extensionsUsed = [name]; d.extensionsRequired = [name]; }, /unavailable local decoder/);
    reject(d => d.meshes[0].primitives[0].extensions = { [name]: {} }, /unavailable local decoder/);
  }
  reject(d => d.extensionsUsed = ['VENDOR_unknown'], /unsupported extension/);
  reject(d => d.extensionsUsed = ['EXT_texture_webp'], /unsupported extension/);
});

test('material and texture extension payloads are typed and cannot hide unsupported locations', () => {
  const f = fixture(); f.doc.extensionsUsed = ['KHR_materials_unlit']; f.doc.materials = [{ extensions: { KHR_materials_unlit: {} } }]; f.doc.meshes[0].primitives[0].material = 0; validateGlb(glb(f.doc, f.bin));
  reject(d => d.materials[0].extensions.KHR_materials_ior.ior = '1.5', /finite number/, true);
  reject(d => d.materials[0].extensions.KHR_materials_specular.unknown = {}, /unknown material/, true);
  reject(d => d.materials[0].extensions.KHR_materials_specular.toString = 1, /unknown material/, true);
  reject(d => d.materials[0].pbrMetallicRoughness.baseColorTexture.extensions.KHR_texture_transform.scale = [1, 2, 3], /array budget/, true);
  reject(d => { d.extensionsUsed = ['KHR_materials_unlit']; d.nodes[0].extensions = { KHR_materials_unlit: {} }; }, /unsupported location/);
  reject(d => { d.extensionsRequired = ['KHR_materials_unlit']; }, /listed in extensionsUsed/);
  reject(d => d.materials[0].pbrMetallicRoughness.baseColorTexture.index = 99, /integer bound/, true);
  reject(d => d.textures[0].source = 99, /integer bound/, true);
});

test('dense accessor ranges, indices, finite data, declared bounds and attribute formats are checked', () => {
  for (const change of [
    (d: Doc) => d.bufferViews[0].byteLength = 35,
    (d: Doc) => d.bufferViews[0].byteOffset = 1,
    (d: Doc) => d.bufferViews[0].buffer = 1,
    (d: Doc) => d.accessors[0].byteOffset = 2,
    (d: Doc) => d.accessors[0].count = 4,
    (d: Doc) => d.accessors[0].componentType = 5124,
    (d: Doc) => d.accessors[0].max = [0, 0, 0],
    (d: Doc) => d.accessors[1].count = 2,
    (d: Doc) => d.accessors[0].normalized = true,
    (d: Doc) => d.accessors[2].normalized = true,
    (d: Doc) => d.bufferViews[2].byteStride = 4,
    (d: Doc) => d.meshes[0].primitives[0].mode = 1,
  ]) reject(change, /GLB preflight/);
  for (const value of [NaN, Infinity, -Infinity, L.magnitude + 1, -(L.magnitude + 1)]) reject((_d, bin) => new DataView(bin.buffer).setFloat32(0, value, true), /finite number/);
  reject((d, bin) => new DataView(bin.buffer).setUint16(d.bufferViews[2].byteOffset, 3, true), /index value/);
  reject((d, bin) => new DataView(bin.buffer).setUint16(d.bufferViews[2].byteOffset, 65535, true), /index value/);
  reject(d => delete d.accessors[0].min, /requires min/);
});

test('interleaved geometry and unindexed/strip/fan/point/line modes are supported', () => {
  const f = fixture(), extra = new Uint8Array(72), v = new DataView(extra.buffer);
  [[0, 0, 0], [1, 0, 0], [0, 1, 0]].forEach((row, i) => { row.forEach((n, k) => v.setFloat32(i * 24 + k * 4, n, true)); v.setFloat32(i * 24 + 20, 1, true); });
  f.doc.bufferViews[0] = { buffer: 0, byteOffset: 0, byteLength: 72, byteStride: 24 };
  f.doc.bufferViews[1] = { buffer: 0, byteOffset: 0, byteLength: 72, byteStride: 24 };
  f.doc.accessors[1].byteOffset = 12;
  f.doc.bufferViews[2].byteOffset = 72;
  const bin = new Uint8Array(78); bin.set(extra); new DataView(bin.buffer).setUint16(74, 1, true); new DataView(bin.buffer).setUint16(76, 2, true); f.doc.buffers[0].byteLength = bin.length;
  assert.equal(validateGlb(glb(f.doc, bin)).triangleEstimate, 1);
  for (const mode of [0, 2, 3, 4, 5, 6]) { const f = fixture(); delete f.doc.meshes[0].primitives[0].indices; f.doc.meshes[0].primitives[0].mode = mode; assert.equal(validateGlb(glb(f.doc, f.bin)).triangleEstimate, mode >= 4 ? 1 : 0); }
});

function sparseFixture() {
  const b = builder(), d = b.doc;
  const indices = b.view(new Uint8Array([1, 2]));
  const valueAccessor = b.accessor([1, 0, 0, 0, 1, 0], 'VEC3');
  const values = d.accessors[valueAccessor].bufferView;
  d.accessors = [{ type: 'VEC3', componentType: 5126, count: 3, min: [0, 0, 0], max: [1, 1, 0], sparse: { count: 2, indices: { bufferView: indices, componentType: 5121 }, values: { bufferView: values } } }];
  d.meshes = [{ primitives: [{ attributes: { POSITION: 0 } }] }]; d.nodes = [{ mesh: 0 }];
  return b.finish();
}
test('sparse accessors support zero bases and enforce count, increasing indices and both ranges', () => {
  const f = sparseFixture(); assert.equal(validateGlb(f.bytes).triangleEstimate, 1);
  for (const change of [
    (d: Doc, _b: Uint8Array) => d.accessors[0].sparse.count = 4,
    (d: Doc, _b: Uint8Array) => d.accessors[0].sparse.values.byteOffset = 4,
    (d: Doc, _b: Uint8Array) => d.accessors[0].sparse.indices.byteOffset = 2,
    (d: Doc, _b: Uint8Array) => d.bufferViews[0].byteStride = 4,
    (d: Doc, _b: Uint8Array) => d.bufferViews[1].target = 34962,
    (_d: Doc, b: Uint8Array) => b[0] = 3,
    (_d: Doc, b: Uint8Array) => b[1] = 1,
    (_d: Doc, b: Uint8Array) => b[1] = 0,
  ]) { const f = sparseFixture(); change(f.doc, f.bin); assert.throws(() => validateGlb(glb(f.doc, f.bin)), /sparse/); }
  const zero = fixture(); delete zero.doc.accessors[1].bufferView; validateGlb(glb(zero.doc, zero.bin));
});

test('sparse geometry indices are read after substitution, and matrix column padding permits omitted tail bytes', () => {
  const f = fixture();
  // Replace index 2 using a new sparse index/value buffer pair.
  const offset = (f.bin.length + 3) & ~3, bin = new Uint8Array(offset + 6); bin.set(f.bin); bin[offset] = 2; new DataView(bin.buffer).setUint16(offset + 4, 2, true);
  f.doc.buffers[0].byteLength = bin.length;
  const indexView = f.doc.bufferViews.length;
  f.doc.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: 1 }, { buffer: 0, byteOffset: offset + 4, byteLength: 2 });
  f.doc.accessors[2].sparse = { count: 1, indices: { bufferView: indexView, componentType: 5121 }, values: { bufferView: indexView + 1 } };
  validateGlb(glb(f.doc, bin));
  new DataView(bin.buffer).setUint16(offset + 4, 3, true); assert.throws(() => validateGlb(glb(f.doc, bin)), /index value/);
  const m = fixture(), start = (m.bin.length + 3) & ~3, matrixBin = new Uint8Array(start + 11); matrixBin.set(m.bin);
  // UBYTE MAT3 columns start at 0,4,8; final 4-byte column padding is omitted.
  matrixBin.set([1, 2, 3, 0, 4, 5, 6, 0, 7, 8, 9], start);
  m.doc.buffers[0].byteLength = matrixBin.length;
  const view = m.doc.bufferViews.length; m.doc.bufferViews.push({ buffer: 0, byteOffset: start, byteLength: 11 });
  m.doc.accessors.push({ bufferView: view, type: 'MAT3', componentType: 5121, count: 1, min: [1, 2, 3, 4, 5, 6, 7, 8, 9], max: [1, 2, 3, 4, 5, 6, 7, 8, 9] });
  validateGlb(glb(m.doc, matrixBin));
  m.doc.bufferViews[view].byteLength = 10; assert.throws(() => validateGlb(glb(m.doc, matrixBin)), /accessor range/);
});

test('node graph cycles, duplicate parents, deep hierarchies and accumulated transforms fail', () => {
  reject(d => d.nodes[0].children = [0], /cycle/);
  reject(d => { d.nodes = [{ mesh: 0, children: [1] }, { children: [0] }]; }, /cycle/);
  reject(d => { d.nodes = [{ children: [1, 1] }, { mesh: 0 }]; }, /parents/);
  reject(d => { d.nodes = [{ children: [2] }, { children: [2] }, { mesh: 0 }]; }, /parents/);
  reject(d => d.nodes[0].translation = [L.magnitude + 1, 0, 0], /finite number/);
  reject(d => { d.nodes[0].scale = [L.magnitude, L.magnitude, L.magnitude]; d.nodes[0].translation = [1, 0, 0]; }, /worldPosition/);
  reject(d => d.nodes[0].rotation = [0, 0, 0, 0], /quaternion/);
  reject(d => { d.nodes[0].matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; d.nodes[0].scale = [1, 1, 1]; }, /mutually exclusive/);
  reject(d => { d.nodes = Array.from({ length: L.nodeDepth + 1 }, (_, i) => i === L.nodeDepth ? { mesh: 0 } : { children: [i + 1] }); }, /depth budget/);
  reject(d => { d.nodes = [{ scale: [1000, 1000, 1000], children: [1] }, { scale: [1000, 1000, 1000], children: [2] }, { scale: [1000, 1000, 1000], mesh: 0 }]; }, /worldTransform/);
  reject(d => d.nodes[0].children = [99], /integer bound/);
  reject(d => d.scenes[0].nodes = [0, 0], /unique hierarchy roots/);
});

test('skin, morph and animation references/counts/interpolation are checked', () => {
  reject(d => d.skins[0].joints = [2, 2], /duplicate skin/, true);
  reject(d => d.skins[0].joints = [2, 99], /integer bound/, true);
  reject(d => d.accessors[d.skins[0].inverseBindMatrices].count = 1, /matrix count/, true);
  reject(d => delete d.meshes[0].primitives[0].attributes.JOINTS_0, /matching JOINTS|require JOINTS/, true);
  reject((d, bin) => { const a = d.accessors[d.meshes[0].primitives[0].attributes.JOINTS_0]; bin[d.bufferViews[a.bufferView].byteOffset] = 2; }, /JOINTS value/, true);
  reject(d => d.meshes[0].weights = [0, 1], /array budget/, true);
  reject(d => d.meshes[0].primitives[0].targets[0].POSITION = 999, /integer bound/, true);
  reject(d => d.animations[0].samplers[0].interpolation = 'EXEC', /unsupported value/, true);
  reject(d => d.animations[0].samplers[0].output = d.animations[0].samplers[2].output, /invalid accessor format/, true);
  reject(d => d.animations[0].channels.push(d.animations[0].channels[0]), /duplicate animation target/, true);
  reject(d => d.animations[0].channels[2].target.node = 0, /weights animation/, true);
  reject((d, bin) => { const a = d.accessors[d.animations[0].samplers[0].input]; new DataView(bin.buffer).setFloat32(d.bufferViews[a.bufferView].byteOffset + 4, 0, true); a.max = [0]; }, /strictly increasing/, true);
  reject((d, bin) => { const a = d.accessors[d.animations[0].samplers[0].output]; new DataView(bin.buffer).setFloat32(d.bufferViews[a.bufferView].byteOffset, Infinity, true); }, /finite number/, true);
  reject((d, bin) => { const a = d.accessors[d.animations[0].samplers[1].output]; new DataView(bin.buffer).setFloat32(d.bufferViews[a.bufferView].byteOffset + 12, 20, true); }, /unit quaternions/, true);
});

test('cubic-spline translation/morph animation accepts tangents and rejects missing output triplets', () => {
  const f = fixture(true), offset = (f.bin.length + 3) & ~3;
  const values = [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0];
  const bin = new Uint8Array(offset + values.length * 4), v = new DataView(bin.buffer); bin.set(f.bin);
  values.forEach((n, i) => v.setFloat32(offset + i * 4, n, true));
  const view = f.doc.bufferViews.length; f.doc.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: values.length * 4 }); f.doc.buffers[0].byteLength = bin.length;
  const output = f.doc.accessors.length; f.doc.accessors.push({ bufferView: view, componentType: 5126, type: 'VEC3', count: 6 });
  f.doc.animations[0].samplers[0].output = output; f.doc.animations[0].samplers[0].interpolation = 'CUBICSPLINE';
  validateGlb(glb(f.doc, bin));
  f.doc.accessors[output].count = 4; assert.throws(() => validateGlb(glb(f.doc, bin)), /output count/);
  // Weight animation with two targets requires keys * 3 * targets SCALARs.
  const b = builder(), d = b.doc;
  const position = b.accessor([0, 0, 0, 1, 0, 0, 0, 1, 0], 'VEC3', 5126, { min: [0, 0, 0], max: [1, 1, 0] });
  const morph = b.accessor([0, 0, 0, 0, 0, 0, 0, 0, 1], 'VEC3', 5126, { min: [0, 0, 0], max: [0, 0, 1] });
  d.meshes = [{ primitives: [{ attributes: { POSITION: position }, targets: [{ POSITION: morph }, { POSITION: morph }] }], weights: [0, 0] }]; d.nodes = [{ mesh: 0 }];
  const times = b.accessor([0, 1], 'SCALAR', 5126, { min: [0], max: [1] }), weights = b.accessor([0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0], 'SCALAR');
  d.animations = [{ samplers: [{ input: times, output: weights, interpolation: 'CUBICSPLINE' }], channels: [{ sampler: 0, target: { node: 0, path: 'weights' } }] }]; validateGlb(b.finish().bytes);
});

test('PNG dimensions/CRC and aggregate image/texture pixels are bounded before decode', () => {
  assert.equal(validateGlb(imageFixture(PNG, 'image/png')).imagePixels, 1);
  const changed = (w: number, h: number) => { const bytes = PNG.slice(), v = new DataView(bytes.buffer); v.setUint32(16, w); v.setUint32(20, h); fixCrc(bytes, 12, 29); return bytes; };
  for (const [w, h] of [[0, 1], [8193, 1], [1, 8193], [8192, 8192]]) assert.throws(() => validateGlb(imageFixture(changed(w!, h!), 'image/png')), /bound|budget/);
  assert.throws(() => validateGlb(imageFixture(changed(4000, 4001), 'image/png', 2)), /aggregate image pixels/);
  const f = fixture(true); f.doc.textures = Array.from({ length: 3 }, () => ({ source: 0 }));
  const iv = f.doc.bufferViews[f.doc.images[0].bufferView], big = changed(4000, 4000); f.bin.set(big, iv.byteOffset);
  assert.throws(() => validateGlb(glb(f.doc, f.bin)), /aggregate texture pixels/);
  const corrupt = PNG.slice(); corrupt[29] = corrupt[29]! ^ 1; assert.throws(() => validateGlb(imageFixture(corrupt, 'image/png')), /CRC/);
  assert.throws(() => validateGlb(imageFixture(PNG.slice(0, -1), 'image/png')), /PNG/);
  assert.throws(() => validateGlb(imageFixture(PNG, 'image/jpeg')), /JPEG signature/);
  assert.throws(() => validateGlb(imageFixture(PNG, 'image/webp')), /only embedded PNG\/JPEG/);
  // A second IHDR or APNG control chunk cannot alter the budgeted image.
  for (const marker of [0x49484452, 0x6163544c, 0x6663544c, 0x66644154]) {
    const image = PNG.slice(); new DataView(image.buffer).setUint32(37, marker); fixCrc(image, 37, 52);
    assert.throws(() => validateGlb(imageFixture(image, 'image/png')), /duplicate PNG|animated PNG/);
  }
});

test('JPEG frames/segments/EOI are checked and dimension-changing/trailing data are refused', () => {
  assert.equal(validateGlb(imageFixture(jpeg(), 'image/jpeg')).imagePixels, 1);
  assert.equal(validateGlb(imageFixture(jpeg(8192, 1), 'image/jpeg')).imagePixels, 8192);
  for (const [w, h] of [[0, 1], [8193, 1], [1, 8193], [8192, 8192]]) assert.throws(() => validateGlb(imageFixture(jpeg(w, h), 'image/jpeg')), /bound|budget/);
  const source = jpeg();
  for (let length = 0; length < source.length; length++) assert.throws(() => validateGlb(imageFixture(source.slice(0, length), 'image/jpeg')), /GLB preflight/);
  const trailing = new Uint8Array(source.length + 1); trailing.set(source); assert.throws(() => validateGlb(imageFixture(trailing, 'image/jpeg')), /trailing/);
  const dnl = new Uint8Array(source.length + 6); dnl.set(source.subarray(0, -2)); dnl.set([255, 220, 0, 4, 0, 1, 255, 217], source.length - 2); assert.throws(() => validateGlb(imageFixture(dnl, 'image/jpeg')), /DNL/);
  const doubled = new Uint8Array(source.length + 13); doubled.set(source.subarray(0, 84)); doubled.set(source.subarray(71, 84), 84); doubled.set(source.subarray(84), 97); assert.throws(() => validateGlb(imageFixture(doubled, 'image/jpeg')), /frame/);
  const large = new Uint8Array(source.length + 4 * 65537); large.set(source.subarray(0, 2));
  for (let i = 0; i < 4; i++) large.set([255, 239, 255, 255], 2 + i * 65537);
  large.set(source.subarray(2), 2 + 4 * 65537);
  assert.throws(() => validateGlb(imageFixture(large, 'image/jpeg', L.images)), /aggregate encoded image bytes/);
});

test('JSON, arrays, nodes, meshes, accessors, primitives and instanced draw budgets fail', () => {
  reject(d => d.extras = { x: Array(L.arrayLength + 1).fill(0) }, /array budget/);
  reject(d => { let v: Doc = d; for (let i = 0; i < L.jsonDepth + 1; i++) { v.extra = {}; v = v.extra; } }, /depth budget/);
  reject(d => d.nodes = Array(L.nodes + 1).fill({}), /nodes.*array budget/);
  reject(d => d.meshes = Array(L.meshes + 1).fill(d.meshes[0]), /meshes.*array budget/);
  reject(d => d.accessors = Array(L.accessors + 1).fill(d.accessors[2]), /accessors.*array budget/);
  reject(d => d.meshes[0].primitives = Array(L.primitives + 1).fill(d.meshes[0].primitives[0]), /array budget/);
  reject(d => { d.meshes[0].primitives = Array(65).fill(d.meshes[0].primitives[0]); d.nodes = Array(64).fill({ mesh: 0 }); }, /instance draw calls/);
  reject(d => d.accessors[0].count = L.accessorElements + 1, /integer bound/);
  reject(d => { d.accessors = Array(17).fill({ type: 'SCALAR', componentType: 5126, count: L.accessorElements }); }, /accessor components/);
  reject(d => { d.bufferViews[0].byteStride = 252; d.accessors = [{ type: 'SCALAR', componentType: 5126, count: L.accessorElements, bufferView: 0 }]; }, /accessor allocation/);
  reject(d => d.images = Array(L.images + 1).fill(d.images[0]), /images.*array budget/, true);
  reject(d => d.animations = Array(L.animations + 1).fill(d.animations[0]), /animations.*array budget/, true);
  reject(d => { d.extras = Array(16).fill(Array(16_000).fill(0)); }, /tree.*budget/);
  const f = fixture(); assert.throws(() => validateGlb(glb(' '.repeat(L.jsonBytes) + JSON.stringify(f.doc), f.bin)), /JSON byte budget/);
  // Large leading JSON whitespace must remain linear-time and does not count
  // as forbidden trailing GLB alignment padding.
  validateGlb(glb(' '.repeat(100_000) + JSON.stringify(f.doc), f.bin));
});

test('instanced triangles, point vertices and aggregate animation channels have independent budgets', () => {
  const b = builder(), d = b.doc;
  const position = b.accessor([0, 0, 0, 1, 0, 0, 0, 1, 0], 'VEC3', 5126, { min: [0, 0, 0], max: [1, 1, 0] });
  const normal = b.accessor([0, 0, 1, 0, 0, 1, 0, 0, 1], 'VEC3');
  const indices = b.accessor(Array.from({ length: 6000 }, (_, i) => i % 3), 'SCALAR', 5123);
  d.meshes = [{ primitives: [{ attributes: { POSITION: position, NORMAL: normal }, indices }] }];
  d.nodes = Array(1001).fill({ mesh: 0 }); assert.throws(() => validateGlb(b.finish().bytes), /instance triangles/);
  const f = fixture();
  f.doc.accessors = [{ componentType: 5126, type: 'VEC3', count: L.accessorElements, min: [0, 0, 0], max: [0, 0, 0] }, { componentType: 5126, type: 'VEC3', count: L.accessorElements }];
  f.doc.meshes[0].primitives = [{ attributes: { POSITION: 0, NORMAL: 1 }, mode: 0 }]; f.doc.nodes = Array(9).fill({ mesh: 0 });
  assert.throws(() => validateGlb(glb(f.doc, f.bin)), /instance submitted vertices/);
  reject(d => {
    const clip = d.animations[0]; clip.channels = Array(1025).fill({ sampler: 0, target: { path: 'translation' } });
    d.animations = Array(4).fill(clip);
  }, /animation channels.*resource budget/, true);
});

test('pipeline-shaped meshes/extras and instanced estimates remain supported', () => {
  const f = fixture();
  f.doc.meshes = Array.from({ length: 3 }, (_, i) => ({ ...f.doc.meshes[0], name: 'SM_machine_' + i }));
  f.doc.nodes = [{ children: [1, 2, 3, 4] }, { mesh: 0, name: 'SM_part', extras: { role: 'render' } }, { mesh: 1, translation: [3, 0, 0] }, { mesh: 2, translation: [0, 3, 0] }, { mesh: 0, translation: [3, 3, 0] }];
  assert.deepEqual(validateGlb(glb(f.doc, f.bin)), { nodeCount: 5, meshCount: 3, triangleEstimate: 4, imagePixels: 0, animations: 0 });
  f.doc.cameras = [{ type: 'perspective', perspective: { yfov: 0.7, znear: 0.1, zfar: 100, aspectRatio: 1.7 } }]; f.doc.nodes[0].camera = 0; validateGlb(glb(f.doc, f.bin));
  f.doc.cameras[0].perspective.znear = 100; assert.throws(() => validateGlb(glb(f.doc, f.bin)), /zfar/);
});

test('the preflight source has no executable asset or network/native integration', () => {
  const source = readFileSync('apps/desktop/src/glb-preflight.ts', 'utf8');
  assert.doesNotMatch(source, /^import\s|\bfetch\s*\(|\beval\s*\(|new\s+Function\s*\(|\b(?:document|window|process)\./m);
  assert(Object.isFrozen(L));
});
