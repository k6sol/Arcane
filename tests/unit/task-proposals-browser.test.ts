/// <reference lib="dom" />
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,mkdtemp} from 'node:fs/promises';
import {isAbsolute,join,relative,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const browserModule=process.env.ARCANE_UI_BROWSER_MODULE;
const FIXTURE=String.raw`
import {CodexChatApi,TaskProposalPanel} from '/dist/apps/desktop/src/codex-chat.js';
const token='a'.repeat(64),listeners=new Set(),calls=[],rows=new Map();let release=null;
let scope={projectPath:'C:/owned-fixture/proposals',chatKey:'owned-chat',connectionId:'11111111-1111-4111-8111-111111111111',threadId:'owned-thread',sessionId:'owned-session',taskId:'22222222-2222-4222-8222-222222222222',active:true,account:'owned-fixture-subscription',model:'fixture',effort:'low'};
const state=()=>({provider:'codex',use:'personal-local',projectPath:scope.projectPath,connecting:false,closing:false,busy:false,snapshot:null,lastSnapshot:null,actions:[],nativeTools:{configured:false,verified:false}});
const hash=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),byte=>byte.toString(16).padStart(2,'0')).join('');
const api=new CodexChatApi(token,async(path,init)=>{
 const body=JSON.parse(init.body);calls.push({path,body,signal:init.signal});
 if(new Headers(init.headers).get('Authorization')!=='Bearer '+token)throw Error('Missing owned control bearer');
 if(path==='/v1/codex/proposals')return Response.json({proposals:{taskId:body.taskId,display:'proposal_not_applied',proposals:rows.get(body.taskId)??[]}});
 if(path!=='/v1/codex/action'||body.action!=='proposal-start')throw Error('Unexpected fixture action');
 return new Promise(done=>{release=async(text='<img src=x onerror=alert(1)> '+token+' '+('long-unbroken-text'.repeat(35)))=>{
   const at=new Date().toISOString(),proposalId=crypto.randomUUID();
   rows.set(body.taskId,[{proposalId,requestId:body.requestId,state:'proposed',reason:null,text,textSha256:await hash(text),textBytes:new TextEncoder().encode(text).byteLength,createdAt:at,updatedAt:at}]);
   done(Response.json({replayed:false,state:state(),record:{requestId:body.requestId,action:'proposal-start',connectionId:body.connectionId,threadId:body.threadId,turnId:null,model:'fixture',effort:'low',state:'acknowledged',errorCode:null,createdAt:at,finishedAt:at,proposalId}}));
 };});
});
const panel=TaskProposalPanel.mount(document,api,()=>({...scope}),listener=>{listeners.add(listener);return()=>listeners.delete(listener);},{pollMs:25});
window.proposalFixture={calls,panel,release:text=>release?.(text),switch:()=>{scope={...scope,taskId:'33333333-3333-4333-8333-333333333333',threadId:'next-thread'};for(const listener of listeners)listener();}};
`;
test('Edge task proposals: trusted keyboard dispatch, private text, responsive layout and retired late output',
 {skip:!browserModule,timeout:45000},async t=>{
  const root=resolve('.'),dist=join(root,'dist'),errors:string[]=[];
  const html=`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/studio.css"><style>body{display:block!important;margin:0;min-width:0!important}#panel-fixture{box-sizing:border-box;max-width:900px;margin:24px auto;padding:16px}#codex-messages{display:block;height:auto;min-height:0;max-height:none}</style><main id="panel-fixture"><h1>Task proposals</h1><p>Owned browser fixture</p><div id="codex-messages"></div></main><script type="module" src="/fixture.js"></script>`;
  const server=createServer((request,response)=>{void(async()=>{
    const path=new URL(request.url??'/','http://fixture.invalid').pathname;let bytes:Buffer|string,type='text/javascript';
    if(path==='/'){bytes=html;type='text/html';}else if(path==='/fixture.js')bytes=FIXTURE;
    else if(path==='/studio.css'){bytes=await readFile(join(root,'apps/desktop/public/studio.css'));type='text/css';}
    else if(path.startsWith('/dist/')&&path.endsWith('.js')){const file=resolve(root,'.'+path),child=relative(dist,file);if(isAbsolute(child)||child.startsWith('..'))throw Error('Outside module tree');bytes=await readFile(file);}
    else{response.writeHead(404);response.end();return;}
    response.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'self'"});response.end(bytes);
  })().catch(error=>{errors.push(String(error));response.writeHead(500);response.end();});});
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));t.after(async()=>{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));});
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const {chromium}=await import(pathToFileURL(resolve(browserModule!)).href) as typeof import('playwright-core');
  const browser=await chromium.launch({headless:true,executablePath:process.env.ARCANE_UI_BROWSER_EXE??'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1100,height:800}});page.on('pageerror',error=>errors.push(error.message));await page.goto('http://127.0.0.1:'+address.port);
  await page.waitForFunction(()=>!!(window as any).proposalFixture);
  const prompt=page.getByLabel('What should the proposal cover?'),request=page.getByRole('button',{name:'Request proposal',exact:true});
  await prompt.fill('Review this approach for the current task.');await request.waitFor();await page.waitForFunction(()=>!(document.getElementById('codex-proposal-request') as HTMLButtonElement).disabled);
  await request.evaluate(element=>(element as HTMLButtonElement).click());
  assert.equal(await page.evaluate(()=>(window as any).proposalFixture.calls.filter((call:any)=>call.path==='/v1/codex/action').length),0);
  await request.click({modifiers:['Shift']});assert.equal(await page.evaluate(()=>(window as any).proposalFixture.calls.filter((call:any)=>call.path==='/v1/codex/action').length),0);
  await request.focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>(window as any).proposalFixture.calls.some((call:any)=>call.path==='/v1/codex/action'));
  assert.equal(await request.isDisabled(),true);await page.evaluate(()=>(window as any).proposalFixture.release());
  await page.getByText('Proposal — not applied',{exact:true}).waitFor();
  assert.equal(await page.locator('#codex-proposal-list img').count(),0);const rendered=await page.locator('#codex-proposal-list').textContent();
  assert.ok(rendered?.includes('<img src=x onerror=alert(1)>')&&rendered.includes('[REDACTED]')&&!rendered.includes('a'.repeat(64)));
  assert.equal(await page.locator('#codex-proposal-list button').count(),0);assert.equal(await page.evaluate(()=>(window as any).proposalFixture.calls.filter((call:any)=>call.path==='/v1/codex/action').length),1);
  await page.setViewportSize({width:390,height:800});
  await mkdir(join(root,'runtime'),{recursive:true});const artifact=await mkdtemp(join(root,'runtime/proposal-browser-'));await page.screenshot({path:join(artifact,'proposals.png'),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await prompt.fill('Review a second approach.');await page.waitForFunction(()=>!(document.getElementById('codex-proposal-request') as HTMLButtonElement).disabled);
  await request.focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>(window as any).proposalFixture.calls.filter((call:any)=>call.path==='/v1/codex/action').length===2);
  await page.evaluate(()=>(window as any).proposalFixture.switch());await page.evaluate(()=>(window as any).proposalFixture.release('Late output from the earlier task'));
  await page.waitForFunction(()=>!(document.getElementById('codex-proposal-list')?.textContent??'').includes('Late output'));
  assert.equal(await prompt.inputValue(),'');assert.equal(await page.evaluate(()=>(window as any).proposalFixture.calls.filter((call:any)=>call.path==='/v1/codex/action')[1].signal.aborted),true);
  assert.equal(await page.evaluate(()=>(window as any).proposalFixture.calls.filter((call:any)=>call.path==='/v1/codex/action').length),2);assert.deepEqual(errors,[]);
  t.diagnostic(JSON.stringify({browser:browser.version(),screenshot:join(artifact,'proposals.png'),scope:'Actual panel/API with synthetic transport and owned task scope; no inference or Studio'}));
 });
