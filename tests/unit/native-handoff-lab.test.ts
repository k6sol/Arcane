import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createConnectionLab } from '../../apps/daemon/src/lab-server.js';
import { createAssetService } from '../../apps/daemon/src/asset-service.js';
import { createMcpServer } from '../../apps/mcp/src/server.js';
import { DaemonClient } from '../../apps/mcp/src/daemon-client.js';
import { StudioStore } from '../../packages/storage/src/studio-store.js';
import { WorkStore } from '../../packages/storage/src/work-store.js';
import { CodexSession } from '../../packages/codex-client/src/session.js';
import { nativeEnvironment } from '../../packages/codex-client/src/transport.js';
import { limits } from '../../packages/codex-client/src/validation.js';
import { ARCANE_NATIVE_TOOL_NAMES } from '../../packages/protocol/src/arcane-tools.js';
import type { ChatTaskProposalFactory } from '../../apps/daemon/src/chat-task-coordinator.js';

// The actual createConnectionLab with real StudioStore/WorkStore/AssetService, MCP SDK + DaemonClient, and an OWNED
// scripted CodexSession peer for existing-native compatibility. No installed CLI, provider inference, Studio operation,
// asset job or launch. A sealed handoff is a human-host acknowledgement, not proof that any native client connected.
const THREAD = 'handoff.lab.thread', SESSION = 'handoff.lab.session';
const PEER = String.raw`
const{createInterface}=require('node:readline'),{appendFileSync,existsSync}=require('node:fs');
const c=JSON.parse(process.argv[1]);let turns=0;const send=v=>process.stdout.write(JSON.stringify(v)+'\n');
createInterface({input:process.stdin}).on('line',line=>{const{id,method,params={}}=JSON.parse(line);if(!method||method==='initialized')return;
appendFileSync(c.audit,JSON.stringify({method,text:method==='turn/start'?params.input?.[0]?.text:undefined})+'\n');const reply=result=>send({id,result});
if(method==='initialize')return reply({});
if(method==='account/read')return reply({account:{type:'chatgpt',email:'handoff@example.invalid',planType:'plus'},requiresOpenaiAuth:true});
if(method==='model/list')return reply({data:[{id:'fixture',model:'fixture',displayName:'Fixture',supportedReasoningEfforts:[{reasoningEffort:'low'}]}],nextCursor:null});
if(method==='thread/start'||method==='thread/resume')return reply({thread:{id:c.thread,sessionId:c.session,turns:[],status:{type:'idle'}},model:params.model,modelProvider:'openai',cwd:process.cwd(),approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:{type:'readOnly',networkAccess:false}});
if(method==='mcpServerStatus/list')return reply({data:[{name:'arcane',runtimeStatus:'connected',toolsError:null,pluginId:null,tools:Object.fromEntries(c.tools.map(name=>[name,{}]))}],nextCursor:null});
if(method==='turn/start'){turns++;const turn={id:'handoff.turn:'+turns,status:'inProgress'};reply({turn});
 const timer=setInterval(()=>{if(existsSync(c.gate+'-'+turns)){clearInterval(timer);send({method:'turn/completed',params:{threadId:c.thread,turn:{...turn,status:'completed'}}});}},5);return;}
if(method==='turn/interrupt')return reply({});throw Error('Unexpected fixture method '+method);
});`;
const unhandled: unknown[] = []; process.on('unhandledRejection', error => { unhandled.push(error); });
async function until(check: () => boolean | Promise<boolean>, what: string, ms = 20000) { const end = Date.now() + ms; while (!await check()) { assert.ok(Date.now() < end, 'Expected ' + what); await delay(10); } }
type Reply = { status: number; body: Record<string, any>; text: string };

async function fixture(t: TestContext) {
  const base = await realpath(tmpdir()), root = await realpath(await mkdtemp(join(base, 'arcane-handoff-lab-'))), project = join(root, 'project'), audit = join(root, 'wire.jsonl'), gate = join(root, 'finished');
  await mkdir(join(project, 'reports'), { recursive: true });
  const studio = new StudioStore({ directory: join(root, 'studio') }), work = new WorkStore({ directory: join(root, 'work'), projectPath: project });
  const assets = await createAssetService({ cwd: process.cwd(), projectPath: project, outputRoot: join(root, 'assets') });
  const tokens: string[] = [], providers: CodexSession[] = [], agents: Client[] = [], servers: { close(): Promise<void> }[] = [];
  const proposalWorker: ChatTaskProposalFactory = async () => ({
    propose: async () => ({ threadId: 'worker.thread', sessionId: null, turnId: 'worker.turn:' + randomUUID(), text: 'Suggestion: keep the change bounded.' }), close: async () => {} });
  const lab = await createConnectionLab({ cwd: process.cwd(), stateDirectory: join(root, 'lab'), projectPath: project, studioStore: studio, workStore: work, assetService: assets,
    codexProposalWorker: proposalWorker, codexAutomaticTaskPlanning: true,
    codexConnect: async hooks => {
      assert.ok(hooks); tokens.push(hooks.finalCredential());
      const client = new CodexSession({ command: process.execPath, args: ['-e', PEER, JSON.stringify({ thread: THREAD, session: SESSION, audit, gate, tools: ARCANE_NATIVE_TOOL_NAMES })], cwd: project, env: nativeEnvironment() },
        limits({ requestTimeoutMs: 2000 }), 'spawned-node-fixture', 'arcane-only', hooks);
      providers.push(client); await client.initialize(); return client;
    } });
  let closed = false;
  const closeLab = async () => { if (closed) return; closed = true; await lab.close(); };
  t.after(async () => {
    for (let turn = 1; turn <= 4; turn++) if (!existsSync(gate + '-' + turn)) try { await writeFile(gate + '-' + turn, 'done'); } catch { /* cleanup */ }
    for (const close of [...agents.map(a => () => a.close()), ...servers.map(s => () => s.close()), closeLab, ...providers.map(p => () => p.close()), () => assets.close(), () => { work.close(); }, () => { studio.close(); }])
      try { await close(); } catch { /* best-effort owned cleanup */ }
    const part = relative(base, root); assert.ok(part.startsWith('arcane-handoff-lab-') && !isAbsolute(part) && !part.includes(sep)); await rm(root, { recursive: true, force: true });
  });
  const call = async (token: string | null, path: string, body?: unknown, origin = body !== undefined): Promise<Reply> => {
    const response = await fetch(lab.origin + path, { method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(15000),
      headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(origin ? { Origin: lab.origin } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text(); let parsed: Record<string, any> = {}; try { parsed = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: response.status, body: parsed, text };
  };
  const human = (path: string, body?: unknown) => call(lab.token, path, body);
  const projectId = async () => (await human('/v1/native-handoffs')).body.projectId as string;
  const begin = async (requestId = randomUUID()) => human('/v1/native-handoffs/begin', { requestId, projectId: await projectId() });
  const seal = async (handoffId: string) => human('/v1/native-handoffs/seal', { handoffId, projectId: await projectId() });
  const revoke = async (handoffId: string) => human('/v1/native-handoffs/revoke', { handoffId, projectId: await projectId() });
  const sealed = async () => {
    const started = await begin(); assert.equal(started.status, 200, started.text);
    assert.equal((await seal(started.body.handoff.handoffId)).status, 200);
    return { handoffId: started.body.handoff.handoffId as string, credential: started.body.credential as string };
  };
  const mcpAgent = async (token: string, assetAudience?: 'native-session') => {
    const server = createMcpServer({ client: new DaemonClient({ url: lab.origin, token, ...(assetAudience ? { assetAudience } : {}) }), projectRoot: project }), agent = new Client({ name: 'handoff-lab-fixture', version: 'fixture' });
    const [left, right] = InMemoryTransport.createLinkedPair(); await server.connect(right); await agent.connect(left); servers.push(server); agents.push(agent);
    return async (name: string, args: Record<string, unknown>) => CallToolResultSchema.parse(await agent.callTool({ name, arguments: args }));
  };
  const action = async (name: string, fields: Record<string, unknown> = {}) => human('/v1/codex/action', { requestId: randomUUID(), connectionId: name === 'connect' ? null : providers.at(-1)!.snapshot().connectionId, action: name, ...fields });
  const turnStarts = async () => existsSync(audit) ? (await readFile(audit, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { method: string; text?: string }).filter(row => row.method === 'turn/start') : [];
  /** Human Send driving the genuine plan to its held final parent turn, which names its host-bound review run. */
  const boundPlan = async () => {
    for (const [name, fields] of [['connect', {}], ['select', { model: 'fixture', effort: 'low' }], ['thread-start', {}]] as const) assert.equal((await action(name, fields)).body.record.state, 'acknowledged', name);
    assert.equal((await action('turn-start', { threadId: THREAD, text: 'Build a small door that opens and verify it.', allowWorkspaceWrites: true, allowAssets: true })).body.record.state, 'acknowledged');
    await until(async () => (await turnStarts()).length === 1, 'the original turn'); await writeFile(gate + '-1', 'done');
    await until(async () => (await turnStarts()).length === 2, 'round 1 parent incorporation'); await writeFile(gate + '-2', 'done');
    await until(async () => (await turnStarts()).length === 3, 'the final parent turn');
    const match = /bound review run ([0-9a-f-]{36})/.exec((await turnStarts())[2]!.text ?? ''); assert.ok(match); const runId = match![1]!;
    assert.ok(work.bindingForRun(runId));
    return { runId, credential: tokens[0]!, finishFinal: () => writeFile(gate + '-3', 'done') };
  };
  const heldClaim = (credential: string, taskId: string, during: () => Promise<void>) => new Promise<{ status: number | null; error: string | null }>(resolve => {
    const body = JSON.stringify({ taskId, worker: 'held' }), url = new URL('/v1/work/claim', lab.origin);
    const req = httpRequest(url, { method: 'POST', headers: { Authorization: 'Bearer ' + credential, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, response => {
      let text = ''; response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; });
      response.on('end', () => { let error: string | null = null; try { error = JSON.parse(text).error ?? null; } catch { /* closed */ } resolve({ status: response.statusCode ?? null, error }); });
    });
    req.on('error', () => resolve({ status: null, error: 'connection_closed' })); req.write(body.slice(0, 8));
    void (async () => { await delay(100); await during(); req.end(body.slice(8)); })().catch(() => resolve({ status: null, error: 'fixture_failed' }));
  });
  return { lab, work, studio, assets, project, tokens, call, human, projectId, begin, seal, revoke, sealed, mcpAgent, boundPlan, heldClaim, closeLab };
}
const data = (result: { structuredContent?: unknown }) => result.structuredContent as Record<string, any>;
const task = (key: string) => ({ key, title: key, instructions: 'i', acceptance: 'a', scope: ['src/' + key], dependencies: [] });
const tokenFree = (text: string, credential: string) => assert.ok(!text.includes(credential), 'credential leaked');

test('human handoff control on the actual lab: exact project, one-time begin, and no core/native/handoff/foreign bearer control', async t => {
  const f = await fixture(t), state = await f.human('/v1/product/state'), pid = await f.projectId();
  assert.equal(pid, state.body.projectId, 'the handoff project is the exact original lab project');
  const core = (await f.human('/v1/product/mcp-token', {})).body.token as string;
  const requestId = randomUUID(), first = await f.begin(requestId), credential = first.body.credential as string;
  assert.equal(first.status, 200); assert.equal(first.body.handoff.state, 'pending');
  const spent = await f.begin(requestId); assert.deepEqual([spent.status, spent.body.error, spent.body.credential], [409, 'HANDOFF_SPENT', undefined]);
  for (const [who, bearer] of [['core', core], ['handoff', credential], ['foreign', randomBytes(32).toString('base64url')], ['none', null]] as const)
    for (const [path, body] of [['/v1/native-handoffs', undefined], ['/v1/native-handoffs/begin', { requestId: randomUUID(), projectId: pid }],
      ['/v1/native-handoffs/seal', { handoffId: first.body.handoff.handoffId, projectId: pid }], ['/v1/native-handoffs/revoke', { handoffId: first.body.handoff.handoffId, projectId: pid }]] as const) {
      const reply = await f.call(bearer, path, body); assert.ok(reply.status === 401 || reply.status === 403, who + ' ' + path + ' -> ' + reply.status); tokenFree(reply.text, credential);
    }
  const listed = await f.human('/v1/native-handoffs'); assert.equal(listed.body.handoffs.length, 1, 'no extra credential minted'); assert.equal(listed.body.handoffs[0].state, 'pending');
  for (const reply of [listed, spent]) tokenFree(reply.text, credential);
});

test('pending handoffs do not authenticate; sealed handoffs work unbound tasks only and never review, grant, asset control, codex or handoff control', async t => {
  const f = await fixture(t), started = await f.begin(), credential = started.body.credential as string;
  assert.equal((await f.call(credential, '/v1/work/runs')).status, 401, 'pending');
  await f.seal(started.body.handoff.handoffId);
  const agent = await f.mcpAgent(credential);
  const created = data(await agent('work_create', { title: 'Handoff', objective: 'Unbound', tasks: [task('impl')] })), taskId = created.run.tasks[0].id;
  const claim = data(await agent('work_claim', { taskId, worker: 'external native client' }));
  assert.equal(data(await agent('work_progress', { taskId, leaseToken: claim.leaseToken, progress: 'working' })).task.state, 'in_progress');
  await writeFile(join(f.project, 'reports', 'impl.txt'), 'actual evidence');
  assert.equal(data(await agent('work_submit', { taskId, leaseToken: claim.leaseToken, evidence: [{ path: 'reports/impl.txt', note: 'file' }] })).task.state, 'needs_review');
  const pid = await f.projectId();
  for (const [path, body] of [['/v1/work/review', { taskId, approved: true, note: 'self' }], ['/v1/product/mcp-token', {}], ['/v1/studio/keys', undefined], ['/v1/studio/pairing', {}],
    ['/v1/studio/revoke', {}], ['/v1/codex/state', undefined], ['/v1/codex/action', { requestId: randomUUID(), connectionId: null, action: 'connect' }],
    ['/v1/assets/history-status', undefined], ['/v1/assets/conversation-jobs', undefined], ['/v1/assets/native/jobs', undefined], ['/v1/native-handoffs', undefined], ['/v1/native-handoffs/begin', { requestId: randomUUID(), projectId: pid }]] as const) {
    const reply = await f.call(credential, path, body, false); assert.ok(reply.status >= 400, path + ' -> ' + reply.status); tokenFree(reply.text, credential);
  }
  // Like the workbench agent token, the handoff reads generic local asset history (the in-app chat's assets_* tools).
  assert.equal((await f.call(credential, '/v1/assets/jobs')).status, 200);
  assert.equal((await f.human('/v1/work/review', { taskId, approved: true, note: 'Human inspected' })).status, 200);
  assert.equal(f.studio.commands().length, 0, 'no Studio command'); assert.equal(f.studio.sessions().length, 0, 'no Studio grant'); assert.equal(f.assets.jobs().length, 0, 'no asset job');
});

test('a sealed handoff cannot see or mutate the original-bound run, even with a copied lease; native and core routing stay compatible', async t => {
  const f = await fixture(t), bound = await f.boundPlan(), native = await f.mcpAgent(bound.credential, 'native-session'), { credential } = await f.sealed(), handoff = await f.mcpAgent(credential);
  const ready = data(await native('work_ready', { runId: bound.runId })), target = ready.tasks[0];
  const claim = data(await native('work_claim', { taskId: target.id, worker: 'original parent' }));
  assert.equal((await handoff('work_ready', { runId: bound.runId })).isError, true, 'handoff cannot read the bound run');
  assert.ok(!data(await handoff('work_runs', {})).runs.some((run: { id: string }) => run.id === bound.runId), 'bound run hidden');
  for (const [path, body] of [['/v1/work/progress', { taskId: target.id, leaseToken: claim.leaseToken, progress: 'copied' }],
    ['/v1/work/submit', { taskId: target.id, leaseToken: claim.leaseToken, evidence: [{ path: 'reports/x.txt', note: 'copied' }] }]] as const) {
    const refused = await f.call(credential, path, body, false); assert.deepEqual([refused.status, refused.body.error], [403, 'SCOPE'], path);
  }
  assert.equal(f.work.task(target.id).state, 'in_progress', 'copied-lease refusals changed nothing');
  // The live native task credential has no handoff control either.
  const pid = await f.projectId();
  for (const [path, body] of [['/v1/native-handoffs', undefined], ['/v1/native-handoffs/begin', { requestId: randomUUID(), projectId: pid }]] as const) {
    const reply = await f.call(bound.credential, path, body); assert.ok(reply.status === 401 || reply.status === 403, 'native ' + path + ' -> ' + reply.status);
  }
  assert.equal((await f.human('/v1/native-handoffs')).body.handoffs.length, 1, 'only the human-begun handoff exists');
  assert.equal(data(await native('work_progress', { taskId: target.id, leaseToken: claim.leaseToken, progress: 'original' })).task.state, 'in_progress', 'native routing unchanged');
  const core = (await f.human('/v1/product/mcp-token', {})).body.token as string, generic = await f.mcpAgent(core);
  const created = data(await generic('work_create', { title: 'Core', objective: 'Generic', tasks: [task('core')] }));
  assert.equal(data(await generic('work_claim', { taskId: created.run.tasks[0].id, worker: 'core' })).task.state, 'in_progress', 'generic core workflow unchanged');
  await bound.finishFinal();
  assert.equal(f.studio.commands().length, 0); assert.equal(f.assets.jobs().length, 0);
});

test('a held claim body revoked before effect leaves no lease', async t => {
  const f = await fixture(t), { handoffId, credential } = await f.sealed(), agent = await f.mcpAgent(credential);
  const taskId = data(await agent('work_create', { title: 'Held', objective: 'x', tasks: [task('held')] })).run.tasks[0].id;
  const outcome = await f.heldClaim(credential, taskId, async () => { assert.equal((await f.revoke(handoffId)).body.handoff.state, 'revoked'); });
  assert.notEqual(outcome.status, 200, JSON.stringify(outcome)); assert.equal(f.work.task(taskId).state, 'pending', 'no lease');
  assert.equal((await f.call(credential, '/v1/work/runs')).status, 401, 'revoked');
});

test('shutdown invalidates sealed and pending handoff authority before any held body takes effect', async t => {
  const f = await fixture(t), { credential } = await f.sealed(), pending = (await f.begin()).body.credential as string, agent = await f.mcpAgent(credential);
  const taskId = data(await agent('work_create', { title: 'Shutdown', objective: 'x', tasks: [task('shutdown')] })).run.tasks[0].id;
  let closing: Promise<void> | null = null;
  const outcome = await f.heldClaim(credential, taskId, async () => { closing = f.closeLab(); await delay(20); });
  await closing; t.diagnostic('held claim during shutdown: ' + JSON.stringify(outcome));
  assert.notEqual(outcome.status, 200); assert.equal(f.work.task(taskId).state, 'pending', 'no lease after shutdown');
  for (const bearer of [credential, pending]) await assert.rejects(f.call(bearer, '/v1/work/runs'), 'the closed lab accepts nothing');
  await delay(20); assert.deepEqual(unhandled, []);
});
