import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute,sep} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {CodexSession} from '../../packages/codex-client/src/session.js';
import {nativeEnvironment} from '../../packages/codex-client/src/transport.js';
import {limits} from '../../packages/codex-client/src/validation.js';
import {ARCANE_NATIVE_TOOL_NAMES} from '../../packages/protocol/src/arcane-tools.js';

// Actual session/JSONL transport with an owned Node peer, not a provider,
// native asset worker, Studio or customer acceptance fixture.
const PEER=String.raw`
const {createInterface}=require('node:readline'),{appendFileSync,existsSync}=require('node:fs');
const [encoded,audit]=process.argv.slice(1),s=JSON.parse(encoded);let turns=0,checks=0,models=0;
const send=v=>process.stdout.write(JSON.stringify(v)+'\n'),reply=(id,result)=>send({id,result});
const wait=(name,run)=>{const timer=setInterval(()=>{if(existsSync(s.gate+'-'+name)){clearInterval(timer);run();}},5);};
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line),{id,method,params={}}=m;appendFileSync(audit,JSON.stringify(m)+'\n');
 if(!method||method==='initialized')return;
 if(method==='initialize')return reply(id,{});
 if(method==='account/read')return reply(id,{account:{type:'chatgpt',email:'retirement@example.invalid',planType:'plus'},requiresOpenaiAuth:true});
 if(method==='model/list'){models++;const value={data:[{id:'fixture',model:'fixture',displayName:'Fixture',supportedReasoningEfforts:[{reasoningEffort:'low'}]}],nextCursor:null};
  if(s.holdModels&&models>1)return wait('models',()=>reply(id,value));return reply(id,value);}
 if(method==='thread/start')return reply(id,{thread:{id:'retirement.thread',sessionId:'retirement.session',turns:[],status:{type:'idle'}},model:params.model,modelProvider:'openai',cwd:process.cwd(),approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:{type:'readOnly',networkAccess:false}});
 if(method==='mcpServerStatus/list'){checks++;const value={data:[{name:'arcane',runtimeStatus:'connected',toolsError:null,pluginId:null,tools:Object.fromEntries(s.tools.map(n=>[n,{}]))}],nextCursor:null};
  if(s.holdCheck===checks)return wait('preflight',()=>reply(id,value));return reply(id,value);}
 if(method==='turn/start'){turns++;const mode=s.turns[turns-1]??'complete',turn={id:'retirement.turn:'+turns,status:mode==='complete'?'completed':mode==='failed'?'failed':'inProgress'};
  if(mode==='reject')return send({id,error:{code:-32000,message:'controlled rejection'}});
  if(mode==='unknown')return reply(id,{});
  if(mode==='terminal-before-ack'){send({method:'turn/completed',params:{threadId:'retirement.thread',turn:{...turn,status:'completed'}}});return wait('ack',()=>reply(id,{turn}));}
  reply(id,{turn});if(mode==='held')wait('turn'+turns,()=>send({method:'turn/completed',params:{threadId:'retirement.thread',turn:{...turn,status:'completed'}}}));return;}
 if(method==='turn/steer'){if(s.holdSteer)return wait('steer',()=>reply(id,{turnId:params.expectedTurnId}));return reply(id,{turnId:params.expectedTurnId});}
 if(method==='turn/interrupt')return reply(id,{});
});`;
type Wire={method?:string;params?:Record<string,unknown>};
async function fixture(t:test.TestContext,options:{turns?:string[];holdCheck?:number;holdModels?:boolean;holdSteer?:boolean;deferStart?:boolean;manualWrites?:boolean}={}){
  const boundary=await realpath(tmpdir()),root=await realpath(await mkdtemp(join(boundary,'arcane-retire-session-'))),audit=join(root,'wire.jsonl'),gate=join(root,'gate');
  let retired=0;
  const client=new CodexSession({command:process.execPath,args:['-e',PEER,JSON.stringify({gate,tools:ARCANE_NATIVE_TOOL_NAMES,...options}),audit],cwd:root,env:nativeEnvironment()},
    limits({requestTimeoutMs:2500}),'spawned-node-fixture','arcane-only',Object.freeze({finalCredential:()=> 'c'.repeat(64),dispatched(){},ended(){},retired(){retired++;}}));
  t.after(async()=>{try{await client.close();}finally{const part=relative(boundary,root);assert.ok(part.startsWith('arcane-retire-session-')&&!isAbsolute(part)&&!part.includes(sep));await rm(root,{recursive:true,force:true});}});
  await client.initialize();client.selectModel({initiatedBy:'human',model:'fixture',effort:'low'});await client.startThread({initiatedBy:'human'});
  if(options.manualWrites)client.grantThreadWrites({initiatedBy:'human',threadId:'retirement.thread'});
  const wire=async():Promise<Wire[]>=>{const text=await readFile(audit,'utf8'),end=text.lastIndexOf('\n');return end<0?[]:text.slice(0,end).split('\n').map(line=>JSON.parse(line)as Wire);};
  const entered=async(method:string,count:number)=>{const deadline=Date.now()+6000;while((await wire()).filter(row=>row.method===method).length<count){assert.ok(Date.now()<deadline,'Actual peer did not receive expected request.');await delay(5);}};
  const start=()=>client.startManagedTask({initiatedBy:'human',threadId:'retirement.thread',text:'Original task'});
  const started=options.deferStart?null:await start();
  return{client,started,start,wire,entered,retired:()=>retired,release:(name:string)=>writeFile(gate+'-'+name,'release',{flag:'wx'})};
}
const scope=(error:unknown)=>!!error&&typeof error==='object'&&'code'in error&&error.code==='TASK_SCOPE';

test('normal session join covers initial, incorporation and repair while preserving manual grants and usable account', {timeout:10000},async t=>{
  const f=await fixture(t,{turns:['complete','complete','complete'],manualWrites:true}),token=f.started!.continuation;
  const chain=f.client.openIncorporationChain({continuation:token,maxSteps:1});
  await f.client.continueIncorporation({chain,permit:f.client.issueIncorporationPermit({chain}),text:'Incorporate'});
  await f.client.continueTask({continuation:token,text:'One repair'});
  const first=f.client.retireManagedTask(token);assert.equal(f.client.retireManagedTask(token),first);await first;
  assert.equal(f.retired(),0);assert.equal(f.client.snapshot().connected,true);assert.equal(f.client.snapshot().ready,true);
  assert.equal(f.client.snapshot().account?.auth,'subscription');assert.equal(f.client.snapshot().thread!.writeGranted,true);
  assert.equal((await f.client.listModels()).length,1);
  await assert.rejects(f.client.continueTask({continuation:token,text:'No reuse'}),scope);
  assert.throws(()=>f.client.issueIncorporationPermit({chain}),scope);
  assert.equal((await f.wire()).filter(row=>row.method==='turn/start').length,3);
  assert.equal((await f.wire()).some(row=>row.method==='turn/interrupt'),false);
});

test('exact terminal joins without waiting for an unrelated held model-catalogue request',{timeout:10000},async t=>{
  const f=await fixture(t,{turns:['held'],holdModels:true});let catalogued=false,settled=false;
  const catalogue=f.client.listModels().then(value=>{catalogued=true;return value;});await f.entered('model/list',2);
  const join=f.client.retireManagedTask(f.started!.continuation).then(()=>{settled=true;});
  assert.equal(settled,false);assert.equal(catalogued,false);
  await f.release('turn1');await join;assert.equal(catalogued,false,'Unrelated original read stays live and outside task join.');
  assert.equal(f.client.snapshot().ready,true);assert.equal(f.retired(),0);
  await f.release('models');assert.equal((await catalogue).length,1);
});

test('a terminal notification before the original ACK cannot manufacture an issued continuation',{timeout:10000},async t=>{
  const f=await fixture(t,{turns:['terminal-before-ack'],deferStart:true}),starting=f.start();await f.entered('turn/start',1);
  const deadline=Date.now()+6000;while(f.client.snapshot().thread!.turnStatus!=='completed'){assert.ok(Date.now()<deadline);await delay(5);}
  assert.equal(f.client.snapshot().operations.at(-1)!.state,'pending');
  assert.throws(()=>f.client.retireManagedTask({kind:'native-task-continuation'}),scope);
  await f.release('ack');const started=await starting;await f.client.retireManagedTask(started.continuation);
  assert.equal(f.retired(),0);
});

test('normal retirement joins an already admitted original steer ACK and its exact parent terminal',{timeout:10000},async t=>{
  const f=await fixture(t,{turns:['held'],holdSteer:true});const turn=f.client.snapshot().thread!.turnId!;
  const steer=f.client.steerTurn({initiatedBy:'human',threadId:'retirement.thread',expectedTurnId:turn,text:'Amend this exact turn',clientUserMessageId:randomUUID()});
  await f.entered('turn/steer',1);let settled=false;
  const normal=f.client.retireManagedTask(f.started!.continuation).then(()=>{settled=true;});
  assert.equal(settled,false);await f.release('steer');assert.equal((await steer).turnId,turn);assert.equal(settled,false);
  await f.release('turn1');await normal;assert.equal(f.retired(),0);
  const wire=await f.wire();assert.equal(wire.filter(row=>row.method==='turn/steer').length,1);assert.equal(wire.filter(row=>row.method==='turn/start').length,1);
});

test('normal fencing observes original preflight refusal and retains that exact error without another turn',{timeout:10000},async t=>{
  const f=await fixture(t,{holdCheck:3}),chain=f.client.openIncorporationChain({continuation:f.started!.continuation,maxSteps:1});
  const pending=f.client.continueIncorporation({chain,permit:f.client.issueIncorporationPermit({chain}),text:'Held preflight'}).then(()=>null,error=>error as unknown);
  await f.entered('mcpServerStatus/list',3);const joined=f.client.retireManagedTask(f.started!.continuation);void joined.catch(()=>{});
  await f.release('preflight');const original=await pending;assert.ok(original&&typeof original==='object');
  await assert.rejects(joined,error=>error===original);assert.equal(f.client.retireManagedTask(f.started!.continuation),joined);
  assert.equal((await f.wire()).filter(row=>row.method==='turn/start').length,1);assert.equal(f.retired(),0);
});

test('foreign, copied and proxy continuation objects cannot fence an original live task',{timeout:10000},async t=>{
  const f=await fixture(t),other=await fixture(t);let traps=0;
  const token=f.started!.continuation,proxy=new Proxy(token,{get(){traps++;throw Error('must not run');}});
  for(const bad of [other.started!.continuation,structuredClone(token),proxy])assert.throws(()=>f.client.retireManagedTask(bad),scope);
  assert.equal(traps,0);assert.equal(f.client.snapshot().ready,true);
  const chain=f.client.openIncorporationChain({continuation:token,maxSteps:1});
  await f.client.continueIncorporation({chain,permit:f.client.issueIncorporationPermit({chain}),text:'Still genuine'});
  await f.client.retireManagedTask(token);assert.equal(other.client.snapshot().ready,true);
});

for(const outcome of ['failed','reject','unknown']as const)test('unsuccessful original '+outcome+' cannot become normal proof',{timeout:10000},async t=>{
  const f=await fixture(t,{turns:['complete',outcome]}),token=f.started!.continuation,chain=f.client.openIncorporationChain({continuation:token,maxSteps:1});
  const request=f.client.continueIncorporation({chain,permit:f.client.issueIncorporationPermit({chain}),text:'Controlled outcome'});
  if(outcome==='failed'){await request;await assert.rejects(f.client.retireManagedTask(token),scope);}
  else if(outcome==='reject'){let original:unknown;await assert.rejects(request,error=>{original=error;return true;});await assert.rejects(f.client.retireManagedTask(token),error=>error===original);}
  else{await assert.rejects(request);assert.throws(()=>f.client.retireManagedTask(token),scope);}
  assert.equal((await f.wire()).filter(row=>row.method==='turn/start').length,2);
});
