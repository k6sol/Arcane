'use strict';

// Trusted Arcane decision dialogs. Every question that grants authority (Claude tool access, plugin install, project switch,
// provider sign-in or terminal, checkout, turning automatic approval on, Luau verification setup) is asked here, in a
// separate modal BrowserWindow owned by the main process, never in the workspace renderer (which also shows model output
// and therefore must not be able to answer its own approval). The window is frameless, a modal child of the main window,
// sandboxed with context isolation and no Node, loads only the local static page trusted-dialog.html (+ .css/.js), and its
// tiny preload (trusted-dialog-preload.cjs) can only fetch this one request and return one button index for its id.
// Answers are accepted only from that window's own webContents and only for its request id; a timeout, the window being
// closed, its renderer going away or the owner closing all answer the cancel button. Without an owner window the native
// message box is used. Import and construction have no native side effects.
const { randomUUID: nativeUUID } = require('node:crypto');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { types } = require('node:util');
const { dialogRequest } = require('./in-app-dialog.cjs');

const CHANNELS = Object.freeze({ open: 'arcane:trusted-dialog-open', ready: 'arcane:trusted-dialog-ready', answer: 'arcane:trusted-dialog-answer' });
const LIMITS = Object.freeze({ timeoutMs: 10 * 60000, queued: 16, width: 480, minHeight: 168, maxHeight: 640 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PAGE_FILES = Object.freeze(['trusted-dialog.html', 'trusted-dialog.css', 'trusted-dialog.js']);

/** A question is a decision (and so must be trusted) when it offers more than one button. */
function isDecision(config) {
  return !!config && typeof config === 'object' && Array.isArray(config.buttons) && config.buttons.length > 1;
}

function createTrustedDialogs(options) {
  if (!options || typeof options.getWindow !== 'function' || typeof options.BrowserWindow !== 'function') throw new Error('Trusted dialogs need a window factory.');
  const native = () => options.native ?? require('electron').dialog;
  const randomUUID = options.randomUUID ?? nativeUUID, timeoutMs = options.timeoutMs ?? LIMITS.timeoutMs;
  const directory = options.directory ?? __dirname;
  const pageUrl = pathToFileURL(join(directory, 'trusted-dialog.html')).href;
  const allowedUrls = new Set(PAGE_FILES.map(file => pathToFileURL(join(directory, file)).href));
  let pending = null, queue = Promise.resolve(), queued = 0, disposed = false;

  function liveOwner(owner) {
    const window = options.getWindow();
    return window && window === owner && !window.isDestroyed?.() ? window : null;
  }
  function settle(entry, response) {
    if (!entry || entry.done) return;
    entry.done = true; clearTimeout(entry.timer);
    if (pending === entry) pending = null;
    try { entry.owner?.removeListener?.('closed', entry.onOwnerClosed); } catch { /* owner gone */ }
    try { if (entry.window && !entry.window.isDestroyed?.()) entry.window.destroy(); } catch { /* already gone */ }
    entry.resolve(Object.freeze({ response, checkboxChecked: false }));
  }
  function createWindow(owner, request) {
    const window = new options.BrowserWindow({ parent: owner, modal: true, show: false, frame: false, width: LIMITS.width, height: 240, useContentSize: true,
      resizable: false, minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, autoHideMenuBar: true, title: request.title,
      backgroundColor: '#0d0d0f', webPreferences: { preload: join(directory, 'trusted-dialog-preload.cjs'), sandbox: true, contextIsolation: true,
        nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, webSecurity: true, allowRunningInsecureContent: false,
        webviewTag: false, navigateOnDragDrop: false, spellcheck: false, devTools: false, disableDialogs: true, partition: 'arcane-trusted-dialog' } });
    const contents = window.webContents;
    try { window.setMenu?.(null); } catch { /* no menu support */ }
    const session = contents.session;
    session?.setPermissionRequestHandler?.((_contents, _permission, callback) => callback(false));
    session?.setPermissionCheckHandler?.(() => false);
    session?.setDevicePermissionHandler?.(() => false);
    session?.webRequest?.onBeforeRequest?.({ urls: ['<all_urls>'] }, (details, callback) => callback({ cancel: !allowedUrls.has(String(details.url).split(/[?#]/)[0]) }));
    contents.setWindowOpenHandler?.(() => ({ action: 'deny' }));
    for (const type of ['will-navigate', 'will-redirect', 'will-frame-navigate']) contents.on(type, event => event.preventDefault());
    contents.on('will-attach-webview', event => event.preventDefault());
    return window;
  }
  /** One question in its own trusted window; resolves with the validated choice, the cancel button, or null (could not show). */
  function present(owner, request) {
    return new Promise(resolve => {
      if (disposed || !liveOwner(owner)) { resolve(null); return; }
      const entry = { request, owner, window: null, contents: null, resolve, done: false, shown: false, timer: null, onOwnerClosed: () => settle(entry, request.cancelId) };
      try { entry.window = createWindow(owner, request); entry.contents = entry.window.webContents; }
      catch { entry.done = true; resolve(null); return; }
      pending = entry;
      entry.timer = setTimeout(() => settle(entry, request.cancelId), timeoutMs);
      entry.window.on('closed', () => settle(entry, request.cancelId));
      for (const type of ['render-process-gone', 'destroyed']) entry.contents.on(type, () => settle(entry, request.cancelId));
      owner.once?.('closed', entry.onOwnerClosed);
      Promise.resolve().then(() => entry.window.loadURL(pageUrl)).catch(() => {
        // The local page could not load: ask natively instead (never silently grant).
        if (entry.done) return;
        entry.done = true; clearTimeout(entry.timer); if (pending === entry) pending = null;
        try { entry.window.destroy(); } catch { /* gone */ }
        resolve(null);
      });
    });
  }
  /** Electron-compatible `showMessageBox([owner], options)`; native only when there is no live owner window. */
  async function showMessageBox(owner, maybeOptions) {
    const hasOwner = maybeOptions !== undefined;
    const config = hasOwner ? maybeOptions : owner;
    const window = hasOwner ? liveOwner(owner) : null;
    const request = window ? dialogRequest(config, randomUUID()) : null;
    if (!window || !request || queued >= LIMITS.queued) return hasOwner ? native().showMessageBox(owner, config) : native().showMessageBox(config);
    queued++;
    const run = queue.then(() => present(window, request));
    queue = run.catch(() => null);
    let result;
    try { result = await run; } finally { queued--; }
    if (result === null) return disposed || !liveOwner(owner) ? Object.freeze({ response: request.cancelId, checkboxChecked: false }) : native().showMessageBox(owner, config);
    return result;
  }
  /** The exact pending entry for this sender (only the dialog window's own main frame). */
  function entryFor(event) {
    const entry = pending;
    if (disposed || !entry || entry.done || !event || event.sender !== entry.contents) return null;
    const frame = event.senderFrame;
    if (frame && entry.contents.mainFrame && frame !== entry.contents.mainFrame) return null;
    return entry;
  }
  function installIpc(ipcMain) {
    ipcMain.handle(CHANNELS.open, async (event, ...args) => {
      const entry = entryFor(event);
      if (!entry || args.length) throw new Error('This dialog is unavailable.');
      const { id, type, title, message, detail, buttons, defaultId, cancelId } = entry.request;
      return { version: 1, id, type, title, message, detail, buttons: [...buttons], defaultId, cancelId };
    });
    ipcMain.handle(CHANNELS.ready, async (event, ...args) => {
      const entry = entryFor(event);
      if (!entry || args.length !== 1 || !Number.isFinite(args[0]) || entry.shown) throw new Error('This dialog is unavailable.');
      entry.shown = true;
      const height = Math.round(Math.min(LIMITS.maxHeight, Math.max(LIMITS.minHeight, args[0])));
      const window = entry.window;
      try {
        window.setContentSize?.(LIMITS.width, height);
        const parent = options.getWindow(), bounds = parent && !parent.isDestroyed?.() ? parent.getBounds?.() : null, own = window.getBounds?.();
        if (bounds && own) window.setPosition?.(Math.round(bounds.x + (bounds.width - own.width) / 2), Math.round(bounds.y + Math.max(48, (bounds.height - own.height) / 3)));
        window.show(); window.focus(); entry.contents.focus?.();
      } catch { settle(entry, entry.request.cancelId); throw new Error('This dialog is unavailable.'); }
      return { shown: true };
    });
    ipcMain.handle(CHANNELS.answer, async (event, ...args) => {
      const entry = entryFor(event);
      try {
        if (!entry || args.length !== 1) throw 0;
        const reply = args[0];
        if (!reply || typeof reply !== 'object' || types.isProxy(reply) || Object.getPrototypeOf(reply) !== Object.prototype) throw 0;
        const keys = Reflect.ownKeys(reply);
        if (keys.length !== 2 || !keys.includes('id') || !keys.includes('response')) throw 0;
        const { id, response } = reply;
        if (typeof id !== 'string' || !UUID.test(id) || id !== entry.request.id || !Number.isSafeInteger(response) || response < 0 || response >= entry.request.buttons.length) throw 0;
        settle(entry, response);
        return { accepted: true };
      } catch { throw new Error('This dialog answer was not accepted.'); }
    });
  }
  return Object.freeze({
    showMessageBox, installIpc,
    open: () => !!pending,
    dispose: () => { disposed = true; settle(pending, pending?.request.cancelId); },
  });
}

module.exports = { createTrustedDialogs, isDecisionDialog: isDecision, TRUSTED_DIALOG_CHANNELS: CHANNELS, TRUSTED_DIALOG_LIMITS: LIMITS, TRUSTED_DIALOG_PAGE_FILES: PAGE_FILES };
