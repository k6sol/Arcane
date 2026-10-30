import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs,{mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {mkdirSync,writeFileSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {isAbsolute,join,relative,sep} from 'node:path';
import {captureAssetSave,type AssetSaveOutcome} from '../../apps/daemon/src/asset-save-tail.js';
import {createAssetService,type AssetStartAdmission} from '../../apps/daemon/src/asset-service.js';
import {createAssetConversationHost} from '../../apps/daemon/src/asset-conversation-host.js';
import {createNativeAssetRegistry} from '../../apps/daemon/src/native-asset-authority.js';
import {ConversationWorkStore} from '../../packages/storage/src/conversation-work-store.js';
import {AssetPipeline,normalizeRequest,makeConvertedGlbCreation,type AssetInput,type AssetJob,type AssetJobResult,type JobOptions,type GlbConversionInput,type ConvertedGlbJob} from '../../packages/asset-pipeline/src/index.js';
import {parseAdoptedGlbManifest} from '../../packages/asset-pipeline/src/adopted-glb.js';
import {atomicAssetJson,AtomicJsonFailure} from '../../packages/asset-pipeline/src/atomic-json.js';
import {sha256} from '../../packages/asset-pipeline/src/validation.js';

function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});void promise.catch(()=>{});return{promise,resolve,reject};}
function gate(){const done=deferred<void>();return{promise:done.promise,release:()=>done.resolve()};}
const saved=()=>Promise.resolve<AssetSaveOutcome>({ok:true});
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function pending(promise:Promise<unknown>){let done=false;void promise.then(()=>{done=true;},()=>{done=true;});await turn();assert.equal(done,false);}

for(const failure of [Error('original save failure'),null,undefined,false,0])test('captured save retains original failure and skips later write: '+String(failure),async()=>{
  let first=0,later=0;const held=gate(),tail=captureAssetSave(saved(),async()=>{first++;await held.promise;throw failure;});
  const queued=captureAssetSave(tail,async()=>{later++;});held.release();const original=await tail;
  assert.equal(original.ok,false);if(original.ok)return assert.fail('Expected original failure.');
  assert.ok(Object.is(original.error,failure));
  const next=await captureAssetSave(Promise.resolve(original),async()=>{later++;});
  assert.equal(await queued,original);assert.equal(next,original);assert.equal(first,1);assert.equal(later,0);
});

test('one captured FIFO save excludes the later owned save while both originals stay observed',async()=>{
  const a=gate(),b=gate(),aEntered=gate(),bEntered=gate();
  try{
    const first=captureAssetSave(saved(),async()=>{aEntered.release();await a.promise;});
    const later=captureAssetSave(first,async()=>{bEntered.release();await b.promise;});
    await aEntered.promise;await pending(first);await pending(later);a.release();await bEntered.promise;
    assert.deepEqual(await first,{ok:true});await pending(later);b.release();assert.deepEqual(await later,{ok:true});
  }finally{a.release();b.release();}
});

async function directory(prefix:string){
  const boundary=await realpath(tmpdir()),root=await realpath(await mkdtemp(join(boundary,prefix)));
  const remove=async()=>{const tail=relative(boundary,root);assert.ok(tail.startsWith(prefix)&&!isAbsolute(tail)&&tail!=='..'&&!tail.startsWith('..'+sep));await rm(root,{recursive:true,force:true});};
  return{root,remove};
}
test('actual atomic save wrapper is retained by identity rather than called a falsy OS failure',{timeout:15000,concurrency:false},async t=>{
  const f=await directory('arcane-atomic-save-tail-'),target=join(f.root,'index.json');await atomicAssetJson(f.root,'index.json','{"before":true}\n');
  const before=await readFile(target),actual=fs.rename;
  const mock=t.mock.method(fs,'rename',async(...args:Parameters<typeof fs.rename>)=>{if(args[1]===target)throw Object.assign(Error('controlled ordinary replace error'),{code:'EIO'});return actual(...args);});
  syncBuiltinESMExports();
  try{
    let original:unknown;
    const outcome=await captureAssetSave(saved(),async()=>{try{await atomicAssetJson(f.root,'index.json','{"after":true}\n');}catch(error){original=error;throw error;}});
    assert.equal(outcome.ok,false);if(outcome.ok)return assert.fail('Expected real atomic wrapper.');
    assert.equal(outcome.error,original);assert.ok(outcome.error instanceof AtomicJsonFailure);assert.equal(outcome.error.phase,'replace');assert.equal(outcome.error.code,'EIO');
    assert.deepEqual(await readFile(target),before);
  }finally{mock.mock.restore();syncBuiltinESMExports();await f.remove();}
});

function triangleGlb():Buffer{
  const bin=Buffer.alloc(80);[0,0,0,1,0,0,0,1,0,0,0,1,0,0,1,0,0,1].forEach((value,index)=>bin.writeFloatLE(value,index*4));[0,1,2].forEach((value,index)=>bin.writeUInt16LE(value,72+index*2));
  const doc={asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0}],meshes:[{primitives:[{attributes:{POSITION:0,NORMAL:1},indices:2}]}],
    buffers:[{byteLength:80}],bufferViews:[{buffer:0,byteOffset:0,byteLength:36},{buffer:0,byteOffset:36,byteLength:36},{buffer:0,byteOffset:72,byteLength:6}],
    accessors:[{bufferView:0,componentType:5126,type:'VEC3',count:3,min:[0,0,0],max:[1,1,0]},{bufferView:1,componentType:5126,type:'VEC3',count:3},{bufferView:2,componentType:5123,type:'SCALAR',count:3}]};
  const json=Buffer.from(JSON.stringify(doc)),length=(json.length+3)&~3,out=Buffer.alloc(28+length+bin.length);
  out.writeUInt32LE(0x46546c67,0);out.writeUInt32LE(2,4);out.writeUInt32LE(out.length,8);out.writeUInt32LE(length,12);out.writeUInt32LE(0x4e4f534a,16);out.fill(0x20,20,20+length);json.copy(out,20);
  out.writeUInt32LE(bin.length,20+length);out.writeUInt32LE(0x004e4942,24+length);bin.copy(out,28+length);return out;
}
type Kind='generation'|'conversion';
interface Control {id:string;directory:string;closed:boolean;finish(state:'failed'|'cancelled'|'interrupted'):Promise<void>;emit(stage:string):void}

// Actual registry/host/service, owned files, real CWS and actual atomic saves.
// Producer handles are controlled: they write truthful no-process journals and
// original callback/listener completion. No native-success manifest or physical
// worker close is invented; "closed" below describes this controlled handle only.
async function fixture(t:TestContext,kind:Kind,options:{saveFailure?:boolean}={}){
  const f=await directory('arcane-final-save-');await mkdir(join(f.root,'project'));const project=await realpath(join(f.root,'project'));
  const source=triangleGlb();await writeFile(join(project,'source.glb'),source);await mkdir(join(f.root,'reports'));
  const outputRoot=join(f.root,'assets'),registry=createNativeAssetRegistry({projectPath:project}),store=new ConversationWorkStore({directory:join(f.root,'bindings'),projectPath:project});
  const controls:Control[]=[],admissions:AssetStartAdmission[]=[],releases=new Set<()=>void>();
  const makeControl=(name:string,request:ReturnType<typeof normalizeRequest>|null,jobOptions:JobOptions,creation:ReturnType<typeof makeConvertedGlbCreation>|null,id:string):AssetJob=>{
    const target=join(outputRoot,name+'-'+id),startedAt=new Date().toISOString();mkdirSync(target);
    const journal={schemaVersion:1,jobId:id,directory:target,request,state:'running',manifestPath:null,error:null,startedAt,workers:[],...(creation?{kind:'converted-glb',creation}:{})};
    writeFileSync(join(target,'job.json'),JSON.stringify(journal)+'\n');
    const done=deferred<AssetJobResult>();let ended=false;
    const control:Control={id,directory:target,closed:false,
      async finish(state){if(ended)return;ended=true;const error=state==='cancelled'?null:{code:state==='interrupted'?'CONTROLLED_UNVERIFIED':'CONTROLLED_FAILURE',message:'Controlled producer result, no native success.'};
        const result:AssetJobResult={jobId:id,directory:target,state,manifestPath:null,error};
        try{await writeFile(join(target,'job.json'),JSON.stringify({...journal,...result,finishedAt:new Date().toISOString()})+'\n');done.resolve(result);}catch(error){done.reject(error);throw error;}},
      emit(stage){assert.equal(control.closed,false);jobOptions.onEvent?.({jobId:id,stage,state:'running',at:new Date().toISOString()});}};
    const abort=()=>{void control.finish('cancelled').catch(()=>{});};jobOptions.signal?.addEventListener('abort',abort,{once:true});
    const completion=done.promise.finally(()=>{jobOptions.signal?.removeEventListener('abort',abort);control.closed=true;});controls.push(control);
    return{id,directory:target,completion,cancel:abort};
  };
  t.mock.method(AssetPipeline.prototype,'start',(input:AssetInput,jobOptions:JobOptions={}):AssetJob=>makeControl(input.name,normalizeRequest(input),jobOptions,null,randomUUID()));
  t.mock.method(AssetPipeline.prototype,'startConversion',(input:GlbConversionInput,jobOptions:JobOptions={}):ConvertedGlbJob=>{
    const id=randomUUID(),parent=parseAdoptedGlbManifest(JSON.parse(input.parentManifest.toString('utf8')));
    const creation=makeConvertedGlbCreation(id,{parentJobId:parent.jobId,parentManifestSha256:input.parentManifestSha256,name:input.name,collision:input.collision,renderResolution:input.renderResolution,renderSamples:input.renderSamples});
    return Object.freeze({...makeControl(input.name,null,jobOptions,creation,id),creation});
  });
  const assets=await createAssetService({cwd:f.root,projectPath:project,outputRoot,studioImport:{workAssociations:store,selectTarget(){return assert.fail('No Studio target in final save fixture.');}},
    reportFailure:async event=>{await writeFile(join(f.root,'reports',event.eventId+'.json'),JSON.stringify(event)+'\n',{flag:'wx'});return event.eventId;}});
  let serial=0;
  const owner=async()=>{
    const incarnation=registry.issue(),credential=incarnation.credential(),connectionId='save-connection-'+(++serial),operationId='save-operation-'+serial,conversation={provider:'codex' as const,threadId:'save-thread-'+serial,sessionId:null};
    incarnation.seal({connectionId,...conversation});incarnation.grant({connectionId,threadId:conversation.threadId});incarnation.dispatched({connectionId,threadId:conversation.threadId,operationId});
    const actor=registry.capture(credential,'mutate');
    const host=createAssetConversationHost({projectPath:project,workAssociations:store,conversation:()=>null,start:async()=>{return assert.fail('Generic start is not admitted.');},
      startNative:async(input,admission)=>{admissions.push(admission);return(await assets.start(input,admission)).jobId;},
      adoptNative:async(input,original,admission)=>(await assets.adoptProjectGlb(input,original,admission)).jobId,
      convertNative:async(input,original,admission)=>{admissions.push(admission);return(await assets.convertProjectGlb(input,original,admission)).jobId;}});
    let parent:string|null=null;
    if(kind==='conversion'){const adopted=await host.adoptNative(actor,{name:'parent-'+serial,path:'source.glb'});assert.ok(adopted.jobId);parent=adopted.jobId;}
    return{incarnation,conversation,async start(name:string){
      if(kind==='generation')return host.startNative(actor,{template:'hero-prop',name,renderResolution:128});
      assert.ok(parent);return host.convertNative(actor,{parentJobId:parent,name,collision:'none',renderResolution:256,renderSamples:8});
    },retire(){incarnation.ended(operationId);incarnation.retire();incarnation.transportClosed();}};
  };
  t.after(async()=>{for(const release of releases)release();let failed=false,failure:unknown;
    const keep=(error:unknown)=>{if(!failed){failed=true;failure=error;}};
    try{
      for(const control of controls)if(!control.closed)try{await control.finish('cancelled');}catch(error){keep(error);}
      try{if(options.saveFailure)await assert.rejects(assets.close(),{code:'PERSISTENCE'});else await assets.close();}catch(error){keep(error);}
    }finally{registry.close();store.close();t.mock.restoreAll();syncBuiltinESMExports();await f.remove();}
    if(failed)throw failure;
  });
  const hold=()=>{const held=gate();releases.add(held.release);return held;};
  return{...f,project,source,outputRoot,registry,store,assets,controls,admissions,owner,hold};
}

for(const kind of ['generation','conversion']as const)test(kind+' final save holds only its original work and excludes a later unrelated snapshot',{timeout:15000,concurrency:false},async t=>{
  const f=await fixture(t,kind),a=await f.owner(),b=await f.owner();const first=await a.start('original-save'),later=await b.start('unrelated-save');assert.ok(first.jobId&&later.jobId);
  const ca=f.controls[0]!,cb=f.controls[1]!,firstEntered=f.hold(),firstRelease=f.hold(),laterEntered=f.hold(),laterRelease=f.hold(),actual=fs.rename;let writes=0;
  const mock=t.mock.method(fs,'rename',async(...args:Parameters<typeof fs.rename>)=>{
    if(args[1]===join(f.outputRoot,'index.json')){writes++;if(writes===1){firstEntered.release();await firstRelease.promise;}else if(writes===2){laterEntered.release();await laterRelease.promise;}}
    return actual(...args);
  });syncBuiltinESMExports();t.after(()=>{mock.mock.restore();syncBuiltinESMExports();});
  await ca.finish('failed');await firstEntered.promise;assert.equal(ca.closed,true);assert.equal(cb.closed,false);a.retire();
  assert.equal(a.incarnation.status().released,false);const work=f.admissions[0]!.work;assert.ok(work);assert.equal(work.signal.aborted,false);
  cb.emit('unrelated-progress');firstRelease.release();await laterEntered.promise;await turn();
  assert.equal(a.incarnation.status().released,true,'Original successful save ended; later owner is still writing.');
  assert.equal(cb.closed,false);const other=f.admissions[1]!.work;assert.ok(other);assert.equal(other.signal.aborted,false);
  laterRelease.release();await cb.finish('failed');await f.assets.cancel(later.jobId);b.retire();assert.equal(b.incarnation.status().released,true);
  assert.equal(f.assets.jobs().find(job=>job.jobId===first.jobId)?.state,'failed');assert.equal(sha256(await readFile(join(f.project,'source.glb'))),sha256(f.source));
});

for(const kind of ['generation','conversion']as const)test(kind+' actual final save failure retains original lease and public PERSISTENCE without changing producer outcome',{timeout:15000,concurrency:false},async t=>{
  const f=await fixture(t,kind,{saveFailure:true}),owner=await f.owner(),started=await owner.start('failed-save');assert.ok(started.jobId);
  const entered=f.hold(),actual=fs.rename;let writes=0;
  const mock=t.mock.method(fs,'rename',async(...args:Parameters<typeof fs.rename>)=>{if(args[1]===join(f.outputRoot,'index.json')){writes++;entered.release();throw Object.assign(Error('controlled final save failure'),{code:'EIO'});}return actual(...args);});
  syncBuiltinESMExports();t.after(()=>{mock.mock.restore();syncBuiltinESMExports();});
  await f.controls[0]!.finish('failed');await entered.promise;await assert.rejects(f.assets.cancel(started.jobId),{code:'PERSISTENCE'});await turn();
  assert.equal(f.controls[0]!.closed,true);const job=f.assets.jobs().find(value=>value.jobId===started.jobId);assert.ok(job);assert.equal(job.state,'failed');assert.equal(job.error?.code,'CONTROLLED_FAILURE');
  const work=f.admissions[0]!.work;assert.ok(work);work.finish('closed');owner.retire();assert.equal(owner.incarnation.status().released,false);assert.equal(writes,1);
  assert.equal(f.store.binding('asset-job',started.jobId)?.conversation.threadId,owner.conversation.threadId);
  const journal:unknown=JSON.parse(await readFile(join(job.directory,'job.json'),'utf8'));assert.ok(journal&&typeof journal==='object');assert.equal(Reflect.get(journal,'state'),'failed');
  assert.equal(sha256(await readFile(join(f.project,'source.glb'))),sha256(f.source));await assert.rejects(f.assets.close(),{code:'PERSISTENCE'});
});

for(const kind of ['generation','conversion']as const)test(kind+' unverified producer remains unresolved even when its final save succeeds',{timeout:15000,concurrency:false},async t=>{
  const f=await fixture(t,kind),owner=await f.owner(),started=await owner.start('unverified-save');assert.ok(started.jobId);
  await f.controls[0]!.finish('interrupted');const job=await f.assets.cancel(started.jobId);assert.equal(job.state,'interrupted');assert.equal(job.error?.code,'CONTROLLED_UNVERIFIED');
  const work=f.admissions[0]!.work;assert.ok(work);work.finish('closed');owner.retire();assert.equal(owner.incarnation.status().released,false);
  const index:unknown=JSON.parse(await readFile(join(f.outputRoot,'index.json'),'utf8'));assert.ok(index&&typeof index==='object');assert.ok(Array.isArray(Reflect.get(index,'jobs')));
});
