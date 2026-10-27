import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {validateCommandArgs,parseStudioImportObservationArgs,parseStudioImportObservationReceipt,parseStudioImportObservationWitness,validateStudioImportObservationReceipt,parseStudioImportRevisionArgs,parseStudioImportRevisionReceipt,validateStudioImportRevisionReceipt} from '../../packages/core/src/studio-policy.js';
import {studioImportObservationReceiptDigest} from '../../packages/asset-pipeline/src/studio-import-manifest.js';
import {convertedGlbAssetId,convertedGlbObjectId} from '../../packages/asset-pipeline/src/converted-glb.js';
import type {StudioSession,StudioImportObservationSource,StudioImportObservationArgs,StudioImportObservationReceipt,StudioImportObservationWitness,StudioImportRevisionArgs,StudioImportRevisionReceipt} from '../../packages/protocol/src/studio.js';

// Actual closed command/receipt policy with synthetic metadata only. No host or
// plugin witness is created here; no native allocation, upload or Studio proof.
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const uuid=(n:number)=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const refused={code:'STUDIO_IMPORT_OBSERVATION'};
function fixture(){
  const sourceSha256=sha('synthetic retained source'),source:StudioImportObservationSource={projectId:sha('project'),jobId:uuid(1),assetId:convertedGlbAssetId(sourceSha256),sourceSha256,
    preparedDigest:sha('old preparation'),manifestDigest:sha('old manifest'),payloadDigest:sha('old payload'),transferDigest:sha('old transfer'),graphDigest:sha('old graph'),conversionRequestDigest:sha('old request')};
  const target={sessionId:'fixture-session',placeId:12,universeId:34,root:'Workspace' as const,parentRef:'workspace-ref',creator:{kind:'user' as const,id:'78'}},continuity={clientLifetimeId:'fixture-lifetime',pluginArtifactHash:sha('plugin'),playEpoch:0};
  const args:StudioImportObservationArgs={formatVersion:2,observationId:uuid(2),source,target,continuity,modelRef:{instanceId:'model-root',sessionId:target.sessionId,root:'Workspace',pathSegments:['Tree'],className:'Model'}};
  const children=[{instanceRef:'authored-script',kind:'script' as const,stateSha256:sha('authored script state')}];
  const body:StudioImportObservationReceipt={...args,modelOwnedStateSha256:sha('actual synthetic root state'),nodes:[
    {nodeKey:'node0',instanceRef:'group-0',ownedStateSha256:sha('group state'),authoredChildren:[]},
    {nodeKey:'node0_primitive0',instanceRef:'mesh-0',ownedStateSha256:sha('mesh state'),authoredChildren:children}],
    objects:[{sourceObjectId:convertedGlbObjectId(sourceSha256,'render','node0_primitive0'),instanceRef:'mesh-0',ownedStateSha256:sha('mesh state'),authoredChildren:children,meshAssetId:null}],
    receiptScope:'live-import-observation',imported:false,engineVerification:'pending'};
  const observation=validateStudioImportObservationReceipt(args,body),current=structuredClone(observation);current.observationId=uuid(3);
  const wrap=(value:StudioImportObservationReceipt,id:number):StudioImportObservationWitness=>({commandId:uuid(id),receiptSha256:studioImportObservationReceiptDigest(value),observation:value});
  const next:StudioImportObservationSource={...source,jobId:uuid(4),preparedDigest:sha('next preparation'),manifestDigest:sha('next manifest'),payloadDigest:sha('next payload'),transferDigest:sha('next transfer'),graphDigest:sha('next graph'),conversionRequestDigest:sha('next request')};
  const revision:StudioImportRevisionArgs={formatVersion:2,runId:uuid(5),expected:{digest:next.transferDigest,payloadDigest:next.payloadDigest,manifestDigest:next.manifestDigest},packetCount:12,byteLength:10000,source:next,target,continuity,observation:wrap(observation,6),currentObservation:wrap(current,7)};
  const applied:StudioImportRevisionReceipt={...current,source:next,runId:revision.runId,state:'applied',receiptScope:'live-import-revision'};
  const session:StudioSession={id:target.sessionId,protocolVersion:1,clientSessionId:continuity.clientLifetimeId,placeId:target.placeId,universeId:target.universeId,name:'Synthetic place',pluginVersion:'0.1.9',allowedRoots:['Workspace'],allowWrites:true,capabilities:['scene.observe_import','asset.apply_revision'],connectedAt:'2026-10-27T00:00:00Z',lastSeenAt:'2026-10-27T00:00:00Z',revokedAt:null,
    proof:{sessionId:target.sessionId,clientLifetimeId:continuity.clientLifetimeId,pluginArtifactHash:continuity.pluginArtifactHash,markerName:'ArcaneTestProof_observation',placeId:target.placeId,universeId:target.universeId,placeName:'Synthetic place',mode:'Edit',playEpoch:0,continuitySupported:true,connected:true,observedAt:'2026-10-27T00:00:00Z',expiresAt:'2026-10-27T00:01:00Z'}};
  return {args,body,observation,current,revision,applied,session};
}

test('fixed converted observation read validates exact source/context and detaches actual node/object metadata',()=>{
  const f=fixture(),a=validateCommandArgs('scene.observe_import',f.args,f.session),r=validateStudioImportObservationReceipt(a,f.body);
  assert.deepEqual(r,f.observation);assert.equal(r.objects[0]!.meshAssetId,null);assert.equal(r.imported,false);assert.equal(r.engineVerification,'pending');
  assert.ok(Object.isFrozen(r)&&Object.isFrozen(r.source)&&Object.isFrozen(r.nodes[1]!.authoredChildren));assert.notEqual(r.nodes,f.body.nodes);
  f.body.nodes[0]!.ownedStateSha256=sha('later mutation');assert.notEqual(r.nodes[0]!.ownedStateSha256,f.body.nodes[0]!.ownedStateSha256);
  const kept=structuredClone(f.observation);kept.objects[0]!.meshAssetId='912345678';assert.equal(parseStudioImportObservationReceipt(kept).objects[0]!.meshAssetId,'912345678');
});

test('per-operation revision accepts a new current read without rewriting the original sealed observation',()=>{
  const f=fixture(),sealed=JSON.stringify(f.revision.observation),a=validateCommandArgs('asset.apply_revision',f.revision,f.session),r=validateStudioImportRevisionReceipt(a,f.applied);
  assert.equal(r.observationId,f.current.observationId);assert.notEqual(r.observationId,f.observation.observationId);assert.deepEqual(r.source,f.revision.source);assert.equal(r.modelRef.instanceId,f.observation.modelRef.instanceId);
  assert.equal(JSON.stringify(f.revision.observation),sealed);assert.deepEqual(parseStudioImportRevisionReceipt(r),r);assert.ok(Object.isFrozen(r));
  assert.throws(()=>parseStudioImportObservationReceipt(r),refused,'An applied receipt cannot become a fresh read witness.');
  assert.equal(Object.hasOwn(a,'actor'),false,'Per-operation actors are private host custody, not serialized authority.');
});

test('fresh observation identity cannot hide changed old source, graph, root state, reference or owned children',()=>{
  const f=fixture();
  const changes:((value:StudioImportRevisionArgs)=>void)[]=[v=>{v.currentObservation.commandId=v.observation.commandId;},v=>{v.currentObservation.observation.observationId=v.observation.observation.observationId;},
    v=>{v.currentObservation.observation.source.transferDigest=sha('stale source');},v=>{v.currentObservation.observation.source.graphDigest=sha('stale graph');},
    v=>{v.currentObservation.observation.modelOwnedStateSha256=sha('moved root');},v=>{v.currentObservation.observation.modelRef.instanceId='other-root';},
    v=>{v.currentObservation.observation.nodes[0]!.ownedStateSha256=sha('edited group');},v=>{v.currentObservation.observation.nodes[1]!.authoredChildren=[];},
    v=>{v.source.sourceSha256=sha('other retained source');},v=>{v.target.parentRef='other-parent';},v=>{v.continuity.playEpoch++;}];
  for(const change of changes){const value=structuredClone(f.revision);change(value);assert.throws(()=>parseStudioImportRevisionArgs(value),refused);}
});

test('read and revision policy refuse foreign or inactive plugin continuity before command admission',()=>{
  const f=fixture();
  const changes:((session:StudioSession)=>void)[]=[s=>{s.id='foreign-session';},s=>{s.placeId++;},s=>{s.allowWrites=false;},s=>{s.allowedRoots=[];},s=>{s.capabilities=[];},s=>{s.revokedAt='2026-10-27T00:00:01Z';},s=>{s.proof!.placeId++;},s=>{s.proof!.universeId++;},s=>{s.proof!.connected=false;},s=>{s.proof!.mode='Play';},s=>{s.proof!.playEpoch++;},s=>{s.proof!.pluginArtifactHash=sha('other artifact');}];
  for(const change of changes){const session=structuredClone(f.session);change(session);assert.throws(()=>validateCommandArgs('asset.apply_revision',f.revision,session),refused);}
  assert.deepEqual(validateCommandArgs('scene.observe_import',f.args,{...f.session,allowWrites:false}),parseStudioImportObservationArgs(f.args),'Read metadata still requires the real target/context, independently of writes.');
});

test('closed observation parsers reject duplicate identities, model overlap, wrong mesh IDs and forged result echoes',()=>{
  const f=fixture(),changes:((value:StudioImportObservationReceipt)=>void)[]=[v=>{v.nodes.push(v.nodes[0]!);},v=>{v.objects.push(v.objects[0]!);},v=>{v.nodes[0]!.instanceRef=v.modelRef.instanceId;},v=>{v.objects[0]!.ownedStateSha256=sha('wrong mesh');},v=>{v.objects[0]!.authoredChildren=[];},v=>{v.objects[0]!.meshAssetId='0';},v=>{v.source.graphDigest+='\n';}];
  for(const change of changes){const value=structuredClone(f.observation);change(value);assert.throws(()=>parseStudioImportObservationReceipt(value),refused);}
  assert.throws(()=>parseStudioImportObservationReceipt({...f.observation,imported:true}),refused);
  const wrong=structuredClone(f.observation);wrong.source.preparedDigest=sha('foreign preparation');assert.throws(()=>validateStudioImportObservationReceipt(f.args,wrong),refused);
  const applied=structuredClone(f.applied);applied.observationId=f.observation.observationId;assert.throws(()=>validateStudioImportRevisionReceipt(f.revision,applied),refused);
});

test('getters, proxies, hidden fields, symbols, sparse arrays and custom prototypes never become observation data',()=>{
  const f=fixture();let reads=0;
  const getter=structuredClone(f.observation);Object.defineProperty(getter.source,'graphDigest',{enumerable:true,get(){reads++;throw Error('not executed');}});assert.throws(()=>parseStudioImportObservationReceipt(getter),refused);
  const argument=structuredClone(f.args);Object.defineProperty(argument.source,'graphDigest',{enumerable:true,get(){reads++;throw Error('not executed');}});assert.throws(()=>validateCommandArgs('scene.observe_import',argument,f.session),refused,'The actual command policy snapshots before generic JSON normalization.');
  const proxy=new Proxy(f.observation,{getPrototypeOf(){reads++;throw Error('not executed');}});assert.throws(()=>parseStudioImportObservationReceipt(proxy),refused);
  const hidden=structuredClone(f.observation);Object.defineProperty(hidden.source,'secret',{value:'hidden'});assert.throws(()=>parseStudioImportObservationReceipt(hidden),refused);
  const symbol=structuredClone(f.observation);Object.defineProperty(symbol.source,Symbol('hidden'),{value:1});assert.throws(()=>parseStudioImportObservationReceipt(symbol),refused);
  const sparse=structuredClone(f.observation);Reflect.deleteProperty(sparse.nodes,'0');assert.throws(()=>parseStudioImportObservationReceipt(sparse),refused);
  const custom=structuredClone(f.observation);Object.setPrototypeOf(custom.source,{fake:true});assert.throws(()=>parseStudioImportObservationReceipt(custom),refused);assert.equal(reads,0);
});

test('actual observation checksum binds source, target, state and returned persistent mesh identity',()=>{
  const f=fixture(),before=studioImportObservationReceiptDigest(f.observation),changed=structuredClone(f.observation);changed.objects[0]!.meshAssetId='912345678';assert.notEqual(studioImportObservationReceiptDigest(changed),before);
  assert.deepEqual(parseStudioImportObservationWitness(f.revision.observation),f.revision.observation);assert.equal(f.revision.observation.receiptSha256,before);
  assert.throws(()=>parseStudioImportObservationWitness({...f.revision.observation,approved:true}),refused,'A data witness has no approval field.');
});

test('complete observation geometry budget counts the actual outer model and refuses overage',()=>{
  const f=fixture(),value=structuredClone(f.observation);value.objects[0]!.authoredChildren=[];
  value.nodes=Array.from({length:127},(_,i)=>({nodeKey:'node'+i,instanceRef:'group-'+i,ownedStateSha256:sha('group '+i),authoredChildren:[]}));
  value.objects[0]!.instanceRef='group-0';value.objects[0]!.ownedStateSha256=value.nodes[0]!.ownedStateSha256;
  assert.equal(parseStudioImportObservationReceipt(value).nodes.length,127);
  value.objects[0]!.instanceRef='derived-extra';assert.throws(()=>parseStudioImportObservationReceipt(value),refused,'127 nodes plus an extra mesh and root exceed the materialized budget.');
  value.nodes.push({nodeKey:'node127',instanceRef:'extra',ownedStateSha256:sha('extra'),authoredChildren:[]});assert.throws(()=>parseStudioImportObservationReceipt(value),refused);
});
