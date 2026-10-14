import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, relative, isAbsolute} from 'node:path';
import {StudioStore, type AssetUploadIntent} from '../../packages/storage/src/studio-store.js';
const ATTEMPT = '11111111-1111-4111-8111-111111111111';
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'arcane-upload-journal-'));
  let studio = new StudioStore({directory: root});
  t.after(() => {studio.close(); const p = relative(tmpdir(), root); assert.ok(!isAbsolute(p) && p.startsWith('arcane-upload-journal-') && !p.includes('..')); rmSync(root, {recursive: true, force: true});});
  const intent: AssetUploadIntent = {projectId: 'a'.repeat(64), jobId: ATTEMPT, sourceId: 'synthetic-object', sourceSha256: 'b'.repeat(64), assetType: 'Mesh',
    sessionId: 'synthetic-session', clientLifetimeId: 'synthetic-lifetime', pluginArtifactHash: 'c'.repeat(64), playEpoch: 0,
    placeId: 12, universeId: 34, creator: {kind: 'group', id: 56}, uploaderId: 78, rightsGrantId: 'synthetic-host-grant', name: 'Fixture mesh', description: ''};
  return {get studio() {return studio;}, intent, restart() {studio.close(); studio = new StudioStore({directory: root});}};
}
test('durable fresh intent is snapshotted before callback mutation and only original ticket records an outcome', t => {
  const f = fixture(t); let guards = 0;
  const result = f.studio.beginAssetUpload(ATTEMPT, f.intent, () => {if (++guards === 2) f.intent.name = 'changed later';});
  assert.equal(result.fresh, true); assert.ok(result.ticket); assert.equal(result.record.intent.name, 'Fixture mesh');
  assert.throws(() => f.studio.finishAssetUpload(structuredClone(result.ticket!), {state: 'succeeded', assetId: 123}), {code: 'UPLOAD_TICKET'});
  const observed = f.studio.finishAssetUpload(result.ticket!, {state: 'succeeded', assetId: 123});
  assert.equal(observed.assetId, 123); assert.equal(f.studio.assetUpload(ATTEMPT).state, 'succeeded');
});
test('identical repeat has no fresh execution ticket and changed attempt/account cannot bypass prior intent', t => {
  const f = fixture(t), first = f.studio.beginAssetUpload(ATTEMPT, f.intent, () => {});
  const repeat = f.studio.beginAssetUpload(ATTEMPT, f.intent, () => {});
  assert.equal(repeat.fresh, false); assert.equal(repeat.ticket, null); assert.deepEqual(repeat.record, first.record);
  for (const patch of [{uploaderId: 79}, {creator: {kind: 'user' as const, id: 80}}, {sessionId: 'new-session'}])
    assert.throws(() => f.studio.beginAssetUpload(ATTEMPT, {...f.intent, ...patch}, () => {}), {code: 'UPLOAD_CONFLICT'});
  assert.throws(() => f.studio.beginAssetUpload('22222222-2222-4222-8222-222222222222', f.intent, () => {}), {code: 'UPLOAD_CONFLICT'});
});
test('restart turns unobserved intent into reconciliation and never mints another upload ticket', t => {
  const f = fixture(t), first = f.studio.beginAssetUpload(ATTEMPT, f.intent, () => {});
  f.restart(); const repeat = f.studio.beginAssetUpload(ATTEMPT, f.intent, () => {});
  assert.equal(repeat.fresh, false); assert.equal(repeat.ticket, null); assert.equal(repeat.record.state, 'needs_reconciliation');
  assert.throws(() => f.studio.finishAssetUpload(first.ticket!, {state: 'succeeded', assetId: 123}), {code: 'UPLOAD_TICKET'});
});
test('known outcomes survive restart, duplicate facts match, and contradictory outcomes cannot overwrite', t => {
  const f = fixture(t), first = f.studio.beginAssetUpload(ATTEMPT, f.intent, () => {});
  const outcome = {state: 'succeeded' as const, assetId: 123};
  const result = f.studio.finishAssetUpload(first.ticket!, outcome);
  assert.deepEqual(f.studio.finishAssetUpload(first.ticket!, outcome), result);
  assert.throws(() => f.studio.finishAssetUpload(first.ticket!, {...outcome, assetId: 124}), {code: 'UPLOAD_CONFLICT'});
  f.restart(); assert.deepEqual(f.studio.assetUpload(ATTEMPT), result);
});
test('revoked guard before commit rolls back the intent; invalid outcome claims never enter the journal', t => {
  const f = fixture(t); let calls = 0;
  assert.throws(() => f.studio.beginAssetUpload(ATTEMPT, f.intent, () => {if (++calls === 3) throw new Error('scope retired');}), /scope retired/);
  assert.throws(() => f.studio.assetUpload(ATTEMPT), {code: 'UPLOAD_NOT_FOUND'});
  const fresh = f.studio.beginAssetUpload(ATTEMPT, f.intent, () => {});
  for (const id of [0, -1, Infinity, NaN, 0.1, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => f.studio.finishAssetUpload(fresh.ticket!, {state: 'succeeded', assetId: id}), {code: 'INPUT'});
  assert.equal(f.studio.assetUpload(ATTEMPT).state, 'intent');
});
