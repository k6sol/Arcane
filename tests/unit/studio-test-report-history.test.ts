import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join,relative,isAbsolute } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema,ListToolsRequestSchema,type CallToolResult,type Tool } from '@modelcontextprotocol/sdk/types.js';
import { createStudioTestService,type NativeTestConnection,type StudioTestService } from '../../apps/daemon/src/studio-test-service.js';
import { openStudioTestReportStore,type StudioTestReportWriter,type StudioTestReportStore } from '../../apps/daemon/src/studio-test-report-store.js';
import { StudioStore } from '../../packages/storage/src/studio-store.js';
import {workflowProjectIdentity} from '../../packages/storage/src/workflow-store.js';
import { digest,reviewedTestTools,readTestLedger } from '../../packages/studio-test-controller/src/index.js';
import { buildScenarioProgram } from '../../packages/studio-test-controller/src/scenario-runtime.js';
import { fixtureScenario,runScenarioFixture,type ScenarioFixtureOptions } from '../../packages/studio-test-controller/testing/scenario-fixture.js';
import type { StudioTestTaskPort,StudioTestTaskOrigin,StudioTestTaskSettled } from '../../packages/protocol/src/chat-task-playtest.js';
import { makeFixtureDirectory,fixtureTempDirectory } from './windows-fixture-paths.js';

// Actual service/controller, SDK Client/Server, SQLite and safety ledger. The peer and
// standalone-Luau physics/input are controlled fixtures, never native Studio proof.
const ARTIFACT='b'.repeat(64),ACTOR='agent-private-bearer-derived-fixture',STUDIO='report-history-peer',NAME='Report history fixture';
const text=(v:unknown):CallToolResult=>({content:[{type:'text',text:typeof v==='string'?v:JSON.stringify(v)}]});
const tools:Tool[]=[...structuredClone(reviewedTestTools),{name:'execute_luau',inputSchema:{type:'object',properties:{studio_id:{type:'string'},datamodel_type:{type:'string',enum:['Edit','Client','Server']},code:{type:'string'}},required:['studio_id','datamodel_type','code']}}];
const guard=()=>{};
async function until(predicate:()=>boolean){const end=Date.now()+10000;while(!predicate()){assert.ok(Date.now()<end,'controlled history service did not settle');await new Promise(resolve=>setTimeout(resolve,10));}}
async function fixture(t:TestContext,options:{scenario?:boolean;runtime?:ScenarioFixtureOptions;closeFailure?:Error;writer?:(store:StudioTestReportStore)=>StudioTestReportWriter;task?:boolean}={}){
  const root=makeFixtureDirectory('arcane-playtest-history-'),directory=join(root,'playtests'),reportDirectory=join(root,'reports');
  const projectId=workflowProjectIdentity(root).projectId;
  const store=new StudioStore({directory:join(root,'studio')}),reports=await openStudioTestReportStore({directory:reportDirectory,projectId,exclusiveWriter:()=>true});
  const services:StudioTestService[]=[],connections:NativeTestConnection[]=[],packets:StudioTestTaskSettled[]=[],reportStores:StudioTestReportStore[]=[reports];
  let heartbeat:ReturnType<typeof setInterval>|undefined;
  t.after(async()=>{clearInterval(heartbeat);try{for(const s of services)try{await s.lifecycle.close();}catch(e){assert.equal(e,options.closeFailure);}
      for(const c of connections)await c.close();}finally{for(const r of reportStores)r.close();store.close();const inside=relative(fixtureTempDirectory(),root);assert.ok(!isAbsolute(inside)&&inside.startsWith('arcane-playtest-history-')&&!inside.startsWith('..'));rmSync(root,{recursive:true,force:true});}});
  const grant=store.createGrant({allowedRoots:['Workspace','ServerStorage'],allowWrites:true});
  const pair=store.pair({code:grant.code,protocolVersion:1,identity:{clientSessionId:'report-plugin-life',placeId:0,universeId:0,name:NAME,pluginVersion:'fixture'},capabilities:['scene.children']});
  const state={mode:'Edit' as 'Edit'|'Play',epoch:10,connects:0,closes:0,starts:0,stops:0,clientPrograms:0,prepared:0};
  const origin:StudioTestTaskOrigin=Object.freeze({kind:'studio-test-task-origin',taskId:'33333333-3333-4333-8333-333333333333',projectId,provider:'codex',threadId:'fixture-thread',sessionId:null,incarnationId:'44444444-4444-4444-8444-444444444444'});
  const plan=fixtureScenario();plan.capture.required=false;
  const publish=()=>{store.authenticate(pair.sessionId,pair.token);return store.poll(pair.sessionId,{sessionId:pair.sessionId,clientLifetimeId:'report-plugin-life',pluginArtifactHash:ARTIFACT,
    markerName:'ArcaneTestProof_report_history',placeId:0,universeId:0,placeName:NAME,mode:state.mode,playEpoch:state.epoch,continuitySupported:true,connected:true});};
  publish();heartbeat=setInterval(()=>assert.deepEqual(publish(),[]),250);
  const taskPort:StudioTestTaskPort={capture(actor){assert.equal(actor,ACTOR);return origin;},assert(value){assert.equal(value,origin);},prepared(value,job){assert.equal(value,origin);state.prepared++;
      // A fault writer may intentionally refuse storage; actual admitted records precede this callback otherwise.
      if(!options.writer)assert.equal(reports.get(job.jobId,guard)?.snapshot,'admission');},terminal(value,packet){assert.equal(value,origin);packets.push(packet);}};
  const connect=async():Promise<NativeTestConnection>=>{
    state.connects++;const client=new Client({name:'report-history-fixture-client',version:'fixture-only'}),server=new Server({name:'fixture-not-RobloxStudio',version:'fixture-only'},{capabilities:{tools:{}}});
    const [a,b]=InMemoryTransport.createLinkedPair();
    server.setRequestHandler(ListToolsRequestSchema,()=>({tools:structuredClone(tools)}));
    server.setRequestHandler(CallToolRequestSchema,async request=>{
      const {name,arguments:args={}}=request.params;
      if(name==='list_roblox_studios')return text({studios:[{id:STUDIO,name:NAME}]});assert.equal(args.studio_id,STUDIO);
      if(name==='get_studio_state')return text(state.mode==='Edit'?'- Current Studio Mode: Edit\n- Available DataModels: Edit\n- Focused DataModel in the viewport: Edit':'- Current Studio Mode: Play\n- Available DataModels: Client, Server\n- Focused DataModel in the viewport: Client');
      if(name==='get_console_output')return text('');
      if(name==='start_stop_play'){
        const records=await readTestLedger(join(directory,'ledger'),directory);assert.equal(records.at(-1)?.event.kind,args.is_start?'start_intent':'stop_intent');
        if(args.is_start)state.starts++;else state.stops++;state.mode=args.is_start?'Play':'Edit';state.epoch++;assert.deepEqual(publish(),[]);return text('controlled ACK');
      }
      assert.equal(name,'execute_luau');
      if(args.datamodel_type==='Edit'){assert.ok(String(args.code).includes('ScriptEditorService'));return text({schemaVersion:1,sessionId:pair.sessionId,clientLifetimeId:'report-plugin-life',pluginArtifactHash:ARTIFACT,nodes:4,sourceCount:1,
        sources:{s1:{root:'Workspace',path:['FixtureScript'],identity:'controlled-original-script',className:'Script',enabled:true,source:'print("fixture")',editorSource:'print("fixture")'}}});}
      assert.equal(args.datamodel_type,'Client');const last=(await readTestLedger(join(directory,'ledger'),directory)).at(-1);assert.equal(last?.event.kind,'scenario_intent');assert.ok(last);
      assert.equal(args.code,buildScenarioProgram(plan,last.event.id,digest(plan)));state.clientPrograms++;
      return text(runScenarioFixture(plan,options.runtime,last.event.id,String(args.code)).report);
    });
    await server.connect(b);await client.connect(a);let closed=false;
    const connection:NativeTestConnection={client,evidence:'fixture',async witness(studioId,marker,mode,signal){assert.equal(studioId,STUDIO);assert.equal(marker,'ArcaneTestProof_report_history');assert.equal(mode,state.mode);assert.equal(signal.aborted,false);
      return {placeId:0,universeId:0,placeName:NAME,sessionId:pair.sessionId,clientLifetimeId:'report-plugin-life',pluginArtifactHash:ARTIFACT};},async close(){if(closed)return;closed=true;state.closes++;await client.close();await server.close();if(options.closeFailure)throw options.closeFailure;}};
    connections.push(connection);return connection;
  };
  const writer=options.writer?.(reports)??reports;
  const openService=async()=>{const service=await createStudioTestService({directory,store,custody:store.bindNativeCustody(projectId,join(root,'studio')),pluginArtifactHash:ARTIFACT,connect,reports:writer,...(options.task?{taskPort}:{})});services.push(service);return service;};
  const service=await openService();
  const openReports=async()=>{const r=await openStudioTestReportStore({directory:reportDirectory,projectId,exclusiveWriter:()=>true});reportStores.push(r);return r;};
  const prepare=()=>service.requests.prepare({sessionId:pair.sessionId,nativeStudioId:STUDIO,durationMs:5000,observationIntervalMs:250,failOnRuntimeError:true,...(options.scenario?{scenario:plan}:{})},ACTOR);
  return {root,directory,reportDirectory,store,reports,service,openService,openReports,state,packets,prepare};
}

test('actual service admission and pending cancellation retain actor-free history across 65 jobs and reopen',{timeout:30000},async t=>{
  const f=await fixture(t);let first='';
  for(let n=0;n<65;n++){const job=await f.prepare();if(!n)first=job.id;assert.equal(f.reports.get(job.id,guard)?.snapshot,'admission');
    const cancelled=await f.service.requests.cancel(job.id,ACTOR);assert.equal(cancelled.actor,ACTOR);assert.equal(cancelled.state,'cancelled');assert.equal(f.reports.get(job.id,guard)?.snapshot,'terminal');}
  assert.throws(()=>f.service.requests.status(first,ACTOR),{code:'HUMAN_AUTH_REQUIRED'});assert.ok(f.reports.get(first,guard));assert.equal(f.state.starts,0);assert.equal(f.state.stops,0);assert.equal(f.state.closes,65);
  assert.ok(!JSON.stringify(f.reports.get(first,guard)).includes(ACTOR));await f.service.lifecycle.close();f.reports.close();
  const before=f.state.connects,reopened=await f.openReports();
  assert.equal(reopened.get(first,guard)?.observedState,'cancelled');assert.equal(reopened.list({cursor:null},guard).reports.length,8);assert.equal(f.state.connects,before,'historical reads do not open native clients');
});

test('actual measured scenario failure is archived before original task settlement without changing its digest',{timeout:15000},async t=>{
  const f=await fixture(t,{scenario:true,task:true,runtime:{immobile:true}}),job=await f.prepare();assert.equal(f.state.prepared,1);
  await f.service.humanControl.approve({id:job.id,displayDigest:job.displayDigest},guard);await until(()=>f.packets.length===1);
  const actual=f.service.requests.status(job.id,ACTOR),retained=f.reports.get(job.id,guard);assert.ok(retained);
  assert.equal(actual.review.code,'ASSERTION_FAILED');assert.equal(actual.review.outcome,'failed');assert.equal(actual.review.cleanup,'complete');assert.equal(f.state.clientPrograms,1);
  assert.deepEqual(retained.review,actual.review);assert.deepEqual(retained.display,actual.display);assert.equal(retained.taskId,'33333333-3333-4333-8333-333333333333');
  assert.ok(retained.review.scenario?.steps.some(row=>row.outcome==='failed'));assert.equal(f.packets[0]?.reportDigest,digest(actual));assert.equal(f.state.starts,1);assert.equal(f.state.stops,1);assert.equal(f.state.closes,1);
  assert.deepEqual(f.service.reportArchiveStatus?.(),{state:'ready',code:null});
});

test('unknown actual input cleanup remains readable when the reopened live safety ledger is fenced',{timeout:15000},async t=>{
  const f=await fixture(t,{scenario:true,runtime:{releaseError:true}}),job=await f.prepare();
  await f.service.humanControl.approve({id:job.id,displayDigest:job.displayDigest},guard);await until(()=>f.reports.get(job.id,guard)?.snapshot==='terminal');
  const actual=f.service.requests.status(job.id,ACTOR);assert.equal(actual.review.cleanup,'unknown');assert.equal(actual.review.scenario?.inputRelease,'unknown');
  assert.deepEqual(f.reports.get(job.id,guard)?.review,actual.review);await f.service.lifecycle.close();const before=f.state.connects;
  await assert.rejects(f.openService(),{code:'FENCED'});assert.equal(f.state.connects,before);
  f.reports.close();const reopened=await f.openReports();
  assert.equal(reopened.get(job.id,guard)?.review.cleanup,'unknown');assert.equal(reopened.get(job.id,guard)?.review.requiresHumanReview,true);assert.equal(f.state.connects,before);
});

test('archive writer and failure-recorder exceptions never change cancellation or original task evidence',async t=>{
  let admissions=0,terminals=0,notes=0;
  const f=await fixture(t,{task:true,writer:reports=>({projectId:reports.projectId,recordAdmission(){admissions++;return {stored:false,code:'ARCHIVE_WRITE'};},recordTerminal(){terminals++;throw new Error('PRIVATE_ARCHIVE_FAILURE');},noteFailure(){notes++;throw new Error('PRIVATE_RECORDER_FAILURE');}})});
  const job=await f.prepare(),cancelled=await f.service.requests.cancel(job.id,ACTOR);
  assert.equal(admissions,1);assert.equal(terminals,1);assert.equal(notes,2);assert.equal(f.state.prepared,1);assert.equal(f.packets.length,1);
  assert.equal(cancelled.state,'cancelled');assert.equal(cancelled.review.cleanup,'not_started');assert.equal(f.state.starts,0);assert.equal(f.state.stops,0);assert.equal(f.state.closes,1);
  assert.equal(f.packets[0]?.reportDigest,digest(cancelled));assert.deepEqual(f.service.reportArchiveStatus?.(),{state:'degraded',code:'ARCHIVE_WRITE'});
  assert.ok(!JSON.stringify(f.service.reportArchiveStatus?.()).includes('PRIVATE'));
});

test('archive faults cannot replace an original SDK-close rejection or fabricate task settlement',async t=>{
  const original=new Error('controlled original close failure');let archived=0;
  const f=await fixture(t,{task:true,closeFailure:original,writer:reports=>({projectId:reports.projectId,recordAdmission(){return {stored:true};},recordTerminal(){archived++;throw new Error('archive rejected');},noteFailure(){throw new Error('recorder rejected');}})});
  const job=await f.prepare();await assert.rejects(f.service.requests.cancel(job.id,ACTOR),error=>error===original);
  assert.equal(archived,1);assert.equal(f.state.closes,1);assert.equal(f.packets.length,0,'the original failed-close path never sent a task terminal');
  assert.equal(f.state.starts,0);assert.deepEqual(f.service.reportArchiveStatus?.(),{state:'degraded',code:'ARCHIVE_WRITE'});
});
