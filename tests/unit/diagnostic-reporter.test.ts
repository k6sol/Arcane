import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {assetFailureEvent, codexActionFailureEvent, studioStagingFailureEvent, createDiagnosticReporter, type DiagnosticChannel} from '../../apps/daemon/src/diagnostic-reporter.js';
import {readStudioStagingDiagnostic, type StudioStagingDiagnostic} from '../../packages/asset-pipeline/src/failure-diagnostics.js';
import {JsonlTransport, readNativeFrameEvidence, annotateNativeConnectFrame} from '../../packages/codex-client/src/transport.js';
import {CodexClientError} from '../../packages/codex-client/src/types.js';
import {limits} from '../../packages/codex-client/src/validation.js';
import {DIAGNOSTIC_REASONS} from '../../packages/diagnostics/src/report.js';
const jobId='8e6bc8a1-a0ea-4823-8998-0f82d14469ba';
const event=()=>assetFailureEvent(jobId,{code:'BLENDER_FAILED',message:'private C:\\Users\\me\\script.py prompt and token',
  diagnostic:{schemaVersion:1,stage:'mesh-validation',reasonCode:'MESH_AUDIT',reason:'private raw reason',exceptionType:'ValueError',metrics:{renderTriangles:17000,triangleBudget:16000},logPath:'failure.json'}},1792500000000);
function channel(){const emitter=new EventEmitter();const messages:Record<string,unknown>[]=[];let callback:(error:Error|null)=>void=()=>{};
  const wire=Object.assign(emitter,{connected:true,send(message:unknown,cb:(error:Error|null)=>void){messages.push(message as Record<string,unknown>);callback=cb;return true;}});
  return {wire:wire as DiagnosticChannel,messages,receive:(message:unknown)=>emitter.emit('message',message),callback:(error:Error|null)=>callback(error),ack(stored:boolean,id?:string){const request=messages.at(-1)!;emitter.emit('message',{type:'arcane-diagnostic-ack',protocolVersion:1,requestId:request.requestId,eventId:id??(request.event as {eventId:string}).eventId,stored});}};}
test('asset reports preserve stage, safe class and measured cause without transporting raw exception content',()=>{
  const result=event();assert.equal(result.stage,'mesh-validation');assert.equal(result.code,'MESH_AUDIT');assert.equal(result.context?.exceptionType,'ValueError');
  assert.equal(result.context?.renderTriangles,17000);assert.ok(!JSON.stringify(result).includes('private'));assert.ok(!JSON.stringify(result).includes('failure.json'));
  assert.equal(assetFailureEvent(jobId,{code:'UNKNOWN_PRIVATE',message:'private'}).code,'INTERNAL_ERROR');
});

test('measured material reasons reach the central reporter with only finite fields and require the original durable ACK',async()=>{
  for(const reasonCode of ['MESH_MATERIAL_NODE','MESH_MATERIAL_LINK','MESH_MATERIAL_SURFACE','MESH_MATERIAL_PBR'] as const){
    const input=assetFailureEvent(jobId,{code:'BLENDER_FAILED',message:'private C:/source.py token',diagnostic:{schemaVersion:1,
      stage:'mesh-validation',reasonCode,reason:'private raw material error',exceptionType:'ValueError',auditPath:'audit.json',logPath:'failure.json',
      metrics:{renderTriangles:10310,triangleBudget:16000,collisionTriangles:12,invalidMeshes:1,errorCount:1}}});
    assert.equal(input.component,'blender');assert.equal(input.stage,'mesh-validation');assert.equal(input.code,reasonCode);
    assert.equal(input.reason,DIAGNOSTIC_REASONS[reasonCode]);assert.notEqual(input.reason,DIAGNOSTIC_REASONS.MESH_AUDIT);
    assert.deepEqual(input.context,{jobId,exceptionType:'ValueError',renderTriangles:10310,triangleBudget:16000,collisionTriangles:12,invalidMeshes:1,errorCount:1});
    assert.doesNotMatch(JSON.stringify(input),/private|source\.py|token|failure\.json|audit\.json/);
    const c=channel(),reporter=createDiagnosticReporter(c.wire);let settled=false;
    try{
      const pending=reporter.report(input).then(value=>{settled=true;return value;});
      c.callback(null);await Promise.resolve();assert.equal(settled,false);
      assert.equal((c.messages[0]!.event as {code:string}).code,reasonCode);
      c.ack(true);assert.equal(await pending,input.eventId);
    }finally{reporter.close();}
  }
});
test('successful pipe write is not a durable ack and delayed EPIPE cannot produce a report id',async()=>{
  const c=channel(),reporter=createDiagnosticReporter(c.wire);let settled=false;
  const pending=reporter.report(event()).then(value=>{settled=true;return value;});c.callback(null);await Promise.resolve();assert.equal(settled,false);
  c.callback(Object.assign(Error('private pipe detail'),{code:'EPIPE'}));assert.equal(await pending,null);reporter.close();
});
test('deadline, user cancellation and unresolved supervision retain their actual cause over a generic host diagnostic',()=>{
  for(const [code,expected]of [['DEADLINE','REQUEST_TIMEOUT'],['CANCELLED','OPERATION_CANCELLED'],['SUPERVISION_UNRESOLVED','SUPERVISION_LOST']]){
    const report=assetFailureEvent(jobId,{code:code!,message:'private',diagnostic:{schemaVersion:1,stage:'export',reasonCode:'HOST_FAILURE',reason:'private',exceptionType:null}});
    assert.equal(report.code,expected);assert.equal(report.stage,'export');
  }
});
test('only matching positive durable acknowledgement returns the report id',async()=>{
  const c=channel(),reporter=createDiagnosticReporter(c.wire),input=event();const pending=reporter.report(input);let settled=false;void pending.then(()=>{settled=true;});
  c.ack(true,randomUUID());await Promise.resolve();assert.equal(settled,false);c.ack(true);assert.equal(await pending,input.eventId);
  const rejected=reporter.report(event());c.ack(false);assert.equal(await rejected,null);reporter.close();
});
test('missing acknowledgements, close and saturation are bounded without inventing stored ids',async()=>{
  const c=channel(),reporter=createDiagnosticReporter(c.wire,10);assert.equal(await reporter.report(event()),null);c.ack(true);reporter.close();
  const other=channel(),active=createDiagnosticReporter(other.wire);const pending=Array.from({length:16},()=>active.report(event()));
  assert.equal(await active.report(event()),null);assert.equal(other.messages.length,16);active.close();assert.deepEqual(await Promise.all(pending),Array(16).fill(null));
  assert.equal(await active.report(event()),null);
});

test('Codex action reports contain only a canonical operation UUID and fixed classifications',()=>{
  const operationId='A7F9DA50-55BD-46CE-9DF9-24826FD66139',privateCode='private prompt path C:\\Users\\fixture\\source.lua account@example.invalid token=fixture';
  const result=codexActionFailureEvent(operationId,'turn-steer',privateCode,1792500000000);
  assert.match(result.eventId,/^[a-f0-9-]{36}$/);assert.equal(result.occurredAt,1792500000000);
  assert.equal(result.component,'chat');assert.equal(result.stage,'request-submit');assert.equal(result.code,'HOST_FAILURE');
  assert.deepEqual(result.context,{operationId:operationId.toLowerCase()});
  assert.deepEqual(Object.keys(result).sort(),['code','component','context','eventId','occurredAt','reason','schemaVersion','stage']);
  assert.doesNotMatch(JSON.stringify(result),/private|fixture|source\.lua|account@|token=/);
  assert.throws(()=>codexActionFailureEvent('not-an-operation-uuid','connect','TIMEOUT'));
});

test('Codex action classifications use finite host codes without treating arbitrary code strings as schema fields',()=>{
  for(const [action,code,stage,expected]of[
    ['connect','CLI_MISSING','authenticate','PROCESS_LAUNCH'],
    ['history-load','TIMEOUT','history-load','REQUEST_TIMEOUT'],
    ['approval','REMOTE_REJECTED','tool-approval','REQUEST_REJECTED'],
    ['grant-assets','ASSET_AUTHORITY','tool-approval','HOST_FAILURE'],
    ['turn-start','NATIVE_ERROR','request-submit','INTERNAL_ERROR'],
    ['select','constructor','request-validation','HOST_FAILURE'],
    ['disconnect',null,'request-stream','HOST_FAILURE'],
  ]as const){
    const result=codexActionFailureEvent(jobId,action,code);
    assert.equal(result.stage,stage);assert.equal(result.code,expected);assert.deepEqual(result.context,{operationId:jobId});
  }
});

test('reserved operation correlation cannot acknowledge an owned-child IPC request',async()=>{
  const c=channel(),reporter=createDiagnosticReporter(c.wire),input=codexActionFailureEvent('00000000-0000-0000-0000-000000000000','connect','TIMEOUT');
  let settled=false;const pending=reporter.report(input).then(value=>{settled=true;return value;});
  for(const requestId of ['00000000-0000-0000-0000-000000000000','ffffffff-ffff-ffff-ffff-ffffffffffff']){
    c.receive({type:'arcane-diagnostic-ack',protocolVersion:1,requestId,eventId:input.eventId,stored:true});
    await Promise.resolve();assert.equal(settled,false);
  }
  c.ack(true);assert.equal(await pending,input.eventId);reporter.close();
});

test('staging reports preserve only the actual closed check and ordinal, without job or native identities',()=>{
  const raw={schemaVersion:1,operation:'stage',phase:'packet-receipt',reason:'proof-expired',packetOrdinal:12},diagnostic=readStudioStagingDiagnostic(raw);assert.ok(diagnostic);
  const result=studioStagingFailureEvent(diagnostic,1792500000000);
  assert.equal(result.component,'studio');assert.equal(result.stage,'studio-import');assert.equal(result.code,'STUDIO_STAGE_CONTINUITY');assert.equal(result.occurredAt,1792500000000);
  assert.deepEqual(result.context,{packetOrdinal:12,stagingPhase:'packet-receipt',stagingReason:'proof-expired'});
  assert.equal(result.reason,'Studio staging continuity could not be confirmed; inspect the recorded check without repeating the request.');
  assert.deepEqual(Object.keys(result).sort(),['code','component','context','eventId','occurredAt','reason','schemaVersion','stage']);
  raw.reason='private error C:\\Users\\fixture\\model.glb token';assert.equal(result.context?.stagingReason,'proof-expired');
  const target=readStudioStagingDiagnostic({schemaVersion:1,operation:'stage',phase:'target-check',reason:'plugin-lifetime-changed',packetOrdinal:null});assert.ok(target);
  assert.deepEqual(studioStagingFailureEvent(target).context,{stagingPhase:'target-check',stagingReason:'plugin-lifetime-changed'});
  assert.equal(assetFailureEvent(jobId,{code:'STUDIO_STAGE_CONTINUITY',message:'private'}).code,'INTERNAL_ERROR','The new staging code cannot relabel a generated worker failure.');
});

test('staging mapper refuses forged descriptors before any report can contain arbitrary text or identities',()=>{
  const value={schemaVersion:1,operation:'stage',phase:'packet-enqueue',reason:'disconnected',packetOrdinal:0};let getters=0;
  for(const bad of [{...value,message:'private prompt'}, {...value,jobId}, {...value,reason:'private C:\\Users\\fixture'}, {...value,packetOrdinal:512},
    {...value,phase:'target-check'}, Object.defineProperty({...value},'reason',{enumerable:true,get(){getters++;throw Error('private');}}),
    new Proxy(value,{get(){getters++;throw Error('private');}})])assert.throws(()=>studioStagingFailureEvent(bad as unknown as StudioStagingDiagnostic));
  assert.equal(getters,0);
});

test('actual staging events still require durable owner acknowledgements and closed or faulted channels return no id',async()=>{
  const diagnostic=readStudioStagingDiagnostic({schemaVersion:1,operation:'stage',phase:'seal-check',reason:'edit-epoch-changed',packetOrdinal:null});assert.ok(diagnostic);
  const c=channel(),reporter=createDiagnosticReporter(c.wire),event=studioStagingFailureEvent(diagnostic);let settled=false;
  const pending=reporter.report(event).then(value=>{settled=true;return value;});c.callback(null);await Promise.resolve();assert.equal(settled,false);
  assert.deepEqual((c.messages[0]!.event as {context:unknown}).context,{stagingPhase:'seal-check',stagingReason:'edit-epoch-changed'});
  c.ack(true);assert.equal(await pending,event.eventId);
  const failed=reporter.report(studioStagingFailureEvent(diagnostic));c.callback(new Error('private send failure'));assert.equal(await failed,null);
  reporter.close();const count=c.messages.length;assert.equal(await reporter.report(studioStagingFailureEvent(diagnostic)),null);assert.equal(c.messages.length,count);
  const absent=channel();absent.wire.connected=false;const unavailable=createDiagnosticReporter(absent.wire);
  assert.equal(await unavailable.report(studioStagingFailureEvent(diagnostic)),null);assert.equal(absent.messages.length,0);unavailable.close();
});

test('only an actual frame refusal can produce a connect-frame report; copies and worker labels cannot',async t=>{
  const transport=new JsonlTransport({command:process.execPath,cwd:process.cwd(),env:{},
    args:['-e',"process.stdin.once('data',()=>process.stdout.write('x'.repeat(128)));process.stdin.resume();"]},
    limits({maxFrameBytes:64,requestTimeoutMs:5000}),()=>{},()=>{});
  t.after(()=>transport.close());
  let original:unknown;
  await assert.rejects(transport.request('initialize',{}),error=>{original=error;return error instanceof CodexClientError&&error.code==='FRAME_LIMIT';});
  assert.ok(original instanceof CodexClientError);assert.equal(original.dispatched,true);
  assert.equal(readNativeFrameEvidence(original)?.connectPhase,'not-connect');
  assert.equal(codexActionFailureEvent(jobId,'connect','FRAME_LIMIT',1792500000000,original).code,'HOST_FAILURE');
  annotateNativeConnectFrame(original,'discovery-initialize');
  const frame=readNativeFrameEvidence(original);assert.ok(frame);assert.ok(frame.byteCount>64&&frame.byteCount<=128);
  const event=codexActionFailureEvent(jobId,'connect','FRAME_LIMIT',1792500000000,original);
  assert.equal(event.code,'NATIVE_FRAME_LIMIT');assert.equal(event.stage,'authenticate');
  assert.deepEqual(event.context,{operationId:jobId,nativeFrameDirection:'inbound',nativeFramePhase:'discovery-initialize',
    nativeFrameByteKind:'at-least',nativeFrameBytes:frame.byteCount,nativeFrameLimit:64,nativeFramePendingMask:1,nativeFramePendingCount:1});
  assert.equal(codexActionFailureEvent(jobId,'turn-start','FRAME_LIMIT',1792500000000,original).code,'HOST_FAILURE');
  assert.equal(codexActionFailureEvent(jobId,'connect','PROCESS_EXIT_UNCONFIRMED',1792500000000,original).code,'SUPERVISION_LOST');
  let reads=0;
  const proxy=new Proxy(original,{get(){reads++;throw Error('private');}});
  for(const forged of [{code:'FRAME_LIMIT'},new CodexClientError('FRAME_LIMIT','private',true),JSON.parse(JSON.stringify(original)),proxy]){
    assert.equal(readNativeFrameEvidence(forged),null);annotateNativeConnectFrame(forged,'final-initialize');
    assert.equal(codexActionFailureEvent(jobId,'connect','FRAME_LIMIT',1792500000000,forged).code,'HOST_FAILURE');
  }
  assert.equal(reads,0);assert.equal(assetFailureEvent(jobId,{code:'NATIVE_FRAME_LIMIT',message:'private'}).code,'INTERNAL_ERROR');
  const c=channel(),reporter=createDiagnosticReporter(c.wire),pending=reporter.report(event);c.ack(true);assert.equal(await pending,event.eventId);reporter.close();
  assert.doesNotMatch(JSON.stringify(event),/private|stdin|taskSupport|inputSchema|password|Bearer/i);
});
