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
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const fail = () => { throw new Error('Provider setup request is unavailable.'); };

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
  let active = false, ownedLogin = null, disposed = false, epoch = 0;
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
  function run(command, args, cwd, capture = true) {
    return new Promise(resolve => {
      let child, done = false, bytes = 0, stdout = [], stderr = [];
      const finish = (ok, code = null) => {
        if (done) return;
        done = true; clearTimeout(timer);
        if (!ok) { try { child?.kill('SIGKILL'); } catch { /* Closed child. */ } }
        resolve({ ok, code, stdout: ok ? Buffer.concat(stdout).toString('utf8') : '', stderr: ok ? Buffer.concat(stderr).toString('utf8') : '' });
        stdout = []; stderr = [];
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      try {
        child = spawn(command, args, { cwd, env: nativeEnvironment(), shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        child.once('error', () => finish(false));
        child.once('close', code => finish(Number.isInteger(code), code));
        for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) {
          stream.on('data', data => {
            if (done) return;
            const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
            bytes += chunk.length;
            if (bytes > MAX_BYTES) return finish(false);
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
    // Fail closed on other OSes until their visible-terminal contract is verified.
    if (platform !== 'win32') return false;
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
    const result = await run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(launcher, 'utf16le').toString('base64')], cwd, false);
    return result.ok && result.code === 0;
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
            const cliVersion = parseVersion(provider, await run(command, ['--version'], cwd));
            stillCurrent(scope);
            if (!cliVersion) update(provider, { cliVersion: null, auth: 'unknown', message: 'Native CLI version could not be verified.' });
            else {
              const auth = parseAuth(provider, await run(command, provider === 'codex' ? ['login', 'status'] : ['auth', 'status', '--json'], cwd));
              stillCurrent(scope);
              update(provider, { cliVersion, auth, message: auth === 'unknown' ? 'Native authentication status is unavailable or unrecognized.' :
                auth === 'api-or-cloud' ? 'Native CLI reports API or cloud authentication. Usage may incur charges; Arcane has not started a request.' : null });
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
    } finally { active = false; }
    return copy(provider);
  }
  const host = {
    status: (...args) => act('status', args), login: (...args) => act('login', args),
    install: (...args) => act('install', args), launch: (...args) => act('launch', args),
  };
  // Trusted owner hooks are deliberately outside the renderer's enumerable v1 API.
  Object.defineProperties(host, {
    cancelPending: { value: cancelPending },
    dispose: { value: () => { disposed = true; cancelPending(); } },
  });
  return Object.freeze(host);
}

module.exports = { createProviderSetup };
