import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { win32 } from 'node:path';
import { EventEmitter } from 'node:events';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

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
    process:{env:{ARCANE_PROJECT:projectPath},pid:17,exit(code){exitCode=code;}},
    join:win32.join, resolve:win32.resolve,
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
      return created('lab',{origin,async close(){closed('lab',this);}});
    },
  };
  const cleanupBegin = productSource.indexOf('async function cleanupStartup('), cleanupEnd = productSource.indexOf('// The desktop host',cleanupBegin);
  const begin = productSource.indexOf('const store = new StudioStore('), end = productSource.indexOf('const descriptor =',begin);
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

test('product import wiring shares exact stores, awaited artifact, host hooks and ledger persistence', async () => {
  const f=productServiceFixture(); await f.initialize();
  const resources=f.events.filter(value => value.operation === 'create').map(value => value.resource);
  assert.ok(resources.indexOf('host') > resources.indexOf('preparations'));
  assert.ok(resources.indexOf('host') > resources.indexOf('artifact')); assert.ok(resources.indexOf('assets') > resources.indexOf('host'));
  const args=[Object.freeze({fixture:'actor'}),'synthetic-job',Object.freeze({fixture:'plan'}),Object.freeze({fixture:'witness'}),()=>assert.fail('Forward the guard without invoking it.')];
  await f.hostConfiguration.persistPreparation(...args);
  assert.equal(f.savedArgs.length,args.length); for(let i=0;i<args.length;i++) assert.equal(f.savedArgs[i],args[i]);
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
  assert.deepEqual(Object.keys(exposed).sort(), ['codeVerification', 'platform', 'providerSetup', 'runtime', 'studioKeys', 'version', 'workspacePreferences']);
  assert.equal(exposed.runtime, 'desktop');
  assert.equal(Object.isFrozen(exposed), true);
  assert.equal(Object.isFrozen(exposed.codeVerification), true);
  assert.equal(Object.isFrozen(exposed.providerSetup),true);
  assert.equal(Object.isFrozen(exposed.studioKeys), true);
  assert.equal(Object.isFrozen(exposed.workspacePreferences), true);
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
  assert.match(mainSource, /setPermissionRequestHandler[\s\S]*?callback\(false\)/);
  assert.match(mainSource, /setPermissionCheckHandler\(\(\)\s*=>\s*false\)/);
  assert.match(mainSource, /setDevicePermissionHandler\(\(\)\s*=>\s*false\)/);
});

test('source contract: bundled resource entry executes in owned writable cwd over private IPC', () => {
  assert.match(mainSource, /spawn\(nodeExecutable,\s*\[entry\]/);
  assert.match(mainSource, /cwd:\s*userRoot/);
  assert.match(mainSource, /shell:\s*false/);
  assert.match(mainSource, /windowsHide:\s*true/);
  assert.match(mainSource, /stdio:\s*\['ignore',\s*'ignore',\s*'ignore',\s*'ipc'\]/);
  assert.match(mainSource, /await stopDaemon\(\)[\s\S]*?await startDaemon\(path\)/);
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
  const context = { child, token, origin, loginCancellations: 0, providerSetup: null, setTimeout: () => 1, clearTimeout() {} };
  context.providerSetup = { cancelPending() { context.loginCancellations++; } };
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
  await Promise.resolve();
  assert.equal(fixture.token, '');
  assert.equal(fixture.origin, '');
  assert.equal(fixture.loginCancellations, 1, 'The owned pending sign-in is cancelled before waiting for daemon quiescence.');
  assert.equal(settled, false);
  assert.deepEqual(JSON.parse(JSON.stringify(envelope)), { type: 'arcane-shutdown', protocolVersion: 1 });
  child.exitCode = 0;
  child.emit('close', 0);
  assert.equal(await stopped, true);
});

test('regression: an already failed owned child cannot count as clean quiescence', async () => {
  const fixture = stopFixture({ exitCode: 9, connected: false });
  assert.equal(await fixture.stopOwned(), false, 'Failed shutdown must not authorize a new project runtime.');
  assert.equal(fixture.loginCancellations, 1);
});

test('regression: post-idle shutdown fences fresh requests before awaiting child cleanup', async () => {
  // Source boundary fixture: neither a real listener nor a native service runs.
  const begin = labSource.lastIndexOf('close(): Promise<void> {');
  const end = labSource.indexOf('\n    }', begin);
  assert.ok(begin >= 0 && end > begin, 'Expected the connection lab lifecycle boundary.');
  const member = labSource.slice(begin, end + '\n    }'.length);
  let release, nativeAssetsFenced = false;
  const childCleanup = new Promise(resolve => { release = resolve; });
  const server = {
    accepting: true,
    closeAllConnections() {},
    close(callback) { this.accepting = false; callback?.(); return this; },
    closeIdleConnections() {},
  };
  const cleanup = vm.runInNewContext(stripTypeScriptTypes('let cleanup=null,shuttingDown=false; const fixture = { ' + member + ' }; fixture.close.bind(fixture);'), {
    server, workflow: null, associations: null, ownsAssociations: false, ArcaneError: Error, ownedTests: null,
    ownedSourceVerifier: { dispose() { assert.equal(nativeAssetsFenced, true, 'Native authority is fenced before compiler disposal'); } },
    nativeAssetRegistry: { close() { nativeAssetsFenced = true; } },
    codex: { close: () => { assert.equal(nativeAssetsFenced, true, 'Native authority must be fenced before child cleanup'); return childCleanup; } },
  });
  const closing = cleanup();
  try {
    await Promise.resolve();
    assert.equal(server.accepting, false, 'A holder of the old agent bearer can currently open a fresh socket while shutdown waits.');
    assert.equal(nativeAssetsFenced, true, 'Shutdown retires native authority while child cleanup is still held');
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
    process: { argv: ['C:\\Arcane\\Arcane.exe', '--arcane-smoke', 'C:\\Smoke\\new-empty'], platform: 'win32', resourcesPath: 'C:\\Arcane\\resources', env: {} },
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
  });
  assert.equal(options.studioImport, importHooks, 'Packaged assets use the same owned production host hooks.');
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
  const pipelineCall = /const pipeline\s*=\s*createAssetPipeline\((\{[\s\S]*?\})\);/.exec(serviceSource);
  assert.ok(pipelineCall, 'Expected asset pipeline configuration.');
  const pipeline = vm.runInNewContext('(' + pipelineCall[1] + ')', { options, root: result, ...win32 });
  assert.equal(policy.within(pipeline.workspaceRoot, pipeline.outputRoot), true, 'Generated asset output must fit the writable pipeline workspace.');
  assert.equal(pipeline.workerRoot, win32.join(resources, 'workers', 'blender'), 'Bundled worker lookup must retain the immutable resource root.');
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
