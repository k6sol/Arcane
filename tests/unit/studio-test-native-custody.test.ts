import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {rmSync,mkdirSync,renameSync,rmdirSync} from 'node:fs';
import {join,relative,isAbsolute} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {CallToolRequestSchema,ListToolsRequestSchema,type CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import {StudioStore} from '../../packages/storage/src/studio-store.js';
import {workflowProjectIdentity} from '../../packages/storage/src/workflow-store.js';
import {reviewedTestTools} from '../../packages/studio-test-controller/src/index.js';
import {createStudioTestService,type NativeTestConnection} from '../../apps/daemon/src/studio-test-service.js';
import {createStudioTestNativeCustody,closeAfterStudioTestNativeConnectFailure,captureStudioTestNativeProject,type StudioTestNativeConnectAttempt} from '../../apps/daemon/src/studio-test-native-custody.js';
import {createStudioTestOwnedClose} from '../../apps/daemon/src/studio-test-owned-close.js';
import {openStudioTestReportStore} from '../../apps/daemon/src/studio-test-report-store.js';
import {makeFixtureDirectory,fixtureTempDirectory} from './windows-fixture-paths.js';

// Real SQLite, SDK in-memory peers and, explicitly marked below, fixed Node
// stdio children. None is a Roblox Studio/engine acceptance fixture.
const ARTIFACT='a'.repeat(64),STUDIO='custody-fixture-studio',NAME='Custody fixture',ACTOR='custody-agent';
const reply=(text:string):CallToolResult=>({content:[{type:'text',text}]});
const code=(expected:string)=>(error:unknown)=>error instanceof Error&&'code' in error&&error.code===expected;
function gate(){let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve;});return {pending,release};}
function database(t:TestContext){
  const root=makeFixtureDirectory('arcane-native-custody-'),directory=join(root,'store');
  const projectId=workflowProjectIdentity(root).projectId,store=new StudioStore({directory});
  let closed=false;const cleanup:(()=>void|Promise<void>)[]=[];
  t.after(async()=>{try{for(const action of cleanup)await action();}finally{if(!closed)store.close();const local=relative(fixtureTempDirectory(),root);assert.ok(!isAbsolute(local)&&!local.startsWith('..')&&local.startsWith('arcane-native-custody-'));rmSync(root,{recursive:true,force:true});}});
  return {root,directory,projectId,store,port:()=>store.bindNativeCustody(projectId,directory),beforeClose(action:()=>void|Promise<void>){cleanup.push(action);},close(){if(!closed){store.close();closed=true;}}};
}
function owner(f:ReturnType<typeof database>){
  const custody=createStudioTestNativeCustody(f.port());
  f.beforeClose(async()=>{try{await custody.close();}catch{/* Tests assert expected refusals in their body; cleanup cannot mint settlement. */}});
  return custody;
}
async function serviceFixture(t:TestContext){
  const db=database(t),reports=await openStudioTestReportStore({directory:join(db.root,'reports'),projectId:db.projectId,
    exclusiveWriter:()=>db.store.holdsWorkspaceLock(db.directory)});
  const grant=db.store.createGrant({allowedRoots:['Workspace','ServerStorage'],allowWrites:true});
  const pair=db.store.pair({code:grant.code,protocolVersion:1,identity:{clientSessionId:'custody-plugin',placeId:0,universeId:0,name:NAME,pluginVersion:'fixture'},capabilities:['scene.children']});
  let mode:'Edit'|'Play'='Edit',playEpoch=0,allowPlay=false,heartbeat:ReturnType<typeof setInterval>|undefined;
  const publish=()=>{db.store.authenticate(pair.sessionId,pair.token);return db.store.poll(pair.sessionId,{sessionId:pair.sessionId,clientLifetimeId:'custody-plugin',pluginArtifactHash:ARTIFACT,
    markerName:'ArcaneTestProof_custody',placeId:0,universeId:0,placeName:NAME,mode,playEpoch,continuitySupported:true,connected:true});};
  publish();
  let connects=0,closes=0,effects=0,connectFailure:unknown=null,closeFailure:unknown=null,heldClose:number|null=null;
  const closeEntered=gate(),releaseClose=gate(),releaseConnect=gate(),connectEntered=gate();
  let holdConnect=false,serviceClosed=false;
  const connect=async():Promise<NativeTestConnection>=>{
    const index=++connects;connectEntered.release();
    if(holdConnect)await releaseConnect.pending;
    if(connectFailure!==null)throw connectFailure;
    const [a,b]=InMemoryTransport.createLinkedPair(),client=new Client({name:'custody-fixture',version:'1'},{capabilities:{}}),server=new Server({name:'fixture-not-RobloxStudio',version:'1'},{capabilities:{tools:{}}});
    server.setRequestHandler(ListToolsRequestSchema,()=>({tools:structuredClone([...reviewedTestTools])}));
    server.setRequestHandler(CallToolRequestSchema,request=>{
      const name=request.params.name;
      if(name==='list_roblox_studios')return reply(JSON.stringify({studios:[{id:STUDIO,name:NAME}]}));
      if(name==='get_studio_state')return reply(mode==='Edit'?'- Current Studio Mode: Edit\n- Available DataModels: Edit\n- Focused DataModel in the viewport: Edit':'- Current Studio Mode: Play\n- Available DataModels: Client, Server\n- Focused DataModel in the viewport: Client');
      if(name==='get_console_output')return reply('');
      assert.ok(allowPlay,'This case never authorizes effects.');assert.equal(name,'start_stop_play');
      assert.equal(typeof request.params.arguments?.is_start,'boolean');effects++;
      mode=request.params.arguments?.is_start?'Play':'Edit';playEpoch++;publish();return reply('controlled fixture acknowledgement');
    });
    await server.connect(b);await client.connect(a);
    let closing:Promise<void>|null=null;
    const connection:NativeTestConnection={client,evidence:'fixture',async witness(){publish();return {placeId:0,universeId:0,placeName:NAME,sessionId:pair.sessionId,clientLifetimeId:'custody-plugin',pluginArtifactHash:ARTIFACT};},
      close(){return closing??=(async()=>{closes++;if(heldClose===index){closeEntered.release();await releaseClose.pending;}await client.close();await server.close();if(closeFailure!==null)throw closeFailure;})();}};
    return connection;
  };
  const service=await createStudioTestService({directory:join(db.root,'service'),store:db.store,pluginArtifactHash:ARTIFACT,custody:db.port(),connect,reports});
  const request={sessionId:pair.sessionId,nativeStudioId:STUDIO,durationMs:5000,observationIntervalMs:1000,failOnRuntimeError:true};
  db.beforeClose(async()=>{clearInterval(heartbeat);releaseConnect.release();releaseClose.release();try{if(!serviceClosed)await service.lifecycle.close();}finally{reports.close();}});
  return {db,reports,service,request,publish,closeEntered,connectEntered,releaseClose,releaseConnect,
    counters:()=>({connects,closes,effects}),holdClose(index:number){heldClose=index;},holdConnect(){holdConnect=true;},
    enablePlay(){allowPlay=true;heartbeat=setInterval(publish,250);},
    failConnect(error:unknown){connectFailure=error;},failClose(error:unknown){closeFailure=error;},
    async shutdown(expected?:(error:unknown)=>boolean){try{if(expected)await assert.rejects(service.lifecycle.close(),expected);else await service.lifecycle.close();}finally{serviceClosed=true;}}};
}

test('actual service holds close custody after visible cancellation and blocks every new connector',{timeout:30000},async t=>{
  const f=await serviceFixture(t),job=await f.service.requests.prepare(f.request,ACTOR);f.holdClose(1);
  const cancelled=f.service.requests.cancel(job.id,ACTOR);
  await assert.rejects(f.service.requests.prepare(f.request,ACTOR),code('BUSY'),'The closing hold starts before controller cleanup awaits.');
  await f.closeEntered.pending;
  assert.equal(f.service.requests.status(job.id,ACTOR).state,'cancelled');
  await assert.rejects(f.service.requests.prepare(f.request,ACTOR),code('BUSY'));
  await assert.rejects(f.service.requests.viewport!({sessionId:f.request.sessionId},ACTOR),code('BUSY'));
  await assert.rejects(f.service.requests.nativeAssets!.search({sessionId:f.request.sessionId,query:'wind',category:'Audio'},ACTOR),code('BUSY'));
  assert.deepEqual(f.counters(),{connects:1,closes:1,effects:0});
  f.releaseClose.release();await cancelled;
  const next=await f.service.requests.prepare(f.request,ACTOR);assert.notEqual(next.id,job.id);
  await f.service.requests.cancel(next.id,ACTOR);await f.shutdown();
});

test('actual complete Play cleanup cannot admit a new job while original SDK close is held',{timeout:30000},async t=>{
  const f=await serviceFixture(t);f.enablePlay();const job=await f.service.requests.prepare(f.request,ACTOR);f.holdClose(1);
  await f.service.humanControl.approve({id:job.id,displayDigest:job.displayDigest},()=>{});await f.closeEntered.pending;
  const complete=f.service.requests.status(job.id,ACTOR);assert.equal(complete.state,'complete');assert.equal(complete.review.cleanup,'complete');
  assert.equal(f.counters().effects,2);await assert.rejects(f.service.requests.prepare(f.request,ACTOR),code('BUSY'));
  f.releaseClose.release();await f.service.requests.cancel(job.id,ACTOR);await f.shutdown();
});

test('older preparation cannot approve while another viewport connection is closing',{timeout:30000},async t=>{
  const f=await serviceFixture(t),job=await f.service.requests.prepare(f.request,ACTOR);f.holdClose(2);
  // A definite inventory mismatch reaches the real viewport finally/close path.
  const viewport=f.service.requests.viewport!({sessionId:f.request.sessionId,nativeStudioId:'missing-studio'},ACTOR);
  const refused=assert.rejects(viewport,code('BINDING_CHANGED'));await f.closeEntered.pending;
  await assert.rejects(f.service.humanControl.approve({id:job.id,displayDigest:job.displayDigest},()=>{}),code('BUSY'));
  assert.equal(f.counters().effects,0);f.releaseClose.release();await refused;
  await f.service.requests.cancel(job.id,ACTOR);await f.shutdown();
});

test('service close failure keeps reports readable and survives actual store reopen',{timeout:30000},async t=>{
  const f=await serviceFixture(t),job=await f.service.requests.prepare(f.request,ACTOR),original=new Error('controlled close refusal');f.failClose(original);
  await assert.rejects(f.service.requests.cancel(job.id,ACTOR),error=>error===original);
  await assert.rejects(f.service.requests.prepare(f.request,ACTOR),code('SDK_CUSTODY_UNCONFIRMED'));
  assert.equal(f.service.requests.list(ACTOR)[0]?.id,job.id);
  const saved=f.reports.get(job.id,()=>{});assert.ok(saved);assert.equal(saved.jobId,job.id);
  await f.shutdown(error=>error===original);f.db.close();
  const reopened=new StudioStore({directory:f.db.directory});
  try{assert.throws(()=>{reopened.bindNativeCustody(f.db.projectId,f.db.directory).assertReady();},code('SDK_CUSTODY_UNCONFIRMED'));}
  finally{reopened.close();}
});

test('opaque failed initialization preserves original error and cannot imply no-start',{timeout:30000},async t=>{
  const f=await serviceFixture(t),original=new Error('controlled rejected connector');f.failConnect(original);
  await assert.rejects(f.service.requests.prepare(f.request,ACTOR),error=>error===original);
  await assert.rejects(f.service.requests.viewport!({sessionId:f.request.sessionId},ACTOR),code('SDK_CUSTODY_UNCONFIRMED'));
  assert.deepEqual(f.counters(),{connects:1,closes:0,effects:0});await f.shutdown(code('SDK_CUSTODY_UNCONFIRMED'));
});

test('held original connector is fenced on shutdown and its late result is closed once',{timeout:30000},async t=>{
  const f=await serviceFixture(t);f.holdConnect();
  const preparing=f.service.requests.prepare(f.request,ACTOR),refused=assert.rejects(preparing,code('SDK_CUSTODY_UNCONFIRMED'));
  await f.connectEntered.pending;const shutdown=f.shutdown();f.releaseConnect.release();await refused;await shutdown;
  assert.deepEqual(f.counters(),{connects:1,closes:1,effects:0});
});

test('missing custody refuses native admission without fabricating a project binding',{timeout:30000},async t=>{
  const f=database(t);let called=0;
  const service=await createStudioTestService({directory:join(f.root,'missing'),store:f.store,pluginArtifactHash:ARTIFACT,connect:async()=>{called++;throw new Error('must not run');}});
  assert.deepEqual(service.requests.list(ACTOR),[]);
  await assert.rejects(service.requests.prepare({},ACTOR),code('SDK_CUSTODY_UNCONFIRMED'));assert.equal(called,0);
  await service.lifecycle.close();
});

test('definite no-start and all operation kinds reuse only settled fixture custody',{timeout:30000},async t=>{
  const f=database(t),custody=owner(f),original=new Error('controlled pre-connect discovery absence');
  await assert.rejects(custody.connect('viewport','native',async attempt=>{attempt.noStart();throw original;}),error=>error===original);
  custody.assertReady();
  for(const operation of ['playtest-prepare','viewport','playtest-revalidate','asset-search','asset-insert','asset-job'] as const){
    const client=new Client({name:'unused-fixture',version:'1'},{capabilities:{}});let closes=0;
    const connection=await custody.connect(operation,'fixture',async()=>({client,evidence:'fixture',async witness(){assert.fail('No native witness requested.');},async close(){closes++;}}));
    custody.assertConnection(connection);await connection.close();await connection.close();assert.equal(closes,1);
  }
  await custody.close();
  // A fresh port after retirement cannot adopt old tickets, but all these rows settled.
  f.port().assertReady();
});

test('global opening gate protects an older connection without self-fencing its own factory',{timeout:30000},async t=>{
  const f=database(t),custody=owner(f),client=new Client({name:'unused',version:'1'},{capabilities:{}});
  const make=async():Promise<NativeTestConnection>=>({client,evidence:'fixture',async witness(){assert.fail();},async close(){}});
  const old=await custody.connect('playtest-prepare','fixture',make),entered=gate(),release=gate();
  const pending=custody.connect('playtest-revalidate','fixture',async attempt=>{attempt.assertCurrent();entered.release();await release.pending;attempt.assertCurrent();return make();});
  await entered.pending;assert.throws(()=>custody.assertConnection(old),code('BUSY'));release.release();
  const next=await pending;custody.assertConnection(old);await next.close();await old.close();await custody.close();
});

// Actual fixed SDK stdio peer, not Studio. Physical onclose is observed from the
// original owned child; no authored audit/exit field is used as close proof.
const CHILD=`const readline=require('node:readline');const lines=readline.createInterface({input:process.stdin,crlfDelay:Infinity});lines.on('line',line=>{const r=JSON.parse(line);if(r.method==='initialize')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result:{protocolVersion:process.argv[1]==='invalid'?'unsupported-fixture-version':r.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixed-custody-node-peer',version:'1'}}})+'\\n');});lines.on('close',()=>process.exit(0));`;
async function child(attempt:StudioTestNativeConnectAttempt,mode:'ready'|'invalid',afterClose?:()=>void){
  const transport=new StdioClientTransport({command:process.execPath,args:['-e',CHILD,mode],stderr:'ignore'}),client=new Client({name:'custody-controlled-child',version:'1'},{capabilities:{}});
  const owned=createStudioTestOwnedClose(client,transport);attempt.observePhysicalClose(owned.physicalClosed);attempt.launchAttempted();
  const finalClose={physicalClosed:owned.physicalClosed,async close(){await owned.close();afterClose?.();}};
  try{await client.connect(transport,{timeout:10000,maxTotalTimeout:10000});}
  catch(error){return closeAfterStudioTestNativeConnectFailure(attempt,finalClose,error);}
  const connection:NativeTestConnection={client,evidence:'native',async witness(){assert.fail('A Node process cannot prove a Studio binding.');},close:()=>finalClose.close()};
  return connection;
}
test('actual SDK physical close persists, but a later original close rejection keeps current service fenced',{timeout:30000},async t=>{
  const f=database(t),custody=owner(f),original=new Error('controlled post-physical close failure');
  const connection=await custody.connect('viewport','native',attempt=>child(attempt,'ready',()=>{throw original;}));
  await assert.rejects(connection.close(),error=>error===original);
  assert.throws(()=>custody.assertReady(),code('SDK_CUSTODY_UNCONFIRMED'));
  await assert.rejects(custody.close(),code('SDK_CUSTODY_UNCONFIRMED'));
  // Current port stays sticky; a new owner can see actual durable physical settlement.
  f.port().assertReady();
});
test('actual SDK failed initialize preserves its error when post-physical cleanup also rejects',{timeout:30000},async t=>{
  const f=database(t),custody=owner(f),closeError=new Error('controlled failed-init cleanup rejection');let original:unknown;
  await assert.rejects(custody.connect('playtest-prepare','native',async attempt=>{
    try{return await child(attempt,'invalid',()=>{throw closeError;});}catch(error){original=error;throw error;}
  }),error=>error===original);
  assert.ok(original instanceof Error);assert.notStrictEqual(original,closeError);
  assert.throws(()=>custody.assertReady(),code('SDK_CUSTODY_UNCONFIRMED'));await assert.rejects(custody.close(),code('SDK_CUSTODY_UNCONFIRMED'));
  f.port().assertReady();
});
test('actual SDK failed initialize uses original cleanup helper and can settle only its real child close',{timeout:30000},async t=>{
  const f=database(t),custody=owner(f);let original:unknown;
  await assert.rejects(custody.connect('playtest-prepare','native',async attempt=>{
    try{return await child(attempt,'invalid');}catch(error){original=error;throw error;}
  }),error=>error===original);
  assert.ok(original instanceof Error);custody.assertReady();await custody.close();f.port().assertReady();
});

test('actual project directory replacement and ABA fence effects but preserve original physical settlement',{timeout:30000},async t=>{
  const f=database(t),project=join(f.root,'project'),away=join(f.root,'original-project');mkdirSync(project);
  const captured=captureStudioTestNativeProject(project),port=f.store.bindNativeCustody(captured.projectId,f.directory),custody=createStudioTestNativeCustody(port,captured.assertCurrent);
  f.beforeClose(async()=>{try{await custody.close();}catch{/* Original scope loss remains a refusal. */}});
  const connection=await custody.connect('viewport','native',attempt=>child(attempt,'ready'));
  renameSync(project,away);mkdirSync(project);
  assert.throws(()=>custody.assertConnection(connection),code('SDK_CUSTODY_UNCONFIRMED'));
  rmdirSync(project);renameSync(away,project);
  assert.throws(captured.assertCurrent,code('SDK_CUSTODY_UNCONFIRMED'),'Restoring the old inode cannot re-arm this captured epoch.');
  await connection.close();await assert.rejects(custody.close(),code('SDK_CUSTODY_UNCONFIRMED'));
  f.store.bindNativeCustody(captured.projectId,f.directory).assertReady();
});
