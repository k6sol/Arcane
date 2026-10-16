/// <reference lib="dom" />
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,relative,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';

const browserModule=process.env.ARCANE_UI_BROWSER_MODULE;
const options={skip:!browserModule,timeout:45000};
const FIXTURE=String.raw`
import {StudioApi,StudioWorkbench} from '/dist/apps/desktop/src/studio.js';
const token='a'.repeat(64),project='C:\\owned-fixture\\worker-status',id='11111111-1111-4111-8111-111111111111';
let resolved=false,release=null,conversation={provider:'codex',threadId:'worker-thread',sessionId:'worker-session'};
const listeners=new Set(),calls=[],signals=[];
const job=()=>({schemaVersion:1,jobId:id,directory:project+'\\assets\\crate-'+id,manifestPath:null,
  request:{schemaVersion:1,template:'hero-prop',name:'retained-crate',seed:1,sizeMeters:[1,.65,.7],color:[.12,.32,.27],triangleBudget:5000,renderResolution:384,renderSamples:16},
  state:'interrupted',stage:'complete',startedAt:'2026-10-16T00:00:00.000Z',updatedAt:'2026-10-16T00:00:00.000Z',events:[],manifestAvailable:false,error:null,
  ...(resolved?{resolution:{status:'resolved',resolvedAt:'2026-10-16T00:00:01.0000000Z'}}:{})});
const api=new StudioApi(token,async(path,init)=>{
  calls.push({path:String(path),method:init.method,body:init.body});
  if(new Headers(init.headers).get('Authorization')!=='Bearer '+token)throw Error('Missing fixture control bearer');
  if(path==='/v1/assets/resolve-interrupted'){
    signals.push(init.signal);return new Promise(done=>{release=()=>{resolved=true;done(Response.json({resolution:{jobId:id,status:'resolved',resolvedAt:'2026-10-16T00:00:01.0000000Z',evidence:['closed-exit-observed'],alreadyResolved:false}}));};});
  }
  if(!String(path).startsWith('/v1/assets/conversation-jobs?limit=32'))throw Error('Unexpected action in owned fixture');
  return Response.json({projectId:'b'.repeat(64),projectPath:project,conversation,jobs:[job()],nextCursor:null,byteLimit:524288});
});
const view=new StudioWorkbench(document,api,location.origin,token,{getProjectPath:()=>project,getNativeConversation:()=>({...conversation,projectPath:project}),isSignedIn:()=>true,
  subscribeContextChange:fn=>{listeners.add(fn);return()=>listeners.delete(fn);}});
const stage=document.createElement('main');stage.id='owned-worker-fixture';document.body.prepend(stage);stage.append(document.getElementById('chat-assets'));
const style=document.createElement('style');style.textContent='body{display:block!important}body>:not(#owned-worker-fixture){display:none!important}#owned-worker-fixture{box-sizing:border-box;max-width:900px;margin:30px auto;padding:16px}';document.head.append(style);
view.subscribeAssetContext();await view.refreshAssets();view.assetProbed=true;view.renderAssetControls();
window.workerStatusFixture={calls,signals,view,release:()=>release?.(),change:()=>{conversation={...conversation,threadId:'another-thread'};for(const listener of listeners)listener();}};
`;

test('Edge worker recovery: scripted activation is inert; trusted keyboard checks one job and preserves interrupted output',options,async t=>{
  const root=resolve('.'),dist=resolve('dist');
  const html=(await readFile('apps/desktop/public/studio.html','utf8')).replace('<script type="module" src="/studio.js"></script>','<script type="module" src="/fixture.js"></script>');
  const errors:string[]=[];
  const server=createServer((request,response)=>{void(async()=>{
    const path=new URL(request.url??'/','http://fixture.invalid').pathname;
    let body:Buffer|string,type='text/javascript';
    if(path==='/'){body=html;type='text/html';}
    else if(path==='/fixture.js')body=FIXTURE;
    else if(path==='/studio.css'){body=await readFile('apps/desktop/public/studio.css');type='text/css';}
    else if(path.startsWith('/dist/')&&path.endsWith('.js')){
      const file=resolve(root,'.'+path),child=relative(dist,file);if(isAbsolute(child)||child.startsWith('..'))throw Error('Outside owned module tree');
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
  const page=await browser.newPage({viewport:{width:1100,height:800}});page.on('pageerror',error=>errors.push(error.message));
  await page.goto('http://127.0.0.1:'+address.port);await page.waitForFunction(()=>!!(window as any).workerStatusFixture);
  const button=page.getByRole('button',{name:'Check worker status for retained crate',exact:true});
  await button.evaluate(node=>(node as HTMLButtonElement).click());
  assert.equal(await page.evaluate(()=>(window as any).workerStatusFixture.calls.filter((c:any)=>c.method==='POST').length),0);
  await button.focus();await page.keyboard.press('Enter');
  await page.waitForFunction(()=>(window as any).workerStatusFixture.calls.filter((c:any)=>c.method==='POST').length===1);
  assert.equal(await page.getByRole('button',{name:'Check worker status for retained crate',exact:true}).isDisabled(),true);
  await page.evaluate(()=>(window as any).workerStatusFixture.release());
  await page.getByText('Worker confirmed stopped. Partial files are kept; this job remains interrupted.',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>(window as any).workerStatusFixture.view.assetJobs[0].state),'interrupted');
  assert.equal(await page.evaluate(()=>(window as any).workerStatusFixture.view.assetJobs[0].manifestAvailable),false);
  assert.equal(await page.evaluate(()=>(window as any).workerStatusFixture.calls.filter((c:any)=>c.method==='POST').length),1);
  assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('data-worker-status-note')),'11111111-1111-4111-8111-111111111111');
  await page.setViewportSize({width:390,height:700});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.deepEqual(errors,[]);t.diagnostic('Actual browser '+browser.version()+'; synthetic service; production card/API code; page bootstrap disabled.');
});
