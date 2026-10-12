'use strict';
const { app, BrowserWindow, Menu, dialog, nativeTheme } = require('electron');
const { spawn } = require('node:child_process');
const { join, resolve, basename } = require('node:path');
const { mkdir, readFile, writeFile, readdir } = require('node:fs/promises');
const { createHash } = require('node:crypto');
const policy = require('./policy.cjs');
app.setName('Arcane'); app.setAppUserModelId('com.arcane.desktop'); app.enableSandbox();
app.commandLine.appendSwitch('disable-background-networking');
const args = process.argv.slice(app.isPackaged ? 1 : 2);
const smoke = args[0] === '--arcane-smoke';
if (args.length && (!smoke || args.length !== 2)) throw new Error('Only the bounded local smoke-check mode is accepted.');
const smokeRoot = smoke ? policy.localPath(args[1]) : null;
if (smokeRoot) app.setPath('userData', join(smokeRoot, 'profile'));
const locked = app.requestSingleInstanceLock();
let window, child, origin = '', token = '', closing = false, switching = false, userRoot, productRoot, nodeExecutable, projectPath;
const started = performance.now(); let daemonReadyMs = 0, firstReadyMs = 0;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function ownedDirectory(path) { await policy.directPath(path, 'directory', true); await mkdir(path, { recursive: true, mode: 0o700 }); return policy.directPath(path); }
async function stopDaemon() {
  const owned = child; child = null; token = ''; origin = '';
  if (!owned || owned.exitCode !== null) return true;
  return new Promise(resolve => {
    let finished = false;
    const done = code => { if (finished) return; finished = true; clearTimeout(timer); resolve(code === 0); };
    const timer = setTimeout(() => { if (owned.exitCode === null) owned.kill(); done(1); }, 15000);
    owned.once('close', done);
    if (owned.connected) owned.send({ type: 'arcane-shutdown', protocolVersion: 1 }, error => { if (error && owned.exitCode === null) owned.kill(); }); else owned.kill();
  });
}
async function startDaemon(project) {
  const canonical = await policy.directPath(project);
  const key = createHash('sha256').update(process.platform === 'win32' ? canonical.toLowerCase() : canonical).digest('hex');
  const stateRoot = await ownedDirectory(join(userRoot, 'runtime', 'projects', key));
  const env = policy.daemonEnvironment(process.env, { productRoot, stateRoot, projectPath: canonical });
  const entry = await policy.directPath(join(productRoot, 'dist/apps/daemon/src/product-main.js'), 'file');
  const owned = spawn(nodeExecutable, [entry], { cwd: userRoot, env, shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  child = owned;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { owned.kill(); reject(new Error('Startup timed out.')); }, 30000);
    const fail = () => { clearTimeout(timer); reject(new Error('Bundled local runtime failed.')); };
    owned.once('error', fail); owned.once('exit', fail);
    owned.on('message', message => {
      try { const ready = policy.readyMessage(message); if (child !== owned || origin) return;
        origin = ready.origin; token = ready.token; clearTimeout(timer);
        owned.removeListener('error', fail); owned.removeListener('exit', fail); owned.removeAllListeners('message'); resolve();
      } catch { /* Exact private parent-child handoff only. */ }
    });
  });
  daemonReadyMs = performance.now() - started; projectPath = canonical;
  owned.once('exit', () => { if (child === owned && !closing && !switching) { token = ''; origin = ''; if (window && !window.isDestroyed()) window.destroy(); void failStartup('The local runtime stopped. Your project records have been retained.'); } });
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
async function loadWorkspace() { await window.loadURL(origin + '/studio#' + token); window.setTitle('Arcane - ' + basename(projectPath).slice(0, 80)); }
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
  } catch { await failStartup('Project switching failed. Previous records were retained; no automatic retry was attempted.'); }
  finally { switching = false; }
}
function installMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [{ label: 'Open project...', accelerator: 'CmdOrCtrl+O', click: () => void chooseProject() }, { type: 'separator' }, { label: 'Quit Arcane', accelerator: 'Alt+F4', click: () => app.quit() }] },
    { label: 'View', submenu: [{ label: 'Reload workspace', accelerator: 'CmdOrCtrl+R', click: () => { if (window && !switching && origin && token) void loadWorkspace(); } }, { role: 'togglefullscreen' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
    { label: 'Help', submenu: [{ label: 'About Arcane', click: () => { if (window) void dialog.showMessageBox(window, { type: 'info', title: 'Arcane', message: 'Arcane 0.1.0 - Local development preview', detail: 'Your tools. Your workspace.\nThis build is unsigned. It does not automatically connect providers, edit Studio, publish, or train model weights.' }); } }] }
  ]));
}
async function failStartup(message) {
  if (closing) return;
  if (!smoke) await dialog.showMessageBox({ type: 'error', title: 'Arcane could not continue', message });
  else if (smokeRoot) { try { await writeFile(join(smokeRoot, 'error.json'), JSON.stringify({ version: 1, error: message }) + '\n', { flag: 'wx' }); } catch {} }
  closing = true; await stopDaemon(); app.exit(1);
}
async function checkSmoke() {
  await sleep(1200);
  const stateResponse = await fetch(origin + '/v1/product/state', { headers: { Authorization: 'Bearer ' + token } }); const state = await stateResponse.json();
  const response = await fetch(origin + '/studio');
  const renderer = JSON.parse(await window.webContents.executeJavaScript("JSON.stringify({title:document.title,desktop:window.arcaneDesktop,nodeAvailable:typeof require!=='undefined'||typeof process!=='undefined',scrollWidth:document.documentElement.scrollWidth,width:innerWidth,height:innerHeight,staticIds:['workspace-topbar','codex-composer','artifact-panel','app-sidebar'].every(id=>!!document.getElementById(id)),previews:document.querySelectorAll('#asset-previews canvas').length,modelOptions:document.getElementById('codex-model')?.options.length??0})"));
  const prefs = window.webContents.getLastWebPreferences();
  await writeFile(join(smokeRoot, 'workspace.png'), (await window.webContents.capturePage()).toPNG(), { flag: 'wx' });
  const checks = {
    ownDaemonReady: policy.validOrigin(origin), productStateReadable: stateResponse.ok,
    studioIdle: Array.isArray(state.studioSessions) && state.studioSessions.length === 0,
    noCommands: Object.values(state.commandCounts ?? {}).every(n => n === 0),
    isolatedRenderer: renderer.nodeAvailable === false && prefs.sandbox === true && prefs.contextIsolation === true && prefs.nodeIntegration === false,
    sameOriginCsp: (response.headers.get('content-security-policy') ?? '').includes("script-src 'self'"),
    requiredUi: renderer.staticIds === true, noHorizontalOverflow: renderer.scrollWidth <= renderer.width,
    genuineEmptyPreview: renderer.previews === 0, desktopIdentity: renderer.desktop?.runtime === 'desktop',
    externalNavigationRejected: !policy.navigationAllowed(origin, 'https://example.com/') && !policy.requestAllowed(origin, 'file:///C:/Windows/win.ini'),
    nativeLifecycleNotStarted: renderer.modelOptions <= 1
  };
  checks.shutdownClean = await stopDaemon();
  const report = { schemaVersion: 1, kind: 'arcane-windows-executable-smoke', version: app.getVersion(), electronVersion: process.versions.electron,
    elapsed: { daemonReadyMs: Math.round(daemonReadyMs), firstReadyMs: Math.round(firstReadyMs), totalMs: Math.round(performance.now() - started) },
    viewport: { width: renderer.width, height: renderer.height }, checks, inferenceStarted: false, studioOperations: 0, signed: false, fullProductVerified: false };
  await writeFile(join(smokeRoot, 'checks.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  closing = true; app.exit(Object.values(checks).every(Boolean) ? 0 : 1);
}
if (!locked) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.on('before-quit', event => { if (!closing) { event.preventDefault(); closing = true; void stopDaemon().then(clean => app.exit(clean ? 0 : 1)); } });
  app.on('window-all-closed', () => { if (!switching && !closing) app.quit(); });
  app.whenReady().then(async () => {
    try {
      nativeTheme.themeSource = 'dark';
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
    } catch { await failStartup('Startup failed. Verify the complete app folder is present and its runtime is permitted by Windows. No security settings were changed.'); }
  });
}
