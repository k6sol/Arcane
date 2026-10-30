import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { connectCodexClient, CODEX_LIMITS, MCP_TOOL_SUMMARY_LIMITS, summarizeMcpToolCall } from '../../packages/codex-client/src/index.js';
import { CodexSession } from '../../packages/codex-client/src/session.js';
import { limits } from '../../packages/codex-client/src/validation.js';
import { nativeEnvironment, JsonlTransport, readNativeFrameEvidence, annotateNativeConnectFrame } from '../../packages/codex-client/src/transport.js';
import { prepareCodexProcess } from '../../packages/codex-client/src/mcp-profile.js';
import { ARCANE_TOOL_NAMES, ARCANE_TASK_INSTRUCTIONS } from '../../packages/protocol/src/arcane-tools.js';
import { PROJECT_MEMORY_GUIDANCE, projectMemorySection, readProjectMemory } from '../../packages/core/src/project-memory.js';
import {arcaneIsolationOverrides,arcaneThreadIsIsolated} from '../../packages/codex-client/src/mcp-isolation.js';
import type { Approval, ArcaneMcpLaunchProfile, LimitOptions, SessionEventValue } from '../../packages/codex-client/src/types.js';
import {referencePng,referenceInput} from '../../packages/codex-client/testing/reference-fixture.js';
import {summarizeMcpToolFailure,readMcpToolFailure,mcpToolFailureEnvelope} from '../../packages/codex-client/src/tool-failure.js';

const ROOT = resolve(process.cwd());
const TEMP = join(ROOT, 'packages','codex-client','.test-output','fixtures');
const HUMAN = { initiatedBy: 'human' } as const;
const PAIR = { model: 'fixture-sol', effort: 'ultra' };
const THREAD = 'fixture-thread';
const INPUT = { ...HUMAN, threadId: THREAD, text: 'Synthetic human input\nhéllo 🌕' };
type Receipt = { type: string; cwd?: string; envKeys?: string[]; argv?: string[]; arcaneDaemonUrl?: string | null; arcaneTokenSha256?: string | null; historyBytes?:number;excluded?:boolean;message?: { id?: number | string; method?: string; params?: Record<string, unknown>; result?: { decision?: string }; error?: { code?: number } } };
const code = (expected: string) => (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === expected;
async function until(predicate: () => boolean | Promise<boolean>, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!await predicate()) { if(Date.now() >= deadline) assert.fail('Timed out waiting for fixture evidence.'); await delay(5); }
}
async function fixture(t: test.TestContext, mode = 'normal', overrides: LimitOptions = {}, initialize = true, profile?: ArcaneMcpLaunchProfile, mcpPolicy:'native-config'|'arcane-only'='native-config') {
  await mkdir(TEMP, {recursive:true});
  const dir = await mkdtemp(join(TEMP,'session-'));
  const audit = join(dir,'audit.jsonl');
  const planned = await prepareCodexProcess(process.execPath, ROOT, profile, join(ROOT,'dist','apps','mcp','src','main.js'));
  const testBounds = limits({requestTimeoutMs:5000, approvalTimeoutMs:1000, ...overrides});
  const actionTimeout = testBounds.requestTimeoutMs;
  // OS/OneDrive startup is separate from the short lost-ack action deadlines under test.
  Object.assign(testBounds, {requestTimeoutMs:Math.max(5000, actionTimeout)});
  const session = new CodexSession({
    command: process.execPath, args: [join(ROOT,'packages','codex-client','fixtures','protocol.mjs'),mode,audit,...planned.args],
    cwd: ROOT, env: planned.env,
  }, testBounds, 'spawned-node-fixture',mcpPolicy,undefined,undefined,mcpPolicy==='arcane-only'?async (cwd:string)=>projectMemorySection((await readProjectMemory(cwd)).text):undefined);
  t.after(async () => {
    await session.close();
    const child = relative(TEMP,dir);
    assert.ok(child.startsWith('session-') && !child.includes(sep) && !child.includes('..'));
    await rm(dir,{recursive:true,force:true});
  });
  const receipts = async (): Promise<Receipt[]> => {
    try { return (await readFile(audit,'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Receipt); }
    catch { return []; }
  };
  if(initialize) await session.initialize();
  Object.assign(testBounds, {requestTimeoutMs:actionTimeout});
  return { session, receipts, dir, launchArgs: planned.args };
}
async function open(t: test.TestContext, mode = 'normal', overrides: LimitOptions = {}) {
  const context = await fixture(t,mode,overrides);
  context.session.selectModel({...HUMAN,...PAIR});
  await context.session.startThread(HUMAN);
  return context;
}
function answer(approval: Approval, decision: 'accept' | 'decline' | 'cancel' = 'accept') {
  return { ...HUMAN, handle:approval.handle,connectionId:approval.connectionId,threadId:approval.threadId,turnId:approval.turnId,decision };
}
const inputs = (records: Receipt[]) => records.flatMap(record => record.message ? [record.message] : []);
const replies = (records: Receipt[]) => inputs(records).filter(message => !message.method);

test('actual native peer receives original inline PNG with text; echoed media stays out of public state',async t=>{
  const f=await open(t,'image-input'),references=[referenceInput()];
  await f.session.startTurn({...INPUT,references});
  const sent=inputs(await f.receipts()).find(message=>message.method==='turn/start')!.params!;
  assert.deepEqual(sent.input,[{type:'text',text:INPUT.text,text_elements:[]},{type:'image',url:references[0]!.dataUrl}]);
  assert.deepEqual(f.session.snapshot().models[0]!.inputModalities,['text','image']);assert.equal(f.session.snapshot().models[0]!.inputModalitiesSource,'reported');
  assert.ok(!JSON.stringify(f.session.snapshot()).includes('data:image/'));
});
test('turn/start sends the user text unchanged: the pinned protocol has no per-turn developer note for the Playtest switch',async t=>{
  // TurnStartParams carries no developer/collaboration instructions, so the composer's Playtest switch reaches ChatGPT only
  // through automatic approval of its playtest requests (playtest-panel.ts), never as text added to the user's message.
  const pinned=await readFile(resolve('packages/codex-client/.protocol/v2/TurnStartParams.ts'),'utf8');
  assert.doesNotMatch(pinned,/developerInstructions|collaborationMode|instructions\??:/);
  const f=await open(t,'image-input');await f.session.startTurn(INPUT);
  const sent=inputs(await f.receipts()).find(message=>message.method==='turn/start')!.params!;
  assert.deepEqual(sent.input,[{type:'text',text:INPUT.text,text_elements:[]}]);
  assert.deepEqual(Object.keys(sent).sort(),['approvalPolicy','approvalsReviewer','cwd','effort','input','model','sandboxPolicy','threadId']);
});
test('native catalogue image denial is not replaced by an assumed capability',async t=>{
  const f=await open(t,'image-text-only');await assert.rejects(()=>f.session.startTurn({...INPUT,references:[referenceInput()]}),code('IMAGE_UNSUPPORTED'));
  assert.equal(inputs(await f.receipts()).filter(message=>message.method==='turn/start').length,0);assert.equal(f.session.snapshot().thread!.writeGranted,false);
  await f.session.startTurn(INPUT);assert.equal(inputs(await f.receipts()).filter(message=>message.method==='turn/start').length,1);
});
test('old catalogue uses documented modality compatibility while references remain initial human input only',async t=>{
  const f=await open(t);assert.deepEqual(f.session.snapshot().models[0]!.inputModalities,['text','image']);assert.equal(f.session.snapshot().models[0]!.inputModalitiesSource,'compatibility-default');
  await f.session.startTurn({...INPUT,references:[referenceInput()]});
  await assert.rejects(()=>f.session.continueTask({continuation:{kind:'native-task-continuation'},text:'not a new human input',references:[referenceInput()]} as never),code('ARGUMENTS'));
});
test('whole native frame budget includes JSON-escaped caption and PNG; failure creates no operation or grant',async t=>{
  const f=await open(t),before=f.session.snapshot().operations.length;
  await assert.rejects(()=>f.session.startTurn({...INPUT,text:'\u0001'.repeat(131072),allowWorkspaceWrites:true,references:[referenceInput(referencePng(128,128,512*1024))]}),code('FRAME_LIMIT'));
  assert.equal(f.session.snapshot().operations.length,before);assert.equal(f.session.snapshot().thread!.writeGranted,false);
  assert.equal(inputs(await f.receipts()).filter(message=>message.method==='turn/start').length,0);
});

test('resume excludes two maximal prior images; a bounded history-read refusal preserves the exact live client',async t=>{
  const f=await fixture(t,'image-history-resume'),image=referenceInput(referencePng(128,128,512*1024));
  const history=[1,2].map(n=>({id:'earlier-turn-'+n,status:'completed',error:null,items:[{type:'userMessage',id:'earlier-image-'+n,
    content:[{type:'text',text:'Earlier human caption '+n,text_elements:[]},{type:'image',url:image.dataUrl}]}]}));
  assert.ok(Buffer.byteLength(JSON.stringify(history))>CODEX_LIMITS.maxFrameBytes);
  await writeFile(join(f.dir,'image-history.json'),JSON.stringify(history),{flag:'wx'});
  f.session.selectModel({...HUMAN,...PAIR});await f.session.resumeThread({...HUMAN,threadId:THREAD});
  const receipts=await f.receipts(),resume=inputs(receipts).find(row=>row.method==='thread/resume')!;
  assert.equal(resume.params!.threadId,THREAD);assert.equal(resume.params!.excludeTurns,true);
  const originalHistory=receipts.find(row=>row.type==='image-history')!;assert.equal(originalHistory.excluded,true);assert.ok(originalHistory.historyBytes!>CODEX_LIMITS.maxFrameBytes);
  const connection=f.session.snapshot().connectionId;
  await f.session.startTurn({...INPUT,references:[referenceInput()]});assert.equal(f.session.snapshot().thread!.turnStatus,'completed');
  const before=f.session.snapshot();await assert.rejects(()=>f.session.readThreadHistory({...HUMAN,threadId:THREAD,sessionId:'fixture-session-root'}),code('FRAME_LIMIT'));
  const after=f.session.snapshot();assert.equal(after.connectionId,connection);assert.equal(after.connected,true);assert.equal(after.ready,true);assert.equal(after.failureCode,null);
  assert.deepEqual(after.thread,before.thread);assert.deepEqual(after.operations,before.operations);assert.ok(!JSON.stringify(after).includes('data:image/'));
  await f.session.startTurn(INPUT);assert.equal(f.session.snapshot().thread!.turnStatus,'completed');
  assert.equal(inputs(await f.receipts()).filter(row=>row.method==='turn/start').length,2);
});

test('real Node stdio handshake, interleaved out-of-order IDs, pagination and sanitized account',async t=>{
  const {session,receipts}=await fixture(t);
  assert.deepEqual(session.snapshot().account,{auth:'subscription',plan:'pro',requiresOpenaiAuth:true});
  assert.deepEqual(session.snapshot().models.map(model=>model.model),['fixture-sol','fixture-other']);
  assert.deepEqual(session.snapshot().models[0]?.efforts,['low','ultra']);
  const json=JSON.stringify(session.snapshot());
  assert.ok(!json.includes('FIXTURE_SECRET') && !json.includes('synthetic@example.test'));
  assert.equal(session.snapshot().provenance,'spawned-node-fixture');
  const log=inputs(await receipts());
  assert.deepEqual(log.map(message=>message.method),['initialize','initialized','account/read','model/list','model/list']);
  assert.deepEqual(log[0]?.params?.capabilities,{experimentalApi:false});
  assert.deepEqual(log[2]?.params,{refreshToken:false});
  assert.deepEqual(log[4]?.params,{limit:100,includeHidden:false,cursor:'page-two'});
  const ids=log.filter(message=>message.id!==undefined).map(message=>message.id);
  assert.equal(new Set(ids).size,ids.length);
  await assert.rejects(()=>session.initialize(),code('STATE'));
});

test('installed factory rejects hosted use, relative/wrapper commands and extra env/config/HTTP fields before spawn',async()=>{
  const base={command:process.execPath,cwd:ROOT,use:'personal-local'} as const;
  for(const field of ['args','env','config','method','url','refreshToken','apiKey']) {
    await assert.rejects(()=>connectCodexClient({...base,[field]:{synthetic:true}} as never),code('ARGUMENTS'));
  }
  await assert.rejects(()=>connectCodexClient({...base,use:'commercial-hosted'} as never),code('LOCAL_USE_ONLY'));
  await assert.rejects(()=>connectCodexClient({...base,command:'codex'}),code('PROCESS_PATH'));
  await assert.rejects(()=>connectCodexClient(base),code('PROCESS_PATH'));
  assert.throws(()=>limits({requestTimeoutMs:0}),code('ARGUMENTS'));
  assert.throws(()=>limits({maxFrameBytes:CODEX_LIMITS.maxFrameBytes+1}),code('ARGUMENTS'));
});

test('child environment has no auth/endpoint overrides, while cwd is an exact absolute workspace',async t=>{
  const old=process.env.OPENAI_API_KEY; const oldHome=process.env.CODEX_HOME; const oldEndpoint=process.env.OPENAI_BASE_URL;
  process.env.OPENAI_API_KEY='SYNTHETIC'; process.env.CODEX_HOME='SYNTHETIC'; process.env.OPENAI_BASE_URL='SYNTHETIC';
  try {
    const {receipts}=await fixture(t);
    const spawn=(await receipts()).find(record=>record.type==='spawn');
    assert.equal(spawn?.cwd,ROOT);
    for(const key of ['OPENAI_API_KEY','CODEX_HOME','OPENAI_BASE_URL','CODEX_AUTH_JSON']) assert.ok(!spawn?.envKeys?.includes(key));
  } finally {
    for(const [key,value] of [['OPENAI_API_KEY',old],['CODEX_HOME',oldHome],['OPENAI_BASE_URL',oldEndpoint]]) {
      if(value===undefined) delete process.env[key!]; else process.env[key!]=value;
    }
  }
});

test('human selection is exact: aliases, unsupported efforts, unknown fields and automatic actions fail',async t=>{
  const {session,receipts}=await fixture(t);
  assert.throws(()=>session.selectModel({...HUMAN,model:'picker-fixture-sol',effort:'ultra'}),code('SELECTION'));
  assert.throws(()=>session.selectModel({...HUMAN,...PAIR,effort:'high'}),code('SELECTION'));
  assert.throws(()=>session.selectModel({...PAIR,initiatedBy:'agent'} as never),code('HUMAN_REQUIRED'));
  await assert.rejects(()=>session.startThread(HUMAN),code('SELECTION'));
  session.selectModel({...HUMAN,...PAIR});
  await assert.rejects(()=>session.startThread({initiatedBy:'agent'} as never),code('HUMAN_REQUIRED'));
  await assert.rejects(()=>session.startThread({...HUMAN,config:{}} as never),code('ARGUMENTS'));
  assert.ok(!inputs(await receipts()).some(message=>message.method==='thread/start'));
});

test('thread defaults to native human review/read-only; turn sends the selected effort without arbitrary config',async t=>{
  const {session,receipts}=await open(t);
  const thread=session.snapshot().thread!;
  assert.equal(thread.writeGranted,false);
  assert.equal(thread.sessionId,'fixture-session-root');
  await session.startTurn(INPUT);
  await until(async()=>inputs(await receipts()).some(message=>message.method==='turn/start'));
  const log=inputs(await receipts());
  assert.deepEqual(log.find(message=>message.method==='thread/start')?.params,{
    model:PAIR.model,modelProvider:'openai',cwd:ROOT,approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:'read-only',
  });
  const turn=log.find(message=>message.method==='turn/start')?.params;
  assert.equal(turn?.model,PAIR.model); assert.equal(turn?.effort,'ultra');
  assert.deepEqual(turn?.sandboxPolicy,{type:'readOnly',networkAccess:false});
  assert.deepEqual(turn?.input,[{type:'text',text:INPUT.text,text_elements:[]}]);
  assert.equal(turn?.approvalsReviewer,'user');
  assert.ok(!Object.hasOwn(turn!,'config'));
  assert.throws(()=>session.selectModel({...HUMAN,...PAIR}),code('STATE')); // Active turn, including same-pair actions.
  assert.throws(()=>session.selectModel({...HUMAN,model:'fixture-other',effort:'low'}),code('STATE'));
  assert.deepEqual(session.snapshot().selection,PAIR);
  await assert.rejects(()=>session.startTurn(INPUT),code('BUSY'));
});

test('human write grant is exact-thread, defensive and only changes subsequent turn sandbox',async t=>{
  const {session,receipts}=await open(t);
  const copy=session.snapshot(); copy.thread!.writeGranted=true;
  assert.equal(session.snapshot().thread?.writeGranted,false);
  assert.throws(()=>session.grantThreadWrites({...HUMAN,threadId:'other'}),code('THREAD'));
  assert.throws(()=>session.grantThreadWrites({initiatedBy:'agent',threadId:THREAD} as never),code('HUMAN_REQUIRED'));
  session.grantThreadWrites({...HUMAN,threadId:THREAD});
  await session.startTurn(INPUT);
  const turn=inputs(await receipts()).find(message=>message.method==='turn/start')?.params;
  assert.deepEqual(turn?.sandboxPolicy,{type:'workspaceWrite',writableRoots:[ROOT],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true});
  session.revokeThreadWrites({...HUMAN,threadId:THREAD});
  assert.equal(session.snapshot().connected,false);
  assert.equal(session.snapshot().thread?.writeGranted,false);
});

test('human Send enables only its exact turn sandbox and expires before a terminal-before-ACK response',async t=>{
  const {session,receipts}=await open(t,'complete-before-ack');
  assert.equal(session.snapshot().thread?.writeGranted,false);
  const completed=await session.startTurn({...INPUT,allowWorkspaceWrites:true});
  assert.equal(completed.turnStatus,'completed');assert.equal(completed.writeGranted,false);
  assert.equal(session.snapshot().thread?.writeGranted,false);
  await session.startTurn(INPUT);
  await session.startTurn({...INPUT,allowWorkspaceWrites:false});
  const turns=inputs(await receipts()).filter(message=>message.method==='turn/start');
  assert.equal(turns.length,3);
  assert.deepEqual(turns[0]?.params?.sandboxPolicy,{type:'workspaceWrite',writableRoots:[ROOT],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true});
  for(const message of turns.slice(1))assert.deepEqual(message.params?.sandboxPolicy,{type:'readOnly',networkAccess:false});
  for(const message of turns){
    assert.equal(message.params?.cwd,ROOT);assert.equal(message.params?.approvalPolicy,'on-request');assert.equal(message.params?.approvalsReviewer,'user');
    assert.equal(Object.hasOwn(message.params!,'allowWorkspaceWrites'),false,'Human host intent is not provider metadata.');
  }
});

test('a delayed terminal from an earlier turn cannot clear the newer automatic write operation',async t=>{
  const {session,receipts}=await open(t,'stale-turn-event');
  await session.startTurn({...INPUT,allowWorkspaceWrites:true});
  assert.equal(session.snapshot().thread?.turnStatus,'completed');assert.equal(session.snapshot().thread?.writeGranted,false);
  await session.startTurn({...INPUT,allowWorkspaceWrites:true});
  const current=session.snapshot();
  assert.equal(current.connected,true);assert.equal(current.thread?.turnId,'fixture-turn-2');
  assert.equal(current.thread?.turnStatus,'inProgress');assert.equal(current.thread?.writeGranted,true);
  assert.equal(current.operations.at(-1)?.turnId,'fixture-turn-2');
  assert.equal(inputs(await receipts()).filter(message=>message.method==='turn/start').length,2);
  await session.interruptTurn({...HUMAN,threadId:THREAD,turnId:'fixture-turn-2'});
  assert.equal(session.snapshot().thread?.writeGranted,false);
  await until(()=>session.snapshot().thread?.turnStatus==='interrupted');
});

for(const [mode,turnId] of [['lost-turn-no-id',null],['lost-turn-ack','fixture-turn-1']] as const)
test('unknown automatic start stops the owned client without asset hooks or replay: '+mode,async t=>{
  const {session,receipts}=await open(t,mode,{requestTimeoutMs:1500});
  await assert.rejects(()=>session.startTurn({...INPUT,allowWorkspaceWrites:true}),error=>{
    assert.ok(code('TIMEOUT')(error));assert.equal((error as {dispatched:boolean}).dispatched,true);return true;
  });
  const unknown=session.snapshot();
  assert.equal(unknown.connected,false);assert.equal(unknown.ready,false);assert.equal(unknown.failureCode,'TIMEOUT');
  assert.equal(unknown.thread?.writeGranted,false);assert.equal(unknown.thread?.turnStatus,'unknown');assert.equal(unknown.thread?.turnId,turnId);
  assert.equal(unknown.operations.at(-1)?.state,'unknown');assert.equal(unknown.operations.at(-1)?.turnId,turnId);
  await assert.rejects(()=>session.startTurn({...INPUT,allowWorkspaceWrites:true}),code('DISCONNECTED'));
  const turns=inputs(await receipts()).filter(message=>message.method==='turn/start');assert.equal(turns.length,1);
  assert.equal((turns[0]?.params?.sandboxPolicy as {type:string}).type,'workspaceWrite');
});

test('an automatic frame refusal clears permission before dispatch and a later ordinary turn stays read-only',async t=>{
  const {session,receipts}=await open(t,'normal',{maxFrameBytes:2048});
  await assert.rejects(()=>session.startTurn({...INPUT,text:'x'.repeat(2000),allowWorkspaceWrites:true}),error=>{
    assert.ok(code('FRAME_LIMIT')(error));assert.equal((error as {dispatched:boolean}).dispatched,false);return true;
  });
  const refused=session.snapshot();
  assert.equal(refused.connected,true);assert.equal(refused.thread?.writeGranted,false);assert.equal(refused.thread?.turnStatus,'idle');
  assert.equal(refused.operations.at(-1)?.state,'not-sent');assert.equal(refused.operations.at(-1)?.errorCode,'FRAME_LIMIT');
  assert.equal(inputs(await receipts()).some(message=>message.method==='turn/start'),false);
  await session.startTurn(INPUT);
  const turns=inputs(await receipts()).filter(message=>message.method==='turn/start');assert.equal(turns.length,1);
  assert.deepEqual(turns[0]?.params?.sandboxPolicy,{type:'readOnly',networkAccess:false});
  assert.equal(session.snapshot().thread?.writeGranted,false);
});

test('a lost automatic ACK still closes the owned client after an earlier terminal event expired its active grant',async t=>{
  const {session,receipts}=await open(t,'terminal-before-lost-ack',{requestTimeoutMs:1500});
  const starting=session.startTurn({...INPUT,allowWorkspaceWrites:true});
  const rejected=assert.rejects(starting,code('TIMEOUT'));
  await until(()=>session.snapshot().thread?.turnStatus==='completed');
  const terminal=session.snapshot();
  assert.equal(terminal.connected,true);assert.equal(terminal.thread?.writeGranted,false);
  assert.equal(terminal.thread?.turnId,'fixture-turn-1');assert.equal(terminal.operations.at(-1)?.state,'pending');
  await rejected;
  const unknown=session.snapshot();
  assert.equal(unknown.connected,false);assert.equal(unknown.ready,false);assert.equal(unknown.failureCode,'TIMEOUT');
  assert.equal(unknown.thread?.writeGranted,false);assert.equal(unknown.thread?.turnStatus,'completed','Keep the observed terminal event without inventing an ACK.');
  assert.equal(unknown.operations.at(-1)?.state,'unknown');assert.equal(unknown.operations.at(-1)?.turnId,'fixture-turn-1');
  await assert.rejects(()=>session.startTurn(INPUT),code('DISCONNECTED'));
  assert.equal(inputs(await receipts()).filter(message=>message.method==='turn/start').length,1);
});

test('revoking an automatic write start before its first turn ID fences the dispatched client',async t=>{
  const {session,receipts}=await open(t,'revoke-start-no-id');
  const starting=session.startTurn({...INPUT,allowWorkspaceWrites:true});
  const rejected=assert.rejects(starting,code('GRANT_REVOKED'));
  await until(async()=>inputs(await receipts()).some(message=>message.method==='turn/start'));
  const pending=session.snapshot();
  assert.equal(pending.thread?.turnStatus,'starting');assert.equal(pending.thread?.turnId,null);assert.equal(pending.thread?.writeGranted,true);
  session.revokeThreadWrites({...HUMAN,threadId:THREAD});await rejected;
  const revoked=session.snapshot();
  assert.equal(revoked.connected,false);assert.equal(revoked.failureCode,'GRANT_REVOKED');assert.equal(revoked.thread?.writeGranted,false);
  assert.equal(revoked.thread?.turnStatus,'unknown');assert.equal(revoked.operations.at(-1)?.state,'unknown');
  assert.equal(inputs(await receipts()).filter(message=>message.method==='turn/start').length,1);
});

test('revoking automatic writes during an acknowledged active turn stops native execution',async t=>{
  const {session,receipts}=await open(t);
  await session.startTurn({...INPUT,allowWorkspaceWrites:true});
  assert.equal(session.snapshot().thread?.writeGranted,true);assert.equal(session.snapshot().thread?.turnStatus,'inProgress');
  session.revokeThreadWrites({...HUMAN,threadId:THREAD});
  const revoked=session.snapshot();
  assert.equal(revoked.connected,false);assert.equal(revoked.thread?.writeGranted,false);assert.equal(revoked.thread?.turnStatus,'unknown');
  await assert.rejects(()=>session.startTurn(INPUT),code('DISCONNECTED'));
  assert.equal(inputs(await receipts()).filter(message=>message.method==='turn/start').length,1);
});

test('omitted, false and automatic Send flags preserve an existing deliberate persistent write grant',async t=>{
  const {session,receipts}=await open(t,'complete-before-ack');session.grantThreadWrites({...HUMAN,threadId:THREAD});
  for(const flags of [{},{allowWorkspaceWrites:false},{allowWorkspaceWrites:true},{}]){
    const completed=await session.startTurn({...INPUT,...flags});
    assert.equal(completed.turnStatus,'completed');assert.equal(completed.writeGranted,true);
  }
  const turns=inputs(await receipts()).filter(message=>message.method==='turn/start');assert.equal(turns.length,4);
  for(const message of turns)assert.deepEqual(message.params?.sandboxPolicy,{type:'workspaceWrite',writableRoots:[ROOT],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true});
  session.revokeThreadWrites({...HUMAN,threadId:THREAD});assert.equal(session.snapshot().thread?.writeGranted,false);
});

test('automatic write intent requires a boolean, human action and exact current thread before any operation',async t=>{
  const {session,receipts}=await open(t),before=session.snapshot();
  for(const value of [undefined,null,'true',1,{},[]])await assert.rejects(()=>session.startTurn({...INPUT,allowWorkspaceWrites:value} as never),code('ARGUMENTS'));
  await assert.rejects(()=>session.startTurn({...INPUT,initiatedBy:'agent',allowWorkspaceWrites:true} as never),code('HUMAN_REQUIRED'));
  await assert.rejects(()=>session.startTurn({...INPUT,threadId:'foreign-thread',allowWorkspaceWrites:true}),code('THREAD'));
  assert.deepEqual(session.snapshot(),before);assert.equal(inputs(await receipts()).some(message=>message.method==='turn/start'),false);
});

test('revoking writes before any turn ID or ACK stops the dispatched workspaceWrite client',async t=>{
  const {session,receipts}=await open(t,'revoke-start-no-id');
  session.grantThreadWrites({...HUMAN,threadId:THREAD});
  const starting=session.startTurn(INPUT);
  const rejected=assert.rejects(starting,code('GRANT_REVOKED'));
  await until(async()=>inputs(await receipts()).some(message=>message.method==='turn/start'));
  const before=session.snapshot();
  assert.equal(before.thread?.turnStatus,'starting');
  assert.equal(before.thread?.turnId,null);
  assert.equal(before.operations.at(-1)?.state,'pending');
  session.revokeThreadWrites({...HUMAN,threadId:THREAD});
  await rejected;
  const after=session.snapshot();
  assert.equal(after.connected,false);
  assert.equal(after.failureCode,'GRANT_REVOKED');
  assert.equal(after.thread?.writeGranted,false);
  assert.equal(after.thread?.turnStatus,'unknown');
  assert.equal(after.thread?.turnId,null);
  assert.equal(after.operations.at(-1)?.state,'unknown');
  assert.equal(after.operations.at(-1)?.errorCode,'GRANT_REVOKED');
  assert.equal(after.operations.at(-1)?.turnId,null);
  await assert.rejects(()=>session.startTurn(INPUT),code('DISCONNECTED'));
  const dispatched=inputs(await receipts()).filter(message=>message.method==='turn/start');
  assert.equal(dispatched.length,1);
  assert.deepEqual(dispatched[0]?.params?.sandboxPolicy,{type:'workspaceWrite',writableRoots:[ROOT],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true});
});

for(const kind of ['command','file']) test('a previous-turn '+kind+' approval cannot adopt the ID of a new pending start',async t=>{
  const {session,receipts}=await open(t,'stale-approval-before-turn-id-'+kind);
  session.grantThreadWrites({...HUMAN,threadId:THREAD});
  await session.startTurn(INPUT);
  assert.equal(session.snapshot().thread?.turnStatus,'completed');
  const starting=session.startTurn(INPUT);
  // Register a rejection observer immediately so fixture cleanup cannot leave an unhandled promise.
  starting.catch(()=>undefined);
  assert.equal(session.snapshot().thread?.turnId,null);
  await until(()=>session.snapshot().approvals.some(entry=>entry.serverRequestId===702));
  const pending=session.snapshot();
  assert.equal(pending.connected,true);
  assert.equal(pending.thread?.turnId,'fixture-turn-2');
  assert.equal(pending.thread?.turnStatus,'starting');
  assert.equal(pending.operations.at(-1)?.state,'pending');
  assert.equal(pending.operations.at(-1)?.turnId,'fixture-turn-2');
  assert.deepEqual(pending.approvals.map(entry=>[entry.serverRequestId,entry.turnId,entry.canAccept]),[[702,'fixture-turn-2',true]]);
  assert.ok(!pending.events.some(event=>event.type==='approval'&&event.turnId==='fixture-turn-1'));
  const approval=pending.approvals[0]!;
  session.respondApproval(answer(approval,'decline'));
  await starting;
  await until(async()=>replies(await receipts()).length===2);
  assert.deepEqual(replies(await receipts()).map(reply=>[reply.id,reply.result?.decision]),[[701,'cancel'],[702,'decline']]);
  assert.equal(session.snapshot().thread?.turnId,'fixture-turn-2');
  assert.equal(session.snapshot().thread?.turnStatus,'inProgress');
  assert.equal(session.snapshot().operations.at(-1)?.state,'acknowledged');
  assert.equal(inputs(await receipts()).filter(message=>message.method==='turn/start').length,2);
});

test('a fresh approval can supply the first turn ID before notifications or ACK',async t=>{
  const {session,receipts}=await open(t,'approval-before-turn-id');
  const starting=session.startTurn(INPUT);
  starting.catch(()=>undefined);
  await until(()=>session.snapshot().approvals.length===1);
  const pending=session.snapshot();
  assert.equal(pending.thread?.turnId,'fixture-turn-1');
  assert.equal(pending.thread?.turnStatus,'starting');
  assert.equal(pending.operations.at(-1)?.turnId,'fixture-turn-1');
  assert.equal(pending.operations.at(-1)?.state,'pending');
  session.respondApproval(answer(pending.approvals[0]!,'decline'));
  await starting;
  assert.equal(session.snapshot().operations.at(-1)?.state,'acknowledged');
  assert.deepEqual(replies(await receipts()).map(reply=>[reply.id,reply.result?.decision]),[[702,'decline']]);
});

for(const method of ['thread/start','thread/resume'] as const) {
  for(const [mode,observed] of [['malformed-thread-ack-no-id',false],['malformed-thread-ack-observed',true]] as const) {
    test('malformed successful '+method+' ACK is dispatched unknown and disconnects: '+mode,async t=>{
      const {session,receipts}=await fixture(t,mode);
      session.selectModel({...HUMAN,...PAIR});
      await assert.rejects(()=>method==='thread/start'?session.startThread(HUMAN):session.resumeThread({...HUMAN,threadId:THREAD}),(error:unknown)=>{
        assert.ok(code('PROTOCOL')(error));
        assert.equal((error as {dispatched:boolean}).dispatched,true);
        return true;
      });
      const snapshot=session.snapshot();
      assert.equal(snapshot.connected,false);
      assert.equal(snapshot.failureCode,'PROTOCOL');
      assert.equal(snapshot.thread?.configured??false,false);
      assert.equal(snapshot.thread?.threadId??null,observed?THREAD:null);
      assert.equal(snapshot.operations.at(-1)?.state,'unknown');
      assert.equal(snapshot.operations.at(-1)?.errorCode,'PROTOCOL');
      assert.equal(snapshot.operations.at(-1)?.threadId,observed||method==='thread/resume'?THREAD:null);
      assert.ok(snapshot.operations.at(-1)?.requestId);
      await assert.rejects(()=>session.startThread(HUMAN),code('DISCONNECTED'));
      assert.equal(inputs(await receipts()).filter(message=>message.method===method).length,1);
    });
  }
}

for(const mode of ['malformed-thread-id','malformed-thread-sandbox']) test('malformed successful thread ACK fields require explicit recovery: '+mode,async t=>{
  const {session,receipts}=await fixture(t,mode);
  session.selectModel({...HUMAN,...PAIR});
  await assert.rejects(()=>session.startThread(HUMAN),(error:unknown)=>{
    assert.ok(code('PROTOCOL')(error)); assert.equal((error as {dispatched:boolean}).dispatched,true); return true;
  });
  const snapshot=session.snapshot();
  assert.equal(snapshot.connected,false);
  assert.equal(snapshot.failureCode,'PROTOCOL');
  assert.equal(snapshot.operations.at(-1)?.state,'unknown');
  assert.equal(snapshot.operations.at(-1)?.threadId,THREAD);
  assert.equal(snapshot.thread?.configured,false);
  await assert.rejects(()=>session.startThread(HUMAN),code('DISCONNECTED'));
  assert.equal(inputs(await receipts()).filter(message=>message.method==='thread/start').length,1);
});

for(const [mode,turnId] of [
  ['malformed-turn-ack-no-id',null],['malformed-turn-ack-observed','fixture-turn-1'],
  ['malformed-turn-id',null],['malformed-turn-status','fixture-turn-1'],
] as const) test('malformed successful turn ACK is dispatched unknown and never replayable: '+mode,async t=>{
  const {session,receipts}=await open(t,mode);
  session.grantThreadWrites({...HUMAN,threadId:THREAD});
  await assert.rejects(()=>session.startTurn(INPUT),(error:unknown)=>{
    assert.ok(code('PROTOCOL')(error)); assert.equal((error as {dispatched:boolean}).dispatched,true); return true;
  });
  const snapshot=session.snapshot();
  assert.equal(snapshot.connected,false);
  assert.equal(snapshot.failureCode,'PROTOCOL');
  assert.equal(snapshot.thread?.turnStatus,'unknown');
  assert.equal(snapshot.thread?.writeGranted,false);
  assert.equal(snapshot.thread?.turnId,turnId);
  assert.equal(snapshot.operations.at(-1)?.state,'unknown');
  assert.equal(snapshot.operations.at(-1)?.errorCode,'PROTOCOL');
  assert.equal(snapshot.operations.at(-1)?.turnId,turnId);
  assert.ok(snapshot.operations.at(-1)?.requestId);
  await assert.rejects(()=>session.startTurn(INPUT),code('DISCONNECTED'));
  assert.equal(inputs(await receipts()).filter(message=>message.method==='turn/start').length,1);
});

test('resume by exact human-selected ID uses safe overrides and creates no new thread',async t=>{
  const {session,receipts}=await fixture(t);
  session.selectModel({...HUMAN,...PAIR});
  await session.resumeThread({...HUMAN,threadId:THREAD});
  const log=inputs(await receipts());
  assert.ok(!log.some(message=>message.method==='thread/start'));
  assert.equal(log.find(message=>message.method==='thread/resume')?.params?.threadId,THREAD);
  assert.equal(log.find(message=>message.method==='thread/resume')?.params?.excludeTurns,true);
  assert.equal(session.snapshot().thread?.writeGranted,false);
});

test('active resumed metadata without a known turn ID stays unknown and cannot start another turn',async t=>{
  const {session,receipts}=await fixture(t,'resume-active-unknown');
  session.selectModel({...HUMAN,...PAIR});
  await session.resumeThread({...HUMAN,threadId:THREAD});
  assert.equal(session.snapshot().thread?.turnStatus,'unknown');
  await assert.rejects(()=>session.startTurn(INPUT),code('BUSY'));
  const requests=inputs(await receipts());assert.equal(requests.find(row=>row.method==='thread/resume')?.params?.excludeTurns,true);assert.equal(requests.filter(row=>row.method==='turn/start').length,0);
});

test('unexpected active turns in a metadata-only resume still fence a later Send',async t=>{
  const {session,receipts}=await fixture(t,'resume-unexpected-active');session.selectModel({...HUMAN,...PAIR});
  await session.resumeThread({...HUMAN,threadId:THREAD});assert.equal(session.snapshot().thread!.turnId,'existing-active-turn');assert.equal(session.snapshot().thread!.turnStatus,'inProgress');
  await assert.rejects(()=>session.startTurn(INPUT),code('BUSY'));
  const requests=inputs(await receipts());assert.equal(requests.find(row=>row.method==='thread/resume')?.params?.excludeTurns,true);assert.equal(requests.filter(row=>row.method==='turn/start').length,0);
});

for(const mode of ['bad-model','bad-reviewer','bad-sandbox']) test('fails closed on effective thread settings: '+mode,async t=>{
  const {session,receipts}=await fixture(t,mode);
  session.selectModel({...HUMAN,...PAIR});
  await assert.rejects(()=>session.startThread(HUMAN),code('SETTINGS_MISMATCH'));
  assert.equal(session.snapshot().connected,false);
  assert.equal(session.snapshot().thread?.configured,false);
  assert.equal(session.snapshot().operations[0]?.threadId,THREAD);
  assert.equal(session.snapshot().operations[0]?.state,'unknown');
  assert.ok(!inputs(await receipts()).some(message=>message.method==='turn/start'));
});

test('wrong resume identity is refused, preserving the requested ID',async t=>{
  const {session}=await fixture(t,'wrong-resume-id');
  session.selectModel({...HUMAN,...PAIR});
  await assert.rejects(()=>session.resumeThread({...HUMAN,threadId:THREAD}),code('PROTOCOL'));
  assert.equal(session.snapshot().operations[0]?.threadId,THREAD);
});

test('API billing accounts cannot start threads or trigger a fallback',async t=>{
  const {session,receipts}=await fixture(t,'api-account');
  session.selectModel({...HUMAN,...PAIR});
  await assert.rejects(()=>session.startThread(HUMAN),code('SUBSCRIPTION_REQUIRED'));
  assert.equal(session.snapshot().account?.auth,'unsupported');
  assert.ok(!inputs(await receipts()).some(message=>message.method==='thread/start'));
});

test('split UTF-8 survives a frame delivered one byte at a time',async t=>{
  const {session}=await open(t,'split-utf8');
  await session.startTurn(INPUT);
  await until(()=>session.snapshot().events.some(event=>event.type==='delta'));
  assert.equal(session.snapshot().events.find(event=>event.type==='delta')?.type,'delta');
  const delta=session.snapshot().events.find(event=>event.type==='delta');
  assert.equal(delta?.type==='delta'?delta.text:null,'héllo 🌕');
});

test('terminal event before turn acknowledgement never becomes inProgress again',async t=>{
  const {session}=await open(t,'complete-before-ack');
  await session.startTurn(INPUT);
  assert.equal(session.snapshot().thread?.turnStatus,'completed');
});

test('approvals never auto-accept; numeric and string IDs are separate and human acceptance needs a thread grant',async t=>{
  const {session,receipts}=await open(t,'approvals');
  await session.startTurn(INPUT);
  await until(()=>session.snapshot().approvals.length===2);
  await delay(40);
  assert.equal(replies(await receipts()).length,0);
  const approvals=session.snapshot().approvals;
  const command=approvals.find(entry=>entry.serverRequestId===7)!;
  const file=approvals.find(entry=>entry.serverRequestId==='7')!;
  assert.throws(()=>session.respondApproval(answer(file)),code('WRITE_GRANT_REQUIRED'));
  assert.throws(()=>session.respondApproval({...answer(file),connectionId:'other'}),code('STALE_APPROVAL'));
  assert.throws(()=>session.respondApproval({...answer(file),turnId:'other'}),code('STALE_APPROVAL'));
  assert.throws(()=>session.respondApproval({...answer(file),decision:'acceptForSession'} as never),code('ARGUMENTS'));
  assert.deepEqual(file.changes,[{path:'review.txt',kind:'update',movePath:null,diff:'@@ fixture diff @@\n+reviewed'}]);
  session.grantThreadWrites({...HUMAN,threadId:THREAD});
  session.respondApproval(answer(file));
  session.respondApproval(answer(command,'decline'));
  await until(async()=>replies(await receipts()).length===2);
  const responses=replies(await receipts());
  assert.deepEqual(responses.map(value=>[value.id,value.result?.decision]),[['7','accept'],[7,'decline']]);
  assert.throws(()=>session.respondApproval(answer(file)),code('STALE_APPROVAL'));
});

test('interrupt fences cached and future approval IDs before cancellation acknowledgement',async t=>{
  const {session,receipts}=await open(t,'late-approval');
  await session.startTurn(INPUT);
  await until(()=>session.snapshot().approvals.length===1);
  const approval=session.snapshot().approvals[0]!;
  session.grantThreadWrites({...HUMAN,threadId:THREAD});
  const cancelling=session.interruptTurn({...HUMAN,threadId:THREAD,turnId:approval.turnId});
  assert.throws(()=>session.respondApproval(answer(approval)),code('STALE_APPROVAL'));
  await cancelling;
  await until(()=>session.snapshot().thread?.turnStatus==='interrupted');
  await until(async()=>replies(await receipts()).length>=3);
  assert.ok(replies(await receipts()).every(value=>value.result?.decision==='cancel'));
  assert.equal(session.snapshot().thread?.writeGranted,false);
});

test('resolved server requests invalidate approval handles without sending another response',async t=>{
  const {session,receipts}=await open(t,'resolved-approval');
  await session.startTurn(INPUT);
  await until(()=>session.snapshot().approvals.length===1);
  const approval=session.snapshot().approvals[0]!;
  await until(()=>session.snapshot().approvals.length===0);
  assert.throws(()=>session.respondApproval(answer(approval)),code('STALE_APPROVAL'));
  assert.equal(replies(await receipts()).length,0);
});

test('expired approvals send cancel and cannot subsequently accept',async t=>{
  const {session,receipts}=await open(t,'approval-expiry',{approvalTimeoutMs:120});
  await session.startTurn(INPUT);
  await until(()=>session.snapshot().approvals.length===1);
  const approval=session.snapshot().approvals[0]!;
  session.grantThreadWrites({...HUMAN,threadId:THREAD});
  await until(()=>session.snapshot().approvals.length===0);
  assert.throws(()=>session.respondApproval(answer(approval)),code('STALE_APPROVAL'));
  await until(async()=>replies(await receipts()).length===1);
  assert.equal(replies(await receipts())[0]?.result?.decision,'cancel');
});

test('disconnect revokes write grants and prevents answering a previously visible approval',async t=>{
  const {session,receipts}=await open(t,'disconnect-approval');
  await session.startTurn(INPUT);
  await until(()=>session.snapshot().approvals.length===1);
  const approval=session.snapshot().approvals[0]!;
  session.grantThreadWrites({...HUMAN,threadId:THREAD});
  await until(()=>!session.snapshot().connected);
  assert.throws(()=>session.respondApproval(answer(approval)),code('DISCONNECTED'));
  assert.equal(session.snapshot().approvals.length,0);
  assert.equal(session.snapshot().thread?.writeGranted,false);
  assert.equal(replies(await receipts()).length,0);
});

test('foreign-thread approvals cancel; network/session-root prompts cannot accept even with a write grant',async t=>{
  const foreign=await open(t,'foreign-approval');
  await foreign.session.startTurn(INPUT);
  await until(async()=>replies(await foreign.receipts()).length===1);
  assert.equal(replies(await foreign.receipts())[0]?.result?.decision,'cancel');
  const unsafe=await open(t,'unsafe-approval');
  unsafe.session.grantThreadWrites({...HUMAN,threadId:THREAD});
  await unsafe.session.startTurn(INPUT);
  await until(()=>unsafe.session.snapshot().approvals.length===2);
  for(const approval of unsafe.session.snapshot().approvals) {
    assert.equal(approval.canAccept,false);
    assert.throws(()=>unsafe.session.respondApproval(answer(approval)),code('WRITE_GRANT_REQUIRED'));
    unsafe.session.respondApproval(answer(approval,'decline'));
  }
});

test('unsupported server methods receive fixed refusal, never credentials, permission grants or automation',async t=>{
  const {session,receipts}=await open(t,'unsupported-request');
  await session.startTurn(INPUT);
  await until(async()=>replies(await receipts()).length===5);
  for(const response of replies(await receipts())) assert.equal(response.error?.code,-32601);
  assert.ok(!JSON.stringify(session.snapshot()).includes('FIXTURE_SECRET'));
});

for(const [mode,options,expected] of [
  ['duplicate-server-id',{},'PROTOCOL'],
  ['approval-limit',{maxApprovals:1},'APPROVAL_LIMIT'],
  ['oversized-frame',{maxFrameBytes:2048},'FRAME_LIMIT'],
  ['malformed',{},'PROTOCOL'],
  ['bad-utf8',{},'PROTOCOL'],
  ['stderr-flood',{maxStderrBytes:64},'OUTPUT_LIMIT'],
  ['output-flood',{maxOutputBytes:8192},'OUTPUT_LIMIT'],
] as const) test('bounded transport fails closed: '+mode,async t=>{
  const {session}=await open(t,mode,options);
  await session.startTurn(INPUT).catch(()=>undefined);
  await until(()=>!session.snapshot().connected);
  assert.equal(session.snapshot().failureCode,expected);
  assert.equal(session.snapshot().approvals.length,0);
  assert.ok(!JSON.stringify(session.snapshot()).includes('FIXTURE_SECRET'));
});

test('event ring evicts by count and bytes without retaining unknown auth notifications',async t=>{
  const {session}=await open(t,'event-flood',{maxEvents:3,maxEventBytes:400});
  await session.startTurn(INPUT);
  await until(()=>session.snapshot().droppedEvents>20);
  const snapshot=session.snapshot();
  assert.ok(snapshot.connected);
  assert.ok(snapshot.events.length<=3);
  assert.ok(snapshot.events.reduce((n,event)=>n+Buffer.byteLength(JSON.stringify(event)),0)<=400);
  assert.ok(!JSON.stringify(snapshot).includes('FIXTURE_SECRET'));
});

for(const mode of ['cursor-loop','duplicate-model','duplicate-effort']) test('catalogue refuses ambiguous pagination or effort data: '+mode,async t=>{
  const {session}=await fixture(t,mode,{},false);
  await assert.rejects(()=>session.initialize(),code('CATALOGUE'));
  assert.equal(session.snapshot().connected,false);
});

test('catalogue page/model caps refuse instead of returning a truncated selectable list',async t=>{
  const {session}=await fixture(t,'normal',{maxCatalogPages:1},false);
  await assert.rejects(()=>session.initialize(),code('CATALOGUE_LIMIT'));
  const second=await fixture(t,'normal',{maxModels:1},false);
  await assert.rejects(()=>second.session.initialize(),code('CATALOGUE_LIMIT'));
});

test('pending request and outbound byte caps are enforced before another dispatch',async t=>{
  const {session,receipts}=await fixture(t,'normal',{maxPendingRequests:2});
  const results=await Promise.allSettled([session.readAccount(),session.readAccount(),session.readAccount()]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,2);
  const rejection=results.find(result=>result.status==='rejected');
  assert.ok(rejection?.status==='rejected' && code('PENDING_LIMIT')(rejection.reason));
  const limited=await open(t,'normal',{maxQueuedBytes:1024});
  await assert.rejects(()=>limited.session.startTurn({...INPUT,text:'x'.repeat(1000)}),code('QUEUE_LIMIT'));
  assert.equal(limited.session.snapshot().operations.at(-1)?.state,'not-sent');
  assert.ok(!inputs(await limited.receipts()).some(message=>message.method==='turn/start'));
  assert.ok(inputs(await receipts()).filter(message=>message.method==='account/read').length===3);
});

test('lost thread acknowledgement preserves observed thread/session IDs and never replays start',async t=>{
  const {session,receipts}=await fixture(t,'lost-thread-ack',{requestTimeoutMs:1500});
  session.selectModel({...HUMAN,...PAIR});
  await assert.rejects(()=>session.startThread(HUMAN),code('TIMEOUT'));
  const snapshot=session.snapshot();
  assert.equal(snapshot.thread?.threadId,THREAD);
  assert.equal(snapshot.thread?.sessionId,'fixture-session-root');
  assert.equal(snapshot.operations[0]?.state,'unknown');
  assert.ok(snapshot.operations[0]?.requestId);
  assert.equal(inputs(await receipts()).filter(message=>message.method==='thread/start').length,1);
  await assert.rejects(()=>session.startThread(HUMAN),code('DISCONNECTED'));
});

for(const [mode,expectedId,expectedError] of [
  ['lost-turn-ack','fixture-turn-1','TIMEOUT'],
  ['lost-turn-no-id',null,'TIMEOUT'],
  ['disconnect-turn','fixture-turn-1','DISCONNECTED'],
] as const) test('uncertain turn outcome is preserved without replay: '+mode,async t=>{
  const {session,receipts}=await open(t,mode,{requestTimeoutMs:1500});
  await assert.rejects(()=>session.startTurn(INPUT),code(expectedError));
  const snapshot=session.snapshot();
  assert.equal(snapshot.thread?.threadId,THREAD);
  assert.equal(snapshot.thread?.turnId,expectedId);
  assert.equal(snapshot.thread?.turnStatus,'unknown');
  assert.equal(snapshot.operations.at(-1)?.state,'unknown');
  assert.equal(snapshot.operations.at(-1)?.threadId,THREAD);
  assert.equal(snapshot.operations.at(-1)?.turnId,expectedId);
  await assert.rejects(()=>session.startTurn(INPUT),code('DISCONNECTED'));
  assert.equal(inputs(await receipts()).filter(message=>message.method==='turn/start').length,1);
});

test('lost interrupt acknowledgement leaves exact thread/turn unknown and clears all grants',async t=>{
  const {session,receipts}=await open(t,'lost-interrupt-ack',{requestTimeoutMs:1500});
  await session.startTurn(INPUT);
  await assert.rejects(()=>session.interruptTurn({...HUMAN,threadId:THREAD,turnId:'fixture-turn-1'}),code('TIMEOUT'));
  assert.equal(session.snapshot().operations.at(-1)?.state,'unknown');
  assert.equal(session.snapshot().operations.at(-1)?.turnId,'fixture-turn-1');
  assert.equal(session.snapshot().thread?.turnStatus,'unknown');
  assert.equal(inputs(await receipts()).filter(message=>message.method==='turn/interrupt').length,1);
});

test('remote rejection exposes a bounded code without raw server secrets',async t=>{
  const {session}=await fixture(t,'reject-thread');
  session.selectModel({...HUMAN,...PAIR});
  await assert.rejects(()=>session.startThread(HUMAN),(error:unknown)=>{
    assert.ok(code('REMOTE_REJECTED')(error));
    assert.equal((error as {remoteCode:number}).remoteCode,-32001);
    assert.ok(!String(error).includes('FIXTURE_SECRET')); return true;
  });
  assert.equal(session.snapshot().operations[0]?.state,'rejected');
});

test('bounded operation history retains unknown identities rather than evicting them',async t=>{
  const {session}=await open(t,'complete-before-ack',{maxOperations:2});
  await session.startTurn(INPUT);
  await assert.rejects(()=>session.startTurn(INPUT),code('OPERATION_LIMIT'));
  assert.equal(session.snapshot().operations.length,2);
  assert.equal(session.snapshot().operations.at(-1)?.turnId,'fixture-turn-1');
});

test('account changes invalidate subscription status and write grants without leaking auth fields',async t=>{
  const {session}=await open(t,'account-change');
  session.grantThreadWrites({...HUMAN,threadId:THREAD});
  await session.startTurn(INPUT);
  await until(()=>session.snapshot().account===null);
  assert.equal(session.snapshot().thread?.writeGranted,false);
  assert.equal(session.snapshot().connected,false);
  assert.ok(!JSON.stringify(session.snapshot()).includes('FIXTURE_SECRET'));
});

test('delayed previous-turn notifications cannot bind or complete a later turn',async t=>{
  const {session}=await open(t,'stale-turn-event');
  await session.startTurn(INPUT);
  assert.equal(session.snapshot().thread?.turnStatus,'completed');
  await session.startTurn(INPUT);
  assert.equal(session.snapshot().thread?.turnId,'fixture-turn-2');
  assert.equal(session.snapshot().thread?.turnStatus,'inProgress');
});

test('input and outbound frame caps reject an oversized turn before dispatch',async t=>{
  const small=await open(t,'normal',{maxInputBytes:32});
  await assert.rejects(()=>small.session.startTurn({...INPUT,text:'x'.repeat(33)}),code('ARGUMENTS'));
  assert.ok(!inputs(await small.receipts()).some(message=>message.method==='turn/start'));
  const frame=await open(t,'normal',{maxFrameBytes:2048});
  await assert.rejects(()=>frame.session.startTurn({...INPUT,text:'x'.repeat(2000)}),code('FRAME_LIMIT'));
  assert.equal(frame.session.snapshot().operations.at(-1)?.state,'not-sent');
  assert.equal(frame.session.snapshot().operations.at(-1)?.errorCode,'FRAME_LIMIT');
  assert.equal(frame.session.snapshot().connected,true);
  assert.equal(frame.session.snapshot().thread?.turnStatus,'idle');
  assert.ok(!inputs(await frame.receipts()).some(message=>message.method==='turn/start'));
  await frame.session.startTurn(INPUT);
  assert.equal(frame.session.snapshot().operations.at(-1)?.state,'acknowledged');
  assert.equal(inputs(await frame.receipts()).filter(message=>message.method==='turn/start').length,1);
});

test('close is idempotent and a stale approval cannot be reused in another connection',async t=>{
  const first=await open(t,'approvals');
  await first.session.startTurn(INPUT);
  await until(()=>first.session.snapshot().approvals.length===2);
  const stale=first.session.snapshot().approvals[0]!;
  await first.session.close(); await first.session.close();
  const second=await open(t,'approvals');
  await second.session.startTurn(INPUT);
  await until(()=>second.session.snapshot().approvals.length===2);
  second.session.grantThreadWrites({...HUMAN,threadId:THREAD});
  assert.throws(()=>second.session.respondApproval(answer(stale)),code('STALE_APPROVAL'));
  assert.equal(replies(await second.receipts()).length,0);
});

test('server request lifetime cap disconnects instead of forgetting old wire IDs',async t=>{
  const {session}=await open(t,'unsupported-request',{maxServerRequests:2});
  await session.startTurn(INPUT).catch(()=>undefined);
  await until(()=>!session.snapshot().connected);
  assert.equal(session.snapshot().failureCode,'APPROVAL_LIMIT');
});

test('malformed error response rejects and closes the pending request without hanging',async t=>{
  const {session}=await fixture(t,'malformed-response',{},false);
  await assert.rejects(()=>session.initialize(),code('PROTOCOL'));
  assert.equal(session.snapshot().connected,false);
});
for(const mode of ['missing-file-preview','outside-file-preview','oversized-file-preview']) test('file acceptance requires a complete bounded workspace preview: '+mode,async t=>{
  const {session,receipts}=await open(t,mode);
  session.grantThreadWrites({...HUMAN,threadId:THREAD});
  await session.startTurn(INPUT);
  await until(()=>session.snapshot().approvals.length===1);
  const approval=session.snapshot().approvals[0]!;
  assert.equal(approval.canAccept,false);
  assert.equal(approval.changes,null);
  assert.throws(()=>session.respondApproval(answer(approval)),code('WRITE_GRANT_REQUIRED'));
  session.respondApproval(answer(approval,'decline'));
  await until(async()=>replies(await receipts()).length===1);
  assert.equal(replies(await receipts())[0]?.result?.decision,'decline');
});

for(const mode of ['completed-file-item','changed-file-item']) test('item completion or changed proposal invalidates cached approval: '+mode,async t=>{
  const {session,receipts}=await open(t,mode);
  session.grantThreadWrites({...HUMAN,threadId:THREAD});
  await session.startTurn(INPUT);
  await until(()=>session.snapshot().approvals.length===1);
  const approval=session.snapshot().approvals[0]!;
  assert.equal(approval.canAccept,true);
  await until(()=>session.snapshot().approvals.length===0);
  assert.throws(()=>session.respondApproval(answer(approval)),code('STALE_APPROVAL'));
  if(mode==='changed-file-item') {
    await until(async()=>replies(await receipts()).length===1);
    assert.equal(replies(await receipts())[0]?.result?.decision,'cancel');
  } else assert.equal(replies(await receipts()).length,0);
});

test('identical consecutive deltas retain distinct monotonic public sequences and existing fields',async t=>{
  const {session}=await open(t,'identical-deltas');
  await session.startTurn(INPUT);
  await until(()=>session.snapshot().lastEventSeq===5);
  const events=session.snapshot().events;
  assert.deepEqual(events.map(event=>event.seq),[1,2,3,4,5]);
  const deltas=events.filter(event=>event.type==='delta');
  assert.equal(deltas.length,3);
  const value: SessionEventValue={type:'delta',threadId:THREAD,turnId:'fixture-turn-1',itemId:'fixture-message',text:'same'};
  for(const event of deltas) {const {seq,...fields}=event; assert.ok(seq>0); assert.deepEqual(fields,value);}
  assert.equal(session.snapshot().droppedEvents,0);
});

test('live MCP tool items expose only a bounded, allowlisted Arcane identity',async t=>{
  const {session}=await open(t,'mcp-tool-items');
  await session.startTurn(INPUT);
  await until(()=>session.snapshot().events.filter(event=>event.type==='item').length===5);
  const items=session.snapshot().events.flatMap(event=>event.type==='item'?[event]:[]);
  const serialized=JSON.stringify(session.snapshot());
  for(const secret of ['FIXTURE_SECRET','FIXTURESECRET','print(','instanceId','xxxxxxxxxx','qqqqqqqqqq'])assert.ok(!serialized.includes(secret),secret);
  const create={server:'arcane',tool:'scene_create',args:{parent:{root:'Workspace',pathSegments:['Forest']},className:'Part',name:'Tree',properties:{Size:true,Color:true}}};
  assert.deepEqual(items.map(event=>[event.itemId,event.itemType,event.status,event.tool??null]),[
    ['fixture-mcp-1','mcpToolCall','inProgress',create],
    ['fixture-mcp-1','mcpToolCall','completed',create],
    ['fixture-mcp-2','mcpToolCall','inProgress',{server:'other',tool:'scene_create',args:null}],
    ['fixture-mcp-3','mcpToolCall','inProgress',null],
    ['fixture-mcp-4','mcpToolCall','inProgress',{server:'arcane',tool:'script_update',args:{ref:{root:'ServerScriptService',pathSegments:['Main']}}}],
  ]);
  for(const event of items)assert.ok(Buffer.byteLength(JSON.stringify(event))<4096);
});

test('actual stdio MCP failures retain finite codes and original scope without provider messages',async t=>{
  const {session}=await open(t,'mcp-tool-failures');
  await session.startTurn(INPUT);
  await until(()=>session.snapshot().events.filter(event=>event.type==='item').length===9);
  const items=session.snapshot().events.flatMap(event=>event.type==='item'?[event]:[]);
  assert.deepEqual(items.map(event=>[event.itemId,event.status,event.tool?.failure??null]),[
    ['failure-skill','inProgress',null],
    ['failure-skill','failed',{schemaVersion:1,kind:'arcane-code',tool:'skills_recommend',code:'INTEGRITY'}],
    ['failure-forest','failed',{schemaVersion:1,kind:'arcane-code',tool:'scene_build',code:'FOREST_SOURCES_REQUIRED'}],
    ['failure-blender','failed',{schemaVersion:1,kind:'arcane-code',tool:'studio_asset_generate',code:'BLENDER_REQUIRED'}],
    ['failure-reconstruction','failed',{schemaVersion:1,kind:'arcane-code',tool:'assets_place_studio_import',code:'STUDIO_RECONSTRUCTION_REQUIRED'}],
    ['failure-capture','failed',{schemaVersion:1,kind:'arcane-code',tool:'studio_viewport_capture',code:'SDK_CUSTODY_UNCONFIRMED'}],
    ['failure-provider','failed',{schemaVersion:1,kind:'mcp-error',tool:'skills_get',code:null}],
    ['failure-unknown','failed',{schemaVersion:1,kind:'details-unavailable',tool:'skills_list',code:null}],
    ['failure-other','failed',{schemaVersion:1,kind:'mcp-error',tool:null,code:null}],
  ]);
  assert.ok(items.every(event=>event.threadId===THREAD&&event.turnId==='fixture-turn-1'));
  const text=JSON.stringify(session.snapshot());
  for(const secret of ['PRIVATE_','PrivateToolSecret','UNKNOWN_PRIVATE_CODE','C:/private','password='])assert.ok(!text.includes(secret),secret);
  assert.equal(session.snapshot().droppedEvents,0);
});

test('finite MCP failure parsing refuses getters/proxies, mismatched codes and conflicting candidates',()=>{
  const item=(code:string)=>({status:'failed',server:'arcane',tool:'skills_get',result:{structuredContent:{error:{code}}}});
  assert.equal(summarizeMcpToolFailure(item('INTEGRITY'))?.code,'INTEGRITY');
  assert.equal(summarizeMcpToolFailure(item('VIEWPORT_FAILED'))?.kind,'details-unavailable');
  for(const tool of ['studio_asset_generate','assets_place_studio_import']){
    const value={...item('INTEGRITY'),tool};
    assert.equal(summarizeMcpToolFailure(value)?.kind,'details-unavailable','codes remain bound to the tool that can emit them');
    assert.equal(summarizeMcpToolFailure({...value,server:'other'})?.tool,null,'a matching foreign tool is not Arcane evidence');
  }
  const conflict={...item('INTEGRITY'),result:{structuredContent:{error:{code:'INTEGRITY'}},content:[{type:'text',text:'{"error":{"code":"REGISTRY"}}'}]}};
  assert.equal(summarizeMcpToolFailure(conflict)?.kind,'details-unavailable');
  let invoked=0;const hidden=()=>{invoked++;throw new Error('must stay unread');};
  const success=Object.defineProperty({status:'completed'},'result',{get:hidden});
  assert.equal(summarizeMcpToolFailure(success),null);
  for(const field of ['status','result','error']){
    const input=Object.defineProperty({status:'failed',server:'arcane',tool:'skills_get'},field,{enumerable:true,get:hidden});
    summarizeMcpToolFailure(input);
  }
  const coded=Object.defineProperty({schemaVersion:1,kind:'arcane-code',tool:'skills_get'},'code',{enumerable:true,get:hidden});
  assert.equal(readMcpToolFailure(coded),null);
  const proxy=new Proxy({},{getPrototypeOf:hidden,getOwnPropertyDescriptor:hidden,ownKeys:hidden});
  assert.equal(summarizeMcpToolFailure(proxy),null);assert.equal(readMcpToolFailure(proxy),null);
  assert.equal(summarizeMcpToolCall(proxy),null);
  const revoked=Proxy.revocable({},{});revoked.revoke();assert.equal(summarizeMcpToolFailure(revoked.proxy),null);
  const plain=Object.assign(Object.create(null),{schemaVersion:1,kind:'mcp-error',tool:null,code:null});
  assert.equal(mcpToolFailureEnvelope(plain),'{"toolFailure":{"schemaVersion":1,"kind":"mcp-error","tool":null,"code":null}}');
  assert.equal(readMcpToolFailure({...plain,secret:'PRIVATE'}),null);
  assert.equal(invoked,0,'no getter or proxy trap ran');
});

test('MCP tool summaries refuse getters, oversize and non-plain arguments',()=>{
  let invoked=false;
  const args=Object.defineProperty({className:'Part'},'name',{enumerable:true,get(){invoked=true;return 'Tree';}});
  assert.deepEqual(summarizeMcpToolCall({server:'arcane',tool:'scene_create',arguments:args}),{server:'arcane',tool:'scene_create',args:{className:'Part'}});
  assert.equal(invoked,false);
  assert.deepEqual(summarizeMcpToolCall({server:'arcane',tool:'scene_create',arguments:'{"name":"x"}'}),{server:'arcane',tool:'scene_create',args:null});
  assert.deepEqual(summarizeMcpToolCall({server:'arcane',tool:'scene_create',arguments:{ref:{root:'Workspace',pathSegments:Array(17).fill('a')}}})?.args,{ref:{root:'Workspace',pathSegments:[]}});
  assert.deepEqual(summarizeMcpToolCall({server:'arcane',tool:'scene_search',arguments:{query:'Bearer abcdefghijk',root:'Workspace'}})?.args,{root:'Workspace'});
  const many=summarizeMcpToolCall({server:'arcane',tool:'scene_update',arguments:{properties:Object.fromEntries(Array.from({length:20},(_,i)=>['P'+'a'.repeat(i),'FIXTURE_SECRET']))}});
  assert.equal(Object.keys(many?.args?.properties??{}).length,MCP_TOOL_SUMMARY_LIMITS.maxProperties);
  assert.ok(!JSON.stringify(many).includes('FIXTURE_SECRET'));
  for(const item of [{server:'arc ane',tool:'x'},{server:'arcane',tool:''},{server:'arcane',tool:'t'.repeat(129)},{server:'a'.repeat(65),tool:'x'},{server:'arcane'}])assert.equal(summarizeMcpToolCall(item as Record<string,unknown>),null);
});

test('MCP tool summaries read compact slash-joined ref paths with the same bounds and redaction',()=>{
  const ref=(value:Record<string,unknown>)=>summarizeMcpToolCall({server:'arcane',tool:'scene_update',arguments:{ref:{instanceId:'i1',className:'Part',...value}}})?.args?.ref;
  assert.deepEqual(ref({root:'Workspace',path:'Village/Hut/Door'}),{root:'Workspace',pathSegments:['Village','Hut','Door']});
  assert.deepEqual(ref({root:'Workspace',path:''}),{root:'Workspace',pathSegments:[]});
  assert.deepEqual(ref({root:'Workspace',pathSegments:['Village','Hut']}),{root:'Workspace',pathSegments:['Village','Hut']},'full refs still work');
  assert.deepEqual(summarizeMcpToolCall({server:'arcane',tool:'scene_create',arguments:{parent:{root:'Workspace',path:'Village'}}})?.args,{parent:{root:'Workspace',pathSegments:['Village']}});
  // Same bounds and redaction as pathSegments: too many segments, an oversize or credential-shaped segment, an empty segment
  // or an ambiguous ref keeps the root only; a non-string path is ignored.
  for(const value of [{path:Array(MCP_TOOL_SUMMARY_LIMITS.maxSegments+1).fill('a').join('/')},{path:'Village/'+'x'.repeat(MCP_TOOL_SUMMARY_LIMITS.maxText+1)},
    {path:'Village/Bearer abcdefghijk'},{path:'Village//Hut'},{path:'Village\nHut'},{path:'x'.repeat(5000)},{path:'Village',pathSegments:['Village']},{path:42}])
    assert.deepEqual(ref({root:'Workspace',...value}),{root:'Workspace',pathSegments:[]},JSON.stringify(value).slice(0,80));
  assert.equal(ref({path:'Village'}),undefined,'a ref without a root is dropped');
});

test('ring count overflow retains sequence gaps and exact dropped count',async t=>{
  const {session}=await open(t,'identical-deltas',{maxEvents:2});
  await session.startTurn(INPUT);
  await until(()=>session.snapshot().lastEventSeq===5);
  const snapshot=session.snapshot();
  assert.deepEqual(snapshot.events.map(event=>event.seq),[4,5]);
  assert.equal(snapshot.droppedEvents,3);
  assert.equal(snapshot.lastEventSeq,5);
  await session.interruptTurn({...HUMAN,threadId:THREAD,turnId:'fixture-turn-1'});
  await until(()=>session.snapshot().thread?.turnStatus==='interrupted');
  assert.deepEqual(session.snapshot().events.map(event=>event.seq),[5,6]);
  assert.equal(session.snapshot().lastEventSeq,6);
});

test('oversized events consume sequences and expose internal and trailing gaps',async t=>{
  const {session}=await open(t,'event-gaps',{maxEventBytes:1024});
  await session.startTurn(INPUT);
  await until(()=>session.snapshot().lastEventSeq===6);
  const snapshot=session.snapshot();
  assert.deepEqual(snapshot.events.map(event=>event.seq),[1,2,3,5]);
  assert.equal(snapshot.droppedEvents,2);
  assert.equal(snapshot.lastEventSeq,6);
  assert.ok(snapshot.events.reduce((sum,event)=>sum+Buffer.byteLength(JSON.stringify(event)),0)<=1024);
});

test('sequence snapshots are defensive and a fresh connection starts its own cursor',async t=>{
  const first=await open(t,'identical-deltas');
  await first.session.startTurn(INPUT);
  await until(()=>first.session.snapshot().lastEventSeq===5);
  const changed=first.session.snapshot();
  changed.lastEventSeq=900; changed.events[0]!.seq=999; changed.events.splice(1);
  assert.equal(first.session.snapshot().lastEventSeq,5);
  assert.deepEqual(first.session.snapshot().events.map(event=>event.seq),[1,2,3,4,5]);
  const second=await open(t);
  assert.notEqual(first.session.snapshot().connectionId,second.session.snapshot().connectionId);
  assert.equal(second.session.snapshot().lastEventSeq,1);
  assert.equal(second.session.snapshot().events[0]?.seq,1);
});

const BUNDLED_ENTRY=join(ROOT,'dist','apps','mcp','src','main.js');
const AGENT_BEARER='a4'.repeat(32); // Synthetic test-only scoped bearer.
function hostProfile(overrides: Partial<ArcaneMcpLaunchProfile> = {}): ArcaneMcpLaunchProfile {
  return {nodeExecutable:process.execPath,serverEntry:BUNDLED_ENTRY,projectRoot:ROOT,
    daemonUrl:'http://127.0.0.1:47831',agentToken:AGENT_BEARER,...overrides};
}
async function profileDir(t: test.TestContext): Promise<string> {
  await mkdir(TEMP,{recursive:true});
  const dir=await mkdtemp(join(TEMP,'profile-'));
  t.after(async()=>{const child=relative(TEMP,dir); assert.ok(child.startsWith('profile-')&&!child.includes(sep)); await rm(dir,{recursive:true,force:true});});
  return dir;
}
test('optional MCP profile creates fixed ephemeral argv and only named child environment values',async t=>{
  const profile=hostProfile();
  const {session,receipts,dir,launchArgs}=await fixture(t,'normal',{},true,profile);
  const spawn=(await receipts()).find(record=>record.type==='spawn')!;
  assert.deepEqual(launchArgs,[
    'app-server','--listen','stdio://',
    '-c','mcp_servers.arcane={}',
    '-c','mcp_servers.arcane.command='+JSON.stringify(process.execPath),
    '-c','mcp_servers.arcane.args='+JSON.stringify([BUNDLED_ENTRY,'--project',ROOT]),
    '-c','mcp_servers.arcane.env_vars=["ARCANE_DAEMON_URL","ARCANE_LOCAL_TOKEN"]',
    '-c','mcp_servers.arcane.enabled=true',
    '-c','mcp_servers.arcane.required=true',
    '-c','mcp_servers.arcane.default_tools_approval_mode="approve"',
    '-c','mcp_servers.arcane.enabled_tools='+JSON.stringify(ARCANE_TOOL_NAMES),
    '-c','mcp_servers.arcane.disabled_tools=[]',
  ]);
  assert.deepEqual(spawn.argv,launchArgs);
  assert.equal(spawn.arcaneDaemonUrl,profile.daemonUrl);
  assert.equal(spawn.arcaneTokenSha256,createHash('sha256').update(AGENT_BEARER).digest('hex'));
  assert.ok(spawn.envKeys?.includes('ARCANE_LOCAL_TOKEN')&&spawn.envKeys.includes('ARCANE_DAEMON_URL'));
  assert.ok(!JSON.stringify(await receipts()).includes(AGENT_BEARER));
  assert.ok(!JSON.stringify(session.snapshot()).includes(AGENT_BEARER));
  assert.ok(!JSON.stringify(session).includes(AGENT_BEARER)); // No retained spec.env property on the session.
  assert.equal(session.snapshot().thread,null);
  assert.equal(session.snapshot().operations.length,0);
  await session.close(); await session.close();
  assert.equal(session.snapshot().connected,false);
  assert.deepEqual(await readdir(dir),['audit.jsonl']);
  const methods=inputs(await receipts()).map(message=>message.method);
  assert.deepEqual(methods,['initialize','initialized','account/read','model/list','model/list']);
});

test('no-profile launch stays unchanged and ignores ambient Arcane token/config variables',async t=>{
  const oldToken=process.env.ARCANE_LOCAL_TOKEN,oldUrl=process.env.ARCANE_DAEMON_URL,oldOptions=process.env.NODE_OPTIONS;
  process.env.ARCANE_LOCAL_TOKEN='SYNTHETIC_AMBIENT';
  process.env.ARCANE_DAEMON_URL='http://example.test:1';
  process.env.NODE_OPTIONS='--require=SYNTHETIC_WRAPPER';
  try {
    const {session,receipts,launchArgs}=await fixture(t);
    assert.deepEqual(launchArgs,['app-server','--listen','stdio://']);
    const spawn=(await receipts()).find(record=>record.type==='spawn')!;
    assert.equal(spawn.arcaneTokenSha256,null); assert.equal(spawn.arcaneDaemonUrl,null);
    assert.ok(!spawn.envKeys?.includes('NODE_OPTIONS'));
    assert.equal(session.snapshot().ready,true);
  } finally {
    for(const [key,value] of [['ARCANE_LOCAL_TOKEN',oldToken],['ARCANE_DAEMON_URL',oldUrl],['NODE_OPTIONS',oldOptions]]) {
      if(value===undefined) delete process.env[key!]; else process.env[key!]=value;
    }
  }
});

test('MCP project paths with spaces and quotes stay literal in a fixed TOML argument array',async t=>{
  const dir=await profileDir(t);
  const project=join(dir,process.platform==='win32'?"project space 'quoted'":'project space "quoted"');
  await mkdir(project);
  const {receipts}=await fixture(t,'normal',{},true,hostProfile({projectRoot:project}));
  const args=(await receipts()).find(record=>record.type==='spawn')!.argv!;
  const encoded=args.find(arg=>arg.startsWith('mcp_servers.arcane.args='))!;
  assert.deepEqual(JSON.parse(encoded.slice(encoded.indexOf('=')+1)),[BUNDLED_ENTRY,'--project',project]);
  assert.ok(!args.some(arg=>arg.includes(AGENT_BEARER)));
  assert.ok(!args.includes(project)); // The project is inside one config value, never extra CLI arguments.
});

test('MCP profile accepts only its exact required field envelope',async()=>{
  for(const key of ['nodeExecutable','serverEntry','projectRoot','daemonUrl','agentToken']) {
    const profile={...hostProfile()} as Record<string,unknown>; delete profile[key];
    await assert.rejects(()=>prepareCodexProcess(process.execPath,ROOT,profile as unknown as ArcaneMcpLaunchProfile,BUNDLED_ENTRY),code('ARGUMENTS'));
  }
  for(const key of ['args','env','callerEnv','config','url','methods','shell','trustedEntry']) {
    await assert.rejects(()=>prepareCodexProcess(process.execPath,ROOT,{...hostProfile(),[key]:'SYNTHETIC'} as never,BUNDLED_ENTRY),code('ARGUMENTS'));
  }
  await assert.rejects(()=>prepareCodexProcess(process.execPath,ROOT,null as never,BUNDLED_ENTRY),code('ARGUMENTS'));
});

test('MCP profile rejects arbitrary URLs, invalid ports and non-hex bearers without echoing values',async()=>{
  for(const daemonUrl of ['https://127.0.0.1:1','http://localhost:1','http://127.0.0.1:0','http://127.0.0.1:65536','http://127.0.0.1:01','http://127.0.0.1:1/','http://127.0.0.1:1?x=1','http://127.0.0.1:1#x','http://user@127.0.0.1:1']) {
    await assert.rejects(()=>prepareCodexProcess(process.execPath,ROOT,hostProfile({daemonUrl}),BUNDLED_ENTRY),code('MCP_PROFILE'));
  }
  for(const agentToken of ['g'.repeat(64),'a'.repeat(63),'a'.repeat(65),'bearer '+AGENT_BEARER]) {
    await assert.rejects(()=>prepareCodexProcess(process.execPath,ROOT,hostProfile({agentToken}),BUNDLED_ENTRY),(error:unknown)=>{
      assert.ok(code('MCP_PROFILE')(error)||code('ARGUMENTS')(error));
      assert.ok(!String(error).includes(agentToken)); return true;
    });
  }
});

test('MCP profile rejects wrappers, relative/control paths, missing files and directory entries',async t=>{
  for(const nodeExecutable of ['node','node.cmd','node.ps1','node.bat','node.exe\n-c CONFIG']) {
    await assert.rejects(()=>prepareCodexProcess(process.execPath,ROOT,hostProfile({nodeExecutable}),BUNDLED_ENTRY),code('MCP_PROFILE'));
  }
  for(const serverEntry of ['main.js',join(ROOT,'wrapper.mjs'),BUNDLED_ENTRY+'\n']) {
    await assert.rejects(()=>prepareCodexProcess(process.execPath,ROOT,hostProfile({serverEntry}),BUNDLED_ENTRY),code('MCP_PROFILE'));
  }
  const dir=await profileDir(t);
  const fakeNode=join(dir,process.platform==='win32'?'node.exe':'node');
  await mkdir(fakeNode);
  await assert.rejects(()=>prepareCodexProcess(process.execPath,ROOT,hostProfile({nodeExecutable:fakeNode}),BUNDLED_ENTRY),code('MCP_PROFILE'));
  const entryDirectory=join(dir,'main.js'); await mkdir(entryDirectory);
  await assert.rejects(()=>prepareCodexProcess(process.execPath,ROOT,hostProfile({serverEntry:entryDirectory}),BUNDLED_ENTRY),code('MCP_PROFILE'));
  await assert.rejects(()=>prepareCodexProcess(process.execPath,ROOT,hostProfile({projectRoot:join(dir,'missing')}),BUNDLED_ENTRY),code('MCP_PROFILE'));
  await assert.rejects(()=>prepareCodexProcess(process.execPath,ROOT,hostProfile({projectRoot:BUNDLED_ENTRY}),BUNDLED_ENTRY),code('MCP_PROFILE'));
  await assert.rejects(()=>prepareCodexProcess(process.execPath,ROOT,hostProfile(),join(dir,'missing','main.js')),code('MCP_PROFILE'));
});

test('existing arbitrary main.js and fake named Node files cannot replace the trusted bundle/runtime',async t=>{
  const dir=await profileDir(t);
  const otherEntry=join(dir,'main.js'),otherNode=join(dir,process.platform==='win32'?'node.exe':'node');
  await writeFile(otherEntry,'throw new Error("SYNTHETIC_WRAPPER");\n');
  await writeFile(otherNode,'SYNTHETIC_NOT_NODE');
  await assert.rejects(()=>prepareCodexProcess(process.execPath,ROOT,hostProfile({serverEntry:otherEntry}),BUNDLED_ENTRY),code('MCP_PROFILE'));
  await assert.rejects(()=>prepareCodexProcess(process.execPath,ROOT,hostProfile({nodeExecutable:otherNode}),BUNDLED_ENTRY),code('MCP_PROFILE'));
  assert.deepEqual((await readdir(dir)).sort(),['main.js',process.platform==='win32'?'node.exe':'node'].sort());
});

test('MCP profile preserves exact uppercase hexadecimal bearer without normalizing or persisting it',async t=>{
  const token='B7'.repeat(32);
  const {receipts,session}=await fixture(t,'normal',{},true,hostProfile({agentToken:token,daemonUrl:'http://127.0.0.1:65535'}));
  const spawn=(await receipts()).find(record=>record.type==='spawn')!;
  assert.equal(spawn.arcaneTokenSha256,createHash('sha256').update(token).digest('hex'));
  assert.equal(spawn.arcaneDaemonUrl,'http://127.0.0.1:65535');
  assert.ok(!JSON.stringify(await receipts()).includes(token));
  assert.ok(!JSON.stringify(session).includes(token));
});

test('scoped Arcane tool calls use the configured approval policy while native file and shell approvals remain on request',async t=>{
  const f=await fixture(t,'scoped-mcp-approval',{},true,hostProfile(),'arcane-only');
  f.session.selectModel({...HUMAN,...PAIR});await f.session.startThread(HUMAN);
  await f.session.startTurn({...INPUT,allowWorkspaceWrites:true});
  await until(()=>['completed','failed'].includes(f.session.snapshot().thread!.turnStatus));
  assert.equal(f.session.snapshot().thread!.turnStatus,'completed');
  const receipts=await f.receipts();
  assert.ok(!receipts.some(row=>row.message?.error),'ordinary Arcane calls do not reach an unsupported approval callback');
  const start=receipts.find(row=>row.message?.method==='turn/start')!.message!.params!;
  assert.equal(start.approvalPolicy,'on-request');
  assert.equal((start.sandboxPolicy as {type:string}).type,'workspaceWrite');
  assert.ok(f.session.snapshot().events.some(event=>event.type==='item'&&event.tool?.tool==='terrain_generate'&&event.status==='completed'));
});

test('public factory preserves local-use restrictions and rejects browser-style extra profile controls',async()=>{
  await assert.rejects(()=>connectCodexClient({command:process.execPath,cwd:ROOT,use:'commercial-hosted',arcaneMcp:hostProfile()} as never),code('LOCAL_USE_ONLY'));
  for(const key of ['env','args','config','mcpServers','trustedEntry']) {
    await assert.rejects(()=>connectCodexClient({command:process.execPath,cwd:ROOT,use:'personal-local',arcaneMcp:hostProfile(),[key]:{}} as never),code('ARGUMENTS'));
  }
});

test('an agent bearer embedded in a project path is rejected before it can reach argv or logs',async t=>{
  const dir=await profileDir(t),project=join(dir,AGENT_BEARER); await mkdir(project);
  await assert.rejects(()=>prepareCodexProcess(process.execPath,ROOT,hostProfile({projectRoot:project}),BUNDLED_ENTRY),(error:unknown)=>{
    assert.ok(code('MCP_PROFILE')(error)); assert.ok(!String(error).includes(AGENT_BEARER)); return true;
  });
});


test('human MCP inventory is bounded metadata, without endpoint, auth or raw tool descriptions',async t=>{
  const {session,receipts}=await fixture(t);const rows=await session.inspectMcpServers(HUMAN);assert.deepEqual(rows,[{name:'arcane',runtimeStatus:'connected',toolNames:[...ARCANE_TOOL_NAMES],toolsError:false,plugin:false,pluginId:null}]);assert.equal(JSON.stringify(rows).includes('FIXTURE_SECRET'),false);assert.equal(session.snapshot().thread,null);assert.equal(inputs(await receipts()).filter(m=>m.method==='mcpServerStatus/list').length,1);
  await assert.rejects(()=>session.inspectMcpServers({initiatedBy:'agent'} as never),code('HUMAN_REQUIRED'));
});
for(const mode of ['bad-mcp-inventory','mcp-cursor-loop'])test('native MCP inventory rejects '+mode+' without model work',async t=>{const {session}=await fixture(t,mode);await assert.rejects(()=>session.inspectMcpServers(HUMAN),code('MCP_INVENTORY'));assert.equal(session.snapshot().thread,null);});


test('Arcane-only child overrides disable inherited tools with literal safe dotted keys and no token',()=>{
 const row={runtimeStatus:'connected',toolNames:['write'],toolsError:false,plugin:false,pluginId:null};
 const args=arcaneIsolationOverrides([{...row,name:'Roblox_Studio'},{...row,name:'cua_repl',plugin:true,pluginId:'unified-computer-use@openai-bundled'}],process.execPath,AGENT_BEARER);assert.ok(args.some(s=>s.startsWith('mcp_servers.Roblox_Studio=')));assert.ok(args.includes('plugins.unified-computer-use@openai-bundled.mcp_servers.cua_repl.enabled=false'));assert.equal(args.some(s=>s.includes(AGENT_BEARER)),false);
 for(const name of ['a.b','a"b','a=b',AGENT_BEARER])assert.throws(()=>arcaneIsolationOverrides([{...row,name}],process.execPath,AGENT_BEARER),code('MCP_ISOLATION'));
 assert.equal(arcaneThreadIsIsolated([{...row,name:'arcane'}]),true);assert.equal(arcaneThreadIsIsolated([{...row,name:'arcane'},{...row,name:'inherited'}]),false);assert.equal(arcaneThreadIsIsolated([{...row,name:'arcane',runtimeStatus:'starting'}]),false);
});


test('Arcane-only native thread is configured only after the actual scoped MCP inventory passes',async t=>{
 const {session,receipts}=await fixture(t,'normal',{},true,undefined,'arcane-only');assert.equal(session.snapshot().mcpIsolation,'arcane-only-pending');session.selectModel({...HUMAN,...PAIR});await session.startThread(HUMAN);assert.equal(session.snapshot().thread?.configured,true);assert.equal(session.snapshot().mcpIsolation,'arcane-only-verified');
 const calls=inputs(await receipts()); // The pinned task instructions stay first and unchanged; project memory guidance (and ARCANE.md, when present) follows.
 const developer=String(calls.find(m=>m.method==='thread/start')!.params!.developerInstructions);assert.equal(developer,ARCANE_TASK_INSTRUCTIONS+projectMemorySection((await readProjectMemory(ROOT)).text));assert.ok(developer.startsWith(ARCANE_TASK_INSTRUCTIONS+'\n\n'+PROJECT_MEMORY_GUIDANCE));assert.equal(calls.filter(m=>m.method==='mcpServerStatus/list').length,1);assert.equal(calls.find(m=>m.method==='mcpServerStatus/list')!.params!.threadId,THREAD);assert.equal(calls.filter(m=>m.method==='turn/start').length,0);
});
for (const opening of ['start', 'resume'] as const) test('Arcane-only thread ' + opening + ' refuses a missing source-search tool before model work', async t => {
  const { session, receipts } = await fixture(t, 'missing-script-search', {}, true, undefined, 'arcane-only');
  session.selectModel({ ...HUMAN, ...PAIR });
  await assert.rejects(() => opening === 'start' ? session.startThread(HUMAN) : session.resumeThread({ ...HUMAN, threadId: THREAD }), (error: unknown) => {
    assert.ok(code('MCP_CAPABILITIES')(error)); assert.match(String(error), /script_search/); return true;
  });
  assert.notEqual(session.snapshot().thread?.configured, true);
  assert.notEqual(session.snapshot().mcpIsolation, 'arcane-only-verified');
  assert.equal(inputs(await receipts()).filter(message => message.method === 'turn/start').length, 0);
});

test('unexpected inherited MCP server fences the thread before any native turn can start',async t=>{
 const {session,receipts}=await fixture(t,'inherited-mcp-active',{},true,undefined,'arcane-only');session.selectModel({...HUMAN,...PAIR});await assert.rejects(()=>session.startThread(HUMAN),code('MCP_ISOLATION'));assert.equal(session.snapshot().connected,false);assert.equal(session.snapshot().thread?.configured,false);assert.equal(session.snapshot().operations.at(-1)?.state,'unknown');await assert.rejects(()=>session.startTurn(INPUT),code('DISCONNECTED'));assert.equal(inputs(await receipts()).filter(m=>m.method==='turn/start').length,0);
});


test('same-thread model switch is local, revokes grants and sends the exact pair only on the next human turn', async t => {
  const { session, receipts } = await fixture(t, 'normal', {}, true, undefined, 'arcane-only');
  session.selectModel({ ...HUMAN, ...PAIR }); await session.startThread(HUMAN);
  const before = session.snapshot(); session.grantThreadWrites({ ...HUMAN, threadId: THREAD });
  const log = inputs(await receipts()), next = { model: 'fixture-other', effort: 'low' };
  const selected = session.selectModel({ ...HUMAN, ...next }); selected.model = 'mutated-copy';
  const switched = session.snapshot();
  assert.deepEqual(switched.selection, next); assert.deepEqual(switched.thread!.selection, next);
  assert.equal(switched.thread!.threadId, before.thread!.threadId); assert.equal(switched.thread!.sessionId, before.thread!.sessionId);
  assert.equal(switched.thread!.turnId, before.thread!.turnId); assert.equal(switched.thread!.turnStatus, 'idle');
  assert.equal(switched.thread!.writeGranted, false); assert.equal(switched.mcpIsolation, 'arcane-only-verified');
  assert.deepEqual(switched.operations, before.operations); assert.deepEqual(switched.events, before.events);
  await delay(10); assert.deepEqual(inputs(await receipts()), log, 'selection sends no native method or callback answer');
  await session.startTurn(INPUT);
  const calls = inputs(await receipts()), turn = calls.find(m => m.method === 'turn/start')!.params!;
  assert.equal(turn.threadId, THREAD); assert.equal(turn.model, next.model); assert.equal(turn.effort, next.effort);
  assert.equal(turn.cwd, ROOT); assert.equal(turn.approvalPolicy, 'on-request'); assert.equal(turn.approvalsReviewer, 'user');
  assert.deepEqual(turn.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  assert.ok(!Object.hasOwn(turn, 'config')); assert.ok(!Object.hasOwn(turn, 'apiKey'));
  assert.equal(calls.filter(m => m.method === 'thread/start').length, 1); assert.equal(calls.filter(m => m.method === 'thread/resume').length, 0);
  const inventoryCalls = calls.filter(m => m.method === 'mcpServerStatus/list');
  assert.equal(inventoryCalls.length, 2, 'thread setup plus a fresh pre-turn isolation check');
  assert.ok(inventoryCalls.every(m => m.params?.threadId === THREAD));
});

test('same-thread effort-only switch resets grants; idle same-pair selection is a defensive no-op', async t => {
  const { session, receipts } = await open(t); session.grantThreadWrites({ ...HUMAN, threadId: THREAD });
  const before = session.snapshot(), unchanged = session.selectModel({ ...HUMAN, ...PAIR }); unchanged.effort = 'mutated-copy';
  assert.deepEqual(session.snapshot(), before, 'same pair does not revoke an existing deliberate grant');
  for (const invalid of [
    { ...HUMAN, model: 'picker-fixture-other', effort: 'low' }, { ...HUMAN, ...PAIR, effort: 'high' },
    { ...PAIR, initiatedBy: 'agent' }, { ...HUMAN, ...PAIR, cwd: ROOT }, { ...HUMAN, ...PAIR, config: {} },
  ]) assert.throws(() => session.selectModel(invalid as never));
  assert.deepEqual(session.snapshot(), before, 'refused selection never changes grant or selected pair');
  const next = { model: PAIR.model, effort: 'low' }; session.selectModel({ ...HUMAN, ...next });
  assert.equal(session.snapshot().thread!.writeGranted, false); assert.deepEqual(session.snapshot().thread!.selection, next);
  await session.startTurn(INPUT); const turn = inputs(await receipts()).find(m => m.method === 'turn/start')!.params!;
  assert.equal(turn.model, next.model); assert.equal(turn.effort, next.effort); assert.deepEqual(turn.sandboxPolicy, { type: 'readOnly', networkAccess: false });
});

test('same-thread selection waits for the complete current catalogue even for an idle same pair', async t => {
  const { session } = await open(t); const before = session.snapshot(); const pending = session.listModels();
  assert.throws(() => session.selectModel({ ...HUMAN, ...PAIR }), code('BUSY'));
  assert.throws(() => session.selectModel({ ...HUMAN, model: 'fixture-other', effort: 'low' }), code('BUSY'));
  assert.deepEqual(session.snapshot().selection, before.selection); await pending;
  assert.deepEqual(session.selectModel({ ...HUMAN, model: 'fixture-other', effort: 'low' }), { model: 'fixture-other', effort: 'low' });
});

// Local programmable stdio peer, owned by this test file. Modes control ACK
// races via a harmless account/read, never an installed CLI or live model.
async function switchPeer(t: test.TestContext, mode: string, deadline = 5000) {
  await mkdir(TEMP, { recursive: true }); const dir = await mkdtemp(join(TEMP, 'session-switch-'));
  const peer = join(dir, 'peer.mjs'), audit = join(dir, 'audit.jsonl');
  await writeFile(peer, `
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const [mode, audit] = process.argv.slice(2), threadId = 'fixture-thread';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const notify = (method, params) => send({ method, params });
let held = null, count = 0;
const threadReply = message => {
  notify('thread/started', { thread: { id: threadId, sessionId: 'fixture-session-root' } });
  send({ id: message.id, result: { thread: { id: threadId, sessionId: 'fixture-session-root', status: { type: 'idle' }, turns: [] }, model: message.params.model, modelProvider: 'openai', cwd: process.cwd(), approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'readOnly', networkAccess: false } } });
};
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line); appendFileSync(audit, JSON.stringify({ type: 'input', message }) + '\\n');
  const { id, method, params = {} } = message;
  if (method === 'initialize') { send({ id, result: {} }); return; }
  if (method === 'initialized') return;
  if (method === 'account/read') {
    send({ id, result: { account: { type: 'chatgpt', planType: 'pro' }, requiresOpenaiAuth: true } });
    if (held && mode !== 'unknown-terminal') { const old = held; held = null; if (old.method.startsWith('thread/')) threadReply(old); else send({ id: old.id, result: old.method === 'turn/start' ? { turn: { id: 'fixture-turn-' + count, status: 'inProgress' } } : {} }); }
    return;
  }
  if (method === 'model/list') { send({ id, result: { data: ['fixture-sol','fixture-other'].map(model => ({ id: 'picker-' + model, model, displayName: model, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'ultra' }] })), nextCursor: null } }); return; }
  if (method === 'thread/start' || method === 'thread/resume') {
    if (mode === 'pending-open') { held = message; return; }
    threadReply(message); return;
  }
  if (method === 'turn/start') {
    const turnId = 'fixture-turn-' + (++count);
    if (mode === 'reject-first' && count === 1) { send({ id, error: { code: -32000, message: 'fixture rejection' } }); return; }
    notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } });
    if (mode === 'unknown-rejection-terminal') { send({ id, error: { code: -32000, message: 'fixture observed rejection' } }); notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } }); return; }
    if (['pending-terminal','unknown-terminal'].includes(mode)) { held = message; notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } }); return; }
    send({ id, result: { turn: { id: turnId, status: 'inProgress' } } });
    if (mode.startsWith('terminal-')) notify('turn/completed', { threadId, turn: { id: turnId, status: mode.slice(9) } });
    return;
  }
  if (method === 'turn/interrupt') {
    if (mode === 'pending-interrupt') { held = message; notify('turn/completed', { threadId, turn: { id: params.turnId, status: 'interrupted' } }); return; }
    send({ id, result: {} }); notify('turn/completed', { threadId, turn: { id: params.turnId, status: 'interrupted' } }); return;
  }
});
`, 'utf8');
  const bounds = limits({ requestTimeoutMs: 5000 });
  const session = new CodexSession({ command: process.execPath, args: [peer, mode, audit], cwd: ROOT, env: nativeEnvironment() }, bounds, 'spawned-node-fixture');
  t.after(async () => { await session.close(); const child = relative(TEMP, dir); assert.ok(child.startsWith('session-switch-') && !child.includes(sep) && !child.includes('..')); await rm(dir, { recursive: true, force: true }); });
  await session.initialize(); Object.assign(bounds, { requestTimeoutMs: deadline });
  session.selectModel({ ...HUMAN, ...PAIR });
  const receipts = async (): Promise<Receipt[]> => (await readFile(audit, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Receipt);
  return { session, receipts };
}

for (const method of ['start', 'resume'] as const) test('same-thread selection refuses pending thread ' + method + ' before any notification', async t => {
  const { session, receipts } = await switchPeer(t, 'pending-open');
  const opening = method === 'start' ? session.startThread(HUMAN) : session.resumeThread({ ...HUMAN, threadId: THREAD });
  await until(async () => inputs(await receipts()).some(m => m.method === 'thread/' + method));
  assert.equal(session.snapshot().thread, null);
  assert.throws(() => session.selectModel({ ...HUMAN, model: 'fixture-other', effort: 'low' }), code('STATE'));
  assert.throws(() => session.selectModel({ ...HUMAN, ...PAIR }), code('STATE'));
  assert.deepEqual(session.snapshot().selection, PAIR); await session.readAccount(); await opening;
  assert.deepEqual(session.snapshot().thread!.selection, PAIR);
});

for (const terminal of ['completed', 'failed', 'interrupted']) test('same-thread selection preserves history and identity after terminal ' + terminal, async t => {
  const { session, receipts } = await switchPeer(t, 'terminal-' + terminal); await session.startThread(HUMAN); await session.startTurn(INPUT);
  await until(() => session.snapshot().thread?.turnStatus === terminal); const before = session.snapshot();
  session.selectModel({ ...HUMAN, model: 'fixture-other', effort: 'low' }); const after = session.snapshot();
  assert.equal(after.thread!.threadId, before.thread!.threadId); assert.equal(after.thread!.sessionId, before.thread!.sessionId);
  assert.equal(after.thread!.turnId, before.thread!.turnId); assert.equal(after.thread!.turnStatus, terminal);
  assert.deepEqual(after.events, before.events); assert.deepEqual(after.operations, before.operations);
  await session.startTurn(INPUT); const turns = inputs(await receipts()).filter(m => m.method === 'turn/start');
  assert.equal(turns.length, 2); assert.equal(turns[1]!.params!.model, 'fixture-other'); assert.equal(turns[1]!.params!.effort, 'low');
});

test('same-thread selection refuses a terminal notification while its turn ACK is still pending', async t => {
  const { session } = await switchPeer(t, 'pending-terminal'); await session.startThread(HUMAN); const turn = session.startTurn(INPUT);
  await until(() => session.snapshot().thread?.turnStatus === 'completed');
  assert.equal(session.snapshot().operations.at(-1)!.state, 'pending');
  assert.throws(() => session.selectModel({ ...HUMAN, model: 'fixture-other', effort: 'low' }), code('STATE'));
  await assert.rejects(() => session.startTurn(INPUT), code('BUSY'));
  await session.readAccount(); await turn; assert.equal(session.snapshot().thread!.turnStatus, 'completed');
  assert.doesNotThrow(() => session.selectModel({ ...HUMAN, model: 'fixture-other', effort: 'low' }));
});

test('same-thread selection refuses terminal interruption while its interrupt ACK is still pending', async t => {
  const { session } = await switchPeer(t, 'pending-interrupt'); await session.startThread(HUMAN); await session.startTurn(INPUT);
  const interrupt = session.interruptTurn({ ...HUMAN, threadId: THREAD, turnId: 'fixture-turn-1' });
  assert.throws(() => session.selectModel({ ...HUMAN, ...PAIR }), code('STATE'));
  await until(() => session.snapshot().thread?.turnStatus === 'interrupted');
  assert.throws(() => session.selectModel({ ...HUMAN, model: 'fixture-other', effort: 'low' }), code('STATE'));
  await session.readAccount(); await interrupt; assert.doesNotThrow(() => session.selectModel({ ...HUMAN, model: 'fixture-other', effort: 'low' }));
});

test('same-thread selection cannot turn a terminal lost acknowledgement into a safe new model action', async t => {
  const { session, receipts } = await switchPeer(t, 'unknown-terminal', 50); await session.startThread(HUMAN);
  await assert.rejects(() => session.startTurn(INPUT), code('TIMEOUT')); const before = session.snapshot();
  assert.equal(before.thread!.turnStatus, 'completed'); assert.equal(before.operations.at(-1)!.state, 'unknown');
  assert.throws(() => session.selectModel({ ...HUMAN, model: 'fixture-other', effort: 'low' }), code('DISCONNECTED'));
  assert.deepEqual(session.snapshot().selection, PAIR); assert.deepEqual(session.snapshot().thread!.selection, PAIR);
  assert.equal(inputs(await receipts()).filter(m => m.method === 'turn/start').length, 1);
});

test('same-thread selection is safe after a definite unsent or unobserved rejected turn', async t => {
  const { session } = await switchPeer(t, 'reject-first'); await session.startThread(HUMAN);
  await assert.rejects(() => session.startTurn(INPUT), code('REMOTE_REJECTED'));
  assert.equal(session.snapshot().operations.at(-1)!.state, 'rejected');
  assert.deepEqual(session.selectModel({ ...HUMAN, model: 'fixture-other', effort: 'low' }), { model: 'fixture-other', effort: 'low' });
  const limited = await open(t, 'normal', { maxQueuedBytes: 1024 });
  await assert.rejects(() => limited.session.startTurn({ ...INPUT, text: 'x'.repeat(1000) }), code('QUEUE_LIMIT'));
  assert.equal(limited.session.snapshot().operations.at(-1)!.state, 'not-sent');
  assert.doesNotThrow(() => limited.session.selectModel({ ...HUMAN, model: 'fixture-other', effort: 'low' }));
});


test('same-thread selection invalidates old approval acceptance and does not answer or reopen native work', async t => {
  const { session, receipts } = await open(t, 'approvals'); session.grantThreadWrites({ ...HUMAN, threadId: THREAD }); await session.startTurn(INPUT);
  await until(() => session.snapshot().approvals.length === 2); const approvals = session.snapshot().approvals;
  assert.throws(() => session.selectModel({ ...HUMAN, model: 'fixture-other', effort: 'low' }), code('STATE'));
  assert.equal(session.snapshot().thread!.writeGranted, true);
  await session.interruptTurn({ ...HUMAN, threadId: THREAD, turnId: 'fixture-turn-1' }); await until(() => session.snapshot().thread!.turnStatus === 'interrupted');
  session.grantThreadWrites({ ...HUMAN, threadId: THREAD }); const before = inputs(await receipts());
  session.selectModel({ ...HUMAN, model: 'fixture-other', effort: 'low' });
  assert.equal(session.snapshot().thread!.writeGranted, false); assert.deepEqual(session.snapshot().approvals, []);
  for (const approval of approvals) assert.throws(() => session.respondApproval(answer(approval)), code('STALE_APPROVAL'));
  await delay(10); assert.deepEqual(inputs(await receipts()), before);
});

test('same-thread selection blocks recorded unknown operation even if a later notification is terminal', async t => {
  const { session, receipts } = await switchPeer(t, 'unknown-rejection-terminal'); await session.startThread(HUMAN);
  await assert.rejects(() => session.startTurn(INPUT), code('REMOTE_REJECTED'));
  await until(() => session.snapshot().thread!.turnStatus === 'completed'); const before = session.snapshot();
  assert.equal(before.connected, true); assert.equal(before.operations.at(-1)!.state, 'unknown');
  assert.throws(() => session.selectModel({ ...HUMAN, model: 'fixture-other', effort: 'low' }), code('STATE'));
  assert.throws(() => session.selectModel({ ...HUMAN, ...PAIR }), code('STATE'));
  await assert.rejects(() => session.startTurn(INPUT), code('BUSY'));
  assert.deepEqual(session.snapshot().selection, PAIR); assert.deepEqual(session.snapshot().thread!.selection, PAIR);
  assert.equal(inputs(await receipts()).filter(m => m.method === 'turn/start').length, 1);
});

test('same-thread selection refuses an active resumed thread whose exact turn is unknown', async t => {
  const { session } = await fixture(t, 'resume-active-unknown'); session.selectModel({ ...HUMAN, ...PAIR }); await session.resumeThread({ ...HUMAN, threadId: THREAD });
  assert.equal(session.snapshot().thread!.configured, true); assert.equal(session.snapshot().thread!.turnStatus, 'unknown');
  assert.throws(() => session.selectModel({ ...HUMAN, model: 'fixture-other', effort: 'low' }), code('STATE'));
  assert.deepEqual(session.snapshot().selection, PAIR);
});


test('actual fragmented inbound overflow preserves finite observations on each original pending rejection',async t=>{
  const transport=new JsonlTransport({command:process.execPath,cwd:ROOT,env:nativeEnvironment(),args:['-e',
    "let count=0;require('node:readline').createInterface({input:process.stdin}).on('line',()=>{if(++count===2){process.stdout.write('x'.repeat(48));setTimeout(()=>process.stdout.write('y'.repeat(96)),15);}});"]},
    limits({maxFrameBytes:64,requestTimeoutMs:5000}),()=>assert.fail('oversized bytes must not be parsed'),()=>{});
  t.after(()=>transport.close());
  const results=await Promise.allSettled([transport.request('account/read',{}),transport.request('model/list',{})]);
  const a=results[0],b=results[1];assert.ok(a&&b&&a.status==='rejected'&&b.status==='rejected');
  assert.notEqual(a.reason,b.reason,'stop retains each pending request error object');
  for(const result of [a,b]){
    assert.equal(result.reason.code,'FRAME_LIMIT');assert.equal(result.reason.dispatched,true);
    const evidence=readNativeFrameEvidence(result.reason);assert.ok(evidence&&Object.isFrozen(evidence));
    assert.equal(evidence.schemaVersion,1);assert.equal(evidence.direction,'inbound');assert.equal(evidence.byteCountKind,'at-least');
    assert.ok(evidence.byteCount>64&&evidence.byteCount<=144);assert.equal(evidence.frameLimitBytes,64);
    assert.equal(evidence.pendingCount,2);assert.equal(evidence.pendingMethodMask,10);assert.equal(evidence.connectPhase,'not-connect');
    assert.equal(transport.isOwnedCloseRequestError(result.reason),false,'frame failure is not an intentional-close marker');
  }
  assert.deepEqual(readNativeFrameEvidence(a.reason),readNativeFrameEvidence(b.reason));
  annotateNativeConnectFrame(a.reason,'direct-initialize');
  assert.equal(readNativeFrameEvidence(a.reason)?.connectPhase,'direct-initialize');
  assert.equal(readNativeFrameEvidence(b.reason)?.connectPhase,'not-connect','annotation never retags another pending request');
  await transport.close();
});

test('actual outbound frame refusal reports exact UTF8 plus LF before dispatch and leaves the original close path intact',async t=>{
  const transport=new JsonlTransport({command:process.execPath,cwd:ROOT,env:nativeEnvironment(),args:['-e','process.stdin.resume();']},
    limits({maxFrameBytes:64,requestTimeoutMs:5000}),()=>{},()=>{});
  t.after(()=>transport.close());
  const params={payload:String.fromCodePoint(233).repeat(100)};
  const expectedBytes=Buffer.byteLength(JSON.stringify({id:1,method:'initialize',params})+'\n');
  await assert.rejects(transport.request('initialize',params),error=>{
    assert.ok(error!==null&&typeof error==='object'&&'code'in error&&'dispatched'in error);
    assert.equal(error.code,'FRAME_LIMIT');assert.equal(error.dispatched,false);
    assert.deepEqual(readNativeFrameEvidence(error),{schemaVersion:1,direction:'outbound',byteCountKind:'exact',
      byteCount:expectedBytes,frameLimitBytes:64,pendingMethodMask:1,pendingCount:1,connectPhase:'not-connect'});
    return true;
  });
  assert.equal(transport.connected,true,'diagnostics do not stop a prewrite-rejected transport');
  await transport.close();assert.equal(transport.connected,false);
});

test('an actual oversized unsolicited line has no pending-method attribution', {timeout:CODEX_LIMITS.requestTimeoutMs},async t=>{
  let finish!:(error:unknown)=>void;const disconnected=new Promise<unknown>(resolve=>{finish=resolve;});
  const transport=new JsonlTransport({command:process.execPath,cwd:ROOT,env:nativeEnvironment(),args:['-e',
    "process.stdout.write('z'.repeat(128));process.stdin.resume();"]},
    limits({maxFrameBytes:64,requestTimeoutMs:5000}),()=>assert.fail('oversized data cannot become a message'),error=>finish(error));
  t.after(()=>transport.close());
  const evidence=readNativeFrameEvidence(await disconnected);assert.ok(evidence);
  assert.equal(evidence.direction,'inbound');assert.equal(evidence.byteCountKind,'at-least');
  assert.ok(evidence.byteCount>64&&evidence.byteCount<=128);assert.equal(evidence.pendingCount,0);assert.equal(evidence.pendingMethodMask,0);
  await transport.close();
});
