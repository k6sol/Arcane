import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createServer, IncomingMessage, request as httpRequest, type ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import {
  studioTestRoutes, STUDIO_TEST_HTTP_LIMITS,
  type StudioTestRouteService, type StudioTestActor,
} from '../../apps/daemon/src/studio-test-routes.js';

// Synthetic caller credentials only. This harness never imports a provider,
// Studio adapter, the parent server, or the actual playtest service.
const HUMAN = 'fixture-human-control-secret', HUMAN_NEXT = 'fixture-human-control-rotated';
const AGENT_A = 'fixture-agent-a-secret', AGENT_B = 'fixture-agent-b-secret';
const HUMAN_ID = 'human';
const agentId = (token: string) => 'agent-' + createHash('sha256').update(token).digest('hex');
const ORIGIN = 'http://127.0.0.1:43210';
const PREPARE = { nativeStudioId: 'studio-fixture', sessionId: 'paired-fixture',
  durationMs: 5_000, observationIntervalMs: 1_000, failOnRuntimeError: true };
const APPROVE = { id: 'job-1', displayDigest: 'a'.repeat(64) };
type Call = { method: string; actor?: string; input?: unknown };
function problem(code: string, message = 'fixture service refusal'): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
function gate() {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  return { pending, release };
}
const flush = async () => { await new Promise<void>(resolve => setImmediate(resolve)); };

function fakeService() {
  const calls: Call[] = [];
  const jobs = new Map<string, { owner: string; job: { id: string; state: string } }>();
  const hooks: {
    prepare?: () => Promise<unknown>;
    approve?: (input: unknown, guard: () => void) => Promise<unknown>;
    list?: () => unknown;
    cancel?: () => Promise<unknown>;
  } = {};
  const own = (id: string, actor: string) => {
    const found = jobs.get(id);
    if (!found || (actor !== HUMAN_ID && found.owner !== actor)) throw problem('NOT_FOUND');
    return found.job;
  };
  const service: StudioTestRouteService = {
    requests: {
      async prepare(input, actor) {
        calls.push({ method: 'prepare', actor, input });
        if (hooks.prepare) return hooks.prepare();
        const job = { id: 'job-' + (jobs.size + 1), state: 'prepared' };
        jobs.set(job.id, { owner: actor, job }); return job;
      },
      status(id, actor) { calls.push({ method: 'status', actor, input: id }); return own(id, actor); },
      list(actor) {
        calls.push({ method: 'list', actor });
        return hooks.list ? hooks.list() : [...jobs.values()].filter(value => actor === HUMAN_ID || value.owner === actor).map(value => value.job);
      },
      async cancel(id, actor) {
        calls.push({ method: 'cancel', actor, input: id });
        if (hooks.cancel) return hooks.cancel();
        const job = own(id, actor); job.state = 'cancelled'; return job;
      },
    },
    humanControl: {
      async approve(input, guard) {
        calls.push({ method: 'approve', input });
        if (hooks.approve) return hooks.approve(input, guard);
        await Promise.resolve(); guard();
        calls.push({ method: 'approved-effect', input }); return { id: (input as { id: string }).id, state: 'approved' };
      },
    },
    lifecycle: { async close() { calls.push({ method: 'close' }); } },
  };
  return { service, calls, hooks, jobs };
}
function resolveActor(request: IncomingMessage): StudioTestActor | null {
  const header = request.headers.authorization;
  if (header === 'Bearer ' + HUMAN || header === 'Bearer ' + HUMAN_NEXT) return { kind: 'human', id: HUMAN_ID };
  if (header === 'Bearer ' + AGENT_A) return { kind: 'agent', id: agentId(AGENT_A) };
  if (header === 'Bearer ' + AGENT_B) return { kind: 'agent', id: agentId(AGENT_B) };
  return null;
}
async function httpFixture(t: TestContext) {
  const fake = fakeService();
  const route = studioTestRoutes(fake.service, resolveActor);
  const clientSockets = new Map<Socket, Promise<void>>();
  let origin = '';
  const server = createServer((request, response) => {
    void route(request, response, new URL(request.url ?? '/', origin), origin).then(handled => {
      if (!handled) { response.writeHead(404); response.end(); }
    }).catch(error => { response.destroy(error as Error); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  origin = 'http://127.0.0.1:' + address.port;
  t.after(async () => {
    const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closed;
    await Promise.all(clientSockets.values());
  });
  const call = (options: { path: string; method?: string; body?: string | Buffer; token?: string | null; headers?: Record<string, string> }) =>
    new Promise<{ status: number; text: string; headers: Record<string, string | string[] | undefined>; json: unknown }>((resolve, reject) => {
      const method = options.method ?? (options.body === undefined ? 'GET' : 'POST');
      const token = options.token === undefined ? AGENT_A : options.token;
      const outgoing = httpRequest(origin + options.path, { method, agent: false, headers: {
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}), ...options.headers,
      } }, response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.once('error', reject);
        response.once('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: response.statusCode!, text, headers: response.headers, json: text ? JSON.parse(text) as unknown : null });
        });
      });
      outgoing.once('socket', socket => {
        if (!clientSockets.has(socket)) clientSockets.set(socket, new Promise<void>(resolve => socket.once('close', resolve)));
      });
      outgoing.once('error', reject); outgoing.end(options.body);
    });
  const post = (endpoint: string, input: unknown, token: string | null = AGENT_A, headers: Record<string, string> = {}) =>
    call({ path: '/v1/playtests/' + endpoint, body: JSON.stringify(input), token, headers });
  return { ...fake, call, post, origin };
}

class ResponseFixture extends EventEmitter {
  destroyed = false; writableEnded = false; writableFinished = false; headersSent = false;
  status = 0; text = ''; headers: Record<string, string | number> = {};
  setHeader(name: string, value: string | number) { this.headers[name.toLowerCase()] = value; return this; }
  writeHead(status: number, headers: Record<string, string | number>) {
    this.status = status; this.headersSent = true;
    for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    return this;
  }
  end(text: string) { this.text = text; this.writableEnded = true; this.writableFinished = true; this.emit('finish'); return this; }
}
function streamFixture(t: TestContext, options: { path?: string; method?: string; actor?: StudioTestActor | null; origin?: string } = {}) {
  const fake = fakeService();
  const socket = new Socket();
  Object.defineProperty(socket, 'remoteAddress', { value: '127.0.0.1', configurable: true });
  const request = new IncomingMessage(socket);
  request.method = options.method ?? 'POST'; request.url = options.path ?? '/v1/playtests/approve';
  request.headers = { host: new URL(ORIGIN).host, 'content-type': 'application/json', authorization: 'Bearer ' + HUMAN, origin: ORIGIN };
  request.rawHeaders = Object.entries(request.headers).flatMap(([key, value]) => [key, value as string]);
  const response = new ResponseFixture();
  const state = { actor: options.actor === undefined ? { kind: 'human', id: HUMAN_ID } as StudioTestActor : options.actor, resolves: 0 };
  const route = studioTestRoutes(fake.service, () => { state.resolves++; return state.actor; });
  const start = () => route(request, response as unknown as ServerResponse, new URL(request.url!, ORIGIN), options.origin ?? ORIGIN);
  const finishBody = (value: unknown = APPROVE) => { request.complete = true; request.push(Buffer.from(JSON.stringify(value))); request.push(null); };
  t.after(() => { request.destroy(); socket.destroy(); });
  return { ...fake, request, response, state, route, start, finishBody, socket };
}

test('loopback HTTP dispatch passes only opaque actors and enforces service ownership on list/status/cancel', async t => {
  const f = await httpFixture(t);
  const created = await f.post('prepare', PREPARE);
  assert.equal(created.status, 200); assert.deepEqual(created.json, { job: { id: 'job-1', state: 'prepared' } });
  assert.deepEqual(f.calls[0], { method: 'prepare', actor: agentId(AGENT_A), input: PREPARE });
  assert.deepEqual((await f.call({ path: '/v1/playtests' })).json, { jobs: [{ id: 'job-1', state: 'prepared' }] });
  assert.deepEqual((await f.call({ path: '/v1/playtests', token: AGENT_B })).json, { jobs: [] });
  assert.equal((await f.call({ path: '/v1/playtests?id=job-1', token: AGENT_B })).status, 404);
  assert.equal((await f.post('cancel', { id: 'job-1' }, AGENT_B)).status, 404);
  assert.equal(f.jobs.get('job-1')?.job.state, 'prepared');
  assert.equal((await f.call({ path: '/v1/playtests?id=job-1' })).status, 200);
  assert.equal((await f.post('cancel', { id: 'job-1' })).status, 200);
  assert.equal(f.jobs.get('job-1')?.job.state, 'cancelled');
  assert.equal((await f.post('prepare', PREPARE, HUMAN)).status, 200);
  assert.deepEqual((await f.call({ path: '/v1/playtests', token: HUMAN_NEXT })).json,
    { jobs: [{ id: 'job-1', state: 'cancelled' }, { id: 'job-2', state: 'prepared' }] });
  assert.equal((await f.call({ path: '/v1/playtests?id=job-1', token: HUMAN })).status, 200);
  assert.ok(f.calls.filter(call => call.method === 'list').some(call => call.actor === HUMAN_ID));
  assert.ok(f.calls.every(call => !call.actor?.includes(AGENT_A) && !call.actor?.includes(HUMAN)));
  assert.equal(f.calls.some(call => call.method === 'close'), false);
});

test('only the authenticated human with exact Origin can approve; payload claims never establish authority', async t => {
  const f = await httpFixture(t);
  for (const token of [AGENT_A, AGENT_B, null]) {
    const result = await f.post('approve', { ...APPROVE, role: 'human', human: true, consent: true }, token, { Origin: f.origin });
    assert.equal(result.status, token === null ? 401 : 403);
  }
  assert.equal((await f.post('approve', APPROVE, HUMAN)).status, 403);
  for (const origin of ['null', 'https://attacker.example', f.origin + '/', f.origin.replace('127.0.0.1', 'localhost')])
    assert.equal((await f.post('approve', APPROVE, HUMAN, { Origin: origin })).status, 403);
  for (const claim of [{ role: 'human' }, { actor: HUMAN_ID }, { authenticatedHuman: true }, { consent: true }, { guard: true }])
    assert.equal((await f.post('approve', { ...APPROVE, ...claim }, HUMAN, { Origin: f.origin })).status, 400);
  assert.deepEqual(f.calls, []);
  const result = await f.post('approve', APPROVE, HUMAN, { Origin: f.origin });
  assert.equal(result.status, 200); assert.deepEqual(result.json, { job: { id: 'job-1', state: 'approved' } });
  assert.deepEqual(f.calls, [{ method: 'approve', input: APPROVE }, { method: 'approved-effect', input: APPROVE }]);
});

test('exact Host/Origin and loopback peer checks run before service dispatch', async t => {
  const f = await httpFixture(t);
  for (const host of ['attacker.example', 'localhost:' + new URL(f.origin).port, '127.0.0.1:1', '127.0.0.1', '127.0.0.2:' + new URL(f.origin).port])
    assert.equal((await f.call({ path: '/v1/playtests', headers: { Host: host } })).status, 403, host);
  assert.equal((await f.call({ path: '/v1/playtests', headers: { Origin: 'https://attacker.example' } })).status, 403);
  for (const headers of [{ 'Sec-Fetch-Site': 'same-origin' }, { 'User-Agent': 'Mozilla/5.0 fixture' }, { 'Sec-Fetch-Dest': 'empty' }])
    assert.equal((await f.post('prepare', PREPARE, AGENT_A, headers)).status, 403);
  assert.deepEqual(f.calls, []);
  const s = streamFixture(t, { path: '/v1/playtests', method: 'GET' });
  Object.defineProperty(s.socket, 'remoteAddress', { value: '192.0.2.1' });
  await s.start(); assert.equal(s.response.status, 403); assert.deepEqual(s.calls, []);
  for (const origin of ['https://127.0.0.1:43210', 'http://localhost:43210', ORIGIN + '/', 'http://user@127.0.0.1:43210', 'http://127.0.0.1']) {
    const s = streamFixture(t, { path: '/v1/playtests', method: 'GET', origin });
    await s.start(); assert.equal(s.response.status, 403, origin); assert.deepEqual(s.calls, []);
  }
});

test('route matching, methods, query keys and bodyless GET are exact', async t => {
  const f = await httpFixture(t);
  assert.equal((await f.call({ path: '/v1/playtests-other' })).status, 404);
  assert.equal((await f.call({ path: '/v1/playtests/unknown' })).status, 404);
  assert.equal((await f.call({ path: '/v1/playtests/' })).status, 404);
  const wrong = await f.call({ path: '/v1/playtests', method: 'POST', body: '{}' });
  assert.equal(wrong.status, 405); assert.equal(wrong.headers.allow, 'GET');
  const wrongPrepare = await f.call({ path: '/v1/playtests/prepare' });
  assert.equal(wrongPrepare.status, 405); assert.equal(wrongPrepare.headers.allow, 'POST');
  for (const path of ['/v1/playtests?id=job-1&id=job-2', '/v1/playtests?actor=human', '/v1/playtests?limit=1',
    '/v1/playtests/prepare?id=job-1', '/v1/playtests/approve?human=true', '/v1/playtests/cancel?id=job-1'])
    assert.equal((await f.call({ path, ...(path.includes('/') && path.startsWith('/v1/playtests/') ? { body: '{}' } : {}) })).status, 400, path);
  for (const id of ['', '../job', 'job/1', 'job-1\n', 'x'.repeat(129)])
    assert.equal((await f.call({ path: '/v1/playtests?id=' + encodeURIComponent(id) })).status, 400);
  assert.equal((await f.call({ path: '/v1/playtests', method: 'GET', body: '{}', headers: { 'Content-Length': '2' } })).status, 400);
  assert.deepEqual(f.calls, []);
  const s = streamFixture(t, { path: '/v1/elsewhere', method: 'GET' });
  assert.equal(await s.start(), false); assert.equal(s.response.status, 0); assert.equal(s.state.resolves, 0);
  for (const [path, status] of [['/v1/x/../playtests', 400], [ORIGIN + '/v1/playtests', 400],
    ['/v1/playtests#fragment', 403], ['/v1/playtests/%70repare', 400]] as const) {
    const s = streamFixture(t, { path, method: 'GET' });
    await s.start(); assert.equal(s.response.status, status, path); assert.deepEqual(s.calls, []);
  }
});

test('prepare schema rejects credentials, authority, code, URLs, connection settings and binding overrides', async t => {
  const f = await httpFixture(t);
  for (const extra of [{ actor: 'human' }, { role: 'human' }, { human: true }, { consent: true }, { authorization: HUMAN },
    { lua: 'print("untrusted")' }, { source: 'print("untrusted")' }, { url: 'https://attacker.example' },
    { connectOptions: {} }, { executable: 'anything' }, { artifactPath: 'C:/fixture.lua' }, { pluginArtifactHash: 'b'.repeat(64) },
    { scopeRevision: 'c'.repeat(64) }, { placeId: 0 }, { binding: {} }, { provider: 'fixture' }, { method: 'execute_luau' }])
    assert.equal((await f.post('prepare', { ...PREPARE, ...extra })).status, 400, JSON.stringify(extra));
  for (const value of [null, [], 1, 'human', true, {}, { ...PREPARE, failOnRuntimeError: 'true' },
    { ...PREPARE, nativeStudioId: 'https://attacker.example' }, { ...PREPARE, sessionId: 'a\n' },
    { ...PREPARE, nativeStudioId: { role: 'human' } }])
    assert.equal((await f.post('prepare', value)).status, 400);
  const missingSession: Record<string, unknown> = { ...PREPARE }; delete missingSession.sessionId;
  assert.equal((await f.post('prepare', missingSession)).status, 400);
  assert.equal((await f.post('prepare', { ...PREPARE, pairedSessionId: 'legacy-id' })).status, 400);
  assert.deepEqual(f.calls, []);
});

test('preparation uses service defaults, optional Studio ID, and exact duration/interval bounds', async t => {
  const f = await httpFixture(t);
  for (const durationMs of [4_999, 60_001, -1, 5_000.5, '5000', null])
    assert.equal((await f.post('prepare', { ...PREPARE, durationMs })).status, 400);
  for (const observationIntervalMs of [249, 2_001, -1, 250.5, '1000', null])
    assert.equal((await f.post('prepare', { ...PREPARE, observationIntervalMs })).status, 400);
  assert.equal((await f.post('prepare', { ...PREPARE, nativeStudioId: null })).status, 400);
  assert.deepEqual(f.calls, []);
  assert.equal((await f.post('prepare', { sessionId: 'paired-fixture' })).status, 200);
  assert.deepEqual(f.calls[0], { method: 'prepare', actor: agentId(AGENT_A), input: {
    sessionId: 'paired-fixture', durationMs: 15_000, observationIntervalMs: 1_000, failOnRuntimeError: true,
  } });
  for (const values of [{ durationMs: 5_000, observationIntervalMs: 250 }, { durationMs: 60_000, observationIntervalMs: 2_000 },
    { durationMs: 60_000, observationIntervalMs: 250 }])
    assert.equal((await f.post('prepare', { ...PREPARE, ...values, failOnRuntimeError: false })).status, 200);
});

test('approval and cancel accept exactly a bounded job ID and approval digest', async t => {
  const f = await httpFixture(t);
  for (const displayDigest of ['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'a'.repeat(64) + '\n', null, true])
    assert.equal((await f.post('approve', { ...APPROVE, displayDigest }, HUMAN, { Origin: f.origin })).status, 400);
  for (const id of ['', 'a'.repeat(129), '../x', 'x\n', 1, null, { human: true }]) {
    assert.equal((await f.post('approve', { ...APPROVE, id }, HUMAN, { Origin: f.origin })).status, 400);
    assert.equal((await f.post('cancel', { id })).status, 400);
  }
  for (const input of [{}, { id: 'job-1', actor: agentId(AGENT_A) }, { id: 'job-1', human: true }, { id: 'job-1', displayDigest: APPROVE.displayDigest }])
    assert.equal((await f.post('cancel', input)).status, 400);
  assert.deepEqual(f.calls, []);
});

test('HTTP body accepts only unencoded UTF-8 JSON and rejects malformed, duplicate and ambiguous input', async t => {
  const f = await httpFixture(t);
  for (const headers of [{ 'Content-Type': 'text/plain' }, { 'Content-Type': 'application/x-www-form-urlencoded' },
    { 'Content-Type': 'application/json; charset=latin1' }, { 'Content-Type': 'application/json; extra=true' },
    { 'Content-Encoding': 'gzip' }, { 'Content-Encoding': 'br' }, { 'Content-Encoding': 'identity' }])
    assert.equal((await f.post('prepare', PREPARE, AGENT_A, headers)).status, 415);
  for (const body of ['', '{', '{} trailing', '{"id":"job-1","id":"job-2"}', '{"id":"job-1","\\u0069d":"job-2"}',
    '\ufeff{"id":"job-1"}', Buffer.from([0x7b, 0x22, 0x69, 0x64, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d])])
    assert.equal((await f.call({ path: '/v1/playtests/cancel', body })).status, 400);
  assert.deepEqual(f.calls, []);
  assert.equal((await f.post('prepare', PREPARE, AGENT_A, { 'Content-Type': 'Application/JSON; charset="UTF-8"' })).status, 200);
});

test('16 KiB body limit counts declared and streamed bytes; exact maximum remains usable', async t => {
  const f = await httpFixture(t);
  const json = JSON.stringify(PREPARE);
  const exact = json + ' '.repeat(STUDIO_TEST_HTTP_LIMITS.bodyBytes - Buffer.byteLength(json));
  assert.equal((await f.call({ path: '/v1/playtests/prepare', body: exact, headers: { 'Content-Length': String(Buffer.byteLength(exact)) } })).status, 200);
  assert.equal((await f.call({ path: '/v1/playtests/prepare', body: exact + ' ' })).status, 413);
  assert.equal((await f.call({ path: '/v1/playtests/prepare', body: exact + ' ', headers: { 'Content-Length': String(Buffer.byteLength(exact) + 1) } })).status, 413);
  assert.equal((await f.call({ path: '/v1/playtests/prepare', body: 'é'.repeat(9_000) })).status, 413);
  assert.equal(f.calls.length, 1);
  const s = streamFixture(t, { path: '/v1/playtests/prepare' });
  s.request.headers['content-length'] = '-1';
  await s.start(); assert.equal(s.response.status, 413); assert.deepEqual(s.calls, []);
});

test('duplicate security headers and resolver-returned raw credentials cannot enter the service', async t => {
  for (const name of ['Host', 'Authorization', 'Origin', 'Content-Type', 'Content-Encoding', 'Content-Length', 'Transfer-Encoding']) {
    const f = streamFixture(t, { path: '/v1/playtests', method: 'GET' });
    f.request.rawHeaders.push(name, 'fixture', name.toLowerCase(), 'fixture');
    await f.start(); assert.equal(f.response.status, name === 'Authorization' ? 401 : 400, name); assert.deepEqual(f.calls, []);
  }
  const invalidActors: (StudioTestActor | null)[] = [null, { kind: 'agent', id: HUMAN }, { kind: 'human', id: '' }, { kind: 'human', id: 'human\n' },
    { kind: 'human', id: 'x'.repeat(257) }, { kind: 'model', id: HUMAN_ID } as unknown as StudioTestActor];
  for (const actor of invalidActors) {
    const f = streamFixture(t, { path: '/v1/playtests', method: 'GET', actor });
    await f.start(); assert.equal(f.response.status, 401); assert.deepEqual(f.calls, []);
  }
  for (const actor of [{ kind: 'agent', id: HUMAN_ID }, { kind: 'human', id: 'human-replacement' }] as const) {
    const f = streamFixture(t, { path: '/v1/playtests', method: 'GET', actor });
    await f.start(); assert.equal(f.response.status, 403); assert.deepEqual(f.calls, []);
  }
});

test('responses have byte bounds, fixed security headers and no caller bearer in service results', async t => {
  const f = await httpFixture(t);
  const overhead = Buffer.byteLength(JSON.stringify({ job: { text: '' } }));
  f.hooks.prepare = async () => ({ text: 'x'.repeat(STUDIO_TEST_HTTP_LIMITS.responseBytes - overhead) });
  const exact = await f.post('prepare', PREPARE);
  t.diagnostic('Exact response boundary acknowledged.');
  assert.equal(exact.status, 200); assert.equal(Buffer.byteLength(exact.text), STUDIO_TEST_HTTP_LIMITS.responseBytes);
  assert.equal(Number(exact.headers['content-length']), STUDIO_TEST_HTTP_LIMITS.responseBytes);
  assert.equal(exact.headers['cache-control'], 'no-store'); assert.equal(exact.headers['x-content-type-options'], 'nosniff');
  assert.equal(exact.headers['referrer-policy'], 'no-referrer'); assert.match(String(exact.headers['content-type']), /^application\/json/);
  f.hooks.prepare = async () => ({ text: 'x'.repeat(STUDIO_TEST_HTTP_LIMITS.responseBytes - overhead + 1) });
  assert.equal((await f.post('prepare', PREPARE)).status, 502);
  t.diagnostic('Oversized POST response refused.');
  f.hooks.list = () => [{ text: 'é'.repeat(70_000) }];
  assert.equal((await f.call({ path: '/v1/playtests' })).status, 502);
  t.diagnostic('Oversized GET response refused.');
  f.hooks.prepare = async () => ({ [AGENT_A]: 'Bearer ' + AGENT_A, text: AGENT_A });
  const scrubbed = await f.post('prepare', PREPARE);
  t.diagnostic('Credential-bearing diagnostic redacted.');
  assert.equal(scrubbed.status, 200); assert.equal(scrubbed.text.includes(AGENT_A), false);
  assert.match(scrubbed.text, /REDACTED/); assert.doesNotThrow(() => JSON.parse(scrubbed.text));
  const circular: Record<string, unknown> = {}; circular.self = circular;
  f.hooks.prepare = async () => circular;
  assert.equal((await f.post('prepare', PREPARE)).status, 503);
});

test('known and unknown service failures use fixed messages without error, provider or credential disclosure', async t => {
  const f = await httpFixture(t);
  for (const [code, status] of [['BUSY', 409], ['NOT_FOUND', 404], ['HUMAN_AUTH_REQUIRED', 403], ['PLACE_DENIED', 403],
    ['FENCED', 409], ['CONSENT_EXPIRED', 409], ['TIMEOUT', 504], ['SHUTDOWN', 503], ['JOURNAL_FAILED', 503], ['invented-secret-code', 503]] as const) {
    f.hooks.prepare = async () => { throw problem(code, 'provider stdout ' + AGENT_A + ' ' + HUMAN); };
    const result = await f.post('prepare', PREPARE);
    assert.equal(result.status, status, code); assert.equal(result.text.includes(AGENT_A), false);
    assert.equal(result.text.includes(HUMAN), false); assert.equal(result.text.includes('provider stdout'), false);
    assert.equal(result.text.includes('invented-secret-code'), false);
  }
});

test('upload rechecks the original actor before prepare/cancel/approve reaches the service', async t => {
  for (const [path, body] of [['/v1/playtests/prepare', PREPARE], ['/v1/playtests/cancel', { id: 'job-1' }],
    ['/v1/playtests/approve', APPROVE]] as const) {
    for (const next of [null, { kind: 'agent', id: agentId(AGENT_A) }, { kind: 'human', id: 'human:replacement' }] as const) {
      const f = streamFixture(t, { path }); const text = JSON.stringify(body);
      const handling = f.start(); f.request.push(Buffer.from(text.slice(0, 8))); await flush();
      f.state.actor = next; f.request.complete = true; f.request.push(Buffer.from(text.slice(8))); f.request.push(null);
      await handling; assert.ok([401, 403].includes(f.response.status));
      assert.deepEqual(f.calls, [], path); assert.equal(f.request.listenerCount('data'), 0);
    }
  }
});

test('approval guard rejects identity loss or change after a service await before any approval effect', async t => {
  for (const next of [null, { kind: 'agent', id: agentId(AGENT_A) }, { kind: 'human', id: 'human:replacement' }] as const) {
    const f = streamFixture(t); const wait = gate(); let guard: (() => void) | undefined;
    f.hooks.approve = async (_input, recheck) => { guard = recheck; await wait.pending; recheck(); f.calls.push({ method: 'approved-effect' }); return {}; };
    const handling = f.start(); f.finishBody(); await flush(); assert.ok(guard);
    f.state.actor = next; wait.release(); await handling;
    assert.ok([401, 403].includes(f.response.status)); assert.equal(f.calls.some(call => call.method === 'approved-effect'), false);
    assert.throws(guard); assert.equal(f.response.listenerCount('close'), 0);
  }
});

test('approval snapshots a mutable resolver result and permits a fresh object with the same stable human ID', async t => {
  const f = streamFixture(t); const wait = gate();
  f.hooks.approve = async (_input, guard) => { await wait.pending; guard(); f.calls.push({ method: 'approved-effect' }); return {}; };
  const handling = f.start(); f.finishBody(); await flush();
  f.state.actor = { kind: 'human', id: HUMAN_ID }; wait.release(); await handling;
  assert.equal(f.response.status, 200); assert.equal(f.calls.filter(call => call.method === 'approved-effect').length, 1);
  const changed = streamFixture(t); const waitChanged = gate();
  changed.hooks.approve = async (_input, guard) => { await waitChanged.pending; guard(); return {}; };
  const pending = changed.start(); changed.finishBody(); await flush();
  (changed.state.actor as { id: string }).id = 'human-mutated'; waitChanged.release(); await pending;
  assert.equal(changed.response.status, 403);
});

test('approval guard checks response liveness and exact Origin again after awaiting', async t => {
  for (const alter of [
    (f: ReturnType<typeof streamFixture>) => { f.response.destroyed = true; },
    (f: ReturnType<typeof streamFixture>) => { f.response.writableEnded = true; },
    (f: ReturnType<typeof streamFixture>) => { f.response.headersSent = true; },
    (f: ReturnType<typeof streamFixture>) => { f.request.headers.origin = 'https://attacker.example'; },
    (f: ReturnType<typeof streamFixture>) => { delete f.request.headers.origin; },
    (f: ReturnType<typeof streamFixture>) => { f.request.headers.host = 'attacker.example'; },
  ]) {
    const f = streamFixture(t); const wait = gate(); let guard: (() => void) | undefined;
    f.hooks.approve = async (_input, recheck) => { guard = recheck; await wait.pending; recheck(); f.calls.push({ method: 'approved-effect' }); return {}; };
    const handling = f.start(); f.finishBody(); await flush(); assert.ok(guard);
    alter(f); wait.release(); await handling;
    assert.equal(f.calls.some(call => call.method === 'approved-effect'), false); assert.throws(guard);
    assert.notEqual(f.response.status, 200);
  }
});

test('disconnect settles the route and invalidates the approval guard while service work is still pending', async t => {
  const f = streamFixture(t); const wait = gate(); let guard: (() => void) | undefined;
  f.hooks.approve = async (_input, recheck) => { guard = recheck; await wait.pending; recheck(); f.calls.push({ method: 'approved-effect' }); return {}; };
  const handling = f.start(); f.finishBody(); await flush(); assert.ok(guard);
  f.response.destroyed = true; f.response.emit('close');
  assert.equal(await handling, true); assert.equal(f.response.status, 0); assert.throws(guard);
  wait.release(); await flush(); assert.equal(f.calls.some(call => call.method === 'approved-effect'), false);
  assert.equal(f.response.listenerCount('close'), 0); assert.equal(f.calls.some(call => call.method === 'close'), false);
});

test('absolute 8 second deadline rejects a slow-drip body and removes body listeners', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = streamFixture(t, { path: '/v1/playtests/prepare' });
  const handling = f.start(); f.request.push(Buffer.from('{')); await flush();
  t.mock.timers.tick(7_999); f.request.push(Buffer.from(' ')); await flush(); assert.equal(f.response.status, 0);
  t.mock.timers.tick(1); await handling;
  assert.equal(f.response.status, 408); assert.match(f.response.text, /BODY_TIMEOUT/); assert.deepEqual(f.calls, []);
  for (const name of ['data', 'end', 'error', 'aborted']) assert.equal(f.request.listenerCount(name), 0, name);
  assert.equal(f.response.listenerCount('close'), 0);
});

test('8 second deadline also invalidates approval after a pending service await without replay', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = streamFixture(t); const wait = gate(); let guard: (() => void) | undefined;
  f.hooks.approve = async (_input, recheck) => { guard = recheck; await wait.pending; recheck(); f.calls.push({ method: 'approved-effect' }); return {}; };
  const handling = f.start(); f.finishBody(); await flush(); assert.ok(guard);
  t.mock.timers.tick(8_000); await handling;
  assert.equal(f.response.status, 504); assert.throws(guard); wait.release(); await flush();
  assert.equal(f.calls.filter(call => call.method === 'approve').length, 1);
  assert.equal(f.calls.some(call => call.method === 'approved-effect'), false);
  assert.equal(f.response.listenerCount('close'), 0);
});

test('aborted uploads never dispatch service operations and clean up listeners', async t => {
  const f = streamFixture(t, { path: '/v1/playtests/prepare' });
  const handling = f.start(); f.request.push(Buffer.from('{')); await flush();
  f.request.aborted = true; f.request.emit('aborted'); await handling;
  assert.equal(f.response.status, 400); assert.deepEqual(f.calls, []);
  for (const name of ['data', 'end', 'error', 'aborted']) assert.equal(f.request.listenerCount(name), 0, name);
});
