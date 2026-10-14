import { makeFixtureDirectory, fixtureTempDirectory } from './windows-fixture-paths.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdirSync, lstatSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { ConversationWorkStore, type NativeConversation } from '../../packages/storage/src/conversation-work-store.js';
import { WorkStore } from '../../packages/storage/src/work-store.js';
import { workflowProjectIdentity } from '../../packages/storage/src/workflow-store.js';
import {
  createWorkflowHost, workflowReceiptParent, type WorkflowHost, type WorkflowPreview, type WorkflowHostOptions,
} from '../../apps/daemon/src/workflow-host.js';
import { workflowRoutes } from '../../apps/daemon/src/workflow-routes.js';
import type { WorkflowSnapshot } from '../../apps/daemon/src/workflow-service.js';

const native: NativeConversation = { provider: 'codex', threadId: 'Fixture:Thread.A', sessionId: 'Fixture:Session.A' };
const recipe = () => ({ deliverable: 'code-change', engine: 'roblox', title: 'Offline conversation fixture',
  prompt: 'Review a scoped local deliverable without launching anything.', scope: ['fixture-source'], model: null });
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value);
}
interface Reply { status: number; value: Record<string, unknown> | null; text: string }
interface Listing { projectId: string; workflows: { id: string; recipeId: string; state: string }[] }
async function fixture(t: test.TestContext, settings: { unscoped?: boolean; homeProject?: boolean } = {}) {
  const root = makeFixtureDirectory('arcane-workflow-conversation-');
  const projectPath = settings.homeProject ? homedir() : join(root, 'project');
  if (!settings.homeProject) mkdirSync(projectPath);
  const directory = join(root, 'state');
  const work = new WorkStore({ directory, projectPath });
  const associationStores = new Set<ConversationWorkStore>();
  const openAssociations = (path = projectPath, state = directory) => {
    const store = new ConversationWorkStore({ directory: state, projectPath: path }); associationStores.add(store); return store;
  };
  let associations = openAssociations(), conversation: NativeConversation | null = structuredClone(native);
  const receiptParent = workflowReceiptParent(directory, workflowProjectIdentity(projectPath).projectId);
  const keyFile = join(receiptParent, 'workflow-human-receipts', 'key-v1');
  const token = 'fixture-human-' + randomUUID(), agentToken = 'fixture-agent-' + randomUUID();
  function options(scoped = true): WorkflowHostOptions {
    return { directory, projectPath, workStore: { store: work, projectPath },
      ...(scoped ? { conversation: () => conversation, workAssociations: associations } : {}) };
  }
  let host: WorkflowHost = createWorkflowHost(options(!settings.unscoped)), route = workflowRoutes(host), origin = '';
  const server = createServer((request, response) => {
    void route(request, response, new URL(request.url ?? '/', origin), token, origin, agentToken).then(handled => {
      if (!handled) { response.writeHead(404); response.end('{}'); }
    }).catch(() => { if (!response.headersSent) response.writeHead(500); response.end('{"error":"fixture"}'); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  t.after(async () => {
    host.close(); for (const store of associationStores) store.close(); work.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (process.platform === 'win32') {
      const part = relative(resolve(homedir(), '.arcane-private-receipts-v1'), resolve(receiptParent));
      assert.match(part, /^[a-f0-9]{64}$/); assert.ok(!lstatSync(receiptParent).isSymbolicLink());
      rmSync(resolve(receiptParent), { recursive: true, force: true });
    }
    const part = relative(fixtureTempDirectory(), resolve(root));
    assert.ok(part && !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep) && !lstatSync(root).isSymbolicLink());
    rmSync(resolve(root), { recursive: true, force: true });
  });
  const call = (path: string, input?: unknown): Promise<Reply> => new Promise((resolve, reject) => {
    const raw = input === undefined ? undefined : JSON.stringify(input);
    const request = httpRequest(origin + path, { method: raw === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + token, Origin: origin,
        ...(raw === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(raw)) }) },
    }, response => {
      let text = ''; response.setEncoding('utf8'); response.on('data', chunk => text += chunk);
      response.on('end', () => resolve({ status: response.statusCode!, text, value: JSON.parse(text) as Reply['value'] }));
      response.on('error', reject);
    });
    request.on('error', reject); request.setTimeout(20000, () => request.destroy(new Error('Fixture request deadline')));
    request.end(raw);
  });
  const preview = async () => {
    const reply = await call('/v1/workflows/preview', { action: 'recipe', request: recipe() });
    assert.equal(reply.status, 200, reply.text); return reply.value as unknown as WorkflowPreview;
  };
  const execute = (preview: WorkflowPreview, idempotencyKey = randomUUID()) => call('/v1/workflows/execute', { preview, idempotencyKey });
  const list = async () => {
    const reply = await call('/v1/workflows'); assert.equal(reply.status, 200, reply.text); return reply.value as unknown as Listing;
  };
  const create = async () => {
    const p = await preview(), idempotencyKey = randomUUID(), reply = await execute(p, idempotencyKey);
    assert.equal(reply.status, 200, reply.text);
    return { id: (reply.value as unknown as WorkflowSnapshot).workflow.id, p, idempotencyKey };
  };
  const restart = (scoped = true) => {
    host.close(); associations.close(); associations = openAssociations();
    host = createWorkflowHost(options(scoped)); route = workflowRoutes(host);
  };
  const workflowId = () => {
    const db = new DatabaseSync(join(directory, 'workflow.sqlite'), { readOnly: true });
    try { return String(db.prepare('SELECT id FROM workflows ORDER BY rowid DESC LIMIT 1').get()!.id); }
    finally { db.close(); }
  };
  return { root, projectPath, directory, work, keyFile, call, preview, execute, create, list, restart, workflowId,
    host: () => host, get associations() { return associations; },
    context: (value: NativeConversation | null) => { conversation = value === null ? null : structuredClone(value); },
    foreignAssociations: () => {
      const other = join(root, 'foreign-project'); mkdirSync(other);
      return openAssociations(other, join(root, 'foreign-state'));
    }, options };
}

test('creation binds the exact server conversation; restart reads and exact replay preserve one run', async t => {
  const f = await fixture(t), { id, p, idempotencyKey } = await f.create();
  assert.deepEqual(p.conversation, native);
  assert.deepEqual(f.associations.binding('workflow', id), {
    projectId: workflowProjectIdentity(f.projectPath).projectId, conversation: native, kind: 'workflow', id,
  });
  assert.deepEqual((await f.list()).workflows.map(row => row.id), [id]);
  f.restart();
  assert.equal((await f.call('/v1/workflows/' + id)).status, 200);
  assert.equal((await f.call('/v1/workflows/current-flow')).value!.workflow &&
    ((await f.call('/v1/workflows/current-flow')).value as unknown as WorkflowSnapshot).workflow.id, id);
  assert.equal((await f.execute(p, idempotencyKey)).status, 200);
  assert.equal(f.work.runs().length, 1);
  f.host().close(); assert.equal(f.associations.binding('workflow', id)!.conversation.threadId, native.threadId);
});

test('provider, thread, session, null session and case isolate every read and old preview', async t => {
  const f = await fixture(t), { id, p, idempotencyKey } = await f.create();
  for (const changed of [
    { ...native, provider: 'claude-code' as const }, { ...native, threadId: 'Different-thread' },
    { ...native, sessionId: 'Different-session' }, { ...native, sessionId: null },
    { ...native, threadId: native.threadId.toLowerCase() }, { ...native, sessionId: native.sessionId!.toLowerCase() },
  ]) {
    f.context(changed);
    assert.deepEqual((await f.list()).workflows, []);
    assert.equal((await f.call('/v1/workflows/current-flow')).value, null);
    assert.equal((await f.call('/v1/workflows/' + id)).status, 403);
    assert.equal((await f.execute(p, idempotencyKey)).status, 403);
    assert.equal((await f.call('/v1/workflows/preview', {
      action: 'review', workflowId: id, stepKey: 'prompt', decision: 'approved',
    })).status, 403);
    assert.deepEqual(f.associations.binding('workflow', id)!.conversation, native);
  }
  f.context(native); assert.equal((await f.call('/v1/workflows/' + id)).status, 200);
  f.context({ ...native, sessionId: 'Different-session' }); const other = await f.create();
  assert.notEqual(other.id, id); assert.deepEqual((await f.list()).workflows.map(row => row.id), [other.id]);
  f.context(native); assert.deepEqual((await f.list()).workflows.map(row => row.id), [id]);
});

test('the receipt MAC covers conversation; changing the envelope to the current context cannot forge it', async t => {
  const f = await fixture(t), p = await f.preview();
  const nonce = p.receiptHash.slice(0, 16);
  const expected = createHmac('sha256', readFileSync(f.keyFile))
    .update('arcane.workflow.human-receipt.v1\0').update(nonce).update('\0')
    .update(canonical({ prepared: p.prepared, conversation: native })).digest('hex').slice(0, 48);
  assert.equal(p.receiptHash.slice(16), expected);
  const current = { ...native, sessionId: 'Current-session' }; f.context(current);
  const forged = structuredClone(p); forged.conversation = current;
  const denied = await f.execute(forged);
  assert.equal(denied.status, 403); assert.equal(denied.value!.error, 'WORKFLOW_HUMAN_REQUIRED');
  const stripped = structuredClone(p); delete stripped.conversation;
  assert.equal((await f.execute(stripped)).status, 403);
  assert.equal(f.work.runs().length, 0);
  assert.equal((await f.call('/v1/workflows/preview', {
    action: 'recipe', request: recipe(), conversation: native, verifiers: [], workAssociations: {},
  })).status, 400);
});

test('null server context cannot create or adopt work; reads never backfill legacy workflows after restart', async t => {
  const f = await fixture(t, { unscoped: true }), legacy = await f.create();
  assert.equal(legacy.p.conversation, undefined); assert.equal(f.associations.binding('workflow', legacy.id), null);
  f.restart();
  let binds = 0; const bind = f.associations.bind.bind(f.associations);
  f.associations.bind = input => { binds++; return bind(input); };
  assert.deepEqual((await f.list()).workflows, []);
  assert.equal((await f.call('/v1/workflows/current-flow')).value, null);
  assert.equal((await f.call('/v1/workflows/' + legacy.id)).status, 403);
  assert.equal((await f.execute(legacy.p, legacy.idempotencyKey)).status, 403);
  assert.equal(binds, 0); assert.equal(f.associations.binding('workflow', legacy.id), null);
  const p = await f.preview(); f.context(null);
  assert.equal((await f.execute(p)).status, 403);
  assert.equal((await f.call('/v1/workflows/preview', { action: 'recipe', request: recipe() })).status, 403);
  assert.deepEqual((await f.list()).workflows, []); assert.equal((await f.call('/v1/workflows/current-flow')).value, null);
  assert.equal(f.work.runs().length, 1); assert.equal(binds, 0);
  f.restart(); assert.deepEqual((await f.list()).workflows, []);
  assert.equal(f.associations.binding('workflow', legacy.id), null);
});

test('association failure is HTTP 202 without repeated work creation or automatic read/restart association', async t => {
  const f = await fixture(t), p = await f.preview(), idempotencyKey = randomUUID();
  let creates = 0, binds = 0; const create = f.work.create.bind(f.work);
  f.work.create = input => { creates++; return create(input); };
  f.associations.bind = () => { binds++; throw new Error('PRIVATE-ASSOCIATION-FAILURE'); };
  const result = await f.execute(p, idempotencyKey);
  assert.equal(result.status, 202, result.text);
  assert.equal(result.value!.error, 'WORKFLOW_ASSOCIATION_UNKNOWN'); assert.equal(result.value!.outcome, 'unknown');
  assert.equal(result.value!.retry, false); assert.equal(result.text.includes('PRIVATE-ASSOCIATION-FAILURE'), false);
  const id = f.workflowId();
  assert.deepEqual((await f.list()).workflows, []); assert.equal((await f.call('/v1/workflows/' + id)).status, 403);
  assert.equal((await f.execute(p, idempotencyKey)).status, 202); assert.equal(creates, 1); assert.equal(binds, 2);
  f.restart();
  let restartedBinds = 0; const bind = f.associations.bind.bind(f.associations);
  f.associations.bind = input => { restartedBinds++; return bind(input); };
  assert.deepEqual((await f.list()).workflows, []); assert.equal((await f.call('/v1/workflows/current-flow')).value, null);
  assert.equal((await f.call('/v1/workflows/' + id)).status, 403);
  assert.equal(f.associations.binding('workflow', id), null);
  assert.equal(restartedBinds, 0); assert.equal(creates, 1);
});

test('a foreign project association store is rejected before any workflow or association write', async t => {
  const f = await fixture(t), foreign = f.foreignAssociations();
  f.host().close();
  assert.notEqual(foreign.projectId, workflowProjectIdentity(f.projectPath).projectId);
  let writes = 0; const bind = foreign.bind.bind(foreign);
  foreign.bind = input => { writes++; return bind(input); };
  let selected: WorkflowHost | undefined;
  try {
    assert.throws(() => {
      selected = createWorkflowHost({ ...f.options(), workAssociations: foreign });
      selected.list();
    }, { code: 'WORKFLOW_PROJECT' });
    assert.equal(writes, 0); assert.equal(f.work.runs().length, 0);
  } finally { selected?.close(); }
});

test('receipts are scoped to project and state directory; actual private home key paths reject scopes and evidence', async t => {
  const f = await fixture(t, { homeProject: process.platform === 'win32' }), { id } = await f.create();
  const identity = workflowProjectIdentity(f.projectPath);
  const parent = workflowReceiptParent(f.directory, identity.projectId);
  assert.equal(f.keyFile, join(parent, 'workflow-human-receipts', 'key-v1'));
  if (process.platform === 'win32') {
    const expected = createHash('sha256').update(identity.projectId).update('\0').update(resolve(f.directory).toLowerCase()).digest('hex');
    assert.equal(parent, join(homedir(), '.arcane-private-receipts-v1', expected));
    const keyPath = relative(f.projectPath, f.keyFile).replaceAll('\\', '/');
    assert.ok(!keyPath.startsWith('../') && !isAbsolute(keyPath));
    assert.equal((await f.call('/v1/workflows/preview', {
      action: 'recipe', request: { ...recipe(), scope: ['.arcane-private-receipts-v1'] },
    })).status, 400);
    const bytes = readFileSync(f.keyFile);
    assert.equal((await f.call('/v1/workflows/preview', {
      action: 'handoff', workflowId: id, submission: { key: 'prompt', artifacts: [{
        path: keyPath, role: 'brief', sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
      }], subjectHashes: [], checks: [] },
    })).status, 400);
    const otherParent = workflowReceiptParent(f.directory + '-other', identity.projectId);
    assert.notEqual(otherParent, parent);
    const scope = relative(join(homedir(), '.arcane-private-receipts-v1'), otherParent);
    assert.match(scope, /^[a-f0-9]{64}$/); assert.ok(!lstatSync(otherParent).isSymbolicLink());
    rmSync(resolve(otherParent), { recursive: true, force: true });
  }
  assert.equal(((await f.call('/v1/workflows/' + id)).value as unknown as WorkflowSnapshot).workflow.taskStates.prompt, 'pending');
});
