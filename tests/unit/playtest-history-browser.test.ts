/// <reference lib="dom" />
import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import type {Page} from 'playwright-core';
import {createStudioTestHistoricalReport,type StudioTestHistoricalReport} from '../../apps/daemon/src/studio-test-report-store.js';
import {digest} from '../../packages/studio-test-controller/src/contracts.js';
import {SCENARIO_ACTIONS} from '../../packages/studio-test-controller/src/scenario.js';
import {png} from '../../packages/asset-pipeline/testing/fixture.js';

// Real Edge DOM + production built module/HTML/CSS; synthetic history HTTP only.
// No provider, controller, Studio, real account or native acceptance is involved.
const browserModule=process.env.ARCANE_UI_BROWSER_MODULE,PROJECT='a'.repeat(64),OTHER='b'.repeat(64),TOKEN='owned-history-browser-fixture',HASH='c'.repeat(64);
const DRAFT='Keep this unsent conversation draft.',LONG_NAME='Saved garden '+('Detailed garden name '.repeat(22)).trim();
const options={skip:!browserModule,timeout:60_000};
const id=(n:number)=>'11111111-1111-4111-8111-'+n.toString(16).padStart(12,'0');
function record(n:number,image:Buffer,admission=false):StudioTestHistoricalReport {
  const plan={version:1,runtimeBudgetMs:500,targets:[],steps:[{id:'move',kind:'hold-key',key:'W',holdMs:100},{id:'distance',kind:'assert-displacement',minimumStuds:2}],capture:{required:!admission}};
  const display={proposal:{binding:{nativeStudioId:'browser-native-fixture',pairedSessionId:'browser-paired-fixture',clientLifetimeId:'fixture-life',pluginArtifactHash:HASH,scopeRevision:HASH,placeId:0},durationMs:5000,observationIntervalMs:1000,failOnRuntimeError:true,scenario:plan,subjectDigest:HASH},
    cleanupGraceMs:15000,requestTimeoutMs:15000,proofMaxAgeMs:6000,consentExpiresAt:1,guarantee:'observed-non-atomic',actions:SCENARIO_ACTIONS,raceDisclosure:'Observed checks cannot atomically fence the native call.'};
  return createStudioTestHistoricalReport({schemaVersion:1,kind:'studio-playtest-report',projectId:PROJECT,jobId:id(n),taskId:null,createdAt:'2026-10-27T00:00:00.000Z',observedAt:admission?'2026-10-27T00:00:00.000Z':'2026-10-27T00:00:06.000Z',snapshot:admission?'admission':'terminal',
    targetName:admission?'Incomplete saved admission':LONG_NAME,observedState:admission?'needs_approval':'complete',display,displayDigest:digest(display),evidence:'fixture',nativeAcceptance:false,
    review:{runId:admission?null:'browser-run-'+n,evidence:'fixture',nativeAcceptance:false,binding:admission?null:display.proposal.binding,scopeDigest:admission?null:digest(display),phase:admission?'idle':'done',outcome:admission?null:'failed',code:admission?'OK':'ASSERTION_FAILED',cleanup:admission?'not_started':'complete',
      startedAt:admission?null:0,deadline:admission?null:5000,cleanupDeadline:admission?null:20000,watchdog:{armed:false,fired:false,reason:null},observations:admission?0:2,logs:admission?[]:Array.from({length:128},()=>({idDigest:HASH,digest:HASH,level:'warning',bytes:8192})),logsTruncated:!admission,requiresHumanReview:false,canStartAnotherOperation:!admission,
      scenario:{scenarioDigest:digest(plan),subjectDigest:HASH,state:admission?'not_started':'failed',inputRelease:admission?'not_started':'observed_released',temporary:admission?'not_started':'restored',consoleCoverage:'ambiguous',steps:admission?[]:[{id:'move',kind:'hold-key',outcome:'passed',expected:'W:100',observed:'observed-released'},{id:'distance',kind:'assert-displacement',outcome:'failed',expected:2,observed:0.25}],
        capture:admission?null:{id:'browser-run-'+n,sha256:createHash('sha256').update(image).digest('hex'),bytes:image.length,mimeType:'image/png',width:128,height:128,context:'unattested',nativeAcceptance:false}}}});
}
interface BrowserHistoryFixture {ready:boolean;created:string[];revoked:string[];transition(kind:'auth'|'project'):Promise<void>;stop():void}
declare global {interface Window {savedHistoryFixture:BrowserHistoryFixture}}
async function fixture(t:TestContext){
  const build=process.env.ARCANE_UI_BUILD_DIR;assert.ok(build,'Use the actual explicit compiled product output.');
  const image=png(true),records=[record(1,image),record(2,image,true)],reads:string[]=[],writes:string[]=[],errors:string[]=[],unexpected:string[]=[];
  const source=(await readFile(resolve('apps/desktop/public/studio.html'),'utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace('</body>','<script type="module" src="/history-fixture.js"></script></body>');
  const files=new Map<string,[string,string]>([['/studio.css',[resolve('apps/desktop/public/studio.css'),'text/css']],['/playtest-panel.js',[resolve(build,'apps/desktop/src/playtest-panel.js'),'text/javascript']],
    ['/brand/arcane-ridges.png',[resolve('apps/desktop/public/brand/arcane-ridges.png'),'image/png']],
    ...(await readdir(resolve('apps/desktop/public/fonts'))).filter(name=>name.endsWith('.woff2')).map(name=>['/fonts/'+name,[resolve('apps/desktop/public/fonts',name),'font/woff2']] as [string,[string,string]])]);
  const bootstrap=`import {startPlaytestPanel} from '/playtest-panel.js';
    const root=document.getElementById('playtest-panel');let signed=true,projectId=${JSON.stringify(PROJECT)},projectEpoch=0,authEpoch=0;
    document.getElementById('workspace-stage').classList.remove('provider-required');
    document.getElementById('provider-login-gate').hidden=true;document.getElementById('provider-checking').hidden=true;
    document.getElementById('codex-submit').disabled=false;document.getElementById('codex-composer').value=${JSON.stringify(DRAFT)};
    const message=document.createElement('p');message.textContent='Existing conversation remains reachable.';document.getElementById('codex-messages').append(message);
    const created=[],revoked=[],create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);
    URL.createObjectURL=blob=>{const url=create(blob);created.push(url);return url;};URL.revokeObjectURL=url=>{revoked.push(url);revoke(url);};
    const panel=startPlaytestPanel({root,token:()=>${JSON.stringify(TOKEN)},isSignedIn:()=>signed,reports:true,reportContext:()=>({projectId,projectEpoch,authEpoch}),autoApprove:()=>true});
    window.savedHistoryFixture={ready:false,created,revoked,async transition(kind){if(kind==='auth'){signed=false;authEpoch++;signed=true;authEpoch++;}else{projectId=${JSON.stringify(OTHER)};projectEpoch++;projectId=${JSON.stringify(PROJECT)};projectEpoch++;}await panel.refresh();},stop(){panel.stop();}};
    await panel.refresh();await document.fonts.ready;window.savedHistoryFixture.ready=true;`;
  let held=false,release=()=>{},entered=()=>{};let reportEntered=Promise.resolve();
  const server=createServer((request,response)=>{void(async()=>{
    const path=new URL(request.url??'/','http://fixture.invalid').pathname;
    const send=(body:unknown)=>{response.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});response.end(JSON.stringify(body));};
    if(request.method==='GET'&&path==='/studio'){response.writeHead(200,{'content-type':'text/html'});response.end(source);return;}
    if(request.method==='GET'&&path==='/history-fixture.js'){response.writeHead(200,{'content-type':'text/javascript'});response.end(bootstrap);return;}
    const file=files.get(path);if(request.method==='GET'&&file){response.writeHead(200,{'content-type':file[1]});response.end(await readFile(file[0]));return;}
    if(path==='/favicon.ico'){response.writeHead(204);response.end();return;}
    if(request.method!=='GET'){writes.push(path);response.writeHead(405);response.end();return;}
    assert.equal(request.headers.authorization,'Bearer '+TOKEN);reads.push(request.url!);
    if(path==='/v1/playtests'){send({jobs:[]});return;}
    if(path==='/v1/playtests/history'){send({schemaVersion:1,projectId:PROJECT,archive:{state:'ready',code:null},reports:records.map(r=>({jobId:r.jobId,taskId:r.taskId,createdAt:r.createdAt,observedAt:r.observedAt,snapshot:r.snapshot,targetName:r.targetName,observedState:r.observedState,outcome:r.review.outcome,code:r.review.code,cleanup:r.review.cleanup,evidence:r.evidence,nativeAcceptance:false,historicalDigest:r.historicalDigest})),nextCursor:null,omittedReports:0});return;}
    const selected=records.find(r=>r.jobId===new URL(request.url!,'http://fixture.invalid').searchParams.get('id'));assert.ok(selected);
    if(path==='/v1/playtests/history/report'){if(held){entered();await new Promise<void>(done=>{release=done;});}if(response.destroyed)return;
      send({schemaVersion:1,projectId:PROJECT,archive:{state:'ready',code:null},report:selected,receiptScope:'historical-playtest',currentSource:'unobserved',readOnly:true});return;}
    if(path==='/v1/playtests/history/capture'&&selected.jobId===records[0]!.jobId){response.writeHead(200,{'content-type':'image/png','content-length':image.length,'cache-control':'no-store'});response.end(image);return;}
    unexpected.push(path);response.writeHead(404);response.end();
  })().catch(error=>{errors.push(String(error));if(!response.headersSent)response.writeHead(500);response.end();});});
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));t.after(async()=>{release();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));});
  const address=server.address();assert.ok(address&&typeof address!=='string');const origin='http://127.0.0.1:'+address.port;
  const {chromium}=await import(pathToFileURL(resolve(browserModule!)).href) as typeof import('playwright-core');
  const browser=await chromium.launch({headless:true,args:['--disable-gpu'],executablePath:process.env.ARCANE_UI_BROWSER_EXE??'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'});page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(!request.url().startsWith(origin+'/')&&!request.url().startsWith('blob:'))unexpected.push(request.url());});
  await page.goto(origin+'/studio',{waitUntil:'domcontentloaded',timeout:6000});await page.waitForFunction(()=>window.savedHistoryFixture?.ready===true,{},{timeout:6000});
  return{page,reads,writes,errors,unexpected,records,holdReport(){held=true;reportEntered=new Promise<void>(done=>{entered=done;});return reportEntered;},releaseReport(){held=false;release();},
    check(){assert.deepEqual(writes,[],'History never invokes live POST/action routes.');assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);}};
}
async function openReport(page:Page,name=LONG_NAME){
  const load=page.getByRole('button',{name:/^(Load saved reports|Latest reports)$/});await page.waitForFunction(()=>document.getElementById('playtest-panel')?.getAttribute('aria-busy')==='false');await load.focus();await load.press('Enter');
  const open=page.getByRole('button',{name:'Open report · '+name,exact:true});await open.waitFor({state:'visible'});await page.waitForFunction(()=>document.getElementById('playtest-panel')?.getAttribute('aria-busy')==='false');await open.focus();await open.press('Enter');
  await page.getByRole('heading',{name:'Saved playtest · '+name,exact:true}).waitFor({state:'visible'});
}
async function reachable(page:Page,label:string){
  const facts=await page.evaluate(()=>{
    const send=document.getElementById('codex-submit')!,composer=document.getElementById('codex-compose')!,panel=document.getElementById('playtest-panel')!,scroll=document.querySelector('.conversation-scroll')!;
    const s=send.getBoundingClientRect(),c=composer.getBoundingClientRect();
    return{horizontal:document.documentElement.scrollWidth-document.documentElement.clientWidth,transcriptOverflow:scroll.scrollWidth-scroll.clientWidth,panelOverflow:panel.scrollWidth-panel.clientWidth,
      sendVisible:s.width>0&&s.height>0&&s.left>=0&&s.right<=innerWidth&&s.top>=0&&s.bottom<=innerHeight,composerVisible:c.top>=0&&c.bottom<=innerHeight,
      sendHit:!!document.elementFromPoint(s.left+s.width/2,s.top+s.height/2)?.closest('#codex-submit'),draft:(document.getElementById('codex-composer') as HTMLTextAreaElement).value};
  });
  assert.ok(facts.horizontal<=0,label+': no horizontal page overflow');assert.ok(facts.transcriptOverflow<=1,label+': no horizontal transcript overflow');assert.ok(facts.panelOverflow<=1,label+': long reports stay inside panel');
  assert.ok(facts.sendVisible&&facts.composerVisible&&facts.sendHit,label+': composer and Send stay reachable');assert.equal(facts.draft,DRAFT);
}

test('Edge saved reports: long full details preserve chat/composer geometry and keyboard disclosure at narrow and wide sizes',options,async t=>{
  const f=await fixture(t),{page}=f;assert.equal(f.reads.some(path=>path.startsWith('/v1/playtests/history')),false,'Mount does not automatically read history.');
  await openReport(page);assert.equal(await page.getByText('First failed step: distance',{exact:true}).count(),1);assert.equal(await page.getByText('distance · failed · Expected 2 · Observed 0.25',{exact:true}).count(),1);
  const details=page.locator('#playtest-panel .playtest-details'),summary=details.locator('summary');assert.equal(await details.evaluate(node=>(node as HTMLDetailsElement).open),false);
  for(const [width,height] of [[360,900],[768,1024],[1440,900]] as const){
    await page.setViewportSize({width,height});await reachable(page,width+' collapsed');
    await summary.focus();await summary.press('Space');assert.equal(await details.evaluate(node=>(node as HTMLDetailsElement).open),true);assert.equal(await details.locator('pre').count(),1);
    assert.match(await details.locator('pre').innerText(),/"logsTruncated": true/);await reachable(page,width+' full JSON');
    await summary.press('Space');assert.equal(await details.evaluate(node=>(node as HTMLDetailsElement).open),false);assert.equal(await summary.evaluate(node=>node===document.activeElement),true,'Native keyboard disclosure retains focus.');
    await page.locator('#codex-composer').focus();assert.equal(await page.locator('#codex-composer').evaluate(node=>node===document.activeElement),true);await reachable(page,width+' returned to composer');
  }
  await openReport(page,'Incomplete saved admission');assert.equal(await page.getByText('Last observed · Outcome unavailable',{exact:true}).count(),1);
  assert.equal(await page.locator('#playtest-panel button[data-playtest-action="approve"],#playtest-panel button[data-playtest-action="cancel"]').count(),0);
  await page.waitForResponse(response=>new URL(response.url()).pathname==='/v1/playtests'&&response.status()===200,{timeout:6000});f.check();
});

test('Edge saved reports: original capture URLs and stale reports retire across auth/project ABA and stop without historical writes',options,async t=>{
  const f=await fixture(t),{page}=f;await openReport(page);await page.getByRole('button',{name:'View capture · Context unverified',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector<HTMLImageElement>('#playtest-panel img')?.naturalWidth===128);
  for(const kind of ['project','auth'] as const){
    await page.evaluate(kind=>window.savedHistoryFixture.transition(kind),kind);
    assert.equal(await page.locator('#playtest-panel img').count(),0);assert.equal(await page.getByRole('heading',{name:'Saved playtest · '+LONG_NAME,exact:true}).count(),0);
    assert.equal(await page.evaluate(()=>window.savedHistoryFixture.created.length===window.savedHistoryFixture.revoked.length),true);await reachable(page,kind+' invalidation');
    await openReport(page);await page.getByRole('button',{name:'View capture · Context unverified',exact:true}).click();await page.waitForFunction(()=>document.querySelector<HTMLImageElement>('#playtest-panel img')?.naturalWidth===128);
  }
  await page.evaluate(()=>window.savedHistoryFixture.transition('auth'));const entered=f.holdReport();
  const load=page.getByRole('button',{name:'Load saved reports',exact:true});await load.click();const open=page.getByRole('button',{name:'Open report · '+LONG_NAME,exact:true});await open.waitFor({state:'visible'});await open.click();await entered;
  await page.evaluate(()=>window.savedHistoryFixture.transition('auth'));f.releaseReport();await page.evaluate(()=>new Promise<void>(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done()))));
  assert.equal(await page.getByRole('heading',{name:'Saved playtest · '+LONG_NAME,exact:true}).count(),0,'Releasing the old held response cannot repopulate the new auth epoch.');
  await openReport(page);await page.getByRole('button',{name:'View capture · Context unverified',exact:true}).click();await page.waitForFunction(()=>document.querySelector<HTMLImageElement>('#playtest-panel img')?.naturalWidth===128);
  await page.evaluate(()=>window.savedHistoryFixture.stop());assert.equal(await page.locator('#playtest-panel img').count(),0);assert.equal(await page.evaluate(()=>window.savedHistoryFixture.created.length===window.savedHistoryFixture.revoked.length),true);
  f.check();
});
