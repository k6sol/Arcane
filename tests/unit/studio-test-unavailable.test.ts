import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createConnectionLab } from '../../apps/daemon/src/lab-server.js';
import type { CodexService } from '../../apps/daemon/src/codex-service.js';
import type { StudioTestService } from '../../apps/daemon/src/studio-test-service.js';
import { STUDIO_TEST_HTTP_LIMITS } from '../../apps/daemon/src/studio-test-routes.js';
import { BridgeError, DaemonClient } from '../../apps/mcp/src/daemon-client.js';
import { StudioStore } from '../../packages/storage/src/studio-store.js';
import { WorkStore } from '../../packages/storage/src/work-store.js';
import { ConversationWorkStore } from '../../packages/storage/src/conversation-work-store.js';
import { openStudioTestReportStore } from '../../apps/daemon/src/studio-test-report-store.js';
import { workflowProjectIdentity } from '../../packages/storage/src/workflow-store.js';
import { TestLedger, digest } from '../../packages/studio-test-controller/src/index.js';
import { STUDIO_PLUGIN_SOURCES } from '../../packages/protocol/src/studio-plugin-artifact.js';
import { studioImportPluginArtifactHash } from '../../apps/daemon/src/studio-import-plugin-artifact.js';
import { fixtureTempDirectory, makeFixtureDirectory } from './windows-fixture-paths.js';

// Offline host-wiring fixtures only: copies of the actual bundled modular plugin
// and retained journal bytes in an owned temporary tree, real loopback HTTP/SQLite, no native engine,
// SDK connection, provider, installed plugin, or fabricated completed playtest.
const PRIVATE = 'private-unavailable-fixture-diagnostic';
const APPROVAL = { id: 'fixture-job', displayDigest: 'a'.repeat(64) };
type Source = 'verified' | 'missing-manifest' | 'missing-source' | 'malformed-manifest' | 'wrong-hash' |
  'missing-module' | 'tampered-module' | 'wrong-identity' | 'duplicate-artifact' | 'legacy-only';
type Lab = Awaited<ReturnType<typeof createConnectionLab>>;
type Reply = { status: number; text: string; json: Record<string, unknown>; headers: IncomingHttpHeaders };

function persistentFiles(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), stat = lstatSync(path);
      assert.equal(stat.isSymbolicLink(), false, 'The fixture cannot follow filesystem links.');
      if (stat.isDirectory()) walk(path);
      else {
        const key = relative(root, path);
        // The fixture's read-only observer itself updates this volatile WAL
        // reader index. Keep its presence/size check, and hash all durable DB/WAL
        // bytes plus the independent row counts instead of claiming SHM is inert.
        result[key] = key === join('studio-fixture', 'studio.sqlite-shm')
          ? `volatile SQLite reader index: ${stat.size} bytes`
          : createHash('sha256').update(readFileSync(path)).digest('hex');
      }
    }
  };
  walk(root); return result;
}

function fixture(t: TestContext, source: Source = 'verified', options: { outsideWorkspace?: boolean } = {}) {
  const root = makeFixtureDirectory('arcane-studio-test-unavailable-');
  const cwd = join(root, 'synthetic-resources'), storeDirectory = join(root, 'studio-fixture');
  const stateDirectory = options.outsideWorkspace ? join(root, 'lab') : join(storeDirectory, 'connection-lab');
  const artifacts = join(cwd, 'plugin', 'build'), ledgerDirectory = join(stateDirectory, 'playtests', 'ledger');
  mkdirSync(artifacts, { recursive: true }); mkdirSync(stateDirectory, { recursive: true });
  const sources = join(cwd, 'plugin', 'src'); mkdirSync(sources);
  const bundled = resolve('plugin');
  copyFileSync(join(bundled, 'build', 'ArcaneLocalBridge.rbxmx'), join(artifacts, 'ArcaneLocalBridge.rbxmx'));
  for (const [, , filename] of STUDIO_PLUGIN_SOURCES) copyFileSync(join(bundled, 'src', filename), join(sources, filename));
  const manifest = JSON.parse(readFileSync(join(bundled, 'build', 'manifest.json'), 'utf8')) as {
    preferredArtifact: string; runtimeIdentity: { sha256: string }; artifacts: { name: string; sha256: string }[];
  };
  if (source === 'wrong-hash') manifest.artifacts.find(artifact => artifact.name === 'ArcaneLocalBridge.rbxmx')!.sha256 = 'b'.repeat(64);
  if (source === 'wrong-identity') manifest.runtimeIdentity.sha256 = 'b'.repeat(64);
  if (source === 'duplicate-artifact') manifest.artifacts.push({ ...manifest.artifacts.find(artifact => artifact.name === 'ArcaneLocalBridge.rbxmx')! });
  if (source === 'legacy-only') {
    manifest.preferredArtifact = 'ArcaneLocalBridge.lua';
    manifest.artifacts = [{ name: 'ArcaneLocalBridge.lua', sha256: createHash('sha256').update(PRIVATE).digest('hex') }];
    writeFileSync(join(artifacts, 'ArcaneLocalBridge.lua'), PRIVATE);
    rmSync(join(artifacts, 'ArcaneLocalBridge.rbxmx'));
  }
  if (source !== 'missing-manifest') writeFileSync(join(artifacts, 'manifest.json'), source === 'malformed-manifest' ? PRIVATE : JSON.stringify(manifest));
  if (source === 'missing-source') rmSync(join(artifacts, 'ArcaneLocalBridge.rbxmx'));
  if (source === 'missing-module') rmSync(join(sources, 'AssetUpload.luau'));
  if (source === 'tampered-module') writeFileSync(join(sources, 'AssetUpload.luau'), '--!strict\n-- Changed child module fixture.\nreturn {}\n');
  const store = new StudioStore({ directory: storeDirectory });
  const grant = store.createGrant({ allowedRoots: ['Workspace', 'ServerStorage'], allowWrites: true });
  const pair = store.pair({ code: grant.code, protocolVersion: 1,
    identity: { clientSessionId: 'unavailable-fixture-lifetime', placeId: 0, universeId: 0,
      name: 'Offline unavailable fixture', pluginVersion: 'fixture-only' }, capabilities: ['scene.children'] });
  const effects = { sdkConnect: 0, sdkStart: 0, sdkTool: 0, providerActions: 0, providerCloses: 0, probes: 0 };
  t.mock.method(Client.prototype, 'connect', async () => { effects.sdkConnect++; throw new Error('SDK connections forbidden in this fixture.'); });
  t.mock.method(Client.prototype, 'callTool', async () => { effects.sdkTool++; throw new Error('SDK calls forbidden in this fixture.'); });
  t.mock.method(StdioClientTransport.prototype, 'start', async () => { effects.sdkStart++; throw new Error('SDK process launches forbidden in this fixture.'); });
  const codex: CodexService = {
    state: () => ({ provider: 'codex', use: 'personal-local', projectPath: cwd, connecting: false, closing: false,
      busy: false, snapshot: null, lastSnapshot: null, actions: [], nativeTools: { configured: false, verified: false } }),
    async action() { effects.providerActions++; throw new Error('Provider actions forbidden in this fixture.'); },
    async close() { effects.providerCloses++; },
  };
  const labs: Lab[] = [], workStores: WorkStore[] = [];
  const start = async (overrides: Partial<Parameters<typeof createConnectionLab>[0]> = {}) => {
    const lab = await createConnectionLab({ cwd, stateDirectory, studioStore: store, codexService: codex,
      probe: async () => { effects.probes++; return []; }, ...overrides });
    labs.push(lab); return lab;
  };
  const counts = () => {
    const db = new DatabaseSync(join(storeDirectory, 'studio.sqlite'), { readOnly: true, allowExtension: false });
    try { return ['events', 'commands', 'sessions'].map(table => db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n); }
    finally { db.close(); }
  };
  const noExecution = () => {
    assert.deepEqual({ ...effects, providerCloses: 0 },
      { sdkConnect: 0, sdkStart: 0, sdkTool: 0, providerActions: 0, providerCloses: 0, probes: 0 });
  };
  t.after(async () => {
    try { for (const lab of labs) await lab.close(); }
    finally {
      for (const work of workStores) work.close();
      store.close();
      const target = resolve(root), boundary = relative(fixtureTempDirectory(), target);
      assert.ok(boundary.startsWith('arcane-studio-test-unavailable-') && !isAbsolute(boundary) &&
        boundary !== '..' && !boundary.startsWith('..' + sep) && !lstatSync(target).isSymbolicLink());
      rmSync(target, { recursive: true, force: true });
    }
  });
  return { root, cwd, stateDirectory, artifacts, ledgerDirectory, store, pair, effects, codex, labs, workStores, start, counts, noExecution,
    runtimeHash: manifest.runtimeIdentity.sha256 };
}

function call(lab: Lab, options: {
  path?: string; token?: string | null; method?: string; body?: string | Buffer; headers?: Record<string, string | string[]>;
} = {}): Promise<Reply> {
  const method = options.method ?? (options.body === undefined ? 'GET' : 'POST');
  const token = options.token === undefined ? lab.agentToken : options.token;
  return new Promise((resolveReply, reject) => {
    const request = httpRequest(lab.origin + (options.path ?? '/v1/playtests'), { method, agent: false, headers: {
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}), ...options.headers,
    } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.once('error', reject);
      response.once('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolveReply({ status: response.statusCode!, headers: response.headers, text, json: JSON.parse(text) as Record<string, unknown> });
      });
    });
    request.once('error', reject); request.end(options.body);
  });
}
const post = (lab: Lab, endpoint: string, value: unknown, token = lab.agentToken, headers: Record<string, string> = {}) =>
  call(lab, { path: '/v1/playtests/' + endpoint, body: JSON.stringify(value), token, headers });

function refusal(reply: Reply, code: 'UNAVAILABLE' | 'FENCED' | 'SDK_CUSTODY_UNCONFIRMED', lab: Lab, root: string) {
  assert.equal(reply.status, code === 'UNAVAILABLE' ? 503 : 409);
  assert.equal(reply.json.error, code);
  assert.deepEqual(Object.keys(reply.json).sort(), ['error', 'message'], 'A refusal cannot impersonate a job or completion.');
  if (code === 'SDK_CUSTODY_UNCONFIRMED') assert.equal(reply.json.message, 'Studio native operations are paused because Arcane could not confirm that an owned SDK connection closed. Saved playtest reports remain available. Edit-mode record repair cannot settle this connection. Do not retry native work or delete the retained records.');
  else assert.match(String(reply.json.message), code === 'FENCED' ? /stop any running playtest.*Repair playtest records/i : /repair.*plugin.*restart/i);
  assert.equal(reply.headers['cache-control'], 'no-store');
  assert.equal(reply.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(reply.headers['x-content-type-options'], 'nosniff');
  assert.equal(reply.headers.connection, 'close');
  assert.equal(Number(reply.headers['content-length']), Buffer.byteLength(reply.text));
  assert.ok(Buffer.byteLength(reply.text) <= STUDIO_TEST_HTTP_LIMITS.responseBytes);
  for (const secret of [lab.token, lab.agentToken, PRIVATE, root]) assert.equal(reply.text.includes(secret), false);
}

async function mountedRefusals(f: ReturnType<typeof fixture>, lab: Lab, code: 'UNAVAILABLE' | 'FENCED') {
  const beforeFiles = persistentFiles(f.root), beforeCounts = f.counts();
  for (const token of [lab.token, lab.agentToken]) {
    for (const path of ['/v1/playtests', '/v1/playtests?id=fixture-job']) refusal(await call(lab, { path, token }), code, lab, f.root);
    refusal(await post(lab, 'prepare', { sessionId: f.pair.sessionId }, token), code, lab, f.root);
    refusal(await post(lab, 'cancel', { id: 'fixture-job' }, token), code, lab, f.root);
  }
  refusal(await post(lab, 'approve', APPROVAL, lab.token, { Origin: lab.origin }), code, lab, f.root);
  const mcp = new DaemonClient({ url: lab.origin, token: lab.agentToken });
  const guidance = code === 'FENCED' ? /Repair playtest records/ : /restart/i;
  await assert.rejects(mcp.playtestStatus(undefined), error => error instanceof BridgeError && error.code === code && guidance.test(error.message));
  // Viewport capture shares the service: it names the same reason instead of a generic "unavailable".
  refusal(await post(lab, 'viewport', { sessionId: f.pair.sessionId }), code, lab, f.root);
  assert.equal((await call(lab, { path: '/v1/studio/sessions' })).status, 200);
  assert.equal((await call(lab, { path: '/v1/codex/state', token: lab.token })).status, 200);
  const state = await call(lab, { path: '/v1/state', token: lab.token });
  assert.equal(state.status, 200); assert.equal(state.json.inferenceRuns, 0);
  assert.ok((state.json.warnings as string[]).some(message => guidance.test(message)));
  assert.deepEqual(f.counts(), beforeCounts, 'Refused HTTP/MCP requests cannot write Studio commands or events.');
  assert.deepEqual(persistentFiles(f.root), beforeFiles, 'Refused requests cannot rewrite artifacts, locks, journals, or durable SQLite/WAL bytes.');
  f.noExecution();
}

test('actual bundled modular plugin initializes the production playtest service without launching native tools', async t => {
  const f = fixture(t), layout = projectLayout(f);
  assert.equal(existsSync(join(f.artifacts, 'ArcaneLocalBridge.lua')), false, 'No legacy single-script artifact may mask the modular path.');
  const xmlHash = createHash('sha256').update(readFileSync(join(f.artifacts, 'ArcaneLocalBridge.rbxmx'))).digest('hex');
  assert.notEqual(f.runtimeHash, xmlHash, 'The loaded-source identity is distinct from the delivery checksum.');
  assert.equal(await studioImportPluginArtifactHash(f.cwd), f.runtimeHash);
  const lab = await f.start({ stateDirectory: layout.stateDirectory });
  for (const token of [lab.token, lab.agentToken]) {
    const listed = await call(lab, { token }); assert.equal(listed.status, 200); assert.deepEqual(listed.json, { jobs: [] });
  }
  const state = await call(lab, { path: '/v1/state', token: lab.token });
  assert.equal(state.status, 200); assert.deepEqual(state.json.warnings, []);
  assert.equal(existsSync(join(layout.ledgerDirectory, 'writer.lock')), true, 'The real owned service opened its ledger.');
  f.noExecution(); await lab.close();
  assert.equal(existsSync(join(layout.ledgerDirectory, 'writer.lock')), false, 'Shutdown releases only the owned idle ledger.');
  f.noExecution();
});

test('offline modular resource fixtures mount actionable UNAVAILABLE on every playtest operation', async t => {
  for (const source of ['missing-manifest', 'missing-source', 'malformed-manifest', 'wrong-hash',
    'missing-module', 'tampered-module', 'wrong-identity', 'duplicate-artifact', 'legacy-only'] as const) await t.test(source, async sub => {
    const f = fixture(sub, source), lab = await f.start();
    assert.equal(existsSync(join(f.stateDirectory, 'playtests')), false, 'Untrusted source cannot initialize a journal.');
    await mountedRefusals(f, lab, 'UNAVAILABLE');
    await lab.close(); assert.equal(f.effects.providerCloses, 1);
  });
});

test('offline retained-journal fixtures mount FENCED and preserve recovery state across close', async t => {
  for (const kind of ['writer-lock', 'corrupt-record', 'unresolved-record', 'blocked-directory'] as const) await t.test(kind, async sub => {
    const f = fixture(sub);
    if (kind === 'blocked-directory') writeFileSync(join(f.stateDirectory, 'playtests'), PRIVATE);
    else {
      mkdirSync(f.ledgerDirectory, { recursive: true });
      if (kind === 'writer-lock') writeFileSync(join(f.ledgerDirectory, 'writer.lock'), PRIVATE);
      else {
        const event = { kind: 'admit', id: 'fixture-unresolved-run', at: 1, scopeDigest: 'a'.repeat(64), evidence: 'fixture', code: 'OK' };
        const record = { seq: 1, previous: 'genesis', event };
        writeFileSync(join(f.ledgerDirectory, '00001.json'), kind === 'corrupt-record' ? PRIVATE : JSON.stringify({ ...record, hash: digest(record) }));
      }
    }
    const lab = await f.start(); await mountedRefusals(f, lab, 'FENCED');
    const retained = persistentFiles(f.root);
    await lab.close(); assert.deepEqual(persistentFiles(f.root), retained, 'Shutdown must retain an unknown journal/fence.');
    if (kind !== 'blocked-directory') assert.equal(existsSync(join(f.ledgerDirectory, 'writer.lock')), true);
    const restarted = await f.start(); refusal(await call(restarted), 'FENCED', restarted, f.root);
    assert.deepEqual(persistentFiles(f.root), retained, 'Restart cannot reset or replace retained test state.');
    f.noExecution();
  });
});

test('offline unavailable mount retains trusted actors, HUMAN_ONLY approval, ingress and byte bounds', async t => {
  const f = fixture(t, 'missing-manifest'), lab = await f.start(), before = persistentFiles(f.root), beforeCounts = f.counts();
  const check = async (reply: Promise<Reply>, status: number, error: string) => {
    const found = await reply; assert.equal(found.status, status); assert.equal(found.json.error, error);
    assert.equal(found.text.includes('trusted plugin'), false, 'Ingress refusals must not be replaced by recovery guidance.');
  };
  for (const token of [null, 'untrusted-fixture-bearer', f.pair.token]) await check(call(lab, { token }), 401, 'AUTH');
  await check(post(lab, 'approve', APPROVAL, lab.agentToken, { Origin: lab.origin }), 403, 'HUMAN_AUTH_REQUIRED');
  await check(post(lab, 'approve', { ...APPROVAL, role: 'human', consent: true }, lab.agentToken, { Origin: lab.origin }), 403, 'HUMAN_AUTH_REQUIRED');
  await check(post(lab, 'approve', APPROVAL, lab.token), 403, 'ORIGIN');
  await check(post(lab, 'approve', APPROVAL, lab.token, { Origin: 'https://foreign.example' }), 403, 'ORIGIN');
  await check(post(lab, 'prepare', { sessionId: f.pair.sessionId }, lab.agentToken, { 'Sec-Fetch-Site': 'same-origin' }), 403, 'ORIGIN');
  await check(call(lab, { headers: { Origin: 'https://foreign.example' } }), 403, 'ORIGIN');
  await check(call(lab, { headers: { Host: 'localhost:' + new URL(lab.origin).port } }), 403, 'HOST');
  await check(call(lab, { headers: { Authorization: ['Bearer ' + lab.token, 'Bearer ' + lab.agentToken] } }), 401, 'AUTH');
  await check(call(lab, { method: 'DELETE' }), 405, 'METHOD');
  await check(call(lab, { path: '/v1/playtests?id=a&id=b' }), 400, 'QUERY');
  await check(call(lab, { path: '/v1/playtests?id=invalid%0A' }), 400, 'INVALID_REQUEST');
  await check(post(lab, 'prepare', { sessionId: f.pair.sessionId, actor: 'human', approved: true }), 400, 'INVALID_REQUEST');
  await check(post(lab, 'prepare', { sessionId: f.pair.sessionId, durationMs: 4_999 }), 400, 'INVALID_REQUEST');
  await check(post(lab, 'prepare', { sessionId: f.pair.sessionId, observationIntervalMs: 2_001 }), 400, 'INVALID_REQUEST');
  await check(post(lab, 'approve', { ...APPROVAL, consent: true }, lab.token, { Origin: lab.origin }), 400, 'INVALID_REQUEST');
  await check(call(lab, { path: '/v1/playtests/prepare', body: '{"sessionId":"a","sessionId":"b"}' }), 400, 'BODY');
  await check(call(lab, { path: '/v1/playtests/prepare', body: Buffer.from([0xff]) }), 400, 'BODY');
  await check(post(lab, 'prepare', { sessionId: f.pair.sessionId }, lab.agentToken, { 'Content-Encoding': 'gzip' }), 415, 'CONTENT_TYPE');
  const oversized = JSON.stringify({ sessionId: '🙂'.repeat(STUDIO_TEST_HTTP_LIMITS.bodyBytes / 4) });
  assert.ok(oversized.length < STUDIO_TEST_HTTP_LIMITS.bodyBytes && Buffer.byteLength(oversized) > STUDIO_TEST_HTTP_LIMITS.bodyBytes);
  await check(call(lab, { path: '/v1/playtests/prepare', body: oversized, headers: { 'Content-Length': String(Buffer.byteLength(oversized)) } }), 413, 'BODY_LIMIT');
  await check(call(lab, { path: '/v1/playtests/prepare', body: oversized, headers: { 'Transfer-Encoding': 'chunked' } }), 413, 'BODY_LIMIT');
  await check(call(lab, { path: '/v1/playtests/unknown' }), 404, 'NOT_FOUND');
  assert.deepEqual(f.counts(), beforeCounts); assert.deepEqual(persistentFiles(f.root), before); f.noExecution();
});

test('offline successful test initialization releases its owned ledger on later failure, even if cleanup throws', async t => {
  const f = fixture(t), work = new WorkStore({ directory: join(f.root, 'work-fixture'), projectPath: f.cwd });
  f.workStores.push(work);
  writeFileSync(join(f.stateDirectory, 'workflows'), PRIVATE);
  const originalClose = TestLedger.prototype.close;
  let closes = 0;
  t.mock.method(TestLedger.prototype, 'close', async function(this: TestLedger) {
    closes++; await originalClose.call(this); throw new Error('Synthetic ledger cleanup failure after release.');
  });
  await assert.rejects(f.start({ workStore: work }), { code: 'EEXIST' });
  assert.equal(closes, 1); assert.equal(f.effects.providerCloses, 1);
  assert.equal(existsSync(join(f.ledgerDirectory, 'writer.lock')), false);
  assert.deepEqual(work.runs(), [], 'The borrowed WorkStore must remain usable.');
  assert.equal(f.store.sessions().length, 1, 'The borrowed StudioStore must remain usable.');
  const reopened = new ConversationWorkStore({ directory: join(f.stateDirectory, 'conversation-work'), projectPath: f.cwd });
  reopened.close(); f.noExecution();
});

test('offline listener failure releases the owned ledger and preserves the original bind error', async t => {
  const f = fixture(t), occupied = createServer();
  await new Promise<void>(resolveListen => occupied.listen(0, '127.0.0.1', resolveListen));
  t.after(() => new Promise<void>((resolveClose, reject) => occupied.close(error => error ? reject(error) : resolveClose())));
  const address = occupied.address(); assert.ok(address && typeof address === 'object');
  await assert.rejects(f.start({ port: address.port }), { code: 'EADDRINUSE' });
  assert.equal(f.effects.providerCloses, 1);
  assert.equal(existsSync(join(f.ledgerDirectory, 'writer.lock')), false);
  assert.equal(f.store.sessions().length, 1); f.noExecution();
});

test('offline borrowed service still receives only trusted actors and is never closed by the lab', async t => {
  const f = fixture(t, 'missing-manifest'), actors: string[] = [];
  let closes = 0, approvals = 0;
  const refuse = (): never => { throw Object.assign(new Error(PRIVATE), { code: 'UNAVAILABLE' }); };
  const borrowed: StudioTestService = {
    requests: {
      async prepare(_input, actor) { actors.push(actor); return refuse(); },
      status(_id, actor) { actors.push(actor); return refuse(); },
      list(actor) { actors.push(actor); return []; },
      async cancel(_id, actor) { actors.push(actor); return refuse(); },
    },
    humanControl: { async approve(_input, guard) { guard(); approvals++; return refuse(); } },
    lifecycle: { async close() { closes++; } },
  };
  const lab = await f.start({ studioTestService: borrowed });
  assert.deepEqual((await call(lab, { token: lab.token })).json, { jobs: [] });
  assert.deepEqual((await call(lab)).json, { jobs: [] });
  assert.deepEqual(actors, ['human', 'agent-' + createHash('sha256').update(lab.agentToken).digest('hex')]);
  assert.equal((await post(lab, 'approve', APPROVAL, lab.agentToken, { Origin: lab.origin })).json.error, 'HUMAN_AUTH_REQUIRED');
  assert.equal(approvals, 0);
  const denied = await post(lab, 'approve', APPROVAL, lab.token, { Origin: lab.origin });
  assert.equal(denied.status, 503); assert.equal(denied.text.includes(PRIVATE), false); assert.equal(approvals, 1);
  await lab.close(); assert.equal(closes, 0); f.noExecution();
});

/** The desktop layout: the playtest state lives inside the project directory whose StudioStore holds the workspace lock. */
function projectLayout(f: ReturnType<typeof fixture>) {
  const stateDirectory = join(f.root, 'studio-fixture', 'connection-lab'), ledgerDirectory = join(stateDirectory, 'playtests', 'ledger');
  mkdirSync(ledgerDirectory, { recursive: true });
  return { stateDirectory, ledgerDirectory };
}
const unresolvedRecord = () => {
  const event = { kind: 'admit', id: 'fixture-unresolved-run', at: 1, scopeDigest: 'a'.repeat(64), evidence: 'fixture', code: 'OK' };
  const record = { seq: 1, previous: 'genesis', event };
  return JSON.stringify({ ...record, hash: digest(record) });
};

test('an empty writer lock left by a killed daemon no longer fences playtests or viewport capture', async t => {
  const f = fixture(t), layout = projectLayout(f);
  // Exactly the retained state found after the unclean shutdown: a zero-byte lock and no records.
  writeFileSync(join(layout.ledgerDirectory, 'writer.lock'), '');
  const lab = await f.start({ stateDirectory: layout.stateDirectory });
  for (const token of [lab.token, lab.agentToken]) {
    const listed = await call(lab, { token }); assert.equal(listed.status, 200); assert.deepEqual(listed.json, { jobs: [] });
  }
  const state = await call(lab, { path: '/v1/state', token: lab.token });
  assert.deepEqual(state.json.warnings, []);
  const lock = JSON.parse(readFileSync(join(layout.ledgerDirectory, 'writer.lock'), 'utf8'));
  assert.deepEqual(Object.keys(lock).sort(), ['schemaVersion', 'writerId'], 'The new lock names its owner shape.');
  await lab.close();
  assert.equal(existsSync(join(layout.ledgerDirectory, 'writer.lock')), false);
  // A second unclean stop leaves the new JSON lock: it is recognised and recovered too.
  writeFileSync(join(layout.ledgerDirectory, 'writer.lock'), JSON.stringify(lock));
  const again = await f.start({ stateDirectory: layout.stateDirectory });
  assert.equal((await call(again)).status, 200);
  f.noExecution();
});

test('foreign ledger state and a lab outside its workspace retain distinct refusal guidance', async t => {
  for (const kind of ['foreign-lock', 'unresolved-run', 'no-project-lock'] as const) await t.test(kind, async sub => {
    const f = fixture(sub, 'verified', { outsideWorkspace: kind === 'no-project-lock' });
    const layout = kind === 'no-project-lock'
      ? { stateDirectory: f.stateDirectory, ledgerDirectory: f.ledgerDirectory } : projectLayout(f);
    mkdirSync(layout.ledgerDirectory, { recursive: true });
    writeFileSync(join(layout.ledgerDirectory, 'writer.lock'), kind === 'foreign-lock' ? PRIVATE : '');
    if (kind === 'unresolved-run') writeFileSync(join(layout.ledgerDirectory, '00001.json'), unresolvedRecord());
    if (kind !== 'no-project-lock') {
      const reports = await openStudioTestReportStore({ directory: join(layout.stateDirectory, 'playtest-reports'),
        projectId: workflowProjectIdentity(f.cwd).projectId,
        exclusiveWriter: () => f.store.holdsWorkspaceLock(join(f.root, 'studio-fixture')) });
      try { assert.deepEqual(reports.status(), { state: 'ready', code: null }); }
      finally { reports.close(); }
    }
    const before = persistentFiles(f.root);
    const lab = await f.start({ stateDirectory: layout.stateDirectory });
    refusal(await call(lab), kind === 'no-project-lock' ? 'SDK_CUSTODY_UNCONFIRMED' : 'FENCED', lab, f.root);
    assert.deepEqual(persistentFiles(f.root), before, 'Unprovable state is never cleared automatically.');
    f.noExecution();
  });
});

test('Repair playtest records is human-only, keeps the earlier journal and restarts playtests', async t => {
  const f = fixture(t), layout = projectLayout(f);
  const recordBytes = unresolvedRecord();
  writeFileSync(join(layout.ledgerDirectory, '00001.json'), recordBytes); writeFileSync(join(layout.ledgerDirectory, 'writer.lock'), '');
  const lab = await f.start({ stateDirectory: layout.stateDirectory });
  refusal(await call(lab), 'FENCED', lab, f.root);
  const repair = (token: string, body: unknown, headers: Record<string, string> = { Origin: lab.origin }) =>
    call(lab, { path: '/v1/playtests/repair', body: JSON.stringify(body), token, headers });
  const confirm = { confirm: 'studio-in-edit-mode' };
  assert.equal((await repair(lab.agentToken, confirm)).status, 401, 'The assistant cannot repair its own fence.');
  assert.equal((await repair(lab.token, confirm, {})).status, 403, 'The desktop Origin is required.');
  assert.equal((await repair(lab.token, {})).status, 400, 'The person must confirm Studio is back in Edit mode.');
  assert.equal(existsSync(join(layout.ledgerDirectory, '00001.json')), true);
  const repaired = await repair(lab.token, confirm);
  assert.equal(repaired.status, 200); assert.equal(repaired.json.repaired, true);
  const retainedRoot = join(layout.stateDirectory, 'playtests-retained'), [kept] = readdirSync(retainedRoot);
  assert.ok(kept && String(repaired.json.retained).endsWith(kept));
  assert.equal(readFileSync(join(retainedRoot, kept, '00001.json'), 'utf8'), recordBytes, 'The earlier evidence is kept byte for byte.');
  assert.equal(existsSync(join(retainedRoot, kept, 'writer.lock')), true);
  for (const token of [lab.token, lab.agentToken]) assert.deepEqual((await call(lab, { token })).json, { jobs: [] });
  assert.deepEqual((await call(lab, { path: '/v1/state', token: lab.token })).json.warnings, []);
  assert.equal((await repair(lab.token, confirm)).json.error, 'NOT_FENCED');
  f.noExecution();
});
