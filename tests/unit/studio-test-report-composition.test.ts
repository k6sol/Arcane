import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {copyFileSync,existsSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {request as httpRequest} from 'node:http';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {CallToolRequestSchema,ListToolsRequestSchema,type CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import {createConnectionLab} from '../../apps/daemon/src/lab-server.js';
import type {CodexService} from '../../apps/daemon/src/codex-service.js';
import type {NativeTestConnection} from '../../apps/daemon/src/studio-test-service.js';
import {studioImportPluginArtifactHash} from '../../apps/daemon/src/studio-import-plugin-artifact.js';
import {openStudioTestReportStore} from '../../apps/daemon/src/studio-test-report-store.js';
import {STUDIO_PLUGIN_SOURCES} from '../../packages/protocol/src/studio-plugin-artifact.js';
import {StudioStore} from '../../packages/storage/src/studio-store.js';
import {reviewedTestTools} from '../../packages/studio-test-controller/src/index.js';
import {workflowProjectIdentity} from '../../packages/storage/src/workflow-store.js';
import {fixtureTempDirectory,makeFixtureDirectory} from './windows-fixture-paths.js';

// Actual owned lab composition/service/controller, SQLite and loopback HTTP.
// SDK peers and plugin heartbeats are synthetic; no native Studio/provider runs.
type Lab=Awaited<ReturnType<typeof createConnectionLab>>;
const NATIVE='history-fixture-native',MARKER='ArcaneTestProof_history_composition';
const text=(value:string):CallToolResult=>({content:[{type:'text',text:value}]});
async function fixture(t:TestContext,options:{siblingWorkspace?:boolean}={}){
  const root=makeFixtureDirectory('arcane-report-composition-'),resources=join(root,'resources');
  const storeDirectory=options.siblingWorkspace?join(root,'runtime','product'):root,state=options.siblingWorkspace?join(root,'runtime','connection-lab'):join(root,'lab');
  mkdirSync(join(resources,'plugin','build'),{recursive:true});mkdirSync(join(resources,'plugin','src'));mkdirSync(state,{recursive:true});
  for(const file of ['manifest.json','ArcaneLocalBridge.rbxmx'])copyFileSync(resolve('plugin','build',file),join(resources,'plugin','build',file));
  for(const[,,file]of STUDIO_PLUGIN_SOURCES)copyFileSync(resolve('plugin','src',file),join(resources,'plugin','src',file));
  const store=new StudioStore({directory:storeDirectory}),labs:Lab[]=[],connections:NativeTestConnection[]=[];
  const stats={connects:0,closes:0,providerActions:0,providerCloses:0,calls:[] as string[]};let failClose=false;
  const grant=store.createGrant({allowedRoots:['Workspace','ServerStorage'],allowWrites:true}),pair=store.pair({code:grant.code,protocolVersion:1,identity:{clientSessionId:'history-fixture-lifetime',placeId:0,universeId:0,name:'History disposable fixture',pluginVersion:'fixture-only'},capabilities:['scene.children']});
  const artifact=await studioImportPluginArtifactHash(resources);
  const publish=()=>{store.authenticate(pair.sessionId,pair.token);assert.deepEqual(store.poll(pair.sessionId,{sessionId:pair.sessionId,clientLifetimeId:'history-fixture-lifetime',pluginArtifactHash:artifact,markerName:MARKER,placeId:0,universeId:0,placeName:'History disposable fixture',mode:'Edit',playEpoch:0,continuitySupported:true,connected:true}),[]);};
  const codex:CodexService={state:()=>({provider:'codex',use:'personal-local',projectPath:root,connecting:false,closing:false,busy:false,snapshot:null,lastSnapshot:null,actions:[],nativeTools:{configured:false,verified:false}}),async action(){stats.providerActions++;throw Error('No provider actions in composition fixture');},async close(){stats.providerCloses++;}};
  const connect=async():Promise<NativeTestConnection>=>{
    stats.connects++;const[clientTransport,serverTransport]=InMemoryTransport.createLinkedPair(),client=new Client({name:'history-fixture',version:'fixture-only'},{capabilities:{}}),server=new Server({name:'synthetic-not-Studio',version:'fixture-only'},{capabilities:{tools:{}}});
    server.setRequestHandler(ListToolsRequestSchema,()=>({tools:structuredClone([...reviewedTestTools])}));
    server.setRequestHandler(CallToolRequestSchema,request=>{const name=request.params.name,args=request.params.arguments??{};stats.calls.push(name);
      if(name==='list_roblox_studios'){assert.deepEqual(args,{});return text(JSON.stringify({studios:[{id:NATIVE,name:'History disposable fixture'}]}));}
      assert.equal(args.studio_id,NATIVE);assert.ok(name==='get_studio_state'||name==='get_console_output','No Play or other effect is authorized by this fixture');
      return text(name==='get_studio_state'?'- Current Studio Mode: Edit\n- Available DataModels: Edit\n- Focused DataModel in the viewport: Edit':'');});
    await server.connect(serverTransport);await client.connect(clientTransport);let closed=false;
    const connection:NativeTestConnection={client,evidence:'fixture',async witness(studioId,marker,mode,signal){assert.equal(studioId,NATIVE);assert.equal(marker,MARKER);assert.equal(mode,'Edit');signal.throwIfAborted();const session=store.session(pair.sessionId);return{placeId:0,universeId:0,placeName:session.name,sessionId:session.id,clientLifetimeId:session.clientSessionId,pluginArtifactHash:artifact};},async close(){if(closed)return;closed=true;stats.closes++;await client.close();await server.close();if(failClose)throw Error('synthetic-original-close-failure');}};
    connections.push(connection);return connection;
  };
  const start=async(overrides:Partial<Parameters<typeof createConnectionLab>[0]>={})=>{const app=await createConnectionLab({cwd:resources,projectPath:root,stateDirectory:state,studioStore:store,codexService:codex,probe:async()=>[],studioTestConnect:connect,...overrides});labs.push(app);return app;};
  t.after(async()=>{failClose=false;for(const app of labs)try{await app.close();}catch{}for(const connection of connections)await connection.close();store.close();const tail=relative(fixtureTempDirectory(),root);assert.ok(!isAbsolute(tail)&&!tail.startsWith('..')&&tail.startsWith('arcane-report-composition-'));rmSync(root,{recursive:true,force:true});});
  return{root,resources,state,storeDirectory,store,pair,stats,start,publish,setCloseFailure(){failClose=true;},projectId:workflowProjectIdentity(root).projectId};
}
function call(app:Lab,path:string,options:{agent?:boolean;token?:string;body?:unknown}={}){
  return new Promise<{status:number;bytes:Buffer;json:Record<string,unknown>}>((resolve,reject)=>{
    const request=httpRequest(app.origin+path,{method:options.body===undefined?'GET':'POST',agent:false,headers:{Authorization:'Bearer '+(options.token??(options.agent?app.agentToken:app.token)),...(options.body===undefined?{}:{'Content-Type':'application/json'})}},response=>{const chunks:Buffer[]=[];response.on('data',chunk=>chunks.push(Buffer.from(chunk)));response.once('error',reject);response.once('end',()=>{const bytes=Buffer.concat(chunks);resolve({status:response.statusCode!,bytes,json:JSON.parse(bytes.toString())});});});request.once('error',reject);request.end(options.body===undefined?undefined:JSON.stringify(options.body));
  });
}
async function prepare(f:Awaited<ReturnType<typeof fixture>>,app:Lab){f.publish();const result=await call(app,'/v1/playtests/prepare',{body:{sessionId:f.pair.sessionId,nativeStudioId:NATIVE,durationMs:5000,observationIntervalMs:1000,failOnRuntimeError:true}});assert.equal(result.status,200,JSON.stringify(result.json));const value=result.json.job;assert.ok(value&&typeof value==='object'&&'id'in value&&typeof value.id==='string');return value.id;}

function historical(reply:Awaited<ReturnType<typeof call>>){assert.equal(reply.status,200);const report=reply.json.report;assert.ok(report&&typeof report==='object'&&'jobId'in report&&'snapshot'in report);return report;}

test('actual owned lab prepares and archives service output across daemon close/reopen without a new native connection',async t=>{
  const f=await fixture(t),app=await f.start(),jobId=await prepare(f,app);
  const admitted=historical(await call(app,'/v1/playtests/history/report?id='+jobId));assert.equal(admitted.jobId,jobId);assert.equal(admitted.snapshot,'admission');
  const oldToken=app.token,connects=f.stats.connects;await app.close();assert.equal(f.stats.closes,1);
  const reopened=await f.start(),saved=await call(reopened,'/v1/playtests/history/report?id='+jobId),final=historical(saved);assert.equal(final.jobId,jobId);assert.equal(final.snapshot,'terminal');assert.equal(saved.json.projectId,f.projectId);assert.equal(saved.json.currentSource,'unobserved');assert.equal(saved.json.readOnly,true);assert.equal(f.stats.connects,connects);
  assert.equal((await call(reopened,'/v1/playtests/history',{token:oldToken})).status,401);assert.equal((await call(reopened,'/v1/playtests/history',{agent:true})).status,403);assert.equal(f.stats.providerActions,0);assert.ok(f.stats.calls.every(name=>name!=='start_stop_play'));
});

test('actual retained reports remain readable while the independent live safety ledger is FENCED',async t=>{
  const f=await fixture(t),app=await f.start(),jobId=await prepare(f,app);await app.close();
  const lock=join(f.state,'playtests','ledger','writer.lock');writeFileSync(lock,'synthetic-retained-writer-fence');const retained=readFileSync(lock),connects=f.stats.connects;
  const reopened=await f.start(),live=await call(reopened,'/v1/playtests',{agent:true});assert.equal(live.status,409);assert.equal(live.json.error,'FENCED');
  const page=await call(reopened,'/v1/playtests/history');assert.equal(page.status,200);assert.deepEqual(page.json.archive,{state:'ready',code:null});assert.equal(historical(await call(reopened,'/v1/playtests/history/report?id='+jobId)).jobId,jobId);assert.equal(f.stats.connects,connects);
  await reopened.close();assert.deepEqual(readFileSync(lock),retained);
});

test('wrong project archive cannot be relabelled or reset by the actual lab composition',async t=>{
  const f=await fixture(t),app=await f.start(),jobId=await prepare(f,app);await app.close();
  const database=join(f.state,'playtest-reports','reports.sqlite'),before=readFileSync(database),other=join(f.root,'other-project');mkdirSync(other);
  const foreign=await f.start({projectPath:other}),page=await call(foreign,'/v1/playtests/history');assert.equal(page.status,200);assert.deepEqual(page.json.archive,{state:'unavailable',code:'ARCHIVE_UNAVAILABLE'});assert.deepEqual(page.json.reports,[]);assert.equal(page.json.projectId,workflowProjectIdentity(other).projectId);
  assert.equal((await call(foreign,'/v1/playtests/history/report?id='+jobId)).status,503);
  const cursor=await call(foreign,'/v1/playtests/history?cursor='+encodeURIComponent('1.'+f.projectId+'.1'));assert.notEqual(cursor.status,200,'Unavailable fallback must not silently follow or reset a prior/foreign anchor');
  await foreign.close();assert.deepEqual(readFileSync(database),before);const original=await f.start();assert.equal(historical(await call(original,'/v1/playtests/history/report?id='+jobId)).jobId,jobId);
});

test('owned archive still closes and retains actual terminal observation when native connection close fails',async t=>{
  const f=await fixture(t),app=await f.start(),jobId=await prepare(f,app);f.setCloseFailure();await assert.rejects(app.close(),{code:'CLEANUP'});
  const reopened=await f.start();assert.equal(historical(await call(reopened,'/v1/playtests/history/report?id='+jobId)).snapshot,'terminal');assert.equal(f.stats.providerActions,0);
});

test('initialization failure after opening reports releases its actual archive owner',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.start({assetReviewHostFactory:()=>{throw Error('unreachable factory');}}),{code:'ASSET_REVIEW_CONFIGURATION'});
  const reopened=await openStudioTestReportStore({directory:join(f.state,'playtest-reports'),projectId:f.projectId,exclusiveWriter:()=>true});try{assert.equal(reopened.list({cursor:null},()=>{}).reports.length,0);}finally{reopened.close();}
  assert.equal(f.stats.connects,0);assert.equal(f.stats.providerActions,0);
});

test('daemon shutdown invalidates a real in-flight historical store read before response delivery',async t=>{
  const f=await fixture(t),app=await f.start(),jobId=await prepare(f,app);await app.close();
  const reference=await openStudioTestReportStore({directory:join(f.state,'playtest-reports'),projectId:f.projectId,exclusiveWriter:()=>true}),prototype=Object.getPrototypeOf(reference),original=reference.get;reference.close();
  const reopened=await f.start();let closing:Promise<void>|undefined,reads=0;
  const mock=t.mock.method(prototype,'get',function(this:typeof reference,...args:Parameters<typeof original>){reads++;closing=reopened.close();return original.apply(this,args);});
  try{const result=await call(reopened,'/v1/playtests/history/report?id='+jobId).catch(()=>null);assert.ok(result===null||result.status!==200);assert.equal(reads,1);assert.ok(closing);await closing;}finally{mock.mock.restore();}
});

// Actual SQLite/LAB composition with the preserved default-product sibling paths.
// The SDK peer is synthetic and never starts Studio; source wiring below is not native proof.
test('trusted original workspace enables legacy sibling admission and independent retained history without moving data',async t=>{
  const f=await fixture(t,{siblingWorkspace:true}),options={studioWorkspaceDirectory:f.storeDirectory};
  const app=await f.start(options),jobId=await prepare(f,app);assert.equal(f.stats.connects,1);
  assert.ok(existsSync(join(f.storeDirectory,'studio.sqlite')));
  assert.ok(existsSync(join(f.state,'playtest-reports','reports.sqlite')));
  assert.equal(existsSync(join(f.storeDirectory,'connection-lab')),false);
  await app.close();assert.equal(f.stats.closes,1);
  const lock=join(f.state,'playtests','ledger','writer.lock');writeFileSync(lock,'synthetic-retained-writer-fence');const retained=readFileSync(lock);
  const reopened=await f.start(options),live=await call(reopened,'/v1/playtests',{agent:true});assert.equal(live.status,409);assert.equal(live.json.error,'FENCED');
  const page=await call(reopened,'/v1/playtests/history');assert.equal(page.status,200);assert.deepEqual(page.json.archive,{state:'ready',code:null});
  assert.equal(historical(await call(reopened,'/v1/playtests/history/report?id='+jobId)).jobId,jobId);assert.equal(f.stats.connects,1);
  await reopened.close();assert.deepEqual(readFileSync(lock),retained);assert.equal(existsSync(join(f.storeDirectory,'connection-lab')),false);
});

test('absent sibling workspace and explicit foreign workspace refuse without fallback or SDK effects',async t=>{
  for(const siblingWorkspace of [true,false]){
    const f=await fixture(t,{siblingWorkspace}),foreign=join(f.root,'foreign-workspace');mkdirSync(foreign);
    const app=await f.start(siblingWorkspace?{}:{studioWorkspaceDirectory:foreign});
    const live=await call(app,'/v1/playtests',{agent:true});assert.equal(live.status,409);assert.equal(live.json.error,'SDK_CUSTODY_UNCONFIRMED');
    const page=await call(app,'/v1/playtests/history');assert.equal(page.status,200);assert.deepEqual(page.json.archive,{state:'unavailable',code:'ARCHIVE_UNAVAILABLE'});
    assert.equal(f.stats.connects,0);assert.equal(f.stats.closes,0);assert.equal(f.stats.providerActions,0);
    await app.close();
  }
});
