import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import policy from '../apps/desktop/electron/policy.cjs';
const repository=resolve(fileURLToPath(new URL('..',import.meta.url)));
const root=join(repository,'runtime','verification');await mkdir(root,{recursive:true});
const directory=await mkdtemp(join(root,'memory-browser-')),project=join(directory,'project');await mkdir(project);
const env=policy.daemonEnvironment(process.env,{productRoot:repository,stateRoot:join(directory,'runtime','product'),projectPath:project});
let daemon,browser,origin,token;
async function start(){
  daemon=spawn(process.execPath,[join(repository,'dist/apps/daemon/src/product-main.js')],{cwd:directory,env,shell:false,windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});
  await new Promise((ok,bad)=>{const timeout=setTimeout(()=>bad(Error('Own memory fixture startup timeout.')),15000);daemon.once('error',()=>{clearTimeout(timeout);bad(Error('Own fixture could not start.'));});daemon.once('exit',()=>{clearTimeout(timeout);bad(Error('Own fixture stopped before ready.'));});daemon.on('message',msg=>{try{const ready=policy.readyMessage(msg);origin=ready.origin;token=ready.token;clearTimeout(timeout);ok();}catch{}});});
}
async function stop(){if(!daemon||daemon.exitCode!==null)return;const owned=daemon;daemon=null;await new Promise((ok,bad)=>{const t=setTimeout(()=>{owned.kill();bad(Error('Own fixture shutdown timeout.'));},15000);owned.once('close',code=>{clearTimeout(t);code===0?ok():bad(Error('Own fixture cleanup failed.'));});owned.send({type:'arcane-shutdown',protocolVersion:1});});}
const proof={schemaVersion:1,kind:'arcane-reviewed-memory-real-browser',checks:{},providerInference:0,studioOperations:0};
try{
 await start(); browser=await chromium.launch({headless:true,executablePath:process.env.ARCANE_UI_BROWSER_EXE??'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',args:['--disable-gpu']});
 const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(); const errors=[],memoryRequests=[];
 page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(new URL(request.url()).pathname.startsWith('/v1/learning/'))memoryRequests.push({method:request.method(),path:new URL(request.url()).pathname});});
 await page.goto(origin+'/studio#'+token);await page.waitForTimeout(350);assert.equal(memoryRequests.length,0);proof.checks.startupDoesNotCollect=true;
 await page.locator('[data-workspace-target="learning-heading"]').click();
 const refresh=async()=>{await page.locator('#learning-refresh').click();await page.waitForFunction(()=>document.querySelector('#learning-status').textContent.includes('refreshed'));};
 const ack=async()=>{await page.waitForFunction(()=>document.querySelector('#learning-status').textContent.includes('acknowledged'));};
 await refresh();assert.match(await page.locator('#learning-status').textContent(),/Learning off/);proof.checks.defaultOff=true;
 await page.locator('#learning-toggle').click();await ack();await refresh();assert.match(await page.locator('#learning-status').textContent(),/Learning on/);
 await page.locator('#learning-text').fill('Fixture only: use clear interaction labels and verify exports before accepting an asset.');await page.locator('#learning-kind').selectOption('workflow_pattern');await page.locator('#learning-form button[type="submit"]').click();await ack();await refresh();
 const approve=page.getByRole('button',{name:'Approve note',exact:true});assert.equal(await approve.isDisabled(),true);proof.checks.reviewRequired=true;
 await page.getByRole('checkbox',{name:'I verified this note',exact:true}).check();await approve.click();await ack();await refresh();
 await page.locator('#codex-composer').fill('Existing unsent fixture draft.');await page.locator('#learning-context').click();await page.waitForFunction(()=>document.querySelector('#codex-composer').value.includes('[End project memory hints]'));
 const draft=await page.locator('#codex-composer').inputValue();assert.ok(draft.startsWith('Existing unsent fixture draft.'));assert.ok(draft.includes('untrusted supplemental hints'));proof.checks.explicitContextPreservesDraft=true;
 await page.getByRole('button',{name:'Disable note',exact:true}).click();await ack();await refresh();await page.locator('#codex-composer').fill('Disabled-note fixture draft must stay unchanged.');await page.locator('#learning-context').click();await page.waitForFunction(()=>document.querySelector('#learning-notice').textContent.includes('No approved, enabled hints'));assert.equal(await page.locator('#codex-composer').inputValue(),'Disabled-note fixture draft must stay unchanged.');proof.checks.disableRemovesContext=true;
 await page.locator('#learning-heading').scrollIntoViewIfNeeded();await page.screenshot({path:join(directory,'reviewed-memory.png')});
 const state=await(await fetch(origin+'/v1/learning/state',{headers:{Authorization:'Bearer '+token}})).json();assert.equal(state.settings.optIn,true);assert.equal(state.records.length,1);assert.equal(state.records[0].status,'approved');assert.equal(state.records[0].disabled,true);proof.checks.actualScopedStore=true;
 const product=await(await fetch(origin+'/v1/product/state',{headers:{Authorization:'Bearer '+token}})).json();assert.equal(product.studioSessions.length,0);assert.ok(Object.values(product.commandCounts).every(n=>n===0));
 const native=await(await fetch(origin+'/v1/codex/state',{headers:{Authorization:'Bearer '+token}})).json();assert.equal(native.state.snapshot,null);assert.deepEqual(native.state.actions,[]);proof.checks.noNativeLifecycle=true;
 assert.deepEqual(errors,[]);proof.checks.noPageErrors=true;proof.browserVersion=browser.version();proof.requests=memoryRequests;
 const oldToken=token;await stop();await start();assert.notEqual(token,oldToken);const persisted=await(await fetch(origin+'/v1/learning/state',{headers:{Authorization:'Bearer '+token}})).json();assert.equal(persisted.settings.projectId,state.settings.projectId);assert.equal(persisted.records[0].id,state.records[0].id);assert.equal(persisted.records[0].disabled,true);proof.checks.restartPersistsReviewedNote=true;
 await stop();await browser.close();browser=null;proof.checks.cleanShutdown=true;
 await writeFile(join(directory,'checks.json'),JSON.stringify(proof,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({directory,checks:proof.checks,browserVersion:proof.browserVersion,providerInference:0,studioOperations:0},null,2));
}finally{await stop().catch(()=>{});await browser?.close().catch(()=>{});}
