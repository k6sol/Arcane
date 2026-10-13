/// <reference lib="dom" />
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Page } from 'playwright-core';

const enabled = !!process.env.ARCANE_UI_BROWSER_MODULE;
async function fixture(t: TestContext) {
  const build = process.env.ARCANE_UI_BUILD_DIR; assert.ok(build, 'Explicit private output required');
  const html = (await readFile(resolve('apps/desktop/public/studio.html'),'utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'');
  const files = new Map([
    ['/studio.css', [resolve('apps/desktop/public/studio.css'), 'text/css']],
    ['/provider-setup.js', [join(build,'apps/desktop/src/provider-setup.js'), 'text/javascript']],
  ]);
  const unexpected: string[] = [], errors: string[] = [];
  const server = createServer((req,res)=>{void(async()=>{
    const path = new URL(req.url??'/','http://fixture').pathname;
    assert.equal(req.method,'GET','Provider bridge is synthetic; no native or inference HTTP is permitted');
    if(path==='/fixture'){res.writeHead(200,{'Content-Type':'text/html'});res.end(html);return;}
    const file=files.get(path);
    if(!file){if(path!=='/favicon.ico')unexpected.push(path);res.writeHead(404);res.end();return;}
    res.writeHead(200,{'Content-Type':file[1]!});res.end(await readFile(file[0]!));
  })().catch(error=>{errors.push(String(error));res.destroy();});});
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));});
  const {chromium}=await import(pathToFileURL(resolve(process.env.ARCANE_UI_BROWSER_MODULE!)).href) as typeof import('playwright-core');
  const browser=await chromium.launch({headless:true,executablePath:process.env.ARCANE_UI_BROWSER_EXE!,args:['--disable-gpu']});
  t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  page.on('pageerror',error=>errors.push(error.message));
  const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
  await page.route('**/*',async route=>{if(new URL(route.request().url()).origin===origin)await route.continue();else{unexpected.push(route.request().url());await route.abort();}});
  await page.goto(origin+'/fixture');
  await page.clock.install({time:new Date('2026-10-13T17:23:00Z')});
  await page.clock.pauseAt(new Date('2026-10-13T17:23:01Z'));
  await page.evaluate(async()=>{
    const path:string='/provider-setup.js',m=await import(path),w=window as any;
    w.calls=[];w.effects=[];w.connection={fresh:true,connected:false,ready:false,auth:'unknown'};w.listener=()=>{};
    w.nativeState={version:1,provider:'codex',installed:true,auth:'unknown',cliVersion:'0.143.0',busy:true,message:null};
    w.failure=false;w.hold=false;w.release=null;
    const bridge=Object.freeze({version:1,...Object.fromEntries(['status','login','install','launch'].map(action=>[action,async(provider:string)=>{
      w.calls.push({action,provider,time:Date.now()});
      if(w.hold)await new Promise<void>(done=>{w.release=done;});
      if(w.failure)throw new Error('fixture-private-error');
      return {...w.nativeState,provider};
    }]))});
    const connect=document.getElementById('codex-connect') as HTMLButtonElement;connect.disabled=false;
    connect.addEventListener('click',()=>w.effects.push('connect'));
    for(const id of ['codex-disconnect','codex-thread-start','codex-thread-resume','codex-submit','codex-grant','codex-assets-grant'])
      document.getElementById(id)!.addEventListener('click',()=>w.effects.push(id));
    w.controller=m.startProviderSetup(document,{nativeBridge:bridge,chat:{providerConnectionStatus:()=>w.connection,subscribeProviderStateChange:(fn:()=>void)=>{w.listener=fn;return()=>{w.listener=()=>{};};}}});
    // Same lifecycle hooks as the production Studio bootstrap; resume never probes.
    window.addEventListener('pagehide',()=>w.controller.stop());
    window.addEventListener('pageshow',event=>{if(event.persisted)w.controller.resume();});
  });
  await page.locator('#codex-composer').fill('Retain unsent draft 🧩\n  ');
  t.after(async()=>{assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);});
  t.diagnostic('Real Edge '+browser.version()+'; private production provider module; exact 2000 ms virtual clock; zero native operations');
  return page;
}
const view=(page:Page)=>page.evaluate(()=>({calls:(window as any).calls,effects:(window as any).effects}));
const set=(page:Page,values:Record<string,unknown>)=>page.evaluate(values=>Object.assign((window as any).nativeState,values),values);
const advance=(page:Page,ms=2000)=>page.clock.runFor(ms);
const settled=(page:Page)=>page.waitForFunction(()=>document.getElementById('provider-login-gate')?.getAttribute('aria-busy')==='false');

test('explicit login alone starts a 2-second watcher; only final native subscription ACK connects metadata once',{skip:!enabled,timeout:30000},async t=>{
  const page=await fixture(t);assert.deepEqual(await view(page),{calls:[],effects:[]});
  await page.locator('#provider-login-start').evaluate((button:HTMLElement)=>button.click());assert.deepEqual(await view(page),{calls:[],effects:[]});
  await page.locator('#provider-login-start').click();await settled(page);
  assert.deepEqual((await view(page)).calls.map((call:any)=>call.action),['login']);
  assert.equal(await page.locator('#provider-login-refresh').isVisible(),false);
  await advance(page,1999);assert.equal((await view(page)).calls.length,1);
  await advance(page,1);await settled(page);assert.equal((await view(page)).calls.length,2);
  assert.equal((await view(page)).calls[1].time-(await view(page)).calls[0].time,2000);
  await page.locator('#provider-login-start').click();await settled(page);
  assert.deepEqual((await view(page)).calls.map((call:any)=>call.action),['login','status','status'],'Pending status never makes another sign-in');
  await set(page,{auth:'subscription',busy:true});await advance(page);await settled(page);assert.deepEqual((await view(page)).effects,[]);
  await set(page,{auth:'subscription',busy:false});await advance(page);await settled(page);
  assert.deepEqual((await view(page)).effects,['connect']);await advance(page,10000);assert.deepEqual((await view(page)).effects,['connect']);
  assert.equal(await page.locator('#codex-composer').inputValue(),'Retain unsent draft 🧩\n  ');
});

test('mount, preference restoration, cached status and resume never start login, polling or automatic connect',{skip:!enabled,timeout:30000},async t=>{
  const page=await fixture(t);
  await page.evaluate(()=>{document.dispatchEvent(new CustomEvent('workspace:providerpreference',{detail:{provider:'claude'}}));document.dispatchEvent(new CustomEvent('workspace:providerpreference',{detail:{provider:'codex'}}));(window as any).controller.resume();});
  await advance(page,100000);assert.deepEqual(await view(page),{calls:[],effects:[]});
  await set(page,{auth:'subscription',busy:false});
  await page.evaluate(()=>{const d=document.getElementById('settings-drawer') as HTMLDialogElement;d.showModal();});
  await page.locator('#provider-setup-refresh').click();await settled(page);await advance(page,10000);
  assert.deepEqual((await view(page)).calls.map((call:any)=>call.action),['status']);assert.deepEqual((await view(page)).effects,[]);
  await page.evaluate(()=>{(window as any).controller.stop();(window as any).controller.resume();});await advance(page,10000);
  assert.deepEqual((await view(page)).calls.map((call:any)=>call.action),['status']);assert.deepEqual((await view(page)).effects,[]);
});

test('login completion never disconnects an old client or connects through a disabled native control',{skip:!enabled,timeout:30000},async t=>{
  const page=await fixture(t);
  await page.evaluate(()=>{(window as any).connection={fresh:true,connected:true,ready:true,auth:'signed-out'};});
  await page.locator('#provider-login-start').click();await settled(page);await set(page,{auth:'subscription',busy:false});await advance(page);await settled(page);
  assert.deepEqual((await view(page)).effects,[]);assert.match(await page.locator('#provider-login-start').innerText(),/Disconnect old session/);
  await page.evaluate(()=>{const w=window as any;w.controller.stop();w.controller.resume();w.connection={fresh:true,connected:false,ready:false,auth:'unknown'};(document.getElementById('codex-connect') as HTMLButtonElement).disabled=true;w.listener();});
  await set(page,{auth:'unknown',busy:true});await page.locator('#provider-login-start').click();await settled(page);
  await set(page,{auth:'subscription',busy:false});await advance(page);await settled(page);assert.deepEqual((await view(page)).effects,[]);
});

test('provider A-B-A and pagehide/cleanup discard held status replies and cancel every future watcher',{skip:!enabled,timeout:30000},async t=>{
  const page=await fixture(t);
  for(const lifecycle of ['provider','pagehide','cleanup']){
    await page.evaluate(()=>{const w=window as any;w.controller.stop();w.controller.resume();w.hold=false;});
    await set(page,{auth:'unknown',busy:true});await page.locator('#provider-login-start').click();await settled(page);
    await page.evaluate(()=>{(window as any).hold=true;});await advance(page);
    await page.waitForFunction(()=>typeof (window as any).release==='function');
    await page.evaluate(lifecycle=>{const w=window as any;
      if(lifecycle==='provider'){document.dispatchEvent(new CustomEvent('workspace:providerpreference',{detail:{provider:'claude'}}));document.dispatchEvent(new CustomEvent('workspace:providerpreference',{detail:{provider:'codex'}}));}
      else if(lifecycle==='pagehide'){window.dispatchEvent(new PageTransitionEvent('pagehide'));window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));}
      else w.controller.cleanup();
      w.nativeState.auth='subscription';w.nativeState.busy=false;w.hold=false;w.release();w.release=null;
    },lifecycle);
    if(lifecycle!=='cleanup')await settled(page);
    else await page.evaluate(async()=>{await Promise.resolve();await Promise.resolve();});
    const count=(await view(page)).calls.length;await advance(page,10000);
    assert.equal((await view(page)).calls.length,count);assert.deepEqual((await view(page)).effects,[]);
  }
});

test('failed or malformed watcher replies stop polling and never imply authentication or connect',{skip:!enabled,timeout:30000},async t=>{
  const page=await fixture(t);
  for(const invalid of ['error','schema']){
    await page.evaluate(()=>{const w=window as any;w.controller.stop();w.controller.resume();w.failure=false;});
    await set(page,{auth:'unknown',busy:true});await page.locator('#provider-login-start').click();await settled(page);
    if(invalid==='error')await page.evaluate(()=>{(window as any).failure=true;});else await set(page,{auth:'subscription',busy:false,token:'fixture-credential'});
    await advance(page);await settled(page);const count=(await view(page)).calls.length;await advance(page,10000);
    assert.equal((await view(page)).calls.length,count);assert.deepEqual((await view(page)).effects,[]);
    assert.match(await page.locator('#provider-login-message').innerText(),/Setup unavailable/);
  }
});

test('pending login status watcher has an exact 450-poll cap without extending production timing',{skip:!enabled,timeout:30000},async t=>{
  const page=await fixture(t);await page.locator('#provider-login-start').click();await settled(page);
  for(let i=0;i<450;i++){await advance(page);await settled(page);}
  assert.equal((await view(page)).calls.length,451);assert.equal((await view(page)).calls.filter((call:any)=>call.action==='status').length,450);
  await advance(page,100000);assert.equal((await view(page)).calls.length,451);assert.deepEqual((await view(page)).effects,[]);
});
