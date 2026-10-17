'use strict';

// Persistent per-project agent permissions, owned by the main process. One small JSON record lives in the project's owned
// state directory (<userData>/runtime/projects/<project sha256>/agent-permissions.json) so a choice survives restarts and
// never leaks to another project. Two switches, both ON by default (the user asked Arcane to auto-approve and keep working):
//   claudeTools    Claude chat uses Arcane's project tools without a consent question each time the project opens.
//   codexAutoApprove  Codex edits and in-scope tool requests that Arcane's approval policy already marks safe are accepted
//                  automatically (hard fences stay: see apps/desktop/src/codex-chat.ts autoApprovalVerdict).
// Turning a switch off takes effect immediately (the owner revokes the live Claude credential). Unknown or damaged records
// fall back to the defaults and are rewritten only on the next explicit save. Import and construction have no side effects.
const nativeFs = require('node:fs/promises');
const nativePath = require('node:path');
const { randomUUID } = require('node:crypto');
const { types } = require('node:util');

const FILE = 'agent-permissions.json';
const MAX_BYTES = 4096;
const DEFAULTS = Object.freeze({ claudeTools: true, codexAutoApprove: true });
const KEYS = Object.freeze(Object.keys(DEFAULTS));
const UNAVAILABLE = 'Project permissions are unavailable.';

function settingsOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1) return null;
  const out = {};
  for (const key of KEYS) out[key] = typeof value[key] === 'boolean' ? value[key] : DEFAULTS[key];
  return Object.freeze(out);
}

function createProjectPermissions(options) {
  if (!options || typeof options.getSession !== 'function') throw new Error(UNAVAILABLE);
  const fs = options.fs ?? nativeFs, p = options.path ?? nativePath, now = options.now ?? (() => Date.now());
  const enabled = options.enabled !== false;
  let cache = null, queue = Promise.resolve();
  const listeners = new Set();
  const serial = fn => { const run = queue.then(fn); queue = run.catch(() => {}); return run; };
  /** The current project's state root; the cache is per project epoch. */
  function scope() {
    const session = options.getSession();
    if (!session || typeof session.stateRoot !== 'string' || !p.isAbsolute(session.stateRoot)) return null;
    return session;
  }
  async function readFrom(stateRoot) {
    const file = p.join(stateRoot, FILE);
    let stat; try { stat = await fs.lstat(file); } catch (error) { if (error?.code === 'ENOENT') return DEFAULTS; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) return DEFAULTS;
    try { return settingsOf(JSON.parse(await fs.readFile(file, 'utf8'))) ?? DEFAULTS; } catch { return DEFAULTS; }
  }
  /** Current settings for the open project (defaults when nothing was saved); never throws. */
  function read() {
    return serial(async () => {
      const session = scope();
      if (!enabled || !session) return DEFAULTS;
      if (cache && cache.epoch === session.epoch) return cache.settings;
      let settings; try { settings = await readFrom(session.stateRoot); } catch { settings = DEFAULTS; }
      cache = { epoch: session.epoch, settings };
      return settings;
    });
  }
  /** Exact partial update ({claudeTools?, codexAutoApprove?} booleans); atomic owned write; returns the saved settings. */
  function save(patch) {
    return serial(async () => {
      const session = scope();
      if (!enabled || !session) throw new Error(UNAVAILABLE);
      if (!patch || typeof patch !== 'object' || types.isProxy(patch) || Object.getPrototypeOf(patch) !== Object.prototype) throw new Error(UNAVAILABLE);
      const keys = Reflect.ownKeys(patch);
      if (!keys.length || keys.some(key => typeof key !== 'string' || !KEYS.includes(key))) throw new Error(UNAVAILABLE);
      for (const key of keys) { const field = Object.getOwnPropertyDescriptor(patch, key); if (!field || !Object.hasOwn(field, 'value') || typeof field.value !== 'boolean') throw new Error(UNAVAILABLE); }
      let current; try { current = cache && cache.epoch === session.epoch ? cache.settings : await readFrom(session.stateRoot); } catch { current = DEFAULTS; }
      const previous = current;
      const next = Object.freeze({ ...current, ...Object.fromEntries(keys.map(key => [key, patch[key]])) });
      const file = p.join(session.stateRoot, FILE), temporary = file + '.' + randomUUID() + '.tmp';
      const body = JSON.stringify({ version: 1, ...next, updatedAt: new Date(now()).toISOString() }) + '\n';
      try { await fs.writeFile(temporary, body, { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, file); }
      catch { try { await fs.unlink(temporary); } catch { /* absent */ } throw new Error(UNAVAILABLE); }
      if (scope()?.epoch !== session.epoch) throw new Error(UNAVAILABLE);
      cache = { epoch: session.epoch, settings: next };
      for (const listener of listeners) { try { listener(next, previous); } catch { /* owner hooks never break a save */ } }
      return next;
    });
  }
  /** Owner hook (main process only): called after each successful save with (next, previous). */
  function subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  /** Renderer IPC: the trusted main window only; exact shapes in and out. */
  function installIpc(ipcMain, { trusted }) {
    ipcMain.handle('arcane:project-permissions-read', async (event, ...args) => {
      try {
        if (args.length || !trusted(event)) throw 0;
        const session = scope();
        return { available: enabled && !!session, settings: { ...(await read()) } };
      } catch { throw new Error(UNAVAILABLE); }
    });
    ipcMain.handle('arcane:project-permissions-save', async (event, ...args) => {
      try {
        if (args.length !== 1 || !trusted(event)) throw 0;
        return { saved: true, settings: { ...(await save(args[0])) } };
      } catch { throw new Error(UNAVAILABLE); }
    });
  }
  return Object.freeze({ read, save, subscribe, installIpc, reset: () => { cache = null; } });
}

module.exports = { createProjectPermissions, PROJECT_PERMISSION_DEFAULTS: DEFAULTS, PROJECT_PERMISSIONS_FILE: FILE };
