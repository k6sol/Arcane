import test from 'node:test';import assert from 'node:assert/strict';import{readFileSync}from'node:fs';import{createRequire}from'node:module';import{EventEmitter}from'node:events';import vm from'node:vm';
const require=createRequire(import.meta.url),read=file=>readFileSync(new URL('../../'+file,import.meta.url),'utf8').replaceAll('\r\n','\n');
const main=read('apps/desktop/electron/main.cjs'),preload=read('apps/desktop/electron/preload.cjs'),policy=require('../../apps/desktop/electron/policy.cjs');
const{createRuntimeRecovery}=require('../../apps/desktop/electron/runtime-recovery.cjs');
const between=(from,to)=>{const begin=main.indexOf(from),end=main.indexOf(to,begin)+to.length;assert.ok(begin>0&&end>begin);return main.slice(begin,end);};
const factory=between("runtimeRecovery = require('./runtime-recovery.cjs').createRuntimeRecovery(",'runtimeRecovery.installIpc(ipcMain, rendererEvent);');
const eventGate=main.slice(main.indexOf('function rendererEvent(event)'),main.indexOf('const CODE_VERIFICATION_WARNING'));
const settle=async()=>{for(let n=0;n<20;n++)await Promise.resolve();};
function fixture({choice=1}={}){
 const calls=[],handlers=new Map(),emitter=new EventEmitter(),preferences=new Map();let exposed,preloadContext;
 const frame={url:'http://127.0.0.1:45871/studio#fixture'},contents={mainFrame:frame,isDestroyed:()=>false,send:(channel,value)=>{calls.push(['send',channel,value]);if(preloadContext){preloadContext.serialized=JSON.stringify(value);emitter.emit(channel,{},vm.runInContext('JSON.parse(serialized)',preloadContext));}}};
 const window={webContents:contents,isDestroyed:()=>false},project=Object.freeze({projectId:'a'.repeat(64),projectPath:'C:\\Project',stateRoot:'C:\\Profile\\runtime\\projects\\'+'a'.repeat(64)}),event={sender:contents,senderFrame:frame};
 const context=vm.createContext({window,projectSession:project,projectPath:project.projectPath,userRoot:'C:\\Profile',origin:'http://127.0.0.1:45871',token:'fixture-token',child:null,closing:false,switching:false,smoke:false,runtimeRecovery:null,workspacePreferences:null,claudePreferences:null,toolDrafts:null,studioKeyVault:null,safeStorage:{},clipboard:{},appDialogs:null,policy,URL,console,
  ipcMain:{handle:(channel,handler)=>handlers.set(channel,handler)},sleep:async ms=>calls.push(['sleep',ms]),
  stopClaudeChat:reason=>{calls.push(['stopClaudeChat',reason]);return Promise.resolve();},stopDaemon:async()=>{context.origin='';context.token='';context.child=null;calls.push(['stopDaemon']);return true;},
  startDaemon:async path=>{calls.push(['startDaemon',path]);context.origin='http://127.0.0.1:45871';context.token='replacement-token';context.child={exitCode:null,signalCode:null};},startClaudeChat:async()=>calls.push(['startClaudeChat']),loadWorkspace:async()=>calls.push(['loadWorkspace']),reloadRecoveredWorkspace:async()=>{context.switching=false;calls.push(['loadWorkspace']);},
  nativeDialog:{showMessageBox:async(owner,options)=>{calls.push(['confirm',owner,options]);return{response:choice};}},
  require:name=>{if(name==='./runtime-recovery.cjs')return{createRuntimeRecovery};if(name==='./workspace-preferences.cjs')return{createWorkspacePreferences:options=>({installIpc:()=>preferences.set(options.record??'workspace',options.getSession)})};throw Error('Unexpected recovery fixture dependency');},
  createStudioKeyVault:options=>({installIpc:()=>preferences.set('keys',options.getSession)})});
 context.dialog=context.nativeDialog;
 vm.runInContext(eventGate+factory,context);
 for(const slot of['studioKeyVault','workspacePreferences','claudePreferences','toolDrafts']){
  const start=slot==='studioKeyVault'?'studioKeyVault = createStudioKeyVault(':slot+" = require('./workspace-preferences.cjs').createWorkspacePreferences(";
  vm.runInContext(between(start,slot+'.installIpc(ipcMain);'),context);
 }
 preloadContext=vm.createContext({TextEncoder,require:name=>{assert.equal(name,'electron');return{contextBridge:{exposeInMainWorld:(name,value)=>{assert.equal(name,'arcaneDesktop');exposed=value;}},ipcRenderer:{on:(...args)=>emitter.on(...args),removeListener:(...args)=>emitter.removeListener(...args),invoke:async(channel,...args)=>{const handler=handlers.get(channel);assert.ok(handler,'Actual native recovery IPC registered');const result=await handler(event,...JSON.parse(JSON.stringify(args)));preloadContext.serializedReply=JSON.stringify(result);return vm.runInContext('JSON.parse(serializedReply)',preloadContext);}}};}});
 vm.runInContext(preload,preloadContext);preloadContext.api=exposed;
 void handlers.get('arcane:runtime-recovery-status')(event);
 const evaluate=code=>vm.runInContext(code,preloadContext),request=()=>calls.filter(row=>row[0]==='send'&&row[1]==='arcane:runtime-recovery-checkpoint').at(-1)?.[2];
 return{calls,context,preferences,project,window,event,contents,frame,evaluate,emitter,request,recovery:context.runtimeRecovery,stop:info=>context.runtimeRecovery.stopped({code:1,signal:null,uptimeMs:120000,...info}),ack:async saved=>{const requestId=request().requestId;await evaluate('api.runtimeRecovery.acknowledge('+JSON.stringify({requestId,saved})+')');}};
}
test('actual main wiring retains only presentation saves after the runtime credential is retired',async()=>{
 const f=fixture();assert.equal(f.preferences.get('workspace')().epoch,f.project);assert.ok(f.preferences.get('keys')());const done=f.stop();await settle();
 assert.equal(f.context.origin,'');assert.equal(f.context.token,'');assert.equal(f.context.switching,true);assert.equal(f.preferences.get('keys')(),null,'The key vault never gains offline authority.');
 for(const slot of['workspace','claude','tools']){const scope=f.preferences.get(slot)();assert.equal(scope.window,f.window);assert.equal(scope.origin,'http://127.0.0.1:45871');assert.equal(scope.projectPath,f.project.projectPath);assert.notEqual(scope.epoch,f.project);assert.equal(Object.hasOwn(scope,'token'),false);}
 assert.equal(f.calls.some(row=>row[0]==='startDaemon'),false);await f.ack(true);await done;assert.equal(f.calls.filter(row=>row[0]==='loadWorkspace').length,1);assert.equal(f.context.switching,false);
});
test('ordinary token revocation does not create offline presentation access',()=>{
 const f=fixture();f.context.token='';for(const slot of['workspace','claude','tools','keys'])assert.equal(f.preferences.get(slot)(),null);
});
test('native confirmation can keep the original workspace open without claiming its drafts were saved',async()=>{
 const f=fixture({choice:0});await f.stop({code:0});assert.equal(f.calls.some(row=>row[0]==='loadWorkspace'),false);assert.equal(f.calls.some(row=>row[0]==='startDaemon'),false);assert.equal(f.context.window,f.window);
 const options=f.calls.find(row=>row[0]==='confirm')[2];assert.deepEqual([...options.buttons],['Keep window open','Restart local services']);assert.match(options.detail,/save your workspace drafts first/);assert.doesNotMatch(options.detail,/drafts are saved|reconnects by itself/);
});
test('the production preload validates status and checkpoint payloads without acknowledging by itself',async()=>{
 const f=fixture();assert.equal(await f.evaluate('Object.isFrozen(api.runtimeRecovery)'),true);assert.equal((await f.evaluate('api.runtimeRecovery.status()')).state,'ready');
 await assert.rejects(f.evaluate('api.runtimeRecovery.retry("extra")'),/unavailable/);await assert.rejects(f.evaluate('api.runtimeRecovery.acknowledge({requestId:"bad",saved:true})'),/unavailable/);
 f.evaluate('globalThis.notices=[];globalThis.remove=api.runtimeRecovery.onCheckpoint(value=>notices.push(value));');
 f.emitter.emit('arcane:runtime-recovery-checkpoint',{},{});assert.equal(await f.evaluate('notices.length'),0);
 const done=f.stop();await settle();assert.equal(await f.evaluate('notices.length'),1);assert.equal(f.calls.some(row=>row[0]==='startDaemon'),false);await f.ack(false);await done;
 f.evaluate('remove()');assert.equal(f.emitter.listenerCount('arcane:runtime-recovery-checkpoint'),0);
});
test('the native acknowledgement rejects added fields and accepts the exact request only once',async()=>{
 const f=fixture(),done=f.stop();await settle();const requestId=f.request().requestId;
 await assert.rejects(f.evaluate('api.runtimeRecovery.acknowledge('+JSON.stringify({requestId,saved:true,token:'x'})+')'),/unavailable/);
 await assert.rejects(f.evaluate('api.runtimeRecovery.acknowledge('+JSON.stringify({requestId,saved:'yes'})+')'),/unavailable/);
 await f.ack(false);await done;await assert.rejects(f.ack(true),/unavailable/);assert.equal(f.calls.some(row=>row[0]==='loadWorkspace'),false);
});
test('actual offline preference access retires when the document, project or window changes',async()=>{
 for(const mutate of[f=>f.contents.mainFrame={url:f.frame.url},f=>f.context.projectSession={...f.project,projectPath:'C:\\Other'},f=>f.context.window=null,f=>f.context.closing=true]){
  const f=fixture({choice:0});await f.stop({code:0});assert.ok(f.preferences.get('workspace')());mutate(f);assert.equal(f.preferences.get('workspace')(),null);assert.equal(f.preferences.get('claude')(),null);
 }
});
test('a project taken by another open Arcane during recovery stays a retryable stop, never a takeover or kill',async()=>{
 const f=fixture();f.context.startDaemon=async path=>{f.calls.push(['startDaemon',path]);throw Object.assign(new Error('Arcane is already open for this project in another window. Switch to it, or close it and try again.'),{code:'ARCANE_PROJECT_IN_USE'});};
 const done=f.stop();await settle();await f.ack(true);await done;
 assert.equal(f.recovery.status().state,'stopped');assert.match(f.recovery.status().message,/could not restart.*try again/i);
 assert.equal(f.calls.filter(row=>row[0]==='startDaemon').length,1,'One attempt; no automatic loop against the other instance.');
 assert.equal(f.calls.filter(row=>row[0]==='confirm').length,0,'The one automatic restart asks nothing; a later retry is up to the person.');assert.equal(f.calls.some(row=>row[0]==='loadWorkspace'),false);
 assert.match(between("runtimeRecovery = require('./runtime-recovery.cjs').createRuntimeRecovery(",'runtimeRecovery.installIpc(ipcMain, rendererEvent);'),/start: async \(\) => \{ await startDaemon\(projectPath\); await startClaudeChat\(\); \}/);
});
