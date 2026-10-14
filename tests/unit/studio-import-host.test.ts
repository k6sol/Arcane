import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { createStudioImportHost } from '../../apps/daemon/src/studio-import-host.js';
import { createStudioImportStagingController } from '../../apps/daemon/src/studio-import-staging-controller.js';
import { createStudioImportPreparationStore } from '../../apps/daemon/src/studio-import-preparation-store.js';
import { createAssetService, type AssetService } from '../../apps/daemon/src/asset-service.js';
import { createNativeAssetRegistry, nativeAssetActorScope } from '../../apps/daemon/src/native-asset-authority.js';
import { StudioStore } from '../../packages/storage/src/studio-store.js';
import { ConversationWorkStore } from '../../packages/storage/src/conversation-work-store.js';
import { READ_METHODS, WRITE_METHODS, ASSET_STAGE_METHODS, ROOTS, type StudioImportContextObservation, type StudioCommand } from '../../packages/protocol/src/studio.js';
import { saveStudioFixture } from '../../packages/asset-pipeline/testing/studio-import-fixture.js';

// Production host, stores, queue receipts, completed-byte service and pending
// ledger. The paired plugin and GLBs are synthetic; no real Studio, SDK, worker,
// provider, credentials, import or upload is involved.
const JOB = '11111111-1111-4111-8111-111111111111', HASH = 'a'.repeat(64);
const conversation = { provider: 'codex' as const, threadId: 'fixture.import-host', sessionId: null };
const refused = (code: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === code;
async function fixture(t: test.TestContext, local = false, hostNow: () => number = Date.now) {
  const boundary = await realpath(tmpdir()), root = await mkdtemp(join(boundary, 'arcane-import-host-'));
  const projectPath = await realpath(root), studio = new StudioStore({ directory: join(root, 'studio') });
  const work = new ConversationWorkStore({ directory: join(root, 'work'), projectPath });
  work.bind({ conversation, kind: 'asset-job', id: JOB });
  const registry = createNativeAssetRegistry({ projectPath }), incarnation = registry.issue();
  const binding = { connectionId: 'fixture-connection', threadId: conversation.threadId };
  incarnation.seal({ ...binding, ...conversation }); incarnation.grant(binding);
  incarnation.dispatched({ ...binding, operationId: 'fixture-intent' });
  const actor = registry.capture(incarnation.credential(), 'mutate');
  const pair = (client: string, capabilities = [...READ_METHODS, ...WRITE_METHODS, ...ASSET_STAGE_METHODS]) => {
    const grant = studio.createGrant({ allowedRoots: [...ROOTS], allowWrites: true });
    return studio.pair({ code: grant.code, protocolVersion: 1, capabilities,
      identity: { clientSessionId: client, pluginVersion: '0.1.7', name: 'Synthetic import target', placeId: local ? 0 : 12, universeId: local ? 0 : 34 } });
  };
  const paired = pair('fixture-plugin');
  const proof = (hash = HASH, mode: 'Edit' | 'Play' = 'Edit', playEpoch = 0) => {
    const session = studio.session(paired.sessionId);
    return { sessionId: session.id, clientLifetimeId: session.clientSessionId, pluginArtifactHash: hash,
      markerName: 'ArcaneTestProof_fixture', placeId: session.placeId, universeId: session.universeId,
      placeName: session.name, mode, playEpoch, continuitySupported: true, connected: true };
  };
  studio.poll(paired.sessionId, proof());
  const context = (): StudioImportContextObservation => ({ sessionId: paired.sessionId, root: 'Workspace',
    parentRef: { instanceId: 'fixture-workspace', sessionId: paired.sessionId, root: 'Workspace', pathSegments: [], className: 'Workspace' },
    placeId: local ? 0 : 12, universeId: local ? 0 : 34, mode: 'Edit', modeProvenance: 'StudioTestService.EditModeActive',
    creator: local ? { status: 'unavailable', kind: null, id: 0, provenance: 'game.CreatorType/CreatorId' }
      : { status: 'available', kind: 'group', id: 56, provenance: 'game.CreatorType/CreatorId' },
    studioUser: local ? { status: 'available', id: 1234, provenance: 'StudioService:GetUserId' }
      : { status: 'not_applicable', id: null, provenance: 'StudioService:GetUserId' } });
  const ledger = await createStudioImportPreparationStore({ projectPath, directory: join(root, 'preparations'), workAssociations: work, studio });
  let saved = 0, response = context, held = false, reads = 0;
  const host = createStudioImportHost({ projectPath, workAssociations: work, studio, pluginArtifactHash: HASH, now: hostNow,
    persistPreparation: async (...args) => { await ledger.save(...args); saved++; } });
  let service: AssetService | undefined;
  let staging: ReturnType<typeof createStudioImportStagingController> | undefined;
  const received = new Map<string, {count: number; bytes: number}>();
  let stageHook: ((command: StudioCommand) => boolean) | null = null;
  const failures: unknown[] = [];
  const pump = setInterval(() => {
    try {
      if (held) return;
      for (const command of studio.poll(paired.sessionId, proof())) {
        if (command.method === 'asset.stage_packet') {
          if (stageHook && !stageHook(command)) continue;
          const expected = command.args.expected as {digest: string}, packet = JSON.parse(command.args.packet as string);
          const prior = received.get(expected.digest) ?? {count: 0, bytes: 0};
          assert.equal(packet.ordinal, prior.count); prior.count++; prior.bytes += Buffer.byteLength(command.args.packet as string);
          received.set(expected.digest, prior);
          studio.result({sessionId: paired.sessionId, commandId: command.id, state: 'succeeded', result: {
            transferDigest: expected.digest, packetCount: prior.count, byteLength: prior.bytes,
            state: packet.kind === 'seal' ? 'sealed' : 'receiving', engineVerification: 'pending',
          }});
          continue;
        }
        reads++; assert.equal(command.method, 'scene.import_context'); assert.deepEqual(command.args, {});
        studio.result({ sessionId: paired.sessionId, commandId: command.id, state: 'succeeded', result: response() });
      }
    } catch (error) { failures.push(error); }
  }, 100);
  t.after(async () => {
    clearInterval(pump); staging?.close(); host.close(); await service?.close(); await ledger.close(); registry.close(); work.close(); studio.close();
    const part = relative(boundary, root); assert.ok(part.startsWith('arcane-import-host-') && !isAbsolute(part) && !part.includes(sep));
    await rm(root, { recursive: true, force: true }); assert.deepEqual(failures, []);
  });
  const scope = nativeAssetActorScope(actor), guard = () => {};
  async function setupService() {
    if (service) return service;
    const outputRoot = join(root, 'outputs'), directory = join(outputRoot, 'test-kit-' + JOB);
    await mkdir(directory, {recursive: true}); await saveStudioFixture(directory, JOB);
    service = await createAssetService({cwd: root, projectPath, outputRoot, studioImport: host.hooks});
    return service;
  }
  return { studio, work, actor, incarnation, host, ledger, scope, guard, pair, proof, paired,
    context, hold: () => { held = true; }, respond: (fn: typeof context) => { response = fn; },
    onStage: (hook: (command: StudioCommand) => boolean) => {stageHook = hook;},
    async stage() {
      const assets = await setupService();
      staging ??= createStudioImportStagingController({projectPath, workAssociations: work, studio, assets, host: host.hooks, pluginArtifactHash: HASH});
      return staging.stage(JOB, actor);
    },
    counts: () => ({ saved, reads }), async prepare() {
      return (await setupService()).prepareStudioImport(JOB, actor);
    } };
}

test('production host observes two queue receipts and durably saves a strictly pending preparation', async t => {
  const f = await fixture(t), prepared = await f.prepare();
  assert.equal(prepared.status, 'prepared'); assert.equal(prepared.manifest.engineVerification, 'pending');
  assert.deepEqual(prepared.manifest.target.creator, { kind: 'group', id: '56' });
  assert.deepEqual(f.counts(), { saved: 1, reads: 2 });
  const record = await f.ledger.get(f.actor, JOB, f.guard); assert.ok(record);
  assert.equal(record.prepared.digest, prepared.digest); assert.equal(record.engineVerification, 'pending');
  assert.notEqual(record.witness.initialContextReceiptId, record.witness.confirmedContextReceiptId);
  assert.equal(f.studio.commands().every(c => c.method === 'scene.import_context' && c.state === 'succeeded'), true);
  const retry = await f.prepare();
  assert.equal(retry.digest, prepared.digest);
  assert.deepEqual(f.counts(), { saved: 2, reads: 4 });
  assert.deepEqual(await f.ledger.get(f.actor, JOB, f.guard), record, 'Fresh read receipts do not rewrite immutable pending metadata.');
});

test('native controller stages owned bytes through durable bounded queue receipts but never claims an import', async t => {
  const f = await fixture(t), staged = await f.stage();
  assert.equal(staged.status, 'staged'); assert.equal(staged.state, 'sealed');
  assert.equal(staged.imported, false); assert.equal(staged.engineVerification, 'pending');
  assert.equal(staged.packetCount, staged.commandIds.length); assert.ok(staged.byteLength > 0);
  for (const id of staged.commandIds) {
    const command = f.studio.command(id);
    assert.equal(command.method, 'asset.stage_packet'); assert.equal(command.state, 'succeeded');
    assert.ok(Buffer.byteLength(JSON.stringify(command.args)) <= 256 * 1024);
    assert.throws(() => f.studio.enqueue({sessionId: command.sessionId, requestId: command.requestId, method: command.method, args: command.args}), {code: 'ASSET_STAGE_AUTHORITY'});
    assert.throws(() => f.studio.restore({commandId: id, requestId: 'fixture_restore_stage'}), {code: 'RESTORE'});
  }
  assert.deepEqual(f.counts(), {saved: 1, reads: 3});
  const record = await f.ledger.get(f.actor, JOB, f.guard); assert.equal(record?.engineVerification, 'pending');
});

test('retired same native capture stops a delivered packet and retains its unknown outcome without replay', async t => {
  const f = await fixture(t); let attempted: StudioCommand | null = null;
  f.onStage(command => {attempted = command; f.incarnation.revokeGrant(); return false;});
  await assert.rejects(f.stage(), refused('NATIVE_ASSET_AUTHORITY'));
  assert.ok(attempted);
  assert.equal(f.studio.command((attempted as StudioCommand).id).state, 'needs_reconciliation');
  assert.equal(f.studio.poll(f.paired.sessionId, f.proof()).length, 0);
});

test('creator change after preparation is refused before any binary staging command', async t => {
  const f = await fixture(t);
  f.respond(() => {
    const context = f.context();
    if (f.counts().reads >= 3) context.creator = {status: 'available', kind: 'group', id: 57, provenance: 'game.CreatorType/CreatorId'};
    return context;
  });
  await assert.rejects(f.stage(), refused('STUDIO_STAGE_TARGET'));
  assert.equal(f.studio.commands().some(command => command.method === 'asset.stage_packet'), false);
});

test('unpublished target uses only the actually observed Studio user', async t => {
  const f = await fixture(t, true), prepared = await f.prepare();
  assert.deepEqual(prepared.manifest.target.creator, { kind: 'user', id: '1234' });
  assert.deepEqual(f.counts(), { saved: 1, reads: 2 });
});

test('a second live pairing is ambiguous even when its plugin lacks the new capability', async t => {
  const f = await fixture(t); f.pair('older-plugin', ['scene.children']);
  await assert.rejects(async () => f.host.hooks.selectTarget(f.scope, JOB, f.actor, f.guard), refused('STUDIO_IMPORT_AMBIGUOUS'));
  assert.deepEqual(f.counts(), { saved: 0, reads: 0 });
});

test('all authoritative pairings are considered beyond the display page', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 102; i++) { const p = f.pair('revoked-' + i, ['scene.children']); f.studio.revoke(p.sessionId, 'fixture'); }
  // These synchronous fixture writes can outlast the normal freshness window
  // on Windows. Deliver the synthetic plugin's heartbeat after setup; rowid
  // ordering must still leave this live pairing beyond the display page.
  f.studio.poll(f.paired.sessionId, f.proof());
  assert.equal(f.studio.sessions().some(s => s.id === f.paired.sessionId), false);
  assert.equal(f.studio.activeSessions().length, 1);
  const selected = await f.host.hooks.selectTarget(f.scope, JOB, f.actor, f.guard);
  assert.equal(selected.target.sessionId, f.paired.sessionId); f.host.hooks.releaseTarget?.(f.scope, JOB);
});

test('the same authoritative pairing is still refused once its production freshness window expires', async t => {
  const f = await fixture(t, false, () => Date.now() + 31_000);
  assert.equal(f.studio.activeSessions().length, 1);
  await assert.rejects(async () => f.host.hooks.selectTarget(f.scope, JOB, f.actor, f.guard), refused('STUDIO_IMPORT_TARGET'));
  assert.deepEqual(f.counts(), { saved: 0, reads: 0 });
});

test('changed creator between the initial and confirmation reads is refused without a saved record', async t => {
  const f = await fixture(t); f.respond(() => {
    const context = f.context();
    if (f.counts().reads >= 2) context.creator = { status: 'available', kind: 'group', id: 57, provenance: 'game.CreatorType/CreatorId' };
    return context;
  });
  await assert.rejects(f.prepare(), refused('STUDIO_IMPORT_CONTINUITY'));
  assert.deepEqual(f.counts(), { saved: 0, reads: 2 }); assert.equal(await f.ledger.get(f.actor, JOB, f.guard), null);
});

test('Play mode is refused before any context command or pending record', async t => {
  const f = await fixture(t); f.hold(); f.studio.poll(f.paired.sessionId, f.proof(HASH, 'Play', 1));
  await assert.rejects(async () => f.host.hooks.selectTarget(f.scope, JOB, f.actor, f.guard), refused('STUDIO_IMPORT_CONTINUITY'));
  assert.deepEqual(f.counts(), { saved: 0, reads: 0 });
});

test('unbound jobs and stale native captures cannot select a target', async t => {
  const f = await fixture(t);
  await assert.rejects(async () => f.host.hooks.selectTarget(f.scope, '22222222-2222-4222-8222-222222222222', f.actor, f.guard), refused('NOT_FOUND'));
  f.incarnation.revokeGrant();
  await assert.rejects(async () => f.host.hooks.selectTarget(f.scope, JOB, f.actor, f.guard), refused('NATIVE_ASSET_AUTHORITY'));
  assert.deepEqual(f.counts(), { saved: 0, reads: 0 });
});

test('host shutdown fences a pending context read without manufacturing a receipt', async t => {
  const f = await fixture(t); f.hold();
  const pending = f.host.hooks.selectTarget(f.scope, JOB, f.actor, f.guard);
  await new Promise(resolve => setTimeout(resolve, 5)); f.host.close();
  await assert.rejects(Promise.resolve(pending), refused('STUDIO_IMPORT_SCOPE')); assert.deepEqual(f.counts(), { saved: 0, reads: 0 });
});
