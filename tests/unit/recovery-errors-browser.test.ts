import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir,mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';

// Actual compiled controller, decoder, error catalogue and shipped HTML/CSS in isolated Edge.
// Native/provider transport is a read-only state fixture. No login, customer profile or Studio runs.
test('recovery errors are readable overlays and never move sign-in controls at desktop and narrow widths',
 {skip:!process.env.ARCANE_UI_BROWSER_MODULE,timeout:30000},async t=>{
  const {chromium}=await import(pathToFileURL(resolve(process.env.ARCANE_UI_BROWSER_MODULE!)).href);
  const browser=await chromium.launch({headless:true,executablePath:process.env.ARCANE_UI_BROWSER_EXE});t.after(()=>browser.close());
  const build=process.env.ARCANE_UI_BUILD_DIR??resolve('dist'),files=new Map<string,{body:Buffer;type:string}>();
  const html=(await readFile('apps/desktop/public/studio.html','utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'');
  files.set('/fixture',{body:Buffer.from(html),type:'text/html'});
  for(const name of ['codex-chat','provider-setup','user-errors'])files.set('/'+name+'.js',{body:await readFile(join(build,'apps/desktop/src/'+name+'.js')),type:'text/javascript'});
  files.set('/studio.css',{body:await readFile('apps/desktop/public/studio.css'),type:'text/css'});
  for(const name of await readdir('apps/desktop/public/fonts'))if(/^[a-z0-9-]+\.woff2$/.test(name))files.set('/fonts/'+name,{body:await readFile('apps/desktop/public/fonts/'+name),type:'font/woff2'});
  const unexpected:string[]=[],server=createServer((req,res)=>{const path=req.url?.split('?')[0]??'',file=files.get(path);if(!file&&path!=='/favicon.ico')unexpected.push(path);res.writeHead(file?200:404,{'Content-Type':file?.type??'text/plain'});res.end(file?.body??'');});
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));t.after(async()=>{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));});
  const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
  const record={requestId:randomUUID(),action:'connect',connectionId:null,state:'unknown',errorCode:'FRAME_LIMIT',threadId:null,turnId:null,model:null,effort:null,createdAt:'2026-10-30T12:00:00.000Z',finishedAt:'2026-10-30T12:00:01.000Z'};
  type FixtureConnectRecord=typeof record;
  for(const width of [1484,980,540,375]){
    const page=await browser.newPage({viewport:{width,height:960},reducedMotion:'reduce'}),errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));
    await page.goto(origin+'/fixture');await page.evaluate(async()=>{document.documentElement.dataset.providerReady='true';document.documentElement.dataset.providerView='setup';document.documentElement.dataset.theme='dark';document.getElementById('workspace-stage')!.classList.add('provider-required');await document.fonts.ready;});
    await page.evaluate(async()=>{
      const modulePath='/codex-chat.js',m=await import(modulePath),w=window as any;w.posts=[];
      w.fixture={provider:'codex',use:'personal-local',projectPath:'/fixture-project',connecting:false,closing:false,busy:false,snapshot:null,lastSnapshot:null,actions:[],nativeThreads:[],nativeHistory:null,nativeTools:{configured:true,verified:false}};
      const api=new m.CodexChatApi('a'.repeat(64),async(_path:string,init:RequestInit)=>{if(init?.method==='POST'){w.posts.push(_path);throw Error('Unexpected native dispatch');}return Response.json({state:w.fixture});});
      w.chat=new m.CodexChat(document,api);await w.chat.start();
    });
    const before=await page.locator('#provider-login-start').boundingBox();assert.ok(before);
    await page.evaluate(async({record}:{record:FixtureConnectRecord})=>{const w=window as any;w.fixture.actions=[record];w.fixture.connectNotices=[{requestId:record.requestId,receiptFingerprint:'c'.repeat(64),reviewedAt:null}];w.fixture.chatTasks=Array.from({length:3},(_,i)=>({taskId:'11111111-2222-4333-8444-'+String(i+1).padStart(12,'0'),threadId:'earlier-'+i,sessionId:null,connectionId:'22222222-3333-4444-8555-666666666666',state:'unknown',round:0,reason:'daemon_restarted_no_replay',reportDigest:null,retained:false}));await w.chat.refresh();},{record});
    assert.match(await page.locator('#codex-unknown-title').innerText(),/^Error 412/);
    assert.equal(await page.locator('#codex-acknowledge').isEnabled(),false);
    assert.equal(await page.locator('#codex-recovery-panel').getAttribute('open'),null);
    const collapsed=await page.locator('#codex-unknown').boundingBox();assert.ok(collapsed);assert.ok(collapsed.x>=0&&collapsed.x+collapsed.width<=width&&collapsed.height<=112);
    const after=await page.locator('#provider-login-start').boundingBox();assert.deepEqual(after,before,'Showing an error must not move the sign-in action at '+width);
    assert.equal(await page.locator('body > #codex-unknown').count(),1,'Notification escapes masked conversation layout');
    assert.equal(await page.locator('#codex-reconcile').isVisible(),true,'Status remains available without expanding details');
    if(process.env.ARCANE_ERROR_SCREENSHOTS){await mkdir(process.env.ARCANE_ERROR_SCREENSHOTS,{recursive:true});await page.screenshot({path:join(process.env.ARCANE_ERROR_SCREENSHOTS,'recovery-collapsed-'+width+'.png')});}
    await page.locator('#codex-recovery-panel > summary').click();
    assert.match(await page.locator('#codex-error-explanation').innerText(),/Reconnecting does not settle/);
    assert.deepEqual(await page.locator('#provider-login-start').boundingBox(),before,'Expanding explanation must not move sign-in controls');
    await page.locator('#codex-unknown-details > summary').click();assert.match(await page.locator('#codex-unknown-requests').innerText(),new RegExp(record.requestId));
    assert.match(await page.locator('#codex-unknown-requests').innerText(),/Error 411/);
    assert.deepEqual(await page.evaluate(()=>(window as any).posts),[]);assert.deepEqual(errors,[]);
    if(process.env.ARCANE_ERROR_SCREENSHOTS){await mkdir(process.env.ARCANE_ERROR_SCREENSHOTS,{recursive:true});await page.screenshot({path:join(process.env.ARCANE_ERROR_SCREENSHOTS,'recovery-'+width+'.png')});}
    await page.evaluate(async()=>{
      const w=window as any;w.chat.stop();w.loginCalls=[];w.settingsRequests=0;document.addEventListener('workspace:settingsrequest',()=>w.settingsRequests++);
      const modulePath='/provider-setup.js',m=await import(modulePath);
      const status=async()=>({version:1,provider:'codex',installed:true,auth:'signed-out',cliVersion:'fixture',busy:false,message:null});
      w.provider=m.startProviderSetup(document,{chat:{providerConnectionStatus:()=>null,subscribeProviderStateChange:()=>()=>{}},nativeBridge:Object.freeze({version:1,status,login:async(provider:string)=>{w.loginCalls.push(provider);throw Error('Controlled browser sign-in failed before confirmation.');},install:status,launch:status})});
    });
    await page.waitForFunction(()=>!(document.getElementById('provider-login-start') as HTMLButtonElement).disabled);
    const loginBefore=await page.locator('#provider-login-start').boundingBox();assert.ok(loginBefore);
    await page.locator('#provider-login-start').click();
    await page.waitForFunction(()=>document.getElementById('provider-login-message')!.textContent!.startsWith('Error 414'));
    assert.deepEqual(await page.locator('#provider-login-start').boundingBox(),loginBefore,'A browser login failure must not move its action at '+width);
    assert.match(await page.locator('#provider-login-message').innerText(),/Controlled browser sign-in failed before confirmation/);
    assert.deepEqual(await page.evaluate(()=>(window as any).loginCalls),['codex']);assert.equal(await page.evaluate(()=>(window as any).settingsRequests),0);
    assert.deepEqual(errors,[]);await page.evaluate(()=>(window as any).provider.cleanup());
    await page.evaluate(async()=>{
      const w=window as any;w.loginCalls=[];w.metadataChecks=0;w.chat.resume();await w.chat.refresh();
      const modulePath='/provider-setup.js',m=await import(modulePath);
      const status=async()=>({version:1,provider:'codex',installed:true,auth:'signed-out',cliVersion:'fixture',busy:false,message:null});
      const forbidden=async()=>{throw Error('No installation or terminal launch is expected.');};
      w.provider=m.startProviderSetup(document,{signInPage:true,chat:{
        providerConnectionStatus:()=>w.chat.providerConnectionStatus(),subscribeProviderStateChange:(listener:()=>void)=>w.chat.subscribeProviderStateChange(listener),
        connectForSavedLogin:async(current?:()=>boolean)=>{w.metadataChecks++;await w.chat.connectForSavedLogin(current);}},
        nativeBridge:Object.freeze({version:1,status,login:async(provider:string)=>{w.loginCalls.push(provider);return {...await status(),auth:'subscription'};},install:forbidden,launch:forbidden})});
    });
    await page.waitForFunction(()=>!(document.getElementById('provider-login-start') as HTMLButtonElement).disabled);
    assert.equal(await page.locator('#provider-login-gate').isVisible(),true);
    await page.locator('#provider-login-start').click();
    await page.waitForFunction(()=>(window as any).metadataChecks===1&&document.getElementById('provider-login-gate')!.getAttribute('aria-busy')==='false');
    assert.equal(await page.locator('#provider-login-gate').isVisible(),false,'Verified account sign-in must open the workspace even while recovery holds native connection');
    assert.equal(await page.locator('html').getAttribute('data-provider-view'),'workspace');
    assert.match(await page.locator('#codex-unknown-title').innerText(),/^Error 412/);
    assert.equal(await page.locator('#codex-submit').isDisabled(),true);assert.equal(await page.locator('#codex-model-trigger').isDisabled(),true);
    assert.equal(await page.evaluate(()=>(window as any).provider.isSignedIn()),false,'Presentation cannot establish native readiness');
    assert.deepEqual(await page.evaluate(()=>(window as any).posts),[]);
    assert.deepEqual(await page.evaluate(()=>(window as any).loginCalls),['codex']);
    assert.deepEqual(await page.evaluate(()=>{const s=(window as any).chat.currentStateView().state;return{snapshot:s.snapshot,actions:s.actions,tasks:s.chatTasks.map((task:any)=>task.state)};}),
      {snapshot:null,actions:[record],tasks:['unknown','unknown','unknown']});
    await page.evaluate(()=>(window as any).chat.refresh());assert.equal(await page.evaluate(()=>(window as any).metadataChecks),1);
    assert.equal(await page.evaluate(()=>(window as any).settingsRequests),0);assert.deepEqual(errors,[]);
    await page.evaluate(()=>{const w=window as any;w.provider.cleanup();w.chat.stop();});await page.close();
  }
  assert.deepEqual(unexpected,[]);
 });
