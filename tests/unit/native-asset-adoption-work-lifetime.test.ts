import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs, {mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {basename,isAbsolute,join,relative,sep} from 'node:path';
import {createAssetService,type AssetStartAdmission} from '../../apps/daemon/src/asset-service.js';
import {createAssetConversationHost} from '../../apps/daemon/src/asset-conversation-host.js';
import {acquireNativeAssetWork,createNativeAssetRegistry} from '../../apps/daemon/src/native-asset-authority.js';
import {ConversationWorkStore} from '../../packages/storage/src/conversation-work-store.js';
import {sha256} from '../../packages/asset-pipeline/src/validation.js';

// Actual registry, host, asset service, ordinary files and SQLite CWS. The GLB is
// synthetic. No provider/worker exists: transportClosed below is the controlled
// definitive-no-child branch, never evidence of a native process/Studio close.
const INPUT=Object.freeze({name:'lifetime-adoption',path:'exports/source.glb'});
function gate(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return{promise,release};}
async function pending(value:Promise<unknown>){let settled=false;void value.then(()=>{settled=true;},()=>{settled=true;});await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(settled,false);}
function triangleGlb():Uint8Array{
  const bin=new Uint8Array(80),view=new DataView(bin.buffer);
  [0,0,0,1,0,0,0,1,0,0,0,1,0,0,1,0,0,1].forEach((value,index)=>view.setFloat32(index*4,value,true));
  [0,1,2].forEach((value,index)=>view.setUint16(72+index*2,value,true));
  const doc={asset:{version:'2.0',generator:'Synthetic adoption lifetime fixture'},scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0}],
    buffers:[{byteLength:bin.length}],bufferViews:[{buffer:0,byteOffset:0,byteLength:36},{buffer:0,byteOffset:36,byteLength:36},{buffer:0,byteOffset:72,byteLength:6}],
    accessors:[{bufferView:0,componentType:5126,count:3,type:'VEC3',min:[0,0,0],max:[1,1,0]},
      {bufferView:1,componentType:5126,count:3,type:'VEC3'},{bufferView:2,componentType:5123,count:3,type:'SCALAR'}],
    meshes:[{primitives:[{attributes:{POSITION:0,NORMAL:1},indices:2}]}]};
  const json=new TextEncoder().encode(JSON.stringify(doc)),jsonBytes=(json.length+3)&~3;
  const bytes=new Uint8Array(28+jsonBytes+bin.length),header=new DataView(bytes.buffer);
  header.setUint32(0,0x46546c67,true);header.setUint32(4,2,true);header.setUint32(8,bytes.length,true);
  header.setUint32(12,jsonBytes,true);header.setUint32(16,0x4e4f534a,true);bytes.fill(0x20,20,20+jsonBytes);bytes.set(json,20);
  header.setUint32(20+jsonBytes,bin.length,true);header.setUint32(24+jsonBytes,0x004e4942,true);bytes.set(bin,28+jsonBytes);return bytes;
}
async function fixture(t:TestContext,options:{persistenceFailure?:boolean}={}){
  const boundary=await realpath(tmpdir()),root=await realpath(await mkdtemp(join(boundary,'arcane-adoption-lifetime-')));
  await mkdir(join(root,'project'));const project=await realpath(join(root,'project'));await mkdir(join(project,'exports'));
  const source=join(project,'exports','source.glb'),original=triangleGlb();await writeFile(source,original);
  const store=new ConversationWorkStore({directory:join(root,'bindings'),projectPath:project});
  const registry=createNativeAssetRegistry({projectPath:project});
  const service=await createAssetService({cwd:root,projectPath:project,outputRoot:join(root,'managed'),studioImport:{workAssociations:store,
    selectTarget(){return assert.fail('Adoption never asks Studio for a target.');}}});
  let serial=0;
  const issue=()=>{
    const incarnation=registry.issue(),connectionId='adoption-connection-'+(++serial),operationId='adoption-operation-'+serial;
    const identity={connectionId,provider:'codex' as const,threadId:'adoption-thread-'+serial,sessionId:null};
    incarnation.seal(identity);incarnation.grant({connectionId,threadId:identity.threadId});
    incarnation.dispatched({connectionId,threadId:identity.threadId,operationId});
    const credential=incarnation.credential();
    return{incarnation,operationId,identity,actor:()=>registry.capture(credential,'mutate')};
  };
  const own=issue(),admissions:AssetStartAdmission[]=[],releases=new Set<()=>void>();
  const host=createAssetConversationHost({projectPath:project,workAssociations:store,conversation:()=>null,
    start:async()=>{return assert.fail('No generation callback is allowed.');},
    adoptNative:async(input,actor,admission)=>{admissions.push(admission);return(await service.adoptProjectGlb(input,actor,admission)).jobId;}});
  t.after(async()=>{
    for(const release of releases)release();
    try{if(options.persistenceFailure)await assert.rejects(service.close(),{code:'PERSISTENCE'});else await service.close();}finally{registry.close();store.close();const tail=relative(boundary,root);
      assert.ok(tail.startsWith('arcane-adoption-lifetime-')&&!isAbsolute(tail)&&tail!=='..'&&!tail.startsWith('..'+sep));
      await rm(root,{recursive:true,force:true});}
  });
  const retire=()=>{own.incarnation.ended(own.operationId);own.incarnation.retire();own.incarnation.transportClosed();};
  return{root,source,original,store,registry,service,host,own,issue,admissions,retire,
    hold(){const held=gate();releases.add(held.release);return held;},
    adopt:()=>host.adoptNative(own.actor(),INPUT)};
}

test('actual adoption requires original lease and same-operation signal before file allocation',{timeout:10000},async t=>{
  const f=await fixture(t),actor=f.own.actor(),other=f.issue(),own=acquireNativeAssetWork(actor,'generation'),foreign=acquireNativeAssetWork(other.actor(),'generation');
  let callbacks=0,reads=0;const callbacksOnly={beforeCreate(){callbacks++;},created(){callbacks++;}};
  const getter=Object.defineProperty({...own},'signal',{get(){reads++;return own.signal;}});
  try{
    for(const {admission,code} of [{admission:callbacksOnly,code:'ADMISSION_WORK'},
      {admission:{...callbacksOnly,work:own,signal:new AbortController().signal},code:'ADMISSION_WORK'},
      {admission:{...callbacksOnly,work:foreign,signal:foreign.signal},code:'ADMISSION_WORK'},
      {admission:{...callbacksOnly,work:{...own},signal:own.signal},code:'NATIVE_ASSET_AUTHORITY'},
      {admission:{...callbacksOnly,work:getter,signal:own.signal},code:'NATIVE_ASSET_AUTHORITY'}]){
      await assert.rejects(async()=>f.service.adoptProjectGlb(INPUT,actor,admission),{code});
    }
    assert.equal(callbacks,0);assert.equal(reads,0);assert.deepEqual(f.service.jobs(),[]);
    assert.deepEqual(f.store.list({provider:'codex',threadId:f.own.identity.threadId,sessionId:null},'asset-job').items,[]);
  }finally{own.finish('closed');foreign.finish('closed');}
});

for(const mode of ['retire','stop','registry-close-stop']as const)test('held original source handle survives original '+mode+' until actual close',{timeout:10000,concurrency:false},async t=>{
  const f=await fixture(t),entered=f.hold(),release=f.hold(),actual=fs.open;let sourceClosed=false;
  const mock=t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{
    const handle=await actual(...args);
    if(args[0]===f.source){const close=handle.close.bind(handle);t.mock.method(handle,'close',async()=>{try{await close();}finally{sourceClosed=true;}});entered.release();await release.promise;}
    return handle;
  });
  syncBuiltinESMExports();t.after(()=>{mock.mock.restore();syncBuiltinESMExports();});
  const adoption=f.adopt();void adoption.catch(()=>{});await entered.promise;
  assert.equal(f.admissions.length,1);const work=f.admissions[0]!.work;assert.ok(work);assert.equal(f.admissions[0]!.signal,work.signal);
  const stop=mode!=='retire';
  if(mode==='registry-close-stop'){f.registry.close();f.own.incarnation.cancelWork('incarnation');f.own.incarnation.transportClosed();}
  else{if(stop)f.own.incarnation.cancelWork('incarnation');f.retire();}
  assert.equal(work.signal.aborted,stop);assert.equal(f.own.incarnation.status().released,false);assert.equal(sourceClosed,false);await pending(adoption);
  release.release();await assert.rejects(adoption);assert.equal(sourceClosed,true);
  assert.equal(f.own.incarnation.status().released,true,'No allocation occurred and the actual original file read/close ended.');
  assert.deepEqual(f.service.jobs(),[]);assert.equal(sha256(await readFile(f.source)),sha256(f.original));
});

test('published rename tail keeps original attribution after retirement and retains unknown ownership',{timeout:10000,concurrency:false},async t=>{
  const f=await fixture(t),entered=f.hold(),release=f.hold(),actual=fs.rename;let publications=0;
  const mock=t.mock.method(fs,'rename',async(...args:Parameters<typeof fs.rename>)=>{
    await actual(...args);
    if(typeof args[0]==='string'&&basename(args[0]).startsWith('.adopting-')){publications++;entered.release();await release.promise;}
  });
  syncBuiltinESMExports();t.after(()=>{mock.mock.restore();syncBuiltinESMExports();});
  const adoption=f.adopt();await entered.promise;const work=f.admissions[0]!.work;assert.ok(work);
  f.retire();assert.equal(work.signal.aborted,false);assert.equal(f.own.incarnation.status().released,false);await pending(adoption);
  release.release();const result=await adoption;assert.ok(result.jobId);assert.equal(result.creation,'created');assert.equal(result.association,'bound');assert.equal(result.retry,false);
  assert.equal(publications,1);assert.equal(f.store.binding('asset-job',result.jobId)?.conversation.threadId,f.own.identity.threadId);
  const job=f.service.jobs().find(row=>row.jobId===result.jobId);assert.ok(job);assert.equal(job.state,'failed');
  assert.equal(f.own.incarnation.status().released,false,'Post-publication ownership loss remains unresolved, with no worker inferred.');
});

test('original final adoption persistence is joined even after completion fact and retirement',{timeout:10000,concurrency:false},async t=>{
  const f=await fixture(t),entered=f.hold(),release=f.hold(),actual=fs.rename;let commits=0;
  const mock=t.mock.method(fs,'rename',async(...args:Parameters<typeof fs.rename>)=>{
    if(args[1]===join(f.service.outputRoot,'index.json')){commits++;entered.release();await release.promise;}
    return actual(...args);
  });
  syncBuiltinESMExports();t.after(()=>{mock.mock.restore();syncBuiltinESMExports();});
  const adoption=f.adopt();await entered.promise;assert.equal(f.service.jobs()[0]?.state,'succeeded');
  f.retire();assert.equal(f.own.incarnation.status().released,false);await pending(adoption);
  release.release();const result=await adoption;assert.ok(result.jobId);assert.equal(result.creation,'created');assert.equal(commits,1);
  assert.equal(f.own.incarnation.status().released,true,'Only the original completed commit permits this file-operation lease to release.');
  assert.equal(f.service.jobs()[0]?.state,'succeeded');assert.equal(sha256(await readFile(f.source)),sha256(f.original));
});

test('failed original final index persistence keeps unresolved lease despite later closed label',{timeout:10000,concurrency:false},async t=>{
  const f=await fixture(t,{persistenceFailure:true}),actual=fs.rename,indexPath=join(f.service.outputRoot,'index.json'),before=await readFile(indexPath);let attempts=0;
  const mock=t.mock.method(fs,'rename',async(...args:Parameters<typeof fs.rename>)=>{
    if(args[1]===indexPath){attempts++;throw Error('controlled final adoption persistence failure');}
    return actual(...args);
  });
  syncBuiltinESMExports();t.after(()=>{mock.mock.restore();syncBuiltinESMExports();});
  const result=await f.adopt();assert.ok(result.jobId);assert.equal(result.creation,'unknown');assert.equal(result.association,'unknown');assert.equal(result.retry,false);
  assert.equal(attempts,1);assert.equal(f.admissions.length,1);assert.equal(f.store.binding('asset-job',result.jobId)?.conversation.threadId,f.own.identity.threadId);
  const job=f.service.jobs().find(row=>row.jobId===result.jobId);assert.ok(job);assert.equal(job.state,'failed');
  const journal:unknown=JSON.parse(await readFile(join(job.directory,'job.json'),'utf8'));assert.ok(journal&&typeof journal==='object'&&!Array.isArray(journal));assert.equal(Reflect.get(journal,'jobId'),result.jobId);assert.equal(Reflect.get(journal,'state'),'failed');
  assert.equal(sha256(await readFile(f.source)),sha256(f.original));assert.equal(sha256(await readFile(join(job.directory,'asset.glb'))),sha256(f.original));assert.deepEqual(await readFile(indexPath),before);
  const work=f.admissions[0]!.work;assert.ok(work);work.finish('closed');f.retire();
  assert.equal(f.own.incarnation.status().released,false,'A later closed label cannot erase the original unconfirmed persistence tail.');
  await assert.rejects(f.service.close(),{code:'PERSISTENCE'});assert.equal(attempts,1);assert.equal(f.admissions.length,1);
});

test('lost original binding COMMIT acknowledgement retains lease without rebind or copy',{timeout:10000},async t=>{
  const f=await fixture(t),actual=f.store.bind.bind(f.store),failure=Error('controlled original binding ACK lost');let calls=0;
  f.store.bind=input=>{calls++;actual(input);throw failure;};
  const result=await f.adopt();assert.ok(result.jobId);assert.equal(result.association,'unknown');assert.equal(result.creation,'unknown');assert.equal(result.retry,false);assert.equal(calls,1);
  assert.equal(f.store.binding('asset-job',result.jobId)?.conversation.threadId,f.own.identity.threadId);
  const job=f.service.jobs().find(row=>row.jobId===result.jobId);assert.ok(job);assert.equal(job.state,'failed');
  await assert.rejects(readFile(join(job.directory,'asset.glb')),{code:'ENOENT'});
  f.retire();assert.equal(f.own.incarnation.status().released,false,'A committed binding plus lost ACK is not a known closed admission.');
});

test('known failed copy with exact attribution and completed journal closes without inventing worker uncertainty',{timeout:10000,concurrency:false},async t=>{
  const f=await fixture(t),actual=fs.writeFile;let refused=0;
  const mock=t.mock.method(fs,'writeFile',async(...args:Parameters<typeof fs.writeFile>)=>{
    if(typeof args[0]==='string'&&basename(args[0])==='asset.glb'){refused++;throw Error('controlled ordinary file copy failure');}
    return actual(...args);
  });
  syncBuiltinESMExports();t.after(()=>{mock.mock.restore();syncBuiltinESMExports();});
  const result=await f.adopt();assert.ok(result.jobId);assert.equal(result.creation,'created');assert.equal(result.association,'bound');assert.equal(result.retry,false);assert.equal(refused,1);
  const job=f.service.jobs().find(row=>row.jobId===result.jobId);assert.ok(job);assert.equal(job.state,'failed');assert.equal(job.error?.code,'ASSET_ADOPT_INCOMPLETE');
  assert.equal(f.store.binding('asset-job',result.jobId)?.conversation.threadId,f.own.identity.threadId);
  const journal:unknown=JSON.parse(await readFile(join(job.directory,'job.json'),'utf8'));assert.ok(journal&&typeof journal==='object'&&!Array.isArray(journal));assert.equal(Reflect.get(journal,'state'),'failed');
  f.retire();assert.equal(f.own.incarnation.status().released,true,'The failed job is known and its original file/journal I/O completed.');
});

for(const published of [false,true])test('uncertain original publication keeps its lease, renamed='+published,{timeout:10000,concurrency:false},async t=>{
  const f=await fixture(t),actual=fs.rename;let attempts=0;
  const mock=t.mock.method(fs,'rename',async(...args:Parameters<typeof fs.rename>)=>{
    if(typeof args[0]==='string'&&basename(args[0]).startsWith('.adopting-')){attempts++;if(published)await actual(...args);throw Error('controlled publication ACK unknown');}
    return actual(...args);
  });
  syncBuiltinESMExports();t.after(()=>{mock.mock.restore();syncBuiltinESMExports();});
  const result=await f.adopt();assert.equal(result.jobId,null);assert.equal(result.creation,'unknown');assert.equal(result.association,'unknown');assert.equal(result.retry,false);assert.equal(attempts,1);
  assert.deepEqual(f.service.jobs(),[]);f.retire();assert.equal(f.own.incarnation.status().released,false);
});

test('ordinary completed pre-admission GLB refusal releases its original file lifetime',{timeout:10000},async t=>{
  const f=await fixture(t);await writeFile(f.source,'not a GLB');
  await assert.rejects(f.adopt(),{code:'ASSET_ADOPT_GLB'});assert.equal(f.admissions.length,1);assert.deepEqual(f.service.jobs(),[]);
  f.retire();assert.equal(f.own.incarnation.status().released,true);
});
