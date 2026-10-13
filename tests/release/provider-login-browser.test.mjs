import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { StringDecoder } from 'node:string_decoder';
import { win32 } from 'node:path';

const require = createRequire(import.meta.url);
const { createCodexBrowserLogin } = require('../../apps/desktop/electron/provider-login.cjs');
const { createProviderSetup } = require('../../apps/desktop/electron/provider-setup.cjs');
const VERSION = '0.162.0-alpha.17.2';
const LOGIN = 'a1223344-5566-7788-99aa-bbccddeeff00';
const OTHER = 'b1223344-5566-7788-99aa-bbccddeeff00';
const APP_SERVER_ARGS = ['app-server', '--listen', 'stdio://', '--disable', 'apps', '--disable', 'plugins',
  '--disable', 'remote_plugin', '--disable', 'skill_mcp_dependency_install'];
const SECRET = 'never-public-fixture-account@example.invalid';
const signedOut = { account: null, requiresOpenaiAuth: true, workspaceRouting: null };
const signedIn = { account: { type: 'chatgpt', email: SECRET, planType: 'prolite' }, requiresOpenaiAuth: true, workspaceRouting: null };
const tick = () => new Promise(resolve => setImmediate(resolve));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function authUrl(changes = {}) {
  const url = new URL('https://auth.openai.com/oauth/authorize');
  for (const [key, value] of Object.entries({ client_id: 'app_native_codex_fixture', response_type: 'code',
    redirect_uri: 'http://localhost:1455/auth/callback', scope: 'openid profile email offline_access',
    state: 'opaque-fixture-state-0123456789', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256', ...changes })) {
    if (value !== null) url.searchParams.set(key, value);
  }
  return url.href;
}

function fixture(settings = {}) {
  const calls = [], processes = [], urls = [], changes = [], children = [], accesses = [], dialogs = [];
  const window = new EventEmitter(); window.isDestroyed = () => false; window.webContents = new EventEmitter();
  const state = { current: true, window, project: 'C:\\Projects\\Arcane', origin: 'http://127.0.0.1:45123', accountReads: 0,
    response: 1, loggedIn: false };
  const home = 'C:\\Users\\fixture', command = 'C:\\Tools\\codex.exe';
  const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  let child;
  function emit(value, target = child) { target.stdout.emit('data', Buffer.from(JSON.stringify(value) + '\n')); }
  function raw(value) { child.stdout.emit('data', Buffer.from(value)); }
  const notify = (params = { loginId: LOGIN, success: true, error: null }) => emit({ method: 'account/login/completed', params });
  function spawn(executable, args, options) {
    processes.push({ executable, args, options });
    const process = new EventEmitter(); process.stdout = new EventEmitter(); process.stderr = new EventEmitter();
    process.stdin = new EventEmitter(); process.stdin.writable = true;
    process.kills = 0; process.kill = signal => { process.kills++; process.signal = signal; };
    process.stdin.end = () => { process.stdin.writable = false; process.ended = true; };
    children.push(process);
    if (args[0] !== 'app-server') {
      queueMicrotask(() => {
        if (args[0] === '--version') process.stdout.emit('data', Buffer.from(`codex-cli ${settings.version ?? VERSION}\n`));
        else if (args.join(' ') === 'login status') process.stderr.emit('data', Buffer.from(state.loggedIn ? 'Logged in using ChatGPT\n' : 'Not logged in\n'));
        process.emit('close', args.join(' ') === 'login status' && !state.loggedIn ? 1 : 0);
      });
      return process;
    }
    child = process;
    process.stdin.write = line => {
      const request = JSON.parse(line); calls.push(request);
      queueMicrotask(() => {
        if (settings.respond?.(request, { emit, raw, notify, state, child: process }) === true) return;
        if (request.id === undefined) return;
        let result;
        if (request.method === 'initialize') result = { userAgent: `arcane_provider_login/${VERSION} (Windows; x86_64) Arcane`, codexHome: home, platformFamily: 'windows', platformOs: 'windows' };
        else if (request.method === 'account/read') result = ++state.accountReads === 1 ? settings.existing ?? signedOut : settings.after ?? signedIn;
        else if (request.method === 'account/login/start') result = settings.loginResult ?? { type: 'chatgpt', loginId: LOGIN, authUrl: settings.url ?? authUrl() };
        else if (request.method === 'account/login/cancel') result = { status: 'canceled' };
        else assert.fail('Unexpected native method: ' + request.method);
        emit({ id: request.id, result }, process);
        if (settings.early && request.method === 'account/login/start') notify(settings.early === true ? undefined : settings.early);
      });
      return true;
    };
    return process;
  }
  const openExternal = async url => { urls.push(url); return settings.open?.({ state, notify, child }); };
  const session = createCodexBrowserLogin({ spawn, command, cwd: home, env: { PATH: 'C:\\Tools' }, cliVersion: VERSION,
    openExternal, isCurrent: () => state.current, onChange: value => changes.push(value), rpcTimeoutMs: 80,
    loginTimeoutMs: settings.loginTimeoutMs ?? 500 });
  const entries = new Set([home, state.project, 'C:\\Tools', command, powershell]);
  const fs = {
    async realpath(value) { accesses.push(value); if (!entries.has(value)) throw new Error(SECRET); return value; },
    async stat(value) { return { isFile: () => value.endsWith('.exe'), isDirectory: () => !value.endsWith('.exe'), mode: 0o755 }; },
    async opendir() { throw new Error(SECRET); },
  };
  const options = { spawn, fs, platform: 'win32', homedir: () => home, timeoutMs: 80,
    loginTimeoutMs: settings.loginTimeoutMs ?? 500, getWindow: () => state.window,
    getOrigin: () => state.origin, getProjectPath: () => state.project,
    env: { PATH: 'C:\\Tools', SystemRoot: 'C:\\Windows', USERPROFILE: home, HOME: home,
      OPENAI_API_KEY: SECRET, CODEX_ACCESS_TOKEN: SECRET, ARCANE_AGENT_TOKEN: SECRET, HTTP_PROXY: SECRET, NODE_OPTIONS: SECRET },
    openExternal, dialog: { async showMessageBox(owner, config) { dialogs.push({ owner, config }); return { response: state.response }; } } };
  const host = createProviderSetup(options);
  return { session, host, options, state, calls, processes, urls, changes, children, accesses, dialogs, notify, emit, raw,
    get child() { return child; } };
}

function publicValue(value) {
  const text = JSON.stringify(value);
  for (const item of [SECRET, LOGIN, 'https://auth.', 'opaque-fixture-state', 'code_challenge', 'codexHome']) assert.ok(!text.includes(item), item);
}
function cleaned(f) {
  assert.equal(f.child.kills, 1); assert.equal(f.child.signal, 'SIGKILL'); assert.equal(f.child.ended, true);
  assert.equal(f.child.stdout.listenerCount('data'), 0); assert.equal(f.child.stderr.listenerCount('data'), 0);
  assert.equal(f.child.listenerCount('close'), 0);
  for (const value of f.changes) publicValue(value);
  assert.equal(f.calls.filter(value => /^(turn\/|thread\/|model\/|command\/)/.test(value.method)).length, 0, 'inference count 0');
  assert.ok(f.calls.every(value => ['initialize', 'initialized', 'account/read', 'account/login/start', 'account/login/cancel'].includes(value.method)));
}

test('helper import and construction are inert and only export the private native client', () => {
  const source = readFileSync(new URL('../../apps/desktop/electron/provider-login.cjs', import.meta.url), 'utf8');
  const module = { exports: {} };
  vm.runInNewContext(source, { module, Buffer, URL, setTimeout, clearTimeout,
    require(name) { assert.equal(name, 'node:string_decoder'); return { StringDecoder }; } });
  const inert = () => assert.fail('native effect during construction');
  const session = module.exports.createCodexBrowserLogin({ spawn: inert, openExternal: inert, isCurrent: inert, onChange: inert });
  assert.ok(Object.isFrozen(session)); assert.deepEqual(Object.keys(module.exports), ['createCodexBrowserLogin']);
});

test('browser login owns stdio, opens only in main, and requires completion plus fresh account ACK; inference 0', async () => {
  const f = fixture(); const result = await f.session.start();
  publicValue(result); assert.equal(result.pending, true); assert.equal(result.auth, 'unknown');
  assert.deepEqual(f.processes[0].args, APP_SERVER_ARGS);
  assert.deepEqual(f.processes[0].options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(f.processes[0].options.shell, false); assert.equal(f.processes[0].options.windowsHide, true);
  assert.deepEqual(f.calls.map(value => value.method), ['initialize', 'initialized', 'account/read', 'account/login/start']);
  assert.deepEqual(f.calls.at(-1).params, { type: 'chatgpt' }); assert.deepEqual(f.urls, [authUrl()]);
  f.emit({ method: 'account/updated', params: { authMode: 'chatgpt', planType: 'pro' } });
  assert.equal(f.session.status().auth, 'unknown'); assert.equal(f.state.accountReads, 1);
  f.notify(); await tick(); assert.equal(f.session.status().auth, 'subscription'); assert.equal(f.state.accountReads, 2);
  assert.deepEqual(f.calls.at(-1).params, { refreshToken: false }); cleaned(f);
});

test('existing native ChatGPT sign-in never starts another login or opens the browser', async () => {
  const f = fixture({ existing: signedIn }); const result = await f.session.start();
  assert.equal(result.auth, 'subscription'); assert.equal(result.pending, false); publicValue(result);
  assert.equal(f.urls.length, 0); assert.ok(!f.calls.some(value => value.method === 'account/login/start')); cleaned(f);
});

test('API/cloud, unknown plan, malformed and unmanaged account results never select another auth or billing route', async () => {
  for (const [existing, expected] of [[{ ...signedOut, account: { type: 'apiKey' } }, 'api-or-cloud'],
    [{ ...signedOut, account: { type: 'amazonBedrock', usesCodexManagedCredentials: true } }, 'api-or-cloud'],
    [{ ...signedIn, account: { ...signedIn.account, planType: 'unknown' } }, 'unknown'],
    [{ ...signedOut, requiresOpenaiAuth: false }, 'unknown'], [{ account: null }, 'unknown'], [[], 'unknown']]) {
    const f = fixture({ existing }); assert.equal((await f.session.start()).auth, expected);
    assert.equal(f.urls.length, 0); assert.ok(!f.calls.some(value => value.method === 'account/login/start')); cleaned(f);
  }
});

test('changed native version, identity, malformed initialization or control bytes refuse browser authority', async () => {
  for (const result of [{ userAgent: 'arcane_provider_login/0.1.0 (Windows)' }, { userAgent: 'other/0.162.0-alpha.17.2 (Windows)' },
    { userAgent: `arcane_provider_login/${VERSION} \n${SECRET}` }, {}, null]) {
    const f = fixture({ respond(request, api) {
      if (request.method !== 'initialize') return false;
      api.emit({ id: request.id, result }); return true;
    } });
    const value = await f.session.start(); assert.equal(value.auth, 'unknown'); assert.equal(value.unsupported, false);
    assert.equal(f.urls.length, 0); assert.equal(f.calls.length, 1); cleaned(f);
  }
});

test('authorization URL allowlist refuses hostile origins, redirects, ports, duplicates and malformed PKCE/state', async () => {
  const bad = [authUrl().replace('auth.openai.com', 'auth.openai.com.evil.invalid'), authUrl().replace('https:', 'http:'),
    authUrl().replace('auth.openai.com', 'user:password@auth.openai.com'), authUrl().replace('auth.openai.com', 'auth.openai.com:444'),
    authUrl().replace('/oauth/authorize', '/other'), authUrl() + '#secret', authUrl() + '&state=duplicate',
    authUrl() + '&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback',
    authUrl({ redirect_uri: 'http://localhost.evil.invalid:1455/auth/callback' }),
    authUrl({ redirect_uri: 'http://0.0.0.0:1455/auth/callback' }), authUrl({ redirect_uri: 'https://localhost:1455/auth/callback' }),
    authUrl({ redirect_uri: 'http://localhost/auth/callback' }), authUrl({ redirect_uri: 'http://localhost:1455/other' }),
    authUrl({ redirect_uri: 'http://user:pass@localhost:1455/auth/callback' }),
    authUrl({ redirect_uri: 'http://localhost:1455/auth/callback?code=secret' }),
    authUrl({ redirect_uri: 'http://localhost:1455/auth/callback#secret' }),
    authUrl({ redirect_uri: 'http://127.1:1455/auth/callback' }), authUrl({ response_type: 'token' }),
    authUrl({ state: 'short' }), authUrl({ state: null }), authUrl({ state: 'a'.repeat(20) + '\n' }),
    authUrl({ code_challenge: null }), authUrl({ code_challenge_method: 'plain' }), authUrl({ client_id: null }),
    authUrl({ scope: 'email' }), authUrl() + '&extra=%00secret', 'https://chatgpt.com/', 'file:///C:/evil',
    'javascript:alert(1)', authUrl() + 'a'.repeat(8192), authUrl().replace('/oauth', '\\oauth'), ' ' + authUrl()];
  for (const url of bad) {
    const f = fixture({ url }); const value = await f.session.start(); await tick();
    assert.equal(value.auth, 'unknown'); assert.equal(value.unsupported, false); assert.equal(f.urls.length, 0, url);
    assert.deepEqual(f.calls.at(-1).params, { loginId: LOGIN }); assert.equal(f.calls.at(-1).method, 'account/login/cancel'); cleaned(f);
  }
});

test('native owned loopback callback variations pass without Arcane opening a callback listener', async () => {
  for (const redirect_uri of ['http://127.0.0.1:1455/auth/callback', 'http://[::1]:1455/auth/callback', 'http://localhost:43210/auth/callback']) {
    const f = fixture({ url: authUrl({ redirect_uri }) }); assert.equal((await f.session.start()).pending, true);
    f.session.cancel(); await tick(); cleaned(f);
  }
});

test('wrong login result types and IDs never open the browser or invent owned cancellation IDs', async () => {
  for (const loginResult of [{ type: 'chatgpt', loginId: OTHER.replaceAll('-', ''), authUrl: authUrl() },
    { type: 'chatgpt', loginId: null, authUrl: authUrl() }, { type: 'apiKey', loginId: LOGIN, authUrl: authUrl() },
    { type: 'chatgptDeviceCode', loginId: LOGIN, verificationUrl: authUrl(), userCode: SECRET }, {}, null]) {
    const f = fixture({ loginResult, respond(request, api) {
      if (request.method !== 'account/login/start') return false;
      api.emit({ id: request.id, result: loginResult }); return true;
    } });
    assert.equal((await f.session.start()).auth, 'unknown'); assert.equal(f.urls.length, 0);
    assert.ok(!f.calls.some(value => value.method === 'account/login/cancel')); cleaned(f);
  }
});

test('only explicit method-not-found ACK establishes an unsupported browser contract', async () => {
  for (const method of ['initialize', 'account/read', 'account/login/start']) for (const code of [-32601, -32602, -32000]) {
    const f = fixture({ respond(request, api) {
      if (request.method !== method) return false;
      api.emit({ id: request.id, error: { code, message: SECRET } }); return true;
    } });
    const result = await f.session.start(); assert.equal(result.unsupported, code === -32601);
    assert.equal(result.auth, 'unknown'); assert.equal(f.urls.length, 0); publicValue(result); cleaned(f);
    assert.equal(f.calls.filter(value => value.method === method).length, 1, 'no retry');
  }
});

test('unsupported ACK after context loss or malformed output never authorizes terminal fallback', async () => {
  for (const mode of ['context', 'malformed', 'close']) {
    const f = fixture({ respond(request, api) {
      if (request.method !== 'account/login/start') return false;
      api.emit({ id: request.id, error: { code: -32601, message: SECRET } });
      if (mode === 'context') api.state.current = false;
      else if (mode === 'malformed') api.raw('not-json\n');
      else api.child.emit('close', 1);
      return true;
    } });
    const result = await f.session.start();
    assert.equal(result.unsupported, false, mode); assert.equal(result.auth, 'unknown');
    assert.equal(f.urls.length, 0); cleaned(f);
  }
});

test('false, malformed, foreign or duplicate completion fails closed with only the owned login cancelled', async () => {
  for (const params of [{ loginId: OTHER, success: true, error: null }, { loginId: null, success: true, error: null },
    { loginId: LOGIN, success: false, error: SECRET }, { loginId: LOGIN, success: 'true', error: null },
    { loginId: LOGIN, success: true, error: SECRET }, { loginId: LOGIN, success: true }, null]) {
    const f = fixture(); await f.session.start(); f.notify(params); await tick();
    assert.equal(f.session.status().auth, 'unknown'); publicValue(f.session.status());
    assert.deepEqual(f.calls.at(-1).params, { loginId: LOGIN }); cleaned(f);
  }
  const f = fixture({ respond(request) { return request.method === 'account/read' && request.id !== 2; } });
  await f.session.start(); f.notify(); f.notify(); await tick(); assert.equal(f.session.status().auth, 'unknown'); cleaned(f);
});

test('completion needs a fresh recognized ChatGPT account response, never cached green', async () => {
  for (const after of [signedOut, { ...signedOut, account: { type: 'apiKey' } }, { ...signedIn, account: { type: 'chatgpt', planType: 'unknown' } }, {}, []]) {
    const f = fixture({ after }); await f.session.start(); f.notify(); await tick();
    assert.equal(f.state.accountReads, 2); assert.equal(f.session.status().auth, 'unknown'); cleaned(f);
  }
});

test('RPC wrong IDs, server requests, malformed JSON and overlarge output cannot establish authority', async () => {
  for (const output of [JSON.stringify({ id: 99, result: {} }) + '\n', JSON.stringify({ id: '1', result: {} }) + '\n',
    JSON.stringify({ id: 1, method: 'turn/start', params: {} }) + '\n', JSON.stringify({ id: 1, result: {}, error: {} }) + '\n',
    'not-json ' + SECRET + '\n', 'x'.repeat(32769)]) {
    const f = fixture({ respond(request, api) { if (request.method !== 'initialize') return false; api.raw(output); return true; } });
    assert.equal((await f.session.start()).auth, 'unknown'); assert.equal(f.urls.length, 0); cleaned(f);
  }
});

test('split stdio JSON and completion arriving alongside the start ACK are handled without losing verification', async () => {
  const f = fixture({ early: true, respond(request, api) {
    if (request.method !== 'initialize') return false;
    const bytes = Buffer.from(JSON.stringify({ id: request.id, result: { userAgent: `arcane_provider_login/${VERSION} fixture-é` } }) + '\n');
    const at = bytes.indexOf(Buffer.from('é')) + 1;
    api.child.stdout.emit('data', bytes.subarray(0, at)); api.child.stdout.emit('data', bytes.subarray(at)); return true;
  } });
  await f.session.start(); await tick(); assert.equal(f.session.status().auth, 'subscription'); cleaned(f);
  const bad = fixture({ early: { loginId: OTHER, success: true, error: null } });
  assert.equal((await bad.session.start()).auth, 'unknown'); await tick(); assert.equal(bad.urls.length, 0); cleaned(bad);
});

test('browser rejection or a hanging openExternal settles boundedly and cancels only the owned native login', async () => {
  for (const open of [() => { throw new Error(SECRET); }, () => new Promise(() => {})]) {
    const f = fixture({ open, loginTimeoutMs: 10 }); const value = await f.session.start(); await tick();
    assert.equal(value.auth, 'unknown'); assert.equal(value.pending, false); publicValue(value);
    assert.equal(f.urls.length, 1); cleaned(f);
  }
});

test('malformed early or duplicate completion during browser opening cannot bypass the open/verification sequence', async () => {
  const early = fixture({ respond(request, api) {
    if (request.method !== 'account/login/start') return false;
    api.emit({ id: request.id, result: { type: 'chatgpt', loginId: LOGIN, authUrl: authUrl() } });
    api.notify(null); return true;
  } });
  assert.equal((await early.session.start()).auth, 'unknown'); assert.equal(early.urls.length, 0); cleaned(early);
  const duplicate = fixture({ open({ notify }) { notify(); notify(); return new Promise(() => {}); } });
  assert.equal((await duplicate.session.start()).auth, 'unknown'); assert.equal(duplicate.state.accountReads, 1); cleaned(duplicate);
});

test('native login expiry cancels once, stops process, ignores late success and never retries', async () => {
  const f = fixture({ loginTimeoutMs: 10 }); await f.session.start(); await delay(25);
  assert.match(f.session.status().message, /expired/); f.notify(); f.session.cancel(); await tick();
  assert.equal(f.session.status().auth, 'unknown'); assert.equal(f.calls.filter(value => value.method === 'account/login/cancel').length, 1);
  assert.equal(f.calls.filter(value => value.method === 'account/login/start').length, 1); cleaned(f);
});

test('cancel ACK timeout is bounded, duplicate actions stay locked during cleanup, and owner dispose kills immediately', async () => {
  const f = fixture({ loginTimeoutMs: 10, respond(request) { return request.method === 'account/login/cancel'; } });
  await f.host.login('codex'); await delay(20);
  assert.equal((await f.host.login('codex')).busy, true); assert.equal(f.processes.length, 2);
  await delay(100); const before = f.processes.length, result = await f.host.status('codex');
  assert.equal(result.busy, false); assert.equal(result.auth, 'unknown'); assert.match(result.message, /expired/);
  assert.equal(f.processes.length, before, 'final RPC failure delivered before any fresh CLI probe'); cleaned(f);
  const disposed = fixture({ respond(request) { return request.method === 'account/login/cancel'; } });
  await disposed.host.login('codex'); disposed.host.dispose(); cleaned(disposed);
  const count = disposed.processes.length; assert.equal((await disposed.host.login('codex')).auth, 'unknown');
  assert.equal(disposed.processes.length, count);
});

test('host delivers wrong-ID completion failure even if independent native storage subsequently reports sign-in', async () => {
  const f = fixture(); await f.host.login('codex'); f.state.loggedIn = true;
  f.notify({ loginId: OTHER, success: true, error: null }); await tick();
  const before = f.processes.length, result = await f.host.status('codex');
  assert.equal(result.auth, 'unknown'); assert.match(result.message, /No completion was verified/);
  assert.equal(f.processes.length, before); cleaned(f);
  assert.equal((await f.host.status('codex')).auth, 'subscription', 'later explicit refresh uses actual native status');
});

test('cancellation during a pending login/start response fences a late browser URL without guessing an ID', async () => {
  let release;
  const f = fixture({ respond(request, api) {
    if (request.method !== 'account/login/start') return false;
    release = () => api.emit({ id: request.id, result: { type: 'chatgpt', loginId: LOGIN, authUrl: authUrl() } });
    return true;
  } });
  const pending = f.host.login('codex'); await tick(); assert.equal(typeof release, 'function');
  f.host.cancelPending(); release(); const result = await pending;
  assert.equal(result.auth, 'unknown'); assert.equal(f.urls.length, 0); cleaned(f);
  assert.ok(!f.calls.some(value => value.method === 'account/login/cancel'));
});

test('unknown RPC outcomes and stdin/stdout/process errors never retry or fall back', async () => {
  for (const mode of ['timeout', 'stdin', 'stdout', 'stderr', 'process', 'close', 'stderr-cap']) {
    const f = fixture({ respond(request, api) {
      if (request.method !== 'initialize') return false;
      if (mode === 'close') api.child.emit('close', 1);
      else if (mode === 'stderr-cap') api.child.stderr.emit('data', Buffer.from(SECRET.repeat(1000)));
      else if (mode !== 'timeout') (mode === 'process' ? api.child : api.child[mode]).emit('error', new Error(SECRET));
      return true;
    } });
    const value = await f.session.start(); assert.equal(value.auth, 'unknown'); assert.equal(value.unsupported, false);
    assert.equal(f.urls.length, 0); cleaned(f);
  }
});

test('context revocation before an ACK, during openExternal, and while browser waits prevents late authority', async () => {
  for (const method of ['initialize', 'account/read', 'account/login/start']) {
    const f = fixture({ respond(request, api) {
      if (request.method !== method) return false; api.state.current = false; api.emit({ id: request.id, result: {} }); return true;
    } });
    assert.equal((await f.session.start()).auth, 'unknown'); assert.equal(f.urls.length, 0); cleaned(f);
  }
  const f = fixture({ open({ state }) { state.current = false; } });
  assert.equal((await f.session.start()).auth, 'unknown'); await tick(); cleaned(f);
  const pending = fixture(); await pending.session.start(); pending.state.current = false; await delay(120);
  pending.notify(); assert.equal(pending.session.status().auth, 'unknown'); cleaned(pending);
});

test('host keeps the enumerable v1 API/response, scrubs env, polls pending without probing and locks duplicate actions', async () => {
  const f = fixture(); const result = await f.host.login('codex'); publicValue(result);
  assert.deepEqual(Object.keys(f.host).sort(), ['install', 'launch', 'login', 'status']);
  assert.deepEqual(Object.keys(result).sort(), ['auth', 'busy', 'cliVersion', 'installed', 'message', 'provider', 'version']);
  assert.equal(result.busy, true); assert.equal(result.auth, 'unknown'); assert.equal(result.cliVersion, VERSION);
  assert.deepEqual(f.processes.map(value => value.args), [['--version'], APP_SERVER_ARGS]);
  assert.ok(!JSON.stringify(f.processes.at(-1).options.env).includes(SECRET));
  const before = f.processes.length;
  for (const action of ['status', 'login', 'install', 'launch']) assert.equal((await f.host[action]('codex')).busy, true);
  assert.equal(f.processes.length, before); assert.equal(f.dialogs.length, 1);
  assert.deepEqual(f.dialogs[0].config.buttons, ['Cancel', 'Sign in']); assert.equal(f.dialogs[0].config.defaultId, 0);
  f.state.loggedIn = true; f.notify(); await tick(); const status = await f.host.status('codex');
  assert.equal(status.auth, 'subscription'); assert.equal(status.busy, false); publicValue(status); cleaned(f);
  assert.ok(!f.accesses.some(value => /auth\.json|config\.toml|credential/i.test(value)));
  assert.equal(f.state.window.listenerCount('closed'), 0); assert.equal(f.state.window.webContents.listenerCount('will-navigate'), 0);
});

test('host navigation, close, owner hooks and context switches cancel pending owned flows', async () => {
  for (const change of [f => f.state.window.emit('closed'), f => f.state.window.webContents.emit('destroyed'),
    f => f.state.window.webContents.emit('will-navigate', {}, 'https://evil.invalid'),
    f => f.state.window.webContents.emit('did-start-navigation', {}, 'http://127.0.0.1:45123/new', false, true),
    f => f.state.window.webContents.emit('render-process-gone'), f => f.host.cancelPending(), f => f.host.dispose(),
    f => { f.state.project = 'C:\\Other'; }, f => { f.state.origin = 'http://127.0.0.1:45124'; },
    f => { f.state.window = null; }]) {
    const f = fixture(); await f.host.login('codex'); const owner = f.state.window;
    change(f); await delay(120); f.notify(); await tick(); cleaned(f);
    assert.equal(owner.listenerCount('closed'), 0); assert.equal(owner.webContents.listenerCount('will-navigate'), 0);
    assert.ok(!f.changes.some(value => value.auth === 'subscription'));
  }
});

test('host cached native sign-in works without browser flow, and verification mode never loads/starts login', async () => {
  const f = fixture({ existing: signedIn }); const value = await f.host.login('codex');
  assert.equal(value.auth, 'subscription'); assert.equal(value.busy, false); assert.equal(f.urls.length, 0); cleaned(f);
  const inert = fixture(); const host = createProviderSetup({ ...inert.options, enabled: false });
  for (const action of ['status', 'login', 'install', 'launch']) {
    const value = await host[action]('codex'); assert.equal(value.auth, 'unknown'); assert.equal(value.installed, false);
  }
  host.cancelPending(); host.dispose(); assert.equal(inert.calls.length + inert.processes.length + inert.accesses.length + inert.urls.length, 0);
});

test('explicit unsupported RPC offers exact honest PowerShell fallback; unknown failure never opens terminal', async () => {
  for (const code of [-32601, -32000]) {
    const f = fixture({ respond(request, api) {
      if (request.method !== 'account/login/start') return false;
      api.emit({ id: request.id, error: { code, message: SECRET } }); return true;
    } });
    const value = await f.host.login('codex'); assert.equal(value.auth, 'unknown'); assert.equal(f.urls.length, 0); publicValue(value); cleaned(f);
    if (code === -32601) {
      assert.match(value.message, /unsupported.*Visible Codex login terminal requested/);
      assert.equal(f.dialogs.length, 2); assert.deepEqual(f.dialogs.at(-1).config.buttons, ['Cancel', 'Open terminal']);
      const process = f.processes.at(-1); assert.match(process.executable, /WindowsPowerShell.*powershell\.exe/);
      const launcher = Buffer.from(process.args.at(-1), 'base64').toString('utf16le');
      assert.match(launcher, /-WindowStyle Normal/);
      const encoded = /'-EncodedCommand', '([A-Za-z0-9+/=]+)'/.exec(launcher)[1];
      assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), "$ErrorActionPreference = 'Stop'; Set-Location -LiteralPath 'C:\\Users\\fixture'; & 'C:\\Tools\\codex.exe' 'login'");
    } else { assert.equal(f.processes.length, 2); assert.equal(f.dialogs.length, 1); }
  }
});

test('owner cancellation after an unsupported ACK cannot revive browser intent as a terminal handoff', async () => {
  const f = fixture({ respond(request, api) {
    if (request.method !== 'account/login/start') return false;
    api.emit({ id: request.id, error: { code: -32601, message: SECRET } });
    f.host.cancelPending(); return true;
  } });
  const result = await f.host.login('codex');
  assert.equal(result.auth, 'unknown'); assert.equal(result.busy, false);
  assert.equal(f.dialogs.length, 1); assert.equal(f.urls.length, 0);
  assert.deepEqual(f.processes.map(value => value.args), [['--version'], APP_SERVER_ARGS]);
  cleaned(f);
});
