import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {mkdir,mkdtemp,readFile,writeFile,realpath,rm} from 'node:fs/promises';
import {mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {isAbsolute,join,relative,sep} from 'node:path';
import {AssetPipeline,normalizeRequest,type AssetJob,type AssetJobResult} from '../../packages/asset-pipeline/src/index.js';
import {AssetArchiveStore} from '../../apps/daemon/src/asset-archive-store.js';
import {createAssetService,type AssetService,type AssetServiceOptions} from '../../apps/daemon/src/asset-service.js';
import {LEDGER_FILE,type ArchiveHostFacts} from '../../packages/asset-pipeline/src/archive-ledger.js';
import {saveStudioFixture} from '../../packages/asset-pipeline/testing/studio-import-fixture.js';

const JOB=(n:number)=>n.toString(16).padStart(8,'0')+'-1111-4111-8111-111111111111';
const FACTS:ArchiveHostFacts={active:false,readPinned:false,importCaptured:false,preparationRecord:false,pendingStage:false,uncertainLatch:false,manifestVerified:false};
const code=(expected:string)=>(error:unknown)=>!!error&&typeof error==='object'&&'code'in error&&error.code===expected;
const guard=()=>{};
async function fixture(t:test.TestContext,count=0){
  const base=await realpath(tmpdir()),root=await realpath(await mkdtemp(join(base,'arcane-retention-service-'))),outputRoot=join(root,'assets');
  await mkdir(outputRoot);const services:AssetService[]=[];
  const spawn=t.mock.method(childProcess,'spawn',()=>{throw Error('Retention fixtures cannot launch a native process.');});syncBuiltinESMExports();
  t.after(async()=>{try{for(const service of services)await service.close();}finally{spawn.mock.restore();syncBuiltinESMExports();
    const child=relative(base,await realpath(root));assert.ok(!isAbsolute(child)&&child.startsWith('arcane-retention-service-')&&!child.includes(sep)&&!child.includes('..'));
    await rm(root,{recursive:true,force:true});}});
  const job=async(n:number)=>{
    const directory=join(outputRoot,'crate-'+JOB(n)),at=new Date(Date.UTC(2026,0,1)+n*1000).toISOString();await mkdir(directory);
    const journal=Buffer.from(JSON.stringify({schemaVersion:1,jobId:JOB(n),state:'failed',request:normalizeRequest({template:'hero-prop',name:'crate'}),
      error:{code:'BLENDER_UNAVAILABLE',message:'Synthetic retained failure.'},startedAt:at,finishedAt:at}));
    await writeFile(join(directory,'job.json'),journal);return{directory,journal};
  };
  for(let start=1;start<=count;start+=16)await Promise.all(Array.from({length:Math.min(16,count-start+1)},(_,i)=>job(start+i)));
  return{root,outputRoot,job,spawns:()=>spawn.mock.callCount(),async open(options:Partial<AssetServiceOptions>={}){
    const service=await createAssetService({cwd:root,outputRoot,...options});services.push(service);return service;
  },pipeline(){
    // Producer boundary double: it writes only this owned synthetic journal and never executes a worker.
    const calls:unknown[]=[];
    t.mock.method(AssetPipeline.prototype,'start',(input:Parameters<AssetPipeline['start']>[0])=>{
      calls.push(structuredClone(input));const request=normalizeRequest(input),id=JOB(9999),directory=join(outputRoot,request.name+'-'+id),at=new Date().toISOString();
      mkdirSync(directory);const journal={schemaVersion:1,jobId:id,state:'running',request,startedAt:at,finishedAt:at,error:null};
      writeFileSync(join(directory,'job.json'),JSON.stringify(journal));
      let resolve!:(result:AssetJobResult)=>void,finished=false;const completion=new Promise<AssetJobResult>(done=>{resolve=done;});
      const finish=()=>{if(finished)return;finished=true;writeFileSync(join(directory,'job.json'),JSON.stringify({...journal,state:'cancelled'}));
        resolve({jobId:id,directory,state:'cancelled',manifestPath:null,error:null});};
      return{id,directory,completion,cancel:finish} as AssetJob;
    });return calls;
  }};
}

test('generation admission archives eligible history and every old UUID stays readable across restart',async t=>{
  const f=await fixture(t,256),calls=f.pipeline(),service=await f.open();
  const original=await readFile(join(f.outputRoot,'crate-'+JOB(1),'job.json'));
  const created=await service.start({template:'hero-prop',name:'new-asset'});assert.equal(calls.length,1);assert.equal(created.jobId,JOB(9999));
  const status=await service.historyStatus();assert.equal(status.degraded,false);assert.equal(status.active,225);assert.equal(status.archived,32);
  const looked=await service.lookupJobs([JOB(1),JOB(256)]);assert.equal(looked.jobs.length,2);assert.equal(looked.unavailable.length,0);
  assert.equal(looked.jobs[0]?.retention?.status,'archived');assert.equal(looked.jobs[0]?.state,'failed');
  assert.deepEqual(looked.jobs[0]?.error,{code:'BLENDER_UNAVAILABLE',message:'Synthetic retained failure.'});
  assert.deepEqual(await readFile(join(f.outputRoot,'crate-'+JOB(1),'job.json')),original);
  const ids:string[]=[];let after:string|undefined;
  do{const page=await service.historyPage({limit:17,...(after?{after}:{})});assert.equal(page.total,257);assert.ok(Buffer.byteLength(JSON.stringify(page))<=page.byteLimit);
    ids.push(...page.jobs.map(job=>job.jobId));assert.equal(page.unavailable,undefined);after=page.nextCursor??undefined;
  }while(after);
  assert.equal(new Set(ids).size,257);assert.equal(ids.length,257);
  await service.close();const restarted=await f.open();
  assert.equal((await restarted.lookupJobs([JOB(1)])).jobs[0]?.retention?.status,'archived');assert.equal((await restarted.historyStatus()).archived,32);
  assert.equal(f.spawns(),0);
});

test('explicit rebuild recovers legacy capacity without replay and preserves its original ledger bytes',async t=>{
  const f=await fixture(t,257),calls=f.pipeline(),original=Buffer.from([0xff,0x7b,0x00,0x80]);
  await writeFile(join(f.outputRoot,LEDGER_FILE),original);
  const service=await f.open();await assert.rejects(service.start({template:'hero-prop',name:'before-inspection'}),code('HISTORY_INTEGRITY'));
  const rebuilt=await service.rebuildHistory();assert.equal(rebuilt.active,256);assert.equal(rebuilt.archived,1);assert.equal(rebuilt.unavailable,0);assert.equal(rebuilt.degraded,false);
  assert.ok(rebuilt.backup);assert.deepEqual(await readFile(join(f.outputRoot,rebuilt.backup!)),original);assert.equal(calls.length,0);
  assert.equal((await service.lookupJobs([JOB(1)])).jobs[0]?.retention?.status,'archived');
  const confirmed=await service.confirmHistory();assert.deepEqual(confirmed,{active:256,archived:1,unavailable:0,degraded:false,backup:null});
  await service.start({template:'hero-prop',name:'after-inspection'});assert.equal(calls.length,1);assert.equal(f.spawns(),0);
});

test('rebuild keeps malformed retained work visible and admission fenced without rewriting the index or journals',async t=>{
  const f=await fixture(t,257),calls=f.pipeline(),directory=join(f.outputRoot,'crate-'+JOB(1)),malformed=Buffer.from('{broken retained job');
  await writeFile(join(directory,'job.json'),malformed);await writeFile(join(f.outputRoot,LEDGER_FILE),'broken ledger');
  const index=Buffer.from('original advisory index bytes');await writeFile(join(f.outputRoot,'index.json'),index);
  const service=await f.open(),result=await service.rebuildHistory();assert.equal(result.degraded,true);assert.equal(result.unavailable,1);
  const row=await service.lookupJobs([JOB(1)]);assert.deepEqual(row.jobs,[]);assert.deepEqual(row.unavailable,[{jobId:JOB(1),name:'crate',status:'conflict'}]);
  await assert.rejects(service.start({template:'hero-prop',name:'must-remain-paused'}),code('HISTORY_INTEGRITY'));
  assert.deepEqual(await readFile(join(directory,'job.json')),malformed);assert.deepEqual(await readFile(join(f.outputRoot,'index.json')),index);assert.equal(calls.length,0);
  await service.close();const reopened=await f.open();assert.equal((await reopened.historyStatus()).degraded,true);
});

test('rebuild never rewrites a newly discovered running journal or releases its supervision fence',async t=>{
  const f=await fixture(t,257),directory=join(f.outputRoot,'crate-'+JOB(257)),path=join(directory,'job.json');
  const saved=JSON.parse((await readFile(path)).toString()) as Record<string,unknown>;saved.state='running';saved.finishedAt=null;
  const original=Buffer.from(JSON.stringify(saved));await writeFile(path,original);
  const service=await f.open(),before=await readFile(path),result=await service.rebuildHistory();
  // If normal startup already owned this record it can mark lost supervision.
  // Rebuilding itself must preserve precisely the bytes it observed.
  assert.deepEqual(await readFile(path),before);
  assert.ok(result.degraded||service.jobs().some(job=>job.jobId===JOB(257)&&job.state==='interrupted'));
  const calls=f.pipeline();await assert.rejects(service.start({template:'hero-prop',name:'must-not-replay'}),error=>code('HISTORY_INTEGRITY')(error)||code('RECONCILIATION')(error));
  assert.equal(calls.length,0);assert.equal(f.spawns(),0);
});

test('confirmation cannot accept changed archived evidence',async t=>{
  const f=await fixture(t,2),store=await AssetArchiveStore.open({root:f.outputRoot});
  await store.archive({jobIds:[JOB(1)],activeCount:2,facts:async()=>FACTS,guard});store.close();const service=await f.open();
  const ledger=await readFile(join(f.outputRoot,LEDGER_FILE)),path=join(f.outputRoot,'crate-'+JOB(1),'job.json');
  await writeFile(path,(await readFile(path)).toString()+' ');await assert.rejects(service.confirmHistory(),code('ASSET_ARCHIVE_CHANGED'));
  assert.deepEqual(await readFile(join(f.outputRoot,LEDGER_FILE)),ledger);assert.equal((await service.historyStatus()).degraded,true);
});

test('history maintenance is one owned operation and close aborts and joins a held inspection',async t=>{
  const f=await fixture(t,1);await writeFile(join(f.outputRoot,LEDGER_FILE),'corrupt');
  let entered!:()=>void,release!:()=>void;const observing=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const service=await f.open({retentionPins:{async preparationRecord(){entered();await gate;return false;},pendingStage:()=>false,importCaptured:()=>false}});
  const pending=service.rebuildHistory(),settled=pending.then(value=>({value}),error=>({error}));await observing;
  await assert.rejects(service.rebuildHistory(),code('BUSY'));await assert.rejects(service.confirmHistory(),code('BUSY'));
  await assert.rejects(service.start({template:'hero-prop',name:'overlap'}),code('BUSY'));
  let closed=false;const closing=service.close().then(()=>{closed=true;});await Promise.resolve();assert.equal(closed,false);release();
  const outcome=await settled;assert.ok('error'in outcome&&code('CLOSED')(outcome.error));await closing;
  assert.equal(closed,true);assert.equal((await readFile(join(f.outputRoot,LEDGER_FILE))).toString(),'corrupt');assert.equal(f.spawns(),0);
});

test('restoring at full active capacity swaps exactly one eligible job and preserves both journals',async t=>{
  const f=await fixture(t,256),store=await AssetArchiveStore.open({root:f.outputRoot});
  await store.archive({jobIds:[JOB(1)],activeCount:256,facts:async()=>FACTS,guard});store.close();await f.job(257);
  const first=await readFile(join(f.outputRoot,'crate-'+JOB(1),'job.json')),second=await readFile(join(f.outputRoot,'crate-'+JOB(2),'job.json'));
  const service=await f.open();assert.deepEqual(await service.restoreHistory(JOB(1)),{jobId:JOB(1),swappedOut:JOB(2),activeAfter:256});
  const result=await service.lookupJobs([JOB(1),JOB(2)]);assert.equal(result.jobs[0]?.retention,undefined);assert.equal(result.jobs[1]?.retention?.status,'archived');
  assert.deepEqual(await readFile(join(f.outputRoot,'crate-'+JOB(1),'job.json')),first);assert.deepEqual(await readFile(join(f.outputRoot,'crate-'+JOB(2),'job.json')),second);
  await service.close();const restarted=await f.open();assert.equal((await restarted.historyStatus()).active,256);assert.equal((await restarted.historyStatus()).archived,1);
  assert.equal((await restarted.lookupJobs([JOB(1)])).jobs[0]?.retention,undefined);assert.equal(f.spawns(),0);
});

test('retained import/preparation pins refuse capacity admission without a producer or ledger write',async t=>{
  const f=await fixture(t,256),calls=f.pipeline(),service=await f.open({retentionPins:{preparationRecord:async()=>true,pendingStage:()=>false,importCaptured:()=>false}});
  await assert.rejects(service.start({template:'hero-prop',name:'new-asset'}),code('HISTORY_LIMIT'));assert.equal(calls.length,0);assert.equal(f.spawns(),0);
  await assert.rejects(readFile(join(f.outputRoot,LEDGER_FILE)),{code:'ENOENT'});assert.equal((await service.historyStatus()).active,256);
});

test('corrupt ledger and over-cap legacy history open for inspection and keep admission fenced',async t=>{
  const f=await fixture(t,257),calls=f.pipeline(),corrupt=Buffer.from('{retained corrupt ledger');await writeFile(join(f.outputRoot,LEDGER_FILE),corrupt);
  const index=Buffer.from('{original advisory bytes');await writeFile(join(f.outputRoot,'index.json'),index);
  const service=await f.open(),status=await service.historyStatus();assert.equal(status.degraded,true);assert.equal(status.active,256);assert.equal(status.unclassified,1);
  const ids:string[]=[];let after:string|undefined;
  do{const page=await service.historyPage({limit:64,...(after?{after}:{})});ids.push(...page.jobs.map(j=>j.jobId),...(page.unavailable??[]).map(j=>j.jobId));after=page.nextCursor??undefined;}while(after);
  assert.equal(new Set(ids).size,257);await assert.rejects(service.start({template:'hero-prop',name:'new-asset'}),code('HISTORY_INTEGRITY'));
  assert.deepEqual(await readFile(join(f.outputRoot,LEDGER_FILE)),corrupt);assert.deepEqual(await readFile(join(f.outputRoot,'index.json')),index);assert.equal(calls.length,0);
});

test('changed or missing archived journals remain explicit page entries and cannot authorize content',async t=>{
  const f=await fixture(t,2),store=await AssetArchiveStore.open({root:f.outputRoot});await store.archive({jobIds:[JOB(1)],activeCount:2,facts:async()=>FACTS,guard});store.close();
  await writeFile(join(f.outputRoot,'crate-'+JOB(1),'job.json'),'{}');const service=await f.open();
  const loaded=await service.lookupJobs([JOB(1),JOB(2)]);assert.equal(loaded.jobs.length,1);assert.deepEqual(loaded.unavailable,[{jobId:JOB(1),name:'crate',status:'conflict'}]);
  const page=await service.historyPage();assert.equal(page.total,2);assert.equal(page.unavailable?.[0]?.jobId,JOB(1));
  await assert.rejects(service.manifest(JOB(1)),code('HISTORY_INTEGRITY'));assert.equal(f.spawns(),0);
});

test('invalid input cannot archive history; lookup bounds and retired reads refuse without effects',async t=>{
  const f=await fixture(t,256),calls=f.pipeline(),service=await f.open();
  await assert.rejects(service.start({template:'hero-prop',name:'../invalid'}),code('INPUT'));
  await assert.rejects(readFile(join(f.outputRoot,LEDGER_FILE)),{code:'ENOENT'});
  await assert.rejects(service.lookupJobs(Array.from({length:65},(_,i)=>JOB(i+1))),code('INPUT'));
  await assert.rejects(service.lookupJobs([JOB(1),JOB(1)]),code('INPUT'));
  await service.close();await assert.rejects(service.lookupJobs([JOB(1)]),code('CLOSED'));assert.equal(calls.length,0);
});

test('archived succeeded jobs still validate actual manifests and export bytes on use',async t=>{
  const f=await fixture(t),id=JOB(1),directory=join(f.outputRoot,'test-kit-'+id);await mkdir(directory);
  const manifest=await saveStudioFixture(directory,id);
  await writeFile(join(directory,'job.json'),JSON.stringify({schemaVersion:1,jobId:id,state:'succeeded',request:manifest.request,error:null,startedAt:manifest.createdAt,finishedAt:manifest.createdAt}));
  const store=await AssetArchiveStore.open({root:f.outputRoot});await store.archive({jobIds:[id],activeCount:1,facts:async()=>({...FACTS,manifestVerified:true}),guard});store.close();
  const service=await f.open();assert.equal((await service.lookupJobs([id])).jobs[0]?.retention?.status,'archived');
  assert.equal((await service.manifest(id)).jobId,id);const exported=await service.artifact(id,'asset.glb');assert.deepEqual(exported.bytes,await readFile(join(directory,'asset.glb')));
  await writeFile(join(directory,'asset.glb'),'changed');await assert.rejects(service.artifact(id,'asset.glb'));assert.equal(f.spawns(),0);
});

test('rebuilt archived successes become usable only after current saved exports pass validation',async t=>{
  const f=await fixture(t),id=JOB(1),directory=join(f.outputRoot,'test-kit-'+id);await mkdir(directory);
  const manifest=await saveStudioFixture(directory,id),journal=Buffer.from(JSON.stringify({schemaVersion:1,jobId:id,state:'succeeded',request:manifest.request,error:null,
    startedAt:'2025-01-01T00:00:00.000Z',finishedAt:'2025-01-01T00:00:01.000Z'}));await writeFile(join(directory,'job.json'),journal);
  for(let n=2;n<=257;n++)await f.job(n);
  const store=await AssetArchiveStore.open({root:f.outputRoot}),rebuilt=await store.rebuild({facts:async()=>FACTS,guard});
  assert.ok(rebuilt.archived.includes(id));store.close();const ledger=await readFile(join(f.outputRoot,LEDGER_FILE));
  assert.equal(JSON.parse(ledger.toString()).entries[0].manifestAvailable,false,'terminal state alone never proves exports');
  const service=await f.open(),record=(await service.lookupJobs([id])).jobs[0];assert.equal(record?.manifestAvailable,true);assert.equal(record?.retention?.status,'archived');
  assert.equal((await service.manifest(id)).jobId,id);assert.deepEqual(await readFile(join(f.outputRoot,LEDGER_FILE)),ledger,'read verification does not rewrite the ledger');
  assert.deepEqual(await readFile(join(directory,'job.json')),journal);
  await writeFile(join(directory,'asset.glb'),'changed');const changed=(await service.lookupJobs([id])).jobs[0];
  assert.equal(changed?.manifestAvailable,false);assert.equal(changed?.error?.code,'HISTORY_INTEGRITY');await assert.rejects(service.manifest(id),code('JOB_STATE'));assert.equal(f.spawns(),0);
});
