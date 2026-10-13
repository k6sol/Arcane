import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ArcaneError } from '../../packages/protocol/src/providers.js';
import { WorkStore } from '../../packages/storage/src/work-store.js';
import { workflowProjectIdentity } from '../../packages/storage/src/workflow-store.js';
import { createConnectionLab } from '../../apps/daemon/src/lab-server.js';
import { workflowNativeModel } from '../../apps/daemon/src/workflow-native-model.js';
import { workflowReceiptParent, type WorkflowPreview } from '../../apps/daemon/src/workflow-host.js';
import { workflowCodeHostConfiguration, createWorkflowCodeHostVerifier } from '../../apps/daemon/src/workflow-code-host.js';
import type { CodexProductState, CodexService } from '../../apps/daemon/src/codex-service.js';
import type { WorkflowSnapshot } from '../../apps/daemon/src/workflow-service.js';
import type { WorkflowRecipeRequest, WorkflowSubmission } from '../../packages/core/src/workflow-recipes.js';

const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const PATH = process.platform === 'win32' ? 'C:\\Tools\\luau-compile.exe' : '/tools/luau-compile';
const environment = () => ({ ARCANE_LUAU_COMPILER_PATH: PATH, ARCANE_LUAU_COMPILER_SHA256: 'a'.repeat(64), ARCANE_LUAU_EVIDENCE_DIRECTORY: 'src/proof' });
const invalid = (error: unknown) => error instanceof ArcaneError && error.code === 'WORKFLOW_CODE_CONFIGURATION';

test('host configuration is inert without all fixed launcher keys and captures only the exact complete tuple', () => {
  assert.equal(workflowCodeHostConfiguration({}), undefined);
  assert.equal(workflowCodeHostConfiguration({ OTHER: 'do not read this' }), undefined);
  const source = environment(), configured = workflowCodeHostConfiguration(source)!;
  assert.ok(Object.isFrozen(configured)); assert.ok(Object.isFrozen(configured.compiler));
  assert.deepEqual(configured, { evidenceDirectory: 'src/proof', compiler: { executablePath: PATH, sha256: 'a'.repeat(64) } });
  source.ARCANE_LUAU_COMPILER_PATH = 'relative'; assert.equal(configured.compiler.executablePath, PATH);
  for (const key of Object.keys(environment())) {
    const partial: NodeJS.ProcessEnv = environment(); delete partial[key]; assert.throws(() => workflowCodeHostConfiguration(partial), invalid);
  }
});

test('host configuration refuses relative/UNC/ambiguous compiler paths, unpinned digests and unsafe output scopes', () => {
  for (const path of ['', 'luau-compile', './luau-compile', PATH + '\n', '\\\\server\\tool.exe', '//server/tool', PATH + '/..'])
    assert.throws(() => workflowCodeHostConfiguration({ ...environment(), ARCANE_LUAU_COMPILER_PATH: path }), invalid);
  for (const digest of ['', 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(64) + '\n'])
    assert.throws(() => workflowCodeHostConfiguration({ ...environment(), ARCANE_LUAU_COMPILER_SHA256: digest }), invalid);
  for (const directory of ['', '../evidence', '/tmp/evidence', 'src//proof', 'src/./proof', 'src/proof.', 'src/proof ', 'src/proof:stream'])
    assert.throws(() => workflowCodeHostConfiguration({ ...environment(), ARCANE_LUAU_EVIDENCE_DIRECTORY: directory }), invalid);
});

test('host configuration and registration refuse proxies/getters/foreign project fields without invoking them', async () => {
  let accessed = 0;
  const getter = { ...environment() }; Object.defineProperty(getter, 'ARCANE_LUAU_COMPILER_PATH', { get() { accessed++; return PATH; } });
  assert.throws(() => workflowCodeHostConfiguration(getter), invalid);
  assert.throws(() => workflowCodeHostConfiguration(new Proxy(environment(), { ownKeys() { accessed++; return []; } })), invalid);
  const normal = workflowCodeHostConfiguration(environment())!;
  await assert.rejects(createWorkflowCodeHostVerifier(dirname(PATH), { ...normal, projectPath: 'foreign' } as typeof normal), invalid);
  const config = { ...normal }; Object.defineProperty(config, 'compiler', { get() { accessed++; return normal.compiler; } });
  await assert.rejects(createWorkflowCodeHostVerifier(dirname(PATH), config), invalid);
  await assert.rejects(createWorkflowCodeHostVerifier(dirname(PATH), { ...normal, compiler: new Proxy(normal.compiler, {}) }), invalid);
  assert.equal(accessed, 0);
});

function nativeState(projectPath: string): CodexProductState {
  return { provider: 'codex', use: 'personal-local', projectPath, connecting: false, closing: false, busy: false, lastSnapshot: null, actions: [], nativeHistory: null,
    nativeTools: { configured: false, verified: false }, snapshot: {
      connectionId: '11111111-1111-4111-8111-111111111111', provenance: 'installed-cli', connected: true, ready: true,
      account: { auth: 'subscription', plan: null, requiresOpenaiAuth: true }, models: [{ model: 'offline-model', id: 'offline-row', displayName: 'Borrowed synthetic installed metadata', efforts: ['high'], defaultEffort: 'high', entitlement: 'unverified' }],
      selection: { model: 'offline-model', effort: 'high' }, thread: { threadId: 'Fixture-Code-Thread', sessionId: 'Fixture-Code-Session', selection: { model: 'offline-model', effort: 'high' }, configured: true, writeGranted: false, turnId: null, turnStatus: 'idle' },
      operations: [], approvals: [], events: [], droppedEvents: 0, lastEventSeq: 0, failureCode: null,
    } };
}

async function fixture(t: test.TestContext, compiler?: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'arcane-code-host-'))), projectPath = join(root, 'project'), stateDirectory = join(root, 'state');
  const evidence = join(projectPath, 'src', 'proof'); mkdirSync(evidence, { recursive: true });
  const work = new WorkStore({ directory: join(stateDirectory, 'borrowed-work'), projectPath });
  const counters = { nativeActions: 0, probes: 0, closes: 0 };
  const observed = nativeState(projectPath); let selected = observed;
  const codex: CodexService = { state: () => structuredClone(selected), action: async () => { counters.nativeActions++; throw Error('Actual provider actions forbidden'); }, close: async () => { counters.closes++; } };
  const lab = await createConnectionLab({ cwd: root, projectPath, stateDirectory, workStore: work, codexService: codex, port: 0,
    probe: async () => { counters.probes++; throw Error('Provider discovery forbidden'); },
    ...(compiler ? { workflowCodeVerification: { evidenceDirectory: 'src/proof', compiler: { executablePath: compiler, sha256: sha(readFileSync(compiler)) } } } : {}) });
  const receiptParent = workflowReceiptParent(join(stateDirectory, 'workflows'), workflowProjectIdentity(projectPath).projectId);
  t.after(async () => {
    await lab.close(); work.close();
    if (process.platform === 'win32' && existsSync(receiptParent)) {
      assert.match(relative(resolve(homedir(), '.arcane-private-receipts-v1'), resolve(receiptParent)), /^[a-f0-9]{64}$/);
      assert.ok(!lstatSync(receiptParent).isSymbolicLink()); rmSync(receiptParent, { recursive: true });
    }
    const part = relative(resolve(tmpdir()), resolve(root)); assert.ok(part && !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep));
    assert.ok(!lstatSync(root).isSymbolicLink()); rmSync(root, { recursive: true });
    assert.equal(counters.nativeActions, 0); assert.equal(counters.probes, 0); assert.equal(counters.closes, 1);
  });
  let calls = 0;
  async function call(path: string, input?: unknown, token = lab.token) {
    const started = performance.now(), number = ++calls;
    const response = await fetch(lab.origin + '/v1/workflows' + path, { method: input === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + token, Origin: lab.origin, ...(input === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(15000) });
    const value = await response.json() as Record<string, unknown>;
    t.diagnostic('Owned HTTP '+number+' '+(input === undefined ? 'GET' : 'POST')+' '+path+' '+response.status+' '+Math.round(performance.now()-started)+'ms');
    return { status: response.status, value };
  }
  async function execute(input: unknown) {
    const preview = await call('/preview', input); assert.equal(preview.status, 200, JSON.stringify(preview.value));
    const result = await call('/execute', { preview: preview.value, idempotencyKey: randomUUID() });
    assert.equal(result.status, 200, JSON.stringify(result.value)); return result.value as unknown as WorkflowSnapshot;
  }
  const model = workflowNativeModel(observed)!.proof.selection;
  const request: WorkflowRecipeRequest = { deliverable: 'code-change', engine: 'roblox', title: 'Owned production host syntax report', prompt: 'Verify the scoped source; leave unimplemented quality checks pending.', scope: ['src'], model };
  const created = await execute({ action: 'recipe', request });
  const id = created.workflow.id;
  async function get() { const r = await call('/' + id); assert.equal(r.status, 200, JSON.stringify(r.value)); return r.value as unknown as WorkflowSnapshot; }
  async function ready() {
    let snapshot = created;
    for (const key of ['prompt', 'requirements', 'plan', 'plan_acceptance', 'implementation']) {
      const record = snapshot.workflow, step = record.recipe.steps.find(s => s.key === key)!;
      for (const gate of step.gates) await execute({ action: 'gate', workflowId: id, stepKey: key, gate, decision: 'approved' });
      const path = 'src/' + key + (key === 'implementation' ? '.luau' : '.txt');
      const bytes = Buffer.from(key === 'implementation' ? '--!strict\nlocal number: number = 42\nreturn number\n' : 'Actual owned fixture evidence for ' + key);
      writeFileSync(join(projectPath, path), bytes);
      const submission: WorkflowSubmission = { key, checks: [],
        subjectHashes: [...new Set(step.subjectSteps.flatMap(subject => record.submissions.find(s => s.key === subject)?.artifacts.map(a => a.sha256) ?? []))].sort(),
        artifacts: [{ path, role: step.quality.roles[0]!, bytes: bytes.length, sha256: sha(bytes) }] };
      await execute({ action: 'handoff', workflowId: id, submission });
      snapshot = await execute({ action: 'review', workflowId: id, stepKey: key, decision: 'approved' });
      t.diagnostic('Ready phase '+key+' complete');
    }
  }
  return { projectPath, evidence, lab, counters, id, call, execute, get, ready,
    switchChat: () => { selected = structuredClone(observed); selected.snapshot!.thread!.threadId = 'Another-Code-Thread'; } };
}

test('production host without explicit compiler never enables verifier or dispatches provider/Studio; route is human-only', {timeout: 60000}, async t => {
  t.diagnostic('Borrowed synthetic installed-cli observations only; no actual provider/Studio operations.');
  const f = await fixture(t), payload = { workflowId: f.id, stepKey: 'verification', idempotencyKey: randomUUID() };
  assert.equal((await f.call('/verify-safe', payload, f.lab.agentToken)).status, 403);
  assert.equal((await f.call('/verify-safe', { ...payload, compiler: PATH })).status, 400);
  assert.equal((await f.call('/verify-safe', payload)).status, 409);
  assert.deepEqual((await f.get()).workflow.attempts, []); assert.deepEqual(readdirSync(f.evidence), []);
  f.switchChat(); assert.equal((await f.call('/verify-safe', payload)).status, 403);
});

test('REAL OFFICIAL COMPILER: production host HTTP routes create exact partial report and preserve blocked release without any native actions', { timeout: 300000 }, async t => {
  const path = process.env.ARCANE_TEST_OFFICIAL_LUAU_COMPILER;
  if (!path) { t.skip('Requires host-installed official luau-compile; no substitute or download.'); return; }
  assert.equal(isAbsolute(path), true); const compiler = realpathSync(path), beforeCompiler = readFileSync(compiler);
  if (process.platform === 'win32') assert.equal(sha(beforeCompiler), '74cf7ed3621b8966bac6fec7f1a0caf13616655fa06d346133cd31f6aac439d8', 'Known previously verified official binary pin');
  t.diagnostic('Actual official Luau compiler; borrowed synthetic Codex metadata, no real provider/Studio.');
  const f = await fixture(t, compiler); await f.ready();
  const ready = await f.get(); assert.equal(ready.assessment!.steps.find(s => s.key === 'verification')!.disposition, 'verify');
  const input = { workflowId: f.id, stepKey: 'verification', idempotencyKey: randomUUID() };
  const source = readFileSync(join(f.projectPath, 'src', 'implementation.luau'));
  const reply = await f.call('/verify-safe', input); assert.equal(reply.status, 200, JSON.stringify(reply.value)); assert.equal(reply.value.result, 'submitted');
  const snapshot = reply.value as unknown as WorkflowSnapshot; assert.equal(snapshot.workflow.attempts.length, 1); assert.equal(snapshot.workflow.taskStates.verification, 'needs_review');
  const s = snapshot.workflow.submissions.find(s => s.key === 'verification')!; const a = s.artifacts[0]!;
  const reportBytes = readFileSync(join(f.projectPath, a.path)), report = JSON.parse(reportBytes.toString()) as Record<string, unknown>;
  assert.equal(sha(reportBytes), a.sha256); assert.equal(report.syntaxCompilation, 'pass');
  assert.equal(s.checks.find(c => c.id === 'syntax-types')!.outcome, 'unsupported'); assert.equal(snapshot.assessment!.steps.find(s => s.key === 'verification')!.state, 'pending');
  const review = await f.call('/preview', { action: 'review', workflowId: f.id, stepKey: 'verification', decision: 'approved' });
  assert.equal(review.status, 200); const released = await f.call('/execute', { preview: review.value as unknown as WorkflowPreview, idempotencyKey: randomUUID() }); assert.equal(released.status, 409);
  const duplicate = await f.call('/verify-safe', input); assert.equal(duplicate.status, 200); assert.equal((duplicate.value as unknown as WorkflowSnapshot).workflow.attempts.length, 1);
  assert.equal(readdirSync(f.evidence).length, 1, 'Exact duplicate returns durable result without re-execution');
  const repeat = await f.call('/verify-safe', { ...input, idempotencyKey: randomUUID() }); assert.equal(repeat.status, 409, 'No terminal execution retry');
  assert.deepEqual(readFileSync(join(f.projectPath, 'src', 'implementation.luau')), source); assert.deepEqual(readFileSync(compiler), beforeCompiler);
});
