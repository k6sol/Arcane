import test from 'node:test';
import assert from 'node:assert/strict';
import {diagnosticEvent, diagnosticEventId, DiagnosticValidationError, DIAGNOSTIC_REASONS} from '../../packages/diagnostics/src/report.js';
import {readStudioStagingDiagnostic} from '../../packages/asset-pipeline/src/failure-diagnostics.js';
import {DIAGNOSTIC_MAX_BYTES} from '../../packages/diagnostics/src/report.js';

const input = {schemaVersion: 1, eventId: '8e6bc8a1-a0ea-4823-8998-0f82d14469ba', occurredAt: 1792500000000,
  component: 'blender', stage: 'texture-authoring', code: 'MEMORY_LIMIT', context: {exceptionType: 'MemoryError', exitCode: 1, triangleBudget: 16000}};

test('a foliage contact refusal retains its finite stage and reason in the central report contract',()=>{
  const event=diagnosticEvent({...input,stage:'blockout',code:'FOLIAGE_ATTACHMENT'});
  assert.equal(event.stage,'blockout');assert.equal(event.code,'FOLIAGE_ATTACHMENT');
  assert.equal(DIAGNOSTIC_REASONS[event.code],'Foliage could not remain attached to the final emitted branch surface.');
});
test('a report identifies the real failing stage, safe exception class and useful numeric context', () => {
  const event = diagnosticEvent(input);
  assert.equal(event.stage, 'texture-authoring'); assert.equal(event.code, 'MEMORY_LIMIT');
  assert.equal(event.reason, DIAGNOSTIC_REASONS.MEMORY_LIMIT); assert.equal(event.context?.triangleBudget, 16000);
  assert.deepEqual(diagnosticEvent(JSON.parse(JSON.stringify(event))), event);
  assert.equal(diagnosticEvent({...input, code: 'INTERNAL_ERROR', context: {exceptionType: 'TypeError'}}).context?.exceptionType, 'TypeError');
});
test('private text cannot enter reports through extra fields, reason, identifiers or context', () => {
  const secret = 'Bearer private-token user@example.com C:\\Users\\private\\script.py prompt text';
  for (const value of [
    {...input, message: secret}, {...input, stack: secret}, {...input, reason: secret}, {...input, prompt: secret},
    {...input, stage: secret}, {...input, code: secret}, {...input, eventId: secret}, {...input, release: secret},
    {...input, context: {path: secret}}, {...input, context: {jobId: secret}}, {...input, context: {exceptionType: secret}},
    {...input, context: {elapsedMs: secret}}, {...input, context: {httpStatus: 999}}, {...input, context: {exitCode: Infinity}},
    {...input, occurredAt: NaN}, {...input, context: {triangleBudget: -1}}, {...input, context: {attempt: 1.5}},
  ]) assert.throws(() => diagnosticEvent(value), (error: unknown) => error instanceof DiagnosticValidationError && !error.message.includes(secret));
});
test('canonical serialization ignores object insertion order without retaining mutable caller context', () => {
  const a = diagnosticEvent(input), b = diagnosticEvent({...input, context: {triangleBudget: 16000, exitCode: 1, exceptionType: 'MemoryError'}});
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  input.context.triangleBudget = 1; assert.equal(a.context?.triangleBudget, 16000);
});
test('fixed launcher failures preserve the actionable startup cause without exception text',()=>{
  for(const code of ['PORT_IN_USE','PROJECT_IN_USE','STATE_NEWER','STATE_UNSAFE','RESOURCE_UNAVAILABLE']){
    const event=diagnosticEvent({...input,component:'daemon',stage:'startup',code});
    assert.equal(event.code,code);assert.ok(event.reason.length>20);
  }
});

test('reserved native request UUIDs are correlation metadata only, never event, job or IPC request identities',()=>{
  for(const operationId of ['00000000-0000-0000-0000-000000000000','ffffffff-ffff-ffff-ffff-ffffffffffff']){
    const event=diagnosticEvent({...input,component:'chat',context:{operationId}});
    assert.deepEqual(event.context,{operationId});assert.deepEqual(diagnosticEvent(JSON.parse(JSON.stringify(event))),event);
    assert.equal(diagnosticEventId(operationId),false,'the unchanged event/IPC UUID validator refuses reserved identities');
    assert.throws(()=>diagnosticEvent({...input,eventId:operationId}),DiagnosticValidationError);
    assert.throws(()=>diagnosticEvent({...input,context:{jobId:operationId}}),DiagnosticValidationError);
  }
});

test('operation correlation still rejects arbitrary strings and reserved UUID near misses',()=>{
  for(const operationId of ['private prompt','00000000-0000-0000-0000-000000000001','ffffffff-ffff-ffff-ffff-fffffffffffe',
    'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF','11111111-2222-0333-8444-555555555555','11111111-2222-4333-0444-555555555555',
    '11111111-2222-4333-c444-555555555555','11111111-2222-9333-8444-555555555555','00000000-0000-0000-0000-000000000000x']){
    assert.throws(()=>diagnosticEvent({...input,context:{operationId}}),DiagnosticValidationError);
  }
});

test('standalone diagnostic schema agrees with every closed staging phase/reason and preserves packet bounds',()=>{
  const phases=['prior-attempt-check','target-check','admission','packet-enqueue','packet-receipt','seal-check'] as const;
  const reasons=['proof-missing','plugin-lifetime-changed','plugin-artifact-changed','edit-epoch-changed','not-edit','disconnected','continuity-unsupported','proof-expired'] as const;
  for(const phase of phases)for(const reason of reasons){
    const packet=phase==='packet-enqueue'||phase==='packet-receipt';
    for(const ordinal of packet?[0,511]:[null]){
      const source=readStudioStagingDiagnostic({schemaVersion:1,operation:'stage',phase,reason,packetOrdinal:ordinal});assert.ok(source);
      const context={stagingReason:source.reason,stagingPhase:source.phase,...(source.packetOrdinal===null?{}:{packetOrdinal:source.packetOrdinal})};
      const event=diagnosticEvent({...input,component:'studio',stage:'studio-import',code:'STUDIO_STAGE_CONTINUITY',context});
      assert.deepEqual(event.context,context);assert.deepEqual(diagnosticEvent(JSON.parse(JSON.stringify(event))),event);
      assert.equal(event.reason,DIAGNOSTIC_REASONS.STUDIO_STAGE_CONTINUITY);
    }
  }
});

test('staging fields are event-specific and refuse private identities, unknown predicates and invalid ordinal combinations',()=>{
  const base={...input,component:'studio',stage:'studio-import',code:'STUDIO_STAGE_CONTINUITY'},context={stagingPhase:'packet-receipt',stagingReason:'proof-expired',packetOrdinal:0};
  const secret='private prompt token C:\\Users\\fixture\\model.glb';
  for(const value of [
    {...base}, {...base,context:undefined}, {...base,component:'chat',context}, {...base,stage:'export',context},
    {...base,context:{...context,stagingPhase:'unknown-check'}}, {...base,context:{...context,stagingReason:secret}},
    {...base,context:{...context,jobId:input.eventId}}, {...base,context:{...context,operationId:input.eventId}},
    {...base,context:{...context,exceptionType:'Error'}}, {...base,context:{...context,path:secret}},
    {...base,context:{stagingPhase:'packet-enqueue',stagingReason:'disconnected'}},
    {...base,context:{...context,stagingPhase:'target-check'}},
    {...input,context:{stagingPhase:'target-check',stagingReason:'disconnected'}},
    ...[-1,512,0.5,NaN,Infinity,'0',null].map(packetOrdinal=>({...base,context:{...context,packetOrdinal}})),
  ])assert.throws(()=>diagnosticEvent(value),(error:unknown)=>error instanceof DiagnosticValidationError&&!error.message.includes(secret));
  let called=0;
  const getter=Object.defineProperty({...context},'stagingReason',{enumerable:true,get(){called++;throw Error(secret);}});
  const hidden=Object.defineProperty({...context},'hidden',{value:secret,enumerable:false});
  const symbol={...context,[Symbol('private')]:secret};
  for(const bad of [getter,hidden,symbol])assert.throws(()=>diagnosticEvent({...base,context:bad}),DiagnosticValidationError);
  assert.equal(called,0);
});

const nativeFrameContext={operationId:input.eventId,nativeFrameDirection:'inbound',nativeFramePhase:'discovery-initialize',
  nativeFrameByteKind:'at-least',nativeFrameBytes:1048577,nativeFrameLimit:1048576,nativeFramePendingMask:10,nativeFramePendingCount:2};
test('native frame evidence has a closed chat-only finite context within the unchanged event bound',()=>{
  for(const nativeFramePhase of ['direct-initialize','discovery-initialize','discovery-inventory','discovery-close','final-initialize'])
    for(const [nativeFrameDirection,nativeFrameByteKind]of [['inbound','at-least'],['outbound','exact'],['outbound','at-least']]){
      const context={...nativeFrameContext,nativeFramePhase,nativeFrameDirection,nativeFrameByteKind};
      const event=diagnosticEvent({...input,component:'chat',stage:'authenticate',code:'NATIVE_FRAME_LIMIT',context});
      assert.deepEqual(event.context,context);assert.deepEqual(diagnosticEvent(JSON.parse(JSON.stringify(event))),event);
      assert.equal(event.reason,DIAGNOSTIC_REASONS.NATIVE_FRAME_LIMIT);
      assert.ok(Buffer.byteLength(JSON.stringify(event))<=DIAGNOSTIC_MAX_BYTES);
    }
  for(const values of [{nativeFramePendingMask:0,nativeFramePendingCount:0},{nativeFramePendingMask:1023,nativeFramePendingCount:16},
    {nativeFrameBytes:268435456,nativeFrameLimit:1}])assert.doesNotThrow(()=>diagnosticEvent({...input,component:'chat',stage:'authenticate',code:'NATIVE_FRAME_LIMIT',context:{...nativeFrameContext,...values}}));
});

test('native frame contexts refuse mixed fields, malformed observations, coercion and unowned object behavior',()=>{
  const base={...input,component:'chat',stage:'authenticate',code:'NATIVE_FRAME_LIMIT',context:nativeFrameContext};
  const invalid:unknown[]=[{...base,context:undefined},{...base,component:'blender'},{...base,stage:'request-submit'},
    {...base,code:'HOST_FAILURE'},{...base,context:{...nativeFrameContext,jobId:input.eventId}},
    {...base,context:{...nativeFrameContext,stagingPhase:'admission'}},
    ...Object.keys(nativeFrameContext).map(key=>({...base,context:Object.fromEntries(Object.entries(nativeFrameContext).filter(([k])=>k!==key))})),
  ];
  for(const [key,values]of Object.entries({nativeFrameDirection:['unknown',null,{}],nativeFramePhase:['not-connect','private',null],
    nativeFrameByteKind:['unknown',null],nativeFrameBytes:[-1,268435457,0.5,NaN,Infinity,'1'],nativeFrameLimit:[0,1048577,0.5,'1'],
    nativeFramePendingMask:[-1,1024,0.5,'1'],nativeFramePendingCount:[-1,17,0.5,'1']}))
    for(const value of values)invalid.push({...base,context:{...nativeFrameContext,[key]:value}});
  invalid.push({...base,context:{...nativeFrameContext,nativeFramePendingMask:3,nativeFramePendingCount:1}},
    {...base,context:{...nativeFrameContext,nativeFramePendingCount:0}},
    {...base,context:{...nativeFrameContext,nativeFrameByteKind:'exact'}});
  let reads=0;
  const getter=Object.defineProperty({...nativeFrameContext},'nativeFramePhase',{enumerable:true,get(){reads++;throw Error('private');}});
  const hidden=Object.defineProperty({...nativeFrameContext},'private',{value:'private'});
  const proxy=new Proxy(nativeFrameContext,{get(){reads++;throw Error('private');},getPrototypeOf(){reads++;throw Error('private');}});
  invalid.push({...base,context:getter},{...base,context:hidden},{...base,context:{...nativeFrameContext,[Symbol('private')]:true}},
    {...base,context:proxy},new Proxy(base,{get(){reads++;throw Error('private');}}),
    {...base,context:{...nativeFrameContext,nativeFrameDirection:{toString(){reads++;throw Error('private');}}}});
  for(const value of invalid)assert.throws(()=>diagnosticEvent(value),DiagnosticValidationError);
  assert.equal(reads,0);
});

test('new native frame envelope snapshots exact own data before validation without accessor rereads',()=>{
  const base={schemaVersion:1,eventId:input.eventId,occurredAt:1792500000000,component:'chat',stage:'authenticate',code:'NATIVE_FRAME_LIMIT',
    context:nativeFrameContext,release:'a'.repeat(40),platform:'linux'};
  let reads=0;
  for(const key of ['schemaVersion','eventId','occurredAt','component','stage','code','context','release','platform','reason']){
    const getter=Object.defineProperty({...base},key,{enumerable:true,get(){reads++;throw Error('private accessor');}});
    assert.throws(()=>diagnosticEvent(getter),DiagnosticValidationError);
  }
  for(const value of [Object.defineProperty({...base},'private',{value:true}),{...base,[Symbol('private')]:true},
    Object.create(base)])assert.throws(()=>diagnosticEvent(value),DiagnosticValidationError);
  assert.equal(reads,0);
  assert.deepEqual(diagnosticEvent(base),diagnosticEvent(JSON.parse(JSON.stringify(base))));
});
