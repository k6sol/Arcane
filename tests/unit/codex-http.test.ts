import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtemp,mkdir,rm,readFile,writeFile } from 'node:fs/promises';
import { join,resolve,relative,sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createConnectionLab } from '../../apps/daemon/src/lab-server.js';
import { createCodexService, type CodexAction, type CodexActionOutcome, type CodexProductState } from '../../apps/daemon/src/codex-service.js';
import { CodexSession } from '../../packages/codex-client/src/session.js';
import { limits } from '../../packages/codex-client/src/validation.js';
import { nativeEnvironment } from '../../packages/codex-client/src/transport.js';
const ROOT=resolve(process.cwd()),TEMP=join(ROOT,'tests','.tmp','codex-http');
async function fixture(t:test.TestContext,mode='normal') {
  await mkdir(TEMP,{recursive:true});const directory=await mkdtemp(join(TEMP,'native-'));let starts=0;
  const connect=async()=>{starts++;const client=new CodexSession({command:process.execPath,args:[join(ROOT,'packages/codex-client/fixtures/protocol.mjs'),mode,join(directory,'receipt-'+starts+'.jsonl')],cwd:ROOT,env:nativeEnvironment()},limits({requestTimeoutMs:3000,approvalTimeoutMs:15000}),'spawned-node-fixture');await client.initialize();return client;};
  const service=createCodexService({directory,projectPath:ROOT,connect});
  const lab=await createConnectionLab({cwd:ROOT,stateDirectory:join(directory,'lab'),codexService:service});
  t.after(async()=>{await lab.close();const path=relative(TEMP,directory);assert.ok(path.startsWith('native-')&&!path.includes(sep));await rm(directory,{recursive:true,force:true});});
  const call=async(route:string,body?:unknown,bearer=lab.token,origin=lab.origin)=>{
    const response=await fetch(lab.origin+route,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+bearer,...(origin?{Origin:origin}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});
    return {status:response.status,text:await response.text()};
  };
  const state=async():Promise<CodexProductState>=>JSON.parse((await call('/v1/codex/state')).text).state;
  const action=async(value:Record<string,unknown>):Promise<CodexActionOutcome>=>JSON.parse((await call('/v1/codex/action',{requestId:randomUUID(),...value})).text);
  return {lab,service,call,state,action,directory,starts:()=>starts};
}
async function connected(t:test.TestContext,mode='normal'){
  const f=await fixture(t,mode),opening=await f.action({action:'connect',connectionId:null});
  assert.equal(opening.record.state,'acknowledged');const id=opening.state.snapshot!.connectionId;
  return {...f,id};
}
async function thread(t:test.TestContext,mode='normal'){
  const f=await connected(t,mode);assert.equal((await f.action({action:'select',connectionId:f.id,model:'fixture-sol',effort:'ultra'})).record.state,'acknowledged');
  const opened=await f.action({action:'thread-start',connectionId:f.id});assert.equal(opened.record.state,'acknowledged');return {...f,threadId:opened.state.snapshot!.thread!.threadId};
}

test('saved history reads SQLite for one exact thread without connecting, resuming or journaling',async t=>{
  const f=await thread(t,'image-history-resume');
  await writeFile(join(f.directory,'image-history.json'),'[]');
  assert.equal((await f.action({action:'history-load',connectionId:f.id,threadId:f.threadId})).record.state,'acknowledged');
  assert.equal((await f.action({action:'disconnect',connectionId:f.id})).record.state,'acknowledged');
  const before=await f.state(),starts=f.starts();
  const url='/v1/codex/history?threadId='+encodeURIComponent(f.threadId),result=await f.call(url);
  assert.equal(result.status,200);const recorded=JSON.parse(result.text).nativeHistory;
  assert.equal(recorded.projectPath,ROOT);assert.equal(recorded.threadId,f.threadId);assert.ok(recorded.recorded);
  assert.deepEqual((await f.state()).actions,before.actions);assert.equal((await f.state()).snapshot,null);assert.equal(f.starts(),starts);
  assert.equal((await f.call('/v1/codex/history?threadId=not-owned')).status,200);
  assert.equal(JSON.parse((await f.call('/v1/codex/history?threadId=not-owned')).text).nativeHistory,null);
  assert.equal((await f.call(url,undefined,f.lab.agentToken)).status,403);
  assert.equal((await f.call(url,undefined,f.lab.token,'https://foreign.invalid')).status,403);
  for(const query of ['?threadId=','?threadId=../other','?threadId=a&threadId=b','?threadId=a&projectPath=other','?threadId='+('a'.repeat(257))])
    assert.equal((await f.call('/v1/codex/history'+query)).status,400);
  assert.equal(f.starts(),starts);
});

test('human account-usage refresh uses the actual SDK without starting or journaling a model turn',async t=>{
  const f=await connected(t),before=f.service.state();
  const result=await f.call('/v1/codex/usage',{connectionId:f.id});assert.equal(result.status,200);
  const after=JSON.parse(result.text).state as CodexProductState;
  assert.equal(after.snapshot!.rateLimits!.buckets[0]!.primary!.usedPercent,25);assert.equal(after.snapshot!.rateLimits!.ordinaryUsageAllowed,true);
  assert.deepEqual(after.actions,before.actions);assert.equal(after.snapshot!.thread,null);assert.deepEqual(after.snapshot!.selection,before.snapshot!.selection);
  assert.doesNotMatch(result.text,/FIXTURE_SECRET|balance|accountId|rateLimitResetCredits/);
  const audit=(await readFile(join(f.directory,'receipt-1.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(audit.filter(row=>row.message?.method==='account/rateLimits/read').length,1);assert.equal(audit.some(row=>row.message?.method==='turn/start'),false);
});
test('account-usage route denies agents, foreign origins, stale connections and expanded request bodies before native reads',async t=>{
  const f=await connected(t);
  for(const [token,origin,status] of [[f.lab.agentToken,f.lab.origin,403],['bad',f.lab.origin,401],[f.lab.token,'https://foreign.invalid',403],[f.lab.token,'',403]] as const)
    assert.equal((await f.call('/v1/codex/usage',{connectionId:f.id},token,origin)).status,status);
  for(const value of [{connectionId:randomUUID()},{connectionId:f.id,initiatedBy:'human'},{connectionId:f.id,action:'turn-start'},null,{connectionId:f.id,padding:'x'.repeat(1100)}])
    assert.ok([400,413].includes((await f.call('/v1/codex/usage',value)).status));
  assert.equal((await f.call('/v1/codex/usage')).status,405);assert.equal((await f.call('/v1/codex/usage?account=foreign',{connectionId:f.id})).status,400);
  const audit=(await readFile(join(f.directory,'receipt-1.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(audit.some(row=>row.message?.method==='account/rateLimits/read'),false);assert.equal(f.starts(),1);
});
test('disconnect fences a pending account-usage read without attaching it to a replacement connection',async t=>{
  const f=await connected(t,'quota-held'),pending=f.call('/v1/codex/usage',{connectionId:f.id});
  const deadline=Date.now()+3000;for(;;){if((await readFile(join(f.directory,'receipt-1.jsonl'),'utf8')).includes('account/rateLimits/read'))break;if(Date.now()>deadline)assert.fail('Usage read was not dispatched');await delay(5);}
  await f.action({action:'disconnect',connectionId:f.id});const result=await pending;assert.equal(result.status,400);
  await f.action({action:'connect',connectionId:null});const current=f.service.state();assert.notEqual(current.snapshot!.connectionId,f.id);assert.equal(current.snapshot!.rateLimits,undefined);
  assert.equal(current.actions.some(row=>String(row.action).includes('usage')),false);
});

test('human native controller is inert on mount and denies agent grants, omitted/mismatched Origin and host before native work',async t=>{
  const f=await fixture(t);assert.equal((await f.state()).snapshot,null);assert.equal(f.starts(),0);
  for(const [token,origin,status] of [[f.lab.agentToken,f.lab.origin,403],['bad',f.lab.origin,401],[f.lab.token,'https://evil.invalid',403],[f.lab.token,'',403]] as const){
    assert.equal((await f.call('/v1/codex/action',{requestId:randomUUID(),action:'connect',connectionId:null},token,origin)).status,status);
  }
  assert.equal((await f.call('/v1/codex/state',undefined,f.lab.agentToken)).status,403);
  assert.equal((await f.call('/v1/codex/state?unsafe=true')).status,400);
  // Undici fetch can replace Host: use a real HTTP wire request for this boundary.
  const bad=await new Promise<{status:number,text:string}>( (resolve,reject)=>{
    const request=httpRequest(f.lab.origin+'/v1/codex/state',{headers:{Host:'evil.invalid',Authorization:'Bearer '+f.lab.token}},response=>{let body='';response.setEncoding('utf8');response.on('data',chunk=>body+=chunk);response.on('end',()=>resolve({status:response.statusCode!,text:body}));});
    request.setTimeout(10000,()=>request.destroy(new Error('Host test timed out')));request.on('error',reject);request.end();
  });assert.equal(bad.status,403);assert.equal(JSON.parse(bad.text).error,'HOST');
  assert.equal(f.starts(),0);assert.deepEqual((await f.state()).actions,[]);
});

test('real Node protocol + HTTP + SQLite carries exact selection, read-only thread/turn and idempotent requests',async t=>{
  const f=await thread(t,'complete-before-ack');
  const input={requestId:randomUUID(),action:'turn-start',connectionId:f.id,threadId:f.threadId,text:'Synthetic test only'};
  const first=JSON.parse((await f.call('/v1/codex/action',input)).text) as CodexActionOutcome;
  assert.equal(first.record.state,'acknowledged');assert.equal(first.state.snapshot!.thread!.turnStatus,'completed');assert.equal(first.record.effort,'ultra');
  const replay=JSON.parse((await f.call('/v1/codex/action',input)).text) as CodexActionOutcome;assert.equal(replay.replayed,true);assert.deepEqual(replay.record,first.record);
  assert.equal((await f.call('/v1/codex/action',{...input,text:'Different intent'})).status,409);
  const log=await readFile(join(f.directory,'receipt-1.jsonl'),'utf8');const rows=log.trim().split('\n').map(line=>JSON.parse(line));
  const turns=rows.filter(row=>row.message?.method==='turn/start');assert.equal(turns.length,1);assert.equal(turns[0].message.params.model,'fixture-sol');assert.equal(turns[0].message.params.effort,'ultra');assert.equal(turns[0].message.params.sandboxPolicy.type,'readOnly');
  // Lifecycle receipts contain metadata; submitted prompts have their own conversation-scoped transcript.
  const journal=new DatabaseSync(join(f.directory,'codex-actions.sqlite'),{readOnly:true});
  try {
    const actions=journal.prepare('SELECT payload FROM actions').all() as {payload:string}[];
    assert.ok(actions.every(row=>!row.payload.includes(input.text)));
    const submitted=journal.prepare('SELECT thread_id,session_id,payload FROM submitted_chat_messages WHERE request_id=?').get(input.requestId) as {thread_id:string;session_id:string|null;payload:string};
    assert.equal(submitted.thread_id,f.threadId);
    assert.equal(submitted.session_id,first.state.snapshot!.thread!.sessionId);
    assert.equal(JSON.parse(submitted.payload).text,input.text);
  } finally {journal.close();}
  assert.equal(first.state.snapshot!.provenance,'spawned-node-fixture');
});

test('request scope and unknown fields cannot grant native access or choose arbitrary code/config',async t=>{
  const f=await connected(t);
  for(const extra of [{initiatedBy:'human'},{command:'C:/unsafe.exe'},{env:{TOKEN:'secret'}},{use:'commercial-hosted'},{config:'full-access'}]){
    assert.equal((await f.call('/v1/codex/action',{requestId:randomUUID(),connectionId:f.id,action:'thread-start',...extra})).status,400);
  }
  assert.equal((await f.action({action:'select',connectionId:randomUUID(),model:'fixture-sol',effort:'ultra'})).record.errorCode,'STALE_CONNECTION');
  assert.equal((await f.action({action:'select',connectionId:f.id,model:'fallback-model',effort:'ultra'})).record.state,'rejected');
  assert.equal((await f.state()).snapshot!.thread,null);
});

test('human approvals require exact native scope and explicit thread write grant, never agent authorization',async t=>{
  const f=await thread(t,'approvals');
  const start=await f.action({action:'turn-start',connectionId:f.id,threadId:f.threadId,text:'Synthetic approvals'});assert.equal(start.record.state,'acknowledged');
  for(let n=0;n<100&&!((await f.state()).snapshot!.approvals.length);n++)await delay(5);
  let approval=(await f.state()).snapshot!.approvals[0]!;assert.ok(approval);assert.equal(approval.canAccept,false);
  const answer={action:'approval',connectionId:f.id,threadId:approval.threadId,turnId:approval.turnId,handle:approval.handle,decision:'accept'};
  assert.equal((await f.call('/v1/codex/action',{requestId:randomUUID(),...answer},f.lab.agentToken)).status,403);
  assert.equal((await f.action(answer)).record.errorCode,'WRITE_GRANT_REQUIRED');
  assert.equal((await f.action({...answer,turnId:'foreign-turn'})).record.errorCode,'STALE_APPROVAL');
  assert.equal((await f.action({action:'grant-writes',connectionId:f.id,threadId:f.threadId})).record.state,'acknowledged');
  approval=(await f.state()).snapshot!.approvals[0]!;assert.equal(approval.canAccept,true);
  assert.equal((await f.action(answer)).record.state,'acknowledged');assert.equal((await f.action(answer)).record.errorCode,'STALE_APPROVAL');
  assert.equal((await f.action({action:'revoke-writes',connectionId:f.id,threadId:f.threadId})).record.state,'acknowledged');assert.equal((await f.state()).snapshot!.connected,false);
});

test('lost native turn acknowledgement returns a durable unknown record without automatic replay',async t=>{
  const f=await thread(t,'lost-turn-ack');const input={requestId:randomUUID(),action:'turn-start',connectionId:f.id,threadId:f.threadId,text:'Synthetic lost ack'};
  const result=await f.call('/v1/codex/action',input);assert.equal(result.status,202);const outcome=JSON.parse(result.text) as CodexActionOutcome;
  assert.equal(outcome.record.state,'unknown');assert.equal(outcome.record.turnId,'fixture-turn-1');assert.equal(outcome.record.errorCode,'TIMEOUT');
  assert.equal((JSON.parse((await f.call('/v1/codex/action',input)).text) as CodexActionOutcome).replayed,true);
  const logs=(await readFile(join(f.directory,'receipt-1.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.equal(logs.filter(row=>row.message?.method==='turn/start').length,1);
});

test('disconnect fences scope and delayed acknowledgements; reconnect never revives old grants',async t=>{
  const f=await thread(t);const disconnect=await f.action({action:'disconnect',connectionId:f.id});assert.equal(disconnect.record.state,'acknowledged');assert.equal(disconnect.state.snapshot,null);
  assert.equal(disconnect.state.lastSnapshot!.connected,false);const next=await f.action({action:'connect',connectionId:null});const id=next.state.snapshot!.connectionId;assert.notEqual(id,f.id);
  assert.equal((await f.action({action:'grant-writes',connectionId:f.id,threadId:f.threadId})).record.errorCode,'STALE_CONNECTION');assert.equal(next.state.snapshot!.thread,null);
});


test('native shutdown fences a dispatched pending turn and retains unknown scope before SQLite closes',async t=>{
  const f=await thread(t,'lost-turn-ack');const input={requestId:randomUUID(),action:'turn-start' as const,connectionId:f.id,threadId:f.threadId,text:'Synthetic shutdown only'};
  const pending=f.service.action(input);const rejection=assert.rejects(pending,/closed/i);
  for(let n=0;n<100&&!f.service.state().snapshot!.thread!.turnId;n++)await delay(5);
  assert.equal(f.service.state().busy,true);assert.equal(f.service.state().snapshot!.thread!.turnId,'fixture-turn-1');
  await f.service.close();await rejection;
  let starts=0;const restored=createCodexService({directory:f.directory,projectPath:ROOT,connect:async()=>{starts++;throw new Error('Must remain inert after restart');}});
  try{const state=restored.state();assert.equal(state.snapshot,null);const receipt=state.actions.find(row=>row.requestId===input.requestId)!;assert.equal(receipt.state,'unknown');assert.equal(receipt.turnId,'fixture-turn-1');
    const replay=await restored.action(input);assert.equal(replay.replayed,true);assert.equal(replay.record.state,'unknown');assert.equal(starts,0);
  }finally{await restored.close();}
});

test('durable lost-ack receipt survives restart and never relaunches or resubmits the original text',async t=>{
  const f=await thread(t,'lost-turn-ack'),input={requestId:randomUUID(),action:'turn-start' as const,connectionId:f.id,threadId:f.threadId,text:'Synthetic restart only'};
  const first=await f.service.action(input);assert.equal(first.record.state,'unknown');await f.service.close();let starts=0;
  const restored=createCodexService({directory:f.directory,projectPath:ROOT,connect:async()=>{starts++;throw new Error('No automatic connection');}});
  try{const replay=await restored.action(input);assert.equal(replay.replayed,true);assert.deepEqual(replay.record,first.record);assert.equal(replay.state.snapshot,null);assert.equal(starts,0);
    await assert.rejects(restored.action({...input,text:'Changed intent'}),/different action/);
  }finally{await restored.close();}
});

test('crash-pending action is explicitly classified unknown by migration without factory work',async t=>{
  const f=await fixture(t),input={requestId:randomUUID(),connectionId:null,action:'connect' as const};await f.service.close();
  // Simulate a crash-only durable pending row; no native work is performed by this fixture.
  const db=new DatabaseSync(join(f.directory,'codex-actions.sqlite'));
  const row={...input,state:'pending',errorCode:null,threadId:null,turnId:null,model:null,effort:null,createdAt:new Date().toISOString(),finishedAt:null};
  db.prepare('INSERT INTO actions(id,hash,payload) VALUES(?,?,?)').run(input.requestId,createHash('sha256').update(JSON.stringify(input)).digest('hex'),JSON.stringify(row));db.close();
  let starts=0;const restored=createCodexService({directory:f.directory,projectPath:ROOT,connect:async()=>{starts++;throw new Error('No crash replay');}});
  try{const result=await restored.action(input);assert.equal(result.replayed,true);assert.equal(result.record.state,'unknown');assert.equal(result.record.errorCode,'DAEMON_RESTART');assert.equal(starts,0);}finally{await restored.close();}
});

test('malformed, encoded and excessive HTTP input is rejected without spawning or echoing payloads',async t=>{
  const f=await fixture(t);
  for(const [body,extra,status] of [['{bad secret-payload',{},400],['{}',{'Content-Type':'text/plain'},415],['{}',{'Content-Encoding':'gzip'},415],['x'.repeat(170000),{},413]] as const){
    const response=await fetch(f.lab.origin+'/v1/codex/action',{method:'POST',headers:{Authorization:'Bearer '+f.lab.token,Origin:f.lab.origin,'Content-Type':'application/json',...extra},body,signal:AbortSignal.timeout(10000)});assert.equal(response.status,status);assert.equal((await response.text()).includes('secret-payload'),false);
  }
  assert.equal(f.starts(),0);assert.deepEqual((await f.state()).actions,[]);
});


test('pre-dispatch refusals never borrow an unrelated unknown operation or overwrite requested scope',async t=>{
  const f=await thread(t,'lost-turn-ack');const old=await f.service.action({requestId:randomUUID(),action:'turn-start',connectionId:f.id,threadId:f.threadId,text:'Synthetic attribution only'});assert.equal(old.record.state,'unknown');
  const foreign=await f.action({action:'grant-writes',connectionId:randomUUID(),threadId:'requested-foreign-thread'});
  assert.equal(foreign.record.state,'rejected');assert.equal(foreign.record.errorCode,'STALE_CONNECTION');assert.equal(foreign.record.threadId,'requested-foreign-thread');assert.equal(foreign.record.turnId,null);
});

test('journal saturation fences active write grants for disconnect, interrupt and revoke without model replay',async t=>{
  for(const safety of ['disconnect','turn-interrupt','revoke-writes'] as const){
    const f=await thread(t,'lost-turn-ack');await f.service.action({requestId:randomUUID(),action:'grant-writes',connectionId:f.id,threadId:f.threadId});
    const input={requestId:randomUUID(),action:'turn-start' as const,connectionId:f.id,threadId:f.threadId,text:'Synthetic saturation only'};const pending=f.service.action(input);
    for(let n=0;n<100&&!f.service.state().snapshot!.thread!.turnId;n++)await delay(5);assert.equal(f.service.state().snapshot!.thread!.writeGranted,true);
    // Only this explicitly named temporary fixture DB is seeded; no production journal.
    const db=new DatabaseSync(join(f.directory,'codex-actions.sqlite'));const count=Number((db.prepare('SELECT count(*) AS n FROM actions').get() as {n:number}).n),write=db.prepare('INSERT INTO actions(id,hash,payload) VALUES(?,?,?)');
    db.exec('BEGIN');for(let n=count;n<4096;n++){const id=randomUUID();write.run(id,'fixture-seed',JSON.stringify({requestId:id,action:'select',connectionId:f.id,state:'rejected',errorCode:'FIXTURE_SEED',threadId:f.threadId,turnId:null,model:null,effort:null,createdAt:new Date().toISOString(),finishedAt:new Date().toISOString()}));}db.exec('COMMIT');db.close();
    const args=safety==='disconnect'?{}:safety==='revoke-writes'?{threadId:f.threadId}:{threadId:f.threadId,turnId:'fixture-turn-1'};
    const result=await f.call('/v1/codex/action',{requestId:randomUUID(),action:safety,connectionId:f.id,...args});assert.equal(result.status,429);assert.equal(JSON.parse(result.text).error,'JOURNAL_LIMIT');
    const state=f.service.state();assert.equal(state.snapshot,null);assert.equal(state.lastSnapshot!.connected,false);assert.equal(state.lastSnapshot!.thread!.writeGranted,false);
    const old=await pending;assert.equal(old.record.state,'unknown');assert.equal(old.record.turnId,'fixture-turn-1');assert.equal((await f.service.action(input)).replayed,true);assert.equal(f.starts(),1);
    const log=(await readFile(join(f.directory,'receipt-1.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.equal(log.filter(row=>row.message?.method==='turn/start').length,1);
  }
});
