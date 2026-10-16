/// <reference lib="dom" />
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,mkdtemp,readFile,readdir,writeFile,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomBytes,randomUUID} from 'node:crypto';
import {createAssetService} from '../../apps/daemon/src/asset-service.js';
import {assetRoutes} from '../../apps/daemon/src/asset-routes.js';
import {AssetArchiveStore} from '../../apps/daemon/src/asset-archive-store.js';
import {normalizeRequest} from '../../packages/asset-pipeline/src/index.js';
import {LEDGER_FILE,type ArchiveHostFacts} from '../../packages/asset-pipeline/src/archive-ledger.js';

const browserModule=process.env.ARCANE_UI_BROWSER_MODULE;
const options={skip:!browserModule,timeout:45000};
const id=(n:number)=>n.toString(16).padStart(8,'0')+'-4444-4444-8444-444444444444';

test('Edge retained history uses the real controller and filesystem for restore and corrupt-index rebuild',options,async t=>{
  const repo=resolve('.'),boundary=await realpath(tmpdir()),root=await realpath(await mkdtemp(join(boundary,'arcane-retention-live-'))),outputRoot=join(root,'assets');await mkdir(outputRoot);
  const journals:Buffer[]=[];
  for(let n=1;n<=2;n++){
    const directory=join(outputRoot,'crate-'+id(n));await mkdir(directory);const bytes=Buffer.from(JSON.stringify({schemaVersion:1,jobId:id(n),state:'failed',
      request:normalizeRequest({template:'hero-prop',name:'crate'}),startedAt:'2026-10-16T00:00:00.000Z',finishedAt:'2026-10-16T00:00:01.000Z',error:{code:'FIXTURE',message:'Saved failure'}}));
    journals.push(bytes);await writeFile(join(directory,'job.json'),bytes);
  }
  const facts:ArchiveHostFacts={active:false,readPinned:false,importCaptured:false,preparationRecord:false,pendingStage:false,uncertainLatch:false,manifestVerified:false};
  const archive=await AssetArchiveStore.open({root:outputRoot});await archive.archive({jobIds:[id(1)],activeCount:2,facts:async()=>facts,guard:()=>{}});archive.close();
  const service=await createAssetService({cwd:repo,projectPath:root,outputRoot}),route=assetRoutes(service),token=randomBytes(32).toString('hex');
  const html=(await readFile(join(repo,'apps/desktop/public/studio.html'),'utf8')).replace('<script type="module" src="/studio.js"></script>','<script type="module" src="/fixture.js"></script>');
  const fixture=`import {StudioApi,StudioWorkbench} from '/dist/apps/desktop/src/studio.js';
const token=${JSON.stringify(token)},project=${JSON.stringify(root)};
const view=new StudioWorkbench(document,new StudioApi(token),location.origin,token,{getProjectPath:()=>project,getNativeConversation:()=>null,isSignedIn:()=>true});
view.assetContext.setGlobal(true);view.bindAssetAcknowledgement();
const stage=document.createElement('main');stage.id='live-history';document.body.prepend(stage);stage.append(document.getElementById('asset-history-health'),document.getElementById('asset-worker-status'),document.getElementById('chat-assets'));
const style=document.createElement('style');style.textContent='body{display:block!important}body>:not(#live-history){display:none!important}#live-history{box-sizing:border-box;max-width:900px;margin:20px auto;padding:16px}';document.head.append(style);
await view.refreshAssets();view.selectAssetJob(${JSON.stringify(id(1))},true);window.liveHistory={view};`;
  let origin='';const errors:string[]=[],posts:string[]=[];
  const server=createServer((req,res)=>{void(async()=>{
    const url=new URL(req.url??'/',origin);if(url.pathname.startsWith('/v1/assets/')){
      if(req.method==='POST')posts.push(url.pathname);await route(req,res,url,token,origin,'distinct-owned-agent');return;
    }
    let bytes:Buffer|string,type='text/javascript';
    if(url.pathname==='/favicon.ico'){res.writeHead(204);res.end();return;}
    if(url.pathname==='/'){bytes=html;type='text/html';}
    else if(url.pathname==='/fixture.js')bytes=fixture;
    else if(url.pathname==='/studio.css'){bytes=await readFile(join(repo,'apps/desktop/public/studio.css'));type='text/css';}
    else if(url.pathname.startsWith('/dist/')&&url.pathname.endsWith('.js')){
      const file=resolve(repo,'.'+url.pathname),part=relative(join(repo,'dist'),file);
      if(isAbsolute(part)||part==='..'||part.startsWith('..'+sep))throw Error('Outside compiled fixture boundary');
      bytes=await readFile(file);if(url.pathname==='/dist/apps/desktop/src/studio.js')bytes='const window=undefined,document=undefined;\n'+bytes.toString();
    }else{res.writeHead(404);res.end();return;}
    res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'"});res.end(bytes);
  })().catch(error=>{errors.push(String(error));if(!res.headersSent){res.writeHead(500);res.end();}else res.destroy();});});
  let browser:import('playwright-core').Browser|undefined;
  t.after(async()=>{await browser?.close();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await service.close();
    const part=relative(boundary,await realpath(root));assert.ok(!isAbsolute(part)&&part.startsWith('arcane-retention-live-')&&!part.includes(sep)&&!part.includes('..'));await rm(root,{recursive:true,force:true});});
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
  const {chromium}=await import(pathToFileURL(resolve(browserModule!)).href) as typeof import('playwright-core');
  browser=await chromium.launch({headless:true,executablePath:process.env.ARCANE_UI_BROWSER_EXE??'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
  const page=await browser.newPage({viewport:{width:390,height:780}});page.on('pageerror',error=>errors.push(error.message));await page.goto(origin);
  await page.waitForFunction(()=>!!(window as any).liveHistory);await page.locator('#asset-history-health-status').getByText('Saved history is healthy.',{exact:false}).waitFor();
  const restore=page.getByRole('button',{name:'Restore crate to active history',exact:true});await restore.evaluate(node=>(node as HTMLButtonElement).click());
  assert.deepEqual(posts,[]);await restore.focus();await page.keyboard.press('Enter');
  await page.getByText('Restored to active history. Generation was not restarted.',{exact:true}).first().waitFor();
  assert.equal((await service.historyStatus()).archived,0);assert.equal((await service.historyStatus()).active,2);
  const corrupt=Buffer.from([0xff,0x00,0x7b,0x80]);await writeFile(join(outputRoot,LEDGER_FILE),corrupt);
  await page.evaluate(()=>(window as any).liveHistory.view.refreshAssets());
  await page.locator('#asset-history-health-status').getByText('Saved history needs attention.',{exact:false}).waitFor();
  const rebuild=page.getByRole('button',{name:'Rebuild history index',exact:true});await rebuild.focus();
  const rebuilding=page.waitForResponse(response=>new URL(response.url()).pathname==='/v1/assets/rebuild-history');await page.keyboard.press('Enter');
  const rebuiltResponse=await rebuilding;assert.equal(rebuiltResponse.status(),200,await rebuiltResponse.text());
  await page.locator('#asset-history-health-result').getByText('History index rebuilt',{exact:false}).waitFor();
  await page.locator('#asset-history-health-status').getByText('Saved history is healthy.',{exact:false}).waitFor();
  const backups=(await readdir(outputRoot)).filter(name=>name.startsWith('archive-ledger.backup-'));assert.equal(backups.length,1);assert.deepEqual(await readFile(join(outputRoot,backups[0]!)),corrupt);
  assert.deepEqual(posts,['/v1/assets/restore-history','/v1/assets/rebuild-history']);
  for(let n=1;n<=2;n++)assert.deepEqual(await readFile(join(outputRoot,'crate-'+id(n),'job.json')),journals[n-1]);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
  const evidence=join(repo,'runtime/verification/retention-live-'+randomUUID());await mkdir(evidence,{recursive:true});await page.screenshot({path:join(evidence,'history.png'),fullPage:true});
  t.diagnostic(JSON.stringify({browser:browser.version(),screenshot:join(evidence,'history.png'),scope:'Actual asset controller/service/filesystem and browser; owned failed journals; no inference, generation or native engine calls.'}));
});
