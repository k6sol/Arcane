import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { ArcaneError } from '../../../packages/protocol/src/providers.js';
import {
  WORKFLOW_LIMITS, assessWorkflow, canRetryWorkflowStep, createWorkflowRecipe,
  evaluateWorkflowEvidence, toWorkStoreInput, workflowGateBinding, workflowSubjectDigest,
  type HumanDecision, type HumanDecisionCommand, type HumanGate, type WorkflowAssessment,
  type WorkflowContext, type WorkflowRecipe, type WorkflowRecipeRequest,
  type WorkflowStep, type WorkflowSubmission, type WorkflowArtifact,
} from '../../../packages/core/src/workflow-recipes.js';
import { WorkStore, type WorkTask } from '../../../packages/storage/src/work-store.js';
import {
  WorkflowStore, workflowProjectIdentity,
  type StoredWorkflow, type WorkflowCommand, type WorkflowCommandKind, type WorkflowOperation,
} from '../../../packages/storage/src/workflow-store.js';

export type SafeWorkflowAction = 'verify-code' | 'verify-asset' | 'verify-playtest';
export interface PinnedWorkflowArtifact extends WorkflowArtifact { stepKey: string }
export interface WorkflowHumanRequest {
  kind: Exclude<WorkflowCommandKind, 'verify'>; projectId: string; workflowId: string | null;
  recipe: WorkflowRecipe; stepKey: string | null; decision: 'approved' | 'rejected'; binding: string;
  subjectHashes: string[]; inputArtifacts: PinnedWorkflowArtifact[];
  submission: WorkflowSubmission | null; operation: WorkflowOperation | null;
  recipeGate: Omit<HumanDecisionCommand, 'receiptHash'> | null;
}
export interface WorkflowHumanCommand extends Omit<WorkflowHumanRequest, 'recipeGate'> {
  receiptHash: string; recipeGate: HumanDecisionCommand | null;
}
export interface WorkflowVerificationRequest {
  projectId: string; projectPath: string; workflowId: string; recipeId: string;
  step: WorkflowStep; subjectDigest: string; inputArtifacts: PinnedWorkflowArtifact[];
}
export type WorkflowVerificationResult =
  | { status: 'evidence'; submission: WorkflowSubmission }
  | { status: 'evidence-read-busy' }
  | { status: 'unsupported' };
export interface WorkflowVerifier {
  action: SafeWorkflowAction;
  /** Fixed host function: read-only and deterministic. Never build commands from workflow text. */
  verify: (request: Readonly<WorkflowVerificationRequest>) => Promise<WorkflowVerificationResult> | WorkflowVerificationResult;
}
export interface WorkflowServiceOptions {
  directory: string; projectPath: string;
  /** Borrowing avoids reopening WorkStore (which interrupts workers). The host attests its project root. */
  workStore?: { store: WorkStore; projectPath: string };
  /** Host-only receipt validation. Missing, throwing, async or truthy non-boolean answers deny. */
  authorizeHuman?: (command: Readonly<WorkflowHumanCommand>) => boolean;
  /** Trusted current observations; never accept this context from route JSON. */
  policyContext?: () => Pick<WorkflowContext, 'connections' | 'studioSessions' | 'capabilities'>;
  verifiers?: readonly WorkflowVerifier[];
  now?: () => number;
}
export interface WorkflowSnapshot {
  workflow: StoredWorkflow; tasks: WorkTask[]; assessment: WorkflowAssessment | null;
}
export interface WorkflowCommandResult extends WorkflowSnapshot { result: WorkflowCommand['result'] }
const CAPABILITY: Record<SafeWorkflowAction, string> = {
  'verify-code': 'local.code.verify', 'verify-asset': 'blender.verify', 'verify-playtest': 'local.playtest.verify',
};
const HASH = /^[a-f0-9]{64}$/;
function fail(code: string, message: string): never { throw new ArcaneError(code, message); }
function object(input: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('WORKFLOW_INPUT', 'Expected a workflow command.');
  const a = input as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(a, key)) || Object.keys(a).some(key => !required.includes(key) && !optional.includes(key))) fail('WORKFLOW_INPUT', 'Unexpected or missing command fields.');
  return a;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value)) fail('WORKFLOW_INPUT', 'Expected a bounded opaque identifier.');
  return value;
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || !HASH.test(value)) fail('WORKFLOW_INPUT', 'Expected a lowercase SHA-256 receipt or binding.');
  return value;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
function clone<T>(value: T): T { return structuredClone(value); }

/** Project-bound coordinator. No process, inference, Studio, upload or automatic reviewer exists here. */
export class WorkflowService {
  readonly projectId: string;
  private readonly journal: WorkflowStore;
  private readonly work: WorkStore;
  private readonly ownsWork: boolean;
  private readonly authorize: WorkflowServiceOptions['authorizeHuman'];
  private readonly context: WorkflowServiceOptions['policyContext'];
  private readonly verifiers = new Map<SafeWorkflowAction, WorkflowVerifier['verify']>();
  private busy = false;
  private closed = false;

  constructor(options: WorkflowServiceOptions) {
    const identity = workflowProjectIdentity(options.projectPath);
    this.projectId = identity.projectId;
    this.authorize = options.authorizeHuman; this.context = options.policyContext;
    if (options.verifiers && options.verifiers.length > 3) fail('WORKFLOW_INPUT', 'At most three fixed verifiers may be registered.');
    for (const verifier of options.verifiers ?? []) {
      if (!Object.hasOwn(CAPABILITY, verifier.action) || typeof verifier.verify !== 'function' || this.verifiers.has(verifier.action)) fail('WORKFLOW_INPUT', 'Expected unique host verifier registrations.');
      this.verifiers.set(verifier.action, verifier.verify);
    }
    if (options.workStore && workflowProjectIdentity(options.workStore.projectPath).projectId !== this.projectId) fail('WORKFLOW_PROJECT', 'Borrowed WorkStore must belong to the selected project.');
    this.journal = new WorkflowStore({ directory: options.directory, projectPath: options.projectPath });
    this.ownsWork = !options.workStore;
    try {
      this.work = options.workStore?.store ?? new WorkStore({
        directory: options.directory, projectPath: identity.projectPath,
        ...(options.now ? { now: options.now } : {}),
      });
    } catch (error) { this.journal.close(); throw error; }
  }
  private open(): void { if (this.closed) fail('WORKFLOW_CLOSED', 'Workflow service is closed.'); }
  private exclusive<T>(work: () => T): T {
    this.open();
    if (this.busy) fail('WORKFLOW_BUSY', 'A coordinator operation is already in progress.');
    this.busy = true;
    try { return work(); } finally { this.busy = false; }
  }
  private step(record: StoredWorkflow, key: string): WorkflowStep {
    const step = record.recipe.steps.find(s => s.key === key);
    if (!step) fail('WORKFLOW_INPUT', 'Unknown recipe step.');
    return step;
  }
  private load(id: string, active = true): StoredWorkflow {
    this.open();
    const record = this.journal.get(identifier(id));
    toWorkStoreInput(record.recipe);
    if (workflowProjectIdentity(this.journal.projectPath).projectId !== this.projectId) fail('WORKFLOW_PROJECT', 'Selected project identity changed.');
    if (active && (record.state !== 'active' || record.operation)) fail('WORKFLOW_UNCERTAIN', 'Workflow requires human reconciliation or is halted.');
    return record;
  }
  private scoped(path: string, file: boolean): string {
    const full = resolve(this.journal.projectPath, path);
    const rel = relative(this.journal.projectPath, full);
    if (!rel || rel === '..' || rel.startsWith('..' + sep) || resolve(this.journal.projectPath, rel) !== full) fail('WORKFLOW_EVIDENCE', 'Artifact or scope escapes the project.');
    let current = this.journal.projectPath;
    for (const part of rel.split(sep)) {
      current = join(current, part);
      if (!existsSync(current)) {
        if (file) fail('WORKFLOW_EVIDENCE', 'Pinned evidence is missing.');
        continue;
      }
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1)) fail('WORKFLOW_EVIDENCE', 'Linked artifacts and scopes are forbidden.');
    }
    return full;
  }
  private pin(artifact: WorkflowArtifact): void {
    const full = this.scoped(artifact.path, true);
    const fd = openSync(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.nlink !== 1 || before.size !== artifact.bytes || before.size < 1 || before.size > WORKFLOW_LIMITS.artifactBytes) fail('WORKFLOW_EVIDENCE', 'Pinned evidence size or file type changed.');
      const bounded = Buffer.alloc(artifact.bytes + 1);
      let length = 0;
      while (length < bounded.length) {
        const count = readSync(fd, bounded, length, bounded.length - length, length);
        if (count === 0) break;
        length += count;
      }
      const bytes = bounded.subarray(0, length), after = fstatSync(fd), current = lstatSync(full);
      this.scoped(artifact.path, true);
      if (bytes.length !== artifact.bytes || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256 ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
        current.isSymbolicLink() || current.nlink !== 1 || current.ino !== after.ino || current.dev !== after.dev) fail('WORKFLOW_EVIDENCE', 'Pinned evidence changed.');
    } finally { closeSync(fd); }
  }
  private inputArtifacts(record: StoredWorkflow, step: WorkflowStep): PinnedWorkflowArtifact[] {
    return step.subjectSteps.flatMap(key => record.submissions.find(s => s.key === key)?.artifacts.map(a => ({ ...a, stepKey: key })) ?? [])
      .sort((a, b) => (a.stepKey + ':' + a.path).localeCompare(b.stepKey + ':' + b.path));
  }
  private subjects(record: StoredWorkflow, step: WorkflowStep): string[] {
    return [...new Set(this.inputArtifacts(record, step).map(a => a.sha256))].sort();
  }

  private projection(record: StoredWorkflow): WorkTask[] {
    const input = toWorkStoreInput(record.recipe);
    if (!record.runId || !same(Object.keys(record.taskIds).sort(), input.tasks.map(t => t.key).sort()) ||
      new Set(Object.values(record.taskIds)).size !== input.tasks.length) fail('WORKFLOW_MAPPING', 'Workflow task mapping is incomplete.');
    return input.tasks.map(expected => {
      const task = this.work.task(record.taskIds[expected.key]!);
      if (task.runId !== record.runId || !same({
        key: task.key, title: task.title, instructions: task.instructions, acceptance: task.acceptance,
        dependencies: task.dependencies, scope: task.scope,
      }, expected)) fail('WORKFLOW_MAPPING', 'WorkStore task no longer matches its exact recipe projection.');
      return task;
    });
  }
  private checked(record: StoredWorkflow): WorkTask[] {
    if (record.runId) this.work.ready(record.runId);
    const tasks = this.projection(record);
    for (const task of tasks) {
      if (record.taskStates[task.key] !== task.state) fail('WORKFLOW_MAPPING', 'WorkStore state changed outside the coordinator.');
      const submission = record.submissions.find(s => s.key === task.key);
      const expected = submission?.artifacts.map(a => ({ path: a.path, sha256: a.sha256, bytes: a.bytes })) ?? [];
      const actual = task.evidence.map(a => ({ path: a.path, sha256: a.sha256, bytes: a.bytes }));
      if (!same(expected, actual)) fail('WORKFLOW_MAPPING', 'WorkStore evidence changed outside the coordinator.');
    }
    for (const submission of record.submissions) {
      evaluateWorkflowEvidence(this.step(record, submission.key), submission, this.subjects(record, this.step(record, submission.key)));
      for (const artifact of submission.artifacts) this.pin(artifact);
    }
    return tasks;
  }
  private humanRequest(
    kind: WorkflowHumanRequest['kind'], recipe: WorkflowRecipe, record: StoredWorkflow | null,
    stepKey: string | null, decision: 'approved' | 'rejected', submission: WorkflowSubmission | null = null,
    recipeGate: WorkflowHumanRequest['recipeGate'] = null, operation: WorkflowOperation | null = null,
  ): WorkflowHumanRequest {
    const step = record && stepKey ? this.step(record, stepKey) : null;
    const base = {
      kind, projectId: this.projectId, workflowId: record?.id ?? null, recipe: clone(recipe), stepKey, decision,
      subjectHashes: record && step ? this.subjects(record, step) : [],
      inputArtifacts: record && step ? this.inputArtifacts(record, step) : [],
      submission: clone(submission), recipeGate: clone(recipeGate), operation: clone(operation),
    };
    return freeze({ ...base, binding: hash(base) });
  }
  private authorized(request: WorkflowHumanRequest, receiptHash: string): boolean {
    const command: WorkflowHumanCommand = freeze({
      ...clone(request), receiptHash,
      recipeGate: request.recipeGate ? { ...clone(request.recipeGate), receiptHash } : null,
    });
    try {
      const result: unknown = this.authorize?.(command);
      if (result instanceof Promise) void result.catch(() => undefined);
      return result === true;
    } catch { return false; }
  }
  private requireHuman(request: WorkflowHumanRequest, receiptHash: string): void {
    if (!this.authorized(request, digest(receiptHash))) fail('WORKFLOW_HUMAN_REQUIRED', 'An exact trusted host human receipt is required.');
  }
  private assessment(record: StoredWorkflow, tasks: WorkTask[]): WorkflowAssessment {
    let observed: Pick<WorkflowContext, 'connections' | 'studioSessions' | 'capabilities'>;
    try {
      const current = this.context?.() ?? {};
      object(current, [], ['connections', 'studioSessions', 'capabilities']);
      observed = clone(current);
    } catch { fail('WORKFLOW_CONTEXT', 'Trusted policy observations are unavailable.'); }
    const localIds = Object.values(CAPABILITY);
    const capabilities: NonNullable<WorkflowContext['capabilities']> = [
      ...(observed.capabilities ?? []).filter(c => !localIds.includes(c.id)),
      ...[...this.verifiers.keys()].map(action => ({ id: CAPABILITY[action], state: 'available' as const, safety: 'read-only-deterministic' as const })),
    ];
    return assessWorkflow(record.recipe, {
      ...observed, capabilities, tasks, submissions: record.submissions, decisions: record.decisions,
      authorizeHuman: command => {
        const { receiptHash, ...gate } = command;
        return command.workflowId === record.recipe.id && this.authorized(
          this.humanRequest('recipe-gate', record.recipe, record, command.stepKey, command.decision, null, gate), receiptHash,
        );
      },
    });
  }
  private snapshot(record: StoredWorkflow): WorkflowSnapshot {
    if (record.state !== 'active' || record.operation) {
      return { workflow: record, tasks: record.runId ? this.projection(record) : [], assessment: null };
    }
    const tasks = this.checked(record);
    return { workflow: record, tasks, assessment: this.assessment(record, tasks) };
  }
  get(workflowId: string): WorkflowSnapshot { return this.snapshot(this.load(workflowId, false)); }
  list(): { id: string; recipeId: string; state: StoredWorkflow['state'] }[] {
    this.open();
    return this.journal.list().map(r => ({ id: r.id, recipeId: r.recipe.id, state: r.state }));
  }
  private replay(key: string, requestHash: string): WorkflowCommandResult | undefined {
    const previous = this.journal.command(key, requestHash);
    if (!previous) return undefined;
    if (previous.state !== 'done') fail('WORKFLOW_UNCERTAIN', 'Uncertain or running commands are never replayed.');
    return { ...this.get(previous.workflowId), result: previous.result };
  }
  private begin(
    record: StoredWorkflow, key: string, kind: WorkflowCommandKind, requestHash: string,
    receiptHash: string | null, stepKey: string | null,
    submission: WorkflowSubmission | null = null, approved: boolean | null = null, inserting = false,
  ): WorkflowCommand {
    const command: WorkflowCommand = { key, workflowId: record.id, kind, requestHash, receiptHash, state: 'running', result: null };
    record.operation = { key, kind, stepKey, submission, approved };
    this.journal.begin(record, command, inserting);
    return command;
  }
  private finish(record: StoredWorkflow, command: WorkflowCommand, result: WorkflowCommand['result']): WorkflowCommandResult {
    record.operation = null;
    command.state = 'done'; command.result = result;
    const snapshot = this.snapshot(record); // Validate before committing the terminal journal result.
    this.journal.finish(record, command);
    return { ...snapshot, result };
  }
  private uncertain(record: StoredWorkflow, command: WorkflowCommand): never {
    this.journal.interrupt(record.id, command.key);
    fail('WORKFLOW_UNCERTAIN', 'Operation outcome is uncertain. Human reconciliation is required; nothing is replayed.');
  }
  prepareCreation(request: WorkflowRecipeRequest): WorkflowHumanRequest {
    this.open();
    return this.humanRequest('create-recipe', createWorkflowRecipe(request), null, null, 'approved');
  }
  create(input: unknown): WorkflowCommandResult {
    return this.exclusive(() => {
      const a = object(input, ['request', 'idempotencyKey', 'receiptHash']);
      const key = identifier(a.idempotencyKey), receiptHash = digest(a.receiptHash);
      const prepared = this.prepareCreation(a.request as WorkflowRecipeRequest);
      const requestHash = hash({ kind: 'create-recipe', recipeId: prepared.recipe.id, receiptHash });
      const replay = this.replay(key, requestHash); if (replay) return replay;
      this.requireHuman(prepared, receiptHash);
      for (const step of prepared.recipe.steps) for (const scope of step.scope) this.scoped(scope, false);
      const record: StoredWorkflow = {
        id: randomUUID(), projectId: this.projectId, recipe: clone(prepared.recipe), creationReceiptHash: receiptHash,
        runId: null, taskIds: {}, taskStates: {}, state: 'creating', submissions: [], decisions: [], attempts: [],
        operation: null, revision: 0,
      };
      const command = this.begin(record, key, 'create-recipe', requestHash, receiptHash, null, null, null, true);
      try {
        const run = this.work.create(toWorkStoreInput(record.recipe));
        record.runId = run.id;
        record.taskIds = Object.fromEntries(run.tasks.map(t => [t.key, t.id]));
        record.taskStates = Object.fromEntries(run.tasks.map(t => [t.key, t.state]));
        this.projection(record); record.state = 'active';
        return this.finish(record, command, 'created');
      } catch { return this.uncertain(record, command); }
    });
  }
  prepareGate(workflowId: string, stepKey: string, gate: HumanGate, decision: HumanDecision['decision']): WorkflowHumanRequest {
    const record = this.load(workflowId); this.checked(record);
    if (!['approved', 'rejected'].includes(decision)) fail('WORKFLOW_INPUT', 'Expected an explicit gate decision.');
    const binding = workflowGateBinding(record.recipe, stepKey, gate, this.subjects(record, this.step(record, stepKey)));
    return this.humanRequest('recipe-gate', record.recipe, record, stepKey, decision, null, {
      workflowId: record.recipe.id, stepKey, gate, decision, binding,
    });
  }
  recordDecision(input: unknown): WorkflowCommandResult {
    return this.exclusive(() => {
      const a = object(input, ['workflowId', 'idempotencyKey', 'decision']);
      const d = object(a.decision, ['stepKey', 'gate', 'decision', 'binding', 'receiptHash']);
      const decision = clone(d) as unknown as HumanDecision;
      const key = identifier(a.idempotencyKey), id = identifier(a.workflowId);
      const receiptHash = digest(d.receiptHash); digest(d.binding); identifier(d.stepKey);
      const requestHash = hash({ kind: 'recipe-gate', workflowId: id, decision });
      const replay = this.replay(key, requestHash); if (replay) return replay;
      const record = this.load(id);
      if (record.taskStates[decision.stepKey] === 'complete') fail('WORKFLOW_STATE', 'Accepted steps are immutable; create a new reviewed recipe.');
      const prepared = this.prepareGate(id, decision.stepKey, decision.gate, decision.decision);
      if (prepared.recipeGate?.binding !== decision.binding) fail('WORKFLOW_BINDING', 'Recipe gate binding is stale.');
      if (!prepared.subjectHashes.length) fail('WORKFLOW_EVIDENCE', 'Gate decisions need pinned input evidence.');
      this.requireHuman(prepared, receiptHash);
      const command = this.begin(record, key, 'recipe-gate', requestHash, receiptHash, decision.stepKey);
      try {
        record.decisions = record.decisions.filter(d => d.stepKey !== decision.stepKey || d.gate !== decision.gate);
        record.decisions.push(decision);
        return this.finish(record, command, 'decided');
      } catch { return this.uncertain(record, command); }
    });
  }

  private submission(record: StoredWorkflow, step: WorkflowStep, input: WorkflowSubmission, passing: boolean): WorkflowSubmission {
    const issues = evaluateWorkflowEvidence(step, input, this.subjects(record, step));
    if ((passing && issues.length) || issues.includes('current-subject-hashes')) fail('WORKFLOW_EVIDENCE', 'Evidence does not satisfy the current recipe subjects and quality contract.');
    if (!input.artifacts.length) fail('WORKFLOW_EVIDENCE', 'At least one pinned artifact is required.');
    const normalized: WorkflowSubmission = {
      key: step.key,
      artifacts: input.artifacts.map(a => ({
        path: a.path.normalize('NFKC').replaceAll('\\', '/').trim(), role: a.role, sha256: a.sha256, bytes: a.bytes,
      })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
      subjectHashes: [...new Set(input.subjectHashes)].sort(),
      checks: input.checks.map(c => ({ ...c, id: c.id.normalize('NFKC').trim() })).sort((a, b) => a.id.localeCompare(b.id)),
    };
    if (normalized.artifacts.reduce((total, a) => total + a.bytes, 0) > WORKFLOW_LIMITS.artifactBytes) fail('WORKFLOW_EVIDENCE', 'Submission exceeds the aggregate evidence byte bound.');
    for (const artifact of normalized.artifacts) this.pin(artifact);
    return normalized;
  }
  prepareSubmission(workflowId: string, submission: WorkflowSubmission): WorkflowHumanRequest {
    const record = this.load(workflowId); this.checked(record);
    const step = this.step(record, submission.key);
    if (step.execution === 'local-verification') fail('WORKFLOW_VERIFIER', 'Only the registered host verifier may submit verification evidence.');
    return this.humanRequest('submit-evidence', record.recipe, record, step.key, 'approved', this.submission(record, step, submission, true));
  }
  private publishSubmission(record: StoredWorkflow, step: WorkflowStep, submission: WorkflowSubmission): void {
    const taskId = record.taskIds[step.key]!;
    const lease = this.work.claim({ taskId, worker: 'workflow-coordinator' });
    const task = this.work.submit({
      taskId, leaseToken: lease.leaseToken,
      evidence: submission.artifacts.map(a => ({ path: a.path, note: 'Workflow artifact: ' + a.role })),
    });
    if (!same(task.evidence.map(a => ({ path: a.path, sha256: a.sha256, bytes: a.bytes })),
      submission.artifacts.map(a => ({ path: a.path, sha256: a.sha256, bytes: a.bytes })))) fail('WORKFLOW_EVIDENCE', 'Evidence changed during WorkStore submission.');
    record.submissions = record.submissions.filter(s => s.key !== step.key);
    record.submissions.push(submission); record.taskStates[step.key] = 'needs_review';
  }
  submitHandoff(input: unknown): WorkflowCommandResult {
    return this.exclusive(() => {
      const a = object(input, ['workflowId', 'idempotencyKey', 'receiptHash', 'submission']);
      const id = identifier(a.workflowId), key = identifier(a.idempotencyKey), receiptHash = digest(a.receiptHash);
      const requestHash = hash({ kind: 'submit-evidence', workflowId: id, submission: a.submission, receiptHash });
      const replay = this.replay(key, requestHash); if (replay) return replay;
      const record = this.load(id), tasks = this.checked(record);
      const prepared = this.prepareSubmission(id, a.submission as WorkflowSubmission);
      const step = this.step(record, prepared.stepKey!);
      if (this.assessment(record, tasks).steps.find(s => s.key === step.key)?.disposition !== 'human-handoff') fail('WORKFLOW_BLOCKED', 'Recipe policy does not permit this handoff submission.');
      this.requireHuman(prepared, receiptHash);
      const submission = prepared.submission!;
      const command = this.begin(record, key, 'submit-evidence', requestHash, receiptHash, step.key, submission);
      try { this.publishSubmission(record, step, clone(submission)); return this.finish(record, command, 'submitted'); }
      catch { return this.uncertain(record, command); }
    });
  }
  async verify(input: unknown): Promise<WorkflowCommandResult> {
    this.open();
    if (this.busy) fail('WORKFLOW_BUSY', 'A coordinator operation is already in progress.');
    this.busy = true;
    try {
      const a = object(input, ['workflowId', 'stepKey', 'idempotencyKey']);
      const id = identifier(a.workflowId), stepKey = identifier(a.stepKey), key = identifier(a.idempotencyKey);
      const requestHash = hash({ kind: 'verify', workflowId: id, stepKey });
      const replay = this.replay(key, requestHash); if (replay) return replay;
      const record = this.load(id), tasks = this.checked(record), step = this.step(record, stepKey);
      const verifier = this.verifiers.get(step.action as SafeWorkflowAction);
      if (!verifier || step.execution !== 'local-verification' || step.provider || step.studio || step.gates.length ||
        this.assessment(record, tasks).steps.find(s => s.key === stepKey)?.disposition !== 'verify') fail('WORKFLOW_VERIFIER', 'Only a ready registered deterministic verifier can execute.');
      const subjectDigest = workflowSubjectDigest(this.subjects(record, step));
      const attempts = record.attempts.filter(a => a.stepKey === stepKey), previous = attempts.at(-1);
      if (record.attempts.length >= WORKFLOW_LIMITS.totalAttempts || (previous && (previous.state !== 'busy' || !canRetryWorkflowStep(step, {
        attempts: attempts.length, reason: 'evidence-read-busy', previousSubjectDigest: previous.subjectDigest, subjectDigest,
      })))) fail('WORKFLOW_RETRY', 'Only bounded busy evidence reads with unchanged subjects may retry.');
      record.attempts.push({ stepKey, number: attempts.length + 1, subjectDigest, state: 'running' });
      const command = this.begin(record, key, 'verify', requestHash, null, stepKey);
      try {
        const result = await verifier(freeze({
          projectId: this.projectId, projectPath: this.journal.projectPath, workflowId: id, recipeId: record.recipe.id,
          step: clone(step), subjectDigest, inputArtifacts: this.inputArtifacts(record, step),
        }));
        this.checked(record);
        const last = record.attempts.at(-1)!;
        if (result.status === 'evidence-read-busy' || result.status === 'unsupported') {
          object(result, ['status']);
          last.state = result.status === 'evidence-read-busy' ? 'busy' : 'unsupported';
          return this.finish(record, command, last.state);
        }
        object(result, ['status', 'submission']);
        if (result.status !== 'evidence') fail('WORKFLOW_VERIFIER', 'Unknown verifier result.');
        const submission = this.submission(record, step, result.submission, false);
        // Checkpoint the intended output before touching WorkStore.
        record.operation!.submission = submission;
        this.journal.finish(record, command);
        this.publishSubmission(record, step, submission);
        last.state = 'submitted';
        return this.finish(record, command, 'submitted');
      } catch { return this.uncertain(record, command); }
    } finally { this.busy = false; }
  }
  prepareReview(workflowId: string, stepKey: string, decision: HumanDecision['decision']): WorkflowHumanRequest {
    const record = this.load(workflowId); this.checked(record);
    if (!['approved', 'rejected'].includes(decision)) fail('WORKFLOW_INPUT', 'Expected an explicit review decision.');
    const submission = record.submissions.find(s => s.key === stepKey);
    if (!submission || record.taskStates[stepKey] !== 'needs_review') fail('WORKFLOW_STATE', 'Only submitted evidence may be reviewed.');
    return this.humanRequest('review-evidence', record.recipe, record, stepKey, decision, submission);
  }
  review(input: unknown): WorkflowCommandResult {
    return this.exclusive(() => {
      const a = object(input, ['workflowId', 'stepKey', 'idempotencyKey', 'decision', 'receiptHash']);
      const id = identifier(a.workflowId), stepKey = identifier(a.stepKey), key = identifier(a.idempotencyKey), receiptHash = digest(a.receiptHash);
      const requestHash = hash({ kind: 'review-evidence', workflowId: id, stepKey, decision: a.decision, receiptHash });
      const replay = this.replay(key, requestHash); if (replay) return replay;
      const record = this.load(id), tasks = this.checked(record);
      const prepared = this.prepareReview(id, stepKey, a.decision as HumanDecision['decision']);
      const approved = prepared.decision === 'approved';
      if (approved && this.assessment(record, tasks).steps.find(s => s.key === stepKey)?.disposition !== 'needs_review') fail('WORKFLOW_BLOCKED', 'Current policy and evidence do not permit acceptance.');
      this.requireHuman(prepared, receiptHash);
      const command = this.begin(record, key, 'review-evidence', requestHash, receiptHash, stepKey, prepared.submission, approved);
      try {
        this.work.review({ taskId: record.taskIds[stepKey], approved, note: 'Explicit host human workflow review.' });
        record.taskStates[stepKey] = approved ? 'complete' : 'pending';
        // WorkStore retains rejected evidence; preserve the matching pinned submission until a new handoff.
        return this.finish(record, command, 'reviewed');
      } catch { return this.uncertain(record, command); }
    });
  }

  prepareReconciliation(workflowId: string, resolution: 'halt' | 'accept-observed', observedRun?: { runId: string; taskIds: Record<string, string> }): WorkflowHumanRequest {
    const record = this.load(workflowId, false);
    if (record.state !== 'uncertain' || !record.operation) fail('WORKFLOW_STATE', 'Only an uncertain operation may be reconciled.');
    if (!['halt', 'accept-observed'].includes(resolution)) fail('WORKFLOW_INPUT', 'Unknown reconciliation resolution.');
    const operation = clone(record.operation);
    const request = this.humanRequest('reconcile', record.recipe, record, operation.stepKey,
      resolution === 'halt' ? 'rejected' : 'approved', operation.submission, null, operation);
    return freeze({ ...request, binding: hash({ request, resolution, observedRun: observedRun ?? null }) });
  }
  reconcile(input: unknown): WorkflowCommandResult {
    return this.exclusive(() => {
      const a = object(input, ['workflowId', 'idempotencyKey', 'receiptHash', 'resolution'], ['observedRun']);
      const id = identifier(a.workflowId), key = identifier(a.idempotencyKey), receiptHash = digest(a.receiptHash);
      const observedRun = a.observedRun as { runId: string; taskIds: Record<string, string> } | undefined;
      if (observedRun) {
        const mapping = object(observedRun, ['runId', 'taskIds']); identifier(mapping.runId);
        if (!mapping.taskIds || typeof mapping.taskIds !== 'object' || Array.isArray(mapping.taskIds) || Object.keys(mapping.taskIds).length > WORKFLOW_LIMITS.steps) fail('WORKFLOW_MAPPING', 'Invalid observed run mapping.');
        for (const [key, value] of Object.entries(mapping.taskIds)) { identifier(key); identifier(value); }
      }
      const requestHash = hash({ kind: 'reconcile', workflowId: id, resolution: a.resolution, observedRun: observedRun ?? null, receiptHash });
      const replay = this.replay(key, requestHash); if (replay) return replay;
      const record = this.load(id, false);
      const prepared = this.prepareReconciliation(id, a.resolution as 'halt' | 'accept-observed', observedRun);
      const interrupted = clone(record.operation!);
      this.requireHuman(prepared, receiptHash);
      if (a.resolution === 'accept-observed') {
        if (interrupted.kind === 'create-recipe') {
          if (!observedRun) fail('WORKFLOW_MAPPING', 'Creation reconciliation needs the observed exact run mapping.');
          record.runId = observedRun.runId; record.taskIds = clone(observedRun.taskIds);
          const tasks = this.projection(record);
          if (tasks.some(t => t.state !== 'pending' || t.evidence.length)) fail('WORKFLOW_MAPPING', 'Observed created tasks must be untouched.');
          record.taskStates = Object.fromEntries(tasks.map(t => [t.key, t.state]));
        } else if (interrupted.submission && interrupted.stepKey) {
          const step = this.step(record, interrupted.stepKey);
          const submission = this.submission(record, step, interrupted.submission, false);
          const tasks = this.projection(record), task = tasks.find(t => t.key === step.key)!;
          const expectedState = interrupted.kind === 'review-evidence' ? (interrupted.approved ? 'complete' : 'pending') : 'needs_review';
          if (task.state !== expectedState || !same(task.evidence.map(a => ({ path: a.path, sha256: a.sha256, bytes: a.bytes })),
            submission.artifacts.map(a => ({ path: a.path, sha256: a.sha256, bytes: a.bytes })))) fail('WORKFLOW_MAPPING', 'Observed outcome does not match the interrupted mutation.');
          record.submissions = record.submissions.filter(s => s.key !== step.key); record.submissions.push(submission);
          record.taskStates[step.key] = expectedState;
          for (const attempt of record.attempts) if (attempt.stepKey === step.key && attempt.state === 'uncertain') attempt.state = 'submitted';
        } else fail('WORKFLOW_UNCERTAIN', 'There is no exact observed outcome to accept. Halt and create a newly reviewed workflow.');
        record.state = 'active'; record.operation = null; this.checked(record);
      } else record.state = 'halted';
      const command = this.begin(record, key, 'reconcile', requestHash, receiptHash, interrupted.stepKey);
      try { return this.finish(record, command, 'reconciled'); }
      catch { return this.uncertain(record, command); }
    });
  }
  close(): void {
    if (this.closed) return;
    if (this.busy) fail('WORKFLOW_BUSY', 'Wait for the verifier before closing the coordinator.');
    this.closed = true;
    try { if (this.ownsWork) this.work.close(); } finally { this.journal.close(); }
  }
}

