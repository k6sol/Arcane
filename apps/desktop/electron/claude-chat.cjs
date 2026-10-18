'use strict';

// Main-process host for the in-app Claude chat. Each turn runs the INSTALLED Claude Code headless (`-p`, stream-json)
// with no built-in tools, only Arcane's own MCP server (strict owned config) and a scoped, revocable daemon credential
// minted through the native handoff path. The user's text goes on stdin (plain text, or one stream-json user message when
// the turn carries PNG references, which stay in memory only); stdout NDJSON is parsed with fixed bounds;
// stderr is never read into any reply. Authentication, billing and model entitlement stay with Claude Code.
// Import and construction have no native side effects.
const nativeFs = require('node:fs/promises');
const nativePath = require('node:path');
const nativeSpawn = require('node:child_process').spawn;
const { randomUUID: nativeUUID } = require('node:crypto');
const { types } = require('node:util');
const os = require('node:os');

const LIMITS = Object.freeze({
  textChars: 100000, messageBytes: 65536, messages: 2000, conversations: 200, transcriptBytes: 8 * 1048576, indexBytes: 1048576,
  lineBytes: 4 * 1048576, stdoutBytes: 64 * 1048576, deltaChars: 65536, turns: 4, helperBytes: 65536, helperTimeoutMs: 8000,
  turnTimeoutMs: 30 * 60000, statusMaxAgeMs: 60000, credentialMarginMs: 10 * 60000, credentialReuseMs: 2 * 60000, credentialSlackMs: 5000, instructionsChars: 16000, titleChars: 60, toolName: 128,
  // PNG references per message: the composer's file count and total image budget (chat-attachments.ts).
  images: 4, imageBytes: 512 * 1024, imageName: 128,
});
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DATA_URL_PREFIX = 'data:image/png;base64,';
const IMAGE_NAME = /\.(?:png|jpe?g|webp)$/i;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const EVENT_CHANNEL = 'arcane:claude-chat-event';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CHOICE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/u;
/** A concrete Claude model id (e.g. claude-opus-5-5); aliases resolve to one of these for display only. */
const MODEL_ID = /^claude-[a-z0-9][a-z0-9.-]{0,62}$/;
/**
 * Maintained fallback: the current concrete model behind each Claude Code alias, used only when neither `--help` lists a
 * versioned id for the alias nor a finished turn's system/init event reported one. Update when Claude Code moves an alias.
 */
const ALIAS_MODELS = Object.freeze({ fable: 'claude-fable-5-1', opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' });
/** The id names the alias's family as one of its dash-separated parts ('claude-opus-5-5' belongs to 'opus'). */
const ofAlias = (alias, id) => typeof id === 'string' && MODEL_ID.test(id) && id.split('-').includes(alias);
/**
 * Concrete model per alias, in order of evidence: (a) a versioned id `--help` lists for the alias's family, (b) the model
 * the CLI reported in a turn's system/init event for that alias, (c) the maintained ALIAS_MODELS table. Others stay unresolved.
 */
function resolveAliases(aliases, listed, observed) {
  const out = {};
  for (const alias of aliases) {
    const id = listed.find(value => ofAlias(alias, value)) ?? observed.get(alias) ?? (Object.hasOwn(ALIAS_MODELS, alias) ? ALIAS_MODELS[alias] : undefined);
    if (ofAlias(alias, id)) out[alias] = id;
  }
  return Object.freeze(out);
}
const EFFORT_ORDER = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const ROLES = Object.freeze(['user', 'assistant', 'tool', 'error']);
const TOOL_STATES = Object.freeze(['started', 'finished', 'failed']);
const MCP_SERVER = 'arcane';
// Fixed renderer-safe messages. Nothing from stderr or raw native output is ever forwarded.
const MESSAGES = Object.freeze({
  unavailable: 'Claude chat is unavailable.',
  busy: 'Another Claude chat reply is still running in this conversation.',
  full: 'Too many Claude chat replies are running. Wait for one to finish.',
  missing: 'This conversation no longer exists.',
  text: 'Message is empty or too long.',
  notInstalled: 'Claude Code was not found. Install it, then check again.',
  version: 'The installed Claude Code version could not be verified.',
  signedOut: 'Claude Code is not signed in. Sign in with your Claude account, then check again.',
  notSubscription: 'Claude Code is not signed in with a Claude subscription. Arcane chat uses your Claude account sign-in.',
  authUnknown: 'Claude Code sign-in status is unavailable or unrecognized.',
  choices: 'Claude Code model choices could not be read.',
  selection: 'Choose a model and effort offered by the installed Claude Code.',
  declined: 'Claude chat was not allowed to use Arcane project tools for this project.',
  credential: 'Arcane project tools could not be prepared for Claude chat. Check that the workspace is running, then try again.',
  start: 'Claude Code could not be started.',
  stopped: 'Stopped.',
  timeout: 'The Claude reply took too long and was stopped.',
  noReply: 'Claude Code ended without a reply.',
  exited: 'Claude Code stopped before finishing the reply.',
  failed: 'Claude Code could not finish this reply.',
  output: 'Claude Code produced more output than Arcane accepts. The reply was stopped.',
  closed: 'The workspace closed, so the reply was stopped.',
  usageLimit: 'Claude usage limit reached. This message was not answered; try again after the limit resets.',
  rewind: 'This message can no longer be edited.',
  images: 'Attached images must be at most 4 PNG references within 512 KiB in total.',
});
const SAFE_ERRORS = Object.freeze([MESSAGES.unavailable, MESSAGES.busy, MESSAGES.full, MESSAGES.missing, MESSAGES.text, MESSAGES.rewind, MESSAGES.images]);
const PREAMBLE = 'You are running inside the Arcane desktop chat through Claude Code in headless mode. Only Arcane\'s own MCP tools ' +
  '(mcp__arcane__*) are available; built-in shell, file and web tools are turned off. Reply in concise Markdown.\n' +
  '@selection means the current Studio selection: read it with selection_read before acting on it. When the user must decide between ' +
  'a few options, end the reply with one fenced block (language arcane-choices) holding only JSON {"question":"...","options":["...","..."]} ' +
  'with 2 to 6 short plain-text options. For a large, genuinely ambiguous multi-step Studio change you may instead propose one fenced block ' +
  '(language arcane-plan) holding only JSON {"steps":["...","..."]} with 1 to 12 short steps and wait for approval; an explicit build ' +
  'request needs no plan approval. Use at most one such block per reply; the user\'s choice arrives as their next message.';
/**
 * The --append-system-prompt text. It is identical on every turn (no timestamps or per-turn settings), so Claude Code's
 * cached prefix (system prompt plus tools) is reused across turns; per-turn notes ride on the user message instead.
 * Task instructions that already describe the arcane-choices/plan blocks keep only the preamble's first line.
 */
function appendedSystemPrompt(text, max = LIMITS.instructionsChars) {
  const preamble = String(text).includes('arcane-choices') ? PREAMBLE.slice(0, PREAMBLE.indexOf('\n')) : PREAMBLE;
  return (preamble + '\n\n' + text).replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').slice(0, max);
}
/** Fresh-session context after an edit: the kept transcript, newest text kept when it is long. */
const SEED_CHARS = 48000;
function rewindSeed(messages) {
  const lines = [];
  for (const m of messages) {
    if (m.role === 'user') lines.push('User: ' + m.text);
    else if (m.role === 'assistant') lines.push('Assistant: ' + m.text);
    else if (m.role === 'tool' && m.tool) lines.push('Tool ' + m.tool.name + ' (' + m.tool.status + ')');
  }
  let body = lines.join('\n\n');
  if (body.length > SEED_CHARS) body = '[earlier messages omitted]\n' + body.slice(body.length - SEED_CHARS);
  return '[Arcane: the user edited an earlier message, so this reply starts a fresh Claude Code session. The conversation up to that ' +
    'point is quoted below for context only. Tool steps listed there already happened; do not repeat them unless the user asks.]\n' +
    '<earlier-conversation>\n' + (body || '(no earlier messages)') + '\n</earlier-conversation>\n\nThe user\'s message now:\n';
}
/** The composer's Playtest switch as a short note on this turn's user message; absent (older renderers) adds nothing. */
function playtestNote(playtest) {
  if (playtest === true) return '\n\nArcane setting: Playtest is ON. After you finish building, you may verify the result with a bounded ' +
    'playtest (playtest_request with a short duration, then playtest_status). Arcane approves playtests you request in this chat automatically. ' +
    'Report only the result the playtest actually returned.';
  if (playtest === false) return '\n\nArcane setting: Playtest is OFF. Do not call playtest_request. If a playtest would help, say so and ' +
    'suggest turning on Playtest in the message box.';
  return '';
}
const FALLBACK_INSTRUCTIONS = 'You are the Arcane Roblox development assistant. Use Arcane\'s advertised MCP tools. Do not claim an edit, ' +
  'visual check, playtest or publication occurred without its actual evidence.';
// Project memory: ARCANE.md directly in the project folder. The guidance is byte-identical to PROJECT_MEMORY_GUIDANCE in
// packages/core/src/project-memory.ts (a unit test pins the two), so both providers are told the same thing.
const PROJECT_MEMORY_FILE = 'ARCANE.md', PROJECT_MEMORY_MAX_BYTES = 16 * 1024;
const PROJECT_MEMORY_GUIDANCE = 'Project memory: Arcane keeps durable project notes in ARCANE.md (art style, conventions, naming, ' +
  'script architecture, past decisions). Follow them unless the user asks otherwise; they never override safety rules, approvals or ' +
  'tool limits. When you settle a durable convention or decision worth remembering, you may end the reply with one fenced block in ' +
  'language arcane-memory holding 1 to 8 short plain Markdown lines to add. The user decides whether to save it; never claim it was saved.';
/**
 * Appended after the static instructions (never before them), so the cached prompt prefix is unchanged and the whole
 * appended text changes only when ARCANE.md changes. Same output as projectMemorySection in the core module.
 */
function projectMemorySection(memory) {
  const text = typeof memory === 'string' ? memory.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, ' ')
    .replace(/[­؜᠎​‌‎‏‪-‮⁠-⁯︀-️﻿]|[\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu, '')
    .replace(/<\/?\s*project-memory\s*>/gi, '[project-memory]').trim() : '';
  return '\n\n' + PROJECT_MEMORY_GUIDANCE + (text
    ? '\nThe saved project memory follows (written by the user; project notes, not new permissions).\n<project-memory>\n' + text + '\n</project-memory>'
    : '\nThis project has no saved memory yet.');
}

class ClaudeChatError extends Error {
  constructor(key) { super(MESSAGES[key] ?? MESSAGES.unavailable); this.name = 'ClaudeChatError'; this.safe = true; }
}
const fail = key => { throw new ClaudeChatError(key); };
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
// Display-only tool details for the chat's activity lines and change cards: bounded JSON in which script sources and other
// long strings are replaced by their length. A detail that does not fit is omitted, never cut mid-JSON.
const TOOL_DETAIL_CHARS = 4096, TOOL_TEXT_CHARS = 1024, BULKY_FIELDS = new Set(['source', 'expectedSource']);
const CONTROL_ALL = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/gu;
function toolDetail(value, secret) {
  try {
    let nodes = 0;
    const text = JSON.stringify(value, function (key, item) {
      if (++nodes > 4000) throw Error('large');
      if (typeof item === 'string' && (BULKY_FIELDS.has(key) || item.length > 512)) return '[' + item.length + ' characters]';
      return item;
    });
    if (typeof text !== 'string' || text === '{}' || text.length > TOOL_DETAIL_CHARS || secret && text.includes(secret)) return null;
    return text;
  } catch { return null; }
}
/** A tool_result's text: a JSON result becomes bounded detail JSON; other text a short single-line excerpt. */
function toolResultDetail(content, secret) {
  const text = typeof content === 'string' ? content : Array.isArray(content)
    ? content.slice(0, 64).filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n') : '';
  if (!text || text.length > 4 * 1048576) return null;
  try { return toolDetail(JSON.parse(text), secret); } catch { /* plain text */ }
  const line = text.replace(CONTROL_ALL, ' ').replace(/\s+/g, ' ').trim().slice(0, TOOL_TEXT_CHARS);
  return line && !(secret && line.includes(secret)) ? line : null;
}
/** name/status plus the optional bounded display details. */
const toolCopy = t => ({ name: t.name, status: t.status, ...(typeof t.input === 'string' ? { input: t.input } : {}), ...(typeof t.result === 'string' ? { result: t.result } : {}) });
const isoNow = now => new Date(now()).toISOString();
/** UTF-8 byte bound without splitting a code point. */
function bounded(text, maxBytes) {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let out = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8');
  while (out.endsWith('�')) out = out.slice(0, -1);
  return out;
}
/** A plain array (no proxy, holes, accessors or extra keys) of at most `max` entries; null otherwise. */
function plainArray(value, max) {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max) return null;
  const out = [];
  for (let i = 0; i < value.length; i++) { const field = Object.getOwnPropertyDescriptor(value, String(i)); if (!field || !Object.hasOwn(field, 'value')) return null; out.push(field.value); }
  return Reflect.ownKeys(value).length === value.length + 1 ? out : null;
}
/**
 * Optional PNG references: 1..4 exact {name, dataUrl} records whose data URL is canonical base64 of a PNG (magic bytes
 * checked), at most 512 KiB decoded in total. Returns frozen {name, dataUrl} copies (re-validatable); bytes never touch disk.
 */
function imagesInput(value) {
  const list = plainArray(value, LIMITS.images);
  if (!list || !list.length) fail('images');
  const maxChars = DATA_URL_PREFIX.length + Math.ceil(LIMITS.imageBytes / 3) * 4;
  let total = 0;
  return Object.freeze(list.map(item => {
    let v; try { v = plain(item, ['name', 'dataUrl']); } catch { fail('images'); }
    if (typeof v.name !== 'string' || !v.name || v.name.length > LIMITS.imageName || v.name.trim() !== v.name || !IMAGE_NAME.test(v.name) ||
        CONTROL.test(v.name) || /[\\/<>:"|?*]/.test(v.name) || !v.name.isWellFormed()) fail('images');
    if (typeof v.dataUrl !== 'string' || v.dataUrl.length > maxChars || !v.dataUrl.startsWith(DATA_URL_PREFIX)) fail('images');
    const data = v.dataUrl.slice(DATA_URL_PREFIX.length);
    if (!data || !BASE64.test(data)) fail('images');
    const bytes = Buffer.from(data, 'base64');
    total += bytes.length;
    if (bytes.length < 33 || total > LIMITS.imageBytes || !bytes.subarray(0, 8).equals(PNG_MAGIC) || bytes.toString('base64') !== data) fail('images');
    return Object.freeze({ name: v.name, dataUrl: v.dataUrl });
  }));
}
/** Lightweight transcript marker for each reference; the bytes are never persisted. */
const imageMarkers = images => images.map(image => '[image: ' + image.name + ']').join(' ');
/** Exact `send` envelope (shared by the IPC boundary and the host); `images` is optional. */
function sendInput(value) {
  const keys = ['conversationId', 'text', 'model', 'effort'];
  const hasImages = !!value && typeof value === 'object' && !types.isProxy(value) && Object.hasOwn(value, 'images');
  const hasPlaytest = !!value && typeof value === 'object' && !types.isProxy(value) && Object.hasOwn(value, 'playtest');
  const v = plain(value, [...keys, ...(hasImages ? ['images'] : []), ...(hasPlaytest ? ['playtest'] : [])]);
  if (hasPlaytest && typeof v.playtest !== 'boolean') fail('unavailable');
  if (!(v.conversationId === null || isId(v.conversationId)) || typeof v.model !== 'string' || !CHOICE.test(v.model) ||
      typeof v.effort !== 'string' || !CHOICE.test(v.effort)) fail('unavailable');
  if (typeof v.text !== 'string' || !v.text.trim() || v.text.length > LIMITS.textChars || !v.text.isWellFormed()) fail('text');
  const out = { conversationId: v.conversationId, text: v.text, model: v.model, effort: v.effort };
  if (hasImages) out.images = imagesInput(v.images);
  if (hasPlaytest) out.playtest = v.playtest;
  return Object.freeze(out);
}
/** One stream-json user message (the shape Claude Code reads with --input-format stream-json): references in order, then the text. */
function streamJsonMessage(images, text) {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: [
    ...images.map(image => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.dataUrl.slice(DATA_URL_PREFIX.length) } })), { type: 'text', text }] } }) + '\n';
}
/** Exact `rewind` envelope: the conversation and the user message the edit replaces (it and everything after are removed). */
function rewindInput(value) {
  const v = plain(value, ['conversationId', 'messageId']);
  if (!isId(v.conversationId) || !isId(v.messageId)) fail('unavailable');
  return Object.freeze({ conversationId: v.conversationId, messageId: v.messageId });
}
/** CLI aliases/efforts from the fixed `--help` paragraphs (provider-setup's parseClaudeChoices logic). */
function parseChoices(stdout) {
  const help = stdout.replace(/\r\n/g, '\n');
  const modelParagraph = /--model\s+<model>([\s\S]*?)(?:\n\s{2}--|\n\s{2}-[a-z])/m.exec(help)?.[1] ?? '';
  const quoted = [...new Set([...modelParagraph.matchAll(/'([a-z][a-z0-9.-]+)'/g)].map(m => m[1]))];
  const aliases = quoted.filter(v => !v.startsWith('claude-') && CHOICE.test(v) && !v.includes('.'));
  const ids = quoted.filter(v => MODEL_ID.test(v)).slice(0, 32);
  const effortParagraph = /--effort\s+<level>([\s\S]*?)(?:\n\s{2}--|\n\s{2}-[a-z])/m.exec(help)?.[1] ?? '';
  const efforts = EFFORT_ORDER.filter(e => new RegExp('\\b' + e + '\\b').test(effortParagraph));
  if (!aliases.length || aliases.length > 32 || aliases.some(alias => !CHOICE.test(alias)) || !efforts.length) return null;
  return { aliases, efforts, ids };
}
/** A CLI result error is forwarded only when it is a short plain sentence: no URL, address, path, or token-like run. */
function safeResultText(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > 300 || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/u.test(text) || /https?:|www\.|@|[A-Za-z]:[\\/]|[\\/](?:Users|home)[\\/]/i.test(text) ||
      /[A-Za-z0-9_+/=-]{32,}/.test(text)) return null;
  return text.replace(/\s+/g, ' ');
}
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
/** Unix seconds inside a sane window; anything else is an unreported reset time. */
const resetSeconds = value => {
  const n = typeof value === 'string' && /^\d{10}$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(n) && n >= 1e9 && n < 1e11 ? n : null;
};
// Usage/rate-limit outcomes are recognised from the CLI's own result; their raw text is never forwarded.
const LIMIT_TEXT = /\b(?:usage|rate) limit\b|\bhit your (?:usage )?limit\b|\blimit reached\b|\bout of (?:extra )?usage\b/i;
/** Fixed usage-limit classification of a stream-json error result; null when it is not a usage/rate limit. */
function usageLimitResult(event) {
  if (!event || event.type !== 'result' || event.is_error !== true && event.subtype === 'success') return null;
  const text = typeof event.result === 'string' ? event.result.slice(0, 2000) : '';
  if (event.api_error_status !== 429 && !LIMIT_TEXT.test(text)) return null;
  return { resetsAt: resetSeconds(/\|(\d{10})\b/.exec(text)?.[1]) };
}

/** Per-project transcript store: owned directory, atomic writes, fixed bounds, one serial write queue. */
function createStore({ fs, p, directory, now, limits }) {
  const indexPath = p.join(directory, 'index.json'), conversationsDirectory = p.join(directory, 'conversations');
  let entries = null, queue = Promise.resolve();
  const transcripts = new Map();
  const serial = fn => { const run = queue.then(fn); queue = run.catch(() => {}); return run; };
  const transcriptPath = id => { if (!isId(id)) fail('unavailable'); return p.join(conversationsDirectory, id + '.json'); };
  async function readJson(path, maxBytes) {
    let stat; try { stat = await fs.lstat(path); } catch (error) { if (error?.code === 'ENOENT') return undefined; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) return null;
    try { return JSON.parse(await fs.readFile(path, 'utf8')); } catch { return null; }
  }
  async function atomicWrite(path, value) {
    const data = JSON.stringify(value) + '\n', temporary = path + '.' + nativeUUID() + '.tmp';
    try { await fs.writeFile(temporary, data, { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, path); }
    catch (error) { try { await fs.unlink(temporary); } catch { /* absent */ } throw error; }
  }
  function validEntry(e) {
    try {
      const keys = ['conversationId', 'title', 'createdAt', 'updatedAt', 'model', 'effort', 'sessionId'];
      const v = plain(e, e && typeof e === 'object' && Object.hasOwn(e, 'rewound') ? [...keys, 'rewound'] : keys);
      if ('rewound' in v && typeof v.rewound !== 'boolean') return null;
      if (!isId(v.conversationId) || typeof v.title !== 'string' || v.title.length > 200 || CONTROL.test(v.title) || !ISO.test(v.createdAt) || !ISO.test(v.updatedAt) ||
          typeof v.model !== 'string' || !CHOICE.test(v.model) || typeof v.effort !== 'string' || !CHOICE.test(v.effort) || !(v.sessionId === null || isId(v.sessionId))) return null;
      return { ...v };
    } catch { return null; }
  }
  function validMessage(m) {
    try {
      const keys = m && typeof m === 'object' && Object.hasOwn(m, 'tool') ? ['id', 'role', 'text', 'at', 'tool'] : ['id', 'role', 'text', 'at'];
      const v = plain(m, keys);
      if (!isId(v.id) || !ROLES.includes(v.role) || typeof v.text !== 'string' || Buffer.byteLength(v.text) > limits.messageBytes || !ISO.test(v.at)) return null;
      const out = { id: v.id, role: v.role, text: v.text, at: v.at };
      if (keys.length === 5) {
        const raw = v.tool && typeof v.tool === 'object' ? v.tool : null;
        const t = plain(v.tool, ['name', 'status', ...['input', 'result'].filter(key => raw && Object.hasOwn(raw, key))]);
        if (v.role !== 'tool' || typeof t.name !== 'string' || !t.name || t.name.length > limits.toolName || CONTROL.test(t.name) || !TOOL_STATES.includes(t.status)) return null;
        for (const key of ['input', 'result']) if (key in t && (typeof t[key] !== 'string' || t[key].length > TOOL_DETAIL_CHARS)) return null;
        out.tool = toolCopy(t);
      }
      return out;
    } catch { return null; }
  }
  async function load() {
    if (entries) return entries;
    await fs.mkdir(conversationsDirectory, { recursive: true, mode: 0o700 });
    const saved = await readJson(indexPath, limits.indexBytes);
    const list = saved && saved.version === 1 && Array.isArray(saved.conversations) ? saved.conversations.slice(0, limits.conversations).map(validEntry).filter(Boolean) : [];
    if (saved === null) { try { await fs.rename(indexPath, indexPath + '.unreadable-' + now()); } catch { /* retained */ } }
    const seen = new Set(); entries = list.filter(e => !seen.has(e.conversationId) && seen.add(e.conversationId));
    return entries;
  }
  const persistIndex = () => atomicWrite(indexPath, { version: 1, conversations: entries });
  async function messagesOf(id) {
    if (transcripts.has(id)) return transcripts.get(id);
    const saved = await readJson(transcriptPath(id), limits.transcriptBytes + limits.messageBytes * 2);
    const messages = saved && saved.version === 1 && saved.conversationId === id && Array.isArray(saved.messages) ?
      saved.messages.slice(-limits.messages).map(validMessage).filter(Boolean) : [];
    transcripts.set(id, messages);
    if (transcripts.size > 8) for (const key of transcripts.keys()) { if (transcripts.size <= 8) break; if (key !== id) transcripts.delete(key); }
    return messages;
  }
  async function persistMessages(id, messages) {
    while (messages.length > limits.messages) messages.shift();
    let bytes = messages.reduce((total, m) => total + Buffer.byteLength(JSON.stringify(m)) + 1, 0);
    while (bytes > limits.transcriptBytes && messages.length > 1) bytes -= Buffer.byteLength(JSON.stringify(messages.shift())) + 1;
    await atomicWrite(transcriptPath(id), { version: 1, conversationId: id, messages });
  }
  return Object.freeze({
    list: () => serial(async () => (await load()).map(e => ({ ...e }))),
    get: id => serial(async () => { const e = (await load()).find(item => item.conversationId === id); return e ? { ...e } : null; }),
    create: (entry, protectedIds) => serial(async () => {
      const list = await load();
      while (list.length >= limits.conversations) {
        const victims = list.filter(e => !protectedIds.has(e.conversationId)).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
        if (!victims.length) fail('full');
        list.splice(list.indexOf(victims[0]), 1); transcripts.delete(victims[0].conversationId);
        try { await fs.unlink(transcriptPath(victims[0].conversationId)); } catch { /* absent */ }
      }
      list.push({ ...entry }); transcripts.set(entry.conversationId, []);
      await persistIndex();
    }),
    update: (id, patch) => serial(async () => {
      const e = (await load()).find(item => item.conversationId === id); if (!e) return false;
      Object.assign(e, patch); await persistIndex(); return true;
    }),
    remove: id => serial(async () => {
      const list = await load(), at = list.findIndex(item => item.conversationId === id); if (at < 0) return false;
      list.splice(at, 1); transcripts.delete(id); await persistIndex();
      try { await fs.unlink(transcriptPath(id)); } catch { /* absent */ }
      return true;
    }),
    messages: id => serial(async () => { if (!(await load()).some(e => e.conversationId === id)) return null; return (await messagesOf(id)).map(m => ({ ...m, ...(m.tool ? { tool: toolCopy(m.tool) } : {}) })); }),
    /**
     * Edit rewind: removes the user message `messageId` and everything after it, persists the shorter transcript and
     * marks the conversation for a fresh, seeded session. Returns the kept messages, or null when that is not a user message.
     */
    truncate: (id, messageId) => serial(async () => {
      const e = (await load()).find(item => item.conversationId === id); if (!e) return null;
      const messages = await messagesOf(id), at = messages.findIndex(m => m.id === messageId);
      if (at < 0 || messages[at].role !== 'user') return null;
      messages.splice(at);
      await persistMessages(id, messages);
      Object.assign(e, { sessionId: null, rewound: true, updatedAt: isoNow(now) }); await persistIndex();
      return messages.map(m => ({ ...m, ...(m.tool ? { tool: toolCopy(m.tool) } : {}) }));
    }),
    /** Append, or replace by id; skipped when the conversation was removed meanwhile. */
    put: (id, message) => serial(async () => {
      if (!(await load()).some(e => e.conversationId === id)) return false;
      const messages = await messagesOf(id), at = messages.findIndex(m => m.id === message.id);
      if (at >= 0) messages[at] = message; else messages.push(message);
      await persistMessages(id, messages); return true;
    }),
  });
}

function createClaudeChat(options) {
  if (!options || typeof options !== 'object' || typeof options.getWindow !== 'function' || typeof options.projectPath !== 'string' ||
      typeof options.stateDirectory !== 'string' || !options.handoff || typeof options.handoff.prepare !== 'function' || typeof options.handoff.release !== 'function') fail('unavailable');
  // Trusted main-process seams for tests only; never IPC payloads.
  const fs = options.fs ?? nativeFs, spawn = options.spawn ?? nativeSpawn, platform = options.platform ?? process.platform;
  const p = platform === 'win32' ? nativePath.win32 : nativePath.posix;
  const env = { ...(options.env ?? process.env) }, home = options.homedir ?? (() => os.homedir()), now = options.now ?? (() => Date.now());
  const randomUUID = options.randomUUID ?? nativeUUID, handoff = options.handoff;
  const limits = Object.freeze({ ...LIMITS, ...(options.limits ?? {}) });
  const projectPath = options.projectPath;
  const store = createStore({ fs, p, directory: options.stateDirectory, now, limits });
  const turns = new Map(), byConversation = new Map();
  // Alias -> concrete model id reported by system/init events of this host's turns (in memory; display only).
  const observedModels = new Map();
  let disposed = false, statusCache = null, approval = null, approved = false, credential = null, minting = null, instructions = null;
  const credentials = new Set();

  function emit(event) {
    try {
      const window = options.getWindow();
      if (!window || window.isDestroyed?.() || !window.webContents || window.webContents.isDestroyed?.()) return;
      window.webContents.send(EVENT_CHANNEL, event);
    } catch { /* A closed renderer misses the event; the transcript keeps it. */ }
  }
  function nativeEnvironment() {
    const output = {};
    const names = ['SystemRoot', 'WINDIR', 'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP', 'TMPDIR',
      'LANG', 'LC_ALL', 'TERM', 'DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'CLAUDE_CONFIG_DIR'];
    for (const name of names) {
      const key = Object.keys(env).find(key => key.toLowerCase() === name.toLowerCase());
      const value = key === undefined ? undefined : env[key];
      if (typeof value === 'string' && !CONTROL.test(value) && Buffer.byteLength(value) <= 4096) output[name] = value;
    }
    output.PATH = pathDirectories().join(p.delimiter);
    return output;
  }
  function absolute(value) {
    if (typeof value !== 'string' || !value || value !== value.trim() || CONTROL.test(value) || Buffer.byteLength(value) > 2048 || !p.isAbsolute(value)) return null;
    if (platform === 'win32' && (!/^[a-z]:[\\/]/i.test(value) || /[<>"|?*]/.test(value) || value.slice(2).includes(':'))) return null;
    return p.normalize(value);
  }
  function pathDirectories() {
    const raw = env.PATH ?? env.Path ?? '';
    if (typeof raw !== 'string' || raw.length > 32768) return [];
    const entries = raw.split(p.delimiter); if (entries.length > 64) return [];
    const out = [];
    for (let entry of entries) {
      if (entry.startsWith('"') && entry.endsWith('"')) entry = entry.slice(1, -1);
      const full = absolute(entry); if (full && !out.some(item => item.toLowerCase() === full.toLowerCase())) out.push(full);
    }
    return out;
  }
  const inside = (directory, value) => { const r = p.relative(directory, value); return !r || (!p.isAbsolute(r) && r !== '..' && !r.startsWith('..' + p.sep)); };
  /** The native claude executable: PATH, then the official user installer location; never a wrapper or a project file. */
  async function locate() {
    if (options.locate) return options.locate();
    const filename = 'claude' + (platform === 'win32' ? '.exe' : '');
    const candidate = async value => {
      try {
        const full = absolute(await fs.realpath(value)), stat = full && await fs.stat(full);
        if (!full || !stat.isFile() || inside(projectPath, full) || (platform === 'win32' && p.basename(full).toLowerCase() !== filename)) return null;
        if (platform !== 'win32' && !(stat.mode & 0o111)) return null;
        return full;
      } catch { return null; }
    };
    for (const directory of pathDirectories()) { const full = await candidate(p.join(directory, filename)); if (full) return full; }
    const userHome = absolute(home());
    return userHome ? candidate(p.join(userHome, '.local', 'bin', filename)) : null;
  }
  /** Bounded one-shot helper; output stays in this closure. */
  function run(command, args) {
    return new Promise(resolve => {
      let child, done = false, bytes = 0; const chunks = [];
      const finish = (ok, code = null) => {
        if (done) return; done = true; clearTimeout(timer);
        if (!ok) { try { child?.kill(); } catch { /* closed */ } }
        resolve({ ok, code, stdout: ok ? Buffer.concat(chunks).toString('utf8') : '' });
      };
      const timer = setTimeout(() => finish(false), limits.helperTimeoutMs);
      try {
        child = spawn(command, args, { cwd: absolute(home()) ?? projectPath, env: nativeEnvironment(), shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        child.once('error', () => finish(false));
        child.once('close', code => finish(Number.isInteger(code), code));
        child.stdout.on('data', data => { const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data); bytes += chunk.length; if (bytes > limits.helperBytes) return finish(false); chunks.push(chunk); });
        child.stderr.on('data', data => { bytes += data.length; if (bytes > limits.helperBytes) finish(false); });
        child.stdout.once('error', () => finish(false)); child.stderr.once('error', () => finish(false));
      } catch { finish(false); }
    });
  }
  const snapshot = (values, command = null) => {
    const value = Object.freeze({ installed: false, signedIn: false, cliVersion: null, models: Object.freeze([]), efforts: Object.freeze([]), defaultModel: null, resolved: Object.freeze({}), message: null, ...values });
    statusCache = { at: now(), value, command }; return value;
  };
  async function readStatus() {
    if (disposed) return snapshot({ message: MESSAGES.unavailable });
    const command = await locate();
    if (!command) return snapshot({ message: MESSAGES.notInstalled });
    const version = await run(command, ['--version']);
    const match = version.ok && version.code === 0 ? /^([0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5}(?:-[A-Za-z0-9.-]{1,32})?) \(Claude Code\)\s*$/.exec(version.stdout) : null;
    if (!match) return snapshot({ installed: true, message: MESSAGES.version });
    const cliVersion = match[1];
    const auth = await run(command, ['auth', 'status', '--json']);
    let signedIn = false, message = MESSAGES.authUnknown;
    try {
      const value = JSON.parse(auth.stdout);
      if (auth.ok && value && typeof value === 'object' && !Array.isArray(value)) {
        if (value.loggedIn === false) message = MESSAGES.signedOut;
        else if (value.loggedIn === true && value.authMethod === 'claude.ai') { signedIn = true; message = null; }
        else if (value.loggedIn === true) message = MESSAGES.notSubscription;
      }
    } catch { /* unknown */ }
    const help = await run(command, ['--help']);
    const choices = help.ok && help.code === 0 ? parseChoices(help.stdout) : null;
    if (!choices) return snapshot({ installed: true, signedIn, cliVersion, message: message ?? MESSAGES.choices }, command);
    return snapshot({ installed: true, signedIn, cliVersion, models: Object.freeze([...choices.aliases]), efforts: Object.freeze([...choices.efforts]),
      defaultModel: choices.aliases.includes('sonnet') ? 'sonnet' : choices.aliases[0], resolved: resolveAliases(choices.aliases, choices.ids, observedModels), message }, command);
  }
  let statusRun = null;
  function status() { statusRun ??= readStatus().catch(() => snapshot({ message: MESSAGES.unavailable })).finally(() => { statusRun = null; }); return statusRun; }
  async function freshStatus() {
    if (statusCache && statusCache.command && now() - statusCache.at >= 0 && now() - statusCache.at < limits.statusMaxAgeMs) return statusCache;
    await status(); return statusCache;
  }
  /** The persisted per-project switch (Settings > Permissions); absent or failing ports mean "ask". */
  async function autoApproved() {
    try { return typeof options.permissions?.claudeTools === 'function' && (await options.permissions.claudeTools()) === true; } catch { return false; }
  }
  /**
   * Consent to use Arcane project tools. With the project's "Let Claude use Arcane tools" switch on (the default) no
   * question is shown. Otherwise one in-app question per project session (this host instance); concurrent first turns
   * share it, a decline asks again next time, and "Always allow" saves the switch for this project.
   */
  function ensureApproval(cliVersion) {
    if (approved) return Promise.resolve(true);
    approval ??= (async () => {
      if (await autoApproved()) { if (disposed) return false; approved = true; return true; }
      const window = options.getWindow();
      if (!window || window.isDestroyed?.()) return false;
      const dialog = options.dialog ?? require('electron').dialog;
      const remember = typeof options.permissions?.allowClaudeTools === 'function';
      const result = await dialog.showMessageBox(window, {
        type: 'question', title: 'Arcane Claude chat', message: 'Use Claude chat with Arcane project tools?',
        detail: 'Claude chat runs the installed Claude Code ' + cliVersion + ' in the background for this project, using your Claude sign-in and subscription usage. ' +
          'Arcane gives it only its own project tools and a scoped project credential (work coordination and Studio commands you already allowed). ' +
          'The credential renews automatically while you work and is revoked when the project closes. Built-in shell, file and web tools are turned off. ' +
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
  /** Settings switched to "ask": forget this session's consent and retire the shared credential (running replies finish). */
  function revokeApproval() {
    approved = false;
    const c = credential; credential = null;
    if (c) { c.retired = true; if (!c.users && credentials.has(c)) void retire(c); }
  }
  const remainingMs = c => Date.parse(c.expiresAt) - now();
  /** A shared credential must still cover a full reply (turn timeout minus a short reuse window). */
  const reuseFloor = () => Math.max(limits.credentialMarginMs, limits.turnTimeoutMs - limits.credentialReuseMs);
  /**
   * Reuse the scoped credential only while it can cover a whole reply, so a long reply never outlives its tools. Otherwise
   * mint a fresh one transparently (shared by concurrent turns) and revoke the old one once idle. The daemon never extends
   * a credential, so renewal is always a new, equally scoped mint through the same handoff path.
   */
  async function acquireCredential(model, effort) {
    const usable = c => c && !c.retired && remainingMs(c) >= reuseFloor();
    if (usable(credential)) { credential.users++; return credential; }
    minting ??= (async () => {
      const previous = credential; credential = null;
      if (previous) { previous.retired = true; if (!previous.users) void retire(previous); }
      let receipt; try { receipt = await handoff.prepare(Object.freeze({ model, effort })); } catch { receipt = null; }
      const overlay = receipt?.env;
      if (!receipt || typeof receipt.configPath !== 'string' || !isId(receipt.handoffId) || typeof receipt.expiresAt !== 'string' || !Number.isFinite(Date.parse(receipt.expiresAt)) ||
          !overlay || typeof overlay.ARCANE_DAEMON_URL !== 'string' || typeof overlay.ARCANE_LOCAL_TOKEN !== 'string') return null;
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
    // An idle credential that can no longer cover a full reply is revoked now; the next turn mints a fresh one.
    if (!c.retired && !c.users && credential === c && remainingMs(c) < reuseFloor()) { c.retired = true; credential = null; }
    if (c.retired && !c.users && credentials.has(c)) void retire(c);
  }
  async function loadInstructions() {
    if (instructions !== null) return instructions;
    let text = FALLBACK_INSTRUCTIONS;
    try { const value = await options.instructions?.(); if (typeof value === 'string' && value.trim()) text = value; } catch { /* fallback */ }
    instructions = appendedSystemPrompt(text, limits.instructionsChars);
    return instructions;
  }
  /** ARCANE.md in this project folder, bounded; links, non-files and read errors count as no memory. Read per turn. */
  async function loadProjectMemory() {
    let handle = null;
    try {
      const file = p.join(projectPath, PROJECT_MEMORY_FILE), info = await fs.lstat(file);
      if (!info.isFile() || info.nlink > 1) return '';
      handle = await fs.open(file, 'r');
      const buffer = Buffer.alloc(PROJECT_MEMORY_MAX_BYTES), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const text = buffer.subarray(0, bytesRead).toString('utf8');
      // A file cut at the bound may end mid-character; drop that partial character only.
      let end = text.length; if (bytesRead === buffer.length) while (end > 0 && text.charCodeAt(end - 1) === 0xfffd) end--;
      return text.slice(0, end);
    } catch { return ''; } finally { try { await handle?.close(); } catch { /* read-only */ } }
  }
  function killTree(child) {
    if (!child || child.exitCode !== null && child.exitCode !== undefined || child.signalCode) return;
    if (platform === 'win32' && Number.isSafeInteger(child.pid) && child.pid > 0) {
      const root = absolute(env.SystemRoot ?? env.SYSTEMROOT ?? env.WINDIR ?? '');
      if (root) {
        try {
          const killer = spawn(p.join(root, 'System32', 'taskkill.exe'), ['/T', '/F', '/PID', String(child.pid)], { shell: false, windowsHide: true, stdio: 'ignore' });
          killer.once?.('error', () => {});
        } catch { /* child.kill below */ }
      }
    }
    try { child.kill(); } catch { /* closed */ }
  }
  const message = (role, text, tool) => ({ id: randomUUID(), role, text: bounded(text, limits.messageBytes), at: isoNow(now), ...(tool ? { tool: { ...tool } } : {}) });
  const publicMessage = m => ({ id: m.id, role: m.role, text: m.text, at: m.at, ...(m.tool ? { tool: toolCopy(m.tool) } : {}) });
  const toolName = name => { const short = name.startsWith('mcp__' + MCP_SERVER + '__') ? name.slice(MCP_SERVER.length + 7) : name; return (short.replace(/[^A-Za-z0-9._:-]/g, '_') || 'tool').slice(0, limits.toolName); };

  async function send(input) {
    if (disposed) fail('unavailable');
    const v = sendInput(input);
    if (turns.size >= limits.turns) fail('full');
    let entry = null;
    if (v.conversationId !== null) { entry = await store.get(v.conversationId); if (!entry) fail('missing'); }
    const conversationId = entry ? entry.conversationId : randomUUID();
    if (disposed) fail('unavailable');
    if (byConversation.has(conversationId)) fail('busy');
    if (turns.size >= limits.turns) fail('full');
    const turn = { turnId: randomUUID(), conversationId, model: v.model, effort: v.effort, child: null, stopped: false, finished: false, timer: null,
      sessionId: entry?.sessionId ?? null, credential: null, result: null, tools: new Map(), overflow: false, limit: null, seed: '', images: v.images ?? [], playtest: v.playtest };
    turns.set(turn.turnId, turn); byConversation.set(conversationId, turn);
    let user = null;
    try {
      const at = isoNow(now);
      if (!entry) {
        const title = v.text.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, limits.titleChars) || 'New chat';
        await store.create({ conversationId, title, createdAt: at, updatedAt: at, model: v.model, effort: v.effort, sessionId: null }, new Set(byConversation.keys()));
      } else await store.update(conversationId, { updatedAt: at, model: v.model, effort: v.effort });
      // After an edit rewind there is no session to resume: the first turn carries the kept transcript as context.
      if (entry?.rewound === true && !entry.sessionId) turn.seed = rewindSeed(await store.messages(conversationId) ?? []);
      // The transcript keeps only a '[image: name]' marker per reference, never the image bytes.
      user = message('user', v.images ? v.text + '\n\n' + imageMarkers(v.images) : v.text);
      if (!await store.put(conversationId, user)) fail('missing');
    } catch (error) {
      turns.delete(turn.turnId); byConversation.delete(conversationId);
      throw error instanceof ClaudeChatError ? error : new ClaudeChatError('unavailable');
    }
    void runTurn(turn, turn.seed + v.text);
    return Object.freeze({ turnId: turn.turnId, conversationId, messageId: user.id });
  }
  /**
   * Edit a past user message: drop it and everything after it from the saved transcript. The Claude Code CLI offers
   * `--fork-session` but no documented way to resume at an earlier message, so the next `send` starts a fresh session
   * seeded with the kept transcript (rewindSeed) instead of resuming the discarded one.
   */
  async function rewind(input) {
    if (disposed) fail('unavailable');
    const v = rewindInput(input);
    if (!await store.get(v.conversationId)) fail('missing');
    if (byConversation.has(v.conversationId)) fail('busy');
    const kept = await store.truncate(v.conversationId, v.messageId);
    if (!kept) fail('rewind');
    return Object.freeze({ conversationId: v.conversationId, kept: kept.length });
  }

  async function finish(turn, ok, error, usage = null, limit = null) {
    if (turn.finished) return; turn.finished = true;
    clearTimeout(turn.timer); releaseCredential(turn.credential); turn.credential = null;
    if (!ok) statusCache = null; // the next turn re-reads native sign-in status
    try {
      if (error) await store.put(turn.conversationId, message('error', error));
      await store.update(turn.conversationId, { updatedAt: isoNow(now), ...(turn.sessionId ? { sessionId: turn.sessionId, rewound: false } : {}) });
    } catch { /* the done event still reports the outcome */ }
    turns.delete(turn.turnId); if (byConversation.get(turn.conversationId) === turn) byConversation.delete(turn.conversationId);
    emit({ turnId: turn.turnId, conversationId: turn.conversationId, type: 'done', ok, error: ok ? null : error ?? MESSAGES.failed, usage,
      usageLimit: ok || !limit ? null : { resetsAt: limit.resetsAt } });
  }

  async function runTurn(turn, text) {
    try {
      const s = (await freshStatus()).value, command = statusCache?.command;
      if (turn.stopped) return finish(turn, false, MESSAGES.stopped);
      if (!s.installed || !command) return finish(turn, false, s.message ?? MESSAGES.notInstalled);
      if (!s.signedIn) return finish(turn, false, s.message ?? MESSAGES.signedOut);
      if (!s.models.includes(turn.model) || !s.efforts.includes(turn.effort)) return finish(turn, false, MESSAGES.selection);
      if (!await ensureApproval(s.cliVersion)) return finish(turn, false, disposed ? MESSAGES.closed : MESSAGES.declined);
      if (turn.stopped || disposed) return finish(turn, false, disposed ? MESSAGES.closed : MESSAGES.stopped);
      turn.credential = await acquireCredential(turn.model, turn.effort);
      if (turn.stopped || disposed) return finish(turn, false, disposed ? MESSAGES.closed : MESSAGES.stopped);
      if (!turn.credential) return finish(turn, false, MESSAGES.credential);
      // Stable system prompt (cacheable across turns); the per-turn Playtest note goes on the user message.
      // ARCANE.md rides after the static instructions, so the prompt stays byte-identical until that file changes.
      const prompt = (await loadInstructions()) + projectMemorySection(await loadProjectMemory()), input = text + playtestNote(turn.playtest);
      if (turn.stopped || disposed) return finish(turn, false, disposed ? MESSAGES.closed : MESSAGES.stopped);
      // A turn with PNG references sends one stream-json user message; plain text turns keep the text input format.
      const images = turn.images; turn.images = [];
      const args = ['-p', '--input-format', images.length ? 'stream-json' : 'text', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
        // Only the user's own Claude Code settings load: a project's .claude/settings*.json (hooks, apiKeyHelper, env such as
        // a base URL) must never run or redirect anything just because that folder was opened in Arcane.
        '--mcp-config', turn.credential.configPath, '--strict-mcp-config', '--setting-sources', 'user', '--model', turn.model, '--effort', turn.effort,
        '--permission-mode', 'default', '--tools', '', '--allowedTools', 'mcp__' + MCP_SERVER, '--append-system-prompt', prompt,
        ...(turn.sessionId ? ['--resume', turn.sessionId] : [])];
      if (args.some(value => value.includes(turn.credential.env.ARCANE_LOCAL_TOKEN))) return finish(turn, false, MESSAGES.start);
      let child;
      try {
        child = spawn(command, args, { cwd: projectPath, env: { ...nativeEnvironment(), ...turn.credential.env }, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch { return finish(turn, false, MESSAGES.start); }
      turn.child = child;
      // A reply is also bounded by its credential's remaining lifetime, so its tools never expire mid-reply.
      const budget = Math.max(1000, Math.min(limits.turnTimeoutMs, remainingMs(turn.credential) - limits.credentialSlackMs));
      turn.timer = setTimeout(() => { if (!turn.finished) { turn.timedOut = true; killTree(child); } }, budget);
      let pending = [], pendingBytes = 0, skipping = false, total = 0;
      const line = buffer => {
        if (!buffer.length) return;
        let value; try { value = JSON.parse(buffer.toString('utf8')); } catch { return; }
        if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.type !== 'string') return;
        try { handle(turn, value); } catch { /* unknown shapes are ignored */ }
      };
      child.stdout.on('data', data => {
        if (turn.finished) return;
        let chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
        total += chunk.length;
        if (total > limits.stdoutBytes) { turn.overflow = true; killTree(child); return; }
        for (let at = chunk.indexOf(10); at >= 0; at = chunk.indexOf(10)) {
          const head = chunk.subarray(0, at); chunk = chunk.subarray(at + 1);
          if (!skipping && pendingBytes + head.length <= limits.lineBytes) line(Buffer.concat([...pending, head]));
          pending = []; pendingBytes = 0; skipping = false;
        }
        if (skipping || !chunk.length) return;
        pendingBytes += chunk.length;
        if (pendingBytes > limits.lineBytes) { pending = []; pendingBytes = 0; skipping = true; } else pending.push(chunk);
      });
      // stderr may contain account details or secrets: it is drained and discarded, never stored or forwarded.
      child.stderr.on('data', () => {});
      for (const stream of [child.stdout, child.stderr, child.stdin]) stream?.on?.('error', () => {});
      child.once('error', () => { void finish(turn, false, turn.stopped ? MESSAGES.stopped : MESSAGES.start); });
      child.once('close', code => {
        if (!skipping && pending.length) line(Buffer.concat(pending));
        pending = [];
        const r = turn.result;
        if (turn.stopped) return void finish(turn, false, disposed ? MESSAGES.closed : MESSAGES.stopped, r?.usage ?? null);
        if (turn.timedOut) return void finish(turn, false, MESSAGES.timeout, r?.usage ?? null);
        if (turn.overflow) return void finish(turn, false, MESSAGES.output, r?.usage ?? null);
        if (r && !r.isError) return void finish(turn, true, null, r.usage);
        // A usage/rate limit (an error result or a rejected rate_limit_event) becomes one fixed message.
        const limit = r?.limit ?? turn.limit;
        if (limit) return void finish(turn, false, MESSAGES.usageLimit, r?.usage ?? null, limit);
        if (r) return void finish(turn, false, safeResultText(r.text) ?? MESSAGES.failed, r.usage);
        void finish(turn, false, code === 0 ? MESSAGES.noReply : MESSAGES.exited);
      });
      child.stdin.end(images.length ? streamJsonMessage(images, input) : input, 'utf8');
    } catch { await finish(turn, false, MESSAGES.failed); }
  }

  /** Stream-json events observed from Claude Code 2.1.301; anything else is ignored. */
  function handle(turn, event) {
    const base = { turnId: turn.turnId, conversationId: turn.conversationId };
    const secret = turn.credential?.env?.ARCANE_LOCAL_TOKEN, leaksToken = text => typeof secret === 'string' && secret.length > 0 && text.includes(secret);
    if (isId(event.session_id) && (event.type === 'system' && event.subtype === 'init' || event.type === 'result') && turn.sessionId !== event.session_id) {
      turn.sessionId = event.session_id;
      void store.update(turn.conversationId, { sessionId: turn.sessionId, rewound: false }).catch(() => {});
    }
    // (b) The concrete model the CLI ran for an alias; it names the version shown for that alias from the next status read.
    if (event.type === 'system' && event.subtype === 'init' && typeof event.model === 'string') {
      const id = event.model.replace(/\[[0-9]{1,4}[km]\]$/i, '');
      if (ofAlias(turn.model, id) && (observedModels.has(turn.model) || observedModels.size < 32)) observedModels.set(turn.model, id);
    }
    if (event.type === 'rate_limit_event') {
      const info = event.rate_limit_info;
      if (info && typeof info === 'object' && info.status === 'rejected') turn.limit = { resetsAt: resetSeconds(info.resetsAt) };
      return;
    }
    if (event.parent_tool_use_id !== null && event.parent_tool_use_id !== undefined) return; // subagent traffic
    if (event.type === 'assistant' && event.error === 'rate_limit' && !turn.limit) turn.limit = { resetsAt: null };
    if (event.type === 'stream_event') {
      const e = event.event;
      if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta' && typeof e.delta.text === 'string' && e.delta.text && !leaksToken(e.delta.text))
        emit({ ...base, type: 'delta', text: e.delta.text.slice(0, limits.deltaChars) });
    } else if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
      for (const block of event.message.content.slice(0, 256)) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          if (leaksToken(block.text)) continue; // a reply that echoes the project credential is never shown or stored
          const m = message('assistant', block.text);
          void store.put(turn.conversationId, m).catch(() => {});
          emit({ ...base, type: 'message', message: publicMessage(m) });
        } else if (block?.type === 'tool_use' && typeof block.name === 'string' && typeof block.id === 'string' && block.id.length <= 256 && !turn.tools.has(block.id) && turn.tools.size < 4096) {
          const name = toolName(block.name), input = toolDetail(block.input, turn.credential?.env?.ARCANE_LOCAL_TOKEN);
          const m = message('tool', name, { name, status: 'started', ...(input ? { input } : {}) });
          turn.tools.set(block.id, m);
          void store.put(turn.conversationId, m).catch(() => {});
          emit({ ...base, type: 'tool', message: publicMessage(m) });
        }
      }
    } else if (event.type === 'user' && Array.isArray(event.message?.content)) {
      for (const block of event.message.content.slice(0, 256)) {
        const m = block?.type === 'tool_result' ? turn.tools.get(block.tool_use_id) : undefined;
        if (!m || m.tool.status !== 'started') continue;
        const result = toolResultDetail(block.content, turn.credential?.env?.ARCANE_LOCAL_TOKEN);
        m.tool = { ...toolCopy(m.tool), status: block.is_error === true ? 'failed' : 'finished', ...(result ? { result } : {}) };
        void store.put(turn.conversationId, { ...m, tool: toolCopy(m.tool) }).catch(() => {});
        emit({ ...base, type: 'tool', message: publicMessage(m) });
      }
    } else if (event.type === 'result') {
      const u = event.usage && typeof event.usage === 'object' ? event.usage : null;
      const cost = typeof event.total_cost_usd === 'number' && Number.isFinite(event.total_cost_usd) && event.total_cost_usd >= 0 ? event.total_cost_usd : null;
      const limit = usageLimitResult(event);
      turn.result = { isError: event.is_error === true || event.subtype !== 'success', text: event.result,
        limit: limit ? { resetsAt: limit.resetsAt ?? turn.limit?.resetsAt ?? null } : null,
        usage: u ? { inputTokens: count(u.input_tokens) + count(u.cache_creation_input_tokens) + count(u.cache_read_input_tokens), outputTokens: count(u.output_tokens), costUsd: cost } : null };
    }
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
  function stop(turnId) {
    if (!isId(turnId)) fail('unavailable');
    const turn = turns.get(turnId);
    if (!turn || turn.finished) return Promise.resolve(false);
    turn.stopped = true; killTree(turn.child);
    return Promise.resolve(true);
  }
  async function remove(conversationId) {
    if (disposed) fail('unavailable');
    if (!isId(conversationId)) fail('unavailable');
    const turn = byConversation.get(conversationId);
    if (turn) { turn.stopped = true; killTree(turn.child); }
    return store.remove(conversationId);
  }
  /** App quit / project switch: stop every turn this host spawned and revoke the credentials it minted. */
  async function dispose() {
    if (disposed) return; disposed = true;
    for (const turn of turns.values()) { turn.stopped = true; killTree(turn.child); }
    const owned = [...credentials]; credential = null;
    for (const c of owned) c.retired = true;
    await Promise.all(owned.map(retire));
  }
  const host = { version: 1, status: () => status(), list, history, send, rewind, stop, remove };
  Object.defineProperties(host, { dispose: { value: dispose }, activeTurns: { value: () => turns.size }, revokeApproval: { value: revokeApproval } });
  return Object.freeze(host);
}

/** Human IPC: only the trusted main window's main frame on the daemon origin; every argument shape is exact. */
function installClaudeChatIpc(ipcMain, { getSession, getHost }) {
  const policy = require('./policy.cjs');
  function scope(event) {
    const session = getSession(), window = session?.window, contents = window?.webContents, frame = event?.senderFrame;
    if (!session || !window || window.isDestroyed() || !contents || contents.isDestroyed() || event.sender !== contents || !frame || frame !== contents.mainFrame ||
        !policy.validOrigin(session.origin) || !policy.navigationAllowed(session.origin, frame.url) || new URL(frame.url).href !== frame.url) fail('unavailable');
    return session;
  }
  for (const action of ['status', 'list', 'history', 'send', 'rewind', 'stop', 'remove']) ipcMain.handle('arcane:claude-chat-' + action, async (event, ...args) => {
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
      throw new Error(error instanceof ClaudeChatError && SAFE_ERRORS.includes(error.message) ? error.message : MESSAGES.unavailable);
    }
  });
}

module.exports = { createClaudeChat, installClaudeChatIpc, parseChoices, sendInput, playtestNote, appendedSystemPrompt, projectMemorySection, PROJECT_MEMORY_GUIDANCE, streamJsonMessage, rewindSeed, resolveAliases, CLAUDE_ALIAS_MODELS: ALIAS_MODELS, safeResultText, usageLimitResult, CLAUDE_CHAT_LIMITS: LIMITS, CLAUDE_CHAT_MESSAGES: MESSAGES, CLAUDE_CHAT_EVENT: EVENT_CHANNEL };
