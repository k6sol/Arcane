import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexSession } from '../../packages/codex-client/src/session.js';
import { parseNativeRateLimits, mergeNativeRateLimitUpdate } from '../../packages/codex-client/src/rate-limits.js';
import { nativeEnvironment } from '../../packages/codex-client/src/transport.js';
import { limits } from '../../packages/codex-client/src/validation.js';

const HUMAN = { initiatedBy: 'human' } as const, NOW = 1_792_102_400_000;
const window = (usedPercent = 25) => ({ usedPercent, windowDurationMins: 300, resetsAt: 1_792_104_000 });
const bucket = (limitId = 'codex') => ({ limitId, limitName: 'Codex', normalModelSlug: 'fixture-model', primary: window(), secondary: null,
  credits: { hasCredits: true, unlimited: false, balance: 'SYNTHETIC_PRIVATE_BALANCE' }, spendControlReached: false, rateLimitReachedType: null });
const response = () => ({ ordinaryUsageAllowed: true, rateLimits: bucket(), rateLimitsByLimitId: { codex: bucket(), other: bucket('other') },
  accountId: 'SYNTHETIC_PRIVATE_ACCOUNT', rateLimitUpsell: { secret: 'SYNTHETIC_PRIVATE_BANNER' },
  rateLimitResetCredits: { credits: [{ id: 'SYNTHETIC_PRIVATE_RESET' }] }, accessToken: 'SYNTHETIC_PRIVATE_TOKEN' });
const update = (raw: unknown) => ({ method: 'account/rateLimits/updated', params: { rateLimits: raw } });
const code = (expected: string) => (e: unknown) => e instanceof Error && 'code' in e && e.code === expected;

test('rate-limit full snapshots preserve measured windows and omit private account, balance and reset data', () => {
  const raw = response(), parsed = parseNativeRateLimits(raw, NOW)!;
  assert.equal(parsed.buckets.length, 2); assert.equal(parsed.ordinaryUsageAllowed, true); assert.equal(parsed.observedAt, NOW);
  assert.deepEqual(parsed.buckets[0]!.primary, window()); assert.deepEqual(parsed.buckets[0]!.credits, { hasCredits: true, unlimited: false });
  assert.doesNotMatch(JSON.stringify(parsed), /SYNTHETIC_PRIVATE|accountId|accessToken|balance|rateLimitResetCredits|rateLimitUpsell/);
  raw.rateLimits.primary.usedPercent = 98; assert.equal(parsed.buckets[0]!.primary!.usedPercent, 25);
});
test('rate-limit compatibility snapshots keep missing metadata unknown, including zero usage and absent reset times', () => {
  const parsed = parseNativeRateLimits({ rateLimits: { primary: { usedPercent: 0, windowDurationMins: null, resetsAt: null } } }, NOW)!;
  assert.equal(parsed.ordinaryUsageAllowed, null); assert.equal(parsed.buckets[0]!.primary!.usedPercent, 0);
  assert.equal(parsed.buckets[0]!.primary!.resetsAt, null); assert.equal(parsed.buckets[0]!.credits, null);
  assert.equal(parsed.buckets[0]!.limitId, null);
});
test('rate-limit sparse updates preserve bucket metadata and cannot infer recovery from a low percentage', () => {
  const raw = response(); raw.ordinaryUsageAllowed = false;
  const full = parseNativeRateLimits(raw, NOW)!; full.buckets[0]!.rateLimitReachedType = 'workspace_member_usage_limit_reached';
  const next = mergeNativeRateLimitUpdate(full, { rateLimits: { limitId: 'codex', limitName: null, primary: window(0), spendControlReached: null } }, NOW + 1)!;
  assert.equal(next.buckets.length, 2); assert.equal(next.buckets[0]!.limitName, 'Codex'); assert.equal(next.buckets[0]!.normalModelSlug, 'fixture-model');
  assert.equal(next.buckets[0]!.primary!.usedPercent, 0); assert.equal(next.buckets[0]!.spendControlReached, null);
  assert.equal(next.buckets[0]!.rateLimitReachedType, 'workspace_member_usage_limit_reached'); assert.equal(next.ordinaryUsageAllowed, false);
  assert.equal(full.buckets[0]!.primary!.usedPercent, 25);
  const allowed = parseNativeRateLimits(response(), NOW)!;
  assert.equal(mergeNativeRateLimitUpdate(allowed, { rateLimits: bucket() }, NOW + 1)!.ordinaryUsageAllowed, null);
  assert.equal(parseNativeRateLimits(response(), NOW + 2)!.buckets[0]!.rateLimitReachedType, null);
});
test('rate-limit full reads reject conflicting aliases, invalid metered keys and excessive inventories', () => {
  const conflict = response(); conflict.rateLimitsByLimitId.codex.primary.usedPercent = 26;
  assert.equal(parseNativeRateLimits(conflict, NOW), null);
  assert.equal(parseNativeRateLimits({ rateLimits: bucket(), rateLimitsByLimitId: { mismatched: bucket() } }, NOW), null);
  assert.equal(parseNativeRateLimits({ rateLimits: bucket(), rateLimitsByLimitId: {} }, NOW), null);
  assert.equal(parseNativeRateLimits({ rateLimits: bucket(), rateLimitsByLimitId: Object.fromEntries(Array.from({length:17}, (_,i) => ['quota'+i,bucket('quota'+i)])) }, NOW), null);
  const full = parseNativeRateLimits({rateLimits:bucket(),rateLimitsByLimitId:Object.fromEntries(Array.from({length:16},(_,i)=>['q'+i,bucket('q'+i)]))},NOW)!;
  assert.equal(mergeNativeRateLimitUpdate(full,{rateLimits:bucket('new')},NOW),null);
  assert.equal(mergeNativeRateLimitUpdate(full,{rateLimits:bucket('q0')},NOW)!.buckets.length,16);
});
test('rate-limit parsers reject malformed values and accessors without reading them', () => {
  for (const bad of [-1, Infinity, NaN, '25', null, 1_000_001]) assert.equal(parseNativeRateLimits({rateLimits:{primary:{...window(),usedPercent:bad}}},NOW),null);
  for (const bad of [-1, 0.5, '300', Infinity]) assert.equal(parseNativeRateLimits({rateLimits:{primary:{...window(),resetsAt:bad}}},NOW),null);
  for (const bad of ['', 'x'.repeat(161), '\u202equota', '\uD800']) assert.equal(parseNativeRateLimits({rateLimits:{...bucket(),limitName:bad}},NOW),null);
  assert.equal(parseNativeRateLimits({rateLimits:{...bucket(),credits:{hasCredits:'true',unlimited:false}}},NOW),null);
  assert.equal(parseNativeRateLimits({rateLimits:{...bucket(),rateLimitReachedType:'invented'}},NOW),null);
  assert.equal(parseNativeRateLimits(response(),NaN),null);
  let called=false; const getter=Object.defineProperty({},'primary',{get(){called=true;throw Error('Must not read');}});
  assert.equal(parseNativeRateLimits({rateLimits:getter},NOW),null); assert.equal(called,false);
  assert.equal(mergeNativeRateLimitUpdate(undefined,[],NOW),null);
  assert.equal(parseNativeRateLimits({rateLimits:{...bucket(),primary:window(120.5)}},NOW)!.buckets[0]!.primary!.usedPercent,120.5);
});

// Spawned synthetic JSONL peer only. No installed provider, credentials or Studio.
function peer(): void {
  const {createInterface}=require('node:readline') as typeof import('node:readline');
  const {existsSync,readFileSync,appendFileSync}=require('node:fs') as typeof import('node:fs');
  const [gate,audit,mode]=process.argv.slice(1); let last='',pending:number|undefined;
  const send=(v:unknown)=>process.stdout.write(JSON.stringify(v)+'\n');
  setInterval(()=>{if(!existsSync(gate!))return;const raw=readFileSync(gate!,'utf8');if(!raw||raw===last)return;
    let row:{notifications?:unknown[];reply?:unknown;marker:number};try{row=JSON.parse(raw) as typeof row;}catch{return;}last=raw;
    for(const n of row.notifications??[])send(n); if(Object.hasOwn(row,'reply')&&pending!==undefined){send({id:pending,result:row.reply});pending=undefined;}
    send({method:'item/agentMessage/delta',params:{threadId:'limits-thread',turnId:'limits-turn',itemId:'barrier',delta:'barrier:'+row.marker}});
  },5);
  createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line) as {id:number;method:string;params:Record<string,unknown>};
    appendFileSync(audit!,JSON.stringify({method:m.method,params:m.params})+'\n'); const result=(v:unknown)=>send({id:m.id,result:v});
    if(m.method==='initialize')result({});
    else if(m.method==='account/read')result({account:mode==='signed-out'?null:{type:'chatgpt',planType:'plus',email:'synthetic@example.invalid'},requiresOpenaiAuth:true});
    else if(m.method==='model/list')result({data:[{id:'fixture-model',model:'fixture-model',displayName:'Fixture',supportedReasoningEfforts:[{reasoningEffort:'ultra'}]}],nextCursor:null});
    else if(m.method==='thread/start')result({thread:{id:'limits-thread',sessionId:null,turns:[]},model:m.params.model,modelProvider:'openai',approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:{type:'readOnly',networkAccess:false},cwd:m.params.cwd});
    else if(m.method==='turn/start'){const turn={id:'limits-turn',status:'inProgress'};send({method:'turn/started',params:{threadId:'limits-thread',turn}});result({turn});}
    else if(m.method==='account/rateLimits/read'){if(mode==='reject')send({id:m.id,error:{code:-32601,message:'SYNTHETIC_PRIVATE_DIAGNOSTIC'}});else pending=m.id;}
  });
}
async function until(check:()=>boolean|Promise<boolean>){const deadline=performance.now()+5000;while(!await check()){if(performance.now()>deadline)assert.fail('Synthetic quota peer did not settle');await delay(5);}}
async function fixture(t:test.TestContext,mode='normal',requestTimeoutMs=5000){
  const dir=await mkdtemp(join(tmpdir(),'arcane-rate-limits-')),gate=join(dir,'gate.json'),audit=join(dir,'audit.jsonl');
  const session=new CodexSession({command:process.execPath,args:['-e',`(${peer.toString()})()`,gate,audit,mode],cwd:process.cwd(),env:nativeEnvironment()},limits({requestTimeoutMs}),'spawned-node-fixture');
  t.after(async()=>{await session.close();const child=relative(tmpdir(),dir);assert.ok(child.startsWith('arcane-rate-limits-')&&!child.includes(sep)&&!child.includes('..'));await rm(dir,{recursive:true,force:true});});
  await session.initialize(); let marker=0;
  const wire=async()=>{try{return(await readFile(audit,'utf8')).trim().split('\n').map(line=>JSON.parse(line) as {method:string;params:unknown});}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;}};
  const emit=async(row:{notifications?:unknown[];reply?:unknown})=>{marker++;await writeFile(gate,JSON.stringify({...row,marker}));await until(()=>session.snapshot().events.some(e=>e.type==='delta'&&e.text==='barrier:'+marker));};
  const start=async()=>{session.selectModel({...HUMAN,model:'fixture-model',effort:'ultra'});await session.startThread(HUMAN);await session.startTurn({...HUMAN,threadId:'limits-thread',text:'Synthetic quota fixture'});};
  const readPending=async()=>{const before=(await wire()).filter(m=>m.method==='account/rateLimits/read').length;const pending=session.readRateLimits(HUMAN);await until(async()=>(await wire()).filter(m=>m.method==='account/rateLimits/read').length===before+1);return {pending};};
  return{session,start,wire,emit,readPending};
}
test('quota SDK reads exact native metadata without creating a turn or enabling fallback', {timeout:15000},async t=>{
  const {session,start,wire,emit,readPending}=await fixture(t); assert.equal(session.snapshot().rateLimits,undefined);await start();
  const {pending}=await readPending();await emit({reply:response()});const report=await pending;
  assert.equal(report.buckets.length,2);report.buckets[0]!.primary!.usedPercent=999;
  assert.equal(session.snapshot().rateLimits!.buckets[0]!.primary!.usedPercent,25);
  const requests=await wire();assert.equal(requests.filter(m=>m.method==='turn/start').length,1);
  assert.deepEqual(requests.find(m=>m.method==='account/rateLimits/read')!.params,{supportsLunaReserve:false,excludeResetCreditDetails:true});
  assert.equal(requests.some(m=>/consume|Email|login|logout/.test(m.method)),false);
  assert.doesNotMatch(JSON.stringify(session.snapshot()),/SYNTHETIC_PRIVATE/);
});
test('quota SDK ignores malformed updates and keeps selected model, grants and lifecycle intact', {timeout:15000},async t=>{
  const {session,start,emit}=await fixture(t);await start();const before=session.snapshot();
  await emit({notifications:[{method:'rateLimits/updated',params:{rateLimits:bucket()}},update({primary:window(-1)})]});
  assert.equal(session.snapshot().rateLimits,undefined);await emit({notifications:[update(bucket())]});
  const after=session.snapshot();assert.equal(after.rateLimits!.buckets[0]!.primary!.usedPercent,25);
  assert.deepEqual(after.selection,before.selection);assert.deepEqual(after.thread,before.thread);assert.deepEqual(after.operations,before.operations);assert.equal(after.connected,true);
});
test('quota SDK rejects an older full read when a rolling update arrives during its request', {timeout:15000},async t=>{
  const {session,start,emit,readPending}=await fixture(t);await start();const {pending}=await readPending();const refused=assert.rejects(pending,code('RATE_LIMITS_CHANGED'));
  await emit({notifications:[update({...bucket(),primary:window(80)})],reply:response()});await refused;
  assert.equal(session.snapshot().rateLimits!.buckets[0]!.primary!.usedPercent,80);assert.equal(session.snapshot().connected,true);
});
test('quota SDK clears account observations and refuses a response across an account-change notification', {timeout:15000},async t=>{
  const {session,start,emit,readPending}=await fixture(t);await start();await emit({notifications:[update(bucket())]});
  const {pending}=await readPending();const refused=assert.rejects(pending,code('ACCOUNT_CHANGED'));
  await emit({notifications:[{method:'account/updated',params:{authMode:'chatgpt'}},update(bucket())],reply:response()});await refused;
  assert.equal(session.snapshot().rateLimits,undefined);assert.equal(session.snapshot().account,null);
});
test('quota SDK rejects malformed full responses without replacing the last observation or replaying work', {timeout:15000},async t=>{
  const {session,start,emit,readPending,wire}=await fixture(t);await start();await emit({notifications:[update(bucket())]});
  const before=session.snapshot().rateLimits;const {pending}=await readPending();const refused=assert.rejects(pending,code('RATE_LIMITS_UNAVAILABLE'));
  await emit({reply:{rateLimits:{primary:window(-1)}}});await refused;assert.deepEqual(session.snapshot().rateLimits,before);assert.equal(session.snapshot().connected,true);
  assert.equal((await wire()).filter(m=>m.method==='turn/start').length,1);
});
test('quota SDK reports unsupported read methods without disconnecting or exposing provider diagnostics', {timeout:15000},async t=>{
  const {session,wire}=await fixture(t,'reject');await assert.rejects(session.readRateLimits(HUMAN),code('REMOTE_REJECTED'));
  assert.equal(session.snapshot().connected,true);assert.equal(session.snapshot().rateLimits,undefined);
  assert.equal((await wire()).filter(m=>m.method==='account/rateLimits/read').length,1);
});
test('quota SDK rejects signed-out and non-human requests before dispatch', {timeout:15000},async t=>{
  const {session,wire}=await fixture(t,'signed-out');await assert.rejects(session.readRateLimits(HUMAN),code('SUBSCRIPTION_REQUIRED'));
  await assert.rejects(session.readRateLimits({initiatedBy:'agent'} as unknown as typeof HUMAN));
  assert.equal((await wire()).filter(m=>m.method==='account/rateLimits/read').length,0);
});
test('quota read timeout retains the active turn and ignores its late reply without replay', {timeout:15000},async t=>{
  const {session,start,emit,wire}=await fixture(t,'normal',1000);await start();const before=session.snapshot();
  await assert.rejects(session.readRateLimits(HUMAN),code('RATE_LIMITS_TIMEOUT'));
  await emit({reply:response()});const after=session.snapshot();
  assert.equal(after.connected,true);assert.equal(after.ready,true);assert.deepEqual(after.thread,before.thread);assert.deepEqual(after.operations,before.operations);
  assert.equal(after.rateLimits,undefined);assert.equal((await wire()).filter(m=>m.method==='account/rateLimits/read').length,1);
  const {pending}=await (async()=>{const pending=session.readRateLimits(HUMAN);await until(async()=>(await wire()).filter(m=>m.method==='account/rateLimits/read').length===2);return{pending};})();
  await emit({reply:response()});await pending;assert.equal(session.snapshot().rateLimits!.buckets.length,2);
});
