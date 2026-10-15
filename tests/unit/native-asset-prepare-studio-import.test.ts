import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, realpath, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createAssetService, type AssetService } from '../../apps/daemon/src/asset-service.js';
import { createAssetConversationHost, type NativeAssetConversationHost } from '../../apps/daemon/src/asset-conversation-host.js';
import { createNativeAssetRegistry, assertNativeAssetActor, type NativeAssetActor } from '../../apps/daemon/src/native-asset-authority.js';
import { nativeAssetRoutes, parseNativeStudioImportResponse, NATIVE_STUDIO_IMPORT_RESPONSE_BYTES } from '../../apps/daemon/src/native-asset-routes.js';
import {ArcaneError} from '../../packages/protocol/src/providers.js';
import type {createStudioImportStagingController} from '../../apps/daemon/src/studio-import-staging-controller.js';
import { DaemonClient, type AssetAudience } from '../../apps/mcp/src/daemon-client.js';
import { createMcpServer } from '../../apps/mcp/src/server.js';
import { ConversationWorkStore } from '../../packages/storage/src/conversation-work-store.js';
import { saveStudioFixture } from '../../packages/asset-pipeline/testing/studio-import-fixture.js';
import type { PreparedStudioImport, StudioImportSelection, StudioImportBaseline } from '../../packages/asset-pipeline/src/studio-import-manifest.js';

// Real route, native authority, SQLite bindings and AssetService with synthetic
// completed bytes. MCP uses the official in-memory SDK. No engine/worker/provider.
const JOB = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const PATH = '/v1/assets/native/prepare-studio-import';
const TOOL = 'assets_prepare_studio_import';
const CONVERSATION = { provider: 'codex' as const, threadId: 'prepare-original', sessionId: 'prepare-session' };
const SELECTION: StudioImportSelection = { target: { sessionId: 'synthetic-studio', placeId: 0, universeId: 0,
  root: 'Workspace', parentRef: 'synthetic-parent', creator: { kind: 'user', id: '1234' } },
  placement: { mode: 'bottom-centre' }, studsPerMeter: 1 / 0.28 };
function gate() { let release!: () => void; const promise = new Promise<void>(accept => { release = accept; }); return { promise, release }; }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}';
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
function rehash(prepared: PreparedStudioImport): PreparedStudioImport {
  const { digest: _old, ...content } = prepared.manifest, digest = hash(content);
  const manifest = { ...content, digest }, delta = { ...prepared.delta, nextDigest: digest };
  return { status: 'prepared', manifest, delta, digest: hash({ manifestDigest: digest, delta }) };
}
const refused = (code: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === code;
type Mutable<T> = T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
type Transition = 'revoke-regrant' | 'new-intent' | 'replacement' | 'close';

async function fixture(t: test.TestContext, configured = true) {
  const boundary = await realpath(tmpdir()), directory = await mkdtemp(join(boundary, 'arcane-native-prepare-test-'));
  const projectPath = await realpath(directory), outputRoot = join(projectPath, 'outputs'); await mkdir(outputRoot);
  const jobDirectory = join(outputRoot, 'test-kit-' + JOB); await mkdir(jobDirectory); await saveStudioFixture(jobDirectory, JOB);
  const nextDirectory = join(outputRoot, 'test-kit-' + OTHER); await mkdir(nextDirectory); await saveStudioFixture(nextDirectory, OTHER, { wide: true });
  const store = new ConversationWorkStore({ directory: join(projectPath, 'state'), projectPath });
  store.bind({ kind: 'asset-job', id: JOB, conversation: CONVERSATION });
  store.bind({ kind: 'asset-job', id: OTHER, conversation: CONVERSATION });
  const registry = createNativeAssetRegistry({ projectPath }), incarnation = registry.issue();
  const binding = { connectionId: 'prepare-connection', threadId: CONVERSATION.threadId }, operationId = 'prepare-intent';
  const credential = incarnation.credential();
  incarnation.seal({ ...binding, ...CONVERSATION }); incarnation.grant(binding); incarnation.dispatched({ ...binding, operationId });
  let selections = 0, preparations = 0, lastActor: NativeAssetActor | undefined, baseline: StudioImportBaseline | null = null;
  const service = await createAssetService({ cwd: projectPath, projectPath, outputRoot,
    ...(configured ? { studioImport: { workAssociations: store, selectTarget: async () => { selections++; return SELECTION; }, loadObservedBaseline: async () => baseline } } : {}) });
  let prepare: AssetService['prepareStudioImport'] = service.prepareStudioImport.bind(service);
  const routed: AssetService = { ...service, async prepareStudioImport(id, actor) {
    preparations++; lastActor = actor; assertNativeAssetActor(actor, 'mutate'); return prepare(id, actor);
  } };
  const host = createAssetConversationHost({ projectPath, workAssociations: store,
    conversation: () => { throw new Error('Provider inference is forbidden'); },
    start: () => { throw new Error('Asset generation is forbidden'); } });
  let lookup = host.bindingNative.bind(host);
  const routeHost: NativeAssetConversationHost = { ...host, bindingNative: (actor, id) => lookup(actor, id) };
  let stage: ReturnType<typeof createStudioImportStagingController>['stage'] | null = null;
  let status: ReturnType<typeof createStudioImportStagingController>['status'] | null = null;
  let staged = 0;
  const route = nativeAssetRoutes(routed, routeHost, registry, {stage: (...args) => {
    if (!stage) throw new ArcaneError('STUDIO_STAGE_UNAVAILABLE', 'Synthetic staging controller is not configured.');
    staged++; return stage(...args);
  }, status: (...args) => {
    if (!status) throw new ArcaneError('STUDIO_STAGE_UNAVAILABLE', 'Synthetic staging status is not configured.');
    return status(...args);
  }});
  let origin = '', requests = 0; const failures: unknown[] = [], releases: (() => void)[] = [];
  const server = createServer((request, response) => { requests++; void route(request, response, new URL(request.url ?? '/', origin), origin)
    .then(handled => { if (!handled) { response.writeHead(404); response.end('{}'); } })
    .catch(error => { failures.push(error); if (!response.destroyed && !response.headersSent) { response.writeHead(500); response.end('{}'); } }); });
  await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  const address = server.address(); assert.ok(address && typeof address !== 'string'); origin = 'http://127.0.0.1:' + address.port;
  t.after(async () => {
    releases.forEach(release => release()); registry.close(); server.closeAllConnections();
    await new Promise<void>(accept => server.close(() => accept())); await service.close(); store.close();
    const part = relative(boundary, directory); assert.ok(part.startsWith('arcane-native-prepare-test-') && !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep));
    assert.equal((await lstat(directory)).isSymbolicLink(), false); await rm(directory, { recursive: true, force: true });
    assert.deepEqual(failures, [], 'Route listener assertions must surface');
  });
  const http = (value: unknown = { jobId: JOB }, options: { hold?: boolean; headers?: Record<string, string>; method?: string; path?: string; bytes?: Buffer } = {}) => {
    const bytes = options.bytes ?? Buffer.from(JSON.stringify(value)), entered = gate(), marker = randomUUID();
    const observe = (request: import('node:http').IncomingMessage) => {
      if (request.headers['x-prepare-fixture'] !== marker) return;
      assert.ok(request.listenerCount('data') > 0); assert.equal(request.complete, false);
      request.once('data', entered.release);
    };
    if (options.hold) server.on('request', observe);
    const outgoing = httpRequest(origin + (options.path ?? PATH), { method: options.method ?? 'POST', headers: {
      Host: new URL(origin).host, Authorization: 'Bearer ' + credential, 'Content-Type': 'application/json',
      'Content-Length': String(bytes.length), 'X-Prepare-Fixture': marker, ...options.headers } });
    const result = new Promise<{ status: number; data: Record<string, unknown>; text: string; headers: import('node:http').IncomingHttpHeaders }>((accept, reject) => {
      outgoing.once('error', reject); outgoing.once('response', response => {
        const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(Buffer.from(chunk))); response.once('error', reject);
        response.once('end', () => { try {
          const text = Buffer.concat(chunks).toString(); assert.equal(text.includes(credential), false);
          accept({ status: response.statusCode!, data: JSON.parse(text) as Record<string, unknown>, text, headers: response.headers });
        } catch (error) { reject(error); } });
      });
    });
    void result.catch(() => {}); outgoing.setTimeout(4000, () => outgoing.destroy(new Error('HTTP fixture deadline')));
    t.after(() => { server.off('request', observe); outgoing.destroy(); });
    if (options.hold) outgoing.write(bytes.subarray(0, 1)); else outgoing.end(bytes);
    return { result, captured: async () => { await entered.promise; server.off('request', observe); }, finish: () => outgoing.end(bytes.subarray(1)) };
  };
  return { origin, credential, service, host, store, registry, incarnation, http,
    setStage(fn: NonNullable<typeof stage>) {stage = fn;}, stageCalls: () => staged,
    setStatus(fn: NonNullable<typeof status>) {status = fn;}, endMutationWindow() {incarnation.ended(operationId);},
    setPrepare(fn: typeof prepare) { prepare = fn; }, setLookup(fn: typeof lookup) { lookup = fn; },
    setBaseline(value: StudioImportBaseline) { baseline = value; },
    counts: () => ({ preparations, selections, requests }), actor: () => lastActor,
    holdPreparation() {
      const entered = gate(), release = gate(), original = prepare; releases.push(release.release);
      prepare = async (id, actor) => { const result = await original(id, actor); entered.release(); await release.promise; return result; };
      return { entered: entered.promise, release: release.release };
    },
    transition(which: Transition) {
      if (which === 'close') { registry.close(); return; }
      if (which === 'replacement') {
        incarnation.retire(); const replacement = registry.issue(), foreign = { connectionId: 'replacement-connection', threadId: 'replacement-thread' };
        replacement.seal({ ...foreign, provider: 'codex', sessionId: 'replacement-session' }); replacement.grant(foreign);
        replacement.dispatched({ ...foreign, operationId: 'replacement-intent' }); return;
      }
      if (which === 'revoke-regrant') { incarnation.revokeGrant(); incarnation.grant(binding); }
      else incarnation.ended(operationId);
      incarnation.dispatched({ ...binding, operationId: 'next-intent' });
    },
  };
}
async function linked(t: test.TestContext, url: string, token: string, audience: AssetAudience = 'native-session') {
  const daemon = new DaemonClient({ url, token, assetAudience: audience }), server = createMcpServer({ client: daemon, projectRoot: process.cwd() });
  const client = new Client({ name: 'prepare-fixture', version: '1' }), [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); }); return { daemon, client };
}
const call = async (client: Client, input: Record<string, unknown> = { jobId: JOB }) => CallToolResultSchema.parse(await client.callTool({ name: TOOL, arguments: input }));

test('native prepare route returns verified synthetic preparation; MCP preserves the full plan and pending verification', async t => {
  const f = await fixture(t), reply = await f.http().result;
  assert.equal(reply.status, 200); assert.equal(reply.headers['cache-control'], 'no-store'); assert.equal(reply.headers['x-content-type-options'], 'nosniff');
  const plan = parseNativeStudioImportResponse(reply.data, JOB).prepared;
  assert.equal(plan.status, 'prepared'); assert.equal(plan.manifest.engineVerification, 'pending'); assert.equal(plan.manifest.objects.length, 8);
  assert.equal(plan.delta.preservation, 'preserve-all-scripts-attachments-constraints'); assert.ok(Buffer.byteLength(reply.text) <= NATIVE_STUDIO_IMPORT_RESPONSE_BYTES);
  const sdk = await linked(t, f.origin, f.credential), result = await call(sdk.client);
  assert.notEqual(result.isError, true); assert.deepEqual(result.structuredContent, reply.data);
  assert.deepEqual(JSON.parse((result.content[0] as { text: string }).text), reply.data);
  assert.deepEqual(f.counts(), { preparations: 2, selections: 2, requests: 2 });
  assert.equal(f.service.jobs().length, 2); assert.equal(f.service.jobs()[0]!.state, 'succeeded');
});

test('native staging ingress accepts only an owned job and the same mutating capture', async t => {
  const f = await fixture(t), path = '/v1/assets/native/stage-studio-import';
  f.setStage(async (id, actor) => {
    assert.equal(id, JOB); assertNativeAssetActor(actor, 'mutate');
    return {status: 'staged', runId: '55555555-5555-4555-8555-555555555555', imported: false, transferDigest: 'a'.repeat(64), packetCount: 1, byteLength: 4,
      state: 'sealed', engineVerification: 'pending', commandIds: ['44444444-4444-4444-8444-444444444444']};
  });
  const response = await f.http({jobId: JOB}, {path}).result;
  assert.equal(response.status, 200);
  assert.equal(response.data.jobId, JOB); assert.equal(response.data.projectId, f.store.projectId);
  assert.deepEqual(Object.keys(response.data).sort(), ['jobId', 'projectId', 'staged']);
  const receipt=response.data.staged as Record<string,unknown>;
  assert.equal(receipt.imported, false); assert.equal(receipt.engineVerification, 'pending');
  for (const input of [{jobId: JOB, target: SELECTION.target}, {jobId: JOB, packet: '{}'}, {jobId: JOB, permission: true}]) {
    const refused = await f.http(input, {path}).result; assert.equal(refused.status, 400);
  }
  const missing = await f.http({jobId: '33333333-3333-4333-8333-333333333333'}, {path}).result;
  assert.equal(missing.status, 404); assert.equal(f.stageCalls(), 1);
});

test('native staging ingress rejects a revoked capture after awaiting its controller result', async t => {
  const f = await fixture(t), path = '/v1/assets/native/stage-studio-import';
  f.setStage(async () => {
    f.transition('revoke-regrant');
    return {status: 'staged', runId: '55555555-5555-4555-8555-555555555555', imported: false, transferDigest: 'a'.repeat(64), packetCount: 1, byteLength: 4,
      state: 'sealed', engineVerification: 'pending', commandIds: ['44444444-4444-4444-8444-444444444444']};
  });
  const response = await f.http({jobId: JOB}, {path}).result;
  assert.equal(response.status, 403); assert.equal(response.data.error, 'NATIVE_ASSET_AUTHORITY'); assert.equal(response.data.state, undefined);
});

test('native staging MCP reaches the scoped route once and returns only pending CPU evidence', async t => {
  const f = await fixture(t), sdk = await linked(t, f.origin, f.credential);
  const staged = {status: 'staged' as const, runId: '55555555-5555-4555-8555-555555555555', imported: false as const, transferDigest: 'a'.repeat(64),
    packetCount: 1, byteLength: 4, state: 'sealed' as const, engineVerification: 'pending' as const,
    commandIds: ['44444444-4444-4444-8444-444444444444']};
  f.setStage(async (id, actor) => {
    assert.equal(id, JOB); assertNativeAssetActor(actor, 'mutate'); return staged;
  });
  const result = CallToolResultSchema.parse(await sdk.client.callTool({name: 'assets_stage_studio_import', arguments: {jobId: JOB}}));
  assert.notEqual(result.isError, true);
  assert.deepEqual(result.structuredContent, {jobId: JOB, projectId: f.store.projectId, staged});
  assert.deepEqual(JSON.parse((result.content[0] as {text: string}).text), result.structuredContent);
  assert.deepEqual(f.counts(), {preparations: 0, selections: 0, requests: 1});
  assert.equal(f.stageCalls(), 1);
  const invalid = CallToolResultSchema.parse(await sdk.client.callTool({name: 'assets_stage_studio_import',
    arguments: {jobId: JOB, permission: true}}));
  assert.equal(invalid.isError, true); assert.equal(f.stageCalls(), 1); assert.equal(f.counts().requests, 1);
});

test('native staging MCP treats a real late scope rejection as unknown without replaying', async t => {
  const f = await fixture(t), sdk = await linked(t, f.origin, f.credential);
  f.setStage(async () => {
    f.transition('revoke-regrant');
    return {status: 'staged', runId: '55555555-5555-4555-8555-555555555555', imported: false, transferDigest: 'a'.repeat(64), packetCount: 1, byteLength: 4,
      state: 'sealed', engineVerification: 'pending', commandIds: ['44444444-4444-4444-8444-444444444444']};
  });
  const result = CallToolResultSchema.parse(await sdk.client.callTool({name: 'assets_stage_studio_import', arguments: {jobId: JOB}}));
  const outcome = result.structuredContent as Record<string, unknown>;
  assert.equal(outcome.jobId, JOB); assert.equal(outcome.state, 'unknown');
  assert.equal(outcome.terminal, false); assert.equal(outcome.ambiguous, true); assert.equal(outcome.retry, false);
  assert.equal(outcome.staged, undefined); assert.equal(outcome.imported, undefined);
  assert.equal(f.stageCalls(), 1); assert.equal(f.counts().requests, 1);
});

test('native staging status MCP can read its owned scope after the mutation window ends without staging again', async t => {
  const f = await fixture(t), sdk = await linked(t, f.origin, f.credential);
  f.endMutationWindow();
  f.setStatus(async (id, actor) => {
    assert.equal(id, JOB); assertNativeAssetActor(actor, 'read');
    assert.throws(() => assertNativeAssetActor(actor, 'mutate'), {code: 'NATIVE_ASSET_AUTHORITY'});
    return {jobId: JOB, projectId: f.store.projectId, stage: null};
  });
  const result = CallToolResultSchema.parse(await sdk.client.callTool({name: 'assets_studio_staging_status', arguments: {jobId: JOB}}));
  assert.notEqual(result.isError, true);
  assert.deepEqual(result.structuredContent, {jobId: JOB, projectId: f.store.projectId, stage: null});
  assert.equal(f.stageCalls(), 0); assert.deepEqual(f.counts(), {preparations: 0, selections: 0, requests: 1});
  const path = '/v1/assets/native/studio-staging-status?jobId=' + JOB;
  assert.equal((await f.http(undefined, {method: 'GET', path: path + '&projectId=forged'}).result).status, 400);
  assert.equal((await f.http(undefined, {method: 'GET', path: path + '&jobId=' + JOB}).result).status, 400);
  assert.equal((await f.http(undefined, {method: 'GET', path: '/v1/assets/native/studio-staging-status?jobId=' + '33333333-3333-4333-8333-333333333333'}).result).status, 404);
});

test('native staging status route fences its original read actor across an awaited lookup', async t => {
  const f = await fixture(t);
  f.setStatus(async () => {f.transition('revoke-regrant'); return {jobId: JOB, projectId: f.store.projectId, stage: null};});
  const response = await f.http(undefined, {method: 'GET', path: '/v1/assets/native/studio-staging-status?jobId=' + JOB}).result;
  assert.equal(response.status, 403); assert.equal(response.data.stage, undefined); assert.equal(f.stageCalls(), 0);
});

test('native staging refuses a changed owned binding or malformed controller evidence without claiming completion', async t => {
  for (const mode of ['binding', 'receipt'] as const) {
    const f = await fixture(t), path = '/v1/assets/native/stage-studio-import';
    f.setStage(async () => {
      if (mode === 'binding') f.setLookup((actor, id) => {
        const original = f.host.bindingNative(actor, id); return original ? {...original, id: OTHER} : null;
      });
      return {status: 'staged', runId: '55555555-5555-4555-8555-555555555555', imported: false, transferDigest: 'a'.repeat(64), packetCount: 1, byteLength: 4,
        state: 'sealed', engineVerification: 'pending', commandIds: [mode === 'receipt' ? 'invalid-command' : '44444444-4444-4444-8444-444444444444']};
    });
    const response = await f.http({jobId: JOB}, {path}).result;
    assert.equal(response.status, mode === 'binding' ? 404 : 503);
    assert.equal(response.data.staged, undefined); assert.equal(response.data.projectId, undefined);
    assert.equal(f.stageCalls(), 1, 'A refusal after execution never replays staging.');
  }
});

for (const phase of ['body', 'preparation'] as const) for (const transition of ['revoke-regrant', 'new-intent', 'replacement', 'close'] as const)
  test('native prepare fences the same capture across ' + phase + ' and ' + transition, { timeout: 8000 }, async t => {
    const f = await fixture(t), hold = phase === 'preparation' ? f.holdPreparation() : undefined;
    const request = f.http(undefined, { hold: phase === 'body' });
    if (hold) await hold.entered; else await request.captured();
    f.transition(transition); if (hold) hold.release(); else request.finish();
    const reply = await request.result; assert.equal(reply.status, 403); assert.equal(reply.data.error, 'NATIVE_ASSET_AUTHORITY');
    assert.equal(reply.data.prepared, undefined); assert.equal(reply.text.includes('synthetic-parent'), false);
    assert.equal(f.counts().preparations, phase === 'body' ? 0 : 1);
    if (phase === 'preparation') assert.throws(() => assertNativeAssetActor(f.actor()!, 'mutate'), refused('NATIVE_ASSET_AUTHORITY'));
  });

test('native prepare rejects a changed exact binding after its awaited service result', async t => {
  const f = await fixture(t), hold = f.holdPreparation(), request = f.http(); await hold.entered;
  f.setLookup((actor, id) => { const original = f.host.bindingNative(actor, id); return original ? { ...original, id: OTHER } : null; });
  hold.release(); const reply = await request.result; assert.equal(reply.status, 404); assert.equal(reply.data.prepared, undefined);
});

test('native prepare ingress requires native mutation authority and exact body-only job identity', async t => {
  const f = await fixture(t);
  const rejectedHeaders: Record<string, string>[] = [{ Authorization: 'Bearer ' + 'a'.repeat(64) }, { Authorization: 'Bearer human-bearer' },
    { Origin: f.origin }, { 'Sec-Fetch-Site': 'same-origin' }, { Host: 'localhost:' + new URL(f.origin).port }];
  for (const headers of rejectedHeaders)
    assert.equal((await f.http(undefined, { headers }).result).status, 403);
  for (const value of [null, [], {}, { jobId: JOB + '\n' }, { jobId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' }, { jobId: '../job' }, { jobId: 1 },
    ...['target', 'baseline', 'files', 'credential', 'actor', 'projectId', 'threadId', 'sessionId', 'provider', 'grant'].map(key => ({ jobId: JOB, [key]: 'forged' }))])
    assert.equal((await f.http(value).result).status, 400, JSON.stringify(value));
  assert.equal((await f.http(undefined, { path: PATH + '?jobId=' + JOB }).result).status, 400);
  const method = await f.http(undefined, { method: 'GET' }).result; assert.equal(method.status, 405); assert.equal(method.headers.allow, 'POST');
  assert.equal((await f.http(undefined, { bytes: Buffer.from('{}' + ' '.repeat(16383)) }).result).status, 413);
  assert.equal((await f.http(undefined, { bytes: Buffer.from([0x7b, 0xff, 0x7d]) }).result).data.error, 'JSON');
  assert.equal((await f.http(undefined, { headers: { 'Content-Encoding': 'gzip' } }).result).data.error, 'CONTENT_TYPE');
  assert.equal((await f.http({ jobId: '33333333-3333-4333-8333-333333333333' }).result).status, 404);
  assert.equal(f.counts().preparations, 0);
  f.incarnation.revokeGrant(); assert.equal((await f.http().result).status, 403); assert.equal(f.counts().preparations, 0);
});

test('native prepare fails unavailable without product target hooks; MCP establishes no plan or acceptance', async t => {
  const f = await fixture(t, false), reply = await f.http().result;
  assert.equal(reply.status, 503); assert.equal(reply.data.error, 'STUDIO_IMPORT_UNAVAILABLE'); assert.equal(reply.data.prepared, undefined);
  const sdk = await linked(t, f.origin, f.credential), result = await call(sdk.client);
  assert.equal(result.isError, true); assert.equal((result.structuredContent?.error as { code: string }).code, 'STUDIO_IMPORT_UNAVAILABLE');
  assert.equal(f.counts().selections, 0); assert.equal(f.counts().requests, 2);
});

test('native preparation serialization refuses accessors, proxies, non-JSON data, byte excess and unsupported claims without disclosure', async t => {
  const f = await fixture(t), original = parseNativeStudioImportResponse((await f.http().result).data, JOB).prepared;
  let invoked = 0;
  const getter = { ...original }; Object.defineProperty(getter, 'digest', { enumerable: true, get() { invoked++; throw new Error(f.credential); } });
  const proxy = new Proxy(original, { ownKeys() { invoked++; throw new Error('Proxy executed'); } });
  for (const value of [getter, proxy, { ...original, toJSON() { invoked++; return original; } }, { ...original, credential: f.credential },
    { ...original, manifest: { ...original.manifest, engineVerification: 'accepted' } },
    { ...original, manifest: { ...original.manifest, revisionId: OTHER } },
    { ...original, manifest: { ...original.manifest, projectId: 'f'.repeat(64) } },
    { ...original, manifest: { ...original.manifest, limitations: ['🌿'.repeat(NATIVE_STUDIO_IMPORT_RESPONSE_BYTES / 4)] } }]) {
    f.setPrepare(async () => value as PreparedStudioImport); const reply = await f.http().result;
    assert.equal(reply.status, 503); assert.equal(reply.data.error, 'STUDIO_IMPORT_RESPONSE'); assert.equal(reply.data.prepared, undefined);
  }
  assert.equal(invoked, 0);
  const cycle: Record<string, unknown> = { ...original }; cycle.delta = cycle;
  assert.throws(() => parseNativeStudioImportResponse({ prepared: cycle }, JOB), refused('STUDIO_IMPORT_RESPONSE'));
  assert.throws(() => parseNativeStudioImportResponse({ prepared: { ...original, digest: undefined } }, JOB), refused('STUDIO_IMPORT_RESPONSE'));
});

test('native wire gate verifies revision preservation and rejects recomputed contradictory plans', async t => {
  const f = await fixture(t), original = parseNativeStudioImportResponse((await f.http().result).data, JOB).prepared;
  const mutableOriginal = structuredClone(original) as Mutable<PreparedStudioImport>;
  const baseline: StudioImportBaseline = { manifest: mutableOriginal.manifest, receipt: {
    manifestDigest: original.manifest.digest, receiptSha256: 'b'.repeat(64), modelRef: 'synthetic-model', modelAssetId: '7001',
    objects: original.manifest.objects.map((o, i) => ({ sourceObjectId: o.sourceObjectId, instanceRef: 'object-' + i,
      meshAssetId: '7002', ownedStateSha256: 'c'.repeat(64), authoredChildren: [{ instanceRef: 'script-' + i, kind: 'script', stateSha256: 'd'.repeat(64) }] })) } };
  f.setBaseline(baseline);
  const previousActor = f.registry.capture(f.credential, 'mutate');
  const next = await f.service.prepareStudioImport(OTHER, previousActor);
  assert.equal(parseNativeStudioImportResponse({ prepared: next }, OTHER).prepared.manifest.revisionId, OTHER);
  assert.equal(next.delta.previousDigest, original.manifest.digest); assert.equal(next.delta.modelRef, 'synthetic-model');
  assert.ok(next.delta.objects.every(o => o.preserveChildren.length === 1)); assert.ok(next.delta.objects.some(o => o.action === 'update-in-place'));
  const mutations: ((p: Mutable<PreparedStudioImport>) => void)[] = [
    p => { p.delta.objects[0]!.action = 'reuse'; },
    p => { Object.assign(p.delta.objects[0]!, { deleteInstance: true }); },
    p => { p.manifest.objects.push(p.manifest.objects[0]!); },
    p => { p.delta.geometry.prepare = []; },
    p => { Object.assign(p.manifest.target, { credential: 'forged' }); },
    p => { p.manifest.objects[0]!.triangles = 20001; },
    p => { Object.assign(p.manifest.files[0]!, { bytes: [1, 2] }); },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(original) as Mutable<PreparedStudioImport>; mutate(changed);
    assert.throws(() => parseNativeStudioImportResponse({ prepared: rehash(changed) }, JOB), refused('STUDIO_IMPORT_RESPONSE'));
  }
});

test('native-only MCP catalogue and schemas refuse authority/target fields before HTTP; generic has no prepare tool', async t => {
  const f = await fixture(t), native = await linked(t, f.origin, f.credential), generic = await linked(t, f.origin, f.credential, 'generic');
  const tools = (await native.client.listTools()).tools, tool = tools.find(value => value.name === TOOL)!; assert.ok(tool);
  assert.equal(tool.inputSchema.additionalProperties, false); assert.deepEqual(Object.keys(tool.inputSchema.properties!).sort(), ['jobId', 'timeoutMs']);
  assert.equal(tool.annotations?.readOnlyHint, false); assert.equal(tool.annotations?.destructiveHint, false); assert.equal(tool.annotations?.idempotentHint, false);
  assert.match(tool.description!, /engineVerification pending/); assert.match(tool.description!, /Unconfigured target hooks fail unavailable/);
  assert.match(tool.description!, /no Studio execution.*acceptance is established/);
  assert.equal((await generic.client.listTools()).tools.some(value => value.name === TOOL), false);
  assert.equal((await call(generic.client)).isError, true);
  await assert.rejects(generic.daemon.assetsPrepareStudioImport(JOB), refused('ASSET_AUDIENCE'));
  for (const input of [{}, { jobId: JOB + '\n' }, { jobId: 'forged' }, { jobId: { id: JOB } },
    ...['target', 'baseline', 'files', 'credential', 'actor', 'grant', 'assetAudience', 'provider', 'threadId', 'sessionId'].map(key => ({ jobId: JOB, [key]: 'forged' }))])
    assert.equal((await call(native.client, input)).isError, true);
  await assert.rejects(native.daemon.assetsPrepareStudioImport(JOB + '\n'));
  const abort = new AbortController(); abort.abort(); await assert.rejects(native.daemon.assetsPrepareStudioImport(JOB, { signal: abort.signal }));
  assert.equal(f.counts().requests, 0);
});

test('native MCP rejects malformed/foreign/overbound wire responses with one POST and no fallback or retry', async t => {
  const f = await fixture(t), valid = (await f.http().result).data;
  let respond: (response: ServerResponse) => void = response => response.end();
  const requests: { method: string; path: string; body: unknown; origin: unknown }[] = [];
  const errors: unknown[] = [];
  const server = createServer((request, response) => { void (async () => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({ method: request.method!, path: request.url!, body: JSON.parse(Buffer.concat(chunks).toString()), origin: request.headers.origin }); respond(response);
  })().catch(error => { errors.push(error); response.destroy(); }); });
  await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept)); const address = server.address(); assert.ok(address && typeof address !== 'string');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(accept => server.close(() => accept())); assert.deepEqual(errors, []); });
  const sdk = await linked(t, 'http://127.0.0.1:' + address.port, f.credential);
  const send = (response: ServerResponse, payload: unknown, status = 200, contentType = 'application/json') => {
    response.writeHead(status, { 'Content-Type': contentType }); response.end(JSON.stringify(payload));
  };
  for (const handler of [
    (r: ServerResponse) => send(r, { ...valid, credential: f.credential }),
    (r: ServerResponse) => send(r, { prepared: { ...(valid.prepared as PreparedStudioImport), digest: 'a'.repeat(64) } }),
    (r: ServerResponse) => send(r, { prepared: { ...(valid.prepared as PreparedStudioImport), manifest: { ...(valid.prepared as PreparedStudioImport).manifest, revisionId: OTHER } } }),
    (r: ServerResponse) => send(r, valid, 202),
    (r: ServerResponse) => send(r, valid, 200, 'application/json-invalid'),
    (r: ServerResponse) => { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(Buffer.from([0x7b, 0xff, 0x7d])); },
    (r: ServerResponse) => { r.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(NATIVE_STUDIO_IMPORT_RESPONSE_BYTES + 1) }); r.end('{}'); },
    (r: ServerResponse) => { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(' '.repeat(NATIVE_STUDIO_IMPORT_RESPONSE_BYTES + 1)); },
    (r: ServerResponse) => { r.writeHead(302, { Location: '/v1/assets/prepare-studio-import' }); r.end(); },
    (r: ServerResponse) => send(r, { error: 'NATIVE_ASSET_AUTHORITY', message: 'Denied ' + f.credential }, 403),
    (r: ServerResponse) => r.destroy(),
    (_r: ServerResponse) => {},
  ]) {
    respond = handler; const before = requests.length, result = await call(sdk.client, { jobId: JOB, timeoutMs: 150 });
    assert.equal(result.isError, true); assert.equal(result.structuredContent?.prepared, undefined); assert.equal(JSON.stringify(result).includes(f.credential), false);
    assert.equal(requests.length, before + 1);
  }
  assert.ok(requests.every(r => r.method === 'POST' && r.path === PATH && r.origin === undefined));
  assert.ok(requests.every(r => JSON.stringify(r.body) === JSON.stringify({ jobId: JOB })));
});
