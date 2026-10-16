import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request as httpRequest} from 'node:http';
import {mkdir,mkdtemp,readFile,writeFile,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute,sep} from 'node:path';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {createAssetService} from '../../apps/daemon/src/asset-service.js';
import {assetRoutes} from '../../apps/daemon/src/asset-routes.js';
import {AssetArchiveStore} from '../../apps/daemon/src/asset-archive-store.js';
import {normalizeRequest} from '../../packages/asset-pipeline/src/index.js';
import {LEDGER_FILE,type ArchiveHostFacts} from '../../packages/asset-pipeline/src/archive-ledger.js';

const id=(n:number)=>n.toString(16).padStart(8,'0')+'-3333-4333-8333-333333333333';
const human='owned-retention-human-token',agent='owned-retention-agent-token';
const facts:ArchiveHostFacts={active:false,readPinned:false,importCaptured:false,preparationRecord:false,pendingStage:false,uncertainLatch:false,manifestVerified:false};
async function fixture(t:test.TestContext,corrupt=false){
  const boundary=await realpath(tmpdir()),root=await realpath(await mkdtemp(join(boundary,'arcane-retention-http-'))),outputRoot=join(root,'assets');await mkdir(outputRoot);
  for(let n=1;n<=2;n++){
    const directory=join(outputRoot,'crate-'+id(n));await mkdir(directory);
    await writeFile(join(directory,'job.json'),JSON.stringify({schemaVersion:1,jobId:id(n),request:normalizeRequest({template:'hero-prop',name:'crate'}),state:'failed',
      startedAt:'2026-10-16T00:00:00.000Z',finishedAt:'2026-10-16T00:00:01.000Z',error:{code:'FIXTURE',message:'Saved failure'}}));
  }
  const original=Buffer.from([0xff,0x00,0x7b,0x80]);
  if(corrupt)await writeFile(join(outputRoot,LEDGER_FILE),original);
  else{const store=await AssetArchiveStore.open({root:outputRoot});await store.archive({jobIds:[id(1)],activeCount:2,facts:async()=>facts,guard:()=>{}});store.close();}
  const service=await createAssetService({cwd:root,outputRoot}),route=assetRoutes(service);let origin='';
  const server=createServer(async(req,res)=>{if(!await route(req,res,new URL(req.url??'/',origin),human,origin,agent)){res.writeHead(404);res.end();}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await service.close();
    const child=relative(boundary,await realpath(root));assert.ok(!isAbsolute(child)&&child.startsWith('arcane-retention-http-')&&!child.includes(sep)&&!child.includes('..'));
    await rm(root,{recursive:true,force:true});});
  const call=async(path:string,input?:unknown,token=human,headers:Record<string,string>={})=>{
    const response=await fetch(origin+'/v1/assets/'+path,{method:input===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,Origin:origin,
      ...(input===undefined?{}:{'Content-Type':'application/json'}),...headers},...(input===undefined?{}:{body:typeof input==='string'?input:JSON.stringify(input)}),signal:AbortSignal.timeout(8000)});
    return{status:response.status,body:await response.json() as Record<string,unknown>};
  };
  return{service,origin,outputRoot,call,original};
}

test('retained-history controls require distinct same-origin human authority before parsing bodies',async t=>{
  const f=await fixture(t),rebuild=t.mock.method(f.service,'rebuildHistory'),confirm=t.mock.method(f.service,'confirmHistory'),restore=t.mock.method(f.service,'restoreHistory');
  for(const path of ['rebuild-history','confirm-history','restore-history']){
    assert.equal((await f.call(path,'{invalid',agent)).status,403);
    assert.equal((await f.call(path,{},human,{Origin:'https://foreign.invalid'})).status,403);
    assert.equal((await f.call(path)).status,405);
  }
  assert.equal((await f.call('history-status',undefined,agent)).status,403);
  assert.equal((await f.call('history-status?jobId='+id(1))).status,400);
  for(const value of [{jobId:id(1)},{path:'../outside'},{confirmed:true}])assert.equal((await f.call('rebuild-history',value)).status,400);
  assert.equal((await f.call('confirm-history',{acceptMissing:true})).status,400);
  assert.equal((await f.call('restore-history',{jobId:'a'.repeat(36)})).status,400);
  assert.equal(rebuild.mock.callCount(),0);assert.equal(confirm.mock.callCount(),0);assert.equal(restore.mock.callCount(),0);
});

test('real human routes restore a retained identity and report the current classification without replay',async t=>{
  const f=await fixture(t),path=join(f.outputRoot,'crate-'+id(1),'job.json'),before=await readFile(path);
  const status=await f.call('history-status');assert.equal(status.status,200);assert.equal((status.body.history as {archived:number}).archived,1);
  const restored=await f.call('restore-history',{jobId:id(1)});assert.equal(restored.status,200);
  assert.deepEqual(restored.body,{restored:{jobId:id(1),swappedOut:null,activeAfter:2}});
  const page=await f.call('jobs?limit=2');assert.equal(page.status,200);assert.equal((page.body.jobs as unknown[]).length,2);
  const confirmed=await f.call('confirm-history',{});assert.equal(confirmed.status,200);
  assert.deepEqual(confirmed.body,{confirmed:{active:2,archived:0,unavailable:0,degraded:false,backup:null}});
  assert.deepEqual(await readFile(path),before);assert.ok(f.service.jobs().every(job=>job.state==='failed'));
});

test('human rebuild retains original corrupt bytes and changed archived evidence cannot be confirmed',async t=>{
  const f=await fixture(t,true),rebuilt=await f.call('rebuild-history',{});assert.equal(rebuilt.status,200);
  const receipt=rebuilt.body.rebuilt as {backup:string;degraded:boolean};assert.equal(receipt.degraded,false);
  assert.match(receipt.backup,/^archive-ledger\.backup-[a-f0-9]{16}-[a-f0-9-]{36}\.bin$/);assert.deepEqual(await readFile(join(f.outputRoot,receipt.backup)),f.original);
  const g=await fixture(t),path=join(g.outputRoot,'crate-'+id(1),'job.json');await writeFile(path,(await readFile(path)).toString()+' ');
  const refused=await g.call('confirm-history',{});assert.equal(refused.status,409);assert.equal(refused.body.error,'ASSET_ARCHIVE_CHANGED');
  assert.equal((await g.call('history-status')).status,200);
});

test('completed request bodies keep maintenance alive, while socket loss aborts before the ledger write',async t=>{
  const f=await fixture(t,true),original=f.service.rebuildHistory;let signal:AbortSignal|undefined,entered!:()=>void,release!:()=>void;
  const observed=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});t.after(()=>release());
  t.mock.method(f.service,'rebuildHistory',async(value?:AbortSignal)=>{signal=value;entered();await gate;return original(value);});
  const request=httpRequest(f.origin+'/v1/assets/rebuild-history',{method:'POST',headers:{Authorization:'Bearer '+human,Origin:f.origin,'Content-Type':'application/json'}},response=>response.resume());
  request.on('error',()=>{});request.end('{}');await observed;await nextTurn();assert.equal(signal?.aborted,false,'normal request completion is not cancellation');
  const aborted=new Promise<void>(resolve=>signal!.addEventListener('abort',()=>resolve(),{once:true}));request.destroy();await aborted;release();
  await nextTurn();assert.deepEqual(await readFile(join(f.outputRoot,LEDGER_FILE)),f.original);
});
