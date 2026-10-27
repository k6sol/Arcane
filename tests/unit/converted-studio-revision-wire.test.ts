import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {NATIVE_STUDIO_REVISION_RESPONSE_BYTES,nativeStudioRevisionResponse,nativeStudioRevisionStatusResponse,parseNativeStudioRevisionResponse,parseNativeStudioRevisionStatusResponse} from '../../packages/asset-pipeline/src/studio-revision-wire.js';
import type {StudioImportRevisionReceipt,CommandState} from '../../packages/protocol/src/studio.js';

// Synthetic public metadata only: these codecs create no host/plugin witness,
// native materialization proof, current resource mapping or permission to retry.
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const uuid=(n:number)=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
function fixture(){
  const jobId=uuid(1),projectId=hash('project'),runId=uuid(2),commandId=uuid(3);
  const receipt:StudioImportRevisionReceipt={formatVersion:2,runId,state:'applied',observationId:uuid(4),
    source:{projectId,jobId,assetId:'arcane_'+hash('synthetic asset'),sourceSha256:hash('source'),preparedDigest:hash('preparation'),manifestDigest:hash('manifest'),payloadDigest:hash('payload'),transferDigest:hash('transfer'),graphDigest:hash('graph'),conversionRequestDigest:hash('request')},
    target:{sessionId:'session',placeId:1,universeId:2,root:'Workspace',parentRef:'parent',creator:{kind:'user',id:'123'}},continuity:{clientLifetimeId:'lifetime',pluginArtifactHash:hash('plugin'),playEpoch:0},
    modelRef:{instanceId:'root',sessionId:'session',root:'Workspace',pathSegments:['Tree'],className:'Model'},modelOwnedStateSha256:hash('root state'),
    nodes:[{nodeKey:'node0',instanceRef:'group',ownedStateSha256:hash('group'),authoredChildren:[]},{nodeKey:'node0_primitive0',instanceRef:'mesh',ownedStateSha256:hash('mesh'),authoredChildren:[]}],
    objects:[{sourceObjectId:'arcane_'+hash('synthetic object'),instanceRef:'mesh',ownedStateSha256:hash('mesh'),authoredChildren:[],meshAssetId:null}],
    receiptScope:'live-import-revision',imported:false,engineVerification:'pending'};
  const post={jobId,projectId,applied:{...receipt,commandId}};
  const status={jobId,projectId,revision:{runId,commandId,state:'succeeded' as CommandState,receipt,receiptScope:'historical-revision' as const,currentResources:'unobserved' as const,imported:false as const,engineVerification:'pending' as const,retry:false as const}};
  return {jobId,projectId,runId,commandId,receipt,post,status};
}

test('public applied revision metadata is exact, detached and bound to requested source scope',()=>{
  const f=fixture(),parsed=parseNativeStudioRevisionResponse(f.post,f.jobId,f.projectId);
  assert.deepEqual(parsed,f.post);assert.notEqual(parsed.applied.nodes,f.post.applied.nodes);assert.ok(Object.isFrozen(parsed.applied.nodes[0]));
  assert.equal(parsed.applied.objects[0]!.meshAssetId,null);assert.equal(parsed.applied.imported,false);assert.equal(parsed.applied.engineVerification,'pending');
  f.post.applied.nodes[0]!.ownedStateSha256=hash('later');assert.notEqual(parsed.applied.nodes[0]!.ownedStateSha256,f.post.applied.nodes[0]!.ownedStateSha256);
  assert.equal(nativeStudioRevisionResponse.refine(v=>v.jobId===f.jobId).safeParse(f.post).success,true);
  assert.throws(()=>parseNativeStudioRevisionResponse(f.post,uuid(9)),{code:'STUDIO_REVISION_RESPONSE'});
  assert.throws(()=>parseNativeStudioRevisionResponse(f.post,f.jobId,hash('wrong project')),{code:'STUDIO_REVISION_RESPONSE'});
});

test('historical status supports genuine null and exact non-success states without replay authority',()=>{
  const f=fixture(),empty={jobId:f.jobId,projectId:f.projectId,revision:null};
  assert.deepEqual(parseNativeStudioRevisionStatusResponse(empty,f.jobId,f.projectId),empty);
  assert.deepEqual(parseNativeStudioRevisionStatusResponse(f.status),f.status);
  for(const state of ['queued','dispatched','failed','cancelled','needs_reconciliation'] as const){
    const value={...f.status,revision:{...f.status.revision,state,receipt:null}};assert.deepEqual(parseNativeStudioRevisionStatusResponse(value),value);
    assert.equal(nativeStudioRevisionStatusResponse.safeParse({...value,revision:{...value.revision,receipt:f.receipt}}).success,false);
  }
  assert.equal(nativeStudioRevisionStatusResponse.safeParse({...f.status,revision:{...f.status.revision,receipt:null}}).success,false);
  assert.throws(()=>parseNativeStudioRevisionStatusResponse(empty,uuid(9)),{code:'STUDIO_REVISION_STATUS_RESPONSE'});
});

test('execution and historical envelopes refuse wrong job/project/run/command and unknown authority claims',()=>{
  const f=fixture();
  for(const value of [{...f.post,jobId:uuid(8)},{...f.post,projectId:hash('other')},{...f.post,applied:{...f.post.applied,commandId:'not-a-command'}},{...f.post,applied:{...f.post.applied,receiptScope:'live-import-observation'}},{...f.post,applied:{...f.post.applied,modelAssetId:'123'}},{...f.post,approved:true}])assert.equal(nativeStudioRevisionResponse.safeParse(value).success,false);
  for(const change of [{runId:uuid(8)},{commandId:uuid(3)+'\n'},{retry:true},{currentResources:'live'},{receiptScope:'live-import-revision'},{imported:true},{engineVerification:'verified'}])assert.equal(nativeStudioRevisionStatusResponse.safeParse({...f.status,revision:{...f.status.revision,...change}}).success,false);
  assert.equal(nativeStudioRevisionStatusResponse.safeParse({...f.status,projectId:hash('other')}).success,false);
  assert.equal(nativeStudioRevisionStatusResponse.safeParse({...f.status,jobId:uuid(8)}).success,false);
});

test('actual closed receipt parser validates nullable persisted IDs and managed node/object observations',()=>{
  const f=fixture(),kept=structuredClone(f.post);kept.applied.objects[0]!.meshAssetId='123456789';assert.equal(parseNativeStudioRevisionResponse(kept).applied.objects[0]!.meshAssetId,'123456789');
  const duplicate=structuredClone(f.post);duplicate.applied.nodes.push(duplicate.applied.nodes[0]!);assert.equal(nativeStudioRevisionResponse.safeParse(duplicate).success,false);
  const changed=structuredClone(f.post);changed.applied.objects[0]!.ownedStateSha256=hash('different node state');assert.equal(nativeStudioRevisionResponse.safeParse(changed).success,false);
  const zero=structuredClone(kept);zero.applied.objects[0]!.meshAssetId='0';assert.equal(nativeStudioRevisionResponse.safeParse(zero).success,false);
});

test('public codecs reject hostile descriptors and proxies without executing input code',()=>{
  const f=fixture();let reads=0;
  const accessor={...f.post};Object.defineProperty(accessor,'applied',{enumerable:true,get(){reads++;throw Error('getter');}});
  const proxy=new Proxy(f.post,{ownKeys(){reads++;throw Error('proxy');},get(){reads++;throw Error('proxy');}});
  const nested={...f.post,applied:new Proxy(f.post.applied,{getPrototypeOf(){reads++;throw Error('proxy');}})};
  const hidden={...f.post};Object.defineProperty(hidden,'extra',{value:true,enumerable:false});
  const symbol={...f.post,[Symbol('hidden')]:true},custom=Object.assign(Object.create({}),f.post);
  const sparse=structuredClone(f.post);Reflect.deleteProperty(sparse.applied.nodes,'0');
  const cycle:Record<string,unknown>={...f.post};cycle.extra=cycle;
  for(const value of [accessor,proxy,nested,hidden,symbol,custom,sparse,cycle])assert.equal(nativeStudioRevisionResponse.safeParse(value).success,false);
  assert.equal(reads,0);
});

test('public envelopes enforce actual serialized bytes and bounded dense data',()=>{
  const f=fixture(),oversize={...f.post,extra:'x'.repeat(NATIVE_STUDIO_REVISION_RESPONSE_BYTES)};
  assert.equal(nativeStudioRevisionResponse.safeParse(oversize).success,false);
  const array=structuredClone(f.post);array.applied.nodes=Array.from({length:129},()=>array.applied.nodes[0]!);assert.equal(nativeStudioRevisionResponse.safeParse(array).success,false);
  assert.equal(nativeStudioRevisionStatusResponse.safeParse({...f.status,extra:undefined}).success,false);
  assert.equal(nativeStudioRevisionResponse.safeParse({...f.post,applied:{...f.post.applied,toJSON(){throw Error('serializer must not execute');}}}).success,false);
});
