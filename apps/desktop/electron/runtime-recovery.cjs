'use strict';
const { randomUUID } = require('node:crypto');
const policy = require('./policy.cjs');
const LIMITS = Object.freeze({ healthyUptimeMs: 60000, backoffMs: 2000, checkpointMs: 10000, automaticRestarts: 1 });
const MESSAGES = Object.freeze({
  stopped: 'Local services stopped. Your workspace remains open. Restart services to continue.',
  saving: 'Saving chat drafts before restarting local services…',
  starting: 'Restarting local services…',
  unsaved: 'Chat drafts could not be saved. Keep this window open, review your drafts and try again.',
  failed: 'Local services could not restart. Your saved records were retained. Keep this window open and try again.',
});
const fields = (value, names) => !!value && Object.getPrototypeOf(value) === Object.prototype &&
  Reflect.ownKeys(value).length === names.length && names.every(name => {
    const d = Object.getOwnPropertyDescriptor(value, name); return d?.enumerable && Object.hasOwn(d, 'value');
  });
/** Main-process lifecycle owner. Presentation scope never contains a control token or provider credential. */
function createRuntimeRecovery(options) {
  let capsule = null, pending = null, operation = null, phase = 'ready', message = '', automatic = 0, ownsBusy = false, renderer = null;
  const enabled = options.enabled !== false;
  const schedule = options.setTimer ?? setTimeout, cancelTimer = options.clearTimer ?? clearTimeout;
  function capture() {
    try {
      const context = options.getContext(), owner = context.window, contents = owner?.webContents, frame = contents?.mainFrame;
      if (!enabled || context.closing || !owner || owner.isDestroyed() || !contents || contents.isDestroyed() ||
          !context.project || !context.userRoot || !frame || !policy.validOrigin(context.origin) ||
          !policy.navigationAllowed(context.origin, frame.url) || new URL(frame.url).href !== frame.url) return null;
      return { window: owner, contents, frame, frameUrl: frame.url, origin: context.origin, userRoot: context.userRoot,
        project: context.project, epoch: Object.freeze({}) };
    } catch { return null; }
  }
  function current(value = capsule) {
    try {
      const context = options.getContext();
      return !!value && capsule === value && !context.closing && (!context.switching || ownsBusy) &&
        context.window === value.window && !value.window.isDestroyed() && !value.contents.isDestroyed() &&
        value.contents.mainFrame === value.frame && value.frame.url === value.frameUrl && context.userRoot === value.userRoot &&
        ['projectId', 'projectPath', 'stateRoot'].every(key => context.project?.[key] === value.project[key]);
    } catch { return false; }
  }
  function preferences() {
    if (!current() || phase === 'ready') return null;
    return { ...capsule.project, window: capsule.window, origin: capsule.origin, userRoot: capsule.userRoot, epoch: capsule.epoch };
  }
  function trusted(event, value = capsule) {
    return current(value) && event?.sender === value.contents && event.senderFrame === value.frame && event.senderFrame.url === value.frameUrl;
  }
  function status() { return { version: 1, state: enabled ? phase : 'unavailable', message: enabled ? message : '' }; }
  function publish(next, text) {
    phase = next; message = text;
    if (current()) { try { capsule.contents.send('arcane:runtime-recovery-state', status()); } catch {} }
  }
  function invalidate(owner) {
    if (owner && renderer?.window === owner && owner.isDestroyed()) cancelRenderer(owner);
    if (owner && capsule?.window !== owner) return;
    capsule = null;
    if (pending) { const old = pending; pending = null; cancelTimer(old.timer); old.resolve(false); }
  }
  function cancelRenderer(owner) {
    if (!renderer || renderer.window !== owner) return;
    const item = renderer; renderer = null; item.resolve(false);
  }
  function waitForRenderer(owner) {
    if (renderer) cancelRenderer(renderer.window);
    const context = options.getContext();
    if (!enabled || context.closing || context.window !== owner || owner.isDestroyed()) return Promise.resolve(false);
    return new Promise(resolve => { renderer = { window: owner, project: context.project, resolve }; });
  }
  function checkpoint(value) {
    if (!current(value) || pending) return Promise.resolve(false);
    return new Promise(resolve => {
      const requestId = randomUUID();
      const finish = saved => { if (pending?.requestId !== requestId) return; cancelTimer(pending.timer); pending = null; resolve(saved && current(value)); };
      const timer = schedule(() => finish(false), LIMITS.checkpointMs);
      pending = { requestId, value, timer, resolve };
      try { value.contents.send('arcane:runtime-recovery-checkpoint', { version: 1, requestId }); }
      catch { finish(false); }
    });
  }
  async function run(allowAutomatic) {
    if (operation || !current()) return;
    const value = capsule;
    operation = (async () => {
      try {
        if (allowAutomatic && automatic < LIMITS.automaticRestarts) {
          automatic++; await options.delay(LIMITS.backoffMs);
        } else {
          const accepted = await options.confirm();
          if (!accepted || !current(value)) return;
        }
        if (!current(value)) return;
        ownsBusy = true; options.setBusy(true); publish('saving', MESSAGES.saving);
        if (!await checkpoint(value)) { if (current(value)) publish('stopped', MESSAGES.unsaved); return; }
        if (!current(value)) return;
        publish('starting', MESSAGES.starting);
        await options.start();
        if (!current(value)) { await options.retire(); return; }
        if (!options.running()) throw new Error('Runtime stopped before workspace navigation.');
        await options.reload();
        if (!options.running()) throw new Error('Runtime stopped during recovery.');
        invalidate(); phase = 'ready'; message = '';
      } catch {
        await options.retire().catch(() => null);
        if (current()) publish('stopped', MESSAGES.failed);
      } finally { ownsBusy = false; options.setBusy(false); }
    })().finally(() => { operation = null; });
    return operation;
  }
  async function stopped(info) {
    if (!enabled) return;
    const next = capture();
    if (next) capsule = next;
    const handled = !!next || current();
    // This call retires authority before any awaited confirmation, checkpoint or restart.
    const retired = options.retire();
    publish('stopped', MESSAGES.stopped);
    await retired;
    if (!handled) return false;
    if (operation || !current()) return true;
    const transient = Number.isFinite(info.uptimeMs) && info.uptimeMs >= LIMITS.healthyUptimeMs &&
      (info.signal != null || Number.isInteger(info.code) && info.code !== 0);
    await run(transient); return true;
  }
  function installIpc(ipcMain, liveTrusted) {
    ipcMain.handle('arcane:runtime-recovery-ready', async (event, ...args) => {
      if (args.length) throw new Error('Runtime recovery readiness is unavailable.');
      if (!enabled) return { ready: false };
      if (!liveTrusted(event)) throw new Error('Runtime recovery readiness is unavailable.');
      if (renderer) {
        const context = options.getContext(), item = renderer;
        if (context.window !== item.window || event.sender !== item.window.webContents ||
            ['projectId', 'projectPath', 'stateRoot'].some(key => context.project?.[key] !== item.project?.[key])) throw new Error('Runtime recovery readiness is unavailable.');
        renderer = null; item.resolve(true);
      }
      return { ready: true };
    });
    ipcMain.handle('arcane:runtime-recovery-status', async (event, ...args) => {
      const live = enabled && liveTrusted(event);
      if (args.length || enabled && !(trusted(event) || live)) throw new Error('Runtime recovery is unavailable.');
      if (live) {
        if (capsule && event.sender !== capsule.contents) return { version: 1, state: 'ready', message: '' };
      }
      return status();
    });
    ipcMain.handle('arcane:runtime-recovery-retry', async (event, ...args) => {
      if (!enabled || args.length || !trusted(event) || operation || phase !== 'stopped') throw new Error('Runtime recovery is unavailable.');
      void run(false); return { requested: true };
    });
    ipcMain.handle('arcane:runtime-recovery-saved', async (event, ...args) => {
      const input = args[0], item = pending;
      if (args.length !== 1 || !fields(input, ['requestId', 'saved']) || typeof input.saved !== 'boolean' || !item ||
          input.requestId !== item.requestId || !trusted(event, item.value)) throw new Error('Runtime recovery acknowledgement is unavailable.');
      pending = null; cancelTimer(item.timer); item.resolve(input.saved && current(item.value)); return { acknowledged: true };
    });
  }
  return Object.freeze({ stopped, preferences, invalidate, installIpc, status, waitForRenderer, cancelRenderer, limits: LIMITS });
}
module.exports = { createRuntimeRecovery };
