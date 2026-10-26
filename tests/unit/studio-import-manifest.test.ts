import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createStudioImportManifestAuthority, StudioImportManifestError, STUDIO_IMPORT_LIMITS } from '../../packages/asset-pipeline/src/studio-import-manifest.js';
import type { HostGeneratedStudioImport, PreparedStudioImport, StudioImportAdmission, StudioImportBaseline } from '../../packages/asset-pipeline/src/studio-import-manifest.js';
import { parseNativeStudioImportResponse } from '../../packages/asset-pipeline/src/studio-import-wire.js';

// Typed, in-memory exported cubes and PNGs. No filesystem, native applications,
// HTTP, provider, installed plugin, generated project or running bundle is used.
type Doc = Record<string, any>;
const JOB = '11111111-1111-4111-8111-111111111111';
const NEXT_JOB = '22222222-2222-4222-8222-222222222222';
const sha = (v: Uint8Array | string) => createHash('sha256').update(v).digest('hex');
const H = sha('source');
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');

test('CRC-valid PNG resources require decodable pixels before preparation succeeds', async () => {
  const corrupt = Buffer.from(PNG);
  const data = corrupt.indexOf(Buffer.from('IDAT'));
  assert.ok(data >= 0); corrupt[data + 4]! ^= 1;
  const length = corrupt.readUInt32BE(data - 4); let crc = 0xffffffff;
  for (const byte of corrupt.subarray(data, data + 4 + length)) {
    crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  corrupt.writeUInt32BE((crc ^ 0xffffffff) >>> 0, data + 4 + length);
  const input = fixture({ texture: corrupt }).input;
  await assert.rejects(prepare(input), value => value instanceof Error && 'code' in value && value.code === 'EXPORT' && /PNG pixel validation/.test(value.message));
});
function pack(doc: Doc, bin: Buffer): Buffer {
  const json = Buffer.from(JSON.stringify(doc)), jsonSize = Math.ceil(json.length / 4) * 4, binSize = Math.ceil(bin.length / 4) * 4;
  const bytes = Buffer.alloc(28 + jsonSize + binSize); bytes.writeUInt32LE(0x46546c67); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(jsonSize, 12); bytes.writeUInt32LE(0x4e4f534a, 16); bytes.fill(0x20, 20, 20 + jsonSize); json.copy(bytes, 20);
  bytes.writeUInt32LE(binSize, 20 + jsonSize); bytes.writeUInt32LE(0x004e4942, 24 + jsonSize); bin.copy(bytes, 28 + jsonSize); return bytes;
}
function fixture(options: { wide?: boolean; material?: number; texture?: Buffer; removed?: boolean; extra?: boolean; translated?: boolean;
  surface?: 'xy' | 'xz' | 'yz' | 'seams' | 'diagonal'; flatCollision?: boolean; rotated?: boolean } = {}) {
  const doc: Doc = { asset: { version: '2.0' }, buffers: [{ byteLength: 0 }], bufferViews: [], accessors: [], meshes: [], nodes: [], scene: 0, scenes: [{ nodes: [] }] };
  let bin: Buffer = Buffer.alloc(0);
  function view(bytes: Buffer): number {
    const at = Math.ceil(bin.length / 4) * 4, index = doc.bufferViews.length;
    bin = Buffer.concat([bin, Buffer.alloc(at - bin.length), bytes]); doc.bufferViews.push({ buffer: 0, byteOffset: at, byteLength: bytes.length }); return index;
  }
  function accessor(values: number[], type: 'VEC3' | 'VEC2' | 'SCALAR', index = false): number {
    const components = type === 'VEC3' ? 3 : type === 'VEC2' ? 2 : 1, bytes = Buffer.alloc(values.length * (index ? 2 : 4));
    values.forEach((n, i) => index ? bytes.writeUInt16LE(n, i * 2) : bytes.writeFloatLE(n, i * 4));
    const result = doc.accessors.length;
    const a: Doc = { bufferView: view(bytes), componentType: index ? 5123 : 5126, count: values.length / components, type };
    if (type === 'VEC3') { a.min = [0, 1, 2].map(c => Math.min(...values.filter((_, i) => i % 3 === c))); a.max = [0, 1, 2].map(c => Math.max(...values.filter((_, i) => i % 3 === c))); }
    doc.accessors.push(a); return result;
  }
  doc.materials = [{ pbrMetallicRoughness: { baseColorFactor: [0.2, 0.4, 0.6, 1], metallicFactor: options.material ?? 0.25, roughnessFactor: 0.7 } }];
  if (options.surface) doc.materials[0].doubleSided = true;
  if (options.texture) {
    doc.images = [{ bufferView: view(options.texture), mimeType: 'image/png' }]; doc.textures = [{ source: 0 }];
    doc.materials[0].pbrMetallicRoughness.baseColorTexture = { index: 0 };
    doc.materials[0].pbrMetallicRoughness.metallicRoughnessTexture = { index: 0 };
    doc.materials[0].normalTexture = { index: 0 };
  }
  const objects: HostGeneratedStudioImport['models'][number]['objects'] = [];
  for (const name of ['blade', ...(options.removed ? [] : ['handle']), ...(options.extra ? ['guard'] : []), 'proxy']) {
    const role = name === 'proxy' ? 'collision' as const : 'render' as const;
    const x = name === 'blade' && options.wide ? 1.5 : 1;
    const surface = role === 'render' ? options.surface : options.flatCollision ? 'xy' : undefined;
    const cards = { xy: [0,0,0,x,0,0,x,1,0,0,1,0], xz: [0,0,0,x,0,0,x,0,1,0,0,1], yz: [0,0,0,0,x,0,0,x,1,0,0,1],
      seams: [0,0,0,x,0,0,x,1,0,0,0,0,x,1,0,0,1,0], diagonal: [0,0,0,1,1,1,2,2,2] };
    const positions = surface ? cards[surface] : [0, 0, 0, x, 0, 0, x, 1, 0, 0, 1, 0, 0, 0, 1, x, 0, 1, x, 1, 1, 0, 1, 1];
    const indices = surface ? surface === 'seams' ? [0,1,2,3,4,5] : surface === 'diagonal' ? [0,1,2] : [0,1,2,0,2,3] :
      [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
    const normal = surface === 'xy' || surface === 'seams' ? [0,0,1] : surface === 'yz' ? [1,0,0] : [0,1,0];
    const primitive: Doc = { attributes: { POSITION: accessor(positions, 'VEC3'), NORMAL: accessor(Array.from({ length: positions.length / 3 }, () => normal).flat(), 'VEC3') }, indices: accessor(indices, 'SCALAR', true) };
    if (role === 'render') primitive.material = 0;
    if (options.texture && role === 'render') primitive.attributes.TEXCOORD_0 = accessor(Array.from({ length: positions.length / 3 }, (_, at) => surface ? [at % 2, Math.floor(at / 2) % 2] : [0, 0]).flat(), 'VEC2');
    const nodeIndex = doc.nodes.length;
    doc.meshes.push({ primitives: [primitive] }); doc.nodes.push({ name: name === 'proxy' ? 'COL_proxy' : 'SM_' + name, mesh: nodeIndex, ...(options.translated && name === 'blade' ? { translation: [2, 3, 4] } : {}) });
    if (options.rotated && role === 'render') { doc.nodes[nodeIndex].rotation = [0,0,Math.SQRT1_2,Math.SQRT1_2]; doc.nodes[nodeIndex].scale = [2,3,4]; }
    doc.scenes[0].nodes.push(nodeIndex);
    objects.push({ sourceObjectId: name, nodeIndex, role, pivot: [0, 0, 0], collisionFor: role === 'collision' ? ['blade'] : [] });
  }
  doc.buffers[0].byteLength = bin.length;
  const bytes = pack(doc, bin);
  const input: HostGeneratedStudioImport = { schemaVersion: 1, projectId: sha('project'), assetId: 'asset-shiv', revisionId: JOB, sourceSha256: H,
    producer: { blenderVersion: '4.5.3 LTS', exporterVersion: 'glTF 2.0' },
    target: { sessionId: 'studio-session', placeId: 0, universeId: 0, root: 'Workspace', parentRef: 'parent-opaque', creator: { kind: 'user', id: '1234' } },
    placement: { mode: 'bottom-centre' }, studsPerMeter: 1 / 0.28,
    files: [{ fileId: 'model-export', contentType: 'model/gltf-binary', bytes, sha256: sha(bytes) }],
    models: [{ fileId: 'model-export', resources: [], objects }],
    anchors: [{ sourceAnchorId: 'grip', sourceObjectId: 'blade', kind: 'socket', transform: [...IDENTITY] }], baseline: null };
  return { input, doc, bin, update() { const bytes = pack(doc, bin); input.files[0]!.bytes = bytes; input.files[0]!.sha256 = sha(bytes); } };
}
function baseline(prepared: PreparedStudioImport): StudioImportBaseline {
  return { manifest: JSON.parse(JSON.stringify(prepared.manifest)) as StudioImportBaseline['manifest'],
    receipt: { manifestDigest: prepared.manifest.digest, receiptSha256: sha('host Studio receipt'), modelRef: 'model-instance', modelAssetId: '7001',
      objects: prepared.manifest.objects.map(o => ({ sourceObjectId: o.sourceObjectId, instanceRef: 'instance-' + o.sourceObjectId, meshAssetId: '7002', ownedStateSha256: sha('owned-state-' + o.sourceObjectId),
        authoredChildren: [{ instanceRef: 'script-' + o.sourceObjectId, kind: 'script', stateSha256: sha('script') },
          { instanceRef: 'attachment-' + o.sourceObjectId, kind: 'attachment', stateSha256: sha('attachment') },
          { instanceRef: 'constraint-' + o.sourceObjectId, kind: 'constraint', stateSha256: sha('constraint') }] })) } };
}
async function prepare(input: HostGeneratedStudioImport, limits?: Parameters<typeof createStudioImportManifestAuthority>[0]['limits']) {
  const host = createStudioImportManifestAuthority({ loadGeneratedFiles: async () => input, ...(limits ? { limits } : {}) });
  return host.prepare(await host.admit(input.revisionId));
}
const errorCode = (code: StudioImportManifestError['code']) => (error: unknown) => error instanceof StudioImportManifestError && error.code === code;

for (const [surface, high] of [['xy',[1,1,0]],['xz',[1,0,1]],['yz',[0,1,1]]] as const)
  test('planar '+surface+' render bounds survive preparation, native wire and retained baseline without thickness', async () => {
    const f = fixture({surface,removed:true}), source = Buffer.from(f.input.files[0]!.bytes), prepared = await prepare(f.input);
    const render = prepared.manifest.objects.find(o => o.role === 'render')!;
    assert.deepEqual(render.bounds,{min:[0,0,0],max:[...high]}); assert.deepEqual(render.worldBounds,render.bounds);
    assert.deepEqual(prepared.manifest.bounds,render.bounds); assert.equal(render.triangles,2);
    assert.equal(prepared.manifest.materials[0]!.doubleSided,true);
    assert.deepEqual(f.input.files[0]!.bytes,source); assert.equal(prepared.manifest.files[0]!.sha256,sha(source));
    assert.deepEqual(parseNativeStudioImportResponse({prepared},JOB,f.input.projectId).prepared,prepared);
    f.input.revisionId=NEXT_JOB; f.input.baseline=baseline(prepared);
    const next=await prepare(f.input); assert.deepEqual(next.manifest.bounds,prepared.manifest.bounds);
    assert.ok(next.delta.objects.every(o=>o.action==='reuse')); assert.equal(next.manifest.engineVerification,'pending');
    assert.deepEqual(parseNativeStudioImportResponse({prepared:next},NEXT_JOB,f.input.projectId).prepared,next);
  });

test('planar seam vertices and nonuniform rotated ancestry retain measured source and world bounds', async () => {
  const f=fixture({surface:'seams',removed:true,translated:true,rotated:true}), source=Buffer.from(f.input.files[0]!.bytes);
  const prepared=await prepare(f.input), render=prepared.manifest.objects.find(o=>o.role==='render')!;
  assert.deepEqual(render.bounds,{min:[0,0,0],max:[1,1,0]}); render.scale.forEach((v,i)=>assert.ok(Math.abs(v-[2,3,4][i]!)<1e-12));
  const expectedLow=[-1,3,4],expectedHigh=[2,5,4];
  render.worldBounds.min.forEach((v,i)=>assert.ok(Math.abs(v-expectedLow[i]!)<1e-12));
  render.worldBounds.max.forEach((v,i)=>assert.ok(Math.abs(v-expectedHigh[i]!)<1e-12));
  assert.equal(render.triangles,2); assert.deepEqual(f.input.files[0]!.bytes,source);
  assert.deepEqual(parseNativeStudioImportResponse({prepared},JOB,f.input.projectId).prepared,prepared);
});

test('true diagonal zero-area triangles and flat collision hulls remain refused', async () => {
  await assert.rejects(prepare(fixture({surface:'diagonal',removed:true}).input),errorCode('EXPORT'));
  await assert.rejects(prepare(fixture({surface:'xy',flatCollision:true,removed:true}).input));
});

test('emissive glTF lamp data survives preparation and native wire validation without engine acceptance', async () => {
  const f = fixture({ texture: PNG });
  f.doc.materials[0].emissiveFactor = [0.9, 0.3, 0.1];
  f.doc.materials[0].emissiveTexture = { index: 0 };
  f.doc.materials[0].extensions = { KHR_materials_emissive_strength: { emissiveStrength: 2.5 } };
  f.doc.extensionsUsed = ['KHR_materials_emissive_strength']; f.update();
  const prepared = await prepare(f.input), light = prepared.manifest.materials[0]!.emission!;
  assert.deepEqual(light.factor, [0.9, 0.3, 0.1]); assert.equal(light.strength, 2.5);
  assert.equal(light.map!.sha256, sha(PNG)); assert.equal(light.map!.channel, 'rgb');
  assert.ok(prepared.manifest.objects.filter(o => o.role === 'render').every(o => o.textureSha256s.includes(sha(PNG))));
  assert.deepEqual(parseNativeStudioImportResponse({ prepared }, JOB, f.input.projectId).prepared, prepared);
  assert.equal(prepared.manifest.engineVerification, 'pending');
});

test('zero emission preserves existing material hashes while invalid emission and unsupported extensions remain refused', async () => {
  const first = fixture(), plain = await prepare(first.input); first.doc.materials[0].emissiveFactor = [0, 0, 0]; first.update();
  const zero = await prepare(first.input);
  assert.equal(zero.manifest.materials[0]!.sha256, plain.manifest.materials[0]!.sha256);
  assert.equal(Object.hasOwn(zero.manifest.materials[0]!, 'emission'), false);
  for (const strength of [-1, 1001, '2']) {
    const f = fixture(); f.doc.materials[0].extensions = { KHR_materials_emissive_strength: { emissiveStrength: strength } };
    f.doc.extensionsUsed = ['KHR_materials_emissive_strength']; f.update(); await assert.rejects(prepare(f.input));
  }
  const unsupported = fixture(); unsupported.doc.extensionsUsed = ['KHR_materials_unlit'];
  unsupported.doc.materials[0].extensions = { KHR_materials_unlit: {} }; unsupported.update();
  await assert.rejects(prepare(unsupported.input));
});
function withText(png: Buffer): Buffer {
  const data = Buffer.from('revision\0two'), chunk = Buffer.alloc(12 + data.length); chunk.writeUInt32BE(data.length); chunk.write('tEXt', 4); data.copy(chunk, 8);
  let crc = 0xffffffff;
  for (const n of chunk.subarray(4, -4)) { crc ^= n; for (let j = 0; j < 8; j++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1; }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]);
}

test('prepared manifest records actual export hashes, stable IDs, PBR, bounds, scale, pivots and collision; deeply immutable', async () => {
  const f = fixture({ texture: PNG, translated: true }), p = await prepare(f.input);
  assert.equal(p.status, 'prepared'); assert.equal(p.manifest.engineVerification, 'pending');
  assert.equal(p.manifest.files[0]!.sha256, sha(f.input.files[0]!.bytes));
  assert.deepEqual(p.manifest.objects.map(o => o.sourceObjectId), ['blade', 'handle', 'proxy']);
  const blade = p.manifest.objects[0]!;
  assert.deepEqual(blade.bounds, { min: [0, 0, 0], max: [1, 1, 1] });
  assert.deepEqual(blade.worldBounds, { min: [2, 3, 4], max: [3, 4, 5] }); assert.deepEqual(blade.scale, [1, 1, 1]); assert.deepEqual(blade.pivot, [0, 0, 0]);
  assert.equal(blade.triangles, 12); assert.deepEqual(p.manifest.objects[2]!.collisionFor, ['blade']);
  assert.equal(p.manifest.materials[0]!.metallic, 0.25); assert.equal(p.manifest.materials[0]!.roughnessMap!.channel, 'g'); assert.equal(p.manifest.materials[0]!.metalnessMap!.channel, 'b');
  assert.equal(p.manifest.textures[0]!.sha256, sha(PNG)); assert.equal(p.manifest.textures[0]!.width, 1);
  assert.equal(p.manifest.conversion.studsPerMeter, 1 / 0.28); assert.equal(p.delta.previousDigest, null); assert.equal(p.delta.modelRef, null);
  assert.ok(p.delta.objects.every(o => o.action === 'create' && !o.replaceInstance && !o.deleteInstance));
  assert.ok(Object.isFrozen(p) && Object.isFrozen(p.manifest.objects[0]!.bounds.min) && Object.isFrozen(p.delta));
  assert.throws(() => (p.manifest.objects as unknown as object[]).push({}), TypeError);
  assert.match(p.digest, /^[a-f0-9]{64}$/); assert.notEqual(p.digest, p.manifest.digest);
});

test('deterministic digest ignores host object/key/list ordering; admission snapshots mutable host bytes and metadata', async () => {
  const f = fixture({ texture: PNG }), a = await prepare(f.input);
  const reversed = { ...f.input, anchors: [...f.input.anchors].reverse(), models: f.input.models.map(m => ({ ...m, objects: [...m.objects].reverse() })) };
  assert.deepEqual(await prepare(reversed), a);
  const host = createStudioImportManifestAuthority({ loadGeneratedFiles: async () => f.input }), token = await host.admit(JOB);
  f.input.files[0]!.bytes.fill(0); f.input.assetId = 'changed'; f.input.models[0]!.objects[0]!.pivot[0] = 99;
  assert.deepEqual(host.prepare(token), a);
});

test('only exact opaque admissions work; booleans, verified flags, clones, cross-authority tokens and revoked tokens fail', async () => {
  const f = fixture(), host = createStudioImportManifestAuthority({ loadGeneratedFiles: async () => f.input });
  for (const forged of [true, false, null, {}, { kind: 'studio-import-admission', verified: true }]) assert.throws(() => host.prepare(forged as StudioImportAdmission), errorCode('AUTHORITY'));
  const token = await host.admit(JOB), other = createStudioImportManifestAuthority({ loadGeneratedFiles: async () => f.input });
  assert.throws(() => host.prepare(structuredClone(token)), errorCode('AUTHORITY')); assert.throws(() => other.prepare(token), errorCode('AUTHORITY'));
  host.revoke(token); assert.throws(() => host.prepare(token), errorCode('AUTHORITY'));
  for (const value of [true, { verified: true }, { hostAttested: true }]) await assert.rejects(createStudioImportManifestAuthority({ loadGeneratedFiles: async () => value as unknown as HostGeneratedStudioImport }).admit(JOB), errorCode('SCHEMA'));
  assert.throws(() => createStudioImportManifestAuthority(true as never), errorCode('AUTHORITY'));
});

test('close fences asynchronous admissions and requested revision is pinned', async () => {
  let resolve!: (v: HostGeneratedStudioImport) => void;
  const host = createStudioImportManifestAuthority({ loadGeneratedFiles: () => new Promise(r => { resolve = r; }) });
  const admission = host.admit(JOB); host.close(); resolve(fixture().input); await assert.rejects(admission, errorCode('AUTHORITY'));
  await assert.rejects(createStudioImportManifestAuthority({ loadGeneratedFiles: async () => fixture().input }).admit(NEXT_JOB), errorCode('AUTHORITY'));
});

test('unchanged exported meshes are reused despite changed bundle/revision; geometry update preserves scripts/attachments/constraints in place', async () => {
  const first = await prepare(fixture().input), f = fixture({ wide: true }); f.input.revisionId = NEXT_JOB; f.input.baseline = baseline(first);
  const p = await prepare(f.input);
  assert.notEqual(p.manifest.files[0]!.sha256, first.manifest.files[0]!.sha256);
  assert.deepEqual(p.delta.objects.map(o => [o.sourceObjectId, o.action]), [['blade', 'update-in-place'], ['handle', 'reuse'], ['proxy', 'reuse']]);
  assert.deepEqual(p.delta.objects[0]!.changed, ['geometry']); assert.equal(p.delta.objects[0]!.instanceRef, 'instance-blade');
  assert.deepEqual(p.delta.objects[0]!.preserveChildren.map(c => c.kind).sort(), ['attachment', 'constraint', 'script']);
  assert.equal(p.delta.objects[0]!.expectedOwnedStateSha256, sha('owned-state-blade'));
  assert.equal(p.delta.geometry.prepare.length, 1); assert.equal(p.delta.geometry.reuse.length, 1);
  assert.equal(p.delta.previousDigest, first.manifest.digest); assert.equal(p.delta.receiptSha256, sha('host Studio receipt'));
  assert.equal(p.delta.modelRef, 'model-instance'); assert.ok(p.delta.objects.every(o => !o.replaceInstance && !o.deleteInstance));
});

test('identical revision content causes no object updates, while material/texture changes do not reupload geometry', async () => {
  const first = await prepare(fixture({ texture: PNG }).input), same = fixture({ texture: PNG }); same.input.revisionId = NEXT_JOB; same.input.baseline = baseline(first);
  assert.ok((await prepare(same.input)).delta.objects.every(o => o.action === 'reuse'));
  const changed = fixture({ texture: withText(PNG), material: 0.5 }); changed.input.revisionId = NEXT_JOB; changed.input.baseline = baseline(first);
  const p = await prepare(changed.input);
  assert.deepEqual(p.delta.objects[0]!.changed, ['material', 'textures']); assert.equal(p.delta.geometry.prepare.length, 0);
  assert.equal(p.delta.textures.prepare.length, 1); assert.equal(p.delta.textures.reuse.length, 0);
  assert.equal(p.delta.objects[2]!.action, 'reuse');
});

test('removed objects are retained for review with preserved children; new objects do not get another existing mapping', async () => {
  const first = await prepare(fixture().input), f = fixture({ removed: true, extra: true }); f.input.revisionId = NEXT_JOB; f.input.baseline = baseline(first);
  const p = await prepare(f.input), guard = p.delta.objects.find(o => o.sourceObjectId === 'guard')!;
  assert.equal(guard.action, 'create'); assert.equal(guard.instanceRef, null);
  assert.equal(p.delta.reviewRemovals[0]!.sourceObjectId, 'handle'); assert.equal(p.delta.reviewRemovals[0]!.action, 'retain-for-review');
  assert.equal(p.delta.reviewRemovals[0]!.authoredChildren.length, 3); assert.equal(p.delta.reviewRemovals[0]!.instanceRef, 'instance-handle');
});

test('placement, unit conversion and anchor changes are explicit; anchors are reviewed rather than overwritten', async () => {
  const first = await prepare(fixture().input), f = fixture(); f.input.revisionId = NEXT_JOB; f.input.baseline = baseline(first); f.input.studsPerMeter = 2;
  f.input.placement = { mode: 'custom-anchor', anchorId: 'grip' }; f.input.anchors[0]!.transform[12] = 1;
  const p = await prepare(f.input); assert.equal(p.delta.placementChanged, true); assert.ok(p.delta.objects.every(o => o.changed.includes('transform')));
  assert.deepEqual(p.delta.reviewAnchors, ['grip']); assert.equal(p.delta.geometry.prepare.length, 0);
  const selected = fixture(); selected.input.placement = { mode: 'selected-attachment', attachmentRef: 'existing-grip', expectedStateSha256: H };
  assert.equal((await prepare(selected.input)).manifest.placement.mode, 'selected-attachment');
  const bad = fixture(); bad.input.placement = { mode: 'cframe', value: Array(12).fill(0) }; await assert.rejects(prepare(bad.input), errorCode('SCHEMA'));
});

test('baseline digests, complete mappings, and exact project/creator/place/session/parent must match', async () => {
  const first = await prepare(fixture().input);
  const mutations: ((v: HostGeneratedStudioImport) => void)[] = [
    v => v.projectId = sha('other'), v => v.assetId = 'other-asset', v => v.target.creator.id = '5678', v => v.target.sessionId = 'other-session',
    v => v.target.placeId = 1, v => v.target.universeId = 1, v => v.target.parentRef = 'other-parent',
    v => v.baseline!.manifest.sourceSha256 = sha('tampered'), v => v.baseline!.receipt.manifestDigest = sha('tampered'),
    v => v.baseline!.receipt.objects.pop(), v => v.baseline!.receipt.objects[1]!.instanceRef = v.baseline!.receipt.objects[0]!.instanceRef,
  ];
  for (const mutate of mutations) { const f = fixture(); f.input.revisionId = NEXT_JOB; f.input.baseline = baseline(first); mutate(f.input); await assert.rejects(prepare(f.input), errorCode('BASELINE')); }
});

test('strict metadata rejects executable fields, renderer authority, paths/URLs, unknown ownership, and duplicate IDs', async () => {
  const mutations: ((v: HostGeneratedStudioImport) => void)[] = [
    v => (v as any).verified = true, v => (v as any).path = 'C:\\secret\\asset.glb', v => (v.files[0] as any).url = 'https://example.invalid/model',
    v => v.files[0]!.fileId = '../export', v => v.target.parentRef = 'Workspace.Model', v => (v.target as any).hostAuthority = true,
    v => v.models[0]!.objects[1]!.sourceObjectId = 'blade', v => v.models[0]!.objects[1]!.nodeIndex = 0,
    v => v.models[0]!.objects[2]!.collisionFor = ['blade', 'blade'], v => v.anchors[0]!.sourceObjectId = 'unknown',
    v => v.models[0]!.objects[2]!.collisionFor = ['missing'], v => v.models[0]!.objects[0]!.collisionFor = ['handle'],
    v => v.placement = { mode: 'custom-anchor', anchorId: 'missing' },
    v => v.assetId += '\n', v => v.projectId += '\n', v => v.target.creator.id += '\n', v => v.producer.blenderVersion += '\n',
  ];
  for (const mutate of mutations) { const f = fixture(); mutate(f.input); await assert.rejects(prepare(f.input), StudioImportManifestError); }
});

test('metadata getters/proxies/symbols/custom prototypes/sparse arrays and shared memory cannot execute or grant admission', async () => {
  let calls = 0;
  const host = (value: unknown) => createStudioImportManifestAuthority({ loadGeneratedFiles: async () => value as HostGeneratedStudioImport }).admit(JOB);
  const getter = Object.defineProperty({}, 'schemaVersion', { enumerable: true, get() { calls++; return 1; } });
  const proxy = new Proxy({}, { ownKeys() { calls++; return []; } });
  for (const value of [getter, proxy, { ...fixture().input, [Symbol('authority')]: true }, Object.assign(Object.create({ authority: true }), fixture().input)]) await assert.rejects(host(value), errorCode('SCHEMA'));
  const sparse = fixture(); delete sparse.input.anchors[0]; await assert.rejects(host(sparse.input), errorCode('SCHEMA'));
  const shared = fixture(); shared.input.files[0]!.bytes = new Uint8Array(new SharedArrayBuffer(128)); await assert.rejects(host(shared.input), errorCode('SCHEMA'));
  const shadow = fixture(); Object.defineProperty(shadow.input.files[0]!.bytes, 'buffer', { get() { calls++; throw new Error('getter executed'); } });
  await host(shadow.input); assert.equal(calls, 0);
});

test('hash/byte/count/triangle/material/texture budgets are enforced, overrides only tighten policy', async () => {
  const f = fixture(); f.input.files[0]!.sha256 = H; await assert.rejects(prepare(f.input), errorCode('EXPORT'));
  for (const limits of [{ fileBytes: 100 }, { totalBytes: 100 }, { objects: 2 }, { triangles: 35 }, { meshTriangles: 11 }, { jsonBytes: 100 }, { manifestBytes: 100 }]) await assert.rejects(prepare(fixture().input, limits), errorCode('BUDGET'));
  const twoMaterials = fixture(); twoMaterials.doc.materials.push({ pbrMetallicRoughness: { metallicFactor: 0.8 } }); twoMaterials.update(); await assert.rejects(prepare(twoMaterials.input, { materials: 1 }), errorCode('BUDGET'));
  const textured = fixture({ texture: PNG }); await assert.rejects(prepare(textured.input, { texturePixels: 0 }), errorCode('BUDGET'));
  for (const limits of [{ meshTriangles: 20_001 }, { fileBytes: STUDIO_IMPORT_LIMITS.fileBytes + 1 }, { arbitrary: 1 }]) assert.throws(() => createStudioImportManifestAuthority({ loadGeneratedFiles: async () => fixture().input, limits }), errorCode('BUDGET'));
  assert.throws(() => createStudioImportManifestAuthority({ loadGeneratedFiles: async () => fixture().input, limits: { triangles: NaN } }), errorCode('SCHEMA'));
  assert.equal(STUDIO_IMPORT_LIMITS.meshTriangles, 20_000); assert.equal(STUDIO_IMPORT_LIMITS.fileBytes, 20_000_000);
});

test('official per-mesh triangle ceiling and single-material constraint reject otherwise bounded GLBs', async () => {
  const big = fixture(), p = big.doc.meshes[0].primitives[0];
  big.doc.meshes[0].primitives = Array.from({ length: 1667 }, () => ({ ...p })); big.update(); await assert.rejects(prepare(big.input), /Per-mesh triangles/);
  const multi = fixture(); multi.doc.materials.push({ pbrMetallicRoughness: { metallicFactor: 0.9 } }); multi.doc.meshes[0].primitives.push({ ...multi.doc.meshes[0].primitives[0], material: 1 }); multi.update();
  await assert.rejects(prepare(multi.input), /one material per mesh/);
});

test('malformed binary, external resources (including unused), rigs, animations and unsupported material features fail closed', async () => {
  const corrupt = fixture(); corrupt.input.files[0]!.bytes[0] = 0; corrupt.input.files[0]!.sha256 = sha(corrupt.input.files[0]!.bytes); await assert.rejects(prepare(corrupt.input), errorCode('EXPORT'));
  for (const mutate of [
    (d: Doc) => d.buffers[0].uri = 'https://example.invalid/data.bin', (d: Doc) => d.extras = { uri: 'file:///secret' },
    (d: Doc) => d.nodes[0].scale = [-1, 1, 1], (d: Doc) => d.materials[0].emissiveFactor = [2, 0, 0],
    (d: Doc) => { d.extensionsUsed = ['KHR_materials_unlit']; d.materials[0].extensions = { KHR_materials_unlit: {} }; },
    (d: Doc) => d.nodes[0].weights = [1],
  ]) { const f = fixture(); mutate(f.doc); f.update(); await assert.rejects(prepare(f.input), StudioImportManifestError); }
});

test('self-contained host-attested glTF dependency bundle is admitted without reading paths or URLs', async () => {
  const f = fixture(); f.doc.buffers[0].uri = 'generated.bin';
  const text = Buffer.from(JSON.stringify(f.doc));
  f.input.files = [{ fileId: 'model-export', contentType: 'model/gltf+json', bytes: text, sha256: sha(text) },
    { fileId: 'generated-buffer', contentType: 'application/octet-stream', bytes: f.bin, sha256: sha(f.bin) }];
  f.input.models[0]!.resources = [{ uri: 'generated.bin', fileId: 'generated-buffer' }];
  const p = await prepare(f.input); assert.equal(p.manifest.files.length, 2); assert.equal(p.manifest.objects[0]!.triangles, 12);
  assert.equal(p.manifest.objects[0]!.meshExportSha256, (await prepare(fixture().input)).manifest.objects[0]!.meshExportSha256);
  f.input.models[0]!.resources[0]!.uri = '../generated.bin'; await assert.rejects(prepare(f.input), errorCode('SCHEMA'));
});

test('glTF rejects unmatched/unused/path/URL resources and wrong content lengths/MIME, including resources not rendered', async () => {
  for (const uri of ['../data.bin', 'C:/data.bin', 'https://example.invalid/data.bin', 'data:application/octet-stream;base64,AAAA', 'missing.bin']) {
    const f = fixture(); f.doc.buffers[0].uri = uri; const text = Buffer.from(JSON.stringify(f.doc));
    f.input.files[0] = { fileId: 'model-export', contentType: 'model/gltf+json', bytes: text, sha256: sha(text) };
    await assert.rejects(prepare(f.input), /host-attested/);
  }
  const f = fixture(); f.input.files.push({ fileId: 'unused', contentType: 'application/octet-stream', bytes: Buffer.from('unused'), sha256: sha('unused') });
  await assert.rejects(prepare(f.input), /Unreferenced/);
});

test('glTF generated image resources are hashed and packed locally; length and MIME mismatches are refused', async () => {
  function bundle() {
    const f = fixture({ texture: PNG }); f.doc.buffers[0].uri = 'generated.bin';
    f.doc.images = [{ uri: 'albedo.png', mimeType: 'image/png' }];
    const update = () => { const text = Buffer.from(JSON.stringify(f.doc)); f.input.files[0] = { fileId: 'model-export', contentType: 'model/gltf+json', bytes: text, sha256: sha(text) }; };
    f.input.files = [{ fileId: 'model-export', contentType: 'model/gltf+json', bytes: Buffer.alloc(0), sha256: H },
      { fileId: 'generated-buffer', contentType: 'application/octet-stream', bytes: f.bin, sha256: sha(f.bin) },
      { fileId: 'generated-texture', contentType: 'image/png', bytes: PNG, sha256: sha(PNG) }];
    f.input.models[0]!.resources = [{ uri: 'generated.bin', fileId: 'generated-buffer' }, { uri: 'albedo.png', fileId: 'generated-texture' }];
    update(); return { ...f, update };
  }
  const f = bundle(), p = await prepare(f.input);
  assert.equal(p.manifest.textures[0]!.sha256, sha(PNG)); assert.equal(p.manifest.files.length, 3);
  assert.equal(p.manifest.materials[0]!.colorMap!.sha256, sha(PNG));
  const length = bundle(); length.doc.buffers[0].byteLength--; length.update(); await assert.rejects(prepare(length.input), /buffer length/);
  const mime = bundle(); mime.doc.images[0].mimeType = 'image/jpeg'; mime.update(); await assert.rejects(prepare(mime.input), /MIME mismatch/);
});
