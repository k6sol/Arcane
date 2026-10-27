import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
import { TASK_PLAN_DISPLAY_LIMITS } from '../../packages/protocol/src/chat-task-plan.js';
import type { ChatTaskProposalFactory } from '../../apps/daemon/src/chat-task-coordinator.js';

// GET /v1/codex/task-plan over the actual lab HTTP authority with the codex service, coordinator, plan runner,
// WorkStore and a real CodexSession driving an owned scripted JSONL peer. No installed CLI/provider and no Studio.
const THREAD = 'plan.route.thread', SESSION = 'plan.route.session', OBJECTIVE = 'Build a small door that opens and verify it.';
const PEER = String.raw`
const{createInterface}=require('node:readline'),{appendFileSync,existsSync}=require('node:fs');
const c=JSON.parse(process.argv[1]);let turns=0,email='route@example.invalid';const send=v=>process.stdout.write(JSON.stringify(v)+'\n');
const flip=setInterval(()=>{if(existsSync(c.gate+'-account')){clearInterval(flip);email='other@example.invalid';send({method:'account/updated',params:{authMode:'chatgpt'}});}},5);flip.unref();
createInterface({input:process.stdin}).on('line',line=>{const{id,method,params={}}=JSON.parse(line);if(!method||method==='initialized')return;
appendFileSync(c.audit,JSON.stringify({method,text:method==='turn/start'?params.input?.[0]?.text:undefined})+'\n');const reply=result=>send({id,result});
if(method==='initialize')return reply({});
if(method==='account/read')return reply({account:{type:'chatgpt',email,planType:'plus'},requiresOpenaiAuth:true});
if(method==='model/list')return reply({data:[{id:'fixture',model:'fixture',displayName:'Fixture',supportedReasoningEfforts:[{reasoningEffort:'low'}]}],nextCursor:null});
if(method==='thread/start'||method==='thread/resume')return reply({thread:{id:c.thread,sessionId:c.session,turns:[],status:{type:'idle'}},model:params.model,modelProvider:'openai',cwd:process.cwd(),approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:{type:'readOnly',networkAccess:false}});
if(method==='mcpServerStatus/list')return reply({data:[{name:'arcane',runtimeStatus:'connected',toolsError:null,pluginId:null,tools:Object.fromEntries(c.tools.map(name=>[name,{}]))}],nextCursor:null});
if(method==='turn/start'){turns++;const turn={id:'route.turn:'+turns,status:'inProgress'};reply({turn});
 const timer=setInterval(()=>{if(existsSync(c.gate+'-'+turns)){clearInterval(timer);send({method:'turn/completed',params:{threadId:c.thread,turn:{...turn,status:'completed'}}});}},5);return;}
if(method==='turn/interrupt')return reply({});throw Error('Unexpected fixture method '+method);
});`;
const unhandled: unknown[] = []; process.on('unhandledRejection', error => { unhandled.push(error); });
async function until(check: () => boolean | Promise<boolean>, what: string, ms = 20000) { const end = Date.now() + ms; while (!await check()) { assert.ok(Date.now() < end, 'Expected ' + what); await delay(10); } }
type Reply = { status: number; body: Record<string, any> };

async function fixture(t: TestContext) {
  const base = await realpath(tmpdir()), root = await realpath(await mkdtemp(join(base, 'arcane-plan-route-'))), project = join(root, 'project'), audit = join(root, 'wire.jsonl'), gate = join(root, 'finished');
  await mkdir(join(project, 'reports'), { recursive: true });
  const studio = new StudioStore({ directory: join(root, 'studio') }), work = new WorkStore({ directory: join(root, 'work'), projectPath: project });
  const assets = await createAssetService({ cwd: process.cwd(), projectPath: project, outputRoot: join(root, 'assets') });
  const tokens: string[] = [], providers: CodexSession[] = [], agents: Client[] = [], servers: { close(): Promise<void> }[] = [];
  let proposals = 0;
  const proposalWorker: ChatTaskProposalFactory = async () => ({
    propose: async () => { proposals++; return { threadId: 'worker.thread', sessionId: null, turnId: 'worker.turn:' + proposals, text: 'Suggestion ' + proposals + ': keep the change bounded.' }; },
    close: async () => {} });
  const lab = await createConnectionLab({ cwd: process.cwd(), stateDirectory: join(root, 'studio', 'lab'), projectPath: project, studioStore: studio, workStore: work, assetService: assets,
    codexProposalWorker: proposalWorker, codexAutomaticTaskPlanning: true,
    codexConnect: async hooks => {
      assert.ok(hooks); tokens.push(hooks.finalCredential()); const index = providers.length;
      const client = new CodexSession({ command: process.execPath, args: ['-e', PEER, JSON.stringify({ thread: index ? THREAD + '.second' : THREAD, session: index ? SESSION + '.second' : SESSION, audit: index ? audit + '.second' : audit, gate: index ? gate + '.second' : gate, tools: ARCANE_NATIVE_TOOL_NAMES })], cwd: project, env: nativeEnvironment() },
        limits({ requestTimeoutMs: 2000 }), 'spawned-node-fixture', 'arcane-only', hooks);
      providers.push(client); await client.initialize(); return client;
    } });
  t.after(async () => {
    for (let turn = 1; turn <= 4; turn++) if (!existsSync(gate + '-' + turn)) try { await writeFile(gate + '-' + turn, 'done'); } catch { /* cleanup */ }
    for (const close of [...agents.map(a => () => a.close()), ...servers.map(s => () => s.close()), () => lab.close(), ...providers.map(p => () => p.close()), () => assets.close(), () => { work.close(); }, () => { studio.close(); }])
      try { await close(); } catch { /* best-effort owned cleanup */ }
    const part = relative(base, root); assert.ok(part.startsWith('arcane-plan-route-') && !isAbsolute(part) && !part.includes(sep)); await rm(root, { recursive: true, force: true });
  });
  const human = async (path: string, body: unknown) => {
    const response = await fetch(lab.origin + path, { method: 'POST', headers: { Authorization: 'Bearer ' + lab.token, Origin: lab.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  const bearer = async (token: string, path: string, body: unknown) => {
    const response = await fetch(lab.origin + path, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  /** Raw HTTP so Host can be set; default is the human panel bearer with no Origin header. */
  const raw = (path: string, options: { method?: string; token?: string | null; host?: string; origin?: string } = {}) => new Promise<Reply & { text: string }>((resolve, reject) => {
    const url = new URL(lab.origin), headers: Record<string, string> = { Host: options.host ?? url.host };
    const token = options.token === undefined ? lab.token : options.token; if (token !== null) headers.Authorization = 'Bearer ' + token;
    if (options.origin !== undefined) headers.Origin = options.origin;
    const req = httpRequest({ hostname: url.hostname, port: url.port, path, method: options.method ?? 'GET', headers }, response => {
      let text = ''; response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; });
      response.on('end', () => { try { resolve({ status: response.statusCode!, body: JSON.parse(text), text }); } catch (error) { reject(error); } });
    });
    req.setTimeout(15000, () => req.destroy(new Error('timeout'))); req.on('error', reject); req.end();
  });
  const playtests = await raw('/v1/playtests');
  assert.equal(playtests.status, 200, playtests.text);
  assert.deepEqual(playtests.body.jobs, [], 'the actual owned verification service is attached before managed planning');
  const query = (scope: Record<string, string>) => '/v1/codex/task-plan?' + new URLSearchParams(scope).toString();
  const action = async (name: string, fields: Record<string, unknown> = {}) => human('/v1/codex/action', { requestId: randomUUID(), connectionId: name === 'connect' ? null : providers.at(-1)!.snapshot().connectionId, action: name, ...fields });
  const wire = async (file = audit) => existsSync(file) ? (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { method: string; text?: string }) : [];
  const turnStarts = async () => (await wire()).filter(row => row.method === 'turn/start');
  const mcpAgent = async (token: string) => {
    const server = createMcpServer({ client: new DaemonClient({ url: lab.origin, token, assetAudience: 'native-session' }), projectRoot: project }), agent = new Client({ name: 'plan-route-fixture', version: 'fixture' });
    const [left, right] = InMemoryTransport.createLinkedPair(); await server.connect(right); await agent.connect(left); servers.push(server); agents.push(agent);
    return async (name: string, args: Record<string, unknown>) => CallToolResultSchema.parse(await agent.callTool({ name, arguments: args }));
  };
  const state = async () => (await raw('/v1/codex/state')).body.state as Record<string, any>;
  /** Everything a read could conceivably change: native turns (both peers), workers, work runs/leases/evidence, Studio, task summaries, grants. */
  const effects = async () => JSON.stringify({ turns: (await wire()).length, second: (await wire(audit + '.second')).length, proposals, runs: work.runsReadOnly(), studio: studio.commands().length,
    tasks: (await state()).chatTasks, granted: providers.map(p => p.snapshot().thread?.writeGranted ?? null) });
  /** Human Send, then drive the genuine plan to its held final parent turn (turn 3) and return the read scope. */
  const boundPlan = async () => {
    for (const [name, fields] of [['connect', {}], ['select', { model: 'fixture', effort: 'low' }], ['thread-start', {}]] as const) assert.equal((await action(name, fields)).body.record.state, 'acknowledged', name);
    assert.equal((await action('turn-start', { threadId: THREAD, text: OBJECTIVE, allowWorkspaceWrites: true, allowAssets: true })).body.record.state, 'acknowledged');
    await until(async () => (await turnStarts()).length === 1, 'the original turn'); await writeFile(gate + '-1', 'done');
    await until(async () => (await turnStarts()).length === 2, 'round 1 parent incorporation'); await writeFile(gate + '-2', 'done');
    await until(async () => (await turnStarts()).length === 3, 'the final parent turn with its bound run');
    const match = /bound review run ([0-9a-f-]{36})/.exec((await turnStarts())[2]!.text ?? ''); assert.ok(match); const runId = match![1]!;
    const binding = work.bindingForRun(runId); assert.ok(binding);
    const chatTasks = (await state()).chatTasks as { taskId: string; threadId: string }[]; assert.equal(chatTasks.length, 1);
    const scope = { connectionId: providers[0]!.snapshot().connectionId!, threadId: THREAD, taskId: chatTasks[0]!.taskId };
    return { runId, binding: binding!, scope, credential: tokens[0]!, finishFinal: () => writeFile(gate + '-3', 'done') };
  };
  const read = async (scope: Record<string, string>) => raw(query(scope));
  return { lab, work, studio, project, tokens, providers, gate, human, bearer, raw, read, query, action, mcpAgent, boundPlan, turnStarts, effects, proposals: () => proposals };
}
const data = (result: { structuredContent?: unknown }) => result.structuredContent as Record<string, any>;
const evidence = async (project: string, name: string) => { await writeFile(join(project, 'reports', name), 'actual evidence ' + name); return 'reports/' + name; };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Exact display contract: only these keys, bounded, enumerated values. */
function assertDisplayOnly(view: Record<string, any>, taskId: string) {
  assert.deepEqual(Object.keys(view).sort(), ['plan', 'taskId']); assert.equal(view.taskId, taskId);
  const plan = view.plan; assert.deepEqual(Object.keys(plan).sort(), ['planId', 'reason', 'review', 'state', 'steps']); assert.match(plan.planId, UUID);
  assert.ok(['active', 'stopped', 'awaiting_review', 'unknown'].includes(plan.state)); assert.ok(plan.steps.length <= TASK_PLAN_DISPLAY_LIMITS.steps);
  for (const step of plan.steps) {
    assert.deepEqual(Object.keys(step).sort(), ['index', 'kind', 'reason', 'round', 'seq', 'state', 'terminal']);
    assert.ok(['worker', 'incorporation', 'evidence'].includes(step.kind)); assert.ok([1, 2].includes(step.round) && [0, 1, 2].includes(step.index));
    assert.ok(step.reason === null || (typeof step.reason === 'string' && step.reason.length <= TASK_PLAN_DISPLAY_LIMITS.reasonChars));
  }
  if (plan.review) {
    assert.deepEqual(Object.keys(plan.review).sort(), ['reason', 'runId', 'state', 'tasks']); assert.match(plan.review.runId, UUID);
    for (const task of plan.review.tasks) assert.deepEqual(Object.keys(task).sort(), ['key', 'state']);
  }
}

test('human-only bearer/Host/Origin, exact query and bounded display-only data; reads have no effects', async t => {
  const f = await fixture(t), bound = await f.boundPlan(), path = f.query(bound.scope);
  const core = (await f.human('/v1/product/mcp-token', {})).body.token as string;
  const before = await f.effects();
  // Authority: only the human panel bearer, exact Host, and either no Origin or the exact panel Origin.
  for (const [what, options, status, error] of [
    ['no bearer', { token: null }, 401, 'AUTH'], ['native task credential', { token: bound.credential }, 401, 'AUTH'], ['core agent bearer', { token: core }, 403, 'HUMAN_ONLY'],
    ['wrong bearer', { token: 'x'.repeat(43) }, 401, 'AUTH'], ['foreign Host', { host: 'evil.example:80' }, 403, 'HOST'],
    ['foreign Origin', { origin: 'http://evil.example' }, 403, 'ORIGIN'], ['POST', { method: 'POST', origin: f.lab.origin }, 405, 'METHOD'],
  ] as const) { const reply = await f.raw(path, options); assert.deepEqual([reply.status, reply.body.error], [status, error], what); }
  // Exact query: three keys, each once, valid shapes, bounded length; no extra/duplicate keys.
  const { connectionId, threadId, taskId } = bound.scope;
  for (const [what, search, error] of [
    ['missing taskId', new URLSearchParams({ connectionId, threadId }).toString(), 'QUERY'],
    ['duplicate taskId', new URLSearchParams([['connectionId', connectionId], ['threadId', threadId], ['taskId', taskId], ['taskId', taskId]]).toString(), 'QUERY'],
    ['extra key', new URLSearchParams({ ...bound.scope, runId: bound.runId }).toString(), 'QUERY'],
    ['replaced key', new URLSearchParams({ connectionId, threadId, runId: taskId }).toString(), 'QUERY'],
    ['oversize', new URLSearchParams({ connectionId, threadId: 'a'.repeat(2100), taskId }).toString(), 'QUERY'],
    ['malformed taskId', new URLSearchParams({ connectionId, threadId, taskId: 'not-a-uuid' }).toString(), 'TASK_SCOPE'],
    ['malformed connectionId', new URLSearchParams({ connectionId: connectionId.toUpperCase() + 'x', threadId, taskId }).toString(), 'TASK_SCOPE'],
    ['control character', new URLSearchParams({ connectionId, threadId: 'a\nb', taskId }).toString(), 'TASK_SCOPE'],
    ['empty threadId', new URLSearchParams({ connectionId, threadId: '', taskId }).toString(), 'TASK_SCOPE'],
  ] as const) { const reply = await f.raw('/v1/codex/task-plan?' + search); assert.deepEqual([reply.status, reply.body.error], [400, error], what); }
  assert.deepEqual([(await f.raw('/v1/codex/state?connectionId=' + connectionId)).body.error], ['QUERY'], 'other codex routes still refuse any query');
  // The exact human read succeeds with and without the panel Origin and is bounded display data only.
  const ok = await f.raw(path), withOrigin = await f.raw(path, { origin: f.lab.origin });
  assert.equal(ok.status, 200); assert.equal(withOrigin.status, 200); assert.equal(ok.text, withOrigin.text);
  assertDisplayOnly(ok.body, taskId); assert.ok(Buffer.byteLength(ok.text) <= TASK_PLAN_DISPLAY_LIMITS.responseBytes);
  assert.equal(ok.body.plan.review.runId, bound.runId);
  const original = bound.binding.original;
  for (const secret of [f.lab.token, core, bound.credential, connectionId, threadId, SESSION, OBJECTIVE, 'Suggestion', 'bound review run', 'route@example.invalid',
    String(original.accountIdentity), String(original.incarnationId), bound.binding.objectiveSha256, 'route.turn', 'worker.thread'])
    assert.ok(!ok.text.includes(secret), 'response must not carry ' + secret.slice(0, 24));
  assert.doesNotMatch(ok.text, /[0-9a-f]{64}/, 'no identity, objective or evidence hashes');
  // Repeated reads (plus every refusal above) create no turns, workers, grants, claims, submissions, leases or plan steps.
  for (let i = 0; i < 8; i++) assert.equal((await f.raw(path)).text, ok.text, 'stable repeated read ' + i);
  assert.equal(await f.effects(), before, 'reads and refusals had no effects');
  assert.equal((await f.turnStarts()).length, 3); assert.equal(f.proposals(), 5);
  await bound.finishFinal();
});

test('honest early-bound active review; human approval is never accepted before the final incorporation succeeds', async t => {
  const f = await fixture(t), bound = await f.boundPlan(), native = await f.mcpAgent(bound.credential);
  const view = async () => { const reply = await f.read(bound.scope); assert.equal(reply.status, 200, JSON.stringify(reply.body)); assertDisplayOnly(reply.body, bound.scope.taskId); return reply.body.plan; };
  const early = await view();
  t.diagnostic('early: ' + JSON.stringify(early));
  assert.equal(early.state, 'active', 'final parent turn is still live');
  assert.deepEqual([early.review.runId, early.review.state, early.review.reason], [bound.runId, 'pending_submission', null], 'the early-bound review is honestly pending');
  assert.deepEqual(early.review.tasks.map((task: { key: string; state: string }) => task.key + ':' + task.state).sort(), ['implementation:pending', 'verification:pending']);
  const parents = (plan: any) => plan.steps.filter((step: { kind: string }) => step.kind === 'incorporation');
  assert.notEqual(parents(early).at(-1).state, 'completed', 'the final incorporation has not completed');
  // Original actor submits both tasks while the final turn is held.
  const ready = data(await native('work_ready', { runId: bound.runId }));
  for (const key of ['implementation', 'verification']) {
    const task = ready.tasks.find((value: { key: string }) => value.key === key);
    const claim = data(await native('work_claim', { taskId: task.id, worker: 'original parent' }));
    assert.equal(data(await native('work_submit', { taskId: task.id, leaseToken: claim.leaseToken, evidence: [{ path: await evidence(f.project, key + '.txt'), note: key }] })).task.state, 'needs_review');
  }
  const submitted = await view();
  assert.deepEqual([submitted.state, submitted.review.state], ['active', 'awaiting_human_review']);
  // The human approves every task while native work is still pending: the read must not report accepted.
  for (const task of ready.tasks) assert.equal((await f.human('/v1/work/review', { taskId: task.id, approved: true, note: 'Human inspected' })).status, 200);
  assert.ok(f.work.runById(bound.runId).tasks.every(task => task.state === 'complete'), 'the WorkStore run is fully human-approved');
  const approvedEarly = await view();
  assert.equal(approvedEarly.state, 'active');
  assert.deepEqual([approvedEarly.review.state, approvedEarly.review.reason], ['unavailable', 'native_work_pending'], 'human evidence review cannot make accepted before final incorporation');
  assert.equal((await view()).review.state, 'unavailable', 'repeated read stays not-accepted');
  // Only after the final parent incorporation completes does the plan await review with accepted human review.
  await bound.finishFinal();
  await until(async () => (await f.read(bound.scope)).body.plan?.state === 'awaiting_review', 'final incorporation to complete');
  const final = await view();
  t.diagnostic('final: ' + JSON.stringify(final));
  assert.deepEqual([final.state, final.review.state, final.review.reason], ['awaiting_review', 'accepted', null]);
  assert.deepEqual([parents(final).at(-1).state, parents(final).at(-1).terminal], ['completed', 'completed']);
  assert.equal((await f.turnStarts()).length, 3, 'no extra native turns'); assert.equal(f.studio.commands().length, 0, 'no Studio commands');
});

test('final awaiting-review is honest without submissions; stale, retired and wrong scopes refuse without effects', async t => {
  const f = await fixture(t), bound = await f.boundPlan(), { connectionId, threadId, taskId } = bound.scope;
  await bound.finishFinal();
  await until(async () => (await f.read(bound.scope)).body.plan?.state === 'awaiting_review', 'final incorporation to complete');
  const final = (await f.read(bound.scope)).body.plan;
  assert.deepEqual([final.state, final.review.state, final.review.runId], ['awaiting_review', 'pending_submission', bound.runId], 'awaiting_review is not acceptance');
  const refuse = async (what: string, scope: Record<string, string>, errors: readonly string[]) => {
    const before = await f.effects(), reply = await f.read(scope);
    assert.equal(reply.status, 400, what + ': ' + JSON.stringify(reply.body)); assert.ok(errors.includes(reply.body.error), what + ': ' + reply.body.error);
    assert.ok(!reply.text.includes(bound.runId) && !reply.text.includes('planId'), what + ' discloses nothing');
    assert.equal(await f.effects(), before, what + ' had no effects');
  };
  await refuse('unknown connection', { connectionId: randomUUID(), threadId, taskId }, ['STALE_CONNECTION']);
  await refuse('wrong thread', { connectionId, threadId: THREAD + '.other', taskId }, ['TASK_SCOPE']);
  await refuse('unknown task', { connectionId, threadId, taskId: randomUUID() }, ['TASK_SCOPE']);
  // Navigation keeps the original task live but makes its connection stale; a second chat cannot read the first task.
  assert.equal((await f.action('disconnect', { preserveAssetWork: true })).body.record.state, 'acknowledged');
  await refuse('stale navigated connection', bound.scope, ['STALE_CONNECTION']);
  for (const [name, fields] of [['connect', {}], ['select', { model: 'fixture', effort: 'low' }], ['thread-start', {}]] as const) assert.equal((await f.action(name, fields)).body.record.state, 'acknowledged', name);
  const second = f.providers[1]!.snapshot().connectionId!; assert.notEqual(second, connectionId);
  await refuse('second incarnation with original thread', { connectionId: second, threadId, taskId }, ['TASK_SCOPE']);
  await refuse('second incarnation with its own thread', { connectionId: second, threadId: THREAD + '.second', taskId }, ['TASK_SCOPE']);
  // A full disconnect retires the second connection.
  assert.equal((await f.action('disconnect')).body.record.state, 'acknowledged');
  await refuse('retired connection', { connectionId: second, threadId: THREAD + '.second', taskId }, ['STALE_CONNECTION', 'CLOSED']);
  assert.equal((await f.turnStarts()).length, 3); assert.equal(f.studio.commands().length, 0);
});

test('a native account change on the original connection fails closed: the connection is dropped and the read refuses without effects', async t => {
  const f = await fixture(t), bound = await f.boundPlan();
  assert.equal((await f.read(bound.scope)).status, 200);
  await bound.finishFinal();
  await until(async () => (await f.read(bound.scope)).body.plan?.state === 'awaiting_review', 'final incorporation to complete');
  await writeFile(f.gate + '-account', 'flip');
  await until(() => f.providers[0]!.taskAccountIdentity() !== bound.binding.original.accountIdentity, 'the account change to reach the session');
  await until(async () => !f.providers[0]!.snapshot().connected && !(await f.raw('/v1/codex/state')).body.state.snapshot, 'the changed-account connection to be dropped');
  const before = await f.effects(), reply = await f.read(bound.scope);
  assert.deepEqual([reply.status, reply.body.error], [400, 'STALE_CONNECTION'], JSON.stringify(reply.body));
  assert.ok(!reply.text.includes(bound.runId));
  assert.equal(await f.effects(), before, 'refused read had no effects');
});

test('no unhandled rejections', async () => { await delay(20); assert.deepEqual(unhandled, []); });
