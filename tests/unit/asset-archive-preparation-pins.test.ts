import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdir, mkdtemp, realpath, rm, readFile, writeFile, readdir, lstat, open, link } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ArcaneError } from '../../packages/protocol/src/providers.js';
import type { StudioImportContextObservation } from '../../packages/protocol/src/studio.js';
import { StudioStore } from '../../packages/storage/src/studio-store.js';
import { ConversationWorkStore } from '../../packages/storage/src/conversation-work-store.js';
import { createAssetService } from '../../apps/daemon/src/asset-service.js';
import { adaptCompletedStudioImport, assertStudioImportJobScope } from '../../apps/daemon/src/asset-import-adapter.js';
import { createNativeAssetRegistry, type NativeAssetActor } from '../../apps/daemon/src/native-asset-authority.js';
import { createStudioImportPreparationStore, STUDIO_IMPORT_PREPARATION_LIMITS, type StudioImportPreparationStore, type StudioImportPreparationPins } from '../../apps/daemon/src/studio-import-preparation-store.js';
import { parseNativeStudioImportResponse } from '../../packages/asset-pipeline/src/studio-import-wire.js';
import { saveStudioFixture } from '../../packages/asset-pipeline/testing/studio-import-fixture.js';
import { createStudioImportManifestAuthority, type PreparedStudioImport, type StudioImportSelection } from '../../packages/asset-pipeline/src/studio-import-manifest.js';

// Archival pins use real filesystem, SQLite receipts, conversation bindings and the production prepared
// codec. All pairings, observations and exported bytes are synthetic and local;
// no Studio/SDK/provider/Blender process or credential file is accessed.
const JOB = '11111111-1111-4111-8111-111111111111', NEXT = '22222222-2222-4222-8222-222222222222';
const HASH = 'a'.repeat(64), THREAD = { provider: 'codex' as const, threadId: 'preparation-fixture-thread', sessionId: null };
const guard = () => {};
const refused = (code: string) => (error: unknown) => error instanceof ArcaneError && error.code === code;
const code = (suffix: string) => refused('STUDIO_IMPORT_PREPARATION_' + suffix);
function gate() { let release!: () => void; const promise = new Promise<void>(accept => { release = accept; }); return { promise, release }; }

async function fixture(t: test.TestContext, local = false) {
  const boundary = await realpath(tmpdir()), root = await mkdtemp(join(boundary, 'arcane-preparation-store-')), projectPath = await realpath(root);
  let now = Date.now(), epoch = 0;
  const cws = new ConversationWorkStore({ directory: join(root, 'bindings'), projectPath });
  cws.bind({ kind: 'asset-job', id: JOB, conversation: THREAD }); cws.bind({ kind: 'asset-job', id: NEXT, conversation: THREAD });
  const registry = createNativeAssetRegistry({ projectPath }), incarnation = registry.issue(), binding = { connectionId: 'fixture-connection', threadId: THREAD.threadId };
  incarnation.seal({ ...binding, ...THREAD }); incarnation.grant(binding); incarnation.dispatched({ ...binding, operationId: 'fixture-intent' });
  const actor = registry.capture(incarnation.credential(), 'mutate');
  const studio = new StudioStore({ directory: join(root, 'studio-state'), now: () => now });
  const grant = studio.createGrant({ allowedRoots: ['Workspace', 'ServerStorage'], allowWrites: true });
  const pair = studio.pair({ code: grant.code, protocolVersion: 1, identity: { clientSessionId: 'fixture-plugin-lifetime',
    placeId: local ? 0 : 12, universeId: local ? 0 : 34, name: 'Synthetic preparation receipts', pluginVersion: 'fixture' }, capabilities: ['scene.import_context', 'selection.read'] });
  const observation: StudioImportContextObservation = { sessionId: pair.sessionId, root: 'Workspace',
    parentRef: { instanceId: 'fixture-workspace', sessionId: pair.sessionId, root: 'Workspace', pathSegments: [], className: 'Workspace' },
    placeId: local ? 0 : 12, universeId: local ? 0 : 34, mode: 'Edit', modeProvenance: 'StudioTestService.EditModeActive',
    creator: local ? { status: 'unavailable', kind: null, id: 0, provenance: 'game.CreatorType/CreatorId' }
      : { status: 'available', kind: 'group', id: 56, provenance: 'game.CreatorType/CreatorId' },
    studioUser: local ? { status: 'available', id: 78, provenance: 'StudioService:GetUserId' }
      : { status: 'not_applicable', id: null, provenance: 'StudioService:GetUserId' } };
  function heartbeat(mode: 'Edit' | 'Play' = 'Edit', playEpoch = epoch) {
    return { sessionId: pair.sessionId, clientLifetimeId: 'fixture-plugin-lifetime', pluginArtifactHash: HASH,
      markerName: 'ArcaneTestProof_fixture', placeId: observation.placeId, universeId: observation.universeId,
      placeName: 'Synthetic preparation receipts', mode, playEpoch, continuitySupported: true, connected: true };
  }
  function receipt(value: StudioImportContextObservation = observation) {
    const queued = studio.enqueue({ sessionId: pair.sessionId, requestId: 'fixture-context-' + randomUUID(), method: 'scene.import_context', args: {} });
    assert.equal(studio.poll(pair.sessionId, heartbeat())[0]!.id, queued.id);
    studio.result({ sessionId: pair.sessionId, commandId: queued.id, state: 'succeeded', result: value }); return queued.id;
  }
  const witness = { initialContextReceiptId: receipt(), confirmedContextReceiptId: receipt(), pluginArtifactHash: HASH,
    clientLifetimeId: 'fixture-plugin-lifetime', playEpoch: 0 };
  const outputRoot = join(root, 'outputs'); await mkdir(outputRoot);
  const sources = new Map<string, { manifest: Awaited<ReturnType<typeof saveStudioFixture>>; exports: Map<'asset.glb' | 'collision.glb', Buffer> }>();
  async function sourceFor(job: string) {
    const existing = sources.get(job); if (existing) return existing;
    assert.ok(job === JOB || job === NEXT);
    const directory = join(outputRoot, 'test-kit-' + job); await mkdir(directory);
    const manifest = await saveStudioFixture(directory, job), exports = new Map<'asset.glb' | 'collision.glb', Buffer>();
    for (const name of ['asset.glb', 'collision.glb'] as const) exports.set(name, await readFile(join(directory, name)));
    const source = { manifest, exports }; sources.set(job, source); return source;
  }
  let studsPerMeter = 1 / 0.28, parentRef = 'fixture-workspace';
  const selection = (): StudioImportSelection => ({ target: { sessionId: pair.sessionId, placeId: observation.placeId, universeId: observation.universeId,
      root: 'Workspace', parentRef, creator: local ? { kind: 'user', id: '78' } : { kind: 'group', id: '56' } },
      placement: { mode: 'bottom-centre' }, studsPerMeter });
  // Exercise the production adapter/authority on the unchanged real GLB bytes,
  // without repeating AssetService's full artifact inventory in every fence setup.
  // The dedicated equivalence case below retains that actual service integration.
  async function directPrepared(jobId: string): Promise<PreparedStudioImport> {
    const scope = assertStudioImportJobScope(projectPath, cws, actor, jobId), source = await sourceFor(jobId);
    const generated = adaptCompletedStudioImport(source.manifest, source.exports, scope.projectId, selection(), null);
    const authority = createStudioImportManifestAuthority({ loadGeneratedFiles: async requested => {
      assert.equal(requested, jobId); assertStudioImportJobScope(projectPath, cws, actor, jobId); return generated;
    } });
    try {
      const admission = await authority.admit(jobId); assertStudioImportJobScope(projectPath, cws, actor, jobId);
      return authority.prepare(admission);
    } finally { authority.close(); }
  }
  let assets: Awaited<ReturnType<typeof createAssetService>> | undefined;
  async function servicePrepared(jobId: string): Promise<PreparedStudioImport> {
    // The real service equivalence case still sees the complete two-job disk
    // inventory at startup. Other fences need only their requested export.
    if (!assets) for (const job of [JOB, NEXT]) await sourceFor(job);
    assets ??= await createAssetService({ cwd: projectPath, projectPath, outputRoot,
      studioImport: { workAssociations: cws, selectTarget: selection } });
    return assets.prepareStudioImport(jobId, actor);
  }
  const prepared = await directPrepared(JOB);
  const directory = join(root, 'preparations'), options = { projectPath, directory, workAssociations: cws, studio, now: () => now };
  let store: (StudioImportPreparationStore & StudioImportPreparationPins) | undefined; const releases: (() => void)[] = [];
  t.after(async () => {
    releases.forEach(release => release()); t.mock.restoreAll(); syncBuiltinESMExports();
    await store?.close().catch(error => { if (!code('LOCKED')(error) && !code('PATH')(error)) throw error; });
    await assets?.close(); cws.close(); registry.close(); studio.close();
    const part = relative(boundary, root); assert.ok(part.startsWith('arcane-preparation-store-') && !isAbsolute(part) && !part.startsWith('..' + sep));
    assert.equal((await lstat(root)).isSymbolicLink(), false); await rm(root, { recursive: true, force: true });
  });
  return { root, options, actor, prepared, witness, cws, registry, incarnation, studio, pair, observation, receipt,
    nextWitness() { epoch++; studio.poll(pair.sessionId, heartbeat()); return {...witness,initialContextReceiptId:receipt(),confirmedContextReceiptId:receipt(),playEpoch:epoch}; },
    directPrepared, servicePrepared, assetServiceCreated: () => assets !== undefined,
    async nextPrepared() { return directPrepared(NEXT); },
    async create(limits?: Parameters<typeof createStudioImportPreparationStore>[0]['limits']) { store = await createStudioImportPreparationStore({ ...options, ...(limits ? { limits } : {}) }); return store; },
    advance(ms: number) { now += ms; }, play() { studio.poll(pair.sessionId, heartbeat('Play', 1)); },
    async changedPrepared() { studsPerMeter = 4; return directPrepared(JOB); },
    async changedTarget() { parentRef = 'fixture-other-workspace'; return directPrepared(JOB); },
    holdRead() {
      t.signal.throwIfAborted();
      const entered = gate(), resume = gate(), original = fs.opendir; let held = false; releases.push(resume.release);
      t.mock.method(fs, 'opendir', async (...args: Parameters<typeof fs.opendir>) => {
        const result = await original(...args); if (!held && String(args[0]) === directory) { held = true; entered.release(); await resume.promise; } return result;
      }); syncBuiltinESMExports(); return { entered: entered.promise, release: resume.release };
    },
    transition(which: 'regrant' | 'new-intent' | 'retire' | 'registry-close' | 'cws-close') {
      if (which === 'registry-close') { registry.close(); return; } if (which === 'cws-close') { cws.close(); return; }
      if (which === 'retire') { incarnation.retire(); return; }
      if (which === 'regrant') { incarnation.revokeGrant(); incarnation.grant(binding); } else incarnation.ended('fixture-intent');
      incarnation.dispatched({ ...binding, operationId: 'fixture-next-intent' });
    },
  };
}

import { createHash } from 'node:crypto';
async function snapshot(directory: string): Promise<string> {
  const names = (await readdir(directory)).sort(), parts: string[] = [];
  for (const name of names) parts.push(name + ':' + createHash('sha256').update(await readFile(join(directory, name))).digest('hex'));
  return parts.join('|');
}
const ATTEMPT = '33333333-3333-4333-8333-333333333333';

test('archival pin: absent before any record, exact job only, and the query writes nothing', async t => {
  const f = await fixture(t), store = await f.create();
  assert.equal(await store.hasRecordForJob(JOB), false); assert.equal(await store.hasRecordForJob(NEXT), false);
  await store.save(f.actor, JOB, f.prepared, f.witness, guard);
  const before = await snapshot(f.options.directory);
  assert.equal(await store.hasRecordForJob(JOB), true);
  assert.equal(await store.hasRecordForJob(NEXT), false, 'another job of the same project is not pinned');
  assert.equal(await snapshot(f.options.directory), before, 'no write, prune or migration');
  for (const bad of ['not-a-uuid', 'ABCDEF11-1111-4111-8111-111111111111', JOB + ' ', '', 7 as unknown as string]) await assert.rejects(store.hasRecordForJob(bad), code('INPUT'));
});

test('archival pin includes historical attempts, not just a root record named after the job', async t => {
  const f = await fixture(t), store = await f.create();
  await store.saveAttempt(f.actor, JOB, ATTEMPT, f.prepared, f.witness, guard); // Stored as <attempt>.json only.
  assert.deepEqual((await readdir(f.options.directory)).filter(n => n !== 'preparation-owner.json').sort(), [ATTEMPT + '.json']);
  assert.equal(await store.hasRecordForJob(JOB), true);
  assert.equal(await store.hasRecordForJob(NEXT), false);
});

test('archival pin with root plus later attempt history stays pinned', async t => {
  const f = await fixture(t), store = await f.create();
  await store.save(f.actor, JOB, f.prepared, f.witness, guard);
  await store.saveAttempt(f.actor, JOB, ATTEMPT, f.prepared, f.witness, guard);
  assert.equal(await store.hasRecordForJob(JOB), true);
});

test('closed, busy and corrupt storage refuse instead of implying absence; corruption poisons later queries', async t => {
  const f = await fixture(t), store = await f.create();
  await store.save(f.actor, JOB, f.prepared, f.witness, guard);
  const held = f.holdRead(), reading = store.get(f.actor, JOB, guard);
  await held.entered;
  await assert.rejects(store.hasRecordForJob(JOB), code('BUSY'));
  held.release(); await reading;
  await writeFile(join(f.options.directory, NEXT + '.json'), '{"not":"a record"}');
  await assert.rejects(store.hasRecordForJob(NEXT), code('CORRUPT'));
  await assert.rejects(store.hasRecordForJob(JOB), code('WRITE_UNKNOWN'), 'poisoned after detected corruption');
  const g = await fixture(t), other = await g.create();
  await other.close();
  await assert.rejects(other.hasRecordForJob(JOB), code('CLOSED'));
});
