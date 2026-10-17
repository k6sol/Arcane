'use strict';

// Main-process host for Arcane-styled in-app dialogs. It keeps Electron's `dialog.showMessageBox(owner, options)` shape so
// every existing host (Claude chat consent, provider setup, plugin install, project switch, Luau verification) is unchanged:
// when the trusted main window's renderer has attached, the question is sent over IPC and rendered in the workspace as a
// focused modal; the renderer answers with the request id and one button index, which is validated here (exact id, exact
// index range, one answer, timeout or navigation = the dialog's cancel button). Without an attached renderer (startup
// failure, a crashed or navigating renderer, no window) it falls back to the native message box. Folder and file pickers
// (showOpenDialog) always stay native. Import and construction have no native side effects.
const { randomUUID: nativeUUID } = require('node:crypto');
const { types } = require('node:util');

const REQUEST_CHANNEL = 'arcane:dialog-request';
const LIMITS = Object.freeze({ title: 120, message: 600, detail: 4000, buttons: 4, buttonLabel: 48, timeoutMs: 10 * 60000, queued: 16 });
const TYPES = Object.freeze(['none', 'info', 'question', 'warning', 'error']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Bidi overrides and C0/C1 controls (newline kept for detail paragraphs).
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/gu;

const clean = (value, max, multiline = false) => {
  if (typeof value !== 'string') return '';
  let text = value.replace(/\r\n?/g, '\n').replace(CONTROL, ' ');
  if (!multiline) text = text.replace(/\n+/g, ' ');
  text = text.trim();
  return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;
};

/** Validated renderer request: fixed fields, bounded strings, 1..4 labelled buttons, in-range default and cancel. */
function requestOf(options, id) {
  const o = options && typeof options === 'object' && !types.isProxy(options) ? options : {};
  const labels = Array.isArray(o.buttons) && o.buttons.length ? o.buttons.slice(0, LIMITS.buttons).map(label => clean(label, LIMITS.buttonLabel)) : ['OK'];
  if (labels.some(label => !label)) return null;
  const index = (value, fallback) => Number.isSafeInteger(value) && value >= 0 && value < labels.length ? value : fallback;
  const cancelFallback = labels.findIndex(label => /^(cancel|close|no)$/i.test(label));
  const cancelId = index(o.cancelId, cancelFallback >= 0 ? cancelFallback : 0);
  return Object.freeze({ version: 1, id, type: TYPES.includes(o.type) ? o.type : 'info',
    title: clean(o.title, LIMITS.title) || 'Arcane', message: clean(o.message, LIMITS.message), detail: clean(o.detail, LIMITS.detail, true),
    buttons: Object.freeze(labels), defaultId: index(o.defaultId, cancelId), cancelId });
}

function createInAppDialogs(options) {
  if (!options || typeof options.getWindow !== 'function' || typeof options.trusted !== 'function') throw new Error('In-app dialogs need a window and a trust check.');
  const native = () => options.native ?? require('electron').dialog;
  const randomUUID = options.randomUUID ?? nativeUUID, timeoutMs = options.timeoutMs ?? LIMITS.timeoutMs;
  let attached = null, pending = null, queue = Promise.resolve(), queued = 0, disposed = false;

  function liveWindow(owner) {
    const window = options.getWindow();
    if (!window || window !== owner || window.isDestroyed?.()) return null;
    const contents = window.webContents;
    return contents && !contents.isDestroyed?.() && attached && attached.contents === contents ? window : null;
  }
  function settle(entry, response) {
    if (!entry || entry.done) return;
    entry.done = true; clearTimeout(entry.timer);
    if (pending === entry) pending = null;
    entry.resolve(Object.freeze({ response, checkboxChecked: false }));
  }
  /** One request on the attached renderer; resolves with the validated choice or the cancel button. */
  function present(window, request) {
    return new Promise(resolve => {
      const entry = { request, contents: window.webContents, resolve, done: false, timer: null };
      if (disposed || !liveWindow(window)) { resolve(null); return; }
      pending = entry;
      entry.timer = setTimeout(() => settle(entry, request.cancelId), timeoutMs);
      try { entry.contents.send(REQUEST_CHANNEL, request); }
      catch { pending = null; clearTimeout(entry.timer); entry.done = true; resolve(null); }
    });
  }
  /** Electron-compatible `showMessageBox([owner], options)`; native only when no trusted renderer can answer. */
  async function showMessageBox(owner, maybeOptions) {
    const hasOwner = maybeOptions !== undefined;
    const config = hasOwner ? maybeOptions : owner;
    const window = hasOwner ? liveWindow(owner) : null;
    const request = window ? requestOf(config, randomUUID()) : null;
    if (!window || !request || queued >= LIMITS.queued) return hasOwner ? native().showMessageBox(owner, config) : native().showMessageBox(config);
    queued++;
    const run = queue.then(() => present(window, request));
    queue = run.catch(() => null);
    let result;
    try { result = await run; } finally { queued--; }
    // The renderer went away before the request could be shown: ask natively instead of silently cancelling.
    if (result === null) return liveWindow(owner) || disposed ? Object.freeze({ response: request.cancelId, checkboxChecked: false }) : native().showMessageBox(owner, config);
    return result;
  }
  /** Navigation, crash, close or project switch: the open question is answered with its cancel button. */
  function detach(contents) {
    if (contents && attached && attached.contents !== contents) return;
    attached = null;
    settle(pending, pending?.request.cancelId);
  }
  function installIpc(ipcMain) {
    ipcMain.handle('arcane:dialog-attach', async (event, ...args) => {
      if (disposed || args.length || !options.trusted(event)) throw new Error('In-app dialogs are unavailable.');
      if (attached && attached.contents !== event.sender) detach();
      attached = { contents: event.sender };
      return { attached: true };
    });
    ipcMain.handle('arcane:dialog-reply', async (event, ...args) => {
      const entry = pending;
      try {
        if (disposed || args.length !== 1 || !options.trusted(event) || !attached || attached.contents !== event.sender || !entry || entry.contents !== event.sender) throw 0;
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
    showMessageBox,
    // OS file and folder pickers stay native by design.
    showOpenDialog: (...args) => native().showOpenDialog(...args),
    installIpc, detach,
    attached: () => !!attached,
    dispose: () => { disposed = true; detach(); },
  });
}

module.exports = { createInAppDialogs, dialogRequest: requestOf, IN_APP_DIALOG_CHANNEL: REQUEST_CHANNEL, IN_APP_DIALOG_LIMITS: LIMITS };
