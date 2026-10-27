import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {getEventListeners} from 'node:events';
import {rmSync} from 'node:fs';
import {join,relative,isAbsolute} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {CallToolRequestSchema,ListToolsRequestSchema,type CallToolResult,type Tool} from '@modelcontextprotocol/sdk/types.js';
import {StudioStore} from '../../packages/storage/src/studio-store.js';
import {workflowProjectIdentity} from '../../packages/storage/src/workflow-store.js';
import {digest,readTestLedger,reviewedTestTools} from '../../packages/studio-test-controller/src/index.js';
import {fixtureScenario,runScenarioFixture} from '../../packages/studio-test-controller/testing/scenario-fixture.js';
import {buildScenarioProgram} from '../../packages/studio-test-controller/src/scenario-runtime.js';
import {ChatTaskCoordinator,ChatTaskProposalBudget,type ChatTaskOwner} from '../../apps/daemon/src/chat-task-coordinator.js';
import {createStudioTestService,type NativeTestConnection} from '../../apps/daemon/src/studio-test-service.js';
import type {Snapshot} from '../../packages/codex-client/src/types.js';
import type {StudioTestTaskPort,StudioTestTaskWorkRegistration,StudioTestTaskSettled} from '../../packages/protocol/src/chat-task-playtest.js';
import {makeFixtureDirectory,fixtureTempDirectory} from './windows-fixture-paths.js';
// Actual coordinator/service/controller/custodian and SQLite; SDK peers and task
// snapshots are controlled fixtures, not native provider/Studio acceptance.
const ARTIFACT='d'.repeat(64),ACCOUNT='e'.repeat(64),ACTOR='quiescence-actor',STUDIO='quiescence-studio',NAME='Quiescence fixture';
function gate(){let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return{promise,resolve};}
const text=(value:string):CallToolResult=>({content:[{type:'text',text:value}]});
async function stillPending(promise:Promise<unknown>){let settled=false;void promise.then(()=>{settled=true;},()=>{settled=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);}
async function fixture(t:TestContext,options:{holdConnect?:boolean;holdClose?:boolean;preparedFailure?:{value:unknown};closeFailure?:{value:unknown};cancelInsideConnect?:boolean;scenario?:boolean;holdRevalidationConnect?:boolean;holdRevalidationClose?:boolean}={}){
 const root=makeFixtureDirectory('arcane-task-quiescence-'),directory=join(root,'studio'),store=new StudioStore({directory});
 const coordinator=new ChatTaskCoordinator({directory:join(root,'tasks'),projectPath:root,proposalBudget:new ChatTaskProposalBudget()});
 const stats={connects:0,closes:0,sdkCalls:0,prepared:0,terminal:0,unpublishedCancel:0,publishedCancel:0,ownerCancel:0,ownerRevoke:0};
 const workSignals:AbortSignal[]=[],listenerBaselines:number[]=[];
 const registrations:StudioTestTaskWorkRegistration[]=[],packets:StudioTestTaskSettled[]=[],connections:NativeTestConnection[]=[];
 const connectEntered=gate(),connectRelease=gate(),closeEntered=gate(),closeRelease=gate(),revalidationEntered=gate(),readerCloseEntered=gate();
 const plan=fixtureScenario();plan.capture.required=false;let mode:'Edit'|'Play'='Edit',epoch=0;
 let insideCancellation:Promise<void>|null=null;
 const live:Snapshot={connectionId:randomUUID(),provenance:'spawned-node-fixture',mcpIsolation:'arcane-only-verified',connected:true,ready:true,
  account:{auth:'subscription',plan:null,requiresOpenaiAuth:false},models:[],selection:{model:'fixture',effort:'low'},operations:[],approvals:[],events:[],droppedEvents:0,lastEventSeq:0,failureCode:null,
  thread:{configured:true,threadId:'quiescence-thread',sessionId:null,selection:{model:'fixture',effort:'low'},turnStatus:'inProgress',turnId:null,writeGranted:false}};
 const owner:ChatTaskOwner={snapshot:()=>live,accountIdentity:()=>ACCOUNT,revoke(){stats.ownerRevoke++;},async cancel(){stats.ownerCancel++;},async repair(){assert.fail('No repair in this scheduling fixture');}};
 const taskPort:StudioTestTaskPort={capture:actor=>coordinator.playtests.capture(actor),assert:origin=>coordinator.playtests.assert(origin),
  registerWork(origin,registration){const original:StudioTestTaskWorkRegistration=Object.freeze({...registration,cancel:async()=>{stats.unpublishedCancel++;await registration.cancel();}});registrations.push(original);const identity=coordinator.playtests.registerWork(origin,original);workSignals.push(identity.signal);listenerBaselines.push(getEventListeners(identity.signal,'abort').length);return identity;},
  prepared(origin,value,work){if(options.preparedFailure)throw options.preparedFailure.value;coordinator.playtests.prepared(origin,value,work);stats.prepared++;},
  terminal(origin,value,work){stats.terminal++;packets.push(value);return coordinator.playtests.terminal(origin,value,work);}};
 const grant=store.createGrant({allowedRoots:['Workspace','ServerStorage'],allowWrites:true}),pair=store.pair({code:grant.code,protocolVersion:1,
  identity:{clientSessionId:'quiescence-plugin',placeId:0,universeId:0,name:NAME,pluginVersion:'fixture'},capabilities:['scene.children']});
 const publish=()=>{store.authenticate(pair.sessionId,pair.token);assert.deepEqual(store.poll(pair.sessionId,{sessionId:pair.sessionId,clientLifetimeId:'quiescence-plugin',pluginArtifactHash:ARTIFACT,
  markerName:'ArcaneTestProof_quiescence',placeId:0,universeId:0,placeName:NAME,mode,playEpoch:epoch,continuitySupported:true,connected:true}),[]);};publish();
 const id=randomUUID(),operationId=randomUUID();
 const connect=async():Promise<NativeTestConnection>=>{
  assert.ok(registrations.length>0,'task registration exists before factory invocation');stats.connects++;connectEntered.resolve();
  if(options.cancelInsideConnect)insideCancellation=coordinator.cancel(id,'synchronous-connector-retirement');
  if(stats.connects===2)revalidationEntered.resolve();
  if(options.holdConnect||options.holdRevalidationConnect&&stats.connects===2)await connectRelease.promise;
  const index=stats.connects;
  const [a,b]=InMemoryTransport.createLinkedPair(),client=new Client({name:'quiescence-fixture',version:'fixture'}),server=new Server({name:'fixture-not-Studio',version:'fixture'},{capabilities:{tools:{}}});
  const tools:Tool[]=[...structuredClone(reviewedTestTools),...(options.scenario?[{name:'execute_luau',inputSchema:{type:'object' as const,properties:{studio_id:{type:'string'},datamodel_type:{type:'string',enum:['Edit','Client','Server']},code:{type:'string'}},required:['studio_id','datamodel_type','code']}}]:[])];
  server.setRequestHandler(ListToolsRequestSchema,()=>({tools:structuredClone(tools)}));
  server.setRequestHandler(CallToolRequestSchema,async request=>{stats.sdkCalls++;const name=request.params.name,args=request.params.arguments??{};
   if(name==='list_roblox_studios')return text(JSON.stringify({studios:[{id:STUDIO,name:NAME}]}));
   assert.equal(args.studio_id,STUDIO);if(name==='get_studio_state')return text(mode==='Edit'?'- Current Studio Mode: Edit\n- Available DataModels: Edit\n- Focused DataModel in the viewport: Edit':'- Current Studio Mode: Play\n- Available DataModels: Client, Server\n- Focused DataModel in the viewport: Client');
   if(name==='get_console_output')return text('');assert.equal(options.scenario,true,'No effects or caller programs in ordinary scheduling cases');
   if(name==='start_stop_play'){assert.equal(typeof args.is_start,'boolean');mode=args.is_start?'Play':'Edit';epoch++;publish();return text('controlled ACK');}
   assert.equal(name,'execute_luau');
   if(args.datamodel_type==='Edit')return text(JSON.stringify({schemaVersion:1,sessionId:pair.sessionId,clientLifetimeId:'quiescence-plugin',pluginArtifactHash:ARTIFACT,nodes:4,sourceCount:1,
    sources:{s1:{root:'Workspace',path:['FixtureScript'],identity:'quiescence-original-script',className:'Script',enabled:true,source:'print("fixture")',editorSource:'print("fixture")'}}}));
   assert.equal(args.datamodel_type,'Client');const last=(await readTestLedger(join(root,'playtests','ledger'),join(root,'playtests'))).at(-1);assert.ok(last);assert.equal(last.event.kind,'scenario_intent');
   assert.equal(args.code,buildScenarioProgram(plan,last.event.id,digest(plan)));return text(JSON.stringify(runScenarioFixture(plan,{},last.event.id,String(args.code)).report));
  });
  await server.connect(b);await client.connect(a);let closing:Promise<void>|null=null;
  const connection:NativeTestConnection={client,evidence:'fixture',async witness(studioId,marker,wantedMode,signal){assert.equal(studioId,STUDIO);assert.equal(marker,'ArcaneTestProof_quiescence');assert.equal(wantedMode,mode);signal.throwIfAborted();return{placeId:0,universeId:0,placeName:NAME,sessionId:pair.sessionId,clientLifetimeId:'quiescence-plugin',pluginArtifactHash:ARTIFACT};},
   close(){return closing??=(async()=>{stats.closes++;closeEntered.resolve();if(index===2)readerCloseEntered.resolve();if(options.holdClose||options.holdRevalidationClose&&index===2)await closeRelease.promise;await client.close();await server.close();if(options.closeFailure)throw options.closeFailure.value;})();}};
  connections.push(connection);return connection;
 };
 const service=await createStudioTestService({directory:join(root,'playtests'),store,pluginArtifactHash:ARTIFACT,connect,taskPort,custody:store.bindNativeCustody(workflowProjectIdentity(root).projectId,directory)});
 coordinator.attachCancellation(Object.freeze({async cancelExact(jobId:string,origin:Parameters<typeof service.cancelExact>[1]){stats.publishedCancel++;await service.cancelExact(jobId,origin);},revalidateExact:service.revalidateExact}));
 coordinator.begin({id,actorId:ACTOR,snapshot:live,allowWorkspaceWrites:false,allowAssets:false,owner,accountIdentity:ACCOUNT});coordinator.dispatched(id,operationId);
 const origin=coordinator.playtests.capture(ACTOR);assert.ok(origin);
 t.after(async()=>{connectRelease.resolve();closeRelease.resolve();try{
  if(options.closeFailure){await assert.rejects(coordinator.close(),error=>error===options.closeFailure!.value);await assert.rejects(service.lifecycle.close(),error=>error===options.closeFailure!.value);}
  else{await coordinator.close();await service.lifecycle.close();}
  for(const connection of connections){if(options.closeFailure)await assert.rejects(connection.close(),error=>error===options.closeFailure!.value);else await connection.close();}
 }finally{store.close();const tail=relative(fixtureTempDirectory(),root);assert.ok(!isAbsolute(tail)&&tail.startsWith('arcane-task-quiescence-')&&!tail.startsWith('..'));rmSync(root,{recursive:true,force:true});}});
 const prepare=(actor=ACTOR)=>{publish();return service.requests.prepare({sessionId:pair.sessionId,nativeStudioId:STUDIO,durationMs:5000,observationIntervalMs:1000,...(options.scenario?{scenario:plan}:{})},actor);};
 return{root,service,coordinator,id,origin,stats,registrations,workSignals,listenerBaselines,packets,prepare,connectEntered,connectRelease,closeEntered,closeRelease,revalidationEntered,readerCloseEntered,finishTurn(){assert.ok(live.thread);live.thread.turnStatus='completed';live.thread.turnId='quiescence-turn';live.operations=[{operationId,method:'turn/start',requestId:1,threadId:live.thread.threadId,turnId:live.thread.turnId,state:'acknowledged',errorCode:null}];coordinator.acknowledged(id);},insideCancellation:()=>insideCancellation};
}

test('actual task cancellation joins held prepare allocation and the original late close without publication',async t=>{
 const f=await fixture(t,{holdConnect:true,holdClose:true}),request=f.prepare();void request.catch(()=>{});await f.connectEntered.promise;
 assert.equal(f.registrations.length,1);const cancellation=f.coordinator.cancel(f.id,'held-prepare');void cancellation.catch(()=>{});await stillPending(cancellation);
 f.connectRelease.resolve();await f.closeEntered.promise;assert.equal(f.stats.ownerCancel,1);assert.equal(f.stats.sdkCalls,0);await stillPending(cancellation);await stillPending(f.registrations[0]!.completion);
 f.closeRelease.resolve();await assert.rejects(request);await cancellation;await f.registrations[0]!.completion;
 assert.equal(f.stats.closes,1);assert.equal(f.stats.prepared,0);assert.equal(f.stats.terminal,0);assert.equal(f.stats.unpublishedCancel,1);assert.equal(f.stats.publishedCancel,0);
});

test('synchronous connector retirement uses the existing original registration and one compensation',async t=>{
 const f=await fixture(t,{cancelInsideConnect:true,holdClose:true}),request=f.prepare();void request.catch(()=>{});await f.closeEntered.promise;
 const cancellation=f.insideCancellation();assert.ok(cancellation);await stillPending(cancellation);f.closeRelease.resolve();await assert.rejects(request);await cancellation;
 assert.equal(f.stats.connects,1);assert.equal(f.stats.closes,1);assert.equal(f.stats.unpublishedCancel,1);assert.equal(f.stats.prepared,0);assert.equal(f.stats.terminal,0);
});

for(const requestError of [Error('prepared refusal A'),null,undefined])test('unpublished callback refusal preserves request error while positive cleanup completes accounting '+String(requestError),async t=>{
 const f=await fixture(t,{preparedFailure:{value:requestError}});
 await assert.rejects(f.prepare(),error=>error===requestError);assert.equal(f.registrations.length,1);await f.registrations[0]!.completion;
 assert.equal(f.stats.prepared,0);assert.equal(f.stats.terminal,0);assert.equal(f.stats.closes,1);await f.coordinator.cancel(f.id,'after-ordinary-request-refusal');
});

for(const cleanupError of [Error('cleanup B'),null,undefined])test('request A and failed original cleanup B remain separate actual service outcomes '+String(cleanupError),async t=>{
 const requestError=Error('prepared refusal A'),f=await fixture(t,{preparedFailure:{value:requestError},closeFailure:{value:cleanupError}});
 await assert.rejects(f.prepare(),error=>error===requestError);await assert.rejects(f.registrations[0]!.completion,error=>error===cleanupError);
 await assert.rejects(f.coordinator.cancel(f.id,'cleanup-failed'),error=>error===cleanupError);assert.equal(f.stats.prepared,0);assert.equal(f.stats.terminal,0);assert.equal(f.stats.closes,1);
});

test('published cancellation chooses only cancelExact and joins its original terminal callback',async t=>{
 const f=await fixture(t,{holdClose:true}),job=await f.prepare();assert.equal(f.stats.prepared,1);await stillPending(f.registrations[0]!.completion);
 const cancellation=f.coordinator.cancel(f.id,'published-job');void cancellation.catch(()=>{});await f.closeEntered.promise;await stillPending(cancellation);
 assert.equal(f.stats.publishedCancel,1);assert.equal(f.stats.unpublishedCancel,0);f.closeRelease.resolve();await cancellation;await f.registrations[0]!.completion;
 assert.equal(f.stats.closes,1);assert.equal(f.stats.terminal,1);assert.equal(f.packets[0]?.jobId,job.id);
});

test('original published handle survives actual64-row presentation eviction',{timeout:30000},async t=>{
 const f=await fixture(t),first=await f.prepare();await f.service.requests.cancel(first.id,ACTOR);await f.registrations[0]!.completion;
 for(let index=0;index<64;index++){const job=await f.prepare('human');await f.service.requests.cancel(job.id,'human');}
 assert.equal(f.service.requests.list('human').length,64);assert.throws(()=>f.service.requests.status(first.id,ACTOR),{code:'HUMAN_AUTH_REQUIRED'});
 await f.service.cancelExact(first.id,f.origin);assert.equal(f.stats.closes,65);assert.equal(f.stats.connects,65);await f.coordinator.cancel(f.id,'retire-retained-original');
});


test('actual advancing revalidation stays joined through fresh held connector and original reader close',{timeout:30000},async t=>{
 const f=await fixture(t,{scenario:true,holdRevalidationConnect:true,holdRevalidationClose:true}),job=await f.prepare();
 await f.service.humanControl.approve({id:job.id,displayDigest:job.displayDigest},()=>{});
 const deadline=Date.now()+20000;while(f.packets.length===0){assert.ok(Date.now()<deadline,'original measured fixture controller must settle');await new Promise(resolve=>setTimeout(resolve,10));}
 await f.registrations[0]!.completion;f.finishTurn();await f.revalidationEntered.promise;assert.equal(f.registrations.length,2);assert.equal(f.registrations[1]?.kind,'revalidate');
 const cancellation=f.coordinator.cancel(f.id,'held-source-revalidation');void cancellation.catch(()=>{});await stillPending(cancellation);
 const calls=f.stats.sdkCalls;f.connectRelease.resolve();await f.readerCloseEntered.promise;assert.equal(f.stats.sdkCalls,calls,'retired fresh reader makes no new tool dispatch');await stillPending(cancellation);await stillPending(f.registrations[1]!.completion);
 f.closeRelease.resolve();await cancellation;await f.registrations[1]!.completion;assert.equal(f.stats.connects,2);assert.equal(f.stats.closes,2);assert.equal(f.stats.unpublishedCancel,1);
});


test('repeated healthy-cleanup preparation refusals remove their listener from the still-active original task signal',{timeout:30000},async t=>{
 const requestError=Error('ordinary prepared refusal'),f=await fixture(t,{preparedFailure:{value:requestError}});
 for(let index=0;index<70;index++){
  await assert.rejects(f.prepare(),error=>error===requestError);await f.registrations[index]!.completion;
  const signal=f.workSignals[index];assert.ok(signal);assert.equal(signal,f.workSignals[0]);assert.equal(signal.aborted,false);
  assert.equal(getEventListeners(signal,'abort').length,f.listenerBaselines[0],'successful provisional lifetime removes exactly its release listener');
 }
 assert.equal(f.stats.connects,70);assert.equal(f.stats.closes,70);assert.equal(f.stats.prepared,0);assert.equal(f.stats.terminal,0);
 await f.coordinator.cancel(f.id,'ordinary-refusals-remain-healthy');
});
