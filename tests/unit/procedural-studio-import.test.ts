import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { adaptCompletedStudioImport } from '../../apps/daemon/src/asset-import-adapter.js';
import { saveStudioFixture } from '../../packages/asset-pipeline/testing/studio-import-fixture.js';
import { normalizeRequest } from '../../packages/asset-pipeline/src/validation.js';
import type { AssetManifest, AssetRequest, WorkerStudioImportEvidence } from '../../packages/asset-pipeline/src/types.js';
import { createStudioImportManifestAuthority, type StudioImportSelection } from '../../packages/asset-pipeline/src/studio-import-manifest.js';
import { decodeStudioImportPayload } from '../../packages/asset-pipeline/src/studio-import-payload.js';
import { createStudioImportTransfer, STUDIO_IMPORT_TRANSFER_LIMITS } from '../../packages/asset-pipeline/src/studio-import-transfer.js';

// Mandatory synthetic adapter/prepare/decode/transfer coverage invokes no worker,
// Studio, provider, upload or dispatch. Retained native exports are read only when
// explicit proof paths are supplied; those checks still perform no engine work.
const JOB = '11111111-1111-4111-8111-111111111111';
const PROJECT = '9'.repeat(64);
const selection: StudioImportSelection = {
  target: { sessionId: 'synthetic-procedural-session', placeId: 0, universeId: 0, root: 'Workspace',
    parentRef: 'synthetic-procedural-parent', creator: { kind: 'user', id: '123' } },
  placement: { mode: 'origin' }, studsPerMeter: 1 / 0.28,
};
const cases = [
  { kind: 'tree', keys: ['bark', 'leaves'] },
  { kind: 'rock', keys: ['rock'] },
  { kind: 'column', keys: ['stone'] },
  { kind: 'foliage', keys: ['foliage'] },
] as const;
type Kind = typeof cases[number]['kind'];
type Exports = Map<'asset.glb' | 'collision.glb', Buffer>;
type Doc = Record<string, any>; // Synthetic bounded GLB JSON, never external input.
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const identity = (request: AssetRequest, role: string, key: string) => 'arcane_' +
  sha(['arcane-semantic-v1', request.template, request.name, role, key].join('\0'));
const evidenceFailure = (error: unknown) => !!error && typeof error === 'object' &&
  (error as { code?: string }).code === 'STUDIO_IMPORT_EVIDENCE';
function unpack(bytes: Buffer): { doc: Doc; bin: Buffer } {
  const size = bytes.readUInt32LE(12);
  return { doc: JSON.parse(bytes.subarray(20, 20 + size).toString('utf8')) as Doc, bin: bytes.subarray(28 + size) };
}
function pack(doc: Doc, bin: Buffer): Buffer {
  const raw = Buffer.from(JSON.stringify(doc)), json = Buffer.alloc(Math.ceil(raw.length / 4) * 4, 0x20); raw.copy(json);
  const out = Buffer.alloc(28 + json.length + bin.length);
  out.writeUInt32LE(0x46546c67); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(json.length, 12); out.writeUInt32LE(0x4e4f534a, 16); json.copy(out, 20);
  out.writeUInt32LE(bin.length, 20 + json.length); out.writeUInt32LE(0x004e4942, 24 + json.length); bin.copy(out, 28 + json.length);
  return out;
}
function replaceModel(manifest: AssetManifest, exports: Exports, path: 'asset.glb' | 'collision.glb', bytes: Buffer): void {
  exports.set(path, bytes);
  const artifact = manifest.artifacts.find(a => a.path === path)!;
  artifact.bytes = bytes.length; artifact.sha256 = sha(bytes);
  const model = manifest.validation.studioImport!.models.find(m => m.path === path)!;
  model.byteLength = bytes.length; model.sha256 = artifact.sha256;
}
async function fixture(t: test.TestContext, kind: Kind, overrides: { renderKeys?: readonly string[]; collisionKey?: string; leafDensity?: number; manifestVersion?: 1 | 2 } = {}) {
  const parent = tmpdir(), directory = await mkdtemp(join(parent, 'arcane-procedural-import-'));
  t.after(async () => {
    const part = relative(parent, directory);
    assert.ok(part.startsWith('arcane-procedural-import-') && !isAbsolute(part) && !part.includes('..'));
    await rm(directory, { recursive: true, force: true });
  });
  const manifest = await saveStudioFixture(directory, JOB);
  manifest.schemaVersion = overrides.manifestVersion ?? 1;
  manifest.request = normalizeRequest({ template: 'procedural', name: 'procedural-' + kind,
    procedural: { kind, ...(kind === 'tree' && overrides.leafDensity !== undefined ? { leafDensity: overrides.leafDensity } : {}) } });
  const request = Buffer.from(JSON.stringify(manifest.request)), requestHash = sha(request);
  manifest.sourceRequestSha256 = requestHash;
  for (const path of ['request.json', 'input.json']) {
    const row = manifest.artifacts.find(a => a.path === path)!; row.sha256 = requestHash; row.bytes = request.length;
  }
  const evidence = manifest.validation.studioImport!, renderKeys = overrides.renderKeys ??
    (kind === 'tree' && overrides.leafDensity === 0 && manifest.schemaVersion === 2 ? ['bark'] : cases.find(c => c.kind === kind)!.keys);
  evidence.assetId = identity(manifest.request, 'asset', 'root'); evidence.requestSha256 = requestHash;
  const exports: Exports = new Map();
  for (const path of ['asset.glb', 'collision.glb'] as const) {
    const role = path === 'asset.glb' ? 'render' : 'collision';
    const keys = role === 'render' ? renderKeys : [overrides.collisionKey ?? 'proxy'];
    const { doc, bin } = unpack(await readFile(join(directory, path)));
    doc.nodes = doc.nodes.slice(0, keys.length); doc.meshes = doc.meshes.slice(0, keys.length);
    doc.scenes[0].nodes = keys.map((_, i) => i);
    const objects: WorkerStudioImportEvidence['models'][number]['objects'] = keys.map((sourceKey, i) => {
      const sourceObjectId = identity(manifest.request, role, sourceKey);
      const collisionFor = role === 'collision' ? renderKeys.map(k => identity(manifest.request, 'render', k)).sort() : [];
      doc.nodes[i].name = (role === 'render' ? 'SM_' : 'COL_') + sourceKey;
      doc.nodes[i].extras = { arcane_identity_scheme: 'arcane-semantic-v1', arcane_source_key: sourceKey,
        arcane_source_object_id: sourceObjectId, arcane_role: role, arcane_pivot: [0, 0, 0], arcane_collision_for: JSON.stringify(collisionFor) };
      return { sourceObjectId, sourceKey, nodeIndex: i, role, pivot: [0, 0, 0], collisionFor };
    });
    evidence.models.find(m => m.path === path)!.objects = objects;
    replaceModel(manifest, exports, path, pack(doc, bin));
  }
  return { manifest, exports };
}
async function stage(t: test.TestContext, manifest: AssetManifest, exports: Exports, target = selection) {
  const generated = adaptCompletedStudioImport(manifest, exports, PROJECT, target, null);
  const authority = createStudioImportManifestAuthority({ loadGeneratedFiles: async () => generated });
  t.after(() => authority.close());
  const prepared = authority.prepare(await authority.admit(manifest.jobId));
  const payload = decodeStudioImportPayload(prepared, new Map(generated.files.map(f => [f.fileId, f.bytes])));
  const transfer = createStudioImportTransfer(prepared, payload);
  assert.equal(prepared.manifest.engineVerification, 'pending'); assert.equal(payload.engineVerification, 'pending');
  assert.equal(transfer.engineVerification, 'pending'); assert.equal(transfer.payloadDigest, payload.digest);
  assert.equal(payload.sourceSha256, generated.sourceSha256);
  assert.equal(generated.sourceSha256, sha(['input.json', 'request.json', 'asset.blend'].map(path =>
    manifest.artifacts.find(a => a.path === path)!.sha256).concat(manifest.templateSha256).join('\n')));
  assert.equal(payload.objects.length, manifest.validation.studioImport!.models.reduce((n, model) => n + model.objects.length, 0));
  for (const model of manifest.validation.studioImport!.models) {
    const fileId = model.path === 'asset.glb' ? 'render-export' : 'collision-export';
    assert.equal(payload.files.find(f => f.fileId === fileId)!.sha256, sha(exports.get(model.path)!));
    for (const object of model.objects) {
      const decoded = payload.objects.find(o => o.object.sourceObjectId === object.sourceObjectId)!;
      assert.ok(decoded); assert.equal(decoded.object.role, object.role);
      assert.deepEqual(decoded.object.collisionFor, object.collisionFor);
      assert.equal(decoded.provenance.node.extras && (decoded.provenance.node.extras as Doc).arcane_source_key, object.sourceKey);
      assert.ok(decoded.primitives.every(p => p.triangleCount > 0));
    }
  }
  const packets = transfer.packets.map(packet => {
    assert.ok(packet.byteLength <= STUDIO_IMPORT_TRANSFER_LIMITS.argumentBytes);
    assert.equal(packet.sha256, sha(packet.json)); return JSON.parse(packet.json) as Doc;
  });
  assert.equal(packets[0]!.kind, 'begin'); assert.deepEqual(packets[0]!.target, target.target);
  assert.equal(packets.at(-1)!.kind, 'seal');
  assert.equal(packets.at(-1)!.precedingPacketCount, packets.length - 1);
  assert.equal(transfer.digest, sha(transfer.packets.map(p => p.sha256).join('\n')));
  for (const packet of packets.filter(p => p.kind === 'chunk')) {
    const bytes = Buffer.from(packet.data, 'base64'); assert.equal(bytes.length, packet.byteLength); assert.equal(sha(bytes), packet.sha256);
  }
  return { prepared, payload, transfer };
}

for (const { kind, keys } of cases) test('procedural ' + kind + ' adapts exact producer keys through prepared sealed transfer', async t => {
  const f = await fixture(t, kind), result = await stage(t, f.manifest, f.exports);
  const objects = result.prepared.manifest.objects;
  assert.deepEqual(objects.filter(o => o.role === 'render').map(o => o.sourceObjectId).sort(), keys.map(k => identity(f.manifest.request, 'render', k)).sort());
  assert.deepEqual(objects.filter(o => o.role === 'collision').map(o => o.sourceObjectId), [identity(f.manifest.request, 'collision', 'proxy')]);
  assert.equal(result.payload.textures?.length ?? 0, 0);
});

for (const manifestVersion of [1, 2] as const) test('zero-density manifest v' + manifestVersion + ' retains its exact render set through sealed import', async t => {
  const f = await fixture(t, 'tree', { leafDensity: 0, manifestVersion }), result = await stage(t, f.manifest, f.exports);
  const keys = manifestVersion === 1 ? ['bark', 'leaves'] : ['bark'];
  assert.deepEqual(result.prepared.manifest.objects.filter(o => o.role === 'render').map(o => o.sourceObjectId).sort(),
    keys.map(k => identity(f.manifest.request, 'render', k)).sort());
  assert.deepEqual(result.prepared.manifest.objects.find(o => o.role === 'collision')!.collisionFor,
    keys.map(k => identity(f.manifest.request, 'render', k)).sort());
  const rewritten = { ...f.manifest, schemaVersion: manifestVersion === 1 ? 2 : 1 } as AssetManifest;
  assert.throws(() => adaptCompletedStudioImport(rewritten, f.exports, PROJECT, selection, null), evidenceFailure);
});

test('positive tiny density still requires leaves and cannot masquerade as a new bare tree', async t => {
  const f = await fixture(t, 'tree', { leafDensity: 1e-8, manifestVersion: 2, renderKeys: ['bark'] });
  assert.throws(() => adaptCompletedStudioImport(f.manifest, f.exports, PROJECT, selection, null), evidenceFailure);
});

for (const overrides of [{ renderKeys: ['body'] }, { renderKeys: ['bark'] }, { renderKeys: ['bark', 'leaves', 'extra'] }, { collisionKey: 'body_proxy' }])
  test('procedural import refuses rewritten producer keys ' + JSON.stringify(overrides), async t => {
    const f = await fixture(t, 'tree', overrides);
    assert.throws(() => adaptCompletedStudioImport(f.manifest, f.exports, PROJECT, selection, null), evidenceFailure);
  });

test('procedural admission retains byte, object identity, collision target and request provenance checks', async t => {
  const f = await fixture(t, 'tree');
  const changedBytes = new Map(f.exports); changedBytes.set('asset.glb', Buffer.from('changed export'));
  assert.throws(() => adaptCompletedStudioImport(f.manifest, changedBytes, PROJECT, selection, null), evidenceFailure);
  const wrongInput = structuredClone(f.manifest); wrongInput.sourceRequestSha256 = '0'.repeat(64);
  assert.throws(() => adaptCompletedStudioImport(wrongInput, f.exports, PROJECT, selection, null), evidenceFailure);
  const wrongCollision = structuredClone(f.manifest);
  wrongCollision.validation.studioImport!.models.find(m => m.path === 'collision.glb')!.objects[0]!.collisionFor = [];
  assert.throws(() => adaptCompletedStudioImport(wrongCollision, f.exports, PROJECT, selection, null), evidenceFailure);
  const { doc, bin } = unpack(f.exports.get('asset.glb')!);
  doc.nodes[0].extras.arcane_source_object_id = identity(f.manifest.request, 'render', 'forged');
  replaceModel(f.manifest, f.exports, 'asset.glb', pack(doc, bin));
  assert.throws(() => adaptCompletedStudioImport(f.manifest, f.exports, PROJECT, selection, null), evidenceFailure);
});

test('procedural sealed transfer retains decoded provenance and exact creator target binding', async t => {
  const f = await fixture(t, 'rock'), { prepared, payload } = await stage(t, f.manifest, f.exports);
  assert.throws(() => createStudioImportTransfer(prepared, structuredClone(payload)), /decoded payload/);
  const otherCreator = structuredClone(prepared); (otherCreator.manifest.target.creator as { id: string }).id = '999';
  assert.throws(() => createStudioImportTransfer(otherCreator, payload));
});

const nativeSummary = process.env.ARCANE_PROCEDURAL_NATIVE_SUMMARY;
const deliveryReport = process.env.ARCANE_PROCEDURAL_DELIVERY_REPORT;
for (const kind of ['oak', 'rock', 'column']) test('retained native ' + kind + ' GLBs adapt, prepare, decode textures and seal offline',
  { skip: !nativeSummary || !deliveryReport }, async t => {
    const summary = JSON.parse(await readFile(nativeSummary!, 'utf8')) as { cases: { kind: string; state: string; directory: string; jobId: string; triangles: number; materials: number }[] };
    const proof = summary.cases.find(c => c.kind === kind)!; assert.ok(proof); assert.equal(proof.state, 'succeeded');
    const report = JSON.parse(await readFile(deliveryReport!, 'utf8')) as { offlineSelection: StudioImportSelection };
    const manifest = JSON.parse(await readFile(join(proof.directory, 'manifest.json'), 'utf8')) as AssetManifest;
    assert.equal(manifest.jobId, proof.jobId); assert.equal(manifest.validation.totals.renderTriangles, proof.triangles);
    const exports: Exports = new Map();
    for (const path of ['asset.glb', 'collision.glb'] as const) exports.set(path, await readFile(join(proof.directory, path)));
    const { prepared, payload, transfer } = await stage(t, manifest, exports, report.offlineSelection);
    assert.equal(prepared.manifest.textures.length, proof.materials * 3);
    assert.equal(payload.textures!.length, proof.materials * 4);
    assert.equal(payload.objects.filter(o => o.object.role === 'render').reduce((n, o) => n + o.primitives.reduce((sum, p) => sum + p.triangleCount, 0), 0), proof.triangles);
    for (const object of payload.objects.filter(o => o.object.role === 'render')) {
      assert.ok(object.primitives.every(p => p.attributes.TEXCOORD_0));
      assert.deepEqual(Object.keys(object.textureBindings!).sort(), ['ColorMap', 'MetalnessMap', 'NormalMap', 'RoughnessMap']);
    }
    assert.equal(transfer.packets.filter(p => p.kind === 'texture').length, proof.materials * 4);
  });
