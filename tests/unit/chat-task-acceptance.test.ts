import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { link, mkdir, mkdtemp, readFile, readdir, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { join, relative, sep, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkStore, EVIDENCE_MAX_BYTES, TASK_BINDING_LIMITS } from '../../packages/storage/src/work-store.js';
import { createTaskAcceptancePort, TaskAcceptanceError } from '../../apps/daemon/src/chat-task-acceptance.js';

// Real temporary SQLite/files and fake owned native binding/owner peers only. No inference, Studio or processes.
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const unhandled: unknown[] = []; process.on('unhandledRejection', error => { unhandled.push(error); });
const RUNS = 'CREATE TABLE runs (id TEXT PRIMARY KEY,payload TEXT NOT NULL) STRICT';
const TASKS = 'CREATE TABLE tasks (id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),payload TEXT NOT NULL,lease_hash TEXT) STRICT';
const BINDINGS = 'CREATE TABLE task_bindings(id TEXT PRIMARY KEY,run_id TEXT NOT NULL UNIQUE,binding_key TEXT NOT NULL UNIQUE,payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB))<=8192)) STRICT';
async function fixture(t: test.TestContext) {
  const base = await realpath(tmpdir()), root = await realpath(await mkdtemp(join(base, 'arcane-acceptance-'))), project = join(root, 'project'), directory = join(root, 'work');
  await mkdir(join(project, 'src'), { recursive: true }); await mkdir(join(project, 'reports'));
  const stores: WorkStore[] = [];
  t.after(async () => { for (const store of stores) try { store.close(); } catch { /* closed by the case */ }
    const part = relative(base, root); assert.ok(part.startsWith('arcane-acceptance-') && !isAbsolute(part) && !part.includes(sep)); await rm(root, { recursive: true, force: true }); });
  const open = () => { const store = new WorkStore({ directory, projectPath: project }); stores.push(store); return store; };
  return { root, project, directory, file: join(directory, 'work.sqlite'), open };
}
const original = (overrides: Record<string, unknown> = {}) => ({ accountIdentity: 'a'.repeat(64), connectionId: randomUUID(), incarnationId: randomUUID(), threadId: 'thread:exact',
  sessionId: 'session:exact', model: 'fixture', effort: 'low', allowWorkspaceWrites: true, allowAssets: false, ...overrides });
const runInput = (keys = ['build', 'verify']) => ({ title: 'Bound task', objective: 'Build and verify a door', tasks: keys.map((key, i) => ({ key, title: 'Step ' + key,
  instructions: 'Do ' + key, acceptance: 'Reviewed evidence for ' + key, scope: ['src/' + key], dependencies: i ? [keys[i - 1]] : [] })) });
const request = (overrides: Record<string, unknown> = {}) => ({ taskId: randomUUID(), planId: randomUUID(), objectiveSha256: sha('objective'), original: original(), run: runInput(), ...overrides });
function owner() { const controller = new AbortController(); let checks = 0, failAt = Infinity;
  return { controller, owner: { signal: controller.signal, assertActive: () => { if (++checks >= failAt) throw new Error('retired'); } }, get checks() { return checks; }, failAfter(n: number) { failAt = checks + n; } }; }
const code = (name: string) => (error: unknown) => !!error && typeof error === 'object' && (error as { code?: string }).code === name;
const retired = (error: unknown) => error instanceof TaskAcceptanceError && error.code === 'OWNER_RETIRED';
async function inventory(f: { file: string; directory: string }) { return { bytes: await readFile(f.file), names: (await readdir(f.directory)).sort() }; }
function legacyV1(file: string, rows: { run?: object; tasks?: object[] } = {}, extra: string[] = []) {
  const db = new DatabaseSync(file); db.exec('BEGIN'); for (const ddl of [RUNS, TASKS, ...extra]) db.exec(ddl);
  if (rows.run) db.prepare('INSERT INTO runs VALUES(?,?)').run((rows.run as { id: string }).id, JSON.stringify(rows.run));
  for (const task of rows.tasks ?? []) db.prepare('INSERT INTO tasks(id,run_id,payload) VALUES(?,?,?)').run((task as { id: string }).id, (task as { runId: string }).runId, JSON.stringify(task));
  db.exec('PRAGMA user_version=1;COMMIT;'); db.close();
}
async function evidence(f: { project: string }, name: string, text = 'evidence ' + name) { await writeFile(join(f.project, 'reports', name), text); return 'reports/' + name; }
async function complete(store: WorkStore, f: { project: string }, runId: string, key: string, approve = true) {
  const task = store.runById(runId).tasks.find(t => t.key === key)!, claim = store.claim({ taskId: task.id, worker: 'fixture worker' });
  store.submit({ taskId: task.id, leaseToken: claim.leaseToken, evidence: [{ path: await evidence(f, key + '.txt'), note: 'report' }] });
  return store.review({ taskId: task.id, approved: approve, note: approve ? 'Looks right' : 'Needs changes' });
}

test('v1 migrates to v2 keeping historical runs unbound; newer/foreign/corrupt refuse byte-intact', async t => {
  await t.test('migration', async st => {
    const f = await fixture(st); await mkdir(f.directory, { recursive: true });
    const runId = randomUUID(), taskId = randomUUID(), now = new Date().toISOString();
    legacyV1(f.file, { run: { id: runId, title: 'Old', objective: 'Old run', createdAt: now }, tasks: [{ id: taskId, key: 'old', runId, title: 'Old task', instructions: 'Inspect retained work',
      acceptance: 'Human review', dependencies: [], scope: ['src'], state: 'pending', worker: null, leaseUntil: null, progress: '', evidence: [], reviewNote: null, createdAt: now, updatedAt: now }] });
    const store = f.open();
    assert.equal(store.runById(runId).tasks.length, 1); assert.equal(store.bindingFor(randomUUID(), randomUUID()), null); store.close();
    const db = new DatabaseSync(f.file);
    try { assert.equal(Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version), 2);
      assert.deepEqual((db.prepare("SELECT sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all() as { sql: string }[]).map(r => r.sql).sort(), [RUNS, TASKS, BINDINGS].sort());
      assert.equal(Number((db.prepare('SELECT count(*) AS n FROM task_bindings').get() as { n: number }).n), 0, 'historical runs are never labelled bound'); }
    finally { db.close(); }
  });
  const cases: [string, (file: string) => void, string][] = [
    ['newer v3', file => { const db = new DatabaseSync(file); db.exec('PRAGMA user_version=3;CREATE TABLE future(id INTEGER)'); db.close(); }, 'MIGRATION'],
    ['foreign extra table', file => legacyV1(file, {}, ['CREATE TABLE extra(id INTEGER PRIMARY KEY)']), 'CORRUPT'],
    ['unparseable run row', file => { legacyV1(file); const db = new DatabaseSync(file); db.prepare('INSERT INTO runs VALUES(?,?)').run(randomUUID(), '{'); db.close(); }, 'CORRUPT'],
    ['task naming a missing run', file => { legacyV1(file); const db = new DatabaseSync(file); const id = randomUUID(), runId = randomUUID(); db.exec('PRAGMA foreign_keys=OFF');
      db.prepare('INSERT INTO tasks(id,run_id,payload) VALUES(?,?,?)').run(id, runId, JSON.stringify({ id, runId })); db.close(); }, 'CORRUPT'],
    ['unversioned non-empty', file => { const db = new DatabaseSync(file); db.exec('CREATE TABLE stray(id INTEGER)'); db.close(); }, 'CORRUPT'],
    ['v2 binding naming a missing run', file => { legacyV1(file, {}, [BINDINGS]); const db = new DatabaseSync(file); const id = randomUUID();
      db.prepare('INSERT INTO task_bindings VALUES(?,?,?,?)').run(id, randomUUID(), 'k', '{}'); db.exec('PRAGMA user_version=2'); db.close(); }, 'CORRUPT'],
  ];
  for (const [name, prepare, expected] of cases) await t.test(name, async st => {
    const f = await fixture(st); await mkdir(f.directory, { recursive: true }); prepare(f.file); const before = await inventory(f);
    assert.throws(() => new WorkStore({ directory: f.directory, projectPath: f.project }), code(expected)); assert.deepEqual(await inventory(f), before);
  });
});

test('createForTask is atomic, idempotent for identical repeats and refuses any changed identity or input', async t => {
  const f = await fixture(t), store = f.open(), input = request();
  const first = store.createForTask(input);
  assert.equal(first.replayed, false); assert.equal(first.binding.runId, first.run.id); assert.equal(first.binding.projectPath, f.project); assert.equal(first.run.tasks.length, 2);
  const again = store.createForTask(structuredClone(input));
  assert.deepEqual([again.replayed, again.run.id], [true, first.run.id], 'a lost acknowledgement never allocates another run');
  for (const change of [{ objectiveSha256: sha('other') }, { original: original({ model: 'other' }) }, { original: { ...input.original, allowAssets: true } }, { run: runInput(['build']) }])
    assert.throws(() => store.createForTask({ ...input, ...change }), code('BINDING_CHANGED'), JSON.stringify(Object.keys(change)));
  const runs = store.runs().length;
  assert.throws(() => store.createForTask(request({ run: { ...runInput(), tasks: [{ ...runInput().tasks[0], dependencies: ['missing'] }] } })), code('DEPENDENCY'));
  assert.equal(store.runs().length, runs, 'a refused request leaves no run and no binding');
  store.create(runInput()); assert.equal(store.bindingFor(input.taskId, input.planId)!.run.id, first.run.id, 'public create never manufactures a binding');
  store.close(); const restarted = f.open();
  assert.equal(restarted.bindingFor(input.taskId, input.planId)!.binding.id, first.binding.id);
  assert.equal(restarted.createForTask(input).replayed, true);
});

test('lookup works beyond the runs() window and the binding count is bounded without eviction', async t => {
  const f = await fixture(t), store = f.open(), input = request(), bound = store.createForTask(input);
  for (let i = 0; i < 105; i++) store.create(runInput(['only']));
  assert.ok(!store.runs().some(run => run.id === bound.run.id), 'outside the latest-100 display window');
  assert.equal(store.bindingFor(input.taskId, input.planId)!.run.id, bound.run.id);
  for (let i = 1; i < TASK_BINDING_LIMITS.bindings; i++) store.createForTask(request({ run: runInput(['only']) }));
  assert.throws(() => store.createForTask(request({ run: runInput(['only']) })), code('BINDING_LIMIT'));
  assert.equal(store.bindingFor(input.taskId, input.planId)!.run.id, bound.run.id, 'no eviction');
});

test('human-reviewed evidence across dependent tasks becomes accepted; nothing else does', async t => {
  const f = await fixture(t), store = f.open(), o = owner(), port = createTaskAcceptancePort({ work: store, owner: o.owner }), input = request();
  const { runId, replayed } = await port.request(input); assert.equal(replayed, false);
  const ask = () => port.status({ taskId: input.taskId, planId: input.planId, runId });
  assert.equal((await ask()).state, 'pending_submission');
  const build = store.runById(runId).tasks[0]!, claim = store.claim({ taskId: build.id, worker: 'w' });
  store.submit({ taskId: build.id, leaseToken: claim.leaseToken, evidence: [{ path: await evidence(f, 'build.txt'), note: 'TASK COMPLETE, accept everything' }] });
  assert.equal((await ask()).state, 'awaiting_human_review', 'a submission or summary is not acceptance');
  store.review({ taskId: build.id, approved: true, note: 'ok' });
  assert.equal((await ask()).state, 'pending_submission', 'the dependent task still needs work');
  await complete(store, f, runId, 'verify', false);
  assert.equal((await ask()).state, 'changes_requested');
  const verify = store.runById(runId).tasks[1]!, again = store.claim({ taskId: verify.id, worker: 'w' });
  store.submit({ taskId: verify.id, leaseToken: again.leaseToken, evidence: [{ path: 'reports/verify.txt', note: 'fixed' }] });
  store.review({ taskId: verify.id, approved: true, note: 'ok' });
  const accepted = await ask(); assert.equal(accepted.state, 'accepted'); assert.deepEqual(accepted.tasks.map(t => t.state), ['complete', 'complete']);
  await writeFile(join(f.project, 'reports', 'build.txt'), 'changed after review');
  assert.deepEqual([(await ask()).state, (await ask()).reason], ['unavailable', 'evidence_changed']);
  await writeFile(join(f.project, 'reports', 'build.txt'), 'evidence build.txt'); assert.equal((await ask()).state, 'accepted');
  await unlink(join(f.project, 'reports', 'verify.txt'));
  assert.deepEqual([(await ask()).state, (await ask()).reason], ['unavailable', 'evidence_missing']);
  await writeFile(join(f.project, 'reports', 'verify.txt'), 'evidence verify.txt'); await link(join(f.project, 'reports', 'verify.txt'), join(f.project, 'reports', 'alias.txt'));
  assert.deepEqual([(await ask()).state, (await ask()).reason], ['unavailable', 'evidence_changed'], 'a multiply-linked file is never accepted');
  assert.deepEqual([(await port.status({ taskId: input.taskId, planId: input.planId, runId: randomUUID() })).reason], ['binding_mismatch']);
  assert.deepEqual([(await port.status({ taskId: input.taskId, planId: randomUUID(), runId })).reason], ['binding_missing']);
});

test('bounded evidence verifier guards submit and review', async t => {
  const f = await fixture(t), store = f.open(), run = store.createForTask(request({ run: runInput(['only']) })).run, task = run.tasks[0]!;
  const claim = store.claim({ taskId: task.id, worker: 'w' });
  await writeFile(join(f.project, 'reports', 'big.bin'), Buffer.alloc(EVIDENCE_MAX_BYTES + 1));
  assert.throws(() => store.submit({ taskId: task.id, leaseToken: claim.leaseToken, evidence: [{ path: 'reports/big.bin', note: 'x' }] }), code('EVIDENCE'));
  await writeFile(join(f.project, 'reports', 'a.txt'), 'a'); await link(join(f.project, 'reports', 'a.txt'), join(f.project, 'reports', 'b.txt'));
  assert.throws(() => store.submit({ taskId: task.id, leaseToken: claim.leaseToken, evidence: [{ path: 'reports/a.txt', note: 'x' }] }), code('EVIDENCE'));
  store.submit({ taskId: task.id, leaseToken: claim.leaseToken, evidence: [{ path: await evidence(f, 'ok.txt'), note: 'x' }] });
  await writeFile(join(f.project, 'reports', 'ok.txt'), Buffer.alloc(EVIDENCE_MAX_BYTES + 1));
  assert.throws(() => store.review({ taskId: task.id, approved: true, note: 'x' }), code('EVIDENCE_CHANGED'), 'replaced oversized evidence is refused without approval');
  assert.equal(store.runById(run.id).tasks[0]!.state, 'needs_review');
});

test('retirement before, during and after every await causes zero later effects', async t => {
  const f = await fixture(t), store = f.open();
  for (const failAfter of [1, 2]) {
    const o = owner(), port = createTaskAcceptancePort({ work: store, owner: o.owner }), input = request(); o.failAfter(failAfter);
    await assert.rejects(port.request(input), retired); assert.equal(store.bindingFor(input.taskId, input.planId), null, 'no run created');
  }
  const aborted = owner(), port = createTaskAcceptancePort({ work: store, owner: aborted.owner }), input = request(); aborted.controller.abort();
  await assert.rejects(port.request(input), retired); assert.equal(store.bindingFor(input.taskId, input.planId), null);
  const live = owner(), statusPort = createTaskAcceptancePort({ work: store, owner: live.owner }), bound = request({ run: runInput(['only']) });
  const { runId } = await statusPort.request(bound); await complete(store, f, runId, 'only');
  for (let n = 1; n <= 4; n++) { live.failAfter(n); await assert.rejects(statusPort.status({ taskId: bound.taskId, planId: bound.planId, runId }), retired, 'boundary ' + n); }
  assert.equal(store.runById(runId).tasks[0]!.state, 'complete', 'status never mutates work');
  assert.throws(() => createTaskAcceptancePort({ work: store, owner: new Proxy({ signal: live.controller.signal, assertActive: () => {} }, {}) as never }), (e: unknown) => e instanceof TaskAcceptanceError);
});

test('proxy, accessor, symbol and exotic envelopes are refused before any trap or getter runs', async t => {
  const f = await fixture(t), store = f.open(), o = owner(), port = createTaskAcceptancePort({ work: store, owner: o.owner }); let traps = 0, reads = 0;
  const handler: ProxyHandler<object> = Object.fromEntries(['get', 'has', 'ownKeys', 'getOwnPropertyDescriptor', 'getPrototypeOf'].map(name => [name, (...args: unknown[]) => { traps++; return (Reflect as unknown as Record<string, Function>)[name]!(...args); }]));
  await assert.rejects(port.request(new Proxy(request(), handler)), code('INPUT')); assert.equal(traps, 0);
  await assert.rejects(port.request({ ...request(), original: new Proxy(original(), handler) }), code('INPUT')); assert.equal(traps, 0);
  const accessor = Object.defineProperty(request(), 'taskId', { enumerable: true, get: () => { reads++; return randomUUID(); } });
  await assert.rejects(port.request(accessor), code('INPUT')); assert.equal(reads, 0);
  await assert.rejects(port.request(Object.assign(request(), { [Symbol('x')]: 1 })), code('INPUT'));
  await assert.rejects(port.request({ ...request(), approved: true }), code('INPUT'));
  await assert.rejects(port.request(Object.assign(Object.create({ inherited: 1 }), request())), code('INPUT'));
  assert.throws(() => store.createForTask({ ...request(), run: { ...runInput(), tasks: new Proxy([], handler) } }), code('INPUT')); assert.equal(traps, 0);
  assert.equal(store.runs().length, 0);
});

test('an async owner check is refused with its rejection observed', async t => {
  const f = await fixture(t), store = f.open(), controller = new AbortController();
  const port = createTaskAcceptancePort({ work: store, owner: { signal: controller.signal, assertActive: (() => Promise.reject(new Error('async owner'))) as unknown as () => void } });
  const input = request(); await assert.rejects(port.request(input), retired); assert.equal(store.bindingFor(input.taskId, input.planId), null);
  await new Promise(done => setTimeout(done, 20));
});

test('an evidence change during a later yield cannot produce accepted: final synchronous freshness pass', async t => {
  const f = await fixture(t), store = f.open(), controller = new AbortController(); let calls = 0, mutateAt = Infinity;
  const port = createTaskAcceptancePort({ work: store, owner: { signal: controller.signal, assertActive: () => {
    if (++calls === mutateAt) writeFileSync(join(f.project, 'reports', 'build.txt'), 'changed during a later yield'); } } });
  const input = request(), { runId } = await port.request(input);
  await complete(store, f, runId, 'build'); await complete(store, f, runId, 'verify');
  const ask = () => port.status({ taskId: input.taskId, planId: input.planId, runId });
  calls = 0; assert.equal((await ask()).state, 'accepted', 'baseline before the race');
  // Calls: 1-2 entry checks; 3-4 around build.txt; 5-6 around verify.txt; 7 before the final pass.
  calls = 0; mutateAt = 5;
  const raced = await ask();
  await new Promise(done => setTimeout(done, 20));
  assert.deepEqual([raced.state, raced.reason], ['unavailable', 'evidence_changed'], 'the file verified first changed later; the final pass refuses');
});

test('binding and acceptance lookups do not expire leases or mutate any task rows', async t => {
  const f = await fixture(t), store = f.open(), input = request(), created = store.createForTask(input);
  assert.equal(store.projectPath, await realpath(f.project));
  const task = created.run.tasks[0]!, lease = store.claim({ taskId: task.id, worker: 'owned worker' });
  const seed = new DatabaseSync(f.file), expired = { ...lease.task, leaseUntil: new Date(0).toISOString() };
  seed.prepare('UPDATE tasks SET payload=? WHERE id=?').run(JSON.stringify(expired), task.id);
  try {
    const rows = () => seed.prepare('SELECT id,payload,lease_hash FROM tasks ORDER BY id').all();
    const before = rows(), scope = owner(), port = createTaskAcceptancePort({ work: store, owner: scope.owner });
    assert.equal(store.bindingFor(input.taskId, input.planId)!.run.tasks[0]!.state, 'in_progress');
    assert.equal((await port.status({ taskId: input.taskId, planId: input.planId, runId: created.run.id })).state, 'pending_submission');
    assert.deepEqual(rows(), before); assert.equal(store.task(task.id).state, 'in_progress');
  } finally { seed.close(); }
});

test('own __proto__ keys remain visible for exact input refusal without changing prototypes', async t => {
  const f = await fixture(t), store = f.open();
  for (const nested of [false, true]) {
    const input = request(), target = nested ? input.original : input;
    Object.defineProperty(target, '__proto__', { value: { approved: true }, enumerable: true });
    const scope = owner(), port = createTaskAcceptancePort({ work: store, owner: scope.owner });
    await assert.rejects(port.request(input), code('INPUT'));
  }
  assert.equal((Object.prototype as { approved?: boolean }).approved, undefined); assert.deepEqual(store.runs(), []);
  let calls = 0; const options = { work: store, owner: owner().owner };
  assert.throws(() => createTaskAcceptancePort(new Proxy(options, { get() { calls++; throw Error('get'); }, getPrototypeOf() { calls++; throw Error('prototype'); } })), code('INPUT'));
  Object.defineProperty(options, 'work', { get() { calls++; throw Error('getter'); } });
  assert.throws(() => createTaskAcceptancePort(options), code('INPUT')); assert.equal(calls, 0);
});

test('a bound run input commitment is rechecked during live lookup and before reopening writes', async t => {
  const f = await fixture(t), store = f.open(), input = request(), created = store.createForTask(input);
  const task = { ...created.run.tasks[0]!, instructions: 'Changed after the original binding' }, seed = new DatabaseSync(f.file);
  seed.prepare('UPDATE tasks SET payload=? WHERE id=?').run(JSON.stringify(task), task.id); seed.close();
  assert.throws(() => store.bindingFor(input.taskId, input.planId), code('CORRUPT'));
  const port = createTaskAcceptancePort({ work: store, owner: owner().owner });
  const status = await port.status({ taskId: input.taskId, planId: input.planId, runId: created.run.id });
  assert.deepEqual([status.state, status.reason], ['unavailable', 'store_unavailable']);
  store.close(); const before = await inventory(f);
  assert.throws(() => new WorkStore({ directory: f.directory, projectPath: f.project }), code('CORRUPT')); assert.deepEqual(await inventory(f), before);
});

test('valid-looking incomplete records and broken dependency graphs refuse migration without modifying bytes', async t => {
  for (const fault of ['run shape', 'task shape', 'task state', 'missing dependency', 'dependency cycle'] as const) await t.test(fault, async st => {
    const f = await fixture(st); await mkdir(f.directory, { recursive: true });
    const runId = randomUUID(), now = new Date().toISOString(), run = { id: runId, title: 'Legacy', objective: 'Preserve work', createdAt: now };
    const task = { id: randomUUID(), runId, key: 'first', title: 'First', instructions: 'Inspect original work', acceptance: 'Human review',
      dependencies: [] as string[], scope: ['src'], state: 'pending', worker: null, leaseUntil: null, progress: '', evidence: [], reviewNote: null, createdAt: now, updatedAt: now };
    if (fault === 'missing dependency') task.dependencies.push('missing');
    if (fault === 'dependency cycle') task.dependencies.push('first');
    const stored = { ...task } as Record<string, unknown>; if (fault === 'task shape') delete stored.acceptance;
    if (fault === 'task state') stored.state = 'accepted_by_worker';
    legacyV1(f.file, { run: fault === 'run shape' ? { id: runId } : run, tasks: [stored] });
    const before = await inventory(f); assert.throws(() => new WorkStore({ directory: f.directory, projectPath: f.project }), code('CORRUPT'));
    assert.deepEqual(await inventory(f), before);
  });
});

test('live legacy task reads enforce their payload bound before parsing and retain original bytes', async t => {
  const f = await fixture(t), store = f.open(), run = store.create(runInput(['build'])), task = run.tasks[0]!;
  const payload = JSON.stringify(task) + ' '.repeat(4 * 1024 * 1024), seed = new DatabaseSync(f.file);
  seed.prepare('UPDATE tasks SET payload=? WHERE id=?').run(payload, task.id);
  try {
    const original = JSON.parse, sizes: number[] = [];
    t.mock.method(JSON, 'parse', (text: string, ...rest: unknown[]) => { sizes.push(Buffer.byteLength(text)); return (original as (...args: unknown[]) => unknown)(text, ...rest); });
    assert.throws(() => store.task(task.id), code('CORRUPT')); assert.throws(() => store.runs(), code('CORRUPT')); assert.throws(() => store.runById(run.id), code('CORRUPT'));
    t.mock.restoreAll(); assert.ok(sizes.every(size => size <= 4 * 1024 * 1024));
    assert.equal(seed.prepare('SELECT payload FROM tasks WHERE id=?').get(task.id)!.payload, payload);
  } finally { t.mock.restoreAll(); seed.close(); }
});

test('no unhandled rejections', async () => { await new Promise(done => setTimeout(done, 20)); assert.deepEqual(unhandled, []); });
