import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {CodexChatApi,CodexHttpError,codexRateLimitDisplay,readCodexState,type ChatState} from '../../apps/desktop/src/codex-chat.js';
import {parseNativeRateLimits} from '../../packages/codex-client/src/rate-limits.js';

const TOKEN='c'.repeat(64),ID=randomUUID();
function state():ChatState {
  const rateLimits=parseNativeRateLimits({ordinaryUsageAllowed:false,rateLimits:{limitId:'codex',limitName:'Codex',normalModelSlug:'fixture-model',
    primary:{usedPercent:100,windowDurationMins:300,resetsAt:1},secondary:{usedPercent:0,windowDurationMins:null,resetsAt:null},
    credits:{hasCredits:false,unlimited:false},spendControlReached:true,rateLimitReachedType:'workspace_member_usage_limit_reached'}},1792102400000)!;
  return{provider:'codex',use:'personal-local',projectPath:process.cwd(),connecting:false,closing:false,busy:false,actions:[],lastSnapshot:null,nativeTools:{configured:true,verified:false},snapshot:{connectionId:ID,provenance:'spawned-node-fixture',connected:true,ready:true,account:{auth:'subscription',plan:null,requiresOpenaiAuth:true},models:[],selection:null,thread:null,operations:[],approvals:[],events:[],droppedEvents:0,lastEventSeq:0,failureCode:null,rateLimits}};
}
test('quota view renders actual windows, unknown metadata and provider reasons without inferring reset recovery',()=>{
  const s=state();assert.deepEqual(readCodexState(s),s);const view=codexRateLimitDisplay(s.snapshot);
  assert.match(view.status,/Provider reports included usage is blocked/);assert.match(view.rows[0]!,/100% used/);assert.match(view.rows[0]!,/5 hours/);
  assert.match(view.rows[0]!,/0% used.*Reset time not reported/);assert.match(view.rows[0]!,/Member usage limit reached/);assert.match(view.rows[0]!,/Account spending limit reached/);
  assert.doesNotMatch(view.status,/available|renewed|retrying/);s.snapshot!.connected=false;s.snapshot!.ready=false;
  assert.match(codexRateLimitDisplay(s.snapshot).status,/Disconnected.*last reported/);
  assert.match(codexRateLimitDisplay(null).status,/when the provider reports/);
  delete s.snapshot!.rateLimits;assert.equal(codexRateLimitDisplay(s.snapshot).rows.length,0);
});
test('quota public-state validation rejects additional authority, private fields and malformed telemetry',()=>{
  const mutations:Array<(v:Record<string,any>)=>void>=[
    v=>v.accountId='private',v=>v.source='inferred',v=>v.observedAt=-1,v=>v.ordinaryUsageAllowed='true',
    v=>{v.source='account/rateLimits/updated';v.ordinaryUsageAllowed=true;},v=>v.buckets=[],
    v=>v.buckets.push({...v.buckets[0]}),v=>v.buckets[0].credits.balance='private',v=>v.buckets[0].limitName='\u202equota',
    v=>v.buckets[0].primary.usedPercent=NaN,v=>v.buckets[0].primary.windowDurationMins=0,v=>v.buckets[0].primary.resetsAt=0.5,
    v=>v.buckets[0].spendControlReached='false',v=>v.buckets[0].rateLimitReachedType='invented',
  ];
  for(const mutate of mutations){const s=state();mutate(s.snapshot!.rateLimits!);assert.throws(()=>readCodexState(s));}
  const s=state();let invoked=false;Object.defineProperty(s.snapshot!.rateLimits!.buckets[0]!,'limitName',{get(){invoked=true;throw Error('Unsafe');}});
  assert.throws(()=>readCodexState(s));assert.equal(invoked,false);
});
test('quota HTTP refresh is a bounded, private read with an exact connection envelope',async()=>{
  const requests:Array<{path:string;init:RequestInit|undefined}>=[];
  const api=new CodexChatApi(TOKEN,(async(path,init)=>{requests.push({path:String(path),init});return new Response(JSON.stringify({state:state()}),{status:200,headers:{'Content-Type':'application/json'}});}) as typeof fetch);
  await api.refreshUsage(ID);assert.equal(requests.length,1);const {path,init}=requests[0]!;
  assert.equal(path,'/v1/codex/usage');assert.equal(init!.method,'POST');assert.deepEqual(JSON.parse(init!.body as string),{connectionId:ID});
  assert.equal((init!.headers as Record<string,string>).Authorization,'Bearer '+TOKEN);assert.equal(init!.credentials,'omit');assert.equal(init!.redirect,'error');assert.equal(init!.cache,'no-store');
  await assert.rejects(api.refreshUsage('foreign'));assert.equal(requests.length,1);
});
test('quota HTTP failures do not create uncertain action receipts or retry observations',async()=>{
  for(const failure of ['network','503','wrong-connection','private-field'] as const){let requests=0;
    const api=new CodexChatApi(TOKEN,(async()=>{requests++;if(failure==='network')throw Error('Synthetic transport loss');
      if(failure==='503')return new Response(JSON.stringify({error:'RATE_LIMITS_UNAVAILABLE'}),{status:503});
      const s=state();if(failure==='wrong-connection')s.snapshot!.connectionId=randomUUID();else(s.snapshot!.rateLimits as unknown as Record<string,unknown>).accountId='private';
      return new Response(JSON.stringify({state:s}),{status:200});}) as typeof fetch);
    await assert.rejects(api.refreshUsage(ID),(error:unknown)=>error instanceof Error&&(!(error instanceof CodexHttpError)||error.unknown===false));assert.equal(requests,1);
  }
});
