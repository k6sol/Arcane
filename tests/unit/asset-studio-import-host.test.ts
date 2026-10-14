import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile, truncate } from 'node:fs/promises';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { createAssetService, type AssetService } from '../../apps/daemon/src/asset-service.js';
import { createNativeAssetRegistry, type NativeAssetActor } from '../../apps/daemon/src/native-asset-authority.js';
import { ConversationWorkStore } from '../../packages/storage/src/conversation-work-store.js';
import { StudioImportManifestError, STUDIO_IMPORT_LIMITS, type PreparedStudioImport, type StudioImportBaseline, type StudioImportSelection } from '../../packages/asset-pipeline/src/studio-import-manifest.js';
import { saveStudioFixture, saveFixtureManifest, fixtureId } from '../../packages/asset-pipeline/testing/studio-import-fixture.js';
import { sha256 } from '../../packages/asset-pipeline/src/validation.js';

// Real AssetService, file readers, manifest validation, native registry, SQLite
// and strict preparation authority. All job bytes/ACKs/receipts are SYNTHETIC;
// zero native workers, SDK, Studio, provider, upload, or credential-file reads.
const JOB = '11111111-1111-4111-8111-111111111111', NEXT = '22222222-2222-4222-8222-222222222222';
const conversation = { provider: 'codex' as const, threadId: 'fixture-thread', sessionId: null };
const selection: StudioImportSelection = { target: { sessionId: 'synthetic-studio-session', placeId: 0, universeId: 0,
  root: 'Workspace', parentRef: 'synthetic-parent', creator: { kind: 'user', id: '1234' } }, placement: { mode: 'bottom-centre' }, studsPerMeter: 1/0.28 };
const code = (expected: string) => (error: unknown) => !!error && typeof error === 'object' && (error as { code?: string }).code === expected;
function deferred() { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; }
async function harness(t: test.TestContext, old = false) {
  const spawn = childProcess.spawn; let spawns = 0;
  childProcess.spawn = (() => { spawns++; throw Error('Native spawn forbidden in synthetic host preparation'); }) as typeof spawn;
  syncBuiltinESMExports();
  const boundary = await realpath(tmpdir()), directory = await mkdtemp(join(boundary, 'arcane-studio-host-'));
  const project = await realpath(directory), outputRoot = join(project, 'outputs'); await mkdir(outputRoot);
  const jobDirectory = join(outputRoot, 'test-kit-' + JOB); await mkdir(jobDirectory);
  const manifest = await saveStudioFixture(jobDirectory, JOB, { evidence: !old });
  const nextDirectory = join(outputRoot, 'test-kit-' + NEXT); await mkdir(nextDirectory);
  await saveStudioFixture(nextDirectory, NEXT, { wide: true });
  const store = new ConversationWorkStore({ directory: join(project, 'state'), projectPath: project });
  store.bind({ conversation, kind: 'asset-job', id: JOB }); store.bind({ conversation, kind: 'asset-job', id: NEXT });
  const registry = createNativeAssetRegistry({ projectPath: project });
  const incarnation = registry.issue(), binding = { connectionId: 'fixture-connection', threadId: conversation.threadId };
  incarnation.seal({ ...binding, provider: 'codex', sessionId: null }); incarnation.grant(binding);
  incarnation.dispatched({ ...binding, operationId: 'fixture-intent' });
  const actor = registry.capture(incarnation.credential(), 'mutate');
  let choose = async () => selection, load = async (): Promise<StudioImportBaseline | null> => null;
  let persist = async (): Promise<void> => {};
  let selections = 0, baselines = 0;
  let service: AssetService | undefined;
  t.after(async () => {
    try { await service?.close(); store.close(); registry.close(); assert.equal(spawns, 0); }
    finally {
      childProcess.spawn = spawn; syncBuiltinESMExports();
      const part = relative(boundary, directory); assert.ok(part.startsWith('arcane-studio-host-') && !isAbsolute(part) && !part.includes('..'));
      await rm(directory, { recursive: true, force: true });
    }
  });
  service = await createAssetService({ cwd: project, projectPath: project, outputRoot, studioImport: { workAssociations: store,
    selectTarget: async () => { selections++; return choose(); }, loadObservedBaseline: async () => { baselines++; return load(); },
    recordPrepared: async () => persist() } });
  return { service, store, registry, incarnation, actor, manifest, jobDirectory, nextDirectory,
    selection: (fn: typeof choose) => { choose = fn; }, baseline: (fn: typeof load) => { load = fn; }, persist: (fn: typeof persist) => { persist = fn; }, counts: () => ({ selections, baselines }) };
}
function baseline(prepared: PreparedStudioImport): StudioImportBaseline {
  return { manifest: structuredClone(prepared.manifest) as StudioImportBaseline['manifest'], receipt: {
    manifestDigest: prepared.manifest.digest, receiptSha256: sha256(Buffer.from('SYNTHETIC receipt')), modelRef: 'synthetic-model', modelAssetId: '7001',
    objects: prepared.manifest.objects.map(o => ({ sourceObjectId: o.sourceObjectId, instanceRef: 'instance-' + o.sourceObjectId,
      meshAssetId: '7002', ownedStateSha256: sha256(Buffer.from('owned synthetic state')), authoredChildren: [
        { instanceRef: 'script-' + o.sourceObjectId, kind: 'script', stateSha256: sha256(Buffer.from('script')) },
        { instanceRef: 'attach-' + o.sourceObjectId, kind: 'attachment', stateSha256: sha256(Buffer.from('attachment')) },
        { instanceRef: 'constraint-' + o.sourceObjectId, kind: 'constraint', stateSha256: sha256(Buffer.from('constraint')) },
      ] })) } };
}
test('owned completed production service prepares strict manifest from real synthetic artifact bytes', async t => {
  const f = await harness(t), result = await f.service.prepareStudioImport(JOB, f.actor);
  assert.equal(result.status, 'prepared'); assert.equal(result.manifest.engineVerification, 'pending');
  assert.equal(result.manifest.assetId, fixtureId('asset', 'root')); assert.equal(result.manifest.objects.length, 8);
  assert.equal(result.manifest.producer.exporterVersion, 'Khronos glTF Blender IO v4.5.0');
  assert.equal(result.manifest.files.length, 2); assert.equal(result.delta.objects.every(o => o.action === 'create'), true);
  for (const row of result.manifest.files) assert.equal(row.sha256, f.manifest.artifacts.find(a => a.path === (row.fileId === 'render-export' ? 'asset.glb' : 'collision.glb'))!.sha256);
  const json = JSON.stringify(result); for (const text of ['synthetic-not-run', f.jobDirectory, 'credential', 'executable', 'input.json']) assert.equal(json.includes(text), false);
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.delta)); assert.deepEqual(f.counts(), { selections: 1, baselines: 1 });
  assert.equal(result.digest, (await f.service.prepareStudioImport(JOB, f.actor)).digest);
});
test('producer IDs persist across revisions and only changed meshes update while authored children remain', async t => {
  const f = await harness(t), previous = await f.service.prepareStudioImport(JOB, f.actor), receipt = baseline(previous);
  f.baseline(async () => receipt);
  const result = await f.service.prepareStudioImport(NEXT, f.actor);
  assert.deepEqual(result.manifest.objects.map(o => o.sourceObjectId), previous.manifest.objects.map(o => o.sourceObjectId));
  assert.equal(result.delta.objects.filter(o => o.action === 'update-in-place').length, 2);
  assert.equal(result.delta.objects.filter(o => o.action === 'reuse').length, 6);
  assert.equal(result.delta.geometry.prepare.length, 1); assert.equal(result.delta.geometry.reuse.length, 1);
  for (const obj of result.delta.objects) { assert.equal(obj.replaceInstance, false); assert.equal(obj.deleteInstance, false); assert.equal(obj.preserveChildren.length, 3); }
});
test('baseline authority stays in host configuration and wrong asset/session receipts refuse', async t => {
  const f = await harness(t), previous = await f.service.prepareStudioImport(JOB, f.actor), receipt = baseline(previous);
  receipt.manifest.target.sessionId = 'wrong-session'; f.baseline(async () => receipt);
  await assert.rejects(f.service.prepareStudioImport(NEXT, f.actor), error => error instanceof StudioImportManifestError && error.code === 'BASELINE');
  await assert.rejects(f.service.prepareStudioImport({ jobId: JOB, baseline: receipt }, f.actor), code('INPUT'));
});
test('forged and read actors, unbound jobs and different conversations cannot select a target', async t => {
  const f = await harness(t);
  await assert.rejects(f.service.prepareStudioImport(JOB, { kind: 'native-asset-actor' } as NativeAssetActor), code('NATIVE_ASSET_AUTHORITY'));
  await assert.rejects(f.service.prepareStudioImport(JOB, f.registry.capture(f.incarnation.credential(), 'read')), code('NATIVE_ASSET_AUTHORITY'));
  const other = f.registry.issue(); other.seal({ connectionId: 'other-connection', provider: 'codex', threadId: 'other-thread', sessionId: null });
  other.grant({ connectionId: 'other-connection', threadId: 'other-thread' }); other.dispatched({ connectionId: 'other-connection', threadId: 'other-thread', operationId: 'other-intent' });
  await assert.rejects(f.service.prepareStudioImport(JOB, f.registry.capture(other.credential(), 'mutate')), code('NOT_FOUND'));
  await assert.rejects(f.service.prepareStudioImport('33333333-3333-4333-8333-333333333333', f.actor), code('NOT_FOUND'));
  assert.deepEqual(f.counts(), { selections: 0, baselines: 0 });
});
test('older completed jobs remain downloadable but are explicitly unsupported for Studio preparation', async t => {
  const f = await harness(t, true);
  assert.ok((await f.service.artifact(JOB, 'asset.glb')).bytes.length);
  await assert.rejects(f.service.prepareStudioImport(JOB, f.actor), code('STUDIO_IMPORT_UNSUPPORTED'));
  assert.deepEqual(f.counts(), { selections: 0, baselines: 0 });
});
for (const method of ['prepareStudioImport', 'prepareStudioImportPayload'] as const)
for (const stage of ['manifest', 'target', 'artifact', 'baseline', 'persistence'] as const) test(method + ' fences the same native capture after awaited ' + stage, async t => {
  const f = await harness(t);
  if (stage === 'manifest') { const fn = f.service.manifest.bind(f.service); f.service.manifest = async job => { const result = await fn(job); f.incarnation.revokeGrant(); return result; }; }
  if (stage === 'target') f.selection(async () => { f.incarnation.revokeGrant(); return selection; });
  if (stage === 'artifact') { const fn = f.service.artifact.bind(f.service); f.service.artifact = async (job, path) => { const result = await fn(job, path); f.incarnation.revokeGrant(); return result; }; }
  if (stage === 'baseline') f.baseline(async () => { f.incarnation.revokeGrant(); return null; });
  if (stage === 'persistence') f.persist(async () => { f.incarnation.revokeGrant(); });
  await assert.rejects(f.service[method](JOB, f.actor), code('NATIVE_ASSET_AUTHORITY'));
});
test('a pending selection is single-flight and service close fences the awaited result', async t => {
  const f = await harness(t), started = deferred(), gate = deferred();
  f.selection(async () => { started.release(); await gate.promise; return selection; });
  const result = f.service.prepareStudioImport(JOB, f.actor); await started.promise;
  await assert.rejects(f.service.prepareStudioImport(NEXT, f.actor), code('BUSY'));
  await f.service.close(); gate.release(); await assert.rejects(result, code('CLOSED'));
});
test('oversized fixed exports fail before full loading and changed artifact bytes fail verification', async t => {
  const f = await harness(t);
  await truncate(join(f.jobDirectory, 'asset.glb'), STUDIO_IMPORT_LIMITS.fileBytes+1);
  await assert.rejects(f.service.prepareStudioImport(JOB, f.actor), code('ARTIFACT'));
  assert.deepEqual(f.counts(), { selections: 0, baselines: 0 });
  await saveStudioFixture(f.jobDirectory, JOB);
  await writeFile(join(f.jobDirectory, 'asset.glb'), Buffer.from('tampered'));
  await assert.rejects(f.service.prepareStudioImport(JOB, f.actor), code('MANIFEST'));
});
test('schema, producer IDs and bytes must agree even with rewritten fixture audit checksums', async t => {
  const f = await harness(t), evidence = f.manifest.validation.studioImport!;
  evidence.models[0]!.objects[0]!.sourceObjectId = fixtureId('render', 'fake');
  await saveFixtureManifest(f.jobDirectory, f.manifest);
  await assert.rejects(f.service.prepareStudioImport(JOB, f.actor), code('STUDIO_IMPORT_EVIDENCE'));
  evidence.models[0]!.objects[0]!.sourceObjectId = fixtureId('render', 'floor');
  (evidence as unknown as Record<string, unknown>).secret = 'fixture-only'; await saveFixtureManifest(f.jobDirectory, f.manifest);
  await assert.rejects(f.service.prepareStudioImport(JOB, f.actor), code('STUDIO_IMPORT_EVIDENCE'));
});
test('GLB metadata forgery and unsupported material extensions fail through production service', async t => {
  const f = await harness(t);
  await saveStudioFixture(f.jobDirectory, JOB, { mutate: doc => { doc.nodes[0].extras.arcane_source_object_id = fixtureId('render', 'fake'); } });
  await assert.rejects(f.service.prepareStudioImport(JOB, f.actor), code('STUDIO_IMPORT_EVIDENCE'));
  await saveStudioFixture(f.jobDirectory, JOB, { mutate: doc => {
    doc.extensionsUsed = ['KHR_materials_unlit']; doc.materials[0].extensions = { KHR_materials_unlit: {} };
  } });
  await assert.rejects(f.service.prepareStudioImport(JOB, f.actor), error => error instanceof StudioImportManifestError && error.code === 'EXPORT');
});
test('host target selection cannot inject extra paths, baseline or getters into the strict input', async t => {
  const f = await harness(t); let reads = 0;
  const malicious = Object.defineProperty({ ...selection }, 'target', { enumerable: true, get() { reads++; return selection.target; } });
  f.selection(async () => malicious);
  await assert.rejects(f.service.prepareStudioImport(JOB, f.actor)); assert.equal(reads, 0);
  f.selection(async () => ({ ...selection, baseline: {} })); await assert.rejects(f.service.prepareStudioImport(JOB, f.actor));
});

for (const method of ['prepareStudioImport', 'prepareStudioImportPayload'] as const)
test(method + ' refuses forged actors and caller-controlled targets', async t => {
  const f = await harness(t);
  await assert.rejects(f.service[method](JOB, { kind: 'native-asset-actor' } as NativeAssetActor), code('NATIVE_ASSET_AUTHORITY'));
  await assert.rejects(f.service[method]({ jobId: JOB, target: selection.target }, f.actor), code('INPUT'));
  await assert.rejects(f.service[method](JOB, f.registry.capture(f.incarnation.credential(), 'read')), code('NATIVE_ASSET_AUTHORITY'));
  assert.deepEqual(f.counts(), { selections: 0, baselines: 0 });
});

test('payload staging and metadata preparation share single-flight and lifetime fencing', async t => {
  const f = await harness(t), started = deferred(), gate = deferred();
  f.selection(async () => { started.release(); await gate.promise; return selection; });
  const pending = f.service.prepareStudioImportPayload(JOB, f.actor); await started.promise;
  await assert.rejects(f.service.prepareStudioImport(NEXT, f.actor), code('BUSY'));
  await assert.rejects(f.service.prepareStudioImportPayload(NEXT, f.actor), code('BUSY'));
  await f.service.close(); gate.release(); await assert.rejects(pending, code('CLOSED'));
});

test('payload staging rejects changed owned bytes and unsupported historical producer jobs', async t => {
  const f = await harness(t, true);
  await assert.rejects(f.service.prepareStudioImportPayload(JOB, f.actor), code('STUDIO_IMPORT_UNSUPPORTED'));
  assert.deepEqual(f.counts(), { selections: 0, baselines: 0 });
  await saveStudioFixture(f.jobDirectory, JOB);
  await writeFile(join(f.jobDirectory, 'asset.glb'), Buffer.from('tampered'));
  await assert.rejects(f.service.prepareStudioImportPayload(JOB, f.actor), code('MANIFEST'));
});

test('owned payload intake preserves prepared identity, actual mesh streams and chunk checksums without dispatch', async t => {
  const f = await harness(t), result = await f.service.prepareStudioImportPayload(JOB, f.actor);
  assert.equal(result.prepared.manifest.engineVerification, 'pending');
  assert.equal(result.payload.engineVerification, 'pending');
  assert.equal(result.payload.manifestDigest, result.prepared.manifest.digest);
  assert.equal(result.payload.preparedDigest, result.prepared.digest);
  assert.equal(result.payload.projectId, result.prepared.manifest.projectId);
  assert.equal(result.payload.revisionId, JOB);
  assert.equal(result.payload.objects.length, 8);
  assert.deepEqual(result.payload.files, result.prepared.manifest.files);
  for (const item of result.payload.objects) {
    assert.deepEqual(item.object, result.prepared.manifest.objects.find(o => o.sourceObjectId === item.object.sourceObjectId));
    assert.equal(item.primitives.length, 1);
    const primitive = item.primitives[0]!;
    assert.equal(primitive.vertexCount, 4); assert.equal(primitive.triangleCount, 4);
    assert.equal(primitive.attributes.POSITION!.bytes.byteLength, 48);
    assert.equal(primitive.attributes.NORMAL!.bytes.byteLength, 48);
    assert.equal(primitive.indices.bytes.byteLength, 12);
    for (const stream of [primitive.attributes.POSITION!, primitive.attributes.NORMAL!, primitive.indices]) {
      assert.equal(sha256(Buffer.from(stream.bytes)), stream.sha256);
      for (const chunk of stream.chunks) {
        const bytes = Buffer.from(chunk.data, 'base64');
        assert.equal(bytes.length, chunk.byteLength); assert.equal(sha256(bytes), chunk.sha256);
        assert.ok(Buffer.byteLength(JSON.stringify(chunk)) < 256 * 1024);
      }
    }
  }
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.payload));
  assert.deepEqual(f.counts(), { selections: 1, baselines: 1 });
});

test('owned payload intake keeps emissive production material data rather than dropping it', async t => {
  const f = await harness(t);
  await saveStudioFixture(f.jobDirectory, JOB, { mutate: doc => {
    if (doc.materials) {
      doc.extensionsUsed = ['KHR_materials_emissive_strength'];
      doc.materials[0].emissiveFactor = [0.2, 0.1, 0];
      doc.materials[0].extensions = { KHR_materials_emissive_strength: { emissiveStrength: 2 } };
    }
  } });
  const result = await f.service.prepareStudioImportPayload(JOB, f.actor);
  const expected = result.prepared.manifest.materials[0]!.emission;
  assert.deepEqual(expected, { factor: [0.2, 0.1, 0], strength: 2, map: null });
  for (const o of result.payload.objects.filter(o => o.object.role === 'render')) assert.deepEqual(o.material!.emission, expected);
  assert.equal(result.payload.engineVerification, 'pending');
});
