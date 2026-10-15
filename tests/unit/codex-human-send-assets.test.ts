import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute,sep} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createCodexService,type CodexActionOutcome} from '../../apps/daemon/src/codex-service.js';
import {codexRoutes} from '../../apps/daemon/src/codex-routes.js';
import {createNativeAssetRegistry,assertNativeAssetActor,type NativeAssetRegistry,type NativeAssetActor} from '../../apps/daemon/src/native-asset-authority.js';
import {CodexSession} from '../../packages/codex-client/src/session.js';
import {nativeEnvironment} from '../../packages/codex-client/src/transport.js';
import {limits} from '../../packages/codex-client/src/validation.js';
import {ARCANE_NATIVE_TOOL_NAMES,ARCANE_TOOL_NAMES} from '../../packages/protocol/src/arcane-tools.js';

const THREAD='send.thread:exact',SESSION='send.session:exact',denied={code:'NATIVE_ASSET_AUTHORITY'};
// Actual production CodexSession, registry, control route and SQLite. Only this
// Node JSONL peer substitutes for the provider. No CLI, inference or Studio.
const PEER=String.raw`
const {createInterface}=require('node:readline'),{appendFileSync}=require('node:fs');
const [encoded,audit]=process.argv.slice(1),scenario=JSON.parse(encoded);let checks=0,turns=0;
const send=value=>process.stdout.write(JSON.stringify(value)+'\n'),reply=(id,result)=>send({id,result});
createInterface({input:process.stdin}).on('line',line=>{
 const {id,method,params={}}=JSON.parse(line);appendFileSync(audit,JSON.stringify({method,params})+'\n');
 if(method==='initialized')return;
 if(method==='initialize')return reply(id,{});
 if(method==='account/read')return reply(id,{account:{type:'chatgpt',planType:'plus'},requiresOpenaiAuth:true});
 if(method==='model/list')return reply(id,{data:[{id:'fixture',model:'fixture',displayName:'Fixture',nativeAssets:true,
   allowAssets:true,assetAudience:'native-session',supportedReasoningEfforts:[{reasoningEffort:'low'}]}],nextCursor:null});
 if(method==='thread/start')return reply(id,{thread:{id:'send.thread:exact',sessionId:'send.session:exact',turns:[],status:{type:'idle'}},
   model:params.model,modelProvider:'openai',cwd:process.cwd(),approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:{type:'readOnly',networkAccess:false}});
 if(method==='mcpServerStatus/list'){
   checks++;let tools=scenario.tools;
   if(scenario.mode==='preflight-fail'&&checks>1)tools=tools.filter(name=>name!=='assets_start');
   const result={data:[{name:'arcane',runtimeStatus:'connected',toolsError:null,pluginId:null,tools:Object.fromEntries(tools.map(name=>[name,{}]))}],nextCursor:null};
   if(scenario.mode==='hold-preflight'&&checks>1)return setTimeout(()=>reply(id,result),200);
   return reply(id,result);
 }
 if(method==='turn/start'){
   turns++;const turn={id:'send.turn:'+turns,status:'inProgress'};
   if(scenario.mode==='reject-first'&&turns===1)return send({id,error:{code:-32602,message:'Synthetic rejection'}});
   if(scenario.mode==='unknown')return reply(id,{});
   if(scenario.mode==='disconnect')return process.exit(0);
   if(scenario.mode==='terminal-before-ack')send({method:'turn/completed',params:{threadId:'send.thread:exact',turn:{...turn,status:'completed'}}});
   if(scenario.mode==='terminal-ack')turn.status='completed';
   return reply(id,{turn});
 }
 if(method==='turn/interrupt')return reply(id,{});
 throw Error('Unexpected fixture method: '+method);
});
`;
type Wire={method:string;params:Record<string,unknown>};
async function fixture(t:test.TestContext,mode='normal',native=true){
 const boundary=await realpath(tmpdir()),root=await realpath(await mkdtemp(join(boundary,'arcane-human-send-'))),project=join(root,'project');await mkdir(project);
 const registry=createNativeAssetRegistry({projectPath:await realpath(project)}),dispatched:{operationId:string;granted:boolean;actor:NativeAssetActor|null}[]=[],ended:{id:string;granted:boolean}[]=[];
 let token='',client:CodexSession|undefined;
 const observedRegistry:NativeAssetRegistry=Object.freeze({...registry,issue(){
   const handle=registry.issue();return Object.freeze({...handle,
     dispatched(value:{connectionId:string;threadId:string;operationId:string}){handle.dispatched(value);let actor:NativeAssetActor|null=null;try{actor=registry.capture(token,'mutate');}catch{}
       dispatched.push({operationId:value.operationId,granted:handle.status().granted,actor});},
     ended(id:string){handle.ended(id);ended.push({id,granted:handle.status().granted});}});
 }});
 const audit=join(root,'wire.jsonl');
 const service=createCodexService({directory:join(root,'journal'),projectPath:project,...(native?{assetRegistry:observedRegistry}:{}),connect:async hooks=>{
   if(hooks){assert.deepEqual(Object.keys(hooks).sort(),['dispatched','ended','finalCredential','retired']);token=hooks.finalCredential();}
   client=new CodexSession({command:process.execPath,args:['-e',PEER,JSON.stringify({mode,tools:native?ARCANE_NATIVE_TOOL_NAMES:ARCANE_TOOL_NAMES}),audit],cwd:project,env:nativeEnvironment()},
     limits({requestTimeoutMs:5000}),'spawned-node-fixture','arcane-only',hooks);
   await client.initialize();return client;
 }});
 const control='human-'+randomUUID(),generic='generic-'+randomUUID(),route=codexRoutes(service);let origin='';
 const server=createServer(async(request,response)=>{if(!await route(request,response,new URL(request.url??'/',origin),control,origin,generic)){response.writeHead(404);response.end();}});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
 t.after(async()=>{registry.close();await service.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
   const part=relative(boundary,root);assert.ok(part.startsWith('arcane-human-send-')&&!isAbsolute(part)&&!part.includes(sep));await rm(root,{recursive:true,force:true});});
 const post=async(input:unknown,bearer=control,requestOrigin:string|null=origin)=>{
   const response=await fetch(origin+'/v1/codex/action',{method:'POST',headers:{Authorization:'Bearer '+bearer,'Content-Type':'application/json',...(requestOrigin===null?{}:{Origin:requestOrigin})},body:JSON.stringify(input),signal:AbortSignal.timeout(10000)});
   return {status:response.status,data:await response.json() as CodexActionOutcome&{error?:string}};
 };
 const action=(action:string,fields:Record<string,unknown>={})=>post({requestId:randomUUID(),connectionId:action==='connect'?null:service.state().snapshot!.connectionId,action,...fields});
 const ready=async()=>{assert.equal((await action('connect')).status,200);assert.equal((await action('select',{model:'fixture',effort:'low'})).status,200);assert.equal((await action('thread-start')).status,200);};
 const wire=async():Promise<Wire[]>=>(await readFile(audit,'utf8')).trim().split('\n').map(line=>JSON.parse(line) as Wire);
 return {service,registry,dispatched,ended,action,post,ready,wire,control,generic,origin,get token(){return token;},get client(){return client!;}};
}

test('human Send alone opens the exact actual native operation without workspace writes or provider flags',async t=>{
 const f=await fixture(t);await f.ready();assert.equal(f.service.state().nativeAssets?.granted,false);const old=f.registry.capture(f.token,'read');
 assert.throws(()=>f.registry.capture(f.token,'mutate'),denied);
 const sent=await f.action('turn-start',{threadId:THREAD,text:'Synthetic human Build Send',allowAssets:true});assert.equal(sent.status,200);
 assert.equal(f.dispatched.length,1);assert.equal(f.dispatched[0]!.granted,true);assert.ok(f.dispatched[0]!.actor);
 assert.throws(()=>assertNativeAssetActor(old,'mutate'),denied);assert.equal(sent.data.state.snapshot!.thread!.writeGranted,false);
 const turn=(await f.wire()).find(row=>row.method==='turn/start')!;
 assert.equal(turn.params.allowAssets,undefined);assert.equal(turn.params.nativeAssets,undefined);assert.equal(turn.params.nativeAssetHooks,undefined);
 assert.deepEqual(turn.params.sandboxPolicy,{type:'readOnly',networkAccess:false});
 await f.action('turn-interrupt',{threadId:THREAD,turnId:sent.data.state.snapshot!.thread!.turnId});
 assert.equal(f.service.state().nativeAssets?.granted,false);assert.equal(f.service.state().nativeAssets?.admissionOpen,false);
 assert.throws(()=>assertNativeAssetActor(f.dispatched[0]!.actor!,'mutate'),denied);
});

for(const mode of ['terminal-ack','terminal-before-ack'])test('automatic permission expires on exact '+mode+' and no later ordinary Send inherits it',async t=>{
 const f=await fixture(t,mode);await f.ready();assert.equal((await f.action('turn-start',{threadId:THREAD,text:'Human Send',allowAssets:true})).status,200);
 assert.equal(f.dispatched[0]!.granted,true);assert.equal(f.service.state().nativeAssets?.granted,false);
 assert.equal((await f.action('turn-start',{threadId:THREAD,text:'No automatic permission'})).status,200);assert.equal(f.dispatched[1]!.granted,false);
});

test('manual persistent permission survives automatic Send completion unchanged',async t=>{
 const f=await fixture(t,'terminal-ack');await f.ready();assert.equal((await f.action('grant-assets',{threadId:THREAD})).status,200);
 await f.action('turn-start',{threadId:THREAD,text:'Human Send',allowAssets:true});assert.equal(f.service.state().nativeAssets?.granted,true);
 assert.equal(f.service.state().nativeAssets?.admissionOpen,false);await f.action('turn-start',{threadId:THREAD,text:'Manual scope'});assert.equal(f.dispatched[1]!.granted,true);
});

test('failed known start expires automatic permission and cannot lend it to a subsequent ordinary turn',async t=>{
 const f=await fixture(t,'reject-first');await f.ready();const failed=await f.action('turn-start',{threadId:THREAD,text:'Known failure',allowAssets:true});
 assert.equal(failed.data.record.state,'rejected');assert.equal(f.service.state().nativeAssets?.granted,false);
 assert.throws(()=>assertNativeAssetActor(f.dispatched[0]!.actor!,'mutate'),denied);
 await f.action('turn-start',{threadId:THREAD,text:'Ordinary follow-up'});assert.equal(f.dispatched[1]!.granted,false);
});

for(const mode of ['unknown','disconnect','preflight-fail'])test('automatic Send '+mode+' fences without replay or leftover permission',async t=>{
 const f=await fixture(t,mode);await f.ready();const input={requestId:randomUUID(),connectionId:f.service.state().snapshot!.connectionId,action:'turn-start',threadId:THREAD,text:'Synthetic failed start',allowAssets:true};
 const failed=await f.post(input);assert.ok(['rejected','unknown'].includes(failed.data.record.state));assert.equal(f.service.state().nativeAssets?.granted,false);
 assert.throws(()=>f.registry.capture(f.token,'mutate'),denied);const count=f.dispatched.length;
 const replay=await f.post(input);assert.equal(replay.data.replayed,true);assert.equal(f.dispatched.length,count);
 if(mode==='preflight-fail')assert.equal(count,0);
});

test('revocation during actual preflight prevents the pending human Send from regranting at dispatch',async t=>{
 const f=await fixture(t,'hold-preflight');await f.ready();const pending=f.action('turn-start',{threadId:THREAD,text:'Human Send',allowAssets:true});
 const end=Date.now()+4000;while((await f.wire()).filter(row=>row.method==='mcpServerStatus/list').length<2){assert.ok(Date.now()<end);await delay(5);}
 assert.equal(f.service.state().nativeAssets?.granted,false);assert.throws(()=>f.registry.capture(f.token,'mutate'),denied);
 assert.equal((await f.action('revoke-assets',{threadId:THREAD})).status,200);assert.equal((await pending).status,200);
 assert.equal(f.dispatched[0]!.granted,false);assert.throws(()=>f.registry.capture(f.token,'mutate'),denied);
});

test('agent/model selfclaims and non-human, wrong-Origin or wrong-scope Send cannot arm automatic assets',async t=>{
 const f=await fixture(t);await f.ready();const input={requestId:randomUUID(),connectionId:f.service.state().snapshot!.connectionId,action:'turn-start',threadId:THREAD,text:'Selfclaim',allowAssets:true};
 for(const bearer of [f.generic,f.token,'invalid'])assert.ok([401,403].includes((await f.post(input,bearer)).status));
 for(const origin of [null,'https://foreign.invalid'])assert.equal((await f.post(input,f.control,origin)).status,403);
 for(const extra of [{initiatedBy:'human'},{actor:{role:'human'}},{grantNextIntent:true},{nativeAssetHooks:true},{sessionId:SESSION},{allowAssets:'true'}])assert.equal((await f.post({...input,...extra})).status,400);
 assert.equal((await f.post({...input,threadId:'wrong-thread'})).data.record.state,'rejected');assert.equal(f.dispatched.length,0);
 assert.equal(f.service.state().nativeAssets?.granted,false);assert.throws(()=>f.registry.capture(f.token,'mutate'),denied);
});

test('no asset registry means no automatic authority despite human allowAssets and model metadata',async t=>{
 const f=await fixture(t,'terminal-ack',false);await f.ready();assert.equal((await f.action('turn-start',{threadId:THREAD,text:'Ordinary human',allowAssets:true})).status,200);
 assert.equal(f.service.state().nativeAssets,undefined);assert.equal(f.dispatched.length,0);
 assert.equal((await f.wire()).find(row=>row.method==='turn/start')!.params.allowAssets,undefined);
});
