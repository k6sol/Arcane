import { makeFixtureDirectory, fixtureTempDirectory } from './windows-fixture-paths.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { linkSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { ArcaneError, type Connection } from '../../packages/protocol/src/providers.js';
import { WorkStore } from '../../packages/storage/src/work-store.js';
import {
  workflowGateBinding, workflowSubjectDigest,
  type HumanDecision, type WorkflowRecipeRequest, type WorkflowStep, type WorkflowSubmission,
} from '../../packages/core/src/workflow-recipes.js';
import {
  WorkflowService, type WorkflowHumanCommand, type WorkflowHumanRequest,
  type WorkflowServiceOptions, type WorkflowVerifier, type WorkflowVerificationRequest,
} from '../../apps/daemon/src/workflow-service.js';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const selected = { provider: 'codex', model: 'offline-fixture', effort: 'high', connectionRevision: 'offline-v1' } as const;
function request(overrides: Partial<WorkflowRecipeRequest> = {}): WorkflowRecipeRequest {
  return { deliverable: 'code-change', engine: 'roblox', title: 'Offline bounded patch',
    prompt: 'Review a scoped patch with actual local proof files.', scope: ['src'], model: selected, ...overrides };
}
function connection(): Connection {
  return { provider: 'codex', installed: true, version: 'offline', auth: 'subscription', plan: null,
    models: [{ id: selected.model, label: 'Offline fixture', efforts: ['high'], defaultEffort: 'high',
      source: 'runtime-catalogue', entitlement: 'unverified', inputModalities: ['text', 'image'] }],
    features: [{ id: 'coding', label: 'Offline handoff', state: 'native-handoff', route: 'native-client', reason: 'Synthetic observation only.' }],
    warnings: [], observedAt: '2026-10-12T00:00:00Z', revision: selected.connectionRevision };
}
const code = (expected: string) => (error: unknown) => error instanceof ArcaneError && error.code === expected;
function fixture(t: test.TestContext, extra: Partial<WorkflowServiceOptions> = {}) {
  const root = makeFixtureDirectory('arcane-workflow-service-');
  const project = join(root, 'project'), directory = join(root, 'state');
  mkdirSync(project); mkdirSync(join(project, 'src'));
  const work = new WorkStore({ directory, projectPath: project });
  const receipts = new Map<string, string>(), commands: WorkflowHumanCommand[] = [];
  let counter = 0;
  const options: WorkflowServiceOptions = {
    directory, projectPath: project, workStore: { store: work, projectPath: project },
    authorizeHuman(command) {
      assert.ok(Object.isFrozen(command)); assert.ok(Object.isFrozen(command.recipe));
      assert.ok(Object.isFrozen(command.inputArtifacts));
      commands.push(command);
      return receipts.get(command.receiptHash) === command.binding;
    },
    policyContext: () => ({
      connections: [connection()],
      capabilities: [{ id: 'local.patch', state: 'available', safety: 'human-handoff' }],
    }),
    ...extra,
  };
  let service = new WorkflowService(options);
  const f = {
    root, project, directory, work, receipts, commands,
    get service() { return service; },
    issue(prepared: WorkflowHumanRequest): string {
      // Offline host receipt registry, populated only by this explicit test-human seam.
      const receipt = hash('offline-human:' + prepared.binding); receipts.set(receipt, prepared.binding); return receipt;
    },
    next: () => 'request-' + ++counter,
    reopen() { service.close(); service = new WorkflowService(options); },
  };
  t.after(() => {
    service.close(); work.close();
    assert.ok(resolve(root).startsWith(fixtureTempDirectory() + sep));
    rmSync(root, { recursive: true, force: true });
  });
  return f;
}
type Fixture = ReturnType<typeof fixture>;
function create(f: Fixture, recipeRequest = request()) {
  const input = { request: recipeRequest, idempotencyKey: f.next(), receiptHash: f.issue(f.service.prepareCreation(recipeRequest)) };
  return { input, state: f.service.create(input) };
}
function proof(f: Fixture, step: WorkflowStep, subjects: string[], failing = false): WorkflowSubmission {
  const suffix = f.next();
  const artifacts = step.quality.roles.map(role => {
    const path = 'proof/' + suffix + '/' + step.key + '-' + role + '.json';
    const content = Buffer.from(JSON.stringify({ fixture: true, step: step.key, role, suffix }));
    mkdirSync(dirname(join(f.project, path)), { recursive: true }); writeFileSync(join(f.project, path), content);
    return { path, role, sha256: hash(content), bytes: content.length };
  }).sort((a, b) => a.path.localeCompare(b.path));
  const report = artifacts.find(a => a.role === 'report');
  return { key: step.key, artifacts, subjectHashes: subjects,
    checks: step.quality.checks.map((check, i) => ({
      id: check.id, outcome: failing && i === 0 ? 'fail' : 'pass', evidenceSha256: report!.sha256,
      subjectDigest: workflowSubjectDigest(subjects), ...(check.limit === null ? {} : { value: check.limit }),
    })) };
}
function submission(f: Fixture, id: string, key: string) {
  const record = f.service.get(id).workflow;
  const step = record.recipe.steps.find(s => s.key === key)!;
  const subjects = [...new Set(step.subjectSteps.flatMap(key => record.submissions.find(s => s.key === key)?.artifacts.map(a => a.sha256) ?? []))].sort();
  return proof(f, step, subjects);
}
function approveGates(f: Fixture, id: string, key: string) {
  const record = f.service.get(id).workflow, step = record.recipe.steps.find(s => s.key === key)!;
  for (const gate of step.gates) {
    const prepared = f.service.prepareGate(id, key, gate, 'approved');
    const decision: HumanDecision = { stepKey: key, gate, decision: 'approved', binding: prepared.recipeGate!.binding, receiptHash: f.issue(prepared) };
    assert.equal(decision.binding, workflowGateBinding(record.recipe, key, gate, prepared.subjectHashes));
    f.service.recordDecision({ workflowId: id, idempotencyKey: f.next(), decision });
  }
}
function review(f: Fixture, id: string, key: string, decision: 'approved' | 'rejected' = 'approved') {
  return f.service.review({ workflowId: id, stepKey: key, idempotencyKey: f.next(), decision,
    receiptHash: f.issue(f.service.prepareReview(id, key, decision)) });
}
function handoff(f: Fixture, id: string, key: string) {
  approveGates(f, id, key);
  const evidence = submission(f, id, key);
  return f.service.submitHandoff({ workflowId: id, idempotencyKey: f.next(), submission: evidence,
    receiptHash: f.issue(f.service.prepareSubmission(id, evidence)) });
}
function complete(f: Fixture, id: string, key: string) { handoff(f, id, key); return review(f, id, key); }
function ready(f: Fixture, id: string) {
  for (const key of ['prompt', 'requirements', 'plan', 'plan_acceptance', 'implementation']) complete(f, id, key);
}
function verifier(f: () => Fixture, calls: { count: number }, failing = false): WorkflowVerifier {
  return { action: 'verify-code', verify(input: Readonly<WorkflowVerificationRequest>) {
    calls.count++;
    assert.ok(Object.isFrozen(input)); assert.ok(Object.isFrozen(input.step));
    return { status: 'evidence', submission: proof(f(), input.step, [...new Set(input.inputArtifacts.map(a => a.sha256))].sort(), failing) };
  } };
}

test('human authority defaults deny; JSON labels, truthiness, promises and thrown secrets cannot grant it', t => {
  for (const authorizeHuman of [
    undefined, (() => 'yes') as unknown as WorkflowServiceOptions['authorizeHuman'],
    (() => Promise.resolve(true)) as unknown as WorkflowServiceOptions['authorizeHuman'],
    () => { throw new Error('PRIVATE-HOST-PROOF'); },
  ]) {
    const f = fixture(t, authorizeHuman ? { authorizeHuman } : { authorizeHuman: () => false });
    const input = { request: request(), idempotencyKey: f.next(), receiptHash: hash('forged') };
    assert.throws(() => f.service.create(input), code('WORKFLOW_HUMAN_REQUIRED'));
    assert.throws(() => f.service.create({ ...input, trustedHuman: true }), code('WORKFLOW_INPUT'));
    assert.throws(() => f.service.create({ ...input, approved: true }), code('WORKFLOW_INPUT'));
    assert.equal(f.work.runs().length, 0); assert.equal(f.service.list().length, 0);
  }
});
test('recipe mapping is durable and idempotent, and a borrowed WorkStore stays open', t => {
  const f = fixture(t), { input, state } = create(f), id = state.workflow.id;
  assert.equal(state.workflow.recipe.id.startsWith('workflow-v1-'), true);
  assert.equal(state.tasks.length, state.workflow.recipe.steps.length);
  assert.equal(f.service.create(input).workflow.id, id); assert.equal(f.work.runs().length, 1);
  assert.throws(() => f.service.create({ ...input, request: request({ prompt: 'Different objective.' }) }), code('WORKFLOW_IDEMPOTENCY'));
  f.reopen(); assert.deepEqual(f.service.get(id).workflow.taskIds, state.workflow.taskIds);
  assert.equal(f.service.create(input).workflow.id, id); assert.equal(f.work.runs().length, 1);
  f.service.close(); assert.equal(f.work.task(state.tasks[0]!.id).state, 'pending');
  assert.throws(() => f.service.get(id), code('WORKFLOW_CLOSED'));
});
test('receipt bindings include project and workflow instance, and strict WorkStore project injection is checked', t => {
  const a = fixture(t), b = fixture(t);
  const approved = a.issue(a.service.prepareCreation(request()));
  b.receipts.set(approved, a.receipts.get(approved)!);
  assert.throws(() => b.service.create({ request: request(), idempotencyKey: b.next(), receiptHash: approved }), code('WORKFLOW_HUMAN_REQUIRED'));
  assert.throws(() => new WorkflowService({ directory: join(b.root, 'other-state'), projectPath: b.project,
    workStore: { store: a.work, projectPath: a.project } }), code('WORKFLOW_PROJECT'));
});
test('handoff and every evidence acceptance require distinct exact human receipts; policy sees the exact gate', t => {
  const f = fixture(t), id = create(f).state.workflow.id;
  const prompt = handoff(f, id, 'prompt');
  assert.equal(prompt.workflow.taskStates.prompt, 'needs_review');
  assert.equal(prompt.assessment!.steps.find(s => s.key === 'requirements')!.disposition, 'pending');
  assert.throws(() => f.service.review({ workflowId: id, stepKey: 'prompt', idempotencyKey: f.next(), decision: 'approved', receiptHash: hash('forged') }), code('WORKFLOW_HUMAN_REQUIRED'));
  review(f, id, 'prompt');
  const prepared = f.service.prepareGate(id, 'requirements', 'model-handoff', 'approved');
  assert.equal(prepared.inputArtifacts.length, 1); assert.equal(prepared.recipeGate!.workflowId, prompt.workflow.recipe.id);
  assert.throws(() => f.service.recordDecision({ workflowId: id, idempotencyKey: f.next(),
    decision: { ...prepared.recipeGate, workflowId: undefined, binding: hash('stale'), receiptHash: f.issue(prepared) } }), code('WORKFLOW_INPUT'));
  const gate = prepared.recipeGate!;
  assert.throws(() => f.service.recordDecision({ workflowId: id, idempotencyKey: f.next(),
    decision: { stepKey: gate.stepKey, gate: gate.gate, decision: gate.decision, binding: hash('stale'), receiptHash: f.issue(prepared) } }), code('WORKFLOW_BINDING'));
  complete(f, id, 'requirements');
  const seen = f.commands.filter(c => c.recipeGate?.stepKey === 'requirements');
  assert.ok(seen.length > 1); assert.ok(seen.every(c => c.recipeGate!.binding === prepared.recipeGate!.binding));
  assert.ok(seen.every(c => c.inputArtifacts[0]!.sha256 === prompt.workflow.submissions[0]!.artifacts[0]!.sha256));
});


test('only injected deterministic verification executes and success remains pending human review', async t => {
  const calls = { count: 0 };
  let f!: Fixture; f = fixture(t, { verifiers: [verifier(() => f, calls)] });
  const id = create(f).state.workflow.id;
  await assert.rejects(f.service.verify({ workflowId: id, stepKey: 'requirements', idempotencyKey: f.next() }), code('WORKFLOW_VERIFIER'));
  ready(f, id);
  const fake = submission(f, id, 'verification');
  assert.throws(() => f.service.prepareSubmission(id, fake), code('WORKFLOW_VERIFIER'));
  await assert.rejects(f.service.verify({ workflowId: id, stepKey: 'verification', idempotencyKey: f.next(), command: 'node forbidden.js' }), code('WORKFLOW_INPUT'));
  const input = { workflowId: id, stepKey: 'verification', idempotencyKey: f.next() };
  const verified = await f.service.verify(input);
  assert.equal(calls.count, 1); assert.equal(verified.workflow.taskStates.verification, 'needs_review');
  assert.equal(verified.workflow.attempts[0]!.state, 'submitted');
  assert.equal(verified.assessment!.steps.find(s => s.key === 'preview_acceptance')!.disposition, 'pending');
  await f.service.verify(input); assert.equal(calls.count, 1);
  review(f, id, 'verification');
  for (const key of ['preview_acceptance', 'review_analysis', 'review']) complete(f, id, key);
  assert.ok(f.service.get(id).assessment!.steps.every(s => s.state === 'complete'));
  f.reopen(); assert.ok(f.service.get(id).assessment!.steps.every(s => s.state === 'complete'));
});
test('catalogue or browser capability labels cannot manufacture a verifier', async t => {
  const f = fixture(t, { policyContext: () => ({ connections: [connection()], capabilities: [
    { id: 'local.patch', state: 'available', safety: 'human-handoff' },
    { id: 'local.code.verify', state: 'available', safety: 'read-only-deterministic' },
  ] }) });
  const id = create(f).state.workflow.id; ready(f, id);
  assert.ok(f.service.get(id).assessment!.steps.find(s => s.key === 'verification')!.blockers.some(b => b.code === 'capability'));
  await assert.rejects(f.service.verify({ workflowId: id, stepKey: 'verification', idempotencyKey: f.next() }), code('WORKFLOW_VERIFIER'));
});
test('failed measured checks stay reviewable but cannot be accepted', async t => {
  const calls = { count: 0 }; let f!: Fixture;
  f = fixture(t, { verifiers: [verifier(() => f, calls, true)] });
  const id = create(f).state.workflow.id; ready(f, id);
  await f.service.verify({ workflowId: id, stepKey: 'verification', idempotencyKey: f.next() });
  assert.throws(() => review(f, id, 'verification'), code('WORKFLOW_BLOCKED'));
  review(f, id, 'verification', 'rejected');
  await assert.rejects(f.service.verify({ workflowId: id, stepKey: 'verification', idempotencyKey: f.next() }), code('WORKFLOW_VERIFIER'));
  assert.equal(calls.count, 1);
});
test('busy evidence reads have durable finite attempt bounds; duplicate requests do not retry', async t => {
  let calls = 0;
  const f = fixture(t, { verifiers: [{ action: 'verify-code', verify: () => { calls++; return { status: 'evidence-read-busy' }; } }] });
  const id = create(f).state.workflow.id; ready(f, id);
  const first = { workflowId: id, stepKey: 'verification', idempotencyKey: f.next() };
  assert.equal((await f.service.verify(first)).result, 'busy'); await f.service.verify(first); assert.equal(calls, 1);
  f.reopen();
  assert.equal((await f.service.verify({ ...first, idempotencyKey: f.next() })).result, 'busy');
  await assert.rejects(f.service.verify({ ...first, idempotencyKey: f.next() }), code('WORKFLOW_RETRY'));
  assert.equal(calls, 2); assert.equal(f.service.get(id).workflow.attempts.length, 2);
});
test('unsupported results do not become retries or acceptance', async t => {
  let calls = 0;
  const f = fixture(t, { verifiers: [{ action: 'verify-code', verify: () => { calls++; return { status: 'unsupported' }; } }] });
  const id = create(f).state.workflow.id; ready(f, id);
  assert.equal((await f.service.verify({ workflowId: id, stepKey: 'verification', idempotencyKey: f.next() })).result, 'unsupported');
  await assert.rejects(f.service.verify({ workflowId: id, stepKey: 'verification', idempotencyKey: f.next() }), code('WORKFLOW_RETRY'));
  assert.equal(calls, 1); assert.equal(f.service.get(id).workflow.taskStates.verification, 'pending');
});
test('changed accepted evidence blocks verification before the callback runs', async t => {
  const calls = { count: 0 }; let f!: Fixture; f = fixture(t, { verifiers: [verifier(() => f, calls)] });
  const id = create(f).state.workflow.id; ready(f, id);
  const artifact = f.service.get(id).workflow.submissions.find(s => s.key === 'implementation')!.artifacts[0]!;
  writeFileSync(join(f.project, artifact.path), 'changed-input');
  await assert.rejects(f.service.verify({ workflowId: id, stepKey: 'verification', idempotencyKey: f.next() }), code('WORKFLOW_EVIDENCE'));
  assert.equal(calls.count, 0);
});
test('an asynchronous callback cannot race another mutation or close; changed inputs become uncertain', async t => {
  let release!: (result: { status: 'evidence-read-busy' }) => void;
  const f = fixture(t, { verifiers: [{ action: 'verify-code', verify: () => new Promise(resolve => { release = resolve; }) }] });
  const id = create(f).state.workflow.id; ready(f, id);
  const artifact = f.service.get(id).workflow.submissions.find(s => s.key === 'implementation')!.artifacts[0]!;
  const input = { workflowId: id, stepKey: 'verification', idempotencyKey: f.next() };
  const pending = f.service.verify(input);
  assert.equal(f.service.get(id).assessment, null);
  assert.throws(() => f.service.close(), code('WORKFLOW_BUSY'));
  await assert.rejects(f.service.verify({ ...input, idempotencyKey: f.next() }), code('WORKFLOW_BUSY'));
  assert.throws(() => f.service.create({ request: request(), idempotencyKey: f.next(), receiptHash: hash('forged') }), code('WORKFLOW_BUSY'));
  writeFileSync(join(f.project, artifact.path), 'changed-during-callback');
  release({ status: 'evidence-read-busy' });
  await assert.rejects(pending, code('WORKFLOW_UNCERTAIN'));
  assert.equal(f.service.get(id).workflow.attempts[0]!.state, 'uncertain');
  await assert.rejects(f.service.verify(input), code('WORKFLOW_UNCERTAIN'));
  f.reopen(); await assert.rejects(f.service.verify({ ...input, idempotencyKey: f.next() }), code('WORKFLOW_UNCERTAIN'));
});
test('thrown verifier outcomes remain uncertain across restart and can only be explicitly halted', async t => {
  let calls = 0;
  const f = fixture(t, { verifiers: [{ action: 'verify-code', verify: () => { calls++; throw new Error('PRIVATE-VERIFIER-ERROR'); } }] });
  const id = create(f).state.workflow.id; ready(f, id);
  const input = { workflowId: id, stepKey: 'verification', idempotencyKey: f.next() };
  await assert.rejects(f.service.verify(input), error => code('WORKFLOW_UNCERTAIN')(error) && !(error as Error).message.includes('PRIVATE'));
  f.reopen(); await assert.rejects(f.service.verify(input), code('WORKFLOW_UNCERTAIN'));
  await assert.rejects(f.service.verify({ ...input, idempotencyKey: f.next() }), code('WORKFLOW_UNCERTAIN'));
  assert.throws(() => f.service.reconcile({ workflowId: id, idempotencyKey: f.next(), receiptHash: hash('forged'), resolution: 'halt' }), code('WORKFLOW_HUMAN_REQUIRED'));
  const receiptHash = f.issue(f.service.prepareReconciliation(id, 'halt'));
  assert.equal(f.service.reconcile({ workflowId: id, idempotencyKey: f.next(), receiptHash, resolution: 'halt' }).workflow.state, 'halted');
  await assert.rejects(f.service.verify({ ...input, idempotencyKey: f.next() }), code('WORKFLOW_UNCERTAIN'));
  assert.equal(calls, 1);
});
test('a lost submission response reconciles actual pinned WorkStore evidence without replay', t => {
  const f = fixture(t), id = create(f).state.workflow.id, evidence = submission(f, id, 'prompt');
  const input = { workflowId: id, idempotencyKey: f.next(), submission: evidence,
    receiptHash: f.issue(f.service.prepareSubmission(id, evidence)) };
  const original = f.work.submit.bind(f.work); let calls = 0;
  f.work.submit = value => { calls++; original(value); throw new Error('simulated response loss'); };
  assert.throws(() => f.service.submitHandoff(input), code('WORKFLOW_UNCERTAIN'));
  assert.equal(f.service.get(id).tasks.find(t => t.key === 'prompt')!.state, 'needs_review');
  f.reopen(); assert.throws(() => f.service.submitHandoff(input), code('WORKFLOW_UNCERTAIN'));
  const receiptHash = f.issue(f.service.prepareReconciliation(id, 'accept-observed'));
  f.service.reconcile({ workflowId: id, idempotencyKey: f.next(), receiptHash, resolution: 'accept-observed' });
  assert.equal(f.service.get(id).workflow.taskStates.prompt, 'needs_review'); assert.equal(calls, 1);
  review(f, id, 'prompt'); assert.equal(f.service.get(id).workflow.taskStates.prompt, 'complete');
  assert.throws(() => f.service.submitHandoff(input), code('WORKFLOW_UNCERTAIN'));
});
test('a lost review response reconciles the exact approved outcome', t => {
  const f = fixture(t), id = create(f).state.workflow.id; handoff(f, id, 'prompt');
  const original = f.work.review.bind(f.work);
  f.work.review = value => { original(value); throw new Error('simulated review response loss'); };
  assert.throws(() => review(f, id, 'prompt'), code('WORKFLOW_UNCERTAIN'));
  const receiptHash = f.issue(f.service.prepareReconciliation(id, 'accept-observed'));
  f.service.reconcile({ workflowId: id, idempotencyKey: f.next(), receiptHash, resolution: 'accept-observed' });
  assert.equal(f.service.get(id).workflow.taskStates.prompt, 'complete');
});
test('lost creation responses require exact observed mapping, never another WorkStore create', t => {
  const f = fixture(t), prepared = f.service.prepareCreation(request()), original = f.work.create.bind(f.work); let calls = 0;
  f.work.create = input => { calls++; original(input); throw new Error('simulated create response loss'); };
  const input = { request: request(), idempotencyKey: f.next(), receiptHash: f.issue(prepared) };
  assert.throws(() => f.service.create(input), code('WORKFLOW_UNCERTAIN'));
  const id = f.service.list()[0]!.id, run = f.work.runs()[0]!;
  assert.throws(() => f.service.create(input), code('WORKFLOW_UNCERTAIN'));
  const observedRun = { runId: run.id, taskIds: Object.fromEntries(run.tasks.map(t => [t.key, t.id])) };
  f.service.reconcile({ workflowId: id, idempotencyKey: f.next(), resolution: 'accept-observed', observedRun,
    receiptHash: f.issue(f.service.prepareReconciliation(id, 'accept-observed', observedRun)) });
  assert.equal(f.service.get(id).workflow.runId, run.id); assert.equal(calls, 1);
});
test('out-of-band WorkStore boolean approval cannot promote a coordinator step', t => {
  const f = fixture(t), id = create(f).state.workflow.id, state = handoff(f, id, 'prompt');
  f.work.review({ taskId: state.workflow.taskIds.prompt, approved: true, note: 'Outside coordinator' });
  assert.throws(() => f.service.get(id), code('WORKFLOW_MAPPING'));
});
test('unsafe paths, links, fake hashes, byte mismatches and collection bounds fail before submission', t => {
  const f = fixture(t), id = create(f).state.workflow.id;
  const evidence = submission(f, id, 'prompt');
  for (const path of ['../outside', '.env', '.ssh/key', 'C:/outside', 'proof/../outside']) {
    const bad = { ...evidence, artifacts: [{ ...evidence.artifacts[0]!, path }] };
    assert.throws(() => f.service.prepareSubmission(id, bad));
  }
  assert.throws(() => f.service.prepareSubmission(id, { ...evidence, artifacts: [{ ...evidence.artifacts[0]!, sha256: hash('fake') }] }), code('WORKFLOW_EVIDENCE'));
  assert.throws(() => f.service.prepareSubmission(id, { ...evidence, artifacts: [{ ...evidence.artifacts[0]!, bytes: evidence.artifacts[0]!.bytes + 1 }] }), code('WORKFLOW_EVIDENCE'));
  assert.throws(() => f.service.prepareSubmission(id, { ...evidence, artifacts: Array(21).fill(evidence.artifacts[0]) }));
  const hard = 'proof/hard.json'; linkSync(join(f.project, evidence.artifacts[0]!.path), join(f.project, hard));
  assert.throws(() => f.service.prepareSubmission(id, { ...evidence, artifacts: [{ ...evidence.artifacts[0]!, path: hard }] }), code('WORKFLOW_EVIDENCE'));
  const outside = join(f.root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'brief.json'), 'outside');
  symlinkSync(outside, join(f.project, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const linked = { ...evidence, artifacts: [{ ...evidence.artifacts[0]!, path: 'linked/brief.json', sha256: hash('outside'), bytes: 7 }] };
  assert.throws(() => f.service.prepareSubmission(id, linked), code('WORKFLOW_EVIDENCE'));
  assert.equal(f.service.get(id).workflow.taskStates.prompt, 'pending');
});

