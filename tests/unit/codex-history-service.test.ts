import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createCodexService, type CodexService, type CodexActionOutcome } from '../../apps/daemon/src/codex-service.js';
import { codexRoutes } from '../../apps/daemon/src/codex-routes.js';
import { CodexSession } from '../../packages/codex-client/src/session.js';
import { limits } from '../../packages/codex-client/src/validation.js';
import { nativeEnvironment } from '../../packages/codex-client/src/transport.js';
import { HISTORY_GAP_MARKER, NATIVE_HISTORY_LIMITS } from '../../packages/codex-client/src/history.js';

const THREAD = 'fixture-thread', SESSION = 'fixture-session';
const SECRET = 'sk-proj-syntheticHistorySecret12345678';
const fixtureScript = String.raw`
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const [modeFile,audit] = process.argv.slice(2);
let phase='startup';
const log = message => {phase='audit';appendFileSync(audit, JSON.stringify({pid:process.pid,at:Date.now(),message})+'\n');};
// Keep Node's normal exception exit; this owned peer records only safe metadata.
process.on('uncaughtExceptionMonitor',error=>{
  try {appendFileSync(audit,JSON.stringify({pid:process.pid,at:Date.now(),message:{method:'fixture/error',phase,
    code:typeof error.code==='string'?error.code.slice(0,64):null,syscall:typeof error.syscall==='string'?error.syscall.slice(0,64):null}})+'\n');}catch{}
});
log({method:'fixture/spawn',cwd:process.cwd()});
const send = value => {phase='reply';return process.stdout.write(JSON.stringify(value)+'\n');};
const item = (id='answer',text='Recorded assistant answer.') => ({type:'agentMessage',id,text,phase:'final_answer'});
const turn = (items,id='fixture-turn') => ({id,items,itemsView:'full',status:'completed'});
const history = mode => {
  const question={type:'userMessage',id:'question',content:[{type:'text',text:'Inspect this fixture.'}]};
  const answer=item('answer','Recorded assistant answer. api_key=sk-proj-syntheticHistorySecret12345678');
  const reasoning={type:'reasoning',id:'private',summary:[{text:'PRIVATE_REASONING'}],content:'PRIVATE_REASONING'};
  const mcp={type:'mcpToolCall',id:'mcp',arguments:{secret:'PRIVATE_ARGUMENTS'},result:{content:[{type:'text',text:'Public tool output. password=fixturePassword123'}],structuredContent:{secret:'PRIVATE_STRUCTURED'}}};
  const publicItems=[question,answer,reasoning,{type:'commandExecution',id:'tool',command:'PRIVATE_COMMAND',aggregatedOutput:'password=fixturePassword123',status:'completed'},mcp,
    ...(mode==='unsupported-item'?[{type:'futureItem',id:'future',text:'PRIVATE_UNKNOWN'}]:[])];
  // Public metadata shape reported by the parent: one completed full turn, five native item kinds.
  const paginatedItems=[question,item('progress','Public assistant progress.'),mcp,reasoning,answer];
  let turns=mode==='missing-turns'||mode==='paginated-missing-turns'?undefined:
    mode==='turn-limit'?Array.from({length:65},(_,n)=>turn([item('i-'+n)],'t-'+n)):
    mode==='paginated-pages'?Array.from({length:40},(_,n)=>turn([item('p-'+n,'Page answer '+n+'.')],'pt-'+n)):
    mode==='item-limit'?[turn(Array.from({length:257},(_,n)=>item('i-'+n)))]:
    mode==='empty'||mode==='paginated-empty'?[]:[turn(mode.startsWith('paginated')?paginatedItems:publicItems)];
  if(mode==='paginated-summary')turns=[{...turn(paginatedItems),itemsView:'summary'}];
  if(mode==='paginated-missing-view')turns=[{...turn(paginatedItems),itemsView:undefined}];
  if(mode==='paginated-mixed-views')turns=[turn(paginatedItems),
    {...turn([item('summary','PRIVATE_SUMMARY_OUTPUT')],'fixture-summary'),itemsView:'summary'},
    {...turn([item('missing','PRIVATE_MISSING_VIEW_OUTPUT')],'fixture-missing'),itemsView:undefined}];
  const result={thread:{id:mode.endsWith('wrong-thread')?'foreign-thread':mode==='new-thread'?'fixture-new-thread':'fixture-thread',
    sessionId:mode.endsWith('wrong-session')?'foreign-session':'fixture-session',cwd:mode.endsWith('wrong-cwd')?process.cwd()+'/other':process.cwd(),
    ephemeral:mode==='ephemeral',historyMode:mode==='unknown-mode'?'future-mode':mode.startsWith('paginated')?'paginated':'legacy',path:'PRIVATE_TRANSCRIPT_PATH',turns}};
  if(mode==='paginated-envelope')result.nextCursor='older';
  return result;
};
createInterface({input:process.stdin}).on('line',line=>{
  phase='parse';const message=JSON.parse(line);log(message);phase='mode';const mode=readFileSync(modeFile,'utf8').trim();phase='dispatch';
  if(message.method==='initialize')send({id:message.id,result:{userAgent:'synthetic-history-fixture'}});
  else if(message.method==='account/read')send({id:message.id,result:{requiresOpenaiAuth:true,account:{type:'chatgpt',planType:'pro'}}});
  else if(message.method==='model/list')send({id:message.id,result:{data:[{id:'fixture-model',model:'fixture-model',displayName:'Fixture model',supportedReasoningEfforts:[{reasoningEffort:'high'}],defaultReasoningEffort:'high'}],nextCursor:null}});
  else if(message.method==='thread/start'||message.method==='thread/resume'){
    if(mode==='start-hang')return;
    send({id:message.id,result:{thread:{id:mode==='new-thread'?'fixture-new-thread':'fixture-thread',sessionId:'fixture-session',turns:[]},model:'fixture-model',modelProvider:'openai',cwd:process.cwd(),approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:{type:'readOnly',networkAccess:false}}});
  }
  else if(message.method==='thread/read'){
    if(mode==='hang')return;
    if(mode==='remote-error'){process.stderr.write('PRIVATE_STDERR');send({id:message.id,error:{code:-32602,message:'PRIVATE_REMOTE_ERROR'}});return;}
    if(mode==='invalid-json'){process.stdout.write('{bad PRIVATE_JSON\n');return;}
    if(mode==='frame-limit'){send({id:message.id,result:{thread:{...history('normal').thread,preview:'x'.repeat(1048576)}}});return;}
    if(mode==='server-request'){
      send({id:900,method:'item/commandExecution/requestApproval',params:{threadId:'fixture-thread',turnId:'fixture-turn',command:'PRIVATE_APPROVAL_COMMAND'}});
      setTimeout(()=>send({id:message.id,result:history('normal')}),100);return;
    }
    const result=history(mode);
    // A metadata-only read carries no turns, as in the public schema.
    if(message.params.includeTurns===false)delete result.thread.turns;
    setTimeout(()=>send({id:message.id,result}),mode==='delayed'?1000:0);
  } else if(message.method==='thread/turns/list'){
    if(mode==='paginated-turns-error'){send({id:message.id,error:{code:-32603,message:'PRIVATE_REMOTE_PAGE_ERROR'}});return;}
    const all=history(mode).thread.turns,{limit,cursor}=message.params,start=cursor?Number(cursor.slice(5)):0;
    if(all===undefined){send({id:message.id,result:{nextCursor:null,backwardsCursor:null}});return;}
    if(mode==='paginated-cursor-loop'){send({id:message.id,result:{data:[turn([item('loop-'+start)],'loop-'+start)],nextCursor:'page-'+(start+1),backwardsCursor:null}});return;}
    const data=all.slice(start,start+limit),next=start+limit<all.length?'page-'+(start+limit):null;
    send({id:message.id,result:{data,nextCursor:next,backwardsCursor:data.length?'back-'+start:null}});
  } else if(message.method && message.method!=='initialized')send({id:message.id,error:{code:-32601,message:'Unexpected fixture method'}});
});
`;

async function fixture(t: test.TestContext, initialMode='normal') {
  const tempRoot=await realpath(tmpdir()), directory=await mkdtemp(join(tempRoot,'arcane-history-test-'));
  const project=join(directory,'project'), other=join(directory,'other-project'), journal=join(directory,'journal');
  await mkdir(project); await mkdir(other);
  const projectPath=await realpath(project), script=join(directory,'protocol.mjs'), modeFile=join(directory,'mode.txt'), audit=join(directory,'audit.jsonl');
  await writeFile(script,fixtureScript); await writeFile(modeFile,initialMode);
  const services:CodexService[]=[], sessions:CodexSession[]=[]; let starts=0;
  const open=(path=projectPath, connect=true) => {
    const service=createCodexService({directory:journal,projectPath:path,connect:async()=>{
      starts++; assert.ok(connect,'Recorded history must not connect automatically');
      const session=new CodexSession({command:process.execPath,args:[script,modeFile,audit],cwd:path,env:nativeEnvironment()},limits({requestTimeoutMs:3000}),'spawned-node-fixture');
      sessions.push(session); await session.initialize(); return session;
    }}); services.push(service); return service;
  };
  const service=open();
  t.after(async()=>{
    for(const owned of services.reverse())await owned.close();
    const child=relative(tempRoot,resolve(directory));
    assert.ok(child.startsWith('arcane-history-test-')&&!isAbsolute(child)&&!child.includes(sep)&&!child.includes('..'));
    await rm(directory,{recursive:true,force:true});
  });
  const action=(service:CodexService,value:Record<string,unknown>)=>service.action({requestId:randomUUID(),...value});
  const expectAcknowledged=async(result:CodexActionOutcome)=>{
    if(result.record.state==='acknowledged')return;
    const text=(value:unknown,max=96)=>typeof value==='string'?value.slice(0,max):null;
    let peer:unknown;
    try {peer=(await logs()).slice(-16).map(({pid,at,message})=>({pid,at,method:text(message.method),
      id:Number.isSafeInteger(message.id)?message.id:text(message.id,64),code:text(message.code,64),syscall:text(message.syscall,64),phase:text(message.phase,32)}));}
    catch(error){peer={auditError:text((error as NodeJS.ErrnoException)?.code,64)??'UNREADABLE'};}
    const {action,state,errorCode,createdAt,finishedAt}=result.record,snapshot=result.state.snapshot;
    const diagnostic={record:{action,state,errorCode,createdAt,finishedAt},snapshot:snapshot?{connected:snapshot.connected,ready:snapshot.ready,
      failureCode:snapshot.failureCode,operations:snapshot.operations.slice(-8).map(({method,state,errorCode})=>({method,state,errorCode}))}:null,peer};
    assert.equal(result.record.state,'acknowledged','History fixture setup: '+JSON.stringify(diagnostic).slice(0,12288));
  };
  const connect=async(service:CodexService)=>{const result=await action(service,{action:'connect',connectionId:null});await expectAcknowledged(result);return result.state.snapshot!.connectionId;};
  const bind=async(service:CodexService)=>{
    const connectionId=await connect(service);
    await expectAcknowledged(await action(service,{action:'select',connectionId,model:'fixture-model',effort:'high'}));
    const opened=await action(service,{action:'thread-start',connectionId});await expectAcknowledged(opened);
    return {connectionId,threadId:opened.record.threadId!};
  };
  const load=(service:CodexService,connectionId:string,threadId=THREAD,requestId=randomUUID())=>service.action({requestId,action:'history-load',connectionId,threadId});
  const logs=async()=>{try{return (await readFile(audit,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line) as {pid:number;at:number;message:Record<string,unknown>});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}};
  const waitRead=async()=>{for(let n=0;n<400;n++){if((await logs()).some(row=>row.message.method==='thread/read'))return;await delay(5);}assert.fail('Fixture read did not dispatch');};
  return {service,open,action,connect,bind,load,logs,waitRead,starts:()=>starts,sessions,projectPath,other,journal,directory,setMode:(mode:string)=>writeFile(modeFile,mode)};
}
async function http(t:test.TestContext,service:CodexService) {
  const token='a'.repeat(64), agentToken='b'.repeat(64);let origin='';const route=codexRoutes(service);
  const server=createServer((request,response)=>{void route(request,response,new URL(request.url!,origin),token,origin,agentToken).catch(()=>{response.destroy();});});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
  t.after(()=>new Promise<void>((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeAllConnections();}));
  const call=async(path:string,body?:unknown,bearer=token,requestOrigin:string|null=origin)=>{
    const response=await fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+bearer,...(requestOrigin===null?{}:{Origin:requestOrigin}),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});
    return {status:response.status,text:await response.text(),cache:response.headers.get('cache-control')};
  };
  return {call,token,agentToken,origin};
}

test('uncertain history setup reports bounded receipt and peer metadata without replaying the request',async t=>{
  const f=await fixture(t,'start-hang');
  await assert.rejects(f.bind(f.service),(error:unknown)=>{
    assert.ok(error instanceof assert.AssertionError);assert.equal(error.actual,'unknown');assert.equal(error.expected,'acknowledged');
    const match=/^History fixture setup: (\{[^\n]*\})/.exec(error.message);assert.ok(match);
    const diagnostic=JSON.parse(match[1]!);
    assert.equal(diagnostic.record.action,'thread-start');assert.equal(diagnostic.record.errorCode,'TIMEOUT');
    assert.equal(diagnostic.snapshot.connected,false);assert.equal(diagnostic.snapshot.failureCode,'TIMEOUT');
    assert.deepEqual(diagnostic.snapshot.operations,[{method:'thread/start',state:'unknown',errorCode:'TIMEOUT'}]);
    assert.equal(diagnostic.peer.filter((row:{method:string})=>row.method==='thread/start').length,1);
    assert.ok(error.message.length<13000);
    for(const value of [f.projectPath,SECRET,'PRIVATE_', 'params','cwd','sandbox'])assert.ok(!error.message.includes(value));
    return true;
  });
  assert.equal((await f.logs()).filter(row=>row.message.method==='thread/start').length,1);
  assert.equal(f.starts(),1);
});

test('history endpoints are inert and human-only; agent/foreign-origin/query/spoofed inputs cannot launch',async t=>{
  const f=await fixture(t),h=await http(t,f.service);
  const cached=await h.call('/v1/codex/history');assert.equal(cached.status,200);assert.equal(cached.cache,'no-store');assert.equal(JSON.parse(cached.text).nativeHistory,null);
  assert.equal((await h.call('/v1/codex/history',undefined,h.agentToken)).status,403);
  assert.equal((await h.call('/v1/codex/history',undefined,'invalid')).status,401);
  assert.equal((await h.call('/v1/codex/history?threadId=foreign')).status,400);
  assert.equal((await h.call('/v1/codex/history',undefined,h.token,'https://foreign.invalid')).status,403);
  assert.equal((await h.call('/v1/codex/history',{})).status,405);
  const input={requestId:randomUUID(),action:'history-load',connectionId:randomUUID(),threadId:THREAD};
  for(const extra of [{initiatedBy:'human'},{cwd:f.projectPath},{sessionId:SESSION},{includeTurns:true},{historyMode:'legacy'},{command:process.execPath}])assert.equal((await h.call('/v1/codex/action',{...input,...extra})).status,400);
  assert.equal((await h.call('/v1/codex/action',input,h.agentToken)).status,403);
  assert.equal((await h.call('/v1/codex/action',input,h.token,null)).status,403);
  assert.equal(f.starts(),0);assert.deepEqual(await f.logs(),[]);assert.equal(f.service.state().nativeHistory,null);
});

test('human HTTP load returns the documented action/state contract and cached GET never rereads',async t=>{
  const f=await fixture(t,'unsupported-item'),scope=await f.bind(f.service),h=await http(t,f.service),requestId=randomUUID();
  const response=await h.call('/v1/codex/action',{requestId,action:'history-load',...scope});
  assert.equal(response.status,200);assert.equal(response.cache,'no-store');
  const loaded=JSON.parse(response.text);assert.equal(loaded.record.requestId,requestId);assert.equal(loaded.record.state,'acknowledged');assert.equal(loaded.replayed,false);
  assert.equal(loaded.state.nativeHistory.projectPath,f.projectPath);assert.equal(loaded.state.nativeHistory.recorded.requestId,requestId);assert.equal(loaded.state.nativeHistory.recorded.result.completeness,'incomplete');assert.equal(loaded.state.nativeHistory.recorded.result.marker,HISTORY_GAP_MARKER);
  const count=(await f.logs()).length,cached=await h.call('/v1/codex/history');
  assert.deepEqual(JSON.parse(cached.text).nativeHistory,loaded.state.nativeHistory);assert.equal((await f.logs()).length,count);
  assert.equal((await h.call('/v1/codex/action',{requestId:randomUUID(),action:'history-load',connectionId:scope.connectionId,threadId:'foreign-thread'})).status,409);
});

test('explicit load sends only public read in its bounded child, preserves IDs, redacts and records projection atomically',async t=>{
  const f=await fixture(t),scope=await f.bind(f.service);
  assert.equal(f.service.state().nativeHistory!.recorded,null);assert.equal((await f.logs()).filter(row=>row.message.method==='thread/read').length,0);
  const before=f.sessions[0]!.snapshot(),loaded=await f.load(f.service,scope.connectionId),recorded=loaded.state.nativeHistory!.recorded!;
  assert.equal(loaded.record.state,'acknowledged');assert.equal(recorded.provenance,'spawned-node-fixture');assert.equal(recorded.result.completeness,'complete');assert.equal(recorded.result.redacted,true);assert.equal(recorded.result.excludedItems,1);
  assert.deepEqual(recorded.result.entries.map(entry=>entry.role),['user','assistant','tool','tool']);
  assert.deepEqual(recorded.result.entries[1]!.ids,{threadId:THREAD,sessionId:SESSION,turnId:'fixture-turn',itemId:'answer'});
  assert.deepEqual(f.sessions[0]!.snapshot(),before);
  const rows=await f.logs(),readPid=rows.find(row=>row.message.method==='thread/read')!.pid,reads=rows.filter(row=>row.pid===readPid);
  // Legacy storage: exact-scope metadata first, then the hydrated legacy read; never a page request.
  assert.deepEqual(reads.map(row=>row.message.method),['fixture/spawn','initialize','initialized','thread/read','thread/read']);
  assert.deepEqual(reads.filter(row=>row.message.method==='thread/read').map(row=>row.message.params),[{threadId:THREAD,includeTurns:false},{threadId:THREAD,includeTurns:true}]);
  const db=new DatabaseSync(join(f.journal,'codex-actions.sqlite'));
  try{
    const row=db.prepare('SELECT payload FROM native_history').get() as {payload:string};
    for(const secret of [SECRET,'fixturePassword123','PRIVATE_REASONING','PRIVATE_COMMAND','PRIVATE_ARGUMENTS','PRIVATE_STRUCTURED','PRIVATE_TRANSCRIPT_PATH'])assert.ok(!row.payload.includes(secret));
    assert.equal((db.prepare('SELECT count(*) AS n FROM native_history').get() as {n:number}).n,1);
    assert.equal(JSON.parse((db.prepare('SELECT payload FROM actions WHERE id=?').get(loaded.record.requestId) as {payload:string}).payload).state,'acknowledged');
  }finally{db.close();}
  recorded.result.entries[0]!.text='mutated';assert.equal(f.service.state().nativeHistory!.recorded!.result.entries[0]!.text,'Inspect this fixture.');
});

test('paginated history pages thread/turns/list after a metadata read, persists redacted exact-scoped IDs and survives offline restart',async t=>{
  const f=await fixture(t,'paginated'),scope=await f.bind(f.service),before=f.sessions[0]!.snapshot(),requestId=randomUUID();
  const loaded=await f.load(f.service,scope.connectionId,scope.threadId,requestId);
  assert.equal(loaded.record.state,'acknowledged',loaded.record.errorCode??undefined);
  const binding=loaded.state.nativeHistory!,recorded=binding.recorded!,result=recorded.result;assert.equal(binding.projectPath,f.projectPath);assert.equal(binding.threadId,THREAD);assert.equal(binding.sessionId,SESSION);
  assert.equal(recorded.requestId,requestId);assert.equal(recorded.connectionId,scope.connectionId);assert.equal(recorded.provenance,'spawned-node-fixture');
  assert.equal(result.completeness,'complete');assert.equal(result.marker,null);assert.deepEqual(result.gaps,[]);assert.equal(result.truncated,false);assert.equal(result.excludedItems,1);assert.equal(result.redacted,true);
  assert.deepEqual(result.entries.map(entry=>({role:entry.role,ids:entry.ids})),[
    {role:'user',ids:{threadId:THREAD,sessionId:SESSION,turnId:'fixture-turn',itemId:'question'}},
    {role:'assistant',ids:{threadId:THREAD,sessionId:SESSION,turnId:'fixture-turn',itemId:'progress'}},
    {role:'tool',ids:{threadId:THREAD,sessionId:SESSION,turnId:'fixture-turn',itemId:'mcp'}},
    {role:'assistant',ids:{threadId:THREAD,sessionId:SESSION,turnId:'fixture-turn',itemId:'answer'}},
  ]);
  assert.equal(result.entries[2]!.text,'Public tool output. password=[REDACTED]');
  assert.equal(result.entries[3]!.text,'Recorded assistant answer. api_key=[REDACTED]');assert.deepEqual(f.sessions[0]!.snapshot(),before);
  const db=new DatabaseSync(join(f.journal,'codex-actions.sqlite'));
  try{
    const row=db.prepare('SELECT project_path,thread_id,session_id,payload FROM native_history').get() as {project_path:string;thread_id:string;session_id:string;payload:string};
    assert.equal(row.project_path,f.projectPath);assert.equal(row.thread_id,THREAD);assert.equal(row.session_id,SESSION);assert.deepEqual(JSON.parse(row.payload),recorded);
    for(const secret of [SECRET,'fixturePassword123','PRIVATE_REASONING','PRIVATE_ARGUMENTS','PRIVATE_STRUCTURED','PRIVATE_TRANSCRIPT_PATH'])assert.ok(!row.payload.includes(secret));
  }finally{db.close();}
  const rows=await f.logs(),readPid=rows.find(row=>row.message.method==='thread/read')!.pid,reads=rows.filter(row=>row.pid===readPid);
  // The deprecated hydrated read is never sent for paginated storage.
  assert.deepEqual(reads.map(row=>row.message.method),['fixture/spawn','initialize','initialized','thread/read','thread/turns/list']);
  assert.deepEqual(reads[3]!.message.params,{threadId:THREAD,includeTurns:false});
  assert.deepEqual(reads[4]!.message.params,{threadId:THREAD,limit:32,sortDirection:'asc',itemsView:'full'});
  await f.service.close();const restarted=f.open(f.projectPath,false),h=await http(t,restarted),count=(await f.logs()).length;
  assert.deepEqual(restarted.state().nativeHistory,binding);assert.equal(restarted.state().snapshot,null);
  const cached=await h.call('/v1/codex/history');assert.equal(cached.status,200);assert.deepEqual(JSON.parse(cached.text).nativeHistory,binding);
  const replay=await f.load(restarted,scope.connectionId,scope.threadId,requestId);assert.equal(replay.replayed,true);assert.deepEqual(replay.state.nativeHistory,binding);
  assert.equal(f.starts(),1);assert.equal((await f.logs()).length,count);
  await restarted.close();const other=f.open(await realpath(f.other),false);assert.equal(other.state().nativeHistory,null);assert.equal(f.starts(),1);assert.equal((await f.logs()).length,count);
});

for(const mode of ['paginated-summary','paginated-missing-view'])test(mode+' is recorded with an incomplete marker and cannot pretend to be hydrated',async t=>{
  const f=await fixture(t,mode),scope=await f.bind(f.service),loaded=await f.load(f.service,scope.connectionId);
  assert.equal(loaded.record.state,'acknowledged',loaded.record.errorCode??undefined);
  const binding=loaded.state.nativeHistory!,result=binding.recorded!.result;assert.equal(result.completeness,'incomplete');assert.equal(result.marker,HISTORY_GAP_MARKER);assert.ok(result.gaps.length>0);assert.deepEqual(result.entries,[]);
  if(mode==='paginated-summary'||mode==='paginated-missing-view')assert.ok(result.gaps.some(gap=>gap.reason==='items-not-full'));
  assert.ok(!JSON.stringify(binding).includes(SECRET));assert.ok(!JSON.stringify(binding).includes('PRIVATE_'));
  await f.service.close();const restarted=f.open(f.projectPath,false);assert.deepEqual(restarted.state().nativeHistory,binding);assert.equal(restarted.state().snapshot,null);assert.equal(f.starts(),1);
});

test('a fully enumerated empty paginated thread is a complete empty history',async t=>{
  const f=await fixture(t,'paginated-empty'),scope=await f.bind(f.service),loaded=await f.load(f.service,scope.connectionId);
  assert.equal(loaded.record.state,'acknowledged',loaded.record.errorCode??undefined);
  const result=loaded.state.nativeHistory!.recorded!.result;
  assert.equal(result.completeness,'complete');assert.deepEqual(result.entries,[]);assert.deepEqual(result.gaps,[]);assert.equal(result.marker,null);
  assert.equal((await f.logs()).filter(row=>row.message.method==='thread/turns/list').length,1);
});

test('multiple bounded pages follow nextCursor in ascending order into one complete projection',async t=>{
  const f=await fixture(t,'paginated-pages'),scope=await f.bind(f.service),loaded=await f.load(f.service,scope.connectionId);
  assert.equal(loaded.record.state,'acknowledged',loaded.record.errorCode??undefined);
  const result=loaded.state.nativeHistory!.recorded!.result;
  assert.equal(result.completeness,'complete');assert.equal(result.entries.length,40);
  assert.deepEqual(result.entries.map(entry=>entry.ids.turnId),Array.from({length:40},(_,n)=>'pt-'+n));
  const pages=(await f.logs()).filter(row=>row.message.method==='thread/turns/list').map(row=>row.message.params);
  assert.deepEqual(pages,[{threadId:THREAD,limit:32,sortDirection:'asc',itemsView:'full'},{threadId:THREAD,limit:32,sortDirection:'asc',itemsView:'full',cursor:'page-32'}]);
});

test('an endless cursor is bounded by the page cap and never reported complete',async t=>{
  const f=await fixture(t,'paginated-cursor-loop'),scope=await f.bind(f.service),loaded=await f.load(f.service,scope.connectionId);
  assert.equal(loaded.record.state,'acknowledged',loaded.record.errorCode??undefined);
  const result=loaded.state.nativeHistory!.recorded!.result;
  assert.equal(result.completeness,'incomplete');assert.equal(result.truncated,true);assert.equal(result.marker,HISTORY_GAP_MARKER);
  assert.ok(result.gaps.some(gap=>gap.reason==='turn-limit'));assert.equal(result.entries.length,8);
  assert.equal((await f.logs()).filter(row=>row.message.method==='thread/turns/list').length,8);
});

test('paginated turns each require explicit full itemsView while valid hydrated turns retain their IDs',async t=>{
  const f=await fixture(t,'paginated-mixed-views'),scope=await f.bind(f.service),loaded=await f.load(f.service,scope.connectionId);
  assert.equal(loaded.record.state,'acknowledged',loaded.record.errorCode??undefined);
  const result=loaded.state.nativeHistory!.recorded!.result;assert.equal(result.completeness,'incomplete');assert.equal(result.marker,HISTORY_GAP_MARKER);
  assert.deepEqual(result.gaps.filter(gap=>gap.reason==='items-not-full').map(gap=>gap.turnId),['fixture-summary','fixture-missing']);
  assert.deepEqual(result.entries.map(entry=>entry.ids.itemId),['question','progress','mcp','answer']);assert.ok(result.entries.every(entry=>entry.ids.threadId===THREAD&&entry.ids.sessionId===SESSION&&entry.ids.turnId==='fixture-turn'));
  assert.ok(!JSON.stringify(result).includes('PRIVATE_SUMMARY_OUTPUT'));assert.ok(!JSON.stringify(result).includes('PRIVATE_MISSING_VIEW_OUTPUT'));assert.ok(!JSON.stringify(result).includes(SECRET));
});

test('recorded history survives restart and GET/replayed load remains offline without restoring grants',async t=>{
  const f=await fixture(t),scope=await f.bind(f.service),requestId=randomUUID(),loaded=await f.load(f.service,scope.connectionId,THREAD,requestId);
  await f.service.close();const restarted=f.open(f.projectPath,false),h=await http(t,restarted),count=(await f.logs()).length;
  assert.deepEqual(restarted.state().nativeHistory,loaded.state.nativeHistory);assert.equal(restarted.state().snapshot,null);assert.equal(restarted.state().lastSnapshot,null);
  const cached=await h.call('/v1/codex/history');assert.equal(cached.status,200);assert.deepEqual(JSON.parse(cached.text).nativeHistory,loaded.state.nativeHistory);
  const replay=await f.load(restarted,scope.connectionId,THREAD,requestId);assert.equal(replay.replayed,true);assert.deepEqual(replay.record,loaded.record);
  assert.equal((await f.load(restarted,scope.connectionId)).record.errorCode,'STALE_CONNECTION');
  assert.equal(f.starts(),1);assert.equal((await f.logs()).length,count);
});

test('after human reconnect a recorded bound thread can refresh without selection, resume, inference or writes',async t=>{
  const f=await fixture(t),scope=await f.bind(f.service);await f.load(f.service,scope.connectionId);await f.service.close();
  const restarted=f.open(),connectionId=await f.connect(restarted),before=f.sessions[1]!.snapshot(),count=(await f.logs()).length;
  assert.equal(before.thread,null);assert.equal(before.selection,null);assert.equal((await f.load(restarted,connectionId)).record.state,'acknowledged');
  assert.deepEqual(f.sessions[1]!.snapshot(),before);assert.deepEqual((await f.logs()).slice(count).map(row=>row.message.method),['fixture/spawn','initialize','initialized','thread/read','thread/read']);
});

test('unknown/foreign/stale bindings are refused before native read; request identity never dispatches twice',async t=>{
  const f=await fixture(t),connectionId=await f.connect(f.service);
  assert.equal((await f.load(f.service,connectionId)).record.errorCode,'HISTORY_SCOPE');
  await f.action(f.service,{action:'disconnect',connectionId});const scope=await f.bind(f.service),requestId=randomUUID();
  assert.equal((await f.load(f.service,connectionId)).record.errorCode,'STALE_CONNECTION');
  assert.equal((await f.load(f.service,scope.connectionId,'foreign-thread')).record.errorCode,'HISTORY_SCOPE');
  assert.equal((await f.load(f.service,scope.connectionId,THREAD,requestId)).record.state,'acknowledged');
  assert.equal((await f.load(f.service,scope.connectionId,THREAD,requestId)).replayed,true);
  await assert.rejects(f.load(f.service,scope.connectionId,'foreign-thread',requestId),{code:'IDEMPOTENCY'});
  // Exactly one load dispatched: one metadata read plus its one legacy hydration.
  assert.equal((await f.logs()).filter(row=>row.message.method==='thread/read'&&(row.message.params as {includeTurns?:unknown}).includeTurns===false).length,1);
});

for(const mode of ['wrong-thread','wrong-session','wrong-cwd','unknown-mode','paginated-wrong-thread','paginated-wrong-session','paginated-wrong-cwd','paginated-envelope','paginated-missing-turns','paginated-turns-error','ephemeral','remote-error','invalid-json','frame-limit'])test('history '+mode+' refuses unsafe replacement and retains the last verified recording',async t=>{
  const f=await fixture(t),scope=await f.bind(f.service),first=await f.load(f.service,scope.connectionId);
  await f.setMode(mode);const refused=await f.load(f.service,scope.connectionId);
  assert.equal(refused.record.state,'rejected');assert.deepEqual(refused.state.nativeHistory,first.state.nativeHistory);
  assert.ok(['HISTORY_REJECTED','REMOTE_REJECTED','PROTOCOL','FRAME_LIMIT'].includes(refused.record.errorCode!));
  assert.ok(!JSON.stringify(refused).includes('PRIVATE_'));assert.ok(!JSON.stringify(refused).includes(SECRET));
});

for(const mode of ['unsupported-item','missing-turns','turn-limit','item-limit','empty'])test('bounded '+mode+' history records explicit completeness evidence',async t=>{
  const f=await fixture(t,mode),scope=await f.bind(f.service),loaded=await f.load(f.service,scope.connectionId),result=loaded.state.nativeHistory!.recorded!.result;
  assert.equal(loaded.record.state,'acknowledged');assert.ok(Buffer.byteLength(JSON.stringify(result))<=NATIVE_HISTORY_LIMITS.maxBytes);
  if(mode==='empty'){assert.equal(result.completeness,'complete');assert.deepEqual(result.entries,[]);assert.equal(result.marker,null);}
  else{assert.equal(result.completeness,'incomplete');assert.equal(result.marker,HISTORY_GAP_MARKER);assert.ok(result.gaps.length>0);}
  if(mode==='turn-limit'){assert.equal(result.entries.length,64);assert.equal(result.truncated,true);}
  if(mode==='item-limit'){assert.equal(result.entries.length,256);assert.equal(result.truncated,true);}
});

test('read child refuses unsolicited native approvals and never exposes their payload',async t=>{
  const f=await fixture(t,'server-request'),scope=await f.bind(f.service),loaded=await f.load(f.service,scope.connectionId);
  assert.equal(loaded.record.state,'acknowledged');assert.deepEqual(loaded.state.snapshot!.approvals,[]);
  const response=(await f.logs()).find(row=>row.message.id===900 && row.message.error)!;
  assert.deepEqual(response.message.error,{code:-32601,message:'Unsupported by the history reader.'});assert.ok(!JSON.stringify(loaded).includes('PRIVATE_APPROVAL_COMMAND'));
});

test('disconnect fences an outstanding read; busy actions and duplicate request IDs cannot start more reads',async t=>{
  const f=await fixture(t,'delayed'),scope=await f.bind(f.service),requestId=randomUUID();
  const pending=f.load(f.service,scope.connectionId,THREAD,requestId);await f.waitRead();assert.equal(f.service.state().busy,true);
  assert.equal((await f.load(f.service,scope.connectionId,THREAD,requestId)).replayed,true);
  assert.equal((await f.load(f.service,scope.connectionId)).record.errorCode,'BUSY');
  assert.equal((await f.action(f.service,{action:'disconnect',connectionId:scope.connectionId})).record.state,'acknowledged');
  const stopped=await pending;assert.equal(stopped.record.state,'rejected');assert.equal(stopped.state.nativeHistory!.recorded,null);
  assert.equal((await f.logs()).filter(row=>row.message.method==='thread/read').length,1);
});

test('shutdown cancels and durably refuses an outstanding read without crash replay',async t=>{
  const f=await fixture(t,'hang'),scope=await f.bind(f.service),requestId=randomUUID();
  const pending=f.load(f.service,scope.connectionId,THREAD,requestId),rejected=assert.rejects(pending,{code:'CLOSED'});await f.waitRead();await f.service.close();await rejected;
  const restarted=f.open(f.projectPath,false),receipt=restarted.state().actions.find(row=>row.requestId===requestId)!;
  assert.equal(receipt.state,'rejected');assert.equal(restarted.state().nativeHistory!.recorded,null);assert.equal(f.starts(),1);
});

test('timed out read is bounded, recorded as refused, and cannot auto retry',async t=>{
  const f=await fixture(t,'hang'),scope=await f.bind(f.service),requestId=randomUUID(),result=await f.load(f.service,scope.connectionId,THREAD,requestId);
  assert.equal(result.record.state,'rejected');assert.equal(result.record.errorCode,'TIMEOUT');
  assert.equal((await f.load(f.service,scope.connectionId,THREAD,requestId)).replayed,true);assert.equal((await f.logs()).filter(row=>row.message.method==='thread/read').length,1);
});

test('a different project cannot display or refresh another project recording',async t=>{
  const f=await fixture(t),scope=await f.bind(f.service);await f.load(f.service,scope.connectionId);await f.service.close();
  const other=f.open(await realpath(f.other)),connectionId=await f.connect(other),count=(await f.logs()).length;
  assert.equal(other.state().nativeHistory,null);assert.equal((await f.load(other,connectionId)).record.errorCode,'HISTORY_SCOPE');assert.equal((await f.logs()).length,count);
});

test('acknowledging a new current thread clears the old projection and preserves exact new binding',async t=>{
  const f=await fixture(t),scope=await f.bind(f.service);await f.load(f.service,scope.connectionId);await f.action(f.service,{action:'disconnect',connectionId:scope.connectionId});
  await f.setMode('new-thread');const next=await f.bind(f.service);assert.equal(next.threadId,'fixture-new-thread');assert.equal(f.service.state().nativeHistory!.recorded,null);
  assert.equal((await f.load(f.service,next.connectionId)).record.errorCode,'HISTORY_SCOPE');assert.equal((await f.load(f.service,next.connectionId,next.threadId)).record.state,'acknowledged');
  assert.equal(f.service.state().nativeHistory!.recorded!.result.entries[0]!.ids.threadId,next.threadId);
});

test('v1 migration preserves receipts without guessing project/thread binding or dispatching',async t=>{
  const f=await fixture(t),scope=await f.bind(f.service);await f.service.close();
  // A genuine v1 journal has action receipts but neither later native table.
  // Receipts must not be promoted into guessed native ownership on migration.
  const db=new DatabaseSync(join(f.journal,'codex-actions.sqlite'));db.exec('DROP TABLE native_history; DROP TABLE native_threads; PRAGMA user_version=1;');db.close();
  const migrated=f.open(f.projectPath,false);assert.equal(migrated.state().nativeHistory,null);assert.deepEqual(migrated.state().nativeThreads,[]);assert.ok(migrated.state().actions.some(row=>row.threadId===scope.threadId));assert.equal(f.starts(),1);
  const check=new DatabaseSync(join(f.journal,'codex-actions.sqlite'));assert.equal((check.prepare('PRAGMA user_version').get() as {user_version:number}).user_version,3);assert.equal((check.prepare('SELECT count(*) AS count FROM native_threads').get() as {count:number}).count,0);check.close();
});

test('client rejects nonhuman and mismatched identity before starting a read process',async t=>{
  const f=await fixture(t),scope=await f.bind(f.service),session=f.sessions[0]!,count=(await f.logs()).length;
  await assert.rejects(session.readThreadHistory({initiatedBy:'agent',threadId:THREAD} as never),{code:'HUMAN_REQUIRED'});
  await assert.rejects(session.readThreadHistory({initiatedBy:'human',threadId:'foreign-thread'}),{code:'THREAD'});
  await assert.rejects(session.readThreadHistory({initiatedBy:'human',threadId:THREAD,sessionId:'foreign-session'}),{code:'THREAD'});
  assert.equal((await f.logs()).length,count);assert.equal(session.snapshot().connectionId,scope.connectionId);
});
