'use strict';
const {createHash} = require('node:crypto');
const LOCAL_SCOPE = createHash('sha256').update('arcane.diagnostics.local-only.v1').digest('hex');
const TOKEN = /^arc_[A-Za-z0-9_-]{43}$/;
const accountId = value => typeof value === 'string' && /^acct_[a-f0-9]{32}$/.test(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const fields = (value, names) => value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join(',') === [...names].sort().join(',');
const unavailable = () => ({stored: false, state: 'unavailable'});

/** Main-process only. storage.db is borrowed; its owner closes it only after close() returns true.
 * storage.assertReady must revalidate the caller's private, direct storage path before every operation.
 * No renderer channel, arbitrary path API, profile lookup or timer is created by this module. */
async function createDiagnosticsHost(options) {
  const runtime = await options.loadRuntime();
  const {DiagnosticOutbox, diagnosticScope, diagnosticEvent, diagnosticEventId} = runtime;
  let closed = false, binding = null;
  const active = new Set(), detachments = new Set(), controller = new AbortController();
  const now = options.now ?? Date.now;
  const enabled = options.enabled === true;
  function guard() {
    if (!enabled || closed || options.safeStorage?.isEncryptionAvailable() !== true || typeof options.storage?.assertReady !== 'function') throw Error('Diagnostic storage is unavailable.');
    options.storage.assertReady();
  }
  const codec = {
    seal(id, body) {
      guard();
      return options.safeStorage.encryptString(JSON.stringify({version: 1, id, body})).toString('base64url');
    },
    open(id, value) {
      guard();
      if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > 45000) throw Error('Invalid diagnostic envelope.');
      const bytes = Buffer.from(value, 'base64url'); if (bytes.toString('base64url') !== value) throw Error('Invalid diagnostic envelope.');
      const parsed = JSON.parse(options.safeStorage.decryptString(bytes));
      if (!fields(parsed, ['version', 'id', 'body']) || parsed.version !== 1 || parsed.id !== id || typeof parsed.body !== 'string' || parsed.body.length > 8192) throw Error('Invalid diagnostic envelope.');
      return parsed.body;
    },
  };
  const origins = options.allowedOrigins ?? [];
  async function credential() {
    const current = await options.credential();
    return current && typeof current.base === 'string' && typeof current.token === 'string' && TOKEN.test(current.token) ? current : null;
  }
  async function boundCredential() {
    const current = await credential();
    return binding && current && binding.base === current.base && binding.tokenHash === hash(current.token) ? {...current, scope: binding.scope} : null;
  }
  function tracked(work) {active.add(work); work.finally(() => active.delete(work)).catch(() => {}); return work;}
  const doFetch = (url, init) => (options.fetch ?? fetch)(url, {...init, signal: AbortSignal.any([init.signal, controller.signal])});
  let queue = null;
  try {guard(); queue = new DiagnosticOutbox({db: options.storage.db, codec, allowedOrigins: origins, credential: boundCredential, fetch: doFetch, now});}
  catch { /* Original errors remain available; no acknowledgement claims this queue was initialized. */ }
  async function report(input, stillCurrent = () => true) {
    try {
      guard(); if (!queue || !stillCurrent()) return unavailable();
      const event = diagnosticEvent(input), current = await boundCredential();
      guard(); if (!stillCurrent()) return unavailable();
      const scope = current?.scope ?? LOCAL_SCOPE;
      queue.enqueue(scope, event);
      return {stored: true, eventId: event.eventId, state: scope === LOCAL_SCOPE ? 'local-only' : 'queued'};
    } catch {return unavailable();}
  }
  async function refresh() {
    try {
      guard(); binding = null;
      if (!origins.length) return {state: 'disabled'};
      const current = await credential(); if (!current) return {state: 'signed-out'};
      const url = new URL(current.base);
      if (url.protocol !== 'https:' || url.origin !== current.base || !origins.includes(url.origin)) return {state: 'disabled'};
      const response = await doFetch(url.origin + '/v1/diagnostics/identity', {redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(5000), headers: {Authorization: 'Bearer ' + current.token}});
      if (!response.ok) {await response.body?.cancel().catch(() => {}); return {state: 'unavailable'};}
      const reader = response.body?.getReader(); if (!reader) return {state: 'unavailable'};
      let size = 0; const parts = [];
      try {for (;;) {const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 1024) throw Error(); parts.push(part.value);}}
      finally {await reader.cancel().catch(() => {});}
      const identity = JSON.parse(Buffer.concat(parts).toString('utf8')), latest = await credential();
      guard();
      if (!fields(identity, ['accountId']) || !accountId(identity.accountId) || !latest || latest.base !== current.base || latest.token !== current.token) return {state: 'unavailable'};
      binding = {base: current.base, tokenHash: hash(current.token), scope: diagnosticScope(current.base, identity.accountId)};
      return {state: 'ready'};
    } catch {binding = null; return {state: 'unavailable'};}
  }
  async function flush() {
    try {guard(); if (!queue) return {state: 'unavailable'}; queue.prune(); const status = await refresh(); if (status.state !== 'ready') return status; return await queue.flush();}
    catch {return {state: 'unavailable'};}
  }
  function list(query = {}) {
    guard(); if (!queue || !fields(query, Object.keys(query)) || Object.keys(query).some(key => !['before', 'eventId'].includes(key))) throw Error('Diagnostic reports are unavailable.');
    queue.prune();
    if (query.before !== undefined && (!Number.isSafeInteger(query.before) || query.before < 1) || query.eventId !== undefined && !diagnosticEventId(query.eventId)) throw Error('Invalid diagnostic filter.');
    const rows = options.storage.db.prepare('SELECT rowid AS id,scope,event_id,payload,attempts,blocked,next_at FROM diagnostic_outbox WHERE rowid<? AND (? IS NULL OR event_id=?) ORDER BY rowid DESC LIMIT 51')
      .all(query.before ?? Number.MAX_SAFE_INTEGER, query.eventId ?? null, query.eventId ?? null);
    const events = rows.slice(0, 50).map(row => ({id: Number(row.id), event: diagnosticEvent(JSON.parse(codec.open(row.scope + '\0' + row.event_id, row.payload))),
      state: row.blocked ? 'blocked' : row.scope === LOCAL_SCOPE ? 'local-only' : 'queued', attempts: Number(row.attempts), nextAttemptAt: Number(row.next_at)}));
    return {events, next: rows.length > 50 ? events.at(-1).id : null};
  }
  function attach(child, isCurrent) {
    let live = true, pending = 0;
    const current = () => {try{return live && !closed && isCurrent() === true;}catch{return false;}};
    function reply(message) {try {if (current() && child.connected !== false) child.send(message, () => {});} catch { /* A gone child cannot receive a false acknowledgement. */ }}
    const listener = message => {
      if (!current() || !fields(message, ['type', 'protocolVersion', 'requestId', 'event']) || message.type !== 'arcane-diagnostic-report' || message.protocolVersion !== 1 || !diagnosticEventId(message.requestId)) return;
      let event; try {event = diagnosticEvent(message.event);} catch {return;}
      const ack = result => reply({type: 'arcane-diagnostic-ack', protocolVersion: 1, requestId: message.requestId, eventId: event.eventId, stored: result.stored === true});
      if (pending >= 16) {ack(unavailable()); return;}
      pending++;
      tracked(report(event, current).then(ack).finally(() => {pending--;}));
    };
    child.on('message', listener);
    const detach = () => {live = false; child.removeListener('message', listener); detachments.delete(detach);};
    detachments.add(detach); return detach;
  }
  async function close() {
    closed = true; binding = null; controller.abort(); for (const detach of [...detachments]) detach();
    if (!active.size) return true;
    let timer;
    try {return await Promise.race([Promise.allSettled([...active]).then(() => true), new Promise(resolve => {timer = setTimeout(() => resolve(false), 1000);})]);}
    finally {clearTimeout(timer);}
  }
  return Object.freeze({report: (...args) => tracked(report(...args)), refresh: () => tracked(refresh()), flush: () => tracked(flush()), list, attach, close});
}
module.exports = {createDiagnosticsHost};
