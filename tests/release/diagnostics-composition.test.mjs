// Execute selected production composition functions with owned in-memory adapters; never load Electron or a profile.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {EventEmitter} from 'node:events';
import {win32 as path} from 'node:path';
import vm from 'node:vm';
import * as report from '../../packages/diagnostics/src/report.ts';
const read=file=>readFileSync(new URL('../../'+file,import.meta.url),'utf8').replaceAll('\r\n','\n');
const main=read('apps/desktop/electron/main.cjs'),product=read('apps/daemon/src/product-main.ts'),packaging=read('scripts/package-windows.mjs');
const policy=createRequire(import.meta.url)('../../apps/desktop/electron/policy.cjs');
const defer=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function between(source,start,end){const at=source.indexOf(start),last=source.indexOf(end,at+start.length);assert.ok(at>=0&&last>at,start);return source.slice(at,last);}
function fixture(options={}){
 const calls=[],intervals=[],events=[],attachments=[];let id=0;
 const storage={db:{},assertReady(){},close(){calls.push('storage-close');options.storageClose?.();}};
 const host={list(){calls.push('list');if(options.listError)throw Error('private queue failure');return{events:[]};},
  report(event){events.push(event);calls.push('report');return options.report?.(event)??Promise.resolve({stored:true,eventId:event.eventId});},
  flush(){calls.push('flush');return options.flush?.()??Promise.resolve({state:'disabled'});},
  close(){calls.push('host-close');return options.close?.()??Promise.resolve(true);},
  attach(owned,current){const row={owned,current,detached:0};attachments.push(row);const receive=frame=>{
   if(!options.ack||!current())return;
   const event=report.diagnosticEvent(frame.event);
   void host.report(event).then(result=>{if(current())owned.send({type:'arcane-diagnostic-ack',protocolVersion:1,requestId:frame.requestId,eventId:event.eventId,stored:result.stored===true},()=>{});});
  };owned.on('message',receive);return()=>{row.detached++;owned.removeListener('message',receive);};}};
 const context={smoke:options.smoke??false,closing:false,child:null,userRoot:'C:\\Fixture\\Arcane',productRoot:'C:\\Product',safeStorage:{},billing:null,
  join:path.join,Date,Buffer,Promise,Object,JSON,setTimeout,clearTimeout,
  setInterval(callback,ms){const timer={callback,ms,cleared:false,unref(){}};intervals.push(timer);return timer;},clearInterval(timer){if(timer)timer.cleared=true;},
  app:{exit:code=>calls.push('exit:'+code)},
  fixtureLoad:async name=>{calls.push('load:'+name);if(options.loadError)throw Error('private module failure');
   assert.ok(['dist/packages/diagnostics/src/report.js','dist/packages/diagnostics/src/outbox.js','dist/packages/protocol/src/plans.js'].includes(name));
   return name.endsWith('plans.js')?{ARCANE_PLANS:{gateway:{allowedOrigins:[]}}}:name.endsWith('report.js')?report:{};},
  require(name){
   if(name==='node:crypto')return{randomUUID:()=>`11111111-2222-4333-8444-${String(++id).padStart(12,'0')}`};
   if(name==='node:events')return{EventEmitter};
   if(name==='./diagnostics-directory.cjs')return{createDiagnosticsDirectoryPreparer:configuration=>{assert.equal(configuration.root,context.userRoot);return async directory=>directory;}};
   if(name==='./diagnostics-storage.cjs')return{openDiagnosticsStorage:async configuration=>{calls.push('storage-open');assert.equal(configuration.directory,path.join(context.userRoot,'diagnostics'));assert.equal(typeof configuration.prepareDirectory,'function');await options.open?.();return storage;}};
   if(name==='./diagnostics-host.cjs')return{createDiagnosticsHost:async configuration=>{calls.push('host-open');assert.equal(configuration.storage,storage);assert.equal(configuration.safeStorage,context.safeStorage);assert.equal(configuration.enabled,true);assert.deepEqual(Array.from(configuration.allowedOrigins),[]);return host;}};
   assert.fail('Unexpected dependency '+name);
  },
 };
 let block=between(main,'let diagnostics = null','let studioPlugin;');
 const loader="const load = relative => import(require('node:url').pathToFileURL(join(productRoot, relative)).href);";
 assert.equal(block.split(loader).length,2);block=block.replace(loader,'const load = relative => fixtureLoad(relative);');
 vm.runInNewContext(block+'\nglobalThis.fixture = { initializeDiagnostics, recordStartupDiagnostic, flushDiagnostics, closeDiagnostics, exitAfterDiagnostics, attachDiagnosticChild, retireDiagnosticChild, initialized:()=>diagnosticInit, state:()=>diagnosticState };',context);
 return{api:context.fixture,context,calls,intervals,events,attachments,host,storage,ready:async()=>{await context.fixture.initialized();await settle();}};
}
test('smoke mode never initializes diagnostics, loads modules, touches storage or schedules delivery',async()=>{
 const f=fixture({smoke:true});assert.equal(f.api.initializeDiagnostics(),undefined);f.api.recordStartupDiagnostic('STARTUP_FAILED');await f.api.closeDiagnostics();assert.deepEqual(f.calls,[]);assert.deepEqual(f.intervals,[]);
});
test('initialization stays asynchronous and preserves a bounded fixed startup event until storage is ready',async()=>{
 const gate=defer(),f=fixture({open:()=>gate.promise});assert.equal(f.api.initializeDiagnostics(),undefined);await settle();
 for(let i=0;i<20;i++)f.api.recordStartupDiagnostic('STARTUP_TIMEOUT');f.api.recordStartupDiagnostic('private exception message');
 assert.equal(f.events.length,0);gate.resolve();await f.ready();assert.equal(f.events.length,8);
 assert.ok(f.events.every(event=>event.code==='REQUEST_TIMEOUT'&&event.stage==='startup'&&Object.keys(event).sort().join(',')==='code,component,eventId,occurredAt,schemaVersion,stage'));
 assert.equal(f.api.state(),'ready');assert.equal(f.intervals[0].ms,60000);await f.api.closeDiagnostics();
});
test('module or private storage initialization failure remains a finite unavailable state without rejecting startup',async()=>{
 for(const options of [{loadError:true},{open:()=>Promise.reject(Error('private storage path'))}]){
  const f=fixture(options);f.api.initializeDiagnostics();await f.ready();assert.equal(f.api.state(),'unavailable');assert.equal(f.intervals.length,0);await f.api.closeDiagnostics();
 }
 const f=fixture({listError:true});f.api.initializeDiagnostics();await f.ready();assert.equal(f.api.state(),'unavailable');assert.ok(f.calls.indexOf('host-close')<f.calls.indexOf('storage-close'));assert.equal(f.intervals.length,0);
});
test('the 60-second scheduler serializes flushes and retires its timer on close',async()=>{
 const gate=defer(),f=fixture({flush:()=>gate.promise});f.api.initializeDiagnostics();await f.ready();assert.equal(f.calls.filter(call=>call==='flush').length,1);
 f.intervals[0].callback();await f.api.flushDiagnostics();assert.equal(f.calls.filter(call=>call==='flush').length,1);
 gate.resolve({state:'disabled'});await settle();f.intervals[0].callback();await settle();assert.equal(f.calls.filter(call=>call==='flush').length,2);
 await f.api.closeDiagnostics();assert.equal(f.intervals[0].cleared,true);f.intervals[0].callback();await settle();assert.equal(f.calls.filter(call=>call==='flush').length,2);
});
test('a daemon started before async storage completion gains an additive current-lifetime listener exactly once',async()=>{
 const f=fixture(),callbacks=new Map(),owned={exitCode:null,signalCode:null,on(type,callback){callbacks.set(type,callback);},once(type,callback){callbacks.set(type,callback);},removeListener(type,callback){if(callbacks.get(type)===callback)callbacks.delete(type);}};
 const original=()=>{};callbacks.set('startup-message',original);f.context.child=owned;f.api.initializeDiagnostics();await f.ready();
 assert.equal(f.attachments.length,1);f.api.attachDiagnosticChild(owned);assert.equal(f.attachments.length,1);assert.equal(callbacks.get('startup-message'),original);
 assert.equal(f.attachments[0].current(),true);f.context.child={};assert.equal(f.attachments[0].current(),false);f.context.child=owned;f.context.closing=true;assert.equal(f.attachments[0].current(),false);
 callbacks.get('close')();assert.equal(f.attachments[0].detached,1);await f.api.closeDiagnostics();
});
const childFixture=()=>Object.assign(new EventEmitter(),{exitCode:null,signalCode:null,connected:true,sent:[],send(message,callback){this.sent.push(message);callback?.(null);}});
const frame=index=>({type:'arcane-diagnostic-report',protocolVersion:1,requestId:`22222222-3333-4444-8555-${String(index+1).padStart(12,'0')}`,
 event:{schemaVersion:1,eventId:`33333333-4444-4555-8666-${String(index+1).padStart(12,'0')}`,occurredAt:1792500000000,component:'blender',stage:'mesh-validation',code:'MESH_AUDIT'}});
test('a canonical failure before storage initialization is relayed privately and acknowledged only after its durable report',async()=>{
 const opening=defer(),commit=defer(),f=fixture({ack:true,open:()=>opening.promise,report:event=>commit.promise.then(()=>({stored:true,eventId:event.eventId}))}),owned=childFixture();
 f.context.child=owned;f.api.initializeDiagnostics();await settle();f.api.attachDiagnosticChild(owned);owned.emit('message',frame(0));assert.equal(f.events.length,0);assert.equal(owned.sent.length,0);
 opening.resolve();await f.ready();assert.equal(f.events.length,1);assert.equal(f.events[0].reason,report.DIAGNOSTIC_REASONS.MESH_AUDIT);assert.equal(owned.sent.length,0);
 commit.resolve();await settle();assert.equal(owned.sent.length,1);assert.equal(owned.sent[0].stored,true);assert.equal(owned.sent[0].eventId,frame(0).event.eventId);await f.api.closeDiagnostics();
});
test('relay count, byte and canonical schema bounds retain no raw exception text and never replay other messages',async()=>{
 const opening=defer(),f=fixture({ack:true,open:()=>opening.promise}),owned=childFixture();let readiness=0;owned.on('message',message=>{if(message.type==='arcane-ready')readiness++;});
 f.context.child=owned;f.api.initializeDiagnostics();await settle();f.api.attachDiagnosticChild(owned);
 owned.emit('message',{...frame(90),event:{...frame(90).event,message:'private script'}});
 owned.emit('message',{...frame(91),event:{...frame(91).event,reason:'x'.repeat(10*1024)}});
 owned.emit('message',{type:'arcane-ready'});for(let i=0;i<25;i++)owned.emit('message',frame(i));
 opening.resolve();await f.ready();assert.equal(f.events.length,16);assert.equal(owned.sent.length,16);assert.equal(readiness,1);assert.equal(JSON.stringify(f.events).includes('private script'),false);await f.api.closeDiagnostics();
});
test('child retirement, replacement and application close discard buffered relay frames and prevent stale acknowledgements',async()=>{
 for(const action of ['retire','replace','close']){
  const opening=defer(),f=fixture({ack:true,open:()=>opening.promise}),owned=childFixture();f.context.child=owned;f.api.initializeDiagnostics();await settle();f.api.attachDiagnosticChild(owned);owned.emit('message',frame(0));
  let closing;if(action==='retire')f.api.retireDiagnosticChild(owned);else if(action==='replace')f.context.child=childFixture();else closing=f.api.closeDiagnostics();
  opening.resolve();await f.ready();if(closing)await closing;assert.equal(f.events.length,0);assert.equal(owned.sent.length,0);await f.api.closeDiagnostics();
 }
 const opening=defer(),commit=defer(),f=fixture({ack:true,open:()=>opening.promise,report:event=>commit.promise.then(()=>({stored:true,eventId:event.eventId}))}),owned=childFixture();
 f.context.child=owned;f.api.initializeDiagnostics();await settle();f.api.attachDiagnosticChild(owned);owned.emit('message',frame(0));opening.resolve();await f.ready();assert.equal(f.events.length,1);
 f.api.retireDiagnosticChild(owned);commit.resolve();await settle();assert.equal(owned.sent.length,0);await f.api.closeDiagnostics();
});
test('the production first-failure fence and fixed code mapper preserve only the first failure of each startup attempt',async()=>{
 const scope=between(main,'  let diagnosticFailureRecorded = false;','  const STARTUP_FAILURE_TEXT =');
 for(const first of ['PORT_IN_USE','STARTUP_TIMEOUT','STARTUP_FAILED']){
  const captured=[],context={recordStartupDiagnostic:code=>captured.push(code),startupPortError:message=>new Error(message),STARTUP_FAILURE_TEXT:{PORT_IN_USE:'port',STARTUP_TIMEOUT:'timeout',STARTUP_FAILED:'failed'}};
  vm.runInNewContext(scope+'\nglobalThis.startupFailure = startupFailure;',context);context.startupFailure(first);context.startupFailure('STARTUP_FAILED');assert.deepEqual(captured,[first]);
 }
 const accepted=[],context={policy,reportedFailure:null,reportFailureOnce:code=>accepted.push(code)};
 const branch=between(main,'      try { const code = policy.startupFailureMessage(message);','      let ready;');
 vm.runInNewContext('globalThis.receive = message => {\n'+branch+'\n};',context);
 context.receive({type:'arcane-startup-failure',protocolVersion:1,code:'STATE_UNSAFE',message:'private'});assert.equal(accepted.length,0);
 context.receive({type:'arcane-startup-failure',protocolVersion:1,code:'STATE_UNSAFE'});assert.deepEqual(accepted,['STATE_UNSAFE']);
 const f=fixture();f.api.initializeDiagnostics();await f.ready();f.api.recordStartupDiagnostic('STARTUP_FAILED');await settle();assert.equal(f.events[0].code,'INTERNAL_ERROR');await f.api.closeDiagnostics();
});
test('shutdown awaits captured reports before host quiescence and database close',async()=>{
 const gate=defer(),f=fixture({report:event=>gate.promise.then(()=>({stored:true,eventId:event.eventId}))});f.api.initializeDiagnostics();await f.ready();f.api.recordStartupDiagnostic('STATE_UNSAFE');await settle();
 const closing=f.api.closeDiagnostics();await settle();assert.equal(f.calls.includes('host-close'),false);assert.equal(f.calls.includes('storage-close'),false);
 gate.resolve();assert.equal(await closing,true);assert.ok(f.calls.indexOf('report')<f.calls.indexOf('host-close'));assert.ok(f.calls.indexOf('host-close')<f.calls.indexOf('storage-close'));
});
test('an unresolved host close never closes its database and a later explicit close can finish',async()=>{
 let clean=false;const f=fixture({close:async()=>clean});f.api.initializeDiagnostics();await f.ready();const a=f.api.closeDiagnostics(),b=f.api.closeDiagnostics();assert.equal(a,b);assert.equal(await a,false);assert.equal(f.calls.includes('storage-close'),false);
 clean=true;assert.equal(await f.api.closeDiagnostics(),true);assert.equal(f.calls.filter(call=>call==='storage-close').length,1);
});
test('a fatal startup during private initialization retains its fixed event and closes in order without starting delivery',async()=>{
 const gate=defer(),f=fixture({open:()=>gate.promise});f.api.initializeDiagnostics();await settle();f.api.recordStartupDiagnostic('STARTUP_FAILED');const done=f.api.exitAfterDiagnostics(1);gate.resolve();await done;
 assert.equal(f.events.length,1);assert.equal(f.events[0].code,'INTERNAL_ERROR');assert.equal(f.intervals.length,0);assert.equal(f.calls.includes('flush'),false);
 assert.ok(f.calls.indexOf('report')<f.calls.indexOf('host-close'));assert.ok(f.calls.indexOf('host-close')<f.calls.indexOf('storage-close'));assert.equal(f.calls.at(-1),'exit:1');
});
test('startup quit and startup failure both await diagnostic shutdown before exiting',async()=>{
 for(const [name,end,expected,rejectDialog] of [['quitStartup','async function runtimeStopped',0,false],['failStartup','/** Start a project',1,false],['failStartup','/** Start a project',1,true]]){
  const body=between(main,'async function '+name+'(',end),calls=[];let pyxDisposed=0;
  const context={closing:false,smoke:false,providerSetup:{dispose(){}},pyxBar:{dispose(){pyxDisposed++;}},stopClaudeChat:()=>Promise.resolve(),appDialogs:null,trustedDialogs:null,
   dialog:{showMessageBox:async()=>{calls.push('dialog');if(rejectDialog)throw Error('fixture native dialog refusal');}},stopDaemon:async()=>calls.push('daemon'),exitAfterDiagnostics:async code=>calls.push('diagnostics-exit:'+code)};
  vm.runInNewContext(body+'\nglobalThis.run='+name+';',context);await context.run('fixed public startup message');assert.equal(calls.at(-1),'diagnostics-exit:'+expected);assert.ok(calls.indexOf('daemon')<calls.length-1);
  if(name==='failStartup')assert.equal(pyxDisposed,1,'a failed startup also retires the Pyx bar window');
 }
});
test('the before-quit callback observes daemon failure and always delegates final diagnostic closure',async()=>{
 const registration=main.split(/\r?\n/).find(line=>line.includes("app.on('before-quit'"));assert.ok(registration);
 for(const fail of [false,true]){
  let callback,pyxDisposed=0;const calls=[],context={app:{on(type,fn){assert.equal(type,'before-quit');callback=fn;}},closing:false,providerSetup:{dispose(){}},pyxBar:{dispose(){pyxDisposed++;}},
   stopClaudeChat:async()=>{},stopDaemon:async()=>{if(fail)throw Error('fixture daemon refusal');return true;},exitAfterDiagnostics:async code=>calls.push('diagnostics-exit:'+code)};
  vm.runInNewContext(registration,context);callback({preventDefault:()=>calls.push('prevent')});await settle();assert.deepEqual(calls,['prevent','diagnostics-exit:'+(fail?1:0)]);
  assert.equal(pyxDisposed,1,'quitting retires the Pyx bar window');
 }
});
test('update handoff quiesces diagnostics before relaunch and preserves a refused-close fence',async()=>{
 const adapter=between(main,"      require('./desktop-updates.cjs').createDesktopUpdates(","      ipcMain.handle('arcane:asset-conversation-select'");
 for(const clean of [false,true]){
  const calls=[];let config;const context={require:name=>{assert.equal(name,'./desktop-updates.cjs');return{createDesktopUpdates:options=>{config=options;return{installIpc(){}};}};},
   smoke:false,process:{env:{LOCALAPPDATA:'C:\\Local'},resourcesPath:'C:\\Resources'},app:{isPackaged:true,getPath:()=> 'C:\\App\\Arcane.exe',relaunch:()=>calls.push('relaunch'),exit:()=>calls.push('exit')},
   join:path.join,resolve:path.resolve,__dirname:'C:\\Source',window:{isDestroyed:()=>false},projectSession:{},origin:'http://127.0.0.1:1234',token:'fixture',closing:false,switching:false,
   ipcMain:{},rendererEvent:()=>true,stopClaudeChat:async()=>{},stopDaemon:async()=>{calls.push('daemon');return true;},closeDiagnostics:async()=>{calls.push('diagnostics');return clean;},providerSetup:{dispose:()=>calls.push('dispose')},setTimeout:callback=>{calls.push('exit-scheduled');callback();}};
  vm.runInNewContext(adapter,context);assert.equal(await config.restart('C:\\Next\\Arcane.exe'),clean);
  assert.deepEqual(calls,clean?['daemon','diagnostics','dispose','relaunch','exit-scheduled','exit']:['daemon','diagnostics']);
 }
});
test('project switch and local runtime recovery retain the user-wide diagnostic queue',()=>{
 for(const body of [between(main,'async function chooseProject()','function installMenu()'),between(main,"retire: async () => { appDialogs",'        reload: reloadRecoveredWorkspace')]){
  assert.equal(body.includes('closeDiagnostics'),false);assert.equal(body.includes('diagnosticStorage'),false);
 }
 const calls=[],context={policy:{directPath:async value=>calls.push('validate:'+value)},productRoot:'product',nodeExecutable:'node',initializeDiagnostics:()=>calls.push('initialize')};
 const setup=between(main,"      await policy.directPath(productRoot); await policy.directPath(nodeExecutable, 'file');",'      const defaultProject =');
 return vm.runInNewContext('(async()=>{'+setup+'})()',context).then(()=>assert.deepEqual(calls,['validate:product','validate:node','initialize']));
});
test('asset creation receives the actual reporter and normal cleanup closes it after asset shutdown',async()=>{
 const creation=between(product,'try {assets=await createAssetService(','}catch(error)');
 let received;const reporter=async()=>null,context={createAssetService:async options=>{received=options;return{};},runtimeRoot:'runtime',cwd:'product',join:path.join,associations:{projectPath:'project'},modelReview:{},importHost:{hooks:{},hasCapturedJob(){}},preparations:{hasRecordForJob(){}},store:{hasPendingStageWork(){}},stateOverride:undefined,resourceOverride:undefined,directory:'state',diagnosticReporter:{report:reporter}};
 await vm.runInNewContext('(async()=>{'+creation.slice('try {'.length)+';})()',context);assert.equal(received.reportFailure,reporter);
 const loop=between(product,'  for (const close of [() => app.close(),','  try {\n    const current =').trim();
 const calls=[],objects=['app','importStaging','importHost','assets','learning','preparations','associations','work','store','diagnosticReporter'];
 const cleanup={failed:false};for(const name of objects)cleanup[name]={close(){calls.push(name);if(name==='app')throw Error('fixture close refusal');}};
 await vm.runInNewContext('(async()=>{'+loop+'})()',cleanup);assert.deepEqual(calls,objects);assert.equal(cleanup.failed,true);
});
test('packaging requires every shipped diagnostic helper and compiled entrypoint through the existing release manifest',()=>{
 const required=['dist/apps/daemon/src/diagnostic-reporter.js','dist/packages/diagnostics/src/report.js','dist/packages/diagnostics/src/outbox.js'];
 const hosts=between(packaging,'const HOST_FILES =','const PRODUCTION_ROOTS =');const context={};vm.runInNewContext(hosts+'globalThis.files=HOST_FILES;',context);
 for(const file of ['diagnostics-host.cjs','diagnostics-storage.cjs','diagnostics-directory.cjs'])assert.ok(context.files.includes(file));
 const check=between(packaging,"  for (const required of ['dist/apps/daemon/src/diagnostic-reporter.js'",'  if (releaseManifest.version');
 for(const omitted of required)assert.throws(()=>vm.runInNewContext(check,{releaseManifest:{files:required.filter(file=>file!==omitted).map(path=>({path}))}}),/Diagnostic runtime is absent/);
 assert.doesNotThrow(()=>vm.runInNewContext(check,{releaseManifest:{files:required.map(path=>({path}))}}));
 const bundle=between(packaging,"  for (const path of [...ELECTRON_REQUIRED, 'resources/app/package.json'",'  if (!manifest.files.some');
 const all=[...context.files.map(file=>'resources/app/'+file),'resources/app/package.json','resources/node/node.exe','resources/node/LICENSE','resources/product/release-manifest.json','resources/product/dist/apps/daemon/src/product-main.js','resources/product/dist/apps/mcp/src/main.js',...required.map(file=>'resources/product/'+file)];
 for(const omitted of required)assert.throws(()=>vm.runInNewContext(bundle,{ELECTRON_REQUIRED:[],HOST_FILES:context.files,REQUIRED_FRONTEND_FILES:[],REQUIRED_MANAGED_LUAU_FILES:[],seen:new Set(all.filter(path=>path!=='resources/product/'+omitted))}),/Missing required Windows bundle file/);
});
