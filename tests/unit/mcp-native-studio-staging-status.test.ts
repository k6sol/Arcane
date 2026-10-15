import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {CallToolResultSchema} from '@modelcontextprotocol/sdk/types.js';
import {DaemonClient, BridgeError, type AssetAudience} from '../../apps/mcp/src/daemon-client.js';
import {createMcpServer} from '../../apps/mcp/src/server.js';
import {NATIVE_STUDIO_STAGING_STATUS_RESPONSE_BYTES, nativeStudioStagingStatusResponse,
  parseNativeStudioStagingStatusResponse, type NativeStudioStagingStatusResponse} from '../../packages/asset-pipeline/src/studio-staging-status-wire.js';
import {ARCANE_TOOL_NAMES, ARCANE_NATIVE_TOOL_NAMES} from '../../packages/protocol/src/arcane-tools.js';

// Mocked fetch and in-memory SDK only; no actual controller, socket or engine.
const JOB = '11111111-1111-4111-8111-111111111111', OTHER = '22222222-2222-4222-8222-222222222222';
const PROJECT = 'b'.repeat(64), DIGEST = 'a'.repeat(64), TOKEN = 'synthetic-status-bearer';
const TOOL = 'assets_studio_staging_status', PATH = '/v1/assets/native/studio-staging-status?jobId=' + JOB;
type Stage = NonNullable<NativeStudioStagingStatusResponse['stage']>;
function stage(): Stage {
  return {runId: OTHER, phase: 'cpu-staged', transferDigest: DIGEST, plannedPacketCount: 1,
    plannedEnvelopeBytes: 4096, commands: [{ordinal: 0, commandId: JOB, state: 'succeeded'}],
    receipt: {transferDigest: DIGEST, packetCount: 1, byteLength: 1024, state: 'sealed', engineVerification: 'pending'},
    engineVerification: 'pending', imported: false, retry: false};
}
function response(value: Stage | null = stage()): NativeStudioStagingStatusResponse {return {jobId: JOB, projectId: PROJECT, stage: value};}
function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json; charset=utf-8', ...headers}});
}
function fixture(t: test.TestContext, audience: AssetAudience = 'native-session') {
  const requests: {url: string; init: RequestInit}[] = [];
  let responder: (signal: AbortSignal) => Response | Promise<Response> = () => json(response());
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    assert.ok(init); const signal = init.signal; assert.ok(signal);
    requests.push({url: String(url), init}); return responder(signal);
  });
  const daemon = new DaemonClient({url: 'http://127.0.0.1:12345', token: TOKEN, assetAudience: audience});
  return {daemon, requests, respond(fn: typeof responder) {responder = fn;}};
}
async function linked(t: test.TestContext, daemon: DaemonClient) {
  const server = createMcpServer({client: daemon, projectRoot: process.cwd()}), client = new Client({name: 'status-fixture', version: '1'});
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  t.after(async () => {await client.close(); await server.close();}); return client;
}
async function call(client: Client, input: Record<string, unknown> = {jobId: JOB}) {
  return CallToolResultSchema.parse(await client.callTool({name: TOOL, arguments: input}));
}

test('status codec detaches exact scope and preserves null, planned running and terminal CPU evidence', () => {
  assert.deepEqual(parseNativeStudioStagingStatusResponse(response(null), JOB, PROJECT), response(null));
  for (const phase of ['running', 'stopped', 'needs_reconciliation'] as const) {
    const initial: Stage = {...stage(), phase, commands: [], receipt: null};
    assert.deepEqual(parseNativeStudioStagingStatusResponse(response(initial), JOB), response(initial));
    assert.equal(nativeStudioStagingStatusResponse.safeParse(response({...stage(), phase})).success, true);
  }
  const input = response(), parsed = parseNativeStudioStagingStatusResponse(input, JOB, PROJECT);
  assert.notEqual(parsed, input); assert.notEqual(parsed.stage, input.stage);
  assert.notEqual(parsed.stage!.commands, input.stage!.commands); assert.notEqual(parsed.stage!.receipt, input.stage!.receipt);
  input.stage!.commands[0]!.state = 'failed'; assert.equal(parsed.stage!.commands[0]!.state, 'succeeded');
  assert.equal(NATIVE_STUDIO_STAGING_STATUS_RESPONSE_BYTES, 64 * 1024);
});

test('status codec rejects scope changes, authority fields, false completion and contradictory accounting', () => {
  assert.throws(() => parseNativeStudioStagingStatusResponse({...response(), jobId: OTHER}, JOB));
  assert.throws(() => parseNativeStudioStagingStatusResponse(response(), JOB, 'c'.repeat(64)));
  assert.equal(parseNativeStudioStagingStatusResponse(response(), JOB).projectId, PROJECT);
  for (const value of [{...response(), rights: true}, {...response(), projectId: PROJECT + '\n'}, {...response(), jobId: JOB + '\n'},
    ...[{imported: true}, {retry: true}, {engineVerification: 'verified'}, {phase: 'uploaded'}, {runId: 'x'},
      {plannedPacketCount: 513}, {plannedEnvelopeBytes: 8 * 1024 * 1024 + 1}, {plannedEnvelopeBytes: 1},
      {transferDigest: null}, {commands: []}, {receipt: null}, {commands: [{ordinal: 1, commandId: JOB, state: 'succeeded'}]},
      {commands: [{ordinal: 0, commandId: JOB, state: 'unknown'}]},
      {receipt: {...stage().receipt!, transferDigest: 'c'.repeat(64)}},
      {receipt: {...stage().receipt!, imported: false}}].map(patch => response({...stage(), ...patch} as Stage))]) {
    assert.equal(nativeStudioStagingStatusResponse.safeParse(value).success, false);
  }
  const maximum: Stage = {...stage(), plannedPacketCount: 512, plannedEnvelopeBytes: 8 * 1024 * 1024,
    commands: Array.from({length: 512}, (_, ordinal) => ({ordinal,
      commandId: ordinal.toString(16).padStart(8, '0') + '-1111-4111-8111-111111111111', state: 'succeeded' as const})),
    receipt: {...stage().receipt!, packetCount: 512, byteLength: 8 * 1024 * 1024}};
  assert.equal(nativeStudioStagingStatusResponse.safeParse(response(maximum)).success, true);
  assert.equal(nativeStudioStagingStatusResponse.safeParse(response({...maximum, commands: [...maximum.commands, maximum.commands[0]!]})).success, false);
});

test('status data descriptors reject getters, proxies, symbols and sparse command arrays without execution', () => {
  let accesses = 0;
  const getter = {...stage()}; Object.defineProperty(getter, 'phase', {enumerable: true, get() {accesses++; throw Error('never');}});
  const array = [...stage().commands]; Object.defineProperty(array, '0', {enumerable: true, get() {accesses++; throw Error('never');}});
  const revoked = Proxy.revocable(stage(), {}); revoked.revoke();
  for (const value of [response(getter), response({...stage(), commands: array}), response(revoked.proxy),
    {...response(), [Symbol('grant')]: true}, response({...stage(), commands: new Array(1)}),
    new Proxy(response(), {ownKeys() {accesses++; throw Error('never');}})]) {
    assert.equal(nativeStudioStagingStatusResponse.safeParse(value).success, false);
  }
  assert.equal(accesses, 0);
});

test('native status issues one scoped GET with no body and keeps authoritative CPU result', async t => {
  const f = fixture(t); assert.deepEqual(await f.daemon.assetsStudioStagingStatus(JOB), response());
  assert.equal(f.requests.length, 1); const {url, init} = f.requests[0]!;
  assert.equal(url, f.daemon.url + PATH); assert.equal(init.method, 'GET'); assert.equal(init.body, undefined);
  assert.equal(init.redirect, 'error'); assert.equal(new Headers(init.headers).get('Origin'), null);
  f.respond(() => json(response(null))); assert.deepEqual(await f.daemon.assetsStudioStagingStatus(JOB), response(null));
});

test('status tool is native-only, read-only and accepts only exact job plus bounded wait', async t => {
  const f = fixture(t), client = await linked(t, f.daemon), tool = (await client.listTools()).tools.find(v => v.name === TOOL)!;
  assert.ok(tool); assert.equal(tool.inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(tool.inputSchema.properties!).sort(), ['jobId', 'timeoutMs']);
  assert.deepEqual(tool.annotations, {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false});
  assert.ok(ARCANE_NATIVE_TOOL_NAMES.includes(TOOL)); assert.ok(!(ARCANE_TOOL_NAMES as readonly string[]).includes(TOOL));
  const result = await call(client); assert.notEqual(result.isError, true); assert.deepEqual(result.structuredContent, response());
  for (const key of ['target', 'bytes', 'projectId', 'actor', 'rightsGrantId', 'retry', 'assetAudience', 'token']) {
    assert.equal((await call(client, {jobId: JOB, [key]: 'forged'})).isError, true);
  }
  for (const timeoutMs of [0, 99, 60001, 100.5]) assert.equal((await call(client, {jobId: JOB, timeoutMs})).isError, true);
  assert.equal(f.requests.length, 1);
});

test('generic status cannot acquire native audience or submit any HTTP request', async t => {
  const f = fixture(t, 'generic'), client = await linked(t, f.daemon);
  assert.ok(!(await client.listTools()).tools.some(v => v.name === TOOL));
  await assert.rejects(f.daemon.assetsStudioStagingStatus(JOB), (e: unknown) => e instanceof BridgeError && e.code === 'ASSET_AUDIENCE');
  assert.equal((await call(client, {jobId: JOB, assetAudience: 'native-session'})).isError, true);
  assert.equal(f.requests.length, 0);
});

test('status invalid evidence, framing and transport loss fail without invented stage or retries', async t => {
  const f = fixture(t), client = await linked(t, f.daemon);
  for (const make of [() => json({...response(), jobId: OTHER}), () => json({...response(), projectId: 'wrong'}),
    () => json({...response(), authority: true}), () => json(response(), 202),
    () => json(response(), 200, {'Content-Type': 'application/json; charset=latin1'}),
    () => json(response(), 200, {'Content-Length': '01'}),
    () => json(response(), 200, {'Content-Length': String(NATIVE_STUDIO_STAGING_STATUS_RESPONSE_BYTES + 1)}),
    () => new Response(' '.repeat(NATIVE_STUDIO_STAGING_STATUS_RESPONSE_BYTES + 1), {headers: {'Content-Type': 'application/json'}}),
    () => new Response(new Uint8Array([0xff]), {headers: {'Content-Type': 'application/json'}}),
    () => json({error: 'NATIVE_ASSET_AUTHORITY', message: 'Denied ' + TOKEN}, 403),
    () => {throw Error('lost read ' + TOKEN);}]) {
    f.respond(make); const before = f.requests.length, result = await call(client);
    assert.equal(result.isError, true); assert.equal(result.structuredContent?.stage, undefined);
    assert.equal(JSON.stringify(result).includes(TOKEN), false); assert.equal(f.requests.length, before + 1);
  }
  assert.ok(f.requests.every(r => r.init.method === 'GET'));
});

test('status client timeout and caller abort cannot start, resume or replay staging', async t => {
  t.mock.timers.enable({apis: ['setTimeout']}); const f = fixture(t);
  f.respond(signal => new Promise<Response>((_resolve, reject) => signal.addEventListener('abort', () => reject(Error('wait ended')), {once: true})));
  const pending = f.daemon.assetsStudioStagingStatus(JOB, {timeoutMs: 100});
  t.mock.timers.tick(100); await assert.rejects(pending); assert.equal(f.requests.length, 1);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.daemon.assetsStudioStagingStatus(JOB, {signal: controller.signal}));
  assert.equal(f.requests.length, 1);
});
