/// <reference lib="dom" />
import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {startPlaytestPanel} from '../../apps/desktop/src/playtest-panel.js';
import {createStudioTestHistoricalReport,type StudioTestHistoricalReport,type StudioTestReportSummary} from '../../apps/daemon/src/studio-test-report-store.js';
import {digest} from '../../packages/studio-test-controller/src/contracts.js';
import {SCENARIO_ACTIONS} from '../../packages/studio-test-controller/src/scenario.js';

// Actual report factory and browser panel; the DOM/HTTP/capture are offline doubles.
// No controller, bearer-derived actor, permission or native evidence is reconstructed.
const PROJECT='a'.repeat(64),OTHER='b'.repeat(64),HASH='c'.repeat(64),TOKEN='original-human-control-token',NOW=2_000_000_000_000;
const id=(n:number)=>'11111111-1111-4111-8111-'+n.toString(16).padStart(12,'0');
const PNG=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5l8AAAAASUVORK5CYII=','base64'));
function report(n=1,admission=false,capture=false):StudioTestHistoricalReport {
  const plan={version:1,runtimeBudgetMs:500,targets:[],steps:[{id:'move',kind:'hold-key',key:'W',holdMs:100},{id:'distance',kind:'assert-displacement',minimumStuds:2}],capture:{required:capture}};
  const display={proposal:{binding:{nativeStudioId:'historical-native',pairedSessionId:'historical-paired',clientLifetimeId:'original-life',pluginArtifactHash:HASH,scopeRevision:HASH,placeId:0},
    durationMs:5000,observationIntervalMs:1000,failOnRuntimeError:true,scenario:plan,subjectDigest:HASH},cleanupGraceMs:15000,requestTimeoutMs:15000,proofMaxAgeMs:6000,consentExpiresAt:NOW-1000,
    guarantee:'observed-non-atomic',actions:SCENARIO_ACTIONS,raceDisclosure:'Observed checks cannot atomically fence the native call.'};
  return createStudioTestHistoricalReport({schemaVersion:1,kind:'studio-playtest-report',projectId:PROJECT,jobId:id(n),taskId:null,createdAt:'2026-10-27T00:00:00.000Z',observedAt:admission?'2026-10-27T00:00:00.000Z':'2026-10-27T00:00:06.000Z',
    snapshot:admission?'admission':'terminal',targetName:'Saved garden '+n,observedState:admission?'needs_approval':'complete',display,displayDigest:digest(display),evidence:'fixture',nativeAcceptance:false,
    review:{runId:admission?null:'run-'+n,evidence:'fixture',nativeAcceptance:false,binding:admission?null:display.proposal.binding,scopeDigest:admission?null:digest(display),phase:admission?'idle':'done',outcome:admission?null:'failed',code:admission?'OK':'ASSERTION_FAILED',
      cleanup:admission?'not_started':'complete',startedAt:admission?null:0,deadline:admission?null:5000,cleanupDeadline:admission?null:20000,watchdog:{armed:false,fired:false,reason:null},observations:admission?0:2,
      logs:admission?[]:[{idDigest:HASH,digest:HASH,level:'warning',bytes:24}],logsTruncated:false,requiresHumanReview:false,canStartAnotherOperation:!admission,
      scenario:{scenarioDigest:digest(plan),subjectDigest:HASH,state:admission?'not_started':'failed',inputRelease:admission?'not_started':'observed_released',temporary:admission?'not_started':'restored',consoleCoverage:'ambiguous',
        steps:admission?[]:[{id:'move',kind:'hold-key',outcome:'passed',expected:'W:100',observed:'observed-released'},{id:'distance',kind:'assert-displacement',outcome:'failed',expected:2,observed:0.25}],
        capture:capture?{id:'run-'+n,sha256:createHash('sha256').update(PNG).digest('hex'),bytes:PNG.length,mimeType:'image/png',width:1,height:1,context:'unattested',nativeAcceptance:false}:null}}});
}
function summary(r:StudioTestHistoricalReport):StudioTestReportSummary {
  return{jobId:r.jobId,taskId:r.taskId,createdAt:r.createdAt,observedAt:r.observedAt,snapshot:r.snapshot,targetName:r.targetName,observedState:r.observedState,outcome:r.review.outcome,code:r.review.code,cleanup:r.review.cleanup,evidence:r.evidence,nativeAcceptance:false,historicalDigest:r.historicalDigest};
}
const envelope=(r:StudioTestHistoricalReport)=>({schemaVersion:1,projectId:PROJECT,archive:{state:'ready',code:null},report:r,receiptScope:'historical-playtest',currentSource:'unobserved',readOnly:true});
class Events {
  private listeners=new Map<string,EventListener[]>();
  addEventListener(type:string,listener:EventListener):void{this.listeners.set(type,[...this.listeners.get(type)??[],listener]);}
  removeEventListener(type:string,listener:EventListener):void{this.listeners.set(type,(this.listeners.get(type)??[]).filter(value=>value!==listener));}
  emit(type:string,trusted=false):void{for(const listener of [...this.listeners.get(type)??[]])listener({type,isTrusted:trusted,preventDefault(){}} as unknown as Event);}
}
class ElementFixture extends Events {
  children:ElementFixture[]=[];parentElement:ElementFixture|null=null;hidden=false;disabled=false;open=false;tabIndex=0;className='';type='';src='';alt='';style={maxWidth:''};
  private content='';private attributes=new Map<string,string>();
  constructor(readonly tagName:string,readonly ownerDocument:DocumentFixture){super();}
  get textContent():string{return this.content+this.children.map(child=>child.textContent).join('');}
  set textContent(value:string){this.replaceChildren();this.content=value;}
  get innerHTML():never{throw Error('No HTML sinks');}set innerHTML(_value:string){throw Error('No HTML sinks');}
  append(...values:ElementFixture[]):void{for(const value of values){value.parentElement=this;this.children.push(value);}}
  replaceChildren(...values:ElementFixture[]):void{if(this.ownerDocument.activeElement&&this.contains(this.ownerDocument.activeElement))this.ownerDocument.activeElement=null;for(const child of this.children)child.parentElement=null;this.children=[];this.content='';this.append(...values);}
  contains(value:ElementFixture):boolean{return value===this||this.children.some(child=>child.contains(value));}
  all():ElementFixture[]{return this.children.flatMap(child=>[child,...child.all()]);}
  setAttribute(key:string,value:string):void{this.attributes.set(key,value);}getAttribute(key:string):string|null{return this.attributes.get(key)??null;}
  focus():void{this.ownerDocument.activeElement=this;}click():void{this.emit('click');}
}
class DocumentFixture extends Events {
  visibilityState='visible';activeElement:ElementFixture|null=null;defaultView=new Events();root=this.createElement('div');
  createElement(tag:string):ElementFixture{return new ElementFixture(tag.toUpperCase(),this);}
}
interface Call {path:string;init:RequestInit}
type Handler=(call:Call)=>Promise<Response>;
const flush=async()=>{for(let i=0;i<8;i++)await new Promise<void>(resolve=>setImmediate(resolve));};
// Report digests settle on the crypto thread pool, not within a fixed number of
// event-loop turns; bound the wait by real elapsed time (timers/Date are mocked).
async function until(predicate:()=>boolean):Promise<void>{const deadline=performance.now()+5000;while(!predicate()&&performance.now()<deadline)await new Promise<void>(resolve=>setImmediate(resolve));assert.ok(predicate(),'Expected the bounded offline panel operation to settle.');}
function fixture(t:TestContext,records=[report()],reports=true){
  t.mock.timers.enable({apis:['setTimeout','Date'],now:NOW});
  const doc=new DocumentFixture(),calls:Call[]=[];let token=TOKEN,signed=true,project=PROJECT,projectEpoch=0,authEpoch=0;
  let handler:Handler=async call=>{
    if(call.path==='/v1/playtests')return Response.json({jobs:[]});
    if(call.path.startsWith('/v1/playtests/history/report?')){const value=records.find(r=>r.jobId===new URL(call.path,'http://offline.test').searchParams.get('id'));assert.ok(value);return Response.json(envelope(value));}
    if(call.path.startsWith('/v1/playtests/history/capture?'))return new Response(PNG,{headers:{'content-type':'image/png'}});
    if(call.path.startsWith('/v1/playtests/history'))return Response.json({schemaVersion:1,projectId:PROJECT,archive:{state:'ready',code:null},reports:records.slice(0,8).map(summary),nextCursor:null,omittedReports:0});
    assert.fail('History must not use a live mutation route.');
  };
  const transport:typeof fetch=async(input,init)=>{const call={path:String(input),init:init!};calls.push(call);return handler(call);};
  const mount=()=>startPlaytestPanel({root:doc.root as unknown as HTMLElement,token:()=>token,isSignedIn:()=>signed,transport,reports,
    reportContext:()=>({projectId:project,projectEpoch,authEpoch}),autoApprove:()=>true});
  let panel=mount();t.after(()=>panel.stop());
  return{doc,root:doc.root,calls,get panel(){return panel;},handler(value:Handler){handler=value;},auth(value:boolean,next=token){signed=value;token=next;authEpoch++;},project(value:string){project=value;projectEpoch++;},
    remount(){panel.stop();panel=mount();},posts(){return calls.filter(call=>call.init.method==='POST');}};
}
type Fixture=ReturnType<typeof fixture>;
function button(f:Fixture,label:string):ElementFixture{const value=f.root.all().find(e=>e.tagName==='BUTTON'&&e.textContent===label);assert.ok(value,'Expected button '+label);return value;}
function saved(f:Fixture):boolean{return f.root.all().some(e=>e.tagName==='H3'&&e.textContent.startsWith('Saved playtest · '));}
async function load(f:Fixture,r:StudioTestHistoricalReport):Promise<void>{await f.panel.refresh();button(f,'Load saved reports').emit('click',true);await until(()=>f.root.textContent.includes('Open report · '+r.targetName));button(f,'Open report · '+r.targetName).emit('click',true);await until(()=>saved(f));}
function noAuthority(f:Fixture):void{assert.equal(f.posts().length,0);for(const label of ['Run test','Stop','Cancel','Repair playtest records'])assert.ok(!f.root.all().some(e=>e.tagName==='BUTTON'&&!e.hidden&&e.textContent===label));}

test('saved terminal report renders after remount without live jobs, preserving first failure and complete details',async t=>{
  const r=report(),f=fixture(t,[r]);await f.panel.refresh();assert.equal(f.root.hidden,false);assert.equal(f.calls.filter(c=>c.path.startsWith('/v1/playtests/history')).length,0,'History reads require an explicit trusted action.');
  button(f,'Load saved reports').click();await flush();assert.equal(f.calls.filter(c=>c.path.startsWith('/v1/playtests/history')).length,0);
  await load(f,r);assert.match(f.root.textContent,/First failed step: distance/);assert.match(f.root.textContent,/distance · failed · Expected 2 · Observed 0.25/);assert.match(f.root.textContent,/Input release: observed released/);assert.match(f.root.textContent,/Cleanup: complete/);
  const details=f.root.all().find(e=>e.tagName==='DETAILS');assert.ok(details);assert.equal(details.children[0]!.textContent,'Report details');details.open=true;
  assert.ok(f.root.all().some(e=>e.tagName==='PRE'&&e.textContent===JSON.stringify(r,null,2)),'Full actual review, watchdog and log digests stay inspectable.');
  noAuthority(f);f.remount();await load(f,r);assert.match(f.root.textContent,/Current source unobserved/);noAuthority(f);
  t.mock.timers.tick(5000);await flush();noAuthority(f);
});

test('admission-only report remains last observed with unavailable outcome and never revives expired permission',async t=>{
  const r=report(2,true),f=fixture(t,[r]);await load(f,r);assert.match(f.root.textContent,/Last observed · Outcome unavailable/);assert.match(f.root.textContent,/Read-only/);assert.match(f.root.textContent,/grants no current test permission/);noAuthority(f);
  t.mock.timers.tick(10_000);await flush();noAuthority(f);
});

test('the admitted128-observation boundary remains readable independently of the log cap',async t=>{
  const seed=report(),{historicalDigest:_,...content}=seed,{scenario:_plan,subjectDigest:_subject,...proposal}=seed.display.proposal,{scenario:_scenarioReview,...review}=seed.review;
  const display={...seed.display,proposal:{...proposal,durationMs:32_000,observationIntervalMs:250},actions:['start','observe-state-and-console','stop-owned-play']};
  const r=createStudioTestHistoricalReport({...content,display,displayDigest:digest(display),review:{...review,outcome:'succeeded',code:'OK',observations:128,scopeDigest:digest(display),deadline:32_000,cleanupDeadline:47_000}});
  const f=fixture(t,[r]);await load(f,r);assert.ok(f.root.all().some(e=>e.tagName==='PRE'&&e.textContent===JSON.stringify(r,null,2)));assert.match(f.root.textContent,/Result: succeeded/);noAuthority(f);
});

for(const interval of [250,25])test('historical metadata cannot claim an unadmitted '+Math.ceil(60_000/interval)+'-observation proposal',async t=>{
  const seed=report(),{historicalDigest:_,...original}=seed,display={...seed.display,proposal:{...seed.display.proposal,durationMs:60_000,observationIntervalMs:interval}};
  const content={...original,display,displayDigest:digest(display),review:{...seed.review,observations:Math.ceil(60_000/interval),scopeDigest:digest(display),deadline:60_000,cleanupDeadline:75_000}};
  assert.throws(()=>createStudioTestHistoricalReport(content),{code:'ARCHIVE_INPUT'},'The real controller admission domain is retained by the backend parser.');
  const r:StudioTestHistoricalReport={...content,historicalDigest:digest(content)},f=fixture(t,[r]);await f.panel.refresh();button(f,'Load saved reports').emit('click',true);await until(()=>f.root.textContent.includes('Open report ·'));
  button(f,'Open report · '+r.targetName).emit('click',true);await until(()=>f.root.textContent.includes('Saved report unavailable'));assert.equal(saved(f),false);noAuthority(f);
});

test('history opt-in leaves legacy facades hidden and performs no history reads',async t=>{
  const f=fixture(t,[],false);await f.panel.refresh();assert.equal(f.root.hidden,true);assert.equal(f.calls.filter(c=>c.path.includes('/history')).length,0);assert.equal(f.root.textContent.includes('Saved playtest reports'),false);
});

test('saved reports stay readable when the independent live playtest ledger is fenced',async t=>{
  const r=report(),f=fixture(t,[r]);await f.panel.refresh();f.handler(async call=>call.path==='/v1/playtests'?Response.json({error:'FENCED'},{status:409}):
    call.path.includes('/report?')?Response.json(envelope(r)):Response.json({schemaVersion:1,projectId:PROJECT,archive:{state:'ready',code:null},reports:[summary(r)],nextCursor:null,omittedReports:0}));
  await f.panel.refresh();assert.match(f.root.textContent,/Playtests are paused/);await load(f,r);assert.ok(saved(f));assert.equal(f.posts().length,0);assert.equal(button(f,'Repair playtest records').hidden,false,'Live repair remains separate and was never invoked by history.');
});

test('unknown cleanup, release and restoration stay unknown in saved evidence',async t=>{
  const seed=report(),{historicalDigest:_,...content}=seed;
  const r=createStudioTestHistoricalReport({...content,review:{...seed.review,code:'EFFECT_UNKNOWN',cleanup:'unknown',requiresHumanReview:true,canStartAnotherOperation:false,
    scenario:{...seed.review.scenario!,state:'unknown',inputRelease:'unknown',temporary:'unknown',steps:[{id:'move',kind:'hold-key',outcome:'failed',expected:'W:100',observed:null},{id:'distance',kind:'assert-displacement',outcome:'not_run',expected:2,observed:null}]}}});
  const f=fixture(t,[r]);await load(f,r);assert.match(f.root.textContent,/Needs review/);assert.match(f.root.textContent,/Cleanup: unknown/);assert.match(f.root.textContent,/Input release: unknown · Temporary changes: unknown/);noAuthority(f);
});

test('fixed eight-report pagination uses only the exact returned project cursor and human GET',async t=>{
  const records=Array.from({length:9},(_,i)=>report(i+1)),f=fixture(t,records),cursor='1.'+PROJECT+'.2';let page=0;
  f.handler(async call=>{if(call.path==='/v1/playtests')return Response.json({jobs:[]});assert.equal(call.init.method,'GET');assert.equal(new Headers(call.init.headers).get('Authorization'),'Bearer '+TOKEN);
    if(page++===0){assert.equal(call.path,'/v1/playtests/history');return Response.json({schemaVersion:1,projectId:PROJECT,archive:{state:'degraded',code:'ARCHIVE_LIMIT'},reports:records.slice(0,8).map(summary),nextCursor:cursor,omittedReports:4});}
    assert.equal(call.path,'/v1/playtests/history?cursor='+encodeURIComponent(cursor));return Response.json({schemaVersion:1,projectId:PROJECT,archive:{state:'ready',code:null},reports:[summary(records[8]!)],nextCursor:null,omittedReports:4});});
  await f.panel.refresh();button(f,'Load saved reports').emit('click',true);await until(()=>f.root.textContent.includes('4 earlier reports omitted'));assert.equal(f.root.all().filter(e=>e.tagName==='BUTTON'&&e.textContent.startsWith('Open report ·')).length,8);
  button(f,'Next reports').emit('click',true);await until(()=>f.root.textContent.includes(records[8]!.targetName));assert.equal(f.root.all().filter(e=>e.tagName==='BUTTON'&&e.textContent.startsWith('Open report ·')).length,1);assert.equal(button(f,'Next reports').hidden,true);noAuthority(f);
});

for(const malformed of ['project','unknown-field','nine-reports','foreign-cursor'])test('history page refuses '+malformed+' instead of adopting response identity',async t=>{
  const r=report(),f=fixture(t,[r]);await f.panel.refresh();f.handler(async()=>{const page={schemaVersion:1,projectId:PROJECT,archive:{state:'ready',code:null},reports:[summary(r)],nextCursor:null as string|null,omittedReports:0};
    if(malformed==='project')page.projectId=OTHER;else if(malformed==='unknown-field')Object.assign(page,{actor:'invented'});else if(malformed==='nine-reports')page.reports=Array.from({length:9},()=>summary(r));else page.nextCursor='1.'+OTHER+'.1';return Response.json(page);});
  button(f,'Load saved reports').emit('click',true);await until(()=>f.root.textContent.includes('Saved reports unavailable'));assert.equal(saved(f),false);assert.ok(!f.root.textContent.includes('Open report ·'));noAuthority(f);
});

for(const malformed of ['digest','content','display-digest','run-metadata','envelope','job'])test('saved report refuses exact '+malformed+' tamper before rendering',async t=>{
  const r=report(),f=fixture(t,[r]);await f.panel.refresh();button(f,'Load saved reports').emit('click',true);await until(()=>f.root.textContent.includes('Open report ·'));
  f.handler(async()=>{const value=structuredClone(envelope(r));if(malformed==='digest')Object.assign(value.report,{historicalDigest:HASH});else if(malformed==='content')Object.assign(value.report.review.logs[0]!,{bytes:25});else if(malformed==='display-digest')Object.assign(value.report,{displayDigest:HASH});else if(malformed==='run-metadata')Object.assign(value.report.review,{binding:null});else if(malformed==='envelope')Object.assign(value,{readOnly:false});else Object.assign(value.report,{jobId:id(99)});return Response.json(value);});
  button(f,'Open report · '+r.targetName).emit('click',true);await until(()=>f.root.textContent.includes('Saved report unavailable'));assert.equal(saved(f),false);noAuthority(f);
});

for(const change of ['auth-ABA','project-ABA'])test('an original pending history response loses authority after '+change,async t=>{
  const r=report(),f=fixture(t,[r]);await f.panel.refresh();let resolve!:(response:Response)=>void;const pending=new Promise<Response>(done=>{resolve=done;});f.handler(async()=>pending);
  button(f,'Load saved reports').emit('click',true);const original=f.calls.at(-1)!;
  if(change==='auth-ABA'){f.auth(false,'other-control');f.auth(true,TOKEN);}else{f.project(OTHER);f.project(PROJECT);}
  const refresh=f.panel.refresh();assert.equal(original.init.signal?.aborted,true);resolve(Response.json({schemaVersion:1,projectId:PROJECT,archive:{state:'ready',code:null},reports:[summary(r)],nextCursor:null,omittedReports:0}));await refresh;await flush();
  assert.equal(saved(f),false);assert.ok(!f.root.textContent.includes('Open report · '+r.targetName));noAuthority(f);
});

for(const cancel of ['deadline','context','stop'])test('delayed report digest cannot render after '+cancel,async t=>{
  const r=report(),f=fixture(t,[r]);await f.panel.refresh();button(f,'Load saved reports').emit('click',true);await until(()=>f.root.textContent.includes('Open report ·'));
  let release!:()=>void,started=false,finished=false;const gate=new Promise<void>(done=>{release=done;}),original=crypto.subtle.digest.bind(crypto.subtle);
  t.mock.method(crypto.subtle,'digest',async(algorithm:AlgorithmIdentifier,data:BufferSource)=>{started=true;await gate;const result=await original(algorithm,data);finished=true;return result;});
  button(f,'Open report · '+r.targetName).emit('click',true);await until(()=>started);
  if(cancel==='deadline')t.mock.timers.tick(15_001);else if(cancel==='context'){f.auth(false);await f.panel.refresh();}else f.panel.stop();
  release();await until(()=>finished);await flush();assert.equal(saved(f),false);noAuthority(f);
});

test('original capture is fetched only by trusted human GET and its Blob is retired on invalidation and stop',async t=>{
  const r=report(3,false,true),f=fixture(t,[r]),created:Blob[]=[],revoked:string[]=[];
  t.mock.method(URL,'createObjectURL',(blob:Blob)=>{created.push(blob);return 'blob:offline-'+created.length;});t.mock.method(URL,'revokeObjectURL',(url:string)=>{revoked.push(url);});
  await load(f,r);const capture=button(f,'View capture · Context unverified');capture.click();await flush();assert.equal(created.length,0);
  capture.emit('click',true);await until(()=>created.length===1);assert.deepEqual(new Uint8Array(await created[0]!.arrayBuffer()),PNG);assert.equal(created[0]!.type,'image/png');
  const read=f.calls.find(c=>c.path.startsWith('/v1/playtests/history/capture'));assert.ok(read);assert.equal(read.init.method,'GET');assert.equal(new Headers(read.init.headers).get('Authorization'),'Bearer '+TOKEN);
  f.project(OTHER);await f.panel.refresh();assert.deepEqual(revoked,['blob:offline-1']);f.project(PROJECT);f.remount();await load(f,r);button(f,'View capture · Context unverified').emit('click',true);await until(()=>created.length===2);
  f.panel.stop();assert.deepEqual(revoked,['blob:offline-1','blob:offline-2']);noAuthority(f);
});

test('pending capture stream is aborted on context change and tampered original bytes create no URL',async t=>{
  const r=report(4,false,true),f=fixture(t,[r]);let created=0,cancelled=0;t.mock.method(URL,'createObjectURL',()=>{created++;return 'blob:forbidden';});
  await load(f,r);f.handler(async()=>new Response(new ReadableStream<Uint8Array>({cancel(){cancelled++;}}),{headers:{'content-type':'image/png'}}));
  button(f,'View capture · Context unverified').emit('click',true);await flush();const read=f.calls.at(-1)!;f.auth(false);await f.panel.refresh();await flush();assert.equal(read.init.signal?.aborted,true);assert.equal(cancelled,1);assert.equal(created,0);
  f.auth(true);f.remount();f.handler(async call=>call.path.includes('/capture?')?new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'image/png'}}):call.path.includes('/report?')?Response.json(envelope(r)):call.path==='/v1/playtests'?Response.json({jobs:[]}):Response.json({schemaVersion:1,projectId:PROJECT,archive:{state:'ready',code:null},reports:[summary(r)],nextCursor:null,omittedReports:0}));
  await load(f,r);button(f,'View capture · Context unverified').emit('click',true);await until(()=>f.root.textContent.includes('Capture unavailable'));assert.equal(created,0);noAuthority(f);
});

for(const cancel of ['deadline','auth-ABA'])test('original capture digest finishing after '+cancel+' cannot allocate a Blob URL',async t=>{
  const r=report(5,false,true),f=fixture(t,[r]);let created=0;t.mock.method(URL,'createObjectURL',()=>{created++;return 'blob:forbidden';});await load(f,r);
  let release!:()=>void,started=false,finished=false;const gate=new Promise<void>(done=>{release=done;}),original=crypto.subtle.digest.bind(crypto.subtle);
  t.mock.method(crypto.subtle,'digest',async(algorithm:AlgorithmIdentifier,data:BufferSource)=>{started=true;await gate;const result=await original(algorithm,data);finished=true;return result;});
  button(f,'View capture · Context unverified').emit('click',true);await until(()=>started);
  if(cancel==='deadline')t.mock.timers.tick(8001);else{f.auth(false,'other-control');f.auth(true,TOKEN);await f.panel.refresh();}
  release();await until(()=>finished);await flush();assert.equal(created,0);noAuthority(f);
});

for(const kind of ['page','report'])test('history '+kind+' response respects its independent advertised byte cap',async t=>{
  const r=report(),f=fixture(t,[r]);await f.panel.refresh();if(kind==='report'){button(f,'Load saved reports').emit('click',true);await until(()=>f.root.textContent.includes('Open report ·'));}
  let cancelled=0;f.handler(async()=>new Response(new ReadableStream<Uint8Array>({cancel(){cancelled++;}}),{headers:{'content-type':'application/json','content-length':String((kind==='page'?32:272)*1024+1)}}));
  button(f,kind==='page'?'Load saved reports':'Open report · '+r.targetName).emit('click',true);await until(()=>cancelled===1);assert.equal(saved(f),false);noAuthority(f);
});

for(const kind of ['page','report'])test('duplicate keys in the original history '+kind+' envelope are refused',async t=>{
  const r=report(),f=fixture(t,[r]);await f.panel.refresh();if(kind==='report'){button(f,'Load saved reports').emit('click',true);await until(()=>f.root.textContent.includes('Open report ·'));}
  const original=kind==='report'?envelope(r):{schemaVersion:1,projectId:PROJECT,archive:{state:'ready',code:null},reports:[summary(r)],nextCursor:null,omittedReports:0};
  f.handler(async()=>new Response(JSON.stringify(original).replace('{','{"schemaVersion":1,'),{headers:{'content-type':'application/json'}}));
  button(f,kind==='page'?'Load saved reports':'Open report · '+r.targetName).emit('click',true);await until(()=>f.root.textContent.includes(kind==='page'?'Saved reports unavailable':'Saved report unavailable'));assert.equal(saved(f),false);noAuthority(f);
});

test('actual production caller explicitly enables fixed-project history and releases its auth subscription',async()=>{
  const source=await readFile(resolve('apps/desktop/src/studio.ts'),'utf8');
  assert.match(source,/reports:true/);assert.match(source,/projectEpoch:this\.productMetadataEpoch/);assert.match(source,/playtestAuthEpoch\+\+;void playtests\?\.refresh\(\)/);
  assert.match(source,/reportContext:\(\)=>\{const current=workbench\.getPlaytestReportContext\(\)/);assert.match(source,/const stopTests=\(\)=>\{removePlaytestAuth\?\.\(\);removePlaytestAuth=null;playtests\?\.stop\(\)/);
});
