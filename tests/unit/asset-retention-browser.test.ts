/// <reference lib="dom" />
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,relative,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';

// Owned Edge page + synthetic transport. Modules come from ARCANE_UI_MODULE_ROOT (a private build), never shared dist.
const browserModule=process.env.ARCANE_UI_BROWSER_MODULE,moduleRoot=process.env.ARCANE_UI_MODULE_ROOT;
const options={skip:!browserModule||!moduleRoot,timeout:60000};
const FIXTURE=String.raw`
import {StudioApi,StudioWorkbench} from '/dist/apps/desktop/src/studio.js';
const token='a'.repeat(64),project='C:\\owned-fixture\\retention',id='11111111-1111-4111-8111-111111111111',mode=location.hash.slice(1);
const backup='archive-ledger.backup-0123456789abcdef-33333333-3333-4333-8333-333333333333.bin';
let retained=true,healthy=false,uncertain=true,conversation={provider:'codex',threadId:'retention-thread',sessionId:'retention-session'},confirmLost=false;
const listeners=new Set(),calls=[],signals=[],held={};
const job=()=>({schemaVersion:1,jobId:id,directory:project+'\\assets\\retained-crate-'+id,manifestPath:null,
  request:{schemaVersion:1,template:'hero-prop',name:'retained-crate',seed:1,sizeMeters:[1,.65,.7],color:[.12,.32,.27],triangleBudget:5000,renderResolution:384,renderSamples:16},
  state:'failed',stage:'complete',startedAt:'2026-10-16T00:00:00.000Z',updatedAt:'2026-10-16T00:00:00.000Z',finishedAt:'2026-10-16T00:00:01.000Z',events:[],manifestAvailable:false,error:null,
  ...(retained?{retention:{status:'archived',archivedAt:'2026-10-16T00:00:02.000Z'}}:{})});
const hold=name=>new Promise(done=>{held[name]=done;});
const api=new StudioApi(token,async(path,init)=>{
  calls.push({path:String(path),method:init.method,body:init.body});signals.push(init.signal);
  if(new Headers(init.headers).get('Authorization')!=='Bearer '+token)throw Error('Missing fixture control bearer');
  if(path==='/v1/assets/history-status')return Response.json({history:healthy?{degraded:false,reasons:[],active:1,archived:0,unclassified:0,unavailable:0}
    :{degraded:true,reasons:uncertain?['ledger-invalid','commit-uncertain']:['ledger-invalid'],active:0,archived:1,unclassified:0,unavailable:1}});
  if(path==='/v1/assets/rebuild-history'){await hold('rebuild');healthy=true;return Response.json({rebuilt:{active:0,archived:1,unavailable:0,degraded:false,backup}});}
  if(path==='/v1/assets/confirm-history'){if(confirmLost)throw new TypeError('fixture connection lost');return Response.json({confirmed:{active:0,archived:1,unavailable:0,degraded:false,backup:null}});}
  if(path==='/v1/assets/restore-history'){retained=false;return Response.json({restored:{jobId:id,swappedOut:null,activeAfter:1}});}
  if(!String(path).startsWith('/v1/assets/conversation-jobs?limit=32'))throw Error('Unexpected action in owned fixture '+path);
  return Response.json({projectId:'b'.repeat(64),projectPath:project,conversation,jobs:[job()],nextCursor:null,byteLimit:524288});
});
const view=new StudioWorkbench(document,api,location.origin,token,{getProjectPath:()=>project,getNativeConversation:()=>({...conversation,projectPath:project}),isSignedIn:()=>true,
  subscribeContextChange:fn=>{listeners.add(fn);return()=>listeners.delete(fn);}});
const stage=document.createElement('main');stage.id='owned-retention-fixture';document.body.prepend(stage);
stage.append(document.getElementById('asset-history-health'),document.getElementById('asset-unknown'),document.getElementById('chat-assets'));
const style=document.createElement('style');style.textContent='body{display:block!important}body>:not(#owned-retention-fixture){display:none!important}#owned-retention-fixture{box-sizing:border-box;max-width:900px;margin:30px auto;padding:16px}';document.head.append(style);
view.bindAssetAcknowledgement();view.subscribeAssetContext();await view.refreshAssets();
window.retentionFixture={calls,signals,view,posts:()=>calls.filter(c=>c.method==='POST').map(c=>c.path+' '+c.body),release:name=>held[name]?.(),
  degrade:async()=>{healthy=false;uncertain=true;confirmLost=true;await view.refreshAssets();},
  change:()=>{conversation={...conversation,threadId:'another-thread'};for(const listener of listeners)listener();}};
`;

async function harness(t:test.TestContext){
  const root=resolve('.'),modules=resolve(moduleRoot!);
  const html=(await readFile('apps/desktop/public/studio.html','utf8')).replace('<script type="module" src="/studio.js"></script>','<script type="module" src="/fixture.js"></script>');
  const errors:string[]=[];
  const server=createServer((request,response)=>{void(async()=>{
    const path=new URL(request.url??'/','http://fixture.invalid').pathname;
    let body:Buffer|string,type='text/javascript';
    if(path==='/favicon.ico'){response.writeHead(204);response.end();return;}
    if(path==='/'){body=html;type='text/html';}
    else if(path==='/fixture.js')body=FIXTURE;
    else if(path==='/studio.css'){body=await readFile(resolve(root,'apps/desktop/public/studio.css'));type='text/css';}
    else if(path.startsWith('/dist/')&&path.endsWith('.js')){
      const file=resolve(modules,'.'+path.slice('/dist'.length)),child=relative(modules,file);if(isAbsolute(child)||child.startsWith('..'))throw Error('Outside owned module tree');
      body=await readFile(file);
      // Disable only the page bootstrap. All production class/event/transport code remains byte-identical.
      if(path==='/dist/apps/desktop/src/studio.js')body='const window=undefined,document=undefined;\n'+body.toString();
    }else{response.writeHead(404);response.end();return;}
    response.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'"});response.end(body);
  })().catch(error=>{errors.push(String(error));response.writeHead(500);response.end();});});
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));});
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const {chromium}=await import(pathToFileURL(resolve(browserModule!)).href) as typeof import('playwright-core');
  const browser=await chromium.launch({headless:true,executablePath:process.env.ARCANE_UI_BROWSER_EXE??'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1100,height:800}});page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push('console: '+message.text());});
  const ready=async(hash:string)=>{await page.goto('http://127.0.0.1:'+address.port+'/#'+hash);
    try{await page.waitForFunction(()=>!!(window as any).retentionFixture,undefined,{timeout:15000});}catch(error){throw new Error('Fixture did not start: '+JSON.stringify(errors));}};
  return{page,errors,browser,origin:'http://127.0.0.1:'+address.port,ready};
}
const posts=(page:import('playwright-core').Page)=>page.evaluate(()=>(window as any).retentionFixture.posts() as string[]);

test('Edge retained history: health, trusted rebuild, restore and lost confirm without replay',options,async t=>{
  const {page,errors,browser,ready}=await harness(t);
  await ready('main');
  const status=page.locator('#asset-history-health-status');await status.getByText('Saved history needs attention.',{exact:false}).waitFor();
  assert.match(await status.innerText(),/could not be read.*not confirmed.*Files are kept/s);
  const rebuild=page.getByRole('button',{name:'Rebuild history index',exact:true});
  await rebuild.evaluate(node=>(node as HTMLButtonElement).click());await page.waitForTimeout(50);
  assert.deepEqual(await posts(page),[],'scripted activation is inert');
  await rebuild.focus();await page.keyboard.press('Enter');
  await page.waitForFunction(()=>(window as any).retentionFixture.posts().length===1);
  assert.equal(await page.locator('#asset-history-rebuild').isDisabled(),true,'one flight');
  await page.keyboard.press('Enter');await page.waitForTimeout(50);assert.equal((await posts(page)).length,1);
  await page.evaluate(()=>(window as any).retentionFixture.release('rebuild'));
  await page.locator('#asset-history-health-result').getByText('History index rebuilt',{exact:false}).waitFor();
  assert.match(await page.locator('#asset-history-health-result').innerText(),/previous index was kept as a backup\. No job was moved, deleted or restarted\./);
  await page.locator('#asset-history-health-status').getByText('Saved history is healthy.',{exact:false}).waitFor();
  assert.equal(await page.locator('#asset-history-rebuild').isHidden(),true);
  assert.ok(!(await page.locator('#owned-retention-fixture').innerText()).includes('archive-ledger.backup-'),'backup names stay out of the flow');

  const restore=page.getByRole('button',{name:'Restore retained crate to active history',exact:true});
  await restore.evaluate(node=>(node as HTMLButtonElement).click());await page.waitForTimeout(50);assert.equal((await posts(page)).length,1);
  await restore.focus();await page.keyboard.press('Enter');
  await page.getByText('Restored to active history. Generation was not restarted.',{exact:true}).first().waitFor();
  assert.deepEqual((await posts(page)).slice(1),['/v1/assets/restore-history {"jobId":"11111111-1111-4111-8111-111111111111"}']);
  assert.equal(await page.evaluate(()=>(window as any).retentionFixture.view.assetJobs[0].state),'failed','restore supplies no job state or work authority');

  await page.evaluate(()=>(window as any).retentionFixture.degrade());
  const confirm=page.getByRole('button',{name:'Confirm last change',exact:true});await confirm.waitFor();
  await confirm.focus();await page.keyboard.press('Enter');
  await page.locator('#asset-unknown').waitFor({state:'visible'});
  assert.match(await page.locator('#asset-unknown-message').innerText(),/unknown\. It was not repeated/);
  assert.equal(await confirm.isDisabled(),true);await page.keyboard.press('Enter');await page.waitForTimeout(50);
  assert.equal((await posts(page)).filter(p=>p.startsWith('/v1/assets/confirm-history')).length,1,'lost receipt is never replayed');
  await page.evaluate(()=>(window as any).retentionFixture.view.refreshAssets());
  const acknowledge=page.locator('#asset-acknowledge');assert.equal(await acknowledge.isDisabled(),false);
  await acknowledge.evaluate(node=>(node as HTMLButtonElement).click());
  assert.notEqual(await page.evaluate(()=>(window as any).retentionFixture.view.assetUnknown),'','scripted acknowledgement cannot clear uncertainty');
  await acknowledge.focus();await page.keyboard.press('Enter');
  await page.waitForFunction(()=>(window as any).retentionFixture.view.assetUnknown==='');
  assert.equal((await posts(page)).filter(p=>p.startsWith('/v1/assets/confirm-history')).length,1,'human acknowledgement does not replay a mutation');
  await page.setViewportSize({width:390,height:700});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'390px layout wraps');
  assert.deepEqual(errors,[]);t.diagnostic('Actual browser '+browser.version()+'; synthetic service; private-build production code; page bootstrap disabled.');
});

test('Edge retained history: a chat switch aborts an in-flight rebuild, clears health and ignores late output',options,async t=>{
  const {page,errors,ready}=await harness(t);
  await ready('switch');
  const rebuild=page.getByRole('button',{name:'Rebuild history index',exact:true});await rebuild.waitFor();
  await rebuild.focus();await page.keyboard.press('Enter');
  await page.waitForFunction(()=>(window as any).retentionFixture.posts().length===1);
  await page.evaluate(()=>(window as any).retentionFixture.change());
  await page.waitForFunction(()=>{const f=(window as any).retentionFixture,i=f.calls.findIndex((c:any)=>c.method==='POST');return f.signals[i].aborted===true;},undefined,{timeout:5000});
  // Health is project-level: the new chat re-reads it fresh; the aborted change never leaves it in flight.
  await page.waitForFunction(()=>{const b=document.getElementById('asset-history-rebuild') as HTMLButtonElement;return b.textContent==='Rebuild history index'&&!b.disabled;},undefined,{timeout:5000});
  assert.equal(await page.evaluate(()=>(window as any).retentionFixture.view.assetBusy),false);
  await page.evaluate(()=>(window as any).retentionFixture.release('rebuild'));await page.waitForTimeout(100);
  assert.equal(await page.locator('#asset-history-health-result').innerText(),'','late output ignored');
  assert.equal((await posts(page)).length,1);assert.deepEqual(errors,[]);
});
