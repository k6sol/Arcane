import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { win32, posix } from 'node:path';
import vm from 'node:vm';
import { StringDecoder } from 'node:string_decoder';

// Run production source, without loading Electron or touching native provider state.
// Extraction includes the factory accessors and the entire IPC registration loop;
// the policy and helper guards are never replaced by permissive test equivalents.
const source = name => readFileSync(new URL('../../apps/desktop/electron/' + name, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const mainSource = source('main.cjs');
const preloadSource = source('preload.cjs');
const helperSource = source('provider-setup.cjs');
const loginSource = source('provider-login.cjs');
const policySource = source('policy.cjs');
function between(text, start, end) {
  const first = text.indexOf(start), last = text.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, 'Production extraction markers must exist in order.');
  assert.equal(text.indexOf(start, first + start.length), -1, 'Production extraction start must be unique.');
  return text.slice(first, last);
}
const wiring = between(mainSource, '      providerSetup = createProviderSetup(', '      // Electron can create the profile');
const declarations = [
  /^let window, child,.*;$/m.exec(mainSource)?.[0],
  /^let codeVerification, projectSession, providerSetup;$/m.exec(mainSource)?.[0],
];
assert.ok(declarations.every(Boolean), 'Use the actual main-process state declarations.');
const policy = vm.runInNewContext(between(policySource, 'function validOrigin(origin) {', '\nfunction requestAllowed(') +
  '\n({ validOrigin, navigationAllowed })', { URL }, { filename: 'provider-setup-ipc-policy.cjs', timeout: 1000 });

const actions = ['status', 'login', 'install', 'launch'];
const providers = ['codex', 'claude'];
const channels = actions.map(action => 'arcane:provider-' + action);
const fields = ['auth', 'busy', 'cliVersion', 'installed', 'message', 'provider', 'version'];
const origin = 'http://127.0.0.1:45871';
const home = 'C:\\ProviderSetupFixture\\Home';
const project = 'C:\\ProviderSetupFixture\\Project';
const tools = 'C:\\ProviderSetupFixture\\Tools';
const system = 'C:\\ProviderSetupFixture\\Windows';
const sensitive = 'synthetic-only-private-output@example.invalid';
const unavailable = 'Native provider setup unavailable.';
const hostUnavailable = 'Provider setup is unavailable. No completion was verified.';
const bounded = { timeout: 5000 };
const json = value => JSON.parse(JSON.stringify(value));
const loginId = 'a1223344-5566-7788-99aa-bbccddeeff00';
const appServerArgs = ['app-server', '--listen', 'stdio://', '--disable', 'apps', '--disable', 'plugins',
  '--disable', 'remote_plugin', '--disable', 'skill_mcp_dependency_install'];
const signedIn = { account: { type: 'chatgpt', planType: 'pro', email: sensitive }, requiresOpenaiAuth: true };
function authUrl() {
  const url = new URL('https://auth.openai.com/oauth/authorize');
  for (const [key, value] of Object.entries({ client_id: 'app_native_codex_fixture', response_type: 'code',
    redirect_uri: 'http://localhost:1455/auth/callback', scope: 'openid profile email offline_access',
    state: 'opaque-fixture-state-0123456789', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' })) url.searchParams.set(key, value);
  return url.href;
}

function fakeWindow(url = origin + '/studio#' + 'a'.repeat(64)) {
  const mainFrame = { url };
  const contents = Object.assign(new EventEmitter(), { mainFrame, destroyed: false, isDestroyed() { return this.destroyed; } });
  return Object.assign(new EventEmitter(), { webContents: contents, destroyed: false, isDestroyed() { return this.destroyed; } });
}

function fixture({ smoke = false } = {}) {
  const hooks = {}, handlers = new Map(), entries = new Map();
  const calls = [], dispatches = [], hostReplies = [], processes = [], metadata = [], dialogs = [], urls = [], nativeFallbacks = [], factoryCalls = [];
  const rpc = [];
  let loginChild;
  const key = value => win32.normalize(value).toLowerCase();
  function put(value, kind = 'directory', attributes = {}) {
    entries.set(key(value), { full: win32.normalize(value), kind, ...attributes });
  }
  const codex = win32.join(tools, 'codex.exe');
  const claude = win32.join(home, '.local', 'bin', 'claude.exe');
  const powershell = win32.join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  for (const directory of [home, project, tools]) put(directory);
  for (const executable of [codex, claude, powershell]) put(executable, 'file');
  function entry(value) {
    const found = entries.get(key(value));
    if (!found) throw Object.assign(new Error(sensitive), { code: 'ENOENT' });
    return found;
  }
  const fs = {
    async realpath(value) {
      metadata.push(['realpath', value]);
      await hooks.realpath?.(value);
      const found = entry(value);
      return found.target ?? found.full;
    },
    async stat(value) {
      metadata.push(['stat', value]);
      await hooks.stat?.(value);
      const found = entry(value);
      return { isFile: () => found.kind === 'file', isDirectory: () => found.kind === 'directory', mode: 0o755 };
    },
    async opendir(value) {
      metadata.push(['opendir', value]);
      entry(value);
      return (async function* () {
        for (const found of entries.values()) if (key(win32.dirname(found.full)) === key(value)) {
          yield { name: win32.basename(found.full), isDirectory: () => found.kind === 'directory' };
        }
      })();
    },
  };
  const forbid = name => () => {
    nativeFallbacks.push(name);
    throw new Error('Unexpected native boundary: ' + name);
  };
  function spawn(command, args, options) {
    const record = { command, args: Array.from(args), options: json(options) };
    processes.push(record);
    const index = processes.length;
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = signal => { record.killed = signal; };
    if (args[0] === 'app-server') {
      assert.equal(command, codex); assert.deepEqual(Array.from(args), appServerArgs);
      loginChild = child;
      child.stdin = new EventEmitter(); child.stdin.writable = true;
      child.stdin.end = () => { child.stdin.writable = false; };
      let reads = 0;
      child.stdin.write = line => {
        const request = JSON.parse(line); rpc.push(request);
        assert.ok(['initialize', 'initialized', 'account/read', 'account/login/start', 'account/login/cancel'].includes(request.method), 'No inference, model, signup or arbitrary native method');
        if (request.id === undefined) return true;
        queueMicrotask(() => {
          let result;
          if (request.method === 'initialize') result = { userAgent: 'arcane_provider_login/0.143.0 (Windows; x86_64) Arcane' };
          else if (request.method === 'account/read') result = hooks.account?.(++reads) ?? signedIn;
          else if (request.method === 'account/login/start') result = { type: 'chatgpt', loginId, authUrl: authUrl() };
          else result = { status: 'canceled' };
          child.stdout.emit('data', Buffer.from(JSON.stringify({ id: request.id, result }) + '\n'));
        });
        return true;
      };
      return child;
    }
    queueMicrotask(async () => {
      try {
        const reply = await hooks.reply?.(record, index) ?? (args[0] === '--version' ? {
          code: 0, stdout: command === claude ? '2.1.211 (Claude Code)\n' : 'codex-cli 0.143.0\n',
        } : args.join(' ') === 'login status' ? { code: 0, stderr: 'Logged in using ChatGPT\n' } :
          args.join(' ') === 'auth status --json' ? { code: 0, stdout: JSON.stringify({
            loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: sensitive,
            configDirectory: 'C:\\synthetic-private', subscriptionType: 'max',
          }) } : { code: 0 });
        if (reply.error) child.emit('error', new Error(sensitive));
        else {
          if (reply.stdout) child.stdout.emit('data', Buffer.from(reply.stdout));
          if (reply.stderr) child.stderr.emit('data', Buffer.from(reply.stderr));
          child.emit('close', reply.code ?? 0);
        }
      } catch (error) { child.emit('error', error); }
    });
    return child;
  }
  const module = { exports: {} };
  const loginModule = { exports: {} };
  vm.runInNewContext(loginSource, { module: loginModule, Buffer, URL, setTimeout, clearTimeout,
    require(name) { assert.equal(name, 'node:string_decoder'); return { StringDecoder }; },
  }, { filename: 'provider-login.cjs', timeout: 1000 });
  vm.runInNewContext(helperSource, {
    module, Buffer, URL, setTimeout, clearTimeout,
    process: { platform: 'win32', arch: 'x64', env: {} },
    require(name) {
      if (name === 'node:path') return { win32, posix };
      if (name === 'node:fs/promises') return { realpath: forbid('realpath'), stat: forbid('stat'), opendir: forbid('opendir') };
      if (name === 'node:child_process') return { spawn: forbid('spawn') };
      if (name === 'node:os') return { homedir: forbid('homedir') };
      if (name === './provider-login.cjs') return loginModule.exports;
      nativeFallbacks.push(name); throw new Error('Unexpected import: ' + name);
    },
  }, { filename: 'provider-setup.cjs', timeout: 1000 });
  const dialog = { async showMessageBox(window, options) {
    dialogs.push({ window, options: json(options) });
    return await hooks.dialog?.(window, options) ?? { response: 0 };
  } };
  const initialWindow = fakeWindow();
  const event = { sender: initialWindow.webContents, senderFrame: initialWindow.webContents.mainFrame };
  let invocationEvent = event, invokeFailure = null, dispatchFailure = null, exposed;
  const context = vm.createContext({
    URL, smoke, dialog, policy,
    __initial: { window: initialWindow, origin, projectPath: project, closing: false, switching: false },
    ipcMain: { handle(channel, handler) {
      assert.equal(handlers.has(channel), false, 'No duplicate provider handler.');
      handlers.set(channel, handler);
    } },
    createProviderSetup(options) {
      factoryCalls.push(options);
      // Only main-owned native dependencies are substituted. In particular, the
      // production getWindow/getOrigin/getProjectPath/enabled accessors survive.
      const host = module.exports.createProviderSetup({ ...options, fs, spawn,
        platform: 'win32', arch: 'x64', timeoutMs: 100, homedir: () => home,
        env: { PATH: tools, USERPROFILE: home, HOME: home, SystemRoot: system,
          OPENAI_API_KEY: sensitive, ANTHROPIC_API_KEY: sensitive, ARCANE_AGENT_TOKEN: sensitive,
          NODE_OPTIONS: '--require=synthetic.js', HTTP_PROXY: sensitive },
        openExternal: async url => { urls.push(url); },
      });
      return Object.freeze(Object.fromEntries(actions.map(action => [action, (...args) => {
        dispatches.push([action, ...args]);
        if (dispatchFailure === 'sync') throw new Error(sensitive);
        if (dispatchFailure === 'async') return Promise.reject(new Error(sensitive));
        return host[action](...args).then(value => { hostReplies.push(value); return value; });
      }])));
    },
  });
  const stateNames = ['window', 'origin', 'projectPath', 'closing', 'switching'];
  vm.runInContext(declarations.join('\n') + '\n' +
    'globalThis.__setState = next => {' + stateNames.map(name =>
      `if (Object.hasOwn(next, '${name}')) ${name} = next.${name};`).join('\n') + '};\n' +
    'globalThis.__state = () => ({' + stateNames.join(',') + '});\n' +
    '__setState(__initial);\n' + wiring,
  context, { filename: 'provider-setup-main-wiring.cjs', timeout: 1000 });
  vm.runInNewContext(preloadSource, { require(name) {
    assert.equal(name, 'electron', 'The sandboxed preload imports only Electron.');
    return { contextBridge: { exposeInMainWorld(name, value) {
      assert.equal(name, 'arcaneDesktop'); assert.equal(exposed, undefined); exposed = value;
    } }, ipcRenderer: { invoke(channel, ...args) {
      calls.push([channel, ...args]);
      if (invokeFailure === 'sync') throw new Error(sensitive);
      if (invokeFailure === 'async') return Promise.reject(new Error(sensitive));
      assert.ok(handlers.has(channel), 'Only an actually registered provider channel is invoked.');
      // Electron serializes results across IPC: main-process Object.freeze does
      // not turn the renderer's returned snapshot into a frozen shared object.
      return Promise.resolve(handlers.get(channel)(invocationEvent, ...args)).then(value => structuredClone(value));
    } } };
  } }, { filename: 'provider-setup-preload.cjs', timeout: 1000 });
  return { bridge: exposed.providerSetup, exposed, handlers, factoryCalls, dialog, event, window: initialWindow,
    calls, dispatches, hostReplies, processes, metadata, dialogs, urls, nativeFallbacks, hooks, entries, put, rpc,
    notifyLogin() { assert.ok(loginChild); loginChild.stdout.emit('data', Buffer.from(JSON.stringify({ method: 'account/login/completed', params: { loginId, success: true, error: null } }) + '\n')); },
    codex, claude, powershell, state: context.__state, update: context.__setState,
    setEvent: value => { invocationEvent = value; },
    failInvoke: value => { invokeFailure = value; }, failDispatch: value => { dispatchFailure = value; },
  };
}

function snapshot(value, provider, message) {
  const keys = Object.keys(value).sort();
  if (provider === 'claude' && keys.includes('claudeChoices')) {
    assert.deepEqual(keys, [...fields, 'claudeChoices'].sort());
    if (value.claudeChoices !== null) {
      assert.deepEqual(Object.keys(value.claudeChoices).sort(), ['aliases', 'cliVersion', 'efforts']);
      assert.equal(value.claudeChoices.cliVersion, value.cliVersion);
      assert.ok(Array.isArray(value.claudeChoices.aliases) && Array.isArray(value.claudeChoices.efforts));
      assert.equal(Object.isFrozen(value.claudeChoices), false, 'IPC serializes the private metadata snapshot.');
    }
  } else assert.deepEqual(keys, fields);
  assert.equal(value.version, 1); assert.equal(value.provider, provider);
  assert.equal(typeof value.installed, 'boolean'); assert.equal(typeof value.busy, 'boolean');
  assert.ok(['unknown', 'signed-out', 'subscription', 'api-or-cloud'].includes(value.auth));
  assert.ok(value.cliVersion === null || typeof value.cliVersion === 'string');
  assert.ok(value.message === null || typeof value.message === 'string');
  assert.equal(Object.isFrozen(value), false, 'IPC returns a serialized snapshot, not the main-process object.');
  assert.equal(JSON.stringify(value).includes(sensitive), false);
  if (message !== undefined) assert.equal(value.message, message);
}
function inert(f) {
  assert.equal(f.dispatches.length, 0); assert.equal(f.metadata.length, 0);
  assert.equal(f.processes.length, 0); assert.equal(f.dialogs.length, 0);
  assert.equal(f.urls.length, 0); assert.deepEqual(f.nativeFallbacks, []);
}

test('non-null Claude help metadata survives IPC as detached presentation data', bounded, async () => {
  const f = fixture();
  const help = "Options:\n  --effort <level>  Choose low, high, or max\n  --model <model>  Use 'opus' or 'sonnet'\n  -n, --name <name>  Name this session\n";
  f.hooks.reply = record => record.args[0] === '--help' ? { code: 0, stdout: help } : null;
  const value = await f.bridge.status('claude'); snapshot(value, 'claude');
  assert.deepEqual(value.claudeChoices, { cliVersion: '2.1.211', aliases: ['opus', 'sonnet'], efforts: ['low', 'high', 'max'] });
  const original = f.hostReplies.at(-1).claudeChoices;
  assert.ok(Object.isFrozen(original) && Object.isFrozen(original.aliases) && Object.isFrozen(original.efforts));
  value.claudeChoices.aliases.push('changed');
  assert.deepEqual(Array.from(original.aliases), ['opus', 'sonnet']);
  assert.equal(JSON.stringify(value).includes(sensitive), false);
});
async function denied(pending) {
  await assert.rejects(pending, error => {
    assert.equal(error.message, unavailable); assert.equal(error.message.includes(sensitive), false);
    return true;
  });
}
const invalidArguments = () => [
  [], [undefined], [null], [true], [0], [Symbol('codex')], ['Codex'], ['claude '], ['codex\n'],
  ['--version'], ['status'], ['C:\\arbitrary\\codex.exe'], ['codex; arbitrary-command'],
  [new String('codex')], [['codex']], [{ provider: 'codex' }], [{ toString: () => 'claude' }],
  [{ path: 'C:\\arbitrary', command: 'arbitrary-command', args: ['--unsafe'], url: 'https://example.invalid' }],
  ['codex', undefined], ['claude', { projectPath: 'C:\\arbitrary', flags: ['--unsafe'] }],
  ['codex', 'login', 'C:\\arbitrary'],
];
const changes = [
  ['closing', f => f.update({ closing: true })],
  ['switching', f => f.update({ switching: true })],
  ['window replaced', f => f.update({ window: fakeWindow() })],
  ['window removed', f => f.update({ window: null })],
  ['window destroyed', f => { f.window.destroyed = true; }],
  ['origin replaced', f => f.update({ origin: 'http://127.0.0.1:45872' })],
  ['project replaced', f => f.update({ projectPath: 'C:\\ProviderSetupFixture\\OtherProject' })],
];

test('actual parent factory wires trusted context and revokes getWindow on closing/switching', bounded, () => {
  const f = fixture();
  assert.deepEqual([...f.handlers.keys()], channels); assert.equal(f.factoryCalls.length, 1);
  const options = f.factoryCalls[0];
  assert.deepEqual(Object.keys(options).sort(), ['dialog', 'enabled', 'getOrigin', 'getProjectPath', 'getWindow']);
  assert.equal(options.dialog, f.dialog); assert.equal(options.enabled, true);
  assert.equal(options.getWindow(), f.window); assert.equal(options.getOrigin(), origin); assert.equal(options.getProjectPath(), project);
  for (const flag of ['closing', 'switching']) {
    f.update({ [flag]: true }); assert.equal(options.getWindow(), null, flag + ' must revoke helper scope before window destruction');
    f.update({ [flag]: false }); assert.equal(options.getWindow(), f.window);
  }
  const nextProject = 'C:\\ProviderSetupFixture\\NextProject';
  f.update({ projectPath: nextProject }); assert.equal(options.getProjectPath(), nextProject);
  inert(f);
});

test('real preload exposes a frozen versioned enum-only provider bridge', bounded, () => {
  const f = fixture();
  assert.equal(Object.isFrozen(f.exposed), true); assert.equal(Object.isFrozen(f.bridge), true);
  assert.equal(f.bridge.version, 1); assert.equal(f.exposed.runtime, 'desktop');
  assert.deepEqual(Object.keys(f.bridge).sort(), [...actions, 'version'].sort());
  for (const action of actions) assert.equal(typeof f.bridge[action], 'function');
  inert(f);
});

test('all four preload intents reach the real parent handler and helper with one provider enum', bounded, async () => {
  const f = fixture();
  for (const action of actions) for (const provider of providers) snapshot(await f.bridge[action](provider), provider);
  assert.deepEqual(f.calls, actions.flatMap(action => providers.map(provider => ['arcane:provider-' + action, provider])));
  assert.deepEqual(f.dispatches, actions.flatMap(action => providers.map(provider => [action, provider])));
  assert.equal(f.hostReplies.length, 8); assert.equal(f.hostReplies.every(Object.isFrozen), true);
  const cached = await f.bridge.status('codex'); const before = f.processes.length;
  cached.provider = 'claude'; cached.installed = false; cached.auth = 'signed-out'; cached.cliVersion = 'renderer-injected';
  const next = await f.bridge.install('codex'); snapshot(next, 'codex');
  assert.equal(next.installed, true); assert.equal(next.auth, 'subscription'); assert.equal(next.cliVersion, '0.143.0');
  assert.equal(f.processes.length, before, 'Renderer mutation cannot change the host cache or trigger a probe.');
  assert.equal(f.urls.length, 0); assert.deepEqual(f.nativeFallbacks, []);
});

test('preload rejects missing, malformed, coercible, path/command and extra arguments before IPC', bounded, async () => {
  const f = fixture();
  for (const action of actions) for (const args of invalidArguments()) {
    let pending; assert.doesNotThrow(() => { pending = f.bridge[action](...args); });
    await denied(pending);
  }
  assert.equal(f.calls.length, 0); inert(f);
});

test('direct IPC cannot bypass enum validation or supply paths, flags, commands or extra arguments', bounded, async () => {
  const f = fixture();
  for (const channel of channels) for (const args of invalidArguments()) await denied(f.handlers.get(channel)(f.event, ...args));
  inert(f);
});

test('IPC requires identity of the owner webContents and its top frame, not matching URLs', bounded, async () => {
  const f = fixture(), other = fakeWindow();
  const badEvents = [undefined, null, {}, { ...f.event, sender: other.webContents },
    { ...f.event, sender: { ...f.event.sender } }, { ...f.event, sender: null },
    { ...f.event, senderFrame: { url: f.event.senderFrame.url } },
    { ...f.event, senderFrame: { url: f.event.senderFrame.url, parent: f.event.senderFrame } },
    { ...f.event, senderFrame: other.webContents.mainFrame }, { ...f.event, senderFrame: null }];
  for (const channel of channels) for (const event of badEvents) await denied(f.handlers.get(channel)(event, 'claude'));
  f.window.webContents.mainFrame = { url: f.event.senderFrame.url };
  for (const channel of channels) await denied(f.handlers.get(channel)(f.event, 'codex'));
  inert(f);
});

test('closing, switching, missing or destroyed owner contents stop every IPC intent before helper entry', bounded, async () => {
  const mutations = [f => f.update({ closing: true }), f => f.update({ switching: true }),
    f => f.update({ window: null }), f => f.update({ window: {} }),
    f => { f.window.webContents.destroyed = true; }, f => f.update({ window: fakeWindow() })];
  for (const mutate of mutations) {
    const f = fixture(); mutate(f);
    for (const channel of channels) await denied(f.handlers.get(channel)(f.event, 'claude'));
    inert(f);
  }
});

test('IPC rejects noncanonical URLs, other origins, subroutes, credentials and query strings', bounded, async () => {
  const f = fixture();
  const urls = ['http://localhost:45871/studio', 'http://[::1]:45871/studio', 'http://127.0.0.1:45872/studio',
    'http://127.0.0.1:045871/studio', 'http://127.000.000.001:45871/studio', 'HTTP://127.0.0.1:45871/studio',
    'http://user:pass@127.0.0.1:45871/studio', origin + '/studio?x=1', origin + '/studio/',
    origin + '/a/../studio', origin + '/%73tudio', origin + '/v1/product/state',
    ' ' + origin + '/studio', origin + '/stu\ndio', 'https://example.invalid/studio', 'file:///C:/fixture',
    'data:text/html,fixture', 'not a URL', '', undefined, null, 17];
  for (const url of urls) {
    f.event.senderFrame.url = url;
    for (const channel of channels) await denied(f.handlers.get(channel)(f.event, 'codex'));
  }
  inert(f);
});

test('IPC uses the current canonical trusted origin rather than a renderer-provided origin', bounded, async () => {
  const f = fixture();
  for (const value of ['', 'https://127.0.0.1:45871', 'http://localhost:45871', 'http://127.0.0.1:045871',
    'http://127.0.0.1:65536', origin + '/', origin + '#fixture', 'http://127.0.0.1:45872', undefined, null]) {
    f.update({ origin: value });
    for (const channel of channels) await denied(f.handlers.get(channel)(f.event, 'claude'));
  }
  inert(f);
});

test('canonical root/studio documents and fragment credentials remain valid owner frames', bounded, async () => {
  const f = fixture();
  for (const suffix of ['/', '/studio', '/studio#' + 'b'.repeat(64), '/#fixture']) {
    f.event.senderFrame.url = origin + suffix;
    const value = await f.bridge.status('codex'); snapshot(value, 'codex');
    assert.equal(value.auth, 'subscription'); assert.equal(value.cliVersion, '0.143.0');
  }
  assert.equal(f.dispatches.length, 4); assert.equal(f.processes.length, 8);
  assert.deepEqual(f.nativeFallbacks, []);
});

test('the actual parent supplies the current project; project-resolved executables are refused', bounded, async () => {
  const f = fixture(), nextProject = 'C:\\ProviderSetupFixture\\NextProject';
  f.put(nextProject); f.update({ projectPath: nextProject });
  const inside = win32.join(nextProject, 'codex.exe');
  f.put(inside, 'file'); f.put(f.codex, 'file', { target: inside });
  const value = await f.bridge.status('codex'); snapshot(value, 'codex');
  assert.equal(value.installed, false); assert.equal(value.auth, 'unknown');
  assert.ok(f.metadata.some(([operation, path]) => operation === 'realpath' && path === nextProject));
  assert.equal(f.metadata.some(([, path]) => path === project), false);
  assert.equal(f.processes.length, 0); assert.deepEqual(f.nativeFallbacks, []);
});

test('helper context revocation after executable resolution blocks subsequent native work through IPC', bounded, async () => {
  for (const action of ['status', 'login', 'launch']) for (const [label, change] of changes) {
    const f = fixture(); let changed = false;
    f.hooks.realpath = value => { if (value === f.claude) { changed = true; change(f); } };
    const value = await f.bridge[action]('claude'); snapshot(value, 'claude', hostUnavailable);
    assert.equal(changed, true, 'The executable-resolution await must be reached.');
    assert.equal(value.auth, 'unknown', action + ': ' + label);
    assert.equal(f.processes.length, 0); assert.equal(f.dialogs.length, 0); assert.equal(f.urls.length, 0);
    assert.deepEqual(f.nativeFallbacks, []);
  }
});

test('helper context revocation after cwd resolution blocks probes and confirmation through IPC', bounded, async () => {
  for (const action of ['status', 'login', 'launch']) for (const [label, change] of changes) {
    const f = fixture(); let projectChecks = 0, changed = false;
    f.hooks.stat = value => {
      if (value === project) projectChecks++;
      if (action === 'launch' ? value === project && projectChecks === 2 : value === home) { changed = true; change(f); }
    };
    const value = await f.bridge[action]('claude'); snapshot(value, 'claude', hostUnavailable);
    assert.equal(changed, true, 'The cwd-resolution await must be reached.');
    assert.equal(value.auth, 'unknown', action + ': ' + label);
    assert.equal(f.processes.length, 0); assert.equal(f.dialogs.length, 0); assert.equal(f.urls.length, 0);
    assert.deepEqual(f.nativeFallbacks, []);
  }
});

test('post-version and post-auth scope checks discard stale replies without another native helper', bounded, async () => {
  for (const stage of [1, 2]) for (const [label, change] of changes) {
    const f = fixture(); let changed = false;
    f.hooks.reply = (_record, index) => { if (index === stage) { changed = true; change(f); } };
    const value = await f.bridge.status('claude'); snapshot(value, 'claude', hostUnavailable);
    assert.equal(changed, true, 'The requested native reply await must be reached.');
    assert.equal(value.auth, 'unknown', label); assert.equal(value.cliVersion, null);
    assert.equal(f.processes.length, stage); assert.equal(f.dialogs.length, 0); assert.equal(f.urls.length, 0);
    assert.deepEqual(f.nativeFallbacks, []);
  }
});

test('post-confirmation closing/switching and context changes revoke install/login/launch through the actual seam', bounded, async () => {
  for (const action of ['install', 'login', 'launch']) for (const [label, change] of changes) {
    const f = fixture();
    f.hooks.dialog = () => { change(f); return { response: 1 }; };
    const value = await f.bridge[action]('claude'); snapshot(value, 'claude', hostUnavailable);
    assert.equal(value.auth, 'unknown', action + ': ' + label);
    assert.equal(f.dialogs.length, 1); assert.equal(f.processes.length, 0); assert.equal(f.urls.length, 0);
    assert.deepEqual(f.nativeFallbacks, []);
  }
});

test('post-confirmation executable recheck and terminal resolution recheck scope before synthetic spawn', bounded, async () => {
  for (const action of ['login', 'launch']) for (const stage of ['executable', 'terminal']) for (const [label, change] of changes) {
    const f = fixture(); let approved = false, changed = false;
    f.hooks.dialog = () => { approved = true; return { response: 1 }; };
    f.hooks.realpath = value => {
      if (approved && value === (stage === 'executable' ? f.claude : f.powershell)) { changed = true; change(f); }
    };
    const value = await f.bridge[action]('claude'); snapshot(value, 'claude', hostUnavailable);
    assert.equal(changed, true, 'The requested post-confirmation resolution await must be reached.');
    assert.equal(value.auth, 'unknown', action + ': ' + stage + ': ' + label);
    assert.equal(f.dialogs.length, 1); assert.equal(f.processes.length, 0); assert.equal(f.urls.length, 0);
    assert.deepEqual(f.nativeFallbacks, []);
  }
});

test('closing/switching during a pending dialog revokes the still-live original window and unchanged project', bounded, async () => {
  for (const flag of ['closing', 'switching']) {
    const f = fixture(); let entered, release;
    const atDialog = new Promise(resolve => { entered = resolve; });
    f.hooks.dialog = () => { entered(); return new Promise(resolve => { release = resolve; }); };
    const pending = f.bridge.install('claude'); await atDialog;
    try {
      f.update({ [flag]: true });
      assert.equal(f.state().window, f.window); assert.equal(f.window.isDestroyed(), false);
      assert.equal(f.window.webContents.isDestroyed(), false); assert.equal(f.state().projectPath, project);
      assert.equal(f.state().origin, origin);
      assert.equal(f.factoryCalls[0].getWindow(), null, 'The actual parent accessor must revoke the suspended scope.');
    } finally { release({ response: 1 }); }
    const value = await pending; snapshot(value, 'claude', hostUnavailable);
    assert.equal(value.auth, 'unknown'); assert.equal(value.busy, false);
    assert.equal(f.dispatches.length, 1); assert.equal(f.dialogs.length, 1);
    assert.equal(f.processes.length, 0); assert.equal(f.urls.length, 0); assert.equal(f.metadata.length, 0);
    assert.deepEqual(f.nativeFallbacks, []);
  }
});

test('parent verification mode disables all provider methods without metadata, dialogs or processes', bounded, async () => {
  const f = fixture({ smoke: true }); assert.equal(f.factoryCalls[0].enabled, false);
  for (const action of actions) for (const provider of providers) {
    const value = await f.bridge[action](provider); snapshot(value, provider);
    assert.deepEqual(json(value), { version: 1, provider, installed: false, auth: 'unknown', cliVersion: null,
      busy: false, message: 'CLI setup checks are disabled in verification mode.' });
  }
  assert.equal(f.dispatches.length, 8); assert.equal(f.metadata.length, 0);
  assert.equal(f.processes.length, 0); assert.equal(f.dialogs.length, 0); assert.equal(f.urls.length, 0);
  assert.deepEqual(f.nativeFallbacks, []);
});

test('parent and preload sanitize synchronous and asynchronous failures on every action', bounded, async () => {
  for (const boundary of ['dispatch', 'invoke']) for (const failure of ['sync', 'async']) {
    const f = fixture();
    if (boundary === 'dispatch') f.failDispatch(failure); else f.failInvoke(failure);
    for (const action of actions) {
      let pending; assert.doesNotThrow(() => { pending = f.bridge[action]('codex'); }); await denied(pending);
      if (boundary === 'dispatch') await denied(f.handlers.get('arcane:provider-' + action)(f.event, 'claude'));
    }
    assert.equal(f.metadata.length, 0); assert.equal(f.processes.length, 0);
    assert.equal(f.dialogs.length, 0); assert.equal(f.urls.length, 0); assert.deepEqual(f.nativeFallbacks, []);
  }
});

test('one in-flight native confirmation fences every bridge action and releases cleanly after cancel', bounded, async () => {
  const f = fixture(); let release, entered;
  const atDialog = new Promise(resolve => { entered = resolve; });
  f.hooks.dialog = () => { entered(); return new Promise(resolve => { release = resolve; }); };
  const first = f.bridge.install('codex'); await atDialog;
  try {
    for (const action of actions) {
      const value = await f.bridge[action]('claude'); snapshot(value, 'claude');
      assert.equal(value.busy, true); assert.equal(value.message, 'Another provider setup action is in progress.');
    }
    assert.equal(f.dialogs.length, 1); assert.equal(f.metadata.length, 0); assert.equal(f.processes.length, 0); assert.equal(f.urls.length, 0);
  } finally { release({ response: 0 }); }
  assert.equal((await first).busy, false);
  f.hooks.dialog = () => ({ response: 0 });
  assert.equal((await f.bridge.install('claude')).busy, false); assert.equal(f.dialogs.length, 2);
  assert.deepEqual(f.nativeFallbacks, []);
});

function terminalScript(record) {
  assert.deepEqual(record.args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
  assert.equal(record.args.length, 5);
  const launcher = Buffer.from(record.args[4], 'base64').toString('utf16le');
  const encoded = /'-EncodedCommand', '([A-Za-z0-9+/=]+)'/.exec(launcher)?.[1];
  assert.ok(encoded); assert.match(launcher, /-WindowStyle Normal/);
  assert.match(launcher, /'-NoLogo', '-NoProfile', '-NoExit'/);
  return { launcher, inner: Buffer.from(encoded, 'base64').toString('utf16le') };
}

test('successful IPC operations use only fixed probes/pages/vendor intents and main-owned paths/environment', bounded, async () => {
  const f = fixture();
  for (const provider of providers) {
    const value = await f.bridge.status(provider); snapshot(value, provider);
    assert.equal(value.auth, 'subscription');
  }
  assert.deepEqual(f.processes.map(record => [record.command, record.args, record.options.cwd]), [
    [f.codex, ['--version'], home], [f.codex, ['login', 'status'], home],
    [f.claude, ['--version'], home], [f.claude, ['auth', 'status', '--json'], home], [f.claude, ['--help'], home],
  ]);
  f.hooks.dialog = () => ({ response: 1 });
  for (const provider of providers) snapshot(await f.bridge.install(provider), provider);
  assert.deepEqual(f.urls, ['https://learn.chatgpt.com/docs/codex/cli', 'https://code.claude.com/docs/en/setup']);
  assert.equal(f.processes.length, 5);
  f.hooks.account = read => read === 1 ? { account: null, requiresOpenaiAuth: true } : signedIn;
  const pending = await f.bridge.login('codex'); snapshot(pending, 'codex');
  assert.equal(pending.auth, 'unknown'); assert.equal(pending.busy, true);
  assert.deepEqual(f.urls, ['https://learn.chatgpt.com/docs/codex/cli', 'https://code.claude.com/docs/en/setup', authUrl()]);
  assert.deepEqual(f.rpc.map(request => request.method), ['initialize', 'initialized', 'account/read', 'account/login/start']);
  assert.deepEqual(f.rpc[0].params, { clientInfo: { name: 'arcane_provider_login', title: 'Arcane', version: '1.0.0' }, capabilities: null });
  assert.deepEqual(f.rpc[2].params, { refreshToken: false }); assert.deepEqual(f.rpc[3].params, { type: 'chatgpt' });
  const beforePoll = f.processes.length;
  const poll = await f.bridge.status('codex'); snapshot(poll, 'codex');
  assert.equal(poll.auth, 'unknown'); assert.equal(poll.busy, true); assert.equal(f.processes.length, beforePoll);
  f.notifyLogin(); await new Promise(resolve => setImmediate(resolve));
  const completed = await f.bridge.status('codex'); snapshot(completed, 'codex');
  assert.equal(completed.auth, 'subscription'); assert.equal(completed.busy, false);
  assert.deepEqual(f.rpc.at(-1).params, { refreshToken: false });
  assert.equal(f.processes.at(-1).killed, 'SIGKILL');
  assert.ok(f.hostReplies.every(value => !JSON.stringify(value).includes(loginId) && !JSON.stringify(value).includes('https://auth.')));
  const claudeLogin = await f.bridge.login('claude'); snapshot(claudeLogin, 'claude'); assert.equal(claudeLogin.auth, 'unknown');
  const nextProject = "C:\\ProviderSetupFixture\\O'Brien; $(synthetic)`&";
  f.put(nextProject); f.update({ projectPath: nextProject });
  const launched = await f.bridge.launch('claude'); snapshot(launched, 'claude'); assert.equal(launched.auth, 'unknown');
  const expected = [
    "$ErrorActionPreference = 'Stop'; Set-Location -LiteralPath '" + home + "'; & '" + f.claude + "' 'auth' 'login'",
    "$ErrorActionPreference = 'Stop'; Set-Location -LiteralPath '" + nextProject.replaceAll("'", "''") + "'; & '" + f.claude + "'",
  ];
  assert.deepEqual(f.processes[5].args, ['--version']);
  assert.equal(f.processes[6].command, f.codex); assert.deepEqual(f.processes[6].args, appServerArgs);
  for (const [index, record] of f.processes.slice(7).entries()) {
    assert.equal(record.command, f.powershell);
    const scripts = terminalScript(record); assert.equal(scripts.inner, expected[index]);
    assert.equal(/ExecutionPolicy|Bypass|setup-token|--console|--with-api-key|device-auth|Invoke-Expression|RunAs|curl/.test(scripts.launcher + scripts.inner), false);
  }
  const before = f.processes.length;
  const noHandoff = await f.bridge.launch('codex'); snapshot(noHandoff, 'codex');
  assert.equal(noHandoff.message, 'Native client handoff is available only for Claude Code.'); assert.equal(f.processes.length, before);
  for (const record of f.processes) {
    assert.equal(record.options.shell, false); assert.equal(record.options.windowsHide, true);
    assert.deepEqual(record.options.stdio, record.args[0] === 'app-server' ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe']);
    assert.deepEqual(Object.keys(record.options.env).sort(), ['HOME', 'PATH', 'SystemRoot', 'USERPROFILE']);
    assert.equal(JSON.stringify(record.options.env).includes(sensitive), false);
  }
  for (const confirmation of f.dialogs) {
    assert.equal(confirmation.window, f.window);
    assert.equal(confirmation.options.defaultId, 0); assert.equal(confirmation.options.cancelId, 0);
    assert.equal(confirmation.options.buttons[0], 'Cancel');
  }
  assert.deepEqual(f.nativeFallbacks, []);
});
