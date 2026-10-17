'use strict';
const { contextBridge, ipcRenderer } = require('electron');
// Two zero-argument intents only; paths and policy remain in the native host.
const invoke = async (channel, args) => {
  try {
    if (args.length) throw new Error('Unexpected arguments.');
    return await ipcRenderer.invoke(channel);
  } catch { throw new Error('Luau verification configuration is unavailable.'); }
};
const codeVerification = Object.freeze({ version: 1,
  status: (...args) => invoke('arcane:luau-status', args),
  configure: (...args) => invoke('arcane:luau-configure', args),
});
const providerInvoke = async (action, args) => {
  if (args.length !== 1 || !['codex','claude'].includes(args[0])) throw new Error('Native provider setup unavailable.');
  try { return await ipcRenderer.invoke('arcane:provider-' + action, args[0]); }
  catch { throw new Error('Native provider setup unavailable.'); }
};
const providerSetup = Object.freeze({version:1,
  status:(...args)=>providerInvoke('status',args),login:(...args)=>providerInvoke('login',args),
  install:(...args)=>providerInvoke('install',args),launch:(...args)=>providerInvoke('launch',args),
});
const handoffError = () => { throw new Error('Native handoff is unavailable.'); };
const handoffFields = (value, required, optional = []) => {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) handoffError();
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || !required.includes(key) && !optional.includes(key)) ||
      required.some(key => !keys.includes(key))) handoffError();
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field?.enumerable || !Object.hasOwn(field, 'value')) handoffError();
  }
  return value;
};
const handoffId = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const handoffTime = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
const handoffChoice = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
const handoffReply = value => {
  const state = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'state') : null;
  if (!state || !Object.hasOwn(state, 'value')) handoffError();
  if (state.value === 'listed') {
    handoffFields(value, ['state', 'projectId', 'handoffs']);
    if (typeof value.projectId !== 'string' || !/^[a-f0-9]{64}$/.test(value.projectId) || !Array.isArray(value.handoffs) ||
        Object.getPrototypeOf(value.handoffs) !== Array.prototype || value.handoffs.length > 256 ||
        Reflect.ownKeys(value.handoffs).length !== value.handoffs.length + 1) handoffError();
    const ids = new Set(), handoffs = [];
    for (let i = 0; i < value.handoffs.length; i++) {
      const field = Object.getOwnPropertyDescriptor(value.handoffs, String(i));
      if (!field?.enumerable || !Object.hasOwn(field, 'value')) handoffError();
      const row = handoffFields(field.value, ['handoffId', 'state', 'createdAt', 'expiresAt', 'sealedAt', 'endedAt', 'owned']);
      if (!handoffId(row.handoffId) || ids.has(row.handoffId) || typeof row.owned !== 'boolean' ||
          !['pending', 'sealed', 'expired', 'revoked', 'project_changed', 'closed'].includes(row.state) ||
          !handoffTime(row.createdAt) || !handoffTime(row.expiresAt) || !(row.sealedAt === null || handoffTime(row.sealedAt)) ||
          !(row.endedAt === null || handoffTime(row.endedAt))) handoffError();
      ids.add(row.handoffId); handoffs.push({ ...row });
    }
    return { state: 'listed', projectId: value.projectId, handoffs };
  }
  handoffFields(value, ['state', 'reason', 'message'], ['handoffId', 'expiresAt', 'revocation', 'cleanup']);
  if (!['opened', 'cancelled', 'refused', 'unknown', 'revoked'].includes(value.state) ||
      !(value.reason === null || typeof value.reason === 'string' && /^[a-z_]{1,64}$/.test(value.reason)) ||
      typeof value.message !== 'string' || value.message.length > 512 || /[\x00-\x1f\x7f]/.test(value.message) ||
      (Object.hasOwn(value, 'handoffId') && !handoffId(value.handoffId)) ||
      (Object.hasOwn(value, 'expiresAt') && !handoffTime(value.expiresAt)) ||
      (Object.hasOwn(value, 'revocation') && !['revoked', 'unknown'].includes(value.revocation)) ||
      (Object.hasOwn(value, 'cleanup') && !['removed', 'retained', 'not_owned'].includes(value.cleanup)) ||
      (value.state === 'opened' && (!handoffId(value.handoffId) || !handoffTime(value.expiresAt))) ||
      (value.state === 'revoked' && !handoffId(value.handoffId))) handoffError();
  return { ...value };
};
const handoffInvoke = async (action, args) => {
  try {
    let input;
    if (action === 'list') { if (args.length) handoffError(); }
    else if (action === 'revoke') { if (args.length !== 1 || !handoffId(args[0])) handoffError(); input = args[0]; }
    else {
      if (args.length !== 1) handoffError();
      const value = handoffFields(args[0], ['model', 'effort']);
      if (!handoffChoice(value.model) || !handoffChoice(value.effort)) handoffError();
      input = { model: value.model, effort: value.effort };
    }
    return handoffReply(await ipcRenderer.invoke('arcane:native-handoff-' + action, ...(action === 'list' ? [] : [input])));
  } catch { handoffError(); }
};
const nativeHandoff = Object.freeze({ version: 1,
  launch: (...args) => handoffInvoke('launch', args), list: (...args) => handoffInvoke('list', args),
  revoke: (...args) => handoffInvoke('revoke', args),
});
const studioKeyError = () => { throw new Error('Arcane Studio key storage is unavailable.'); };
const studioKeyFields = (value, names) => {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== names.length ||
      names.some(name => { const d = Object.getOwnPropertyDescriptor(value, name); return !d || !d.enumerable || !Object.hasOwn(d, 'value'); })) studioKeyError();
  return value;
};
const studioKeyId = value => typeof value === 'string' && value.length === 36 &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const studioApiKey = value => {
  if (typeof value !== 'string' || value.length > 92) return false;
  const m = /^arcane_local_v1_([1-9][0-9]{0,4})_([a-f0-9]{64})$/.exec(value);
  return !!m && m[0] === value && Number(m[1]) <= 65535;
};
const studioKeyInvoke = async (action, args) => {
  try {
    let input;
    if (action === 'list') { if (args.length) studioKeyError(); }
    else {
      if (args.length !== 1) studioKeyError();
      const remembers = action === 'remember' || action === 'replace';
      const value = studioKeyFields(args[0], remembers ? ['keyId', 'apiKey'] : ['keyId']);
      if (!studioKeyId(value.keyId) || (remembers && !studioApiKey(value.apiKey))) studioKeyError();
      input = remembers ? { keyId: value.keyId, apiKey: value.apiKey } : { keyId: value.keyId };
    }
    const value = await ipcRenderer.invoke('arcane:studio-keys-' + action, ...(input ? [input] : []));
    if (action === 'list') {
      studioKeyFields(value, ['available', 'items']);
      if (typeof value.available !== 'boolean' || !Array.isArray(value.items) || value.items.length > 32 ||
          (!value.available && value.items.length)) studioKeyError();
      const ids = new Set();
      for (const item of value.items) {
        studioKeyFields(item, ['keyId']);
        if (!studioKeyId(item.keyId) || ids.has(item.keyId)) studioKeyError(); ids.add(item.keyId);
      }
    } else if (action === 'reveal') {
      studioKeyFields(value, ['apiKey']); if (!studioApiKey(value.apiKey)) studioKeyError();
    } else {
      const field = ['remember', 'replace'].includes(action) ? 'remembered' : action === 'copy' ? 'copied' : 'forgotten';
      studioKeyFields(value, [field]); if (value[field] !== true) studioKeyError();
    }
    return value;
  } catch { studioKeyError(); }
};
const studioKeys = Object.freeze({ version: 1,
  list: (...args) => studioKeyInvoke('list', args), remember: (...args) => studioKeyInvoke('remember', args),
  reveal: (...args) => studioKeyInvoke('reveal', args), forget: (...args) => studioKeyInvoke('forget', args),
  copy: (...args) => studioKeyInvoke('copy', args),
  replace: (...args) => studioKeyInvoke('replace', args),
});
const workspacePreferenceError = () => { throw new Error('Arcane workspace preferences are unavailable.'); };
const workspacePreferenceFields = (value, names) => {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== names.length ||
      names.some(name => { const d = Object.getOwnPropertyDescriptor(value, name); return !d || !d.enumerable || !Object.hasOwn(d, 'value'); })) workspacePreferenceError();
  return value;
};
const workspacePreferenceText = (value, max, identifier = false) => {
  if (typeof value !== 'string' || value.length > max || !value.isWellFormed() || new TextEncoder().encode(value).byteLength > max ||
      (identifier && (!/^[A-Za-z0-9]/.test(value) || /[^A-Za-z0-9._:-]/.test(value)))) workspacePreferenceError();
  return value;
};
const workspacePreferenceId = (value, max) => value === null ? null : workspacePreferenceText(value, max, true);
const WORKSPACE_PREFERENCE_ROW = Object.freeze(['localId', 'title', 'provider', 'threadId', 'sessionId', 'draft', 'modelId', 'effort', 'tool', 'previewOpen']);
const workspacePreferenceSnapshot = value => {
  workspacePreferenceFields(value, ['version', 'projectPath', 'provider', 'tabs', 'activeTabId']);
  const projectPath = workspacePreferenceText(value.projectPath, 4096);
  if (value.version !== 1 || !['codex', 'claude'].includes(value.provider) || !Array.isArray(value.tabs) ||
      Object.getPrototypeOf(value.tabs) !== Array.prototype || value.tabs.length > 16 ||
      Reflect.ownKeys(value.tabs).length !== value.tabs.length + 1) workspacePreferenceError();
  const tabs = [], ids = new Set();
  for (let i = 0; i < value.tabs.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value.tabs, String(i));
    if (!d || !d.enumerable || !Object.hasOwn(d, 'value')) workspacePreferenceError();
    // Optional boolean workflowDraft: legacy rows omit it (a plain draft). Presence is preserved exactly, never invented.
    const flagged = !!d.value && Object.getPrototypeOf(d.value) === Object.prototype && Object.hasOwn(d.value, 'workflowDraft');
    const row = workspacePreferenceFields(d.value, flagged ? [...WORKSPACE_PREFERENCE_ROW, 'workflowDraft'] : WORKSPACE_PREFERENCE_ROW);
    if (flagged && typeof row.workflowDraft !== 'boolean') workspacePreferenceError();
    const localId = workspacePreferenceText(row.localId, 128, true), title = workspacePreferenceText(row.title, 512);
    if (ids.has(localId) || /[\x00-\x1f\x7f]/.test(title) || !['codex', 'claude'].includes(row.provider) ||
        !['all', 'blender', 'roblox'].includes(row.tool) || typeof row.previewOpen !== 'boolean') workspacePreferenceError();
    ids.add(localId);
    tabs.push({ localId, title, provider: row.provider, threadId: workspacePreferenceId(row.threadId, 256), sessionId: workspacePreferenceId(row.sessionId, 256),
      draft: workspacePreferenceText(row.draft, 128 * 1024), modelId: workspacePreferenceId(row.modelId, 256), effort: workspacePreferenceId(row.effort, 64),
      tool: row.tool, previewOpen: row.previewOpen, ...(flagged ? { workflowDraft: row.workflowDraft } : {}) });
  }
  const activeTabId = workspacePreferenceId(value.activeTabId, 128);
  if (activeTabId !== null && !ids.has(activeTabId)) workspacePreferenceError();
  const result = { version: 1, projectPath, provider: value.provider, tabs, activeTabId };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 512 * 1024) workspacePreferenceError();
  return result;
};
const workspacePreferenceInvoke = async (action, args) => {
  try {
    let input;
    if (action === 'read') { if (args.length) workspacePreferenceError(); }
    else { if (args.length !== 1) workspacePreferenceError(); input = workspacePreferenceSnapshot(args[0]); }
    const value = await ipcRenderer.invoke('arcane:workspace-preferences-' + action, ...(input ? [input] : []));
    if (action === 'read') {
      workspacePreferenceFields(value, ['available', 'preferences']);
      if (typeof value.available !== 'boolean' || (!value.available && value.preferences !== null)) workspacePreferenceError();
      return { available: value.available, preferences: value.preferences === null ? null : workspacePreferenceSnapshot(value.preferences) };
    }
    workspacePreferenceFields(value, ['saved']); if (value.saved !== true) workspacePreferenceError();
    return { saved: true };
  } catch { workspacePreferenceError(); }
};
const workspacePreferences = Object.freeze({ version: 1,
  read: (...args) => workspacePreferenceInvoke('read', args), save: (...args) => workspacePreferenceInvoke('save', args),
});
// In-app Claude chat: exact argument envelopes out, plain bounded copies back. Only fixed host messages pass through.
const CLAUDE_CHAT_ERRORS = ['Claude chat is unavailable.', 'Another Claude chat reply is still running in this conversation.',
  'Too many Claude chat replies are running. Wait for one to finish.', 'This conversation no longer exists.', 'Message is empty or too long.'];
// The engine's one fixed usage-limit message (claude-chat.cjs MESSAGES.usageLimit); done events may carry it with a reset time.
const CLAUDE_CHAT_USAGE_LIMIT = 'Claude usage limit reached. This message was not answered; try again after the limit resets.';
const claudeChatUnavailable = () => { throw new Error(CLAUDE_CHAT_ERRORS[0]); };
const claudeChatId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const claudeChatChoice = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
const claudeChatTime = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value);
const claudeChatText = (value, max) => typeof value === 'string' && value.length <= max;
const claudeChatList = (value, max) => Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length <= max;
const claudeChatMessage = value => {
  if (!value || typeof value !== 'object' || !claudeChatId(value.id) || !['user', 'assistant', 'tool', 'error'].includes(value.role) ||
      !claudeChatText(value.text, 65536) || !claudeChatTime(value.at)) claudeChatUnavailable();
  const out = { id: value.id, role: value.role, text: value.text, at: value.at };
  if (value.tool !== undefined) {
    if (!value.tool || typeof value.tool !== 'object' || !claudeChatText(value.tool.name, 128) || !value.tool.name ||
        !['started', 'finished', 'failed'].includes(value.tool.status)) claudeChatUnavailable();
    out.tool = { name: value.tool.name, status: value.tool.status };
    // Optional display-only details (bounded JSON or a short excerpt) for activity lines and change cards.
    for (const key of ['input', 'result']) {
      const detail = value.tool[key];
      if (detail === undefined) continue;
      if (!claudeChatText(detail, 4096)) claudeChatUnavailable();
      out.tool[key] = detail;
    }
  }
  return out;
};
// Alias -> concrete model id (display only). Older engines omit it; otherwise a plain object keyed by reported aliases.
const claudeChatModelId = value => typeof value === 'string' && /^claude-[a-z0-9][a-z0-9.-]{0,62}$/.test(value);
const claudeChatResolved = (value, models) => {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) claudeChatUnavailable();
  const keys = Object.keys(value), out = {};
  if (keys.length > 32 || keys.some(key => !models.includes(key) || !claudeChatModelId(value[key]))) claudeChatUnavailable();
  for (const key of keys) out[key] = value[key];
  return out;
};
const claudeChatReply = (action, value) => {
  if (!value || typeof value !== 'object') claudeChatUnavailable();
  if (action === 'status') {
    if (typeof value.installed !== 'boolean' || typeof value.signedIn !== 'boolean' || !(value.cliVersion === null || claudeChatText(value.cliVersion, 64)) ||
        !claudeChatList(value.models, 32) || !value.models.every(claudeChatChoice) || !claudeChatList(value.efforts, 16) || !value.efforts.every(claudeChatChoice) ||
        !(value.defaultModel === null || value.models.includes(value.defaultModel)) || !(value.message === null || claudeChatText(value.message, 512))) claudeChatUnavailable();
    return { installed: value.installed, signedIn: value.signedIn, cliVersion: value.cliVersion, models: [...value.models], efforts: [...value.efforts], defaultModel: value.defaultModel,
      resolved: claudeChatResolved(value.resolved, value.models), message: value.message };
  }
  if (action === 'list') {
    if (!claudeChatList(value.conversations, 200)) claudeChatUnavailable();
    return { conversations: value.conversations.map(c => {
      if (!c || !claudeChatId(c.conversationId) || !claudeChatText(c.title, 200) || !claudeChatTime(c.updatedAt) || !claudeChatChoice(c.model) || !claudeChatChoice(c.effort)) claudeChatUnavailable();
      return { conversationId: c.conversationId, title: c.title, updatedAt: c.updatedAt, model: c.model, effort: c.effort };
    }) };
  }
  if (action === 'history') {
    if (!claudeChatId(value.conversationId) || !claudeChatList(value.messages, 2000)) claudeChatUnavailable();
    return { conversationId: value.conversationId, messages: value.messages.map(claudeChatMessage) };
  }
  if (!claudeChatId(value.turnId) || !claudeChatId(value.conversationId)) claudeChatUnavailable();
  return { turnId: value.turnId, conversationId: value.conversationId };
};
const claudeChatInvoke = async (action, args) => {
  let input;
  if (action === 'status' || action === 'list') { if (args.length) claudeChatUnavailable(); }
  else if (action === 'send') {
    const value = args[0];
    if (args.length !== 1 || !value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== 4) claudeChatUnavailable();
    for (const key of ['conversationId', 'text', 'model', 'effort']) { const d = Object.getOwnPropertyDescriptor(value, key); if (!d?.enumerable || !Object.hasOwn(d, 'value')) claudeChatUnavailable(); }
    if (!(value.conversationId === null || claudeChatId(value.conversationId)) || !claudeChatChoice(value.model) || !claudeChatChoice(value.effort)) claudeChatUnavailable();
    if (typeof value.text !== 'string' || !value.text.trim() || value.text.length > 100000) throw new Error(CLAUDE_CHAT_ERRORS[4]);
    input = { conversationId: value.conversationId, text: value.text, model: value.model, effort: value.effort };
  } else { if (args.length !== 1 || !claudeChatId(args[0])) claudeChatUnavailable(); input = args[0]; }
  let value;
  try { value = await ipcRenderer.invoke('arcane:claude-chat-' + action, ...(input === undefined ? [] : [input])); }
  catch (error) { const text = String(error?.message ?? ''); throw new Error(CLAUDE_CHAT_ERRORS.find(known => text.endsWith(known)) ?? CLAUDE_CHAT_ERRORS[0]); }
  if (action === 'stop' || action === 'remove') { if (typeof value !== 'boolean') claudeChatUnavailable(); return value; }
  return claudeChatReply(action, value);
};
const claudeChatEvent = value => {
  if (!value || typeof value !== 'object' || !claudeChatId(value.turnId) || !claudeChatId(value.conversationId)) return null;
  const base = { turnId: value.turnId, conversationId: value.conversationId };
  try {
    if (value.type === 'delta') return claudeChatText(value.text, 65536) ? { ...base, type: 'delta', text: value.text } : null;
    if (value.type === 'message' || value.type === 'tool') return { ...base, type: value.type, message: claudeChatMessage(value.message) };
    if (value.type === 'done') {
      const u = value.usage, number = n => Number.isSafeInteger(n) && n >= 0;
      if (typeof value.ok !== 'boolean' || !(value.error === null || claudeChatText(value.error, 512)) ||
          !(u === null || u && typeof u === 'object' && number(u.inputTokens) && number(u.outputTokens) && (u.costUsd === null || typeof u.costUsd === 'number' && Number.isFinite(u.costUsd) && u.costUsd >= 0))) return null;
      // A usage limit is only the fixed engine message plus an optional bounded reset time (Unix seconds).
      const l = value.usageLimit ?? null;
      if (!(l === null || value.ok === false && value.error === CLAUDE_CHAT_USAGE_LIMIT && l && typeof l === 'object' &&
          (l.resetsAt === null || Number.isSafeInteger(l.resetsAt) && l.resetsAt >= 1e9 && l.resetsAt < 1e11))) return null;
      return { ...base, type: 'done', ok: value.ok, error: value.error, usage: u === null ? null : { inputTokens: u.inputTokens, outputTokens: u.outputTokens, costUsd: u.costUsd },
        usageLimit: l === null ? null : { resetsAt: l.resetsAt } };
    }
  } catch { return null; }
  return null;
};
const claudeChat = Object.freeze({ version: 1,
  status: (...args) => claudeChatInvoke('status', args), list: (...args) => claudeChatInvoke('list', args),
  history: (...args) => claudeChatInvoke('history', args), send: (...args) => claudeChatInvoke('send', args),
  stop: (...args) => claudeChatInvoke('stop', args), remove: (...args) => claudeChatInvoke('remove', args),
  onEvent: listener => {
    if (typeof listener !== 'function') claudeChatUnavailable();
    const wrapped = (_event, payload) => { const event = claudeChatEvent(payload); if (event) { try { listener(event); } catch { /* renderer listener errors stay in the renderer */ } } };
    ipcRenderer.on('arcane:claude-chat-event', wrapped);
    let active = true;
    return () => { if (active) { active = false; ipcRenderer.removeListener('arcane:claude-chat-event', wrapped); } };
  },
});
// Studio plugin install: zero-argument intents. Paths, hashes and the confirm dialog stay in the native host;
// only a fixed state, the bundled version and one of the host's fixed messages come back.
const STUDIO_PLUGIN_UNAVAILABLE = 'Studio plugin setup is unavailable.';
const STUDIO_PLUGIN_MESSAGES = [STUDIO_PLUGIN_UNAVAILABLE, 'The Arcane Studio plugin is installed and current.',
  'An older Arcane Studio plugin is installed. Update it to match this app.', 'The Arcane Studio plugin is not installed yet.',
  'Arcane Studio plugin installed. Restart Roblox Studio to load it.', 'The Arcane Studio plugin is already current.',
  'Plugin install cancelled. Nothing was changed.', 'Studio plugin setup is disabled in verification mode.',
  'One-click plugin install is available on Windows.', 'The Roblox Studio Plugins folder could not be found.',
  'The bundled Arcane plugin failed its integrity check. Reinstall Arcane, then try again.',
  'Another plugin already uses the Arcane plugin file name. Remove or rename it, then try again.',
  'A plugin install is already running.', 'The plugin folder changed during install. Nothing was overwritten; try again.'];
const studioPluginInvoke = async (action, args) => {
  if (args.length) throw new Error(STUDIO_PLUGIN_UNAVAILABLE);
  let value;
  try { value = await ipcRenderer.invoke('arcane:studio-plugin-' + action); }
  catch (error) { const text = String(error?.message ?? ''); throw new Error(STUDIO_PLUGIN_MESSAGES.find(known => text.endsWith(known)) ?? STUDIO_PLUGIN_UNAVAILABLE); }
  if (!value || typeof value !== 'object' || value.version !== 1 || !['installed', 'outdated', 'missing', 'unavailable'].includes(value.state) ||
      !(value.pluginVersion === null || typeof value.pluginVersion === 'string' && /^[0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5}$/.test(value.pluginVersion)) ||
      !STUDIO_PLUGIN_MESSAGES.includes(value.message) || (action === 'install' && typeof value.changed !== 'boolean')) throw new Error(STUDIO_PLUGIN_UNAVAILABLE);
  return { version: 1, state: value.state, pluginVersion: value.pluginVersion, message: value.message, ...(action === 'install' ? { changed: value.changed } : {}) };
};
const studioPlugin = Object.freeze({ version: 1,
  status: (...args) => studioPluginInvoke('status', args), install: (...args) => studioPluginInvoke('install', args),
});
// Open project: the host shows its own native folder picker and switch confirmation. Nothing else crosses.
const workspaceProject = Object.freeze({ version: 1,
  open: async (...args) => {
    try { if (args.length) throw new Error(); const value = await ipcRenderer.invoke('arcane:project-open'); if (!value || value.requested !== true) throw new Error(); return { requested: true }; }
    catch { throw new Error('The project picker is unavailable.'); }
  },
});
contextBridge.exposeInMainWorld('arcaneDesktop', Object.freeze({ version: '0.1.0', platform: 'win32', runtime: 'desktop', codeVerification, providerSetup, nativeHandoff, studioKeys, workspacePreferences, claudeChat, studioPlugin, workspaceProject }));
