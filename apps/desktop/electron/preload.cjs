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
    const row = workspacePreferenceFields(d.value, ['localId', 'title', 'provider', 'threadId', 'sessionId', 'draft', 'modelId', 'effort', 'tool', 'previewOpen']);
    const localId = workspacePreferenceText(row.localId, 128, true), title = workspacePreferenceText(row.title, 512);
    if (ids.has(localId) || /[\x00-\x1f\x7f]/.test(title) || !['codex', 'claude'].includes(row.provider) ||
        !['all', 'blender', 'roblox'].includes(row.tool) || typeof row.previewOpen !== 'boolean') workspacePreferenceError();
    ids.add(localId);
    tabs.push({ localId, title, provider: row.provider, threadId: workspacePreferenceId(row.threadId, 256), sessionId: workspacePreferenceId(row.sessionId, 256),
      draft: workspacePreferenceText(row.draft, 128 * 1024), modelId: workspacePreferenceId(row.modelId, 256), effort: workspacePreferenceId(row.effort, 64),
      tool: row.tool, previewOpen: row.previewOpen });
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
contextBridge.exposeInMainWorld('arcaneDesktop', Object.freeze({ version: '0.1.0', platform: 'win32', runtime: 'desktop', codeVerification, providerSetup, nativeHandoff, studioKeys, workspacePreferences }));
