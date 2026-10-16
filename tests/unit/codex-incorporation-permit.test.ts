import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexSession } from '../../packages/codex-client/src/session.js';
import { nativeEnvironment } from '../../packages/codex-client/src/transport.js';
import { limits } from '../../packages/codex-client/src/validation.js';
import { ARCANE_NATIVE_TOOL_NAMES } from '../../packages/protocol/src/arcane-tools.js';
import type { NativeIncorporationChain, NativeIncorporationPermit, NativeTaskContinuation } from '../../packages/codex-client/src/index.js';

// Production CodexSession with a labelled JSONL process peer owned by this test.
// This is not a native provider, inference, Studio or customer acceptance test.
const THREAD = 'incorp.thread', SESSION = 'incorp.session';
const PEER = String.raw`
const {createInterface}=require('node:readline'),{appendFileSync,existsSync}=require('node:fs');
const [encoded,audit]=process.argv.slice(1),s=JSON.parse(encoded);let checks=0,turns=0,threadId=null;
const send=v=>process.stdout.write(JSON.stringify(v)+'\n'),reply=(id,result)=>send({id,result});
const gate=(name,fn)=>{const timer=setInterval(()=>{if(existsSync(s.gate+'-'+name)){clearInterval(timer);fn();}},5);};
gate('account',()=>send({method:'account/updated',params:{}}));
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line),{id,method,params={}}=m;appendFileSync(audit,JSON.stringify(m)+'\n');
 if(!method||method==='initialized')return;
 if(method==='initialize')return reply(id,{});
 if(method==='account/read')return reply(id,{account:{type:'chatgpt',email:'fixture@example.invalid',planType:'plus'},requiresOpenaiAuth:true});
 if(method==='model/list')return reply(id,{data:[{id:'fixture',model:'fixture',displayName:'Fixture',supportedReasoningEfforts:[{reasoningEffort:'low'}]}],nextCursor:null});
 if(method==='thread/start'){threadId='incorp.thread';return reply(id,{thread:{id:threadId,sessionId:'incorp.session',turns:[],status:{type:'idle'}},model:params.model,modelProvider:'openai',cwd:process.cwd(),approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:{type:'readOnly',networkAccess:false}});}
 if(method==='mcpServerStatus/list'){checks++;const result={data:[{name:'arcane',runtimeStatus:'connected',toolsError:null,pluginId:null,tools:Object.fromEntries(s.tools.map(n=>[n,{}]))}],nextCursor:null};
  if(s.holdCheck===checks)return gate('preflight',()=>reply(id,result));return reply(id,result);}
 if(method==='turn/start'){turns++;const mode=s.turns[turns-1]??'complete';
  if(mode==='unknown')return reply(id,{});
  if(mode==='reject')return send({id,error:{code:-32000,message:'fixture refused'}});
  const turn={id:'incorp.turn:'+turns,status:mode==='complete'?'completed':mode==='failed'?'failed':'inProgress'};reply(id,{turn});
  if(mode==='held')gate('turn'+turns,()=>send({method:'turn/completed',params:{threadId,turn:{...turn,status:'completed'}}}));return;}
 if(method==='turn/interrupt')return reply(id,{});
});`;
interface Wire { method?: string; params?: Record<string, unknown> }
const unhandled: unknown[] = []; process.on('unhandledRejection', error => { unhandled.push(error); });
async function until(check: () => boolean | Promise<boolean>) { const end = Date.now() + 6000; while (!await check()) { assert.ok(Date.now() < end, 'expected fixture state'); await delay(5); } }
async function fixture(t: test.TestContext, options: { turns?: string[]; holdCheck?: number; allowWorkspaceWrites?: boolean } = {}) {
  const base = await realpath(tmpdir()), root = await realpath(await mkdtemp(join(base, 'arcane-incorporation-'))), audit = join(root, 'wire.jsonl'), gate = join(root, 'gate');
  const hooks = Object.freeze({ finalCredential: () => 'c'.repeat(64), dispatched: () => {}, ended: () => {}, retired: () => {} });
  const client = new CodexSession({ command: process.execPath, args: ['-e', PEER, JSON.stringify({ gate, tools: ARCANE_NATIVE_TOOL_NAMES, turns: options.turns ?? [], holdCheck: options.holdCheck ?? 0 }), audit],
    cwd: root, env: nativeEnvironment() }, limits({ requestTimeoutMs: 1500 }), 'spawned-node-fixture', 'arcane-only', hooks);
  t.after(async () => { try { await client.close(); } catch { /* closed by the case */ }
    const part = relative(base, root); assert.ok(part.startsWith('arcane-incorporation-') && !isAbsolute(part) && !part.includes(sep)); await rm(root, { recursive: true, force: true }); });
  await client.initialize(); client.selectModel({ initiatedBy: 'human', model: 'fixture', effort: 'low' }); await client.startThread({ initiatedBy: 'human' });
  const started = await client.startManagedTask({ initiatedBy: 'human', threadId: THREAD, text: 'Original human task', ...(options.allowWorkspaceWrites ? { allowWorkspaceWrites: true } : {}) });
  const wire = async (): Promise<Wire[]> => (await readFile(audit, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Wire);
  const turns = async () => (await wire()).filter(row => row.method === 'turn/start');
  const open = (maxSteps = 3) => client.openIncorporationChain({ continuation: started.continuation, maxSteps });
  return { client, started, wire, turns, open, release: (name: string) => writeFile(gate + '-' + name, 'go', { flag: 'wx' }) };
}
const scope = (error: unknown) => !!error && typeof error === 'object' && (error as { code?: string }).code === 'TASK_SCOPE';
const step = (f: Awaited<ReturnType<typeof fixture>>, chain: NativeIncorporationChain, text: string) => {
  const permit = f.client.issueIncorporationPermit({ chain }); return f.client.continueIncorporation({ chain, permit, text }); };

test('two sequential incorporation turns keep the exact original identity and leave the one repair usable', async t => {
  const f = await fixture(t, { turns: ['complete', 'complete', 'complete', 'complete'] }), chain = f.open(2);
  await step(f, chain, 'Incorporate suggestion one'); await step(f, chain, 'Incorporate suggestion two');
  assert.throws(() => f.client.issueIncorporationPermit({ chain }), scope, 'over budget');
  const turns = await f.turns(); assert.equal(turns.length, 3);
  for (const turn of turns) { assert.equal(turn.params!.threadId, THREAD); assert.equal(turn.params!.model, 'fixture'); assert.equal(turn.params!.effort, 'low');
    assert.deepEqual(turn.params!.sandboxPolicy, { type: 'readOnly', networkAccess: false }, 'no write expansion'); }
  assert.equal(f.client.snapshot().thread!.sessionId, SESSION);
  await f.client.continueTask({ continuation: f.started.continuation, text: 'One bounded repair' });
  assert.equal((await f.turns()).length, 4, 'the repair token was untouched by incorporation');
  await assert.rejects(f.client.continueTask({ continuation: f.started.continuation, text: 'Replay' }), scope);
});

test('the original write policy is retained, never expanded', async t => {
  const f = await fixture(t, { turns: ['complete', 'complete'], allowWorkspaceWrites: true }), chain = f.open(1);
  await step(f, chain, 'Incorporate');
  assert.equal((await f.turns())[1]!.params!.sandboxPolicy && ((await f.turns())[1]!.params!.sandboxPolicy as { type: string }).type, 'workspaceWrite');
  assert.equal(f.client.snapshot().thread!.writeGranted, false, 'automatic write ends with its own turn');
});

test('forged, duplicate, foreign, malformed, out-of-order and over-budget capabilities are refused', async t => {
  const f = await fixture(t, { turns: ['complete', 'held', 'complete'] }), other = await fixture(t);
  assert.throws(() => f.client.openIncorporationChain({ continuation: structuredClone(f.started.continuation), maxSteps: 1 }), scope);
  assert.throws(() => f.client.openIncorporationChain({ continuation: other.started.continuation, maxSteps: 1 }), scope);
  for (const maxSteps of [0, 4, 1.5, Number.NaN]) assert.throws(() => f.client.openIncorporationChain({ continuation: f.started.continuation, maxSteps }), { code: 'ARGUMENTS' });
  assert.throws(() => f.client.openIncorporationChain({ continuation: f.started.continuation, maxSteps: '2' } as never), { code: 'ARGUMENTS' });
  assert.throws(() => f.client.openIncorporationChain({ continuation: f.started.continuation, maxSteps: 1, initiatedBy: 'human' } as never), { code: 'ARGUMENTS' });
  let reads = 0; const accessor = Object.defineProperty({ maxSteps: 1 }, 'continuation', { enumerable: true, get: () => { reads++; return f.started.continuation; } });
  assert.throws(() => f.client.openIncorporationChain(accessor as never), { code: 'ARGUMENTS' }); assert.equal(reads, 0, 'accessor never invoked');
  let traps=0;
  const proxy=<T extends object>(value:T)=>new Proxy(value,{ownKeys(target){traps++;return Reflect.ownKeys(target);},
    getOwnPropertyDescriptor(target,key){traps++;return Reflect.getOwnPropertyDescriptor(target,key);},getPrototypeOf(target){traps++;return Reflect.getPrototypeOf(target);}});
  assert.throws(()=>f.client.openIncorporationChain(proxy({continuation:f.started.continuation,maxSteps:1})),{code:'ARGUMENTS'});
  const revoked=Proxy.revocable({continuation:f.started.continuation,maxSteps:1},{});revoked.revoke();
  assert.throws(()=>f.client.openIncorporationChain(revoked.proxy),{code:'ARGUMENTS'});
  const chain = f.open(2);
  assert.throws(()=>f.client.issueIncorporationPermit(proxy({chain})),{code:'ARGUMENTS'});
  assert.throws(() => f.open(1), scope, 'one chain per original task continuation');
  assert.throws(() => f.client.issueIncorporationPermit({ chain: structuredClone(chain) }), scope);
  const otherChain = other.open(1);
  assert.throws(() => f.client.issueIncorporationPermit({ chain: otherChain }), scope);
  const permit = f.client.issueIncorporationPermit({ chain });
  await assert.rejects(f.client.continueIncorporation(proxy({chain,permit,text:'Proxy envelope'})),{code:'ARGUMENTS'});assert.equal(traps,0);
  assert.throws(() => f.client.issueIncorporationPermit({ chain }), scope, 'no duplicate outstanding permit');
  await assert.rejects(f.client.continueIncorporation({ chain, permit: structuredClone(permit), text: 'forged' }), scope);
  await assert.rejects(f.client.continueIncorporation({ chain, permit: other.client.issueIncorporationPermit({ chain: otherChain }) as NativeIncorporationPermit, text: 'foreign' }), scope);
  await assert.rejects(f.client.continueIncorporation({ chain, permit, text: 'x'.repeat(200000) }), { code: 'ARGUMENTS' });
  await assert.rejects(f.client.continueIncorporation({ chain, permit, text: 'extra', initiatedBy: 'human' } as never), { code: 'ARGUMENTS' });
  assert.equal((await f.turns()).length, 1, 'refusals consumed nothing and sent nothing');
  await f.client.continueIncorporation({ chain, permit, text: 'Step one (held)' });
  await assert.rejects(f.client.continueIncorporation({ chain, permit, text: 'Replay' }), scope);
  assert.throws(() => f.client.issueIncorporationPermit({ chain }), scope, 'previous owned turn is not terminal yet');
  await f.release('turn2'); await until(() => f.client.snapshot().thread!.turnStatus === 'completed');
  await step(f, chain, 'Step two'); assert.throws(() => f.client.issueIncorporationPermit({ chain }), scope);
  assert.equal((await f.turns()).length, 3);
});

test('overlapping repair, incorporation and issue requests are refused without spending repair', async t => {
  const f = await fixture(t, { turns: ['complete', 'complete', 'complete'], holdCheck: 3 }), chain = f.open(2);
  const permit = f.client.issueIncorporationPermit({ chain }), pending = f.client.continueIncorporation({ chain, permit, text: 'Held in preflight' });
  void pending.catch(() => {});
  await until(async () => (await f.wire()).filter(row => row.method === 'mcpServerStatus/list').length === 3);
  await assert.rejects(f.client.continueTask({ continuation: f.started.continuation, text: 'Overlapping repair' }), { code: 'BUSY' });
  await assert.rejects(f.client.continueIncorporation({ chain, permit, text: 'Overlap' }), scope);
  assert.throws(() => f.client.issueIncorporationPermit({ chain }), scope);
  await f.release('preflight'); await pending;
  await f.client.continueTask({ continuation: f.started.continuation, text: 'Repair still available' });
  assert.equal((await f.turns()).length, 3);
});

test('retirement during preflight suppresses dispatch and fences the chain', async t => {
  const f = await fixture(t, { turns: ['complete', 'complete'], holdCheck: 3 }), chain = f.open(2);
  const permit = f.client.issueIncorporationPermit({ chain }), pending = f.client.continueIncorporation({ chain, permit, text: 'Held in preflight' });
  void pending.catch(() => {});
  await until(async () => (await f.wire()).filter(row => row.method === 'mcpServerStatus/list').length === 3);
  f.client.revokeTaskContinuation(); await f.release('preflight');
  await assert.rejects(pending, { code: 'GRANT_REVOKED', dispatched: false });
  assert.equal((await f.turns()).length, 1); assert.throws(() => f.client.issueIncorporationPermit({ chain }), scope);
});

test('unknown and rejected dispatch are never replayed and issue no replacement step', async t => {
  for (const mode of ['unknown', 'reject']) {
    const f = await fixture(t, { turns: ['complete', mode, 'complete'] }), chain = f.open(3);
    const permit = f.client.issueIncorporationPermit({ chain });
    await assert.rejects(f.client.continueIncorporation({ chain, permit, text: 'May be lost' }));
    await assert.rejects(f.client.continueIncorporation({ chain, permit, text: 'Replay' }), scope);
    assert.throws(() => f.client.issueIncorporationPermit({ chain }), scope);
    assert.equal((await f.turns()).length, 2, mode);
  }
});

test('model, grant, account and connection drift refuse further steps', async t => {
  const drifts: [string, (f: Awaited<ReturnType<typeof fixture>>) => Promise<void> | void][] = [
    ['model selection', f => { f.client.selectModel({ initiatedBy: 'human', model: 'fixture', effort: 'low' }); }],
    ['write grant expansion', f => { f.client.grantThreadWrites({ initiatedBy: 'human', threadId: THREAD }); }],
    ['account update', async f => { await f.release('account'); await until(() => f.client.snapshot().account === null || !f.client.snapshot().ready); }],
    ['disconnect', f => f.client.close()],
  ];
  for (const [name, drift] of drifts) {
    const f = await fixture(t, { turns: ['complete', 'complete'] }), chain = f.open(2);
    await drift(f);
    assert.throws(() => f.client.issueIncorporationPermit({ chain }), (error: unknown) => !!error && typeof error === 'object' && ['TASK_SCOPE', 'DISCONNECTED', 'SUBSCRIPTION_REQUIRED'].includes((error as { code: string }).code), name);
    assert.equal((await f.turns()).length, 1, name);
  }
});

test('every human/host revoke path ends the chain, including after repair was spent', async t => {
  const paths: [string, (f: Awaited<ReturnType<typeof fixture>>) => Promise<unknown> | unknown][] = [
    ['human follow-up', f => f.client.startTurn({ initiatedBy: 'human', threadId: THREAD, text: 'Human follow-up' })],
    ['replacement managed start', f => f.client.startManagedTask({ initiatedBy: 'human', threadId: THREAD, text: 'New task' })],
    ['task revocation', f => f.client.revokeTaskContinuation()],
    ['write revocation', f => f.client.revokeThreadWrites({ initiatedBy: 'human', threadId: THREAD })],
    ['repair spent', f => f.client.continueTask({ continuation: f.started.continuation, text: 'Repair' })],
    ['close', f => f.client.close()],
  ];
  for (const [name, revoke] of paths) {
    const f = await fixture(t, { turns: ['complete', 'complete', 'complete'] }), chain = f.open(3), permit = f.client.issueIncorporationPermit({ chain });
    await revoke(f);
    await assert.rejects(f.client.continueIncorporation({ chain, permit, text: 'After revoke' }), name);
    assert.throws(() => f.client.issueIncorporationPermit({ chain }), name);
  }
  const g = await fixture(t, { turns: ['complete', 'held'] }), chain = g.open(2);
  await step(g, chain, 'Active incorporation turn');
  await g.client.interruptTurn({ initiatedBy: 'human', threadId: THREAD, turnId: g.client.snapshot().thread!.turnId! });
  assert.throws(() => g.client.issueIncorporationPermit({ chain }), scope, 'interrupt');
  const h = await fixture(t, { turns: ['complete', 'complete'] }); h.client.revokeTaskContinuation();
  assert.throws(() => h.open(1), scope, 'a revoked repair capability cannot open a chain');
  void (null as unknown as NativeTaskContinuation);
});

test('no unhandled rejections from incorporation paths', async () => { await delay(20); assert.deepEqual(unhandled, []); });
