'use strict';

// Private main-process stdio client. No HTTP listener, token handling, or inference.
const { StringDecoder } = require('node:string_decoder');
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const PLANS = new Set(['free', 'go', 'plus', 'pro', 'prolite', 'promax', 'team',
  'self_serve_business_prolite', 'self_serve_business_usage_based', 'business', 'ent26',
  'enterprise_cbp_automation', 'enterprise_cbp_usage_based', 'enterprise', 'edu', 'edu_plus', 'edu_pro']);
const FAILURE = 'Native browser sign-in stopped. No completion was verified. Check status before trying again.';
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function accountAuth(value) {
  if (!record(value) || typeof value.requiresOpenaiAuth !== 'boolean') return 'unknown';
  if (value.account === null) return value.requiresOpenaiAuth ? 'signed-out' : 'unknown';
  if (!record(value.account)) return 'unknown';
  if (value.account.type === 'apiKey' || value.account.type === 'amazonBedrock') return 'api-or-cloud';
  if (value.account.type === 'chatgpt' && PLANS.has(value.account.planType)) return 'subscription';
  return 'unknown';
}

function validAuthUrl(value) {
  if (typeof value !== 'string' || value !== value.trim() || value.length > 8192 || CONTROL.test(value) || value.includes('\\')) return false;
  try {
    const url = new URL(value);
    // Pin the known native Codex issuer and authorization endpoint. New endpoints
    // require review; a vendor suffix or an arbitrary ChatGPT page is not enough.
    if (url.origin !== 'https://auth.openai.com' || url.pathname !== '/oauth/authorize' ||
        url.username || url.password || url.hash) return false;
    for (const [key, item] of url.searchParams) {
      if (CONTROL.test(key + item) || url.searchParams.getAll(key).length !== 1) return false;
    }
    const callbackText = url.searchParams.get('redirect_uri');
    const callback = new URL(callbackText);
    if (callback.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(callback.hostname) ||
        !/^[1-9][0-9]{0,4}$/.test(callback.port) || Number(callback.port) > 65535 ||
        callback.pathname !== '/auth/callback' || callback.username || callback.password || callback.search || callback.hash ||
        callback.href !== callbackText) return false;
    const state = url.searchParams.get('state'), challenge = url.searchParams.get('code_challenge');
    return url.searchParams.get('response_type') === 'code' &&
      /^[A-Za-z0-9_-]{16,1024}$/.test(state ?? '') && /^[A-Za-z0-9_-]{43}$/.test(challenge ?? '') &&
      url.searchParams.get('code_challenge_method') === 'S256' &&
      /^[A-Za-z0-9_-]{1,256}$/.test(url.searchParams.get('client_id') ?? '') &&
      (url.searchParams.get('scope') ?? '').split(' ').includes('openid');
  } catch { return false; }
}

function createCodexBrowserLogin(options) {
  const { spawn, command, cwd, env, cliVersion, openExternal, isCurrent, onChange } = options;
  const rpcTimeoutMs = options.rpcTimeoutMs ?? 8000, loginTimeoutMs = options.loginTimeoutMs ?? 180000;
  if (![spawn, openExternal, isCurrent, onChange].every(value => typeof value === 'function') ||
      !Number.isInteger(rpcTimeoutMs) || rpcTimeoutMs < 1 || rpcTimeoutMs > 15000 ||
      !Number.isInteger(loginTimeoutMs) || loginTimeoutMs < 1 || loginTimeoutMs > 300000) {
    throw new Error('Provider setup request is unavailable.');
  }
  let child, stopped = false, closing = false, nextId = 1, loginId = null, earlyCompletion = null;
  let phase = 'starting', auth = 'unknown', message = null, buffer = '', bytes = 0, stderrBytes = 0;
  let loginTimer, contextTimer, stopTimer, completionSeen = false;
  let signalStopped;
  const stoppedSignal = new Promise(resolve => { signalStopped = resolve; });
  const pending = new Map(), decoder = new StringDecoder('utf8');
  const current = () => { try { return isCurrent() === true; } catch { return false; } };
  const snapshot = () => Object.freeze({ auth, message, pending: !stopped });
  function publish(nextAuth, nextMessage) {
    auth = nextAuth; message = nextMessage;
    onChange(snapshot());
  }
  function stop(notify = true) {
    if (stopped) return;
    stopped = true; clearTimeout(loginTimer); clearTimeout(contextTimer); clearTimeout(stopTimer);
    signalStopped();
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error(FAILURE)); }
    pending.clear(); buffer = ''; earlyCompletion = null;
    child?.stdout?.removeListener('data', data); child?.stderr?.removeListener('data', stderr);
    child?.removeListener('close', closed);
    try { child?.stdin?.end(); } catch { /* Child already exited. */ }
    try { child?.kill('SIGKILL'); } catch { /* Child already exited. */ }
    if (notify) onChange(snapshot());
  }
  function cancel(reason = 'Native browser sign-in was cancelled. No completion was verified.', immediate = false) {
    if (stopped || closing) return;
    closing = true; publish('unknown', reason);
    clearTimeout(loginTimer); clearTimeout(contextTimer);
    // Only this process's acknowledged login may be cancelled. Never sign out.
    if (loginId && child?.stdin?.writable !== false) {
      stopTimer = setTimeout(stop, Math.min(rpcTimeoutMs, 250));
      try {
        request('account/login/cancel', { loginId }, true).then(stop, stop);
      } catch { stop(); }
    } else stop();
    if (immediate) stop();
  }
  function closed() { if (!stopped) cancel(FAILURE); stop(); }
  function write(value) {
    if (!child?.stdin || child.stdin.writable === false) throw new Error(FAILURE);
    child.stdin.write(JSON.stringify(value) + '\n');
  }
  function request(method, params, cancelling = false) {
    if (stopped || (closing && !cancelling) || (!current() && !cancelling)) return Promise.reject(new Error(FAILURE));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(FAILURE)); cancel(FAILURE); }, rpcTimeoutMs);
      pending.set(id, { resolve, reject, timer, method });
      try { write({ id, method, params }); }
      catch { clearTimeout(timer); pending.delete(id); reject(new Error(FAILURE)); cancel(FAILURE); }
    });
  }
  async function completed(value) {
    if (stopped || closing || !current()) return cancel();
    if (!record(value) || value.loginId !== loginId || completionSeen || typeof value.success !== 'boolean' ||
        (value.error !== null && typeof value.error !== 'string')) return cancel(FAILURE);
    completionSeen = true;
    if (!value.success || value.error !== null) return cancel(FAILURE);
    phase = 'verifying';
    try {
      const result = await request('account/read', { refreshToken: false });
      if (stopped || closing || !current()) return cancel();
      if (accountAuth(result) !== 'subscription') return cancel(FAILURE);
      stop(false); publish('subscription', 'Native ChatGPT sign-in completed and account status was verified.');
    } catch { cancel(FAILURE); }
  }
  function packet(value) {
    if (!record(value) || (value.jsonrpc !== undefined && value.jsonrpc !== '2.0')) return cancel(FAILURE);
    if (Object.hasOwn(value, 'id')) {
      const entry = pending.get(value.id);
      if (!entry || Object.hasOwn(value, 'method') || Object.hasOwn(value, 'result') === Object.hasOwn(value, 'error')) return cancel(FAILURE);
      clearTimeout(entry.timer); pending.delete(value.id);
      if (Object.hasOwn(value, 'error')) {
        const unsupported = record(value.error) && value.error.code === -32601 &&
          (phase === 'starting' || (phase === 'login-requested' && entry.method === 'account/login/start'));
        entry.reject(Object.assign(new Error(FAILURE), { unsupported }));
      } else entry.resolve(value.result);
      return;
    }
    if (typeof value.method !== 'string') return cancel(FAILURE);
    if (value.method === 'account/login/completed') {
      const notification = value.params;
      if (!record(notification) || !UUID.test(notification.loginId ?? '') ||
          typeof notification.success !== 'boolean' || (notification.error !== null && typeof notification.error !== 'string') ||
          (loginId && notification.loginId !== loginId)) return cancel(FAILURE);
      if (['login-requested', 'opening'].includes(phase)) {
        if (earlyCompletion) return cancel(FAILURE);
        earlyCompletion = notification;
      } else if (loginId && phase === 'browser') void completed(notification);
      else cancel(FAILURE);
    }
    // account/updated alone is never proof. Other native notifications grant no authority.
  }
  function data(chunk) {
    if (stopped) return;
    if (!closing && !current()) return cancel();
    const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += input.length;
    if (bytes > 131072) return cancel(FAILURE);
    buffer += decoder.write(input);
    if (Buffer.byteLength(buffer) > 32768) return cancel(FAILURE);
    while (!stopped && buffer.includes('\n')) {
      const end = buffer.indexOf('\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try { packet(JSON.parse(line)); } catch { cancel(FAILURE); }
    }
  }
  function stderr(chunk) {
    stderrBytes += Buffer.byteLength(chunk);
    if (stderrBytes > 16384) cancel(FAILURE);
    // Discard native stderr; errors can contain URLs, account details, or tokens.
  }
  function checkContext() {
    if (stopped || closing) return;
    if (!current()) return cancel();
    contextTimer = setTimeout(checkContext, 100);
  }
  async function start() {
    let unsupported = false;
    try {
      if (!current()) throw new Error(FAILURE);
      child = spawn(command, ['app-server', '--listen', 'stdio://', '--disable', 'apps', '--disable', 'plugins',
        '--disable', 'remote_plugin', '--disable', 'skill_mcp_dependency_install'], {
        cwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.on('error', closed); child.once('close', closed);
      child.stdin.on('error', closed); child.stdout.on('error', closed); child.stderr.on('error', closed);
      child.stdout.on('data', data); child.stderr.on('data', stderr);
      checkContext();
      const initialized = await request('initialize', {
        clientInfo: { name: 'arcane_provider_login', title: 'Arcane', version: '1.0.0' }, capabilities: null,
      });
      if (!record(initialized) || typeof initialized.userAgent !== 'string' ||
          initialized.userAgent.length > 1024 || CONTROL.test(initialized.userAgent) ||
          !initialized.userAgent.startsWith('arcane_provider_login/' + cliVersion + ' ')) throw new Error(FAILURE);
      if (!current() || stopped || closing) throw new Error(FAILURE);
      write({ method: 'initialized', params: {} });
      const existing = accountAuth(await request('account/read', { refreshToken: false }));
      if (!current() || stopped || closing) throw new Error(FAILURE);
      if (existing !== 'signed-out') {
        stop(false); publish(existing, existing === 'subscription' ? 'Native CLI already reports ChatGPT sign-in.' :
          existing === 'api-or-cloud' ? 'Native CLI reports API or cloud authentication. Review sign-in in the native client; no request was started.' : FAILURE);
        return { ...snapshot(), unsupported: false };
      }
      phase = 'login-requested';
      let result;
      try { result = await request('account/login/start', { type: 'chatgpt' }); }
      catch (error) {
        // An explicit method-not-found ACK establishes that no login was started.
        if (error.unsupported) unsupported = true;
        throw error;
      }
      if (record(result) && result.type === 'chatgpt' && UUID.test(result.loginId ?? '')) loginId = result.loginId;
      if (!current() || stopped || closing || !record(result) || result.type !== 'chatgpt' || !loginId ||
          !validAuthUrl(result.authUrl)) throw new Error(FAILURE);
      if (earlyCompletion && (!record(earlyCompletion) || earlyCompletion.loginId !== loginId ||
          typeof earlyCompletion.success !== 'boolean' || earlyCompletion.error !== null || !earlyCompletion.success)) throw new Error(FAILURE);
      phase = 'opening';
      loginTimer = setTimeout(() => cancel('Native browser sign-in expired. No completion was verified. Check status before trying again.'), loginTimeoutMs);
      publish('unknown', 'Complete ChatGPT sign-in in your browser, then check status. Authentication is not yet verified.');
      // This is the only OAuth URL sink, supplied by trusted main-process code.
      await Promise.race([Promise.resolve(openExternal(result.authUrl)),
        stoppedSignal.then(() => { throw new Error(FAILURE); })]);
      if (!current() || closing) throw new Error(FAILURE);
      phase = 'browser';
      if (earlyCompletion && !stopped) { const notification = earlyCompletion; earlyCompletion = null; void completed(notification); }
      return { ...snapshot(), unsupported: false };
    } catch (error) {
      // An unsupported ACK cannot outlive revoked intent or a failed transport.
      unsupported = (unsupported || error.unsupported === true) && !loginId && !stopped && !closing && current();
      if (unsupported) { stop(false); publish('unknown', 'Native browser login RPC is unsupported.'); }
      else cancel(FAILURE);
      await stoppedSignal;
      return { ...snapshot(), unsupported };
    }
  }
  return Object.freeze({ start, status: snapshot, cancel });
}

module.exports = { createCodexBrowserLogin };
