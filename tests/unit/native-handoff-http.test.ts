import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createNativeHandoffRoutes, NATIVE_HANDOFF_ROUTE_LIMITS } from '../../apps/daemon/src/native-handoff-routes.js';
import { studioRoutes } from '../../apps/daemon/src/studio-routes.js';
import { createMcpServer } from '../../apps/mcp/src/server.js';
import { DaemonClient } from '../../apps/mcp/src/daemon-client.js';
import { StudioStore } from '../../packages/storage/src/studio-store.js';
import { WorkStore } from '../../packages/storage/src/work-store.js';

// Real local HTTP composing the handoff routes beside the real StudioRoutes/WorkStore/StudioStore, as root
// will later (agentToken first, then the core token). Not wired into the app. No CLI, inference, Studio or processes.
const unhandled: unknown[] = []; process.on('unhandledRejection', error => { unhandled.push(error); });
type Reply = { status: number; body: Record<string, any>; text: string; headers: Record<string, string | string[] | undefined> };

async function fixture(t: TestContext, lifetimeMs = 60_000) {
  const base = await realpath(tmpdir()), root = await realpath(await mkdtemp(join(base, 'arcane-handoff-http-'))), project = join(root, 'project');
  await mkdir(join(project, 'reports'), { recursive: true });
  const clock = { offset: 0 }, human = randomBytes(32).toString('hex'), core = randomBytes(32).toString('hex');
  const studio = new StudioStore({ directory: join(root, 'studio') }), work = new WorkStore({ directory: join(root, 'work'), projectPath: project });
  const handoffs = createNativeHandoffRoutes({ projectPath: project, now: () => Date.now() + clock.offset, lifetimeMs });
  let origin = '';
  const bridge = studioRoutes(studio, root, work, project, (request: IncomingMessage) => handoffs.agentToken(request, origin) || core, null,
    () => { throw new Error('no original native task in this fixture'); });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', origin);
    void (async () => {
      if (await handoffs.handle(request, response, url, human, origin)) return;
      if (await bridge(request, response, url, human, origin)) return;
      response.writeHead(404, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: 'NOT_FOUND' }));
    })().catch(() => { if (!response.headersSent) { response.writeHead(500); response.end('{}'); } });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  const agents: Client[] = [];
  t.after(async () => {
    for (const close of [...agents.map(a => () => a.close()), () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }), () => handoffs.close(), () => work.close(), () => studio.close()])
      try { await close(); } catch { /* owned cleanup */ }
    const part = relative(base, root); assert.ok(part.startsWith('arcane-handoff-http-') && !isAbsolute(part) && !part.includes(sep)); await rm(root, { recursive: true, force: true });
  });
  const raw = (path: string, options: { method?: string; token?: string | null; host?: string; origin?: string | null; body?: string | Buffer; headers?: Record<string, string> } = {}) =>
    new Promise<Reply>((resolve, reject) => {
      const target = new URL(origin), headers: Record<string, string> = { Host: options.host ?? target.host, ...(options.headers ?? {}) };
      const token = options.token === undefined ? human : options.token; if (token !== null) headers.Authorization = 'Bearer ' + token;
      const method = options.method ?? (options.body === undefined ? 'GET' : 'POST');
      const sentOrigin = options.origin === undefined ? (method === 'POST' ? origin : null) : options.origin; if (sentOrigin !== null) headers.Origin = sentOrigin;
      if (options.body !== undefined) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = String(Buffer.byteLength(options.body)); }
      const req = httpRequest({ hostname: target.hostname, port: target.port, path, method, headers }, response => {
        let text = ''; response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; });
        response.on('end', () => { let body: Record<string, any> = {}; try { body = JSON.parse(text); } catch { /* non-JSON */ } resolve({ status: response.statusCode!, body, text, headers: response.headers }); });
      });
      req.setTimeout(20000, () => req.destroy(new Error('timeout'))); req.on('error', reject); if (options.body !== undefined) req.write(options.body); req.end();
    });
  const post = (path: string, value: unknown, options: Parameters<typeof raw>[1] = {}) => raw(path, { ...options, body: JSON.stringify(value) });
  const begin = (requestId = randomUUID()) => post('/v1/native-handoffs/begin', { requestId, projectId: handoffs.projectId });
  const sealed = async () => {
    const started = await begin(); assert.equal(started.status, 200, started.text);
    assert.equal((await post('/v1/native-handoffs/seal', { handoffId: started.body.handoff.handoffId, projectId: handoffs.projectId })).status, 200);
    return { handoffId: started.body.handoff.handoffId as string, credential: started.body.credential as string };
  };
  const mcp = async (token: string) => {
    const server = createMcpServer({ client: new DaemonClient({ url: origin, token }), projectRoot: project }), agent = new Client({ name: 'handoff-fixture', version: 'fixture' });
    const [left, right] = InMemoryTransport.createLinkedPair(); await server.connect(right); await agent.connect(left); agents.push(agent);
    return async (name: string, args: Record<string, unknown>) => CallToolResultSchema.parse(await agent.callTool({ name, arguments: args }));
  };
  return { origin: () => origin, human, core, project, studio, work, handoffs, clock, raw, post, begin, sealed, mcp };
}
const data = (result: { structuredContent?: unknown }) => result.structuredContent as Record<string, any>;
const tokenFree = (text: string, credential: string) => assert.ok(!text.includes(credential), 'credential leaked');
const task = (key: string) => ({ key, title: key, instructions: 'i', acceptance: 'a', scope: ['src/' + key], dependencies: [] });

test('human endpoints require the human bearer, exact Host, Origin for POST, no query/cookie and exact bounded bodies', async t => {
  const f = await fixture(t), { credential } = await f.sealed(), pid = f.handoffs.projectId, list = '/v1/native-handoffs';
  for (const [what, reply, status, error] of [
    ['no bearer', await f.raw(list, { token: null }), 401, 'AUTH'], ['core bearer', await f.raw(list, { token: f.core }), 401, 'AUTH'],
    ['handoff credential', await f.raw(list, { token: credential }), 401, 'AUTH'], ['foreign Host', await f.raw(list, { host: 'evil.example:80' }), 403, 'HOST'],
    ['foreign Origin GET', await f.raw(list, { origin: 'http://evil.example' }), 403, 'ORIGIN'], ['query', await f.raw(list + '?projectId=' + pid), 400, 'QUERY'],
    ['cookie', await f.raw(list, { headers: { Cookie: 'role=human' } }), 400, 'COOKIE'], ['unknown', await f.raw(list + '/approve'), 404, 'NOT_FOUND'],
    ['POST list', await f.post(list, {}), 405, 'METHOD'], ['GET begin', await f.raw(list + '/begin'), 405, 'METHOD'],
    ['POST without Origin', await f.post(list + '/begin', { requestId: randomUUID(), projectId: pid }, { origin: null }), 403, 'ORIGIN'],
    ['POST foreign Origin', await f.post(list + '/begin', { requestId: randomUUID(), projectId: pid }, { origin: 'http://evil.example' }), 403, 'ORIGIN'],
    ['extra key', await f.post(list + '/begin', { requestId: randomUUID(), projectId: pid, role: 'human' }), 400, 'BODY'],
    ['missing key', await f.post(list + '/begin', { requestId: randomUUID() }), 400, 'BODY'], ['bad uuid', await f.post(list + '/begin', { requestId: 'x', projectId: pid }), 400, 'BODY'],
    ['project path', await f.post(list + '/begin', { requestId: randomUUID(), projectId: f.project }), 400, 'BODY'],
    ['other project', await f.post(list + '/begin', { requestId: randomUUID(), projectId: 'b'.repeat(64) }), 409, 'PROJECT'],
    ['array', await f.raw(list + '/begin', { body: '[]' }), 400, 'BODY'], ['not JSON', await f.raw(list + '/begin', { body: '{' }), 400, 'BODY'],
    ['invalid UTF-8', await f.raw(list + '/begin', { body: Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]) }), 400, 'BODY'],
    ['oversize', await f.raw(list + '/begin', { body: JSON.stringify({ requestId: randomUUID(), projectId: pid, pad: 'x'.repeat(NATIVE_HANDOFF_ROUTE_LIMITS.bodyBytes) }) }), 413, 'BODY_LIMIT'],
  ] as const) { assert.deepEqual([reply.status, reply.body.error], [status, error], what); tokenFree(reply.text, credential); }
  const listed = await f.raw(list); assert.equal(listed.status, 200); assert.equal(listed.headers['cache-control'], 'no-store');
  assert.equal(listed.body.projectId, pid); assert.deepEqual(listed.body.handoffs.map((h: { state: string }) => h.state), ['sealed']); tokenFree(listed.text, credential);
  assert.ok(Buffer.byteLength(listed.text) <= NATIVE_HANDOFF_ROUTE_LIMITS.responseBytes);
});

test('begin emits its credential once; a duplicate or lost request is spent, never re-minted; pending credentials do not authenticate', async t => {
  const f = await fixture(t), requestId = randomUUID(), first = await f.begin(requestId);
  assert.equal(first.status, 200); assert.match(first.body.credential, /^[A-Za-z0-9_-]{43}$/); assert.equal(first.body.handoff.state, 'pending'); assert.equal(first.headers['cache-control'], 'no-store');
  const credential = first.body.credential as string, handoffId = first.body.handoff.handoffId as string;
  const duplicate = await f.begin(requestId); assert.deepEqual([duplicate.status, duplicate.body.error], [409, 'HANDOFF_SPENT']); tokenFree(duplicate.text, credential);
  assert.equal((await f.raw('/v1/native-handoffs')).body.handoffs.length, 1, 'no second credential minted');
  assert.equal((await f.raw('/v1/work/runs', { token: credential })).status, 401, 'a pending credential does not authenticate');
  const seal = await f.post('/v1/native-handoffs/seal', { handoffId, projectId: f.handoffs.projectId }); assert.equal(seal.body.handoff.state, 'sealed'); tokenFree(seal.text, credential);
  assert.equal((await f.post('/v1/native-handoffs/seal', { handoffId, projectId: f.handoffs.projectId })).body.error, 'STATE', 'seal once');
  assert.equal((await f.raw('/v1/work/runs', { token: credential })).status, 200);
  assert.deepEqual([(await f.post('/v1/native-handoffs/seal', { handoffId: randomUUID(), projectId: f.handoffs.projectId })).body.error], ['UNKNOWN']);
  // Recovery is explicit human revoke plus a new request ID.
  assert.equal((await f.post('/v1/native-handoffs/revoke', { handoffId, projectId: f.handoffs.projectId })).body.handoff.state, 'revoked');
  assert.equal((await f.raw('/v1/work/runs', { token: credential })).status, 401);
  assert.equal((await f.post('/v1/native-handoffs/seal', { handoffId, projectId: f.handoffs.projectId })).body.error, 'STATE', 'revoked never revives');
  const fresh = await f.begin(); assert.equal(fresh.status, 200); assert.notEqual(fresh.body.credential, credential);
  for (const reply of [await f.raw('/v1/native-handoffs')]) tokenFree(reply.text, credential);
});

test('spent begin records are bounded with no eviction or retry', async t => {
  const f = await fixture(t);
  for (let i = 0; i < NATIVE_HANDOFF_ROUTE_LIMITS.spentRequests; i++) {
    const started = await f.begin(); assert.equal(started.status, 200, 'begin ' + i);
    assert.equal((await f.post('/v1/native-handoffs/revoke', { handoffId: started.body.handoff.handoffId, projectId: f.handoffs.projectId })).status, 200);
  }
  const refused = await f.begin(); assert.deepEqual([refused.status, refused.body.error, refused.body.credential], [429, 'REQUEST_LIMIT', undefined]);
  assert.equal((await f.raw('/v1/native-handoffs')).body.handoffs.length, NATIVE_HANDOFF_ROUTE_LIMITS.spentRequests, 'nothing evicted or minted');
});

test('agentToken admits only the fixed method/path allowlist with exact Host/Origin; every other request is empty', async t => {
  const f = await fixture(t), { credential } = await f.sealed(), origin = f.origin(), host = new URL(origin).host, runId = randomUUID();
  const req = (method: string, url: string, headers: Record<string, string> = {}) => ({ method, url, headers: { host, authorization: 'Bearer ' + credential, ...headers } }) as unknown as IncomingMessage;
  const allowed = [['GET', '/v1/product/state'], ['GET', '/v1/work/runs'], ['GET', '/v1/work/runs/' + runId], ['GET', '/v1/work/ready'], ['GET', '/v1/work/ready?runId=' + runId],
    ['POST', '/v1/work/create'], ['POST', '/v1/work/claim'], ['POST', '/v1/work/progress'], ['POST', '/v1/work/submit'], ['GET', '/v1/studio/sessions'],
    ['GET', '/v1/studio/commands'], ['GET', '/v1/studio/commands?sessionId=s1'], ['GET', '/v1/studio/commands/cmd-1'], ['POST', '/v1/studio/commands'], ['POST', '/v1/studio/restore']];
  for (const [method, url] of allowed) assert.equal(f.handoffs.agentToken(req(method!, url!), origin), credential, method + ' ' + url);
  const denied = [['POST', '/v1/work/review'], ['POST', '/v1/product/mcp-token'], ['GET', '/v1/product/events'], ['GET', '/v1/studio/keys'], ['POST', '/v1/studio/keys'],
    ['POST', '/v1/studio/pairing'], ['POST', '/v1/studio/revoke'], ['POST', '/v1/studio/keys/rotate'], ['GET', '/v1/assets/native/x'], ['POST', '/v1/assets/generate'],
    ['POST', '/v1/codex/action'], ['GET', '/v1/native-handoffs'], ['POST', '/v1/native-handoffs/begin'], ['POST', '/v1/plugin/poll'], ['GET', '/v1/work/claim'],
    ['POST', '/v1/work/runs'], ['DELETE', '/v1/work/runs'], ['GET', '/v1/work/runs/not-a-uuid'], ['GET', '/v1/work/runs?x=1'], ['GET', '/v1/work/ready?runId=a&runId=b'],
    ['GET', '/v1/work/ready?sessionId=s'], ['GET', '/v1/studio/commands/' + 'x'.repeat(129)], ['GET', '/v1/studio/commands/a%2Fb'], ['POST', '/v1/work/create?x=1'],
    ['GET', 'http://evil.example/v1/work/runs'], ['GET', '/v1/work/runs#x']];
  for (const [method, url] of denied) assert.equal(f.handoffs.agentToken(req(method!, url!), origin), '', method + ' ' + url);
  for (const headers of [{ host: 'evil.example:80' }, { origin: 'http://evil.example' }, { authorization: 'Bearer ' + f.core }, { authorization: 'Bearer ' + credential + ' ' }, { authorization: credential }])
    assert.equal(f.handoffs.agentToken(req('GET', '/v1/work/runs', headers), origin), '', JSON.stringify(Object.keys(headers)));
  assert.equal(f.handoffs.agentToken(req('GET', '/v1/work/runs', { origin }), origin), credential, 'the exact panel Origin is allowed');
  // Over real HTTP, denied paths fall through to the core token and are refused for the handoff bearer.
  for (const [path, method] of [['/v1/work/review', 'POST'], ['/v1/product/mcp-token', 'POST'], ['/v1/studio/keys', 'GET'], ['/v1/product/events', 'GET']] as const) {
    const reply = method === 'GET' ? await f.raw(path, { token: credential }) : await f.post(path, { taskId: randomUUID(), approved: true, note: 'x' }, { token: credential, origin: null });
    assert.equal(reply.status, 401, path); tokenFree(reply.text, credential);
  }
  assert.equal((await f.raw('/v1/product/state', { token: credential })).status, 200);
});

test('unbound work coordination works through MCP; human review, grants and bound work with a copied lease are denied', async t => {
  const f = await fixture(t), { credential } = await f.sealed(), agent = await f.mcp(credential);
  const created = data(await agent('work_create', { title: 'Handoff work', objective: 'Cooperative', tasks: [task('impl')] }));
  const claim = data(await agent('work_claim', { taskId: created.run.tasks[0].id, worker: 'external native client' }));
  assert.equal(data(await agent('work_progress', { taskId: created.run.tasks[0].id, leaseToken: claim.leaseToken, progress: 'working' })).task.state, 'in_progress');
  await writeFile(join(f.project, 'reports', 'impl.txt'), 'actual evidence');
  const submitted = data(await agent('work_submit', { taskId: created.run.tasks[0].id, leaseToken: claim.leaseToken, evidence: [{ path: 'reports/impl.txt', note: 'file' }] }));
  assert.equal(submitted.task.state, 'needs_review');
  const selfReview = await f.post('/v1/work/review', { taskId: created.run.tasks[0].id, approved: true, note: 'self' }, { token: credential });
  assert.equal(selfReview.status, 401, 'a handoff credential can never review');
  assert.equal((await f.post('/v1/work/review', { taskId: created.run.tasks[0].id, approved: true, note: 'Human inspected' })).status, 200);
  // A task-bound run: invisible and refused even with a trusted copied lease.
  const bound = f.work.createForTask({ taskId: randomUUID(), planId: randomUUID(), objectiveSha256: 'c'.repeat(64),
    original: { accountIdentity: 'd'.repeat(64), connectionId: randomUUID(), incarnationId: randomUUID(), threadId: 'thread', sessionId: null, model: 'fixture', effort: 'low', allowWorkspaceWrites: true, allowAssets: false },
    run: { title: 'Bound', objective: 'Original task only', tasks: [task('bound')] } });
  const lease = f.work.claim({ taskId: bound.run.tasks[0]!.id, worker: 'trusted original' });
  assert.equal((await agent('work_ready', { runId: bound.run.id })).isError, true);
  assert.ok(!data(await agent('work_runs', {})).runs.some((run: { id: string }) => run.id === bound.run.id));
  for (const [path, body] of [['/v1/work/progress', { taskId: lease.task.id, leaseToken: lease.leaseToken, progress: 'copied' }],
    ['/v1/work/submit', { taskId: lease.task.id, leaseToken: lease.leaseToken, evidence: [{ path: 'reports/impl.txt', note: 'copied' }] }]] as const) {
    const refused = await f.post(path, body, { token: credential, origin: null }); assert.deepEqual([refused.status, refused.body.error], [403, 'SCOPE'], path);
  }
  assert.equal(f.work.task(lease.task.id).state, 'in_progress');
  assert.equal(f.studio.commands().length, 0, 'no Studio operation'); assert.equal(f.studio.sessions().length, 0, 'no Studio grant');
});

test('foreign, expired, revoked and closed credentials are denied; a held claim body revoked before effect leaves no lease', async t => {
  const f = await fixture(t), other = await fixture(t), foreign = await other.sealed();
  assert.equal((await f.raw('/v1/work/runs', { token: foreign.credential })).status, 401, 'another registry\'s credential');
  const created = data(await (await f.mcp((await f.sealed()).credential))('work_create', { title: 'Held', objective: 'x', tasks: [task('held')] }));
  const held = await f.sealed(), body = JSON.stringify({ taskId: created.run.tasks[0].id, worker: 'held' }), target = new URL(f.origin());
  const outcome = await new Promise<{ status: number; error: string }>((resolve, reject) => {
    const req = httpRequest({ hostname: target.hostname, port: target.port, path: '/v1/work/claim', method: 'POST',
      headers: { Host: target.host, Authorization: 'Bearer ' + held.credential, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, response => {
      let text = ''; response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; }); response.on('end', () => resolve({ status: response.statusCode!, error: JSON.parse(text).error }));
    });
    req.on('error', reject); req.write(body.slice(0, 8));
    void (async () => { await delay(100); assert.equal((await f.post('/v1/native-handoffs/revoke', { handoffId: held.handoffId, projectId: f.handoffs.projectId })).status, 200); req.end(body.slice(8)); })().catch(reject);
  });
  assert.deepEqual([outcome.status, outcome.error], [403, 'SCOPE'], 'refused after the body await');
  assert.equal(f.work.task(created.run.tasks[0].id).state, 'pending', 'no lease was created');
  const expiring = await f.sealed(); assert.equal((await f.raw('/v1/work/runs', { token: expiring.credential })).status, 200);
  f.clock.offset = 60_001; assert.equal((await f.raw('/v1/work/runs', { token: expiring.credential })).status, 401, 'expired');
  f.clock.offset = -3_600_000; assert.equal((await f.raw('/v1/work/runs', { token: expiring.credential })).status, 401, 'a backward clock never revives');
  f.clock.offset = 0;
  const live = await f.sealed(); assert.equal((await f.raw('/v1/work/runs', { token: live.credential })).status, 200);
  f.handoffs.close();
  assert.equal((await f.raw('/v1/work/runs', { token: live.credential })).status, 401, 'closed');
  assert.deepEqual([(await f.raw('/v1/native-handoffs')).body.error], ['CLOSED']);
});

test('a body that never completes is refused within the finite deadline', async t => {
  const f = await fixture(t), target = new URL(f.origin()), started = Date.now();
  const outcome = await new Promise<{ status: number; error: string }>((resolve, reject) => {
    const req = httpRequest({ hostname: target.hostname, port: target.port, path: '/v1/native-handoffs/begin', method: 'POST',
      headers: { Host: target.host, Origin: f.origin(), Authorization: 'Bearer ' + f.human, 'Content-Type': 'application/json', 'Content-Length': '100' } }, response => {
      let text = ''; response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; }); response.on('end', () => resolve({ status: response.statusCode!, error: JSON.parse(text).error }));
    });
    req.on('error', reject); req.write('{"requestId"');
  });
  const elapsed = Date.now() - started; t.diagnostic('body deadline after ' + elapsed + ' ms');
  assert.deepEqual([outcome.status, outcome.error], [408, 'BODY_TIMEOUT']); assert.ok(elapsed <= NATIVE_HANDOFF_ROUTE_LIMITS.bodyTimeoutMs + 2000);
  assert.equal((await f.raw('/v1/native-handoffs')).body.handoffs.length, 0, 'nothing minted');
});

test('module source owns no process, provider or Studio activation and stores no raw credential', async () => {
  // The module that actually ran: compiled JavaScript beside this compiled test.
  const source = await readFile(new URL('../../apps/daemon/src/native-handoff-routes.js', import.meta.url), 'utf8');
  for (const forbidden of ['child_process', 'spawn(', 'execFile', 'codex', 'assetService', 'createHash']) assert.ok(!source.includes(forbidden), 'no ' + forbidden);
  // Mutable state (collections created empty): only the lease map and the spent request set. The other two are fixed path allowlists.
  assert.equal(source.match(/new (Map|Set|WeakMap)\(\)/g)?.length, 2, 'only the lease map and the spent request set are retained');
  await delay(20); assert.deepEqual(unhandled, []);
});
