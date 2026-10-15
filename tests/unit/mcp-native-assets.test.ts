import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { DaemonClient, type AssetAudience } from '../../apps/mcp/src/daemon-client.js';
import { createMcpServer } from '../../apps/mcp/src/server.js';
import { assetHistoryInput, assetJobPage, nativeAssetHistoryInput, nativeAssetJobPage, nativeAssetStart, nativeAssetCancel } from '../../apps/mcp/src/asset-schemas.js';
import { normalizeRequest } from '../../packages/asset-pipeline/src/validation.js';
import type { AssetManifest } from '../../packages/asset-pipeline/src/types.js';
import { HISTORY_PAGE_BYTES, type AssetJobRecord } from '../../apps/daemon/src/asset-service.js';

// Owned loopback HTTP and official in-memory SDK fixtures only. No installed
// provider/worker, native history, daemon startup or filesystem writes.
const ROOT = resolve(process.cwd()), TOKEN = 'owned-native-asset-fixture-bearer';
const JOB_ID = '11111111-1111-4111-8111-111111111111', OTHER_ID = '22222222-2222-4222-8222-222222222222';
const INPUT = { template: 'hero-prop' as const, name: 'native-fixture' }, REQUEST = normalizeRequest(INPUT);
const SCOPE = { projectId: 'a'.repeat(64), projectPath: ROOT,
  conversation: { provider: 'codex' as const, threadId: 'Native:Thread.Exact', sessionId: null as string | null } };
const PROBE = { observedAt: '2026-10-13T00:00:00Z', available: false, blender: null, python: null, attempts: [] };
function cursor(sequence: number, scope = SCOPE) {
  const { projectId, conversation: c } = scope;
  return createHash('sha256').update(JSON.stringify([projectId, c.provider, c.threadId, c.sessionId, 'asset-job'])).digest('hex') + ':' + sequence;
}
function job(jobId = JOB_ID): AssetJobRecord {
  return { schemaVersion: 1, jobId, directory: resolve(ROOT, 'synthetic-assets', jobId), manifestPath: null,
    request: REQUEST, state: 'failed', stage: 'Retained café 🌿', startedAt: '2026-10-13T00:00:00Z',
    updatedAt: '2026-10-13T00:00:01Z', events: [{ jobId, at: '2026-10-13T00:00:01Z', stage: 'audit', state: 'failed' }],
    manifestAvailable: false, error: { code: 'FIXTURE', message: 'Complete retained failure evidence.' } };
}
function page(jobs = [job()], nextCursor: string | null = null) {
  return { ...SCOPE, jobs, nextCursor, byteLimit: HISTORY_PAGE_BYTES };
}
function ack(jobId: string | null = JOB_ID, association: 'bound' | 'unknown' = 'bound', creation: 'created' | 'unknown' = 'created') {
  return { ...SCOPE, jobId, association, creation, retry: false as const };
}
function genericPage(jobs = [job()], nextCursor: string | null = null) {
  return { schemaVersion: 1 as const, jobs, total: jobs.length, nextCursor, byteLimit: HISTORY_PAGE_BYTES };
}
function manifest(jobId = JOB_ID): AssetManifest {
  return { schemaVersion: 1, jobId, createdAt: '2026-10-13T00:00:00Z', request: REQUEST,
    runtime: { executable: 'synthetic/blender', version: 'fixture', pythonVersion: 'fixture', background: true,
      capabilities: { glbExport: true, glbImport: true, fbxExport: true, fbxImport: true, cycles: true } },
    templateSha256: 'b'.repeat(64),
    coordinateSystem: { units: 'meters', sceneUp: 'Z', glbUp: 'Y', fbxUp: 'Y', pivot: 'floor', robloxScaleVerified: false },
    validation: { schemaVersion: 1, template: 'hero-prop', meshes: [{ name: 'SM_fixture', role: 'render',
      vertices: 8, edges: 12, faces: 6, triangles: 12, nonManifoldEdges: 0, looseVertices: 0, looseEdges: 0,
      duplicateVertices: 0, duplicateFaces: 0, degenerateFaces: 0, inconsistentNormals: 0, invertedComponents: 0,
      finitePositions: true, uvLayers: 1, uvLoops: 24, invalidUVs: 0, degenerateUVFaces: 0,
      dimensions: [1, 1, 1], scale: [1, 1, 1], rotation: [0, 0, 0], materials: ['MAT_fixture'], errors: [] }],
      totals: { renderTriangles: 12, lod1Triangles: 0, collisionTriangles: 0, materials: 1 },
      renders: [], exports: [], savedSceneReopened: true, errors: [], warnings: [] },
    artifacts: [{ path: 'audit.json', role: 'audit', bytes: 100, sha256: 'c'.repeat(64) }],
    limitations: ['Synthetic response only; no installed runtime or production asset verification.'] };
}
function send(response: ServerResponse, status: number, payload: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(payload));
}
type Observation = { method: string; url: string; auth: string | undefined; origin: string | undefined; body: unknown };
type Responder = (url: URL, response: ServerResponse, request: IncomingMessage, body: unknown) => void | Promise<void>;
async function fixture(t: test.TestContext, responder: Responder, audience: AssetAudience = 'native-session') {
  const requests: Observation[] = [], failures: unknown[] = [];
  const http = createServer((request, response) => { void (async () => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
    requests.push({ method: request.method ?? '', url: request.url ?? '', auth: request.headers.authorization, origin: request.headers.origin, body });
    await responder(new URL(request.url ?? '/', 'http://127.0.0.1'), response, request, body);
  })().catch(error => { failures.push(error); if (!response.destroyed) send(response, 500, { error: 'FIXTURE', message: 'Fixture assertion failed.' }); }); });
  await new Promise<void>((accept, reject) => {
    http.once('error', reject); http.listen(0, '127.0.0.1', () => { http.off('error', reject); accept(); });
  });
  const address = http.address(); assert.ok(address && typeof address !== 'string');
  t.after(async () => {
    http.closeAllConnections();
    await new Promise<void>((accept, reject) => http.close(error => error ? reject(error) : accept()));
    assert.deepEqual(failures, [], 'HTTP fixture assertions');
  });
  const daemon = new DaemonClient({ url: 'http://127.0.0.1:' + address.port, token: TOKEN, assetAudience: audience });
  const server = createMcpServer({ client: daemon, projectRoot: ROOT });
  const client = new Client({ name: 'owned-native-assets-sdk', version: '1.0.0' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  return { requests, daemon, client };
}
async function call(client: Client, name: string, input: Record<string, unknown> = {}) {
  return CallToolResultSchema.parse(await client.callTool({ name, arguments: input }));
}
function onlyNative(requests: Observation[]) { assert.ok(requests.every(request => request.url.startsWith('/v1/assets/native/'))); }

test('native MCP: trusted constructor routing and exact environment opt-in', () => {
  const options = { url: 'http://127.0.0.1:12345', token: TOKEN };
  assert.equal(new DaemonClient(options).assetAudience, 'generic');
  assert.equal(new DaemonClient({ ...options, assetAudience: 'generic' }).assetAudience, 'generic');
  assert.equal(new DaemonClient({ ...options, assetAudience: 'native-session' }).assetAudience, 'native-session');
  const env = { ARCANE_DAEMON_URL: options.url, ARCANE_LOCAL_TOKEN: TOKEN };
  assert.equal(DaemonClient.fromEnvironment(env).assetAudience, 'generic');
  assert.equal(DaemonClient.fromEnvironment({ ...env, ARCANE_ASSET_AUDIENCE: 'native-session' }).assetAudience, 'native-session');
  for (const value of ['', 'generic', 'native', 'NATIVE-SESSION', ' native-session', 'native-session ', 'native-session\n', 'placeholder']) {
    assert.throws(() => DaemonClient.fromEnvironment({ ...env, ARCANE_ASSET_AUDIENCE: value }), { code: 'CONFIG_ASSET_AUDIENCE' }, value);
  }
  for (const value of ['', 'native', null, true, {}]) {
    assert.throws(() => new DaemonClient({ ...options, assetAudience: value as AssetAudience }), { code: 'CONFIG_ASSET_AUDIENCE' });
  }
});

test('native MCP: all asset tools use exact native paths and the same existing bearer', async t => {
  const f = await fixture(t, (url, response, _request, body) => {
    switch (url.pathname) {
      case '/v1/assets/native/probe': assert.deepEqual(body, {}); send(response, 200, { probe: PROBE }); break;
      case '/v1/assets/native/jobs': assert.equal(body, null); send(response, 200, page()); break;
      case '/v1/assets/native/start': assert.deepEqual(body, INPUT); send(response, 202, ack()); break;
      case '/v1/assets/native/cancel': assert.deepEqual(body, { jobId: JOB_ID }); send(response, 200, { job: { ...job(), state: 'cancelled' } }); break;
      case '/v1/assets/native/manifest': assert.equal(url.searchParams.get('jobId'), JOB_ID); send(response, 200, { manifest: manifest() }); break;
      default: assert.fail('Unexpected path ' + url.pathname);
    }
  });
  assert.deepEqual((await call(f.client, 'assets_probe')).structuredContent, { probe: PROBE });
  assert.deepEqual((await call(f.client, 'assets_jobs')).structuredContent, page());
  assert.deepEqual((await call(f.client, 'assets_start', INPUT)).structuredContent, ack());
  assert.deepEqual((await call(f.client, 'assets_cancel', { jobId: JOB_ID })).structuredContent, { job: { ...job(), state: 'cancelled' } });
  assert.deepEqual((await call(f.client, 'assets_manifest', { jobId: JOB_ID })).structuredContent, { manifest: manifest() });
  assert.deepEqual(f.requests.map(request => [request.method, request.url]), [
    ['POST', '/v1/assets/native/probe'], ['GET', '/v1/assets/native/jobs'], ['POST', '/v1/assets/native/start'],
    ['POST', '/v1/assets/native/cancel'], ['GET', '/v1/assets/native/manifest?jobId=' + JOB_ID],
  ]);
  assert.ok(f.requests.every(request => request.auth === 'Bearer ' + TOKEN && request.origin === undefined));
});

test('native MCP: 202 unknown start ACK preserves witnessed ID and independent creation/association status', async t => {
  const values = [ack(null, 'unknown', 'unknown'), ack(JOB_ID, 'unknown', 'unknown'), ack(JOB_ID, 'unknown', 'created'), ack(), { ...ack(), job: job() }];
  let current: unknown = values[0];
  const f = await fixture(t, (_url, response) => send(response, 202, current));
  for (const value of values) {
    current = value; const result = await call(f.client, 'assets_start', INPUT);
    assert.notEqual(result.isError, true); assert.deepEqual(result.structuredContent, value);
    assert.equal(result.structuredContent?.retry, false); assert.equal(Object.hasOwn(result.structuredContent!, 'ambiguous'), false);
    const content = result.content[0]; assert.ok(content?.type === 'text'); assert.deepEqual(JSON.parse(content.text), value);
  }
  assert.equal(f.requests.length, values.length); onlyNative(f.requests);
});

test('native schemas: reject contradictory ACKs, non-UUID jobs and incomplete records', () => {
  for (const value of [
    { ...ack(), creation: 'confirmed' }, { ...ack(), creation: 'unknown' }, ack(null), ack(null, 'unknown', 'created'),
    { ...ack(), retry: true }, { ...ack(), jobId: 'synthetic-id' }, { ...ack(), jobId: JOB_ID + '\n' }, { ...ack(), job: job(OTHER_ID) },
    { ...ack(null, 'unknown', 'unknown'), job: job() }, { ...ack(), job: { jobId: JOB_ID } }, { job: job() },
    { ...ack(), projectId: undefined }, { ...ack(), creation: undefined }, { ...ack(), grant: true },
  ]) assert.equal(nativeAssetStart.safeParse(value).success, false, JSON.stringify(value));
  assert.equal(nativeAssetStart.safeParse(ack()).success, true, 'Job record is optional');
  for (const value of [{ jobId: JOB_ID, state: 'unknown', retry: true }, { jobId: 'bad', state: 'unknown', retry: false },
    { jobId: JOB_ID, state: 'cancelled', retry: false }, { jobId: JOB_ID + '\n', state: 'unknown', retry: false }]) assert.equal(nativeAssetCancel.safeParse(value).success, false);
});

test('native schemas: bounded IDs, absolute project path, scope cursors, complete records and raw UTF-8 bytes', () => {
  const scopes = [
    { ...SCOPE, projectId: 'a'.repeat(63) }, { ...SCOPE, projectId: 'A'.repeat(64) }, { ...SCOPE, projectId: SCOPE.projectId + '\n' },
    { ...SCOPE, projectPath: '' }, { ...SCOPE, projectPath: 'relative/project' }, { ...SCOPE, projectPath: ROOT + '\0' },
    { ...SCOPE, projectPath: resolve(ROOT, '🌿'.repeat(1500)) },
    { ...SCOPE, conversation: { ...SCOPE.conversation, provider: 'claude-code' } },
    { ...SCOPE, conversation: { ...SCOPE.conversation, threadId: '' } },
    { ...SCOPE, conversation: { ...SCOPE.conversation, threadId: 'a'.repeat(257) } },
    { ...SCOPE, conversation: { ...SCOPE.conversation, threadId: 'Thread/Outside' } },
    { ...SCOPE, conversation: { ...SCOPE.conversation, threadId: 'Thread\n' } },
    { ...SCOPE, conversation: { ...SCOPE.conversation, sessionId: '' } },
    { ...SCOPE, conversation: { ...SCOPE.conversation, sessionId: 'a'.repeat(257) } },
    { ...SCOPE, conversation: { ...SCOPE.conversation, sessionId: undefined } },
  ];
  for (const scope of scopes) {
    assert.equal(nativeAssetJobPage.safeParse({ ...page(), ...scope }).success, false);
    assert.equal(nativeAssetStart.safeParse({ ...ack(), ...scope }).success, false);
  }
  const sessionScope = { ...SCOPE, conversation: { ...SCOPE.conversation, sessionId: 'Session:Exact' } };
  assert.equal(nativeAssetJobPage.safeParse({ ...page(), ...sessionScope, nextCursor: cursor(1, sessionScope) }).success, true);
  for (const after of [JOB_ID, 'b'.repeat(64) + ':0', 'b'.repeat(64) + ':01', 'b'.repeat(64) + ':9007199254740992',
    'b'.repeat(64) + ':1\n', 'b'.repeat(64) + ':' + '1'.repeat(17)]) assert.equal(nativeAssetHistoryInput.safeParse({ after }).success, false, after);
  for (const value of [
    { ...page(), byteLimit: HISTORY_PAGE_BYTES + 1 }, { ...page(), nextCursor: JOB_ID }, page([job(), job()]),
    page([{ jobId: JOB_ID } as AssetJobRecord]), page([{ ...job(JOB_ID + '\n'), events: [] }]), page([{ ...job(), events: [{ ...job().events[0]!, jobId: OTHER_ID }] }]),
    { ...page(), jobs: Array.from({ length: 65 }, (_, i) => job((i + 1).toString(16).padStart(8, '0') + '-1111-4111-8111-111111111111')) },
    { ...page(), nextCursor: cursor(1, { ...SCOPE, conversation: { ...SCOPE.conversation, sessionId: 'Other:Session' } }) },
    { ...page(), schemaVersion: 1 },
  ]) assert.equal(nativeAssetJobPage.safeParse(value).success, false);
  assert.equal(nativeAssetJobPage.safeParse(page([], cursor(1))).success, true, 'Missing associated jobs do not invalidate a scope cursor');
  const padded = { ...job(), ignored: '🌿'.repeat(HISTORY_PAGE_BYTES / 4) };
  assert.equal(nativeAssetJobPage.safeParse(page([padded])).success, false, 'Raw bytes are checked before unknown fields are stripped');
  assert.equal(nativeAssetStart.safeParse({ ...ack(), job: padded }).success, false);
  const largeJobs = Array.from({ length: 64 }, (_, i) => ({ ...job((i + 1).toString(16).padStart(8, '0') + '-1111-4111-8111-111111111111'),
    error: { code: 'FIXTURE', message: '🌿'.repeat(2048) } }));
  assert.ok(Buffer.byteLength(JSON.stringify(page(largeJobs))) > HISTORY_PAGE_BYTES);
  assert.equal(nativeAssetJobPage.safeParse(page(largeJobs)).success, false);
});

test('native MCP: explicit storage-scope pagination preserves complete records with no automatic fetch', async t => {
  const first = page([job()], cursor(9)), second = page([job(OTHER_ID)]);
  const f = await fixture(t, (url, response) => {
    assert.equal(url.searchParams.get('limit'), '1');
    const after = url.searchParams.get('after');
    if (after === null) send(response, 200, first);
    else { assert.equal(after, cursor(9)); send(response, 200, second); }
  });
  const result = await call(f.client, 'assets_jobs', { limit: 1 });
  assert.deepEqual(result.structuredContent, first); assert.equal(f.requests.length, 1);
  assert.deepEqual((await call(f.client, 'assets_jobs', { limit: 1, after: result.structuredContent!.nextCursor })).structuredContent, second);
  assert.equal(f.requests[1]!.url, '/v1/assets/native/jobs?limit=1&after=' + encodeURIComponent(cursor(9)));
  assert.equal(f.requests.length, 2);
  assert.equal(assetHistoryInput.safeParse({ after: cursor(9) }).success, false);
  assert.equal(assetHistoryInput.safeParse({ after: JOB_ID }).success, true);
});

test('native MCP: wrong history schemas, overflows and foreign returned cursors fail without fallback', async t => {
  let payload: unknown = page();
  const f = await fixture(t, (_url, response) => send(response, 200, payload));
  for (const invalid of [genericPage(), { ...page(), projectId: 'bad' },
    { ...page(), conversation: { ...SCOPE.conversation, provider: 'claude-code' } }, page([job()], 'b'.repeat(64) + ':1'),
    page([job(), job(OTHER_ID)]), { ...page(), jobs: [{ ...job(), ignored: 'x'.repeat(HISTORY_PAGE_BYTES) }] }]) {
    payload = invalid; const result = await call(f.client, 'assets_jobs', { limit: 1 });
    assert.equal(result.isError, true); assert.equal((result.structuredContent?.error as { code: string }).code, 'PROTOCOL');
  }
  assert.equal(f.requests.length, 6); onlyNative(f.requests);
});

test('native MCP: after cursor scope and sequence cannot cross project/thread/session or move backwards', async t => {
  let payload = page([job()]);
  const f = await fixture(t, (_url, response) => send(response, 200, payload));
  for (const scope of [{ ...SCOPE, projectId: 'b'.repeat(64) },
    { ...SCOPE, conversation: { ...SCOPE.conversation, threadId: 'Another:Thread' } },
    { ...SCOPE, conversation: { ...SCOPE.conversation, sessionId: 'Session:Other' } }]) {
    const result = await call(f.client, 'assets_jobs', { after: cursor(3, scope) });
    assert.equal(result.isError, true); assert.equal((result.structuredContent?.error as { code: string }).code, 'PROTOCOL');
  }
  payload = page([job()], cursor(3));
  assert.equal((await call(f.client, 'assets_jobs', { after: cursor(3) })).isError, true);
  payload = page([job()], cursor(2));
  assert.equal((await call(f.client, 'assets_jobs', { after: cursor(3) })).isError, true);
  assert.equal(f.requests.length, 5); onlyNative(f.requests);
});

for (const failure of ['dropped', 'malformed', 'schema', 'overflow', '500', 'redirect', 'timeout'] as const) {
  test('native MCP: start ' + failure + ' retains ambiguity with no retry/fallback/adoption', async t => {
    const f = await fixture(t, (url, response, request) => {
      if (url.pathname === '/v1/assets/native/jobs') { send(response, 200, page()); return; }
      assert.equal(url.pathname, '/v1/assets/native/start');
      switch (failure) {
        case 'dropped': request.socket.destroy(); break;
        case 'malformed': response.writeHead(202, { 'Content-Type': 'application/json' }); response.end('{'); break;
        case 'schema': send(response, 202, { ...ack(), creation: 'unknown' }); break;
        case 'overflow': send(response, 202, { ...ack(), job: { ...job(), ignored: 'x'.repeat(HISTORY_PAGE_BYTES) } }); break;
        case '500': send(response, 500, { error: 'INTERNAL', message: 'Start response uncertain' }); break;
        case 'redirect': response.writeHead(302, { Location: '/v1/assets/start' }); response.end(); break;
        case 'timeout': break;
      }
    });
    const result = await call(f.client, 'assets_start', { ...INPUT, timeoutMs: 150 });
    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent?.jobId, null); assert.equal(result.structuredContent?.state, 'unknown');
    assert.equal(result.structuredContent?.terminal, false); assert.equal(result.structuredContent?.ambiguous, true);
    assert.equal(result.structuredContent?.retry, false); assert.equal(result.structuredContent?.name, INPUT.name);
    assert.equal(result.structuredContent?.wait, failure === 'timeout' ? 'timeout' : 'interrupted');
    assert.match(String(result.structuredContent?.nextStep), /assets_jobs.*same native project and conversation scope/);
    assert.match(String(result.structuredContent?.nextStep), /do not repeat.*adopt/);
    assert.equal(f.requests.length, 1, 'No automatic lookup or replay');
    assert.deepEqual((await call(f.client, 'assets_jobs')).structuredContent, page());
    assert.equal(f.requests.length, 2); onlyNative(f.requests);
    assert.equal(f.requests.filter(request => request.method === 'POST').length, 1);
  });
}

test('native MCP: post-admission 202 cancel unknown is ambiguous, no-retry and preserves exact UUID', async t => {
  const f = await fixture(t, (url, response, _request, body) => {
    assert.equal(url.pathname, '/v1/assets/native/cancel'); assert.deepEqual(body, { jobId: JOB_ID });
    send(response, 202, { jobId: JOB_ID, state: 'unknown', retry: false });
  });
  const result = await call(f.client, 'assets_cancel', { jobId: JOB_ID });
  assert.notEqual(result.isError, true);
  assert.equal(result.structuredContent?.jobId, JOB_ID); assert.equal(result.structuredContent?.state, 'unknown');
  assert.equal(result.structuredContent?.retry, false); assert.equal(result.structuredContent?.ambiguous, true);
  assert.equal(result.structuredContent?.terminal, false);
  assert.match(String(result.structuredContent?.nextStep), /same native project and conversation scope/);
  assert.equal(f.requests.length, 1); onlyNative(f.requests);
});

test('native MCP: missing authority and foreign cursor denial stay definitive; client mode grants nothing', async t => {
  const f = await fixture(t, (_url, response) => send(response, 403, { error: 'NATIVE_ASSET_AUTHORITY', message: 'Denied ' + TOKEN }));
  for (const [name, input] of [['assets_probe', {}], ['assets_jobs', { after: 'b'.repeat(64) + ':1' }],
    ['assets_start', INPUT], ['assets_cancel', { jobId: JOB_ID }], ['assets_manifest', { jobId: JOB_ID }]] as const) {
    const result = await call(f.client, name, input);
    assert.equal(result.isError, true); assert.equal((result.structuredContent?.error as { code: string }).code, 'NATIVE_ASSET_AUTHORITY');
    assert.ok(!JSON.stringify(result).includes(TOKEN));
  }
  assert.equal(f.requests.length, 5); onlyNative(f.requests);
  assert.ok(f.requests.every(request => request.auth === 'Bearer ' + TOKEN));
});

test('native MCP: identity, audience and grants in every tool JSON are rejected before HTTP', async t => {
  const f = await fixture(t, () => assert.fail('Invalid tool input must not reach HTTP'));
  const fields = ['assetAudience', 'audience', 'projectId', 'projectPath', 'provider', 'threadId', 'sessionId',
    'conversation', 'grant', 'assetGrant', 'allowWrites', 'writeGranted', 'actor', 'role', 'authority', 'capabilities', 'operationId'];
  for (const [name, input] of [['assets_probe', {}], ['assets_jobs', {}], ['assets_start', INPUT],
    ['assets_cancel', { jobId: JOB_ID }], ['assets_manifest', { jobId: JOB_ID }]] as const) {
    for (const field of fields) assert.equal((await call(f.client, name, { ...input, [field]: 'forged' })).isError, true, name + ':' + field);
  }
  for (const after of [JOB_ID, 'x', cursor(1) + '\n']) assert.equal((await call(f.client, 'assets_jobs', { after })).isError, true);
  await assert.rejects(f.daemon.assetsStart({ ...INPUT, conversation: SCOPE.conversation } as typeof INPUT));
  await assert.rejects(f.daemon.assetsJobs({ after: JOB_ID }));
  for (const name of ['assets_cancel', 'assets_manifest']) assert.equal((await call(f.client, name, { jobId: JOB_ID + '\n' })).isError, true);
  await assert.rejects(f.daemon.assetsCancel(JOB_ID + '\n'));
  await assert.rejects(f.daemon.assetsManifest(JOB_ID + '\n'));
  assert.equal(f.requests.length, 0);
});

test('native MCP: existing probe/manifest/cancel record checks retain requested job identity', async t => {
  const f = await fixture(t, (url, response) => {
    if (url.pathname.endsWith('/probe')) send(response, 200, { probe: { available: false } });
    else if (url.pathname.endsWith('/manifest')) send(response, 200, { manifest: manifest(OTHER_ID) });
    else send(response, 200, { job: job(OTHER_ID) });
  });
  assert.equal((await call(f.client, 'assets_probe')).structuredContent?.ambiguous, true);
  assert.equal((await call(f.client, 'assets_manifest', { jobId: JOB_ID })).isError, true);
  const cancelled = await call(f.client, 'assets_cancel', { jobId: JOB_ID });
  assert.equal(cancelled.structuredContent?.jobId, JOB_ID); assert.equal(cancelled.structuredContent?.ambiguous, true);
  assert.equal(cancelled.structuredContent?.retry, false);
  assert.match(String(cancelled.structuredContent?.nextStep), /same native project and conversation scope/);
  assert.equal(f.requests.length, 3); onlyNative(f.requests);
});

test('native MCP: fixed descriptions/annotations explain scope, host permission and unproven originating turn', async t => {
  const f = await fixture(t, () => assert.fail('Listing tools must not contact HTTP'));
  const tools = (await f.client.listTools()).tools.filter(tool => tool.name.startsWith('assets_'));
  assert.equal(tools.length, 9);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.additionalProperties, false); assert.equal(tool.annotations?.openWorldHint, false);
    assert.match(tool.description!, /exact project and Codex conversation scope/);
    assert.match(tool.description!, /explicit host asset permission.*open admission window/);
    assert.match(tool.description!, /routing mode grants no authority/);
    assert.match(tool.description!, /no originating-turn provenance/);
    const mutation = ['assets_start', 'assets_adopt_glb', 'assets_cancel', 'assets_prepare_studio_import', 'assets_stage_studio_import'].includes(tool.name);
    assert.equal(tool.annotations?.readOnlyHint, !mutation); assert.equal(tool.annotations?.idempotentHint, !mutation);
  }
  assert.equal(f.requests.length, 0);
});

test('generic MCP: endpoints, envelopes, UUID cursors, bearer, descriptions and annotations stay unchanged', async t => {
  const f = await fixture(t, (url, response) => {
    switch (url.pathname) {
      case '/v1/assets/probe': send(response, 200, { probe: PROBE }); break;
      case '/v1/assets/jobs': assert.equal(url.searchParams.get('after'), JOB_ID); send(response, 200, genericPage([job(OTHER_ID)])); break;
      case '/v1/assets/start': send(response, 202, { job: job() }); break;
      case '/v1/assets/cancel': send(response, 200, { job: job() }); break;
      case '/v1/assets/manifest': send(response, 200, { manifest: manifest() }); break;
      case '/v1/work/runs': send(response, 200, { runs: [] }); break;
      default: assert.fail('Unexpected generic route');
    }
  }, 'generic');
  assert.deepEqual((await call(f.client, 'assets_probe')).structuredContent, { probe: PROBE });
  assert.deepEqual((await call(f.client, 'assets_jobs', { after: JOB_ID })).structuredContent, genericPage([job(OTHER_ID)]));
  assert.deepEqual((await call(f.client, 'assets_start', INPUT)).structuredContent, { job: job() });
  assert.deepEqual((await call(f.client, 'assets_cancel', { jobId: JOB_ID })).structuredContent, { job: job() });
  assert.deepEqual((await call(f.client, 'assets_manifest', { jobId: JOB_ID })).structuredContent, { manifest: manifest() });
  assert.equal((await call(f.client, 'assets_jobs', { after: cursor(1) })).isError, true);
  assert.deepEqual(f.requests.map(request => [request.method, request.url]), [
    ['POST', '/v1/assets/probe'], ['GET', '/v1/assets/jobs?after=' + JOB_ID], ['POST', '/v1/assets/start'],
    ['POST', '/v1/assets/cancel'], ['GET', '/v1/assets/manifest?jobId=' + JOB_ID],
  ]);
  assert.equal(assetJobPage.safeParse(genericPage()).success, true); assert.equal(assetJobPage.safeParse(page()).success, false);
  const tools = (await f.client.listTools()).tools.filter(tool => tool.name.startsWith('assets_'));
  for (const tool of tools) assert.ok(!tool.description!.includes('Native-session'));
  const probe = tools.find(tool => tool.name === 'assets_probe')!;
  assert.match(probe.description!, /^Read: probe installed local Blender\/Python/);
  assert.equal(probe.annotations?.readOnlyHint, true); assert.equal(probe.annotations?.idempotentHint, true);
  assert.ok(f.requests.every(request => request.auth === 'Bearer ' + TOKEN));
  const native = new DaemonClient({ url: f.daemon.url, token: TOKEN, assetAudience: 'native-session' });
  assert.deepEqual(await native.workRuns(), { runs: [] });
  assert.equal(f.requests.at(-1)!.url, '/v1/work/runs', 'Asset audience does not retarget other capabilities');
});
