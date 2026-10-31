import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute,sep} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import {createCodexService,type CodexActionOutcome} from '../../apps/daemon/src/codex-service.js';
import {codexRoutes} from '../../apps/daemon/src/codex-routes.js';
import {createNativeAssetRegistry,assertNativeAssetActor} from '../../apps/daemon/src/native-asset-authority.js';
import {CodexSession} from '../../packages/codex-client/src/session.js';
import {CodexClientError,type NativeTaskContinuation} from '../../packages/codex-client/src/types.js';
import {nativeEnvironment} from '../../packages/codex-client/src/transport.js';
import {limits} from '../../packages/codex-client/src/validation.js';
import {ARCANE_NATIVE_TOOL_NAMES} from '../../packages/protocol/src/arcane-tools.js';
import {sqliteTransportPath} from '../../packages/storage/src/sqlite-path.js';

// Actual service/registry/SQLite/HTTP/client with controlled Node JSONL peers.
// No customer CLI, provider, Studio, real native sandbox or engine acceptance.
const PEER=String.raw`
const {createInterface}=require('node:readline'),{appendFileSync,existsSync}=require('node:fs');
const [encoded,audit]=process.argv.slice(1),s=JSON.parse(encoded);let threadId=s.threadId,turns=0;
const send=value=>process.stdout.write(JSON.stringify(value)+'\n'),reply=(id,result)=>send({id,result});
createInterface({input:process.stdin}).on('line',line=>{
 const message=JSON.parse(line),{id,method,params={}}=message;
 appendFileSync(audit,JSON.stringify({process:s.index,...message})+'\n');
 if(!method||method==='initialized')return;
 if(method==='initialize'){
  if(s.mode==='frame')return process.stdout.write('x'.repeat(1048577)+'\n');
  return reply(id,{});
 }
 if(method==='account/read')return reply(id,{account:{type:'chatgpt',email:'fixture@example.invalid',planType:'plus'},requiresOpenaiAuth:true});
 if(method==='model/list')return reply(id,{data:[{id:'fixture',model:'fixture',displayName:'Fixture',supportedReasoningEfforts:[{reasoningEffort:'low'}]}],nextCursor:null});
 if(method==='thread/start'||method==='thread/resume'){
  threadId=params.threadId??s.threadId;return reply(id,{thread:{id:threadId,sessionId:s.sessionId,turns:[],status:{type:'idle'}},
   model:params.model,modelProvider:'openai',cwd:process.cwd(),approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:{type:'readOnly',networkAccess:false}});
 }
 if(method==='mcpServerStatus/list')return reply(id,{data:[{name:'arcane',runtimeStatus:'connected',toolsError:null,pluginId:null,
  tools:Object.fromEntries(s.tools.map(name=>[name,{}]))}],nextCursor:null});
 if(method==='turn/start'){
  turns++;reply(id,{turn:{id:'recovery.turn:'+s.index+':'+turns,status:'inProgress'}});
  if(s.mode==='depart'){const timer=setInterval(()=>{if(existsSync(s.depart)){clearInterval(timer);process.exit(0);}},5);}
  return;
 }
 if(method==='turn/interrupt')return reply(id,{});
 throw Error('Unexpected controlled recovery method');
});`;
interface Wire {process:number;method?:string;params?:Record<string,unknown>}
async function until(check:()=>boolean):Promise<void>{
  const deadline=Date.now()+4000;while(!check()){assert.ok(Date.now()<deadline,'Expected controlled recovery phase');await delay(5);}
}

test('fresh same-project human Send survives legacy unknown records without replay or rewriting their raw journals',{timeout:20000},async t=>{
  const boundary=await realpath(tmpdir()),root=await realpath(await mkdtemp(join(boundary,'arcane-native-recovery-'))),project=join(root,'project'),directory=join(root,'journal');
  await mkdir(project);const audit=join(root,'wire.jsonl'),depart=join(root,'depart-original');
  const clients:CodexSession[]=[],tokens:string[]=[],continuations=new Map<number,NativeTaskContinuation>(),closers:(()=>Promise<void>)[]=[];
  let actionDb:DatabaseSync|undefined,taskDb:DatabaseSync|undefined;
  t.after(async()=>{
    try{for(const close of [...closers].reverse())await close();}
    finally{actionDb?.close();taskDb?.close();const part=relative(boundary,root);assert.ok(part.startsWith('arcane-native-recovery-')&&!isAbsolute(part)&&!part.includes(sep));await rm(root,{recursive:true,force:true});}
  });
  async function open(){
    const registry=createNativeAssetRegistry({projectPath:await realpath(project)});
    const service=createCodexService({directory,projectPath:project,assetRegistry:registry,connect:async hooks=>{
      assert.ok(hooks);const index=clients.length;tokens.push(hooks.finalCredential());
      const client=new CodexSession({command:process.execPath,args:['-e',PEER,JSON.stringify({index,mode:index===0?'frame':index===1?'depart':'held',
        threadId:'recovery.thread:'+index,sessionId:'recovery.session:'+index,depart,tools:ARCANE_NATIVE_TOOL_NAMES}),audit],cwd:project,env:nativeEnvironment()},
        limits({requestTimeoutMs:3000}),'spawned-node-fixture','arcane-only',hooks);
      clients.push(client);
      // Observe the genuine private return; do not mint or replace a token.
      const start=client.startManagedTask.bind(client);
      client.startManagedTask=async input=>{const value=await start(input);continuations.set(index,value.continuation);return value;};
      try{await client.initialize();return client;}catch(error){await client.close();throw error;}
    }});
    service.attachPlaytestCancellation(Object.freeze({async cancelExact(){assert.fail('No playtest was prepared');},async revalidateExact(){assert.fail('No playtest was prepared');return 'unobserved' as const;}}));
    const control='human-'+randomUUID(),generic='agent-'+randomUUID(),route=codexRoutes(service);let origin='';
    const server=createServer(async(request,response)=>{if(!await route(request,response,new URL(request.url??'/',origin),control,origin,generic)){response.writeHead(404);response.end();}});
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
    let closed:Promise<void>|null=null;
    const close=()=>closed??=(async()=>{try{await service.close();}finally{registry.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}})();
    closers.push(close);
    const post=async(input:unknown,bearer=control)=>{
      const response=await fetch(origin+'/v1/codex/action',{method:'POST',headers:{Authorization:'Bearer '+bearer,Origin:origin,'Content-Type':'application/json'},
        body:JSON.stringify(input),signal:AbortSignal.timeout(5000)});
      return{status:response.status,data:await response.json() as CodexActionOutcome};
    };
    const action=(action:string,fields:Record<string,unknown>={})=>post({requestId:randomUUID(),connectionId:action==='connect'?null:service.state().snapshot!.connectionId,action,...fields});
    const ready=async()=>{for(const [name,fields]of [['connect',{}],['select',{model:'fixture',effort:'low'}],['thread-start',{}]]as const){
      const result=await action(name,fields);assert.equal(result.status,200);assert.equal(result.data.record.state,'acknowledged');
    }};
    return{service,registry,post,action,ready,close,generic};
  }
  const wire=async():Promise<Wire[]>=>{
    const text=await readFile(audit,'utf8');assert.ok(Buffer.byteLength(text)<=256*1024);const end=text.lastIndexOf('\n');
    return end<0?[]:text.slice(0,end).split('\n').map(line=>JSON.parse(line)as Wire);
  };
  const first=await open(),failed=await first.action('connect');
  assert.equal(failed.data.record.state,'unknown');assert.equal(failed.data.record.errorCode,'FRAME_LIMIT');assert.equal(clients[0]!.snapshot().connected,false);
  await first.ready();const oldConnection=first.service.state().snapshot!.connectionId,oldThread=first.service.state().snapshot!.thread!.threadId;
  const started=await first.action('turn-start',{threadId:oldThread,text:'Controlled original task',allowWorkspaceWrites:true,allowAssets:true});
  assert.equal(started.data.record.state,'acknowledged');const originalToken=continuations.get(1);assert.ok(originalToken);
  const oldActorId='agent-'+createHash('sha256').update(tokens[1]!).digest('hex'),oldOrigin=first.service.playtestTasks!.capture(oldActorId);assert.ok(oldOrigin);
  const oldActor=first.registry.capture(tokens[1]!,'mutate');assertNativeAssetActor(oldActor,'mutate');
  await writeFile(depart,'',{flag:'wx'});
  await until(()=>first.service.state().chatTasks!.some(row=>row.taskId===oldOrigin.taskId&&row.state==='unknown'));
  await first.close();assert.equal(clients[1]!.snapshot().connected,false);
  assert.throws(()=>assertNativeAssetActor(oldActor,'mutate'));
  await assert.rejects(clients[1]!.continueTask({continuation:originalToken,text:'Must not resume retired original'}),error=>error instanceof CodexClientError&&error.code==='TASK_SCOPE');

  actionDb=new DatabaseSync(sqliteTransportPath(join(directory,'codex-actions.sqlite')));
  taskDb=new DatabaseSync(sqliteTransportPath(join(directory,'chat-tasks','chat-tasks.sqlite')));
  const legacyActions=actionDb.prepare('SELECT id,hash,payload FROM actions ORDER BY rowid').all(),legacyTasks=taskDb.prepare('SELECT id,payload FROM chat_tasks ORDER BY rowid').all();
  assert.equal(legacyTasks.length,1);assert.equal(JSON.parse(String(legacyTasks[0]!.payload)).state,'unknown');
  // The controlled old peers genuinely closed. Remove only their modern custody
  // evidence to model an old v4 journal; never insert fictitious closure proof or
  // rewrite the original action/task receipts to make recovery pass.
  actionDb.exec('DROP TABLE native_session_requests;DROP TABLE native_session_custody;PRAGMA user_version=4;');
  const unchanged=()=>{
    assert.deepEqual(actionDb!.prepare('SELECT id,hash,payload FROM actions ORDER BY rowid LIMIT ?').all(legacyActions.length),legacyActions);
    assert.deepEqual(taskDb!.prepare('SELECT id,payload FROM chat_tasks ORDER BY rowid LIMIT ?').all(legacyTasks.length),legacyTasks);
  };
  const second=await open();unchanged();assert.equal(clients.length,2,'reopening does not start a provider or replay an old turn');
  const recovery=second.service.state().nativeRecovery;assert.ok(recovery);assert.equal(recovery.nativeReservations,3);
  assert.ok(recovery.historicalActionIds.includes(failed.data.record.requestId));assert.ok(recovery.historicalTaskIds.includes(oldOrigin.taskId));
  assert.ok(recovery.blockedThreadIds.includes(oldThread));assert.equal(second.service.state().snapshot,null);
  assert.equal(second.service.playtestTasks!.capture(oldActorId),null);assert.throws(()=>second.service.playtestTasks!.assert(oldOrigin));
  assert.throws(()=>second.registry.capture(tokens[1]!,'mutate'));
  await second.ready();const fresh=second.service.state().snapshot!,freshThread=fresh.thread!.threadId;
  assert.notEqual(fresh.connectionId,oldConnection);assert.notEqual(freshThread,oldThread);assert.equal(second.service.state().projectPath,await realpath(project));
  for(const [name,fields]of [['thread-resume',{threadId:oldThread}],['task-focus',{threadId:oldThread,taskId:oldOrigin.taskId}],
    ['grant-writes',{threadId:oldThread}]]as const){
    const refused=await second.action(name,fields);assert.equal(refused.data.record.state,'rejected');assert.equal(refused.data.record.errorCode,'TASK_RECOVERY_REQUIRED');
  }
  const input={requestId:randomUUID(),connectionId:fresh.connectionId,action:'turn-start',threadId:freshThread,text:'Independent authorized human task',allowWorkspaceWrites:true,allowAssets:true};
  const denied=await second.post(input,second.generic);assert.equal(denied.status,403);
  const sent=await second.post(input);assert.equal(sent.status,200);assert.equal(sent.data.record.state,'acknowledged');
  const newTask=second.service.state().chatTasks!.find(row=>row.threadId===freshThread);assert.ok(newTask);assert.notEqual(newTask.taskId,oldOrigin.taskId);
  const turns=(await wire()).filter(row=>row.method==='turn/start');assert.equal(turns.length,2);assert.deepEqual(turns.map(row=>row.process),[1,2]);
  const policy=turns[1]!.params?.sandboxPolicy as {type:string;writableRoots:string[];networkAccess:boolean;excludeTmpdirEnvVar:boolean;excludeSlashTmp:boolean};
  assert.deepEqual(policy,{type:'workspaceWrite',writableRoots:[project],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true});
  assert.equal(Object.hasOwn(turns[1]!.params!,'allowAssets'),false);assert.equal(Object.hasOwn(turns[1]!.params!,'allowWorkspaceWrites'),false);
  await assert.rejects(clients[2]!.continueTask({continuation:originalToken,text:'Must not borrow old continuation'}),error=>error instanceof CodexClientError&&error.code==='TASK_SCOPE');
  assert.equal((await second.post(input)).data.replayed,true);assert.equal((await wire()).filter(row=>row.method==='turn/start').length,2);
  unchanged();await second.close();unchanged();assert.equal(clients[2]!.snapshot().connected,false);
  const third=await open();unchanged();assert.equal(clients.length,3);
  assert.equal(third.service.state().nativeRecovery!.nativeReservations,3,'the new closed/reused owner adds no permanent recovery debt');
  assert.equal(third.service.state().nativeRecovery!.blockedThreadIds.includes(freshThread),false);
  assert.equal(third.service.state().chatTasks!.find(row=>row.taskId===oldOrigin.taskId)!.state,'unknown');
  assert.equal((await wire()).filter(row=>row.method==='thread/resume').length,0);await third.close();unchanged();
});
