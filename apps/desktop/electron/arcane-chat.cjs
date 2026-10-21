'use strict';

// Main-process host for the in-app Arcane chat (Arcane Credits). The user's Arcane gateway proxies raw model APIs, so
// there is no agent loop on the other side: this host runs a small, bounded tool-use loop itself. Each turn
//   1. reads the signed-in account's gateway client (billing.cjs accountCredential, never sent to the renderer);
//   2. mints the scoped core project credential through the existing native handoff and starts its owned stdio MCP;
//      an optional trusted appAssets port separately binds a64hex asset credential to this durable app chat/turn;
//   3. offers the MCP tools to the model in the gateway's provider-neutral function-calling format, streams the reply
//      through POST /v1/chat/stream, runs each requested tool through the MCP server and feeds the result back, until
//      the model stops or a fixed bound (model rounds, tool calls, time) is reached.
// Events go to the renderer in the Claude chat bridge's shape (delta/message/tool/done with usage), so the same
// renderer controller draws them. Model access and billing stay with the user's gateway; no model key ever exists here.
// Disabled (status reports `available: false`, no network call) unless a gateway is configured and an account is
// connected. Import and construction have no native side effects.
const nativeFs = require('node:fs/promises');
const nativePath = require('node:path');
const nativeSpawn = require('node:child_process').spawn;
const { randomUUID: nativeUUID } = require('node:crypto');
const { types } = require('node:util');
const shared = require('./claude-chat.cjs');

const LIMITS = Object.freeze({
  textChars: 100000, messageBytes: 65536, messages: 2000, conversations: 200, transcriptBytes: 8 * 1048576, indexBytes: 1048576,
  turns: 4, turnTimeoutMs: 20 * 60000, statusMaxAgeMs: 30000, deltaChars: 65536, titleChars: 60, toolName: 128, instructionsChars: 24000,
  // The loop: model requests per reply, tool calls per reply, one tool call's time, and what one result may add to the context.
  rounds: 16, toolCalls: 24, toolTimeoutMs: 120000, toolResultChars: 16000, historyChars: 96000,
  // Offered tools (the gateway accepts at most 64, 32 KiB per schema).
  tools: 64, toolSchemaChars: 32768, toolsChars: 196608,
  // MCP server child: start-up bound, one JSON-RPC line and the whole stdout.
  mcpStartMs: 20000, mcpLineBytes: 4 * 1048576, mcpBytes: 64 * 1048576, mcpConfigBytes: 65536,
  credentialMarginMs: 10 * 60000, credentialReuseMs: 2 * 60000, credentialSlackMs: 5000,
});
const EVENT_CHANNEL = 'arcane:arcane-chat-event';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Gateway model ids (the reference gateway's MODEL_ID). */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,95}$/;
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/u;
/** Gateway models have no reasoning levels; the chat reports one fixed level so the shared picker stays simple. */
const EFFORT = 'standard';
const MCP_PROTOCOL = '2025-06-18';
const MESSAGES = Object.freeze({
  unavailable: 'Arcane chat is unavailable.',
  busy: 'Another Arcane chat reply is still running in this conversation.',
  full: 'Too many Arcane chat replies are running. Wait for one to finish.',
  missing: 'This conversation no longer exists.',
  text: 'Message is empty or too long.',
  rewind: 'This message can no longer be edited.',
  images: 'Arcane Credits chat sends text only. Remove the attached images, then send.',
  notConnected: 'Arcane Credits are not connected yet.',
  signedOut: 'Connect your Arcane account in Settings > Plans & credits to use credits.',
  selection: 'Choose a model offered by your Arcane account.',
  declined: 'Arcane chat was not allowed to use Arcane project tools for this project.',
  credential: 'Arcane project tools could not be prepared for Arcane chat. Check that the workspace is running, then try again.',
  tools: 'Arcane project tools could not be started for Arcane chat. Check that the workspace is running, then try again.',
  stopped: 'Stopped.',
  timeout: 'The Arcane reply took too long and was stopped.',
  failed: 'Arcane could not finish this reply.',
  closed: 'The workspace closed, so the reply was stopped.',
  noCredits: "You're out of Arcane Credits. This message was not answered; buy credits to continue.",
  expired: 'Your Arcane sign-in expired. Connect your account again in Settings > Plans & credits.',
  rateLimited: 'Too many Arcane requests right now. Try again in a minute.',
  gateway: 'The Arcane gateway is unavailable. Try again shortly.',
  steps: 'Arcane paused after the most steps one reply may take. Send "continue" to go on.',
});
const SAFE_ERRORS = Object.freeze([MESSAGES.unavailable, MESSAGES.busy, MESSAGES.full, MESSAGES.missing, MESSAGES.text, MESSAGES.rewind, MESSAGES.images]);
const PREAMBLE = 'You are Arcane\'s in-app assistant for Roblox development, running through the user\'s Arcane Credits. The functions you ' +
  'can call are Arcane\'s own project tools (the same tools Arcane offers every chat); there are no shell, file or web tools. Call tools ' +
  'when the task needs Studio facts or changes, one step at a time, and read results before acting on them. Reply in concise Markdown.\n' +
  '@selection means the current Studio selection: read it with selection_read before acting on it. When the user must decide between a ' +
  'few options, end the reply with one fenced block (language arcane-choices) holding only JSON {"question":"...","options":["...","..."]} ' +
  'with 2 to 6 short plain-text options. For a large, genuinely ambiguous multi-step Studio change you may instead propose one fenced block ' +
  '(language arcane-plan) holding only JSON {"steps":["...","..."]} with 1 to 12 short steps and wait for approval; an explicit build ' +
  'request needs no plan approval. Use at most one such block per reply; the user\'s choice arrives as their next message.';
const FALLBACK_INSTRUCTIONS = 'Use Arcane\'s project tools. Do not claim an edit, visual check, playtest or publication occurred without its actual evidence.';
const PROJECT_MEMORY_FILE = 'ARCANE.md', PROJECT_MEMORY_MAX_BYTES = 16 * 1024;

class ArcaneChatError extends Error {
  constructor(key) { super(MESSAGES[key] ?? MESSAGES.unavailable); this.name = 'ArcaneChatError'; this.safe = true; }
}
const fail = key => { throw new ArcaneChatError(key); };
/** Exact plain own data fields; proxies refused before any trap and accessors never invoked. */
function plain(value, keys) {
  if (!value || typeof value !== 'object' || types.isProxy(value)) fail('unavailable');
  const prototype = Object.getPrototypeOf(value), own = Reflect.ownKeys(value);
  if (prototype !== Object.prototype && prototype !== null || own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) fail('unavailable');
  const out = Object.create(null);
  for (const key of keys) { const field = Object.getOwnPropertyDescriptor(value, key); if (!field || !field.enumerable || !Object.hasOwn(field, 'value')) fail('unavailable'); out[key] = field.value; }
  return out;
}
const isId = value => typeof value === 'string' && UUID.test(value);
const own = (value, key) => !!value && typeof value === 'object' && !types.isProxy(value) && Object.hasOwn(value, key);
/** Exact `send` envelope: the Claude chat shape; images are refused (the gateway takes text), playtest is optional. */
function sendInput(value) {
  if (own(value, 'images')) fail('images');
  const hasPlaytest = own(value, 'playtest');
  const hasDisplay=own(value,'displayText');
  const v = plain(value, ['conversationId', 'text', 'model', 'effort', ...(hasPlaytest ? ['playtest'] : []),...(hasDisplay?['displayText']:[])]);
  if (hasPlaytest && typeof v.playtest !== 'boolean') fail('unavailable');
  if (!(v.conversationId === null || isId(v.conversationId)) || typeof v.model !== 'string' || !MODEL_ID.test(v.model) || v.effort !== EFFORT) fail('unavailable');
  if (typeof v.text !== 'string' || !v.text.trim() || v.text.length > LIMITS.textChars || !v.text.isWellFormed()) fail('text');
  if(hasDisplay&&(typeof v.displayText!=='string'||!v.displayText.trim()||v.displayText.length>LIMITS.textChars||!v.displayText.isWellFormed()))fail('text');
  return Object.freeze({ conversationId: v.conversationId, text: v.text, model: v.model, effort: v.effort,...(hasDisplay?{displayText:v.displayText}:{}), ...(hasPlaytest ? { playtest: v.playtest } : {}) });
}
function rewindInput(value) {
  const v = plain(value, ['conversationId', 'messageId']);
  if (!isId(v.conversationId) || !isId(v.messageId)) fail('unavailable');
  return Object.freeze({ conversationId: v.conversationId, messageId: v.messageId });
}
const isoNow = now => new Date(now()).toISOString();
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const plainObject = value => !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const jsonSize = value => { try { return JSON.stringify(value).length; } catch { return Infinity; } };

/**
 * The MCP tool list as gateway function tools: valid names only, descriptions cut to 4096 characters, schemas that are
 * plain objects within the per-schema bound; tools that would exceed the total bound are left out (never an error).
 */
function gatewayTools(list, limits = LIMITS) {
  const out = [], names = new Set(); let total = 0;
  for (const tool of Array.isArray(list) ? list.slice(0, 256) : []) {
    if (out.length >= limits.tools) break;
    if (!tool || typeof tool.name !== 'string' || !TOOL_NAME.test(tool.name) || names.has(tool.name) || !plainObject(tool.inputSchema)) continue;
    const schemaSize = jsonSize(tool.inputSchema), description = typeof tool.description === 'string' ? tool.description.slice(0, 4096) : '';
    if (schemaSize > limits.toolSchemaChars || total + schemaSize + description.length > limits.toolsChars) continue;
    total += schemaSize + description.length; names.add(tool.name);
    out.push({ name: tool.name, description, inputSchema: tool.inputSchema });
  }
  return out;
}
/** A tool result as model context: its text blocks (or structured content), bounded, with the credential never echoed. */
function toolResultText(result, secret, max = LIMITS.toolResultChars) {
  let text = Array.isArray(result?.content) ? result.content.slice(0, 64).filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n') : '';
  if (!text && result && plainObject(result.structuredContent)) { try { text = JSON.stringify(result.structuredContent); } catch { text = ''; } }
  if (!text) text = result?.isError === true ? 'The tool failed without details.' : 'Done.';
  if (secret && text.includes(secret)) text = text.split(secret).join('[redacted]');
  return text.length > max ? text.slice(0, max) + '\n[' + (text.length - max) + ' more characters omitted]' : text;
}
/**
 * The saved transcript as model context: user and assistant text in order (tool steps folded into the assistant text as
 * short notes, errors left out), consecutive same-role text merged, starting with a user message, newest kept within bound.
 */
function historyMessages(messages, max = LIMITS.historyChars) {
  const out = [];
  const push = (role, text) => { const last = out.at(-1); if (last && last.role === role) last.content += '\n\n' + text; else out.push({ role, content: text }); };
  for (const m of messages) {
    if (m.role === 'user') push('user', m.text);
    else if (m.role === 'assistant' && m.text.trim()) push('assistant', m.text);
    else if (m.role === 'tool' && m.tool) push('assistant', '[Arcane tool ' + m.tool.name + ' ' + m.tool.status + ']');
  }
  while (out.length && out[0].role !== 'user') out.shift();
  let size = out.reduce((sum, item) => sum + item.content.length, 0);
  while (size > max && out.length > 1) { size -= out.shift().content.length; while (out.length && out[0].role !== 'user') size -= out.shift().content.length; }
  if (size > max && out.length === 1) out[0].content = '[earlier text omitted]\n' + out[0].content.slice(out[0].content.length - max);
  return out;
}
/** The fixed renderer message for a gateway refusal; `limit` marks an exhausted balance (shown with Buy credits). */
function gatewayFailure(error) {
  const code = error && typeof error === 'object' ? error.code : undefined;
  if (code === 'insufficient-credits') return { key: 'noCredits', limit: true };
  if (code === 'signed-out') return { key: 'expired', limit: false };
  if (code === 'rate-limited') return { key: 'rateLimited', limit: false };
  return { key: 'gateway', limit: false };
}

/**
 * Minimal MCP client over the server's stdio (newline-delimited JSON-RPC 2.0): initialize, tools/list, tools/call.
 * Output is bounded per line and in total; stderr is drained and never read; the server cannot call back into the host.
 */
function createMcpClient(child, { limits, onPhysicalClose }) {
  const pending = new Map();
  let seq = 0, closed = false, physicalClosed = false, started = false, total = 0, chunks = [], chunkBytes = 0, skipping = false;
  let spawnResolve, spawnReject;
  const spawned = new Promise((resolve, reject) => { spawnResolve = resolve; spawnReject = reject; });
  void spawned.catch(() => {});
  const settle = (entry, value, error, failed) => {
    if (entry.settled) return; entry.settled = true; clearTimeout(entry.timer);
    if (failed) entry.reject(error); else entry.resolve(value);
  };
  const reject = error => { for (const entry of pending.values()) settle(entry, null, error, true); };

  const finish = () => { if (closed) return; closed = true; if (!started) spawnReject(new ArcaneChatError('tools')); reject(new ArcaneChatError('tools')); };
  const send = value => { if (closed) throw new ArcaneChatError('tools'); child.stdin.write(JSON.stringify(value) + '\n', 'utf8'); };
  const line = buffer => {
    if (!buffer.length) return;
    let message; try { message = JSON.parse(buffer.toString('utf8')); } catch { return; }
    if (!plainObject(message) || message.jsonrpc !== '2.0') return;
    if (typeof message.method === 'string' && message.id !== undefined) {
      // Server-to-client requests (sampling, roots, elicitation) were not offered: refuse them.
      try { send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }); } catch { /* closing */ }
      return;
    }
    const entry = typeof message.id === 'number' ? pending.get(message.id) : undefined;
    if (!entry) return;
    pending.delete(message.id);
    // Timed-out replies drain custody without reviving their logical outcome.
    settle(entry, message.result, new ArcaneChatError('tools'), !!message.error);
  };
  child.stdout.on('data', data => {
    let chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    total += chunk.length;
    if (total > limits.mcpBytes) { close(); return; }
    for (let at = chunk.indexOf(10); at >= 0; at = chunk.indexOf(10)) {
      const head = chunk.subarray(0, at); chunk = chunk.subarray(at + 1);
      if (!skipping && chunkBytes + head.length <= limits.mcpLineBytes) line(Buffer.concat([...chunks, head]));
      chunks = []; chunkBytes = 0; skipping = false;
    }
    if (skipping || !chunk.length) return;
    chunkBytes += chunk.length;
    if (chunkBytes > limits.mcpLineBytes) { chunks = []; chunkBytes = 0; skipping = true; } else chunks.push(chunk);
  });
  child.stderr?.on('data', () => {});
  for (const stream of [child.stdout, child.stderr, child.stdin]) stream?.on?.('error', () => {});
  child.once('spawn', () => { started = true; spawnResolve(); });
  child.once('error', finish);
  child.once('close', () => { if (physicalClosed) return; physicalClosed = true; finish(); pending.clear(); onPhysicalClose?.(); });
  function request(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      // Fixed original bound: initialize + four list pages +24 tool calls.
      if (closed || pending.size >= 29 || seq >= Number.MAX_SAFE_INTEGER) { reject(new ArcaneChatError('tools')); return; }
      const id = ++seq, entry = { resolve, reject, timer: null, settled: false };
      entry.timer = setTimeout(() => settle(entry, null, new ArcaneChatError('tools'), true), timeoutMs);
      pending.set(id, entry);
      try { send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }); }
      catch (error) { settle(entry, null, error, true); /* a partial write remains owned until close */ }
    });
  }
  function notify(method) { send({ jsonrpc: '2.0', method }); }
  function close() { finish(); try { child.stdin.end(); } catch { /* closed */ } try { child.kill(); } catch { /* closed */ } }
  return { request, notify, close, closed: () => closed, spawned: () => spawned, inFlight: () => pending.size };
}

function createArcaneChat(options) {
  if (!options || typeof options !== 'object' || typeof options.getWindow !== 'function' || typeof options.projectPath !== 'string' || typeof options.gateway !== 'function' ||
      typeof options.stateDirectory !== 'string' || !options.handoff || typeof options.handoff.prepare !== 'function' || typeof options.handoff.release !== 'function') fail('unavailable');
  // Trusted main-process seams for tests only; never IPC payloads.
  const fs = options.fs ?? nativeFs, spawn = options.spawn ?? nativeSpawn, platform = options.platform ?? process.platform;
  const p = platform === 'win32' ? nativePath.win32 : nativePath.posix;
  const env = { ...(options.env ?? process.env) }, now = options.now ?? (() => Date.now());
  const randomUUID = options.randomUUID ?? nativeUUID, handoff = options.handoff;
  const limits = Object.freeze({ ...LIMITS, ...(options.limits ?? {}) });
  const projectPath = options.projectPath;
  const appAssets = options.appAssets === undefined ? null : options.appAssets;
  if (options.appAssets !== undefined && (!appAssets || typeof appAssets.issue !== 'function' || typeof appAssets.isCurrent !== 'function')) fail('unavailable');
  const assetConnectionId = appAssets ? randomUUID() : null, assetTurns = new Set();
  const assetCurrent = () => { try { return !appAssets || appAssets.isCurrent() === true; } catch { return false; } };
  const assetMethods = ['launchEnvironment', 'bind', 'grantNextIntent', 'dispatched', 'ended', 'cancelWork', 'retire', 'transportClosed'];
  function scrub(value, secrets) {
    let encoded; try { encoded = JSON.stringify(value); } catch { return null; }
    if (encoded === undefined) return null;
    for (const secret of secrets) encoded = encoded.split(secret).join('[redacted]');
    try { return JSON.parse(encoded); } catch { return null; }
  }
  function deltaRedactor(secrets) {
    let held = '';
    return text => {
      held += text;
      for (const secret of secrets) held = held.split(secret).join('[redacted]');
      let keep = 0;
      for (const secret of secrets) for (let n = 1; n < secret.length && n <= held.length; n++) if (held.endsWith(secret.slice(0, n))) keep = Math.max(keep, n);
      const safe = held.slice(0, held.length - keep); held = keep ? held.slice(-keep) : ''; return safe;
    };
  }
  function maybeCloseAssets(turn) {
    const a = turn.asset;
    if (!a || !a.loopSettled) return;
    if (!a.context) { assetTurns.delete(turn); return; }
    if (!a.deliverySettled || !a.cleanupSettled || !a.childClosed || a.client?.inFlight() || a.gateway.size || a.closeSent) return;
    a.closeSent = true;
    // One attempt only. Unknown acknowledgement keeps this bounded owner pinned.
    void Promise.resolve().then(() => a.context.transportClosed()).then(() => { a.secret = null; assetTurns.delete(turn); }, () => { a.unknown = true; });
  }
  function cleanupAssets(turn) {
    const a = turn.asset;
    if (!a || a.cleanupStarted || !a.context) return;
    a.cleanupStarted = true;
    const attempt = async action => { try { await action(); } catch { a.unknown = true; } };
    // Invoke in private channel order without awaiting: retire fences the local
    // capability synchronously even if an earlier cleanup ACK is held/lost.
    const pending = [];
    if (a.cancel) pending.push(attempt(() => a.cancel));
    if (a.dispatched) pending.push(attempt(() => a.context.ended(turn.turnId)));
    pending.push(attempt(() => a.context.retire()));
    void Promise.all(pending).then(() => { a.cleanupSettled = true; maybeCloseAssets(turn); });
  }
  async function issueAssets(turn) {
    if (!appAssets) return;
    if (interrupted(turn) || turns.get(turn.turnId) !== turn || turn.finished) fail('closed');
    const context = await appAssets.issue({conversationId: turn.conversationId, connectionId: assetConnectionId});
    turn.asset.context = context;
    if (!context || assetMethods.some(name => typeof context[name] !== 'function')) fail('credential');
    if (interrupted(turn) || turns.get(turn.turnId) !== turn || turn.finished) { cleanupAssets(turn); fail('closed'); }
    const overlay = context.launchEnvironment(), d = overlay && Object.getOwnPropertyDescriptor(overlay, 'ARCANE_ASSET_TOKEN');
    if (!d || !Object.hasOwn(d, 'value') || d.enumerable || typeof d.value !== 'string' || !/^[0-9a-f]{64}$/.test(d.value)) { cleanupAssets(turn); fail('credential'); }
    turn.asset.secret = d.value;
  }
  async function assetAck(turn, name, value) {
    if (!turn.asset) return;
    if (interrupted(turn) || turn.finished || turns.get(turn.turnId) !== turn) fail('closed');
    if (name === 'dispatched') turn.asset.dispatched = true;
    await turn.asset.context[name](...(value === undefined ? [] : [value]));
    if (interrupted(turn) || turn.finished || turns.get(turn.turnId) !== turn) fail('closed');
  }
  const store = shared.createChatStore({ fs, p, directory: options.stateDirectory, now, limits, modelPattern: MODEL_ID });
  const turns = new Map(), byConversation = new Map(), credentials = new Set();
  let disposed = false, statusCache = null, statusRun = null, approval = null, approved = false, credential = null, minting = null, instructions = null;

  function emit(event) {
    try {
      if (appAssets && event.type !== 'done') { const turn = turns.get(event.turnId); if (!turn || interrupted(turn)) return; }
      const window = options.getWindow();
      if (!window || window.isDestroyed?.() || !window.webContents || window.webContents.isDestroyed?.()) return;
      window.webContents.send(EVENT_CHANNEL, event);
    } catch { /* A closed renderer misses the event; the transcript keeps it. */ }
  }
  /** The MCP child's environment: a short allowlist of the host's variables plus the scoped credential overlay. */
  function childEnvironment(overlay, assetSecret) {
    const output = {};
    const names = ['SystemRoot', 'WINDIR', 'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'PATH'];
    for (const name of names) {
      const key = Object.keys(env).find(item => item.toLowerCase() === name.toLowerCase());
      const value = key === undefined ? undefined : env[key];
      if (typeof value === 'string' && !CONTROL.test(value) && Buffer.byteLength(value) <= 32768) output[name] = value;
    }
    // Explicit copy from the nonenumerable launch overlay into final spawn env only.
    return { ...output, ARCANE_DAEMON_URL: overlay.ARCANE_DAEMON_URL, ARCANE_LOCAL_TOKEN: overlay.ARCANE_LOCAL_TOKEN,
      ...(assetSecret ? {ARCANE_ASSET_TOKEN: assetSecret, ARCANE_ASSET_AUDIENCE: 'native-session'} : {}) };
  }

  // ---- Status: the account's models (with credit prices) and balance; nothing is requested while disabled ----------
  const snapshot = value => { const frozen = Object.freeze({ ...value, models: Object.freeze(value.models.map(model => Object.freeze({ ...model }))), efforts: Object.freeze([EFFORT]) });
    statusCache = { at: now(), value: frozen }; return frozen; };
  const empty = (state, message) => ({ available: false, state, models: [], defaultModel: null, balance: null, message });
  async function readStatus() {
    if (disposed) return snapshot(empty('disabled', MESSAGES.unavailable));
    let gateway = null;
    try { gateway = await options.gateway(); } catch { gateway = null; }
    if (!gateway) return snapshot(empty('disabled', MESSAGES.notConnected));
    let state = null; try { state = await gateway.status(); } catch { state = null; }
    if (!state || state.state !== 'ready') return snapshot(empty(state?.state === 'signed-out' ? 'signed-out' : 'disabled', state?.state === 'signed-out' ? MESSAGES.signedOut : MESSAGES.notConnected));
    let listed;
    try { listed = await gateway.models(); }
    catch (error) { const failure = gatewayFailure(error); return snapshot({ ...empty(failure.key === 'expired' ? 'signed-out' : 'error', MESSAGES[failure.key]), available: true }); }
    const models = [];
    for (const row of Array.isArray(listed) ? listed.slice(0, 32) : []) {
      if (!row || typeof row.id !== 'string' || !MODEL_ID.test(row.id) || typeof row.label !== 'string' || !row.label || row.label.length > 64 || CONTROL.test(row.label) || models.some(m => m.id === row.id)) continue;
      const pricing = row.pricing && Number.isSafeInteger(row.pricing.inputPerMTok) && Number.isSafeInteger(row.pricing.outputPerMTok) && row.pricing.inputPerMTok >= 0 && row.pricing.outputPerMTok >= 0
        ? { inputPerMTok: row.pricing.inputPerMTok, outputPerMTok: row.pricing.outputPerMTok } : null;
      models.push({ id: row.id, label: row.label, pricing });
    }
    let balance = null;
    try {
      const b = await gateway.balance();
      if (b && Number.isFinite(b.credits) && b.credits >= 0) balance = { credits: Math.floor(b.credits), actionsRemaining: Number.isSafeInteger(b.actionsRemaining) && b.actionsRemaining >= 0 ? b.actionsRemaining : null,
        plan: typeof b.plan === 'string' && b.plan.length <= 48 && !CONTROL.test(b.plan) ? b.plan : null };
    } catch { balance = null; }
    return snapshot({ available: true, state: 'ready', models, defaultModel: models[0]?.id ?? null, balance, message: models.length ? null : 'Your Arcane gateway offers no models right now.' });
  }
  function status() { statusRun ??= readStatus().catch(() => snapshot(empty('disabled', MESSAGES.unavailable))).finally(() => { statusRun = null; }); return statusRun; }
  async function freshStatus() {
    if (statusCache && now() - statusCache.at >= 0 && now() - statusCache.at < limits.statusMaxAgeMs) return statusCache.value;
    return status();
  }

  // ---- Consent and the scoped credential (Claude chat's rules: same switch, same scope, same renewal) --------------
  async function autoApproved() {
    try { return typeof options.permissions?.claudeTools === 'function' && (await options.permissions.claudeTools()) === true; } catch { return false; }
  }
  function ensureApproval() {
    if (approved) return Promise.resolve(true);
    approval ??= (async () => {
      if (await autoApproved()) { if (disposed) return false; approved = true; return true; }
      const window = options.getWindow();
      if (!window || window.isDestroyed?.()) return false;
      const dialog = options.dialog ?? require('electron').dialog;
      const remember = typeof options.permissions?.allowClaudeTools === 'function';
      const result = await dialog.showMessageBox(window, {
        type: 'question', title: 'Arcane chat', message: 'Use Arcane chat with Arcane project tools?',
        detail: 'Arcane chat sends your messages to the model you chose through your Arcane account and uses your Arcane Credits. ' +
          'When the model asks for a project tool, Arcane runs it here with a scoped project credential (work coordination and Studio commands you already allowed). ' +
          'The credential renews automatically while you work and is revoked when the project closes. There are no shell, file or web tools. ' +
          (remember ? 'Choose Always allow to stop asking for this project; you can change it in Settings > Permissions.' : 'Arcane asks once each time this project is opened.') +
          '\n\nProject: ' + projectPath,
        buttons: remember ? ['Cancel', 'Allow', 'Always allow'] : ['Cancel', 'Allow'], defaultId: 0, cancelId: 0, noLink: true,
      });
      if (disposed || options.getWindow() !== window) return false;
      approved = result?.response === 1 || remember && result?.response === 2;
      if (approved && result.response === 2) { try { await options.permissions.allowClaudeTools(); } catch { /* allowed for this session only */ } }
      return approved;
    })().catch(() => false).finally(() => { approval = null; });
    return approval;
  }
  function revokeApproval() {
    approved = false;
    const c = credential; credential = null;
    if (c) { c.retired = true; if (!c.users && credentials.has(c)) void retire(c); }
  }
  const remainingMs = c => Date.parse(c.expiresAt) - now();
  const reuseFloor = () => Math.max(limits.credentialMarginMs, limits.turnTimeoutMs - limits.credentialReuseMs);
  async function acquireCredential() {
    const usable = c => c && !c.retired && remainingMs(c) >= reuseFloor();
    if (usable(credential)) { credential.users++; return credential; }
    minting ??= (async () => {
      const previous = credential; credential = null;
      if (previous) { previous.retired = true; if (!previous.users) void retire(previous); }
      let receipt; try { receipt = await handoff.prepare(Object.freeze({ model: 'arcane', effort: EFFORT })); } catch { receipt = null; }
      const overlay = receipt?.env;
      if (!receipt || typeof receipt.configPath !== 'string' || !isId(receipt.handoffId) || typeof receipt.expiresAt !== 'string' || !Number.isFinite(Date.parse(receipt.expiresAt)) ||
          !overlay || typeof overlay.ARCANE_DAEMON_URL !== 'string' || typeof overlay.ARCANE_LOCAL_TOKEN !== 'string' || !overlay.ARCANE_LOCAL_TOKEN) return null;
      const minted = { handoffId: receipt.handoffId, expiresAt: receipt.expiresAt, configPath: receipt.configPath, users: 0, retired: false,
        env: Object.freeze({ ARCANE_DAEMON_URL: overlay.ARCANE_DAEMON_URL, ARCANE_LOCAL_TOKEN: overlay.ARCANE_LOCAL_TOKEN }) };
      credentials.add(minted);
      if (disposed) { minted.retired = true; void retire(minted); return null; }
      credential = minted; return minted;
    })().finally(() => { minting = null; });
    const minted = await minting;
    if (!minted || minted.retired) return null;
    minted.users++; return minted;
  }
  async function retire(c) { credentials.delete(c); try { await handoff.release(c.handoffId); } catch { /* the broker's dispose still revokes */ } }
  function releaseCredential(c) {
    if (!c) return; c.users = Math.max(0, c.users - 1);
    if (!c.retired && !c.users && credential === c && remainingMs(c) < reuseFloor()) { c.retired = true; credential = null; }
    if (c.retired && !c.users && credentials.has(c)) void retire(c);
  }

  // ---- Instructions and project memory ------------------------------------------------------------------------------
  async function loadInstructions() {
    if (instructions !== null) return instructions;
    let text = FALLBACK_INSTRUCTIONS;
    try { const value = await options.instructions?.(); if (typeof value === 'string' && value.trim()) text = value; } catch { /* fallback */ }
    // Task instructions that already describe @selection and the choice/plan blocks keep only the preamble's first line.
    const preamble = text.includes('arcane-choices') ? PREAMBLE.slice(0, PREAMBLE.indexOf('\n')) : PREAMBLE;
    instructions = (preamble + '\n\n' + text).replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').slice(0, limits.instructionsChars);
    return instructions;
  }
  /** Learned preferences from the host (daemon read, short timeout); any failure means none. Read per turn. */
  async function loadLearned() {
    try { const value = await options.learned?.(); return typeof value === 'string' ? value : ''; } catch { return ''; }
  }
  async function loadProjectMemory() {
    let handle = null;
    try {
      const file = p.join(projectPath, PROJECT_MEMORY_FILE), info = await fs.lstat(file);
      if (!info.isFile() || info.nlink > 1) return '';
      handle = await fs.open(file, 'r');
      const buffer = Buffer.alloc(PROJECT_MEMORY_MAX_BYTES), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const text = buffer.subarray(0, bytesRead).toString('utf8');
      let end = text.length; if (bytesRead === buffer.length) while (end > 0 && text.charCodeAt(end - 1) === 0xfffd) end--;
      return text.slice(0, end);
    } catch { return ''; } finally { try { await handle?.close(); } catch { /* read-only */ } }
  }

  // ---- The MCP server child for one turn ------------------------------------------------------------------------------
  /** The owned handoff config's `arcane` stdio server: an absolute command and at most 8 plain arguments; null otherwise. */
  async function mcpLaunch(configPath) {
    try {
      if (typeof configPath !== 'string' || !p.isAbsolute(configPath)) return null;
      const info = await fs.lstat(configPath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > limits.mcpConfigBytes) return null;
      const server = JSON.parse(await fs.readFile(configPath, 'utf8'))?.mcpServers?.arcane;
      if (!plainObject(server) || server.type !== 'stdio' || typeof server.command !== 'string' || !p.isAbsolute(server.command) || CONTROL.test(server.command) ||
          !Array.isArray(server.args) || server.args.length > 8 || server.args.some(arg => typeof arg !== 'string' || arg.length > 4096 || CONTROL.test(arg))) return null;
      return { command: server.command, args: [...server.args] };
    } catch { return null; }
  }
  async function startTools(turn) {
    const launch = await mcpLaunch(turn.credential.configPath);
    if (!launch || interrupted(turn) || turn.finished) return null;
    if (turn.asset && [launch.command, ...launch.args].some(value => value.includes(turn.asset.secret) || value.includes(turn.credential.env.ARCANE_LOCAL_TOKEN))) return null;
    let child;
    try { child = spawn(launch.command, launch.args, { cwd: projectPath, env: childEnvironment(turn.credential.env, turn.asset?.secret), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { return null; }
    if (turn.asset) turn.asset.childClosed = false;
    const client = createMcpClient(child, { limits, onPhysicalClose() { if (turn.asset) { turn.asset.childClosed = true; maybeCloseAssets(turn); } } });
    turn.mcp = client; if (turn.asset) turn.asset.client = client;
    try {
      const initializing = client.request('initialize', { protocolVersion: MCP_PROTOCOL, capabilities: {}, clientInfo: { name: 'arcane-desktop-chat', version: '1.0.0' } }, limits.mcpStartMs);
      const [init] = await Promise.all([initializing, ...(turn.asset ? [client.spawned()] : [])]);
      if (turn.asset) await assetAck(turn, 'bind', {kind: 'arcane-gateway-loop', incarnationId: turn.asset.loopId});
      client.notify('notifications/initialized');
      const listed = [];
      let cursor;
      for (let page = 0; page < 4; page++) {
        const result = await client.request('tools/list', cursor ? { cursor } : {}, limits.mcpStartMs);
        if (Array.isArray(result?.tools)) listed.push(...result.tools.slice(0, 256));
        cursor = typeof result?.nextCursor === 'string' && result.nextCursor.length <= 512 ? result.nextCursor : undefined;
        if (!cursor) break;
      }
      const tools = gatewayTools(listed, limits);
      const serverInstructions = typeof init?.instructions === 'string' ? init.instructions.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').slice(0, 8000) : '';
      return { client, tools, names: new Set(tools.map(tool => tool.name)), serverInstructions };
    } catch { client.close(); return null; }
  }

  // ---- Turns --------------------------------------------------------------------------------------------------------
  const message = (role, text, tool) => ({ id: randomUUID(), role, text: role==='user'?text:shared.boundedText(text, limits.messageBytes), at: isoNow(now), ...(tool ? { tool: { ...tool } } : {}) });
  const publicMessage = m => ({ id: m.id, role: m.role, text: m.text, at: m.at,...(m.delivery?{delivery:{...m.delivery}}:{}), ...(m.tool ? { tool: shared.toolCopy(m.tool) } : {}) });
  const toolName = name => (String(name).replace(/[^A-Za-z0-9._:-]/g, '_') || 'tool').slice(0, limits.toolName);

  async function send(input) {
    if (disposed) fail('unavailable');
    const v = sendInput(input);
    if (turns.size >= limits.turns || appAssets && assetTurns.size >= limits.turns) fail('full');
    let entry = null;
    if (v.conversationId !== null) { entry = await store.get(v.conversationId); if (!entry) fail('missing'); }
    const conversationId = entry ? entry.conversationId : randomUUID();
    if (disposed) fail('unavailable');
    if (byConversation.has(conversationId)) fail('busy');
    if (turns.size >= limits.turns || appAssets && assetTurns.size >= limits.turns) fail('full');
    const turn = { turnId: randomUUID(), conversationId, model: v.model, stopped: false, finished: false, timedOut: false, timer: null, credential: null, mcp: null,
      controller: new AbortController(), playtest: v.playtest, history: [],
      asset: appAssets ? {loopId: randomUUID(), context: null, secret: null, client: null, childClosed: true, gateway: new Set(),
        loopSettled: false, deliverySettled: false, cleanupStarted: false, cleanupSettled: false, dispatched: false, cancel: null, closeSent: false, unknown: false} : null };
    turns.set(turn.turnId, turn); byConversation.set(conversationId, turn); if (turn.asset) assetTurns.add(turn);
    let user = null;
    try {
      const at = isoNow(now);
      if (!entry) {
        const title = (v.displayText??v.text).replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, limits.titleChars) || 'New chat';
        await store.create({ conversationId, title, createdAt: at, updatedAt: at, model: v.model, effort: EFFORT, sessionId: null }, new Set(byConversation.keys()));
      } else await store.update(conversationId, { updatedAt: at, model: v.model, effort: EFFORT });
      // The context is the saved conversation before this message (no server-side session exists to resume).
      turn.history = historyMessages(await store.messages(conversationId) ?? [], limits.historyChars);
      user = message('user', v.displayText??v.text);
      turn.delivery={model:v.model,effort:EFFORT,turnId:turn.turnId,startedAt:at,finishedAt:null,state:'accepted',error:null,contextIncluded:v.displayText!==undefined&&v.displayText!==v.text,transmittedBytes:Buffer.byteLength(v.text)};
      user.delivery={...turn.delivery};turn.userMessage=user;
      if (!await store.put(conversationId, user)) fail('missing');
    } catch (error) {
      turns.delete(turn.turnId); byConversation.delete(conversationId); assetTurns.delete(turn);
      throw error instanceof ArcaneChatError ? error : new ArcaneChatError('unavailable');
    }
    const running = runTurn(turn, v.text);
    if (turn.asset) {
      const settled = () => { turn.asset.loopSettled = true; cleanupAssets(turn); maybeCloseAssets(turn); };
      void running.then(settled, settled);
    } else void running;
    return Object.freeze({ turnId: turn.turnId, conversationId, messageId: user.id });
  }
  async function rewind(input) {
    if (disposed) fail('unavailable');
    const v = rewindInput(input);
    if (!await store.get(v.conversationId)) fail('missing');
    if (byConversation.has(v.conversationId)) fail('busy');
    const kept = await store.truncate(v.conversationId, v.messageId);
    if (!kept) fail('rewind');
    return Object.freeze({ conversationId: v.conversationId, kept: kept.length });
  }
  async function finish(turn, ok, error, usage = null, limit = false) {
    if (turn.finished) return; turn.finished = true;
    clearTimeout(turn.timer); turn.mcp?.close(); turn.mcp = null; cleanupAssets(turn);
    releaseCredential(turn.credential); turn.credential = null;
    // Balance changed (or sign-in may have): the next status read asks the gateway again.
    statusCache = null;
    try {
      if(turn.userMessage&&turn.delivery){turn.delivery={...turn.delivery,finishedAt:isoNow(now),state:ok?'completed':turn.stopped?'stopped':'failed',error:error??null};turn.userMessage.delivery={...turn.delivery};await store.put(turn.conversationId,turn.userMessage);}
      if (error) await store.put(turn.conversationId, message('error', error));
      await store.update(turn.conversationId, { updatedAt: isoNow(now) });
    } catch { /* the done event still reports the outcome */ }
    turns.delete(turn.turnId); if (byConversation.get(turn.conversationId) === turn) byConversation.delete(turn.conversationId);
    emit({ turnId: turn.turnId, conversationId: turn.conversationId, type: 'done', ok, error: ok ? null : error ?? MESSAGES.failed, usage,
      usageLimit: ok || !limit ? null : { resetsAt: null } });
    if (turn.asset) { turn.asset.deliverySettled = true; maybeCloseAssets(turn); }
  }
  const interrupted = turn => turn.stopped || disposed || turn.timedOut || turn.finished || !assetCurrent();
  const stopMessage = turn => disposed || !assetCurrent() ? MESSAGES.closed : turn.timedOut ? MESSAGES.timeout : MESSAGES.stopped;

  async function runTurn(turn, text) {
    const usage = { inputTokens: 0, outputTokens: 0, costUsd: null, credits: null };
    const reported = () => usage.inputTokens || usage.outputTokens || usage.credits !== null ? { ...usage } : null;
    try {
      turn.timer = setTimeout(() => { if (!turn.finished) { turn.timedOut = true; turn.controller.abort(); turn.mcp?.close(); if (turn.asset) void finish(turn, false, MESSAGES.timeout); } }, limits.turnTimeoutMs);
      if (interrupted(turn)) return finish(turn, false, stopMessage(turn));
      let gateway = null; try { gateway = await options.gateway(); } catch { gateway = null; }
      if (interrupted(turn)) return finish(turn, false, stopMessage(turn));
      if (!gateway) return finish(turn, false, MESSAGES.notConnected);
      const s = await freshStatus();
      if (interrupted(turn)) return finish(turn, false, stopMessage(turn));
      if (!s.available || s.state !== 'ready') return finish(turn, false, s.message ?? MESSAGES.notConnected);
      if (!s.models.some(model => model.id === turn.model)) return finish(turn, false, MESSAGES.selection);
      if (!await ensureApproval()) return finish(turn, false, disposed ? MESSAGES.closed : MESSAGES.declined);
      if (interrupted(turn)) return finish(turn, false, stopMessage(turn));
      const acquired = await acquireCredential();
      if (turn.asset && turn.finished) { releaseCredential(acquired); return; }
      turn.credential = acquired;
      if (interrupted(turn)) return finish(turn, false, stopMessage(turn));
      if (!turn.credential) return finish(turn, false, MESSAGES.credential);
      await issueAssets(turn);
      const tools = await startTools(turn);
      if (interrupted(turn)) return finish(turn, false, stopMessage(turn));
      if (!tools) return finish(turn, false, MESSAGES.tools);
      const secret = turn.credential.env.ARCANE_LOCAL_TOKEN, secrets = [turn.asset?.secret, secret].filter(Boolean).sort((a, b) => b.length - a.length);
      const clean = value => turn.asset ? scrub(value, secrets) : value;
      const leaks = value => typeof value === 'string' && secrets.some(secret => value.includes(secret));
      // The server instructions carry the shared guidance block, so the task instructions' copy of it is left out.
      const own = clean(await loadInstructions()), server = clean(tools.serverInstructions);
      const system = (server.includes(shared.GUIDANCE_START) ? shared.withoutSharedGuidance(own) : own) + (server ? '\n\n' + server : '') + shared.projectMemorySection(await loadProjectMemory()) + shared.learnedPreferenceSection(await loadLearned());
      const messages = [{ role: 'system', content: system }, ...turn.history, { role: 'user', content: text + shared.playtestNote(turn.playtest) }];
      if (turn.asset) { await assetAck(turn, 'grantNextIntent'); await assetAck(turn, 'dispatched', turn.turnId); }
      const base = { turnId: turn.turnId, conversationId: turn.conversationId };
      let calls = 0, imagesShown = 0;
      for (let round = 0; ; round++) {
        if (interrupted(turn)) return finish(turn, false, stopMessage(turn), reported());
        if (round >= limits.rounds) return finish(turn, false, MESSAGES.steps, reported());
        let reply = '', done = null;
        const requested = [], redactDelta = turn.asset ? deltaRedactor(secrets) : null;
        const hold = turn.asset ? {settled: false, observed: false, closed: false} : null;
        if (hold) turn.asset.gateway.add(hold);
        const drain = () => { if (hold && hold.settled && hold.closed) { turn.asset.gateway.delete(hold); maybeCloseAssets(turn); } };
        try {
          if (interrupted(turn)) { if (hold) turn.asset.gateway.delete(hold); return finish(turn, false, stopMessage(turn), reported()); }
          for await (const chunk of gateway.streamChat({ model: turn.model, messages: clean(messages), tools: clean(tools.tools), conversationId: turn.conversationId, turnId: turn.turnId }, turn.controller.signal,
            hold ? value => {
              if (hold.observed) return; hold.observed = true;
              hold.closed = Object.isFrozen(value) && value?.state === 'closed'; drain();
            } : undefined)) {
            if (interrupted(turn)) return finish(turn, false, stopMessage(turn), reported());
            if (chunk.type === 'delta') {
              if (typeof chunk.text !== 'string' || !chunk.text || !redactDelta && leaks(chunk.text)) continue;
              const safe = redactDelta ? redactDelta(chunk.text) : chunk.text;
              reply += safe; if (safe) emit({ ...base, type: 'delta', text: safe.slice(0, limits.deltaChars) });
            } else if (chunk.type === 'tool_call') requested.push(clean(chunk.call));
            else if (chunk.type === 'done') done = chunk;
            else if (chunk.type === 'error') { done = null; reply = reply || ''; throw Object.assign(new Error('stream'), { streamMessage: chunk.message }); }
          }
        } catch (error) {
          if (interrupted(turn)) return finish(turn, false, stopMessage(turn), reported());
          if (reply.trim() && !leaks(reply)) { const m = message('assistant', reply); await store.put(turn.conversationId, m).catch(() => {}); emit({ ...base, type: 'message', message: publicMessage(m) }); }
          if (error && typeof error === 'object' && 'streamMessage' in error) return finish(turn, false, shared.safeResultText(clean(error.streamMessage)) ?? MESSAGES.failed, reported());
          const failure = gatewayFailure(error);
          return finish(turn, false, MESSAGES[failure.key], reported(), failure.limit);
        } finally { if (hold) { hold.settled = true; drain(); } }
        if (done) {
          usage.inputTokens += count(done.inputTokens); usage.outputTokens += count(done.outputTokens);
          if (typeof done.creditsUsed === 'number' && Number.isFinite(done.creditsUsed) && done.creditsUsed >= 0) usage.credits = (usage.credits ?? 0) + done.creditsUsed;
        } else if (!interrupted(turn)) return finish(turn, false, MESSAGES.failed, reported());
        if (interrupted(turn)) return finish(turn, false, stopMessage(turn), reported());
        if (reply.trim() && !leaks(reply)) {
          const m = {...message('assistant', reply),...(turn.delivery?{delivery:{...turn.delivery,state:'completed',finishedAt:isoNow(now)}}:{})};
          await store.put(turn.conversationId, m).catch(() => {});
          emit({ ...base, type: 'message', message: publicMessage(m) });
        }
        if (!requested.length) return finish(turn, true, null, reported());
        messages.push({ role: 'assistant', content: leaks(reply) ? '' : reply, toolCalls: requested.map(call => ({ id: call.id, name: call.name, arguments: call.arguments })) });
        for (const call of requested) {
          if (interrupted(turn)) return finish(turn, false, stopMessage(turn), reported());
          const name = toolName(call.name), input = shared.toolDetail(clean(call.arguments), secret);
          const m = message('tool', name, { name, status: 'started', ...(input ? { input } : {}) });
          await store.put(turn.conversationId, m).catch(() => {});
          emit({ ...base, type: 'tool', message: publicMessage(m) });
          let result = null, isError = true, content;
          if (++calls > limits.toolCalls) content = 'Arcane reached the most tool calls one reply may make. Summarise what was done and what is left.';
          else if (!tools.names.has(call.name)) content = 'Unknown tool: ' + name + '. Use only the tools offered.';
          else {
            try {
              if (interrupted(turn)) return finish(turn, false, stopMessage(turn), reported());
              result = clean(await tools.client.request('tools/call', { name: call.name, arguments: clean(call.arguments) }, limits.toolTimeoutMs));
              if (interrupted(turn)) return finish(turn, false, stopMessage(turn), reported());
              isError = result?.isError === true; content = toolResultText(result, secret, limits.toolResultChars);
            } catch {
              if (turn.asset && turn.finished) return;
              if (interrupted(turn)) { m.tool = { ...shared.toolCopy(m.tool), status: 'failed' }; await store.put(turn.conversationId, { ...m }).catch(() => {}); emit({ ...base, type: 'tool', message: publicMessage(m) }); return finish(turn, false, stopMessage(turn), reported()); }
              content = 'The tool did not answer. It may still be running in Studio; check before repeating it.';
              if (tools.client.closed()) { m.tool = { ...shared.toolCopy(m.tool), status: 'failed' }; await store.put(turn.conversationId, { ...m }).catch(() => {}); emit({ ...base, type: 'tool', message: publicMessage(m) }); return finish(turn, false, MESSAGES.tools, reported()); }
            }
          }
          const detail = result ? shared.toolResultDetail(result.content, secret) : shared.toolResultDetail(content, secret);
          m.tool = { ...shared.toolCopy(m.tool), status: isError ? 'failed' : 'finished', ...(detail ? { result: detail } : {}) };
          await store.put(turn.conversationId, { ...m, tool: shared.toolCopy(m.tool) }).catch(() => {});
          // Every offered tool is one of Arcane's own MCP server's; a capture rides on this live event only, bounded per reply.
          let image = result && !isError && imagesShown < shared.TOOL_IMAGE_LIMITS.perTurn ? shared.toolResultImage(result.content) : null;
          if (image && turn.asset) {
            try { const bytes = Buffer.from(image.slice(image.indexOf(',') + 1), 'base64'); if (secrets.some(secret => bytes.includes(Buffer.from(secret)))) image = null; } catch { image = null; }
          }
          if (image) imagesShown++;
          emit({ ...base, type: 'tool', message: shared.withToolImage(publicMessage(m), image) });
          messages.push({ role: 'tool', toolCallId: call.id, content, ...(isError ? { isError: true } : {}) });
        }
      }
    } catch { return finish(turn, false, interrupted(turn) ? stopMessage(turn) : MESSAGES.failed, reported()); }
  }

  async function list() {
    if (disposed) fail('unavailable');
    const entries = await store.list();
    entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return Object.freeze({ conversations: entries.map(e => ({ conversationId: e.conversationId, title: e.title, updatedAt: e.updatedAt, model: e.model, effort: e.effort })) });
  }
  async function history(conversationId) {
    if (disposed) fail('unavailable');
    if (!isId(conversationId)) fail('unavailable');
    const messages = await store.messages(conversationId);
    if (!messages) fail('missing');
    return Object.freeze({ conversationId, messages: messages.map(publicMessage) });
  }
  function halt(turn, explicit = false) {
    turn.stopped = true;
    if (explicit && turn.asset?.context && !turn.asset.cancel) {
      try { turn.asset.cancel = Promise.resolve(turn.asset.context.cancelWork('incarnation')); }
      catch (error) { turn.asset.cancel = Promise.reject(error); }
      void turn.asset.cancel.catch(() => {});
    }
    turn.controller.abort(); turn.mcp?.close();
    if (turn.asset) void finish(turn, false, stopMessage(turn));
  }
  function stop(turnId) {
    if (!isId(turnId)) fail('unavailable');
    const turn = turns.get(turnId);
    if (!turn || turn.finished) return Promise.resolve(false);
    halt(turn, true);
    return Promise.resolve(true);
  }
  async function remove(conversationId) {
    if (disposed) fail('unavailable');
    if (!isId(conversationId)) fail('unavailable');
    const turn = byConversation.get(conversationId);
    if (turn) halt(turn, true);
    return store.remove(conversationId);
  }
  /** App quit / project switch: stop every turn, close its MCP child and revoke the credentials this host minted. */
  async function dispose() {
    if (disposed) return; disposed = true;
    for (const turn of turns.values()) halt(turn);
    const owned = [...credentials]; credential = null;
    for (const c of owned) c.retired = true;
    await Promise.all(owned.map(retire));
  }
  const host = { version: 1, status: () => status(), list, history, send, rewind, stop, remove };
  Object.defineProperties(host, { dispose: { value: dispose }, activeTurns: { value: () => turns.size }, revokeApproval: { value: revokeApproval } });
  return Object.freeze(host);
}

/** Human IPC: only the trusted main window's main frame on the daemon origin; every argument shape is exact. */
function installArcaneChatIpc(ipcMain, { getSession, getHost }) {
  const policy = require('./policy.cjs');
  function scope(event) {
    const session = getSession(), window = session?.window, contents = window?.webContents, frame = event?.senderFrame;
    if (!session || !window || window.isDestroyed() || !contents || contents.isDestroyed() || event.sender !== contents || !frame || frame !== contents.mainFrame ||
        !policy.validOrigin(session.origin) || !policy.navigationAllowed(session.origin, frame.url) || new URL(frame.url).href !== frame.url) fail('unavailable');
    return session;
  }
  for (const action of ['status', 'list', 'history', 'send', 'rewind', 'stop', 'remove']) ipcMain.handle('arcane:arcane-chat-' + action, async (event, ...args) => {
    try {
      const before = scope(event), host = getHost();
      if (!host) fail('unavailable');
      let input;
      if (action === 'status' || action === 'list') { if (args.length) fail('unavailable'); }
      else if (action === 'send') { if (args.length !== 1) fail('unavailable'); input = sendInput(args[0]); }
      else if (action === 'rewind') { if (args.length !== 1) fail('unavailable'); input = rewindInput(args[0]); }
      else { if (args.length !== 1 || !isId(args[0])) fail('unavailable'); input = args[0]; }
      const response = input === undefined ? await host[action]() : await host[action](input);
      const after = getSession();
      if (!after || after.window !== before.window || after.epoch !== before.epoch || getHost() !== host) fail('unavailable');
      return response;
    } catch (error) {
      throw new Error(error instanceof ArcaneChatError && SAFE_ERRORS.includes(error.message) ? error.message : MESSAGES.unavailable);
    }
  });
}

module.exports = { createArcaneChat, installArcaneChatIpc, sendInput, gatewayTools, toolResultText, historyMessages, createMcpClient,
  ARCANE_CHAT_LIMITS: LIMITS, ARCANE_CHAT_MESSAGES: MESSAGES, ARCANE_CHAT_EVENT: EVENT_CHANNEL, ARCANE_CHAT_EFFORT: EFFORT };
