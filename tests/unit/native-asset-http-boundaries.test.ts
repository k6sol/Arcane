import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, lstatSync, rmSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingMessage } from 'node:http';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createNativeAssetRegistry, nativeAssetActorScope } from '../../apps/daemon/src/native-asset-authority.js';
import { nativeAssetRoutes } from '../../apps/daemon/src/native-asset-routes.js';
import { createAssetConversationHost } from '../../apps/daemon/src/asset-conversation-host.js';
import type { AssetService, AssetJobRecord } from '../../apps/daemon/src/asset-service.js';
import { ConversationWorkStore } from '../../packages/storage/src/conversation-work-store.js';
import { normalizeRequest } from '../../packages/asset-pipeline/src/validation.js';
import { CUSTOM_REQUEST_BYTES } from '../../packages/asset-pipeline/src/recipe.js';
import type { AssetManifest } from '../../packages/asset-pipeline/src/types.js';

// Dedicated native routes + real registry/SQLite. AssetService and the listener
// are explicit fixtures. No provider, installed runtime or engine is involved.
const PREFIX = '/v1/assets/native/';
const INPUT = { template: 'hero-prop' as const, name: 'http-boundary-fixture' };
const ORIGINAL = { provider: 'codex' as const, threadId: 'Boundary.original-chat', sessionId: 'Boundary.original-session' };
const FOREIGN = { provider: 'codex' as const, threadId: 'Boundary.replacement-chat', sessionId: 'Boundary.replacement-session' };
const MARKER = 'PRIVATE-FAKE-RUNTIME-COMPLETION';
function gate() {
  let release!: () => void; const promise = new Promise<void>(accept => { release = accept; });
  return { promise, release };
}
type Reply = { status: number; data: Record<string, unknown> };
type Transition = 'revoke-regrant' | 'terminal-new-intent' | 'retire-replacement' | 'registry-close';

async function fixture(t: test.TestContext) {
  const boundary = realpathSync(tmpdir()), root = mkdtempSync(join(boundary, 'arcane-native-http-boundaries-'));
  const project = join(root, 'project'); mkdirSync(project); const projectPath = realpathSync(project);
  const store = new ConversationWorkStore({ directory: join(root, 'bindings'), projectPath });
  const registry = createNativeAssetRegistry({ projectPath }), handle = registry.issue();
  const connectionId = randomUUID(), operationId = randomUUID(); let credential = handle.credential();
  handle.seal({ connectionId, ...ORIGINAL }); handle.grant({ connectionId, threadId: ORIGINAL.threadId });
  handle.dispatched({ connectionId, threadId: ORIGINAL.threadId, operationId });
  const jobId = randomUUID(), request = normalizeRequest(INPUT), now = new Date().toISOString();
  const seeded: AssetJobRecord = { schemaVersion: 1, jobId, directory: join(root, 'fake-assets', jobId), manifestPath: null,
    request, state: 'running', stage: 'Explicit fake AssetService', startedAt: now, updatedAt: now,
    events: [], manifestAvailable: false, error: null };
  const jobs = [seeded]; store.bind({ kind: 'asset-job', id: jobId, conversation: ORIGINAL });
  let starts = 0, allocations = 0, cancels = 0, manifestReads = 0, probeReads = 0, routeRequests = 0;
  const readEntered = gate(), readRelease = gate();
  const fakeAssetService: AssetService = {
    projectPath, outputRoot: join(root, 'fake-assets'), jobs: () => structuredClone(jobs),
    jobPage() { return { schemaVersion: 1, jobs: structuredClone(jobs), total: jobs.length, nextCursor: null, byteLimit: 512 * 1024 }; },
    async start(input, admission) {
      starts++; assert.ok(admission); const normalized = normalizeRequest(input); admission.beforeCreate(); allocations++;
      const job = { ...structuredClone(seeded), jobId: randomUUID(), request: normalized };
      jobs.push(job); admission.created(job.jobId); return structuredClone(job);
    },
    async cancel(id) { cancels++; const job = jobs.find(value => value.jobId === id); assert.ok(job); job.state = 'cancelled'; return structuredClone(job); },
    async manifest(id) {
      assert.equal(id, jobId); manifestReads++; readEntered.release(); await readRelease.promise;
      // Minimal disclosure sentinel, deliberately not a generated/validated manifest.
      return { jobId, fixtureMarker: MARKER } as unknown as AssetManifest;
    },
    async probe() {
      probeReads++; readEntered.release(); await readRelease.promise;
      return { observedAt: now, available: false, blender: null, python: null, attempts: [], fixtureMarker: MARKER };
    },
    async prepareStudioImport() { throw new Error('No generated import preparation evidence in the native HTTP fixture.'); },
    async preview() { throw new Error('No fixture previews'); }, async artifact() { throw new Error('No fixture artifacts'); }, async close() {},
  };
  const host = createAssetConversationHost({ projectPath, workAssociations: store,
    conversation: () => { throw new Error('Native scope must never consult a live provider'); },
    start: () => { throw new Error('No generic start in dedicated native fixture'); },
    startNative: async (input, admission) => (await fakeAssetService.start(input, admission)).jobId });
  const route = nativeAssetRoutes(fakeAssetService, host, registry); let origin = '';
  const failures: unknown[] = [];
  const server = createServer((incoming, response) => {
    routeRequests++;
    void (async () => {
      if (await route(incoming, response, new URL(incoming.url ?? '/', origin), origin)) return;
      response.writeHead(404); response.end(JSON.stringify({ error: 'FIXTURE_NOT_FOUND' }));
    })().catch(error => { failures.push(error); if (!response.destroyed && !response.headersSent) { response.writeHead(500); response.end('{}'); } });
  });
  await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  const address = server.address(); assert.ok(address && typeof address !== 'string'); origin = 'http://127.0.0.1:' + address.port;
  t.after(async () => {
    registry.close(); readRelease.release(); server.closeAllConnections();
    await new Promise<void>(accept => server.close(() => accept())); store.close();
    const part = relative(boundary, resolve(root));
    assert.ok(part && !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep));
    assert.equal(lstatSync(root).isSymbolicLink(), false); rmSync(root, { recursive: true, force: true });
    assert.deepEqual(failures, [], 'Dedicated listener failures must not be hidden');
  });
  const http = (path: string, body?: Buffer, headers: Record<string, string> = {}, hold = false) => {
    const marker = randomUUID(), entered = gate();
    const observe = (incoming: IncomingMessage) => {
      if (incoming.headers['x-boundary-fixture'] !== marker) return;
      // nativeAssetRoutes captured the real actor before readAssetJson subscribed.
      assert.equal(incoming.complete, false); assert.ok(incoming.listenerCount('data') > 0);
      incoming.once('data', () => entered.release());
    };
    if (hold) server.on('request', observe);
    const outgoing = httpRequest(origin + path, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + credential,
      ...(body ? { 'Content-Type': 'application/json', 'Content-Length': String(body.length) } : {}), 'X-Boundary-Fixture': marker, ...headers } });
    const result = new Promise<Reply>((accept, reject) => {
      outgoing.once('error', reject); outgoing.once('response', response => {
        const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(Buffer.from(chunk))); response.once('error', reject);
        response.once('end', () => {
          const text = Buffer.concat(chunks).toString();
          try { assert.equal(text.includes(credential), false); accept({ status: response.statusCode!, data: JSON.parse(text) as Record<string, unknown> }); }
          catch (error) { reject(error); }
        });
      });
    });
    void result.catch(() => {}); outgoing.setTimeout(4000, () => outgoing.destroy(new Error('Fixture HTTP deadline')));
    t.after(() => { server.off('request', observe); outgoing.destroy(); });
    if (hold) outgoing.write(body!.subarray(0, 1)); else outgoing.end(body);
    return { result, async captured() { await entered.promise; server.off('request', observe); }, finish: () => outgoing.end(body!.subarray(1)) };
  };
  const raw = (target: string, headers: [string, string][]) => new Promise<{ status: number; wire: string }>((accept, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: address.port }); const chunks: Buffer[] = [];
    socket.setTimeout(4000, () => socket.destroy(new Error('Raw HTTP fixture deadline'))); socket.once('error', reject);
    socket.on('data', chunk => chunks.push(chunk)); t.after(() => socket.destroy());
    socket.once('connect', () => socket.write('GET ' + target + ' HTTP/1.1\r\n' +
      [['Host', new URL(origin).host], ['Authorization', 'Bearer ' + credential], ['Connection', 'close'], ...headers]
        .map(([name, value]) => name + ': ' + value).join('\r\n') + '\r\n\r\n' + (headers.some(([name]) => name.toLowerCase() === 'transfer-encoding') ? '0\r\n\r\n' : '')));
    socket.once('close', () => {
      const wire = Buffer.concat(chunks).toString();
      try { assert.equal(wire.includes(credential), false); const match = /^HTTP\/1\.1 (\d{3})/.exec(wire); assert.ok(match); accept({ status: Number(match[1]), wire }); }
      catch (error) { reject(error); }
    });
  });
  return { store, jobId, origin, http, raw, readEntered: readEntered.promise, releaseRead: readRelease.release,
    get starts() { return starts; }, get allocations() { return allocations; }, get cancels() { return cancels; },
    get manifestReads() { return manifestReads; }, get probeReads() { return probeReads; }, get routeRequests() { return routeRequests; },
    transition(which: Transition) {
      if (which === 'registry-close') { registry.close(); return; }
      if (which === 'retire-replacement') {
        handle.retire(); const replacement = registry.issue(), replacementId = randomUUID(); credential = replacement.credential();
        replacement.seal({ connectionId: replacementId, ...FOREIGN }); replacement.grant({ connectionId: replacementId, threadId: FOREIGN.threadId });
        replacement.dispatched({ connectionId: replacementId, threadId: FOREIGN.threadId, operationId: randomUUID() }); return;
      }
      if (which === 'revoke-regrant') { handle.revokeGrant(); handle.grant({ connectionId, threadId: ORIGINAL.threadId }); }
      else handle.ended(operationId);
      handle.dispatched({ connectionId, threadId: ORIGINAL.threadId, operationId: randomUUID() });
    },
    freshScope: () => nativeAssetActorScope(registry.capture(credential, 'mutate')).conversation,
    assertUntouched() {
      assert.equal(starts, 0); assert.equal(allocations, 0); assert.equal(cancels, 0); assert.equal(jobs.length, 1);
      assert.equal(jobs[0]!.state, 'running'); assert.deepEqual(store.list(ORIGINAL, 'asset-job').items.map(value => value.id), [jobId]);
      assert.deepEqual(store.list(FOREIGN, 'asset-job').items, []);
      assert.deepEqual(store.binding('asset-job', jobId)?.conversation, ORIGINAL);
    },
  };
}

for (const operation of ['start', 'cancel'] as const) for (const transition of ['revoke-regrant', 'terminal-new-intent', 'retire-replacement', 'registry-close'] as const)
  test('native HTTP held ' + operation + ' cannot upgrade across ' + transition, { timeout: 8000 }, async t => {
    const f = await fixture(t), body = Buffer.from(JSON.stringify(operation === 'start' ? INPUT : { jobId: f.jobId }));
    const pending = f.http(PREFIX + operation, body, {}, true); await pending.captured(); f.assertUntouched();
    f.transition(transition);
    if (transition !== 'registry-close') assert.deepEqual(f.freshScope(), transition === 'retire-replacement' ? FOREIGN : ORIGINAL);
    pending.finish(); const denied = await pending.result;
    assert.equal(denied.status, 403); assert.equal(denied.data.error, 'NATIVE_ASSET_AUTHORITY'); f.assertUntouched();
  });

for (const operation of ['manifest', 'probe'] as const)
  test('native HTTP ' + operation + ' completion cannot disclose after retirement/replacement', { timeout: 8000 }, async t => {
    const f = await fixture(t), path = PREFIX + operation + (operation === 'manifest' ? '?jobId=' + f.jobId : '');
    const pending = f.http(path, operation === 'probe' ? Buffer.from('{}') : undefined).result;
    await f.readEntered; f.transition('retire-replacement'); assert.deepEqual(f.freshScope(), FOREIGN); f.releaseRead();
    const denied = await pending; assert.equal(denied.status, 403); assert.equal(denied.data.error, 'NATIVE_ASSET_AUTHORITY');
    assert.equal(JSON.stringify(denied.data).includes(MARKER), false); assert.equal(denied.data[operation], undefined);
    assert.equal(f.manifestReads, operation === 'manifest' ? 1 : 0); assert.equal(f.probeReads, operation === 'probe' ? 1 : 0); f.assertUntouched();
  });

test('native HTTP ingress refuses wrong Host, any Origin, fetch metadata and noncanonical targets', { timeout: 8000 }, async t => {
  const f = await fixture(t);
  for (const [headers, error] of [
    [{ Host: 'localhost:' + new URL(f.origin).port }, 'HOST'], [{ Origin: f.origin }, 'ORIGIN'],
    [{ Origin: 'https://forged.example' }, 'ORIGIN'], [{ 'Sec-Fetch-Site': 'same-origin' }, 'ORIGIN'],
  ] as const) { const reply = await f.http(PREFIX + 'jobs', undefined, headers).result; assert.equal(reply.status, 403); assert.equal(reply.data.error, error); }
  for (const target of [PREFIX + './jobs', PREFIX + 'jobs/../jobs', PREFIX + '%2e/jobs', PREFIX + 'jobs#forged', f.origin + PREFIX + 'jobs']) {
    const reply = await f.raw(target, []); assert.equal(reply.status, 400, target); assert.ok(reply.wire.includes('"error":"INPUT"'));
  }
  for (const path of [PREFIX + 'jobs?limit=1&limit=2', PREFIX + 'jobs?threadId=forged']) assert.equal((await f.http(path).result).status, 400);
  f.assertUntouched(); assert.equal(f.manifestReads, 0); assert.equal(f.probeReads, 0);
});

test('native HTTP rejects duplicate sensitive raw headers at route or Node framing boundary', { timeout: 8000 }, async t => {
  const f = await fixture(t);
  for (const [name, values] of [
    ['Host', [new URL(f.origin).host]], ['Authorization', ['Bearer forged']],
    ['Origin', [f.origin, f.origin]], ['Content-Type', ['application/json', 'application/json']],
  ] as const) {
    const reply = await f.raw(PREFIX + 'jobs', values.map(value => [name, value]));
    assert.equal(reply.status, 403, name); assert.ok(reply.wire.includes('"error":"AUTH"'), name);
  }
  for (const name of ['Content-Length', 'Transfer-Encoding']) {
    const value = name === 'Content-Length' ? '0' : 'chunked', before = f.routeRequests;
    const reply = await f.raw(PREFIX + 'jobs', [[name, value], [name, value]]);
    assert.equal(reply.status, 400, name); assert.equal(f.routeRequests, before, 'Node must reject duplicate framing before the listener');
  }
  f.assertUntouched(); assert.equal(f.manifestReads, 0); assert.equal(f.probeReads, 0);
});

test('native HTTP preserves shared JSON byte limits, content checks and custom-recipe allowance', { timeout: 8000 }, async t => {
  const f = await fixture(t), padded = (value: unknown, bytes: number) => {
    const text = JSON.stringify(value); return Buffer.from(text + ' '.repeat(bytes - Buffer.byteLength(text)));
  };
  assert.equal((await f.http(PREFIX + 'start', padded(INPUT, 16384)).result).status, 200);
  assert.equal(f.allocations, 1);
  for (const [path, body] of [[PREFIX + 'start', padded(INPUT, 16385)], [PREFIX + 'cancel', padded({ jobId: f.jobId }, 16385)]] as const) {
    const rejected = await f.http(path, body).result; assert.equal(rejected.status, 413); assert.equal(rejected.data.error, 'BODY_LIMIT');
  }
  const tooLarge = await f.http(PREFIX + 'start', Buffer.from('{}'), { 'Content-Length': String(CUSTOM_REQUEST_BYTES + 1) }).result;
  assert.equal(tooLarge.status, 413); assert.equal(tooLarge.data.error, 'BODY_LIMIT');
  const custom = await f.http(PREFIX + 'start', padded({ template: 'custom-assembly', name: 'invalid-recipe-fixture' }, 16385)).result;
  assert.equal(custom.status, 400); assert.equal(custom.data.error, 'INPUT', 'Larger custom JSON reaches recipe validation, without allocating');
  const compressed = await f.http(PREFIX + 'cancel', Buffer.from('{}'), { 'Content-Encoding': 'gzip' }).result;
  assert.equal(compressed.status, 400); assert.equal(compressed.data.error, 'CONTENT_TYPE');
  const invalidUtf8 = await f.http(PREFIX + 'cancel', Buffer.from([0x7b, 0xff, 0x7d])).result;
  assert.equal(invalidUtf8.status, 400); assert.equal(invalidUtf8.data.error, 'JSON');
  assert.equal((await f.http(PREFIX + 'cancel', padded({ jobId: f.jobId }, 16384)).result).status, 200);
  assert.equal(f.starts, 1); assert.equal(f.allocations, 1); assert.equal(f.cancels, 1);
});
