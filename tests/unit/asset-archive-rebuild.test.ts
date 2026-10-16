import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,readdir,writeFile,realpath,rm,link,symlink,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {AssetArchiveStore} from '../../apps/daemon/src/asset-archive-store.js';
import {AtomicJsonFailure,atomicAssetJson} from '../../packages/asset-pipeline/src/atomic-json.js';
import {LEDGER_FILE,parseLedger,type ArchiveHostFacts} from '../../packages/asset-pipeline/src/archive-ledger.js';

// Owned temp filesystem fixtures only; no service, process query, inference, Blender or Studio.
const JOB=(n:number)=>n.toString(16).padStart(8,'0')+'-2222-4222-8222-222222222222';
const at=(n:number)=>new Date(Date.UTC(2026,0,1)+n*60000).toISOString();
const FACTS:ArchiveHostFacts=Object.freeze({active:false,readPinned:false,importCaptured:false,preparationRecord:false,pendingStage:false,uncertainLatch:false,manifestVerified:false});
const guard=()=>{};
const code=(name:string)=>(error:unknown)=>!!error&&typeof error==='object'&&'code'in error&&error.code==='ASSET_ARCHIVE_'+name;
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const unhandled:unknown[]=[];process.on('unhandledRejection',error=>{unhandled.push(error);});
const CORRUPT=Buffer.from([0xff,0xfe,0x7b,0x22,0xc3,0x28,0x00,0x0a,0x80,0x7d]); // invalid UTF-8 and JSON
type Writer=(directory:string,filename:string,text:string)=>Promise<void>;
async function fixture(t:test.TestContext,writer?:Writer){
  const base=await realpath(tmpdir()),root=await realpath(await mkdtemp(join(base,'arcane-archive-rebuild-')));
  const stores:AssetArchiveStore[]=[];
  t.after(async()=>{for(const store of stores)store.close();const child=relative(base,await realpath(root));
    assert.ok(!isAbsolute(child)&&child.startsWith('arcane-archive-rebuild-')&&!child.includes(sep)&&!child.includes('..'));
    await rm(root,{recursive:true,force:true});});
  const job=async(n:number,options:{state?:string;name?:string;journal?:Buffer|null;artifact?:boolean}={})=>{
    const name=options.name??'crate',directory=join(root,name+'-'+JOB(n));await mkdir(directory);
    const journal=options.journal===undefined?Buffer.from(JSON.stringify({schemaVersion:1,jobId:JOB(n),request:{schemaVersion:1,template:'hero-prop',name},
      state:options.state??'failed',startedAt:at(n),finishedAt:options.state==='running'?null:at(n)})):options.journal;
    if(journal)await writeFile(join(directory,'job.json'),journal);
    if(options.artifact)await writeFile(join(directory,'model.glb'),Buffer.from('glTF fixture '+n));
    return{directory,journal};
  };
  const open=async()=>{const store=await AssetArchiveStore.open({root,...(writer?{writer}:{})});stores.push(store);return store;};
  // Exact bytes of every job file, so tests prove no journal/artifact mutation.
  const snapshot=async()=>{const rows:string[]=[];for(const entry of (await readdir(root,{withFileTypes:true})).filter(e=>e.isDirectory()).sort((a,b)=>a.name<b.name?-1:1))
    for(const file of (await readdir(join(root,entry.name))).sort())rows.push(entry.name+'/'+file+':'+hash(await readFile(join(root,entry.name,file))));return rows;};
  const ledger=()=>readFile(join(root,LEDGER_FILE));
  return{root,job,open,snapshot,ledger};
}
const rebuild=(store:AssetArchiveStore,facts:(jobId:string)=>Promise<ArchiveHostFacts>=async()=>FACTS,g:()=>void=guard)=>store.rebuild({facts,guard:g});

test('corrupt ledger bytes are preserved exactly, then a valid ledger survives restart without touching jobs',async t=>{
  const f=await fixture(t);for(let n=1;n<=3;n++)await f.job(n,{artifact:true});
  await writeFile(join(f.root,LEDGER_FILE),CORRUPT);const before=await f.snapshot(),store=await f.open();
  assert.deepEqual((await store.scan()).reasons,['ledger-invalid']);
  const result=await rebuild(store);
  assert.ok(result.backup&&result.backup.startsWith('archive-ledger.backup-')&&!result.backup.includes(sep));
  assert.deepEqual(await readFile(join(f.root,result.backup!)),CORRUPT,'original invalid UTF-8 bytes preserved byte-for-byte');
  assert.equal((await lstat(join(f.root,result.backup!))).nlink,1);
  assert.deepEqual([...result.active],[JOB(1),JOB(2),JOB(3)]);assert.deepEqual([...result.archived],[]);
  assert.ok(parseLedger(await f.ledger()).ok);assert.equal((await store.scan()).degraded,false);
  assert.deepEqual(await f.snapshot(),before,'no job journal or artifact changed');
  store.close();const restarted=await f.open();assert.equal((await restarted.scan()).degraded,false);
  await restarted.confirm(guard);
});

test('legacy over-cap inventory keeps the newest 256 visible and archives only freshly eligible older jobs',async t=>{
  const f=await fixture(t);for(let n=1;n<=300;n++)await f.job(n);
  await f.job(301,{state:'running'});await f.job(302,{journal:null});await f.job(303,{journal:Buffer.from('{not json')});
  const before=await f.snapshot(),store=await f.open();assert.ok((await store.scan()).reasons.includes('active-limit'));
  const unresolved=new Set([JOB(4)]);
  const result=await rebuild(store,async id=>unresolved.has(id)?{...FACTS,uncertainLatch:true}:FACTS);
  assert.equal(result.backup,null);assert.equal(result.active.length,256);assert.equal(result.archived.length,47);
  for(const id of [JOB(301),JOB(302),JOB(303),JOB(4)])assert.ok(result.active.includes(id),'unresolved/running/missing/malformed stay visible: '+id);
  for(let n=253;n<=300;n++)if(n!==4)assert.ok(result.active.includes(JOB(n)),'newest stay active');
  assert.ok(result.archived.includes(JOB(1))&&!result.archived.includes(JOB(4)));
  const parsed=parseLedger(await f.ledger());assert.ok(parsed.ok&&parsed.ledger.entries.every(e=>e.manifestAvailable===false),'no manufactured manifest availability');
  assert.deepEqual(await f.snapshot(),before);
  store.close();const scan=await (await f.open()).scan();
  assert.equal(scan.degraded,false);assert.equal(scan.active.length,256);assert.ok(scan.archived.every(a=>a.status==='archived'));
});

test('full capacity succeeds exactly; one more job or an incomplete scan refuses without writing',async t=>{
  const f=await fixture(t);for(let n=1;n<=256+4096+1;n++)await f.job(n);
  const store=await f.open();
  await assert.rejects(rebuild(store),code('CAPACITY'));await assert.rejects(f.ledger(),{code:'ENOENT'});
  await rm(join(f.root,'crate-'+JOB(256+4096+1)),{recursive:true});
  const result=await rebuild(store);assert.equal(result.active.length,256);assert.equal(result.archived.length,4096);
  const committed=await f.ledger();
  for(let n=0;n<70;n++)await writeFile(join(f.root,'note-'+n+'.txt'),'x');
  await assert.rejects(rebuild(store),code('SCAN_LIMIT'));assert.deepEqual(await f.ledger(),committed);
});

test('more than 256 unarchivable jobs cannot be hidden: capacity refusal',async t=>{
  const f=await fixture(t);for(let n=1;n<=257;n++)await f.job(n,{state:'running'});
  await assert.rejects(rebuild(await f.open()),code('CAPACITY'));await assert.rejects(f.ledger(),{code:'ENOENT'});
});

test('retained classifications need their directory and fresh eligibility; changed eligible evidence is refreshed',async t=>{
  const f=await fixture(t),a=await f.job(1);const b=await f.job(2);await f.job(3);let store=await f.open();
  await store.archive({jobIds:[JOB(1),JOB(2)],activeCount:3,facts:async()=>FACTS,guard});
  const committed=await f.ledger();
  await assert.rejects(rebuild(store,async id=>id===JOB(2)?{...FACTS,active:true}:FACTS),code('CHANGED'));assert.deepEqual(await f.ledger(),committed);
  await writeFile(join(a.directory,'job.json'),a.journal!.toString()+' ');
  const refreshed=await rebuild(store);assert.deepEqual([...refreshed.archived],[JOB(1),JOB(2)]);assert.ok(refreshed.backup);
  assert.deepEqual(await readFile(join(f.root,refreshed.backup!)),committed);
  assert.equal((await store.scan()).degraded,false);
  const kept=await f.ledger();await rm(b.directory,{recursive:true});store.close();store=await f.open();
  await assert.rejects(rebuild(store),code('MISSING'));assert.deepEqual(await f.ledger(),kept,'no acknowledge-missing release');
});

test('leases, retirement, closure, busy and async guards refuse without writing',async t=>{
  const f=await fixture(t);await f.job(1);await f.job(2);await writeFile(join(f.root,LEDGER_FILE),CORRUPT);const store=await f.open();
  const release=store.pin([JOB(1)]);await assert.rejects(rebuild(store),code('LEASED'));release();
  for(const after of [1,2,3,5,8]){let calls=0;
    await assert.rejects(rebuild(store,async()=>FACTS,()=>{if(++calls>=after)throw new Error('retired');}),/retired/);}
  await assert.rejects(rebuild(store,async()=>FACTS,(()=>Promise.resolve()) as unknown as ()=>void),code('GUARD'));
  let gate!:()=>void;const held=new Promise<void>(resolve=>{gate=resolve;});
  const first=rebuild(store,async()=>{await held;throw new Error('host facts unavailable');});await assert.rejects(rebuild(store),code('BUSY'));
  let pinDuring:(()=>void)|null=null;gate();await first.catch(()=>{});
  const pinned=rebuild(store,async id=>{if(!pinDuring)pinDuring=store.pin([id]);return FACTS;});await assert.rejects(pinned,code('LEASED'));pinDuring!();
  assert.deepEqual((await f.ledger()).subarray(0,CORRUPT.length),CORRUPT);
  store.close();await assert.rejects(rebuild(store),code('CLOSED'));
});

test('linked, duplicated and unsafe sources are refused intact',async t=>{
  const f=await fixture(t);await f.job(1);await f.job(1,{name:'box'});
  await assert.rejects(rebuild(await f.open()),code('DUPLICATE'));
  const g=await fixture(t);await g.job(1);const target=join(g.root,'outside');await mkdir(target);
  try{await symlink(target,join(g.root,'crate-'+JOB(9)),'junction');}catch(error){t.diagnostic('junction unavailable: '+String(error));}
  await assert.rejects(rebuild(await g.open()),(error:unknown)=>code('DIRECTORY')(error)||code('PATH')(error));
  const h=await fixture(t);await h.job(1);await writeFile(join(h.root,'external'),CORRUPT);await link(join(h.root,'external'),join(h.root,LEDGER_FILE));
  await assert.rejects(rebuild(await h.open()),code('LEDGER_SOURCE'));assert.deepEqual(await h.ledger(),CORRUPT);
  const k=await fixture(t);await k.job(1);const huge=Buffer.alloc(4*1024*1024+1,0x20);await writeFile(join(k.root,LEDGER_FILE),huge);
  await assert.rejects(rebuild(await k.open()),code('LEDGER_SOURCE'));assert.ok((await k.ledger()).equals(huge));
  assert.deepEqual((await readdir(k.root)).filter(n=>n.startsWith('archive-ledger.backup-')),[]);
});

test('backup substitution before commit refuses; after commit it is reported uncertain',async t=>{
  const f=await fixture(t);await f.job(1);await writeFile(join(f.root,LEDGER_FILE),CORRUPT);const store=await f.open();let pass=0;
  await assert.rejects(rebuild(store,async()=>{
    if(++pass===2)for(const name of (await readdir(f.root)).filter(n=>n.startsWith('archive-ledger.backup-')))await writeFile(join(f.root,name),'substituted');
    return FACTS;}),code('BACKUP'));
  assert.deepEqual(await f.ledger(),CORRUPT,'old classification and bytes unchanged');
  const g=await fixture(t,async(directory,filename,text)=>{
    for(const name of (await readdir(directory)).filter(n=>n.startsWith('archive-ledger.backup-')))await writeFile(join(directory,name),'late substitution');
    await atomicAssetJson(directory,filename,text);});
  await g.job(1);await writeFile(join(g.root,LEDGER_FILE),CORRUPT);const later=await g.open();
  await assert.rejects(rebuild(later),code('BACKUP'));assert.ok((await later.scan()).reasons.includes('commit-uncertain'));
});

test('faults before replacement keep the old classification; ambiguous replacement stays fenced',async t=>{
  const pre=await fixture(t,async()=>{throw new AtomicJsonFailure('write',new Error('disk full'));});
  await pre.job(1);await writeFile(join(pre.root,LEDGER_FILE),CORRUPT);let store=await pre.open();
  await assert.rejects(rebuild(store),code('PERSISTENCE'));assert.deepEqual(await pre.ledger(),CORRUPT);
  assert.deepEqual((await store.scan()).reasons,['ledger-invalid'],'old classification retained, no uncertainty');
  const landed=await fixture(t,async(directory,filename,text)=>{await atomicAssetJson(directory,filename,text);throw new AtomicJsonFailure('replace',new Error('ambiguous'));});
  await landed.job(1);store=await landed.open();
  await assert.rejects(rebuild(store),code('UNCERTAIN'));assert.ok((await store.scan()).reasons.includes('commit-uncertain'));
  const foreign=await fixture(t,async(directory,filename)=>{await atomicAssetJson(directory,filename,'{"schemaVersion":1,"kind":"arcane-asset-archive","entries":[]}\n ');});
  await foreign.job(1);store=await foreign.open();
  await assert.rejects(rebuild(store),code('UNCERTAIN'));
  const retired=await fixture(t,async(directory,filename,text)=>{store.close();await atomicAssetJson(directory,filename,text);});
  await retired.job(1);await writeFile(join(retired.root,LEDGER_FILE),CORRUPT);store=await retired.open();
  const outcome=await rebuild(store).then(value=>value,error=>error);
  assert.ok(parseLedger(await retired.ledger()).ok,'a begun commit is joined and inspected despite closure');
  assert.ok(!(outcome instanceof Error)||code('UNCERTAIN')(outcome)||code('BACKUP')(outcome));
});

test('rebuild never produced an unhandled rejection',async()=>{assert.deepEqual(unhandled,[]);});
