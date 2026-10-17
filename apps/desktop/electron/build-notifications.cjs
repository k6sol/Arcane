'use strict';

// Build-done notifications, owned by the main process. When a chat turn finishes while the Arcane window is not focused,
// the workspace renderer (apps/desktop/src/notifications.ts) asks for ONE native OS notification. Only two fixed titles
// exist; the body is plain text cleaned of control and bidi characters and clipped to 120 characters; the target is an
// opaque short renderer id. The host re-checks focus itself, keeps a short cooldown, and on click restores and focuses
// the window and hands the target id back so the renderer can select the right chat tab. Nothing else crosses.
// Import and construction have no side effects.
const { types } = require('node:util');

const TITLES = Object.freeze({ finished: 'Arcane — Build finished', attention: 'Arcane — Needs your attention' });
const BODY_MAX = 120;
const TARGET = /^[A-Za-z0-9-]{1,64}$/;
const ACTIVATE_CHANNEL = 'arcane:notification-activate';
const COOLDOWN_MS = 1500;
const KEEP = 4;
const UNAVAILABLE = 'Notifications are unavailable.';
const CONTROL = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/gu;

function bodyText(value) {
  if (typeof value !== 'string') return '';
  const text = value.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  return text.length > BODY_MAX ? text.slice(0, BODY_MAX - 1).trimEnd() + '…' : text;
}

/** Exact {kind, body, target} plain object, or null. */
function requestOf(value) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 3 || !['kind', 'body', 'target'].every(key => keys.includes(key))) return null;
  for (const key of keys) { const d = Object.getOwnPropertyDescriptor(value, key); if (!d || !d.enumerable || !Object.hasOwn(d, 'value')) return null; }
  if (!Object.hasOwn(TITLES, value.kind) || typeof value.body !== 'string' || value.body.length > 4 * BODY_MAX ||
      typeof value.target !== 'string' || !TARGET.test(value.target)) return null;
  return Object.freeze({ kind: value.kind, title: TITLES[value.kind], body: bodyText(value.body), target: value.target });
}

function createBuildNotifications(options) {
  if (!options || typeof options.getWindow !== 'function' || !options.Notification) throw new Error(UNAVAILABLE);
  const Notification = options.Notification, now = options.now ?? (() => Date.now());
  const enabled = options.enabled !== false;
  const live = [];
  let last = -Infinity;

  function focusAndActivate(owner, target) {
    const window = options.getWindow();
    if (!window || window !== owner || window.isDestroyed?.()) return;
    try { if (window.isMinimized?.()) window.restore(); window.show(); window.focus(); } catch { /* Window closing. */ }
    const contents = window.webContents;
    try { if (contents && !contents.isDestroyed?.()) contents.send(ACTIVATE_CHANNEL, { target }); } catch { /* Renderer gone. */ }
  }

  /** Shows one notification when allowed; returns {shown}. Never throws for a valid request. */
  function notify(request) {
    const owner = options.getWindow();
    if (!enabled || !owner || owner.isDestroyed?.()) return { shown: false };
    if (owner.isFocused?.() === true) return { shown: false };
    let supported = false; try { supported = Notification.isSupported?.() !== false; } catch { supported = false; }
    if (!supported) return { shown: false };
    const at = now();
    if (at - last < COOLDOWN_MS) return { shown: false };
    last = at;
    try {
      const note = new Notification({ title: request.title, body: request.body, silent: false });
      note.on?.('click', () => focusAndActivate(owner, request.target));
      // Keep a few references so a click still arrives after garbage collection.
      live.push(note); while (live.length > KEEP) live.shift();
      note.show();
      return { shown: true };
    } catch { return { shown: false }; }
  }

  function installIpc(ipcMain, { trusted }) {
    ipcMain.handle('arcane:notification-show', async (event, ...args) => {
      const request = args.length === 1 ? requestOf(args[0]) : null;
      if (!request || !trusted(event)) throw new Error(UNAVAILABLE);
      return notify(request);
    });
  }
  return Object.freeze({ notify, installIpc, dispose: () => { live.length = 0; } });
}

module.exports = { createBuildNotifications, notificationRequest: requestOf, NOTIFICATION_TITLES: TITLES, NOTIFICATION_ACTIVATE_CHANNEL: ACTIVATE_CHANNEL };
