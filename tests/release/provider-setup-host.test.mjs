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
  // claudeChoices is optional and Claude-only: exact frozen {cliVersion, aliases, efforts} or null.
  const keys = Object.keys(value).sort();
  if (provider === 'claude' && keys.includes('claudeChoices')) {
    assert.deepEqual(keys, [...fields, 'claudeChoices'].sort());
    const c = value.claudeChoices;
    if (c !== null) {
      assert.deepEqual(Object.keys(c).sort(), ['aliases', 'cliVersion', 'efforts']); assert.ok(Object.isFrozen(c) && Object.isFrozen(c.aliases) && Object.isFrozen(c.efforts));
      assert.equal(c.cliVersion, value.cliVersion);
    }
  } else assert.deepEqual(keys, fields);
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
  // Claude status adds exactly one fixed metadata argv, `--help`, after verified version and auth.
  assert.deepEqual(f.processes.map(item => item.args), [['--version'], ['login', 'status'], ['--version'], ['auth', 'status', '--json'], ['--help']]);
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
  snapshot(await f.host.status('claude'), 'claude'); assert.equal(f.processes.length, 3, 'version, auth and fixed --help metadata'); f.processes.length = 0;
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


// ---- Claude handoff metadata and trusted terminal ports (fake spawn/filesystem only; no PowerShell or CLI) ----
const HELP = ['Usage: claude [options] [command] [prompt]', '', 'Options:',
  '  --effort <level>                      Effort level for the current session',
  '                                        (low, medium, high, xhigh, max)',
  '  --model <model>                       Model for the current session. Provide',
  "                                        an alias for the latest model (e.g.",
  "                                        'fable', 'opus', or 'sonnet') or a",
  "                                        model's full name (e.g.",
  "                                        'claude-fable-5').",
  '  -n, --name <name>                     Set a display name for this session', ''].join('\n');
const TOKEN = 'Q'.repeat(20) + '_-' + 'z'.repeat(21);
async function handoffFixture(settings = {}, help = HELP) {
  const f = fixture(settings);
  f.state.reply = (command, args) => args[0] === '--help' ? (typeof help === 'function' ? help() : { code: 0, stdout: help }) : null;
  const value = await f.host.status('claude'); f.processes.length = 0;
  return { ...f, value };
}
const session = f => ({ projectPath: f.project, runtimeDirectory: 'C:\\Users\\fixture\\AppData\\Roaming\\Arcane\\native-handoffs', nodePath: 'C:\\Program Files\\Arcane\\node.exe',
  mcpEntry: 'C:\\Program Files\\Arcane\\main.js', origin: f.state.origin, controlToken: 'a'.repeat(64), epoch: {} });
const profile = (overrides = {}) => ({ provider: 'claude', model: 'opus', effort: 'high', cliVersion: '2.1.211', ...overrides });
const handoffRequest = (f, overrides = {}) => ({ argv: ['--mcp-config', 'C:\\Users\\fixture\\AppData\\Roaming\\Arcane\\native-handoffs\\claude-handoff-1\\arcane.mcp.json', '--strict-mcp-config',
  '--model', 'opus', '--effort', 'high', '--permission-mode', 'default'], env: { ARCANE_DAEMON_URL: f.state.origin, ARCANE_LOCAL_TOKEN: TOKEN }, projectPath: f.project, epoch: {}, ...overrides });
const decode = value => Buffer.from(value, 'base64').toString('utf16le');
function launcherScripts(processRecord) {
  const outer = decode(processRecord.args.at(-1)), inner = decode(/'-EncodedCommand', '([A-Za-z0-9+/=]+)'/.exec(outer)[1]);
  return { outer, inner };
}

test('Claude status records fixed --help aliases/efforts with no default; metadata failure keeps legacy auth and gives null', async () => {
  const f = await handoffFixture(); snapshot(f.value, 'claude');
  assert.equal(f.value.auth, 'subscription');
  assert.deepEqual(f.value.claudeChoices, { cliVersion: '2.1.211', aliases: ['fable', 'opus', 'sonnet'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] });
  assert.deepEqual(f.host.getHandoffChoices(), f.value.claudeChoices); assert.notEqual(f.host.getHandoffChoices().aliases, f.value.claudeChoices.aliases, 'detached copy');
  assert.ok(!('default' in f.value.claudeChoices) && !('defaultModel' in f.value.claudeChoices));
  for (const [what, help] of [['no model paragraph', HELP.replace(/--model <model>[\s\S]*claude-fable-5'\)\./, '')], ['no effort list', HELP.replace('(low, medium, high, xhigh, max)', '(see docs)')],
    ['only full names', HELP.replace("'fable', 'opus', or 'sonnet'", "'claude-opus-5'")], ['failed help', () => ({ code: 1, stdout: HELP })], ['help error', () => ({ error: true })],
    ['help hang', () => ({ hang: true })], ['oversize help', 'x'.repeat(70000) + HELP], ['empty help', '']]) {
    const g = await handoffFixture({}, help); snapshot(g.value, 'claude');
    assert.deepEqual([g.value.auth, g.value.claudeChoices, g.host.getHandoffChoices()], ['subscription', null, null], what);
  }
  const codex = await f.host.status('codex'); assert.ok(!('claudeChoices' in codex), 'Codex snapshots are unchanged');
  const v = fixture(); v.state.reply = (command, args) => args[0] === '--version' ? { code: 0, stdout: 'garbage' } : null;
  const unverified = await v.host.status('claude'); assert.ok(!('claudeChoices' in unverified), 'the optional field only appears after a help read'); assert.ok(!v.processes.some(item => item.args[0] === '--help'), 'no help before a verified version');
  const disabled = createProviderSetup({ ...f.options, enabled: false }); assert.equal(disabled.getHandoffChoices(), null);
  assert.deepEqual(Object.keys(f.host).sort(), ['install', 'launch', 'login', 'status']);
  for (const name of ['getHandoffChoices', 'confirmHandoff', 'launchHandoffTerminal']) assert.equal(Object.getOwnPropertyDescriptor(f.host, name).enumerable, false, name);
});

test('handoff choices are null unless current subscription metadata is eligible, not busy, not stale and not disposed', async () => {
  const api = await handoffFixture(); api.state.reply = (command, args) => args[0] === '--help' ? { code: 0, stdout: HELP } : args[0] === 'auth' ? { code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'api_key' }) } : null;
  await api.host.status('claude'); assert.equal(api.host.getHandoffChoices(), null, 'API/cloud authentication is not eligible');
  const cancelled = await handoffFixture(); cancelled.host.cancelPending(); assert.equal(cancelled.host.getHandoffChoices(), null, 'stale after cancelPending');
  const moved = await handoffFixture(); moved.put('C:\\Projects\\other'); moved.state.project = 'C:\\Projects\\other'; assert.equal(moved.host.getHandoffChoices(), null, 'stale after a project change');
  const window = await handoffFixture(); window.state.window = { isDestroyed: () => false }; assert.equal(window.host.getHandoffChoices(), null, 'stale after a window change');
  const failed = await handoffFixture(); failed.state.reply = () => ({ code: 0, stdout: 'garbage' }); await failed.host.status('claude');
  assert.equal(failed.host.getHandoffChoices(), null, 'a later failed status clears metadata');
  const busy = await handoffFixture(); busy.state.reply = () => ({ hang: true }); const pending = busy.host.status('codex');
  assert.equal(busy.host.getHandoffChoices(), null, 'busy'); await pending;
  const disposed = await handoffFixture(); disposed.host.dispose(); assert.equal(disposed.host.getHandoffChoices(), null);
});

test('confirmHandoff shows exactly one native confirmation for an explicit current selection; any doubt is false', async () => {
  const f = await handoffFixture();
  assert.equal(await f.host.confirmHandoff(profile(), session(f)), true); assert.equal(f.dialogs.length, 1);
  const { config } = f.dialogs[0];
  assert.equal(config.message, 'Open Claude Code with Arcane project tools?'); assert.deepEqual([config.buttons, config.defaultId, config.cancelId], [['Cancel', 'Open terminal'], 0, 0]);
  for (const text of ['model opus', 'effort high', '2.1.211', 'temporary project credential', 'expires in 30 minutes', 'does not verify', f.project]) assert.ok(config.detail.includes(text), text);
  assert.ok(!config.detail.includes('a'.repeat(64)), 'no human token in the dialog');
  f.state.response = 0; assert.equal(await f.host.confirmHandoff(profile(), session(f)), false, 'cancel'); f.state.response = 1;
  const before = f.dialogs.length;
  for (const [what, pr, se] of [['unknown model', profile({ model: 'haiku' }), session(f)], ['unsupported effort', profile({ effort: 'ultra' }), session(f)], ['other CLI', profile({ cliVersion: '2.1.212' }), session(f)],
    ['codex', profile({ provider: 'codex' }), session(f)], ['extra key', { ...profile(), fallback: 'sonnet' }, session(f)], ['missing effort', (({ effort, ...rest }) => rest)(profile()), session(f)],
    ['proxy profile', new Proxy(profile(), {}), session(f)], ['other origin', profile(), { ...session(f), origin: 'http://127.0.0.1:1' }], ['other project', profile(), { ...session(f), projectPath: 'C:\\Projects\\other' }],
    ['partial session', profile(), (({ epoch, ...rest }) => rest)(session(f))]])
    assert.equal(await f.host.confirmHandoff(pr, se), false, what);
  assert.equal(f.dialogs.length, before, 'no dialog for any invalid request');
  f.state.beforeConfirm = () => { f.host.cancelPending(); }; assert.equal(await f.host.confirmHandoff(profile(), session(f)), false, 'cancelled during the dialog');
  const g = await handoffFixture(); g.state.beforeConfirm = () => { g.put('C:\\Projects\\other'); g.state.project = 'C:\\Projects\\other'; };
  assert.equal(await g.host.confirmHandoff(profile(), session(g)), false, 'project changed during the dialog');
  assert.equal(await g.host.confirmHandoff(profile(), session(g)), false, 'metadata is stale afterwards');
});

test('launchHandoffTerminal puts the overlay only in the launcher spawn env; argv and both encoded scripts never carry it; plain launch is unchanged', async () => {
  const f = await handoffFixture(), outcome = await f.host.launchHandoffTerminal(handoffRequest(f));
  assert.equal(outcome, 'opened'); assert.equal(f.dialogs.length, 0, 'no second approval flow inside the port');
  const scoped = f.processes.at(-1); assert.equal(scoped.command, f.powershell);
  assert.equal(scoped.options.env.ARCANE_LOCAL_TOKEN, TOKEN); assert.equal(scoped.options.env.ARCANE_DAEMON_URL, f.state.origin);
  const { outer, inner } = launcherScripts(scoped);
  for (const text of [JSON.stringify(scoped.args), outer, inner]) { assert.ok(!text.includes(TOKEN), 'credential absent'); assert.ok(!text.includes(secret)); }
  for (const arg of ['--mcp-config', 'arcane.mcp.json', '--strict-mcp-config', "'--model' 'opus'", "'--effort' 'high'", "'--permission-mode' 'default'"]) assert.ok(inner.includes(arg), arg);
  assert.ok(inner.includes(f.claude));
  f.processes.length = 0; const plain = await f.host.launch('claude'); assert.match(plain.message, /Native Claude Code terminal requested/);
  const plainLauncher = f.processes.at(-1), plainScripts = launcherScripts(plainLauncher);
  assert.ok(!Object.keys(plainLauncher.options.env).some(key => key.startsWith('ARCANE_')), 'plain launch env has no Arcane overlay');
  assert.deepEqual({ ...scoped.options.env, ARCANE_LOCAL_TOKEN: undefined, ARCANE_DAEMON_URL: undefined }, { ...plainLauncher.options.env, ARCANE_LOCAL_TOKEN: undefined, ARCANE_DAEMON_URL: undefined },
    'the scoped env is exactly the preserved plain environment plus the fixed overlay');
  assert.ok(plainScripts.inner.endsWith('& ' + "'" + f.claude + "'"), 'plain launch: no injected args or model');
  assert.ok(!JSON.stringify(plain).includes(TOKEN));
});

test('malformed or unauthorised handoff requests fail before any process', async () => {
  const f = await handoffFixture(), good = handoffRequest(f);
  const argv = (index, value) => { const copy = [...good.argv]; copy[index] = value; return copy; };
  for (const [what, request] of [['extra flag', { ...good, argv: [...good.argv, '--dangerously-skip-permissions'] }], ['model not offered', { ...good, argv: argv(4, 'haiku') }],
    ['effort not offered', { ...good, argv: argv(6, 'ultra') }], ['permission mode', { ...good, argv: argv(8, 'bypassPermissions') }], ['config name', { ...good, argv: argv(1, 'C:\\x\\other.json') }],
    ['relative config', { ...good, argv: argv(1, 'arcane.mcp.json') }], ['token in argv', { ...good, argv: argv(1, 'C:\\' + TOKEN + '\\arcane.mcp.json') }],
    ['human 64-hex token', { ...good, env: { ...good.env, ARCANE_LOCAL_TOKEN: 'a'.repeat(64) } }], ['extra env', { ...good, env: { ...good.env, ANTHROPIC_API_KEY: 'x' } }],
    ['other daemon', { ...good, env: { ...good.env, ARCANE_DAEMON_URL: 'http://127.0.0.1:1' } }], ['other project', { ...good, projectPath: 'C:\\Projects\\other' }],
    ['missing epoch', (({ epoch, ...rest }) => rest)(good)], ['proxy request', new Proxy(good, {})], ['accessor env', Object.defineProperty({ ...good }, 'env', { get() { return good.env; }, enumerable: true })]])
    assert.equal(await f.host.launchHandoffTerminal(request), 'failed', what);
  assert.equal(f.processes.length + f.dialogs.length, 0);
  const stale = await handoffFixture(); stale.host.cancelPending(); assert.equal(await stale.host.launchHandoffTerminal(handoffRequest(stale)), 'failed', 'stale metadata');
  const linux = await handoffFixture({ platform: 'linux' }); assert.equal(await linux.host.launchHandoffTerminal(handoffRequest(linux)), 'failed', 'unverified platform');
  assert.equal(stale.processes.length + linux.processes.length, 0);
});

test('launcher failure is failed; timeout and post-launch context change are unknown; busy refuses; never opened without a clean launcher exit', async () => {
  const outcomes = [];
  for (const reply of [{ code: 1 }, { error: true }, { hang: true }]) {
    const f = await handoffFixture(); f.state.reply = command => command === f.powershell ? reply : null;
    outcomes.push(await f.host.launchHandoffTerminal(handoffRequest(f)));
    if (reply.hang) assert.equal(f.children.at(-1).killed, 'SIGKILL', 'timed-out launcher helper is killed');
  }
  assert.deepEqual(outcomes, ['failed', 'failed', 'unknown']);
  const moved = await handoffFixture(); moved.state.reply = command => { if (command === moved.powershell) { moved.put('C:\\Projects\\other'); moved.state.project = 'C:\\Projects\\other'; } return null; };
  assert.equal(await moved.host.launchHandoffTerminal(handoffRequest(moved)), 'unknown', 'context changed after the launcher started');
  const busy = await handoffFixture(); busy.state.reply = () => ({ hang: true }); const pending = busy.host.status('codex');
  assert.equal(await busy.host.launchHandoffTerminal(handoffRequest(busy)), 'failed'); await pending;
  assert.ok(!busy.processes.some(item => item.command === busy.powershell), 'busy: no launcher');
});


// ---- D4-027: bounded trusted handoff metadata freshness ----
// The REAL provider-setup source runs in an isolated VM realm whose only clock is a controlled `performance`
// (no global clock mutation, no sleeps). Documented boundary: eligible for 0 <= elapsed < 60000 ms after the
// successful verified help read; expired at exactly 60000 ms; expiry is sticky until a later explicit status.
const sourceText = readFileSync(new URL('../../apps/desktop/electron/provider-setup.cjs', import.meta.url), 'utf8');
const nodeModules = { 'node:fs/promises': require('node:fs/promises'), 'node:path': require('node:path'), 'node:os': require('node:os'), 'node:util': require('node:util') };
function clockedHost(settings = {}, help = HELP, clockGlobals) {
  const f = fixture(settings), clock = { now: 1000 };
  const globals = clockGlobals ? clockGlobals(clock) : { performance: { now: () => clock.now } };
  const module = { exports: {} };
  const context = vm.createContext({ module, Buffer, URL, setTimeout, clearTimeout, process: { platform: 'win32', arch: 'x64', env: {} }, ...globals,
    require(name) { if (name === 'node:child_process') return { spawn() { assert.fail('module-level spawn'); } }; if (nodeModules[name]) return nodeModules[name]; assert.fail('unexpected import: ' + name); } });
  vm.runInContext(sourceText, context);
  const host = module.exports.createProviderSetup(f.options);
  f.state.reply = (command, args) => args[0] === '--help' ? { code: 0, stdout: help } : null;
  // Trusted envelopes must be plain objects of the module's own realm.
  const realmJson = vm.runInContext('JSON', context), inRealm = value => realmJson.parse(JSON.stringify(value));
  const plainJson = value => JSON.parse(JSON.stringify(value));
  return { ...f, host, clock, inRealm, plainJson };
}

test('trusted handoff metadata is eligible for 0 <= elapsed < 60 s and sticky-expired at exactly 60 s; only an explicit status restores it', async () => {
  const f = clockedHost(); f.clock.now = 1000; await f.host.status('claude');
  const choices = f.plainJson(f.host.getHandoffChoices());
  assert.deepEqual(choices, { cliVersion: '2.1.211', aliases: ['fable', 'opus', 'sonnet'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }, 'elapsed 0');
  f.clock.now = 1000 + 59999; assert.deepEqual(f.plainJson(f.host.getHandoffChoices()), choices, 'elapsed 59999 ms: still eligible');
  const processes = f.processes.length;
  f.clock.now = 1000 + 60000; assert.equal(f.host.getHandoffChoices(), null, 'elapsed exactly 60000 ms: expired');
  for (const later of [1000 + 1, 1000 + 30000, 1000 + 59999, 1000 + 120000]) { f.clock.now = later; assert.equal(f.host.getHandoffChoices(), null, 'sticky at ' + later); }
  assert.equal(f.processes.length, processes, 'expiry never auto-probes, refreshes or renews');
  const snapshotAfter = await f.host.status('codex'); assert.ok(!('claudeChoices' in snapshotAfter));
  assert.equal(f.host.getHandoffChoices(), null, 'a status read for another provider does not renew Claude metadata');
  f.clock.now = 500000; await f.host.status('claude');
  assert.deepEqual(f.plainJson(f.host.getHandoffChoices()), choices, 'a fresh explicit Claude status restores eligibility');
  f.clock.now = 500000 + 59999; assert.ok(f.host.getHandoffChoices()); f.clock.now = 500000 + 60000; assert.equal(f.host.getHandoffChoices(), null, 'the new observation has its own fixed bound');
});

test('backward, non-finite, negative, throwing or missing clocks make metadata ineligible without corrupting legacy auth or snapshots', async () => {
  const back = clockedHost(); back.clock.now = 5000; await back.host.status('claude'); assert.ok(back.host.getHandoffChoices());
  back.clock.now = 4999; assert.equal(back.host.getHandoffChoices(), null, 'backward reading');
  back.clock.now = 5000; assert.equal(back.host.getHandoffChoices(), null, 'a returning clock does not revive');
  const later = clockedHost(); later.clock.now = 5000; await later.host.status('claude');
  later.clock.now = Number.NaN; assert.equal(later.host.getHandoffChoices(), null, 'NaN after observation'); later.clock.now = 5001; assert.equal(later.host.getHandoffChoices(), null, 'sticky after NaN');
  for (const [what, clockGlobals] of [['NaN', () => ({ performance: { now: () => Number.NaN } })], ['Infinity', () => ({ performance: { now: () => Infinity } })],
    ['negative', () => ({ performance: { now: () => -1 } })], ['string', () => ({ performance: { now: () => '1000' } })],
    ['throwing', () => ({ performance: { now() { throw new Error('clock'); } } })], ['missing performance', () => ({})]]) {
    const f = clockedHost({}, HELP, clockGlobals), value = await f.host.status('claude');
    snapshot(value, 'claude');
    assert.deepEqual([value.auth, value.cliVersion, f.plainJson(value.claudeChoices)?.aliases], ['subscription', '2.1.211', ['fable', 'opus', 'sonnet']], what + ': legacy auth and display metadata intact');
    assert.equal(f.host.getHandoffChoices(), null, what + ': trusted metadata ineligible');
    assert.match((await f.host.launch('claude')).message, /Native Claude Code terminal requested/, what + ': plain launch unchanged');
  }
});

test('expired metadata refuses confirmHandoff before any dialog and launchHandoffTerminal before any spawn', async () => {
  const f = clockedHost(); f.clock.now = 1000; await f.host.status('claude');
  assert.equal(await f.host.confirmHandoff(f.inRealm(profile()), f.inRealm(session(f))), true, 'fresh metadata: one confirmation'); assert.equal(f.dialogs.length, 1);
  f.processes.length = 0; assert.equal(await f.host.launchHandoffTerminal(f.inRealm(handoffRequest(f))), 'opened', 'fresh metadata: scoped launch'); assert.equal(f.processes.length, 1);
  f.processes.length = 0; f.clock.now = 1000 + 60000;
  assert.equal(await f.host.confirmHandoff(f.inRealm(profile()), f.inRealm(session(f))), false); assert.equal(f.dialogs.length, 1, 'no dialog after expiry');
  assert.equal(await f.host.launchHandoffTerminal(f.inRealm(handoffRequest(f))), 'failed'); assert.equal(f.processes.length, 0, 'no spawn after expiry');
  const during = clockedHost(); during.clock.now = 1000; await during.host.status('claude');
  during.state.beforeConfirm = () => { during.clock.now = 1000 + 60000; };
  assert.equal(await during.host.confirmHandoff(during.inRealm(profile()), during.inRealm(session(during))), false, 'expiry during the dialog');
  assert.equal(during.dialogs.length, 1);
});
