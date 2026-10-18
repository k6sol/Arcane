import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
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
  const assets = await createAssetService({ cwd: process.env.ARCANE_TASK_PLAN_PRODUCT_ROOT ?? process.cwd(), projectPath: project, outputRoot: join(root, 'assets') });
  const tokens: string[] = [], providers: CodexSession[] = [], agents: Client[] = [], servers: { close(): Promise<void> }[] = [];
  let proposals = 0;
  const proposalWorker: ChatTaskProposalFactory = async () => ({
    propose: async () => { proposals++; return { threadId: 'worker.thread', sessionId: null, turnId: 'worker.turn:' + proposals, text: 'Suggestion ' + proposals + ': keep the change bounded.' }; },
    close: async () => {} });
  const lab = await createConnectionLab({ cwd: process.env.ARCANE_TASK_PLAN_PRODUCT_ROOT ?? process.cwd(), stateDirectory: join(root, 'lab'), projectPath: project, studioStore: studio, workStore: work, assetService: assets,
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

const browserModule=process.env.ARCANE_UI_BROWSER_MODULE,productRoot=process.env.ARCANE_TASK_PLAN_PRODUCT_ROOT;
test('owned Edge: actual product boot opens exact older evidence, fences pagehide navigation and keeps review human',
  {skip:!browserModule||!productRoot,timeout:60000},async t=>{
  const f=await fixture(t),bound=await f.boundPlan();
  // Put the bound run outside the recent-run window without changing its authority.
  for(let index=0;index<101;index++)f.work.create({title:'Recent fixture '+index,objective:'Read-only navigation fixture',tasks:[{key:'recent',title:'Recent task',instructions:'Inspect only',acceptance:'Human review',scope:['recent/'+index],dependencies:[]}]});
  assert.equal(f.work.runsReadOnly().some(run=>run.id===bound.runId),false);
  assert.equal((await f.bearer(f.lab.token,'/v1/work/runs/'+bound.runId)).status,200);
  const core=await f.human('/v1/product/mcp-token',{});
  assert.equal((await f.bearer(core.body.token,'/v1/work/runs/'+bound.runId)).status,403);
  const {chromium}=await import(pathToFileURL(resolve(browserModule!)).href) as typeof import('playwright-core');
  const browser=await chromium.launch({headless:true,executablePath:process.env.ARCANE_UI_BROWSER_EXE??'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:390,height:844}}),errors:string[]=[],csp:string[]=[],effects:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(/Content Security Policy/i.test(message.text()))csp.push(message.text());});
  page.on('request',request=>{if(request.method()==='POST'&&/\/v1\/(?:codex\/action|studio\/(?:commands|restore)|work\/(?:claim|submit|review))/.test(new URL(request.url()).pathname))effects.push(request.url());});
  await page.goto(f.lab.origin+'/studio#'+f.lab.token);
  const card=page.locator('#codex-task-plan'),button=card.getByRole('button',{name:'Open evidence'});
  await button.waitFor();assert.match(await card.innerText(),/sent, waiting for result[\s\S]*Evidence not submitted yet/);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'actual boot fits 390px');
  if(process.env.ARCANE_TASK_PLAN_DESKTOP_SCREENSHOT){
    await button.scrollIntoViewIfNeeded();
    await writeFile(process.env.ARCANE_TASK_PLAN_DESKTOP_SCREENSHOT.replace(/\.png$/,'-chat.png'),await page.screenshot());
  }
  // Hold the real exact-run response across pagehide. Its old navigation must not open settings.
  let held=false,release!:()=>void;const gate=new Promise<void>(done=>{release=done;});
  await page.route('**/v1/work/runs/'+bound.runId,async route=>{held=true;await gate;await route.continue();});
  await button.focus();await page.keyboard.press('Enter');await until(()=>held,'exact-run request');
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));release();
  await until(async()=>await page.locator('#codex-task-plan').isHidden(),'stopped task card');
  assert.equal(await page.locator('#settings-drawer').evaluate(node=>(node as HTMLDialogElement).open),false);
  await page.unroute('**/v1/work/runs/'+bound.runId);
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));
  await button.waitFor();await button.click();
  await page.waitForFunction(id=>(document.getElementById('work-run-picker') as HTMLSelectElement)?.value===id&&
    (document.getElementById('settings-drawer') as HTMLDialogElement)?.open,bound.runId);
  assert.equal(await page.locator('#work-task-detail').isVisible(),true);
  assert.match(await page.locator('#work-task-evidence').innerText(),/No evidence submitted/);
  assert.equal(await page.locator('#work-review-form').isHidden(),true,'pending evidence offers no approval');
  // A normal work refresh must retain and re-read a selected run outside the recent 100.
  await page.locator('#work-refresh').evaluate(node=>(node as HTMLButtonElement).click());
  await page.waitForFunction(id=>(document.getElementById('work-run-picker') as HTMLSelectElement)?.value===id,bound.runId);
  if(process.env.ARCANE_TASK_PLAN_DESKTOP_SCREENSHOT){
    await page.locator('#work-task-detail').scrollIntoViewIfNeeded();
    await writeFile(process.env.ARCANE_TASK_PLAN_DESKTOP_SCREENSHOT.replace(/\.png$/,'-evidence.png'),await page.screenshot({fullPage:true}));
  }
  assert.equal(f.work.runById(bound.runId).tasks.every(task=>task.state==='pending'&&task.leaseUntil===null),true,'navigation never claims or submits');
  assert.deepEqual(effects,[]);assert.deepEqual(errors,[]);assert.deepEqual(csp,[]);
  assert.equal((await f.turnStarts()).length,3);assert.equal(f.studio.commands().length,0);assert.deepEqual(unhandled,[]);
  t.diagnostic('Actual product HTML/CSS/boot/modules and local lab HTTP; real Edge '+browser.version()+', owned scripted native turns only; no Studio or provider inference.');
});
