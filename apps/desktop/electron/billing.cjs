'use strict';

// Desktop checkout bridge (Settings > Plans & credits), owned by the main process.
//
// The renderer names ONE offer id. This host looks the offer up in the shipped plans config
// (packages/protocol/src/plans.ts, compiled to dist/packages/protocol/src/plans.js), builds the checkout URL itself from
// the billing service base URL, re-checks that it is https on an exact allowlisted origin, asks the user in an Arcane
// in-app dialog (in-app-dialog.cjs, native fallback) and only then opens it in the system browser with shell.openExternal.
// Every reply is one of the fixed states and messages below; no URL, path or error text crosses back to the renderer.
//
// Where the billing service URL comes from (default: unset, so checkout stays "not connected"):
//   1. <Arcane userData>/billing-service.json  {"version":1,"serviceUrl":"https://billing.your-domain.example"}
//      (Windows: %APPDATA%\Arcane\billing-service.json; a plain file of at most 4 KiB; links are refused).
//   2. Otherwise `billing.serviceUrl` in packages/protocol/src/plans.ts (empty by default).
// Either way the URL's exact origin must be listed in `billing.allowedOrigins` in plans.ts, which ships with the app,
// so a local file alone can never point checkout at a new origin.
//
// Connect Arcane account (Arcane Credits gateway sign-in), also owned here. DISABLED unless all of these hold:
//   - the host passes `safeStorage` and OS encryption is available (the studio-key-vault.cjs pattern);
//   - a gateway URL is configured: `gatewayUrl` in billing-service.json or `gateway.url` in plans.ts, on an exact https
//     origin listed in `gateway.allowedOrigins` in plans.ts.
// Otherwise status() reports `account: 'unavailable'` and nothing is requested. The sign-in is the gateway's device-code
// flow (docs/ARCANE_CREDITS.md): the host asks the gateway for a short code, shows it in an Arcane dialog, opens the
// gateway's sign-in page in the browser (the user confirms the same code and approves an emailed link), then polls for
// the opaque account token. The token is stored only encrypted (safeStorage) in <userData>/arcane-account.bin, bound to
// the gateway origin it came from, and never crosses to the renderer.
// Import and construction have no side effects.
const nativeFs = require('node:fs/promises');
const nativePath = require('node:path');
const { types } = require('node:util');

const CONFIG_FILE = 'billing-service.json';
const ACCOUNT_FILE = 'arcane-account.bin';
const MAX_CONFIG_BYTES = 4096;
const OFFER_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const ACCOUNT_TOKEN = /^[A-Za-z0-9._~-]{16,512}$/;
const DEVICE_CODE = /^[A-Za-z0-9_-]{20,128}$/;
const USER_CODE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const ACCOUNT_STATES = Object.freeze(['unavailable', 'signed-out', 'signing-in', 'signed-in']);
const ACCOUNT_MESSAGES = Object.freeze({
  notConnected: "Arcane Credits aren't connected yet",
  opened: 'Finish signing in in your browser',
  cancelled: 'Sign-in cancelled.',
  busy: 'A sign-in is already in progress.',
  signedIn: 'Your Arcane account is connected.',
  signedOut: 'Your Arcane account is disconnected.',
  unavailable: 'Arcane account sign-in is unavailable right now.',
});
const ACCOUNT_REPLY_STATES = Object.freeze(['not-connected', 'opened', 'cancelled', 'busy', 'signed-in', 'signed-out', 'unavailable']);
const MESSAGES = Object.freeze({
  notConnected: "Checkout isn't connected yet",
  ready: 'Checkout is connected.',
  opened: 'Checkout opened in your browser',
  cancelled: 'Checkout cancelled. Nothing was charged.',
  unknownOffer: 'That offer is unavailable. Nothing was charged.',
  busy: 'A checkout question is already open.',
  unavailable: 'Checkout is unavailable right now. Nothing was charged.',
});
const STATES = Object.freeze(['not-connected', 'ready', 'opened', 'cancelled', 'unknown-offer', 'busy', 'unavailable']);

const reply = (state, message) => Object.freeze({ version: 1, state, message });

/** Exact https origin (default port, no userinfo, no IP literal or localhost), or null. Mirrors protocol httpsOrigin. */
function httpsOrigin(value) {
  if (typeof value !== 'string' || !value || value.length > 256) return null;
  let url; try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) return null;
  if (url.hostname === 'localhost' || /^[0-9.]+$/.test(url.hostname) || url.hostname.includes(':')) return null;
  return url.origin;
}

/** https base URL whose exact origin is allowlisted, without trailing slashes; otherwise null. */
function billingBase(serviceUrl, allowedOrigins) {
  if (typeof serviceUrl !== 'string' || !serviceUrl || serviceUrl.length > 512 || !Array.isArray(allowedOrigins)) return null;
  let url; try { url = new URL(serviceUrl); } catch { return null; }
  const origin = httpsOrigin(url.origin);
  if (!origin || url.username || url.password || url.search || url.hash) return null;
  const allowed = new Set(allowedOrigins.slice(0, 8).map(httpsOrigin).filter(Boolean));
  if (!allowed.has(origin)) return null;
  return { origin, base: origin + url.pathname.replace(/\/+$/, '') };
}

/** Finds an offer id across plans, packs and credits of the shipped config. */
function findOffer(config, id) {
  if (typeof id !== 'string' || !OFFER_ID.test(id) || !config) return null;
  const groups = [['plan', config.plans], ['pack', config.packs], ['credits', config.credits?.offers]];
  for (const [kind, list] of groups) {
    const offer = Array.isArray(list) ? list.find(row => row && row.id === id) : null;
    if (offer && typeof offer.name === 'string') return { kind, id: offer.id, name: offer.name.slice(0, 32) };
  }
  return null;
}

/** Checkout URL from trusted config only; null when the result leaves the allowlisted origin. */
function checkoutUrl(service, offer) {
  const url = new URL(service.base + '/checkout');
  url.searchParams.set('kind', offer.kind); url.searchParams.set('offer', offer.id);
  return url.protocol === 'https:' && url.origin === service.origin && !url.username && !url.password ? url.href : null;
}

function createBilling(options) {
  if (!options || typeof options.loadPlans !== 'function' || typeof options.configDirectory !== 'function' ||
      typeof options.getWindow !== 'function' || !options.dialog || !options.shell) throw new Error(MESSAGES.unavailable);
  const fs = options.fs ?? nativeFs, p = options.path ?? nativePath;
  const enabled = options.enabled !== false;
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms, signal) => new Promise(resolve => {
    const timer = setTimeout(resolve, ms); signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  }));
  let asking = false, signIn = null;

  /** The local billing-service.json fields (serviceUrl, gatewayUrl), '' each when absent, damaged or unsafe. Never throws. */
  async function localConfig() {
    const empty = { serviceUrl: '', gatewayUrl: '' };
    try {
      const directory = options.configDirectory();
      if (typeof directory !== 'string' || !p.isAbsolute(directory)) return empty;
      const file = p.join(directory, CONFIG_FILE);
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONFIG_BYTES) return empty;
      const value = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1) return empty;
      return { serviceUrl: typeof value.serviceUrl === 'string' ? value.serviceUrl : '', gatewayUrl: typeof value.gatewayUrl === 'string' ? value.gatewayUrl : '' };
    } catch { return empty; }
  }
  /** Shipped plans config plus the effective, validated billing service and gateway; never throws. */
  async function resolve() {
    let config = null;
    try { config = (await options.loadPlans()) ?? null; } catch { config = null; }
    const billing = config && config.billing && typeof config.billing === 'object' ? config.billing : null;
    const gatewayConfig = config && config.gateway && typeof config.gateway === 'object' ? config.gateway : null;
    if (!billing && !gatewayConfig) return { config, service: null, gateway: null };
    const local = await localConfig();
    const serviceUrl = local.serviceUrl || (typeof billing?.serviceUrl === 'string' ? billing.serviceUrl : '');
    const gatewayUrl = local.gatewayUrl || (typeof gatewayConfig?.url === 'string' ? gatewayConfig.url : '');
    return { config, service: billing ? billingBase(serviceUrl, billing.allowedOrigins) : null,
      gateway: gatewayConfig ? billingBase(gatewayUrl, gatewayConfig.allowedOrigins) : null };
  }

  // ---- Arcane account token (encrypted at rest, bound to its gateway origin) -------------------------------------
  const encryption = () => { try { return enabled && !!options.safeStorage && options.safeStorage.isEncryptionAvailable() === true; } catch { return false; } };
  function accountFile() {
    const directory = options.configDirectory();
    return typeof directory === 'string' && p.isAbsolute(directory) ? p.join(directory, ACCOUNT_FILE) : null;
  }
  async function readToken(gateway) {
    if (!gateway || !encryption()) return null;
    try {
      const file = accountFile(); if (!file) return null;
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) return null;
      const value = JSON.parse(options.safeStorage.decryptString(await fs.readFile(file)));
      return value && value.version === 1 && value.origin === gateway.origin && typeof value.token === 'string' && ACCOUNT_TOKEN.test(value.token) ? value.token : null;
    } catch { return null; }
  }
  async function writeToken(gateway, token) {
    const file = accountFile();
    if (!file || !encryption() || !ACCOUNT_TOKEN.test(token)) throw new Error(ACCOUNT_MESSAGES.unavailable);
    const encrypted = options.safeStorage.encryptString(JSON.stringify({ version: 1, origin: gateway.origin, token }));
    const temporary = file + '.' + process.pid + '.tmp';
    await fs.writeFile(temporary, encrypted, { mode: 0o600, flag: 'wx' });
    try { await fs.rename(temporary, file); } catch (error) { await fs.rm(temporary, { force: true }).catch(() => {}); throw error; }
  }
  /** Small JSON POST to the gateway: no redirects, no cookies, 10 s timeout, reply capped at 4 KiB. */
  async function gatewayPost(gateway, path, body, token) {
    const url = new URL(gateway.base + path);
    if (url.origin !== gateway.origin || url.protocol !== 'https:') throw new Error(ACCOUNT_MESSAGES.unavailable);
    const response = await doFetch(url.href, { method: 'POST', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(10000),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) });
    const reader = response.body?.getReader(); const chunks = []; let size = 0;
    if (reader) for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > 4096) { await reader.cancel(); throw new Error(ACCOUNT_MESSAGES.unavailable); }
      chunks.push(Buffer.from(value));
    }
    let value = null; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { value = null; }
    return { status: response.status, value: value && typeof value === 'object' && !Array.isArray(value) ? value : null };
  }
  async function accountState(gateway) {
    if (!enabled || !gateway || !encryption()) return 'unavailable';
    if (signIn && signIn.origin === gateway.origin) return 'signing-in';
    return (await readToken(gateway)) ? 'signed-in' : 'signed-out';
  }
  function poll(gateway, deviceCode, intervalSeconds, expiresSeconds) {
    const state = { origin: gateway.origin, controller: new AbortController() };
    const deadline = Date.now() + expiresSeconds * 1000;
    void (async () => {
      let wait = intervalSeconds;
      try {
        while (!state.controller.signal.aborted && Date.now() < deadline) {
          await sleep(wait * 1000, state.controller.signal);
          if (state.controller.signal.aborted) break;
          const result = await gatewayPost(gateway, '/v1/auth/token', { deviceCode }).catch(() => null);
          if (!result) continue;
          if (result.status === 200 && typeof result.value?.token === 'string' && ACCOUNT_TOKEN.test(result.value.token)) { await writeToken(gateway, result.value.token); break; }
          const error = result.value?.error;
          if (error === 'slow_down') wait = Math.min(wait + 5, 60);
          else if (error !== 'authorization_pending') break;
        }
      } catch { /* sign-in simply stays signed out */ }
      finally { if (signIn === state) signIn = null; }
    })();
    return state;
  }
  const accountReply = (state, message) => Object.freeze({ version: 1, state, message });

  /** Connect Arcane account: device code from the gateway, confirm in an Arcane dialog, open the sign-in page, poll. */
  async function connectAccount() {
    if (!enabled) return accountReply('not-connected', ACCOUNT_MESSAGES.notConnected);
    if (asking || signIn) return accountReply('busy', ACCOUNT_MESSAGES.busy);
    asking = true;
    try {
      const { gateway } = await resolve();
      if (!gateway) return accountReply('not-connected', ACCOUNT_MESSAGES.notConnected);
      if (!encryption()) return accountReply('unavailable', ACCOUNT_MESSAGES.unavailable);
      if (await readToken(gateway)) return accountReply('signed-in', ACCOUNT_MESSAGES.signedIn);
      const started = await gatewayPost(gateway, '/v1/auth/device', {});
      const device = started.status === 200 ? started.value : null;
      if (!device || typeof device.deviceCode !== 'string' || !DEVICE_CODE.test(device.deviceCode) || typeof device.userCode !== 'string' || !USER_CODE.test(device.userCode))
        return accountReply('unavailable', ACCOUNT_MESSAGES.unavailable);
      let page;
      try { page = new URL(typeof device.verificationUrlComplete === 'string' ? device.verificationUrlComplete : device.verificationUrl); } catch { page = null; }
      if (!page || page.protocol !== 'https:' || page.origin !== gateway.origin || page.username || page.password) return accountReply('unavailable', ACCOUNT_MESSAGES.unavailable);
      const interval = Number.isSafeInteger(device.interval) ? Math.min(Math.max(device.interval, 1), 60) : 5;
      const expires = Number.isSafeInteger(device.expiresIn) ? Math.min(Math.max(device.expiresIn, 60), 1800) : 600;
      const owner = options.getWindow();
      if (!owner || owner.isDestroyed?.()) return accountReply('unavailable', ACCOUNT_MESSAGES.unavailable);
      const choice = await options.dialog.showMessageBox(owner, { type: 'question', title: 'Connect Arcane account',
        message: 'Sign in with code ' + device.userCode + '?',
        detail: 'Arcane will open ' + gateway.origin + ' in your browser. Check that it shows the same code, enter your email, then approve the link we email you.',
        buttons: ['Cancel', 'Open sign-in page'], defaultId: 0, cancelId: 0, noLink: true });
      if (!choice || choice.response !== 1 || options.getWindow() !== owner) return accountReply('cancelled', ACCOUNT_MESSAGES.cancelled);
      if (httpsOrigin(page.origin) !== gateway.origin) return accountReply('unavailable', ACCOUNT_MESSAGES.unavailable);
      await options.shell.openExternal(page.href);
      signIn = poll(gateway, device.deviceCode, interval, expires);
      return accountReply('opened', ACCOUNT_MESSAGES.opened);
    } catch { return accountReply('unavailable', ACCOUNT_MESSAGES.unavailable); }
    finally { asking = false; }
  }

  /** Forgets the account token on this device and revokes it on the gateway (best effort). */
  async function disconnectAccount() {
    if (!enabled) return accountReply('not-connected', ACCOUNT_MESSAGES.notConnected);
    if (signIn) { signIn.controller.abort(); signIn = null; }
    try {
      const { gateway } = await resolve();
      const token = await readToken(gateway);
      const file = accountFile(); if (file) await fs.rm(file, { force: true });
      if (gateway && token) await gatewayPost(gateway, '/v1/auth/logout', {}, token).catch(() => null);
      return accountReply('signed-out', ACCOUNT_MESSAGES.signedOut);
    } catch { return accountReply('unavailable', ACCOUNT_MESSAGES.unavailable); }
  }

  /** Main-process only (never over IPC): the gateway base and account token for the Arcane provider, or null. */
  async function accountCredential() {
    const { gateway } = await resolve();
    const token = await readToken(gateway);
    return gateway && token ? Object.freeze({ base: gateway.base, token }) : null;
  }

  async function status() {
    if (!enabled) return Object.freeze({ ...reply('not-connected', MESSAGES.notConnected), account: 'unavailable' });
    const { service, gateway } = await resolve();
    return Object.freeze({ ...(service ? reply('ready', MESSAGES.ready) : reply('not-connected', MESSAGES.notConnected)), account: await accountState(gateway) });
  }

  async function openCheckout(productId) {
    if (typeof productId !== 'string' || !OFFER_ID.test(productId)) return reply('unknown-offer', MESSAGES.unknownOffer);
    if (!enabled) return reply('not-connected', MESSAGES.notConnected);
    if (asking) return reply('busy', MESSAGES.busy);
    asking = true;
    try {
      const { config, service } = await resolve();
      if (!config) return reply('unavailable', MESSAGES.unavailable);
      const offer = findOffer(config, productId);
      if (!offer) return reply('unknown-offer', MESSAGES.unknownOffer);
      if (!service) return reply('not-connected', MESSAGES.notConnected);
      const url = checkoutUrl(service, offer);
      if (!url) return reply('not-connected', MESSAGES.notConnected);
      const owner = options.getWindow();
      if (!owner || owner.isDestroyed?.()) return reply('unavailable', MESSAGES.unavailable);
      const choice = await options.dialog.showMessageBox(owner, { type: 'question', title: 'Open checkout',
        message: 'Open checkout for ' + offer.name + ' in your browser?',
        detail: 'Arcane will open ' + service.origin + ' in your default browser. Nothing is charged until you finish there.',
        buttons: ['Cancel', 'Open checkout'], defaultId: 0, cancelId: 0, noLink: true });
      if (!choice || choice.response !== 1 || options.getWindow() !== owner) return reply('cancelled', MESSAGES.cancelled);
      // Re-check right before the URL leaves the app.
      if (httpsOrigin(new URL(url).origin) !== service.origin) return reply('not-connected', MESSAGES.notConnected);
      await options.shell.openExternal(url);
      return reply('opened', MESSAGES.opened);
    } catch { return reply('unavailable', MESSAGES.unavailable); }
    finally { asking = false; }
  }

  /** Renderer IPC: the trusted main window only; zero or one exact string argument; fixed replies. */
  function installIpc(ipcMain, { trusted }) {
    ipcMain.handle('arcane:billing-status', async (event, ...args) => {
      if (args.length || !trusted(event)) throw new Error(MESSAGES.unavailable);
      return status();
    });
    ipcMain.handle('arcane:billing-checkout', async (event, ...args) => {
      if (args.length !== 1 || typeof args[0] !== 'string' || types.isProxy(args[0]) || !trusted(event)) throw new Error(MESSAGES.unavailable);
      return openCheckout(args[0]);
    });
    ipcMain.handle('arcane:billing-account-connect', async (event, ...args) => {
      if (args.length || !trusted(event)) throw new Error(ACCOUNT_MESSAGES.unavailable);
      return connectAccount();
    });
    ipcMain.handle('arcane:billing-account-disconnect', async (event, ...args) => {
      if (args.length || !trusted(event)) throw new Error(ACCOUNT_MESSAGES.unavailable);
      return disconnectAccount();
    });
  }
  return Object.freeze({ status, openCheckout, connectAccount, disconnectAccount, accountCredential, installIpc });
}

module.exports = { createBilling, BILLING_MESSAGES: MESSAGES, BILLING_STATES: STATES, BILLING_CONFIG_FILE: CONFIG_FILE, billingBase,
  ACCOUNT_MESSAGES, ACCOUNT_STATES, ACCOUNT_REPLY_STATES, ACCOUNT_FILE };
