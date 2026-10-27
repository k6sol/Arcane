import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, relative, isAbsolute} from 'node:path';
import {saveStudioFixture} from '../../packages/asset-pipeline/testing/studio-import-fixture.js';
import {adaptCompletedStudioImport} from '../../apps/daemon/src/asset-import-adapter.js';
import {createStudioImportManifestAuthority,type PreparedStudioImport,type GeneratedPreparedStudioImportV1} from '../../packages/asset-pipeline/src/studio-import-manifest.js';
import {decodeStudioImportPayload, type GeneratedStudioImportPayloadV1 as StudioImportPayload} from '../../packages/asset-pipeline/src/studio-import-payload.js';
import {createStudioImportTransfer, STUDIO_IMPORT_TRANSFER_LIMITS} from '../../packages/asset-pipeline/src/studio-import-transfer.js';

// Owned synthetic export bytes only: no Blender, Studio, providers or dispatch.
const JOB = '11111111-1111-4111-8111-111111111111';
const sha = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');
function generatedPreparation(value:PreparedStudioImport):value is GeneratedPreparedStudioImportV1 {return value.manifest.schemaVersion===1;}
async function fixture(t: test.TestContext) {
  const parent = tmpdir(), directory = await mkdtemp(join(parent, 'arcane-transfer-'));
  t.after(async () => {const path = relative(parent, directory); assert.ok(path.startsWith('arcane-transfer-') && !isAbsolute(path) && !path.includes('..')); await rm(directory, {recursive: true, force: true});});
  const manifest = await saveStudioFixture(directory, JOB);
  const exports = new Map<'asset.glb' | 'collision.glb', Buffer>();
  for (const name of ['asset.glb', 'collision.glb'] as const) exports.set(name, await readFile(join(directory, name)));
  const generated = adaptCompletedStudioImport(manifest, exports, sha('project'), {
    target: {sessionId: 'synthetic-session', placeId: 0, universeId: 0, root: 'Workspace', parentRef: 'synthetic-parent', creator: {kind: 'user', id: '123'}},
    placement: {mode: 'bottom-centre'}, studsPerMeter: 1 / 0.28,
  }, null);
  const authority = createStudioImportManifestAuthority({loadGeneratedFiles: async () => generated});
  t.after(() => authority.close());
  const prepared = authority.prepare(await authority.admit(JOB));
  assert.ok(generatedPreparation(prepared),'This fixture prepares generated version-one models.');
  const files = new Map(generated.files.map(f => [f.fileId, f.bytes]));
  const payload = decodeStudioImportPayload(prepared, files);
  return {prepared, payload, files};
}
test('staged packets are ordered, bounded, deterministic and pin the exact preparation target', async t => {
  const {prepared, payload} = await fixture(t), transfer = createStudioImportTransfer(prepared, payload);
  assert.equal(transfer.engineVerification, 'pending'); assert.equal(transfer.payloadDigest, payload.digest);
  assert.deepEqual(transfer, createStudioImportTransfer(prepared, payload));
  assert.ok(Object.isFrozen(transfer)); assert.ok(Object.isFrozen(transfer.packets));
  let bytes = 0;
  for (const [i, p] of transfer.packets.entries()) {
    assert.equal(p.ordinal, i); assert.equal(p.byteLength, Buffer.byteLength(p.json)); assert.equal(p.sha256, sha(p.json));
    assert.ok(p.byteLength <= STUDIO_IMPORT_TRANSFER_LIMITS.argumentBytes); bytes += p.byteLength;
    const args = JSON.parse(p.json); assert.equal(args.ordinal, i); assert.equal(args.kind, p.kind);
    assert.equal(args.payloadDigest, payload.digest); assert.equal(args.manifestDigest, prepared.manifest.digest);
  }
  assert.equal(transfer.byteLength, bytes);
  const begin = JSON.parse(transfer.packets[0]!.json), seal = JSON.parse(transfer.packets.at(-1)!.json);
  assert.deepEqual(begin.target, prepared.manifest.target); assert.deepEqual(begin.anchors, prepared.manifest.anchors);
  assert.equal(seal.precedingPacketCount, transfer.packets.length - 1);
  assert.equal(seal.precedingByteLength, bytes - transfer.packets.at(-1)!.byteLength);
  assert.equal(transfer.digest, sha(transfer.packets.map(p => p.sha256).join('\n')));
});
test('object declarations and chunks reassemble the original geometry with no duplicate or missing streams', async t => {
  const {prepared, payload} = await fixture(t), transfer = createStudioImportTransfer(prepared, payload);
  const bodies = transfer.packets.map(p => JSON.parse(p.json));
  const objects = bodies.filter(b => b.kind === 'object'); assert.equal(objects.length, payload.objects.length);
  for (const declaration of objects) {
    const original = payload.objects.find(o => o.object.sourceObjectId === declaration.object.sourceObjectId)!;
    assert.deepEqual(declaration.object, original.object); assert.deepEqual(declaration.material, original.material);
    for (const [i, primitive] of declaration.primitives.entries()) {
      for (const descriptor of [...Object.values(primitive.attributes), primitive.indices] as Record<string, any>[]) {
        const chunks = bodies.filter(b => b.kind === 'chunk' && b.streamId === descriptor.streamId);
        assert.deepEqual(chunks.map(c => ({offset: c.offset, byteLength: c.byteLength, sha256: c.sha256})), descriptor.chunks);
        const bytes = Buffer.concat(chunks.map(c => Buffer.from(c.data, 'base64')));
        assert.equal(bytes.length, descriptor.byteLength); assert.equal(sha(bytes), descriptor.sha256);
        const stream = descriptor.semantic === 'indices' ? original.primitives[i]!.indices : original.primitives[i]!.attributes[descriptor.semantic as 'POSITION']!;
        assert.deepEqual(bytes, Buffer.from(stream.bytes));
      }
    }
  }
});
test('mutable convenience buffers cannot change transferred immutable original chunks', async t => {
  const {prepared, payload} = await fixture(t), before = createStudioImportTransfer(prepared, payload);
  payload.objects[0]!.primitives[0]!.attributes.POSITION!.bytes.fill(255);
  assert.deepEqual(createStudioImportTransfer(prepared, payload), before);
});
test('clones, serialized claims and proxies do not acquire decoded-data provenance', async t => {
  const {prepared, payload} = await fixture(t); let reads = 0;
  const fake = Object.defineProperty({}, 'revisionId', {get() {reads++; return JOB;}}) as StudioImportPayload;
  for (const candidate of [fake, structuredClone(payload), {...payload}, new Proxy(payload, {})]) {
    assert.throws(() => createStudioImportTransfer(prepared, candidate), /decoded payload/);
  }
  assert.equal(reads, 0);
});
test('another preparation or creator cannot be substituted around authentic decoded data', async t => {
  const {prepared, payload} = await fixture(t);
  const other = structuredClone(prepared); (other.manifest.target as {creator: {id: string}}).creator.id = '999';
  assert.throws(() => createStudioImportTransfer(other, payload));
});
