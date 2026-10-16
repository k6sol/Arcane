import test from 'node:test';
import assert from 'node:assert/strict';
import fs,{mkdir,mkdtemp,readFile,writeFile,realpath,rm,rename,link,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute,sep} from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
import {createHash} from 'node:crypto';
import {AssetArchiveStore} from '../../apps/daemon/src/asset-archive-store.js';
import {AtomicJsonFailure,atomicAssetJson} from '../../packages/asset-pipeline/src/atomic-json.js';
import {LEDGER_FILE,parseLedger,fingerprintOf,type ArchiveHostFacts,type LedgerEntry} from '../../packages/asset-pipeline/src/archive-ledger.js';

const JOB=(n:number)=>n.toString(16).padStart(8,'0')+'-1111-4111-8111-111111111111';
const AT='2026-10-16T00:00:00.000Z';
const FACTS:ArchiveHostFacts=Object.freeze({active:false,readPinned:false,importCaptured:false,preparationRecord:false,pendingStage:false,uncertainLatch:false,manifestVerified:false});
const guard=()=>{};
const code=(name:string)=>(error:unknown)=>!!error&&typeof error==='object'&&'code'in error&&error.code==='ASSET_ARCHIVE_'+name;
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t:test.TestContext,options:Parameters<typeof AssetArchiveStore.open>[0]['writer']=undefined){
  const base=await realpath(tmpdir()),root=await realpath(await mkdtemp(join(base,'arcane-archive-store-')));
  const stores:AssetArchiveStore[]=[];
  t.after(async()=>{for(const store of stores)store.close();const child=relative(base,await realpath(root));
    assert.ok(!isAbsolute(child)&&child.startsWith('arcane-archive-store-')&&!child.includes(sep)&&!child.includes('..'));
    await rm(root,{recursive:true,force:true});});
  const job=async(n:number,state='failed',name='crate')=>{
    const directory=join(root,name+'-'+JOB(n));await mkdir(directory);
    const journal=Buffer.from(JSON.stringify({schemaVersion:1,jobId:JOB(n),request:{schemaVersion:1,template:'hero-prop',name},state,startedAt:AT,finishedAt:AT}));
    await writeFile(join(directory,'job.json'),journal);return{directory,journal};
  };
  return{root,job,async open(){const store=await AssetArchiveStore.open({root,...(options?{writer:options}:{})});stores.push(store);return store;}};
}

test('durable archive writes one ledger, preserves job bytes and survives a fresh owner',async t=>{
  const f=await fixture(t),a=await f.job(1),b=await f.job(2),store=await f.open();
  assert.deepEqual((await store.scan()).active.map(j=>j.jobId).sort(),[JOB(1),JOB(2)]);
  assert.deepEqual(await store.archive({jobIds:[JOB(1)],activeCount:2,facts:async()=>FACTS,guard}),[JOB(1)]);
  assert.deepEqual(await readFile(join(a.directory,'job.json')),a.journal);assert.deepEqual(await readFile(join(b.directory,'job.json')),b.journal);
  const parsed=parseLedger(await readFile(join(f.root,LEDGER_FILE)));assert.ok(parsed.ok);assert.equal(parsed.ledger.entries[0]?.manifestAvailable,false);
  store.close();const restarted=await f.open(),scan=await restarted.scan();
  assert.equal(scan.degraded,false);assert.deepEqual(scan.active.map(j=>j.jobId),[JOB(2)]);assert.equal(scan.archived[0]?.status,'archived');
  const found=await restarted.read(JOB(1));assert.equal(found.status,'archived');assert.deepEqual(found.journal,a.journal);
});

test('startup checkpoint opens no archived journal or artifact bytes',async t=>{
  const f=await fixture(t);await f.job(1);const first=await f.open();await first.archive({jobIds:[JOB(1)],activeCount:1,facts:async()=>FACTS,guard});first.close();
  const original=fs.open,opened:string[]=[];
  t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{opened.push(String(args[0]));return original(...args);});syncBuiltinESMExports();
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  const restarted=await f.open();assert.equal((await restarted.scan()).degraded,false);
  assert.ok(opened.some(path=>path.endsWith(LEDGER_FILE)));assert.equal(opened.some(path=>path.endsWith('job.json')),false);
  assert.equal(opened.some(path=>/\.(?:glb|blend|png|fbx)$/.test(path)),false);
  await restarted.read(JOB(1));assert.equal(opened.some(path=>path.endsWith('job.json')),true,'lookup performs full byte validation');
});

test('a changed archived journal retains its identity, reports drift and blocks admission',async t=>{
  const f=await fixture(t),a=await f.job(1);await f.job(2);const store=await f.open();
  await store.archive({jobIds:[JOB(1)],activeCount:2,facts:async()=>FACTS,guard});
  await writeFile(join(a.directory,'job.json'),a.journal.toString()+' ');
  const scan=await store.scan();assert.equal(scan.degraded,true);assert.equal(scan.archived[0]?.status,'changed');
  assert.equal((await store.read(JOB(1))).status,'changed');assert.equal(store.isArchived(JOB(1)),true);
  await assert.rejects(store.archive({jobIds:[JOB(2)],activeCount:1,facts:async()=>FACTS,guard}),code('DEGRADED'));
  await writeFile(join(a.directory,'job.json'),JSON.stringify({...JSON.parse(a.journal.toString()),state:'running'}));
  assert.equal((await store.read(JOB(1))).status,'conflict');
});

test('missing evidence and a linked journal remain visible as refused retained identities',async t=>{
  const f=await fixture(t),a=await f.job(1);const store=await f.open();await store.archive({jobIds:[JOB(1)],activeCount:1,facts:async()=>FACTS,guard});
  await rename(join(a.directory,'job.json'),join(a.directory,'saved.json'));
  assert.equal((await store.scan()).archived[0]?.status,'missing');assert.equal((await store.read(JOB(1))).status,'missing');
  await link(join(a.directory,'saved.json'),join(a.directory,'job.json'));
  assert.equal((await store.scan()).archived[0]?.status,'conflict');assert.equal((await store.read(JOB(1))).status,'conflict');
});

test('corrupt and externally changed ledgers preserve exact bytes and refuse new classification',async t=>{
  const f=await fixture(t);await f.job(1);const corrupt=Buffer.from('{incomplete');await writeFile(join(f.root,LEDGER_FILE),corrupt);
  const store=await f.open(),scan=await store.scan();assert.equal(scan.degraded,true);assert.deepEqual(scan.reasons,['ledger-invalid']);
  assert.equal(scan.active.length,1);await assert.rejects(store.archive({jobIds:[JOB(1)],activeCount:1,facts:async()=>FACTS,guard}),code('DEGRADED'));
  assert.deepEqual(await readFile(join(f.root,LEDGER_FILE)),corrupt);
  const g=await fixture(t);await g.job(1);const changed=await g.open();await writeFile(join(g.root,LEDGER_FILE),'{}');
  assert.ok((await changed.scan()).reasons.includes('ledger-changed'));
  assert.equal(await readFile(join(g.root,LEDGER_FILE),'utf8'),'{}');
});

test('active capacity stays at 256; overflow has explicit unclassified summaries and never changes files',async t=>{
  const f=await fixture(t);for(let n=1;n<=257;n++)await f.job(n);
  const store=await f.open(),scan=await store.scan();assert.equal(scan.active.length,256);assert.equal(scan.unclassified.length,1);
  assert.equal(scan.degraded,true);assert.ok(scan.reasons.includes('active-limit'));
  await assert.rejects(readFile(join(f.root,LEDGER_FILE)),{code:'ENOENT'});
});

test('read leases, host preparation/stage pins and uncertain facts prevent archival',async t=>{
  const f=await fixture(t);await f.job(1);const store=await f.open(),release=store.pin([JOB(1)]);
  await assert.rejects(store.archive({jobIds:[JOB(1)],activeCount:1,facts:async()=>FACTS,guard}),code('LEASED'));
  release();release();
  for(const key of ['active','readPinned','importCaptured','preparationRecord','pendingStage','uncertainLatch'] as const){
    await assert.rejects(store.archive({jobIds:[JOB(1)],activeCount:1,facts:async()=>({...FACTS,[key]:true}),guard}),code('INELIGIBLE'),key);
  }
  await assert.rejects(readFile(join(f.root,LEDGER_FILE)),{code:'ENOENT'});
});

test('a lease or journal change appearing during the final host check prevents a write',async t=>{
  for(const mode of ['lease','journal'] as const){
    const f=await fixture(t),job=await f.job(1);let calls=0,release=()=>{};const store=await f.open();
    await assert.rejects(store.archive({jobIds:[JOB(1)],activeCount:1,guard,facts:async()=>{
      if(++calls===2){if(mode==='lease')release=store.pin([JOB(1)]);else await writeFile(join(job.directory,'job.json'),job.journal.toString()+' ');}
      return FACTS;
    }}),code(mode==='lease'?'LEASED':'CHANGED'));release();
    await assert.rejects(readFile(join(f.root,LEDGER_FILE)),{code:'ENOENT'});
  }
});

test('synchronous retirement after an awaited host fact prevents persistence',async t=>{
  const f=await fixture(t);await f.job(1);const store=await f.open();let retired=false;
  await assert.rejects(store.archive({jobIds:[JOB(1)],activeCount:1,facts:async()=>{retired=true;return FACTS;},guard:()=>{if(retired)throw Error('retired');}}),/retired/);
  await assert.rejects(readFile(join(f.root,LEDGER_FILE)),{code:'ENOENT'});
});

test('reentrant host closure in the final guard cannot start the ledger writer',async t=>{
  let writes=0;
  const f=await fixture(t,async(directory,name,text)=>{writes++;await atomicAssetJson(directory,name,text);});
  await f.job(1);const store=await f.open();let guards=0;
  await assert.rejects(store.archive({jobIds:[JOB(1)],activeCount:1,facts:async()=>FACTS,guard:()=>{if(++guards===7)store.close();}}),code('CLOSED'));
  assert.equal(writes,0);await assert.rejects(readFile(join(f.root,LEDGER_FILE)),{code:'ENOENT'});
});

test('an uncertain committed write stays fenced; a known pre-replacement failure leaves the old classification',async t=>{
  const f=await fixture(t,async(directory,name,text)=>{await atomicAssetJson(directory,name,text);throw new AtomicJsonFailure('replace',{code:'EIO'});});
  const job=await f.job(1),store=await f.open();
  await assert.rejects(store.archive({jobIds:[JOB(1)],activeCount:1,facts:async()=>FACTS,guard}),code('UNCERTAIN'));
  assert.equal(store.isArchived(JOB(1)),true);assert.ok((await store.scan()).reasons.includes('commit-uncertain'));
  assert.deepEqual(await readFile(join(job.directory,'job.json')),job.journal);
  const committed=await readFile(join(f.root,LEDGER_FILE));await store.confirm(guard);
  assert.equal((await store.scan()).degraded,false);assert.deepEqual(await readFile(join(f.root,LEDGER_FILE)),committed,'inspection never rewrites a confirmed ledger');
  const g=await fixture(t,async()=>{throw new AtomicJsonFailure('write',{code:'ENOSPC'});});await g.job(1);const prior=await g.open();
  await assert.rejects(prior.archive({jobIds:[JOB(1)],activeCount:1,facts:async()=>FACTS,guard}),code('PERSISTENCE'));
  assert.equal(prior.isArchived(JOB(1)),false);assert.equal((await prior.scan()).degraded,false);
});

test('restore below capacity retains exact job bytes and read leases prevent classification changes',async t=>{
  const f=await fixture(t),a=await f.job(1);await f.job(2);const store=await f.open();
  await store.archive({jobIds:[JOB(1)],activeCount:2,facts:async()=>FACTS,guard});
  const release=store.pin([JOB(1)]);
  await assert.rejects(store.restore({jobId:JOB(1),activeCount:1,facts:async()=>FACTS,guard}),code('LEASED'));release();
  assert.deepEqual(await store.restore({jobId:JOB(1),activeCount:1,facts:async()=>FACTS,guard}),{jobId:JOB(1),swappedOut:null,activeAfter:2});
  const scan=await store.scan();assert.equal(scan.archived.length,0);assert.equal(scan.active.length,2);assert.equal(scan.degraded,false);
  assert.deepEqual(await readFile(join(a.directory,'job.json')),a.journal);
});

test('ineligible work and a retired caller cannot be used as restore swap authority',async t=>{
  const f=await fixture(t);await f.job(1);await f.job(2);const store=await f.open();
  await store.archive({jobIds:[JOB(1)],activeCount:2,facts:async()=>FACTS,guard});
  const bytes=await readFile(join(f.root,LEDGER_FILE));
  await assert.rejects(store.restore({jobId:JOB(1),activeCount:1,swapJobId:JOB(2),facts:async()=>({...FACTS,preparationRecord:true}),guard}),code('INELIGIBLE'));
  await assert.rejects(store.restore({jobId:JOB(1),activeCount:1,facts:async()=>FACTS,guard:()=>{throw Error('retired');}}),/retired/);
  assert.deepEqual(await readFile(join(f.root,LEDGER_FILE)),bytes);
});

test('actual locator opens 256 active plus 4096 archived jobs without archived journal or artifact reads',async t=>{
  const f=await fixture(t),entries:LedgerEntry[]=[];
  for(let start=1;start<=4352;start+=16)await Promise.all(Array.from({length:Math.min(16,4353-start)},async(_,offset)=>{
    const n=start+offset,job=await f.job(n);if(n<=4096)entries.push({jobId:JOB(n),name:'crate',template:'hero-prop',state:'failed',manifestAvailable:false,
      startedAt:AT,finishedAt:AT,archivedAt:AT,journalSha256:hash(job.journal),journal:fingerprintOf(await lstat(join(job.directory,'job.json'),{bigint:true})),resolutionMarkerSha256:null});
  }));
  await writeFile(join(f.root,LEDGER_FILE),JSON.stringify({schemaVersion:1,kind:'arcane-asset-archive',entries}));
  const original=fs.open;let journals=0;
  t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{if(String(args[0]).endsWith('job.json'))journals++;return original(...args);});syncBuiltinESMExports();
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  const started=performance.now(),store=await f.open(),scan=await store.scan();
  assert.equal(scan.degraded,false);assert.equal(scan.active.length,256);assert.equal(scan.archived.length,4096);assert.equal(journals,0);
  t.diagnostic(JSON.stringify({active:256,archived:4096,archivedJournalReads:journals,elapsedMs:Math.round(performance.now()-started),warmCache:true,nativeWorkers:false}));
  const swapped=await store.restore({jobId:JOB(1),activeCount:256,swapJobId:JOB(4097),facts:async()=>FACTS,guard});
  assert.deepEqual(swapped,{jobId:JOB(1),swappedOut:JOB(4097),activeAfter:256});
  assert.equal(store.isArchived(JOB(1)),false);assert.equal(store.isArchived(JOB(4097)),true);
  const committed=parseLedger(await readFile(join(f.root,LEDGER_FILE)));assert.ok(committed.ok);assert.equal(committed.ledger.entries.length,4096);
  store.close();const restarted=await f.open(),after=await restarted.scan();
  assert.equal(after.degraded,false);assert.equal(after.active.length,256);assert.equal(after.archived.length,4096);
  assert.equal(after.active.some(job=>job.jobId===JOB(1)),true);assert.equal(after.active.some(job=>job.jobId===JOB(4097)),false);
});
