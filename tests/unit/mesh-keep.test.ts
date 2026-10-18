import test from 'node:test';
import assert from 'node:assert/strict';
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { StudioStore } from '../../packages/storage/src/studio-store.js';
import type { Json } from '../../packages/protocol/src/studio.js';
import { validateCommandArgs } from '../../packages/core/src/studio-policy.js';
import { validateMeshKeepReceipt } from '../../packages/core/src/mesh-keep-policy.js';
import { createMeshKeep, meshKeepMessage, MESH_KEEP_CONSENT_MESSAGE } from '../../apps/daemon/src/mesh-keep-routes.js';
import { importContextFixture } from './studio-import-context-fixture.js';
import { makeFixtureDirectory, fixtureTempDirectory } from './windows-fixture-paths.js';

// Synthetic store + simulated plugin only: no Studio, no Roblox API, no network.
const digest = 'cd'.repeat(32), consent = 'e'.repeat(64);
function fixture(t: test.TestContext, capabilities = ['scene.upload_context', 'scene.place_asset', 'scene.children', 'asset.keep_mesh']) {
  const directory = makeFixtureDirectory('arcane-mesh-keep-');
  let clock = Date.parse('2026-10-18T10:00:00.000Z'), ids = 0;
  const now = () => clock;
  const store = new StudioStore({ directory, now });
  t.after(() => { store.close(); assert.ok(resolve(directory).startsWith(resolve(fixtureTempDirectory()) + sep)); rmSync(directory, { recursive: true, force: true }); });
  const grant = store.createGrant({ allowedRoots: ['Workspace', 'ServerStorage'], allowWrites: true });
  const paired = store.pair({ code: grant.code, protocolVersion: 1, capabilities, identity: { clientSessionId: 'keep-client', placeId: 12, universeId: 34, name: 'Keep place', pluginVersion: '0.2.0' } });
  const sessionId = paired.sessionId;
  const proof = { sessionId, clientLifetimeId: 'keep-client', pluginArtifactHash: 'a'.repeat(64), markerName: 'ArcaneTestProof_keep', placeId: 12, universeId: 34, placeName: 'Keep place', mode: 'Edit', playEpoch: 0, continuitySupported: true, connected: true };
  const { observation } = importContextFixture();
  const plugin = { uploaderId: 78 as number | null, contexts: 0 };
  /** Simulated plugin: heartbeats and answers the account read the service asks for. */
  const pump = () => {
    for (const c of store.poll(sessionId, proof)) {
      if (c.method === 'scene.upload_context') {
        plugin.contexts++;
        store.result({ sessionId, commandId: c.id, state: 'succeeded', result: { ...observation, sessionId, parentRef: { ...observation.parentRef, sessionId },
          uploader: plugin.uploaderId === null ? { status: 'unavailable', id: null, provenance: 'StudioService:GetUserId' } : { status: 'available', id: plugin.uploaderId, provenance: 'StudioService:GetUserId' } } as unknown as Json });
      }
    }
  };
  pump();
  const parent = { instanceId: 'w', sessionId, root: 'Workspace', pathSegments: [], className: 'Workspace' };
  const placed = store.enqueue({ sessionId, requestId: 'place-request-1', method: 'scene.place_asset', args: { watch: 'editable-' + digest, parent, name: 'OakTemplate', position: [0, 0, 0], yaw: 0, ground: true, anchor: true, allowScripts: false } });
  store.poll(sessionId, proof);
  store.result({ sessionId, commandId: placed.id, state: 'succeeded', result: { ref: { ...parent, instanceId: 'm', pathSegments: ['OakTemplate'], className: 'Model' },
    mutation: { kind: 'scene.place_asset', ref: { ...parent, instanceId: 'm', pathSegments: ['OakTemplate'], className: 'Model' }, before: null, after: { descendants: 2, removedScripts: 0, keptScripts: 0, scale: 1 } } } as unknown as Json });
  const keep = createMeshKeep({ store, stateDirectory: directory, now, uuid: () => '00000000-0000-4000-8000-' + String(++ids).padStart(12, '0'),
    sleep: async ms => { clock += ms; pump(); } });
  /** Deliver the queued keep command and report a plugin receipt. */
  const answer = (result: unknown, state: 'succeeded' | 'failed' = 'succeeded', error?: string) => {
    const commands = store.poll(sessionId, proof).filter(c => c.method === 'asset.keep_mesh');
    assert.equal(commands.length, 1);
    store.result({ sessionId, commandId: commands[0]!.id, state, ...(result === undefined ? {} : { result: result as Json }), ...(error ? { error } : {}) });
    return commands[0]!;
  };
  return { store, keep, sessionId, plugin, answer, directory, proof, advance: (ms: number) => { clock += ms; } };
}
const mesh = (index: number, assetId: number | null, upload: string, swapped: boolean, reason: string | null = null) => ({ index, name: 'SM_oak_' + index, assetId, upload, reason, swapped });

function savedRecord(sessionId: string, index = 1) {
  return { attemptId: '00000000-0000-4000-8000-' + String(index).padStart(12, '0'), digest: 'ab'.repeat(32), sessionId,
    placeName: 'Keep place', name: 'Old mesh', creatorId: 78, meshCount: null, consentedAt: '2026-10-18T09:00:00.000Z',
    commandId: '', finishCommandId: null, state: 'unknown', assets: [], uploadsStarted: null,
    message: 'Check the original upload.', acknowledged: false, updatedAt: '2026-10-18T09:00:00.000Z' };
}

test('receipt history preserves an unresolved upload when more than 200 later attempts are recorded', async t => {
  const f = fixture(t), old = savedRecord(f.sessionId, 1000);
  const receipts = [old, ...Array.from({ length: 200 }, (_, i) => ({ ...savedRecord(f.sessionId, i + 1001), state: 'failed' }))];
  mkdirSync(join(f.directory, 'mesh-keep'));
  const file = join(f.directory, 'mesh-keep/receipts.json');
  writeFileSync(file, JSON.stringify({ version: 1, receipts }));
  f.keep.enableConsentChannel();
  const prepared = await f.keep.prepare({ digest, sessionId: f.sessionId });
  f.keep.acceptConsent({ type: MESH_KEEP_CONSENT_MESSAGE, protocolVersion: 1, prepareId: prepared.prepareId, consent });
  await f.keep.start({ prepareId: prepared.prepareId, consent });
  const persisted = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(persisted.receipts.length, 202);
  assert.deepEqual(persisted.receipts[0], old);
});

test('malformed saved receipts are retained and refuse a new upload before any command is queued', async t => {
  for (const change of [(row: any) => { row.state = 'done'; }, (row: any) => { row.digest = 'bad'; },
    (row: any) => { row.creatorId = -1; }, (row: any) => { row.acknowledged = 'yes'; },
    (row: any) => { row.assets = [{ index: 1, assetId: '5' }]; }, (row: any) => { row.extra = 'unexpected'; }]) {
    const f = fixture(t), record = savedRecord(f.sessionId); change(record);
    mkdirSync(join(f.directory, 'mesh-keep'));
    const file = join(f.directory, 'mesh-keep/receipts.json'), original = JSON.stringify({ version: 1, receipts: [record] });
    writeFileSync(file, original); f.keep.enableConsentChannel();
    await assert.rejects(f.keep.prepare({ digest, sessionId: f.sessionId }), { code: 'MESH_KEEP_RECEIPTS' });
    assert.equal(readFileSync(file, 'utf8'), original);
    assert.equal(f.store.commands(f.sessionId).some(command => command.method === 'asset.keep_mesh'), false);
  }
});

test('duplicate, oversized and hardlinked receipt files refuse before an account or upload command', async t => {
  for (const kind of ['duplicate', 'oversized', 'hardlink']) {
    const f = fixture(t), row = savedRecord(f.sessionId);
    mkdirSync(join(f.directory, 'mesh-keep'));
    const file = join(f.directory, 'mesh-keep/receipts.json');
    if (kind === 'oversized') writeFileSync(file, Buffer.alloc(8 * 1024 * 1024 + 1, 32));
    else {
      const text = JSON.stringify({ version: 1, receipts: kind === 'duplicate' ? [row, row] : [row] });
      if (kind === 'hardlink') { const original = join(f.directory, 'original.json'); writeFileSync(original, text); linkSync(original, file); }
      else writeFileSync(file, text);
    }
    const before = readFileSync(file); f.keep.enableConsentChannel();
    await assert.rejects(f.keep.prepare({ digest, sessionId: f.sessionId }), { code: 'MESH_KEEP_RECEIPTS' });
    assert.deepEqual(readFileSync(file), before);
    assert.equal(f.plugin.contexts, 0); assert.equal(f.store.commands(f.sessionId).length, 1);
  }
});

test('a new service recovers the recorded attempt and keeps a delivered failure unresolved', async t => {
  const f = fixture(t); f.keep.enableConsentChannel();
  const prepared = await f.keep.prepare({ digest, sessionId: f.sessionId });
  f.keep.acceptConsent({ type: MESH_KEEP_CONSENT_MESSAGE, protocolVersion: 1, prepareId: prepared.prepareId, consent });
  const { receipt } = await f.keep.start({ prepareId: prepared.prepareId, consent });
  const recovered = createMeshKeep({ store: f.store, stateDirectory: f.directory, now: () => Date.parse('2026-10-18T10:00:00.000Z') });
  assert.equal((await recovered.state()).candidates[0]!.receipt!.attemptId, receipt.attemptId);
  f.answer(undefined, 'failed', 'UNKNOWN_AFTER_DELIVERY');
  assert.equal((await recovered.state()).candidates[0]!.receipt!.state, 'unknown');
  recovered.enableConsentChannel();
  await assert.rejects(recovered.prepare({ digest, sessionId: f.sessionId }), { code: 'MESH_KEEP_STATE' });
});

test('a consent that expires while start reads current state cannot queue an upload', async t => {
  const f = fixture(t); f.keep.enableConsentChannel();
  const prepared = await f.keep.prepare({ digest, sessionId: f.sessionId });
  f.keep.acceptConsent({ type: MESH_KEEP_CONSENT_MESSAGE, protocolVersion: 1, prepareId: prepared.prepareId, consent });
  const starting = f.keep.start({ prepareId: prepared.prepareId, consent });
  f.advance(120000);
  f.store.poll(f.sessionId, f.proof); // A fresh heartbeat cannot refresh the person's expired confirmation.
  await assert.rejects(starting, { code: 'MESH_KEEP_CONSENT' });
  assert.equal(f.store.commands(f.sessionId).some(command => command.method === 'asset.keep_mesh'), false);
});

test('keep: refused without the desktop consent channel; prepare names the signed-in account; consent arrives only over IPC and is single-use', async t => {
  const f = fixture(t);
  let state = await f.keep.state();
  assert.equal(state.consentChannel, false);
  assert.deepEqual(state.candidates.map(c => [c.digest, c.name, c.action, c.receipt]), [[digest, 'OakTemplate', 'keep', null]]);
  await assert.rejects(f.keep.prepare({ digest, sessionId: f.sessionId }), { code: 'MESH_KEEP_DESKTOP' });
  f.keep.enableConsentChannel();
  f.plugin.uploaderId = null;
  await assert.rejects(f.keep.prepare({ digest, sessionId: f.sessionId }), { code: 'STUDIO_ACCOUNT' });
  f.plugin.uploaderId = 78;
  const prepared = await f.keep.prepare({ digest, sessionId: f.sessionId, name: 'Old oak' });
  assert.deepEqual({ ...prepared, prepareId: 'x', expiresAt: 'x' }, { prepareId: 'x', account: { kind: 'user', userId: 78 }, name: 'Old oak', meshCount: null, placeName: 'Keep place', expiresAt: 'x' });
  // Without the IPC consent (or with another one) nothing is queued.
  await assert.rejects(f.keep.start({ prepareId: prepared.prepareId, consent }), { code: 'MESH_KEEP_CONSENT' });
  assert.equal(f.store.commands(f.sessionId).some(c => c.method === 'asset.keep_mesh'), false);
  const again = await f.keep.prepare({ digest, sessionId: f.sessionId });
  for (const bad of [{ type: MESH_KEEP_CONSENT_MESSAGE, protocolVersion: 1, prepareId: again.prepareId, consent: 'short' },
    { type: 'other', protocolVersion: 1, prepareId: again.prepareId, consent }, { type: MESH_KEEP_CONSENT_MESSAGE, protocolVersion: 1, prepareId: again.prepareId, consent, extra: 1 }])
    assert.equal(f.keep.acceptConsent(bad), false);
  assert.equal(f.keep.acceptConsent({ type: MESH_KEEP_CONSENT_MESSAGE, protocolVersion: 1, prepareId: again.prepareId, consent }), true);
  assert.equal(f.keep.acceptConsent({ type: MESH_KEEP_CONSENT_MESSAGE, protocolVersion: 1, prepareId: again.prepareId, consent: 'f'.repeat(64) }), false, 'one consent per confirmation');
  await assert.rejects(f.keep.start({ prepareId: again.prepareId, consent: 'f'.repeat(64) }), { code: 'MESH_KEEP_CONSENT' });
  await assert.rejects(f.keep.start({ prepareId: again.prepareId, consent }), { code: 'MESH_KEEP_CONSENT' }, 'a refused start consumes the confirmation');
  const third = await f.keep.prepare({ digest, sessionId: f.sessionId });
  f.keep.acceptConsent({ type: MESH_KEEP_CONSENT_MESSAGE, protocolVersion: 1, prepareId: third.prepareId, consent });
  const started = await f.keep.start({ prepareId: third.prepareId, consent });
  assert.equal(started.receipt.state, 'uploading');
  // The durable intent receipt exists on disk before (and with) the queued command.
  const saved = JSON.parse(readFileSync(join(f.directory, 'mesh-keep', 'receipts.json'), 'utf8'));
  assert.equal(saved.receipts[0].attemptId, started.receipt.attemptId); assert.equal(saved.receipts[0].commandId, started.receipt.commandId);
  const command = f.store.command(started.receipt.commandId);
  assert.equal(command.method, 'asset.keep_mesh');
  assert.deepEqual(command.args, { source: 'editable-' + digest, attemptId: started.receipt.attemptId, name: 'OakTemplate', description: 'Procedural mesh made with Arcane and kept by its owner.',
    creatorId: 78, continuity: { clientLifetimeId: 'keep-client', pluginArtifactHash: 'a'.repeat(64), playEpoch: 0 }, finish: false });
  state = await f.keep.state();
  assert.equal(state.candidates[0]!.action, 'none', 'no second keep while one is in flight');
  await assert.rejects(f.keep.prepare({ digest, sessionId: f.sessionId }), { code: 'MESH_KEEP_STATE' });
});

test('keep: uploaded-but-not-swapped offers Finish keeping (no upload); finish reuses exactly the recorded IDs', async t => {
  const f = fixture(t); f.keep.enableConsentChannel();
  const prepared = await f.keep.prepare({ digest, sessionId: f.sessionId });
  f.keep.acceptConsent({ type: MESH_KEEP_CONSENT_MESSAGE, protocolVersion: 1, prepareId: prepared.prepareId, consent });
  await f.keep.start({ prepareId: prepared.prepareId, consent });
  f.answer({ state: 'uploaded', meshes: [mesh(1, 111, 'succeeded', false), mesh(2, 222, 'succeeded', false)], uploadsStarted: 2, swapped: 0, persistence: 'studio-session-only', creatorId: 78, ref: null });
  let candidate = (await f.keep.state()).candidates[0]!;
  assert.equal(candidate.receipt!.state, 'uploaded'); assert.equal(candidate.action, 'finish');
  assert.match(candidate.receipt!.message, /111, 222/); assert.match(candidate.receipt!.message, /Finish keeping/);
  await f.keep.finish({ attemptId: candidate.receipt!.attemptId });
  const finishCommand = f.answer({ state: 'kept', meshes: [mesh(1, 111, 'reused', true), mesh(2, 222, 'reused', true)], uploadsStarted: 0, swapped: 2, persistence: 'saved-asset', creatorId: 78, ref: { instanceId: 'm' } });
  assert.equal(finishCommand.args.finish, true); assert.deepEqual(finishCommand.args.assetIds, [111, 222]);
  candidate = (await f.keep.state()).candidates[0]!;
  assert.equal(candidate.receipt!.state, 'kept'); assert.equal(candidate.action, 'none'); assert.equal(candidate.receipt!.uploadsStarted, 2);
  assert.match(candidate.receipt!.message, /^Kept\./);
});

test('keep: unknown outcomes block a new keep until the person checked; engine rejections name quota and moderation', async t => {
  const f = fixture(t); f.keep.enableConsentChannel();
  const prepared = await f.keep.prepare({ digest, sessionId: f.sessionId });
  f.keep.acceptConsent({ type: MESH_KEEP_CONSENT_MESSAGE, protocolVersion: 1, prepareId: prepared.prepareId, consent });
  await f.keep.start({ prepareId: prepared.prepareId, consent });
  f.answer({ state: 'failed', meshes: [mesh(1, null, 'reconciliation', false, 'ENGINE_OUTCOME_UNKNOWN')], uploadsStarted: 1, swapped: 0, persistence: 'studio-session-only', creatorId: 78, ref: null });
  let candidate = (await f.keep.state()).candidates[0]!;
  assert.equal(candidate.receipt!.state, 'unknown'); assert.equal(candidate.action, 'none'); assert.match(candidate.receipt!.message, /Check your Roblox inventory/);
  await assert.rejects(f.keep.prepare({ digest, sessionId: f.sessionId }), { code: 'MESH_KEEP_STATE' });
  await f.keep.acknowledge({ attemptId: candidate.receipt!.attemptId });
  candidate = (await f.keep.state()).candidates[0]!;
  assert.equal(candidate.action, 'keep');
  const quota = meshKeepMessage('failed', { assets: [mesh(1, null, 'failed', false, 'ENGINE_REJECTED:UploadLimitExceeded')], meshCount: 1 });
  assert.match(quota, /upload quota or limit reached \(UploadLimitExceeded\)/);
  assert.match(meshKeepMessage('failed', { assets: [mesh(1, null, 'failed', false, 'ENGINE_REJECTED:ModerationFailed')], meshCount: 1 }), /moderation/);
  assert.match(meshKeepMessage('failed', { assets: [mesh(1, null, 'failed', false, 'ENGINE_REJECTED:PermissionDenied')], meshCount: 1 }), /PermissionDenied/);
});

test('keep: store admits asset.keep_mesh only from the host service; receipts and restore are closed', async t => {
  const f = fixture(t);
  const args = { source: 'editable-' + digest, attemptId: '00000000-0000-4000-8000-000000000099', name: 'Oak', description: '', creatorId: 78,
    continuity: { clientLifetimeId: 'keep-client', pluginArtifactHash: 'a'.repeat(64), playEpoch: 0 }, finish: false };
  assert.throws(() => f.store.enqueue({ sessionId: f.sessionId, requestId: 'agent-keep-1', method: 'asset.keep_mesh', args }), { code: 'MESH_KEEP_AUTHORITY' });
  await assert.rejects(f.store.enqueueVerified({ sessionId: f.sessionId, requestId: 'agent-keep-2', method: 'asset.keep_mesh', args }, null), { code: 'MESH_KEEP_AUTHORITY' });
  const session = f.store.session(f.sessionId);
  for (const bad of [{ ...args, source: 'editable-xyz' }, { ...args, name: '' }, { ...args, name: 'x'.repeat(51) }, { ...args, creatorId: 0 }, { ...args, assetIds: [1] },
    { ...args, finish: true }, { ...args, extra: 1 }, { ...args, continuity: { ...args.continuity, pluginArtifactHash: 'no' } }])
    assert.throws(() => validateCommandArgs('asset.keep_mesh', bad, session), { code: 'INPUT' });
  assert.throws(() => validateCommandArgs('asset.keep_mesh', args, { ...session, capabilities: ['scene.children'] }), { code: 'PLUGIN_UPDATE_REQUIRED' });
  assert.throws(() => validateCommandArgs('asset.keep_mesh', args, { ...session, allowWrites: false }), { code: 'READ_ONLY' });
  // Receipt states must match their entries exactly.
  const ok = { state: 'kept', meshes: [mesh(1, 5, 'succeeded', true)], uploadsStarted: 1, swapped: 1, persistence: 'saved-asset', creatorId: 78, ref: null };
  assert.equal(validateMeshKeepReceipt(args, ok).state, 'kept');
  for (const bad of [{ ...ok, state: 'uploaded' }, { ...ok, persistence: 'studio-session-only' }, { ...ok, creatorId: 79 }, { ...ok, swapped: 0 },
    { ...ok, meshes: [mesh(1, null, 'succeeded', false)] }, { ...ok, meshes: [mesh(1, 5, 'reused', true)] }, { ...ok, meshes: [mesh(2, 5, 'succeeded', true)] }])
    assert.throws(() => validateMeshKeepReceipt(args, bad), { code: 'RECEIPT' });
  assert.throws(() => validateMeshKeepReceipt({ ...args, finish: true, assetIds: [5] }, ok), { code: 'RECEIPT' }, 'finishing never uploads');
  // A completed keep cannot be "restored" into an un-upload.
  f.keep.enableConsentChannel();
  const prepared = await f.keep.prepare({ digest, sessionId: f.sessionId });
  f.keep.acceptConsent({ type: MESH_KEEP_CONSENT_MESSAGE, protocolVersion: 1, prepareId: prepared.prepareId, consent });
  const { receipt } = await f.keep.start({ prepareId: prepared.prepareId, consent });
  const command = f.answer({ ...ok, creatorId: 78 });
  assert.equal(f.store.command(command.id).state, 'succeeded');
  assert.throws(() => f.store.restore({ commandId: command.id, requestId: 'restore-keep-1' }), { code: 'RESTORE' });
  assert.equal((await f.keep.state()).candidates[0]!.receipt!.attemptId, receipt.attemptId);
});

test('keep routes: agent and missing bearers are refused before any work', async t => {
  const f = fixture(t);
  for (const authorization of [undefined, 'Bearer ' + 'b'.repeat(64)]) {
    let status = 0, body = '';
    const response = { headersSent: false, destroyed: false, writeHead(code: number) { status = code; }, end(text: string) { body = text; } };
    const handled = await f.keep.handle({ headers: { authorization }, method: 'GET' } as never, response as never, new URL('http://127.0.0.1:1/v1/mesh-keep/state'), 'a'.repeat(64), 'http://127.0.0.1:1');
    assert.equal(handled, true); assert.equal(status, 403); assert.equal(JSON.parse(body).error, 'SCOPE');
  }
  assert.equal(await f.keep.handle({ headers: {}, method: 'GET' } as never, {} as never, new URL('http://127.0.0.1:1/v1/other'), 'a'.repeat(64), 'http://127.0.0.1:1'), false);
});
