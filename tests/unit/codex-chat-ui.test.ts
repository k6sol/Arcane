import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createCodexService, codexActionInput, type CodexHostClient } from '../../apps/daemon/src/codex-service.js';
import { codexRoutes } from '../../apps/daemon/src/codex-routes.js';
import { CodexSession } from '../../packages/codex-client/src/session.js';
import { CodexClientError, type Approval, type Snapshot, type ThreadState } from '../../packages/codex-client/src/types.js';
import { limits } from '../../packages/codex-client/src/validation.js';
import { nativeEnvironment } from '../../packages/codex-client/src/transport.js';
import { CodexChatApi, CodexHttpError, CodexTranscript, CODEX_STATE_BYTES, prepareCodexAction, readCodexState, approvalEligible, approvalFingerprint, type ChatState, type ChatSnapshot } from '../../apps/desktop/src/codex-chat.js';

const HUMAN='a'.repeat(64), AGENT='b'.repeat(64), PROJECT=resolve('.');
function snapshot():Snapshot {
  return {connectionId:randomUUID(),provenance:'spawned-node-fixture',connected:true,ready:true,account:{auth:'subscription',plan:'fixture',requiresOpenaiAuth:true},models:[{model:'fixture-sol',id:'picker-sol',displayName:'Fixture model <img src=x onerror=alert(1)>',efforts:['low','ultra'],defaultEffort:'low',entitlement:'unverified'}],selection:null,thread:null,operations:[],approvals:[],events:[],droppedEvents:0,lastEventSeq:0,failureCode:null};
}
function state(s:ChatSnapshot|null=snapshot(),projectPath=PROJECT):ChatState {return {provider:'codex',use:'personal-local',projectPath,connecting:false,closing:false,busy:false,snapshot:s,lastSnapshot:null,actions:[],nativeTools:{configured:true,verified:false}};}
function thread():ThreadState {return {threadId:'fixture-thread',sessionId:'fixture-session',selection:{model:'fixture-sol',effort:'ultra'},configured:true,writeGranted:false,turnId:null,turnStatus:'idle'};}
function approval(s:Snapshot,projectPath=PROJECT):Approval {return {handle:randomUUID(),connectionId:s.connectionId,serverRequestId:7,method:'item/commandExecution/requestApproval',threadId:s.thread!.threadId,turnId:s.thread!.turnId!,itemId:'fixture-command',reason:'Fixture only',command:'fixture command <script>window.injected=true</script>',cwd:projectPath,changes:null,canAccept:true,expiresAt:Date.now()+60000};}

test('browser action envelopes exactly match service schemas, with UUIDs and no host configuration',()=>{
  const st=state(), fields:Record<string,Record<string,unknown>>={connect:{},disconnect:{},select:{model:'fixture-sol',effort:'ultra'},'thread-start':{},'thread-resume':{threadId:'human-exact-id'},'grant-writes':{threadId:'fixture-thread'},'revoke-writes':{threadId:'fixture-thread'},'turn-start':{threadId:'fixture-thread',text:'Human public text'},'turn-interrupt':{threadId:'fixture-thread',turnId:'exact-turn'},approval:{threadId:'fixture-thread',turnId:'exact-turn',handle:'exact-handle',decision:'accept'}};
  for(const [action,args] of Object.entries(fields)){const request=prepareCodexAction(st,action,args);assert.deepEqual(codexActionInput.parse(request),request);assert.equal(request.connectionId,action==='connect'?null:st.snapshot!.connectionId);}
  for(const key of ['initiatedBy','exe','cwd','config','modelProvider'])assert.throws(()=>prepareCodexAction(st,'connect',{[key]:'injected'}),/exact browser envelope/);
  assert.throws(()=>prepareCodexAction(st,'select',{model:'unreported',effort:'ultra'}),/reported/);
  assert.throws(()=>prepareCodexAction(st,'select',{model:'fixture-sol',effort:'max'}),/reported/);
  assert.throws(()=>prepareCodexAction(null,'disconnect'),/exact reported/);
  assert.throws(()=>prepareCodexAction(st,'thread-resume',{threadId:'\0'}),/scope ID/);
  assert.throws(()=>prepareCodexAction(st,'connect',{},'not-uuid'),/UUID/);
  assert.throws(()=>prepareCodexAction(st,'turn-start',{threadId:'fixture-thread',text:'🧩'.repeat(32769)}),/128 KiB/);
  assert.throws(()=>prepareCodexAction(st,'turn-start',{threadId:'fixture-thread',text:'  '}),/nonempty/);
});

test('public deltas deduplicate by seq while preserving identical consecutive text and ignoring private item payloads',()=>{
  const s=snapshot(), history=new CodexTranscript();
  s.events=[{seq:1,type:'delta',threadId:'t',turnId:'v',itemId:'m',text:'same'},{seq:2,type:'delta',threadId:'t',turnId:'v',itemId:'m',text:'same'},{seq:3,type:'item',threadId:'t',turnId:'v',itemId:'private',itemType:'reasoning',status:null},{seq:4,type:'delta',threadId:'t',turnId:'v',itemId:'m',text:' public'}];s.lastEventSeq=4;
  history.consume(s);history.consume(s);assert.equal(history.messages[0]?.text,'samesame public');assert.equal(history.messages.length,1);
  assert.throws(()=>history.consume({...s,events:[],lastEventSeq:2}),/Older/);assert.equal(history.cursor,4);
  history.consume({...s,events:[{seq:8,type:'delta',threadId:'t',turnId:'v',itemId:'m',text:' next'}],lastEventSeq:8,droppedEvents:3});assert.equal(history.gaps,3);assert.equal(history.dropped,3);
  history.consume({...s,events:[{seq:9,type:'delta',threadId:'t',turnId:'v',itemId:'big',text:'🧩'.repeat(20000)}],lastEventSeq:9});assert.equal(history.truncated,true);assert.equal(Buffer.byteLength(history.messages.at(-1)!.text),65536);
  history.consume({...s,connectionId:randomUUID(),events:[],lastEventSeq:0});assert.equal(history.messages.length,0);
});

test('native snapshots are bounded and fail closed on inferred profiles, invalid catalogues and unordered seq',()=>{
  const st=state();assert.equal(readCodexState(st).nativeTools.verified,false);
  for(const patch of [{provider:'other'},{nativeTools:{configured:true,verified:true}},{actions:Array(101).fill({})}])assert.throws(()=>readCodexState({...st,...patch}));
  const s=st.snapshot!;
  assert.throws(()=>readCodexState({...st,snapshot:{...s,selection:{model:'other',effort:'low'}}}),/catalogue/);
  assert.throws(()=>readCodexState({...st,snapshot:{...s,events:[{type:'delta',text:'missing seq'}]}}),/sequence/);
  assert.throws(()=>readCodexState({...st,snapshot:{...s,events:[{seq:2,type:'account-changed'},{seq:1,type:'account-changed'}],lastEventSeq:2}}),/unordered/);
});

test('approval eligibility and fingerprints include every scope and complete bounded file preview',()=>{
  const s=snapshot();s.thread={...thread(),writeGranted:true,turnId:'turn',turnStatus:'inProgress'};const st=state(s),a=approval(s);
  assert.doesNotThrow(()=>readCodexState({...st,snapshot:{...s,approvals:[{...a,serverRequestId:-7}]}}));
  assert.equal(approvalEligible(st,a),true);
  for(const patch of [{canAccept:false},{connectionId:randomUUID()},{threadId:'other'},{turnId:'other'},{cwd:'outside'},{expiresAt:0}])assert.equal(approvalEligible(st,{...a,...patch}),false);
  assert.notEqual(approvalFingerprint(a),approvalFingerprint({...a,command:'changed command'}));
  const file={...a,method:'item/fileChange/requestApproval' as const,command:null,cwd:null,changes:[{path:'src/a.ts',kind:'update' as const,movePath:null,diff:'@@ full diff @@\n+text'}]};
  assert.equal(approvalEligible(st,file),true);assert.equal(approvalEligible(st,{...file,changes:[{...file.changes[0]!,path:'../outside'}]}),false);
  assert.equal(approvalEligible(st,{...file,changes:null}),false);s.thread.writeGranted=false;assert.equal(approvalEligible(st,a),false);
});

test('private bearer transport reads 202/409 service outcomes, bounds UTF-8 streams and never retries unknown POSTs',async()=>{
  const st=state(),input=prepareCodexAction(st,'disconnect'),record={...input,state:'rejected',errorCode:'FIXTURE',threadId:null,turnId:null,model:null,effort:null,createdAt:new Date().toISOString(),finishedAt:null};
  for(const [status,receiptState] of [[409,'rejected'],[202,'unknown'],[200,'acknowledged']] as const) {
    const api=new CodexChatApi(HUMAN,async function(this:unknown,path,init){assert.equal(this,undefined);assert.equal(path,'/v1/codex/action');assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer '+HUMAN);assert.equal(init?.credentials,'omit');assert.equal(init?.redirect,'error');return Response.json({record:{...record,state:receiptState},replayed:false,state:st},{status});});
    assert.equal((await api.action(input)).record.state,receiptState);
  }
  await assert.rejects(new CodexChatApi(HUMAN,async()=>Response.json({record:{...record,state:'acknowledged'},replayed:false,state:st},{status:500})).action(input),(e:unknown)=>e instanceof CodexHttpError&&e.unknown);
  let sent=0;const lost=new CodexChatApi(HUMAN,async()=>{sent++;throw new Error('fixture lost ack');});await assert.rejects(lost.action(input),(e:unknown)=>e instanceof CodexHttpError&&e.unknown);assert.equal(sent,1);
  await assert.rejects(new CodexChatApi(HUMAN,async()=>Response.json({error:'HUMAN_ONLY'},{status:403})).action(input),(e:unknown)=>e instanceof CodexHttpError&&!e.unknown);
  await assert.rejects(new CodexChatApi(HUMAN,async()=>Response.json({record:{...record,requestId:randomUUID()},replayed:false,state:st},{status:409})).action(input),/exact request/);
  let cancelled=false;const body=new ReadableStream<Uint8Array>({start(c){c.enqueue(new Uint8Array(CODEX_STATE_BYTES+1));},cancel(){cancelled=true;}});
  await assert.rejects(new CodexChatApi(HUMAN,async()=>new Response(body)).state(),/4 MiB/);assert.equal(cancelled,true);
  await assert.rejects(new CodexChatApi(HUMAN,async()=>new Response(new Uint8Array([0xc3,0x28]))).state(),/UTF-8/);
  const safe=new CodexChatApi(HUMAN).safe('<img src=x> Bearer fake-secret password=fixture '+HUMAN);assert.match(safe,/<img src=x>/);assert.doesNotMatch(safe,/fake-secret|password=fixture/);assert.equal(safe.includes(HUMAN),false);
});

test('Codex bundle is browser-only and boot shares takeControlToken without new storage or automatic actions',async()=>{
  const source=await readFile(resolve('apps/desktop/src/codex-chat.ts'),'utf8'),boot=await readFile(resolve('apps/desktop/src/studio.ts'),'utf8');
  assert.doesNotMatch(source,/\.innerHTML|\.outerHTML|\beval\s*\(|new Function|localStorage|sessionStorage|initiatedBy\s*:/);
  assert.match(boot,/new CodexChatApi\(token\)/);assert.match(boot,/takeControlToken/);
  const js=await readFile(resolve(process.env.ARCANE_UI_BUILD_DIR??'dist','apps/desktop/src/codex-chat.js'),'utf8');assert.doesNotMatch(js,/^\s*import\s|\brequire\s*\(|\bprocess\.|node:/m);
});

function mockClient(projectPath:string) {
  const s=snapshot(); const calls:{method:string;value:unknown}[]=[];let hold:Promise<void>|null=null;let release:()=>void=()=>{};let number=0;let loseAck=false;
  const record=(method:string,value:unknown)=>{calls.push({method,value:structuredClone(value)});};
  const push=(delta:string)=>{const t=s.thread!;s.events.push({seq:++s.lastEventSeq,type:'delta',threadId:t.threadId,turnId:t.turnId!,itemId:'public-message',text:delta});};
  const host:CodexHostClient={
    snapshot(){return structuredClone(s);},
    selectModel(a){record('select',a);s.selection={model:a.model,effort:a.effort};return {...s.selection};},
    async startThread(a){record('thread-start',a);s.thread=thread();return structuredClone(s.thread);},
    async resumeThread(a){record('thread-resume',a);s.thread={...thread(),threadId:a.threadId};return structuredClone(s.thread);},
    grantThreadWrites(a){record('grant-writes',a);s.thread!.writeGranted=true;for(const p of s.approvals)p.canAccept=true;return structuredClone(s.thread!);},
    revokeThreadWrites(a){record('revoke-writes',a);s.thread!.writeGranted=false;s.approvals=[];if(s.thread!.turnStatus==='inProgress'){s.connected=false;s.ready=false;s.thread!.turnStatus='unknown';}},
    async startTurn(a){record('turn-start',a);s.thread!.turnId='fixture-turn-'+(++number);s.thread!.turnStatus='inProgress';push('same');push('same');push(' public <img src=x onerror=alert(1)>');if(hold)await hold;if(loseAck){loseAck=false;throw new CodexClientError('TIMEOUT','Synthetic native acknowledgement loss',true);}return structuredClone(s.thread!);},
    async interruptTurn(a){record('turn-interrupt',a);s.thread!.turnStatus='interrupted';s.thread!.writeGranted=false;s.approvals=[];s.events.push({seq:++s.lastEventSeq,type:'turn',threadId:s.thread!.threadId,turnId:s.thread!.turnId!,status:'interrupted'});},
    respondApproval(a){record('approval',a);const p=s.approvals.find(p=>p.handle===a.handle);if(!p||p.connectionId!==a.connectionId||p.threadId!==a.threadId||p.turnId!==a.turnId||a.decision==='accept'&&!approvalEligible(state(s,projectPath),p))throw new CodexClientError('STALE_APPROVAL','Fixture scope refused');s.approvals=s.approvals.filter(candidate=>candidate!==p);},
    async close(){s.connected=false;s.ready=false;if(s.thread){s.thread.writeGranted=false;s.thread.turnStatus='unknown';}release();}
  };
  return {host,s,calls,push,loseAck(){loseAck=true;},hold(){hold=new Promise<void>(done=>{release=done;});},release(){release();hold=null;}};
}
async function harness(t:test.TestContext,spawned=false) {
  const directory=await mkdtemp(join(tmpdir(),'arcane-codex-chat-')),projectPath=join(directory,'project');await mkdir(projectPath);
  const clients:ReturnType<typeof mockClient>[]=[];const children:CodexSession[]=[];let connected=0;
  const service=createCodexService({directory:join(directory,'journal'),projectPath,nativeToolsConfigured:true,connect:async()=>{
    connected++;
    if(spawned){const client=new CodexSession({command:process.execPath,args:[resolve('packages/codex-client/fixtures/protocol.mjs'),'approvals',join(directory,'audit-'+connected+'.jsonl')],cwd:projectPath,env:nativeEnvironment()},limits({requestTimeoutMs:1500,approvalTimeoutMs:15000}),'spawned-node-fixture');children.push(client);await client.initialize();return client;}
    const client=mockClient(projectPath);clients.push(client);return client.host;
  }});
  const routes=codexRoutes(service);let origin='';
  const build=process.env.ARCANE_UI_BUILD_DIR??'dist';
  const assets=new Map([['/studio',resolve('apps/desktop/public/studio.html')],['/studio.css',resolve('apps/desktop/public/studio.css')],['/studio.js',resolve(build,'apps/desktop/src/studio.js')],['/codex-chat.js',resolve(build,'apps/desktop/src/codex-chat.js')],['/workspace-shell.js',resolve(build,'apps/desktop/src/workspace-shell.js')], ['/asset-downloads.js', resolve(build,'apps/desktop/src/asset-downloads.js')],['/learning-panel.js',resolve(build,'apps/desktop/src/learning-panel.js')],['/brand/arcane-ridges.png',resolve('apps/desktop/public/brand/arcane-ridges.png')]]);
  let gets=0;
  const server=createServer((request,response)=>{void(async()=>{
    const url=new URL(request.url??'/',origin),asset=assets.get(url.pathname);
    if(asset){response.writeHead(200,{'Content-Type':url.pathname.endsWith('.png')?'image/png':url.pathname.endsWith('.js')?'text/javascript':url.pathname.endsWith('.css')?'text/css':'text/html','Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"});response.end(await readFile(asset));return;}
    if(url.pathname==='/v1/codex/state')gets++;
    if(await routes(request,response,url,HUMAN,origin,AGENT))return;
    response.writeHead(404,{'Content-Type':'application/json'});response.end(JSON.stringify({error:'NOT_FOUND',message:'Absent from explicit conversation fixture.'}));
  })().catch(()=>response.destroy());});
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const addr=server.address();assert.ok(addr&&typeof addr!=='string');origin='http://127.0.0.1:'+addr.port;
  t.after(async()=>{for(const c of clients)c.release();await service.close();for(const c of children)await c.close();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));const child=relative(tmpdir(),directory);assert.ok(child&&!child.startsWith('..')&&!isAbsolute(child));await rm(directory,{recursive:true,force:true});});
  const post=async(body:unknown,token=HUMAN,from=origin)=>{const response=await fetch(origin+'/v1/codex/action',{method:'POST',headers:{Authorization:'Bearer '+token,Origin:from,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:response.status,body:await response.json() as any};};
  return {service,origin,projectPath,directory,clients,children,post,get connected(){return connected;},get gets(){return gets;}};
}
const browserModule=process.env.ARCANE_UI_BROWSER_MODULE;
async function browser(t:test.TestContext,origin:string) {
  const playwright=await import(pathToFileURL(resolve(browserModule!)).href);
  const instance=await playwright.chromium.launch({headless:true,args:['--disable-gpu'],...(process.env.ARCANE_UI_BROWSER_EXE?{executablePath:process.env.ARCANE_UI_BROWSER_EXE}:{})});t.after(()=>instance.close());
  const page=await instance.newPage({viewport:{width:1440,height:1100}}),errors:string[]=[],posts:any[]=[];
  page.on('pageerror',(e:Error)=>errors.push(e.message));page.on('request',(r:any)=>{if(r.url().endsWith('/v1/codex/action'))posts.push(r.postDataJSON());});
  const text=async(id:string,part:string)=>{await page.waitForFunction(({id,part}:{id:string;part:string})=>document.getElementById(id)?.textContent?.includes(part),{id,part},{timeout:8000});};
  const ready=async(id:string)=>{await page.waitForFunction((id:string)=>!(document.getElementById(id) as HTMLButtonElement).disabled,id,{timeout:8000});};
  const refresh=async()=>{await page.locator('#codex-refresh').click();await page.waitForTimeout(60);};
  const open=async(token=HUMAN)=>{try{await page.goto(origin+'/studio#'+token);await page.reload();await ready('codex-refresh');await page.locator('#auto-refresh').uncheck();}catch(error){t.diagnostic('Browser mount diagnostic '+JSON.stringify(await page.evaluate(()=>({title:document.title,refresh:document.getElementById('codex-refresh')?.outerHTML,notice:document.getElementById('codex-notice')?.textContent,main:document.getElementById('notice')?.textContent})))+' errors '+errors.join(';'));throw error;}};
  const connect=async()=>{await ready('codex-connect');await page.locator('#codex-connect').click();await text('codex-status','Fixture connected');await ready('codex-model');};
  const select=async()=>{await page.locator('#codex-model').selectOption('fixture-sol');assert.equal(await page.locator('#codex-effort').inputValue(),'');await page.locator('#codex-effort').selectOption('ultra');await page.locator('#codex-select').click();await text('codex-selection','fixture-sol · ultra');await ready('codex-thread-start');};
  const grant=async()=>{await page.locator('#codex-grant').click();await text('codex-confirm-preview','Workspace');assert.equal(await page.locator('#codex-confirm-submit').isDisabled(),true);await page.locator('#codex-confirm-check').check();await page.locator('#codex-confirm-submit').click();await text('codex-policy','Workspace writes granted');};
  return {page,errors,posts,text,ready,refresh,open,connect,select,grant,instance};
}

test('actual HTTP service denies every agent lifecycle/approval and malformed host input before connecting',async t=>{
  const h=await harness(t),st=state(),id=randomUUID();
  for(const token of [AGENT,'']){const response=await fetch(h.origin+'/v1/codex/state',{headers:{Authorization:'Bearer '+token}});assert.equal(response.status,token?403:401);}
  const fields:Record<string,Record<string,unknown>>={connect:{},disconnect:{},select:{model:'fixture-sol',effort:'ultra'},'thread-start':{},'thread-resume':{threadId:'id'},'grant-writes':{threadId:'id'},'revoke-writes':{threadId:'id'},'turn-start':{threadId:'id',text:'fixture'},'turn-interrupt':{threadId:'id',turnId:'turn'},approval:{threadId:'id',turnId:'turn',handle:'handle',decision:'accept'}};
  for(const [action,args] of Object.entries(fields)){assert.equal((await h.post(prepareCodexAction(st,action,args),AGENT)).status,403);assert.equal(h.connected,0);}
  assert.equal((await h.post({requestId:id,connectionId:null,action:'connect',cwd:'injected'})).status,400);
  assert.equal((await h.post(prepareCodexAction(st,'connect'),HUMAN,'http://example.invalid')).status,403);assert.equal(h.connected,0);
});

test('real Edge + service fixtures: explicit setup, scopes, public text, XSS, approvals, loss reconciliation, safety races and collapse', {skip:!browserModule,timeout:90000},async t=>{
  const h=await harness(t),b=await browser(t,h.origin),{page}=b;
  await b.open(AGENT);await b.text('codex-notice','HUMAN_ONLY');assert.equal(await page.locator('#codex-connect').isDisabled(),true);assert.equal(h.connected,0);
  await b.open();await b.ready('codex-connect');assert.equal(h.connected,0);assert.equal(b.posts.length,0);assert.equal(await page.locator('#codex-model').inputValue(),'');
  await b.connect();const c=h.clients[0]!,connectionId=c.s.connectionId;
  assert.equal(c.calls.length,0);assert.equal(await page.locator('#codex-model').inputValue(),'');assert.equal(await page.locator('#codex-effort').inputValue(),'');assert.equal(await page.locator('#codex-thread-start').isDisabled(),true);
  await b.text('codex-profile','profile requested · verified:false');assert.equal(await page.locator('#codex-panel img, #codex-panel script').count(),0);
  await b.select();await page.locator('#codex-resume-id').fill('human-exact-native-thread');await page.locator('#codex-thread-resume').click();await b.text('codex-scope','human-exact-native-thread');await b.ready('codex-grant');
  assert.equal(c.calls.some(v=>v.method==='thread-start'),false);assert.equal(c.s.thread!.writeGranted,false);
  await page.locator('#codex-grant').click();await b.text('codex-confirm-preview',connectionId);await b.text('codex-confirm-preview','human-exact-native-thread');await b.text('codex-confirm-preview',h.projectPath);
  await page.locator('#codex-confirm-check').check();c.s.thread!.threadId='changed-thread-scope';await b.text('codex-scope','changed-thread-scope');assert.equal(await page.locator('#codex-confirm-submit').isDisabled(),true);await page.locator('#codex-confirm-cancel').click();assert.equal(c.s.thread!.writeGranted,false);
  c.s.thread!.threadId='human-exact-native-thread';await b.refresh();await b.text('codex-scope','human-exact-native-thread');await b.grant();
  // Delay a granted HTTP snapshot, revoke without emitting events, then deliver the old reply.
  await page.locator('#codex-revoke').click();await b.text('codex-policy','Read-only thread');
  let releaseGrant:()=>void=()=>{},grantReady:()=>void=()=>{};
  const grantHeld=new Promise<void>(done=>{releaseGrant=done;}),grantAccepted=new Promise<void>(done=>{grantReady=done;});
  await page.route('**/v1/codex/action',async(route:any)=>{const response=await route.fetch();grantReady();await grantHeld;await route.fulfill({response});},{times:1});
  await page.locator('#codex-grant').click();await page.locator('#codex-confirm-check').check();await page.locator('#codex-confirm-submit').click();await grantAccepted;
  await page.locator('#codex-revoke').click();await b.text('codex-policy','Read-only thread');
  await page.evaluate(()=>{const seen:string[]=[];(window as unknown as {policySeen:string[]}).policySeen=seen;new MutationObserver(()=>{seen.push(document.getElementById('codex-policy')!.textContent!);}).observe(document.getElementById('codex-policy')!,{childList:true});});
  const grantResponse=page.waitForResponse('**/v1/codex/action');releaseGrant();await (await grantResponse).finished();await b.ready('codex-grant');
  assert.equal(c.s.thread!.writeGranted,false);assert.equal(await page.evaluate(()=>(window as unknown as {policySeen:string[]}).policySeen.some(s=>s.includes('writes granted'))),false);await b.grant();
  await page.locator('#codex-composer').fill('🧩'.repeat(32769));assert.equal(await page.locator('#codex-submit').isDisabled(),true);
  const beforeTyping=b.posts.length;await page.locator('#codex-composer').fill('Fixture human message <script>window.injected=true</script>');assert.equal(b.posts.length,beforeTyping);
  await page.locator('#codex-submit').click();await b.text('codex-policy','inProgress');await b.text('codex-messages','samesame public');assert.equal(await page.locator('#codex-submit').isDisabled(),true);
  if(process.env.ARCANE_UI_SCREENSHOT)await page.locator('#codex-panel').screenshot({path:process.env.ARCANE_UI_SCREENSHOT+'.codex-conversation.png'});
  const output=await page.locator('#codex-messages').textContent();await b.refresh();assert.equal(await page.locator('#codex-messages').textContent(),output);assert.equal(await page.locator('#codex-messages script, #codex-messages img').count(),0);assert.equal(await page.evaluate(()=>Boolean((window as unknown as {injected?:boolean}).injected)),false);
  const a=approval(c.s,h.projectPath);a.canAccept=false;c.s.approvals=[a];await b.refresh();await b.text('codex-approvals','fixture command');assert.equal(await page.locator('#codex-approvals [data-decision="accept"]').isDisabled(),true);
  const file:Approval={...a,canAccept:true,method:'item/fileChange/requestApproval',command:null,cwd:null,itemId:'full-file',changes:[{path:'src/full.ts',kind:'update',movePath:null,diff:'@@ full scoped diff @@\n'+('+line\n'.repeat(2000))+'+FULL-END <img src=x onerror=alert(1)>'}]};
  c.s.approvals=[file];await b.refresh();await b.text('codex-approvals','FULL-END');assert.equal(await page.locator('#codex-approvals img').count(),0);
  await page.locator('#codex-approvals [data-decision="accept"]').click();for(const id of [file.connectionId,file.threadId,file.turnId,file.handle,file.itemId])await b.text('codex-confirm-preview',id);await b.text('codex-confirm-preview','FULL-END');await page.locator('#codex-confirm-check').check();
  if(process.env.ARCANE_UI_SCREENSHOT)await page.locator('#codex-confirm').screenshot({path:process.env.ARCANE_UI_SCREENSHOT+'.codex-approval.png'});
  file.changes![0]!.diff='@@ changed preview @@';await b.text('codex-approvals','changed preview');assert.equal(await page.locator('#codex-confirm-submit').isDisabled(),true);await page.locator('#codex-confirm-cancel').click();assert.equal(c.calls.some(v=>v.method==='approval'),false);
  await page.locator('#codex-approvals [data-decision="accept"]').click();await page.locator('#codex-confirm-check').check();await page.locator('#codex-confirm-submit').click();await page.waitForFunction(()=>document.getElementById('codex-approval-section')?.hidden===true);
  assert.equal(c.calls.filter(v=>v.method==='approval').length,1);
  await page.locator('#codex-interrupt').click();await b.text('codex-policy','interrupted');
  // Lose HTTP acknowledgement after the actual service has durably recorded the action.
  await page.route('**/v1/codex/action',async(route:any)=>{const response=await route.fetch();assert.equal(response.status(),200);await route.abort('failed');},{times:1});
  const beforeLoss=c.calls.filter(v=>v.method==='turn-start').length;
  await page.locator('#codex-composer').fill('Fixture lost HTTP ack');await page.locator('#codex-submit').click();await page.waitForFunction(()=>!document.getElementById('codex-unknown')?.hidden);await b.text('codex-unknown-requests','acknowledged');
  assert.equal(c.calls.filter(v=>v.method==='turn-start').length,beforeLoss+1);assert.equal(await page.locator('#codex-submit').isDisabled(),true);await b.ready('codex-acknowledge');await page.locator('#codex-acknowledge').click();assert.equal(await page.locator('#codex-unknown').isVisible(),false);
  // A real service action may still await acknowledgement; safety requests remain independent.
  await page.locator('#codex-interrupt').click();await b.text('codex-policy','interrupted');c.hold();await page.locator('#codex-composer').fill('Fixture held turn');await page.locator('#codex-submit').click();await b.ready('codex-interrupt');
  assert.equal(h.service.state().busy,true);assert.equal(await page.locator('#codex-disconnect').isDisabled(),false);assert.equal(await page.locator('#codex-revoke').isDisabled(),false);await page.locator('#codex-interrupt').click();await b.text('codex-policy','interrupted');assert.equal(await page.locator('#codex-submit').isDisabled(),true);c.release();await page.waitForFunction(()=>!document.getElementById('codex-unknown')?.textContent?.includes('pending'));
  await b.refresh();
  // Old HTTP snapshots cannot reconnect the UI after an explicit disconnect.
  let releaseReply:()=>void=()=>{},replyReady:()=>void=()=>{};
  const heldReply=new Promise<void>(r=>{releaseReply=r;}),acceptedReply=new Promise<void>(r=>{replyReady=r;});
  await page.route('**/v1/codex/action',async(route:any)=>{const response=await route.fetch();replyReady();await heldReply;await route.fulfill({response});},{times:1});
  await page.locator('#codex-composer').fill('Fixture old connection response');await b.ready('codex-submit');await page.locator('#codex-submit').click();await acceptedReply;await b.ready('codex-disconnect');await page.locator('#codex-disconnect').click();await b.text('codex-status','Not connected');const oldResponse=page.waitForResponse('**/v1/codex/action');releaseReply();await oldResponse;await b.ready('codex-connect');assert.equal(await page.locator('#codex-messages').textContent().then((v:string)=>v.includes('Fixture old connection response')),false);
  assert.equal(h.service.state().snapshot,null);
  // Collapse pauses ordinary background reads, while reopening fetches current metadata.
  await page.locator('#codex-panel>summary').click();await page.waitForTimeout(1800);const collapsedGets=h.gets;await page.waitForTimeout(1700);assert.equal(h.gets,collapsedGets);await page.locator('#go-codex').click();await page.waitForFunction(()=>Boolean((document.getElementById('codex-panel') as HTMLDetailsElement).open));await b.ready('codex-connect');
  await b.connect();await b.select();await page.locator('#codex-thread-start').click();await b.text('codex-policy','Read-only thread');
  // A native timeout stays unknown after GET reconciliation and reload. No turn is replayed.
  const latest=h.clients.at(-1)!;latest.loseAck();await page.locator('#codex-composer').fill('Synthetic native unknown acknowledgement');await page.locator('#codex-submit').click();await b.text('codex-unknown-requests','unknown');
  assert.equal(latest.calls.filter(call=>call.method==='turn-start').length,1);assert.equal(await page.locator('#codex-acknowledge').isDisabled(),true);
  if(process.env.ARCANE_UI_SCREENSHOT)await page.locator('#codex-panel').screenshot({path:process.env.ARCANE_UI_SCREENSHOT+'.codex-unknown.png'});
  await page.reload();await b.text('codex-unknown-requests','unknown');assert.equal(await page.locator('#codex-submit').isDisabled(),true);assert.equal(latest.calls.filter(call=>call.method==='turn-start').length,1);
  await page.evaluate(()=>{window.dispatchEvent(new PageTransitionEvent('pagehide'));window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));});
  await b.text('codex-unknown-requests','unknown');await b.refresh();assert.equal(latest.calls.filter(call=>call.method==='turn-start').length,1);assert.equal(await page.locator('#codex-acknowledge').isDisabled(),true);
  await page.locator('#codex-disconnect').click();await b.text('codex-status','Not connected');await b.ready('codex-acknowledge');await page.locator('#codex-acknowledge').click();
  await b.connect();assert.equal(await page.locator('#codex-model').inputValue(),'');assert.equal(await page.locator('#codex-thread-start').isDisabled(),true);await b.select();await page.locator('#codex-thread-start').click();await b.text('codex-policy','Read-only thread');
  if(process.env.ARCANE_UI_SCREENSHOT)await page.locator('#codex-panel').screenshot({path:process.env.ARCANE_UI_SCREENSHOT+'.codex-desktop.png'});
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  if(process.env.ARCANE_UI_SCREENSHOT)await page.locator('#codex-panel').screenshot({path:process.env.ARCANE_UI_SCREENSHOT+'.codex-mobile.png'});
  assert.deepEqual(await page.evaluate(()=>Object.keys(sessionStorage)),['arcane-lab-session']);assert.equal(await page.evaluate(()=>localStorage.length),0);
  assert.equal((await page.locator('#codex-panel').textContent()).includes(HUMAN),false);
  for(const input of b.posts)assert.deepEqual(codexActionInput.parse(input),input);assert.deepEqual(b.errors,[]);
  t.diagnostic('Installed Edge '+b.instance.version()+'; actual human-only service + synthetic host; '+h.connected+' fixture connections; no live inference or Studio calls.');
});

test('real Edge + spawned Node native client: metadata-only connect, native readonly thread, public approvals and human interruption', {skip:!browserModule,timeout:60000},async t=>{
  const h=await harness(t,true),b=await browser(t,h.origin),{page}=b;await b.open();await b.ready('codex-connect');assert.equal(h.connected,0);
  await b.connect();assert.equal(h.connected,1);assert.equal(h.children[0]!.snapshot().thread,null);
  await b.select();await page.locator('#codex-thread-start').click();await b.text('codex-policy','Read-only thread');await b.ready('codex-grant');await b.grant();
  await page.locator('#codex-composer').fill('Synthetic human turn; spawned Node only');await page.locator('#codex-submit').click();await b.text('codex-policy','inProgress');await b.text('codex-approvals','fixture test command');await b.text('codex-approvals','@@ fixture diff @@');
  assert.equal(await page.locator('.codex-approval').count(),2);assert.equal(await page.locator('#codex-submit').isDisabled(),true);
  const file=page.locator('.codex-approval').filter({hasText:'Review scoped file changes'});
  await file.locator('[data-decision="accept"]').click();await b.text('codex-confirm-preview','review.txt');await b.text('codex-confirm-preview',h.children[0]!.snapshot().connectionId);await page.locator('#codex-confirm-check').check();await page.locator('#codex-confirm-submit').click();await page.waitForFunction(()=>document.querySelectorAll('.codex-approval').length===1);
  await page.locator('.codex-approval [data-decision="decline"]').click();await page.waitForFunction(()=>document.querySelectorAll('.codex-approval').length===0);
  await page.locator('#codex-interrupt').click();await b.text('codex-policy','interrupted');await page.locator('#codex-disconnect').click();await b.text('codex-status','Not connected');
  const audit=(await readFile(join(h.directory,'audit-1.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  const inputs=audit.filter(v=>v.type==='input').map(v=>v.message);
  assert.equal(inputs.filter(v=>v.method==='thread/start').length,1);assert.equal(inputs.filter(v=>v.method==='turn/start').length,1);
  assert.equal(inputs.find(v=>v.method==='thread/start').params.sandbox,'read-only');
  assert.equal(inputs.find(v=>v.method==='turn/start').params.sandboxPolicy.type,'workspaceWrite');
  assert.equal(inputs.find(v=>v.method==='turn/start').params.effort,'ultra');
  assert.equal(inputs.filter(v=>v.result?.decision==='accept').length,1);assert.equal(inputs.filter(v=>v.result?.decision==='decline').length,1);
  assert.equal(inputs.filter(v=>v.method==='turn/interrupt').length,1);assert.deepEqual(b.errors,[]);
  t.diagnostic('Installed Edge '+b.instance.version()+'; real service + spawned-node-fixture JSONL; exactly one synthetic turn/start, no installed Codex inference or Studio calls.');
});

test('interleaved public items retain exact thread/turn/item identity and count gaps once',()=>{
  const s=snapshot(),history=new CodexTranscript();
  s.events=[{seq:1,type:'delta',threadId:'t',turnId:'v',itemId:'a',text:'same'},{seq:2,type:'delta',threadId:'t',turnId:'v',itemId:'b',text:'other'},{seq:3,type:'delta',threadId:'t',turnId:'v',itemId:'a',text:'same'},{seq:5,type:'delta',threadId:'t',turnId:'next',itemId:'a',text:'new turn'}];s.lastEventSeq=7;s.droppedEvents=1;
  history.consume(s);history.consume(s);
  assert.deepEqual(history.messages.map(m=>m.text),['samesame','other','new turn']);assert.equal(history.cursor,7);assert.equal(history.gaps,3);
  history.consume({...s,events:[{seq:8,type:'delta',threadId:'other',turnId:'v',itemId:'a',text:'new thread'}],lastEventSeq:8});assert.equal(history.gaps,3);assert.equal(history.messages.length,4);
});

test('malformed action receipts remain unknown even when the HTTP status says acknowledged',async()=>{
  const st=state(),input=prepareCodexAction(st,'disconnect');
  const record={requestId:input.requestId,action:input.action,connectionId:input.connectionId,state:'acknowledged',errorCode:null,threadId:null,turnId:null,model:null,effort:null,createdAt:new Date().toISOString(),finishedAt:null};
  for(const patch of [{threadId:{}},{effort:'x'.repeat(65)},{errorCode:[]},{createdAt:'not a timestamp'}]){
    const api=new CodexChatApi(HUMAN,async()=>Response.json({record:{...record,...patch},replayed:false,state:st}));
    await assert.rejects(api.action(input),(e:unknown)=>e instanceof CodexHttpError&&e.unknown);
  }
  await assert.rejects(new CodexChatApi(HUMAN,async()=>Response.json({record,replayed:false,state:{...st,provider:'other'}})).action(input),(e:unknown)=>e instanceof CodexHttpError&&e.unknown);
});




test('oversized native state is explicitly compacted without lying about accepted actions or hiding stop controls', {skip:!browserModule,timeout:60000},async t=>{
  const h=await harness(t),b=await browser(t,h.origin);await b.open();await b.connect();await b.select();await b.page.locator('#codex-thread-start').click();await b.text('codex-policy','Read-only thread');
  const client=h.clients[0]!;client.s.thread={...client.s.thread!,writeGranted:true,turnId:'fixture-large-turn',turnStatus:'inProgress'};
  const a=approval(client.s,h.projectPath);a.command=null;a.cwd=null;a.method='item/fileChange/requestApproval';a.changes=[{path:'src/review.ts',kind:'update',movePath:null,diff:'x'.repeat(65536)}];
  client.s.approvals=Array.from({length:16},(_,n)=>({...a,handle:randomUUID(),itemId:'fixture-large-'+n,changes:Array.from({length:8},()=>({...a.changes![0]!}))}));
  await b.refresh();await b.text('codex-profile','Display limited:');assert.equal(await b.page.locator('#codex-submit').isDisabled(),true);assert.equal(await b.page.locator('#codex-revoke').isDisabled(),false);assert.equal(await b.page.locator('#codex-disconnect').isDisabled(),false);assert.equal(await b.page.locator('#codex-approvals [data-decision="accept"]').count(),0);
  const result=await h.post(prepareCodexAction(state(client.s,h.projectPath),'approval',{threadId:a.threadId,turnId:a.turnId,handle:client.s.approvals[0]!.handle,decision:'decline'}));assert.equal(result.status,200);assert.equal(result.body.record.state,'acknowledged');t.diagnostic('Overflow after action '+JSON.stringify({bytes:Buffer.byteLength(JSON.stringify(h.service.state())),approvals:h.service.state().snapshot?.approvals.length,limited:result.body.state.displayLimited,replyApprovals:result.body.state.snapshot?.approvals.length}));assert.equal(result.body.state.displayLimited,true);assert.equal(client.calls.filter(x=>x.method==='approval').length,1);
  await b.page.locator('#codex-disconnect').click();await b.text('codex-status','Not connected');assert.equal(h.service.state().snapshot,null);assert.deepEqual(b.errors,[]);
});
