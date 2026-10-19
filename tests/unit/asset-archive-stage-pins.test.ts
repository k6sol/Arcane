import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { StudioStore, type AssetUploadIntent, type StageRunIntent } from '../../packages/storage/src/studio-store.js';
import type { StudioAssetStageArgs, Json } from '../../packages/protocol/src/studio.js';

// Real temporary SQLite stores with synthetic pairings, proofs and ACKs exercise archival pins.
// No Studio/SDK/provider/Blender process; no shared dist.
const projectId = 'a'.repeat(64), otherProject = '9'.repeat(64), jobId = '11111111-1111-4111-8111-111111111111', otherJob = '22222222-2222-4222-8222-222222222222';
const guard = () => {};
// Trusted synthetic model-only review port; the real human gate is exercised by asset-review-boundaries.test.ts.
const fixtureModelReview={reviewId:'99999999-9999-4999-8999-999999999999',subjectDigest:'9'.repeat(64),revision:1};
const bindFixtureReview=(value:StudioStore)=>value.bindAssetModelReview(intent=>{assert.deepEqual(intent.modelReview,fixtureModelReview);});
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const refused = (code: string) => (error: unknown) => (error as { code?: string }).code === code;

function fixture(t: test.TestContext, count = 2) {
  const base = realpathSync(tmpdir()), directory = mkdtempSync(join(base, 'arcane-archive-stage-pins-')), now = Date.now();
  let store = new StudioStore({ directory, now: () => now });bindFixtureReview(store);
  t.after(() => { try { store.close(); } catch { /* already closed */ }
    const child = relative(base, realpathSync(directory)); assert.ok(!isAbsolute(child) && child.startsWith('arcane-archive-stage-pins-') && !child.includes(sep) && !child.includes('..'));
    rmSync(directory, { recursive: true, force: true }); });
  const grant = store.createGrant({ allowedRoots: ['Workspace', 'ServerStorage'], allowWrites: true });
  const pair = store.pair({ code: grant.code, protocolVersion: 1, capabilities: ['asset.stage_packet'], identity: { clientSessionId: 'fixture-client', placeId: 12, universeId: 34, name: 'Fixture', pluginVersion: '0.1.7' } });
  store.poll(pair.sessionId, { sessionId: pair.sessionId, clientLifetimeId: 'fixture-client', pluginArtifactHash: 'b'.repeat(64), markerName: 'ArcaneTestProof_fixture', placeId: 12, universeId: 34, placeName: 'Fixture', mode: 'Edit', playEpoch: 0, continuitySupported: true, connected: true });
  const expected = { digest: 'c'.repeat(64), payloadDigest: 'd'.repeat(64), manifestDigest: 'e'.repeat(64) };
  const target: StudioAssetStageArgs['target'] = { sessionId: pair.sessionId, placeId: 12, universeId: 34, root: 'Workspace', parentRef: 'fixture-parent', creator: { kind: 'group', id: '56' } };
  const continuity = { clientLifetimeId: 'fixture-client', pluginArtifactHash: 'b'.repeat(64), playEpoch: 0 };
  const args: StudioAssetStageArgs[] = Array.from({ length: count }, (_, ordinal) => ({ expected, packet: JSON.stringify({ formatVersion: 1, payloadDigest: expected.payloadDigest, manifestDigest: expected.manifestDigest, ordinal, kind: ordinal === count - 1 ? 'seal' : ordinal === 0 ? 'begin' : 'object' }), target, continuity }));
  let bytes = 0;
  const intent = (forJob = jobId, forProject = projectId): StageRunIntent => {
    bytes = 0;
    return { projectId: forProject, jobId: forJob, modelReview:fixtureModelReview, conversation: { provider: 'codex', threadId: 'fixture-thread', sessionId: null }, transferDigest: expected.digest, payloadDigest: expected.payloadDigest, manifestDigest: expected.manifestDigest, preparedDigest: 'f'.repeat(64), target, continuity,
      plan: args.map((a, ordinal) => { const packetByteLength = Buffer.byteLength(a.packet); bytes += packetByteLength; return { ordinal, argsSha256: sha(JSON.stringify(a)), packetByteLength, envelopeByteLength: Buffer.byteLength(JSON.stringify(a)), expectedReceipt: { transferDigest: expected.digest, packetCount: ordinal + 1, byteLength: bytes, state: ordinal === count - 1 ? 'sealed' : 'receiving', engineVerification: 'pending' } }; }) };
  };
  const ack = (id: string, ordinal: number) => { assert.equal(store.poll(pair.sessionId)[0]?.id, id); store.result({ sessionId: pair.sessionId, commandId: id, state: 'succeeded', result: intent().plan[ordinal]!.expectedReceipt as unknown as Json }); };
  const upload = (attempt: string, forJob = jobId): AssetUploadIntent => ({ projectId, jobId: forJob, sourceId: 'synthetic-object-' + attempt.slice(0, 4), sourceSha256: 'b'.repeat(64), assetType: 'Mesh',
    sessionId: 'synthetic-session', clientLifetimeId: 'synthetic-lifetime', pluginArtifactHash: 'c'.repeat(64), playEpoch: 0, placeId: 12, universeId: 34, creator: { kind: 'group', id: 56 }, uploaderId: 78, rightsGrantId: 'synthetic-host-grant', name: 'Fixture mesh', description: '' });
  /** Byte-level state: every table's rows plus events count, read through a separate connection. */
  const state = () => {
    const db = new DatabaseSync(join(directory, 'studio.sqlite'), { readOnly: true });
    try {
      const tables = (db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all() as { name: string }[]).map(r => r.name);
      return tables.map(name => name + ':' + sha(JSON.stringify(db.prepare('SELECT * FROM "' + name + '"').all()))).join('|');
    } finally { db.close(); }
  };
  return { directory, pair, args, intent, ack, upload, state, get store() { return store; }, restart() { store.close(); store = new StudioStore({ directory, now: () => now });bindFixtureReview(store); } };
}

test('invalid identifiers and closed storage refuse instead of implying absence', t => {
  const f = fixture(t);
  for (const [p, j] of [['A'.repeat(64), jobId], [projectId, 'nope'], [projectId, 'ABCDEF11-1111-4111-8111-111111111111'], [projectId.slice(1), jobId], [projectId, jobId + ' ']] as const) {
    assert.throws(() => f.store.hasPendingStageWork(p, j), refused('STUDIO_STAGE_INPUT'));
  }
  f.store.close();
  assert.throws(() => f.store.hasPendingStageWork(projectId, jobId), refused('STUDIO_STAGE_CLOSED'));
});

test('no stage or upload history: not pinned, and the query writes nothing', t => {
  const f = fixture(t), before = f.state();
  assert.equal(f.store.hasPendingStageWork(projectId, jobId), false);
  assert.equal(f.state(), before);
});

test('stage phases: running, cpu-staged and needs_reconciliation pin; only closed+stopped is released', t => {
  // Open run with no commands: running.
  const a = fixture(t), started = a.store.beginStageRun(a.intent(), guard);
  assert.equal(a.store.hasPendingStageWork(projectId, jobId), true);
  // Closed with nothing enqueued: provably stopped.
  a.store.closeStageRun(started.handle!);
  assert.equal(a.store.readStageRun(projectId, jobId)?.phase, 'stopped');
  const before = a.state();
  assert.equal(a.store.hasPendingStageWork(projectId, jobId), false);
  assert.equal(a.state(), before, 'read-only on a closed run');
  // Queued then closed: the queued command is cancelled, phase stopped.
  const b = fixture(t), run = b.store.beginStageRun(b.intent(), guard);
  b.store.enqueueStagePacket(run.handle!, 0, b.args[0]!, guard);
  assert.equal(b.store.hasPendingStageWork(projectId, jobId), true, 'queued work pins while open');
  b.store.closeStageRun(run.handle!);
  assert.equal(b.store.hasPendingStageWork(projectId, jobId), false);
  // Dispatched then closed: effect unknown, needs_reconciliation pins.
  const c = fixture(t), crun = c.store.beginStageRun(c.intent(), guard);
  c.store.enqueueStagePacket(crun.handle!, 0, c.args[0]!, guard); c.store.poll(c.pair.sessionId);
  c.store.closeStageRun(crun.handle!);
  assert.equal(c.store.readStageRun(projectId, jobId)?.phase, 'needs_reconciliation');
  assert.equal(c.store.hasPendingStageWork(projectId, jobId), true);
  // Fully acknowledged: cpu-staged awaiting engine completion pins, open or closed.
  const d = fixture(t), drun = d.store.beginStageRun(d.intent(), guard);
  for (const [ordinal, packet] of d.args.entries()) { const command = d.store.enqueueStagePacket(drun.handle!, ordinal, packet, guard); d.ack(command.id, ordinal); }
  assert.equal(d.store.readStageRun(projectId, jobId)?.phase, 'cpu-staged');
  assert.equal(d.store.hasPendingStageWork(projectId, jobId), true);
  d.store.closeStageRun(drun.handle!);
  assert.equal(d.store.hasPendingStageWork(projectId, jobId), true, 'closed cpu-staged still awaits engine completion');
  // Survives restart: pins are durable facts, not process memory.
  d.restart();
  assert.equal(d.store.hasPendingStageWork(projectId, jobId), true);
});

test('exact project/job isolation for stage runs', t => {
  const f = fixture(t);
  f.store.beginStageRun(f.intent(), guard);
  assert.equal(f.store.hasPendingStageWork(projectId, jobId), true);
  assert.equal(f.store.hasPendingStageWork(projectId, otherJob), false);
  assert.equal(f.store.hasPendingStageWork(otherProject, jobId), false);
});

test('uploads: unknown intent and needs_reconciliation pin; a known success does not; other jobs are isolated', t => {
  const f = fixture(t);
  const a = '33333333-3333-4333-8333-333333333333', b = '44444444-4444-4444-8444-444444444444', c = '55555555-5555-4555-8555-555555555555';
  const first = f.store.beginAssetUpload(a, f.upload(a), guard);
  assert.equal(f.store.hasPendingStageWork(projectId, jobId), true, 'intent: effect unknown');
  f.store.finishAssetUpload(first.ticket!, { state: 'succeeded', assetId: 123 });
  assert.equal(f.store.hasPendingStageWork(projectId, jobId), false, 'known success');
  const second = f.store.beginAssetUpload(b, f.upload(b), guard);
  f.store.finishAssetUpload(second.ticket!, { state: 'needs_reconciliation', assetId: null });
  assert.equal(f.store.hasPendingStageWork(projectId, jobId), true);
  f.store.beginAssetUpload(c, f.upload(c, otherJob), guard);
  assert.equal(f.store.hasPendingStageWork(projectId, otherJob), true);
  assert.equal(f.store.hasPendingStageWork(otherProject, otherJob), false);
  f.restart();
  assert.equal(f.store.hasPendingStageWork(projectId, jobId), true, 'durable after restart');
});

test('corrupt stage or upload journals refuse rather than imply absence', t => {
  const f = fixture(t);
  const a = '33333333-3333-4333-8333-333333333333';
  const first = f.store.beginAssetUpload(a, f.upload(a, otherJob), guard); f.store.finishAssetUpload(first.ticket!, { state: 'succeeded', assetId: 1 });
  const db = new DatabaseSync(join(f.directory, 'studio.sqlite'));
  try { db.prepare('UPDATE asset_uploads SET payload=? WHERE attempt_id=?').run('{not json', a); } finally { db.close(); }
  assert.throws(() => f.store.hasPendingStageWork(projectId, jobId), refused('UPLOAD_JOURNAL'), 'even an unrelated corrupt upload refuses');
  const g = fixture(t); g.store.beginStageRun(g.intent(), guard);
  const gdb = new DatabaseSync(join(g.directory, 'studio.sqlite'));
  try { gdb.prepare('UPDATE asset_stage_attempts SET payload=?').run('{}'); } finally { gdb.close(); }
  assert.throws(() => g.store.hasPendingStageWork(projectId, jobId));
  assert.equal(g.store.hasPendingStageWork(projectId, otherJob), false, 'other job unaffected by its corrupt sibling');
});

test('upload success needs a positive asset identity and the exact stored intent before releasing an archival pin',t=>{
  const f=fixture(t),attempt='33333333-3333-4333-8333-333333333333';
  const first=f.store.beginAssetUpload(attempt,f.upload(attempt),guard);
  const valid=f.store.finishAssetUpload(first.ticket!,{state:'succeeded',assetId:123});
  const db=new DatabaseSync(join(f.directory,'studio.sqlite'));
  try{
    const variants=[...([null,0,-1,1.5] as const).map(assetId=>({...valid,assetId})),
      {...valid,intentSha256:'f'.repeat(64)},{...valid,resourceKey:'f'.repeat(64)},
      {...valid,intent:{...valid.intent,jobId:otherJob}},
      {...valid,state:'intent',assetId:123},{...valid,extra:'unexpected'},
      {...valid,intent:{...valid.intent,name:'x'.repeat(17000)}}];
    for(const variant of variants){
      db.prepare('UPDATE asset_uploads SET payload=? WHERE attempt_id=?').run(JSON.stringify(variant),attempt);
      const before=f.state();
      assert.throws(()=>f.store.hasPendingStageWork(projectId,jobId),refused('UPLOAD_JOURNAL'));
      assert.equal(f.state(),before,'a refused read cannot rewrite the journal');
    }
    db.prepare('UPDATE asset_uploads SET payload=? WHERE attempt_id=?').run(JSON.stringify(valid),attempt);
    assert.equal(f.store.hasPendingStageWork(projectId,jobId),false);
  }finally{db.close();}
});
