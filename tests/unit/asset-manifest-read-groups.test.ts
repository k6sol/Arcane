import test from 'node:test';
import assert from 'node:assert/strict';
import fs, {type FileHandle} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {basename,isAbsolute,join,relative,sep} from 'node:path';
import {manifestFixture,glb} from '../../packages/asset-pipeline/testing/fixture.js';
import {AssetError} from '../../packages/asset-pipeline/src/types.js';
import {sha256,validateManifestFiles} from '../../packages/asset-pipeline/src/validation.js';

function gate(){let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return{promise,resolve};}
const cleanups=new WeakMap<test.TestContext,(()=>Promise<void>)[]>();
async function fixture(t:test.TestContext){
  const base=await fs.realpath(tmpdir()),root=await fs.realpath(await fs.mkdtemp(join(base,'arcane-manifest-groups-')));
  const beforeCleanup:(()=>Promise<void>)[]=[];cleanups.set(t,beforeCleanup);
  t.after(async()=>{for(const finish of beforeCleanup)await finish();const part=relative(base,root);assert.ok(part.startsWith('arcane-manifest-groups-')&&!isAbsolute(part)&&!part.includes(sep));await fs.rm(root,{recursive:true,force:true});});
  return{root,manifest:await manifestFixture(root)};
}
function controlledReads(t:test.TestContext,heldNames:readonly string[]=[],failures=new Map<string,unknown>()){
  const original=fs.open,held=new Map(heldNames.map(name=>[name,gate()])),entered=new Map<string,ReturnType<typeof gate>>(),closed=new Map<string,ReturnType<typeof gate>>();
  const handles:{name:string;handle:FileHandle;reads:number}[]=[],started:string[]=[],pending:Promise<unknown>[]=[];let active=0,maximum=0;
  const event=(events:Map<string,ReturnType<typeof gate>>,name:string)=>{let found=events.get(name);if(!found){found=gate();events.set(name,found);}return found;};
  t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{
    const handle=await original(...args),name=basename(String(args[0])),read=handle.read.bind(handle),close=handle.close.bind(handle),record={name,handle,reads:0};
    handles.push(record);active++;maximum=Math.max(maximum,active);
    t.mock.method(handle,'read',async(...readArgs:any[])=>{
      record.reads++;
      if(record.reads===1){started.push(name);event(entered,name).resolve();await held.get(name)?.promise;}
      const result=await Reflect.apply(read,handle,readArgs);
      if(record.reads===1&&failures.has(name))throw failures.get(name);
      return result;
    });
    t.mock.method(handle,'close',async()=>{try{await close();}finally{active--;event(closed,name).resolve();}});
    return handle;
  });
  const allocation=t.mock.method(Buffer,'alloc');syncBuiltinESMExports();
  const restore=()=>{t.mock.restoreAll();syncBuiltinESMExports();};
  // Any assertion failure still releases test-owned reads before cleanup.
  cleanups.get(t)!.push(async()=>{for(const hold of held.values())hold.resolve();await Promise.allSettled(pending);restore();});
  return{handles,started,entered:(name:string)=>event(entered,name).promise,closed:(name:string)=>event(closed,name).promise,
    release:(name:string)=>held.get(name)?.resolve(),maximum:()=>maximum,restore,
    track:<T>(promise:Promise<T>)=>{pending.push(promise);void promise.catch(()=>{});return promise;},
    allocations:()=>allocation.mock.calls.map(call=>call.arguments[0])};
}

test('manifest verification starts exactly two actual reads and never opens a third before their group joins',{timeout:10000},async t=>{
  const f=await fixture(t),first=f.manifest.artifacts[0]!.path,second=f.manifest.artifacts[1]!.path;
  const reads=controlledReads(t,[first,second]),pending=reads.track(validateManifestFiles(f.root,f.manifest));let settled=false;
  void pending.then(()=>{settled=true;},()=>{settled=true;});
  await Promise.all([reads.entered(first),reads.entered(second)]);
  assert.deepEqual(new Set(reads.started),new Set([first,second]));assert.equal(reads.handles.length,2);assert.equal(settled,false);
  reads.release(second);await reads.closed(second);assert.equal(reads.handles.length,2);assert.equal(settled,false);
  reads.release(first);assert.equal(await pending,f.manifest);
  assert.equal(reads.maximum(),2);assert.ok(reads.handles.every(record=>record.handle.fd===-1));
});

test('later read failure cannot reject before earlier held read closes and first manifest error identity wins',{timeout:10000},async t=>{
  const f=await fixture(t),first=f.manifest.artifacts[0]!.path,second=f.manifest.artifacts[1]!.path;
  const firstFailure=new AssetError('HASH','first original failure'),laterFailure=new AssetError('EXPORT','later original failure');
  const reads=controlledReads(t,[first],new Map([[first,firstFailure],[second,laterFailure]])),pending=reads.track(validateManifestFiles(f.root,f.manifest));let settled=false;
  const outcome=pending.then(()=>({ok:true as const}),error=>{settled=true;return{ok:false as const,error};});
  await Promise.all([reads.entered(first),reads.closed(second)]);assert.equal(settled,false);assert.equal(reads.handles[0]!.handle.fd===-1&&reads.handles[1]!.handle.fd===-1,false);
  reads.release(first);const result=await outcome;assert.equal(result.ok,false);if(!result.ok)assert.equal(result.error,firstFailure);
  assert.ok(reads.handles.every(record=>record.handle.fd===-1));assert.equal(reads.handles.length,2);
});

for(const reason of [null,undefined,false,0])test('metadata refusal '+String(reason)+' joins prior original read and preserves exact falsy identity',{timeout:10000},async t=>{
  const f=await fixture(t),first=f.manifest.artifacts[0]!.path;
  Object.defineProperty(f.manifest.artifacts[1]!,'bytes',{get(){throw reason;},enumerable:true});
  let laterObserved=false;Object.defineProperty(f.manifest.artifacts[2]!,'path',{get(){laterObserved=true;throw new Error('Later metadata must not start');},enumerable:true});
  const reads=controlledReads(t,[first]),pending=reads.track(validateManifestFiles(f.root,f.manifest));let settled=false;
  const outcome=pending.then(()=>({ok:true as const}),error=>{settled=true;return{ok:false as const,error};});
  await reads.entered(first);assert.equal(settled,false);assert.equal(laterObserved,false);assert.equal(reads.handles.length,1);
  reads.release(first);const result=await outcome;assert.equal(result.ok,false);if(!result.ok)assert.equal(result.error,reason);
  assert.equal(laterObserved,false);assert.equal(reads.handles[0]!.handle.fd,-1);
});

test('invalid declared size stops later work and refuses the mismatched opened file before allocation',async t=>{
  const f=await fixture(t),first=f.manifest.artifacts[0]!,actual=first.bytes;first.bytes=NaN;
  let laterObserved=false;Object.defineProperty(f.manifest.artifacts[1]!,'path',{get(){laterObserved=true;throw new Error('Later metadata must not start');},enumerable:true});
  const reads=controlledReads(t);
  await assert.rejects(validateManifestFiles(f.root,f.manifest),(error:unknown)=>error instanceof AssetError&&error.code==='MANIFEST'&&error.message.includes(`observed ${actual}, manifest invalid, total ${actual}.`));
  assert.equal(laterObserved,false);assert.equal(reads.handles.length,1);assert.equal(reads.handles[0]!.reads,0);assert.equal(reads.handles[0]!.handle.fd,-1);assert.deepEqual(reads.allocations(),[]);
});

test('manifest group snapshots declared sizes once and does not reread mutable metadata during admission',async t=>{
  const f=await fixture(t),artifact=f.manifest.artifacts[0]!,declared=artifact.bytes;let observations=0;
  Object.defineProperty(artifact,'bytes',{get(){observations++;return observations===1?declared:1;},enumerable:true});
  assert.equal(await validateManifestFiles(f.root,f.manifest),f.manifest);assert.equal(observations,1);
});

test('two verified 128MiB artifacts cannot admit any further bytes past the original 256MiB aggregate',async t=>{
  const f=await fixture(t),size=128*1024*1024,chunk=Buffer.alloc(1024*1024),digest=createHash('sha256');
  for(let i=0;i<128;i++)digest.update(chunk);const hash=digest.digest('hex');
  for(const artifact of f.manifest.artifacts.slice(0,2)){await fs.truncate(join(f.root,artifact.path),0);await fs.truncate(join(f.root,artifact.path),size);artifact.bytes=size;artifact.sha256=hash;}
  const denied=f.manifest.artifacts[2]!,reads=controlledReads(t);
  await assert.rejects(validateManifestFiles(f.root,f.manifest),(error:unknown)=>error instanceof AssetError&&error.code==='MANIFEST'&&error.message.startsWith(denied.path+':')&&error.message.includes(`observed ${denied.bytes}, manifest ${denied.bytes}, total ${2*size+denied.bytes}.`));
  assert.equal(reads.maximum(),2);assert.ok(reads.handles.every(record=>record.handle.fd===-1));
  assert.ok(reads.handles.filter(record=>record.name===denied.path).every(record=>record.reads===0));
  assert.ok(!reads.allocations().includes(denied.bytes));
});

test('grouped verification retains hash and actual GLB geometry refusals',async t=>{
  const f=await fixture(t),scene=f.manifest.artifacts[0]!;await fs.writeFile(join(f.root,scene.path),Buffer.alloc(scene.bytes,0x7f));
  await assert.rejects(validateManifestFiles(f.root,f.manifest),{code:'HASH'});
  await fs.writeFile(join(f.root,scene.path),'synthetic scene fixture');
  const malformed=glb(doc=>{delete (doc.meshes as {primitives:{attributes:Record<string,number>}[]}[])[0]!.primitives[0]!.attributes.NORMAL;});
  const render=f.manifest.artifacts.find(artifact=>artifact.path==='asset.glb')!;await fs.writeFile(join(f.root,render.path),malformed);render.bytes=malformed.length;render.sha256=sha256(malformed);
  await assert.rejects(validateManifestFiles(f.root,f.manifest),{code:'EXPORT'});
});
