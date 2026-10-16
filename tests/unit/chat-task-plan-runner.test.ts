import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { ChatTaskStore, type ChatTaskPlanRecord, type ChatTaskProposalRecord } from '../../packages/storage/src/chat-task-store.js';
import { startChatTaskPlan, CHAT_TASK_PLAN_INPUT_BYTES, type ChatTaskPlanPorts } from '../../apps/daemon/src/chat-task-plan-runner.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const account = 'a'.repeat(64), objective = 'Implement the requested local change and verify the result.';
const unhandled: unknown[] = []; process.on('unhandledRejection', error => unhandled.push(error));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t: test.TestContext) {
  const boundary = await realpath(tmpdir()), root = await realpath(await mkdtemp(join(boundary, 'arcane-plan-runner-'))), project = join(root, 'project');
  await mkdir(project); const directory = join(root, 'journal');
  let store = new ChatTaskStore({ directory, projectPath: project });
  t.after(async () => { store.close(); const part = relative(boundary, root);
    assert.ok(part.startsWith('arcane-plan-runner-') && !isAbsolute(part) && !part.includes(sep)); await rm(root, { recursive: true, force: true }); });
  const task = store.create({ id: randomUUID(), provider: 'codex', threadId: 'original', sessionId: 'session', connectionId: randomUUID(), incarnationId: randomUUID(),
    model: 'fixture', effort: 'low', allowWorkspaceWrites: true, allowAssets: false, state: 'working', round: 0, operationId: null, turnId: null,
    nativeSettled: false, acknowledged: false, repairDispatch: 'not_requested', prepared: null, evidence: [], reason: null });
  const controller = new AbortController(), events: string[] = [];
  const ports: ChatTaskPlanPorts = {
    signal: controller.signal, assertActive() { if (controller.signal.aborted) throw Error('retired'); }, async waitForInitial() { events.push('initial'); },
    async propose(record, prompt) {
      assert.ok(store.planSteps(store.plan(task.id)!.id).some(step => step.kind === 'worker' && step.proposalId === record.id && step.state === 'reserved'));
      assert.equal(store.proposalById(record.id)!.state, 'reserved'); assert.ok(Buffer.byteLength(prompt) <= 16384); events.push('worker');
      const text = 'Suggestion ' + events.length;
      store.settleProposal(record.id, { state: 'proposed', result: { threadId: 'worker', sessionId: null, turnId: randomUUID(), text, textBytes: Buffer.byteLength(text), textSha256: hash(text) } });
    },
    async incorporate(text, acknowledge) {
      assert.ok(Buffer.byteLength(text) < 131072); assert.equal(store.planSteps(store.plan(task.id)!.id).at(-1)!.state, 'reserved');
      assert.equal(store.planSteps(store.plan(task.id)!.id).at(-1)!.inputSha256, hash(text), 'the exact rendered native input is committed before dispatch');
      if (events.filter(e => e === 'parent').length === 1) {
        const reference = store.planSteps(store.plan(task.id)!.id).find(step => step.kind === 'evidence')!;
        assert.equal(reference.state, 'acknowledged'); assert.ok(text.includes(reference.evidence!.runId), 'the last native turn receives its bound review run');
      }
      events.push('parent'); acknowledge({ operationId: randomUUID(), turnId: randomUUID() }); return 'completed';
    },
    async requestEvidence(plan: ChatTaskPlanRecord) { assert.equal(store.planSteps(plan.id).at(-1)!.kind, 'evidence');
      assert.equal(store.planSteps(plan.id).at(-1)!.state, 'reserved'); events.push('evidence'); return { runId: randomUUID() }; },
  };
  const start = (overrides: Partial<ChatTaskPlanPorts> = {}) => startChatTaskPlan({ store, taskId: task.id, accountIdentity: account,
    objective, inputSha256: hash(objective), ports: Object.freeze({ ...ports, ...overrides }) });
  return { get store() { return store; }, task, controller, ports, events, start,
    reopen() { store.close(); store = new ChatTaskStore({ directory, projectPath: project }); return store; } };
}

test('a journal-backed plan reserves before effects, runs five workers and two exact parents, then requests review once', async t => {
  const f = await fixture(t), started = f.start(), done = await started.completion;
  assert.equal(done.state, 'awaiting_review');
  assert.deepEqual(f.events, ['initial', 'worker', 'worker', 'worker', 'parent', 'worker', 'worker', 'evidence', 'parent']);
  assert.equal(f.store.get(f.task.id).state, 'working', 'a plan and review reference never accept a chat task');
  assert.deepEqual(f.store.planSteps(done.id).map(s => [s.kind, s.state]), [
    ['worker', 'completed'], ['worker', 'completed'], ['worker', 'completed'], ['incorporation', 'completed'],
    ['worker', 'completed'], ['worker', 'completed'], ['evidence', 'acknowledged'], ['incorporation', 'completed'],
  ]);
  assert.equal(f.store.plan(f.task.id)!.objectiveSha256, hash(objective));
});

test('duplicate starts during a held original turn only observe the original plan; restart never dispatches it again', async t => {
  const f = await fixture(t), gate = deferred(), initial = deferred();
  const first = f.start({ async waitForInitial() { initial.resolve(); await gate.promise; } }); await initial.promise;
  const second = f.start(); assert.equal(second.plan.id, first.plan.id); assert.equal((await second.completion).state, 'active');
  assert.deepEqual(f.events, []); gate.resolve(); await first.completion;
  const before = [...f.events]; f.reopen(); const observed = await f.start().completion;
  assert.equal(observed.state, 'awaiting_review'); assert.deepEqual(f.events, before);
});

test('unsettled or failed worker responses never imply a usable proposal or authorize a replacement', async t => {
  for (const kind of ['throws', 'returns unsettled', 'all refused'] as const) await t.test(kind, async st => {
    const f = await fixture(st); let workers = 0;
    const done = await f.start({ async propose(record) { workers++;
      if (kind === 'throws') throw Error('lost acknowledgement');
      if (kind === 'all refused') f.store.settleProposal(record.id, { state: 'failed', reason: 'worker_failed_before_dispatch' });
    } }).completion;
    assert.equal(done.state, kind === 'all refused' ? 'stopped' : 'unknown');
    assert.equal(done.reason, kind === 'all refused' ? 'no_usable_proposals' : 'step_unknown');
    assert.equal(workers, kind === 'all refused' ? 3 : 1); assert.deepEqual(f.events, ['initial']);
    const count = workers; await f.start({ async propose() { workers++; } }).completion; assert.equal(workers, count);
  });
});

test('parent acknowledgement and terminal are separate; uncertain or failed parents never open another round or review', async t => {
  for (const mode of ['lost ack', 'missing ack', 'lost terminal', 'failed terminal'] as const) await t.test(mode, async st => {
    const f = await fixture(st); let parents = 0;
    const done = await f.start({ async incorporate(_text, acknowledge) { parents++;
      if (mode === 'lost ack') throw Error('uncertain dispatch');
      if (mode !== 'missing ack') acknowledge({ operationId: 'owned-op', turnId: 'owned-turn' });
      if (mode === 'lost terminal') throw Error('unobserved terminal');
      return mode === 'failed terminal' ? 'failed' : 'completed';
    } }).completion;
    assert.equal(done.state, mode === 'failed terminal' ? 'stopped' : 'unknown'); assert.equal(parents, 1);
    const steps = f.store.planSteps(done.id); assert.equal(steps.length, 4); assert.equal(steps.at(-1)!.terminal, mode === 'failed terminal' ? 'failed' : null);
    assert.ok(!f.events.includes('evidence'));
    // Pre-ACK uncertainty stays dispatch_uncertain; a journaled exact ACK whose terminal was lost is terminal_unobserved.
    assert.deepEqual([steps.at(-1)!.state, steps.at(-1)!.reason, !!steps.at(-1)!.native], {
      'lost ack': ['unknown', 'dispatch_uncertain', false], 'missing ack': ['unknown', 'dispatch_uncertain', false],
      'lost terminal': ['unknown', 'terminal_unobserved', true], 'failed terminal': ['completed', null, true] }[mode]);
    await f.start({ async incorporate() { parents++; return 'completed'; } }).completion; assert.equal(parents, 1);
  });
});

test('an acknowledged final parent whose terminal is unobserved keeps its early evidence and records terminal_unobserved', async t => {
  const f = await fixture(t); let parents = 0;
  const done = await f.start({ async incorporate(_text, acknowledge) { parents++; f.events.push('parent');
    acknowledge({ operationId: 'owned-op-' + parents, turnId: 'owned-turn-' + parents });
    if (parents === 2) throw Error('final terminal unobserved'); return 'completed'; } }).completion;
  assert.deepEqual([done.state, done.reason], ['unknown', 'step_unknown']); assert.equal(parents, 2);
  const steps = f.store.planSteps(done.id), evidence = steps.find(step => step.kind === 'evidence')!, final = steps.at(-1)!;
  assert.ok(evidence.seq < final.seq, 'the review run was bound before the final parent');
  assert.deepEqual([evidence.state, evidence.reason, !!evidence.evidence?.runId], ['acknowledged', null, true]);
  assert.deepEqual([final.kind, final.round, final.state, final.reason, final.native?.turnId], ['incorporation', 2, 'unknown', 'terminal_unobserved', 'owned-turn-2']);
  assert.ok(steps.filter(step => step.kind === 'worker').every(step => step.state === 'completed' && step.reason === null), 'worker steps keep their own reasons');
  await f.start({ async incorporate() { parents++; return 'completed'; } }).completion; assert.equal(parents, 2, 'never replayed');
});

test('a lost evidence response retains an unknown spent request and cannot allocate another review run', async t => {
  const f = await fixture(t); let requested = 0;
  const done = await f.start({ async requestEvidence() { requested++; throw Error('commit landed, reply lost'); } }).completion;
  assert.equal(done.state, 'unknown'); assert.equal(f.store.planSteps(done.id).at(-1)!.reason, 'request_uncertain');
  await f.start({ async requestEvidence() { requested++; return { runId: randomUUID() }; } }).completion; assert.equal(requested, 1);
});

test('retirement during each asynchronous phase prevents every later effect', async t => {
  for (const phase of ['initial', 'worker', 'parent', 'evidence'] as const) await t.test(phase, async st => {
    const f = await fixture(st), overrides: Partial<ChatTaskPlanPorts> = {};
    if (phase === 'initial') overrides.waitForInitial = async () => { f.controller.abort(); };
    if (phase === 'worker') overrides.propose = async record => { await f.ports.propose(record, 'fixture'); f.controller.abort(); };
    if (phase === 'parent') overrides.incorporate = async (text, ack) => { const terminal = await f.ports.incorporate(text, ack); f.controller.abort(); return terminal; };
    if (phase === 'evidence') overrides.requestEvidence = async plan => { const reference = await f.ports.requestEvidence(plan); f.controller.abort(); return reference; };
    const done = await f.start(overrides).completion;
    assert.ok(['stopped', 'unknown'].includes(done.state)); assert.notEqual(done.state, 'awaiting_review');
    assert.equal(f.events.filter(x => x === 'worker').length, phase === 'initial' ? 0 : phase === 'worker' ? 1 : phase === 'parent' ? 3 : 5);
    assert.equal(f.events.filter(x => x === 'parent').length, phase === 'initial' || phase === 'worker' ? 0 : 1);
  });
});

test('original binding drift and proposal capacity refuse before any factory is entered', async t => {
  for (const fault of ['binding', 'proposal capacity'] as const) await t.test(fault, async st => {
    const f = await fixture(st); let factories = 0;
    const done = await f.start({ async waitForInitial() {
      if (fault === 'binding') f.store.update(f.task.id, task => { task.model = 'changed'; });
      else for (let i = 0; i < 8; i++) f.store.reserveProposal({ id: randomUUID(), taskId: f.task.id, requestId: randomUUID(), promptSha256: hash('p'), promptBytes: 1 });
    }, async propose() { factories++; } }).completion;
    assert.equal(done.state, 'stopped'); assert.equal(factories, 0);
  });
});

test('fan-in selects whole proposals within its budget and never truncates generated text', async t => {
  const f = await fixture(t); let count = 0, parents = 0;
  const done = await f.start({ async propose(record: ChatTaskProposalRecord) {
    const text = String(count++).repeat(65536);
    f.store.settleProposal(record.id, { state: 'proposed', result: { threadId: 'worker', sessionId: null, turnId: randomUUID(), text, textBytes: text.length, textSha256: hash(text) } });
  }, async incorporate(text, acknowledge) { parents++; assert.ok(Buffer.byteLength(text) < 131072);
    const step = f.store.planSteps(f.store.plan(f.task.id)!.id).at(-1)!;
    assert.equal(step.fanIn!.proposalIds.length, 1); assert.equal(step.fanIn!.bytes, 65536);
    assert.ok(text.includes(String(parents === 1 ? 0 : 3).repeat(65536))); acknowledge({ operationId: randomUUID(), turnId: randomUUID() }); return 'completed';
  } }).completion;
  assert.equal(done.state, 'awaiting_review'); assert.equal(count, 5); assert.equal(parents, 2);
});

test('port proxies/accessors and asynchronous ownership assertions are refused without hidden effects', async t => {
  const f = await fixture(t); let traps = 0;
  const base = { store: f.store, taskId: f.task.id, accountIdentity: account, objective, inputSha256: hash(objective) };
  const options = { ...base, ports: Object.freeze({ ...f.ports }) };
  assert.throws(() => startChatTaskPlan(new Proxy(options, { get() { traps++; throw Error('get'); }, getPrototypeOf() { traps++; throw Error('prototype'); } })), /own-data/);
  const accessorOptions = { ...options }; Object.defineProperty(accessorOptions, 'objective', { get() { traps++; throw Error('objective getter'); } });
  assert.throws(() => startChatTaskPlan(accessorOptions), /own-data/); assert.equal(traps, 0);
  const proxied = new Proxy(Object.freeze({ ...f.ports }), { getPrototypeOf() { traps++; throw Error('trap'); } });
  assert.throws(() => startChatTaskPlan({ ...base, ports: proxied }), /fixed private/); assert.equal(traps, 0);
  const accessor = { ...f.ports }; Object.defineProperty(accessor, 'assertActive', { get() { traps++; throw Error('getter'); } });
  assert.throws(() => startChatTaskPlan({ ...base, ports: Object.freeze(accessor) }), /own data/); assert.equal(traps, 0);
  assert.throws(() => f.start({ assertActive: (async () => { throw Error('private owner detail'); }) as () => void }), /synchronously/);
  assert.equal(f.store.plan(f.task.id), null); assert.deepEqual(f.events, []);
  assert.throws(() => startChatTaskPlan({ ...base, objective: 'x'.repeat(CHAT_TASK_PLAN_INPUT_BYTES + 1), ports: Object.freeze({ ...f.ports }) }), /bounded/);
});

test('no unhandled plan-runner rejections', async () => { await new Promise(resolve => setTimeout(resolve, 20)); assert.deepEqual(unhandled, []); });
