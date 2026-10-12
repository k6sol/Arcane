import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { Connection } from '../../packages/protocol/src/providers.js';
import type { StudioSession } from '../../packages/protocol/src/studio.js';
import {
  WORKFLOW_LIMITS, WORKFLOW_POLICY, createWorkflowRecipe, validateWorkflowGraph,
  toWorkStoreInput, assessWorkflow, evaluateWorkflowEvidence, workflowGateBinding,
  workflowSubjectDigest, canRetryWorkflowStep,
  type WorkflowRecipe, type WorkflowRecipeRequest, type WorkflowContext,
  type WorkflowStep, type WorkflowSubmission, type HumanDecisionCommand,
  type LearningFeedbackReference,
} from '../../packages/core/src/workflow-recipes.js';

// Entirely synthetic manifests and catalogues: no filesystem, provider or Studio execution.
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const selected = { provider: 'codex', model: 'fixture-model', effort: 'high', connectionRevision: 'fixture-revision' } as const;
const target = { sessionId: 'fixture-studio', placeId: 123, universeId: 456, roots: ['ServerScriptService'], method: 'script.update' } as const;
function request(overrides: Partial<WorkflowRecipeRequest> = {}): WorkflowRecipeRequest {
  return { deliverable: 'code-change', engine: 'roblox', title: 'Repair authoritative pickup',
    prompt: 'Produce a reviewed scoped pickup patch with regression evidence.',
    scope: ['src/pickup'], model: selected, ...overrides };
}
function connection(): Connection {
  return { provider: 'codex', installed: true, version: 'fixture', auth: 'subscription', plan: null,
    models: [{ id: selected.model, label: 'Fixture', efforts: ['high'], defaultEffort: 'high', source: 'runtime-catalogue', entitlement: 'unverified', inputModalities: ['text', 'image'] }],
    features: [{ id: 'coding', label: 'Fixture native handoff', state: 'native-handoff', route: 'native-client', reason: 'Synthetic offline observation.' }],
    warnings: ['RAW-AUTH-DUMMY-MUST-NOT-LEAK'], observedAt: '2026-10-12T00:00:00.000Z', revision: selected.connectionRevision };
}
function session(): StudioSession {
  return { id: target.sessionId, clientSessionId: 'fixture-client', placeId: target.placeId, universeId: target.universeId,
    name: 'Synthetic fixture', pluginVersion: 'fixture', protocolVersion: 1,
    allowedRoots: ['ServerScriptService'], allowWrites: true, capabilities: ['script.update', 'playtest'],
    connectedAt: '2026-10-12T00:00:00.000Z', lastSeenAt: '2026-10-12T00:00:00.000Z', revokedAt: null };
}
function step(recipe: WorkflowRecipe, key: string): WorkflowStep {
  const result = recipe.steps.find(s => s.key === key); assert.ok(result); return result;
}
function subjects(s: WorkflowStep, submissions: WorkflowSubmission[]): string[] {
  return [...new Set(s.subjectSteps.flatMap(key => submissions.find(e => e.key === key)?.artifacts.map(a => a.sha256) ?? []))].sort();
}
function receipt(command: Omit<HumanDecisionCommand, 'receiptHash'>): string {
  return hash([command.workflowId, command.stepKey, command.gate, command.decision, command.binding].join(':'));
}
/** Test-only trusted human seam with deterministic synthetic receipts; never a production verifier. */
function human(command: Readonly<HumanDecisionCommand>): boolean {
  assert.ok(Object.isFrozen(command));
  return command.receiptHash === receipt(command);
}
function context(recipe: WorkflowRecipe): WorkflowContext {
  const submissions: WorkflowSubmission[] = [];
  for (const s of recipe.steps) {
    const subjectHashes = subjects(s, submissions);
    const artifacts = s.quality.roles.map(role => ({ path: 'fixtures/' + s.key + '/' + role + '.txt', sha256: hash(s.key + ':' + role), bytes: 128, role }));
    const report = artifacts.find(a => a.role === 'report');
    submissions.push({ key: s.key, artifacts, subjectHashes,
      checks: s.quality.checks.map(c => ({ id: c.id, outcome: 'pass', evidenceSha256: report!.sha256,
        subjectDigest: workflowSubjectDigest(subjectHashes), ...(c.limit === null ? {} : { value: c.limit }) })) });
  }
  const decisions = recipe.steps.flatMap(s => s.gates.map(gate => {
    const command = { workflowId: recipe.id, stepKey: s.key, gate, decision: 'approved' as const,
      binding: workflowGateBinding(recipe, s.key, gate, subjects(s, submissions)) };
    return { stepKey: s.key, gate, decision: command.decision, binding: command.binding, receiptHash: receipt(command) };
  }));
  const capabilityIds = [...new Set(recipe.steps.flatMap(s => s.capabilities))];
  return { connections: [connection()], studioSessions: [session()], submissions, decisions, authorizeHuman: human,
    tasks: recipe.steps.map(s => ({ key: s.key, state: 'complete' })),
    capabilities: capabilityIds.map(id => ({ id, state: 'available', safety: id.endsWith('.verify') ? 'read-only-deterministic' : 'human-handoff' })) };
}
function result(recipe: WorkflowRecipe, ctx: WorkflowContext, key: string) {
  const found = assessWorkflow(recipe, ctx).steps.find(s => s.key === key); assert.ok(found); return found;
}

test('three production deliverables create deterministic WorkStore-compatible DAGs', () => {
  const recipes = [createWorkflowRecipe(request()),
    createWorkflowRecipe(request({ deliverable: 'production-asset', engine: 'blender', scope: ['art/props'] })),
    createWorkflowRecipe(request({ deliverable: 'playtest-repair', studio: { ...target, roots: [...target.roots] } }))];
  for (const recipe of recipes) {
    const order = validateWorkflowGraph(recipe.steps);
    assert.equal(new Set(order).size, recipe.steps.length);
    for (const s of recipe.steps) for (const dependency of s.dependencies) assert.ok(order.indexOf(dependency) < order.indexOf(s.key));
    assert.deepEqual([...new Set(recipe.steps.map(s => s.stage))], ['prompt', 'requirements', 'plan', 'implementation', 'verification', 'review']);
    const projected = toWorkStoreInput(recipe);
    assert.equal(projected.tasks.length, recipe.steps.length);
    assert.ok(projected.tasks.every(t => t.scope.length > 0 && t.acceptance.includes('Unsupported work stays pending')));
    assert.ok(projected.tasks.every(t => !Object.hasOwn(t, 'state') && !Object.hasOwn(t, 'worker')));
    assert.ok(recipe.steps.length <= WORKFLOW_LIMITS.steps);
    assert.equal(result(recipe, context(recipe), 'review').state, 'complete');
  }
  const a = request({ scope: ['src/z', 'src/a', 'src/z'], verificationAttempts: 2 });
  const b = request({ scope: ['src/a', 'src/z'] });
  assert.deepEqual(createWorkflowRecipe(a), createWorkflowRecipe(b));
  assert.notEqual(createWorkflowRecipe(a).id, createWorkflowRecipe({ ...a, prompt: 'Changed deliverable requirements.' }).id);
  assert.deepEqual(WORKFLOW_POLICY, recipes[0]!.policy);
  assert.equal(recipes[0]!.policy.trainWeights, false);
  assert.equal(recipes[0]!.policy.autoEditStudio, false);
});

test('graph rejects cycles, missing and duplicate keys, unsafe subjects and weakened gates', () => {
  const recipe = createWorkflowRecipe(request());
  const cycle = structuredClone(recipe.steps); cycle[0]!.dependencies = ['review'];
  assert.throws(() => validateWorkflowGraph(cycle), /cycle/);
  const missing = structuredClone(recipe.steps); missing[1]!.dependencies = ['missing'];
  assert.throws(() => validateWorkflowGraph(missing), /missing/);
  assert.throws(() => validateWorkflowGraph([...recipe.steps, recipe.steps[0]!]), /Duplicate/);
  const subject = structuredClone(recipe.steps); subject[0]!.subjectSteps = ['review'];
  assert.throws(() => validateWorkflowGraph(subject), /ancestors/);
  const gates = structuredClone(recipe.steps); gates.find(s => s.key === 'implementation')!.gates = [];
  assert.throws(() => validateWorkflowGraph(gates), /human gates/);
  const changed = structuredClone(recipe); changed.title = 'Modified after approval';
  assert.throws(() => toWorkStoreInput(changed), /construct a new recipe/);
});

test('unsupported capabilities and even complete snapshots stay pending without exact support', () => {
  const recipe = createWorkflowRecipe(request());
  const initial = assessWorkflow(recipe);
  assert.ok(initial.steps.every(s => s.state === 'pending'));
  assert.equal(initial.steps.find(s => s.key === 'prompt')!.disposition, 'human-handoff');
  const ctx = context(recipe);
  ctx.capabilities = ctx.capabilities!.map(c => c.id === 'local.patch' ? { ...c, state: 'unsupported' } : c);
  assert.ok(result(recipe, ctx, 'implementation').blockers.some(b => b.code === 'capability'));
  assert.equal(result(recipe, ctx, 'implementation').state, 'pending');
  assert.equal(result(recipe, ctx, 'review').state, 'pending');
  ctx.capabilities = context(recipe).capabilities!.map(c => c.id === 'local.code.verify' ? { ...c, safety: 'human-handoff' } : c);
  assert.equal(result(recipe, ctx, 'verification').state, 'pending');
});

test('provider gates require exact revision/model/effort/modality/feature/route/subscription', () => {
  const recipe = createWorkflowRecipe(request());
  const variants: Connection[] = [
    { ...connection(), installed: false }, { ...connection(), revision: 'stale' },
    { ...connection(), auth: 'api-or-cloud' }, { ...connection(), auth: 'signed-out' }, { ...connection(), auth: 'unknown' },
    { ...connection(), models: [] }, { ...connection(), models: [{ ...connection().models[0]!, efforts: ['low'] }] },
    { ...connection(), features: [{ ...connection().features[0]!, route: 'future-adapter' }] },
    { ...connection(), features: [{ ...connection().features[0]!, state: 'unsupported' }] },
    { ...connection(), features: [{ ...connection().features[0]!, state: 'unverified' }] },
    { ...connection(), models: [{ ...connection().models[0]!, inputModalities: [] }] },
  ];
  for (const c of variants) {
    const assessed = result(recipe, { ...context(recipe), connections: [c] }, 'requirements');
    assert.equal(assessed.state, 'pending'); assert.ok(assessed.blockers.some(b => b.code === 'provider'));
  }
  const duplicate = result(recipe, { ...context(recipe), connections: [connection(), connection()] }, 'requirements');
  assert.ok(duplicate.blockers.some(b => b.requirement === 'exact-provider'));
  const noSelection = createWorkflowRecipe(request({ model: null }));
  assert.ok(result(noSelection, context(noSelection), 'requirements').blockers.some(b => b.requirement === 'exact-selection'));
  const asset = createWorkflowRecipe(request({ deliverable: 'production-asset', engine: 'blender' }));
  const textOnly = { ...connection(), models: [{ ...connection().models[0]!, inputModalities: ['text'] }] };
  assert.ok(result(asset, { ...context(asset), connections: [textOnly] }, 'review_analysis').blockers.some(b => b.requirement === 'input-modality:image'));
  assert.ok(recipe.steps.filter(s => s.provider).every(s => s.gates.includes('model-handoff') && s.retry.maxAttempts === 1));
});

test('human approvals default deny and bind exact current input artifacts before execution', () => {
  const recipe = createWorkflowRecipe(request()), ctx = context(recipe);
  const { authorizeHuman: _human, ...withoutHuman } = ctx;
  assert.equal(result(recipe, withoutHuman, 'requirements').state, 'pending');
  assert.equal(result(recipe, { ...ctx, authorizeHuman: () => { throw new Error('PRIVATE-PROOF'); } }, 'requirements').state, 'pending');
  assert.equal(result(recipe, { ...ctx, authorizeHuman: (() => 'yes') as unknown as NonNullable<WorkflowContext['authorizeHuman']> }, 'requirements').state, 'pending');
  const rejected = structuredClone(ctx.decisions!);
  const d = rejected.find(d => d.stepKey === 'plan_acceptance')!; d.decision = 'rejected';
  d.receiptHash = receipt({ ...d, workflowId: recipe.id });
  assert.equal(result(recipe, { ...ctx, decisions: rejected }, 'plan_acceptance').state, 'pending');
  const stale = structuredClone(ctx.submissions!); stale.find(s => s.key === 'prompt')!.artifacts[0]!.sha256 = hash('changed-brief');
  assert.ok(result(recipe, { ...ctx, submissions: stale }, 'requirements').blockers.some(b => b.code === 'human'));
  const prospective: WorkflowContext = {
    ...ctx, tasks: [{ key: 'prompt', state: 'complete' }, { key: 'requirements', state: 'pending' }],
    submissions: ctx.submissions!.filter(s => s.key === 'prompt'),
  };
  assert.equal(result(recipe, prospective, 'requirements').disposition, 'human-handoff');
  const captured = assessWorkflow(recipe, ctx).audit.filter(a => a.kind === 'human-decision');
  assert.equal(captured.length, ctx.decisions!.length);
  assert.ok(captured.every(a => /^[a-f0-9]{64}$/.test(a.referenceHash)));
});

test('Studio requires exact live writable pairing, roots, method and human patch/playtest decisions', () => {
  const recipe = createWorkflowRecipe(request({ deliverable: 'playtest-repair', studio: { ...target, roots: [...target.roots] } }));
  const ctx = context(recipe);
  for (const s of [
    { ...session(), allowWrites: false }, { ...session(), revokedAt: '2026-10-12T01:00:00.000Z' },
    { ...session(), placeId: 999 }, { ...session(), universeId: 999 }, { ...session(), allowedRoots: [] },
    { ...session(), capabilities: [] },
  ]) assert.ok(result(recipe, { ...ctx, studioSessions: [s] }, 'studio_patch').blockers.some(b => b.code === 'studio'));
  assert.ok(result(recipe, { ...ctx, decisions: ctx.decisions!.filter(d => d.gate !== 'studio-write') }, 'studio_patch').blockers.some(b => b.requirement === 'studio-write'));
  assert.ok(result(recipe, { ...ctx, decisions: ctx.decisions!.filter(d => d.gate !== 'studio-playtest') }, 'playtest').blockers.some(b => b.requirement === 'studio-playtest'));
  // Current Arcane bridge advertises script.update but has no playtest method.
  const bridge = { ...session(), capabilities: ['script.update'] };
  assert.equal(result(recipe, { ...ctx, studioSessions: [bridge] }, 'studio_patch').state, 'complete');
  assert.ok(result(recipe, { ...ctx, studioSessions: [bridge] }, 'playtest').blockers.some(b => b.requirement === 'session-method:playtest'));
  assert.equal(result(recipe, { ...ctx, studioSessions: [bridge] }, 'review').state, 'pending');
  const noTarget = createWorkflowRecipe(request({ deliverable: 'playtest-repair' }));
  assert.ok(result(noTarget, context(noTarget), 'studio_patch').blockers.some(b => b.requirement === 'exact-place-session-target'));
  assert.ok(recipe.steps.filter(s => s.studio).every(s => s.retry.maxAttempts === 1));
});

test('quality requires actual roles, hashed reports, finite measurements and current subjects', () => {
  const recipe = createWorkflowRecipe(request({ deliverable: 'production-asset', engine: 'blender', assetBudget: { triangles: 2000, materials: 3, textureBytes: 4096 } }));
  const s = step(recipe, 'verification'), ctx = context(recipe);
  const good = ctx.submissions!.find(e => e.key === s.key)!;
  assert.deepEqual(evaluateWorkflowEvidence(s, good, good.subjectHashes), []);
  for (const id of ['triangles', 'materials', 'texture-bytes']) {
    const bad = structuredClone(good); bad.checks.find(c => c.id === id)!.value!++;
    assert.ok(evaluateWorkflowEvidence(s, bad, bad.subjectHashes).includes('check:' + id));
  }
  const missing = { ...good, artifacts: [] };
  assert.ok(evaluateWorkflowEvidence(s, missing, good.subjectHashes).includes('artifact:report'));
  const unrelated = structuredClone(good); unrelated.checks[0]!.evidenceSha256 = hash('unattached-report');
  assert.ok(evaluateWorkflowEvidence(s, unrelated, good.subjectHashes).includes('check:' + unrelated.checks[0]!.id));
  const stale = structuredClone(good); stale.checks[0]!.subjectDigest = hash('old-subjects');
  assert.ok(evaluateWorkflowEvidence(s, stale, good.subjectHashes).length > 0);
  assert.ok(evaluateWorkflowEvidence(s, good, [hash('changed-source')]).includes('current-subject-hashes'));
  for (const outcome of ['unsupported', 'pending', 'fail'] as const) {
    const failed = structuredClone(good); failed.checks[0]!.outcome = outcome;
    assert.ok(evaluateWorkflowEvidence(s, failed, good.subjectHashes).length > 0);
  }
  const notFinite = structuredClone(good); notFinite.checks[0]!.value = Number.NaN;
  assert.throws(() => evaluateWorkflowEvidence(s, notFinite, good.subjectHashes), /quality value/);
  assert.throws(() => evaluateWorkflowEvidence(s, { ...good, artifacts: [...good.artifacts, ...good.artifacts] }, good.subjectHashes), /distinct/);
  assert.equal(result(recipe, { ...ctx, decisions: ctx.decisions!.filter(d => d.gate !== 'preview-acceptance') }, 'preview_acceptance').state, 'pending');
  assert.equal(result(recipe, { ...ctx, decisions: ctx.decisions!.filter(d => d.gate !== 'final-review') }, 'review').state, 'pending');
});

test('playtest verification enforces repeated original scenario and zero unexpected errors', () => {
  const recipe = createWorkflowRecipe(request({ deliverable: 'playtest-repair', reproductionRuns: 4, studio: { ...target, roots: [...target.roots] } }));
  const s = step(recipe, 'playtest_verification'), ctx = context(recipe);
  const evidence = ctx.submissions!.find(e => e.key === s.key)!;
  const tooFew = structuredClone(evidence); tooFew.checks.find(c => c.id === 'reproduction-runs')!.value = 3;
  assert.ok(evaluateWorkflowEvidence(s, tooFew, evidence.subjectHashes).includes('check:reproduction-runs'));
  const errors = structuredClone(evidence); errors.checks.find(c => c.id === 'unexpected-errors')!.value = 1;
  assert.ok(evaluateWorkflowEvidence(s, errors, evidence.subjectHashes).includes('check:unexpected-errors'));
  assert.equal(step(recipe, 'prompt').quality.roles.includes('reproduction'), true);
});

test('readiness does not infer completion, repeat owned work, or reconcile interruptions', () => {
  const recipe = createWorkflowRecipe(request()), ctx = context(recipe);
  const unsubmitted = { ...ctx, submissions: ctx.submissions!.filter(s => s.key !== 'verification') };
  assert.ok(result(recipe, unsubmitted, 'verification').blockers.some(b => b.requirement === 'submission'));
  for (const state of ['in_progress', 'interrupted', 'needs_review', 'failed', 'pending'] as const) {
    const tasks = ctx.tasks!.map(t => t.key === 'verification' ? { ...t, state } : t);
    const assessed = result(recipe, { ...ctx, tasks }, 'verification');
    assert.notEqual(assessed.state, 'complete');
    if (state === 'interrupted') assert.ok(assessed.blockers.some(b => b.requirement === 'human-reconciliation'));
    if (state === 'pending') assert.equal(assessed.disposition, 'verify');
    if (state === 'needs_review') assert.equal(assessed.state, 'needs_review');
    assert.notEqual(result(recipe, { ...ctx, tasks }, 'review').state, 'complete');
  }
});

test('retry policy is bounded to transient safe reads of unchanged evidence', () => {
  const recipe = createWorkflowRecipe(request({ verificationAttempts: 3 }));
  const same = hash('unchanged-evidence');
  const attempt = { attempts: 1, reason: 'evidence-read-busy', previousSubjectDigest: same, subjectDigest: same };
  for (const s of recipe.steps) assert.equal(canRetryWorkflowStep(s, attempt), s.execution === 'local-verification');
  const verifier = step(recipe, 'verification');
  assert.equal(canRetryWorkflowStep(verifier, { ...attempt, attempts: 2 }), true);
  assert.equal(canRetryWorkflowStep(verifier, { ...attempt, attempts: 3 }), false);
  for (const reason of ['check-failed', 'unsupported', 'interrupted', 'model-timeout', 'studio-timeout']) assert.equal(canRetryWorkflowStep(verifier, { ...attempt, reason }), false);
  assert.equal(canRetryWorkflowStep(verifier, { ...attempt, subjectDigest: hash('changed') }), false);
  const forged = structuredClone(recipe.steps); forged.find(s => s.key === 'implementation')!.retry.maxAttempts = 3;
  assert.throws(() => validateWorkflowGraph(forged), /safe deterministic/);
  assert.throws(() => canRetryWorkflowStep(verifier, { ...attempt, attempts: 0 }), /bound/);
});

test('hard bounds reject oversized input, evidence, graph, budget, snapshots and retry settings', () => {
  for (const verificationAttempts of [0, 4, 1.5, Infinity]) assert.throws(() => createWorkflowRecipe(request({ verificationAttempts })), /bound/);
  assert.throws(() => createWorkflowRecipe(request({ prompt: 'x'.repeat(8001) })), /bounded/);
  assert.throws(() => createWorkflowRecipe(request({ scope: Array.from({ length: 21 }, (_, i) => 'src/' + i) })), /bound/);
  assert.throws(() => createWorkflowRecipe(request({ deliverable: 'production-asset', assetBudget: { triangles: 0, materials: 3, textureBytes: 4096 } })), /bound/);
  assert.throws(() => createWorkflowRecipe(request({ deliverable: 'playtest-repair', reproductionRuns: 11 })), /bound/);
  assert.throws(() => createWorkflowRecipe(request({ deliverable: 'playtest-repair', engine: 'blender' })), /Roblox/);
  assert.throws(() => createWorkflowRecipe(request({ assetBudget: { triangles: 1, materials: 1, textureBytes: 1 } })), /Asset budgets/);
  const recipe = createWorkflowRecipe(request()), ctx = context(recipe);
  const evidence = structuredClone(ctx.submissions!.find(e => e.key === 'verification')!);
  evidence.artifacts[0]!.bytes = WORKFLOW_LIMITS.artifactBytes + 1;
  assert.throws(() => evaluateWorkflowEvidence(step(recipe, evidence.key), evidence, evidence.subjectHashes), /bound/);
  evidence.artifacts[0]!.bytes = 0;
  assert.throws(() => evaluateWorkflowEvidence(step(recipe, evidence.key), evidence, evidence.subjectHashes), /bound/);
  assert.throws(() => validateWorkflowGraph(Array.from({ length: 25 }, () => recipe.steps[0]!)), /step bound/);
  assert.throws(() => validateWorkflowGraph(Array.from({ length: 24 }, (_, i) => ({ ...step(recipe, 'verification'), key: 'verify_' + i, dependencies: [], subjectSteps: [], retry: { maxAttempts: 3, reason: 'evidence-read-busy' as const } }))), /total attempt/);
  assert.throws(() => assessWorkflow(recipe, { ...ctx, submissions: [...ctx.submissions!, ctx.submissions![0]!] }), /Duplicate/);
  assert.throws(() => assessWorkflow(recipe, { tasks: [{ key: 'missing', state: 'complete' }] }), /unknown/);
});

test('secret-like content is rejected without echoing it, while raw provider data never enters audits', () => {
  const secrets = ['sk-proj-' + 'a'.repeat(24), 'Bearer ' + 'a'.repeat(24), 'password=fixture-secret',
    'https://example.test/?token=fixture-secret', '-----BEGIN PRIVATE KEY-----'];
  for (const secret of secrets) for (const changed of [
    request({ prompt: secret }), request({ title: secret }), request({ scope: [secret] }),
    request({ model: { ...selected, model: secret } }),
  ]) assert.throws(() => createWorkflowRecipe(changed), error => {
    assert.ok(error instanceof Error); assert.ok(!error.message.includes(secret)); return true;
  });
  for (const scope of ['../secrets', '.env', '.env.local', '.git/hooks', '.aws/keys', '.ssh/id_rsa', 'C:/outside', '/outside', 'src/../../outside', 'src/NUL.txt']) assert.throws(() => createWorkflowRecipe(request({ scope: [scope] })), /relative workflow path/);
  assert.throws(() => createWorkflowRecipe({ ...request(), authorization: 'RAW-SECRET' } as WorkflowRecipeRequest), /Unexpected/);
  const recipe = createWorkflowRecipe(request()), assessed = assessWorkflow(recipe, context(recipe));
  const encoded = JSON.stringify({ recipe, assessed });
  assert.ok(!encoded.includes('RAW-AUTH-DUMMY-MUST-NOT-LEAK'));
  assert.ok(assessed.audit.every(e => /^[a-f0-9]{64}$/.test(e.referenceHash)));
});

test('learning audit retains references only after trusted current human approval and consent', () => {
  const recipe = createWorkflowRecipe(request()), ctx = context(recipe);
  const reference: LearningFeedbackReference = { projectId: hash('project'), recordId: hash('record'), reviewReceiptHash: hash('review-receipt'), evidenceHashes: [hash('human-evidence')] };
  const withFeedback: WorkflowContext = { ...ctx, feedback: { projectId: reference.projectId, optIn: true, references: [reference] } };
  assert.deepEqual(assessWorkflow(recipe, withFeedback).learning.references, []);
  const approved = { ...withFeedback, authorizeLearningReference: (r: Readonly<LearningFeedbackReference>) => {
    assert.ok(Object.isFrozen(r)); assert.ok(Object.isFrozen(r.evidenceHashes));
    return r.reviewReceiptHash === reference.reviewReceiptHash && r.recordId === reference.recordId;
  } };
  const out = assessWorkflow(recipe, approved);
  assert.deepEqual(out.learning.references, [reference]);
  assert.equal(out.learning.mode, 'context learning not weights');
  assert.equal(out.learning.authority, 'untrusted_supplemental_hints');
  assert.equal(out.audit.filter(e => e.kind === 'learning-reference').length, 1);
  assert.ok(!JSON.stringify(out).includes('hintText'));
  assert.deepEqual(assessWorkflow(recipe, { ...approved, feedback: { ...withFeedback.feedback!, optIn: false } }).learning.references, []);
  assert.deepEqual(assessWorkflow(recipe, { ...approved, feedback: { ...withFeedback.feedback!, projectId: hash('other-project') } }).learning.references, []);
  assert.deepEqual(assessWorkflow(recipe, { ...approved, authorizeLearningReference: () => { throw new Error('PRIVATE-HUMAN-PROOF'); } }).learning.references, []);
  assert.throws(() => assessWorkflow(recipe, { ...approved, feedback: { ...withFeedback.feedback!, references: [{ ...reference, hintText: 'RAW-SECRET' } as LearningFeedbackReference] } }), /Unexpected/);
  assert.throws(() => assessWorkflow(recipe, { ...approved, feedback: { ...withFeedback.feedback!, references: Array.from({ length: 9 }, () => reference) } }), /bound/);
});

test('assessment and audit are deterministic under reordered observations and do not mutate inputs', () => {
  const recipe = createWorkflowRecipe(request()), ctx = context(recipe);
  const beforeRecipe = JSON.stringify(recipe), beforeContext = JSON.stringify(ctx);
  const a = assessWorkflow(recipe, ctx);
  const b = assessWorkflow(recipe, { ...ctx, tasks: [...ctx.tasks!].reverse(), submissions: [...ctx.submissions!].reverse().map(s => ({ ...s, artifacts: [...s.artifacts].reverse(), checks: [...s.checks].reverse(), subjectHashes: [...s.subjectHashes].reverse() })), decisions: [...ctx.decisions!].reverse(), capabilities: [...ctx.capabilities!].reverse() });
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(recipe), beforeRecipe); assert.equal(JSON.stringify(ctx), beforeContext);
  const projection = toWorkStoreInput(recipe); projection.tasks[0]!.scope.push('other/file');
  assert.equal(JSON.stringify(recipe), beforeRecipe);
});
