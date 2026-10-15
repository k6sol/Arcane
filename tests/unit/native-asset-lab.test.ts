import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, lstatSync, rmSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createConnectionLab } from '../../apps/daemon/src/lab-server.js';
import { createCodexService, type CodexHostClient, type CodexActionRecord, type CodexActionOutcome, type CodexProductState } from '../../apps/daemon/src/codex-service.js';
import type { AssetService, AssetJobRecord } from '../../apps/daemon/src/asset-service.js';
import { CodexClientError, type NativeAssetHooks, type Snapshot } from '../../packages/codex-client/src/index.js';
import { ConversationWorkStore } from '../../packages/storage/src/conversation-work-store.js';
import { StudioStore } from '../../packages/storage/src/studio-store.js';
import { WorkStore } from '../../packages/storage/src/work-store.js';
import { READ_METHODS, WRITE_METHODS, type StudioCommand } from '../../packages/protocol/src/studio.js';
import { normalizeRequest } from '../../packages/asset-pipeline/src/validation.js';
import { DaemonClient } from '../../apps/mcp/src/daemon-client.js';
import { createMcpServer } from '../../apps/mcp/src/server.js';
import { nativeAssetStart, nativeAssetJobPage } from '../../apps/mcp/src/asset-schemas.js';

// Actual LAB, SQLite and official SDK/HTTP. Only CodexHostClient and AssetService
// are explicit provider/runtime doubles; this is not installed-native attestation.
const ROOT = resolve('.');
const workInput = () => ({ title: 'LAB fixture', objective: 'Prove inherited coordination scope', tasks: [
  { key: 'one', title: 'Fixture task', instructions: 'Read fixture evidence', acceptance: 'Human review', dependencies: [], scope: ['fixture/evidence.txt'] },
] });
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(accept => { release = accept; });
  return { promise, release };
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check() && Date.now() < deadline) await new Promise(accept => setTimeout(accept, 5));
  assert.ok(check(), 'Fixture boundary reached within deadline');
}
function temporaryProject() {
  const boundary = realpathSync(tmpdir()), root = mkdtempSync(join(boundary, 'arcane-native-asset-lab-'));
  const projectPath = join(root, 'project'); mkdirSync(projectPath);
  const cleanup = () => {
    const part = relative(boundary, resolve(root));
    assert.ok(part && !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep));
    assert.equal(lstatSync(root).isSymbolicLink(), false);
    rmSync(root, { recursive: true, force: true });
  };
  return { root, projectPath: realpathSync(projectPath), cleanup };
}

async function fixture(t: test.TestContext) {
  const { root, projectPath, cleanup } = temporaryProject(), stateDirectory = join(root, 'lab');
  const studio = new StudioStore({ directory: join(root, 'studio') });
  const work = new WorkStore({ directory: join(root, 'work'), projectPath });
  const threadAck = gate(), threadEntered = gate(), turnAck = gate(), turnEntered = gate();
  const connectionId = randomUUID(), threadId = 'LAB.fake-provider.original-chat', sessionId = 'LAB.fake-provider.session';
  let hooks: NativeAssetHooks | undefined, localKey = '', starts = 0, cancels = 0, closes = 0;
  const snapshot: Snapshot = { connectionId, provenance: 'spawned-node-fixture', mcpIsolation: 'arcane-only-pending',
    connected: true, ready: true, account: { auth: 'subscription', plan: null, requiresOpenaiAuth: true },
    models: [], selection: { model: 'LAB.fake-model', effort: 'low' }, thread: null, operations: [], approvals: [], events: [],
    droppedEvents: 0, lastEventSeq: 0, failureCode: null };
  const fakeCodexHostClient: CodexHostClient = {
    snapshot: () => structuredClone(snapshot),
    selectModel(input) { snapshot.selection = { model: input.model, effort: input.effort }; return snapshot.selection; },
    async startThread(input) {
      assert.equal(input.initiatedBy, 'human');
      snapshot.mcpIsolation = 'arcane-only-verified';
      snapshot.thread = { threadId, sessionId, selection: snapshot.selection!, configured: true, writeGranted: false, turnId: null, turnStatus: 'idle' };
      threadEntered.release(); await threadAck.promise; return structuredClone(snapshot.thread);
    },
    async resumeThread() { throw new Error('Fake provider does not resume'); },
    grantThreadWrites() { throw new Error('Fake provider has no native file writes'); },
    revokeThreadWrites() {},
    async startTurn(input) {
      assert.equal(input.initiatedBy, 'human'); assert.equal(input.threadId, threadId); assert.ok(snapshot.thread && hooks);
      hooks.dispatched({ connectionId, threadId, operationId: randomUUID() });
      snapshot.thread.turnStatus = 'starting'; turnEntered.release();
      await turnAck.promise; snapshot.thread.turnId = 'LAB.fake-turn'; snapshot.thread.turnStatus = 'inProgress';
      return structuredClone(snapshot.thread);
    },
    async interruptTurn() { throw new Error('Fake provider does not interrupt'); },
    respondApproval() { throw new Error('Fake provider has no approvals'); },
    async close() {
      // The owned service must fence BEFORE asking its provider double to close.
      assert.ok(hooks);
      assert.throws(() => hooks!.dispatched({ connectionId, threadId, operationId: randomUUID() }), { code: 'ASSET_AUTHORITY' });
      closes++; snapshot.connected = false; snapshot.ready = false; hooks.retired();
      threadAck.release(); turnAck.release();
    },
  };
  const jobs: AssetJobRecord[] = [];
  const fakeAssetService: AssetService = {
    projectPath, outputRoot: join(root, 'fake-assets'),
    jobs: () => structuredClone(jobs),
    jobPage() { return { schemaVersion: 1, jobs: structuredClone(jobs), total: jobs.length, nextCursor: null, byteLimit: 512 * 1024 }; },
    async start(input, admission) {
      const request = normalizeRequest(input); admission?.beforeCreate(); starts++;
      const job: AssetJobRecord = { schemaVersion: 1, jobId: randomUUID(), directory: join(root, 'fake-assets', String(starts)),
        manifestPath: null, request, state: 'running', stage: 'Explicit fake AssetService', startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(), events: [], manifestAvailable: false, error: null };
      jobs.push(job); admission?.created(job.jobId); return structuredClone(job);
    },
    async cancel(id) { const job = jobs.find(value => value.jobId === id); assert.ok(job); cancels++; job.state = 'cancelled'; return structuredClone(job); },
    async probe() { throw new Error('No runtime probes in LAB proof'); },
    async manifest() { throw new Error('No generated manifests in LAB proof'); },
    async adoptProjectGlb() { throw new Error('Adoption is unavailable in this existing non-adoption fixture.'); },
    async prepareStudioImport() { throw new Error('No generated import preparation evidence in LAB proof'); },
    async prepareStudioImportPayload() { throw new Error('Payload staging must not be called by this public service fixture.'); },
    async preview() { throw new Error('No rendered previews in LAB proof'); },
    async artifact() { throw new Error('No generated artifacts in LAB proof'); },
    async close() {},
  };
  const lab = await createConnectionLab({ cwd: ROOT, projectPath, stateDirectory, studioStore: studio, workStore: work,
    assetService: fakeAssetService, probe: async () => { throw new Error('No provider probes in LAB proof'); },
    codexConnect: async value => {
      assert.ok(value && Object.isFrozen(value)); hooks = value; localKey = value.finalCredential();
      assert.ok(/^[a-f0-9]{64}$/.test(localKey)); return fakeCodexHostClient;
    } });
  let sdk: Client | null = null, sdkServer: ReturnType<typeof createMcpServer> | null = null;
  t.after(async () => {
    try { await sdk?.close(); await sdkServer?.close(); }
    finally { try { await lab.close(); } finally { work.close(); studio.close(); cleanup(); } }
  });
  type Reply<T> = { status: number; data: T };
  const http = async <T = Record<string, unknown>>(path: string, bearer: string, input?: unknown, headers: Record<string, string> = {}): Promise<Reply<T>> => {
    const response = await fetch(lab.origin + path, { method: input === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + bearer, ...(input === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(6000) });
    const text = await response.text();
    if (localKey) assert.equal(text.includes(localKey), false, 'LAB HTTP must not disclose the native local key');
    return { status: response.status, data: JSON.parse(text) as T };
  };
  const action = (action: string, extra: Record<string, unknown> = {}, requestId = randomUUID()) =>
    http<CodexActionOutcome>('/v1/codex/action', lab.token, { requestId, connectionId: action === 'connect' ? null : connectionId, action, ...extra }, { Origin: lab.origin });
  const tool = async (name: string, input: Record<string, unknown> = {}) => {
    if (!sdk) {
      assert.ok(localKey);
      const server = createMcpServer({ client: new DaemonClient({ url: lab.origin, token: localKey, assetAudience: 'native-session' }), projectRoot: projectPath });
      sdkServer = server;
      sdk = new Client({ name: 'LAB.explicit-provider-runtime-doubles', version: '1.0.0' });
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport); await sdk.connect(clientTransport);
    }
    return CallToolResultSchema.parse(await sdk.callTool({ name, arguments: { timeoutMs: 2000, ...input } }));
  };
  return { lab, work, studio, snapshot, fakeAssetService, projectPath, threadId, sessionId, connectionId, tool, action,
    threadEntered: threadEntered.promise, turnEntered: turnEntered.promise, releaseThread: threadAck.release, releaseTurn: turnAck.release,
    native: (path: string, input?: unknown, headers?: Record<string, string>) => http(path, localKey, input, headers),
    human: (path: string, input?: unknown, headers?: Record<string, string>) => http(path, lab.token, input, headers),
    generic: (path: string, input?: unknown) => http(path, lab.agentToken, input),
    async state() { return (await http<{ state: CodexProductState }>('/v1/codex/state', lab.token)).data.state; },
    journal(id: string) {
      const db = new DatabaseSync(join(stateDirectory, 'native-codex', 'codex-actions.sqlite'), { readOnly: true });
      try { const row = db.prepare('SELECT payload FROM actions WHERE id=?').get(id) as { payload: string }; return JSON.parse(row.payload) as CodexActionRecord; }
      finally { db.close(); }
    },
    bindingsDirectory: join(stateDirectory, 'conversation-work'),
    get starts() { return starts; }, get cancels() { return cancels; }, get closes() { return closes; },
    async ready() { assert.equal((await action('connect')).status, 200); threadAck.release(); assert.equal((await action('thread-start')).status, 200); },
    async partialCoreBody(input: unknown) {
      const path = '/v1/work/create', marker = randomUUID(), body = Buffer.from(JSON.stringify(input));
      let incoming: IncomingMessage | null = null;
      const observe = (request: IncomingMessage) => { if (request.headers['x-lab-fixture'] === marker) incoming = request; };
      lab.server.on('request', observe);
      const outgoing = httpRequest(lab.origin + path, { method: 'POST', headers: { Authorization: 'Bearer ' + localKey,
        'Content-Type': 'application/json', 'Content-Length': body.length, 'X-Lab-Fixture': marker } });
      const result = new Promise<Reply<Record<string, unknown>>>((accept, reject) => {
        outgoing.once('error', reject); outgoing.once('response', response => {
          const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(Buffer.from(chunk)));
          response.once('end', () => accept({ status: response.statusCode!, data: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> }));
        });
      });
      void result.catch(() => {});
      t.after(() => outgoing.destroy()); outgoing.setTimeout(6000, () => outgoing.destroy(new Error('Fixture body deadline')));
      outgoing.write(body.subarray(0, 1));
      try {
        // The real bridge's async body iterator has begun after agent classification.
        await until(() => incoming !== null && !incoming.complete && incoming.readableLength === 0 && incoming.listenerCount('readable') > 0);
      } finally { lab.server.off('request', observe); }
      return { finish: () => outgoing.end(body.subarray(1)), result };
    },
  };
}
function toolData(result: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['tool']>>) {
  assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent));
  assert.ok(result.structuredContent); return result.structuredContent;
}

test('LAB built-in service seals only after the durable human thread ACK', { timeout: 15000 }, async t => {
  const f = await fixture(t); assert.equal((await f.action('connect')).status, 200);
  const requestId = randomUUID(), pending = f.action('thread-start', {}, requestId); await f.threadEntered;
  assert.equal(f.snapshot.thread?.configured, true, 'Even configured provider metadata is insufficient before ACK');
  assert.equal(f.journal(requestId).state, 'pending'); assert.equal((await f.state()).nativeAssets?.sealed, false);
  assert.equal((await f.native('/v1/assets/native/jobs')).status, 403);
  assert.equal((await f.native('/v1/work/runs')).status, 401);
  f.releaseThread(); const acknowledged = await pending;
  assert.equal(acknowledged.status, 200); assert.equal(f.journal(requestId).state, 'acknowledged');
  assert.equal(acknowledged.data.state.nativeAssets?.sealed, true); assert.equal(acknowledged.data.state.nativeAssets?.granted, false);
  assert.deepEqual(acknowledged.data.state.nativeHistory, { projectPath: f.projectPath, threadId: f.threadId, sessionId: f.sessionId, recorded: null });
  const stateText = JSON.stringify(acknowledged.data.state);
  for (const field of ['codexConnect', 'assetRegistry', 'finalCredential', 'nativeAssetHooks']) assert.equal(stateText.includes(field), false);
  assert.equal((await f.action('connect', { codexConnect: {}, assetRegistry: {} })).status, 400, 'Factory and registry cannot enter through action JSON');
});

test('LAB native SDK starts before turn ACK, binds original chat, and requires explicit start/cancel grant', { timeout: 15000 }, async t => {
  const f = await fixture(t); await f.ready();
  const global = await f.fakeAssetService.start({ template: 'hero-prop', name: 'unscoped-double-job' });
  for (const [name, args] of [['assets_start', { template: 'hero-prop', name: 'no-grant' }], ['assets_cancel', { jobId: global.jobId }]] as const)
    assert.equal((await f.tool(name, args)).isError, true, name);
  assert.equal(f.starts, 1); assert.equal(f.cancels, 0);
  assert.equal((await f.action('grant-assets', { threadId: 'foreign-chat' })).status, 409);
  const granted = await f.action('grant-assets', { threadId: f.threadId }); assert.equal(granted.status, 200);
  assert.equal(f.journal(granted.data.record.requestId).state, 'acknowledged'); assert.equal(f.snapshot.thread?.writeGranted, false);
  assert.equal((await f.tool('assets_start', { template: 'hero-prop', name: 'no-dispatch' })).isError, true);
  const turnId = randomUUID(), pending = f.action('turn-start', { threadId: f.threadId, text: 'Explicit fake provider turn' }, turnId);
  await f.turnEntered; assert.equal(f.journal(turnId).state, 'pending'); assert.equal((await f.state()).nativeAssets?.admissionOpen, true);
  const started = nativeAssetStart.parse(toolData(await f.tool('assets_start', { template: 'hero-prop', name: 'original-chat-job' })));
  assert.equal(started.association, 'bound'); assert.ok(started.jobId); assert.equal(f.starts, 2);
  assert.deepEqual(started.conversation, { provider: 'codex', threadId: f.threadId, sessionId: f.sessionId });
  assert.equal(f.journal(turnId).state, 'pending', 'SDK asset creation must complete while provider ACK is withheld');
  f.releaseTurn(); assert.equal((await pending).status, 200);
  // Changing the fake provider's displayed chat cannot adopt/rebind native asset scope.
  f.snapshot.thread!.threadId = 'foreign-display-chat';
  const page = nativeAssetJobPage.parse(toolData(await f.tool('assets_jobs')));
  assert.deepEqual(page.conversation, started.conversation); assert.deepEqual(page.jobs.map(job => job.jobId), [started.jobId]);
  assert.equal((await f.native('/v1/assets/native/manifest?jobId=' + global.jobId)).status, 404);
  assert.equal((await f.tool('assets_cancel', { jobId: global.jobId })).isError, true); assert.equal(f.cancels, 0);
  f.snapshot.thread!.threadId = f.threadId;
  assert.equal((toolData(await f.tool('assets_cancel', { jobId: started.jobId })).job as AssetJobRecord).state, 'cancelled');
  assert.equal(f.cancels, 1);
  assert.equal((await f.action('revoke-assets', { threadId: f.threadId })).status, 200);
  assert.equal((await f.tool('assets_start', { template: 'hero-prop', name: 'revoked' })).isError, true);
  assert.equal((await f.tool('assets_cancel', { jobId: started.jobId })).isError, true); assert.equal(f.starts, 2); assert.equal(f.cancels, 1);
  assert.equal(nativeAssetJobPage.parse(toolData(await f.tool('assets_jobs'))).jobs.length, 1, 'Revocation retains scoped reads');
  await f.lab.close(); assert.equal(f.closes, 1, 'Shutdown fences before provider close');
  const retained = new ConversationWorkStore({ directory: f.bindingsDirectory, projectPath: f.projectPath });
  try { assert.deepEqual(retained.binding('asset-job', started.jobId)?.conversation, started.conversation); assert.equal(retained.binding('asset-job', global.jobId), null); }
  finally { retained.close(); }
});

test('LAB dispatch without a human asset grant cannot start or cancel', { timeout: 15000 }, async t => {
  const f = await fixture(t); await f.ready();
  const pending = f.action('turn-start', { threadId: f.threadId, text: 'Explicit ungranted fake turn' });
  await f.turnEntered; const state = await f.state();
  assert.equal(state.nativeAssets?.admissionOpen, false, 'Dispatch without a grant does not authorize admission'); assert.equal(state.nativeAssets?.granted, false);
  for (const [path, input] of [
    ['/v1/assets/native/start', { template: 'hero-prop', name: 'dispatched-without-grant' }],
    ['/v1/assets/native/cancel', { jobId: randomUUID() }],
  ] as const) {
    const denied = await f.native(path, input); assert.equal(denied.status, 403); assert.equal(denied.data.error, 'NATIVE_ASSET_AUTHORITY');
  }
  assert.equal(f.starts, 0); assert.equal(f.cancels, 0); f.releaseTurn(); assert.equal((await pending).status, 200);
});

test('LAB sealed key inherits Studio/work READ tools but cannot grant/review/export keys or use global assets', { timeout: 15000 }, async t => {
  const f = await fixture(t); await f.ready();
  const grant = f.studio.createGrant({ allowedRoots: ['Workspace'], allowWrites: false });
  const paired = f.studio.pair({ code: grant.code, protocolVersion: 1, identity: { clientSessionId: randomUUID(), placeId: 0, universeId: 0,
    name: 'Explicit non-engine Studio fixture', pluginVersion: 'LAB.fixture' }, capabilities: [...READ_METHODS, ...WRITE_METHODS] });
  const run = f.work.create(workInput());
  assert.equal((toolData(await f.tool('sessions')).sessions as { id: string }[])[0]?.id, paired.sessionId);
  assert.equal((toolData(await f.tool('work_runs')).runs as { id: string }[])[0]?.id, run.id);
  assert.equal((toolData(await f.tool('work_ready', { runId: run.id })).tasks as { id: string }[])[0]?.id, run.tasks[0]!.id);
  const queued = await f.native('/v1/studio/commands', { sessionId: paired.sessionId, requestId: randomUUID(), method: 'scene.children', args: { root: 'Workspace' } });
  assert.equal(queued.status, 200); const command = queued.data.command as StudioCommand;
  assert.deepEqual(command.allowedRoots, ['Workspace']); assert.equal(command.allowWrites, false);
  assert.equal((toolData(await f.tool('receipt_status', { commandId: command.id })).command as StudioCommand).id, command.id);
  assert.equal((await f.tool('scene_children', { sessionId: paired.sessionId, root: 'Lighting' })).isError, true);
  const ref = { instanceId: 'fixture-ref', sessionId: paired.sessionId, root: 'Workspace', pathSegments: ['Fixture'], className: 'ModuleScript' };
  const refused = await f.tool('script_update', { sessionId: paired.sessionId, ref, expectedSource: '', source: 'return 1' });
  assert.equal(refused.isError, true); assert.equal((refused.structuredContent?.error as { code: string }).code, 'READ_ONLY');
  assert.equal(f.studio.commands(paired.sessionId).length, 1, 'Denied root/write requests never enqueue');
  for (const [path, input] of [
    ['/v1/studio/pairing', { allowedRoots: ['Workspace'], allowWrites: true }], ['/v1/studio/revoke', { sessionId: paired.sessionId }],
    ['/v1/studio/keys', { allowedRoots: ['Workspace'], allowWrites: true }], ['/v1/studio/keys/revoke', { keyId: randomUUID() }],
    ['/v1/work/review', { taskId: run.tasks[0]!.id, approved: true, note: 'Forged review' }], ['/v1/product/mcp-token', {}],
  ] as const) {
    const denied = await f.native(path, input, { Origin: f.lab.origin }); assert.equal(denied.status, 403, path); assert.equal(denied.data.error, 'SCOPE');
  }
  assert.equal((await f.native('/v1/studio/keys')).status, 403); assert.equal(f.studio.keys().length, 0);
  assert.equal(f.work.task(run.tasks[0]!.id).state, 'pending'); assert.equal(f.studio.session(paired.sessionId).revokedAt, null);
  for (const [path, input] of [['/v1/assets/jobs', undefined], ['/v1/assets/start', { template: 'hero-prop', name: 'global-bypass' }], ['/v1/assets/cancel', { jobId: randomUUID() }]] as const)
    assert.equal((await f.native(path, input)).status, 401, path);
  assert.equal((await f.native('/v1/codex/action', { requestId: randomUUID(), connectionId: f.connectionId, action: 'grant-assets', threadId: f.threadId }, { Origin: f.lab.origin })).status, 401);
  for (const origin of [f.lab.origin, 'https://forged.example']) assert.equal((await f.native('/v1/assets/native/jobs', undefined, { Origin: origin })).status, 403);
  assert.equal((await f.native('/v1/work/runs', undefined, { Origin: 'https://forged.example' })).status, 403);
  assert.equal((await f.human('/v1/assets/native/jobs')).status, 403); assert.equal((await f.generic('/v1/assets/native/jobs')).status, 403);
  assert.equal(f.starts, 0); assert.equal(f.cancels, 0);
});

test('LAB disconnect retires native and inherited Core keys, including a body already being read', { timeout: 15000 }, async t => {
  const f = await fixture(t); await f.ready();
  assert.equal((await f.native('/v1/work/runs')).status, 200);
  const stalled = await f.partialCoreBody(workInput()); assert.equal(f.work.runs().length, 0);
  assert.equal((await f.action('disconnect')).status, 200); assert.equal(f.closes, 1);
  stalled.finish(); const denied = await stalled.result;
  assert.equal(denied.status, 403); assert.equal(denied.data.error, 'SCOPE'); assert.equal(f.work.runs().length, 0);
  assert.equal((await f.native('/v1/assets/native/jobs')).status, 403);
  assert.equal((await f.native('/v1/work/runs')).status, 401); assert.equal((await f.native('/v1/studio/sessions')).status, 401);
  assert.equal(f.starts, 0); assert.equal(f.cancels, 0);
});

test('LAB existing codexService injection takes precedence over the trusted connect seam', { timeout: 10000 }, async t => {
  const { root, projectPath, cleanup } = temporaryProject(); let ownedConnects = 0, injectedConnects = 0;
  const service = createCodexService({ directory: join(root, 'injected-journal'), projectPath, connect: async () => {
    injectedConnects++; throw new CodexClientError('FIXTURE_INJECTED', 'Explicit injected service fixture');
  } });
  const lab = await createConnectionLab({ cwd: ROOT, projectPath, stateDirectory: join(root, 'lab'), codexService: service,
    codexConnect: async () => { ownedConnects++; throw new Error('Owned factory must not run'); } });
  t.after(async () => { try { await lab.close(); } finally { await service.close(); cleanup(); } });
  const response = await fetch(lab.origin + '/v1/codex/action', { method: 'POST', headers: { Authorization: 'Bearer ' + lab.token,
    'Content-Type': 'application/json', Origin: lab.origin }, body: JSON.stringify({ requestId: randomUUID(), connectionId: null, action: 'connect' }) });
  assert.equal(response.status, 409); const outcome = await response.json() as CodexActionOutcome;
  assert.equal(outcome.record.errorCode, 'FIXTURE_INJECTED'); assert.equal(injectedConnects, 1); assert.equal(ownedConnects, 0);
});
