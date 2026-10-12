/** Explicitly human-authorized, one-turn personal-local native smoke test. Never run in ordinary npm test. */
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,basename} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {CodexSession} from '../dist/packages/codex-client/src/session.js';
import {prepareCodexProcess} from '../dist/packages/codex-client/src/mcp-profile.js';
import {limits} from '../dist/packages/codex-client/src/validation.js';
import {locateNativeCli} from '../dist/packages/model-adapters/src/process.js';
import {StudioStore} from '../dist/packages/storage/src/studio-store.js';
import {WorkStore} from '../dist/packages/storage/src/work-store.js';
import {createConnectionLab} from '../dist/apps/daemon/src/lab-server.js';
if(process.argv.length!==3||process.argv[2]!=='--human-authorized-one-turn')throw Error('Explicit --human-authorized-one-turn is required. This uses the existing CLI subscription.');
// A consumed approval is not replayable. A future run needs new human approval and
// explicit reconciliation/archival of this report; ordinary test/goal retries cannot
// silently run another subscription turn.
try { const prior=JSON.parse(await readFile(join(resolve('.'),'docs/research/native-codex-smoke-checks.json'),'utf8'));if(prior.requestedTurns>0)throw Error('A native turn was already dispatched under this approval. Inspect the report; do not automatically replay.'); }
catch(error){if(error.code!=='ENOENT')throw error;}
const root=resolve('.'),directory=await mkdtemp(join(tmpdir(),'arcane-native-smoke-')),workspace=join(directory,'workspace');await mkdir(workspace);
await writeFile(join(workspace,'AGENTS.md'),'Disposable native smoke test. Only the arcane work_runs MCP tool is authorized. Do not use terminals, other tools, Studio, Hunted, network, assets or file edits.');
const report={schemaVersion:1,observedAt:new Date().toISOString(),kind:'human-authorized-installed-cli-one-turn',workspace,model:'gpt-6.1-sol',effort:'ultra',stage:'prepared',passed:false,requestedTurns:0,studioCalls:0,httpCalls:[],limitations:['A one-turn read-only smoke test does not prove writes, image/design, all native features or Studio integration.','CLI-owned conversation persistence is normal; provider tokens are never read/copied by this harness.']};
const reportPath=join(root,'docs','research','native-codex-smoke-checks.json');let store,work,app,client;const seen=new Set();let epoch=0;
const save=async()=>{await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');};
try {
 store=new StudioStore({directory:join(directory,'state')});work=new WorkStore({directory:join(directory,'state'),projectPath:workspace});
 app=await createConnectionLab({cwd:root,stateDirectory:join(directory,'lab'),studioStore:store,workStore:work,projectPath:workspace,port:0});
 app.server.on('request',request=>{const path=new URL(request.url??'/',app.origin).pathname;report.httpCalls.push({method:request.method,path});if(path.startsWith('/v1/native/')||path.startsWith('/v1/studio/'))report.studioCalls++;});
 const command=await locateNativeCli('codex');assert.ok(command&&basename(command).toLowerCase()==='codex.exe','Installed native Codex executable is required.');
 const spec=await prepareCodexProcess(command,workspace,{nodeExecutable:process.execPath,serverEntry:join(root,'dist/apps/mcp/src/main.js'),projectRoot:root,daemonUrl:app.origin,agentToken:app.agentToken});
 // Child-only config overrides: no home/project client config or credential files are written.
 // Narrow the native smoke tool surface; abort before inference if any other server remains enabled.
 spec.args=[...spec.args.slice(0,3),'-c','mcp_servers={}','-c','plugins={}',...spec.args.slice(3),'-c','mcp_servers.arcane.enabled_tools=["work_runs"]'];
 client=new CodexSession(spec,limits({}), 'installed-cli');await client.initialize();report.stage='native-metadata';
 const metadata=client.snapshot();report.provenance=metadata.provenance;report.account=metadata.account;report.reportedModelNames=metadata.models.map(m=>m.model);
 const selected=metadata.models.find(m=>m.model===report.model);assert.ok(selected&&selected.efforts.includes(report.effort),'The exact gpt-6.1-sol / ultra pair is not reported; no fallback permitted.');assert.equal(metadata.account?.auth,'subscription');
 report.mcpInventory=await client.inspectMcpServers({initiatedBy:'human'});assert.ok(report.mcpInventory.some(s=>s.name==='arcane'&&s.toolNames.includes('work_runs')&&!s.toolsError),'Arcane work_runs must actually be discovered.');
 report.preflightInheritedServers=report.mcpInventory.filter(s=>s.name!=='arcane').map(s=>({name:s.name,pluginId:s.pluginId}));
 const extra=[];for(const server of report.preflightInheritedServers){
   assert.match(server.name,/^[A-Za-z0-9_-]+$/,'Unsupported server key: no inference permitted.');if(server.pluginId)assert.match(server.pluginId,/^[A-Za-z0-9_@-]+$/,'Unsupported plugin key: no inference permitted.');
   if(server.pluginId){const plugin='plugins.'+server.pluginId+'.mcp_servers.'+server.name;extra.push('-c',plugin+'.enabled=false','-c',plugin+'.enabled_tools=[]');}
   else {const key='mcp_servers.'+server.name;extra.push('-c',key+'={command='+JSON.stringify(process.execPath)+',args=["-e","process.exit(0)"],enabled=false,enabled_tools=[]}');}
 }
 await client.close();spec.args.push(...extra);client=new CodexSession(spec,limits({}),'installed-cli');await client.initialize();await save();console.log('Native subscription/model catalogue verified; inherited tool overrides scoped to this disposable child.');
 client.selectModel({initiatedBy:'human',model:report.model,effort:report.effort});const thread=await client.startThread({initiatedBy:'human'});report.threadId=thread.threadId;report.threadSettingsVerified=thread.configured&&!thread.writeGranted;report.stage='read-only-thread';
 report.mcpInventory=await client.inspectMcpServers({initiatedBy:'human',threadId:thread.threadId});
 assert.deepEqual(report.mcpInventory.filter(s=>s.name!=='arcane'&&s.runtimeStatus!=='disabled'),[],'Unexpected active thread MCP server: abort before inference.');
 assert.ok(report.mcpInventory.some(s=>s.name==='arcane'&&s.runtimeStatus==='connected'&&s.toolNames.includes('work_runs')),'Arcane must be connected in the actual native thread.');await save();
 report.requestedTurns=1;report.stage='turn-dispatched';epoch=Date.now();await save();
 await client.startTurn({initiatedBy:'human',threadId:thread.threadId,text:'This is a tiny native integration smoke test in a disposable workspace. Call the arcane work_runs MCP tool exactly once with timeoutMs 5000. Then reply exactly ARCANE_SMOKE_OK runs=0 when the returned runs array is empty. Do not run shell commands, use other tools, inspect files, edit anything, access Studio or Hunted, search the web or generate assets. If the tool is unavailable, say ARCANE_SMOKE_FAILED rather than inventing a result.'});
 while(Date.now()-epoch<180000){const s=client.snapshot();for(const a of s.approvals){if(!seen.has(a.handle)){seen.add(a.handle);client.respondApproval({initiatedBy:'human',connectionId:a.connectionId,threadId:a.threadId,turnId:a.turnId,handle:a.handle,decision:'decline'});}}
  if(['completed','failed','interrupted','unknown'].includes(s.thread?.turnStatus)){report.turnId=s.thread.turnId;report.turnStatus=s.thread.turnStatus;report.publicText=s.events.filter(e=>e.type==='delta').map(e=>e.text).join('').slice(0,1024);report.mcpItems=s.events.filter(e=>e.type==='item'&&e.itemType==='mcpToolCall');break;}await delay(100);
 }
 assert.equal(report.turnStatus,'completed','The native turn did not complete. No automatic replay is permitted.');assert.match(report.publicText,/ARCANE_SMOKE_OK runs=0/);assert.equal(report.httpCalls.filter(c=>c.method==='GET'&&c.path==='/v1/work/runs').length,1);assert.equal(report.studioCalls,0);assert.equal(seen.size,0,'Smoke requested unauthorized command/file approval.');
 report.stage='completed';report.passed=true;report.nativeInferenceVerified=true;report.arcaneMcpRoundTripVerified=true;
} catch(error){report.errorCode=typeof error.code==='string'?error.code:'SMOKE_ASSERTION';report.failureStage=report.stage;report.unknownOutcome=report.requestedTurns>0;process.exitCode=1;}
finally {
 if(client){const s=client.snapshot();if(s.thread?.turnId&&['starting','inProgress'].includes(s.thread.turnStatus)){try{await client.interruptTurn({initiatedBy:'human',threadId:s.thread.threadId,turnId:s.thread.turnId});}catch{report.interruptOutcome='unknown';}}await client.close();report.clientClosed=!client.snapshot().connected;}
 if(app)await app.close();work?.close();store?.close();await save();console.log(JSON.stringify({...report,mcpInventory:report.mcpInventory?.map(s=>({name:s.name,runtimeStatus:s.runtimeStatus,toolCount:s.toolNames.length,pluginId:s.pluginId}))},null,2));
}
