import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

test('real browser update banner waits for draft saving, handles refusal, ignores synthetic clicks and stops stale polling',
  {skip:!process.env.ARCANE_UI_BROWSER_MODULE,timeout:45000},async t=>{
    const {chromium}=await import(pathToFileURL(resolve(process.env.ARCANE_UI_BROWSER_MODULE!)).href);
    const browser=await chromium.launch({headless:true,executablePath:process.env.ARCANE_UI_BROWSER_EXE});t.after(()=>browser.close());
    const module=await readFile(resolve(process.env.ARCANE_UI_BUILD_DIR??'dist','apps/desktop/src/desktop-update.js'));
    const css=await readFile('apps/desktop/public/studio.css');
    const html=`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/studio.css"><main class="app-main"><textarea id="draft">Draft</textarea></main>
      <script>window.fixture={status:'current',reads:0,restarts:0,saves:0,error:null,hold:false,reply:{state:'refused',message:'Try again.'}};
      window.arcaneDesktop={updates:{status:async()=>{fixture.reads++;if(fixture.readGate)await new Promise(resolve=>fixture.releaseRead=resolve);return {version:1,state:fixture.status,buildId:'a'.repeat(64)+'-11111111-2222-4333-8444-555555555555',message:'Ready'};},
      restart:async()=>{fixture.restarts++;return fixture.reply;}}};</script>
      <script type="module">import {startDesktopUpdates} from '/desktop-update.js';window.controller=startDesktopUpdates(document,{pollMs:100,beforeRestart:async()=>{fixture.saves++;if(fixture.hold)await new Promise(resolve=>fixture.releaseSave=resolve);if(fixture.error)throw Error(fixture.error);}});window.ready=true;</script>`;
    const server=createServer((request,response)=>{const path=request.url;response.setHeader('Content-Type',path==='/desktop-update.js'?'text/javascript':path==='/studio.css'?'text/css':'text/html');response.end(path==='/desktop-update.js'?module:path==='/studio.css'?css:html);});
    await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));t.after(()=>new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done())));
    const origin='http://127.0.0.1:'+(server.address() as {port:number}).port,page=await browser.newPage({viewport:{width:1100,height:720}});
    const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));await page.goto(origin);await page.waitForFunction(()=>!!(window as any).ready);
    const banner=page.locator('#desktop-update-banner'),button=banner.locator('button');
    await page.waitForTimeout(150);assert.equal(await banner.isVisible(),false);
    await page.evaluate(async()=>{(window as any).fixture.status='available';await (window as any).controller.check();});assert.equal(await banner.isVisible(),true);
    if(process.env.ARCANE_UI_SCREENSHOT)await page.screenshot({path:process.env.ARCANE_UI_SCREENSHOT+'.desktop-update.png'});
    await button.evaluate((node:HTMLButtonElement)=>node.click());assert.equal(await page.evaluate(()=>(window as any).fixture.restarts),0,'Synthetic click never restarts.');
    await page.evaluate(()=>{(window as any).fixture.hold=true;});await button.click();assert.equal(await button.isDisabled(),true);
    assert.equal(await page.evaluate(()=>!!document.querySelector('#draft')?.closest('[inert]')),true);
    assert.equal(await page.evaluate(()=>(window as any).fixture.restarts),0,'Saving finishes before host restart is called.');
    await page.evaluate(()=>{(window as any).fixture.releaseSave();});await page.waitForFunction(()=>(window as any).fixture.restarts===1);
    await page.waitForFunction(()=>document.getElementById('desktop-update-banner')?.textContent?.includes('Try again.'));
    assert.equal(await page.evaluate(()=>!!document.querySelector('#draft')?.closest('[inert]')),false);
    await page.evaluate(()=>{(window as any).fixture.hold=false;(window as any).fixture.error='Your draft could not be saved.';});await button.click();
    await page.waitForFunction(()=>document.getElementById('desktop-update-banner')?.textContent?.includes('draft could not be saved'));
    assert.equal(await page.evaluate(()=>(window as any).fixture.restarts),1,'A failed save leaves the app running.');
    await page.evaluate(()=>{(window as any).fixture.error=null;(window as any).fixture.reply={state:'refused',message:'<img src=x onerror=alert(1)>'};});await button.click();
    await page.waitForFunction(()=>(window as any).fixture.restarts===2);assert.equal(await banner.locator('img').count(),0);
    await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    if(process.env.ARCANE_UI_SCREENSHOT)await page.screenshot({path:process.env.ARCANE_UI_SCREENSHOT+'.desktop-update-mobile.png'});
    // The in-flight old observation cannot make a stopped controller show a banner again.
    await page.evaluate(()=>{(window as any).fixture.readGate=true;void (window as any).controller.check();});
    await page.waitForFunction(()=>!!(window as any).fixture.releaseRead);await page.evaluate(()=>{(window as any).controller.stop();(window as any).fixture.releaseRead();});
    await page.waitForTimeout(200);assert.equal(await banner.isVisible(),false);
    const reads=await page.evaluate(()=>(window as any).fixture.reads);await page.waitForTimeout(200);assert.equal(await page.evaluate(()=>(window as any).fixture.reads),reads);
    await page.evaluate(()=>{(window as any).fixture.readGate=false;(window as any).controller.resume();});await page.waitForFunction(()=>!document.getElementById('desktop-update-banner')?.hidden);
    await page.evaluate(()=>{(window as any).fixture.reply={state:'restarting',message:'Restarting Arcane…'};});await button.click();
    await page.waitForFunction(()=>document.getElementById('desktop-update-banner')?.textContent?.includes('Restarting Arcane'));
    assert.equal(await button.isVisible(),false);await page.evaluate(()=>(window as any).controller.stop());assert.deepEqual(errors,[]);
  });
