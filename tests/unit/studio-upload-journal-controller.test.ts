import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdir, mkdtemp, readFile, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {isAbsolute, join, relative, sep} from 'node:path';
import {createStudioUploadJournalController, type StudioUploadAdmission, type StudioUploadJournalConfiguration,
  type StudioUploadJournalInput, type StudioUploadRecordingHandle, type StudioUploadTicket} from '../../apps/daemon/src/studio-upload-journal-controller.js';
import {createNativeAssetRegistry} from '../../apps/daemon/src/native-asset-authority.js';
import {StudioStore} from '../../packages/storage/src/studio-store.js';
import {ConversationWorkStore} from '../../packages/storage/src/conversation-work-store.js';
import {saveStudioFixture} from '../../packages/asset-pipeline/testing/studio-import-fixture.js';
import {adaptCompletedStudioImport} from '../../apps/daemon/src/asset-import-adapter.js';
import {createStudioImportManifestAuthority} from '../../packages/asset-pipeline/src/studio-import-manifest.js';
import {decodeStudioImportPayload} from '../../packages/asset-pipeline/src/studio-import-payload.js';
import {READ_METHODS, type StudioUploadContextObservation} from '../../packages/protocol/src/studio.js';

// Real native capture, job attribution, decoded-byte provenance and temporary
// SQLite. Receipt and rights callbacks are SYNTHETIC, not live rights/engine proof.
// No HTTP, queue registration, SDK, native app, providers or editable resources.
const JOB = '11111111-1111-4111-8111-111111111111';
const ATTEMPT = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const HASH = 'a'.repeat(64);
const conversation = {provider: 'codex' as const, threadId: 'upload-journal-fixture', sessionId: null};
const refused = (code: string) => (e: unknown) => !!e && typeof e === 'object' && 'code' in e && e.code === code;
async function fixture(t: test.TestContext, local = false) {
  const boundary = await realpath(tmpdir()), root = await mkdtemp(join(boundary, 'arcane-upload-controller-'));
  const projectPath = await realpath(root), studioDirectory = join(root, 'studio');
  let time = Date.now(), studio = new StudioStore({directory: studioDirectory, now: () => time});
  const work = new ConversationWorkStore({directory: join(root, 'work'), projectPath});
  work.bind({kind: 'asset-job', id: JOB, conversation});
  const registry = createNativeAssetRegistry({projectPath}), incarnation = registry.issue();
  const binding = {connectionId: 'upload-fixture-connection', threadId: conversation.threadId};
  incarnation.seal({...binding, ...conversation}); incarnation.grant(binding);
  incarnation.dispatched({...binding, operationId: 'upload-fixture-intent'});
  const actor = registry.capture(incarnation.credential(), 'mutate');
  let controller: ReturnType<typeof createStudioUploadJournalController> | undefined;
  t.after(async () => {
    controller?.close(); registry.close(); work.close(); studio.close();
    const part = relative(boundary, root);
    assert.ok(part.startsWith('arcane-upload-controller-') && !isAbsolute(part) && !part.includes(sep));
    await rm(root, {recursive: true, force: true});
  });
  const filesDirectory = join(root, 'source'); await mkdir(filesDirectory);
  const manifest = await saveStudioFixture(filesDirectory, JOB);
  const exports = new Map<'asset.glb' | 'collision.glb', Buffer>();
  for (const name of ['asset.glb', 'collision.glb'] as const) exports.set(name, await readFile(join(filesDirectory, name)));
  let sessionId = '', receiptId = '', context!: StudioUploadContextObservation;
  function observe(store: StudioStore) {
    const grant = store.createGrant({allowedRoots: ['Workspace', 'ServerStorage'], allowWrites: true});
    const paired = store.pair({code: grant.code, protocolVersion: 1, capabilities: [...READ_METHODS],
      identity: {clientSessionId: 'synthetic-plugin-lifetime', pluginVersion: '0.1.7', name: 'Synthetic upload target',
        placeId: local ? 0 : 12, universeId: local ? 0 : 34}});
    sessionId = paired.sessionId;
    context = {sessionId, root: 'Workspace', parentRef: {instanceId: 'synthetic-workspace', sessionId, root: 'Workspace', pathSegments: [], className: 'Workspace'},
      placeId: local ? 0 : 12, universeId: local ? 0 : 34, mode: 'Edit', modeProvenance: 'StudioTestService.EditModeActive',
      creator: local ? {status: 'unavailable', kind: null, id: 0, provenance: 'game.CreatorType/CreatorId'}
        : {status: 'available', kind: 'group', id: 56, provenance: 'game.CreatorType/CreatorId'},
      studioUser: local ? {status: 'available', id: 78, provenance: 'StudioService:GetUserId'}
        : {status: 'not_applicable', id: null, provenance: 'StudioService:GetUserId'},
      uploader: {status: 'available', id: 78, provenance: 'StudioService:GetUserId'}};
    store.poll(sessionId, proof());
    const command = store.enqueue({sessionId, requestId: 'synthetic-upload-context-' + sessionId, method: 'scene.upload_context', args: {}});
    store.poll(sessionId, proof()); store.result({sessionId, commandId: command.id, state: 'succeeded', result: context});
    receiptId = command.id;
  }
  function proof(patch: Record<string, unknown> = {}) {
    return {sessionId, clientLifetimeId: 'synthetic-plugin-lifetime', pluginArtifactHash: HASH, markerName: 'ArcaneTestProof_fixture',
      placeId: local ? 0 : 12, universeId: local ? 0 : 34, placeName: 'Synthetic upload target', mode: 'Edit', playEpoch: 0,
      continuitySupported: true, connected: true, ...patch};
  }
  observe(studio);
  async function source() {
    const generated = adaptCompletedStudioImport(manifest, exports, work.projectId, {target: {sessionId, placeId: context.placeId,
      universeId: context.universeId, root: 'Workspace', parentRef: context.parentRef.instanceId,
      creator: {kind: local ? 'user' : 'group', id: local ? '78' : '56'}}, placement: {mode: 'bottom-centre'}, studsPerMeter: 1 / 0.28}, null);
    const authority = createStudioImportManifestAuthority({loadGeneratedFiles: async () => generated});
    try {
      const prepared = authority.prepare(await authority.admit(JOB));
      const payload = decodeStudioImportPayload(prepared, new Map(generated.files.map(f => [f.fileId, f.bytes])));
      return {prepared, payload, sourceObject: payload.objects.find(o => o.object.role === 'render')!};
    } finally {authority.close();}
  }
  let guards = 0, rights = 0;
  const resource: object = Object.freeze(Object.create(null)); // actual host-held identity double, no metadata authority
  const observed: StudioUploadAdmission[] = [];
  let onGuard: ((a: StudioUploadAdmission, n: number, resource: object | null) => unknown) | undefined;
  let onRights: ((a: StudioUploadAdmission, n: number) => unknown) | undefined;
  function config(): StudioUploadJournalConfiguration {
    return {projectPath, workAssociations: work, studio, pluginArtifactHash: HASH, now: () => time,
      beginAdmissionGuard(a) {
        guards++; observed.push(a); assert.equal(a.actor, actor); assert.equal(a.scope.projectId, work.projectId);
        assert.equal(a.scope.conversation.sessionId, null); assert.equal(a.contextReceiptId, receiptId);
        assert.equal(a.sourceIdentity.sourceId, a.sourceObject.object.sourceObjectId);
        return onGuard?.(a, guards, null) as void;
      },
      admissionGuard(a, borrowedResource) {
        assert.equal(borrowedResource, resource, 'exact host-owned borrowed resource required');
        guards++; observed.push(a); assert.equal(a.actor, actor);
        return onGuard?.(a, guards, borrowedResource) as void;
      },
      rightsAdmission(a, borrowedResource) {
        if (borrowedResource !== null) assert.equal(borrowedResource, resource);
        rights++; assert.equal(a.intent.rightsGrantId, 'synthetic-host-owned-rights-grant');
        assert.equal(a.intent.creator.id, local ? 78 : 56); assert.equal(a.intent.uploaderId, 78);
        return onRights?.(a, rights) as void;
      }};
  }
  const data = await source();
  const input: StudioUploadJournalInput = {attemptId: ATTEMPT, actor, ...data, contextReceiptId: receiptId,
    rightsGrantId: 'synthetic-host-owned-rights-grant', name: 'Owned fixture mesh', description: 'Synthetic admission only'};
  controller = createStudioUploadJournalController(config());
  return {root, actor, resource, registry, incarnation, work, controller, input, config, source, proof,
    get studio() {return studio;}, get sessionId() {return sessionId;}, get context() {return context;},
    observed, counts: () => ({guards, rights}), advance(ms: number) {time += ms;},
    onGuard(fn: typeof onGuard) {onGuard = fn;}, onRights(fn: typeof onRights) {onRights = fn;},
    async restart() {
      studio.close(); studio = new StudioStore({directory: studioDirectory, now: () => time}); observe(studio);
      return {...input, ...await source(), contextReceiptId: receiptId};
    },
  };
}
function fresh(result: ReturnType<ReturnType<typeof createStudioUploadJournalController>['begin']>) {
  assert.equal(result.fresh, true); if (!result.fresh) throw Error('Expected a fresh private journal handle'); return result;
}

test('fresh durable Store intent precedes a one-use engine permission ACK and exact result logging', async t => {
  const f = await fixture(t), result = fresh(f.controller.begin(f.input)), callbacks = f.controller.callbacks(result.handle, f.resource);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.handle) && Object.isFrozen(result.ticket.source));
  assert.equal(f.studio.assetUpload(ATTEMPT).state, 'intent');
  assert.equal(result.record.intent.creator.id, 56); assert.equal(result.record.intent.uploaderId, 78);
  assert.equal(result.ticket.source.sha256, f.input.sourceObject.object.meshExportSha256);
  assert.equal(result.ticket.source.resourceId, f.input.sourceObject.object.sourceObjectId);
  assert.deepEqual(result.ticket.continuity, {sessionId: f.sessionId, clientLifetimeId: 'synthetic-plugin-lifetime',
    pluginArtifactHash: HASH, playEpoch: 0, placeId: 12, universeId: 34});
  assert.equal(callbacks.assertAdmission(result.ticket, f.resource), undefined); assert.equal(callbacks.liveGuard(result.ticket, f.resource), undefined);
  const ack = callbacks.recordIntent(result.ticket); assert.deepEqual(ack, {phase: 'intent', ticket: result.ticket});
  let simulatedEngineCalls = 0; if (ack.phase === 'intent') simulatedEngineCalls++; // no engine object or SDK
  assert.throws(() => callbacks.recordIntent(result.ticket), refused('STUDIO_UPLOAD_CONSUMED'));
  assert.equal(simulatedEngineCalls, 1);
  assert.deepEqual(callbacks.recordResult(result.ticket, {attemptId: ATTEMPT, assetId: 987654}), {phase: 'result', ticket: result.ticket, assetId: 987654});
  assert.equal(f.studio.assetUpload(ATTEMPT).assetId, 987654);
  // The helper's final live guard follows its own successful result ACK.
  assert.equal(callbacks.liveGuard(result.ticket, f.resource), undefined);
  assert.throws(() => callbacks.recordIntent(result.ticket), refused('STUDIO_UPLOAD_CONSUMED'));
});

test('local three-zero-ID target retains separately observed uploader and explicit rights guard', async t => {
  const f = await fixture(t, true), result = fresh(f.controller.begin(f.input));
  assert.deepEqual(result.ticket.creator, {kind: 'user', id: 78}); assert.equal(result.ticket.uploader.id, 78);
  assert.ok(f.counts().rights > 0); assert.equal(result.ticket.continuity.placeId, 0);
});

test('metadata is detached before guards; callback references and Store methods are snapshotted', async t => {
  const f = await fixture(t), original = {...f.input};
  f.onGuard(a => {
    f.input.name = 'changed'; f.input.description = 'changed'; f.input.rightsGrantId = 'changed'; f.input.attemptId = OTHER;
    assert.ok(Object.isFrozen(a.intent) && Object.isFrozen(a.ticket) && Object.isFrozen(a.target) && Object.isFrozen(a.context));
    f.studio.beginAssetUpload = () => {throw Error('must not replace captured Store method');};
  });
  const result = fresh(f.controller.begin(f.input));
  assert.equal(result.ticket.name, original.name); assert.equal(result.ticket.attemptId, ATTEMPT);
  assert.equal(result.record.intent.rightsGrantId, original.rightsGrantId);
  assert.equal(f.studio.assetUpload(ATTEMPT).intent.description, original.description);
  assert.equal(f.observed.every(a => a.ticket === result.ticket), true);
});

test('absence of actual synchronous admission/rights callbacks is unavailable', async t => {
  const f = await fixture(t);
  for (const field of ['beginAdmissionGuard', 'admissionGuard', 'rightsAdmission'] as const) {
    for (const value of [undefined, true, async () => {}, function* () {}]) {
      assert.throws(() => createStudioUploadJournalController({...f.config(), [field]: value} as StudioUploadJournalConfiguration), refused('STUDIO_UPLOAD_UNAVAILABLE'));
    }
  }
  assert.throws(() => f.studio.assetUpload(ATTEMPT), refused('UPLOAD_NOT_FOUND'));
});

for (const role of ['guard', 'rights'] as const) {
  test(`${role} must return void; booleans, values, promises and thenables cannot admit`, async t => {
    const f = await fixture(t);
    let traps = 0;
    const thenable = Object.defineProperty({}, 'then', {get() {traps++; throw Error('must not inspect thenable');}});
    for (const value of [true, false, null, 0, {}, Promise.resolve(), Promise.reject(Error('synthetic rejection')), thenable]) {
      if (role === 'guard') f.onGuard(() => value); else f.onRights(() => value);
      assert.throws(() => f.controller.begin(f.input), refused(role === 'guard' ? 'STUDIO_UPLOAD_ADMISSION' : 'STUDIO_UPLOAD_RIGHTS'));
    }
    assert.equal(traps, 0); assert.throws(() => f.studio.assetUpload(ATTEMPT), refused('UPLOAD_NOT_FOUND'));
  });
}

test('metadata rightsGrantId cannot substitute for a denied host rights admission', async t => {
  const f = await fixture(t); f.onRights(() => {throw Error('synthetic rights denied');});
  assert.throws(() => f.controller.begin(f.input), refused('STUDIO_UPLOAD_RIGHTS'));
  assert.throws(() => f.studio.assetUpload(ATTEMPT), refused('UPLOAD_NOT_FOUND'));
});

test('forged actors, wrong conversations and read-only captures never write an intent', async t => {
  const f = await fixture(t);
  const other = f.registry.issue(), bound = {connectionId: 'other', threadId: 'other-thread'};
  other.seal({...bound, provider: 'codex', sessionId: null}); other.grant(bound); other.dispatched({...bound, operationId: 'other-intent'});
  for (const actor of [structuredClone(f.actor), new Proxy(f.actor, {}), f.registry.capture(other.credential(), 'mutate'), f.registry.capture(other.credential(), 'read')]) {
    assert.throws(() => f.controller.begin({...f.input, actor}));
  }
  assert.throws(() => f.studio.assetUpload(ATTEMPT), refused('UPLOAD_NOT_FOUND'));
});

test('decoded payload and exact source membership cannot be forged, proxied or cloned', async t => {
  const f = await fixture(t); let traps = 0;
  for (const payload of [structuredClone(f.input.payload), {...f.input.payload}, new Proxy(f.input.payload, {get() {traps++; throw Error('never');}})]) {
    assert.throws(() => f.controller.begin({...f.input, payload}));
  }
  for (const sourceObject of [structuredClone(f.input.sourceObject), {...f.input.sourceObject}, new Proxy(f.input.sourceObject, {get() {traps++; throw Error('never');}})]) {
    assert.throws(() => f.controller.begin({...f.input, sourceObject}), refused('STUDIO_UPLOAD_SOURCE'));
  }
  const prepared = {...f.input.prepared, manifest: {...f.input.prepared.manifest,
    target: {...f.input.prepared.manifest.target, creator: {...f.input.prepared.manifest.target.creator, id: '999'}}}};
  assert.throws(() => f.controller.begin({...f.input, prepared}));
  assert.equal(traps, 0); assert.equal(f.counts().guards, 0);
});

test('top-level, prepared and configuration accessors/proxies are refused without invoking traps', async t => {
  const f = await fixture(t); let reads = 0;
  const accessor = {...f.input}; Object.defineProperty(accessor, 'name', {get() {reads++; return 'bad';}});
  const prepared = Object.defineProperty({}, 'manifest', {get() {reads++; throw Error('never');}});
  const config = f.config(); Object.defineProperty(config, 'rightsAdmission', {get() {reads++; throw Error('never');}});
  for (const value of [accessor, new Proxy(f.input, {ownKeys() {reads++; throw Error('never');}})]) assert.throws(() => f.controller.begin(value));
  assert.throws(() => f.controller.begin({...f.input, prepared: prepared as typeof f.input.prepared}));
  assert.throws(() => createStudioUploadJournalController(config));
  assert.equal(reads, 0); assert.throws(() => f.studio.assetUpload(ATTEMPT), refused('UPLOAD_NOT_FOUND'));
});

test('scope change before begin refuses without a durable journal effect', async t => {
  const f = await fixture(t); f.onGuard(() => {f.incarnation.retire();});
  assert.throws(() => f.controller.begin(f.input), refused('NATIVE_ASSET_AUTHORITY'));
  assert.throws(() => f.studio.assetUpload(ATTEMPT), refused('UPLOAD_NOT_FOUND'));
});

test('late pre-COMMIT retirement rolls back the actual SQLite intent and cannot be retried', async t => {
  const f = await fixture(t); f.onRights((_a, count) => {if (count === 4) f.incarnation.retire();});
  assert.throws(() => f.controller.begin(f.input), refused('NATIVE_ASSET_AUTHORITY'));
  assert.throws(() => f.studio.assetUpload(ATTEMPT), refused('UPLOAD_NOT_FOUND'));
});

for (const patch of [{mode: 'Play', playEpoch: 1}, {playEpoch: 1}, {connected: false}]) {
  test(`continuity change ${Object.keys(patch)[0]} refuses before SQLite effects`, async t => {
    const f = await fixture(t); f.studio.poll(f.sessionId, f.proof(patch));
    assert.throws(() => f.controller.begin(f.input)); assert.throws(() => f.studio.assetUpload(ATTEMPT), refused('UPLOAD_NOT_FOUND'));
  });
}

test('artifact drift is rejected by Store without replacing its original continuity proof', async t => {
  const f = await fixture(t), original = f.studio.session(f.sessionId).proof;
  assert.throws(() => f.studio.poll(f.sessionId, f.proof({pluginArtifactHash: 'b'.repeat(64)})), refused('IDENTITY'));
  assert.deepEqual(f.studio.session(f.sessionId).proof, original);
  assert.throws(() => f.studio.assetUpload(ATTEMPT), refused('UPLOAD_NOT_FOUND'));
});

test('old upload-context receipt cannot be relabelled with a newer Edit epoch before begin', async t => {
  const f = await fixture(t);
  f.studio.poll(f.sessionId, f.proof({mode: 'Play', playEpoch: 1}));
  f.studio.poll(f.sessionId, f.proof({mode: 'Edit', playEpoch: 2}));
  assert.equal(f.studio.command(f.input.contextReceiptId).state, 'succeeded');
  assert.throws(() => f.controller.begin(f.input), refused('STUDIO_UPLOAD_CONTINUITY'));
  assert.equal(f.counts().guards, 0); assert.equal(f.counts().rights, 0);
  assert.throws(() => f.studio.assetUpload(ATTEMPT), refused('UPLOAD_NOT_FOUND'));
});

test('a live current heartbeat cannot substitute for a missing original Store context pin', async t => {
  const f = await fixture(t);
  t.mock.method(f.studio, 'assetUploadContextPin', () => null);
  const controller = createStudioUploadJournalController(f.config());
  assert.throws(() => controller.begin(f.input), refused('STUDIO_UPLOAD_CONTINUITY'));
  assert.equal(f.counts().guards, 0); assert.equal(f.counts().rights, 0);
  assert.throws(() => f.studio.assetUpload(ATTEMPT), refused('UPLOAD_NOT_FOUND'));
});

test('epoch change after begin cannot grant execution even while the context receipt stays succeeded', async t => {
  const f = await fixture(t), result = fresh(f.controller.begin(f.input));
  const callbacks = f.controller.callbacks(result.handle, f.resource);
  f.studio.poll(f.sessionId, f.proof({playEpoch: 1}));
  assert.throws(() => callbacks.assertAdmission(result.ticket, f.resource), refused('STUDIO_UPLOAD_CONTINUITY'));
  assert.throws(() => callbacks.recordIntent(result.ticket), refused('STUDIO_UPLOAD_CONTINUITY'));
  assert.equal(f.studio.assetUpload(ATTEMPT).state, 'intent');
});

test('expired upload context is refused even if a new heartbeat is live', async t => {
  const f = await fixture(t); f.advance(10_001); f.studio.poll(f.sessionId, f.proof());
  assert.throws(() => f.controller.begin(f.input), refused('STUDIO_UPLOAD_CONTEXT'));
});

test('only successful exact stored upload-context receipts are accepted', async t => {
  const f = await fixture(t), command = f.studio.enqueue({sessionId: f.sessionId, requestId: 'wrong-context', method: 'scene.import_context', args: {}});
  assert.throws(() => f.controller.begin({...f.input, contextReceiptId: command.id}), refused('STUDIO_UPLOAD_CONTEXT'));
  assert.throws(() => f.controller.begin({...f.input, contextReceiptId: 'invented'}));
  assert.equal(f.counts().guards, 0);
});

test('repeat and replacement attempts never yield fresh permission, including another controller', async t => {
  const f = await fixture(t), result = fresh(f.controller.begin(f.input));
  assert.deepEqual(f.controller.begin(f.input), {fresh: false, handle: null, ticket: null, record: result.record});
  const second = createStudioUploadJournalController(f.config());
  assert.equal(second.begin(f.input).fresh, false);
  assert.throws(() => second.begin({...f.input, attemptId: OTHER}), refused('UPLOAD_CONFLICT'));
  assert.throws(() => second.callbacks(result.handle, f.resource), refused('STUDIO_UPLOAD_HANDLE'));
});

test('forged, inherited, copied, accessor and proxy handles do not record or acquire callbacks', async t => {
  const f = await fixture(t), result = fresh(f.controller.begin(f.input)); let reads = 0;
  const getter = Object.defineProperty({}, 'kind', {get() {reads++; return result.handle.kind;}});
  for (const handle of [{kind: result.handle.kind}, structuredClone(result.handle), Object.create(result.handle), getter,
    new Proxy(result.handle, {get() {reads++; throw Error('never');}})]) {
    assert.throws(() => f.controller.callbacks(handle as StudioUploadRecordingHandle, f.resource), refused('STUDIO_UPLOAD_HANDLE'));
    assert.throws(() => f.controller.finishUnknown(handle as StudioUploadRecordingHandle), refused('STUDIO_UPLOAD_HANDLE'));
  }
  assert.equal(reads, 0); assert.equal(f.studio.assetUpload(ATTEMPT).state, 'intent');
});

test('all original ticket identities must match; getters/proxies cannot launder changed metadata', async t => {
  const f = await fixture(t), result = fresh(f.controller.begin(f.input)), callbacks = f.controller.callbacks(result.handle, f.resource);
  const patches = [{attemptId: OTHER}, {assetType: 'Image'}, {name: 'other'}, {description: 'other'},
    {creator: {...result.ticket.creator, id: 999}}, {uploader: {...result.ticket.uploader, id: 999}},
    {source: {...result.ticket.source, sha256: 'b'.repeat(64)}}, {source: {...result.ticket.source, resourceId: 'other'}},
    {continuity: {...result.ticket.continuity, sessionId: 'other'}}, {continuity: {...result.ticket.continuity, playEpoch: 1}}];
  for (const patch of patches) assert.throws(() => callbacks.recordIntent({...result.ticket, ...patch} as StudioUploadTicket), refused('STUDIO_UPLOAD_TICKET'));
  let reads = 0; const getter = {...result.ticket}; Object.defineProperty(getter, 'creator', {get() {reads++; throw Error('never');}});
  assert.throws(() => callbacks.recordIntent(getter)); assert.throws(() => callbacks.recordIntent(new Proxy(result.ticket, {get() {reads++; throw Error('never');}})));
  assert.equal(reads, 0); callbacks.recordIntent(result.ticket);
});

test('revoked claim is consumed, never revived by re-grant or new callback objects', async t => {
  const f = await fixture(t), result = fresh(f.controller.begin(f.input)), callbacks = f.controller.callbacks(result.handle, f.resource);
  f.incarnation.revokeGrant(); assert.throws(() => callbacks.recordIntent(result.ticket));
  assert.throws(() => f.controller.callbacks(result.handle, f.resource).recordIntent(result.ticket), refused('STUDIO_UPLOAD_CONSUMED'));
  assert.throws(() => callbacks.recordResult(result.ticket, {attemptId: ATTEMPT, assetId: 1}), refused('STUDIO_UPLOAD_OBSERVATION'));
});

test('P1: callbacks bind one actual borrowed resource and execution guards reject every substitute before host admission', async t => {
  const f = await fixture(t), result = fresh(f.controller.begin(f.input));
  let seen: object | null = null;
  f.onGuard((_a, _n, actual) => {seen = actual;});
  const callbacks = f.controller.callbacks(result.handle, f.resource);
  assert.equal(seen, f.resource);
  seen = null; callbacks.assertAdmission(result.ticket, f.resource); assert.equal(seen, f.resource);
  seen = null; callbacks.liveGuard(result.ticket, f.resource); assert.equal(seen, f.resource);
  const before = f.counts(); let reads = 0;
  const proxy = new Proxy(f.resource, {get() {reads++; throw Error('must not inspect');}});
  for (const other of [{}, structuredClone(f.resource), JSON.parse(JSON.stringify(f.resource)), proxy, undefined]) {
    assert.throws(() => callbacks.assertAdmission(result.ticket, other as object), refused('STUDIO_UPLOAD_RESOURCE'));
    assert.throws(() => callbacks.liveGuard(result.ticket, other as object), refused('STUDIO_UPLOAD_RESOURCE'));
    assert.throws(() => f.controller.callbacks(result.handle, other as object), refused('STUDIO_UPLOAD_RESOURCE'));
  }
  assert.deepEqual(f.counts(), before); assert.equal(reads, 0);
  callbacks.recordIntent(result.ticket); // the original binding remains intact
});

test('P1: metadata-only begin cannot admit a serialized resource at callback creation', async t => {
  const f = await fixture(t), result = fresh(f.controller.begin(f.input));
  assert.throws(() => f.controller.callbacks(result.handle, structuredClone(f.resource)), refused('STUDIO_UPLOAD_ADMISSION'));
  assert.equal(f.studio.assetUpload(ATTEMPT).state, 'intent');
  const callbacks = f.controller.callbacks(result.handle, f.resource);
  callbacks.recordIntent(result.ticket);
});

test('known successful ID logs after actor/rights retirement and close, without admitting continuation', async t => {
  const f = await fixture(t), result = fresh(f.controller.begin(f.input)), callbacks = f.controller.callbacks(result.handle, f.resource);
  callbacks.recordIntent(result.ticket); const before = f.counts();
  f.incarnation.retire(); f.onRights(() => {throw Error('rights retired');}); f.controller.close();
  const ack = callbacks.recordResult(result.ticket, {attemptId: ATTEMPT, assetId: 123456});
  assert.equal(ack.assetId, 123456); assert.equal(f.studio.assetUpload(ATTEMPT).state, 'succeeded');
  assert.deepEqual(f.counts(), before); assert.throws(() => callbacks.liveGuard(result.ticket, f.resource));
  assert.deepEqual(callbacks.recordResult(result.ticket, {attemptId: ATTEMPT, assetId: 123456}), ack);
  assert.throws(() => callbacks.recordResult(result.ticket, {attemptId: ATTEMPT, assetId: 654321}), refused('UPLOAD_CONFLICT'));
});

test('unknown terminal outcome never authorizes continuation or overwrites a known success', async t => {
  const f = await fixture(t), result = fresh(f.controller.begin(f.input)), callbacks = f.controller.callbacks(result.handle, f.resource);
  callbacks.recordIntent(result.ticket);
  assert.equal(f.controller.finishUnknown(result.handle).state, 'needs_reconciliation');
  assert.throws(() => callbacks.recordIntent(result.ticket), refused('STUDIO_UPLOAD_RETIRED'));
  assert.throws(() => callbacks.recordResult(result.ticket, {attemptId: ATTEMPT, assetId: 123}), refused('UPLOAD_CONFLICT'));
});

test('P1: execution admission and rights callbacks must also synchronously return void for the actual resource', async t => {
  const f = await fixture(t), result = fresh(f.controller.begin(f.input));
  for (const value of [true, false, Promise.resolve()]) {
    f.onGuard((_a, _n, resource) => resource === null ? undefined : value);
    assert.throws(() => f.controller.callbacks(result.handle, f.resource), refused('STUDIO_UPLOAD_ADMISSION'));
  }
  f.onGuard(undefined);
  const callbacks = f.controller.callbacks(result.handle, f.resource);
  f.onRights(() => true);
  assert.throws(() => callbacks.liveGuard(result.ticket, f.resource), refused('STUDIO_UPLOAD_RIGHTS'));
  f.onRights(undefined);
  callbacks.recordIntent(result.ticket);
});

test('P2: unknown outcome after intent ACK retires guards before uploader resumes and preserves immutable unknown', async t => {
  const f = await fixture(t), result = fresh(f.controller.begin(f.input)), callbacks = f.controller.callbacks(result.handle, f.resource);
  const ack = callbacks.recordIntent(result.ticket); assert.equal(ack.phase, 'intent');
  f.controller.finishUnknown(result.handle); // uploader was paused after this ACK
  let simulatedEngineCalls = 0;
  assert.throws(() => {
    callbacks.assertAdmission(result.ticket, f.resource);
    callbacks.liveGuard(result.ticket, f.resource);
    simulatedEngineCalls++;
  }, refused('STUDIO_UPLOAD_RETIRED'));
  assert.equal(simulatedEngineCalls, 0);
  assert.throws(() => callbacks.liveGuard(result.ticket, f.resource), refused('STUDIO_UPLOAD_RETIRED'));
  assert.throws(() => callbacks.recordIntent(result.ticket), refused('STUDIO_UPLOAD_RETIRED'));
  assert.throws(() => f.controller.callbacks(result.handle, f.resource), refused('STUDIO_UPLOAD_RETIRED'));
  f.incarnation.retire();
  assert.throws(() => callbacks.recordResult(result.ticket, {attemptId: ATTEMPT, assetId: 111222}), refused('UPLOAD_CONFLICT'));
  assert.equal(f.studio.assetUpload(ATTEMPT).state, 'needs_reconciliation');
  assert.equal(f.studio.assetUpload(ATTEMPT).assetId, null);
});

test('P2: unknown logging failure still retires execution before its Store callback runs', async t => {
  const f = await fixture(t), original = f.studio.finishAssetUpload.bind(f.studio);
  f.studio.finishAssetUpload = (ticket, outcome) => {
    if (outcome.state === 'needs_reconciliation') throw Error('synthetic unknown journal failure');
    return original(ticket, outcome);
  };
  const controller = createStudioUploadJournalController(f.config()), result = fresh(controller.begin(f.input));
  const callbacks = controller.callbacks(result.handle, f.resource); callbacks.recordIntent(result.ticket);
  assert.throws(() => controller.finishUnknown(result.handle));
  assert.equal(f.studio.assetUpload(ATTEMPT).state, 'intent');
  assert.throws(() => callbacks.assertAdmission(result.ticket, f.resource), refused('STUDIO_UPLOAD_RETIRED'));
  assert.throws(() => callbacks.recordIntent(result.ticket), refused('STUDIO_UPLOAD_RETIRED'));
  f.incarnation.retire();
  callbacks.recordResult(result.ticket, {attemptId: ATTEMPT, assetId: 777888}); // known fact may still be logged
  assert.equal(f.studio.assetUpload(ATTEMPT).assetId, 777888);
});

test('P2: finishUnknown cannot overwrite known success and retirement cannot reopen execution', async t => {
  const f = await fixture(t), result = fresh(f.controller.begin(f.input)), callbacks = f.controller.callbacks(result.handle, f.resource);
  callbacks.recordIntent(result.ticket); callbacks.recordResult(result.ticket, {attemptId: ATTEMPT, assetId: 111333});
  assert.throws(() => f.controller.finishUnknown(result.handle), refused('UPLOAD_CONFLICT'));
  assert.equal(f.studio.assetUpload(ATTEMPT).state, 'succeeded'); assert.equal(f.studio.assetUpload(ATTEMPT).assetId, 111333);
  assert.throws(() => callbacks.liveGuard(result.ticket, f.resource), refused('STUDIO_UPLOAD_RETIRED'));
});

test('result observation requires issued permission and exact valid ID; malicious records are not read', async t => {
  const f = await fixture(t), result = fresh(f.controller.begin(f.input)), callbacks = f.controller.callbacks(result.handle, f.resource);
  assert.throws(() => callbacks.recordResult(result.ticket, {attemptId: ATTEMPT, assetId: 123}), refused('STUDIO_UPLOAD_OBSERVATION'));
  callbacks.recordIntent(result.ticket);
  for (const id of [0, -1, 1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => callbacks.recordResult(result.ticket, {attemptId: ATTEMPT, assetId: id}));
  assert.throws(() => callbacks.recordResult(result.ticket, {attemptId: OTHER, assetId: 123}), refused('STUDIO_UPLOAD_OBSERVATION'));
  let reads = 0; const getter = Object.defineProperty({attemptId: ATTEMPT}, 'assetId', {enumerable: true, get() {reads++; return 123;}});
  assert.throws(() => callbacks.recordResult(result.ticket, getter as {attemptId: string; assetId: number}));
  assert.throws(() => callbacks.recordResult(result.ticket, new Proxy({attemptId: ATTEMPT, assetId: 123}, {ownKeys() {reads++; throw Error('never');}})));
  assert.equal(reads, 0); assert.equal(f.studio.assetUpload(ATTEMPT).state, 'intent');
});

test('reentry from begin and permission guards cannot reserve another upload or issue a second ACK', async t => {
  const f = await fixture(t); let calls = 0;
  f.onGuard(() => {calls++; assert.throws(() => f.controller.begin({...f.input, attemptId: OTHER}), refused('STUDIO_UPLOAD_REENTRY'));});
  const result = fresh(f.controller.begin(f.input)), callbacks = f.controller.callbacks(result.handle, f.resource);
  f.onGuard(() => {assert.throws(() => callbacks.recordIntent(result.ticket), refused('STUDIO_UPLOAD_REENTRY'));});
  callbacks.recordIntent(result.ticket); assert.ok(calls > 0);
  assert.throws(() => f.studio.assetUpload(OTHER), refused('UPLOAD_NOT_FOUND'));
});

for (const afterCommit of [false, true]) {
  test(`actual SQLite ${afterCommit ? 'committed-but-ACK-lost' : 'COMMIT-failed'} begin yields no handle and no replay permission`, async t => {
    const f = await fixture(t), original = DatabaseSync.prototype.exec; let uploadDb: DatabaseSync | undefined;
    t.mock.method(DatabaseSync.prototype, 'exec', function(this: DatabaseSync, sql: string) {
      if (sql === 'BEGIN IMMEDIATE' && !uploadDb) uploadDb = this;
      if (this === uploadDb && sql === 'COMMIT') {
        if (afterCommit) original.call(this, sql);
        throw Error('synthetic COMMIT failure/unknown acknowledgement');
      }
      return original.call(this, sql);
    });
    assert.throws(() => f.controller.begin(f.input)); t.mock.restoreAll();
    if (afterCommit) assert.equal(f.studio.assetUpload(ATTEMPT).state, 'intent');
    else assert.throws(() => f.studio.assetUpload(ATTEMPT), refused('UPLOAD_NOT_FOUND'));
    if (afterCommit) assert.equal(f.controller.begin(f.input).fresh, false);
    else assert.throws(() => f.controller.begin(f.input), refused('STUDIO_UPLOAD_RECONCILIATION'));
    assert.throws(() => createStudioUploadJournalController(f.config()).begin({...f.input, attemptId: OTHER}), refused('UPLOAD_CONFLICT'));
  });
}

test('restart preserves unknown intent reservation and invalidates all old recording handles', async t => {
  const f = await fixture(t), result = fresh(f.controller.begin(f.input));
  const input = await f.restart(), controller = createStudioUploadJournalController(f.config());
  assert.equal(f.studio.assetUpload(ATTEMPT).state, 'needs_reconciliation');
  assert.throws(() => controller.callbacks(result.handle, f.resource), refused('STUDIO_UPLOAD_HANDLE'));
  assert.throws(() => controller.begin(input), refused('UPLOAD_CONFLICT')); // changed session cannot hide same logical resource
  assert.throws(() => controller.begin({...input, attemptId: OTHER}), refused('UPLOAD_CONFLICT'));
});

test('known successful facts survive restart and no replay becomes fresh', async t => {
  const f = await fixture(t), result = fresh(f.controller.begin(f.input)), callbacks = f.controller.callbacks(result.handle, f.resource);
  callbacks.recordIntent(result.ticket); callbacks.recordResult(result.ticket, {attemptId: ATTEMPT, assetId: 345678});
  const input = await f.restart(); assert.equal(f.studio.assetUpload(ATTEMPT).assetId, 345678);
  assert.throws(() => createStudioUploadJournalController(f.config()).begin(input), refused('UPLOAD_CONFLICT'));
});
