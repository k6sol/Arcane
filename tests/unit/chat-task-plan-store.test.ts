import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { join, relative, sep, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { ChatTaskStore, CHAT_TASK_PLAN_POLICY, ChatTaskPlanError, type ChatTaskRecord } from '../../packages/storage/src/chat-task-store.js';
import { sqliteTransportPath } from '../../packages/storage/src/sqlite-path.js';
import { workflowProjectIdentity } from '../../packages/storage/src/workflow-store.js';

// Real temp SQLite and owned fake data only; no coordinator, native client, WorkStore, inference or Studio.
const ACCOUNT = 'a'.repeat(64), OTHER = 'b'.repeat(64);
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const unhandled: unknown[] = []; process.on('unhandledRejection', error => { unhandled.push(error); });
const V1 = [
  'CREATE TABLE chat_tasks(id TEXT PRIMARY KEY,payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB))<=524288)) STRICT',
  'CREATE TABLE chat_task_meta(id INTEGER PRIMARY KEY CHECK(id=1),project_id TEXT NOT NULL,project_path TEXT NOT NULL) STRICT',
  'CREATE TABLE chat_task_owner(id INTEGER PRIMARY KEY CHECK(id=1),pid INTEGER NOT NULL,token TEXT NOT NULL) STRICT',
];
const PROPOSALS = 'CREATE TABLE chat_task_proposals(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,request_id TEXT NOT NULL UNIQUE,payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB))<=98304)) STRICT';
const PLANS = 'CREATE TABLE chat_task_plans(id TEXT PRIMARY KEY,task_id TEXT NOT NULL UNIQUE,payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB))<=8192)) STRICT';
const STEPS = 'CREATE TABLE chat_task_plan_steps(id TEXT PRIMARY KEY,plan_id TEXT NOT NULL,step_key TEXT NOT NULL,seq INTEGER NOT NULL,payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB))<=8192),UNIQUE(plan_id,step_key),UNIQUE(plan_id,seq)) STRICT';

async function fixture(t: test.TestContext) {
  const base = await realpath(tmpdir()), root = await realpath(await mkdtemp(join(base, 'arcane-plan-store-'))), project = join(root, 'project'), directory = join(root, 'state');
  await mkdir(project); await mkdir(directory, { mode: 0o700 });
  const stores: ChatTaskStore[] = [];
  t.after(async () => { for (const store of stores) try { store.close(); } catch { /* closed by the case */ }
    const part = relative(base, root); assert.ok(part.startsWith('arcane-plan-store-') && !isAbsolute(part) && !part.includes(sep)); await rm(root, { recursive: true, force: true }); });
  const open = () => { const store = new ChatTaskStore({ directory, projectPath: project }); stores.push(store); return store; };
  return { root, project, directory, file: join(directory, 'chat-tasks.sqlite'), open };
}
function task(overrides: Partial<ChatTaskRecord> = {}) {
  return { id: randomUUID(), provider: 'codex' as const, threadId: 'thread:exact', sessionId: 'session:exact', connectionId: randomUUID(), incarnationId: randomUUID(), model: 'fixture', effort: 'low',
    allowWorkspaceWrites: true, allowAssets: false, state: 'working' as const, round: 0 as const, operationId: null, turnId: null, nativeSettled: false, acknowledged: false,
    repairDispatch: 'not_requested' as const, prepared: null, evidence: [], reason: null, ...overrides };
}
const code = (name: ChatTaskPlanError['code']) => (error: unknown) => error instanceof ChatTaskPlanError && error.code === name;
const result = (text: string) => ({ threadId: 'w', sessionId: null, turnId: 'w:' + randomUUID(), text, textSha256: sha(text), textBytes: Buffer.byteLength(text) });
function harness(store: ChatTaskStore, overrides: Partial<ChatTaskRecord> = {}) {
  const value = store.create(task(overrides)), plan = store.createPlan({ taskId: value.id, accountIdentity: ACCOUNT, objectiveSha256: sha('objective'), inputSha256: sha('input') });
  const live = { accountIdentity: ACCOUNT };
  const worker = (round: number, index: number, outcome: 'proposed' | 'failed' | 'unknown' | null = 'proposed', text = 'Proposal ' + round + ':' + index) => {
    const proposal = store.reserveProposal({ id: randomUUID(), taskId: value.id, requestId: randomUUID(), promptSha256: sha('p'), promptBytes: 1 });
    const step = store.reservePlanStep({ planId: plan.id, kind: 'worker', round, index, live, proposalId: proposal.id });
    if (outcome) store.settleProposal(proposal.id, outcome === 'proposed' ? { state: 'proposed', result: result(text) } : { state: outcome, reason: outcome === 'failed' ? 'output_rejected' : 'dispatch_uncertain' });
    return { proposal, step: outcome ? store.syncWorkerStep({ stepId: step.id }) : step };
  };
  const incorporate = (round: number, proposalIds: string[], terminal: 'completed' | 'failed' = 'completed') => {
    const step = store.reservePlanStep({ planId: plan.id, kind: 'incorporation', round, index: 0, live, proposalIds });
    store.acknowledgePlanStep({ stepId: step.id, native: { operationId: 'op:' + round, turnId: 'turn:' + round } });
    return store.settlePlanStep({ stepId: step.id, outcome: { state: 'completed', terminal } });
  };
  return { task: value, plan, live, worker, incorporate };
}
function v1Journal(file: string, project: string, tasks: object[], extra: string[] = [], version = 1) {
  const identity = workflowProjectIdentity(project), db = new DatabaseSync(sqliteTransportPath(file));
  db.exec('BEGIN'); for (const ddl of [...V1, ...extra]) db.exec(ddl);
  db.prepare('INSERT INTO chat_task_meta VALUES(1,?,?)').run(identity.projectId, identity.projectPath);
  for (const value of tasks) db.prepare('INSERT INTO chat_tasks(id,payload) VALUES(?,?)').run((value as { id: string }).id, JSON.stringify(value));
  db.exec(`PRAGMA application_id=${0x41524354};PRAGMA user_version=${version};COMMIT;`); db.close();
}
const fullTask = (project: string, state: ChatTaskRecord['state']) => { const identity = workflowProjectIdentity(project), now = new Date().toISOString();
  return { ...task({ state }), projectId: identity.projectId, projectPath: identity.projectPath, revision: 0, createdAt: now, updatedAt: now }; };
async function inventory(f: { file: string; directory: string }) { return { bytes: await readFile(f.file), names: (await readdir(f.directory)).sort() }; }
function schema(file: string) { const db = new DatabaseSync(sqliteTransportPath(file)); try {
  return { version: Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version),
    sql: (db.prepare("SELECT sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all() as { sql: string }[]).map(row => row.sql).sort() }; } finally { db.close(); } }

test('v1, v2 and v3 journals migrate to v4 with tasks and proposals preserved', async t => {
  for (const version of [1, 2, 3]) await t.test('v' + version, async st => {
    const f = await fixture(st), kept = fullTask(f.project, 'verified');
    v1Journal(f.file, f.project, [kept], version === 3 ? [PROPOSALS, PLANS, STEPS] : version === 2 ? [PROPOSALS] : [], version);
    const store = f.open();
    assert.deepEqual(store.get(kept.id), kept); assert.equal(store.plan(kept.id), null); store.close();
    const after = schema(f.file); assert.equal(after.version, 4); assert.deepEqual(after.sql, [...V1, PROPOSALS, PLANS, STEPS].sort());
  });
});

test('newer, foreign, corrupt and inconsistent plan state is refused byte-intact', async t => {
  const cases: [string, (f: Awaited<ReturnType<typeof fixture>>) => void, RegExp][] = [
    ['v5 newer', f => { const db = new DatabaseSync(sqliteTransportPath(f.file)); db.exec('PRAGMA user_version=5;CREATE TABLE future_state(id INTEGER PRIMARY KEY)'); db.close(); }, /newer/],
    ['v3 with a foreign table', f => { v1Journal(f.file, f.project, [], [PROPOSALS, PLANS, STEPS, 'CREATE TABLE extra(id INTEGER PRIMARY KEY)'], 3); }, /schema or project/],
    ['v3 missing the step table', f => { v1Journal(f.file, f.project, [], [PROPOSALS, PLANS], 3); }, /schema or project/],
    ['plan row for an unknown task', f => { v1Journal(f.file, f.project, [], [PROPOSALS, PLANS, STEPS], 3); const db = new DatabaseSync(sqliteTransportPath(f.file)); const id = randomUUID(), taskId = randomUUID();
      db.prepare('INSERT INTO chat_task_plans VALUES(?,?,?)').run(id, taskId, JSON.stringify({ id, taskId })); db.close(); }, /corrupt|unknown task/],
    ['unparseable plan row', f => { const value = fullTask(f.project, 'working'); v1Journal(f.file, f.project, [value], [PROPOSALS, PLANS, STEPS], 3);
      const db = new DatabaseSync(sqliteTransportPath(f.file)); db.prepare('INSERT INTO chat_task_plans VALUES(?,?,?)').run(randomUUID(), value.id, '{'); db.close(); }, /corrupt/],
  ];
  for (const [name, prepare, expected] of cases) await t.test(name, async st => {
    const f = await fixture(st); prepare(f); const before = await inventory(f);
    assert.throws(() => new ChatTaskStore({ directory: f.directory, projectPath: f.project }), expected); assert.deepEqual(await inventory(f), before);
  });
  await t.test('step sequence gap', async st => {
    const f = await fixture(st), store = f.open(), h = harness(store); const { step } = h.worker(1, 0); store.close();
    const db = new DatabaseSync(sqliteTransportPath(f.file)); db.prepare('UPDATE chat_task_plan_steps SET seq=2,payload=? WHERE id=?').run(JSON.stringify({ ...step, seq: 2 }), step.id); db.close();
    const before = await inventory(f); assert.throws(() => new ChatTaskStore({ directory: f.directory, projectPath: f.project }), /order is corrupt/); assert.deepEqual(await inventory(f), before);
  });
});

test('a full bounded plan: two rounds, five workers, canonical fan-in, evidence reference is never acceptance', async t => {
  const f = await fixture(t), store = f.open(), h = harness(store);
  assert.deepEqual(h.plan.policy, CHAT_TASK_PLAN_POLICY); assert.equal(h.plan.policy.parentSteps, 2);
  assert.equal(h.plan.binding.accountIdentity, ACCOUNT); assert.equal(h.plan.binding.incarnationId, h.task.incarnationId);
  const r1 = [h.worker(1, 0), h.worker(1, 1, 'failed'), h.worker(1, 2)];
  assert.throws(() => store.reservePlanStep({ planId: h.plan.id, kind: 'worker', round: 1, index: 3, live: h.live, proposalId: randomUUID() }), code('INPUT'));
  const first = h.incorporate(1, [r1[2]!.proposal.id, r1[0]!.proposal.id]);
  const expected = [r1[0]!, r1[2]!].map(w => { const p = store.proposalById(w.proposal.id)!; return { proposalId: p.id, textSha256: p.result!.textSha256, textBytes: p.result!.textBytes }; });
  assert.deepEqual(first.fanIn, { proposalIds: expected.map(e => e.proposalId), bytes: expected.reduce((n, e) => n + e.textBytes, 0), sha256: sha(JSON.stringify(expected)) }, 'canonical, index-ordered fan-in');
  const r2 = [h.worker(2, 0), h.worker(2, 1)];
  const spare = store.reserveProposal({ id: randomUUID(), taskId: h.task.id, requestId: randomUUID(), promptSha256: sha('p'), promptBytes: 1 });
  assert.throws(() => store.reservePlanStep({ planId: h.plan.id, kind: 'worker', round: 2, index: 2, live: h.live, proposalId: spare.id }), code('BUDGET'), 'five worker attempts');
  assert.equal(store.proposalById(spare.id)!.state, 'reserved', 'an orphan reservation stays a spent attempt; never replayed by the store');
  h.incorporate(2, r2.map(w => w.proposal.id));
  const evidence = store.reservePlanStep({ planId: h.plan.id, kind: 'evidence', round: 2, index: 0, live: h.live });
  store.acknowledgePlanStep({ stepId: evidence.id, evidence: { runId: 'run:review' } });
  assert.equal(store.plan(h.task.id)!.state, 'awaiting_review'); assert.equal(store.get(h.task.id).state, 'working', 'plan completion never accepts the task');
  assert.throws(() => store.reservePlanStep({ planId: h.plan.id, kind: 'worker', round: 2, index: 2, live: h.live, proposalId: spare.id }), code('PLAN_INACTIVE'));
  assert.deepEqual(store.planSteps(h.plan.id).map(s => s.key), ['worker:1:0', 'worker:1:1', 'worker:1:2', 'incorporation:1:0', 'worker:2:0', 'worker:2:1', 'incorporation:2:0', 'evidence:2:0']);
  store.close(); const restarted = f.open();
  assert.equal(restarted.plan(h.task.id)!.state, 'awaiting_review'); assert.equal(restarted.planSteps(h.plan.id).at(-1)!.state, 'acknowledged', 'review reference stays visible, not re-requested');
});

test('order, one-flight, duplicates, fan-in and terminal failure rules', async t => {
  const f = await fixture(t), store = f.open(), h = harness(store);
  const pending = h.worker(1, 0, null);
  assert.throws(() => store.reservePlanStep({ planId: h.plan.id, kind: 'incorporation', round: 1, index: 0, live: h.live, proposalIds: [pending.proposal.id] }), code('ORDER'), 'workers still in flight');
  assert.throws(() => store.reservePlanStep({ planId: h.plan.id, kind: 'worker', round: 2, index: 0, live: h.live, proposalId: randomUUID() }), code('ORDER'), 'round 2 before round 1');
  assert.throws(() => store.reservePlanStep({ planId: h.plan.id, kind: 'worker', round: 1, index: 0, live: h.live, proposalId: pending.proposal.id }), code('DUPLICATE'));
  store.settleProposal(pending.proposal.id, { state: 'failed', reason: 'output_rejected' }); store.syncWorkerStep({ stepId: pending.step.id });
  const again = store.reserveProposal({ id: randomUUID(), taskId: h.task.id, requestId: randomUUID(), promptSha256: sha('p'), promptBytes: 1 });
  assert.throws(() => store.reservePlanStep({ planId: h.plan.id, kind: 'worker', round: 1, index: 0, live: h.live, proposalId: again.id }), code('DUPLICATE'), 'a failed slot is never replaced');
  const big = [h.worker(1, 1, 'proposed', 'x'.repeat(50000)), h.worker(1, 2, 'proposed', 'y'.repeat(50000))];
  assert.throws(() => store.reservePlanStep({ planId: h.plan.id, kind: 'incorporation', round: 1, index: 0, live: h.live, proposalIds: big.map(w => w.proposal.id) }), code('BUDGET'));
  assert.throws(() => store.reservePlanStep({ planId: h.plan.id, kind: 'incorporation', round: 1, index: 0, live: h.live, proposalIds: [pending.proposal.id] }), code('ORDER'), 'failed proposal');
  assert.throws(() => store.reservePlanStep({ planId: h.plan.id, kind: 'incorporation', round: 1, index: 0, live: h.live, proposalIds: [big[0]!.proposal.id, big[0]!.proposal.id] }), code('ORDER'), 'duplicate ids');
  assert.throws(() => store.reservePlanStep({ planId: h.plan.id, kind: 'evidence', round: 1, index: 0, live: h.live }), code('ORDER'), 'evidence before incorporation');
  h.incorporate(1, [big[0]!.proposal.id], 'failed');
  assert.throws(() => store.reservePlanStep({ planId: h.plan.id, kind: 'worker', round: 2, index: 0, live: h.live, proposalId: again.id }), code('ORDER'), 'native failure never opens a next round');
  assert.throws(() => store.reservePlanStep({ planId: h.plan.id, kind: 'evidence', round: 1, index: 0, live: h.live }), code('ORDER'), 'nor evidence');
});

test('unknown dispatch stays unknown with no replay; acknowledgement is not completion; late observations never reopen', async t => {
  const f = await fixture(t), store = f.open(), h = harness(store); const w = h.worker(1, 0);
  const step = store.reservePlanStep({ planId: h.plan.id, kind: 'incorporation', round: 1, index: 0, live: h.live, proposalIds: [w.proposal.id] });
  assert.throws(() => store.settlePlanStep({ stepId: step.id, outcome: { state: 'completed', terminal: 'completed' } }), code('STATE'), 'reserved cannot complete without acknowledgement');
  store.settlePlanStep({ stepId: step.id, outcome: { state: 'unknown', reason: 'dispatch_uncertain' } });
  assert.equal(store.plan(h.task.id)!.state, 'unknown');
  assert.throws(() => store.settlePlanStep({ stepId: step.id, outcome: { state: 'completed', terminal: 'completed' } }), code('STATE'), 'unknown is immutable');
  assert.throws(() => store.reservePlanStep({ planId: h.plan.id, kind: 'incorporation', round: 1, index: 0, live: h.live, proposalIds: [w.proposal.id] }), code('PLAN_INACTIVE'));
  const g = harness(store); const gw = g.worker(1, 0);
  const acked = store.reservePlanStep({ planId: g.plan.id, kind: 'incorporation', round: 1, index: 0, live: g.live, proposalIds: [gw.proposal.id] });
  store.acknowledgePlanStep({ stepId: acked.id, native: { operationId: 'op', turnId: 'turn' } });
  assert.equal(store.stopPlan({ planId: g.plan.id, reason: 'parent_retired' }).state, 'stopped');
  assert.equal(store.settlePlanStep({ stepId: acked.id, outcome: { state: 'completed', terminal: 'completed' } }).terminal, 'completed', 'late native terminal is recorded as an observation');
  assert.equal(store.plan(g.task.id)!.state, 'stopped');
  assert.throws(() => store.reservePlanStep({ planId: g.plan.id, kind: 'evidence', round: 1, index: 0, live: g.live }), code('PLAN_INACTIVE'), 'never reopens');
});

test('restart: interrupted native steps become unknown atomically with the claim; active plans stop', async t => {
  const f = await fixture(t), store = f.open(), h = harness(store); const w = h.worker(1, 0);
  const step = store.reservePlanStep({ planId: h.plan.id, kind: 'incorporation', round: 1, index: 0, live: h.live, proposalIds: [w.proposal.id] });
  store.acknowledgePlanStep({ stepId: step.id, native: { operationId: 'op', turnId: 'turn' } });
  const g = harness(store); const pending = g.worker(1, 0, null);
  store.close(); const restarted = f.open();
  assert.deepEqual([restarted.planSteps(h.plan.id).at(-1)!.state, restarted.planSteps(h.plan.id).at(-1)!.reason], ['unknown', 'daemon_restarted_no_replay']);
  assert.deepEqual([restarted.planSteps(g.plan.id)[0]!.state, restarted.proposalById(pending.proposal.id)!.state], ['unknown', 'unknown']);
  for (const plan of [h.plan, g.plan]) assert.deepEqual([restarted.plan(plan.taskId)!.state, restarted.plan(plan.taskId)!.reason], ['stopped', 'daemon_restarted']);
});

test('retirement, repair reservation and every binding drift refuse new reservations', async t => {
  const f = await fixture(t), store = f.open();
  const drift: [string, (store: ChatTaskStore, id: string) => void, ChatTaskPlanError['code']][] = [
    ['task cancelled', (s, id) => s.update(id, v => { v.state = 'cancelled'; }), 'PLAN_INACTIVE'],
    ['repair reserved', (s, id) => s.update(id, v => { v.repairDispatch = 'reserved'; v.round = 1; }), 'PLAN_INACTIVE'],
    ['model', (s, id) => s.update(id, v => { v.model = 'other'; }), 'BINDING'],
    ['effort', (s, id) => s.update(id, v => { v.effort = 'high'; }), 'BINDING'],
    ['write grant', (s, id) => s.update(id, v => { v.allowWorkspaceWrites = false; }), 'BINDING'],
    ['asset grant', (s, id) => s.update(id, v => { v.allowAssets = true; }), 'BINDING'],
    ['connection', (s, id) => s.update(id, v => { v.connectionId = randomUUID(); }), 'BINDING'],
    ['incarnation', (s, id) => s.update(id, v => { v.incarnationId = randomUUID(); }), 'BINDING'],
    ['session', (s, id) => s.update(id, v => { v.sessionId = 'other'; }), 'BINDING'],
  ];
  for (const [name, change, expected] of drift) {
    const h = harness(store), proposal = store.reserveProposal({ id: randomUUID(), taskId: h.task.id, requestId: randomUUID(), promptSha256: sha('p'), promptBytes: 1 });
    change(store, h.task.id);
    assert.throws(() => store.reservePlanStep({ planId: h.plan.id, kind: 'worker', round: 1, index: 0, live: h.live, proposalId: proposal.id }), code(expected), name);
    assert.deepEqual(store.planSteps(h.plan.id), [], name + ': rolled back, nothing recorded');
  }
  const h = harness(store), proposal = store.reserveProposal({ id: randomUUID(), taskId: h.task.id, requestId: randomUUID(), promptSha256: sha('p'), promptBytes: 1 });
  assert.throws(() => store.reservePlanStep({ planId: h.plan.id, kind: 'worker', round: 1, index: 0, live: { accountIdentity: OTHER }, proposalId: proposal.id }), code('BINDING'), 'account');
  assert.throws(() => store.createPlan({ taskId: h.task.id, accountIdentity: ACCOUNT, objectiveSha256: sha('o'), inputSha256: sha('i') }), code('DUPLICATE'), 'one plan per task');
  const repairing = store.create(task({ repairDispatch: 'reserved', round: 1 }));
  assert.throws(() => store.createPlan({ taskId: repairing.id, accountIdentity: ACCOUNT, objectiveSha256: sha('o'), inputSha256: sha('i') }), code('PLAN_INACTIVE'));
  assert.equal(store.stopPlan({ planId: h.plan.id, reason: 'repair_reserved' }).reason, 'repair_reserved');
  assert.equal(store.stopPlan({ planId: h.plan.id, reason: 'fenced' }).reason, 'repair_reserved', 'stop is idempotent; first reason kept');
  assert.throws(() => store.stopPlan({ planId: h.plan.id, reason: 'daemon_restarted' }), code('INPUT'));
});

test('detached input refuses accessors, symbols, extra keys and non-plain arrays; foreign proposals cannot link', async t => {
  const f = await fixture(t), store = f.open(), h = harness(store); let reads = 0;
  const accessor = Object.defineProperty({ taskId: h.task.id, objectiveSha256: sha('o'), inputSha256: sha('i') }, 'accountIdentity', { enumerable: true, get: () => { reads++; return ACCOUNT; } });
  assert.throws(() => store.createPlan(accessor as never), code('INPUT')); assert.equal(reads, 0);
  assert.throws(() => store.createPlan({ taskId: h.task.id, accountIdentity: ACCOUNT, objectiveSha256: sha('o'), inputSha256: sha('i'), approved: true } as never), code('INPUT'));
  assert.throws(() => store.stopPlan(Object.assign({ planId: h.plan.id, reason: 'fenced' }, { [Symbol('x')]: 1 }) as never), code('INPUT'));
  const w = h.worker(1, 0), list = [w.proposal.id]; Object.defineProperty(list, 0, { get: () => { reads++; return w.proposal.id; } });
  assert.throws(() => store.reservePlanStep({ planId: h.plan.id, kind: 'incorporation', round: 1, index: 0, live: h.live, proposalIds: list }), code('INPUT')); assert.equal(reads, 0);
  const other = harness(store), foreign = store.reserveProposal({ id: randomUUID(), taskId: other.task.id, requestId: randomUUID(), promptSha256: sha('p'), promptBytes: 1 });
  assert.throws(() => store.reservePlanStep({ planId: h.plan.id, kind: 'worker', round: 1, index: 1, live: h.live, proposalId: foreign.id }), code('ORDER'));
  assert.throws(() => store.reservePlanStep({ planId: h.plan.id, kind: 'worker', round: 1, index: 1, live: h.live, proposalId: w.proposal.id }), code('ORDER'), 'one proposal links one step');
});

test('persistence faults roll back the whole reservation', async t => {
  const f = await fixture(t), store = f.open(), h = harness(store);
  const proposal = store.reserveProposal({ id: randomUUID(), taskId: h.task.id, requestId: randomUUID(), promptSha256: sha('p'), promptBytes: 1 });
  const lock = new DatabaseSync(sqliteTransportPath(f.file)); lock.exec('BEGIN IMMEDIATE');
  try { assert.throws(() => store.reservePlanStep({ planId: h.plan.id, kind: 'worker', round: 1, index: 0, live: h.live, proposalId: proposal.id }), /locked|busy/i); }
  finally { lock.exec('ROLLBACK'); lock.close(); }
  assert.deepEqual(store.planSteps(h.plan.id), []);
  const step = store.reservePlanStep({ planId: h.plan.id, kind: 'worker', round: 1, index: 0, live: h.live, proposalId: proposal.id });
  const db = new DatabaseSync(sqliteTransportPath(f.file)); db.prepare('UPDATE chat_task_plan_steps SET payload=? WHERE id=?').run(JSON.stringify({ ...step, updatedAt: new Date(0).toISOString() }), step.id); db.close();
  store.settleProposal(proposal.id, { state: 'proposed', result: result('x') });
  assert.equal(store.syncWorkerStep({ stepId: step.id }).state, 'completed', 'CAS uses the exact stored payload, including external rewrites read in-transaction');
});

test('a live store refuses an externally oversized task row before JSON.parse and repairs nothing', async t => {
  const f = await fixture(t), store = f.open(), kept = store.create(task()), altered = store.create(task());
  const oversized = JSON.stringify(store.get(altered.id)) + ' '.repeat(512 * 1024); // valid JSON once parsed, but beyond the row bound
  const seed = new DatabaseSync(sqliteTransportPath(f.file)); // owned second connection; CHECK bypass only to seed the fixture
  seed.exec('PRAGMA ignore_check_constraints=ON'); seed.prepare('UPDATE chat_tasks SET payload=? WHERE id=?').run(oversized, altered.id); seed.close();
  const original = JSON.parse, seen: number[] = [];
  t.mock.method(JSON, 'parse', (text: string, ...rest: unknown[]) => { seen.push(typeof text === 'string' ? Buffer.byteLength(text) : -1); return (original as (...a: unknown[]) => unknown)(text, ...rest); });
  assert.throws(() => store.get(altered.id), /exceeds its bound/);
  assert.throws(() => store.list(), /exceeds its bound/);
  assert.equal(store.get(kept.id).id, kept.id, 'other rows stay readable');
  assert.ok(seen.every(bytes => bytes <= 512 * 1024), 'the oversized payload never reached JSON.parse');
  t.mock.restoreAll();
  const check = new DatabaseSync(sqliteTransportPath(f.file));
  try { assert.equal((check.prepare('SELECT payload FROM chat_tasks WHERE id=?').get(altered.id) as { payload: string }).payload, oversized, 'retained bytes; no repair'); }
  finally { check.close(); }
  store.close(); assert.throws(() => new ChatTaskStore({ directory: f.directory, projectPath: f.project }), /integrity failed|exceeds its bound/, 'reopen refuses too');
});

test('unknown workers fence the whole plan and cannot allocate a replacement', async t => {
  const f = await fixture(t), store = f.open(), h = harness(store);
  const worker = h.worker(1, 0, 'unknown');
  assert.equal(worker.step.state, 'unknown');
  assert.deepEqual([store.plan(h.task.id)!.state, store.plan(h.task.id)!.reason], ['unknown', 'step_unknown']);
  const spare = store.reserveProposal({ id: randomUUID(), taskId: h.task.id, requestId: randomUUID(), promptSha256: sha('p'), promptBytes: 1 });
  assert.throws(() => store.reservePlanStep({ planId: h.plan.id, kind: 'worker', round: 1, index: 1, live: h.live, proposalId: spare.id }), code('PLAN_INACTIVE'));
  assert.equal(store.planSteps(h.plan.id).length, 1);
  store.close(); const restarted = f.open();
  assert.equal(restarted.plan(h.task.id)!.state, 'unknown');
  assert.equal(restarted.planSteps(h.plan.id)[0]!.state, 'unknown');
});

test('proxy and exotic plan envelopes are refused without invoking traps or getters', async t => {
  const f = await fixture(t), store = f.open(), h = harness(store), worker = h.worker(1, 0);
  let calls = 0;
  const traps: ProxyHandler<object> = { get() { calls++; throw Error('get'); }, ownKeys() { calls++; throw Error('keys'); },
    getOwnPropertyDescriptor() { calls++; throw Error('descriptor'); }, getPrototypeOf() { calls++; throw Error('prototype'); } };
  const input = { planId: h.plan.id, kind: 'incorporation' as const, round: 1, index: 0, live: h.live, proposalIds: [worker.proposal.id] };
  assert.throws(() => store.reservePlanStep(new Proxy(input, traps) as typeof input), code('INPUT'));
  assert.throws(() => store.reservePlanStep({ ...input, live: new Proxy(h.live, traps) as typeof h.live }), code('INPUT'));
  assert.throws(() => store.reservePlanStep({ ...input, proposalIds: new Proxy(input.proposalIds, traps) as typeof input.proposalIds }), code('INPUT'));
  const revoked = Proxy.revocable(input, {}); revoked.revoke();
  assert.throws(() => store.reservePlanStep(revoked.proxy), code('INPUT'));
  const exotic = Object.create({ get accountIdentity() { calls++; return ACCOUNT; } }) as { accountIdentity: string };
  Object.defineProperty(exotic, 'accountIdentity', { value: ACCOUNT, enumerable: true });
  assert.throws(() => store.reservePlanStep({ ...input, live: exotic }), code('INPUT'));
  const exoticArray = [...input.proposalIds]; Object.setPrototypeOf(exoticArray, Object.create(Array.prototype));
  assert.throws(() => store.reservePlanStep({ ...input, proposalIds: exoticArray }), code('INPUT'));
  assert.equal(calls, 0); assert.equal(store.planSteps(h.plan.id).length, 1);
});

test('persisted foreign proposal and changed fan-in references refuse live use and reopening without repair', async t => {
  for (const corruption of ['foreign proposal', 'fan-in digest'] as const) await t.test(corruption, async st => {
    const f = await fixture(st), store = f.open(), h = harness(store), worker = h.worker(1, 0);
    const parent = store.reservePlanStep({ planId: h.plan.id, kind: 'incorporation', round: 1, index: 0, live: h.live, proposalIds: [worker.proposal.id] });
    const foreign = harness(store).worker(1, 0);
    const changed = corruption === 'foreign proposal' ? { ...worker.step, proposalId: foreign.proposal.id }
      : { ...parent, fanIn: { ...parent.fanIn!, sha256: '0'.repeat(64) } };
    const payload = JSON.stringify(changed), seed = new DatabaseSync(sqliteTransportPath(f.file));
    seed.prepare('UPDATE chat_task_plan_steps SET payload=? WHERE id=?').run(payload, changed.id); seed.close();
    assert.throws(() => store.planSteps(h.plan.id), code('CORRUPT'));
    assert.throws(() => store.acknowledgePlanStep({ stepId: parent.id, native: { operationId: 'op', turnId: 'turn' } }), code('CORRUPT'));
    const check = new DatabaseSync(sqliteTransportPath(f.file));
    try { assert.equal((check.prepare('SELECT payload FROM chat_task_plan_steps WHERE id=?').get(changed.id) as { payload: string }).payload, payload); }
    finally { check.close(); }
    store.close(); const before = await inventory(f);
    assert.throws(() => new ChatTaskStore({ directory: f.directory, projectPath: f.project }), code('CORRUPT'));
    assert.deepEqual(await inventory(f), before);
  });
});

test('review binding precedes only the final parent and becomes awaiting review after its successful terminal', async t => {
  const f = await fixture(t), store = f.open(), h = harness(store), first = h.worker(1, 0);
  h.incorporate(1, [first.proposal.id]); const second = h.worker(2, 0);
  const evidence = store.reservePlanStep({ planId: h.plan.id, kind: 'evidence', round: 2, index: 0, live: h.live });
  assert.throws(() => store.reservePlanStep({ planId: h.plan.id, kind: 'incorporation', round: 2, index: 0, live: h.live, proposalIds: [second.proposal.id] }), code('ORDER'), 'review commit must be acknowledged before its native handoff');
  store.acknowledgePlanStep({ stepId: evidence.id, evidence: { runId: randomUUID() } });
  assert.equal(store.plan(h.task.id)!.state, 'active', 'a review binding cannot accept unfinished native work');
  const spare = store.reserveProposal({ id: randomUUID(), taskId: h.task.id, requestId: randomUUID(), promptSha256: sha('p'), promptBytes: 1 });
  assert.throws(() => store.reservePlanStep({ planId: h.plan.id, kind: 'worker', round: 2, index: 1, live: h.live, proposalId: spare.id }), code('ORDER'));
  h.incorporate(2, [second.proposal.id]); assert.equal(store.plan(h.task.id)!.state, 'awaiting_review');
  store.close(); const reopened = f.open();
  assert.equal(reopened.plan(h.task.id)!.state, 'awaiting_review');
  assert.deepEqual(reopened.planSteps(h.plan.id).slice(-2).map(step => [step.kind, step.state]), [['evidence', 'acknowledged'], ['incorporation', 'completed']]);
});

test('restart preserves an early review reference without dispatching its unstarted final parent', async t => {
  const f = await fixture(t), store = f.open(), h = harness(store), first = h.worker(1, 0);
  h.incorporate(1, [first.proposal.id]); h.worker(2, 0);
  const evidence = store.reservePlanStep({ planId: h.plan.id, kind: 'evidence', round: 2, index: 0, live: h.live }), runId = randomUUID();
  store.acknowledgePlanStep({ stepId: evidence.id, evidence: { runId } }); store.close();
  const reopened = f.open(); assert.equal(reopened.plan(h.task.id)!.state, 'stopped');
  assert.equal(reopened.planSteps(h.plan.id).at(-1)!.evidence!.runId, runId);
  assert.equal(reopened.planSteps(h.plan.id).filter(step => step.kind === 'incorporation').length, 1);
  assert.throws(() => reopened.reservePlanStep({ planId: h.plan.id, kind: 'incorporation', round: 2, index: 0, live: h.live, proposalIds: [] }), code('INPUT'));
});

test('v3 completed late-review plans migrate with their original payload bytes and no invented prompt digest', async t => {
  const f = await fixture(t), store = f.open(), h = harness(store), worker = h.worker(1, 0);
  h.incorporate(1, [worker.proposal.id]); const evidence = store.reservePlanStep({ planId: h.plan.id, kind: 'evidence', round: 1, index: 0, live: h.live });
  store.acknowledgePlanStep({ stepId: evidence.id, evidence: { runId: randomUUID() } }); store.close();
  const db = new DatabaseSync(sqliteTransportPath(f.file));
  for (const row of db.prepare('SELECT id,payload FROM chat_task_plan_steps').all() as { id: string; payload: string }[]) {
    const legacy = JSON.parse(row.payload) as Record<string, unknown>; delete legacy.inputSha256;
    db.prepare('UPDATE chat_task_plan_steps SET payload=? WHERE id=?').run(JSON.stringify(legacy), row.id);
  }
  db.exec('PRAGMA user_version=3'); const before = db.prepare('SELECT id,payload FROM chat_task_plan_steps ORDER BY seq').all(); db.close();
  const reopened = f.open(); assert.equal(reopened.plan(h.task.id)!.state, 'awaiting_review');
  assert.ok(reopened.planSteps(h.plan.id).every(step => step.inputSha256 === null)); reopened.close();
  const check = new DatabaseSync(sqliteTransportPath(f.file)); try { assert.deepEqual(check.prepare('SELECT id,payload FROM chat_task_plan_steps ORDER BY seq').all(), before); }
  finally { check.close(); }
});

test('no unhandled rejections', async () => { await new Promise(done => setTimeout(done, 20)); assert.deepEqual(unhandled, []); });
