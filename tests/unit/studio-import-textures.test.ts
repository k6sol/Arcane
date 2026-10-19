import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';
import { createStudioImportManifestAuthority, type HostGeneratedStudioImport } from '../../packages/asset-pipeline/src/studio-import-manifest.js';
import { decodeStudioImportPayload, StudioImportPayloadError } from '../../packages/asset-pipeline/src/studio-import-payload.js';
import { createStudioImportTransfer } from '../../packages/asset-pipeline/src/studio-import-transfer.js';
import { decodeMaterialPng, materialPngPixels } from '../../packages/asset-pipeline/src/material-png.js';
import { decodeEmbeddedStudioImages, materialStudioTexturePixels, StudioTextureError } from '../../packages/asset-pipeline/src/studio-import-textures.js';
import { adaptCompletedStudioImport } from '../../apps/daemon/src/asset-import-adapter.js';
import type { AssetManifest } from '../../packages/asset-pipeline/src/types.js';

type Doc = Record<string, any>;
const sha = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');
const JOB = '11111111-1111-4111-8111-111111111111', H = sha('original-texture-test');
function png(pixels: readonly number[], width = 2, height = 2): Buffer {
  const chunk = (name: string, bytes: Buffer) => {
    const kind = Buffer.from(name), crcInput = Buffer.concat([kind, bytes]); let crc = 0xffffffff;
    for (const byte of crcInput) { crc ^= byte; for (let j = 0; j < 8; j++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1; }
    const out = Buffer.alloc(bytes.length + 12); out.writeUInt32BE(bytes.length); kind.copy(out, 4); bytes.copy(out, 8); out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, bytes.length + 8); return out;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const rows = Array.from({ length: height }, (_, i) => Buffer.from([0, ...pixels.slice(i * width * 4, (i + 1) * width * 4)]));
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
function pack(doc: Doc, bin: Buffer): Buffer {
  const text = Buffer.from(JSON.stringify(doc)), n = Math.ceil(text.length / 4) * 4, m = Math.ceil(bin.length / 4) * 4;
  const result = Buffer.alloc(28 + n + m); result.writeUInt32LE(0x46546c67); result.writeUInt32LE(2, 4); result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(n, 12); result.writeUInt32LE(0x4e4f534a, 16); result.fill(32, 20, 20 + n); text.copy(result, 20);
  result.writeUInt32LE(m, 20 + n); result.writeUInt32LE(0x004e4942, 24 + n); bin.copy(result, 28 + n); return result;
}
function fixture() {
  const doc: Doc = { asset: { version: '2.0', generator: 'Khronos glTF Blender I/O v4.5.48' }, buffers: [{ byteLength: 0 }],
    bufferViews: [], accessors: [], meshes: [], nodes: [], scene: 0, scenes: [{ nodes: [0, 1, 2] }] };
  let bin = Buffer.alloc(0);
  const append = (raw: Buffer) => { const at = Math.ceil(bin.length / 4) * 4; bin = Buffer.concat([bin, Buffer.alloc(at - bin.length), raw]); const index = doc.bufferViews.length; doc.bufferViews.push({ buffer: 0, byteOffset: at, byteLength: raw.length }); return index; };
  const accessor = (values: number[], type: string) => { const raw = Buffer.alloc(values.length * 4); values.forEach((n, i) => raw.writeFloatLE(n, i * 4)); const view = append(raw), i = doc.accessors.length, size = type === 'VEC3' ? 3 : type === 'VEC2' ? 2 : 1;
    const a: Doc = { bufferView: view, componentType: 5126, type, count: values.length / size };
    if (type === 'VEC3') { a.min = [0, 1, 2].map(c => Math.min(...values.filter((_, j) => j % 3 === c))); a.max = [0, 1, 2].map(c => Math.max(...values.filter((_, j) => j % 3 === c))); }
    doc.accessors.push(a); return i; };
  const position = accessor([0,0,0,1,0,0,0,1,0,0,0,1], 'VEC3'), normal = accessor([0,0,1,0,0,1,0,0,1,0,0,1], 'VEC3'), uv = accessor([0,0,1,0,1,1,0,1], 'VEC2');
  const indicesView = append(Buffer.from([0,2,1,0,1,3,0,3,2,1,2,3])), indices = doc.accessors.length;
  doc.accessors.push({ bufferView: indicesView, componentType: 5121, type: 'SCALAR', count: 12 });
  const albedo = [255,0,0,0, 0,255,0,255, 0,0,255,128, 128,128,128,255];
  const normals = [64,192,255,255, 160,80,240,255, 128,128,255,255, 200,150,230,255];
  const packed = [17,20,220,255, 33,100,160,255, 55,180,80,255, 77,255,0,255];
  doc.images = [albedo, normals, packed].map(p => ({ bufferView: append(png(p)), mimeType: 'image/png' }));
  doc.samplers = [{ wrapS: 10497, wrapT: 10497, magFilter: 9729, minFilter: 9987 }];
  doc.textures = [0,1,2].map(source => ({ source, sampler: 0 }));
  doc.materials = [{ doubleSided: true, pbrMetallicRoughness: { baseColorFactor: [0.5,0.25,0.75,1], metallicFactor: 0.4, roughnessFactor: 0.6,
    baseColorTexture: { index: 0 }, metallicRoughnessTexture: { index: 2 } }, normalTexture: { index: 1, scale: 1 } }];
  const objects: HostGeneratedStudioImport['models'][number]['objects'] = [];
  const renderId = 'arcane_' + sha('render'), secondId = 'arcane_' + sha('second');
  for (const [i, role, id] of [[0,'render',renderId], [1,'render',secondId], [2,'collision','arcane_' + sha('collision')]] as const) {
    const collisionFor = role === 'collision' ? [renderId, secondId].sort() : [];
    doc.meshes.push({ primitives: [{ attributes: { POSITION: position, NORMAL: normal, TEXCOORD_0: uv }, indices, ...(role === 'render' ? { material: 0 } : {}) }] });
    doc.nodes.push({ mesh: i, name: role + i, extras: { arcane_identity_scheme: 'arcane-semantic-v1', arcane_source_object_id: id, arcane_role: role,
      arcane_source_key: role + i, arcane_pivot: [0,0,0], arcane_collision_for: JSON.stringify(collisionFor) } });
    objects.push({ sourceObjectId: id, nodeIndex: i, role, pivot: [0,0,0], collisionFor });
  }
  const generated = (): HostGeneratedStudioImport => { doc.buffers[0].byteLength = bin.length; const bytes = pack(doc, bin); return {
    schemaVersion: 1, projectId: H, assetId: 'arcane_' + H, revisionId: JOB, sourceSha256: H,
    producer: { blenderVersion: '4.5.3 LTS', exporterVersion: 'Khronos glTF Blender IO v4.5.48' },
    target: { sessionId: 'offline-texture', placeId: 0, universeId: 0, root: 'Workspace', parentRef: 'parent', creator: { kind: 'user', id: '1' } },
    placement: { mode: 'bottom-centre' }, studsPerMeter: 1 / .28,
    files: [{ fileId: 'export', contentType: 'model/gltf-binary', sha256: sha(bytes), bytes }], models: [{ fileId: 'export', resources: [], objects }], anchors: [], baseline: null,
  }; };
  return { doc, generated, albedo, normals, packed };
}
async function prepare(generated: HostGeneratedStudioImport) {
  const authority = createStudioImportManifestAuthority({ loadGeneratedFiles: async () => generated });
  try { return authority.prepare(await authority.admit(generated.revisionId)); } finally { authority.close(); }
}
async function decode(generated: HostGeneratedStudioImport) { const prepared = await prepare(generated); const files = new Map(generated.files.map(f => [f.fileId, f.bytes])); return { prepared, payload: decodeStudioImportPayload(prepared, files), files }; }

test('embedded PNG maps retain source identity, UV0, normal orientation and exact packed channel factors', async () => {
  const f = fixture(), g = f.generated(), { prepared, payload } = await decode(g);
  assert.equal(payload.textures!.length, 4, 'shared material maps are transported once');
  const maps = Object.fromEntries(payload.textures!.map(t => [t.semantic, t]));
  assert.deepEqual([...maps.NormalMap!.bytes], f.normals, 'OpenGL normal RGB does not get gamma conversion or green flip');
  assert.deepEqual([...maps.RoughnessMap!.bytes], [12,12,12,255,60,60,60,255,108,108,108,255,153,153,153,255]);
  assert.deepEqual([...maps.MetalnessMap!.bytes], [88,88,88,255,64,64,64,255,32,32,32,255,0,0,0,255]);
  assert.deepEqual([...maps.ColorMap!.bytes], [188,0,0,255,0,137,0,255,0,0,225,255,92,66,112,255]);
  assert.equal(maps.ColorMap!.orientation, 'top-left'); assert.equal(maps.NormalMap!.normalConvention, 'OpenGL');
  assert.equal(maps.RoughnessMap!.sourceSha256, maps.MetalnessMap!.sourceSha256);
  for (const entry of payload.objects.filter(o => o.object.role === 'render')) assert.deepEqual([...new Float32Array(entry.primitives[0]!.attributes.TEXCOORD_0!.bytes.buffer)], [0,0,1,0,1,1,0,1]);
  const transfer = createStudioImportTransfer(prepared, payload), packets = transfer.packets.map(p => JSON.parse(p.json));
  assert.equal(packets.filter(p => p.kind === 'texture').length, 4); assert.equal(packets[0].textureCount, 4);
  assert.ok(transfer.packets.every(p => p.byteLength <= 256 * 1024));
  for (const texture of packets.filter(p => p.kind === 'texture')) {
    const raw = Buffer.concat(packets.filter(p => p.kind === 'chunk' && p.streamId === texture.texture.stream.streamId).map(p => Buffer.from(p.data, 'base64')));
    assert.equal(sha(raw), texture.texture.sha256); assert.deepEqual(raw, Buffer.from(maps[texture.texture.semantic]!.bytes));
  }
  const before = createStudioImportTransfer(prepared, payload);
  for (const map of payload.textures!) map.bytes.fill(0);
  assert.deepEqual(createStudioImportTransfer(prepared, payload), before, 'mutable convenience pixels never change sealed transport');
  if (process.env.ARCANE_TEXTURE_FIXTURE_OUTPUT) writeFileSync(process.env.ARCANE_TEXTURE_FIXTURE_OUTPUT, JSON.stringify({ expected: { payloadDigest: before.payloadDigest, manifestDigest: prepared.manifest.digest, digest: before.digest }, packets: before.packets.map(p => p.json), maps: Object.fromEntries(payload.textures!.map(t => [t.semantic, { width: t.width, height: t.height, sha256: t.sha256 }])) }));
});

for (const [name, mutate, code] of [
  ['nearest sampler', (d: Doc) => { d.samplers[0].magFilter = 9728; }, 'UNSUPPORTED_TEXTURE'],
  ['normal scale', (d: Doc) => { d.materials[0].normalTexture.scale = 0.5; }, 'UNSUPPORTED_TEXTURE'],
  ['missing UV0', (d: Doc) => { delete d.meshes[0].primitives[0].attributes.TEXCOORD_0; }, 'UNSUPPORTED_TEXTURE'],
] as const) test('texture delivery refuses ' + name + ' before returning a payload', async () => {
  const f = fixture(); mutate(f.doc); const g = f.generated(), p = await prepare(g);
  assert.throws(() => decodeStudioImportPayload(p, new Map(g.files.map(f => [f.fileId, f.bytes]))), e => e instanceof StudioImportPayloadError && e.code === code);
});

test('pixel allocations, chunk envelopes and aggregate textures obey tightened budgets', async () => {
  const f = fixture(), g = f.generated(), p = await prepare(g), files = new Map(g.files.map(f => [f.fileId, f.bytes]));
  assert.throws(() => decodeStudioImportPayload(p, files, { binaryBytes: 63 }), e => e instanceof StudioImportPayloadError && e.code === 'BUDGET');
  const payload = decodeStudioImportPayload(p, files, { chunkBytes: 5 }), transfer = createStudioImportTransfer(p, payload);
  assert.ok(payload.textures!.every(t => t.chunks.length > 1)); assert.ok(transfer.packets.every(p => p.byteLength <= 256 * 1024));
});

test('all unique source pixels and converted map bytes are preflighted before PNG inflate or map conversion', async () => {
  const f = fixture(), generated = f.generated(), prepared = await prepare(generated);
  const bytes = Buffer.from(generated.files[0]!.bytes), jsonLength = bytes.readUInt32LE(12), bin = bytes.subarray(28 + jsonLength);
  const oversized = Buffer.from(bin);
  oversized.writeUInt32BE(1025, f.doc.bufferViews[f.doc.images[0].bufferView].byteOffset + 16);
  assert.throws(() => decodeEmbeddedStudioImages(f.doc, oversized, prepared.manifest, 'export'),
    e => e instanceof StudioTextureError && e.code === 'BUDGET' && /1024 pixels per axis/.test(e.message));
  assert.throws(() => decodeEmbeddedStudioImages(f.doc, bin, prepared.manifest, 'export', 47),
    e => e instanceof StudioTextureError && e.code === 'BUDGET' && /source PNG pixels/.test(e.message));
  const images = decodeEmbeddedStudioImages(f.doc, bin, prepared.manifest, 'export', 48);
  assert.throws(() => materialStudioTexturePixels(prepared.manifest.materials[0]!, images, 63),
    e => e instanceof StudioTextureError && e.code === 'BUDGET' && /Converted material maps/.test(e.message));
  assert.equal(materialStudioTexturePixels(prepared.manifest.materials[0]!, images, 64).length, 4);
  // A repeated image location retains prepared coverage without inflating its
  // exact source bytes again or charging their private source storage twice.
  const duplicate = structuredClone(f.doc); duplicate.images.push({...duplicate.images[0]});
  const manifest = {...prepared.manifest, textures: prepared.manifest.textures.map(t => ({...t,
    locations: [...t.locations, ...(t.locations.some(l => l.imageIndex === 0) ? [{fileId: 'export', imageIndex: 3}] : [])]}))};
  assert.equal(decodeEmbeddedStudioImages(duplicate, bin, manifest, 'export', 48).hashes.length, 4);
});

test('actual original Blender UV/PBR GLBs preserve embedded PNG pixels and every packed UV stream', { skip: !process.env.ARCANE_TEXTURE_NATIVE_REPORT }, async () => {
  const report = JSON.parse(readFileSync(process.env.ARCANE_TEXTURE_NATIVE_REPORT!, 'utf8')) as Doc;
  const exports = new Map<'asset.glb' | 'collision.glb', Buffer>();
  for (const name of ['asset.glb', 'collision.glb'] as const) { const file = report.outputFiles.find((f: Doc) => f.relativePath === name), bytes = readFileSync(file.path); assert.equal(sha(bytes), file.sha256); exports.set(name, bytes); }
  const generated = adaptCompletedStudioImport(report.manifest as AssetManifest, exports, H, report.offlineSelection, null), { prepared, payload } = await decode(generated);
  assert.ok(payload.textures!.length >= 4); createStudioImportTransfer(prepared, payload);
  for (const entry of payload.objects.filter(o => o.object.role === 'render')) {
    assert.ok(entry.textureBindings?.ColorMap); assert.ok(entry.textureBindings?.NormalMap);
    const bytes = Buffer.from(generated.files.find(f => f.fileId === entry.object.exportFileId)!.bytes), n = bytes.readUInt32LE(12), doc = JSON.parse(bytes.subarray(20, 20 + n).toString()), bin = bytes.subarray(28 + n);
    for (const p of entry.primitives) {
      const uv = p.attributes.TEXCOORD_0!, a = doc.accessors[uv.source!.accessorIndex], v = doc.bufferViews[a.bufferView], width = a.componentType === 5126 ? 4 : a.componentType === 5123 ? 2 : 1;
      const raw = Buffer.concat(Array.from({ length: a.count }, (_, i) => bin.subarray((v.byteOffset ?? 0) + (a.byteOffset ?? 0) + i * (v.byteStride ?? 2 * width), (v.byteOffset ?? 0) + (a.byteOffset ?? 0) + i * (v.byteStride ?? 2 * width) + 2 * width)));
      assert.deepEqual(raw, Buffer.from(uv.bytes));
    }
    for (const map of payload.textures!.filter(t => t.materialSha256 === entry.material!.sha256)) {
      const imageIndex = prepared.manifest.textures.find(t => t.sha256 === map.sourceSha256)!.locations.find(l => l.fileId === entry.object.exportFileId)!.imageIndex;
      const source = doc.images[imageIndex], view = doc.bufferViews[source.bufferView], image = decodeMaterialPng(bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength));
      assert.equal(image.rgbaSha256, map.sourceRgbaSha256);
      if (map.semantic === 'NormalMap') assert.deepEqual(Buffer.from(map.bytes), materialPngPixels(image, 'rgb'));
    }
  }
});
