import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { ArcaneError } from '../../packages/protocol/src/providers.js';
import { createWorkflowRecipe } from '../../packages/core/src/workflow-recipes.js';
import {
  WORKFLOW_STORE_LIMITS, WorkflowStore, type StoredWorkflow, type WorkflowCommand,
} from '../../packages/storage/src/workflow-store.js';

const sha = 'a'.repeat(64);
const code = (expected: string) => (error: unknown) => error instanceof ArcaneError && error.code === expected;
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'arcane-workflow-store-')), project = join(root, 'project'), directory = join(root, 'state');
  mkdirSync(project);
  let store = new WorkflowStore({ directory, projectPath: project });
  t.after(() => {
    store.close(); assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true, force: true });
  });
  return { root, project, directory, get store() { return store; }, reopen() { store.close(); store = new WorkflowStore({ directory, projectPath: project }); } };
}
function record(store: WorkflowStore, key = randomUUID()): StoredWorkflow {
  return { id: randomUUID(), projectId: store.projectId,
    recipe: createWorkflowRecipe({ deliverable: 'code-change', engine: 'roblox', title: 'Offline journal fixture',
      prompt: 'Test durable workflow records.', scope: ['src'], model: null }),
    creationReceiptHash: sha, runId: null, taskIds: {}, taskStates: {}, state: 'creating',
    submissions: [], decisions: [], attempts: [],
    operation: { key, kind: 'create-recipe', stepKey: null, submission: null, approved: null }, revision: 0 };
}
function command(r: StoredWorkflow): WorkflowCommand {
  return { key: r.operation!.key, workflowId: r.id, requestHash: sha, kind: r.operation!.kind,
    receiptHash: null, state: 'running', result: null };
}
function commit(store: WorkflowStore, r: StoredWorkflow, c: WorkflowCommand) {
  r.operation = null; r.state = 'active'; c.state = 'done'; c.result = 'created'; store.finish(r, c);
}

test('single coordinator ownership and canonical project identity fail closed', t => {
  const f = fixture(t);
  assert.throws(() => new WorkflowStore({ directory: f.directory, projectPath: f.project }), code('WORKFLOW_OWNER'));
  f.store.close();
  const other = join(f.root, 'other-project'); mkdirSync(other);
  assert.throws(() => new WorkflowStore({ directory: f.directory, projectPath: other }), code('WORKFLOW_PROJECT'));
  f.reopen(); assert.equal(f.store.list().length, 0);
});
test('journal request bindings and revisions persist; stale writes fail without overwriting the record', t => {
  const f = fixture(t), r = record(f.store), c = command(r);
  f.store.begin(r, c, true); assert.equal(r.revision, 1);
  const stale = f.store.get(r.id); commit(f.store, r, c);
  assert.equal(f.store.command(c.key, sha)!.state, 'done');
  assert.throws(() => f.store.command(c.key, 'b'.repeat(64)), code('WORKFLOW_IDEMPOTENCY'));
  const c2 = { ...c, key: randomUUID(), state: 'running' as const, result: null };
  stale.operation = { ...record(f.store).operation!, key: c2.key };
  assert.throws(() => f.store.begin(stale, c2), code('WORKFLOW_CONFLICT'));
  f.reopen(); assert.equal(f.store.get(r.id).revision, 2); assert.equal(f.store.command(c.key, sha)!.result, 'created');
});
test('restart retains exact in-flight operation and marks commands and attempts uncertain', t => {
  const f = fixture(t), r = record(f.store);
  r.state = 'active'; r.operation = { key: randomUUID(), kind: 'verify', stepKey: 'verification', submission: null, approved: null };
  r.attempts.push({ stepKey: 'verification', number: 1, subjectDigest: sha, state: 'running' });
  const c = command(r); f.store.begin(r, c, true);
  f.reopen();
  const recovered = f.store.get(r.id);
  assert.equal(recovered.state, 'uncertain'); assert.deepEqual(recovered.operation, r.operation);
  assert.equal(recovered.attempts[0]!.state, 'uncertain'); assert.equal(f.store.command(c.key, sha)!.state, 'uncertain');
});
test('hard workflow, command and collection capacities are enforced before insertion', t => {
  const f = fixture(t);
  const oversized = record(f.store); oversized.attempts = Array(49).fill({ stepKey: 'verification', number: 1, subjectDigest: sha, state: 'busy' });
  assert.throws(() => f.store.begin(oversized, command(oversized), true), code('WORKFLOW_CAPACITY'));
  for (let i = 0; i < WORKFLOW_STORE_LIMITS.workflows; i++) {
    const r = record(f.store), c = command(r); f.store.begin(r, c, true); commit(f.store, r, c);
  }
  const extra = record(f.store);
  assert.throws(() => f.store.begin(extra, command(extra), true), code('WORKFLOW_CAPACITY'));
  assert.equal(f.store.list().length, WORKFLOW_STORE_LIMITS.workflows);
  const r = f.store.list()[0]!;
  for (let i = 1; i < WORKFLOW_STORE_LIMITS.commandsPerWorkflow; i++) {
    r.operation = { key: randomUUID(), kind: 'recipe-gate', stepKey: 'plan_acceptance', submission: null, approved: null };
    const c = command(r); f.store.begin(r, c); commit(f.store, r, c);
  }
  r.operation = { key: randomUUID(), kind: 'recipe-gate', stepKey: 'plan_acceptance', submission: null, approved: null };
  assert.throws(() => f.store.begin(r, command(r)), code('WORKFLOW_CAPACITY'));
});
test('linked storage directories and hard-linked SQLite databases are forbidden', t => {
  const f = fixture(t), linked = join(f.root, 'linked');
  symlinkSync(f.directory, linked, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => new WorkflowStore({ directory: linked, projectPath: f.project }), code('WORKFLOW_STORAGE'));
  f.store.close();
  linkSync(join(f.directory, 'workflow.sqlite'), join(f.root, 'database-link.sqlite'));
  assert.throws(() => new WorkflowStore({ directory: f.directory, projectPath: f.project }), code('WORKFLOW_STORAGE'));
});

