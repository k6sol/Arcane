import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {rmSync,existsSync,writeFileSync} from 'node:fs';
import {join,relative,isAbsolute} from 'node:path';
import {createServer} from 'node:http';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {CallToolRequestSchema,ListToolsRequestSchema,type CallToolResult,type Tool} from '@modelcontextprotocol/sdk/types.js';
import {createStudioTestService,type NativeTestConnection} from '../../apps/daemon/src/studio-test-service.js';
import {StudioStore,type StudioTestTemporaryEdit} from '../../packages/storage/src/studio-store.js';
import {readTestLedger,reviewedTestTools,digest,TestLedger} from '../../packages/studio-test-controller/src/index.js';
import {buildScenarioProgram} from '../../packages/studio-test-controller/src/scenario-runtime.js';
import {fixtureScenario,fixtureLayoutScenario,runScenarioFixture,type ScenarioFixtureOptions} from '../../packages/studio-test-controller/testing/scenario-fixture.js';
import {png} from '../../packages/asset-pipeline/testing/fixture.js';
import {READ_METHODS,WRITE_METHODS,type StudioCommand} from '../../packages/protocol/src/studio.js';
import {makeFixtureDirectory,fixtureTempDirectory} from './windows-fixture-paths.js';
import {playtestJob} from '../../apps/mcp/src/playtest-schemas.js';
import {studioTestRoutes} from '../../apps/daemon/src/studio-test-routes.js';
import {StudioTestError} from '../../packages/studio-test-controller/src/contracts.js';
import type {StudioTestTaskPort,StudioTestTaskOrigin,StudioTestTaskSettled,StudioTestTaskPrepared} from '../../packages/protocol/src/chat-task-playtest.js';

// Actual service/controller/native SDK adapter, authenticated SQLite queue and
// fsynced ledger. Native peers/physics/image bytes are fixtures. The exact Client
// program received over SDK is executed by pinned standalone Luau, never Studio.
const STUDIO='scenario-fixture-studio',NAME='Scenario fixture',ACTOR='scenario-fixture-agent',ARTIFACT='a'.repeat(64);
const text=(value:unknown):CallToolResult=>({content:[{type:'text',text:typeof value==='string'?value:JSON.stringify(value)}]});
const signal=()=>new AbortController().signal;
const gate=()=>{let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return{promise,release};};
async function until(predicate:()=>boolean,timeout=10000){const end=Date.now()+timeout;while(!predicate()){if(Date.now()>end)throw new Error('Scenario fixture did not settle.');await new Promise(resolve=>setTimeout(resolve,10));}}
const scenarioTools:Tool[]=[...structuredClone(reviewedTestTools),
  {name:'execute_luau',inputSchema:{type:'object',properties:{studio_id:{type:'string'},datamodel_type:{type:'string',enum:['Edit','Client','Server']},code:{type:'string'}},required:['studio_id','datamodel_type','code']}},
  {name:'screen_capture',inputSchema:{type:'object',properties:{studio_id:{type:'string'},capture_id:{type:'string'}},required:['studio_id','capture_id']}}];
async function fixture(t:TestContext,options:{runtime?:ScenarioFixtureOptions;temporary?:boolean;capture?:boolean;queuedSetup?:boolean;failSecondSetup?:boolean;badRestore?:boolean;
  taskPort?:StudioTestTaskPort;allowJournalFailure?:boolean;holdSetupAck?:boolean;holdInputAck?:boolean;inputErrorAck?:boolean;captureErrorAck?:boolean;mutateReport?:(report:ReturnType<typeof runScenarioFixture>['report'])=>void}={}){
  const root=makeFixtureDirectory('arcane-scenario-service-'),directory=join(root,'playtests'),store=new StudioStore({directory:join(root,'store')});
  const grant=store.createGrant({allowedRoots:['Workspace','ServerStorage'],allowWrites:true});
  const pair=store.pair({code:grant.code,protocolVersion:1,identity:{clientSessionId:'scenario-plugin-lifetime',placeId:0,universeId:0,name:NAME,pluginVersion:'fixture'},capabilities:[...READ_METHODS,...WRITE_METHODS]});
  const state={mode:'Edit' as 'Edit'|'Play',epoch:20,source:'print("fixture source")',pluginEnabled:!options.queuedSetup,polls:0,closes:0,setupEffects:0,restores:0,transparency:0,clientCalls:0,captures:0,inputRequests:0,inputEffects:0};
  const calls:{name:string;args:Record<string,unknown>}[]=[],connections:NativeTestConnection[]=[];
  const inputEntered=gate(),inputAck=gate();
  const setupEntered=gate(),setupAck=gate();
  const plan=fixtureScenario();plan.capture.required=options.capture??true;
  const ref={instanceId:'private-scenario-part',sessionId:pair.sessionId,root:'Workspace' as const,pathSegments:['Part'],className:'Part'};
  if(options.temporary){plan.temporaryEdits=[{id:'visual-setup',ref,expected:{Transparency:0},properties:{Transparency:0.5}}];if(options.failSecondSetup)plan.temporaryEdits.push({id:'second-setup',ref:{...ref,instanceId:'second-private-part'},expected:{Transparency:0},properties:{Transparency:0.25}});}
  const observation=()=>({sessionId:pair.sessionId,clientLifetimeId:'scenario-plugin-lifetime',pluginArtifactHash:ARTIFACT,markerName:'ArcaneTestProof_scenario_fixture',placeId:0,universeId:0,placeName:NAME,mode:state.mode,playEpoch:state.epoch,continuitySupported:true,connected:true});
  const publish=()=>{store.authenticate(pair.sessionId,pair.token);const commands=store.poll(pair.sessionId,observation());state.polls++;return commands;};
  const records=()=>readTestLedger(join(directory,'ledger'),directory);
  publish();
  let pluginBusy=false,pluginFailure:unknown;
  const applyCommand=(command:StudioCommand)=>{
    if(command.method==='scene.update'){
      state.setupEffects++;
      if(options.failSecondSetup&&state.setupEffects===2){store.result({sessionId:pair.sessionId,commandId:command.id,state:'failed',error:'Fixture rejected setup',result:{partial:false}});return;}
      state.transparency=Number((command.args.properties as Record<string,unknown>).Transparency);
      const acknowledge=()=>{store.result({sessionId:pair.sessionId,commandId:command.id,state:'succeeded',result:{ref:command.args.ref,mutation:{kind:'scene.update',ref:command.args.ref,before:{properties:command.args.expected},after:{properties:command.args.properties}}}});};
      if(options.holdSetupAck&&state.setupEffects===1){setupEntered.release();void setupAck.promise.then(acknowledge).catch(error=>{pluginFailure=error;});}else acknowledge();
    }else{
      assert.equal(command.method,'scene.restore');state.restores++;
      if(options.badRestore){store.result({sessionId:pair.sessionId,commandId:command.id,state:'failed',error:'Fixture after baseline changed',result:{partial:false}});return;}
      state.transparency=Number(((command.args.mutation as Record<string,unknown>).before as {properties:{Transparency:number}}).properties.Transparency);
      store.result({sessionId:pair.sessionId,commandId:command.id,state:'succeeded',result:{restored:true,ref:(command.args.mutation as Record<string,unknown>).ref}});
    }
  };
  // The production plugin polls every 2s. Accelerate queue delivery to 250ms
  // here, keeping real proof freshness without idle 100Hz SQLite write traffic.
  // Owned mode changes still publish their proof immediately below.
  const timer=setInterval(()=>{if(pluginBusy||!state.pluginEnabled)return;pluginBusy=true;try{for(const command of publish())applyCommand(command);}catch(error){pluginFailure=error;}finally{pluginBusy=false;}},250);
  const connect=async():Promise<NativeTestConnection>=>{
    const client=new Client({name:'scenario-production-client-fixture',version:'fixture-only'}),server=new Server({name:'fixture-not-RobloxStudio',version:'fixture-only'},{capabilities:{tools:{}}});
    const[clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
    server.setRequestHandler(ListToolsRequestSchema,()=>({tools:structuredClone(scenarioTools)}));
    server.setRequestHandler(CallToolRequestSchema,async request=>{
      const{name,arguments:args={}}=request.params;calls.push({name,args:structuredClone(args)});
      if(name==='list_roblox_studios')return text({studios:[{id:STUDIO,name:NAME}]});
      assert.equal(args.studio_id,STUDIO);
      if(name==='get_studio_state')return text(state.mode==='Edit'?'- Current Studio Mode: Edit\n- Available DataModels: Edit\n- Focused DataModel in the viewport: Edit':'- Current Studio Mode: Play\n- Available DataModels: Client, Server\n- Focused DataModel in the viewport: Client');
      if(name==='get_console_output')return text('');
      if(name==='start_stop_play'){
        if(!options.allowJournalFailure)assert.equal((await records()).at(-1)?.event.kind,args.is_start?'start_intent':'stop_intent');
        state.mode=args.is_start?'Play':'Edit';state.epoch++;assert.deepEqual(publish(),[]);return text('Fixture native ACK');
      }
      if(name==='execute_luau'&&args.datamodel_type==='Edit'){
        assert.ok(String(args.code).includes('ScriptEditorService'));assert.ok(!String(args.code).includes('SendKey'));
        return text({schemaVersion:1,sessionId:pair.sessionId,clientLifetimeId:'scenario-plugin-lifetime',pluginArtifactHash:ARTIFACT,nodes:4,sourceCount:1,
          sources:{s1:{root:'Workspace',path:['GameScript'],identity:'fixture-original-edit-script',className:'Script',enabled:true,source:state.source,editorSource:state.source}}});
      }
      if(name==='execute_luau'){
        assert.equal(args.datamodel_type,'Client');const intent=(await records()).at(-1)!.event;assert.equal(intent.kind,'scenario_intent');
        state.clientCalls++;const runId=intent.id;
        assert.equal(args.code,buildScenarioProgram(plan,runId,digest(plan)));
        inputEntered.release();const actual=runScenarioFixture(plan,options.runtime,runId,String(args.code));state.inputRequests+=actual.inputRequests;state.inputEffects+=actual.effects.length;options.mutateReport?.(actual.report);
        if(options.holdInputAck)await inputAck.promise;
        if(options.inputErrorAck)return{isError:true,content:[{type:'text',text:'Fixture lost original ACK after execution'}]};
        return text(actual.report);
      }
      assert.equal(name,'screen_capture');assert.deepEqual(Object.keys(args).sort(),['capture_id','studio_id']);state.captures++;
      if(options.captureErrorAck)return{isError:true,content:[{type:'text',text:'Fixture capture ACK unavailable'}]};
      return {content:[{type:'image',mimeType:'image/png',data:png().toString('base64')}]};
    });
    await server.connect(serverTransport);await client.connect(clientTransport);let closed=false;
    const connection:NativeTestConnection={client,evidence:'fixture',async witness(studioId,marker,mode,signal){assert.equal(studioId,STUDIO);assert.equal(marker,'ArcaneTestProof_scenario_fixture');assert.equal(mode,state.mode);assert.equal(signal.aborted,false);return{placeId:0,universeId:0,placeName:NAME,sessionId:pair.sessionId,clientLifetimeId:'scenario-plugin-lifetime',pluginArtifactHash:ARTIFACT};},async close(){if(closed)return;closed=true;state.closes++;await client.close();await server.close();}};
    connections.push(connection);return connection;
  };
  const service=await createStudioTestService({directory,store,pluginArtifactHash:ARTIFACT,connect,...(options.taskPort?{taskPort:options.taskPort}:{})});
  t.after(async()=>{inputAck.release();setupAck.release();clearInterval(timer);try{await service.lifecycle.close();for(const connection of connections)await connection.close();assert.equal(pluginFailure,undefined);}finally{store.close();const inside=relative(fixtureTempDirectory(),root);assert.ok(!isAbsolute(inside)&&inside.startsWith('arcane-scenario-service-')&&!inside.startsWith('..'));rmSync(root,{recursive:true,force:true});}});
  const prepare=()=>service.requests.prepare({sessionId:pair.sessionId,nativeStudioId:STUDIO,durationMs:5000,observationIntervalMs:250,failOnRuntimeError:true,scenario:plan},ACTOR);
  const approve=(job:{id:string;displayDigest:string})=>service.humanControl.approve({id:job.id,displayDigest:job.displayDigest},()=>{});
  const status=(id:string)=>service.requests.status(id,ACTOR);
  return{root,directory,store,service,state,pair,plan,prepare,approve,status,records,calls,inputEntered,inputAck,setupEntered,setupAck};
}

test('production service runs approved read-only assertions without virtual input and settles owned stop',{timeout:15000},async t=>{
  const f=await fixture(t,{capture:false,runtime:{inputUnavailable:true}});
  f.plan.steps=[{id:'snapshot',kind:'assert-gui',targetId:'status',property:'Visible',equals:false,withinMs:100,requireTransition:false}];
  const job=await f.prepare();assert.equal(f.state.clientCalls,0);assert.equal(f.state.inputRequests,0);await f.approve(job);
  await until(()=>f.status(job.id).review.phase==='done'&&f.state.closes===1);
  const report=f.status(job.id);assert.deepEqual(playtestJob.parse(report),report);
  assert.equal(report.displayDigest,job.displayDigest);assert.equal(report.review.outcome,'succeeded');assert.equal(report.review.cleanup,'complete');
  assert.equal(report.review.scenario!.inputRelease,'not_started');assert.equal(report.review.scenario!.steps[0]!.observed,false);
  assert.equal(report.nativeAcceptance,false);assert.equal(f.state.inputRequests,0);assert.equal(f.state.inputEffects,0);assert.equal(f.state.clientCalls,1);
  assert.deepEqual(f.calls.filter(call=>call.name==='start_stop_play').map(call=>call.args.is_start),[true,false]);
  const records=await f.records();assert.equal(records.filter(row=>row.event.kind==='terminal').length,1);assert.equal(records.at(-1)?.event.cleanup,'complete');
  assert.ok(f.calls.filter(call=>call.name==='execute_luau'&&call.args.datamodel_type==='Edit').length>=3,'source scope remains checked around approval and cleanup');
});

for(const failed of [false,true])test(`production service settles player attribute evidence with its original task and source digest: ${failed?'measured failure':'checkpoint changes'}`,{timeout:15000},async t=>{
  const task=taskFixture(),f=await fixture(t,{capture:false,taskPort:task.port,runtime:{inputUnavailable:true,attribute:{initial:1,...(failed?{}:{next:2,transition:'wait' as const})}}});
  Object.assign(f.plan,{version:1,runtimeBudgetMs:300,targets:[],steps:[{id:'checkpoint',kind:'assert-player-attribute',attribute:'Checkpoint',equals:2,withinMs:100,requireTransition:true}],capture:{required:false}});
  const job=await f.prepare();assert.equal(f.state.clientCalls,0);await f.approve(job);await until(()=>task.packets.length===1);
  const report=f.status(job.id),row=report.review.scenario!.steps[0]!,packet=task.packets[0]!;assert.deepEqual(playtestJob.parse(report),report);
  assert.equal(report.review.code,failed?'ASSERTION_FAILED':'OK');assert.equal(report.review.cleanup,'complete');assert.equal(row.observed,!failed);
  assert.deepEqual(row.attribute,{context:'Client',subject:'LocalPlayer',name:'Checkpoint',baseline:{present:true,value:1},observed:{present:true,value:failed?1:2}});
  assert.deepEqual(packet.scenario,{outcome:failed?'failed':'passed',requiredEvidence:'complete',inputRelease:'complete',restoration:'not_required',subjects:'current'});
  assert.equal(packet.reportDigest,digest(report));assert.equal(await f.service.revalidateExact(job.id,task.origin,packet.reportDigest),'current');
  assert.equal(f.state.inputRequests,0);assert.equal(f.state.inputEffects,0);assert.equal(f.state.clientCalls,1);assert.equal(report.nativeAcceptance,false);
  assert.deepEqual(f.calls.filter(call=>call.name==='start_stop_play').map(call=>call.args.is_start),[true,false]);
});

for(const mutation of ['missing','server','wrong-name','contradiction']as const)test('native player attribute failure cannot authorize repair with '+mutation+' evidence',{timeout:15000},async t=>{
  const task=taskFixture(),f=await fixture(t,{capture:false,taskPort:task.port,runtime:{attribute:{initial:1}},mutateReport(report){
    const row=report.steps[0]!;
    if(mutation==='missing')delete row.attribute;
    else if(mutation==='server')Object.assign(row.attribute!,{context:'Server'});
    else if(mutation==='wrong-name')row.attribute!.name='Foreign';
    else row.attribute!.observed={present:true,value:2};
  }});
  Object.assign(f.plan,{version:1,runtimeBudgetMs:300,targets:[],steps:[{id:'checkpoint',kind:'assert-player-attribute',attribute:'Checkpoint',equals:2,withinMs:100,requireTransition:true}],capture:{required:false}});
  const job=await f.prepare();await f.approve(job);await until(()=>task.packets.length===1);
  const report=f.status(job.id);assert.equal(report.review.code,'BAD_NATIVE_RESPONSE');assert.equal(report.review.scenario!.inputRelease,'unknown');
  assert.equal(task.packets[0]!.scenario!.outcome,'incomplete');assert.equal(task.packets[0]!.scenario!.requiredEvidence,'missing');
  assert.equal(f.state.clientCalls,1);assert.equal(f.state.mode,'Edit');assert.equal(report.review.canStartAnotherOperation,false);
});

for(const failed of [false,true])test(`production service binds approved layout measurements to settled source-current task evidence: ${failed?'measured failure':'current layout passes'}`,{timeout:15000},async t=>{
    const task=taskFixture(),f=await fixture(t,{capture:false,taskPort:task.port,runtime:{inputUnavailable:true,layout:failed?{width:60}:{}}});Object.assign(f.plan,fixtureLayoutScenario());
    const job=await f.prepare();assert.deepEqual(playtestJob.parse(job),job);assert.equal(f.state.clientCalls,0);await f.approve(job);await until(()=>task.packets.length===1);
    const report=f.status(job.id),row=report.review.scenario!.steps[0]!,packet=task.packets[0]!;assert.deepEqual(playtestJob.parse(report),report);
    assert.equal(report.review.outcome,failed?'failed':'succeeded');assert.equal(report.review.code,failed?'ASSERTION_FAILED':'OK');assert.equal(report.review.cleanup,'complete');
    assert.equal(row.observed,!failed);assert.equal(row.layout!.target.right-row.layout!.target.left,failed?60:200);
    assert.equal(row.layout!.safeArea.bottom,600);assert.equal(row.layout!.viewport.height,644);assert.equal(packet.reportDigest,digest(report));
    assert.deepEqual(packet.scenario,{outcome:failed?'failed':'passed',requiredEvidence:'complete',inputRelease:'complete',restoration:'not_required',subjects:'current'});
    assert.equal(f.state.inputRequests,0);assert.equal(f.state.inputEffects,0);assert.equal(f.state.clientCalls,1);assert.equal(report.nativeAcceptance,false);
    assert.deepEqual(f.calls.filter(call=>call.name==='start_stop_play').map(call=>call.args.is_start),[true,false]);assert.equal((await f.records()).at(-1)?.event.cleanup,'complete');
    assert.equal(await f.service.revalidateExact(job.id,task.origin,packet.reportDigest),'current');
});

for(const mutation of ['missing','null','string','contradiction','wrong-minimum','clip-overflow']as const)test(`native layout failures require measured metadata before they can become repair evidence: ${mutation}`,{timeout:15000},async t=>{
    const task=taskFixture(),f=await fixture(t,{capture:false,taskPort:task.port,runtime:{layout:{width:60}},mutateReport(report){
      const row=report.steps[0]!;
      if(mutation==='missing')delete row.layout;
      else if(mutation==='null'){delete row.layout;row.observed=null;}
      else if(mutation==='string'){delete row.layout;row.observed='not-observed';}
      else if(mutation==='contradiction')row.layout!.target.right=row.layout!.target.left+200;
      else if(mutation==='wrong-minimum')row.expected='core-safe:1x1';
      else row.layout!.clips=Array.from({length:9},()=>row.layout!.safeArea);
    }});Object.assign(f.plan,fixtureLayoutScenario());const job=await f.prepare();await f.approve(job);await until(()=>task.packets.length===1);
    const report=f.status(job.id);assert.equal(report.review.code,'BAD_NATIVE_RESPONSE');assert.equal(report.review.scenario!.inputRelease,'unknown');
    assert.equal(task.packets[0]!.scenario!.outcome,'incomplete');assert.equal(task.packets[0]!.scenario!.requiredEvidence,'missing');
    assert.equal(f.state.clientCalls,1);assert.equal(f.state.mode,'Edit');assert.equal(report.review.canStartAnotherOperation,false);
});

test('production service executes finite gameplay and retains unattested capture without claiming Client screenshot proof',{timeout:15000},async t=>{
  const f=await fixture(t,{temporary:true}),job=await f.prepare();assert.deepEqual(playtestJob.parse(job),job);assert.match(job.display.proposal.subjectDigest!,/^[a-f0-9]{64}$/);
  assert.equal(f.state.clientCalls,0);assert.equal(f.state.setupEffects,0);await f.approve(job);await until(()=>f.status(job.id).review.phase==='done'&&f.state.closes===1);
  const report=f.status(job.id);assert.deepEqual(playtestJob.parse(report),report);assert.equal(report.review.outcome,'failed');assert.equal(report.review.code,'UNSUPPORTED_TOOL');assert.equal(report.review.cleanup,'complete');
  assert.equal(report.review.scenario!.state,'passed');assert.equal(report.review.scenario!.inputRelease,'observed_released');assert.equal(report.review.scenario!.temporary,'restored');assert.equal(report.review.scenario!.capture!.context,'unattested');assert.equal(report.review.scenario!.capture!.nativeAcceptance,false);
  assert.equal(f.state.setupEffects,1);assert.equal(f.state.restores,1);assert.equal(f.state.transparency,0);assert.equal(f.state.clientCalls,1);assert.equal(f.state.captures,1);
  const image=await f.service.requests.capture(job.id,ACTOR);assert.deepEqual(image.bytes,png());await assert.rejects(f.service.requests.capture(job.id,'foreign-agent'),{code:'HUMAN_AUTH_REQUIRED'});
  let origin='';const routes=studioTestRoutes(f.service,request=>({kind:'agent',id:request.headers.authorization==='Bearer fixture-owner'?ACTOR:'foreign-agent'}));
  const http=createServer((request,response)=>{void routes(request,response,new URL(request.url??'/',origin),origin).catch(()=>response.destroy());});
  await new Promise<void>(resolve=>http.listen(0,'127.0.0.1',resolve));const address=http.address();assert.ok(address&&typeof address!=='string');origin='http://127.0.0.1:'+address.port;
  t.after(async()=>{http.closeAllConnections();await new Promise<void>((resolve,reject)=>http.close(error=>error?reject(error):resolve()));});
  const delivered=await fetch(origin+'/v1/playtests/capture?id='+job.id,{headers:{Authorization:'Bearer fixture-owner'}});
  assert.equal(delivered.status,200);assert.equal(delivered.headers.get('content-type'),'image/png');assert.equal(delivered.headers.get('cache-control'),'no-store');assert.equal(delivered.headers.get('x-content-type-options'),'nosniff');
  assert.deepEqual(Buffer.from(await delivered.arrayBuffer()),png());assert.equal((await fetch(origin+'/v1/playtests/capture?id='+job.id,{headers:{Authorization:'Bearer foreign-owner'}})).status,403);
  assert.equal((await f.records()).filter(row=>row.event.kind==='terminal').length,1);assert.equal((await f.records()).at(-1)?.event.cleanup,'complete');
  assert.equal(f.store.enqueue({sessionId:f.pair.sessionId,requestId:'after-scenario-restoration',method:'scene.children',args:{root:'Workspace'}}).state,'queued');
});
test('changed persisted/editor source invalidates approval before any scenario side effect',async t=>{
  const f=await fixture(t),job=await f.prepare();f.state.source='print("new source revision")';await assert.rejects(f.approve(job),{code:'BINDING_CHANGED'});assert.equal(f.state.clientCalls,0);assert.equal(f.state.setupEffects,0);assert.equal(f.calls.filter(call=>call.name==='start_stop_play').length,0);
});

test('measured assertion failure retains the actual failed row, bounded console observation and human-review image',{timeout:15000},async t=>{
  const f=await fixture(t,{runtime:{immobile:true}}),job=await f.prepare();await f.approve(job);await until(()=>f.status(job.id).review.phase==='done'&&f.state.closes===1);
  const report=f.status(job.id);assert.equal(report.review.code,'ASSERTION_FAILED');assert.equal(report.review.scenario!.state,'failed');
  assert.equal(report.review.scenario!.steps[1]!.observed,0);assert.equal(report.review.scenario!.steps[1]!.outcome,'failed');assert.equal(report.review.cleanup,'complete');
  assert.equal(report.review.observations,1);assert.equal(f.state.captures,1);assert.equal(report.review.scenario!.capture!.context,'unattested');assert.deepEqual(playtestJob.parse(report),report);
});
test('human Stop cancels queued setup before Play starts and releases after exact zero-effect cleanup',{timeout:15000},async t=>{
  const f=await fixture(t,{temporary:true,queuedSetup:true}),job=await f.prepare();await f.approve(job);await until(()=>f.store.commands(f.pair.sessionId).some(command=>command.method==='scene.update'&&command.state==='queued'));
  const report=await f.service.requests.cancel(job.id,ACTOR);assert.equal(report.review.outcome,'cancelled');assert.equal(report.review.cleanup,'complete');assert.equal(report.review.scenario!.inputRelease,'not_started');assert.equal(f.state.clientCalls,0);assert.equal(f.state.setupEffects,0);assert.equal(f.calls.filter(call=>call.name==='start_stop_play').length,0);
  const polls=f.state.polls;f.state.pluginEnabled=true;await until(()=>f.state.polls>polls);assert.equal(f.state.setupEffects,0);
});

test('human Stop awaits the late exact setup ACK before deriving its inverse and releasing the owner',{timeout:15000},async t=>{
  const f=await fixture(t,{temporary:true,holdSetupAck:true}),job=await f.prepare();await f.approve(job);await f.setupEntered.promise;
  const cancelling=f.service.requests.cancel(job.id,ACTOR);await new Promise(resolve=>setTimeout(resolve,40));assert.equal(f.state.restores,0);assert.equal(f.state.transparency,0.5);
  assert.throws(()=>f.store.enqueue({sessionId:f.pair.sessionId,requestId:'held-setup-owner',method:'scene.children',args:{root:'Workspace'}}),{code:'BUSY'});
  f.setupAck.release();const report=await cancelling;assert.equal(report.review.outcome,'cancelled');assert.equal(report.review.cleanup,'complete');assert.equal(f.state.transparency,0);assert.equal(f.state.restores,1);
  assert.equal(f.calls.filter(call=>call.name==='start_stop_play').length,0);assert.equal(f.state.clientCalls,0);
});
test('partial setup failure still restores earlier proven edits and retains the unresolved delivered fence',{timeout:15000},async t=>{
  const f=await fixture(t,{temporary:true,failSecondSetup:true}),job=await f.prepare();await f.approve(job);await until(()=>f.status(job.id).review.phase==='done'&&f.state.closes===1);
  const report=f.status(job.id);assert.equal(report.review.cleanup,'unknown');assert.equal(f.state.setupEffects,2);assert.equal(f.state.restores,1);assert.equal(f.state.transparency,0);assert.equal(f.state.clientCalls,0);assert.equal(f.calls.filter(call=>call.name==='start_stop_play').length,0);
  assert.throws(()=>f.store.enqueue({sessionId:f.pair.sessionId,requestId:'must-remain-fenced',method:'scene.children',args:{root:'Workspace'}}),{code:'BUSY'});
});
test('late original scenario ACK never clears cancelled input uncertainty and owned Play is still stopped once',{timeout:15000},async t=>{
  const f=await fixture(t,{holdInputAck:true}),job=await f.prepare();await f.approve(job);await f.inputEntered.promise;
  const cancelling=f.service.requests.cancel(job.id,ACTOR);await new Promise(resolve=>setTimeout(resolve,40));f.inputAck.release();const report=await cancelling;
  assert.equal(report.review.outcome,'cancelled');assert.equal(report.review.cleanup,'unknown');assert.equal(report.review.scenario!.inputRelease,'unknown');assert.equal(f.state.clientCalls,1);assert.equal(f.state.mode,'Edit');assert.equal(f.calls.filter(call=>call.name==='start_stop_play').length,2);assert.equal(f.state.captures,0);
  assert.equal((await f.records()).filter(row=>row.event.kind==='terminal').length,1);assert.equal((await f.records()).at(-1)?.event.cleanup,'unknown');assert.equal(existsSync(join(f.directory,'ledger','writer.lock')),true);
});
for(const [label,options]of [['lost original ACK',{inputErrorAck:true}],['failed original release',{runtime:{releaseError:true}}]]as const)test(`verified owned stop preserves unknown input cleanup: ${label}`,{timeout:15000},async t=>{
    const f=await fixture(t,options),job=await f.prepare();await f.approve(job);await until(()=>f.status(job.id).review.phase==='done'&&f.state.closes===1);const report=f.status(job.id);
    assert.equal(report.review.cleanup,'unknown');assert.equal(report.review.scenario!.inputRelease,'unknown');assert.equal(f.state.clientCalls,1);assert.equal(f.state.mode,'Edit');assert.equal(f.calls.filter(call=>call.name==='start_stop_play').length,2);
});
test('capture ACK failure does not invent an image and does not erase observed input release',{timeout:15000},async t=>{
  const f=await fixture(t,{captureErrorAck:true}),job=await f.prepare();await f.approve(job);await until(()=>f.status(job.id).review.phase==='done'&&f.state.closes===1);const report=f.status(job.id);
  assert.equal(report.review.outcome,'failed');assert.equal(report.review.cleanup,'complete');assert.equal(report.review.scenario!.inputRelease,'observed_released');assert.equal(report.review.scenario!.capture,null);assert.equal(f.state.captures,1);assert.equal(f.state.mode,'Edit');
});
for(const change of ['expected','observed','baseline']as const)test(`contradictory native step fields are rejected without replay and retain input uncertainty: ${change}`,{timeout:15000},async t=>{
    const f=await fixture(t,{mutateReport(report){const row=report.steps[3]!;if(change==='expected')row.expected=false;else if(change==='observed')row.observed=false;else row.baseline='not-a-boolean';}}),job=await f.prepare();await f.approve(job);await until(()=>f.status(job.id).review.phase==='done'&&f.state.closes===1);
    assert.equal(f.status(job.id).review.code,'BAD_NATIVE_RESPONSE');assert.equal(f.status(job.id).review.cleanup,'unknown');assert.equal(f.state.clientCalls,1);assert.equal(f.state.mode,'Edit');
});
test('restoration conflict preserves original measured scenario evidence and retains the private fence',{timeout:15000},async t=>{
  const f=await fixture(t,{temporary:true,badRestore:true}),job=await f.prepare();await f.approve(job);await until(()=>f.status(job.id).review.phase==='done'&&f.state.closes===1);const report=f.status(job.id);
  assert.equal(report.review.scenario!.state,'passed');assert.equal(report.review.cleanup,'unknown');assert.equal(report.review.scenario!.temporary,'unknown');assert.equal(f.state.restores,1);assert.equal(f.state.mode,'Edit');assert.equal(report.review.canStartAnotherOperation,false);
});

function taskFixture(){
  const origin:StudioTestTaskOrigin=Object.freeze({kind:'studio-test-task-origin',taskId:'fixture-task',projectId:'fixture-project',provider:'codex',threadId:'fixture-thread',sessionId:'fixture-session',incarnationId:'fixture-incarnation'});
  let revoked=false;const prepared:StudioTestTaskPrepared[]=[],packets:StudioTestTaskSettled[]=[];
  const port:StudioTestTaskPort=Object.freeze({capture(actor:string){assert.equal(actor,ACTOR);return origin;},assert(value:StudioTestTaskOrigin){if(value!==origin||revoked)throw new StudioTestError('HUMAN_AUTH_REQUIRED');},
    prepared(value:StudioTestTaskOrigin,packet:StudioTestTaskPrepared){assert.equal(value,origin);prepared.push(structuredClone(packet));},
    terminal(value:StudioTestTaskOrigin,packet:StudioTestTaskSettled){assert.equal(value,origin);packets.push(structuredClone(packet));}});
  return{origin,port,prepared,packets,revoke(){revoked=true;}};
}

test('private task evidence is settled once and revalidated from a fresh read-only connection after the requesting turn',{timeout:15000},async t=>{
  const task=taskFixture(),f=await fixture(t,{capture:false,taskPort:task.port}),job=await f.prepare();
  assert.equal(task.prepared.length,1);assert.deepEqual(task.prepared[0],{jobId:job.id,displayDigest:job.displayDigest,scenarioDigest:digest(f.plan),subjectDigest:job.display.proposal.subjectDigest});
  await f.approve(job);await until(()=>task.packets.length===1);const report=f.status(job.id),packet=task.packets[0]!;
  assert.equal(report.review.outcome,'succeeded');assert.equal(report.review.cleanup,'complete');assert.equal(packet.reportDigest,digest(report));
  assert.deepEqual(packet.scenario,{outcome:'passed',requiredEvidence:'complete',inputRelease:'complete',restoration:'not_required',subjects:'current'});
  const effects=f.calls.filter(call=>call.name==='start_stop_play'||call.name==='screen_capture'||call.name==='execute_luau'&&call.args.datamodel_type==='Client').length;
  await assert.rejects(f.service.revalidateExact(job.id,structuredClone(task.origin),packet.reportDigest),{code:'HUMAN_AUTH_REQUIRED'});
  await assert.rejects(f.service.revalidateExact(job.id,task.origin,'0'.repeat(64)),{code:'HUMAN_AUTH_REQUIRED'});
  assert.equal(await f.service.revalidateExact(job.id,task.origin,packet.reportDigest),'current');assert.equal(f.state.closes,2);
  f.state.source='print("later native turn edit")';assert.equal(await f.service.revalidateExact(job.id,task.origin,packet.reportDigest),'changed');assert.equal(f.state.closes,3);
  assert.equal(f.calls.filter(call=>call.name==='start_stop_play'||call.name==='screen_capture'||call.name==='execute_luau'&&call.args.datamodel_type==='Client').length,effects,'revalidation never starts, replays input, or captures');
  task.revoke();await f.service.cancelExact(job.id,task.origin);await f.service.cancelExact(job.id,task.origin);assert.equal(task.packets.length,1);
});

test('revoked task origins cannot approve effects while the same private origin can still cancel its pending job',async t=>{
  const task=taskFixture(),f=await fixture(t,{taskPort:task.port}),job=await f.prepare();task.revoke();
  await assert.rejects(f.approve(job),{code:'HUMAN_AUTH_REQUIRED'});
  await assert.rejects(f.service.cancelExact(job.id,structuredClone(task.origin)),{code:'HUMAN_AUTH_REQUIRED'});
  await f.service.cancelExact(job.id,task.origin);assert.equal(task.packets.length,1);assert.equal(task.packets[0]!.scenario!.requiredEvidence,'missing');
  assert.equal(f.state.clientCalls,0);assert.equal(f.calls.filter(call=>call.name==='start_stop_play').length,0);
});

test('private cancellation settles owned stop but refuses successor admission when original input ACK is unknown',{timeout:15000},async t=>{
  const task=taskFixture(),f=await fixture(t,{taskPort:task.port,holdInputAck:true}),job=await f.prepare();await f.approve(job);await f.inputEntered.promise;task.revoke();
  const stopping=assert.rejects(f.service.cancelExact(job.id,task.origin),{code:'FENCED'});await new Promise(resolve=>setTimeout(resolve,30));f.inputAck.release();await stopping;
  assert.equal(f.state.mode,'Edit');assert.equal(task.packets.length,1);assert.equal(task.packets[0]!.scenario!.inputRelease,'unknown');
  assert.equal(await f.service.revalidateExact(job.id,task.origin,task.packets[0]!.reportDigest),'unobserved');assert.equal(f.state.closes,1);
});

for(const fault of ['start_intent','scenario_result']as const)test(`real journal segment conflict restores proven temporary edits and closes SDK without releasing the reservation: ${fault}`,{timeout:15000},async t=>{
    const f=await fixture(t,{temporary:true,allowJournalFailure:true}),job=await f.prepare(),append=TestLedger.prototype.append;
    let injected=false;
    TestLedger.prototype.append=async function(event){
      if(!injected&&event.kind===fault){injected=true;const records=this.records();writeFileSync(join(f.directory,'ledger',String(records.length+1).padStart(5,'0')+'.json'),'fixture interrupted segment',{flag:'wx'});}
      return append.call(this,event);
    };
    try{await f.approve(job);await until(()=>f.status(job.id).review.phase==='done'&&f.state.closes===1);}
    finally{TestLedger.prototype.append=append;}
    const report=f.status(job.id);assert.equal(injected,true);assert.equal(report.review.cleanup,'unknown');assert.equal(report.review.scenario!.temporary,'restored');
    assert.equal(f.state.transparency,0);assert.equal(f.state.restores,1);assert.equal(f.state.mode,'Edit');
    assert.equal(f.state.clientCalls,fault==='start_intent'?0:1);assert.equal(f.calls.filter(call=>call.name==='start_stop_play').length,fault==='start_intent'?0:2);
    assert.equal(report.review.scenario!.inputRelease,fault==='start_intent'?'not_started':'observed_released');
    assert.throws(()=>f.store.enqueue({sessionId:f.pair.sessionId,requestId:'journal-reservation-remains-owned',method:'scene.children',args:{root:'Workspace'}}),{code:'BUSY'});
    assert.equal(existsSync(join(f.directory,'ledger','writer.lock')),true);await assert.rejects(f.records(),{code:'JOURNAL_FAILED'});
});
