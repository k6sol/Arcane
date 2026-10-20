import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {assetFailureEvent, codexActionFailureEvent, createDiagnosticReporter, type DiagnosticChannel} from '../../apps/daemon/src/diagnostic-reporter.js';
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
  assert.deepEqual(Object.keys(result).sort(),['code','component','context','eventId','occurredAt','reason','schemaVersion']);
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
