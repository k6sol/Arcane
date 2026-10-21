import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createNativeAssetRegistry, nativeAssetOperationSignal } from '../../apps/daemon/src/native-asset-authority.js';
import { createAssetConversationHost } from '../../apps/daemon/src/asset-conversation-host.js';
import { createAssetService } from '../../apps/daemon/src/asset-service.js';
import { nativeAssetRoutes } from '../../apps/daemon/src/native-asset-routes.js';
import { createCodexService, type CodexHostClient } from '../../apps/daemon/src/codex-service.js';
import { codexRoutes } from '../../apps/daemon/src/codex-routes.js';
import { ConversationWorkStore } from '../../packages/storage/src/conversation-work-store.js';
import { AssetError, AssetPipeline, type AssetJobResult, type AssetRequest, type AssetJobState } from '../../packages/asset-pipeline/src/index.js';
import { runBounded } from '../../packages/asset-pipeline/src/process.js';
import { manifestFixture } from '../../packages/asset-pipeline/testing/fixture.js';
import { CodexClientError, type NativeAssetHooks, type Snapshot } from '../../packages/codex-client/src/types.js';

// Real registry, host, HTTP, SQLite, asset service, pipeline cancellation relay
// and bounded child-process supervision. Only the Blender generation method is
// replaced by a controlled Node worker with explicitly synthetic asset bytes.
// No installed provider, Blender, Studio, upload or native asset acceptance.
const INPUT = { template: 'environment-kit' as const, name: 'test-kit', renderResolution: 128 };
const ROOT = resolve(process.cwd());
const CHILD = String.raw`
const {existsSync,writeFileSync}=require('node:fs');
const [directory]=process.argv.slice(1),{join}=require('node:path');
writeFileSync(join(directory,'partial-worker.txt'),'Retained controlled worker output\n');
process.stdout.write('CONTROLLED_READY\n');
setInterval(()=>{if(existsSync(join(directory,'finish-worker')))process.exit(0);},20);
`;
type Generate = (id: string, directory: string, request: AssetRequest, source: unknown, end: number,
  signal: AbortSignal, emit: (stage: string, state?: AssetJobState) => void) => Promise<AssetJobResult>;
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 8000;
  while (!await check()) { assert.ok(Date.now() < deadline, 'Controlled worker did not reach the expected state.'); await delay(5); }
}
async function fixture(t: test.TestContext) {
  const boundary = await realpath(tmpdir()), root = await realpath(await mkdtemp(join(boundary, 'arcane-native-work-stop-')));
  const projectPath = join(root, 'project'), outputRoot = join(root, 'assets'); await mkdir(projectPath);
  const registry = createNativeAssetRegistry({ projectPath });
  const associations = new ConversationWorkStore({ projectPath, directory: join(root, 'bindings') });
  const workers = new Map<string, { directory: string; ready: boolean; exited: boolean; signal: AbortSignal }>();
  t.mock.method(AssetPipeline.prototype as unknown as { generate: Generate }, 'generate', async (...[jobId, directory, request, _source, _end, signal, emit]: Parameters<Generate>) => {
    const worker = { directory, ready: false, exited: false, signal }; workers.set(jobId, worker);
    const startedAt = new Date().toISOString(); let result: AssetJobResult;
    await mkdir(directory);
    const journal = { schemaVersion: 1, jobId, directory, request, startedAt, manifestPath: null, state: 'running', error: null };
    await writeFile(join(directory, 'job.json'), JSON.stringify(journal)); emit('controlled-worker');
    try {
      const child = await runBounded({ executable: process.execPath, args: ['-e', CHILD, directory], cwd: directory },
        { signal, deadlineMs: 10000, onLine: line => { if (line === 'CONTROLLED_READY') worker.ready = true; } });
      assert.equal(child.exitCode, 0);
      const manifest = await manifestFixture(directory); manifest.jobId = jobId;
      assert.deepEqual(manifest.request, request); await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
      result = { jobId, directory, state: 'succeeded', manifestPath: join(directory, 'manifest.json'), error: null };
    } catch (error) {
      assert.ok(error instanceof AssetError && error.code === 'CANCELLED', String(error));
      result = { jobId, directory, state: 'cancelled', manifestPath: null, error: { code: 'CANCELLED', message: 'Controlled worker stopped.' } };
    } finally { worker.exited = true; }
    await writeFile(join(directory, 'job.json'), JSON.stringify({ ...journal, ...result, finishedAt: new Date().toISOString() }));
    emit('complete', result.state); return result;
  });
  const assets = await createAssetService({ cwd: ROOT, projectPath, outputRoot,
    blenderExecutable: join(root, 'absent-blender.exe'), pythonExecutable: join(root, 'absent-python.exe') });
  let current: { state: Snapshot; hooks: NativeAssetHooks; credential: string; operationId: string | null } | null = null;
  let serial = 0, revokeFailure = false;
  const codex = createCodexService({ directory: join(root, 'codex'), projectPath, assetRegistry: registry,
    connect: async hooks => {
      assert.ok(hooks); const connectionId = randomUUID();
      const state: Snapshot = { connectionId, provenance: 'spawned-node-fixture', connected: true, ready: true,
        mcpIsolation: 'arcane-only-verified', account: { auth: 'subscription', plan: null, requiresOpenaiAuth: true },
        models: [{ id: 'fixture', model: 'fixture', displayName: 'Fixture', efforts: ['low'], defaultEffort: 'low', entitlement: 'unverified' }],
        selection: null, thread: null, operations: [], approvals: [], events: [], droppedEvents: 0, lastEventSeq: 0, failureCode: null };
      const owned = { state, hooks, credential: hooks.finalCredential(), operationId: null as string | null }; current = owned;
      const exact = (threadId: string) => { if (state.thread?.threadId !== threadId) throw new CodexClientError('THREAD', 'Wrong controlled thread.'); return state.thread; };
      const client: CodexHostClient = {
        snapshot: () => structuredClone(state),
        selectModel(action) { state.selection = { model: action.model, effort: action.effort }; return { ...state.selection }; },
        async startThread() { state.thread = { threadId: 'controlled-thread-' + ++serial, sessionId: null, selection: { ...state.selection! },
          configured: true, writeGranted: false, turnId: null, turnStatus: 'idle' }; return structuredClone(state.thread); },
        async resumeThread() { throw new Error('No resume in this controlled peer.'); },
        grantThreadWrites(action) { const thread = exact(action.threadId); thread.writeGranted = true; return structuredClone(thread); },
        revokeThreadWrites(action) {
          exact(action.threadId).writeGranted = false; hooks.retired(); state.connected = false; state.ready = false;
          if (revokeFailure) throw new CodexClientError('APPROVAL_UNKNOWN', 'Controlled native approval delivery failed.');
        },
        async startTurn(action) {
          const thread = exact(action.threadId), operationId = randomUUID(); owned.operationId = operationId;
          state.operations.push({ operationId, method: 'turn/start', requestId: ++serial, threadId: thread.threadId,
            turnId: null, state: 'pending', errorCode: null });
          hooks.dispatched({ connectionId, threadId: thread.threadId, operationId });
          thread.turnId = 'controlled-turn-' + ++serial; thread.turnStatus = 'inProgress';
          Object.assign(state.operations.at(-1)!, { state: 'acknowledged', turnId: thread.turnId }); return structuredClone(thread);
        },
        async interruptTurn(action) {
          const thread = exact(action.threadId); assert.equal(thread.turnId, action.turnId);
          if (owned.operationId) hooks.ended({ connectionId, threadId: thread.threadId, operationId: owned.operationId });
          thread.turnStatus = 'interrupted'; thread.writeGranted = false;
        },
        respondApproval() { throw new Error('No approval in this controlled peer.'); },
        async close() { hooks.retired(); state.connected = false; state.ready = false; },
      }; return client;
    },
  });
  const host = createAssetConversationHost({ projectPath, workAssociations: associations, conversation: () => null,
    start: async () => { throw new Error('Generic generation is not used.'); },
    startNative: async (request, admission) => (await assets.start(request, admission)).jobId });
  const native = nativeAssetRoutes(assets, host, registry), controls = codexRoutes(codex);
  const human = 'controlled-human-' + randomUUID(), agent = 'controlled-agent-' + randomUUID(); let origin = '';
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', origin);
    if (await controls(request, response, url, human, origin, agent)) return;
    if (await native(request, response, url, origin)) return;
    response.writeHead(404); response.end();
  });
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  t.after(async () => {
    try { server.closeAllConnections(); await new Promise<void>(resolveClose => server.close(() => resolveClose())); await codex.close(); await assets.close(); }
    finally {
      registry.close(); associations.close(); t.mock.restoreAll();
      const part = relative(boundary, root); assert.ok(!isAbsolute(part) && part.startsWith('arcane-native-work-stop-') && !part.includes(sep));
      await rm(root, { recursive: true, force: true });
    }
  });
  const call = async (path: string, value: unknown, bearer: string, requestOrigin: string | null) => {
    const response = await fetch(origin + path, { method: 'POST', headers: { Authorization: 'Bearer ' + bearer, 'Content-Type': 'application/json',
      ...(requestOrigin === null ? {} : { Origin: requestOrigin }) }, body: JSON.stringify(value), signal: AbortSignal.timeout(10000) });
    return { status: response.status, data: await response.json() as Record<string, unknown> };
  };
  const action = (action: string, fields: Record<string, unknown> = {}, bearer = human, requestOrigin: string | null = origin) =>
    call('/v1/codex/action', { requestId: randomUUID(), connectionId: action === 'connect' ? null : current!.state.connectionId, action, ...fields }, bearer, requestOrigin);
  const ready = async () => {
    assert.equal((await action('connect')).status, 200); assert.equal((await action('select', { model: 'fixture', effort: 'low' })).status, 200);
    assert.equal((await action('thread-start')).status, 200);
    assert.equal((await action('turn-start', { threadId: current!.state.thread!.threadId, text: 'Controlled asset request', allowAssets: true })).status, 200);
  };
  await ready();
  return { root, registry, associations, assets, host, codex, workers, action, call, origin, human, agent,
    failRevoke() { revokeFailure = true; },
    get current() { assert.ok(current); return current; },
    get signal() { return nativeAssetOperationSignal(registry.capture(current!.credential, 'mutate')); },
    async start() {
      const signal = nativeAssetOperationSignal(registry.capture(current!.credential, 'mutate'));
      const reply = await call('/v1/assets/native/start', INPUT, current!.credential, null); assert.equal(reply.status, 200);
      const jobId = reply.data.jobId as string; assert.ok(jobId); await until(() => workers.get(jobId)?.ready === true);
      return { jobId, signal, directory: workers.get(jobId)!.directory };
    },
    completeTurn() {
      const selected = current!; selected.hooks.ended({ connectionId: selected.state.connectionId, threadId: selected.state.thread!.threadId, operationId: selected.operationId! });
      selected.state.thread!.turnStatus = 'completed';
    },
    async settled(jobId: string) { await until(() => assets.jobs().some(job => job.jobId === jobId && job.state !== 'running')); return assets.jobs().find(job => job.jobId === jobId)!; },
  };
}

test('human Stop cancels the admitted bounded worker and preserves partial output and original conversation binding', async t => {
  const f = await fixture(t), job = await f.start(), conversation = { provider: 'codex', threadId: f.current.state.thread!.threadId, sessionId: null };
  assert.equal((await f.action('turn-interrupt', { threadId: conversation.threadId, turnId: f.current.state.thread!.turnId })).status, 200);
  assert.equal(job.signal.aborted, true); const stopped = await f.settled(job.jobId);
  assert.equal(stopped.state, 'cancelled'); assert.equal(stopped.error?.code, 'CANCELLED'); assert.equal(f.workers.get(job.jobId)?.exited, true);
  assert.equal(await readFile(join(job.directory, 'partial-worker.txt'), 'utf8'), 'Retained controlled worker output\n');
  assert.deepEqual(f.associations.binding('asset-job', job.jobId)?.conversation, conversation);
});

test('normal terminal and stopping a later operation preserve the earlier asynchronous worker and other incarnations', async t => {
  const f = await fixture(t), job = await f.start(); f.completeTurn();
  assert.equal(job.signal.aborted, false); assert.equal(f.assets.jobs()[0]?.state, 'running');
  assert.equal((await f.action('turn-start', { threadId: f.current.state.thread!.threadId, text: 'Later task', allowAssets: true })).status, 200);
  const later = f.signal, other = f.registry.issue();
  other.seal({ connectionId: 'foreign-connection', provider: 'codex', threadId: 'foreign-conversation', sessionId: null });
  other.grant({ connectionId: 'foreign-connection', threadId: 'foreign-conversation' });
  other.dispatched({ connectionId: 'foreign-connection', threadId: 'foreign-conversation', operationId: 'foreign-operation' });
  const foreign = nativeAssetOperationSignal(f.registry.capture(other.credential(), 'mutate'));
  await f.action('turn-interrupt', { threadId: f.current.state.thread!.threadId, turnId: f.current.state.thread!.turnId });
  assert.equal(later.aborted, true); assert.equal(job.signal.aborted, false); assert.equal(foreign.aborted, false);
  assert.equal(f.assets.jobs()[0]?.state, 'running');
  await f.action('revoke-assets', { threadId: f.current.state.thread!.threadId });
  assert.equal(job.signal.aborted, true); assert.equal(foreign.aborted, false); assert.equal((await f.settled(job.jobId)).state, 'cancelled');
});

for (const action of ['revoke-assets', 'revoke-writes', 'disconnect', 'disconnect-false']) test('explicit ' + action + ' stops older accepted workers of that incarnation after normal turn completion', async t => {
  const f = await fixture(t), job = await f.start(); f.completeTurn();
  assert.equal(job.signal.aborted, false);
  const fields = action === 'disconnect-false' ? { preserveAssetWork: false } : action === 'disconnect' ? {} : { threadId: f.current.state.thread!.threadId };
  assert.equal((await f.action(action === 'disconnect-false' ? 'disconnect' : action, fields)).status, 200);
  assert.equal(job.signal.aborted, true); assert.equal((await f.settled(job.jobId)).state, 'cancelled');
});

test('chat navigation retires old authority while its accepted worker survives and a new incarnation cannot stop it', async t => {
  const f = await fixture(t), job = await f.start(), oldToken = f.current.credential; f.completeTurn();
  assert.equal((await f.action('disconnect', { preserveAssetWork: true })).status, 200);
  assert.equal(job.signal.aborted, false); assert.equal(f.assets.jobs()[0]?.state, 'running');
  assert.equal(f.registry.recognizes(oldToken), false); assert.throws(() => f.registry.capture(oldToken, 'mutate'), { code: 'NATIVE_ASSET_AUTHORITY' });
  await f.action('connect'); await f.action('select', { model: 'fixture', effort: 'low' }); await f.action('thread-start');
  await f.action('turn-start', { threadId: f.current.state.thread!.threadId, text: 'A separate chat task', allowAssets: true });
  const newSignal = f.signal;
  assert.equal((await f.action('disconnect')).status, 200);
  assert.equal(newSignal.aborted, true); assert.equal(job.signal.aborted, false); assert.equal(f.assets.jobs()[0]?.state, 'running');
  // Explicit host-owned asset cancellation still works; no old task is replayed.
  assert.equal((await f.assets.cancel(job.jobId)).state, 'cancelled');
});

test('explicit disconnect can stop an accepted worker after unexpected native retirement without granting recovery authority', async t => {
  const f = await fixture(t), job = await f.start();
  f.current.hooks.retired(); f.current.state.connected = false; f.current.state.ready = false;
  assert.equal(job.signal.aborted, false); assert.equal(f.assets.jobs()[0]?.state, 'running');
  assert.throws(() => f.registry.capture(f.current.credential, 'mutate'), { code: 'NATIVE_ASSET_AUTHORITY' });
  assert.equal((await f.action('disconnect')).status, 200); assert.equal(job.signal.aborted, true);
  assert.equal((await f.settled(job.jobId)).state, 'cancelled');
});

test('completed synthetic artifacts remain unchanged when the owning task is later stopped', async t => {
  const f = await fixture(t), job = await f.start(); await writeFile(join(job.directory, 'finish-worker'), 'finish');
  const completed = await f.settled(job.jobId); assert.equal(completed.state, 'succeeded'); assert.equal(completed.manifestAvailable, true);
  const before = createHash('sha256').update(await readFile(join(job.directory, 'manifest.json'))).digest('hex');
  await f.action('turn-interrupt', { threadId: f.current.state.thread!.threadId, turnId: f.current.state.thread!.turnId });
  assert.equal(job.signal.aborted, true); assert.deepEqual(f.assets.jobs().find(found => found.jobId === job.jobId), completed);
  assert.equal(createHash('sha256').update(await readFile(join(job.directory, 'manifest.json'))).digest('hex'), before);
});

test('wrong caller, origin, connection, thread or turn cannot cancel accepted work', async t => {
  const f = await fixture(t), job = await f.start(), threadId = f.current.state.thread!.threadId, turnId = f.current.state.thread!.turnId;
  for (const [bearer, origin] of [[f.agent, f.origin], [f.current.credential, f.origin], [f.human, 'https://foreign.invalid'], [f.human, null]] as const)
    assert.ok([401, 403].includes((await f.action('turn-interrupt', { threadId, turnId }, bearer, origin)).status));
  for (const fields of [{ threadId, turnId, connectionId: randomUUID() }, { threadId: 'wrong-thread', turnId }, { threadId, turnId: 'wrong-turn' }])
    assert.equal((await f.action('turn-interrupt', fields)).status, 409);
  for (const action of ['revoke-assets', 'revoke-writes']) assert.equal((await f.action(action, { threadId: 'wrong-thread' })).status, 409);
  assert.equal(job.signal.aborted, false); assert.equal(f.assets.jobs()[0]?.state, 'running');
  assert.equal((await f.action('turn-interrupt', { threadId, turnId })).status, 200); assert.equal((await f.settled(job.jobId)).state, 'cancelled');
});

test('revocation before awaited service admission creates no worker, artifact directory or binding', async t => {
  const f = await fixture(t), actor = f.registry.capture(f.current.credential, 'mutate');
  const pending = f.host.startNative(actor, INPUT), refused = assert.rejects(pending, { code: 'NATIVE_ASSET_AUTHORITY' });
  // Invoke the real human service synchronously while start() is at its first
  // awaited flush; a loopback round trip would not control this ordering.
  const stopped = await f.codex.action({ requestId: randomUUID(), connectionId: f.current.state.connectionId,
    action: 'revoke-assets', threadId: f.current.state.thread!.threadId });
  assert.equal(stopped.record.state, 'acknowledged'); await refused;
  assert.equal(f.workers.size, 0); assert.deepEqual(f.assets.jobs(), []);
  assert.deepEqual(f.associations.list({ provider: 'codex', threadId: f.current.state.thread!.threadId, sessionId: null }, 'asset-job').items, []);
});

test('serialized actors and read captures cannot obtain a worker stop signal', async t => {
  const f = await fixture(t), actor = f.registry.capture(f.current.credential, 'mutate');
  for (const forged of [{ ...actor }, JSON.parse(JSON.stringify(actor)), f.registry.capture(f.current.credential, 'read')])
    assert.throws(() => nativeAssetOperationSignal(forged), { code: 'NATIVE_ASSET_AUTHORITY' });
  const response = await f.call('/v1/assets/native/start', { ...INPUT, signal: { aborted: false } }, f.current.credential, null);
  assert.equal(response.status, 400); assert.equal(f.workers.size, 0);
  for (const preserveAssetWork of ['true', 1, {}, null]) assert.equal((await f.action('disconnect', { preserveAssetWork })).status, 400);
  assert.equal((await f.action('turn-start', { threadId: f.current.state.thread!.threadId, text: 'Wrong envelope', preserveAssetWork: true })).status, 400);
  assert.equal(f.codex.state().snapshot?.connected, true);
});

test('valid human revocation stops accepted workers even when native approval cleanup retires and throws', async t => {
  const f = await fixture(t), job = await f.start(); f.failRevoke();
  const reply = await f.action('revoke-writes', { threadId: f.current.state.thread!.threadId });
  assert.equal(reply.status, 409); assert.equal(job.signal.aborted, true);
  assert.equal((reply.data.record as { errorCode: string }).errorCode, 'APPROVAL_UNKNOWN');
  assert.equal((await f.settled(job.jobId)).state, 'cancelled');
});

test('saturated admission epochs cannot strand an already accepted controlled worker', async t => {
  const f = await fixture(t), incarnation = f.registry.issue();
  const binding = { connectionId: 'saturated-connection', threadId: 'saturated-thread' };
  incarnation.seal({ ...binding, provider: 'codex', sessionId: null }); incarnation.grant(binding);
  incarnation.dispatched({ ...binding, operationId: 'saturated-operation' });
  const actor = f.registry.capture(incarnation.credential(), 'mutate'), signal = nativeAssetOperationSignal(actor);
  const started = await f.host.startNative(actor, INPUT); assert.ok(started.jobId);
  await until(() => f.workers.get(started.jobId!)?.ready === true);
  for (let epoch = 3; epoch < 65535; epoch++) incarnation.grant(binding);
  incarnation.cancelWork('active-operation');
  assert.equal(signal.aborted, true); assert.equal(incarnation.status().retired, true);
  assert.equal((await f.settled(started.jobId)).state, 'cancelled');
});

test('real accepted worker and input listener keep a closed transport leased through their actual completion',async t=>{
  const f=await fixture(t),incarnation=f.registry.issue(),binding={connectionId:'leased-owned-connection',threadId:'leased-owned-thread'};
  incarnation.seal({...binding,provider:'codex',sessionId:null});incarnation.grantNextIntent({...binding,sessionId:null});
  incarnation.dispatched({...binding,operationId:'leased-owned-operation'});
  const token=incarnation.credential(),actor=f.registry.capture(token,'mutate'),signal=nativeAssetOperationSignal(actor);
  const reply=await f.host.startNative(actor,INPUT);assert.ok(reply.jobId);const jobId=reply.jobId;
  await until(()=>f.workers.get(jobId)?.ready===true);
  incarnation.ended('leased-owned-operation');incarnation.retire();incarnation.transportClosed();
  assert.equal(incarnation.status().released,false);assert.equal(signal.aborted,false);assert.equal(f.workers.get(jobId)?.exited,false);
  assert.equal(f.registry.recognizes(token),false);assert.throws(()=>f.registry.capture(token,'read'),{code:'NATIVE_ASSET_AUTHORITY'});
  await writeFile(join(f.workers.get(jobId)!.directory,'finish-worker'),'finish');
  assert.equal((await f.settled(jobId)).state,'succeeded');await until(()=>incarnation.status().released);
  assert.equal(f.workers.get(jobId)?.exited,true);assert.equal(signal.aborted,false);
  assert.deepEqual(f.associations.binding('asset-job',jobId)?.conversation,{provider:'codex',threadId:binding.threadId,sessionId:null});
});

test('real service releases a synchronously refused pipeline start before any worker exists',async t=>{
  const f=await fixture(t),incarnation=f.registry.issue(),binding={connectionId:'no-allocation-connection',threadId:'no-allocation-thread'};
  incarnation.seal({...binding,provider:'codex',sessionId:null});incarnation.grant(binding);incarnation.dispatched({...binding,operationId:'no-allocation-operation'});
  const actor=f.registry.capture(incarnation.credential(),'mutate');let starts=0;
  t.mock.method(AssetPipeline.prototype,'start',()=>{starts++;throw new AssetError('BUSY','Controlled refusal before allocation.');});
  const response=await f.host.startNative(actor,INPUT);
  assert.equal(response.creation,'unknown');assert.equal(response.jobId,null);assert.equal(response.retry,false);
  assert.equal(starts,1);assert.equal(f.workers.size,0);assert.deepEqual(f.assets.jobs(),[]);
  incarnation.retire();incarnation.transportClosed();assert.equal(incarnation.status().released,true);
});
test('real service retains unresolved pipeline ownership even after its actual completion promise settles',async t=>{
  const f=await fixture(t),incarnation=f.registry.issue(),binding={connectionId:'unresolved-connection',threadId:'unresolved-thread'};
  incarnation.seal({...binding,provider:'codex',sessionId:null});incarnation.grant(binding);incarnation.dispatched({...binding,operationId:'unresolved-operation'});
  t.mock.method(AssetPipeline.prototype as unknown as {generate:Generate},'generate',async(jobId:string,directory:string,request:AssetRequest)=>{
    await mkdir(directory);const result:AssetJobResult={jobId,directory,state:'interrupted',manifestPath:null,
      error:{code:'SUPERVISION_UNRESOLVED',message:'Synthetic unconfirmed worker closure; no native worker launched.'}};
    await writeFile(join(directory,'job.json'),JSON.stringify({schemaVersion:1,...result,request,startedAt:new Date().toISOString()}));return result;
  });
  const response=await f.host.startNative(f.registry.capture(incarnation.credential(),'mutate'),INPUT);assert.ok(response.jobId);
  const result=await f.settled(response.jobId);assert.equal(result.state,'interrupted');assert.equal(result.error?.code,'SUPERVISION_UNRESOLVED');
  await f.assets.cancel(response.jobId);incarnation.retire();incarnation.transportClosed();
  assert.equal(incarnation.status().released,false,'A settled promise and Stop request do not confirm missing worker closure.');
  assert.equal(f.workers.size,0);assert.equal(f.associations.binding('asset-job',response.jobId)?.conversation.threadId,binding.threadId);
});
