'use strict';
const { app, BrowserWindow, Menu, dialog, nativeTheme, ipcMain, safeStorage, clipboard } = require('electron');
const { spawn } = require('node:child_process');
const { join, resolve, basename } = require('node:path');
const { mkdir, readFile, writeFile, readdir } = require('node:fs/promises');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const policy = require('./policy.cjs');
const { createCodeVerification } = require('./code-verification.cjs');
const { createProviderSetup } = require('./provider-setup.cjs');
const { createStudioKeyVault } = require('./studio-key-vault.cjs');
app.setName('Arcane'); app.setAppUserModelId('com.arcane.desktop'); app.enableSandbox();
app.commandLine.appendSwitch('disable-background-networking');
const args = process.argv.slice(app.isPackaged ? 1 : 2);
const smoke = args[0] === '--arcane-smoke';
if (args.length && (!smoke || args.length !== 2)) throw new Error('Only the bounded local smoke-check mode is accepted.');
const smokeRoot = smoke ? policy.localPath(args[1]) : null;
let profilePreparationFailed = false;
if (smokeRoot) app.setPath('userData', policy.prepareSmokeDirectory(smokeRoot));
else { try { app.setPath('userData', policy.prepareUserDirectory(app.getPath('userData'), { appData: app.getPath('appData'), localAppData: process.env.LOCALAPPDATA })); } catch { profilePreparationFailed = true; } }
const locked = !profilePreparationFailed && app.requestSingleInstanceLock();
let window, child, origin = '', token = '', closing = false, switching = false, userRoot, productRoot, nodeExecutable, projectPath;
let codeVerification, projectSession, providerSetup;
let studioKeyVault;
let workspacePreferences;
const CODE_VERIFICATION_WARNING = 'Arcane opened without Luau verification. The saved compiler is unavailable. Saved configuration was retained; choose an approved compiler in Tool > Configure Luau verification, then restart Arcane.';
const started = performance.now(); let daemonReadyMs = 0, firstReadyMs = 0;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function ownedDirectory(path) { await policy.directPath(path, 'directory', true); await mkdir(path, { recursive: true, mode: 0o700 }); return policy.directPath(path); }
async function stopDaemon() {
  providerSetup?.cancelPending();
  const owned = child; child = null; token = ''; origin = '';
  if (!owned) return true;
  if (owned.exitCode !== null || owned.signalCode != null) return owned.exitCode === 0;
  return new Promise(resolve => {
    let finished = false;
    const done = code => { if (finished) return; finished = true; clearTimeout(timer); resolve(code === 0); };
    const timer = setTimeout(() => { if (owned.exitCode === null) owned.kill(); done(1); }, 15000);
    owned.once('exit', done); owned.once('close', done);
    if (owned.connected) owned.send({ type: 'arcane-shutdown', protocolVersion: 1 }, error => { if (error && owned.exitCode === null) owned.kill(); }); else owned.kill();
  });
}
async function startDaemon(project) {
  const canonical = await policy.directPath(project);
  const key = createHash('sha256').update(process.platform === 'win32' ? canonical.toLowerCase() : canonical).digest('hex');
  const stateRoot = await ownedDirectory(join(userRoot, 'runtime', 'projects', key));
  const env = policy.daemonEnvironment(process.env, { productRoot, stateRoot, projectPath: canonical });
  // Persist the per-project listener: key-only Studio connections encode this port.
  // A conflicting occupied port fails startup; no silent port rotation or key replacement.
  const portFile = join(stateRoot, 'listener-port.json'); let savedPort = null;
  const startupPortError = message => Object.assign(new Error(message), { code: 'ARCANE_PROJECT_PORT' });
  // Only a daemon-proved listener bind conflict uses port wording and the port code; other outcomes stay generic.
  const startupFailure = code => code === 'PORT_IN_USE' ? startupPortError(STARTUP_FAILURE_TEXT[code]) : Object.assign(new Error(STARTUP_FAILURE_TEXT[code]), { code: 'ARCANE_STARTUP' });
  const STARTUP_FAILURE_TEXT = Object.freeze({
    PORT_IN_USE: 'The local runtime could not start because its local port is in use. Project records and the saved port were retained. Check for another app using the local port, then restart Arcane. No automatic retry was attempted.',
    STATE_NEWER: 'This project uses records saved by a newer version of Arcane. Open this project with that version or later. No automatic retry or downgrade was attempted.',
    STATE_UNSAFE: 'Arcane could not safely verify this project\'s saved records. They were retained unchanged; inspect the Arcane application-data folder before restarting. No automatic retry was attempted.',
    RESOURCE_UNAVAILABLE: 'The Arcane application folder is incomplete or unavailable. Project records and the saved port were retained. Replace the complete app folder, then restart Arcane. No automatic retry was attempted.',
    STARTUP_FAILED: 'The local runtime could not start. Project records and the saved port were retained. No automatic retry was attempted.',
    STARTUP_TIMEOUT: 'The local runtime startup timed out after 30 seconds. Project records and the saved port were retained. No automatic retry was attempted.',
  });
  const portFailure = () => { throw startupPortError('Saved local port metadata is unavailable. Project records were retained; inspect the Arcane application-data folder before restarting.'); };
  const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  const sameNode = (a, b) => ['dev', 'ino', 'mode', 'nlink'].every(name => a[name] === b[name]);
  const sameFile = (a, b) => sameNode(a, b) && ['size', 'mtimeNs', 'ctimeNs'].every(name => a[name] === b[name]);
  // Snapshot the already approved project/state paths. Only this fixed metadata
  // file is opened; no key store, credential or renderer-selected path is read.
  const chain = [];
  for (const full of [canonical, stateRoot]) {
    let current = full, depth = 0;
    for (;;) {
      if (++depth > 64) portFailure();
      const stat = fs.lstatSync(current, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(fs.realpathSync(current), current)) portFailure();
      chain.push({ path: current, stat });
      const parent = resolve(current, '..'); if (parent === current) break; current = parent;
    }
  }
  function checkDirectories() {
    for (const node of chain) {
      const stat = fs.lstatSync(node.path, { bigint: true });
      if (!sameNode(node.stat, stat) || !stat.isDirectory() || stat.isSymbolicLink() || !samePath(fs.realpathSync(node.path), node.path)) portFailure();
    }
  }
  function readPortRecord() {
    checkDirectories();
    let before;
    try { before = fs.lstatSync(portFile, { bigint: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; checkDirectories(); return null; }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 1024n || !samePath(fs.realpathSync(portFile), portFile)) portFailure();
    const fd = fs.openSync(portFile, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      if (!sameFile(before, fs.fstatSync(fd, { bigint: true }))) portFailure();
      const buffer = Buffer.alloc(1025); let length = 0;
      while (length < buffer.length) {
        const count = fs.readSync(fd, buffer, length, buffer.length - length, length);
        if (!Number.isSafeInteger(count) || count < 0 || count > buffer.length - length) portFailure();
        if (!count) break; length += count;
      }
      checkDirectories();
      if (length > 1024 || BigInt(length) !== before.size || !sameFile(before, fs.fstatSync(fd, { bigint: true })) ||
          !sameFile(before, fs.lstatSync(portFile, { bigint: true })) || !samePath(fs.realpathSync(portFile), portFile)) portFailure();
      const bytes = buffer.subarray(0, length), saved = JSON.parse(bytes.toString('utf8'));
      if (!saved || Object.getPrototypeOf(saved) !== Object.prototype || Object.keys(saved).sort().join(',') !== 'port,protocolVersion' ||
          saved.protocolVersion !== 1 || !Number.isInteger(saved.port) || saved.port < 1 || saved.port > 65535) portFailure();
      return { port: saved.port, stat: before, bytes };
    } finally { fs.closeSync(fd); }
  }
  const priorPortRecord = readPortRecord();
  if (priorPortRecord) { savedPort = priorPortRecord.port; env.ARCANE_PORT = String(savedPort); }
  const entry = await policy.directPath(join(productRoot, 'dist/apps/daemon/src/product-main.js'), 'file');
  // Saved host settings are authoritative; only absent settings use the pinned product compiler.
  // Both paths populate the normal trusted adapter fields. No inherited overrides survive.
  const { managedCodeVerificationConfiguration } = await import(require('node:url').pathToFileURL(join(productRoot, 'scripts/managed-luau-compiler.mjs')).href);
  const verification = managedCodeVerificationConfiguration({ codeVerification,
    project: { projectId: key, projectPath: canonical, stateRoot }, productRoot });
  Object.assign(env, verification.environment);
  const owned = spawn(nodeExecutable, [entry], { cwd: userRoot, env, shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  child = owned;
  let reportedFailure = null;
  const ready = await new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); owned.removeListener('error', fail); owned.removeListener('exit', fail); owned.removeListener('message', onMessage); };
    const timer = setTimeout(() => { cleanup(); reject(startupFailure(reportedFailure ?? 'STARTUP_TIMEOUT')); }, 30000);
    const fail = () => { cleanup(); reject(startupFailure(reportedFailure ?? 'STARTUP_FAILED')); };
    const onMessage = message => {
      if (child !== owned || origin) return;
      // The first valid report is kept until exit; it never establishes readiness or a retry.
      try { const code = policy.startupFailureMessage(message); reportedFailure ??= code; return; } catch { /* Not a failure report. */ }
      let ready; try { ready = policy.readyMessage(message); } catch { return; }
      if (reportedFailure !== null) { cleanup(); reject(startupFailure(reportedFailure)); return; }
      // Use the validated literal port: URL normalizes the explicit HTTP port 80.
      const assignedPort = Number(ready.origin.slice(ready.origin.lastIndexOf(':') + 1));
      cleanup();
      if (savedPort !== null && assignedPort !== savedPort) { reject(startupPortError('The local runtime reported a different port. The saved port was retained; startup was stopped.')); return; }
      resolve({ ...ready, assignedPort });
    };
    owned.once('error', fail); owned.once('exit', fail);
    owned.on('message', onMessage);
  });
  if (child !== owned || (owned.exitCode != null || owned.signalCode != null)) throw new Error('Local runtime stopped before startup completed.');
  const currentPortRecord = readPortRecord();
  if (priorPortRecord ? !currentPortRecord || !sameFile(priorPortRecord.stat, currentPortRecord.stat) || !priorPortRecord.bytes.equals(currentPortRecord.bytes) : currentPortRecord !== null) portFailure();
  if (savedPort === null) {
    const fd = fs.openSync(portFile, 'wx+', 0o600);
    try {
      const created = fs.fstatSync(fd, { bigint: true }); checkDirectories();
      if (!created.isFile() || created.nlink !== 1n || !sameFile(created, fs.lstatSync(portFile, { bigint: true })) || !samePath(fs.realpathSync(portFile), portFile)) portFailure();
      fs.writeFileSync(fd, JSON.stringify({ protocolVersion: 1, port: ready.assignedPort }) + '\n'); fs.fsyncSync(fd);
      const persisted = readPortRecord();
      if (!persisted || persisted.port !== ready.assignedPort || !sameFile(persisted.stat, fs.fstatSync(fd, { bigint: true }))) portFailure();
    } finally { fs.closeSync(fd); }
  }
  origin = ready.origin; token = ready.token;
  daemonReadyMs = performance.now() - started; projectPath = canonical;
  projectSession = Object.freeze({ projectId: key, projectPath: canonical, stateRoot, activeSettingsHash: verification.settingsHash,
    verificationUnavailable: verification.failure === 'compiler-unavailable',
    verificationEnvironmentAbsent: !['ARCANE_LUAU_COMPILER_PATH', 'ARCANE_LUAU_COMPILER_SHA256', 'ARCANE_LUAU_EVIDENCE_DIRECTORY'].some(name => Object.hasOwn(env, name)) });
  if (projectSession.verificationUnavailable) console.warn(CODE_VERIFICATION_WARNING);
  owned.once('exit', () => { if (child === owned && !closing && !switching) { token = ''; origin = ''; void failStartup('The local runtime stopped. Your project records have been retained.'); } });
}
function makeWindow() {
  window = new BrowserWindow({ width: 1512, height: 960, minWidth: 1000, minHeight: 680, show: false, title: 'Arcane', backgroundColor: '#0b0b0d', autoHideMenuBar: true, icon: join(__dirname, 'icon.png'),
    webPreferences: { preload: join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, navigateOnDragDrop: false, spellcheck: false, devTools: !app.isPackaged, partition: 'arcane-workspace' } });
  const session = window.webContents.session;
  session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false); session.setDevicePermissionHandler(() => false);
  session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => callback({ cancel: !policy.requestAllowed(origin, details.url) }));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  for (const type of ['will-navigate', 'will-redirect', 'will-frame-navigate']) window.webContents.on(type, event => { if (!event.isMainFrame || !policy.navigationAllowed(origin, event.url)) event.preventDefault(); });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('render-process-gone', () => { if (!closing && !switching) void failStartup('The workspace renderer stopped. Restart Arcane to recover saved records.'); });
  window.once('ready-to-show', () => { firstReadyMs = performance.now() - started; if (!smoke) window.show(); });
  window.on('page-title-updated', event => event.preventDefault());
  window.on('closed', () => { window = null; if (!switching && !closing) app.quit(); });
}
async function showCodeVerificationWarning() {
  if (smoke || closing || !window || window.isDestroyed() || !projectSession?.verificationUnavailable) return;
  try { await dialog.showMessageBox(window, { type: 'warning', title: 'Luau verification unavailable', message: CODE_VERIFICATION_WARNING }); }
  catch { console.warn('Luau verification warning could not be displayed.'); }
}
async function loadWorkspace() {
  await window.loadURL(origin + '/studio#' + token); window.setTitle('Arcane - ' + basename(projectPath).slice(0, 80));
  await showCodeVerificationWarning();
}
async function chooseProject() {
  if (switching || closing || !window) return;
  const selected = await dialog.showOpenDialog(window, { title: 'Open a local project', properties: ['openDirectory', 'dontAddToRecent'] });
  if (selected.canceled || selected.filePaths.length !== 1) return;
  let path; try { path = await policy.directPath(selected.filePaths[0]); } catch { await dialog.showMessageBox(window, { type: 'error', message: 'Choose a direct local folder, not a link or network directory.' }); return; }
  if (path === projectPath) return;
  const confirm = await dialog.showMessageBox(window, { type: 'question', title: 'Switch project', message: 'Stop this workspace and open the selected project?', detail: 'Active jobs and native connections will stop. Saved records are retained. No inference, Studio connection, write grant or upload starts automatically.', buttons: ['Cancel', 'Open project'], defaultId: 0, cancelId: 0 });
  if (confirm.response !== 1 || closing || switching) return;
  switching = true;
  try {
    // Discard the previous renderer and credential before selecting a new project.
    const old = window; window = null; if (old && !old.isDestroyed()) old.destroy();
    if (!await stopDaemon()) throw new Error('Previous runtime did not close cleanly.');
    await startDaemon(path); makeWindow(); await loadWorkspace();
    const pref = join(userRoot, 'last-project.json'); await policy.directPath(pref, 'file', true);
    await writeFile(pref, JSON.stringify({ version: 1, projectPath: path }) + '\n', { mode: 0o600 });
  } catch (error) { await failStartup(['ARCANE_PROJECT_PORT', 'ARCANE_STARTUP'].includes(error.code) ? error.message : 'Project switching failed. Previous records were retained; no automatic retry was attempted.'); }
  finally { switching = false; }
}
function installMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [{ label: 'Open project...', accelerator: 'CmdOrCtrl+O', click: () => void chooseProject() }, { type: 'separator' }, { label: 'Quit Arcane', accelerator: 'Alt+F4', click: () => app.quit() }] },
    { label: 'View', submenu: [{ label: 'Reload workspace', accelerator: 'CmdOrCtrl+R', click: () => { if (window && !switching && origin && token) window.webContents.reload(); } }, { role: 'togglefullscreen' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
    { label: 'Tool', submenu: [{ label: 'Configure Luau verification...', enabled: !smoke, click: () => {
      void codeVerification.configure().catch(() => { if (window && !closing && !switching) void dialog.showMessageBox(window,
        { type: 'error', title: 'Luau verification', message: 'Luau verification configuration is unavailable. Saved settings were retained.' }); });
    } }] },
    { label: 'Help', submenu: [{ label: 'About Arcane', click: () => { if (window) void dialog.showMessageBox(window, { type: 'info', title: 'Arcane', message: 'Arcane 0.1.0 - Local development preview', detail: 'Your tools. Your workspace.\nThis build is unsigned. It does not automatically connect providers, edit Studio, publish, or train model weights.' }); } }] }
  ]));
}
async function failStartup(message) {
  providerSetup?.dispose();
  if (closing) return; closing = true;
  if (!smoke) await dialog.showMessageBox({ type: 'error', title: 'Arcane could not continue', message });
  else if (smokeRoot) { try { await writeFile(join(smokeRoot, 'error.json'), JSON.stringify({ version: 1, error: message }) + '\n', { flag: 'wx' }); } catch {} }
  await stopDaemon(); app.exit(1);
}
async function checkSmoke() {
  await sleep(1200);
  const stateResponse = await fetch(origin + '/v1/product/state', { headers: { Authorization: 'Bearer ' + token } }); const state = await stateResponse.json();
  const response = await fetch(origin + '/studio');
  const nativeAssetResponse = await fetch(origin + '/v1/codex/state', { headers: { Authorization: 'Bearer ' + token } });
  const nativeAssetState = await nativeAssetResponse.json();
  const memoryResponse = await fetch(origin + '/v1/learning/state', { headers: { Authorization: 'Bearer ' + token } }); const memory = await memoryResponse.json();
  const renderer = JSON.parse(await window.webContents.executeJavaScript(`JSON.stringify({
    title: document.title, desktop: window.arcaneDesktop,
    nodeAvailable: typeof require !== 'undefined' || typeof process !== 'undefined',
    scrollWidth: document.documentElement.scrollWidth, width: innerWidth, height: innerHeight,
    staticIds: ['workspace-topbar','codex-composer','artifact-panel','app-sidebar'].every(id => !!document.getElementById(id)),
    previews: document.querySelectorAll('#asset-previews canvas').length,
    modelOptions: document.getElementById('codex-model')?.options.length ?? 0,
    conversationOnly: document.getElementById('artifact-panel')?.hidden === true && !document.getElementById('workspace-stage')?.classList.contains('preview-open'),
    providerSetupMounted: !!window.arcaneDesktop?.providerSetup && Object.isFrozen(window.arcaneDesktop.providerSetup) &&
      document.getElementById('provider-setup-panel')?.getAttribute('aria-busy') === 'false' && document.getElementById('provider-setup-refresh')?.disabled === false,
    nativeAssetPermissionControls: document.getElementById('codex-assets-grant')?.disabled === true &&
      document.getElementById('codex-assets-revoke')?.disabled === true &&
      !!document.getElementById('codex-assets-status')?.textContent &&
      document.getElementById('codex-assets-status')?.textContent !== 'Asset permission has not been read.',
    codeVerificationBridge: (() => {
      const bridge = window.arcaneDesktop?.codeVerification;
      return !!bridge && Object.isFrozen(bridge) && bridge.version === 1 &&
        typeof bridge.status === 'function' && typeof bridge.configure === 'function';
    })(),
    studioKeysBridge: (() => {
      const bridge = window.arcaneDesktop?.studioKeys;
      return !!bridge && Object.isFrozen(bridge) && bridge.version === 1 &&
        ['list','remember','reveal','forget'].every(name => typeof bridge[name] === 'function');
    })(),
    desktopVerificationController: document.getElementById('desktop-verification')?.getAttribute('aria-busy') === 'false' &&
      document.getElementById('desktop-verification-setup')?.disabled === false &&
      document.getElementById('desktop-verification-refresh')?.disabled === false
  })`));
  const prefs = window.webContents.getLastWebPreferences();
  checks.taskStatusModules = await window.webContents.executeJavaScript(`(async () => {
    for (const path of ['/task-plan-boot.js', '/codex-task-plan.js']) {
      const response = await fetch(path, { cache: 'no-store', credentials: 'omit', redirect: 'error' });
      if (response.status !== 200 || !/^text\\/javascript(?:;|$)/i.test(response.headers.get('content-type') || '')) return false;
      if ((await response.text()).length > 262144) return false;
    }
    const boot = await import('/task-plan-boot.js'), card = await import('/codex-task-plan.js');
    return typeof boot.startTaskPlanCard === 'function' && typeof card.TaskPlanCard?.mount === 'function';
  })()`);
  const workspacePreferenceRead = await window.webContents.executeJavaScript('window.arcaneDesktop.workspacePreferences.read()');
  await writeFile(join(smokeRoot, 'workspace.png'), (await window.webContents.capturePage()).toPNG(), { flag: 'wx' });
  // Exercise only the actual packaged renderer's local draft controllers. No
  // provider setup/lifecycle button, API command or native input is simulated.
  const localChat = JSON.parse(await window.webContents.executeJavaScript(`(async () => {
    const deadline = Date.now() + 8000;
    const tabs = () => Array.from(document.querySelectorAll('#workspace-chat-tabs [role="tab"]'));
    const wait = async predicate => { while (!predicate()) { if (Date.now() >= deadline) throw new Error('Local chat smoke acknowledgement missing.'); await new Promise(resolve => setTimeout(resolve, 20)); } };
    const composer = document.getElementById('codex-composer'), create = document.getElementById('workspace-new-chat');
    if (!composer || !create) throw new Error('Local chat controls missing.');
    await wait(() => tabs().length === 1 && !create.disabled);
    const first = tabs()[0].dataset.chatKey;
    const write = text => { composer.value = text; composer.dispatchEvent(new Event('input', { bubbles: true })); };
    write('Arcane smoke first unsent draft.'); create.click();
    await wait(() => tabs().length === 2 && composer.value === '');
    const second = tabs().find(tab => tab.dataset.chatKey !== first).dataset.chatKey;
    write('Arcane smoke second unsent draft.');
    tabs().find(tab => tab.dataset.chatKey === first).click();
    await wait(() => composer.value === 'Arcane smoke first unsent draft.');
    tabs().find(tab => tab.dataset.chatKey === second).click();
    await wait(() => composer.value === 'Arcane smoke second unsent draft.');
    const stableComposer = composer === document.getElementById('codex-composer');
    write(''); tabs().find(tab => tab.dataset.chatKey === first).click();
    await wait(() => composer.value === 'Arcane smoke first unsent draft.'); write('');
    const close = tabs().find(tab => tab.dataset.chatKey === second).nextElementSibling;
    if (!close || close.tagName !== 'BUTTON' || close.getAttribute('role') === 'tab') throw new Error('Local chat close control missing.');
    close.click(); await wait(() => tabs().length === 1 && composer.value === '');
    return JSON.stringify({ draftsSeparate: true, stableComposer, cleaned: true,
      taskUsageInactive: document.getElementById('codex-task-usage')?.hidden === true });
  })()`));
  const afterChatResponse = await fetch(origin + '/v1/codex/state', { headers: { Authorization: 'Bearer ' + token } });
  const afterChat = await afterChatResponse.json();
  const checks = {
    ownDaemonReady: policy.validOrigin(origin), productStateReadable: stateResponse.ok,
    projectMemoryOffByDefault: memoryResponse.ok && memory.settings?.optIn === false && memory.records?.length === 0,
    projectMemoryScoped: /^[a-f0-9]{64}$/.test(memory.settings?.projectId ?? ''),
    studioIdle: Array.isArray(state.studioSessions) && state.studioSessions.length === 0,
    noCommands: Object.values(state.commandCounts ?? {}).every(n => n === 0),
    isolatedRenderer: renderer.nodeAvailable === false && prefs.sandbox === true && prefs.contextIsolation === true && prefs.nodeIntegration === false,
    sameOriginCsp: (response.headers.get('content-security-policy') ?? '').includes("script-src 'self'"),
    requiredUi: renderer.staticIds === true, noHorizontalOverflow: renderer.scrollWidth <= renderer.width,
    genuineEmptyPreview: renderer.previews === 0, desktopIdentity: renderer.desktop?.runtime === 'desktop',
    desktopVerificationSetupMounted: renderer.codeVerificationBridge === true && renderer.desktopVerificationController === true,
    studioKeyVaultBridgeMounted: renderer.studioKeysBridge === true,
    workspacePreferencesDisabledAndEmpty: workspacePreferenceRead?.available === false && workspacePreferenceRead.preferences === null,
    localChatDraftSwitching: localChat.draftsSeparate === true && localChat.stableComposer === true && localChat.cleaned === true,
    taskUsageHiddenWithoutTask: localChat.taskUsageInactive === true,
    localChatIntentsStartNoNativeLifecycle: afterChatResponse.ok && afterChat.state?.snapshot === null && afterChat.state.actions?.length === 0,
    optionalCodeVerificationFailureContained: !projectSession.verificationUnavailable ||
      (projectSession.activeSettingsHash === null && projectSession.verificationEnvironmentAbsent),
    externalNavigationRejected: !policy.navigationAllowed(origin, 'https://example.com/') && !policy.requestAllowed(origin, 'file:///C:/Windows/win.ini'),
    nativeLifecycleNotStarted: renderer.modelOptions <= 1,
    conversationOnlyDefault:renderer.conversationOnly === true,providerSetupMounted:renderer.providerSetupMounted === true,
    nativeAssetPermissionMounted: nativeAssetResponse.ok && nativeAssetState.state?.snapshot === null &&
      nativeAssetState.state?.nativeAssets?.available === true && nativeAssetState.state.nativeAssets.sealed === false &&
      nativeAssetState.state.nativeAssets.granted === false && nativeAssetState.state.nativeAssets.admissionOpen === false &&
      renderer.nativeAssetPermissionControls === true
  };
  checks.shutdownClean = await stopDaemon();
  const report = { schemaVersion: 1, kind: 'arcane-windows-executable-smoke', version: app.getVersion(), electronVersion: process.versions.electron,
    elapsed: { daemonReadyMs: Math.round(daemonReadyMs), firstReadyMs: Math.round(firstReadyMs), totalMs: Math.round(performance.now() - started) },
    viewport: { width: renderer.width, height: renderer.height }, checks,
    codeVerification: { configuredUnavailable: projectSession.verificationUnavailable },
    studioKeyVault: { enabled: false, encryptionAvailable: safeStorage.isEncryptionAvailable() === true, encryptionRoundTripTested: false },
    workspacePreferences: { enabled: false, encryptionAvailable: safeStorage.isEncryptionAvailable() === true, encryptionRoundTripTested: false },
    localChat: { harnessOnlyRendererIntents: true, nativeKeyboardInputVerified: false, inferenceStarted: false },
    inferenceStarted: false, studioOperations: 0, signed: false, fullProductVerified: false };
  await writeFile(join(smokeRoot, 'checks.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  closing = true; app.exit(Object.values(checks).every(Boolean) ? 0 : 1);
}
if (profilePreparationFailed) app.whenReady().then(() => failStartup('Arcane application data could not be opened safely. No project or provider was started.'));
else if (!locked) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.on('before-quit', event => { if (!closing) { event.preventDefault(); closing = true; providerSetup?.dispose(); void stopDaemon().then(clean => app.exit(clean ? 0 : 1)); } });
  app.on('window-all-closed', () => { if (!switching && !closing) app.quit(); });
  app.whenReady().then(async () => {
    try {
      nativeTheme.themeSource = 'dark';
      codeVerification = createCodeVerification({ dialog, smoke, getSession: () => {
        if (closing || switching || !window || !projectSession || !origin || !token) return null;
        return { ...projectSession, window, origin, epoch: projectSession };
      } });
      codeVerification.installIpc(ipcMain);
      studioKeyVault = createStudioKeyVault({ safeStorage, clipboard, enabled: !smoke, getSession: () => {
        if (closing || switching || !window || !projectSession || !origin || !token || !userRoot) return null;
        return { ...projectSession, window, origin, userRoot, epoch: projectSession };
      } });
      studioKeyVault.installIpc(ipcMain);
      workspacePreferences = require('./workspace-preferences.cjs').createWorkspacePreferences({ safeStorage, enabled: !smoke, getSession: () => {
        if (closing || switching || !window || !projectSession || !origin || !token || !userRoot) return null;
        return { ...projectSession, window, origin, userRoot, epoch: projectSession };
      } });
      workspacePreferences.installIpc(ipcMain);
      providerSetup = createProviderSetup({getWindow:()=>closing||switching?null:window,getOrigin:()=>origin,getProjectPath:()=>projectPath,enabled:!smoke,dialog});
      for (const action of ['status','login','install','launch']) ipcMain.handle('arcane:provider-'+action, async (event,...args)=>{
        try {
          const contents=window?.webContents,frame=event.senderFrame;
          if(closing||switching||!contents||contents.isDestroyed()||event.sender!==contents||frame!==contents.mainFrame||
            !frame||!policy.validOrigin(origin)||!policy.navigationAllowed(origin,frame.url)||new URL(frame.url).href!==frame.url||
            args.length!==1||!['codex','claude'].includes(args[0]))throw Error('Denied');
          return await providerSetup[action](args[0]);
        } catch { throw new Error('Native provider setup unavailable.'); }
      });
      // Electron can create the profile before ready, so validate the report before the app launches (runner owns the empty root).
      if (smokeRoot) await policy.directPath(smokeRoot);
      userRoot = await ownedDirectory(app.getPath('userData'));
      productRoot = app.isPackaged ? join(process.resourcesPath, 'product') : resolve(__dirname, '../../..');
      nodeExecutable = app.isPackaged ? join(process.resourcesPath, 'node/node.exe') : join(process.env.ProgramFiles ?? 'C:/Program Files', 'nodejs/node.exe');
      await policy.directPath(productRoot); await policy.directPath(nodeExecutable, 'file');
      const defaultProject = await ownedDirectory(join(userRoot, 'projects', 'Untitled')); let selected = defaultProject;
      try {
        const pref = join(userRoot, 'last-project.json'); await policy.directPath(pref, 'file'); const bytes = await readFile(pref);
        if (bytes.length > 8192) throw new Error('Project preference too large.'); const saved = JSON.parse(bytes.toString('utf8'));
        if (Object.keys(saved).sort().join(',') !== 'projectPath,version' || saved.version !== 1) throw new Error('Invalid project preference.'); selected = await policy.directPath(saved.projectPath);
      } catch (error) { if (error.code !== 'ENOENT' && !smoke) await dialog.showMessageBox({ type: 'warning', title: 'Saved project unavailable', message: 'Starting an empty local project. The saved preference was preserved; use File > Open project to choose a folder.' }); }
      await startDaemon(selected); makeWindow(); installMenu(); await loadWorkspace(); if (smoke) await checkSmoke();
    } catch (error) { await failStartup(['ARCANE_PROJECT_PORT', 'ARCANE_STARTUP'].includes(error.code) ? error.message : 'Startup failed. Verify the complete app folder is present and its runtime is permitted by Windows. No security settings were changed.'); }
  });
}
