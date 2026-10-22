import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { createImportedAssets, packGltf, readImportedEffect, readImportedModel, importDisplayName, parseRobloxXml, IMPORT_CONSENT_MESSAGE, ImportError } from '../../apps/daemon/src/imported-assets.js';
import { importedFacts, effectProperties, particleEstimate, EFFECT_BUDGETS, type ImportedViewerAsset } from '../../apps/desktop/src/asset-viewer.js';
import { readImportedAsset, formatBytes } from '../../apps/desktop/src/asset-imports.js';

const TOKEN = 'b'.repeat(64);
/** A real 1x1 RGBA PNG (valid chunk CRCs and zlib data), as an exporter writes it. */
function pngPixel(): Buffer {
  const crc = (data: Buffer) => { let n = 0xffffffff; for (const byte of data) { n ^= byte; for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; } return (n ^ 0xffffffff) >>> 0; };
  const chunk = (name: string, data: Buffer) => { const type = Buffer.from(name), bytes = Buffer.alloc(data.length + 12); bytes.writeUInt32BE(data.length); type.copy(bytes, 4); data.copy(bytes, 8); bytes.writeUInt32BE(crc(Buffer.concat([type, data])), bytes.length - 4); return bytes; };
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, 220, 120, 35, 255]))), chunk('IEND', Buffer.alloc(0))]);
}
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
/** A real one-triangle glTF 2.0 scene: positions, one material, optional embedded PNG. */
function triangle(options: { image?: boolean } = {}): { json: Record<string, unknown>; bin: Buffer } {
  const positions = Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
  const uvs = Buffer.from(new Float32Array([0, 0, 1, 0, 0, 1]).buffer);
  const png = pngPixel();
  const bin = Buffer.concat([positions, uvs, ...(options.image ? [png, Buffer.alloc((4 - png.length % 4) % 4)] : [])]);
  const json: Record<string, unknown> = {
    asset: { version: '2.0', generator: 'Arcane import test' },
    buffers: [{ byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 24 }, ...(options.image ? [{ buffer: 0, byteOffset: 60, byteLength: png.length }] : [])],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }, { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: options.image ? { baseColorTexture: { index: 0 } } : { baseColorFactor: [.8, .2, .2, 1] } }],
    ...(options.image ? { images: [{ bufferView: 2, mimeType: 'image/png' }], textures: [{ source: 0 }] } : {}),
    nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0,
  };
  return { json, bin };
}
function glb(parts = triangle()): Buffer {
  const json = Buffer.from(JSON.stringify(parts.json)), jsonLength = Math.ceil(json.length / 4) * 4, binLength = Math.ceil(parts.bin.length / 4) * 4;
  const out = Buffer.alloc(28 + jsonLength + binLength);
  out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(jsonLength, 12); out.writeUInt32LE(0x4e4f534a, 16); out.fill(0x20, 20, 20 + jsonLength); json.copy(out, 20);
  out.writeUInt32LE(binLength, 20 + jsonLength); out.writeUInt32LE(0x004e4942, 24 + jsonLength); parts.bin.copy(out, 28 + jsonLength);
  return out;
}
const CAMPFIRE = `<?xml version="1.0" encoding="utf-8"?>
<roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" version="4">
  <Item class="Part" referent="RBX1">
    <Properties>
      <string name="Name">Campfire</string>
      <CoordinateFrame name="CFrame"><X>10</X><Y>2</Y><Z>-4</Z><R00>1</R00><R01>0</R01><R02>0</R02><R10>0</R10><R11>1</R11><R12>0</R12><R20>0</R20><R21>0</R21><R22>1</R22></CoordinateFrame>
      <Vector3 name="size"><X>4</X><Y>1</Y><Z>4</Z></Vector3>
    </Properties>
    <Item class="Attachment" referent="RBX2">
      <Properties>
        <string name="Name">FlameRoot</string>
        <CoordinateFrame name="CFrame"><X>0</X><Y>0.5</Y><Z>0</Z><R00>1</R00><R01>0</R01><R02>0</R02><R10>0</R10><R11>1</R11><R12>0</R12><R20>0</R20><R21>0</R21><R22>1</R22></CoordinateFrame>
      </Properties>
      <Item class="ParticleEmitter" referent="RBX3">
        <Properties>
          <string name="Name">Flames &amp; embers</string>
          <float name="Rate">40</float>
          <NumberRange name="Lifetime">0.6 1.1 </NumberRange>
          <NumberRange name="Speed">3 5 </NumberRange>
          <NumberSequence name="Size">0 1.6 0 0.5 1.2 0 1 0.2 0 </NumberSequence>
          <NumberSequence name="Transparency">0 1 0 0.15 0.35 0 1 1 0 </NumberSequence>
          <ColorSequence name="Color">0 1 0.82 0.48 0 1 0.7 0.21 0.1 0 </ColorSequence>
          <Vector3 name="Acceleration"><X>0</X><Y>4</Y><Z>0</Z></Vector3>
          <Vector2 name="SpreadAngle"><X>8</X><Y>8</Y></Vector2>
          <float name="LightEmission">1</float>
          <token name="EmissionDirection">1</token>
          <Content name="Texture"><url>rbxasset://textures/particles/fire_main.dds</url></Content>
          <float name="Drag">900</float>
        </Properties>
      </Item>
      <Item class="PointLight" referent="RBX4">
        <Properties>
          <string name="Name">Glow</string>
          <float name="Brightness">2</float>
          <float name="Range">14</float>
          <Color3 name="Color"><R>1</R><G>0.56</G><B>0.6</B></Color3>
          <bool name="Shadows">true</bool>
        </Properties>
      </Item>
    </Item>
    <Item class="Script" referent="RBX5"><Properties><string name="Name">Flicker</string><ProtectedString name="Source"><![CDATA[print("never run")]]></ProtectedString></Properties></Item>
    <Item class="Beam" referent="RBX6"><Properties><string name="Name">Shaft</string><float name="Width0">6</float></Properties></Item>
  </Item>
</roblox>`;

test('model admission: real GLB magic, version, preflight and measured stats', () => {
  const bytes = glb(triangle({ image: true }));
  const { stats } = readImportedModel(bytes);
  assert.deepEqual(stats, { triangles: 1, meshes: 1, materials: 1, textures: 1, animations: 0, nodes: 1 });
  const renamed = Buffer.from(bytes); renamed.write('PK\x03\x04', 0, 'latin1');
  assert.throws(() => readImportedModel(renamed), (error: unknown) => error instanceof ImportError && /not a GLB/.test(error.message));
  const v1 = Buffer.from(bytes); v1.writeUInt32LE(1, 4);
  assert.throws(() => readImportedModel(v1), /glTF 2\.0/);
  const external = triangle(); (external.json.buffers as Record<string, unknown>[])[0]!.uri = 'https://example.com/a.bin';
  assert.throws(() => readImportedModel(glb(external)), /preview this model safely/);
  assert.throws(() => readImportedModel(new Uint8Array(8)), /empty or larger/);
});

test('gltf packing: embedded buffers and textures become one GLB; links and bad data are refused', () => {
  const parts = triangle({ image: true }), json = structuredClone(parts.json) as Record<string, any>;
  const png = pngPixel();
  json.buffers = [{ byteLength: 60, uri: 'data:application/octet-stream;base64,' + parts.bin.subarray(0, 60).toString('base64') }];
  json.bufferViews = json.bufferViews.slice(0, 2);
  json.images = [{ uri: 'data:image/png;base64,' + png.toString('base64') }];
  const packed = packGltf(Buffer.from(JSON.stringify(json)));
  const { stats } = readImportedModel(packed);
  assert.equal(stats.triangles, 1); assert.equal(stats.textures, 1);
  const linked = structuredClone(json); linked.buffers[0].uri = 'scene.bin';
  assert.throws(() => packGltf(Buffer.from(JSON.stringify(linked))), /Export it as a GLB/);
  const damaged = structuredClone(json); damaged.buffers[0].uri = 'data:application/octet-stream;base64,@@@';
  assert.throws(() => packGltf(Buffer.from(JSON.stringify(damaged))), /damaged/);
  const gif = structuredClone(json); gif.images[0].uri = 'data:image/gif;base64,' + Buffer.from('GIF89a....').toString('base64');
  assert.throws(() => packGltf(Buffer.from(JSON.stringify(gif))), /PNG or JPEG/);
  assert.throws(() => packGltf(Buffer.from('{"asset":{"version":"1.0"}}')), /glTF 2\.0/);
  assert.throws(() => packGltf(Buffer.from('not json')), /not valid JSON/);
});

test('effect admission: Arcane allowlist, Roblox enums, positions, caps and honest notes', () => {
  const effect = readImportedEffect(Buffer.from(CAMPFIRE));
  assert.deepEqual(effect.items.map(item => item.className), ['ParticleEmitter', 'PointLight', 'Beam']);
  const [flames, glow] = effect.items;
  assert.equal(flames!.name, 'Flames & embers'); assert.equal(flames!.parent, 'FlameRoot');
  assert.deepEqual(flames!.position, [10, 2.5, -4]); assert.equal(flames!.area, null);
  assert.equal(flames!.props.Rate, 40); assert.deepEqual(flames!.props.Lifetime, { min: .6, max: 1.1 });
  assert.equal(flames!.props.EmissionDirection, 'Top'); assert.equal(flames!.props.Texture, 'rbxasset://textures/particles/fire_main.dds');
  assert.deepEqual((flames!.props.Size as { keys: number[][] }).keys, [[0, 1.6, 0], [.5, 1.2, 0], [1, .2, 0]]);
  assert.equal((flames!.props.Color as { colors: number[][] }).colors.length, 2);
  assert.equal(flames!.props.Drag, 50, 'Drag 900 is capped at Arcane\'s limit of 50');
  assert.deepEqual(effect.clamped, ['ParticleEmitter.Drag']);
  assert.deepEqual(glow!.props, { Brightness: 2, Range: 14, Color: [1, .56, .6], Shadows: true });
  assert.equal(effect.scripts, 1); assert.equal(effect.truncated, false);
  assert.throws(() => readImportedEffect(Buffer.from('<roblox!\x89\xff\r\n\x1a\n' + 'x'.repeat(40), 'latin1')), /binary \.rbxm/);
  assert.throws(() => readImportedEffect(Buffer.from('<?xml version="1.0"?><!DOCTYPE roblox [<!ENTITY a "b">]><roblox version="4"></roblox>')), /not a Roblox model file|document type/);
  assert.throws(() => readImportedEffect(Buffer.from('<roblox version="4"><!DOCTYPE x><Item class="Fire"/></roblox>')), /document type/);
  assert.throws(() => readImportedEffect(Buffer.from('<roblox version="4"><Item class="Part"><Properties/></Item></roblox>')), /no particle emitters/);
  assert.throws(() => readImportedEffect(Buffer.from('<html><body>hi</body></html>')), /not a Roblox model file/);
  assert.throws(() => parseRobloxXml('<roblox><Item class="A"></roblox>'), /damaged/);
  assert.throws(() => parseRobloxXml('<roblox>' + '<a>'.repeat(200) + '</a>'.repeat(200) + '</roblox>'), /nests too deeply/);
});

test('display names: no folders, controls or bidi overrides', () => {
  assert.deepEqual(importDisplayName('C:\\Users\\me\\Desktop\\oak_tree.glb'), { name: 'oak tree', fileName: 'oak_tree.glb' });
  assert.deepEqual(importDisplayName('../../evil\u202egpj.glb'), { name: 'evil gpj', fileName: 'evil gpj.glb' });
  assert.throws(() => importDisplayName('..'), /missing/);
});

async function server(t: { after(fn: () => unknown): void }, store: ReturnType<typeof createImportedAssets>): Promise<{ origin: string; call(path: string, init?: RequestInit): Promise<Response> }> {
  let origin = '';
  const http: Server = createServer((request, response) => { void store.handle(request, response, new URL(request.url ?? '/', origin), TOKEN, origin).then(handled => { if (!handled) { response.writeHead(404); response.end(); } }); });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const address = http.address(); if (!address || typeof address === 'string') throw new Error('no port');
  origin = 'http://127.0.0.1:' + address.port;
  t.after(() => new Promise<void>(resolve => http.close(() => resolve())));
  return { origin, call: (path, init = {}) => fetch(origin + path, { ...init, headers: { Authorization: 'Bearer ' + TOKEN, ...(init.headers as Record<string, string> | undefined) } }) };
}
const consent = (store: ReturnType<typeof createImportedAssets>, value = sha(String(Math.random()))) => { assert.equal(store.acceptConsent({ type: IMPORT_CONSENT_MESSAGE, protocolVersion: 1, consent: value }), true); return value; };

test('import routes: consent from the main process, bearer, origin, list, file, duplicate and remove', async t => {
  const state = await mkdtemp(join(tmpdir(), 'arcane-imports-')); t.after(() => rm(state, { recursive: true, force: true }));
  const store = createImportedAssets({ stateDirectory: state }), { origin, call } = await server(t, store);
  const bytes = glb(triangle({ image: true }));
  const upload = (headers: Record<string, string>, body: Uint8Array = bytes, query = 'format=glb&name=oak_tree.glb') => call('/v1/imports/upload?' + query, { method: 'POST', body: new Uint8Array(body), headers: { 'Content-Type': 'application/octet-stream', ...headers } });
  // Without the IPC channel no consent is accepted at all.
  assert.equal(store.acceptConsent({ type: IMPORT_CONSENT_MESSAGE, protocolVersion: 1, consent: 'c'.repeat(64) }), false);
  store.enableConsentChannel();
  assert.equal((await fetch(origin + '/v1/imports')).status, 401, 'no bearer');
  assert.equal((await call('/v1/imports', { headers: { Origin: 'http://evil.test' } })).status, 403, 'foreign origin');
  assert.equal((await upload({})).status, 403, 'no consent: the renderer alone cannot import');
  assert.equal((await upload({ 'X-Arcane-Import-Consent': 'd'.repeat(64) })).status, 403, 'unknown consent');
  const key = consent(store);
  const created = await upload({ 'X-Arcane-Import-Consent': key });
  assert.equal(created.status, 201);
  const record = (await created.json() as { import: Record<string, any> }).import;
  assert.equal(record.source, 'imported'); assert.equal(record.kind, 'model'); assert.equal(record.name, 'oak tree'); assert.equal(record.sha256, sha(bytes));
  assert.deepEqual(record.model, { triangles: 1, meshes: 1, materials: 1, textures: 1, animations: 0, nodes: 1 });
  assert.equal(record.jobId, undefined, 'imports never carry a generation job id');
  assert.equal((await upload({ 'X-Arcane-Import-Consent': key })).status, 403, 'consent is single use');
  const again = await upload({ 'X-Arcane-Import-Consent': consent(store) });
  assert.equal(again.status, 200); assert.equal((await again.json() as { duplicate: boolean }).duplicate, true);
  const renamed = Buffer.from(bytes); renamed.write('PK', 0, 'latin1');
  const wrong = await upload({ 'X-Arcane-Import-Consent': consent(store) }, renamed);
  assert.equal(wrong.status, 400); assert.match((await wrong.json() as { message: string }).message, /not a GLB/);
  assert.equal((await upload({ 'X-Arcane-Import-Consent': consent(store) }, bytes, 'format=fbx&name=a.fbx')).status, 415);
  assert.equal((await upload({ 'X-Arcane-Import-Consent': consent(store) }, bytes, 'format=glb&name=a.glb&path=../../x')).status, 400, 'no extra query');
  const effect = await upload({ 'X-Arcane-Import-Consent': consent(store) }, Buffer.from(CAMPFIRE), 'format=rbxmx&name=campfire.rbxmx');
  assert.equal(effect.status, 201);
  const listed = await (await call('/v1/imports')).json() as { imports: Record<string, any>[] };
  assert.deepEqual(listed.imports.map(item => item.kind).sort(), ['effect', 'model']);
  const file = await call('/v1/imports/file?id=' + record.id);
  assert.equal(file.status, 200); assert.equal(file.headers.get('content-type'), 'model/gltf-binary');
  assert.equal(file.headers.get('content-length'), String(bytes.length)); assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(sha(Buffer.from(await file.arrayBuffer())), sha(bytes));
  for (const id of ['../../etc/passwd', '..%2F..%2Frecord', 'abc']) assert.equal((await call('/v1/imports/file?id=' + id)).status, 404, id);
  assert.equal((await call('/v1/imports/remove', { method: 'POST', body: JSON.stringify({ id: record.id }), headers: { 'Content-Type': 'application/json' } })).status, 403, 'remove needs the workspace origin');
  const removed = await call('/v1/imports/remove', { method: 'POST', body: JSON.stringify({ id: record.id }), headers: { 'Content-Type': 'application/json', Origin: origin } });
  assert.equal(removed.status, 200);
  assert.equal((await call('/v1/imports/file?id=' + record.id)).status, 404);
  assert.deepEqual((await readdir(join(state, 'imported-assets'))).filter(name => !name.startsWith('.')).length, 1);
});

test('renderer facts for imports: measured stats, VFX budgets and notes; records are re-validated', () => {
  const store = readImportedEffect(Buffer.from(CAMPFIRE));
  const asset = readImportedAsset({ schemaVersion: 1, id: '0f0e0d0c-0b0a-4908-8706-050403020100', source: 'imported', kind: 'effect', format: 'rbxmx', name: 'Campfire', fileName: 'campfire.rbxmx',
    bytes: 4096, sha256: 'e'.repeat(64), importedAt: '2026-10-22T08:00:00.000Z', model: null, effect: store }) as ImportedViewerAsset;
  assert.ok(asset);
  assert.equal(particleEstimate(asset.effect!.items[0]!), 44);
  const facts = importedFacts(asset);
  assert.equal(facts.kind, 'Imported effect');
  assert.deepEqual(facts.issues, []);
  assert.ok(facts.passed.includes('Every emitter within ' + EFFECT_BUDGETS.perEmitter + ' live particles'));
  assert.ok(facts.notes.some(note => /Beam is listed but not previewed/.test(note)));
  assert.ok(facts.notes.some(note => /never runs scripts/.test(note)));
  assert.ok(facts.notes.some(note => /capped: Drag/.test(note)));
  const rows = effectProperties(asset.effect!.items[0]!);
  assert.deepEqual(rows.slice(0, 3).map(row => [row.label, row.value]), [['Rate', '40 /s'], ['Lifetime', '0.6 – 1.1 s'], ['Speed', '3 – 5 studs/s']]);
  assert.deepEqual(rows.find(row => row.label === 'Size')?.curve, [1.6, 1.2, .2]);
  const busy = structuredClone(asset); (busy.effect!.items[0]!.props as Record<string, unknown>).Rate = 400;
  assert.match(importedFacts(busy).issues[0]!.title, /about 440 live particles/);
  assert.equal(readImportedAsset({ ...asset, source: 'generated' }), null, 'only imported records');
  assert.equal(readImportedAsset({ ...asset, id: '../x' }), null);
  assert.equal(formatBytes(2_427_968), '2.3 MB');
});
