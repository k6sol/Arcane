import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { win32 } from 'node:path';
import { EventEmitter } from 'node:events';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { REQUIRED_SMOKE_CHECKS, smokeChecksComplete } from '../../scripts/check-windows-executable.mjs';

// Read source directly: no build, Electron, HTTP listener, native CLI or provider.
const source = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const policySource = source('apps/desktop/electron/policy.cjs');
const mainSource = source('apps/desktop/electron/main.cjs');
const preloadSource = source('apps/desktop/electron/preload.cjs');
const productSource = source('apps/daemon/src/product-main.ts');
const labSource = source('apps/daemon/src/lab-server.ts');
const origin = 'http://127.0.0.1:45871';
const token = 'a'.repeat(64);
const key = path => win32.resolve(path).toLowerCase();

test('packaged smoke records module delivery after initialization and fails when its renderer check refuses',async()=>{
  const start=mainSource.indexOf('async function checkSmoke() {'),end=mainSource.indexOf('\n}\n',start);
  assert.ok(start>=0&&end>start);const check=mainSource.slice(start,end+2);
  for(const modulesAvailable of [true,false]){
    const writes=new Map(),exits=[],scripts=[];
    const renderer={nodeAvailable:false,staticIds:true,scrollWidth:100,width:100,height:100,previews:0,desktop:{runtime:'desktop'},
      codeVerificationBridge:true,desktopVerificationController:true,studioKeysBridge:true,modelOptions:0,conversationOnly:true,providerSetupMounted:true,nativeHandoffMounted:true,nativeAssetPermissionControls:true};
    const nativeState={snapshot:null,actions:[],nativeAssets:{available:true,sealed:false,granted:false,admissionOpen:false}};
    const context={origin,token,smokeRoot:'C:\\Smoke',closing:false,started:0,daemonReadyMs:1,firstReadyMs:2,
      sleep:async()=>{},join:win32.join,performance:{now:()=>3},process:{versions:{electron:'fixture'}},
      projectSession:{verificationUnavailable:false},safeStorage:{isEncryptionAvailable:()=>false},
      smokePackagedFeatures:async()=>({bundledPluginVerified:true,plansConfigValid:true,chatInstructionsBundled:true,trustedDialogBundled:true}),
      stopDaemon:async()=>true,app:{getVersion:()=> 'fixture',exit:code=>exits.push(code)},
      exitAfterDiagnostics:async code=>exits.push(code),
      writeFile:async(path,value)=>writes.set(path,value),
      policy:{validOrigin:value=>value===origin,navigationAllowed:()=>false,requestAllowed:()=>false},
      fetch:async url=>({ok:true,headers:{get:()=>"script-src 'self'"},json:async()=>url.endsWith('/v1/product/state')?{studioSessions:[],commandCounts:{}}:
        url.endsWith('/v1/learning/state')?{settings:{optIn:false,projectId:'f'.repeat(64)},records:[]}:{state:nativeState}}),
      window:{webContents:{getLastWebPreferences:()=>({sandbox:true,contextIsolation:true,nodeIntegration:false}),
        capturePage:async()=>({toPNG:()=>Buffer.from('fixture image')}),executeJavaScript:async code=>{
          scripts.push(code);
          if(code.includes('title: document.title'))return JSON.stringify(renderer);
          if(code.includes("'/task-plan-boot.js'"))return modulesAvailable;
          if(code==='window.arcaneDesktop.workspacePreferences.read()')return{available:false,preferences:null};
          if(code.includes('const bridge=window.arcaneDesktop.runtimeRecovery;'))return{frozen:true,status:{version:1,state:'unavailable',message:''}};
          if(code==='window.arcaneDesktop.claudePreferences.read()')return{available:false,projectPath:null,preferences:null};
          if(code==='window.arcaneDesktop.toolDrafts.read()')return{available:false,projectPath:null,preferences:null};
          if(code.includes('d.claudeChat.status()'))return JSON.stringify({claudeChat:true,arcaneChat:true,studioPlugin:true,workspaceProject:true,dialogs:true,projectPermissions:true,billing:true,notifications:true,meshKeep:true,updates:true});
          if(code.includes('Arcane smoke first unsent draft.'))return JSON.stringify({draftsSeparate:true,stableComposer:true,cleaned:true,taskUsageInactive:true});
          assert.fail('Unexpected smoke renderer request');
        }}},Math,JSON,Buffer,
    };
    await vm.runInNewContext(check+'\ncheckSmoke()',context,{filename:'owned-check-smoke.cjs'});
    const report=JSON.parse(writes.get('C:\\Smoke\\checks.json'));
    assert.equal(report.checks.taskStatusModules,modulesAvailable);assert.equal(exits[0],modulesAvailable?0:1);
    assert.equal(report.inferenceStarted,false);assert.equal(report.studioOperations,0);
    assert.equal(scripts.filter(code=>code.includes("'/task-plan-boot.js'")).length,1);
    if(modulesAvailable)assert.ok(Object.values(report.checks).every(Boolean));
    assert.deepEqual(Object.keys(report.checks).sort(),[...REQUIRED_SMOKE_CHECKS].sort(),'checkSmoke and the executable verifier name the same checks');
    assert.equal(smokeChecksComplete(report.checks),modulesAvailable);
  }
});

test('executable verifier requires every named smoke check, including the newer desktop bridges',()=>{
  const all=Object.fromEntries(REQUIRED_SMOKE_CHECKS.map(name=>[name,true]));
  assert.equal(smokeChecksComplete(all),true);
  for(const name of ['claudeChatBridgeDisabledInSmoke','arcaneChatBridgeDisabledInSmoke','studioPluginBridgeDisabledInSmoke','workspaceProjectBridgeDisabledInSmoke','inAppDialogsBridgeMounted',
    'projectPermissionsBridgeDisabledInSmoke','billingBridgeNotConnectedInSmoke','notificationsBridgeSilentInSmoke','meshKeepBridgeUnavailableInSmoke','desktopUpdatesUnavailableInSmoke','bundledStudioPluginVerified','bundledPlansConfigValid','bundledChatInstructionsLoadable','trustedDecisionDialogsBundled']){
    assert.ok(REQUIRED_SMOKE_CHECKS.includes(name),name);
    const {[name]:_,...missing}=all;assert.equal(smokeChecksComplete(missing),false,name+' missing');
    assert.equal(smokeChecksComplete({...all,[name]:false}),false,name+' false');
  }
  assert.equal(smokeChecksComplete({...all,extra:false}),false);assert.equal(smokeChecksComplete(null),false);
});

test('smoke bridge probe accepts only the disabled verification-mode answers of the newer bridges',async()=>{
  const start=mainSource.indexOf('async function checkSmoke() {'),end=mainSource.indexOf('\n}\n',start);
  const probe=[...mainSource.slice(start,end).matchAll(/executeJavaScript\(`([\s\S]*?)`\)/g)].map(m=>m[1]).find(code=>code.includes('d.claudeChat.status()'));
  assert.ok(probe,'Expected the desktop bridge smoke probe.');
  const calls=[];
  const bridge=(names,impl={})=>Object.freeze({version:1,...Object.fromEntries(names.map(n=>[n,impl[n]??(()=>{calls.push(n);throw new Error('Smoke must not call '+n+'.');})]))});
  const desktop=overrides=>({
    claudeChat:bridge(['status','list','history','send','rewind','stop','remove','onEvent'],{status:async()=>{calls.push('chat.status');throw new Error('Claude chat is unavailable.');}}),
    arcaneChat:bridge(['status','list','history','send','rewind','stop','remove','onEvent'],{status:async()=>{calls.push('arcane.status');throw new Error('Arcane chat is unavailable.');}}),
    studioPlugin:bridge(['status','install'],{status:async()=>({version:1,state:'unavailable',pluginVersion:null,message:'Studio plugin setup is disabled in verification mode.'})}),
    workspaceProject:bridge(['open'],{open:async()=>{throw new Error('The project picker is unavailable.');}}),
    dialogs:bridge(['attach','reply']),
    projectPermissions:bridge(['read','save'],{read:async()=>({available:false,settings:{claudeTools:false,codexAutoApprove:false}})}),
    billing:bridge(['status','openCheckout'],{status:async()=>({version:1,state:'not-connected',message:"Checkout isn't connected yet",account:'unavailable'})}),
    notifications:bridge(['notify','onActivate'],{notify:async()=>({shown:false})}),
    updates:bridge(['status','restart'],{status:async()=>({version:1,state:'unavailable',buildId:null,message:'Updates are unavailable.'})}),
    meshKeep:bridge(['keep'],{keep:async()=>({state:'unavailable',message:'Keep this mesh is unavailable.'})}),
    ...overrides});
  const observe=async d=>JSON.parse(await vm.runInNewContext(probe,{window:{arcaneDesktop:d},Object,String,JSON}));
  const good=await observe(desktop({}));
  assert.deepEqual(good,{claudeChat:true,arcaneChat:true,studioPlugin:true,workspaceProject:true,dialogs:true,projectPermissions:true,billing:true,notifications:true,meshKeep:true,updates:true});
  assert.deepEqual(calls,['chat.status','arcane.status'],'only read-only or disabled calls are made');
  assert.equal((await observe(desktop({meshKeep:bridge(['keep'],{keep:async()=>({state:'started',message:''})})}))).meshKeep,false,'smoke must never start an upload');
  assert.equal((await observe(desktop({meshKeep:undefined}))).meshKeep,false);
  assert.equal((await observe(desktop({studioPlugin:bridge(['status','install'],{status:async()=>({state:'missing',message:'The Arcane Studio plugin is not installed yet.'})})}))).studioPlugin,false);
  assert.equal((await observe(desktop({billing:bridge(['status','openCheckout'],{status:async()=>({state:'ready',account:'unavailable'})})}))).billing,false);
  assert.equal((await observe(desktop({notifications:bridge(['notify','onActivate'],{notify:async()=>({shown:true})})}))).notifications,false);
  assert.equal((await observe(desktop({workspaceProject:bridge(['open'],{open:async()=>({requested:true})})}))).workspaceProject,false);
  assert.equal((await observe(desktop({dialogs:{version:1,attach(){},reply(){}}}))).dialogs,false,'bridges must be frozen');
  assert.equal((await observe(desktop({claudeChat:undefined}))).claudeChat,false);
  assert.equal((await observe(desktop({arcaneChat:undefined}))).arcaneChat,false);
  assert.equal((await observe(desktop({arcaneChat:bridge(['status','list','history','send','rewind','stop','remove','onEvent'],{status:async()=>({available:false})})}))).arcaneChat,false,'a disabled bridge must refuse in smoke');
  assert.equal((await observe(desktop({projectPermissions:bridge(['read','save'],{read:async()=>({available:true})})}))).projectPermissions,false);
});

function filesystemFixture() {
  const entries = new Map();
  const put = (path, options = {}) => entries.set(key(path), { path: win32.resolve(path), kind: 'directory', nlink: 1, ...options });
  put('C:\\');
  put('C:\\Smoke');
  put('C:\\Smoke\\new-empty');
  function entry(path) {
    const value = entries.get(key(path));
    if (!value) throw Object.assign(new Error('Fixture path absent.'), { code: 'ENOENT' });
    return value;
  }
  const stat = path => {
    const value = entry(path);
    return {
      nlink: value.nlink,
      isDirectory: () => value.kind === 'directory',
      isFile: () => value.kind === 'file',
      isSymbolicLink: () => value.kind === 'link',
    };
  };
  const physical = path => entry(path).physical ?? entry(path).path;
  const mkdir = path => {
    const parts = [];
    for (let current = win32.resolve(path); !entries.has(key(current)); current = win32.dirname(current)) parts.push(current);
    for (const part of parts.reverse()) put(part);
    return undefined;
  };
  const syncRealpath = path => entry(path).logical ?? physical(path);
  syncRealpath.native = physical;
  return {
    put,
    async: { lstat: async path => stat(path), realpath: async path => physical(path), mkdir: async path => mkdir(path) },
    sync: {
      lstatSync: stat, realpathSync: syncRealpath, mkdirSync: mkdir,
      existsSync: path => entries.has(key(path)),
      readdirSync: path => [...entries.values()].filter(value => key(win32.dirname(value.path)) === key(path) && key(value.path) !== key(path)).map(value => win32.basename(value.path)),
    },
  };
}

function windowsPolicy(fs = filesystemFixture()) {
  const module = { exports: {} };
  vm.runInNewContext(policySource, {
    module, URL, process: { platform: 'win32' },
    require(name) {
      if (name === 'node:path') return win32;
      if (name === 'node:fs/promises') return fs.async;
      if (name === 'node:fs') return fs.sync;
      throw new Error('Unexpected policy dependency: ' + name);
    },
  }, { filename: 'policy.cjs' });
  return module.exports;
}
const policy = windowsPolicy();

function productServiceFixture({ closeFailAt } = {}) {
  const directory = 'C:\\UserData\\runtime\\projects\\fixture', cwd = 'C:\\Arcane\\resources\\product', projectPath = 'C:\\Project';
  const artifactHash = 'd'.repeat(64), services = {}, events = [];
  let hostConfiguration, savedArgs, exitCode, descriptorRemoved = false;
  const created = (resource, instance) => { assert.equal(services[resource], undefined); services[resource]=instance; events.push({operation:'create',resource}); return instance; };
  const closed = (resource, instance) => {
    assert.equal(instance, services[resource], 'Cleanup retains the exact owned instance.');
    assert.equal(events.filter(value => value.operation === 'close' && value.resource === resource).length, 0);
    events.push({operation:'close',resource});
    if (resource === closeFailAt) throw new Error('Synthetic ' + resource + ' close failure');
  };
  const context = {
    cwd, runtimeRoot:'C:\\UserData', directory, connectionDirectory:win32.join(directory,'connection-lab'),
    stateOverride:directory, resourceOverride:cwd, port:0, workflowCodeVerification:undefined,
    diagnosticReporter:{report:async()=>null,close(){}},
    process:{env:{ARCANE_PROJECT:projectPath},pid:17,exit(code){exitCode=code;}},
    join:win32.join, resolve:win32.resolve, basename:win32.basename, dirname:win32.dirname,
    async reportStartupFailure(){ assert.fail('A healthy product composition must not report a startup failure.'); },
    StudioStore:class { constructor(options) { assert.equal(options.directory,directory); created('studio',this); } close(){closed('studio',this);} },
    WorkStore:class { constructor(options) { assert.equal(options.directory,directory); assert.equal(options.projectPath,projectPath); created('work',this); } close(){closed('work',this);} },
    ConversationWorkStore:class { constructor(options) { assert.equal(options.directory,win32.join(directory,'connection-lab','conversation-work')); assert.equal(options.projectPath,projectPath); this.projectPath=projectPath; created('associations',this); } close(){closed('associations',this);} },
    async studioImportPluginArtifactHash(root) { assert.equal(root,cwd); events.push({operation:'create',resource:'artifact'}); return artifactHash; },
    async createStudioImportPreparationStore(options) {
      assert.deepEqual(Object.keys(options).sort(), ['directory','projectPath','studio','workAssociations']);
      assert.equal(options.projectPath,projectPath); assert.equal(options.directory,win32.join(directory,'studio-import-preparations'));
      assert.equal(options.studio,services.studio); assert.equal(options.workAssociations,services.associations);
      return created('preparations',Object.freeze({async save(...args){assert.equal(this,services.preparations);savedArgs=args;},
        async get(){assert.fail('Metadata fixture never reads preparations.');},async close(){closed('preparations',this);}}));
    },
    createStudioImportHost(options) {
      assert.deepEqual(Object.keys(options).sort(), ['persistPreparation','pluginArtifactHash','projectPath','studio','workAssociations']);
      assert.equal(options.projectPath,projectPath); assert.equal(options.studio,services.studio); assert.equal(options.workAssociations,services.associations);
      assert.equal(options.pluginArtifactHash,artifactHash,'Await the bundled artifact loader.');
      assert.equal(events.filter(value => value.resource === 'artifact').length,1); assert.ok(services.preparations);
      assert.equal(typeof options.persistPreparation,'function'); hostConfiguration=options;
      const hooks=Object.freeze({workAssociations:services.associations,selectTarget(){assert.fail('Metadata fixture must not observe Studio.');},
        validateTarget(){assert.fail('Metadata fixture must not read engine state.');},recordPrepared(){assert.fail('Metadata fixture must not prepare or upload.');},
        releaseTarget(){assert.fail('Metadata fixture must not operate on an engine target.');}});
      return created('host',Object.freeze({hooks,close(){closed('host',this);}}));
    },
    async createAssetService(options) {
      assert.equal(options.projectPath,services.associations.projectPath); assert.equal(options.studioImport,services.host.hooks);
      assert.equal(options.studioImport.workAssociations,services.associations);
      assert.ok(options.studioImport.workAssociations instanceof context.ConversationWorkStore);
      assert.equal(options.outputRoot,win32.join(directory,'assets'));
      return created('assets',{options,async close(){closed('assets',this);}});
    },
    createStudioImportStagingController(options) {
      assert.deepEqual(Object.keys(options).sort(), ['assets','host','pluginArtifactHash','projectPath','studio','workAssociations']);
      assert.equal(options.assets,services.assets); assert.equal(options.host,services.host.hooks);
      assert.equal(options.studio,services.studio); assert.equal(options.workAssociations,services.associations);
      assert.equal(options.projectPath,projectPath); assert.equal(options.pluginArtifactHash,artifactHash);
      assert.equal(events.filter(value=>value.resource==='artifact').length,1);
      return created('staging',Object.freeze({stage(){assert.fail('Metadata fixture must never stage or upload.');},close(){closed('staging',this);}}));
    },
    createLearningService() { return created('learning',{close(){closed('learning',this);}}); },
    async createConnectionLab(options) {
      assert.equal(options.studioStore,services.studio); assert.equal(options.workStore,services.work);
      assert.equal(options.conversationWorkStore,services.associations); assert.equal(options.assetService,services.assets); assert.equal(options.learningService,services.learning);
      assert.equal(options.studioImportStaging,services.staging);
      assert.equal(options.preferenceGlobalDirectory,win32.join('C:\\UserData','runtime','learned-preferences'));
      return created('lab',{origin,async close(){closed('lab',this);}});
    },
  };
  const cleanupBegin = productSource.indexOf('async function cleanupStartup('), cleanupEnd = productSource.indexOf('// The desktop host',cleanupBegin);
  const begin = productSource.indexOf('let store: StudioStore;'), end = productSource.indexOf('const descriptor =',begin);
  assert.ok(cleanupBegin >= 0 && cleanupEnd > cleanupBegin && begin >= 0 && end > begin,'Expected the trusted product composition boundary.');
  const initialize = () => vm.runInNewContext(stripTypeScriptTypes('(async () => {\n' + productSource.slice(cleanupBegin,cleanupEnd) + productSource.slice(begin,end) + '\nreturn {store,work,associations,assets,learning,app};\n})()'),context);
  const shutdown = async () => {
    const shutdownBegin = productSource.indexOf('async function shutdown()'), shutdownEnd = productSource.indexOf('for (const signal',shutdownBegin);
    assert.ok(shutdownBegin >= 0 && shutdownEnd > shutdownBegin,'Expected the product shutdown boundary.');
    const descriptor=win32.join(directory,'daemon.json');
    await vm.runInNewContext(stripTypeScriptTypes('let closing=false;\n' + productSource.slice(shutdownBegin,shutdownEnd) + '\nshutdown();'),{
      ...context,app:services.lab,assets:services.assets,learning:services.learning,associations:services.associations,work:services.work,store:services.studio,
      importHost:services.host,importStaging:services.staging,preparations:services.preparations,descriptor,
      setTimeout(){return {unref(){}};},clearTimeout(){},console:{error(message){assert.match(message,/cleanup had an error/);}},
      async readFile(path){assert.equal(path,descriptor);return JSON.stringify({pid:17,origin});},
      async unlink(path){assert.equal(path,descriptor);descriptorRemoved=true;},
    });
  };
  return {initialize,shutdown,services,events,get hostConfiguration(){return hostConfiguration;},get savedArgs(){return savedArgs;},get exitCode(){return exitCode;},get descriptorRemoved(){return descriptorRemoved;}};
}

test('product import wiring forwards original and explicit preparation attempts to the same owned ledger', async () => {
  const f=productServiceFixture(); await f.initialize();
  const resources=f.events.filter(value => value.operation === 'create').map(value => value.resource);
  assert.ok(resources.indexOf('host') > resources.indexOf('preparations'));
  assert.ok(resources.indexOf('host') > resources.indexOf('artifact')); assert.ok(resources.indexOf('assets') > resources.indexOf('host'));
  const args=[Object.freeze({fixture:'actor'}),'synthetic-job',Object.freeze({fixture:'plan'}),Object.freeze({fixture:'witness'}),()=>assert.fail('Forward the guard without invoking it.')];
  for (const forwarded of [args,[...args,undefined],[...args,'22222222-2222-4222-8222-222222222222']]) {
    await f.hostConfiguration.persistPreparation(...forwarded);
    assert.equal(f.savedArgs.length,forwarded.length,'Do not discard the optional sixth preparation-attempt argument.');
    for(let i=0;i<forwarded.length;i++) assert.equal(f.savedArgs[i],forwarded[i],'Preserve actor, plan, witness, guard and attempt identity/order.');
  }
  await f.shutdown();
  assert.deepEqual(f.events.filter(value => value.operation === 'close').map(value => value.resource).sort(),['assets','associations','host','lab','learning','preparations','staging','studio','work']);
  assert.equal(f.exitCode,0); assert.equal(f.descriptorRemoved,true);
});

test('product host close failure still closes the same ledger, assets and borrowed stores', async () => {
  const f=productServiceFixture({closeFailAt:'host'}); await f.initialize(); await f.shutdown();
  assert.deepEqual(f.events.filter(value => value.operation === 'close').map(value => value.resource).sort(),['assets','associations','host','lab','learning','preparations','staging','studio','work']);
  assert.equal(f.exitCode,1); assert.equal(f.descriptorRemoved,true);
});

test('staging close failure still drains every other product-owned service', async () => {
  const f=productServiceFixture({closeFailAt:'staging'}); await f.initialize(); await f.shutdown();
  assert.deepEqual(f.events.filter(value=>value.operation==='close').map(value=>value.resource).sort(),['assets','associations','host','lab','learning','preparations','staging','studio','work']);
  assert.equal(f.exitCode,1); assert.equal(f.descriptorRemoved,true);
});

test('origin accepts only canonical numeric IPv4 loopback and a valid port', () => {
  assert.equal(policy.validOrigin(origin), true);
  for (const value of [
    '', 'http://127.0.0.1:0', 'http://127.0.0.1:65536', 'http://127.0.0.1:045871',
    'http://localhost:45871', 'http://[::1]:45871', 'https://127.0.0.1:45871',
    origin + '/', origin + '?token=' + token, origin + '#' + token,
  ]) assert.equal(policy.validOrigin(value), false, value);
});

test('navigation accepts the workspace fragment but rejects other origins, paths and queries', () => {
  assert.equal(policy.navigationAllowed(origin, origin + '/studio#' + token), true);
  assert.equal(policy.navigationAllowed(origin, origin + '/'), true);
  for (const value of [
    'https://example.com/#' + token, 'file:///C:/Windows/win.ini', 'javascript:alert(1)',
    'http://127.0.0.1:45872/studio', origin + '/v1/product/state',
    origin + '/studio?token=' + token, 'http://user:pass@127.0.0.1:45871/studio',
  ]) assert.equal(policy.navigationAllowed(origin, value), false, value);
});

test('requests allow only the owned origin and its blob downloads', () => {
  for (const value of [origin + '/studio.js', origin + '/v1/product/state', 'blob:' + origin + '/fixture']) assert.equal(policy.requestAllowed(origin, value), true, value);
  for (const value of [
    'https://example.com/', 'http://127.0.0.1:45872/', 'http://localhost:45871/',
    'file:///C:/Windows/win.ini', 'data:text/html,fixture', 'ws://127.0.0.1:45871/',
    'blob:https://example.com/fixture', 'blob:null/fixture', 'http://user:pass@127.0.0.1:45871/',
  ]) assert.equal(policy.requestAllowed(origin, value), false, value);
  assert.equal(policy.requestAllowed('', origin + '/studio.js'), false);
});

test('private ready handoff requires the exact envelope and bounded endpoint', () => {
  const ready = { type: 'arcane-ready', protocolVersion: 1, origin, token };
  assert.equal(policy.readyMessage(ready).origin, origin);
  for (const value of [
    null, {}, { ...ready, extra: true }, { ...ready, protocolVersion: 2 },
    { ...ready, type: 'ready' }, { ...ready, origin: 'http://localhost:45871' },
    { ...ready, token: 'short' }, { ...ready, token: 'g'.repeat(64) },
  ]) assert.throws(() => policy.readyMessage(value));
});

test('daemon environment drops credentials, runtime injection and inherited Arcane overrides', () => {
  const env = policy.daemonEnvironment({
    PATH: 'C:\\Windows\\System32', APPDATA: 'C:\\Users\\Fixture\\AppData\\Roaming',
    OPENAI_API_KEY: 'fixture-secret', ANTHROPIC_API_KEY: 'fixture-secret',
    NODE_OPTIONS: '--require=C:\\fixture.js', NODE_PATH: 'C:\\foreign',
    ELECTRON_RUN_AS_NODE: '1', ARCANE_LOCAL_TOKEN: token, ARCANE_PORT: '1',
    ARCANE_DAEMON_URL: 'https://example.com', CODEX_HOME: 'C:\\foreign',
  }, { productRoot: 'C:\\App\\resources\\product', stateRoot: 'C:\\UserData\\runtime\\projects\\fixture', projectPath: 'C:\\Project' });
  assert.deepEqual(Object.keys(env).sort(), ['APPDATA', 'ARCANE_PORT', 'ARCANE_PROJECT', 'ARCANE_RESOURCE_DIRECTORY', 'ARCANE_STATE_DIRECTORY', 'PATH'].sort());
  assert.equal(env.ARCANE_PORT, '0');
  assert.equal(env.ARCANE_RESOURCE_DIRECTORY, 'C:\\App\\resources\\product');
  assert.equal(env.ARCANE_STATE_DIRECTORY, 'C:\\UserData\\runtime\\projects\\fixture');
  assert.equal(env.ARCANE_PROJECT, 'C:\\Project');
});

test('Windows path validation rejects traversal, network, device, ADS and reserved names', () => {
  assert.equal(policy.localPath('C:\\Smoke\\new-empty'), 'C:\\Smoke\\new-empty');
  for (const value of [
    '', 'relative', 'C:relative', 'C:\\', '\\\\server\\share\\folder', '//server/share/folder',
    '\\\\?\\C:\\Smoke', '\\\\.\\C:\\Smoke', 'C:\\Smoke\\..\\escape', 'C:\\Smoke\\.\\folder',
    'C:\\Smoke\\NUL.txt', 'C:\\Smoke\\CON', 'C:\\Smoke\\COM1.txt',
    'C:\\Smoke\\folder.', 'C:\\Smoke\\folder ', 'C:\\Smoke\\file:stream', 'C:\\Smoke\\bad\u0000name',
  ]) assert.throws(() => policy.localPath(value), undefined, JSON.stringify(value));
});

test('regression: Windows paths require a drive-qualified absolute root', () => {
  for (const value of ['\\Temp\\Smoke', '/Temp/Smoke']) assert.throws(() => policy.localPath(value), undefined, value);
});

test('path containment excludes root equality, siblings and other drives', () => {
  assert.equal(policy.within('C:\\UserData\\runtime', 'C:\\UserData\\runtime\\projects\\fixture'), true);
  for (const value of ['C:\\UserData\\runtime', 'C:\\UserData\\runtime-other\\fixture', 'C:\\UserData\\outside', 'D:\\UserData\\runtime\\fixture']) assert.equal(policy.within('C:\\UserData\\runtime', value), false, value);
});

test('direct path validation rejects parent links and physically redirected directories', async () => {
  const fs = filesystemFixture(), checked = windowsPolicy(fs);
  await checked.directPath('C:\\Smoke\\new-empty');
  fs.put('C:\\Smoke', { kind: 'link', physical: 'C:\\Elsewhere' });
  await assert.rejects(checked.directPath('C:\\Smoke\\new-empty'));
  fs.put('C:\\Smoke', { physical: 'C:\\Elsewhere' });
  await assert.rejects(checked.directPath('C:\\Smoke\\new-empty'));
});

test('missing leaf allowance still rejects unsafe existing ancestors and hardlinked files', async () => {
  const fs = filesystemFixture(), checked = windowsPolicy(fs);
  assert.equal(await checked.directPath('C:\\Smoke\\new-empty\\missing', 'directory', true), 'C:\\Smoke\\new-empty\\missing');
  fs.put('C:\\Smoke\\new-empty\\record.json', { kind: 'file', nlink: 2 });
  await assert.rejects(checked.directPath('C:\\Smoke\\new-empty\\record.json', 'file'));
  fs.put('C:\\Smoke\\new-empty', { kind: 'file' });
  await assert.rejects(checked.directPath('C:\\Smoke\\new-empty\\missing', 'directory', true));
});

test('preload exposes immutable identity and only the bounded Luau verification intents', () => {
  let exposed;
  vm.runInNewContext(preloadSource, {
    require(name) {
      assert.equal(name, 'electron');
      return { contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'arcaneDesktop'); exposed = value; } } };
    },
  });
  assert.deepEqual(Object.keys(exposed).sort(), ['arcaneChat', 'billing', 'chatQueue', 'claudeChat', 'claudePreferences', 'codeVerification', 'conversationLibrary', 'dialogs', 'meshKeep', 'nativeHandoff', 'notifications', 'platform', 'projectPermissions', 'providerSetup', 'runtime', 'runtimeRecovery', 'selectAssetConversation', 'setupChecklist', 'studioKeys', 'studioPlugin', 'toolDrafts', 'updates', 'version', 'welcomeTour', 'workspacePreferences', 'workspaceProject']);
  assert.equal(typeof exposed.selectAssetConversation, 'function');
  assert.equal(Object.isFrozen(exposed.conversationLibrary), true);
  assert.deepEqual(Object.keys(exposed.conversationLibrary).sort(), ['read', 'save', 'version']);
  assert.equal(exposed.conversationLibrary.version, 1);
  assert.equal(Object.isFrozen(exposed.chatQueue), true);
  assert.deepEqual(Object.keys(exposed.chatQueue).sort(), ['read', 'save', 'version']);
  assert.equal(exposed.chatQueue.version, 1);
  assert.equal(Object.isFrozen(exposed.runtimeRecovery), true);
  assert.deepEqual(Object.keys(exposed.runtimeRecovery).sort(), ['acknowledge','onCheckpoint','onState','ready','retry','status','version']);
  assert.equal(Object.isFrozen(exposed.billing), true);
  assert.deepEqual(Object.keys(exposed.billing).sort(), ['connectAccount', 'disconnectAccount', 'openCheckout', 'status', 'version']);
  assert.equal(exposed.billing.version, 1);
  assert.equal(Object.isFrozen(exposed.notifications), true);
  assert.deepEqual(Object.keys(exposed.notifications).sort(), ['notify', 'onActivate', 'version']);
  assert.equal(Object.isFrozen(exposed.meshKeep), true);
  assert.deepEqual(Object.keys(exposed.meshKeep).sort(), ['keep', 'version']);
  assert.equal(Object.isFrozen(exposed.dialogs), true);
  assert.deepEqual(Object.keys(exposed.dialogs).sort(), ['attach', 'reply', 'version']);
  assert.equal(Object.isFrozen(exposed.projectPermissions), true);
  assert.deepEqual(Object.keys(exposed.projectPermissions).sort(), ['read', 'save', 'version']);
  assert.equal(Object.isFrozen(exposed.studioPlugin), true);
  assert.deepEqual(Object.keys(exposed.studioPlugin).sort(), ['autoUpdate', 'disableAutoUpdate', 'enableAutoUpdate', 'install', 'preference', 'status', 'version']);
  assert.equal(Object.isFrozen(exposed.workspaceProject), true);
  assert.deepEqual(Object.keys(exposed.workspaceProject).sort(), ['open', 'version']);
  assert.equal(Object.isFrozen(exposed.nativeHandoff), true);
  assert.deepEqual(Object.keys(exposed.nativeHandoff).sort(), ['launch', 'list', 'revoke', 'version']);
  assert.equal(exposed.runtime, 'desktop');
  assert.equal(Object.isFrozen(exposed), true);
  assert.equal(Object.isFrozen(exposed.codeVerification), true);
  assert.equal(Object.isFrozen(exposed.providerSetup),true);
  assert.equal(Object.isFrozen(exposed.claudeChat), true);
  assert.equal(Object.isFrozen(exposed.arcaneChat), true);
  assert.deepEqual(Object.keys(exposed.arcaneChat).sort(), ['history', 'list', 'onEvent', 'remove', 'rewind', 'send', 'status', 'stop', 'version']);
  assert.equal(Object.isFrozen(exposed.studioKeys), true);
  assert.equal(Object.isFrozen(exposed.workspacePreferences), true);
  assert.equal(Object.isFrozen(exposed.claudePreferences), true);
  assert.equal(Object.isFrozen(exposed.toolDrafts), true);
  assert.deepEqual(Object.keys(exposed.toolDrafts).sort(), ['read', 'save', 'version']);
  assert.deepEqual(Object.keys(exposed.claudePreferences).sort(), ['read', 'save', 'version']);
  assert.deepEqual(Object.keys(exposed.workspacePreferences).sort(), ['read', 'save', 'version']);
  assert.deepEqual(Object.keys(exposed.studioKeys).sort(), ['copy', 'forget', 'list', 'remember', 'replace', 'reveal', 'version']);
  assert.deepEqual(Object.keys(exposed.providerSetup).sort(),['install','launch','login','status','version']);
  assert.deepEqual(Object.keys(exposed.codeVerification).sort(), ['configure', 'status', 'version']);
});

test('source contract: renderer isolation, exact navigation and deny-by-default permissions', () => {
  for (const property of ['sandbox: true', 'contextIsolation: true', 'nodeIntegration: false', 'nodeIntegrationInWorker: false', 'nodeIntegrationInSubFrames: false', 'webSecurity: true', 'allowRunningInsecureContent: false', 'webviewTag: false']) assert.ok(mainSource.includes(property), property);
  for (const event of ['will-navigate', 'will-frame-navigate', 'will-redirect', 'will-attach-webview']) assert.ok(mainSource.includes("'" + event + "'"), event);
  assert.match(mainSource, /event\.isMainFrame/);
  assert.match(mainSource, /policy\.navigationAllowed\(origin,\s*event\.url\)/);
  assert.match(mainSource, /onBeforeRequest[\s\S]*policy\.requestAllowed\(origin,\s*details\.url\)/);
  assert.match(mainSource, /setWindowOpenHandler\([\s\S]*?action:\s*'deny'/);
  assert.match(mainSource, /policy\.installClipboardPermissions\(owner\.webContents\.session,/);
  assert.match(mainSource, /active: !closing && !switching && window === owner/);
  assert.match(mainSource, /setDevicePermissionHandler\(\(\)\s*=>\s*false\)/);
});

test('source contract: bundled resource entry executes in owned writable cwd over private IPC', () => {
  assert.match(mainSource, /const entry = await policy\.directPath\(join\(productRoot, 'dist\/apps\/daemon\/src\/product-main\.js'\), 'file'\)/);
  assert.match(mainSource, /spawn\(nodeExecutable,\s*\[entry\]/);
  assert.match(mainSource, /cwd:\s*userRoot/);
  assert.match(mainSource, /shell:\s*false/);
  assert.match(mainSource, /windowsHide:\s*true/);
  // stdout (which carries the workspace token) stays ignored; only stderr may reach the bounded state-root log.
  assert.match(mainSource, /stdio:\s*\['ignore',\s*'ignore',\s*stderrLog \? 'pipe' : 'ignore',\s*'ipc'\]/);
  assert.match(mainSource, /const stderrLog = policy\.daemonStderrLog\(stateRoot\)/);
  // Project switch stops the old runtime before starting the next one (through the in-use question wrapper).
  assert.match(mainSource, /await stopDaemon\(\)[\s\S]*?if \(!await startProjectRuntime\(path\)\) return;/);
  assert.match(productSource, /outputRoot:\s*join\(directory,\s*'assets'\)/);
  assert.match(productSource, /process\.send\(\{\s*type:\s*'arcane-ready'/);
});

test('regression: loss of the private desktop IPC parent triggers daemon shutdown', () => {
  assert.match(productSource, /process\.(?:once|on)\(\s*['"]disconnect['"]\s*,\s*(?:shutdown|\([^)]*\)\s*=>\s*\{?\s*(?:void\s+)?shutdown\()/,
    'An Electron crash must fence the child rather than leave its daemon bearer and active work alive.');
});

function stopFixture(child) {
  const begin = mainSource.indexOf('async function stopDaemon()');
  const end = mainSource.indexOf('async function startDaemon(', begin);
  assert.ok(begin >= 0 && end > begin, 'Expected the named desktop shutdown boundary.');
  const assetEvents = [];
  const assets = { fence() { assetEvents.push('fence'); }, close() { assetEvents.push('close'); },
    transportClosed() { assert.fail('Desktop shutdown cannot claim an app-provider child has closed.'); } };
  const context = { child, token, origin, nativeHandoff: null, appAssets: assets, assetSelectionGeneration: 7, assetSelectionReady: true, assetEvents,
    loginCancellations: 0, providerSetup: null, setTimeout: () => 1, clearTimeout() {}, retireDiagnosticChild() {} };
  context.providerSetup = { cancelPending() { assert.deepEqual(assetEvents, ['fence'], 'asset admission is fenced before provider cancellation'); context.loginCancellations++; } };
  vm.createContext(context);
  vm.runInContext(mainSource.slice(begin, end) + '\nglobalThis.stopOwned = stopDaemon;', context);
  return context;
}

test('private stop revokes the host credential immediately and waits for the owned close', async () => {
  const child = new EventEmitter();
  Object.assign(child, { exitCode: null, connected: true, kill() { assert.fail('Fixture cleanup should not kill a healthy child.'); } });
  let envelope;
  child.send = (message, callback) => { envelope = message; callback(null); };
  const fixture = stopFixture(child);
  let settled = false;
  const stopped = fixture.stopOwned().then(clean => { settled = true; return clean; });
  assert.equal(fixture.appAssets, null); assert.equal(fixture.assetSelectionReady, false); assert.equal(fixture.assetSelectionGeneration, 8);
  assert.deepEqual(fixture.assetEvents, ['fence'], 'asset authority is fenced synchronously before daemon quiescence');
  await Promise.resolve();
  assert.equal(fixture.token, '');
  assert.equal(fixture.origin, '');
  assert.equal(fixture.loginCancellations, 1, 'The owned pending sign-in is cancelled before waiting for daemon quiescence.');
  assert.equal(settled, false);
  assert.deepEqual(JSON.parse(JSON.stringify(envelope)), { type: 'arcane-shutdown', protocolVersion: 1 });
  child.exitCode = 0;
  child.emit('close', 0);
  assert.equal(await stopped, true);
  assert.deepEqual(fixture.assetEvents, ['fence', 'close'], 'broker close follows the owned daemon close');
});

test('regression: an already failed owned child cannot count as clean quiescence', async () => {
  const fixture = stopFixture({ exitCode: 9, connected: false });
  assert.equal(await fixture.stopOwned(), false, 'Failed shutdown must not authorize a new project runtime.');
  assert.equal(fixture.loginCancellations, 1);
  assert.deepEqual(fixture.assetEvents, ['fence', 'close'], 'failed child cleanup still fences and closes its exact private broker');
});

test('regression: post-idle shutdown fences fresh requests before awaiting child cleanup', async () => {
  // Source boundary fixture: neither a real listener nor a native service runs.
  const begin = labSource.lastIndexOf('close(): Promise<void> {');
  const end = labSource.indexOf('\n    }', begin);
  assert.ok(begin >= 0 && end > begin, 'Expected the connection lab lifecycle boundary.');
  const member = labSource.slice(begin, end + '\n    }'.length);
  let release, humanSelectionFenced = false, appAssetsFenced = false, nativeAssetsFenced = false, taskAdmissionFenced = false, handoffsFenced = false;
  const childCleanup = new Promise(resolve => { release = resolve; });
  const server = {
    accepting: true,
    closeAllConnections() {},
    close(callback) { this.accepting = false; callback?.(); return this; },
    closeIdleConnections() {},
  };
  const cleanup = vm.runInNewContext(stripTypeScriptTypes('let cleanup=null,shuttingDown=false; const fixture = { ' + member + ' }; fixture.close.bind(fixture);'), {
    server, workflow: null, modelReviews: null, associations: null, ownsAssociations: false, ArcaneError: Error,
    humanAssetSelection: { close() { humanSelectionFenced = true; } },
    appAssets: { close() { assert.equal(humanSelectionFenced, true, 'human selection is fenced before private app admission'); appAssetsFenced = true; } },
    fenceTasks() { assert.equal(appAssetsFenced, true, 'Private app asset admission is fenced before task cleanup'); taskAdmissionFenced = true; return []; },
    handoffs: { close() { assert.equal(taskAdmissionFenced, true, 'Task admission is fenced before handoff retirement'); handoffsFenced = true; } },
    ownedTests: { lifecycle: { close: async () => { assert.equal(taskAdmissionFenced, true, 'Task admission is fenced before test terminal publication'); assert.equal(nativeAssetsFenced, true, 'Native authority is fenced before test cleanup'); assert.equal(handoffsFenced,true,'Handoff authority is fenced before test cleanup'); } } },
    ownedSourceVerifier: { dispose() { assert.equal(taskAdmissionFenced, true, 'Task admission is fenced before compiler disposal'); assert.equal(nativeAssetsFenced, true, 'Native authority is fenced before compiler disposal'); assert.equal(handoffsFenced,true,'Handoff authority is fenced before compiler disposal'); } },
    nativeAssetRegistry: { close() { assert.equal(appAssetsFenced, true, 'Private app asset admission is fenced before registry retirement'); assert.equal(taskAdmissionFenced, true, 'Task admission is fenced before registry retirement'); nativeAssetsFenced = true; } },
    scriptSync: { close() { assert.equal(taskAdmissionFenced, true, 'Task admission is fenced before script sync stops watching'); } },
    codex: { close: () => { assert.equal(taskAdmissionFenced, true, 'Task admission must be fenced before child cleanup'); assert.equal(nativeAssetsFenced, true, 'Native authority must be fenced before child cleanup'); assert.equal(handoffsFenced,true,'Handoff authority must be fenced before child cleanup'); return childCleanup; } },
  });
  const closing = cleanup();
  try {
    await Promise.resolve();
    assert.equal(server.accepting, false, 'A holder of the old agent bearer can currently open a fresh socket while shutdown waits.');
    assert.equal(humanSelectionFenced, true, 'Shutdown invalidates human selection before awaiting child cleanup');
    assert.equal(taskAdmissionFenced, true, 'Shutdown fences tasks while child cleanup is still held');
    assert.equal(appAssetsFenced, true, 'Shutdown fences private app assets while child cleanup is still held');
    assert.equal(nativeAssetsFenced, true, 'Shutdown retires native authority while child cleanup is still held');
    assert.equal(handoffsFenced,true,'Shutdown retires handoff authority while child cleanup is still held');
  } finally {
    release();
    await closing;
  }
});

test('regression: empty smoke fixture creates its profile before Electron setPath', () => {
  const fs = filesystemFixture(), paths = new Map();
  const app = {
    isPackaged: true, setName() {}, setAppUserModelId() {}, enableSandbox() {},
    commandLine: { appendSwitch() {} }, requestSingleInstanceLock: () => false, quit() {},
    setPath(name, path) {
      if (!fs.sync.existsSync(path)) throw new Error('Electron setPath requires an existing directory.');
      paths.set(name, path);
    },
    getPath: name => paths.get(name) ?? 'C:\\UserData',
  };
  assert.doesNotThrow(() => vm.runInNewContext(mainSource, {
    require(name) {
      if (name === 'electron') return { app, BrowserWindow: class {}, Menu: {}, dialog: {}, nativeTheme: {} };
      if (name === 'node:child_process') return { spawn() { assert.fail('Smoke fixture must not spawn a daemon.'); } };
      if (name === 'node:path') return win32;
      if (name === 'node:fs/promises') return fs.async;
      if (name === 'node:fs') return fs.sync;
      if (name === 'node:crypto') return { createHash() { assert.fail('Fixture must not start runtime work.'); } };
      if (name === './policy.cjs') return windowsPolicy(fs);
      if (name === './provider-setup.cjs') return {createProviderSetup(){assert.fail('Fixture must not start provider setup work.');}};
      if (name === './code-verification.cjs') return { createCodeVerification() { assert.fail('Fixture must not start runtime work.'); } };
      if (name === './studio-key-vault.cjs') return { createStudioKeyVault() { assert.fail('Fixture must not start key storage work.'); } };
      if (name === './workspace-preferences.cjs') return { createWorkspacePreferences() { assert.fail('Fixture must not start preference storage work.'); } };
      throw new Error('Unexpected host dependency: ' + name);
    },
    process: { argv: ['C:\\Arcane\\Arcane.exe', '--arcane-smoke', 'C:\\Smoke\\new-empty'], platform: 'win32', resourcesPath: 'C:\\Arcane\\resources', env: {}, stdout: new EventEmitter(), stderr: new EventEmitter() },
    __dirname: 'C:\\Arcane\\resources\\app', performance: { now: () => 0 },
  }, { filename: 'main.cjs' }));
  assert.equal(paths.get('userData'), 'C:\\Smoke\\new-empty\\profile');
});

test('regression: normal packaged asset state is accepted outside resources and OS Temp', async () => {
  const resources = 'C:\\Program Files\\Arcane\\resources\\product';
  const userData = 'C:\\Users\\Fixture\\AppData\\Roaming\\Arcane';
  const directory = win32.join(userData, 'runtime', 'projects', 'fixture');
  const temp = 'C:\\Users\\Fixture\\AppData\\Local\\Temp';
  // Evaluate only the trusted constructor arguments, never the daemon entry.
  const constructor = /assets\s*=\s*await\s*createAssetService\(([\s\S]*?)\)\s*;\s*\}\s*catch/.exec(productSource);
  assert.ok(constructor, 'Expected product asset-service initialization.');
  class ConversationWorkStore { constructor(projectPath) { this.projectPath=projectPath; } }
  const associations = new ConversationWorkStore('C:\\Project');
  const importHooks = Object.freeze({workAssociations:associations,selectTarget() { assert.fail('Asset path evaluation must not observe Studio.'); }});
  const options = await vm.runInNewContext('(async () => capture(' + constructor[1] + '))()', {
    capture: value => value, cwd: resources, runtimeRoot: userData, projectPath: 'C:\\Project', associations, stateOverride: directory,
    resourceOverride: resources, directory, join: win32.join, importHost: { hooks:importHooks },
    diagnosticReporter:Object.freeze({report:async()=>null,close(){}}),
    modelReview:Object.freeze({assertApproved(){assert.fail('Path fixture must not approve a model.');},assertReference(){assert.fail('Path fixture must not inspect a decision.');}}),
  });
  assert.equal(options.studioImport, importHooks, 'Packaged assets use the same owned production host hooks.');
  assert.equal(options.modelReviewAssociations,associations,'Review uses the same conversation binding store.');
  assert.equal(typeof options.modelReview.assertApproved,'function');
  assert.equal(options.studioImport.workAssociations, associations, 'The asset scope borrows the same conversation store.');
  const serviceSource = source('apps/daemon/src/asset-service.ts');
  const begin = serviceSource.indexOf('export async function createAssetService(');
  const end = serviceSource.indexOf('  const ownerKey', begin);
  assert.ok(begin >= 0 && end > begin, 'Expected asset root validation boundary.');
  const validation = serviceSource.slice(begin, end).replace('export ', '') + 'return root;\n}\ncreateAssetService(options);';
  const pathsSource = source('packages/asset-pipeline/src/paths.ts');
  const rootBegin = pathsSource.indexOf('export async function prepareOutputRoot(');
  const rootEnd = pathsSource.indexOf('export async function regularFile(', rootBegin);
  assert.ok(rootBegin >= 0 && rootEnd > rootBegin, 'Expected output-root policy boundary.');
  const rootPolicy = pathsSource.slice(rootBegin, rootEnd).replace('export ', '');
  const fs = filesystemFixture();
  for (const path of [resources, userData, directory, temp]) fs.sync.mkdirSync(path);
  const writes = [];
  const result = await vm.runInNewContext(stripTypeScriptTypes(rootPolicy + '\n' + validation), {
    options, ...win32, process: { platform: 'win32' }, ArcaneError: Error, AssetError: Error, ConversationWorkStore,
    realpath: fs.async.realpath, lstat: fs.async.lstat, noLinks: async () => {}, tmpdir: () => temp,
    within: (root, target) => key(root) === key(target) || policy.within(root, target),
    mkdir: async path => { writes.push(path); return fs.async.mkdir(path); },
  });
  assert.equal(result, win32.join(directory, 'assets'));
  assert.ok(writes.every(path => policy.within(userData, path)), 'Asset initialization may write only beneath owned userData.');
  // Generation repeats the containment check: fixing service initialization alone
  // must not leave the actual pipeline rooted in the immutable installation.
  const pipelineCall = /const pipeline\s*=\s*new AssetPipeline\(([\s\S]*?)\);\s*const writeMarker/.exec(serviceSource);
  assert.ok(pipelineCall, 'Expected asset pipeline configuration.');
  const captured = vm.runInNewContext('capture(' + pipelineCall[1] + ')', {
    options, root: result, ...win32, capture: (configuration, dependencies) => ({configuration, dependencies}),
  });
  const pipeline = captured.configuration;
  assert.deepEqual(Object.keys(captured.dependencies), [], 'Production defaults must retain the fixed process query host.');
  assert.equal(policy.within(pipeline.workspaceRoot, pipeline.outputRoot), true, 'Generated asset output must fit the writable pipeline workspace.');
  assert.equal(pipeline.workerRoot, win32.join(resources, 'workers', 'blender'), 'Bundled worker lookup must retain the immutable resource root.');
  const queryHost = Object.freeze({platform: 'fixture-only'});
  const injected = vm.runInNewContext('capture(' + pipelineCall[1] + ')', {
    options: {...options, workerQueryHost: queryHost}, root: result, ...win32,
    capture: (configuration, dependencies) => ({configuration, dependencies}),
  });
  assert.equal(injected.dependencies.queryHost, queryHost, 'Only trusted host composition supplies a process query fixture.');
  assert.equal(injected.configuration.outputRoot, pipeline.outputRoot);
  assert.equal(injected.configuration.workerRoot, pipeline.workerRoot);
});



test('private stop accepts a proven zero exit even if IPC close is delayed',async()=>{
  const child=new EventEmitter();
  Object.assign(child,{exitCode:null,connected:true,send(_message,cb){cb(null)},kill(){assert.fail('No kill after graceful exit')}});
  const fixture=stopFixture(child),pending=fixture.stopOwned();child.exitCode=0;child.emit('exit',0,null);
  assert.equal(await pending,true);
});

test('trusted profile supports only the known MSIX Arcane AppData mapping',()=>{
  const fs=filesystemFixture(),roaming='C:\\Users\\Fixture\\AppData\\Roaming',local='C:\\Users\\Fixture\\AppData\\Local';
  const original=roaming+'\\Arcane',actual=local+'\\Packages\\Vendor.App_123\\LocalCache\\Roaming\\Arcane';
  const ensure=p=>{for(let current=win32.resolve(p);;current=win32.dirname(current)){fs.put(current);if(win32.dirname(current)===current)break;}};
  ensure(roaming);ensure(local);ensure(actual);fs.put(original,{physical:actual,logical:original});
  const checked=windowsPolicy(fs);
  assert.equal(checked.prepareUserDirectory(original,{appData:roaming,localAppData:local}),actual);
  fs.put(original,{physical:'C:\\Other\\Arcane'});ensure('C:\\Other\\Arcane');
  assert.throws(()=>checked.prepareUserDirectory(original,{appData:roaming,localAppData:local}),/Unexpected/);
  fs.put(original,{kind:'link',physical:actual});
  assert.throws(()=>checked.prepareUserDirectory(original,{appData:roaming,localAppData:local}),/Unsafe/);
});
test('trusted profile does not admit unrelated leafs or redirected physical ancestors',()=>{
  const fs=filesystemFixture(),roaming='C:\\Users\\Fixture\\AppData\\Roaming',local='C:\\Users\\Fixture\\AppData\\Local';
  const ensure=p=>{for(let current=win32.resolve(p);;current=win32.dirname(current)){fs.put(current);if(win32.dirname(current)===current)break;}};
  ensure(roaming);ensure(local);ensure(roaming+'\\Arcane');
  const checked=windowsPolicy(fs);
  assert.equal(checked.prepareUserDirectory(roaming+'\\Arcane',{appData:roaming,localAppData:local}),roaming+'\\Arcane');
  assert.throws(()=>checked.prepareUserDirectory(roaming+'\\OtherApp',{appData:roaming,localAppData:local}),/trusted/);
  fs.put(roaming,{kind:'link',physical:'C:\\Other'});
  assert.throws(()=>checked.prepareUserDirectory(roaming+'\\Arcane',{appData:roaming,localAppData:local}),/direct/);
});

test('profile preparation errors are caught before lock and routed to controlled failure',()=>{
  assert.match(mainSource,/catch \{ profilePreparationFailed = true; \}/);
  assert.match(mainSource,/const locked = !profilePreparationFailed && app.requestSingleInstanceLock\(\)/);
  assert.match(mainSource,/if \(profilePreparationFailed\) app.whenReady\(\).then\(\(\) => failStartup/);
});

// ---------------------------------------------------------------- in-app dialogs and persistent project permissions
const hostRequire = (await import('node:module')).createRequire(import.meta.url);
const requireHost = name => hostRequire('../../apps/desktop/electron/' + name);
function dialogFixture({ trusted = () => true } = {}) {
  const handlers = new Map(), sent = [], natives = [];
  const contents = Object.assign(new EventEmitter(), { destroyed: false, isDestroyed() { return this.destroyed; }, send(channel, value) { sent.push({ channel, value }); } });
  const window = { destroyed: false, isDestroyed() { return this.destroyed; }, webContents: contents };
  let ids = 0;
  const host = requireHost('in-app-dialog.cjs').createInAppDialogs({ getWindow: () => window, trusted, timeoutMs: 200,
    randomUUID: () => '00000000-0000-4000-8000-' + String(++ids).padStart(12, '0'),
    native: { async showMessageBox(...args) { natives.push(args); return { response: 0 }; }, async showOpenDialog() { return { canceled: true, filePaths: [] }; } } });
  host.installIpc({ handle(channel, handler) { handlers.set(channel, handler); } });
  const event = { sender: contents };
  const invoke = (channel, ...args) => handlers.get(channel)(event, ...args);
  return { host, handlers, sent, natives, window, contents, event, invoke };
}
const nextTick = () => new Promise(resolve => setImmediate(resolve));

test('in-app dialogs: native until the trusted renderer attaches, then a validated in-app answer', async () => {
  const f = dialogFixture();
  const config = { type: 'question', title: 'Switch project', message: 'Stop this workspace?', detail: 'Line one\n\nLine two', buttons: ['Cancel', 'Open project'], defaultId: 0, cancelId: 0 };
  assert.deepEqual(await f.host.showMessageBox(f.window, config), { response: 0 }); assert.equal(f.natives.length, 1, 'native before attach');
  await f.host.showMessageBox({ type: 'error', message: 'Startup failed' }); assert.equal(f.natives.length, 2, 'no owner: native (startup failure path)');
  assert.deepEqual(await f.invoke('arcane:dialog-attach'), { attached: true });
  const pending = f.host.showMessageBox(f.window, config); await nextTick();
  assert.equal(f.sent.length, 1); const { channel, value } = f.sent[0];
  assert.equal(channel, 'arcane:dialog-request');
  assert.deepEqual({ ...value, buttons: [...value.buttons] }, { version: 1, id: '00000000-0000-4000-8000-000000000001', type: 'question', title: 'Switch project', message: 'Stop this workspace?', detail: 'Line one\n\nLine two', buttons: ['Cancel', 'Open project'], defaultId: 0, cancelId: 0 });
  for (const bad of [[{ id: value.id, response: 2 }], [{ id: value.id, response: -1 }], [{ id: '00000000-0000-4000-8000-000000000009', response: 1 }], [{ id: value.id, response: 1, extra: true }], [{ id: value.id }], []])
    await assert.rejects(f.invoke('arcane:dialog-reply', ...bad), /not accepted/);
  await assert.rejects(f.handlers.get('arcane:dialog-reply')({ sender: {} }, { id: value.id, response: 1 }), /not accepted/, 'another sender cannot answer');
  assert.deepEqual(await f.invoke('arcane:dialog-reply', { id: value.id, response: 1 }), { accepted: true });
  assert.deepEqual(await pending, { response: 1, checkboxChecked: false });
  await assert.rejects(f.invoke('arcane:dialog-reply', { id: value.id, response: 1 }), /not accepted/, 'one answer only');
  assert.equal(f.natives.length, 2, 'no native dialog once attached');
});

test('in-app dialogs: timeout, navigation and untrusted attach all fail safe to cancel or native', async () => {
  const f = dialogFixture();
  await f.invoke('arcane:dialog-attach');
  const timed = await f.host.showMessageBox(f.window, { buttons: ['Cancel', 'Allow', 'Always allow'], cancelId: 0, defaultId: 0 });
  assert.deepEqual(timed, { response: 0, checkboxChecked: false }, 'timeout answers cancel');
  const pending = f.host.showMessageBox(f.window, { buttons: ['Open instructions', 'Cancel'] }); await nextTick();
  assert.equal(f.sent.at(-1).value.cancelId, 1, 'a Cancel label is the cancel button when none is given');
  f.host.detach(f.contents);
  assert.deepEqual(await pending, { response: 1, checkboxChecked: false }, 'navigation cancels the open question');
  await f.host.showMessageBox(f.window, { buttons: ['OK'] }); assert.equal(f.natives.length, 1, 'detached: native again');
  const other = { isDestroyed: () => false, webContents: f.contents };
  await f.invoke('arcane:dialog-attach'); await f.host.showMessageBox(other, { buttons: ['OK'] }); assert.equal(f.natives.length, 2, 'a different owner window never gets an in-app answer');
  const g = dialogFixture({ trusted: () => false });
  await assert.rejects(g.invoke('arcane:dialog-attach'), /unavailable/);
  await g.host.showMessageBox(g.window, { buttons: ['OK'] }); assert.equal(g.natives.length, 1);
  assert.equal(typeof f.host.showOpenDialog, 'function', 'folder pickers stay native');
  const { dialogRequest } = requireHost('in-app-dialog.cjs');
  assert.equal(dialogRequest({ buttons: ['', 'OK'] }, 'id'), null, 'empty button labels are refused');
  const clean = dialogRequest({ type: 'weird', title: 'T‮itle', message: 'a\nb', detail: 'x'.repeat(5000), buttons: ['OK'], defaultId: 7 }, 'id');
  assert.equal(clean.type, 'info'); assert.equal(clean.title, 'T itle'); assert.equal(clean.message, 'a b'); assert.equal(clean.detail.length, 4000); assert.equal(clean.defaultId, 0);
});

test('main routes workflow message boxes through the in-app host and keeps pickers and startup failures native', () => {
  assert.match(mainSource, /dialog: nativeDialog/);
  assert.match(mainSource, /showMessageBox: \(\.\.\.args\) => appDialogs \? appDialogs\.showMessageBox\(\.\.\.args\) : nativeDialog\.showMessageBox\(\.\.\.args\)/);
  assert.match(mainSource, /showOpenDialog: \(\.\.\.args\) => nativeDialog\.showOpenDialog\(\.\.\.args\)/);
  assert.match(mainSource, /createInAppDialogs\(\{ native: nativeDialog, getWindow: \(\) => closing \|\| switching \? null : window, trusted: rendererEvent,\n\s+decisions: trustedDialogs\.showMessageBox \}\)/);
  assert.match(mainSource, /createTrustedDialogs\(\{ BrowserWindow, native: nativeDialog, getWindow: \(\) => closing \|\| switching \? null : window \}\)/);
  assert.match(mainSource, /trustedDialogs\.installIpc\(ipcMain\)/);
  assert.match(mainSource, /appDialogs\?\.dispose\(\); trustedDialogs\?\.dispose\(\);/);
  assert.match(mainSource, /if \(isMainFrame && !inPlace\) appDialogs\?\.detach\(dialogContents\)/);
  assert.match(mainSource, /createClaudeChat\(\{[^\n]*dialog, permissions,/);
});

test('project permissions persist per project, default to auto-approve and accept only exact boolean patches', async () => {
  const { mkdtemp, readFile, writeFile, rm, mkdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'arcane-permissions-')); const a = join(root, 'a'), b = join(root, 'b');
  await mkdir(a); await mkdir(b);
  try {
    let session = { stateRoot: a, epoch: {} };
    const handlers = new Map(), changes = [];
    const make = () => requireHost('project-permissions.cjs').createProjectPermissions({ getSession: () => session });
    const p = make(); p.subscribe((next, previous) => changes.push([previous.claudeTools, next.claudeTools]));
    p.installIpc({ handle(channel, handler) { handlers.set(channel, handler); } }, { trusted: event => event.ok === true });
    assert.deepEqual({ ...await p.read() }, { claudeTools: true, codexAutoApprove: true }, 'auto-approve by default');
    assert.deepEqual({ ...await p.save({ claudeTools: false }) }, { claudeTools: false, codexAutoApprove: true });
    assert.deepEqual(changes, [[true, false]]);
    const saved = JSON.parse(await readFile(join(a, 'agent-permissions.json'), 'utf8'));
    assert.equal(saved.version, 1); assert.equal(saved.claudeTools, false); assert.equal(saved.codexAutoApprove, true);
    assert.deepEqual({ ...await make().read() }, { claudeTools: false, codexAutoApprove: true }, 'survives a restart');
    session = { stateRoot: b, epoch: {} };
    assert.deepEqual({ ...await p.read() }, { claudeTools: true, codexAutoApprove: true }, 'another project keeps its own record');
    for (const bad of [{}, { claudeTools: 'yes' }, { other: true }, [], null, Object.create({ claudeTools: true })]) await assert.rejects(p.save(bad), /unavailable/);
    await assert.rejects(handlers.get('arcane:project-permissions-read')({ ok: false }), /unavailable/, 'untrusted sender');
    assert.deepEqual(await handlers.get('arcane:project-permissions-read')({ ok: true }), { available: true, settings: { claudeTools: true, codexAutoApprove: true } });
    assert.deepEqual(await handlers.get('arcane:project-permissions-save')({ ok: true }, { codexAutoApprove: false }), { saved: true, settings: { claudeTools: true, codexAutoApprove: false } });
    await writeFile(join(a, 'agent-permissions.json'), '{not json');
    session = { stateRoot: a, epoch: {} };
    assert.deepEqual({ ...await make().read() }, { claudeTools: false, codexAutoApprove: false }, 'a damaged record fails closed (never re-enables auto-approval)');
    await writeFile(join(a, 'agent-permissions.json'), JSON.stringify({ version: 2, claudeTools: true, codexAutoApprove: true }));
    assert.deepEqual({ ...await make().read() }, { claudeTools: false, codexAutoApprove: false }, 'an unknown record version fails closed');
    const off = requireHost('project-permissions.cjs').createProjectPermissions({ getSession: () => session, enabled: false });
    await assert.rejects(off.save({ claudeTools: true }), /unavailable/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- trusted decision window
function trustedFixture({ loadFails = false, timeoutMs = 200 } = {}) {
  const handlers = new Map(), windows = [], natives = [];
  class FakeContents extends EventEmitter {
    constructor() { super(); this.destroyed = false; this.mainFrame = { main: true }; this.filter = null;
      this.session = { setPermissionRequestHandler: () => {}, setPermissionCheckHandler: () => {}, setDevicePermissionHandler: () => {},
        webRequest: { onBeforeRequest: (_filter, callback) => { this.filter = callback; } } }; }
    isDestroyed() { return this.destroyed; } setWindowOpenHandler(handler) { this.openHandler = handler; } focus() { this.focused = true; }
  }
  class FakeWindow extends EventEmitter {
    constructor(opts) { super(); this.opts = opts; this.webContents = new FakeContents(); this.destroyed = false; this.shown = false; windows.push(this); }
    isDestroyed() { return this.destroyed; }
    destroy() { if (this.destroyed) return; this.destroyed = true; this.webContents.destroyed = true; this.emit('closed'); }
    loadURL(url) { this.url = url; return loadFails ? Promise.reject(new Error('load failed')) : Promise.resolve(); }
    setMenu() {} setContentSize(width, height) { this.size = [width, height]; } getBounds() { return { x: 0, y: 0, width: 480, height: 240 }; }
    setPosition() {} show() { this.shown = true; } focus() { this.focused = true; }
  }
  const owner = Object.assign(new EventEmitter(), { isDestroyed: () => false, getBounds: () => ({ x: 0, y: 0, width: 1500, height: 900 }), webContents: new FakeContents() });
  let current = owner, ids = 0;
  const host = requireHost('trusted-dialog.cjs').createTrustedDialogs({ BrowserWindow: FakeWindow, getWindow: () => current, timeoutMs,
    randomUUID: () => '00000000-0000-4000-8000-' + String(++ids).padStart(12, '0'),
    native: { async showMessageBox(...args) { natives.push(args); return { response: 0, native: true }; } } });
  host.installIpc({ handle(channel, handler) { handlers.set(channel, handler); } });
  const call = (sender, channel, ...args) => handlers.get(channel)({ sender, senderFrame: sender.mainFrame }, ...args);
  return { host, handlers, windows, natives, owner, call, setOwner: value => { current = value; } };
}
const consent = { type: 'question', title: 'Arcane Claude chat', message: 'Use Claude chat with Arcane project tools?', detail: 'Project: Obby', buttons: ['Cancel', 'Allow', 'Always allow'], defaultId: 0, cancelId: 0 };

test('trusted dialogs: a sandboxed modal child window asks; the workspace renderer cannot read or answer it', async () => {
  const f = trustedFixture();
  const pending = f.host.showMessageBox(f.owner, consent); await nextTick();
  assert.equal(f.windows.length, 1); const w = f.windows[0];
  assert.equal(w.opts.parent, f.owner); assert.equal(w.opts.modal, true); assert.equal(w.opts.frame, false); assert.equal(w.opts.show, false);
  const prefs = w.opts.webPreferences;
  assert.deepEqual([prefs.sandbox, prefs.contextIsolation, prefs.nodeIntegration, prefs.webviewTag, prefs.devTools], [true, true, false, false, false]);
  assert.match(prefs.preload, /trusted-dialog-preload\.cjs$/); assert.match(w.url, /^file:\/\/\/.*trusted-dialog\.html$/);
  const blocked = []; w.webContents.filter({ url: 'https://example.com/' }, out => blocked.push(out.cancel));
  w.webContents.filter({ url: w.url }, out => blocked.push(out.cancel));
  assert.deepEqual(blocked, [true, false], 'only the local dialog page files load');
  const navigation = { prevented: false, preventDefault() { this.prevented = true; } }; w.webContents.emit('will-navigate', navigation);
  assert.equal(navigation.prevented, true); assert.deepEqual(w.webContents.openHandler(), { action: 'deny' });
  // The workspace renderer (the owner's webContents) can neither read the question nor answer it.
  await assert.rejects(f.call(f.owner.webContents, 'arcane:trusted-dialog-open'), /unavailable/);
  await assert.rejects(f.call(f.owner.webContents, 'arcane:trusted-dialog-answer', { id: '00000000-0000-4000-8000-000000000001', response: 2 }), /not accepted/);
  await assert.rejects(f.handlers.get('arcane:trusted-dialog-answer')({ sender: w.webContents, senderFrame: { child: true } }, { id: '00000000-0000-4000-8000-000000000001', response: 2 }), /not accepted/, 'a subframe cannot answer');
  const request = await f.call(w.webContents, 'arcane:trusted-dialog-open');
  assert.deepEqual(request, { version: 1, id: '00000000-0000-4000-8000-000000000001', type: 'question', title: 'Arcane Claude chat', message: 'Use Claude chat with Arcane project tools?', detail: 'Project: Obby', buttons: ['Cancel', 'Allow', 'Always allow'], defaultId: 0, cancelId: 0 });
  assert.deepEqual(await f.call(w.webContents, 'arcane:trusted-dialog-ready', 220), { shown: true });
  assert.equal(w.shown, true); assert.equal(w.focused, true); assert.deepEqual(w.size, [480, 220]);
  await assert.rejects(f.call(w.webContents, 'arcane:trusted-dialog-ready', 220), /unavailable/, 'shown once');
  // Only this window's own request id and an in-range index are accepted, exactly once.
  for (const bad of [[{ id: '00000000-0000-4000-8000-000000000009', response: 1 }], [{ id: request.id, response: 3 }], [{ id: request.id, response: 1, extra: 1 }], [{ id: request.id }], []])
    await assert.rejects(f.call(w.webContents, 'arcane:trusted-dialog-answer', ...bad), /not accepted/);
  assert.deepEqual(await f.call(w.webContents, 'arcane:trusted-dialog-answer', { id: request.id, response: 2 }), { accepted: true });
  assert.deepEqual(await pending, { response: 2, checkboxChecked: false });
  assert.equal(w.destroyed, true, 'the window closes after the answer');
  await assert.rejects(f.call(w.webContents, 'arcane:trusted-dialog-answer', { id: request.id, response: 1 }), /not accepted/, 'one answer only');
  assert.equal(f.natives.length, 0);
});

test('trusted dialogs: timeout, closing the window, owner close and dispose all answer cancel; no owner or a failed page asks natively', async () => {
  const f = trustedFixture({ timeoutMs: 50 });
  assert.deepEqual(await f.host.showMessageBox(f.owner, consent), { response: 0, checkboxChecked: false }, 'timeout = cancel');
  assert.equal(f.windows[0].destroyed, true);
  const closed = f.host.showMessageBox(f.owner, { ...consent, cancelId: 1, defaultId: 1 }); await nextTick();
  f.windows[1].destroy(); assert.deepEqual(await closed, { response: 1, checkboxChecked: false }, 'closing the window (Alt+F4) = cancel');
  const ownerGone = f.host.showMessageBox(f.owner, consent); await nextTick();
  f.owner.emit('closed'); assert.deepEqual(await ownerGone, { response: 0, checkboxChecked: false }, 'owner closed = cancel');
  const crashed = f.host.showMessageBox(f.owner, consent); await nextTick();
  f.windows[3].webContents.emit('render-process-gone'); assert.deepEqual(await crashed, { response: 0, checkboxChecked: false }, 'crash = cancel');
  const queuedA = f.host.showMessageBox(f.owner, consent), queuedB = f.host.showMessageBox(f.owner, consent); await nextTick();
  assert.equal(f.windows.length, 5, 'one decision window at a time');
  f.host.dispose();
  assert.deepEqual(await queuedA, { response: 0, checkboxChecked: false }); assert.deepEqual(await queuedB, { response: 0, checkboxChecked: false });
  assert.equal(f.natives.length, 0);
  const g = trustedFixture({ loadFails: true });
  assert.deepEqual(await g.host.showMessageBox(g.owner, consent), { response: 0, native: true }, 'page failure: native question, never a silent grant');
  await g.host.showMessageBox(consent); assert.equal(g.natives.length, 2, 'no owner: native');
  g.setOwner(null); await g.host.showMessageBox(g.owner, consent); assert.equal(g.natives.length, 3, 'closing/switching: native');
  const { isDecisionDialog } = requireHost('trusted-dialog.cjs');
  assert.equal(isDecisionDialog(consent), true); assert.equal(isDecisionDialog({ buttons: ['OK'] }), false); assert.equal(isDecisionDialog({}), false);
});

test('trusted dialogs: a standalone startup question opens the trusted page as its own taskbar window and answers once', async () => {
  const f = trustedFixture(); f.setOwner(null);
  const question = { type: 'warning', title: 'Arcane is already open', message: 'Arcane is already open for this project in another window.', buttons: ['Quit', 'Try again'], defaultId: 1, cancelId: 0 };
  const pending = f.host.showStandalone(question); await nextTick();
  assert.equal(f.windows.length, 1); const w = f.windows[0];
  assert.equal(w.opts.parent, undefined); assert.equal(w.opts.modal, undefined); assert.equal(w.opts.skipTaskbar, false); assert.equal(w.opts.center, true);
  assert.deepEqual([w.opts.webPreferences.sandbox, w.opts.webPreferences.contextIsolation, w.opts.webPreferences.nodeIntegration], [true, true, false]);
  const request = await f.call(w.webContents, 'arcane:trusted-dialog-open');
  assert.deepEqual([request.title, [...request.buttons], request.defaultId, request.cancelId], ['Arcane is already open', ['Quit', 'Try again'], 1, 0]);
  assert.deepEqual(await f.call(w.webContents, 'arcane:trusted-dialog-ready', 200), { shown: true }); assert.equal(w.shown, true);
  assert.deepEqual(await f.call(w.webContents, 'arcane:trusted-dialog-answer', { id: request.id, response: 1 }), { accepted: true });
  assert.deepEqual(await pending, { response: 1, checkboxChecked: false }); assert.equal(f.natives.length, 0);
  const closed = f.host.showStandalone(question); await nextTick(); f.windows[1].destroy();
  assert.deepEqual(await closed, { response: 0, checkboxChecked: false }, 'closing the window = Quit (cancel)');
  const g = trustedFixture({ loadFails: true }); g.setOwner(null);
  assert.deepEqual(await g.host.showStandalone(question), { response: 0, native: true }, 'page failure: native question');
  g.host.dispose(); await g.host.showStandalone(question); assert.equal(g.natives.length, 2, 'after dispose: native');
});

// ------------------------------------------------------------- another Arcane already open for the same project
function projectInUseFixture({ answers = [], failures = 1, error = null, smoke = false } = {}) {
  const begin = mainSource.indexOf('async function startProjectRuntime('), end = mainSource.indexOf('async function runtimeStopped(');
  assert.ok(begin > 0 && end > begin);
  const calls = [], inUse = () => Object.assign(new Error('Arcane is already open for this project in another window. Switch to it, or close it and try again.'), { code: 'ARCANE_PROJECT_IN_USE' });
  let starts = 0;
  const context = vm.createContext({ smoke, closing: false, appDialogs: { dispose: () => calls.push(['appDialogs.dispose']) }, providerSetup: { dispose() {} },
    stopClaudeChat: () => Promise.resolve(),
    startDaemon: async project => { calls.push(['startDaemon', project]); if (error) throw error; if (starts++ < failures) throw inUse(); },
    stopDaemon: async () => { calls.push(['stopDaemon']); return true; },
    trustedDialogs: { showStandalone: async config => { calls.push(['ask', config]); return { response: answers.shift() ?? 0 }; }, dispose: () => calls.push(['trustedDialogs.dispose']) },
    nativeDialog: { showMessageBox: async () => assert.fail('The in-use question uses the trusted Arcane window, not a native box.') },
    app: { exit: code => calls.push(['exit', code]) }, exitAfterDiagnostics: async code => calls.push(['exit', code]) });
  vm.runInContext(mainSource.slice(begin, end) + '\nglobalThis.run = startProjectRuntime;', context);
  return { calls, context, run: project => context.run(project) };
}

test('another open Arcane: the trusted question offers Try again (rechecks) and Quit, never a native box or takeover', async () => {
  const f = projectInUseFixture({ answers: [1, 1], failures: 2 });
  assert.equal(await f.run('C:\\Project'), true);
  assert.deepEqual(f.calls.filter(row => row[0] === 'startDaemon').length, 3, 'each Try again rechecks from the start');
  const ask = f.calls.find(row => row[0] === 'ask')[1];
  assert.deepEqual([ask.title, ask.message, [...ask.buttons], ask.defaultId, ask.cancelId], ['Arcane is already open', 'Arcane is already open for this project in another window.', ['Quit', 'Try again'], 1, 0]);
  assert.match(ask.detail, /Switch to it, or close it and try again/); assert.match(ask.detail, /never closes the other window or takes over its project/);
  assert.equal(f.calls.some(row => row[0] === 'exit'), false);
  const quit = projectInUseFixture({ answers: [0] });
  assert.equal(await quit.run('C:\\Project'), false);
  assert.deepEqual(quit.calls.map(row => row[0]), ['startDaemon', 'stopDaemon', 'ask', 'appDialogs.dispose', 'trustedDialogs.dispose', 'stopDaemon', 'exit']);
  assert.deepEqual(quit.calls.at(-1), ['exit', 0], 'Quit is a clean exit, not a startup failure');
});

test('other startup failures and smoke runs keep their existing failure path without the in-use question', async () => {
  const generic = Object.assign(new Error('The local runtime could not start.'), { code: 'ARCANE_STARTUP' });
  const f = projectInUseFixture({ error: generic });
  await assert.rejects(f.run('C:\\Project'), error => error === generic); assert.equal(f.calls.some(row => row[0] === 'ask'), false);
  const s = projectInUseFixture({ smoke: true });
  await assert.rejects(s.run('C:\\Project'), { code: 'ARCANE_PROJECT_IN_USE' }); assert.equal(s.calls.some(row => row[0] === 'ask'), false);
});

test('single-instance focus stays first; startup and project switch both use the in-use question; the lock is never taken', () => {
  assert.match(mainSource, /const locked = !profilePreparationFailed && app\.requestSingleInstanceLock\(\)/);
  assert.match(mainSource, /else if \(!locked\) app\.quit\(\);/);
  assert.match(mainSource, /app\.on\('second-instance', \(\) => \{ if \(window\) \{ if \(window\.isMinimized\(\)\) window\.restore\(\); window\.show\(\); window\.focus\(\); \} \}\)/);
  assert.match(mainSource, /if \(!await startProjectRuntime\(selected\)\) return;/);
  assert.match(mainSource, /if \(!await startProjectRuntime\(path\)\) return;/);
  assert.match(mainSource, /if \(await policy\.liveRuntimeOwner\(stateRoot\)\) throw startupFailure\('PROJECT_IN_USE'\);/);
  const realPolicy = requireHost('policy.cjs');
  assert.equal(realPolicy.STARTUP_FAILURE_CODES.includes('PROJECT_IN_USE'), true);
  assert.equal(realPolicy.startupFailureMessage({ type: 'arcane-startup-failure', protocolVersion: 1, code: 'PROJECT_IN_USE' }), 'PROJECT_IN_USE');
  const start = mainSource.slice(mainSource.indexOf('async function startProjectRuntime('), mainSource.indexOf('async function runtimeStopped('));
  assert.doesNotMatch(start, /\.kill\(|unlink|studio\.lock|daemon\.json/);
});

test('in-app host delegates every decision to the trusted window; the renderer only ever receives one-button notices', async () => {
  const f = dialogFixture(); const decided = [];
  const host = requireHost('in-app-dialog.cjs').createInAppDialogs({ getWindow: () => f.window, trusted: () => true, timeoutMs: 200,
    native: { async showMessageBox() { throw new Error('unexpected native'); } }, decisions: async (...args) => { decided.push(args); return { response: 1 }; } });
  const handlers = new Map(); host.installIpc({ handle(channel, handler) { handlers.set(channel, handler); } });
  const sent = []; f.contents.send = (channel, value) => sent.push(value);
  await handlers.get('arcane:dialog-attach')({ sender: f.contents });
  assert.deepEqual(await host.showMessageBox(f.window, consent), { response: 1 });
  assert.deepEqual(await host.showMessageBox({ ...consent, buttons: ['Cancel', 'Open project'] }), { response: 1 });
  assert.equal(sent.length, 0, 'no decision reaches the workspace renderer');
  assert.deepEqual(decided.map(args => args.length), [2, 1]);
  const notice = host.showMessageBox(f.window, { type: 'info', title: 'Arcane', message: 'About', buttons: ['OK'] }); await nextTick();
  assert.equal(sent.length, 1); assert.deepEqual([...sent[0].buttons], ['OK']);
  await handlers.get('arcane:dialog-reply')({ sender: f.contents }, { id: sent[0].id, response: 0 }); assert.deepEqual(await notice, { response: 0, checkboxChecked: false });
});

test('trusted dialog preload exposes only request/ready/answer, keeps the request id and answers once', async () => {
  let exposed; const invoked = [];
  const answers = { 'arcane:trusted-dialog-open': { version: 1, id: '00000000-0000-4000-8000-000000000001', type: 'question', title: 'Switch project', message: 'Stop?', detail: '', buttons: ['Cancel', 'Open project'], defaultId: 0, cancelId: 0 },
    'arcane:trusted-dialog-ready': { shown: true }, 'arcane:trusted-dialog-answer': { accepted: true } };
  vm.runInNewContext(source('apps/desktop/electron/trusted-dialog-preload.cjs'), { require(name) { assert.equal(name, 'electron');
    return { contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'arcaneTrustedDialog'); exposed = value; } },
      ipcRenderer: { invoke: async (channel, ...args) => { invoked.push([channel, ...args]); return answers[channel]; } } }; } });
  assert.equal(Object.isFrozen(exposed), true); assert.deepEqual(Object.keys(exposed).sort(), ['answer', 'ready', 'request', 'version']);
  await assert.rejects(exposed.answer(1), /unavailable/, 'no answer before the request is read');
  const request = await exposed.request();
  assert.equal('id' in request, false, 'the page never sees the request id');
  await assert.rejects(exposed.request(), /unavailable/, 'one request per window');
  await exposed.ready(180);
  await assert.rejects(exposed.answer(2), /unavailable/, 'out of range');
  assert.equal((await exposed.answer(1)).accepted, true);
  await assert.rejects(exposed.answer(0), /unavailable/, 'answers once');
  assert.deepEqual(JSON.parse(JSON.stringify(invoked)), [['arcane:trusted-dialog-open'], ['arcane:trusted-dialog-ready', 180], ['arcane:trusted-dialog-answer', { id: '00000000-0000-4000-8000-000000000001', response: 1 }]]);
  const page = source('apps/desktop/electron/trusted-dialog.html'), script = source('apps/desktop/electron/trusted-dialog.js');
  assert.match(page, /Content-Security-Policy" content="default-src 'none'; script-src file:; style-src file:/);
  assert.doesNotMatch(script, /innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function/);
  assert.doesNotMatch(preloadSource, /trusted-dialog/, 'the workspace preload has no way to reach the trusted dialog channels');
});

test('turning a permission ON from the renderer needs the trusted confirmation; OFF does not', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'arcane-permissions-confirm-'));
  try {
    const session = { stateRoot: root, epoch: {} }, handlers = new Map(), asked = []; let allow = false;
    const p = requireHost('project-permissions.cjs').createProjectPermissions({ getSession: () => session });
    p.installIpc({ handle(channel, handler) { handlers.set(channel, handler); } }, { trusted: () => true, confirmEnable: async keys => { asked.push(keys); return allow; } });
    const save = patch => handlers.get('arcane:project-permissions-save')({}, patch);
    assert.deepEqual(await save({ claudeTools: false, codexAutoApprove: false }), { saved: true, settings: { claudeTools: false, codexAutoApprove: false } });
    assert.deepEqual(asked, [], 'turning off asks nothing');
    assert.deepEqual(await save({ claudeTools: true }), { saved: false, settings: { claudeTools: false, codexAutoApprove: false } }, 'declined: nothing changes');
    allow = true;
    assert.deepEqual(await save({ claudeTools: true, codexAutoApprove: true }), { saved: true, settings: { claudeTools: true, codexAutoApprove: true } });
    assert.deepEqual(asked, [['claudeTools'], ['claudeTools', 'codexAutoApprove']]);
    assert.deepEqual(await save({ claudeTools: true }), { saved: true, settings: { claudeTools: true, codexAutoApprove: true } }); assert.equal(asked.length, 2, 'already on: no question');
  } finally { await rm(root, { recursive: true, force: true }); }
  assert.match(mainSource, /projectPermissions\.installIpc\(ipcMain, \{ trusted: rendererEvent, confirmEnable: async keys => \{/);
  assert.match(preloadSource, /return \{ saved: out\.saved, settings: permissionSettings\(out\.settings\) \};/);
});


// ---------------------------------------------------------------- checkout bridge and build-done notifications
test('main wires the checkout bridge and build notifications through the trusted renderer check', () => {
  assert.match(mainSource, /require\('\.\/billing\.cjs'\)\.createBilling\(\{ enabled: !smoke, dialog, shell,/);
  assert.match(mainSource, /dist\/packages\/protocol\/src\/plans\.js/);
  assert.match(mainSource, /require\('\.\/build-notifications\.cjs'\)\.createBuildNotifications\(\{ enabled: !smoke, Notification,/);
  assert.ok((mainSource.match(/\.installIpc\(ipcMain, \{ trusted: rendererEvent[ ,]/g) ?? []).length >= 4);
});

test('checkout bridge: unconfigured never opens; configured opens only an allowlisted https URL after an in-app confirm', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'arcane-billing-'));
  try {
    const opened = [], asked = [], handlers = new Map();
    let answer = 1;
    const window = { isDestroyed: () => false };
    const plans = { plans: [{ id: 'pro', name: 'Pro' }], packs: [{ id: 'pack-100', name: 'Top-up' }], credits: { offers: [{ id: 'credits-10', name: '$10 of credits' }] },
      billing: { serviceUrl: '', allowedOrigins: ['https://billing.arcane.test'] } };
    const make = (overrides = {}) => requireHost('billing.cjs').createBilling({ loadPlans: async () => plans, configDirectory: () => root, getWindow: () => window,
      dialog: { showMessageBox: async (owner, options) => { assert.equal(owner, window); asked.push(options); return { response: answer }; } },
      shell: { openExternal: async url => { opened.push(url); } }, ...overrides });
    const billing = make();
    billing.installIpc({ handle(channel, handler) { handlers.set(channel, handler); } }, { trusted: event => event.ok === true });
    assert.deepEqual({ ...await billing.status() }, { version: 1, state: 'not-connected', message: "Checkout isn't connected yet", account: 'unavailable' });
    assert.deepEqual({ ...await billing.openCheckout('pro') }, { version: 1, state: 'not-connected', message: "Checkout isn't connected yet" });
    assert.deepEqual(opened, []); assert.deepEqual(asked, [], 'no question while unconfigured');
    // A local file may name a service only on an origin the shipped config allowlists.
    for (const serviceUrl of ['http://billing.arcane.test', 'https://evil.test', 'https://user@billing.arcane.test', 'https://billing.arcane.test:8443', 'https://127.0.0.1']) {
      await writeFile(join(root, 'billing-service.json'), JSON.stringify({ version: 1, serviceUrl }));
      assert.equal((await billing.openCheckout('pro')).state, 'not-connected', serviceUrl);
    }
    assert.deepEqual(opened, []);
    await writeFile(join(root, 'billing-service.json'), JSON.stringify({ version: 1, serviceUrl: 'https://billing.arcane.test/' }));
    assert.equal((await billing.status()).state, 'ready');
    assert.equal((await billing.openCheckout('nope')).state, 'unknown-offer');
    assert.equal((await billing.openCheckout('../x')).state, 'unknown-offer');
    answer = 0;
    assert.equal((await billing.openCheckout('pro')).state, 'cancelled'); assert.deepEqual(opened, []);
    assert.equal(asked.at(-1).buttons[asked.at(-1).cancelId], 'Cancel'); assert.equal(asked.at(-1).defaultId, 0);
    answer = 1;
    assert.deepEqual({ ...await billing.openCheckout('pack-100') }, { version: 1, state: 'opened', message: 'Checkout opened in your browser' });
    assert.deepEqual(opened, ['https://billing.arcane.test/checkout?kind=pack&offer=pack-100']);
    assert.match(asked.at(-1).message, /Top-up/);
    // IPC: trusted sender and exactly one string.
    await assert.rejects(handlers.get('arcane:billing-checkout')({ ok: false }, 'pro'), /unavailable/);
    await assert.rejects(handlers.get('arcane:billing-checkout')({ ok: true }, { id: 'pro' }), /unavailable/);
    await assert.rejects(handlers.get('arcane:billing-checkout')({ ok: true }, 'pro', 'extra'), /unavailable/);
    assert.equal((await handlers.get('arcane:billing-checkout')({ ok: true }, 'credits-10')).state, 'opened');
    assert.equal(opened.at(-1), 'https://billing.arcane.test/checkout?kind=credits&offer=credits-10');
    // Disabled (smoke) and a failing browser stay fixed and quiet.
    assert.equal((await make({ enabled: false }).openCheckout('pro')).state, 'not-connected');
    assert.equal((await make({ shell: { openExternal: async () => { throw new Error('C:\\secret path'); } } }).openCheckout('pro')).message, 'Checkout is unavailable right now. Nothing was charged.');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('connect Arcane account: disabled by default; device sign-in on the allowlisted gateway stores the token only encrypted', async () => {
  const { mkdtemp, writeFile, readFile, rm, access } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'arcane-account-'));
  try {
    const TOKEN = 'arc_' + 'T'.repeat(43);
    const opened = [], asked = [], calls = [], handlers = new Map();
    let answer = 1, verification = 'https://gw.arcane.test/v1/auth/verify?user_code=BCDF-GHJK', polls = 0;
    const window = { isDestroyed: () => false };
    const plans = { plans: [], packs: [], credits: { offers: [] }, billing: { serviceUrl: '', allowedOrigins: [] },
      gateway: { url: '', allowedOrigins: ['https://gw.arcane.test', 'https://gw2.arcane.test'] } };
    const safeStorage = { isEncryptionAvailable: () => true,
      encryptString: plain => Buffer.from('enc:' + Buffer.from(plain).toString('base64')), decryptString: buffer => Buffer.from(String(buffer).slice(4), 'base64').toString() };
    const fetch = async (url, init) => {
      calls.push({ url, auth: init.headers.Authorization ?? null, redirect: init.redirect });
      const path = new URL(url).pathname;
      const body = path === '/v1/auth/device' ? { deviceCode: 'D'.repeat(43), userCode: 'BCDF-GHJK', verificationUrl: 'https://gw.arcane.test/v1/auth/verify', verificationUrlComplete: verification, interval: 5, expiresIn: 600 }
        : path === '/v1/auth/token' ? (++polls < 2 ? { error: 'authorization_pending' } : { token: TOKEN, tokenType: 'Bearer' }) : { signedOut: true };
      return new Response(JSON.stringify(body), { status: path === '/v1/auth/token' && !body.token ? 400 : 200 });
    };
    const make = (overrides = {}) => requireHost('billing.cjs').createBilling({ loadPlans: async () => plans, configDirectory: () => root, getWindow: () => window,
      dialog: { showMessageBox: async (owner, options) => { asked.push(options); return { response: answer }; } }, shell: { openExternal: async url => { opened.push(url); } },
      safeStorage, fetch, sleep: async () => {}, ...overrides });
    const settle = async billing => { for (let i = 0; i < 200 && (await billing.status()).account === 'signing-in'; i++) await new Promise(resolve => setImmediate(resolve)); };

    // Default: no gateway URL, so the account stays unavailable and nothing is requested.
    let billing = make();
    assert.equal((await billing.status()).account, 'unavailable');
    assert.equal((await billing.connectAccount()).state, 'not-connected');
    assert.equal((await make({ safeStorage: undefined }).status()).account, 'unavailable');
    assert.equal((await make({ enabled: false }).connectAccount()).state, 'not-connected');
    for (const gatewayUrl of ['https://evil.test', 'http://gw.arcane.test', 'https://gw.arcane.test:8443']) {
      await writeFile(join(root, 'billing-service.json'), JSON.stringify({ version: 1, gatewayUrl }));
      assert.equal((await billing.connectAccount()).state, 'not-connected', gatewayUrl);
    }
    assert.deepEqual(calls, []); assert.deepEqual(asked, []);

    await writeFile(join(root, 'billing-service.json'), JSON.stringify({ version: 1, gatewayUrl: 'https://gw.arcane.test' }));
    assert.equal((await make({ safeStorage: { ...safeStorage, isEncryptionAvailable: () => false } }).connectAccount()).state, 'unavailable');
    assert.equal((await billing.status()).account, 'signed-out');
    // An off-origin sign-in page is never opened.
    verification = 'https://evil.test/v1/auth/verify';
    assert.equal((await billing.connectAccount()).state, 'unavailable'); assert.deepEqual(opened, []);
    verification = 'https://gw.arcane.test/v1/auth/verify?user_code=BCDF-GHJK';
    answer = 0;
    assert.equal((await billing.connectAccount()).state, 'cancelled'); assert.deepEqual(opened, []);
    assert.match(asked.at(-1).message, /BCDF-GHJK/); assert.equal(asked.at(-1).defaultId, 0);
    answer = 1;
    assert.deepEqual({ ...await billing.connectAccount() }, { version: 1, state: 'opened', message: 'Finish signing in in your browser' });
    assert.deepEqual(opened, [verification]);
    await settle(billing);
    assert.equal((await billing.status()).account, 'signed-in');
    assert.ok(calls.every(call => call.redirect === 'error' && call.url.startsWith('https://gw.arcane.test/')));
    const stored = await readFile(join(root, 'arcane-account.bin'), 'utf8');
    assert.ok(!stored.includes(TOKEN), 'token never stored in plain text');
    assert.deepEqual({ ...await billing.accountCredential() }, { base: 'https://gw.arcane.test', token: TOKEN });
    assert.equal((await billing.connectAccount()).state, 'signed-in');

    // The token is bound to its gateway origin.
    await writeFile(join(root, 'billing-service.json'), JSON.stringify({ version: 1, gatewayUrl: 'https://gw2.arcane.test' }));
    assert.equal((await billing.status()).account, 'signed-out'); assert.equal(await billing.accountCredential(), null);
    await writeFile(join(root, 'billing-service.json'), JSON.stringify({ version: 1, gatewayUrl: 'https://gw.arcane.test' }));

    // IPC: trusted sender and no arguments; replies never carry the token.
    billing.installIpc({ handle(channel, handler) { handlers.set(channel, handler); } }, { trusted: event => event.ok === true });
    await assert.rejects(handlers.get('arcane:billing-account-connect')({ ok: false }), /unavailable/);
    await assert.rejects(handlers.get('arcane:billing-account-disconnect')({ ok: true }, 'x'), /unavailable/);
    assert.ok(!JSON.stringify(await handlers.get('arcane:billing-status')({ ok: true })).includes(TOKEN));
    assert.deepEqual({ ...await handlers.get('arcane:billing-account-disconnect')({ ok: true }) }, { version: 1, state: 'signed-out', message: 'Your Arcane account is disconnected.' });
    await assert.rejects(access(join(root, 'arcane-account.bin')));
    assert.equal(calls.at(-1).url, 'https://gw.arcane.test/v1/auth/logout'); assert.equal(calls.at(-1).auth, 'Bearer ' + TOKEN);
    assert.equal((await billing.status()).account, 'signed-out');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('build notifications: fixed titles, bounded body, only when unfocused; click focuses and returns the target', async () => {
  const shown = [], sent = [], handlers = new Map();
  let focused = false, clock = 0;
  class FakeNotification extends EventEmitter {
    static isSupported() { return true; }
    constructor(options) { super(); this.options = options; }
    show() { shown.push(this); }
  }
  const window = { isDestroyed: () => false, isFocused: () => focused, isMinimized: () => true, restored: 0, focused: 0,
    restore() { this.restored++; }, show() {}, focus() { this.focused++; }, webContents: { isDestroyed: () => false, send: (channel, value) => sent.push({ channel, value }) } };
  const host = requireHost('build-notifications.cjs').createBuildNotifications({ Notification: FakeNotification, getWindow: () => window, now: () => clock });
  host.installIpc({ handle(channel, handler) { handlers.set(channel, handler); } }, { trusted: event => event.ok === true });
  const show = handlers.get('arcane:notification-show');
  assert.deepEqual(await show({ ok: true }, { kind: 'finished', body: 'Claude finished in “Castle”.', target: 'n1-abc' }), { shown: true });
  assert.equal(shown[0].options.title, 'Arcane — Build finished'); assert.equal(shown[0].options.body, 'Claude finished in “Castle”.');
  clock += 5000;
  assert.deepEqual(await show({ ok: true }, { kind: 'attention', body: 'x'.repeat(300) + '\u202e', target: 'n2-abc' }), { shown: true });
  assert.equal(shown[1].options.title, 'Arcane — Needs your attention'); assert.ok(shown[1].options.body.length <= 120);
  assert.doesNotMatch(shown[1].options.body, /\u202e/);
  clock += 100;
  assert.deepEqual(await show({ ok: true }, { kind: 'finished', body: 'again', target: 'n3' }), { shown: false }, 'cooldown');
  clock += 5000; focused = true;
  assert.deepEqual(await show({ ok: true }, { kind: 'finished', body: 'focused', target: 'n4' }), { shown: false }, 'focused window');
  for (const bad of [{ kind: 'other', body: '', target: 'n5' }, { kind: 'finished', body: '', target: 'bad target' }, { kind: 'finished', body: '', target: 'n6', title: 'x' }, null, 'finished'])
    await assert.rejects(show({ ok: true }, bad), /unavailable/);
  await assert.rejects(show({ ok: false }, { kind: 'finished', body: '', target: 'n7' }), /unavailable/);
  shown[0].emit('click');
  assert.equal(window.restored, 1); assert.equal(window.focused, 1);
  assert.deepEqual(sent, [{ channel: 'arcane:notification-activate', value: { target: 'n1-abc' } }]);
  const off = requireHost('build-notifications.cjs').createBuildNotifications({ Notification: FakeNotification, getWindow: () => window, enabled: false });
  focused = false; assert.deepEqual(off.notify({ kind: 'finished', title: 'Arcane — Build finished', body: '', target: 'n8' }), { shown: false });
});

// ---------------------------------------------------------------- Keep this mesh (trusted dialog + IPC consent)
test('main wires Keep this mesh through the trusted decision dialog and the private child IPC channel', () => {
  assert.match(mainSource, /require\('\.\/mesh-keep\.cjs'\)\.createMeshKeepHost\(\{ enabled: !smoke,/);
  assert.match(mainSource, /send: message => \{ if \(!child \|\| !child\.connected\) throw new Error\('Runtime unavailable\.'\); child\.send\(message\); \}/);
  assert.match(mainSource, /buttons: \['Cancel', request\.confirmLabel\], defaultId: 0, cancelId: 0, noLink: true \}\);\n\s+return choice\.response === 1 && !closing && !switching && window === owner;\n\s+\} \}\)\.installIpc\(ipcMain, \{ trusted: rendererEvent \}\);/);
  assert.match(productSource, /app\.meshKeep\?\.acceptConsent\(message\)/);
  assert.match(labSource, /if\(meshKeep&&await meshKeep\.handle\(request,response,url,token,origin\)\)return;/);
});

test('Keep this mesh host: exact request, trusted confirmation naming account/name/quota, consent only over IPC, never on cancel', async () => {
  const { createMeshKeepHost, meshKeepRequest } = requireHost('mesh-keep.cjs');
  const digest = 'ab'.repeat(32), window = {};
  assert.equal(meshKeepRequest({ digest, sessionId: 's-1' }).digest, digest);
  for (const bad of [null, { digest }, { digest: 'x', sessionId: 's' }, { digest, sessionId: 'a b' }, { digest, sessionId: 's', extra: 1 }, Object.create({ digest, sessionId: 's' })]) assert.equal(meshKeepRequest(bad), null);
  const run = async ({ answer = true, prepare = { prepareId: '11111111-2222-4333-8444-555555555555', account: { kind: 'user', userId: 42 }, name: 'Oak\u202e tree', meshCount: 3, placeName: 'My place', expiresAt: 'x' }, startOk = true, session } = {}) => {
    const calls = [], sent = [], questions = [];
    const current = session === undefined ? { window, origin, token, send: message => sent.push(message) } : session;
    const host = createMeshKeepHost({ getSession: () => current, randomBytes: () => Buffer.alloc(32, 7),
      confirm: async question => { questions.push(question); return answer; },
      fetch: async (url, init) => { calls.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
        return url.endsWith('/prepare') ? { ok: true, json: async () => prepare } : { ok: startOk, json: async () => (startOk ? { receipt: {} } : { message: 'Roblox said no' }) }; } });
    return { result: await host.keep({ digest, sessionId: 's-1' }), calls, sent, questions };
  };
  const ok = await run();
  assert.deepEqual(ok.result, { state: 'started', message: 'Uploading to your Roblox account…' });
  assert.deepEqual(ok.calls.map(c => c.url), [origin + '/v1/mesh-keep/prepare', origin + '/v1/mesh-keep/start']);
  assert.ok(ok.calls.every(c => c.auth === 'Bearer ' + token));
  const consent = Buffer.alloc(32, 7).toString('hex');
  assert.deepEqual(ok.sent, [{ type: 'arcane-mesh-keep-consent', protocolVersion: 1, prepareId: '11111111-2222-4333-8444-555555555555', consent }]);
  assert.deepEqual(ok.calls[1].body, { prepareId: '11111111-2222-4333-8444-555555555555', consent });
  const q = ok.questions[0];
  assert.equal(q.confirmLabel, 'Upload and keep');
  assert.match(q.detail, /Roblox user ID 42/); assert.match(q.detail, /Asset name: Oak tree/); assert.match(q.detail, /upload quota/); assert.match(q.detail, /3 mesh assets/);
  assert.doesNotMatch(q.message + q.detail, /\u202e/, 'bidi controls never reach the dialog');
  const cancelled = await run({ answer: false });
  assert.equal(cancelled.result.state, 'cancelled'); assert.deepEqual(cancelled.sent, []); assert.equal(cancelled.calls.length, 1, 'cancel never starts');
  const bad = await run({ prepare: { prepareId: 'nope' } });
  assert.equal(bad.result.state, 'refused'); assert.equal(bad.questions.length, 0); assert.deepEqual(bad.sent, []);
  const refused = await run({ startOk: false });
  assert.deepEqual(refused.result, { state: 'refused', message: 'Roblox said no' });
  const none = await run({ session: null });
  assert.equal(none.result.state, 'unavailable'); assert.equal(none.calls.length, 0);
  const off = createMeshKeepHost({ enabled: false, getSession: () => ({ window, origin, token, send() {} }), confirm: async () => true, fetch: async () => assert.fail('disabled host must not call the daemon') });
  assert.equal((await off.keep({ digest, sessionId: 's-1' })).state, 'unavailable');
  const handlers = new Map();
  createMeshKeepHost({ getSession: () => null, confirm: async () => true }).installIpc({ handle: (name, fn) => handlers.set(name, fn) }, { trusted: () => false });
  await assert.rejects(handlers.get('arcane:mesh-keep')({}, { digest, sessionId: 's-1' }), /unavailable/);
});


test('Keep this mesh preserves uncertainty when a delivered start has no readable refusal', async () => {
  const { createMeshKeepHost } = requireHost('mesh-keep.cjs');
  for (const unreadable of [false, true]) {
    const sent = [], calls = [];
    const session = { window: {}, origin, token, send: message => sent.push(message) };
    const host = createMeshKeepHost({ getSession: () => session, confirm: async () => true,
      fetch: async url => {
        calls.push(url);
        if (url.endsWith('/prepare')) return { ok: true, json: async () => ({ prepareId: '11111111-2222-4333-8444-555555555555', account: { kind: 'user', userId: 42 }, name: 'Oak', meshCount: 1, placeName: 'Game' }) };
        return { ok: false, json: async () => { if (unreadable) throw Error('response lost'); return {}; } };
      } });
    const result = await host.keep({ digest: 'ab'.repeat(32), sessionId: 's-1' });
    assert.equal(sent.length, 1); assert.equal(calls.length, 2, 'The start was delivered once; nothing is retried.');
    assert.equal(result.state, 'refused');
    assert.match(result.message, /Review the mesh card/);
    assert.doesNotMatch(result.message, /Nothing was uploaded/);
  }
});
