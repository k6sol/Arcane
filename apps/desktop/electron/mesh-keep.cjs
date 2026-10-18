'use strict';

// "Keep this mesh" (docs/build/MESH_KEEP.md), owned by the main process. A procedural mesh placed in Studio lives only in
// that Studio session; keeping it uploads its meshes to the signed-in Studio user's own Roblox account. The workspace
// renderer (apps/desktop/src/mesh-keep.ts) sends ONE placed mesh id (transfer digest + Studio session) after the person
// clicked Keep this mesh. The host then:
//   1. asks the daemon to prepare it (fresh signed-in account observation, asset name, mesh count),
//   2. asks the person in the trusted Arcane decision window (trusted-dialog.cjs via `confirm`), naming the account, the
//      asset name, the number of uploads and that it uses their Roblox upload quota,
//   3. only on "Upload and keep" hands the daemon a fresh single-use consent over the private child-process IPC channel
//      (which neither the renderer nor any model can reach), then starts the keep with that consent.
// Cancel, a closed or timed-out dialog, a project switch or any doubt answers "not uploaded". Never automatic, never
// retried. Import and construction have no side effects.
const { randomBytes } = require('node:crypto');
const { types } = require('node:util');

const CHANNEL = 'arcane:mesh-keep';
const UNAVAILABLE = 'Keep this mesh is unavailable.';
const DIGEST = /^[a-f0-9]{64}$/, SESSION = /^[A-Za-z0-9_-]{1,128}$/, UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNSAFE = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/gu;
const LIMITS = Object.freeze({ requestMs: 30000, message: 400 });

const plain = (value, max) => typeof value === 'string' ? value.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';

/** Exact {digest, sessionId} plain object, or null. */
function keepRequest(value) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || !keys.includes('digest') || !keys.includes('sessionId')) return null;
  for (const key of keys) { const d = Object.getOwnPropertyDescriptor(value, key); if (!d || !d.enumerable || !Object.hasOwn(d, 'value')) return null; }
  if (typeof value.digest !== 'string' || !DIGEST.test(value.digest) || typeof value.sessionId !== 'string' || !SESSION.test(value.sessionId)) return null;
  return Object.freeze({ digest: value.digest, sessionId: value.sessionId });
}

/** The daemon's prepared request, checked field by field before any of it reaches the dialog. */
function preparedOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const account = value.account;
  if (typeof value.prepareId !== 'string' || !UUID.test(value.prepareId) || !account || account.kind !== 'user' || !Number.isSafeInteger(account.userId) || account.userId < 1
    || typeof value.name !== 'string' || !value.name.trim() || [...value.name].length > 50 || typeof value.placeName !== 'string'
    || !(value.meshCount === null || Number.isSafeInteger(value.meshCount) && value.meshCount >= 1 && value.meshCount <= 16)) return null;
  return Object.freeze({ prepareId: value.prepareId, userId: account.userId, name: plain(value.name, 50), placeName: plain(value.placeName, 120) || 'this place', meshCount: value.meshCount });
}

/** The trusted dialog text: account, asset name, upload count and quota, in plain words. */
function keepQuestion(prepared) {
  const uploads = prepared.meshCount === null ? 'One mesh asset per part of this model.' : prepared.meshCount === 1 ? '1 mesh asset.' : prepared.meshCount + ' mesh assets (one per part).';
  return Object.freeze({
    title: 'Keep this mesh',
    message: 'Upload “' + prepared.name + '” to your Roblox account?',
    detail: 'Account: Roblox user ID ' + prepared.userId + ' (signed in to Roblox Studio)\nAsset name: ' + prepared.name + '\nUploads: ' + uploads + '\nPlace: ' + prepared.placeName +
      '\n\nThis uses your Roblox upload quota. New assets can wait for Roblox moderation before they load. The model then uses the uploaded meshes, so it stays after reconnecting, Play and reopening once you save the place.' +
      '\n\nArcane never uploads without this confirmation and cannot undo an upload.',
    confirmLabel: 'Upload and keep',
  });
}

function createMeshKeepHost(options) {
  if (!options || typeof options.getSession !== 'function' || typeof options.confirm !== 'function') throw new Error(UNAVAILABLE);
  const enabled = options.enabled !== false;
  const transport = options.fetch ?? ((...args) => fetch(...args));
  const random = options.randomBytes ?? randomBytes;
  let busy = false;

  async function call(session, path, body) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), LIMITS.requestMs);
    try {
      const response = await transport(session.origin + path, { method: 'POST', headers: { Authorization: 'Bearer ' + session.token, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: controller.signal, redirect: 'error', cache: 'no-store' });
      let payload = null; try { payload = await response.json(); } catch { payload = null; }
      return { ok: response.ok === true, payload };
    } finally { clearTimeout(timer); }
  }
  const refused = payload => Object.freeze({ state: 'refused', message: plain(payload && payload.message, LIMITS.message) || 'Arcane could not confirm the keep result. Review the mesh card before trying again.' });

  /** One keep: prepare, trusted confirmation, IPC consent, start. Returns a fixed-shape answer; never throws for a valid request. */
  async function keep(request) {
    const session = enabled ? options.getSession() : null;
    if (!session) return Object.freeze({ state: 'unavailable', message: UNAVAILABLE });
    if (busy) return Object.freeze({ state: 'refused', message: 'Another Keep this mesh confirmation is open.' });
    busy = true;
    try {
      const prepared = await call(session, '/v1/mesh-keep/prepare', { digest: request.digest, sessionId: request.sessionId });
      if (!prepared.ok) return refused(prepared.payload);
      const value = preparedOf(prepared.payload);
      if (!value) return Object.freeze({ state: 'refused', message: 'The keep request could not be checked. Nothing was uploaded.' });
      const confirmed = await options.confirm(keepQuestion(value));
      const current = options.getSession();
      if (confirmed !== true) return Object.freeze({ state: 'cancelled', message: 'Not uploaded.' });
      if (!current || current.window !== session.window || current.origin !== session.origin || current.token !== session.token)
        return Object.freeze({ state: 'cancelled', message: 'The project changed before the upload started. Nothing was uploaded.' });
      const consent = random(32).toString('hex');
      try { current.send({ type: 'arcane-mesh-keep-consent', protocolVersion: 1, prepareId: value.prepareId, consent }); }
      catch { return Object.freeze({ state: 'refused', message: 'The local runtime could not receive your confirmation. Nothing was uploaded.' }); }
      const started = await call(current, '/v1/mesh-keep/start', { prepareId: value.prepareId, consent });
      if (!started.ok) return refused(started.payload);
      return Object.freeze({ state: 'started', message: 'Uploading to your Roblox account…' });
    } catch {
      return Object.freeze({ state: 'refused', message: 'Arcane could not reach the local runtime. Check the mesh card before trying again.' });
    } finally { busy = false; }
  }

  function installIpc(ipcMain, { trusted }) {
    ipcMain.handle(CHANNEL, async (event, ...args) => {
      const request = args.length === 1 ? keepRequest(args[0]) : null;
      if (!request || !trusted(event)) throw new Error(UNAVAILABLE);
      return keep(request);
    });
  }
  return Object.freeze({ keep, installIpc });
}

module.exports = { createMeshKeepHost, meshKeepRequest: keepRequest, meshKeepQuestion: keepQuestion, meshKeepPrepared: preparedOf, MESH_KEEP_CHANNEL: CHANNEL };
