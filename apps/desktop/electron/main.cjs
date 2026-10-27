'use strict';
const { app, BrowserWindow, Menu, dialog: nativeDialog, nativeTheme, ipcMain, safeStorage, clipboard, shell, Notification, screen } = require('electron');
const { spawn } = require('node:child_process');
const { join, resolve, basename } = require('node:path');
const { mkdir, readFile, writeFile, readdir } = require('node:fs/promises');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const policy = require('./policy.cjs');
policy.protectConsolePipes([process.stdout, process.stderr]);
const { createCodeVerification } = require('./code-verification.cjs');
const { createProviderSetup } = require('./provider-setup.cjs');
const { createStudioKeyVault } = require('./studio-key-vault.cjs');
app.setName('Arcane'); app.setAppUserModelId('com.arcane.desktop'); app.enableSandbox();
app.commandLine.appendSwitch('disable-background-networking');
const args = process.argv.slice(app.isPackaged ? 1 : 2);
// ARCANE_CUSTOMER_CHAT_CHECK_V1_BEGIN
// Diagnostic-only: no send, approval, credential export, debug port or renderer capability.
function createCustomerCheck(argv) {
  if (argv[0] !== '--arcane-customer-check') return null;
  const deny = () => { throw new Error('Customer check unavailable.'); };
  if (!app.isPackaged || process.platform !== 'win32' || argv.length !== 3 || !['first','reopen'].includes(argv[2])) deny();
  const path = require('node:path'), root = path.resolve(argv[1]);
  if (root !== argv[1] || !/^arcane-customer-check-[0-9a-f-]{36}$/.test(path.basename(root))) deny();
  function direct(file, directory = false) {
    let cursor = path.resolve(file);
    for (;;) { const st = fs.lstatSync(cursor); if (st.isSymbolicLink()) deny(); const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent; }
    const st = fs.lstatSync(file);
    if (directory ? !st.isDirectory() : !st.isFile() || st.nlink !== 1) deny();
    if (fs.realpathSync(file).toLowerCase() !== path.resolve(file).toLowerCase()) deny();
    return st;
  }
  direct(root, true);
  const same = (a,b) => ['dev','ino','mode','nlink','size','mtimeMs','ctimeMs'].every(k=>a[k]===b[k]);
  function bytes(file,max,hashOnly=false) {
    const before=direct(file);if(before.size>max)deny();let fd;
    try {
      fd=fs.openSync(file,'r');const opened=fs.fstatSync(fd);if(!same(before,opened)||!opened.isFile()||opened.nlink!==1)deny();
      const buffer=Buffer.alloc(hashOnly?65536:max+1),hash=hashOnly?createHash('sha256'):null;let length=0;
      for(;;){const count=fs.readSync(fd,buffer,hashOnly?0:length,hashOnly?Math.min(buffer.length,max-length+1):buffer.length-length,length);if(!count)break;length+=count;if(length>max)deny();if(hash)hash.update(buffer.subarray(0,count));if(!hash&&length===buffer.length)break;}
      const after=fs.fstatSync(fd);if(!same(opened,after)||!same(after,direct(file)))deny();
      return hash?hash.digest('hex'):buffer.subarray(0,length);
    }finally{if(fd!==undefined)fs.closeSync(fd);}
  }
  const json = name => JSON.parse(bytes(path.join(root,name),16384).toString('utf8'));
  const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
  const exact = (v, keys) => v && Object.getPrototypeOf(v) === Object.prototype && Object.keys(v).sort().join(',') === keys.slice().sort().join(',');
  const intent = json('intent.json'), intentHash = digest(intent);
  if (!exact(intent,['schemaVersion','runId','provider','model','effort','nonce','bundleManifestSha256','executableSha256','authorizedOneTurn']) || intent.schemaVersion !== 1 || intent.authorizedOneTurn !== true ||
      !/^[0-9a-f-]{36}$/.test(intent.runId) || path.basename(root) !== 'arcane-customer-check-'+intent.runId || !['codex','claude'].includes(intent.provider) ||
      ![intent.model,intent.effort].every(v=>typeof v==='string'&&/^[A-Za-z0-9._:-]{1,128}$/.test(v)) || !/^[0-9a-f]{32}$/.test(intent.nonce) ||
      ![intent.bundleManifestSha256,intent.executableSha256].every(v=>/^[0-9a-f]{64}$/.test(v))) deny();
  const bundle = path.dirname(process.execPath);
  direct(process.execPath); direct(path.join(bundle,'windows-manifest.json'));
  if (bytes(process.execPath,512*1024*1024,true) !== intent.executableSha256 || bytes(path.join(bundle,'windows-manifest.json'),16*1024*1024,true) !== intent.bundleManifestSha256) deny();
  // Executables are deliberately not read through the bounded JSON reader.
  const profile = path.join(root,'profile');
  if (argv[2] === 'first') { if(fs.existsSync(profile))deny(); fs.mkdirSync(profile,{mode:0o700}); }
  else { direct(profile,true); const closed=json('first-closed.json'); if(closed.outcome!=='completed'||closed.rootExit!=='normal'||closed.daemonClean!==true||closed.runId!==intent.runId)deny(); }
  app.setPath('userData',profile);
  let pin=null, busy=false, timer=null, failed=false, complete=false, terminal=null, previousReceiptSha256=argv[2]==='reopen'?bytes(path.join(root,'first-closed.json'),16384,true):null;
  const phase=argv[2], prompt='Reply with exactly ARCANE_CUSTOMER_CHAT_OK '+intent.nonce+'. Do not use tools, files, network or Roblox Studio.', reply='ARCANE_CUSTOMER_CHAT_OK '+intent.nonce;
  const write = (name,data) => {direct(root,true); const bytes=JSON.stringify({schemaVersion:1,kind:'arcane-packaged-customer-chat-diagnostic',runId:intent.runId,provider:intent.provider,phase,processId:process.pid,
    intentSha256:intentHash,bundleManifestSha256:intent.bundleManifestSha256,executableSha256:intent.executableSha256,requestedModel:intent.model,requestedEffort:intent.effort,
    fullProductVerified:false,nativeAcceptance:false,studioOperations:0,previousReceiptSha256,...data})+'\n'; fs.writeFileSync(path.join(root,phase+'-'+name+'.json'),bytes,{flag:'wx',mode:0o600});previousReceiptSha256=digest(bytes);};
  const guard=()=>{
    if(digest(json('intent.json'))!==intentHash||!pin||pin.retired||window!==pin.window||projectSession!==pin.session||child!==pin.child||origin!==pin.origin||switching||closing||
      window.isDestroyed()||window.webContents.mainFrame!==pin.frame||window.webContents.isLoading()||projectPath!==path.join(profile,'projects','Untitled')||child.exitCode!=null||child.signalCode!=null||!policy.navigationAllowed(origin,pin.frame.url))deny();
  };
  async function get(route) {
    guard(); const response=await fetch(pin.origin+route,{headers:{Authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(2000)});
    const reader=response.body?.getReader();let cleanupFailed=false;
    try {
      guard();
      const maximum=4*1024*1024,type=response.headers.get('content-type'),encoding=response.headers.get('content-encoding'),declared=response.headers.get('content-length');
      if(!response.ok||!reader||!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(type??'')||encoding!==null||declared!==null&&(!/^(0|[1-9][0-9]{0,9})$/.test(declared)||Number(declared)>maximum))deny();
      const bytes=Buffer.alloc(maximum);let length=0;
      for(;;){
        guard();const part=await reader.read();guard();
        if(part.done)break;
        if(!require('node:util').types.isUint8Array(part.value)||part.value.byteLength===0||part.value.byteLength>maximum-length)deny();
        bytes.set(part.value,length);length+=part.value.byteLength;
      }
      if(declared!==null&&Number(declared)!==length)deny();
      const raw=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,length));guard();return JSON.parse(raw);
    }finally{
      if(reader){
        // A retired scope must not prevent cleanup of this exact owned reader.
        try{guard();}catch{cleanupFailed=true;}
        try{await reader.cancel();}catch{cleanupFailed=true;}
        try{guard();}catch{cleanupFailed=true;}
        try{reader.releaseLock();}catch{cleanupFailed=true;}
        if(cleanupFailed)deny();
      }
    }
  }
  async function ui() {
    guard();
    const value=await window.webContents.executeJavaScript(`(async()=>{const d=window.arcaneDesktop;return {model:document.getElementById('codex-model')?.value??null,effort:document.getElementById('codex-effort')?.value??null,prefs:await d.workspacePreferences.read(),library:await d.conversationLibrary.read(),body:document.body.innerText.slice(0,262144)};})()`);
    guard();return value;
  }
  function selection(v) {const p=v.prefs?.preferences;const tab=p?.tabs?.find(t=>t.localId===p.activeTabId);return p?.provider===intent.provider&&tab?.modelId===intent.model&&tab?.effort===intent.effort&&v.model===intent.model&&v.effort===intent.effort;}
  function library(v) {const l=v.library?.preferences;return l?.conversations?.filter(c=>c.messages?.some(m=>m.provider===intent.provider&&m.role==='user'&&m.text===prompt)&&c.messages.some(m=>m.provider===intent.provider&&m.role==='assistant'&&m.text.trim()===reply))??[];}
  function stop(code) {if(failed||complete)return;failed=true;write('result',{outcome:'unsupported',code,dispatch:fs.existsSync(path.join(root,'armed.json'))?'armed-unknown':'not-armed'});}
  async function observe() {
    if(busy)return;busy=true;
    try {
      guard();
      if(fs.existsSync(path.join(root,phase+'-close.json'))) {const close=json(phase+'-close.json');if(!exact(close,['runId','phase'])||close.runId!==intent.runId||close.phase!==phase)deny();app.quit();return;}
      if(failed||complete)return;
      if(intent.provider==='claude') {const evidence=await claudeChat?.customerCheckEvidence?.();guard();stop(evidence?.nativeIsolationVerified===true?'CLAUDE_TERMINAL_PROOF_UNAVAILABLE':'CLAUDE_ISOLATION_UNAVAILABLE');return;}
      const state=(await get('/v1/codex/state')).state,s=state?.snapshot;
      if(!s?.ready||!s.connected||s.account?.auth!=='subscription')return;
      if(s.provenance!=='installed-cli'||s.mcpIsolation!=='arcane-only-verified'){stop('NATIVE_ISOLATION_UNAVAILABLE');return;}
      if(!s.models?.some(m=>m.model===intent.model&&m.efforts?.includes(intent.effort))){stop('SELECTION_UNSUPPORTED');return;}
      if(s.droppedEvents!==0||state.displayLimited===true||s.approvals?.length||s.events?.some(e=>e.type==='approval'||e.type==='item'&&(e.tool||/tool|command|fileChange/i.test(e.itemType)))){stop('TOOL_ACTIVITY');return;}
      if(s.selection?.model!==intent.model||s.selection?.effort!==intent.effort||s.thread&&(!s.thread.configured||s.thread.writeGranted||s.thread.selection?.model!==intent.model||s.thread.selection?.effort!==intent.effort)){if(fs.existsSync(path.join(root,'armed.json')))stop('NATIVE_SELECTION_OR_POLICY');return;}
      const studio=await get('/v1/studio/sessions');if(!Array.isArray(studio.sessions)||studio.sessions.length){stop('STUDIO_SESSION_PRESENT');return;}
      const visible=await ui();if(!selection(visible))return;
      if(pin.nativeConnection&&pin.nativeConnection!==s.connectionId){stop('NATIVE_CONTEXT_CHANGED');return;}
      pin.nativeConnection=s.connectionId;
      const turnActions=state.actions?.filter(a=>a.action==='turn-start'||a.action==='turn-steer')??[];if(turnActions.length>1||state.submittedMessages?.earlierCount>0){stop('EXTRA_MESSAGE');return;}
      const messages=state.submittedMessages?.messages??[];
      const armed=fs.existsSync(path.join(root,'armed.json'));
      if(phase==='first'&&!armed){if(messages.length||turnActions.length){stop('UNARMED_MESSAGE');return;}if(!fs.existsSync(path.join(root,'first-ready.json')))write('ready',{outcome:'ready',dispatch:'not-armed',catalogueVerified:true,uiSelectionVerified:true,provenance:'installed-cli',isolation:'arcane-only-verified'});return;}
      if(phase==='first') {const a=json('armed.json');if(!exact(a,['runId','promptSha256'])||a.runId!==intent.runId||a.promptSha256!==digest(prompt))deny();}
      if(messages.some(m=>m.text!==prompt)||messages.length>1){stop('EXTRA_MESSAGE');return;}
      const m=messages[0];if(!m)return;
      if(m.state==='unknown'||m.state==='rejected'){stop('DISPATCH_UNRESOLVED');return;}
      const a=state.actions?.filter(a=>a.action==='turn-start'&&a.requestId===m.requestId&&a.state==='acknowledged'&&a.turnId===m.turnId&&a.threadId===state.submittedMessages.threadId&&a.model===intent.model&&a.effort===intent.effort)??[];
      if(m.state!=='acknowledged'||m.model!==intent.model||m.effort!==intent.effort||a.length!==1)return;
      const history=(await get('/v1/codex/history')).nativeHistory,record=history?.recorded,result=record?.result;
      const entries=result?.entries??[];
      const nativeReply=entries.some(e=>e.role==='assistant'&&e.text.trim()===reply&&e.ids.turnId===m.turnId&&e.ids.threadId===state.submittedMessages.threadId);
      const nativePrompt=entries.some(e=>e.role==='user'&&e.text===prompt&&e.ids.turnId===m.turnId);
      const eventReply=s.events?.filter(e=>e.type==='delta'&&e.turnId===m.turnId).map(e=>e.text).join('').trim()===reply;
      const finished=s.thread?.turnId===m.turnId&&s.thread.turnStatus==='completed';
      if(phase==='first'&&!(finished&&(eventReply||nativeReply)))return;
      if(phase==='reopen'&&!(record?.provenance==='installed-cli'&&result.completeness==='complete'&&!result.truncated&&!result.gaps.length&&nativeReply&&nativePrompt))return;
      const saved=library(visible);if(visible.library.preferences?.conversations?.length!==1||saved.length!==1||!visible.body.includes(prompt)||!visible.body.includes(reply))return;
      terminal={outcome:'completed',dispatch:'completed',provenance:'installed-cli',isolation:'arcane-only-verified',nativeModel:null,nativeEffort:null,requestedSelectionAcknowledged:true,
        requestSha256:digest(m.requestId),threadSha256:digest(state.submittedMessages.threadId),turnSha256:digest(m.turnId),conversationSha256:digest(saved[0].id),promptSha256:digest(prompt),replySha256:digest(reply),
        uiSelectionVerified:true,nativeTurnVerified:true,persistedLibraryVerified:true,nativeHistoryVerified:phase==='reopen',auth:'subscription',reauthenticationAction:'unobserved',providerDescendantCleanup:'unobserved'};
      write('result',terminal);complete=true;
    } catch {if(complete){complete=false;failed=true;}else stop('OBSERVATION_UNAVAILABLE');}finally{busy=false;}
  }
  return {profile,prompt,start(){pin={window,session:projectSession,child,origin,frame:window.webContents.mainFrame,retired:false};window.webContents.on('did-start-navigation',(_event,_url,_inPlace,isMainFrame)=>{if(isMainFrame)pin.retired=true;});timer=setInterval(()=>void observe(),1000);timer.unref?.();void observe();},
    async closed(clean){clearInterval(timer);write('closed',{outcome:complete?'completed':failed?'unsupported':'unresolved',rootExit:'normal',daemonClean:clean===true,providerDescendantCleanup:'unobserved',dispatch:terminal?.dispatch??(fs.existsSync(path.join(root,'armed.json'))?'armed-unknown':'not-armed')});}};
}
// ARCANE_CUSTOMER_CHAT_CHECK_V1_END

const customerCheck = createCustomerCheck(args);
const smoke = args[0] === '--arcane-smoke';
if (args.length && !customerCheck && (!smoke || args.length !== 2)) throw new Error('Only the bounded local smoke-check mode is accepted.');
const smokeRoot = smoke ? policy.localPath(args[1]) : null;
let profilePreparationFailed = false;
if (customerCheck) { /* The closed diagnostic mode owns this separate profile. */ }
else if (smokeRoot) app.setPath('userData', policy.prepareSmokeDirectory(smokeRoot));
else { try { app.setPath('userData', policy.prepareUserDirectory(app.getPath('userData'), { appData: app.getPath('appData'), localAppData: process.env.LOCALAPPDATA })); } catch { profilePreparationFailed = true; } }
const locked = !profilePreparationFailed && app.requestSingleInstanceLock();
let window, child, origin = '', token = '', closing = false, switching = false, userRoot, productRoot, nodeExecutable, projectPath;
let codeVerification, projectSession, providerSetup;
let nativeHandoff;
let appAssets = null, assetSelectionGeneration = 0, assetSelectionReady = false;
let studioKeyVault;
let workspacePreferences;
let conversationLibrary;
let codexQueuePreferences, claudeQueuePreferences;
let claudePreferences;
let toolDrafts;
let runtimeRecovery;
let recoveryWindow = null, recoveryWindowFailure = null, deferWindowShow = false;
let claudeChat;
let arcaneChat;
let billing;
let diagnostics = null, diagnosticStorage = null, diagnosticInit = null, diagnosticClose = null, diagnosticTimer = null;
let diagnosticState = 'unavailable', diagnosticRetiring = false, diagnosticBooting = false, diagnosticFlushing = false;
const diagnosticPending = [], diagnosticReports = new Set(), diagnosticChildren = new Map();
let diagnosticSchema = null;
function attachDiagnosticChild(owned) {
  if (smoke || diagnosticRetiring || !owned || owned.exitCode != null || owned.signalCode != null || diagnosticChildren.has(owned)) return;
  const relay = new (require('node:events').EventEmitter)(), pending = [];
  let live = true, detach = null;
  const current = () => live && child === owned && !closing && !diagnosticRetiring && owned.exitCode == null && owned.signalCode == null;
  Object.defineProperty(relay, 'connected', { get: () => owned.connected });
  relay.send = (message, callback) => { if (current()) owned.send(message, callback); else callback?.(new Error('Diagnostic child retired.')); };
  const activate = () => {
    if (detach || !diagnostics || !current()) return;
    detach = diagnostics.attach(relay, current);
    for (const frame of pending.splice(0)) { if (!current()) break; relay.emit('message', frame); }
  };
  const receive = message => {
    if (!current() || !diagnosticSchema) return;
    try {
      if (!message || Object.getPrototypeOf(message) !== Object.prototype || Object.keys(message).sort().join(',') !== 'event,protocolVersion,requestId,type' ||
          message.type !== 'arcane-diagnostic-report' || message.protocolVersion !== 1 || !diagnosticSchema.diagnosticEventId(message.requestId)) return;
      const frame = { type: 'arcane-diagnostic-report', protocolVersion: 1, requestId: message.requestId, event: diagnosticSchema.diagnosticEvent(message.event) };
      if (Buffer.byteLength(JSON.stringify(frame)) > 9 * 1024) return;
      activate();
      if (detach) relay.emit('message', frame); else if (pending.length < 16) pending.push(frame);
    } catch { /* Unvalidated text is neither retained nor acknowledged. */ }
  };
  const retire = () => { if (!live) return; live = false; pending.length = 0; detach?.(); owned.removeListener('message', receive); diagnosticChildren.delete(owned); };
  diagnosticChildren.set(owned, { activate, retire });
  owned.on('message', receive); owned.once('close', retire); activate();
}
function retireDiagnosticChild(owned) { diagnosticChildren.get(owned)?.retire(); }

function persistDiagnostic(event, finishing = false) {
  const host = diagnostics;
  if (diagnosticRetiring && !finishing || !host || diagnosticReports.size >= 16) return;
  const work = Promise.resolve().then(() => host.report(event)).then(result => { if (result?.stored !== true) diagnosticState = 'unavailable'; }).catch(() => { diagnosticState = 'unavailable'; });
  diagnosticReports.add(work); void work.finally(() => diagnosticReports.delete(work)).catch(() => {});
}
function recordStartupDiagnostic(code) {
  const codes = { PROJECT_IN_USE: 'PROJECT_IN_USE', PORT_IN_USE: 'PORT_IN_USE', STATE_NEWER: 'STATE_NEWER', STATE_UNSAFE: 'STATE_UNSAFE',
    RESOURCE_UNAVAILABLE: 'RESOURCE_UNAVAILABLE', STARTUP_TIMEOUT: 'REQUEST_TIMEOUT', STARTUP_FAILED: 'INTERNAL_ERROR' };
  if (smoke || diagnosticRetiring || !Object.hasOwn(codes, code)) return;
  const event = { schemaVersion: 1, eventId: require('node:crypto').randomUUID(), occurredAt: Date.now(), component: 'daemon', stage: 'startup', code: codes[code] };
  if (diagnostics) persistDiagnostic(event); else if (diagnosticBooting && diagnosticPending.length < 8) diagnosticPending.push(event);
}
async function flushDiagnostics() {
  if (diagnosticRetiring || diagnosticFlushing || !diagnostics) return;
  diagnosticFlushing = true;
  try { await diagnostics.flush(); } catch { diagnosticState = 'unavailable'; }
  finally { diagnosticFlushing = false; }
}
async function closeDiagnosticResources() {
  try {
    if (diagnostics && await diagnostics.close() !== true) return false;
    diagnosticStorage?.close(); diagnosticStorage = null; diagnostics = null; return true;
  } catch { diagnosticState = 'unavailable'; return false; }
}
function initializeDiagnostics() {
  if (smoke || diagnosticInit || diagnosticRetiring) return;
  diagnosticBooting = true;
  diagnosticInit = (async () => {
    try {
      const load = relative => import(require('node:url').pathToFileURL(join(productRoot, relative)).href);
      const [report, outbox, plans] = await Promise.all([load('dist/packages/diagnostics/src/report.js'), load('dist/packages/diagnostics/src/outbox.js'), load('dist/packages/protocol/src/plans.js')]);
      diagnosticSchema = report;
      if (diagnosticRetiring && !diagnosticPending.length) return;
      diagnosticStorage = await require('./diagnostics-storage.cjs').openDiagnosticsStorage({ directory: join(userRoot, 'diagnostics'),
        prepareDirectory: require('./diagnostics-directory.cjs').createDiagnosticsDirectoryPreparer({ root: userRoot }) });
      if (diagnosticRetiring && !diagnosticPending.length) return;
      diagnostics = await require('./diagnostics-host.cjs').createDiagnosticsHost({ enabled: true, safeStorage, storage: diagnosticStorage,
        loadRuntime: async () => ({ ...report, ...outbox }), allowedOrigins: plans.ARCANE_PLANS.gateway.allowedOrigins,
        credential: async () => (await billing?.accountCredential().catch(() => null)) ?? null });
      diagnostics.list(); // Refuse a host whose private queue could not be initialized.
      if (diagnosticRetiring && !diagnosticPending.length) return;
      diagnosticState = 'ready';
      for (const event of diagnosticPending.splice(0)) persistDiagnostic(event, true);
      if (diagnosticRetiring) return;
      attachDiagnosticChild(child);
      for (const entry of diagnosticChildren.values()) entry.activate();
      diagnosticTimer = setInterval(() => { void flushDiagnostics(); }, 60000); diagnosticTimer.unref?.();
      void flushDiagnostics();
    } catch { diagnosticState = 'unavailable'; diagnosticPending.length = 0; await closeDiagnosticResources(); }
    finally { diagnosticBooting = false; }
  })().catch(() => { diagnosticState = 'unavailable'; });
}
function closeDiagnostics() {
  diagnosticRetiring = true; clearInterval(diagnosticTimer); diagnosticTimer = null;
  for (const entry of [...diagnosticChildren.values()]) entry.retire();
  if (diagnosticClose) return diagnosticClose;
  diagnosticClose = (async () => {
    await diagnosticInit;
    let timer;
    try { await Promise.race([Promise.allSettled([...diagnosticReports]), new Promise(resolve => { timer = setTimeout(resolve, 1000); })]); }
    finally { clearTimeout(timer); }
    return closeDiagnosticResources();
  })().catch(() => false).finally(() => { diagnosticClose = null; });
  return diagnosticClose;
}
async function exitAfterDiagnostics(code) { const clean = await closeDiagnostics(); if(customerCheck)await customerCheck.closed(clean && code === 0).catch(()=>{}); app.exit(clean ? code : 1); }
let studioPlugin;
let projectPermissions;
// Decisions (any question with more than one button: Claude tool consent, provider sign-in/terminal, plugin install,
// project switch, checkout, turning auto-approve on, Luau setup) open in a separate main-process-owned Arcane window
// (trusted-dialog.cjs) that the workspace renderer cannot answer. Purely informational one-button notices (About,
// warnings) render in-page once the trusted workspace renderer attaches (in-app-dialog.cjs). Without an owner window,
// e.g. for startup failures, the native message box remains. Folder/file pickers stay native.
let appDialogs = null, trustedDialogs = null, pyxBar = null;
const dialog = Object.freeze({
  showMessageBox: (...args) => appDialogs ? appDialogs.showMessageBox(...args) : nativeDialog.showMessageBox(...args),
  showOpenDialog: (...args) => nativeDialog.showOpenDialog(...args),
});
/** Exact main-frame workspace renderer for zero-argument native intents (plugin install, project picker). */
function rendererEvent(event) {
  const contents = window?.webContents, frame = event?.senderFrame;
  try {
    return !closing && !switching && !!contents && !contents.isDestroyed() && event.sender === contents && !!frame && frame === contents.mainFrame &&
      policy.validOrigin(origin) && policy.navigationAllowed(origin, frame.url) && new URL(frame.url).href === frame.url;
  } catch { return false; }
}
const CODE_VERIFICATION_WARNING = 'Arcane opened without Luau verification. The saved compiler is unavailable. Saved configuration was retained; choose an approved compiler in Tool > Configure Luau verification, then restart Arcane.';
const started = performance.now(); let daemonReadyMs = 0, firstReadyMs = 0;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function ownedDirectory(path) { await policy.directPath(path, 'directory', true); await mkdir(path, { recursive: true, mode: 0o700 }); return policy.directPath(path); }
/** Stop every in-app Claude chat turn of the current project and revoke its scoped credentials (quit/switch/failure). */
function stopClaudeChat(reason) { const chat = claudeChat, arcane = stopArcaneChat(); claudeChat = null; return chat ? Promise.all([chat.dispose(reason).catch(() => null), arcane]).then(() => null) : arcane; }
/** Learned preferences for the in-app chats: the daemon's human-only read of the <= 600-character block; '' on any failure. */
async function learnedContext() {
  const at = origin, bearer = token; if (!at || !bearer || smoke) return '';
  try {
    const response = await fetch(at + '/v1/preferences/context', { headers: { Authorization: 'Bearer ' + bearer }, redirect: 'error', signal: AbortSignal.timeout(1500) });
    if (!response.ok) return '';
    const value = await response.json();
    return value && typeof value.text === 'string' ? value.text.slice(0, 600) : '';
  } catch { return ''; }
}
// App-asset authority belongs to one exact owned daemon/project. Startup may
// occur while switching; provider admission never does.
function ownedAppAssetRuntime(broker, epoch, owned) {
  try {
    return !!broker && appAssets === broker && projectSession === epoch && child === owned && !closing &&
      !!origin && !!token && !!owned && owned.connected === true && owned.exitCode == null && owned.signalCode == null && broker.isCurrent() === true;
  } catch { return false; }
}
async function startAppAssets(owned, epoch) {
  if (smoke) return;
  const broker = require('./app-asset-host.cjs').createAppAssetHost({ child: owned, projectPath: epoch.projectPath });
  appAssets = broker; assetSelectionGeneration++; assetSelectionReady = false;
  try {
    await broker.ready();
    if (!ownedAppAssetRuntime(broker, epoch, owned)) throw new Error('App asset runtime changed during startup.');
  } catch {
    // The surrounding startup owner still shuts down this child. Fencing is not
    // an assertion that its transport or accepted daemon work has closed.
    try { broker.fence(); } catch { /* Startup remains failed. */ }
    throw new Error('App asset runtime is unavailable.');
  }
}
function appAssetPort(provider, broker, epoch, owned) {
  const isCurrent = () => !switching && ownedAppAssetRuntime(broker, epoch, owned);
  return Object.freeze({ isCurrent, async issue(value) {
    if (!isCurrent()) throw new Error('App asset runtime is unavailable.');
    const context = await broker.issue({ provider, conversationId: value.conversationId, connectionId: value.connectionId });
    if (!isCurrent()) {
      // This context has never escaped to a provider host: no child could have
      // received its credential. Both cleanup calls are ordered, one-shot and
      // independent of an unknown/held prior receipt.
      try { void Promise.resolve(context.retire()).catch(() => {}); } catch { /* Unknown; never replay. */ }
      try { void Promise.resolve(context.transportClosed()).catch(() => {}); } catch { /* True no-child cleanup only. */ }
      throw new Error('App asset runtime is unavailable.');
    }
    return context;
  } });
}
function clearHumanAssetSelection() {
  assetSelectionGeneration++; assetSelectionReady = false;
  const broker = appAssets;
  if (!broker) return;
  // An unknown clear is not an acknowledgement. Only a later explicit, exact
  // selection ACK can arm the new view; no native grant or cancellation follows.
  try { void Promise.resolve(broker.selectHumanConversation(null)).catch(() => {}); } catch { /* Remains unready. */ }
}
async function selectHumanAssetConversation(event, ...args) {
  const unavailable = () => Object.freeze({ state: 'unavailable' });
  if (smoke || args.length !== 1 || !rendererEvent(event)) return unavailable();
  const owner = window, frame = event.senderFrame, url = frame.url, broker = appAssets, epoch = projectSession, owned = child;
  if (!owner || owner.isDestroyed() || !ownedAppAssetRuntime(broker, epoch, owned)) return unavailable();
  const generation = ++assetSelectionGeneration; assetSelectionReady = false;
  try {
    // The broker snapshots and strictly validates the sole secret-free selection
    // union. Renderer input cannot choose a token, process, project or RPC.
    await broker.selectHumanConversation(args[0]);
    if (generation !== assetSelectionGeneration || owner !== window || owner.isDestroyed() || frame !== owner.webContents.mainFrame || frame.url !== url ||
        !rendererEvent(event) || !ownedAppAssetRuntime(broker, epoch, owned)) return unavailable();
    assetSelectionReady = true;
    return Object.freeze({ state: assetSelectionReady ? 'selected' : 'unavailable' });
  } catch { return unavailable(); }
}
// In-app Claude chat: headless installed Claude Code per turn, Arcane-only MCP config and a scoped credential from this
// project's handoff broker. Bound to this project epoch; the transcript lives in an owned per-project directory.
// Started after startDaemon, so the port/state host fixtures exercise only the daemon boundary.
async function startClaudeChat() {
  if (smoke || !projectSession || !nativeHandoff || !appAssets) return;
  const chatBroker = nativeHandoff, chatEpoch = projectSession, assetBroker = appAssets, chatChild = child;
  const chatDirectory = await ownedDirectory(join(chatEpoch.stateRoot, 'claude-chat'));
  if (nativeHandoff !== chatBroker || !ownedAppAssetRuntime(assetBroker, chatEpoch, chatChild)) return;
  void stopClaudeChat();
  // Persisted per-project consent (Settings > Permissions): on by default, so Claude chat starts without a question.
  const permissions = projectPermissions ? { claudeTools: async () => projectSession === chatEpoch && (await projectPermissions.read()).claudeTools === true,
    allowClaudeTools: async () => { if (projectSession === chatEpoch) await projectPermissions.save({ claudeTools: true }); } } : undefined;
  claudeChat = require('./claude-chat.cjs').createClaudeChat({ projectPath: chatEpoch.projectPath, stateDirectory: chatDirectory, dialog, permissions,
    appAssets: appAssetPort('claude-code', assetBroker, chatEpoch, chatChild),
    getWindow: () => closing || switching || !window || window.isDestroyed() || projectSession !== chatEpoch ? null : window,
    handoff: { prepare: selection => nativeHandoff === chatBroker && projectSession === chatEpoch ? chatBroker.prepareChat(selection) : null,
      release: handoffId => chatBroker.releaseChat(handoffId) },
    learned: learnedContext,
    instructions: async () => (await import(require('node:url').pathToFileURL(join(productRoot, 'dist/packages/protocol/src/arcane-tools.js')).href)).ARCANE_TASK_INSTRUCTIONS });
  await startArcaneChat(permissions);
}
// In-app Arcane chat (Arcane Credits): models through the user's own Arcane gateway, a bounded tool loop in this process
// and Arcane's MCP tools under a scoped credential from this project's handoff broker (the Claude chat scope and consent).
// The gateway client exists only while an account is connected (billing.accountCredential); otherwise status reports
// the chat unavailable and nothing is requested. The account token never leaves the main process.
function stopArcaneChat() { const chat = arcaneChat; arcaneChat = null; return chat ? chat.dispose().catch(() => null) : Promise.resolve(null); }
async function startArcaneChat(permissions) {
  if (smoke || !projectSession || !nativeHandoff || !appAssets) return;
  const chatBroker = nativeHandoff, chatEpoch = projectSession, assetBroker = appAssets, chatChild = child;
  const chatDirectory = await ownedDirectory(join(chatEpoch.stateRoot, 'arcane-chat'));
  if (nativeHandoff !== chatBroker || !ownedAppAssetRuntime(assetBroker, chatEpoch, chatChild)) return;
  void stopArcaneChat();
  const credential = async () => (await billing?.accountCredential().catch(() => null)) ?? null;
  arcaneChat = require('./arcane-chat.cjs').createArcaneChat({ projectPath: chatEpoch.projectPath, stateDirectory: chatDirectory, dialog, permissions,
    appAssets: appAssetPort('arcane', assetBroker, chatEpoch, chatChild),
    getWindow: () => closing || switching || !window || window.isDestroyed() || projectSession !== chatEpoch ? null : window,
    handoff: { prepare: selection => nativeHandoff === chatBroker && projectSession === chatEpoch ? chatBroker.prepareChat(selection) : null,
      release: handoffId => chatBroker.releaseChat(handoffId) },
    gateway: async () => {
      if (!productRoot || !await credential()) return null;
      const module = await import(require('node:url').pathToFileURL(join(productRoot, 'dist/apps/daemon/src/arcane-gateway.js')).href);
      return module.createArcaneGateway({ config: null, vault: null, credential });
    },
    learned: learnedContext,
    instructions: async () => (await import(require('node:url').pathToFileURL(join(productRoot, 'dist/packages/protocol/src/arcane-tools.js')).href)).ARCANE_TASK_INSTRUCTIONS });
}
async function stopDaemon() {
  // Clear/fence the exact private broker synchronously before any shutdown await.
  const assets = appAssets; appAssets = null; assetSelectionGeneration++; assetSelectionReady = false;
  let assetClean = true;
  try { assets?.fence(); } catch { assetClean = false; }
  providerSetup?.cancelPending();
  const handoff = nativeHandoff; nativeHandoff = null;
  // Retire authority while the owned daemon closes; cleanup never holds its shutdown request.
  const handoffCleanup = handoff?.dispose().catch(() => null) ?? Promise.resolve(null);
  const owned = child; child = null; token = ''; origin = '';
  retireDiagnosticChild(owned);
  let clean = false;
  try {
    if (!owned) clean = true;
    else if (owned.exitCode !== null || owned.signalCode != null) clean = owned.exitCode === 0;
    else clean = await new Promise(resolve => {
      let finished = false;
      const done = code => { if (finished) return; finished = true; clearTimeout(timer); resolve(code === 0); };
      const timer = setTimeout(() => { if (owned.exitCode === null) owned.kill(); done(1); }, 15000);
      owned.once('exit', done); owned.once('close', done);
      if (owned.connected) owned.send({ type: 'arcane-shutdown', protocolVersion: 1 }, error => { if (error && owned.exitCode === null) owned.kill(); }); else owned.kill();
    });
  } finally {
    await handoffCleanup;
    // Closing the private IPC broker is not transportClosed on any provider
    // context. A timed-out/failed daemon still returns an unclean outcome.
    try { assets?.close(); } catch { assetClean = false; }
  }
  return clean && assetClean;
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
  let diagnosticFailureRecorded = false;
  const reportFailureOnce = code => { if (!diagnosticFailureRecorded) { diagnosticFailureRecorded = true; recordStartupDiagnostic(code); } };
  const startupFailure = code => { reportFailureOnce(code); return code === 'PORT_IN_USE' ? startupPortError(STARTUP_FAILURE_TEXT[code]) :
    Object.assign(new Error(STARTUP_FAILURE_TEXT[code]), { code: code === 'PROJECT_IN_USE' ? 'ARCANE_PROJECT_IN_USE' : 'ARCANE_STARTUP' }); };
  const STARTUP_FAILURE_TEXT = Object.freeze({
    PROJECT_IN_USE: 'Arcane is already open for this project in another window. Switch to it, or close it and try again.',
    PORT_IN_USE: 'The local runtime could not start because its local port is in use. Project records and the saved port were retained. Check for another app using the local port, then restart Arcane. No automatic retry was attempted.',
    STATE_NEWER: 'This project uses records saved by a newer version of Arcane. Open this project with that version or later. No automatic retry or downgrade was attempted.',
    STATE_UNSAFE: 'Arcane could not safely verify this project\'s saved records. They were retained unchanged; inspect the Arcane application-data folder before restarting. No automatic retry was attempted.',
    RESOURCE_UNAVAILABLE: 'The Arcane application folder is incomplete or unavailable. Project records and the saved port were retained. Replace the complete app folder, then restart Arcane. No automatic retry was attempted.',
    STARTUP_FAILED: 'The local runtime could not start. Project records and the saved port were retained. Its error output was saved to daemon-stderr.log in the Arcane runtime folder for this project. No automatic retry was attempted.',
    STARTUP_TIMEOUT: 'The local runtime startup timed out after 30 seconds. Project records and the saved port were retained. No automatic retry was attempted.',
  });
  // Another live Arcane (a different build or profile window) already serves this project: never spawn a contender,
  // signal it or take its lock. Read-only: its daemon.json names a live pid whose loopback listener answers.
  if (await policy.liveRuntimeOwner(stateRoot)) throw startupFailure('PROJECT_IN_USE');
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
  // stdout carries the workspace token and stays ignored; stderr goes to a bounded log under the owned state root.
  const stderrLog = policy.daemonStderrLog(stateRoot);
  const owned = spawn(nodeExecutable, [entry], { cwd: userRoot, env, shell: false, windowsHide: true, stdio: ['ignore', 'ignore', stderrLog ? 'pipe' : 'ignore', 'ipc'] });
  if (stderrLog) { if (owned.stderr) stderrLog.attach(owned.stderr); else stderrLog.close(); }
  child = owned;
  attachDiagnosticChild(owned);
  let reportedFailure = null;
  const ready = await new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); owned.removeListener('error', fail); owned.removeListener('exit', fail); owned.removeListener('message', onMessage); };
    const timer = setTimeout(() => { cleanup(); reject(startupFailure(reportedFailure ?? 'STARTUP_TIMEOUT')); }, 30000);
    const fail = () => { cleanup(); reject(startupFailure(reportedFailure ?? 'STARTUP_FAILED')); };
    const onMessage = message => {
      if (child !== owned || origin) return;
      // The first valid report is kept until exit; it never establishes readiness or a retry.
      try { const code = policy.startupFailureMessage(message); reportedFailure ??= code; reportFailureOnce(reportedFailure); return; } catch { /* Not a failure report. */ }
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
  await startAppAssets(owned, projectSession);
  const handoffDirectory = await ownedDirectory(join(stateRoot, 'native-handoffs'));
  const handoffEpoch = projectSession;
  nativeHandoff = require('./native-handoff-host.cjs').createNativeHandoffHost({
    getSession: () => {
      if (smoke || closing || switching || !window || window.isDestroyed() || !origin || !token || projectSession !== handoffEpoch) return null;
      return { projectPath, runtimeDirectory: handoffDirectory, nodePath: nodeExecutable,
        mcpEntry: join(productRoot, 'dist/apps/mcp/src/main.js'), origin, controlToken: token, epoch: handoffEpoch };
    },
    getChoices: () => providerSetup?.getHandoffChoices() ?? null,
    confirm: (profile, session) => providerSetup.confirmHandoff(profile, session),
    launchTerminal: request => providerSetup.launchHandoffTerminal(request),
  });
  if (projectSession.verificationUnavailable) console.warn(CODE_VERIFICATION_WARNING);
  const adoptedAt = performance.now();
  owned.once('exit', (code, signal) => { if (child === owned && !closing && !switching) void runtimeStopped({ code, signal, uptimeMs: performance.now() - adoptedAt }); });
}
function installClipboardForWindow(owner) {
  policy.installClipboardPermissions(owner.webContents.session, () => ({ window: owner,
    origin: origin || runtimeRecovery?.preferences()?.origin || '', active: !closing && !switching && window === owner }));
}
/** Keep the previous document until the replacement has loaded with a live owned runtime. */
async function reloadRecoveredWorkspace() {
  const previous = window; if (!previous || previous.isDestroyed()) throw new Error('Workspace closed.');
  let replacement = null, timer = null, retired = false;
  const previousClosed = () => { if (!retired && !closing) app.quit(); };
  previous.once('closed', previousClosed);
  try {
    deferWindowShow = true;
    try { makeWindow(); replacement = window; } finally { deferWindowShow = false; }
    const rendererReady = runtimeRecovery.waitForRenderer(replacement);
    switching = false;
    const mounted = await Promise.race([Promise.all([loadWorkspace(), rendererReady]), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Workspace loading timed out.')), 30000); })]);
    if (!Array.isArray(mounted) || mounted[1] !== true || recoveryWindowFailure === replacement || closing || window !== replacement || replacement.isDestroyed() || !child || child.exitCode != null || child.signalCode != null) throw new Error('Runtime stopped while loading the workspace.');
    recoveryWindow = null; retired = true; previous.removeListener('closed', previousClosed);
    previous.destroy(); if (!smoke) replacement.show();
    void showCodeVerificationWarning();
  } catch (error) {
    const failed = replacement; if (failed) runtimeRecovery.cancelRenderer(failed);
    window = !previous.isDestroyed() ? previous : null; recoveryWindow = null;
    if (failed && failed !== previous && !failed.isDestroyed()) failed.destroy();
    if (window && !closing) { installClipboardForWindow(window); if (!smoke) window.show(); }
    throw error;
  } finally { if (timer) clearTimeout(timer); previous.removeListener('closed', previousClosed); }
}
function makeWindow() {
  window = new BrowserWindow({ width: 1512, height: 960, minWidth: 380, minHeight: 520, show: false, title: 'Arcane', backgroundColor: '#0b0b0d', autoHideMenuBar: true, icon: join(__dirname, 'icon.png'),
    // Arcane's top bar is the title bar: no classic caption; the native window buttons (snap layouts included) draw over its right end.
    titleBarStyle: 'hidden', titleBarOverlay: { color: '#200b0f', symbolColor: '#ffffff', height: 48 },
    webPreferences: { preload: join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, navigateOnDragDrop: false, spellcheck: false, devTools: !app.isPackaged, partition: 'arcane-workspace' } });
  const owner = window; if (deferWindowShow) { recoveryWindow = owner; recoveryWindowFailure = null; }
  const session = owner.webContents.session;
  installClipboardForWindow(owner);
  session.setDevicePermissionHandler(() => false);
  session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => callback({ cancel: !policy.requestAllowed(origin, details.url) }));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  for (const type of ['will-navigate', 'will-redirect', 'will-frame-navigate']) window.webContents.on(type, event => { if (!event.isMainFrame || !policy.navigationAllowed(origin, event.url)) event.preventDefault(); });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => {
    if (isMainFrame) { if (!inPlace) { runtimeRecovery?.invalidate(owner); if (window === owner) { clearHumanAssetSelection(); pyxBar?.reset(); } } if (window === owner) { nativeHandoff?.cancelPending(); providerSetup?.cancelPending(); } }
  });
  window.webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (isMainFrame) runtimeRecovery?.navigatedInPage(owner, url);
  });
  window.webContents.on('render-process-gone', () => {
    if (recoveryWindow === owner) { recoveryWindowFailure = owner; runtimeRecovery?.cancelRenderer(owner); return; }
    if (window === owner && !closing && !switching) void failStartup('The workspace renderer stopped. Restart Arcane to recover saved records.');
  });
  // A document change, crash or close answers any open in-app dialog with its cancel button and detaches the renderer.
  const dialogContents = window.webContents;
  dialogContents.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => { if (isMainFrame && !inPlace) appDialogs?.detach(dialogContents); });
  for (const type of ['render-process-gone', 'destroyed']) dialogContents.on(type, () => appDialogs?.detach(dialogContents));
  window.once('ready-to-show', () => { firstReadyMs = performance.now() - started; if (!smoke && window === owner && recoveryWindow !== owner) owner.show(); });
  window.on('page-title-updated', event => event.preventDefault());
  window.on('closed', () => { runtimeRecovery?.invalidate(owner); if (window === owner) { window = null; pyxBar?.reset(); pyxBar?.hide(); if (!switching && !closing) app.quit(); } });
}
async function showCodeVerificationWarning() {
  if (smoke || closing || !window || window.isDestroyed() || !projectSession?.verificationUnavailable) return;
  try { await dialog.showMessageBox(window, { type: 'warning', title: 'Luau verification unavailable', message: CODE_VERIFICATION_WARNING }); }
  catch { console.warn('Luau verification warning could not be displayed.'); }
}
async function loadWorkspace() {
  const owner = window, expectedOrigin = origin, expectedToken = token, expectedProject = projectSession;
  await owner.loadURL(expectedOrigin + '/studio#' + expectedToken);
  if (window !== owner || owner.isDestroyed() || closing || projectSession !== expectedProject || origin !== expectedOrigin || token !== expectedToken) throw new Error('Workspace changed during loading.');
  owner.setTitle('Arcane - ' + basename(projectPath).slice(0, 80));
  if (recoveryWindow !== owner) await showCodeVerificationWarning();
}
async function chooseProject() {
  if (switching || closing || !window || runtimeRecovery && runtimeRecovery.status().state !== 'ready') return;
  const selected = await dialog.showOpenDialog(window, { title: 'Open a local project', properties: ['openDirectory', 'dontAddToRecent'] });
  if (selected.canceled || selected.filePaths.length !== 1) return;
  let path; try { path = await policy.directPath(selected.filePaths[0]); } catch { await dialog.showMessageBox(window, { type: 'error', message: 'Choose a direct local folder, not a link or network directory.' }); return; }
  if (path === projectPath) return;
  const confirm = await dialog.showMessageBox(window, { type: 'question', title: 'Switch project', message: 'Stop this workspace and open the selected project?', detail: 'Active jobs and native connections will stop. Saved records are retained. No inference, Studio connection, write grant or upload starts automatically.', buttons: ['Cancel', 'Open project'], defaultId: 0, cancelId: 0 });
  if (confirm.response !== 1 || closing || switching || runtimeRecovery && runtimeRecovery.status().state !== 'ready') return;
  switching = true;
  pyxBar?.reset(); pyxBar?.hide();
  try {
    // Discard the previous renderer and credential before selecting a new project.
    const old = window; window = null; if (old && !old.isDestroyed()) old.destroy();
    void stopClaudeChat(); // children stop now; revocation runs beside the daemon shutdown
    if (!await stopDaemon()) throw new Error('Previous runtime did not close cleanly.');
    if (!await startProjectRuntime(path)) return;
    await startClaudeChat(); makeWindow(); await loadWorkspace();
    const pref = join(userRoot, 'last-project.json'); await policy.directPath(pref, 'file', true);
    await writeFile(pref, JSON.stringify({ version: 1, projectPath: path }) + '\n', { mode: 0o600 });
  } catch (error) { await failStartup(['ARCANE_PROJECT_PORT', 'ARCANE_STARTUP', 'ARCANE_PROJECT_IN_USE'].includes(error.code) ? error.message : 'Project switching failed. Previous records were retained; no automatic retry was attempted.'); }
  finally { switching = false; }
}
function installMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [{ label: 'Open project...', accelerator: 'CmdOrCtrl+O', click: () => void chooseProject() }, { type: 'separator' }, { label: 'Quit Arcane', accelerator: 'Alt+F4', click: () => app.quit() }] },
    { label: 'View', submenu: [{ label: 'Reload workspace', accelerator: 'CmdOrCtrl+R', click: () => { if (window && !switching && origin && token && (!runtimeRecovery || runtimeRecovery.status().state === 'ready')) window.webContents.reload(); } }, { role: 'togglefullscreen' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
    { label: 'Tool', submenu: [{ label: 'Configure Luau verification...', enabled: !smoke, click: () => {
      void codeVerification.configure().catch(() => { if (window && !closing && !switching) void dialog.showMessageBox(window,
        { type: 'error', title: 'Luau verification', message: 'Luau verification configuration is unavailable. Saved settings were retained.' }); });
    } }] },
    { label: 'Help', submenu: [{ label: 'About Arcane', click: () => { if (window) void dialog.showMessageBox(window, { type: 'info', title: 'Arcane', message: 'Arcane 0.1.0 - Local development preview', detail: 'Your tools. Your workspace.\nThis unsigned preview reads native sign-in status at startup and can reconnect a saved Codex login. Tasks use your selected account and model.' }); } }] }
  ]));
}
async function failStartup(message) {
  providerSetup?.dispose(); pyxBar?.dispose(); void stopClaudeChat();
  if (closing) return; closing = true; appDialogs?.dispose(); trustedDialogs?.dispose();
  if (!smoke) { try { await dialog.showMessageBox({ type: 'error', title: 'Arcane could not continue', message }); } catch { /* Shutdown still releases the owned diagnostic store. */ } }
  else if (smokeRoot) { try { await writeFile(join(smokeRoot, 'error.json'), JSON.stringify({ version: 1, error: message }) + '\n', { flag: 'wx' }); } catch {} }
  try { await stopDaemon(); } catch { /* Preserve the original startup failure. */ }
  await exitAfterDiagnostics(1);
}
/** Start a project's runtime; when another open Arcane already owns it, ask in a trusted Arcane window (not a native box)
 * to try again or quit. Never closes the other instance or takes over its lock. Resolves false when the person quits. */
async function startProjectRuntime(project) {
  for (;;) {
    try { await startDaemon(project); return true; }
    catch (error) {
      if (error?.code !== 'ARCANE_PROJECT_IN_USE' || smoke || closing) throw error;
      await stopDaemon();
      const config = { type: 'warning', title: 'Arcane is already open', message: 'Arcane is already open for this project in another window.',
        detail: 'Switch to it, or close it and try again. If you just closed it, wait a moment for it to finish saving. Arcane never closes the other window or takes over its project.',
        buttons: ['Quit', 'Try again'], defaultId: 1, cancelId: 0, noLink: true };
      let choice; try { choice = trustedDialogs ? await trustedDialogs.showStandalone(config) : await nativeDialog.showMessageBox(config); } catch { choice = { response: 0 }; }
      if (closing) return false;
      if (choice?.response !== 1) { await quitStartup(); return false; }
    }
  }
}
async function quitStartup() {
  providerSetup?.dispose(); void stopClaudeChat();
  if (closing) return; closing = true; appDialogs?.dispose(); trustedDialogs?.dispose();
  let code = 0; try { await stopDaemon(); } catch { code = 1; }
  await exitAfterDiagnostics(code);
}
async function runtimeStopped(info) {
  if (smoke) return failStartup('The local runtime stopped. Your project records have been retained.');
  if (closing || switching) return;
  try { if (await runtimeRecovery?.stopped(info) === false && !closing) await failStartup('Local services stopped before the workspace opened. Saved records were retained. Restart Arcane to try again.'); }
  catch { console.warn('Local service recovery is unavailable. Keep this workspace open.'); }
}
// Smoke only: read-only checks of packaged host inputs. The Studio plugin check uses a separate installer pointed at an
// empty folder inside the smoke root, so it verifies the bundled plugin build without touching Roblox Studio or writing files.
async function smokePackagedFeatures() {
  const load = async path => import(require('node:url').pathToFileURL(join(productRoot, path)).href);
  const result = { bundledPluginVerified: false, plansConfigValid: false, chatInstructionsBundled: false, trustedDialogBundled: false };
  try {
    const plugin = await require('./plugin-install.cjs').createStudioPluginInstaller({ productRoot, pluginsDirectory: join(smokeRoot, 'studio-plugins-empty'),
      confirm: async () => false }).status();
    result.bundledPluginVerified = plugin.state === 'missing' && typeof plugin.pluginVersion === 'string';
  } catch {}
  try { const plans = await load('dist/packages/protocol/src/plans.js'); plans.validatePlansConfig(plans.ARCANE_PLANS); result.plansConfigValid = true; } catch {}
  try {
    const { TRUSTED_DIALOG_PAGE_FILES } = require('./trusted-dialog.cjs');
    for (const file of [...TRUSTED_DIALOG_PAGE_FILES, 'trusted-dialog-preload.cjs']) await policy.directPath(join(__dirname, file), 'file');
    result.trustedDialogBundled = !!trustedDialogs && !!appDialogs;
  } catch {}
  try { const tools = await load('dist/packages/protocol/src/arcane-tools.js'); result.chatInstructionsBundled = typeof tools.ARCANE_TASK_INSTRUCTIONS === 'string' && tools.ARCANE_TASK_INSTRUCTIONS.length > 0; } catch {}
  return result;
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
    nativeHandoffMounted: !!window.arcaneDesktop?.nativeHandoff && Object.isFrozen(window.arcaneDesktop.nativeHandoff) &&
      document.getElementById('native-handoff-panel')?.getAttribute('aria-busy') === 'false' &&
      document.getElementById('native-handoff-launch')?.disabled === true && document.getElementById('native-handoff-model')?.value === '' &&
      document.getElementById('native-handoff-effort')?.value === '',
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
  const taskStatusModules = await window.webContents.executeJavaScript(`(async () => {
    for (const path of ['/task-plan-boot.js', '/codex-task-plan.js']) {
      const response = await fetch(path, { cache: 'no-store', credentials: 'omit', redirect: 'error' });
      if (response.status !== 200 || !/^text\\/javascript(?:;|$)/i.test(response.headers.get('content-type') || '')) return false;
      if ((await response.text()).length > 262144) return false;
    }
    const boot = await import('/task-plan-boot.js'), card = await import('/codex-task-plan.js');
    return typeof boot.startTaskPlanCard === 'function' && typeof card.TaskPlanCard?.mount === 'function';
  })()`);
  const workspacePreferenceRead = await window.webContents.executeJavaScript('window.arcaneDesktop.workspacePreferences.read()');
  const claudePreferenceRead = await window.webContents.executeJavaScript('window.arcaneDesktop.claudePreferences.read()');
  const toolDraftRead = await window.webContents.executeJavaScript('window.arcaneDesktop.toolDrafts.read()');
  const runtimeRecoveryRead = await window.webContents.executeJavaScript('(async()=>{const bridge=window.arcaneDesktop.runtimeRecovery;return {frozen:Object.isFrozen(bridge),status:await bridge.status()};})()');
  // Newer desktop bridges: frozen shape plus the verification-mode answer of each read-only or disabled call. In smoke the
  // hosts are disabled, so no Claude process, folder picker, browser, checkout or system notification can start.
  const desktopBridges = JSON.parse(await window.webContents.executeJavaScript(`(async () => {
    const d = window.arcaneDesktop || {};
    const shaped = (bridge, names) => !!bridge && Object.isFrozen(bridge) && bridge.version === 1 && names.every(name => typeof bridge[name] === 'function');
    const settle = async call => { try { return { ok: true, value: await call() }; } catch (error) { return { ok: false, message: String(error && error.message || '') }; } };
    const chat = shaped(d.claudeChat, ['status','list','history','send','rewind','stop','remove','onEvent']) ? await settle(() => d.claudeChat.status()) : null;
    const arcane = shaped(d.arcaneChat, ['status','list','history','send','rewind','stop','remove','onEvent']) ? await settle(() => d.arcaneChat.status()) : null;
    const plugin = shaped(d.studioPlugin, ['status','install']) ? await settle(() => d.studioPlugin.status()) : null;
    const project = shaped(d.workspaceProject, ['open']) ? await settle(() => d.workspaceProject.open()) : null;
    const permissions = shaped(d.projectPermissions, ['read','save']) ? await settle(() => d.projectPermissions.read()) : null;
    const billing = shaped(d.billing, ['status','openCheckout']) ? await settle(() => d.billing.status()) : null;
    const notice = shaped(d.notifications, ['notify','onActivate']) ? await settle(() => d.notifications.notify({ kind: 'finished', body: 'Arcane smoke check.', target: 'arcane-smoke' })) : null;
    const updates = shaped(d.updates, ['status','restart']) ? await settle(() => d.updates.status()) : null;
    const keep = shaped(d.meshKeep, ['keep']) ? await settle(() => d.meshKeep.keep({ digest: '0'.repeat(64), sessionId: 'arcane-smoke' })) : null;
    return JSON.stringify({
      claudeChat: !!chat && chat.ok === false,
      arcaneChat: !!arcane && arcane.ok === false,
      studioPlugin: !!plugin && plugin.ok && plugin.value.state === 'unavailable' && plugin.value.message === 'Studio plugin setup is disabled in verification mode.',
      workspaceProject: !!project && project.ok === false && project.message === 'The project picker is unavailable.',
      dialogs: shaped(d.dialogs, ['attach','reply']),
      projectPermissions: !!permissions && permissions.ok && permissions.value.available === false,
      billing: !!billing && billing.ok && billing.value.state === 'not-connected' && billing.value.account === 'unavailable',
      notifications: !!notice && notice.ok && notice.value.shown === false,
      updates: !!updates && updates.ok && updates.value.state === 'unavailable',
      meshKeep: !!keep && keep.ok && keep.value.state === 'unavailable'
    });
  })()`));
  const packagedFeatures = await smokePackagedFeatures();
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
    taskStatusModules: taskStatusModules === true,
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
    runtimeRecoveryDisabledAndEmpty: runtimeRecoveryRead?.frozen === true && runtimeRecoveryRead.status?.version === 1 && runtimeRecoveryRead.status.state === 'unavailable' && runtimeRecoveryRead.status.message === '',
    claudePreferencesDisabledAndEmpty: claudePreferenceRead?.available === false && claudePreferenceRead.projectPath === null && claudePreferenceRead.preferences === null,
    toolDraftsDisabledAndEmpty: toolDraftRead?.available === false && toolDraftRead.projectPath === null && toolDraftRead.preferences === null,
    localChatDraftSwitching: localChat.draftsSeparate === true && localChat.stableComposer === true && localChat.cleaned === true,
    taskUsageHiddenWithoutTask: localChat.taskUsageInactive === true,
    localChatIntentsStartNoNativeLifecycle: afterChatResponse.ok && afterChat.state?.snapshot === null && afterChat.state.actions?.length === 0,
    optionalCodeVerificationFailureContained: !projectSession.verificationUnavailable ||
      (projectSession.activeSettingsHash === null && projectSession.verificationEnvironmentAbsent),
    externalNavigationRejected: !policy.navigationAllowed(origin, 'https://example.com/') && !policy.requestAllowed(origin, 'file:///C:/Windows/win.ini'),
    nativeLifecycleNotStarted: renderer.modelOptions <= 1,
    conversationOnlyDefault:renderer.conversationOnly === true,providerSetupMounted:renderer.providerSetupMounted === true,
    nativeHandoffMounted: renderer.nativeHandoffMounted === true,
    claudeChatBridgeDisabledInSmoke: desktopBridges.claudeChat === true,
    arcaneChatBridgeDisabledInSmoke: desktopBridges.arcaneChat === true,
    studioPluginBridgeDisabledInSmoke: desktopBridges.studioPlugin === true,
    workspaceProjectBridgeDisabledInSmoke: desktopBridges.workspaceProject === true,
    inAppDialogsBridgeMounted: desktopBridges.dialogs === true,
    projectPermissionsBridgeDisabledInSmoke: desktopBridges.projectPermissions === true,
    billingBridgeNotConnectedInSmoke: desktopBridges.billing === true,
    notificationsBridgeSilentInSmoke: desktopBridges.notifications === true,
    desktopUpdatesUnavailableInSmoke: desktopBridges.updates === true,
    meshKeepBridgeUnavailableInSmoke: desktopBridges.meshKeep === true,
    bundledStudioPluginVerified: packagedFeatures.bundledPluginVerified === true,
    bundledPlansConfigValid: packagedFeatures.plansConfigValid === true,
    bundledChatInstructionsLoadable: packagedFeatures.chatInstructionsBundled === true,
    trustedDecisionDialogsBundled: packagedFeatures.trustedDialogBundled === true,
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
  closing = true; await exitAfterDiagnostics(Object.values(checks).every(Boolean) ? 0 : 1);
}
if (profilePreparationFailed) app.whenReady().then(() => failStartup('Arcane application data could not be opened safely. No project or provider was started.'));
else if (!locked) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.on('before-quit', event => { if (!closing) { event.preventDefault(); closing = true; providerSetup?.dispose(); pyxBar?.dispose(); void Promise.all([stopClaudeChat(), stopDaemon()]).then(([, clean]) => exitAfterDiagnostics(clean ? 0 : 1)).catch(() => exitAfterDiagnostics(1)); } });
  app.on('window-all-closed', () => { if (!switching && !closing) app.quit(); });
  app.whenReady().then(async () => {
    try {
      nativeTheme.themeSource = 'dark';
      runtimeRecovery = require('./runtime-recovery.cjs').createRuntimeRecovery({ enabled: !smoke,
        getContext: () => ({ window, project: projectSession, userRoot, origin, closing, switching }),
        setBusy: value => { switching = value; }, delay: sleep,
        retire: async () => { appDialogs?.detach(window?.webContents); const chats = stopClaudeChat('interrupted'); await Promise.all([stopDaemon(), chats]); },
        start: async () => { await startDaemon(projectPath); await startClaudeChat(); },
        reload: reloadRecoveredWorkspace,
        running: () => !!child && child.exitCode == null && child.signalCode == null,
        confirm: async () => {
          const owner = window; if (closing || !owner || owner.isDestroyed()) return false;
          const result = await dialog.showMessageBox(owner, { type: 'warning', title: 'Arcane services stopped',
            message: 'Restart local services to continue?', detail: 'Arcane will save your workspace drafts first. Running replies are interrupted; messages and tool calls are not sent again automatically.',
            buttons: ['Keep window open', 'Restart local services'], defaultId: 1, cancelId: 0, noLink: true });
          return result.response === 1 && !closing && window === owner;
        } });
      runtimeRecovery.installIpc(ipcMain, rendererEvent);
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
        if (closing || switching || !window || !projectSession || !origin || !token || !userRoot) return runtimeRecovery?.preferences() ?? null;
        return { ...projectSession, window, origin, userRoot, epoch: projectSession };
      } });
      workspacePreferences.installIpc(ipcMain);
      conversationLibrary = require('./workspace-preferences.cjs').createWorkspacePreferences({ safeStorage, enabled: !smoke, record: 'library', getSession: () => {
        if (closing || switching || !window || !projectSession || !origin || !token || !userRoot) return runtimeRecovery?.preferences() ?? null;
        return { ...projectSession, window, origin, userRoot, epoch: projectSession };
      } });
      conversationLibrary.installIpc(ipcMain);
      codexQueuePreferences = require('./workspace-preferences.cjs').createWorkspacePreferences({ safeStorage, enabled: !smoke, record: 'queue-codex', getSession: () => {
        if (closing || switching || !window || !projectSession || !origin || !token || !userRoot) return runtimeRecovery?.preferences() ?? null;
        return { ...projectSession, window, origin, userRoot, epoch: projectSession };
      } });
      codexQueuePreferences.installIpc(ipcMain);
      claudeQueuePreferences = require('./workspace-preferences.cjs').createWorkspacePreferences({ safeStorage, enabled: !smoke, record: 'queue-claude', getSession: () => {
        if (closing || switching || !window || !projectSession || !origin || !token || !userRoot) return runtimeRecovery?.preferences() ?? null;
        return { ...projectSession, window, origin, userRoot, epoch: projectSession };
      } });
      claudeQueuePreferences.installIpc(ipcMain);
      claudePreferences = require('./workspace-preferences.cjs').createWorkspacePreferences({ safeStorage, enabled: !smoke, record: 'claude', getSession: () => {
        if (closing || switching || !window || !projectSession || !origin || !token || !userRoot) return runtimeRecovery?.preferences() ?? null;
        return { ...projectSession, window, origin, userRoot, epoch: projectSession };
      } });
      claudePreferences.installIpc(ipcMain);
      toolDrafts = require('./workspace-preferences.cjs').createWorkspacePreferences({ safeStorage, enabled: !smoke, record: 'tools', getSession: () => {
        if (closing || switching || !window || !projectSession || !origin || !token || !userRoot) return runtimeRecovery?.preferences() ?? null;
        return { ...projectSession, window, origin, userRoot, epoch: projectSession };
      } });
      toolDrafts.installIpc(ipcMain);
      // One-click Studio plugin install/update: verified bundled artifact only, after a native confirm dialog.
      studioPlugin = require('./plugin-install.cjs').createStudioPluginInstaller({ enabled: !smoke, productRoot: () => productRoot,
        backupDirectory: () => userRoot ? join(userRoot, 'plugin-backups') : null, preferenceDirectory: () => userRoot ?? null,
        confirm: async request => {
          const owner = window; if (closing || switching || !owner || owner.isDestroyed()) return false;
          const choice = await dialog.showMessageBox(owner, { type: 'question', title: request.title, message: request.message, detail: request.detail,
            buttons: ['Cancel', request.confirmLabel], defaultId: 0, cancelId: 0, noLink: true });
          return choice.response === 1 && !closing && !switching && window === owner;
        } });
      studioPlugin.installIpc(ipcMain, { trusted: rendererEvent });
      // Setup checklist "Open project": the same native picker and confirm as File > Open project.
      ipcMain.handle('arcane:project-open', async (event, ...args) => {
        if (smoke || args.length || !rendererEvent(event)) throw new Error('The project picker is unavailable.');
        void chooseProject(); return { requested: true };
      });
      trustedDialogs = require('./trusted-dialog.cjs').createTrustedDialogs({ BrowserWindow, native: nativeDialog, getWindow: () => closing || switching ? null : window });
      trustedDialogs.installIpc(ipcMain);
      appDialogs = require('./in-app-dialog.cjs').createInAppDialogs({ native: nativeDialog, getWindow: () => closing || switching ? null : window, trusted: rendererEvent,
        decisions: trustedDialogs.showMessageBox });
      appDialogs.installIpc(ipcMain);
      projectPermissions = require('./project-permissions.cjs').createProjectPermissions({ enabled: !smoke,
        getSession: () => closing || switching || !projectSession ? null : { stateRoot: projectSession.stateRoot, epoch: projectSession } });
      // Turning a switch ON grants authority, so the host asks in the trusted decision window first; OFF needs no question.
      projectPermissions.installIpc(ipcMain, { trusted: rendererEvent, confirmEnable: async keys => {
        const owner = window; if (closing || switching || !owner || owner.isDestroyed()) return false;
        const lines = keys.map(key => key === 'claudeTools' ? 'Claude chat will use Arcane project tools without asking each time.' : 'In-project edits and commands will be approved automatically.');
        const choice = await dialog.showMessageBox(owner, { type: 'warning', title: 'Turn on automatic approval', message: 'Let Arcane act without asking in this project?',
          detail: lines.join('\n\n') + '\n\nYou can turn this off again in Settings > Permissions.', buttons: ['Cancel', 'Turn on'], defaultId: 0, cancelId: 0, noLink: true });
        return choice.response === 1 && !closing && !switching && window === owner;
      } });
      // Switching Claude tools to "ask" revokes this session's consent and its shared credential immediately (Arcane chat too).
      projectPermissions.subscribe(next => { if (!next.claudeTools) { claudeChat?.revokeApproval?.(); arcaneChat?.revokeApproval?.(); } });
      // Plans & credits checkout: one offer id in; the host builds the URL from the shipped plans config and the local
      // billing-service.json (billing.cjs), checks the exact https allowlist, confirms in an Arcane dialog, then opens the browser.
      // Connect Arcane account stays unavailable unless a gateway URL is allowlisted; its token is kept with safeStorage.
      billing = require('./billing.cjs').createBilling({ enabled: !smoke, dialog, shell, safeStorage, getWindow: () => closing || switching ? null : window,
        configDirectory: () => userRoot ?? null,
        loadPlans: async () => productRoot ? (await import(require('node:url').pathToFileURL(join(productRoot, 'dist/packages/protocol/src/plans.js')).href)).ARCANE_PLANS : null,
      });
      billing.installIpc(ipcMain, { trusted: rendererEvent });
      // Build-done notifications: fixed titles and a bounded body, only while the window is not focused; click focuses it.
      require('./build-notifications.cjs').createBuildNotifications({ enabled: !smoke, Notification,
        getWindow: () => closing || switching ? null : window }).installIpc(ipcMain, { trusted: rendererEvent });
      // Pyx pop-out bar: a small always-on-top window whose preload exposes arcaneDesktop.pyx only. Its intents are relayed to
      // the workspace renderer, which uses the main composer's own controls (pyx-link.ts); the bar holds no token.
      pyxBar = require('./pyx-bar-host.cjs').createPyxBar({ BrowserWindow, screen, preload: join(__dirname, 'pyx-preload.cjs'), devTools: !app.isPackaged,
        getMain: () => closing || switching ? null : window, getOrigin: () => origin,
        available: () => !smoke && !closing && !switching && !!window && !window.isDestroyed() && policy.validOrigin(origin),
        store: require('./pyx-bar-host.cjs').createPositionStore(() => smoke ? null : userRoot) }); // where the user dragged it, per display (pyx-bar.v1.json)
      pyxBar.installIpc(ipcMain, { trusted: rendererEvent });
      // The native window buttons draw over the top bar; their background follows the surface shown (the workspace bar or
      // the near-black sign-in page) so they never sit on a mismatched block. Two fixed colours; the renderer only picks one.
      ipcMain.on('arcane:titlebar-tone', (event, tone) => {
        if (!rendererEvent(event) || (tone !== 'workspace' && tone !== 'page') || !window || window.isDestroyed() || typeof window.setTitleBarOverlay !== 'function') return;
        try { window.setTitleBarOverlay({ color: tone === 'page' ? '#0b0a0b' : '#200b0f', symbolColor: '#ffffff', height: 48 }); } catch { /* The buttons keep their colour. */ }
      });
      // Keep this mesh: the host asks in the trusted decision window (account, asset name, upload quota) and only then hands
      // the daemon a single-use consent over the private child IPC channel. Never automatic, never from a model.
      require('./mesh-keep.cjs').createMeshKeepHost({ enabled: !smoke,
        getSession: () => closing || switching || !window || !origin || !token || !child || !child.connected ? null :
          { window, origin, token, send: message => { if (!child || !child.connected) throw new Error('Runtime unavailable.'); child.send(message); } },
        confirm: async request => {
          const owner = window; if (closing || switching || !owner || owner.isDestroyed()) return false;
          const choice = await dialog.showMessageBox(owner, { type: 'warning', title: request.title, message: request.message, detail: request.detail,
            buttons: ['Cancel', request.confirmLabel], defaultId: 0, cancelId: 0, noLink: true });
          return choice.response === 1 && !closing && !switching && window === owner;
        } }).installIpc(ipcMain, { trusted: rendererEvent });
      // Importing models and effects: the native file picker, or files dropped on the preview. This host checks and reads
      // each file, then hands the bytes to the daemon with a single-use consent over the private child IPC channel.
      require('./asset-import.cjs').createAssetImportHost({ enabled: !smoke, dialog,
        getSession: () => closing || switching || !window || !origin || !token || !child || !child.connected ? null :
          { window, origin, token, send: message => { if (!child || !child.connected) throw new Error('Runtime unavailable.'); child.send(message); } },
      }).installIpc(ipcMain, { trusted: rendererEvent });
      require('./desktop-updates.cjs').createDesktopUpdates({ enabled: !smoke && !!process.env.LOCALAPPDATA,
        development: !app.isPackaged,
        installRoot: join(process.env.LOCALAPPDATA ?? app.getPath('userData'), 'Arcane', 'Desktop'),
        currentDirectory: resolve(app.getPath('exe'), '..'),
        productRoot: app.isPackaged ? join(process.resourcesPath, 'product') : resolve(__dirname, '../../..'),
        getContext: () => ({ window, epoch: projectSession, origin, token }),
        available: () => !closing && !switching && !!window && !window.isDestroyed(),
        restart: async executable => {
          if (closing || switching || !window || window.isDestroyed()) return false;
          switching = true;
          try {
            const [, clean] = await Promise.all([stopClaudeChat(), stopDaemon()]);
            if (!clean || !await closeDiagnostics()) { switching = false; return false; }
            providerSetup?.dispose();
            app.relaunch({ execPath: executable, args: [] });
            closing = true; setTimeout(() => app.exit(0), 100); return true;
          } catch { switching = false; return false; }
        } }).installIpc(ipcMain, { trusted: rendererEvent });
      ipcMain.handle('arcane:asset-conversation-select', selectHumanAssetConversation);
      require('./claude-chat.cjs').installClaudeChatIpc(ipcMain, {
        getSession: () => smoke || closing || switching || !window || !projectSession || !origin || !token || !claudeChat ? null : { window, origin, epoch: projectSession },
        getHost: () => claudeChat ?? null,
      });
      require('./arcane-chat.cjs').installArcaneChatIpc(ipcMain, {
        getSession: () => smoke || closing || switching || !window || !projectSession || !origin || !token || !arcaneChat ? null : { window, origin, epoch: projectSession },
        getHost: () => arcaneChat ?? null,
      });
      require('./native-handoff-ipc.cjs').installNativeHandoffIpc(ipcMain, {
        getSession: () => smoke || closing || switching || !window || !projectSession || !origin || !token || !nativeHandoff ? null :
          { window, origin, epoch: projectSession },
        host: Object.fromEntries(['launch', 'list', 'revoke'].map(action => [action, (...args) => {
          if (!nativeHandoff) throw new Error('Native handoff is unavailable.');
          return nativeHandoff[action](...args);
        }])),
      });
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
      initializeDiagnostics(); // Asynchronous best-effort storage; diagnostics never blocks opening a workspace.
      const defaultProject = await ownedDirectory(join(userRoot, 'projects', 'Untitled')); let selected = defaultProject;
      try {
        const pref = join(userRoot, 'last-project.json'); await policy.directPath(pref, 'file'); const bytes = await readFile(pref);
        if (bytes.length > 8192) throw new Error('Project preference too large.'); const saved = JSON.parse(bytes.toString('utf8'));
        if (Object.keys(saved).sort().join(',') !== 'projectPath,version' || saved.version !== 1) throw new Error('Invalid project preference.'); selected = await policy.directPath(saved.projectPath);
      } catch (error) { if (error.code !== 'ENOENT' && !smoke) await dialog.showMessageBox({ type: 'warning', title: 'Saved project unavailable', message: 'Starting an empty local project. The saved preference was preserved; use File > Open project to choose a folder.' }); }
      if (!await startProjectRuntime(selected)) return;
      await startClaudeChat(); makeWindow(); installMenu(); await loadWorkspace(); if (customerCheck) customerCheck.start(); if (smoke) await checkSmoke();
    } catch (error) { await failStartup(['ARCANE_PROJECT_PORT', 'ARCANE_STARTUP', 'ARCANE_PROJECT_IN_USE'].includes(error.code) ? error.message : 'Startup failed. Verify the complete app folder is present and its runtime is permitted by Windows. No security settings were changed.'); }
  });
}
