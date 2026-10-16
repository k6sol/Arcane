import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,realpathSync,lstatSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute,sep,resolve} from 'node:path';
import {createNativeAssetRegistry} from '../../apps/daemon/src/native-asset-authority.js';
import {createAssetConversationHost} from '../../apps/daemon/src/asset-conversation-host.js';
import {nativeAssetRoutes} from '../../apps/daemon/src/native-asset-routes.js';
import {assetRoutes} from '../../apps/daemon/src/asset-routes.js';
import {createCodexService,type CodexHostClient} from '../../apps/daemon/src/codex-service.js';
import {codexRoutes} from '../../apps/daemon/src/codex-routes.js';
import {ConversationWorkStore} from '../../packages/storage/src/conversation-work-store.js';
import {normalizeRequest} from '../../packages/asset-pipeline/src/validation.js';
import type {Snapshot,NativeAssetHooks} from '../../packages/codex-client/src/index.js';
import type {AssetService,AssetJobRecord,AssetStartAdmission} from '../../apps/daemon/src/asset-service.js';
import {DaemonClient} from '../../apps/mcp/src/daemon-client.js';

// Actual SQLite journal/binding store + owned HTTP/SDK clients. The provider and
// asset runtime are explicit doubles; this is NOT installed-native verification.
async function fixture(t:test.TestContext) {
 const boundary=realpathSync(tmpdir()),root=mkdtempSync(join(boundary,'arcane-native-assets-http-')),project=join(root,'project');mkdirSync(project);
 const registry=createNativeAssetRegistry({projectPath:project}),store=new ConversationWorkStore({directory:join(root,'bindings'),projectPath:project});
 const connectionId=randomUUID(),threadId='owned-fixture-thread';let hooks:NativeAssetHooks|undefined,credential='',starts=0,cancels=0,hold:Promise<void>|null=null;
 let release:()=>void=()=>{};const jobs:AssetJobRecord[]=[];
 const snapshot:Snapshot={connectionId,provenance:'spawned-node-fixture',mcpIsolation:'arcane-only-verified',connected:true,ready:true,account:{auth:'subscription',plan:null,requiresOpenaiAuth:true},models:[],selection:null,thread:null,operations:[],approvals:[],events:[],droppedEvents:0,lastEventSeq:0,failureCode:null};
 const client:CodexHostClient={snapshot:()=>structuredClone(snapshot),selectModel:()=>({model:'fixture',effort:'low'}),
  async startThread(){snapshot.thread={threadId,sessionId:null,selection:{model:'fixture',effort:'low'},configured:true,writeGranted:false,turnId:null,turnStatus:'idle'};return structuredClone(snapshot.thread);},
  async resumeThread(){return this.startThread({initiatedBy:'human'});},grantThreadWrites(){throw Error('Not an asset grant');},revokeThreadWrites(){},
  async startTurn(){if(!snapshot.thread)throw Error('No thread');const operationId=randomUUID();hooks!.dispatched({connectionId,threadId,operationId});snapshot.thread.turnStatus='starting';hold=new Promise<void>(resolve=>release=resolve);await hold;snapshot.thread.turnId='fixture-turn';snapshot.thread.turnStatus='inProgress';return structuredClone(snapshot.thread);},
  async interruptTurn(){hooks!.retired();},respondApproval(){throw Error('Not an asset approval');},async close(){snapshot.connected=false;snapshot.ready=false;hooks?.retired();release();},};
 const codex=createCodexService({directory:join(root,'codex'),projectPath:project,assetRegistry:registry,nativeToolsConfigured:true,connect:async value=>{hooks=value;credential=value!.finalCredential();return client;}});
 const service={projectPath:project,jobs:()=>structuredClone(jobs),async start(input:unknown,admission?:AssetStartAdmission){admission?.beforeCreate();starts++;const id=randomUUID(),request=normalizeRequest(input);const job:AssetJobRecord={schemaVersion:1,jobId:id,directory:join(root,'assets',id),manifestPath:null,request,state:'running',stage:'starting',startedAt:new Date().toISOString(),updatedAt:new Date().toISOString(),events:[],manifestAvailable:false,error:null};jobs.push(job);admission?.created(id);return structuredClone(job);},async cancel(id:string){cancels++;const job=jobs.find(j=>j.jobId===id);if(!job)throw Error('missing');job.state='cancelled';return structuredClone(job);},async manifest(){throw Error('No actual runtime manifest');},async probe(){return {observedAt:new Date().toISOString(),available:false,blender:null,python:null,attempts:[]};}} as unknown as AssetService;
 service.lookupJobs=async ids=>({jobs:structuredClone(jobs.filter(job=>ids.includes(job.jobId))),unavailable:ids.filter(id=>!jobs.some(job=>job.jobId===id)).map(jobId=>({jobId,status:'missing' as const}))});
 const host=createAssetConversationHost({projectPath:project,workAssociations:store,conversation:()=>snapshot.thread?{provider:'codex',threadId,sessionId:null}:null,start:async req=>(await service.start(req)).jobId,startNative:async(req,admission)=>(await service.start(req,admission)).jobId});
 const native=nativeAssetRoutes(service,host,registry),global=assetRoutes(service,host),actions=codexRoutes(codex);const human='fixture-control-'+randomUUID(),generic='fixture-global-'+randomUUID();let origin='';
 const server=createServer(async(request,response)=>{const url=new URL(request.url??'/',origin);try{if(await native(request,response,url,origin))return;if(await actions(request,response,url,human,origin,generic))return;if(await global(request,response,url,human,origin,generic))return;response.writeHead(404);response.end();}catch{response.writeHead(500);response.end();}});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
 const call=async(path:string,token=credential,input?:unknown,headers:Record<string,string>={})=>{const response=await fetch(origin+path,{method:input===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,...(input===undefined?{}:{'Content-Type':'application/json'}),...headers},...(input===undefined?{}:{body:JSON.stringify(input)}),signal:AbortSignal.timeout(8000)});const text=await response.text();return {status:response.status,data:text?JSON.parse(text) as Record<string,unknown>:null};};
 const action=async(action:string,extra:Record<string,unknown>={})=>call('/v1/codex/action',human,{requestId:randomUUID(),connectionId:action==='connect'?null:connectionId,action,...extra},{Origin:origin});
 t.after(async()=>{registry.close();release();await codex.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();const part=relative(boundary,resolve(root));assert.ok(part&&!isAbsolute(part)&&part!=='..'&&!part.startsWith('..'+sep));assert.ok(!lstatSync(root).isSymbolicLink());rmSync(root,{recursive:true,force:true});});
 return {root,registry,store,codex,service,origin,human,generic,threadId,connectionId,call,action,snapshot,release:()=>release(),get token(){return credential;},get starts(){return starts;},get cancels(){return cancels;},sdk:()=>new DaemonClient({url:origin,token:credential,assetAudience:'native-session'}),async ready(){assert.equal((await action('connect')).status,200);assert.equal((await action('thread-start')).status,200);}};
}

test('human durable seal/grant and pre-ACK native SDK start bind exactly once to the original chat',{timeout:15000},async t=>{
 const f=await fixture(t);await f.ready();assert.equal(f.codex.state().nativeAssets?.sealed,true);assert.equal(f.codex.state().nativeAssets?.granted,false);
 assert.equal((await f.call('/v1/assets/native/start',f.token,{template:'hero-prop',name:'ungranted'})).status,403);assert.equal(f.starts,0);
 assert.equal((await f.action('grant-assets',{threadId:f.threadId})).status,200);assert.equal(f.codex.state().nativeAssets?.granted,true);assert.equal(f.snapshot.thread?.writeGranted,false,'Asset grant is not native-file/Studio grant.');
 const pending=f.action('turn-start',{threadId:f.threadId,text:'Synthetic turn only'});const deadline=Date.now()+5000;while(!f.codex.state().nativeAssets?.admissionOpen&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,1));assert.equal(f.codex.state().nativeAssets?.admissionOpen,true,'Local dispatch must open within fixture deadline');
 for(const invalid of [{template:'unknown',name:'invalid'}, {template:'hero-prop',name:'invalid',actor:{role:'human'}}]) {
  assert.equal((await f.call('/v1/assets/native/start',f.token,invalid)).status,400);assert.equal(f.starts,0,'Invalid recipes cannot create or bind any asset.');
 }
 const started=await f.sdk().assetsStart({template:'hero-prop',name:'owned-chat-job'});assert.ok('jobId' in started);assert.equal((started as {association:string}).association,'bound');assert.equal(f.starts,1);assert.equal(f.codex.state().busy,true,'MCP start completes before synthetic turn ACK, without deadlock.');
 f.release();assert.equal((await pending).status,200);const page=await f.sdk().assetsJobs();assert.ok('conversation' in page);assert.equal((page as {jobs:unknown[]}).jobs.length,1);
 const row=f.store.binding('asset-job',(started as {jobId:string}).jobId)!;assert.equal(row.conversation.threadId,f.threadId);assert.equal(row.conversation.sessionId,null);
 assert.equal((await f.action('revoke-assets',{threadId:f.threadId})).status,200);assert.equal(f.codex.state().nativeAssets?.granted,false);
 assert.equal((await f.call('/v1/assets/native/start',f.token,{template:'hero-prop',name:'revoked'})).status,403);assert.equal(f.starts,1);
});
test('generic/human cannot forge native audience and native key cannot use global assets or human grant routes',async t=>{
 const f=await fixture(t);await f.ready();for(const key of [f.generic,f.human,'0'.repeat(64)])assert.equal((await f.call('/v1/assets/native/jobs',key)).status,403);
 assert.equal((await f.call('/v1/assets/start',f.token,{template:'hero-prop',name:'global-bypass'})).status,401);assert.equal(f.starts,0);
 assert.equal((await f.call('/v1/codex/action',f.token,{requestId:randomUUID(),connectionId:f.connectionId,action:'grant-assets',threadId:f.threadId},{Origin:f.origin})).status,401);
 assert.equal((await f.call('/v1/assets/native/jobs',f.token,undefined,{Origin:f.origin})).status,403);
 assert.equal((await f.action('grant-assets',{threadId:'foreign-thread'})).status,409);assert.equal(f.codex.state().nativeAssets?.granted,false);
});
test('read ownership never adopts global jobs and foreign cursors/identity fields disclose no metadata',async t=>{
 const f=await fixture(t);await f.ready();const global=await f.service.start({template:'hero-prop',name:'unscoped'});
 const page=await f.call('/v1/assets/native/jobs');assert.equal(page.status,200);assert.deepEqual(page.data?.jobs,[]);
 assert.equal((await f.call('/v1/assets/native/manifest?jobId='+global.jobId)).status,404);assert.equal((await f.call('/v1/assets/native/jobs?projectId=foreign')).status,400);
 assert.equal((await f.call('/v1/assets/native/jobs?after='+encodeURIComponent('f'.repeat(64)+':1'))).status,503);
});
test('disconnect retires original native captures and cannot rebind after a lost request/connection',async t=>{
 const f=await fixture(t);await f.ready();const old=f.token;assert.equal((await f.action('disconnect')).status,200);assert.equal(f.registry.recognizes(old),false);assert.equal((await f.call('/v1/assets/native/jobs',old)).status,403);assert.equal(f.starts,0);
});
