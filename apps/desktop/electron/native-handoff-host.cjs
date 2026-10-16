'use strict';

// Main-process broker for ONE explicit human native Claude Code handoff at a time. It confirms once, asks the
// daemon's human endpoints for a pending handoff credential, prepares the Arcane-only MCP config through the
// released helper, asks the trusted host port to open a visible terminal with the credential ONLY in its launch
// env, and seals only on an explicit `opened` acknowledgement. `opened` means the terminal was acknowledged and
// the daemon sealed the handoff; it never means Claude Code or its Arcane tools connected. No retries, no core
// token, no process ownership, no provider authentication. Unwired until root composes it.
const { randomUUID } = require('node:crypto');
const { types } = require('node:util');
const nativePath = require('node:path');
const { createNativeHandoff } = require('./native-handoff.cjs');

const LIMITS = Object.freeze({ responseBytes: 131072, timeoutMs: 8000, records: 256, aliases: 32, efforts: 16 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const CREDENTIAL = /^[A-Za-z0-9_-]{43}$/;
const ORIGIN = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/;
const CHOICE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const STATES = new Set(['pending', 'sealed', 'expired', 'revoked', 'project_changed', 'closed']);
const SESSION_KEYS = ['projectPath', 'runtimeDirectory', 'nodePath', 'mcpEntry', 'origin', 'controlToken', 'epoch'];
const MESSAGES = Object.freeze({
  opened: 'Claude Code terminal opened for this project with Arcane tools configured. Arcane has not verified that Claude Code or its Arcane tools connected.',
  cancelled: 'Claude Code handoff was cancelled. Nothing was started.',
  refused: 'Claude Code handoff did not start. Any handoff it created was revoked.',
  unknown: 'Claude Code handoff outcome is unknown. Nothing was retried; review and revoke it from the handoff list.',
  revoked: 'The handoff was revoked.', unavailable: 'Native handoff is unavailable.',
});

class NativeHandoffHostError extends Error {
  constructor(code) { super('Native handoff is unavailable (' + code + ').'); this.name = 'NativeHandoffHostError'; this.code = code; }
}
const fail = code => { throw new NativeHandoffHostError(code); };
/** Plain own data only: proxies are refused before any trap and accessors are never invoked. */
function plain(value, required, optional = []) {
  if (!value || typeof value !== 'object' || types.isProxy(value)) fail('INPUT');
  const prototype = Object.getPrototypeOf(value), keys = Reflect.ownKeys(value);
  if (prototype !== Object.prototype && prototype !== null || keys.some(key => typeof key !== 'string' || !required.includes(key) && !optional.includes(key)) ||
      required.some(key => !keys.includes(key))) fail('INPUT');
  const out = Object.create(null);
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field || !Object.hasOwn(field, 'value')) fail('INPUT');
    out[key] = field.value;
  }
  return out;
}
const fn = value => typeof value === 'function' && !types.isProxy(value);
const absolute = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && nativePath.isAbsolute(value) && !/[\u0000-\u001f\u007f]/.test(value);
const result = (state, reason, extra = {}) => Object.freeze({ state, reason, message: MESSAGES[state], ...extra });

function createNativeHandoffHost(ports) {
  const p = plain(ports, ['getSession', 'getChoices', 'confirm', 'launchTerminal'], ['fetch', 'preparer']);
  for (const key of ['getSession', 'getChoices', 'confirm', 'launchTerminal']) if (!fn(p[key])) fail('INPUT');
  const fetchPort = p.fetch === undefined ? globalThis.fetch : p.fetch;
  if (!fn(fetchPort)) fail('INPUT');
  let preparer;
  if (p.preparer === undefined) preparer = createNativeHandoff();
  else { const q = plain(p.preparer, ['prepare', 'cleanup']); if (!fn(q.prepare) || !fn(q.cleanup)) fail('INPUT'); preparer = Object.freeze({ prepare: q.prepare, cleanup: q.cleanup }); }
  const { getSession, getChoices, confirm, launchTerminal } = p;

  let generation = 0, controller = new AbortController(), inflight = false, disposed = false;
  // Bounded private bookkeeping for handoffs this host minted: original captured session, owned receipt, revoked flag.
  const records = new Map();

  /** Synchronous trusted session snapshot, exact plain fields; null when the host context is invalid. */
  function readSession() {
    let raw; try { raw = getSession(); } catch { return null; }
    if (raw === null || raw === undefined) return null;
    if (types.isPromise(raw)) { void Promise.prototype.catch.call(raw, () => {}); return null; }
    let s; try { s = plain(raw, SESSION_KEYS); } catch { return null; }
    const port = typeof s.origin === 'string' ? ORIGIN.exec(s.origin) : null;
    if (!port || Number(port[1]) > 65535 || typeof s.controlToken !== 'string' || !HEX64.test(s.controlToken) || s.epoch === null || s.epoch === undefined ||
        !['projectPath', 'runtimeDirectory', 'nodePath', 'mcpEntry'].every(key => absolute(s[key]))) return null;
    return Object.freeze({ ...s });
  }
  function readChoices() {
    let raw; try { raw = getChoices(); } catch { return null; }
    if (types.isPromise(raw)) { void Promise.prototype.catch.call(raw, () => {}); return null; }
    let c; try { c = plain(raw, ['cliVersion', 'aliases', 'efforts']); } catch { return null; }
    const list = (value, max) => Array.isArray(value) && !types.isProxy(value) && value.length > 0 && value.length <= max &&
      Object.getPrototypeOf(value) === Array.prototype && value.every((item, index) => Object.hasOwn(value, index) && typeof item === 'string' && CHOICE.test(item));
    if (typeof c.cliVersion !== 'string' || !/^[0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5}(?:-[A-Za-z0-9.-]{1,32})?$/.test(c.cliVersion) || !list(c.aliases, LIMITS.aliases) || !list(c.efforts, LIMITS.efforts)) return null;
    return Object.freeze({ cliVersion: c.cliVersion, aliases: Object.freeze([...c.aliases]), efforts: Object.freeze([...c.efforts]) });
  }
  const sameSession = (a, b) => !!a && !!b && SESSION_KEYS.every(key => Object.is(a[key], b[key]));
  /** Fresh session identity, same generation, and (for launches) the same verified choice snapshot with membership. */
  function current(scope) {
    if (disposed || generation !== scope.generation || !sameSession(readSession(), scope.session)) return false;
    if (!scope.selection) return true;
    const c = readChoices();
    return !!c && c.cliVersion === scope.choices.cliVersion && c.aliases.includes(scope.selection.model) && c.efforts.includes(scope.selection.effort);
  }

  /** Fixed same-loopback human request: bearer + exact Origin, no redirects/cookies, bounded UTF-8 JSON, finite deadline. */
  async function request(session, method, path, body, signal) {
    const url = session.origin + path;
    let response;
    try {
      response = await fetchPort(url, { method, redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(LIMITS.timeoutMs)]),
        headers: { Authorization: 'Bearer ' + session.controlToken, Origin: session.origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch { return { kind: 'lost' }; }
    try {
      if (!response || typeof response.status !== 'number' || response.redirected === true || (response.url && response.url !== url)) return { kind: 'lost' };
      const reader = response.body?.getReader?.(); if (!reader) return { kind: 'lost' };
      const chunks = []; let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.byteLength; if (bytes > LIMITS.responseBytes) { try { await reader.cancel(); } catch { /* bounded */ } return { kind: 'lost' }; }
        chunks.push(value);
      }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))));
      const value = JSON.parse(text);
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return { kind: 'lost' };
      return { kind: 'reply', status: response.status, value };
    } catch { return { kind: 'lost' }; }
  }
  function status(value, projectId) {
    try {
      const s = plain(value, ['handoffId', 'state', 'projectId', 'createdAt', 'expiresAt', 'sealedAt', 'endedAt']);
      if (!UUID.test(s.handoffId) || !STATES.has(s.state) || s.projectId !== projectId || !ISO.test(s.createdAt) || !ISO.test(s.expiresAt) ||
          !(s.sealedAt === null || ISO.test(s.sealedAt)) || !(s.endedAt === null || ISO.test(s.endedAt))) return null;
      return Object.freeze({ handoffId: s.handoffId, state: s.state, createdAt: s.createdAt, expiresAt: s.expiresAt, sealedAt: s.sealedAt, endedAt: s.endedAt });
    } catch { return null; }
  }
  async function projectOf(session, signal) {
    const reply = await request(session, 'GET', '/v1/native-handoffs', undefined, signal);
    if (reply.kind !== 'reply' || reply.status !== 200) return null;
    try {
      const v = plain(reply.value, ['projectId', 'handoffs']);
      if (typeof v.projectId !== 'string' || !HEX64.test(v.projectId) || !Array.isArray(v.handoffs) || v.handoffs.length > LIMITS.records) return null;
      const handoffs = v.handoffs.map(item => status(item, v.projectId));
      return handoffs.every(Boolean) ? { projectId: v.projectId, handoffs } : null;
    } catch { return null; }
  }
  /** One revocation on the ORIGINAL captured session (it can only decrease authority); no retry, no substitution. */
  async function revokeOriginal(record) {
    if (record.revoked) return 'revoked';
    const reply = await request(record.session, 'POST', '/v1/native-handoffs/revoke', { handoffId: record.handoffId, projectId: record.projectId }, new AbortController().signal);
    if (reply.kind === 'reply' && reply.status === 200) {
      try { const s = status(plain(reply.value, ['handoff']).handoff, record.projectId);
        if (s && s.handoffId === record.handoffId && s.state !== 'pending' && s.state !== 'sealed') { record.revoked = true; return 'revoked'; } } catch { /* unknown below */ }
    }
    return 'unknown';
  }
  async function cleanupOwned(record) {
    if (!record.receipt) return 'not_owned';
    try {
      const outcome = await preparer.cleanup(record.receipt);
      if (outcome && outcome.state === 'removed') { record.receipt = null; return 'removed'; }
      return 'retained';
    } catch { return 'retained'; }
  }
  async function abandon(record, state, reason) {
    const revoked = await revokeOriginal(record), cleanup = await cleanupOwned(record);
    return result(state, reason, { handoffId: record.handoffId, revocation: revoked, cleanup });
  }

  async function launch(input) {
    if (disposed) return result('refused', 'disposed');
    let selection;
    try { const s = plain(input, ['model', 'effort']); if (typeof s.model !== 'string' || typeof s.effort !== 'string') fail('INPUT'); selection = Object.freeze({ model: s.model, effort: s.effort }); }
    catch { return result('refused', 'input'); }
    if (inflight) return result('refused', 'busy');
    if (records.size >= LIMITS.records) return result('refused', 'records_full');
    inflight = true;
    try {
      // Capture plain trusted fields and the verified choice snapshot before the first await.
      const session = readSession(), choices = readChoices();
      if (!session) return result('refused', 'session_unavailable');
      if (!choices) return result('refused', 'metadata_unavailable');
      if (!choices.aliases.includes(selection.model) || !choices.efforts.includes(selection.effort)) return result('refused', 'selection');
      const scope = { session, choices, selection, generation }, signal = controller.signal;
      let confirmed;
      try { confirmed = await confirm(Object.freeze({ provider: 'claude', model: selection.model, effort: selection.effort, cliVersion: choices.cliVersion }), session); } catch { confirmed = false; }
      if (!current(scope)) return result('cancelled', 'context_changed');
      if (confirmed !== true) return result('cancelled', 'not_confirmed');
      const project = await projectOf(session, signal);
      if (!current(scope)) return result('cancelled', 'context_changed');
      if (!project) return result('refused', 'daemon_unavailable');
      const begun = await request(session, 'POST', '/v1/native-handoffs/begin', { requestId: randomUUID(), projectId: project.projectId }, signal);
      let handoff = null, credential = null;
      if (begun.kind === 'reply' && begun.status === 200) {
        try { const v = plain(begun.value, ['handoff', 'credential']); const s = status(v.handoff, project.projectId);
          if (s && s.state === 'pending' && typeof v.credential === 'string' && CREDENTIAL.test(v.credential)) { handoff = s; credential = v.credential; } } catch { /* malformed below */ }
      }
      if (!handoff) {
        // A non-200 well-formed reply is a known refusal with nothing minted; anything else is unknown (never re-requested).
        const known = begun.kind === 'reply' && begun.status !== 200 && begun.status >= 400 && begun.status < 500;
        return known ? result('refused', 'begin_refused') : result('unknown', 'begin_unconfirmed');
      }
      const record = { handoffId: handoff.handoffId, projectId: project.projectId, session, receipt: null, revoked: false };
      records.set(record.handoffId, record);
      if (!current(scope)) return abandon(record, 'refused', 'context_changed');
      let receipt;
      try {
        receipt = await preparer.prepare({ projectPath: session.projectPath, runtimeDirectory: session.runtimeDirectory, nodePath: session.nodePath, mcpEntry: session.mcpEntry,
          daemonUrl: session.origin, credential, model: selection.model, effort: selection.effort, assertCurrent: () => { if (!current(scope)) throw new Error('stale'); } });
      } catch { return abandon(record, 'refused', current(scope) ? 'prepare_refused' : 'context_changed'); }
      record.receipt = receipt; credential = null;
      if (!current(scope)) return abandon(record, 'refused', 'context_changed');
      let opened;
      try { opened = await launchTerminal(Object.freeze({ argv: Object.freeze([...receipt.argv]), env: Object.freeze({ ...receipt.env }), projectPath: session.projectPath, epoch: session.epoch })); }
      catch { opened = 'unknown'; }
      if (opened === 'failed') return abandon(record, 'refused', 'launch_failed');
      if (opened !== 'opened') return abandon(record, 'unknown', 'launch_unconfirmed');
      if (!current(scope)) return abandon(record, 'unknown', 'context_changed_after_launch');
      const sealed = await request(session, 'POST', '/v1/native-handoffs/seal', { handoffId: record.handoffId, projectId: project.projectId }, signal);
      let receiptStatus = null;
      if (sealed.kind === 'reply' && sealed.status === 200) {
        try { const s = status(plain(sealed.value, ['handoff']).handoff, project.projectId); if (s && s.handoffId === record.handoffId && s.state === 'sealed') receiptStatus = s; } catch { /* unknown */ }
      }
      if (!receiptStatus) {
        const known = sealed.kind === 'reply' && sealed.status >= 400 && sealed.status < 500;
        return abandon(record, known ? 'refused' : 'unknown', known ? 'seal_refused' : 'seal_unconfirmed');
      }
      if (!current(scope)) return abandon(record, 'unknown', 'context_changed_after_seal');
      return result('opened', null, { handoffId: record.handoffId, expiresAt: receiptStatus.expiresAt });
    } finally { inflight = false; }
  }

  async function list() {
    if (disposed) return result('refused', 'disposed');
    const session = readSession(); if (!session) return result('refused', 'session_unavailable');
    const scope = { session, generation }, project = await projectOf(session, controller.signal);
    if (!current(scope)) return result('cancelled', 'context_changed');
    if (!project) return result('unknown', 'daemon_unavailable');
    return Object.freeze({ state: 'listed', projectId: project.projectId,
      handoffs: Object.freeze(project.handoffs.map(s => Object.freeze({ ...s, owned: records.get(s.handoffId)?.receipt ? true : false }))) });
  }
  /** Human revoke in the CURRENT scope; cleans only a config this host owns for that handoff. */
  async function revoke(handoffId) {
    if (disposed) return result('refused', 'disposed');
    if (typeof handoffId !== 'string' || !UUID.test(handoffId)) return result('refused', 'input');
    const session = readSession(); if (!session) return result('refused', 'session_unavailable');
    const scope = { session, generation }, project = await projectOf(session, controller.signal);
    if (!current(scope)) return result('cancelled', 'context_changed');
    if (!project) return result('unknown', 'daemon_unavailable');
    const reply = await request(session, 'POST', '/v1/native-handoffs/revoke', { handoffId, projectId: project.projectId }, controller.signal);
    let ended = null;
    if (reply.kind === 'reply' && reply.status === 200) {
      try { const s = status(plain(reply.value, ['handoff']).handoff, project.projectId); if (s && s.handoffId === handoffId && s.state !== 'pending' && s.state !== 'sealed') ended = s; } catch { /* unknown */ }
    }
    if (!ended) return result(reply.kind === 'reply' && reply.status >= 400 && reply.status < 500 ? 'refused' : 'unknown', 'revoke_unconfirmed', { handoffId });
    const record = records.get(handoffId);
    if (record) record.revoked = true;
    return result('revoked', null, { handoffId, cleanup: record ? await cleanupOwned(record) : 'not_owned' });
  }
  /** Synchronous fence: later awaits in flight see a new generation and their reads are aborted. */
  function cancelPending() { generation++; controller.abort(); controller = new AbortController(); }
  /** Fence, then revoke known original handoffs once and clean only owned material. Never touches native processes. */
  async function dispose() {
    if (disposed) return Object.freeze({ revoked: 0, unknown: 0, retained: 0 });
    cancelPending(); disposed = true;
    let revoked = 0, unknown = 0, retained = 0;
    for (const record of records.values()) {
      if ((await revokeOriginal(record)) === 'revoked') revoked++; else unknown++;
      if ((await cleanupOwned(record)) === 'retained') retained++;
    }
    return Object.freeze({ revoked, unknown, retained });
  }
  return Object.freeze({ launch, list, revoke, cancelPending, dispose });
}

module.exports = { createNativeHandoffHost, NativeHandoffHostError, NATIVE_HANDOFF_HOST_LIMITS: LIMITS };
