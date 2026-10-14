import { makeFixtureDirectory, fixtureTempDirectory } from './windows-fixture-paths.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnectionLab } from '../../apps/daemon/src/lab-server.js';
import type { CodexProductState, CodexService } from '../../apps/daemon/src/codex-service.js';
import { workflowReceiptParent } from '../../apps/daemon/src/workflow-host.js';
import type { WorkflowPreview } from '../../apps/daemon/src/workflow-host.js';
import type { WorkflowSnapshot } from '../../apps/daemon/src/workflow-service.js';
import { StudioStore } from '../../packages/storage/src/studio-store.js';
import { WorkStore } from '../../packages/storage/src/work-store.js';
import { ConversationWorkStore } from '../../packages/storage/src/conversation-work-store.js';
import { workflowProjectIdentity } from '../../packages/storage/src/workflow-store.js';
import type { Snapshot, ThreadState } from '../../packages/codex-client/src/types.js';
import type { NativeConversation } from '../../packages/storage/src/conversation-work-store.js';
// These type dependencies include the real browser modules in a focused compile;
// the test serves their emitted bytes and never evaluates a browser DOM in Node.
type BrowserProductModule = typeof import('../../apps/desktop/src/studio.js');

const SOURCE = resolve(process.cwd());
const EMITTED = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const native: NativeConversation = { provider: 'codex', threadId: 'Product:Fixture.Thread', sessionId: 'Product:Fixture.Session' };
const recipe = { deliverable: 'code-change', engine: 'roblox', title: 'Offline product wiring proof',
  prompt: 'Record a scoped deliverable without executing a model or Studio operation.', scope: ['src'], model: null };

function syntheticCodex(projectPath: string, counters: { actions: number; closes: number }) {
  let thread: ThreadState | null = null, recorded: NonNullable<CodexProductState['nativeHistory']> | null = null, closed = false;
  const selection = { model: 'offline-product-fixture', effort: 'high' };
  function snapshot(): Snapshot {
    return { connectionId: 'fixture-connection', provenance: 'spawned-node-fixture',
      connected: true, ready: true, account: null, models: [], selection, thread,
      operations: [], approvals: [], events: [], droppedEvents: 0, lastEventSeq: 0, failureCode: null };
  }
  const service: CodexService = {
    state(): CodexProductState {
      assert.equal(closed, false, 'A closed synthetic service cannot provide a native context.');
      return structuredClone({ provider: 'codex', use: 'personal-local', projectPath,
        connecting: false, closing: false, busy: false, snapshot: thread ? snapshot() : null,
        lastSnapshot: null, actions: [], nativeHistory: recorded, nativeTools: { configured: false, verified: false } });
    },
    async action() { counters.actions++; throw new Error('Native actions are forbidden in this product fixture.'); },
    async close() { counters.closes++; closed = true; },
  };
  return {
    service,
    setThread(conversation: NativeConversation | null, configured = true) {
      recorded = null;
      thread = conversation ? { threadId: conversation.threadId, sessionId: conversation.sessionId,
        selection, configured, writeGranted: false, turnId: null, turnStatus: 'idle' } : null;
    },
    setRecorded(conversation: NativeConversation) {
      thread = null;
      recorded = { projectPath, threadId: conversation.threadId, sessionId: conversation.sessionId, recorded: null };
    },
  };
}
interface Reply { status: number; text: string; headers: Headers }
const json = <T>(reply: Reply): T => JSON.parse(reply.text) as T;
interface Listing { projectId: string; workflows: { id: string; recipeId: string; state: string }[] }

test('actual product lab serves workflow modules and human routes with exact native binding, restart and borrowed cleanup',
  { timeout: 60000 }, async t => {
  const root = makeFixtureDirectory('arcane-workflow-product-');
  const projectPath = join(root, 'project'), resources = join(root, 'resources'), stateDirectory = join(root, 'connection-lab');
  mkdirSync(join(projectPath, 'src'), { recursive: true });
  const publicRoot = join(resources, 'apps/desktop/public'), moduleRoot = join(resources, 'dist/apps/desktop/src');
  mkdirSync(publicRoot, { recursive: true }); mkdirSync(moduleRoot, { recursive: true });
  for (const file of ['studio.html', 'studio.css']) copyFileSync(join(SOURCE, 'apps/desktop/public', file), join(publicRoot, file));
  for (const module of ['studio', 'codex-chat', 'codex-history', 'workflow-panel', 'learning-panel', 'workspace-shell', 'asset-downloads']) {
    copyFileSync(join(EMITTED, 'apps/desktop/src', module + '.js'), join(moduleRoot, module + '.js'));
  }
  const studio = new StudioStore({ directory: join(root, 'studio') });
  const work = new WorkStore({ directory: join(root, 'work'), projectPath });
  const counters = { actions: 0, closes: 0, probes: 0 };
  const workflowDirectory = join(stateDirectory, 'workflows'), identity = workflowProjectIdentity(projectPath);
  let receiptParent: string | undefined;
  let codex = syntheticCodex(projectPath, counters);
  let app: Awaited<ReturnType<typeof createConnectionLab>> | undefined;
  const stop = async () => {
    const current = app; app = undefined;
    if (current) {
      const first = current.close(), second = current.close();
      assert.equal(first, second, 'Concurrent close calls share the same cleanup promise.');
      await Promise.all([first, second]);
      assert.equal(current.close(), first, 'Completed cleanup is also idempotent.');
      assert.equal(current.server.listening, false);
    }
  };
  t.after(async () => {
    try { await stop(); } finally {
      work.close(); studio.close();
      if (process.platform === 'win32' && receiptParent && existsSync(receiptParent)) {
        const part = relative(resolve(homedir(), '.arcane-private-receipts-v1'), resolve(receiptParent));
        assert.match(part, /^[a-f0-9]{64}$/); assert.ok(!lstatSync(receiptParent).isSymbolicLink());
        rmSync(resolve(receiptParent), { recursive: true, force: true });
      }
      const part = relative(fixtureTempDirectory(), resolve(root));
      assert.ok(part && !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep) && !lstatSync(root).isSymbolicLink());
      rmSync(resolve(root), { recursive: true, force: true });
    }
  });
  const launch = async () => {
    app = await createConnectionLab({ cwd: resources, stateDirectory, projectPath,
      studioStore: studio, workStore: work, codexService: codex.service,
      probe: async () => { counters.probes++; return []; }, port: 0 });
  };
  const call = async (path: string, input?: unknown, options: { token?: string; origin?: string | null } = {}): Promise<Reply> => {
    assert.ok(app);
    const response = await fetch(app.origin + path, {
      method: input === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + (options.token ?? app.token),
        ...(options.origin === null ? {} : { Origin: options.origin ?? app.origin }),
        ...(input === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(15000),
    });
    return { status: response.status, text: await response.text(), headers: response.headers };
  };

  const unrelated = work.create({ title: 'Borrowed worker task', objective: 'Remain claimed across lab lifetime.',
    tasks: [{ key: 'worker', title: 'Worker task', instructions: 'Offline fixture.', acceptance: 'Preserve its lease.',
      scope: ['worker-scope'], dependencies: [] }] });
  work.claim({ taskId: unrelated.tasks[0]!.id, worker: 'offline-owned-worker' });
  await launch();
  assert.equal(work.task(unrelated.tasks[0]!.id).state, 'in_progress');

  const html = await call('/studio');
  assert.equal(html.status, 200); assert.match(html.text, /id="workflow-panel"/);
  assert.match(html.text, /<script\s+type="module"\s+src="\/studio\.js"/);
  const csp = html.headers.get('content-security-policy')!;
  assert.match(csp, /script-src 'self'/); assert.match(csp, /connect-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/); assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  const script = await call('/studio.js'), panel = await call('/workflow-panel.js');
  assert.equal(script.status, 200); assert.equal(panel.status, 200);
  assert.equal(panel.text, readFileSync(join(moduleRoot, 'workflow-panel.js'), 'utf8'));
  assert.match(script.text, /import\(['"]\.\/workflow-panel\.js['"]\)/);
  assert.match(panel.text, /export function startWorkflowPanel/);
  assert.doesNotMatch(panel.text, /from\s+['"]node:|\brequire\s*\(/);
  assert.match(panel.headers.get('content-type')!, /^text\/javascript/);
  assert.equal(panel.headers.get('content-security-policy'), csp);
  assert.equal(panel.headers.get('cache-control'), 'no-store');
  const product = await call('/v1/product/state');
  assert.equal(product.status, 200); assert.equal(json<{ projectPath: string }>(product).projectPath, projectPath);

  const empty = await call('/v1/workflows');
  assert.equal(empty.status, 200);
  assert.deepEqual(json<Listing>(empty), { projectId: identity.projectId, workflows: [] });
  assert.equal(json(await call('/v1/workflows/current-flow')), null);
  receiptParent = workflowReceiptParent(workflowDirectory, identity.projectId);

  for (const scope of [null, { ...native }]) {
    codex.setThread(scope, false);
    const denied = await call('/v1/workflows/preview', { action: 'recipe', request: recipe });
    assert.equal(denied.status, 403, denied.text); assert.equal(json<{ error: string }>(denied).error, 'WORKFLOW_CONVERSATION');
  }
  assert.equal(work.runs().length, 1);
  codex.setThread(native);
  const observed = json<{ state: CodexProductState }>(await call('/v1/codex/state')).state;
  assert.equal(observed.snapshot!.thread!.configured, true);
  assert.equal(observed.snapshot!.thread!.threadId, native.threadId);

  const previewReply = await call('/v1/workflows/preview', { action: 'recipe', request: recipe });
  assert.equal(previewReply.status, 200, previewReply.text);
  const preview = json<WorkflowPreview>(previewReply);
  assert.deepEqual(preview.conversation, native);
  assert.equal(work.runs().length, 1, 'Preview must not create a workflow run.');
  const input = { preview, idempotencyKey: randomUUID() };
  for (const path of ['/v1/workflows', '/v1/workflows/current-flow']) {
    assert.equal((await call(path, undefined, { token: app!.agentToken })).status, 403);
    assert.equal((await call(path, undefined, { token: 'incorrect-control' })).status, 401);
  }
  for (const path of ['/v1/workflows/preview', '/v1/workflows/execute']) {
    const body = path.endsWith('preview') ? { action: 'recipe', request: recipe } : input;
    assert.equal((await call(path, body, { token: app!.agentToken })).status, 403);
    assert.equal((await call(path, body, { origin: null })).status, 403);
    assert.equal((await call(path, body, { origin: 'https://foreign.invalid' })).status, 403);
  }
  const executed = await call('/v1/workflows/execute', input);
  assert.equal(executed.status, 200, executed.text);
  const snapshot = json<WorkflowSnapshot>(executed), id = snapshot.workflow.id;
  assert.equal(snapshot.workflow.projectId, identity.projectId);
  assert.equal(snapshot.workflow.taskStates.prompt, 'pending');
  assert.equal(work.runs().length, 2);
  assert.deepEqual(json<Listing>(await call('/v1/workflows')).workflows.map(row => row.id), [id]);
  assert.equal(json<WorkflowSnapshot>(await call('/v1/workflows/current-flow')).workflow.id, id);

  codex.setThread({ ...native, sessionId: 'Product:Other.Session' });
  assert.deepEqual(json<Listing>(await call('/v1/workflows')).workflows, []);
  assert.equal((await call('/v1/workflows/' + id)).status, 403);
  assert.equal((await call('/v1/workflows/execute', input)).status, 403);
  codex.setThread(native);
  const firstToken = app!.token;
  await stop();
  assert.equal(counters.closes, 1);
  assert.equal(work.task(unrelated.tasks[0]!.id).state, 'in_progress');
  assert.equal(studio.sessions().length, 0); // Borrowed store is still usable; no real Studio session exists.
  const associations = new ConversationWorkStore({ directory: join(stateDirectory, 'conversation-work'), projectPath });
  try {
    assert.deepEqual(associations.binding('workflow', id), { projectId: identity.projectId, conversation: native, kind: 'workflow', id });
  } finally { associations.close(); }

  codex = syntheticCodex(projectPath, counters);
  codex.setRecorded(native); // Exact stored native history is a supported server-owned context.
  await launch();
  assert.notEqual(app!.token, firstToken);
  assert.equal((await call('/v1/workflows', undefined, { token: firstToken })).status, 401);
  const restarted = json<WorkflowSnapshot>(await call('/v1/workflows/' + id));
  assert.deepEqual(restarted.workflow.taskIds, snapshot.workflow.taskIds);
  assert.deepEqual(json<Listing>(await call('/v1/workflows')).workflows.map(row => row.id), [id]);
  const replay = await call('/v1/workflows/execute', input);
  assert.equal(replay.status, 200, replay.text);
  assert.equal(json<WorkflowSnapshot>(replay).workflow.id, id);
  assert.equal(work.runs().length, 2, 'Exact confirmed replay must not create another run.');
  assert.equal(counters.actions, 0); assert.equal(counters.probes, 0);
  assert.equal(studio.commands().length, 0); assert.equal(studio.keys().length, 0);
  await stop();
  assert.equal(counters.closes, 2);
  assert.equal(work.task(unrelated.tasks[0]!.id).state, 'in_progress');
  assert.equal(studio.sessions().length, 0);
});


test('product initialization failure closes owned resources even when synthetic cleanup throws and preserves borrowed WorkStore',
  { timeout: 15000 }, async t => {
  const root = makeFixtureDirectory('arcane-workflow-product-failure-');
  const projectPath = join(root, 'project'), stateDirectory = join(root, 'connection-lab');
  mkdirSync(projectPath); mkdirSync(stateDirectory);
  // Force failure after the real association store opens, without linking paths
  // or changing any permissions. This is an owned fixture file, not host config.
  writeFileSync(join(stateDirectory, 'workflows'), 'fixture blocks directory creation');
  const work = new WorkStore({ directory: join(root, 'work'), projectPath });
  const counters = { actions: 0, closes: 0 };
  const synthetic = syntheticCodex(projectPath, counters);
  synthetic.service.close = async () => { counters.closes++; throw new Error('Synthetic cleanup failure'); };
  t.after(() => {
    work.close();
    const part = relative(fixtureTempDirectory(), resolve(root));
    assert.ok(part && !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep) && !lstatSync(root).isSymbolicLink());
    rmSync(resolve(root), { recursive: true, force: true });
  });
  await assert.rejects(createConnectionLab({ cwd: root, stateDirectory, projectPath, workStore: work,
    codexService: synthetic.service, probe: async () => [] }), { code: 'EEXIST' });
  assert.equal(counters.closes, 1); assert.equal(counters.actions, 0);
  assert.deepEqual(work.runs(), []);
  const associations = new ConversationWorkStore({ directory: join(stateDirectory, 'conversation-work'), projectPath });
  try { assert.equal(associations.projectId, workflowProjectIdentity(projectPath).projectId); }
  finally { associations.close(); }
});
