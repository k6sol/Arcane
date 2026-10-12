import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { workflowNativeModel } from '../../apps/daemon/src/workflow-native-model.js';
import { codexRoutes } from '../../apps/daemon/src/codex-routes.js';
import { createConnectionLab } from '../../apps/daemon/src/lab-server.js';
import { readCodexState } from '../../apps/desktop/src/codex-chat.js';
import type { CodexProductState, CodexService, CodexActionRecord } from '../../apps/daemon/src/codex-service.js';
import type { Model, Operation, Snapshot } from '../../packages/codex-client/src/types.js';
import type { NativeWorkflowModelProof } from '../../packages/protocol/src/workflow-model.js';
import type { WorkflowRecipeRequest } from '../../packages/core/src/workflow-recipes.js';
import { WorkStore, type WorkRun, type WorkTask } from '../../packages/storage/src/work-store.js';
import { workflowProjectIdentity } from '../../packages/storage/src/workflow-store.js';
import { workflowReceiptParent, type WorkflowPreview, type WorkflowReceiptResponse, type WorkflowEvidencePreparationResponse, type WorkflowHostSnapshot } from '../../apps/daemon/src/workflow-host.js';

const CONNECTION = '11111111-1111-4111-8111-111111111111';
const SECOND_CONNECTION = '22222222-2222-4222-8222-222222222222';
const THREAD = 'Model:Fixture.Active.Thread', SESSION = 'Model:Fixture.Active.Session';
function state(projectPath = process.platform === 'win32' ? 'C:\\FixtureProject' : '/fixture-project'): CodexProductState {
  const active = { model: 'fixture-model-a', effort: 'high' };
  const snapshot: Snapshot = { connectionId: CONNECTION, provenance: 'spawned-node-fixture', connected: true, ready: true,
    account: { auth: 'subscription', plan: 'fixture-plan', requiresOpenaiAuth: true },
    models: [
      { model: 'fixture-model-a', id: 'fixture-row-a', displayName: 'Fixture model A', efforts: ['high', 'low', 'future-effort'], defaultEffort: 'high', entitlement: 'unverified' },
      { model: 'fixture-model-b', id: 'fixture-row-b', displayName: 'Fixture model B', efforts: ['medium', 'high'], defaultEffort: 'medium', entitlement: 'unverified' },
    ],
    selection: { model: 'fixture-model-b', effort: 'medium' }, // Picker differs deliberately from the active thread.
    thread: { threadId: THREAD, sessionId: SESSION, selection: active, configured: true, writeGranted: false, turnId: null, turnStatus: 'idle' },
    operations: [], approvals: [], events: [], droppedEvents: 0, lastEventSeq: 0, failureCode: null,
  };
  return { provider: 'codex', use: 'personal-local', projectPath, connecting: false, closing: false, busy: false,
    snapshot, lastSnapshot: null, actions: [], nativeHistory: null, nativeTools: { configured: false, verified: false } };
}
function project(input: CodexProductState) { const result = workflowNativeModel(input); assert.ok(result, 'Valid synthetic public observation must project'); return result; }
function altered(change: (value: CodexProductState, snapshot: Snapshot) => void): CodexProductState {
  const value = state(); change(value, value.snapshot!); return value;
}
function operation(status: Operation['state']): Operation {
  return { operationId: 'Fixture-Operation', method: 'turn/start', requestId: 1, threadId: THREAD, turnId: null, state: status, errorCode: null };
}
function action(status: CodexActionRecord['state'], connectionId = CONNECTION): CodexActionRecord {
  return { requestId: '33333333-3333-4333-8333-333333333333', action: 'select', connectionId, state: status, errorCode: null,
    threadId: THREAD, turnId: null, model: 'fixture-model-a', effort: 'high', createdAt: '2026-10-12T00:00:00.000Z', finishedAt: null };
}

test('projection selects the active thread, emits honest fixture provenance, and never translates future efforts or aliases', () => {
  const source = state(), before = structuredClone(source), result = project(source);
  assert.deepEqual(result.proof.selection, { provider: 'codex', model: 'fixture-model-a', effort: 'high', connectionRevision: result.connection.revision });
  assert.equal(result.proof.version, 1); assert.equal(result.proof.source, 'active-native-thread-catalogue');
  assert.equal(result.proof.threadId, THREAD); assert.equal(result.proof.sessionId, SESSION); assert.equal(result.proof.connectionId, CONNECTION);
  assert.equal(result.proof.entitlement, 'unverified'); assert.equal(result.connection.installed, false);
  assert.ok(result.connection.models.every(model => model.entitlement === 'unverified' && model.source === 'runtime-catalogue'));
  assert.deepEqual(result.connection.models[0]!.efforts, ['high', 'low']);
  assert.ok(!result.connection.models.some(model => model.efforts.some(effort => effort === ('future-effort' as string))));
  assert.equal(result.connection.features[0]!.state, 'native-handoff'); assert.equal(result.connection.features[0]!.route, 'native-client');
  assert.deepEqual(source, before, 'Pure projection cannot mutate observations');
  for (const selected of [{ model: 'fixture-row-a', effort: 'high' }, { model: 'auto', effort: 'high' },
    { model: 'fixture-model-a', effort: 'future-effort' }, { model: 'fixture-model-a', effort: 'medium' },
    { model: 'fixture-model-a ', effort: 'high' }, { model: 'fixture-model-a', effort: 'HIGH' }]) {
    assert.equal(workflowNativeModel(altered((_value, s) => { s.thread!.selection = selected; })), null);
  }
  const futureOnly = altered((_value, s) => { s.models[0]!.efforts = ['future-effort']; s.models[0]!.defaultEffort = 'future-effort'; });
  assert.equal(workflowNativeModel(futureOnly), null, 'No known reported effort means no usable active model');
  const unknownDefault = project(altered((_value, s) => { s.models[0]!.defaultEffort = 'future-effort'; }));
  assert.equal(unknownDefault.connection.models[0]!.defaultEffort, null, 'Unknown default is never substituted');
});

test('revision ignores transport reconnect, display labels, events, progress and picker selection; catalogue order is canonical', () => {
  const baseline = project(state()).connection.revision;
  const cases: Array<[string, (value: CodexProductState, s: Snapshot) => void]> = [
    ['reconnect', (_value, s) => { s.connectionId = SECOND_CONNECTION; }],
    ['display name', (_value, s) => { s.models[0]!.displayName = 'Changed label'; }],
    ['catalogue row ID', (_value, s) => { s.models[0]!.id = 'display-only-row-id'; }],
    ['picker selection', (_value, s) => { s.selection = { model: 'fixture-model-b', effort: 'high' }; }],
    ['missing picker', (_value, s) => { s.selection = null; }],
    ['events', (_value, s) => { s.events = [{ type: 'delta', seq: 1, threadId: THREAD, turnId: 'Fixture-Turn', itemId: 'Fixture-Item', text: 'Synthetic progress' }]; s.lastEventSeq = 1; s.droppedEvents = 3; }],
    ['turn progress', (value, s) => { value.busy = true; s.thread!.turnId = 'Fixture-Turn'; s.thread!.turnStatus = 'inProgress'; }],
    ['terminal operation', (_value, s) => { s.operations = [operation('acknowledged')]; }],
    ['terminal action', (value) => { value.actions = [action('acknowledged')]; }],
    ['historical unresolved action', (value) => { value.actions = [action('unknown', SECOND_CONNECTION)]; }],
    ['catalogue and effort order', (_value, s) => { s.models.reverse(); for (const model of s.models) model.efforts.reverse(); }],
    ['last snapshot', (value) => { value.lastSnapshot = structuredClone(value.snapshot); value.lastSnapshot!.connectionId = SECOND_CONNECTION; }],
  ];
  for (const [label, change] of cases) assert.equal(project(altered(change)).connection.revision, baseline, label);
  assert.match(baseline, /^[a-f0-9]{64}$/);
});

test('revision changes for the exact active pair, usable catalogue and project/thread/session/account/provenance scope', () => {
  const baseline = project(state()).connection.revision;
  const cases: Array<[string, (value: CodexProductState, s: Snapshot) => void]> = [
    ['model', (_value, s) => { s.thread!.selection = { model: 'fixture-model-b', effort: 'high' }; }],
    ['effort', (_value, s) => { s.thread!.selection.effort = 'low'; }],
    ['project', (value) => { value.projectPath += '-other'; }],
    ['thread', (_value, s) => { s.thread!.threadId += '.Other'; }],
    ['session', (_value, s) => { s.thread!.sessionId = 'Model:Fixture.Other.Session'; }],
    ['null session', (_value, s) => { s.thread!.sessionId = null; }],
    ['reported effort', (_value, s) => { s.models[0]!.efforts.push('ultra'); }],
    ['default effort', (_value, s) => { s.models[0]!.defaultEffort = 'low'; }],
    ['new usable model', (_value, s) => { s.models.push({ ...s.models[1]!, model: 'fixture-model-c', id: 'fixture-row-c' }); }],
    ['removed model', (_value, s) => { s.models.pop(); }],
    ['account plan', (_value, s) => { s.account!.plan = 'different-fixture-plan'; }],
    ['installed provenance observation', (_value, s) => { s.provenance = 'installed-cli'; }],
  ];
  for (const [label, change] of cases) assert.notEqual(project(altered(change)).connection.revision, baseline, label);
  const installed = project(altered((_value, s) => { s.provenance = 'installed-cli'; }));
  assert.equal(installed.connection.installed, true); assert.equal(installed.proof.entitlement, 'unverified');
  assert.ok(installed.connection.models.every(model => model.entitlement === 'unverified'));
});

test('v2 catalogue revision survives reconnect while the browser requires a fresh exact live connection proof', () => {
  const observed = state(), initial = project(observed), snapshot = observed.snapshot!;
  const payload = JSON.stringify({ provenance: snapshot.provenance, projectPath: observed.projectPath,
    threadId: snapshot.thread!.threadId, sessionId: snapshot.thread!.sessionId, account: snapshot.account,
    selected: snapshot.thread!.selection,
    models: initial.connection.models.map(m => ({ id: m.id, efforts: m.efforts, defaultEffort: m.defaultEffort, inputModalities: m.inputModalities })) });
  assert.equal(initial.connection.revision, createHash('sha256').update('arcane.workflow.native-catalogue.v2\0').update(payload).digest('hex'));
  assert.notEqual(initial.connection.revision, createHash('sha256').update('arcane.workflow.native-catalogue.v1\0').update(payload).digest('hex'),
    'Changed revision semantics must have a distinct domain.');
  observed.workflowModel = initial.proof;
  assert.doesNotThrow(() => readCodexState(observed));
  snapshot.connectionId = SECOND_CONNECTION;
  const reconnected = project(observed);
  assert.deepEqual(reconnected.proof.selection, initial.proof.selection);
  assert.equal(reconnected.connection.revision, initial.connection.revision);
  assert.equal(reconnected.proof.connectionId, SECOND_CONNECTION);
  assert.equal(initial.proof.connectionId, CONNECTION, 'Old proof must not be rewritten or accepted as fresh.');
  assert.throws(() => readCodexState(observed), /Invalid host-attested active native model/,
    'Stable catalogue revision cannot authorize an old connection proof against a new live snapshot.');
  observed.workflowModel = reconnected.proof;
  assert.doesNotThrow(() => readCodexState(observed));
  assert.equal(reconnected.connection.installed, false, 'Reconnect never upgrades spawned fixture provenance.');

  for (const [label, change] of [
    ['pending current action', (value: CodexProductState) => { value.actions = [action('pending', SECOND_CONNECTION)]; }],
    ['unknown current action', (value: CodexProductState) => { value.actions = [action('unknown', SECOND_CONNECTION)]; }],
    ['disconnected', (value: CodexProductState) => { value.snapshot!.connected = false; }],
    ['not ready', (value: CodexProductState) => { value.snapshot!.ready = false; }],
  ] as const) {
    const unavailable = structuredClone(observed); change(unavailable);
    assert.equal(workflowNativeModel(unavailable), null, label);
  }
});

test('invalid, absent, unconfigured, signed-out and unresolved native observations deny projection', () => {
  assert.equal(workflowNativeModel(null), null);
  const cases: Array<[string, (value: CodexProductState, s: Snapshot) => void]> = [
    ['no snapshot', (value) => { value.snapshot = null; }],
    ['connecting', (value) => { value.connecting = true; }], ['closing', (value) => { value.closing = true; }],
    ['display limited', (value) => { value.displayLimited = true; }],
    ['wrong provider', (value) => { (value as unknown as Record<string, unknown>).provider = 'claude'; }],
    ['wrong use', (value) => { (value as unknown as Record<string, unknown>).use = 'open-source-local'; }],
    ['empty project', (value) => { value.projectPath = ''; }], ['project control', (value) => { value.projectPath += '\n'; }],
    ['project limit', (value) => { value.projectPath = 'p'.repeat(4097); }],
    ['disconnected', (_value, s) => { s.connected = false; }], ['not ready', (_value, s) => { s.ready = false; }],
    ['connection failure', (_value, s) => { s.failureCode = 'Fixture-Failure'; }],
    ['invalid connection ID', (_value, s) => { s.connectionId = 'non-uuid'; }],
    ['invalid provenance', (_value, s) => { (s as unknown as Record<string, unknown>).provenance = 'unknown'; }],
    ['missing thread', (_value, s) => { s.thread = null; }], ['unconfigured thread', (_value, s) => { s.thread!.configured = false; }],
    ['empty thread', (_value, s) => { s.thread!.threadId = ''; }], ['oversized thread', (_value, s) => { s.thread!.threadId = 't'.repeat(257); }],
    ['invalid session', (_value, s) => { s.thread!.sessionId = 'bad/session'; }],
    ['missing selection', (_value, s) => { (s.thread as unknown as Record<string, unknown>).selection = null; }],
    ['missing account', (_value, s) => { s.account = null; }], ['signed out', (_value, s) => { s.account!.auth = 'signed-out'; }],
    ['unsupported account', (_value, s) => { s.account!.auth = 'unsupported'; }], ['unsupported auth mode', (_value, s) => { s.account!.requiresOpenaiAuth = false; }],
    ['pending operation', (_value, s) => { s.operations = [operation('pending')]; }], ['unknown operation', (_value, s) => { s.operations = [operation('unknown')]; }],
    ['pending current action', (value) => { value.actions = [action('pending')]; }], ['unknown current action', (value) => { value.actions = [action('unknown')]; }],
    ['missing catalogue', (_value, s) => { s.models = []; }],
    ['catalogue bound', (_value, s) => { s.models = Array.from({ length: 513 }, (_, i) => ({ ...s.models[0]!, model: 'fixture-' + i })); }],
    ['duplicate model', (_value, s) => { s.models.push(structuredClone(s.models[0]!)); }],
    ['invalid model ID', (_value, s) => { s.models[0]!.model = 'bad/model'; }],
    ['model ID bound', (_value, s) => { s.models[0]!.model = 'm'.repeat(161); }],
    ['empty display name', (_value, s) => { s.models[0]!.displayName = ''; }],
    ['empty efforts', (_value, s) => { s.models[0]!.efforts = []; }],
    ['duplicate effort', (_value, s) => { s.models[0]!.efforts = ['high', 'high']; }],
    ['effort bound', (_value, s) => { s.models[0]!.efforts = Array.from({ length: 17 }, (_, i) => 'future-' + i); }],
    ['claimed entitlement', (_value, s) => { (s.models[0] as unknown as Record<string, unknown>).entitlement = 'verified'; }],
    ['catalogue shape', (_value, s) => { (s as unknown as Record<string, unknown>).models = null; }],
    ['operations shape', (_value, s) => { (s as unknown as Record<string, unknown>).operations = null; }],
    ['actions shape', (value) => { (value as unknown as Record<string, unknown>).actions = null; }],
  ];
  for (const [label, change] of cases) assert.equal(workflowNativeModel(altered(change)), null, label);
});

function serviceDouble(observed: () => CodexProductState, counters: { actions: number; closes: number }): CodexService {
  return { state: () => structuredClone(observed()),
    action: async () => { counters.actions++; throw new Error('Native actions forbidden in this synthetic fixture'); },
    close: async () => { counters.closes++; } };
}
async function closeServer(server: Server) { server.closeAllConnections(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); }
test('codex route projection is opt-in and carries only the host proof without native actions', async t => {
  const observed = state(), counters = { actions: 0, closes: 0 }, service = serviceDouble(() => observed, counters);
  let projection = false, origin = '';
  const plain = codexRoutes(service), opted = codexRoutes(service, { workflowModels: true });
  const server = createServer((request, response) => {
    void (projection ? opted : plain)(request, response, new URL(request.url ?? '/', origin), 'fixture-control', origin, 'fixture-agent')
      .catch(() => { response.writeHead(500); response.end('{}'); });
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  t.after(() => closeServer(server));
  const read = async () => {
    const reply = await fetch(origin + '/v1/codex/state', { headers: { Authorization: 'Bearer fixture-control' }, signal: AbortSignal.timeout(5000) });
    assert.equal(reply.status, 200); return (await reply.json() as { state: CodexProductState }).state;
  };
  assert.equal(Object.hasOwn(await read(), 'workflowModel'), false);
  projection = true; assert.deepEqual((await read()).workflowModel, project(observed).proof);
  observed.snapshot!.account!.auth = 'signed-out'; assert.equal((await read()).workflowModel, null);
  assert.equal(counters.actions, 0); assert.equal(counters.closes, 0);
});

function workDouble() {
  const runs: WorkRun[] = [], tasks = new Map<string, WorkTask>();
  const counts = { creates: 0, ready: 0, forbidden: 0, closes: 0 };
  const forbidden = (): never => { counts.forbidden++; throw new Error('Only workflow metadata creation/read is permitted'); };
  const store = { create(input: { title: string; objective: string; tasks: Array<Pick<WorkTask, 'key' | 'title' | 'instructions' | 'acceptance' | 'dependencies' | 'scope'>> }): WorkRun {
    const id = 'Fixture-Run-' + ++counts.creates, createdAt = '2026-10-12T00:00:00.000Z';
    const run: WorkRun = { id, title: input.title, objective: input.objective, createdAt,
      tasks: input.tasks.map((item, i) => ({ ...structuredClone(item), id: id + '-Task-' + i, runId: id, state: 'pending', worker: null,
        leaseUntil: null, progress: '', evidence: [], reviewNote: null, createdAt, updatedAt: createdAt })) };
    runs.push(run); for (const task of run.tasks) tasks.set(task.id, task); return structuredClone(run);
  }, task(id: string) { const task = tasks.get(id); assert.ok(task); return structuredClone(task); },
  ready(runId?: string) { counts.ready++; return [...tasks.values()].filter(task => (!runId || task.runId === runId) && task.state === 'pending').map(task => structuredClone(task)); },
  runs() { return structuredClone(runs); }, claim: forbidden, submit: forbidden, review: forbidden,
  close() { counts.closes++; }, } as unknown as WorkStore;
  return { store, counts, dump: () => structuredClone(runs) };
}
const recipe = (model: WorkflowRecipeRequest['model']): WorkflowRecipeRequest => ({ deliverable: 'code-change', engine: 'roblox',
  title: 'Offline selected model regression', prompt: 'Create metadata and inspect current context without executing any native action.', scope: ['src'], model });

// Actual product dispatcher; both WorkStore and CodexService are doubles. No StudioStore or provider probe is opened.
test('actual product proof drives exact model preview/execute; stale models deny while completed receipts remain read-only', { timeout: 60000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'arcane-workflow-native-model-')), projectPath = join(root, 'project'), stateDirectory = join(root, 'state');
  mkdirSync(join(projectPath, 'src'), { recursive: true });
  let observed = state(projectPath); const work = workDouble(), counters = { actions: 0, closes: 0, probes: 0 };
  const lab = await createConnectionLab({ cwd: root, projectPath, stateDirectory, port: 0, workStore: work.store,
    codexService: serviceDouble(() => observed, counters), probe: async () => { counters.probes++; throw new Error('Provider discovery is forbidden'); } });
  const receiptParent = workflowReceiptParent(join(stateDirectory, 'workflows'), workflowProjectIdentity(projectPath).projectId);
  t.after(async () => {
    await lab.close();
    if (process.platform === 'win32' && existsSync(receiptParent)) {
      const part = relative(resolve(homedir(), '.arcane-private-receipts-v1'), resolve(receiptParent));
      assert.match(part, /^[a-f0-9]{64}$/); assert.ok(!lstatSync(receiptParent).isSymbolicLink()); rmSync(resolve(receiptParent), { recursive: true, force: true });
    }
    const part = relative(resolve(tmpdir()), resolve(root));
    assert.ok(part && !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep) && !lstatSync(root).isSymbolicLink()); rmSync(resolve(root), { recursive: true, force: true });
    assert.equal(counters.actions, 0); assert.equal(counters.probes, 0); assert.equal(work.counts.forbidden, 0); assert.equal(work.counts.closes, 0);
  });
  const call = async (path: string, input?: unknown, token = lab.token) => {
    const response = await fetch(lab.origin + path, { method: input === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + token, Origin: lab.origin, ...(input === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(15000) });
    const text = await response.text(); return { status: response.status, text, json: JSON.parse(text) as Record<string, unknown> };
  };
  const proof = async () => {
    const reply = await call('/v1/codex/state'); assert.equal(reply.status, 200, reply.text);
    const value = (reply.json.state as CodexProductState).workflowModel; assert.ok(value); return value;
  };
  assert.equal((await call('/v1/codex/state', undefined, lab.agentToken)).status, 403);
  const original = await proof(); assert.deepEqual(original, project(observed).proof); assert.equal(original.entitlement, 'unverified');
  assert.equal(original.selection.model, 'fixture-model-a'); assert.notEqual(original.selection.model, observed.snapshot!.selection!.model);
  const previewReply = await call('/v1/workflows/preview', { action: 'recipe', request: recipe(original.selection) });
  assert.equal(previewReply.status, 200, previewReply.text); const preview = previewReply.json as unknown as WorkflowPreview;
  assert.equal(work.counts.creates, 0); assert.deepEqual(preview.request!.model, original.selection);
  observed.snapshot!.thread!.selection = { model: 'fixture-model-b', effort: 'high' };
  const changed = await proof(); assert.notEqual(changed.selection.connectionRevision, original.selection.connectionRevision);
  for (const model of [original.selection, { ...changed.selection, model: 'auto' }, { ...changed.selection, effort: 'low' as const },
    { ...changed.selection, connectionRevision: 'browser-made-revision' }]) {
    const denied = await call('/v1/workflows/preview', { action: 'recipe', request: recipe(model) });
    assert.equal(denied.status, 409, denied.text); assert.equal(denied.json.error, 'WORKFLOW_MODEL_CURRENT');
  }
  const stale = await call('/v1/workflows/execute', { preview, idempotencyKey: 'stale-key' });
  assert.equal(stale.status, 409, stale.text); assert.equal(stale.json.error, 'WORKFLOW_MODEL_CURRENT'); assert.equal(work.counts.creates, 0);
  observed.snapshot!.account!.auth = 'signed-out';
  assert.equal((await call('/v1/codex/state')).json.state && ((await call('/v1/codex/state')).json.state as CodexProductState).workflowModel, null);
  const unavailable = await call('/v1/workflows/preview', { action: 'recipe', request: recipe(changed.selection) });
  assert.equal(unavailable.status, 409, unavailable.text); assert.equal(unavailable.json.error, 'WORKFLOW_MODEL_CURRENT');
  const planning = await call('/v1/workflows/preview', { action: 'recipe', request: recipe(null) });
  assert.equal(planning.status, 200, planning.text); assert.equal((planning.json as unknown as WorkflowPreview).request!.model, null);
  assert.equal(work.counts.creates, 0, 'Null planning preview does not create work or native actions');
  observed = state(projectPath);
  const fresh = await proof(), freshReply = await call('/v1/workflows/preview', { action: 'recipe', request: recipe(fresh.selection) });
  assert.equal(freshReply.status, 200, freshReply.text); const creation = { preview: freshReply.json as unknown as WorkflowPreview, idempotencyKey: 'completed-key' };
  const done = await call('/v1/workflows/execute', creation); assert.equal(done.status, 200, done.text); assert.equal(work.counts.creates, 1);
  assert.deepEqual(done.json.conversation, { provider: 'codex', threadId: THREAD, sessionId: SESSION });
  observed.snapshot!.thread!.selection = { model: 'fixture-model-b', effort: 'high' };
  const before = work.dump(), ready = work.counts.ready, receiptReply = await call('/v1/workflows/receipt', creation);
  assert.equal(receiptReply.status, 200, receiptReply.text); const receipt = receiptReply.json as unknown as WorkflowReceiptResponse;
  assert.equal(receipt.state, 'done'); assert.equal(receipt.association, 'bound'); assert.equal(receipt.snapshotStatus, 'available'); assert.equal(receipt.retry, false);
  assert.deepEqual(receipt.snapshot!.conversation, { provider: 'codex', threadId: THREAD, sessionId: SESSION });
  assert.equal(work.counts.ready, ready, 'Completed receipt read cannot call WorkStore.ready'); assert.deepEqual(work.dump(), before);
  const replay = await call('/v1/workflows/execute', creation);
  assert.equal(replay.status, 409, replay.text); assert.equal(replay.json.error, 'WORKFLOW_MODEL_CURRENT'); assert.equal(work.counts.creates, 1);
  assert.equal(counters.actions, 0); assert.equal(counters.probes, 0); assert.equal(work.counts.forbidden, 0);
});

// Borrowed synthetic installed-cli metadata exercises policy prerequisites only.
// No installed CLI is constructed or started: every CodexService action is forbidden.
// The separate projection case above keeps spawned-node-fixture installed:false.
test('actual host retains a gated recipe across metadata reconnect using borrowed synthetic installed-cli observations', { timeout: 60000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'arcane-workflow-reconnect-')), projectPath = join(root, 'project'), stateDirectory = join(root, 'state');
  mkdirSync(join(projectPath, 'src'), { recursive: true });
  const brief = Buffer.from('Owned offline brief: retain this exact project, native thread, model and human gate across reconnect.\n');
  writeFileSync(join(projectPath, 'src', 'brief.txt'), brief);
  const observed = state(projectPath), counters = { actions: 0, closes: 0, probes: 0 };
  observed.snapshot!.provenance = 'installed-cli'; // Explicitly synthetic public metadata, not an installed-client proof.
  t.diagnostic('Borrowed synthetic installed-cli metadata only; no actual CLI/native turn/provider probe is permitted.');
  const work = new WorkStore({ directory: join(stateDirectory, 'borrowed-work'), projectPath });
  const receiptParent = workflowReceiptParent(join(stateDirectory, 'workflows'), workflowProjectIdentity(projectPath).projectId);
  let lab: Awaited<ReturnType<typeof createConnectionLab>> | undefined;
  t.after(async () => {
    try {
      await lab?.close();
      assert.doesNotThrow(() => work.runs(), 'Product close must leave the borrowed WorkStore open.');
      assert.equal(counters.actions, 0); assert.equal(counters.probes, 0);
    } finally {
      work.close();
      try {
        if (process.platform === 'win32' && existsSync(receiptParent)) {
          const part = relative(resolve(homedir(), '.arcane-private-receipts-v1'), resolve(receiptParent));
          assert.match(part, /^[a-f0-9]{64}$/); assert.ok(!lstatSync(receiptParent).isSymbolicLink());
          rmSync(resolve(receiptParent), { recursive: true, force: true });
        }
      } finally {
        const part = relative(resolve(tmpdir()), resolve(root));
        assert.ok(part && !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep) && !lstatSync(root).isSymbolicLink());
        rmSync(resolve(root), { recursive: true, force: true });
      }
    }
  });
  lab = await createConnectionLab({ cwd: root, projectPath, stateDirectory, port: 0, workStore: work,
    codexService: serviceDouble(() => observed, counters), probe: async () => { counters.probes++; throw new Error('Provider discovery is forbidden'); } });
  const app = lab, native = { provider: 'codex', threadId: THREAD, sessionId: SESSION };
  const call = async (path: string, input?: unknown, token = app.token) => {
    const response = await fetch(app.origin + path, { method: input === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + token, Origin: app.origin, ...(input === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(15000) });
    const text = await response.text(); return { status: response.status, text, json: JSON.parse(text) as Record<string, unknown> };
  };
  const ok = async (path: string, input?: unknown) => {
    const reply = await call(path, input); assert.equal(reply.status, 200, reply.text); return reply.json;
  };
  const proof = async () => {
    const value = (await ok('/v1/codex/state')).state as CodexProductState;
    readCodexState(value); assert.ok(value.workflowModel); return value.workflowModel;
  };
  const initial = await proof(), request = recipe(initial.selection);
  const metadata = project(observed), s = observed.snapshot!;
  const legacyRevision = createHash('sha256').update('arcane.workflow.native-catalogue.v1\0').update(JSON.stringify({
    connectionId: s.connectionId, provenance: s.provenance, projectPath: observed.projectPath,
    threadId: s.thread!.threadId, sessionId: s.thread!.sessionId, account: s.account, selected: s.thread!.selection,
    models: metadata.connection.models.map(m => ({ id: m.id, efforts: m.efforts, defaultEffort: m.defaultEffort, inputModalities: m.inputModalities })),
  })).digest('hex');
  const legacyRequest = recipe({ ...initial.selection, connectionRevision: legacyRevision }), preservedLegacy = structuredClone(legacyRequest);
  const legacyDenied = await call('/v1/workflows/preview', { action: 'recipe', request: legacyRequest });
  assert.equal(legacyDenied.status, 409, legacyDenied.text); assert.equal(legacyDenied.json.error, 'WORKFLOW_MODEL_CURRENT');
  assert.deepEqual(legacyRequest, preservedLegacy, 'A genuine v1 mismatch must not be silently rebound to v2.');
  assert.equal(work.runs().length, 0, 'A legacy request requires a new explicit human-reviewed recipe, not automatic migration.');
  const preview = await ok('/v1/workflows/preview', { action: 'recipe', request }) as unknown as WorkflowPreview;
  const creation = { preview, idempotencyKey: 'reconnect-create' };
  assert.equal(work.runs().length, 0, 'Preview does not create a run.');
  observed.connecting = true; observed.snapshot!.connected = false;
  assert.equal(((await ok('/v1/codex/state')).state as CodexProductState).workflowModel, null);
  const unavailable = await call('/v1/workflows/execute', creation);
  assert.equal(unavailable.status, 409, unavailable.text); assert.equal(unavailable.json.error, 'WORKFLOW_MODEL_CURRENT');
  assert.equal(work.runs().length, 0, 'Transport downtime cannot execute the prepared recipe.');
  observed.connecting = false; observed.snapshot!.connected = true; observed.snapshot!.connectionId = SECOND_CONNECTION;
  const reconnected = await proof();
  assert.equal(reconnected.connectionId, SECOND_CONNECTION); assert.deepEqual(reconnected.selection, initial.selection);
  await ok('/v1/workflows/preview', { action: 'recipe', request });
  const created = await ok('/v1/workflows/execute', creation) as unknown as WorkflowHostSnapshot;
  assert.equal(work.runs().length, 1); assert.deepEqual(created.conversation, native);
  const workflowId = created.workflow.id, promptTask = created.workflow.taskIds.prompt!, requirementsTask = created.workflow.taskIds.requirements!;
  const beforeEvidence = work.task(promptTask);
  const evidence = await ok('/v1/workflows/evidence', { workflowId, stepKey: 'prompt', files: [{ path: 'src/brief.txt', role: 'brief' }] }) as unknown as WorkflowEvidencePreparationResponse;
  const briefHash = createHash('sha256').update(brief).digest('hex');
  assert.deepEqual(evidence.submission.artifacts, [{ path: 'src/brief.txt', role: 'brief', sha256: briefHash, bytes: brief.length }]);
  assert.deepEqual(work.task(promptTask), beforeEvidence, 'Evidence preparation is read-only.');
  const decide = async (input: unknown, key: string, result: string) => {
    const prepared = await ok('/v1/workflows/preview', input) as unknown as WorkflowPreview;
    const value = await ok('/v1/workflows/execute', { preview: prepared, idempotencyKey: key });
    assert.equal(value.result, result); return value as unknown as WorkflowHostSnapshot;
  };
  await decide({ action: 'handoff', workflowId, submission: evidence.submission }, 'reconnect-brief', 'submitted');
  const reviewed = await decide({ action: 'review', workflowId, stepKey: 'prompt', decision: 'approved' }, 'reconnect-review', 'reviewed');
  assert.equal(work.task(promptTask).state, 'complete');
  const beforeGate = reviewed.assessment!.steps.find(step => step.key === 'requirements')!;
  assert.equal(beforeGate.disposition, 'pending');
  assert.ok(beforeGate.blockers.some(b => b.code === 'human' && b.requirement === 'model-handoff'));
  assert.ok(!beforeGate.blockers.some(b => b.code === 'provider'), JSON.stringify(beforeGate));
  const draftDenied = await call('/v1/workflows/draft', { workflowId, stepKey: 'requirements' });
  assert.equal(draftDenied.status, 409, draftDenied.text); assert.equal(draftDenied.json.error, 'WORKFLOW_BLOCKED');
  const gatePreview = await ok('/v1/workflows/preview', { action: 'gate', workflowId, stepKey: 'requirements', gate: 'model-handoff', decision: 'approved' }) as unknown as WorkflowPreview;
  assert.deepEqual(gatePreview.prepared.subjectHashes, [briefHash]);
  observed.snapshot!.connectionId = CONNECTION; // A second metadata-only transport reconnect, same exact context.
  const refreshed = await proof();
  assert.equal(refreshed.connectionId, CONNECTION); assert.deepEqual(refreshed.selection, initial.selection);
  const gated = await ok('/v1/workflows/execute', { preview: gatePreview, idempotencyKey: 'reconnect-gate' });
  assert.equal(gated.result, 'decided');
  const current = await ok('/v1/workflows/' + workflowId) as unknown as WorkflowHostSnapshot;
  assert.deepEqual(current.conversation, native);
  const requirements = current.assessment!.steps.find(step => step.key === 'requirements')!;
  assert.equal(requirements.disposition, 'human-handoff', JSON.stringify(requirements)); assert.deepEqual(requirements.blockers, []);
  assert.equal(work.task(requirementsTask).state, 'pending', 'Human handoff readiness never starts a native turn.');
  for (const [key, capability] of [['implementation', 'local.patch'], ['verification', 'local.code.verify']] as const) {
    const assessment = current.assessment!.steps.find(step => step.key === key)!;
    assert.equal(assessment.disposition, 'pending');
    assert.ok(assessment.blockers.some(b => b.code === 'capability' && b.requirement === capability), JSON.stringify(assessment));
  }
  const beforeDraft = work.runs(), draft = await ok('/v1/workflows/draft', { workflowId, stepKey: 'requirements' });
  assert.deepEqual(draft.model, initial.selection); assert.deepEqual(draft.conversation, native);
  assert.equal(draft.startsNativeTurn, false); assert.equal(draft.requiresHumanSubmit, true);
  assert.deepEqual(work.runs(), beforeDraft, 'Draft preparation cannot mutate or execute work.');
  assert.equal((await call('/v1/workflows/preview', { action: 'recipe', request }, app.agentToken)).status, 403);
  const replay = await ok('/v1/workflows/execute', creation) as unknown as WorkflowHostSnapshot;
  assert.equal(replay.workflow.id, workflowId); assert.equal(work.runs().length, 1, 'Reconnect never duplicates the recipe.');
  const receipt = await ok('/v1/workflows/receipt', creation) as unknown as WorkflowReceiptResponse;
  assert.equal(receipt.state, 'done'); assert.equal(receipt.association, 'bound'); assert.equal(receipt.retry, false);
  assert.deepEqual(receipt.snapshot!.conversation, native); assert.deepEqual(work.runs(), beforeDraft);
  assert.equal(counters.actions, 0); assert.equal(counters.probes, 0);
});
