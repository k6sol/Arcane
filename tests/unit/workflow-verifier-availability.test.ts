import { makeFixtureDirectory, fixtureTempDirectory } from './windows-fixture-paths.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { ArcaneError, type Connection } from '../../packages/protocol/src/providers.js';
import { WorkStore } from '../../packages/storage/src/work-store.js';
import {
  workflowGateBinding, workflowSubjectDigest,
  type HumanDecision, type WorkflowRecipeRequest, type WorkflowStep, type WorkflowSubmission,
} from '../../packages/core/src/workflow-recipes.js';
import {
  WorkflowService, type WorkflowHumanRequest, type WorkflowServiceOptions,
  type WorkflowVerifier, type WorkflowVerificationRequest,
} from '../../apps/daemon/src/workflow-service.js';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const selected = { provider: 'codex', model: 'synthetic-availability-fixture', effort: 'high', connectionRevision: 'synthetic-v1' } as const;
const errorCode = (expected: string) => (error: unknown) => error instanceof ArcaneError && error.code === expected;
type Availability = NonNullable<WorkflowVerifier['available']>;

// Synthetic model catalogue only: no installed provider, inference or Studio is used.
function connection(): Connection {
  return {
    provider: 'codex', installed: true, version: 'synthetic', auth: 'subscription', plan: null,
    models: [{ id: selected.model, label: 'Synthetic availability fixture', efforts: ['high'], defaultEffort: 'high',
      source: 'runtime-catalogue', entitlement: 'unverified', inputModalities: ['text', 'image'] }],
    features: [{ id: 'coding', label: 'Synthetic handoff observation', state: 'native-handoff', route: 'native-client',
      reason: 'Synthetic catalogue for service tests only.' }],
    warnings: [], observedAt: '2026-10-13T00:00:00Z', revision: selected.connectionRevision,
  };
}
function fixture(t: test.TestContext, extra: Pick<WorkflowServiceOptions, 'verifiers' | 'policyContext'> = {}) {
  const root = makeFixtureDirectory('arcane-verifier-availability-');
  const project = join(root, 'project'), directory = join(root, 'state');
  mkdirSync(project); mkdirSync(join(project, 'src'));
  const work = new WorkStore({ directory, projectPath: project });
  const receipts = new Map<string, string>();
  let sequence = 0, service: WorkflowService | undefined;
  // Register cleanup before constructing the service, including rejected registrations.
  t.after(() => {
    try { service?.close(); }
    finally {
      work.close();
      assert.ok(resolve(root).startsWith(fixtureTempDirectory() + sep));
      rmSync(root, { recursive: true, force: true });
    }
  });
  service = new WorkflowService({
    directory, projectPath: project, workStore: { store: work, projectPath: project },
    authorizeHuman: command => receipts.get(command.receiptHash) === command.binding,
    policyContext: () => ({ connections: [connection()], capabilities: [
      { id: 'local.patch', state: 'available', safety: 'human-handoff' },
    ] }),
    ...extra,
  });
  return {
    project, directory, work, service,
    next: () => 'availability-' + ++sequence,
    issue(prepared: WorkflowHumanRequest): string {
      // Synthetic human receipt registry: this explicit fixture seam grants each exact binding.
      const receipt = hash('synthetic-human-availability:' + prepared.binding);
      receipts.set(receipt, prepared.binding); return receipt;
    },
  };
}
type Fixture = ReturnType<typeof fixture>;

function proof(f: Fixture, step: WorkflowStep, subjects: string[]): WorkflowSubmission {
  const suffix = f.next();
  const artifacts = step.quality.roles.map(role => {
    const path = 'proof/' + suffix + '/' + step.key + '-' + role + '.json';
    const content = Buffer.from(JSON.stringify({ syntheticFixture: 'verifier-availability', step: step.key, role, suffix }));
    mkdirSync(dirname(join(f.project, path)), { recursive: true });
    writeFileSync(join(f.project, path), content);
    return { path, role, sha256: hash(content), bytes: content.length };
  }).sort((a, b) => a.path.localeCompare(b.path));
  const report = artifacts.find(a => a.role === 'report')!;
  return {
    key: step.key, artifacts, subjectHashes: subjects,
    checks: step.quality.checks.map(check => ({
      id: check.id, outcome: 'pass', evidenceSha256: report.sha256,
      subjectDigest: workflowSubjectDigest(subjects), ...(check.limit === null ? {} : { value: check.limit }),
    })),
  };
}
function ready(f: Fixture): string {
  const request: WorkflowRecipeRequest = {
    deliverable: 'code-change', engine: 'roblox', title: 'Synthetic verifier availability fixture',
    prompt: 'Exercise coordinator availability with owned local evidence files.', scope: ['src'], model: selected,
  };
  const id = f.service.create({ request, idempotencyKey: f.next(),
    receiptHash: f.issue(f.service.prepareCreation(request)) }).workflow.id;
  for (const key of ['prompt', 'requirements', 'plan', 'plan_acceptance', 'implementation']) {
    const record = f.service.get(id).workflow, step = record.recipe.steps.find(s => s.key === key)!;
    for (const gate of step.gates) {
      const prepared = f.service.prepareGate(id, key, gate, 'approved');
      const decision: HumanDecision = {
        stepKey: key, gate, decision: 'approved', binding: prepared.recipeGate!.binding, receiptHash: f.issue(prepared),
      };
      assert.equal(decision.binding, workflowGateBinding(record.recipe, key, gate, prepared.subjectHashes));
      f.service.recordDecision({ workflowId: id, idempotencyKey: f.next(), decision });
    }
    const subjects = [...new Set(step.subjectSteps.flatMap(subject =>
      record.submissions.find(s => s.key === subject)?.artifacts.map(a => a.sha256) ?? []))].sort();
    const submission = proof(f, step, subjects);
    f.service.submitHandoff({ workflowId: id, idempotencyKey: f.next(), submission,
      receiptHash: f.issue(f.service.prepareSubmission(id, submission)) });
    f.service.review({ workflowId: id, stepKey: key, idempotencyKey: f.next(), decision: 'approved',
      receiptHash: f.issue(f.service.prepareReview(id, key, 'approved')) });
  }
  assert.equal(f.work.runs().length, 1);
  return id;
}
function assessment(f: Fixture, id: string) {
  const snapshot = f.service.get(id);
  assert.ok(snapshot.assessment);
  const step = snapshot.assessment.steps.find(s => s.key === 'verification');
  assert.ok(step); return step;
}
function evidenceVerifier(getFixture: () => Fixture, calls: { count: number }): WorkflowVerifier['verify'] {
  return input => {
    calls.count++;
    assert.ok(Object.isFrozen(input)); assert.ok(Object.isFrozen(input.step));
    return { status: 'evidence', submission: proof(getFixture(), input.step,
      [...new Set(input.inputArtifacts.map(a => a.sha256))].sort()) };
  };
}
async function denied(f: Fixture, id: string, calls: { count: number }, expectedAttempts = 0, expectedCalls = 0) {
  const before = f.service.get(id), step = assessment(f, id);
  assert.equal(step.disposition, 'pending');
  assert.deepEqual(step.blockers, [{ code: 'capability', requirement: 'local.code.verify' }]);
  assert.equal(before.workflow.attempts.length, expectedAttempts);
  assert.equal(calls.count, expectedCalls);
  const key = f.next();
  await assert.rejects(f.service.verify({ workflowId: id, stepKey: 'verification', idempotencyKey: key }), errorCode('WORKFLOW_VERIFIER'));
  const after = f.service.get(id);
  assert.deepEqual(after.workflow, before.workflow);
  assert.deepEqual(after.tasks, before.tasks);
  assert.equal(calls.count, expectedCalls);
  const db = new DatabaseSync(join(f.directory, 'workflow.sqlite'), { readOnly: true, allowExtension: false });
  try {
    assert.equal(db.prepare('SELECT count(*) AS count FROM workflow_commands WHERE key=?').get(key)!.count, 0);
  } finally { db.close(); }
}

test('false availability blocks a ready code recipe before any attempt or verifier dispatch', async t => {
  const calls = { count: 0 };
  let observations = 0, f!: Fixture;
  f = fixture(t, { verifiers: [{ action: 'verify-code', available: () => { observations++; return false; },
    verify: evidenceVerifier(() => f, calls) }] });
  const id = ready(f);
  await denied(f, id, calls);
  assert.ok(observations > 0);
  assert.equal(f.work.task(f.service.get(id).workflow.taskIds.verification!).state, 'pending');
});

test('throwing, asynchronous and nonboolean availability deny without unhandled rejections', async t => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  t.after(() => { process.off('unhandledRejection', onUnhandled); });
  const observers: Array<[string, () => unknown]> = [
    ['throws', () => { throw new Error('SYNTHETIC-AVAILABILITY-THROW'); }],
    ['async true', async () => true],
    ['async rejection', async () => { throw new Error('SYNTHETIC-AVAILABILITY-REJECTION'); }],
    ['truthy string', () => 'available'],
    ['truthy number', () => 1],
    ['object', () => ({ available: true })],
    ['boxed boolean', () => new Boolean(true)],
    ['thenable true', () => ({ then: (resolveValue: (value: boolean) => void) => resolveValue(true) })],
    ['null', () => null],
    ['undefined', () => undefined],
  ];
  for (const [label, observer] of observers) await t.test(label, async t => {
    const calls = { count: 0 }; let f!: Fixture;
    f = fixture(t, { verifiers: [{ action: 'verify-code', available: observer as Availability,
      verify: evidenceVerifier(() => f, calls) }] });
    await denied(f, ready(f), calls);
    // Give rejected observer promises a full event-loop turn to surface if not consumed.
    await nextTurn(); await nextTurn();
    assert.deepEqual(unhandled, []);
  });
});

test('exact synchronous true is observed before verification; later false blocks its assessment', async t => {
  let available = true, f!: Fixture;
  const calls = { count: 0 }, events: string[] = [];
  const verify = evidenceVerifier(() => f, calls);
  f = fixture(t, { verifiers: [{ action: 'verify-code',
    available: () => { events.push('available'); return available; },
    verify: (input: Readonly<WorkflowVerificationRequest>) => {
      assert.equal(available, true);
      assert.equal(events.at(-1), 'available'); events.push('verify'); return verify(input);
    },
  }] });
  const id = ready(f);
  assert.equal(assessment(f, id).disposition, 'verify');
  events.length = 0;
  const result = await f.service.verify({ workflowId: id, stepKey: 'verification', idempotencyKey: f.next() });
  assert.equal(result.result, 'submitted'); assert.equal(calls.count, 1);
  assert.deepEqual(result.workflow.attempts.map(a => a.state), ['submitted']);
  assert.equal(result.workflow.taskStates.verification, 'needs_review');
  assert.equal(assessment(f, id).disposition, 'needs_review');
  available = false;
  await denied(f, id, calls, 1, 1);
  const prepared = f.service.prepareReview(id, 'verification', 'approved');
  assert.throws(() => f.service.review({ workflowId: id, stepKey: 'verification', idempotencyKey: f.next(),
    decision: 'approved', receiptHash: f.issue(prepared) }), errorCode('WORKFLOW_BLOCKED'));
});

test('invalidation after a busy verifier prevents an otherwise permitted second attempt', async t => {
  let available = true;
  const calls = { count: 0 };
  const f = fixture(t, { verifiers: [{ action: 'verify-code', available: () => available,
    verify: () => { calls.count++; return { status: 'evidence-read-busy' }; } }] });
  const id = ready(f);
  assert.equal((await f.service.verify({ workflowId: id, stepKey: 'verification', idempotencyKey: f.next() })).result, 'busy');
  assert.equal(assessment(f, id).disposition, 'verify');
  available = false;
  await denied(f, id, calls, 1, 1);
});

test('policyContext local.code.verify cannot override a false registered observer', async t => {
  const calls = { count: 0 }; let f!: Fixture;
  f = fixture(t, {
    policyContext: () => ({ connections: [connection()], capabilities: [
      { id: 'local.patch', state: 'available', safety: 'human-handoff' },
      { id: 'local.code.verify', state: 'available', safety: 'read-only-deterministic' },
    ] }),
    verifiers: [{ action: 'verify-code', available: () => false, verify: evidenceVerifier(() => f, calls) }],
  });
  await denied(f, ready(f), calls);
});

test('a fixed trusted verifier without an availability observer remains backward compatible', async t => {
  const calls = { count: 0 }; let f!: Fixture;
  f = fixture(t, { verifiers: [{ action: 'verify-code', verify: evidenceVerifier(() => f, calls) }] });
  const id = ready(f);
  assert.equal(assessment(f, id).disposition, 'verify');
  const input = { workflowId: id, stepKey: 'verification', idempotencyKey: f.next() };
  const result = await f.service.verify(input);
  assert.equal(result.result, 'submitted'); assert.equal(calls.count, 1);
  assert.equal(result.workflow.attempts.length, 1);
  assert.equal(result.workflow.taskStates.verification, 'needs_review');
  await f.service.verify(input); assert.equal(calls.count, 1);
});

test('nonfunction available values are rejected at registration', async t => {
  const values: Array<[string, unknown]> = [
    ['true', true], ['false', false], ['number', 1], ['string', 'available'],
    ['object', {}], ['null', null], ['promise', Promise.resolve(true)],
  ];
  for (const [label, available] of values) await t.test(label, t => {
    const registration = { action: 'verify-code', available, verify: () => ({ status: 'unsupported' }) } as unknown as WorkflowVerifier;
    assert.throws(() => fixture(t, { verifiers: [registration] }), errorCode('WORKFLOW_INPUT'));
  });
});

test('mutating a registration after construction cannot replace captured available or verify callbacks', async t => {
  let available = false, replacedAvailabilityCalls = 0, replacedVerifyCalls = 0, f!: Fixture;
  const calls = { count: 0 };
  const registration: WorkflowVerifier = {
    action: 'verify-code', available: () => available, verify: evidenceVerifier(() => f, calls),
  };
  f = fixture(t, { verifiers: [registration] });
  registration.available = () => { replacedAvailabilityCalls++; return true; };
  registration.verify = () => { replacedVerifyCalls++; return { status: 'unsupported' }; };
  const id = ready(f);
  await denied(f, id, calls);
  available = true;
  assert.equal(assessment(f, id).disposition, 'verify');
  const result = await f.service.verify({ workflowId: id, stepKey: 'verification', idempotencyKey: f.next() });
  assert.equal(result.result, 'submitted'); assert.equal(calls.count, 1);
  assert.equal(replacedAvailabilityCalls, 0); assert.equal(replacedVerifyCalls, 0);
  available = false;
  await denied(f, id, calls, 1, 1);
});
test('shutdown drain waits for exactly the owned verifier and synchronous busy refusal retains the journal', async t => {
  let release: () => void = () => {}, entered: () => void = () => {};
  const started = new Promise<void>(done => { entered = done; });
  const held = new Promise<void>(done => { release = done; });
  const f = fixture(t, { verifiers: [{ action: 'verify-code', available: () => true,
    verify: async () => { entered(); await held; return { status: 'unsupported' }; } }] });
  const id = ready(f);
  await f.service.waitForIdle();
  const operation = f.service.verify({ workflowId: id, stepKey: 'verification', idempotencyKey: f.next() });
  await started;
  let settled = false; const first = f.service.waitForIdle(), second = f.service.waitForIdle();
  assert.equal(first, second);
  void first.then(() => { settled = true; });
  await nextTurn(); assert.equal(settled, false);
  assert.throws(() => f.service.close(), errorCode('WORKFLOW_BUSY'));
  release(); const result = await operation; await first;
  assert.equal(settled, true); assert.equal(result.result, 'unsupported');
  assert.equal(f.service.get(id).workflow.attempts.length, 1, 'Busy-close did not discard the owned journal');
  f.service.close(); assert.equal(f.work.runs().length, 1, 'Borrowed WorkStore is still usable');
});
