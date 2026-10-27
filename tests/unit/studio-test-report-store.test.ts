import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, link, unlink, realpath } from 'node:fs/promises';
import { join,dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { digest } from '../../packages/studio-test-controller/src/contracts.js';
import { openStudioTestReportStore as openRetainedStore,createStudioTestHistoricalReport,parseStudioTestHistoricalReport,parseStudioTestReportCursor,
  STUDIO_TEST_REPORT_LIMITS,type StudioTestHistoricalReport,type StudioTestReportStore } from '../../apps/daemon/src/studio-test-report-store.js';

// Constructed metadata tests; this factory does not establish native execution or screenshot provenance.
const PROJECT='a'.repeat(64),OTHER='b'.repeat(64),H='c'.repeat(64),TASK='33333333-3333-4333-8333-333333333333';
const id=(n:number)=>'11111111-1111-4111-8111-'+n.toString(16).padStart(12,'0');
function snapshot(n=1,terminal=false,taskId:string|null=null):StudioTestHistoricalReport {
  const display={proposal:{binding:{nativeStudioId:'studio-fixture',pairedSessionId:'paired-fixture',clientLifetimeId:'life-fixture',pluginArtifactHash:H,scopeRevision:H,placeId:0 as const},
    durationMs:5000,observationIntervalMs:1000,failOnRuntimeError:true},cleanupGraceMs:15000,requestTimeoutMs:15000,proofMaxAgeMs:6000,consentExpiresAt:60000,
    guarantee:'observed-non-atomic' as const,actions:['start','observe-state-and-console','stop-owned-play'] as const,raceDisclosure:'Observed checks cannot atomically fence the native call.' as const};
  return createStudioTestHistoricalReport({schemaVersion:1,kind:'studio-playtest-report',projectId:PROJECT,jobId:id(n),taskId,
    createdAt:'2026-10-27T00:00:00.000Z',observedAt:terminal?'2026-10-27T00:00:06.000Z':'2026-10-27T00:00:00.000Z',snapshot:terminal?'terminal':'admission',
    targetName:'Controlled report fixture',observedState:terminal?'complete':'needs_approval',display,displayDigest:digest(display),evidence:'fixture',nativeAcceptance:false,
    review:{runId:terminal?id(n+1000):null,evidence:'fixture',nativeAcceptance:false,binding:terminal?display.proposal.binding:null,scopeDigest:terminal?digest(display):null,
      phase:terminal?'done':'idle',outcome:terminal?'succeeded':null,code:'OK',cleanup:terminal?'complete':'not_started',startedAt:terminal?0:null,deadline:terminal?5000:null,cleanupDeadline:terminal?20000:null,
      watchdog:{armed:false,fired:false,reason:null},observations:terminal?5:0,logs:[],logsTruncated:false,requiresHumanReview:false,canStartAnotherOperation:terminal}});
}
const owned=new Map<string,Set<StudioTestReportStore>>();
async function openStudioTestReportStore(options:Parameters<typeof openRetainedStore>[0]){const store=await openRetainedStore(options);
  let stores=owned.get(options.directory);if(!stores){stores=new Set();owned.set(options.directory,stores);}stores.add(store);return store;}
async function directory(t:TestContext){const root=await realpath(await mkdtemp(join(tmpdir(),'arcane-report-store-'))),dir=join(root,'reports');
  t.after(async()=>{try{for(const store of owned.get(dir)??[])store.close();}finally{owned.delete(dir);await rm(root,{recursive:true,force:true});}});return dir;}
const guard=()=>{};
/** Seed historical metadata in the actual store-created schema in one transaction.
 * Boundary tests then exercise the real admission/retention transaction once,
 * rather than hundreds of redundant full-history validations/fsyncs. No native proof is seeded. */
async function retained(t:TestContext,taskId:string|null){
  const dir=await directory(t),empty=await openStudioTestReportStore({directory:dir,projectId:PROJECT,exclusiveWriter:()=>true});empty.close();
  const db=new DatabaseSync(join(dir,'reports.sqlite'));
  try{db.exec('BEGIN IMMEDIATE');for(let n=1;n<=256;n++){const r=snapshot(n,taskId!==null,taskId);db.prepare('INSERT INTO report_records VALUES(?,?,?,?,?)').run(r.jobId,n,r.taskId,r.historicalDigest,JSON.stringify(r));}
    db.prepare('UPDATE report_meta SET next_sequence=257 WHERE id=1').run();db.exec('COMMIT');}finally{db.close();}
  return {dir,store:await openStudioTestReportStore({directory:dir,projectId:PROJECT,exclusiveWriter:()=>true})};
}
function reseal(value:StudioTestHistoricalReport,patch:Record<string,unknown>):StudioTestHistoricalReport {
  const {historicalDigest:_,...content}=value;return createStudioTestHistoricalReport({...content,...patch});
}

test('strict detached historical snapshots contain no actor and reject unsafe descriptors before execution',()=>{
  const original=snapshot(),copy=structuredClone(original);assert.deepEqual(parseStudioTestHistoricalReport(copy),original);assert.ok(Object.isFrozen(parseStudioTestHistoricalReport(copy).display));
  assert.ok(!Object.hasOwn(original,'actor'));let calls=0;
  const getter={...copy};Object.defineProperty(getter,'targetName',{enumerable:true,get(){calls++;throw new Error('getter must not run');}});
  for(const value of [getter,new Proxy(copy,{get(){calls++;throw new Error('proxy must not run');}}),Object.assign(Object.create({}),copy)])assert.throws(()=>parseStudioTestHistoricalReport(value),{code:'ARCHIVE_INPUT'});
  assert.equal(calls,0);Object.defineProperty(copy,'hidden',{value:true});assert.throws(()=>parseStudioTestHistoricalReport(copy),{code:'ARCHIVE_INPUT'});
  assert.throws(()=>parseStudioTestHistoricalReport({...original,actor:'must-not-retain-bearer-derived-id'}),{code:'ARCHIVE_INPUT'});
  assert.throws(()=>parseStudioTestHistoricalReport({...original,historicalDigest:'d'.repeat(64)}),{code:'ARCHIVE_INPUT'});
});

test('actual SQLite admission and immutable terminal report survive reopen without native ports',async t=>{
  const dir=await directory(t),store=await openStudioTestReportStore({directory:dir,projectId:PROJECT,exclusiveWriter:()=>true});
  const admitted=snapshot(),done=snapshot(1,true);assert.deepEqual(store.recordAdmission(admitted,[admitted.jobId]),{stored:true});
  assert.deepEqual(store.recordAdmission(reseal(admitted,{projectId:OTHER}),[]),{stored:false,code:'ARCHIVE_INPUT'});assert.deepEqual(store.get(admitted.jobId,guard),admitted);
  assert.equal(store.get(admitted.jobId,guard)?.snapshot,'admission');assert.deepEqual(store.recordTerminal(done),{stored:true});assert.deepEqual(store.recordTerminal(done),{stored:true});
  assert.deepEqual(store.recordTerminal(reseal(done,{observedAt:'2026-10-27T00:00:07.000Z'})),{stored:false,code:'ARCHIVE_CONFLICT'});
  assert.deepEqual(store.get(done.jobId,guard),done);store.close();store.close();
  const reopened=await openStudioTestReportStore({directory:dir,projectId:PROJECT,exclusiveWriter:()=>true});t.after(()=>reopened.close());
  assert.deepEqual(reopened.get(done.jobId,guard),done);assert.equal(reopened.get(id(999),guard),null);assert.equal(reopened.captureDescriptor(done.jobId,guard),null);
  assert.equal(Object.getOwnPropertyDescriptor(reopened,'projectId')?.writable,false);
});

test('metadata history retains the 65th job and pages by exact project and retained anchor',async t=>{
  const store=await openStudioTestReportStore({directory:await directory(t),projectId:PROJECT,exclusiveWriter:()=>true});t.after(()=>store.close());
  for(let n=1;n<=65;n++)assert.deepEqual(store.recordAdmission(snapshot(n),[id(n)]),{stored:true});
  assert.equal(store.get(id(1),guard)?.jobId,id(1));const page=store.list({cursor:null},guard);assert.equal(page.reports.length,8);assert.equal(page.reports[0]?.jobId,id(65));assert.equal(page.omittedReports,0);
  const cursor=page.nextCursor;assert.ok(cursor);assert.equal(store.list({cursor},guard).reports[0]?.jobId,id(57));
  assert.throws(()=>store.list({cursor:cursor.replace(PROJECT,OTHER)},guard),{code:'CURSOR_INVALID'});
  assert.throws(()=>parseStudioTestReportCursor(`1.${PROJECT}.9007199254740992`,PROJECT),{code:'CURSOR_INVALID'});
  assert.throws(()=>store.list({cursor:null,projectId:OTHER},guard),{code:'CURSOR_INVALID'});
  let checks=0;assert.throws(()=>store.get(id(1),()=>{if(++checks===2)throw new Error('original epoch retired');}),/original epoch retired/);assert.equal(checks,2);assert.deepEqual(store.status(),{state:'ready',code:null});
});

test('bounded retention prunes only unprotected non-task metadata and reports a stale cursor explicitly',async t=>{
  const {store}=await retained(t,null);t.after(()=>store.close());
  assert.deepEqual(store.recordAdmission(snapshot(257),[id(1),id(257)]),{stored:true});assert.ok(store.get(id(1),guard));assert.equal(store.get(id(2),guard),null);
  const page=store.list({cursor:null},guard);assert.equal(page.omittedReports,1);assert.equal(page.reports[0]?.jobId,id(257));
  assert.throws(()=>store.list({cursor:`1.${PROJECT}.2`},guard),{code:'CURSOR_INVALID'});
  assert.deepEqual(store.recordTerminal(snapshot(258,true)),{stored:true});assert.ok(store.get(id(1),guard),'late terminal insert respects the current admission pin set');
});

test('genuine task metadata pins survive terminal labels, reopen and all-pinned capacity',async t=>{
  const {dir,store}=await retained(t,TASK);store.close();
  const reopened=await openStudioTestReportStore({directory:dir,projectId:PROJECT,exclusiveWriter:()=>true});t.after(()=>reopened.close());
  assert.deepEqual(reopened.recordAdmission(snapshot(257),[id(257)]),{stored:false,code:'ARCHIVE_LIMIT'});
  assert.ok(reopened.get(id(1),guard));assert.ok(reopened.get(id(256),guard));assert.equal(reopened.get(id(257),guard),null);
  assert.deepEqual(reopened.status(),{state:'degraded',code:'ARCHIVE_LIMIT'});assert.equal(reopened.list({cursor:null},guard).omittedReports,0);
});

test('wrong project/schema and malformed retained JSON refuse without schema repair or byte changes',async t=>{
  for(const mode of ['project','schema','hidden-schema','duplicate','digest']as const)await t.test(mode,async sub=>{
    const dir=await directory(sub),store=await openStudioTestReportStore({directory:dir,projectId:PROJECT,exclusiveWriter:()=>true});assert.deepEqual(store.recordAdmission(snapshot(),[]),{stored:true});store.close();
    const path=join(dir,'reports.sqlite');
    if(mode!=='project'){const db=new DatabaseSync(path);try{
      if(mode==='schema')db.exec('PRAGMA user_version=2');
      else if(mode==='hidden-schema')db.exec('CREATE TABLE sqlitex_extra(value TEXT) STRICT');
      else if(mode==='duplicate'){const row=db.prepare('SELECT payload FROM report_records').get();assert.equal(typeof row?.payload,'string');
        db.prepare('UPDATE report_records SET payload=?').run(String(row?.payload).replace('{','{"schemaVersion":1,'));}
      else db.prepare('UPDATE report_records SET historical_digest=?').run('d'.repeat(64));
    }finally{db.close();}}
    const before=await readFile(path);await assert.rejects(openStudioTestReportStore({directory:dir,projectId:mode==='project'?OTHER:PROJECT,exclusiveWriter:()=>true}),{code:'ARCHIVE_UNAVAILABLE'});assert.deepEqual(await readFile(path),before);
  });
});

test('failed SQLite transaction leaves the prior snapshot exact and reports archive degradation',async t=>{
  const dir=await directory(t),store=await openStudioTestReportStore({directory:dir,projectId:PROJECT,exclusiveWriter:()=>true});t.after(()=>store.close());
  const admitted=snapshot();assert.deepEqual(store.recordAdmission(admitted,[]),{stored:true});
  const held=new DatabaseSync(join(dir,'reports.sqlite'));try{held.exec('BEGIN IMMEDIATE');assert.deepEqual(store.recordTerminal(snapshot(1,true)),{stored:false,code:'ARCHIVE_WRITE'});}finally{held.exec('ROLLBACK');held.close();}
  assert.deepEqual(store.get(admitted.jobId,guard),admitted);assert.deepEqual(store.status(),{state:'degraded',code:'ARCHIVE_WRITE'});
});

test('hardlinked database and interrupted journal are retained refusals, not cleanup/recovery authority',async t=>{
  const dir=await directory(t),store=await openStudioTestReportStore({directory:dir,projectId:PROJECT,exclusiveWriter:()=>true});store.close();
  const path=join(dir,'reports.sqlite'),alias=join(dirname(dir),'reports-copy');await link(path,alias);
  await assert.rejects(openStudioTestReportStore({directory:dir,projectId:PROJECT,exclusiveWriter:()=>true}));await unlink(alias);
  await writeFile(join(dir,'reports.sqlite-journal'),Buffer.from('interrupted ordinary journal fixture'));
  const before=await readFile(path);await assert.rejects(openStudioTestReportStore({directory:dir,projectId:PROJECT,exclusiveWriter:()=>true}),{code:'ARCHIVE_UNAVAILABLE'});assert.deepEqual(await readFile(path),before);
});

test('retained report/domain bounds never promote foreign evidence or source/capture context',()=>{
  const report=snapshot(1,true),{historicalDigest:_,...content}=report;
  for(const patch of [{projectId:OTHER,displayDigest:'d'.repeat(64)},{evidence:'native'},{nativeAcceptance:true},
    {review:{...report.review,binding:null,scopeDigest:null}},{review:{...report.review,deadline:6000}},
    {review:{...report.review,cleanup:'unknown',canStartAnotherOperation:true}},{targetName:'x'.repeat(STUDIO_TEST_REPORT_LIMITS.reportBytes)}])
    assert.throws(()=>createStudioTestHistoricalReport({...content,...patch}));
});

test('historical observation counts mirror the actual admitted controller sampling budget',()=>{
  const measured=(durationMs:number,observationIntervalMs:number,observations:number,terminal=true)=>{
    const report=snapshot(1,terminal),{historicalDigest:_,...content}=report;
    const display={...report.display,proposal:{...report.display.proposal,durationMs,observationIntervalMs}};
    return createStudioTestHistoricalReport({...content,display,displayDigest:digest(display),review:{...report.review,observations,
      scopeDigest:terminal?digest(display):null,deadline:terminal?durationMs:null,cleanupDeadline:terminal?durationMs+display.cleanupGraceMs:null}});
  };
  const maximum=measured(32000,250,128);assert.equal(maximum.review.observations,128);assert.deepEqual(parseStudioTestHistoricalReport(maximum),maximum);
  assert.throws(()=>measured(32000,250,129),{code:'ARCHIVE_INPUT'});
  assert.throws(()=>measured(5000,1000,6),{code:'ARCHIVE_INPUT'});
  assert.throws(()=>measured(5000,6000,0),{code:'ARCHIVE_INPUT'});
  assert.throws(()=>measured(5000,1000,1,false),{code:'ARCHIVE_INPUT'});
  for(const interval of [250,25]){
    // Both the over-budget count and a smaller count under an unadmitted proposal refuse.
    assert.throws(()=>measured(60000,interval,Math.ceil(60000/interval)),{code:'ARCHIVE_INPUT'});
    assert.throws(()=>measured(60000,interval,128),{code:'ARCHIVE_INPUT'});
  }
});
