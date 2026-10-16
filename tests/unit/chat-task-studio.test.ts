import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import {mkdirSync} from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, CallToolResultSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createConnectionLab } from '../../apps/daemon/src/lab-server.js';
import { refuseNativeCodex, noProviderProbe } from './native-fixture-refusal.js';
import { createAssetService } from '../../apps/daemon/src/asset-service.js';
import { studioImportPluginArtifactHash } from '../../apps/daemon/src/studio-import-plugin-artifact.js';
import type { NativeTestConnection, StudioTestView } from '../../apps/daemon/src/studio-test-service.js';
import { createMcpServer } from '../../apps/mcp/src/server.js';
import { DaemonClient } from '../../apps/mcp/src/daemon-client.js';
import { playtestJob } from '../../apps/mcp/src/playtest-schemas.js';
import { StudioStore } from '../../packages/storage/src/studio-store.js';
import { WorkStore } from '../../packages/storage/src/work-store.js';
import { CodexSession } from '../../packages/codex-client/src/session.js';
import { nativeEnvironment } from '../../packages/codex-client/src/transport.js';
import { limits } from '../../packages/codex-client/src/validation.js';
import { ARCANE_NATIVE_TOOL_NAMES } from '../../packages/protocol/src/arcane-tools.js';
import { READ_METHODS, WRITE_METHODS } from '../../packages/protocol/src/studio.js';
import { digest, readTestLedger, reviewedTestTools } from '../../packages/studio-test-controller/src/index.js';
import { buildScenarioProgram } from '../../packages/studio-test-controller/src/scenario-runtime.js';
import { fixtureScenario, runScenarioFixture } from '../../packages/studio-test-controller/testing/scenario-fixture.js';
import { fixtureTempDirectory, makeFixtureDirectory } from './windows-fixture-paths.js';

const THREAD = 'joint.fixture.thread', SESSION = 'joint.fixture.session', STUDIO = 'joint-fixture-studio', NAME = 'Joint task fixture';
// This labelled Node peer exercises the real Codex protocol/client. Gameplay,
// plugin heartbeats and engine objects are synthetic; no native provider or
// Studio executable is launched. Actual terminal packets come from the owned
// service/controller/SDK/SQLite/ledger and the fixed standalone Luau program.
const PEER = String.raw`
const{createInterface}=require('node:readline'),{appendFileSync,existsSync}=require('node:fs');
const c=JSON.parse(process.argv[1]);let turns=0;const send=v=>process.stdout.write(JSON.stringify(v)+'\n');
createInterface({input:process.stdin}).on('line',line=>{const{id,method,params={}}=JSON.parse(line);if(!method||method==='initialized')return;
appendFileSync(c.audit,JSON.stringify({method,params})+'\n');const reply=result=>send({id,result});
if(method==='initialize')return reply({});
if(method==='account/read')return reply({account:{type:'chatgpt',email:'joint@example.invalid',planType:'plus'},requiresOpenaiAuth:true});
if(method==='model/list')return reply({data:[{id:'fixture',model:'fixture',displayName:'Fixture',supportedReasoningEfforts:[{reasoningEffort:'low'}]}],nextCursor:null});
if(method==='thread/start'||method==='thread/resume')return reply({thread:{id:c.thread,sessionId:c.session,turns:[],status:{type:'idle'}},model:params.model,modelProvider:'openai',cwd:process.cwd(),approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:{type:'readOnly',networkAccess:false}});
if(method==='mcpServerStatus/list')return reply({data:[{name:'arcane',runtimeStatus:'connected',toolsError:null,pluginId:null,tools:Object.fromEntries(c.tools.map(name=>[name,{}]))}],nextCursor:null});
if(method==='turn/start'){turns++;const turn={id:'joint.turn:'+turns,status:'inProgress'};reply({turn});const timer=setInterval(()=>{if(existsSync(c.gate+'-'+turns)){clearInterval(timer);send({method:'turn/completed',params:{threadId:c.thread,turn:{...turn,status:'completed'}}});}},5);return;}
if(method==='turn/interrupt')return reply({});throw Error('Unexpected fixture method '+method);
});
`;
const text = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] });
async function until(check: () => boolean | Promise<boolean>) {
  const end = Date.now() + 15000;
  while (!await check()) { assert.ok(Date.now() < end, 'Expected joint task state before its deadline.'); await delay(10); }
}
async function fixture(t: TestContext, holdClose = false) {
  const root = makeFixtureDirectory('arcane-chat-studio-'), project = join(root, 'project'), directory = join(root, 'lab');
  let store:StudioStore|undefined,work:WorkStore|undefined,assets:Awaited<ReturnType<typeof createAssetService>>|undefined;
  let creatingAssets:Promise<Awaited<ReturnType<typeof createAssetService>>>|undefined;
  let lab:Awaited<ReturnType<typeof createConnectionLab>>|undefined,creatingLab:Promise<Awaited<ReturnType<typeof createConnectionLab>>>|undefined;
  let timer:ReturnType<typeof setInterval>|undefined,heartbeatFailure:unknown,closing:Promise<void>|undefined;
  let releaseClose!: () => void; const closeGate = new Promise<void>(resolve => { releaseClose = resolve; });
  const tokens: string[] = [], providers: CodexSession[] = [], connections: NativeTestConnection[] = [],requests=new AbortController();
  const agent = new Client({ name: 'joint-agent-fixture', version: 'fixture' });
  let mcp: ReturnType<typeof createMcpServer> | null = null;
  const close=():Promise<void>=>{
    releaseClose();requests.abort();
    if(closing)return closing;
    closing=(async()=>{
      const errors:unknown[]=[];
      if(!assets&&creatingAssets){try{assets=await creatingAssets;}catch{/* Preserve the original initialization error. */}}
      if(!lab&&creatingLab){try{lab=await creatingLab;}catch{/* Preserve the original initialization error. */}}
      for(const dispose of [()=>agent.close(),()=>mcp?.close(),()=>lab?.close()]){
        try{await dispose();}catch(error){errors.push(error);}
      }
      clearInterval(timer);
      for(const dispose of [...providers.map(provider=>()=>provider.close()),...connections.map(connection=>()=>connection.close()),()=>assets?.close(),()=>work?.close(),()=>store?.close()]){
        try{await dispose();}catch(error){errors.push(error);}
      }
      t.signal.removeEventListener('abort',cancel);
      if(errors.length){t.diagnostic('Retained joint fixture after uncertain cleanup: '+root);throw new AggregateError(errors,'Joint fixture cleanup failed.');}
      const part=relative(fixtureTempDirectory(),root);assert.ok(part.startsWith('arcane-chat-studio-')&&!isAbsolute(part)&&!part.includes(sep));
      await rm(root,{recursive:true,force:true});assert.equal(heartbeatFailure,undefined);
    })();void closing.catch(()=>{});return closing;
  };
  const cancel=()=>{void close();};t.after(close);t.signal.addEventListener('abort',cancel,{once:true});t.signal.throwIfAborted();
  mkdirSync(project);t.signal.throwIfAborted();
  const studio=store=new StudioStore({directory:join(root,'studio')}),workStore=work=new WorkStore({directory:join(root,'work'),projectPath:project});
  creatingAssets=createAssetService({ cwd: process.cwd(), projectPath: project, outputRoot: join(root, 'assets') });assets=await creatingAssets;t.signal.throwIfAborted();
  const artifact = await studioImportPluginArtifactHash(process.cwd());t.signal.throwIfAborted();
  const grant = studio.createGrant({ allowedRoots: ['Workspace', 'ServerStorage'], allowWrites: true });
  const pair = store.pair({ code: grant.code, protocolVersion: 1, identity: { clientSessionId: 'joint-plugin-lifetime', placeId: 0, universeId: 0, name: NAME, pluginVersion: 'fixture' }, capabilities: [...READ_METHODS, ...WRITE_METHODS] });
  const state = { mode: 'Edit' as 'Edit' | 'Play', epoch: 10, immobile: true, source: 'print("original fixture")', inputCalls: 0, starts: 0, stops: 0, closes: 0, closeEntered: false };
  const plan = fixtureScenario(); plan.capture.required = false;
  const publish = () => { studio.authenticate(pair.sessionId, pair.token); return studio.poll(pair.sessionId, {
    sessionId: pair.sessionId, clientLifetimeId: 'joint-plugin-lifetime', pluginArtifactHash: artifact, markerName: 'ArcaneTestProof_joint_fixture',
    placeId: 0, universeId: 0, placeName: NAME, mode: state.mode, playEpoch: state.epoch, continuitySupported: true, connected: true,
  }); };
  publish();
  timer = setInterval(() => { try { assert.deepEqual(publish(), []); } catch (error) { heartbeatFailure = error; } }, 20);
  const connectStudio = async (): Promise<NativeTestConnection> => {
    const client = new Client({ name: 'joint-studio-fixture', version: 'fixture' }), server = new Server({ name: 'synthetic-native-peer', version: 'fixture' }, { capabilities: { tools: {} } });
    const [left, right] = InMemoryTransport.createLinkedPair();
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [...structuredClone(reviewedTestTools), {
      name: 'execute_luau', inputSchema: { type: 'object', properties: { studio_id: { type: 'string' }, datamodel_type: { type: 'string', enum: ['Edit', 'Client', 'Server'] }, code: { type: 'string' } }, required: ['studio_id', 'datamodel_type', 'code'] } },
    ] }));
    server.setRequestHandler(CallToolRequestSchema, async request => {
      const { name, arguments: args = {} } = request.params;
      if (name === 'list_roblox_studios') return text({ studios: [{ id: STUDIO, name: NAME }] });
      assert.equal(args.studio_id, STUDIO);
      if (name === 'get_studio_state') return text(state.mode === 'Edit'
        ? '- Current Studio Mode: Edit\n- Available DataModels: Edit\n- Focused DataModel in the viewport: Edit'
        : '- Current Studio Mode: Play\n- Available DataModels: Client, Server\n- Focused DataModel in the viewport: Client');
      if (name === 'get_console_output') return text('');
      if (name === 'start_stop_play') {
        state.mode = args.is_start ? 'Play' : 'Edit'; state.epoch++; if (args.is_start) state.starts++; else state.stops++;
        assert.deepEqual(publish(), []); return text('Synthetic owned ACK');
      }
      assert.equal(name, 'execute_luau');
      if (args.datamodel_type === 'Edit') {
        assert.ok(String(args.code).includes('ScriptEditorService'));
        return text({ schemaVersion: 1, sessionId: pair.sessionId, clientLifetimeId: 'joint-plugin-lifetime', pluginArtifactHash: artifact,
          nodes: 4, sourceCount: 1, sources: { s1: { root: 'Workspace', path: ['GameScript'], identity: 'original-edit-script', className: 'Script', enabled: true, source: state.source, editorSource: state.source } } });
      }
      assert.equal(args.datamodel_type, 'Client');
      const rows = await readTestLedger(join(directory, 'playtests', 'ledger'), join(directory, 'playtests')), event = rows.at(-1)!.event;
      assert.equal(event.kind, 'scenario_intent'); assert.equal(args.code, buildScenarioProgram(plan, event.id, digest(plan)));
      state.inputCalls++; return text(runScenarioFixture(plan, { immobile: state.immobile }, event.id, String(args.code)).report);
    });
    await server.connect(right); await client.connect(left); let closed = false; const index = connections.length;
    const connection: NativeTestConnection = { client, evidence: 'fixture', async witness(id, marker, mode, signal) {
      assert.equal(id, STUDIO); assert.equal(marker, 'ArcaneTestProof_joint_fixture'); assert.equal(mode, state.mode); assert.equal(signal.aborted, false);
      return { placeId: 0, universeId: 0, placeName: NAME, sessionId: pair.sessionId, clientLifetimeId: 'joint-plugin-lifetime', pluginArtifactHash: artifact };
    }, async close() { if (closed) return; closed = true; state.closes++;
      if (holdClose && index === 0) { state.closeEntered = true; await closeGate; }
      try { await client.close(); } finally { await server.close(); } } };
    connections.push(connection); return connection;
  };
  const audit = join(root, 'provider-wire.jsonl');
  creatingLab = createConnectionLab({ cwd: process.cwd(), stateDirectory: directory, projectPath: project, studioStore: studio, workStore, assetService: assets,
    studioTestConnect: connectStudio, codexConnect: async hooks => {
      assert.ok(hooks); tokens.push(hooks.finalCredential());
      const client = new CodexSession({ command: process.execPath, args: ['-e', PEER, JSON.stringify({ thread: THREAD, session: SESSION, audit, gate: join(root, 'finished'), tools: ARCANE_NATIVE_TOOL_NAMES })], cwd: project, env: nativeEnvironment() },
        limits({ requestTimeoutMs: 2000 }), 'spawned-node-fixture', 'arcane-only', hooks);
      providers.push(client); await client.initialize(); return client;
    } });
  const ownedLab=lab=await creatingLab;if(t.signal.aborted){await close();t.signal.throwIfAborted();}
  const post = async (path: string, body: unknown, bearer = ownedLab.token) => {
    const response = await fetch(ownedLab.origin + path, { method: 'POST', headers: { Authorization: 'Bearer ' + bearer, Origin: ownedLab.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.any([t.signal,requests.signal,AbortSignal.timeout(15000)]) });
    const value = await response.json() as { record?: { state: string }; state?: { chatTasks?: { taskId: string; state: string; round: number }[] }; job?: StudioTestView };
    assert.equal(response.status, 200, JSON.stringify(value)); return value;
  };
  const action = async (name: string, fields: Record<string, unknown> = {}) => post('/v1/codex/action', {
    requestId: randomUUID(), connectionId: name === 'connect' ? null : providers.at(-1)!.snapshot().connectionId, action: name, ...fields,
  });
  const status = async (id: string) => {
    const result = CallToolResultSchema.parse(await agent.callTool({ name: 'playtest_status', arguments: { jobId: id } }));
    assert.notEqual(result.isError, true); return playtestJob.parse((result.structuredContent as { job: unknown }).job);
  };
  const task = async () => {
    const response = await fetch(ownedLab.origin + '/v1/codex/state', { headers: { Authorization: 'Bearer ' + ownedLab.token }, signal: AbortSignal.any([t.signal,requests.signal,AbortSignal.timeout(5000)]) });
    assert.equal(response.status, 200); return ((await response.json()) as { state: { chatTasks: { taskId: string; state: string; round: number; reportDigest: string | null }[] } }).state.chatTasks.at(-1)!;
  };
  const ready = async () => {
    for (const [name, fields] of [['connect', {}], ['select', { model: 'fixture', effort: 'low' }], ['thread-start', {}]] as const) assert.equal((await action(name, fields)).record!.state, 'acknowledged');
    assert.equal((await action('turn-start', { threadId: THREAD, text: 'Build and verify this synthetic local task.', allowWorkspaceWrites: true, allowAssets: true })).record!.state, 'acknowledged');
    mcp = createMcpServer({ client: new DaemonClient({ url: ownedLab.origin, token: tokens[0]!, assetAudience: 'native-session' }), projectRoot: project });
    const [left, right] = InMemoryTransport.createLinkedPair(); await mcp.connect(right); await agent.connect(left);
  };
  const prepare = async () => {
    const result = CallToolResultSchema.parse(await agent.callTool({ name: 'playtest_request', arguments: { sessionId: pair.sessionId, nativeStudioId: STUDIO, durationMs: 5000, observationIntervalMs: 250, failOnRuntimeError: true, scenario: plan } }));
    assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent)); return playtestJob.parse((result.structuredContent as { job: unknown }).job);
  };
  return { lab:ownedLab, state, providers, ready, prepare, status, task, action, releaseClose, approve: (job: Pick<StudioTestView,'id'|'displayDigest'>) => post('/v1/playtests/approve', { id: job.id, displayDigest: job.displayDigest }),
    finish: (turn: number) => writeFile(join(root, 'finished-' + turn), 'Synthetic terminal', { flag: 'wx' }),
    wire: async () => (await readFile(audit, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { method: string; params: Record<string, unknown> }) };
}

test('production lab routes measured scenario failure into one original-client repair and bounded reverify', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.ready(); const first = await f.prepare(); await f.approve(first);
  await until(async () => (await f.status(first.id)).review.phase === 'done'); const failed = await f.status(first.id);
  assert.equal(failed.review.outcome, 'failed'); assert.equal(failed.review.code, 'ASSERTION_FAILED'); assert.equal(failed.review.cleanup, 'complete');
  assert.equal(failed.review.scenario!.inputRelease, 'observed_released'); assert.equal((await f.task()).round, 0);
  await until(async () => (await f.task()).reportDigest!==null);
  const failedDigest=(await f.task()).reportDigest; assert.ok(failedDigest);
  assert.equal((await f.wire()).filter(row => row.method === 'turn/start').length, 1);
  await f.finish(1); await until(async () => (await f.task()).round === 1 && f.providers[0]!.snapshot().operations.filter(op => op.method === 'turn/start' && op.state === 'acknowledged').length === 2);
  assert.equal(f.providers.length, 1); f.state.immobile = false; f.state.source = 'print("repaired fixture")';
  const second = await f.prepare(); assert.notEqual(first.display.proposal.subjectDigest, second.display.proposal.subjectDigest);
  assert.deepEqual(first.display.proposal.scenario, second.display.proposal.scenario); await f.approve(second);
  await until(async () => (await f.status(second.id)).review.phase === 'done'); const passed = await f.status(second.id);
  assert.equal(passed.review.outcome, 'succeeded'); assert.equal(passed.review.cleanup, 'complete'); assert.equal(passed.evidence, 'fixture'); assert.equal(passed.nativeAcceptance, false);
  await f.finish(2); await until(async () => (await f.task()).state === 'verified');
  assert.equal(f.state.inputCalls, 2); assert.equal(f.state.starts, 2); assert.equal(f.state.stops, 2); assert.equal(f.state.mode, 'Edit');
  const turns = (await f.wire()).filter(row => row.method === 'turn/start'); assert.equal(turns.length, 2);
  for (const row of turns) { assert.equal(row.params.threadId, THREAD); assert.equal(row.params.model, 'fixture'); assert.equal(row.params.effort, 'low'); assert.equal(row.params.initiatedBy, undefined); }
  const repairInput=turns[1]!.params.input as {type:string;text:string}[];
  assert.equal(repairInput.length,1); assert.equal(repairInput[0]!.type,'text');
  assert.ok(repairInput[0]!.text.includes(first.id)); assert.ok(repairInput[0]!.text.includes(failedDigest));
  assert.ok((await f.task()).reportDigest);
});

test('a changed source after measured failure pauses the task before any automatic repair', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.ready(); const job = await f.prepare(); await f.approve(job);
  await until(async () => (await f.status(job.id)).review.phase === 'done');
  const failed = await f.status(job.id); assert.equal(failed.review.code, 'ASSERTION_FAILED'); assert.equal(failed.review.cleanup, 'complete');
  f.state.source = 'print("separate human edit after test")'; await f.finish(1);
  await until(async () => (await f.task()).state === 'paused');
  assert.equal((await f.task()).round, 0); assert.equal((await f.wire()).filter(row => row.method === 'turn/start').length, 1);
  assert.equal(f.state.starts, 1); assert.equal(f.state.stops, 1); assert.equal(f.state.inputCalls, 1); assert.equal(f.state.mode, 'Edit');
});

test('a Studio metadata lab initializes its owned services without a managed asset registry', { timeout: 15000 }, async t => {
  const root = makeFixtureDirectory('arcane-chat-studio-'), store = new StudioStore({directory:join(root,'studio')});
  let lab: Awaited<ReturnType<typeof createConnectionLab>> | undefined;
  t.after(async () => {
    try { await lab?.close(); } finally { store.close();
      const part=relative(fixtureTempDirectory(),root); assert.ok(part.startsWith('arcane-chat-studio-')&&!isAbsolute(part)&&!part.includes(sep));
      await rm(root,{recursive:true,force:true}); }
  });
  lab=await createConnectionLab({cwd:process.cwd(),stateDirectory:join(root,'lab'),studioStore:store,codexConnect:refuseNativeCodex,probe:noProviderProbe});
  const response=await fetch(lab.origin+'/v1/codex/state',{headers:{Authorization:'Bearer '+lab.token},signal:AbortSignal.timeout(5000)});
  assert.equal(response.status,200);
  const body=await response.json() as {state:{chatTasks?:unknown[]}}; assert.equal(body.state.chatTasks,undefined);
});

test('lab shutdown fences task admission before owned playtest teardown can request a repair', { timeout: 20000 }, async t => {
  const f = await fixture(t, true); await f.ready(); await f.finish(1);
  await until(() => f.providers[0]!.snapshot().thread!.turnStatus === 'completed');
  const pending = await f.prepare(); await f.approve(pending); await until(() => f.state.closeEntered);
  const measured = await f.status(pending.id); assert.equal(measured.review.outcome, 'failed'); assert.equal(measured.review.cleanup, 'complete');
  const before = await f.wire(), closing = f.lab.close(); await delay(20); f.releaseClose(); await closing;
  assert.equal(f.providers[0]!.snapshot().connected, false); assert.equal(f.state.starts, 1); assert.equal(f.state.stops, 1); assert.equal(f.state.inputCalls, 1);
  assert.deepEqual(await f.wire(), before, 'No provider preflight or repair may start during daemon teardown.');
});
