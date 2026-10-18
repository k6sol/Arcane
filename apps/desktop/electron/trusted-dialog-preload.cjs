'use strict';
// Preload for the trusted Arcane decision window (trusted-dialog.cjs). It exposes exactly three calls: read this window's
// one question, report the rendered height once, and answer once with a button index. The request id stays here, so the
// page can only answer its own question; the host checks the sender window and the id again.
const { contextBridge, ipcRenderer } = require('electron');

const UNAVAILABLE = 'This dialog is unavailable.';
const text = (value, max) => typeof value === 'string' && value.length <= max && !/[\u0000-\u0009\u000b-\u001f\u007f]/.test(value);
let request = null, ready = false, answered = false;

contextBridge.exposeInMainWorld('arcaneTrustedDialog', Object.freeze({
  version: 1,
  request: async (...args) => {
    if (args.length || request) throw new Error(UNAVAILABLE);
    const v = await ipcRenderer.invoke('arcane:trusted-dialog-open').catch(() => null);
    if (!v || v.version !== 1 || typeof v.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v.id) ||
        !['none', 'info', 'question', 'warning', 'error'].includes(v.type) || !text(v.title, 120) || !text(v.message, 600) || !text(v.detail, 4000) ||
        !Array.isArray(v.buttons) || v.buttons.length < 1 || v.buttons.length > 4 || !v.buttons.every(label => text(label, 48) && label.length > 0)) throw new Error(UNAVAILABLE);
    const index = n => Number.isSafeInteger(n) && n >= 0 && n < v.buttons.length;
    if (!index(v.defaultId) || !index(v.cancelId)) throw new Error(UNAVAILABLE);
    request = { id: v.id, buttons: v.buttons.length };
    return { type: v.type, title: v.title, message: v.message, detail: v.detail, buttons: [...v.buttons], defaultId: v.defaultId, cancelId: v.cancelId };
  },
  ready: async (...args) => {
    if (args.length !== 1 || !Number.isFinite(args[0]) || !request || ready) throw new Error(UNAVAILABLE);
    ready = true;
    await ipcRenderer.invoke('arcane:trusted-dialog-ready', Math.round(args[0]));
    return { shown: true };
  },
  answer: async (...args) => {
    const response = args[0];
    if (args.length !== 1 || !request || answered || !Number.isSafeInteger(response) || response < 0 || response >= request.buttons) throw new Error(UNAVAILABLE);
    answered = true;
    await ipcRenderer.invoke('arcane:trusted-dialog-answer', { id: request.id, response });
    return { accepted: true };
  },
}));
