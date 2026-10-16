import test from 'node:test';import assert from 'node:assert/strict';import {readProviderSetupState,readProviderPresentation,startProviderSetup} from '../../apps/desktop/src/provider-setup.js';
import {readFile} from 'node:fs/promises';import {createServer} from 'node:http';import {join,resolve} from 'node:path';import {pathToFileURL} from 'node:url';
const state={version:1,provider:'codex',installed:true,auth:'signed-out',cliVersion:'0.162.0-alpha.17.2',busy:false,message:null};
test('native setup accepts exact sanitized state and rejects authority fields, stale providers and accessors',()=>{
 assert.deepEqual(readProviderSetupState(state,'codex'),state);
 for(const v of [{...state,provider:'claude'},{...state,token:'secret'},{...state,auth:'authenticated'},{...state,installed:false},{...state,message:'bad\nlog'},{...state,cliVersion:'x'.repeat(101)}])assert.throws(()=>readProviderSetupState(v,'codex'));
 let reads=0;const v={...state};Object.defineProperty(v,'auth',{enumerable:true,get(){reads++;return 'subscription';}});assert.throws(()=>readProviderSetupState(v,'codex'));assert.equal(reads,0);
});
test('a missing mount does not invoke the native bridge or connection',()=>{
 const doc={getElementById:()=>null} as unknown as Document;assert.doesNotThrow(()=>startProviderSetup(doc,{chat:{providerConnectionStatus:()=>null,subscribeProviderStateChange:()=>()=>{}},nativeBridge:Object.freeze({version:1,status(){assert.fail('no probe');},login(){assert.fail('no login');},install(){assert.fail('no install');},launch(){assert.fail('no launch');}})}));
});
test('Claude help choices remain explicit detached metadata with exact version and bounded own arrays',()=>{
 const native={...state,provider:'claude',auth:'subscription',cliVersion:'2.1.177'};
 const choices={cliVersion:'2.1.177',aliases:['opus','sonnet'],efforts:['low','high','max']};
 const out=readProviderSetupState({...native,claudeChoices:choices},'claude');
 assert.deepEqual(out.claudeChoices,choices); assert.ok(Object.isFrozen(out.claudeChoices)&&Object.isFrozen(out.claudeChoices?.aliases)&&Object.isFrozen(out.claudeChoices?.efforts));
 choices.aliases.push('changed');assert.deepEqual(out.claudeChoices?.aliases,['opus','sonnet']);choices.aliases.pop();
 assert.equal(readProviderSetupState({...native,claudeChoices:null},'claude').claudeChoices,null);
 assert.ok(!Object.hasOwn(readProviderSetupState(native,'claude'),'claudeChoices'),'legacy status remains compatible');
 for(const bad of [{...choices,token:'secret'},{...choices,cliVersion:'2.1.178'},{...choices,aliases:[]},{...choices,aliases:['opus','opus']},
  {...choices,aliases:['--model']},{...choices,efforts:new Array(2)},{...choices,efforts:['x'.repeat(65)]},{...choices,aliases:Array(33).fill('opus')}])
  assert.throws(()=>readProviderSetupState({...native,claudeChoices:bad},'claude'));
 assert.throws(()=>readProviderSetupState({...state,claudeChoices:choices},'codex'));
 assert.throws(()=>readProviderSetupState({...native,installed:false,cliVersion:null,auth:'unknown',claudeChoices:choices},'claude'));
 let reads=0;const aliases=['opus'];Object.defineProperty(aliases,'0',{enumerable:true,get(){reads++;return 'opus';}});
 assert.throws(()=>readProviderSetupState({...native,claudeChoices:{...choices,aliases}},'claude'));assert.equal(reads,0);
 const accessor={...choices};Object.defineProperty(accessor,'efforts',{enumerable:true,get(){reads++;return ['high'];}});
 assert.throws(()=>readProviderSetupState({...native,claudeChoices:accessor},'claude'));assert.equal(reads,0);
});
test('remembered provider accepts only bounded presentation metadata, never auth or credentials',()=>{
 for(const provider of ['codex','claude'])assert.equal(readProviderPresentation(JSON.stringify({version:1,provider})),provider);
 for(const value of [null,{},'null','[]','{','"codex"',JSON.stringify({version:2,provider:'codex'}),JSON.stringify({version:1,provider:'other'}),JSON.stringify({version:1,provider:'codex',auth:'subscription'}),JSON.stringify({version:1,provider:'claude',token:'secret'}),' '.repeat(81)+JSON.stringify({version:1,provider:'codex'})]) {
  assert.equal(readProviderPresentation(value),null);
 }
 assert.equal(readProviderPresentation('{"version":1,"provider":"codex","__proto__":{"auth":"subscription"}}'),null);
});
test('real Edge setup: bounded startup status, explicit login/install, auth gate and draft preserved',{skip:!process.env.ARCANE_UI_BROWSER_MODULE,timeout:30000},async t=>{
 const {chromium}=await import(pathToFileURL(resolve(process.env.ARCANE_UI_BROWSER_MODULE!)).href);const browser=await chromium.launch({headless:true,executablePath:process.env.ARCANE_UI_BROWSER_EXE});t.after(()=>browser.close());
 const build=process.env.ARCANE_UI_BUILD_DIR??resolve('dist'),html=await readFile('apps/desktop/public/studio.html','utf8'),js=await readFile(join(build,'apps/desktop/src/provider-setup.js'),'utf8'),css=await readFile('apps/desktop/public/studio.css','utf8');
 const server=createServer((req,res)=>{const p=req.url?.split('?')[0],value=p==='/fixture'?html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,''):p==='/provider-setup.js'?js:p==='/studio.css'?css:'';res.writeHead(value?200:404,{'Content-Type':p==='/fixture'?'text/html':p==='/studio.css'?'text/css':'text/javascript'});res.end(value);});await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));t.after(async()=>{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));});const port=(server.address() as {port:number}).port;
 const page=await browser.newPage(),errors:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message));await page.goto('http://127.0.0.1:'+port+'/fixture');
 await page.evaluate(async()=>{const modulePath:string='/provider-setup.js',m=await import(modulePath);const w=window as unknown as Record<string,any>;w.calls=[];w.account=null;w.subscriber=()=>{};w.providerFixtureState={version:1,provider:'codex',installed:true,auth:'signed-out',cliVersion:'1.0.0',busy:false,message:null};
 const bridge=Object.freeze({version:1,...Object.fromEntries(['status','login','install','launch'].map(action=>[action,async(provider:string)=>{w.calls.push({action,provider});return {...w.providerFixtureState,provider};}]))});
 w.controller=m.startProviderSetup(document,{chat:{providerConnectionStatus:()=>w.account,subscribeProviderStateChange:(fn:()=>void)=>{w.subscriber=fn;return()=>{};}},nativeBridge:bridge});
 let p=document.getElementById('provider-setup-panel')!.parentElement;while(p){if(p.tagName==='DETAILS')(p as HTMLDetailsElement).open=true;p=p.parentElement;}
 });
 await page.waitForFunction(()=>!(document.getElementById('provider-setup-refresh') as HTMLButtonElement).disabled);
 assert.deepEqual(await page.evaluate(()=>(window as any).calls),[{action:'status',provider:'codex'}]);assert.equal(await page.locator('#provider-login-gate').isVisible(),true);
 assert.equal(await page.locator('#provider-login-codex').getAttribute('aria-pressed'),'true');
 assert.equal(await page.locator('#provider-login-claude').getAttribute('aria-pressed'),'false');
 await page.locator('#provider-login-claude').click();
 await page.waitForFunction(()=>(window as any).calls.length===2&&!(document.getElementById('provider-setup-refresh') as HTMLButtonElement).disabled);
 assert.equal(await page.locator('#provider-login-claude').getAttribute('aria-pressed'),'true');
 assert.equal(await page.locator('#provider-login-codex').getAttribute('aria-pressed'),'false');
 await page.locator('#provider-login-codex').click();
 await page.waitForFunction(()=>(window as any).calls.length===3&&!(document.getElementById('provider-setup-refresh') as HTMLButtonElement).disabled);
 assert.equal(await page.locator('#provider-login-codex').getAttribute('aria-pressed'),'true');
 assert.deepEqual(await page.evaluate(()=>(window as any).calls.map((v:any)=>v.action)),['status','status','status']);
 assert.equal(await page.locator('#codex-composer').isVisible(),false,'Signed-out gate hides unavailable chat actions.');
 await page.locator('#codex-composer').evaluate((input:HTMLTextAreaElement)=>{input.value='Keep my unsent draft';}); // A previously restored draft, not signed-out user typing.
 await page.locator('#provider-setup-refresh').evaluate((b:HTMLElement)=>b.click());assert.equal(await page.evaluate(()=>(window as any).calls.length),3);
 const exposePane=async(id:string)=>page.evaluate((id:string)=>{for(const pane of document.querySelectorAll<HTMLElement>('[data-settings-section]'))pane.hidden=pane.id!==id;const d=document.getElementById('settings-drawer') as HTMLDialogElement;if(!d.open)d.showModal();},id);
 await exposePane('workspace-settings');await page.locator('#provider-setup-refresh').click();await page.waitForFunction(()=>(window as any).calls.length===4);assert.match(await page.locator('#provider-setup-status').innerText(),/Sign in with ChatGPT/);
 await page.locator('#provider-setup-login').click();await page.waitForFunction(()=>(window as any).calls.length===5);
 await page.evaluate(()=>Object.assign((window as any).providerFixtureState,{installed:false,auth:'unknown',cliVersion:null}));
 await page.locator('#provider-setup-refresh').click();await page.waitForFunction(()=>(window as any).calls.length===6);
 await exposePane('settings-connections');await page.locator('#provider-setup-install').click();await page.waitForFunction(()=>(window as any).calls.length===7);
 await page.evaluate(()=>{(document.getElementById('settings-drawer') as HTMLDialogElement).close();const w=window as any;w.account={connected:true,ready:true,fresh:true,auth:'subscription'};w.subscriber();});assert.equal(await page.locator('#provider-login-gate').isVisible(),false);
 assert.equal(await page.locator('#codex-composer').inputValue(),'Keep my unsent draft');assert.deepEqual(await page.evaluate(()=>(window as any).calls.map((v:any)=>v.action)),['status','status','status','status','login','status','install']);assert.deepEqual(errors,[]);
 // Fresh native authentication does not silently reuse a stale signed-out client.
 await page.evaluate(()=>{const w=window as any;w.account={connected:true,ready:true,fresh:true,auth:'signed-out'};Object.assign(w.providerFixtureState,{installed:true,auth:'subscription',cliVersion:'1.0.0'});w.sessionActions=[];
 const disconnect=document.getElementById('codex-disconnect') as HTMLButtonElement,connect=document.getElementById('codex-connect') as HTMLButtonElement;disconnect.disabled=false;connect.disabled=true;
 disconnect.addEventListener('click',()=>{w.sessionActions.push('disconnect');w.account={connected:false,ready:false,fresh:true,auth:'unknown'};connect.disabled=false;disconnect.disabled=true;w.subscriber();});connect.addEventListener('click',()=>w.sessionActions.push('connect'));w.subscriber();});
 await exposePane('workspace-settings');await page.locator('#provider-setup-refresh').click();await page.waitForFunction(()=>(window as any).calls.length===8);
 await page.evaluate(()=>(document.getElementById('settings-drawer') as HTMLDialogElement).close());assert.match(await page.locator('#provider-login-start').innerText(),/Disconnect old session/);assert.deepEqual(await page.evaluate(()=>(window as any).sessionActions),[]);
 await page.locator('#provider-login-start').click();assert.deepEqual(await page.evaluate(()=>(window as any).sessionActions),['disconnect']);
 await page.locator('#provider-login-start').click();assert.deepEqual(await page.evaluate(()=>(window as any).sessionActions),['disconnect','connect']);assert.equal(await page.evaluate(()=>(window as any).calls.length),8);
 assert.equal(await page.locator('#codex-composer').inputValue(),'Keep my unsent draft');
 await page.evaluate(()=>{const w=window as any;w.controller.stop();w.controller.resume();});await page.waitForFunction(()=>(window as any).calls.length===9);assert.equal(await page.evaluate(()=>(window as any).calls.length),9);
});
