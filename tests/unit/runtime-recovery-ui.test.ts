import test from'node:test';import assert from'node:assert/strict';import{readFile}from'node:fs/promises';import{createServer}from'node:http';import{resolve}from'node:path';import{pathToFileURL}from'node:url';
test('Edge recovery checkpoints wait for saves, retain drafts on failure and ignore stale requests',{skip:!process.env.ARCANE_UI_BROWSER_MODULE,timeout:45000},async t=>{
 const{chromium}=await import(pathToFileURL(resolve(process.env.ARCANE_UI_BROWSER_MODULE!)).href);const browser=await chromium.launch({headless:true,executablePath:process.env.ARCANE_UI_BROWSER_EXE});t.after(()=>browser.close());
 const module=await readFile(resolve(process.env.ARCANE_UI_BUILD_DIR??'dist','apps/desktop/src/runtime-recovery.js')),css=await readFile('apps/desktop/public/studio.css');
 const html=`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/studio.css"><main class="app-main"><textarea id="draft">  Keep this draft\n\n🧩  </textarea><button id="send">Send</button></main>
 <script type="module">import{startRuntimeRecovery}from'/runtime-recovery.js';window.fixture={acks:[],retries:0,saves:0,hold:false,fail:false};
 const bridge={ready:async()=>({ready:true}),status:async()=>({version:1,state:'ready',message:''}),retry:async()=>{fixture.retries++;return{requested:true};},acknowledge:async value=>{fixture.acks.push(value);return{acknowledged:true};},onState:listener=>{fixture.state=listener;return()=>fixture.state=null;},onCheckpoint:listener=>{fixture.request=listener;return()=>fixture.request=null;}};
 window.controller=startRuntimeRecovery(document,{bridge,checkpoint:async()=>{fixture.saves++;if(fixture.hold)await new Promise(resolve=>fixture.release=resolve);if(fixture.fail)throw Error('Private provider error');}});window.ready=true;</script>`;
 const server=createServer((request,response)=>{const url=request.url;response.setHeader('content-type',url==='/runtime-recovery.js'?'text/javascript':url==='/studio.css'?'text/css':'text/html');response.end(url==='/runtime-recovery.js'?module:url==='/studio.css'?css:html);});
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));t.after(async()=>{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));});
 const page=await browser.newPage({viewport:{width:1100,height:740}}),errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));await page.goto('http://127.0.0.1:'+(server.address()as{port:number}).port);await page.waitForFunction(()=>!!(window as any).ready);
 const banner=page.locator('#runtime-recovery-banner'),button=banner.locator('button'),draft=await page.locator('#draft').inputValue();assert.equal(await banner.isVisible(),false);
 const emit=async(state:string,message:string)=>page.evaluate(({state,message}:{state:string;message:string})=>(window as any).fixture.state({version:1,state,message}),{state,message});
 const request=async(id:string)=>page.evaluate((id:string)=>(window as any).fixture.request({version:1,requestId:id}),id);
 const one='11111111-2222-4333-8444-555555555555',two='22222222-2222-4333-8444-555555555555',three='33333333-2222-4333-8444-555555555555',four='44444444-2222-4333-8444-555555555555';
 await emit('stopped','Local services stopped.');assert.equal(await banner.isVisible(),true);await button.evaluate((node:HTMLButtonElement)=>node.click());assert.equal(await page.evaluate(()=>(window as any).fixture.retries),0);await button.click();assert.equal(await page.evaluate(()=>(window as any).fixture.retries),1);
 await page.evaluate(()=>(window as any).fixture.hold=true);await emit('saving','Saving drafts…');await request(one);assert.equal(await page.evaluate(()=>!!document.querySelector('#draft')?.closest('[inert]')),true);assert.equal(await page.evaluate(()=>(window as any).fixture.acks.length),0);
 await page.evaluate(()=>(window as any).fixture.release());await page.waitForFunction(()=>(window as any).fixture.acks.length===1);assert.deepEqual(await page.evaluate(()=>(window as any).fixture.acks[0]),{requestId:one,saved:true});
 await emit('starting','Restarting local services…');assert.equal(await page.evaluate(()=>!!document.querySelector('#draft')?.closest('[inert]')),true);await emit('ready','');assert.equal(await banner.isVisible(),false);assert.equal(await page.locator('#draft').inputValue(),draft);assert.equal(await page.evaluate(()=>!!document.querySelector('#draft')?.closest('[inert]')),false);
 await page.evaluate(()=>{(window as any).fixture.hold=false;(window as any).fixture.fail=true;});await request(two);await page.waitForFunction(()=>(window as any).fixture.acks.length===2);assert.equal(await page.evaluate(()=>(window as any).fixture.acks[1].saved),false);assert.match(await banner.innerText(),/could not be saved/);assert.doesNotMatch(await banner.innerText(),/Private/);assert.equal(await page.locator('#draft').inputValue(),draft);assert.equal(await page.evaluate(()=>!!document.querySelector('#draft')?.closest('[inert]')),false);
 await page.evaluate(()=>{(window as any).fixture.hold=true;(window as any).fixture.fail=false;(window as any).fixture.release=null;});await request(three);await page.waitForFunction(()=>!!(window as any).fixture.release);await emit('stopped','Save timed out. Keep this window open.');await page.evaluate(()=>(window as any).fixture.release());await page.waitForTimeout(50);assert.equal(await page.evaluate(()=>(window as any).fixture.acks.length),2,'A timed-out request cannot later acknowledge a save.');
 const saves=await page.evaluate(()=>(window as any).fixture.saves);await request(one);assert.equal(await page.evaluate(()=>(window as any).fixture.saves),saves,'A duplicate nonce never runs the checkpoint again.');
 await emit('stopped','<img src=x onerror=alert(1)>');assert.equal(await banner.locator('img').count(),0);await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.evaluate(()=>(window as any).fixture.release=null);await request(four);await page.waitForFunction(()=>!!(window as any).fixture.release);await page.evaluate(()=>{(window as any).controller.stop();(window as any).fixture.release();});await page.waitForTimeout(50);assert.equal(await page.evaluate(()=>(window as any).fixture.acks.length),2);assert.equal(await banner.isVisible(),false);assert.equal(await page.locator('#draft').inputValue(),draft);assert.deepEqual(errors,[]);
});

test('Edge cached pages reconnect recovery and reject callbacks from the previous lifecycle', {
  skip: !process.env.ARCANE_UI_BROWSER_MODULE, timeout: 60000,
}, async t => {
  const { chromium } = await import(pathToFileURL(resolve(process.env.ARCANE_UI_BROWSER_MODULE!)).href);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.ARCANE_UI_BROWSER_EXE,
    ignoreDefaultArgs: ['--disable-back-forward-cache'] });
  t.after(() => browser.close());
  const module = await readFile(resolve(process.env.ARCANE_UI_BUILD_DIR ?? 'dist', 'apps/desktop/src/runtime-recovery.js'));
  const studio = (await readFile('apps/desktop/src/studio.ts', 'utf8')).replaceAll('\r\n', '\n');
  const begin = studio.indexOf("window.addEventListener('pagehide',()=>recovery?.stop());");
  const end = studio.indexOf('\n  }', begin);
  assert.ok(begin >= 0 && end > begin, 'Use the production recovery lifecycle wiring.');
  const lifecycle = studio.slice(begin, end);
  const html = `<!doctype html><main class="app-main"><textarea id="draft"></textarea><button id="send">Send</button></main>
  <script type="module">
    import { startRuntimeRecovery } from '/runtime-recovery.js';
    const f = window.fixture = { id: crypto.randomUUID(), shows: [], hides: [], states: new Set(), requests: new Set(),
      oldStates: [], oldRequests: [], removed: 0, reads: 0, saves: 0, acks: [], retries: 0,
      status: {version: 1, state: 'ready', message: ''}, statusWaits: [], retryWaits: [], readyWaits: [] };
    const bridge = {
      status: async () => { f.reads++; return f.holdStatus ? new Promise(resolve => f.statusWaits.push(resolve)) : f.status; },
      retry: async () => { f.retries++; return f.holdRetry ? new Promise((resolve, reject) => f.retryWaits.push({resolve, reject})) : {requested: true}; },
      ready: async () => f.holdReady ? new Promise(resolve => f.readyWaits.push(resolve)) : {ready: true},
      acknowledge: async value => { f.acks.push(value); return {acknowledged: true}; },
      onState: fn => { f.states.add(fn); f.oldStates.push(fn); return () => { f.states.delete(fn); f.removed++; }; },
      onCheckpoint: fn => { f.requests.add(fn); f.oldRequests.push(fn); return () => { f.requests.delete(fn); f.removed++; }; },
    };
    f.emit = (state, message) => { for (const fn of f.states) fn({version: 1, state, message}); };
    f.request = requestId => { for (const fn of f.requests) fn({version: 1, requestId}); };
    const recovery = window.controller = startRuntimeRecovery(document, {bridge, checkpoint: async () => {
      f.saves++; if (f.holdSave) await new Promise(resolve => f.releaseSave = resolve);
    }});
    ${lifecycle}
    window.addEventListener('pageshow', event => f.shows.push(event.persisted));
    window.addEventListener('pagehide', event => f.hides.push(event.persisted));
    window.ready = true;
  </script>`;
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/runtime-recovery.js' ? 'text/javascript' : 'text/html');
    res.end(req.url === '/runtime-recovery.js' ? module : req.url === '/other' ? '<title>Another page</title>' : html);
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
  const origin = 'http://127.0.0.1:' + (server.address() as {port: number}).port;
  const page = await browser.newPage(), errors: string[] = [];
  page.on('pageerror', (error: Error) => errors.push(error.message));
  await page.goto(origin); await page.waitForFunction(() => (window as any).ready);
  const id = await page.evaluate(() => (window as any).fixture.id), draft = '  Keep this draft\n\n\u{1f9e9}  ';
  await page.locator('#draft').fill(draft);
  await page.evaluate(() => (window as any).fixture.status = {version: 1, state: 'stopped', message: 'Fresh service status.'});
  await page.goto(origin + '/other'); await page.goBack({waitUntil: 'commit'});
  await page.waitForFunction(() => (window as any).fixture?.shows.includes(true));
  assert.equal(await page.evaluate(() => (window as any).fixture.id), id, 'The document was actually restored from browser cache.');
  assert.deepEqual(await page.evaluate(() => (window as any).fixture.hides), [true]);
  const banner = page.locator('#runtime-recovery-banner'), button = banner.locator('button');
  await page.waitForFunction(() => (window as any).fixture.reads === 2);
  assert.match(await banner.innerText(), /Fresh service status/);
  assert.equal(await page.locator('#draft').inputValue(), draft);
  assert.deepEqual(await page.evaluate(() => { const f = (window as any).fixture; return [f.states.size, f.requests.size, f.removed]; }), [1, 1, 2]);
  await page.evaluate(() => { (window as any).controller.resume(); (window as any).controller.resume(); });
  assert.equal(await page.evaluate(() => (window as any).fixture.reads), 2, 'Repeated resume does not duplicate subscriptions or status reads.');
  const one = '11111111-2222-4333-8444-555555555555', two = '22222222-2222-4333-8444-555555555555';
  await page.evaluate((requestId: string) => { const f = (window as any).fixture;
    f.oldStates[0]({version: 1, state: 'starting', message: 'Old callback.'}); f.oldRequests[0]({version: 1, requestId});
  }, one);
  assert.match(await banner.innerText(), /Fresh service status/);
  assert.equal(await page.evaluate(() => (window as any).fixture.saves), 0);
  await page.evaluate((requestId: string) => { const f = (window as any).fixture; f.holdSave = true; f.request(requestId); }, one);
  await page.waitForFunction(() => !!(window as any).fixture.releaseSave);
  await page.evaluate(() => { const f = (window as any).fixture; (window as any).controller.stop(); (window as any).controller.stop(); (window as any).controller.resume(); f.releaseSave(); });
  await page.waitForFunction(() => (window as any).fixture.reads === 3);
  await page.waitForTimeout(20);
  assert.equal(await page.evaluate(() => (window as any).fixture.acks.length), 0, 'A save from before pagehide cannot acknowledge after resume.');
  await page.evaluate((requestId: string) => (window as any).fixture.request(requestId), one);
  assert.equal(await page.evaluate(() => (window as any).fixture.saves), 1, 'A seen nonce is not replayed by the resumed listener.');
  await page.evaluate((requestId: string) => { const f = (window as any).fixture; f.holdSave = false; f.request(requestId); }, two);
  await page.waitForFunction(() => (window as any).fixture.acks.length === 1);
  assert.deepEqual(await page.evaluate(() => (window as any).fixture.acks[0]), {requestId: two, saved: true});
  await page.evaluate(() => {
    const f = (window as any).fixture; f.holdStatus = true;
    (window as any).controller.stop(); (window as any).controller.resume();
    (window as any).controller.stop(); (window as any).controller.resume();
    f.statusWaits[1]({version: 1, state: 'stopped', message: 'Current status.'});
  });
  await page.waitForFunction(() => document.getElementById('runtime-recovery-banner')?.textContent?.includes('Current status.'));
  await page.evaluate(() => { const f = (window as any).fixture; f.holdStatus = false; f.statusWaits[0]({version: 1, state: 'starting', message: 'Stale status.'}); });
  await page.waitForTimeout(20);
  assert.match(await banner.innerText(), /Current status/);
  assert.equal(await page.evaluate(() => !!document.getElementById('draft')?.closest('[inert]')), false);
  await page.evaluate(() => (window as any).fixture.holdRetry = true); await button.click();
  await page.evaluate(() => { (window as any).controller.stop(); (window as any).controller.resume(); });
  await button.click();
  assert.equal(await page.evaluate(() => (window as any).fixture.retries), 2);
  await page.evaluate(() => (window as any).fixture.retryWaits[0].reject(new Error('Stale retry.')));
  await page.waitForTimeout(20); assert.equal(await button.isDisabled(), true, 'A retired retry cannot clear the new retry state.');
  assert.doesNotMatch(await banner.innerText(), /could not restart/);
  await page.evaluate(() => (window as any).fixture.retryWaits[1].reject(new Error('Current retry.')));
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#runtime-recovery-banner button')?.disabled);
  assert.match(await banner.innerText(), /could not restart/);
  await page.evaluate(() => { const f = (window as any).fixture; f.holdReady = true; (window as any).controller.ready().then((value: boolean) => f.readyResult = value);
    (window as any).controller.stop(); (window as any).controller.resume(); f.readyWaits[0]({ready: true}); });
  await page.waitForFunction(() => (window as any).fixture.readyResult !== undefined);
  assert.equal(await page.evaluate(() => (window as any).fixture.readyResult), false);
  await page.evaluate(() => (window as any).fixture.holdReady = false);
  assert.equal(await page.evaluate(() => (window as any).controller.ready()), true);
  assert.equal(await page.locator('#runtime-recovery-banner').count(), 1);
  assert.equal(await page.locator('#draft').inputValue(), draft);
  assert.deepEqual(await page.evaluate(() => { const f = (window as any).fixture; return [f.states.size, f.requests.size]; }), [1, 1]);
  assert.deepEqual(errors, []);
});
