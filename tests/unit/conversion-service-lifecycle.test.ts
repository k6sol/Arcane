import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {mkdir,mkdtemp,readFile,writeFile,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {isAbsolute,join,relative,sep} from 'node:path';
import {createAssetService,type AssetService,type AssetStartAdmission} from '../../apps/daemon/src/asset-service.js';
import {createAssetConversationHost} from '../../apps/daemon/src/asset-conversation-host.js';
import {AssetArchiveStore} from '../../apps/daemon/src/asset-archive-store.js';
import {createNativeAssetRegistry,acquireNativeAssetWork} from '../../apps/daemon/src/native-asset-authority.js';
import {ConversationWorkStore,type NativeConversation} from '../../packages/storage/src/conversation-work-store.js';
import {AssetPipeline,AssetError,makeConvertedGlbCreation,type GlbConversionInput,type ConvertedGlbJob,type AssetJobResult,type JobOptions} from '../../packages/asset-pipeline/src/index.js';
import {snapshotGlbConversionInput,prepareRetainedGlbConversionInput} from '../../packages/asset-pipeline/src/conversion-input.js';
import {parseConvertedGlbRequest,type ConvertedGlbRequest} from '../../packages/asset-pipeline/src/converted-glb.js';
import {assessEligibility,type ArchiveHostFacts} from '../../packages/asset-pipeline/src/archive-ledger.js';
import {sha256} from '../../packages/asset-pipeline/src/validation.js';

// Real ordinary source/managed files, SQLite bindings, registry actors and work
// leases. The producer seam writes only controlled journals/terminal outcomes;
// it never fabricates a successful native manifest or starts a process.
const CHAT='11111111-1111-4111-8111-111111111111';
const AT='2026-10-27T01:00:00.000Z';
const FACTS:ArchiveHostFacts={active:false,readPinned:false,importCaptured:false,preparationRecord:false,pendingStage:false,uncertainLatch:false,manifestVerified:true};
const code=(expected:string)=>(error:unknown)=>!!error&&typeof error==='object'&&'code'in error&&error.code===expected;
function gate(){let release!:()=>void;const promise=new Promise<void>(done=>{release=done;});return{promise,release};}
function triangleGlb():Buffer {
  const bin=Buffer.alloc(80);
  [0,0,0,1,0,0,0,1,0,0,0,1,0,0,1,0,0,1].forEach((v,i)=>bin.writeFloatLE(v,i*4));
  [0,1,2].forEach((v,i)=>bin.writeUInt16LE(v,72+i*2));
  const doc={asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0}],meshes:[{primitives:[{attributes:{POSITION:0,NORMAL:1},indices:2}]}],
    buffers:[{byteLength:78}],bufferViews:[{buffer:0,byteOffset:0,byteLength:36},{buffer:0,byteOffset:36,byteLength:36},{buffer:0,byteOffset:72,byteLength:6}],
    accessors:[{bufferView:0,componentType:5126,type:'VEC3',count:3,min:[0,0,0],max:[1,1,0]},
      {bufferView:1,componentType:5126,type:'VEC3',count:3},{bufferView:2,componentType:5123,type:'SCALAR',count:3}]};
  const text=Buffer.from(JSON.stringify(doc)),length=(text.length+3)&~3,out=Buffer.alloc(28+length+bin.length);
  out.writeUInt32LE(0x46546c67,0);out.writeUInt32LE(2,4);out.writeUInt32LE(out.length,8);
  out.writeUInt32LE(length,12);out.writeUInt32LE(0x4e4f534a,16);out.fill(0x20,20,20+length);text.copy(out,20);
  out.writeUInt32LE(bin.length,20+length);out.writeUInt32LE(0x004e4942,24+length);bin.copy(out,28+length);return out;
}
function preparedRequest(input:GlbConversionInput,id:string):ConvertedGlbRequest {
  const p=prepareRetainedGlbConversionInput(snapshotGlbConversionInput(input)),s=p.source;
  const map={schemaVersion:2,fidelityPolicy:'arcane-static-fidelity-v1',sourceSha256:s.sourceSha256,importSha256:s.importSha256,
    sourceSceneIndex:s.sourceSceneIndex,declaredSceneCount:s.declaredSceneCount,parts:s.parts,nodes:s.nodes};
  return parseConvertedGlbRequest({schemaVersion:2,fidelityPolicy:'arcane-static-fidelity-v1',kind:'converted-glb',jobId:id,parentJobId:p.parent.jobId,
    parentManifestSha256:p.parentManifestSha256,name:p.name,sourceSha256:s.sourceSha256,sourceBytes:p.sourceGlb.length,
    importSha256:s.importSha256,importBytes:s.importBytes.length,sourceMapSha256:sha256(Buffer.from(JSON.stringify(map)+'\n')),
    collision:p.collision,renderResolution:p.renderResolution,renderSamples:p.renderSamples});
}
type Control={id:string;directory:string;input:GlbConversionInput;options:JobOptions;cancels:number;
  finish(state:AssetJobResult['state'],request?:ConvertedGlbRequest|null,workers?:unknown[]):void;reject():void};
async function fixture(t:test.TestContext,provider:NativeConversation['provider']='codex'){
  const boundary=await realpath(tmpdir()),directory=await realpath(await mkdtemp(join(boundary,'arcane-conversion-service-')));
  const project=join(directory,'project');await mkdir(project);const canonical=await realpath(project);
  const store=new ConversationWorkStore({directory:join(directory,'bindings'),projectPath:canonical}),registry=createNativeAssetRegistry({projectPath:canonical});
  const outputRoot=join(directory,'assets'),source=triangleGlb();await writeFile(join(project,'source.glb'),source);
  const spawn=t.mock.method(childProcess,'spawn',()=>{throw Error('Conversion lifecycle fixture cannot launch a process.');});syncBuiltinESMExports();
  const services:AssetService[]=[],controls:Control[]=[],archives:AssetArchiveStore[]=[];let selected=0,sequence=0;
  const originalPin=AssetArchiveStore.prototype.pin;
  t.mock.method(AssetArchiveStore.prototype,'pin',function(this:AssetArchiveStore,ids:readonly string[]):()=>void{
    if(!archives.includes(this))archives.push(this);return originalPin.call(this,ids);
  });
  function owner(kind:NativeConversation['provider']=provider,conversationId=CHAT){
    const incarnation=registry.issue(),credential=incarnation.credential(),connectionId='owned-connection-'+(++sequence);
    const conversation:NativeConversation={provider:kind,threadId:kind==='codex'?'owned-thread-'+conversationId:'app:'+conversationId,sessionId:null};
    if(kind==='codex')incarnation.seal({connectionId,provider:'codex',threadId:conversation.threadId,sessionId:null});
    else if(kind==='claude-code')incarnation.bindAppConversation({kind:'app-conversation',provider:kind,connectionId,conversationId,
      transport:{kind:'claude-code-process',incarnationId:'owned-process-'+sequence,nativeSessionId:null}});
    else incarnation.bindAppConversation({kind:'app-conversation',provider:kind,connectionId,conversationId,
      transport:{kind:'arcane-gateway-loop',incarnationId:'owned-loop-'+sequence}});
    const operationId='operation-'+sequence,binding={connectionId,threadId:conversation.threadId};
    incarnation.grantNextIntent({...binding,sessionId:null});incarnation.dispatched({...binding,operationId});
    return{incarnation,conversation,operationId,binding,actor:registry.capture(credential,'mutate')};
  }
  const current=owner();
  const serviceOptions={cwd:directory,projectPath:canonical,outputRoot,studioImport:{workAssociations:store,
    selectTarget(){selected++;throw Error('No native target operation is part of conversion lifecycle.');}},
    retentionPins:{preparationRecord:async()=>false,pendingStage:()=>false,importCaptured:()=>false}};
  t.after(async()=>{try{for(const opened of services)await opened.close();}finally{registry.close();store.close();spawn.mock.restore();syncBuiltinESMExports();
    const child=relative(boundary,directory);assert.ok(!isAbsolute(child)&&child.startsWith('arcane-conversion-service-')&&!child.includes(sep)&&!child.includes('..'));
    await rm(directory,{recursive:true,force:true});}});
  let service=await createAssetService(serviceOptions);services.push(service);
  const makeHost=()=>createAssetConversationHost({projectPath:canonical,workAssociations:store,conversation:()=>current.conversation,
    start:async()=>{throw Error('No generator route in this fixture.');},
    adoptNative:async(input,actor,admission)=>(await service.adoptProjectGlb(input,actor,admission)).jobId,
    convertNative:async(input,actor,admission)=>(await service.convertProjectGlb(input,actor,admission)).jobId});
  let host=makeHost();
  const adopted=await host.adoptNative(current.actor,{name:'original-card',path:'source.glb'});assert.equal(adopted.association,'bound');assert.ok(adopted.jobId);
  const parentId=adopted.jobId,parentDirectory=join(outputRoot,'original-card-'+parentId);
  t.mock.method(AssetPipeline.prototype,'startConversion',(input:GlbConversionInput,options:JobOptions={}):ConvertedGlbJob=>{
    const id=randomUUID(),target=join(outputRoot,input.name+'-'+id),parent=JSON.parse(input.parentManifest.toString('utf8')) as {jobId:string};
    const creation=makeConvertedGlbCreation(id,{parentJobId:parent.jobId,parentManifestSha256:input.parentManifestSha256,
      name:input.name,collision:input.collision,renderResolution:input.renderResolution,renderSamples:input.renderSamples});
    mkdirSync(target);const initial={schemaVersion:1,kind:'converted-glb',jobId:id,directory:target,manifestPath:null,error:null,
      creation,request:null,state:'running',startedAt:AT,workers:[]};writeFileSync(join(target,'job.json'),JSON.stringify(initial)+'\n');
    let resolve!:(result:AssetJobResult)=>void,reject!:(error:Error)=>void,settled=false;
    const pending=new Promise<AssetJobResult>((done,fail)=>{resolve=done;reject=fail;});
    const control:Control={id,directory:target,input,options,cancels:0,
      finish(state,request=null,workers=[]){if(settled)return;settled=true;
        const error=state==='cancelled'?null:{code:state==='interrupted'?'SUPERVISION_UNRESOLVED':'ASSET_FAILED',message:'Controlled terminal outcome; no native success.'};
        writeFileSync(join(target,'job.json'),JSON.stringify({...initial,state,request,workers,error,finishedAt:AT})+'\n');
        resolve({jobId:id,directory:target,state,manifestPath:null,error});},
      reject(){if(settled)return;settled=true;reject(Error('Controlled lost completion.'));}};
    controls.push(control);const abort=()=>{control.cancels++;control.finish('cancelled');};
    options.signal?.addEventListener('abort',abort,{once:true});
    const completion=pending.finally(()=>options.signal?.removeEventListener('abort',abort));
    return Object.freeze({id,directory:target,creation,completion,cancel:abort});
  });
  const input=()=>({parentJobId:parentId,name:'derived-card',collision:'none' as const,renderResolution:256,renderSamples:8});
  return{directory,project:canonical,outputRoot,store,registry,current,owner,parentId,parentDirectory,source,input,controls,services,
    get service(){return service;},get host(){return host;},get archive(){assert.ok(archives.length);return archives.at(-1)!;},
    selected:()=>selected,spawns:()=>spawn.mock.callCount(),
    async restart(){await service.close();service=await createAssetService(serviceOptions);services.push(service);host=makeHost();return service;}};
}

for(const provider of ['codex','claude-code','arcane'] as const)test(provider+' conversion admits actual managed parent snapshots and exposes truthful pending metadata',async t=>{
  const f=await fixture(t,provider);await writeFile(join(f.project,'source.glb'),Buffer.from('changed original project path'));
  const result=await f.host.convertNative(f.current.actor,f.input());assert.equal(result.creation,'created');assert.equal(result.association,'bound');assert.equal(result.retry,false);
  const c=f.controls[0]!;assert.equal(f.controls.length,1);assert.deepEqual(c.input.sourceGlb,f.source);
  assert.deepEqual(c.input.parentManifest,await readFile(join(f.parentDirectory,'manifest.json')));assert.equal(c.input.parentManifestSha256,sha256(c.input.parentManifest));
  assert.deepEqual(Object.keys(c.input).sort(),['collision','name','parentManifest','parentManifestSha256','renderResolution','renderSamples','sourceGlb'].sort());
  const job=f.service.jobs().find(row=>row.jobId===c.id);assert.ok(job&&job.kind==='converted-glb');assert.equal(job.form,'new-pending');assert.equal(job.request,null);
  assert.equal(job.creation?.parentJobId,f.parentId);assert.equal(job.manifestAvailable,false);assert.equal(job.manifestPath,null);assert.equal(Object.hasOwn(job,'name'),false);
  assert.deepEqual(f.store.binding('asset-job',c.id)?.conversation,f.current.conversation);
  const parent=f.service.jobs().find(row=>row.jobId===f.parentId)!;assert.equal(Object.hasOwn(parent,'kind'),false);assert.equal(Object.hasOwn(parent,'form'),false);assert.equal(Object.hasOwn(parent,'creation'),false);
  c.finish('failed');await f.service.cancel(c.id);assert.equal(f.selected(),0);assert.equal(f.spawns(),0);
});

test('conversion public authority fields, foreign bindings and changed managed bytes refuse before allocation',async t=>{
  const f=await fixture(t);let created=0,before=0;
  const direct=async(input:unknown,owner=f.current)=>{const work=acquireNativeAssetWork(owner.actor,'generation');
    try{return await f.service.convertProjectGlb(input,owner.actor,{work,signal:work.signal,beforeCreate(){before++;},created(){created++;}});}finally{work.finish('closed');}};
  await assert.rejects(direct({...f.input(),waitMs:1}),code('ASSET_CONVERT_INPUT'));
  await assert.rejects(direct({...f.input(),sourceGlb:f.source}),code('ASSET_CONVERT_INPUT'));
  const foreign=f.owner('arcane','22222222-2222-4222-8222-222222222222');await assert.rejects(direct(f.input(),foreign),code('ASSET_CONVERT_SCOPE'));
  await assert.rejects(direct({...f.input(),parentJobId:randomUUID()}),code('ASSET_CONVERT_SCOPE'));
  const path=join(f.parentDirectory,'asset.glb'),bytes=await readFile(path);await writeFile(path,Buffer.concat([bytes,Buffer.from([0])]));
  await assert.rejects(direct(f.input()));assert.equal(f.controls.length,0);assert.equal(before,0);assert.equal(created,0);assert.equal(f.spawns(),0);
});

test('held preflight cannot upgrade a revoked then regranted actor into new conversion authority',async t=>{
  const f=await fixture(t),entered=gate(),held=gate(),scan=AssetArchiveStore.prototype.scan;
  t.mock.method(AssetArchiveStore.prototype,'scan',async function(this:AssetArchiveStore){const result=await scan.call(this);entered.release();await held.promise;return result;});
  const pending=f.host.convertNative(f.current.actor,f.input());await entered.promise;
  f.current.incarnation.revokeGrant();f.current.incarnation.grant(f.current.binding);held.release();
  await assert.rejects(pending,code('NATIVE_ASSET_AUTHORITY'));assert.equal(f.controls.length,0);assert.equal(f.store.list(f.current.conversation,'asset-job',{limit:64}).items.length,1);
});

test('actual work hold and parent pin are installed before created can finish and retire the host',async t=>{
  const f=await fixture(t),work=acquireNativeAssetWork(f.current.actor,'generation');let witnessed=0;
  const admission:AssetStartAdmission={work,signal:work.signal,beforeCreate(){},created(id){witnessed++;f.store.bind({conversation:f.current.conversation,kind:'asset-job',id});
    work.finish('closed');f.current.incarnation.retire();f.current.incarnation.transportClosed();assert.equal(f.current.incarnation.status().released,false);}};
  const job=await f.service.convertProjectGlb(f.input(),f.current.actor,admission);assert.equal(witnessed,1);assert.equal(job.kind,'converted-glb');
  assert.equal(await f.archive.eligible(f.parentId,FACTS),false);assert.equal(f.controls[0]!.options.signal?.aborted,false);
  f.controls[0]!.finish('cancelled');await f.service.cancel(job.jobId);assert.equal(f.current.incarnation.status().released,true);
  assert.equal(await f.archive.eligible(f.parentId,FACTS),true);assert.equal(f.spawns(),0);
});

test('lost child binding acknowledgement keeps one witnessed job and its owned worker without replay',async t=>{
  const f=await fixture(t),bind=f.store.bind;let attempts=0;
  t.mock.method(f.store,'bind',(input:Parameters<ConversationWorkStore['bind']>[0])=>{bind.call(f.store,input);attempts++;throw Error('Controlled binding ACK loss after real commit.');});
  const result=await f.host.convertNative(f.current.actor,f.input());assert.equal(result.creation,'unknown');assert.equal(result.association,'unknown');assert.equal(result.retry,false);
  assert.equal(attempts,1);assert.equal(f.controls.length,1);assert.equal(result.jobId,f.controls[0]!.id);assert.ok(f.store.binding('asset-job',result.jobId!));
  f.current.incarnation.retire();f.current.incarnation.transportClosed();assert.equal(f.current.incarnation.status().released,false);
  f.controls[0]!.finish('cancelled');await f.service.cancel(result.jobId);assert.equal(f.current.incarnation.status().released,true);assert.equal(attempts,1);
});

test('normal end and retirement preserve accepted conversion; exact incarnation Stop cancels only original work',async t=>{
  const f=await fixture(t),foreign=f.owner(),foreignWork=acquireNativeAssetWork(foreign.actor,'generation');
  const result=await f.host.convertNative(f.current.actor,f.input()),c=f.controls[0]!;
  f.current.incarnation.ended(f.current.operationId);f.current.incarnation.retire();f.current.incarnation.transportClosed();assert.equal(c.options.signal?.aborted,false);
  f.current.incarnation.cancelWork('incarnation');assert.equal(c.options.signal?.aborted,true);assert.equal(foreignWork.signal.aborted,false);
  await f.service.cancel(result.jobId);assert.equal(c.cancels>=1,true);assert.equal(f.current.incarnation.status().released,true);foreignWork.finish('closed');
});

test('synchronous failed allocation creates no witness and releases only its original lease hold and parent pin',async t=>{
  const f=await fixture(t),work=acquireNativeAssetWork(f.current.actor,'generation');let starts=0,created=0;
  t.mock.method(AssetPipeline.prototype,'startConversion',()=>{starts++;throw new AssetError('BUSY','Controlled allocation refusal.');});
  await assert.rejects(f.service.convertProjectGlb(f.input(),f.current.actor,{work,signal:work.signal,beforeCreate(){},created(){created++;}}),code('BUSY'));
  work.finish('closed');f.current.incarnation.retire();f.current.incarnation.transportClosed();assert.equal(f.current.incarnation.status().released,true);
  assert.equal(starts,1);assert.equal(created,0);assert.equal(f.controls.length,0);assert.equal(await f.archive.eligible(f.parentId,FACTS),true);
});

test('unknown completion retains parent and registry fences across promise settlement and service restart',async t=>{
  const f=await fixture(t),result=await f.host.convertNative(f.current.actor,f.input()),c=f.controls[0]!;c.reject();await f.service.cancel(result.jobId);
  const job=f.service.jobs().find(row=>row.jobId===c.id)!;assert.equal(job.state,'interrupted');assert.equal(await f.archive.eligible(f.parentId,FACTS),false);
  f.current.incarnation.retire();f.current.incarnation.transportClosed();assert.equal(f.current.incarnation.status().released,false);
  await f.restart();assert.equal(await f.archive.eligible(f.parentId,FACTS),false);
  const fresh=f.owner();await assert.rejects(f.host.convertNative(fresh.actor,f.input()),code('RECONCILIATION'));assert.equal(f.controls.length,1);assert.equal(f.spawns(),0);
});

test('invalidated exact worker-resolution marker repins the known parent before retention effects',async t=>{
  const f=await fixture(t),result=await f.host.convertNative(f.current.actor,f.input()),c=f.controls[0]!;
  const closed=[{schemaVersion:1,role:'generate',reservationId:randomUUID(),reservedAt:'2026-10-27T01:00:00.0000000Z',state:'closed',
    closure:'not-started',closedAt:'2026-10-27T01:00:01.0000000Z',identity:null}];
  c.finish('interrupted',null,closed);await f.service.cancel(result.jobId);assert.equal(await f.archive.eligible(f.parentId,FACTS),false);
  const resolution=await f.service.resolveInterrupted(c.id);assert.equal(resolution.status,'resolved');assert.equal(await f.archive.eligible(f.parentId,FACTS),true);
  const path=join(c.directory,'worker-resolution.json'),original=await readFile(path),changed=JSON.parse(original.toString('utf8')) as Record<string,unknown>;
  changed.journalSha256='f'.repeat(64);await writeFile(path,JSON.stringify(changed)+'\n');
  await assert.rejects(f.service.rebuildHistory(),code('ASSET_ARCHIVE_LEASED'));assert.equal(await f.archive.eligible(f.parentId,FACTS),false);
  await writeFile(path,original);assert.equal((await f.service.resolveInterrupted(c.id)).status,'resolved');assert.equal(await f.archive.eligible(f.parentId,FACTS),true);
  assert.equal(f.controls.length,1);assert.equal(f.spawns(),0);
});

test('actual prepared journal request survives failed completion, logical archive and read-only hydration',async t=>{
  const f=await fixture(t),result=await f.host.convertNative(f.current.actor,f.input()),c=f.controls[0]!,request=preparedRequest(c.input,c.id);
  c.finish('failed',request);await f.service.cancel(result.jobId);
  const live=f.service.jobs().find(row=>row.jobId===c.id);assert.ok(live&&live.kind==='converted-glb');assert.equal(live.form,'new-prepared');assert.deepEqual(live.request,request);
  await f.archive.archive({jobIds:[c.id],activeCount:2,facts:async()=>({...FACTS,manifestVerified:false}),guard(){}});
  const original=await readFile(join(c.directory,'job.json'));await f.restart();
  const loaded=(await f.service.lookupJobs([c.id])).jobs[0];assert.ok(loaded&&loaded.kind==='converted-glb');assert.equal(loaded.form,'new-prepared');assert.deepEqual(loaded.request,request);assert.equal(loaded.retention?.status,'archived');
  assert.deepEqual(await readFile(join(c.directory,'job.json')),original);assert.equal(f.controls.length,1);assert.equal(f.spawns(),0);
});

test('archive classification keeps all four metadata forms distinct and rejects false authority or closure',async t=>{
  const f=await fixture(t),result=await f.host.convertNative(f.current.actor,f.input()),c=f.controls[0]!,request=preparedRequest(c.input,c.id);
  const raw=JSON.parse((await readFile(join(c.directory,'job.json'))).toString('utf8')) as Record<string,unknown>;
  c.finish('cancelled');await f.service.cancel(result.jobId);
  for(const form of ['new-pending','new-prepared','legacy-pending','legacy-prepared'] as const){
    const row:Record<string,unknown>={...raw,state:'failed',request:form.endsWith('prepared')?request:null,error:null};if(form.startsWith('legacy'))delete row.creation;
    const eligibility=assessEligibility({jobId:c.id,name:'derived-card',journal:Buffer.from(JSON.stringify(row)),marker:null,facts:{...FACTS,manifestVerified:false}});
    assert.equal(eligibility.eligible,true,form);if(eligibility.eligible)assert.equal(eligibility.entry.template,'converted-glb');
  }
  for(const row of [{...raw,state:'succeeded',request:null},{...raw,state:'failed',creation:null},
    {...raw,state:'failed',request:{...request,name:'different-name'}},{...raw,state:'failed',workers:undefined}]){
    assert.equal(assessEligibility({jobId:c.id,name:'derived-card',journal:Buffer.from(JSON.stringify(row)),marker:null,facts:FACTS}).eligible,false);
  }
});

test('pending converted jobs refuse review/import before target calls or generated adapter access',async t=>{
  const f=await fixture(t),result=await f.host.convertNative(f.current.actor,f.input());
  const child=f.service.jobs().find(job=>job.jobId===result.jobId);assert.ok(child&&child.kind==='converted-glb'&&child.form==='new-pending');
  assert.equal(child.state,'running');assert.equal(child.request,null);assert.equal(child.manifestAvailable,false);
  const scope={projectId:f.store.projectId,conversation:f.current.conversation};
  await assert.rejects(f.service.modelReviewSubject(result.jobId,scope),code('ASSET_REVIEW_JOB_STATE'));
  await assert.rejects(f.service.prepareStudioImport(result.jobId,f.current.actor),code('JOB_STATE'));
  assert.equal(f.selected(),0);assert.equal(f.spawns(),0);f.controls[0]!.finish('cancelled');await f.service.cancel(result.jobId);
});

test('recovery refusal never converts an unknown closed state into a released parent pin',async t=>{
  const f=await fixture(t),result=await f.host.convertNative(f.current.actor,f.input()),c=f.controls[0]!;c.finish('failed');await f.service.cancel(result.jobId);
  const original=await readFile(join(c.directory,'job.json'));await f.service.close();
  t.mock.method(AssetPipeline.prototype,'recover',async()=>{throw new AssetError('RECOVERY','Controlled recovery evidence unavailable.');});
  await f.restart();assert.equal((await f.service.historyStatus()).degraded,true);assert.equal(await f.archive.eligible(f.parentId,FACTS),false);
  const row=f.service.jobs().find(job=>job.jobId===c.id);assert.equal(row?.state,'interrupted');
  assert.deepEqual(await readFile(join(c.directory,'job.json')),original);assert.equal(f.controls.length,1);assert.equal(f.spawns(),0);
});

test('a terminal completion label cannot release a parent or work lease with unresolved retained worker evidence',async t=>{
  const f=await fixture(t),result=await f.host.convertNative(f.current.actor,f.input()),c=f.controls[0]!;
  c.finish('failed',null,[{schemaVersion:1,role:'generate',reservationId:randomUUID(),reservedAt:'2026-10-27T01:00:00.0000000Z',state:'reserved'}]);
  await f.service.cancel(result.jobId);
  const row=f.service.jobs().find(job=>job.jobId===c.id);assert.equal(row?.state,'interrupted');assert.equal(row?.error?.code,'SUPERVISION_LOST');
  assert.equal(await f.archive.eligible(f.parentId,FACTS),false);
  f.current.incarnation.retire();f.current.incarnation.transportClosed();assert.equal(f.current.incarnation.status().released,false);
  assert.equal(f.controls.length,1);assert.equal(f.spawns(),0);
});

for(const state of ['failed','cancelled','timed_out'] as const)test(state+' retained label with unverified workers stays pinned and fenced after actual recovery',async t=>{
  const f=await fixture(t),result=await f.host.convertNative(f.current.actor,f.input()),c=f.controls[0]!;
  c.finish(state);await f.service.cancel(result.jobId);
  const path=join(c.directory,'job.json'),raw=JSON.parse((await readFile(path)).toString('utf8')) as Record<string,unknown>;
  if(state==='failed')raw.workers=[{schemaVersion:1,role:'generate',reservationId:randomUUID(),reservedAt:'2026-10-27T01:00:00.0000000Z',state:'reserved'}];
  else if(state==='cancelled')delete raw.workers;
  else raw.workers=[{schemaVersion:1,state:'closed'}];
  const original=Buffer.from(JSON.stringify(raw)+'\n');await writeFile(path,original);await f.restart();
  const row=f.service.jobs().find(job=>job.jobId===c.id);assert.equal(row?.state,'interrupted');assert.equal(row?.error?.code,'SUPERVISION_LOST');
  assert.equal(await f.archive.eligible(f.parentId,FACTS),false);
  const fresh=f.owner();await assert.rejects(f.host.convertNative(fresh.actor,f.input()),code('RECONCILIATION'));
  assert.deepEqual(await readFile(path),original);assert.equal(f.controls.length,1);assert.equal(f.spawns(),0);
});
