import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WorkStore } from '../../packages/storage/src/work-store.js';
function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'arcane-work-store-')); const project = join(dir, 'project'); mkdirSync(project); let now = Date.now();
  const store = new WorkStore({ directory: join(dir, 'state'), projectPath: project, now: () => now });
  t.after(() => { store.close(); assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + '\\') || resolve(dir).startsWith(resolve(tmpdir()) + '/')); rmSync(dir, { recursive: true, force: true }); });
  const tasks = [{ key: 'asset', title: 'Make prop', instructions: 'Create actual Blender prop.', scope: ['art/prop'], dependencies: [], acceptance: 'Validated GLB, preview and mesh metrics.' }, { key: 'game', title: 'Use prop', instructions: 'Use verified asset.', scope: ['src'], dependencies: ['asset'], acceptance: 'Actual fixture behavior.' }];
  return { dir, project, store, tasks, advance: (ms: number) => { now += ms; } };
}
test('dependency graph rejects cycles, missing keys and unsafe scopes', t => {
  const f = fixture(t); const create = (tasks: unknown) => f.store.create({ title: 'Workflow', objective: 'Produce playable feature', tasks });
  assert.throws(() => create([{ ...f.tasks[0], dependencies: ['game'] }, f.tasks[1]]), /cycle/);
  assert.throws(() => create([{ ...f.tasks[0], dependencies: ['missing'] }]), /missing/);
  for (const scope of ['../secrets', '.git/hooks', 'C:/outside', '.env', 'src/../../outside']) assert.throws(() => create([{ ...f.tasks[0], scope: [scope] }]), /safe relative/);
});
test('lease ownership, overlap and explicit review gate protect parallel task work', t => {
  const f = fixture(t); const run = f.store.create({ title: 'Workflow', objective: 'Verified artifacts', tasks: f.tasks });
  assert.equal(f.store.ready(run.id).length, 1); const first = run.tasks[0]!;
  const claim = f.store.claim({ taskId: first.id, worker: 'worker-A' }); assert.equal(claim.task.state, 'in_progress');
  assert.throws(() => f.store.claim({ taskId: first.id, worker: 'worker-B' }), /not ready/);
  assert.throws(() => f.store.progress({ taskId: first.id, leaseToken: 'wrong', progress: 'Done' }), /invalid/);
  const another = f.store.create({ title: 'Overlap', objective: 'Collision fixture', tasks: [{ ...f.tasks[0], scope: ['art'] }] });
  assert.throws(() => f.store.claim({ taskId: another.tasks[0]!.id, worker: 'worker-B' }), /overlapping/);
  writeFileSync(join(f.project, 'report.json'), '{"validated":true}');
  const submitted = f.store.submit({ taskId: first.id, leaseToken: claim.leaseToken, evidence: [{ path: 'report.json', note: 'Fixture test report (not native behavior)' }] }); assert.equal(submitted.state, 'needs_review');
  assert.equal(f.store.ready(run.id).length, 0);
  f.store.review({ taskId: first.id, approved: true, note: 'Reviewed actual fixture evidence.' }); assert.equal(f.store.ready(run.id)[0]?.key, 'game');
});
test('changed evidence cannot pass review; expiry preserves work rather than auto rerunning', t => {
  const f = fixture(t); const run = f.store.create({ title: 'Workflow', objective: 'Evidence gate', tasks: [f.tasks[0]] }); const id = run.tasks[0]!.id;
  const lease = f.store.claim({ taskId: id, worker: 'worker-A' }); writeFileSync(join(f.project, 'proof.txt'), 'original');
  f.store.submit({ taskId: id, leaseToken: lease.leaseToken, evidence: [{ path: 'proof.txt', note: 'Evidence' }] }); writeFileSync(join(f.project, 'proof.txt'), 'different');
  assert.throws(() => f.store.review({ taskId: id, approved: true, note: 'Trying stale evidence' }), /changed/);
  f.store.review({ taskId: id, approved: false, note: 'Re-run and submit new proof.' }); const next = f.store.claim({ taskId: id, worker: 'worker-B' }); f.advance(300001);
  assert.throws(() => f.store.progress({ taskId: id, leaseToken: next.leaseToken, progress: 'Late' }), /invalid or expired/);
  assert.equal(f.store.task(id).state, 'interrupted'); assert.equal(f.store.ready()[0]?.id, id);
});
