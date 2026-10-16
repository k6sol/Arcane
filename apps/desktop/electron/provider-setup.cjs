'use strict';

// Main-process capability only. Import and construction have no native side effects.
const nativeFs = require('node:fs/promises');
const nativePath = require('node:path');
const nativeSpawn = require('node:child_process').spawn;
const os = require('node:os');
const PAGES = Object.freeze({
  codex: 'https://learn.chatgpt.com/docs/codex/cli',
  claude: 'https://code.claude.com/docs/en/setup',
});
const DISABLED = 'CLI setup checks are disabled in verification mode.';
const MAX_BYTES = 16384;
// Claude `--help` is longer than the status helpers (2.1.177: 15,388 bytes); it gets its own fixed bound.
const HELP_MAX_BYTES = 65536;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const EFFORT_ORDER = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const HANDOFF_CREDENTIAL = /^[A-Za-z0-9_-]{43}$/;
const HANDOFF_DAEMON = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/;
const fail = () => { throw new Error('Provider setup request is unavailable.'); };
/** Exact plain own data fields; proxies are refused before any trap and accessors are never invoked. */
function plainFields(value, keys) {
  const { types } = require('node:util');
  if (!value || typeof value !== 'object' || types.isProxy(value)) fail();
  const prototype = Object.getPrototypeOf(value), own = Reflect.ownKeys(value);
  if (prototype !== Object.prototype && prototype !== null || own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) fail();
  const out = Object.create(null);
  for (const key of keys) { const field = Object.getOwnPropertyDescriptor(value, key); if (!field || !Object.hasOwn(field, 'value')) fail(); out[key] = field.value; }
  return out;
}
/** Native CLI aliases/efforts from the fixed `--help` paragraphs (the catalogue.ts claudeModelsFromHelp logic).
 * Help text is CLI metadata, never per-account entitlement; no default is chosen. */
function parseClaudeChoices(result, cliVersion) {
  if (!result.ok || result.code !== 0 || typeof result.stdout !== 'string') return null;
  const help = result.stdout.replace(/\r\n/g, '\n');
  const modelParagraph = /--model\s+<model>([\s\S]*?)(?:\n\s{2}--|\n\s{2}-[a-z])/m.exec(help)?.[1] ?? '';
  const aliases = [...new Set([...modelParagraph.matchAll(/'([a-z][a-z0-9-]+)'/g)].map(m => m[1]).filter(v => !v.startsWith('claude-')))];
  const effortParagraph = /--effort\s+<level>([\s\S]*?)(?:\n\s{2}--|\n\s{2}-[a-z])/m.exec(help)?.[1] ?? '';
  const efforts = EFFORT_ORDER.filter(e => new RegExp('\\b' + e + '\\b').test(effortParagraph));
  if (!aliases.length || aliases.length > 32 || aliases.some(alias => alias.length > 64) || !efforts.length) return null;
  return Object.freeze({ cliVersion, aliases: Object.freeze(aliases), efforts: Object.freeze(efforts) });
}

function createProviderSetup(options) {
  if (!options || typeof options.getWindow !== 'function' || typeof options.getOrigin !== 'function' ||
      typeof options.getProjectPath !== 'function' || (options.enabled !== undefined && typeof options.enabled !== 'boolean')) fail();
  // These seams are supplied by trusted main-process code, never IPC payloads.
  const fs = options.fs ?? nativeFs, spawn = options.spawn ?? nativeSpawn;
  const enabled = options.enabled !== false;
  const platform = options.platform ?? process.platform, arch = options.arch ?? process.arch;
  const p = platform === 'win32' ? nativePath.win32 : nativePath.posix;
  const env = { ...(options.env ?? process.env) };
  const home = options.homedir ?? (() => os.homedir());
  const timeoutMs = options.timeoutMs ?? 8000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000) fail();
  const loginTimeoutMs = options.loginTimeoutMs ?? 180000;
  if (!Number.isInteger(loginTimeoutMs) || loginTimeoutMs < 1 || loginTimeoutMs > 300000) fail();
  const snapshots = new Map(['codex', 'claude'].map(provider => [provider, {
    version: 1, provider, installed: false, auth: 'unknown', cliVersion: null, busy: false, message: null,
  }]));
  let active = false, ownedLogin = null, disposed = false, epoch = 0, claudeMetadataScope = null;
  const copy = provider => Object.freeze({ ...snapshots.get(provider), busy: active || !!ownedLogin?.session.status().pending });
  const update = (provider, values) => snapshots.set(provider, { ...snapshots.get(provider), ...values });
  function providerArgument(args) {
    if (args.length !== 1 || (args[0] !== 'codex' && args[0] !== 'claude')) fail();
    return args[0];
  }
  function absolute(value) {
    if (typeof value !== 'string' || !value || value !== value.trim() || CONTROL.test(value) ||
        Buffer.byteLength(value) > 2048 || !p.isAbsolute(value)) fail();
    if (platform === 'win32' && (!/^[a-z]:[\\/]/i.test(value) || /[<>"|?*]/.test(value) || value.slice(2).includes(':') ||
        value.split(/[\\/]/).slice(1).some(part => /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))) fail();
    return p.normalize(value);
  }
  const equal = (a, b) => platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  function inside(directory, value) {
    const relative = p.relative(directory, value);
    return !relative || (!p.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + p.sep));
  }
  async function checked(value, kind) {
    const input = absolute(value), full = absolute(await fs.realpath(input)), stat = await fs.stat(full);
    if (kind === 'directory' ? !stat.isDirectory() : !stat.isFile()) fail();
    if (kind === 'file' && platform !== 'win32' && !(stat.mode & 0o111)) fail();
    return full;
  }
  function context() {
    const window = options.getWindow(), origin = options.getOrigin();
    if (!window || typeof window.isDestroyed !== 'function' || window.isDestroyed() || typeof origin !== 'string') fail();
    const url = new URL(origin);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        !url.port || url.origin !== origin || url.username || url.password) fail();
    return { window, origin, project: options.getProjectPath(), epoch };
  }
  function stillCurrent(scope) {
    if (disposed) fail();
    const current = context();
    if (current.window !== scope.window || current.origin !== scope.origin || current.project !== scope.project || current.epoch !== scope.epoch) fail();
  }
  function nativeEnvironment() {
    // No Arcane authority, provider keys/tokens, injected runtimes, or proxy routing.
    // Authentication remains in vendor-owned storage and the native vendor UI.
    const output = {};
    const names = ['SystemRoot', 'WINDIR', 'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA',
      'APPDATA', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'DISPLAY', 'XAUTHORITY',
      'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'];
    for (const name of names) {
      const key = Object.keys(env).find(key => key.toLowerCase() === name.toLowerCase());
      const value = key === undefined ? undefined : env[key];
      if (typeof value === 'string' && !CONTROL.test(value) && Buffer.byteLength(value) <= 4096) output[name] = value;
    }
    // Retain absolute directories only; never let the child's cwd resolve a tool.
    output.PATH = pathDirectories().join(p.delimiter);
    return output;
  }
  function pathDirectories() {
    const raw = env.PATH ?? env.Path ?? '';
    if (typeof raw !== 'string' || raw.length > 32768) return [];
    const entries = raw.split(p.delimiter);
    if (entries.length > 64) return [];
    const directories = [];
    for (let entry of entries) {
      if (entry.startsWith('"') && entry.endsWith('"')) entry = entry.slice(1, -1);
      try { const full = absolute(entry); if (!directories.some(item => equal(item, full))) directories.push(full); } catch { /* Reject relative, empty and device paths. */ }
    }
    return directories;
  }
  async function locate(provider, scope) {
    const filename = provider + (platform === 'win32' ? '.exe' : '');
    let project = null;
    if (scope.project) project = await checked(scope.project, 'directory');
    const candidate = async value => {
      try {
        const full = await checked(value, 'file');
        if ((project && inside(project, full)) || (platform === 'win32' && p.basename(full).toLowerCase() !== filename)) return null;
        return full;
      } catch { return null; }
    };
    const directories = pathDirectories();
    for (const directory of directories) { const full = await candidate(p.join(directory, filename)); if (full) return full; }
    // Official native user installer locations; never inspect auth/config contents.
    const userHome = absolute(home());
    const userBin = await candidate(p.join(userHome, '.local', 'bin', filename));
    if (userBin) return userBin;
    if (provider === 'codex' && platform === 'win32' && env.LOCALAPPDATA) {
      const root = p.join(absolute(env.LOCALAPPDATA), 'OpenAI', 'Codex', 'bin');
      const found = []; let count = 0;
      try {
        const directory = await fs.opendir(root);
        for await (const entry of directory) {
          if (++count > 32) return null;
          if (!entry.isDirectory() || !/^[a-f0-9]{16}$/.test(entry.name)) continue;
          const full = await candidate(p.join(root, entry.name, filename));
          if (full) found.push(full);
        }
      } catch { /* Native desktop install may be absent. */ }
      // An opaque build ID is not a version; do not guess which build is current.
      if (found.length === 1) return found[0];
      if (found.length > 1) return null;
    }
    // Invoke npm's native payload directly, never .cmd/.ps1/JS wrappers or npm.
    if (provider === 'codex' && platform === 'win32' && ['x64', 'arm64'].includes(arch)) {
      const triple = arch === 'x64' ? 'x86_64-pc-windows-msvc' : 'aarch64-pc-windows-msvc';
      for (const directory of directories) {
        const packageRoot = p.join(directory, 'node_modules', '@openai');
        for (const root of [p.join(packageRoot, 'codex', 'node_modules', '@openai', 'codex-win32-' + arch),
          p.join(packageRoot, 'codex-win32-' + arch), p.join(packageRoot, 'codex')]) {
          const full = await candidate(p.join(root, 'vendor', triple, 'codex', 'codex.exe'));
          if (full) return full;
        }
      }
    }
    return null;
  }
  // Bounded one-shot helpers only. Raw output never escapes this closure.
  // `overlay` is used ONLY by the scoped handoff launcher: a fixed env addition for that one spawn, never argv/logs.
  function run(command, args, cwd, capture = true, overlay = null, maxBytes = MAX_BYTES) {
    return new Promise(resolve => {
      let child, done = false, bytes = 0, stdout = [], stderr = [];
      const finish = (ok, code = null, timedOut = false) => {
        if (done) return;
        done = true; clearTimeout(timer);
        if (!ok) { try { child?.kill('SIGKILL'); } catch { /* Closed child. */ } }
        resolve({ ok, code, timedOut, stdout: ok ? Buffer.concat(stdout).toString('utf8') : '', stderr: ok ? Buffer.concat(stderr).toString('utf8') : '' });
        stdout = []; stderr = [];
      };
      const timer = setTimeout(() => finish(false, null, true), timeoutMs);
      try {
        child = spawn(command, args, { cwd, env: overlay ? { ...nativeEnvironment(), ...overlay } : nativeEnvironment(), shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        child.once('error', () => finish(false));
        child.once('close', code => finish(Number.isInteger(code), code));
        for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) {
          stream.on('data', data => {
            if (done) return;
            const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
            bytes += chunk.length;
            if (bytes > maxBytes) return finish(false);
            if (capture) chunks.push(chunk);
          });
          stream.once('error', () => finish(false));
        }
      } catch { finish(false); }
    });
  }
  function parseVersion(provider, result) {
    if (!result.ok || result.code !== 0) return null;
    const pattern = provider === 'codex' ? /^codex-cli ([0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5}(?:-(?:alpha|beta|rc)(?:[.-][0-9]{1,5}){0,3})?)\s*$/i :
      /^([0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5}(?:-(?:alpha|beta|rc)(?:[.-][0-9]{1,5}){0,3})?) \(Claude Code\)\s*$/i;
    const match = pattern.exec(result.stdout);
    return match && match[1].length <= 64 ? match[1] : null;
  }
  function parseAuth(provider, result) {
    if (!result.ok) return 'unknown';
    if (provider === 'codex') {
      // Current native Codex prints status on stderr; stdout is also supported.
      const text = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
      if (result.code === 0 && text === 'Logged in using ChatGPT') return 'subscription';
      if (result.code === 0 && /^Logged in using an API key(?: - [^\r\n]{1,256})?$/.test(text)) return 'api-or-cloud';
      if (result.code === 1 && text === 'Not logged in') return 'signed-out';
      return 'unknown';
    }
    try {
      const auth = JSON.parse(result.stdout);
      if (!auth || Array.isArray(auth) || typeof auth !== 'object') return 'unknown';
      if (auth.loggedIn === false && [0, 1].includes(result.code)) return 'signed-out';
      if (result.code !== 0 || auth.loggedIn !== true) return 'unknown';
      if (auth.authMethod === 'claude.ai' && auth.apiProvider === 'firstParty') return 'subscription';
      if (['api_key', 'api_key_helper', 'third_party'].includes(auth.authMethod)) return 'api-or-cloud';
      // oauth_token and new methods do not establish subscription entitlement.
      return 'unknown';
    } catch { return 'unknown'; }
  }
  async function confirm(scope, action, provider, cwd = null) {
    const dialog = options.dialog ?? require('electron').dialog;
    const name = provider === 'codex' ? 'Codex' : 'Claude Code';
    const browser = action === 'login' && provider === 'codex';
    const detail = action === 'install' ? 'Open the official installation instructions in your browser. Arcane will not download or install software. Any later download or installation is your separate choice.' :
      browser ? 'Use the installed native Codex app-server to open official ChatGPT sign-in in your browser. Codex owns the local callback and credentials. Arcane sends no AI request and does not receive credentials or sign-in codes.' :
      action === 'fallback' ? 'This native Codex explicitly reports that browser login RPC is unsupported. Open the installed Codex login command in a visible PowerShell terminal. Complete sign-in in the vendor browser, then check status in Arcane.' :
      action === 'login' ? `Run the installed native ${name} sign-in command in a visible terminal. Complete authentication only in the vendor terminal or browser. Arcane does not receive credentials or sign-in codes.` :
        'Open unmodified Claude Code in a visible terminal for the current project. Review authentication, billing, project trust, and tool permissions there. Your own API or cloud account can incur charges; Arcane sends no prompt and selects no billing route.';
    const result = await dialog.showMessageBox(scope.window, {
      type: 'question', title: 'Arcane provider setup', message: action === 'install' ? `Open ${name} installation instructions?` :
        browser ? 'Sign in with ChatGPT?' : action === 'fallback' ? 'Open native Codex login in a terminal?' :
          action === 'login' ? `Sign in using native ${name}?` : 'Open native Claude Code?',
      detail: detail + (action === 'launch' ? '\n\nProject: ' + cwd : ''),
      buttons: ['Cancel', action === 'install' ? 'Open instructions' : browser ? 'Sign in' : 'Open terminal'],
      defaultId: 0, cancelId: 0, noLink: true,
    });
    stillCurrent(scope);
    return result?.response === 1;
  }
  async function terminal(command, args, cwd, scope) {
    return (await terminalOutcome(command, args, cwd, scope, null)) === 'opened';
  }
  /** opened: the short launcher exited 0 after Start-Process; failed: refused or exited non-zero before any
   * visible terminal; unknown: timed out or killed. Never a claim that the native client or MCP connected. */
  async function terminalOutcome(command, args, cwd, scope, overlay, progress = {}) {
    // Fail closed on other OSes until their visible-terminal contract is verified.
    if (platform !== 'win32') return 'failed';
    const systemRoot = absolute(env.SystemRoot ?? env.SYSTEMROOT ?? env.WINDIR);
    const requested = p.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const powershell = await checked(requested, 'file');
    if (!equal(powershell, requested)) fail();
    const literal = value => "'" + value.replaceAll("'", "''") + "'";
    const script = "$ErrorActionPreference = 'Stop'; Set-Location -LiteralPath " + literal(cwd) + '; & ' +
      literal(command) + (args.length ? ' ' + args.map(literal).join(' ') : '');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const launcher = "$ErrorActionPreference = 'Stop'; Start-Process -FilePath " + literal(powershell) +
      " -ArgumentList @('-NoLogo', '-NoProfile', '-NoExit', '-EncodedCommand', " + literal(encoded) + ') -WorkingDirectory ' +
      literal(cwd) + ' -WindowStyle Normal | Out-Null';
    // Only this short launcher is bounded/captured; the user owns the visible child.
    stillCurrent(scope);
    progress.spawned = true; // from here a launcher process may exist; later uncertainty is unknown, not failed
    const result = await run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(launcher, 'utf16le').toString('base64')], cwd, false, overlay);
    return result.ok && result.code === 0 ? 'opened' : result.timedOut ? 'unknown' : 'failed';
  }
  function cancelPending() {
    // Revoke intent even before the owned login exists (dialog/version awaits).
    // A context that returns to its original paths cannot revive the old action.
    epoch++;
    const owned = ownedLogin;
    if (!owned) return;
    owned.session.cancel(undefined, true); owned.detach();
    if (ownedLogin === owned) ownedLogin = null;
    update('codex', { auth: 'unknown', message: 'Native browser sign-in was cancelled. No completion was verified.' });
  }
  async function browserLogin(command, cwd, scope) {
    const cliVersion = parseVersion('codex', await run(command, ['--version'], cwd));
    stillCurrent(scope);
    if (!cliVersion) {
      update('codex', { cliVersion: null, auth: 'unknown', message: 'Native CLI version could not be verified. Browser sign-in was not started.' });
      return;
    }
    update('codex', { cliVersion, auth: 'unknown' });
    if (!equal(await checked(command, 'file'), command) || !equal(await checked(cwd, 'directory'), cwd)) fail();
    stillCurrent(scope);
    const { createCodexBrowserLogin } = require('./provider-login.cjs');
    const listeners = [];
    const owned = { session: null, scope, detach() {
      for (const [target, event, listener] of listeners) target.removeListener(event, listener);
      listeners.length = 0;
    } };
    const isCurrent = () => {
      if (disposed || ownedLogin !== owned) return false;
      try { stillCurrent(scope); return true; } catch { return false; }
    };
    owned.session = createCodexBrowserLogin({ spawn, command, cwd, env: nativeEnvironment(), cliVersion,
      rpcTimeoutMs: timeoutMs, loginTimeoutMs, isCurrent,
      openExternal: options.openExternal ?? (url => require('electron').shell.openExternal(url)),
      onChange(value) {
        if (isCurrent()) update('codex', { auth: value.auth, message: value.message });
        if (!value.pending) owned.detach();
      },
    });
    ownedLogin = owned;
    for (const [target, event] of [[scope.window, 'closed'], [scope.window.webContents, 'destroyed'],
      [scope.window.webContents, 'render-process-gone'], [scope.window.webContents, 'will-navigate'],
      [scope.window.webContents, 'did-start-navigation']]) {
      if (typeof target?.on !== 'function' || typeof target?.removeListener !== 'function') continue;
      const listener = (...args) => {
        if (event === 'did-start-navigation' && args[3] === false) return;
        if (ownedLogin === owned) cancelPending();
      };
      target.on(event, listener); listeners.push([target, event, listener]);
    }
    const result = await owned.session.start();
    if (!result.pending) { owned.detach(); if (ownedLogin === owned) ownedLogin = null; }
    stillCurrent(scope);
    const latest = owned.session.status();
    update('codex', { auth: latest.auth, message: latest.message });
    if (result.unsupported) {
      if (platform !== 'win32') {
        update('codex', { message: 'Native browser login RPC is unsupported. Run codex login in your own visible terminal, then check status.' });
      } else if (await confirm(scope, 'fallback', 'codex')) {
        if (!equal(await checked(command, 'file'), command) || !equal(await checked(cwd, 'directory'), cwd)) fail();
        stillCurrent(scope);
        const launched = await terminal(command, ['login'], cwd, scope);
        update('codex', { auth: 'unknown', message: launched ?
          'Native browser login RPC is unsupported. Visible Codex login terminal requested; complete sign-in there, then check status. Authentication is not yet verified.' :
          'Native browser login RPC is unsupported and the visible terminal could not be opened. Run codex login in your own terminal, then check status.' });
      }
    }
  }
  async function act(action, args) {
    const provider = providerArgument(args);
    if (!enabled) return Object.freeze({
      version: 1, provider, installed: false, auth: 'unknown', cliVersion: null, busy: false, message: DISABLED,
    });
    if (disposed) return Object.freeze({ ...copy(provider), auth: 'unknown', message: 'Provider setup is unavailable. No completion was verified.' });
    if (ownedLogin) {
      try { stillCurrent(ownedLogin.scope); } catch { cancelPending(); }
    }
    if (ownedLogin?.session.status().pending) return action === 'status' && provider === 'codex' ? copy(provider) :
      Object.freeze({ ...copy(provider), message: 'Another provider setup action is in progress.' });
    if (ownedLogin && !active) {
      // Deliver the actual final RPC outcome once to the polling renderer before
      // a later explicit refresh runs fresh native CLI metadata checks.
      const latest = ownedLogin.session.status();
      ownedLogin.detach(); ownedLogin = null;
      update('codex', { auth: latest.auth, message: latest.message });
      if (action === 'status' && provider === 'codex') return copy(provider);
    }
    if (active) return Object.freeze({ ...copy(provider), message: 'Another provider setup action is in progress.' });
    active = true;
    try {
      const scope = context();
      if (action === 'install') {
        if (!await confirm(scope, action, provider)) update(provider, { message: 'Installation instructions were cancelled.' });
        else {
          const open = options.openExternal ?? (url => require('electron').shell.openExternal(url));
          await open(PAGES[provider]);
          update(provider, { message: 'Official installation instructions opened. Arcane has not downloaded or installed the CLI. Check status after installation.' });
        }
      } else if (action === 'launch' && provider !== 'claude') {
        update(provider, { message: 'Native client handoff is available only for Claude Code.' });
      } else {
        const command = await locate(provider, scope);
        stillCurrent(scope);
        if (!command) update(provider, { installed: false, auth: 'unknown', cliVersion: null, message: 'A supported native CLI executable was not found. Open the official installation instructions or check your native PATH.' });
        else {
          update(provider, { installed: true });
          const cwd = await checked(action === 'launch' ? scope.project : home(), 'directory');
          stillCurrent(scope);
          if (action === 'status') {
            // Stale metadata is withdrawn immediately; the optional field only appears once a help read happened.
            if (provider === 'claude') { claudeMetadataScope = null; if (Object.hasOwn(snapshots.get('claude'), 'claudeChoices')) update(provider, { claudeChoices: null }); }
            const cliVersion = parseVersion(provider, await run(command, ['--version'], cwd));
            stillCurrent(scope);
            if (!cliVersion) update(provider, { cliVersion: null, auth: 'unknown', message: 'Native CLI version could not be verified.' });
            else {
              const auth = parseAuth(provider, await run(command, provider === 'codex' ? ['login', 'status'] : ['auth', 'status', '--json'], cwd));
              stillCurrent(scope);
              update(provider, { cliVersion, auth, message: auth === 'unknown' ? 'Native authentication status is unavailable or unrecognized.' :
                auth === 'api-or-cloud' ? 'Native CLI reports API or cloud authentication. Usage may incur charges; Arcane has not started a request.' : null });
              if (provider === 'claude') {
                // Optional handoff metadata: a failure leaves the legacy auth result and plain launch untouched.
                const choices = parseClaudeChoices(await run(command, ['--help'], cwd, true, null, HELP_MAX_BYTES), cliVersion);
                stillCurrent(scope);
                update(provider, { claudeChoices: choices });
                claudeMetadataScope = choices ? scope : null;
              }
            }
          } else if (action === 'login' && provider === 'codex') {
            if (!await confirm(scope, action, provider)) update(provider, { message: 'Native browser sign-in was cancelled.' });
            else await browserLogin(command, cwd, scope);
          } else if (platform !== 'win32') {
            update(provider, { message: 'A verified visible terminal handoff is unavailable on this platform. Use the native CLI in your own terminal.' });
          } else if (!await confirm(scope, action, provider, cwd)) {
            update(provider, { message: 'Native terminal handoff was cancelled.' });
          } else {
            // Recheck executable/cwd after the human decision, before launching.
            if (!equal(await checked(command, 'file'), command) || !equal(await checked(cwd, 'directory'), cwd)) fail();
            stillCurrent(scope);
            const launched = await terminal(command, action === 'login' ? provider === 'codex' ? ['login'] : ['auth', 'login'] : [], cwd, scope);
            update(provider, { auth: 'unknown', message: launched ? action === 'login' ?
              'Native sign-in terminal requested. Complete sign-in there, then check status. Authentication is not yet verified.' :
              'Native Claude Code terminal requested. Continue in the vendor client; Arcane has sent no prompt.' : 'The visible native terminal could not be opened.' });
          }
        }
      }
    } catch {
      update(provider, { auth: 'unknown', message: 'Provider setup is unavailable. No completion was verified.' });
      if (provider === 'claude' && Object.hasOwn(snapshots.get('claude'), 'claudeChoices')) { claudeMetadataScope = null; update('claude', { claudeChoices: null }); }
    } finally { active = false; }
    return copy(provider);
  }
  /** Trusted host port: verified current Claude metadata or null. No default, no entitlement claim. */
  function getHandoffChoices() {
    if (!enabled || disposed || active || ownedLogin?.session.status().pending || !claudeMetadataScope) return null;
    const s = snapshots.get('claude'), c = s.claudeChoices;
    if (!s.installed || s.auth !== 'subscription' || !s.cliVersion || !c || c.cliVersion !== s.cliVersion) return null;
    try { stillCurrent(claudeMetadataScope); } catch { return null; }
    return Object.freeze({ cliVersion: c.cliVersion, aliases: Object.freeze([...c.aliases]), efforts: Object.freeze([...c.efforts]) });
  }
  const sameProject = (value, project) => typeof value === 'string' && typeof project === 'string' && equal(p.normalize(value), p.normalize(project));
  /** Trusted host port: one native confirmation with the exact explicit selection. Any doubt is false. */
  async function confirmHandoff(profile, session) {
    if (!enabled || disposed || active || platform !== 'win32') return false;
    let selection, scope;
    try {
      const pr = plainFields(profile, ['provider', 'model', 'effort', 'cliVersion']);
      const choices = getHandoffChoices();
      if (pr.provider !== 'claude' || !choices || pr.cliVersion !== choices.cliVersion || !choices.aliases.includes(pr.model) || !choices.efforts.includes(pr.effort)) return false;
      const se = plainFields(session, ['projectPath', 'runtimeDirectory', 'nodePath', 'mcpEntry', 'origin', 'controlToken', 'epoch']);
      scope = context();
      if (se.origin !== scope.origin || !sameProject(se.projectPath, scope.project)) return false;
      selection = { model: pr.model, effort: pr.effort, cliVersion: pr.cliVersion };
    } catch { return false; }
    active = true;
    try {
      const dialog = options.dialog ?? require('electron').dialog;
      const result = await dialog.showMessageBox(scope.window, {
        type: 'question', title: 'Arcane provider setup', message: 'Open Claude Code with Arcane project tools?',
        detail: 'Open the installed Claude Code ' + selection.cliVersion + ' in a visible terminal for this project with model ' + selection.model + ' and effort ' + selection.effort +
          '. Arcane adds only its own project tools and a temporary project credential (work coordination and Studio commands you already allowed; it expires in 30 minutes and can be revoked). ' +
          'That terminal session can read the credential. Claude Code keeps its own sign-in, billing and permission prompts; Arcane sends no prompt and does not verify that Claude Code or its tools connect.\n\nProject: ' + scope.project,
        buttons: ['Cancel', 'Open terminal'], defaultId: 0, cancelId: 0, noLink: true,
      });
      stillCurrent(scope);
      active = false; // release before re-reading the eligibility gate, which refuses while busy
      const after = getHandoffChoices();
      return result?.response === 1 && !!after && after.cliVersion === selection.cliVersion && after.aliases.includes(selection.model) && after.efforts.includes(selection.effort);
    } catch { return false; } finally { active = false; }
  }
  /** Trusted host port: scoped visible terminal. The overlay goes ONLY into the launcher spawn env. */
  async function launchHandoffTerminal(request) {
    if (!enabled || disposed || active || ownedLogin || platform !== 'win32') return 'failed';
    let argv, overlay, scope;
    try {
      const r = plainFields(request, ['argv', 'env', 'projectPath', 'epoch']);
      const e = plainFields(r.env, ['ARCANE_DAEMON_URL', 'ARCANE_LOCAL_TOKEN']);
      scope = context();
      const port = typeof e.ARCANE_DAEMON_URL === 'string' ? HANDOFF_DAEMON.exec(e.ARCANE_DAEMON_URL) : null;
      if (!port || Number(port[1]) > 65535 || e.ARCANE_DAEMON_URL !== scope.origin || typeof e.ARCANE_LOCAL_TOKEN !== 'string' || !HANDOFF_CREDENTIAL.test(e.ARCANE_LOCAL_TOKEN)) return 'failed';
      const { types } = require('node:util');
      const a = r.argv;
      if (!Array.isArray(a) || types.isProxy(a) || Object.getPrototypeOf(a) !== Array.prototype || a.length !== 9 || !a.every((v, i) => Object.hasOwn(a, i) && typeof v === 'string')) return 'failed';
      const choices = getHandoffChoices();
      if (!choices || a[0] !== '--mcp-config' || a[2] !== '--strict-mcp-config' || a[3] !== '--model' || !choices.aliases.includes(a[4]) || a[5] !== '--effort' ||
          !choices.efforts.includes(a[6]) || a[7] !== '--permission-mode' || a[8] !== 'default' || p.basename(absolute(a[1])) !== 'arcane.mcp.json') return 'failed';
      if (a.some(v => v.includes(e.ARCANE_LOCAL_TOKEN)) || !sameProject(r.projectPath, scope.project) || r.epoch === null || r.epoch === undefined) return 'failed';
      argv = Object.freeze([...a]); overlay = Object.freeze({ ARCANE_DAEMON_URL: e.ARCANE_DAEMON_URL, ARCANE_LOCAL_TOKEN: e.ARCANE_LOCAL_TOKEN });
    } catch { return 'failed'; }
    active = true; const progress = { spawned: false };
    try {
      const command = await locate('claude', scope); stillCurrent(scope);
      if (!command) return 'failed';
      const cwd = await checked(scope.project, 'directory'); stillCurrent(scope);
      if (!equal(await checked(command, 'file'), command) || !equal(await checked(cwd, 'directory'), cwd)) return 'failed';
      stillCurrent(scope);
      const outcome = await terminalOutcome(command, argv, cwd, scope, overlay, progress);
      try { stillCurrent(scope); } catch { return outcome === 'failed' ? 'failed' : 'unknown'; }
      return outcome;
    } catch { return progress.spawned ? 'unknown' : 'failed'; }
    finally { active = false; }
  }
  const host = {
    status: (...args) => act('status', args), login: (...args) => act('login', args),
    install: (...args) => act('install', args), launch: (...args) => act('launch', args),
  };
  // Trusted owner hooks are deliberately outside the renderer's enumerable v1 API.
  Object.defineProperties(host, {
    cancelPending: { value: cancelPending },
    dispose: { value: () => { disposed = true; cancelPending(); } },
    getHandoffChoices: { value: getHandoffChoices },
    confirmHandoff: { value: confirmHandoff },
    launchHandoffTerminal: { value: launchHandoffTerminal },
  });
  return Object.freeze(host);
}

module.exports = { createProviderSetup };
