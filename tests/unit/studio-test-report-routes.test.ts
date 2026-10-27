import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request as httpRequest,type IncomingMessage} from 'node:http';
import {join,relative,isAbsolute} from 'node:path';
import {existsSync,rmSync,writeFileSync,unlinkSync,linkSync} from 'node:fs';
import {createStudioTestHistoricalReport,openStudioTestReportStore,type StudioTestReportArchiveStatus,type StudioTestReportStore} from '../../apps/daemon/src/studio-test-report-store.js';
import {studioTestReportRoutes,type StudioTestReportRouteStore} from '../../apps/daemon/src/studio-test-report-routes.js';
import {createStudioTestCaptureStore,readStudioTestCapture} from '../../apps/daemon/src/studio-test-captures.js';
import {scenarioPng} from '../../packages/studio-test-controller/src/scenario-image.js';
import {SCENARIO_ACTIONS,type ScenarioCapture} from '../../packages/studio-test-controller/src/scenario.js';
import {digest} from '../../packages/studio-test-controller/src/contracts.js';
import {png} from '../../packages/asset-pipeline/testing/fixture.js';
import {makeFixtureDirectory,fixtureTempDirectory} from './windows-fixture-paths.js';

// Actual SQLite, HTTP and checked filesystem reads; all playtest reports are
// synthetic fixture observations, with no live ledger, provider or Studio calls.
const PROJECT='a'.repeat(64),HUMAN='synthetic-history-human-secret',AGENT='synthetic-history-agent-secret';
const uuid=(n:number)=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const JOB=uuid(1),RUN=uuid(100);
function report(jobId=JOB,terminal=false,image:ScenarioCapture|null=null,withScenario=false){
  const plan={version:1,runtimeBudgetMs:100,targets:[],steps:[{id:'distance',kind:'assert-displacement',minimumStuds:1}],capture:{required:true}};
  const display={proposal:{binding:{nativeStudioId:'fixture-native',pairedSessionId:'fixture-paired',clientLifetimeId:'fixture-lifetime',pluginArtifactHash:'b'.repeat(64),scopeRevision:'c'.repeat(64),placeId:0},durationMs:1000,observationIntervalMs:100,failOnRuntimeError:true,...(withScenario?{scenario:plan,subjectDigest:'d'.repeat(64)}:{})},
    cleanupGraceMs:1000,requestTimeoutMs:1000,proofMaxAgeMs:1000,consentExpiresAt:10000,guarantee:'observed-non-atomic',actions:withScenario?SCENARIO_ACTIONS:['start','observe-state-and-console','stop-owned-play'],raceDisclosure:'Observed checks cannot atomically fence the native call.'};
  return createStudioTestHistoricalReport({schemaVersion:1,kind:'studio-playtest-report',projectId:PROJECT,jobId,taskId:null,createdAt:'2026-10-28T00:00:00.000Z',observedAt:terminal?'2026-10-28T00:00:01.000Z':'2026-10-28T00:00:00.000Z',snapshot:terminal?'terminal':'admission',targetName:'Fixture disposable place',observedState:terminal?'complete':'needs_approval',display,displayDigest:digest(display),
    review:{runId:terminal?RUN:null,evidence:'fixture',nativeAcceptance:false,binding:terminal?display.proposal.binding:null,scopeDigest:terminal?digest(display):null,phase:terminal?'done':'idle',outcome:terminal?'failed':null,code:terminal?'ASSERTION_FAILED':'OK',cleanup:terminal?'unknown':'not_started',startedAt:terminal?1000:null,deadline:terminal?2000:null,cleanupDeadline:terminal?3000:null,watchdog:{armed:false,fired:false,reason:null},observations:terminal?1:0,logs:[],logsTruncated:false,requiresHumanReview:terminal,canStartAnotherOperation:false,
      ...(withScenario?{scenario:{scenarioDigest:digest(plan),subjectDigest:'d'.repeat(64),state:terminal?'failed':'not_started',inputRelease:'not_started',temporary:'not_started',steps:terminal?[{id:'distance',kind:'assert-displacement',outcome:'failed',expected:1,observed:0}]:[],capture:image,consoleCoverage:'ambiguous'}}:{})},evidence:'fixture',nativeAcceptance:false});
}
function gate(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return{promise,release};}
async function fixture(t:TestContext,options:{capture?:boolean;extra?:number}={}){
  const root=makeFixtureDirectory('arcane-report-http-');let store:StudioTestReportStore|undefined;
  let project=PROJECT,epoch=0,daemon=true,humanToken=HUMAN,origin='',captureReads=0,statusOverride:StudioTestReportArchiveStatus|undefined,held:ReturnType<typeof gate>|undefined,entered:ReturnType<typeof gate>|undefined;
  const captureStore=await createStudioTestCaptureStore(root),image=options.capture?await captureStore.save(RUN,png(),scenarioPng(png())):null;
  store=await openStudioTestReportStore({directory:join(root,'reports'),projectId:PROJECT,exclusiveWriter:()=>true});
  assert.deepEqual(store.recordAdmission(report(JOB,false,null,!!options.capture),[]),{stored:true});
  if(options.capture)assert.deepEqual(store.recordTerminal(report(JOB,true,image,true)),{stored:true});
  for(let i=0;i<(options.extra??0);i++)assert.deepEqual(store.recordAdmission(report(uuid(i+2)),[]),{stored:true});
  store.close();store=await openStudioTestReportStore({directory:join(root,'reports'),projectId:PROJECT,exclusiveWriter:()=>true});
  const actual=store;
  const actor=(request:IncomingMessage)=>request.headers.authorization==='Bearer '+humanToken?{kind:'human' as const,id:'human'}:request.headers.authorization==='Bearer '+AGENT?{kind:'agent' as const,id:'agent-fixture'}:null;
  const captureScope=()=>{const capturedEpoch=epoch,capturedProject=project;return{projectId:capturedProject,assertCurrent(){if(!daemon||epoch!==capturedEpoch||project!==capturedProject)throw Error('original host context changed');}};};
  const reader:StudioTestReportRouteStore={projectId:actual.projectId,status:()=>actual.status(),list:(input,guard)=>actual.list(input,guard),get:(id,guard)=>actual.get(id,guard),captureDescriptor:(id,guard)=>actual.captureDescriptor(id,guard)};
  const route=studioTestReportRoutes(reader,actor,{captureScope,archiveStatus:()=>statusOverride??actual.status(),readCapture:async(descriptor,guard)=>{captureReads++;entered?.release();if(held)await held.promise;guard();return readStudioTestCapture(root,descriptor,guard);}});
  const server=createServer((request,response)=>{void route(request,response,new URL(request.url??'/',origin),origin).then(done=>{if(!done){response.writeHead(404);response.end();}}).catch(()=>response.destroy());});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address==='object');origin='http://127.0.0.1:'+address.port;
  t.after(async()=>{held?.release();server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));store?.close();const tail=relative(fixtureTempDirectory(),root);assert.ok(!isAbsolute(tail)&&!tail.startsWith('..')&&tail.startsWith('arcane-report-http-'));rmSync(root,{recursive:true,force:true});});
  const call=(path:string,options:{token?:string|null;method?:string;headers?:Record<string,string>}={})=>new Promise<{status:number;bytes:Buffer;headers:IncomingMessage['headers']}>((resolve,reject)=>{
    const token=options.token===undefined?HUMAN:options.token;const request=httpRequest(origin+path,{method:options.method??'GET',agent:false,headers:{...(token?{Authorization:'Bearer '+token}:{}),...options.headers}},response=>{const chunks:Buffer[]=[];response.on('data',chunk=>chunks.push(Buffer.from(chunk)));response.once('error',reject);response.once('end',()=>resolve({status:response.statusCode!,bytes:Buffer.concat(chunks),headers:response.headers}));});request.once('error',reject);request.end();});
  return{root,image,actual,call,origin,get captureReads(){return captureReads;},setStatus(value:StudioTestReportArchiveStatus){statusOverride=value;},hold(){held=gate();entered=gate();return{entered:entered.promise,release:held.release};},switchAwayBack(){project='e'.repeat(64);epoch++;project=PROJECT;epoch++;},closeDaemon(){daemon=false;epoch++;},rotateHuman(){humanToken='rotated-human';}};
}

test('actual reopened report archive is human-readable over HTTP without opening live safety state',async t=>{
  const f=await fixture(t,{extra:9});assert.equal(existsSync(join(f.root,'ledger')),false);
  const first=await f.call('/v1/playtests/history');assert.equal(first.status,200);const page=JSON.parse(first.bytes.toString());assert.equal(page.projectId,PROJECT);assert.equal(page.reports.length,8);assert.equal(page.reports[0].outcome,null);assert.ok(page.nextCursor);assert.equal(first.headers['cache-control'],'no-store');
  const second=await f.call('/v1/playtests/history?cursor='+encodeURIComponent(page.nextCursor));assert.equal(second.status,200);const next=JSON.parse(second.bytes.toString());assert.equal(next.reports.length,2);assert.equal(next.nextCursor,null);assert.equal(new Set([...page.reports,...next.reports].map((row:{jobId:string})=>row.jobId)).size,10);
  const one=await f.call('/v1/playtests/history/report?id='+JOB);assert.equal(one.status,200);const envelope=JSON.parse(one.bytes.toString());assert.equal(envelope.report.snapshot,'admission');assert.equal(envelope.report.review.outcome,null);assert.equal(envelope.receiptScope,'historical-playtest');assert.equal(envelope.currentSource,'unobserved');assert.equal(envelope.readOnly,true);assert.equal('actor'in envelope.report,false);assert.equal('consentId'in envelope,false);assert.equal(f.captureReads,0);assert.equal((await f.call('/v1/playtests/history/capture?id='+JOB)).status,404);assert.equal(f.captureReads,0);
});

test('historical reads refuse agent credentials methods foreign Origin and caller-controlled metadata',async t=>{
  const f=await fixture(t);
  assert.equal((await f.call('/v1/playtests/history',{token:AGENT})).status,403);assert.equal((await f.call('/v1/playtests/history',{token:null})).status,401);
  assert.equal((await f.call('/v1/playtests/history',{method:'POST'})).status,405);assert.equal((await f.call('/v1/playtests/history',{headers:{Origin:'http://evil.invalid'}})).status,403);assert.equal((await f.call('/v1/playtests/history',{headers:{Host:'evil.invalid'}})).status,403);
  for(const path of ['/v1/playtests/history?projectId='+PROJECT,'/v1/playtests/history?cursor=one&cursor=two','/v1/playtests/history/report?id='+JOB+'&actor=human','/v1/playtests/history/capture?id='+JOB+'&path=../image.png','/v1/playtests/history/report?id='+encodeURIComponent('../ledger'),'/v1/playtests/history/report','/v1/playtests/history?cursor=','/v1/playtests/history?cursor='+encodeURIComponent('1.'+'f'.repeat(64)+'.1')])assert.equal((await f.call(path)).status,400,path);
  assert.equal((await f.call('/v1/playtests/history/report?id='+uuid(999))).status,404);assert.equal(f.captureReads,0);
});

test('checked historical PNG is retained separately and failed cleanup stays unknown',async t=>{
  const f=await fixture(t,{capture:true}),one=await f.call('/v1/playtests/history/report?id='+JOB);assert.equal(one.status,200);const body=JSON.parse(one.bytes.toString());assert.equal(body.report.review.cleanup,'unknown');assert.equal(body.report.review.outcome,'failed');assert.equal(body.report.nativeAcceptance,false);
  const image=await f.call('/v1/playtests/history/capture?id='+JOB);assert.equal(image.status,200);assert.equal(image.headers['content-type'],'image/png');assert.deepEqual(image.bytes,png());assert.equal(f.captureReads,1);
  writeFileSync(join(f.root,'captures',RUN+'.png'),png(true));const corrupt=await f.call('/v1/playtests/history/capture?id='+JOB);assert.equal(corrupt.status,404);assert.equal(JSON.parse(corrupt.bytes.toString()).error,'CAPTURE_UNAVAILABLE');assert.ok(!corrupt.bytes.includes(Buffer.from(f.root)));
});

for(const transition of ['project-away-back','daemon-close','human-rotation'] as const)test('pending image read denies original context after '+transition,async t=>{
  const f=await fixture(t,{capture:true}),hold=f.hold(),pending=f.call('/v1/playtests/history/capture?id='+JOB);await hold.entered;
  if(transition==='project-away-back')f.switchAwayBack();else if(transition==='daemon-close')f.closeDaemon();else f.rotateHuman();hold.release();
  const response=await pending;assert.equal(response.status,403);assert.notEqual(response.headers['content-type'],'image/png');assert.ok(!response.bytes.includes(Buffer.from(HUMAN)));
});

test('archive fault status is descriptive and independent of live service availability',async t=>{
  const f=await fixture(t);f.setStatus({state:'degraded',code:'ARCHIVE_WRITE'});const page=await f.call('/v1/playtests/history');assert.equal(page.status,200);assert.deepEqual(JSON.parse(page.bytes.toString()).archive,{state:'degraded',code:'ARCHIVE_WRITE'});assert.equal(f.captureReads,0);
});

test('factored historical capture reader checks original file links hash and original guard without live store',async t=>{
  const f=await fixture(t,{capture:true});assert.ok(f.image);assert.deepEqual(await readStudioTestCapture(f.root,f.image),png());
  let calls=0;await assert.rejects(readStudioTestCapture(f.root,f.image,()=>{if(++calls===3)throw Error('changed');}),/changed/);
  const original=join(f.root,'captures',RUN+'.png'),alias=join(f.root,'capture-alias.png');linkSync(original,alias);await assert.rejects(readStudioTestCapture(f.root,f.image),/identity/);unlinkSync(alias);
  writeFileSync(original,png(true));await assert.rejects(readStudioTestCapture(f.root,f.image),/changed/);
});


test('historical image deadline refuses late bytes without restarting or reopening native work',async t=>{
  const f=await fixture(t,{capture:true});t.mock.timers.enable({apis:['setTimeout']});
  const hold=f.hold(),pending=f.call('/v1/playtests/history/capture?id='+JOB);await hold.entered;
  t.mock.timers.tick(8000);const response=await pending;assert.equal(response.status,504);assert.equal(JSON.parse(response.bytes.toString()).error,'TIMEOUT');
  hold.release();await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(f.captureReads,1);assert.notEqual(response.headers['content-type'],'image/png');
  t.mock.timers.reset();
});
