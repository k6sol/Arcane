import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { ChatTaskCoordinator, ChatTaskProposalBudget, type ChatTaskOwner, type ChatTaskProposalWorkerInput } from '../../apps/daemon/src/chat-task-coordinator.js';
import type { Snapshot } from '../../packages/codex-client/src/types.js';

const account = 'a'.repeat(64), objective = 'Implement and verify the local task.', digest = (s: string) => createHash('sha256').update(s).digest('hex');
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const unhandled: unknown[] = []; process.on('unhandledRejection', error => unhandled.push(error));
async function fixture(t: test.TestContext) {
  const boundary = await realpath(tmpdir()), root = await realpath(await mkdtemp(join(boundary, 'arcane-plan-integration-'))), project = join(root, 'project'); await mkdir(project);
  const budget = new ChatTaskProposalBudget(), coordinator = new ChatTaskCoordinator({ directory: join(root, 'journal'), projectPath: project, proposalBudget: budget });
  coordinator.attachCancellation(Object.freeze({ async cancelExact() {}, async revalidateExact() { return 'current' as const; } }));
  t.after(async () => { await coordinator.close(); const part = relative(boundary, root);
    assert.ok(part.startsWith('arcane-plan-integration-') && !isAbsolute(part) && !part.includes(sep)); await rm(root, { recursive: true, force: true }); });
  const state: Snapshot = { connectionId: randomUUID(), provenance: 'spawned-node-fixture', mcpIsolation: 'arcane-only-verified', connected: true, ready: true,
    account: { auth: 'subscription', plan: null, requiresOpenaiAuth: true }, models: [], selection: { model: 'fixture', effort: 'low' }, operations: [], approvals: [], events: [], droppedEvents: 0, lastEventSeq: 0, failureCode: null,
    thread: { configured: true, threadId: 'original.thread', sessionId: 'original.session', selection: { model: 'fixture', effort: 'low' }, turnStatus: 'completed', turnId: 'initial.turn', writeGranted: false } };
  const taskId = randomUUID(), actorId = 'actor-' + randomUUID(), calls: string[] = [], scopes: ChatTaskProposalWorkerInput['owner'][] = [];
  let liveAccount = account, corruptAck = false, closeFailure = false, held = false;
  const workerEntered = deferred(); let workerRelease: (() => void) | null = null;
  const dispatch = () => {
    const operationId = randomUUID(), turnId = randomUUID(); coordinator.dispatched(taskId, operationId);
    state.thread!.turnId = turnId; state.thread!.turnStatus = 'completed';
    state.operations.push({ operationId, method: 'turn/start', requestId: state.operations.length + 1, threadId: state.thread!.threadId, turnId, state: 'acknowledged', errorCode: null });
    return { operationId, turnId };
  };
  const owner: ChatTaskOwner = { snapshot: () => structuredClone(state), accountIdentity: () => liveAccount,
    revoke() { calls.push('revoke'); assert.ok(scopes.every(scope => scope.signal.aborted)); }, async cancel() { calls.push('cancel'); state.connected = false; },
    async repair() { calls.push('repair'); dispatch(); },
    plan(scope) { scopes.push(scope); return Object.freeze({ async waitForInitial() { scope.assertActive(); calls.push('initial'); },
      async incorporate(_text: string, acknowledge: (value: { operationId: string; turnId: string }) => void) {
        scope.assertActive(); calls.push('parent'); const value = dispatch(); acknowledge(corruptAck ? { ...value, operationId: 'foreign.operation' } : value); return 'completed' as const;
      } }); },
  };
  coordinator.begin({ id: taskId, actorId, snapshot: state, allowWorkspaceWrites: true, allowAssets: false, owner, accountIdentity: account });
  dispatch(); coordinator.acknowledged(taskId);
  const factory = async (input: ChatTaskProposalWorkerInput) => {
    input.owner.assertActive(); calls.push('factory'); scopes.push(input.owner);
    const plan = coordinator.plan(taskId)!; const step = coordinator.planSteps(plan.id).at(-1)!;
    assert.equal(step.kind, 'worker'); assert.equal(step.state, 'reserved'); assert.ok(coordinator.proposals(taskId).some(p => p.id === step.proposalId && p.state === 'reserved'));
    return { async propose() { calls.push('worker'); workerEntered.resolve();
      if (held) await new Promise<void>((resolve, reject) => { const abort = () => reject(Error('retired')); workerRelease = () => { input.owner.signal.removeEventListener('abort', abort); resolve(); };
        if (input.owner.signal.aborted) abort(); else input.owner.signal.addEventListener('abort', abort, { once: true }); });
      input.owner.assertActive(); return { threadId: 'worker.thread', sessionId: null, turnId: 'worker.turn', text: 'A bounded suggestion.' }; },
      async close() { calls.push('close'); if (closeFailure) throw Error('unconfirmed closure'); } };
  };
  const start = () => coordinator.startPlan({ taskId, objective, inputSha256: digest(objective), factory, async evidence(plan, scope) {
    scope.assertActive(); calls.push('evidence'); assert.equal(coordinator.planSteps(plan.id).at(-1)!.kind, 'evidence'); return { runId: randomUUID() };
  } });
  return { coordinator, budget, state, owner, taskId, actorId, calls, scopes, start, workerEntered,
    corruptAck() { corruptAck = true; }, changeAccount() { liveAccount = 'b'.repeat(64); }, unconfirmedClose() { closeFailure = true; }, holdWorker() { held = true; }, releaseWorker() { workerRelease?.(); } };
}

test('the owned coordinator drives durable workers, exact native parent hooks and a review reference', { timeout: 10000 }, async t => {
  const f = await fixture(t), plan = f.start(); await f.coordinator.drain();
  assert.equal(f.coordinator.plan(f.taskId)!.state, 'awaiting_review');
  assert.equal(f.calls.filter(c => c === 'factory').length, 5); assert.equal(f.calls.filter(c => c === 'close').length, 5);
  assert.equal(f.calls.filter(c => c === 'parent').length, 2); assert.equal(f.calls.filter(c => c === 'evidence').length, 1);
  assert.equal(f.coordinator.list()[0]!.state, 'working'); assert.equal(f.coordinator.list()[0]!.operationId, f.state.operations.at(-1)!.operationId);
  const before = [...f.calls]; assert.equal(f.start().id, plan.id); await f.coordinator.drain(); assert.deepEqual(f.calls, before);
});

test('a foreign parent acknowledgement cannot complete incorporation or request evidence', { timeout: 10000 }, async t => {
  const f = await fixture(t); f.corruptAck(); const plan = f.start(); await f.coordinator.drain();
  assert.equal(f.coordinator.plan(f.taskId)!.state, 'unknown'); assert.equal(f.coordinator.planSteps(plan.id).at(-1)!.state, 'unknown');
  assert.equal(f.calls.filter(c => c === 'parent').length, 1); assert.ok(!f.calls.includes('evidence'));
});

test('cancelling a held planned worker aborts before revoke, joins closure and prevents every parent dispatch', { timeout: 10000 }, async t => {
  const f = await fixture(t); f.holdWorker(); const plan = f.start(); await f.workerEntered.promise;
  await f.coordinator.cancel(f.taskId, 'human_stop'); await f.coordinator.drain();
  assert.ok(f.scopes.every(scope => scope.signal.aborted)); assert.equal(f.calls.filter(c => c === 'close').length, 1);
  assert.ok(!f.calls.includes('parent')); assert.ok(!f.calls.includes('evidence'));
  assert.equal(f.coordinator.list()[0]!.state, 'cancelled'); assert.notEqual(f.coordinator.planSteps(plan.id)[0]!.state, 'completed');
});

test('an uncertain planned worker closure quarantines its existing budget and stops later effects', { timeout: 10000 }, async t => {
  const f = await fixture(t); f.unconfirmedClose(); f.start(); await f.coordinator.drain();
  assert.equal(f.budget.quarantined, 1); assert.equal(f.coordinator.plan(f.taskId)!.state, 'unknown');
  assert.equal(f.calls.filter(c => c === 'factory').length, 1); assert.ok(!f.calls.includes('parent'));
});

test('repair reservation stops the planning lane while preserving the original one-repair capability', { timeout: 10000 }, async t => {
  const f = await fixture(t); f.holdWorker(); f.start(); await f.workerEntered.promise;
  const origin = f.coordinator.playtests.capture(f.actorId)!;
  const prepared = { jobId: randomUUID(), displayDigest: '1'.repeat(64), scenarioDigest: '2'.repeat(64), subjectDigest: '3'.repeat(64) };
  f.coordinator.playtests.prepared(origin, prepared);
  f.coordinator.playtests.terminal(origin, { ...prepared, reportDigest: '4'.repeat(64),
    review: { runId: randomUUID(), binding: null, scopeDigest: '5'.repeat(64), phase: 'done', outcome: 'failed', code: 'ASSERTION_FAILED', cleanup: 'complete',
      startedAt: 1, deadline: 2, cleanupDeadline: 3, watchdog: { armed: false, fired: false, reason: null }, observations: 1, logs: [], logsTruncated: false,
      evidence: 'fixture', nativeAcceptance: false, canStartAnotherOperation: true, requiresHumanReview: false },
    scenario: { outcome: 'failed', requiredEvidence: 'complete', inputRelease: 'complete', restoration: 'not_required', subjects: 'current' } });
  await f.coordinator.drain();
  assert.equal(f.calls.filter(c => c === 'repair').length, 1); assert.ok(!f.calls.includes('revoke'));
  assert.equal(f.coordinator.list()[0]!.repairDispatch, 'acknowledged');
  assert.deepEqual([f.coordinator.plan(f.taskId)!.state, f.coordinator.plan(f.taskId)!.reason], ['stopped', 'repair_reserved']);
  assert.ok(!f.calls.includes('parent')); assert.ok(!f.calls.includes('evidence'));
});

test('no unhandled coordinator plan rejections', async () => { await new Promise(resolve => setTimeout(resolve, 20)); assert.deepEqual(unhandled, []); });
