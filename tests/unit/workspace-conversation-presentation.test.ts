/// <reference lib="dom" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { startWorkspaceShell } from '../../apps/desktop/src/workspace-shell.js';

class Node extends EventTarget {
  children:Node[]=[];private attributes=new Map<string,string>();
  constructor(readonly tagName:string){super();}
  setAttribute(name:string,value:string){this.attributes.set(name,value);}
  getAttribute(name:string){return this.attributes.get(name)??null;}
  hasAttribute(name:string){return this.attributes.has(name);}
  removeAttribute(name:string){this.attributes.delete(name);}
  get open(){return this.hasAttribute('open');}
  activate(owner:Node){const event=new Event('click',{cancelable:true});this.dispatchEvent(event);if(!event.defaultPrevented){if(owner.open)owner.removeAttribute('open');else owner.setAttribute('open','');}return event;}
}
test('the primary conversation restores open on mount and heading activation cannot hide its composer',()=>{
  const panel=new Node('DETAILS'),heading=new Node('SUMMARY'),nested=new Node('DETAILS'),nestedHeading=new Node('SUMMARY');
  panel.children=[heading,nested];nested.children=[nestedHeading];
  const doc=Object.assign(new EventTarget(),{querySelectorAll:()=>[],getElementById:(id:string)=>id==='codex-panel'?panel:null});
  const shell=startWorkspaceShell(doc as unknown as Document);
  assert.equal(panel.open,true);
  for(let i=0;i<3;i++){assert.equal(heading.activate(panel).defaultPrevented,true);assert.equal(panel.open,true);}
  assert.equal(nestedHeading.activate(nested).defaultPrevented,false);assert.equal(nested.open,true);
  nestedHeading.activate(nested);assert.equal(nested.open,false);
  shell.cleanup();assert.equal(heading.activate(panel).defaultPrevented,false);assert.equal(panel.open,false);
});

const browserModule=process.env.ARCANE_UI_BROWSER_MODULE;
test('real browser mouse, Enter and Space keep the main chat open across Preview and preserve nested disclosures',
  {skip:!browserModule,timeout:45_000},async t=>{
  const build=resolve(process.env.ARCANE_UI_BUILD_DIR??'dist');
  const [source,css,shell]=await Promise.all([
    readFile('apps/desktop/public/studio.html','utf8'),readFile('apps/desktop/public/studio.css','utf8'),
    readFile(resolve(build,'apps/desktop/src/workspace-shell.js'),'utf8')]);
  const html=source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace('</body>','<script type="module" src="/fixture.js"></script></body>');
  const bootstrap=`import {startWorkspaceShell} from '/workspace-shell.js';
    document.getElementById('workspace-stage').classList.remove('provider-required');document.getElementById('provider-login-gate').hidden=true;
    document.getElementById('codex-messages').innerHTML='<article class="codex-message human"><pre>Preserved fixture message</pre><details id="fixture-message-details"><summary>Message details</summary><p>Fixture metadata</p></details></article>';
    document.getElementById('codex-composer').value=${JSON.stringify('Exact preserved draft\nwith trailing spaces.  ')};
    window.shell=startWorkspaceShell(document);window.ready=true;`;
  const server=createServer((req,res)=>{
    const path=new URL(req.url??'/','http://127.0.0.1').pathname;
    const body=path==='/'?html:path==='/studio.css'?css:path==='/workspace-shell.js'?shell:path==='/fixture.js'?bootstrap:'';
    res.writeHead(body?200:404,{'Content-Type':path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html'});res.end(body);
  });
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));t.after(()=>{server.closeAllConnections();return new Promise<void>(done=>server.close(()=>done()));});
  const playwright=await import(browserModule!),browser=await playwright.chromium.launch({headless:true,args:['--disable-gpu'],
    executablePath:process.env.ARCANE_UI_BROWSER_EXE??'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
  t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:979,height:991}}),errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  await page.goto('http://127.0.0.1:'+address.port);await page.waitForFunction(()=>Boolean((window as unknown as {ready?:boolean}).ready));
  const check=async()=>{
    assert.equal(await page.locator('#codex-panel').getAttribute('open'),'');assert.equal(await page.locator('#codex-composer').isVisible(),true);
    assert.equal(await page.locator('#codex-composer').inputValue(),'Exact preserved draft\nwith trailing spaces.  ');
    assert.match(await page.locator('#codex-messages').textContent()??'',/Preserved fixture message/);
  };
  await page.locator('#codex-panel>summary').click();await check();
  for(const key of ['Enter','Space']){await page.locator('#codex-panel>summary').focus();await page.keyboard.press(key);await check();}
  await page.locator('#fixture-message-details>summary').click();assert.equal(await page.locator('#fixture-message-details').getAttribute('open'),'');
  await page.locator('#fixture-message-details>summary').click();assert.equal(await page.locator('#fixture-message-details').getAttribute('open'),null);
  await page.locator('#workspace-preview-toggle').click();await page.locator('#workspace-preview-close').click();await check();
  await page.evaluate(()=>{document.getElementById('codex-panel')!.removeAttribute('open');const state=window as unknown as {shell:{cleanup():void}};state.shell.cleanup();});
  await page.evaluate(async()=>{const path='/workspace-shell.js';(window as unknown as {shell:unknown}).shell=(await import(path)).startWorkspaceShell(document);});await check();
  assert.deepEqual(errors,[]);
});
