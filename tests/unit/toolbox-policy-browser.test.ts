import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const browserModule=process.env.ARCANE_UI_BROWSER_MODULE;
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
