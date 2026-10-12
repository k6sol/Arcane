import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WorkStore } from '../../packages/storage/src/work-store.js';
import { ConversationWorkStore, type NativeConversation } from '../../packages/storage/src/conversation-work-store.js';
import { workflowProjectIdentity, type WorkflowCommand } from '../../packages/storage/src/workflow-store.js';
import { createWorkflowHost, workflowReceiptParent, WORKFLOW_HTTP_LIMITS, type WorkflowHost, type WorkflowPreview, type WorkflowReceiptResponse } from '../../apps/daemon/src/workflow-host.js';
import { WorkflowService, WORKFLOW_RECEIPT_LIMITS } from '../../apps/daemon/src/workflow-service.js';
import { workflowRoutes } from '../../apps/daemon/src/workflow-routes.js';
import type { WorkflowRecipeRequest } from '../../packages/core/src/workflow-recipes.js';

const native: NativeConversation = { provider: 'codex', threadId: 'Fixture:Thread.Exact', sessionId: 'Fixture:Session.Exact' };
const recipe = (): WorkflowRecipeRequest => ({ deliverable: 'code-change', engine: 'roblox', title: 'Offline receipt fixture',
  prompt: 'Observe the exact recorded outcome without any runner.', scope: ['src'], model: null });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value);
}
interface Reply { status: number; text: string; headers: IncomingHttpHeaders }
const json = <T = Record<string, unknown>>(reply: Reply) => JSON.parse(reply.text) as T;
interface Wire { method?: string; token?: string; origin?: string | null; headers?: Record<string, string | string[]>; raw?: string | Buffer; target?: string }
async function fixture(t: test.TestContext, settings: { unscoped?: boolean; equalTokens?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'arcane-workflow-receipts-')), projectPath = join(root, 'project'), directory = join(root, 'state');
  mkdirSync(projectPath); mkdirSync(join(projectPath, 'src'));
  let now = Date.now(), contextFailure = false, conversation: NativeConversation | null = structuredClone(native);
  const work = new WorkStore({ directory, projectPath, now: () => now });
  const associations = new ConversationWorkStore({ directory, projectPath });
  const receiptParent = workflowReceiptParent(directory, workflowProjectIdentity(projectPath).projectId), keyFile = join(receiptParent, 'workflow-human-receipts', 'key-v1');
  const token = 'fixture-human-' + randomUUID(), agentToken = settings.equalTokens ? token : 'fixture-agent-' + randomUUID();
  const options = { directory, projectPath, workStore: { store: work, projectPath },
    ...(settings.unscoped ? {} : { conversation: () => conversation, workAssociations: associations }),
    policyContext: () => { if (contextFailure) throw new Error('PRIVATE-CONTEXT'); return {}; },
  };
  let host: WorkflowHost = createWorkflowHost(options), route = workflowRoutes(host), origin = '';
  const server = createServer((request, response) => {
    void route(request, response, new URL(request.url ?? '/', origin), token, origin, agentToken).then(handled => {
      if (!handled) { response.writeHead(404); response.end('{}'); }
    }).catch(() => { if (!response.headersSent) response.writeHead(500); response.end('{"error":"fixture"}'); });
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  t.after(async () => {
    host.close(); associations.close(); work.close(); server.closeAllConnections();
    await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    if (process.platform === 'win32') {
      const part = relative(resolve(homedir(), '.arcane-private-receipts-v1'), resolve(receiptParent));
      assert.match(part, /^[a-f0-9]{64}$/); assert.ok(!lstatSync(receiptParent).isSymbolicLink());
      rmSync(resolve(receiptParent), { recursive: true, force: true });
    }
    const part = relative(resolve(tmpdir()), resolve(root));
    assert.ok(part && !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep) && !lstatSync(root).isSymbolicLink());
    rmSync(resolve(root), { recursive: true, force: true });
  });
  const call = (path: string, input?: unknown, wire: Wire = {}): Promise<Reply> => new Promise((done, reject) => {
    const raw = wire.raw ?? (input === undefined ? undefined : JSON.stringify(input));
    const request = httpRequest(origin + path, { method: wire.method ?? (raw === undefined ? 'GET' : 'POST'),
      ...(wire.target ? { path: wire.target } : {}), headers: { Authorization: 'Bearer ' + (wire.token ?? token),
        ...(wire.origin === null ? {} : { Origin: wire.origin ?? origin }),
        ...(raw === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(raw)) }), ...wire.headers },
    }, response => {
      const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => done({ status: response.statusCode!, text: Buffer.concat(chunks).toString('utf8'), headers: response.headers })); response.on('error', reject);
    });
    request.on('error', reject); request.setTimeout(20000, () => request.destroy(new Error('Offline receipt deadline'))); request.end(raw);
  });
  const preview = async (input: unknown = { action: 'recipe', request: recipe() }) => {
    const reply = await call('/v1/workflows/preview', input); assert.equal(reply.status, 200, reply.text); return json<WorkflowPreview>(reply);
  };
  const execute = (preview: WorkflowPreview, idempotencyKey: string) => call('/v1/workflows/execute', { preview, idempotencyKey });
  const lookup = (preview: WorkflowPreview, idempotencyKey: string, wire: Wire = {}) => call('/v1/workflows/receipt', { preview, idempotencyKey }, wire);
  const create = async () => {
    const p = await preview(), key = randomUUID(), reply = await execute(p, key); assert.equal(reply.status, 200, reply.text);
    return { p, key, id: json<{ workflow: { id: string } }>(reply).workflow.id, reply };
  };
  const sql = (file: string, action: (db: DatabaseSync) => void) => { const db = new DatabaseSync(join(directory, file)); try { action(db); } finally { db.close(); } };
  const command = (key: string, change: (command: WorkflowCommand) => void) => sql('workflow.sqlite', db => {
    const row = db.prepare('SELECT payload FROM workflow_commands WHERE key=?').get(key)!;
    const record = JSON.parse(String(row.payload)) as WorkflowCommand; change(record);
    db.prepare('UPDATE workflow_commands SET payload=? WHERE key=?').run(JSON.stringify(record), key);
  });
  const dump = () => {
    const out: Record<string, unknown> = {};
    for (const [file, tables] of [['workflow.sqlite', ['workflows', 'workflow_commands']], ['work.sqlite', ['runs', 'tasks']], ['conversation-work.sqlite', ['conversation_work_bindings']]] as const) {
      const db = new DatabaseSync(join(directory, file), { readOnly: true });
      try { for (const table of tables) out[table] = db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all(); } finally { db.close(); }
    }
    return out;
  };
  return { root, projectPath, directory, work, associations, token, agentToken, origin, keyFile, call, preview, execute, lookup, create, sql, command, dump,
    restart: () => { host.close(); host = createWorkflowHost(options); route = workflowRoutes(host); }, host: () => host,
    context: (value: NativeConversation | null) => { conversation = value; }, expire: () => { now += 86400000; },
    breakContext: () => { contextFailure = true; } };
}

// All identifiers and observations below are synthetic. No provider file, native launch or Studio access.
test('exact unrecorded and done lookup observes one command without executing or replaying', async t => {
  const f = await fixture(t), p = await f.preview(), key = randomUUID();
  const absent = await f.lookup(p, key); assert.equal(absent.status, 200, absent.text);
  assert.deepEqual(json(absent), { state: 'not-recorded', command: null, association: null, snapshot: null, snapshotStatus: 'not-recorded', retry: false });
  const execution = await f.execute(p, key); assert.equal(execution.status, 200, execution.text);
  const id = json<{ workflow: { id: string } }>(execution).workflow.id, before = f.dump();
  let creates = 0, binds = 0;
  f.work.create = () => { creates++; throw new Error('Must not recreate'); };
  f.associations.bind = () => { binds++; throw new Error('Must not bind'); };
  f.host().execute = () => { throw new Error('Must not dispatch execute'); };
  const reply = await f.lookup(p, key); assert.equal(reply.status, 200, reply.text);
  const receipt = json<WorkflowReceiptResponse>(reply);
  assert.deepEqual(receipt.command, { idempotencyKey: key, kind: 'create-recipe', workflowId: id, result: 'created' });
  assert.equal(receipt.state, 'done'); assert.equal(receipt.association, 'bound'); assert.equal(receipt.snapshotStatus, 'available');
  assert.deepEqual(receipt.snapshot?.conversation, native); assert.equal(receipt.retry, false);
  assert.deepEqual(f.dump(), before); assert.equal(creates, 0); assert.equal(binds, 0);
  assert.equal(reply.headers['cache-control'], 'no-store'); assert.equal(reply.headers['x-content-type-options'], 'nosniff');
});

test('restart attests list/get/current-flow/execute and receipt snapshots from persisted binding', async t => {
  const f = await fixture(t), created = await f.create();
  assert.deepEqual(json(created.reply).conversation, native); f.restart();
  for (const path of ['/v1/workflows', '/v1/workflows/' + created.id, '/v1/workflows/current-flow']) {
    const reply = await f.call(path); assert.equal(reply.status, 200, reply.text); assert.deepEqual(json(reply).conversation, native);
  }
  const receipt = await f.lookup(created.p, created.key); assert.equal(receipt.status, 200, receipt.text);
  assert.deepEqual(json<WorkflowReceiptResponse>(receipt).snapshot?.conversation, native);
  assert.deepEqual(json(await f.execute(created.p, created.key)).conversation, native);
  const shape = json<WorkflowReceiptResponse>(receipt).snapshot!.conversation!;
  assert.deepEqual(Object.keys(shape).sort(), ['provider', 'sessionId', 'threadId']);
});

test('running and uncertain metadata remain read-only before and after restart', async t => {
  const f = await fixture(t), created = await f.create();
  for (const state of ['running', 'uncertain'] as const) {
    f.command(created.key, record => { record.state = state; record.result = null; });
    const before = f.dump(), reply = await f.lookup(created.p, created.key); assert.equal(reply.status, 200, reply.text);
    assert.equal(json<WorkflowReceiptResponse>(reply).state, state); assert.equal(json<WorkflowReceiptResponse>(reply).command?.result, null);
    assert.equal(json(reply).retry, false); assert.deepEqual(f.dump(), before);
  }
  f.command(created.key, record => { record.state = 'running'; record.result = null; }); f.restart();
  const reply = await f.lookup(created.p, created.key); assert.equal(json(reply).state, 'uncertain');
});

test('failed association remains unknown after done lookup and restart; no attribution is invented', async t => {
  const f = await fixture(t), p = await f.preview(), key = randomUUID();
  let binds = 0; f.associations.bind = () => { binds++; throw new Error('Offline association failure'); };
  assert.equal((await f.execute(p, key)).status, 202); assert.equal(binds, 1);
  const before = f.dump();
  for (let i = 0; i < 2; i++) {
    const reply = await f.lookup(p, key); assert.equal(reply.status, 200, reply.text);
    const receipt = json<WorkflowReceiptResponse>(reply);
    assert.equal(receipt.state, 'done'); assert.equal(receipt.association, 'unknown'); assert.equal(receipt.snapshot, null);
    assert.equal(receipt.snapshotStatus, 'unbound'); assert.equal(receipt.retry, false);
    assert.equal(f.associations.binding('workflow', receipt.command!.workflowId), null);
    assert.equal(binds, 1); assert.deepEqual(f.dump(), before);
    if (i === 0) f.restart();
  }
  assert.equal(json(await f.call('/v1/workflows')).conversation, undefined);
  assert.equal(json(await f.call('/v1/workflows/current-flow')), null);
});

test('unscoped hosts preserve original snapshot shapes and cannot attest a receipt association', async t => {
  const f = await fixture(t, { unscoped: true }), created = await f.create();
  for (const reply of [created.reply, await f.call('/v1/workflows'), await f.call('/v1/workflows/' + created.id), await f.call('/v1/workflows/current-flow')]) {
    assert.equal(reply.status, 200, reply.text); assert.equal(Object.hasOwn(json(reply), 'conversation'), false);
  }
  const receipt = json<WorkflowReceiptResponse>(await f.lookup(created.p, created.key));
  assert.equal(receipt.state, 'done'); assert.equal(receipt.association, 'unscoped'); assert.equal(receipt.snapshot, null);
});

test('provider/thread/session/null/case and forged conversation envelopes cannot probe receipt metadata', async t => {
  const f = await fixture(t), created = await f.create();
  for (const changed of [{ ...native, provider: 'claude-code' as const }, { ...native, threadId: 'Other-thread' },
    { ...native, sessionId: 'Other-session' }, { ...native, sessionId: null }, { ...native, threadId: native.threadId.toLowerCase() }]) {
    f.context(changed); const denied = await f.lookup(created.p, created.key); assert.equal(denied.status, 403, denied.text);
    assert.ok(!denied.text.includes(created.id));
    const forged = structuredClone(created.p); forged.conversation = changed;
    assert.equal((await f.lookup(forged, created.key)).status, 403);
  }
  f.context(null); assert.equal((await f.lookup(created.p, created.key)).status, 403);
  f.context(native); assert.equal((await f.lookup(created.p, created.key)).status, 200);
});

test('altered prepared/request/receipt, wrong recorded keys and cross-project previews fail exactly', async t => {
  const f = await fixture(t), created = await f.create(), second = await f.create();
  assert.equal((await f.lookup(created.p, second.key)).status, 409);
  assert.equal(json(await f.lookup(created.p, randomUUID())).state, 'not-recorded');
  for (const change of [(p: WorkflowPreview) => { p.prepared.decision = 'rejected'; },
    (p: WorkflowPreview) => { p.prepared.workflowId = created.id; },
    (p: WorkflowPreview) => { p.receiptHash = 'a'.repeat(64); }]) {
    const changed = structuredClone(created.p); change(changed); assert.equal((await f.lookup(changed, created.key)).status, 403);
  }
  const changed = structuredClone(created.p); changed.request!.prompt = 'Altered outer request';
  assert.equal((await f.lookup(changed, created.key)).status, 409);
  const other = await fixture(t); assert.equal((await other.lookup(created.p, created.key)).status, 403);
});

test('receipt route enforces human-only origin/header controls before opening host storage', async t => {
  const f = await fixture(t);
  for (const wire of [{ token: f.agentToken }, { origin: null }, { origin: 'http://evil.invalid' }, { headers: { 'Sec-Fetch-Site': 'cross-site' } }]) {
    assert.equal((await f.call('/v1/workflows/receipt', {}, wire)).status, 403);
  }
  assert.equal((await f.call('/v1/workflows/receipt', {}, { token: 'wrong' })).status, 401);
  assert.equal((await f.call('/v1/workflows/receipt')).status, 405);
  assert.equal(existsSync(f.keyFile), false);
  const equal = await fixture(t, { equalTokens: true }); assert.equal((await equal.call('/v1/workflows/receipt', {})).status, 403);
  const request = { method: 'POST', headers: { host: new URL(f.origin).host, authorization: 'Bearer ' + f.agentToken, origin: f.origin },
    rawHeaders: ['Host', new URL(f.origin).host, 'Authorization', 'Bearer ' + f.agentToken, 'Origin', f.origin] } as IncomingMessage;
  assert.throws(() => f.host().receipt({}, request, { controlToken: f.token, origin: f.origin, agentToken: f.agentToken }), { status: 403 });
});

test('receipt uses identical strict JSON, body bounds, duplicate singleton checks and target rules', async t => {
  const f = await fixture(t);
  for (const raw of ['{"preview":{},"preview":{}}', '{"preview":{},"\\u0070review":{}}', '{"__proto__":{}}', '['.repeat(20) + '0' + ']'.repeat(20), '{"x":1e999}', Buffer.from([123, 34, 255, 34, 58, 49, 125])]) {
    assert.equal((await f.call('/v1/workflows/receipt', undefined, { raw })).status, 400);
  }
  assert.equal((await f.call('/v1/workflows/receipt', undefined, { raw: ' '.repeat(WORKFLOW_HTTP_LIMITS.bodyBytes + 1) })).status, 413);
  assert.equal((await f.call('/v1/workflows/receipt', {}, { headers: { 'Content-Encoding': 'gzip' } })).status, 415);
  assert.equal((await f.call('/v1/workflows/receipt', {}, { headers: { Origin: [f.origin, f.origin] } })).status, 400);
  assert.equal((await f.call('/v1/workflows/receipt', {}, { headers: { 'Content-Type': ['application/json', 'application/json'] } })).status, 400);
  for (const target of ['/v1/workflows/receipt?', '/v1/workflows/x/../receipt', f.origin + '/v1/workflows/receipt']) {
    assert.equal((await f.call('/v1/workflows/receipt', {}, { target })).status, 400);
  }
  assert.equal(existsSync(f.keyFile), false);
});

test('receipt lookup never expires an unrelated worker lease or invokes verifier/work mutations', async t => {
  const f = await fixture(t), created = await f.create();
  const run = f.work.create({ title: 'Unrelated work', objective: 'Preserve lease', tasks: [{ key: 'other', title: 'Other',
    instructions: 'Offline', acceptance: 'Offline', scope: ['src'], dependencies: [] }] });
  f.work.claim({ taskId: run.tasks[0]!.id, worker: 'offline-worker' }); f.expire();
  const before = f.dump(); f.work.ready = () => { throw new Error('Lease expiry must not run'); };
  f.work.claim = () => { throw new Error('Claim must not run'); }; f.work.submit = () => { throw new Error('Handoff must not run'); };
  f.work.review = () => { throw new Error('Review must not run'); };
  const reply = await f.lookup(created.p, created.key); assert.equal(reply.status, 200, reply.text);
  assert.equal(json(reply).snapshotStatus, 'available'); assert.deepEqual(f.dump(), before);
  assert.equal(f.work.task(run.tasks[0]!.id).state, 'in_progress');
});

test('bounded receipt metadata survives unavailable and oversized current snapshots', async t => {
  const f = await fixture(t), created = await f.create();
  f.sql('work.sqlite', db => {
    const row = db.prepare('SELECT id,payload FROM tasks LIMIT 1').get()!, task = JSON.parse(String(row.payload)) as Record<string, unknown>;
    task.progress = 'x'.repeat(WORKFLOW_RECEIPT_LIMITS.responseBytes); db.prepare('UPDATE tasks SET payload=? WHERE id=?').run(JSON.stringify(task), String(row.id));
  });
  const reply = await f.lookup(created.p, created.key); assert.equal(reply.status, 200, reply.text);
  const receipt = json<WorkflowReceiptResponse>(reply);
  assert.equal(receipt.state, 'done'); assert.equal(receipt.association, 'bound'); assert.equal(receipt.snapshot, null); assert.equal(receipt.snapshotStatus, 'too-large');
  assert.ok(Buffer.byteLength(reply.text) <= WORKFLOW_RECEIPT_LIMITS.responseBytes);
  f.breakContext(); const unavailable = await f.lookup(created.p, created.key); assert.equal(unavailable.status, 200, unavailable.text);
  assert.equal(json(unavailable).snapshotStatus, 'unavailable'); assert.equal(json(unavailable).state, 'done');
});

test('reconciliation lookup binds resolution/run envelope and remains valid after current operation changes', async t => {
  const f = await fixture(t), p = await f.preview(), key = randomUUID();
  const create = f.work.create.bind(f.work); f.work.create = input => { create(input); throw new Error('Offline lost create response'); };
  assert.equal((await f.execute(p, key)).status, 202);
  let id = ''; f.sql('workflow.sqlite', db => { id = String(db.prepare('SELECT id FROM workflows LIMIT 1').get()!.id); });
  f.associations.bind({ conversation: native, kind: 'workflow', id });
  const halt = await f.preview({ action: 'reconcile', workflowId: id, resolution: 'halt' }), haltKey = randomUUID();
  assert.equal(json(await f.lookup(halt, haltKey)).state, 'not-recorded');
  const changed = structuredClone(halt); changed.resolution = 'accept-observed';
  assert.equal((await f.lookup(changed, haltKey)).status, 409);
  const runChanged = structuredClone(halt); runChanged.observedRun = { runId: 'different-run', taskIds: { prompt: 'different-task' } };
  assert.equal((await f.lookup(runChanged, haltKey)).status, 409);
  assert.equal((await f.execute(halt, haltKey)).status, 200);
  const before = f.dump(), reply = await f.lookup(halt, haltKey); assert.equal(reply.status, 200, reply.text);
  const receipt = json<WorkflowReceiptResponse>(reply);
  assert.equal(receipt.state, 'done'); assert.equal(receipt.command?.result, 'reconciled'); assert.equal(receipt.snapshot?.workflow.state, 'halted');
  assert.deepEqual(receipt.snapshot?.conversation, native); assert.deepEqual(f.dump(), before);
  assert.equal(json(await f.lookup(p, key)).state, 'uncertain');
});

test('post-handoff and review receipts use their original prepared representation without a fresh action', async t => {
  const f = await fixture(t), created = await f.create(), bytes = Buffer.from('Actual offline brief.');
  writeFileSync(join(f.projectPath, 'src/brief.txt'), bytes);
  const submission = { key: 'prompt', artifacts: [{ path: 'src/brief.txt', role: 'brief', sha256: hash(bytes.toString()), bytes: bytes.length }], subjectHashes: [], checks: [] };
  const handoff = await f.preview({ action: 'handoff', workflowId: created.id, submission }), handoffKey = randomUUID();
  assert.equal((await f.execute(handoff, handoffKey)).status, 200);
  assert.equal(json<WorkflowReceiptResponse>(await f.lookup(handoff, handoffKey)).command?.result, 'submitted');
  const review = await f.preview({ action: 'review', workflowId: created.id, stepKey: 'prompt', decision: 'approved' }), reviewKey = randomUUID();
  assert.equal((await f.execute(review, reviewKey)).status, 200);
  f.restart();
  const before = f.dump(), reply = await f.lookup(review, reviewKey); assert.equal(reply.status, 200, reply.text);
  assert.equal(json<WorkflowReceiptResponse>(reply).command?.result, 'reviewed'); assert.deepEqual(f.dump(), before);
  assert.deepEqual(json<WorkflowReceiptResponse>(await f.lookup(handoff, handoffKey)).snapshot?.conversation, native);
});

test('journal receipt identity/corruption mismatches never leak a replacement command', async t => {
  const f = await fixture(t), created = await f.create();
  f.command(created.key, record => { record.receiptHash = 'b'.repeat(64); });
  assert.equal((await f.lookup(created.p, created.key)).status, 409);
  f.command(created.key, record => { record.receiptHash = created.p.receiptHash; record.kind = 'review-evidence'; });
  assert.equal((await f.lookup(created.p, created.key)).status, 409);
  f.command(created.key, record => { record.kind = 'create-recipe'; record.workflowId = 'another-id'; });
  assert.equal((await f.lookup(created.p, created.key)).status, 404);
  f.command(created.key, record => { record.workflowId = created.id; (record as unknown as Record<string, unknown>).unexpected = 'private'; });
  const corrupt = await f.lookup(created.p, created.key); assert.equal(corrupt.status, 503); assert.equal(json(corrupt).error, 'WORKFLOW_RECEIPT_CORRUPT');
  assert.ok(!corrupt.text.includes('private'));
});

test('receipt lookup retains existing strict single-link key protection', async t => {
  const f = await fixture(t), created = await f.create(), alias = join(f.root, 'key-alias');
  linkSync(f.keyFile, alias);
  const reply = await f.lookup(created.p, created.key); assert.equal(reply.status, 503, reply.text);
  assert.equal(json(reply).error, 'WORKFLOW_RECEIPT_STORAGE'); assert.ok(!reply.text.includes(f.keyFile)); unlinkSync(alias);
});

test('core receipt lookup denies absent human authority rather than bypassing it', t => {
  const root = mkdtempSync(join(tmpdir(), 'arcane-core-receipt-')), projectPath = join(root, 'project'), directory = join(root, 'state');
  mkdirSync(projectPath); const work = new WorkStore({ directory, projectPath });
  const service = new WorkflowService({ directory, projectPath, workStore: { store: work, projectPath } });
  t.after(() => { service.close(); work.close(); assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(resolve(root), { recursive: true, force: true }); });
  assert.throws(() => service.receipt({ prepared: service.prepareCreation(recipe()), receiptHash: 'a'.repeat(64), idempotencyKey: 'unused' }), { code: 'WORKFLOW_HUMAN_REQUIRED' });
});
