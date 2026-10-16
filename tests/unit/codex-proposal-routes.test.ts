import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import { codexRoutes } from '../../apps/daemon/src/codex-routes.js';
import { createCodexService, type CodexService, type CodexProposalList } from '../../apps/daemon/src/codex-service.js';
import { createNativeAssetRegistry } from '../../apps/daemon/src/native-asset-authority.js';
import { CodexClientError } from '../../packages/codex-client/src/types.js';

// Route fixtures only: a spy service and a real unconnected service. No native CLI,
// worker, inference or Studio is involved.
const HUMAN = 'a'.repeat(64), AGENT = 'b'.repeat(64);
const scope = () => ({ connectionId: randomUUID(), threadId: 'thread:exact', taskId: randomUUID() });
function list(taskId: string, text = 'Proposal text'): CodexProposalList {
  return { taskId, display: 'proposal_not_applied', proposals: [{ proposalId: randomUUID(), requestId: randomUUID(), state: 'proposed', reason: null, text,
    textSha256: 'c'.repeat(64), textBytes: Buffer.byteLength(text), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }] };
}
async function serve(t: test.TestContext, service: CodexService) {
  const route = codexRoutes(service); let origin = '';
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => { if (!await route(request, response, new URL(request.url ?? '/', origin), HUMAN, origin, AGENT)) { response.writeHead(404); response.end(); } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const post = async (body: string, options: { bearer?: string | null; origin?: string | null; path?: string; method?: string; type?: string } = {}) => {
    const headers: Record<string, string> = { 'Content-Type': options.type ?? 'application/json' };
    if (options.bearer !== null) headers.Authorization = 'Bearer ' + (options.bearer ?? HUMAN);
    if (options.origin !== null) headers.Origin = options.origin ?? origin;
    const response = await fetch(origin + (options.path ?? '/v1/codex/proposals'), { method: options.method ?? 'POST', headers, ...(options.method === 'GET' ? {} : { body }), signal: AbortSignal.timeout(10000) });
    const text = await response.text(); return { status: response.status, text, data: JSON.parse(text) as Record<string, unknown> };
  };
  return { origin, post };
}
function spy(proposals?: (input: unknown) => CodexProposalList) {
  const calls: unknown[] = [], actions: unknown[] = [];
  const service = { state: () => { throw new Error('state must not be read'); }, action: async (input: unknown) => { actions.push(input); throw new Error('no action'); }, close: async () => {},
    ...(proposals ? { proposals: (input: unknown) => { calls.push(structuredClone(input)); return proposals(input); } } : {}) } as unknown as CodexService;
  return { service, calls, actions };
}

test('human proposal read returns the exact scoped list and never journals or acts', async t => {
  const s = spy(input => list((input as { taskId: string }).taskId)), h = await serve(t, s.service), body = scope();
  const response = await h.post(JSON.stringify(body));
  assert.equal(response.status, 200); assert.deepEqual(Object.keys(response.data), ['proposals']);
  assert.equal((response.data.proposals as CodexProposalList).taskId, body.taskId); assert.deepEqual(s.calls, [body]); assert.deepEqual(s.actions, []);
});

test('authority, origin, method, query and envelope refusals happen before any service access', async t => {
  const s = spy(input => list((input as { taskId: string }).taskId)), h = await serve(t, s.service), body = JSON.stringify(scope());
  const cases: [string, Promise<{ status: number; data: Record<string, unknown> }>, number, string][] = [
    ['agent bearer', h.post(body, { bearer: AGENT }), 403, 'HUMAN_ONLY'], ['no bearer', h.post(body, { bearer: null }), 401, 'AUTH'],
    ['missing origin', h.post(body, { origin: null }), 403, 'ORIGIN'], ['foreign origin', h.post(body, { origin: 'http://127.0.0.1:1' }), 403, 'ORIGIN'],
    ['GET', h.post('', { method: 'GET' }), 405, 'METHOD'], ['query', h.post(body, { path: '/v1/codex/proposals?taskId=x' }), 400, 'QUERY'],
    ['content type', h.post(body, { type: 'text/plain' }), 415, 'CONTENT_TYPE'], ['oversized', h.post(JSON.stringify({ ...scope(), pad: 'x'.repeat(1100) })), 413, 'BODY_LIMIT'],
    ['malformed', h.post('{'), 400, 'JSON'],
  ];
  const bad: unknown[] = [[], null, 'x', { ...scope(), extra: 1 }, { connectionId: randomUUID(), threadId: 'thread:exact' }, { ...scope(), taskId: 'not-a-uuid' },
    { ...scope(), connectionId: 7 }, { ...scope(), threadId: '' }, { ...scope(), threadId: 'x'.repeat(257) }, { ...scope(), threadId: 'bad\u0000id' },
    { ...scope(), action: 'proposal-start' }, { ...scope(), text: 'start a worker' }];
  for (const value of bad) cases.push(['scope ' + JSON.stringify(value).slice(0, 40), h.post(JSON.stringify(value)), 400, 'PROPOSAL_SCOPE']);
  for (const [name, pending, status, error] of cases) { const response = await pending; assert.equal(response.status, status, name); assert.equal(response.data.error, error, name); }
  assert.deepEqual(s.calls, []); assert.deepEqual(s.actions, []);
});

test('service scope errors, missing capability, token privacy and response bounds stay generic', async t => {
  const refused = spy(() => { throw new CodexClientError('TASK_SCOPE', 'secret detail ' + HUMAN); }), a = await serve(t, refused.service);
  const response = await a.post(JSON.stringify(scope()));
  assert.equal(response.status, 400); assert.equal(response.data.error, 'TASK_SCOPE'); assert.ok(!response.text.includes('secret detail') && !response.text.includes(HUMAN));
  const missing = spy(), b = await serve(t, missing.service);
  assert.equal((await b.post(JSON.stringify(scope()))).data.error, 'PROPOSALS_UNAVAILABLE');
  const leaky = spy(input => list((input as { taskId: string }).taskId, 'Echo ' + HUMAN + ' and ' + AGENT)), c = await serve(t, leaky.service);
  const redacted = await c.post(JSON.stringify(scope()));
  assert.equal(redacted.status, 200); assert.ok(!redacted.text.includes(HUMAN) && !redacted.text.includes(AGENT) && redacted.text.includes('[REDACTED]'));
  const huge = spy(input => { const value = list((input as { taskId: string }).taskId); value.proposals = Array.from({ length: 8 }, () => ({ ...value.proposals[0]!, text: '\u0001'.repeat(100000), textBytes: 100000 })); return value; });
  const d = await serve(t, huge.service), bounded = await d.post(JSON.stringify(scope()));
  assert.equal(bounded.status, 500); assert.equal(bounded.data.error, 'STATE_LIMIT'); assert.ok(Buffer.byteLength(bounded.text) < 1024);
});

test('a raw oversized declared body is refused at its header boundary', async t => {
  const s = spy(input => list((input as { taskId: string }).taskId)), h = await serve(t, s.service);
  const status = await new Promise<number>((resolve, reject) => {
    const request = httpRequest(h.origin + '/v1/codex/proposals', { method: 'POST', headers: { Authorization: 'Bearer ' + HUMAN, Origin: h.origin, 'Content-Type': 'application/json', 'Content-Length': '1025' }, signal: AbortSignal.timeout(10000) },
      response => { response.resume(); response.on('end', () => { resolve(response.statusCode!); request.destroy(); }); });
    request.on('error', reject); request.end();
  });
  assert.equal(status, 413); assert.deepEqual(s.calls, []);
});

test('real service read path is unjournaled and starts no worker', async t => {
  const boundary = await realpath(tmpdir()), root = await realpath(await mkdtemp(join(boundary, 'arcane-proposal-route-'))), project = join(root, 'project'); await mkdir(project);
  const registry = createNativeAssetRegistry({ projectPath: await realpath(project) }); let workers = 0;
  const service = createCodexService({ directory: join(root, 'journal'), projectPath: project, assetRegistry: registry, connect: async () => { throw new Error('no connection in this fixture'); },
    proposalWorker: async () => { workers++; throw new Error('never'); } });
  t.after(async () => { await service.close(); registry.close(); const part = relative(boundary, root); assert.ok(part.startsWith('arcane-proposal-route-') && !isAbsolute(part) && !part.includes(sep)); await rm(root, { recursive: true, force: true }); });
  const h = await serve(t, service), before = service.state().actions.length;
  for (let index = 0; index < 3; index++) { const response = await h.post(JSON.stringify(scope())); assert.equal(response.status, 400); assert.equal(response.data.error, 'STALE_CONNECTION'); }
  assert.equal(service.state().actions.length, before); assert.equal(workers, 0);
});
