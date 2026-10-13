import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { win32, posix } from 'node:path';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { createProviderSetup } = require('../../apps/desktop/electron/provider-setup.cjs');
const fields = ['auth', 'busy', 'cliVersion', 'installed', 'message', 'provider', 'version'];
const disabledMessage = 'CLI setup checks are disabled in verification mode.';
const secret = 'fixture-secret-never-public@example.invalid';

function fixture(settings = {}) {
  const platform = settings.platform ?? 'win32', p = platform === 'win32' ? win32 : posix;
  const home = platform === 'win32' ? 'C:\\Users\\fixture' : '/home/fixture';
  const project = platform === 'win32' ? 'C:\\Projects\\arcane' : '/projects/arcane';
  const tools = platform === 'win32' ? 'C:\\Tools' : '/usr/local/bin';
  const system = 'C:\\Windows';
  const local = p.join(home, 'AppData', 'Local');
  const entries = new Map(), accesses = [], processes = [], dialogs = [], urls = [], children = [];
  const key = value => platform === 'win32' ? p.normalize(value).toLowerCase() : p.normalize(value);
  function put(value, kind = 'directory', attributes = {}) {
    value = p.normalize(value);
    if (value !== p.dirname(value) && !entries.has(key(p.dirname(value)))) put(p.dirname(value));
    entries.set(key(value), { full: value, kind, ...attributes });
  }
  const get = value => {
    accesses.push(p.normalize(value));
    const entry = entries.get(key(value));
    if (!entry) throw Object.assign(new Error(secret), { code: 'ENOENT' });
    return entry;
  };
  const fs = {
    async realpath(value) { const entry = get(value); return entry.target ?? entry.full; },
    async stat(value) { const entry = get(value); return { isFile: () => entry.kind === 'file', isDirectory: () => entry.kind === 'directory', mode: entry.mode ?? 0o755 }; },
    async opendir(value) {
      get(value);
      return (async function* () {
        for (const entry of entries.values()) {
          if (key(entry.full) !== key(value) && key(p.dirname(entry.full)) === key(value)) {
            yield { name: p.basename(entry.full), isDirectory: () => entry.kind === 'directory' };
          }
        }
      })();
    },
  };
  put(home); put(project); put(tools);
  const codex = p.join(tools, 'codex' + (platform === 'win32' ? '.exe' : ''));
  const claude = p.join(home, '.local', 'bin', 'claude' + (platform === 'win32' ? '.exe' : ''));
  const powershell = win32.join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (settings.codex !== false) put(codex, 'file');
  if (settings.claude !== false) put(claude, 'file');
  if (platform === 'win32') put(powershell, 'file');
  const state = {
    window: { isDestroyed: () => false }, origin: 'http://127.0.0.1:45871', project,
    response: 1, reply: null, beforeConfirm: null,
  };
  function spawn(command, args, options) {
    processes.push({ command, args: [...args], options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = signal => { child.killed = signal; };
    children.push(child);
    queueMicrotask(() => {
      const reply = state.reply?.(command, args, options) ?? (args[0] === '--version' ? {
        code: 0, stdout: command === claude ? '2.1.211 (Claude Code)\n' : 'codex-cli 0.143.0\n',
      } : args.join(' ') === 'login status' ? { code: 0, stderr: 'Logged in using ChatGPT\n' } :
        args.join(' ') === 'auth status --json' ? { code: 0, stdout: JSON.stringify({
          loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: secret, configDirectory: 'C:\\private', subscriptionType: 'max',
        }) } : { code: 0 });
      if (reply.hang) return;
      if (reply.error) { child.emit('error', new Error(secret)); return; }
      if (reply.stdout) child.stdout.emit('data', Buffer.from(reply.stdout));
      if (reply.stderr) child.stderr.emit('data', Buffer.from(reply.stderr));
      child.emit('close', reply.code ?? 0);
    });
    return child;
  }
  const options = {
    getWindow: () => state.window, getOrigin: () => state.origin, getProjectPath: () => state.project,
    fs, spawn, platform, arch: settings.arch ?? 'x64', homedir: () => home, timeoutMs: 40,
    env: { PATH: tools, USERPROFILE: home, HOME: home, LOCALAPPDATA: local, SystemRoot: system,
      OPENAI_API_KEY: secret, ANTHROPIC_API_KEY: secret, CLAUDE_CODE_OAUTH_TOKEN: secret,
      ARCANE_AGENT_TOKEN: secret, ARCANE_DAEMON_URL: 'http://127.0.0.1:1234',
      NODE_OPTIONS: '--require=malicious.js', ELECTRON_RUN_AS_NODE: '1', HTTP_PROXY: secret },
    dialog: { async showMessageBox(window, config) {
      dialogs.push({ window, config }); await state.beforeConfirm?.(); return { response: state.response };
    } },
    async openExternal(url) { urls.push(url); },
  };
  const host = createProviderSetup(options);
  return { host, options, state, put, entries, key, accesses, processes, children, dialogs, urls, codex, claude, powershell, home, project, local, p, tools };
}

function snapshot(value, provider) {
  assert.deepEqual(Object.keys(value).sort(), fields);
  assert.equal(value.version, 1); assert.equal(value.provider, provider);
  assert.equal(typeof value.installed, 'boolean'); assert.equal(typeof value.busy, 'boolean');
  assert.ok(['signed-out', 'subscription', 'api-or-cloud', 'unknown'].includes(value.auth));
  assert.ok(value.cliVersion === null || typeof value.cliVersion === 'string');
  assert.ok(value.message === null || typeof value.message === 'string');
  assert.ok(Object.isFrozen(value)); assert.ok(!JSON.stringify(value).includes(secret));
}

test('import and factory do not touch Electron, native metadata or processes', () => {
  const source = readFileSync(new URL('../../apps/desktop/electron/provider-setup.cjs', import.meta.url), 'utf8');
  const module = { exports: {} };
  vm.runInNewContext(source, { module, Buffer, URL, setTimeout, clearTimeout,
    process: { platform: 'win32', arch: 'x64', env: {} },
    require(name) {
      if (name === 'node:path') return { win32, posix };
      if (name === 'node:fs/promises') return new Proxy({}, { get() { assert.fail('native metadata'); } });
      if (name === 'node:child_process') return { spawn() { assert.fail('native process'); } };
      if (name === 'node:os') return { homedir() { assert.fail('home metadata'); } };
      assert.fail('unexpected import: ' + name);
    },
  });
  const host = module.exports.createProviderSetup({ getWindow() { assert.fail(); }, getOrigin() { assert.fail(); }, getProjectPath() { assert.fail(); } });
  assert.deepEqual(Object.keys(host).sort(), ['install', 'launch', 'login', 'status']);
  assert.ok(Object.isFrozen(host));
});

test('verification mode has the exact disabled snapshot and zero side effects for every method/provider', async () => {
  const f = fixture(), options = { ...f.options, enabled: false,
    getWindow() { assert.fail(); }, getOrigin() { assert.fail(); }, getProjectPath() { assert.fail(); }, homedir() { assert.fail(); },
  }, host = createProviderSetup(options);
  // Verification mode is pinned at construction, not a mutable renderer toggle.
  options.enabled = true;
  for (const method of Object.keys(host)) for (const provider of ['codex', 'claude']) {
    const result = await host[method](provider); snapshot(result, provider);
    assert.deepEqual(result, { version: 1, provider, installed: false, auth: 'unknown', cliVersion: null, busy: false, message: disabledMessage });
  }
  assert.equal(f.accesses.length + f.processes.length + f.dialogs.length + f.urls.length, 0);
});

test('every method rejects envelopes, extra arguments, command/path/URL injection and unsupported providers', async () => {
  const f = fixture();
  for (const method of Object.keys(f.host)) {
    for (const args of [[], ['Codex'], ['gemini'], [null], [{ provider: 'codex', command: 'evil' }],
      ['codex', 'C:\\evil.exe'], ['claude', { env: {} }], ['claude; evil'], ['https://evil.invalid']]) {
      await assert.rejects(f.host[method](...args), /^Error: Provider setup request is unavailable\.$/);
    }
  }
  assert.equal(f.accesses.length + f.processes.length + f.dialogs.length + f.urls.length, 0);
});

test('native status uses only fixed metadata argv and returns only sanitized enum/version', async () => {
  const f = fixture();
  for (const provider of ['codex', 'claude']) {
    const result = await f.host.status(provider); snapshot(result, provider);
    assert.equal(result.installed, true); assert.equal(result.auth, 'subscription'); assert.equal(result.message, null);
    assert.equal(result.cliVersion, provider === 'codex' ? '0.143.0' : '2.1.211');
  }
  assert.deepEqual(f.processes.map(item => item.args), [['--version'], ['login', 'status'], ['--version'], ['auth', 'status', '--json']]);
  for (const child of f.processes) {
    assert.equal(child.options.shell, false); assert.equal(child.options.windowsHide, true);
    assert.equal(child.options.cwd, f.home); assert.deepEqual(child.options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.ok(!JSON.stringify(child.options.env).includes(secret));
    assert.ok(!Object.keys(child.options.env).some(key => /ARCANE|NODE_|ELECTRON|API_KEY|TOKEN|PROXY/.test(key)));
  }
  assert.equal(f.dialogs.length + f.urls.length, 0);
  assert.ok(!f.accesses.some(path => /auth\.json|config\.toml|\.claude\.json|credentials|settings\.json/.test(path)));
});

test('Codex API-key status projects no key bytes; arbitrary failures are unknown', async () => {
  const f = fixture();
  for (const [reply, expected] of [
    [{ code: 0, stderr: 'Logged in using an API key - ' + secret }, 'api-or-cloud'],
    [{ code: 1, stderr: 'Not logged in' }, 'signed-out'],
    [{ code: 1, stderr: 'network unavailable ' + secret }, 'unknown'],
    [{ code: 0, stderr: 'Logged in using ChatGPT\n' + secret }, 'unknown'],
    [{ code: 2, stderr: 'Not logged in' }, 'unknown'],
  ]) {
    f.state.reply = (command, args) => args[0] === '--version' ? null : reply;
    const result = await f.host.status('codex'); snapshot(result, 'codex'); assert.equal(result.auth, expected);
  }
});

test('Claude auth conservatively distinguishes signed out, subscription, API/cloud and unknown', async () => {
  const f = fixture();
  for (const [auth, code, expected] of [
    [{ loggedIn: false }, 1, 'signed-out'],
    [{ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }, 0, 'subscription'],
    [{ loggedIn: true, authMethod: 'api_key' }, 0, 'api-or-cloud'],
    [{ loggedIn: true, authMethod: 'api_key_helper' }, 0, 'api-or-cloud'],
    [{ loggedIn: true, authMethod: 'third_party', apiProvider: 'bedrock' }, 0, 'api-or-cloud'],
    [{ loggedIn: true, authMethod: 'oauth_token' }, 0, 'unknown'],
    [{ loggedIn: true, authMethod: 'new_vendor_method' }, 0, 'unknown'],
    [{ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'thirdParty' }, 0, 'unknown'],
    [{ loggedIn: true, authMethod: 'api_key' }, 1, 'unknown'],
    [{}, 1, 'unknown'], [null, 0, 'unknown'], [[], 0, 'unknown'],
  ]) {
    f.state.reply = (command, args) => args[0] === '--version' ? null : { code, stdout: JSON.stringify(auth), stderr: secret };
    const result = await f.host.status('claude'); snapshot(result, 'claude'); assert.equal(result.auth, expected);
  }
  f.state.reply = (command, args) => args[0] === '--version' ? null : { code: 0, stdout: '{invalid ' + secret };
  assert.equal((await f.host.status('claude')).auth, 'unknown');
});

test('unrecognized versions stop before auth, never expose extra output or account-like versions', async () => {
  for (const provider of ['codex', 'claude']) for (const output of [secret, 'codex-cli 0.143.0\n' + secret, 'codex-cli 1.2.3-' + secret,
    'codex-cli 1.2.3-sk-test-secret', '1.2.3-sk-test-secret (Claude Code)',
    '1.2.3 (Claude Code)\n' + secret, '9999999.1.1 (Claude Code)', '\u001b[31mcodex-cli 1.2.3']) {
    const f = fixture(); f.state.reply = () => ({ code: 0, stdout: output });
    const result = await f.host.status(provider); snapshot(result, provider);
    assert.equal(result.installed, true); assert.equal(result.cliVersion, null); assert.equal(result.auth, 'unknown');
    assert.equal(f.processes.length, 1);
  }
});

test('combined output byte cap, process errors and deadlines fail closed and kill helpers', async () => {
  for (const reply of [{ code: 0, stdout: 'a'.repeat(10000), stderr: 'b'.repeat(10000) }, { error: true }, { hang: true }]) {
    const f = fixture(); f.state.reply = () => reply;
    const result = await f.host.status('codex'); snapshot(result, 'codex');
    assert.equal(result.auth, 'unknown'); assert.equal(result.cliVersion, null);
    assert.equal(f.processes.length, 1); assert.equal(f.children[0].killed, 'SIGKILL');
  }
});

test('missing CLIs never trigger installation, confirmation, status subprocesses or browser navigation', async () => {
  const f = fixture({ codex: false, claude: false });
  for (const provider of ['codex', 'claude']) for (const method of ['status', 'login', 'launch']) {
    const result = await f.host[method](provider); snapshot(result, provider);
    assert.equal(result.installed, false); assert.equal(result.auth, 'unknown');
  }
  assert.equal(f.processes.length + f.dialogs.length + f.urls.length, 0);
});

test('Codex native desktop installedbin fallback accepts one build and rejects ambiguous builds', async () => {
  const f = fixture({ codex: false });
  const root = f.p.join(f.local, 'OpenAI', 'Codex', 'bin');
  const installed = f.p.join(root, '2e5e00daee91c61d', 'codex.exe'); f.put(installed, 'file');
  const result = await f.host.status('codex'); assert.equal(result.installed, true);
  assert.equal(f.processes[0].command, installed);
  f.put(f.p.join(root, '1111111111111111', 'codex.exe'), 'file'); f.processes.length = 0;
  assert.equal((await f.host.status('codex')).installed, false); assert.equal(f.processes.length, 0);
});

test('installedbin enumeration is capped and does not pick an arbitrary build', async () => {
  const f = fixture({ codex: false });
  const root = f.p.join(f.local, 'OpenAI', 'Codex', 'bin');
  for (let i = 0; i < 33; i++) f.put(f.p.join(root, 'entry-' + i));
  f.put(f.p.join(root, '2e5e00daee91c61d', 'codex.exe'), 'file');
  assert.equal((await f.host.status('codex')).installed, false); assert.equal(f.processes.length, 0);
});

test('npm Windows native payloads are invoked directly for both supported architectures', async () => {
  for (const arch of ['x64', 'arm64']) for (const layout of ['nested', 'sibling', 'legacy']) {
    const f = fixture({ codex: false, arch });
    const base = f.p.join(f.tools, 'node_modules', '@openai');
    const root = layout === 'nested' ? f.p.join(base, 'codex', 'node_modules', '@openai', 'codex-win32-' + arch) :
      layout === 'sibling' ? f.p.join(base, 'codex-win32-' + arch) : f.p.join(base, 'codex');
    const exe = f.p.join(root, 'vendor', arch === 'x64' ? 'x86_64-pc-windows-msvc' : 'aarch64-pc-windows-msvc', 'codex', 'codex.exe');
    f.put(exe, 'file'); assert.equal((await f.host.status('codex')).installed, true);
    assert.equal(f.processes[0].command, exe);
  }
});

test('PATH ignores relative/empty/device/network entries and never executes script wrappers or project CLIs', async () => {
  const f = fixture({ codex: false });
  f.put(f.p.join(f.project, 'codex.exe'), 'file'); f.put(f.p.join(f.tools, 'codex.cmd'), 'file');
  f.put(f.p.join(f.tools, 'codex.ps1'), 'file');
  const host = createProviderSetup({ ...f.options, env: { ...f.options.env,
    PATH: ['.', '', 'C:relative', '\\\\server\\share', '\\\\?\\C:\\Tools', f.project, f.tools].join(';'),
  } });
  assert.equal((await host.status('codex')).installed, false); assert.equal(f.processes.length, 0);
  assert.ok(!f.accesses.some(value => /server|relative|\.cmd$|\.ps1$/.test(value)));
});

test('canonicalized binaries inside a project are rejected even via an outside symlink', async () => {
  const f = fixture({ codex: false });
  const target = f.p.join(f.project, 'codex.exe'); f.put(target, 'file'); f.put(f.codex, 'file', { target });
  assert.equal((await f.host.status('codex')).installed, false); assert.equal(f.processes.length, 0);
});

test('only native install pages open, after a Cancel-default host confirmation, with honest cached status', async () => {
  const f = fixture();
  await f.host.status('codex'); const before = f.processes.length; f.accesses.length = 0;
  for (const provider of ['codex', 'claude']) {
    const result = await f.host.install(provider); snapshot(result, provider);
    assert.equal(result.installed, provider === 'codex'); assert.match(result.message, /has not downloaded or installed/);
    const { window, config } = f.dialogs.at(-1);
    assert.equal(window, f.state.window); assert.equal(config.defaultId, 0); assert.equal(config.cancelId, 0);
    assert.deepEqual(config.buttons, ['Cancel', 'Open instructions']);
  }
  assert.deepEqual(f.urls, ['https://learn.chatgpt.com/docs/codex/cli', 'https://code.claude.com/docs/en/setup']);
  assert.equal(f.processes.length, before); assert.equal(f.accesses.length, 0);
});

test('dismissed or malformed native confirmations cause no external action', async () => {
  for (const response of [0, undefined, -1, '1', true, 2]) {
    const f = fixture(); f.state.response = response;
    for (const provider of ['codex', 'claude']) for (const method of ['install', 'login', 'launch']) {
      snapshot(await f.host[method](provider), provider);
    }
    assert.equal(f.urls.length + f.processes.length, 0);
  }
});

function terminalScripts(process) {
  assert.deepEqual(process.args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
  const launcher = Buffer.from(process.args[4], 'base64').toString('utf16le');
  const encoded = /'-EncodedCommand', '([A-Za-z0-9+/=]+)'/.exec(launcher)?.[1];
  assert.ok(encoded); return { launcher, inner: Buffer.from(encoded, 'base64').toString('utf16le') };
}

test('Claude login requests genuine fixed vendor login in a visible terminal with no auth claim or capture', async () => {
  const f = fixture();
  for (const provider of ['claude']) {
    const result = await f.host.login(provider); snapshot(result, provider);
    assert.equal(result.auth, 'unknown'); assert.equal(result.cliVersion, null); assert.match(result.message, /not yet verified/);
    const process = f.processes.at(-1), { launcher, inner } = terminalScripts(process);
    assert.equal(process.command, f.powershell); assert.match(launcher, /-WindowStyle Normal/);
    assert.match(launcher, /'-NoLogo', '-NoProfile', '-NoExit'/);
    assert.ok(inner.endsWith(provider === 'codex' ? "'codex.exe' 'login'".replace("'codex.exe'", "'" + f.codex + "'") : "'" + f.claude + "' 'auth' 'login'"));
    assert.ok(inner.includes('Set-Location -LiteralPath')); assert.ok(inner.includes(f.home));
    assert.ok(!/ExecutionPolicy|Bypass|setup-token|--console|--with-api-key|device-auth|curl|Invoke-Expression|iex|RunAs/.test(launcher + inner));
    assert.equal(f.dialogs.at(-1).config.defaultId, 0); assert.equal(f.dialogs.at(-1).config.cancelId, 0);
  }
  assert.equal(f.processes.length, 1); assert.equal(f.urls.length, 0);
});

test('Claude handoff sends no prompt, flags, resume, model, API route or app RPC', async () => {
  const f = fixture(); const result = await f.host.launch('claude'); snapshot(result, 'claude');
  const { inner } = terminalScripts(f.processes[0]);
  assert.equal(inner, "$ErrorActionPreference = 'Stop'; Set-Location -LiteralPath '" + f.project + "'; & '" + f.claude + "'");
  assert.match(f.dialogs[0].config.detail, /API or cloud account can incur charges/);
  assert.match(result.message, /Arcane has sent no prompt/); assert.equal(result.auth, 'unknown');
  f.processes.length = 0; f.accesses.length = 0; f.dialogs.length = 0;
  assert.match((await f.host.launch('codex')).message, /only for Claude Code/);
  assert.equal(f.processes.length + f.accesses.length + f.dialogs.length, 0);
});

test('literal apostrophes and metacharacters in trusted project paths cannot inject PowerShell', async () => {
  const f = fixture(); f.state.project = "C:\\Projects\\O'Brien; $(evil)`&"; f.put(f.state.project);
  const result = await f.host.launch('claude'); snapshot(result, 'claude');
  const { inner } = terminalScripts(f.processes[0]);
  assert.ok(inner.includes("Set-Location -LiteralPath 'C:\\Projects\\O''Brien; $(evil)`&'; & '"));
});

test('host window/origin/project changes during confirmation revoke action without fallback', async () => {
  for (const method of ['install', 'login', 'launch']) for (const change of [
    f => { f.state.origin = 'http://127.0.0.1:45872'; },
    f => { f.state.window = { isDestroyed: () => false }; },
    f => { f.state.project = 'C:\\Projects\\other'; },
    f => { f.state.window.isDestroyed = () => true; },
  ]) {
    const f = fixture(); f.state.beforeConfirm = () => change(f);
    const result = await f.host[method]('claude'); snapshot(result, 'claude');
    assert.equal(result.auth, 'unknown'); assert.equal(f.urls.length + f.processes.length, 0);
  }
});

test('owner cancellation revokes a pending confirmation even when the original context returns', async () => {
  for (const method of ['install', 'login']) {
    const f = fixture();
    f.state.beforeConfirm = () => {
      const project = f.state.project;
      f.host.cancelPending();
      f.state.project = 'C:\\Projects\\other'; f.state.project = project;
    };
    const result = await f.host[method]('codex'); snapshot(result, 'codex');
    assert.equal(result.auth, 'unknown'); assert.equal(result.busy, false);
    assert.match(result.message, /No completion was verified/);
    assert.equal(f.urls.length + f.processes.length, 0);
  }
});

test('owner cancellation during the version check prevents app-server launch in an unchanged context', async () => {
  const f = fixture();
  f.state.reply = () => { f.host.cancelPending(); return null; };
  const result = await f.host.login('codex'); snapshot(result, 'codex');
  assert.equal(result.auth, 'unknown'); assert.match(result.message, /No completion was verified/);
  assert.deepEqual(f.processes.map(value => value.args), [['--version']]);
  assert.equal(f.urls.length, 0);
});

test('context changes during terminal shell resolution revoke launch before the process boundary', async () => {
  const f = fixture(), original = f.options.fs.realpath;
  f.options.fs.realpath = async value => {
    const full = await original(value);
    if (value === f.powershell) f.state.origin = 'http://127.0.0.1:45872';
    return full;
  };
  const result = await f.host.login('claude'); snapshot(result, 'claude');
  assert.equal(result.auth, 'unknown'); assert.equal(f.dialogs.length, 1); assert.equal(f.processes.length, 0);
});

test('redirected system PowerShell is refused instead of executing an alternate launcher', async () => {
  const f = fixture(); const target = 'C:\\Elsewhere\\powershell.exe';
  f.put(target, 'file'); f.put(f.powershell, 'file', { target });
  const result = await f.host.login('claude'); snapshot(result, 'claude');
  assert.equal(result.auth, 'unknown'); assert.equal(f.processes.length, 0);
});

test('invalid initial host context and project paths fail closed', async () => {
  for (const change of [f => { f.state.window = null; }, f => { f.state.origin = 'https://example.invalid'; },
    f => { f.state.origin += '/page'; }, f => { f.state.project = '\\\\server\\share'; },
    f => { f.state.project = 'C:\\Projects\\bad\npath'; }]) {
    const f = fixture(); change(f); const result = await f.host.status('claude'); snapshot(result, 'claude');
    assert.equal(result.auth, 'unknown'); assert.equal(f.processes.length, 0);
  }
});

test('window change after version prevents the auth helper and sanitizes failures', async () => {
  const f = fixture(); f.state.reply = () => { f.state.origin = 'http://127.0.0.1:45872'; return null; };
  const result = await f.host.status('codex'); snapshot(result, 'codex');
  assert.equal(result.auth, 'unknown'); assert.equal(f.processes.length, 1);
});

test('global action lock prevents duplicate confirmations, probes and terminal launches', async () => {
  const f = fixture(); let release;
  f.state.beforeConfirm = () => new Promise(resolve => { release = resolve; });
  const pending = f.host.install('codex');
  await new Promise(resolve => setImmediate(resolve));
  for (const method of ['status', 'login', 'install', 'launch']) {
    const result = await f.host[method]('claude'); snapshot(result, 'claude'); assert.equal(result.busy, true);
  }
  assert.equal(f.dialogs.length, 1); assert.equal(f.processes.length, 0);
  release(); assert.equal((await pending).busy, false); assert.equal(f.urls.length, 1);
});

test('terminal failure is honest; no hidden login fallback or automatic status follow-up', async () => {
  const f = fixture(); f.state.reply = () => ({ error: true });
  const result = await f.host.login('claude'); snapshot(result, 'claude');
  assert.equal(result.auth, 'unknown'); assert.match(result.message, /could not be opened/);
  assert.equal(f.processes.length, 1);
});

test('POSIX native status works, but unverified terminal integrations remain unavailable', async () => {
  const f = fixture({ platform: 'linux' });
  snapshot(await f.host.status('claude'), 'claude'); assert.equal(f.processes.length, 2); f.processes.length = 0;
  for (const method of ['login', 'launch']) {
    assert.match((await f.host[method]('claude')).message, /unavailable on this platform/);
  }
  assert.equal(f.dialogs.length + f.processes.length, 0);
});

test('trusted option validation rejects malformed disable flags, required accessors and unbounded timeouts', () => {
  const f = fixture();
  for (const values of [{ enabled: 'false' }, { getWindow: null }, { getOrigin: null }, { getProjectPath: null },
    { timeoutMs: 0 }, { timeoutMs: 15001 }, { timeoutMs: 1.5 },
    { loginTimeoutMs: 0 }, { loginTimeoutMs: 300001 }, { loginTimeoutMs: 1.5 }]) {
    assert.throws(() => createProviderSetup({ ...f.options, ...values }), /unavailable/);
  }
});

test('published multi-component native prerelease version is bounded and supported',async()=>{const f=fixture();f.state.reply=(command,args)=>args[0]==='--version'?{code:0,stdout:'codex-cli 0.162.0-alpha.17.2\n'}:{code:0,stderr:'Logged in using ChatGPT\n'};const value=await f.host.status('codex');assert.equal(value.cliVersion,'0.162.0-alpha.17.2');assert.equal(value.auth,'subscription');});
