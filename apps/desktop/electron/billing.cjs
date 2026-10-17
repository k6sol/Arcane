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
// Arcane account sign-in is NOT implemented here: status() always reports `account: 'unavailable'`. The token storage
// it needs will follow the studio-key-vault.cjs safeStorage pattern (see docs/ARCANE_CREDITS.md).
// Import and construction have no side effects.
const nativeFs = require('node:fs/promises');
const nativePath = require('node:path');
const { types } = require('node:util');

const CONFIG_FILE = 'billing-service.json';
const MAX_CONFIG_BYTES = 4096;
const OFFER_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
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
  let asking = false;

  /** The local billing-service.json serviceUrl, or '' when absent, damaged or unsafe. Never throws. */
  async function localServiceUrl() {
    try {
      const directory = options.configDirectory();
      if (typeof directory !== 'string' || !p.isAbsolute(directory)) return '';
      const file = p.join(directory, CONFIG_FILE);
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONFIG_BYTES) return '';
      const value = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || typeof value.serviceUrl !== 'string') return '';
      return value.serviceUrl;
    } catch { return ''; }
  }
  /** Shipped plans config plus the effective, validated billing service; never throws. */
  async function resolve() {
    let config = null;
    try { config = (await options.loadPlans()) ?? null; } catch { config = null; }
    const billing = config && config.billing && typeof config.billing === 'object' ? config.billing : null;
    if (!billing) return { config, service: null };
    const local = await localServiceUrl();
    const serviceUrl = local || (typeof billing.serviceUrl === 'string' ? billing.serviceUrl : '');
    return { config, service: billingBase(serviceUrl, billing.allowedOrigins) };
  }

  async function status() {
    if (!enabled) return Object.freeze({ ...reply('not-connected', MESSAGES.notConnected), account: 'unavailable' });
    const { service } = await resolve();
    return Object.freeze({ ...(service ? reply('ready', MESSAGES.ready) : reply('not-connected', MESSAGES.notConnected)), account: 'unavailable' });
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
  }
  return Object.freeze({ status, openCheckout, installIpc });
}

module.exports = { createBilling, BILLING_MESSAGES: MESSAGES, BILLING_STATES: STATES, BILLING_CONFIG_FILE: CONFIG_FILE, billingBase };
