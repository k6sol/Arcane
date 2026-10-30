import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const browserModule=process.env.ARCANE_UI_BROWSER_MODULE;
test('real trusted Models gesture permits one typed message; manual polls, synthetic changes and selection ABA cannot re-arm it',{skip:!browserModule,timeout:30000},async t=>{
  const writes:{sessionId:string;allowModels?:boolean}[]=[],choices=new Map([['session-a',true],['session-b',false]]);
  const script=await readFile(resolve(process.env.ARCANE_UI_BUILD_DIR??'dist','apps/desktop/src/toolbox-policy.js'));
  const server=createServer((request,response)=>{void(async()=>{
    const send=(value:unknown)=>{response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify(value));};
    if(request.url==='/toolbox-policy.js'){response.writeHead(200,{'Content-Type':'text/javascript'});response.end(script);return;}
    if(request.url==='/v1/studio-native/toolbox-policy'){
      assert.equal(request.headers.authorization,'Bearer owned-human-fixture');const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8')) as {sessionId:string;allowModels?:boolean};writes.push(body);
      if(typeof body.allowModels==='boolean')choices.set(body.sessionId,body.allowModels);send({sessionId:body.sessionId,allowModels:choices.get(body.sessionId)??false});return;
    }
    response.writeHead(200,{'Content-Type':'text/html'});response.end(`<select id="session-picker"><option value="session-a">A</option><option value="session-b">B</option></select><input id="toolbox-models-allow" type="checkbox" disabled><button id="toolbox-models-revoke" hidden disabled>Turn off Toolbox access</button><p id="toolbox-models-status"></p><button id="send">Send typed message</button><script type="module">
      import {startToolboxPolicy} from '/toolbox-policy.js';
      let revision=0;const sent=[];const policy=startToolboxPolicy(document,{token:()=>'owned-human-fixture',context:()=>({provider:'codex',projectPath:'fixture-project',localId:'original-local-draft',fingerprint:'original brief:'+revision})});
      document.getElementById('send').addEventListener('click',()=>{const ticket=policy.consent.capture(),admission=ticket?.consume();sent.push(admission?.scope??null);});
      window.fixture={policy,sent,replace(){revision++;policy.refreshContext();}};
    </script>`);
  })().catch(()=>{response.writeHead(500);response.end();});});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());}));
  const playwright=await import(pathToFileURL(resolve(browserModule!)).href),browser=await playwright.chromium.launch({headless:true,...(process.env.ARCANE_UI_BROWSER_EXE?{executablePath:process.env.ARCANE_UI_BROWSER_EXE}:{})});
  t.after(()=>browser.close());const page=await browser.newPage();await page.goto('http://127.0.0.1:'+(server.address() as {port:number}).port);
  const box=page.locator('#toolbox-models-allow');await page.waitForFunction(()=>!(document.getElementById('toolbox-models-allow') as HTMLInputElement).disabled);
  assert.equal(await box.isChecked(),false,'a previously enabled manual policy must not arm this message');assert.match(await page.locator('#toolbox-models-status').innerText(),/Manual Toolbox browsing/);
  await page.evaluate(()=>{const box=document.getElementById('toolbox-models-allow') as HTMLInputElement;box.checked=true;box.dispatchEvent(new Event('change',{bubbles:true}));});
  assert.equal(await box.isChecked(),false);assert.equal(writes.filter(value=>Object.hasOwn(value,'allowModels')).length,0);
  await box.check();await page.waitForFunction(()=>document.getElementById('toolbox-models-status')!.textContent!.includes('this typed message only'));
  await page.locator('#send').click();await page.locator('#send').click();
  const sent=()=>page.evaluate(()=>(window as unknown as {fixture:{sent:unknown[]}}).fixture.sent);
  assert.deepEqual(await sent(),[{sessionId:'session-a'},null]);assert.equal(await box.isChecked(),false);
  await page.waitForTimeout(2100);await page.locator('#send').click();assert.deepEqual(await sent(),[{sessionId:'session-a'},null,null],'manual status polling does not restore consumed consent');
  await box.check();await page.waitForFunction(()=>document.getElementById('toolbox-models-status')!.textContent!.includes('this typed message only'));
  await page.evaluate(()=>(window as unknown as {fixture:{replace():void}}).fixture.replace());await page.locator('#send').click();assert.equal((await sent()).at(-1),null);
  await box.check();await page.waitForFunction(()=>document.getElementById('toolbox-models-status')!.textContent!.includes('this typed message only'));
  await page.selectOption('#session-picker','session-b');await page.selectOption('#session-picker','session-a');
  await page.waitForFunction(()=>!(document.getElementById('toolbox-models-allow') as HTMLInputElement).disabled);await page.locator('#send').click();assert.equal((await sent()).at(-1),null);
  assert.equal((await sent()).filter(Boolean).length,1);assert.ok(writes.filter(value=>value.allowModels===true).every(value=>value.sessionId==='session-a'));
  const before=writes.filter(value=>Object.hasOwn(value,'allowModels')).length;
  await page.evaluate(()=>document.getElementById('toolbox-models-revoke')!.dispatchEvent(new Event('click',{bubbles:true})));assert.equal(writes.filter(value=>Object.hasOwn(value,'allowModels')).length,before);
  await page.locator('#toolbox-models-revoke').click();await page.waitForFunction(()=>document.getElementById('toolbox-models-revoke')!.hidden);
  assert.deepEqual(writes.filter(value=>Object.hasOwn(value,'allowModels')).at(-1),{sessionId:'session-a',allowModels:false});assert.equal(choices.get('session-a'),false);
});
test('model source settings: reads never opt in; explicit clicks set the exact selected session; expiry and reconnect return to original models', {skip:!browserModule,timeout:30000},async t=>{
  const seen:{sessionId:string;allowModels?:boolean}[]=[];
  const choices=new Map<string,boolean>();let fail=false;
  const script=await readFile(resolve(process.env.ARCANE_UI_BUILD_DIR??'dist','apps/desktop/src/toolbox-policy.js'));
  const server=createServer((request,response)=>{void(async()=>{
    const send=(value:unknown,status=200)=>{response.writeHead(status,{'Content-Type':'application/json'});response.end(JSON.stringify(value));};
    if(request.url==='/toolbox-policy.js'){response.writeHead(200,{'Content-Type':'text/javascript'});response.end(script);return;}
    if(request.url==='/v1/studio-native/toolbox-policy'){
      assert.equal(request.headers.authorization,'Bearer owned-human-fixture');assert.equal(request.method,'POST');
      const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));seen.push(body);
      if(fail){send({error:'UNAVAILABLE'},503);return;}
      if(typeof body.allowModels==='boolean')choices.set(body.sessionId,body.allowModels);
      send({sessionId:body.sessionId,allowModels:choices.get(body.sessionId)??false});return;
    }
    response.writeHead(200,{'Content-Type':'text/html'});response.end('<select id="session-picker"><option value="session-a">A</option><option value="session-b">B</option></select><input id="toolbox-models-allow" type="checkbox" disabled><p id="toolbox-models-status"></p><script type="module">import {startToolboxPolicy} from "/toolbox-policy.js";window.policy=startToolboxPolicy(document,{token:()=>"owned-human-fixture"});</script>');
  })().catch(()=>{response.writeHead(500);response.end();});});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise<void>(r=>{server.closeAllConnections();server.close(()=>r());}));
  const playwright=await import(pathToFileURL(resolve(browserModule!)).href);
  const browser=await playwright.chromium.launch({headless:true,...(process.env.ARCANE_UI_BROWSER_EXE?{executablePath:process.env.ARCANE_UI_BROWSER_EXE}:{})});
  t.after(()=>browser.close());const page=await browser.newPage();
  await page.goto('http://127.0.0.1:'+(server.address() as {port:number}).port);
  const checkbox=page.locator('#toolbox-models-allow');await page.waitForFunction(()=>!(document.getElementById('toolbox-models-allow') as HTMLInputElement).disabled);
  assert.equal(await checkbox.isChecked(),false);assert.ok(seen.length>0);assert.ok(seen.every(x=>!Object.hasOwn(x,'allowModels')));
  await checkbox.check();await page.waitForFunction(()=>document.getElementById('toolbox-models-status')!.textContent!.includes('allowed'));
  assert.deepEqual(seen.filter(x=>Object.hasOwn(x,'allowModels')),[{sessionId:'session-a',allowModels:true}]);
  await page.selectOption('#session-picker','session-b');await page.waitForFunction(()=>!(document.getElementById('toolbox-models-allow') as HTMLInputElement).disabled);
  assert.equal(await checkbox.isChecked(),false);assert.equal(choices.get('session-b'),undefined);
  await checkbox.check();await page.waitForFunction(()=>document.getElementById('toolbox-models-status')!.textContent!.includes('allowed'));
  choices.set('session-b',false);await page.waitForFunction(()=>!(document.getElementById('toolbox-models-allow') as HTMLInputElement).checked);
  await page.evaluate(()=>{(window as unknown as {policy:{stop():void;resume():void}}).policy.stop();});
  const writes=seen.filter(x=>Object.hasOwn(x,'allowModels')).length;
  await page.evaluate(()=>{(window as unknown as {policy:{stop():void;resume():void}}).policy.resume();});
  await page.waitForFunction(()=>!(document.getElementById('toolbox-models-allow') as HTMLInputElement).disabled);
  assert.equal(seen.filter(x=>Object.hasOwn(x,'allowModels')).length,writes);
  fail=true;await page.waitForFunction(()=>document.getElementById('toolbox-models-status')!.textContent!.includes('unavailable'));
  assert.equal(await checkbox.isChecked(),false);assert.equal(await checkbox.isDisabled(),true);
});
