import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {CallToolResultSchema} from '@modelcontextprotocol/sdk/types.js';
import {DaemonClient, BridgeError, type AssetAudience} from '../../apps/mcp/src/daemon-client.js';
import {createMcpServer} from '../../apps/mcp/src/server.js';
import {NATIVE_STUDIO_STAGING_RESPONSE_BYTES, nativeStudioStagingResponse, parseNativeStudioStagingResponse,
  type NativeStudioStagingResponse} from '../../packages/asset-pipeline/src/studio-staging-wire.js';
import {STUDIO_ASSET_TRANSFER_LIMITS} from '../../packages/protocol/src/studio.js';
import {STUDIO_STAGING_LIMITS} from '../../apps/daemon/src/studio-import-staging-controller.js';
import {ARCANE_TOOL_NAMES, ARCANE_NATIVE_TOOL_NAMES, missingArcaneTools} from '../../packages/protocol/src/arcane-tools.js';

// Mocked fetch and the official in-memory MCP SDK only.
// No listening socket, SQLite, app/daemon launch, Studio, provider or real bearer.
const JOB = '11111111-1111-4111-8111-111111111111';
const OTHER_JOB = '22222222-2222-4222-8222-222222222222';
const PROJECT = 'b'.repeat(64);
const TOKEN = 'synthetic-stage-unit-bearer';
const TOOL = 'assets_stage_studio_import';
const PATH = '/v1/assets/native/stage-studio-import';
const commandId = (index: number) => index.toString(16).padStart(8, '0') + '-1111-4111-8111-111111111111';
function staged(): NativeStudioStagingResponse['staged'] {
  return {status: 'staged', runId: '33333333-3333-4333-8333-333333333333', imported: false, engineVerification: 'pending', state: 'sealed',
    transferDigest: 'a'.repeat(64), packetCount: 3, byteLength: 4096,
    commandIds: [commandId(1), commandId(2), commandId(3)]};
}
function response(jobId = JOB, projectId = PROJECT): NativeStudioStagingResponse {
  return {jobId, projectId, staged: staged()};
}

test('stage runId is a required exact closed receipt field and normalization stays detached', () => {
  const input=response(), parsed=parseNativeStudioStagingResponse(input,JOB,PROJECT);
  assert.equal(parsed.staged.runId,input.staged.runId);assert.notEqual(parsed.staged,input.staged);
  const {runId,...without}=input.staged;
  for(const stagedValue of [without,{...input.staged,runId:null},{...input.staged,runId:undefined},
    {...input.staged,runId:runId+'\n'},{...input.staged,runId:'x'},
    {...input.staged,attempt:2}])assert.equal(nativeStudioStagingResponse.safeParse({...input,staged:stagedValue}).success,false);
  assert.equal(nativeStudioStagingResponse.safeParse({...input,runId}).success,false);
  let reads=0;const getter={...input.staged};Object.defineProperty(getter,'runId',{enumerable:true,get(){reads++;throw Error('never');}});
  assert.equal(nativeStudioStagingResponse.safeParse({...input,staged:getter}).success,false);assert.equal(reads,0);
  input.staged.runId=OTHER_JOB;assert.equal(parsed.staged.runId,runId);
});
function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json; charset=utf-8', ...headers}});
}
interface RequestObservation {url: string; method: string; body: unknown; headers: Headers; redirect: RequestRedirect | undefined}
type Responder = (request: RequestObservation, signal: AbortSignal) => Response | Promise<Response>;
function fixture(t: test.TestContext, audience: AssetAudience = 'native-session') {
  const requests: RequestObservation[] = [];
  let respond: Responder = () => json(response());
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    assert.ok(init);
    const signal = init.signal; assert.ok(signal);
    const request: RequestObservation = {url: String(url), method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? JSON.parse(init.body) as unknown : null,
      headers: new Headers(init.headers), redirect: init.redirect};
    requests.push(request); return respond(request, signal);
  });
  const daemon = new DaemonClient({url: 'http://127.0.0.1:12345', token: TOKEN, assetAudience: audience});
  return {daemon, requests, setResponder(value: Responder) {respond = value;}};
}
async function linked(t: test.TestContext, daemon: DaemonClient) {
  const server = createMcpServer({client: daemon, projectRoot: process.cwd()});
  const client = new Client({name: 'synthetic-staging-draft', version: '1'});
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => {await client.close(); await server.close();});
  return client;
}
async function call(client: Client, input: Record<string, unknown> = {jobId: JOB}) {
  return CallToolResultSchema.parse(await client.callTool({name: TOOL, arguments: input}));
}
function unknown(value: unknown) {
  assert.ok(value && typeof value === 'object');
  const result = value as Record<string, unknown>;
  assert.equal(result.jobId, JOB); assert.equal(result.state, 'unknown');
  assert.equal(result.retry, false); assert.equal(result.terminal, false); assert.equal(result.ambiguous, true);
  for (const key of ['staged', 'status', 'imported', 'engineVerification', 'commandIds', 'transferDigest', 'projectId']) assert.equal(result[key], undefined);
  assert.match(String(result.operationId), /^[a-f0-9-]{36}$/);
  assert.match(String(result.nextStep), /never repeat.*automatically/);
  assert.match(String(result.nextStep), /assets_jobs.*does not confirm staging/);
  assert.match(String(result.nextStep), /assets_studio_staging_status.*original jobId/);
  assert.ok(!JSON.stringify(result).includes(TOKEN));
  return result;
}

test('shared stage codec detaches the authoritative scope envelope and exact sealed CPU receipt', () => {
  const input = response(), result = parseNativeStudioStagingResponse(input, JOB, PROJECT);
  assert.deepEqual(result, input); assert.notEqual(result, input); assert.notEqual(result.staged, input.staged);
  assert.notEqual(result.staged.commandIds, input.staged.commandIds);
  assert.deepEqual(Object.keys(result).sort(), Object.keys(input).sort());
  assert.equal(result.jobId, JOB); assert.equal(result.projectId, PROJECT);
  assert.deepEqual(Object.keys(result.staged).sort(), Object.keys(input.staged).sort());
  input.staged.commandIds[0] = commandId(99); assert.equal(result.staged.commandIds[0], commandId(1));
  const boundary = {...response(), staged: {...staged(), packetCount: 512, byteLength: STUDIO_ASSET_TRANSFER_LIMITS.rawBytes,
    commandIds: Array.from({length: 512}, (_, index) => commandId(index + 1))}};
  assert.equal(nativeStudioStagingResponse.safeParse(boundary).success, true);
  assert.equal(STUDIO_STAGING_LIMITS.packets, 512); assert.equal(STUDIO_STAGING_LIMITS.envelopeBytes, STUDIO_ASSET_TRANSFER_LIMITS.envelopeBytes);
  assert.equal(NATIVE_STUDIO_STAGING_RESPONSE_BYTES, 64 * 1024);
  assert.equal(nativeStudioStagingResponse.safeParse({...boundary, staged: {...boundary.staged, packetCount: STUDIO_STAGING_LIMITS.packets + 1}}).success, false);
  assert.equal(nativeStudioStagingResponse.safeParse({...boundary, staged: {...boundary.staged, byteLength: STUDIO_ASSET_TRANSFER_LIMITS.rawBytes + 1}}).success, false);
});

test('shared parser checks exact expected job and optional trusted project without treating hashes as authority', () => {
  assert.throws(() => parseNativeStudioStagingResponse(response(OTHER_JOB), JOB), {code: 'STUDIO_STAGE_RESPONSE'});
  assert.throws(() => parseNativeStudioStagingResponse(response(JOB, 'c'.repeat(64)), JOB, PROJECT), {code: 'STUDIO_STAGE_RESPONSE'});
  assert.equal(parseNativeStudioStagingResponse(response(JOB, 'c'.repeat(64)), JOB).projectId, 'c'.repeat(64));
  for (const value of [staged(), {...response(), jobId: JOB + '\n'}, {...response(), projectId: 'B'.repeat(64)},
    {...response(), projectId: PROJECT + '\n'}, {...response(), grant: true}, {...response(), staged: undefined}]) {
    assert.throws(() => parseNativeStudioStagingResponse(value, JOB), {code: 'STUDIO_STAGE_RESPONSE'});
  }
});

test('stage codec rejects false completion, extra scope/authority and mismatched count/byte/digest/command IDs', () => {
  const invalid: Record<string, unknown>[] = [
    {...staged(), status: 'imported'}, {...staged(), imported: true}, {...staged(), state: 'receiving'},
    {...staged(), engineVerification: 'verified'}, {...staged(), jobId: JOB}, {...staged(), projectId: 'b'.repeat(64)},
    {...staged(), uploadAccepted: true}, {...staged(), target: {sessionId: 'forged'}}, {...staged(), authority: true},
    {...staged(), packetCount: 0}, {...staged(), packetCount: 4}, {...staged(), packetCount: 513},
    {...staged(), byteLength: 0}, {...staged(), byteLength: 1}, {...staged(), byteLength: STUDIO_ASSET_TRANSFER_LIMITS.rawBytes + 1},
    {...staged(), byteLength: Number.NaN}, {...staged(), byteLength: Number.POSITIVE_INFINITY},
    {...staged(), transferDigest: 'A'.repeat(64)}, {...staged(), transferDigest: 'a'.repeat(64) + '\n'},
    {...staged(), commandIds: [commandId(1), commandId(1), commandId(3)]},
    {...staged(), commandIds: [commandId(1), commandId(2)]},
    {...staged(), commandIds: ['synthetic-unverified-command', commandId(2), commandId(3)]},
    {...staged(), commandIds: [commandId(1) + '\n', commandId(2), commandId(3)]},
  ];
  for (const value of invalid) assert.equal(nativeStudioStagingResponse.safeParse({...response(), staged: value}).success, false);
  for (const key of Object.keys(staged())) {
    const incomplete = {...staged()} as Record<string, unknown>; delete incomplete[key];
    assert.equal(nativeStudioStagingResponse.safeParse({...response(), staged: incomplete}).success, false, key);
  }
});

test('stage codec refuses proxies, accessors, symbols, sparse arrays and exotic prototypes without invoking getters', () => {
  let accesses = 0;
  const getter = {...staged()};
  Object.defineProperty(getter, 'status', {enumerable: true, get() {accesses++; throw new Error('getter must not run');}});
  const array = [...staged().commandIds];
  Object.defineProperty(array, '0', {enumerable: true, get() {accesses++; throw new Error('getter must not run');}});
  const sparse = new Array<string>(3); sparse[1] = commandId(2); sparse[2] = commandId(3);
  const symbol = {...staged(), [Symbol('authority')]: true};
  const proxy = new Proxy(staged(), {get() {accesses++; throw new Error('proxy must not run');}});
  const revoked = Proxy.revocable(staged(), {}); revoked.revoke();
  for (const value of [getter, {...staged(), commandIds: array}, {...staged(), commandIds: sparse}, symbol,
    proxy, revoked.proxy, Object.assign(Object.create({authority: true}) as object, staged()), []]) {
    assert.equal(nativeStudioStagingResponse.safeParse({...response(), staged: value}).success, false);
  }
  const outerGetter = {...response()};
  Object.defineProperty(outerGetter, 'jobId', {enumerable: true, get() {accesses++; throw new Error('getter must not run');}});
  assert.equal(nativeStudioStagingResponse.safeParse(outerGetter).success, false);
  assert.equal(nativeStudioStagingResponse.safeParse({...response(), [Symbol('authority')]: true}).success, false);
  const outerProxy = Proxy.revocable(response(), {}); outerProxy.revoke();
  assert.equal(nativeStudioStagingResponse.safeParse(outerProxy.proxy).success, false);
  assert.equal(accesses, 0);
});

test('native stage client issues one exact body-only POST and preserves authoritative response scope', async t => {
  const f = fixture(t);
  const result = await f.daemon.assetsStageStudioImport(JOB, {timeoutMs: 1000});
  assert.deepEqual(result, response());
  assert.equal(f.requests.length, 1);
  const request = f.requests[0]!;
  assert.equal(request.url, f.daemon.url + PATH); assert.equal(request.method, 'POST');
  assert.deepEqual(request.body, {jobId: JOB}); assert.equal(request.redirect, 'error');
  assert.equal(request.headers.get('Authorization'), 'Bearer ' + TOKEN);
  assert.equal(request.headers.get('Origin'), null);
});

test('stage tool is native-only, reviewed only in the native catalogue and accepts exactly jobId plus bounded timeout', async t => {
  const f = fixture(t), client = await linked(t, f.daemon);
  const tools = (await client.listTools()).tools, tool = tools.find(item => item.name === TOOL)!;
  assert.ok(tool); assert.equal(tool.inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}).sort(), ['jobId', 'timeoutMs']);
  assert.equal(tool.annotations?.readOnlyHint, false); assert.equal(tool.annotations?.idempotentHint, false);
  assert.equal(tool.annotations?.destructiveHint, false); assert.equal(tool.annotations?.openWorldHint, false);
  assert.match(tool.description!, /imported false.*engineVerification pending/);
  assert.match(tool.description!, /authoritative jobId\/projectId/);
  assert.match(tool.description!, /No upload, insertion/);
  assert.ok(ARCANE_NATIVE_TOOL_NAMES.includes(TOOL));
  assert.ok(!(ARCANE_TOOL_NAMES as readonly string[]).includes(TOOL));
  assert.deepEqual(missingArcaneTools(ARCANE_TOOL_NAMES), []);
  assert.ok(missingArcaneTools(ARCANE_TOOL_NAMES, true).includes(TOOL));
  const result = await call(client, {jobId: JOB, timeoutMs: 1000});
  assert.equal(result.isError, undefined); assert.deepEqual(result.structuredContent, response());
  assert.equal(f.requests.length, 1);
});

test('generic audience cannot call or list stage and cannot select native authority through tool JSON', async t => {
  const f = fixture(t, 'generic'), client = await linked(t, f.daemon);
  assert.ok(!(await client.listTools()).tools.some(tool => tool.name === TOOL));
  await assert.rejects(f.daemon.assetsStageStudioImport(JOB), (error: unknown) => error instanceof BridgeError && error.code === 'ASSET_AUDIENCE');
  const result = await call(client, {jobId: JOB, assetAudience: 'native-session'});
  assert.equal(result.isError, true); assert.equal(f.requests.length, 0);
});

test('stage JSON cannot supply targets, bytes, project/account identities, grants or credentials before HTTP', async t => {
  const f = fixture(t), client = await linked(t, f.daemon);
  for (const field of ['target', 'packet', 'bytes', 'baseline', 'files', 'projectId', 'projectPath', 'provider',
    'threadId', 'sessionId', 'creator', 'uploaderId', 'rightsGrantId', 'assetAudience', 'audience',
    'grant', 'allowWrites', 'authority', 'token', 'operationId']) {
    assert.equal((await call(client, {jobId: JOB, [field]: 'forged'})).isError, true, field);
  }
  for (const jobId of [JOB + '\n', 'known', null, 1, {jobId: JOB}]) {
    assert.equal((await call(client, {jobId})).isError, true);
  }
  for (const timeoutMs of [0, 99, 60_001, 100.5, '100']) {
    assert.equal((await call(client, {jobId: JOB, timeoutMs})).isError, true);
  }
  await assert.rejects(f.daemon.assetsStageStudioImport(JOB + '\n'));
  await assert.rejects(f.daemon.assetsStageStudioImport(JOB, {timeoutMs: 60_001}));
  assert.equal(f.requests.length, 0);
});

test('invalid stage responses become unknown and never claim completion or replay the request', async t => {
  const f = fixture(t);
  for (const value of [staged(), response(OTHER_JOB), response(JOB, 'wrong-project'),
    {...response(), callerAuthority: true}, {...response(), staged: {...staged(), imported: true}},
    {...response(), staged: {...staged(), packetCount: 4}}, {...response(), staged: {...staged(), commandIds: []}}]) {
    f.setResponder(() => json(value));
    const before = f.requests.length;
    unknown(await f.daemon.assetsStageStudioImport(JOB));
    assert.equal(f.requests.length, before + 1);
  }
});

test('stage HTTP framing, fatal UTF-8, status and byte bounds fail unknown without retries', async t => {
  const f = fixture(t);
  const responses: (() => Response)[] = [
    () => json(response(), 202), () => json(response(), 200, {'Content-Type': 'text/plain'}),
    () => json(response(), 200, {'Content-Type': 'application/json; charset=latin1'}),
    () => json(response(), 200, {'Content-Length': '01'}),
    () => json(response(), 200, {'Content-Length': String(NATIVE_STUDIO_STAGING_RESPONSE_BYTES + 1)}),
    () => new Response(' '.repeat(NATIVE_STUDIO_STAGING_RESPONSE_BYTES + 1), {headers: {'Content-Type': 'application/json'}}),
    () => new Response(new Uint8Array([0xff]), {headers: {'Content-Type': 'application/json'}}),
    () => new Response('{', {headers: {'Content-Type': 'application/json'}}),
    () => new Response(null, {status: 204}),
  ];
  for (const make of responses) {
    f.setResponder(make);
    const before = f.requests.length;
    unknown(await f.daemon.assetsStageStudioImport(JOB));
    assert.equal(f.requests.length, before + 1);
  }
});

test('late native rejection after staging is unknown, including 403/404; no HTTP status proves no work happened', async t => {
  const f = fixture(t), client = await linked(t, f.daemon);
  let simulatedStaging = 0;
  for (const status of [400, 401, 403, 404, 409, 503]) {
    f.setResponder(() => {
      simulatedStaging++;
      return json({error: 'NATIVE_ASSET_AUTHORITY', message: 'Native staging refused ' + TOKEN}, status);
    });
    const before = f.requests.length;
    const result = await call(client);
    assert.equal(result.isError, undefined); unknown(result.structuredContent);
    assert.equal(f.requests.length, before + 1);
  }
  assert.equal(simulatedStaging, 6);
  // The human/native role is checked by the daemon registry, never inferred by
  // this client from a bearer string or a caller JSON claim.
});

test('lost stage ACK is unknown with only diagnostic operationId and no automatic POST or GET recovery', async t => {
  const f = fixture(t);
  f.setResponder(() => {throw new Error('synthetic connection loss ' + TOKEN);});
  const result = unknown(await f.daemon.assetsStageStudioImport(JOB));
  assert.equal(result.wait, 'interrupted'); assert.equal(f.requests.length, 1);
  assert.deepEqual(f.requests[0]!.body, {jobId: JOB});
});

test('deterministic client timeout is unknown and does not relax or extend the controller deadline', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const f = fixture(t);
  f.setResponder((_request, signal) => new Promise<Response>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('synthetic timed-out ACK')), {once: true});
  }));
  const pending = f.daemon.assetsStageStudioImport(JOB, {timeoutMs: 100});
  assert.equal(f.requests.length, 1);
  t.mock.timers.tick(100);
  const result = unknown(await pending);
  assert.equal(result.wait, 'timeout'); assert.equal(f.requests.length, 1);
});

test('caller abort before send submits nothing; abort after send remains unknown and cannot replay', async t => {
  const f = fixture(t), before = new AbortController(); before.abort();
  await assert.rejects(f.daemon.assetsStageStudioImport(JOB, {signal: before.signal}),
    (error: unknown) => error instanceof BridgeError && error.code === 'ABORTED');
  assert.equal(f.requests.length, 0);
  f.setResponder((_request, signal) => new Promise<Response>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('synthetic cancelled wait')), {once: true});
  }));
  const after = new AbortController(), pending = f.daemon.assetsStageStudioImport(JOB, {signal: after.signal});
  assert.equal(f.requests.length, 1); after.abort();
  const result = unknown(await pending); assert.equal(result.wait, 'aborted'); assert.equal(f.requests.length, 1);
});

test('stage-only ambiguity policy preserves existing definitive rejection handling for other operations', async t => {
  const f = fixture(t);
  f.setResponder(() => json({error: 'NATIVE_ASSET_AUTHORITY', message: 'Native request refused.'}, 403));
  await assert.rejects(f.daemon.assetsCancel(JOB), (error: unknown) => error instanceof BridgeError && error.rejected);
  unknown(await f.daemon.assetsStageStudioImport(JOB));
  assert.deepEqual(f.requests.map(request => new URL(request.url).pathname), ['/v1/assets/native/cancel', PATH]);
});

test('definite daemon preflight refusals stay unknown/no-retry but keep their redacted daemon code', async t => {
  const f = fixture(t), client = await linked(t, f.daemon);
  for (const [path, run, tool] of [
    [PATH, () => f.daemon.assetsStageStudioImport(JOB), TOOL],
    ['/v1/assets/native/reconstruct-studio-import', () => f.daemon.assetsReconstructStudioImport(JOB), 'assets_reconstruct_studio_import'],
    ['/v1/assets/native/apply-studio-revision', () => f.daemon.assetsApplyStudioRevision(JOB), 'assets_apply_studio_revision'],
  ] as const) {
    for (const code of ['STUDIO_IMPORT_TARGET', 'STUDIO_IMPORT_AMBIGUOUS', 'STUDIO_IMPORT_CONTINUITY', 'STUDIO_STAGE_CAPABILITY', 'STUDIO_RECONSTRUCT_STATE']) {
      f.setResponder(request => {
        assert.ok(request.url.endsWith(path));
        return json({error: code, message: 'Native chat asset request refused or unavailable. ' + TOKEN}, 503);
      });
      const direct = await run() as Record<string, unknown>;
      assert.equal(direct.jobId, JOB); assert.equal(direct.state, 'unknown'); assert.equal(direct.retry, false); assert.equal(direct.ambiguous, true);
      assert.deepEqual(direct.error, {code, message: 'Native chat asset request refused or unavailable. [redacted]'});
      const result = CallToolResultSchema.parse(await client.callTool({name: tool, arguments: {jobId: JOB}}));
      const content = result.structuredContent as Record<string, unknown>;
      assert.equal(content.state, 'unknown'); assert.equal((content.error as {code: string}).code, code);
      assert.equal(JSON.stringify(result).includes(TOKEN), false);
    }
  }
  // A lost acknowledgement reports only the local connection failure and stays unknown.
  f.setResponder(() => { throw new TypeError('socket reset'); });
  const lost = unknown(await f.daemon.assetsStageStudioImport(JOB));
  assert.equal((lost.error as {code: string}).code, 'DAEMON_UNREACHABLE');
});


// A full-resolution transfer can exceed the generic 30-second wait.
// Fake fetch and official in-memory MCP; no engine or real 40-second sleep.
for(const viaMcp of [false,true])test('full-resolution staging keeps a 40-second response within its bounded default '+(viaMcp?'MCP':'client')+' wait',async t=>{
  const f=fixture(t),client=viaMcp?await linked(t,f.daemon):null;
  t.mock.timers.enable({apis:['setTimeout']});
  let entered!:()=>void;const sent=new Promise<void>(resolve=>{entered=resolve;});
  f.setResponder((_request,signal)=>new Promise<Response>((resolve,reject)=>{
    const timer=setTimeout(()=>resolve(json(response())),40_000);
    signal.addEventListener('abort',()=>{clearTimeout(timer);reject(new Error('synthetic bounded wait'));},{once:true});entered();
  }));
  const pending=client?call(client):f.daemon.assetsStageStudioImport(JOB);await sent;
  t.mock.timers.tick(40_000);const result=await pending;
  assert.deepEqual(client?(result as {structuredContent:unknown}).structuredContent:result,response());
  assert.equal(f.requests.length,1);assert.deepEqual(f.requests[0]!.body,{jobId:JOB});
});

test('default staging wait ends at 55 seconds as unknown with no retry',async t=>{
  const f=fixture(t);t.mock.timers.enable({apis:['setTimeout']});
  f.setResponder((_request,signal)=>new Promise<Response>((_resolve,reject)=>{signal.addEventListener('abort',()=>reject(new Error('synthetic bounded stage wait')),{once:true});}));
  let settled=false;const pending=f.daemon.assetsStageStudioImport(JOB).then(value=>{settled=true;return value;});
  assert.equal(f.requests.length,1);t.mock.timers.tick(54_999);for(let i=0;i<12;i++)await Promise.resolve();assert.equal(settled,false);
  t.mock.timers.tick(1);const value=unknown(await pending);assert.equal(value.wait,'timeout');assert.equal(f.requests.length,1);
  assert.equal(STUDIO_STAGING_LIMITS.totalDeadlineMs,120_000);
});
