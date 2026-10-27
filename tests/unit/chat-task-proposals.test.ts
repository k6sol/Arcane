import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { join, relative, sep, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { ChatTaskStore, ChatTaskProposalLimitError, CHAT_TASK_PROPOSAL_LIMITS, type ChatTaskRecord } from '../../packages/storage/src/chat-task-store.js';
import { sqliteTransportPath } from '../../packages/storage/src/sqlite-path.js';
import { workflowProjectIdentity } from '../../packages/storage/src/workflow-store.js';
import { ChatTaskCoordinator, ChatTaskProposalBudget, ChatTaskProposalError, type ChatTaskOwner, type ChatTaskProposalFactory,
  type ChatTaskProposalWorkerInput } from '../../apps/daemon/src/chat-task-coordinator.js';
import type { Snapshot } from '../../packages/codex-client/src/types.js';
import type { StudioTestTaskOrigin } from '../../packages/protocol/src/chat-task-playtest.js';

// Real temp SQLite and an injected synthetic proposal worker. No native CLI,
// provider inference, Studio or process query is involved.
const ACCOUNT = 'c'.repeat(64), OTHER_ACCOUNT = 'd'.repeat(64);
const unhandled: unknown[] = [];
process.on('unhandledRejection', error => { unhandled.push(error); });
const V1 = [
  'CREATE TABLE chat_tasks(id TEXT PRIMARY KEY,payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB))<=524288)) STRICT',
  'CREATE TABLE chat_task_meta(id INTEGER PRIMARY KEY CHECK(id=1),project_id TEXT NOT NULL,project_path TEXT NOT NULL) STRICT',
  'CREATE TABLE chat_task_owner(id INTEGER PRIMARY KEY CHECK(id=1),pid INTEGER NOT NULL,token TEXT NOT NULL) STRICT',
];
const PLAN_TABLES = ['CREATE TABLE chat_task_plans(id TEXT PRIMARY KEY,task_id TEXT NOT NULL UNIQUE,payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB))<=8192)) STRICT',
  'CREATE TABLE chat_task_plan_steps(id TEXT PRIMARY KEY,plan_id TEXT NOT NULL,step_key TEXT NOT NULL,seq INTEGER NOT NULL,payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB))<=8192),UNIQUE(plan_id,step_key),UNIQUE(plan_id,seq)) STRICT'];
const V2 = [...V1, 'CREATE TABLE chat_task_proposals(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,request_id TEXT NOT NULL UNIQUE,payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB))<=98304)) STRICT'];

async function fixture(t: test.TestContext) {
  const boundary = await realpath(tmpdir()), root = await realpath(await mkdtemp(join(boundary, 'arcane-task-proposal-'))), project = join(root, 'project'), directory = join(root, 'state');
  await mkdir(project); await mkdir(directory, { mode: 0o700 });
  const closers: (() => Promise<void>)[] = [];
  t.after(async () => {
    for (const close of closers.reverse()) await close(); // Owned SQLite handles close before exact-root removal.
    const part = relative(boundary, root); assert.ok(part.startsWith('arcane-task-proposal-') && !isAbsolute(part) && !part.includes(sep));
    await rm(root, { recursive: true, force: true });
  });
  return { root, project, directory, file: join(directory, 'chat-tasks.sqlite'), closers };
}
function task(state: ChatTaskRecord['state'] = 'working') {
  return { id: randomUUID(), provider: 'codex' as const, threadId: 'thread:actual', sessionId: 'session:actual', connectionId: randomUUID(), incarnationId: randomUUID(), model: 'fixture', effort: 'low',
    allowWorkspaceWrites: false, allowAssets: false, state, round: 0 as const, operationId: null, turnId: null, nativeSettled: false, acknowledged: false,
    repairDispatch: 'not_requested' as const, prepared: null, evidence: [], reason: null };
}
function v1Journal(file: string, project: string, tasks: object[], meta?: { projectId: string; projectPath: string }) {
  const identity = workflowProjectIdentity(project), db = new DatabaseSync(sqliteTransportPath(file));
  db.exec('BEGIN'); for (const ddl of V1) db.exec(ddl);
  db.prepare('INSERT INTO chat_task_meta VALUES(1,?,?)').run(meta?.projectId ?? identity.projectId, meta?.projectPath ?? identity.projectPath);
  for (const value of tasks) db.prepare('INSERT INTO chat_tasks(id,payload) VALUES(?,?)').run((value as { id: string }).id, JSON.stringify(value));
  db.exec(`PRAGMA application_id=${0x41524354};PRAGMA user_version=1;COMMIT;`); db.close();
}
function v1Task(project: string, state: ChatTaskRecord['state']) {
  const identity = workflowProjectIdentity(project), now = new Date().toISOString();
  return { ...task(state), projectId: identity.projectId, projectPath: identity.projectPath, revision: 0, createdAt: now, updatedAt: now };
}
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const reservation = (taskId: string, text = 'Propose a bounded change') => ({ id: randomUUID(), taskId, requestId: randomUUID(), promptSha256: sha(text), promptBytes: Buffer.byteLength(text) });
const result = (text = 'A display-only proposal') => ({ threadId: 'proposal.thread', sessionId: null, turnId: 'proposal.turn', text, textSha256: sha(text), textBytes: Buffer.byteLength(text) });
async function inventory(f: { file: string; directory: string }) { return { bytes: await readFile(f.file), names: (await readdir(f.directory)).sort() }; }
function schema(file: string) { const db = new DatabaseSync(sqliteTransportPath(file)); try { return { version: Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version),
  sql: (db.prepare("SELECT sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all() as { sql: string }[]).map(row => row.sql).sort() }; } finally { db.close(); } }

test('v1 journal migrates to v2 only after exact validation and retains task payload bytes', async t => {
  const f = await fixture(t), kept = v1Task(f.project, 'verified'), active = v1Task(f.project, 'working');
  v1Journal(f.file, f.project, [kept, active]);
  const store = new ChatTaskStore({ directory: f.directory, projectPath: f.project });
  try {
    assert.deepEqual(store.get(kept.id), kept, 'terminal task survives migration unchanged');
    assert.equal(store.get(active.id).state, 'unknown'); assert.equal(store.get(active.id).reason, 'daemon_restarted_no_replay');
    assert.deepEqual(store.proposals(kept.id), []);
  } finally { store.close(); }
  const after = schema(f.file); assert.equal(after.version, 4); assert.deepEqual(after.sql, [...V2, PLAN_TABLES[0], PLAN_TABLES[1]].sort());
  const db = new DatabaseSync(sqliteTransportPath(f.file));
  try { assert.equal((db.prepare('SELECT payload FROM chat_tasks WHERE id=?').get(kept.id) as { payload: string }).payload, JSON.stringify(kept)); } finally { db.close(); }
});

test('corrupt, foreign, wrong-project and live-owned journals are refused byte-identically', async t => {
  const cases: [string, (f: Awaited<ReturnType<typeof fixture>>) => void, RegExp][] = [
    ['corrupt v1 task row', f => { v1Journal(f.file, f.project, [{ ...v1Task(f.project, 'verified'), state: 'exploded' }]); }, /invalid|corrupt|Invalid/i],
    ['unparseable v1 task row', f => { v1Journal(f.file, f.project, []); const db = new DatabaseSync(sqliteTransportPath(f.file)); db.prepare('INSERT INTO chat_tasks VALUES(?,?)').run(randomUUID(), '{'); db.close(); }, /corrupt/],
    ['foreign v2 schema', f => { const db = new DatabaseSync(sqliteTransportPath(f.file)); db.exec("PRAGMA user_version=2;CREATE TABLE future_state(id INTEGER PRIMARY KEY,value TEXT);INSERT INTO future_state VALUES(1,'retained')"); db.close(); }, /schema or project/],
    ['v1 for another project', f => { v1Journal(f.file, f.project, [], { projectId: 'e'.repeat(64), projectPath: f.root }); }, /schema or project/],
    ['v1 with an extra table', f => { v1Journal(f.file, f.project, []); const db = new DatabaseSync(sqliteTransportPath(f.file)); db.exec('CREATE TABLE extra(id INTEGER PRIMARY KEY)'); db.close(); }, /schema or project/],
    ['v1 with a live owner', f => { v1Journal(f.file, f.project, []); const db = new DatabaseSync(sqliteTransportPath(f.file)); db.prepare('INSERT INTO chat_task_owner VALUES(1,?,?)').run(process.pid, 'foreign'); db.close(); }, /live owner/],
    ['v5 journal', f => { const db = new DatabaseSync(sqliteTransportPath(f.file)); db.exec('PRAGMA user_version=5;CREATE TABLE future_state(id INTEGER PRIMARY KEY)'); db.close(); }, /newer/],
  ];
  for (const [name, prepare, expected] of cases) await t.test(name, async st => {
    const f = await fixture(st); prepare(f); const before = await inventory(f);
    assert.throws(() => new ChatTaskStore({ directory: f.directory, projectPath: f.project }), expected);
    assert.deepEqual(await inventory(f), before);
  });
});

test('corrupt v2 proposal payload refuses open without changing retained bytes', async t => {
  const f = await fixture(t), store = new ChatTaskStore({ directory: f.directory, projectPath: f.project }), value = store.create(task());
  const reserved = store.reserveProposal(reservation(value.id)); store.close();
  const db = new DatabaseSync(sqliteTransportPath(f.file)); db.prepare('UPDATE chat_task_proposals SET payload=? WHERE id=?').run(JSON.stringify({ ...reserved, state: 'proposed' }), reserved.id); db.close();
  const before = await inventory(f);
  assert.throws(() => new ChatTaskStore({ directory: f.directory, projectPath: f.project }), /proposal journal is corrupt/);
  assert.deepEqual(await inventory(f), before);
});

test('proposal records are strict, single-settlement, request-unique and bounded without eviction', async t => {
  const f = await fixture(t), store = new ChatTaskStore({ directory: f.directory, projectPath: f.project });
  try {
    const value = store.create(task()), first = reservation(value.id), reserved = store.reserveProposal(first);
    assert.equal(reserved.state, 'reserved'); assert.equal(Object.isFrozen(reserved), true);
    assert.throws(() => store.reserveProposal({ ...reservation(value.id), requestId: first.requestId }), /already exists/);
    assert.throws(() => store.reserveProposal(reservation(randomUUID())), /Unknown task/);
    assert.throws(() => store.settleProposal(reserved.id, { state: 'proposed', result: { ...result(), textBytes: 1 } }), /Invalid task proposal/);
    assert.throws(() => store.settleProposal(reserved.id, { state: 'proposed', result: result('x'.repeat(CHAT_TASK_PROPOSAL_LIMITS.textBytes + 1)) }), /Invalid task proposal/);
    assert.throws(() => store.settleProposal(reserved.id, { state: 'proposed', result: result('\uD800 lone surrogate') }), /Invalid task proposal/);
    assert.equal(store.proposalByRequest(first.requestId)!.state, 'reserved', 'refused settlements leave the reservation untouched');
    const settled = store.settleProposal(reserved.id, { state: 'proposed', result: result('x'.repeat(CHAT_TASK_PROPOSAL_LIMITS.textBytes)) });
    assert.equal(settled.result!.textBytes, CHAT_TASK_PROPOSAL_LIMITS.textBytes);
    assert.throws(() => store.settleProposal(reserved.id, { state: 'failed', reason: 'output_rejected' }), /immutable/);
    assert.deepEqual(store.proposalByRequest(first.requestId), settled);
    for (let index = 1; index < CHAT_TASK_PROPOSAL_LIMITS.perTask; index++) store.reserveProposal(reservation(value.id));
    const full = store.proposals(value.id); assert.equal(full.length, CHAT_TASK_PROPOSAL_LIMITS.perTask);
    assert.throws(() => store.reserveProposal(reservation(value.id)), /full/);
    assert.deepEqual(store.proposals(value.id), full, 'no eviction at the per-task bound');
  } finally { store.close(); }
});

test('global proposal bound refuses without eviction', async t => {
  const f = await fixture(t), store = new ChatTaskStore({ directory: f.directory, projectPath: f.project });
  try {
    const tasks = Array.from({ length: CHAT_TASK_PROPOSAL_LIMITS.total / CHAT_TASK_PROPOSAL_LIMITS.perTask }, () => store.create(task('verified')));
    for (const value of tasks) for (let index = 0; index < CHAT_TASK_PROPOSAL_LIMITS.perTask; index++) store.reserveProposal(reservation(value.id));
    const extra = store.create(task('verified'));
    assert.throws(() => store.reserveProposal(reservation(extra.id)), /full/);
    assert.equal(store.proposals(tasks[0]!.id).length, CHAT_TASK_PROPOSAL_LIMITS.perTask);
  } finally { store.close(); }
});

test('oversized or corrupt persisted proposal rows are refused before parse and escape-heavy results are bound-checked', async t => {
  const f = await fixture(t), store = new ChatTaskStore({ directory: f.directory, projectPath: f.project }), value = store.create(task());
  const escaped = store.reserveProposal(reservation(value.id)), heavy = result(''.repeat(20000));
  assert.ok(heavy.textBytes <= CHAT_TASK_PROPOSAL_LIMITS.textBytes && Buffer.byteLength(JSON.stringify(heavy)) > CHAT_TASK_PROPOSAL_LIMITS.payloadBytes);
  assert.throws(() => store.settleProposal(escaped.id, { state: 'proposed', result: heavy }), ChatTaskProposalLimitError);
  assert.equal(store.proposalByRequest(escaped.requestId)!.state, 'reserved', 'the store never truncates or partially writes');
  const planted = store.reserveProposal(reservation(value.id)); store.close();
  const db = new DatabaseSync(sqliteTransportPath(f.file));
  db.exec('PRAGMA ignore_check_constraints=ON'); db.prepare('UPDATE chat_task_proposals SET payload=? WHERE id=?').run(JSON.stringify(planted) + ' '.repeat(CHAT_TASK_PROPOSAL_LIMITS.payloadBytes), planted.id); db.close();
  const before = await inventory(f);
  // quick_check reports the bypassed CHECK first; the pre-parse byte bound remains a second, independent refusal.
  assert.throws(() => new ChatTaskStore({ directory: f.directory, projectPath: f.project }), /integrity failed|proposal journal is corrupt/);
  assert.deepEqual(await inventory(f), before);
});

test('restart records reserved attempts unknown without replay and retains terminal results', async t => {
  const f = await fixture(t), store = new ChatTaskStore({ directory: f.directory, projectPath: f.project }), value = store.create(task());
  const lost = store.reserveProposal(reservation(value.id)), done = store.reserveProposal(reservation(value.id));
  const proposed = store.settleProposal(done.id, { state: 'proposed', result: result() }); store.close();
  const restarted = new ChatTaskStore({ directory: f.directory, projectPath: f.project });
  try {
    const [first, second] = restarted.proposals(value.id);
    assert.equal(first!.id, lost.id); assert.equal(first!.state, 'unknown'); assert.equal(first!.reason, 'daemon_restarted_no_replay');
    assert.deepEqual(second, proposed);
  } finally { restarted.close(); }
});

// ---------------------------------------------------------------- coordinator
function snapshotFor(live: { connectionId: string; threadId: string; sessionId: string | null; model: string; effort: string }): Snapshot {
  return { connectionId: live.connectionId, provenance: 'spawned-node-fixture', mcpIsolation: 'arcane-only-verified', connected: true, ready: true,
    account: { auth: 'subscription' }, models: [], selection: { model: live.model, effort: live.effort }, operations: [], approvals: [], events: [], droppedEvents: 0, lastEventSeq: 0, failureCode: null,
    thread: { configured: true, threadId: live.threadId, sessionId: live.sessionId, selection: { model: live.model, effort: live.effort }, turnStatus: 'inProgress', turnId: null, writeGranted: false } } as unknown as Snapshot;
}
async function coordinatorFixture(t: test.TestContext) {
  const f = await fixture(t), coordinator = new ChatTaskCoordinator({ directory: f.directory, projectPath: f.project, proposalBudget: new ChatTaskProposalBudget() });
  coordinator.attachCancellation(Object.freeze({ async cancelExact() {}, async revalidateExact() { return 'current' as const; } }));
  let expectedClose:{value:unknown}|null=null;
  f.closers.push(async()=>{
    if(expectedClose){const expected=expectedClose.value;await assert.rejects(coordinator.close(),error=>Object.is(error,expected));await assert.rejects(coordinator.close(),error=>Object.is(error,expected));}
    else await coordinator.close();
  });
  const signals: AbortSignal[] = [];
  const own = (options: { account?: string | null; getter?: boolean } = {}) => {
    const live = { connectionId: randomUUID(), threadId: 'thread:' + randomUUID(), sessionId: 'session:exact', model: 'fixture', effort: 'low', account: ACCOUNT as string | null };
    const events: string[] = [], id = randomUUID();
    const owner: ChatTaskOwner = { snapshot: () => snapshotFor(live), repair: async () => { events.push('repair'); },
      revoke: () => { events.push('revoke:' + (signals.length && signals.every(signal => signal.aborted) ? 'after-abort' : 'before-abort')); }, cancel: async () => { events.push('cancel'); },
      ...(options.getter === false ? {} : { accountIdentity: () => live.account }) };
    coordinator.begin({ id, actorId: 'actor-' + id, snapshot: owner.snapshot(), allowWorkspaceWrites: false, allowAssets: false, owner,
      ...(options.account === null ? {} : { accountIdentity: options.account ?? ACCOUNT }) });
    return { id, live, events, owner };
  };
  return { ...f, coordinator, own, signals, expectClose:(value:unknown)=>{expectedClose={value};} };
}
type Plan = { factory?: (input: ChatTaskProposalWorkerInput) => Promise<void> | void; propose?: (text: string, input: ChatTaskProposalWorkerInput) => Promise<unknown>; close?: () => Promise<void> };
function workers(signals: AbortSignal[], plan: Plan = {}) {
  const calls: ChatTaskProposalWorkerInput[] = [], proposed: string[] = []; let closes = 0;
  const factory: ChatTaskProposalFactory = async input => {
    calls.push(input); signals.push(input.owner.signal); await plan.factory?.(input);
    return { propose: async text => { proposed.push(text); return (plan.propose ? await plan.propose(text, input) : { threadId: 'proposal.thread', sessionId: null, turnId: 'proposal.turn', text: 'Proposal: rename one part.', status: 'proposed' }) as never; },
      close: async () => { closes++; await plan.close?.(); } };
  };
  return { factory, calls, proposed, get closes() { return closes; } };
}
const coded = (code: string) => Object.assign(new Error('fixture ' + code), { code });
const aborted = (signal: AbortSignal) => new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
async function settled(coordinator: ChatTaskCoordinator, taskId: string, id: string) {
  const end = Date.now() + 6000;
  for (;;) { const value = coordinator.proposals(taskId).find(entry => entry.id === id)!; if (value.state !== 'reserved') return value; assert.ok(Date.now() < end, 'proposal settled'); await delay(5); }
}

test('happy path reserves durably before the factory and records display-only output', async t => {
  const f = await coordinatorFixture(t), parent = f.own(), w = workers(f.signals), requestId = randomUUID();
  const text = 'Suggest one change. {"tool":"arcane.write","args":{"path":"x"}}';
  const reserved = f.coordinator.startProposal({ taskId: parent.id, requestId, text, factory: w.factory });
  assert.equal(reserved.state, 'reserved'); assert.equal(w.calls.length, 0, 'factory never runs inside the reserving call');
  assert.equal(f.coordinator.proposalByRequest(requestId)!.id, reserved.id, 'durable before any worker exists');
  const value = await settled(f.coordinator, parent.id, reserved.id);
  assert.equal(value.state, 'proposed'); assert.equal(value.result!.text, 'Proposal: rename one part.'); assert.equal(value.result!.textSha256, sha('Proposal: rename one part.'));
  assert.equal(value.promptSha256, sha(text)); assert.deepEqual(w.proposed, [text]); assert.ok(w.closes >= 1);
  const input = w.calls[0]!;
  assert.deepEqual(Object.keys(input).sort(), ['accountIdentity', 'owner', 'selection']); assert.equal(input.accountIdentity, ACCOUNT);
  assert.deepEqual(input.selection, { model: 'fixture', effort: 'low' }); assert.ok(Object.isFrozen(input) && Object.isFrozen(input.owner));
  assert.deepEqual(Object.keys(input.owner).sort(), ['assertActive', 'signal']);
  assert.ok(Object.hasOwn(Object.getOwnPropertyDescriptor(input.owner, 'assertActive')!, 'value'), 'assertActive is an own data property');
  assert.equal(input.owner.assertActive(), undefined, 'assertion is synchronous and returns nothing');
  // Tool-looking proposal text authorized nothing: no repair, revoke, cancel or task transition.
  assert.deepEqual(parent.events, []); assert.equal(f.coordinator.list().find(entry => entry.id === parent.id)!.state, 'working');
  await f.coordinator.drain();
});

test('reservation fault starts no worker and leaves no attempt', async t => {
  const f = await coordinatorFixture(t), parent = f.own(), w = workers(f.signals), requestId = randomUUID();
  const lock = new DatabaseSync(sqliteTransportPath(f.file)); lock.exec('BEGIN IMMEDIATE');
  try { assert.throws(() => f.coordinator.startProposal({ taskId: parent.id, requestId, text: 'x', factory: w.factory }), (error: unknown) => error instanceof ChatTaskProposalError && error.code === 'JOURNAL_FAILURE'); }
  finally { lock.exec('ROLLBACK'); lock.close(); }
  await delay(20); assert.equal(w.calls.length, 0); assert.equal(f.coordinator.proposalByRequest(requestId), null);
});

test('factory failures are failed, never replayed; unconfirmed closure keeps the slot occupied', async t => {
  const f = await coordinatorFixture(t);
  const outcomes: [string, string][] = [['GENERIC', 'worker_failed_before_dispatch'], ['CLI_MISSING', 'worker_unavailable'], ['PROCESS_PATH', 'worker_unavailable']];
  for (const [code, reason] of outcomes) {
    const parent = f.own(), w = workers(f.signals, { factory: () => { throw coded(code); } });
    const value = await settled(f.coordinator, parent.id, f.coordinator.startProposal({ taskId: parent.id, requestId: randomUUID(), text: 'x', factory: w.factory }).id);
    assert.equal(value.state, 'failed'); assert.equal(value.reason, reason); assert.equal(w.proposed.length, 0);
  }
  const unconfirmed=coded('PROCESS_EXIT_UNCONFIRMED');f.expectClose(unconfirmed);
  for (let slot = 0; slot < 2; slot++) {
    const parent = f.own(), w = workers(f.signals, { factory: () => { throw unconfirmed; } });
    const value = await settled(f.coordinator, parent.id, f.coordinator.startProposal({ taskId: parent.id, requestId: randomUUID(), text: 'x', factory: w.factory }).id);
    assert.equal(value.state, 'failed'); assert.equal(value.reason, 'worker_close_unconfirmed');
  }
  await f.coordinator.drain();
  const parent = f.own(), w = workers(f.signals);
  assert.throws(() => f.coordinator.startProposal({ taskId: parent.id, requestId: randomUUID(), text: 'x', factory: w.factory }), (error: unknown) => error instanceof ChatTaskProposalError && error.code === 'BUSY');
  assert.equal(w.calls.length, 0);
});

test('dispatch failures are unknown or output_rejected and duplicates return the original observation', async t => {
  const f = await coordinatorFixture(t);
  const unconfirmed=coded('PROCESS_EXIT_UNCONFIRMED');f.expectClose(unconfirmed);
  const cases: [Plan, string, string][] = [
    [{ propose: async () => { throw coded('TRANSPORT'); } }, 'unknown', 'dispatch_uncertain'],
    [{ propose: async () => { throw coded('PROPOSAL_OUTPUT'); } }, 'failed', 'output_rejected'],
    [{ propose: async () => ({ threadId: 'proposal.thread', sessionId: null, turnId: 'proposal.turn', text: 'x'.repeat(CHAT_TASK_PROPOSAL_LIMITS.textBytes + 1), status: 'proposed' }) }, 'failed', 'output_rejected'],
    [{ propose: async () => ({ threadId: 'proposal.thread', sessionId: null, turnId: 'proposal.turn', text: 'ok', status: 'proposed', approve: true }) }, 'failed', 'output_rejected'],
    [{ propose: async () => ({ threadId: 'proposal.thread', sessionId: null, turnId: 'proposal.turn', text: 'ok', status: 'proposed' }), close: async () => { throw unconfirmed; } }, 'unknown', 'worker_close_unconfirmed'],
  ];
  for (const [plan, state, reason] of cases) {
    const parent = f.own(), w = workers(f.signals, plan), requestId = randomUUID();
    const first = f.coordinator.startProposal({ taskId: parent.id, requestId, text: 'Same prompt', factory: w.factory });
    const value = await settled(f.coordinator, parent.id, first.id);
    assert.equal(value.state, state); assert.equal(value.reason, reason); assert.equal(value.result, null);
    assert.deepEqual(f.coordinator.startProposal({ taskId: parent.id, requestId, text: 'Same prompt', factory: w.factory }), value, 'duplicate request returns the original record');
    assert.throws(() => f.coordinator.startProposal({ taskId: parent.id, requestId, text: 'Other prompt', factory: w.factory }), (error: unknown) => error instanceof ChatTaskProposalError && error.code === 'IDEMPOTENCY');
    assert.equal(w.calls.length, 1, 'never dispatched again');
  }
  await f.coordinator.drain();
});

test('retirement aborts before revoke at every proposal stage and cancel joins the worker', async t => {
  const stages: [string, (gate: Promise<void>) => Plan, string, string][] = [
    ['discovery/initialization', gate => ({ factory: async () => { await gate; throw coded('PARENT_SCOPE'); } }), 'failed', 'parent_retired'],
    ['preflight/output', gate => ({ propose: async () => { await gate; throw coded('PARENT_SCOPE'); } }), 'unknown', 'parent_retired'],
    ['close', gate => ({ propose: async () => { await gate; return { threadId: 'proposal.thread', sessionId: null, turnId: 'proposal.turn', text: 'late', status: 'proposed' }; } }), 'unknown', 'parent_retired'],
  ];
  const retire: [string, (f: Awaited<ReturnType<typeof coordinatorFixture>>, id: string) => Promise<void>][] = [
    ['cancel', (f, id) => f.coordinator.cancel(id, 'human_stopped_task')],
    ['uncertain', async (f, id) => { f.coordinator.uncertain(id, 'fixture_uncertain'); await f.coordinator.drain(); }],
    ['fence then drain', async f => { f.coordinator.fence(); await f.coordinator.drain(); }],
    ['stopAll', f => f.coordinator.stopAll('fixture_stop')],
    ['close', f => f.coordinator.close()],
  ];
  for (const [stage, plan, state, reason] of stages) for (const [name, act] of retire) await t.test(`${stage} / ${name}`, async st => {
    const f = await coordinatorFixture(st), parent = f.own(); let started!: () => void; const begun = new Promise<void>(resolve => { started = resolve; });
    let signal!: AbortSignal;
    const w = workers(f.signals, plan((async () => { await begun; await aborted(signal); })()));
    const wrapped: ChatTaskProposalFactory = async input => { signal = input.owner.signal; started(); return w.factory(input); };
    const reserved = f.coordinator.startProposal({ taskId: parent.id, requestId: randomUUID(), text: 'x', factory: wrapped });
    await begun; await delay(5);
    await act(f, parent.id);
    assert.equal(signal.aborted, true); assert.ok(parent.events.includes('revoke:after-abort')); assert.ok(!parent.events.includes('revoke:before-abort'));
    // Joined: the attempt is settled when retirement returns, never left reserved.
    const store = name === 'close' ? new ChatTaskStore({ directory: f.directory, projectPath: f.project }) : null;
    try {
      const value = (store ? store.proposals(parent.id) : f.coordinator.proposals(parent.id)).find(entry => entry.id === reserved.id)!;
      assert.equal(value.state, state); assert.equal(value.reason, reason);
    } finally { store?.close(); }
    assert.ok(w.closes >= (stage === 'discovery/initialization' ? 0 : 1));
  });
});

test('account, model, thread and connection drift refuse before reservation; drift mid-run never records output', async t => {
  const f = await coordinatorFixture(t);
  const drift: [string, (live: { account: string | null; model: string; threadId: string; connectionId: string }) => void, string][] = [
    ['account', live => { live.account = OTHER_ACCOUNT; }, 'ACCOUNT_IDENTITY'], ['account unavailable', live => { live.account = null; }, 'ACCOUNT_IDENTITY'],
    ['model', live => { live.model = 'other'; }, 'TASK_SCOPE'], ['thread', live => { live.threadId = 'thread:other'; }, 'TASK_SCOPE'],
    ['connection', live => { live.connectionId = randomUUID(); }, 'TASK_SCOPE'],
  ];
  for (const [name, change, code] of drift) {
    const parent = f.own(), w = workers(f.signals), requestId = randomUUID(); change(parent.live);
    assert.throws(() => f.coordinator.startProposal({ taskId: parent.id, requestId, text: 'x', factory: w.factory }), (error: unknown) => error instanceof ChatTaskProposalError && error.code === code, name);
    assert.equal(f.coordinator.proposalByRequest(requestId), null); assert.equal(w.calls.length, 0);
  }
  const parent = f.own(); let changed!: () => void; const gate = new Promise<void>(resolve => { changed = resolve; });
  const w = workers(f.signals, { propose: async (_text, input) => { await gate; input.owner.assertActive(); return { threadId: 't', sessionId: null, turnId: 'u', text: 'never', status: 'proposed' }; } });
  const reserved = f.coordinator.startProposal({ taskId: parent.id, requestId: randomUUID(), text: 'x', factory: w.factory });
  await delay(10); parent.live.account = OTHER_ACCOUNT; changed();
  const value = await settled(f.coordinator, parent.id, reserved.id);
  assert.equal(value.state, 'unknown'); assert.equal(value.reason, 'dispatch_uncertain'); assert.equal(value.result, null);
  assert.throws(() => w.calls[0]!.owner.assertActive(), (error: unknown) => error instanceof ChatTaskProposalError && error.code === 'ACCOUNT_IDENTITY');
});

test('escape-heavy valid output is explicitly output_rejected, never left reserved or truncated', async t => {
  const f = await coordinatorFixture(t), parent = f.own(), text = ''.repeat(20000);
  const w = workers(f.signals, { propose: async () => ({ threadId: 't', sessionId: null, turnId: 'u', text, status: 'proposed' }) });
  const value = await settled(f.coordinator, parent.id, f.coordinator.startProposal({ taskId: parent.id, requestId: randomUUID(), text: 'x', factory: w.factory }).id);
  assert.equal(value.state, 'failed'); assert.equal(value.reason, 'output_rejected'); assert.equal(value.result, null);
});

test('process-wide budget quarantines unconfirmed closures across coordinator and project replacement', async t => {
  const first = await fixture(t), second = await fixture(t), signals: AbortSignal[] = [];
  const old = new ChatTaskCoordinator({ directory: first.directory, projectPath: first.project });
  old.attachCancellation(Object.freeze({ async cancelExact() {}, async revalidateExact() { return 'current' as const; } }));
  const originalExit=coded('PROCESS_EXIT_UNCONFIRMED');
  first.closers.push(async()=>{await assert.rejects(old.close(),error=>error===originalExit);});
  const begin = (coordinator: ChatTaskCoordinator) => { const id = randomUUID(), live = { connectionId: randomUUID(), threadId: 'thread:' + id, sessionId: null, model: 'fixture', effort: 'low' };
    coordinator.begin({ id, actorId: 'actor-' + id, snapshot: snapshotFor(live), allowWorkspaceWrites: false, allowAssets: false, accountIdentity: ACCOUNT,
      owner: { snapshot: () => snapshotFor(live), repair: async () => {}, revoke: () => {}, cancel: async () => {}, accountIdentity: () => ACCOUNT } }); return id; };
  const failedExit = workers(signals, { factory: () => { throw originalExit; } });
  const quarantined = begin(old), reserved = old.startProposal({ taskId: quarantined, requestId: randomUUID(), text: 'x', factory: failedExit.factory });
  assert.equal((await settled(old, quarantined, reserved.id)).reason, 'worker_close_unconfirmed');
  const held = workers(signals, { propose: async (_text, input) => { await aborted(input.owner.signal); throw coded('PARENT_SCOPE'); }, close: async () => { throw coded('PROCESS_EXIT_UNCONFIRMED'); } });
  const inFlight = begin(old); old.startProposal({ taskId: inFlight, requestId: randomUUID(), text: 'x', factory: held.factory });
  await delay(10); await assert.rejects(old.close(),error=>error===originalExit); // Original unconfirmed exit remains the cached failure.
  await assert.rejects(old.close(),error=>error===originalExit);
  const replacement = new ChatTaskCoordinator({ directory: second.directory, projectPath: second.project });
  replacement.attachCancellation(Object.freeze({ async cancelExact() {}, async revalidateExact() { return 'current' as const; } }));
  second.closers.push(() => replacement.close());
  const fresh = workers(signals), task = begin(replacement);
  assert.throws(() => replacement.startProposal({ taskId: task, requestId: randomUUID(), text: 'x', factory: fresh.factory }), (error: unknown) => error instanceof ChatTaskProposalError && error.code === 'BUSY');
  assert.equal(fresh.calls.length, 0, 'no slot reuse after replacement');
  const isolated = new ChatTaskProposalBudget(); assert.equal(isolated.available(), true, 'only an explicitly trusted isolated budget starts empty');
});

test('one in flight per task and two globally; no factory call when refused', async t => {
  const f = await coordinatorFixture(t); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const w = workers(f.signals, { propose: async () => { await gate; return { threadId: 't', sessionId: null, turnId: 'u', text: 'done', status: 'proposed' }; } });
  const [a, b, c] = [f.own(), f.own(), f.own()];
  const first = f.coordinator.startProposal({ taskId: a.id, requestId: randomUUID(), text: 'x', factory: w.factory });
  const busy = (taskId: string) => assert.throws(() => f.coordinator.startProposal({ taskId, requestId: randomUUID(), text: 'x', factory: w.factory }), (error: unknown) => error instanceof ChatTaskProposalError && error.code === 'BUSY');
  busy(a.id);
  const second = f.coordinator.startProposal({ taskId: b.id, requestId: randomUUID(), text: 'x', factory: w.factory });
  busy(c.id); await delay(10); assert.equal(w.calls.length, 2);
  release(); await f.coordinator.drain();
  assert.equal((await settled(f.coordinator, a.id, first.id)).state, 'proposed'); assert.equal((await settled(f.coordinator, b.id, second.id)).state, 'proposed');
  const third = f.coordinator.startProposal({ taskId: c.id, requestId: randomUUID(), text: 'x', factory: w.factory });
  assert.equal((await settled(f.coordinator, c.id, third.id)).state, 'proposed', 'slots are released after confirmed closure');
});

test('legacy owners, unowned tasks, restarted tasks and invalid prompts gain no proposal authority', async t => {
  const f = await coordinatorFixture(t), w = workers(f.signals), scope = (taskId: string, code = 'TASK_SCOPE', text = 'x') =>
    assert.throws(() => f.coordinator.startProposal({ taskId, requestId: randomUUID(), text, factory: w.factory }), (error: unknown) => error instanceof ChatTaskProposalError && error.code === code);
  scope(f.own({ account: null }).id); scope(f.own({ getter: false }).id); scope(randomUUID());
  const parent = f.own();
  scope(parent.id, 'ARGUMENTS', ''); scope(parent.id, 'ARGUMENTS', 'x'.repeat(CHAT_TASK_PROPOSAL_LIMITS.promptBytes + 1)); scope(parent.id, 'ARGUMENTS', '\uDC00');
  assert.throws(() => f.own({ account: 'not-hex' }), /not exact/);
  await f.coordinator.close();
  const restarted = new ChatTaskCoordinator({ directory: f.directory, projectPath: f.project, proposalBudget: new ChatTaskProposalBudget() });
  try {
    restarted.attachCancellation(Object.freeze({ async cancelExact() {}, async revalidateExact() { return 'current' as const; } }));
    assert.throws(() => restarted.startProposal({ taskId: parent.id, requestId: randomUUID(), text: 'x', factory: w.factory }), (error: unknown) => error instanceof ChatTaskProposalError && error.code === 'TASK_SCOPE');
  } finally { await restarted.close(); }
  assert.equal(w.calls.length, 0);
});

test('settlement journal fault leaves the attempt reserved, frees the confirmed slot and restart records unknown', async t => {
  const f = await coordinatorFixture(t), parent = f.own(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const w = workers(f.signals, { propose: async () => { await gate; return { threadId: 't', sessionId: null, turnId: 'u', text: 'lost', status: 'proposed' }; } });
  const reserved = f.coordinator.startProposal({ taskId: parent.id, requestId: randomUUID(), text: 'x', factory: w.factory });
  await delay(10); const lock = new DatabaseSync(sqliteTransportPath(f.file)); lock.exec('BEGIN IMMEDIATE');
  try { release(); await f.coordinator.drain(); } finally { lock.exec('ROLLBACK'); lock.close(); }
  assert.equal(f.coordinator.proposals(parent.id)[0]!.state, 'reserved');
  const other = f.own(), next = f.coordinator.startProposal({ taskId: other.id, requestId: randomUUID(), text: 'x', factory: workers(f.signals).factory });
  assert.equal((await settled(f.coordinator, other.id, next.id)).state, 'proposed');
  await f.coordinator.close();
  const store = new ChatTaskStore({ directory: f.directory, projectPath: f.project });
  try { const value = store.proposals(parent.id).find(entry => entry.id === reserved.id)!; assert.equal(value.state, 'unknown'); assert.equal(value.reason, 'daemon_restarted_no_replay'); }
  finally { store.close(); }
});

type CleanupFault = { readonly value: unknown };
type CleanupFaults = { retire?: CleanupFault; verification?: CleanupFault; owner?: CleanupFault; proposal?: CleanupFault };
async function cleanupFaultFixture(t: test.TestContext, faults: CleanupFaults) {
  const f = await fixture(t), events: string[] = [], released: boolean[] = [];
  // A trusted budget fault makes the real tracked plan-proposal promise reject
  // after its worker closed. Ordinary proposal errors are journal outcomes.
  class CleanupBudget extends ChatTaskProposalBudget {
    override release(closed: boolean): void {
      released.push(closed); events.push('proposal-release'); super.release(closed);
      if (faults.proposal) throw faults.proposal.value;
    }
  }
  const coordinator = new ChatTaskCoordinator({ directory: f.directory, projectPath: f.project, proposalBudget: new CleanupBudget() });
  const jobId = randomUUID(), id = randomUUID(), actorId = 'cleanup-' + id;
  const counts = { verification: 0, owner: 0, incorporation: 0, evidence: 0 };
  let complete!:()=>void,refuse!:(error:unknown)=>void;
  const lifetime=new Promise<void>((resolve,reject)=>{complete=resolve;refuse=reject;});
  let original: StudioTestTaskOrigin | null = null;
  coordinator.attachCancellation(Object.freeze({
    async cancelExact(job: string, origin: StudioTestTaskOrigin) {
      assert.equal(job, jobId); assert.equal(origin, original);
      counts.verification++; events.push('cancel-exact');
      if (faults.verification) { refuse(faults.verification.value); throw faults.verification.value; }
      complete();
    },
    async revalidateExact() { assert.fail('A cancelled task cannot revalidate.'); },
  }));
  let release!: () => void, ready!: () => void, entered = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const begun = new Promise<void>(resolve => { ready = resolve; });
  // Cleanup always releases controlled peers before closing the actual store.
  f.closers.push(async () => {
    release();
    const expected=faults.retire??faults.verification??faults.owner??faults.proposal;
    if(expected){
      await assert.rejects(coordinator.close(),error=>Object.is(error,expected.value));
      await assert.rejects(coordinator.close(),error=>Object.is(error,expected.value));
    }else await coordinator.close();
  });
  const live = { connectionId: randomUUID(), threadId: 'cleanup.thread', sessionId: 'cleanup.session', model: 'fixture', effort: 'low' };
  const owner: ChatTaskOwner = {
    snapshot: () => snapshotFor(live), accountIdentity: () => ACCOUNT,
    revoke() { events.push('revoke'); if (faults.retire) throw faults.retire.value; },
    async cancel() { counts.owner++; events.push('owner-cancel'); if (faults.owner) throw faults.owner.value; },
    async repair() { assert.fail('A cancelled task cannot repair.'); },
    plan: () => ({ async waitForInitial() {}, async incorporate() { counts.incorporation++; assert.fail('No late incorporation.'); } }),
  };
  coordinator.begin({ id, actorId, snapshot: owner.snapshot(), allowWorkspaceWrites: false, allowAssets: false, owner, accountIdentity: ACCOUNT });
  coordinator.dispatched(id, randomUUID()); original = coordinator.playtests.capture(actorId); assert.ok(original);
  const work=coordinator.playtests.registerWork(original,Object.freeze({kind:'prepare' as const,completion:lifetime,
    cancel:async()=>{assert.fail('A published job uses only its exact cancellation path.');}}));
  coordinator.playtests.prepared(original, { jobId, displayDigest: sha('display'), scenarioDigest: null, subjectDigest: null },work);
  const w = workers([], { propose: async () => {
    if (++entered === 2) ready();
    await gate;
    return { threadId: 'cleanup.proposal', sessionId: null, turnId: 'cleanup.turn', text: 'late proposal', status: 'proposed' };
  } });
  coordinator.startPlan({ taskId: id, objective: 'Controlled cleanup error precedence', inputSha256: sha('original task'), factory: w.factory,
    evidence: async () => { counts.evidence++; assert.fail('No late evidence request.'); } });
  await begun;
  return { coordinator, id, events, counts, released, w, release };
}

test('task cancellation attempts every original cleanup and preserves the first failure, including falsy values', { timeout: 30000 }, async t => {
  const a = new Error('original verification failure'), b = new Error('later owner failure'), c = new Error('later tracked proposal failure'), d = new Error('original retirement failure');
  const cases: { name: string; faults: CleanupFaults; expected?: CleanupFault }[] = [
    ...[a, null, undefined, false, 0].map((value, index) => ({ name: 'verification first ' + index,
      faults: { verification: { value }, owner: { value: b }, proposal: { value: c } }, expected: { value } })),
    { name: 'owner before proposal', faults: { owner: { value: b }, proposal: { value: c } }, expected: { value: b } },
    { name: 'tracked proposal alone', faults: { proposal: { value: c } }, expected: { value: c } },
    { name: 'retirement before all cleanup', faults: { retire: { value: d }, verification: { value: a }, owner: { value: b }, proposal: { value: c } }, expected: { value: d } },
    { name: 'undefined retirement still cleans up', faults: { retire: { value: undefined }, verification: { value: a }, owner: { value: b }, proposal: { value: c } }, expected: { value: undefined } },
    { name: 'all cleanup succeeds', faults: {} },
  ];
  for (const entry of cases) await t.test(entry.name, async st => {
    const f = await cleanupFaultFixture(st, entry.faults);
    const first = f.coordinator.cancel(f.id, 'controlled stop'), second = f.coordinator.cancel(f.id, 'same owned cleanup');
    let finished = false;
    void first.then(() => { finished = true; }, () => { finished = true; });
    const expected = entry.expected;
    const verify = (pending: Promise<void>) => expected ? assert.rejects(pending, error => Object.is(error, expected.value)) : pending;
    const checked = [verify(first), verify(second)]; for (const result of checked) void result.catch(() => {});
    // Yield a turn after the actual cancellation callbacks: held workers must
    // keep cleanup pending even if verification and owner cleanup both failed.
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(finished, false);
    assert.deepEqual(f.events.filter(event => event === 'cancel-exact' || event === 'owner-cancel'), ['cancel-exact', 'owner-cancel']);
    assert.equal(f.counts.verification, 1); assert.equal(f.counts.owner, 1); assert.equal(f.w.closes, 0);
    f.release(); await Promise.all(checked); await f.coordinator.drain();
    assert.equal(f.w.calls.length, 2); assert.equal(f.w.closes, 2); assert.deepEqual(f.released, [true, true]);
    assert.equal(f.counts.incorporation, 0); assert.equal(f.counts.evidence, 0);
    assert.equal(f.coordinator.list().find(value => value.id === f.id)!.state, 'cancelled');
    await verify(f.coordinator.cancel(f.id, 'observe original cleanup again'));
    assert.equal(f.counts.verification, 1); assert.equal(f.counts.owner, 1); assert.equal(f.w.closes, 2);
  });
});

test('no proposal path produced an unhandled rejection', async () => { await delay(20); assert.deepEqual(unhandled, []); });
