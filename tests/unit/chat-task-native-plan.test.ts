import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { types } from 'node:util';
import { runInNewContext } from 'node:vm';
import { CodexSession } from '../../packages/codex-client/src/session.js';
import { nativeEnvironment } from '../../packages/codex-client/src/transport.js';
import { limits } from '../../packages/codex-client/src/validation.js';
import { ARCANE_NATIVE_TOOL_NAMES } from '../../packages/protocol/src/arcane-tools.js';
import { createChatTaskNativePlan, NativePlanError, type NativePlanOriginal } from '../../apps/daemon/src/chat-task-native-plan.js';

// Production CodexSession with an owned, labelled JSONL process peer. Not inference, Studio or acceptance.
const THREAD = 'plan.thread', SESSION = 'plan.session';
const PEER = String.raw`
const {createInterface}=require('node:readline'),{appendFileSync,existsSync}=require('node:fs');
const [encoded,audit]=process.argv.slice(1),s=JSON.parse(encoded);let turns=0,threadId=null;
const send=v=>process.stdout.write(JSON.stringify(v)+'\n'),reply=(id,result)=>send({id,result});
const gate=(name,fn)=>{const timer=setInterval(()=>{if(existsSync(s.gate+'-'+name)){clearInterval(timer);fn();}},5);};
gate('account',()=>send({method:'account/updated',params:{}}));
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line),{id,method,params={}}=m;appendFileSync(audit,JSON.stringify(m)+'\n');
 if(!method||method==='initialized')return;
 if(method==='initialize')return reply(id,{});
 if(method==='account/read')return reply(id,{account:{type:'chatgpt',email:'fixture@example.invalid',planType:'plus'},requiresOpenaiAuth:true});
 if(method==='model/list')return reply(id,{data:[{id:'fixture',model:'fixture',displayName:'Fixture',supportedReasoningEfforts:[{reasoningEffort:'low'}]}],nextCursor:null});
 if(method==='thread/start'){threadId='plan.thread';return reply(id,{thread:{id:threadId,sessionId:'plan.session',turns:[],status:{type:'idle'}},model:params.model,modelProvider:'openai',cwd:process.cwd(),approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:{type:'readOnly',networkAccess:false}});}
 if(method==='mcpServerStatus/list')return reply(id,{data:[{name:'arcane',runtimeStatus:'connected',toolsError:null,pluginId:null,tools:Object.fromEntries(s.tools.map(n=>[n,{}]))}],nextCursor:null});
 if(method==='turn/start'){turns++;const mode=s.turns[turns-1]??'complete';
  if(mode==='unknown')return reply(id,{});
  if(mode==='reject')return send({id,error:{code:-32000,message:'fixture refused'}});
  const turn={id:'plan.turn:'+turns,status:mode==='complete'?'completed':mode==='failed'?'failed':'inProgress'};reply(id,{turn});
  if(mode==='held'||mode==='held-interrupt')gate('turn'+turns,()=>send({method:'turn/completed',params:{threadId,turn:{...turn,status:mode==='held'?'completed':'interrupted'}}}));return;}
 if(method==='turn/interrupt')return reply(id,{});
});`;
interface Wire { method?: string }
const unhandled: unknown[] = []; process.on('unhandledRejection', error => { unhandled.push(error); });
const code = (name: NativePlanError['code']) => (error: unknown) => error instanceof NativePlanError && error.code === name;
async function fixture(t: test.TestContext, turns: string[] = []) {
  const base = await realpath(tmpdir()), root = await realpath(await mkdtemp(join(base, 'arcane-native-plan-'))), audit = join(root, 'wire.jsonl'), gate = join(root, 'gate');
  const hooks = Object.freeze({ finalCredential: () => 'c'.repeat(64), dispatched: () => {}, ended: () => {}, retired: () => {} });
  const client = new CodexSession({ command: process.execPath, args: ['-e', PEER, JSON.stringify({ gate, tools: ARCANE_NATIVE_TOOL_NAMES, turns }), audit], cwd: root, env: nativeEnvironment() },
    limits({ requestTimeoutMs: 1500 }), 'spawned-node-fixture', 'arcane-only', hooks);
  t.after(async () => { try { await client.close(); } catch { /* closed by the case */ }
    const part = relative(base, root); assert.ok(part.startsWith('arcane-native-plan-') && !isAbsolute(part) && !part.includes(sep)); await rm(root, { recursive: true, force: true }); });
  await client.initialize(); client.selectModel({ initiatedBy: 'human', model: 'fixture', effort: 'low' }); await client.startThread({ initiatedBy: 'human' });
  const started = await client.startManagedTask({ initiatedBy: 'human', threadId: THREAD, text: 'Original human task' });
  const snapshot = client.snapshot(), operation = snapshot.operations.find(entry => entry.method === 'turn/start')!;
  const original: NativePlanOriginal = { connectionId: snapshot.connectionId, threadId: THREAD, sessionId: SESSION, accountIdentity: client.taskAccountIdentity()!,
    model: 'fixture', effort: 'low', allowWorkspaceWrites: false, operationId: operation.operationId, turnId: operation.turnId! };
  const controller = new AbortController(); let checks = 0, failAt = Infinity;
  const owner = { signal: controller.signal, assertActive: () => { if (++checks >= failAt) throw new Error('retired'); } };
  const plan = (overrides: Partial<NativePlanOriginal> = {}, timing = { pollMs: 10, deadlineMs: 5000 }) =>
    createChatTaskNativePlan({ client, continuation: started.continuation, original: { ...original, ...overrides }, owner, timing });
  const wire = async (): Promise<Wire[]> => (await readFile(audit, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Wire);
  return { client, started, original, controller, owner, plan, wire, turns: async () => (await wire()).filter(row => row.method === 'turn/start').length,
    release: (name: string) => writeFile(gate + '-' + name, 'go', { flag: 'wx' }), failAfter(n: number) { failAt = checks + n; } };
}
const acks = () => { const seen: { operationId: string; turnId: string }[] = []; return { seen, ack: (value: { operationId: string; turnId: string }) => { seen.push(value); } }; };

test('two incorporation steps on the original client; acknowledgement is exact and once; repair stays usable', async t => {
  const f = await fixture(t, ['complete', 'complete', 'complete', 'complete']), plan = f.plan(), a = acks();
  await plan.waitForInitial();
  assert.equal(await plan.incorporate('Incorporate suggestion one', a.ack), 'completed');
  assert.equal(await plan.incorporate('Incorporate suggestion two', a.ack), 'completed');
  const operations = f.client.snapshot().operations.filter(op => op.method === 'turn/start');
  assert.deepEqual(a.seen, operations.slice(1, 3).map(op => ({ operationId: op.operationId, turnId: op.turnId })), 'one exact acknowledgement per call');
  await assert.rejects(plan.incorporate('third', a.ack), code('ORDER'));
  await f.client.continueTask({ continuation: f.started.continuation, text: 'Repair after planning' });
  assert.equal(await f.turns(), 4, 'the single repair continuation was never spent by planning');
  assert.equal(f.client.snapshot().connected, true, 'planning never closes the client');
});

test('waitForInitial observes only the exact original acknowledged turn reaching success', async t => {
  const held = await fixture(t, ['held']), plan = held.plan(); let done = false;
  const waiting = plan.waitForInitial().then(() => { done = true; }); await delay(50); assert.equal(done, false);
  await held.release('turn1'); await waiting; assert.equal(done, true);
  for (const wrong of [{ operationId: 'foreign-operation' }, { turnId: 'foreign-turn' }] as Partial<NativePlanOriginal>[]) {
    const f = await fixture(t, ['complete']), p = f.plan(wrong);
    await assert.rejects(p.waitForInitial(), code('SCOPE'), JSON.stringify(wrong));
    await assert.rejects(p.incorporate('x', () => {}), code('FENCED'));
  }
  const failed = await fixture(t, ['failed']), p = failed.plan();
  await assert.rejects(p.waitForInitial(), code('ORDER')); await assert.rejects(p.incorporate('x', () => {}), code('FENCED'));
  const interrupted = await fixture(t, ['held-interrupt']), q = interrupted.plan(), pending = q.waitForInitial();
  await interrupted.release('turn1'); await assert.rejects(pending, code('UNCERTAIN'));
});

test('a failed parent terminal returns failed and ends planning; repair is preserved', async t => {
  const f = await fixture(t, ['complete', 'failed', 'complete']), plan = f.plan(), a = acks();
  await plan.waitForInitial(); assert.equal(await plan.incorporate('step', a.ack), 'failed'); assert.equal(a.seen.length, 1);
  await assert.rejects(plan.incorporate('next', a.ack), code('FENCED'));
  await f.client.continueTask({ continuation: f.started.continuation, text: 'Repair' }); assert.equal(await f.turns(), 3);
});

test('unknown or rejected dispatch is never replayed or acknowledged', async t => {
  for (const mode of ['unknown', 'reject']) {
    const f = await fixture(t, ['complete', mode]), plan = f.plan(), a = acks();
    await plan.waitForInitial(); await assert.rejects(plan.incorporate('step', a.ack), code('UNCERTAIN'), mode);
    assert.equal(a.seen.length, 0); await assert.rejects(plan.incorporate('again', a.ack), code('FENCED')); assert.equal(await f.turns(), 2, mode);
  }
});

test('one flight: an overlapping or out-of-order call is refused; the first completes', async t => {
  const f = await fixture(t, ['complete', 'held']), plan = f.plan(), a = acks();
  await assert.rejects(plan.incorporate('before initial', a.ack), code('ORDER'));
  await plan.waitForInitial(); const first = plan.incorporate('held step', a.ack);
  await (async () => { const end = Date.now() + 5000; while (!a.seen.length) { assert.ok(Date.now() < end); await delay(5); } })();
  await assert.rejects(plan.incorporate('overlap', a.ack), code('ORDER')); await assert.rejects(plan.waitForInitial(), code('ORDER'));
  await f.release('turn2'); assert.equal(await first, 'completed'); assert.equal(await f.turns(), 2);
});

test('an acknowledgement callback failure (sync or async) is uncertain and never dispatches again', async t => {
  for (const ack of [() => { throw new Error('journal'); }, () => Promise.reject(new Error('async journal'))]) {
    const f = await fixture(t, ['complete', 'held']), plan = f.plan(); let called = 0;
    await plan.waitForInitial();
    await assert.rejects(plan.incorporate('step', ((value: unknown) => { called++; return (ack as (v: unknown) => unknown)(value); }) as never), code('UNCERTAIN'));
    assert.equal(called, 1); await assert.rejects(plan.incorporate('again', () => {}), code('FENCED')); assert.equal(await f.turns(), 2);
  }
});

test('owner retirement at every boundary refuses with no later effect and no client mutation', async t => {
  for (let n = 1; n <= 6; n++) {
    const f = await fixture(t, ['complete', 'complete']), plan = f.plan(), a = acks();
    await plan.waitForInitial(); f.failAfter(n);
    await assert.rejects(plan.incorporate('step', a.ack), code('RETIRED'), 'boundary ' + n);
    await assert.rejects(plan.incorporate('again', a.ack), code('FENCED'));
    assert.ok(a.seen.length <= 1); assert.ok(await f.turns() <= 2); assert.equal(f.client.snapshot().connected, true, 'plan abort never closes the client');
  }
  const f = await fixture(t, ['complete', 'held', 'complete']), plan = f.plan(), a = acks(); await plan.waitForInitial();
  const pending = plan.incorporate('held', a.ack);
  await (async () => { const end = Date.now() + 5000; while (!a.seen.length) { assert.ok(Date.now() < end); await delay(5); } })();
  f.controller.abort(); await assert.rejects(pending, code('RETIRED'));
  assert.equal(getEventListeners(f.controller.signal, 'abort').length, 0, 'listeners cleared');
  await f.release('turn2'); await delay(30);
  assert.equal(f.client.snapshot().connected, true);
  await f.client.continueTask({ continuation: f.started.continuation, text: 'Repair after plan abort' }); assert.equal(await f.turns(), 3);
});

test('bounded observation times out and clears its timer and listener', async t => {
  const f = await fixture(t, ['held']), plan = f.plan({}, { pollMs: 10, deadlineMs: 60 });
  await assert.rejects(plan.waitForInitial(), code('TIMEOUT'));
  assert.equal(getEventListeners(f.controller.signal, 'abort').length, 0);
  assert.throws(() => f.plan({}, { pollMs: 5, deadlineMs: 60 }), code('INPUT'));
  assert.throws(() => f.plan({}, { pollMs: 10, deadlineMs: 300001 }), code('INPUT'));
});
test('an acknowledgement must return exactly undefined; nonvoid, thenable and cross-realm promise returns are uncertain', async t => {
  let thenCalls = 0;
  const returns: [string, () => unknown][] = [['true', () => true], ['text', () => 'recorded'], ['zero', () => 0], ['null', () => null],
    ['thenable', () => ({ then() { thenCalls++; } })],
    ['cross-realm rejected promise', () => { const value = runInNewContext('Promise.reject(new Error("cross-realm journal"))') as unknown;
      assert.ok(types.isPromise(value) && !(value instanceof Promise), 'a real promise that instanceof misses'); return value; }]];
  for (const [what, result] of returns) {
    const f = await fixture(t, ['complete', 'held']), plan = f.plan(); let called = 0;
    await plan.waitForInitial();
    await assert.rejects(plan.incorporate('step', (() => { called++; return result(); }) as never), code('UNCERTAIN'), what);
    assert.equal(called, 1, what); await assert.rejects(plan.incorporate('again', () => {}), code('FENCED')); assert.equal(await f.turns(), 2, what + ' never redispatches');
  }
  assert.equal(thenCalls, 0, 'an arbitrary thenable is never inspected or invoked');
});
test('the observation bound is strict: a terminal first seen after the deadline times out, and the last poll is clamped to the bound', async t => {
  {
    const f = await fixture(t, ['complete', 'held']), plan = f.plan({}, { pollMs: 1000, deadlineMs: 150 });
    await plan.waitForInitial(); let acknowledgedAt = 0;
    const pending = plan.incorporate('late terminal', () => { acknowledgedAt = Date.now(); }); void pending.catch(() => {});
    while (!acknowledgedAt) await delay(1);
    await f.release('turn2'); // the turn completes well inside the bound...
    while (f.client.snapshot().thread?.turnStatus !== 'completed') await delay(1);
    assert.ok(Date.now() < acknowledgedAt + 150, 'terminal reached before the bound');
    while (Date.now() < acknowledgedAt + 300) { /* ...but the host is blocked until after it, so the first observation is late */ }
    await assert.rejects(pending, code('TIMEOUT'), 'a terminal first observed after the bound is never accepted');
  }
  {
    const f = await fixture(t, ['complete', 'held']), plan = f.plan({}, { pollMs: 1000, deadlineMs: 100 });
    await plan.waitForInitial(); const started = Date.now();
    await assert.rejects(plan.incorporate('held turn', () => {}), code('TIMEOUT'));
    const elapsed = Date.now() - started; t.diagnostic('clamped timeout after ' + elapsed + ' ms (bound 100 ms, poll 1000 ms)');
    assert.ok(elapsed < 700, 'the next poll is clamped to the remaining bound, not a full poll interval');
    assert.equal(getEventListeners(f.controller.signal, 'abort').length, 0);
  }
});

test('selection, account and write-policy drift refuse before any dispatch', async t => {
  const drift: [string, (f: Awaited<ReturnType<typeof fixture>>) => Promise<void> | void][] = [
    ['selection', f => { f.client.selectModel({ initiatedBy: 'human', model: 'fixture', effort: 'low' }); }],
    ['write grant', f => { f.client.grantThreadWrites({ initiatedBy: 'human', threadId: THREAD }); }],
    ['account', async f => { await f.release('account'); const end = Date.now() + 5000; while (f.client.snapshot().ready) { assert.ok(Date.now() < end); await delay(5); } }],
  ];
  for (const [name, change] of drift) {
    const f = await fixture(t, ['complete', 'complete']), plan = f.plan(); await plan.waitForInitial(); await change(f);
    await assert.rejects(plan.incorporate('step', () => {}), (error: unknown) => code('SCOPE')(error) || code('UNCERTAIN')(error), name);
    assert.equal(await f.turns(), 1, name);
  }
  const g = await fixture(t, ['complete']);
  await assert.rejects(g.plan({ sessionId: 'other.session' }).waitForInitial(), code('SCOPE'));
  await assert.rejects(g.plan({ accountIdentity: 'b'.repeat(64) }).waitForInitial(), code('SCOPE'));
});

test('proxy, accessor, __proto__ and async-owner envelopes are refused without traps or unhandled rejections', async t => {
  const f = await fixture(t, ['complete']); let traps = 0, reads = 0;
  const handler: ProxyHandler<object> = Object.fromEntries(['get', 'has', 'ownKeys', 'getOwnPropertyDescriptor', 'getPrototypeOf'].map(name => [name, (...args: unknown[]) => { traps++; return (Reflect as unknown as Record<string, Function>)[name]!(...args); }]));
  const base = { client: f.client, continuation: f.started.continuation, original: f.original, owner: f.owner };
  assert.throws(() => createChatTaskNativePlan(new Proxy(base, handler) as never), code('INPUT'));
  assert.throws(() => createChatTaskNativePlan({ ...base, original: new Proxy(f.original, handler) as never }), code('INPUT'));
  assert.throws(() => createChatTaskNativePlan({ ...base, owner: new Proxy(f.owner, handler) as never }), code('INPUT')); assert.equal(traps, 0);
  assert.throws(() => createChatTaskNativePlan({ ...base, original: Object.defineProperty({ ...f.original }, 'turnId', { enumerable: true, get: () => { reads++; return 'x'; } }) }), code('INPUT')); assert.equal(reads, 0);
  assert.throws(() => createChatTaskNativePlan({ ...base, original: JSON.parse(JSON.stringify(f.original).replace(/^{/, '{"__proto__":{"polluted":true},')) }), code('INPUT'), 'a real own __proto__ key is refused as data');
  assert.equal(({} as Record<string, unknown>).polluted, undefined, 'no prototype pollution');
  const controller = new AbortController();
  const asyncOwner = createChatTaskNativePlan({ ...base, owner: { signal: controller.signal, assertActive: (() => Promise.reject(new Error('async'))) as never } });
  await assert.rejects(asyncOwner.waitForInitial(), code('RETIRED'));
  await delay(20);
});

test('no unhandled rejections', async () => { await delay(20); assert.deepEqual(unhandled, []); });
