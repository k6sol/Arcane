import { workflowNativeModel } from '../../apps/daemon/src/workflow-native-model.js';
import type { WorkflowDraftProvenance } from '../../apps/desktop/src/workflow-panel.js';
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
import { CodexChat, CodexChatApi, CodexHttpError, CodexTranscript, CODEX_STATE_BYTES, prepareCodexAction, readCodexState, approvalEligible, approvalFingerprint, autoApprovalVerdict, type ChatState, type ChatSnapshot } from '../../apps/desktop/src/codex-chat.js';

const HUMAN='a'.repeat(64), AGENT='b'.repeat(64), PROJECT=resolve('.');
function snapshot():Snapshot {
  return {connectionId:randomUUID(),provenance:'spawned-node-fixture',connected:true,ready:true,account:{auth:'subscription',plan:'fixture',requiresOpenaiAuth:true},models:[{model:'fixture-sol',id:'picker-sol',displayName:'Fixture model <img src=x onerror=alert(1)>',efforts:['low','ultra'],defaultEffort:'low',entitlement:'unverified'}],selection:null,thread:null,operations:[],approvals:[],events:[],droppedEvents:0,lastEventSeq:0,failureCode:null};
}
function state(s:ChatSnapshot|null=snapshot(),projectPath=PROJECT):ChatState {return {provider:'codex',use:'personal-local',projectPath,connecting:false,closing:false,busy:false,snapshot:s,lastSnapshot:null,actions:[],nativeTools:{configured:true,verified:false}};}
function thread():ThreadState {return {threadId:'fixture-thread',sessionId:'fixture-session',selection:{model:'fixture-sol',effort:'ultra'},configured:true,writeGranted:false,turnId:null,turnStatus:'idle'};}
function approval(s:Snapshot,projectPath=PROJECT):Approval {return {handle:randomUUID(),connectionId:s.connectionId,serverRequestId:7,method:'item/commandExecution/requestApproval',threadId:s.thread!.threadId,turnId:s.thread!.turnId!,itemId:'fixture-command',reason:'Fixture only',command:'fixture command <script>window.injected=true</script>',cwd:projectPath,changes:null,canAccept:true,expiresAt:Date.now()+60000};}

test('browser action envelopes exactly match service schemas, with UUIDs and no host configuration',()=>{
  const st=state(), fields:Record<string,Record<string,unknown>>={connect:{},disconnect:{},select:{model:'fixture-sol',effort:'ultra'},'thread-start':{},'thread-resume':{threadId:'human-exact-id'},'grant-writes':{threadId:'fixture-thread'},'revoke-writes':{threadId:'fixture-thread'},'turn-start':{threadId:'fixture-thread',text:'Human public text'},'turn-interrupt':{threadId:'fixture-thread',turnId:'exact-turn'},approval:{threadId:'fixture-thread',turnId:'exact-turn',handle:'exact-handle',decision:'accept'},'history-load':{threadId:'fixture-thread'}};
  for(const [action,args] of Object.entries(fields)){const request=prepareCodexAction(st,action,args);assert.deepEqual(codexActionInput.parse(request),request);assert.equal(request.connectionId,action==='connect'?null:st.snapshot!.connectionId);}
  for(const key of ['initiatedBy','exe','cwd','config','modelProvider'])assert.throws(()=>prepareCodexAction(st,'connect',{[key]:'injected'}),/exact browser envelope/);
  assert.throws(()=>prepareCodexAction(st,'select',{model:'unreported',effort:'ultra'}),/reported/);
  assert.throws(()=>prepareCodexAction(st,'select',{model:'fixture-sol',effort:'max'}),/reported/);
  assert.throws(()=>prepareCodexAction(null,'disconnect'),/exact reported/);
  assert.throws(()=>prepareCodexAction(st,'thread-resume',{threadId:'\0'}),/scope ID/);
  assert.throws(()=>prepareCodexAction(st,'connect',{},'not-uuid'),/UUID/);
  assert.throws(()=>prepareCodexAction(st,'turn-start',{threadId:'fixture-thread',text:'🧩'.repeat(32769)}),/128 KiB/);
  assert.throws(()=>prepareCodexAction(st,'turn-start',{threadId:'fixture-thread',text:'  '}),/nonempty/);
  for(const preserveAssetWork of [true,false]) {
    const request=prepareCodexAction(st,'disconnect',{preserveAssetWork});assert.deepEqual(codexActionInput.parse(request),request);
  }
  for(const preserveAssetWork of ['true',1,null,undefined])assert.throws(()=>prepareCodexAction(st,'disconnect',{preserveAssetWork}),/boolean/);
  assert.throws(()=>prepareCodexAction(st,'thread-start',{preserveAssetWork:true}),/exact browser envelope/);
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
test('auto-approval accepts only already-eligible in-project work and keeps every hard fence',()=>{
  const s=snapshot();s.thread={...thread(),writeGranted:true,turnId:'turn',turnStatus:'inProgress'};const st=state(s),a=approval(s);
  const run=(command:string)=>autoApprovalVerdict(st,{...a,command});
  for(const command of ['npm test','npm run build && npm test','luau-analyze src/main.luau','selene src','stylua --check src','git status','git diff -- src/a.ts','git add src && git commit -m "wip"','rojo build -o game.rbxl','node scripts/check.mjs 2>/dev/null','powershell.exe -NoProfile -Command "npm test"','dir src','type '+PROJECT+'\\src\\a.ts'])
    assert.equal(run(command).accept,true,command);
  const fences:[string,RegExp][]=[['rm -rf build',/deletes/],['Remove-Item -Recurse src',/deletes/],['del src\\a.ts',/deletes/],['git reset --hard',/history/],['git clean -fdx',/history/],['git push origin main',/network/],
    ['curl https://example.invalid',/network/],['Invoke-WebRequest x',/network/],['npm install left-pad',/installs/],['npx something',/installs/],['pip install x',/installs/],['rojo upload --asset_id 1',/publishes/],['npm publish',/installs|publishes/],
    ['echo $env:OPENAI_API_KEY',/environment|credential/],['type %USERPROFILE%\\x',/environment/],['cat ~/.ssh/id_rsa',/environment|credential|network/],['cat .env',/credential/],['shutdown /s',/system/],['taskkill /F /IM Studio.exe',/system/],
    ['iex (irm x)',/network|hidden/],['powershell -EncodedCommand AAAA',/hidden/],['echo `whoami`',/hidden/],['cat ../secrets.txt',/outside|credential/],['type C:\\Windows\\win.ini',/outside/],['ls /etc',/outside/]];
  for(const [command,reason] of fences){const v=run(command);assert.equal(v.accept,false,command);assert.match(v.reason,reason,command);}
  // Obfuscated or indirect forms of the same fenced effects never auto-accept.
  for(const command of ['cmd /c de^l src\\a.ts','cmd /c mklink /J x %CD:~0,3%Users','powershell -e AAAA','powershell -ec AAAA','powershell –EncodedCommand AAAA',
    "& ('Remove'+'-Item') src","ri src -Recurse","[IO.File]::Delete('src/a.ts')","(New-Object Net.WebClient).DownloadString('x')",
    "node -e \"require('fs').rmSync('src',{recursive:true})\"",'python -c "import shutil"','find src -delete','robocopy empty src /MIR','ping data.example',
    'New-Item -ItemType Junction -Path x -Target y','ln -s y x','echo x > .git\\hooks\\pre-commit','git config core.hooksPath h','git -c core.fsmonitor=x status'])
    assert.equal(run(command).accept,false,command);
  assert.equal(run('echo dist >> .gitignore').accept,true,'.gitignore is an ordinary file');
  for(const command of ['echo note >> ARCANE.md','copy x .claude\\settings.json'])assert.equal(run(command).accept,false,command);
  const edit={...a,method:'item/fileChange/requestApproval' as const,command:null,cwd:null,changes:[{path:'src/a.ts',kind:'update' as const,movePath:null,diff:'@@'}]};
  for(const path of ['ARCANE.md','CLAUDE.md','AGENTS.md','.mcp.json','.claude/settings.json','.vscode/tasks.json','.arcane/sync.json','.github/workflows/x.yml','.husky/pre-commit'])
    assert.match(autoApprovalVerdict(st,{...edit,changes:[{...edit.changes[0]!,path}]}).reason,/project memory|agent/,path);
  assert.equal(run('x'.repeat(2001)).accept,false);assert.equal(run('npm test\nrm -rf /').accept,false);
  for(const patch of [{canAccept:false},{cwd:'outside'},{expiresAt:0},{turnId:'other'}])assert.equal(autoApprovalVerdict(st,{...a,command:'npm test',...patch}).accept,false,'never weaker than manual eligibility');
  const file={...a,method:'item/fileChange/requestApproval' as const,command:null,cwd:null,changes:[{path:'src/a.ts',kind:'update' as const,movePath:null,diff:'@@'}]};
  assert.deepEqual(autoApprovalVerdict(st,file),{accept:true,reason:'edit src/a.ts'});
  assert.equal(autoApprovalVerdict(st,{...file,changes:[{...file.changes[0]!,kind:'add' as const,path:'src/new.luau'},{...file.changes[0]!,path:'src/b.ts'}]}).accept,true);
  assert.match(autoApprovalVerdict(st,{...file,changes:[{...file.changes[0]!,kind:'delete' as const}]}).reason,/deletes files/);
  for(const path of ['.git/config','.env','config/.env.local','keys/server.pem','src/secrets.lua','.npmrc'])assert.equal(autoApprovalVerdict(st,{...file,changes:[{...file.changes[0]!,path}]}).accept,false,path);
  assert.equal(autoApprovalVerdict(st,{...file,changes:[{...file.changes[0]!,path:'../outside'}]}).accept,false);
  s.thread.writeGranted=false;assert.equal(autoApprovalVerdict(st,{...a,command:'npm test'}).accept,false,'no auto-accept without workspace writes');
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

function mockClient(projectPath:string,threadSuffix='') {
  const s=snapshot(); const calls:{method:string;value:unknown}[]=[];let hold:Promise<void>|null=null;let release:()=>void=()=>{};let number=0;let loseAck=false;
  const record=(method:string,value:unknown)=>{calls.push({method,value:structuredClone(value)});};
  const push=(delta:string)=>{const t=s.thread!;s.events.push({seq:++s.lastEventSeq,type:'delta',threadId:t.threadId,turnId:t.turnId!,itemId:'public-message',text:delta});};
  const host:CodexHostClient={
    snapshot(){return structuredClone(s);},
    async readRateLimits(a){record('usage-read',a);if(hold)await hold;s.rateLimits={source:'account/rateLimits/read',observedAt:Date.now(),ordinaryUsageAllowed:false,buckets:[{limitId:'codex',limitName:'Codex <img src=x onerror=alert(1)>',normalModelSlug:null,primary:{usedPercent:100,windowDurationMins:300,resetsAt:1792104000},secondary:null,credits:{hasCredits:false,unlimited:false},spendControlReached:null,rateLimitReachedType:'rate_limit_reached'}]};return structuredClone(s.rateLimits);},
    async readThreadHistory(a){record('history-read',a);return {entries:[{role:'user' as const,text:'Fixture saved user message',ids:{threadId:a.threadId,sessionId:s.thread!.sessionId,turnId:'saved-turn',itemId:'saved-user'}},{role:'assistant' as const,text:'Fixture imported native history <img src=x onerror=alert(1)>',ids:{threadId:a.threadId,sessionId:s.thread!.sessionId,turnId:'saved-turn',itemId:'saved-assistant'}}],completeness:'incomplete' as const,gaps:[{reason:'context-compaction' as const,turnId:'saved-turn'}],truncated:false,marker:'[History incomplete: some content was omitted or truncated.]',excludedItems:1,droppedGaps:0,redacted:false};},
    selectModel(a){record('select',a);s.selection={model:a.model,effort:a.effort};return {...s.selection};},
    async startThread(a){record('thread-start',a);s.thread={...thread(),threadId:'fixture-thread'+threadSuffix};return structuredClone(s.thread);},
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
async function harness(t:test.TestContext,spawned=false,distinctThreads=false) {
  const directory=await mkdtemp(join(tmpdir(),'arcane-codex-chat-')),projectPath=join(directory,'project');await mkdir(projectPath);
  const clients:ReturnType<typeof mockClient>[]=[];const children:CodexSession[]=[];let connected=0;
  const service=createCodexService({directory:join(directory,'journal'),projectPath,nativeToolsConfigured:true,connect:async()=>{
    connected++;
    if(spawned){const client=new CodexSession({command:process.execPath,args:[resolve('packages/codex-client/fixtures/protocol.mjs'),'approvals',join(directory,'audit-'+connected+'.jsonl')],cwd:projectPath,env:nativeEnvironment()},limits({requestTimeoutMs:1500,approvalTimeoutMs:15000}),'spawned-node-fixture');children.push(client);await client.initialize();return client;}
    const client=mockClient(projectPath,distinctThreads?'-'+connected:'');clients.push(client);return client.host;
  }});
  const routes=codexRoutes(service);let origin='';
  const build=process.env.ARCANE_UI_BUILD_DIR??'dist';
  const assets=new Map([['/studio',resolve('apps/desktop/public/studio.html')],['/studio.css',resolve('apps/desktop/public/studio.css')],['/studio.js',resolve(build,'apps/desktop/src/studio.js')],['/codex-chat.js',resolve(build,'apps/desktop/src/codex-chat.js')],['/workspace-shell.js',resolve(build,'apps/desktop/src/workspace-shell.js')], ['/asset-downloads.js', resolve(build,'apps/desktop/src/asset-downloads.js')],['/learning-panel.js',resolve(build,'apps/desktop/src/learning-panel.js')],['/brand/arcane-ridges.png',resolve('apps/desktop/public/brand/arcane-ridges.png')]]);
  for(const name of ['asset-viewer','automatic-asset-previews','glb-preflight']) assets.set('/'+name+'.js',resolve(process.env.ARCANE_UI_BUILD_DIR ?? 'dist','apps/desktop/src/'+name+'.js'));
  assets.set('/codex-history.js', resolve(process.env.ARCANE_UI_BUILD_DIR ?? 'dist', 'apps/desktop/src/codex-history.js'));
  assets.set('/desktop-verification.js', resolve(process.env.ARCANE_UI_BUILD_DIR ?? 'dist', 'apps/desktop/src/desktop-verification.js'));
  assets.set('/provider-setup.js', resolve(process.env.ARCANE_UI_BUILD_DIR ?? 'dist', 'apps/desktop/src/provider-setup.js'));
  assets.set('/native-handoff.js', resolve(process.env.ARCANE_UI_BUILD_DIR ?? 'dist', 'apps/desktop/src/native-handoff.js'));
  assets.set('/studio-key-settings.js', resolve(build, 'apps/desktop/src/studio-key-settings.js'));
  assets.set('/chat-tabs.js', resolve(process.env.ARCANE_UI_BUILD_DIR ?? 'dist', 'apps/desktop/src/chat-tabs.js'));
  assets.set('/chat-attachments.js', resolve(process.env.ARCANE_UI_BUILD_DIR ?? 'dist', 'apps/desktop/src/chat-attachments.js'));
  assets.set('/task-usage.js', resolve(process.env.ARCANE_UI_BUILD_DIR ?? 'dist', 'apps/desktop/src/task-usage.js'));
  assets.set('/task-usage-ui.js', resolve(process.env.ARCANE_UI_BUILD_DIR ?? 'dist', 'apps/desktop/src/task-usage-ui.js'));
  assets.set('/workflow-panel.js', resolve(process.env.ARCANE_UI_BUILD_DIR ?? 'dist', 'apps/desktop/src/workflow-panel.js'));
  assets.set('/playtest-panel.js', resolve(build, 'apps/desktop/src/playtest-panel.js'));
  assets.set('/toolbox-policy.js', resolve(process.env.ARCANE_UI_BUILD_DIR ?? 'dist', 'apps/desktop/src/toolbox-policy.js'));
  assets.set('/playtest-toggle.js', resolve(build, 'apps/desktop/src/playtest-toggle.js'));
  for(const [path,file] of await productDesktopModules(build))if(!assets.has(path))assets.set(path,file);
  let gets=0;
  const server=createServer((request,response)=>{void(async()=>{
    const url=new URL(request.url??'/',origin),asset=assets.get(url.pathname);
    if(asset){response.writeHead(200,{'Content-Type':url.pathname.endsWith('.png')?'image/png':url.pathname.endsWith('.js')?'text/javascript':url.pathname.endsWith('.css')?'text/css':'text/html','Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"});response.end(await readFile(asset));return;}
    if(url.pathname==='/v1/product/state'){const human=request.headers.authorization==='Bearer '+HUMAN;response.writeHead(human?200:403,{'Content-Type':'application/json'});response.end(JSON.stringify(human?{projectPath,protocolVersion:1,studioSessions:[],commandCounts:{},features:{},buildTasks:[]}:{error:'HUMAN_ONLY'}));return;}
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
  const refresh=async()=>{await openAdvancedSettings(page);await (await visibleControl(page,'#codex-refresh')).click();await page.waitForTimeout(60);};
  const open=async(token=HUMAN)=>{try{await page.goto(origin+'/studio#'+token);await page.reload();await ready('codex-refresh');await openAdvancedSettings(page);await (await visibleControl(page,'#auto-refresh')).uncheck();}catch(error){t.diagnostic('Browser mount diagnostic '+JSON.stringify(await page.evaluate(()=>({title:document.title,refresh:document.getElementById('codex-refresh')?.outerHTML,notice:document.getElementById('codex-notice')?.textContent,main:document.getElementById('notice')?.textContent})))+' errors '+errors.join(';'));throw error;}};
  const connect=async()=>{await openAdvancedSettings(page);await ready('codex-connect');await (await visibleControl(page,'#codex-connect')).click();await text('codex-status','Test connection');await ready('codex-disconnect');};
  const select=async()=>{
    const active=page.locator('#workspace-chat-tabs [role="tab"][aria-selected="true"]');
    if(await active.count() && (await active.getAttribute('title'))!=='Unsent local draft') {
      if(await page.locator('#settings-drawer').isVisible())await page.locator('[data-settings-close]').click();
      await page.locator('#workspace-new-chat').click();
    }
    if(await page.locator('#settings-drawer').isVisible())await page.locator('[data-settings-close]').click();
    const before=posts.length;
    await page.locator('#codex-model-trigger').click();
    await page.locator('#codex-picker-current-model').click();
    await page.locator('[data-picker-model="fixture-sol"]').click();
    await page.locator('#codex-model-trigger').click();
    await page.locator('#codex-picker-effort-slider').press('End');
    await text('codex-effort-label','ultra');await ready('codex-thread-start');
    assert.equal(posts.length,before,'A draft model choice is local until its explicit native open gesture');
  };
  const grant=async()=>{await openAdvancedSettings(page);await (await visibleControl(page,'#codex-grant')).click();await text('codex-confirm-preview','Workspace');assert.equal(await page.locator('#codex-confirm-submit').isDisabled(),true);await (await visibleControl(page,'#codex-confirm-check')).check();await (await visibleControl(page,'#codex-confirm-submit')).click();await text('codex-policy','Workspace editing enabled');};
  return {page,errors,posts,text,ready,refresh,open,connect,select,grant,instance};
}

test('real Edge account usage refresh preserves the draft and model while rendering bounded provider metadata as text', {skip:!browserModule,timeout:60000},async t=>{
  const h=await harness(t),b=await browser(t,h.origin),{page}=b;const usagePosts:unknown[]=[];
  page.on('request',(request:any)=>{if(request.url().endsWith('/v1/codex/usage'))usagePosts.push(request.postDataJSON());});
  await b.open();assert.equal(usagePosts.length,0);await b.connect();const client=h.clients[0]!;
  await b.text('codex-usage-status','when the provider reports');assert.equal(usagePosts.length,0);
  await b.select();await page.locator('#codex-composer').fill('Keep this unsent project request.');
  const selectedModel=await page.locator('#codex-model').inputValue(),selectedEffort=await page.locator('#codex-effort').inputValue();
  await openAdvancedSettings(page);await (await visibleControl(page,'#codex-refresh-usage')).click();
  await b.text('codex-usage-status','included usage is blocked');await b.text('codex-usage-buckets','100% used');
  assert.deepEqual(usagePosts,[{connectionId:client.s.connectionId}]);assert.equal(client.calls.filter(row=>row.method==='usage-read').length,1);
  assert.equal(b.posts.filter(row=>row.action==='turn-start'||row.action==='thread-start'||row.action==='select').length,0);
  assert.equal(client.s.selection,null);assert.equal(client.s.thread,null);assert.equal(await page.locator('#codex-usage-buckets img, #codex-usage-buckets script').count(),0);
  assert.equal(await page.locator('#codex-composer').inputValue(),'Keep this unsent project request.');
  assert.equal(await page.locator('#codex-model').inputValue(),selectedModel);assert.equal(await page.locator('#codex-effort').inputValue(),selectedEffort);
  assert.ok((await page.locator('#codex-usage-buckets').textContent())!.includes('<img src=x onerror=alert(1)>'));
  assert.equal(await page.locator('#codex-refresh-usage').isDisabled(),false);
  if(process.env.ARCANE_UI_SCREENSHOT)await page.locator('#codex-usage-details').screenshot({path:process.env.ARCANE_UI_SCREENSHOT+'.quota-desktop-synthetic.png'});
  await page.setViewportSize({width:390,height:844});
  if(process.env.ARCANE_UI_SCREENSHOT)await page.locator('#codex-usage-details').screenshot({path:process.env.ARCANE_UI_SCREENSHOT+'.quota-mobile-synthetic.png'});
  assert.equal(await page.locator('#codex-usage-details').evaluate((el:HTMLElement)=>el.scrollWidth<=el.clientWidth),true);
  assert.deepEqual(b.errors,[]);
});

test('real Edge Send opens a selected draft and submits once; Enter sends and Stop retains its exact target', {skip:!browserModule,timeout:60000},async t=>{
  const h=await harness(t),b=await browser(t,h.origin),{page}=b;
  await b.open();await b.connect();await b.select();
  assert.equal(h.clients.at(-1)!.s.thread,null,'Metadata setup must not start a conversation or turn');
  if(await page.locator('#settings-drawer').isVisible())await page.locator('[data-settings-close]').click();
  const message='Build a clean circular spawn. Synthetic UI test only.';
  await page.locator('#codex-composer').fill(message);await b.ready('codex-submit');
  await page.locator('#codex-submit').click();await b.text('codex-messages','samesame public');
  const client=h.clients.at(-1)!;
  assert.equal(client.calls.filter(row=>row.method==='thread-start').length,1);
  assert.equal(client.calls.filter(row=>row.method==='turn-start').length,1);
  assert.equal(b.posts.filter(row=>row.action==='turn-start').length,1);
  assert.equal(b.posts.find(row=>row.action==='turn-start').text,message);
  assert.equal(await page.locator('#codex-composer').inputValue(),'');
  assert.equal(await page.locator('.composer-tool-context').isVisible(),false);
  assert.equal(client.s.thread!.writeGranted,false,'Sending is not a write grant');
  const stop=page.locator('#codex-submit');assert.equal(await stop.getAttribute('aria-label'),'Stop task');
  await stop.click();await b.text('codex-policy','interrupted');
  assert.equal(client.calls.filter(row=>row.method==='turn-interrupt').length,1);
  await page.locator('#codex-composer').fill('Second synthetic message');await b.ready('codex-submit');
  await page.locator('#codex-composer').press('Shift+Enter');
  assert.equal(client.calls.filter(row=>row.method==='turn-start').length,1);
  await page.locator('#codex-composer').press('Enter');
  await page.waitForFunction(()=>document.getElementById('codex-submit')?.getAttribute('aria-label')==='Stop task');
  assert.equal(client.calls.filter(row=>row.method==='turn-start').length,2);
  assert.equal(client.calls.filter(row=>row.method==='thread-start').length,1);
  // Native threads cannot be rewound from Arcane: "Edit as new message" copies the text into the message box and sends nothing.
  const edit=page.locator('#codex-messages .codex-message.human .chat-message-edit').first();
  assert.equal(await edit.innerText(),'Edit as new message');
  await edit.click();
  assert.equal(await page.locator('#codex-composer').inputValue(),message);
  assert.equal(client.calls.filter(row=>row.method==='turn-start').length,2,'Edit as new message never sends');
  if(process.env.ARCANE_UI_SCREENSHOT)await page.locator('#codex-panel').screenshot({path:process.env.ARCANE_UI_SCREENSHOT+'.chat-send-synthetic.png'});
  assert.deepEqual(b.errors,[]);
  t.diagnostic('Actual Edge, production UI and durable service with labelled synthetic native clients. No paid inference or Studio operations.');
});

test('real Edge chat navigation preserves asynchronous work while the explicit Disconnect button keeps stop semantics', {skip:!browserModule,timeout:60000},async t=>{
  const h=await harness(t,false,true),b=await browser(t,h.origin),{page}=b;
  await b.open();await b.connect();await b.select();
  await page.locator('#codex-composer').fill('First synthetic navigation task');await b.ready('codex-submit');await page.locator('#codex-submit').click();
  await b.text('codex-scope','fixture-thread-1');await b.text('codex-messages','samesame public');
  h.clients[0]!.s.thread!.turnStatus='completed';await b.refresh();await b.text('codex-policy','completed');
  if(await page.locator('#settings-drawer').isVisible())await page.locator('[data-settings-close]').click();
  await page.locator('#workspace-new-chat').click();await b.select();
  await page.locator('#codex-composer').fill('Second synthetic navigation task');await b.ready('codex-submit');await page.locator('#codex-submit').click();
  await b.text('codex-scope','fixture-thread-2');await b.text('codex-messages','Second synthetic navigation task');
  const navigation=b.posts.filter(row=>row.action==='disconnect');assert.equal(navigation.length,1);
  assert.equal(navigation[0].preserveAssetWork,true);assert.equal(h.clients[0]!.s.connected,false);
  await openAdvancedSettings(page);await b.ready('codex-disconnect');await (await visibleControl(page,'#codex-disconnect')).click();
  await b.text('codex-status','Not connected');
  const disconnects=b.posts.filter(row=>row.action==='disconnect');assert.equal(disconnects.length,2);
  assert.equal(Object.hasOwn(disconnects[1],'preserveAssetWork'),false,'Explicit Disconnect keeps the default stop-owned-work intent.');
  for(const client of h.clients)for(const call of client.calls)assert.equal(Object.hasOwn(call.value as object,'preserveAssetWork'),false,'Teardown intent is never forwarded to the native provider.');
  assert.deepEqual(b.errors,[]);
  t.diagnostic('Actual Edge navigation/button envelopes and durable service; accepted-worker survival is independently exercised with bounded child processes.');
});

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
  await b.connect();let c=h.clients[0]!,connectionId=c.s.connectionId;
  assert.equal(c.calls.length,0);assert.equal(await page.locator('#codex-model').inputValue(),'');assert.equal(await page.locator('#codex-effort').inputValue(),'');assert.equal(await page.locator('#codex-thread-start').isDisabled(),true);
  await b.text('codex-profile','profile requested · verified:false');assert.equal(await page.locator('#codex-panel img, #codex-panel script').count(),0);
  await b.select();await (await visibleControl(page,'#codex-thread-start')).click();await b.text('codex-scope','fixture-thread');
  assert.equal(h.service.state().nativeThreads?.[0]?.projectPath,h.projectPath);
  assert.equal(h.service.state().nativeThreads?.[0]?.sessionId,'fixture-session');
  assert.equal(c.calls.filter(v=>v.method==='thread-start').length,1);
  await (await visibleControl(page,'#codex-disconnect')).click();await b.text('codex-status','Not connected');await b.connect();
  await (await visibleControl(page,'#codex-resume-id')).fill('unowned-raw-thread');assert.equal(await page.locator('#codex-thread-resume').isDisabled(),true);
  await (await visibleControl(page,'#codex-resume-id')).fill('fixture-thread');await b.ready('codex-thread-resume');await (await visibleControl(page,'#codex-thread-resume')).click();await b.text('codex-scope','fixture-thread');await b.ready('codex-grant');
  c=h.clients.at(-1)!;connectionId=c.s.connectionId;
  assert.equal(c.calls.some(v=>v.method==='thread-start'),false);assert.equal(c.s.thread!.writeGranted,false);
  await (await visibleControl(page,'#codex-grant')).click();await b.text('codex-confirm-preview',connectionId);await b.text('codex-confirm-preview','fixture-thread');await b.text('codex-confirm-preview',h.projectPath);
  await (await visibleControl(page,'#codex-confirm-check')).check();c.s.thread!.threadId='changed-thread-scope';await b.text('codex-scope','changed-thread-scope');assert.equal(await page.locator('#codex-confirm-submit').isDisabled(),true);await (await visibleControl(page,'#codex-confirm-cancel')).click();assert.equal(c.s.thread!.writeGranted,false);
  c.s.thread!.threadId='fixture-thread';await b.refresh();await b.text('codex-scope','fixture-thread');await b.grant();
  // Delay a granted HTTP snapshot, revoke without emitting events, then deliver the old reply.
  await (await visibleControl(page,'#codex-revoke')).click();await b.text('codex-policy','Send enables workspace editing for the next task');
  let releaseGrant:()=>void=()=>{},grantReady:()=>void=()=>{};
  const grantHeld=new Promise<void>(done=>{releaseGrant=done;}),grantAccepted=new Promise<void>(done=>{grantReady=done;});
  await page.route('**/v1/codex/action',async(route:any)=>{const response=await route.fetch();grantReady();await grantHeld;await route.fulfill({response});},{times:1});
  await (await visibleControl(page,'#codex-grant')).click();await (await visibleControl(page,'#codex-confirm-check')).check();await (await visibleControl(page,'#codex-confirm-submit')).click();await grantAccepted;
  await (await visibleControl(page,'#codex-revoke')).click();await b.text('codex-policy','Send enables workspace editing for the next task');
  await page.evaluate(()=>{const seen:string[]=[];(window as unknown as {policySeen:string[]}).policySeen=seen;new MutationObserver(()=>{seen.push(document.getElementById('codex-policy')!.textContent!);}).observe(document.getElementById('codex-policy')!,{childList:true});});
  const grantResponse=page.waitForResponse('**/v1/codex/action');releaseGrant();await (await grantResponse).finished();await b.ready('codex-grant');
  assert.equal(c.s.thread!.writeGranted,false);assert.equal(await page.evaluate(()=>(window as unknown as {policySeen:string[]}).policySeen.some(s=>s.includes('writes granted'))),false);await b.grant();
  await (await visibleControl(page,'#codex-composer')).fill('🧩'.repeat(32769));assert.equal(await page.locator('#codex-submit').isDisabled(),true);
  const beforeTyping=b.posts.length;await (await visibleControl(page,'#codex-composer')).fill('Fixture human message <script>window.injected=true</script>');assert.equal(b.posts.length,beforeTyping);
  await (await visibleControl(page,'#codex-submit')).click();await b.text('codex-policy','inProgress');await b.text('codex-messages','samesame public');assert.equal(await page.locator('#codex-submit').isDisabled(),false);assert.equal(await page.locator('#codex-submit').getAttribute('aria-label'),'Stop task');assert.equal(await page.locator('#codex-submit').getAttribute('type'),'button');
  if(process.env.ARCANE_UI_SCREENSHOT)await page.locator('#codex-panel').screenshot({path:process.env.ARCANE_UI_SCREENSHOT+'.codex-conversation.png'});
  const output=await page.locator('#codex-messages').textContent();await b.refresh();assert.equal(await page.locator('#codex-messages').textContent(),output);assert.equal(await page.locator('#codex-messages script, #codex-messages img').count(),0);assert.equal(await page.evaluate(()=>Boolean((window as unknown as {injected?:boolean}).injected)),false);
  const a=approval(c.s,h.projectPath);a.canAccept=false;c.s.approvals=[a];await b.refresh();await b.text('codex-approvals','fixture command');assert.equal(await page.locator('#codex-approvals [data-decision="accept"]').isDisabled(),true);
  const file:Approval={...a,canAccept:true,method:'item/fileChange/requestApproval',command:null,cwd:null,itemId:'full-file',changes:[{path:'src/full.ts',kind:'update',movePath:null,diff:'@@ full scoped diff @@\n'+('+line\n'.repeat(2000))+'+FULL-END <img src=x onerror=alert(1)>'}]};
  c.s.approvals=[file];await b.refresh();await b.text('codex-approvals','FULL-END');assert.equal(await page.locator('#codex-approvals img').count(),0);
  await (await visibleControl(page,'#codex-approvals [data-decision="accept"]')).click();for(const id of [file.connectionId,file.threadId,file.turnId,file.handle,file.itemId])await b.text('codex-confirm-preview',id);await b.text('codex-confirm-preview','FULL-END');await (await visibleControl(page,'#codex-confirm-check')).check();
  if(process.env.ARCANE_UI_SCREENSHOT)await page.locator('#codex-confirm').screenshot({path:process.env.ARCANE_UI_SCREENSHOT+'.codex-approval.png'});
  file.changes![0]!.diff='@@ changed preview @@';await b.text('codex-approvals','changed preview');assert.equal(await page.locator('#codex-confirm-submit').isDisabled(),true);await (await visibleControl(page,'#codex-confirm-cancel')).click();assert.equal(c.calls.some(v=>v.method==='approval'),false);
  await (await visibleControl(page,'#codex-approvals [data-decision="accept"]')).click();await (await visibleControl(page,'#codex-confirm-check')).check();await (await visibleControl(page,'#codex-confirm-submit')).click();await page.waitForFunction(()=>document.getElementById('codex-approval-section')?.hidden===true);
  assert.equal(c.calls.filter(v=>v.method==='approval').length,1);
  await (await visibleControl(page,'#codex-interrupt')).click();await b.text('codex-policy','interrupted');
  // Lose HTTP acknowledgement after the actual service has durably recorded the action.
  await page.route('**/v1/codex/action',async(route:any)=>{const response=await route.fetch();assert.equal(response.status(),200);await route.abort('failed');},{times:1});
  const beforeLoss=c.calls.filter(v=>v.method==='turn-start').length;
  await (await visibleControl(page,'#codex-composer')).fill('Fixture lost HTTP ack');await (await visibleControl(page,'#codex-submit')).click();await page.waitForFunction(()=>!document.getElementById('codex-unknown')?.hidden);await b.text('codex-unknown-requests','acknowledged');
  assert.equal(c.calls.filter(v=>v.method==='turn-start').length,beforeLoss+1);assert.equal(await page.locator('#codex-submit').getAttribute('aria-label'),'Stop task');assert.equal(await page.locator('#codex-submit').getAttribute('type'),'button');await b.ready('codex-acknowledge');await (await visibleControl(page,'#codex-acknowledge')).click();assert.equal(await page.locator('#codex-unknown').isVisible(),false);
  // A real service action may still await acknowledgement; safety requests remain independent.
  await (await visibleControl(page,'#codex-interrupt')).click();await b.text('codex-policy','interrupted');c.hold();await (await visibleControl(page,'#codex-composer')).fill('Fixture held turn');await (await visibleControl(page,'#codex-submit')).click();await b.ready('codex-interrupt');
  assert.equal(h.service.state().busy,true);assert.equal(await page.locator('#codex-disconnect').isDisabled(),false);assert.equal(await page.locator('#codex-revoke').isDisabled(),false);await (await visibleControl(page,'#codex-interrupt')).click();await b.text('codex-policy','interrupted');assert.equal(await page.locator('#codex-submit').isDisabled(),true);c.release();await page.waitForFunction(()=>!document.getElementById('codex-unknown')?.textContent?.includes('pending'));
  await b.refresh();
  // Old HTTP snapshots cannot reconnect the UI after an explicit disconnect.
  let releaseReply:()=>void=()=>{},replyReady:()=>void=()=>{};
  const heldReply=new Promise<void>(r=>{releaseReply=r;}),acceptedReply=new Promise<void>(r=>{replyReady=r;});
  await page.route('**/v1/codex/action',async(route:any)=>{const response=await route.fetch();replyReady();await heldReply;await route.fulfill({response});},{times:1});
  await (await visibleControl(page,'#codex-composer')).fill('Fixture old connection response');await b.ready('codex-submit');await (await visibleControl(page,'#codex-submit')).click();await acceptedReply;await b.ready('codex-disconnect');await (await visibleControl(page,'#codex-disconnect')).click();await b.text('codex-status','Not connected');const oldResponse=page.waitForResponse('**/v1/codex/action');releaseReply();await oldResponse;await b.ready('codex-connect');assert.equal(await page.locator('#codex-messages').textContent().then((v:string)=>v.includes('Fixture old connection response')),false);
  assert.equal(h.service.state().snapshot,null);
  // Signed-out presentation hides unavailable chat controls. Explicit metadata
  // reconnect restores the header. The main conversation has no collapse affordance (it stays open and keeps reading).
  await b.connect();
  await (await visibleControl(page,'#codex-panel>summary')).click();assert.equal(await page.locator('#codex-panel').evaluate((el:HTMLDetailsElement)=>el.open),true,'The conversation cannot be collapsed');await (await visibleControl(page,'#go-codex')).click();await page.waitForFunction(()=>Boolean((document.getElementById('codex-panel') as HTMLDetailsElement).open));
  await b.select();await (await visibleControl(page,'#codex-thread-start')).click();await b.text('codex-policy','Send enables workspace editing for the next task');
  // A native timeout stays unknown after GET reconciliation and reload. No turn is replayed.
  const latest=h.clients.at(-1)!;latest.loseAck();await (await visibleControl(page,'#codex-composer')).fill('Synthetic native unknown acknowledgement');await (await visibleControl(page,'#codex-submit')).click();await b.text('codex-unknown-requests','unknown');
  assert.equal(latest.calls.filter(call=>call.method==='turn-start').length,1);assert.equal(await page.locator('#codex-acknowledge').isDisabled(),true);
  if(process.env.ARCANE_UI_SCREENSHOT)await page.locator('#codex-panel').screenshot({path:process.env.ARCANE_UI_SCREENSHOT+'.codex-unknown.png'});
  await page.reload();await b.text('codex-unknown-requests','unknown');assert.equal(await page.locator('#codex-submit').getAttribute('type'),'button');assert.equal(await page.locator('#codex-submit').getAttribute('aria-label'),'Stop task');assert.equal(latest.calls.filter(call=>call.method==='turn-start').length,1);
  await page.evaluate(()=>{window.dispatchEvent(new PageTransitionEvent('pagehide'));window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));});
  await b.text('codex-unknown-requests','unknown');await b.refresh();assert.equal(latest.calls.filter(call=>call.method==='turn-start').length,1);assert.equal(await page.locator('#codex-acknowledge').isDisabled(),true);
  await (await visibleControl(page,'#codex-disconnect')).click();await b.text('codex-status','Not connected');await b.ready('codex-acknowledge');await (await visibleControl(page,'#codex-acknowledge')).click();
  await b.connect();await page.locator('[data-settings-close]').click();await page.locator('#workspace-new-chat').click();
  assert.equal(await page.locator('#codex-model').inputValue(),'fixture-sol','New chat preserves the previously selected model');await b.select();await (await visibleControl(page,'#codex-thread-start')).click();await b.text('codex-policy','Send enables workspace editing for the next task');
  if(process.env.ARCANE_UI_SCREENSHOT)await page.locator('#codex-panel').screenshot({path:process.env.ARCANE_UI_SCREENSHOT+'.codex-desktop.png'});
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  if(process.env.ARCANE_UI_SCREENSHOT)await page.locator('#codex-panel').screenshot({path:process.env.ARCANE_UI_SCREENSHOT+'.codex-mobile.png'});
  assert.deepEqual(await page.evaluate(()=>Object.keys(sessionStorage)),['arcane-lab-session']);
  const presentation=await page.evaluate(()=>Object.fromEntries(Object.entries(localStorage)));
  const chatKey='arcane.chat-tabs.v1:'+encodeURIComponent(h.projectPath);
  assert.deepEqual(Object.keys(presentation).sort(),[chatKey,'arcane.provider-presentation.v1'].sort());
  assert.deepEqual(JSON.parse(presentation['arcane.provider-presentation.v1']!),{version:1,provider:'codex'});
  const preferences=JSON.parse(presentation[chatKey]!);
  assert.deepEqual(Object.keys(preferences).sort(),['activeKey','projectPath','provider','tabs','version']);
  assert.equal(preferences.version,1);assert.equal(preferences.projectPath,h.projectPath);assert.equal(preferences.provider,'codex');
  assert.ok(preferences.tabs.length>0&&preferences.tabs.length<=16);
  assert.ok(preferences.tabs.some((tab:any)=>tab.key===preferences.activeKey));
  assert.ok(Buffer.byteLength(presentation[chatKey]!)<=512*1024);
  for(const tab of preferences.tabs){
    assert.deepEqual(Object.keys(tab).sort(),['draft','key','kind','localId','previewOpen','projectPath','provider','selection','sessionId','threadId','title','tool','workflowDraft']);
    assert.equal(tab.projectPath,h.projectPath);assert.equal(tab.provider,'codex');
    if(tab.selection)assert.deepEqual(Object.keys(tab.selection).sort(),['effort','model']);
  }
  assert.equal(JSON.stringify(presentation).includes(HUMAN),false);assert.equal(JSON.stringify(presentation).includes(AGENT),false);
  assert.equal((await page.locator('#codex-panel').textContent()).includes(HUMAN),false);
  for(const input of b.posts)assert.deepEqual(codexActionInput.parse(input),input);assert.deepEqual(b.errors,[]);
  t.diagnostic('Installed Edge '+b.instance.version()+'; actual human-only service + synthetic host; '+h.connected+' fixture connections; no live inference or Studio calls.');
});

test('real Edge + spawned Node native client: metadata-only connect, read-only setup then one-turn workspace editing, approvals and interruption', {skip:!browserModule,timeout:60000},async t=>{
  const h=await harness(t,true),b=await browser(t,h.origin),{page}=b;await b.open();await b.ready('codex-connect');assert.equal(h.connected,0);
  await b.connect();assert.equal(h.connected,1);assert.equal(h.children[0]!.snapshot().thread,null);
  await b.select();await (await visibleControl(page,'#codex-thread-start')).click();await b.text('codex-policy','Send enables workspace editing for the next task');assert.equal(h.children[0]!.snapshot().thread!.writeGranted,false);
  await (await visibleControl(page,'#codex-composer')).fill('Synthetic human turn; spawned Node only');await (await visibleControl(page,'#codex-submit')).click();await b.text('codex-policy','inProgress');await b.text('codex-approvals','fixture test command');await b.text('codex-approvals','@@ fixture diff @@');
  assert.equal(h.children[0]!.snapshot().thread!.writeGranted,true);
  assert.equal(b.posts.some(input=>input.action==='grant-writes'),false,'Ordinary Send needs no Advanced thread-grant gesture.');
  assert.equal(await page.locator('.codex-approval').count(),2);assert.equal(await page.locator('#codex-submit').isDisabled(),false);assert.equal(await page.locator('#codex-submit').getAttribute('aria-label'),'Stop task');
  await visibleControl(page,'#codex-approvals');const file=page.locator('.codex-approval').filter({hasText:'Review scoped file changes'});
  await file.locator('[data-decision="accept"]').click();await b.text('codex-confirm-preview','review.txt');await b.text('codex-confirm-preview',h.children[0]!.snapshot().connectionId);await (await visibleControl(page,'#codex-confirm-check')).check();await (await visibleControl(page,'#codex-confirm-submit')).click();await page.waitForFunction(()=>document.querySelectorAll('.codex-approval').length===1);
  await (await visibleControl(page,'.codex-approval [data-decision="decline"]')).click();await page.waitForFunction(()=>document.querySelectorAll('.codex-approval').length===0);
  await (await visibleControl(page,'#codex-interrupt')).click();await b.text('codex-policy','interrupted');assert.equal(h.children[0]!.snapshot().thread!.writeGranted,false);await (await visibleControl(page,'#codex-disconnect')).click();await b.text('codex-status','Not connected');
  const audit=(await readFile(join(h.directory,'audit-1.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  const inputs=audit.filter(v=>v.type==='input').map(v=>v.message);
  assert.equal(inputs.filter(v=>v.method==='thread/start').length,1);assert.equal(inputs.filter(v=>v.method==='turn/start').length,1);
  assert.equal(inputs.find(v=>v.method==='thread/start').params.sandbox,'read-only');
  assert.equal(inputs.find(v=>v.method==='turn/start').params.sandboxPolicy.type,'workspaceWrite');
  assert.equal(inputs.find(v=>v.method==='turn/start').params.allowWorkspaceWrites,undefined);
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
  const h=await harness(t),b=await browser(t,h.origin);await b.open();await b.connect();await b.select();await (await visibleControl(b.page,'#codex-thread-start')).click();await b.text('codex-policy','Send enables workspace editing for the next task');
  const client=h.clients[0]!;client.s.thread={...client.s.thread!,writeGranted:true,turnId:'fixture-large-turn',turnStatus:'inProgress'};
  const a=approval(client.s,h.projectPath);a.command=null;a.cwd=null;a.method='item/fileChange/requestApproval';a.changes=[{path:'src/review.ts',kind:'update',movePath:null,diff:'x'.repeat(65536)}];
  client.s.approvals=Array.from({length:16},(_,n)=>({...a,handle:randomUUID(),itemId:'fixture-large-'+n,changes:Array.from({length:8},()=>({...a.changes![0]!}))}));
  await b.refresh();await b.text('codex-profile','Display limited:');assert.equal(await b.page.locator('#codex-submit').isDisabled(),false);assert.equal(await b.page.locator('#codex-submit').getAttribute('aria-label'),'Stop task');assert.equal(await b.page.locator('#codex-submit').getAttribute('type'),'button');assert.equal(await b.page.locator('#codex-revoke').isDisabled(),false);assert.equal(await b.page.locator('#codex-disconnect').isDisabled(),false);assert.equal(await b.page.locator('#codex-approvals [data-decision="accept"]').count(),0);
  const result=await h.post(prepareCodexAction(state(client.s,h.projectPath),'approval',{threadId:a.threadId,turnId:a.turnId,handle:client.s.approvals[0]!.handle,decision:'decline'}));assert.equal(result.status,200);assert.equal(result.body.record.state,'acknowledged');t.diagnostic('Overflow after action '+JSON.stringify({bytes:Buffer.byteLength(JSON.stringify(h.service.state())),approvals:h.service.state().snapshot?.approvals.length,limited:result.body.state.displayLimited,replyApprovals:result.body.state.snapshot?.approvals.length}));assert.equal(result.body.state.displayLimited,true);assert.equal(client.calls.filter(x=>x.method==='approval').length,1);
  await (await visibleControl(b.page,'#codex-disconnect')).click();await b.text('codex-status','Not connected');assert.equal(h.service.state().snapshot,null);assert.deepEqual(b.errors,[]);
});

test('real Edge + human HTTP fixtures: explicit native open loads public history; later loads stay scoped and deduplicated',{skip:!browserModule,timeout:60000},async t=>{
  const h=await harness(t),b=await browser(t,h.origin),{page}=b;
  await b.open();assert.equal(h.connected,0);assert.equal(b.posts.length,0);
  await (await visibleControl(page,'#refresh')).click();await b.text('project-path',h.projectPath);
  await b.connect();await b.select();await (await visibleControl(page,'#codex-thread-start')).click();await b.text('codex-scope','fixture-thread');
  await b.text('codex-notice','Conversation ready.');
  const c=h.clients[0]!,before=c.calls.length,historyBefore=c.calls.filter(x=>x.method==='history-read').length;
  assert.equal(historyBefore,0,'A newly created conversation has no stored history, so its explicit open reads none');
  await (await visibleControl(page,'#codex-history-refresh')).click();
  try{await b.ready('codex-history-thread');}catch(error){t.diagnostic('History mount '+JSON.stringify(await page.evaluate(()=>({status:document.getElementById('codex-history-status')?.textContent,notice:document.getElementById('codex-history-notice')?.textContent,project:document.getElementById('project-path')?.textContent,scope:document.getElementById('codex-history-scope')?.textContent,disabled:(document.getElementById('codex-history-thread') as HTMLSelectElement)?.disabled})))+' pageErrors '+b.errors.join(';')+' binding '+JSON.stringify(h.service.state().nativeHistory));throw error;}
  assert.equal(c.calls.length,before,'cache read does not launch native history RPC');
  await (await visibleControl(page,'#codex-history-thread')).focus();
  await (await visibleControl(page,'#codex-history-thread')).press('End');
  await (await visibleControl(page,'#codex-history-thread')).press('Enter');
  await b.ready('codex-history-load');await (await visibleControl(page,'#codex-history-load')).click();
  await b.text('codex-history-status','History incomplete');
  await b.text('codex-history-entries','Fixture imported native history');
  await b.text('codex-history-gaps','context-compaction');
  assert.equal(c.calls.filter(x=>x.method==='history-read').length,historyBefore+1);
  assert.equal(c.calls.some(x=>['turn-start','grant-writes','thread-resume'].includes(x.method)),false);
  assert.equal(await page.locator('#codex-history-entries img, #codex-history-entries script').count(),0);
  // The new conversation's transcript starts empty; the explicit history load renders in the history panel above and never twice.
  assert.ok(await page.locator('#codex-messages .message-text').filter({hasText:'Fixture imported native history'}).count()<=1,'Saved public chat text is never duplicated');
  assert.equal(await page.locator('#codex-messages img, #codex-messages script').count(),0);
  assert.deepEqual(b.errors,[]);
  assert.equal(h.service.state().nativeHistory!.recorded!.result.entries.length,2);
  const total=b.posts.length;await page.reload();await b.ready('codex-refresh');
  assert.equal(b.posts.length,total,'reload must not automatically replay history-load');
  assert.equal(c.calls.filter(x=>x.method==='history-read').length,historyBefore+1);
});

// Serve exactly the desktop modules the daemon serves (parsed from lab-server.ts), so a new studio.js import can
// never leave this fixture booting a half-loaded page while the product itself works.
async function productDesktopModules(build: string): Promise<[string, string][]> {
  const source = await readFile(resolve('apps/daemon/src/lab-server.ts'), 'utf8');
  const modules = [...source.matchAll(/\['(\/[a-z0-9-]+\.js)',\s*\[join\(options\.cwd,\s*'dist\/apps\/desktop\/src\/([a-z0-9-]+\.js)'\)/g)]
    .map(match => [match[1]!, resolve(build, 'apps/desktop/src', match[2]!)] as [string, string]);
  assert.ok(modules.some(([path]) => path === '/studio.js') && modules.length > 20, 'lab-server desktop module list');
  return modules;
}

async function openAdvancedSettings(page:any, target='native-conversation-heading') {
  await page.evaluate((target:string)=>document.dispatchEvent(new CustomEvent('workspace:settingsrequest',{detail:{target}})),target);
  const drawer=page.locator('#settings-drawer');
  assert.equal(await drawer.evaluate((dialog:HTMLDialogElement)=>dialog.matches(':modal')),true);
  assert.equal(await drawer.locator('[data-settings-section]:visible').count(),1);
  assert.equal(await page.locator('#'+target).isVisible(),true);
}

async function visibleControl(page:any, selector:string) {
  assert.ok(!['#codex-model','#codex-effort','#codex-select'].includes(selector),'User access must use the visible chat picker');
  const locator=page.locator(selector);
  const context=await locator.evaluate((el:HTMLElement)=>({settings:!!el.closest('#settings-drawer'),confirmation:!!el.closest('#codex-confirm'),target:el.id}));
  // Navigation opens only the control's ancestor pane/details. Real user actions
  // still go through Edge, and the native confirmation remains the top modal.
  if(context.settings)await openAdvancedSettings(page,context.target);
  else if(!context.confirmation&&await page.locator('#settings-drawer').evaluate((dialog:HTMLDialogElement)=>dialog.open))await page.locator('[data-settings-close]').click();
  assert.equal(await locator.isVisible(),true,selector+' must be reachable through the production modal');
  return locator;
}


// Private document fixture; incoming state is decoded through the real API.
// No browser, socket, provider process or native action is used by these tests.
class ContextElement extends EventTarget {
  tagName=''; focusCount=0; focus():void{this.focusCount++;}
  children: ContextElement[] = []; value = ''; checked = false; disabled = false;
  hidden = false; open = false; className = ''; type = ''; dataset: Record<string, string> = {};
  scrollHeight = 0; scrollTop = 0; clientHeight = 0;
  private content = ''; private attributes = new Map<string, string>();
  get textContent(): string { return this.content + this.children.map(e => e.textContent).join(''); }
  set textContent(value: string) { this.children = []; this.content = value; }
  get innerHTML(): never { throw new Error('HTML sink forbidden'); }
  set innerHTML(_value: string) { throw new Error('HTML sink forbidden'); }
  append(...children: ContextElement[]): void { this.children.push(...children); }
  replaceChildren(...children: ContextElement[]): void { this.content = ''; this.children = children; }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  querySelectorAll(): ContextElement[] { return []; }
  showModal(): void { this.open = true; }
  close(): void { this.open = false; }
}
class ContextDocument extends EventTarget {
  private elements = new Map<string, ContextElement>();
  getElementById(id: string): ContextElement {
    let element = this.elements.get(id);
    if (!element) { element = new ContextElement(); if(id==='codex-composer')element.tagName='TEXTAREA'; this.elements.set(id, element); }
    return element;
  }
  createElement(): ContextElement { return new ContextElement(); }
  asDocument(): Document { return this as unknown as Document; }
}
function contextChat(initial: ChatState) {
  const doc = new ContextDocument(), calls: { path: string; method: string }[] = [];
  let observed = structuredClone(initial), failed = false;
  const api = new CodexChatApi(HUMAN, async (input, init) => {
    calls.push({ path: String(input), method: init?.method ?? 'GET' });
    assert.equal(init?.method, 'GET', 'Context reads must never dispatch native actions');
    if (failed) throw new Error('Synthetic unavailable state');
    return Response.json({ state: observed });
  });
  const chat = new CodexChat(doc.asDocument(), api);
  return { doc, calls, chat, set(value: ChatState) { observed = structuredClone(value); }, fail(value: boolean) { failed = value; } };
}
function cacheBinding(projectPath = PROJECT, threadId = 'cached-thread', sessionId: string | null = null): NonNullable<ChatState['nativeHistory']> {
  return { projectPath, threadId, sessionId, recorded: null };
}

test('synthetic workflow identity mirrors host configured-thread precedence and cached history fallback', async () => {
  const initial = state(null); initial.nativeHistory = cacheBinding();
  initial.lastSnapshot = { ...snapshot(), thread: { ...thread(), threadId: 'stale-last-thread' } };
  const f = contextChat(initial); let changes = 0; const unsubscribe = f.chat.subscribeWorkflowContextChange(() => changes++);
  await f.chat.refresh();
  assert.deepEqual(f.chat.workflowConversation(), { provider: 'codex', threadId: 'cached-thread', sessionId: null, projectPath: PROJECT });
  assert.equal(changes, 1);
  const same = state(snapshot()); same.nativeHistory = cacheBinding(); same.snapshot!.thread = { ...thread(), threadId: 'cached-thread', sessionId: null };
  f.set(same); await f.chat.refresh(); assert.equal(changes, 1, 'same durable identity is unchanged when a live handle arrives');
  same.snapshot!.thread = thread(); f.set(same); await f.chat.refresh(); assert.equal(changes, 2);
  assert.equal(f.chat.workflowConversation()!.threadId, 'fixture-thread', 'configured thread takes precedence over cache');
  same.snapshot!.thread!.configured = false; f.set(same); await f.chat.refresh(); assert.equal(changes, 3);
  assert.equal(f.chat.workflowConversation()!.threadId, 'cached-thread', 'unconfigured thread falls back to cache exactly as host does');
  same.snapshot = null; f.set(same); await f.chat.refresh(); assert.equal(changes, 3);
  unsubscribe(); same.nativeHistory = cacheBinding(PROJECT, 'new-cached-thread', 'new-session'); f.set(same); await f.chat.refresh(); assert.equal(changes, 3);
  assert.ok(f.calls.every(c => c.path === '/v1/codex/state' && c.method === 'GET'));
});

test('synthetic unrelated native polling never publishes context changes or clears the unsent draft', async () => {
  const initial = state(); initial.snapshot!.thread = thread(); initial.nativeHistory = cacheBinding(PROJECT, 'fixture-thread', 'fixture-session');
  const f = contextChat(initial), draft = 'Unsent draft 🧩\nKeep trailing spaces.  '; f.doc.getElementById('codex-composer').value = draft;
  let changes = 0; f.chat.subscribeWorkflowContextChange(() => changes++); await f.chat.refresh();
  const next = structuredClone(initial);
  next.snapshot!.thread!.turnId = 'new-turn'; next.snapshot!.thread!.turnStatus = 'inProgress'; next.snapshot!.thread!.writeGranted = true;
  next.snapshot!.thread!.selection.effort = 'low'; next.snapshot!.selection = { model: 'fixture-sol', effort: 'low' };
  next.snapshot!.models[0]!.displayName = 'Updated catalogue label'; next.busy = true;
  next.snapshot!.events = [{ type: 'delta', seq: 1, threadId: 'fixture-thread', turnId: 'new-turn', itemId: 'item', text: 'Actual public fixture text' }]; next.snapshot!.lastEventSeq = 1;
  for (let i = 0; i < 5; i++) { f.set(next); await f.chat.refresh(); }
  assert.equal(changes, 1); assert.equal(f.doc.getElementById('codex-composer').value, draft);
  assert.match(f.doc.getElementById('codex-messages').textContent, /Actual public fixture text/);
  next.snapshot = { ...snapshot(), thread: thread() }; f.set(next); await f.chat.refresh();
  assert.equal(changes, 1, 'new live connection handle is not a new canonical conversation');
  assert.equal(f.doc.getElementById('codex-composer').value, draft);
  f.fail(true); await f.chat.refresh(); assert.equal(changes, 1); assert.equal(f.doc.getElementById('codex-composer').value, draft);
});

test('synthetic canonical thread, session and project changes each publish once', async () => {
  const initial = state(null); initial.nativeHistory = cacheBinding(); const f = contextChat(initial);
  let changes = 0; f.chat.subscribeWorkflowContextChange(() => changes++); await f.chat.refresh();
  const next = structuredClone(initial); next.nativeHistory!.threadId = 'other-thread'; f.set(next); await f.chat.refresh(); assert.equal(changes, 2);
  next.nativeHistory!.sessionId = 'observed-session'; f.set(next); await f.chat.refresh(); assert.equal(changes, 3);
  next.nativeHistory!.sessionId = null; f.set(next); await f.chat.refresh(); assert.equal(changes, 4);
  next.projectPath = PROJECT + '-other'; next.nativeHistory!.projectPath = next.projectPath; f.set(next); await f.chat.refresh(); assert.equal(changes, 5);
  f.set(next); await f.chat.refresh(); assert.equal(changes, 5);
  next.nativeHistory = null; f.set(next); await f.chat.refresh(); assert.equal(changes, 6); assert.equal(f.chat.workflowConversation(), null);
});

test('synthetic recorded-history content refresh retains the same exact canonical identity', async () => {
  const initial = state(null); initial.nativeHistory = cacheBinding(); const f = contextChat(initial);
  let changes = 0; f.chat.subscribeWorkflowContextChange(() => changes++); await f.chat.refresh();
  initial.nativeHistory!.recorded = { requestId: randomUUID(), connectionId: randomUUID(), provenance: 'spawned-node-fixture', loadedAt: new Date().toISOString(),
    result: { entries: [], completeness: 'complete', gaps: [], truncated: false, marker: null, excludedItems: 0, droppedGaps: 0, redacted: false } };
  f.set(initial); await f.chat.refresh();
  initial.nativeHistory!.recorded!.loadedAt = new Date().toISOString(); f.set(initial); await f.chat.refresh(); assert.equal(changes, 1);
});

test('synthetic native context decoder rejects missing sessions and cross-project cached bindings', async () => {
  const initial = state(null); initial.nativeHistory = cacheBinding();
  for (const nativeHistory of [{ ...initial.nativeHistory, projectPath: PROJECT + '-other' }, { ...initial.nativeHistory, sessionId: undefined }, { ...initial.nativeHistory, threadId: '../browser-input' }, { ...initial.nativeHistory, recorded: [] }]) assert.throws(() => readCodexState({ ...initial, nativeHistory }));
  const live = snapshot(); live.thread = thread(); assert.throws(() => readCodexState({ ...state(live), snapshot: { ...live, thread: { ...live.thread, sessionId: undefined } } }));
  const f = contextChat(initial); let changes = 0; f.chat.subscribeWorkflowContextChange(() => changes++); await f.chat.refresh();
  const invalid = structuredClone(initial); invalid.nativeHistory!.projectPath += '-other'; f.set(invalid); await f.chat.refresh();
  assert.equal(changes, 1); assert.equal(f.chat.workflowConversation()!.threadId, 'cached-thread', 'invalid read cannot replace the last trusted identity');
});


function attestedState():ChatState {
  const initial=state();initial.snapshot!.selection={model:'fixture-sol',effort:'ultra'};initial.snapshot!.thread=thread();
  initial.workflowModel=workflowNativeModel(initial)!.proof;return initial;
}
test('host model proof is exact to project/connection/thread/session/catalogue, with no fallback for older clients',()=>{
  const original=attestedState();assert.deepEqual(readCodexState(original).workflowModel,original.workflowModel);
  assert.equal(readCodexState(state()).workflowModel,undefined);
  for(const patch of [{version:2},{source:'browser-invented'},{projectPath:PROJECT+'-other'},{connectionId:randomUUID()},{threadId:'other'},{sessionId:null},{provenance:'installed-cli'},{entitlement:'verified'},
    {selection:{...original.workflowModel!.selection,provider:'claude'}},{selection:{...original.workflowModel!.selection,model:'picker-sol'}},{selection:{...original.workflowModel!.selection,effort:'high'}},
    {selection:{...original.workflowModel!.selection,connectionRevision:'saved-preference'}},{extra:true}]) {
    assert.throws(()=>readCodexState({...original,workflowModel:{...original.workflowModel,...patch}}));
  }
  assert.throws(()=>readCodexState({...original,displayLimited:true}));
  assert.throws(()=>readCodexState({...original,snapshot:null}));
});
test('attested active model enables idle selection and invalidates workflows only on real proof changes',async()=>{
  const initial=attestedState(),f=contextChat(initial),draft='One chat, same unsent draft';f.doc.getElementById('codex-composer').value=draft;
  let changes=0;f.chat.subscribeWorkflowContextChange(()=>changes++);await f.chat.refresh();
  assert.deepEqual(f.chat.workflowModelSelection(),initial.workflowModel!.selection);assert.equal(changes,1);
  const controller=f.chat as unknown as {canSelectModel():boolean};
  assert.equal(controller.canSelectModel(),true);
  initial.snapshot!.models[0]!.displayName='Metadata label only';initial.workflowModel=workflowNativeModel(initial)!.proof;f.set(initial);await f.chat.refresh();assert.equal(changes,1);
  initial.snapshot!.thread!.selection={model:'fixture-sol',effort:'low'};initial.snapshot!.selection={model:'fixture-sol',effort:'low'};initial.workflowModel=workflowNativeModel(initial)!.proof;
  f.set(initial);await f.chat.refresh();assert.equal(changes,2);assert.equal(f.chat.workflowModelSelection()!.effort,'low');
  initial.snapshot!.thread!.turnStatus='inProgress';f.set(initial);await f.chat.refresh();assert.equal(changes,2);
  assert.equal(controller.canSelectModel(),false,'Without chat tabs the legacy native selection remains idle-gated');
  assert.equal(f.doc.getElementById('codex-composer').value,draft);assert.ok(f.calls.every(c=>c.method==='GET'));
});


test('an already-open write-grant confirmation cannot authorize a changed model or effort',async()=>{
  const initial=attestedState(),f=contextChat(initial);
  await f.chat.refresh();
  const controller=f.chat as unknown as {openGrant():void;confirm():Promise<void>};
  controller.openGrant();assert.equal(f.doc.getElementById('codex-confirm').open,true);
  f.doc.getElementById('codex-confirm-check').checked=true;
  initial.snapshot!.thread!.selection={model:'fixture-sol',effort:'low'};initial.snapshot!.selection={model:'fixture-sol',effort:'low'};
  initial.workflowModel=workflowNativeModel(initial)!.proof;f.set(initial);await f.chat.refresh();
  assert.equal(f.doc.getElementById('codex-confirm-submit').disabled,true);
  await controller.confirm();
  assert.match(f.doc.getElementById('codex-confirm-warning').textContent,/scope or preview changed/);
  assert.equal(f.chat.workflowModelSelection()!.effort,'low');
  assert.ok(f.calls.every(c=>c.method==='GET'),'No stale write grant was dispatched');
});

function workflowOrigin(value:ChatState):WorkflowDraftProvenance {
  return {projectPath:value.projectPath,projectId:'a'.repeat(64),workflowId:'fixture-workflow',workflowRevision:3,stepKey:'requirements',
    conversation:{provider:'codex',threadId:value.snapshot!.thread!.threadId,sessionId:value.snapshot!.thread!.sessionId},model:{...value.workflowModel!.selection}};
}

test('workflow draft provenance is detached, preserves original text, and blocks mismatched appends',async()=>{
  const initial=attestedState(),f=contextChat(initial);await f.chat.refresh();
  f.doc.getElementById('codex-composer').value='Human unsent text.  ';
  const origin=workflowOrigin(initial);assert.equal(f.chat.appendWorkflowDraft('Prepared workflow instructions',origin),true);
  const expected='Human unsent text.  \n\nPrepared workflow instructions';assert.equal(f.doc.getElementById('codex-composer').value,expected);
  const mutable=origin as unknown as {projectPath:string;model:{effort:string}};mutable.projectPath+='-mutated';mutable.model.effort='low';
  assert.equal(f.doc.getElementById('codex-submit').disabled,false,'Caller mutation cannot alter tracked provenance');
  assert.equal(f.chat.appendWorkflowDraft('Wrong context',origin),false);assert.equal(f.doc.getElementById('codex-composer').value,expected);
  assert.ok(f.calls.every(c=>c.method==='GET'));
});

test('workflow drafts cannot submit after thread, session, project or model changes; every byte stays unsent',async()=>{
  for(const change of ['thread','session','project','model'] as const){
    const initial=attestedState(),f=contextChat(initial);await f.chat.refresh();
    assert.equal(f.chat.appendWorkflowDraft('Pinned original workflow text 🧩',workflowOrigin(initial)),true);
    const draft=f.doc.getElementById('codex-composer').value,next=structuredClone(initial);
    if(change==='thread')next.snapshot!.thread!.threadId+='-other';
    if(change==='session')next.snapshot!.thread!.sessionId+='-other';
    if(change==='project')next.projectPath+='-other';
    if(change==='model'){next.snapshot!.thread!.selection.effort='low';next.snapshot!.selection!.effort='low';}
    next.workflowModel=workflowNativeModel(next)!.proof;f.set(next);await f.chat.refresh();
    assert.equal(f.doc.getElementById('codex-submit').disabled,true,change);
    assert.equal(f.doc.getElementById('codex-draft-review').hidden,false,change);
    const controller=f.chat as unknown as {dispatch(action:string,fields:Record<string,unknown>):Promise<void>};
    await controller.dispatch('turn-start',{threadId:next.snapshot!.thread!.threadId,text:draft});
    assert.equal(f.doc.getElementById('codex-composer').value,draft);assert.ok(f.calls.every(c=>c.method==='GET'),'Mismatched context never sends a turn');
  }
});

test('explicit workflow draft re-review changes no permission, moves no workflow and submits no turn',async()=>{
  const initial=attestedState(),f=contextChat(initial);await f.chat.refresh();f.chat.appendWorkflowDraft('Reviewed complete draft',workflowOrigin(initial));
  initial.snapshot!.thread!.threadId+='-different';initial.workflowModel=workflowNativeModel(initial)!.proof;f.set(initial);await f.chat.refresh();
  const controller=f.chat as unknown as {openDraftReview():void;confirm():Promise<void>};
  controller.openDraftReview();assert.equal(f.doc.getElementById('codex-confirm').open,true);
  assert.match(f.doc.getElementById('codex-confirm-preview').textContent,/Original workflow context/);assert.match(f.doc.getElementById('codex-confirm-preview').textContent,/Reviewed complete draft/);
  f.doc.getElementById('codex-confirm-check').checked=true;await controller.confirm();
  assert.equal(f.doc.getElementById('codex-submit').disabled,false);assert.equal(f.doc.getElementById('codex-composer').value,'Reviewed complete draft');
  assert.equal(f.doc.getElementById('codex-draft-review').hidden,true);assert.equal(initial.snapshot!.thread!.writeGranted,false);
  assert.ok(f.calls.every(c=>c.method==='GET'),'Review does not dispatch any native action');
});

test('draft text/context changes during re-review invalidate confirmation without losing text',async()=>{
  for(const change of ['text','thread','model'] as const){
    const initial=attestedState(),f=contextChat(initial);await f.chat.refresh();f.chat.appendWorkflowDraft('Original workflow draft',workflowOrigin(initial));
    initial.snapshot!.thread!.threadId+='-different';initial.workflowModel=workflowNativeModel(initial)!.proof;f.set(initial);await f.chat.refresh();
    const controller=f.chat as unknown as {openDraftReview():void;confirm():Promise<void>};controller.openDraftReview();f.doc.getElementById('codex-confirm-check').checked=true;
    if(change==='text')f.doc.getElementById('codex-composer').value+=' Changed by human.';
    if(change==='thread')initial.snapshot!.thread!.threadId+='-again';
    if(change==='model'){initial.snapshot!.thread!.selection.effort='low';initial.snapshot!.selection!.effort='low';}
    initial.workflowModel=workflowNativeModel(initial)!.proof;f.set(initial);await controller.confirm();
    assert.equal(f.doc.getElementById('codex-submit').disabled,true,change);assert.match(f.doc.getElementById('codex-composer').value,/Original workflow draft/);
    assert.match(f.doc.getElementById('codex-confirm-warning').textContent,/scope or preview changed/);assert.ok(f.calls.every(c=>c.method==='GET'));
  }
});

test('typing immediately invalidates an open draft review without notifying conversation subscribers',async t=>{
  const initial=attestedState(),f=contextChat(initial);await f.chat.start();t.after(()=>f.chat.stop());
  f.chat.appendWorkflowDraft('Original draft 🧩  ',workflowOrigin(initial));
  initial.snapshot!.thread!.threadId+='-changed';initial.workflowModel=workflowNativeModel(initial)!.proof;f.set(initial);await f.chat.refresh();
  const controller=f.chat as unknown as {openDraftReview():void};controller.openDraftReview();
  f.doc.getElementById('codex-confirm-check').checked=true;f.doc.getElementById('codex-confirm-check').dispatchEvent(new Event('change'));
  assert.equal(f.doc.getElementById('codex-confirm-submit').disabled,false);
  let changes=0;f.chat.subscribeStateChange(()=>changes++);
  const draft=f.doc.getElementById('codex-composer').value+'Final human edit.  ';
  f.doc.getElementById('codex-composer').value=draft;f.doc.getElementById('codex-composer').dispatchEvent(new Event('input'));
  assert.equal(f.doc.getElementById('codex-confirm-submit').disabled,true);
  assert.equal(f.doc.getElementById('codex-composer').value,draft);assert.equal(changes,0);
  assert.ok(f.calls.every(call=>call.method==='GET'));
});

test('synthetic Codex reply with an arcane-choices block renders option buttons; a click with a draft only adds the answer to the message box',async()=>{
  const initial=state();initial.snapshot!.thread=thread();initial.nativeHistory=cacheBinding(PROJECT,'fixture-thread','fixture-session');
  initial.snapshot!.events=[{type:'delta',seq:1,threadId:'fixture-thread',turnId:'turn-c',itemId:'item-c',text:'Pick one.\n\n```arcane-choices\n{"question":"Which door?","options":["Red <b>door</b>","Blue door"]}\n```'}];initial.snapshot!.lastEventSeq=1;
  const f=contextChat(initial),composer=f.doc.getElementById('codex-composer');composer.value='Keep this draft';
  await f.chat.refresh();
  const walk=(node:any):any[]=>[node,...(node.children??[]).flatMap(walk)];
  const nodes=walk(f.doc.getElementById('codex-messages'));
  const block=nodes.find(node=>node.className==='chat-choices')!,buttons=nodes.filter(node=>String(node.className).split(' ').includes('chat-choice'));
  assert.ok(block,'the fenced block becomes a choice group');assert.equal(block.dataset.state,'open','the latest reply after the last user message is live');
  assert.deepEqual(buttons.map(node=>node.textContent),['Red <b>door</b>','Blue door'],'options are plain text');
  buttons[1].dispatchEvent(new Event('click'));
  assert.equal(composer.value,'Keep this draft\n\nBlue door','with a draft the answer is written into the message box, never sent with it');
  assert.ok(f.calls.every(call=>call.method==='GET'),'no native action was dispatched');
  const invalid=structuredClone(initial);invalid.snapshot!.events=[{type:'delta',seq:2,threadId:'fixture-thread',turnId:'turn-d',itemId:'item-d',text:'```arcane-choices\n{"question":"Q","options":["Only"]}\n```'}];invalid.snapshot!.lastEventSeq=2;
  f.set(invalid);await f.chat.refresh();
  assert.equal(walk(f.doc.getElementById('codex-messages')).filter(node=>node.className==='chat-choices').length,1,'an invalid block stays text');
});
