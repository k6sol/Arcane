import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import {
  chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createWorkflowHost, workflowReceiptParent, WORKFLOW_HTTP_LIMITS, type WorkflowHost, type WorkflowPreview } from '../../apps/daemon/src/workflow-host.js';
import { workflowRoutes } from '../../apps/daemon/src/workflow-routes.js';
import type { WorkflowSnapshot } from '../../apps/daemon/src/workflow-service.js';
import type { WorkflowRecipeRequest, WorkflowSubmission } from '../../packages/core/src/workflow-recipes.js';
import { WorkStore } from '../../packages/storage/src/work-store.js';
import { workflowProjectIdentity } from '../../packages/storage/src/workflow-store.js';
import type { Connection } from '../../packages/protocol/src/providers.js';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const recipe = (): WorkflowRecipeRequest => ({
  deliverable: 'code-change', engine: 'roblox', title: 'Offline HTTP fixture',
  prompt: 'Review an actual scoped local file.', scope: ['src'],
  model: { provider: 'codex', model: 'offline-fixture', effort: 'high', connectionRevision: 'offline-v1' },
});
const connection = (): Connection => ({
  provider: 'codex', installed: true, version: 'offline', auth: 'subscription', plan: null,
  models: [{ id: 'offline-fixture', label: 'Offline fixture', efforts: ['high'], defaultEffort: 'high',
    source: 'runtime-catalogue', entitlement: 'unverified', inputModalities: ['text'] }],
  features: [{ id: 'coding', label: 'Offline handoff', state: 'native-handoff', route: 'native-client', reason: 'Fixture only.' }],
  warnings: [], observedAt: '2026-10-12T00:00:00Z', revision: 'offline-v1',
});
interface Reply { status: number; text: string; headers: IncomingHttpHeaders }
function json<T = Record<string, unknown>>(reply: Reply): T { return JSON.parse(reply.text) as T; }
interface WireOptions {
  method?: string; token?: string; origin?: string | null; host?: string;
  headers?: Record<string, string | string[]>; raw?: string | Buffer; chunks?: Buffer[]; target?: string;
}
async function fixture(t: test.TestContext, settings: { equalTokens?: boolean; token?: string; stateInsideProject?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'arcane-workflow-http-'));
  const projectPath = join(root, 'project'), directory = settings.stateInsideProject ? join(projectPath, 'state') : join(root, 'state');
  mkdirSync(projectPath); mkdirSync(join(projectPath, 'src'));
  const work = new WorkStore({ directory, projectPath });
  const receiptParent = workflowReceiptParent(directory, workflowProjectIdentity(projectPath).projectId);
  const keyFile = join(receiptParent, 'workflow-human-receipts', 'key-v1');
  const token = settings.token ?? 'fixture-human-' + randomUUID();
  const agentToken = settings.equalTokens ? token : 'fixture-agent-' + randomUUID();
  let contextFailure = false;
  const options = { directory, projectPath, workStore: { store: work, projectPath }, policyContext: () => {
    if (contextFailure) throw new Error('PRIVATE-CONTEXT-' + token + projectPath);
    return { connections: [connection()], capabilities: [{ id: 'local.patch', state: 'available' as const, safety: 'human-handoff' as const }] };
  } };
  let host: WorkflowHost = createWorkflowHost(options), route = workflowRoutes(host), origin = '';
  const server = createServer((request, response) => {
    void route(request, response, new URL(request.url ?? '/', origin), token, origin, agentToken).then(handled => {
      if (!handled) { response.writeHead(404); response.end('fixture fallback'); }
    }).catch(() => { if (!response.headersSent) response.writeHead(500); response.end('fixture failed'); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  t.after(async () => {
    host.close(); work.close(); server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    const target = resolve(root), boundary = resolve(tmpdir()), part = relative(boundary, target);
    assert.ok(part && !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep));
    if (process.platform === 'win32') {
      const privateRoot = resolve(homedir(), '.arcane-private-receipts-v1');
      const privatePart = relative(privateRoot, resolve(receiptParent));
      assert.match(privatePart, /^[a-f0-9]{64}$/);
      assert.ok(!lstatSync(receiptParent).isSymbolicLink());
      rmSync(resolve(receiptParent), { recursive: true, force: true });
    }
    rmSync(target, { recursive: true, force: true });
  });
  const call = (path: string, input?: unknown, options: WireOptions = {}): Promise<Reply> => new Promise((resolve, reject) => {
    const raw = options.raw ?? (input === undefined ? undefined : JSON.stringify(input));
    const request = httpRequest(origin + path, {
      method: options.method ?? (raw === undefined && !options.chunks ? 'GET' : 'POST'),
      ...(options.target ? { path: options.target } : {}),
      headers: {
        Host: options.host ?? new URL(origin).host, Authorization: 'Bearer ' + (options.token ?? token),
        ...(options.origin === null ? {} : { Origin: options.origin ?? origin }),
        ...(raw === undefined && !options.chunks ? {} : { 'Content-Type': 'application/json' }),
        ...(raw === undefined ? {} : { 'Content-Length': String(Buffer.byteLength(raw)) }),
        ...(options.chunks ? { 'Transfer-Encoding': 'chunked' } : {}), ...options.headers,
      },
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({ status: response.statusCode!, text: Buffer.concat(chunks).toString('utf8'), headers: response.headers }));
      response.on('error', reject);
    });
    request.setTimeout(8000, () => request.destroy(new Error('Fixture deadline'))); request.on('error', reject);
    for (const chunk of options.chunks ?? []) request.write(chunk);
    request.end(raw);
  });
  const preview = async (input: unknown) => {
    const reply = await call('/v1/workflows/preview', input); assert.equal(reply.status, 200, reply.text);
    return json<WorkflowPreview>(reply);
  };
  const execute = (preview: WorkflowPreview, idempotencyKey = randomUUID()) =>
    call('/v1/workflows/execute', { preview, idempotencyKey });
  const create = async () => {
    const p = await preview({ action: 'recipe', request: recipe() });
    const reply = await execute(p); assert.equal(reply.status, 200, reply.text);
    return json<WorkflowSnapshot>(reply).workflow.id;
  };
  const get = async (id: string) => {
    const reply = await call('/v1/workflows/' + id); assert.equal(reply.status, 200, reply.text);
    return json<WorkflowSnapshot>(reply);
  };
  const proof = (id: string, key = 'prompt'): Promise<WorkflowSubmission> => get(id).then(snapshot => {
    const step = snapshot.workflow.recipe.steps.find(step => step.key === key)!;
    const artifacts = step.quality.roles.map(role => {
      const path = 'src/' + randomUUID() + '-' + role + '.txt', bytes = Buffer.from('Actual offline ' + role + ' evidence.');
      writeFileSync(join(projectPath, path), bytes);
      return { path, role, bytes: bytes.length, sha256: hash(bytes) };
    });
    return { key, artifacts, subjectHashes: [...new Set(step.subjectSteps.flatMap(subject =>
      snapshot.workflow.submissions.find(s => s.key === subject)?.artifacts.map(a => a.sha256) ?? []))].sort(), checks: [] };
  });
  const handoff = async (id: string, key = 'prompt') => {
    const submission = await proof(id, key);
    const p = await preview({ action: 'handoff', workflowId: id, submission });
    const reply = await execute(p); assert.equal(reply.status, 200, reply.text);
    return { p, submission, reply };
  };
  const review = async (id: string, key = 'prompt', decision = 'approved') => {
    const p = await preview({ action: 'review', workflowId: id, stepKey: key, decision });
    const reply = await execute(p); assert.equal(reply.status, 200, reply.text); return { p, reply };
  };
  const restart = () => { host.close(); host = createWorkflowHost(options); route = workflowRoutes(host); };
  return { root, projectPath, directory, work, token, agentToken, origin, call, preview, execute, create,
    get, proof, handoff, review, restart, host: () => host, contextFailure: () => { contextFailure = true; },
    keyFile };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

test('lazy host borrows existing WorkStore; preview and metadata never create a run', async t => {
  const f = await fixture(t);
  const unrelated = f.work.create({ title: 'Worker owned task', objective: 'Remain claimed.', tasks: [{
    key: 'other', title: 'Other task', instructions: 'Fixture', acceptance: 'Fixture', scope: ['other'], dependencies: [],
  }] });
  f.work.claim({ taskId: unrelated.tasks[0]!.id, worker: 'offline-worker' });
  assert.equal(existsSync(f.keyFile), false);
  const empty = await f.call('/v1/workflows');
  assert.equal(empty.status, 200); assert.deepEqual(json(empty).workflows, []);
  assert.equal(json(await f.call('/v1/workflows/current-flow')), null);
  const p = await f.preview({ action: 'recipe', request: recipe() });
  assert.match(p.receiptHash, /^[a-f0-9]{64}$/); assert.equal(p.prepared.kind, 'create-recipe');
  assert.equal(f.work.runs().length, 1); assert.equal(f.work.task(unrelated.tasks[0]!.id).state, 'in_progress');
  assert.equal(lstatSync(f.keyFile).size, 32); assert.equal(lstatSync(f.keyFile).nlink, 1);
  if (process.platform !== 'win32') {
    assert.equal(lstatSync(f.keyFile).mode & 0o777, 0o600);
    assert.equal(lstatSync(dirname(f.keyFile)).mode & 0o777, 0o700);
  }
  assert.equal(empty.headers['cache-control'], 'no-store'); assert.equal(empty.headers['x-content-type-options'], 'nosniff');
  f.host().close(); assert.equal(f.work.task(unrelated.tasks[0]!.id).state, 'in_progress');
  assert.equal((await f.call('/v1/workflows')).status, 503);
  assert.equal((await f.call('/v1/unrelated')).text, 'fixture fallback');
});

test('every route denies agent, missing credentials and hostile origin/host/fetch metadata before key access', async t => {
  const f = await fixture(t);
  for (const endpoint of ['', '/current-flow', '/unknown', '/preview', '/execute']) {
    const payload = ['/preview', '/execute'].includes(endpoint) ? {} : undefined;
    for (const options of [
      { token: f.agentToken }, { origin: 'https://evil.invalid' }, { host: 'evil.invalid' },
      { headers: { 'Sec-Fetch-Site': 'cross-site' } }, { headers: { 'Sec-Fetch-Site': 'same-site' } },
      { headers: { 'Sec-Fetch-Site': 'none' } },
    ]) {
      const reply = await f.call('/v1/workflows' + endpoint, payload, options);
      assert.equal(reply.status, 403, reply.text);
      assert.ok(!reply.text.includes(f.token) && !reply.text.includes(f.agentToken));
      assert.equal(reply.headers['access-control-allow-origin'], undefined);
    }
    assert.equal((await f.call('/v1/workflows' + endpoint, payload, { token: 'wrong' })).status, 401);
  }
  assert.equal((await f.call('/v1/workflows/preview', {}, { origin: null })).status, 403);
  assert.equal(existsSync(f.keyFile), false);
  const equal = await fixture(t, { equalTokens: true });
  assert.equal((await equal.call('/v1/workflows/preview', {})).status, 403);
  assert.equal(existsSync(equal.keyFile), false);
});

test('singleton duplicate headers and query/target aliases are refused', async t => {
  const f = await fixture(t);
  for (const headers of [
    { Authorization: ['Bearer ' + f.token, 'Bearer ' + f.token] },
    { Origin: [f.origin, f.origin] },
    { 'Sec-Fetch-Site': ['same-origin', 'same-origin'] },
    { 'Content-Type': ['application/json', 'application/json'] },
  ]) {
    const reply = await f.call('/v1/workflows/preview', {}, { headers });
    assert.equal(reply.status, 400, reply.text);
  }
  const duplicateHost = await new Promise<string>((resolve, reject) => {
    const url = new URL(f.origin);
    const socket = connect(Number(url.port), url.hostname, () => {
      socket.write('POST /v1/workflows/preview HTTP/1.1\r\nHost: ' + url.host + '\r\nHost: ' + url.host +
        '\r\nAuthorization: Bearer ' + f.token + '\r\nOrigin: ' + f.origin +
        '\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}');
    });
    let text = ''; socket.setEncoding('utf8'); socket.on('data', chunk => text += chunk);
    socket.on('end', () => resolve(text)); socket.on('error', reject);
    socket.setTimeout(6000, () => socket.destroy(new Error('Raw header fixture deadline')));
  });
  assert.match(duplicateHost, /^HTTP\/1\.1 400 /);
  for (const path of ['/v1/workflows?token=private', '/v1/workflows?', '/v1/workflows/current-flow?x=1']) {
    assert.equal((await f.call(path, undefined, { target: path })).status, 400);
  }
  for (const target of ['/v1/workflows/x/../current-flow', f.origin + '/v1/workflows']) {
    assert.equal((await f.call('/v1/workflows', undefined, { target })).status, 400);
  }
  assert.equal((await f.call('/v1/workflows/current-flow', {}, { method: 'GET' })).status, 400);
  assert.equal(existsSync(f.keyFile), false);
});

test('strict JSON rejects duplicate keys, invalid UTF-8, nesting, overflow and compressed bodies', async t => {
  const f = await fixture(t);
  for (const [raw, headers, expected] of [
    ['{"action":"recipe","action":"review"}', {}, 400],
    ['{"action":"recipe","\\u0061ction":"review"}', {}, 400],
    ['{"__proto__":{}}', {}, 400], ['{"x":1e999}', {}, 400],
    ['['.repeat(20) + '0' + ']'.repeat(20), {}, 400], ['{PRIVATE-MALFORMED', {}, 400],
    [Buffer.from([123, 34, 255, 34, 58, 49, 125]), {}, 400],
    ['{}', { 'Content-Type': 'text/plain' }, 415], ['{}', { 'Content-Encoding': 'gzip' }, 415],
    ['x'.repeat(WORKFLOW_HTTP_LIMITS.bodyBytes + 1), {}, 413],
  ] as const) {
    const reply = await f.call('/v1/workflows/preview', undefined, { raw, headers });
    assert.equal(reply.status, expected, reply.text); assert.equal(reply.text.includes('PRIVATE-MALFORMED'), false);
  }
  assert.equal((await f.call('/v1/workflows/preview', undefined, {
    chunks: [Buffer.alloc(65000, 32), Buffer.alloc(70000, 32)],
  })).status, 413);
  assert.equal(existsSync(f.keyFile), false);
});

test('stalled JSON has a deadline and closes the connection without opening the host', async t => {
  const f = await fixture(t), started = Date.now();
  const reply = await new Promise<Reply>((resolve, reject) => {
    const request = httpRequest(f.origin + '/v1/workflows/preview', {
      method: 'POST', headers: { Authorization: 'Bearer ' + f.token, Origin: f.origin,
        'Content-Type': 'application/json', 'Content-Length': '100' },
    }, response => {
      let text = ''; response.setEncoding('utf8'); response.on('data', chunk => text += chunk);
      response.on('end', () => { request.destroy(); resolve({ status: response.statusCode!, text, headers: response.headers }); });
      response.on('error', reject);
    });
    request.on('error', reject); request.setTimeout(6000, () => request.destroy(new Error('Fixture exceeded deadline')));
    request.write('{');
  });
  assert.equal(reply.status, 408); assert.equal(json(reply).error, 'BODY_TIMEOUT');
  assert.equal(reply.headers.connection, 'close'); assert.ok(Date.now() - started < 6000);
  assert.equal(existsSync(f.keyFile), false);
});

test('forged role/receipt/capability callbacks and credential content grant no authority', async t => {
  const f = await fixture(t, { token: 'fixture-human-"\\-' + randomUUID() });
  for (const extra of [{ human: true }, { role: 'human' }, { capabilities: [] }, { verifiers: [] },
    { authorizeHuman: true }, { modelPath: 'native.exe' }, { command: 'anything' }, { projectPath: f.projectPath }]) {
    assert.equal((await f.call('/v1/workflows/preview', { action: 'recipe', request: recipe(), ...extra })).status, 400);
  }
  assert.equal((await f.call('/v1/workflows/preview', {
    action: 'recipe', request: { ...recipe(), prompt: f.token },
  })).status, 400);
  const p = await f.preview({ action: 'recipe', request: recipe() });
  const forged = structuredClone(p); forged.receiptHash = hash(f.token);
  assert.equal((await f.execute(forged)).status, 403);
  for (const change of [
    (p: WorkflowPreview) => { p.prepared.binding = hash('fake'); },
    (p: WorkflowPreview) => { p.prepared.recipe.title = 'Changed recipe'; },
    (p: WorkflowPreview) => { p.prepared.decision = 'rejected'; },
    (p: WorkflowPreview) => { p.prepared.projectId = hash('other'); },
  ]) {
    const altered = structuredClone(p); change(altered); assert.equal((await f.execute(altered)).status, 403);
  }
  const changedRequest = structuredClone(p); changedRequest.request!.title = 'Changed creation input';
  assert.equal((await f.execute(changedRequest)).status, 409);
  for (const path of ['/v1/workflows/verify', '/v1/workflows/launch', '/v1/workflows/studio']) {
    assert.equal((await f.call(path, {})).status, 405);
  }
  assert.equal(f.work.runs().length, 0);
});

test('create/get/current flow and exact command replay survive restart without a second run', async t => {
  const f = await fixture(t), p = await f.preview({ action: 'recipe', request: recipe() }), key = randomUUID();
  f.restart(); // A prepared signed creation is still usable after authority restart.
  const first = await f.execute(p, key); assert.equal(first.status, 200, first.text);
  const id = json<WorkflowSnapshot>(first).workflow.id, mapping = json<WorkflowSnapshot>(first).workflow.taskIds;
  const bytes = readFileSync(f.keyFile);
  f.restart();
  assert.deepEqual(readFileSync(f.keyFile), bytes);
  const replay = await f.execute(p, key); assert.equal(replay.status, 200, replay.text);
  assert.equal(json<WorkflowSnapshot>(replay).workflow.id, id); assert.equal(f.work.runs().length, 1);
  assert.deepEqual((await f.get(id)).workflow.taskIds, mapping);
  assert.equal(json<WorkflowSnapshot>(await f.call('/v1/workflows/current-flow')).workflow.id, id);
  assert.equal((await f.execute(p, randomUUID())).status, 409); // Receipt cannot authorize a second durable command.
  const other = await f.preview({ action: 'recipe', request: { ...recipe(), title: 'Different recipe' } });
  assert.equal((await f.execute(other, key)).status, 409);
});

test('handoff/review are explicit, exact evidence is pinned, and persisted gates validate after restart', async t => {
  const f = await fixture(t), id = await f.create();
  const { submission } = await f.handoff(id);
  const reviewPreview = await f.preview({ action: 'review', workflowId: id, stepKey: 'prompt', decision: 'approved' });
  const key = randomUUID();
  assert.equal((await f.get(id)).workflow.taskStates.prompt, 'needs_review');
  assert.equal((await f.execute(reviewPreview, key)).status, 200);
  f.restart();
  assert.equal((await f.execute(reviewPreview, key)).status, 200);
  const gate = await f.preview({ action: 'gate', workflowId: id, stepKey: 'requirements', gate: 'model-handoff', decision: 'approved' });
  assert.deepEqual(gate.prepared.subjectHashes, [submission.artifacts[0]!.sha256]);
  assert.equal((await f.execute(gate)).status, 200);
  const before = (await f.get(id)).assessment!.steps.find(step => step.key === 'requirements')!;
  assert.equal(before.disposition, 'human-handoff');
  f.restart();
  const after = (await f.get(id)).assessment!.steps.find(step => step.key === 'requirements')!;
  assert.deepEqual(after, before);
  await f.handoff(id, 'requirements');
  assert.equal((await f.get(id)).workflow.taskStates.requirements, 'needs_review');
});

test('changed evidence and altered review decisions cannot be accepted from an old preview', async t => {
  const f = await fixture(t), id = await f.create(), submission = await f.proof(id);
  const p = await f.preview({ action: 'handoff', workflowId: id, submission });
  writeFileSync(join(f.projectPath, submission.artifacts[0]!.path), 'Changed evidence bytes');
  assert.equal((await f.execute(p)).status, 409);
  assert.equal((await f.get(id)).workflow.taskStates.prompt, 'pending');
  const handed = await f.handoff(id);
  const review = await f.preview({ action: 'review', workflowId: id, stepKey: 'prompt', decision: 'approved' });
  const changed = structuredClone(review); changed.prepared.decision = 'rejected';
  assert.equal((await f.execute(changed)).status, 403);
  writeFileSync(join(f.projectPath, handed.submission.artifacts[0]!.path), 'Changed after review preview');
  assert.equal((await f.execute(review)).status, 409);
  assert.equal(f.work.task((json<WorkflowSnapshot>(handed.reply)).workflow.taskIds.prompt!).state, 'needs_review');
});

test('unknown handoff outcome returns 202, never retries, and explicit reconciliation preserves observed evidence', async t => {
  const f = await fixture(t), id = await f.create(), submission = await f.proof(id);
  const p = await f.preview({ action: 'handoff', workflowId: id, submission }), key = randomUUID();
  const original = f.work.submit.bind(f.work); let calls = 0;
  f.work.submit = input => { calls++; original(input); throw new Error('PRIVATE-OUTCOME-' + f.token + f.projectPath); };
  const reply = await f.execute(p, key);
  assert.equal(reply.status, 202, reply.text); assert.equal(json(reply).outcome, 'unknown'); assert.equal(json(reply).retry, false);
  assert.ok(!reply.text.includes(f.token) && !reply.text.includes(f.projectPath));
  f.restart();
  assert.equal((await f.execute(p, key)).status, 202); assert.equal(calls, 1);
  const reconcile = await f.preview({ action: 'reconcile', workflowId: id, resolution: 'accept-observed' });
  const altered = structuredClone(reconcile); altered.resolution = 'halt';
  assert.equal((await f.execute(altered)).status, 409);
  const resolutionKey = randomUUID();
  assert.equal((await f.execute(reconcile, resolutionKey)).status, 200);
  f.restart();
  assert.equal((await f.execute(reconcile, resolutionKey)).status, 200);
  assert.equal((await f.get(id)).workflow.taskStates.prompt, 'needs_review'); assert.equal(calls, 1);
  assert.equal((await f.execute(p, key)).status, 202);
});

test('lost creation response can halt or accept an exact observed WorkStore mapping', async t => {
  const f = await fixture(t), p = await f.preview({ action: 'recipe', request: recipe() });
  const original = f.work.create.bind(f.work); let calls = 0;
  f.work.create = input => { calls++; original(input); throw new Error('PRIVATE-CREATE'); };
  assert.equal((await f.execute(p)).status, 202);
  const listed = json<{ workflows: { id: string }[] }>(await f.call('/v1/workflows')).workflows;
  const id = listed[0]!.id, run = f.work.runs()[0]!;
  const observedRun = { runId: run.id, taskIds: Object.fromEntries(run.tasks.map(task => [task.key, task.id])) };
  const reconcile = await f.preview({ action: 'reconcile', workflowId: id, resolution: 'accept-observed', observedRun });
  const altered = structuredClone(reconcile); altered.observedRun!.runId = randomUUID();
  assert.equal((await f.execute(altered)).status, 409);
  assert.equal((await f.execute(reconcile)).status, 200);
  assert.equal((await f.get(id)).workflow.runId, run.id); assert.equal(calls, 1);
});

test('receipt file replacement, missing key, linked file and linked directory fail closed', async t => {
  for (const damage of [
    (f: Fixture) => writeFileSync(f.keyFile, Buffer.alloc(31)),
    (f: Fixture) => unlinkSync(f.keyFile),
    (f: Fixture) => linkSync(f.keyFile, join(f.root, 'key-hardlink')),
    (f: Fixture) => {
      const directory = dirname(f.keyFile), moved = join(f.root, 'moved-receipts');
      renameSync(directory, moved); symlinkSync(moved, directory, process.platform === 'win32' ? 'junction' : 'dir');
    },
  ]) {
    const f = await fixture(t), p = await f.preview({ action: 'recipe', request: recipe() });
    f.host().close(); damage(f); f.restart();
    const reply = await f.execute(p);
    assert.equal(reply.status, 503, reply.text); assert.equal(reply.text.includes(f.root), false);
    assert.equal(f.work.runs().length, 0);
    assert.equal((await f.call('/v1/workflows')).status, 503);
  }
  const f = await fixture(t), p = await f.preview({ action: 'recipe', request: recipe() });
  writeFileSync(f.keyFile, Buffer.alloc(32, 1)); // Runtime key replacement cannot change authority.
  assert.equal((await f.execute(p)).status, 503);
});

test('POSIX receipt permissions deny unsafe access; project mismatch and context errors redact details', async t => {
  const f = await fixture(t);
  if (process.platform !== 'win32') {
    const p = await f.preview({ action: 'recipe', request: recipe() });
    chmodSync(f.keyFile, 0o644); assert.equal((await f.execute(p)).status, 503);
  }
  const other = join(f.root, 'other-project'); mkdirSync(other);
  const mismatch = createWorkflowHost({ directory: f.directory, projectPath: f.projectPath,
    workStore: { store: f.work, projectPath: other } });
  assert.throws(() => mismatch.list(), { code: 'WORKFLOW_PROJECT' }); mismatch.close();
  const context = await fixture(t), id = await context.create();
  context.contextFailure();
  const reply = await context.call('/v1/workflows/' + id);
  assert.equal(reply.status, 503); assert.equal(json(reply).error, 'WORKFLOW_CONTEXT');
  assert.ok(!reply.text.includes(context.token) && !reply.text.includes(context.projectPath));
});

test('fresh previews allow distinct identical recipes; key substitution and cross-project receipts deny', async t => {
  const f = await fixture(t), p = await f.preview({ action: 'recipe', request: recipe() });
  const second = await f.preview({ action: 'recipe', request: recipe() });
  assert.deepEqual(p.prepared, second.prepared); assert.notEqual(p.receiptHash, second.receiptHash);
  assert.equal((await f.execute(p)).status, 200); assert.equal((await f.execute(second)).status, 200);
  assert.equal(f.work.runs().length, 2);
  const other = await fixture(t);
  assert.equal((await other.execute(p)).status, 403); assert.equal(other.work.runs().length, 0);
  const third = await f.preview({ action: 'recipe', request: recipe() });
  const changed = structuredClone(third);
  changed.receiptHash = '0'.repeat(16) + changed.receiptHash.slice(16);
  assert.equal((await f.execute(changed)).status, 403);
});

test('private receipt storage cannot be used as a project scope or handoff artifact', async t => {
  const f = await fixture(t, { stateInsideProject: true });
  assert.equal((await f.call('/v1/workflows/preview', {
    action: 'recipe', request: { ...recipe(), scope: ['state/workflow-human-receipts'] },
  })).status, 400);
  const id = await f.create(), bytes = readFileSync(f.keyFile);
  assert.equal((await f.call('/v1/workflows/preview', {
    action: 'handoff', workflowId: id, submission: { key: 'prompt', artifacts: [{
      path: relative(f.projectPath, f.keyFile).replaceAll('\\', '/'), role: 'brief', sha256: hash(bytes), bytes: bytes.length,
    }], subjectHashes: [], checks: [] },
  })).status, 400);
  assert.equal((await f.get(id)).workflow.taskStates.prompt, 'pending');
});

test('explicit halt excludes an uncertain workflow from current flow and never repeats lost mutations', async t => {
  const f = await fixture(t), p = await f.preview({ action: 'recipe', request: recipe() });
  const original = f.work.create.bind(f.work); let calls = 0;
  f.work.create = input => { calls++; original(input); throw new Error('Response lost'); };
  const key = randomUUID(); assert.equal((await f.execute(p, key)).status, 202);
  const id = json<WorkflowSnapshot>(await f.call('/v1/workflows/current-flow')).workflow.id;
  const halt = await f.preview({ action: 'reconcile', workflowId: id, resolution: 'halt' });
  assert.equal((await f.execute(halt)).status, 200);
  assert.equal((await f.get(id)).workflow.state, 'halted');
  assert.equal(json(await f.call('/v1/workflows/current-flow')), null);
  f.restart(); assert.equal((await f.execute(p, key)).status, 202); assert.equal(calls, 1);
});
