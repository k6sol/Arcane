import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,mkdir,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {isAbsolute,join,relative,sep} from 'node:path';
import {createServer} from 'node:http';
import {createCodexService,type CodexServiceOptions,type CodexActionRecord,type CodexHostClient} from '../../apps/daemon/src/codex-service.js';
import {codexRoutes} from '../../apps/daemon/src/codex-routes.js';
import type {FailureReporter} from '../../apps/daemon/src/diagnostic-reporter.js';
import {CodexClientError,type Snapshot} from '../../packages/codex-client/src/index.js';
import {diagnosticEvent,type DiagnosticEvent} from '../../packages/diagnostics/src/report.js';
import {createNativeAssetRegistry,type NativeAssetRegistry} from '../../apps/daemon/src/native-asset-authority.js';

const PRIVATE='private prompt/source C:\\Users\\fixture\\scene.lua account@example.invalid token=synthetic';
async function fixture(t:test.TestContext,options:{
  reportFailure?:FailureReporter;connect?:CodexServiceOptions['connect'];
  registry?:(projectPath:string)=>NativeAssetRegistry;
}={}){
  const boundary=await realpath(tmpdir()),root=await mkdtemp(join(boundary,'arcane-codex-report-')),project=join(root,'project'),directory=join(root,'journal');
  await mkdir(project);const projectPath=await realpath(project),registry=options.registry?.(projectPath);
  let connects=0;
  const services:ReturnType<typeof createCodexService>[]=[];
  const open=()=>{
    const service=createCodexService({directory,projectPath,...(registry?{assetRegistry:registry}:{}),...(options.reportFailure?{reportFailure:options.reportFailure}:{}),
      connect:async hooks=>{connects++;if(options.connect)return options.connect(hooks);throw new CodexClientError('CLI_MISSING',PRIVATE);}});
    services.push(service);return service;
  };
  const service=open(),filename=join(directory,'codex-actions.sqlite'),inspector=new DatabaseSync(filename,{readOnly:true,allowExtension:false});
  const record=(requestId:string):CodexActionRecord=>{
    const row=inspector.prepare('SELECT payload FROM actions WHERE id=?').get(requestId) as {payload:string}|undefined;
    assert.ok(row);return JSON.parse(row.payload) as CodexActionRecord;
  };
  t.after(async()=>{
    for(const service of services.reverse())await service.close();
    inspector.close();registry?.close();
    const part=relative(boundary,await realpath(root));assert.ok(part.startsWith('arcane-codex-report-')&&!isAbsolute(part)&&!part.includes(sep)&&!part.includes('..'));
    await rm(root,{recursive:true,force:true});
  });
  return{service,open,record,filename,connects:()=>connects};
}

test('a newly committed rejection reports once; state GETs and exact request replays do not report',{timeout:5000},async t=>{
  const events:DiagnosticEvent[]=[],observed:string[]=[];let read:(id:string)=>CodexActionRecord=()=>assert.fail('report before fixture ready');
  const f=await fixture(t,{reportFailure:event=>{events.push(event);observed.push(read(event.context!.operationId!).state);return Promise.resolve(event.eventId);}});read=f.record;
  await assert.rejects(f.service.action({requestId:randomUUID(),connectionId:null,action:'connect',reportFailure:'not a host callback'}),{code:'ARGUMENTS'});
  assert.deepEqual([...events],[]);assert.equal(f.connects(),0);
  const input={requestId:randomUUID(),connectionId:null,action:'connect'} as const,outcome=await f.service.action(input);
  assert.equal(outcome.record.state,'rejected');assert.equal(outcome.record.errorCode,'CLI_MISSING');
  assert.equal(outcome.replayed,false);assert.deepEqual(observed,['rejected']);assert.equal(events.length,1);assert.deepEqual(events[0]!.context,{operationId:input.requestId});
  assert.equal(events[0]!.component,'chat');assert.equal(events[0]!.stage,'authenticate');assert.equal(events[0]!.code,'PROCESS_LAUNCH');
  assert.deepEqual(diagnosticEvent(events[0]),events[0]);assert.ok(f.record(input.requestId).finishedAt);
  assert.doesNotMatch(JSON.stringify(events),/private|scene\.lua|account@|synthetic/);
  assert.equal((await f.service.action(input)).replayed,true);for(let i=0;i<3;i++)f.service.state();
  const token='a'.repeat(64),agent='b'.repeat(64),route=codexRoutes(f.service);let origin='';
  const server=createServer((request,response)=>{void route(request,response,new URL(request.url??'/',origin),token,origin,agent).catch(()=>response.destroy());});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
  t.after(async()=>{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));});
  for(const path of ['/v1/codex/state','/v1/codex/history']){
    const response=await fetch(origin+path,{headers:{Authorization:'Bearer '+token,Origin:origin},signal:AbortSignal.timeout(1000)});
    assert.equal(response.status,200);await response.arrayBuffer();
  }
  assert.equal(events.length,1);assert.equal(f.connects(),1);
});

for(const [code,dispatched,expected]of[['TIMEOUT',true,'unknown'],['REMOTE_REJECTED',true,'rejected']]as const)
test('reported '+code+' preserves actual '+expected+' receipt and never redispatches',{timeout:5000},async t=>{
  const events:DiagnosticEvent[]=[];
  const f=await fixture(t,{reportFailure:async event=>{events.push(event);return event.eventId;},connect:async()=>{throw new CodexClientError(code,PRIVATE,dispatched);}});
  const input={requestId:randomUUID(),connectionId:null,action:'connect'} as const,result=await f.service.action(input);
  assert.equal(result.record.state,expected);assert.equal(f.record(input.requestId).state,expected);assert.equal(events.length,1);
  assert.equal(events[0]!.code,code==='TIMEOUT'?'REQUEST_TIMEOUT':'REQUEST_REJECTED');
  assert.equal((await f.service.action(input)).replayed,true);assert.equal(events.length,1);assert.equal(f.connects(),1);
});

test('a refused prompt reports no text, source, paths, native identities or account fields',{timeout:5000},async t=>{
  const events:DiagnosticEvent[]=[],f=await fixture(t,{reportFailure:async event=>{events.push(event);return null;}});
  const input={requestId:randomUUID(),connectionId:randomUUID(),action:'turn-start',threadId:'private-native-thread',text:PRIVATE,displayText:'private visible prompt'} as const;
  const result=await f.service.action(input);assert.equal(result.record.state,'rejected');assert.equal(result.record.errorCode,'STALE_CONNECTION');
  assert.equal(events.length,1);assert.deepEqual(events[0]!.context,{operationId:input.requestId});assert.equal(events[0]!.stage,'request-submit');
  assert.equal(events[0]!.code,'CONNECTION_UNAVAILABLE');assert.doesNotMatch(JSON.stringify(events),/private|native-thread|account@|scene\.lua|synthetic/);assert.equal(f.connects(),0);
});

for(const behavior of ['throw','reject','never-resolve']as const)test('diagnostic '+behavior+' cannot delay or change a durable chat failure',{timeout:5000},async t=>{
  let called!:()=>void;const reported=new Promise<void>(resolve=>called=resolve);
  const reportFailure:FailureReporter=()=>{called();if(behavior==='throw')throw Error(PRIVATE);if(behavior==='reject')return Promise.reject(Error(PRIVATE));return new Promise<string|null>(()=>{});};
  const f=await fixture(t,{reportFailure}),input={requestId:randomUUID(),connectionId:null,action:'connect'} as const;
  const result=await f.service.action(input);await reported;
  assert.equal(result.record.state,'rejected');assert.equal(result.record.errorCode,'CLI_MISSING');assert.equal(f.record(input.requestId).state,'rejected');assert.equal(f.connects(),1);
  await new Promise<void>(resolve=>setImmediate(resolve)); // Let the detached rejection handler settle.
});

test('uncommitted terminal failures and recovered pending rows never produce new failure reports',{timeout:5000},async t=>{
  const events:DiagnosticEvent[]=[],f=await fixture(t,{reportFailure:async event=>{events.push(event);return null;}});
  const writer=new DatabaseSync(f.filename,{allowExtension:false});
  writer.exec("CREATE TRIGGER refuse_terminal BEFORE UPDATE ON actions BEGIN SELECT RAISE(ABORT,'synthetic terminal commit refusal'); END;");
  const input={requestId:randomUUID(),connectionId:null,action:'connect'} as const;
  try{await assert.rejects(f.service.action(input),{code:'JOURNAL_FAILURE'});assert.equal(f.record(input.requestId).state,'pending');assert.deepEqual([...events],[]);}
  finally{writer.exec('DROP TRIGGER refuse_terminal');writer.close();}
  await f.service.close();const recovered=f.open();assert.equal(recovered.state().actions.find(row=>row.requestId===input.requestId)!.state,'unknown');
  assert.equal((await recovered.action(input)).replayed,true);assert.deepEqual([...events],[]);assert.equal(f.connects(),1);
});

function labelledClient(){
  const connectionId=randomUUID(),state:Snapshot={connectionId,provenance:'spawned-node-fixture',mcpIsolation:'arcane-only-verified',connected:true,ready:true,
    account:{auth:'subscription',plan:null,requiresOpenaiAuth:true},models:[],selection:{model:'fixture-model',effort:'low'},thread:null,
    operations:[],approvals:[],events:[],droppedEvents:0,lastEventSeq:0,failureCode:null};
  const client:CodexHostClient={snapshot:()=>structuredClone(state),selectModel(){return{model:'fixture-model',effort:'low'};},
    async startThread(){state.thread={threadId:'fixture-thread',sessionId:null,selection:{model:'fixture-model',effort:'low'},configured:true,writeGranted:false,turnId:null,turnStatus:'idle'};return structuredClone(state.thread);},
    async resumeThread(){throw Error('No fixture resume');},grantThreadWrites(){throw Error('No fixture writes');},revokeThreadWrites(){},
    async startTurn(){throw Error('No fixture turn');},async interruptTurn(){throw Error('No fixture interruption');},respondApproval(){throw Error('No fixture approval');},
    async close(){state.connected=false;state.ready=false;},
  };return{client,connectionId};
}
test('a post-commit asset grant conversion reports the final durable unknown receipt exactly once',{timeout:5000},async t=>{
  const events:DiagnosticEvent[]=[],observed:string[]=[];let read:(id:string)=>CodexActionRecord=()=>assert.fail('fixture not ready'),grants=0;
  const {client,connectionId}=labelledClient();
  const f=await fixture(t,{reportFailure:event=>{events.push(event);observed.push(read(event.context!.operationId!).state);return Promise.resolve(null);},
    registry:projectPath=>{const registry=createNativeAssetRegistry({projectPath});return Object.freeze({...registry,issue(){const handle=registry.issue();return Object.freeze({...handle,grant(){grants++;throw Error(PRIVATE);}});}});},
    connect:async hooks=>{assert.ok(hooks);hooks.finalCredential();return client;}});read=f.record;
  assert.equal((await f.service.action({requestId:randomUUID(),connectionId:null,action:'connect'})).record.state,'acknowledged');
  assert.equal((await f.service.action({requestId:randomUUID(),connectionId,action:'thread-start'})).record.state,'acknowledged');assert.deepEqual([...events],[]);
  const input={requestId:randomUUID(),connectionId,action:'grant-assets',threadId:'fixture-thread'} as const,result=await f.service.action(input);
  assert.equal(result.record.state,'unknown');assert.equal(result.record.errorCode,'ASSET_AUTHORITY');assert.equal(f.record(input.requestId).state,'unknown');
  assert.equal(grants,1);assert.deepEqual(observed,['unknown']);assert.equal(events.length,1);assert.equal(events[0]!.stage,'tool-approval');assert.equal(events[0]!.code,'HOST_FAILURE');
  assert.deepEqual(events[0]!.context,{operationId:input.requestId});assert.equal(result.state.nativeAssets?.granted,false);
  assert.equal((await f.service.action(input)).replayed,true);assert.equal(events.length,1);assert.equal(grants,1);
});

for(const requestId of ['00000000-0000-0000-0000-000000000000','ffffffff-ffff-ffff-ffff-ffffffffffff','A7F9DA50-55BD-46CE-9DF9-24826FD66139'])
test('terminal reporting retains canonical request correlation '+requestId,{timeout:5000},async t=>{
  const events:DiagnosticEvent[]=[],f=await fixture(t,{reportFailure:async event=>{events.push(event);return event.eventId;}});
  const input={requestId,connectionId:null,action:'connect'}as const,result=await f.service.action(input);
  assert.equal(result.record.requestId,requestId);assert.equal(result.record.state,'rejected');assert.equal(f.record(requestId).state,'rejected');
  assert.equal(events.length,1);assert.deepEqual(events[0]!.context,{operationId:requestId.toLowerCase()});assert.deepEqual(diagnosticEvent(events[0]),events[0]);
  assert.equal((await f.service.action(input)).replayed,true);assert.equal(events.length,1);assert.equal(f.connects(),1);
});
