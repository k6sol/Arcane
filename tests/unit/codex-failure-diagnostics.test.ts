import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,mkdir,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {isAbsolute,join,relative,sep} from 'node:path';
import {createServer,request,type ClientRequest} from 'node:http';
import {createCodexService,type CodexServiceOptions,type CodexActionRecord,type CodexHostClient} from '../../apps/daemon/src/codex-service.js';
import {codexRoutes} from '../../apps/daemon/src/codex-routes.js';
import type {FailureReporter} from '../../apps/daemon/src/diagnostic-reporter.js';
import {CodexClientError,type Snapshot} from '../../packages/codex-client/src/index.js';
import {diagnosticEvent,type DiagnosticEvent} from '../../packages/diagnostics/src/report.js';
import {createNativeAssetRegistry,type NativeAssetRegistry} from '../../apps/daemon/src/native-asset-authority.js';
import {JsonlTransport,annotateNativeConnectFrame,readNativeFrameEvidence} from '../../packages/codex-client/src/transport.js';
import {limits} from '../../packages/codex-client/src/validation.js';

const PRIVATE='private prompt/source C:\\Users\\fixture\\scene.lua account@example.invalid token=synthetic';
type ReportPhase='case-start'|'fixture-boundary'|'fixture-directory'|'fixture-project'|'service-open'|'inspector-open'|
  'invalid-admission'|'rejection-action'|'rejection-assertions'|'exact-replay'|'state-direct'|'http-listen'|'http-state'|'http-history'|
  'final-assertions'|'body-complete'|'http-close'|'http-closed'|'service-close'|'inspector-close'|'registry-close'|'directory-check'|'directory-remove'|'fixture-closed';
interface PhaseObservation {mark:(phase:ReportPhase)=>void;failure:()=>void}
async function fixture(t:test.TestContext,options:{
  reportFailure?:FailureReporter;connect?:CodexServiceOptions['connect'];
  registry?:(projectPath:string)=>NativeAssetRegistry;
  observation?:PhaseObservation;
}={}){
  options.observation?.mark('fixture-boundary');const boundary=await realpath(tmpdir());
  options.observation?.mark('fixture-directory');const root=await mkdtemp(join(boundary,'arcane-codex-report-')),project=join(root,'project'),directory=join(root,'journal');
  options.observation?.mark('fixture-project');await mkdir(project);const projectPath=await realpath(project),registry=options.registry?.(projectPath);
  let connects=0;
  const services:ReturnType<typeof createCodexService>[]=[];
  const open=()=>{
    options.observation?.mark('service-open');
    const service=createCodexService({directory,projectPath,...(registry?{assetRegistry:registry}:{}),...(options.reportFailure?{reportFailure:options.reportFailure}:{}),
      connect:async hooks=>{connects++;if(options.connect)return options.connect(hooks);throw new CodexClientError('CLI_MISSING',PRIVATE);}});
    services.push(service);return service;
  };
  const service=open(),filename=join(directory,'codex-actions.sqlite');options.observation?.mark('inspector-open');const inspector=new DatabaseSync(filename,{readOnly:true,allowExtension:false});
  const record=(requestId:string):CodexActionRecord=>{
    const row=inspector.prepare('SELECT payload FROM actions WHERE id=?').get(requestId) as {payload:string}|undefined;
    assert.ok(row);return JSON.parse(row.payload) as CodexActionRecord;
  };
  t.after(async()=>{
    try{
      options.observation?.mark('service-close');for(const service of services.reverse())await service.close();
      options.observation?.mark('inspector-close');inspector.close();options.observation?.mark('registry-close');registry?.close();
      options.observation?.mark('directory-check');const part=relative(boundary,await realpath(root));assert.ok(part.startsWith('arcane-codex-report-')&&!isAbsolute(part)&&!part.includes(sep)&&!part.includes('..'));
      options.observation?.mark('directory-remove');await rm(root,{recursive:true,force:true});options.observation?.mark('fixture-closed');
    }catch(error){options.observation?.failure();throw error;}
  });
  return{service,open,record,filename,connects:()=>connects};
}

test('a newly committed rejection reports once; state GETs and exact request replays do not report',{timeout:5000},async t=>{
  const started=performance.now(),phases:{phase:ReportPhase;at:number}[]=[{phase:'case-start',at:0}],requests=new Set<ClientRequest>();
  let phase:ReportPhase='case-start',dropped=0,reported=false,fixtureClosed=false,httpClosed=false;
  const boundedMs=(value:number)=>Math.min(60000,Math.max(0,Math.round(value)));
  const failure=()=>{
    if(reported)return;reported=true;const elapsed=performance.now()-started;
    try{t.diagnostic(JSON.stringify({fixture:'codex-report-committed-rejection',phase,elapsedMs:boundedMs(elapsed),clipped:elapsed>60000,droppedPhases:dropped,
      phases:phases.map((row,index)=>({phase:row.phase,durationMs:boundedMs((phases[index+1]?.at??elapsed)-row.at)}))}));}catch{/* Never replace the original failure. */}
  };
  const aborted=()=>{failure();for(const request of requests)request.destroy();};
  const observation:PhaseObservation={failure,mark(next){phase=next;if(phases.length<32)phases.push({phase:next,at:performance.now()-started});else dropped++;
    if(next==='fixture-closed')fixtureClosed=true;if(next==='http-closed')httpClosed=true;
    if(fixtureClosed&&httpClosed)t.signal.removeEventListener('abort',aborted);
  }};
  t.signal.addEventListener('abort',aborted,{once:true});
  try{
  const events:DiagnosticEvent[]=[],observed:string[]=[];let read:(id:string)=>CodexActionRecord=()=>assert.fail('report before fixture ready');
  const f=await fixture(t,{observation,reportFailure:event=>{events.push(event);observed.push(read(event.context!.operationId!).state);return Promise.resolve(event.eventId);}});read=f.record;
  observation.mark('invalid-admission');
  await assert.rejects(f.service.action({requestId:randomUUID(),connectionId:null,action:'connect',reportFailure:'not a host callback'}),{code:'ARGUMENTS'});
  assert.deepEqual([...events],[]);assert.equal(f.connects(),0);
  observation.mark('rejection-action');
  const input={requestId:randomUUID(),connectionId:null,action:'connect'} as const,outcome=await f.service.action(input);
  observation.mark('rejection-assertions');
  assert.equal(outcome.record.state,'rejected');assert.equal(outcome.record.errorCode,'CLI_MISSING');
  assert.equal(outcome.replayed,false);assert.deepEqual(observed,['rejected']);assert.equal(events.length,1);assert.deepEqual(events[0]!.context,{operationId:input.requestId});
  assert.equal(events[0]!.component,'chat');assert.equal(events[0]!.stage,'authenticate');assert.equal(events[0]!.code,'PROCESS_LAUNCH');
  assert.deepEqual(diagnosticEvent(events[0]),events[0]);assert.ok(f.record(input.requestId).finishedAt);
  assert.doesNotMatch(JSON.stringify(events),/private|scene\.lua|account@|synthetic/);
  observation.mark('exact-replay');assert.equal((await f.service.action(input)).replayed,true);observation.mark('state-direct');for(let i=0;i<3;i++)f.service.state();
  const token='a'.repeat(64),agent='b'.repeat(64),route=codexRoutes(f.service);let origin='';
  const server=createServer((request,response)=>{void route(request,response,new URL(request.url??'/',origin),token,origin,agent).catch(()=>response.destroy());});
  t.after(async()=>{observation.mark('http-close');try{for(const request of requests)request.destroy();server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));observation.mark('http-closed');}catch(error){failure();throw error;}});
  observation.mark('http-listen');await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});});origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
  for(const path of ['/v1/codex/state','/v1/codex/history']){
    observation.mark(path==='/v1/codex/state'?'http-state':'http-history');
    // These are actual authenticated loopback routes. An owned core HTTP request
    // avoids unrelated lazy global-fetch startup and never retains a pooled socket.
    const response=await new Promise<{status:number|undefined;bytes:Buffer}>((resolve,reject)=>{
      const owned=request(origin+path,{method:'GET',agent:false,headers:{Authorization:'Bearer '+token,Origin:origin},signal:AbortSignal.any([t.signal,AbortSignal.timeout(1000)])},incoming=>{
        const chunks:Buffer[]=[];let bytes=0;
        incoming.on('data',(value:Buffer)=>{bytes+=value.length;if(bytes>4*1024*1024){owned.destroy(Error('Fixture response exceeded the route 4MiB limit.'));return;}chunks.push(value);});
        incoming.once('error',reject);incoming.once('aborted',()=>reject(Error('Fixture response ended before its complete body.')));
        incoming.once('end',()=>resolve({status:incoming.statusCode,bytes:Buffer.concat(chunks)}));
      });
      requests.add(owned);owned.once('close',()=>requests.delete(owned));owned.once('error',reject);owned.end();
    });
    assert.equal(response.status,200);
    let body:unknown;try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(response.bytes));}catch{assert.fail('Fixture route returned invalid JSON.');}
    assert.ok(JSON.stringify(body)===JSON.stringify(path==='/v1/codex/state'?{state:f.service.state()}:{nativeHistory:null}),'GET returned the complete actual state/history projection.');
  }
  observation.mark('final-assertions');
  assert.equal(events.length,1);assert.equal(f.connects(),1);
  observation.mark('body-complete');
  }catch(error){failure();throw error;}
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


// Actual controlled Node stdio initialization, not an installed CLI or provider.
// The same owned error survives the connector cleanup and reaches the service.
async function controlledFrameConnectFailure():Promise<CodexClientError>{
  const transport=new JsonlTransport({command:process.execPath,cwd:process.cwd(),env:{},args:['-e',
    "process.stdin.once('data',()=>process.stdout.write('x'.repeat(128)));process.stdin.resume();"]},
    limits({maxFrameBytes:64,requestTimeoutMs:5000}),()=>{},()=>{});
  let original:unknown;
  try{await transport.request('initialize',{});}catch(error){original=error;}
  finally{await transport.close();}
  assert.ok(original instanceof CodexClientError);assert.equal(original.code,'FRAME_LIMIT');assert.equal(original.dispatched,true);
  annotateNativeConnectFrame(original,'direct-initialize');assert.ok(readNativeFrameEvidence(original));
  return original;
}

test('actual owned stdio frame failure reports only after its unchanged unknown SQLite receipt commits',async t=>{
  const events:DiagnosticEvent[]=[],committed:string[]=[];let original:CodexClientError|undefined;
  let read:(id:string)=>CodexActionRecord=()=>assert.fail('report before readiness');
  const f=await fixture(t,{connect:async()=>{original=await controlledFrameConnectFailure();throw original;},
    reportFailure:async event=>{committed.push(read(event.context!.operationId!).state);events.push(event);return event.eventId;}});read=f.record;
  const input={requestId:randomUUID(),connectionId:null,action:'connect'} as const,outcome=await f.service.action(input);
  assert.equal(outcome.record.state,'unknown');assert.equal(outcome.record.errorCode,'FRAME_LIMIT');
  assert.equal(f.record(input.requestId).state,'unknown');assert.deepEqual(committed,['unknown']);assert.equal(events.length,1);
  const event=events[0]!;assert.equal(event.code,'NATIVE_FRAME_LIMIT');assert.equal(event.stage,'authenticate');
  assert.equal(event.context?.operationId,input.requestId);assert.equal(event.context?.nativeFramePhase,'direct-initialize');
  assert.equal(event.context?.nativeFrameDirection,'inbound');assert.equal(event.context?.nativeFramePendingMask,1);
  assert.equal(event.context?.nativeFramePendingCount,1);assert.deepEqual(diagnosticEvent(event),event);
  assert.doesNotMatch(JSON.stringify(event),/private|source\.lua|account@|synthetic|args|stdout|token|thread|session/i);
  assert.equal((await f.service.action(input)).replayed,true);f.service.state();
  await f.service.close();const reopened=f.open();reopened.state();
  assert.equal((await reopened.action(input)).replayed,true);assert.equal(f.connects(),1);assert.equal(events.length,1);
  assert.ok(original&&readNativeFrameEvidence(original),'original owned evidence is data, not consumed replay authority');
});

test('frame diagnostics cannot replace terminal journal refusal or turn a copied error into owned evidence',async t=>{
  const original=await controlledFrameConnectFailure(),events:DiagnosticEvent[]=[];
  const f=await fixture(t,{connect:async()=>{throw original;},reportFailure:async event=>{events.push(event);return event.eventId;}});
  const writer=new DatabaseSync(f.filename,{allowExtension:false});
  writer.exec("CREATE TRIGGER refuse_frame_terminal BEFORE UPDATE ON actions BEGIN SELECT RAISE(ABORT,'controlled terminal refusal'); END;");
  const input={requestId:randomUUID(),connectionId:null,action:'connect'} as const;
  try{await assert.rejects(f.service.action(input),{code:'JOURNAL_FAILURE'});assert.equal(f.record(input.requestId).state,'pending');assert.deepEqual(events,[]);}
  finally{writer.exec('DROP TRIGGER refuse_frame_terminal');writer.close();}
  const copied=new CodexClientError(original.code,PRIVATE,original.dispatched),otherEvents:DiagnosticEvent[]=[];
  const other=await fixture(t,{connect:async()=>{throw copied;},reportFailure:async event=>{otherEvents.push(event);return event.eventId;}});
  const result=await other.service.action({requestId:randomUUID(),connectionId:null,action:'connect'});
  assert.equal(result.record.state,'unknown');assert.equal(result.record.errorCode,'FRAME_LIMIT');
  assert.equal(otherEvents.length,1);assert.equal(otherEvents[0]!.code,'HOST_FAILURE');assert.deepEqual(Object.keys(otherEvents[0]!.context!),['operationId']);
});
