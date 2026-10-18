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
import type { ChatTaskProposalFactory } from '../../apps/daemon/src/chat-task-coordinator.js';

// Actual lab HTTP authority, codex service/coordinator/plan runner, MCP SDK server + DaemonClient, WorkStore
// SQLite/files and the real CodexSession with an owned scripted JSONL peer (owned turn/start calls only).
// No installed CLI/provider inference and no Studio operations.
const THREAD = 'bound.work.thread', SESSION = 'bound.work.session';
const PEER = String.raw`
const{createInterface}=require('node:readline'),{appendFileSync,existsSync}=require('node:fs');
const c=JSON.parse(process.argv[1]);let turns=0;const send=v=>process.stdout.write(JSON.stringify(v)+'\n');
createInterface({input:process.stdin}).on('line',line=>{const{id,method,params={}}=JSON.parse(line);if(!method||method==='initialized')return;
appendFileSync(c.audit,JSON.stringify({method,text:method==='turn/start'?params.input?.[0]?.text:undefined})+'\n');const reply=result=>send({id,result});
if(method==='initialize')return reply({});
if(method==='account/read')return reply({account:{type:'chatgpt',email:'bound@example.invalid',planType:'plus'},requiresOpenaiAuth:true});
if(method==='model/list')return reply({data:[{id:'fixture',model:'fixture',displayName:'Fixture',supportedReasoningEfforts:[{reasoningEffort:'low'}]}],nextCursor:null});
if(method==='thread/start'||method==='thread/resume')return reply({thread:{id:c.thread,sessionId:c.session,turns:[],status:{type:'idle'}},model:params.model,modelProvider:'openai',cwd:process.cwd(),approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:{type:'readOnly',networkAccess:false}});
if(method==='mcpServerStatus/list')return reply({data:[{name:'arcane',runtimeStatus:'connected',toolsError:null,pluginId:null,tools:Object.fromEntries(c.tools.map(name=>[name,{}]))}],nextCursor:null});
if(method==='turn/start'){turns++;const turn={id:'bound.turn:'+turns,status:'inProgress'};reply({turn});
 const timer=setInterval(()=>{if(existsSync(c.gate+'-'+turns)){clearInterval(timer);send({method:'turn/completed',params:{threadId:c.thread,turn:{...turn,status:'completed'}}});}},5);return;}
if(method==='turn/interrupt')return reply({});throw Error('Unexpected fixture method '+method);
});`;
const unhandled: unknown[] = []; process.on('unhandledRejection', error => { unhandled.push(error); });
async function until(check: () => boolean | Promise<boolean>, what: string, ms = 20000) { const end = Date.now() + ms; while (!await check()) { assert.ok(Date.now() < end, 'Expected ' + what); await delay(10); } }

async function fixture(t: TestContext) {
  const base = await realpath(tmpdir()), root = await realpath(await mkdtemp(join(base, 'arcane-bound-work-'))), project = join(root, 'project'), audit = join(root, 'wire.jsonl'), gate = join(root, 'finished');
  await mkdir(join(project, 'reports'), { recursive: true });
  const studio = new StudioStore({ directory: join(root, 'studio') }), clock = { offset: 0 }, work = new WorkStore({ directory: join(root, 'work'), projectPath: project, now: () => Date.now() + clock.offset }); // trusted fixture clock; no global time mutation
  const assets = await createAssetService({ cwd: process.cwd(), projectPath: project, outputRoot: join(root, 'assets') });
  const tokens: string[] = [], providers: CodexSession[] = [], agents: Client[] = [], servers: { close(): Promise<void> }[] = [];
  let proposals = 0;
  const proposalWorker: ChatTaskProposalFactory = async () => ({
    propose: async () => { proposals++; return { threadId: 'worker.thread', sessionId: null, turnId: 'worker.turn:' + proposals, text: 'Suggestion ' + proposals + ': keep the change bounded.' }; },
    close: async () => {} });
  const lab = await createConnectionLab({ cwd: process.cwd(), stateDirectory: join(root, 'lab'), projectPath: project, studioStore: studio, workStore: work, assetService: assets,
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
    const part = relative(base, root); assert.ok(part.startsWith('arcane-bound-work-') && !isAbsolute(part) && !part.includes(sep)); await rm(root, { recursive: true, force: true });
  });
  const human = async (path: string, body: unknown, origin = true) => {
    const response = await fetch(lab.origin + path, { method: 'POST', headers: { Authorization: 'Bearer ' + lab.token, ...(origin ? { Origin: lab.origin } : {}), 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  const bearer = async (token: string, path: string, body?: unknown) => {
    const response = await fetch(lab.origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  const action = async (name: string, fields: Record<string, unknown> = {}) => human('/v1/codex/action', { requestId: randomUUID(), connectionId: name === 'connect' ? null : providers.at(-1)!.snapshot().connectionId, action: name, ...fields });
  const wire = async () => existsSync(audit) ? (await readFile(audit, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { method: string; text?: string }) : [];
  const turnStarts = async () => (await wire()).filter(row => row.method === 'turn/start');
  const mcpAgent = async (token: string) => {
    const server = createMcpServer({ client: new DaemonClient({ url: lab.origin, token, assetAudience: 'native-session' }), projectRoot: project }), agent = new Client({ name: 'bound-work-fixture', version: 'fixture' });
    const [left, right] = InMemoryTransport.createLinkedPair(); await server.connect(right); await agent.connect(left); servers.push(server); agents.push(agent);
    return async (name: string, args: Record<string, unknown>) => CallToolResultSchema.parse(await agent.callTool({ name, arguments: args }));
  };
  /** Human Send, then drive the genuine plan to its held final parent turn (turn 3) and return the bound run. */
  const boundPlan = async () => {
    for (const [name, fields] of [['connect', {}], ['select', { model: 'fixture', effort: 'low' }], ['thread-start', {}]] as const) assert.equal((await action(name, fields)).body.record.state, 'acknowledged', name);
    assert.equal((await action('turn-start', { threadId: THREAD, text: 'Build a small door that opens and verify it.', allowWorkspaceWrites: true, allowAssets: true })).body.record.state, 'acknowledged');
    await until(async () => (await turnStarts()).length === 1, 'the original turn'); await writeFile(gate + '-1', 'done');
    await until(async () => (await turnStarts()).length === 2, 'round 1 parent incorporation'); await writeFile(gate + '-2', 'done');
    await until(async () => (await turnStarts()).length === 3, 'the final parent turn with its bound run');
    const final = (await turnStarts())[2]!.text ?? '', match = /bound review run ([0-9a-f-]{36})/.exec(final);
    assert.ok(match, 'the final parent prompt names its host-bound review run'); const runId = match![1]!;
    const binding = work.bindingForRun(runId); assert.ok(binding, 'the run is task-bound');
    return { runId, binding: binding!, credential: tokens[0]!, finishFinal: () => writeFile(gate + '-3', 'done') };
  };
  return { lab, work, studio, project, tokens, clock, human, bearer, action, mcpAgent, boundPlan, turnStarts, proposals: () => proposals };
}
const data = (result: { structuredContent?: unknown }) => result.structuredContent as Record<string, any>;
const evidence = async (project: string, name: string) => { await writeFile(join(project, 'reports', name), 'actual evidence ' + name); return 'reports/' + name; };

test('only the original native task actor works the bound run during its final turn; review stays human', async t => {
  const f = await fixture(t), bound = await f.boundPlan(), native = await f.mcpAgent(bound.credential);
  assert.equal(f.proposals(), 5, 'two rounds of read-only workers (3 + 2)');
  const ready = data(await native('work_ready', { runId: bound.runId })); assert.deepEqual(ready.tasks.map((task: { key: string }) => task.key).sort(), ['implementation', 'verification']);
  const implementation = ready.tasks.find((task: { key: string }) => task.key === 'implementation');
  const claim = data(await native('work_claim', { taskId: implementation.id, worker: 'original parent' }));
  assert.equal(claim.task.state, 'in_progress');
  // A generic core agent bearer, even holding the copied lease token, is refused for the bound run.
  const core = (await f.human('/v1/product/mcp-token', {})).body.token as string;
  for (const [path, body] of [['/v1/work/progress', { taskId: implementation.id, leaseToken: claim.leaseToken, progress: 'copied lease' }],
    ['/v1/work/submit', { taskId: implementation.id, leaseToken: claim.leaseToken, evidence: [{ path: await evidence(f.project, 'copied.txt'), note: 'x' }] }]] as const) {
    const refused = await f.bearer(core, path, body); assert.deepEqual([refused.status, refused.body.error], [403, 'SCOPE'], path);
  }
  const verification = ready.tasks.find((task: { key: string }) => task.key === 'verification');
  assert.deepEqual([(await f.bearer(core, '/v1/work/claim', { taskId: verification.id, worker: 'core' })).status], [403], 'core cannot claim a bound task');
  const coreReady = await f.bearer(core, '/v1/work/ready?runId=' + bound.runId); assert.deepEqual([coreReady.status, coreReady.body.error], [403, 'SCOPE'], 'explicit foreign bound ready refuses');
  const coreRuns = await f.bearer(core, '/v1/work/runs'); assert.ok(!coreRuns.body.runs.some((run: { id: string }) => run.id === bound.runId), 'bound run hidden from other agents');
  assert.ok(data(await native('work_runs', {})).runs.some((run: { id: string }) => run.id === bound.runId), 'visible to its original actor');
  // The original actor submits actual evidence; it can never approve.
  const submitted = data(await native('work_submit', { taskId: implementation.id, leaseToken: claim.leaseToken, evidence: [{ path: await evidence(f.project, 'implementation.txt'), note: 'actual file' }] }));
  assert.equal(submitted.task.state, 'needs_review'); assert.match(submitted.task.evidence[0].sha256, /^[a-f0-9]{64}$/);
  const selfReview = await f.bearer(bound.credential, '/v1/work/review', { taskId: implementation.id, approved: true, note: 'self' });
  assert.deepEqual([selfReview.status, selfReview.body.error], [403, 'SCOPE']);
  assert.equal(f.work.task(implementation.id).state, 'needs_review');
  // After the final parent turn ends, the original actor loses bound-run write authority.
  await bound.finishFinal();
  await until(() => f.work.task(implementation.id).state === 'needs_review' && f.lab !== undefined, 'final terminal observed', 2000); await delay(300);
  const late = await f.bearer(bound.credential, '/v1/work/claim', { taskId: verification.id, worker: 'late' });
  assert.notEqual(late.status, 200, 'no bound-run writes after the final parent turn ended');
  t.diagnostic('post-final bound write refusal: ' + late.status + ' ' + String(late.body.error));
  assert.equal(f.work.task(verification.id).state, 'pending');
  const approved = await f.human('/v1/work/review', { taskId: implementation.id, approved: true, note: 'Human inspected the evidence' });
  assert.equal(approved.status, 200); assert.equal(f.work.task(implementation.id).state, 'complete');
  assert.equal(f.studio.commands().length, 0, 'no Studio commands'); assert.equal((await f.turnStarts()).length, 3, 'only owned scripted parent turns');
});

test('unbound cooperative workflows keep their contract and native work_create never binds', async t => {
  const f = await fixture(t), bound = await f.boundPlan(), native = await f.mcpAgent(bound.credential);
  const core = (await f.human('/v1/product/mcp-token', {})).body.token as string;
  const created = data(await native('work_create', { title: 'Unbound', objective: 'Cooperative', tasks: [{ key: 'k', title: 't', instructions: 'i', acceptance: 'a', scope: ['src/k'], dependencies: [] }] }));
  assert.equal(f.work.bindingForRun(created.run.id), null, 'native work_create never manufactures task provenance');
  const coreClaim = await f.bearer(core, '/v1/work/claim', { taskId: created.run.tasks[0].id, worker: 'core' });
  assert.equal(coreClaim.status, 200, 'unbound runs keep the existing cooperative any-agent contract');
  await bound.finishFinal();
});

test('retirement during a held bound-run request refuses before the WorkStore operation', async t => {
  const f = await fixture(t), bound = await f.boundPlan(), native = await f.mcpAgent(bound.credential);
  const task = data(await native('work_ready', { runId: bound.runId })).tasks[0];
  const body = JSON.stringify({ taskId: task.id, worker: 'held' }), url = new URL('/v1/work/claim', f.lab.origin);
  const outcome = await new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const req = httpRequest(url, { method: 'POST', headers: { Authorization: 'Bearer ' + bound.credential, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, response => {
      let text = ''; response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; }); response.on('end', () => resolve({ status: response.statusCode!, body: JSON.parse(text) }));
    });
    req.on('error', reject); req.write(body.slice(0, 10));
    void (async () => { await delay(100); await f.action('disconnect'); req.end(body.slice(10)); })().catch(reject);
  });
  assert.ok([401, 403].includes(outcome.status), 'refused: ' + JSON.stringify(outcome.body));
  assert.equal(f.work.task(task.id).state, 'pending', 'no lease was created');
  const retired = await f.bearer(bound.credential, '/v1/work/runs'); assert.equal(retired.status, 401, 'the retired credential is refused');
});

const bindingInput = (keys: string[]) => ({ taskId: randomUUID(), planId: randomUUID(), objectiveSha256: 'c'.repeat(64),
  original: { accountIdentity: 'd'.repeat(64), connectionId: randomUUID(), incarnationId: randomUUID(), threadId: 'other.thread', sessionId: null, model: 'fixture', effort: 'low', allowWorkspaceWrites: true, allowAssets: false },
  run: { title: 'Other bound run', objective: 'Untouched', tasks: keys.map(key => ({ key, title: key, instructions: 'i', acceptance: 'a', scope: ['src/' + key], dependencies: [] })) } });

test('original actor progress, lease expiry, one explicit reclaim and no cross-run expiry', async t => {
  const f = await fixture(t), bound = await f.boundPlan(), native = await f.mcpAgent(bound.credential);
  const ready = data(await native('work_ready', { runId: bound.runId })), task = ready.tasks.find((value: { key: string }) => value.key === 'implementation');
  const first = data(await native('work_claim', { taskId: task.id, worker: 'original parent' }));
  const progress = data(await native('work_progress', { taskId: task.id, leaseToken: first.leaseToken, progress: 'Implementing the bounded change.' }));
  assert.equal(progress.task.state, 'in_progress', 'original actor progress succeeds while the final parent is live');
  // A second, trusted-seeded bound run with its own in-progress lease must not be touched by run-scoped expiry.
  const other = f.work.createForTask(bindingInput(['other'])), otherTask = other.run.tasks[0]!;
  const otherClaim = f.work.claim({ taskId: otherTask.id, worker: 'trusted host fixture' });
  f.clock.offset = 301_000; // past the 300 s cooperative lease, via the WorkStore's own injected clock
  const stale = await native('work_progress', { taskId: task.id, leaseToken: first.leaseToken, progress: 'after expiry' });
  assert.equal(stale.isError, true, 'an expired lease cannot record progress');
  assert.equal((await native('work_submit', { taskId: task.id, leaseToken: first.leaseToken, evidence: [{ path: await evidence(f.project, 'stale.txt'), note: 'x' }] })).isError, true, 'nor submit');
  assert.equal(f.work.task(task.id).state, 'interrupted');
  const reclaim = data(await native('work_claim', { taskId: task.id, worker: 'original parent' }));
  assert.notEqual(reclaim.leaseToken, first.leaseToken); assert.equal(reclaim.task.state, 'in_progress', 'one explicit original-actor reclaim issues a fresh lease');
  assert.equal((await native('work_claim', { taskId: task.id, worker: 'original parent' })).isError, true, 'no second concurrent reclaim');
  assert.equal((await native('work_submit', { taskId: task.id, leaseToken: first.leaseToken, evidence: [{ path: 'reports/stale.txt', note: 'old token' }] })).isError, true, 'the old token cannot submit');
  const core = (await f.human('/v1/product/mcp-token', {})).body.token as string;
  const copied = await f.bearer(core, '/v1/work/submit', { taskId: task.id, leaseToken: reclaim.leaseToken, evidence: [{ path: 'reports/stale.txt', note: 'copied' }] });
  assert.deepEqual([copied.status, copied.body.error], [403, 'SCOPE'], 'a copied fresh lease is refused for another bearer');
  const submitted = data(await native('work_submit', { taskId: task.id, leaseToken: reclaim.leaseToken, evidence: [{ path: await evidence(f.project, 'fresh.txt'), note: 'fresh lease' }] }));
  assert.equal(submitted.task.state, 'needs_review');
  const otherNow = f.work.runById(other.run.id).tasks[0]!;
  assert.deepEqual([otherNow.state, otherNow.leaseUntil !== null], ['in_progress', true], 'expiry and refusals on this run did not mutate another bound run');
  assert.equal(otherClaim.task.id, otherTask.id);
  await bound.finishFinal();
});

test('a concurrently LIVE second native incarnation is denied the bound run but keeps its unbound workflow', async t => {
  const f = await fixture(t), bound = await f.boundPlan(), original = await f.mcpAgent(bound.credential);
  const ready = data(await original('work_ready', { runId: bound.runId })), task = ready.tasks[0];
  const claim = data(await original('work_claim', { taskId: task.id, worker: 'original parent' }));
  // Navigation keeps the original task client (and its credential) live; a second chat opens a fresh incarnation.
  assert.equal((await f.action('disconnect', { preserveAssetWork: true })).body.record.state, 'acknowledged');
  for (const [name, fields] of [['connect', {}], ['select', { model: 'fixture', effort: 'low' }], ['thread-start', {}]] as const) assert.equal((await f.action(name, fields)).body.record.state, 'acknowledged', name);
  assert.equal(f.tokens.length, 2); const secondCredential = f.tokens[1]!; assert.notEqual(secondCredential, bound.credential);
  assert.equal(data(await original('work_ready', { runId: bound.runId })).tasks.length >= 1, true, 'the original incarnation is still live and authorized');
  const second = await f.mcpAgent(secondCredential);
  assert.equal((await second('work_ready', { runId: bound.runId })).isError, true, 'second live incarnation cannot read the bound run');
  assert.ok(!data(await second('work_runs', {})).runs.some((run: { id: string }) => run.id === bound.runId), 'bound run hidden from the second incarnation');
  const other = ready.tasks.find((value: { id: string }) => value.id !== task.id);
  for (const [path, body] of [['/v1/work/claim', { taskId: other.id, worker: 'second' }], ['/v1/work/progress', { taskId: task.id, leaseToken: claim.leaseToken, progress: 'copied' }],
    ['/v1/work/submit', { taskId: task.id, leaseToken: claim.leaseToken, evidence: [{ path: await evidence(f.project, 'second.txt'), note: 'copied lease' }] }]] as const) {
    const refused = await f.bearer(secondCredential, path, body); assert.deepEqual([refused.status, refused.body.error], [403, 'SCOPE'], 'second incarnation ' + path);
  }
  assert.equal(f.work.task(task.id).state, 'in_progress'); assert.equal(f.work.task(other.id).state, 'pending');
  const created = data(await second('work_create', { title: 'Second chat', objective: 'Unbound', tasks: [{ key: 's', title: 't', instructions: 'i', acceptance: 'a', scope: ['src/s'], dependencies: [] }] }));
  const own = data(await second('work_claim', { taskId: created.run.tasks[0].id, worker: 'second chat' }));
  assert.equal(own.task.state, 'in_progress', 'the second incarnation keeps its unbound cooperative workflow');
  await bound.finishFinal();
});

test('no unhandled rejections', async () => { await delay(20); assert.deepEqual(unhandled, []); });
